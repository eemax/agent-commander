import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeLifecycleHooks } from "../src/runtime/bootstrap.js";
import { createTempDir } from "./helpers.js";

const createToolHarnessMock = vi.fn();
const createOpenAIProviderMock = vi.fn();
const createMessageRouterMock = vi.fn();
const createConversationStoreMock = vi.fn();
const createTelegramBotMock = vi.fn();
const createWorkspaceManagerMock = vi.fn();

vi.mock("../src/harness/index.js", () => ({
  createToolHarness: (...args: unknown[]) => createToolHarnessMock(...args)
}));

vi.mock("../src/provider.js", () => ({
  createOpenAIProvider: (...args: unknown[]) => createOpenAIProviderMock(...args)
}));

vi.mock("../src/routing.js", () => ({
  createMessageRouter: (...args: unknown[]) => createMessageRouterMock(...args)
}));

vi.mock("../src/state/conversations.js", () => ({
  createConversationStore: (...args: unknown[]) => createConversationStoreMock(...args)
}));

vi.mock("../src/telegram/bot.js", () => ({
  createTelegramBot: (...args: unknown[]) => createTelegramBotMock(...args)
}));

vi.mock("../src/workspace.js", () => ({
  createWorkspaceManager: (...args: unknown[]) => createWorkspaceManagerMock(...args)
}));

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function setupRuntimeRepo(): string {
  const root = createTempDir("acmd-runtime-bootstrap-");
  writeJson(path.join(root, "config", "config.json"), {
    telegram: {},
    openai: {},
    runtime: {},
    tools: {},
    paths: {},
    observability: {}
  });
  fs.mkdirSync(path.join(root, ".agent-commander", "ysera"), { recursive: true });
  writeJson(path.join(root, "config", "agents.json"), {
    agents: [
      { id: "default", aliases: ["main"], config_dir: ".", telegram_allowlist: ["1001"] },
      { id: "ysera", aliases: ["ysera"], config_dir: ".agent-commander/ysera", telegram_allowlist: ["1001"] }
    ]
  });
  fs.writeFileSync(
    path.join(root, ".env"),
    [
      "DEFAULT_TELEGRAM_BOT_TOKEN=tg-default",
      "DEFAULT_OPENAI_API_KEY=oa-default",
      "YSERA_TELEGRAM_BOT_TOKEN=tg-ysera",
      "YSERA_OPENAI_API_KEY=oa-ysera"
    ].join("\n"),
    "utf8"
  );
  return root;
}

