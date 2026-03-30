export const TELEGRAM_MESSAGE_LIMIT = 4096;
const FINAL_REPLY_SEARCH_WINDOW = 1096;
const FINAL_REPLY_SEARCH_START = TELEGRAM_MESSAGE_LIMIT - FINAL_REPLY_SEARCH_WINDOW;

type SplitOptions = {
  parseMode?: "HTML";
};

type OpenTag = {
  name: string;
  full: string;
};

type SafeBoundary = {
  index: number;
  stack: OpenTag[];
};

type NaturalBoundaryKind = "double_newline" | "newline" | "space";

type NaturalBoundary = SafeBoundary & {
  kind: NaturalBoundaryKind;
};

type HtmlChunkState = {
  currentChunk: string;
  tagStack: OpenTag[];
  safeBoundaries: SafeBoundary[];
  naturalBoundaries: NaturalBoundary[];
  previousTextUnitWasNewline: boolean;
};

type HtmlUnit =
  | {
      kind: "open_tag";
      raw: string;
      tagName: string;
      tracked: boolean;
    }
  | {
      kind: "close_tag";
      raw: string;
      tagName: string;
      tracked: boolean;
    }
  | {
      kind: "text";
      raw: string;
      textKind: "newline" | "space" | "other";
    };

const CLOSE_TAG_PATTERN = /^<\/([a-z][a-z0-9-]*)>/i;
const OPEN_TAG_PATTERN = /^<([a-z][a-z0-9-]*)((?:\s[^>]*)?)>/i;
const HTML_ENTITY_PATTERN = /^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i;

const TRACKED_TAGS = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del",
  "a", "code", "pre", "blockquote", "tg-spoiler", "span", "tg-emoji", "tg-time"
]);

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
    let splitAt = findPreferredFinalSplitPoint(slice, FINAL_REPLY_SEARCH_START);
    if (splitAt <= 0) {
      splitAt = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function closingTagsFor(stack: OpenTag[]): string {
  return [...stack].reverse().map((t) => `</${t.name}>`).join("");
}

function openingTagsFor(stack: OpenTag[]): string {
  return stack.map((t) => t.full).join("");
}

function closingTagsLength(stack: OpenTag[]): number {
  return stack.reduce((total, tag) => total + tag.name.length + 3, 0);
}

function splitHtml(text: string): string[] {
  const chunks: string[] = [];
  let state = createEmptyHtmlChunkState();
  let i = 0;

  while (i < text.length) {
    const { unit, nextIndex } = readNextHtmlUnit(text, i);

    while (wouldOverflowAfterAppend(state, unit)) {
      state = flushHtmlChunk(chunks, state);
    }

    state = appendHtmlUnit(state, unit);
    i = nextIndex;
  }

  if (state.currentChunk.length > 0) {
    chunks.push(state.currentChunk + closingTagsFor(state.tagStack));
  }

  return chunks;
}

/**
 * Find a good split point in the chunk text, preferring \n\n > \n > space.
 * Returns an index to split at, or -1 if no good point found.
 */
function findPreferredFinalSplitPoint(text: string, minimumIndex: number): number {
  const searchFrom = Math.max(0, minimumIndex);

  for (let j = text.length - 1; j >= searchFrom; j -= 1) {
    if (text[j] === "\n" && j > 0 && text[j - 1] === "\n") {
      return j + 1;
    }
  }

  for (let j = text.length - 1; j >= searchFrom; j -= 1) {
    if (text[j] === "\n") {
      return j + 1;
    }
  }

  for (let j = text.length - 1; j >= searchFrom; j -= 1) {
    if (text[j] === " ") {
      return j + 1;
    }
  }

  return -1;
}

/**
 * Find a split point for mid-stream draft commits.
 * Searches backward up to `window` chars with priority: \n\n > \n > space.
 * Returns the index to split at (text.slice(0, idx) is the committed chunk),
 * or -1 if no good point found.
 */
export function findDraftSplitPoint(text: string, window: number = 596): number {
  const searchFrom = Math.max(0, text.length - window);
  let bestNewline = -1;
  let bestSpace = -1;

  for (let j = text.length - 1; j >= searchFrom; j -= 1) {
    if (text[j] === "\n" && j > 0 && text[j - 1] === "\n") return j + 1; // after \n\n
    if (text[j] === "\n" && bestNewline < 0) bestNewline = j + 1; // after \n
    if (text[j] === " " && bestSpace < 0) bestSpace = j + 1; // after space
  }

  return bestNewline > 0 ? bestNewline : bestSpace > 0 ? bestSpace : -1;
}

/**
 * Split a final reply into chunks for sending as permanent Telegram messages.
 *
 * Uses the same backward search policy as the active permanent-send path:
 * search from `4096` down to `3000`, preferring `\n\n`, then `\n`, then
 * space, then a hard split at `4096`.
 */
export function splitFinalReply(text: string): string[] {
  return splitPlainText(text);
}

function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}

