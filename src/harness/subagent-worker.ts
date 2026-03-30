// ──────────────────────────────────────────────────────────────────────────────
// SubagentWorker — drives LLM inference + tool execution for subagent tasks.
// ──────────────────────────────────────────────────────────────────────────────

import { runOpenAIToolLoop, ToolWorkflowAbortError } from "../agent/tool-loop.js";
import { extractAssistantText } from "../provider/response-text.js";
import type { ProviderTransportDeps } from "../provider/responses-transport.js";
import type { AuthModeRegistry } from "../provider/auth-mode-contracts.js";
import { createRequestExecutor, type OpenAIRequestExecutor } from "../provider/request-executor.js";
import { createResponsesRequestWithRetry } from "../provider/responses-transport.js";
import { createWsTransportManager, type WsTransportManager } from "../provider/ws-transport.js";
import type { AuthMode, TransportMode } from "../types.js";
import { createSteerChannel, type SteerChannel } from "../steer-channel.js";
import { resolveModelReference } from "../model-catalog.js";
import { createTraceRootContext, type ObservabilitySink, type TraceContext } from "../observability.js";
import type { SubagentLogSink } from "../subagent-log.js";
import { ProviderError } from "../provider-error.js";
import type { Config, RuntimeLogger, OpenAIModelCatalogEntry } from "../runtime/contracts.js";
import type { ToolHarness } from "./index.js";
import type { SubagentManager } from "./subagent-manager.js";
import type {
  SubagentWorker,
  SubagentTask,
  SupervisorMessage,
  TaskResult,
  Attachment
} from "./subagent-types.js";
import type { ProviderFunctionTool, ToolContext } from "./types.js";
import type { OpenAIInputMessage, OpenAIFunctionCallOutput, OpenAIResponsesOutputItem } from "../provider/openai-types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type OwnerProviderSettings = {
  authMode: AuthMode;
  transportMode: TransportMode;
};

export type SubagentWorkerDeps = {
  config: Config;
  harness: ToolHarness;
  manager: SubagentManager;
  logger: RuntimeLogger;
  observability?: ObservabilitySink;
  subagentLog?: SubagentLogSink;
  transportDeps?: ProviderTransportDeps;
  authModeRegistry: AuthModeRegistry;
  resolveOwnerProviderSettings: (ownerId: string) => Promise<OwnerProviderSettings>;
};

type TaskRuntime = {
  abortController: AbortController;
  steerChannel: SteerChannel;
  loopPromise: Promise<void>;
  pausedResponseId: string | null;
  pausedAccumulatedInput: Array<OpenAIInputMessage | OpenAIFunctionCallOutput | OpenAIResponsesOutputItem> | null;
  // Preserved across pause/resume
  task: SubagentTask;
  model: OpenAIModelCatalogEntry;
  scopedHarness: ToolHarness;
  trace: TraceContext;
  /** Supervisor's auth/transport snapshot, stable for the task lifetime. */
  providerSettings: OwnerProviderSettings;
};

// ── Completion protocol markers ──────────────────────────────────────────────

const NEEDS_INPUT_MARKER = "[NEEDS_INPUT]";
const TASK_COMPLETE_MARKER = "[TASK_COMPLETE]";

type ReplyClassification = "complete" | "needs_input";

export function classifyReply(reply: string): ReplyClassification {
  const trimmed = reply.trimEnd();
  if (trimmed.endsWith(NEEDS_INPUT_MARKER)) return "needs_input";
  return "complete";
}

function stripMarker(reply: string): string {
  const trimmed = reply.trimEnd();
  if (trimmed.endsWith(NEEDS_INPUT_MARKER)) {
    return trimmed.slice(0, -NEEDS_INPUT_MARKER.length).trimEnd();
  }
  if (trimmed.endsWith(TASK_COMPLETE_MARKER)) {
    return trimmed.slice(0, -TASK_COMPLETE_MARKER.length).trimEnd();
  }
  return reply;
}

function hasProtocolMarker(reply: string): boolean {
  const trimmed = reply.trimEnd();
  return trimmed.endsWith(NEEDS_INPUT_MARKER) || trimmed.endsWith(TASK_COMPLETE_MARKER);
}

