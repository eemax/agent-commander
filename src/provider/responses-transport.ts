import { setTimeout as sleep } from "node:timers/promises";
import type { Config, RuntimeLogger } from "../runtime/contracts.js";
import { createChildTraceContext, createTraceRootContext, type ObservabilitySink, type TraceContext } from "../observability.js";
import { ProviderError } from "../provider-error.js";
import type { OpenAIResponsesResponse } from "./openai-types.js";
import { classifyFetchError, classifyHttpStatus, computeRetryDelayMs, type RetryDecision } from "./retry-policy.js";
import { parseOpenAIStream, type StreamParseResult } from "./sse-parser.js";

export type ProviderTransportDeps = {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
  nowMsImpl?: () => number;
  observability?: ObservabilitySink;
};

export type ResponsesRequestOptions = {
  onTextDelta?: (delta: string) => void | Promise<void>;
  trace?: TraceContext;
  messageId?: string;
  abortSignal?: AbortSignal;
};

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (/authorization|api[-_]?key/i.test(name)) {
      redacted[name] = "[REDACTED]";
      continue;
    }

    redacted[name] = value;
  }

  return redacted;
}

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
}): Promise<StreamParseResult> {
  const contentType = params.response.headers.get("content-type") ?? "";
  if (/text\/event-stream/i.test(contentType)) {
    return parseOpenAIStream(params);
  }

  const responseBody = await params.response.text();
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
  options?: ResponsesRequestOptions
) => Promise<{ payload: OpenAIResponsesResponse; attempt: number }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl = deps.sleepImpl ?? sleep;
  const randomImpl = deps.randomImpl ?? Math.random;
  const nowMsImpl = deps.nowMsImpl ?? Date.now;
  const observability = deps.observability;

  return async (
    body: Record<string, unknown>,
    chatId: string,
    options: ResponsesRequestOptions = {}
  ): Promise<{ payload: OpenAIResponsesResponse; attempt: number }> => {
    const maxAttempts = 1 + config.openai.maxRetries;
    let lastFailure: RetryDecision = {
      retryable: false,
      kind: "unknown",
      statusCode: null,
      message: "OpenAI request failed",
      retryAfterMs: null
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptTrace = options.trace
        ? createChildTraceContext(options.trace, "provider")
        : createTraceRootContext("provider");
      const requestHeaders = {
        "content-type": "application/json",
        authorization: `Bearer ${config.openai.apiKey}`
      };
      const requestBodyPayload = {
        ...body,
        stream: true
      };
      const requestBody = JSON.stringify(requestBodyPayload);
      const startedAtMs = nowMsImpl();
      let streamDeltaCount = 0;
      let streamDeltaChars = 0;

      await observability?.record({
        event: "provider.openai.request.started",
        trace: attemptTrace,
        stage: "started",
        chatId,
        messageId: options.messageId,
        attempt,
        maxAttempts,
        url: OPENAI_RESPONSES_URL,
        method: "POST",
        headers: redactHeaders(requestHeaders),
        body: requestBodyPayload,
        bodyShape: {
          keys: Object.keys(requestBodyPayload)
        }
      });

      const timeoutController = new AbortController();
      const timeout = setTimeout(() => {
        timeoutController.abort();
      }, config.openai.timeoutMs);
      const signal = options.abortSignal
        ? AbortSignal.any([timeoutController.signal, options.abortSignal])
        : timeoutController.signal;

      try {
        const response = await fetchImpl(OPENAI_RESPONSES_URL, {
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
          const parsed = await parseSuccessPayload({
            response,
            onTextDelta: async (delta) => {
              streamDeltaCount += 1;
              streamDeltaChars += delta.length;
              await options.onTextDelta?.(delta);
            }
          });
          if (parsed.emittedTextDelta && streamDeltaCount === 0) {
            streamDeltaCount = 1;
          }
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
        const streamFailureMessage = error instanceof Error ? error.message : String(error);
        const failureFromError = classifyFetchError(error);
        lastFailure = streamDeltaCount > 0
          ? {
              retryable: false,
              kind: "invalid_response",
              statusCode: null,
              message: `OpenAI streaming response failed after partial output: ${streamFailureMessage}`,
              retryAfterMs: null
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
            statusCode: lastFailure.statusCode
          },
          stream: {
            deltaCount: streamDeltaCount,
            deltaChars: streamDeltaChars,
            partialOutput: streamDeltaCount > 0
          }
        });
      } finally {
        clearTimeout(timeout);
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
          message: lastFailure.message
        });
        throw new ProviderError({
          message: lastFailure.message,
          kind: lastFailure.kind,
          statusCode: lastFailure.statusCode,
          attempts: attempt,
          retryable: lastFailure.retryable
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
      retryable: lastFailure.retryable
    });
  };
}
