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

    expect(sendDraft.mock.calls.map((call) => call[0])).toEqual(["Hel", "Hello!"]);
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

    expect(sendDraft.mock.calls.map((call) => call[0])).toEqual(["Hello", "Hello world"]);
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

    expect(sendDraft).toHaveBeenCalledTimes(1);
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

  it("sends extra replies before final reply", async () => {
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
});
