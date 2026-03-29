import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createObservabilitySink } from "../src/observability.js";
import {
  activeConversationsIndexPath,
  conversationJsonlPath,
  conversationSnapshotPath
} from "../src/state/conversation-paths.js";
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

    const firstPath = conversationJsonlPath(path.join(root, "conversations"), "archive", "chat-1", first);
    const raw = fs.readFileSync(firstPath, "utf8");
    expect(raw).toContain("conversation_archived");
  });

  it("moves snapshots with stash/restore and deletes them on archive", async () => {
    const root = createTempDir("acmd-conv-snapshot-lifecycle-");
    const conversationsDir = path.join(root, "conversations");
    const store = createConversationStore({
      conversationsDir
    });

    const chatId = "chat-1";
    const conversationId = await store.ensureActiveConversation(chatId);
    const activeSnapshotPath = conversationSnapshotPath(conversationsDir, "active", chatId, conversationId);
    await fs.promises.mkdir(path.dirname(activeSnapshotPath), { recursive: true });
    fs.writeFileSync(activeSnapshotPath, "snapshot-a", "utf8");

    await store.completeStashSelection(chatId, "focus", { type: "new" }, "manual_stash");
    const stashedSnapshotPath = conversationSnapshotPath(conversationsDir, "stashed", chatId, conversationId);
    expect(fs.existsSync(activeSnapshotPath)).toBe(false);
    expect(fs.readFileSync(stashedSnapshotPath, "utf8")).toBe("snapshot-a");

    await store.completeNewSelection(chatId, { type: "stash", conversationId }, "manual_new");
    expect(fs.existsSync(stashedSnapshotPath)).toBe(false);
    expect(fs.readFileSync(activeSnapshotPath, "utf8")).toBe("snapshot-a");

    await store.completeNewSelection(chatId, { type: "new" }, "manual_new");
    expect(fs.existsSync(activeSnapshotPath)).toBe(false);
  });

  it("prunes oldest archived conversations when the archived cap is exceeded", async () => {
    const root = createTempDir("acmd-conv-archive-cap-");
    const conversationsDir = path.join(root, "conversations");
    const store = createConversationStore({
      conversationsDir,
      archivedConversationsMaxCount: 2
    });

    const chatId = "chat-1";
    await store.ensureActiveConversation(chatId);

    const archivedConversationIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await store.completeNewSelection(chatId, { type: "new" }, `manual_new_${index}`);
      if (result.archivedConversationId) {
        archivedConversationIds.push(result.archivedConversationId);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(archivedConversationIds).toHaveLength(3);
    expect(fs.existsSync(conversationJsonlPath(conversationsDir, "archive", chatId, archivedConversationIds[0]!))).toBe(false);
    expect(fs.existsSync(conversationJsonlPath(conversationsDir, "archive", chatId, archivedConversationIds[1]!))).toBe(true);
    expect(fs.existsSync(conversationJsonlPath(conversationsDir, "archive", chatId, archivedConversationIds[2]!))).toBe(true);
  });

  it("stashes current conversation then switches and resets runtime defaults", async () => {
    const root = createTempDir("acmd-conv-stash-switch-");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json"),
      defaultThinkingEffort: "medium"
    });

    const chatId = "chat-1";
    const conversationA = await store.ensureActiveConversation(chatId);

    await store.setWorkingDirectory(chatId, "/tmp/project-focus");
    await store.setThinkingEffort(chatId, "high");
    await store.setCacheRetention(chatId, "24h");
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

    expect(await store.getWorkingDirectory(chatId)).toBe(process.cwd());
    expect(await store.getThinkingEffort(chatId)).toBe("medium");
    expect(await store.getCacheRetention(chatId)).toBe("in_memory");
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
    expect(await store.getWorkingDirectory(chatId)).toBe("/tmp/project-focus");
    expect(await store.getThinkingEffort(chatId)).toBe("high");
    expect(await store.getCacheRetention(chatId)).toBe("24h");
    expect(await store.getActiveModelOverride(chatId)).toBe("gpt-5.3-codex");
    expect(await store.getLatestUsageSnapshot(chatId)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 40,
      reasoningTokens: 10,
      lastCacheHitAt: null
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

    await new Promise((resolve) => setTimeout(resolve, 50));
    await store.completeStashSelection(chatId, "beta", { type: "new" }, "manual_stash");
    const stashesBefore = await store.listStashedConversations(chatId);
    expect(stashesBefore.map((item) => item.alias)).toEqual(["beta", "alpha"]);

    await store.completeNewSelection(chatId, { type: "stash", conversationId: conversationA }, "manual_new");
    const stashesAfter = await store.listStashedConversations(chatId);
    expect(stashesAfter.map((item) => item.alias)).toEqual(["beta"]);
  });

  it("preserves last cache-hit timestamp across no-hit updates and restart", async () => {
    const root = createTempDir("acmd-conv-cache-hit-");
    const conversationsDir = path.join(root, "conversations");
    const stashedConversationsPath = path.join(root, "stashed.json");
    const activeConversationsPath = path.join(root, "active.json");
    const chatId = "chat-1";

    const firstStore = createConversationStore({
      conversationsDir,
      stashedConversationsPath,
      activeConversationsPath
    });
    const conversationId = await firstStore.ensureActiveConversation(chatId);
    const firstHitAt = 1_700_000_000_000;

    await firstStore.setLatestUsageSnapshot(chatId, {
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 10,
      reasoningTokens: 3,
      lastCacheHitAt: firstHitAt
    });
    await firstStore.setLatestUsageSnapshot(chatId, {
      inputTokens: 120,
      outputTokens: 25,
      cachedTokens: 0,
      reasoningTokens: 2,
      lastCacheHitAt: null
    });
    expect(await firstStore.getLatestUsageSnapshot(chatId)).toEqual({
      inputTokens: 120,
      outputTokens: 25,
      cachedTokens: 0,
      reasoningTokens: 2,
      lastCacheHitAt: firstHitAt
    });

    await firstStore.completeStashSelection(chatId, "warm", { type: "new" }, "manual_stash");
    await firstStore.completeNewSelection(chatId, { type: "stash", conversationId }, "manual_new");
    expect(await firstStore.getLatestUsageSnapshot(chatId)).toEqual({
      inputTokens: 120,
      outputTokens: 25,
      cachedTokens: 0,
      reasoningTokens: 2,
      lastCacheHitAt: firstHitAt
    });

    const secondStore = createConversationStore({
      conversationsDir,
      stashedConversationsPath,
      activeConversationsPath
    });
    expect(await secondStore.getLatestUsageSnapshot(chatId)).toEqual({
      inputTokens: 120,
      outputTokens: 25,
      cachedTokens: 0,
      reasoningTokens: 2,
      lastCacheHitAt: firstHitAt
    });
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
    await firstStore.setWorkingDirectory(chatId, "/tmp/project-alpha");
    await firstStore.setCacheRetention(chatId, "24h");

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
    expect(await secondStore.getWorkingDirectory(chatId)).toBe("/tmp/project-alpha");
    expect(await secondStore.getCacheRetention(chatId)).toBe("24h");
  });

  it("persists last provider failure summary across stash and restart", async () => {
    const root = createTempDir("acmd-conv-provider-failure-persist-");
    const conversationsDir = path.join(root, "conversations");
    const stashedConversationsPath = path.join(root, "stashed.json");
    const activeConversationsPath = path.join(root, "active.json");
    const chatId = "chat-1";

    const firstStore = createConversationStore({
      conversationsDir,
      stashedConversationsPath,
      activeConversationsPath
    });

    const conversationId = await firstStore.ensureActiveConversation(chatId);
    await firstStore.setLastProviderFailure(chatId, {
      at: "2026-03-20T08:00:00.000Z",
      kind: "rate_limit",
      statusCode: 429,
      attempts: 2,
      reason: "OpenAI HTTP 429 (rate limit) type=rate_limit_error: retry later."
    });
    expect(await firstStore.getLastProviderFailure(chatId)).toEqual({
      at: "2026-03-20T08:00:00.000Z",
      kind: "rate_limit",
      statusCode: 429,
      attempts: 2,
      reason: "OpenAI HTTP 429 (rate limit) type=rate_limit_error: retry later."
    });

    await firstStore.completeStashSelection(chatId, "ops", { type: "new" }, "manual_stash");
    expect(await firstStore.getLastProviderFailure(chatId)).toBeNull();
    await firstStore.completeNewSelection(chatId, { type: "stash", conversationId }, "manual_new");
    expect(await firstStore.getLastProviderFailure(chatId)).toEqual({
      at: "2026-03-20T08:00:00.000Z",
      kind: "rate_limit",
      statusCode: 429,
      attempts: 2,
      reason: "OpenAI HTTP 429 (rate limit) type=rate_limit_error: retry later."
    });

    const secondStore = createConversationStore({
      conversationsDir,
      stashedConversationsPath,
      activeConversationsPath
    });

    expect(await secondStore.getLastProviderFailure(chatId)).toEqual({
      at: "2026-03-20T08:00:00.000Z",
      kind: "rate_limit",
      statusCode: 429,
      attempts: 2,
      reason: "OpenAI HTTP 429 (rate limit) type=rate_limit_error: retry later."
    });
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
      defaultThinkingEffort: "medium"
    });

    const conversationId = await store.ensureActiveConversation("chat-1");
    expect(conversationId).not.toBe("conv_legacy");
    expect(await store.getThinkingEffort("chat-1")).toBe("medium");
  });

  it("does not migrate old filename layout automatically", async () => {
    const root = createTempDir("acmd-conv-old-layout-");
    const conversationsDir = path.join(root, ".agent-commander", "conversations");
    const newStashedPath = path.join(root, ".agent-commander", "stashed-conversations.json");
    const newCurrentPath = path.join(root, ".agent-commander", "active-conversations.json");
    const oldCurrentPath = path.join(root, ".agent-commander", "current-conversations.json");

    const runtime = {
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
      defaultThinkingEffort: "medium"
    });

    const conversationId = await store.ensureActiveConversation("chat-1");
    expect(conversationId).not.toBe("conv_old_stash");
    expect(conversationId).not.toBe("conv_old_current");
    expect(await store.listStashedConversations("chat-1")).toEqual([]);
    expect(await store.getThinkingEffort("chat-1")).toBe("medium");
  });

  it("loads current conversations from current/active-conversations.json", async () => {
    const root = createTempDir("acmd-conv-current-fallback-");
    const conversationsDir = path.join(root, ".agent-commander", "conversations");
    const currentIndexPath = activeConversationsIndexPath(conversationsDir);
    await fs.promises.mkdir(path.dirname(currentIndexPath), { recursive: true });

    fs.writeFileSync(
      currentIndexPath,
      JSON.stringify(
        {
          "chat-1": {
            conversationId: "conv_existing",
            alias: "existing",
            runtime: {
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
      conversationsDir
    });

    expect(await store.ensureActiveConversation("chat-1")).toBe("conv_existing");
    expect(await store.getThinkingEffort("chat-1")).toBe("high");
  });

  it("applies configured runtime defaults to new conversations", async () => {
    const root = createTempDir("acmd-conv-defaults-");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json"),
      defaultWorkingDirectory: "/tmp/default-cwd",
      defaultThinkingEffort: "xhigh"
    });

    await store.ensureActiveConversation("chat-1");
    expect(await store.getWorkingDirectory("chat-1")).toBe("/tmp/default-cwd");
    expect(await store.getThinkingEffort("chat-1")).toBe("xhigh");
    expect(await store.getCacheRetention("chat-1")).toBe("in_memory");
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

  it("skips malformed JSONL lines instead of failing to load", async () => {
    const root = createTempDir("acmd-conv-malformed-");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json")
    });

    const conversationId = await store.ensureActiveConversation("chat-1");

    await store.appendUserMessageAndGetPromptContext({
      chatId: "chat-1",
      conversationId,
      telegramMessageId: "m1",
      senderId: "u1",
      senderName: "Ada",
      content: "first message",
      historyLimit: null
    });

    // Inject a malformed line directly into the JSONL file
    const jsonlPath = conversationJsonlPath(path.join(root, "conversations"), "active", "chat-1", conversationId);
    fs.appendFileSync(jsonlPath, "{corrupted json line\n");

    await store.appendAssistantMessage({
      chatId: "chat-1",
      conversationId,
      content: "second message"
    });

    // Force cache eviction by creating a new store instance
    const freshStore = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json")
    });
    const activeConvId = await freshStore.ensureActiveConversation("chat-1");
    expect(activeConvId).toBe(conversationId);

    const ctx = await freshStore.appendUserMessageAndGetPromptContext({
      chatId: "chat-1",
      conversationId,
      telegramMessageId: "m2",
      senderId: "u1",
      senderName: "Ada",
      content: "third message",
      historyLimit: null
    });

    // The malformed line should be skipped; we should see first, second, third messages
    const contents = ctx.historyAfterAppend.map((m) => m.content);
    expect(contents).toContain("first message");
    expect(contents).toContain("second message");
    expect(contents).toContain("third message");
  });

  it("keeps only current and stashed conversations resident in the session cache", async () => {
    const root = createTempDir("acmd-conv-cache-eligibility-");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json"),
      sessionCacheMaxEntries: 10
    });

    const chatId = "chat-1";
    const firstConversationId = await store.ensureActiveConversation(chatId);

    await store.getPromptHistory(chatId, firstConversationId, null);
    expect(store.getHealth().cachedSessions).toBe(1);

    const stashed = await store.completeStashSelection(chatId, "focus", { type: "new" }, "manual_stash");
    await store.getPromptHistory(chatId, stashed.stashedConversationId, null);
    await store.getPromptHistory(chatId, stashed.conversationId, null);
    expect(store.getHealth().cachedSessions).toBe(2);

    const archivedConversationId = stashed.conversationId;
    await store.completeNewSelection(chatId, { type: "new" }, "manual_new");

    const afterNew = store.getHealth();
    expect(afterNew.cachedSessions).toBe(1);

    await store.getPromptHistory(chatId, archivedConversationId, null);
    const afterArchivedRead = store.getHealth();
    expect(afterArchivedRead.cachedSessions).toBe(1);
    expect(afterArchivedRead.evictedSessions).toBe(afterNew.evictedSessions);
  });

  it("keeps a cached conversation resident when it transitions from current to stashed", async () => {
    const root = createTempDir("acmd-conv-cache-stash-transition-");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json"),
      sessionCacheMaxEntries: 10
    });

    const chatId = "chat-1";
    const firstConversationId = await store.ensureActiveConversation(chatId);

    await store.getPromptHistory(chatId, firstConversationId, null);
    expect(store.getHealth().cachedSessions).toBe(1);

    const result = await store.completeStashSelection(chatId, "focus", { type: "new" }, "manual_stash");
    expect(result.stashedConversationId).toBe(firstConversationId);
    expect(store.getHealth().cachedSessions).toBe(1);

    await store.getPromptHistory(chatId, result.stashedConversationId, null);
    expect(store.getHealth().cachedSessions).toBe(1);

    await store.getPromptHistory(chatId, result.conversationId, null);
    expect(store.getHealth().cachedSessions).toBe(2);
  });

  it("applies session cache eviction only across eligible current and stashed conversations", async () => {
    const root = createTempDir("acmd-conv-cache-cap-");
    const store = createConversationStore({
      conversationsDir: path.join(root, "conversations"),
      stashedConversationsPath: path.join(root, "active.json"),
      sessionCacheMaxEntries: 2
    });

    const firstChat = "chat-1";
    const firstConversationId = await store.ensureActiveConversation(firstChat);
    await store.getPromptHistory(firstChat, firstConversationId, null);

    const stashed = await store.completeStashSelection(firstChat, "alpha", { type: "new" }, "manual_stash");
    await store.getPromptHistory(firstChat, stashed.stashedConversationId, null);
    await store.getPromptHistory(firstChat, stashed.conversationId, null);

    const secondChat = "chat-2";
    const secondConversationId = await store.ensureActiveConversation(secondChat);
    await store.getPromptHistory(secondChat, secondConversationId, null);

    const health = store.getHealth();
    expect(health.cachedSessions).toBe(2);
    expect(health.maxCachedSessions).toBe(2);
    expect(health.evictedSessions).toBeGreaterThanOrEqual(1);
  });
});
