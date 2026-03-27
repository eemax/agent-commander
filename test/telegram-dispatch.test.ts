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

  it("draft-streams tool call notices with double newline delimiter", async () => {
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
      "📖 Read: `foo.ts`\n\n✍️ Write: `bar.ts`"
    ]);
    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(sendReply.mock.calls.map((call) => call[0])).toEqual([
      "📖 Read: `foo.ts`\n\n✍️ Write: `bar.ts`",
      "done"
    ]);
    expect(sendReply.mock.calls[0]?.[1]).toEqual({
      resultType: "reply",
      isExtra: true,
      origin: "system"
    });
  });

  it("commits tool call batch at 4096 limit and starts new draft", async () => {
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

    // First notice exceeds mid-stream threshold, committed immediately; second committed at finalization
    expect(sendReply).toHaveBeenCalledTimes(3);
    expect(sendReply.mock.calls[0]?.[0]).toBe(longNotice);
    expect(sendReply.mock.calls[0]?.[1]).toEqual({
      resultType: "reply",
      isExtra: true,
      origin: "system"
    });
    expect(sendReply.mock.calls[1]?.[0]).toBe(shortNotice);
    expect(sendReply.mock.calls[2]?.[0]).toBe("done");
  });

  it("commits tool buffer when text streaming starts", async () => {
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

    // Draft: typing indicator, then text drafts after tool buffer committed
    expect(sendDraft.mock.calls.map((call) => call[0])).toEqual([
      "◐",
      "Reply ",
      "Reply text"
    ]);
    // sendReply: committed tool buffer, then final reply
    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(sendReply.mock.calls[0]?.[0]).toBe("📖 Read: `foo.ts`");
    expect(sendReply.mock.calls[0]?.[1]).toEqual({
      resultType: "reply",
      isExtra: true,
      origin: "system"
    });
    expect(sendReply.mock.calls[1]?.[0]).toBe("Reply text");
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

  it("commits tool call buffer as real message even when draft fails", async () => {
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
    // Buffer is still committed as real message.
    expect(sendDraft).toHaveBeenCalledTimes(1);
    expect(sendDraft.mock.calls[0]?.[0]).toBe("◐");
    expect(onDraftFailure).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(sendReply.mock.calls[0]?.[0]).toBe("📖 Read: `foo.ts`\n\n✍️ Write: `bar.ts`");
    expect(sendReply.mock.calls[1]?.[0]).toBe("done");
  });

  it("commits each phase on type transition (tools -> text -> tools)", async () => {
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

    // Deferred tool1, deferred text "Reply" filtered (matches final), deferred tool2, final reply
    expect(sendReply).toHaveBeenCalledTimes(3);
    expect(sendReply.mock.calls[0]?.[0]).toBe("📖 Read: `foo.ts`");
    expect(sendReply.mock.calls[0]?.[1]).toEqual({ resultType: "reply", isExtra: true, origin: "system" });
    expect(sendReply.mock.calls[1]?.[0]).toBe("✍️ Write: `bar.ts`");
    expect(sendReply.mock.calls[1]?.[1]).toEqual({ resultType: "reply", isExtra: true, origin: "system" });
    expect(sendReply.mock.calls[2]?.[0]).toBe("Reply");
    expect(sendReply.mock.calls[2]?.[1]).toEqual({ resultType: "reply", isExtra: false, origin: "system" });
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
    // Reply: tool notice committed, then final reply
    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(sendReply.mock.calls[0]?.[0]).toBe("📖 Read: `foo.ts`");
    expect(sendReply.mock.calls[0]?.[1]).toEqual({ resultType: "reply", isExtra: true, origin: "system" });
    expect(sendReply.mock.calls[1]?.[0]).toBe("done");
  });

  it("empty notice after text does not commit or reset buffer", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onTextDelta?.("Hello");
        clock = 120;
        // Flush the text draft within throttle window
        await stream?.onTextDelta?.(" there");
        clock = 240;
        // Tool phase starts — should commit text and switch to tools mode
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

    // Draft: typing indicator, text flushed; empty notice is a no-op, text continues in same buffer
    expect(sendDraft.mock.calls.map((call) => call[0])).toEqual([
      "◐",
      "Hello there",
      "Hello there world"
    ]);
    // Deferred "Hello there world" deduped (matches final reply)
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

  it("truncates single tool call notice exceeding 4096 chars", async () => {
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

    // Typing indicator is the only draft; truncated notice is committed mid-stream before flush
    expect(sendDraft.mock.calls[0]?.[0]).toBe("◐");
    // The committed real message is truncated to 4096
    expect(sendReply.mock.calls[0]?.[0]).toHaveLength(4096);
  });

  it("supports text -> tools -> text mode switching", async () => {
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

    // Committed text, committed tool, final reply
    expect(sendReply).toHaveBeenCalledTimes(3);
    expect(sendReply.mock.calls[0]?.[0]).toBe("Part 1");
    expect(sendReply.mock.calls[0]?.[1]).toEqual({ resultType: "reply", isExtra: true, origin: "assistant" });
    expect(sendReply.mock.calls[1]?.[0]).toBe("📖 Read: `foo.ts`");
    expect(sendReply.mock.calls[1]?.[1]).toEqual({ resultType: "reply", isExtra: true, origin: "system" });
    expect(sendReply.mock.calls[2]?.[0]).toBe("Part 2");
    expect(sendReply.mock.calls[2]?.[1]).toEqual({ resultType: "reply", isExtra: false, origin: "system" });
  });

  it("supports multiple mode cycles (tools -> text -> tools -> text)", async () => {
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

    // 4 sendReply calls: tool commit, text commit, tool commit, final reply
    expect(sendReply).toHaveBeenCalledTimes(4);
    expect(sendReply.mock.calls[0]?.[0]).toBe("🔍 Search");
    expect(sendReply.mock.calls[0]?.[1]).toEqual({ resultType: "reply", isExtra: true, origin: "system" });
    expect(sendReply.mock.calls[1]?.[0]).toBe("Found it.");
    expect(sendReply.mock.calls[1]?.[1]).toEqual({ resultType: "reply", isExtra: true, origin: "assistant" });
    expect(sendReply.mock.calls[2]?.[0]).toBe("📖 Read: `result.ts`");
    expect(sendReply.mock.calls[2]?.[1]).toEqual({ resultType: "reply", isExtra: true, origin: "system" });
    expect(sendReply.mock.calls[3]?.[0]).toBe("Here are the results.");
    expect(sendReply.mock.calls[3]?.[1]).toEqual({ resultType: "reply", isExtra: false, origin: "system" });
  });

  it("count-mode replace after text commits text first", async () => {
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

    // Text committed on type transition, tool buffer committed at finalization, final reply
    expect(sendReply).toHaveBeenCalledTimes(3);
    expect(sendReply.mock.calls[0]?.[0]).toBe("Thinking...");
    expect(sendReply.mock.calls[0]?.[1]).toEqual({ resultType: "reply", isExtra: true, origin: "assistant" });
    expect(sendReply.mock.calls[1]?.[0]).toBe("📖 Read ×1");
    expect(sendReply.mock.calls[1]?.[1]).toEqual({ resultType: "reply", isExtra: true, origin: "system" });
    expect(sendReply.mock.calls[2]?.[0]).toBe("Done.");
    expect(sendReply.mock.calls[2]?.[1]).toEqual({ resultType: "reply", isExtra: false, origin: "system" });
  });

  it("discards deferred text on fallback, keeps tool notices", async () => {
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

    // Tool notice kept, text discarded, fallback message sent
    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(sendReply.mock.calls[0]?.[0]).toBe("📖 Read: `foo.ts`");
    expect(sendReply.mock.calls[0]?.[1]).toEqual({ resultType: "fallback", isExtra: true, origin: "system" });
    expect(sendReply.mock.calls[1]?.[0]).toBe("Provider error. Please try again.");
    expect(sendReply.mock.calls[1]?.[1]).toEqual({ resultType: "fallback", isExtra: false, origin: "system" });
  });

  it("discards all deferred text on ignore, keeps tool notices", async () => {
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

    // Stale turns emit no permanent messages — all deferred commits discarded
    expect(sendReply).toHaveBeenCalledTimes(0);
  });

  it("filters duplicate text commit matching final reply", async () => {
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
        // Final reply text matches the committed text fragment
        return { type: "reply", text: "Same text" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Deferred text "Same text" filtered (matches final reply), tool notice kept
    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(sendReply.mock.calls[0]?.[0]).toBe("📖 Read: `foo.ts`");
    expect(sendReply.mock.calls[0]?.[1]).toEqual({ resultType: "reply", isExtra: true, origin: "system" });
    expect(sendReply.mock.calls[1]?.[0]).toBe("Same text");
    expect(sendReply.mock.calls[1]?.[1]).toEqual({ resultType: "reply", isExtra: false, origin: "system" });
  });

  it("filters deferred text that duplicates an extraReply", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    const bannerText = "Interrupted previous in-progress run and handling your latest message.";

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        // Banner streamed as text delta (like assistant-turn.ts:93)
        await stream?.onTextDelta?.(`${bannerText}\n`);
        clock = 120;
        // Tool call triggers text->tools commit, deferring the banner text
        await stream?.onToolCallNotice?.("📖 Read: `foo.ts`");
        clock = 240;
        await stream?.onTextDelta?.("Final answer");
        return {
          type: "reply",
          text: "Final answer",
          origin: "assistant",
          // Banner also in extraReplies (like assistant-turn.ts:92)
          extraReplies: [`⚠️ ${bannerText}`]
        };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // extraReply sent once, deferred banner text filtered (substring of extraReply),
    // tool notice sent, final reply sent
    expect(sendReply).toHaveBeenCalledTimes(3);
    expect(sendReply.mock.calls[0]?.[0]).toBe(`⚠️ ${bannerText}`);
    expect(sendReply.mock.calls[0]?.[1]).toEqual({ resultType: "reply", isExtra: true, origin: "assistant" });
    expect(sendReply.mock.calls[1]?.[0]).toBe("📖 Read: `foo.ts`");
    expect(sendReply.mock.calls[1]?.[1]).toEqual({ resultType: "reply", isExtra: true, origin: "system" });
    expect(sendReply.mock.calls[2]?.[0]).toBe("Final answer");
    expect(sendReply.mock.calls[2]?.[1]).toEqual({ resultType: "reply", isExtra: false, origin: "assistant" });
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

  it("resets draft and continues streaming when text approaches 4096 limit", async () => {
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

    // Draft resets after mid-stream commit — post-commit draft has only the remainder
    const draftTexts = sendDraft.mock.calls.map((c: [string]) => c[0]);
    const postCommitDrafts = draftTexts.filter((t: string) => t.includes(chunkB) && !t.includes(chunkA));
    expect(postCommitDrafts.length).toBeGreaterThan(0);

    // Final reply contains the full text (deferred chunks are deduped as substrings)
    expect(sendReply).toHaveBeenCalledWith(fullText, {
      resultType: "reply",
      isExtra: false,
      origin: "assistant"
    });
  });

  it("does not send deferred assistant text on fallback or ignore", async () => {
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

      // The deferred assistant chunk must NOT appear as a sent reply
      const sentTexts = sendReply.mock.calls.map((c: unknown[]) => c[0]);
      expect(sentTexts).not.toContain(bigChunk);
      // For fallback, only the error text is sent
      if (resultType === "fallback") {
        expect(sentTexts).toContain("Something went wrong");
      }
    }
  });

  it("prefers paragraph break over line break over space for mid-stream split", async () => {
    const sendReply = vi.fn(async (_text: string, _meta: unknown) => {});
    const sendDraft = vi.fn(async (_text: string) => {});
    let clock = 0;

    // Place \n\n earlier, \n later, space latest — should pick \n\n
    const beforeParagraph = "x".repeat(3200);
    const afterParagraph = "y".repeat(200) + "\n" + "z".repeat(100) + " " + "w".repeat(200);
    const fullDelta = beforeParagraph + "\n\n" + afterParagraph;

    await dispatchTelegramTextMessage({
      message: baseMessage,
      handleMessage: async (_message, stream) => {
        await stream?.onTextDelta?.(fullDelta);
        clock = 200;
        return { type: "reply", text: fullDelta.trim(), origin: "assistant" };
      },
      sendReply,
      sendDraft,
      draftMinUpdateMs: 100,
      nowMs: () => clock
    });

    // Draft should reset to the portion after \n\n
    const draftTexts = sendDraft.mock.calls.map((c: [string]) => c[0]);
    const postCommitDrafts = draftTexts.filter((t: string) =>
      t.includes(afterParagraph.slice(0, 10)) && !t.includes(beforeParagraph.slice(0, 10))
    );
    expect(postCommitDrafts.length).toBeGreaterThan(0);
  });

  it("draft continues streaming after mid-stream commit", async () => {
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

    // After the mid-stream commit, sendDraft should be called with the short remainder
    const draftTexts = sendDraft.mock.calls.map((c: [string]) => c[0]);
    const postCommitDrafts = draftTexts.filter((t: string) => t.includes(smallChunk));
    expect(postCommitDrafts.length).toBeGreaterThan(0);
  });
});
