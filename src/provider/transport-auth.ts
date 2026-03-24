import type { AuthMode } from "../types.js";
import type { CodexAuthManager } from "../auth/codex-auth.js";

export type TransportAuthParams = {
  url: string;
  headers: Record<string, string>;
  extraBodyFields: Record<string, unknown>;
  /** Body fields to strip before sending (proxy rejects unsupported params). */
  stripBodyFields: string[];
};

export type TransportAuthResolver = {
  /** Resolve URL, headers, and extra body fields for the given auth mode. */
  resolve(authMode: AuthMode): Promise<TransportAuthParams>;
  /** Called on 401 to attempt token recovery before retry. */
  on401(authMode: AuthMode): Promise<void>;
};

export function createTransportAuthResolver(params: {
  apiKey: string;
  codexAuth: CodexAuthManager | null;
}): TransportAuthResolver {
  return {
    async resolve(authMode: AuthMode): Promise<TransportAuthParams> {
      if (authMode === "codex") {
        if (!params.codexAuth) {
          throw new Error(
            "Codex auth mode requested but ~/.codex/auth.json was not found at startup"
          );
        }
        return {
          url: "https://chatgpt.com/backend-api/codex/responses",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await params.codexAuth.getAccessToken()}`,
            "chatgpt-account-id": params.codexAuth.getAccountId()
          },
          extraBodyFields: { store: false },
          stripBodyFields: ["prompt_cache_key", "prompt_cache_retention", "previous_response_id"]
        };
      }

      // "api" mode (default)
      return {
        url: "https://api.openai.com/v1/responses",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${params.apiKey}`
        },
        extraBodyFields: {},
        stripBodyFields: []
      };
    },

    async on401(authMode: AuthMode): Promise<void> {
      if (authMode === "codex" && params.codexAuth) {
        await params.codexAuth.forceRefresh();
      }
    }
  };
}
