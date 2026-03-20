import { setTimeout as sleep } from "node:timers/promises";
import { normalizeToolFailureOutput, normalizeToolSuccessOutput } from "./model-tool-output.js";
import type { ToolHarness } from "../harness/index.js";
import { asRecord, normalizeNonEmptyString } from "../utils.js";
import { stableStringify } from "../harness/arg-normalizer.js";
import { createToolErrorPayload, ToolExecutionError, toToolErrorPayload } from "../harness/errors.js";
import { createChildTraceContext, type TraceContext } from "../observability.js";
import type {
  ThinkingEffort,
  ToolCallReport,
  ToolErrorPayload,
  ToolProgressEvent,
  ToolWorkflowState
} from "../types.js";
import type { SteerChannel } from "../steer-channel.js";
import type {
  OpenAIFunctionCallOutput,
  OpenAIInputMessage,
  OpenAIResponsesOutputItem,
  OpenAIResponsesRequestBody,
  OpenAIResponsesResponse
} from "../provider/openai-types.js";

type FunctionCall = {
  callId: string;
  name: string;
  args: unknown;
};

type PollGuardState = {
  attempts: number;
  lastFingerprint: string;
  lastChangeAtMs: number;
};

export class ToolWorkflowAbortError extends Error {
  public readonly payload: ToolErrorPayload;

  public constructor(payload: ToolErrorPayload) {
    super(payload.error);
    this.name = "ToolWorkflowAbortError";
    this.payload = payload;
  }
}

function extractFunctionCalls(
  outputItems: OpenAIResponsesOutputItem[],
  onSkipped?: (reason: string) => void
): FunctionCall[] {
  const calls: FunctionCall[] = [];

  for (const item of outputItems) {
    if (item.type !== "function_call") {
      continue;
    }

    const callId = item.call_id ?? item.id;
    if (!callId) {
      onSkipped?.("function_call item missing call_id");
      continue;
    }

    if (!item.name) {
      onSkipped?.(`function_call item missing name (call_id=${callId})`);
      continue;
    }

    let parsedArgs: unknown = {};
    if (typeof item.arguments === "string" && item.arguments.trim().length > 0) {
      try {
        parsedArgs = JSON.parse(item.arguments);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onSkipped?.(`invalid arguments JSON for ${item.name}: ${message}`);
        continue;
      }
    }

    calls.push({
      callId,
      name: item.name,
      args: parsedArgs
    });
  }

  return calls;
}

function createWorkflowAbortError(
  errorCode: "WORKFLOW_TIMEOUT" | "WORKFLOW_INTERRUPTED" | "TOOL_LOOP_BREAKER",
  message: string,
  hints: string[] = []
): ToolWorkflowAbortError {
  return new ToolWorkflowAbortError(
    createToolErrorPayload({
      error: message,
      errorCode,
      retryable: false,
      hints
    })
  );
}

function extractProcessPollFingerprint(tool: string, args: unknown, result: unknown): string | null {
  if (tool !== "process") {
    return null;
  }

  const action = normalizeNonEmptyString(asRecord(args).action)?.toLowerCase();
  if (action !== "poll" && action !== "log") {
    return null;
  }

  const record = asRecord(result);
  if (record.status === "completed") {
    return null;
  }

  if (action === "poll") {
    const stdout = typeof record.stdout === "string" ? record.stdout : "";
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    const combined = typeof record.combined === "string" ? record.combined : "";
    return [stdout, stderr, combined].join("\n");
  }

  return typeof record.combined === "string" ? record.combined : "";
}

function extractProcessSessionId(args: unknown): string | null {
  return normalizeNonEmptyString(asRecord(args).sessionId);
}

