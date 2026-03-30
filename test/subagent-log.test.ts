import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createToolHarness } from "../src/harness/index.js";
import type { ToolContext } from "../src/harness/types.js";
import { SubagentManager } from "../src/harness/subagent-manager.js";
import { createSubagentWorker } from "../src/harness/subagent-worker.js";
import { createTraceRootContext } from "../src/observability.js";
import { createAuthModeRegistry } from "../src/provider/auth-mode-registry.js";
import { createSubagentLogSink } from "../src/subagent-log.js";
import type { Config, RuntimeLogger } from "../src/runtime/contracts.js";
import { createTempDir, makeConfig } from "./helpers.js";

function makeLogger(): RuntimeLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function readJsonl(logPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) {
    return [];
  }

  const raw = fs.readFileSync(logPath, "utf8").trim();
  if (raw.length === 0) {
    return [];
  }

  return raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function settle(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn: () => boolean, timeoutMs = 4_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) {
      return;
    }
    await settle(intervalMs);
  }

  throw new Error("Timed out waiting for condition");
}

async function waitForEntries(logPath: string, count: number, timeoutMs = 4_000): Promise<Array<Record<string, unknown>>> {
  let entries: Array<Record<string, unknown>> = [];
  await waitFor(() => {
    entries = readJsonl(logPath);
    return entries.length >= count;
  }, timeoutMs);
  return entries;
}

function createHarnessConfig(config: Config) {
  return {
    defaultCwd: config.tools.defaultCwd,
    defaultShell: config.tools.defaultShell,
    execTimeoutMs: config.tools.execTimeoutMs,
    execYieldMs: config.tools.execYieldMs,
    processLogTailLines: config.tools.processLogTailLines,
    logPath: config.tools.logPath,
    completedSessionRetentionMs: config.tools.completedSessionRetentionMs,
    maxCompletedSessions: config.tools.maxCompletedSessions,
    maxOutputChars: config.tools.maxOutputChars,
    webSearch: config.tools.webSearch,
    subagents: config.subagents
  };
}

