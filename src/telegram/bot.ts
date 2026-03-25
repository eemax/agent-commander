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
  MessageRouteResult,
  MessageStreamingSink,
  NormalizedTelegramCallbackQuery,
  NormalizedTelegramMessage,
  TelegramInlineKeyboard,
  TelegramCommandDefinition,
  ContentPart
} from "../types.js";
import { downloadTelegramFile, FileTooLargeError } from "./file-download.js";
import { resolveAttachmentContentParts } from "./attachment-resolve.js";
import { extractAttachMarkers, resolveOutboundAttachment, type OutboundAttachment } from "./outbound-attachments.js";
import { Semaphore } from "../concurrency.js";
import { renderBasicTelegramHtml, renderMarkdownToTelegramHtml } from "./assistant-format.js";
import { splitTelegramMessage, TELEGRAM_MESSAGE_LIMIT } from "./message-split.js";
import { normalizeTelegramCallbackQuery, normalizeTelegramMessage } from "./normalize.js";
import { VERBOSE_REPLACE_PREFIX } from "../routing/formatters.js";

export type TelegramTextHandler = (
  message: NormalizedTelegramMessage,
  stream?: MessageStreamingSink,
  trace?: TraceContext,
  userContent?: string | ContentPart[]
) => Promise<MessageRouteResult>;

export type TelegramCallbackQueryHandler = (
  query: NormalizedTelegramCallbackQuery,
  trace?: TraceContext
) => Promise<MessageRouteResult>;

export type TelegramRuntime = {
  bot: Bot;
  syncCommands: () => Promise<void>;
};

export type OutboundResultType = Exclude<MessageRouteResult["type"], "ignore">;

export type TelegramOutboundReplyMeta = {
  resultType: OutboundResultType;
  isExtra: boolean;
  origin: "assistant" | "system";
  inlineKeyboard?: TelegramInlineKeyboard;
};

export type TelegramPreparedReply = {
  text: string;
  parseMode?: "HTML";
};

function toTelegramInlineKeyboard(inlineKeyboard: TelegramInlineKeyboard): Array<Array<{ text: string; callback_data: string }>> {
  return inlineKeyboard.map((row) =>
    row.map((button) => ({
      text: button.text,
      callback_data: button.callbackData
    }))
  );
}

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

