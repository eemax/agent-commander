import {
  buildConversationBootstrapInstructions,
  buildSkillInvocationInstructions,
  writeConversationContextSnapshot
} from "../context.js";
import { ToolWorkflowAbortError } from "../agent/tool-loop.js";
import type { ToolHarness } from "../harness/index.js";
import { resolveActiveModel } from "../model-catalog.js";
import { createChildTraceContext, type TraceContext } from "../observability.js";
import type { RuntimeLogger, StateStore, WorkspaceCatalog, Config } from "../runtime/contracts.js";
import { ProviderError } from "../provider-error.js";
import { formatSteerNotice, formatToolProgressNotice, formatVerboseToolCallNotice } from "./formatters.js";
import type { SteerChannel } from "../steer-channel.js";
import type { MessageRouteResult, NormalizedTelegramMessage, Provider, SkillDefinition } from "../types.js";

export type AssistantTurnHandlerInput = {
  message: NormalizedTelegramMessage;
  userContent: string;
  oneShotSkill: SkillDefinition | null;
  trace: TraceContext;
  abortSignal?: AbortSignal;
  steerChannel?: SteerChannel;
  interruptedPreviousTurn?: boolean;
  onTextDelta?: (delta: string) => void | Promise<void>;
};

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
    const [verboseEnabled, thinkingEffort, activeModelOverride] = await Promise.all([
      conversations.getVerboseMode(input.message.chatId),
      conversations.getThinkingEffort(input.message.chatId),
      conversations.getActiveModelOverride(input.message.chatId)
    ]);
    const activeModel = resolveActiveModel({
      models: config.openai.models,
      defaultModelId: config.openai.model,
      overrideModelId: activeModelOverride
    });
    const verboseReplies: string[] = [];
    let lastHeartbeatPublishMs = 0;

    if (input.interruptedPreviousTurn) {
      const note = "Interrupted previous in-progress run and handling your latest message.";
      verboseReplies.push(`⚠️ ${note}`);
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

    let instructions = "";
    if (promptContext.promptCountBeforeAppend === 0) {
      instructions = buildConversationBootstrapInstructions({
        workspace: workspaceSnapshot
      });

      await writeConversationContextSnapshot({
        contextSnapshotsDir: config.paths.contextSnapshotsDir,
        chatId: input.message.chatId,
        conversationId,
        workspace: workspaceSnapshot,
        harnessTools: providerTools,
        compiledInstructions: instructions
      });
    }

    if (input.oneShotSkill) {
      instructions = buildSkillInvocationInstructions({
        skill: input.oneShotSkill,
        baseInstructions: instructions
      });
    }

    try {
      const reply = await provider.generateReply({
        chatId: input.message.chatId,
        conversationId,
        messageId: input.message.messageId,
        model: activeModel.id,
        history: promptContext.historyAfterAppend,
        instructions,
        thinkingEffort,
        compactionTokens: activeModel.compactionTokens,
        compactionThreshold: activeModel.compactionThreshold,
        abortSignal: input.abortSignal,
        steerChannel: input.steerChannel,
        trace: createChildTraceContext(input.trace, "provider"),
        onTextDelta: input.onTextDelta,
        onToolCall: async (event) => {
          await conversations.recordToolResult(input.message.chatId, {
            tool: event.tool,
            success: event.success
          });
          if (verboseEnabled) {
            verboseReplies.push(formatVerboseToolCallNotice(event));
          }
        },
        onToolProgress: async (event) => {
          if (event.type === "steer" && verboseEnabled) {
            verboseReplies.push(formatSteerNotice(event.message));
          }

          if (!config.observability.enabled) {
            return;
          }

          const now = Date.now();
          if (
            event.type === "heartbeat" &&
            now - lastHeartbeatPublishMs < Math.max(1, config.runtime.toolHeartbeatIntervalMs)
          ) {
            return;
          }
          if (event.type === "heartbeat") {
            lastHeartbeatPublishMs = now;
          }

          const line = formatToolProgressNotice(event);
          await input.onTextDelta?.(`${line}\n`);
        },
        onUsage: (usage) => conversations.setLatestUsageSnapshot(input.message.chatId, usage),
        onCompaction: async (count) => {
          for (let i = 0; i < count; i++) {
            await conversations.incrementCompactionCount(input.message.chatId);
          }
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

      logger.warn(
        `routing: provider failure chat=${input.message.chatId} conversation=${conversationId} message=${input.message.messageId} kind=${error.kind} status=${error.statusCode ?? "none"} attempts=${error.attempts}`
      );
      return {
        type: "fallback",
        text: "I hit a temporary provider error. Please try again in a moment.",
        ...(verboseReplies.length > 0 ? { extraReplies: [...verboseReplies] } : {})
      };
    }
  };
}
