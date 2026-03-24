import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { ToolHarness } from "../src/harness/index.js";
import { createObservabilitySink } from "../src/observability.js";
import { ProviderError } from "../src/provider-error.js";
import { createMessageRouter } from "../src/routing.js";
import { createConversationStore } from "../src/state/conversations.js";
import type { NormalizedTelegramCallbackQuery, NormalizedTelegramMessage, Provider } from "../src/types.js";
import { createWorkspaceManager } from "../src/workspace.js";
import { makeConfig } from "./helpers.js";

function sampleIncoming(overrides: Partial<NormalizedTelegramMessage> = {}): NormalizedTelegramMessage {
  return {
    chatId: "chat-1",
    messageId: "msg-1",
    senderId: "user-1",
    senderName: "Ada",
    text: "hello",
    receivedAt: new Date().toISOString(),
    ...overrides
  };
}

function sampleCallback(overrides: Partial<NormalizedTelegramCallbackQuery> = {}): NormalizedTelegramCallbackQuery {
  return {
    callbackQueryId: "cb-1",
    chatId: "chat-1",
    messageId: "msg-callback",
    senderId: "user-1",
    senderName: "Ada",
    data: "invalid",
    receivedAt: new Date().toISOString(),
    ...overrides
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
      processManager: {
        listSessionsByOwner: vi.fn(() => []),
        killRunningSessionsByOwner: vi.fn(() => ({ killed: 0, sessionIds: [] })),
        getHealth: vi.fn(() => ({
          totalSessions: 0,
          runningSessions: 0,
          completedSessions: 0,
          truncatedStdoutChars: 0,
          truncatedStderrChars: 0,
          truncatedCombinedChars: 0
        }))
      } as unknown as ToolHarness["context"]["processManager"],
      logger: {} as ToolHarness["context"]["logger"],
      metrics,
      ownerId: null
    },
    registry: {} as ToolHarness["registry"],
    metrics,
    execute: vi.fn(async () => ({ ok: true })),
    executeWithOwner: vi.fn(async () => ({ status: "completed", exitCode: 0, combined: "ok" })),
    exportProviderTools: vi.fn(() => [
      {
        type: "function" as const,
        name: "bash",
        description: "Run command",
        parameters: { type: "object", properties: {} }
      }
    ])
  };
}

