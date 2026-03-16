import type { ProviderUsageSnapshot, ThinkingEffort, ToolCallReport, ToolProgressEvent } from "../types.js";
import { formatConversationIdForUi } from "./conversation-id.js";

const BASH_MAX_OUTPUT_CHARS = 3_000;
const TOOL_ERROR_MAX_CHARS = 200;

function truncateOutput(text: string, maxChars = BASH_MAX_OUTPUT_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatPath(value: unknown): string {
  const path = readString(value);
  return path ?? "(unknown)";
}

function formatError(value: string | null): string {
  if (!value) {
    return "unknown error";
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= TOOL_ERROR_MAX_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, TOOL_ERROR_MAX_CHARS - 3)}...`;
}

function formatFailure(base: string, error: string | null): string {
  return `${base} - ${formatError(error)}`;
}

const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1
});

export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }

  if (Math.abs(value) < 1_000) {
    return String(value);
  }

  return COMPACT_NUMBER_FORMAT.format(value).toLowerCase();
}

function formatRelativeTime(deltaMs: number): string {
  const seconds = Math.max(0, Math.floor(deltaMs / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatCacheSummary(usage: ProviderUsageSnapshot | null, nowMs?: number): string {
  if (!usage || usage.inputTokens === null || usage.cachedTokens === null || usage.inputTokens <= 0) {
    return "🗄️ Cache: n/a";
  }

  const cachedTokens = Math.min(usage.cachedTokens, usage.inputTokens);
  const newTokens = Math.max(usage.inputTokens - cachedTokens, 0);
  const cacheHitPercent = Math.round((cachedTokens / usage.inputTokens) * 100);
  let line = `🗄️ Cache: ${cacheHitPercent}% hit · ${formatCompactNumber(cachedTokens)} cached, ${formatCompactNumber(newTokens)} new`;

  const lastHitAt = usage.lastCacheHitAt;
  if (lastHitAt != null && lastHitAt > 0) {
    const now = nowMs ?? Date.now();
    line += ` · last ${formatRelativeTime(now - lastHitAt)}`;
  }

  return line;
}

function formatContextRatio(tokens: number | null, contextWindow: number | null): string {
  if (tokens === null) {
    return "n/a";
  }

  if (contextWindow === null) {
    return `${formatCompactNumber(tokens)}/unknown (n/a)`;
  }

  const percent = Math.round((tokens / contextWindow) * 100);
  return `${formatCompactNumber(tokens)}/${formatCompactNumber(contextWindow)} (${percent}%)`;
}

function resolveBudgetContextTokens(
  usage: ProviderUsageSnapshot,
  modelMaxOutputTokens: number | null
): number | null {
  const peakInputTokens = usage.peakInputTokens ?? usage.inputTokens;
  if (peakInputTokens === null || modelMaxOutputTokens === null) {
    return null;
  }
  return peakInputTokens;
}

function resolveBudgetContextWindow(
  contextWindow: number | null,
  modelMaxOutputTokens: number | null
): number | null {
  if (contextWindow === null || modelMaxOutputTokens === null) {
    return null;
  }

  const availableContextWindow = contextWindow - modelMaxOutputTokens;
  if (availableContextWindow <= 0) {
    return null;
  }

  return availableContextWindow;
}

function formatContextSummary(
  contextWindow: number | null,
  modelMaxOutputTokens: number | null,
  usage: ProviderUsageSnapshot | null,
  compactionTokens: number | null,
  compactionThreshold: number,
  compactionCount: number
): string {
  if (!usage) {
    return "📚 Context budget: n/a";
  }

  const invalidBudgetWindow =
    contextWindow !== null && modelMaxOutputTokens !== null && modelMaxOutputTokens >= contextWindow;
  const budgetTokens = invalidBudgetWindow ? null : resolveBudgetContextTokens(usage, modelMaxOutputTokens);
  const budgetContextWindow = invalidBudgetWindow
    ? null
    : resolveBudgetContextWindow(contextWindow, modelMaxOutputTokens);
  if (budgetTokens === null) {
    return "📚 Context budget: n/a";
  }

  let line = `📚 Context budget: ${formatContextRatio(budgetTokens, budgetContextWindow)}`;

  if (compactionTokens !== null) {
    const compactThreshold = Math.floor(compactionTokens * compactionThreshold);
    line += ` · compact: ${formatCompactNumber(compactThreshold)}`;
    if (compactionCount > 0) {
      line += ` (${compactionCount} ${compactionCount === 1 ? "hit" : "hits"})`;
    }
  }

  return line;
}

function formatTokenSummary(usage: ProviderUsageSnapshot | null): string {
  if (!usage || usage.inputTokens === null || usage.outputTokens === null) {
    return "🧮 Tokens: n/a";
  }

  const line = `🧮 Tokens: ${formatCompactNumber(usage.inputTokens)} in / ${formatCompactNumber(usage.outputTokens)} out`;
  if (usage.reasoningTokens === null || usage.reasoningTokens === undefined) {
    return line;
  }

  return `${line} · ${formatCompactNumber(usage.reasoningTokens)} reasoning`;
}

export function formatVerboseToolCallNotice(report: ToolCallReport): string {
  const args = asRecord(report.args);
  const result = asRecord(report.result);

  if (!report.success) {
    if (report.tool === "read_file") {
      return formatFailure(`⚠️ Read failed: \`${formatPath(args.path)}\``, report.error);
    }

    if (report.tool === "write_file") {
      return formatFailure(`⚠️ Write failed: \`${formatPath(args.path)}\``, report.error);
    }

    if (report.tool === "bash") {
      const command = readString(args.command) ?? "(unknown command)";
      return formatFailure(`⚠️ Bash failed: ${command}`, report.error);
    }

    return formatFailure(`⚠️ ${report.tool} failed`, report.error);
  }

  if (report.tool === "read_file") {
    const sourcePath = formatPath(result.path ?? args.path);
    const content = typeof result.content === "string" ? result.content : null;
    const size = content === null ? "" : ` (${content.length} chars)`;
    return `📖 Read: from \`${sourcePath}\`${size}`;
  }

  if (report.tool === "write_file") {
    const targetPath = formatPath(result.path ?? args.path);
    const content = typeof args.content === "string" ? args.content : null;
    const sizeFromArgs = content === null ? null : content.length;
    const sizeFromResult = typeof result.size === "number" ? result.size : null;
    const charCount = sizeFromArgs ?? sizeFromResult;
    const size = typeof charCount === "number" ? ` (${charCount} chars)` : "";
    return `✍️ Write: to \`${targetPath}\`${size}`;
  }

  if (report.tool === "bash") {
    const command = readString(args.command) ?? "(unknown command)";
    return `>_ Bash: ${command}`;
  }

  if (report.tool === "replace_in_file") {
    return `🔁 Replace: in \`${formatPath(args.path)}\``;
  }

  if (report.tool === "apply_patch") {
    return `🩹 Patch: cwd \`${formatPath(args.cwd)}\``;
  }

  if (report.tool === "process") {
    const action = readString(args.action) ?? "unknown";
    return `>_ Process: ${action}`;
  }

  if (report.tool === "web_fetch") {
    const url = readString(args.url) ?? "(unknown url)";
    return `🌐 Web fetch: ${url}`;
  }

  if (report.tool === "web_search") {
    const query = readString(args.query);
    const queryDisplay = query ? `"${query}"` : "(multi-query)";
    const model = readString(result.model) ?? "unknown";
    return `🔎 Web search: ${queryDisplay} · ${model}`;
  }

  return `🔧 Tool: ${report.tool}`;
}

