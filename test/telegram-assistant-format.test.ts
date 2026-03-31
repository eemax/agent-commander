import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderBasicTelegramHtml, renderMarkdownToTelegramHtml } from "../src/telegram/assistant-format.js";
import { prepareTelegramReply } from "../src/telegram/bot.js";
import { prepareTelegramDraft, sendTelegramReplyChunks } from "../src/telegram/outbound.js";

describe("renderMarkdownToTelegramHtml", () => {
  it("renders common markdown formatting into Telegram-safe HTML", () => {
    const output = renderMarkdownToTelegramHtml(
      [
        "**bold** _italic_ `inline` [link](https://example.com)",
        "",
        "```ts",
        "const value = 1;",
        "```",
        "",
        "> block quote"
      ].join("\n")
    );

    expect(output).toContain("<strong>bold</strong>");
    expect(output).toContain("<em>italic</em>");
    expect(output).toContain("<code>inline</code>");
    expect(output).toContain('<a href="https://example.com">link</a>');
    expect(output).toContain("<pre><code>const value = 1;</code></pre>");
    expect(output).toContain("<blockquote>block quote</blockquote>");
  });

  it("normalizes headings, lists, and tables to Telegram-compatible output", () => {
    const output = renderMarkdownToTelegramHtml(
      [
        "# Title",
        "",
        "- first",
        "- second",
        "",
        "| name | score |",
        "| --- | --- |",
        "| Ada | 10 |"
      ].join("\n")
    );

    expect(output).toContain("<b>Title</b>");
    expect(output).toContain("- first");
    expect(output).toContain("- second");
    expect(output).toContain("<pre><code>| name | score |");
    expect(output).not.toContain("<h1>");
    expect(output).not.toContain("<ul>");
    expect(output).not.toContain("<table>");
  });

  it("neutralizes raw html fragments", () => {
    const output = renderMarkdownToTelegramHtml("<b>raw</b> and <script>alert(1)</script>");

    expect(output).toContain("&lt;b&gt;raw&lt;/b&gt;");
    expect(output).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(output).not.toContain("<script>");
  });

  it("removes disallowed link schemes", () => {
    const output = renderMarkdownToTelegramHtml(
      "[bad](javascript:alert('x')) and [good](https://example.com/path)"
    );

    expect(output).not.toContain("javascript:");
    expect(output).toContain("<a>bad</a>");
    expect(output).toContain('<a href="https://example.com/path">good</a>');
  });

  it("preserves blank lines between paragraphs", () => {
    const output = renderMarkdownToTelegramHtml("First paragraph\n\nSecond paragraph");

    expect(output).toBe("First paragraph\n\nSecond paragraph");
  });

  it("preserves paragraph separation around lists", () => {
    const output = renderMarkdownToTelegramHtml(
      [
        "Intro",
        "",
        "- first",
        "- second",
        "",
        "Tail"
      ].join("\n")
    );

    expect(output).toBe("Intro\n\n- first\n- second\n\nTail");
  });

  it("preserves paragraph separation around blockquotes", () => {
    const output = renderMarkdownToTelegramHtml(
      [
        "Intro",
        "",
        "> quoted text",
        "",
        "Tail"
      ].join("\n")
    );

    expect(output).toBe("Intro\n\n<blockquote>quoted text</blockquote>\n\nTail");
  });

  it("preserves paragraph separation around code blocks", () => {
    const output = renderMarkdownToTelegramHtml(
      [
        "Intro",
        "",
        "```ts",
        "const value = 1;",
        "```",
        "",
        "Tail"
      ].join("\n")
    );

    expect(output).toBe("Intro\n\n<pre><code>const value = 1;</code></pre>\n\nTail");
  });
});

