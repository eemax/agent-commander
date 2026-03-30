import { describe, expect, it } from "vitest";
import { parseCliCommand } from "../src/cli/parse.js";

describe("cli parse", () => {
  it("treats bare acmd as help", () => {
    expect(parseCliCommand([])).toEqual({
      ok: true,
      command: { name: "help" }
    });
  });

  it("parses help and status commands", () => {
    expect(parseCliCommand(["help"])).toEqual({
      ok: true,
      command: { name: "help" }
    });
    expect(parseCliCommand(["status"])).toEqual({
      ok: true,
      command: { name: "status" }
    });
  });

  it("parses rebuild flags", () => {
    expect(parseCliCommand(["start", "--rebuild"])).toEqual({
      ok: true,
      command: { name: "start", rebuild: true }
    });
    expect(parseCliCommand(["restart"])).toEqual({
      ok: true,
      command: { name: "restart", rebuild: false }
    });
  });

  it("parses internal runtime invocation", () => {
    expect(parseCliCommand(["__runtime", "--instance-id", "rt_123"])).toEqual({
      ok: true,
      command: { name: "__runtime", instanceId: "rt_123" }
    });
  });

  it("rejects unknown commands", () => {
    expect(parseCliCommand(["wat"])).toEqual({
      ok: false,
      error: "Unknown command: wat"
    });
  });

  it("rejects unsupported flags", () => {
    expect(parseCliCommand(["start", "--wat"])).toEqual({
      ok: false,
      error: "Unknown flag: --wat"
    });
  });
});