function tryFormat(
  params: { text: string; chatId: string; messageId: string; logger: RuntimeLogger },
  convert: (markdown: string) => string
): TelegramPreparedReply {
  try {
    const formatted = convert(params.text);
    if (formatted.trim().length === 0) {
      return { text: params.text };
    }
    return { text: formatted, parseMode: "HTML" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.logger.warn(
      `telegram: assistant formatting failed for chat=${params.chatId} message=${params.messageId}: ${message}`
    );
    return { text: params.text };
  }
}

export function prepareTelegramReply(params: {
  text: string;
  meta: TelegramOutboundReplyMeta;
  assistantFormat: TelegramAssistantFormat;
  chatId: string;
  messageId: string;
  logger: RuntimeLogger;
  markdownToHtml?: (markdown: string) => string;
}): TelegramPreparedReply {
  if (params.assistantFormat !== "markdown_to_html" || params.meta.resultType !== "reply") {
    return { text: params.text };
  }

  if (!params.meta.isExtra) {
    return tryFormat(params, params.markdownToHtml ?? renderMarkdownToTelegramHtml);
  }

  if (params.meta.isExtra) {
    return tryFormat(params, renderBasicTelegramHtml);
  }

  return { text: params.text };
}

export async function dispatchTelegramTextMessage(params: {
  message: NormalizedTelegramMessage;
  handleMessage: TelegramTextHandler;
  sendReply: (text: string, meta: TelegramOutboundReplyMeta) => Promise<void>;
  sendDraft?: (text: string) => Promise<void>;
  sendAttachment?: (attachment: OutboundAttachment) => Promise<void>;
  logger?: RuntimeLogger;
  draftMinUpdateMs?: number;
  onDraftFailure?: (error: unknown) => void | Promise<void>;
  nowMs?: () => number;
  trace?: TraceContext;
  observability?: ObservabilitySink;
  userContent?: string | ContentPart[];
}): Promise<MessageRouteResult> {
  const messageTrace = params.trace ?? createTraceRootContext("telegram");
  const nowMs = params.nowMs ?? Date.now;
  const draftMinUpdateMs = Math.max(1, params.draftMinUpdateMs ?? 100);
  let draftText = "";
  let lastDraftText = "";
  let lastDraftAtMs: number | null = null;
  let draftDisabled = !params.sendDraft;

  let toolCallBuffer = "";
  let textStreamingStarted = false;
  const lateToolCallNotices: string[] = [];

  await params.observability?.record({
    event: "telegram.inbound.received",
    trace: messageTrace,
    stage: "received",
    chatId: params.message.chatId,
    messageId: params.message.messageId,
    senderId: params.message.senderId,
    payload: params.message
  });

  const disableDraft = async (error: unknown): Promise<void> => {
    if (draftDisabled) {
      return;
    }

    draftDisabled = true;
    await params.observability?.record({
      event: "telegram.outbound.draft.failed",
      trace: createChildTraceContext(messageTrace, "telegram"),
      stage: "failed",
      chatId: params.message.chatId,
      messageId: params.message.messageId,
      senderId: params.message.senderId,
      error
    });
    await params.onDraftFailure?.(error);
  };

  const sendOutbound = async (
    text: string,
    resultType: OutboundResultType,
    isExtra: boolean,
    origin: "assistant" | "system",
    inlineKeyboard?: TelegramInlineKeyboard
  ): Promise<void> => {
    const meta: TelegramOutboundReplyMeta = {
      resultType,
      isExtra,
      origin,
      ...(inlineKeyboard ? { inlineKeyboard } : {})
    };
    await params.observability?.record({
      event: "telegram.outbound.reply.sent",
      trace: createChildTraceContext(messageTrace, "telegram"),
      stage: "completed",
      chatId: params.message.chatId,
      messageId: params.message.messageId,
      senderId: params.message.senderId,
      resultType,
      origin,
      text,
      isExtra,
      hasInlineKeyboard: Boolean(inlineKeyboard)
    });
    await params.sendReply(text, meta);
  };

  const commitToolCallBuffer = async (): Promise<void> => {
    const text = toolCallBuffer.trim();
    if (text.length === 0) {
      return;
    }

    toolCallBuffer = "";
    lastDraftText = "";
    lastDraftAtMs = null;
    await sendOutbound(text, "reply", true, "system");
  };

  const flushDraft = async (force: boolean): Promise<void> => {
    if (draftDisabled || !params.sendDraft) {
      return;
    }

    if (draftText.trim().length === 0 || draftText === lastDraftText) {
      return;
    }

    const now = nowMs();
    if (!force && lastDraftAtMs !== null && now - lastDraftAtMs < draftMinUpdateMs) {
      return;
    }

    try {
      await params.observability?.record({
        event: "telegram.outbound.draft.sent",
        trace: createChildTraceContext(messageTrace, "telegram"),
        stage: "completed",
        chatId: params.message.chatId,
        messageId: params.message.messageId,
        senderId: params.message.senderId,
        text: draftText,
        forced: force
      });
      await params.sendDraft(draftText);
      lastDraftText = draftText;
      lastDraftAtMs = now;
    } catch (error) {
      await disableDraft(error);
    }
  };

  const flushToolCallDraft = async (force: boolean): Promise<void> => {
    if (draftDisabled || !params.sendDraft) {
      return;
    }

    if (toolCallBuffer.trim().length === 0 || toolCallBuffer === lastDraftText) {
      return;
    }

    const now = nowMs();
    if (!force && lastDraftAtMs !== null && now - lastDraftAtMs < draftMinUpdateMs) {
      return;
    }

    try {
      const truncated = toolCallBuffer.length > TELEGRAM_MESSAGE_LIMIT
        ? toolCallBuffer.slice(0, TELEGRAM_MESSAGE_LIMIT)
        : toolCallBuffer;
      await params.sendDraft(truncated);
      lastDraftText = toolCallBuffer;
      lastDraftAtMs = now;
    } catch (error) {
      await disableDraft(error);
    }
  };

  const stream: MessageStreamingSink | undefined = params.sendDraft
    ? {
        onTextDelta: async (delta) => {
          await ensureTypingStarted();
          stopTypingIndicator();

          if (!textStreamingStarted) {
            textStreamingStarted = true;
            if (toolCallBuffer.trim().length > 0) {
              await commitToolCallBuffer();
            }
          }

          if (draftDisabled || typeof delta !== "string" || delta.length === 0) {
            return;
          }

          draftText += delta;
          await flushDraft(false);
        },
        onToolCallNotice: async (notice) => {
          await ensureTypingStarted();
          stopTypingIndicator();

          if (typeof notice !== "string" || notice.length === 0) {
            return;
          }

          // Count-mode: replace the entire buffer instead of appending
          if (notice.startsWith(VERBOSE_REPLACE_PREFIX)) {
            const content = notice.slice(VERBOSE_REPLACE_PREFIX.length);
            toolCallBuffer = content.length > TELEGRAM_MESSAGE_LIMIT
              ? content.slice(0, TELEGRAM_MESSAGE_LIMIT)
              : content;
            if (!textStreamingStarted) {
              await flushToolCallDraft(false);
              startToolCallTypingIndicator();
            }
            return;
          }

          if (textStreamingStarted) {
            lateToolCallNotices.push(notice);
            return;
          }

          const delimiter = toolCallBuffer.length > 0 ? "\n\n" : "";
          const candidate = toolCallBuffer + delimiter + notice;

          if (candidate.length > TELEGRAM_MESSAGE_LIMIT) {
            if (toolCallBuffer.trim().length > 0) {
              await commitToolCallBuffer();
            }
            toolCallBuffer = notice.length > TELEGRAM_MESSAGE_LIMIT
              ? notice.slice(0, TELEGRAM_MESSAGE_LIMIT)
              : notice;
          } else {
            toolCallBuffer = candidate;
          }

          await flushToolCallDraft(false);
          startToolCallTypingIndicator();
        }
      }
    : undefined;

  const TYPING_FRAMES = [".", "..", "..."];
  let typingTimer: ReturnType<typeof setInterval> | null = null;
  let typingFrameIndex = 0;

  const stopTypingIndicator = (): void => {
    if (typingTimer !== null) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
  };

  const startToolCallTypingIndicator = (): void => {
    if (draftDisabled || !params.sendDraft) return;
    stopTypingIndicator();
    typingFrameIndex = 0;
    let consecutiveErrors = 0;

    const sendFrame = (): void => {
      if (draftDisabled || !params.sendDraft || textStreamingStarted) {
        stopTypingIndicator();
        return;
      }
      const frame = TYPING_FRAMES[typingFrameIndex % TYPING_FRAMES.length]!;
      typingFrameIndex += 1;
      const prefix = toolCallBuffer.length > 0 ? toolCallBuffer + "\n" : "";
      const candidate = prefix + frame;
      const draft = candidate.length > TELEGRAM_MESSAGE_LIMIT ? toolCallBuffer : candidate;
      params.sendDraft(draft).then(() => {
        consecutiveErrors = 0;
      }).catch(() => {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 3) {
          stopTypingIndicator();
        }
      });
    };

    sendFrame();
    typingTimer = setInterval(sendFrame, draftMinUpdateMs);
  };

  let initialTypingStarted = false;
  const ensureTypingStarted = async (): Promise<void> => {
    if (initialTypingStarted || draftDisabled || !params.sendDraft) {
      return;
    }
    initialTypingStarted = true;
    try {
      await params.sendDraft(TYPING_FRAMES[0]!);
      typingFrameIndex = 1;
      typingTimer = setInterval(() => {
        if (draftDisabled || !params.sendDraft) {
          stopTypingIndicator();
          return;
        }

        const frame = TYPING_FRAMES[typingFrameIndex % TYPING_FRAMES.length]!;
        typingFrameIndex += 1;
        params.sendDraft(frame).catch(() => {
          stopTypingIndicator();
        });
      }, draftMinUpdateMs);
    } catch (error) {
      await disableDraft(error);
    }
  };

  const result = await params.handleMessage(params.message, stream, messageTrace, params.userContent);
  stopTypingIndicator();
  await flushToolCallDraft(true);
  await commitToolCallBuffer();
  await flushDraft(true);

  const sendExtractedAttachments = async (markerPaths: string[]): Promise<void> => {
    if (!params.sendAttachment || !params.logger || markerPaths.length === 0) {
      return;
    }

    for (const markerPath of markerPaths) {
      const attachment = await resolveOutboundAttachment(markerPath, params.logger);
      if (attachment) {
        try {
          await params.sendAttachment(attachment);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          params.logger.warn(`outbound-attachment: failed to send ${attachment.fileName}: ${message}`);
        }
      }
    }
  };

  switch (result.type) {
    case "reply": {
      const extras = result.extraReplies?.filter((item) => item.trim().length > 0) ?? [];
      const origin = result.origin ?? "system";
      const { cleanText, markers } = extractAttachMarkers(result.text);
      for (const extra of extras) {
        await sendOutbound(extra, result.type, true, origin);
      }
      for (const late of lateToolCallNotices) {
        await sendOutbound(late, result.type, true, "system");
      }
      await sendOutbound(cleanText, result.type, false, origin, result.inlineKeyboard);
      await sendExtractedAttachments(markers);
      break;
    }
    case "fallback": {
      const extras = result.extraReplies?.filter((item) => item.trim().length > 0) ?? [];
      const { cleanText, markers } = extractAttachMarkers(result.text);
      for (const extra of extras) {
        await sendOutbound(extra, result.type, true, "system");
      }
      for (const late of lateToolCallNotices) {
        await sendOutbound(late, result.type, true, "system");
      }
      await sendOutbound(cleanText, result.type, false, "system", result.inlineKeyboard);
      await sendExtractedAttachments(markers);
      break;
    }
    case "unauthorized":
      await sendOutbound(result.text, result.type, false, "system", result.inlineKeyboard);
      break;
    case "ignore":
      await params.observability?.record({
        event: "telegram.outbound.reply.sent",
        trace: createChildTraceContext(messageTrace, "telegram"),
        stage: "completed",
        chatId: params.message.chatId,
        messageId: params.message.messageId,
        senderId: params.message.senderId,
        resultType: result.type,
        text: null,
        isExtra: false
      });
      break;
  }
  return result;
}

