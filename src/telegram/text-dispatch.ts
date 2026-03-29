import type { RuntimeLogger } from "../runtime/contracts.js";
import {
  createChildTraceContext,
  createTraceRootContext,
  type ObservabilitySink,
  type TraceContext
} from "../observability.js";
import type {
  ContentPart,
  MessageRouteResult,
  MessageStreamingSink,
  NormalizedTelegramMessage,
  ProviderLifecycleEvent,
  TurnRetentionRegistrar
} from "../types.js";
import type { AttachmentResolver } from "../message-queue.js";
import { VERBOSE_REPLACE_PREFIX } from "../routing/formatters.js";
import { extractAttachMarkers, resolveOutboundAttachment, type OutboundAttachment } from "./outbound-attachments.js";
import { TELEGRAM_MESSAGE_LIMIT } from "./message-split.js";
import { StreamTranscript } from "./stream-transcript.js";
import type { OutboundResultType, TelegramOutboundReplyMeta } from "./outbound.js";

export type TelegramTextHandler = (
  message: NormalizedTelegramMessage,
  stream?: MessageStreamingSink,
  trace?: TraceContext,
  userContent?: string | ContentPart[],
  attachmentResolver?: AttachmentResolver,
  turnRetention?: TurnRetentionRegistrar
) => Promise<MessageRouteResult>;

