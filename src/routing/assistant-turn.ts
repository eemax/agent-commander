import {
  buildConversationBootstrapInstructions,
  writeConversationContextSnapshot
} from "../context.js";
import { ToolWorkflowAbortError } from "../agent/tool-loop.js";
import type { ToolHarness } from "../harness/index.js";
import { resolveActiveModel } from "../model-catalog.js";
import { createChildTraceContext, type TraceContext } from "../observability.js";
import type { RuntimeLogger, StateStore, WorkspaceCatalog, Config } from "../runtime/contracts.js";
import { ProviderError } from "../provider-error.js";
import {
  formatSteerNotice,
  formatVerboseToolCallNotice,
  extractCountUpdate,
  formatCountModeBuffer,
  VERBOSE_REPLACE_PREFIX,
  type CountAccumulatorEntry
} from "./formatters.js";
import { buildProviderFallbackText } from "./provider-fallback.js";
import type { SteerChannel } from "../steer-channel.js";
import type { MessageRouteResult, NormalizedTelegramMessage, Provider, ContentPart } from "../types.js";

export type AssistantTurnHandlerInput = {
  message: NormalizedTelegramMessage;
  userContent: string | ContentPart[];
  trace: TraceContext;
  abortSignal?: AbortSignal;
  steerChannel?: SteerChannel;
  interruptedPreviousTurn?: boolean;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onToolCallNotice?: (notice: string) => void | Promise<void>;
  onLifecycleEvent?: (event: import("../types.js").ProviderLifecycleEvent) => void | Promise<void>;
};

function sanitizeLogToken(value: string | null | undefined): string {
  if (!value) {
    return "none";
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : "none";
}

function quoteLogReason(reason: string | null | undefined): string {
  if (!reason) {
    return "none";
  }

  const normalized = reason.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return "none";
  }

  const escaped = normalized.replace(/"/g, "\\\"");
  if (escaped.length <= 300) {
    return escaped;
  }

  return `${escaped.slice(0, 297)}...`;
}

