// Every bash command runs as a job: a detached wrapper shell that runs the command with its
// output in a log file, ignores the signals a group kill sends, and records the exit code and
// final working directory in files. A foreground call waits for its job; when it times out the
// job simply keeps running as a background job. The daemon sweeps background jobs and wakes the
// agent when one ends, so nothing depends on acmd being the parent or being up at the time.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { log } from "./log.js";
import { atomicWrite } from "./state.js";
import { tailLines } from "./tools/output.js";

export type JobState = "running" | "exited" | "lost";

export type Job = {
  id: number;
  chatId: string;
  conversationId: string;
  command: string;
  cwd: string;
  startedAt: string;
  pgid: number;
  boot: number; // boot time in minutes since the epoch (fallback when there is no boot id)
  bootId?: string; // Linux boot id: a job from an earlier boot is gone, whatever the clock did
  foreground: boolean; // a call is waiting on it; background jobs are swept and delivered
  promoted: boolean; // started in the foreground, moved to the background when the call timed out
  state: JobState;
  exitCode: number | null;
  endedAt: string | null;
  note: string | null; // why acmd ended it, if it did
  delivered: boolean;
};

export type JobInit = { chatId: string; conversationId: string; command: string; cwd: string; foreground?: boolean };

// A background job is stopped once its log passes this size.
export const BACKGROUND_LOG_CAP = 1024 ** 3;
// How long a TERMed job gets before it is SIGKILLed: a stop request leaves time to clean up;
// a runaway past its output cap does not (a fast writer adds hundreds of MB per second).
export const KILL_GRACE_MS = 10_000;
export const CAP_KILL_GRACE_MS = 500;
// Commands are this long at most in notices; the full text stays in the job's command.sh.
const NOTICE_COMMAND_CHARS = 500;

// The wrapper ignores TERM, INT and HUP from its first line, so `kill -- -<pgid>` (which hits
// the whole group) never stops it before it records how the command ended. The command runs in
// a foreground subshell that resets those signals to their defaults, so it stays killable (an
// asynchronous one would have SIGINT ignored by bash, beyond the reach of `trap -`). The command is
// sourced from command.sh (an environment variable would cap its size at 128 KB and leak into
// every child), keeping bash's line numbers in error messages exact. Its EXIT trap records the
// directory it ended in, so a foreground `cd` carries over to the next call. Plain shells
// throughout: the environment is already a login-shell snapshot (tools/shellenv.ts).
const WRAPPER = `
trap '' TERM INT HUP
( trap - TERM INT HUP
  __acmd_job=$ACMD_JOB_DIR; export -n ACMD_JOB_DIR
  trap 'printf %s "$PWD" > "$__acmd_job/cwd"' EXIT
  . "$__acmd_job/command.sh" ) </dev/null >"$ACMD_JOB_DIR/output.log" 2>&1
code=$?
echo "$code" > "$ACMD_JOB_DIR/exit.tmp" && mv "$ACMD_JOB_DIR/exit.tmp" "$ACMD_JOB_DIR/exit"
`;

let linuxBootId: string | null | undefined;

// Exact on Linux; elsewhere the boot time (rounded to minutes) stands in.
export function currentBootId(): string | null {
  if (linuxBootId === undefined) {
    try {
      linuxBootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    } catch {
      linuxBootId = null;
    }
  }
  return linuxBootId;
}

export function currentBoot(): number {
  return Math.round((Date.now() / 1000 - os.uptime()) / 60);
}

