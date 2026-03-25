import type { CodexAuthManager } from "../../auth/codex-auth.js";
import type { AuthModeAdapter, AuthModeAvailability } from "../auth-mode-contracts.js";

export function createCodexAdapter(params: {
  codexAuth: CodexAuthManager | null;
}): AuthModeAdapter {
  return {
    id: "codex",

    describe() {
      return {
        label: "Codex (ChatGPT proxy)",
        capabilities: {
          allowedTransports: ["http", "wss"] as const,
          defaultTransport: "http",
          statelessToolLoop: true
        }
      };
    },

    availability(): AuthModeAvailability {
      if (!params.codexAuth) {
        return {
          ok: false,
          reason: "~/.codex/auth.json was not found at startup"
        };
      }
      return { ok: true };
    },

    onTurnStart() {
      params.codexAuth?.reload();
    },

    async resolveRequest() {
      if (!params.codexAuth) {
        throw new Error(
          "Codex auth mode requested but ~/.codex/auth.json was not found at startup"
        );
      }
      return {
        httpUrl: "https://chatgpt.com/backend-api/codex/responses",
        wsUrl: "wss://chatgpt.com/backend-api/codex/responses",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await params.codexAuth.getAccessToken()}`,
          "chatgpt-account-id": params.codexAuth.getAccountId()
        },
        extraBodyFields: { store: false },
        stripBodyFields: [
          "prompt_cache_key",
          "prompt_cache_retention",
          "previous_response_id"
        ]
      };
    },

    async onUnauthorized() {
      if (params.codexAuth) {
        await params.codexAuth.forceRefresh();
      }
    }
  };
}
