export const TELEGRAM_MESSAGE_LIMIT = 4096;

type SplitOptions = {
  parseMode?: "HTML";
};

/**
 * Split a message into chunks that fit within Telegram's 4096-char limit.
 * In HTML mode, properly closes and reopens tags across chunk boundaries.
 */
export function splitTelegramMessage(text: string, options?: SplitOptions): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  if (options?.parseMode === "HTML") {
    return splitHtml(text);
  }

  return splitPlainText(text);
}

function splitPlainText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    const slice = remaining.slice(0, TELEGRAM_MESSAGE_LIMIT);
    let splitAt = slice.lastIndexOf("\n");
    if (splitAt <= 0) {
      splitAt = slice.lastIndexOf(" ");
    }
    if (splitAt <= 0) {
      splitAt = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

type OpenTag = {
  name: string;
  full: string; // e.g. '<a href="...">' or '<b>'
};

const TAG_OPEN_REGEX = /<([a-z][a-z0-9-]*)((?:\s[^>]*)?)>/gi;
const TAG_CLOSE_REGEX = /<\/([a-z][a-z0-9-]*)>/gi;
const TRACKED_TAGS = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del",
  "a", "code", "pre", "blockquote", "tg-spoiler", "span", "tg-emoji", "tg-time"
]);

function closingTagsFor(stack: OpenTag[]): string {
  return [...stack].reverse().map((t) => `</${t.name}>`).join("");
}

function openingTagsFor(stack: OpenTag[]): string {
  return stack.map((t) => t.full).join("");
}

function tagOverhead(stack: OpenTag[]): number {
  if (stack.length === 0) return 0;
  return closingTagsFor(stack).length + openingTagsFor(stack).length;
}

function splitHtml(text: string): string[] {
  const chunks: string[] = [];
  const tagStack: OpenTag[] = [];
  let currentChunk = "";
  let i = 0;

  while (i < text.length) {
    // Check if we're at a tag
    if (text[i] === "<") {
      const closeMatch = text.slice(i).match(/^<\/([a-z][a-z0-9-]*)>/i);
      if (closeMatch) {
        const tagName = closeMatch[1].toLowerCase();
        const tagStr = closeMatch[0];

        if (currentChunk.length + tagStr.length + tagOverhead(tagStack) > TELEGRAM_MESSAGE_LIMIT) {
          // Flush current chunk
          chunks.push(currentChunk + closingTagsFor(tagStack));
          currentChunk = openingTagsFor(tagStack);
        }

        currentChunk += tagStr;
        // Pop from stack
        if (TRACKED_TAGS.has(tagName)) {
          const idx = findLastIndex(tagStack, (t) => t.name === tagName);
          if (idx >= 0) tagStack.splice(idx, 1);
        }
        i += tagStr.length;
        continue;
      }

      const openMatch = text.slice(i).match(/^<([a-z][a-z0-9-]*)((?:\s[^>]*)?)>/i);
      if (openMatch) {
        const tagName = openMatch[1].toLowerCase();
        const tagStr = openMatch[0];

        if (currentChunk.length + tagStr.length + tagOverhead(tagStack) > TELEGRAM_MESSAGE_LIMIT) {
          chunks.push(currentChunk + closingTagsFor(tagStack));
          currentChunk = openingTagsFor(tagStack);
        }

        currentChunk += tagStr;
        if (TRACKED_TAGS.has(tagName)) {
          tagStack.push({ name: tagName, full: tagStr });
        }
        i += tagStr.length;
        continue;
      }
    }

    // Regular character — check if adding it would exceed the limit
    const overhead = tagOverhead(tagStack);
    if (currentChunk.length + 1 + overhead > TELEGRAM_MESSAGE_LIMIT) {
      // Try to find a better split point (newline or space)
      const splitAt = findSplitPoint(currentChunk, openingTagsFor(tagStack).length);
      if (splitAt > 0 && splitAt < currentChunk.length) {
        const kept = currentChunk.slice(0, splitAt);
        const remainder = currentChunk.slice(splitAt).replace(/^\n/, "");
        chunks.push(kept + closingTagsFor(tagStack));
        currentChunk = openingTagsFor(tagStack) + remainder;
      } else {
        chunks.push(currentChunk + closingTagsFor(tagStack));
        currentChunk = openingTagsFor(tagStack);
      }
    }

    currentChunk += text[i];
    i += 1;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Find a good split point in the chunk text, preferring newlines then spaces.
 * Returns an index to split at, or -1 if no good point found.
 */
function findSplitPoint(text: string, prefixLength: number): number {
  // Look in the last ~200 chars for a newline or space
  const searchFrom = Math.max(prefixLength, text.length - 200);
  let best = -1;

  for (let j = text.length - 1; j >= searchFrom; j -= 1) {
    if (text[j] === "\n") return j;
    if (text[j] === " " && best < 0) best = j;
  }

  return best;
}

function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}
