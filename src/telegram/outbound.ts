import type { RuntimeLogger, TelegramAssistantFormat } from "../runtime/contracts.js";
import type { MessageRouteResult, TelegramInlineKeyboard } from "../types.js";
import { renderBasicTelegramHtml, renderMarkdownToTelegramHtml } from "./assistant-format.js";
import { splitTelegramMessage } from "./message-split.js";

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

export type TelegramSendChunkOptions = {
  parseMode?: "HTML";
  inlineKeyboard?: TelegramInlineKeyboard;
};

export function toTelegramInlineKeyboard(
  inlineKeyboard: TelegramInlineKeyboard
): Array<Array<{ text: string; callback_data: string }>> {
  return inlineKeyboard.map((row) =>
    row.map((button) => ({
      text: button.text,
      callback_data: button.callbackData
    }))
  );
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

  return tryFormat(params, renderBasicTelegramHtml);
}

export async function sendTelegramReplyChunks(params: {
  text: string;
  parseMode?: "HTML";
  inlineKeyboard?: TelegramInlineKeyboard;
  sendChunk: (chunk: string, options: TelegramSendChunkOptions) => Promise<void>;
}): Promise<void> {
  const chunks = splitTelegramMessage(params.text, {
    parseMode: params.parseMode
  });

  for (let i = 0; i < chunks.length; i += 1) {
    const isLast = i === chunks.length - 1;
    await params.sendChunk(chunks[i]!, {
      ...(params.parseMode ? { parseMode: params.parseMode } : {}),
      ...(isLast && params.inlineKeyboard ? { inlineKeyboard: params.inlineKeyboard } : {})
    });
  }
}
