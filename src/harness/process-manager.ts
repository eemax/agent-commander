import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createProcessSessionId } from "../id.js";
import type {
  CompletedExecOutput,
  LogOutput,
  ManagedSessionView,
  PollOutput,
  ProcessManagerHealth,
  ProcessStatus,
  TerminateSessionResult
} from "./types.js";

type StartCommandParams = {
  ownerId: string;
  command: string;
  cwd: string;
  shell: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
};

type Session = {
  sessionId: string;
  ownerId: string;
  command: string;
  cwd: string;
  shell: string;
  pid: number | null;
  child: ChildProcessWithoutNullStreams;
  status: ProcessStatus;
  startedAt: string;
  startedAtMs: number;
  finishedAt: string | null;
  finishedAtMs: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  combined: string;
  stdoutReadOffset: number;
  stderrReadOffset: number;
  combinedReadOffset: number;
  truncatedStdoutChars: number;
  truncatedStderrChars: number;
  truncatedCombinedChars: number;
  completion: Promise<void>;
  resolveCompletion: () => void;
  timeoutHandle: NodeJS.Timeout | null;
};

function tailByLines(content: string, lineCount: number): string {
  if (lineCount <= 0 || content.length === 0) {
    return "";
  }

  const lines = content.split(/\r?\n/);
  if (lines.length <= lineCount) {
    return content;
  }

  return lines.slice(-lineCount).join("\n");
}

function tailByChars(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return content.slice(content.length - maxChars);
}

function appendBounded(
  current: string,
  readOffset: number,
  data: string,
  maxChars: number
): { next: string; nextReadOffset: number; truncatedChars: number } {
  const combined = current + data;
  if (combined.length <= maxChars) {
    return {
      next: combined,
      nextReadOffset: readOffset,
      truncatedChars: 0
    };
  }

  const trim = combined.length - maxChars;
  return {
    next: combined.slice(trim),
    nextReadOffset: Math.max(0, readOffset - trim),
    truncatedChars: trim
  };
}

export class ProcessManager {
  private readonly sessions = new Map<string, Session>();
  private readonly completedSessionRetentionMs: number;
  private readonly maxCompletedSessions: number;
  private readonly maxOutputChars: number;

  public constructor(params: { completedSessionRetentionMs: number; maxCompletedSessions: number; maxOutputChars: number }) {
    this.completedSessionRetentionMs = params.completedSessionRetentionMs;
    this.maxCompletedSessions = params.maxCompletedSessions;
    this.maxOutputChars = params.maxOutputChars;
  }