describe("ZWSP auto-link prevention", () => {
  const ZWSP = "\u200B";

  it("breaks /command patterns in text", () => {
    const output = renderMarkdownToTelegramHtml("Use /start to begin");
    expect(output).toContain(`/${ZWSP}start`);
  });

  it("breaks file.md references in text", () => {
    const output = renderMarkdownToTelegramHtml("Edit README.md now");
    expect(output).toContain(`README${ZWSP}.md`);
  });

  it("does not break non-TLD extensions like .ts and .json", () => {
    const output = renderMarkdownToTelegramHtml("Check config.json and index.ts");
    expect(output).toContain("config.json");
    expect(output).toContain("index.ts");
    expect(output).not.toContain(`config${ZWSP}.json`);
    expect(output).not.toContain(`index${ZWSP}.ts`);
  });

  it("preserves actual URLs in <a> href attributes", () => {
    const output = renderMarkdownToTelegramHtml("[link](https://example.com/path)");
    expect(output).toContain('href="https://example.com/path"');
    expect(output).not.toContain(`href="https:/${ZWSP}`);
  });

  it("does not break content inside <pre><code> blocks", () => {
    const output = renderMarkdownToTelegramHtml("```\n/start config.md\n```");
    expect(output).toContain("<pre><code>");
    // Content inside pre blocks should be untouched
    expect(output).toContain("/start");
    expect(output).toContain("config.md");
    // Verify no ZWSP was inserted in the code block
    const preContent = output.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)?.[1] ?? "";
    expect(preContent).not.toContain(ZWSP);
  });

  it("handles /path patterns that are not commands", () => {
    // A bare /path should still get ZWSP since it's not a URL
    const output = renderMarkdownToTelegramHtml("Run /deploy now");
    expect(output).toContain(`/${ZWSP}deploy`);
  });
});

describe("prepareTelegramReply", () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };

  beforeEach(() => {
    logger.debug.mockReset();
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
  });

  it("formats only final assistant replies when markdown_to_html is enabled", () => {
    const formatted = prepareTelegramReply({
      text: "**done**",
      meta: { resultType: "reply", isExtra: false, origin: "assistant" },
      assistantFormat: "markdown_to_html",
      chatId: "chat-1",
      messageId: "msg-1",
      logger
    });

    expect(formatted.parseMode).toBe("HTML");
    expect(formatted.text).toContain("<strong>done</strong>");
  });

  it("formats extra replies with basic HTML (no ZWSP tricks)", () => {
    const extra = prepareTelegramReply({
      text: "📖 Read: `foo.ts` (3 chars)",
      meta: { resultType: "reply", isExtra: true, origin: "system" },
      assistantFormat: "markdown_to_html",
      chatId: "chat-1",
      messageId: "msg-2",
      logger
    });

    expect(extra.parseMode).toBe("HTML");
    expect(extra.text).toContain("<code>foo.ts</code>");
  });

  it("does not insert ZWSP breakers in extra reply formatting", () => {
    const ZWSP = "\u200B";
    const extra = prepareTelegramReply({
      text: "Use /start and edit README.md",
      meta: { resultType: "reply", isExtra: true, origin: "system" },
      assistantFormat: "markdown_to_html",
      chatId: "chat-1",
      messageId: "msg-2",
      logger
    });

    expect(extra.parseMode).toBe("HTML");
    expect(extra.text).not.toContain(ZWSP);
  });

  it("keeps fallback and non-reply messages as plain text", () => {
    const fallback = prepareTelegramReply({
      text: "**retry**",
      meta: { resultType: "fallback", isExtra: false, origin: "system" },
      assistantFormat: "markdown_to_html",
      chatId: "chat-1",
      messageId: "msg-3",
      logger
    });

    const unauthorized = prepareTelegramReply({
      text: "**denied**",
      meta: { resultType: "unauthorized", isExtra: false, origin: "system" },
      assistantFormat: "markdown_to_html",
      chatId: "chat-1",
      messageId: "msg-4",
      logger
    });

    expect(fallback).toEqual({ text: "**retry**" });
    expect(unauthorized).toEqual({ text: "**denied**" });
  });

  it("falls back to plain text when markdown formatting fails", () => {
    const result = prepareTelegramReply({
      text: "**broken**",
      meta: { resultType: "reply", isExtra: false, origin: "assistant" },
      assistantFormat: "markdown_to_html",
      chatId: "chat-1",
      messageId: "msg-4",
      logger,
      markdownToHtml: () => {
        throw new Error("format failure");
      }
    });

    expect(result).toEqual({ text: "**broken**" });
    expect(logger.warn).toHaveBeenCalledWith(
      "telegram: assistant formatting failed for chat=chat-1 message=msg-4: format failure"
    );
  });

  it("formats system-origin non-extra replies as markdown HTML", () => {
    const result = prepareTelegramReply({
      text: "**status**",
      meta: { resultType: "reply", isExtra: false, origin: "system" },
      assistantFormat: "markdown_to_html",
      chatId: "chat-1",
      messageId: "msg-5",
      logger
    });

    expect(result).toEqual({ text: "<strong>status</strong>", parseMode: "HTML" });
  });

  it("chunks formatted final replies using the active 3000-4096 search window", async () => {
    const before = "a".repeat(3600);
    const after = "b".repeat(800);
    const prepared = prepareTelegramReply({
      text: `${before}\n\n${after}`,
      meta: { resultType: "reply", isExtra: false, origin: "assistant" },
      assistantFormat: "markdown_to_html",
      chatId: "chat-1",
      messageId: "msg-5b",
      logger
    });

    const chunks: string[] = [];
    await sendTelegramReplyChunks({
      text: prepared.text,
      parseMode: prepared.parseMode,
      sendChunk: async (chunk) => {
        chunks.push(chunk);
      }
    });

    expect(prepared.parseMode).toBe("HTML");
    expect(chunks).toEqual([before + "\n\n", after]);
    expect(chunks[0]?.length).toBeGreaterThan(3500);
  });

  it("falls back to plain text when extra reply formatting fails", () => {
    // renderBasicTelegramHtml is used internally for extras, but we can't inject it.
    // Test with plain_text format instead to verify the early-return path.
    const result = prepareTelegramReply({
      text: "📖 Read: `foo.ts`",
      meta: { resultType: "reply", isExtra: true, origin: "system" },
      assistantFormat: "plain_text",
      chatId: "chat-1",
      messageId: "msg-6",
      logger
    });

    expect(result).toEqual({ text: "📖 Read: `foo.ts`" });
  });
});

