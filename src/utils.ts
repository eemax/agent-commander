import {
  THINKING_EFFORT_VALUES,
  CACHE_RETENTION_VALUES,
  TRANSPORT_MODE_VALUES,
  AUTH_MODE_VALUES,
  type ThinkingEffort,
  type CacheRetention,
  type TransportMode,
  type AuthMode
} from "./types.js";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    return {};
  }
  return value;
}

export function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const THINKING_EFFORT_SET: ReadonlySet<string> = new Set(THINKING_EFFORT_VALUES);
const CACHE_RETENTION_SET: ReadonlySet<string> = new Set(CACHE_RETENTION_VALUES);
const TRANSPORT_MODE_SET: ReadonlySet<string> = new Set(TRANSPORT_MODE_VALUES);
const AUTH_MODE_SET: ReadonlySet<string> = new Set(AUTH_MODE_VALUES);

export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return typeof value === "string" && THINKING_EFFORT_SET.has(value);
}

export function isCacheRetention(value: unknown): value is CacheRetention {
  return typeof value === "string" && CACHE_RETENTION_SET.has(value);
}

export function isTransportMode(value: unknown): value is TransportMode {
  return typeof value === "string" && TRANSPORT_MODE_SET.has(value);
}

export function isAuthMode(value: unknown): value is AuthMode {
  return typeof value === "string" && AUTH_MODE_SET.has(value);
}