export function createAssistantTurnHandler(params: {
  logger: RuntimeLogger;
  provider: Provider;
  config: Config;
  conversations: StateStore;
  workspace: WorkspaceCatalog;
  harness: ToolHarness;
}): (input: AssistantTurnHandlerInput) => Promise<MessageRouteResult> {
  const { logger, provider, config, conversations, workspace, harness } = params;

  return async (input: AssistantTurnHandlerInput): Promise<MessageRouteResult> => {
    const conversationId = await conversations.ensureActiveConversation(input.message.chatId);
    const runtimeProfile = await conversations.getConversationRuntimeProfile(input.message.chatId);
    if (!runtimeProfile) {
      throw new Error(`BUG: conversation runtime profile missing after ensureActiveConversation for chat=${input.message.chatId}`);
    }
    const { verboseMode, thinkingEffort, cacheRetention, transportMode, authMode, activeModelOverride } = runtimeProfile;
    const activeModel = resolveActiveModel({
      models: config.openai.models,
      defaultModelId: config.openai.model,
      overrideModelId: activeModelOverride
    });
    const verboseReplies: string[] = [];
    const toolCallAccumulator = new Map<string, CountAccumulatorEntry>();
    let countModeBufferIndex = -1;
    const turnStats = { toolResults: [] as Array<{ tool: string; success: boolean }>, compactionIncrements: 0 };

    if (input.interruptedPreviousTurn) {
      const note = "Interrupted previous in-progress run and handling your latest message.";
      if (!input.onTextDelta) {
        verboseReplies.push(`⚠️ ${note}`);
      }
      await input.onTextDelta?.(`${note}\n`);
    }

    const promptContext = await conversations.appendUserMessageAndGetPromptContext({
      chatId: input.message.chatId,
      conversationId,
      telegramMessageId: input.message.messageId,
      senderId: input.message.senderId,
      senderName: input.message.senderName,
      content: input.userContent,
      historyLimit: config.runtime.promptHistoryLimit,
      trace: createChildTraceContext(input.trace, "state")
    });

    const workspaceSnapshot = workspace.getSnapshot();
    const providerTools = harness.exportProviderTools();

    const instructions = buildConversationBootstrapInstructions({
      workspace: workspaceSnapshot
    });

    if (promptContext.promptCountBeforeAppend === 0) {
      await writeConversationContextSnapshot({
        contextSnapshotsDir: config.paths.contextSnapshotsDir,
        chatId: input.message.chatId,
        conversationId,
        workspace: workspaceSnapshot,
        harnessTools: providerTools,
        compiledInstructions: instructions
      });
    }

    try { // outer try/finally for turn stats flush
    try {
      const reply = await provider.generateReply({
        chatId: input.message.chatId,
        conversationId,
        messageId: input.message.messageId,
        model: activeModel.id,
        history: promptContext.historyAfterAppend,
        instructions,
        thinkingEffort,
        cacheRetention,
        transportMode,
        authMode,
        compactionTokens: activeModel.compactionTokens,
        compactionThreshold: activeModel.compactionThreshold,
        abortSignal: input.abortSignal,
        steerChannel: input.steerChannel,
        trace: createChildTraceContext(input.trace, "provider"),
        onTextDelta: input.onTextDelta,
        onLifecycleEvent: input.onLifecycleEvent,
        onToolCall: async (event) => {
          turnStats.toolResults.push({ tool: event.tool, success: event.success });
          if (verboseMode === "full") {
            const notice = formatVerboseToolCallNotice(event);
            if (input.onToolCallNotice) {
              await input.onToolCallNotice(notice);
            } else {
              verboseReplies.push(notice);
            }
          } else if (verboseMode === "count") {
            const update = extractCountUpdate(event);
            const existing = toolCallAccumulator.get(update.key);
            if (existing) {
              existing.count += 1;
              existing.chars += update.chars;
              if (!update.success) existing.failed += 1;
            } else {
              toolCallAccumulator.set(update.key, {
                emoji: update.emoji,
                label: update.label,
                count: 1,
                failed: update.success ? 0 : 1,
                chars: update.chars,
                trackChars: update.trackChars
              });
            }
            const buffer = formatCountModeBuffer(toolCallAccumulator);
            if (input.onToolCallNotice) {
              await input.onToolCallNotice(VERBOSE_REPLACE_PREFIX + buffer);
            } else {
              if (countModeBufferIndex >= 0) {
                verboseReplies[countModeBufferIndex] = buffer;
              } else {
                countModeBufferIndex = verboseReplies.length;
                verboseReplies.push(buffer);
              }
            }
          }
        },
        onToolProgress: async (event) => {
          if (event.type === "steer" && verboseMode !== "off") {
            const notice = formatSteerNotice(event.message);
            if (input.onToolCallNotice) {
              await input.onToolCallNotice(notice);
            } else {
              verboseReplies.push(notice);
            }
          } else if (event.type === "tool" && input.onToolCallNotice) {
            await input.onToolCallNotice("");
          }
        },
        onUsage: (usage) => conversations.setLatestUsageSnapshot(input.message.chatId, usage),
        onCompaction: async (count) => {
          turnStats.compactionIncrements += count;
          logger.info(`compaction detected: ${count} item(s) for chat=${input.message.chatId}`);
        }
      });

      if (reply.trim().length === 0) {
        logger.warn(
          `routing: provider returned empty text for chat=${input.message.chatId} conversation=${conversationId}`
        );
        return { type: "ignore" };
      }

      await conversations.appendAssistantMessage({
        chatId: input.message.chatId,
        conversationId,
        content: reply,
        trace: createChildTraceContext(input.trace, "state")
      });

      logger.info(
        `routing: replied to chat=${input.message.chatId} conversation=${conversationId} sender=${input.message.senderId} message=${input.message.messageId}`
      );
      return {
        type: "reply",
        text: reply,
        origin: "assistant",
        ...(verboseReplies.length > 0 ? { extraReplies: [...verboseReplies] } : {})
      };
    } catch (error) {
      if (error instanceof ToolWorkflowAbortError && error.payload.errorCode === "WORKFLOW_INTERRUPTED") {
        logger.info(
          `routing: interrupted stale turn chat=${input.message.chatId} conversation=${conversationId} message=${input.message.messageId}`
        );
        return { type: "ignore" };
      }

      if (!(error instanceof ProviderError)) {
        throw error;
      }

      await conversations.appendProviderFailure({
        chatId: input.message.chatId,
        conversationId,
        telegramMessageId: input.message.messageId,
        attempts: error.attempts,
        statusCode: error.statusCode,
        kind: error.kind,
        message: error.message,
        trace: createChildTraceContext(input.trace, "state")
      });

      await conversations.setLastProviderFailure(input.message.chatId, {
        at: new Date().toISOString(),
        kind: error.kind,
        statusCode: error.statusCode,
        attempts: error.attempts,
        reason: error.detail?.reason ?? error.message
      });

      const detail = error.detail;
      const reason = quoteLogReason(detail?.reason ?? error.message);

      logger.warn(
        `routing: provider failure chat=${input.message.chatId} conversation=${conversationId} message=${input.message.messageId} kind=${error.kind} status=${error.statusCode ?? "none"} attempts=${error.attempts} retryable=${error.retryable} reason="${reason}" openai_type=${sanitizeLogToken(detail?.openaiErrorType)} openai_code=${sanitizeLogToken(detail?.openaiErrorCode)} openai_param=${sanitizeLogToken(detail?.openaiErrorParam)} request_id=${sanitizeLogToken(detail?.requestId)}`
      );
      return {
        type: "fallback",
        text: buildProviderFallbackText({
          kind: error.kind,
          detail: error.detail,
          includeDetail: verboseMode !== "off"
        }),
        ...(verboseReplies.length > 0 ? { extraReplies: [...verboseReplies] } : {})
      };
    }
    } finally {
      await conversations.flushTurnStats(input.message.chatId, turnStats).catch((err) => {
        logger.warn(`routing: failed to flush turn stats for chat=${input.message.chatId}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  };
}