export function formatToolProgressNotice(event: ToolProgressEvent): string {
  const elapsedSeconds = Math.max(0, Math.floor(event.elapsedMs / 1000));
  const prefix = `⏳ [${elapsedSeconds}s]`;

  if (event.type === "poll" && event.attempt && event.maxAttempts) {
    return `${prefix} ${event.message} (${event.attempt}/${event.maxAttempts})`;
  }

  if (event.type === "state" && event.state) {
    return `${prefix} ${event.state}: ${event.message}`;
  }

  return `${prefix} ${event.message}`;
}

export function formatBashReply(output: unknown): string {
  const record = output as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : "unknown";
  const truncatedCombinedChars =
    typeof record.truncatedCombinedChars === "number" ? record.truncatedCombinedChars : 0;

  if (status === "running") {
    const sessionId = String(record.sessionId ?? "unknown");
    const tail = typeof record.tail === "string" ? truncateOutput(record.tail) : "";
    const lines = ["bash started", `session: ${sessionId}`, tail.length > 0 ? `tail:\n${tail}` : "tail: (empty)"];
    if (truncatedCombinedChars > 0) {
      lines.push(`buffer_truncated_chars: ${truncatedCombinedChars}`);
    }
    return lines.join("\n").trim();
  }

  const exitCode = record.exitCode;
  const combined = typeof record.combined === "string" ? record.combined : "";
  const lines = [
    `bash completed (exit=${String(exitCode)})`,
    combined.length > 0 ? `output:\n${truncateOutput(combined)}` : "output: (empty)"
  ];
  if (truncatedCombinedChars > 0) {
    lines.push(`buffer_truncated_chars: ${truncatedCombinedChars}`);
  }

  return lines.join("\n").trim();
}