type StructuredTaskResultPayload = {
  summary?: unknown;
  outcome?: unknown;
  confirmed?: unknown;
  inferred?: unknown;
  unverified?: unknown;
  deliverables?: unknown;
  open_issues?: unknown;
  recommended_next_steps?: unknown;
  decision_journal?: unknown;
};

type ParsedTaskResult = {
  summary: string;
  result: TaskResult;
};

type ParsedSectionedResult = {
  leadSummary: string;
  summary: string;
  outcome: string | null;
  confirmed: string[];
  inferred: string[];
  unverified: string[];
  deliverables: Attachment[];
  openIssues: string[];
  recommendedNextSteps: string[];
  decisionJournalPath: string | null;
};

const TASK_RESULT_TAG = "TASK_RESULT";
const SECTION_LABELS = new Map<string, keyof ParsedSectionedResult>([
  ["summary", "summary"],
  ["outcome", "outcome"],
  ["confirmed", "confirmed"],
  ["inferred", "inferred"],
  ["unverified", "unverified"],
  ["deliverables", "deliverables"],
  ["open issues", "openIssues"],
  ["recommended next steps", "recommendedNextSteps"],
  ["next steps", "recommendedNextSteps"],
  ["decision journal", "decisionJournalPath"]
]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function inferAttachmentType(ref: string): string {
  if (/^https?:\/\//i.test(ref)) {
    return "url";
  }
  if (/[/.]/.test(ref)) {
    return "file";
  }
  return "note";
}

function normalizeAttachment(value: unknown): Attachment | null {
  if (typeof value === "string") {
    const ref = value.trim();
    if (ref.length === 0) return null;
    return { type: inferAttachmentType(ref), ref };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const ref = typeof record.ref === "string" ? record.ref.trim() : "";
  if (ref.length === 0) {
    return null;
  }

  const type = typeof record.type === "string" && record.type.trim().length > 0
    ? record.type.trim()
    : inferAttachmentType(ref);
  const label = typeof record.label === "string" && record.label.trim().length > 0
    ? record.label.trim()
    : undefined;

  return {
    type,
    ref,
    ...(label ? { label } : {})
  };
}

function normalizeAttachmentList(value: unknown): Attachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const attachments: Attachment[] = [];
  for (const item of value) {
    const attachment = normalizeAttachment(item);
    if (attachment) {
      attachments.push(attachment);
    }
  }

  return attachments;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupeStrings(
    value.filter((item): item is string => typeof item === "string")
  );
}

function extractTaggedBlock(reply: string, tagName: string): { content: string | null; stripped: string } {
  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "i");
  const match = pattern.exec(reply);
  if (!match) {
    return {
      content: null,
      stripped: reply.trim()
    };
  }

  return {
    content: match[1].trim(),
    stripped: reply.replace(match[0], "").trim()
  };
}

function normalizeSectionHeading(line: string): keyof ParsedSectionedResult | null {
  const match = /^(?:#{1,6}\s*)?([A-Za-z][A-Za-z ]*[A-Za-z])\s*:?\s*$/.exec(line.trim());
  if (!match) {
    return null;
  }

  return SECTION_LABELS.get(match[1].trim().toLowerCase()) ?? null;
}

function appendSectionValue(
  target: ParsedSectionedResult,
  section: keyof ParsedSectionedResult,
  rawLine: string
): void {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0) {
    return;
  }

  const bulletMatch = /^(?:[-*+]\s+|\d+\.\s+)(.+)$/.exec(trimmed);
  const value = (bulletMatch ? bulletMatch[1] : trimmed).trim();
  if (value.length === 0) {
    return;
  }

  switch (section) {
    case "summary":
    case "leadSummary":
      target.summary = target.summary.length > 0 ? `${target.summary}\n${value}` : value;
      break;
    case "outcome":
      target.outcome = value;
      break;
    case "decisionJournalPath":
      target.decisionJournalPath = value;
      break;
    case "deliverables": {
      const attachment = normalizeAttachment(value);
      if (attachment) {
        target.deliverables.push(attachment);
      }
      break;
    }
    case "confirmed":
    case "inferred":
    case "unverified":
    case "openIssues":
    case "recommendedNextSteps":
      target[section].push(value);
      break;
  }
}

