import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSubagentWorker, classifyReply, type SubagentWorkerDeps } from "../src/harness/subagent-worker.js";
import { createAuthModeRegistry } from "../src/provider/auth-mode-registry.js";
import { SubagentManager } from "../src/harness/subagent-manager.js";
import type { SubagentManagerConfig, SubagentTask, SubagentWorker, SpawnTaskParams } from "../src/harness/subagent-types.js";
import type { ToolHarness } from "../src/harness/index.js";
import type { Config, RuntimeLogger, OpenAIModelCatalogEntry } from "../src/runtime/contracts.js";
import type { OpenAIResponsesResponse } from "../src/provider/openai-types.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeManagerConfig(overrides: Partial<SubagentManagerConfig> = {}): SubagentManagerConfig {
  return {
    defaultModel: "test-model",
    maxConcurrentTasks: 10,
    defaultTimeBudgetSec: 900,
    defaultMaxTurns: 30,
    defaultMaxTotalTokens: 500_000,
    defaultHeartbeatIntervalSec: 9999, // Large to avoid heartbeat interference
    defaultIdleTimeoutSec: 9999,
    defaultStallTimeoutSec: 99999,
    defaultRequirePlanByTurn: 999,
    recvMaxEvents: 100,
    recvDefaultWaitMs: 200,
    awaitMaxTimeoutMs: 30_000,
    ...overrides
  };
}

const testModelEntry: OpenAIModelCatalogEntry = {
  id: "test-model",
  aliases: [],
  contextWindow: 128_000,
  maxOutputTokens: 8_000,
  defaultThinking: "low",
  cacheRetention: "in_memory",
  compactionTokens: null,
  compactionThreshold: 0.8
};

function makeConfig(): Config {
  return {
    agentId: "test-agent",
    configPath: "/tmp/test-config.json",
    repoRoot: "/tmp",
    telegram: {
      botToken: "test",
      streamingEnabled: false,
      streamingMinUpdateMs: 0,
      assistantFormat: "plain_text",
      maxFileSizeBytes: 10 * 1024 * 1024,
      fileDownloadTimeoutMs: 30_000,
      maxConcurrentDownloads: 4
    },
    openai: {
      authMode: "api",
      apiKey: "test-key",
      model: "test-model",
      models: [testModelEntry],
      timeoutMs: 30_000,
      maxRetries: 0, // No retries in tests
      retryBaseMs: 100,
      retryMaxMs: 1_000
    },
    runtime: {
      logLevel: "error",
      promptHistoryLimit: null,
      defaultVerbose: "off",
      toolLoopMaxSteps: 50,
      toolWorkflowTimeoutMs: 300_000,
      toolCommandTimeoutMs: 60_000,
      toolPollIntervalMs: 1_000,
      toolPollMaxAttempts: 10,
      toolIdleOutputThresholdMs: 30_000,
      toolHeartbeatIntervalMs: 10_000,
      toolCleanupGraceMs: 5_000,
      toolFailureBreakerThreshold: 3,
      sessionCacheMaxEntries: 10,
      appLogFlushIntervalMs: 5_000,
      messageQueueMode: "batch"
    },
    access: {
      allowedSenderIds: new Set()
    },
    tools: {
      defaultCwd: "/tmp",
      defaultShell: "/bin/sh",
      execTimeoutMs: 30_000,
      execYieldMs: 100,
      processLogTailLines: 50,
      logPath: "/tmp/test-log.jsonl",
      completedSessionRetentionMs: 60_000,
      maxCompletedSessions: 20,
      maxOutputChars: 100_000,
      webSearch: {
        apiKey: null,
        defaultPreset: "pro-search",
        presets: []
      }
    },
    paths: {
      workspaceRoot: "/tmp",
      conversationsDir: "/tmp/conversations",
      stashedConversationsPath: "/tmp/stashed.json",
      activeConversationsPath: "/tmp/active.json",
      contextSnapshotsDir: "/tmp/snapshots",
      appLogPath: "/tmp/app.log"
    },
    observability: {
      enabled: false,
      logPath: "/tmp/obs.jsonl",
      redaction: {
        enabled: false,
        maxStringChars: 1000,
        redactKeys: []
      }
    },
    subagents: {
      enabled: true,
      defaultModel: "test-model",
      maxConcurrentTasks: 10,
      defaultTimeBudgetSec: 900,
      defaultMaxTurns: 30,
      defaultMaxTotalTokens: 500_000,
      defaultHeartbeatIntervalSec: 9999,
      defaultIdleTimeoutSec: 9999,
      defaultStallTimeoutSec: 99999,
      defaultRequirePlanByTurn: 999,
      recvMaxEvents: 100,
      recvDefaultWaitMs: 200,
      awaitMaxTimeoutMs: 30_000
    }
  };
}

