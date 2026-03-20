import { describe, expect, it } from "vitest";
import { classifyFetchError, classifyHttpStatus } from "../src/provider/retry-policy.js";

describe("provider retry policy", () => {
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
});
