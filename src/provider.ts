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
import { createWsTransportManager, type WsTransportManager } from "./provider/ws-transport.js";
import { accumulateUsageSnapshot, countCompactionItems, createEmptyUsageSnapshot } from "./provider/usage.js";
import { createSubagentWorker } from "./harness/subagent-worker.js";
import type { AuthModeRegistry } from "./provider/auth-mode-contracts.js";
import type { OwnerProviderSettings } from "./harness/subagent-worker.js";
import { createRequestExecutor } from "./provider/request-executor.js";

type ProviderRuntimeDeps = ProviderTransportDeps & {
  harness?: ToolHarness;
  observability?: ObservabilitySink;
  authModeRegistry: AuthModeRegistry;
  resolveOwnerProviderSettings?: (ownerId: string) => Promise<OwnerProviderSettings>;
};

function toSafeReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim();
  if (normalized.length <= 300) {
    return normalized;
  }
  return `${normalized.slice(0, 297)}...`;
}

export function createOpenAIProvider(
  config: Config,
  logger: RuntimeLogger,
  deps: ProviderRuntimeDeps
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
      webSearch: config.tools.webSearch,
      subagents: config.subagents
    }, {
      observability: deps.observability,
      subagentLogRedaction: config.observability.redaction
    });

  // Wire real subagent worker if the manager is available
  if (harness.context.subagentManager) {
    const defaultProviderSettings: OwnerProviderSettings = {
      authMode: config.openai.authMode,
      transportMode: config.openai.defaultTransport
    };
    const worker = createSubagentWorker({
      config,
      harness,
      manager: harness.context.subagentManager,
      logger,
      observability: deps.observability,
      subagentLog: harness.context.subagentLog,
      transportDeps: deps,
      authModeRegistry: deps.authModeRegistry,
      resolveOwnerProviderSettings: deps.resolveOwnerProviderSettings
        ?? (async () => defaultProviderSettings)
    });
    harness.context.subagentManager.setWorker(worker);
  }

  const requestWithRetry = createResponsesRequestWithRetry(config, logger, {
    fetchImpl: deps.fetchImpl,
    sleepImpl: deps.sleepImpl,
    randomImpl: deps.randomImpl,
    nowMsImpl: deps.nowMsImpl,
    observability: deps.observability
  });

  let wsManager: WsTransportManager | null = null;
  const getWsManager = (): WsTransportManager => {
    wsManager ??= createWsTransportManager(config, logger, {
      sleepImpl: deps.sleepImpl,
      randomImpl: deps.randomImpl,
      nowMsImpl: deps.nowMsImpl,
      observability: deps.observability
    });
    return wsManager;
  };

  const requestExecutor = createRequestExecutor(deps.authModeRegistry, {
    http: requestWithRetry,
    getWsManager
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
          execute: (name, args, trace, abortSignal) => harness.executeWithOwner(input.chatId, name, args, trace, abortSignal)
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
              const effectiveAuthMode = input.authMode ?? config.openai.authMode;
              const result = await requestExecutor.execute(body, {
                chatId: input.chatId,
                messageId: input.messageId,
                trace: providerTrace,
                abortSignal: input.abortSignal,
                authMode: effectiveAuthMode,
                transportMode: input.transportMode ?? config.openai.defaultTransport,
                onTextDelta: input.onTextDelta,
                onLifecycleEvent: input.onLifecycleEvent
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
          stateless: deps.authModeRegistry.get(input.authMode ?? config.openai.authMode).describe().capabilities.statelessToolLoop,
          thinkingEffort: input.thinkingEffort,
          compactionTokens: input.compactionTokens,
          compactionThreshold: input.compactionThreshold,
          promptCacheKey: buildPromptCacheKey(input),
          promptCacheRetention: input.cacheRetention ?? "in_memory",
          harness: scopedHarness,
          maxSteps: config.runtime.toolLoopMaxSteps,
          extractAssistantText,
          trace: providerTrace,
          abortSignal: input.abortSignal,
          steerChannel: input.steerChannel,
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
          onResponse: async (response) => {
            usageSnapshot = accumulateUsageSnapshot(usageSnapshot, response);
            const compactionItems = countCompactionItems(response.output ?? []);
            if (compactionItems > 0) {
              await input.onCompaction?.(compactionItems);
            }
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
          detail: {
            reason: toSafeReason(message),
            openaiErrorType: null,
            openaiErrorCode: null,
            openaiErrorParam: null,
            requestId: null,
            retryAfterMs: null,
            timedOutBy: null
          },
          cause: error
        });
      }
    }
  };
}
