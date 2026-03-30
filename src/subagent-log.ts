import * as fs from "node:fs/promises";
import * as path from "node:path";
import { appendTextWithTailRetention } from "./file-retention.js";
import type { TraceContext, ObservabilityRedactionConfig } from "./observability.js";
import { DEFAULT_OBSERVABILITY_REDACTION } from "./observability.js";
import type {
  Attachment,
  BlockedAction,
  BudgetInfo,
  Checkpoint,
  DecisionOption,
  ProgressInfo,
  SubagentEvent,
  TaskError,
  TaskResult
} from "./harness/subagent-types.js";

export type SubagentSessionContext = {
  taskId: string;
  ownerId: string;
};

export type SnakeCaseAttachment = {
  type: string;
  ref: string;
  label?: string;
};

export type SnakeCaseProgressInfo = {
  percent: number | null;
  milestone: string | null;
};

export type SnakeCaseDecisionOption = {
  id: string;
  label: string;
  risk?: string;
  expected_effect?: string;
};

export type SnakeCaseBlockedAction = {
  type: string;
  description: string;
  ref?: string;
};

export type SnakeCaseTaskResult = {
  summary: string;
  outcome: "success" | "partial" | "inconclusive";
  confidence: number;
  confirmed: string[];
  inferred: string[];
  unverified: string[];
  deliverables: SnakeCaseAttachment[];
  evidence: string[];
  open_issues: string[];
  recommended_next_steps: string[];
  decision_journal: string | null;
};

export type SnakeCaseTaskError = {
  code: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type SnakeCaseCheckpoint = {
  plan?: string[];
  success_criteria?: string[];
  state?: Record<string, unknown>;
};

export type SnakeCaseBudgetInfo = {
  resource: "turns" | "tokens" | "time";
  used: number;
  limit: number;
  percent: number;
};

export type SupervisorToolCallLogEntry = {
  entry_type: "supervisor_tool_call";
  timestamp: string;
  owner_id: string | null;
  task_id: null;
  tool: "subagents";
  action: string | null;
  normalized_request: unknown;
  success: boolean;
  response: unknown | null;
  error: unknown | null;
  error_code: string | null;
  started_at: string;
  finished_at: string;
  trace: TraceContext;
};

export type WorkerToolCallLogEntry = {
  entry_type: "worker_tool_call";
  timestamp: string;
  owner_id: string;
  task_id: string;
  tool: string;
  args: unknown;
  result: unknown | null;
  error: unknown | null;
  success: boolean;
  error_code: string | null;
  started_at: string;
  finished_at: string;
  trace: TraceContext;
};

export type ExchangeLogEntry = {
  entry_type: "exchange";
  timestamp: string;
  owner_id: string;
  task_id: string;
  direction: "supervisor_to_subagent" | "subagent_to_supervisor";
  role: "supervisor" | "subagent";
  content: string;
  trace: TraceContext;
  directive_type?: string | null;
  reply_classification?: "complete" | "needs_input" | null;
};

export type TaskEventLogEntry = {
  entry_type: "task_event";
  timestamp: string;
  owner_id: string;
  task_id: string;
  trace: TraceContext;
  event_id: string;
  seq: number;
  ts: string;
  state: string;
  kind: string;
  turn_ownership: string;
  requires_response: boolean;
  message: string;
  final: boolean;
  progress?: SnakeCaseProgressInfo;
  options?: SnakeCaseDecisionOption[];
  blocked_action?: SnakeCaseBlockedAction;
  attachments?: SnakeCaseAttachment[];
  result?: SnakeCaseTaskResult;
  partial_result?: SnakeCaseTaskResult;
  error?: SnakeCaseTaskError;
  checkpoint?: SnakeCaseCheckpoint;
  budget?: SnakeCaseBudgetInfo;
  deadline_at?: string;
  lease_expires_at?: string;
};

export type SubagentLogEntry =
  | SupervisorToolCallLogEntry
  | WorkerToolCallLogEntry
  | ExchangeLogEntry
  | TaskEventLogEntry;

export type SubagentLogSink = {
  enabled: boolean;
  path: string | null;
  record: (entry: SubagentLogEntry) => Promise<void>;
};

function serializeValue(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const raw = JSON.stringify(value, (_key, current) => {
    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        stack: current.stack,
        cause: current.cause
      };
    }

    if (typeof current === "bigint") {
      return current.toString();
    }

    if (typeof current === "function") {
      return "[Function]";
    }

    if (typeof current === "object" && current !== null) {
      if (seen.has(current)) {
        return "[Circular]";
      }
      seen.add(current);
    }

    return current;
  });

  if (raw === undefined) {
    return null;
  }

  return JSON.parse(raw);
}

