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

  /**
   * Render the draft bubble content.
   *
   * The bubble grows until it exceeds `limit` chars, then resets
   * completely — all current content is hidden and the next render
   * starts from 0.  This prevents the Telegram UI from scrolling;
   * instead the bubble fills the screen and clears.
   */
  renderDraft(limit: number = TELEGRAM_MESSAGE_LIMIT): string {
    const pinnedEntry = this.draftPinnedEntryIndex !== null && this.draftPinnedEntryIndex < this.draftPageStart
      ? this.entries[this.draftPinnedEntryIndex]?.text ?? null
      : null;
    const visEntries = this.entries.slice(this.draftPageStart).map((e) => e.text);
    const visLive = this.liveDraftText.slice(this.draftLiveStart);
    const draftEntries = pinnedEntry ? [pinnedEntry, ...visEntries] : visEntries;

    const hasEntries = draftEntries.length > 0;
    const hasLive = visLive.length > 0;

    let visible: string;
    if (!hasEntries && !hasLive) return "";
    else if (hasEntries && hasLive) visible = draftEntries.join("\n") + "\n\n" + visLive;
    else if (hasEntries) visible = draftEntries.join("\n");
    else visible = visLive;

    if (visible.length > limit) {
      this.draftPageStart = this.entries.length;
      this.draftLiveStart = this.liveDraftText.length;
      this.draftPinnedEntryIndex = null;
      return "";
    }

    return visible;
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
