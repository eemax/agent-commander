import { describe, it, expect, vi } from "vitest";
import {
  createEmptyUsageSnapshot,
  extractUsageSnapshot,
  accumulateUsageSnapshot,
  countCompactionItems
} from "../src/provider/usage.js";

describe("createEmptyUsageSnapshot", () => {
  it("returns all-null fields", () => {
    const snapshot = createEmptyUsageSnapshot();
    expect(snapshot).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
      peakInputTokens: null,
      peakOutputTokens: null,
      peakContextTokens: null,
      lastCacheHitAt: null
    });
  });
});

describe("extractUsageSnapshot", () => {
  it("extracts all token fields", () => {
    const snap = extractUsageSnapshot({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 30 },
        output_tokens_details: { reasoning_tokens: 10 }
      }
    });
    expect(snap.inputTokens).toBe(100);
    expect(snap.outputTokens).toBe(50);
    expect(snap.cachedTokens).toBe(30);
    expect(snap.reasoningTokens).toBe(10);
  });

  it("computes peakContextTokens as input + output", () => {
    const snap = extractUsageSnapshot({
      usage: { input_tokens: 100, output_tokens: 50 }
    });
    expect(snap.peakContextTokens).toBe(150);
  });

  it("returns null peakContextTokens when tokens missing", () => {
    const snap = extractUsageSnapshot({});
    expect(snap.peakContextTokens).toBeNull();
  });

  it("sets lastCacheHitAt only when cachedTokens > 0", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01"));

    const withCache = extractUsageSnapshot({
      usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 10 } }
    });
    expect(withCache.lastCacheHitAt).toBe(Date.now());

    const noCache = extractUsageSnapshot({
      usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 0 } }
    });
    expect(noCache.lastCacheHitAt).toBeNull();

    vi.useRealTimers();
  });

  it("returns null for non-finite or missing usage", () => {
    const snap = extractUsageSnapshot({ usage: { input_tokens: NaN, output_tokens: Infinity } });
    expect(snap.inputTokens).toBeNull();
    expect(snap.outputTokens).toBeNull();
  });
});

describe("countCompactionItems", () => {
  it("counts items with type compaction", () => {
    expect(
      countCompactionItems([
        { type: "compaction" },
        { type: "message" },
        { type: "compaction" }
      ])
    ).toBe(2);
  });

  it("returns 0 for empty array", () => {
    expect(countCompactionItems([])).toBe(0);
  });
});

describe("accumulateUsageSnapshot", () => {
  it("sums additive fields", () => {
    const current = extractUsageSnapshot({
      usage: { input_tokens: 100, output_tokens: 50 }
    });
    const result = accumulateUsageSnapshot(current, {
      usage: { input_tokens: 200, output_tokens: 100 }
    });
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(150);
  });

  it("takes max of peak fields", () => {
    const current = extractUsageSnapshot({
      usage: { input_tokens: 300, output_tokens: 50 }
    });
    const result = accumulateUsageSnapshot(current, {
      usage: { input_tokens: 100, output_tokens: 200 }
    });
    expect(result.peakInputTokens).toBe(300);
    expect(result.peakOutputTokens).toBe(200);
    expect(result.peakContextTokens).toBe(350); // max(350, 300)
  });

  it("handles null current gracefully", () => {
    const empty = createEmptyUsageSnapshot();
    const result = accumulateUsageSnapshot(empty, {
      usage: { input_tokens: 100, output_tokens: 50 }
    });
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });
});
