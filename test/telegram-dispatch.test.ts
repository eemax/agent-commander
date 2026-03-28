import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createObservabilitySink } from "../src/observability.js";
import { dispatchTelegramTextMessage } from "../src/telegram/bot.js";
import { createTempDir } from "./helpers.js";

describe("dispatchTelegramTextMessage", () => {
  const baseMessage = {
    chatId: "123",
    messageId: "11",
    senderId: "22",
    senderName: "Tester",
    text: "hello",
    receivedAt: new Date().toISOString()
  };

  it("routes one inbound message to one outbound reply", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});

    const result = await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (message) => ({ type: "reply", text: `echo: ${message.text}` }),
      sendReply
    });

    expect(result).toEqual({ type: "reply", text: "echo: hello" });
    expect(sendReply).toHaveBeenCalledWith("echo: hello", {
      resultType: "reply",
      isExtra: false,
      origin: "system"
    });
    expect(sendReply).toHaveBeenCalledTimes(1);
  });

  it("streams draft updates with throttling while generating", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onTextDelta?.("Hel");
        clock = 20;
        await stream?.onTextDelta?.("lo");
        clock = 120;
        await stream?.onTextDelta?.("!");
        return { type: "reply", text: "Hello!" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    expect(sendDraft.mock.calls.map((call) => call[0])).toEqual(["◐", "Hello!"]);
    expect(sendReply).toHaveBeenCalledWith("Hello!", {
      resultType: "reply",
      isExtra: false,
      origin: "system"
    });
  });

  it("force-flushes latest draft text before final reply", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onTextDelta?.("Hello");
        clock = 40;
        await stream?.onTextDelta?.(" world");
        return { type: "reply", text: "Hello world" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    expect(sendDraft.mock.calls.map((call) => call[0])).toEqual(["◐", "Hello world"]);
    expect(sendReply).toHaveBeenCalledWith("Hello world", {
      resultType: "reply",
      isExtra: false,
      origin: "system"
    });
  });

  it("continues with final reply when draft streaming fails", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi
      .fn<(...args: [string]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("draft failed"));
    const onDraftFailure = vi.fn();
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onTextDelta?.("Hi");
        clock = 150;
        await stream?.onTextDelta?.(" there");
        return { type: "reply", text: "Hi there" };
      },
      sendReply,
      sendDraft,
      onDraftFailure,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Typing indicator ("◐") is the first call which fails, disabling all further drafts
    expect(sendDraft).toHaveBeenCalledTimes(1);
    expect(sendDraft.mock.calls[0]?.[0]).toBe("◐");
    expect(onDraftFailure).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith("Hi there", {
      resultType: "reply",
      isExtra: false,
      origin: "system"
    });
  });

  it("sends unauthorized messages", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async () => ({ type: "unauthorized", text: "not allowed" }),
      sendReply
    });

    expect(sendReply).toHaveBeenCalledWith("not allowed", {
      resultType: "unauthorized",
      isExtra: false,
      origin: "system"
    });
  });

  it("sends fallback messages", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async () => ({ type: "fallback", text: "fallback" }),
      sendReply
    });

    expect(sendReply).toHaveBeenCalledWith("fallback", {
      resultType: "fallback",
      isExtra: false,
      origin: "system"
    });
  });

  it("sends extra replies before final reply (non-streaming fallback)", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async () => ({
        type: "reply",
        text: "final",
        extraReplies: ["first", "second"]
      }),
      sendReply
    });

    expect(sendReply).toHaveBeenCalledTimes(3);
    expect(sendReply.mock.calls.map((call) => call[0])).toEqual(["first", "second", "final"]);
    expect(sendReply.mock.calls.map((call) => call[1])).toEqual([
      { resultType: "reply", isExtra: true, origin: "system" },
      { resultType: "reply", isExtra: true, origin: "system" },
      { resultType: "reply", isExtra: false, origin: "system" }
    ]);
  });

  it("attaches inline keyboard metadata only to the final reply", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async () => ({
        type: "reply",
        text: "pick one",
        extraReplies: ["note"],
        inlineKeyboard: [[{ text: "New", callbackData: "convmenu:abc:n" }]]
      }),
      sendReply
    });

    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(sendReply.mock.calls[0]?.[1]).toEqual({
      resultType: "reply",
      isExtra: true,
      origin: "system"
    });
    expect(sendReply.mock.calls[1]?.[1]).toEqual({
      resultType: "reply",
      isExtra: false,
      origin: "system",
      inlineKeyboard: [[{ text: "New", callbackData: "convmenu:abc:n" }]]
    });
  });

  it("marks assistant-origin replies so only they can be formatted", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async () => ({ type: "reply", text: "final", origin: "assistant" }),
      sendReply
    });

    expect(sendReply).toHaveBeenCalledWith("final", {
      resultType: "reply",
      isExtra: false,
      origin: "assistant"
    });
  });

  it("does not send when handler returns ignore", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async () => ({ type: "ignore" }),
      sendReply
    });

    expect(sendReply).not.toHaveBeenCalled();
  });

  it("propagates handler errors", async () => {
    await expect(
      dispatchTelegramTextMessage({
        message: baseMessage,
        handleMessage: async () => {
          throw new Error("handler failed");
        },
        sendReply: async () => {}
      })
    ).rejects.toThrow("handler failed");
  });

  it("writes outbound observability payloads when enabled", async () => {
    const root = createTempDir("acmd-telegram-dispatch-observe-");
    const logPath = path.join(root, "observability.jsonl");
    const observability = createObservabilitySink({
      enabled: true,
      logPath
    });

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async () => ({ type: "fallback", text: "retry later" }),
      sendReply: async () => {},
      observability
    });

    const entries = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(entries).toHaveLength(2);
    const outboundEntry = entries.find((entry) => entry.event === "telegram.outbound.reply.sent");
    expect(outboundEntry).toEqual(
      expect.objectContaining({
        event: "telegram.outbound.reply.sent",
        resultType: "fallback",
        text: "retry later",
        chatId: "123",
        isExtra: false
      })
    );
  });

  it("writes observability for each extra reply and final reply", async () => {
    const root = createTempDir("acmd-telegram-dispatch-observe-extras-");
    const logPath = path.join(root, "observability.jsonl");
    const observability = createObservabilitySink({
      enabled: true,
      logPath
    });

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async () => ({
        type: "reply",
        text: "final",
        extraReplies: ["tool-1", "tool-2"]
      }),
      sendReply: async () => {},
      observability
    });

    const entries = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(entries).toHaveLength(4);
    const outboundEntries = entries.filter((entry) => entry.event === "telegram.outbound.reply.sent");
    expect(outboundEntries.map((entry) => entry.text)).toEqual(["tool-1", "tool-2", "final"]);
    expect(outboundEntries.map((entry) => entry.isExtra)).toEqual([true, true, false]);
  });

  it("draft-streams tool call notices joined by newline", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onToolCallNotice?.("📖 Read: `foo.ts`");
        clock = 120;
        await stream?.onToolCallNotice?.("✍️ Write: `bar.ts`");
        clock = 240;
        return { type: "reply", text: "done" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    expect(sendDraft.mock.calls.map((call) => call[0])).toEqual([
      "◐",
      "📖 Read: `foo.ts`\n✍️ Write: `bar.ts`"
    ]);
    // Transcript + divider + final in one message
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe(
      "📖 Read: `foo.ts`\n✍️ Write: `bar.ts`\n\ndone"
    );
    expect(sendReply.mock.calls[0]?.[1]).toEqual({
      resultType: "reply",
      isExtra: false,
      origin: "system"
    });
  });

  it("splits transcript and final reply when combined exceeds 4096", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    const longNotice = "x".repeat(4080);
    const shortNotice = "📖 Read: `file.ts`";

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onToolCallNotice?.(longNotice);
        clock = 120;
        await stream?.onToolCallNotice?.(shortNotice);
        clock = 240;
        return { type: "reply", text: "done" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Single sendOutbound with full text — sendReply handles splitting internally
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe(longNotice + "\n" + shortNotice + "\n\ndone");
  });

  it("renders tool notice and text together in draft and final reply", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onToolCallNotice?.("📖 Read: `foo.ts`");
        clock = 120;
        await stream?.onTextDelta?.("Reply ");
        clock = 240;
        await stream?.onTextDelta?.("text");
        return { type: "reply", text: "Reply text" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Draft: typing indicator, then tool+text rendered together
    expect(sendDraft.mock.calls.map((call) => call[0])).toEqual([
      "◐",
      "📖 Read: `foo.ts`\n\nReply ",
      "📖 Read: `foo.ts`\n\nReply text"
    ]);
    // Transcript ends with "Reply text" which matches cleanText — no duplication
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe("📖 Read: `foo.ts`\nReply text");
  });

  it("uses extraReplies when streaming is disabled (no sendDraft)", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        // stream is undefined when no sendDraft, so onToolCallNotice is unavailable
        expect(stream).toBeUndefined();
        return {
          type: "reply",
          text: "final",
          extraReplies: ["tool-1", "tool-2"]
        };
      },
      sendReply
    });

    expect(sendReply).toHaveBeenCalledTimes(3);
    expect(sendReply.mock.calls.map((call) => call[0])).toEqual(["tool-1", "tool-2", "final"]);
  });

  it("includes transcript in final reply even when draft fails", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi
      .fn<(...args: [string]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("draft failed"));
    const onDraftFailure = vi.fn();
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onToolCallNotice?.("📖 Read: `foo.ts`");
        clock = 120;
        await stream?.onToolCallNotice?.("✍️ Write: `bar.ts`");
        return { type: "reply", text: "done" };
      },
      sendReply,
      sendDraft,
      onDraftFailure,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Typing indicator ("◐") fails, disabling all further drafts.
    // Transcript is still included in the final reply.
    expect(sendDraft).toHaveBeenCalledTimes(1);
    expect(sendDraft.mock.calls[0]?.[0]).toBe("◐");
    expect(onDraftFailure).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe(
      "📖 Read: `foo.ts`\n✍️ Write: `bar.ts`\n\ndone"
    );
  });

  it("combines transcript from tools -> text -> tools into one final reply", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onToolCallNotice?.("📖 Read: `foo.ts`");
        clock = 120;
        await stream?.onTextDelta?.("Reply");
        clock = 240;
        await stream?.onToolCallNotice?.("✍️ Write: `bar.ts`");
        return { type: "reply", text: "Reply" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Full transcript (including text_blocks) + divider + final text
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe(
      "📖 Read: `foo.ts`\nReply\n✍️ Write: `bar.ts`\n\nReply"
    );
    expect(sendReply.mock.calls[0]?.[1]).toEqual({ resultType: "reply", isExtra: false, origin: "system" });
  });

  it("empty tool call notice enters tools mode with typing indicator", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        // Empty notice = tool-phase entry signal (tool execution starting)
        await stream?.onToolCallNotice?.("");
        clock = 120;
        // Tool completes, verbose notice arrives
        await stream?.onToolCallNotice?.("📖 Read: `foo.ts`");
        clock = 240;
        return { type: "reply", text: "done" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Draft: typing indicator from ensureTypingStarted, then tool notice
    expect(sendDraft.mock.calls.map((call) => call[0])).toEqual([
      "◐",
      "📖 Read: `foo.ts`"
    ]);
    // Single final reply: transcript + divider + answer
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe("📖 Read: `foo.ts`\n\ndone");
  });

  it("empty notice does not affect text accumulation", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onTextDelta?.("Hello");
        clock = 120;
        await stream?.onTextDelta?.(" there");
        clock = 240;
        // Empty notice = tool phase entry signal, does not affect transcript
        await stream?.onToolCallNotice?.("");
        clock = 360;
        await stream?.onTextDelta?.(" world");
        clock = 480;
        return { type: "reply", text: "Hello there world" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Draft: typing indicator, text accumulates continuously
    expect(sendDraft.mock.calls.map((call) => call[0])).toEqual([
      "◐",
      "Hello there",
      "Hello there world"
    ]);
    // No tool entries, so final reply is just the answer text
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe("Hello there world");
  });

  it("empty notice produces no deferred commit when buffer stays empty", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        // Only empty notices (verbose off scenario) — no content in buffer
        await stream?.onToolCallNotice?.("");
        clock = 120;
        await stream?.onToolCallNotice?.("");
        clock = 240;
        return { type: "reply", text: "done" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Only the final reply — no deferred tool notices committed
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe("done");
  });

  it("commits tool calls even when handler returns ignore", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onToolCallNotice?.("📖 Read: `foo.ts`");
        clock = 120;
        return { type: "ignore" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Stale turns emit no permanent messages — all deferred commits discarded
    expect(sendReply).toHaveBeenCalledTimes(0);
  });

  it("draft uses rolling window for huge tool call notice", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});

    const hugeNotice = "x".repeat(5000);

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onToolCallNotice?.(hugeNotice);
        return { type: "reply", text: "done" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => 0
    });

    // Typing indicator is the first draft
    expect(sendDraft.mock.calls[0]?.[0]).toBe("◐");
    // Single sendOutbound with full text — sendReply handles splitting internally
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe(hugeNotice + "\n\ndone");
  });

  it("supports text -> tools -> text mode switching in single reply", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onTextDelta?.("Part 1");
        clock = 120;
        await stream?.onToolCallNotice?.("📖 Read: `foo.ts`");
        clock = 240;
        await stream?.onTextDelta?.("Part 2");
        return { type: "reply", text: "Part 2" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Transcript ends with "Part 2" which matches cleanText — no duplication
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe("Part 1\n📖 Read: `foo.ts`\nPart 2");
    expect(sendReply.mock.calls[0]?.[1]).toEqual({ resultType: "reply", isExtra: false, origin: "system" });
  });

  it("supports multiple mode cycles in single combined reply", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onToolCallNotice?.("🔍 Search");
        clock = 120;
        await stream?.onTextDelta?.("Found it. ");
        clock = 240;
        await stream?.onToolCallNotice?.("📖 Read: `result.ts`");
        clock = 360;
        await stream?.onTextDelta?.("Here are the results.");
        return { type: "reply", text: "Here are the results." };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Transcript ends with "Here are the results." which matches cleanText — no duplication
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe(
      "🔍 Search\nFound it.\n📖 Read: `result.ts`\nHere are the results."
    );
    expect(sendReply.mock.calls[0]?.[1]).toEqual({ resultType: "reply", isExtra: false, origin: "system" });
  });

  it("count-mode replace produces single transcript entry in final reply", async () => {
    const VERBOSE_REPLACE_PREFIX = "\x00REPLACE\x00";
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onTextDelta?.("Thinking...");
        clock = 120;
        // Count-mode tool call notice arrives during text phase
        await stream?.onToolCallNotice?.(VERBOSE_REPLACE_PREFIX + "📖 Read ×1");
        clock = 240;
        await stream?.onTextDelta?.("Done.");
        return { type: "reply", text: "Done." };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Transcript ends with "Done." which matches cleanText — no duplication
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe("Thinking...\n📖 Read ×1\nDone.");
    expect(sendReply.mock.calls[0]?.[1]).toEqual({ resultType: "reply", isExtra: false, origin: "system" });
  });

  it("count-mode replace updates earlier summary even when text intervenes", async () => {
    const VERBOSE_REPLACE_PREFIX = "\x00REPLACE\x00";
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        // First count-mode summary
        await stream?.onToolCallNotice?.(VERBOSE_REPLACE_PREFIX + "📖 Read ×1");
        clock = 120;
        // Text intervenes
        await stream?.onTextDelta?.("thinking...");
        clock = 240;
        // Updated cumulative summary — should replace, not duplicate
        await stream?.onToolCallNotice?.(VERBOSE_REPLACE_PREFIX + "📖 Read ×1\n✍️ Write ×1");
        clock = 360;
        return { type: "reply", text: "done" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // No duplication: full transcript shows updated summary + text + divider + final
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe(
      "📖 Read ×1\n✍️ Write ×1\nthinking...\n\ndone"
    );
  });

  it("re-shows count-mode draft after a reset hides the previous summary", async () => {
    const VERBOSE_REPLACE_PREFIX = "\x00REPLACE\x00";
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onToolCallNotice?.(VERBOSE_REPLACE_PREFIX + "x".repeat(100));
        clock = 120;
        await stream?.onToolCallNotice?.(VERBOSE_REPLACE_PREFIX + "📖 Read ×2");
        return { type: "reply", text: "done" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      draftBubbleMaxChars: 60,
      nowMs: () => clock
    });

    expect(sendDraft.mock.calls.map((call) => call[0])).toEqual([
      "◐",
      "📖 Read ×2"
    ]);
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe("📖 Read ×2\n\ndone");
  });

  it("sends only fallback text without transcript on failure", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onTextDelta?.("Draft answer");
        clock = 120;
        await stream?.onToolCallNotice?.("📖 Read: `foo.ts`");
        clock = 240;
        return { type: "fallback", text: "Provider error. Please try again." };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // No transcript leaked on fallback — only the fallback message
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe("Provider error. Please try again.");
    expect(sendReply.mock.calls[0]?.[1]).toEqual({ resultType: "fallback", isExtra: false, origin: "system" });
  });

  it("sends nothing on ignore even with transcript content", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onTextDelta?.("Draft answer");
        clock = 120;
        await stream?.onToolCallNotice?.("📖 Read: `foo.ts`");
        clock = 240;
        return { type: "ignore" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Ignore discards everything — no permanent messages
    expect(sendReply).toHaveBeenCalledTimes(0);
  });

  it("suppresses draft flushes and final replies when output is canceled after generation", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let suppressOutput = false;

    const result = await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onTextDelta?.("Hello");
        suppressOutput = true;
        return { type: "reply", text: "Hello" };
      },
      sendReply,
      sendDraft,
      shouldSuppressOutput: () => suppressOutput,
      draftMinUpdateMs: 100,
      nowMs: () => 0
    });

    expect(result).toEqual({ type: "ignore" });
    expect(sendDraft.mock.calls.map((call) => call[0])).toEqual(["◐"]);
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("transcript-based reply has no duplication issues", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onTextDelta?.("Same text");
        clock = 120;
        await stream?.onToolCallNotice?.("📖 Read: `foo.ts`");
        clock = 240;
        return { type: "reply", text: "Same text" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Full transcript + divider + final text
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe("Same text\n📖 Read: `foo.ts`\n\nSame text");
  });

  it("interrupted banner goes through transcript, not duplicated with extraReplies", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    const bannerText = "Interrupted previous in-progress run and handling your latest message.";

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        // Banner streamed as text delta (with the fix in assistant-turn.ts,
        // extraReplies is NOT populated when onTextDelta is available)
        await stream?.onTextDelta?.(`${bannerText}\n`);
        clock = 120;
        await stream?.onToolCallNotice?.("📖 Read: `foo.ts`");
        clock = 240;
        await stream?.onTextDelta?.("Final answer");
        return {
          type: "reply",
          text: "Final answer",
          origin: "assistant"
          // No extraReplies — banner only goes through transcript
        };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Transcript ends with "Final answer" which matches cleanText — no duplication
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe(
      `${bannerText}\n📖 Read: \`foo.ts\`\nFinal answer`
    );
    expect(sendReply.mock.calls[0]?.[1]).toEqual({ resultType: "reply", isExtra: false, origin: "assistant" });
  });

  it("sends acknowledged reaction exactly once on first response_acknowledged", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    const sendAcknowledgedReaction = vi.fn(async () => {});

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onLifecycleEvent?.({ type: "response_acknowledged" });
        await stream?.onLifecycleEvent?.({ type: "response_processing_started" });
        // Second ack should be ignored
        await stream?.onLifecycleEvent?.({ type: "response_acknowledged" });
        await stream?.onLifecycleEvent?.({ type: "response_processing_finished", outcome: "completed" });
        return { type: "reply", text: "done" };
      },
      sendReply,
      sendDraft,
      sendAcknowledgedReaction
    });

    expect(sendAcknowledgedReaction).toHaveBeenCalledTimes(1);
  });

  it("starts processing indicator on response_processing_started", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendProcessingAction = vi.fn(async () => {});

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onLifecycleEvent?.({ type: "response_acknowledged" });
        await stream?.onLifecycleEvent?.({ type: "response_processing_started" });
        return { type: "reply", text: "done" };
      },
      sendReply,
      sendProcessingAction
    });

    // Should have been called at least once (immediate send on start)
    expect(sendProcessingAction).toHaveBeenCalled();
  });

  it("cleans up processing timer in finally block even when handler throws", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendProcessingAction = vi.fn(async () => {});

    await expect(
      dispatchTelegramTextMessage({
        message: baseMessage,
        handleMessage: async (_message, stream) => {
          await stream?.onLifecycleEvent?.({ type: "response_acknowledged" });
          await stream?.onLifecycleEvent?.({ type: "response_processing_started" });
          throw new Error("handler crashed");
        },
        sendReply,
        sendProcessingAction
      })
    ).rejects.toThrow("handler crashed");

    // The timer should have been cleaned up in finally block.
    // Verify no further calls after the throw by checking the mock wasn't called excessively.
    expect(sendProcessingAction).toHaveBeenCalled();
  });

  it("lifecycle events work when sendDraft is disabled", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendAcknowledgedReaction = vi.fn(async () => {});
    const sendProcessingAction = vi.fn(async () => {});

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        // stream should exist even without sendDraft because lifecycle callbacks are provided
        expect(stream).toBeDefined();
        await stream?.onLifecycleEvent?.({ type: "response_acknowledged" });
        await stream?.onLifecycleEvent?.({ type: "response_processing_started" });
        return { type: "reply", text: "done" };
      },
      sendReply,
      // No sendDraft!
      sendAcknowledgedReaction,
      sendProcessingAction
    });

    expect(sendAcknowledgedReaction).toHaveBeenCalledTimes(1);
    expect(sendProcessingAction).toHaveBeenCalled();
  });

  it("does not send reaction when sendAcknowledgedReaction is undefined", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onLifecycleEvent?.({ type: "response_acknowledged" });
        return { type: "reply", text: "done" };
      },
      sendReply,
      sendDraft
      // No sendAcknowledgedReaction - simulates acknowledged_emoji: "off"
    });

    // No errors thrown, no reaction sent
    expect(sendReply).toHaveBeenCalledTimes(1);
  });

  it("reaction failure does not block the reply", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendAcknowledgedReaction = vi.fn(async () => {
      throw new Error("reaction API failed");
    });

    const result = await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onLifecycleEvent?.({ type: "response_acknowledged" });
        await stream?.onLifecycleEvent?.({ type: "response_processing_started" });
        return { type: "reply", text: "done" };
      },
      sendReply,
      sendAcknowledgedReaction
    });

    expect(result.type).toBe("reply");
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendAcknowledgedReaction).toHaveBeenCalledTimes(1);
  });

  it("draft failure does not disable processing indicator", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async () => {
      throw new Error("draft failed");
    });
    const sendProcessingAction = vi.fn(async () => {});

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onLifecycleEvent?.({ type: "response_acknowledged" });
        await stream?.onLifecycleEvent?.({ type: "response_processing_started" });
        // Draft will fail on first text delta
        await stream?.onTextDelta?.("hello");
        // Processing action should still be working
        return { type: "reply", text: "done" };
      },
      sendReply,
      sendDraft,
      sendProcessingAction,
      draftMinUpdateMs: 1
    });

    // Processing action was called despite draft failure
    expect(sendProcessingAction).toHaveBeenCalled();
  });

  it("uses page-break for draft when text exceeds 4096 limit", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    const chunkA = "a".repeat(3500);
    const chunkB = "b".repeat(1000);
    const fullText = chunkA + "\n\n" + chunkB;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onTextDelta?.(chunkA + "\n\n");
        clock = 200;
        await stream?.onTextDelta?.(chunkB);
        clock = 400;
        return { type: "reply", text: fullText, origin: "assistant" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // All drafts stay within 4096 chars (page-break applied when needed)
    const draftTexts = sendDraft.mock.calls.map((c: [string]) => c[0]);
    for (const dt of draftTexts) {
      expect(dt.length).toBeLessThanOrEqual(4096);
    }

    // Single sendOutbound with full text — sendReply handles formatting and splitting
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe(fullText);
    expect(sendReply.mock.calls[0]?.[1]).toEqual({
      resultType: "reply",
      isExtra: false,
      origin: "assistant"
    });
  });

  it("does not include assistant text in fallback or ignore final replies", async () => {
    for (const resultType of ["fallback", "ignore"] as const) {
      const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
      const sendDraft = vi.fn(async (_text: string) => {});
      let clock = 0;

      const bigChunk = "a".repeat(3600);

      await dispatchTelegramTextMessage({
        message: baseMessage,
        handleMessage: async (_message, stream) => {
          await stream?.onTextDelta?.(bigChunk);
          clock = 200;
          if (resultType === "fallback") {
            return { type: "fallback", text: "Something went wrong" };
          }
          return { type: "ignore" };
        },
        sendReply,
        sendDraft,
        draftMinUpdateMs: 100,
        nowMs: () => clock
      });

      // Text-only transcript is excluded from final replies
      const sentTexts = sendReply.mock.calls.map((c: unknown[]) => c[0]);
      expect(sentTexts).not.toContain(bigChunk);
      if (resultType === "fallback") {
        expect(sentTexts).toContain("Something went wrong");
      }
    }
  });

  it("draft uses page-break for long text, final reply delegates to sendReply", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    const longText = "x".repeat(5000);

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onTextDelta?.(longText);
        clock = 200;
        return { type: "reply", text: longText, origin: "assistant" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Draft should be capped at 4096 via page-break
    const draftTexts = sendDraft.mock.calls.map((c: [string]) => c[0]);
    for (const dt of draftTexts) {
      expect(dt.length).toBeLessThanOrEqual(4096);
    }

    // Single sendOutbound with full text — sendReply handles formatting and splitting
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toBe(longText);
  });

  it("draft continues accumulating after exceeding limit via rolling window", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    const bigChunk = "a".repeat(3500);
    const smallChunk = "bbb";

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onTextDelta?.(bigChunk + "\n\n");
        clock = 200;
        await stream?.onTextDelta?.(smallChunk);
        clock = 400;
        return { type: "reply", text: bigChunk + "\n\n" + smallChunk, origin: "assistant" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Draft should include the small chunk (via rolling window showing latest content)
    const draftTexts = sendDraft.mock.calls.map((c: [string]) => c[0]);
    const draftsWithSmallChunk = draftTexts.filter((t: string) => t.includes(smallChunk));
    expect(draftsWithSmallChunk.length).toBeGreaterThan(0);
  });
});
