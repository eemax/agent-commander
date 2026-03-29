import { TELEGRAM_MESSAGE_LIMIT } from "./message-split.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TranscriptEntry =
  | { kind: "tool_notice"; text: string }
  | { kind: "text_block"; text: string }
  | { kind: "system_note"; text: string };

export type TranscriptSnapshot = {
  entries: TranscriptEntry[];
  liveDraftText: string;
  toolExecutionActive: boolean;
};

export type DraftRenderResult =
  | { kind: "empty" }
  | { kind: "content"; text: string }
  | { kind: "reset" };

type DraftRenderSource =
  | { kind: "entry"; entryIndex: number }
  | { kind: "live" };

type DraftRenderBlock = {
  kind: "status" | "preview";
  text: string;
  source: DraftRenderSource;
  separatorBefore: "\n" | "\n\n" | "";
};

const DEFAULT_DRAFT_PREVIEW_MAX_SENTENCES = 3;
const DEFAULT_DRAFT_PREVIEW_MAX_CHARS = 280;

type StreamTranscriptOptions = {
  draftPreviewMaxSentences?: number;
  draftPreviewMaxChars?: number;
};

function normalizeDraftPreviewText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function collectSentenceLikeUnits(text: string): string[] {
  const units: string[] = [];
  for (const paragraph of text.split(/\n\s*\n+/)) {
    const compact = normalizeDraftPreviewText(paragraph);
    if (compact.length === 0) {
      continue;
    }
    const matches = compact.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) ?? [];
    for (const match of matches) {
      const unit = match.trim();
      if (unit.length > 0) {
        units.push(unit);
      }
    }
  }
  return units;
}

function trimDraftPreviewTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const bodyChars = Math.max(1, maxChars - 3);
  const rawTail = text.slice(text.length - bodyChars);
  const trimmed = rawTail.replace(/^[^\s]*\s+/, "");
  const visibleTail = trimmed.length > 0 ? trimmed.slice(-bodyChars) : rawTail;
  return `...${visibleTail}`;
}

