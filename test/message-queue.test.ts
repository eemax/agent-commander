import { describe, it, expect } from "vitest";
import { createMessageQueue } from "../src/message-queue.js";
import type { QueuedMessage } from "../src/message-queue.js";

function makeEntry(text: string): QueuedMessage {
  return {
    message: { chatId: "c1", senderId: "u1", senderName: "A", messageId: "m1", text, attachments: [], receivedAt: new Date().toISOString() },
    trace: { traceId: "t1", spanId: "s1", parentSpanId: null, origin: "test" }
  } as QueuedMessage;
}

describe("createMessageQueue", () => {
  it("starts empty", () => {
    const q = createMessageQueue();
    expect(q.length).toBe(0);
  });

  it("push returns new length", () => {
    const q = createMessageQueue();
    expect(q.push(makeEntry("a"))).toBe(1);
    expect(q.push(makeEntry("b"))).toBe(2);
  });

  it("drain returns all items in FIFO order and empties buffer", () => {
    const q = createMessageQueue();
    q.push(makeEntry("a"));
    q.push(makeEntry("b"));
    const items = q.drain();
    expect(items).toHaveLength(2);
    expect(items[0].message.text).toBe("a");
    expect(items[1].message.text).toBe("b");
    expect(q.length).toBe(0);
  });

  it("drainOne returns first item", () => {
    const q = createMessageQueue();
    q.push(makeEntry("a"));
    q.push(makeEntry("b"));
    expect(q.drainOne()?.message.text).toBe("a");
    expect(q.length).toBe(1);
  });

  it("drainOne returns null when empty", () => {
    const q = createMessageQueue();
    expect(q.drainOne()).toBeNull();
  });
});
