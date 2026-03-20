import { ProviderError, type ProviderFailureDetail } from "../provider-error.js";
import type { ProviderErrorKind } from "../types.js";

export type RetryDecision = {
  retryable: boolean;
  kind: ProviderErrorKind;
  statusCode: number | null;
  message: string;
  retryAfterMs: number | null;
  detail: ProviderFailureDetail | null;
};

const REASON_MAX_CHARS = 300;

type ParsedOpenAIError = {
  message: string | null;
  type: string | null;
  code: string | null;
  param: string | null;
};

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function coerceString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return normalizeNonEmptyString(value);
}

function sanitizeReason(raw: string): string {
  const normalized = raw
    .replace(/\s+/g, " ")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "sk-[REDACTED]")
    .trim();

  if (normalized.length === 0) {
    return "Provider request failed";
  }

  if (normalized.length <= REASON_MAX_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, REASON_MAX_CHARS - 3)}...`;
}

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

function parseOpenAIErrorBody(body: string): ParsedOpenAIError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      message: null,
      type: null,
      code: null,
      param: null
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      message: null,
      type: null,
      code: null,
      param: null
    };
  }

  const error = (parsed as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return {
      message: null,
      type: null,
      code: null,
      param: null
    };
  }

  const errorRecord = error as Record<string, unknown>;
  return {
    message: normalizeNonEmptyString(errorRecord.message),
    type: normalizeNonEmptyString(errorRecord.type),
    code: coerceString(errorRecord.code),
    param: coerceString(errorRecord.param)
  };
}

function formatHttpReason(params: {
  status: number;
  kind: ProviderErrorKind;
  openaiMessage: string | null;
  openaiType: string | null;
  openaiCode: string | null;
  openaiParam: string | null;
}): string {
  const classification =
    params.kind === "rate_limit"
      ? "rate limit"
      : params.kind === "server_error"
        ? "server error"
        : params.kind === "client_error"
          ? "client error"
          : params.kind === "timeout"
            ? "timeout"
            : params.kind;

  const prefixes: string[] = [`OpenAI HTTP ${params.status} (${classification})`];
  if (params.openaiType) {
    prefixes.push(`type=${params.openaiType}`);
  }
  if (params.openaiCode) {
    prefixes.push(`code=${params.openaiCode}`);
  }
  if (params.openaiParam) {
    prefixes.push(`param=${params.openaiParam}`);
  }

  const base = prefixes.join(" ");
  if (!params.openaiMessage) {
    return sanitizeReason(base);
  }

  return sanitizeReason(`${base}: ${params.openaiMessage}`);
}

export function classifyFetchError(
  error: unknown,
  context: {
    localTimeoutFired?: boolean;
    upstreamAbortSignal?: AbortSignal;
  } = {}
): RetryDecision {
  if (error instanceof ProviderError) {
    return {
      retryable: error.retryable,
      kind: error.kind,
      statusCode: error.statusCode,
      message: error.message,
      retryAfterMs: error.detail?.retryAfterMs ?? null,
      detail: error.detail
    };
  }

  if (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    const timedOutBy = context.localTimeoutFired
      ? "local_timeout"
      : context.upstreamAbortSignal?.aborted
        ? "upstream_abort"
        : null;
    const message =
      timedOutBy === "upstream_abort"
        ? "OpenAI request interrupted by upstream abort signal"
        : "OpenAI request timed out";

    return {
      retryable: timedOutBy !== "upstream_abort",
      kind: "timeout",
      statusCode: null,
      message,
      retryAfterMs: null,
      detail: {
        reason: sanitizeReason(message),
        openaiErrorType: null,
        openaiErrorCode: null,
        openaiErrorParam: null,
        requestId: null,
        retryAfterMs: null,
        timedOutBy
      }
    };
  }

  if (error instanceof TypeError) {
    const message = `OpenAI network request failed: ${error.message}`;
    return {
      retryable: true,
      kind: "network",
      statusCode: null,
      message,
      retryAfterMs: null,
      detail: {
        reason: sanitizeReason(message),
        openaiErrorType: null,
        openaiErrorCode: null,
        openaiErrorParam: null,
        requestId: null,
        retryAfterMs: null,
        timedOutBy: null
      }
    };
  }

  if (error instanceof SyntaxError) {
    const message = `OpenAI response parsing failed: ${error.message}`;
    return {
      retryable: false,
      kind: "invalid_response",
      statusCode: null,
      message,
      retryAfterMs: null,
      detail: {
        reason: sanitizeReason(message),
        openaiErrorType: null,
        openaiErrorCode: null,
        openaiErrorParam: null,
        requestId: null,
        retryAfterMs: null,
        timedOutBy: null
      }
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    retryable: false,
    kind: "unknown",
    statusCode: null,
    message,
    retryAfterMs: null,
    detail: {
      reason: sanitizeReason(message),
      openaiErrorType: null,
      openaiErrorCode: null,
      openaiErrorParam: null,
      requestId: null,
      retryAfterMs: null,
      timedOutBy: null
    }
  };
}

export function classifyHttpStatus(params: {
  status: number;
  body: string;
  retryAfterHeader: string | null;
  requestIdHeader: string | null;
  nowMs: number;
}): RetryDecision {
  const retryAfterMs = parseRetryAfterMs(params.retryAfterHeader, params.nowMs);
  const parsedError = parseOpenAIErrorBody(params.body);

  const kind: ProviderErrorKind =
    params.status === 429
      ? "rate_limit"
      : params.status === 408
        ? "timeout"
        : params.status === 409 || params.status >= 500
          ? "server_error"
          : "client_error";
  const retryable =
    params.status === 429 || params.status === 408 || params.status === 409 || params.status >= 500;

  const reason = formatHttpReason({
    status: params.status,
    kind,
    openaiMessage: parsedError.message,
    openaiType: parsedError.type,
    openaiCode: parsedError.code,
    openaiParam: parsedError.param
  });

  const requestId = normalizeNonEmptyString(params.requestIdHeader);

  return {
    retryable,
    kind,
    statusCode: params.status,
    message: reason,
    retryAfterMs,
    detail: {
      reason,
      openaiErrorType: parsedError.type,
      openaiErrorCode: parsedError.code,
      openaiErrorParam: parsedError.param,
      requestId,
      retryAfterMs,
      timedOutBy: null
    }
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
