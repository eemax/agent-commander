import type { TraceContext } from "../observability.js";
import type { AuthMode, TransportMode } from "../types.js";
import type { OpenAIResponsesResponse } from "./openai-types.js";
import type { AuthModeRegistry } from "./auth-mode-contracts.js";
import type { ResponsesRequestOptions } from "./responses-transport.js";
import type { WsTransportManager, WsTransportRequestOptions } from "./ws-transport.js";

export type RequestExecutorTransports = {
  http: (
    body: Record<string, unknown>,
    chatId: string,
    options: ResponsesRequestOptions
  ) => Promise<{ payload: OpenAIResponsesResponse; attempt: number }>;
  getWsManager: () => WsTransportManager;
};

export type ExecuteRequestParams = {
  chatId: string;
  messageId?: string;
  trace?: TraceContext;
  abortSignal?: AbortSignal;
  authMode: AuthMode;
  transportMode: TransportMode;
  onTextDelta?: (delta: string) => void | Promise<void>;
};

export type OpenAIRequestExecutor = {
  execute(
    body: Record<string, unknown>,
    params: ExecuteRequestParams
  ): Promise<{ payload: OpenAIResponsesResponse; attempt: number }>;
};

export function createRequestExecutor(
  registry: AuthModeRegistry,
  transports: RequestExecutorTransports
): OpenAIRequestExecutor {
  return {
    async execute(body, params) {
      const adapter = registry.get(params.authMode);

      await adapter.onTurnStart?.();

      const { transport: effectiveTransport } = registry.normalizeTransport(
        params.authMode,
        params.transportMode
      );

      const requestOptions = {
        onTextDelta: params.onTextDelta,
        trace: params.trace,
        messageId: params.messageId,
        abortSignal: params.abortSignal,
        authModeAdapter: adapter
      };

      if (effectiveTransport === "wss") {
        return transports.getWsManager().sendResponseCreate(
          body,
          params.chatId,
          requestOptions as WsTransportRequestOptions
        );
      }

      return transports.http(body, params.chatId, requestOptions as ResponsesRequestOptions);
    }
  };
}
