import { describe, expect, it } from "vitest";
import { buildStatusReply } from "../src/routing/formatters.js";

const baseParams = {
  conversationId: "conv_1",
  model: "gpt-5.3-codex",
  modelContextWindow: 400_000,
  modelMaxOutputTokens: 8_000,
  workspaceRoot: "/tmp/workspace",
  skillsCount: 2,
  fullObservabilityEnabled: false,
  verboseEnabled: false,
  thinkingEffort: "medium" as const,
  cwd: "/tmp/workspace",
  sessions: [],
  completedProcessCount: 0,
  stateHealth: {
    cachedSessions: 1,
    maxCachedSessions: 200,
    queuedAppends: 0,
    evictedSessions: 0
  },
  workspaceHealth: {
    refreshCalls: 1,
    refreshNoChange: 1
  },
  processHealth: {
    truncatedCombinedChars: 0,
    truncatedStdoutChars: 0,
    truncatedStderrChars: 0
  },
  toolRuntime: {
    toolSuccessCount: 0,
    toolFailureCount: 0,
    errorCodeCounts: {},
    workflowsStarted: 0,
    workflowsSucceeded: 0,
    workflowsFailed: 0,
    workflowsTimedOut: 0,
    workflowsInterrupted: 0,
    workflowsCleanupErrors: 0,
    workflowLoopBreakerTrips: 0
  },
  toolResultStats: {
    total: 0,
    success: 0,
    fail: 0,
    byTool: {}
  },
  cacheRetention: "in_memory" as const,
  transportMode: "http" as const,
  compactionTokens: null,
  compactionThreshold: 1,
  compactionCount: 0,
  lastProviderFailure: null
};

