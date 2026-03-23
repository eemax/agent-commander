import type { ToolHarness } from "./harness/index.js";
import type { RuntimeLogger, Config, StateStore, WorkspaceCatalog } from "./runtime/contracts.js";
import { createChildTraceContext, createTraceRootContext, type ObservabilitySink, type TraceContext } from "./observability.js";
import { parseTelegramCommand } from "./telegram/commands.js";
import type {
  MessageRouteResult,
  NormalizedTelegramCallbackQuery,
  MessageStreamingSink,
  NormalizedTelegramMessage,
  Provider,
  TelegramCommandDefinition,
  ContentPart
} from "./types.js";
import { createAssistantTurnHandler } from "./routing/assistant-turn.js";
import { createCoreCommandHandler } from "./routing/core-commands.js";
import { runMessageGatekeeping } from "./routing/gatekeeping.js";
import { TurnManager } from "./routing/turn-manager.js";

export type MessageRouter = {
  handleIncomingMessage(
    message: NormalizedTelegramMessage,
    stream?: MessageStreamingSink,
    trace?: TraceContext,
    userContent?: string | ContentPart[]
  ): Promise<MessageRouteResult>;
  handleIncomingCallbackQuery(query: NormalizedTelegramCallbackQuery, trace?: TraceContext): Promise<MessageRouteResult>;
};

