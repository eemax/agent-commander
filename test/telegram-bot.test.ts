import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderBasicTelegramHtml } from "../src/telegram/assistant-format.js";
import { createTelegramBot } from "../src/telegram/bot.js";

const dispatchTelegramTextMessageMock = vi.fn();
const createTelegramAttachmentResolverMock = vi.fn();
const normalizeTelegramMessageMock = vi.fn();

type MessageHandler = (ctx: FakeMessageContext) => void;

type FakeMessageContext = {
  reply: ReturnType<typeof vi.fn>;
  replyWithDraft: ReturnType<typeof vi.fn>;
  replyWithChatAction: ReturnType<typeof vi.fn>;
  react: ReturnType<typeof vi.fn>;
};

let messageHandler: MessageHandler | null = null;

vi.mock("grammy", () => ({
  Bot: class {
    api = {
      setMyCommands: vi.fn(async () => {})
    };

    on(event: string | string[], handler: MessageHandler): void {
      if (Array.isArray(event)) {
        messageHandler = handler;
      }
    }

    catch(): void {}
  }
}));

vi.mock("../src/telegram/text-dispatch.js", () => ({
  dispatchTelegramTextMessage: (...args: unknown[]) => dispatchTelegramTextMessageMock(...args)
}));

vi.mock("../src/telegram/inbound-attachments.js", () => ({
  createTelegramAttachmentResolver: (...args: unknown[]) => createTelegramAttachmentResolverMock(...args)
}));

vi.mock("../src/telegram/normalize.js", () => ({
  normalizeTelegramMessage: (...args: unknown[]) => normalizeTelegramMessageMock(...args),
  normalizeTelegramCallbackQuery: () => null
}));

describe("createTelegramBot draft formatting", () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };

  const normalizedMessage = {
    chatId: "123",
    messageId: "11",
    senderId: "22",
    senderName: "Tester",
    text: "hello",
    receivedAt: new Date().toISOString()
  };

  beforeEach(() => {
    messageHandler = null;
    dispatchTelegramTextMessageMock.mockReset();
    createTelegramAttachmentResolverMock.mockReset();
    normalizeTelegramMessageMock.mockReset();
    normalizeTelegramMessageMock.mockReturnValue(normalizedMessage);
    logger.debug.mockReset();
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
  });

  function buildContext(): FakeMessageContext {
    return {
      reply: vi.fn(async () => ({})),
      replyWithDraft: vi.fn(async () => true),
      replyWithChatAction: vi.fn(async () => true),
      react: vi.fn(async () => true)
    };
  }

  function createBot(assistantFormat: "plain_text" | "markdown_to_html"): void {
    createTelegramBot({
      token: "telegram-token",
      streamingEnabled: true,
      streamingMinUpdateMs: 100,
      draftBubbleMaxChars: 1500,
      assistantFormat,
      maxFileSizeBytes: 10 * 1024 * 1024,
      fileDownloadTimeoutMs: 30_000,
      maxConcurrentDownloads: 4,
      maxTextAttachmentBytes: 204_800,
      acknowledgedEmoji: null,
      logger,
      handleMessage: async () => ({ type: "ignore" }),
      handleCallbackQuery: async () => ({ type: "ignore" }),
      getCommands: async () => [],
      isAuthorizedSender: () => true
    });
  }

  it("sends plain compact draft text without parse mode when assistant_format is plain_text", async () => {
    let finishDispatch: (() => void) | null = null;
    const dispatched = new Promise<void>((resolve) => {
      finishDispatch = resolve;
    });

    dispatchTelegramTextMessageMock.mockImplementation(
      async (params: { sendDraft?: (text: string) => Promise<void> }) => {
        await params.sendDraft?.("📖 Read: `foo.ts`\n\nAssistant: 4 chars");
        finishDispatch?.();
        return { type: "ignore" };
      }
    );

    createBot("plain_text");
    const ctx = buildContext();

    messageHandler?.(ctx);
    await dispatched;

    expect(ctx.replyWithDraft).toHaveBeenCalledWith("📖 Read: `foo.ts`\n\nAssistant: 4 chars", undefined);
  });

  it("sends HTML-formatted compact draft text when assistant_format is markdown_to_html", async () => {
    const draftText = "Use /start and edit `README.md`\n\nAssistant: **4** chars";
    let finishDispatch: (() => void) | null = null;
    const dispatched = new Promise<void>((resolve) => {
      finishDispatch = resolve;
    });

    dispatchTelegramTextMessageMock.mockImplementation(
      async (params: { sendDraft?: (text: string) => Promise<void> }) => {
        await params.sendDraft?.(draftText);
        finishDispatch?.();
        return { type: "ignore" };
      }
    );

    createBot("markdown_to_html");
    const ctx = buildContext();

    messageHandler?.(ctx);
    await dispatched;

    expect(ctx.replyWithDraft).toHaveBeenCalledWith(
      renderBasicTelegramHtml(draftText),
      { parse_mode: "HTML" }
    );
  });
});
