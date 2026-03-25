import type { CodexAuthManager } from "../auth/codex-auth.js";
import type { AuthMode, TransportMode } from "../types.js";
import type { AuthModeAdapter, AuthModeRegistry } from "./auth-mode-contracts.js";
import { createApiAdapter } from "./auth-modes/api.js";
import { createCodexAdapter } from "./auth-modes/codex.js";

export function createAuthModeRegistry(params: {
  apiKey: string;
  codexAuth: CodexAuthManager | null;
}): AuthModeRegistry {
  const adapters: Record<AuthMode, AuthModeAdapter> = {
    api: createApiAdapter({ apiKey: params.apiKey }),
    codex: createCodexAdapter({ codexAuth: params.codexAuth })
  };

  return {
    get(mode: AuthMode): AuthModeAdapter {
      return adapters[mode];
    },

    normalizeTransport(
      mode: AuthMode,
      requested: TransportMode
    ): { transport: TransportMode; changed: boolean; reason: string | null } {
      const adapter = adapters[mode];
      const caps = adapter.describe().capabilities;

      if (caps.allowedTransports.includes(requested)) {
        return { transport: requested, changed: false, reason: null };
      }

      return {
        transport: caps.defaultTransport,
        changed: true,
        reason: `transport ${requested} is not available in auth mode ${mode}`
      };
    }
  };
}