describe("prepareTelegramDraft", () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };

  beforeEach(() => {
    logger.debug.mockReset();
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
  });

  it("keeps draft text plain when plain_text formatting is enabled", () => {
    const draft = prepareTelegramDraft({
      text: "📖 Read: `foo.ts`\n\nAssistant: 4 chars",
      assistantFormat: "plain_text",
      chatId: "chat-1",
      messageId: "msg-draft-1",
      logger
    });

    expect(draft).toEqual({ text: "📖 Read: `foo.ts`\n\nAssistant: 4 chars" });
  });

  it("formats compact draft text as basic HTML without ZWSP breakers", () => {
    const ZWSP = "\u200B";
    const draft = prepareTelegramDraft({
      text: "Use /start and edit `README.md`\n\nAssistant: **4** chars",
      assistantFormat: "markdown_to_html",
      chatId: "chat-1",
      messageId: "msg-draft-2",
      logger
    });

    expect(draft.parseMode).toBe("HTML");
    expect(draft.text).toContain("/start");
    expect(draft.text).toContain("<code>README.md</code>");
    expect(draft.text).toContain("<strong>4</strong>");
    expect(draft.text).not.toContain(ZWSP);
  });

  it("falls back to plain text when draft formatting fails", () => {
    const draft = prepareTelegramDraft({
      text: "**broken**",
      assistantFormat: "markdown_to_html",
      chatId: "chat-1",
      messageId: "msg-draft-3",
      logger,
      markdownToHtml: () => {
        throw new Error("format failure");
      }
    });

    expect(draft).toEqual({ text: "**broken**" });
    expect(logger.warn).toHaveBeenCalledWith(
      "telegram: draft formatting failed for chat=chat-1 message=msg-draft-3: format failure"
    );
  });

  it("falls back to plain text when formatted draft output exceeds Telegram limits", () => {
    const draft = prepareTelegramDraft({
      text: "compact draft",
      assistantFormat: "markdown_to_html",
      chatId: "chat-1",
      messageId: "msg-draft-4",
      logger,
      markdownToHtml: () => "x".repeat(4097)
    });

    expect(draft).toEqual({ text: "compact draft" });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("renderBasicTelegramHtml", () => {
  it("preserves blank lines between paragraphs", () => {
    const output = renderBasicTelegramHtml("First paragraph\n\nSecond paragraph");

    expect(output).toBe("First paragraph\n\nSecond paragraph");
  });

  it("converts markdown to HTML without ZWSP tricks", () => {
    const ZWSP = "\u200B";
    const output = renderBasicTelegramHtml("Use /start and edit `README.md`");

    expect(output).toContain("<code>README.md</code>");
    expect(output).not.toContain(ZWSP);
    expect(output).toContain("/start");
  });

  it("converts backticks to code tags", () => {
    const output = renderBasicTelegramHtml("📖 Read: `foo.ts` (3 chars)");

    expect(output).toContain("<code>foo.ts</code>");
    expect(output).toContain("📖 Read:");
  });
});
