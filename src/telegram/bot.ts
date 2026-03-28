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
  RetainedTurnHandle,
  TelegramInlineKeyboard,
  TelegramCommandDefinition,
  ContentPart,
  TurnRetentionRegistrar
} from "../types.js";
import { downloadTelegramFile, FileTooLargeError } from "./file-download.js";
import { resolveAttachmentContentParts } from "./attachment-resolve.js";
import { extractAttachMarkers, resolveOutboundAttachment, type OutboundAttachment } from "./outbound-attachments.js";
import { Semaphore } from "../concurrency.js";
import { renderBasicTelegramHtml, renderMarkdownToTelegramHtml } from "./assistant-format.js";
import { splitTelegramMessage, TELEGRAM_MESSAGE_LIMIT } from "./message-split.js";
import { StreamTranscript } from "./stream-transcript.js";
import { normalizeTelegramCallbackQuery, normalizeTelegramMessage } from "./normalize.js";
import { VERBOSE_REPLACE_PREFIX } from "../routing/formatters.js";

export type TelegramTextHandler = (
  message: NormalizedTelegramMessage,
  stream?: MessageStreamingSink,
  trace?: TraceContext,
  userContent?: string | ContentPart[],
  attachmentResolver?: import("../message-queue.js").AttachmentResolver,
  turnRetention?: TurnRetentionRegistrar
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
  draftBubbleMaxChars?: number;
  onDraftFailure?: (error: unknown) => void | Promise<void>;
  nowMs?: () => number;
  trace?: TraceContext;
  observability?: ObservabilitySink;
  userContent?: string | ContentPart[];
  attachmentResolver?: import("../message-queue.js").AttachmentResolver;
  sendAcknowledgedReaction?: () => Promise<void>;
  sendProcessingAction?: () => Promise<void>;
  processingActionRefreshMs?: number;
  shouldSuppressOutput?: () => boolean;
  onSettled?: () => Promise<void>;
}): Promise<MessageRouteResult> {
  const messageTrace = params.trace ?? createTraceRootContext("telegram");
  const nowMs = params.nowMs ?? Date.now;
  const draftMinUpdateMs = Math.max(1, params.draftMinUpdateMs ?? 100);
  const draftBubbleMaxChars = params.draftBubbleMaxChars ?? 750;
  const shouldSuppressOutput = (): boolean => params.shouldSuppressOutput?.() === true;
  const transcript = new StreamTranscript();
  let lastRenderedDraft = "";
  let lastDraftAtMs: number | null = null;
  let draftDisabled = !params.sendDraft;

  // Lifecycle signal state
  let acknowledged = false;
  let processingTimer: ReturnType<typeof setInterval> | null = null;
  const processingActionRefreshMs = params.processingActionRefreshMs ?? 4000;

  try {

  const stopProcessingIndicator = (): void => {
    if (processingTimer !== null) {
      clearInterval(processingTimer);
      processingTimer = null;
    }
  };

  const startProcessingIndicator = (): void => {
    if (!params.sendProcessingAction) return;
    stopProcessingIndicator();
    params.sendProcessingAction().catch(() => {});
    processingTimer = setInterval(() => {
      params.sendProcessingAction!().catch(() => {});
    }, processingActionRefreshMs);
  };

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
    if (shouldSuppressOutput()) {
      return;
    }

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

  const flushDraft = async (force: boolean): Promise<void> => {
    if (draftDisabled || !params.sendDraft || shouldSuppressOutput()) {
      return;
    }

    const rendered = transcript.renderDraft(draftBubbleMaxChars);
    if (rendered.trim().length === 0 || rendered === lastRenderedDraft) {
      return;
    }

    const now = nowMs();
    if (!force && lastDraftAtMs !== null && now - lastDraftAtMs < draftMinUpdateMs) {
      return;
    }

    // Skip if a typing-indicator send is already in-flight
    if (!force && draftInflight) {
      return;
    }

    draftInflight = true;
    try {
      await params.observability?.record({
        event: "telegram.outbound.draft.sent",
        trace: createChildTraceContext(messageTrace, "telegram"),
        stage: "completed",
        chatId: params.message.chatId,
        messageId: params.message.messageId,
        senderId: params.message.senderId,
        text: rendered,
        forced: force
      });
      await params.sendDraft(rendered);
      lastRenderedDraft = rendered;
      lastDraftAtMs = nowMs();
    } catch (error) {
      await disableDraft(error);
    } finally {
      draftInflight = false;
    }
  };

  const hasLifecycleCallbacks = Boolean(params.sendAcknowledgedReaction || params.sendProcessingAction);
  const stream: MessageStreamingSink | undefined = (params.sendDraft || hasLifecycleCallbacks)
    ? {
        onTextDelta: params.sendDraft ? async (delta: string) => {
          await ensureTypingStarted();
          await stopTypingIndicator();

          if (draftDisabled || typeof delta !== "string" || delta.length === 0) {
            return;
          }

          transcript.appendTextDelta(delta);
          await flushDraft(false);
          startTypingIndicator();
        } : undefined,
        onToolCallNotice: params.sendDraft ? async (notice: string) => {
          await ensureTypingStarted();
          await stopTypingIndicator();

          if (typeof notice !== "string") {
            return;
          }

          // Empty notice = tool-phase entry signal (tool execution starting).
          // Start typing indicator without adding content.
          if (notice.length === 0) {
            transcript.setToolExecutionActive(true);
            startTypingIndicator();
            return;
          }

          const isReplace = notice.startsWith(VERBOSE_REPLACE_PREFIX);
          const text = isReplace ? notice.slice(VERBOSE_REPLACE_PREFIX.length) : notice;
          transcript.appendToolNotice(text, { replace: isReplace });
          await flushDraft(false);
          startTypingIndicator();
        } : undefined,
        onLifecycleEvent: hasLifecycleCallbacks ? async (event: import("../types.js").ProviderLifecycleEvent) => {
          if (event.type === "response_acknowledged") {
            if (!acknowledged && params.sendAcknowledgedReaction) {
              acknowledged = true;
              try {
                await params.sendAcknowledgedReaction();
                await params.observability?.record({
                  event: "telegram.outbound.acknowledged.sent",
                  trace: createChildTraceContext(messageTrace, "telegram"),
                  stage: "completed",
                  chatId: params.message.chatId,
                  messageId: params.message.messageId
                });
              } catch (error) {
                await params.observability?.record({
                  event: "telegram.outbound.acknowledged.failed",
                  trace: createChildTraceContext(messageTrace, "telegram"),
                  stage: "failed",
                  chatId: params.message.chatId,
                  messageId: params.message.messageId,
                  error
                });
              }
            }
          } else if (event.type === "response_processing_started") {
            if (processingTimer === null) {
              startProcessingIndicator();
              await params.observability?.record({
                event: "telegram.outbound.processing.started",
                trace: createChildTraceContext(messageTrace, "telegram"),
                stage: "started",
                chatId: params.message.chatId,
                messageId: params.message.messageId
              });
            }
          }
        } : undefined
      }
    : undefined;

  const TYPING_FRAMES = ["◐", "◓", "◑", "◒"];
  let typingFrameIndex = 0;
  let draftWorkerActive = false;
  let draftInflight = false;
  let draftWorkerPromise: Promise<void> | null = null;
  let draftWorkerController: AbortController | null = null;

  const waitForDraftInterval = (signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, draftMinUpdateMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });

  const stopTypingIndicator = async (): Promise<void> => {
    draftWorkerActive = false;
    draftWorkerController?.abort();
    const runningWorker = draftWorkerPromise;
    if (runningWorker) {
      await runningWorker;
    }
  };

  const startTypingIndicator = (): void => {
    if (draftDisabled || !params.sendDraft || draftWorkerPromise) return;
    draftWorkerActive = true;
    let consecutiveErrors = 0;
    const workerController = new AbortController();
    draftWorkerController = workerController;

    let workerPromise: Promise<void> | null = null;
    const runWorker = async (): Promise<void> => {
      try {
        while (draftWorkerActive && !draftDisabled && params.sendDraft && !workerController.signal.aborted) {
          await waitForDraftInterval(workerController.signal);
          if (!draftWorkerActive || draftDisabled || !params.sendDraft || workerController.signal.aborted) break;

          // Skip if another send is in-flight or was sent recently
          const now = nowMs();
          if (draftInflight || (lastDraftAtMs !== null && now - lastDraftAtMs < draftMinUpdateMs)) continue;

          const frame = TYPING_FRAMES[typingFrameIndex % TYPING_FRAMES.length]!;
          typingFrameIndex += 1;
          const rendered = transcript.renderDraft(draftBubbleMaxChars - frame.length - 1);
          const prefix = rendered.length > 0 ? rendered + "\n" : "";
          const candidate = prefix + frame;
          const draft = candidate.length > TELEGRAM_MESSAGE_LIMIT ? rendered : candidate;

          draftInflight = true;
          try {
            await params.sendDraft(draft);
            lastRenderedDraft = draft;
            lastDraftAtMs = nowMs();
            consecutiveErrors = 0;
          } catch {
            consecutiveErrors += 1;
            if (consecutiveErrors >= 3) {
              draftWorkerActive = false;
              return;
            }
          } finally {
            draftInflight = false;
          }
        }
      } finally {
        if (draftWorkerPromise === workerPromise) {
          draftWorkerPromise = null;
        }
        if (draftWorkerController === workerController) {
          draftWorkerController = null;
        }
      }
    };

    workerPromise = runWorker();
    draftWorkerPromise = workerPromise;
  };

  let initialTypingStarted = false;
  const ensureTypingStarted = async (): Promise<void> => {
    if (initialTypingStarted || draftDisabled || !params.sendDraft) {
      return;
    }
    initialTypingStarted = true;
    try {
      await params.sendDraft(TYPING_FRAMES[0]!);
      lastDraftAtMs = nowMs();
      lastRenderedDraft = TYPING_FRAMES[0]!;
      typingFrameIndex = 1;
      startTypingIndicator();
    } catch (error) {
      await disableDraft(error);
    }
  };

  let result: MessageRouteResult;
  try {
    result = await params.handleMessage(params.message, stream, messageTrace, params.userContent, params.attachmentResolver);
  } finally {
    await stopTypingIndicator();
    if (processingTimer !== null) {
      await params.observability?.record({
        event: "telegram.outbound.processing.stopped",
        trace: createChildTraceContext(messageTrace, "telegram"),
        stage: "completed",
        chatId: params.message.chatId,
        messageId: params.message.messageId
      });
    }
    stopProcessingIndicator();
  }
  if (shouldSuppressOutput()) {
    return { type: "ignore" };
  }
  await flushDraft(true);
  transcript.commitLiveDraft();

  const sendExtractedAttachments = async (markerPaths: string[]): Promise<void> => {
    if (!params.sendAttachment || !params.logger || markerPaths.length === 0 || shouldSuppressOutput()) {
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
      const finalText = transcript.buildFinalReplyText(cleanText);
      await sendOutbound(finalText, result.type, false, origin, result.inlineKeyboard);
      await sendExtractedAttachments(markers);
      break;
    }
    case "fallback": {
      const extras = result.extraReplies?.filter((item) => item.trim().length > 0) ?? [];
      const { cleanText, markers } = extractAttachMarkers(result.text);
      for (const extra of extras) {
        await sendOutbound(extra, result.type, true, "system");
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
  } finally {
    await params.onSettled?.();
  }
}

export function createTelegramBot(params: {
  token: string;
  streamingEnabled: boolean;
  streamingMinUpdateMs: number;
  draftBubbleMaxChars: number;
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
      let retainedTurn: RetainedTurnHandle | null = null;
      try {
        // Create a lazy attachment resolver instead of downloading eagerly.
        // Attachments are only fetched when routing decides to execute the message.
        const attachmentResolver = (normalized.attachments && normalized.attachments.length > 0 && params.isAuthorizedSender(normalized.senderId))
          ? async (): Promise<import("../message-queue.js").AttachmentResolverResult> => {
              const downloaded = [];
              const errors: string[] = [];

              for (const attachment of normalized.attachments!) {
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
                logger: params.logger,
                maxTextBytes: params.maxTextAttachmentBytes
              });

              for (const mime of rejected) {
                errors.push(`Unsupported file type: ${mime}. I can process images, PDFs, and text files.`);
              }

              let userContent: string | ContentPart[] | undefined;
              if (parts.length > 0) {
                const contentParts: ContentPart[] = [];
                if (normalized.text.length > 0) {
                  contentParts.push({ type: "text", text: normalized.text });
                }
                contentParts.push(...parts);
                userContent = contentParts;
              }

              return { userContent, errors };
            }
          : undefined;

        await dispatchTelegramTextMessage({
          message: normalized,
          handleMessage: (message, stream, trace, userContent, resolver) =>
            params.handleMessage(message, stream, inboundTrace, userContent, resolver, {
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
          draftBubbleMaxChars: params.draftBubbleMaxChars,
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

      // Dismiss the Telegram loading spinner immediately, before handler execution
      await ctx.answerCallbackQuery().catch(() => {});
      const result = await params.handleCallbackQuery(normalized, inboundTrace);

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