function parseSectionedResult(reply: string): ParsedSectionedResult {
  const parsed: ParsedSectionedResult = {
    leadSummary: "",
    summary: "",
    outcome: null,
    confirmed: [],
    inferred: [],
    unverified: [],
    deliverables: [],
    openIssues: [],
    recommendedNextSteps: [],
    decisionJournalPath: null
  };

  let activeSection: keyof ParsedSectionedResult | null = null;
  let sawHeading = false;

  for (const line of reply.split(/\r?\n/)) {
    const section = normalizeSectionHeading(line);
    if (section) {
      activeSection = section;
      sawHeading = true;
      continue;
    }

    if (!sawHeading) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        if (parsed.leadSummary.length > 0 && !parsed.leadSummary.endsWith("\n\n")) {
          parsed.leadSummary += "\n\n";
        }
        continue;
      }
      parsed.leadSummary += parsed.leadSummary.length > 0 && !parsed.leadSummary.endsWith("\n\n")
        ? ` ${trimmed}`
        : trimmed;
      continue;
    }

    if (activeSection) {
      appendSectionValue(parsed, activeSection, line);
    }
  }

  parsed.leadSummary = parsed.leadSummary.trim();
  parsed.summary = parsed.summary.trim();
  parsed.confirmed = dedupeStrings(parsed.confirmed);
  parsed.inferred = dedupeStrings(parsed.inferred);
  parsed.unverified = dedupeStrings(parsed.unverified);
  parsed.openIssues = dedupeStrings(parsed.openIssues);
  parsed.recommendedNextSteps = dedupeStrings(parsed.recommendedNextSteps);

  return parsed;
}

function normalizeOutcome(value: unknown): TaskResult["outcome"] | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "success" || normalized === "partial" || normalized === "inconclusive") {
    return normalized;
  }
  return null;
}

function inferOutcome(
  explicitOutcome: TaskResult["outcome"] | null,
  confirmed: string[],
  inferred: string[],
  unverified: string[],
  openIssues: string[],
  summary: string,
  requireStructuredResult: boolean
): TaskResult["outcome"] {
  if (explicitOutcome) {
    return explicitOutcome;
  }
  if (confirmed.length > 0 && unverified.length === 0 && openIssues.length === 0) {
    return "success";
  }
  if (!requireStructuredResult && summary.trim().length > 0 && openIssues.length === 0) {
    return "success";
  }
  if (confirmed.length > 0 || inferred.length > 0) {
    return "partial";
  }
  return "inconclusive";
}

function inferConfidence(
  outcome: TaskResult["outcome"],
  confirmed: string[],
  unverified: string[],
  hasStructuredPayload: boolean
): number {
  let confidence = outcome === "success"
    ? 0.85
    : outcome === "partial"
      ? 0.65
      : 0.35;

  if (confirmed.length === 0) {
    confidence -= 0.15;
  }
  confidence -= Math.min(0.25, unverified.length * 0.05);
  if (!hasStructuredPayload) {
    confidence -= 0.1;
  }

  return Math.round(clamp(confidence, 0.1, 0.95) * 100) / 100;
}

function buildFallbackSummary(reply: string): string {
  const firstLine = reply
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? "Subagent completed without a usable final summary.";
}