describe("subagents.jsonl audit log", () => {
  it("logs supervisor subagents tool calls for success, validation failure, and execution failure", async () => {
    const root = createTempDir("acmd-subagent-log-supervisor-");
    const harness = createToolHarness(
      {
        defaultCwd: root,
        defaultShell: "/bin/bash",
        execTimeoutMs: 1_800_000,
        execYieldMs: 10_000,
        processLogTailLines: 200,
        logPath: path.join(root, "tool-calls.jsonl"),
        completedSessionRetentionMs: 3_600_000,
        maxCompletedSessions: 500,
        maxOutputChars: 200_000,
        subagents: {
          enabled: true,
          logPath: path.join(root, "subagents.jsonl"),
          defaultModel: "gpt-5.4-mini",
          maxConcurrentTasks: 10,
          defaultTimeBudgetSec: 900,
          defaultMaxTurns: 30,
          defaultMaxTotalTokens: 500_000,
          defaultHeartbeatIntervalSec: 30,
          defaultIdleTimeoutSec: 120,
          defaultStallTimeoutSec: 300,
          defaultRequirePlanByTurn: 3,
          recvMaxEvents: 100,
          recvDefaultWaitMs: 200,
          awaitMaxTimeoutMs: 30_000
        }
      }
    );

    await harness.executeWithOwner("owner-1", "subagents", {
      action: "spawn",
      task: {
        title: "Success",
        goal: "Spawn a subagent",
        instructions: "Follow the task."
      }
    });

    await expect(
      harness.executeWithOwner("owner-1", "subagents", {
        action: "spawn",
        task: {
          title: "Invalid",
          goal: "Missing instructions"
        }
      })
    ).rejects.toThrow("Invalid arguments for subagents");

    await expect(
      harness.executeWithOwner("owner-1", "subagents", {
        action: "inspect",
        task_id: "satask_missing"
      })
    ).rejects.toThrow("Task not found");

    const entries = await waitForEntries(path.join(root, "subagents.jsonl"), 3);
    const calls = entries.filter((entry) => entry.entry_type === "supervisor_tool_call");
    expect(calls).toHaveLength(3);

    expect(calls[0]).toEqual(
      expect.objectContaining({
        action: "spawn",
        owner_id: "owner-1",
        success: true
      })
    );
    expect(calls[1]).toEqual(
      expect.objectContaining({
        action: "spawn",
        owner_id: "owner-1",
        success: false,
        error_code: "TOOL_VALIDATION_ERROR"
      })
    );
    expect(calls[2]).toEqual(
      expect.objectContaining({
        action: "inspect",
        owner_id: "owner-1",
        success: false
      })
    );
    expect(calls[2].error_code).toBeTruthy();
  });

  it("logs worker tool calls with owner/task correlation and capped payloads", async () => {
    const root = createTempDir("acmd-subagent-log-worker-");
    const harness = createToolHarness(
      {
        defaultCwd: root,
        defaultShell: "/bin/bash",
        execTimeoutMs: 1_800_000,
        execYieldMs: 10_000,
        processLogTailLines: 200,
        logPath: path.join(root, "tool-calls.jsonl"),
        completedSessionRetentionMs: 3_600_000,
        maxCompletedSessions: 500,
        maxOutputChars: 200_000,
        subagents: {
          enabled: true,
          logPath: path.join(root, "subagents.jsonl"),
          defaultModel: "gpt-5.4-mini",
          maxConcurrentTasks: 10,
          defaultTimeBudgetSec: 900,
          defaultMaxTurns: 30,
          defaultMaxTotalTokens: 500_000,
          defaultHeartbeatIntervalSec: 30,
          defaultIdleTimeoutSec: 120,
          defaultStallTimeoutSec: 300,
          defaultRequirePlanByTurn: 3,
          recvMaxEvents: 100,
          recvDefaultWaitMs: 200,
          awaitMaxTimeoutMs: 30_000
        }
      },
      {
        subagentLogRedaction: {
          enabled: true,
          maxStringChars: 40,
          redactKeys: []
        }
      }
    );

    const ctx: ToolContext = {
      ...harness.context,
      ownerId: "satask_worker_test",
      trace: createTraceRootContext("tool"),
      subagentSession: {
        taskId: "satask_worker_test",
        ownerId: "owner-1"
      }
    };

    await harness.registry.execute("write_file", {
      path: "worker-output.txt",
      content: "x".repeat(200)
    }, ctx);

    const entries = await waitForEntries(path.join(root, "subagents.jsonl"), 1);
    const workerCall = entries.find((entry) => entry.entry_type === "worker_tool_call");
    expect(workerCall).toBeDefined();
    expect(workerCall).toEqual(
      expect.objectContaining({
        owner_id: "owner-1",
        task_id: "satask_worker_test",
        tool: "write_file",
        success: true
      })
    );
    expect(((workerCall?.args as { content?: string })?.content ?? "")).toContain("[TRUNCATED:+");
  });

  it("logs task events and supervisor exchanges for spawn, send, cancel, and timeout", async () => {
    const root = createTempDir("acmd-subagent-log-manager-");
    const logPath = path.join(root, "subagents.jsonl");
    const manager = new SubagentManager(
      {
        defaultModel: "gpt-5.4-mini",
        maxConcurrentTasks: 10,
        defaultTimeBudgetSec: 900,
        defaultMaxTurns: 30,
        defaultMaxTotalTokens: 500_000,
        defaultHeartbeatIntervalSec: 30,
        defaultIdleTimeoutSec: 120,
        defaultStallTimeoutSec: 300,
        defaultRequirePlanByTurn: 3,
        recvMaxEvents: 100,
        recvDefaultWaitMs: 200,
        awaitMaxTimeoutMs: 30_000
      },
      undefined,
      undefined,
      createSubagentLogSink({ enabled: true, logPath })
    );

    const steerTask = manager.spawn("owner-1", {
      title: "Needs guidance",
      goal: "Ask a question",
      instructions: "Pause and wait."
    });
    manager.pushWorkerEvent(steerTask.taskId, "question", {
      message: "Which option should I use?"
    });
    manager.send("owner-1", steerTask.taskId, {
      role: "supervisor",
      content: "Use option A",
      directiveType: "answer"
    });

    const cancelTask = manager.spawn("owner-1", {
      title: "Cancel me",
      goal: "Stop early",
      instructions: "Wait."
    });
    manager.cancel("owner-1", cancelTask.taskId, "No longer needed");

    const timeoutTask = manager.spawn("owner-1", {
      title: "Timeout me",
      goal: "Hit a timeout",
      instructions: "Wait."
    });
    manager.pushWorkerEvent(timeoutTask.taskId, "timeout", {
      message: "Time budget exceeded",
      error: {
        code: "TIME_BUDGET_EXCEEDED",
        retryable: false
      }
    });

    const entries = await waitForEntries(logPath, 8);
    const taskEvents = entries.filter((entry) => entry.entry_type === "task_event");
    const exchanges = entries.filter((entry) => entry.entry_type === "exchange");

    expect(taskEvents.some((entry) => entry.task_id === steerTask.taskId && entry.kind === "started")).toBe(true);
    expect(taskEvents.some((entry) => entry.task_id === steerTask.taskId && entry.kind === "question")).toBe(true);
    expect(taskEvents.some((entry) => entry.task_id === steerTask.taskId && entry.kind === "status_change")).toBe(true);
    expect(taskEvents.some((entry) => entry.task_id === cancelTask.taskId && entry.state === "cancelled")).toBe(true);
    expect(taskEvents.some((entry) => entry.task_id === timeoutTask.taskId && entry.state === "timed_out")).toBe(true);

    expect(exchanges).toContainEqual(
      expect.objectContaining({
        task_id: steerTask.taskId,
        direction: "supervisor_to_subagent",
        content: "Use option A",
        directive_type: "answer"
      })
    );

    manager.shutdown();
  });

  it("reconstructs spawn, internal tool activity, exchange, and terminal outcome in one log", async () => {
    const config = makeConfig({
      observability: {
        enabled: false,
        redaction: {
          enabled: true,
          maxStringChars: 4_000,
          redactKeys: []
        }
      }
    });
    const harness = createToolHarness(createHarnessConfig(config), {
      subagentLogRedaction: config.observability.redaction,
      resolveDefaultCwd: async () => config.tools.defaultCwd
    });
    const manager = harness.context.subagentManager;
    if (!manager) {
      throw new Error("subagent manager not initialized");
    }

    const finalReply = [
      "Completed the requested work.",
      "",
      "Confirmed:",
      "- Wrote the requested file.",
      "",
      "Inferred:",
      "- The provided setting should work for the user.",
      "",
      "Unverified:",
      "- Did not run the follow-up command.",
      "",
      "<TASK_RESULT>",
      JSON.stringify({
        summary: "Completed the requested work.",
        outcome: "success",
        confirmed: ["Wrote the requested file."],
        inferred: ["The provided setting should work for the user."],
        unverified: ["Did not run the follow-up command."],
        deliverables: [{ type: "file", ref: "notes.txt" }],
        open_issues: ["Follow-up command still unverified."],
        recommended_next_steps: ["Run the follow-up command if needed."],
        decision_journal: null
      }),
      "</TASK_RESULT>",
      "[TASK_COMPLETE]"
    ].join("\n");

    const responses = [
      {
        id: "resp_1",
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "write_file",
            arguments: JSON.stringify({
              path: "notes.txt",
              content: "written by subagent"
            })
          }
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      },
      {
        id: "resp_2",
        output_text: "Which setting should I use?\n[NEEDS_INPUT]",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Which setting should I use?\n[NEEDS_INPUT]" }]
          }
        ],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
      },
      {
        id: "resp_3",
        output_text: finalReply,
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: finalReply }]
          }
        ],
        usage: { input_tokens: 30, output_tokens: 15, total_tokens: 45 }
      }
    ];

    let responseIndex = 0;
    const fetchMock = vi.fn(async () => {
      const body = responses[responseIndex];
      responseIndex += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const worker = createSubagentWorker({
      config,
      harness,
      manager,
      logger: makeLogger(),
      subagentLog: harness.context.subagentLog,
      transportDeps: {
        fetchImpl: fetchMock as unknown as typeof fetch
      },
      authModeRegistry: createAuthModeRegistry({ apiKey: "test-key", codexAuth: null }),
      resolveOwnerProviderSettings: async () => ({
        authMode: "api" as const,
        transportMode: "http" as const
      })
    });
    manager.setWorker(worker);

    const spawn = await harness.executeWithOwner("owner-1", "subagents", {
      action: "spawn",
      task: {
        title: "Audit reconstruction",
        goal: "Create a file, ask a question, then finish",
        instructions: "Use the provided tools and ask for input when blocked."
      }
    }) as { taskId: string };

    await waitFor(() => manager.inspect("owner-1", spawn.taskId).state === "needs_steer");

    await harness.executeWithOwner("owner-1", "subagents", {
      action: "send",
      task_id: spawn.taskId,
      message: {
        role: "supervisor",
        content: "Use the default setting.",
        directive_type: "answer"
      }
    });

    await waitFor(() => manager.inspect("owner-1", spawn.taskId).state === "completed");

    const entries = await waitForEntries(config.subagents.logPath, 8);

    expect(entries.some((entry) => entry.entry_type === "supervisor_tool_call" && entry.action === "spawn")).toBe(true);
    expect(entries).toContainEqual(
      expect.objectContaining({
        entry_type: "worker_tool_call",
        owner_id: "owner-1",
        task_id: spawn.taskId,
        tool: "write_file",
        success: true
      })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        entry_type: "exchange",
        task_id: spawn.taskId,
        direction: "subagent_to_supervisor",
        reply_classification: "needs_input",
        content: "Which setting should I use?"
      })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        entry_type: "exchange",
        task_id: spawn.taskId,
        direction: "supervisor_to_subagent",
        content: "Use the default setting.",
        directive_type: "answer"
      })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        entry_type: "exchange",
        task_id: spawn.taskId,
        direction: "subagent_to_supervisor",
        reply_classification: "complete"
      })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        entry_type: "task_event",
        task_id: spawn.taskId,
        kind: "result",
        state: "completed",
        result: expect.objectContaining({
          outcome: "success",
          open_issues: expect.arrayContaining(["Follow-up command still unverified."])
        })
      })
    );
  });

  it("keeps only the newest subagent log lines when maxLines is configured", async () => {
    const root = createTempDir("acmd-subagent-log-cap-");
    const logPath = path.join(root, "subagents.jsonl");
    const sink = createSubagentLogSink({
      enabled: true,
      logPath,
      maxLines: 2
    });

    for (const action of ["spawn", "inspect", "cancel"]) {
      await sink.record({
        entry_type: "supervisor_tool_call",
        timestamp: new Date().toISOString(),
        owner_id: "owner-1",
        task_id: null,
        tool: "subagents",
        action,
        normalized_request: { action },
        success: true,
        response: { ok: true },
        error: null,
        error_code: null,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        trace: createTraceRootContext("tool")
      });
    }

    const entries = readJsonl(logPath);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.action)).toEqual(["inspect", "cancel"]);
  });

  it("reports subagent log write failures through the warning reporter once", async () => {
    const warningReporter = vi.fn();
    const sink = createSubagentLogSink({
      enabled: true,
      logPath: path.join("/dev/null", "subagents.jsonl"),
      warningReporter
    });

    await expect(
      sink.record({
        entry_type: "supervisor_tool_call",
        timestamp: new Date().toISOString(),
        owner_id: "owner-1",
        task_id: null,
        tool: "subagents",
        action: "spawn",
        normalized_request: { action: "spawn" },
        success: false,
        response: null,
        error: { code: "WRITE_FAILED", message: "write failed", retryable: false },
        error_code: "WRITE_FAILED",
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        trace: createTraceRootContext("tool")
      })
    ).resolves.toBeUndefined();

    await expect(
      sink.record({
        entry_type: "supervisor_tool_call",
        timestamp: new Date().toISOString(),
        owner_id: "owner-1",
        task_id: null,
        tool: "subagents",
        action: "cancel",
        normalized_request: { action: "cancel" },
        success: false,
        response: null,
        error: { code: "WRITE_FAILED", message: "write failed", retryable: false },
        error_code: "WRITE_FAILED",
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        trace: createTraceRootContext("tool")
      })
    ).resolves.toBeUndefined();

    expect(warningReporter).toHaveBeenCalledTimes(1);
    const warningText = String(warningReporter.mock.calls[0]?.[0] ?? "");
    expect(warningText).toContain("subagent-log: failed to append entry");
    expect(warningText).toContain("/dev/null/subagents.jsonl");
    expect(warningText).toContain("EEXIST");
  });
});