  public async startCommand(params: StartCommandParams): Promise<ManagedSessionView> {
    this.pruneCompletedSessions();

    const sessionId = createProcessSessionId();
    const startedAtMs = Date.now();

    let completionResolved = false;
    let resolveCompletion = () => {
      completionResolved = true;
    };
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = () => {
        if (!completionResolved) {
          completionResolved = true;
          resolve();
        }
      };
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(params.shell, ["-lc", params.command], {
        cwd: params.cwd,
        env: params.env,
        stdio: "pipe",
        detached: true
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unknown spawn error: ${message}`);
    }

    const session: Session = {
      sessionId,
      ownerId: params.ownerId,
      command: params.command,
      cwd: params.cwd,
      shell: params.shell,
      pid: child.pid ?? null,
      child,
      status: "running",
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      finishedAt: null,
      finishedAtMs: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      combined: "",
      stdoutReadOffset: 0,
      stderrReadOffset: 0,
      combinedReadOffset: 0,
      truncatedStdoutChars: 0,
      truncatedStderrChars: 0,
      truncatedCombinedChars: 0,
      completion,
      resolveCompletion,
      timeoutHandle: null
    };

    this.sessions.set(sessionId, session);

    const appendOutput = (kind: "stdout" | "stderr", data: string): void => {
      if (data.length === 0) {
        return;
      }

      if (kind === "stdout") {
        const bounded = appendBounded(session.stdout, session.stdoutReadOffset, data, this.maxOutputChars);
        session.stdout = bounded.next;
        session.stdoutReadOffset = bounded.nextReadOffset;
        session.truncatedStdoutChars += bounded.truncatedChars;
      } else {
        const bounded = appendBounded(session.stderr, session.stderrReadOffset, data, this.maxOutputChars);
        session.stderr = bounded.next;
        session.stderrReadOffset = bounded.nextReadOffset;
        session.truncatedStderrChars += bounded.truncatedChars;
      }

      const boundedCombined = appendBounded(session.combined, session.combinedReadOffset, data, this.maxOutputChars);
      session.combined = boundedCombined.next;
      session.combinedReadOffset = boundedCombined.nextReadOffset;
      session.truncatedCombinedChars += boundedCombined.truncatedChars;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (data: string) => {
      appendOutput("stdout", data);
    });

    child.stderr.on("data", (data: string) => {
      appendOutput("stderr", data);
    });

    child.on("error", (error) => {
      appendOutput("stderr", `process error: ${error.message}\n`);
    });

    child.once("close", (code, signal) => {
      session.status = "completed";
      session.exitCode = code;
      session.signal = (signal ?? null) as NodeJS.Signals | null;
      session.finishedAtMs = Date.now();
      session.finishedAt = new Date(session.finishedAtMs).toISOString();

      if (session.timeoutHandle) {
        clearTimeout(session.timeoutHandle);
        session.timeoutHandle = null;
      }

      session.resolveCompletion();
      this.pruneCompletedSessions();
    });

    if (params.timeoutMs > 0) {
      session.timeoutHandle = setTimeout(() => {
        if (session.status !== "running") {
          return;
        }
        session.timedOut = true;
        appendOutput("stderr", `process timeout after ${params.timeoutMs}ms\n`);
        this.sendSignal(session, "SIGKILL");
      }, params.timeoutMs);
    }

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", (error) => reject(error));
      });
    } catch (error) {
      this.sessions.delete(sessionId);
      if (session.timeoutHandle) {
        clearTimeout(session.timeoutHandle);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unknown spawn error: ${message}`);
    }

    return this.toView(session);
  }

  public async waitForCompletion(sessionId: string, maxWaitMs: number): Promise<boolean> {
    const session = this.getSession(sessionId);

    if (session.status === "completed") {
      return true;
    }

    return Promise.race([session.completion.then(() => true), sleep(maxWaitMs).then(() => false)]);
  }

  public getExecCompletedOutput(sessionId: string, ownerId?: string): CompletedExecOutput {
    const session = this.getSession(sessionId);
    this.assertOwner(session, ownerId);

    if (session.status !== "completed") {
      throw new Error(`Session is still running: ${sessionId}`);
    }
    if (session.timedOut) {
      throw new Error(`Process timeout: ${sessionId}`);
    }

    const finishedAtMs = session.finishedAtMs ?? Date.now();

    return {
      status: "completed",
      sessionId,
      exitCode: session.exitCode,
      stdout: session.stdout,
      stderr: session.stderr,
      combined: session.combined,
      durationMs: finishedAtMs - session.startedAtMs,
      truncatedStdoutChars: session.truncatedStdoutChars,
      truncatedStderrChars: session.truncatedStderrChars,
      truncatedCombinedChars: session.truncatedCombinedChars
    };
  }

  public getRunningTail(
    sessionId: string,
    ownerId?: string
  ): { sessionId: string; pid: number | null; tail: string; truncatedCombinedChars: number } {
    const session = this.getSession(sessionId);
    this.assertOwner(session, ownerId);

    return {
      sessionId,
      pid: session.pid,
      tail: tailByChars(session.combined, 8000),
      truncatedCombinedChars: session.truncatedCombinedChars
    };
  }

  public listSessions(): ManagedSessionView[] {
    this.pruneCompletedSessions();

    return Array.from(this.sessions.values())
      .sort((left, right) => left.startedAtMs - right.startedAtMs)
      .map((session) => this.toView(session));
  }

  public listSessionsByOwner(ownerId: string): ManagedSessionView[] {
    return this.listSessions().filter((session) => session.ownerId === ownerId);
  }

