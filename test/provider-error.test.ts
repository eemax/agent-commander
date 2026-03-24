import { describe, it, expect } from "vitest";
import { ProviderError } from "../src/provider-error.js";

describe("ProviderError", () => {
  it("sets all fields from constructor", () => {
    const detail = {
      reason: "test reason",
      openaiErrorType: "rate_limit",
      openaiErrorCode: "429",
      openaiErrorParam: null,
      requestId: "req-1",
      retryAfterMs: 5000,
      timedOutBy: null as const
    };

    const err = new ProviderError({
      message: "Rate limited",
      kind: "rate_limit",
      statusCode: 429,
      attempts: 3,
      retryable: true,
      detail,
      cause: new Error("original")
    });

    expect(err.name).toBe("ProviderError");
    expect(err.message).toBe("Rate limited");
    expect(err.kind).toBe("rate_limit");
    expect(err.statusCode).toBe(429);
    expect(err.attempts).toBe(3);
    expect(err.retryable).toBe(true);
    expect(err.detail).toBe(detail);
    expect(err.cause).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(Error);
  });

  it("defaults statusCode and detail to null", () => {
    const err = new ProviderError({
      message: "oops",
      kind: "unknown",
      attempts: 1,
      retryable: false
    });

    expect(err.statusCode).toBeNull();
    expect(err.detail).toBeNull();
  });
});
