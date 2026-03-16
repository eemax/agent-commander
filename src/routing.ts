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
  TelegramCommandDefinition
} from "./types.js";
import { createAssistantTurnHandler } from "./routing/assistant-turn.js";
import { createCoreCommandHandler } from "./routing/core-commands.js";
import { runMessageGatekeeping } from "./routing/gatekeeping.js";
import { createSteerChannel, type SteerChannel } from "./steer-channel.js";
import { createMessageQueue, type MessageQueue } from "./message-queue.js";

export type MessageRouter = {
  handleIncomingMessage(
    message: NormalizedTelegramMessage,
    stream?: MessageStreamingSink,
    trace?: TraceContext
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
  const activeTurns = new Map<string, { token: string; controller: AbortController; messageId: string; steerChannel: SteerChannel }>();
  const latestTurnTokenByChat = new Map<string, string>();
  const pendingMessages = new Map<string, MessageQueue>();

  const beginTurn = (chatId: string, messageId: string): { token: string; controller: AbortController; steerChannel: SteerChannel; interruptedPrevious: boolean } => {
    const previous = activeTurns.get(chatId);
    let interruptedPrevious = false;
    if (previous) {
      interruptedPrevious = true;
      previous.controller.abort();
    }

    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const controller = new AbortController();
    const steerChannel = createSteerChannel();
    latestTurnTokenByChat.set(chatId, token);
    activeTurns.set(chatId, {
      token,
      controller,
      messageId,
      steerChannel
    });

    return {
      token,
      controller,
      steerChannel,
      interruptedPrevious
    };
  };

  const releaseTurn = (chatId: string, token: string): void => {
    const current = activeTurns.get(chatId);
    if (current?.token === token) {
      activeTurns.delete(chatId);
    }
  };

  const runSingleTurn = async (
    message: NormalizedTelegramMessage,
    userContent: string,
    oneShotSkill: Parameters<typeof handleAssistantTurn>[0]["oneShotSkill"],
    trace: TraceContext,
    stream?: MessageStreamingSink
  ): Promise<MessageRouteResult> => {
    const turn = beginTurn(message.chatId, message.messageId);
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
        onTextDelta: stream?.onTextDelta
      });
    } finally {
      releaseTurn(message.chatId, turn.token);
    }

    if (latestTurnTokenByChat.get(message.chatId) !== turn.token) {
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
    const queue = pendingMessages.get(chatId);
    if (!queue || queue.length === 0) {
      pendingMessages.delete(chatId);
      return;
    }

    if (config.runtime.messageQueueMode === "batch") {
      const entries = queue.drain();
      pendingMessages.delete(chatId);
      const combinedText = entries.map((e) => e.message.text).join("\n\n");
      const last = entries[entries.length - 1]!;

      await runSingleTurn(last.message, combinedText, null, last.trace, last.stream);
    } else {
      const entry = queue.drainOne();
      if (queue.length === 0) {
        pendingMessages.delete(chatId);
      }
      if (!entry) {
        return;
      }

      await runSingleTurn(entry.message, entry.message.text, null, entry.trace, entry.stream);
      // Recurse: after this turn completes, process next queued message
      await processQueue(chatId);
    }
  };

  const runTurnAndDrainQueue = async (
    message: NormalizedTelegramMessage,
    userContent: string,
    oneShotSkill: Parameters<typeof handleAssistantTurn>[0]["oneShotSkill"],
    trace: TraceContext,
    stream?: MessageStreamingSink
  ): Promise<MessageRouteResult> => {
    const result = await runSingleTurn(message, userContent, oneShotSkill, trace, stream);
    // After this turn completes, drain any messages that were queued during it
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
      trace?: TraceContext
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
        const activeTurn = activeTurns.get(message.chatId);
        if (activeTurn) {
          const queue = pendingMessages.get(message.chatId) ?? createMessageQueue();
          pendingMessages.set(message.chatId, queue);
          const count = queue.push({ message, stream, trace: routingTrace });

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

        return await runTurnAndDrainQueue(message, message.text, null, routingTrace, stream);
      }

      if (parsedCommand.command === "steer") {
        const activeTurn = activeTurns.get(message.chatId);
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
        const activeTurn = activeTurns.get(message.chatId);
        if (activeTurn) {
          activeTurn.controller.abort();
          await observability?.record({
            event: "routing.turn.interrupted",
            trace: routingTrace,
            stage: "completed",
            chatId: message.chatId,
            messageId: message.messageId,
            interruptedByMessageId: message.messageId
          });
        }
        pendingMessages.delete(message.chatId);
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

      const userContent = parsedCommand.args.length > 0 ? parsedCommand.args : message.text;
      return await runTurnAndDrainQueue(message, userContent, skill, routingTrace, stream);
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

      const activeBeforeCommand = activeTurns.get(query.chatId);
      if (activeBeforeCommand) {
        activeBeforeCommand.controller.abort();
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
