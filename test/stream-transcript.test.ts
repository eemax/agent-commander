import { describe, expect, it } from "vitest";
import { StreamTranscript } from "../src/telegram/stream-transcript.js";

describe("StreamTranscript", () => {
  const emptyDraft = { kind: "empty" } as const;
  const resetDraft = { kind: "reset" } as const;
  const contentDraft = (text: string) => ({ kind: "content", text }) as const;

  // ---------- appendTextDelta / liveDraftText ------------------------------

  it("accumulates text deltas in liveDraftText", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("Hello");
    t.appendTextDelta(" world");
    expect(t.getSnapshot().liveDraftText).toBe("Hello world");
    expect(t.getSnapshot().entries).toHaveLength(0);
  });

  // ---------- commitLiveDraft ----------------------------------------------

  it("commits liveDraftText as a text_block entry", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("  Hello  ");
    t.commitLiveDraft();
    const snap = t.getSnapshot();
    expect(snap.liveDraftText).toBe("");
    expect(snap.entries).toEqual([{ kind: "text_block", text: "Hello" }]);
  });

  it("does nothing when liveDraftText is whitespace-only", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("   ");
    t.commitLiveDraft();
    expect(t.getSnapshot().entries).toHaveLength(0);
  });

  // ---------- appendToolNotice ---------------------------------------------

  it("auto-commits pending text before appending tool notice", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("draft");
    t.appendToolNotice("📖 Read: `foo.ts`");
    const snap = t.getSnapshot();
    expect(snap.entries).toEqual([
      { kind: "text_block", text: "draft" },
      { kind: "tool_notice", text: "📖 Read: `foo.ts`" }
    ]);
    expect(snap.liveDraftText).toBe("");
  });

  it("replaces last tool_notice when replace=true", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("📖 Read ×1");
    t.appendToolNotice("📖 Read ×2", { replace: true });
    expect(t.getSnapshot().entries).toEqual([
      { kind: "tool_notice", text: "📖 Read ×2" }
    ]);
  });

  it("appends when replace=true but no prior tool_notice exists", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("text");
    t.appendToolNotice("📖 Read ×1", { replace: true });
    const snap = t.getSnapshot();
    expect(snap.entries).toEqual([
      { kind: "text_block", text: "text" },
      { kind: "tool_notice", text: "📖 Read ×1" }
    ]);
  });

  it("appends consecutive tool notices without replace", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("📖 Read: `a.ts`");
    t.appendToolNotice("✍️ Write: `b.ts`");
    expect(t.getSnapshot().entries).toEqual([
      { kind: "tool_notice", text: "📖 Read: `a.ts`" },
      { kind: "tool_notice", text: "✍️ Write: `b.ts`" }
    ]);
  });

  // ---------- appendSystemNote ---------------------------------------------

  it("auto-commits pending text before appending system note", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("partial");
    t.appendSystemNote("🎯 Steer: do something");
    const snap = t.getSnapshot();
    expect(snap.entries).toEqual([
      { kind: "text_block", text: "partial" },
      { kind: "system_note", text: "🎯 Steer: do something" }
    ]);
  });

  // ---------- setToolExecutionActive ---------------------------------------

  it("tracks tool execution active state", () => {
    const t = new StreamTranscript();
    expect(t.getSnapshot().toolExecutionActive).toBe(false);
    t.setToolExecutionActive(true);
    expect(t.getSnapshot().toolExecutionActive).toBe(true);
  });

  // ---------- hasTranscriptContent -----------------------------------------

  it("returns false when only text_block entries exist", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("text");
    t.commitLiveDraft();
    expect(t.hasTranscriptContent()).toBe(false);
  });

  it("returns true when tool_notice entries exist", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("📖 Read: `foo.ts`");
    expect(t.hasTranscriptContent()).toBe(true);
  });

  it("returns true when system_note entries exist", () => {
    const t = new StreamTranscript();
    t.appendSystemNote("note");
    expect(t.hasTranscriptContent()).toBe(true);
  });

  // ---------- renderDraft --------------------------------------------------

  it("renders only liveDraftText when no entries", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("Hello");
    expect(t.renderDraft()).toEqual(contentDraft("Hello"));
  });

  it("renders only entries when no liveDraftText", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("📖 Read: `a.ts`");
    t.appendToolNotice("✍️ Write: `b.ts`");
    expect(t.renderDraft()).toEqual(contentDraft("📖 Read: `a.ts`\n✍️ Write: `b.ts`"));
  });

  it("renders entries + liveDraftText separated by double newline", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("📖 Read: `a.ts`");
    t.appendTextDelta("Thinking...");
    expect(t.renderDraft()).toEqual(contentDraft("📖 Read: `a.ts`\n\nThinking..."));
  });

  it("returns an empty draft result when transcript is empty", () => {
    const t = new StreamTranscript();
    expect(t.renderDraft()).toEqual(emptyDraft);
  });

  it("returns an explicit reset when draft exceeds limit", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("A".repeat(50));
    t.appendToolNotice("B".repeat(50));
    t.appendToolNotice("C".repeat(50));
    const rendered = t.renderDraft(60);
    expect(rendered).toEqual(resetDraft);
  });

  it("compacts long assistant text into a bounded preview", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("x".repeat(100));
    expect(t.renderDraft(60)).toEqual(contentDraft(`...${"x".repeat(57)}`));
  });

  it("prefers a few complete sentences for the assistant preview", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("First sentence. Second sentence. Third sentence. Fourth sentence.");
    expect(t.renderDraft()).toEqual(
      contentDraft("Second sentence. Third sentence. Fourth sentence.")
    );
  });

  it("honors configured assistant preview sentence and char limits", () => {
    const t = new StreamTranscript({
      draftPreviewMaxSentences: 1,
      draftPreviewMaxChars: 12
    });
    t.appendTextDelta("First sentence. Second sentence.");
    expect(t.renderDraft()).toEqual(contentDraft("...sentence."));
  });

  it("clips an oversized single status block instead of resetting forever", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("x".repeat(5000));
    expect(t.renderDraft(4096)).toEqual(contentDraft("x".repeat(4096)));
  });

  it("carries the overflow-triggering status block into the next page", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("A".repeat(25));
    t.appendToolNotice("B".repeat(25));
    t.appendToolNotice("C".repeat(25));
    expect(t.renderDraft(60)).toEqual(resetDraft);

    t.appendToolNotice("D".repeat(10));
    expect(t.renderDraft(60)).toEqual(contentDraft(`${"C".repeat(25)}\n${"D".repeat(10)}`));
  });

  it("shows a hidden count-mode replacement after reset", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("📖 Read ×1");
    t.appendSystemNote("A".repeat(30));
    t.appendSystemNote("B".repeat(30));
    expect(t.renderDraft(60)).toEqual(resetDraft);

    t.appendToolNotice("📖 Read ×2", { replace: true });

    expect(t.renderDraft(60)).toEqual(contentDraft(`📖 Read ×2\n${"B".repeat(30)}`));
    expect(t.buildFinalReplyText("done")).toBe(
      `📖 Read ×2\n${"A".repeat(30)}\n${"B".repeat(30)}\n\ndone`
    );
  });

  it("keeps later deltas visible in the compact preview", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("a".repeat(40));
    expect(t.renderDraft(60)).toEqual(contentDraft("a".repeat(40)));

    t.appendTextDelta("b".repeat(30));
    expect(t.renderDraft(60)).toEqual(contentDraft(`...${"a".repeat(27)}${"b".repeat(30)}`));

    t.appendTextDelta("ccc");
    expect(t.renderDraft(60)).toEqual(contentDraft(`...${"a".repeat(24)}${"b".repeat(30)}ccc`));
  });

  // ---------- renderFullTranscript -----------------------------------------

  it("includes all entry kinds in full transcript", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("draft text");
    t.appendToolNotice("📖 Read: `a.ts`");
    t.appendTextDelta("more text");
    t.appendSystemNote("🎯 Steer");
    t.appendTextDelta("final draft");
    t.commitLiveDraft();
    expect(t.renderFullTranscript()).toBe(
      "draft text\n📖 Read: `a.ts`\nmore text\n🎯 Steer\nfinal draft"
    );
  });

  it("returns empty string when no entries exist", () => {
    const t = new StreamTranscript();
    expect(t.renderFullTranscript()).toBe("");
  });

  // ---------- getSnapshot --------------------------------------------------

  it("returns an independent copy", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("notice");
    const snap = t.getSnapshot();
    snap.entries.push({ kind: "text_block", text: "injected" });
    snap.liveDraftText = "injected";
    expect(t.getSnapshot().entries).toHaveLength(1);
    expect(t.getSnapshot().liveDraftText).toBe("");
  });

  // ---------- Mixed scenarios ----------------------------------------------

  it("handles tool -> text -> tool -> text sequence", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("🔍 Search");
    t.appendTextDelta("Found it. ");
    t.appendToolNotice("📖 Read: `result.ts`");
    t.appendTextDelta("Here are the results.");
    t.commitLiveDraft();

    expect(t.getSnapshot().entries).toEqual([
      { kind: "tool_notice", text: "🔍 Search" },
      { kind: "text_block", text: "Found it." },
      { kind: "tool_notice", text: "📖 Read: `result.ts`" },
      { kind: "text_block", text: "Here are the results." }
    ]);

    expect(t.renderFullTranscript()).toBe(
      "🔍 Search\nFound it.\n📖 Read: `result.ts`\nHere are the results."
    );
  });

  it("count-mode replace sequence produces single entry", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("📖 Read ×1 (50 chars)");
    t.appendToolNotice("📖 Read ×2 (120 chars)", { replace: true });
    t.appendToolNotice("📖 Read ×3 (300 chars)", { replace: true });

    const snap = t.getSnapshot();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]).toEqual({ kind: "tool_notice", text: "📖 Read ×3 (300 chars)" });
  });

  it("count-mode replace finds and updates earlier tool_notice across text blocks", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("📖 Read ×1");
    t.appendTextDelta("thinking...");
    // Replace should find the earlier tool_notice even with text between
    t.appendToolNotice("📖 Read ×1\n✍️ Write ×1", { replace: true });

    const snap = t.getSnapshot();
    expect(snap.entries).toEqual([
      { kind: "tool_notice", text: "📖 Read ×1\n✍️ Write ×1" },
      { kind: "text_block", text: "thinking..." }
    ]);

    expect(t.renderFullTranscript()).toBe("📖 Read ×1\n✍️ Write ×1\nthinking...");
  });

  // ---------- hasTextContent ------------------------------------------------

  it("hasTextContent returns false when no text_block entries", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("📖 Read: `a.ts`");
    expect(t.hasTextContent()).toBe(false);
  });

  it("hasTextContent returns true after text is committed", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("hello");
    t.commitLiveDraft();
    expect(t.hasTextContent()).toBe(true);
  });

  // ---------- buildFinalReplyText -------------------------------------------

  it("buildFinalReplyText returns cleanText when transcript is empty", () => {
    const t = new StreamTranscript();
    expect(t.buildFinalReplyText("done")).toBe("done");
  });

  it("buildFinalReplyText deduplicates when transcript ends with cleanText", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("📖 Read: `a.ts`");
    t.appendTextDelta("Final answer");
    t.commitLiveDraft();
    // renderFullTranscript = "📖 Read: `a.ts`\nFinal answer"
    expect(t.buildFinalReplyText("Final answer")).toBe(
      "📖 Read: `a.ts`\nFinal answer"
    );
  });

  it("buildFinalReplyText appends cleanText when transcript does not end with it", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("thinking");
    t.appendToolNotice("📖 Read: `a.ts`");
    // Transcript ends with tool_notice, not cleanText
    expect(t.buildFinalReplyText("done")).toBe(
      "thinking\n📖 Read: `a.ts`\n\ndone"
    );
  });

  it("buildFinalReplyText does not suppress reply on tool_notice suffix collision", () => {
    const t = new StreamTranscript();
    // Tool notice text that happens to end with the same string as cleanText
    t.appendToolNotice("Tool log: Final answer");
    // Must NOT treat this as deduplicated — the tool_notice is not a text_block
    expect(t.buildFinalReplyText("Final answer")).toBe(
      "Tool log: Final answer\n\nFinal answer"
    );
  });

  it("buildFinalReplyText returns fullTranscript when cleanText is empty", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("📖 Read: `a.ts`");
    expect(t.buildFinalReplyText("")).toBe("📖 Read: `a.ts`");
  });
});
