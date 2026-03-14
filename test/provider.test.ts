import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { ToolExecutionError } from "../src/harness/errors.js";
import type { ToolHarness } from "../src/harness/index.js";
import { createObservabilitySink } from "../src/observability.js";
import { ProviderError } from "../src/provider-error.js";
import { createOpenAIProvider } from "../src/provider.js";
import { makeConfig } from "./helpers.js";

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function makeHarnessMock(): ToolHarness {
  const metrics: ToolHarness["metrics"] = {
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
  };
  return {
    config: {
      defaultCwd: process.cwd(),
      defaultShell: "/bin/bash",
      execTimeoutMs: 1_800_000,
      execYieldMs: 10_000,
      processLogTailLines: 200,
      logPath: ".agent-commander/tool-calls.jsonl",
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000
    },
    context: {
      config: {
        defaultCwd: process.cwd(),
        defaultShell: "/bin/bash",
        execTimeoutMs: 1_800_000,
        execYieldMs: 10_000,
        processLogTailLines: 200,
        logPath: ".agent-commander/tool-calls.jsonl",
        completedSessionRetentionMs: 3_600_000,
        maxCompletedSessions: 500,
        maxOutputChars: 200_000
      },
      processManager: {} as ToolHarness["context"]["processManager"],
      logger: {} as ToolHarness["context"]["logger"],
      metrics,
      ownerId: null
    },
    registry: {} as ToolHarness["registry"],
    metrics,
    execute: vi.fn(async () => ({ ok: true })),
    executeWithOwner: vi.fn(async () => ({ ok: true })),
    exportProviderTools: vi.fn(() => [
      {
        type: "function" as const,
        name: "bash",
        description: "run command",
        parameters: { type: "object", properties: {} }
      }
    ])
  };
}

