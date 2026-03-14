import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createObservabilitySink } from "../src/observability.js";
import { createConversationStore } from "../src/state/conversations.js";
import { createTempDir } from "./helpers.js";

describe("conversation store", () => {
  it("appends user message atomically and returns bounded prompt context", async () => {
    const root = createTempDir("acmd-conv-atomic-");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json")
    });

    const conversationId = await store.ensureActiveConversation("chat-1");

    const first = await store.appendUserMessageAndGetPromptContext({
      chatId: "chat-1",
      conversationId,
      telegramMessageId: "m1",
      senderId: "u1",
      senderName: "Ada",
      content: "a",
      historyLimit: 2
    });
    expect(first.promptCountBeforeAppend).toBe(0);
    expect(first.historyAfterAppend.map((item) => item.content)).toEqual(["a"]);

    await store.appendAssistantMessage({
      chatId: "chat-1",
      conversationId,
      content: "b"
    });

    const second = await store.appendUserMessageAndGetPromptContext({
      chatId: "chat-1",
      conversationId,
      telegramMessageId: "m2",
      senderId: "u1",
      senderName: "Ada",
      content: "c",
      historyLimit: 2
    });
    expect(second.promptCountBeforeAppend).toBe(2);
    expect(second.historyAfterAppend.map((item) => item.content)).toEqual(["b", "c"]);
  });

  it("returns full prompt history when history limit is null", async () => {
    const root = createTempDir("acmd-conv-history-null-");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json")
    });

    const conversationId = await store.ensureActiveConversation("chat-1");

    await store.appendUserMessage({
      chatId: "chat-1",
      conversationId,
      telegramMessageId: "m1",
      senderId: "u1",
      senderName: "Ada",
      content: "a"
    });
    await store.appendAssistantMessage({
      chatId: "chat-1",
      conversationId,
      content: "b"
    });

    const context = await store.appendUserMessageAndGetPromptContext({
      chatId: "chat-1",
      conversationId,
      telegramMessageId: "m2",
      senderId: "u1",
      senderName: "Ada",
      content: "c",
      historyLimit: null
    });

    expect(context.historyAfterAppend.map((item) => item.content)).toEqual(["a", "b", "c"]);
  });

  it("creates active conversation and persists messages in JSONL", async () => {
    const root = createTempDir("acmd-conv-store-");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json")
    });

    const conversationId = await store.ensureActiveConversation("chat-1");
    await store.appendUserMessage({
      chatId: "chat-1",
      conversationId,
      telegramMessageId: "m1",
      senderId: "u1",
      senderName: "Ada",
      content: "hello"
    });
    await store.appendAssistantMessage({
      chatId: "chat-1",
      conversationId,
      content: "hi"
    });

    const history = await store.getPromptHistory("chat-1", conversationId, 10);
    expect(history.map((item) => item.content)).toEqual(["hello", "hi"]);
    expect(await store.getActiveConversation("chat-1")).toBe(conversationId);
  });

  it("archives current conversation only when /new selection is completed", async () => {
    const root = createTempDir("acmd-conv-new-select-");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json")
    });

    const first = await store.ensureActiveConversation("chat-1");
    const second = await store.completeNewSelection("chat-1", { type: "new" }, "manual_new");

    expect(second.archivedConversationId).toBe(first);
    expect(second.conversationId).not.toBe(first);

    const firstPath = path.join(root, "conversations", encodeURIComponent("chat-1"), `${first}.jsonl`);
    const raw = fs.readFileSync(firstPath, "utf8");
    expect(raw).toContain("conversation_archived");
  });

  it("stashes current conversation then switches and resets runtime defaults", async () => {
    const root = createTempDir("acmd-conv-stash-switch-");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json"),
      defaultVerboseMode: true,
      defaultThinkingEffort: "medium"
    });

    const chatId = "chat-1";
    const conversationA = await store.ensureActiveConversation(chatId);

    await store.setVerboseMode(chatId, false);
    await store.setThinkingEffort(chatId, "high");
    await store.setActiveModelOverride(chatId, "gpt-5.3-codex");
    await store.setLatestUsageSnapshot(chatId, {
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 40,
      reasoningTokens: 10
    });
    await store.recordToolResult(chatId, { tool: "bash", success: true });

    const stashResult = await store.completeStashSelection(chatId, "focus", { type: "new" }, "manual_stash");
    expect(stashResult.stashedConversationId).toBe(conversationA);
    expect(stashResult.stashedAlias).toBe("focus");

    expect(await store.getVerboseMode(chatId)).toBe(true);
    expect(await store.getThinkingEffort(chatId)).toBe("medium");
    expect(await store.getActiveModelOverride(chatId)).toBeNull();
    expect(await store.getLatestUsageSnapshot(chatId)).toBeNull();
    expect(await store.getToolResultStats(chatId)).toEqual({
      total: 0,
      success: 0,
      fail: 0,
      byTool: {}
    });

    await store.completeNewSelection(chatId, { type: "stash", conversationId: conversationA }, "manual_new");

    expect(await store.getActiveConversation(chatId)).toBe(conversationA);
    expect(await store.getVerboseMode(chatId)).toBe(false);
    expect(await store.getThinkingEffort(chatId)).toBe("high");
    expect(await store.getActiveModelOverride(chatId)).toBe("gpt-5.3-codex");
    expect(await store.getLatestUsageSnapshot(chatId)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 40,
      reasoningTokens: 10
    });
    expect(await store.getToolResultStats(chatId)).toEqual({
      total: 1,
      success: 1,
      fail: 0,
      byTool: {
        bash: 1
      }
    });
  });

  it("auto-renames duplicate stash aliases", async () => {
    const root = createTempDir("acmd-conv-stash-alias-");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json")
    });

    const chatId = "chat-1";
    await store.ensureActiveConversation(chatId);

    const first = await store.completeStashSelection(chatId, "work", { type: "new" }, "manual_stash");
    await new Promise((resolve) => setTimeout(resolve, 1));
    const second = await store.completeStashSelection(chatId, "work", { type: "new" }, "manual_stash");

    expect(first.stashedAlias).toBe("work");
    expect(second.stashedAlias).toBe("work-2");

    const stashes = await store.listStashedConversations(chatId);
    expect(stashes.map((item) => item.alias)).toEqual(["work-2", "work"]);
  });

  it("keeps alias when re-stashing the same conversation id", async () => {
    const root = createTempDir("acmd-conv-stash-alias-same-id-");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json")
    });

    const chatId = "chat-1";
    const conversationA = await store.ensureActiveConversation(chatId);

    await store.completeStashSelection(chatId, "TEST", { type: "new" }, "manual_stash");
    await store.completeNewSelection(chatId, { type: "stash", conversationId: conversationA }, "manual_new");

    const second = await store.completeStashSelection(chatId, "TEST", { type: "new" }, "manual_stash");
    expect(second.stashedConversationId).toBe(conversationA);
    expect(second.stashedAlias).toBe("TEST");

    const stashes = await store.listStashedConversations(chatId);
    expect(stashes).toHaveLength(1);
    expect(stashes[0]?.alias).toBe("TEST");
  });

  it("lists stashes newest-first and removes activated stash from stash pool", async () => {
    const root = createTempDir("acmd-conv-stash-list-");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json")
    });

    const chatId = "chat-1";
    const conversationA = await store.ensureActiveConversation(chatId);
    await store.completeStashSelection(chatId, "alpha", { type: "new" }, "manual_stash");
    const conversationB = await store.getActiveConversation(chatId);
    expect(conversationB).toBeTruthy();

    await store.completeStashSelection(chatId, "beta", { type: "new" }, "manual_stash");
    const stashesBefore = await store.listStashedConversations(chatId);
    expect(stashesBefore.map((item) => item.alias)).toEqual(["beta", "alpha"]);

    await store.completeNewSelection(chatId, { type: "stash", conversationId: conversationA }, "manual_new");
    const stashesAfter = await store.listStashedConversations(chatId);
    expect(stashesAfter.map((item) => item.alias)).toEqual(["beta"]);
  });

  it("persists current and stashed runtime profiles across restart", async () => {
    const root = createTempDir("acmd-conv-persist-");
    const conversationsDir = path.join(root, "conversations");
    const stashedConversationsPath = path.join(root, "stashed.json");
    const activeConversationsPath = path.join(root, "active.json");

    const firstStore = createConversationStore({
      conversationsDir,
      stashedConversationsPath,
      activeConversationsPath
    });

    const chatId = "chat-1";
    const conversationA = await firstStore.ensureActiveConversation(chatId);
    await firstStore.setVerboseMode(chatId, false);

    await firstStore.completeStashSelection(chatId, "alpha", { type: "new" }, "manual_stash");

    const secondStore = createConversationStore({
      conversationsDir,
      stashedConversationsPath,
      activeConversationsPath
    });

    const stashes = await secondStore.listStashedConversations(chatId);
    expect(stashes).toHaveLength(1);
    expect(stashes[0]?.alias).toBe("alpha");

    await secondStore.completeNewSelection(chatId, { type: "stash", conversationId: conversationA }, "manual_new");
    expect(await secondStore.getVerboseMode(chatId)).toBe(false);
  });

  it("starts fresh when legacy runtime-settings/index schema is present", async () => {
    const root = createTempDir("acmd-conv-legacy-fresh-");
    const conversationsDir = path.join(root, "conversations");
    const stashedConversationsPath = path.join(root, "stashed.json");
    const activeConversationsPath = path.join(root, "active.json");

    fs.writeFileSync(stashedConversationsPath, JSON.stringify({ "chat-1": "conv_legacy" }, null, 2), "utf8");
    fs.writeFileSync(
      path.join(root, "runtime-settings.json"),
      JSON.stringify(
        {
          verboseMode: false,
          thinkingEffort: "high"
        },
        null,
        2
      ),
      "utf8"
    );

    const store = createConversationStore({
      conversationsDir,
      stashedConversationsPath,
      activeConversationsPath,
      defaultVerboseMode: true,
      defaultThinkingEffort: "medium"
    });

    const conversationId = await store.ensureActiveConversation("chat-1");
    expect(conversationId).not.toBe("conv_legacy");
    expect(await store.getVerboseMode("chat-1")).toBe(true);
    expect(await store.getThinkingEffort("chat-1")).toBe("medium");
  });

  it("does not migrate old filename layout automatically", async () => {
    const root = createTempDir("acmd-conv-old-layout-");
    const conversationsDir = path.join(root, ".agent-commander", "conversations");
    const newStashedPath = path.join(root, ".agent-commander", "stashed-conversations.json");
    const newCurrentPath = path.join(root, ".agent-commander", "active-conversations.json");
    const oldCurrentPath = path.join(root, ".agent-commander", "current-conversations.json");

    const runtime = {
      verboseMode: false,
      thinkingEffort: "high",
      activeModelOverride: "gpt-5.3-codex",
      latestUsage: {
        inputTokens: 1,
        outputTokens: 2,
        cachedTokens: 0,
        reasoningTokens: 0
      },
      toolResults: {
        total: 1,
        success: 1,
        fail: 0,
        byTool: {
          bash: 1
        }
      }
    };

    await fs.promises.mkdir(path.dirname(newCurrentPath), { recursive: true });
    fs.writeFileSync(
      newCurrentPath,
      JSON.stringify(
        {
          "chat-1": [
            {
              conversationId: "conv_old_stash",
              alias: "legacy",
              stashedAt: "2026-01-01T00:00:00.000Z",
              runtime
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );
    fs.writeFileSync(
      oldCurrentPath,
      JSON.stringify(
        {
          "chat-1": {
            conversationId: "conv_old_current",
            alias: null,
            runtime
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const store = createConversationStore({
      conversationsDir,
      stashedConversationsPath: newStashedPath,
      activeConversationsPath: newCurrentPath,
      defaultVerboseMode: true,
      defaultThinkingEffort: "medium"
    });

    const conversationId = await store.ensureActiveConversation("chat-1");
    expect(conversationId).not.toBe("conv_old_stash");
    expect(conversationId).not.toBe("conv_old_current");
    expect(await store.listStashedConversations("chat-1")).toEqual([]);
    expect(await store.getVerboseMode("chat-1")).toBe(true);
    expect(await store.getThinkingEffort("chat-1")).toBe("medium");
  });

  it("uses active-conversations.json as fallback current index path", async () => {
    const root = createTempDir("acmd-conv-current-fallback-");
    const stashedConversationsPath = path.join(root, ".agent-commander", "stashed-conversations.json");
    const fallbackCurrentPath = path.join(root, ".agent-commander", "active-conversations.json");
    await fs.promises.mkdir(path.dirname(fallbackCurrentPath), { recursive: true });

    fs.writeFileSync(
      fallbackCurrentPath,
      JSON.stringify(
        {
          "chat-1": {
            conversationId: "conv_existing",
            alias: "existing",
            runtime: {
              verboseMode: false,
              thinkingEffort: "high",
              activeModelOverride: null,
              latestUsage: null,
              toolResults: {
                total: 0,
                success: 0,
                fail: 0,
                byTool: {}
              }
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const store = createConversationStore({
      conversationsDir: path.join(root, ".agent-commander", "conversations"),
      stashedConversationsPath
    });

    expect(await store.ensureActiveConversation("chat-1")).toBe("conv_existing");
    expect(await store.getVerboseMode("chat-1")).toBe(false);
    expect(await store.getThinkingEffort("chat-1")).toBe("high");
  });

  it("applies configured runtime defaults to new conversations", async () => {
    const root = createTempDir("acmd-conv-defaults-");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json"),
      defaultVerboseMode: false,
      defaultThinkingEffort: "xhigh"
    });

    await store.ensureActiveConversation("chat-1");
    expect(await store.getVerboseMode("chat-1")).toBe(false);
    expect(await store.getThinkingEffort("chat-1")).toBe("xhigh");
  });

  it("emits full conversation event payloads to observability when enabled", async () => {
    const root = createTempDir("acmd-conv-observe-");
    const observabilityPath = path.join(root, "observability.jsonl");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json"),
      observability: createObservabilitySink({
        enabled: true,
        logPath: observabilityPath
      })
    });

    const conversationId = await store.ensureActiveConversation("chat-1");
    await store.appendUserMessage({
      chatId: "chat-1",
      conversationId,
      telegramMessageId: "m1",
      senderId: "u1",
      senderName: "Ada",
      content: "hello observability"
    });

    const entries = fs
      .readFileSync(observabilityPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const messageEntry = entries.find(
      (entry) =>
        entry.event === "conversation.event.appended" &&
        (entry.payload as { type?: string }).type === "message"
    );

    expect(messageEntry).toBeDefined();
    expect(messageEntry).toEqual(
      expect.objectContaining({
        chatId: "chat-1",
        conversationId,
        eventType: "message"
      })
    );
    expect((messageEntry as { payload: { content?: string } }).payload.content).toBe("hello observability");
  });
});
