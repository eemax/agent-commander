import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { HeadTailBuffer, runBash } from "../src/tools/bash.js";

const base = { cwd: os.tmpdir(), timeoutMs: 10_000, outputCapChars: 30_000 };

describe("runBash", () => {
  it("returns exit code and merged output", async () => {
    const r = await runBash({ ...base, command: "echo out; echo err >&2; exit 3" });
    expect(r.exit_code).toBe(3);
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
    expect(r.timed_out).toBe(false);
  });

  it("hides acmd's own credentials from commands", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    const r = await runBash({ ...base, command: 'echo "key=${OPENROUTER_API_KEY:-unset}"' });
    delete process.env.OPENROUTER_API_KEY;
    expect(r.output.trim()).toBe("key=unset");
  });

  it("runs in the given cwd", async () => {
    const r = await runBash({ ...base, command: "pwd -P" });
    expect(r.output.trim()).toBe((await import("node:fs")).realpathSync(os.tmpdir()));
  });

  it("kills the whole process group on timeout", async () => {
    const marker = `acmd-test-${process.pid}-${Date.now()}`;
    const r = await runBash({ ...base, timeoutMs: 500, command: `sleep 30 & echo started; sleep 30 # ${marker}` });
    expect(r.timed_out).toBe(true);
    expect(r.output).toContain("started");
    expect(r.output).toContain("timed out");
    // "[a]" keeps the pattern from matching the shell that runs pgrep (its command line holds the pattern).
    const left = await runBash({ ...base, command: `pgrep -f '[a]${marker.slice(1)}' || true` });
    expect(left.output.trim()).toBe("");
  });

  it("returns promptly when a background child keeps running", async () => {
    const started = Date.now();
    const r = await runBash({ ...base, command: "nohup sleep 5 >/dev/null 2>&1 & echo bg" });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.output).toContain("bg");
    await runBash({ ...base, command: "pkill -f 'sleep 5' || true" });
  });

  it("stops on abort", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const r = await runBash({ ...base, command: "sleep 30", signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.exit_code).not.toBe(0);
  });

  it("caps output keeping head and tail", async () => {
    const r = await runBash({ ...base, outputCapChars: 2000, command: "seq 1 100000" });
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeLessThan(2200);
    expect(r.output.startsWith("1\n2\n")).toBe(true);
    expect(r.output.trimEnd().endsWith("100000")).toBe(true);
    expect(r.output).toContain("characters truncated");
  });
});

describe("HeadTailBuffer", () => {
  it("keeps everything under the cap", () => {
    const b = new HeadTailBuffer(100);
    b.push("hello ");
    b.push("world");
    expect(b.result()).toEqual({ text: "hello world", truncated: false });
  });

  it("reports omitted characters exactly", () => {
    const b = new HeadTailBuffer(10);
    for (let i = 0; i < 100; i++) b.push("x");
    const { text, truncated } = b.result();
    expect(truncated).toBe(true);
    expect(text).toContain("[... 90 characters truncated ...]");
  });
});