  public pollSession(sessionId: string, ownerId?: string): PollOutput {
    this.pruneCompletedSessions();

    const session = this.getSession(sessionId);
    this.assertOwner(session, ownerId);

    const output: PollOutput = {
      status: session.status,
      sessionId,
      stdout: session.stdout.slice(session.stdoutReadOffset),
      stderr: session.stderr.slice(session.stderrReadOffset),
      combined: session.combined.slice(session.combinedReadOffset),
      exitCode: session.exitCode,
      signal: session.signal,
      truncatedStdoutChars: session.truncatedStdoutChars,
      truncatedStderrChars: session.truncatedStderrChars,
      truncatedCombinedChars: session.truncatedCombinedChars
    };

    session.stdoutReadOffset = session.stdout.length;
    session.stderrReadOffset = session.stderr.length;
    session.combinedReadOffset = session.combined.length;

    return output;
  }

  public logSession(sessionId: string, tailLines: number, ownerId?: string): LogOutput {
    this.pruneCompletedSessions();

    const session = this.getSession(sessionId);
    this.assertOwner(session, ownerId);

    return {
      status: session.status,
      sessionId,
      combined: tailByLines(session.combined, tailLines),
      exitCode: session.exitCode,
      signal: session.signal,
      truncatedCombinedChars: session.truncatedCombinedChars
    };
  }

  public writeToSession(sessionId: string, input: string, ownerId?: string): { ok: true; sessionId: string } {
    const session = this.getSession(sessionId);
    this.assertOwner(session, ownerId);

    if (session.status !== "running") {
      throw new Error(`Cannot write to non-running session: ${sessionId}`);
    }

    session.child.stdin.write(input);
    return { ok: true, sessionId };
  }

  public killSession(
    sessionId: string,
    signal: NodeJS.Signals = "SIGTERM",
    ownerId?: string
  ): { ok: true; sessionId: string; signal: NodeJS.Signals; status: ProcessStatus } {
    const session = this.getSession(sessionId);
    this.assertOwner(session, ownerId);

    if (session.status === "running") {
      this.sendSignal(session, signal);
      return {
        ok: true,
        sessionId,
        signal,
        status: "running"
      };
    }

    return {
      ok: true,
      sessionId,
      signal,
      status: "completed"
    };
  }

  public async terminateSession(
    sessionId: string,
    options: {
      graceMs: number;
      forceSignal?: NodeJS.Signals;
      removeAfterTerminate?: boolean;
    },
    ownerId?: string
  ): Promise<TerminateSessionResult> {
    const session = this.getSession(sessionId);
    this.assertOwner(session, ownerId);

    if (session.status === "completed") {
      let removed = false;
      if (options.removeAfterTerminate === true) {
        this.sessions.delete(sessionId);
        removed = true;
      }

      return {
        ok: true,
        sessionId,
        status: "completed",
        alreadyCompleted: true,
        forced: false,
        signalSent: null,
        removed
      };
    }

    this.sendSignal(session, "SIGTERM");
    const gracefulDone = await this.waitForCompletion(sessionId, Math.max(1, options.graceMs));

    let forced = false;
    let signalSent: NodeJS.Signals = "SIGTERM";
    if (!gracefulDone && session.status === "running") {
      if (options.forceSignal) {
        forced = true;
        this.sendSignal(session, options.forceSignal);
        signalSent = options.forceSignal;
        await this.waitForCompletion(sessionId, Math.max(1, options.graceMs));
      }
    }

    let removed = false;
    if (options.removeAfterTerminate === true && this.getSession(sessionId).status === "completed") {
      this.sessions.delete(sessionId);
      removed = true;
    }

    return {
      ok: true,
      sessionId,
      status: session.status,
      alreadyCompleted: false,
      forced,
      signalSent,
      removed
    };
  }

  public killRunningSessionsByOwner(ownerId: string): { killed: number; sessionIds: string[] } {
    const runningSessions = Array.from(this.sessions.values()).filter(
      (session) => session.ownerId === ownerId && session.status === "running"
    );

    for (const session of runningSessions) {
      this.sendSignal(session, "SIGTERM");
    }

    return {
      killed: runningSessions.length,
      sessionIds: runningSessions.map((session) => session.sessionId)
    };
  }

