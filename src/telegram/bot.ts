import { Bot } from "grammy";
import { setTimeout as sleep } from "node:timers/promises";
import type { RuntimeLogger, TelegramAssistantFormat } from "../runtime/contracts.js";
import {
  createChildTraceContext,
  createTraceRootContext,
  type ObservabilitySink,
  type TraceContext
} from "../observability.js";
import type {
  NormalizedTelegramCallbackQuery,
  RetainedTurnHandle,
  TelegramCommandDefinition,
  TelegramInlineKeyboard
} from "../types.js";
import { Semaphore } from "../concurrency.js";
import { createTelegramAttachmentResolver } from "./inbound-attachments.js";
import { TELEGRAM_MESSAGE_LIMIT } from "./message-split.js";
import { normalizeTelegramCallbackQuery, normalizeTelegramMessage } from "./normalize.js";
import {
  prepareTelegramReply,
  sendTelegramReplyChunks,
  toTelegramInlineKeyboard,
  type TelegramSendChunkOptions
} from "./outbound.js";
import { dispatchTelegramTextMessage, type TelegramTextHandler } from "./text-dispatch.js";

export { dispatchTelegramTextMessage, type TelegramTextHandler } from "./text-dispatch.js";
export { prepareTelegramReply } from "./outbound.js";

export type TelegramCallbackQueryHandler = (
  query: NormalizedTelegramCallbackQuery,
  trace?: TraceContext
) => Promise<import("../types.js").MessageRouteResult>;

export type TelegramRuntime = {
  bot: Bot;
  syncCommands: () => Promise<void>;
};

const RETRY_AFTER_REGEX = /retry after\s+(\d+)/i;

function parseRetryAfterMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = RETRY_AFTER_REGEX.exec(message);
  if (!match?.[1]) {
    return null;
  }

  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  return Math.ceil(seconds * 1000);
}

async function withTelegramRateLimitBackoff<T>(
  label: string,
  logger: RuntimeLogger,
  run: () => Promise<T>,
  maxAttempts = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const retryAfterMs = parseRetryAfterMs(error);
      if (!retryAfterMs || attempt >= maxAttempts) {
        throw error;
      }

      logger.warn(
        `telegram: ${label} rate limited; retrying in ${retryAfterMs}ms (attempt ${attempt + 1}/${maxAttempts})`
      );
      await sleep(retryAfterMs);
    }
  }

  throw new Error(`telegram: ${label} failed after retries`);
}

