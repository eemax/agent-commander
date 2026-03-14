import type { ProviderUsageSnapshot } from "../types.js";
import type { OpenAIResponsesResponse } from "./openai-types.js";

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function addNullableNumber(current: number | null, next: number | null): number | null {
  if (next === null) {
    return current;
  }
  if (current === null) {
    return next;
  }
  return current + next;
}

function maxNullableNumber(current: number | null, next: number | null): number | null {
  if (next === null) {
    return current;
  }
  if (current === null) {
    return next;
  }
  return Math.max(current, next);
}

export function createEmptyUsageSnapshot(): ProviderUsageSnapshot {
  return {
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    peakInputTokens: null,
    peakOutputTokens: null,
    peakContextTokens: null
  };
}

export function extractUsageSnapshot(response: OpenAIResponsesResponse): ProviderUsageSnapshot {
  const usage = response.usage;
  const inputTokens = readNumber(usage?.input_tokens);
  const outputTokens = readNumber(usage?.output_tokens);
  const cachedTokens = readNumber(usage?.input_tokens_details?.cached_tokens);
  const reasoningTokens = readNumber(usage?.output_tokens_details?.reasoning_tokens);
  const peakContextTokens = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    peakInputTokens: inputTokens,
    peakOutputTokens: outputTokens,
    peakContextTokens
  };
}

export function accumulateUsageSnapshot(
  current: ProviderUsageSnapshot,
  response: OpenAIResponsesResponse
): ProviderUsageSnapshot {
  const next = extractUsageSnapshot(response);
  return {
    inputTokens: addNullableNumber(current.inputTokens, next.inputTokens),
    outputTokens: addNullableNumber(current.outputTokens, next.outputTokens),
    cachedTokens: addNullableNumber(current.cachedTokens, next.cachedTokens),
    reasoningTokens: addNullableNumber(current.reasoningTokens, next.reasoningTokens),
    peakInputTokens: maxNullableNumber(current.peakInputTokens ?? null, next.peakInputTokens ?? null),
    peakOutputTokens: maxNullableNumber(current.peakOutputTokens ?? null, next.peakOutputTokens ?? null),
    peakContextTokens: maxNullableNumber(current.peakContextTokens ?? null, next.peakContextTokens ?? null)
  };
}
