import { describe, it, expect } from "vitest";
import { createSteerChannel } from "../src/steer-channel.js";

describe("createSteerChannel", () => {
  it("starts empty and drain returns empty array", () => {
    const ch = createSteerChannel();
    expect(ch.drain()).toEqual([]);
  });

  it("push and drain returns messages in order", () => {
    const ch = createSteerChannel();
    ch.push("msg1");
    ch.push("msg2");
    expect(ch.drain()).toEqual(["msg1", "msg2"]);
  });

  it("drain clears the buffer", () => {
    const ch = createSteerChannel();
    ch.push("msg1");
    ch.drain();
    expect(ch.drain()).toEqual([]);
  });
});
