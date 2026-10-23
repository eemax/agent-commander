import { spawn } from "node:child_process";
import * as os from "node:os";

export type BashResult = {
  exit_code: number | null;
  output: string;
  timed_out: boolean;
  truncated: boolean;
};

export type BashOptions = {
  command: string;
  cwd: string;
  timeoutMs: number;
  outputCapChars: number;
  signal?: AbortSignal;
};

// Keeps the first and last part of a stream within a fixed memory budget.
export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private total = 0;
  private readonly headCap: number;
  private readonly tailCap: number;

  constructor(cap: number) {
    this.headCap = Math.floor(cap * 0.4);
    this.tailCap = cap - this.headCap;
  }

  push(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < this.headCap) {
      const room = this.headCap - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (chunk.length === 0) return;
    this.tail += chunk;
    if (this.tail.length > this.tailCap * 2) this.tail = this.tail.slice(-this.tailCap);
  }

  result(): { text: string; truncated: boolean } {
    const kept = this.head.length + Math.min(this.tail.length, this.tailCap);
    if (this.total <= kept) return { text: this.head + this.tail, truncated: false };
    const tail = this.tail.slice(-this.tailCap);
    const omitted = this.total - this.head.length - tail.length;
    return { text: `${this.head}\n\n[... ${omitted} characters truncated ...]\n\n${tail}`, truncated: true };
  }
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

// acmd's own credentials never reach the commands the model runs.
const PRIVATE_ENV = ["TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY"];

function toolEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of PRIVATE_ENV) delete env[key];
  return env;
}

// Runs one command in a fresh login shell, in its own process group so a timeout or abort
// kills everything it started. Resolves on process exit, so a backgrounded child that keeps
// the pipes open does not hang the call.
export function runBash(options: BashOptions): Promise<BashResult> {
  return new Promise((resolve) => {
    const buffer = new HeadTailBuffer(options.outputCapChars);
    let timedOut = false;
    let settled = false;

    const child = spawn("/bin/bash", ["-lc", options.command], {
      cwd: options.cwd,
      env: toolEnv(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8").on("data", (d: string) => buffer.push(d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => buffer.push(d));

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, options.timeoutMs);
    const onAbort = () => killGroup(child.pid);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (extra) buffer.push(extra);
      const { text, truncated } = buffer.result();
      resolve({ exit_code: exitCode, output: text, timed_out: timedOut, truncated });
    };

    child.on("error", (error) => finish(null, `failed to start bash: ${error.message}`));
    child.on("exit", (code, signal) => {
      // Give the pipes a moment to drain, then return even if a background child still holds them.
      const exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : null);
      const done = () => finish(exitCode, timedOut ? `\n[timed out after ${options.timeoutMs} ms]` : "");
      const grace = setTimeout(done, 200);
      child.on("close", () => {
        clearTimeout(grace);
        done();
      });
    });
  });
}