function makeSseResponse(events: Array<{ event?: string; data: unknown }>): Response {
  const payload = events
    .map((entry) => {
      const lines: string[] = [];
      if (entry.event) {
        lines.push(`event: ${entry.event}`);
      }
      lines.push(`data: ${typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data)}`);
      return `${lines.join("\n")}\n\n`;
    })
    .join("");

  return new Response(payload, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

describe("createOpenAIProvider", () => {
  it("calls Responses API with request-scoped instructions", async () => {
    const logger = makeLogger();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output_text: "hello from provider"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const provider = createOpenAIProvider(makeConfig(), logger, {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const reply = await provider.generateReply({
      chatId: "123",
      conversationId: "conv_1",
      model: "gpt-5.3-codex",
      instructions: "Custom instructions",
      thinkingEffort: "high",
      history: [
        {
          role: "user",
          content: "ping",
          createdAt: new Date().toISOString(),
          senderId: "u1",
          senderName: "Ada"
        }
      ]
    });

    expect(reply).toBe("hello from provider");

    const calls = fetchMock.mock.calls as unknown as Array<Parameters<typeof fetch>>;
    const init = calls[0]?.[1];
    const body = JSON.parse(String(init?.body ?? "")) as {
      model: string;
      instructions: string;
      reasoning: {
        effort: string;
      };
      prompt_cache_key: string;
      prompt_cache_retention: string;
      input: Array<{ type: string; role: string; content: string }>;
      tools: Array<{
        type: string;
        name: string;
        parameters: Record<string, unknown>;
      }>;
    };

    expect(body.model).toBe("gpt-5.3-codex");
    expect(body.instructions).toBe("Custom instructions");
    expect(body.reasoning.effort).toBe("high");
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body.prompt_cache_key).toBe("acmd:123:conv_1");
    expect(body.prompt_cache_retention).toBe("in_memory");
    expect(body.input).toEqual([{ type: "message", role: "user", content: "ping" }]);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);

    for (const tool of body.tools) {
      expect(tool.type).toBe("function");
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters).not.toHaveProperty("$schema");
      expect(tool.parameters).not.toHaveProperty("anyOf");
      expect(tool.parameters).not.toHaveProperty("oneOf");
      expect(tool.parameters).not.toHaveProperty("allOf");
      expect(tool.parameters).not.toHaveProperty("enum");
      expect(tool.parameters).not.toHaveProperty("not");
    }

    const processTool = body.tools.find((tool) => tool.name === "process");
    expect(processTool).toBeDefined();
    const processProps = processTool?.parameters.properties as Record<string, unknown>;
    expect(processTool?.parameters.required).toEqual(["action"]);
    expect((processProps.action as { type?: string }).type).toBe("string");
    expect((processProps.action as { enum?: string[] }).enum).toEqual([
      "list",
      "poll",
      "log",
      "write",
      "kill",
      "clear",
      "remove"
    ]);
  });

  it("retries transient 429 errors and succeeds", async () => {
    const logger = makeLogger();
    const sleepMock = vi.fn(async (_ms: number) => {});
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output_text: "ok after retry" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    const provider = createOpenAIProvider(
      makeConfig({ openai: { maxRetries: 2, retryBaseMs: 100, retryMaxMs: 500 } }),
      logger,
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        sleepImpl: sleepMock,
        randomImpl: () => 0.5
      }
    );

    await expect(
      provider.generateReply({
        chatId: "chat-retry",
        conversationId: "conv_1",
        model: "gpt-4.1-mini",
        history: [],
        instructions: "x",
        thinkingEffort: "medium"
      })
    ).resolves.toBe("ok after retry");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("emits latest usage snapshot from successful responses", async () => {
    const logger = makeLogger();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output_text: "usage-aware",
          usage: {
            input_tokens: 1200,
            output_tokens: 300,
            input_tokens_details: {
              cached_tokens: 800
            },
            output_tokens_details: {
              reasoning_tokens: 90
            }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const onUsage = vi.fn();

    const provider = createOpenAIProvider(makeConfig(), logger, {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    await expect(
      provider.generateReply({
        chatId: "chat-usage",
        conversationId: "conv_1",
        model: "gpt-4.1-mini",
        history: [],
        instructions: "x",
        thinkingEffort: "medium",
        onUsage
      })
    ).resolves.toBe("usage-aware");

    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 1200,
      outputTokens: 300,
      cachedTokens: 800,
      reasoningTokens: 90,
      peakInputTokens: 1200,
      peakOutputTokens: 300,
      peakContextTokens: 1500
    });
  });

  it("aggregates usage snapshots across tool-loop responses", async () => {
    const logger = makeLogger();
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "resp_1",
            output: [
              {
                type: "function_call",
                call_id: "call_1",
                name: "bash",
                arguments: "{\"command\":\"echo hi\"}"
              }
            ],
            usage: {
              input_tokens: 1000,
              output_tokens: 50,
              input_tokens_details: {
                cached_tokens: 700
              },
              output_tokens_details: {
                reasoning_tokens: 20
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "resp_2",
            output_text: "done",
            output: [],
            usage: {
              input_tokens: 800,
              output_tokens: 120,
              input_tokens_details: {
                cached_tokens: 600
              },
              output_tokens_details: {
                reasoning_tokens: 30
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    const onUsage = vi.fn();
    const provider = createOpenAIProvider(makeConfig(), logger, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      harness: makeHarnessMock()
    });

    await expect(
      provider.generateReply({
        chatId: "chat-usage-tool-loop",
        conversationId: "conv_1",
        model: "gpt-4.1-mini",
        history: [],
        instructions: "x",
        thinkingEffort: "medium",
        onUsage
      })
    ).resolves.toBe("done");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 1800,
      outputTokens: 170,
      cachedTokens: 1300,
      reasoningTokens: 50,
      peakInputTokens: 1000,
      peakOutputTokens: 120,
      peakContextTokens: 1050
    });
  });

  it("forwards streamed text deltas through onTextDelta", async () => {
    const logger = makeLogger();
    const fetchMock = vi.fn(async () =>
      makeSseResponse([
        {
          event: "response.output_text.delta",
          data: { type: "response.output_text.delta", delta: "hello " }
        },
        {
          event: "response.output_text.delta",
          data: { type: "response.output_text.delta", delta: "world" }
        },
        {
          event: "response.completed",
          data: {
            type: "response.completed",
            response: { id: "resp_1", output_text: "hello world", output: [] }
          }
        }
      ])
    );

    const onTextDelta = vi.fn();
    const provider = createOpenAIProvider(makeConfig(), logger, {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    await expect(
      provider.generateReply({
        chatId: "chat-stream",
        conversationId: "conv_1",
        model: "gpt-4.1-mini",
        instructions: "x",
        history: [],
        thinkingEffort: "medium",
        onTextDelta
      })
    ).resolves.toBe("hello world");

    expect(onTextDelta).toHaveBeenNthCalledWith(1, "hello ");
    expect(onTextDelta).toHaveBeenNthCalledWith(2, "world");
  });

  it("writes full OpenAI observability events with redacted auth headers", async () => {
    const logger = makeLogger();
    const sleepMock = vi.fn(async (_ms: number) => {});
    const config = makeConfig({ observability: { enabled: true } });
    const observability = createObservabilitySink({
      enabled: true,
      logPath: config.observability.logPath
    });
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output_text: "ok after retry" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    const provider = createOpenAIProvider(config, logger, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: sleepMock,
      randomImpl: () => 0.5,
      observability
    });

    await expect(
      provider.generateReply({
        chatId: "chat-observe",
        conversationId: "conv_1",
        model: "gpt-4.1-mini",
        history: [],
        instructions: "x",
        thinkingEffort: "medium"
      })
    ).resolves.toBe("ok after retry");

    const raw = fs.readFileSync(config.observability.logPath, "utf8");
    expect(raw).not.toContain("openai-key");

    const entries = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const request = entries.find((item) => item.event === "provider.openai.request.started");
    const responses = entries.filter((item) => item.event === "provider.openai.request.completed");
    const retry = entries.find((item) => item.event === "provider.openai.retry.scheduled");

    expect(request).toBeDefined();
    const headers = (request?.headers ?? {}) as Record<string, unknown>;
    expect(headers.authorization).toBe("[REDACTED]");

    expect(responses.length).toBe(2);
    expect((responses[0]?.body as string) ?? "").toContain("rate limited");
    expect((responses[1]?.body as Record<string, unknown>)?.output_text).toBe("ok after retry");
    expect(responses[1]?.stream).toEqual(
      expect.objectContaining({
        deltaCount: 0,
        deltaChars: 0,
        partialOutput: false
      })
    );

    expect(retry).toBeDefined();
    expect(retry?.delayMs).toEqual(expect.any(Number));
  });

  it("does not produce observability file when disabled", async () => {
    const logger = makeLogger();
    const config = makeConfig({ observability: { enabled: false } });
    const observabilityPath = path.join(config.paths.workspaceRoot, "unused-observability.jsonl");
    const observability = createObservabilitySink({
      enabled: false,
      logPath: observabilityPath
    });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output_text: "hello from provider"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const provider = createOpenAIProvider(config, logger, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      observability
    });

    await expect(
      provider.generateReply({
        chatId: "chat-disabled-observe",
        conversationId: "conv_1",
        model: "gpt-4.1-mini",
        instructions: "x",
        history: [],
        thinkingEffort: "medium"
      })
    ).resolves.toBe("hello from provider");

    expect(fs.existsSync(observabilityPath)).toBe(false);
  });

  it("honors Retry-After delay when retrying", async () => {
    const logger = makeLogger();
    const sleepMock = vi.fn(async (_ms: number) => {});
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: {
            "retry-after": "2"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output_text: "ok after retry-after" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    const provider = createOpenAIProvider(
      makeConfig({ openai: { maxRetries: 2, retryBaseMs: 100, retryMaxMs: 5_000 } }),
      logger,
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        sleepImpl: sleepMock,
        randomImpl: () => 0
      }
    );

    await expect(
      provider.generateReply({
        chatId: "chat-retry-after",
        conversationId: "conv_1",
        model: "gpt-4.1-mini",
        history: [],
        instructions: "x",
        thinkingEffort: "medium"
      })
    ).resolves.toBe("ok after retry-after");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(2_000);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("throws typed provider error on non-retryable responses", async () => {
    const logger = makeLogger();
    const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
    const provider = createOpenAIProvider(makeConfig(), logger, {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    await expect(
      provider.generateReply({
        chatId: "123",
        conversationId: "conv_1",
        model: "gpt-4.1-mini",
        history: [],
        instructions: "x",
        thinkingEffort: "medium"
      })
    ).rejects.toMatchObject({
      name: "ProviderError",
      kind: "client_error",
      statusCode: 400,
      attempts: 1
    });
  });

  it("handles tool calls and executes with chat ownership", async () => {
    const logger = makeLogger();
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "resp_1",
            output: [
              {
                type: "function_call",
                call_id: "call_1",
                name: "bash",
                arguments: JSON.stringify({ command: "pwd" })
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: "tool-assisted"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    const harness = makeHarnessMock();
    const onToolCall = vi.fn();
    const provider = createOpenAIProvider(makeConfig(), logger, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      harness
    });

    await expect(
      provider.generateReply({
        chatId: "tool-chat",
        conversationId: "conv_1",
        model: "gpt-4.1-mini",
        history: [],
        instructions: "x",
        thinkingEffort: "medium",
        onToolCall
      })
    ).resolves.toBe("tool-assisted");

    expect(harness.executeWithOwner).toHaveBeenCalledWith(
      "tool-chat",
      "bash",
      { command: "pwd" },
      expect.objectContaining({
        traceId: expect.any(String),
        spanId: expect.any(String)
      })
    );
    expect(onToolCall).toHaveBeenCalledWith({
      tool: "bash",
      args: { command: "pwd" },
      result: { ok: true },
      success: true,
      error: null,
      errorCode: null
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondCall = fetchMock.mock.calls[1] as Parameters<typeof fetch> | undefined;
    const secondBody = JSON.parse(String(secondCall?.[1]?.body ?? "{}")) as {
      input: Array<{
        type: string;
        call_id: string;
        output: string;
      }>;
    };
    const wrappedOutput = secondBody.input[0]?.output ?? "";
    expect(secondBody.input[0]?.type).toBe("function_call_output");
    expect(secondBody.input[0]?.call_id).toBe("call_1");
    expect(wrappedOutput).not.toContain("<tool_call>");
    expect(wrappedOutput).not.toContain("<tool_result");
    expect(JSON.parse(wrappedOutput)).toEqual({
      ok: true,
      summary: "Bash command returned output.",
      data: {
        result: {
          ok: true
        }
      }
    });
  });

  it("treats non-zero bash exits as logical failures while continuing the tool loop", async () => {
    const logger = makeLogger();
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "resp_1",
            output: [
              {
                type: "function_call",
                call_id: "call_1",
                name: "bash",
                arguments: JSON.stringify({ command: "grep missing" })
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: "handled non-zero exit"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    const harness = makeHarnessMock();
    vi.mocked(harness.executeWithOwner).mockResolvedValueOnce({
      status: "completed",
      sessionId: "proc_123",
      exitCode: 2,
      stdout: "",
      stderr: "grep: missing pattern",
      combined: "grep: missing pattern",
      durationMs: 11,
      truncatedStdoutChars: 0,
      truncatedStderrChars: 0,
      truncatedCombinedChars: 0
    });
    const onToolCall = vi.fn();

    const provider = createOpenAIProvider(makeConfig(), logger, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      harness
    });

    await expect(
      provider.generateReply({
        chatId: "tool-chat",
        conversationId: "conv_1",
        model: "gpt-4.1-mini",
        history: [],
        instructions: "x",
        thinkingEffort: "medium",
        onToolCall
      })
    ).resolves.toBe("handled non-zero exit");

    expect(onToolCall).toHaveBeenCalledWith({
      tool: "bash",
      args: { command: "grep missing" },
      result: {
        status: "completed",
        sessionId: "proc_123",
        exitCode: 2,
        stdout: "",
        stderr: "grep: missing pattern",
        combined: "grep: missing pattern",
        durationMs: 11,
        truncatedStdoutChars: 0,
        truncatedStderrChars: 0,
        truncatedCombinedChars: 0
      },
      success: false,
      error: "Command exited with status 2",
      errorCode: null
    });

    const secondCall = fetchMock.mock.calls[1] as Parameters<typeof fetch> | undefined;
    const secondBody = JSON.parse(String(secondCall?.[1]?.body ?? "{}")) as {
      input: Array<{
        type: string;
        call_id: string;
        output: string;
      }>;
    };

    expect(secondBody.input[0]?.type).toBe("function_call_output");
    expect(secondBody.input[0]?.call_id).toBe("call_1");
    expect(JSON.parse(secondBody.input[0]?.output ?? "{}")).toEqual({
      ok: false,
      summary: "Bash command failed with exit code 2.",
      error: {
        code: "NON_ZERO_EXIT",
        message: "Command exited with status 2",
        details: {
          stderr: "grep: missing pattern"
        }
      },
      meta: {
        exit_code: 2,
        duration_ms: 11
      }
    });
  });

  it("reports failed tool calls and continues the tool loop", async () => {
    const logger = makeLogger();
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "resp_1",
            output: [
              {
                type: "function_call",
                call_id: "call_1",
                name: "bash",
                arguments: JSON.stringify({ command: "pwd" })
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: "handled tool failure"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    const harness = makeHarnessMock();
    vi.mocked(harness.executeWithOwner).mockRejectedValueOnce(new Error("tool failed"));
    const onToolCall = vi.fn();

    const provider = createOpenAIProvider(makeConfig(), logger, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      harness
    });

    await expect(
      provider.generateReply({
        chatId: "tool-chat",
        conversationId: "conv_1",
        model: "gpt-4.1-mini",
        history: [],
        instructions: "x",
        thinkingEffort: "medium",
        onToolCall
      })
    ).resolves.toBe("handled tool failure");

    expect(onToolCall).toHaveBeenCalledWith({
      tool: "bash",
      args: { command: "pwd" },
      result: {
        ok: false,
        error: "tool failed",
        errorCode: "TOOL_EXECUTION_ERROR",
        retryable: false,
        hints: []
      },
      success: false,
      error: "tool failed",
      errorCode: "TOOL_EXECUTION_ERROR"
    });

    const secondCall = fetchMock.mock.calls[1] as Parameters<typeof fetch> | undefined;
    const secondBody = JSON.parse(String(secondCall?.[1]?.body ?? "{}")) as {
      input: Array<{
        type: string;
        call_id: string;
        output: string;
      }>;
    };

    expect(secondBody.input[0]?.type).toBe("function_call_output");
    expect(secondBody.input[0]?.call_id).toBe("call_1");
    const failedOutput = secondBody.input[0]?.output ?? "";
    expect(failedOutput).not.toContain("<tool_call>");
    expect(failedOutput).not.toContain("<tool_result");
    expect(JSON.parse(failedOutput)).toEqual({
      ok: false,
      summary: "Bash failed.",
      error: {
        code: "TOOL_EXECUTION_ERROR",
        message: "tool failed"
      }
    });
  });

  it("wraps unexpected failures in ProviderError", async () => {
    const logger = makeLogger();
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });

    const provider = createOpenAIProvider(makeConfig({ openai: { maxRetries: 0 } }), logger, {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    await expect(
      provider.generateReply({
        chatId: "x",
        conversationId: "conv_1",
        model: "gpt-4.1-mini",
        history: [],
        instructions: "x",
        thinkingEffort: "medium"
      })
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("interrupts in-flight tool workflows when abort signal is triggered", async () => {
    const logger = makeLogger();
    const fetchMock = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const signal = init?.signal as AbortSignal | undefined;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const provider = createOpenAIProvider(makeConfig({ openai: { maxRetries: 0 } }), logger, {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const abortController = new AbortController();
    const generation = provider.generateReply({
      chatId: "chat-interrupt",
      conversationId: "conv_1",
      model: "gpt-4.1-mini",
      history: [],
      instructions: "x",
      thinkingEffort: "medium",
      abortSignal: abortController.signal
    });

    abortController.abort();
    await expect(generation).rejects.toMatchObject({
      name: "ToolWorkflowAbortError",
      payload: {
        errorCode: "WORKFLOW_INTERRUPTED"
      }
    });
  });

  it("enforces workflow timeout budget", async () => {
    const logger = makeLogger();
    const fetchMock = vi.fn(async () => {
      await sleep(25);
      return new Response(
        JSON.stringify({
          output_text: "late"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const provider = createOpenAIProvider(
      makeConfig({
        runtime: {
          toolWorkflowTimeoutMs: 10
        }
      }),
      logger,
      {
        fetchImpl: fetchMock as unknown as typeof fetch
      }
    );

    await expect(
      provider.generateReply({
        chatId: "chat-timeout",
        conversationId: "conv_1",
        model: "gpt-4.1-mini",
        history: [],
        instructions: "x",
        thinkingEffort: "medium"
      })
    ).rejects.toMatchObject({
      payload: {
        errorCode: "WORKFLOW_TIMEOUT"
      }
    });
  });

  it("breaks repeated near-identical tool failures", async () => {
    const logger = makeLogger();
    const fetchMock = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>().mockImplementation(async () =>
        new Response(
          JSON.stringify({
            id: "resp_repeat",
            output: [
              {
                type: "function_call",
                call_id: "call_repeat",
                name: "bash",
                arguments: JSON.stringify({ command: "pwd" })
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    const harness = makeHarnessMock();
    vi.mocked(harness.executeWithOwner).mockRejectedValue(
      new ToolExecutionError({
        ok: false,
        error: "invalid command",
        errorCode: "TOOL_VALIDATION_ERROR",
        retryable: true,
        hints: ["fix command"],
        expected: {
          required: ["command"],
          optional: []
        }
      })
    );
    const provider = createOpenAIProvider(
      makeConfig({
        runtime: {
          toolFailureBreakerThreshold: 2,
          toolLoopMaxSteps: 20
        }
      }),
      logger,
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        harness
      }
    );

    await expect(
      provider.generateReply({
        chatId: "chat-breaker",
        conversationId: "conv_1",
        model: "gpt-4.1-mini",
        history: [],
        instructions: "x",
        thinkingEffort: "medium"
      })
    ).rejects.toMatchObject({
      payload: {
        errorCode: "TOOL_LOOP_BREAKER"
      }
    });
  });

  it("emits heartbeat tool progress while long tool calls are running", async () => {
    const logger = makeLogger();
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "resp_1",
            output: [
              {
                type: "function_call",
                call_id: "call_1",
                name: "bash",
                arguments: JSON.stringify({ command: "sleep 1" })
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: "done"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    const harness = makeHarnessMock();
    vi.mocked(harness.executeWithOwner).mockImplementation(async () => {
      await sleep(140);
      return { status: "completed", exitCode: 0, combined: "ok" };
    });

    const onToolProgress = vi.fn();
    const provider = createOpenAIProvider(
      makeConfig({
        runtime: {
          toolHeartbeatIntervalMs: 50,
          toolCommandTimeoutMs: 1000,
          toolWorkflowTimeoutMs: 2000
        }
      }),
      logger,
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        harness
      }
    );

    await expect(
      provider.generateReply({
        chatId: "chat-heartbeat",
        conversationId: "conv_1",
        model: "gpt-4.1-mini",
        history: [],
        instructions: "x",
        thinkingEffort: "medium",
        onToolProgress
      })
    ).resolves.toBe("done");

    const heartbeatCalls = onToolProgress.mock.calls.filter(
      (call) => (call[0] as { type?: string }).type === "heartbeat"
    );
    expect(heartbeatCalls.length).toBeGreaterThan(0);
  });
});