function parseTaskResult(reply: string, task: SubagentTask): ParsedTaskResult {
  const strippedReply = stripMarker(reply).trim();
  const tagged = extractTaggedBlock(strippedReply, TASK_RESULT_TAG);
  const sectioned = parseSectionedResult(tagged.stripped);

  let structuredPayload: StructuredTaskResultPayload | null = null;
  let structuredPayloadValid = false;
  if (tagged.content) {
    try {
      structuredPayload = JSON.parse(tagged.content) as StructuredTaskResultPayload;
      structuredPayloadValid = true;
    } catch {
      structuredPayload = null;
      structuredPayloadValid = false;
    }
  }

  const confirmed = dedupeStrings([
    ...normalizeStringList(structuredPayload?.confirmed),
    ...sectioned.confirmed
  ]);
  const inferred = dedupeStrings([
    ...normalizeStringList(structuredPayload?.inferred),
    ...sectioned.inferred
  ]);
  const unverified = dedupeStrings([
    ...normalizeStringList(structuredPayload?.unverified),
    ...sectioned.unverified
  ]);
  const deliverables = [
    ...normalizeAttachmentList(structuredPayload?.deliverables),
    ...sectioned.deliverables
  ];
  const openIssues = dedupeStrings([
    ...normalizeStringList(structuredPayload?.open_issues),
    ...sectioned.openIssues
  ]);
  const recommendedNextSteps = dedupeStrings([
    ...normalizeStringList(structuredPayload?.recommended_next_steps),
    ...sectioned.recommendedNextSteps
  ]);

  let decisionJournalPath =
    (typeof structuredPayload?.decision_journal === "string" && structuredPayload.decision_journal.trim().length > 0
      ? structuredPayload.decision_journal.trim()
      : null)
    ?? sectioned.decisionJournalPath;

  const summary =
    (typeof structuredPayload?.summary === "string" && structuredPayload.summary.trim().length > 0
      ? structuredPayload.summary.trim()
      : null)
    ?? (sectioned.summary.length > 0 ? sectioned.summary : null)
    ?? (sectioned.leadSummary.length > 0 ? sectioned.leadSummary : null)
    ?? buildFallbackSummary(tagged.stripped);

  if (task.completionContract.requireStructuredResult && !structuredPayloadValid) {
    unverified.push("Structured TASK_RESULT payload missing or invalid.");
  }
  if (task.completionContract.requireFinalSummary && summary.trim().length === 0) {
    unverified.push("Final summary missing.");
  }
  if (task.budgetUsage.turnsUsed >= 2 && !decisionJournalPath) {
    unverified.push("No decision journal path was reported for this multi-turn task.");
  }

  const normalizedOutcome = inferOutcome(
    normalizeOutcome(structuredPayload?.outcome ?? sectioned.outcome),
    confirmed,
    inferred,
    unverified,
    openIssues,
    summary,
    task.completionContract.requireStructuredResult
  );

  const dedupedUnverified = dedupeStrings(unverified);
  const dedupedOpenIssues = dedupeStrings([...openIssues, ...dedupedUnverified]);
  if (decisionJournalPath) {
    const noteAttachment = normalizeAttachment({
      type: "note",
      ref: decisionJournalPath,
      label: "decision_journal"
    });
    if (noteAttachment) {
      const alreadyPresent = deliverables.some(
        (attachment) => attachment.type === noteAttachment.type && attachment.ref === noteAttachment.ref
      );
      if (!alreadyPresent) {
        deliverables.push(noteAttachment);
      }
    }
  } else {
    decisionJournalPath = null;
  }

  return {
    summary,
    result: {
      summary,
      outcome: normalizedOutcome,
      confidence: inferConfidence(
        normalizedOutcome,
        confirmed,
        dedupedUnverified,
        structuredPayloadValid || !task.completionContract.requireStructuredResult
      ),
      confirmed,
      inferred,
      unverified: dedupedUnverified,
      deliverables,
      evidence: confirmed,
      openIssues: dedupedOpenIssues,
      recommendedNextSteps,
      decisionJournalPath
    }
  };
}

// ── Scoped harness ───────────────────────────────────────────────────────────

const EXCLUDED_TOOLS = new Set(["subagents"]);

function createScopedHarness(
  parent: ToolHarness,
  taskId: string,
  ownerId: string,
  cwdOverride?: string
): ToolHarness {
  const filteredTools: ProviderFunctionTool[] = parent
    .exportProviderTools()
    .filter((t) => !EXCLUDED_TOOLS.has(t.name));

  const guardedExecute = (
    name: string,
    args: unknown,
    trace?: Parameters<ToolHarness["execute"]>[2],
    signal?: AbortSignal
  ) => {
    if (EXCLUDED_TOOLS.has(name)) {
      return Promise.reject(
        new Error(`Tool '${name}' is not available to subagents`)
      );
    }
    // Execute directly through registry with a pinned CWD context.
    // We must NOT use parent.executeWithOwner(taskId, ...) because that
    // re-resolves CWD via resolveDefaultCwd(taskId), which would pollute
    // the conversation store with a fake entry keyed by the satask_* id.
    const scopedCtx: ToolContext = {
      ...parent.context,
      config: {
        ...parent.context.config,
        defaultCwd: cwdOverride ?? parent.context.config.defaultCwd
      },
      ownerId: taskId,
      trace,
      abortSignal: signal,
      subagentSession: {
        taskId,
        ownerId
      }
    };
    return parent.registry.execute(name, args, scopedCtx);
  };

  return {
    config: cwdOverride
      ? { ...parent.config, defaultCwd: cwdOverride }
      : parent.config,
    context: {
      ...parent.context,
      subagentManager: undefined,
      ownerId: taskId,
      subagentSession: {
        taskId,
        ownerId
      }
    },
    registry: parent.registry,
    metrics: parent.metrics,
    execute: guardedExecute,
    executeWithOwner: (_ownerId, name, args, trace, signal) =>
      guardedExecute(name, args, trace, signal),
    exportProviderTools: () => filteredTools,
    shutdown: async () => {}
  };
}