function toToolDisplayName(toolName: string): string {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "bash") {
    return "Bash";
  }
  if (normalized === "write_file") {
    return "Write";
  }
  if (normalized === "read_file") {
    return "Read";
  }
  if (normalized === "replace_in_file") {
    return "Replace";
  }
  if (normalized === "apply_patch") {
    return "Patch";
  }
  if (normalized === "process") {
    return "Process";
  }

  return normalized
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function formatToolResultsByName(byTool: Record<string, number>): string {
  const byDisplayName = new Map<string, number>();

  for (const [toolName, count] of Object.entries(byTool)) {
    if (!Number.isFinite(count) || count <= 0) {
      continue;
    }
    const displayName = toToolDisplayName(toolName);
    byDisplayName.set(displayName, (byDisplayName.get(displayName) ?? 0) + count);
  }

  const entries = Array.from(byDisplayName.entries()).sort((left, right) => {
    if (left[1] !== right[1]) {
      return right[1] - left[1];
    }
    return left[0].localeCompare(right[0]);
  });

  if (entries.length === 0) {
    return "none";
  }

  return entries.map(([name, count]) => `${name}=${count}`).join(", ");
}

function formatSessionIdForUi(sessionId: string): string {
  const normalized = sessionId.trim();
  if (normalized.length === 0) {
    return "(unknown)";
  }

  const prefix = normalized.split("_")[0] ?? "";
  const head = prefix.length > 0 ? prefix : normalized.slice(0, 4);
  const tail = normalized.slice(-4);

  if (normalized.length <= head.length + tail.length + 3) {
    return normalized;
  }

  return `${head}...${tail}`;
}

