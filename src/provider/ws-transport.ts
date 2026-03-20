import { setTimeout as sleep } from "node:timers/promises";
import type { Config, RuntimeLogger } from "../runtime/contracts.js";
import { createChildTraceContext, createTraceRootContext, type ObservabilitySink, type TraceContext } from "../observability.js";
import { ProviderError } from "../provider-error.js";
import type { OpenAIResponsesResponse } from "./openai-types.js";
import { parseCompletedPayload } from "./sse-parser.js";
import { computeRetryDelayMs } from "./retry-policy.js";
import { sanitizeReason } from "./sanitize.js";

const OPENAI_WS_URL = "wss://api.openai.com/v1/responses";
const WS_ROTATION_MS = 55 * 60 * 1000;
const WS_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export type WsTransportDeps = {
  WebSocketImpl?: typeof WebSocket;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
  nowMsImpl?: () => number;
  observability?: ObservabilitySink;
};

export type WsTransportRequestOptions = {
  onTextDelta?: (delta: string) => void | Promise<void>;
  trace?: TraceContext;
  messageId?: string;
  abortSignal?: AbortSignal;
};

type PendingRequest = {
  resolve: (result: { payload: OpenAIResponsesResponse; emittedTextDelta: boolean }) => void;
  reject: (error: Error) => void;
  emittedTextDelta: boolean;
  onTextDelta?: (delta: string) => void | Promise<void>;
};

type WsConnection = {
  ws: WebSocket;
  chatId: string;
  createdAtMs: number;
  pendingRequest: PendingRequest | null;
  rotationTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
};

export type WsTransportManager = {
  sendResponseCreate(
    body: Record<string, unknown>,
    chatId: string,
    options?: WsTransportRequestOptions
  ): Promise<{ payload: OpenAIResponsesResponse; attempt: number }>;
  closeConnection(chatId: string): void;
  closeAll(): void;
};

