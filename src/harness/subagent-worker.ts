// ──────────────────────────────────────────────────────────────────────────────
// SubagentWorker — drives LLM inference + tool execution for subagent tasks.
// ──────────────────────────────────────────────────────────────────────────────

import { runOpenAIToolLoop, ToolWorkflowAbortError } from "../agent/tool-loop.js";
import { extractAssistantText } from "../provider/response-text.js";
import { createResponsesRequestWithRetry, type ProviderTransportDeps } from "../provider/responses-transport.js";
import { createSteerChannel, type SteerChannel } from "../steer-channel.js";
import { resolveModelReference } from "../model-catalog.js";
import { createTraceRootContext, type ObservabilitySink, type TraceContext } from "../observability.js";
import { ProviderError } from "../provider-error.js";
import type { Config, RuntimeLogger, OpenAIModelCatalogEntry } from "../runtime/contracts.js";
import type { ToolHarness } from "./index.js";
import type { SubagentManager } from "./subagent-manager.js";
import type {
  SubagentWorker,
  SubagentTask,
  SupervisorMessage,
  TaskResult
} from "./subagent-types.js";
import type { ProviderFunctionTool } from "./types.js";
import type { OpenAIInputMessage } from "../provider/openai-types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type SubagentWorkerDeps = {
  config: Config;
  harness: ToolHarness;
  manager: SubagentManager;
  logger: RuntimeLogger;
  observability?: ObservabilitySink;
  transportDeps?: ProviderTransportDeps;
};

type TaskRuntime = {
  abortController: AbortController;
  steerChannel: SteerChannel;
  loopPromise: Promise<void>;
  pausedResponseId: string | null;
  // Preserved across pause/resume
  task: SubagentTask;
  model: OpenAIModelCatalogEntry;
  scopedHarness: ToolHarness;
  trace: TraceContext;
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

// ── Scoped harness ───────────────────────────────────────────────────────────

const EXCLUDED_TOOLS = new Set(["subagents"]);

function createScopedHarness(
  parent: ToolHarness,
  taskId: string
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
    return parent.executeWithOwner(taskId, name, args, trace, signal);
  };

  return {
    config: parent.config,
    context: {
      ...parent.context,
      subagentManager: undefined,
      ownerId: taskId
    },
    registry: parent.registry,
    metrics: parent.metrics,
    execute: guardedExecute,
    executeWithOwner: (_ownerId, name, args, trace, signal) =>
      guardedExecute(name, args, trace, signal),
    exportProviderTools: () => filteredTools
  };
}

// ── System prompt construction ───────────────────────────────────────────────

function buildSystemInstructions(task: SubagentTask): string {
  const parts: string[] = [];

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

  parts.push("## Completion Protocol");
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

// ── Result construction ──────────────────────────────────────────────────────

function buildSuccessResult(reply: string): TaskResult {
  return {
    summary: reply,
    outcome: "success",
    confidence: 1.0,
    deliverables: [],
    evidence: [],
    openIssues: [],
    recommendedNextSteps: []
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createSubagentWorker(deps: SubagentWorkerDeps): SubagentWorker {
  const { config, harness, manager, logger, observability, transportDeps } = deps;
  const activeTasks = new Map<string, TaskRuntime>();

  const requestFactory = createResponsesRequestWithRetry(config, logger, {
    fetchImpl: transportDeps?.fetchImpl,
    sleepImpl: transportDeps?.sleepImpl,
    randomImpl: transportDeps?.randomImpl,
    nowMsImpl: transportDeps?.nowMsImpl,
    observability
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
      const result = await requestFactory(
        body,
        runtime.task.taskId,
        {
          trace: runtime.trace,
          abortSignal: runtime.abortController.signal
        }
      );
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

  /** Handle a tool loop result — classify and push appropriate event. Returns true if paused. */
  function handleReply(taskId: string, reply: string, responseId: string | undefined, runtime: TaskRuntime): boolean {
    const classification = classifyReply(reply);
    const cleanReply = stripMarker(reply);

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
      // Store response ID for resume — do NOT remove from activeTasks
      runtime.pausedResponseId = responseId ?? null;
      return true; // paused
    }

    // Complete
    try {
      manager.pushWorkerEvent(taskId, "result", {
        message: cleanReply,
        result: buildSuccessResult(cleanReply)
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
          manager.pushWorkerEvent(taskId, "error", {
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
    initialInput: OpenAIInputMessage[],
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

      const { reply, finalResponse } = await runOpenAIToolLoop({
        request: wrappedRequest,
        model: model.id,
        instructions,
        initialInput,
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

      const paused = handleReply(taskId, reply, finalResponse.id, runtime);
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
    const scopedHarness = createScopedHarness(harness, taskId);
    const trace = createTraceRootContext("subagent");

    // Register available tools on the task
    const toolNames = scopedHarness.exportProviderTools().map((t) => t.name);
    try { manager.setTaskTools(taskId, toolNames); } catch { /* ignore if not supported */ }

    const runtime: TaskRuntime = {
      abortController,
      steerChannel,
      loopPromise: Promise.resolve(),
      pausedResponseId: null,
      task,
      model,
      scopedHarness,
      trace
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
    runtime.pausedResponseId = null;

    await executeLoop(
      runtime,
      [{ type: "message", role: "user", content: supervisorMessage }],
      previousResponseId
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
