import { describe, expect, it } from "vitest";
import { splitTelegramMessage, splitFinalReply, TELEGRAM_MESSAGE_LIMIT, findDraftSplitPoint } from "../src/telegram/message-split.js";

describe("splitTelegramMessage", () => {
  const MIN_CHUNK = TELEGRAM_MESSAGE_LIMIT - 1096; // 3000

  it("returns a single chunk for short text", () => {
    expect(splitTelegramMessage("hello")).toEqual(["hello"]);
  });

  it("returns a single chunk for text exactly at the limit", () => {
    const text = "a".repeat(TELEGRAM_MESSAGE_LIMIT);
    expect(splitTelegramMessage(text)).toEqual([text]);
  });

  it("prefers paragraph break within the 3000-4096 search window for plain text", () => {
    const before = "a".repeat(3600);
    const after = "b".repeat(800);
    const text = before + "\n\n" + after;

    const chunks = splitTelegramMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(before + "\n");
    expect(chunks[1]).toBe(after);
    expect(chunks[0].length).toBeGreaterThan(3500);
  });

  it("falls back to newline within the 3000-4096 search window for plain text", () => {
    const before = "a".repeat(3700);
    const after = "b".repeat(800);
    const text = before + "\n" + after;

    const chunks = splitTelegramMessage(text);
    expect(chunks).toEqual([before, after]);
  });

  it("falls back to space within the 3000-4096 search window for plain text", () => {
    const before = "a".repeat(3800);
    const after = "b".repeat(800);
    const text = before + " " + after;

    const chunks = splitTelegramMessage(text);
    expect(chunks).toEqual([before, " " + after]);
  });

  it("hard-splits at 4096 when no break exists inside the search window", () => {
    const text = "a".repeat(MIN_CHUNK - 200) + "\n" + "b".repeat(2000);
    const chunks = splitTelegramMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(TELEGRAM_MESSAGE_LIMIT);
    expect(chunks[1].length).toBe(text.length - TELEGRAM_MESSAGE_LIMIT);
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

  it("prefers paragraph breaks within the 3000-4096 search window for HTML", () => {
    const before = "a".repeat(3600);
    const after = "b".repeat(800);
    const html = `<b>${before}\n\n${after}</b>`;

    const chunks = splitTelegramMessage(html, { parseMode: "HTML" });

    expect(chunks).toEqual([
      `<b>${before}\n</b>`,
      `<b>${after}</b>`
    ]);
  });

  it("falls back to newline within the 3000-4096 search window for HTML", () => {
    const before = "a".repeat(3700);
    const after = "b".repeat(800);
    const html = `<b>${before}\n${after}</b>`;

    const chunks = splitTelegramMessage(html, { parseMode: "HTML" });

    expect(chunks).toEqual([
      `<b>${before}</b>`,
      `<b>${after}</b>`
    ]);
  });

  it("falls back to space within the 3000-4096 search window for HTML", () => {
    const before = "a".repeat(3800);
    const after = "b".repeat(800);
    const html = `<b>${before} ${after}</b>`;

    const chunks = splitTelegramMessage(html, { parseMode: "HTML" });

    expect(chunks).toEqual([
      `<b>${before}</b>`,
      `<b> ${after}</b>`
    ]);
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

describe("splitFinalReply", () => {
  const MIN_CHUNK = TELEGRAM_MESSAGE_LIMIT - 1096; // 3000

  it("returns a single chunk for short text", () => {
    expect(splitFinalReply("hello")).toEqual(["hello"]);
  });

  it("returns a single chunk at exactly the limit", () => {
    const text = "a".repeat(TELEGRAM_MESSAGE_LIMIT);
    expect(splitFinalReply(text)).toEqual([text]);
  });

  it("prefers paragraph break within search window", () => {
    const before = "a".repeat(3600);
    const after = "b".repeat(800);
    const text = before + "\n\n" + after;

    const chunks = splitFinalReply(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(before + "\n");
    expect(chunks[1]).toBe(after);
    expect(chunks[0].length).toBeGreaterThan(3500);
  });

  it("falls back to newline when no paragraph break in window", () => {
    const before = "a".repeat(3700);
    const after = "b".repeat(800);
    const text = before + "\n" + after;

    const chunks = splitFinalReply(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(before);
    expect(chunks[1]).toBe(after);
  });

  it("falls back to space when no newlines in window", () => {
    const before = "a".repeat(3800);
    const after = "b".repeat(800);
    const text = before + " " + after;

    const chunks = splitFinalReply(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(before);
    expect(chunks[1]).toBe(" " + after);
  });

  it("hard-splits at 4096 when no break is found inside the search window", () => {
    const text = "a".repeat(MIN_CHUNK - 200) + "\n" + "b".repeat(2000);
    const chunks = splitFinalReply(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(text.slice(0, TELEGRAM_MESSAGE_LIMIT));
    expect(chunks[1]).toBe(text.slice(TELEGRAM_MESSAGE_LIMIT));
  });

  it("splits into multiple chunks for very long text", () => {
    const text = "a".repeat(5000);
    const chunks = splitFinalReply(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(TELEGRAM_MESSAGE_LIMIT));
    expect(chunks[1]).toBe("a".repeat(5000 - TELEGRAM_MESSAGE_LIMIT));
  });
});