describe("buildStatusReply", () => {
  it("shows n/a summary when usage is unavailable", () => {
    const text = buildStatusReply({
      ...baseParams,
      latestUsage: null
    });

    expect(text).toContain("🧮 Tokens: n/a");
    expect(text).toContain("📚 Context: n/a");
    expect(text).toContain("🗄️ Cache: n/a · last: never");
  });

  it("shows budget context summary and cache details when usage is available", () => {
    const text = buildStatusReply({
      ...baseParams,
      verboseEnabled: true,
      thinkingEffort: "high",
      latestUsage: {
        inputTokens: 8_700,
        outputTokens: 138,
        cachedTokens: 8_300,
        reasoningTokens: 42,
        peakInputTokens: 8_700,
        peakOutputTokens: 138,
        peakContextTokens: 8_838
      }
    });

    expect(text).toContain("🧠 gpt-5.3-codex");
    expect(text).toContain("🧮 Tokens: 8.7k in / 138 out · 42 reasoning");
    expect(text).toContain("📚 Context: 8.7k / 392k (2%)");
    expect(text).toContain("🗄️ Cache: 95% hit");
    expect(text).toContain("⚙️ Think: high · cache: in_memory · transport: http · processes: 0 running");
    expect(text).toContain("📁 `/tmp/workspace`");
    expect(text).not.toContain("verbose: on");
    expect(text).not.toContain("observability: off");
    expect(text).not.toContain("conversation:");
  });

  it("shows unknown budget context when model max_output_tokens is unavailable", () => {
    const text = buildStatusReply({
      ...baseParams,
      modelMaxOutputTokens: null,
      latestUsage: {
        inputTokens: 4_000,
        outputTokens: 120,
        cachedTokens: 3_000,
        reasoningTokens: 25,
        peakInputTokens: 3_800,
        peakOutputTokens: 120,
        peakContextTokens: 3_920
      }
    });

    expect(text).toContain("📚 Context: n/a");
  });

  it("shows unknown denominator when context_window is unavailable", () => {
    const text = buildStatusReply({
      ...baseParams,
      modelContextWindow: null,
      latestUsage: {
        inputTokens: 3_500,
        outputTokens: 110,
        cachedTokens: 2_000,
        reasoningTokens: 10,
        peakInputTokens: 3_500,
        peakOutputTokens: 110,
        peakContextTokens: 3_610
      }
    });

    expect(text).toContain("📚 Context: 3.5k / unknown (n/a)");
  });

  it("shows zero budget usage against available context at the start of a turn", () => {
    const text = buildStatusReply({
      ...baseParams,
      modelMaxOutputTokens: 128_000,
      latestUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        peakInputTokens: 0,
        peakOutputTokens: 0,
        peakContextTokens: 0
      }
    });

    expect(text).toContain("📚 Context: 0 / 272k (0%)");
  });

  it("shows n/a budget context when max_output_tokens is not less than context_window", () => {
    const text = buildStatusReply({
      ...baseParams,
      modelContextWindow: 8_000,
      modelMaxOutputTokens: 8_000,
      latestUsage: {
        inputTokens: 1_000,
        outputTokens: 120,
        cachedTokens: 500,
        reasoningTokens: 10,
        peakInputTokens: 1_000,
        peakOutputTokens: 120,
        peakContextTokens: 1_120
      }
    });

    expect(text).toContain("📚 Context: n/a");
  });

  it("includes diagnostics when requested", () => {
    const text = buildStatusReply({
      ...baseParams,
      includeDiagnostics: true,
      latestUsage: null
    });

    expect(text).toContain("conversation: conv...nv_1");
    expect(text).toContain("verbose: off");
    expect(text).toContain("observability: off");
    expect(text).toContain("provider.last_failure_kind: none");
    expect(text).toContain("provider.last_failure_status: none");
    expect(text).toContain("provider.last_failure_attempts: none");
    expect(text).toContain("provider.last_failure_at: none");
    expect(text).toContain("provider.last_failure_reason: none");
    expect(text).toContain("state.cache: 1/200");
    expect(text).toContain("workspace.refresh: 1");
    expect(text).toContain("process.truncated_combined_chars: 0");
    expect(text).toContain("tool.results_total: 0");
    expect(text).toContain("workflow.started: 0");
    expect(text).toContain("tool.error_codes: none");
    expect(text).toContain("completed processes: 0");
    expect(text).toContain("running processes: 0");
    expect(text).toContain("📁 `/tmp/workspace`");
    expect(text).not.toContain("workspace.manifest_hash:");
    expect(text).not.toContain("workspace.snapshot_signature:");
    expect(text).not.toContain("model: ");
    expect(text).not.toContain("workspace: ");
    expect(text).not.toContain("full_observability:");
  });

  it("shows only running processes with compact ids and a completed-process count", () => {
    const text = buildStatusReply({
      ...baseParams,
      includeDiagnostics: true,
      latestUsage: null,
      completedProcessCount: 2,
      sessions: [
        {
          sessionId: "proc_01KKMJV0Z0PQXKPD32GQQTAVN5",
          command: "ls -la ~"
        }
      ]
    });

    expect(text).toContain("completed processes: 2");
    expect(text).toContain("running processes: 1");
    expect(text).toContain("- proc...AVN5 ls -la ~");
  });

  it("includes last provider failure summary in diagnostics", () => {
    const text = buildStatusReply({
      ...baseParams,
      includeDiagnostics: true,
      latestUsage: null,
      lastProviderFailure: {
        at: "2026-03-20T07:00:00.000Z",
        kind: "rate_limit",
        statusCode: 429,
        attempts: 3,
        reason: "OpenAI HTTP 429 (rate limit) type=rate_limit_error: Try again in 1s."
      }
    });

    expect(text).toContain("provider.last_failure_kind: rate_limit");
    expect(text).toContain("provider.last_failure_status: 429");
    expect(text).toContain("provider.last_failure_attempts: 3");
    expect(text).toContain("provider.last_failure_at: 2026-03-20T07:00:00.000Z");
    expect(text).toContain("provider.last_failure_reason: OpenAI HTTP 429 (rate limit) type=rate_limit_error: Try again in 1s.");
  });

  it("formats tool result stats with normalized names and sorted counts", () => {
    const text = buildStatusReply({
      ...baseParams,
      includeDiagnostics: true,
      latestUsage: null,
      toolResultStats: {
        total: 14,
        success: 11,
        fail: 3,
        byTool: {
          write_file: 10,
          bash: 1,
          custom_tool_name: 3
        }
      }
    });

    expect(text).toContain("tool.results_total: 14");
    expect(text).toContain("tool.results_success: 11");
    expect(text).toContain("tool.results_fail: 3");
    expect(text).toContain("tool.results_by_name: Write=10, Custom Tool Name=3, Bash=1");
  });

  it("shows compaction threshold on context budget row when configured", () => {
    const text = buildStatusReply({
      ...baseParams,
      compactionTokens: 200_000,
      compactionThreshold: 0.8,
      latestUsage: {
        inputTokens: 8_700,
        outputTokens: 138,
        cachedTokens: 8_300,
        reasoningTokens: 42,
        peakInputTokens: 8_700,
        peakOutputTokens: 138,
        peakContextTokens: 8_838
      }
    });

    expect(text).toContain("📚 Context: 8.7k / 392k (2%) · compact at: 160k");
    expect(text).not.toContain("hits");
  });

  it("shows compaction hit count when compactions have occurred", () => {
    const text = buildStatusReply({
      ...baseParams,
      compactionTokens: 200_000,
      compactionThreshold: 0.8,
      compactionCount: 3,
      latestUsage: {
        inputTokens: 8_700,
        outputTokens: 138,
        cachedTokens: 8_300,
        reasoningTokens: 42,
        peakInputTokens: 8_700,
        peakOutputTokens: 138,
        peakContextTokens: 8_838
      }
    });

    expect(text).toContain("📚 Context: 8.7k / 392k (2%) · compact at: 160k (3 hits)");
  });

  it("shows singular hit label for single compaction", () => {
    const text = buildStatusReply({
      ...baseParams,
      compactionTokens: 200_000,
      compactionThreshold: 1,
      compactionCount: 1,
      latestUsage: {
        inputTokens: 8_700,
        outputTokens: 138,
        cachedTokens: 8_300,
        reasoningTokens: 42,
        peakInputTokens: 8_700,
        peakOutputTokens: 138,
        peakContextTokens: 8_838
      }
    });

    expect(text).toContain("· compact at: 200k (1 hit)");
  });

  it("shows last cache hit relative time on cache row", () => {
    const nowMs = 1_700_000_120_000;
    const text = buildStatusReply({
      ...baseParams,
      nowMs,
      latestUsage: {
        inputTokens: 8_700,
        outputTokens: 138,
        cachedTokens: 8_300,
        reasoningTokens: 42,
        peakInputTokens: 8_700,
        peakOutputTokens: 138,
        peakContextTokens: 8_838,
        lastCacheHitAt: 1_700_000_000_000
      }
    });

    expect(text).toContain("🗄️ Cache: 95% hit · 8.3k cached · 400 new · last: 2m ago");
  });

  it("places context budget before tokens in row order", () => {
    const text = buildStatusReply({
      ...baseParams,
      latestUsage: {
        inputTokens: 1_000,
        outputTokens: 100,
        cachedTokens: 500,
        reasoningTokens: null,
        peakInputTokens: 1_000,
        peakOutputTokens: 100,
        peakContextTokens: 1_100
      }
    });

    const lines = text.split("\n");
    const contextIdx = lines.findIndex((l) => l.startsWith("📚"));
    const tokensIdx = lines.findIndex((l) => l.startsWith("🧮"));
    expect(contextIdx).toBeLessThan(tokensIdx);
  });
});
