import { describe, it, expect } from "vitest";
import {
  serializeConversationEvent,
  parseConversationEvent
} from "../src/state/events.js";
import type { ConversationEvent } from "../src/state/events.js";

const BASE = {
  timestamp: "2026-01-01T00:00:00Z",
  chatId: "chat-1",
  conversationId: "conv-1"
};

describe("serializeConversationEvent / parseConversationEvent", () => {
  it("round-trips conversation_created", () => {
    const event: ConversationEvent = {
      ...BASE,
      type: "conversation_created",
      reason: "user_request"
    };
    const line = serializeConversationEvent(event);
    expect(parseConversationEvent(line, "test.jsonl")).toEqual(event);
  });

  it("round-trips conversation_archived", () => {
    const event: ConversationEvent = {
      ...BASE,
      type: "conversation_archived",
      reason: "stash"
    };
    const line = serializeConversationEvent(event);
    expect(parseConversationEvent(line, "test.jsonl")).toEqual(event);
  });

  it("round-trips message with string content", () => {
    const event: ConversationEvent = {
      ...BASE,
      type: "message",
      role: "user",
      content: "hello world",
      senderId: "user-1",
      senderName: "Alice",
      telegramMessageId: "msg-1"
    };
    const line = serializeConversationEvent(event);
    expect(parseConversationEvent(line, "test.jsonl")).toEqual(event);
  });

  it("round-trips message with content-part array", () => {
    const event: ConversationEvent = {
      ...BASE,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      senderId: null,
      senderName: null,
      telegramMessageId: null
    };
    const line = serializeConversationEvent(event);
    expect(parseConversationEvent(line, "test.jsonl")).toEqual(event);
  });

  it("round-trips provider_failure", () => {
    const event: ConversationEvent = {
      ...BASE,
      type: "provider_failure",
      kind: "timeout",
      statusCode: 504,
      attempts: 3,
      message: "request timed out",
      telegramMessageId: "msg-2"
    };
    const line = serializeConversationEvent(event);
    expect(parseConversationEvent(line, "test.jsonl")).toEqual(event);
  });
});

describe("parseConversationEvent – validation", () => {
  it("throws on invalid JSON", () => {
    expect(() => parseConversationEvent("not json", "test.jsonl")).toThrow(
      "Invalid JSONL event in test.jsonl"
    );
  });

  it("throws on missing required fields", () => {
    expect(() =>
      parseConversationEvent(JSON.stringify({ type: "conversation_created" }), "test.jsonl")
    ).toThrow("Invalid conversation event in test.jsonl");
  });

  it("throws on unknown event type", () => {
    expect(() =>
      parseConversationEvent(
        JSON.stringify({ ...BASE, type: "nonexistent_type" }),
        "test.jsonl"
      )
    ).toThrow("Invalid conversation event in test.jsonl");
  });

  it("throws on invalid message role", () => {
    expect(() =>
      parseConversationEvent(
        JSON.stringify({
          ...BASE,
          type: "message",
          role: "system",
          content: "hi",
          senderId: null,
          senderName: null,
          telegramMessageId: null
        }),
        "test.jsonl"
      )
    ).toThrow("Invalid conversation event in test.jsonl");
  });
});