export async function dispatchTelegramTextMessage(params: {
  message: NormalizedTelegramMessage;
  handleMessage: TelegramTextHandler;
  sendReply: (text: string, meta: TelegramOutboundReplyMeta) => Promise<void>;
  sendDraft?: (text: string) => Promise<void>;
  sendAttachment?: (attachment: OutboundAttachment) => Promise<void>;
  logger?: RuntimeLogger;
  draftMinUpdateMs?: number;
  draftBubbleMaxChars?: number;
  draftPreviewMaxSentences?: number;
  draftPreviewMaxChars?: number;
  onDraftFailure?: (error: unknown) => void | Promise<void>;
  nowMs?: () => number;
  trace?: TraceContext;
  observability?: ObservabilitySink;
  userContent?: string | ContentPart[];
  attachmentResolver?: AttachmentResolver;
  sendAcknowledgedReaction?: () => Promise<void>;
  sendProcessingAction?: () => Promise<void>;
  processingActionRefreshMs?: number;
  shouldSuppressOutput?: () => boolean;
  onSettled?: () => Promise<void>;
}): Promise<MessageRouteResult> {
  const messageTrace = params.trace ?? createTraceRootContext("telegram");
  const nowMs = params.nowMs ?? Date.now;
  const draftMinUpdateMs = Math.max(1, params.draftMinUpdateMs ?? 1000);
  const draftBubbleMaxChars = params.draftBubbleMaxChars ?? 1500;
  const draftPreviewMaxSentences = Math.max(1, params.draftPreviewMaxSentences ?? 3);
  const draftPreviewMaxChars = Math.max(1, params.draftPreviewMaxChars ?? 280);
  const shouldSuppressOutput = (): boolean => params.shouldSuppressOutput?.() === true;
  const transcript = new StreamTranscript({
    draftPreviewMaxSentences,
    draftPreviewMaxChars
  });
  let lastRenderedDraft = "";
  let lastDraftMode: "content" | "typing" | "reset" | null = null;
  let lastDraftAtMs: number | null = null;
  let draftDisabled = !params.sendDraft;
  let draftInflight = false;

  let acknowledged = false;
  let processingTimer: ReturnType<typeof setInterval> | null = null;
  const processingActionRefreshMs = params.processingActionRefreshMs ?? 4000;

  const TYPING_FRAMES = ["◐", "◓", "◑", "◒"];
  const RESET_DRAFT_FRAME = TYPING_FRAMES[0]!;
  let typingFrameIndex = 0;
  let draftWorkerActive = false;
  let draftWorkerPromise: Promise<void> | null = null;
  let draftWorkerController: AbortController | null = null;
  let initialTypingStarted = false;

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
      inlineKeyboard?: TelegramOutboundReplyMeta["inlineKeyboard"]
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
      if (rendered.kind === "empty") {
        return;
      }

      const isReset = rendered.kind === "reset";
      const draft = isReset ? RESET_DRAFT_FRAME : rendered.text;
      if (draft.trim().length === 0 || draft === lastRenderedDraft) {
        return;
      }

      const now = nowMs();
      if (!isReset && !force && lastDraftAtMs !== null && now - lastDraftAtMs < draftMinUpdateMs) {
        return;
      }

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
          text: draft,
          forced: force
        });
        await params.sendDraft(draft);
        lastRenderedDraft = draft;
        lastDraftMode = isReset ? "reset" : "content";
        lastDraftAtMs = nowMs();
      } catch (error) {
        await disableDraft(error);
      } finally {
        draftInflight = false;
      }
    };

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

            const now = nowMs();
            if (draftInflight || (lastDraftAtMs !== null && now - lastDraftAtMs < draftMinUpdateMs)) continue;

            const frame = TYPING_FRAMES[typingFrameIndex % TYPING_FRAMES.length]!;
            typingFrameIndex += 1;
            const rendered = transcript.renderDraft(draftBubbleMaxChars - frame.length - 1);

            let draft: string | null = null;
            let draftMode: "typing" | "reset" = "typing";
            if (rendered.kind === "reset") {
              draft = RESET_DRAFT_FRAME;
              draftMode = "reset";
            } else if (rendered.kind === "content") {
              const prefix = rendered.text.length > 0 ? rendered.text + "\n" : "";
              const candidate = prefix + frame;
              draft = candidate.length > TELEGRAM_MESSAGE_LIMIT ? rendered.text : candidate;
            } else if (lastDraftMode !== "reset") {
              draft = frame;
            }

            if (!draft || draft === lastRenderedDraft) {
              continue;
            }

            draftInflight = true;
            try {
              await params.sendDraft(draft);
              lastRenderedDraft = draft;
              lastDraftMode = draftMode;
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

    const ensureTypingStarted = async (): Promise<void> => {
      if (initialTypingStarted || draftDisabled || !params.sendDraft) {
        return;
      }
      initialTypingStarted = true;
      try {
        await params.sendDraft(RESET_DRAFT_FRAME);
        lastDraftAtMs = nowMs();
        lastRenderedDraft = RESET_DRAFT_FRAME;
        lastDraftMode = "typing";
        typingFrameIndex = 1;
        startTypingIndicator();
      } catch (error) {
        await disableDraft(error);
      }
    };

    const hasLifecycleCallbacks = Boolean(params.sendAcknowledgedReaction || params.sendProcessingAction);
    const stream: MessageStreamingSink | undefined = (params.sendDraft || hasLifecycleCallbacks)
      ? {
          onTextDelta: params.sendDraft
            ? async (delta: string) => {
                await ensureTypingStarted();
                await stopTypingIndicator();

                if (draftDisabled || typeof delta !== "string" || delta.length === 0) {
                  return;
                }

                transcript.appendTextDelta(delta);
                await flushDraft(false);
                startTypingIndicator();
              }
            : undefined,
          onToolCallNotice: params.sendDraft
            ? async (notice: string) => {
                await ensureTypingStarted();
                await stopTypingIndicator();

                if (typeof notice !== "string") {
                  return;
                }

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
              }
            : undefined,
          onLifecycleEvent: hasLifecycleCallbacks
            ? async (event: ProviderLifecycleEvent) => {
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
              }
            : undefined
        }
      : undefined;

    let result: MessageRouteResult;
    try {
      result = await params.handleMessage(
        params.message,
        stream,
        messageTrace,
        params.userContent,
        params.attachmentResolver
      );
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
      case "reply":
      case "fallback": {
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