function normalizeRedactionConfig(
  redaction: Partial<ObservabilityRedactionConfig> | undefined
): ObservabilityRedactionConfig {
  const maxStringChars = Math.max(1, Math.floor(redaction?.maxStringChars ?? DEFAULT_OBSERVABILITY_REDACTION.maxStringChars));
  const redactKeys =
    redaction?.redactKeys && redaction.redactKeys.length > 0
      ? redaction.redactKeys
      : [...DEFAULT_OBSERVABILITY_REDACTION.redactKeys];

  return {
    enabled: redaction?.enabled ?? DEFAULT_OBSERVABILITY_REDACTION.enabled,
    maxStringChars,
    redactKeys
  };
}

function normalizeRedactionKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function applyRedactionAndTruncation(
  value: unknown,
  config: ObservabilityRedactionConfig,
  redactKeySet: Set<string>
): unknown {
  if (typeof value === "string") {
    if (value.length <= config.maxStringChars) {
      return value;
    }

    const truncatedChars = value.length - config.maxStringChars;
    return `${value.slice(0, config.maxStringChars)}...[TRUNCATED:+${truncatedChars} chars]`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => applyRedactionAndTruncation(item, config, redactKeySet));
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const source = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(source)) {
    const normalizedKey = normalizeRedactionKey(key);
    if (config.enabled && redactKeySet.has(normalizedKey)) {
      redacted[key] = "[REDACTED]";
      continue;
    }

    redacted[key] = applyRedactionAndTruncation(raw, config, redactKeySet);
  }

  return redacted;
}

function toSnakeAttachment(value: Attachment): SnakeCaseAttachment {
  return {
    type: value.type,
    ref: value.ref,
    ...(value.label ? { label: value.label } : {})
  };
}

function toSnakeProgress(value: ProgressInfo): SnakeCaseProgressInfo {
  return {
    percent: value.percent,
    milestone: value.milestone
  };
}

function toSnakeDecisionOption(value: DecisionOption): SnakeCaseDecisionOption {
  return {
    id: value.id,
    label: value.label,
    ...(value.risk ? { risk: value.risk } : {}),
    ...(value.expectedEffect ? { expected_effect: value.expectedEffect } : {})
  };
}

function toSnakeBlockedAction(value: BlockedAction): SnakeCaseBlockedAction {
  return {
    type: value.type,
    description: value.description,
    ...(value.ref ? { ref: value.ref } : {})
  };
}

function toSnakeTaskResult(value: TaskResult): SnakeCaseTaskResult {
  return {
    summary: value.summary,
    outcome: value.outcome,
    confidence: value.confidence,
    confirmed: [...value.confirmed],
    inferred: [...value.inferred],
    unverified: [...value.unverified],
    deliverables: value.deliverables.map((item) => toSnakeAttachment(item)),
    evidence: [...value.evidence],
    open_issues: [...value.openIssues],
    recommended_next_steps: [...value.recommendedNextSteps],
    decision_journal: value.decisionJournalPath
  };
}

function toSnakeTaskError(value: TaskError): SnakeCaseTaskError {
  return {
    code: value.code,
    retryable: value.retryable,
    ...(value.details ? { details: value.details } : {})
  };
}

function toSnakeCheckpoint(value: Checkpoint): SnakeCaseCheckpoint {
  return {
    ...(value.plan ? { plan: [...value.plan] } : {}),
    ...(value.successCriteria ? { success_criteria: [...value.successCriteria] } : {}),
    ...(value.state ? { state: value.state } : {})
  };
}

