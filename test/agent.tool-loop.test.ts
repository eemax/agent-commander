import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runOpenAIToolLoop, ToolWorkflowAbortError } from "../src/agent/tool-loop.js";
import type { OpenAIResponsesResponse } from "../src/provider/openai-types.js";
import type { ToolHarness } from "../src/harness/index.js";
import type { TraceContext } from "../src/observability.js";

function makeMetrics() {
  return {
    workflowsStarted: 0,
    workflowsSucceeded: 0,
    workflowsFailed: 0,
    workflowsTimedOut: 0,
    workflowsInterrupted: 0,
    workflowsCleanupErrors: 0,
    workflowLoopBreakerTrips: 0,
    toolSuccessCount: 0,
    toolFailureCount: 0,
    errorCodeCounts: {} as Record<string, number>
  };
}

function makeHarness(overrides: Partial<ToolHarness> = {}): ToolHarness {
  return {
    exportProviderTools: vi.fn().mockReturnValue([]),
    execute: vi.fn().mockResolvedValue({ ok: true }),
    executeWithOwner: vi.fn().mockResolvedValue({ ok: true }),
    metrics: makeMetrics(),
    context: {
      processManager: {
        terminateSession: vi.fn().mockResolvedValue({ status: "terminated", forced: false }),
        listSessionsByOwner: vi.fn().mockReturnValue([]),
        killRunningSessionsByOwner: vi.fn().mockReturnValue({ killed: 0, sessionIds: [] }),
        getHealth: vi.fn().mockReturnValue({})
      }
    },
    ...overrides
  } as unknown as ToolHarness;
}

function makeTrace(): TraceContext {
  return {
    traceId: "trace-1",
    spanId: "span-1",
    operationName: "test"
  } as unknown as TraceContext;
}

function makeResponse(overrides: Partial<OpenAIResponsesResponse> = {}): OpenAIResponsesResponse {
  return {
    id: "resp-1",
    output_text: "hello",
    output: [],
    ...overrides
  };
}

function makeFunctionCallResponse(calls: Array<{ name: string; args: Record<string, unknown> }>): OpenAIResponsesResponse {
  return {
    id: "resp-fc",
    output: calls.map((call, i) => ({
      type: "function_call",
      call_id: `call_${i}`,
      name: call.name,
      arguments: JSON.stringify(call.args)
    }))
  };
}

const DEFAULT_LIMITS = {
  workflowTimeoutMs: 60_000,
  commandTimeoutMs: 10_000,
  pollIntervalMs: 100,
  pollMaxAttempts: 3,
  idleOutputThresholdMs: 5_000,
  heartbeatIntervalMs: 60_000,
  cleanupGraceMs: 1_000,
  failureBreakerThreshold: 3
};

function makeParams(overrides: Partial<Parameters<typeof runOpenAIToolLoop>[0]> = {}) {
  return {
    request: vi.fn().mockResolvedValue(makeResponse()),
    model: "test-model",
    instructions: "test instructions",
    initialInput: [{ type: "message" as const, role: "user" as const, content: "hello" }],
    thinkingEffort: "medium" as const,
    compactionTokens: null,
    compactionThreshold: 1,
    promptCacheKey: "cache-key",
    promptCacheRetention: "in_memory" as const,
    harness: makeHarness(),
    maxSteps: 10,
    extractAssistantText: (r: OpenAIResponsesResponse) => r.output_text ?? "",
    trace: makeTrace(),
    limits: DEFAULT_LIMITS,
    ...overrides
  };
}