function createEmptyHtmlChunkState(): HtmlChunkState {
  return {
    currentChunk: "",
    tagStack: [],
    safeBoundaries: [],
    naturalBoundaries: [],
    previousTextUnitWasNewline: false
  };
}

function readNextHtmlUnit(text: string, start: number): { unit: HtmlUnit; nextIndex: number } {
  if (text[start] === "<") {
    const closeMatch = text.slice(start).match(CLOSE_TAG_PATTERN);
    if (closeMatch) {
      const tagName = closeMatch[1].toLowerCase();
      return {
        unit: {
          kind: "close_tag",
          raw: closeMatch[0],
          tagName,
          tracked: TRACKED_TAGS.has(tagName)
        },
        nextIndex: start + closeMatch[0].length
      };
    }

    const openMatch = text.slice(start).match(OPEN_TAG_PATTERN);
    if (openMatch) {
      const tagName = openMatch[1].toLowerCase();
      return {
        unit: {
          kind: "open_tag",
          raw: openMatch[0],
          tagName,
          tracked: TRACKED_TAGS.has(tagName)
        },
        nextIndex: start + openMatch[0].length
      };
    }
  }

  if (text[start] === "&") {
    const entityMatch = text.slice(start).match(HTML_ENTITY_PATTERN);
    if (entityMatch) {
      return {
        unit: {
          kind: "text",
          raw: entityMatch[0],
          textKind: "other"
        },
        nextIndex: start + entityMatch[0].length
      };
    }
  }

  const raw = text[start]!;
  return {
    unit: {
      kind: "text",
      raw,
      textKind: raw === "\n" ? "newline" : raw === " " ? "space" : "other"
    },
    nextIndex: start + raw.length
  };
}

function wouldOverflowAfterAppend(state: HtmlChunkState, unit: HtmlUnit): boolean {
  return projectedHtmlLengthAfterAppend(state, unit) > TELEGRAM_MESSAGE_LIMIT;
}

function projectedHtmlLengthAfterAppend(state: HtmlChunkState, unit: HtmlUnit): number {
  const nextStack = getProjectedTagStack(state.tagStack, unit);
  return state.currentChunk.length + unit.raw.length + closingTagsLength(nextStack);
}

function getProjectedTagStack(stack: OpenTag[], unit: HtmlUnit): OpenTag[] {
  if (unit.kind === "open_tag" && unit.tracked) {
    return [...stack, { name: unit.tagName, full: unit.raw }];
  }

  if (unit.kind === "close_tag" && unit.tracked) {
    const idx = findLastIndex(stack, (tag) => tag.name === unit.tagName);
    if (idx < 0) {
      return stack;
    }
    return [...stack.slice(0, idx), ...stack.slice(idx + 1)];
  }

  return stack;
}

