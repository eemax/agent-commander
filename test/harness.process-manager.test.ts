import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ProcessManager } from "../src/harness/process-manager.js";

async function startQuickCommand(
  manager: ProcessManager,
  ownerId: string,
  command: string,
  timeoutMs = 5_000
): Promise<string> {
  const session = await manager.startCommand({
    ownerId,
    command,
    cwd: process.cwd(),
    shell: "/bin/bash",
    env: { ...process.env },
    timeoutMs
  });

  return session.sessionId;
}

async function waitForCombinedOutput(
  manager: ProcessManager,
  ownerId: string,
  sessionId: string,
  expectedText: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const poll = manager.pollSession(sessionId, ownerId);
    if (poll.combined.includes(expectedText)) {
      return;
    }
    await sleep(25);
  }

  throw new Error(`Timed out waiting for process output containing: ${expectedText}`);
}

describe("process manager", () => {
  it("captures completed output", async () => {
    const manager = new ProcessManager({
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000
    });

    const sessionId = await startQuickCommand(manager, "chat-1", "printf 'hello'");
    await expect(manager.waitForCompletion(sessionId, 2_000)).resolves.toBe(true);

    const output = manager.getExecCompletedOutput(sessionId, "chat-1");
    expect(output.status).toBe("completed");
    expect(output.stdout).toBe("hello");
    expect(output.combined).toBe("hello");
  });

  it("poll returns only unread output", async () => {
    const manager = new ProcessManager({
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000
    });

    const sessionId = await startQuickCommand(manager, "chat-1", "echo first; sleep 0.25");
    await waitForCombinedOutput(manager, "chat-1", sessionId, "first");

    const secondPoll = manager.pollSession(sessionId, "chat-1");
    expect(secondPoll.stdout).toBe("");
    expect(secondPoll.stderr).toBe("");
    expect(secondPoll.combined).toBe("");
  });

  it("supports stdin writes", async () => {
    const manager = new ProcessManager({
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000
    });

    const sessionId = await startQuickCommand(manager, "chat-1", "read line; echo got:$line");
    manager.writeToSession(sessionId, "abc\n", "chat-1");

    await expect(manager.waitForCompletion(sessionId, 2_000)).resolves.toBe(true);
    const output = manager.getExecCompletedOutput(sessionId, "chat-1");
    expect(output.combined).toContain("got:abc");
  });

  it("clearPending resets unread offsets without losing accumulated output", async () => {
    const manager = new ProcessManager({
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000
    });

    const sessionId = await startQuickCommand(
      manager,
      "chat-1",
      "echo one; sleep 0.2; echo two"
    );

    await waitForCombinedOutput(manager, "chat-1", sessionId, "one");
    manager.clearPending(sessionId, "chat-1");

    const immediate = manager.pollSession(sessionId, "chat-1");
    expect(immediate.combined).not.toContain("one");

    await waitForCombinedOutput(manager, "chat-1", sessionId, "two");
    await expect(manager.waitForCompletion(sessionId, 2_000)).resolves.toBe(true);
    const completed = manager.getExecCompletedOutput(sessionId, "chat-1");
    expect(completed.combined).toContain("one");
    expect(completed.combined).toContain("two");
  });

  it("supports kill by owner", async () => {
    const manager = new ProcessManager({
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000
    });

    const sessionId = await startQuickCommand(manager, "chat-1", "sleep 5");
    const result = manager.killRunningSessionsByOwner("chat-1");
    expect(result.sessionIds).toContain(sessionId);

    await expect(manager.waitForCompletion(sessionId, 2_000)).resolves.toBe(true);
  });

  it("terminateSession is idempotent for completed sessions", async () => {
    const manager = new ProcessManager({
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000
    });

    const sessionId = await startQuickCommand(manager, "chat-1", "echo done");
    await expect(manager.waitForCompletion(sessionId, 2_000)).resolves.toBe(true);

    await expect(
      manager.terminateSession(
        sessionId,
        {
          graceMs: 50,
          removeAfterTerminate: true
        },
        "chat-1"
      )
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        sessionId,
        status: "completed",
        alreadyCompleted: true,
        forced: false,
        removed: true
      })
    );
  });

  it("terminateSession reports graceful/forced shutdown outcome", async () => {
    const manager = new ProcessManager({
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000
    });

    const sessionId = await startQuickCommand(
      manager,
      "chat-1",
      "trap '' TERM; while true; do sleep 5; done"
    );
    await sleep(150);

    const terminated = await manager.terminateSession(
      sessionId,
      {
        graceMs: 50,
        forceSignal: "SIGKILL"
      },
      "chat-1"
    );
    expect(typeof terminated.forced).toBe("boolean");
    expect(terminated.signalSent === "SIGTERM" || terminated.signalSent === "SIGKILL").toBe(true);

    await expect(manager.waitForCompletion(sessionId, 2_000)).resolves.toBe(true);
  });

  it("enforces ownership checks", async () => {
    const manager = new ProcessManager({
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000
    });

    const sessionId = await startQuickCommand(manager, "chat-1", "sleep 0.1");
    expect(() => manager.pollSession(sessionId, "chat-2")).toThrow("Unauthorized session access");
  });

  it("bounds output buffers and tracks truncation metrics", async () => {
    const manager = new ProcessManager({
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 100
    });

    const sessionId = await startQuickCommand(manager, "chat-1", "head -c 500 /dev/zero | tr '\\0' 'x'");
    await expect(manager.waitForCompletion(sessionId, 2_000)).resolves.toBe(true);

    const completed = manager.getExecCompletedOutput(sessionId, "chat-1");
    expect(completed.combined.length).toBeLessThanOrEqual(100);
    expect(completed.truncatedCombinedChars).toBeGreaterThan(0);

    const health = manager.getHealth();
    expect(health.truncatedCombinedChars).toBeGreaterThan(0);
  });
});
