import { describe, expect, it } from "vitest";
import { TurnManager } from "../src/routing/turn-manager.js";

describe("TurnManager", () => {
  it("begins a turn and tracks it as active", () => {
    const tm = new TurnManager();
    const handle = tm.beginTurn("chat-1", "msg-1");

    expect(handle.token).toBeTruthy();
    expect(handle.interruptedPrevious).toBe(false);
    expect(handle.controller.signal.aborted).toBe(false);
    expect(tm.getActiveTurn("chat-1")).toBeDefined();
  });

  it("interrupts previous turn when beginning a new one", () => {
    const tm = new TurnManager();
    const first = tm.beginTurn("chat-1", "msg-1");
    const second = tm.beginTurn("chat-1", "msg-2");

    expect(second.interruptedPrevious).toBe(true);
    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(false);
  });

  it("releases turn only if token matches", () => {
    const tm = new TurnManager();
    const handle = tm.beginTurn("chat-1", "msg-1");

    tm.releaseTurn("chat-1", "wrong-token");
    expect(tm.getActiveTurn("chat-1")).toBeDefined();

    tm.releaseTurn("chat-1", handle.token);
    expect(tm.getActiveTurn("chat-1")).toBeUndefined();
  });

  it("isLatestTurn tracks the most recent token", () => {
    const tm = new TurnManager();
    const first = tm.beginTurn("chat-1", "msg-1");
    expect(tm.isLatestTurn("chat-1", first.token)).toBe(true);

    const second = tm.beginTurn("chat-1", "msg-2");
    expect(tm.isLatestTurn("chat-1", first.token)).toBe(false);
    expect(tm.isLatestTurn("chat-1", second.token)).toBe(true);
  });

  it("abortActiveTurn aborts and returns true, false if no turn", () => {
    const tm = new TurnManager();
    expect(tm.abortActiveTurn("chat-1")).toBe(false);

    const handle = tm.beginTurn("chat-1", "msg-1");
    expect(tm.abortActiveTurn("chat-1")).toBe(true);
    expect(handle.controller.signal.aborted).toBe(true);
  });

  it("keeps finalizing turns active but no longer steerable", () => {
    const tm = new TurnManager();
    const handle = tm.beginTurn("chat-1", "msg-1");

    tm.markTurnFinalizing("chat-1", handle.token);

    expect(tm.getActiveTurn("chat-1")).toBeDefined();
    expect(tm.getSteerableTurn("chat-1")).toBeUndefined();
    expect(tm.abortActiveTurn("chat-1")).toBe(true);
    expect(handle.controller.signal.aborted).toBe(true);
  });

  it("manages message queues per chat", () => {
    const tm = new TurnManager();
    expect(tm.getQueue("chat-1")).toBeUndefined();

    const queue = tm.getOrCreateQueue("chat-1");
    expect(queue).toBeDefined();
    expect(tm.getOrCreateQueue("chat-1")).toBe(queue);

    tm.deleteQueue("chat-1");
    expect(tm.getQueue("chat-1")).toBeUndefined();
  });

  it("keeps separate state per chat", () => {
    const tm = new TurnManager();
    const h1 = tm.beginTurn("chat-1", "msg-a");
    const h2 = tm.beginTurn("chat-2", "msg-b");

    expect(h1.interruptedPrevious).toBe(false);
    expect(h2.interruptedPrevious).toBe(false);
    expect(tm.getActiveTurn("chat-1")).toBeDefined();
    expect(tm.getActiveTurn("chat-2")).toBeDefined();

    tm.releaseTurn("chat-1", h1.token);
    expect(tm.getActiveTurn("chat-1")).toBeUndefined();
    expect(tm.getActiveTurn("chat-2")).toBeDefined();
  });
});