// ── System prompt construction ───────────────────────────────────────────────

function buildSystemInstructions(task: SubagentTask): string {
  const parts: string[] = [];
  const decisionJournalPath = `notes/${task.taskId}.md`;

  parts.push("You are a subagent working on a specific task assigned by a supervisor.");
  parts.push("");

  parts.push("## Goal");
  parts.push(task.goal);
  parts.push("");

  if (task.instructions) {
    parts.push("## Instructions");
    parts.push(task.instructions);
    parts.push("");
  }

  const contextEntries = Object.entries(task.context);
  if (contextEntries.length > 0) {
    parts.push("## Context");
    for (const [key, value] of contextEntries) {
      parts.push(`- **${key}**: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
    parts.push("");
  }

  parts.push("## Constraints");
  parts.push(`- Maximum turns: ${task.constraints.maxTurns}`);
  parts.push(`- Time budget: ${task.constraints.timeBudgetSec}s`);
  parts.push(`- Token budget: ${task.constraints.maxTotalTokens} tokens`);
  parts.push("");

  parts.push("## Reporting Contract");
  parts.push("");
  parts.push("Every substantive technical report must separate:");
  parts.push("- Confirmed: direct evidence from a read, check, test, or tool result");
  parts.push("- Inferred: reasoned conclusions that are plausible but not directly proved");
  parts.push("- Unverified: what remains unchecked, blocked, or unknown");
  parts.push("");
  parts.push("Use 'verified' only for direct evidence.");
  parts.push("Use 'appears' for indirect evidence.");
  parts.push("Use 'likely' for inference.");
  parts.push("");
  parts.push("If tool output, assumptions, or prior verified state contradict each other:");
  parts.push("- Stop");
  parts.push("- State the contradiction explicitly");
  parts.push("- Ask for guidance with [NEEDS_INPUT]");
  parts.push("");
  parts.push("Once the requested outcome is achieved and reported, stop.");
  parts.push("Do not continue optimizing, cleaning, or investigating unless asked.");
  parts.push("");
  parts.push("If the task spans multiple turns, multiple files, or important decisions:");
  parts.push(`- Keep a concise decision journal at ${decisionJournalPath}`);
  parts.push("- Record key decisions, surprises, and recovery notes");
  parts.push("- Mention the journal path in your final report");
  parts.push("");

  parts.push("## Completion Protocol");
  parts.push("");
  parts.push("Your final report must include Confirmed, Inferred, and Unverified sections.");
  if (task.completionContract.requireStructuredResult) {
    parts.push("");
    parts.push("Before [TASK_COMPLETE], include a machine-readable payload in this exact form:");
    parts.push(`<${TASK_RESULT_TAG}>`);
    parts.push("{");
    parts.push('  "summary": "one concise paragraph",');
    parts.push('  "outcome": "success | partial | inconclusive",');
    parts.push('  "confirmed": ["directly verified facts"],');
    parts.push('  "inferred": ["reasoned but not directly proven conclusions"],');
    parts.push('  "unverified": ["remaining unknowns or unchecked items"],');
    parts.push('  "deliverables": [{"type": "file|url|note", "ref": "path-or-url", "label": "optional"}],');
    parts.push('  "open_issues": ["known gaps or risks"],');
    parts.push('  "recommended_next_steps": ["next actions if any"],');
    parts.push(`  "decision_journal": "${decisionJournalPath} or null"`);
    parts.push("}");
    parts.push(`</${TASK_RESULT_TAG}>`);
  }
  parts.push("");
  parts.push("When you finish the task, end your final message with exactly:");
  parts.push("[TASK_COMPLETE]");
  parts.push("");
  parts.push("When you need supervisor guidance before continuing (blocked, need a decision,");
  parts.push("need information you don't have), end your message with exactly:");
  parts.push("[NEEDS_INPUT]");
  parts.push("");
  parts.push("You MUST end every non-tool-call response with one of these markers.");
  parts.push("");
  parts.push("## Asking for Help");
  parts.push("");
  parts.push("If you encounter a blocker, need a decision, or require information you don't have:");
  parts.push("- Clearly state what you need and why you're blocked");
  parts.push("- End your message with [NEEDS_INPUT]");
  parts.push("- The supervisor will respond with guidance, and you will continue from there");

  return parts.join("\n");
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createSubagentWorker(deps: SubagentWorkerDeps): SubagentWorker {
  const {
    config,
    harness,
    manager,
    logger,
    observability,
    subagentLog,
    transportDeps,
    authModeRegistry,
    resolveOwnerProviderSettings
  } = deps;
  const activeTasks = new Map<string, TaskRuntime>();

  const httpTransport = createResponsesRequestWithRetry(config, logger, {
    fetchImpl: transportDeps?.fetchImpl,
    sleepImpl: transportDeps?.sleepImpl,
    randomImpl: transportDeps?.randomImpl,
    nowMsImpl: transportDeps?.nowMsImpl,
    observability
  });

  let wsManager: WsTransportManager | null = null;
  const getWsManager = (): WsTransportManager => {
    wsManager ??= createWsTransportManager(config, logger, {
      sleepImpl: transportDeps?.sleepImpl,
      randomImpl: transportDeps?.randomImpl,
      nowMsImpl: transportDeps?.nowMsImpl,
      observability
    });
    return wsManager;
  };

  const requestExecutor: OpenAIRequestExecutor = createRequestExecutor(authModeRegistry, {
    http: httpTransport,
    getWsManager
  });

  function resolveModel(modelRef: string): OpenAIModelCatalogEntry {
    const resolved = resolveModelReference(config.openai.models, modelRef);
    if (resolved) return resolved;
    const fallback = resolveModelReference(config.openai.models, config.openai.model);
    if (fallback) return fallback;
    if (config.openai.models.length > 0) return config.openai.models[0];
    return {
      id: modelRef,
      aliases: [],
      contextWindow: null,
      maxOutputTokens: null,
      defaultThinking: "low",
      cacheRetention: "in_memory",
      compactionTokens: null,
      compactionThreshold: 0.8
    };
  }

  function buildToolLoopLimits(task: SubagentTask) {
    return {
      workflowTimeoutMs: task.constraints.timeBudgetSec * 1000,
      commandTimeoutMs: config.runtime.toolCommandTimeoutMs,
      pollIntervalMs: config.runtime.toolPollIntervalMs,
      pollMaxAttempts: config.runtime.toolPollMaxAttempts,
      idleOutputThresholdMs: config.runtime.toolIdleOutputThresholdMs,
      heartbeatIntervalMs: config.runtime.toolHeartbeatIntervalMs,
      cleanupGraceMs: config.runtime.toolCleanupGraceMs,
      failureBreakerThreshold: config.runtime.toolFailureBreakerThreshold
    };
  }

  function buildRequestFn(runtime: TaskRuntime) {
    return async (body: Record<string, unknown>) => {
      if (runtime.abortController.signal.aborted) {
        throw new Error("Subagent task was cancelled");
      }
      const result = await requestExecutor.execute(body, {
        chatId: runtime.task.taskId,
        trace: runtime.trace,
        abortSignal: runtime.abortController.signal,
        authMode: runtime.providerSettings.authMode,
        transportMode: runtime.providerSettings.transportMode
      });
      return result.payload;
    };
  }

  function buildCallbacks(taskId: string) {
    return {
      onToolCall: (event: { tool: string; success: boolean; error: string | null }) => {
        try {
          manager.pushWorkerEvent(taskId, "progress", {
            message: `Tool ${event.tool}: ${event.success ? "ok" : event.error ?? "failed"}`
          });
        } catch {
          // Task may have been cancelled/failed externally
        }
      },
      onResponse: (response: unknown) => {
        try {
          manager.recordTurnUsed(taskId);
          const usage = (response as Record<string, unknown>).usage as
            | { input_tokens?: number; output_tokens?: number }
            | undefined;
          if (usage) {
            const total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
            if (total > 0) {
              manager.recordTokensUsed(taskId, total);
            }
          }
        } catch {
          // Task may have been cancelled/failed externally
        }
      }
    };
  }

  function recordExchange(entry: {
    ownerId: string;
    taskId: string;
    content: string;
    replyClassification: ReplyClassification;
    trace: TraceContext;
  }): void {
    if (!subagentLog?.enabled) {
      return;
    }

    void subagentLog.record({
      entry_type: "exchange",
      timestamp: new Date().toISOString(),
      owner_id: entry.ownerId,
      task_id: entry.taskId,
      direction: "subagent_to_supervisor",
      role: "subagent",
      content: entry.content,
      reply_classification: entry.replyClassification,
      trace: entry.trace
    }).catch(() => {});
  }

  /** Handle a tool loop result — classify and push appropriate event. Returns true if paused. */
  function handleReply(
    taskId: string,
    reply: string,
    responseId: string | undefined,
    runtime: TaskRuntime,
    accumulatedInput?: Array<OpenAIInputMessage | OpenAIFunctionCallOutput | OpenAIResponsesOutputItem>
  ): boolean {
    const classification = classifyReply(reply);
    const cleanReply = stripMarker(reply);
    if (hasProtocolMarker(reply)) {
      recordExchange({
        ownerId: runtime.task.ownerId,
        taskId,
        content: cleanReply,
        replyClassification: classification,
        trace: runtime.trace
      });
    }

    if (classification === "needs_input") {
      // Push question event → manager transitions to needs_steer
      try {
        manager.pushWorkerEvent(taskId, "question", {
          message: cleanReply,
          requiresResponse: true
        });
      } catch {
        // Task may already be terminal
        return false;
      }
      // Store response ID and accumulated input for resume — do NOT remove from activeTasks
      runtime.pausedResponseId = responseId ?? null;
      runtime.pausedAccumulatedInput = accumulatedInput ?? null;
      return true; // paused
    }

    // Complete
    const parsed = parseTaskResult(cleanReply, runtime.task);
    try {
      manager.pushWorkerEvent(taskId, "result", {
        message: parsed.summary,
        result: parsed.result
      });
    } catch {
      // Task may already be in a terminal state
    }
    return false; // not paused
  }

  function handleError(taskId: string, error: unknown, abortController: AbortController): void {
    if (abortController.signal.aborted) return;

    const message = error instanceof Error ? error.message : String(error);

    try {
      if (error instanceof ToolWorkflowAbortError) {
        const code = error.payload.errorCode;
        if (code === "WORKFLOW_TIMEOUT") {
          manager.pushWorkerEvent(taskId, "timeout", {
            message: `Time budget exceeded: ${message}`,
            error: { code: "TIME_BUDGET_EXCEEDED", retryable: false }
          });
        } else {
          manager.pushWorkerEvent(taskId, "error", {
            message,
            error: { code: "WORKER_CRASH", retryable: true }
          });
        }
      } else if (error instanceof ProviderError) {
        manager.pushWorkerEvent(taskId, "error", {
          message: `Provider error: ${message}`,
          error: { code: "WORKER_CRASH", retryable: (error as ProviderError).retryable }
        });
      } else {
        manager.pushWorkerEvent(taskId, "error", {
          message,
          error: { code: "WORKER_CRASH", retryable: false }
        });
      }
    } catch {
      // Task may already be in a terminal state
    }
  }

  async function executeLoop(
    runtime: TaskRuntime,
    initialInput: Array<OpenAIInputMessage | OpenAIFunctionCallOutput | OpenAIResponsesOutputItem>,
    previousResponseId: string | null
  ): Promise<void> {
    const { task, model, scopedHarness, trace, abortController, steerChannel } = runtime;
    const taskId = task.taskId;
    const instructions = buildSystemInstructions(task);
    const maxSteps = task.constraints.maxTurns;
    const callbacks = buildCallbacks(taskId);

    try {
      const requestFn = buildRequestFn(runtime);
      const wrappedRequest = previousResponseId
        ? async (body: Record<string, unknown>) => {
            // Inject previous_response_id for conversation continuity
            if (!body.previous_response_id) {
              body.previous_response_id = previousResponseId;
            }
            return requestFn(body);
          }
        : requestFn;

      const adapter = deps.authModeRegistry.get(runtime.providerSettings.authMode);
      const stateless = adapter.describe().capabilities.statelessToolLoop;

      const { reply, finalResponse, accumulatedInput } = await runOpenAIToolLoop({
        request: wrappedRequest,
        model: model.id,
        instructions,
        initialInput,
        stateless,
        thinkingEffort: model.defaultThinking,
        compactionTokens: model.compactionTokens,
        compactionThreshold: model.compactionThreshold,
        promptCacheKey: `subagent:${taskId}`,
        promptCacheRetention: "in_memory",
        harness: scopedHarness,
        maxSteps,
        extractAssistantText,
        trace,
        abortSignal: abortController.signal,
        steerChannel,
        onToolCall: callbacks.onToolCall,
        onResponse: callbacks.onResponse,
        limits: buildToolLoopLimits(task)
      });

      const paused = handleReply(taskId, reply, finalResponse.id, runtime, accumulatedInput);
      if (!paused) {
        activeTasks.delete(taskId);
      }
    } catch (error) {
      handleError(taskId, error, abortController);
      activeTasks.delete(taskId);
    }
  }

  async function runTask(task: SubagentTask): Promise<void> {
    const { taskId } = task;
    const abortController = new AbortController();
    const steerChannel = createSteerChannel();
    const model = resolveModel(task.execution.model);
    // Resolve the supervisor's per-conversation cwd so the subagent inherits it
    const supervisorCwd = harness.resolveDefaultCwd
      ? await harness.resolveDefaultCwd(task.ownerId)
      : undefined;
    const scopedHarness = createScopedHarness(harness, taskId, task.ownerId, supervisorCwd);
    const trace = createTraceRootContext("subagent");

    // Snapshot supervisor's auth/transport settings so they're stable for this task
    const providerSettings = await resolveOwnerProviderSettings(task.ownerId);

    // Register available tools on the task
    const toolNames = scopedHarness.exportProviderTools().map((t) => t.name);
    try { manager.setTaskTools(taskId, toolNames); } catch { /* ignore if not supported */ }

    const runtime: TaskRuntime = {
      abortController,
      steerChannel,
      loopPromise: Promise.resolve(),
      pausedResponseId: null,
      pausedAccumulatedInput: null,
      task,
      model,
      scopedHarness,
      trace,
      providerSettings
    };
    activeTasks.set(taskId, runtime);

    await executeLoop(
      runtime,
      [{ type: "message", role: "user", content: task.goal }],
      null
    );
  }

  async function resumeTask(taskId: string, runtime: TaskRuntime, supervisorMessage: string): Promise<void> {
    const previousResponseId = runtime.pausedResponseId;
    const savedInput = runtime.pausedAccumulatedInput;
    runtime.pausedResponseId = null;
    runtime.pausedAccumulatedInput = null;

    const resumeInput: Array<OpenAIInputMessage | OpenAIFunctionCallOutput | OpenAIResponsesOutputItem> = savedInput
      ? [...savedInput, { type: "message", role: "user", content: supervisorMessage }]
      : [{ type: "message", role: "user", content: supervisorMessage }];

    await executeLoop(
      runtime,
      resumeInput,
      savedInput ? null : previousResponseId
    );
  }

  return {
    async start(task: SubagentTask): Promise<void> {
      const promise = runTask(task);
      const runtime = activeTasks.get(task.taskId);
      if (runtime) {
        runtime.loopPromise = promise;
      }
    },

    async stop(taskId: string, _reason: string): Promise<void> {
      const runtime = activeTasks.get(taskId);
      if (!runtime) {
        return;
      }
      runtime.abortController.abort();
      activeTasks.delete(taskId);
    },

    async send(taskId: string, message: SupervisorMessage): Promise<void> {
      const runtime = activeTasks.get(taskId);
      if (!runtime) {
        throw new Error(`No active runtime for task ${taskId}`);
      }
      if (runtime.pausedResponseId) {
        // Resume from pause — start a new tool loop iteration
        runtime.loopPromise = resumeTask(taskId, runtime, message.content);
      } else {
        // Inject into running loop via steer channel
        runtime.steerChannel.push(message.content);
      }
    }
  };
}
