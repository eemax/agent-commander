import type { Context } from "grammy";
import type { NormalizedTelegramCallbackQuery, NormalizedTelegramMessage, TelegramAttachment } from "../types.js";

function extractSender(from: { id?: number; username?: string; first_name?: string; last_name?: string } | undefined) {
  const senderId = from?.id ? String(from.id) : "unknown";
  const raw =
    from?.username ??
    [from?.first_name, from?.last_name].filter(Boolean).join(" ").trim() ??
    "unknown";
  const senderName = (raw || "unknown").slice(0, 128);
  return { senderId, senderName };
}

export function normalizeTelegramMessage(ctx: Context): NormalizedTelegramMessage | null {
  const message = ctx.message;
  if (!message) return null;

  const text = (message.text ?? message.caption ?? "").trim();
  const attachments: TelegramAttachment[] = [];

  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1]!;
    attachments.push({
      fileId: largest.file_id,
      fileName: null,
      mimeType: "image/jpeg",
      fileSize: largest.file_size ?? null
    });
  }

  if (message.document) {
    attachments.push({
      fileId: message.document.file_id,
      fileName: message.document.file_name ?? null,
      mimeType: message.document.mime_type ?? null,
      fileSize: message.document.file_size ?? null
    });
  }

  if (message.video) {
    attachments.push({
      fileId: message.video.file_id,
      fileName: null,
      mimeType: message.video.mime_type ?? "video/mp4",
      fileSize: message.video.file_size ?? null
    });
  }

  if (message.audio) {
    attachments.push({
      fileId: message.audio.file_id,
      fileName: message.audio.file_name ?? null,
      mimeType: message.audio.mime_type ?? "audio/mpeg",
      fileSize: message.audio.file_size ?? null
    });
  }

  if (message.voice) {
    attachments.push({
      fileId: message.voice.file_id,
      fileName: null,
      mimeType: message.voice.mime_type ?? "audio/ogg",
      fileSize: message.voice.file_size ?? null
    });
  }

  if (message.animation) {
    attachments.push({
      fileId: message.animation.file_id,
      fileName: message.animation.file_name ?? null,
      mimeType: message.animation.mime_type ?? "video/mp4",
      fileSize: message.animation.file_size ?? null
    });
  }

  if (text.length === 0 && attachments.length === 0) {
    return null;
  }

  const { senderId, senderName } = extractSender(message.from);

  return {
    chatId: String(message.chat.id),
    messageId: String(message.message_id),
    senderId,
    senderName,
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    receivedAt: new Date().toISOString()
  };
}

export function normalizeTelegramCallbackQuery(ctx: Context): NormalizedTelegramCallbackQuery | null {
  const callback = ctx.callbackQuery;
  const message = callback?.message;
  if (!callback || typeof callback.id !== "string" || typeof callback.data !== "string") {
    return null;
  }

  if (!message || !("message_id" in message) || !message.chat) {
    return null;
  }

  const data = callback.data.trim();
  if (data.length === 0) {
    return null;
  }

  const senderId = callback.from?.id ? String(callback.from.id) : "unknown";
  const senderName =
    callback.from?.username ??
    [callback.from?.first_name, callback.from?.last_name].filter(Boolean).join(" ").trim() ??
    "unknown";

  return {
    callbackQueryId: callback.id,
    chatId: String(message.chat.id),
    messageId: String(message.message_id),
    senderId,
    senderName: senderName || "unknown",
    data,
    receivedAt: new Date().toISOString()
  };
}