export function buildStatusReply(params: {
  conversationId: string;
  model: string;
  webSearchModel?: string | null;
  modelContextWindow: number | null;
  modelMaxOutputTokens: number | null;
  workspaceRoot: string;
  skillsCount: number;
  fullObservabilityEnabled: boolean;
  verboseEnabled: boolean;
  thinkingEffort: ThinkingEffort;
  latestUsage: ProviderUsageSnapshot | null;
  sessions: Array<{ sessionId: string; command: string }>;
  completedProcessCount: number;
  stateHealth: {
    cachedSessions: number;
    maxCachedSessions: number;
    queuedAppends: number;
    evictedSessions: number;
  };
  workspaceHealth: {
    refreshCalls: number;
    refreshNoChange: number;
  };
  processHealth: {
    truncatedCombinedChars: number;
    truncatedStdoutChars: number;
    truncatedStderrChars: number;
  };
  toolRuntime: {
    toolSuccessCount: number;
    toolFailureCount: number;
    errorCodeCounts: Record<string, number>;
    workflowsStarted: number;
    workflowsSucceeded: number;
    workflowsFailed: number;
    workflowsTimedOut: number;
    workflowsInterrupted: number;
    workflowsCleanupErrors: number;
    workflowLoopBreakerTrips: number;
  };
  toolResultStats: {
    total: number;
    success: number;
    fail: number;
    byTool: Record<string, number>;
  };
  compactionTokens: number | null;
  compactionThreshold: number;
  compactionCount: number;
  includeDiagnostics?: boolean;
  nowMs?: number;
}): string {
  const includeDiagnostics = params.includeDiagnostics ?? false;
  const runtimeDetails = [
    `think: ${params.thinkingEffort}`,
    `verbose: ${params.verboseEnabled ? "on" : "off"}`,
    `observability: ${params.fullObservabilityEnabled ? "on" : "off"}`
  ];
  const summaryLines = [
    `🧠 openai/${params.model}`,
    ...(params.webSearchModel ? [`🔎 perplexity/${params.webSearchModel}`] : []),
    formatContextSummary(params.modelContextWindow, params.modelMaxOutputTokens, params.latestUsage, params.compactionTokens, params.compactionThreshold, params.compactionCount),
    formatTokenSummary(params.latestUsage),
    formatCacheSummary(params.latestUsage, params.nowMs),
    `⚙️ Runtime: ${runtimeDetails.join(" · ")}`,
    `🏃 Processes: ${params.sessions.length} running`
  ];

  if (!includeDiagnostics) {
    return summaryLines.join("\n");
  }

  const errorCounts = Object.entries(params.toolRuntime.errorCodeCounts).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const toolErrorCodesLine =
    errorCounts.length === 0
      ? "tool.error_codes: none"
      : `tool.error_codes: ${errorCounts.map(([code, count]) => `${code}=${count}`).join(", ")}`;

  const lines = [
    ...summaryLines,
    "",
    `conversation: ${formatConversationIdForUi(params.conversationId)}`,
    `skills: ${params.skillsCount}`,
    `tool.success_count: ${params.toolRuntime.toolSuccessCount}`,
    `tool.failure_count: ${params.toolRuntime.toolFailureCount}`,
    toolErrorCodesLine,
    `tool.results_total: ${params.toolResultStats.total}`,
    `tool.results_success: ${params.toolResultStats.success}`,
    `tool.results_fail: ${params.toolResultStats.fail}`,
    `tool.results_by_name: ${formatToolResultsByName(params.toolResultStats.byTool)}`,
    `workflow.started: ${params.toolRuntime.workflowsStarted}`,
    `workflow.succeeded: ${params.toolRuntime.workflowsSucceeded}`,
    `workflow.failed: ${params.toolRuntime.workflowsFailed}`,
    `workflow.timed_out: ${params.toolRuntime.workflowsTimedOut}`,
    `workflow.interrupted: ${params.toolRuntime.workflowsInterrupted}`,
    `workflow.cleanup_errors: ${params.toolRuntime.workflowsCleanupErrors}`,
    `workflow.loop_breakers: ${params.toolRuntime.workflowLoopBreakerTrips}`
  ];

  lines.push(`completed processes: ${params.completedProcessCount}`);
  if (params.sessions.length === 0) {
    lines.push("running processes: 0");
  } else {
    lines.push(`running processes: ${params.sessions.length}`);
    for (const session of params.sessions) {
      lines.push(`- ${formatSessionIdForUi(session.sessionId)} ${session.command}`);
    }
  }

  lines.push(`state.cache: ${params.stateHealth.cachedSessions}/${params.stateHealth.maxCachedSessions}`);
  lines.push(`state.queued_appends: ${params.stateHealth.queuedAppends}`);
  lines.push(`state.cache_evictions: ${params.stateHealth.evictedSessions}`);
  lines.push(`workspace.refresh: ${params.workspaceHealth.refreshCalls}`);
  lines.push(`workspace.refresh_no_change: ${params.workspaceHealth.refreshNoChange}`);
  lines.push(`process.truncated_combined_chars: ${params.processHealth.truncatedCombinedChars}`);
  lines.push(`process.truncated_stdout_chars: ${params.processHealth.truncatedStdoutChars}`);
  lines.push(`process.truncated_stderr_chars: ${params.processHealth.truncatedStderrChars}`);

  return lines.join("\n");
}
