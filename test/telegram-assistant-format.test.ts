import { describe, expect, it, vi } from "vitest";
import { renderMarkdownToTelegramHtml } from "../src/telegram/assistant-format.js";
import { prepareTelegramReply } from "../src/telegram/bot.js";

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
});

describe("prepareTelegramReply", () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };

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

  it("keeps non-final assistant messages as plain text", () => {
    const extra = prepareTelegramReply({
      text: "**tool notice**",
      meta: { resultType: "reply", isExtra: true, origin: "assistant" },
      assistantFormat: "markdown_to_html",
      chatId: "chat-1",
      messageId: "msg-2",
      logger
    });

    const fallback = prepareTelegramReply({
      text: "**retry**",
      meta: { resultType: "fallback", isExtra: false, origin: "system" },
      assistantFormat: "markdown_to_html",
      chatId: "chat-1",
      messageId: "msg-3",
      logger
    });

    expect(extra).toEqual({ text: "**tool notice**" });
    expect(fallback).toEqual({ text: "**retry**" });
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

  it("keeps system-origin replies plain even when result type is reply", () => {
    const result = prepareTelegramReply({
      text: "**status**",
      meta: { resultType: "reply", isExtra: false, origin: "system" },
      assistantFormat: "markdown_to_html",
      chatId: "chat-1",
      messageId: "msg-5",
      logger
    });

    expect(result).toEqual({ text: "**status**" });
  });
});