function buildFunctionCallOutput(result: unknown): string {
  return JSON.stringify(result);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error
): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(onTimeout());
        }, Math.max(1, timeoutMs));
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function runOpenAIToolLoop(params: {
  request: (body: OpenAIResponsesRequestBody) => Promise<OpenAIResponsesResponse>;
  model: string;
  instructions: string;
  initialInput: OpenAIInputMessage[];
  thinkingEffort: ThinkingEffort;
  compactionTokens: number | null;
  compactionThreshold: number;
  promptCacheKey: string;
  promptCacheRetention: "in_memory" | "24h";
  harness: ToolHarness;
  maxSteps: number | null;
  extractAssistantText: (response: OpenAIResponsesResponse) => string;
  trace: TraceContext;
  abortSignal?: AbortSignal;
  steerChannel?: SteerChannel;
  onToolCall?: (event: ToolCallReport) => void | Promise<void>;
  onToolProgress?: (event: ToolProgressEvent) => void | Promise<void>;
  onResponse?: (response: OpenAIResponsesResponse) => void | Promise<void>;
  limits: {
    workflowTimeoutMs: number;
    commandTimeoutMs: number;
    pollIntervalMs: number;
    pollMaxAttempts: number;
    idleOutputThresholdMs: number;
    heartbeatIntervalMs: number;
    cleanupGraceMs: number;
    failureBreakerThreshold: number;
  };
}): Promise<{
  reply: string;
  finalResponse: OpenAIResponsesResponse;
}> {
  const tools = params.harness.exportProviderTools();
  const workflowStartedAtMs = Date.now();

  let previousResponseId: string | null = null;
  let input: Array<OpenAIInputMessage | OpenAIFunctionCallOutput> = [...params.initialInput];
  let steps = 0;
  let succeeded = false;
  let terminalError: ToolErrorPayload | null = null;

  const processPollGuard = new Map<string, PollGuardState>();
  const failureSignatures = new Map<string, number>();
  const workflowSessionIds = new Set<string>();

  params.harness.metrics.workflowsStarted += 1;

  const elapsedMs = (): number => Date.now() - workflowStartedAtMs;

  const reportToolCall = async (event: ToolCallReport): Promise<void> => {
    if (!params.onToolCall) {
      return;
    }

    try {
      await params.onToolCall(event);
    } catch {
      // Ignore callback failures so tool-loop behavior stays unchanged.
    }
  };

  const reportResponse = async (response: OpenAIResponsesResponse): Promise<void> => {
    if (!params.onResponse) {
      return;
    }

    try {
      await params.onResponse(response);
    } catch {
      // Ignore callback failures so tool-loop behavior stays unchanged.
    }
  };

  const reportProgress = async (event: Omit<ToolProgressEvent, "elapsedMs">): Promise<void> => {
    if (!params.onToolProgress) {
      return;
    }

    try {
      await params.onToolProgress({
        ...event,
        elapsedMs: elapsedMs()
      });
    } catch {
      // Ignore callback failures so tool-loop behavior stays unchanged.
    }
  };

  const transitionState = async (next: ToolWorkflowState, message: string): Promise<void> => {
    await reportProgress({
      type: "state",
      state: next,
      message
    });
  };

  const assertWorkflowActive = (): void => {
    if (params.abortSignal?.aborted) {
      throw createWorkflowAbortError(
        "WORKFLOW_INTERRUPTED",
        "Tool workflow interrupted by a newer user message",
        ["stop current tool loop and continue with the newest user message"]
      );
    }

    if (elapsedMs() > params.limits.workflowTimeoutMs) {
      throw createWorkflowAbortError(
        "WORKFLOW_TIMEOUT",
        `Tool workflow timed out after ${params.limits.workflowTimeoutMs}ms`,
        ["reduce tool steps or increase runtime.tool_workflow_timeout_ms"]
      );
    }
  };

  await transitionState("INIT", "tool workflow initialized");
  await transitionState("RUNNING", "tool workflow running");

  const contextManagement =
    params.compactionTokens !== null
      ? [{ type: "compaction" as const, compact_threshold: Math.floor(params.compactionTokens * params.compactionThreshold) }]
      : undefined;

  const heartbeatHandle = setInterval(() => {
    void reportProgress({
      type: "heartbeat",
      message: `tool workflow still running (${Math.floor(elapsedMs() / 1000)}s elapsed)`
    });
  }, Math.max(1, params.limits.heartbeatIntervalMs));

  try {
    while (true) {
      assertWorkflowActive();

      if (params.maxSteps !== null && steps >= params.maxSteps) {
        throw createWorkflowAbortError(
          "TOOL_LOOP_BREAKER",
          `Tool loop exceeded TOOL_LOOP_MAX_STEPS (${params.maxSteps})`,
          ["reduce repeated tool calls or increase runtime.tool_loop_max_steps"]
        );
      }

      const body: OpenAIResponsesRequestBody =
        previousResponseId === null
          ? {
              model: params.model,
              instructions: params.instructions,
              reasoning: {
                effort: params.thinkingEffort
              },
              prompt_cache_key: params.promptCacheKey,
              prompt_cache_retention: params.promptCacheRetention,
              input,
              tools,
              ...(contextManagement && { context_management: contextManagement })
            }
          : {
              model: params.model,
              previous_response_id: previousResponseId,
              reasoning: {
                effort: params.thinkingEffort
              },
              prompt_cache_key: params.promptCacheKey,
              prompt_cache_retention: params.promptCacheRetention,
              input,
              tools,
              ...(contextManagement && { context_management: contextManagement })
            };

      await reportProgress({
        type: "step",
        message: `tool-loop step ${steps + 1}: requesting model response`,
        step: steps + 1
      });

      const response = await params.request(body);
      await reportResponse(response);
      assertWorkflowActive();

      const calls = extractFunctionCalls(response.output ?? [], (reason) => {
        void reportProgress({
          type: "tool",
          message: `skipped malformed function call: ${reason}`,
          tool: "unknown"
        });
      });

      if (calls.length === 0) {
        params.harness.metrics.workflowsSucceeded += 1;
        await transitionState("SUCCEEDED", "tool workflow completed successfully");
        succeeded = true;
        return {
          reply: params.extractAssistantText(response),
          finalResponse: response
        };
      }

      if (!response.id) {
        throw new Error("Provider response missing id for tool continuation");
      }

      const outputs: OpenAIFunctionCallOutput[] = [];
      for (const call of calls) {
        assertWorkflowActive();
        const toolTrace = createChildTraceContext(params.trace, "tool");
        await reportProgress({
          type: "tool",
          message: `running tool '${call.name}'`,
          tool: call.name
        });

        try {
          const result = await withTimeout(
            params.harness.execute(call.name, call.args, toolTrace, params.abortSignal),
            params.limits.commandTimeoutMs,
            () =>
              new ToolExecutionError(
                createToolErrorPayload({
                  error: `Tool '${call.name}' timed out after ${params.limits.commandTimeoutMs}ms`,
                  errorCode: "TOOL_TIMEOUT",
                  retryable: true,
                  hints: ["reduce tool workload or increase runtime.tool_command_timeout_ms"]
                })
              )
          );

          if (call.name === "bash") {
            const record = asRecord(result);
            if (record.status === "running" && typeof record.sessionId === "string" && record.sessionId.length > 0) {
              workflowSessionIds.add(record.sessionId);
              await reportProgress({
                type: "tool",
                message: `background session acquired: ${record.sessionId}`,
                tool: call.name,
                sessionId: record.sessionId
              });
            }
          }

          if (call.name === "process") {
            const action = normalizeNonEmptyString(asRecord(call.args).action)?.toLowerCase();
            const sessionId = extractProcessSessionId(call.args);
            const fingerprint = extractProcessPollFingerprint(call.name, call.args, result);
            if (action && sessionId && (action === "poll" || action === "log")) {
              const key = `${action}:${sessionId}`;

              if (fingerprint === null) {
                processPollGuard.delete(key);
              } else {
                const now = Date.now();
                const prior = processPollGuard.get(key);
                if (!prior) {
                  processPollGuard.set(key, {
                    attempts: 1,
                    lastFingerprint: fingerprint,
                    lastChangeAtMs: now
                  });
                } else {
                  if (fingerprint !== prior.lastFingerprint && fingerprint.length > 0) {
                    prior.attempts = 1;
                    prior.lastFingerprint = fingerprint;
                    prior.lastChangeAtMs = now;
                  } else {
                    prior.attempts += 1;
                  }

                  if (prior.attempts > params.limits.pollMaxAttempts) {
                    throw createWorkflowAbortError(
                      "TOOL_LOOP_BREAKER",
                      `Process ${action} exceeded max attempts (${params.limits.pollMaxAttempts}) for session ${sessionId}`,
                      ["use bounded polling and stop once output is unchanged"]
                    );
                  }

                  if (now - prior.lastChangeAtMs >= params.limits.idleOutputThresholdMs) {
                    throw createWorkflowAbortError(
                      "TOOL_LOOP_BREAKER",
                      `Process ${action} detected idle output for ${params.limits.idleOutputThresholdMs}ms on session ${sessionId}`,
                      ["stop polling unchanged output and proceed to cleanup or next step"]
                    );
                  }
                }

                const guardState = processPollGuard.get(key);
                if (guardState) {
                  await reportProgress({
                    type: "poll",
                    message: `process.${action} poll attempt ${guardState.attempts}/${params.limits.pollMaxAttempts}`,
                    attempt: guardState.attempts,
                    maxAttempts: params.limits.pollMaxAttempts,
                    sessionId,
                    tool: call.name
                  });
                }

                await sleep(Math.max(1, params.limits.pollIntervalMs));
              }
            }
          }

          const normalizedSuccess = normalizeToolSuccessOutput({
            tool: call.name,
            args: call.args,
            result
          });

          await reportToolCall({
            tool: call.name,
            args: call.args,
            result,
            success: normalizedSuccess.report.success,
            error: normalizedSuccess.report.error,
            errorCode: normalizedSuccess.report.errorCode
          });
          outputs.push({
            type: "function_call_output",
            call_id: call.callId,
            output: buildFunctionCallOutput(normalizedSuccess.envelope)
          });
        } catch (error) {
          if (error instanceof ToolWorkflowAbortError) {
            throw error;
          }

          const payload = toToolErrorPayload(error);
          const normalizedFailure = normalizeToolFailureOutput({
            tool: call.name,
            payload
          });
          await reportToolCall({
            tool: call.name,
            args: call.args,
            result: payload,
            success: normalizedFailure.report.success,
            error: normalizedFailure.report.error,
            errorCode: normalizedFailure.report.errorCode
          });
          outputs.push({
            type: "function_call_output",
            call_id: call.callId,
            output: buildFunctionCallOutput(normalizedFailure.envelope)
          });

          const signature = `${call.name}|${stableStringify(call.args)}|${payload.errorCode}`;
          const failureCount = (failureSignatures.get(signature) ?? 0) + 1;
          failureSignatures.set(signature, failureCount);

          if (failureCount >= params.limits.failureBreakerThreshold) {
            throw createWorkflowAbortError(
              "TOOL_LOOP_BREAKER",
              `Detected repeated tool failure (${failureCount}x): ${call.name} (${payload.errorCode})`,
              ["adjust tool arguments based on error hints before retrying"]
            );
          }
        }
      }

      previousResponseId = response.id;
      input = outputs;

      if (params.steerChannel) {
        const steers = params.steerChannel.drain();
        for (const steerMessage of steers) {
          input.push({
            type: "message",
            role: "user",
            content: steerMessage
          } as OpenAIInputMessage);

          await reportProgress({
            type: "steer",
            message: steerMessage
          });
        }
      }

      steps += 1;
    }
  } catch (error) {
    if (error instanceof ToolWorkflowAbortError) {
      terminalError = error.payload;
      switch (error.payload.errorCode) {
        case "WORKFLOW_INTERRUPTED":
          params.harness.metrics.workflowsInterrupted += 1;
          await transitionState("INTERRUPTED", error.payload.error);
          break;
        case "WORKFLOW_TIMEOUT":
          params.harness.metrics.workflowsTimedOut += 1;
          await transitionState("TIMED_OUT", error.payload.error);
          break;
        case "TOOL_LOOP_BREAKER":
          params.harness.metrics.workflowLoopBreakerTrips += 1;
          params.harness.metrics.workflowsFailed += 1;
          await transitionState("FAILED", error.payload.error);
          break;
        default:
          params.harness.metrics.workflowsFailed += 1;
          await transitionState("FAILED", error.payload.error);
          break;
      }

      throw error;
    }

    if (error instanceof ToolExecutionError) {
      terminalError = error.payload;
      if (error.payload.errorCode === "TOOL_LOOP_BREAKER") {
        params.harness.metrics.workflowLoopBreakerTrips += 1;
      }
      params.harness.metrics.workflowsFailed += 1;
      await transitionState("FAILED", error.payload.error);
      throw new ToolWorkflowAbortError(error.payload);
    }

    const message = error instanceof Error ? error.message : String(error);
    params.harness.metrics.workflowsFailed += 1;
    await transitionState("FAILED", message);
    throw error;
  } finally {
    clearInterval(heartbeatHandle);

    if (!succeeded) {
      await transitionState("CLEANUP", "running workflow cleanup");
      for (const sessionId of workflowSessionIds) {
        try {
          const termination = await params.harness.context.processManager.terminateSession(
            sessionId,
            {
              graceMs: params.limits.cleanupGraceMs,
              forceSignal: "SIGKILL",
              removeAfterTerminate: true
            }
          );

          await reportProgress({
            type: "cleanup",
            message: `cleanup ${termination.status}: session ${sessionId} (forced=${termination.forced ? "yes" : "no"})`,
            sessionId
          });
        } catch (error) {
          params.harness.metrics.workflowsCleanupErrors += 1;
          const cleanupPayload = createToolErrorPayload({
            error: `Cleanup failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            errorCode: "CLEANUP_ERROR",
            retryable: false,
            hints: ["verify process session ownership and state before cleanup"]
          });
          await reportProgress({
            type: "cleanup",
            message: cleanupPayload.error,
            sessionId,
            errorCode: cleanupPayload.errorCode
          });

          if (!terminalError) {
            terminalError = cleanupPayload;
          }
        }
      }
    }

    await transitionState("DONE", "tool workflow finished");
  }
}