describe("runOpenAIToolLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns reply when model returns no function calls", async () => {
    const params = makeParams();
    const result = await runOpenAIToolLoop(params);
    expect(result.reply).toBe("hello");
    expect(params.harness.metrics.workflowsSucceeded).toBe(1);
    expect(params.harness.metrics.workflowsStarted).toBe(1);
  });

  it("executes function calls and feeds outputs back", async () => {
    const harness = makeHarness();
    (harness.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: "result" });

    const request = vi.fn()
      .mockResolvedValueOnce(makeFunctionCallResponse([{ name: "bash", args: { command: "ls" } }]))
      .mockResolvedValueOnce(makeResponse({ output_text: "done" }));

    const result = await runOpenAIToolLoop(makeParams({ request, harness }));

    expect(result.reply).toBe("done");
    expect(request).toHaveBeenCalledTimes(2);
    expect(harness.execute).toHaveBeenCalledWith("bash", { command: "ls" }, expect.anything(), undefined);
  });

  it("throws ToolWorkflowAbortError when maxSteps exceeded", async () => {
    const request = vi.fn().mockResolvedValue(
      makeFunctionCallResponse([{ name: "bash", args: { command: "echo" } }])
    );
    const harness = makeHarness();

    await expect(
      runOpenAIToolLoop(makeParams({ request, harness, maxSteps: 2 }))
    ).rejects.toThrow(ToolWorkflowAbortError);

    expect(harness.metrics.workflowLoopBreakerTrips).toBe(1);
  });

  it("throws on abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runOpenAIToolLoop(makeParams({ abortSignal: controller.signal }))
    ).rejects.toThrow(ToolWorkflowAbortError);
  });

  it("throws on workflow timeout", async () => {
    const harness = makeHarness();
    const request = vi.fn().mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(70_000);
      return makeFunctionCallResponse([{ name: "bash", args: { command: "slow" } }]);
    });

    await expect(
      runOpenAIToolLoop(makeParams({ request, harness }))
    ).rejects.toThrow(ToolWorkflowAbortError);

    expect(harness.metrics.workflowsTimedOut).toBe(1);
  });

  it("triggers failure breaker after repeated identical failures", async () => {
    const harness = makeHarness();
    (harness.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("always fails"));

    const request = vi.fn().mockResolvedValue(
      makeFunctionCallResponse([{ name: "bash", args: { command: "fail" } }])
    );

    await expect(
      runOpenAIToolLoop(makeParams({
        request,
        harness,
        limits: { ...DEFAULT_LIMITS, failureBreakerThreshold: 2 }
      }))
    ).rejects.toThrow(ToolWorkflowAbortError);

    expect(harness.metrics.workflowLoopBreakerTrips).toBe(1);
  });

  it("invokes onToolCall and onResponse callbacks", async () => {
    const onToolCall = vi.fn();
    const onResponse = vi.fn();

    const harness = makeHarness();
    const request = vi.fn()
      .mockResolvedValueOnce(makeFunctionCallResponse([{ name: "bash", args: { command: "ls" } }]))
      .mockResolvedValueOnce(makeResponse());

    await runOpenAIToolLoop(makeParams({
      request,
      harness,
      onToolCall,
      onResponse
    }));

    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "bash", success: true })
    );
    expect(onResponse).toHaveBeenCalled();
  });

  it("swallows callback errors silently", async () => {
    const onResponse = vi.fn().mockRejectedValue(new Error("callback boom"));

    const result = await runOpenAIToolLoop(makeParams({ onResponse }));
    expect(result.reply).toBe("hello");
  });

  it("cleans up sessions on failure", async () => {
    const harness = makeHarness();
    (harness.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: "running",
      sessionId: "bg-session"
    });

    const request = vi.fn()
      .mockResolvedValueOnce(makeFunctionCallResponse([{ name: "bash", args: { command: "sleep 999" } }]))
      .mockRejectedValueOnce(new Error("network failure"));

    await expect(
      runOpenAIToolLoop(makeParams({ request, harness }))
    ).rejects.toThrow();

    expect(harness.context.processManager.terminateSession).toHaveBeenCalledWith(
      "bg-session",
      expect.objectContaining({ removeAfterTerminate: true })
    );
  });

  it("injects steer channel messages into tool loop input", async () => {
    const steerChannel = {
      push: vi.fn(),
      drain: vi.fn().mockReturnValueOnce(["new instruction"]).mockReturnValue([])
    };

    const harness = makeHarness();
    const request = vi.fn()
      .mockResolvedValueOnce(makeFunctionCallResponse([{ name: "bash", args: { command: "ls" } }]))
      .mockResolvedValueOnce(makeResponse());

    await runOpenAIToolLoop(makeParams({ request, harness, steerChannel }));

    // Second request should have steer message in input
    const secondCallBody = request.mock.calls[1][0];
    const hasSteer = secondCallBody.input.some(
      (item: Record<string, unknown>) => item.role === "user" && item.content === "new instruction"
    );
    expect(hasSteer).toBe(true);
  });

  it("handles missing response id for tool continuation", async () => {
    const harness = makeHarness();
    const request = vi.fn().mockResolvedValue({
      output: [{
        type: "function_call",
        call_id: "c1",
        name: "bash",
        arguments: '{"command":"ls"}'
      }]
      // no id field
    });

    await expect(
      runOpenAIToolLoop(makeParams({ request, harness }))
    ).rejects.toThrow("Provider response missing id");
  });

  it("skips malformed function calls", async () => {
    const harness = makeHarness();
    const request = vi.fn()
      .mockResolvedValueOnce({
        id: "resp-1",
        output: [
          { type: "function_call" }, // missing call_id
          { type: "function_call", call_id: "c1" }, // missing name
          { type: "function_call", call_id: "c2", name: "bash", arguments: "invalid json{" } // bad JSON
        ]
      })
      // No valid calls → model returns final response
      .mockResolvedValueOnce(makeResponse({ output_text: "recovered" }));

    // Since all function calls are malformed, extractFunctionCalls returns [], which means
    // the model returned no tool calls → it's the final response from the first call
    await runOpenAIToolLoop(makeParams({ request, harness }));
    // The first response has no output_text, so extractAssistantText returns ""
    // Actually, since calls.length === 0, it tries extractAssistantText on the first response
    // which has no output_text. Our mock extractAssistantText returns "" for that.
    expect(request).toHaveBeenCalledTimes(1);
  });
});