describe("createMessageRouter", () => {
  it("blocks unauthorized senders", async () => {
    const config = makeConfig({ access: { allowedSenderIds: new Set(["allowed-user"]) } });
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async () => "should-not-run")
    };

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath,
        defaultWorkingDirectory: config.tools.defaultCwd
      }),
      workspace,
      harness: makeHarnessMock()
    });

    const result = await router.handleIncomingMessage(sampleIncoming({ senderId: "user-1" }));
    expect(result.type).toBe("unauthorized");
    expect(provider.generateReply).not.toHaveBeenCalled();
  });

  it("injects bootstrap context on the first conversation turn", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async () => "assistant-reply")
    };

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath,
        defaultWorkingDirectory: config.tools.defaultCwd
      }),
      workspace,
      harness: makeHarnessMock()
    });

    const result = await router.handleIncomingMessage(sampleIncoming({ text: "hello" }));
    expect(result).toEqual({ type: "reply", text: "assistant-reply", origin: "assistant" });

    const call = vi.mocked(provider.generateReply).mock.calls[0]?.[0];
    expect(call?.history.map((item) => item.content)).toEqual(["hello"]);
    expect(call?.instructions).toContain("<operating_contracts>");
    expect(call?.instructions).toContain('<contract name="SOUL.md" kind="behavior_spec">');
    expect(call?.instructions).toContain('<contract name="AGENTS.md" kind="agent_spec">');
    expect(call?.instructions).toContain("<available_skills>");
    expect(call?.instructions).not.toContain("<session>");
    expect(call?.instructions).not.toContain("<environment>");
    expect(call?.instructions).not.toContain("<reference_documents>");
    expect(call?.instructions).not.toContain("<context>");
    expect(call?.instructions).not.toContain("<available_tools>");
    expect(call?.instructions).not.toContain("<base_instructions>");

    const snapshotChatDir = path.join(config.paths.contextSnapshotsDir, encodeURIComponent("chat-1"));
    const snapshots = fs.readdirSync(snapshotChatDir);
    expect(snapshots.filter((name) => name.endsWith(".json")).length).toBe(0);
    expect(snapshots.filter((name) => name.endsWith(".md")).length).toBe(1);
  });

  it("passes streaming sink callbacks through to provider", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async (request) => {
        await request.onTextDelta?.("hi");
        return "assistant-reply";
      })
    };

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath,
        defaultWorkingDirectory: config.tools.defaultCwd
      }),
      workspace,
      harness: makeHarnessMock()
    });

    const onTextDelta = vi.fn();
    const result = await router.handleIncomingMessage(sampleIncoming({ text: "hello" }), {
      onTextDelta
    });

    expect(result).toEqual({ type: "reply", text: "assistant-reply", origin: "assistant" });
    expect(onTextDelta).toHaveBeenCalledWith("hi");
  });

  it("handles /new by immediately creating a new conversation", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async () => "ok")
    };

    const conversations = createConversationStore({
      conversationsDir: config.paths.conversationsDir,
      stashedConversationsPath: config.paths.stashedConversationsPath,
      defaultWorkingDirectory: config.tools.defaultCwd
    });

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations,
      workspace,
      harness: makeHarnessMock()
    });

    await router.handleIncomingMessage(sampleIncoming({ text: "hello" }));
    const firstConversation = await conversations.getActiveConversation("chat-1");

    const result = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-2", text: "/new" }));
    expect(result.type).toBe("reply");
    if (result.type !== "reply") {
      return;
    }
    expect(result.text).toContain("started new conversation");
    expect(result.text).toContain("conversation: conv...");
    expect(result.text).toContain("archived: conv...");
    expect(result.text).toContain("model:");
    expect(result.text).toContain("transport:");

    const secondConversation = await conversations.getActiveConversation("chat-1");
    expect(secondConversation).not.toBe(firstConversation);
  });

  it("handles /new from through inline selection callback", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async () => "ok")
    };

    const conversations = createConversationStore({
      conversationsDir: config.paths.conversationsDir,
      stashedConversationsPath: config.paths.stashedConversationsPath,
      defaultWorkingDirectory: config.tools.defaultCwd
    });

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations,
      workspace,
      harness: makeHarnessMock()
    });

    await router.handleIncomingMessage(sampleIncoming({ text: "hello" }));
    const firstConversation = await conversations.getActiveConversation("chat-1");

    const result = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-2", text: "/new from" }));
    expect(result.type).toBe("reply");
    if (result.type !== "reply") {
      return;
    }
    expect(result.inlineKeyboard?.length).toBeGreaterThan(0);
    const newCallbackData = result.inlineKeyboard?.flat().find((button) => button.text === "New")?.callbackData;
    expect(newCallbackData).toBeTruthy();

    const afterCommandConversation = await conversations.getActiveConversation("chat-1");
    expect(afterCommandConversation).toBe(firstConversation);

    const callbackResult = await router.handleIncomingCallbackQuery(
      sampleCallback({
        callbackQueryId: "cb-2",
        messageId: "msg-2",
        data: newCallbackData ?? "missing"
      })
    );
    expect(callbackResult.type).toBe("reply");
    if (callbackResult.type === "reply") {
      expect(callbackResult.text).toContain("conversation: conv...");
      expect(callbackResult.text).toContain("archived: conv...");
      expect(callbackResult.text).toContain("model:");
    }

    const secondConversation = await conversations.getActiveConversation("chat-1");
    expect(secondConversation).not.toBe(firstConversation);
  });

  it("requires /stash to include a name", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    const result = await router.handleIncomingMessage(sampleIncoming({ text: "/stash" }));
    expect(result).toEqual({ type: "reply", text: "Usage: /stash <name>" });
  });

  it("lists stashes with /stash list when stash pool is empty", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    const result = await router.handleIncomingMessage(sampleIncoming({ text: "/stash list" }));
    expect(result).toEqual({
      type: "reply",
      text: "No stashes found. Use /stash <name> to create one."
    });
  });

  it("shows alias, id tail, and relative age for /stash list", async () => {
    vi.useFakeTimers();
    try {
      const config = makeConfig();
      const workspace = createWorkspaceManager(config);
      await workspace.bootstrap();

      const conversations = createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      });

      const router = createMessageRouter({
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        provider: { generateReply: vi.fn(async () => "unused") },
        config,
        conversations,
        workspace,
        harness: makeHarnessMock()
      });

      vi.setSystemTime(new Date("2026-03-13T10:58:00.000Z"));
      await conversations.ensureActiveConversation("chat-1");
      const alphaConversation = await conversations.getActiveConversation("chat-1");
      await conversations.completeStashSelection("chat-1", "alpha", { type: "new" }, "manual_stash_command");

      vi.setSystemTime(new Date("2026-03-13T11:59:00.000Z"));
      const betaConversation = await conversations.getActiveConversation("chat-1");
      await conversations.completeStashSelection("chat-1", "beta", { type: "new" }, "manual_stash_command");

      vi.setSystemTime(new Date("2026-03-13T12:00:00.000Z"));
      const result = await router.handleIncomingMessage(sampleIncoming({ text: "/stash list" }));
      expect(result.type).toBe("reply");
      if (result.type !== "reply") {
        return;
      }

      expect(result.inlineKeyboard).toBeUndefined();
      expect(result.text).toContain("stashes:");
      expect(alphaConversation).toBeTruthy();
      expect(betaConversation).toBeTruthy();
      if (!alphaConversation || !betaConversation) {
        return;
      }
      expect(result.text).toContain(`- beta · ${betaConversation.slice(-4)} · 1 minute ago`);
      expect(result.text).toContain(`- alpha · ${alphaConversation.slice(-4)} · 1h 2m ago`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles /stash selection by stashing current conversation and switching", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const conversations = createConversationStore({
      conversationsDir: config.paths.conversationsDir,
      stashedConversationsPath: config.paths.stashedConversationsPath,
      defaultWorkingDirectory: config.tools.defaultCwd
    });

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "ok") },
      config,
      conversations,
      workspace,
      harness: makeHarnessMock()
    });

    await router.handleIncomingMessage(sampleIncoming({ text: "hello" }));
    const firstConversation = await conversations.getActiveConversation("chat-1");

    const stashMenu = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-2", text: "/stash focus" }));
    expect(stashMenu.type).toBe("reply");
    if (stashMenu.type !== "reply") {
      return;
    }
    const newCallbackData = stashMenu.inlineKeyboard?.flat().find((button) => button.text === "New")?.callbackData;
    expect(newCallbackData).toBeTruthy();

    const callback = await router.handleIncomingCallbackQuery(
      sampleCallback({ callbackQueryId: "cb-10", messageId: "msg-2", data: newCallbackData ?? "missing" })
    );
    expect(callback.type).toBe("reply");
    if (callback.type === "reply") {
      expect(callback.text).toContain("stashed: conv...");
      expect(callback.text).toContain("conversation: conv...");
    }

    const secondConversation = await conversations.getActiveConversation("chat-1");
    expect(secondConversation).not.toBe(firstConversation);
    const stashes = await conversations.listStashedConversations("chat-1");
    expect(stashes[0]?.alias).toBe("focus");
    expect(stashes[0]?.conversationId).toBe(firstConversation);
  });

  it("rejects stale menu callbacks after first use", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    const menu = await router.handleIncomingMessage(sampleIncoming({ text: "/new from", messageId: "msg-2" }));
    expect(menu.type).toBe("reply");
    if (menu.type !== "reply") {
      return;
    }

    const callbackData = menu.inlineKeyboard?.flat().find((button) => button.text === "New")?.callbackData;
    expect(callbackData).toBeTruthy();

    const first = await router.handleIncomingCallbackQuery(
      sampleCallback({ callbackQueryId: "cb-20", messageId: "msg-2", data: callbackData ?? "missing" })
    );
    expect(first.type).toBe("reply");

    const second = await router.handleIncomingCallbackQuery(
      sampleCallback({ callbackQueryId: "cb-21", messageId: "msg-2", data: callbackData ?? "missing" })
    );
    expect(second).toEqual({ type: "reply", text: "That menu is expired. Run /new or /stash again." });
  });

  it("paginates conversation menus and handles Next callbacks", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const conversations = createConversationStore({
      conversationsDir: config.paths.conversationsDir,
      stashedConversationsPath: config.paths.stashedConversationsPath,
      defaultWorkingDirectory: config.tools.defaultCwd
    });

    for (let index = 1; index <= 7; index += 1) {
      await conversations.ensureActiveConversation("chat-1");
      await conversations.completeStashSelection(
        "chat-1",
        `stash-${index}`,
        { type: "new" },
        "manual_stash_command"
      );
    }

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations,
      workspace,
      harness: makeHarnessMock()
    });

    const firstMenu = await router.handleIncomingMessage(sampleIncoming({ text: "/new from", messageId: "msg-2" }));
    expect(firstMenu.type).toBe("reply");
    if (firstMenu.type !== "reply") {
      return;
    }
    expect(firstMenu.text).toContain("menu page: 1/2");
    const stashButtons = firstMenu.inlineKeyboard?.flat().filter((button) => button.text.includes(" · ")) ?? [];
    expect(stashButtons.length).toBeGreaterThan(0);
    for (const button of stashButtons) {
      const suffix = button.text.split(" · ")[1] ?? "";
      expect(suffix.length).toBe(4);
    }
    const nextData = firstMenu.inlineKeyboard?.flat().find((button) => button.text === "Next")?.callbackData;
    expect(nextData).toBeTruthy();

    const secondMenu = await router.handleIncomingCallbackQuery(
      sampleCallback({ callbackQueryId: "cb-22", messageId: "msg-2", data: nextData ?? "missing" })
    );
    expect(secondMenu.type).toBe("reply");
    if (secondMenu.type === "reply") {
      expect(secondMenu.text).toContain("menu page: 2/2");
      expect(secondMenu.inlineKeyboard?.flat().some((button) => button.text === "Prev")).toBe(true);
    }
  });

  it("routes /bash through harness ownership context", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const harness = makeHarnessMock();

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath,
        defaultWorkingDirectory: config.tools.defaultCwd
      }),
      workspace,
      harness
    });

    const result = await router.handleIncomingMessage(sampleIncoming({ text: "/bash echo hi" }));
    expect(result.type).toBe("reply");
    expect(harness.executeWithOwner).toHaveBeenCalledWith("chat-1", "bash", {
      command: "echo hi",
      cwd: config.tools.defaultCwd
    });
  });

  it("anchors multi-line /bash commands to the conversation cwd", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const harness = makeHarnessMock();
    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath,
        defaultWorkingDirectory: config.tools.defaultCwd
      }),
      workspace,
      harness
    });

    const result = await router.handleIncomingMessage(
      sampleIncoming({
        text: "/bash pwd\ncd ~\npwd",
        messageId: "msg-2"
      })
    );
    expect(result.type).toBe("reply");
    expect(harness.executeWithOwner).toHaveBeenNthCalledWith(1, "chat-1", "bash", {
      command: "pwd",
      cwd: config.tools.defaultCwd
    });
    expect(harness.executeWithOwner).toHaveBeenNthCalledWith(2, "chat-1", "bash", {
      command: "cd ~",
      cwd: config.tools.defaultCwd
    });
    expect(harness.executeWithOwner).toHaveBeenNthCalledWith(3, "chat-1", "bash", {
      command: "pwd",
      cwd: config.tools.defaultCwd
    });
  });

  it("supports /cwd for per-conversation working directory and reflects it in /status", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const conversations = createConversationStore({
      conversationsDir: config.paths.conversationsDir,
      stashedConversationsPath: config.paths.stashedConversationsPath,
      defaultWorkingDirectory: config.tools.defaultCwd
    });
    const harness = makeHarnessMock();

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations,
      workspace,
      harness
    });

    const projectDir = path.join(config.paths.workspaceRoot, "project-a");
    fs.mkdirSync(projectDir, { recursive: true });
    const resolvedProjectDir = fs.realpathSync(projectDir);

    const usage = await router.handleIncomingMessage(sampleIncoming({ text: "/cwd", messageId: "msg-1" }));
    expect(usage).toEqual({
      type: "reply",
      text: `Usage: /cwd <absolute-path>\ncwd: ${config.tools.defaultCwd}`
    });

    const relative = await router.handleIncomingMessage(sampleIncoming({ text: "/cwd project-a", messageId: "msg-2" }));
    expect(relative).toEqual({
      type: "reply",
      text: `Usage: /cwd <absolute-path>\ncwd: ${config.tools.defaultCwd}`
    });

    const switched = await router.handleIncomingMessage(sampleIncoming({ text: `/cwd ${projectDir}`, messageId: "msg-3" }));
    expect(switched).toEqual({
      type: "reply",
      text: `cwd: ${resolvedProjectDir}`
    });

    const status = await router.handleIncomingMessage(sampleIncoming({ text: "/status", messageId: "msg-4" }));
    expect(status.type).toBe("reply");
    if (status.type === "reply") {
      expect(status.text).toContain(`📁 \`${resolvedProjectDir}\``);
    }

    await router.handleIncomingMessage(sampleIncoming({ text: "/bash pwd", messageId: "msg-5" }));
    expect(harness.executeWithOwner).toHaveBeenLastCalledWith("chat-1", "bash", {
      command: "pwd",
      cwd: resolvedProjectDir
    });
  });

  it("toggles verbose mode through core commands", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const conversations = createConversationStore({
      conversationsDir: config.paths.conversationsDir,
      stashedConversationsPath: config.paths.stashedConversationsPath
    });

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations,
      workspace,
      harness: makeHarnessMock()
    });

    const usage = await router.handleIncomingMessage(sampleIncoming({ text: "/verbose" }));
    expect(usage).toEqual({
      type: "reply",
      text: "Usage: /verbose <on|off>\nverbose mode: on"
    });

    const enabled = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-2", text: "/verbose on" }));
    expect(enabled).toEqual({
      type: "reply",
      text: "verbose mode: on"
    });
    expect(await conversations.getVerboseMode("chat-1")).toBe(true);

    const status = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-3", text: "/status full" }));
    expect(status.type).toBe("reply");
    if (status.type === "reply") {
      expect(status.text).toContain("verbose: on");
    }
  });

  it("updates thinking effort through core commands", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const conversations = createConversationStore({
      conversationsDir: config.paths.conversationsDir,
      stashedConversationsPath: config.paths.stashedConversationsPath,
      defaultVerboseMode: false
    });

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations,
      workspace,
      harness: makeHarnessMock()
    });

    const usage = await router.handleIncomingMessage(sampleIncoming({ text: "/thinking nope" }));
    expect(usage).toEqual({
      type: "reply",
      text: "Usage: /thinking <none|minimal|low|medium|high|xhigh>\nthinking effort: medium"
    });

    const enabled = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-2", text: "/thinking xhigh" }));
    expect(enabled).toEqual({
      type: "reply",
      text: "thinking effort: xhigh"
    });
    expect(await conversations.getThinkingEffort("chat-1")).toBe("xhigh");

    const status = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-3", text: "/status" }));
    expect(status.type).toBe("reply");
    if (status.type === "reply") {
      expect(status.text).toContain("⚙️ Think: xhigh");
      expect(status.text).not.toContain("conversation:");
    }
  });

  it("lists configured models and switches active model by alias", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const conversations = createConversationStore({
      conversationsDir: config.paths.conversationsDir,
      stashedConversationsPath: config.paths.stashedConversationsPath
    });

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations,
      workspace,
      harness: makeHarnessMock()
    });

    const listBefore = await router.handleIncomingMessage(sampleIncoming({ text: "/models" }));
    expect(listBefore.type).toBe("reply");
    if (listBefore.type === "reply") {
      expect(listBefore.text).toContain("models:");
      expect(listBefore.text).toContain("* gpt-4.1-mini");
      expect(listBefore.text).toContain("- gpt-5.3-codex");
    }

    const switched = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-2", text: "/model codex" }));
    expect(switched).toEqual({
      type: "reply",
      text: "model: gpt-5.3-codex\nthinking effort: high (model default)\ncache retention: 24h (model default)"
    });
    expect(await conversations.getActiveModelOverride("chat-1")).toBe("gpt-5.3-codex");
    expect(await conversations.getThinkingEffort("chat-1")).toBe("high");
    expect(await conversations.getCacheRetention("chat-1")).toBe("24h");

    const listAfter = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-3", text: "/models" }));
    expect(listAfter.type).toBe("reply");
    if (listAfter.type === "reply") {
      expect(listAfter.text).toContain("* gpt-5.3-codex");
      expect(listAfter.text).toContain("high default think");
      expect(listAfter.text).toContain("active model: gpt-5.3-codex");
    }
  });

  it("passes active model selection through to provider requests", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async () => "assistant-reply")
    };

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    await router.handleIncomingMessage(sampleIncoming({ text: "/model codex" }));
    const result = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-2", text: "hello" }));
    expect(result).toEqual({ type: "reply", text: "assistant-reply", origin: "assistant" });

    const request = vi.mocked(provider.generateReply).mock.calls[0]?.[0];
    expect(request?.model).toBe("gpt-5.3-codex");
    expect(request?.thinkingEffort).toBe("high");
    expect(request?.cacheRetention).toBe("24h");
  });

  it("switches cache retention via /cache", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const conversations = createConversationStore({
      conversationsDir: config.paths.conversationsDir,
      stashedConversationsPath: config.paths.stashedConversationsPath
    });

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations,
      workspace,
      harness: makeHarnessMock()
    });

    const usage = await router.handleIncomingMessage(sampleIncoming({ text: "/cache" }));
    expect(usage).toEqual({
      type: "reply",
      text: "Usage: /cache <in_memory|24h>\ncache retention: in_memory\nmodel default cache retention: in_memory"
    });

    const changed = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-2", text: "/cache 24h" }));
    expect(changed).toEqual({
      type: "reply",
      text: "cache retention: 24h"
    });
    expect(await conversations.getCacheRetention("chat-1")).toBe("24h");

    const invalid = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-3", text: "/cache forever" }));
    expect(invalid).toEqual({
      type: "reply",
      text: "Usage: /cache <in_memory|24h>\ncache retention: 24h\nmodel default cache retention: in_memory"
    });
  });

  it("renders n/a token/cache summary before any successful provider usage is captured", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    const result = await router.handleIncomingMessage(sampleIncoming({ text: "/status" }));
    expect(result.type).toBe("reply");
    if (result.type === "reply") {
      expect(result.text).toContain("🧮 Tokens: n/a");
      expect(result.text).toContain("📚 Context: n/a");
      expect(result.text).toContain("🗄️ Cache: n/a · last: never");
    }
  });

  it("shows /status usage for unsupported arguments", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    const result = await router.handleIncomingMessage(sampleIncoming({ text: "/status raw" }));
    expect(result).toEqual({
      type: "reply",
      text: "Usage: /status [full]"
    });
  });

  it("includes latest usage snapshot metrics in /status summary", async () => {
    const config = makeConfig({ openai: { model: "gpt-5.3-codex" } });
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async (request) => {
        await request.onUsage?.({
          inputTokens: 8_700,
          outputTokens: 138,
          cachedTokens: 8_300,
          reasoningTokens: 42,
          peakInputTokens: 8_700,
          peakOutputTokens: 138,
          peakContextTokens: 8_838
        });
        return "assistant-reply";
      })
    };

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    await router.handleIncomingMessage(sampleIncoming({ text: "hello" }));
    const result = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-2", text: "/status" }));
    expect(result.type).toBe("reply");
    if (result.type === "reply") {
      expect(result.text).toContain("🧠 gpt-5.3-codex");
      expect(result.text).toContain("🧮 Tokens: 8.7k in / 138 out · 42 reasoning");
      expect(result.text).toContain("📚 Context: 8.7k / 392k (2%)");
      expect(result.text).toContain("🗄️ Cache: 95% hit");
      expect(result.text).not.toContain("conversation:");
    }
  });

  it("preserves status usage metrics after conversation store restart", async () => {
    const config = makeConfig({ openai: { model: "gpt-5.3-codex" } });
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const firstProvider: Provider = {
      generateReply: vi.fn(async (request) => {
        await request.onUsage?.({
          inputTokens: 1200,
          outputTokens: 160,
          cachedTokens: 900,
          reasoningTokens: 25,
          peakInputTokens: 1200,
          peakOutputTokens: 160,
          peakContextTokens: 1360
        });
        return "assistant-reply";
      })
    };

    const firstRouter = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: firstProvider,
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    await firstRouter.handleIncomingMessage(sampleIncoming({ text: "hello" }));

    const secondRouter = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    const status = await secondRouter.handleIncomingMessage(sampleIncoming({ messageId: "msg-2", text: "/status" }));
    expect(status.type).toBe("reply");
    if (status.type === "reply") {
      expect(status.text).toContain("🧮 Tokens: 1.2k in / 160 out · 25 reasoning");
      expect(status.text).toContain("📚 Context: 1.2k / 392k (0%)");
      expect(status.text).toContain("🗄️ Cache: 75% hit");
    }
  });

  it("attaches verbose tool-call messages to assistant replies when enabled", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async (request) => {
        await request.onToolCall?.({
          tool: "read_file",
          args: { path: "scripts/refresh-lazy-skills.py" },
          result: { path: "scripts/refresh-lazy-skills.py", content: "abc" },
          success: true,
          error: null
        });
        await request.onToolCall?.({
          tool: "write_file",
          args: { path: "refresh_lazy.py", content: "abcd" },
          result: { path: "refresh_lazy.py", size: 4 },
          success: true,
          error: null
        });
        await request.onToolCall?.({
          tool: "bash",
          args: { command: "echo hi" },
          result: { status: "completed" },
          success: true,
          error: null
        });
        return "assistant-reply";
      })
    };

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    await router.handleIncomingMessage(sampleIncoming({ text: "/verbose on" }));
    const result = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-2", text: "hello" }));

    expect(result.type).toBe("reply");
    if (result.type === "reply") {
      expect(result.text).toBe("assistant-reply");
      expect(result.origin).toBe("assistant");
      expect(result.extraReplies).toEqual([
        "📖 Read: `scripts/refresh-lazy-skills.py` (3 chars)",
        "✍️ Write: `refresh_lazy.py` (4 chars)",
        "🐚 Bash: `echo hi`"
      ]);
      expect(result.extraReplies?.some((line) => line.includes("<tool_call>"))).toBe(false);
      expect(result.extraReplies?.some((line) => line.includes("<tool_result"))).toBe(false);
    }
  });

  it("does not stream workflow progress when observability is off, even if verbose is on", async () => {
    const config = makeConfig({
      observability: { enabled: false },
      runtime: { toolHeartbeatIntervalMs: 20 }
    });
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async (request) => {
        await request.onToolProgress?.({
          type: "step",
          message: "tool-loop step 1: requesting model response",
          elapsedMs: 30,
          step: 1
        });
        await request.onToolCall?.({
          tool: "read_file",
          args: { path: "README.md" },
          result: { path: "README.md", content: "hello" },
          success: true,
          error: null
        });
        return "assistant-reply";
      })
    };

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    await router.handleIncomingMessage(sampleIncoming({ text: "/verbose on" }));
    const onTextDelta = vi.fn();
    const result = await router.handleIncomingMessage(
      sampleIncoming({ messageId: "msg-2", text: "hello" }),
      { onTextDelta }
    );

    expect(onTextDelta).not.toHaveBeenCalled();
    expect(result.type).toBe("reply");
    if (result.type === "reply") {
      expect(result.extraReplies).toEqual(["📖 Read: `README.md` (5 chars)"]);
      expect(result.extraReplies?.some((line) => line.includes("⏳"))).toBe(false);
    }
  });

  it("does not stream workflow progress to draft even when observability is on", async () => {
    const config = makeConfig({
      observability: { enabled: true }
    });
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async (request) => {
        await request.onToolProgress?.({
          type: "step",
          message: "tool-loop step 1: requesting model response",
          elapsedMs: 1,
          step: 1
        });
        return "assistant-reply";
      })
    };

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    const onTextDelta = vi.fn();
    const result = await router.handleIncomingMessage(
      sampleIncoming({ messageId: "msg-2", text: "hello" }),
      { onTextDelta }
    );

    expect(result).toEqual({ type: "reply", text: "assistant-reply", origin: "assistant" });
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it("does not leak workflow progress into extraReplies when verbose and observability are both on", async () => {
    const config = makeConfig({
      observability: { enabled: true },
      runtime: { toolHeartbeatIntervalMs: 20 }
    });
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async (request) => {
        await sleep(30);
        await request.onToolProgress?.({
          type: "step",
          message: "tool-loop step 1: requesting model response",
          elapsedMs: 30,
          step: 1
        });
        await request.onToolCall?.({
          tool: "read_file",
          args: { path: "README.md" },
          result: { path: "README.md", content: "hello" },
          success: true,
          error: null
        });
        return "assistant-reply";
      })
    };

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    await router.handleIncomingMessage(sampleIncoming({ text: "/verbose on" }));
    const onTextDelta = vi.fn();
    const result = await router.handleIncomingMessage(
      sampleIncoming({ messageId: "msg-2", text: "hello" }),
      { onTextDelta }
    );

    expect(onTextDelta).not.toHaveBeenCalled();
    expect(result.type).toBe("reply");
    if (result.type === "reply") {
      expect(result.extraReplies).toEqual(["📖 Read: `README.md` (5 chars)"]);
      expect(result.extraReplies?.some((line) => line.includes("⏳"))).toBe(false);
    }
  });

  it("keeps verbose warning messages on fallback when tool calls fail", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async (request) => {
        await request.onToolCall?.({
          tool: "read_file",
          args: { path: "missing.txt" },
          result: null,
          success: false,
          error: "File not found"
        });

        throw new ProviderError({
          message: "tool failure bubbled",
          kind: "unknown",
          statusCode: null,
          attempts: 1,
          retryable: false
        });
      })
    };

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    await router.handleIncomingMessage(sampleIncoming({ text: "/verbose on" }));
    const result = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-2", text: "run" }));
    expect(result.type).toBe("fallback");
    if (result.type === "fallback") {
      expect(result.text).toBe("Temporary provider error. Please try again.");
      expect(result.extraReplies).toEqual(["⚠️ Read failed: `missing.txt` - File not found"]);
    }
  });

  it("logs structured provider failure diagnostics and reports them in /status full", async () => {
    const config = makeConfig({ runtime: { defaultVerbose: false } });
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const provider: Provider = {
      generateReply: vi.fn(async () => {
        throw new ProviderError({
          message: "OpenAI HTTP 429 (rate limit) type=rate_limit_error: Try again.",
          kind: "rate_limit",
          statusCode: 429,
          attempts: 3,
          retryable: false,
          detail: {
            reason: "OpenAI HTTP 429 (rate limit) type=rate_limit_error: Try again.",
            openaiErrorType: "rate_limit_error",
            openaiErrorCode: null,
            openaiErrorParam: null,
            requestId: "req_123",
            retryAfterMs: 1_000,
            timedOutBy: null
          }
        });
      })
    };

    const conversations = createConversationStore({
      conversationsDir: config.paths.conversationsDir,
      stashedConversationsPath: config.paths.stashedConversationsPath,
      defaultVerboseMode: false
    });

    const router = createMessageRouter({
      logger,
      provider,
      config,
      conversations,
      workspace,
      harness: makeHarnessMock()
    });

    const fallback = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-2", text: "run" }));
    expect(fallback).toEqual({
      type: "fallback",
      text: "Provider rate limit reached. Please retry shortly."
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'routing: provider failure chat=chat-1 conversation=conv_'
      )
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'kind=rate_limit status=429 attempts=3 retryable=false reason="OpenAI HTTP 429 (rate limit) type=rate_limit_error: Try again." openai_type=rate_limit_error openai_code=none openai_param=none request_id=req_123'
      )
    );

    const status = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-3", text: "/status full" }));
    expect(status.type).toBe("reply");
    if (status.type !== "reply") {
      return;
    }

    expect(status.text).toContain("provider.last_failure_kind: rate_limit");
    expect(status.text).toContain("provider.last_failure_status: 429");
    expect(status.text).toContain("provider.last_failure_attempts: 3");
    expect(status.text).toContain("provider.last_failure_reason: OpenAI HTTP 429 (rate limit) type=rate_limit_error: Try again.");
  });

  it("appends safe provider failure details in verbose mode fallback messages", async () => {
    const config = makeConfig({ runtime: { defaultVerbose: true } });
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async () => {
        throw new ProviderError({
          message: "OpenAI HTTP 400 (client error)",
          kind: "client_error",
          statusCode: 400,
          attempts: 1,
          retryable: false,
          detail: {
            reason: "OpenAI HTTP 400 (client error): unsupported parameter\nreasoning.effort",
            openaiErrorType: "invalid_request_error",
            openaiErrorCode: "unsupported_parameter",
            openaiErrorParam: "reasoning.effort",
            requestId: "req_456",
            retryAfterMs: null,
            timedOutBy: null
          }
        });
      })
    };

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    const fallback = await router.handleIncomingMessage(sampleIncoming({ messageId: "msg-4", text: "run" }));
    expect(fallback.type).toBe("fallback");
    if (fallback.type !== "fallback") {
      return;
    }

    expect(fallback.text).toBe(
      "Provider rejected this request configuration.\nDetails: OpenAI HTTP 400 (client error): unsupported parameter reasoning.effort"
    );
  });

  it("records tool result stats even when verbose mode is off and shows them in /status full", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async (request) => {
        await request.onToolCall?.({
          tool: "read_file",
          args: { path: "README.md" },
          result: { path: "README.md", content: "hello" },
          success: true,
          error: null
        });
        return "assistant-reply";
      })
    };

    const conversations = createConversationStore({
      conversationsDir: config.paths.conversationsDir,
      stashedConversationsPath: config.paths.stashedConversationsPath
    });

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations,
      workspace,
      harness: makeHarnessMock()
    });

    await router.handleIncomingMessage(sampleIncoming({ text: "/verbose off", messageId: "msg-1" }));
    const reply = await router.handleIncomingMessage(sampleIncoming({ text: "hello", messageId: "msg-2" }));
    expect(reply).toEqual({
      type: "reply",
      text: "assistant-reply",
      origin: "assistant"
    });

    const status = await router.handleIncomingMessage(sampleIncoming({ text: "/status full", messageId: "msg-3" }));
    expect(status.type).toBe("reply");
    if (status.type === "reply") {
      expect(status.text).toContain("tool.results_total: 1");
      expect(status.text).toContain("tool.results_success: 1");
      expect(status.text).toContain("tool.results_fail: 0");
      expect(status.text).toContain("tool.results_by_name: Read=1");
    }
  });

  it("records failed bash tool results and reflects them in /status full", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async (request) => {
        await request.onToolCall?.({
          tool: "bash",
          args: { command: "grep missing" },
          result: {
            status: "completed",
            exitCode: 2,
            stderr: "grep: missing pattern"
          },
          success: false,
          error: "Command exited with status 2",
          errorCode: null
        });
        return "assistant-reply";
      })
    };

    const conversations = createConversationStore({
      conversationsDir: config.paths.conversationsDir,
      stashedConversationsPath: config.paths.stashedConversationsPath
    });

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations,
      workspace,
      harness: makeHarnessMock()
    });

    await router.handleIncomingMessage(sampleIncoming({ text: "/verbose off", messageId: "msg-1" }));
    const reply = await router.handleIncomingMessage(sampleIncoming({ text: "hello", messageId: "msg-2" }));
    expect(reply).toEqual({
      type: "reply",
      text: "assistant-reply",
      origin: "assistant"
    });

    const status = await router.handleIncomingMessage(sampleIncoming({ text: "/status full", messageId: "msg-3" }));
    expect(status.type).toBe("reply");
    if (status.type === "reply") {
      expect(status.text).toContain("tool.results_total: 1");
      expect(status.text).toContain("tool.results_success: 0");
      expect(status.text).toContain("tool.results_fail: 1");
      expect(status.text).toContain("tool.results_by_name: Bash=1");
    }
  });

  it("invokes skill commands as one-shot instructions", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const skillPath = path.join(config.paths.workspaceRoot, "skills", "research", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(
      skillPath,
      "---\nname: Research\ndescription: Research helper\n---\n\n# Research\n",
      "utf8"
    );

    await workspace.refresh();

    const provider: Provider = {
      generateReply: vi.fn(async () => "skill-reply")
    };

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    const result = await router.handleIncomingMessage(sampleIncoming({ text: "/research find docs" }));
    expect(result).toEqual({ type: "reply", text: "skill-reply", origin: "assistant" });

    const call = vi.mocked(provider.generateReply).mock.calls[0]?.[0];
    const lastUserMsg = call?.history?.findLast((m: { role: string }) => m.role === "user");
    const userText = Array.isArray(lastUserMsg?.content)
      ? lastUserMsg.content.find((p: { type: string }) => p.type === "text")?.text ?? ""
      : lastUserMsg?.content ?? "";
    expect(userText).toContain("[Skill Invoked: /Research]");
  });

  it("includes observability state in /status output summary", async () => {
    const config = makeConfig({ observability: { enabled: true } });
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    const result = await router.handleIncomingMessage(sampleIncoming({ text: "/status full" }));
    expect(result.type).toBe("reply");
    if (result.type === "reply") {
      expect(result.text).toContain("observability: on");
    }
  });

  it("writes routing decision observability events when enabled", async () => {
    const config = makeConfig({ observability: { enabled: true } });
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider: { generateReply: vi.fn(async () => "unused") },
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock(),
      observability: createObservabilitySink({
        enabled: true,
        logPath: config.observability.logPath
      })
    });

    const result = await router.handleIncomingMessage(sampleIncoming({ text: "/status" }));
    expect(result.type).toBe("reply");

    const entries = fs
      .readFileSync(config.observability.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const decisionEntry = entries.find((entry) => entry.event === "routing.decision.made");
    expect(decisionEntry).toEqual(
      expect.objectContaining({
        decision: "core_command",
        resultType: "reply",
        messageId: "msg-1",
        chatId: "chat-1"
      })
    );
  });

  it("queues messages during active turns instead of aborting", async () => {
    const config = makeConfig();
    const workspace = createWorkspaceManager(config);
    await workspace.bootstrap();

    const provider: Provider = {
      generateReply: vi.fn(async (request) => {
        const latestContent = request.history[request.history.length - 1]?.content;
        if (latestContent === "first") {
          await sleep(50);
          return "reply-first";
        }
        return "reply-second";
      })
    };

    const router = createMessageRouter({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provider,
      config,
      conversations: createConversationStore({
        conversationsDir: config.paths.conversationsDir,
        stashedConversationsPath: config.paths.stashedConversationsPath
      }),
      workspace,
      harness: makeHarnessMock()
    });

    const firstTurn = router.handleIncomingMessage(sampleIncoming({ text: "first", messageId: "msg-1" }));
    await sleep(10);
    const secondTurn = router.handleIncomingMessage(sampleIncoming({ text: "second", messageId: "msg-2" }));

    // Second message is queued, not a new turn
    await expect(secondTurn).resolves.toMatchObject({
      type: "reply",
      text: "Message queued (1 pending)"
    });
    // First turn completes normally
    await expect(firstTurn).resolves.toMatchObject({
      type: "reply",
      text: "reply-first"
    });
  });
});
