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
import type { CodexAuthManager } from "./auth/codex-auth.js";
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
  codexAuth?: CodexAuthManager;
  onCommandCatalogChanged?: (commands: TelegramCommandDefinition[]) => Promise<void>;
}): MessageRouter {
  const { logger, provider, config, conversations, workspace, harness, observability, codexAuth, onCommandCatalogChanged } =
    params;
  const turns = new TurnManager();

  const runSingleTurn = async (
    message: NormalizedTelegramMessage,
    userContent: string | ContentPart[],
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
      decision: "assistant_turn",
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
        for (let i = 0; i < entries.length; i++) {
          if (i > 0 && parts.length > 0) {
            parts.push({ type: "text", text: "---" });
          }
          const uc = entries[i]!.userContent ?? entries[i]!.message.text;
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

      await runSingleTurn(last.message, combinedContent, last.trace, last.stream);
    } else {
      const entry = queue.drainOne();
      if (queue.length === 0) {
        turns.deleteQueue(chatId);
      }
      if (!entry) {
        return;
      }

      await runSingleTurn(entry.message, entry.userContent ?? entry.message.text, entry.trace, entry.stream);
      await processQueue(chatId);
    }
  };

  const runTurnAndDrainQueue = async (
    message: NormalizedTelegramMessage,
    userContent: string | ContentPart[],
    trace: TraceContext,
    stream?: MessageStreamingSink
  ): Promise<MessageRouteResult> => {
    const result = await runSingleTurn(message, userContent, trace, stream);
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
      if (config.openai.authMode === "codex") {
        codexAuth?.reload();
      }
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

        return await runTurnAndDrainQueue(message, resolvedUserContent ?? message.text, routingTrace, stream);
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

      const skill = workspace.getSkillByName(parsedCommand.command);
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

      const userArgs = parsedCommand.args;
      const skillNotice = [
        `[Skill Invoked: /${skill.name}]`,
        `The user invoked the "${skill.name}" skill: ${skill.description}`,
        `Read the skill file to understand and apply its instructions: ${skill.path}`,
        ...(userArgs.length > 0 ? ["", "---", "", userArgs] : [])
      ].join("\n");

      let skillUserContent: string | ContentPart[];
      if (Array.isArray(resolvedUserContent)) {
        // Replace the user text part (index 0) with the skill notice.
        // Keep all attachment-derived parts (images, files, file-content text parts).
        const isUserTextPart = (p: ContentPart, idx: number) =>
          idx === 0 && p.type === "text" && p.text === message.text;
        const rest = resolvedUserContent.filter((p, i) => !isUserTextPart(p, i));
        skillUserContent = [{ type: "text" as const, text: skillNotice }, ...rest];
      } else {
        skillUserContent = skillNotice;
      }
      return await runTurnAndDrainQueue(message, skillUserContent, routingTrace, stream);
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
