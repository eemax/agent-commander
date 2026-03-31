import { TELEGRAM_MESSAGE_LIMIT } from "./message-split.js";

export type TranscriptEntry =
  | { kind: "tool_notice"; text: string }
  | { kind: "text_block"; text: string }
  | { kind: "system_note"; text: string };

export type TranscriptSnapshot = {
  entries: TranscriptEntry[];
  liveDraftText: string;
  totalAssistantChars: number;
  toolSummary: string | null;
  latestToolNotice: string | null;
  toolExecutionActive: boolean;
};

export type DraftRenderResult =
  | { kind: "empty" }
  | { kind: "content"; text: string }
  | { kind: "reset" };

type DraftRenderSource =
  | { kind: "summary" }
  | { kind: "latest_tool_notice" }
  | { kind: "entry"; entryIndex: number }
  | { kind: "assistant_counter" };

type DraftRenderBlock = {
  kind: "status" | "counter";
  text: string;
  source: DraftRenderSource;
  separatorBefore: "\n" | "\n\n" | "";
  pinned: boolean;
};

function clipDraftBlockText(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function formatAssistantCharCounter(totalAssistantChars: number): string {
  return `Assistant: ${totalAssistantChars} chars`;
}

export class StreamTranscript {
  private entries: TranscriptEntry[] = [];
  private liveDraftText = "";
  private totalAssistantChars = 0;
  private toolExecutionActive = false;
  private draftPageStart = 0;
  private draftCarryEntryIndex: number | null = null;
  private draftLastVisiblePageText: string | null = null;
  private toolSummary: string | null = null;
  private latestToolNotice: string | null = null;

  appendTextDelta(delta: string): void {
    if (delta.length === 0) {
      return;
    }
    this.liveDraftText += delta;
    this.totalAssistantChars += delta.length;
  }

  setToolSummary(summary: string): void {
    this.commitLiveDraft();
    const trimmed = summary.trim();
    this.toolSummary = trimmed.length > 0 ? trimmed : null;
  }

  setLatestToolNotice(notice: string): void {
    this.commitLiveDraft();
    const trimmed = notice.trim();
    this.latestToolNotice = trimmed.length > 0 ? trimmed : null;
  }

  appendToolNotice(notice: string, _options?: { replace?: boolean }): void {
    this.commitLiveDraft();
    const trimmed = notice.trim();
    if (trimmed.length === 0) {
      return;
    }
    this.entries.push({ kind: "tool_notice", text: trimmed });
  }

  appendSystemNote(text: string): void {
    this.commitLiveDraft();
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    this.entries.push({ kind: "system_note", text: trimmed });
  }

  setToolExecutionActive(active: boolean): void {
    this.toolExecutionActive = active;
  }

  commitLiveDraft(): void {
    const trimmed = this.liveDraftText.trim();
    this.liveDraftText = "";
    if (trimmed.length === 0) {
      return;
    }
    this.entries.push({ kind: "text_block", text: trimmed });
  }

  hasTranscriptContent(): boolean {
    return this.toolSummary !== null || this.entries.some((entry) => entry.kind !== "text_block");
  }

  hasTextContent(): boolean {
    return this.entries.some((entry) => entry.kind === "text_block");
  }

  buildFinalReplyText(cleanText: string): string {
    const fullTranscript = this.renderFullTranscript();

    if (fullTranscript.length === 0) {
      return cleanText;
    }

    if (cleanText.length === 0) {
      return fullTranscript;
    }

    const lastEntry = this.entries[this.entries.length - 1];
    if (lastEntry?.kind === "text_block" && lastEntry.text === cleanText) {
      return fullTranscript;
    }

    return `${fullTranscript}\n\n${cleanText}`;
  }

  getSnapshot(): TranscriptSnapshot {
    return {
      entries: this.entries.map((entry) => ({ ...entry })),
      liveDraftText: this.liveDraftText,
      totalAssistantChars: this.totalAssistantChars,
      toolSummary: this.toolSummary,
      latestToolNotice: this.latestToolNotice,
      toolExecutionActive: this.toolExecutionActive
    };
  }

  private buildDraftBlocks(): DraftRenderBlock[] {
    const blocks: DraftRenderBlock[] = [];

    if (this.toolSummary) {
      blocks.push({
        kind: "status",
        text: this.toolSummary,
        source: { kind: "summary" },
        separatorBefore: "",
        pinned: true
      });
    }

    if (this.latestToolNotice) {
      blocks.push({
        kind: "status",
        text: this.latestToolNotice,
        source: { kind: "latest_tool_notice" },
        separatorBefore: blocks.length > 0 ? "\n" : "",
        pinned: true
      });
    }

    let hasStatusBlocks = blocks.length > 0;
    for (let i = this.draftPageStart; i < this.entries.length; i += 1) {
      const entry = this.entries[i]!;
      if (entry.kind === "text_block") {
        continue;
      }

      blocks.push({
        kind: "status",
        text: entry.text,
        source: { kind: "entry", entryIndex: i },
        separatorBefore: hasStatusBlocks ? "\n" : "",
        pinned: false
      });
      hasStatusBlocks = true;
    }

    if (this.totalAssistantChars > 0) {
      blocks.push({
        kind: "counter",
        text: formatAssistantCharCounter(this.totalAssistantChars),
        source: { kind: "assistant_counter" },
        separatorBefore: hasStatusBlocks ? "\n\n" : "",
        pinned: false
      });
    }

    return blocks;
  }

  private renderDraftFromBlocks(blocks: DraftRenderBlock[], limit: number): {
    text: string;
    overflowBlock: DraftRenderBlock | null;
    clippedBlock: DraftRenderBlock | null;
  } {
    let rendered = "";
    let overflowBlock: DraftRenderBlock | null = null;
    let clippedBlock: DraftRenderBlock | null = null;
    let hasRenderedPageableBlock = false;

    for (const block of blocks) {
      const separator = rendered.length > 0 ? block.separatorBefore : "";
      const candidate = `${rendered}${separator}${block.text}`;
      if (candidate.length <= limit) {
        rendered = candidate;
        if (!block.pinned) {
          hasRenderedPageableBlock = true;
        }
        continue;
      }

      const remaining = limit - rendered.length - separator.length;
      if (rendered.length === 0 || block.pinned || !hasRenderedPageableBlock) {
        const maxChars = rendered.length === 0 ? limit : remaining;
        const clipped = clipDraftBlockText(block.text, maxChars);
        if (clipped.length === 0) {
          return { text: rendered, overflowBlock: null, clippedBlock: null };
        }
        clippedBlock = block;
        return {
          text: `${rendered}${separator}${clipped}`,
          overflowBlock:
            !block.pinned && block.source.kind === "entry" ? block : null,
          clippedBlock
        };
      }

      overflowBlock = block;
      break;
    }

    return { text: rendered, overflowBlock, clippedBlock };
  }

  private applyDraftResetFor(block: DraftRenderBlock | null): void {
    if (!block) {
      this.draftPageStart = this.entries.length;
      this.draftCarryEntryIndex = null;
      this.draftLastVisiblePageText = null;
      return;
    }

    if (block.source.kind === "entry") {
      this.draftPageStart = block.source.entryIndex;
      this.draftCarryEntryIndex = block.source.entryIndex;
      this.draftLastVisiblePageText = null;
      return;
    }

    this.draftPageStart = this.entries.length;
    this.draftCarryEntryIndex = null;
    this.draftLastVisiblePageText = null;
  }

  private renderedEntryBeforeOverflow(
    blocks: DraftRenderBlock[],
    overflowBlock: DraftRenderBlock | null,
    entryIndex: number
  ): boolean {
    const limit = overflowBlock ? blocks.indexOf(overflowBlock) : blocks.length;
    if (limit <= 0) {
      return false;
    }

    for (let i = 0; i < limit; i += 1) {
      const block = blocks[i];
      if (block?.source.kind === "entry" && block.source.entryIndex === entryIndex) {
        return true;
      }
    }

    return false;
  }

  renderDraft(limit: number = TELEGRAM_MESSAGE_LIMIT): DraftRenderResult {
    const blocks = this.buildDraftBlocks();
    if (blocks.length === 0) {
      return { kind: "empty" };
    }

    const { text, overflowBlock, clippedBlock } = this.renderDraftFromBlocks(blocks, limit);
    const carriedEntryIndex = this.draftCarryEntryIndex;
    const clippedEntryIndex =
      clippedBlock?.source.kind === "entry" ? clippedBlock.source.entryIndex : null;
    const carriedEntryRendered =
      carriedEntryIndex !== null &&
      (
        this.renderedEntryBeforeOverflow(blocks, overflowBlock, carriedEntryIndex) ||
        clippedEntryIndex === carriedEntryIndex
      );

    if (carriedEntryRendered) {
      this.draftCarryEntryIndex = null;
      if (
        clippedEntryIndex === carriedEntryIndex &&
        overflowBlock?.source.kind === "entry" &&
        overflowBlock.source.entryIndex === carriedEntryIndex
      ) {
        this.draftPageStart = carriedEntryIndex + 1;
      }
    }

    if (overflowBlock || text.length > limit) {
      if (carriedEntryRendered && text.length <= limit) {
        this.draftLastVisiblePageText = text;
        return { kind: "content", text };
      }

      if (
        overflowBlock &&
        text.length <= limit &&
        this.draftLastVisiblePageText !== null &&
        text !== this.draftLastVisiblePageText
      ) {
        this.draftLastVisiblePageText = text;
        return { kind: "content", text };
      }
      this.applyDraftResetFor(overflowBlock ?? blocks[blocks.length - 1] ?? null);
      return { kind: "reset" };
    }

    this.draftLastVisiblePageText = text;
    return { kind: "content", text };
  }

  renderFullTranscript(): string {
    const parts: string[] = [];
    if (this.toolSummary) {
      parts.push(this.toolSummary);
    }
    for (const entry of this.entries) {
      parts.push(entry.text);
    }
    return parts.join("\n");
  }
}