function appendHtmlUnit(state: HtmlChunkState, unit: HtmlUnit): HtmlChunkState {
  if (unit.kind === "open_tag") {
    const nextStack = unit.tracked
      ? [...state.tagStack, { name: unit.tagName, full: unit.raw }]
      : state.tagStack;

    return {
      ...state,
      currentChunk: state.currentChunk + unit.raw,
      tagStack: nextStack,
      previousTextUnitWasNewline: false
    };
  }

  if (unit.kind === "close_tag") {
    const idx = unit.tracked
      ? findLastIndex(state.tagStack, (tag) => tag.name === unit.tagName)
      : -1;
    const nextStack =
      idx >= 0
        ? [...state.tagStack.slice(0, idx), ...state.tagStack.slice(idx + 1)]
        : state.tagStack;

    return {
      ...state,
      currentChunk: state.currentChunk + unit.raw,
      tagStack: nextStack,
      previousTextUnitWasNewline: false
    };
  }

  const nextChunk = state.currentChunk + unit.raw;
  const boundary: SafeBoundary = {
    index: nextChunk.length,
    stack: cloneTagStack(state.tagStack)
  };
  const nextNaturalBoundaries = [...state.naturalBoundaries];

  if (unit.textKind === "newline") {
    if (state.previousTextUnitWasNewline) {
      nextNaturalBoundaries.push({ ...boundary, kind: "double_newline" });
    }
    nextNaturalBoundaries.push({ ...boundary, kind: "newline" });
  }

  if (unit.textKind === "space") {
    nextNaturalBoundaries.push({ ...boundary, kind: "space" });
  }

  return {
    currentChunk: nextChunk,
    tagStack: state.tagStack,
    safeBoundaries: [...state.safeBoundaries, boundary],
    naturalBoundaries: nextNaturalBoundaries,
    previousTextUnitWasNewline: unit.textKind === "newline"
  };
}

function flushHtmlChunk(chunks: string[], state: HtmlChunkState): HtmlChunkState {
  const boundary = pickBestHtmlBoundary(state);
  if (!boundary || boundary.index <= 0) {
    throw new Error("telegram: unable to find a safe HTML split boundary");
  }

  chunks.push(state.currentChunk.slice(0, boundary.index) + closingTagsFor(boundary.stack));

  const carriedChunk = openingTagsFor(boundary.stack) + state.currentChunk.slice(boundary.index);
  return buildHtmlChunkState(carriedChunk);
}

function pickBestHtmlBoundary(state: HtmlChunkState): SafeBoundary | null {
  const searchFrom = Math.max(0, state.currentChunk.length - FINAL_REPLY_SEARCH_WINDOW);

  for (const kind of ["double_newline", "newline", "space"] as const) {
    for (let i = state.naturalBoundaries.length - 1; i >= 0; i -= 1) {
      const boundary = state.naturalBoundaries[i]!;
      if (boundary.kind !== kind || boundary.index < searchFrom) {
        continue;
      }
      if (isUsableHtmlBoundary(boundary)) {
        return boundary;
      }
    }
  }

  for (let i = state.safeBoundaries.length - 1; i >= 0; i -= 1) {
    const boundary = state.safeBoundaries[i]!;
    if (isUsableHtmlBoundary(boundary)) {
      return boundary;
    }
  }

  return null;
}

function isUsableHtmlBoundary(boundary: SafeBoundary): boolean {
  return boundary.index > 0 && boundary.index + closingTagsLength(boundary.stack) <= TELEGRAM_MESSAGE_LIMIT;
}

function buildHtmlChunkState(chunk: string): HtmlChunkState {
  let state = createEmptyHtmlChunkState();
  let index = 0;

  while (index < chunk.length) {
    const { unit, nextIndex } = readNextHtmlUnit(chunk, index);
    state = appendHtmlUnit(state, unit);
    index = nextIndex;
  }

  return state;
}

function cloneTagStack(stack: OpenTag[]): OpenTag[] {
  return stack.map((tag) => ({ ...tag }));
}
