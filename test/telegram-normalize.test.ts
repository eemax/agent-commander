import { describe, expect, it } from "vitest";
import { normalizeTelegramCallbackQuery, normalizeTelegramMessage } from "../src/telegram/normalize.js";

describe("normalizeTelegramMessage", () => {
  it("returns null when message is missing", () => {
    expect(normalizeTelegramMessage({} as never)).toBeNull();
  });

  it("returns null for non-text payloads", () => {
    const ctx = {
      message: {
        chat: { id: 1 },
        message_id: 2,
        photo: []
      }
    };
    expect(normalizeTelegramMessage(ctx as never)).toBeNull();
  });

  it("returns null for blank text", () => {
    const ctx = {
      message: {
        chat: { id: 1 },
        message_id: 2,
        text: "   "
      }
    };
    expect(normalizeTelegramMessage(ctx as never)).toBeNull();
  });

  it("uses username when available", () => {
    const ctx = {
      message: {
        chat: { id: -100 },
        message_id: 42,
        text: " hello ",
        from: {
          id: 77,
          username: "agent_user",
          first_name: "Ada",
          last_name: "Lovelace"
        }
      }
    };

    const normalized = normalizeTelegramMessage(ctx as never);
    expect(normalized).not.toBeNull();
    expect(normalized?.chatId).toBe("-100");
    expect(normalized?.messageId).toBe("42");
    expect(normalized?.senderId).toBe("77");
    expect(normalized?.senderName).toBe("agent_user");
    expect(normalized?.text).toBe("hello");
  });

  it("falls back to first and last name", () => {
    const ctx = {
      message: {
        chat: { id: 10 },
        message_id: 11,
        text: "hi",
        from: {
          id: 12,
          first_name: "Ada",
          last_name: "Lovelace"
        }
      }
    };

    const normalized = normalizeTelegramMessage(ctx as never);
    expect(normalized?.senderName).toBe("Ada Lovelace");
  });

  it("falls back to unknown sender metadata", () => {
    const ctx = {
      message: {
        chat: { id: 10 },
        message_id: 11,
        text: "hi"
      }
    };

    const normalized = normalizeTelegramMessage(ctx as never);
    expect(normalized?.senderId).toBe("unknown");
    expect(normalized?.senderName).toBe("unknown");
  });
});

describe("normalizeTelegramCallbackQuery", () => {
  it("returns null when callback payload is missing", () => {
    expect(normalizeTelegramCallbackQuery({} as never)).toBeNull();
  });

  it("returns null for blank callback data", () => {
    const ctx = {
      callbackQuery: {
        id: "cb-1",
        data: "   ",
        from: { id: 1 },
        message: {
          chat: { id: 10 },
          message_id: 20
        }
      }
    };

    expect(normalizeTelegramCallbackQuery(ctx as never)).toBeNull();
  });

  it("normalizes callback query metadata", () => {
    const ctx = {
      callbackQuery: {
        id: "cb-42",
        data: "convmenu:abc:n",
        from: {
          id: 77,
          username: "agent_user"
        },
        message: {
          chat: { id: -100 },
          message_id: 99
        }
      }
    };

    const normalized = normalizeTelegramCallbackQuery(ctx as never);
    expect(normalized).not.toBeNull();
    expect(normalized?.callbackQueryId).toBe("cb-42");
    expect(normalized?.chatId).toBe("-100");
    expect(normalized?.messageId).toBe("99");
    expect(normalized?.senderId).toBe("77");
    expect(normalized?.senderName).toBe("agent_user");
    expect(normalized?.data).toBe("convmenu:abc:n");
  });
});
