import { runOpenAIToolLoop, ToolWorkflowAbortError } from "./agent/tool-loop.js";
import { createToolHarness, type ToolHarness } from "./harness/index.js";
import { createChildTraceContext, createTraceRootContext } from "./observability.js";
import type { RuntimeLogger, Config } from "./runtime/contracts.js";
import type { ObservabilitySink } from "./observability.js";
import { ProviderError } from "./provider-error.js";
import type { Provider, ProviderRequest } from "./types.js";
import { normalizeHistory } from "./provider/history.js";
import { extractAssistantText } from "./provider/response-text.js";
import { createResponsesRequestWithRetry, type ProviderTransportDeps } from "./provider/responses-transport.js";
import { accumulateUsageSnapshot, createEmptyUsageSnapshot } from "./provider/usage.js";

type ProviderRuntimeDeps = ProviderTransportDeps & {
  harness?: ToolHarness;
  observability?: ObservabilitySink;
};

export function createOpenAIProvider(
  config: Config,
  logger: RuntimeLogger,
  deps: ProviderRuntimeDeps = {}
): Provider {
  const harness =
    deps.harness ??
    createToolHarness({
      defaultCwd: config.tools.defaultCwd,
      defaultShell: config.tools.defaultShell,
      execTimeoutMs: config.tools.execTimeoutMs,
      execYieldMs: config.tools.execYieldMs,
      processLogTailLines: config.tools.processLogTailLines,
      logPath: config.tools.logPath,
      completedSessionRetentionMs: config.tools.completedSessionRetentionMs,
      maxCompletedSessions: config.tools.maxCompletedSessions,
      maxOutputChars: config.tools.maxOutputChars,
      webSearch: config.tools.webSearch
    }, {
      observability: deps.observability
    });

  const requestWithRetry = createResponsesRequestWithRetry(config, logger, {
    fetchImpl: deps.fetchImpl,
    sleepImpl: deps.sleepImpl,
    randomImpl: deps.randomImpl,
    nowMsImpl: deps.nowMsImpl,
    observability: deps.observability
  });

  const buildPromptCacheKey = (request: ProviderRequest): string => {
    return `acmd:${request.chatId}:${request.conversationId}`;
  };

  return {
    async generateReply(input: ProviderRequest): Promise<string> {
      const messages = normalizeHistory(input.history);
      const maxAttempts = 1 + config.openai.maxRetries;
      let lastAttempt = 1;
      const providerTrace = input.trace ? createChildTraceContext(input.trace, "provider") : createTraceRootContext("provider");

      try {
        let usageSnapshot = createEmptyUsageSnapshot();
        const scopedHarness: ToolHarness = {
          ...harness,
          execute: (name, args, trace) => harness.executeWithOwner(input.chatId, name, args, trace)
        };

        const result = await runOpenAIToolLoop({
          request: async (body) => {
            if (input.abortSignal?.aborted) {
              throw new ToolWorkflowAbortError({
                ok: false,
                error: "Tool workflow interrupted by a newer user message",
                errorCode: "WORKFLOW_INTERRUPTED",
                retryable: false,
                hints: ["continue with the latest message"]
              });
            }

            try {
              const result = await requestWithRetry(body, input.chatId, {
                onTextDelta: input.onTextDelta,
                trace: providerTrace,
                messageId: input.messageId,
                abortSignal: input.abortSignal
              });
              lastAttempt = result.attempt;
              return result.payload;
            } catch (error) {
              if (input.abortSignal?.aborted) {
                throw new ToolWorkflowAbortError({
                  ok: false,
                  error: "Tool workflow interrupted by a newer user message",
                  errorCode: "WORKFLOW_INTERRUPTED",
                  retryable: false,
                  hints: ["continue with the latest message"]
                });
              }

              throw error;
            }
          },
          model: input.model,
          instructions: input.instructions,
          initialInput: messages,
          thinkingEffort: input.thinkingEffort,
          compactionTokens: input.compactionTokens,
          compactionThreshold: input.compactionThreshold,
          promptCacheKey: buildPromptCacheKey(input),
          promptCacheRetention: "in_memory",
          harness: scopedHarness,
          maxSteps: config.runtime.toolLoopMaxSteps,
          extractAssistantText,
          trace: providerTrace,
          abortSignal: input.abortSignal,
          onToolCall: input.onToolCall,
          onToolProgress: async (event) => {
            await deps.observability?.record({
              event: "tool.workflow.progress",
              trace: createChildTraceContext(providerTrace, "tool"),
              stage: "completed",
              chatId: input.chatId,
              messageId: input.messageId,
              conversationId: input.conversationId,
              progress: event
            });
            await input.onToolProgress?.(event);
          },
          onResponse: (response) => {
            usageSnapshot = accumulateUsageSnapshot(usageSnapshot, response);
          },
          limits: {
            workflowTimeoutMs: config.runtime.toolWorkflowTimeoutMs,
            commandTimeoutMs: config.runtime.toolCommandTimeoutMs,
            pollIntervalMs: config.runtime.toolPollIntervalMs,
            pollMaxAttempts: config.runtime.toolPollMaxAttempts,
            idleOutputThresholdMs: config.runtime.toolIdleOutputThresholdMs,
            heartbeatIntervalMs: config.runtime.toolHeartbeatIntervalMs,
            cleanupGraceMs: config.runtime.toolCleanupGraceMs,
            failureBreakerThreshold: config.runtime.toolFailureBreakerThreshold
          }
        });

        try {
          await input.onUsage?.(usageSnapshot);
        } catch {
          // Ignore usage callback failures so user replies are not impacted.
        }

        logger.debug(
          `provider: generated reply for chat ${input.chatId} conversation=${input.conversationId} (attempt ${lastAttempt}/${maxAttempts})`
        );

        return result.reply;
      } catch (error) {
        if (error instanceof ToolWorkflowAbortError) {
          throw error;
        }

        if (error instanceof ProviderError) {
          throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new ProviderError({
          message,
          kind: "unknown",
          statusCode: null,
          attempts: 1,
          retryable: false,
          cause: error
        });
      }
    }
  };
}
