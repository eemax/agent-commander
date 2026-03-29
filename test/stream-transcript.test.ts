import { describe, expect, it } from "vitest";
import { StreamTranscript } from "../src/telegram/stream-transcript.js";

describe("StreamTranscript", () => {
  const emptyDraft = { kind: "empty" } as const;
  const resetDraft = { kind: "reset" } as const;
  const contentDraft = (text: string) => ({ kind: "content", text }) as const;

  it("accumulates live text and whole-turn assistant chars", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("Hello");
    t.appendTextDelta(" world");

    expect(t.getSnapshot()).toEqual({
      entries: [],
      liveDraftText: "Hello world",
      totalAssistantChars: 11,
      toolSummary: null,
      latestSuccessfulToolNotice: null,
      toolExecutionActive: false
    });
  });

  it("commits live text into transcript entries", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("  Hello world  ");
    t.commitLiveDraft();

    expect(t.getSnapshot().entries).toEqual([{ kind: "text_block", text: "Hello world" }]);
    expect(t.getSnapshot().liveDraftText).toBe("");
  });

  it("stores count summary separately from transcript entries", () => {
    const t = new StreamTranscript();
    t.setToolSummary("📖 Read ×2 (120 chars)");

    expect(t.getSnapshot().toolSummary).toBe("📖 Read ×2 (120 chars)");
    expect(t.getSnapshot().entries).toEqual([]);
    expect(t.renderFullTranscript()).toBe("📖 Read ×2 (120 chars)");
  });

  it("keeps the latest successful tool notice draft-only", () => {
    const t = new StreamTranscript();
    t.setToolSummary("📖 Read ×1 (50 chars)");
    t.setLatestSuccessfulToolNotice("📖 Read: `foo.ts` (50 chars)");

    expect(t.renderDraft()).toEqual(
      contentDraft("📖 Read ×1 (50 chars)\n📖 Read: `foo.ts` (50 chars)")
    );
    expect(t.renderFullTranscript()).toBe("📖 Read ×1 (50 chars)");
  });

  it("renders summary, latest success, persistent notices, and assistant counter in order", () => {
    const t = new StreamTranscript();
    t.setToolSummary("📖 Read ×1 (50 chars)");
    t.setLatestSuccessfulToolNotice("📖 Read: `foo.ts` (50 chars)");
    t.appendSystemNote("🎯 Steer: focus on the parser");
    t.appendToolNotice("⚠️ Read failed: `missing.ts` - not found");
    t.appendTextDelta("Hello");

    expect(t.renderDraft()).toEqual(
      contentDraft(
        [
          "📖 Read ×1 (50 chars)",
          "📖 Read: `foo.ts` (50 chars)",
          "🎯 Steer: focus on the parser",
          "⚠️ Read failed: `missing.ts` - not found",
          "",
          "Assistant: 5 chars"
        ].join("\n")
      )
    );
  });

  it("renders only the assistant char counter for streamed assistant text", () => {
    const t = new StreamTranscript();
    t.appendTextDelta("Hello");

    expect(t.renderDraft()).toEqual(contentDraft("Assistant: 5 chars"));
  });

  it("returns empty when there is nothing to show", () => {
    const t = new StreamTranscript();
    expect(t.renderDraft()).toEqual(emptyDraft);
  });

  it("clips the first pinned block when it is oversized", () => {
    const t = new StreamTranscript();
    t.setToolSummary("x".repeat(5000));

    expect(t.renderDraft(4096)).toEqual(contentDraft(`${"x".repeat(4093)}...`));
  });

  it("carries the overflow-triggering notice to the next page before allowing later resets", () => {
    const t = new StreamTranscript();
    t.setToolSummary("📖 Read ×1");
    t.setLatestSuccessfulToolNotice("📖 Read: `foo.ts`");
    t.appendToolNotice("A".repeat(25));
    t.appendToolNotice("B".repeat(25));
    t.appendToolNotice("C".repeat(25));

    expect(t.renderDraft(60)).toEqual(resetDraft);

    t.appendToolNotice("D".repeat(10));
    expect(t.renderDraft(60)).toEqual(
      contentDraft(["📖 Read ×1", "📖 Read: `foo.ts`", "B".repeat(25)].join("\n"))
    );
    expect(t.renderDraft(80)).toEqual(
      contentDraft(["📖 Read ×1", "📖 Read: `foo.ts`", "B".repeat(25), "C".repeat(25)].join("\n"))
    );
  });

  it("advances past an oversized first pageable notice after showing its carried page", () => {
    const t = new StreamTranscript();
    t.setToolSummary("SUMMARY");
    t.setLatestSuccessfulToolNotice("SUCCESS");
    t.appendToolNotice("X".repeat(100));
    t.appendToolNotice("NEXT");

    expect(t.renderDraft(40)).toEqual(resetDraft);
    expect(t.renderDraft(40)).toEqual(
      contentDraft(["SUMMARY", "SUCCESS", `${"X".repeat(21)}...`].join("\n"))
    );
    expect(t.renderDraft(40)).toEqual(contentDraft(["SUMMARY", "SUCCESS", "NEXT"].join("\n")));
  });

  it("builds final replies from summary, persistent notices, and text blocks without the latest success notice", () => {
    const t = new StreamTranscript();
    t.setToolSummary("📖 Read ×1 (50 chars)");
    t.setLatestSuccessfulToolNotice("📖 Read: `foo.ts` (50 chars)");
    t.appendSystemNote("🎯 Steer: focus on the parser");
    t.appendToolNotice("⚠️ Read failed: `missing.ts` - not found");
    t.appendTextDelta("Final answer");
    t.commitLiveDraft();

    expect(t.buildFinalReplyText("Final answer")).toBe(
      [
        "📖 Read ×1 (50 chars)",
        "🎯 Steer: focus on the parser",
        "⚠️ Read failed: `missing.ts` - not found",
        "Final answer"
      ].join("\n")
    );
  });

  it("appends the clean reply text when the transcript does not already end with it", () => {
    const t = new StreamTranscript();
    t.setToolSummary("📖 Read ×1 (50 chars)");
    t.appendToolNotice("⚠️ Read failed: `missing.ts` - not found");

    expect(t.buildFinalReplyText("Fallback answer")).toBe(
      [
        "📖 Read ×1 (50 chars)",
        "⚠️ Read failed: `missing.ts` - not found",
        "",
        "Fallback answer"
      ].join("\n")
    );
  });
});
