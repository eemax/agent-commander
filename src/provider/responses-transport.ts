import { setTimeout as sleep } from "node:timers/promises";
import type { Config, RuntimeLogger } from "../runtime/contracts.js";
import { createChildTraceContext, createTraceRootContext, type ObservabilitySink, type TraceContext } from "../observability.js";
import { ProviderError } from "../provider-error.js";
import type { ProviderLifecycleEvent } from "../types.js";
import type { OpenAIResponsesResponse } from "./openai-types.js";
import { classifyFetchError, classifyHttpStatus, computeRetryDelayMs, type RetryDecision } from "./retry-policy.js";
import { sanitizeReason } from "./sanitize.js";
import { parseOpenAIStream, type StreamParseResult } from "./sse-parser.js";
import type { AuthModeAdapter } from "./auth-mode-contracts.js";
import { buildResolvedRequestBody } from "./auth-mode-contracts.js";

export type ProviderTransportDeps = {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
  nowMsImpl?: () => number;
  observability?: ObservabilitySink;
};

export type ResponsesRequestOptions = {
  onTextDelta?: (delta: string) => void | Promise<void>;
  onLifecycleEvent?: (event: ProviderLifecycleEvent) => void | Promise<void>;
  trace?: TraceContext;
  messageId?: string;
  abortSignal?: AbortSignal;
  authModeAdapter: AuthModeAdapter;
};

function readHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    result[name] = value;
  }
  return result;
}

async function parseSuccessPayload(params: {
  response: Response;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onResponseCreated?: () => void | Promise<void>;
}): Promise<StreamParseResult> {
  const contentType = params.response.headers.get("content-type") ?? "";
  if (/text\/event-stream/i.test(contentType)) {
    return parseOpenAIStream(params);
  }

  // Some endpoints (e.g. chatgpt.com codex proxy) return SSE without the
  // text/event-stream content-type header.  Peek at the first bytes to detect
  // SSE format and route to the stream parser instead of JSON.parse.
  const responseBody = await params.response.text();
  if (/^\s*(?:event|data):/m.test(responseBody)) {
    const syntheticResponse = new Response(responseBody, {
      status: params.response.status,
      headers: { "content-type": "text/event-stream" }
    });
    return parseOpenAIStream({
      ...params,
      response: syntheticResponse
    });
  }

  // Non-streaming JSON response — the model accepted and completed in one shot.
  await params.onResponseCreated?.();
  const payload = JSON.parse(responseBody) as OpenAIResponsesResponse;
  return {
    payload,
    emittedTextDelta: false
  };
}

