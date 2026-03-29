import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createToolHarness } from "../src/harness/index.js";
import { createObservabilitySink } from "../src/observability.js";
import { createOpenAIProvider } from "../src/provider.js";
import { createAuthModeRegistry } from "../src/provider/auth-mode-registry.js";
import { createMessageRouter } from "../src/routing.js";
import { createConversationStore } from "../src/state/conversations.js";
import { dispatchTelegramTextMessage } from "../src/telegram/bot.js";
import { createWorkspaceManager } from "../src/workspace.js";
import { makeConfig } from "./helpers.js";

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

describe("observability trace correlation", () => {
  it("keeps one traceId across telegram inbound/outbound, routing, provider, and tool execution", async () => {
    const config = makeConfig({
      observability: { enabled: true },
      access: { allowedSenderIds: new Set(["22"]) }
    });
    const logger = makeLogger();
    const observability = createObservabilitySink({
      enabled: true,
      logPath: config.observability.logPath
    });

    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const harness = createToolHarness(
      {
        defaultCwd: config.tools.defaultCwd,
        defaultShell: config.tools.defaultShell,
        execTimeoutMs: config.tools.execTimeoutMs,
        execYieldMs: config.tools.execYieldMs,
        processLogTailLines: config.tools.processLogTailLines,
        logPath: config.tools.logPath,
        logMaxLines: config.tools.logMaxLines,
        completedSessionRetentionMs: config.tools.completedSessionRetentionMs,
        maxCompletedSessions: config.tools.maxCompletedSessions,
        maxOutputChars: config.tools.maxOutputChars
      },
      { observability }
    );

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
            id: "resp_2",
            output_text: "all good",
            output: []
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    const provider = createOpenAIProvider(config, logger, {
      authModeRegistry: createAuthModeRegistry({ apiKey: "sk-test", codexAuth: null }),
      harness,
      observability,
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const router = createMessageRouter({
      logger,
      provider,
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        observability
      }),
      workspace,
      harness,
      observability
    });

    const result = await dispatchTelegramTextMessage({
      message: {
        chatId: "123",
        messageId: "11",
        senderId: "22",
        senderName: "Tester",
        text: "hello",
        receivedAt: new Date().toISOString()
      },
      handleMessage: router.handleIncomingMessage,
      sendReply: async () => {},
      observability
    });
    expect(result.type).toBe("reply");

    const entries = fs
      .readFileSync(config.observability.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const requiredEvents = [
      "telegram.inbound.received",
      "routing.gatekeeping.checked",
      "routing.decision.made",
      "provider.openai.request.started",
      "provider.openai.request.completed",
      "tool.execution.completed",
      "telegram.outbound.reply.sent"
    ];
    for (const event of requiredEvents) {
      expect(entries.some((entry) => entry.event === event)).toBe(true);
    }

    const relevant = entries.filter((entry) => requiredEvents.includes(String(entry.event)));
    const traceIds = new Set(
      relevant.map((entry) => (entry.trace as { traceId?: string } | undefined)?.traceId).filter((value) => value)
    );
    expect(traceIds.size).toBe(1);

    const inbound = relevant.find((entry) => entry.event === "telegram.inbound.received");
    expect((inbound?.trace as { parentSpanId?: string | null } | undefined)?.parentSpanId).toBeNull();

    const childEvents = relevant.filter((entry) => entry.event !== "telegram.inbound.received");
    for (const entry of childEvents) {
      expect((entry.trace as { parentSpanId?: string | null }).parentSpanId).toEqual(expect.any(String));
    }

  });
});
