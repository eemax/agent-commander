// Background jobs: commands that outlive the turn (and acmd restarts) and wake the agent when
// they exit. Each job is a detached wrapper shell that runs the command, ignores the signals a
// group kill sends, and records the exit code in a file. The daemon sweeps job directories, so
// nothing depends on acmd being the job's parent or being up when it finishes.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { log } from "./log.js";
import { atomicWrite } from "./state.js";

export type JobState = "running" | "exited" | "lost";

export type Job = {
  id: number;
  chatId: string;
  conversationId: string;
  command: string;
  cwd: string;
  startedAt: string;
  pgid: number;
  boot: number; // boot time in minutes since the epoch: a job from an earlier boot is gone
  state: JobState;
  exitCode: number | null;
  endedAt: string | null;
  delivered: boolean;
};

// The command runs in the background of the wrapper. The trap is set after the fork, so the
// command keeps default signal handling while the wrapper survives `kill -- -<pgid>` (TERM,
// INT, HUP) and can still record how the command ended.
const WRAPPER = `
/bin/bash -lc "$ACMD_JOB_CMD" </dev/null >"$ACMD_JOB_DIR/output.log" 2>&1 &
child=$!
trap '' TERM INT HUP
wait "$child"
code=$?
echo "$code" > "$ACMD_JOB_DIR/exit.tmp" && mv "$ACMD_JOB_DIR/exit.tmp" "$ACMD_JOB_DIR/exit"
`;

export function currentBoot(): number {
  return Math.round((Date.now() / 1000 - os.uptime()) / 60);
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
  // Jobs still running or not yet delivered: the only ones a sweep needs to look at.
  private readonly active = new Set<number>();

  constructor(
    stateDir: string,
    private readonly env: () => NodeJS.ProcessEnv
  ) {
    this.dir = path.join(stateDir, "jobs");
    fs.mkdirSync(this.dir, { recursive: true });
    for (const job of this.list()) if (job.state === "running" || !job.delivered) this.active.add(job.id);
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

  // Newest first.
  list(): Job[] {
    return fs
      .readdirSync(this.dir)
      .filter((name) => /^\d+$/.test(name))
      .map((name) => this.get(Number(name)))
      .filter((job): job is Job => job !== null)
      .sort((a, b) => b.id - a.id);
  }

  running(): Job[] {
    return this.list().filter((j) => j.state === "running");
  }

  start(init: { chatId: string; conversationId: string; command: string; cwd: string }): Job {
    const ids = fs.readdirSync(this.dir).filter((n) => /^\d+$/.test(n)).map(Number);
    const id = ids.length > 0 ? Math.max(...ids) + 1 : 1;
    const dir = this.jobDir(id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "output.log"), "");
    const child = spawn("/bin/bash", ["-c", WRAPPER], {
      cwd: init.cwd,
      env: { ...this.env(), ACMD_JOB_CMD: init.command, ACMD_JOB_DIR: dir },
      detached: true,
      stdio: "ignore"
    });
    child.on("error", (error) => log.warn("job wrapper failed", { job: id, error: error.message }));
    child.unref();
    if (child.pid === undefined) throw new Error("could not start the job shell");
    const job: Job = {
      id,
      ...init,
      startedAt: new Date().toISOString(),
      pgid: child.pid,
      boot: currentBoot(),
      state: "running",
      exitCode: null,
      endedAt: null,
      delivered: false
    };
    this.save(job);
    this.active.add(id);
    log.debug("job started", { job: id, pgid: job.pgid });
    return job;
  }

  // Sends TERM to the job's process group; the wrapper records the exit and it is reported as usual.
  stop(id: number): boolean {
    const job = this.get(id);
    if (!job || job.state !== "running") return false;
    try {
      process.kill(-job.pgid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  // Updates jobs that ended since the last sweep. Returns every ended job not yet delivered.
  sweep(): Job[] {
    const boot = currentBoot();
    const ended: Job[] = [];
    for (const id of this.active) {
      const job = this.get(id);
      if (!job) {
        this.active.delete(id);
        continue;
      }
      if (job.state === "running") {
        const exitFile = path.join(this.jobDir(job.id), "exit");
        const readExit = () => (fs.existsSync(exitFile) ? Number.parseInt(fs.readFileSync(exitFile, "utf8"), 10) : null);
        let code = readExit();
        // Same boot (±1 min of uptime rounding) and wrapper alive: still running.
        if (code === null && Math.abs(job.boot - boot) <= 1 && alive(job.pgid)) continue;
        code ??= readExit(); // the wrapper may have finished between the two checks
        job.state = code === null || Number.isNaN(code) ? "lost" : "exited";
        job.exitCode = job.state === "exited" ? code : null;
        job.endedAt = new Date().toISOString();
        this.save(job);
        log.debug("job ended", { job: job.id, state: job.state, exit_code: job.exitCode });
      }
      if (!job.delivered) ended.push(job);
    }
    return ended.sort((a, b) => a.id - b.id);
  }

  markDelivered(id: number): void {
    const job = this.get(id);
    if (!job) return;
    job.delivered = true;
    this.save(job);
    this.active.delete(id);
  }

  // The last lines of a job's output, bounded in characters.
  tail(id: number, lines = 20, maxChars = 2000): string {
    const file = this.logPath(id);
    if (!fs.existsSync(file)) return "";
    const size = fs.statSync(file).size;
    const length = Math.min(size, 16_384);
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    fs.closeSync(fd);
    let text = buffer.toString("utf8");
    if (length < size) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
    text = text.replace(/\s+$/, "").split("\n").slice(-lines).join("\n");
    if (text.length > maxChars) text = `…${text.slice(-maxChars)}`;
    return text;
  }

  // Removes ended, delivered jobs older than maxAgeMs.
  prune(maxAgeMs: number): number {
    let removed = 0;
    for (const job of this.list()) {
      if (job.state === "running" || !job.delivered || !job.endedAt) continue;
      if (Date.now() - Date.parse(job.endedAt) < maxAgeMs) continue;
      fs.rmSync(this.jobDir(job.id), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }
}

// What the agent is told when a job ends.
export function jobNotice(jobs: Jobs, job: Job, currentConversationId: string | null): string {
  const ran = formatDuration(Date.parse(job.endedAt ?? new Date().toISOString()) - Date.parse(job.startedAt));
  const head =
    job.state === "exited"
      ? `[acmd] Background job ${job.id} finished: exit ${job.exitCode} after ${ran}.`
      : `[acmd] Background job ${job.id} ended without an exit status after about ${ran} (killed with SIGKILL, or the machine restarted).`;
  const lines = [head, `Command: ${job.command}`, `Cwd: ${job.cwd}`];
  if (currentConversationId !== null && job.conversationId !== currentConversationId) {
    lines.push("It was started in an earlier conversation.");
  }
  const tail = jobs.tail(job.id);
  lines.push(`Log: ${jobs.logPath(job.id)}${tail ? " (last lines below)" : " (empty)"}`);
  if (tail) lines.push("```", tail, "```");
  return lines.join("\n");
}
