import type { ZodTypeAny, z } from "zod";
import type { ObservabilitySink, TraceContext } from "../observability.js";
import type { ToolErrorCode } from "../types.js";
import type { ToolCallLogger } from "./logger.js";
import type { ProcessManager } from "./process-manager.js";
import type { SubagentManager } from "./subagent-manager.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = {
  [key: string]: JsonValue;
};

export type HarnessConfig = {
  defaultCwd: string;
  defaultShell: string;
  execTimeoutMs: number;
  execYieldMs: number;
  processLogTailLines: number;
  logPath: string;
  completedSessionRetentionMs: number;
  maxCompletedSessions: number;
  maxOutputChars: number;
  webSearch?: {
    apiKey: string | null;
    defaultPreset: string;
    presets: import("../web-search-catalog.js").WebSearchModelCatalogEntry[];
  };
  subagents?: {
    enabled: boolean;
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
};

export type ToolContext = {
  config: HarnessConfig;
  processManager: ProcessManager;
  logger: ToolCallLogger;
  metrics: ToolRuntimeMetrics;
  ownerId: string | null;
  trace?: TraceContext;
  observability?: ObservabilitySink;
  abortSignal?: AbortSignal;
  subagentManager?: SubagentManager;
};

export type ToolDef<TSchema extends ZodTypeAny = ZodTypeAny> = {
  name: string;
  description: string;
  schema: TSchema;
  run: (ctx: ToolContext, input: z.infer<TSchema>) => Promise<JsonValue>;
};

export type ProviderFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: JsonObject;
};

export type ToolLogEntry = {
  timestamp: string;
  startedAt: string;
  finishedAt: string;
  tool: string;
  args: unknown;
  success: boolean;
  error: string | null;
  errorCode?: ToolErrorCode | null;
};

export type ToolRuntimeMetrics = {
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

export type ProcessStatus = "running" | "completed";

export type ManagedSessionView = {
  sessionId: string;
  ownerId: string;
  pid: number | null;
  command: string;
  cwd: string;
  shell: string;
  status: ProcessStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncatedStdoutChars: number;
  truncatedStderrChars: number;
  truncatedCombinedChars: number;
};

export type PollOutput = {
  status: ProcessStatus;
  sessionId: string;
  stdout: string;
  stderr: string;
  combined: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  truncatedStdoutChars: number;
  truncatedStderrChars: number;
  truncatedCombinedChars: number;
};

export type LogOutput = {
  status: ProcessStatus;
  sessionId: string;
  combined: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  truncatedCombinedChars: number;
};

export type CompletedExecOutput = {
  status: "completed";
  sessionId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  combined: string;
  durationMs: number;
  truncatedStdoutChars: number;
  truncatedStderrChars: number;
  truncatedCombinedChars: number;
};

export type RunningExecOutput = {
  status: "running";
  sessionId: string;
  pid: number | null;
  tail: string;
};

export type ExecOutput = CompletedExecOutput | RunningExecOutput;

export type ProcessManagerHealth = {
  totalSessions: number;
  runningSessions: number;
  completedSessions: number;
  truncatedStdoutChars: number;
  truncatedStderrChars: number;
  truncatedCombinedChars: number;
};

export type TerminateSessionResult = {
  ok: true;
  sessionId: string;
  status: ProcessStatus;
  alreadyCompleted: boolean;
  forced: boolean;
  signalSent: NodeJS.Signals | null;
  removed: boolean;
};
