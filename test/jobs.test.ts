import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notificationNotice, readInbox, writeNotification } from "../src/inbox.js";
import { type Job, Jobs, formatDuration, jobNotice } from "../src/jobs.js";
import { toolEnv } from "../src/tools/bash.js";

let stateDir: string;
let jobs: Jobs;
const started: Job[] = [];

function start(command: string): Job {
  const { job } = jobs.start({ chatId: "1", conversationId: "conv_a", command, cwd: os.tmpdir() });
  started.push(job);
  return job;
}

// Waits until the command itself is running (it prints "up" first).
async function running(job: Job, within = 10_000): Promise<void> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    if (jobs.tail(job.id).startsWith("up")) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`job ${job.id} did not start running`);
}

async function ended(id: number, within = 10_000): Promise<Job> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    const job = jobs.sweep().find((j) => j.id === id);
    if (job) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${id} did not end within ${within} ms`);
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "acmd-jobs-"));
  jobs = new Jobs(stateDir, toolEnv);
});

afterEach(() => {
  for (const job of started.splice(0)) {
    try {
      process.kill(-job.pgid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

describe("Jobs", () => {
  it("runs a command in the background and records its exit code and output", async () => {
    const t0 = Date.now();
    const job = start("echo hello; echo oops >&2; exit 3");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(job.id).toBe(1);
    expect(job.state).toBe("running");
    const done = await ended(job.id);
    expect(done).toMatchObject({ state: "exited", exitCode: 3, delivered: false });
    expect(jobs.tail(job.id)).toBe("hello\noops");
  });

  it("numbers jobs and keeps reporting until delivered", async () => {
    const a = start("true");
    const b = start("true");
    expect(b.id).toBe(a.id + 1);
    await ended(b.id);
    await ended(a.id);
    expect(jobs.sweep().map((j) => j.id)).toEqual([a.id, b.id]);
    jobs.markDelivered(a.id);
    jobs.markDelivered(b.id);
    expect(jobs.sweep()).toEqual([]);
  });

  it("reports a job killed through its process group with the signal's exit code", async () => {
    const job = start("echo up; sleep 30");
    await running(job);
    expect(jobs.sweep()).toEqual([]); // still running
    process.kill(-job.pgid, "SIGTERM"); // what the agent runs: kill -- -<pgid>
    expect(await ended(job.id)).toMatchObject({ state: "exited", exitCode: 143 });
  });

  it("reports the exit when killed as soon as the command runs", async () => {
    for (let i = 0; i < 5; i++) {
      const job = start("echo up; sleep 30");
      await running(job);
      process.kill(-job.pgid, "SIGTERM");
      expect(await ended(job.id)).toMatchObject({ state: "exited", exitCode: 143 });
      jobs.markDelivered(job.id);
    }
  });

  it("leaves the command's signals at their defaults", async () => {
    // bash's view, and a program's own view (bash hides signals ignored when it started).
    const job = start(
      "trap -p TERM INT HUP QUIT; python3 -c 'import signal as s; print(*(s.getsignal(x).name if hasattr(s.getsignal(x), \"name\") else \"handler\" for x in (s.SIGTERM, s.SIGINT, s.SIGHUP, s.SIGQUIT)))'"
    );
    await ended(job.id);
    expect(jobs.tail(job.id)).toBe("SIG_DFL handler SIG_DFL SIG_DFL"); // python installs its own SIGINT handler unless SIGINT is ignored
  });

  it("kills a job that ignores TERM after the grace period, and says so", async () => {
    const job = start("trap '' TERM; echo up; sleep 30");
    await running(job);
    expect(jobs.terminate(job.id, "stopped for a test", 300)).toBe(true);
    const done = await ended(job.id);
    expect(done).toMatchObject({ state: "lost", note: "stopped for a test; killed after it ignored SIGTERM" });
    expect(jobNotice(jobs, done, "conv_a")).toContain("Note: stopped for a test; killed after it ignored SIGTERM.");
  });

  it("runs commands far beyond the 128 KB environment limit, without leaking job variables", async () => {
    const big = "x".repeat(300_000);
    const job = start(`cat > big.txt <<'EOF'\n${big}\nEOF\nwc -c < big.txt | tr -d ' '; env | grep -c '^ACMD_' || true; rm big.txt`);
    const done = await ended(job.id);
    expect(done).toMatchObject({ state: "exited", exitCode: 0 });
    expect(jobs.tail(job.id)).toBe("300001\n0");
    expect(jobNotice(jobs, done, "conv_a")).toContain("… (300");
  });

  it("reports syntax errors with the command's own line numbers", async () => {
    const job = start("echo first\nif then");
    await ended(job.id);
    expect(jobs.tail(job.id)).toMatch(/line 2: syntax error/);
  });

  it("refuses a missing cwd cleanly", () => {
    const before = fs.readdirSync(jobs.dir).length;
    expect(() => jobs.start({ chatId: "1", conversationId: "c", command: "true", cwd: "/nonexistent/acmd" })).toThrow(/could not start a shell/);
    expect(fs.readdirSync(jobs.dir).length).toBe(before); // no half-made job directory left behind
  });

  it("stop() ends a running job the same way", async () => {
    const job = start("echo up; sleep 30");
    await running(job);
    expect(jobs.stop(job.id)).toBe(true);
    expect(await ended(job.id)).toMatchObject({ state: "exited", exitCode: 143 });
    expect(jobs.stop(job.id)).toBe(false);
  });

  it("marks a job lost when the whole group is SIGKILLed", async () => {
    const job = start("echo up; sleep 30");
    await running(job);
    process.kill(-job.pgid, "SIGKILL");
    expect(await ended(job.id)).toMatchObject({ state: "lost", exitCode: null });
  });

  it("dates the end from the exit itself, not from when a sweep noticed it", async () => {
    const job = start("sleep 0.2");
    await new Promise((r) => setTimeout(r, 1500)); // nobody sweeps meanwhile
    const done = await ended(job.id);
    const ran = Date.parse(done.endedAt!) - Date.parse(done.startedAt);
    expect(ran).toBeLessThan(1200);
  });

  it("picks up jobs started by an earlier acmd process", async () => {
    const job = start("sleep 0.5; echo done");
    const restarted = new Jobs(stateDir, toolEnv);
    const deadline = Date.now() + 10_000;
    let found: Job | undefined;
    while (!found && Date.now() < deadline) {
      found = restarted.sweep().find((j) => j.id === job.id);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(found).toMatchObject({ state: "exited", exitCode: 0 });
  });

  it("treats a job from an earlier boot as lost even if its pid is reused", async () => {
    const job = start("sleep 30");
    const file = path.join(jobs.dir, String(job.id), "job.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Job;
    const earlier = saved.bootId === undefined ? {} : { bootId: "an-earlier-boot" }; // Linux: exact boot id
    fs.writeFileSync(file, JSON.stringify({ ...saved, boot: saved.boot - 600, ...earlier }));
    expect(await ended(job.id)).toMatchObject({ state: "lost" });
  });

  it("never reuses an id, even after pruning", async () => {
    const a = start("true");
    await ended(a.id);
    jobs.markDelivered(a.id);
    jobs.prune(0);
    const restarted = new Jobs(stateDir, toolEnv);
    expect(restarted.start({ chatId: "1", conversationId: "c", command: "true", cwd: os.tmpdir() }).job.id).toBe(a.id + 1);
  });

  it("stops a background job whose log passes the cap and says why", async () => {
    const capped = new Jobs(stateDir, toolEnv, 2_000_000);
    const { job } = capped.start({ chatId: "1", conversationId: "c", command: "yes acmd", cwd: os.tmpdir() });
    started.push(job);
    const deadline = Date.now() + 10_000;
    let done: Job | undefined;
    while (!done && Date.now() < deadline) {
      done = capped.sweep().find((j) => j.id === job.id);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(done).toMatchObject({ state: "exited", exitCode: 143 });
    expect(jobNotice(capped, done!, "c")).toContain("Note: stopped by acmd: its output passed 2 MB.");
  });

  it("adopts a foreground job whose call died with an earlier acmd process", async () => {
    const { job } = jobs.start({ chatId: "1", conversationId: "c", command: "sleep 0.3", cwd: os.tmpdir(), foreground: true });
    started.push(job);
    expect(jobs.sweep()).toEqual([]); // the live call owns it
    const restarted = new Jobs(stateDir, toolEnv);
    const deadline = Date.now() + 10_000;
    let done: Job | undefined;
    while (!done && Date.now() < deadline) {
      done = restarted.sweep().find((j) => j.id === job.id);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(done).toMatchObject({ state: "exited", exitCode: 0 });
  });

  it("prunes ended, delivered jobs past retention only", async () => {
    const old = start("true");
    const fresh = start("true");
    await ended(old.id);
    await ended(fresh.id);
    jobs.markDelivered(old.id);
    expect(jobs.prune(0)).toBe(1);
    expect(jobs.get(old.id)).toBeNull();
    expect(jobs.get(fresh.id)).not.toBeNull(); // not delivered yet
  });

  it("keeps only the end of a long log", async () => {
    const job = start("seq 1 50000");
    await ended(job.id);
    const tail = jobs.tail(job.id, 3);
    expect(tail).toBe("49998\n49999\n50000");
  });

  it("writes a notice the agent can act on", async () => {
    const job = start("echo built");
    const done = await ended(job.id);
    const notice = jobNotice(jobs, done, "conv_b");
    expect(notice).toMatch(/^\[acmd\] Background job \d+ finished: exit 0 after \d+s\./);
    expect(jobNotice(jobs, { ...done, promoted: true }, "conv_a")).toContain("moved to the background when its call timed out");
    expect(notice).toContain("Command: echo built");
    expect(notice).toContain("earlier conversation");
    expect(notice).toContain("```\nbuilt\n```");
    expect(jobNotice(jobs, done, "conv_a")).not.toContain("earlier conversation");
  });
});

describe("inbox", () => {
  it("round-trips notifications in order and drops malformed ones", () => {
    writeNotification(stateDir, { chatId: "1", text: "first", source: "test" });
    writeNotification(stateDir, { chatId: "1", text: "second", source: "timer" });
    fs.writeFileSync(path.join(stateDir, "inbox", "zzz.json"), "{not json");
    const pending = readInbox(stateDir);
    expect(pending.map((p) => p.notification.text)).toEqual(["first", "second"]);
    expect(fs.existsSync(path.join(stateDir, "inbox", "zzz.json"))).toBe(false);
    expect(notificationNotice(pending[1]!.notification)).toBe("[acmd] Notification (timer):\nsecond");
  });
});

describe("formatDuration", () => {
  it("is compact", () => {
    expect(formatDuration(4_000)).toBe("4s");
    expect(formatDuration(725_000)).toBe("12m 5s");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
  });
});
