import { describe, expect, it } from "vitest";
import { splitTelegramMessage, TELEGRAM_MESSAGE_LIMIT, findDraftSplitPoint } from "../src/telegram/message-split.js";

describe("splitTelegramMessage", () => {
  it("returns a single chunk for short text", () => {
    expect(splitTelegramMessage("hello")).toEqual(["hello"]);
  });

  it("returns a single chunk for text exactly at the limit", () => {
    const text = "a".repeat(TELEGRAM_MESSAGE_LIMIT);
    expect(splitTelegramMessage(text)).toEqual([text]);
  });

  it("prefers paragraph break over line break for plain text split", () => {
    // Build text with both \n and \n\n — the split should happen at \n\n
    const paragraph1 = ("a".repeat(80) + "\n").repeat(30).trimEnd(); // ~2430 chars with \n
    const paragraph2 = ("b".repeat(80) + "\n").repeat(30).trimEnd(); // ~2430 chars with \n
    const text = paragraph1 + "\n\n" + paragraph2;
    expect(text.length).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT);

    const chunks = splitTelegramMessage(text);
    expect(chunks.length).toBe(2);
    // Split happens at \n\n: first chunk gets paragraph1 + trailing \n,
    // second chunk starts clean after the paragraph break
    expect(chunks[0]).toBe(paragraph1 + "\n");
    expect(chunks[1]).toBe(paragraph2);
  });

  it("splits plain text at newline boundary", () => {
    const line = "a".repeat(100);
    const lines = Array.from({ length: 50 }, () => line);
    const text = lines.join("\n");
    expect(text.length).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT);

    const chunks = splitTelegramMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
    // Rejoining should reconstruct (with newlines consumed at boundaries)
    expect(chunks.join("\n").replace(/\n+/g, "\n")).toContain(line);
  });

  it("splits plain text at space boundary when no newlines available", () => {
    const word = "abcdefgh ";
    const text = word.repeat(Math.ceil(TELEGRAM_MESSAGE_LIMIT / word.length) + 10);
    expect(text.length).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT);

    const chunks = splitTelegramMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
  });

  it("hard-splits when no whitespace available", () => {
    const text = "x".repeat(TELEGRAM_MESSAGE_LIMIT + 100);
    const chunks = splitTelegramMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(TELEGRAM_MESSAGE_LIMIT);
    expect(chunks[1].length).toBe(100);
  });

  it("splits HTML with proper tag closing and reopening", () => {
    const inner = "a".repeat(TELEGRAM_MESSAGE_LIMIT - 50);
    const html = `<b>${inner} continuation text that pushes over the limit</b>`;
    expect(html.length).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT);

    const chunks = splitTelegramMessage(html, { parseMode: "HTML" });
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should end with closing tag
    expect(chunks[0]).toContain("</b>");
    // Second chunk should start with opening tag
    expect(chunks[1]).toMatch(/^<b>/);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
  });

  it("handles nested HTML tags across split boundaries", () => {
    // Need enough content that even with tag overhead, it exceeds the limit
    const inner = "x ".repeat(Math.ceil(TELEGRAM_MESSAGE_LIMIT / 2));
    const html = `<b><i>${inner}</i></b>`;
    expect(html.length).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT);

    const chunks = splitTelegramMessage(html, { parseMode: "HTML" });
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should close tags in reverse order
    expect(chunks[0]).toMatch(/<\/i><\/b>$/);
    // Second chunk should reopen tags in original order
    expect(chunks[1]).toMatch(/^<b><i>/);
  });

  it("preserves a href attributes when reopening tags", () => {
    const inner = "w ".repeat(Math.ceil(TELEGRAM_MESSAGE_LIMIT / 2));
    const html = `<a href="https://example.com">${inner}</a>`;
    expect(html.length).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT);

    const chunks = splitTelegramMessage(html, { parseMode: "HTML" });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1]).toContain('href="https://example.com"');
  });
});

describe("findDraftSplitPoint", () => {
  it("prefers \\n\\n over \\n over space", () => {
    const text = "aaa bbb\nccc\n\nddd";
    const idx = findDraftSplitPoint(text, text.length);
    // Should split after \n\n
    expect(text.slice(0, idx)).toBe("aaa bbb\nccc\n\n");
    expect(text.slice(idx)).toBe("ddd");
  });

  it("falls back to \\n when no \\n\\n exists", () => {
    const text = "aaa bbb\nccc ddd";
    const idx = findDraftSplitPoint(text, text.length);
    expect(text.slice(0, idx)).toBe("aaa bbb\n");
  });

  it("falls back to space when no newlines exist", () => {
    const text = "aaa bbb ccc";
    const idx = findDraftSplitPoint(text, text.length);
    expect(text.slice(0, idx)).toBe("aaa bbb ");
  });

  it("returns -1 when no split point exists", () => {
    const text = "abcdef";
    const idx = findDraftSplitPoint(text, text.length);
    expect(idx).toBe(-1);
  });

  it("only searches within the window", () => {
    // \n\n is outside the window (at position 3), only space is inside
    const text = "aa\n\n" + "b".repeat(600) + " ccc";
    const idx = findDraftSplitPoint(text, 596);
    // Should NOT find the \n\n (outside window), should find the space
    expect(idx).toBeGreaterThan(4);
    expect(text[idx - 1]).toBe(" ");
  });
});
