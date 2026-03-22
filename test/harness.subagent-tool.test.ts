import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createToolHarness } from "../src/harness/index.js";
import type { ToolHarness } from "../src/harness/index.js";
import { createTempDir } from "./helpers.js";

function createHarness(root: string): ToolHarness {
  return createToolHarness({
    defaultCwd: root,
    defaultShell: "/bin/bash",
    execTimeoutMs: 30_000,
    execYieldMs: 5_000,
    processLogTailLines: 200,
    logPath: `${root}/tool-calls.jsonl`,
    completedSessionRetentionMs: 3_600_000,
    maxCompletedSessions: 500,
    maxOutputChars: 200_000,
    subagents: {
      enabled: true,
      defaultModel: "gpt-4.1-mini",
      maxConcurrentTasks: 5,
      defaultTimeBudgetSec: 60,
      defaultMaxTurns: 10,
      defaultMaxTotalTokens: 50_000,
      defaultHeartbeatIntervalSec: 30,
      defaultIdleTimeoutSec: 120,
      defaultStallTimeoutSec: 300,
      defaultRequirePlanByTurn: 3,
      recvMaxEvents: 50,
      recvDefaultWaitMs: 100,
      awaitMaxTimeoutMs: 5_000
    }
  });
}

describe("subagents tool (integration)", () => {
  let harness: ToolHarness;
  let root: string;

  beforeEach(() => {
    vi.useFakeTimers();
    root = createTempDir("subagent-tool-");
    harness = createHarness(root);
  });

  afterEach(() => {
    harness.context.subagentManager?.shutdown();
    vi.useRealTimers();
  });

  it("is registered in the tool harness", () => {
    const tools = harness.exportProviderTools();
    expect(tools.some((t) => t.name === "subagents")).toBe(true);
  });

  it("spawn creates a task and returns response", async () => {
    const result = await harness.executeWithOwner("owner-1", "subagents", {
      action: "spawn",
      task: {
        title: "Test task",
        goal: "Do the thing",
        instructions: "Follow the spec."
      }
    }) as Record<string, unknown>;

    expect(result.taskId).toBeDefined();
    expect(typeof result.taskId).toBe("string");
    expect((result.taskId as string).startsWith("satask_")).toBe(true);
    expect(result.state).toBe("running");
    expect(result.cursor).toBeDefined();
  });

  it("inspect returns task snapshot", async () => {
    const spawn = await harness.executeWithOwner("owner-1", "subagents", {
      action: "spawn",
      task: {
        title: "Inspect test",
        goal: "Test inspect",
        instructions: "Do it."
      }
    }) as Record<string, unknown>;

    const snapshot = await harness.executeWithOwner("owner-1", "subagents", {
      action: "inspect",
      task_id: spawn.taskId
    }) as Record<string, unknown>;

    expect(snapshot.taskId).toBe(spawn.taskId);
    expect(snapshot.state).toBe("running");
    expect(snapshot.title).toBe("Inspect test");
  });

  it("list returns spawned tasks", async () => {
    await harness.executeWithOwner("owner-1", "subagents", {
      action: "spawn",
      task: {
        title: "List test 1",
        goal: "Test list",
        instructions: "Do it."
      }
    });
    await harness.executeWithOwner("owner-1", "subagents", {
      action: "spawn",
      task: {
        title: "List test 2",
        goal: "Test list",
        instructions: "Do it."
      }
    });

    const result = await harness.executeWithOwner("owner-1", "subagents", {
      action: "list"
    }) as Record<string, unknown>;

    expect(Array.isArray(result.tasks)).toBe(true);
    expect((result.tasks as unknown[]).length).toBe(2);
  });

  it("recv returns events for a task", async () => {
    const spawn = await harness.executeWithOwner("owner-1", "subagents", {
      action: "spawn",
      task: {
        title: "Recv test",
        goal: "Test recv",
        instructions: "Do it."
      }
    }) as Record<string, unknown>;

    const result = await harness.executeWithOwner("owner-1", "subagents", {
      action: "recv",
      tasks: { [spawn.taskId as string]: "" }
    }) as Record<string, unknown>;

    expect(Array.isArray(result.events)).toBe(true);
    expect((result.events as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(result.cursors).toBeDefined();
  });

  it("cancel terminates a task", async () => {
    const spawn = await harness.executeWithOwner("owner-1", "subagents", {
      action: "spawn",
      task: {
        title: "Cancel test",
        goal: "Test cancel",
        instructions: "Do it."
      }
    }) as Record<string, unknown>;

    const result = await harness.executeWithOwner("owner-1", "subagents", {
      action: "cancel",
      task_id: spawn.taskId,
      reason: "No longer needed"
    }) as Record<string, unknown>;

    expect(result.state).toBe("cancelled");
    expect(result.finalEventId).toBeDefined();
  });

  it("full round-trip: spawn → recv → inspect → cancel", async () => {
    // Spawn
    const spawn = await harness.executeWithOwner("owner-1", "subagents", {
      action: "spawn",
      task: {
        title: "Round trip test",
        goal: "Full lifecycle",
        instructions: "Do the thing.",
        labels: { test: "round-trip" }
      }
    }) as Record<string, unknown>;
    const taskId = spawn.taskId as string;

    // Recv — should have started event
    const recv = await harness.executeWithOwner("owner-1", "subagents", {
      action: "recv",
      tasks: { [taskId]: "" }
    }) as Record<string, unknown>;
    expect((recv.events as unknown[]).length).toBeGreaterThanOrEqual(1);

    // Inspect
    const snapshot = await harness.executeWithOwner("owner-1", "subagents", {
      action: "inspect",
      task_id: taskId
    }) as Record<string, unknown>;
    expect(snapshot.state).toBe("running");
    expect(snapshot.labels).toEqual({ test: "round-trip" });

    // Cancel
    const cancel = await harness.executeWithOwner("owner-1", "subagents", {
      action: "cancel",
      task_id: taskId,
      reason: "Test complete"
    }) as Record<string, unknown>;
    expect(cancel.state).toBe("cancelled");
  });

  it("rejects unknown task_id", async () => {
    await expect(
      harness.executeWithOwner("owner-1", "subagents", {
        action: "inspect",
        task_id: "satask_NONEXISTENT"
      })
    ).rejects.toThrow(/Task not found/);
  });

  it("is not registered when subagents are disabled", () => {
    const disabledHarness = createToolHarness({
      defaultCwd: root,
      defaultShell: "/bin/bash",
      execTimeoutMs: 30_000,
      execYieldMs: 5_000,
      processLogTailLines: 200,
      logPath: `${root}/tool-calls.jsonl`,
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000,
      subagents: {
        enabled: false,
        defaultModel: "gpt-4.1-mini",
        maxConcurrentTasks: 5,
        defaultTimeBudgetSec: 60,
        defaultMaxTurns: 10,
        defaultMaxTotalTokens: 50_000,
        defaultHeartbeatIntervalSec: 30,
        defaultIdleTimeoutSec: 120,
        defaultStallTimeoutSec: 300,
        defaultRequirePlanByTurn: 3,
        recvMaxEvents: 50,
        recvDefaultWaitMs: 100,
        awaitMaxTimeoutMs: 5_000
      }
    });

    const tools = disabledHarness.exportProviderTools();
    expect(tools.some((t) => t.name === "subagents")).toBe(false);
  });
});