function makeLogger(): RuntimeLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function makeSpawnParams(overrides: Partial<SpawnTaskParams> = {}): SpawnTaskParams {
  return {
    title: "Test task",
    goal: "Do the thing",
    instructions: "Follow the spec.",
    ...overrides
  };
}

/** Build a mock response that the tool loop interprets as "done" (no function calls). */
function makeCompletionResponse(text: string, tokens = { input: 100, output: 50 }): OpenAIResponsesResponse {
  return {
    id: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    output_text: text,
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text }]
      }
    ],
    usage: {
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      total_tokens: tokens.input + tokens.output
    }
  };
}

/**
 * Creates a mock harness that pretends to have tools.
 */
function makeMockHarness(): ToolHarness {
  const context = {
    config: {
      defaultCwd: "/tmp",
      defaultShell: "/bin/sh",
      execTimeoutMs: 30_000,
      execYieldMs: 100,
      processLogTailLines: 50,
      logPath: "/tmp/test.jsonl",
      completedSessionRetentionMs: 60_000,
      maxCompletedSessions: 20,
      maxOutputChars: 100_000,
      webSearch: { apiKey: null, defaultPreset: "pro-search", presets: [] }
    },
    processManager: {
      terminateSession: vi.fn().mockResolvedValue({ status: "terminated", forced: false })
    },
    logger: { log: vi.fn() },
    metrics: {
      toolSuccessCount: 0,
      toolFailureCount: 0,
      errorCodeCounts: {},
      workflowsStarted: 0,
      workflowsSucceeded: 0,
      workflowsFailed: 0,
      workflowsTimedOut: 0,
      workflowsInterrupted: 0,
      workflowsCleanupErrors: 0,
      workflowLoopBreakerTrips: 0
    },
    ownerId: null,
    trace: undefined,
    observability: undefined,
    subagentManager: undefined
  } as unknown as ToolHarness["context"];

  const mockTools = [
    {
      type: "function" as const,
      name: "bash",
      description: "Run a shell command",
      parameters: { type: "object", properties: {} },
      strict: false
    },
    {
      type: "function" as const,
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: {} },
      strict: false
    },
    {
      type: "function" as const,
      name: "subagents",
      description: "Manage subagents",
      parameters: { type: "object", properties: {} },
      strict: false
    }
  ];

  return {
    config: context.config,
    context,
    registry: {
      execute: vi.fn().mockResolvedValue({ ok: true, output: "mock output" }),
      register: vi.fn(),
      exportProviderTools: () => mockTools
    } as unknown as ToolHarness["registry"],
    metrics: context.metrics,
    execute: vi.fn().mockResolvedValue({ ok: true, output: "mock output" }),
    executeWithOwner: vi.fn().mockResolvedValue({ ok: true, output: "mock output" }),
    exportProviderTools: () => mockTools
  };
}

