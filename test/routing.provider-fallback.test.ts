import { describe, it, expect } from "vitest";
import { buildProviderFallbackText } from "../src/routing/provider-fallback.js";
import type { ProviderErrorKind } from "../src/types.js";

describe("buildProviderFallbackText", () => {
  it.each<[ProviderErrorKind, string]>([
    ["timeout", "timed out"],
    ["network", "Network error"],
    ["rate_limit", "rate limit"],
    ["server_error", "service error"],
    ["client_error", "rejected"],
    ["invalid_response", "invalid response"],
    ["unknown", "Temporary"]
  ])("returns correct base for kind=%s", (kind, substring) => {
    const result = buildProviderFallbackText({ kind });
    expect(result).toContain(substring);
  });

  it("omits detail by default", () => {
    const result = buildProviderFallbackText({
      kind: "timeout",
      detail: { reason: "upstream took too long", openaiErrorType: null, openaiErrorCode: null, openaiErrorParam: null, requestId: null, retryAfterMs: null, timedOutBy: null }
    });
    expect(result).not.toContain("Details:");
  });

  it("appends detail when includeDetail is true", () => {
    const result = buildProviderFallbackText({
      kind: "timeout",
      detail: { reason: "upstream took too long", openaiErrorType: null, openaiErrorCode: null, openaiErrorParam: null, requestId: null, retryAfterMs: null, timedOutBy: null },
      includeDetail: true
    });
    expect(result).toContain("Details: upstream took too long");
  });

  it("truncates detail at 240 chars", () => {
    const longReason = "x".repeat(300);
    const result = buildProviderFallbackText({
      kind: "server_error",
      detail: { reason: longReason, openaiErrorType: null, openaiErrorCode: null, openaiErrorParam: null, requestId: null, retryAfterMs: null, timedOutBy: null },
      includeDetail: true
    });
    const detailPart = result.split("Details: ")[1];
    expect(detailPart.length).toBe(240);
    expect(detailPart).toMatch(/\.\.\.$/);
  });

  it("omits detail line when reason is empty", () => {
    const result = buildProviderFallbackText({
      kind: "timeout",
      detail: { reason: "", openaiErrorType: null, openaiErrorCode: null, openaiErrorParam: null, requestId: null, retryAfterMs: null, timedOutBy: null },
      includeDetail: true
    });
    expect(result).not.toContain("Details:");
  });

  it("falls back to unknown message for unrecognized kind", () => {
    const result = buildProviderFallbackText({ kind: "bogus" as ProviderErrorKind });
    expect(result).toContain("Temporary");
  });
});
