import { describe, it, expect, vi } from "vitest";
import { createCoreCommandHandler } from "../src/routing/core-commands.js";
import { makeConfig } from "./helpers.js";
import type { StateStore, WorkspaceCatalog, StashedConversationSummary, ConversationSwitchRuntime } from "../src/runtime/contracts.js";
import type { ToolHarness } from "../src/harness/index.js";
import type { NormalizedTelegramMessage, NormalizedTelegramCallbackQuery } from "../src/types.js";

function makeMessage(overrides: Partial<NormalizedTelegramMessage> = {}): NormalizedTelegramMessage {
  return {
    chatId: "chat-1",
    senderId: "user-1",
    senderName: "Alice",
    messageId: "msg-1",
    text: "",
    attachments: [],
    replyToMessageId: null,
    ...overrides
  } as NormalizedTelegramMessage;
}

function makeCallbackQuery(overrides: Partial<NormalizedTelegramCallbackQuery> = {}): NormalizedTelegramCallbackQuery {
  return {
    chatId: "chat-1",
    senderId: "user-1",
    data: "",
    messageId: "msg-1",
    ...overrides
  } as NormalizedTelegramCallbackQuery;
}

function makeSwitchRuntime(): ConversationSwitchRuntime {
  return {
    thinkingEffort: "medium",
    workingDirectory: "/tmp",
    cacheRetention: "in_memory",
    transportMode: "http",
    authMode: "api",
    activeModelOverride: null,
    activeWebSearchModelOverride: null
  } as ConversationSwitchRuntime;
}

function makeConversations(): StateStore {
  return {
    ensureActiveConversation: vi.fn().mockResolvedValue("conv-1"),
    listStashedConversations: vi.fn().mockResolvedValue([]),
    completeNewSelection: vi.fn().mockResolvedValue({
      conversationId: "conv-new",
      archivedConversationId: "conv-old",
      alias: null,
      runtime: makeSwitchRuntime()
    }),
    completeStashSelection: vi.fn().mockResolvedValue({
      conversationId: "conv-restored",
      stashedConversationId: "conv-stashed",
      stashedAlias: "my-stash",
      alias: "restored-alias",
      runtime: makeSwitchRuntime()
    }),
    getWorkingDirectory: vi.fn().mockResolvedValue("/tmp"),
    getVerboseMode: vi.fn().mockResolvedValue("full"),
    getThinkingEffort: vi.fn().mockResolvedValue("medium"),
    getCacheRetention: vi.fn().mockResolvedValue("in_memory"),
    getTransportMode: vi.fn().mockResolvedValue("http"),
    getAuthMode: vi.fn().mockResolvedValue("api"),
    getActiveModelOverride: vi.fn().mockResolvedValue(null),
    getActiveWebSearchModelOverride: vi.fn().mockResolvedValue(null),
    getLatestUsageSnapshot: vi.fn().mockResolvedValue(null),
    getToolResultStats: vi.fn().mockResolvedValue({ successCount: 0, failureCount: 0 }),
    getCompactionCount: vi.fn().mockResolvedValue(0),
    getLastProviderFailure: vi.fn().mockResolvedValue(null),
    setVerboseMode: vi.fn().mockResolvedValue(undefined),
    setThinkingEffort: vi.fn().mockResolvedValue(undefined),
    setCacheRetention: vi.fn().mockResolvedValue(undefined),
    setTransportMode: vi.fn().mockResolvedValue(undefined),
    setAuthMode: vi.fn().mockResolvedValue(undefined),
    setActiveModelOverride: vi.fn().mockResolvedValue(undefined),
    setActiveWebSearchModelOverride: vi.fn().mockResolvedValue(undefined),
    setWorkingDirectory: vi.fn().mockResolvedValue(undefined),
    getHealth: vi.fn().mockReturnValue({ status: "ok" })
  } as unknown as StateStore;
}

function makeWorkspace(): WorkspaceCatalog {
  return {
    getSnapshot: vi.fn().mockReturnValue({ skills: [] }),
    getHealth: vi.fn().mockReturnValue({ status: "ok" })
  } as unknown as WorkspaceCatalog;
}