export function createWsTransportManager(
  config: Config,
  logger: RuntimeLogger,
  deps: WsTransportDeps = {}
): WsTransportManager {
  const WsImpl = deps.WebSocketImpl ?? WebSocket;
  const sleepImpl = deps.sleepImpl ?? ((ms: number) => sleep(ms));
  const randomImpl = deps.randomImpl ?? Math.random;
  const nowMsImpl = deps.nowMsImpl ?? Date.now;
  const observability = deps.observability;
  const maxReconnectAttempts = config.openai.maxRetries;

  const connections = new Map<string, WsConnection>();

  function teardownConnection(conn: WsConnection): void {
    if (conn.rotationTimer !== null) {
      clearTimeout(conn.rotationTimer);
      conn.rotationTimer = null;
    }
    if (conn.idleTimer !== null) {
      clearTimeout(conn.idleTimer);
      conn.idleTimer = null;
    }
    try {
      conn.ws.close();
    } catch {
      // Ignore close errors on already-closed sockets.
    }
    connections.delete(conn.chatId);
  }

  function resetIdleTimer(conn: WsConnection): void {
    if (conn.idleTimer !== null) {
      clearTimeout(conn.idleTimer);
    }
    conn.idleTimer = setTimeout(() => {
      if (conn.pendingRequest === null) {
        teardownConnection(conn);
        observability?.record({
          event: "provider.ws.connection.idle_closed",
          trace: createTraceRootContext("ws-transport"),
          stage: "completed",
          chatId: conn.chatId
        });
      }
    }, WS_IDLE_TIMEOUT_MS);
  }

  function scheduleRotation(conn: WsConnection): void {
    const elapsed = nowMsImpl() - conn.createdAtMs;
    const remaining = Math.max(0, WS_ROTATION_MS - elapsed);
    conn.rotationTimer = setTimeout(() => {
      conn.rotationTimer = null;
      if (conn.pendingRequest === null) {
        teardownConnection(conn);
        logger.info(`[ws-transport] proactive rotation for chat=${conn.chatId}`);
      }
      // If a request is in-flight, rotation will happen after it completes.
    }, remaining);
  }

  function createConnection(chatId: string, trace?: TraceContext): Promise<WsConnection> {
    return new Promise<WsConnection>((resolve, reject) => {
      const eventTrace = trace ? createChildTraceContext(trace, "ws-transport") : createTraceRootContext("ws-transport");

      const ws = new WsImpl(OPENAI_WS_URL, {
        headers: {
          authorization: `Bearer ${config.openai.apiKey}`
        }
      } as unknown as string[]);

      const conn: WsConnection = {
        ws,
        chatId,
        createdAtMs: nowMsImpl(),
        pendingRequest: null,
        rotationTimer: null,
        idleTimer: null,
        reconnectAttempts: 0
      };

      ws.onopen = () => {
        connections.set(chatId, conn);
        scheduleRotation(conn);
        resetIdleTimer(conn);
        observability?.record({
          event: "provider.ws.connected",
          trace: eventTrace,
          stage: "started",
          chatId
        });
        resolve(conn);
      };

      ws.onerror = (event) => {
        const message = event instanceof ErrorEvent ? event.message : "WebSocket connection error";
        if (!connections.has(chatId)) {
          // Connection attempt failed before open.
          reject(new ProviderError({
            message: `WebSocket connection failed: ${message}`,
            kind: "network",
            attempts: 1,
            retryable: true
          }));
        }
      };

      ws.onclose = (event) => {
        const closedConn = connections.get(chatId);
        if (closedConn && closedConn.pendingRequest) {
          closedConn.pendingRequest.reject(new ProviderError({
            message: `WebSocket closed mid-request: code=${event.code} reason=${event.reason || "none"}`,
            kind: "network",
            attempts: 1,
            retryable: true,
            detail: {
              reason: sanitizeReason(`WebSocket closed: code=${event.code} reason=${event.reason || "none"}`),
              openaiErrorType: null,
              openaiErrorCode: null,
              openaiErrorParam: null,
              requestId: null,
              retryAfterMs: null,
              timedOutBy: null
            }
          }));
          closedConn.pendingRequest = null;
        }
        if (closedConn) {
          teardownConnection(closedConn);
        }
        observability?.record({
          event: "provider.ws.disconnected",
          trace: eventTrace,
          stage: "completed",
          chatId,
          closeCode: event.code,
          closeReason: event.reason || null
        });
      };

      // Serialize onmessage processing so async onTextDelta callbacks
      // (which include Telegram draft throttling) execute sequentially,
      // matching SSE's natural `for await` serialization. Without this,
      // concurrent delta handlers bypass the time-based throttle and
      // flood the Telegram API with draft edits.
      let messageQueue: Promise<void> = Promise.resolve();

      ws.onmessage = (event) => {
        messageQueue = messageQueue.then(() => handleMessage(event)).catch(() => {});
      };

      const handleMessage = async (event: MessageEvent) => {
        const currentConn = connections.get(chatId);

        let parsed: unknown;
        try {
          parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        } catch {
          return;
        }

        if (!parsed || typeof parsed !== "object") {
          return;
        }

        const eventType = (parsed as Record<string, unknown>).type;
        if (typeof eventType !== "string") {
          return;
        }

        observability?.record({
          event: "provider.ws.event.received",
          trace: createTraceRootContext("ws-transport"),
          stage: "completed",
          chatId,
          wsEventType: eventType,
          hasPendingRequest: currentConn?.pendingRequest !== null
        });

        if (!currentConn?.pendingRequest) {
          return;
        }

        const pending = currentConn.pendingRequest;

        if (eventType === "response.output_text.delta") {
          const delta = (parsed as { delta?: unknown }).delta;
          if (typeof delta === "string" && delta.length > 0) {
            pending.emittedTextDelta = true;
            try {
              await pending.onTextDelta?.(delta);
            } catch {
              // Ignore delta callback errors to not break the stream.
            }
          }
          return;
        }

        if (eventType === "response.completed") {
          // Guard against duplicate completed events from async concurrency.
          if (currentConn.pendingRequest !== pending) {
            return;
          }
          const payload = parseCompletedPayload(parsed);
          if (payload) {
            currentConn.pendingRequest = null;
            resetIdleTimer(currentConn);
            // Proactive rotation if timer already fired while request was in-flight.
            if (currentConn.rotationTimer === null) {
              teardownConnection(currentConn);
            }
            pending.resolve({ payload, emittedTextDelta: pending.emittedTextDelta });
          } else {
            currentConn.pendingRequest = null;
            pending.reject(new SyntaxError("WebSocket response.completed event did not include a response payload"));
          }
          return;
        }

        if (eventType === "error") {
          const errorObj = (parsed as { error?: unknown }).error;
          const message =
            errorObj && typeof errorObj === "object" && typeof (errorObj as { message?: unknown }).message === "string"
              ? (errorObj as { message: string }).message
              : "OpenAI WebSocket returned an error event";

          currentConn.pendingRequest = null;
          pending.reject(new ProviderError({
            message,
            kind: "server_error",
            attempts: 1,
            retryable: false,
            detail: {
              reason: sanitizeReason(message),
              openaiErrorType: errorObj && typeof errorObj === "object" ? (errorObj as Record<string, unknown>).type as string ?? null : null,
              openaiErrorCode: errorObj && typeof errorObj === "object" ? (errorObj as Record<string, unknown>).code as string ?? null : null,
              openaiErrorParam: null,
              requestId: null,
              retryAfterMs: null,
              timedOutBy: null
            }
          }));
        }
      };
    });
  }

  async function ensureConnected(chatId: string, trace?: TraceContext): Promise<WsConnection> {
    const existing = connections.get(chatId);
    if (existing && existing.ws.readyState === WsImpl.OPEN) {
      return existing;
    }

    // Clean up stale connection if any.
    if (existing) {
      teardownConnection(existing);
    }

    // Try to connect with reconnect backoff.
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxReconnectAttempts + 1; attempt += 1) {
      try {
        const conn = await createConnection(chatId, trace);
        conn.reconnectAttempts = attempt > 1 ? attempt - 1 : 0;
        return conn;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt <= maxReconnectAttempts) {
          const delayMs = computeRetryDelayMs({
            attempt,
            baseMs: config.openai.retryBaseMs,
            maxMs: config.openai.retryMaxMs,
            retryAfterMs: null,
            random: randomImpl
          });
          observability?.record({
            event: "provider.ws.connection.reconnecting",
            trace: trace ? createChildTraceContext(trace, "ws-transport") : createTraceRootContext("ws-transport"),
            stage: "started",
            chatId,
            attempt,
            delayMs
          });
          await sleepImpl(delayMs);
        }
      }
    }

    throw new ProviderError({
      message: `WebSocket reconnect failed after ${maxReconnectAttempts + 1} attempts: ${lastError?.message ?? "unknown"}`,
      kind: "network",
      attempts: maxReconnectAttempts + 1,
      retryable: false,
      cause: lastError ?? undefined,
      detail: {
        reason: sanitizeReason(`WebSocket reconnect failed after ${maxReconnectAttempts + 1} attempts`),
        openaiErrorType: null,
        openaiErrorCode: null,
        openaiErrorParam: null,
        requestId: null,
        retryAfterMs: null,
        timedOutBy: null
      }
    });
  }

  return {
    async sendResponseCreate(body, chatId, options) {
      const requestTrace = options?.trace
        ? createChildTraceContext(options.trace, "ws-transport")
        : createTraceRootContext("ws-transport");
      const startedAtMs = nowMsImpl();

      if (options?.abortSignal?.aborted) {
        throw new ProviderError({
          message: "WebSocket request aborted before send",
          kind: "timeout",
          attempts: 1,
          retryable: false,
          detail: {
            reason: "Request aborted before WebSocket send",
            openaiErrorType: null,
            openaiErrorCode: null,
            openaiErrorParam: null,
            requestId: null,
            retryAfterMs: null,
            timedOutBy: "upstream_abort"
          }
        });
      }

      const conn = await ensureConnected(chatId, requestTrace);

      // The Responses API WebSocket expects a flat message with type "response.create"
      // and all request fields at the top level. The `stream` and `background` fields
      // are transport-specific and must NOT be included in WebSocket messages.
      const { stream: _stream, background: _background, ...wsBody } = body as Record<string, unknown> & { stream?: unknown; background?: unknown };
      const envelope = {
        type: "response.create",
        ...wsBody
      };

      await observability?.record({
        event: "provider.ws.request.started",
        trace: requestTrace,
        stage: "started",
        chatId,
        messageId: options?.messageId
      });

      const result = await new Promise<{ payload: OpenAIResponsesResponse; emittedTextDelta: boolean }>((resolve, reject) => {
        conn.pendingRequest = {
          resolve,
          reject,
          emittedTextDelta: false,
          onTextDelta: options?.onTextDelta
        };

        // Set up abort signal listener.
        if (options?.abortSignal) {
          const onAbort = () => {
            if (conn.pendingRequest) {
              conn.pendingRequest.reject(new ProviderError({
                message: "WebSocket request interrupted by upstream abort signal",
                kind: "timeout",
                attempts: 1,
                retryable: false,
                detail: {
                  reason: "WebSocket request interrupted by upstream abort signal",
                  openaiErrorType: null,
                  openaiErrorCode: null,
                  openaiErrorParam: null,
                  requestId: null,
                  retryAfterMs: null,
                  timedOutBy: "upstream_abort"
                }
              }));
              conn.pendingRequest = null;
            }
          };
          options.abortSignal.addEventListener("abort", onAbort, { once: true });
          // Clean up the listener when the request finishes.
          const originalResolve = resolve;
          const originalReject = reject;
          conn.pendingRequest.resolve = (val) => {
            options.abortSignal!.removeEventListener("abort", onAbort);
            originalResolve(val);
          };
          conn.pendingRequest.reject = (err) => {
            options.abortSignal!.removeEventListener("abort", onAbort);
            originalReject(err);
          };
        }

        // Set up request timeout.
        const timeoutMs = config.openai.timeoutMs;
        const timeoutId = setTimeout(() => {
          if (conn.pendingRequest) {
            conn.pendingRequest.reject(new ProviderError({
              message: "WebSocket request timed out",
              kind: "timeout",
              attempts: 1,
              retryable: true,
              detail: {
                reason: "WebSocket request timed out",
                openaiErrorType: null,
                openaiErrorCode: null,
                openaiErrorParam: null,
                requestId: null,
                retryAfterMs: null,
                timedOutBy: "local_timeout"
              }
            }));
            conn.pendingRequest = null;
          }
        }, timeoutMs);

        // Wrap resolve/reject to clear timeout.
        const wrappedResolve = conn.pendingRequest.resolve;
        const wrappedReject = conn.pendingRequest.reject;
        conn.pendingRequest.resolve = (val) => {
          clearTimeout(timeoutId);
          wrappedResolve(val);
        };
        conn.pendingRequest.reject = (err) => {
          clearTimeout(timeoutId);
          wrappedReject(err);
        };

        try {
          conn.ws.send(JSON.stringify(envelope));
        } catch (sendError) {
          clearTimeout(timeoutId);
          conn.pendingRequest = null;
          reject(new ProviderError({
            message: `WebSocket send failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
            kind: "network",
            attempts: 1,
            retryable: true,
            cause: sendError
          }));
        }
      });

      const durationMs = nowMsImpl() - startedAtMs;
      await observability?.record({
        event: "provider.ws.request.completed",
        trace: requestTrace,
        stage: "completed",
        chatId,
        messageId: options?.messageId,
        durationMs,
        emittedTextDelta: result.emittedTextDelta
      });

      return { payload: result.payload, attempt: 1 };
    },

    closeConnection(chatId) {
      const conn = connections.get(chatId);
      if (conn) {
        teardownConnection(conn);
      }
    },

    closeAll() {
      for (const conn of connections.values()) {
        teardownConnection(conn);
      }
    }
  };
}
