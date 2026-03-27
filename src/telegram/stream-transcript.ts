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
    this.entries.push({ kind: "text_block", text: trimmed });
    this.liveDraftText = "";
  }

  // ---- Queries -----------------------------------------------------------

  /** True when the transcript contains at least one tool or system entry. */
  hasTranscriptContent(): boolean {
    return this.entries.some((e) => e.kind === "tool_notice" || e.kind === "system_note");
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
   * Layout:
   *   <committed entries joined by \n>
   *   \n\n
   *   <liveDraftText>
   *
   * If the rendered text exceeds `limit`, a rolling suffix is shown with a
   * leading `"...\n"` prefix.
   */
  renderDraft(limit: number = TELEGRAM_MESSAGE_LIMIT): string {
    const entryTexts = this.entries.map((e) => e.text);
    const hasEntries = entryTexts.length > 0;
    const hasLive = this.liveDraftText.length > 0;

    if (!hasEntries && !hasLive) return "";

    let full: string;
    if (hasEntries && hasLive) {
      full = entryTexts.join("\n") + "\n\n" + this.liveDraftText;
    } else if (hasEntries) {
      full = entryTexts.join("\n");
    } else {
      full = this.liveDraftText;
    }

    if (full.length <= limit) return full;

    return this.computeRollingWindow(entryTexts, this.liveDraftText, limit);
  }

  /**
   * Render the full transcript timeline — all entry kinds included.
   * Used for the success path where the complete assistant timeline
   * (tool activity + draft text fragments) should be preserved.
   *
   * Returns `""` when there are no entries.
   */
  renderFullTranscript(): string {
    if (this.entries.length === 0) return "";
    return this.entries.map((e) => e.text).join("\n");
  }

  /**
   * Render a safe transcript — only tool_notice and system_note entries.
   * text_block entries are excluded to prevent leaking partial assistant
   * text on fallback/failure paths.
   *
   * Returns `""` when there is no transcript content.
   */
  renderSafeTranscript(): string {
    const lines = this.entries
      .filter((e) => e.kind === "tool_notice" || e.kind === "system_note")
      .map((e) => e.text);
    return lines.join("\n");
  }

  // ---- Internals ---------------------------------------------------------

  /**
   * Build a rolling-window suffix that fits within `budget`, drawn from
   * `items` (entry texts) and an optional `suffix` (liveDraftText).
   *
   * When items must be dropped, the result is prefixed with `"...\n"`.
   */
  private computeRollingWindow(
    items: string[],
    suffix: string,
    budget: number
  ): string {
    const ELLIPSIS = "...\n";

    // Reserve space for the suffix (with the \n\n separator)
    const hasSuffix = suffix.length > 0;
    const suffixCost = hasSuffix ? 2 + suffix.length : 0; // "\n\n" + suffix

    // If suffix alone exceeds the budget, just truncate it
    if (suffixCost > budget) {
      return suffix.slice(suffix.length - budget);
    }

    // Try to fit as many entries as possible from the end
    const available = budget - suffixCost - ELLIPSIS.length;
    let accumulated = 0;
    let startIndex = items.length;

    for (let i = items.length - 1; i >= 0; i--) {
      const itemCost = items[i].length + (i < items.length - 1 ? 1 : 0); // +1 for \n separator
      if (accumulated + itemCost > available && startIndex < items.length) break;
      accumulated += itemCost;
      startIndex = i;
    }

    const visibleItems = items.slice(startIndex);
    const prefix = startIndex > 0 ? ELLIPSIS : "";
    let entriesText = visibleItems.join("\n");

    // If the entries still exceed the available budget (single oversized entry),
    // truncate from the front to show the newest suffix.
    const maxEntriesLen = budget - (prefix.length + suffixCost);
    if (entriesText.length > maxEntriesLen) {
      entriesText = entriesText.slice(entriesText.length - Math.max(0, maxEntriesLen));
    }

    if (hasSuffix) {
      return prefix + entriesText + "\n\n" + suffix;
    }
    return prefix + entriesText;
  }
}