function makeHarness(): ToolHarness {
  return {
    exportProviderTools: vi.fn().mockReturnValue([]),
    execute: vi.fn().mockResolvedValue({ ok: true }),
    executeWithOwner: vi.fn().mockResolvedValue({ ok: true, stdout: "output", exitCode: 0 }),
    metrics: {
      workflowsStarted: 0, workflowsSucceeded: 0, workflowsFailed: 0,
      workflowsTimedOut: 0, workflowsInterrupted: 0, workflowsCleanupErrors: 0,
      workflowLoopBreakerTrips: 0, toolSuccessCount: 5, toolFailureCount: 1,
      errorCodeCounts: {}
    },
    context: {
      processManager: {
        listSessionsByOwner: vi.fn().mockReturnValue([]),
        killRunningSessionsByOwner: vi.fn().mockReturnValue({ killed: 0, sessionIds: [] }),
        getHealth: vi.fn().mockReturnValue({
          truncatedCombinedChars: 0,
          truncatedStdoutChars: 0,
          truncatedStderrChars: 0
        })
      }
    }
  } as unknown as ToolHarness;
}

function createHandler(overrides: {
  conversations?: StateStore;
  config?: ReturnType<typeof makeConfig>;
} = {}) {
  return createCoreCommandHandler({
    config: overrides.config ?? makeConfig(),
    conversations: overrides.conversations ?? makeConversations(),
    workspace: makeWorkspace(),
    harness: makeHarness()
  });
}