function sameBoot(job: Job): boolean {
  const id = currentBootId();
  if (id !== null && job.bootId !== undefined) return job.bootId === id;
  return Math.abs(job.boot - currentBoot()) <= 1; // ±1 min of uptime rounding
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export class Jobs {
  readonly dir: string;
  private readonly counterFile: string;
  private lastId = 0;
  // Background jobs still running or not yet delivered: the only ones a sweep looks at.
  // Foreground jobs join only when promoted, so a finished call is never also delivered.
  private readonly active = new Set<number>();

  constructor(
    stateDir: string,
    private readonly env: () => NodeJS.ProcessEnv,
    private readonly backgroundLogCap = BACKGROUND_LOG_CAP
  ) {
    this.dir = path.join(stateDir, "jobs");
    this.counterFile = path.join(this.dir, "last-id");
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      this.lastId = Number.parseInt(fs.readFileSync(this.counterFile, "utf8"), 10) || 0;
    } catch {
      // no jobs yet
    }
    for (const name of fs.readdirSync(this.dir)) if (/^\d+$/.test(name)) this.lastId = Math.max(this.lastId, Number(name));
    // Includes foreground jobs whose call died with a previous acmd process: they are adopted
    // as background jobs, so whatever they were doing is still reported.
    for (const job of this.list({ all: true })) {
      if (job.state === "running" || !job.delivered) this.active.add(job.id);
    }
  }

  private jobDir(id: number): string {
    return path.join(this.dir, String(id));
  }

  logPath(id: number): string {
    return path.join(this.jobDir(id), "output.log");
  }

  private save(job: Job): void {
    atomicWrite(path.join(this.jobDir(job.id), "job.json"), `${JSON.stringify(job, null, 2)}\n`);
  }

  get(id: number): Job | null {
    const file = path.join(this.jobDir(id), "job.json");
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Job;
    } catch {
      return null;
    }
  }

  // Background jobs (including promoted ones), newest first. `all` adds foreground calls.
  list(options: { all?: boolean } = {}): Job[] {
    return fs
      .readdirSync(this.dir)
      .filter((name) => /^\d+$/.test(name))
      .map((name) => this.get(Number(name)))
      .filter((job): job is Job => job !== null && (options.all === true || !job.foreground))
      .sort((a, b) => b.id - a.id);
  }

  running(): Job[] {
    return this.list().filter((j) => j.state === "running");
  }

  // Ids come from a counter that is persisted whenever an id becomes visible to the model
  // (background job, promotion, kept output), so pruning never leads to reusing one that older
  // notices still refer to. Ids of plain foreground calls are never seen, so they skip the write.
  private nextId(): number {
    this.lastId += 1;
    return this.lastId;
  }

  private persistId(id: number): void {
    let stored = 0;
    try {
      stored = Number.parseInt(fs.readFileSync(this.counterFile, "utf8"), 10) || 0;
    } catch {
      // first visible id
    }
    if (id > stored) atomicWrite(this.counterFile, `${id}\n`);
  }

  // Starts a job. `exited` settles when the wrapper process ends (only while this acmd process
  // is its parent; the sweep covers the rest).
  start(init: JobInit): { job: Job; exited: Promise<void> } {
    const id = this.nextId();
    const dir = this.jobDir(id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "command.sh"), `${init.command}\n`);
    const child = spawn("/bin/bash", ["-c", WRAPPER], {
      cwd: init.cwd,
      // PWD lets bash keep the logical path (no symlinks resolved) as $PWD.
      env: { ...this.env(), PWD: init.cwd, ACMD_JOB_DIR: dir },
      detached: true,
      stdio: "ignore"
    });
    const exited = new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.on("error", (error) => {
        log.warn("job wrapper failed", { job: id, error: error.message });
        resolve();
      });
    });
    child.unref();
    if (child.pid === undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`could not start a shell in ${init.cwd}`);
    }
    const job: Job = {
      id,
      chatId: init.chatId,
      conversationId: init.conversationId,
      command: init.command,
      cwd: init.cwd,
      startedAt: new Date().toISOString(),
      pgid: child.pid,
      boot: currentBoot(),
      ...(currentBootId() !== null ? { bootId: currentBootId()! } : {}),
      foreground: init.foreground === true,
      promoted: false,
      state: "running",
      exitCode: null,
      endedAt: null,
      note: null,
      delivered: false
    };
    // Plain write: the directory is brand new, so no reader can see a partial file.
    fs.writeFileSync(path.join(dir, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
    if (!job.foreground) {
      this.persistId(id);
      this.active.add(id);
    }
    log.debug("job started", { job: id, pgid: job.pgid, foreground: job.foreground });
    return { job, exited };
  }

  // Exit code and final directory written by the wrapper, if it got that far.
  readExit(id: number): number | null {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.jobDir(id), "exit"), "utf8");
    } catch {
      return null;
    }
    const code = Number.parseInt(text, 10);
    return Number.isNaN(code) ? null : code;
  }

  // When the command actually ended: the exit file's write time (a sweep may notice much later,
  // e.g. after an acmd restart). Falls back to now for jobs that left no exit file.
  private endTime(id: number): string {
    try {
      return fs.statSync(path.join(this.jobDir(id), "exit")).mtime.toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  readCwd(id: number): string | null {
    try {
      return fs.readFileSync(path.join(this.jobDir(id), "cwd"), "utf8");
    } catch {
      return null;
    }
  }

  logSize(id: number): number {
    try {
      return fs.statSync(this.logPath(id)).size;
    } catch {
      return 0;
    }
  }

  // Signals the job's process group. TERM lets the wrapper record how the command ended.
  signal(id: number, signal: NodeJS.Signals, note?: string): boolean {
    const job = this.get(id);
    if (!job || job.state !== "running") return false;
    if (note) {
      job.note = note;
      this.save(job);
    }
    try {
      process.kill(-job.pgid, signal);
      return true;
    } catch {
      return false;
    }
  }

  // TERM first; if the job is still running after the grace period, KILL (which also ends the
  // wrapper, so the job is reported without an exit status, with the note saying why).
  terminate(id: number, note?: string, graceMs = KILL_GRACE_MS): boolean {
    if (!this.signal(id, "SIGTERM", note)) return false;
    setTimeout(() => {
      const job = this.get(id);
      if (job?.state === "running" && this.readExit(id) === null && alive(job.pgid)) {
        const why = job.note ? `${job.note}; killed after it ignored SIGTERM` : "killed after it ignored SIGTERM";
        this.signal(id, "SIGKILL", why);
      }
    }, graceMs).unref();
    return true;
  }

  stop(id: number): boolean {
    return this.terminate(id);
  }

  // The call stopped waiting: from now on the job is swept and delivered like any background job.
  promote(id: number): Job | null {
    const job = this.get(id);
    if (!job) return null;
    job.foreground = false;
    job.promoted = true;
    this.save(job);
    this.persistId(id);
    this.active.add(id);
    return job;
  }

  // A foreground call is done with its job. The directory is kept (for the usual retention)
  // only when the model was pointed at the full output file.
  finishForeground(id: number, keep: boolean): void {
    if (!keep) {
      fs.rmSync(this.jobDir(id), { recursive: true, force: true });
      return;
    }
    const job = this.get(id);
    if (!job) return;
    this.persistId(id);
    const code = this.readExit(id);
    job.state = code === null ? "lost" : "exited";
    job.exitCode = code;
    job.endedAt = this.endTime(id);
    job.delivered = true;
    this.save(job);
  }

  // Updates background jobs that ended since the last sweep, and stops any whose log passed
  // the cap. Returns every ended job not yet delivered.
  sweep(): Job[] {
    const ended: Job[] = [];
    for (const id of this.active) {
      const job = this.get(id);
      if (!job) {
        this.active.delete(id);
        continue;
      }
      if (job.state === "running") {
        let code = this.readExit(id);
        // Same boot and wrapper alive: still running.
        if (code === null && sameBoot(job) && alive(job.pgid)) {
          if (job.note === null && this.logSize(id) > this.backgroundLogCap) {
            this.terminate(id, `stopped by acmd: its output passed ${Math.round(this.backgroundLogCap / 1_048_576)} MB`, CAP_KILL_GRACE_MS);
          }
          continue;
        }
        code ??= this.readExit(id); // the wrapper may have finished between the two checks
        const current = this.get(id) ?? job; // pick up a note written by signal()
        current.state = code === null ? "lost" : "exited";
        current.exitCode = code;
        current.endedAt = this.endTime(id);
        this.save(current);
        log.debug("job ended", { job: id, state: current.state, exit_code: current.exitCode });
        if (!current.delivered) ended.push(current);
        continue;
      }
      if (!job.delivered) ended.push(job);
    }
    return ended.sort((a, b) => a.id - b.id);
  }

  markDelivered(id: number): void {
    this.active.delete(id);
    const job = this.get(id);
    if (!job) return;
    job.delivered = true;
    this.save(job);
  }

  tail(id: number, lines = 20, maxChars = 2000): string {
    return tailLines(this.logPath(id), lines, maxChars);
  }

  // Removes ended, delivered jobs older than maxAgeMs.
  prune(maxAgeMs: number): number {
    let removed = 0;
    for (const job of this.list({ all: true })) {
      if (job.state === "running" || !job.delivered || !job.endedAt) continue;
      if (Date.now() - Date.parse(job.endedAt) < maxAgeMs) continue;
      fs.rmSync(this.jobDir(job.id), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }
}

// What the agent is told when a background job ends.
export function jobNotice(jobs: Jobs, job: Job, currentConversationId: string | null): string {
  const ran = formatDuration(Date.parse(job.endedAt ?? new Date().toISOString()) - Date.parse(job.startedAt));
  const what = job.promoted ? `Command ${job.id} (moved to the background when its call timed out)` : `Background job ${job.id}`;
  const head =
    job.state === "exited"
      ? `[acmd] ${what} finished: exit ${job.exitCode} after ${ran}.`
      : `[acmd] ${what} ended without an exit status after about ${ran} (killed with SIGKILL, or the machine restarted).`;
  const lines = [head];
  if (job.note) lines.push(`Note: ${job.note}.`);
  const command = job.command.length > NOTICE_COMMAND_CHARS ? `${job.command.slice(0, NOTICE_COMMAND_CHARS)}… (${job.command.length} chars)` : job.command;
  lines.push(`Command: ${command}`, `Cwd: ${job.cwd}`);
  if (currentConversationId !== null && job.conversationId !== currentConversationId) {
    lines.push("It was started in an earlier conversation.");
  }
  const tail = jobs.tail(job.id);
  lines.push(`Log: ${jobs.logPath(job.id)}${tail ? " (last lines below)" : " (empty)"}`);
  if (tail) lines.push("```", tail, "```");
  return lines.join("\n");
}
