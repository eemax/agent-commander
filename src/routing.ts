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
  ContentPart,
  TurnRetentionRegistrar
} from "./types.js";
import type { AuthModeRegistry } from "./provider/auth-mode-contracts.js";
import type { AttachmentResolver } from "./message-queue.js";
import { createAssistantTurnHandler } from "./routing/assistant-turn.js";
import { createCoreCommandHandler } from "./routing/core-commands.js";
import { runMessageGatekeeping } from "./routing/gatekeeping.js";
import { TurnManager } from "./routing/turn-manager.js";

export type MessageRouter = {
  handleIncomingMessage(
    message: NormalizedTelegramMessage,
    stream?: MessageStreamingSink,
    trace?: TraceContext,
    userContent?: string | ContentPart[],
    attachmentResolver?: AttachmentResolver,
    turnRetention?: TurnRetentionRegistrar
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
  authModeRegistry?: AuthModeRegistry;
  onCommandCatalogChanged?: (commands: TelegramCommandDefinition[]) => Promise<void>;
}): MessageRouter {
  const { logger, provider, config, conversations, workspace, harness, observability, authModeRegistry, onCommandCatalogChanged } =
    params;
  const turns = new TurnManager();

  const runSingleTurn = async (
    message: NormalizedTelegramMessage,
    userContent: string | ContentPart[],
    trace: TraceContext,
    stream?: MessageStreamingSink,
    turnRetention?: TurnRetentionRegistrar
  ): Promise<MessageRouteResult> => {
    const turn = turns.beginTurn(message.chatId, message.messageId);
    let finalized = false;
    const finalizeTurn = async (): Promise<void> => {
      if (finalized) {
        return;
      }
      finalized = true;
      turns.releaseTurn(message.chatId, turn.token);
      try {
        await processQueue(message.chatId);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`routing: failed to process queued messages for chat=${message.chatId}: ${msg}`);
      }
    };

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
        onToolCallNotice: stream?.onToolCallNotice,
        onLifecycleEvent: stream?.onLifecycleEvent
      });
    } catch (error) {
      await finalizeTurn();
      throw error;
    }

    if (!turns.isLatestTurn(message.chatId, turn.token)) {
      result = { type: "ignore" };
    } else {
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
    }

    if (turnRetention) {
      turns.markTurnFinalizing(message.chatId, turn.token);
      turnRetention.retain({
        abortSignal: turn.controller.signal,
        finalize: finalizeTurn
      });
    } else {
      await finalizeTurn();
    }

    return result;
  };

  const resolveQueuedEntryContent = async (entry: import("./message-queue.js").QueuedMessage): Promise<string | ContentPart[]> => {
    if (entry.userContent) return entry.userContent;
    if (entry.attachmentResolver) {
      const resolved = await entry.attachmentResolver();
      if (resolved.userContent) return resolved.userContent;
    }
    return entry.message.text;
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

      // Resolve any deferred attachments in queued entries
      const resolvedEntries: Array<{ userContent: string | ContentPart[] }> = [];
      for (const entry of entries) {
        resolvedEntries.push({ userContent: await resolveQueuedEntryContent(entry) });
      }

      const hasMultipart = resolvedEntries.some((e) => Array.isArray(e.userContent));

      let combinedContent: string | ContentPart[];
      if (hasMultipart) {
        const parts: ContentPart[] = [];
        for (let i = 0; i < resolvedEntries.length; i++) {
          if (i > 0 && parts.length > 0) {
            parts.push({ type: "text", text: "---" });
          }
          const uc = resolvedEntries[i]!.userContent;
          if (typeof uc === "string") {
            if (uc.length > 0) parts.push({ type: "text", text: uc });
          } else {
            parts.push(...uc);
          }
        }
        combinedContent = parts;
      } else {
        combinedContent = resolvedEntries.map((e) => e.userContent as string).join("\n\n");
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

      const content = await resolveQueuedEntryContent(entry);
      await runSingleTurn(entry.message, content, entry.trace, entry.stream);
    }
  };

  const runTurnAndDrainQueue = async (
    message: NormalizedTelegramMessage,
    userContent: string | ContentPart[],
    trace: TraceContext,
    stream?: MessageStreamingSink,
    turnRetention?: TurnRetentionRegistrar
  ): Promise<MessageRouteResult> => {
    return runSingleTurn(message, userContent, trace, stream, turnRetention);
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
    harness,
    authModeRegistry
  });

  return {
    async handleIncomingMessage(
      message: NormalizedTelegramMessage,
      stream?: MessageStreamingSink,
      trace?: TraceContext,
      resolvedUserContent?: string | ContentPart[],
      attachmentResolver?: AttachmentResolver,
      turnRetention?: TurnRetentionRegistrar
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
          const count = queue.push({ message, userContent: resolvedUserContent, attachmentResolver, stream, trace: routingTrace });

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

        // Resolve deferred attachments now that we know the message will execute
        let finalUserContent: string | ContentPart[] = resolvedUserContent ?? message.text;
        if (!resolvedUserContent && attachmentResolver) {
          const resolved = await attachmentResolver();
          if (resolved.errors.length > 0 && !resolved.userContent && message.text.length === 0) {
            return { type: "reply", text: resolved.errors.join("\n") };
          }
          if (resolved.errors.length > 0) {
            logger.warn(`routing: attachment errors for chat=${message.chatId}: ${resolved.errors.join("; ")}`);
          }
          if (resolved.userContent) {
            finalUserContent = resolved.userContent;
          }
        }

        return await runTurnAndDrainQueue(message, finalUserContent, routingTrace, stream, turnRetention);
      }

      if (parsedCommand.command === "steer") {
        const activeTurn = turns.getSteerableTurn(message.chatId);
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
      return await runTurnAndDrainQueue(message, skillUserContent, routingTrace, stream, turnRetention);
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