export function createTelegramBot(params: {
  token: string;
  streamingEnabled: boolean;
  streamingMinUpdateMs: number;
  assistantFormat: TelegramAssistantFormat;
  maxFileSizeBytes: number;
  fileDownloadTimeoutMs: number;
  maxConcurrentDownloads: number;
  logger: RuntimeLogger;
  handleMessage: TelegramTextHandler;
  handleCallbackQuery: TelegramCallbackQueryHandler;
  getCommands: () => Promise<TelegramCommandDefinition[]>;
  isAuthorizedSender: (senderId: string) => boolean;
  observability?: ObservabilitySink;
}): TelegramRuntime {
  const bot = new Bot(params.token);
  let commandSignature = "";

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

  const maxFileSizeBytes = params.maxFileSizeBytes;
  const fileDownloadTimeoutMs = params.fileDownloadTimeoutMs;
  const downloadSemaphore = new Semaphore(params.maxConcurrentDownloads);

  bot.on(["message:text", "message:photo", "message:document", "message:video", "message:audio", "message:voice", "message:animation"], (ctx) => {
    const normalized = normalizeTelegramMessage(ctx);
    if (!normalized) {
      return;
    }

    const inboundTrace = createTraceRootContext("telegram");
    void (async () => {
      try {
        let resolvedUserContent: string | ContentPart[] | undefined;

        if (normalized.attachments && normalized.attachments.length > 0 && params.isAuthorizedSender(normalized.senderId)) {
          const downloaded = [];
          const errors: string[] = [];

          for (const attachment of normalized.attachments) {
            await downloadSemaphore.acquire();
            try {
              const file = await downloadTelegramFile({
                bot,
                fileId: attachment.fileId,
                declaredMimeType: attachment.mimeType,
                declaredFileName: attachment.fileName,
                declaredFileSize: attachment.fileSize,
                maxSizeBytes: maxFileSizeBytes,
                timeoutMs: fileDownloadTimeoutMs,
                logger: params.logger
              });
              downloaded.push(file);
            } catch (error) {
              if (error instanceof FileTooLargeError) {
                errors.push(`File too large (${Math.round(error.fileSize / 1024 / 1024)}MB). Maximum size is ${Math.round(maxFileSizeBytes / 1024 / 1024)}MB.`);
              } else {
                const msg = error instanceof Error ? error.message : String(error);
                params.logger.error(`telegram: file download failed: ${msg}`);
                errors.push("Failed to download file.");
              }
            } finally {
              downloadSemaphore.release();
            }
          }

          const { parts, rejected } = resolveAttachmentContentParts({
            downloaded,
            logger: params.logger
          });

          for (const mime of rejected) {
            errors.push(`Unsupported file type: ${mime}. I can process images, PDFs, and text files.`);
          }

          if (errors.length > 0 && parts.length === 0 && normalized.text.length === 0) {
            await ctx.reply(errors.join("\n"), { link_preview_options: { is_disabled: true } });
            return;
          }

          if (errors.length > 0) {
            await ctx.reply(errors.join("\n"), { link_preview_options: { is_disabled: true } });
          }

          if (parts.length > 0) {
            const contentParts: ContentPart[] = [];
            if (normalized.text.length > 0) {
              contentParts.push({ type: "text", text: normalized.text });
            }
            contentParts.push(...parts);
            resolvedUserContent = contentParts;
          }
        }

        await dispatchTelegramTextMessage({
          message: normalized,
          handleMessage: (message, stream, trace, userContent) =>
            params.handleMessage(message, stream, inboundTrace, userContent),
          userContent: resolvedUserContent,
          sendReply: async (text, meta) => {
            const prepared = prepareTelegramReply({
              text,
              meta,
              assistantFormat: params.assistantFormat,
              chatId: normalized.chatId,
              messageId: normalized.messageId,
              logger: params.logger
            });
            const chunks = splitTelegramMessage(prepared.text, {
              parseMode: prepared.parseMode
            });
            for (let i = 0; i < chunks.length; i += 1) {
              const isLast = i === chunks.length - 1;
              await withTelegramRateLimitBackoff(
                `send reply chat=${normalized.chatId} message=${normalized.messageId}`,
                params.logger,
                async () => {
                  const options = {
                    link_preview_options: { is_disabled: true },
                    ...(prepared.parseMode ? { parse_mode: prepared.parseMode } : {}),
                    ...(isLast && meta.inlineKeyboard
                      ? {
                          reply_markup: {
                            inline_keyboard: toTelegramInlineKeyboard(meta.inlineKeyboard)
                          }
                        }
                      : {})
                  };
                  await ctx.reply(chunks[i], options);
                }
              );
            }
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
          onDraftFailure: (error) => {
            const message = error instanceof Error ? error.message : String(error);
            params.logger.warn(
              `telegram: draft streaming failed for chat=${normalized.chatId} message=${normalized.messageId}: ${message}`
            );
          },
          trace: inboundTrace,
          observability: params.observability
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
  });

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

      const result = await params.handleCallbackQuery(normalized, inboundTrace);
      await ctx.answerCallbackQuery();

      const sendCallbackReply = async (
        text: string,
        resultType: OutboundResultType,
        isExtra: boolean,
        origin: "assistant" | "system",
        inlineKeyboard?: TelegramInlineKeyboard
      ): Promise<void> => {
        await params.observability?.record({
          event: "telegram.outbound.reply.sent",
          trace: createChildTraceContext(inboundTrace, "telegram"),
          stage: "completed",
          chatId: normalized.chatId,
          messageId: normalized.messageId,
          senderId: normalized.senderId,
          resultType,
          origin,
          text,
          isExtra,
          hasInlineKeyboard: Boolean(inlineKeyboard)
        });

        const chunks = splitTelegramMessage(text);
        for (let i = 0; i < chunks.length; i += 1) {
          const isLast = i === chunks.length - 1;
          await withTelegramRateLimitBackoff(
            `send callback reply chat=${normalized.chatId} message=${normalized.messageId}`,
            params.logger,
            async () => {
              const options = {
                link_preview_options: { is_disabled: true },
                ...(isLast && inlineKeyboard
                  ? {
                      reply_markup: {
                        inline_keyboard: toTelegramInlineKeyboard(inlineKeyboard)
                      }
                    }
                  : {})
              };
              await ctx.reply(chunks[i], options);
            }
          );
        }
      };

      switch (result.type) {
        case "reply": {
          const extras = result.extraReplies?.filter((item) => item.trim().length > 0) ?? [];
          const origin = result.origin ?? "system";
          for (const extra of extras) {
            await sendCallbackReply(extra, result.type, true, origin);
          }
          await sendCallbackReply(result.text, result.type, false, origin, result.inlineKeyboard);
          break;
        }
        case "fallback": {
          const extras = result.extraReplies?.filter((item) => item.trim().length > 0) ?? [];
          for (const extra of extras) {
            await sendCallbackReply(extra, result.type, true, "system");
          }
          await sendCallbackReply(result.text, result.type, false, "system", result.inlineKeyboard);
          break;
        }
        case "unauthorized":
          await sendCallbackReply(result.text, result.type, false, "system", result.inlineKeyboard);
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