export function createMessageRouter(params: {
  logger: RuntimeLogger;
  provider: Provider;
  config: Config;
  conversations: StateStore;
  workspace: WorkspaceCatalog;
  harness: ToolHarness;
  observability?: ObservabilitySink;
  onCommandCatalogChanged?: (commands: TelegramCommandDefinition[]) => Promise<void>;
}): MessageRouter {
  const { logger, provider, config, conversations, workspace, harness, observability, onCommandCatalogChanged } =
    params;
  const turns = new TurnManager();

  const runSingleTurn = async (
    message: NormalizedTelegramMessage,
    userContent: string | ContentPart[],
    oneShotSkill: Parameters<typeof handleAssistantTurn>[0]["oneShotSkill"],
    trace: TraceContext,
    stream?: MessageStreamingSink
  ): Promise<MessageRouteResult> => {
    const turn = turns.beginTurn(message.chatId, message.messageId);
    if (turn.interruptedPrevious) {
      await observability?.record({
        event: "routing.turn.interrupted",
        trace,
        stage: "completed",
        chatId: message.chatId,
        messageId: message.messageId,
        interruptedByMessageId: message.messageId
      });
    }

    let result: MessageRouteResult;
    try {
      result = await handleAssistantTurn({
        message,
        userContent,
        oneShotSkill,
        trace,
        abortSignal: turn.controller.signal,
        steerChannel: turn.steerChannel,
        interruptedPreviousTurn: turn.interruptedPrevious,
        onTextDelta: stream?.onTextDelta,
        onToolCallNotice: stream?.onToolCallNotice
      });
    } finally {
      turns.releaseTurn(message.chatId, turn.token);
    }

    if (!turns.isLatestTurn(message.chatId, turn.token)) {
      return { type: "ignore" };
    }

    await observability?.record({
      event: "routing.decision.made",
      trace,
      stage: "completed",
      chatId: message.chatId,
      messageId: message.messageId,
      decision: oneShotSkill ? "skill_command" : "assistant_turn",
      resultType: result.type,
      result
    });

    return result;
  };

  const processQueue = async (chatId: string): Promise<void> => {
    const queue = turns.getQueue(chatId);
    if (!queue || queue.length === 0) {
      turns.deleteQueue(chatId);
      return;
    }

    if (config.runtime.messageQueueMode === "batch") {
      const entries = queue.drain();
      turns.deleteQueue(chatId);
      const last = entries[entries.length - 1]!;
      const hasMultipart = entries.some((e) => Array.isArray(e.userContent));

      let combinedContent: string | ContentPart[];
      if (hasMultipart) {
        const parts: ContentPart[] = [];
        for (const e of entries) {
          const uc = e.userContent ?? e.message.text;
          if (typeof uc === "string") {
            if (uc.length > 0) parts.push({ type: "text", text: uc });
          } else {
            parts.push(...uc);
          }
        }
        combinedContent = parts;
      } else {
        combinedContent = entries.map((e) => (e.userContent as string | undefined) ?? e.message.text).join("\n\n");
      }

      await runSingleTurn(last.message, combinedContent, null, last.trace, last.stream);
    } else {
      const entry = queue.drainOne();
      if (queue.length === 0) {
        turns.deleteQueue(chatId);
      }
      if (!entry) {
        return;
      }

      await runSingleTurn(entry.message, entry.userContent ?? entry.message.text, null, entry.trace, entry.stream);
      await processQueue(chatId);
    }
  };

  const runTurnAndDrainQueue = async (
    message: NormalizedTelegramMessage,
    userContent: string | ContentPart[],
    oneShotSkill: Parameters<typeof handleAssistantTurn>[0]["oneShotSkill"],
    trace: TraceContext,
    stream?: MessageStreamingSink
  ): Promise<MessageRouteResult> => {
    const result = await runSingleTurn(message, userContent, oneShotSkill, trace, stream);
    void processQueue(message.chatId).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`routing: failed to process queued messages for chat=${message.chatId}: ${msg}`);
    });
    return result;
  };

  const handleAssistantTurn = createAssistantTurnHandler({
    logger,
    provider,
    config,
    conversations,
    workspace,
    harness
  });

  const coreCommands = createCoreCommandHandler({
    config,
    conversations,
    workspace,
    harness
  });

  return {
    async handleIncomingMessage(
      message: NormalizedTelegramMessage,
      stream?: MessageStreamingSink,
      trace?: TraceContext,
      resolvedUserContent?: string | ContentPart[]
    ): Promise<MessageRouteResult> {
      const inboundTrace = trace ?? createTraceRootContext("routing");
      const routingTrace = createChildTraceContext(inboundTrace, "routing");
      const gatekeepingResult = await runMessageGatekeeping({
        chatId: message.chatId,
        messageId: message.messageId,
        messageSenderId: message.senderId,
        logger,
        config,
        workspace,
        trace: routingTrace,
        observability,
        onCommandCatalogChanged
      });
      if (gatekeepingResult) {
        await observability?.record({
          event: "routing.decision.made",
          trace: routingTrace,
          stage: "completed",
          chatId: message.chatId,
          messageId: message.messageId,
          decision: "gatekeeping_blocked",
          resultType: gatekeepingResult.type,
          result: gatekeepingResult
        });
        return gatekeepingResult;
      }

      const parsedCommand = parseTelegramCommand(message.text);
      if (!parsedCommand) {
        const activeTurn = turns.getActiveTurn(message.chatId);
        if (activeTurn) {
          const queue = turns.getOrCreateQueue(message.chatId);
          const count = queue.push({ message, userContent: resolvedUserContent, stream, trace: routingTrace });

          await observability?.record({
            event: "routing.message.queued",
            trace: routingTrace,
            stage: "completed",
            chatId: message.chatId,
            messageId: message.messageId,
            pendingCount: count
          });

          return { type: "reply", text: `Message queued (${count} pending)` };
        }

        return await runTurnAndDrainQueue(message, resolvedUserContent ?? message.text, null, routingTrace, stream);
      }

      if (parsedCommand.command === "steer") {
        const activeTurn = turns.getActiveTurn(message.chatId);
        if (!activeTurn) {
          return { type: "reply", text: "No active turn to steer." };
        }

        const steerText = parsedCommand.args.trim();
        if (steerText.length === 0) {
          return { type: "reply", text: "Usage: /steer <message>" };
        }

        activeTurn.steerChannel.push(steerText);

        await observability?.record({
          event: "routing.steer.pushed",
          trace: routingTrace,
          stage: "completed",
          chatId: message.chatId,
          messageId: message.messageId,
          steerText
        });

        return {
          type: "reply",
          text: `Steer queued: ${steerText.slice(0, 100)}${steerText.length > 100 ? "..." : ""}`
        };
      }

      if (parsedCommand.command === "stop") {
        if (turns.abortActiveTurn(message.chatId)) {
          await observability?.record({
            event: "routing.turn.interrupted",
            trace: routingTrace,
            stage: "completed",
            chatId: message.chatId,
            messageId: message.messageId,
            interruptedByMessageId: message.messageId
          });
        }
        turns.deleteQueue(message.chatId);
      }

      const coreHandled = await coreCommands.handleCommand(
        parsedCommand.command,
        parsedCommand.args,
        message,
        routingTrace
      );
      if (coreHandled) {
        await observability?.record({
          event: "routing.decision.made",
          trace: routingTrace,
          stage: "completed",
          chatId: message.chatId,
          messageId: message.messageId,
          decision: "core_command",
          command: parsedCommand.command,
          args: parsedCommand.args,
          resultType: coreHandled.type,
          result: coreHandled
        });
        return coreHandled;
      }

      const skill = workspace.getSkillBySlug(parsedCommand.command);
      if (!skill) {
        const result: MessageRouteResult = {
          type: "reply",
          text: `Unknown command: /${parsedCommand.command}`
        };
        await observability?.record({
          event: "routing.decision.made",
          trace: routingTrace,
          stage: "completed",
          chatId: message.chatId,
          messageId: message.messageId,
          decision: "unknown_command",
          command: parsedCommand.command,
          resultType: result.type,
          result
        });
        return result;
      }

      let skillUserContent: string | ContentPart[];
      if (Array.isArray(resolvedUserContent)) {
        const textPart = parsedCommand.args.length > 0 ? parsedCommand.args : message.text;
        const nonTextParts = resolvedUserContent.filter((p) => p.type !== "text");
        const existingText = resolvedUserContent.filter((p) => p.type === "text");
        skillUserContent = [
          { type: "text" as const, text: textPart },
          ...existingText.filter((p) => p.text !== textPart),
          ...nonTextParts
        ];
      } else {
        skillUserContent = parsedCommand.args.length > 0 ? parsedCommand.args : message.text;
      }
      return await runTurnAndDrainQueue(message, skillUserContent, skill, routingTrace, stream);
    },

    async handleIncomingCallbackQuery(
      query: NormalizedTelegramCallbackQuery,
      trace?: TraceContext
    ): Promise<MessageRouteResult> {
      const inboundTrace = trace ?? createTraceRootContext("routing");
      const routingTrace = createChildTraceContext(inboundTrace, "routing");
      const gatekeepingResult = await runMessageGatekeeping({
        chatId: query.chatId,
        messageId: query.callbackQueryId,
        messageSenderId: query.senderId,
        logger,
        config,
        workspace,
        trace: routingTrace,
        observability,
        onCommandCatalogChanged
      });
      if (gatekeepingResult) {
        await observability?.record({
          event: "routing.decision.made",
          trace: routingTrace,
          stage: "completed",
          chatId: query.chatId,
          messageId: query.callbackQueryId,
          decision: "gatekeeping_blocked",
          resultType: gatekeepingResult.type,
          result: gatekeepingResult
        });
        return gatekeepingResult;
      }

      if (turns.abortActiveTurn(query.chatId)) {
        await observability?.record({
          event: "routing.turn.interrupted",
          trace: routingTrace,
          stage: "completed",
          chatId: query.chatId,
          messageId: query.callbackQueryId,
          interruptedByMessageId: query.callbackQueryId
        });
      }

      const coreHandled = await coreCommands.handleCallbackQuery(query, routingTrace);
      if (!coreHandled) {
        return { type: "ignore" };
      }

      await observability?.record({
        event: "routing.decision.made",
        trace: routingTrace,
        stage: "completed",
        chatId: query.chatId,
        messageId: query.callbackQueryId,
        decision: "core_callback",
        resultType: coreHandled.type,
        result: coreHandled
      });
      return coreHandled;
    }
  };
}
