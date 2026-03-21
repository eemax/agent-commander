// ──────────────────────────────────────────────────────────────────────────────
// Subagent domain types — pure TypeScript, no Zod, no runtime code.
// ──────────────────────────────────────────────────────────────────────────────

// --- State machine -----------------------------------------------------------

export type TaskState =
  | "queued"
  | "starting"
  | "running"
  | "needs_steer"
  | "needs_input"
  | "paused"
  | "stalled"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type TerminalState = "completed" | "failed" | "cancelled" | "timed_out";

export const TERMINAL_STATES: readonly TerminalState[] = [
  "completed",
  "failed",
  "cancelled",
  "timed_out"
] as const;

export function isTerminal(state: TaskState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

// --- Turn ownership ----------------------------------------------------------

export type TurnOwnership = "subagent" | "supervisor" | "user" | "none";

// --- Event kinds -------------------------------------------------------------

export type EventKind =
  | "started"
  | "heartbeat"
  | "progress"
  | "observation"
  | "artifact"
  | "warning"
  | "decision_request"
  | "question"
  | "input_request"
  | "checkpoint"
  | "result"
  | "error"
  | "status_change"
  | "budget_warning";

// --- Directive types ---------------------------------------------------------

export type DirectiveType =
  | "guidance"
  | "correction"
  | "override"
  | "approval"
  | "answer";

// --- Error codes -------------------------------------------------------------

export type SubagentErrorCode =
  | "WORKER_CRASH"
  | "WORKER_EXIT_WITHOUT_TERMINAL_EVENT"
  | "LEASE_EXPIRED"
  | "STALL_TIMEOUT"
  | "TURN_LIMIT_EXCEEDED"
  | "TIME_BUDGET_EXCEEDED"
  | "TOKEN_BUDGET_EXCEEDED"
  | "TOOL_ACCESS_DENIED"
  | "ACTION_NOT_PERMITTED"
  | "SANDBOX_ERROR"
  | "PROTOCOL_VIOLATION"
  | "SUPERVISOR_RESPONSE_TIMEOUT"
  | "USER_INPUT_REQUIRED_TIMEOUT"
  | "SPAWN_DEPTH_VIOLATION"
  | "ENVIRONMENT_MISMATCH";

// --- Event sub-structures ----------------------------------------------------

export type ProgressInfo = {
  percent: number | null;
  milestone: string | null;
};

export type DecisionOption = {
  id: string;
  label: string;
  risk?: string;
  expectedEffect?: string;
};

export type BlockedAction = {
  type: string;
  description: string;
  ref?: string;
};

export type Attachment = {
  type: string;
  ref: string;
  label?: string;
};

export type TaskResult = {
  summary: string;
  outcome: "success" | "partial" | "inconclusive";
  confidence: number;
  deliverables: Attachment[];
  evidence: string[];
  openIssues: string[];
  recommendedNextSteps: string[];
};

export type TaskError = {
  code: SubagentErrorCode;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type Checkpoint = {
  plan?: string[];
  successCriteria?: string[];
  state?: Record<string, unknown>;
};

export type BudgetInfo = {
  resource: "turns" | "tokens" | "time";
  used: number;
  limit: number;
  percent: number;
};

// --- Core event type ---------------------------------------------------------

export type SubagentEvent = {
  eventId: string;
  taskId: string;
  seq: number;
  ts: string;
  state: TaskState;
  kind: EventKind;
  turnOwnership: TurnOwnership;
  requiresResponse: boolean;
  message: string;
  final: boolean;

  // Optional fields
  progress?: ProgressInfo;
  options?: DecisionOption[];
  blockedAction?: BlockedAction;
  attachments?: Attachment[];
  result?: TaskResult;
  partialResult?: TaskResult;
  error?: TaskError;
  checkpoint?: Checkpoint;
  budget?: BudgetInfo;
  deadlineAt?: string;
  leaseExpiresAt?: string;
};

// --- Approval policy ---------------------------------------------------------

export type ApprovalPolicy = {
  canEditCode: boolean;
  canRunTests: boolean;
  canOpenPr: boolean;
  requiresSupervisorFor: string[];
};

// --- Task constraints --------------------------------------------------------

export type TaskConstraints = {
  timeBudgetSec: number;
  maxTurns: number;
  maxTotalTokens: number;
  requirePlanByTurn: number;
  sandbox: string;
  network: "off" | "restricted" | "full";
  noChildSpawn: true;
  approvalPolicy: ApprovalPolicy;
};

// --- Task execution config ---------------------------------------------------

export type TaskExecution = {
  agentType: string;
  model: string;
  heartbeatIntervalSec: number;
  idleTimeoutSec: number;
  stallTimeoutSec: number;
};

// --- Completion contract -----------------------------------------------------

export type CompletionContract = {
  requireFinalSummary: boolean;
  requireStructuredResult: boolean;
};

// --- Spawn params (full input for spawn action) ------------------------------

export type SpawnTaskParams = {
  title: string;
  goal: string;
  instructions: string;
  context?: Record<string, unknown>;
  artifacts?: Attachment[];
  constraints?: Partial<TaskConstraints>;
  execution?: Partial<TaskExecution>;
  completionContract?: Partial<CompletionContract>;
  labels?: Record<string, string>;
};

// --- Budget usage tracking ---------------------------------------------------

export type BudgetUsage = {
  turnsUsed: number;
  tokensUsed: number;
  planSubmitted: boolean;
  budgetWarnings: Set<string>;
};

// --- Internal task record (not exposed to callers) ---------------------------

export type SubagentTask = {
  taskId: string;
  ownerId: string;
  title: string;
  goal: string;
  instructions: string;
  context: Record<string, unknown>;
  artifacts: Attachment[];
  constraints: TaskConstraints;
  execution: TaskExecution;
  completionContract: CompletionContract;
  labels: Record<string, string>;
  state: TaskState;
  turnOwnership: TurnOwnership;
  budgetUsage: BudgetUsage;
  nextSeq: number;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
  leaseExpiresAt: string | null;
  compactedSummary: string | null;
  availableTools: string[];

  // Runtime handles — not serialized
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  stallTimer: ReturnType<typeof setTimeout> | null;
  startedAtMs: number;
};

// --- Public snapshot (returned by inspect/list) ------------------------------

export type TaskSnapshot = {
  taskId: string;
  title: string;
  state: TaskState;
  turnOwnership: TurnOwnership;
  startedAt: string | null;
  updatedAt: string;
  lastEventId: string | null;
  lastHeartbeatAt: string | null;
  leaseExpiresAt: string | null;
  turnsUsed: number;
  tokensUsed: number;
  progress: ProgressInfo;
  compactedSummary: string | null;
  awaiting: {
    type: "supervisor" | "user" | null;
    question: string | null;
    deadlineAt: string | null;
  } | null;
  result: TaskResult | null;
  error: TaskError | null;
  labels: Record<string, string>;
  capabilities: {
    model: string;
    tools: string[];
    constraints: {
      maxTurns: number;
      timeBudgetSec: number;
      maxTotalTokens: number;
    };
  };
};

// --- Supervisor message (send action input) ----------------------------------

export type SupervisorMessage = {
  role: "supervisor";
  content: string;
  directiveType?: DirectiveType;
};

// --- Spawn response ----------------------------------------------------------

export type SpawnResponse = {
  taskId: string;
  state: "starting" | "running";
  cursor: string;
  leaseExpiresAt: string;
  startedAt: string;
};

// --- Recv response -----------------------------------------------------------

export type RecvResponse = {
  events: SubagentEvent[];
  cursors: Record<string, string>;
};

// --- Send response -----------------------------------------------------------

export type SendResponse = {
  taskId: string;
  accepted: boolean;
  state: TaskState;
  cursor: string;
};

// --- Cancel response ---------------------------------------------------------

export type CancelResponse = {
  taskId: string;
  state: "cancelled";
  finalEventId: string;
};

// --- List response -----------------------------------------------------------

export type ListTaskSummary = {
  taskId: string;
  title: string;
  state: TaskState;
  turnOwnership: TurnOwnership;
  progress: ProgressInfo;
  updatedAt: string;
};

// --- Await until conditions --------------------------------------------------

export type AwaitCondition =
  | "requires_response"
  | "terminal"
  | "any_event"
  | "progress";

// --- Worker interface (v1 abstraction) ---------------------------------------

export type SubagentWorker = {
  start(task: SubagentTask): Promise<void>;
  stop(taskId: string, reason: string): Promise<void>;
  send(taskId: string, message: SupervisorMessage): Promise<void>;
};

export const NO_OP_WORKER: SubagentWorker = {
  async start() {},
  async stop() {},
  async send() {}
};

// --- Manager config ----------------------------------------------------------

export type SubagentManagerConfig = {
  defaultModel: string;
  maxConcurrentTasks: number;
  defaultTimeBudgetSec: number;
  defaultMaxTurns: number;
  defaultMaxTotalTokens: number;
  defaultHeartbeatIntervalSec: number;
  defaultIdleTimeoutSec: number;
  defaultStallTimeoutSec: number;
  defaultRequirePlanByTurn: number;
  recvMaxEvents: number;
  recvDefaultWaitMs: number;
  awaitMaxTimeoutMs: number;
};