  public async terminateAllRunningSessions(options: {
    graceMs: number;
    forceSignal?: NodeJS.Signals;
    removeAfterTerminate?: boolean;
  }): Promise<{ terminated: number; forced: number; sessionIds: string[] }> {
    const runningSessions = Array.from(this.sessions.values()).filter((session) => session.status === "running");
    const results = await Promise.all(
      runningSessions.map((session) =>
        this.terminateSession(
          session.sessionId,
          {
            graceMs: options.graceMs,
            forceSignal: options.forceSignal,
            removeAfterTerminate: options.removeAfterTerminate
          }
        )
      )
    );

    return {
      terminated: results.length,
      forced: results.filter((result) => result.forced).length,
      sessionIds: results.map((result) => result.sessionId)
    };
  }

  public clearPending(sessionId: string, ownerId?: string): { ok: true; sessionId: string } {
    const session = this.getSession(sessionId);
    this.assertOwner(session, ownerId);

    session.stdoutReadOffset = session.stdout.length;
    session.stderrReadOffset = session.stderr.length;
    session.combinedReadOffset = session.combined.length;

    return { ok: true, sessionId };
  }

  public removeSession(sessionId: string, ownerId?: string): { ok: true; sessionId: string } {
    const session = this.getSession(sessionId);
    this.assertOwner(session, ownerId);

    if (session.status === "running") {
      throw new Error(`Cannot remove running session: ${sessionId}`);
    }

    this.sessions.delete(sessionId);
    return { ok: true, sessionId };
  }

  public getHealth(): ProcessManagerHealth {
    this.pruneCompletedSessions();
    let running = 0;
    let completed = 0;
    let truncStdout = 0;
    let truncStderr = 0;
    let truncCombined = 0;
    for (const session of this.sessions.values()) {
      if (session.status === "running") running++;
      else if (session.status === "completed") completed++;
      truncStdout += session.truncatedStdoutChars;
      truncStderr += session.truncatedStderrChars;
      truncCombined += session.truncatedCombinedChars;
    }
    return {
      totalSessions: this.sessions.size,
      runningSessions: running,
      completedSessions: completed,
      truncatedStdoutChars: truncStdout,
      truncatedStderrChars: truncStderr,
      truncatedCombinedChars: truncCombined
    };
  }

  private getSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown sessionId: ${sessionId}`);
    }
    return session;
  }

  private assertOwner(session: Session, ownerId?: string): void {
    if (!ownerId) {
      return;
    }

    if (session.ownerId !== ownerId) {
      throw new Error(`Unauthorized session access: ${session.sessionId}`);
    }
  }

  private toView(session: Session): ManagedSessionView {
    return {
      sessionId: session.sessionId,
      ownerId: session.ownerId,
      pid: session.pid,
      command: session.command,
      cwd: session.cwd,
      shell: session.shell,
      status: session.status,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      exitCode: session.exitCode,
      signal: session.signal,
      timedOut: session.timedOut,
      truncatedStdoutChars: session.truncatedStdoutChars,
      truncatedStderrChars: session.truncatedStderrChars,
      truncatedCombinedChars: session.truncatedCombinedChars
    };
  }

  private sendSignal(session: Session, signal: NodeJS.Signals): void {
    if (session.status !== "running") {
      return;
    }

    const pid = session.pid ?? session.child.pid ?? null;
    const canSignalProcessGroup = process.platform !== "win32" && typeof pid === "number" && pid > 0;

    if (canSignalProcessGroup) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Fallback to direct child signal when group signaling is unavailable.
      }
    }

    try {
      session.child.kill(signal);
    } catch {
      // Ignore signaling errors. Session close handlers reconcile final state.
    }
  }

  private pruneCompletedSessions(): void {
    const now = Date.now();
    const remaining: Session[] = [];

    for (const session of this.sessions.values()) {
      if (session.status !== "completed") {
        continue;
      }
      if (session.finishedAtMs !== null && now - session.finishedAtMs > this.completedSessionRetentionMs) {
        this.sessions.delete(session.sessionId);
      } else {
        remaining.push(session);
      }
    }

    const overflow = remaining.length - this.maxCompletedSessions;
    if (overflow > 0) {
      remaining.sort((left, right) => {
        const leftFinished = left.finishedAtMs ?? Number.MAX_SAFE_INTEGER;
        const rightFinished = right.finishedAtMs ?? Number.MAX_SAFE_INTEGER;
        return leftFinished - rightFinished;
      });
      for (let index = 0; index < overflow; index += 1) {
        this.sessions.delete(remaining[index].sessionId);
      }
    }
  }
}
