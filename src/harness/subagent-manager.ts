import { createSubagentTaskId, createSubagentEventId } from "../id.js";
import { createTraceRootContext, type ObservabilitySink, type TraceContext } from "../observability.js";
import { createTaskEventLogEntry, type SubagentLogSink } from "../subagent-log.js";
import {
  type TaskState,
  type TurnOwnership,
  type EventKind,
  type SubagentEvent,
  type SubagentTask,
  type TaskSnapshot,
  type SpawnTaskParams,
  type SpawnResponse,
  type RecvResponse,
  type SendResponse,
  type CancelResponse,
  type ListTaskSummary,
  type SupervisorMessage,
  type SubagentManagerConfig,
  type SubagentWorker,
  type AwaitCondition,
  type TaskConstraints,
  type TaskExecution,
  type CompletionContract,
  type ProgressInfo,
  type TaskResult,
  type TaskError,
  NO_OP_WORKER,
  isTerminal
} from "./subagent-types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TERMINAL_TASK_RETENTION_MS = 10 * 60 * 1000;
const MAX_RETAINED_TERMINAL_TASKS = 20;

export class SubagentManager {
  private readonly tasks = new Map<string, SubagentTask>();
  private readonly events = new Map<string, SubagentEvent[]>();
  private readonly config: SubagentManagerConfig;
  private worker: SubagentWorker;
  private readonly observability: ObservabilitySink | undefined;
  private readonly subagentLog: SubagentLogSink | undefined;

  // Per-task trace contexts for observability correlation
  private readonly taskTraces = new Map<string, TraceContext>();

  // Track latest progress per task for snapshot purposes
  private readonly latestProgress = new Map<string, ProgressInfo>();

  constructor(
    config: SubagentManagerConfig,
    worker?: SubagentWorker,
    observability?: ObservabilitySink,
    subagentLog?: SubagentLogSink
  ) {
    this.config = config;
    this.worker = worker ?? NO_OP_WORKER;
    this.observability = observability;
    this.subagentLog = subagentLog;
  }

  setWorker(worker: SubagentWorker): void {
    this.worker = worker;
  }

