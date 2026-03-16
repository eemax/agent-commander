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
        const turn = beginTurn(message.chatId, message.messageId);
        if (turn.interruptedPrevious) {
          await observability?.record({
            event: "routing.turn.interrupted",
            trace: routingTrace,
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
            userContent: message.text,
            oneShotSkill: null,
            trace: routingTrace,
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
          trace: routingTrace,
          stage: "completed",
          chatId: message.chatId,
          messageId: message.messageId,
          decision: "assistant_turn",
          resultType: result.type,
          result
        });
        return result;
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

      const activeBeforeCommand = activeTurns.get(message.chatId);
      if (activeBeforeCommand) {
        activeBeforeCommand.controller.abort();
        await observability?.record({
          event: "routing.turn.interrupted",
          trace: routingTrace,
          stage: "completed",
          chatId: message.chatId,
          messageId: message.messageId,
          interruptedByMessageId: message.messageId
        });
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
      const turn = beginTurn(message.chatId, message.messageId);
      if (turn.interruptedPrevious) {
        await observability?.record({
          event: "routing.turn.interrupted",
          trace: routingTrace,
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
          oneShotSkill: skill,
          trace: routingTrace,
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
        trace: routingTrace,
        stage: "completed",
        chatId: message.chatId,
        messageId: message.messageId,
        decision: "skill_command",
        command: parsedCommand.command,
        args: parsedCommand.args,
        skillSlug: skill.slug,
        resultType: result.type,
        result
      });
      return result;
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