export function createTelegramBot(params: {
  token: string;
  streamingEnabled: boolean;
  streamingMinUpdateMs: number;
  draftBubbleMaxChars: number;
  draftPreviewMaxSentences: number;
  draftPreviewMaxChars: number;
  assistantFormat: TelegramAssistantFormat;
  maxFileSizeBytes: number;
  fileDownloadTimeoutMs: number;
  maxConcurrentDownloads: number;
  maxTextAttachmentBytes: number;
  acknowledgedEmoji: string | null;
  logger: RuntimeLogger;
  handleMessage: TelegramTextHandler;
  handleCallbackQuery: TelegramCallbackQueryHandler;
  getCommands: () => Promise<TelegramCommandDefinition[]>;
  isAuthorizedSender: (senderId: string) => boolean;
  observability?: ObservabilitySink;
}): TelegramRuntime {
  const bot = new Bot(params.token);
  let commandSignature = "";
  const downloadSemaphore = new Semaphore(params.maxConcurrentDownloads);

  const logFatalHandlerError = (chatId: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    params.logger.error(`telegram: uncaught error in background handler chat=${chatId}: ${message}`);
  };

  const syncCommands = async (): Promise<void> => {
    const commands = await params.getCommands();
    const signature = JSON.stringify(commands);

    if (signature === commandSignature) {
      return;
    }

    await bot.api.setMyCommands(
      commands.map((item) => ({
        command: item.command,
        description: item.description
      }))
    );
    commandSignature = signature;
    params.logger.info(`telegram: registered ${commands.length} commands`);
  };

  const sendReplyChunks = async (paramsInput: {
    label: string;
    chatId: string;
    messageId: string;
    text: string;
    parseMode?: "HTML";
    inlineKeyboard?: TelegramInlineKeyboard;
    reply: (
      text: string,
      options: {
        link_preview_options: { is_disabled: true };
        parse_mode?: "HTML";
        reply_markup?: {
          inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
        };
      }
    ) => Promise<void>;
  }): Promise<void> => {
    await sendTelegramReplyChunks({
      text: paramsInput.text,
      parseMode: paramsInput.parseMode,
      inlineKeyboard: paramsInput.inlineKeyboard,
      sendChunk: async (chunk, options: TelegramSendChunkOptions) => {
        await withTelegramRateLimitBackoff(
          `${paramsInput.label} chat=${paramsInput.chatId} message=${paramsInput.messageId}`,
          params.logger,
          async () => {
            const replyOptions = {
              link_preview_options: { is_disabled: true as const },
              ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
              ...(options.inlineKeyboard
                ? {
                    reply_markup: {
                      inline_keyboard: toTelegramInlineKeyboard(options.inlineKeyboard)
                    }
                  }
                : {})
            };
            await paramsInput.reply(chunk, replyOptions);
          }
        );
      }
    });
  };

  bot.on(
    ["message:text", "message:photo", "message:document", "message:video", "message:audio", "message:voice", "message:animation"],
    (ctx) => {
      const normalized = normalizeTelegramMessage(ctx);
      if (!normalized) {
        return;
      }

      const inboundTrace = createTraceRootContext("telegram");
      void (async () => {
        let retainedTurn: RetainedTurnHandle | null = null;
        try {
          const attachmentResolver = createTelegramAttachmentResolver({
            bot,
            message: normalized,
            isAuthorizedSender: params.isAuthorizedSender,
            logger: params.logger,
            maxFileSizeBytes: params.maxFileSizeBytes,
            fileDownloadTimeoutMs: params.fileDownloadTimeoutMs,
            maxTextAttachmentBytes: params.maxTextAttachmentBytes,
            downloadSemaphore
          });

          await dispatchTelegramTextMessage({
            message: normalized,
            handleMessage: (message, stream, trace, userContent, resolver) =>
              params.handleMessage(message, stream, trace ?? inboundTrace, userContent, resolver, {
                retain: (handle) => {
                  retainedTurn = handle;
                }
              }),
            attachmentResolver,
            sendReply: async (text, meta) => {
              const prepared = prepareTelegramReply({
                text,
                meta,
                assistantFormat: params.assistantFormat,
                chatId: normalized.chatId,
                messageId: normalized.messageId,
                logger: params.logger
              });
              await sendReplyChunks({
                label: "send reply",
                chatId: normalized.chatId,
                messageId: normalized.messageId,
                text: prepared.text,
                parseMode: prepared.parseMode,
                inlineKeyboard: meta.inlineKeyboard,
                reply: async (chunk, options) => {
                  await ctx.reply(chunk, options);
                }
              });
            },
            sendDraft: params.streamingEnabled
              ? async (text) => {
                  const truncated = text.length > TELEGRAM_MESSAGE_LIMIT
                    ? text.slice(0, TELEGRAM_MESSAGE_LIMIT)
                    : text;
                  await withTelegramRateLimitBackoff(
                    `send draft chat=${normalized.chatId} message=${normalized.messageId}`,
                    params.logger,
                    async () => {
                      await ctx.replyWithDraft(truncated);
                    }
                  );
                }
              : undefined,
            sendAttachment: async (attachment) => {
              const { InputFile } = await import("grammy");
              const source = new InputFile(attachment.buffer, attachment.fileName);
              await withTelegramRateLimitBackoff(
                `send attachment chat=${normalized.chatId} message=${normalized.messageId}`,
                params.logger,
                async () => {
                  if (attachment.sendAsPhoto) {
                    await ctx.replyWithPhoto(source);
                  } else {
                    await ctx.replyWithDocument(source);
                  }
                }
              );
            },
            logger: params.logger,
            draftMinUpdateMs: params.streamingMinUpdateMs,
            draftBubbleMaxChars: params.draftBubbleMaxChars,
            draftPreviewMaxSentences: params.draftPreviewMaxSentences,
            draftPreviewMaxChars: params.draftPreviewMaxChars,
            onDraftFailure: (error) => {
              const message = error instanceof Error ? error.message : String(error);
              params.logger.warn(
                `telegram: draft streaming failed for chat=${normalized.chatId} message=${normalized.messageId}: ${message}`
              );
            },
            trace: inboundTrace,
            observability: params.observability,
            sendAcknowledgedReaction: params.acknowledgedEmoji
              ? async () => {
                  await ctx.react(params.acknowledgedEmoji! as Parameters<typeof ctx.react>[0]);
                }
              : undefined,
            sendProcessingAction: async () => {
              await ctx.replyWithChatAction("typing");
            },
            processingActionRefreshMs: 4000,
            shouldSuppressOutput: () => retainedTurn?.abortSignal.aborted ?? false,
            onSettled: async () => {
              const turn = retainedTurn;
              retainedTurn = null;
              await turn?.finalize();
            }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          params.logger.error(`telegram: failed to process message: ${message}`);
          await params.observability?.record({
            event: "telegram.processing.failed",
            trace: createChildTraceContext(inboundTrace, "telegram"),
            stage: "failed",
            chatId: normalized.chatId,
            messageId: normalized.messageId,
            senderId: normalized.senderId,
            error
          });
          await ctx.reply("I hit an internal error while processing that message.", {
            link_preview_options: { is_disabled: true }
          });
        }
      })().catch((fatal) => logFatalHandlerError(normalized.chatId, fatal));
    }
  );

  bot.on("callback_query:data", (ctx) => {
    const normalized = normalizeTelegramCallbackQuery(ctx);
    if (!normalized) {
      return;
    }

    const inboundTrace = createTraceRootContext("telegram");
    void (async () => {
      try {
        await params.observability?.record({
          event: "telegram.inbound.received",
          trace: inboundTrace,
          stage: "received",
          chatId: normalized.chatId,
          messageId: normalized.messageId,
          senderId: normalized.senderId,
          payload: normalized
        });

        await ctx.answerCallbackQuery().catch(() => {});
        const result = await params.handleCallbackQuery(normalized, inboundTrace);

        const sendCallbackReply = async (
          text: string,
          meta: {
            resultType: Exclude<import("../types.js").MessageRouteResult["type"], "ignore">;
            isExtra: boolean;
            origin: "assistant" | "system";
            inlineKeyboard?: TelegramInlineKeyboard;
          }
        ): Promise<void> => {
          await params.observability?.record({
            event: "telegram.outbound.reply.sent",
            trace: createChildTraceContext(inboundTrace, "telegram"),
            stage: "completed",
            chatId: normalized.chatId,
            messageId: normalized.messageId,
            senderId: normalized.senderId,
            resultType: meta.resultType,
            origin: meta.origin,
            text,
            isExtra: meta.isExtra,
            hasInlineKeyboard: Boolean(meta.inlineKeyboard)
          });

          await sendReplyChunks({
            label: "send callback reply",
            chatId: normalized.chatId,
            messageId: normalized.messageId,
            text,
            inlineKeyboard: meta.inlineKeyboard,
            reply: async (chunk, options) => {
              await ctx.reply(chunk, options);
            }
          });
        };

        switch (result.type) {
          case "reply": {
            const extras = result.extraReplies?.filter((item) => item.trim().length > 0) ?? [];
            const origin = result.origin ?? "system";
            for (const extra of extras) {
              await sendCallbackReply(extra, {
                resultType: result.type,
                isExtra: true,
                origin
              });
            }
            await sendCallbackReply(result.text, {
              resultType: result.type,
              isExtra: false,
              origin,
              inlineKeyboard: result.inlineKeyboard
            });
            break;
          }
          case "fallback": {
            const extras = result.extraReplies?.filter((item) => item.trim().length > 0) ?? [];
            for (const extra of extras) {
              await sendCallbackReply(extra, {
                resultType: result.type,
                isExtra: true,
                origin: "system"
              });
            }
            await sendCallbackReply(result.text, {
              resultType: result.type,
              isExtra: false,
              origin: "system",
              inlineKeyboard: result.inlineKeyboard
            });
            break;
          }
          case "unauthorized":
            await sendCallbackReply(result.text, {
              resultType: result.type,
              isExtra: false,
              origin: "system",
              inlineKeyboard: result.inlineKeyboard
            });
            break;
          case "ignore":
            await params.observability?.record({
              event: "telegram.outbound.reply.sent",
              trace: createChildTraceContext(inboundTrace, "telegram"),
              stage: "completed",
              chatId: normalized.chatId,
              messageId: normalized.messageId,
              senderId: normalized.senderId,
              resultType: result.type,
              text: null,
              isExtra: false
            });
            break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        params.logger.error(`telegram: failed to process callback query: ${message}`);
        await params.observability?.record({
          event: "telegram.processing.failed",
          trace: createChildTraceContext(inboundTrace, "telegram"),
          stage: "failed",
          chatId: normalized.chatId,
          messageId: normalized.messageId,
          senderId: normalized.senderId,
          error
        });
        try {
          await ctx.answerCallbackQuery({ text: "Internal error" });
        } catch {
          // ignore callback answer failures on error path
        }
        await ctx.reply("I hit an internal error while handling that selection.", {
          link_preview_options: { is_disabled: true }
        });
      }
    })().catch((fatal) => logFatalHandlerError(normalized.chatId, fatal));
  });

  bot.catch((error) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    params.logger.error(`telegram: bot middleware error: ${message}`);
    const middlewareTrace = createTraceRootContext("system");
    void params.observability?.record({
      event: "telegram.middleware.failed",
      trace: middlewareTrace,
      stage: "failed",
      error
    });
  });

  return {
    bot,
    syncCommands
  };
}
