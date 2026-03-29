import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SubagentManager } from "../src/harness/subagent-manager.js";
import type { SubagentManagerConfig, SpawnTaskParams, SubagentWorker } from "../src/harness/subagent-types.js";
import type { ObservabilitySink, ObservabilityEventV2 } from "../src/observability.js";

function makeConfig(overrides: Partial<SubagentManagerConfig> = {}): SubagentManagerConfig {
  return {
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
    awaitMaxTimeoutMs: 30_000,
    ...overrides
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

describe("SubagentManager", () => {
  let manager: SubagentManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new SubagentManager(makeConfig());
  });

  afterEach(() => {
    manager.shutdown();
    vi.useRealTimers();
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  describe("spawn", () => {
    it("creates a task and returns a spawn response", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      expect(response.taskId).toMatch(/^satask_/);
      expect(response.state).toBe("running");
      expect(response.cursor).toMatch(/^saevt_/);
      expect(response.startedAt).toBeDefined();
      expect(response.leaseExpiresAt).toBeDefined();
    });

    it("task is in running state after spawn", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.state).toBe("running");
      expect(snapshot.turnOwnership).toBe("subagent");
      expect(snapshot.turnsUsed).toBe(0);
      expect(snapshot.tokensUsed).toBe(0);
    });

    it("emits a started event", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      const recv = manager.recv("owner-1", { [response.taskId]: "" });
      expect(recv.events.length).toBeGreaterThanOrEqual(1);
      expect(recv.events[0].kind).toBe("started");
      expect(recv.events[0].state).toBe("running");
    });

    it("applies custom constraints", () => {
      const response = manager.spawn("owner-1", makeSpawnParams({
        constraints: {
          timeBudgetSec: 60,
          maxTurns: 5,
          maxTotalTokens: 10_000
        }
      }));
      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot).toBeDefined();
    });

    it("rejects spawn when concurrent limit reached", () => {
      const config = makeConfig({ maxConcurrentTasks: 2 });
      manager.shutdown();
      manager = new SubagentManager(config);

      manager.spawn("owner-1", makeSpawnParams({ title: "task 1" }));
      manager.spawn("owner-1", makeSpawnParams({ title: "task 2" }));

      expect(() => {
        manager.spawn("owner-1", makeSpawnParams({ title: "task 3" }));
      }).toThrow(/Concurrent task limit/);
    });

    it("uses labels from spawn params", () => {
      const response = manager.spawn("owner-1", makeSpawnParams({
        labels: { initiative: "payments", role: "diagnosis" }
      }));
      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.labels).toEqual({ initiative: "payments", role: "diagnosis" });
    });
  });

  // ── Event protocol ────────────────────────────────────────────────────────

  describe("recv", () => {
    it("returns events after cursor", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      const taskId = response.taskId;

      // Push some worker events
      manager.pushWorkerEvent(taskId, "progress", {
        message: "Step 1 done",
        progress: { percent: 25, milestone: "step_1" }
      });

      const recv = manager.recv("owner-1", { [taskId]: response.cursor });
      expect(recv.events.length).toBeGreaterThanOrEqual(1);
      expect(recv.events.some((e) => e.kind === "progress")).toBe(true);
    });

    it("limits events to max_events", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      const taskId = response.taskId;

      for (let i = 0; i < 10; i++) {
        manager.pushWorkerEvent(taskId, "progress", {
          message: `Step ${i}`,
          progress: { percent: i * 10, milestone: `step_${i}` }
        });
      }

      const recv = manager.recv("owner-1", { [taskId]: "" }, 3);
      expect(recv.events.length).toBe(3);
    });

    it("returns events from multiple tasks", () => {
      const r1 = manager.spawn("owner-1", makeSpawnParams({ title: "task 1" }));
      const r2 = manager.spawn("owner-1", makeSpawnParams({ title: "task 2" }));

      manager.pushWorkerEvent(r1.taskId, "progress", { message: "T1 progress" });
      manager.pushWorkerEvent(r2.taskId, "progress", { message: "T2 progress" });

      const recv = manager.recv("owner-1", {
        [r1.taskId]: r1.cursor,
        [r2.taskId]: r2.cursor
      });

      const taskIds = new Set(recv.events.map((e) => e.taskId));
      expect(taskIds.size).toBe(2);
    });

    it("returns updated cursors per task", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      const recv = manager.recv("owner-1", { [response.taskId]: "" });
      expect(recv.cursors[response.taskId]).toBeDefined();
      expect(recv.cursors[response.taskId]).toMatch(/^saevt_/);
    });

    it("returns events with monotonically increasing seq", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      manager.pushWorkerEvent(response.taskId, "progress", { message: "A" });
      manager.pushWorkerEvent(response.taskId, "progress", { message: "B" });

      const recv = manager.recv("owner-1", { [response.taskId]: "" });
      const seqs = recv.events.map((e) => e.seq);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      }
    });

    it("returns empty when cursor points to last event", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      manager.pushWorkerEvent(response.taskId, "progress", { message: "done" });

      // First recv gets all events and returns a cursor
      const first = manager.recv("owner-1", { [response.taskId]: "" });
      expect(first.events.length).toBeGreaterThan(0);
      const latestCursor = first.cursors[response.taskId];

      // Second recv with that cursor should return empty
      const second = manager.recv("owner-1", { [response.taskId]: latestCursor });
      expect(second.events.length).toBe(0);
    });

    it("returns empty when cursor is unrecognized", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      manager.pushWorkerEvent(response.taskId, "progress", { message: "data" });

      const recv = manager.recv("owner-1", { [response.taskId]: "saevt_BOGUS" });
      expect(recv.events.length).toBe(0);
    });
  });

  // ── Send / Steering ───────────────────────────────────────────────────────

  describe("send", () => {
    it("accepts send when task needs steering", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      const taskId = response.taskId;

      // Push a decision request
      manager.pushWorkerEvent(taskId, "decision_request", {
        message: "Choose A or B?",
        options: [
          { id: "a", label: "Option A" },
          { id: "b", label: "Option B" }
        ]
      });

      const snapshot = manager.inspect("owner-1", taskId);
      expect(snapshot.state).toBe("needs_steer");

      const sendResult = manager.send("owner-1", taskId, {
        role: "supervisor",
        content: "Choose option B.",
        directiveType: "guidance"
      });

      expect(sendResult.accepted).toBe(true);
      expect(sendResult.state).toBe("running");
    });

    it("rejects send when turn ownership is subagent", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      expect(() => {
        manager.send("owner-1", response.taskId, {
          role: "supervisor",
          content: "Interrupt!"
        });
      }).toThrow(/turn ownership is "subagent"/);
    });

    it("rejects send to terminal task", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      manager.cancel("owner-1", response.taskId, "test");

      expect(() => {
        manager.send("owner-1", response.taskId, {
          role: "supervisor",
          content: "Hello?"
        });
      }).toThrow(/terminal state/);
    });
  });

  // ── Inspect ───────────────────────────────────────────────────────────────

  describe("inspect", () => {
    it("returns a complete snapshot", () => {
      const response = manager.spawn("owner-1", makeSpawnParams({
        labels: { initiative: "test" }
      }));

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.taskId).toBe(response.taskId);
      expect(snapshot.title).toBe("Test task");
      expect(snapshot.state).toBe("running");
      expect(snapshot.turnOwnership).toBe("subagent");
      expect(snapshot.turnsUsed).toBe(0);
      expect(snapshot.tokensUsed).toBe(0);
      expect(snapshot.labels).toEqual({ initiative: "test" });
      expect(snapshot.startedAt).toBeDefined();
    });

    it("throws for unknown task", () => {
      expect(() => manager.inspect("owner-1", "satask_NONEXISTENT")).toThrow(/Task not found/);
    });

    it("shows awaiting info when task needs steering", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      manager.pushWorkerEvent(response.taskId, "question", {
        message: "What database to use?"
      });

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.awaiting).toEqual({
        type: "supervisor",
        question: expect.stringContaining("database"),
        deadlineAt: null
      });
    });
  });

  // ── List ──────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns all tasks without filter", () => {
      manager.spawn("owner-1", makeSpawnParams({ title: "task 1" }));
      manager.spawn("owner-1", makeSpawnParams({ title: "task 2" }));

      const result = manager.list("owner-1");
      expect(result.length).toBe(2);
    });

    it("filters by state", () => {
      const r1 = manager.spawn("owner-1", makeSpawnParams({ title: "task 1" }));
      manager.spawn("owner-1", makeSpawnParams({ title: "task 2" }));
      manager.cancel("owner-1", r1.taskId, "test");

      const running = manager.list("owner-1", { states: ["running"] });
      expect(running.length).toBe(1);

      const cancelled = manager.list("owner-1", { states: ["cancelled"] });
      expect(cancelled.length).toBe(1);
    });

    it("filters by labels", () => {
      manager.spawn("owner-1", makeSpawnParams({
        title: "payment task",
        labels: { initiative: "payments" }
      }));
      manager.spawn("owner-1", makeSpawnParams({
        title: "auth task",
        labels: { initiative: "auth" }
      }));

      const result = manager.list("owner-1", { labels: { initiative: "payments" } });
      expect(result.length).toBe(1);
      expect(result[0].title).toBe("payment task");
    });
  });

  // ── Cancel ────────────────────────────────────────────────────────────────

  describe("cancel", () => {
    it("transitions task to cancelled", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      const cancelResult = manager.cancel("owner-1", response.taskId, "User changed priorities");

      expect(cancelResult.state).toBe("cancelled");
      expect(cancelResult.finalEventId).toMatch(/^saevt_/);

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.state).toBe("cancelled");
    });

    it("throws when cancelling an already-terminal task", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      manager.cancel("owner-1", response.taskId, "first cancel");

      expect(() => {
        manager.cancel("owner-1", response.taskId, "second cancel");
      }).toThrow(/terminal state/);
    });

    it("emits a terminal event with final: true", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      manager.cancel("owner-1", response.taskId, "done");

      const recv = manager.recv("owner-1", { [response.taskId]: "" });
      const finalEvent = recv.events.find((e) => e.final);
      expect(finalEvent).toBeDefined();
      expect(finalEvent!.state).toBe("cancelled");
    });
  });

  // ── Worker event pushing ──────────────────────────────────────────────────

  describe("pushWorkerEvent", () => {
    it("pushes progress events", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      manager.pushWorkerEvent(response.taskId, "progress", {
        message: "Reproduced the issue",
        progress: { percent: 30, milestone: "reproduced" }
      });

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.progress).toEqual({ percent: 30, milestone: "reproduced" });
    });

    it("pushes result event and transitions to completed", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      manager.pushWorkerEvent(response.taskId, "result", {
        message: "Done!",
        result: {
          summary: "Fixed the bug",
          outcome: "success",
          confidence: 0.95,
          confirmed: ["tests pass"],
          inferred: [],
          unverified: [],
          deliverables: [],
          evidence: ["tests pass"],
          openIssues: [],
          recommendedNextSteps: [],
          decisionJournalPath: null
        }
      });

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.state).toBe("completed");
      expect(snapshot.result).toBeDefined();
      expect(snapshot.result!.summary).toBe("Fixed the bug");
    });

    it("pushes error event and transitions to failed", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      manager.pushWorkerEvent(response.taskId, "error", {
        message: "Cannot proceed",
        error: {
          code: "ENVIRONMENT_MISMATCH",
          retryable: true,
          details: { reason: "missing dependency" }
        }
      });

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.state).toBe("failed");
    });

    it("pushes decision_request and transitions to needs_steer", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      manager.pushWorkerEvent(response.taskId, "decision_request", {
        message: "Which approach?",
        options: [
          { id: "a", label: "Approach A" },
          { id: "b", label: "Approach B" }
        ]
      });

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.state).toBe("needs_steer");
      expect(snapshot.turnOwnership).toBe("supervisor");
    });

    it("pushes checkpoint with plan and marks plan as submitted", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      manager.pushWorkerEvent(response.taskId, "checkpoint", {
        message: "Plan established",
        checkpoint: {
          plan: ["step 1", "step 2", "step 3"],
          successCriteria: ["tests pass"]
        }
      });

      // Plan is submitted — no needs_steer on turn 3
      manager.recordTurnUsed(response.taskId);
      manager.recordTurnUsed(response.taskId);
      manager.recordTurnUsed(response.taskId);

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.state).toBe("running");
    });

    it("rejects events on terminal tasks", () => {
      const response = manager.spawn("owner-1", makeSpawnParams());
      manager.cancel("owner-1", response.taskId, "done");

      expect(() => {
        manager.pushWorkerEvent(response.taskId, "progress", { message: "Late event" });
      }).toThrow(/terminal state/);
    });
  });

  // ── Budget enforcement ────────────────────────────────────────────────────

  describe("budget enforcement", () => {
    it("emits budget_warning at 80% turns", () => {
      manager.shutdown();
      manager = new SubagentManager(makeConfig({ defaultMaxTurns: 10 }));

      const response = manager.spawn("owner-1", makeSpawnParams());

      // Use 8 turns (80%)
      for (let i = 0; i < 8; i++) {
        manager.recordTurnUsed(response.taskId);
      }

      const recv = manager.recv("owner-1", { [response.taskId]: "" });
      const warnings = recv.events.filter((e) => e.kind === "budget_warning");
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings.some((w) => w.budget?.resource === "turns")).toBe(true);
    });

    it("transitions to timed_out when turns exceeded", () => {
      manager.shutdown();
      manager = new SubagentManager(makeConfig({ defaultMaxTurns: 5 }));

      const response = manager.spawn("owner-1", makeSpawnParams());

      for (let i = 0; i < 5; i++) {
        manager.recordTurnUsed(response.taskId);
      }

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.state).toBe("timed_out");
    });

    it("transitions to timed_out when tokens exceeded", () => {
      manager.shutdown();
      manager = new SubagentManager(makeConfig({ defaultMaxTotalTokens: 1000 }));

      const response = manager.spawn("owner-1", makeSpawnParams());
      manager.recordTokensUsed(response.taskId, 1000);

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.state).toBe("timed_out");
    });
  });

  // ── Plan enforcement ──────────────────────────────────────────────────────

  describe("plan enforcement", () => {
    it("transitions to needs_steer when no plan by deadline", () => {
      manager.shutdown();
      manager = new SubagentManager(makeConfig({ defaultRequirePlanByTurn: 2 }));

      const response = manager.spawn("owner-1", makeSpawnParams());

      manager.recordTurnUsed(response.taskId);
      manager.recordTurnUsed(response.taskId);

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.state).toBe("needs_steer");
    });

    it("does not trigger if plan is submitted before deadline", () => {
      manager.shutdown();
      manager = new SubagentManager(makeConfig({ defaultRequirePlanByTurn: 3 }));

      const response = manager.spawn("owner-1", makeSpawnParams());

      manager.recordTurnUsed(response.taskId);
      manager.pushWorkerEvent(response.taskId, "checkpoint", {
        message: "Plan",
        checkpoint: { plan: ["step 1"] }
      });
      manager.recordTurnUsed(response.taskId);
      manager.recordTurnUsed(response.taskId);

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.state).toBe("running");
    });

    it("does not trigger when require_plan_by_turn is 0", () => {
      manager.shutdown();
      manager = new SubagentManager(makeConfig({ defaultRequirePlanByTurn: 0 }));

      const response = manager.spawn("owner-1", makeSpawnParams());

      for (let i = 0; i < 5; i++) {
        manager.recordTurnUsed(response.taskId);
      }

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.state).toBe("running");
    });
  });

  // ── Liveness (heartbeat & stall detection) ────────────────────────────────

  describe("liveness", () => {
    it("emits heartbeat events at configured interval", () => {
      manager.shutdown();
      manager = new SubagentManager(makeConfig({ defaultHeartbeatIntervalSec: 5 }));

      const response = manager.spawn("owner-1", makeSpawnParams());

      // Advance timer past one heartbeat interval
      vi.advanceTimersByTime(5_000);

      const recv = manager.recv("owner-1", { [response.taskId]: response.cursor });
      const heartbeats = recv.events.filter((e) => e.kind === "heartbeat");
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    });

    it("transitions to stalled after idle timeout", () => {
      manager.shutdown();
      manager = new SubagentManager(makeConfig({
        defaultIdleTimeoutSec: 2,
        defaultStallTimeoutSec: 10
      }));

      const response = manager.spawn("owner-1", makeSpawnParams());

      // Advance past idle timeout
      vi.advanceTimersByTime(2_500);

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.state).toBe("stalled");
    });

    it("transitions to failed after stall timeout", () => {
      manager.shutdown();
      manager = new SubagentManager(makeConfig({
        defaultIdleTimeoutSec: 2,
        defaultStallTimeoutSec: 5
      }));

      const response = manager.spawn("owner-1", makeSpawnParams());

      // Advance past stall timeout
      vi.advanceTimersByTime(6_000);

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.state).toBe("failed");
    });

    it("resets idle timer on worker activity", () => {
      manager.shutdown();
      manager = new SubagentManager(makeConfig({
        defaultIdleTimeoutSec: 3,
        defaultStallTimeoutSec: 10
      }));

      const response = manager.spawn("owner-1", makeSpawnParams());

      // Advance 2 seconds, then push an event
      vi.advanceTimersByTime(2_000);
      manager.pushWorkerEvent(response.taskId, "progress", { message: "Still working" });

      // Advance another 2 seconds — should not be stalled because timer was reset
      vi.advanceTimersByTime(2_000);

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.state).toBe("running");
    });
  });

  // ── Await ─────────────────────────────────────────────────────────────────

  describe("await_", () => {
    it("resolves immediately if task is already terminal", async () => {
      // Use real timers for await_ since it uses setTimeout-based sleep
      vi.useRealTimers();
      const localManager = new SubagentManager(makeConfig());

      const response = localManager.spawn("owner-1", makeSpawnParams());
      localManager.cancel("owner-1", response.taskId, "test");

      const result = await localManager.await_("owner-1", response.taskId, ["terminal"], 5000);
      expect(result.events.some((e) => e.final)).toBe(true);
      localManager.shutdown();
    });

    it("resolves when a matching event appears", async () => {
      vi.useRealTimers();
      const localManager = new SubagentManager(makeConfig());

      const response = localManager.spawn("owner-1", makeSpawnParams());

      // Schedule a cancel after 100ms
      setTimeout(() => {
        localManager.cancel("owner-1", response.taskId, "delayed cancel");
      }, 100);

      const result = await localManager.await_("owner-1", response.taskId, ["terminal"], 5000);
      expect(result.events.some((e) => e.state === "cancelled")).toBe(true);
      localManager.shutdown();
    });

    it("finds pre-existing qualifying events when cursor is provided", async () => {
      vi.useRealTimers();
      const localManager = new SubagentManager(makeConfig());
      const response = localManager.spawn("owner-1", makeSpawnParams());
      const spawnCursor = response.cursor;

      // Push a question event (requiresResponse) BEFORE calling await_
      localManager.pushWorkerEvent(response.taskId, "question", {
        message: "What should I do?"
      });

      // Push a heartbeat AFTER the question
      localManager.pushWorkerEvent(response.taskId, "heartbeat", {
        message: "still alive"
      });

      // With cursor from spawn: sees both events including the question
      const result = await localManager.await_(
        "owner-1",
        response.taskId,
        ["requires_response"],
        1000,
        spawnCursor
      );

      expect(result.events.some((e) => e.requiresResponse)).toBe(true);
      expect(result.events.some((e) => e.kind === "question")).toBe(true);
      localManager.shutdown();
    });

    it("without cursor, pre-scans existing qualifying events", async () => {
      vi.useRealTimers();
      const localManager = new SubagentManager(makeConfig());
      const response = localManager.spawn("owner-1", makeSpawnParams());

      // Push a question event before calling await_ (without cursor)
      localManager.pushWorkerEvent(response.taskId, "question", {
        message: "What should I do?"
      });

      // Without cursor, await_ should pre-scan and find the existing question
      const result = await localManager.await_(
        "owner-1",
        response.taskId,
        ["requires_response"],
        200
      );

      expect(result.events.some((e) => e.requiresResponse)).toBe(true);
      expect(result.events.some((e) => e.kind === "question")).toBe(true);
      localManager.shutdown();
    });
  });

  // ── Shutdown ──────────────────────────────────────────────────────────────

  describe("shutdown", () => {
    it("cancels all running tasks", () => {
      const r1 = manager.spawn("owner-1", makeSpawnParams({ title: "task 1" }));
      const r2 = manager.spawn("owner-1", makeSpawnParams({ title: "task 2" }));

      manager.shutdown();

      const s1 = manager.inspect("owner-1", r1.taskId);
      const s2 = manager.inspect("owner-1", r2.taskId);
      expect(s1.state).toBe("cancelled");
      expect(s2.state).toBe("cancelled");
    });
  });

  // ── Health ────────────────────────────────────────────────────────────────

  describe("getHealth", () => {
    it("returns correct health stats", () => {
      const r1 = manager.spawn("owner-1", makeSpawnParams({ title: "task 1" }));
      manager.spawn("owner-1", makeSpawnParams({ title: "task 2" }));
      manager.cancel("owner-1", r1.taskId, "done");

      const health = manager.getHealth();
      expect(health.totalTasks).toBe(2);
      expect(health.runningTasks).toBe(1);
      expect(health.cancelledTasks).toBe(1);
    });
  });

  describe("terminal task retention", () => {
    it("prunes old terminal tasks without removing active tasks", () => {
      manager.shutdown();
      manager = new SubagentManager(makeConfig({
        defaultHeartbeatIntervalSec: 600,
        defaultIdleTimeoutSec: 3_600,
        defaultStallTimeoutSec: 7_200
      }));

      const terminal = manager.spawn("owner-1", makeSpawnParams({ title: "old terminal" }));
      manager.cancel("owner-1", terminal.taskId, "done");

      const running = manager.spawn("owner-1", makeSpawnParams({ title: "still active" }));

      vi.advanceTimersByTime(600_001);

      const health = manager.getHealth();
      expect(health.totalTasks).toBe(1);
      expect(health.runningTasks).toBe(1);
      expect(() => manager.inspect("owner-1", terminal.taskId)).toThrow(/Task not found/);
      expect(manager.inspect("owner-1", running.taskId).state).toBe("running");
    });

    it("does not prune non-terminal tasks that are waiting on supervisor input", () => {
      manager.shutdown();
      manager = new SubagentManager(makeConfig({
        defaultHeartbeatIntervalSec: 600,
        defaultIdleTimeoutSec: 3_600,
        defaultStallTimeoutSec: 7_200
      }));

      const response = manager.spawn("owner-1", makeSpawnParams({ title: "needs steer" }));
      manager.pushWorkerEvent(response.taskId, "question", {
        message: "Which path should I take?"
      });

      vi.advanceTimersByTime(600_001);

      const snapshot = manager.inspect("owner-1", response.taskId);
      expect(snapshot.state).toBe("needs_steer");
      expect(manager.getHealth().totalTasks).toBe(1);
    });

    it("caps retained terminal tasks at twenty", () => {
      const taskIds: string[] = [];

      for (let index = 0; index < 21; index += 1) {
        const response = manager.spawn("owner-1", makeSpawnParams({ title: `task ${index}` }));
        taskIds.push(response.taskId);
        manager.cancel("owner-1", response.taskId, "done");
        vi.advanceTimersByTime(1);
      }

      const health = manager.getHealth();
      expect(health.totalTasks).toBe(20);
      expect(() => manager.inspect("owner-1", taskIds[0] as string)).toThrow(/Task not found/);
      expect(manager.inspect("owner-1", taskIds[20] as string).state).toBe("cancelled");
    });
  });

  // ── Worker integration ────────────────────────────────────────────────────

  describe("worker integration", () => {
    it("calls worker.start on spawn", async () => {
      const mockWorker: SubagentWorker = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined)
      };

      manager.shutdown();
      manager = new SubagentManager(makeConfig(), mockWorker);
      manager.spawn("owner-1", makeSpawnParams());

      // Give the fire-and-forget promise a tick
      await vi.advanceTimersByTimeAsync(0);

      expect(mockWorker.start).toHaveBeenCalledOnce();
    });

    it("calls worker.stop on cancel", async () => {
      const mockWorker: SubagentWorker = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined)
      };

      manager.shutdown();
      manager = new SubagentManager(makeConfig(), mockWorker);
      const response = manager.spawn("owner-1", makeSpawnParams());
      manager.cancel("owner-1", response.taskId, "done");

      await vi.advanceTimersByTimeAsync(0);

      expect(mockWorker.stop).toHaveBeenCalledOnce();
    });

    it("calls worker.send on send", async () => {
      const mockWorker: SubagentWorker = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined)
      };

      manager.shutdown();
      manager = new SubagentManager(makeConfig(), mockWorker);
      const response = manager.spawn("owner-1", makeSpawnParams());

      // Put task in needs_steer
      manager.pushWorkerEvent(response.taskId, "question", {
        message: "What next?"
      });

      manager.send("owner-1", response.taskId, {
        role: "supervisor",
        content: "Continue with plan B."
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(mockWorker.send).toHaveBeenCalledOnce();
    });
  });

  // ── Observability ─────────────────────────────────────────────────────────

  describe("observability", () => {
    function createObsManager(
      configOverrides: Partial<SubagentManagerConfig> = {}
    ): { manager: SubagentManager; events: ObservabilityEventV2[] } {
      const events: ObservabilityEventV2[] = [];
      const sink: ObservabilitySink = {
        enabled: true,
        path: null,
        async record(event: ObservabilityEventV2): Promise<void> {
          events.push(event);
        }
      };
      const mgr = new SubagentManager(makeConfig(configOverrides), undefined, sink);
      return { manager: mgr, events };
    }

    it("emits subagent.task.spawned on spawn", () => {
      const { manager: m, events } = createObsManager();
      m.spawn("owner-1", makeSpawnParams({ title: "Obs test", labels: { env: "test" } }));

      const spawned = events.filter((e) => e.event === "subagent.task.spawned");
      expect(spawned.length).toBe(1);
      expect(spawned[0].title).toBe("Obs test");
      expect(spawned[0].ownerId).toBe("owner-1");
      expect(spawned[0].labels).toEqual({ env: "test" });
      expect(spawned[0].trace).toBeDefined();
      expect(spawned[0].trace.traceId).toMatch(/^trace_/);
      m.shutdown();
    });

    it("emits subagent.task.terminal on cancel", () => {
      const { manager: m, events } = createObsManager();
      const r = m.spawn("owner-1", makeSpawnParams());
      m.cancel("owner-1", r.taskId, "done");

      const terminal = events.filter((e) => e.event === "subagent.task.terminal");
      expect(terminal.length).toBe(1);
      expect(terminal[0].state).toBe("cancelled");
      expect(terminal[0].taskId).toBe(r.taskId);
      m.shutdown();
    });

    it("emits subagent.task.terminal on completed result", () => {
      const { manager: m, events } = createObsManager();
      const r = m.spawn("owner-1", makeSpawnParams());
      m.pushWorkerEvent(r.taskId, "result", {
        message: "Done!",
        result: {
          summary: "Fixed",
          outcome: "success",
          confidence: 0.9,
          confirmed: [],
          inferred: [],
          unverified: [],
          deliverables: [],
          evidence: [],
          openIssues: [],
          recommendedNextSteps: [],
          decisionJournalPath: null
        }
      });

      const terminal = events.filter((e) => e.event === "subagent.task.terminal");
      expect(terminal.length).toBe(1);
      expect(terminal[0].state).toBe("completed");
      m.shutdown();
    });

    it("emits subagent.task.state_change on needs_steer", () => {
      const { manager: m, events } = createObsManager();
      const r = m.spawn("owner-1", makeSpawnParams());
      m.pushWorkerEvent(r.taskId, "decision_request", {
        message: "Choose A or B?",
        options: [{ id: "a", label: "A" }]
      });

      const changes = events.filter((e) => e.event === "subagent.task.state_change");
      expect(changes.length).toBe(1);
      expect(changes[0].state).toBe("needs_steer");
      expect(changes[0].turnOwnership).toBe("supervisor");
      m.shutdown();
    });

    it("emits subagent.task.state_change on stalled", () => {
      vi.useRealTimers();
      const { manager: m, events } = createObsManager({
        defaultIdleTimeoutSec: 1,
        defaultStallTimeoutSec: 10
      });
      m.spawn("owner-1", makeSpawnParams());

      // Wait for idle timeout
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const changes = events.filter((e) => e.event === "subagent.task.state_change");
          expect(changes.some((e) => e.state === "stalled")).toBe(true);
          m.shutdown();
          resolve();
        }, 1200);
      });
    });

    it("emits subagent.budget.warning at 80% turns", () => {
      const { manager: m, events } = createObsManager({ defaultMaxTurns: 10 });
      const r = m.spawn("owner-1", makeSpawnParams());

      for (let i = 0; i < 8; i++) {
        m.recordTurnUsed(r.taskId);
      }

      const warnings = events.filter((e) => e.event === "subagent.budget.warning");
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0].resource).toBe("turns");
      expect(warnings[0].percent).toBe(80);
      m.shutdown();
    });

    it("emits subagent.supervisor.sent on send", () => {
      const { manager: m, events } = createObsManager();
      const r = m.spawn("owner-1", makeSpawnParams());
      m.pushWorkerEvent(r.taskId, "question", { message: "What next?" });

      m.send("owner-1", r.taskId, {
        role: "supervisor",
        content: "Do plan B.",
        directiveType: "guidance"
      });

      const sent = events.filter((e) => e.event === "subagent.supervisor.sent");
      expect(sent.length).toBe(1);
      expect(sent[0].directiveType).toBe("guidance");
      expect(sent[0].contentLength).toBe(10);
      m.shutdown();
    });

    it("does not emit when observability is disabled", () => {
      const events: ObservabilityEventV2[] = [];
      const sink: ObservabilitySink = {
        enabled: false,
        path: null,
        async record(event: ObservabilityEventV2): Promise<void> {
          events.push(event);
        }
      };
      const m = new SubagentManager(makeConfig(), undefined, sink);
      const r = m.spawn("owner-1", makeSpawnParams());
      m.cancel("owner-1", r.taskId, "test");

      expect(events.length).toBe(0);
      m.shutdown();
    });

    it("shares traceId across events for the same task", () => {
      const { manager: m, events } = createObsManager();
      const r = m.spawn("owner-1", makeSpawnParams());
      m.pushWorkerEvent(r.taskId, "decision_request", {
        message: "Choose?",
        options: [{ id: "a", label: "A" }]
      });
      m.send("owner-1", r.taskId, { role: "supervisor", content: "Go with A." });
      m.cancel("owner-1", r.taskId, "done");

      const taskEvents = events.filter((e) => e.taskId === r.taskId);
      expect(taskEvents.length).toBeGreaterThanOrEqual(3);

      const traceIds = new Set(taskEvents.map((e) => e.trace.traceId));
      expect(traceIds.size).toBe(1);
      m.shutdown();
    });
  });

  // ── Owner isolation ──────────────────────────────────────────────────────

  describe("owner isolation", () => {
    it("list only returns tasks for the calling owner", () => {
      manager.spawn("owner-1", makeSpawnParams({ title: "task A" }));
      manager.spawn("owner-2", makeSpawnParams({ title: "task B" }));

      const owner1Tasks = manager.list("owner-1");
      expect(owner1Tasks.length).toBe(1);
      expect(owner1Tasks[0].title).toBe("task A");

      const owner2Tasks = manager.list("owner-2");
      expect(owner2Tasks.length).toBe(1);
      expect(owner2Tasks[0].title).toBe("task B");
    });

    it("inspect rejects task not owned by caller", () => {
      const r = manager.spawn("owner-1", makeSpawnParams());
      expect(() => manager.inspect("owner-2", r.taskId)).toThrow(/Task not found/);
    });

    it("send rejects task not owned by caller", () => {
      const r = manager.spawn("owner-1", makeSpawnParams());
      manager.pushWorkerEvent(r.taskId, "question", { message: "What?" });

      expect(() => manager.send("owner-2", r.taskId, {
        role: "supervisor",
        content: "hijack"
      })).toThrow(/Task not found/);
    });

    it("cancel rejects task not owned by caller", () => {
      const r = manager.spawn("owner-1", makeSpawnParams());
      expect(() => manager.cancel("owner-2", r.taskId, "nope")).toThrow(/Task not found/);
    });

    it("recv silently drops tasks not owned by caller", () => {
      const r = manager.spawn("owner-1", makeSpawnParams());
      manager.pushWorkerEvent(r.taskId, "progress", { message: "secret" });

      const recv = manager.recv("owner-2", { [r.taskId]: "" });
      expect(recv.events.length).toBe(0);
    });

    it("await_ rejects task not owned by caller", async () => {
      vi.useRealTimers();
      const localManager = new SubagentManager(makeConfig());
      const r = localManager.spawn("owner-1", makeSpawnParams());

      await expect(
        localManager.await_("owner-2", r.taskId, ["terminal"], 200)
      ).rejects.toThrow(/Task not found/);
      localManager.shutdown();
    });
  });

  // ── Timeout event kind ─────────────────────────────────────────────────

  describe("timeout event kind", () => {
    it("pushWorkerEvent with 'timeout' transitions to timed_out state", () => {
      const r = manager.spawn("owner-1", makeSpawnParams());
      manager.pushWorkerEvent(r.taskId, "timeout", {
        message: "Time budget exceeded",
        error: { code: "TIME_BUDGET_EXCEEDED", retryable: false }
      });

      const snapshot = manager.inspect("owner-1", r.taskId);
      expect(snapshot.state).toBe("timed_out");
    });
  });
});
