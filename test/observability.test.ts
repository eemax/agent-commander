import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createObservabilitySink, createTraceRootContext } from "../src/observability.js";
import { createTempDir } from "./helpers.js";

describe("createObservabilitySink", () => {
  it("does not write when disabled", async () => {
    const root = createTempDir("acmd-observability-disabled-");
    const logPath = path.join(root, "observability.jsonl");
    const sink = createObservabilitySink({
      enabled: false,
      logPath
    });

    await sink.record({
      event: "test.event",
      trace: createTraceRootContext("system"),
      value: "x"
    });

    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("writes structured JSONL with safe serialization when enabled", async () => {
    const root = createTempDir("acmd-observability-enabled-");
    const logPath = path.join(root, "observability.jsonl");
    const sink = createObservabilitySink({
      enabled: true,
      logPath
    });

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await sink.record({
      event: "test.event",
      trace: createTraceRootContext("system"),
      big: 42n,
      fn: () => "x",
      circular
    });

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const payload = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(payload.event).toBe("test.event");
    expect(payload.timestamp).toEqual(expect.any(String));
    expect(payload.big).toBe("42");
    expect(payload.fn).toBe("[Function]");
    expect(payload.circular).toEqual({ self: "[Circular]" });
    expect(payload.trace).toEqual(
      expect.objectContaining({
        traceId: expect.any(String),
        spanId: expect.any(String),
        parentSpanId: null
      })
    );
  });

  it("redacts configured sensitive keys and truncates oversized strings by default", async () => {
    const root = createTempDir("acmd-observability-redaction-");
    const logPath = path.join(root, "observability.jsonl");
    const sink = createObservabilitySink({
      enabled: true,
      logPath
    });

    await sink.record({
      event: "test.redaction",
      trace: createTraceRootContext("system"),
      headers: {
        authorization: "Bearer secret-token"
      },
      nested: {
        apiKey: "openai-key",
        text: "a".repeat(5_000)
      }
    });

    const payload = JSON.parse(fs.readFileSync(logPath, "utf8").trim()) as Record<string, unknown>;
    expect((payload.headers as { authorization?: string }).authorization).toBe("[REDACTED]");
    expect((payload.nested as { apiKey?: string }).apiKey).toBe("[REDACTED]");
    const truncated = (payload.nested as { text?: string }).text ?? "";
    expect(truncated.length).toBeGreaterThan(4_000);
    expect(truncated).toContain("[TRUNCATED:+");
  });

  it("warns once when append fails and keeps writes non-blocking", async () => {
    const logPath = path.join("/dev/null", "observability.jsonl");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const sink = createObservabilitySink({
        enabled: true,
        logPath
      });

      await expect(
        sink.record({
          event: "test.write_failure",
          trace: createTraceRootContext("system"),
          index: 1
        })
      ).resolves.toBeUndefined();
      await expect(
        sink.record({
          event: "test.write_failure",
          trace: createTraceRootContext("system"),
          index: 2
        })
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warningText = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(warningText).toContain("observability: failed to append event");
      expect(warningText).toContain(logPath);
      expect(warningText).toContain("EEXIST");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
