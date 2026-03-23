import type { Context } from "grammy";
import type { NormalizedTelegramCallbackQuery, NormalizedTelegramMessage, TelegramAttachment } from "../types.js";

function extractSender(from: { id?: number; username?: string; first_name?: string; last_name?: string } | undefined) {
  const senderId = from?.id ? String(from.id) : "unknown";
  const senderName =
    from?.username ??
    [from?.first_name, from?.last_name].filter(Boolean).join(" ").trim() ??
    "unknown";
  return { senderId, senderName: senderName || "unknown" };
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
