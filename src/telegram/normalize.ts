import type { Context } from "grammy";
import type { NormalizedTelegramCallbackQuery, NormalizedTelegramMessage } from "../types.js";

export function normalizeTelegramMessage(ctx: Context): NormalizedTelegramMessage | null {
  const message = ctx.message;
  if (!message || !("text" in message) || typeof message.text !== "string") {
    return null;
  }

  const text = message.text.trim();
  if (text.length === 0) {
    return null;
  }

  const senderId = message.from?.id ? String(message.from.id) : "unknown";
  const senderName =
    message.from?.username ??
    [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ").trim() ??
    "unknown";

  return {
    chatId: String(message.chat.id),
    messageId: String(message.message_id),
    senderId,
    senderName: senderName || "unknown",
    text,
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