/** Helper to wait for async operations to settle */
async function settle(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until a condition is met or timeout */
async function waitFor(fn: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await settle(intervalMs);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SubagentWorker", () => {
  let manager: SubagentManager;
  let mockHarness: ToolHarness;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    manager = new SubagentManager(makeManagerConfig());
    mockHarness = makeMockHarness();
    mockFetch = vi.fn();
  });

  afterEach(() => {
    manager.shutdown();
  });

  function createWorker(overrides: Partial<SubagentWorkerDeps> = {}): SubagentWorker {
    const w = createSubagentWorker({
      config: makeConfig(),
      harness: mockHarness,
      manager,
      logger: makeLogger(),
      transportDeps: {
        fetchImpl: mockFetch as unknown as typeof fetch
      },
      authModeRegistry: createAuthModeRegistry({ apiKey: "test-key", codexAuth: null }),
      resolveOwnerProviderSettings: async () => ({ authMode: "api" as const, transportMode: "http" as const }),
      ...overrides
    });
    manager.setWorker(w);
    return w;
  }

  function buildTask(params?: Partial<SpawnTaskParams>): SubagentTask {
    // Use a NoOp worker during spawn so the manager doesn't trigger the real worker
    const savedWorker = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) };
    manager.setWorker(savedWorker);
    const response = manager.spawn("owner-1", makeSpawnParams(params));
    const snapshot = manager.inspect("owner-1", response.taskId);
    return {
      taskId: response.taskId,
      ownerId: "owner-1",
      title: "Test task",
      goal: "Do the thing",
      instructions: "Follow the spec.",
      context: {},
      artifacts: [],
      constraints: {
        timeBudgetSec: 900,
        maxTurns: 30,
        maxTotalTokens: 500_000,
        requirePlanByTurn: 999,
        sandbox: "none",
        network: "full",
        noChildSpawn: true,
        approvalPolicy: {
          canEditCode: true,
          canRunTests: true,
          canOpenPr: false,
          requiresSupervisorFor: []
        }
      },
      execution: {
        agentType: "coding",
        model: "test-model",
        heartbeatIntervalSec: 9999,
        idleTimeoutSec: 9999,
        stallTimeoutSec: 99999
      },
      completionContract: {
        requireFinalSummary: true,
        requireStructuredResult: false
      },
      labels: {},
      state: snapshot.state,
      turnOwnership: snapshot.turnOwnership,
      budgetUsage: {
        turnsUsed: 0,
        tokensUsed: 0,
        planSubmitted: false,
        budgetWarnings: new Set()
      },
      nextSeq: 0,
      createdAt: new Date().toISOString(),
      startedAt: snapshot.startedAt,
      updatedAt: snapshot.updatedAt,
      finishedAt: null,
      lastHeartbeatAt: null,
      leaseExpiresAt: snapshot.leaseExpiresAt,
      compactedSummary: null,
      availableTools: [],
      heartbeatTimer: null,
      idleTimer: null,
      stallTimer: null,
      startedAtMs: Date.now()
    };
  }

  describe("start", () => {
    it("runs tool loop and pushes result on success", async () => {
      const completionResp = makeCompletionResponse("Task completed successfully");
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(completionResp), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

      const worker = createWorker();
      const task = buildTask();

      await worker.start(task);
      await waitFor(() => {
        const recv = manager.recv("owner-1", { [task.taskId]: "" });
        return recv.events.some((e) => e.kind === "result");
      });

      const recv = manager.recv("owner-1", { [task.taskId]: "" });
      const resultEvents = recv.events.filter((e) => e.kind === "result");
      expect(resultEvents.length).toBe(1);
      expect(resultEvents[0].result?.outcome).toBe("success");
      expect(resultEvents[0].result?.summary).toBe("Task completed successfully");
    });

    it("pushes error event on provider failure", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Server error", type: "server_error" } }), {
          status: 500,
          headers: { "content-type": "application/json" }
        })
      );

      const worker = createWorker();
      const task = buildTask();

      await worker.start(task);
      await waitFor(() => {
        const recv = manager.recv("owner-1", { [task.taskId]: "" });
        return recv.events.some((e) => e.kind === "error");
      });

      const recv = manager.recv("owner-1", { [task.taskId]: "" });
      const errorEvents = recv.events.filter((e) => e.kind === "error");
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("records token usage from response", async () => {
      const completionResp = makeCompletionResponse("done", { input: 200, output: 100 });
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(completionResp), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

      const worker = createWorker();
      const task = buildTask();

      await worker.start(task);
      await waitFor(() => manager.inspect("owner-1", task.taskId).tokensUsed > 0);

      const snapshot = manager.inspect("owner-1", task.taskId);
      expect(snapshot.tokensUsed).toBe(300); // 200 + 100
    });

    it("records turn usage per model response", async () => {
      const completionResp = makeCompletionResponse("done");
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(completionResp), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

      const worker = createWorker();
      const task = buildTask();

      await worker.start(task);
      await waitFor(() => manager.inspect("owner-1", task.taskId).turnsUsed > 0);

      const snapshot = manager.inspect("owner-1", task.taskId);
      expect(snapshot.turnsUsed).toBe(1);
    });
  });

  describe("stop", () => {
    it("aborts the running tool loop", async () => {
      let requestAborted = false;
      mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener("abort", () => {
              requestAborted = true;
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }
        });
      });

      const worker = createWorker();
      const task = buildTask();

      await worker.start(task);
      await settle(50);

      await worker.stop(task.taskId, "test cancellation");
      await settle(50);

      expect(requestAborted).toBe(true);
    });

    it("is a no-op for unknown task IDs", async () => {
      const worker = createWorker();
      await worker.stop("nonexistent-task", "no such task");
    });
  });

  describe("send", () => {
    it("throws for unknown task IDs", async () => {
      const worker = createWorker();
      await expect(
        worker.send("nonexistent-task", { role: "supervisor", content: "hello" })
      ).rejects.toThrow(/No active runtime/);
    });

    it("pushes message to steer channel for active task", async () => {
      // Set up a hanging request so the task stays active
      mockFetch.mockImplementation(() => new Promise(() => {})); // Never resolves

      const worker = createWorker();
      const task = buildTask();

      await worker.start(task);
      await settle(50);

      // Should not throw
      await worker.send(task.taskId, { role: "supervisor", content: "please hurry" });

      // Clean up
      await worker.stop(task.taskId, "done");
    });
  });

  describe("scoped harness", () => {
    it("excludes subagents from exported provider tools in API request", async () => {
      let sentTools: string[] = [];
      mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string ?? "{}");
        sentTools = (body.tools ?? []).map((t: { name: string }) => t.name);
        return new Response(
          JSON.stringify(makeCompletionResponse("done")),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      });

      const worker = createWorker();
      const task = buildTask();

      await worker.start(task);
      await waitFor(() => sentTools.length > 0);

      expect(sentTools).not.toContain("subagents");
      expect(sentTools).toContain("bash");
      expect(sentTools).toContain("read_file");
    });
  });

  describe("setWorker", () => {
    it("swaps the worker on the manager", () => {
      const mockWorker: SubagentWorker = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined)
      };

      manager.setWorker(mockWorker);
      manager.spawn("owner-1", makeSpawnParams());

      expect(mockWorker.start).toHaveBeenCalledOnce();
    });
  });

  describe("P2: worker.start() rejection transitions task to failed", () => {
    it("pushes error event when worker start rejects", async () => {
      const failingWorker: SubagentWorker = {
        start: vi.fn().mockRejectedValue(new Error("Worker exploded")),
        stop: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined)
      };
      manager.setWorker(failingWorker);

      const response = manager.spawn("owner-1", makeSpawnParams());
      await settle(100);

      const recv = manager.recv("owner-1", { [response.taskId]: "" });
      const errorEvents = recv.events.filter((e) => e.kind === "error");
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
      expect(errorEvents.some((e) => e.message.includes("Worker start failed"))).toBe(true);
    });
  });

  describe("P3: stall timeout with stall <= idle", () => {
    it("does not fire stall terminal immediately when stallTimeout equals idleTimeout", () => {
      vi.useFakeTimers();
      try {
        manager.shutdown();
        manager = new SubagentManager(makeManagerConfig({
          defaultIdleTimeoutSec: 5,
          defaultStallTimeoutSec: 5 // Same as idle — would cause 0ms timer without fix
        }));

        const response = manager.spawn("owner-1", makeSpawnParams());
        const taskId = response.taskId;

        // Advance past idle timeout
        vi.advanceTimersByTime(5_001);

        let snapshot = manager.inspect("owner-1", taskId);
        expect(snapshot.state).toBe("stalled");

        // Not yet failed — minimum 1s gap enforced
        vi.advanceTimersByTime(500);
        snapshot = manager.inspect("owner-1", taskId);
        expect(snapshot.state).toBe("stalled");

        // Advance past the enforced minimum gap
        vi.advanceTimersByTime(1_001);
        snapshot = manager.inspect("owner-1", taskId);
        expect(snapshot.state).toBe("failed");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("recv without wait_ms", () => {
    it("accepts only tasks and max_events", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      const recv = manager.recv("owner-1", { [response.taskId]: "" }, 10);
      expect(recv.events.length).toBeGreaterThanOrEqual(1);
      expect(recv.cursors[response.taskId]).toBeDefined();
    });
  });

  describe("concurrent tasks", () => {
    it("two tasks get independent abort controllers", async () => {
      let requestCount = 0;
      mockFetch.mockImplementation(() => {
        requestCount++;
        return new Promise(() => {}); // Hang forever
      });

      const worker = createWorker();
      const task1 = buildTask({ title: "task-1" });
      const task2 = buildTask({ title: "task-2" });

      await worker.start(task1);
      await worker.start(task2);
      await waitFor(() => requestCount >= 2);

      expect(requestCount).toBe(2);

      // Cancel only task1
      await worker.stop(task1.taskId, "cancel task1");
      await settle(50);

      // task2 should still be sendable
      await worker.send(task2.taskId, { role: "supervisor", content: "hey" });

      // Clean up
      await worker.stop(task2.taskId, "done");
    });
  });

  describe("classifyReply", () => {
    it("returns needs_input for NEEDS_INPUT marker", () => {
      expect(classifyReply("I need help with X\n[NEEDS_INPUT]")).toBe("needs_input");
    });

    it("returns complete for TASK_COMPLETE marker", () => {
      expect(classifyReply("All done\n[TASK_COMPLETE]")).toBe("complete");
    });

    it("returns complete for unmarked replies", () => {
      expect(classifyReply("Here is the result")).toBe("complete");
    });

    it("handles trailing whitespace", () => {
      expect(classifyReply("Question?  [NEEDS_INPUT]  ")).toBe("needs_input");
    });
  });

  describe("question detection and pause/resume", () => {
    it("reply with [NEEDS_INPUT] pushes question event and pauses", async () => {
      const needsInputResp = makeCompletionResponse("I need to know the database password. What is it?\n[NEEDS_INPUT]");
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(needsInputResp), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

      const worker = createWorker();
      const task = buildTask();

      await worker.start(task);
      await waitFor(() => {
        const recv = manager.recv("owner-1", { [task.taskId]: "" });
        return recv.events.some((e) => e.kind === "question");
      });

      const snapshot = manager.inspect("owner-1", task.taskId);
      expect(snapshot.state).toBe("needs_steer");
      expect(snapshot.turnOwnership).toBe("supervisor");

      // Verify the question message doesn't include the marker
      const recv = manager.recv("owner-1", { [task.taskId]: "" });
      const questionEvents = recv.events.filter((e) => e.kind === "question");
      expect(questionEvents.length).toBe(1);
      expect(questionEvents[0].message).not.toContain("[NEEDS_INPUT]");
      expect(questionEvents[0].message).toContain("database password");
    });

    it("reply with [TASK_COMPLETE] pushes result event", async () => {
      const completeResp = makeCompletionResponse("All done, files updated.\n[TASK_COMPLETE]");
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(completeResp), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

      const worker = createWorker();
      const task = buildTask();

      await worker.start(task);
      await waitFor(() => {
        const recv = manager.recv("owner-1", { [task.taskId]: "" });
        return recv.events.some((e) => e.kind === "result");
      });

      const snapshot = manager.inspect("owner-1", task.taskId);
      expect(snapshot.state).toBe("completed");

      const recv = manager.recv("owner-1", { [task.taskId]: "" });
      const resultEvents = recv.events.filter((e) => e.kind === "result");
      expect(resultEvents[0].message).not.toContain("[TASK_COMPLETE]");
    });

    it("resume after needs_input: send() triggers new tool loop", async () => {
      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        // First call → needs input, second call → complete
        const text = callCount === 1
          ? "What database should I use?\n[NEEDS_INPUT]"
          : "Done, used PostgreSQL.\n[TASK_COMPLETE]";
        return new Response(
          JSON.stringify(makeCompletionResponse(text)),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      });

      const worker = createWorker();
      const task = buildTask();
      // Re-set the real worker (buildTask replaces it with NoOp)
      manager.setWorker(worker);

      await worker.start(task);
      await waitFor(() => manager.inspect("owner-1", task.taskId).state === "needs_steer");

      // Send supervisor guidance — this should trigger resume
      // The manager's send() will transition back to running and call worker.send()
      manager.send("owner-1", task.taskId, { role: "supervisor", content: "Use PostgreSQL" });

      // Wait for the second loop to complete
      await waitFor(() => manager.inspect("owner-1", task.taskId).state === "completed");

      const snapshot = manager.inspect("owner-1", task.taskId);
      expect(snapshot.state).toBe("completed");
      expect(callCount).toBe(2);
    });

    it("unmarked reply defaults to complete", async () => {
      const plainResp = makeCompletionResponse("Here is the answer without any marker");
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(plainResp), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

      const worker = createWorker();
      const task = buildTask();

      await worker.start(task);
      await waitFor(() => manager.inspect("owner-1", task.taskId).state === "completed");

      expect(manager.inspect("owner-1", task.taskId).state).toBe("completed");
    });
  });

  describe("capabilities in inspect", () => {
    it("inspect snapshot includes capabilities", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.capabilities).toBeDefined();
      expect(snapshot.capabilities.model).toBeDefined();
      expect(snapshot.capabilities.constraints.maxTurns).toBe(30);
      expect(snapshot.capabilities.constraints.timeBudgetSec).toBe(900);
      expect(Array.isArray(snapshot.capabilities.tools)).toBe(true);
    });
  });
});
