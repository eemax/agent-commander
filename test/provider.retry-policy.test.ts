import { describe, expect, it } from "vitest";
import {
  classifyFetchError,
  classifyHttpStatus,
  computeRetryDelayMs
} from "../src/provider/retry-policy.js";
import { ProviderError } from "../src/provider-error.js";

const EMPTY_BODY = JSON.stringify({});

function httpParams(overrides: Partial<Parameters<typeof classifyHttpStatus>[0]> = {}) {
  return {
    status: 200,
    body: EMPTY_BODY,
    retryAfterHeader: null,
    requestIdHeader: null,
    nowMs: 0,
    ...overrides
  };
}

/* ------------------------------------------------------------------ */
/*  classifyHttpStatus                                                */
/* ------------------------------------------------------------------ */
describe("classifyHttpStatus", () => {
  it("classifies HTTP 429 as retryable rate-limit with retry-after and request id", () => {
    const decision = classifyHttpStatus({
      status: 429,
      body: JSON.stringify({
        error: {
          message: "Rate limit exceeded",
          type: "rate_limit_error",
          code: null,
          param: null
        }
      }),
      retryAfterHeader: "2",
      requestIdHeader: "req_123",
      nowMs: 0
    });

    expect(decision).toMatchObject({
      retryable: true,
      kind: "rate_limit",
      statusCode: 429,
      retryAfterMs: 2_000,
      detail: {
        reason: expect.stringContaining("OpenAI HTTP 429"),
        openaiErrorType: "rate_limit_error",
        requestId: "req_123",
        retryAfterMs: 2_000
      }
    });
  });

  it("classifies 400 as non-retryable client error", () => {
    const decision = classifyHttpStatus(httpParams({ status: 400 }));
    expect(decision.kind).toBe("client_error");
    expect(decision.retryable).toBe(false);
  });

  it("classifies 408 as retryable timeout", () => {
    const decision = classifyHttpStatus(httpParams({ status: 408 }));
    expect(decision.kind).toBe("timeout");
    expect(decision.retryable).toBe(true);
  });

  it("classifies 409 as retryable server error", () => {
    const decision = classifyHttpStatus(httpParams({ status: 409 }));
    expect(decision.kind).toBe("server_error");
    expect(decision.retryable).toBe(true);
  });

  it("classifies 500+ as retryable server error", () => {
    for (const status of [500, 502, 503]) {
      const decision = classifyHttpStatus(httpParams({ status }));
      expect(decision.kind).toBe("server_error");
      expect(decision.retryable).toBe(true);
    }
  });

  it("parses retry-after as date string", () => {
    const futureDate = new Date(10_000).toUTCString();
    const decision = classifyHttpStatus(
      httpParams({ status: 429, retryAfterHeader: futureDate, nowMs: 5_000 })
    );
    expect(decision.retryAfterMs).toBe(5_000);
  });

  it("returns null retryAfterMs for empty header", () => {
    const decision = classifyHttpStatus(httpParams({ status: 429, retryAfterHeader: "" }));
    expect(decision.retryAfterMs).toBeNull();
  });

  it("handles malformed body JSON gracefully", () => {
    const decision = classifyHttpStatus(httpParams({ status: 500, body: "not json" }));
    expect(decision.kind).toBe("server_error");
    expect(decision.detail?.openaiErrorType).toBeNull();
  });

  it("handles body without error key", () => {
    const decision = classifyHttpStatus(
      httpParams({ status: 500, body: JSON.stringify({ data: "no error" }) })
    );
    expect(decision.detail?.openaiErrorType).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  classifyFetchError                                                */
/* ------------------------------------------------------------------ */
describe("classifyFetchError", () => {
  it("distinguishes local timeout and upstream abort", () => {
    const local = classifyFetchError(new DOMException("aborted", "AbortError"), {
      localTimeoutFired: true
    });
    expect(local).toMatchObject({
      retryable: true,
      kind: "timeout",
      detail: {
        timedOutBy: "local_timeout"
      }
    });

    const upstreamController = new AbortController();
    upstreamController.abort();
    const upstream = classifyFetchError(new DOMException("aborted", "AbortError"), {
      localTimeoutFired: false,
      upstreamAbortSignal: upstreamController.signal
    });
    expect(upstream).toMatchObject({
      retryable: false,
      kind: "timeout",
      detail: {
        timedOutBy: "upstream_abort"
      }
    });
  });

  it("passes through ProviderError", () => {
    const err = new ProviderError({
      message: "custom",
      kind: "rate_limit",
      statusCode: 429,
      attempts: 2,
      retryable: true,
      detail: {
        reason: "rate limited",
        openaiErrorType: null,
        openaiErrorCode: null,
        openaiErrorParam: null,
        requestId: null,
        retryAfterMs: 3000,
        timedOutBy: null
      }
    });
    const decision = classifyFetchError(err);
    expect(decision.kind).toBe("rate_limit");
    expect(decision.retryable).toBe(true);
    expect(decision.retryAfterMs).toBe(3000);
  });

  it("classifies TypeError as retryable network error", () => {
    const decision = classifyFetchError(new TypeError("fetch failed"));
    expect(decision.kind).toBe("network");
    expect(decision.retryable).toBe(true);
  });

  it("classifies SyntaxError as non-retryable invalid_response", () => {
    const decision = classifyFetchError(new SyntaxError("unexpected token"));
    expect(decision.kind).toBe("invalid_response");
    expect(decision.retryable).toBe(false);
  });

  it("classifies generic Error as non-retryable unknown", () => {
    const decision = classifyFetchError(new Error("something"));
    expect(decision.kind).toBe("unknown");
    expect(decision.retryable).toBe(false);
  });

  it("handles string errors", () => {
    const decision = classifyFetchError("raw string");
    expect(decision.kind).toBe("unknown");
    expect(decision.message).toBe("raw string");
  });
});

/* ------------------------------------------------------------------ */
/*  computeRetryDelayMs                                               */
/* ------------------------------------------------------------------ */
describe("computeRetryDelayMs", () => {
  it("computes exponential backoff", () => {
    const delay = computeRetryDelayMs({
      attempt: 1,
      baseMs: 100,
      maxMs: 10_000,
      retryAfterMs: null,
      random: () => 1 // max jitter
    });
    // baseMs * 2^0 = 100, jitter with random=1 → floor(1 * 100) = 100
    expect(delay).toBe(100);
  });

  it("respects maxMs cap", () => {
    const delay = computeRetryDelayMs({
      attempt: 10,
      baseMs: 100,
      maxMs: 500,
      retryAfterMs: null,
      random: () => 1
    });
    expect(delay).toBeLessThanOrEqual(500);
  });

  it("respects retryAfterMs floor", () => {
    const delay = computeRetryDelayMs({
      attempt: 1,
      baseMs: 100,
      maxMs: 10_000,
      retryAfterMs: 5000,
      random: () => 0 // min jitter → 0
    });
    expect(delay).toBe(5000);
  });

  it("caps retryAfterMs at maxMs", () => {
    const delay = computeRetryDelayMs({
      attempt: 1,
      baseMs: 100,
      maxMs: 500,
      retryAfterMs: 10_000,
      random: () => 0
    });
    expect(delay).toBeLessThanOrEqual(500);
  });
});