describe("core-commands – handleCommand", () => {
  it("/start returns greeting", async () => {
    const handler = createHandler();
    const result = await handler.handleCommand("start", "", makeMessage());
    expect(result?.type).toBe("reply");
    expect(result?.text).toContain("online");
  });

  it("/new creates new conversation", async () => {
    const conversations = makeConversations();
    const handler = createHandler({ conversations });
    const result = await handler.handleCommand("new", "", makeMessage());
    expect(result?.type).toBe("reply");
    expect(result?.text).toContain("conv...-new");
    expect(conversations.completeNewSelection).toHaveBeenCalledWith(
      "chat-1",
      { type: "new" },
      "manual_new_command",
      expect.anything()
    );
  });

  it("/new from opens stash menu", async () => {
    const stashes: StashedConversationSummary[] = [
      { conversationId: "conv-s1", alias: "my-work", stashedAt: "2026-01-01T00:00:00Z" }
    ];
    const conversations = makeConversations();
    (conversations.listStashedConversations as ReturnType<typeof vi.fn>).mockResolvedValue(stashes);
    const handler = createHandler({ conversations });
    const result = await handler.handleCommand("new", "from", makeMessage());
    expect(result?.type).toBe("reply");
    expect(result?.inlineKeyboard).toBeDefined();
    expect(result!.inlineKeyboard!.length).toBeGreaterThan(0);
  });

  it("/new with invalid args returns usage", async () => {
    const handler = createHandler();
    const result = await handler.handleCommand("new", "invalid", makeMessage());
    expect(result?.text).toContain("Usage");
  });

  it("/stash without args returns usage", async () => {
    const handler = createHandler();
    const result = await handler.handleCommand("stash", "", makeMessage());
    expect(result?.text).toContain("Usage");
  });

  it("/stash list returns stash listing", async () => {
    const conversations = makeConversations();
    (conversations.listStashedConversations as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const handler = createHandler({ conversations });
    const result = await handler.handleCommand("stash", "list", makeMessage());
    expect(result?.text).toContain("No stashes");
  });

  it("/stash <name> opens stash menu", async () => {
    const handler = createHandler();
    const result = await handler.handleCommand("stash", "my-branch", makeMessage());
    expect(result?.inlineKeyboard).toBeDefined();
    expect(result?.text).toContain("my-branch");
  });

  it("/status returns status info", async () => {
    const handler = createHandler();
    const result = await handler.handleCommand("status", "", makeMessage());
    expect(result?.type).toBe("reply");
    expect(result?.text).toContain("gpt-5.4-mini");
  });

  it("/verbose sets mode", async () => {
    const conversations = makeConversations();
    const handler = createHandler({ conversations });
    const result = await handler.handleCommand("verbose", "count", makeMessage());
    expect(result?.text).toContain("count");
    expect(conversations.setVerboseMode).toHaveBeenCalledWith("chat-1", "count", expect.anything());
  });

  it("/verbose without valid arg shows usage", async () => {
    const handler = createHandler();
    const result = await handler.handleCommand("verbose", "", makeMessage());
    expect(result?.text).toContain("Usage");
  });

  it("/thinking sets effort", async () => {
    const conversations = makeConversations();
    const handler = createHandler({ conversations });
    const result = await handler.handleCommand("thinking", "high", makeMessage());
    expect(result?.text).toContain("high");
    expect(conversations.setThinkingEffort).toHaveBeenCalledWith("chat-1", "high", expect.anything());
  });

  it("/bash executes command", async () => {
    const handler = createHandler();
    const result = await handler.handleCommand("bash", "echo hello", makeMessage());
    expect(result?.type).toBe("reply");
  });

  it("/bash without args returns usage", async () => {
    const handler = createHandler();
    const result = await handler.handleCommand("bash", "", makeMessage());
    expect(result?.text).toContain("Usage");
  });

  it("unknown command returns null", async () => {
    const handler = createHandler();
    const result = await handler.handleCommand("nonexistent", "", makeMessage());
    expect(result).toBeNull();
  });

  it("/stop kills running sessions", async () => {
    const handler = createHandler();
    const result = await handler.handleCommand("stop", "", makeMessage());
    expect(result?.text).toContain("stopped sessions: 0");
  });
});

describe("core-commands – handleCallbackQuery", () => {
  it("returns null for non-convmenu prefix", async () => {
    const handler = createHandler();
    const result = await handler.handleCallbackQuery(makeCallbackQuery({ data: "other:token:action" }));
    expect(result).toBeNull();
  });

  it("returns expired message for unknown token", async () => {
    const handler = createHandler();
    const result = await handler.handleCallbackQuery(
      makeCallbackQuery({ data: "convmenu:unknown_token:n" })
    );
    expect(result?.text).toContain("expired");
  });

  it("handles New selection from /new from menu", async () => {
    const conversations = makeConversations();
    const handler = createHandler({ conversations });

    // First create a menu via /new from
    const menuResult = await handler.handleCommand("new", "from", makeMessage());
    expect(menuResult?.inlineKeyboard).toBeDefined();

    // Extract token from the callback data of the "New" button
    const newButton = menuResult!.inlineKeyboard!.flat().find((b) => b.text === "New");
    expect(newButton).toBeDefined();

    const result = await handler.handleCallbackQuery(
      makeCallbackQuery({ data: newButton!.callbackData })
    );
    expect(result?.text).toContain("started new conversation");
    expect(conversations.completeNewSelection).toHaveBeenCalled();
  });

  it("menu token is single-use", async () => {
    const handler = createHandler();

    const menuResult = await handler.handleCommand("new", "from", makeMessage());
    const newButton = menuResult!.inlineKeyboard!.flat().find((b) => b.text === "New");

    // Use it once
    await handler.handleCallbackQuery(makeCallbackQuery({ data: newButton!.callbackData }));

    // Second use returns expired
    const result = await handler.handleCallbackQuery(
      makeCallbackQuery({ data: newButton!.callbackData })
    );
    expect(result?.text).toContain("expired");
  });

  it("rejects callback from different sender", async () => {
    const handler = createHandler();
    const menuResult = await handler.handleCommand("new", "from", makeMessage());
    const newButton = menuResult!.inlineKeyboard!.flat().find((b) => b.text === "New");

    const result = await handler.handleCallbackQuery(
      makeCallbackQuery({ data: newButton!.callbackData, senderId: "other-user" })
    );
    expect(result?.text).toContain("not valid");
  });
});
