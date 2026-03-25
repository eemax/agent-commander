import type { AuthMode, TransportMode } from "../types.js";

export type AuthModeAvailability =
  | { ok: true }
  | { ok: false; reason: string };

export type ResolvedAuthRequest = {
  httpUrl: string;
  wsUrl: string;
  headers: Record<string, string>;
  extraBodyFields: Record<string, unknown>;
  /** Body fields to strip before sending (proxy rejects unsupported params). */
  stripBodyFields: string[];
};

export type AuthModeCapabilities = {
  allowedTransports: readonly TransportMode[];
  defaultTransport: TransportMode;
  statelessToolLoop: boolean;
};

export type AuthModeAdapter = {
  id: AuthMode;
  describe(): {
    label: string;
    capabilities: AuthModeCapabilities;
  };
  availability(): AuthModeAvailability;
  /** Called before each provider turn (e.g. reload credentials from disk). */
  onTurnStart?(): void | Promise<void>;
  /** Resolve URL, headers, and body field rules for the current request. */
  resolveRequest(): Promise<ResolvedAuthRequest>;
  /** Called on 401 to attempt token recovery before retry. */
  onUnauthorized?(): Promise<void>;
};

export type AuthModeRegistry = {
  get(mode: AuthMode): AuthModeAdapter;
  normalizeTransport(
    mode: AuthMode,
    requested: TransportMode
  ): {
    transport: TransportMode;
    changed: boolean;
    reason: string | null;
  };
};

/**
 * Apply adapter body-field rules to a request payload.
 */
export function buildResolvedRequestBody(
  body: Record<string, unknown>,
  resolved: ResolvedAuthRequest,
  options: { includeStream: boolean }
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...body,
    ...(options.includeStream ? { stream: true } : {}),
    ...resolved.extraBodyFields
  };

  for (const key of resolved.stripBodyFields) {
    delete payload[key];
  }

  return payload;
}
