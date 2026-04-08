import { describe, expect, it } from "vitest";
import type { ToolCallReport } from "../src/types.js";
import type { CountAccumulatorEntry } from "../src/routing/formatters.js";
import { buildStatusReply, extractCountUpdate, formatCountModeBuffer } from "../src/routing/formatters.js";

const baseParams = {
  conversationId: "conv_1",
  model: "gpt-5.3-codex",
  modelContextWindow: 400_000,
  modelMaxOutputTokens: 8_000,
  workspaceRoot: "/tmp/workspace",
  skillsCount: 2,
  fullObservabilityEnabled: false,
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
  authMode: "api" as const,
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

    expect(text).toContain("🧮Tokens: n/a");
    expect(text).toContain("📚Context: n/a");
    expect(text).toContain("🗄️Cache: n/a · never");
  });

  it("shows budget context summary and cache details when usage is available", () => {
    const text = buildStatusReply({
      ...baseParams,
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

    expect(text).toContain("🧠gpt-5.3-codex");
    expect(text).toContain("🧮Tokens: 8.7k in / 138 out · 42 reasoning");
    expect(text).toContain("📚Context: 8.7k / 392k (2%)");
    expect(text).toContain("🗄️Cache: 8.3k hit (95%)");
    expect(text).toContain("🧠gpt-5.3-codex · t: high · api:http");
    expect(text).toContain("📁`/tmp/workspace`");
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

    expect(text).toContain("📚Context: n/a");
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

    expect(text).toContain("📚Context: 3.5k / unknown (n/a)");
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

    expect(text).toContain("📚Context: 0 / 272k (0%)");
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

    expect(text).toContain("📚Context: n/a");
  });

  it("includes diagnostics when requested", () => {
    const text = buildStatusReply({
      ...baseParams,
      includeDiagnostics: true,
      latestUsage: null
    });

    expect(text).toContain("conversation: conv...nv_1");
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
    expect(text).toContain("📁`/tmp/workspace`");
    expect(text).not.toContain("workspace.manifest_hash:");
    expect(text).not.toContain("workspace.snapshot_signature:");
    expect(text).not.toContain("model: gpt");
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

    expect(text).toContain("📚Context: 8.7k / 392k (2%) · ♻️160k");
    expect(text).not.toContain("x)");
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

    expect(text).toContain("📚Context: 8.7k / 392k (2%) · ♻️160k(3x)");
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

    expect(text).toContain("· ♻️200k(1x)");
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

    expect(text).toContain("🗄️Cache: 8.3k hit (95%) · 400 new · 2m ago");
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

// ---------------------------------------------------------------------------
// extractCountUpdate
// ---------------------------------------------------------------------------

function makeReport(overrides: Partial<ToolCallReport> & { tool: string }): ToolCallReport {
  return { args: {}, result: {}, success: true, error: null, ...overrides };
}

describe("extractCountUpdate", () => {
  it("extracts read_file chars from result.content", () => {
    const update = extractCountUpdate(makeReport({
      tool: "read_file",
      result: { content: "hello world" }
    }));
    expect(update).toMatchObject({ key: "read_file", emoji: "📖", label: "Read", chars: 11, trackChars: true, success: true });
  });

  it("extracts write_file chars from args.content first", () => {
    const update = extractCountUpdate(makeReport({
      tool: "write_file",
      args: { content: "abc" },
      result: { size: 99 }
    }));
    expect(update.chars).toBe(3);
  });

  it("falls back to result.size for write_file when args.content is missing", () => {
    const update = extractCountUpdate(makeReport({
      tool: "write_file",
      args: {},
      result: { size: 42 }
    }));
    expect(update.chars).toBe(42);
  });

  it("extracts bash chars from result.combined first", () => {
    const update = extractCountUpdate(makeReport({
      tool: "bash",
      result: { combined: "output", stdout: "out" }
    }));
    expect(update.chars).toBe(6);
  });

  it("falls back to result.stdout for bash when combined is missing", () => {
    const update = extractCountUpdate(makeReport({
      tool: "bash",
      result: { stdout: "fallback" }
    }));
    expect(update.chars).toBe(8);
  });

  it("extracts web_fetch chars from result.content", () => {
    const update = extractCountUpdate(makeReport({
      tool: "web_fetch",
      result: { content: "page content" }
    }));
    expect(update).toMatchObject({ emoji: "🔗", label: "Web fetch", chars: 12, trackChars: true });
  });

  it("extracts web_search chars from result.response_text", () => {
    const update = extractCountUpdate(makeReport({
      tool: "web_search",
      result: { response_text: "search results" }
    }));
    expect(update).toMatchObject({ emoji: "🔎", label: "Web search", chars: 14, trackChars: true });
  });

  it("returns non-tracked metadata for glob", () => {
    const update = extractCountUpdate(makeReport({
      tool: "glob",
      result: { matches: ["src/a.ts"] }
    }));
    expect(update).toMatchObject({ emoji: "🗂️", label: "Glob", chars: 0, trackChars: false });
  });

  it("returns non-tracked metadata for grep", () => {
    const update = extractCountUpdate(makeReport({
      tool: "grep",
      result: { matches: [{ path: "src/a.ts", line: 1, text: "needle" }] }
    }));
    expect(update).toMatchObject({ emoji: "🔍", label: "Grep", chars: 0, trackChars: false });
  });

  it("returns zero chars for non-tracked tools", () => {
    const update = extractCountUpdate(makeReport({
      tool: "replace_in_file",
      result: { replacements: 3 }
    }));
    expect(update).toMatchObject({ emoji: "🔁", label: "Replace", chars: 0, trackChars: false });
  });

  it("returns zero chars for failed tracked tools", () => {
    const update = extractCountUpdate(makeReport({
      tool: "read_file",
      success: false,
      error: "not found",
      result: { content: "should be ignored" }
    }));
    expect(update.chars).toBe(0);
    expect(update.success).toBe(false);
  });

  it("uses fallback meta for unknown tools", () => {
    const update = extractCountUpdate(makeReport({
      tool: "custom_magic_tool"
    }));
    expect(update).toMatchObject({ emoji: "🔧", label: "custom_magic_tool", chars: 0, trackChars: false });
  });
});

// ---------------------------------------------------------------------------
// formatCountModeBuffer
// ---------------------------------------------------------------------------

describe("formatCountModeBuffer", () => {
  it("formats a single entry", () => {
    const entries = new Map<string, CountAccumulatorEntry>([
      ["read_file", { emoji: "📖", label: "Read", count: 3, failed: 0, chars: 1500, trackChars: true }]
    ]);
    expect(formatCountModeBuffer(entries)).toBe("📖 Read ×3 (1.5k chars)");
  });

  it("formats multiple entries in insertion order", () => {
    const entries = new Map<string, CountAccumulatorEntry>([
      ["bash", { emoji: "🐚", label: "Bash", count: 2, failed: 0, chars: 500, trackChars: true }],
      ["read_file", { emoji: "📖", label: "Read", count: 1, failed: 0, chars: 100, trackChars: true }]
    ]);
    const lines = formatCountModeBuffer(entries).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Bash");
    expect(lines[1]).toContain("Read");
  });

  it("shows failed suffix when failed > 0", () => {
    const entries = new Map<string, CountAccumulatorEntry>([
      ["bash", { emoji: "🐚", label: "Bash", count: 3, failed: 1, chars: 2000, trackChars: true }]
    ]);
    expect(formatCountModeBuffer(entries)).toBe("🐚 Bash ×3 (2k chars) · 1 failed");
  });

  it("omits char suffix for non-tracked tools", () => {
    const entries = new Map<string, CountAccumulatorEntry>([
      ["replace_in_file", { emoji: "🔁", label: "Replace", count: 5, failed: 0, chars: 0, trackChars: false }]
    ]);
    expect(formatCountModeBuffer(entries)).toBe("🔁 Replace ×5");
  });

  it("omits char suffix when chars is zero even if tracked", () => {
    const entries = new Map<string, CountAccumulatorEntry>([
      ["bash", { emoji: "🐚", label: "Bash", count: 1, failed: 1, chars: 0, trackChars: true }]
    ]);
    expect(formatCountModeBuffer(entries)).toBe("🐚 Bash ×1 · 1 failed");
  });

  it("returns empty string for empty accumulator", () => {
    expect(formatCountModeBuffer(new Map())).toBe("");
  });

  it("handles large char counts via formatCompactNumber", () => {
    const entries = new Map<string, CountAccumulatorEntry>([
      ["read_file", { emoji: "📖", label: "Read", count: 1, failed: 0, chars: 2_500_000, trackChars: true }]
    ]);
    const output = formatCountModeBuffer(entries);
    expect(output).toContain("2.5m chars");
  });
});
