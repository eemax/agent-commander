import { ProviderError } from "../provider-error.js";
import type { ProviderErrorKind } from "../types.js";

export type RetryDecision = {
  retryable: boolean;
  kind: ProviderErrorKind;
  statusCode: number | null;
  message: string;
  retryAfterMs: number | null;
};

function parseRetryAfterMs(header: string | null, nowMs: number): number | null {
  if (!header) {
    return null;
  }

  const trimmed = header.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.ceil(asSeconds * 1000);
  }

  const asDate = Date.parse(trimmed);
  if (!Number.isFinite(asDate)) {
    return null;
  }

  return Math.max(0, asDate - nowMs);
}

export function classifyFetchError(error: unknown): RetryDecision {
  if (error instanceof ProviderError) {
    return {
      retryable: error.retryable,
      kind: error.kind,
      statusCode: error.statusCode,
      message: error.message,
      retryAfterMs: null
    };
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      retryable: true,
      kind: "timeout",
      statusCode: null,
      message: "OpenAI request timed out",
      retryAfterMs: null
    };
  }

  if (error instanceof Error && error.name === "AbortError") {
    return {
      retryable: true,
      kind: "timeout",
      statusCode: null,
      message: "OpenAI request timed out",
      retryAfterMs: null
    };
  }

  if (error instanceof TypeError) {
    return {
      retryable: true,
      kind: "network",
      statusCode: null,
      message: `OpenAI network request failed: ${error.message}`,
      retryAfterMs: null
    };
  }

  if (error instanceof SyntaxError) {
    return {
      retryable: false,
      kind: "invalid_response",
      statusCode: null,
      message: `OpenAI response parsing failed: ${error.message}`,
      retryAfterMs: null
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    retryable: false,
    kind: "unknown",
    statusCode: null,
    message,
    retryAfterMs: null
  };
}

export function classifyHttpStatus(params: {
  status: number;
  body: string;
  retryAfterHeader: string | null;
  nowMs: number;
}): RetryDecision {
  const message = `OpenAI request failed (${params.status}): ${params.body}`;
  const retryAfterMs = parseRetryAfterMs(params.retryAfterHeader, params.nowMs);

  if (params.status === 408) {
    return {
      retryable: true,
      kind: "http_408",
      statusCode: params.status,
      message,
      retryAfterMs
    };
  }

  if (params.status === 409) {
    return {
      retryable: true,
      kind: "http_409",
      statusCode: params.status,
      message,
      retryAfterMs
    };
  }

  if (params.status === 429) {
    return {
      retryable: true,
      kind: "rate_limit",
      statusCode: params.status,
      message,
      retryAfterMs
    };
  }

  if (params.status >= 500) {
    return {
      retryable: true,
      kind: "server_error",
      statusCode: params.status,
      message,
      retryAfterMs
    };
  }

  return {
    retryable: false,
    kind: "client_error",
    statusCode: params.status,
    message,
    retryAfterMs: null
  };
}

export function computeRetryDelayMs(params: {
  attempt: number;
  baseMs: number;
  maxMs: number;
  retryAfterMs: number | null;
  random: () => number;
}): number {
  const exponential = params.baseMs * Math.pow(2, params.attempt - 1);
  const jittered = Math.floor(params.random() * Math.min(exponential, params.maxMs));
  const retryAfterDelay = params.retryAfterMs ?? 0;
  return Math.min(Math.max(jittered, retryAfterDelay), params.maxMs);
}
