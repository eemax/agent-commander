import { describe, expect, it } from "vitest";
import { sanitizeReason } from "../src/provider/sanitize.js";

describe("sanitizeReason", () => {
  it("collapses whitespace and trims", () => {
    expect(sanitizeReason("  too   many\n\tspaces  ")).toBe("too many spaces");
  });

  it("redacts Bearer tokens", () => {
    expect(sanitizeReason("Authorization: Bearer sk-abc123xyz")).toBe(
      "Authorization: Bearer [REDACTED]"
    );
  });

  it("redacts sk- API keys", () => {
    expect(sanitizeReason("key is sk-proj-longKey_value-123")).toBe(
      "key is sk-[REDACTED]"
    );
  });

  it("returns fallback for empty input", () => {
    expect(sanitizeReason("")).toBe("Provider request failed");
    expect(sanitizeReason("   ")).toBe("Provider request failed");
  });

  it("truncates to default 300 chars with ellipsis", () => {
    const long = "a".repeat(400);
    const result = sanitizeReason(long);
    expect(result.length).toBe(300);
    expect(result.endsWith("...")).toBe(true);
  });

  it("respects custom maxChars parameter", () => {
    const long = "b".repeat(100);
    const result = sanitizeReason(long, 50);
    expect(result.length).toBe(50);
    expect(result.endsWith("...")).toBe(true);
  });

  it("does not truncate strings within limit", () => {
    expect(sanitizeReason("short message")).toBe("short message");
  });
});