export function createResponsesRequestWithRetry(
  config: Config,
  logger: RuntimeLogger,
  deps: ProviderTransportDeps = {}
): (
  body: Record<string, unknown>,
  chatId: string,
  options: ResponsesRequestOptions
) => Promise<{ payload: OpenAIResponsesResponse; attempt: number }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl = deps.sleepImpl ?? sleep;
  const randomImpl = deps.randomImpl ?? Math.random;
  const nowMsImpl = deps.nowMsImpl ?? Date.now;
  const observability = deps.observability;

  return async (
    body: Record<string, unknown>,
    chatId: string,
    options: ResponsesRequestOptions
  ): Promise<{ payload: OpenAIResponsesResponse; attempt: number }> => {
    const maxAttempts = 1 + config.openai.maxRetries;
    let lastFailure: RetryDecision = {
      retryable: false,
      kind: "unknown",
      statusCode: null,
      message: "OpenAI request failed",
      retryAfterMs: null,
      detail: {
        reason: "OpenAI request failed",
        openaiErrorType: null,
        openaiErrorCode: null,
        openaiErrorParam: null,
        requestId: null,
        retryAfterMs: null,
        timedOutBy: null
      }
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptTrace = options.trace
        ? createChildTraceContext(options.trace, "provider")
        : createTraceRootContext("provider");
      const adapter = options.authModeAdapter;
      const authParams = await adapter.resolveRequest();
      const requestHeaders = authParams.headers;
      const requestBodyPayload = buildResolvedRequestBody(body, authParams, { includeStream: true });
      const requestBody = JSON.stringify(requestBodyPayload);
      const startedAtMs = nowMsImpl();
      let streamDeltaCount = 0;
      let streamDeltaChars = 0;
      let lifecycleAcknowledged = false;

      await observability?.record({
        event: "provider.openai.request.started",
        trace: attemptTrace,
        stage: "started",
        chatId,
        messageId: options.messageId,
        attempt,
        maxAttempts,
        url: authParams.httpUrl,
        method: "POST",
        headers: requestHeaders,
        body: requestBodyPayload,
        bodyShape: {
          keys: Object.keys(requestBodyPayload)
        }
      });

      const timeoutController = new AbortController();
      let localTimeoutFired = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      if (config.openai.timeoutMs !== null) {
        timeout = setTimeout(() => {
          localTimeoutFired = true;
          timeoutController.abort();
        }, config.openai.timeoutMs);
      }
      const signal = options.abortSignal
        ? (config.openai.timeoutMs !== null
            ? AbortSignal.any([timeoutController.signal, options.abortSignal])
            : options.abortSignal)
        : (config.openai.timeoutMs !== null ? timeoutController.signal : undefined);

      try {
        const response = await fetchImpl(authParams.httpUrl, {
          method: "POST",
          headers: requestHeaders,
          body: requestBody,
          signal
        });

        const responseHeaders = readHeaders(response.headers);
        const durationMs = nowMsImpl() - startedAtMs;

        if (!response.ok) {
          const responseBody = await response.text();
          lastFailure = classifyHttpStatus({
            status: response.status,
            body: responseBody,
            retryAfterHeader: response.headers.get("retry-after"),
            requestIdHeader: response.headers.get("x-request-id"),
            nowMs: nowMsImpl()
          });

          logger.warn(
            `provider: non-2xx response chat=${chatId} attempt=${attempt}/${maxAttempts} status=${response.status}`
          );
          await observability?.record({
            event: "provider.openai.request.completed",
            trace: attemptTrace,
            stage: "completed",
            chatId,
            messageId: options.messageId,
            attempt,
            maxAttempts,
            status: response.status,
            ok: false,
            headers: responseHeaders,
            body: responseBody,
            durationMs,
            retryable: lastFailure.retryable,
            retryAfterMs: lastFailure.retryAfterMs,
            stream: {
              deltaCount: streamDeltaCount,
              deltaChars: streamDeltaChars,
              partialOutput: streamDeltaCount > 0
            }
          });
        } else {
          const emitAcknowledgedIfNeeded = async (): Promise<void> => {
            if (!lifecycleAcknowledged) {
              lifecycleAcknowledged = true;
              await options.onLifecycleEvent?.({ type: "response_acknowledged" });
              await options.onLifecycleEvent?.({ type: "response_processing_started" });
            }
          };
          const parsed = await parseSuccessPayload({
            response,
            onTextDelta: async (delta) => {
              streamDeltaCount += 1;
              streamDeltaChars += delta.length;
              // Fallback: if response.created was never seen, treat the first
              // upstream delta as acceptance.
              await emitAcknowledgedIfNeeded();
              await options.onTextDelta?.(delta);
            },
            onResponseCreated: emitAcknowledgedIfNeeded
          });
          if (parsed.emittedTextDelta && streamDeltaCount === 0) {
            streamDeltaCount = 1;
          }
          await options.onLifecycleEvent?.({ type: "response_processing_finished", outcome: "completed" });
          await observability?.record({
            event: "provider.openai.request.completed",
            trace: attemptTrace,
            stage: "completed",
            chatId,
            messageId: options.messageId,
            attempt,
            maxAttempts,
            status: response.status,
            ok: true,
            headers: responseHeaders,
            body: parsed.payload,
            durationMs,
            retryable: false,
            retryAfterMs: null,
            stream: {
              deltaCount: streamDeltaCount,
              deltaChars: streamDeltaChars,
              partialOutput: streamDeltaCount > 0
            }
          });
          return { payload: parsed.payload, attempt };
        }
      } catch (error) {
        if (lifecycleAcknowledged) {
          const outcome = options.abortSignal?.aborted ? "aborted" as const : "failed" as const;
          try { await options.onLifecycleEvent?.({ type: "response_processing_finished", outcome }); } catch { /* ignore */ }
        }
        const streamFailureMessage = error instanceof Error ? error.message : String(error);
        const failureFromError = classifyFetchError(error, {
          localTimeoutFired,
          upstreamAbortSignal: options.abortSignal
        });
        lastFailure = streamDeltaCount > 0
          ? {
              retryable: false,
              kind: "invalid_response",
              statusCode: null,
              message: `OpenAI streaming response failed after partial output: ${streamFailureMessage}`,
              retryAfterMs: null,
              detail: {
                reason: sanitizeReason(`OpenAI streaming response failed after partial output: ${streamFailureMessage}`),
                openaiErrorType: null,
                openaiErrorCode: null,
                openaiErrorParam: null,
                requestId: null,
                retryAfterMs: null,
                timedOutBy: null
              }
            }
          : failureFromError;

        await observability?.record({
          event: "provider.openai.request.completed",
          trace: attemptTrace,
          stage: "failed",
          chatId,
          messageId: options.messageId,
          attempt,
          maxAttempts,
          status: null,
          ok: false,
          headers: null,
          body: null,
          durationMs: nowMsImpl() - startedAtMs,
          retryable: lastFailure.retryable,
          retryAfterMs: lastFailure.retryAfterMs,
          error,
          failure: {
            kind: lastFailure.kind,
            message: lastFailure.message,
            statusCode: lastFailure.statusCode,
            detail: lastFailure.detail
          },
          stream: {
            deltaCount: streamDeltaCount,
            deltaChars: streamDeltaChars,
            partialOutput: streamDeltaCount > 0
          }
        });
      } finally {
        if (timeout !== null) clearTimeout(timeout);
      }

      // On 401, attempt token recovery via adapter (e.g. codex token refresh)
      if (lastFailure.statusCode === 401 && adapter.onUnauthorized) {
        try {
          await adapter.onUnauthorized();
          lastFailure = { ...lastFailure, retryable: true };
          logger.info(`provider: 401 in ${adapter.id} mode, refreshed token for retry`);
        } catch (refreshErr) {
          logger.warn(`provider: ${adapter.id} token refresh failed: ${refreshErr}`);
        }
      }

      const isFinalAttempt = attempt === maxAttempts;
      if (!lastFailure.retryable || isFinalAttempt) {
        await observability?.record({
          event: "provider.openai.request.failed_final",
          trace: attemptTrace,
          stage: "failed",
          chatId,
          messageId: options.messageId,
          attempt,
          maxAttempts,
          retryable: lastFailure.retryable,
          kind: lastFailure.kind,
          statusCode: lastFailure.statusCode,
          message: lastFailure.message,
          detail: lastFailure.detail
        });
        throw new ProviderError({
          message: lastFailure.message,
          kind: lastFailure.kind,
          statusCode: lastFailure.statusCode,
          attempts: attempt,
          retryable: lastFailure.retryable,
          detail: lastFailure.detail
        });
      }

      const delayMs = computeRetryDelayMs({
        attempt,
        baseMs: config.openai.retryBaseMs,
        maxMs: config.openai.retryMaxMs,
        retryAfterMs: lastFailure.retryAfterMs,
        random: randomImpl
      });

      logger.warn(
        `provider: transient failure chat=${chatId} kind=${lastFailure.kind} status=${lastFailure.statusCode ?? "none"} attempt=${attempt}/${maxAttempts}; retrying in ${delayMs}ms`
      );

      await observability?.record({
        event: "provider.openai.retry.scheduled",
        trace: attemptTrace,
        stage: "scheduled",
        chatId,
        messageId: options.messageId,
        attempt,
        maxAttempts,
        delayMs,
        kind: lastFailure.kind,
        statusCode: lastFailure.statusCode,
        retryAfterMs: lastFailure.retryAfterMs
      });

      await sleepImpl(delayMs);
    }

    throw new ProviderError({
      message: lastFailure.message,
      kind: lastFailure.kind,
      statusCode: lastFailure.statusCode,
      attempts: maxAttempts,
      retryable: lastFailure.retryable,
      detail: lastFailure.detail
    });
  };
}