function toSnakeBudget(value: BudgetInfo): SnakeCaseBudgetInfo {
  return {
    resource: value.resource,
    used: value.used,
    limit: value.limit,
    percent: value.percent
  };
}

export function createTaskEventLogEntry(params: {
  ownerId: string;
  event: SubagentEvent;
  trace: TraceContext;
}): TaskEventLogEntry {
  const { ownerId, event, trace } = params;
  return {
    entry_type: "task_event",
    timestamp: event.ts,
    owner_id: ownerId,
    task_id: event.taskId,
    trace,
    event_id: event.eventId,
    seq: event.seq,
    ts: event.ts,
    state: event.state,
    kind: event.kind,
    turn_ownership: event.turnOwnership,
    requires_response: event.requiresResponse,
    message: event.message,
    final: event.final,
    ...(event.progress ? { progress: toSnakeProgress(event.progress) } : {}),
    ...(event.options ? { options: event.options.map((item) => toSnakeDecisionOption(item)) } : {}),
    ...(event.blockedAction ? { blocked_action: toSnakeBlockedAction(event.blockedAction) } : {}),
    ...(event.attachments ? { attachments: event.attachments.map((item) => toSnakeAttachment(item)) } : {}),
    ...(event.result ? { result: toSnakeTaskResult(event.result) } : {}),
    ...(event.partialResult ? { partial_result: toSnakeTaskResult(event.partialResult) } : {}),
    ...(event.error ? { error: toSnakeTaskError(event.error) } : {}),
    ...(event.checkpoint ? { checkpoint: toSnakeCheckpoint(event.checkpoint) } : {}),
    ...(event.budget ? { budget: toSnakeBudget(event.budget) } : {}),
    ...(event.deadlineAt ? { deadline_at: event.deadlineAt } : {}),
    ...(event.leaseExpiresAt ? { lease_expires_at: event.leaseExpiresAt } : {})
  };
}

export function createNoopSubagentLogSink(): SubagentLogSink {
  return {
    enabled: false,
    path: null,
    async record(): Promise<void> {
      // no-op
    }
  };
}

export function createSubagentLogSink(params: {
  enabled: boolean;
  logPath: string;
  maxLines?: number | null;
  redaction?: Partial<ObservabilityRedactionConfig>;
  warningReporter?: (message: string) => void;
}): SubagentLogSink {
  if (!params.enabled) {
    return createNoopSubagentLogSink();
  }

  const resolvedPath = path.resolve(params.logPath);
  const maxLines = params.maxLines ?? null;
  const redactionConfig = normalizeRedactionConfig(params.redaction);
  const redactKeySet = new Set(redactionConfig.redactKeys.map((key) => normalizeRedactionKey(key)));
  const reportWarning = params.warningReporter ?? ((message: string) => console.warn(message));
  let ensureDirectoryPromise: Promise<void> | null = null;
  let hasReportedWriteFailure = false;
  let queue: Promise<void> = Promise.resolve();

  const ensureLogDirectory = async (): Promise<void> => {
    if (!ensureDirectoryPromise) {
      ensureDirectoryPromise = fs
        .mkdir(path.dirname(resolvedPath), { recursive: true })
        .then(() => undefined)
        .catch((error) => {
          ensureDirectoryPromise = null;
          throw error;
        });
    }

    await ensureDirectoryPromise;
  };

  const appendEntry = async (entry: SubagentLogEntry): Promise<void> => {
    const serialized = serializeValue(entry);
    const payload = applyRedactionAndTruncation(serialized, redactionConfig, redactKeySet);

    try {
      await ensureLogDirectory();
      await appendTextWithTailRetention({
        filePath: resolvedPath,
        text: `${JSON.stringify(payload)}\n`,
        maxLines
      });
    } catch (error) {
      if (hasReportedWriteFailure) {
        return;
      }

      hasReportedWriteFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      reportWarning(
        `${new Date().toISOString()} [WARN] subagent-log: failed to append entry to ${resolvedPath}: ${message}`
      );
    }
  };

  return {
    enabled: true,
    path: resolvedPath,
    async record(entry): Promise<void> {
      queue = queue.then(() => appendEntry(entry), () => appendEntry(entry));
      await queue;
    }
  };
}
