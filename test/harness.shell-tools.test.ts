import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createToolHarness } from "../src/harness/index.js";

function mkdtemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createHarness(root: string) {
  return createToolHarness({
    defaultCwd: root,
    defaultShell: "/bin/bash",
    execTimeoutMs: 30_000,
    execYieldMs: 1_000,
    processLogTailLines: 200,
    logPath: ".agent-commander/tool-calls.jsonl",
    completedSessionRetentionMs: 3_600_000,
    maxCompletedSessions: 500,
    maxOutputChars: 200_000
  });
}

async function waitForProcessOutput(
  harness: ReturnType<typeof createHarness>,
  ownerId: string,
  sessionId: string,
  expectedText: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const poll = await harness.executeWithOwner(ownerId, "process", {
      action: "poll",
      sessionId
    });

    if ((poll as { combined: string }).combined.includes(expectedText)) {
      return;
    }

    await sleep(25);
  }

  throw new Error(`Timed out waiting for process output containing: ${expectedText}`);
}

async function waitForSessionCompleted(
  harness: ReturnType<typeof createHarness>,
  ownerId: string,
  sessionId: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const poll = await harness.executeWithOwner(ownerId, "process", {
      action: "poll",
      sessionId
    });
    if ((poll as { status: string }).status === "completed") {
      return;
    }
    await sleep(25);
  }

  throw new Error(`Timed out waiting for process completion: ${sessionId}`);
}

describe("shell tools", () => {
  it("returns completed output for short commands", async () => {
    const root = mkdtemp("acmd-shell-complete-");
    const harness = createHarness(root);

    const output = await harness.executeWithOwner("chat-1", "bash", { command: "pwd" });
    expect(output).toEqual(
      expect.objectContaining({
        status: "completed",
        exitCode: 0
      })
    );

    const completed = output as { stdout: string };
    expect(fs.realpathSync(completed.stdout.trim())).toBe(fs.realpathSync(root));
  });

  it("uses configured default shell instead of process.env.SHELL", async () => {
    const root = mkdtemp("acmd-shell-default-");
    const harness = createHarness(root);
    const previousShell = process.env.SHELL;
    process.env.SHELL = "/bin/zsh";

    try {
      const output = await harness.executeWithOwner("chat-1", "bash", {
        command: "printf '%s' \"${BASH_VERSION:+bash}${ZSH_VERSION:+zsh}\""
      });

      expect(output).toEqual(
        expect.objectContaining({
          status: "completed"
        })
      );
      expect((output as { stdout: string }).stdout.trim()).toBe("bash");
    } finally {
      if (previousShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = previousShell;
      }
    }
  });

  it("returns running sessions and supports poll/write/kill/remove", async () => {
    const root = mkdtemp("acmd-shell-running-");
    const harness = createHarness(root);

    const running = await harness.executeWithOwner("chat-1", "bash", {
      command: "cat",
      background: true
    });

    expect(running).toEqual(
      expect.objectContaining({
        status: "running"
      })
    );

    const sessionId = (running as { sessionId: string }).sessionId;

    await expect(
      harness.executeWithOwner("chat-1", "process", {
        action: "write",
        sessionId,
        input: "hello\n"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        sessionId
      })
    );

    await waitForProcessOutput(harness, "chat-1", sessionId, "hello");

    await expect(
      harness.executeWithOwner("chat-1", "process", {
        action: "kill",
        sessionId,
        signal: "SIGTERM"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        sessionId
      })
    );

    await waitForSessionCompleted(harness, "chat-1", sessionId);

    await expect(
      harness.executeWithOwner("chat-1", "process", {
        action: "remove",
        sessionId
      })
    ).resolves.toEqual({ ok: true, sessionId });
  });

  it("isolates sessions by owner", async () => {
    const root = mkdtemp("acmd-shell-owner-");
    const harness = createHarness(root);

    const running = await harness.executeWithOwner("chat-1", "bash", {
      command: "sleep 0.2",
      background: true
    });

    const sessionId = (running as { sessionId: string }).sessionId;

    await expect(
      harness.executeWithOwner("chat-2", "process", {
        action: "poll",
        sessionId
      })
    ).rejects.toThrow("Unauthorized session access");
  });

  it("ignores irrelevant process fields for the selected action", async () => {
    const root = mkdtemp("acmd-shell-process-coerce-");
    const harness = createHarness(root);

    const running = await harness.executeWithOwner("chat-1", "bash", {
      command: "printf 'ok\\n'",
      background: true
    });

    const sessionId = (running as { sessionId: string }).sessionId;

    await expect(
      harness.executeWithOwner("chat-1", "process", {
        action: "poll",
        sessionId,
        tailLines: 50,
        input: "",
        signal: "SIGTERM"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        sessionId
      })
    );
  });

  it("normalizes snake_case aliases and coerces numeric strings", async () => {
    const root = mkdtemp("acmd-shell-process-alias-");
    const harness = createHarness(root);

    const running = await harness.executeWithOwner("chat-1", "bash", {
      command: "printf 'ok\\n'",
      background: true
    });
    const sessionId = (running as { sessionId: string }).sessionId;

    await waitForSessionCompleted(harness, "chat-1", sessionId);

    await expect(
      harness.executeWithOwner("chat-1", "process", {
        action: "log",
        session_id: sessionId,
        tail_lines: "50"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        sessionId,
        status: "completed"
      })
    );
  });

  it("shutdown force-kills stubborn background sessions", async () => {
    const root = mkdtemp("acmd-shell-shutdown-");
    const harness = createHarness(root);

    const running = await harness.executeWithOwner("chat-1", "bash", {
      command: "trap '' TERM; while true; do sleep 5; done",
      background: true
    });
    const sessionId = (running as { sessionId: string }).sessionId;

    await sleep(150);
    await harness.shutdown();

    await expect(harness.context.processManager.waitForCompletion(sessionId, 250)).resolves.toBe(true);
    expect(harness.context.processManager.getHealth().runningSessions).toBe(0);
  });

  it("resolves default cwd per owner when a resolver is configured", async () => {
    const root = mkdtemp("acmd-shell-owner-cwd-root-");
    const ownerOneCwd = mkdtemp("acmd-shell-owner-cwd-1-");
    const ownerTwoCwd = mkdtemp("acmd-shell-owner-cwd-2-");
    const harness = createToolHarness(
      {
        defaultCwd: root,
        defaultShell: "/bin/bash",
        execTimeoutMs: 30_000,
        execYieldMs: 1_000,
        processLogTailLines: 200,
        logPath: ".agent-commander/tool-calls.jsonl",
        completedSessionRetentionMs: 3_600_000,
        maxCompletedSessions: 500,
        maxOutputChars: 200_000
      },
      {
        resolveDefaultCwd: async (ownerId) => {
          if (ownerId === "chat-1") {
            return ownerOneCwd;
          }
          if (ownerId === "chat-2") {
            return ownerTwoCwd;
          }
          return root;
        }
      }
    );

    const one = await harness.executeWithOwner("chat-1", "bash", { command: "pwd" });
    const two = await harness.executeWithOwner("chat-2", "bash", { command: "pwd" });

    expect(fs.realpathSync((one as { stdout: string }).stdout.trim())).toBe(fs.realpathSync(ownerOneCwd));
    expect(fs.realpathSync((two as { stdout: string }).stdout.trim())).toBe(fs.realpathSync(ownerTwoCwd));
  });
});