  setTaskTools(taskId: string, tools: string[]): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.availableTools = tools;
    }
  }

  // ── Observability ──────────────────────────────────────────────────────────

  private getTaskTrace(taskId: string): TraceContext {
    return this.taskTraces.get(taskId) ?? createTraceRootContext("subagent");
  }

  private emitObs(
    eventName: string,
    taskId: string,
    fields: Record<string, unknown> = {}
  ): void {
    if (!this.observability?.enabled) return;
    const trace = this.getTaskTrace(taskId);
    void this.observability.record({
      event: eventName,
      trace,
      taskId,
      ...fields
    }).catch(() => {});
  }

  private emitTaskEventLog(ownerId: string, event: SubagentEvent): void {
    if (!this.subagentLog?.enabled) {
      return;
    }

    void this.subagentLog.record(
      createTaskEventLogEntry({
        ownerId,
        event,
        trace: this.getTaskTrace(event.taskId)
      })
    ).catch(() => {});
  }

  private emitExchangeLog(entry: {
    ownerId: string;
    taskId: string;
    direction: "supervisor_to_subagent" | "subagent_to_supervisor";
    role: "supervisor" | "subagent";
    content: string;
    directiveType?: string | null;
    replyClassification?: "complete" | "needs_input" | null;
  }): void {
    if (!this.subagentLog?.enabled) {
      return;
    }

    void this.subagentLog.record({
      entry_type: "exchange",
      timestamp: nowIso(),
      owner_id: entry.ownerId,
      task_id: entry.taskId,
      direction: entry.direction,
      role: entry.role,
      content: entry.content,
      trace: this.getTaskTrace(entry.taskId),
      ...(entry.directiveType ? { directive_type: entry.directiveType } : {}),
      ...(entry.replyClassification ? { reply_classification: entry.replyClassification } : {})
    }).catch(() => {});
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private requireTask(taskId: string): SubagentTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    return task;
  }

  private requireTaskForOwner(taskId: string, ownerId: string): SubagentTask {
    const task = this.tasks.get(taskId);
    if (!task || task.ownerId !== ownerId) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  private requireNonTerminal(task: SubagentTask): void {
    if (isTerminal(task.state)) {
      throw new Error(`Task ${task.taskId} is in terminal state: ${task.state}`);
    }
  }

  private deleteTaskState(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      this.clearTimers(task);
    }
    this.tasks.delete(taskId);
    this.events.delete(taskId);
    this.taskTraces.delete(taskId);
    this.latestProgress.delete(taskId);
  }

  private pruneTerminalTasks(): void {
    const nowMs = Date.now();
    const retained: Array<{ taskId: string; finishedAtMs: number }> = [];

    for (const task of this.tasks.values()) {
      if (!isTerminal(task.state)) {
        continue;
      }

      const finishedAtMs = task.finishedAt ? Date.parse(task.finishedAt) : Date.parse(task.updatedAt);
      if (Number.isFinite(finishedAtMs) && nowMs - finishedAtMs > TERMINAL_TASK_RETENTION_MS) {
        this.deleteTaskState(task.taskId);
        continue;
      }

      retained.push({
        taskId: task.taskId,
        finishedAtMs: Number.isFinite(finishedAtMs) ? finishedAtMs : Number.MAX_SAFE_INTEGER
      });
    }

    const overflow = retained.length - MAX_RETAINED_TERMINAL_TASKS;
    if (overflow <= 0) {
      return;
    }

    retained.sort((left, right) => {
      if (left.finishedAtMs !== right.finishedAtMs) {
        return left.finishedAtMs - right.finishedAtMs;
      }
      return left.taskId.localeCompare(right.taskId);
    });

    for (let index = 0; index < overflow; index += 1) {
      this.deleteTaskState(retained[index].taskId);
    }
  }

  private appendEvent(
    taskId: string,
    kind: EventKind,
    state: TaskState,
    turnOwnership: TurnOwnership,
    fields: Partial<Omit<SubagentEvent, "eventId" | "taskId" | "seq" | "ts" | "state" | "kind" | "turnOwnership">> = {}
  ): SubagentEvent {
    const task = this.requireTask(taskId);
    const seq = task.nextSeq++;
    const event: SubagentEvent = {
      eventId: createSubagentEventId(),
      taskId,
      seq,
      ts: nowIso(),
      state,
      kind,
      turnOwnership,
      requiresResponse: fields.requiresResponse ?? false,
      message: fields.message ?? "",
      final: fields.final ?? false,
      ...fields
    };

    const stream = this.events.get(taskId)!;
    stream.push(event);
    this.emitTaskEventLog(task.ownerId, event);

    task.state = state;
    task.turnOwnership = turnOwnership;
    task.updatedAt = event.ts;

    if (isTerminal(state)) {
      task.finishedAt = event.ts;
      this.clearTimers(task);
      this.emitObs("subagent.task.terminal", taskId, {
        state,
        kind,
        message: event.message,
        result: event.result ?? null,
        error: event.error ?? null,
        turnsUsed: task.budgetUsage.turnsUsed,
        tokensUsed: task.budgetUsage.tokensUsed,
        elapsedSec: (Date.now() - task.startedAtMs) / 1000,
        errorCode: event.error?.code ?? null
      });
      this.pruneTerminalTasks();
    } else if (state === "needs_steer" || state === "needs_input" || state === "stalled") {
      this.emitObs("subagent.task.state_change", taskId, {
        state,
        kind,
        turnOwnership,
        message: event.message
      });
    }

    return event;
  }

  private clearTimers(task: SubagentTask): void {
    if (task.heartbeatTimer !== null) {
      clearInterval(task.heartbeatTimer);
      task.heartbeatTimer = null;
    }
    if (task.idleTimer !== null) {
      clearTimeout(task.idleTimer);
      task.idleTimer = null;
    }
    if (task.stallTimer !== null) {
      clearTimeout(task.stallTimer);
      task.stallTimer = null;
    }
  }

  private startHeartbeatTimer(task: SubagentTask): void {
    const intervalMs = task.execution.heartbeatIntervalSec * 1000;
    task.heartbeatTimer = setInterval(() => {
      if (isTerminal(task.state)) {
        this.clearTimers(task);
        return;
      }
      const now = nowIso();
      task.lastHeartbeatAt = now;
      task.leaseExpiresAt = new Date(Date.now() + intervalMs).toISOString();
      this.appendEvent(task.taskId, "heartbeat", task.state, task.turnOwnership, {
        message: "Heartbeat",
        leaseExpiresAt: task.leaseExpiresAt
      });
    }, intervalMs);
  }

  private startIdleTimer(task: SubagentTask): void {
    const idleMs = task.execution.idleTimeoutSec * 1000;
    const stallMs = task.execution.stallTimeoutSec * 1000;

    task.idleTimer = setTimeout(() => {
      if (isTerminal(task.state)) return;
      // Transition to stalled
      this.appendEvent(task.taskId, "status_change", "stalled", "supervisor", {
        message: `Task idle for ${task.execution.idleTimeoutSec}s — marked stalled.`,
        requiresResponse: true
      });

      // Start stall timeout for final failure (minimum 1s gap to avoid immediate fire)
      const stallTerminalMs = Math.max(stallMs - idleMs, 1_000);
      task.stallTimer = setTimeout(() => {
        if (isTerminal(task.state)) return;
        this.appendEvent(task.taskId, "error", "failed", "none", {
          message: "Stall timeout exceeded.",
          final: true,
          error: {
            code: "STALL_TIMEOUT",
            retryable: true
          }
        });
      }, stallTerminalMs);
    }, idleMs);
  }

  private resetIdleTimer(task: SubagentTask): void {
    if (task.idleTimer !== null) {
      clearTimeout(task.idleTimer);
      task.idleTimer = null;
    }
    if (task.stallTimer !== null) {
      clearTimeout(task.stallTimer);
      task.stallTimer = null;
    }
    if (!isTerminal(task.state)) {
      this.startIdleTimer(task);
    }
  }

  private checkBudgets(task: SubagentTask): void {
    if (isTerminal(task.state)) return;

    const checks: Array<{
      resource: "turns" | "tokens" | "time";
      used: number;
      limit: number;
      code: "TURN_LIMIT_EXCEEDED" | "TOKEN_BUDGET_EXCEEDED" | "TIME_BUDGET_EXCEEDED";
    }> = [];

    if (task.constraints.maxTurns !== null) {
      checks.push({
        resource: "turns",
        used: task.budgetUsage.turnsUsed,
        limit: task.constraints.maxTurns,
        code: "TURN_LIMIT_EXCEEDED"
      });
    }

    if (task.constraints.maxTotalTokens !== null) {
      checks.push({
        resource: "tokens",
        used: task.budgetUsage.tokensUsed,
        limit: task.constraints.maxTotalTokens,
        code: "TOKEN_BUDGET_EXCEEDED"
      });
    }

    if (task.constraints.timeBudgetSec !== null) {
      checks.push({
        resource: "time",
        used: (Date.now() - task.startedAtMs) / 1000,
        limit: task.constraints.timeBudgetSec,
        code: "TIME_BUDGET_EXCEEDED"
      });
    }

    for (const check of checks) {
      const percent = Math.round((check.used / check.limit) * 100);

      // Hard limit
      if (check.used >= check.limit) {
        this.appendEvent(task.taskId, "timeout", "timed_out", "none", {
          message: `${check.resource} budget exceeded (${check.used}/${check.limit}).`,
          final: true,
          error: {
            code: check.code,
            retryable: true
          }
        });
        return;
      }

      // Warning at 80%
      const warningKey = `${check.resource}_80`;
      if (percent >= 80 && !task.budgetUsage.budgetWarnings.has(warningKey)) {
        task.budgetUsage.budgetWarnings.add(warningKey);
        this.appendEvent(task.taskId, "budget_warning", task.state, task.turnOwnership, {
          message: `${check.resource} budget ${percent}% consumed (${check.used}/${check.limit}).`,
          budget: {
            resource: check.resource,
            used: check.used,
            limit: check.limit,
            percent
          }
        });
        this.emitObs("subagent.budget.warning", task.taskId, {
          resource: check.resource,
          used: check.used,
          limit: check.limit,
          percent
        });
      }
    }
  }

  private buildConstraints(): TaskConstraints {
    return {
      timeBudgetSec: this.config.defaultTimeBudgetSec,
      maxTurns: this.config.defaultMaxTurns,
      maxTotalTokens: this.config.defaultMaxTotalTokens
    };
  }

  private buildExecution(): TaskExecution {
    return {
      model: this.config.defaultModel,
      heartbeatIntervalSec: this.config.defaultHeartbeatIntervalSec,
      idleTimeoutSec: this.config.defaultIdleTimeoutSec,
      stallTimeoutSec: this.config.defaultStallTimeoutSec
    };
  }

  private buildCompletionContract(input?: Partial<CompletionContract>): CompletionContract {
    return {
      requireFinalSummary: input?.requireFinalSummary ?? true,
      requireStructuredResult: input?.requireStructuredResult ?? true
    };
  }

  private toSnapshot(task: SubagentTask): TaskSnapshot {
    const stream = this.events.get(task.taskId) ?? [];
    const lastEvent = stream.length > 0 ? stream[stream.length - 1] : null;
    const progress = this.latestProgress.get(task.taskId) ?? { percent: null, milestone: null };

    let awaiting: TaskSnapshot["awaiting"] = null;
    if (task.state === "needs_steer") {
      awaiting = { type: "supervisor", question: lastEvent?.message ?? null, deadlineAt: null };
    } else if (task.state === "needs_input") {
      awaiting = { type: "user", question: lastEvent?.message ?? null, deadlineAt: lastEvent?.deadlineAt ?? null };
    }

    let result: TaskResult | null = null;
    let error: TaskError | null = null;
    if (task.state === "completed" && lastEvent?.result) {
      result = lastEvent.result;
    }
    if ((task.state === "failed" || task.state === "timed_out") && lastEvent?.error) {
      error = lastEvent.error;
    }

    return {
      taskId: task.taskId,
      title: task.title,
      state: task.state,
      turnOwnership: task.turnOwnership,
      startedAt: task.startedAt,
      updatedAt: task.updatedAt,
      lastEventId: lastEvent?.eventId ?? null,
      lastHeartbeatAt: task.lastHeartbeatAt,
      leaseExpiresAt: task.leaseExpiresAt,
      turnsUsed: task.budgetUsage.turnsUsed,
      tokensUsed: task.budgetUsage.tokensUsed,
      progress,
      compactedSummary: task.compactedSummary,
      awaiting,
      result,
      error,
      labels: { ...task.labels }
    };
  }

  private toListSummary(task: SubagentTask): ListTaskSummary {
    const progress = this.latestProgress.get(task.taskId) ?? { percent: null, milestone: null };
    return {
      taskId: task.taskId,
      title: task.title,
      state: task.state,
      turnOwnership: task.turnOwnership,
      progress,
      updatedAt: task.updatedAt
    };
  }

  // ── Public action methods ──────────────────────────────────────────────────

  spawn(ownerId: string, params: SpawnTaskParams): SpawnResponse {
    this.pruneTerminalTasks();

    // Check concurrency limit
    let runningCount = 0;
    for (const t of this.tasks.values()) {
      if (!isTerminal(t.state)) runningCount++;
    }
    if (runningCount >= this.config.maxConcurrentTasks) {
      throw new Error(`Concurrent task limit reached (${this.config.maxConcurrentTasks})`);
    }

    const taskId = createSubagentTaskId();
    const now = nowIso();
    const constraints = this.buildConstraints();
    const execution = this.buildExecution();
    const completionContract = this.buildCompletionContract(params.completionContract);

    const task: SubagentTask = {
      taskId,
      ownerId,
      title: params.title,
      goal: params.goal,
      instructions: params.instructions,
      context: params.context ?? {},
      artifacts: params.artifacts ?? [],
      constraints,
      execution,
      completionContract,
      labels: params.labels ?? {},
      state: "queued",
      turnOwnership: "subagent",
      budgetUsage: {
        turnsUsed: 0,
        tokensUsed: 0,
        budgetWarnings: new Set()
      },
      nextSeq: 0,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      finishedAt: null,
      lastHeartbeatAt: null,
      leaseExpiresAt: null,
      compactedSummary: null,
      availableTools: [],
      heartbeatTimer: null,
      idleTimer: null,
      stallTimer: null,
      startedAtMs: Date.now()
    };

    this.tasks.set(taskId, task);
    this.events.set(taskId, []);

    // Create observability trace for this task
    this.taskTraces.set(taskId, createTraceRootContext("subagent"));

    // Transition: queued -> starting -> running
    task.state = "starting";
    task.startedAt = now;
    const leaseMs = execution.heartbeatIntervalSec * 1000;
    task.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();

    const startedEvent = this.appendEvent(taskId, "started", "running", "subagent", {
      message: `Task "${params.title}" started.`,
      leaseExpiresAt: task.leaseExpiresAt
    });

    // Start runtime timers
    this.startHeartbeatTimer(task);
    this.startIdleTimer(task);

    this.emitObs("subagent.task.spawned", taskId, {
      ownerId,
      title: params.title,
      goal: params.goal,
      instructions: params.instructions ?? null,
      context: params.context ?? null,
      constraints: {
        timeBudgetSec: constraints.timeBudgetSec,
        maxTurns: constraints.maxTurns,
        maxTotalTokens: constraints.maxTotalTokens
      },
      labels: params.labels
    });

    // Notify worker (fire-and-forget — errors become protocol events)
    void this.worker.start(task).catch((err) => {
      if (!isTerminal(task.state)) {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendEvent(taskId, "error", "failed", "none", {
          message: `Worker start failed: ${msg}`,
          final: true,
          error: { code: "WORKER_CRASH" as const, retryable: true }
        });
      }
      this.emitObs("subagent.worker.start_failed", taskId, { error: String(err) });
    });

    return {
      taskId,
      state: task.state as "starting" | "running",
      cursor: startedEvent.eventId,
      leaseExpiresAt: task.leaseExpiresAt!,
      startedAt: task.startedAt!
    };
  }

  recv(
    ownerId: string,
    tasks: Record<string, string>,
    maxEvents?: number
  ): RecvResponse {
    this.pruneTerminalTasks();

    // Filter to only tasks owned by the caller
    const ownedTasks: Record<string, string> = {};
    for (const [taskId, cursor] of Object.entries(tasks)) {
      const task = this.tasks.get(taskId);
      if (task && task.ownerId === ownerId) {
        ownedTasks[taskId] = cursor;
      }
    }
    tasks = ownedTasks;
    const effectiveMaxEvents = Math.min(
      maxEvents ?? this.config.recvMaxEvents,
      this.config.recvMaxEvents
    );

    const collectEvents = (): { events: SubagentEvent[]; cursors: Record<string, string> } => {
      const allEvents: SubagentEvent[] = [];
      const cursors: Record<string, string> = {};

      for (const [taskId, lastCursor] of Object.entries(tasks)) {
        const stream = this.events.get(taskId);
        if (!stream) {
          cursors[taskId] = lastCursor;
          continue;
        }

        // Find events after the cursor
        let startIdx = 0;
        if (lastCursor) {
          const cursorIdx = stream.findIndex((e) => e.eventId === lastCursor);
          if (cursorIdx >= 0) {
            startIdx = cursorIdx + 1;
          } else {
            // Cursor not found — treat as past-the-end to avoid replaying history
            startIdx = stream.length;
          }
        }

        const newEvents = stream.slice(startIdx);
        allEvents.push(...newEvents);

        const lastEvent = newEvents.length > 0 ? newEvents[newEvents.length - 1] : null;
        cursors[taskId] = lastEvent ? lastEvent.eventId : lastCursor;
      }

      // Sort by timestamp, then limit
      allEvents.sort((a, b) => a.ts.localeCompare(b.ts));
      const limited = allEvents.slice(0, effectiveMaxEvents);

      // Update cursors based on which events were actually returned
      const returnedIds = new Set(limited.map((e) => e.eventId));
      for (const [taskId] of Object.entries(tasks)) {
        const stream = this.events.get(taskId);
        if (!stream) continue;
        // Find the last returned event for this task
        for (let i = stream.length - 1; i >= 0; i--) {
          if (returnedIds.has(stream[i].eventId)) {
            cursors[taskId] = stream[i].eventId;
            break;
          }
        }
      }

      return { events: limited, cursors };
    };

    // Immediate collection — use await_ action for blocking behavior
    return collectEvents();
  }

  send(ownerId: string, taskId: string, message: SupervisorMessage): SendResponse {
    this.pruneTerminalTasks();
    const task = this.requireTaskForOwner(taskId, ownerId);

    if (isTerminal(task.state)) {
      throw new Error(`Cannot send to task ${taskId} in terminal state: ${task.state}`);
    }

    if (task.turnOwnership === "subagent") {
      throw new Error(`Cannot send to task ${taskId}: turn ownership is "subagent" (worker is busy). Use cancel to interrupt.`);
    }

    const directiveType = message.directiveType ?? "guidance";

    const event = this.appendEvent(taskId, "status_change", "running", "subagent", {
      message: `Supervisor ${directiveType}: ${message.content.slice(0, 200)}`,
    });

    // Reset idle timer on supervisor interaction
    this.resetIdleTimer(task);

    this.emitObs("subagent.supervisor.sent", taskId, {
      directiveType,
      content: message.content,
      contentLength: message.content.length
    });
    this.emitExchangeLog({
      ownerId,
      taskId,
      direction: "supervisor_to_subagent",
      role: "supervisor",
      content: message.content,
      directiveType
    });

    // Notify worker (errors are logged but non-fatal — task continues)
    void this.worker.send(taskId, message).catch((err) => {
      this.emitObs("subagent.worker.send_failed", taskId, { error: String(err) });
    });

    return {
      taskId,
      accepted: true,
      state: task.state,
      cursor: event.eventId
    };
  }

  inspect(ownerId: string, taskId: string): TaskSnapshot {
    this.pruneTerminalTasks();
    const task = this.requireTaskForOwner(taskId, ownerId);
    return this.toSnapshot(task);
  }

  list(ownerId: string, filter?: {
    states?: TaskState[];
    labels?: Record<string, string>;
  }): ListTaskSummary[] {
    this.pruneTerminalTasks();
    const results: ListTaskSummary[] = [];

    for (const task of this.tasks.values()) {
      if (task.ownerId !== ownerId) continue;
      // Filter by states
      if (filter?.states && filter.states.length > 0) {
        if (!filter.states.includes(task.state)) continue;
      }

      // Filter by labels
      if (filter?.labels) {
        let match = true;
        for (const [key, value] of Object.entries(filter.labels)) {
          if (task.labels[key] !== value) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }

      results.push(this.toListSummary(task));
    }

    return results;
  }

  cancel(ownerId: string, taskId: string, reason: string): CancelResponse {
    this.pruneTerminalTasks();
    const task = this.requireTaskForOwner(taskId, ownerId);

    if (isTerminal(task.state)) {
      throw new Error(`Task ${taskId} is already in terminal state: ${task.state}`);
    }

    const event = this.appendEvent(taskId, "status_change", "cancelled", "none", {
      message: `Cancelled: ${reason}`,
      final: true
    });

    // Notify worker (task already transitioned to cancelled — just log failures)
    void this.worker.stop(taskId, reason).catch((err) => {
      this.emitObs("subagent.worker.stop_failed", taskId, { error: String(err) });
    });

    return {
      taskId,
      state: "cancelled",
      finalEventId: event.eventId
    };
  }

  async await_(
    ownerId: string,
    taskId: string,
    until: AwaitCondition[],
    timeoutMs: number,
    cursor?: string
  ): Promise<RecvResponse> {
    this.pruneTerminalTasks();
    const effectiveTimeout = Math.min(timeoutMs, this.config.awaitMaxTimeoutMs);
    const task = this.requireTaskForOwner(taskId, ownerId);
    const stream = this.events.get(taskId) ?? [];

    // If the task is already terminal and we're waiting for terminal, return immediately
    // with the terminal event(s).
    if (isTerminal(task.state) && until.includes("terminal")) {
      const terminalEvents = stream.filter((e) => e.final);
      return {
        events: terminalEvents,
        cursors: {
          [taskId]: terminalEvents.length > 0
            ? terminalEvents[terminalEvents.length - 1].eventId
            : (stream.length > 0 ? stream[stream.length - 1].eventId : "")
        }
      };
    }

    // Pre-scan: if no cursor and task already has qualifying events, return immediately.
    // This handles the case where qualifying events arrived before await_ was called.
    // (Skips "any_event" — that condition means "wait for the next thing", not "return old events".
    //  Skips "terminal" — already handled by the pre-scan above.)
    if (!cursor) {
      const matchingEvents = stream.filter((e) =>
        (until.includes("requires_response") && e.requiresResponse) ||
        (until.includes("progress") && (e.kind === "progress" || e.kind === "checkpoint"))
      );

      if (matchingEvents.length > 0) {
        const firstMatchIdx = stream.indexOf(matchingEvents[0]);
        const eventsFromMatch = stream.slice(firstMatchIdx);
        return {
          events: eventsFromMatch,
          cursors: { [taskId]: eventsFromMatch[eventsFromMatch.length - 1].eventId }
        };
      }
    }

    let startSeq: number;
    if (cursor) {
      const cursorIdx = stream.findIndex((e) => e.eventId === cursor);
      startSeq = cursorIdx >= 0 ? stream[cursorIdx].seq : -1;
    } else {
      startSeq = stream.length > 0 ? stream[stream.length - 1].seq : -1;
    }
    const deadline = Date.now() + effectiveTimeout;
    const pollIntervalMs = 50;

    while (Date.now() < deadline) {
      const currentStream = this.events.get(taskId) ?? [];
      const newEvents = currentStream.filter((e) => e.seq > startSeq);

      for (const event of newEvents) {
        const matched =
          (until.includes("terminal") && event.final) ||
          (until.includes("requires_response") && event.requiresResponse) ||
          (until.includes("any_event")) ||
          (until.includes("progress") && (event.kind === "progress" || event.kind === "checkpoint"));

        if (matched) {
          return {
            events: newEvents,
            cursors: { [taskId]: newEvents[newEvents.length - 1].eventId }
          };
        }
      }

      await sleep(pollIntervalMs);
    }

    // Timeout — return whatever we have
    const finalStream = this.events.get(taskId) ?? [];
    const timedOutEvents = finalStream.filter((e) => e.seq > startSeq);
    return {
      events: timedOutEvents,
      cursors: {
        [taskId]: timedOutEvents.length > 0
          ? timedOutEvents[timedOutEvents.length - 1].eventId
          : (finalStream.length > 0 ? finalStream[finalStream.length - 1].eventId : "")
      }
    };
  }

  // ── Worker integration (called by workers to push events) ──────────────────

  pushWorkerEvent(
    taskId: string,
    kind: EventKind,
    fields: {
      message: string;
      turnOwnership?: TurnOwnership;
      requiresResponse?: boolean;
      progress?: ProgressInfo;
      options?: SubagentEvent["options"];
      blockedAction?: SubagentEvent["blockedAction"];
      attachments?: SubagentEvent["attachments"];
      result?: TaskResult;
      partialResult?: TaskResult;
      error?: TaskError;
      checkpoint?: SubagentEvent["checkpoint"];
      deadlineAt?: string;
    }
  ): SubagentEvent {
    const task = this.requireTask(taskId);
    this.requireNonTerminal(task);

    // Determine target state and turn ownership
    let targetState: TaskState = task.state;
    let targetOwnership: TurnOwnership = fields.turnOwnership ?? task.turnOwnership;
    let isFinal = false;

    switch (kind) {
      case "result":
        targetState = "completed";
        targetOwnership = "none";
        isFinal = true;
        break;
      case "error":
        targetState = "failed";
        targetOwnership = "none";
        isFinal = true;
        break;
      case "timeout":
        targetState = "timed_out";
        targetOwnership = "none";
        isFinal = true;
        break;
      case "decision_request":
      case "question":
        targetState = "needs_steer";
        targetOwnership = "supervisor";
        break;
      case "input_request":
        targetState = "needs_input";
        targetOwnership = "user";
        break;
      case "progress":
      case "observation":
      case "artifact":
      case "warning":
        targetState = "running";
        targetOwnership = "subagent";
        break;
      case "checkpoint":
        targetState = "running";
        targetOwnership = "subagent";
        break;
    }

    // Update progress tracking
    if (fields.progress) {
      this.latestProgress.set(taskId, fields.progress);
    }

    const event = this.appendEvent(taskId, kind, targetState, targetOwnership, {
      message: fields.message,
      requiresResponse: fields.requiresResponse ?? (targetOwnership === "supervisor" || targetOwnership === "user"),
      final: isFinal,
      progress: fields.progress,
      options: fields.options,
      blockedAction: fields.blockedAction,
      attachments: fields.attachments,
      result: fields.result,
      partialResult: fields.partialResult,
      error: fields.error,
      checkpoint: fields.checkpoint,
      deadlineAt: fields.deadlineAt
    });

    // Emit observability for key exchange events
    if (kind === "question" || kind === "decision_request" || kind === "input_request") {
      this.emitObs("subagent.worker.question", taskId, {
        kind,
        message: fields.message,
        options: fields.options ?? null
      });
    } else if (kind === "result") {
      this.emitObs("subagent.worker.result", taskId, {
        message: fields.message,
        result: fields.result ?? null,
        partialResult: fields.partialResult ?? null
      });
    }

    // Reset idle timer on activity
    this.resetIdleTimer(task);

    return event;
  }

  recordTurnUsed(taskId: string): void {
    const task = this.requireTask(taskId);
    if (isTerminal(task.state)) return;
    task.budgetUsage.turnsUsed++;
    this.checkBudgets(task);
  }

  recordTokensUsed(taskId: string, count: number): void {
    const task = this.requireTask(taskId);
    if (isTerminal(task.state)) return;
    task.budgetUsage.tokensUsed += count;
    this.checkBudgets(task);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    const pendingStops: Promise<void>[] = [];
    for (const task of this.tasks.values()) {
      if (!isTerminal(task.state)) {
        this.clearTimers(task);
        task.state = "cancelled";
        task.finishedAt = nowIso();
        task.updatedAt = task.finishedAt;
        // Append terminal event without going through appendEvent to avoid
        // re-entrance issues during shutdown.
        const stream = this.events.get(task.taskId);
        if (stream) {
          const event: SubagentEvent = {
            eventId: createSubagentEventId(),
            taskId: task.taskId,
            seq: task.nextSeq++,
            ts: task.finishedAt,
            state: "cancelled",
            kind: "status_change",
            turnOwnership: "none",
            requiresResponse: false,
            message: "Shutdown: all tasks cancelled.",
            final: true
          };
          stream.push(event);
          this.emitTaskEventLog(task.ownerId, event);
        }
        pendingStops.push(this.worker.stop(task.taskId, "shutdown").catch(() => {}));
      }
    }

    await Promise.all(pendingStops);
  }

  getHealth(): {
    totalTasks: number;
    runningTasks: number;
    completedTasks: number;
    failedTasks: number;
    cancelledTasks: number;
  } {
    this.pruneTerminalTasks();
    let running = 0;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    for (const task of this.tasks.values()) {
      if (task.state === "completed") completed++;
      else if (task.state === "failed" || task.state === "timed_out") failed++;
      else if (task.state === "cancelled") cancelled++;
      else running++;
    }
    return {
      totalTasks: this.tasks.size,
      runningTasks: running,
      completedTasks: completed,
      failedTasks: failed,
      cancelledTasks: cancelled
    };
  }
}
