import { describe, expect, it } from "vitest";
import { StreamTranscript } from "../src/telegram/stream-transcript.js";

describe("StreamTranscript", () => {
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
    expect(t.renderDraft()).toBe("Hello");
  });

  it("renders only entries when no liveDraftText", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("📖 Read: `a.ts`");
    t.appendToolNotice("✍️ Write: `b.ts`");
    expect(t.renderDraft()).toBe("📖 Read: `a.ts`\n✍️ Write: `b.ts`");
  });

  it("renders entries + liveDraftText separated by double newline", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("📖 Read: `a.ts`");
    t.appendTextDelta("Thinking...");
    expect(t.renderDraft()).toBe("📖 Read: `a.ts`\n\nThinking...");
  });

  it("returns empty string when transcript is empty", () => {
    const t = new StreamTranscript();
    expect(t.renderDraft()).toBe("");
  });

  it("applies rolling window when draft exceeds limit", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("A".repeat(50));
    t.appendToolNotice("B".repeat(50));
    t.appendToolNotice("C".repeat(50));
    // limit=60 should drop some entries from the front
    const rendered = t.renderDraft(60);
    expect(rendered.length).toBeLessThanOrEqual(60);
    expect(rendered).toContain("C".repeat(50));
    expect(rendered.startsWith("...\n")).toBe(true);
  });

  it("handles liveDraftText-only overflow by truncating from front", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("x".repeat(100));
    const rendered = t.renderDraft(50);
    expect(rendered.length).toBeLessThanOrEqual(50);
    expect(rendered).toBe("x".repeat(50));
  });

  it("caps a single oversized entry to the budget", () => {
    const t = new StreamTranscript();
    t.appendToolNotice("x".repeat(5000));
    const rendered = t.renderDraft(4096);
    expect(rendered.length).toBeLessThanOrEqual(4096);
    // Should show the newest suffix (end of the entry)
    expect(rendered.endsWith("x".repeat(100))).toBe(true);
  });

  // ---------- renderSafeTranscript ----------------------------------------

  it("includes only tool_notice and system_note entries", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("draft text");
    t.appendToolNotice("📖 Read: `a.ts`");
    t.appendTextDelta("more text");
    t.appendSystemNote("🎯 Steer");
    t.appendTextDelta("final draft");
    t.commitLiveDraft();
    expect(t.renderSafeTranscript()).toBe("📖 Read: `a.ts`\n🎯 Steer");
  });

  it("returns empty string when no tool/system entries", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("just text");
    t.commitLiveDraft();
    expect(t.renderSafeTranscript()).toBe("");
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

    expect(t.renderSafeTranscript()).toBe("🔍 Search\n📖 Read: `result.ts`");
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

    // Final transcript should show only the updated cumulative summary
    expect(t.renderSafeTranscript()).toBe("📖 Read ×1\n✍️ Write ×1");
  });
});