function buildDraftTextPreview(
  text: string,
  maxSentences: number,
  maxChars: number
): string {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return "";
  }

  const units = collectSentenceLikeUnits(normalized);
  const completeUnits = units.filter((unit) => /[.!?]["')\]]*$/.test(unit));
  if (completeUnits.length > 0) {
    return trimDraftPreviewTail(
      completeUnits.slice(-maxSentences).join(" "),
      maxChars
    );
  }

  return trimDraftPreviewTail(normalizeDraftPreviewText(normalized), maxChars);
}

// ---------------------------------------------------------------------------
// StreamTranscript
// ---------------------------------------------------------------------------

/**
 * Maintains an ordered transcript of streaming events for a single assistant
 * turn.  Used by the Telegram dispatch layer to render both the live draft
 * bubble and the final reply message.
 *
 * The class is pure — it does no I/O and has no async methods.
 */
export class StreamTranscript {
  private entries: TranscriptEntry[] = [];
  private liveDraftText = "";
  private toolExecutionActive = false;
  private draftPageStart = 0;   // entries before this index are hidden
  private draftLiveStart = 0;   // liveDraftText chars before this are hidden
  private draftPinnedEntryIndex: number | null = null; // hidden replaced tool_notice shown on current page
  private draftPreviewMaxSentences: number;
  private draftPreviewMaxChars: number;

  constructor(options: StreamTranscriptOptions = {}) {
    this.draftPreviewMaxSentences = Math.max(1, options.draftPreviewMaxSentences ?? DEFAULT_DRAFT_PREVIEW_MAX_SENTENCES);
    this.draftPreviewMaxChars = Math.max(1, options.draftPreviewMaxChars ?? DEFAULT_DRAFT_PREVIEW_MAX_CHARS);
  }

  // ---- Mutation ----------------------------------------------------------

  /** Append an incremental text delta to the live draft segment. */
  appendTextDelta(delta: string): void {
    this.liveDraftText += delta;
  }

  /**
   * Append a tool-call notice.
   *
   * Automatically commits any pending live draft text first.
   *
   * When `options.replace` is true and the last entry is a `tool_notice`,
   * the existing entry is replaced (count-mode semantics).  Otherwise a new
   * entry is pushed.
   */
  appendToolNotice(notice: string, options?: { replace?: boolean }): void {
    this.commitLiveDraft();

    if (options?.replace) {
      // Search backward for the most recent tool_notice to replace.
      // This handles count-mode cumulative buffers correctly even when
      // text blocks intervene between updates.
      for (let i = this.entries.length - 1; i >= 0; i--) {
        if (this.entries[i].kind === "tool_notice") {
          this.entries[i].text = notice;
          if (i < this.draftPageStart) {
            this.draftPinnedEntryIndex = i;
          }
          return;
        }
      }
    }

    this.entries.push({ kind: "tool_notice", text: notice });
  }

  /**
   * Append a system note (e.g. steer notice).
   *
   * Automatically commits any pending live draft text first.
   */
  appendSystemNote(text: string): void {
    this.commitLiveDraft();
    this.entries.push({ kind: "system_note", text });
  }

  /** Mark whether a tool execution is currently in-flight. */
  setToolExecutionActive(active: boolean): void {
    this.toolExecutionActive = active;
  }

  /**
   * Flush the current `liveDraftText` into the entries list as a
   * `text_block`.  This is called automatically before tool/system entries
   * and should be called once at finalization before rendering the final
   * reply.
   */
  commitLiveDraft(): void {
    const trimmed = this.liveDraftText.trim();
    if (trimmed.length === 0) return;
    const hadHiddenLive = this.draftLiveStart > 0;
    this.entries.push({ kind: "text_block", text: trimmed });
    this.liveDraftText = "";
    this.draftLiveStart = 0;
    if (hadHiddenLive) {
      this.draftPageStart = this.entries.length;
      this.draftPinnedEntryIndex = null;
    }
  }

  // ---- Queries -----------------------------------------------------------

  /** True when the transcript contains at least one tool or system entry. */
  hasTranscriptContent(): boolean {
    return this.entries.some((e) => e.kind === "tool_notice" || e.kind === "system_note");
  }

  /** True when the transcript contains at least one text_block entry. */
  hasTextContent(): boolean {
    return this.entries.some((e) => e.kind === "text_block");
  }

  /**
   * Build the complete reply text for a final `reply` or `fallback` result.
   *
   * Deduplication: when the last entry is a `text_block` whose text
   * matches `cleanText`, the transcript already contains the final
   * answer and `cleanText` is not appended.  This is the common case
   * when streaming is active — the provider's text deltas are captured
   * as text_blocks and the router returns the same content.
   *
   * The check is intentionally strict: only a text_block (not a
   * tool_notice or system_note) with an exact match triggers dedup.
   * This prevents suffix collisions where a tool notice happens to
   * end with the same string as the final answer.
   */
  buildFinalReplyText(cleanText: string): string {
    const fullTranscript = this.renderFullTranscript();

    if (fullTranscript.length === 0) {
      return cleanText;
    }

    if (cleanText.length === 0) {
      return fullTranscript;
    }

    // Only deduplicate when the last entry is a text_block that matches.
    const lastEntry = this.entries[this.entries.length - 1];
    if (lastEntry?.kind === "text_block" && lastEntry.text === cleanText) {
      return fullTranscript;
    }

    return fullTranscript + "\n\n" + cleanText;
  }

  /** Return an independent snapshot of the current state. */
  getSnapshot(): TranscriptSnapshot {
    return {
      entries: this.entries.map((e) => ({ ...e })),
      liveDraftText: this.liveDraftText,
      toolExecutionActive: this.toolExecutionActive
    };
  }

  // ---- Rendering ---------------------------------------------------------

  private buildDraftBlocks(): DraftRenderBlock[] {
    const blocks: DraftRenderBlock[] = [];
    const pinnedEntry = this.draftPinnedEntryIndex !== null && this.draftPinnedEntryIndex < this.draftPageStart
      ? {
          index: this.draftPinnedEntryIndex,
          text: this.entries[this.draftPinnedEntryIndex]?.text ?? null
        }
      : null;

    if (pinnedEntry?.text) {
      blocks.push({
        kind: "status",
        text: pinnedEntry.text,
        source: { kind: "entry", entryIndex: pinnedEntry.index },
        separatorBefore: ""
      });
    }

    let lastTextSource: DraftRenderSource | null = null;
    let lastTextValue = "";
    let hasStatusBlocks = blocks.length > 0;
    for (let i = this.draftPageStart; i < this.entries.length; i += 1) {
      const entry = this.entries[i]!;
      if (entry.kind === "text_block") {
        lastTextSource = { kind: "entry", entryIndex: i };
        lastTextValue = entry.text;
        continue;
      }

      blocks.push({
        kind: "status",
        text: entry.text,
        source: { kind: "entry", entryIndex: i },
        separatorBefore: hasStatusBlocks ? "\n" : ""
      });
      hasStatusBlocks = true;
    }

    const visibleLive = this.liveDraftText.slice(this.draftLiveStart);
    if (visibleLive.trim().length > 0) {
      lastTextSource = { kind: "live" };
      lastTextValue = visibleLive;
    }

    const preview = buildDraftTextPreview(
      lastTextValue,
      this.draftPreviewMaxSentences,
      this.draftPreviewMaxChars
    );
    if (preview.length > 0 && lastTextSource) {
      blocks.push({
        kind: "preview",
        text: preview,
        source: lastTextSource,
        separatorBefore: hasStatusBlocks ? "\n\n" : ""
      });
    }

    return blocks;
  }

  private renderDraftFromBlocks(blocks: DraftRenderBlock[], limit: number): {
    text: string;
    overflowBlock: DraftRenderBlock | null;
  } {
    let rendered = "";
    let overflowBlock: DraftRenderBlock | null = null;

    for (const block of blocks) {
      const candidate = rendered + block.separatorBefore + block.text;
      if (candidate.length > limit && rendered.length === 0) {
        return {
          text: block.kind === "preview" ? trimDraftPreviewTail(block.text, limit) : block.text.slice(0, limit),
          overflowBlock: null
        };
      }
      if (candidate.length > limit) {
        overflowBlock = block;
        break;
      }
      rendered = candidate;
    }

    return { text: rendered, overflowBlock };
  }

  private applyDraftResetFor(block: DraftRenderBlock | null): void {
    this.draftPinnedEntryIndex = null;

    if (!block) {
      this.draftPageStart = this.entries.length;
      this.draftLiveStart = this.liveDraftText.length;
      return;
    }

    if (block.source.kind === "entry") {
      this.draftPageStart = block.source.entryIndex;
      return;
    }

    this.draftPageStart = this.entries.length;
  }

  /**
   * Render the draft bubble content.
   *
   * The bubble grows until it exceeds `limit` chars, then resets
   * completely — all current content is hidden and the next render
   * starts from 0. The reset is reported explicitly so the dispatch
   * layer can show a spinner-only frame instead of silently dropping
   * the overflow event.
   */
  renderDraft(limit: number = TELEGRAM_MESSAGE_LIMIT): DraftRenderResult {
    const blocks = this.buildDraftBlocks();
    if (blocks.length === 0) {
      return { kind: "empty" };
    }

    const { text, overflowBlock } = this.renderDraftFromBlocks(blocks, limit);
    if (overflowBlock || text.length > limit) {
      this.applyDraftResetFor(overflowBlock ?? blocks[blocks.length - 1] ?? null);
      return { kind: "reset" };
    }

    return { kind: "content", text };
  }

  /**
   * Render the full transcript timeline — all entry kinds included.
   * Used for final reply assembly where the complete assistant timeline
   * (tool activity + draft text fragments) should be preserved.
   *
   * Returns `""` when there are no entries.
   */
  renderFullTranscript(): string {
    if (this.entries.length === 0) return "";
    return this.entries.map((e) => e.text).join("\n");
  }

}