describe("runtime bootstrap lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    createToolHarnessMock.mockReset();
    createOpenAIProviderMock.mockReset();
    createMessageRouterMock.mockReset();
    createConversationStoreMock.mockReset();
    createTelegramBotMock.mockReset();
    createWorkspaceManagerMock.mockReset();

    createToolHarnessMock.mockImplementation(() => ({
      config: {
        defaultCwd: process.cwd(),
        defaultShell: "/bin/bash",
        execTimeoutMs: 1_800_000,
        execYieldMs: 10_000,
        processLogTailLines: 200,
        logPath: ".agent-commander/tool-calls.jsonl",
        completedSessionRetentionMs: 900_000,
        maxCompletedSessions: 50,
        maxOutputChars: 200_000
      },
      context: {} as never,
      registry: {} as never,
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
      execute: vi.fn(),
      executeWithOwner: vi.fn(),
      exportProviderTools: vi.fn(() => []),
      shutdown: vi.fn(async () => {})
    }));
    createOpenAIProviderMock.mockReturnValue({});
    createMessageRouterMock.mockReturnValue({
      handleIncomingMessage: vi.fn(),
      handleIncomingCallbackQuery: vi.fn()
    });
    createConversationStoreMock.mockReturnValue({
      getWorkingDirectory: vi.fn(async () => process.cwd()),
      getActiveWebSearchModelOverride: vi.fn(async () => null),
      getAuthMode: vi.fn(async () => "api"),
      getTransportMode: vi.fn(async () => "http")
    });
    createWorkspaceManagerMock.mockReturnValue({
      bootstrap: vi.fn(async () => {}),
      getSnapshot: vi.fn(() => ({ commands: [] }))
    });
  });

  it("calls onReady only after every bot reports polling active", async () => {
    const root = setupRuntimeRepo();
    const events: string[] = [];
    const stopResolvers = new Map<string, () => void>();
    const tokenDelay = new Map([
      ["tg-default", 10],
      ["tg-ysera", 30]
    ]);

    createTelegramBotMock.mockImplementation((params: { token: string }) => ({
      bot: {
        api: {
          getMe: async () => ({ id: params.token, username: params.token })
        },
        start: ({ onStart }: { onStart?: () => void }) =>
          new Promise<void>((resolve) => {
            stopResolvers.set(params.token, resolve);
            setTimeout(() => {
              events.push(`start:${params.token}`);
              onStart?.();
            }, tokenDelay.get(params.token) ?? 0);
          }),
        stop: () => {
          events.push(`stop:${params.token}`);
          stopResolvers.get(params.token)?.();
        }
      },
      syncCommands: async () => {}
    }));

    const { startRuntime } = await import("../src/runtime/bootstrap.js");

    const runtimePromise = startRuntime(root, {
      onReady: async () => {
        events.push("ready");
        process.emit("SIGTERM");
      }
    });

    await runtimePromise;
    expect(events).toEqual(["start:tg-default", "start:tg-ysera", "ready", "stop:tg-default", "stop:tg-ysera"]);
  });

  it("reports startup errors through the lifecycle hook", async () => {
    const root = setupRuntimeRepo();
    const startupError = new Error("telegram start failed");

    createTelegramBotMock.mockImplementation((params: { token: string }) => ({
      bot: {
        api: {
          getMe: async () => ({ id: params.token, username: params.token })
        },
        start: () => Promise.reject(startupError),
        stop: vi.fn()
      },
      syncCommands: async () => {}
    }));

    const { startRuntime } = await import("../src/runtime/bootstrap.js");
    const hooks: RuntimeLifecycleHooks = {
      onStartupError: vi.fn(async () => {})
    };

    await expect(startRuntime(root, hooks)).rejects.toThrow("telegram start failed");
    expect(hooks.onStartupError).toHaveBeenCalledWith(startupError);
  });

  it("shuts runtimes down when the ready hook fails after bots are live", async () => {
    const root = setupRuntimeRepo();
    const events: string[] = [];
    const stopResolvers = new Map<string, () => void>();
    const readyError = new Error("ready hook failed");

    createToolHarnessMock.mockImplementation(() => ({
      config: {
        defaultCwd: process.cwd(),
        defaultShell: "/bin/bash",
        execTimeoutMs: 1_800_000,
        execYieldMs: 10_000,
        processLogTailLines: 200,
        logPath: ".agent-commander/tool-calls.jsonl",
        completedSessionRetentionMs: 900_000,
        maxCompletedSessions: 50,
        maxOutputChars: 200_000
      },
      context: {} as never,
      registry: {} as never,
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
      execute: vi.fn(),
      executeWithOwner: vi.fn(),
      exportProviderTools: vi.fn(() => []),
      shutdown: vi.fn(async () => {
        events.push("harness-shutdown");
      })
    }));

    createTelegramBotMock.mockImplementation((params: { token: string }) => ({
      bot: {
        api: {
          getMe: async () => ({ id: params.token, username: params.token })
        },
        start: ({ onStart }: { onStart?: () => void }) =>
          new Promise<void>((resolve) => {
            stopResolvers.set(params.token, resolve);
            setTimeout(() => {
              events.push(`start:${params.token}`);
              onStart?.();
            }, 0);
          }),
        stop: () => {
          events.push(`bot-stop:${params.token}`);
          stopResolvers.get(params.token)?.();
        }
      },
      syncCommands: async () => {}
    }));

    const { startRuntime } = await import("../src/runtime/bootstrap.js");
    const hooks: RuntimeLifecycleHooks = {
      onReady: vi.fn(async () => {
        throw readyError;
      }),
      onStartupError: vi.fn(async () => {})
    };

    await expect(startRuntime(root, hooks)).rejects.toThrow("ready hook failed");
    expect(events).toContain("harness-shutdown");
    expect(events.some((entry) => entry.startsWith("bot-stop:"))).toBe(true);
    expect(hooks.onStartupError).toHaveBeenCalledWith(readyError);
  });

  it("shuts harnesses down before stopping bots", async () => {
    const root = setupRuntimeRepo();
    const events: string[] = [];
    const stopResolvers = new Map<string, () => void>();

    createToolHarnessMock.mockImplementation(() => ({
      config: {
        defaultCwd: process.cwd(),
        defaultShell: "/bin/bash",
        execTimeoutMs: 1_800_000,
        execYieldMs: 10_000,
        processLogTailLines: 200,
        logPath: ".agent-commander/tool-calls.jsonl",
        completedSessionRetentionMs: 900_000,
        maxCompletedSessions: 50,
        maxOutputChars: 200_000
      },
      context: {} as never,
      registry: {} as never,
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
      execute: vi.fn(),
      executeWithOwner: vi.fn(),
      exportProviderTools: vi.fn(() => []),
      shutdown: vi.fn(async () => {
        events.push("harness-shutdown");
      })
    }));

    createTelegramBotMock.mockImplementation((params: { token: string }) => ({
      bot: {
        api: {
          getMe: async () => ({ id: params.token, username: params.token })
        },
        start: ({ onStart }: { onStart?: () => void }) =>
          new Promise<void>((resolve) => {
            stopResolvers.set(params.token, resolve);
            setTimeout(() => {
              onStart?.();
            }, 0);
          }),
        stop: () => {
          events.push(`bot-stop:${params.token}`);
          stopResolvers.get(params.token)?.();
        }
      },
      syncCommands: async () => {}
    }));

    const { startRuntime } = await import("../src/runtime/bootstrap.js");

    const runtimePromise = startRuntime(root, {
      onReady: async () => {
        process.emit("SIGTERM");
      }
    });

    await runtimePromise;
    expect(events[0]).toBe("harness-shutdown");
    expect(events.some((entry) => entry.startsWith("bot-stop:"))).toBe(true);
    const firstBotStopIndex = events.findIndex((entry) => entry.startsWith("bot-stop:"));
    expect(firstBotStopIndex).toBeGreaterThan(0);
  });
});
