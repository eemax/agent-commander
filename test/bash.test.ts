import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Jobs } from "../src/jobs.js";
import { type ForegroundOptions, runForeground, toolEnv } from "../src/tools/bash.js";
import { cleanOutput, readOutput } from "../src/tools/output.js";
import { loginEnv, parseEnv } from "../src/tools/shellenv.js";

let stateDir: string;
let jobs: Jobs;
let cwd: string;

function opts(command: string, extra: Partial<ForegroundOptions> = {}): ForegroundOptions {
  return { chatId: "1", conversationId: "conv_a", command, cwd, timeoutMs: 10_000, outputCapChars: 30_000, ...extra };
}

async function sweepUntilEnded(id: number, within = 10_000) {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    const job = jobs.sweep().find((j) => j.id === id);
    if (job) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${id} did not end`);
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "acmd-bash-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acmd-cwd-"));
  jobs = new Jobs(stateDir, toolEnv);
});

afterEach(() => {
  for (const job of jobs.list({ all: true })) {
    try {
      process.kill(-job.pgid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

describe("runForeground", () => {
  it("returns exit code and merged output, and leaves nothing behind", async () => {
    const r = await runForeground(jobs, opts("echo out; echo err >&2; exit 3"));
    expect(r).toEqual({ exit_code: 3, output: "out\nerr\n", truncated: false });
    expect(jobs.list({ all: true })).toEqual([]);
    expect(jobs.sweep()).toEqual([]); // a finished call is never delivered as a wake-up
  });

  it("hides acmd's own credentials and sets a non-interactive environment", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    const r = await runForeground(jobs, opts('echo "key=${OPENROUTER_API_KEY:-unset} pager=$GIT_PAGER prompt=$GIT_TERMINAL_PROMPT"'));
    delete process.env.OPENROUTER_API_KEY;
    expect("output" in r && r.output.trim()).toBe("key=unset pager=cat prompt=0");
  });

  it("runs in the cwd and reports a cd only when the directory changed", async () => {
    const sub = path.join(cwd, "sub");
    fs.mkdirSync(sub);
    const stay = await runForeground(jobs, opts("pwd"));
    expect("output" in stay && stay.output.trim()).toBe(cwd);
    expect("cwd" in stay).toBe(false);
    const moved = await runForeground(jobs, opts("cd sub && echo ok"));
    expect("cwd" in moved && moved.cwd).toBe(sub);
    const exitedAfterCd = await runForeground(jobs, opts("cd sub; exit 4"));
    expect(exitedAfterCd).toMatchObject({ exit_code: 4, cwd: sub });
  });

  it("does not report a cd into a directory that is gone", async () => {
    const r = await runForeground(jobs, opts("mkdir gone && cd gone && rmdir ../gone"));
    expect("cwd" in r).toBe(false);
  });

  it("moves a command that outlives the timeout to the background instead of killing it", async () => {
    const r = await runForeground(jobs, opts("echo started; sleep 2; echo finished", { timeoutMs: 1000 }));
    if (!("still_running" in r)) throw new Error("expected still_running");
    expect(r.output).toContain("started");
    expect(r.note).toContain(`kill -- -${r.pgid}`);
    expect(jobs.list().map((j) => j.id)).toEqual([r.job_id]); // visible in /jobs now
    const ended = await sweepUntilEnded(r.job_id);
    expect(ended).toMatchObject({ state: "exited", exitCode: 0, promoted: true });
    expect(jobs.tail(r.job_id)).toBe("started\nfinished");
  });

  it("kills the command and everything it started on abort", async () => {
    const marker = `acmd-test-${process.pid}-${Date.now()}`;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const r = await runForeground(jobs, opts(`sleep 30 & sleep 30 # ${marker}`, { signal: controller.signal }));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r).toMatchObject({ exit_code: null, output: "[stopped]" });
    // "[a]" keeps the pattern from matching the shell that runs pgrep (its command line holds the pattern).
    const left = await runForeground(jobs, opts(`pgrep -f '[a]${marker.slice(1)}' || true`));
    expect("output" in left && left.output.trim()).toBe("");
    expect(jobs.list({ all: true })).toEqual([]);
  });

  it("returns promptly when a background child keeps the output open", async () => {
    const started = Date.now();
    const r = await runForeground(jobs, opts("sleep 5 & echo bg"));
    expect(Date.now() - started).toBeLessThan(3000);
    expect("output" in r && r.output).toContain("bg");
  });

  it("caps output, keeps the full log and points to it", async () => {
    const r = await runForeground(jobs, opts("seq 1 100000", { outputCapChars: 2000 }));
    if (!("truncated" in r)) throw new Error("expected a finished result");
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeLessThan(2300);
    expect(r.output.startsWith("1\n2\n")).toBe(true);
    expect(r.output.trimEnd().endsWith("100000")).toBe(true);
    expect(r.full_output && fs.readFileSync(r.full_output, "utf8").split("\n")).toHaveLength(100001);
    expect(r.output).toContain(r.full_output!);
    expect(jobs.list()).toEqual([]); // kept for the file, but not a background job
  });

  it("stops a command whose output passes the log cap", async () => {
    const r = await runForeground(jobs, opts("yes acmd", { logCap: 2_000_000 }));
    expect(r).toMatchObject({ exit_code: 143, note: expect.stringContaining("stopped by acmd") });
  });

  it("replaces binary output", async () => {
    const r = await runForeground(jobs, opts("head -c 3000 /dev/urandom; printf '\\0\\0'"));
    expect("output" in r && r.output).toMatch(/^\[binary output, /);
  });
});

describe("login environment", () => {
  it("parses env -0 output and drops per-shell variables", () => {
    expect(parseEnv("PATH=/bin:/usr/bin\0PWD=/x\0SHLVL=2\0SSH_CLIENT=1.2.3.4 5 22\0A=b=c\0MULTI=line1\nline2\0")).toEqual({
      PATH: "/bin:/usr/bin",
      A: "b=c",
      MULTI: "line1\nline2"
    });
  });

  it("captures the login shell's environment once and reuses it", () => {
    const first = loginEnv();
    expect(first.PATH).toBeTruthy();
    expect(loginEnv()).toBe(first);
  });
});

describe("output cleaning", () => {
  it("strips colors and terminal codes", () => {
    expect(cleanOutput("\x1b[1;31mred\x1b[0m \x1b]8;;https://x.y\x07link\x1b]8;;\x07 \x07bell")).toBe("red link bell");
  });

  it("keeps only the final state of carriage-return progress bars", () => {
    expect(cleanOutput("Downloading 10%\rDownloading 55%\rDownloading 100%\ndone\r\n")).toBe("Downloading 100%\ndone\n");
  });

  it("reads huge logs from both ends without loading them", () => {
    const file = path.join(stateDir, "big.log");
    const line = `${"x".repeat(99)}\n`;
    fs.writeFileSync(file, `FIRST\n${line.repeat(200_000)}LAST\n`);
    const r = readOutput(file, 1000);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("FIRST\n")).toBe(true);
    expect(r.text.trimEnd().endsWith("LAST")).toBe(true);
    expect(r.text).toContain("19.1 MB in total");
    expect(r.text.length).toBeLessThan(1200);
  });
});
