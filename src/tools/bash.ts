// The bash tool's execution: every command runs as a job (src/jobs.ts). A foreground call
// waits for its job up to the timeout; if the command is still running then, the call returns
// what it has so far and the job carries on in the background, waking the agent when it ends.
import * as fs from "node:fs";
import type { JobInit, Jobs } from "../jobs.js";
import { readOutput } from "./output.js";

// acmd's own credentials never reach the commands the model runs.
const PRIVATE_ENV = ["TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY"];

// Nothing may stop to ask a question: there is no one at the terminal (stdin is /dev/null too).
const NON_INTERACTIVE_ENV = {
  PAGER: "cat",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  DEBIAN_FRONTEND: "noninteractive"
};

// A foreground command is stopped once its output passes this size.
export const FOREGROUND_LOG_CAP = 100 * 1024 ** 2;
const CAP_CHECK_MS = 1000;

export function toolEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...NON_INTERACTIVE_ENV };
  for (const key of PRIVATE_ENV) delete env[key];
  return env;
}

export type ForegroundResult =
  | {
      exit_code: number | null;
      output: string;
      truncated: boolean;
      full_output?: string;
      cwd?: string; // the directory the command ended in, when it changed
      note?: string;
    }
  | {
      still_running: true;
      job_id: number;
      pgid: number;
      log: string;
      output: string;
      note: string;
    };

export type ForegroundOptions = JobInit & {
  timeoutMs: number;
  outputCapChars: number;
  signal?: AbortSignal;
  logCap?: number;
};

export async function runForeground(jobs: Jobs, options: ForegroundOptions): Promise<ForegroundResult> {
  const { job, exited } = jobs.start({ ...options, foreground: true });
  const logCap = options.logCap ?? FOREGROUND_LOG_CAP;
  let capNote: string | undefined;
  const timers: NodeJS.Timeout[] = [];
  let onAbort: (() => void) | undefined;

  const outcome = await new Promise<"exit" | "timeout" | "abort">((resolve) => {
    void exited.then(() => resolve("exit"));
    timers.push(setTimeout(() => resolve("timeout"), options.timeoutMs));
    timers.push(
      setInterval(() => {
        if (capNote === undefined && jobs.logSize(job.id) > logCap) {
          capNote = `stopped by acmd: output passed ${Math.round(logCap / 1_048_576)} MB`;
          jobs.signal(job.id, "SIGTERM", capNote);
        }
      }, CAP_CHECK_MS)
    );
    if (options.signal?.aborted) resolve("abort");
    onAbort = () => resolve("abort");
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
  for (const t of timers) clearTimeout(t);
  if (onAbort) options.signal?.removeEventListener("abort", onAbort);

  if (outcome === "abort") {
    jobs.signal(job.id, "SIGKILL");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    jobs.finishForeground(job.id, false);
    return { exit_code: null, output: "[stopped]", truncated: false };
  }

  const log = jobs.logPath(job.id);
  if (outcome === "timeout") {
    jobs.promote(job.id);
    const sofar = readOutput(log, options.outputCapChars);
    return {
      still_running: true,
      job_id: job.id,
      pgid: job.pgid,
      log,
      output: sofar.text,
      note:
        `Still running after ${Math.round(options.timeoutMs / 1000)} s, so it continues as background job ${job.id}; ` +
        `you will get a message when it exits. Progress: tail the log. Stop it: kill -- -${job.pgid}`
    };
  }

  const exitCode = jobs.readExit(job.id);
  const output = readOutput(log, options.outputCapChars);
  const endedIn = jobs.readCwd(job.id);
  jobs.finishForeground(job.id, output.truncated);
  const result: ForegroundResult = { exit_code: exitCode, output: output.text, truncated: output.truncated };
  if (output.truncated) result.full_output = log;
  if (endedIn && isDirectory(endedIn) && !sameDirectory(endedIn, options.cwd)) result.cwd = endedIn;
  if (capNote) result.note = capNote;
  return result;
}

function sameDirectory(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return a === b;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
