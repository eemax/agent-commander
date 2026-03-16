import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createConversationId } from "../id.js";
import type { StashedConversationSummary, StateStore, ToolResultStats } from "../runtime/contracts.js";
import {
  createChildTraceContext,
  createTraceRootContext,
  type ObservabilitySink,
  type TraceContext
} from "../observability.js";
import {
  THINKING_EFFORT_VALUES,
  type PromptMessage,
  type ProviderErrorKind,
  type ProviderUsageSnapshot,
  type ThinkingEffort
} from "../types.js";
import {
  type ConversationArchiveEvent,
  type ConversationCreatedEvent,
  type ConversationEvent,
  type MessageEvent,
  type ProviderFailureEvent,
  parseConversationEvent,
  serializeConversationEvent
} from "./events.js";

type ConversationRuntimeProfile = {
  verboseMode: boolean;
  thinkingEffort: ThinkingEffort;
  activeModelOverride: string | null;
  activeWebSearchModelOverride: string | null;
  latestUsage: ProviderUsageSnapshot | null;
  toolResults: ToolResultStats;
  compactionCount: number;
};

type CurrentConversationRecord = {
  conversationId: string;
  alias: string | null;
  runtime: ConversationRuntimeProfile;
};

type StashedConversationRecord = {
  conversationId: string;
  alias: string;
  stashedAt: string;
  runtime: ConversationRuntimeProfile;
};

type ActiveConversationsIndex = Record<string, StashedConversationRecord[]>;
type CurrentConversationsIndex = Record<string, CurrentConversationRecord>;

type ConversationSessionCache = {
  events: ConversationEvent[];
  promptMessages: PromptMessage[];
  promptMessageCount: number;
  lastAccessMs: number;
};

type ConversationStoreParams = {
  conversationsDir: string;
  stashedConversationsPath: string;
  activeConversationsPath?: string;
  defaultVerboseMode?: boolean;
  defaultThinkingEffort?: ThinkingEffort;
  sessionCacheMaxEntries?: number;
  observability?: ObservabilitySink;
};

function toChatFolder(chatId: string): string {
  return encodeURIComponent(chatId);
}

function toCacheKey(chatId: string, conversationId: string): string {
  return `${chatId}\u0000${conversationId}`;
}

function toPromptMessage(event: MessageEvent): PromptMessage {
  return {
    role: event.role,
    content: event.content,
    createdAt: event.timestamp,
    senderId: event.senderId,
    senderName: event.senderName
  };
}

function getBoundedHistory(messages: PromptMessage[], limit: number | null): PromptMessage[] {
  if (limit === null) {
    return [...messages];
  }

  if (messages.length <= limit) {
    return [...messages];
  }

  return messages.slice(messages.length - limit);
}

async function atomicWriteJson(targetPath: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, targetPath);
}

const THINKING_EFFORT_SET: ReadonlySet<string> = new Set(THINKING_EFFORT_VALUES);

function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return typeof value === "string" && THINKING_EFFORT_SET.has(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isUsageNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isUsageNumberOrUndefined(value: unknown): value is number | null | undefined {
  return value === undefined || isUsageNumber(value);
}

function isUsageSnapshot(value: unknown): value is ProviderUsageSnapshot {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    isUsageNumber(value.inputTokens) &&
    isUsageNumber(value.outputTokens) &&
    isUsageNumber(value.cachedTokens) &&
    isUsageNumber(value.reasoningTokens) &&
    isUsageNumberOrUndefined(value.peakInputTokens) &&
    isUsageNumberOrUndefined(value.peakOutputTokens) &&
    isUsageNumberOrUndefined(value.peakContextTokens) &&
    isUsageNumberOrUndefined(value.lastCacheHitAt)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isToolResultByToolRecord(value: unknown): value is Record<string, number> {
  if (!isPlainObject(value)) {
    return false;
  }

  return Object.values(value).every((entry) => isNonNegativeInteger(entry));
}

function isToolResultStatsRecord(value: unknown): value is ToolResultStats {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    isNonNegativeInteger(value.total) &&
    isNonNegativeInteger(value.success) &&
    isNonNegativeInteger(value.fail) &&
    isToolResultByToolRecord(value.byTool)
  );
}

function createEmptyToolResultStats(): ToolResultStats {
  return {
    total: 0,
    success: 0,
    fail: 0,
    byTool: {}
  };
}

function cloneToolResultStats(stats: ToolResultStats): ToolResultStats {
  return {
    total: stats.total,
    success: stats.success,
    fail: stats.fail,
    byTool: { ...stats.byTool }
  };
}

function cloneUsageSnapshot(snapshot: ProviderUsageSnapshot): ProviderUsageSnapshot {
  return { ...snapshot };
}

function createDefaultRuntimeProfile(params: {
  defaultVerboseMode: boolean;
  defaultThinkingEffort: ThinkingEffort;
}): ConversationRuntimeProfile {
  return {
    verboseMode: params.defaultVerboseMode,
    thinkingEffort: params.defaultThinkingEffort,
    activeModelOverride: null,
    activeWebSearchModelOverride: null,
    latestUsage: null,
    toolResults: createEmptyToolResultStats(),
    compactionCount: 0
  };
}

function cloneRuntimeProfile(profile: ConversationRuntimeProfile): ConversationRuntimeProfile {
  return {
    verboseMode: profile.verboseMode,
    thinkingEffort: profile.thinkingEffort,
    activeModelOverride: profile.activeModelOverride,
    activeWebSearchModelOverride: profile.activeWebSearchModelOverride,
    latestUsage: profile.latestUsage ? cloneUsageSnapshot(profile.latestUsage) : null,
    toolResults: cloneToolResultStats(profile.toolResults),
    compactionCount: profile.compactionCount
  };
}

function normalizeRuntimeProfile(
  value: unknown,
  defaults: {
    defaultVerboseMode: boolean;
    defaultThinkingEffort: ThinkingEffort;
  }
): ConversationRuntimeProfile | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const activeModelOverrideRaw = value.activeModelOverride;
  const activeModelOverride =
    typeof activeModelOverrideRaw === "string" && activeModelOverrideRaw.trim().length > 0
      ? activeModelOverrideRaw.trim()
      : null;

  const activeWebSearchModelOverrideRaw = value.activeWebSearchModelOverride;
  const activeWebSearchModelOverride =
    typeof activeWebSearchModelOverrideRaw === "string" && activeWebSearchModelOverrideRaw.trim().length > 0
      ? activeWebSearchModelOverrideRaw.trim()
      : null;

  return {
    verboseMode: typeof value.verboseMode === "boolean" ? value.verboseMode : defaults.defaultVerboseMode,
    thinkingEffort: isThinkingEffort(value.thinkingEffort) ? value.thinkingEffort : defaults.defaultThinkingEffort,
    activeModelOverride,
    activeWebSearchModelOverride,
    latestUsage: isUsageSnapshot(value.latestUsage) ? cloneUsageSnapshot(value.latestUsage) : null,
    toolResults: isToolResultStatsRecord(value.toolResults) ? cloneToolResultStats(value.toolResults) : createEmptyToolResultStats(),
    compactionCount: isNonNegativeInteger(value.compactionCount) ? value.compactionCount : 0
  };
}

function parseCurrentConversationsIndex(
  raw: string,
  defaults: {
    defaultVerboseMode: boolean;
    defaultThinkingEffort: ThinkingEffort;
  }
): CurrentConversationsIndex {
  const parsed = JSON.parse(raw) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error("invalid current conversation index format");
  }

  const normalized: CurrentConversationsIndex = {};
  for (const [chatId, entry] of Object.entries(parsed)) {
    if (!isPlainObject(entry)) {
      continue;
    }

    const conversationId = normalizeNonEmptyString(entry.conversationId);
    if (!conversationId) {
      continue;
    }

    const aliasRaw = entry.alias;
    const alias = aliasRaw === null ? null : normalizeNonEmptyString(aliasRaw);
    const runtime = normalizeRuntimeProfile(entry.runtime, defaults);
    if (!runtime) {
      continue;
    }

    normalized[chatId] = {
      conversationId,
      alias,
      runtime
    };
  }

  return normalized;
}

function parseActiveConversationsIndex(
  raw: string,
  defaults: {
    defaultVerboseMode: boolean;
    defaultThinkingEffort: ThinkingEffort;
  }
): ActiveConversationsIndex {
  const parsed = JSON.parse(raw) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error("invalid active conversation index format");
  }

  const normalized: ActiveConversationsIndex = {};
  for (const [chatId, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) {
      continue;
    }

    const entries: StashedConversationRecord[] = [];
    for (const item of value) {
      if (!isPlainObject(item)) {
        continue;
      }

      const conversationId = normalizeNonEmptyString(item.conversationId);
      const alias = normalizeNonEmptyString(item.alias);
      const stashedAt = normalizeNonEmptyString(item.stashedAt);
      const runtime = normalizeRuntimeProfile(item.runtime, defaults);
      if (!conversationId || !alias || !stashedAt || !runtime) {
        continue;
      }

      entries.push({
        conversationId,
        alias,
        stashedAt,
        runtime
      });
    }

    if (entries.length > 0) {
      normalized[chatId] = entries;
    }
  }

  return normalized;
}

function cloneActiveConversationsIndex(index: ActiveConversationsIndex): ActiveConversationsIndex {
  const cloned: ActiveConversationsIndex = {};
  for (const [chatId, stashes] of Object.entries(index)) {
    cloned[chatId] = stashes.map((stash) => ({
      conversationId: stash.conversationId,
      alias: stash.alias,
      stashedAt: stash.stashedAt,
      runtime: cloneRuntimeProfile(stash.runtime)
    }));
  }
  return cloned;
}

function sortStashes(stashes: StashedConversationRecord[]): StashedConversationRecord[] {
  return [...stashes].sort((left, right) => {
    if (left.stashedAt !== right.stashedAt) {
      return right.stashedAt.localeCompare(left.stashedAt);
    }
    if (left.alias !== right.alias) {
      return left.alias.localeCompare(right.alias);
    }
    return left.conversationId.localeCompare(right.conversationId);
  });
}

function resolveStashAlias(baseAlias: string, existingAliases: ReadonlySet<string>): string {
  if (!existingAliases.has(baseAlias)) {
    return baseAlias;
  }

  let suffix = 2;
  while (existingAliases.has(`${baseAlias}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseAlias}-${suffix}`;
}

function toStashSummary(item: StashedConversationRecord): StashedConversationSummary {
  return {
    conversationId: item.conversationId,
    alias: item.alias,
    stashedAt: item.stashedAt
  };
}

export type ConversationStore = StateStore;

export function createConversationStore(params: ConversationStoreParams): ConversationStore {
  const sessionCacheMaxEntries = params.sessionCacheMaxEntries ?? 200;
  const activeConversationsPath =
    params.activeConversationsPath ??
    path.join(path.dirname(params.stashedConversationsPath), "active-conversations.json");
  const defaults = {
    defaultVerboseMode: params.defaultVerboseMode ?? true,
    defaultThinkingEffort: params.defaultThinkingEffort ?? "medium"
  };

  let activeConversationsCache: ActiveConversationsIndex | null = null;
  let currentConversationsCache: CurrentConversationsIndex | null = null;
  let mutationQueue: Promise<unknown> = Promise.resolve();
  let evictedSessions = 0;

  const sessionCache = new Map<string, ConversationSessionCache>();
  const appendQueues = new Map<string, Promise<unknown>>();
  const ensuredConversationDirs = new Map<string, Promise<void>>();

  const conversationPath = (chatId: string, conversationId: string): string => {
    return path.join(params.conversationsDir, toChatFolder(chatId), `${conversationId}.jsonl`);
  };

  const ensureConversationDir = async (dirPath: string): Promise<void> => {
    let pending = ensuredConversationDirs.get(dirPath);
    if (!pending) {
      pending = fs
        .mkdir(dirPath, { recursive: true })
        .then(() => undefined)
        .catch((error) => {
          ensuredConversationDirs.delete(dirPath);
          throw error;
        });
      ensuredConversationDirs.set(dirPath, pending);
    }
    await pending;
  };

  const touchSession = (cacheKey: string): ConversationSessionCache => {
    const session = sessionCache.get(cacheKey);
    if (!session) {
      throw new Error(`Missing session cache for ${cacheKey}`);
    }

    session.lastAccessMs = Date.now();
    return session;
  };

  const pruneSessionCache = (): void => {
    if (sessionCache.size <= sessionCacheMaxEntries) {
      return;
    }

    const candidates = Array.from(sessionCache.entries())
      .map(([key, value]) => ({
        key,
        lastAccessMs: value.lastAccessMs
      }))
      .sort((left, right) => {
        if (left.lastAccessMs !== right.lastAccessMs) {
          return left.lastAccessMs - right.lastAccessMs;
        }
        return left.key.localeCompare(right.key);
      });

    const overflow = sessionCache.size - sessionCacheMaxEntries;
    for (let index = 0; index < overflow; index += 1) {
      const target = candidates[index];
      if (!target) {
        continue;
      }
      sessionCache.delete(target.key);
      evictedSessions += 1;
    }
  };

  const applyEventToSession = (session: ConversationSessionCache, event: ConversationEvent): void => {
    session.events.push(event);
    if (event.type === "message") {
      session.promptMessageCount += 1;
      session.promptMessages.push(toPromptMessage(event));
    }
    session.lastAccessMs = Date.now();
  };

  const loadActiveConversations = async (): Promise<ActiveConversationsIndex> => {
    if (activeConversationsCache) {
      return activeConversationsCache;
    }

    try {
      const raw = await fs.readFile(params.stashedConversationsPath, "utf8");
      activeConversationsCache = parseActiveConversationsIndex(raw, defaults);
      return activeConversationsCache;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        activeConversationsCache = {};
        return activeConversationsCache;
      }
      activeConversationsCache = {};
      return activeConversationsCache;
    }
  };

  const saveActiveConversations = async (next: ActiveConversationsIndex): Promise<void> => {
    activeConversationsCache = next;
    await atomicWriteJson(params.stashedConversationsPath, cloneActiveConversationsIndex(next));
  };

  const loadCurrentConversations = async (): Promise<CurrentConversationsIndex> => {
    if (currentConversationsCache) {
      return currentConversationsCache;
    }

    try {
      const raw = await fs.readFile(activeConversationsPath, "utf8");
      currentConversationsCache = parseCurrentConversationsIndex(raw, defaults);
      return currentConversationsCache;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        currentConversationsCache = {};
        return currentConversationsCache;
      }
      currentConversationsCache = {};
      return currentConversationsCache;
    }
  };

  const saveCurrentConversations = async (next: CurrentConversationsIndex): Promise<void> => {
    currentConversationsCache = next;
    await atomicWriteJson(activeConversationsPath, next);
  };

  const loadConversationSession = async (chatId: string, conversationId: string): Promise<ConversationSessionCache> => {
    const cacheKey = toCacheKey(chatId, conversationId);
    const cached = sessionCache.get(cacheKey);
    if (cached) {
      return touchSession(cacheKey);
    }

    const target = conversationPath(chatId, conversationId);
    let raw: string;

    try {
      raw = await fs.readFile(target, "utf8");
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        const emptySession: ConversationSessionCache = {
          events: [],
          promptMessages: [],
          promptMessageCount: 0,
          lastAccessMs: Date.now()
        };
        sessionCache.set(cacheKey, emptySession);
        pruneSessionCache();
        return emptySession;
      }
      throw error;
    }

    const events: ConversationEvent[] = [];
    const promptMessages: PromptMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const event = parseConversationEvent(trimmed, target);
      events.push(event);
      if (event.type === "message") {
        promptMessages.push(toPromptMessage(event));
      }
    }

    const session: ConversationSessionCache = {
      events,
      promptMessages,
      promptMessageCount: promptMessages.length,
      lastAccessMs: Date.now()
    };
    sessionCache.set(cacheKey, session);
    pruneSessionCache();
    return session;
  };

  const enqueueMutation = async <T>(task: () => Promise<T>): Promise<T> => {
    const queued = mutationQueue.catch(() => undefined).then(task);
    mutationQueue = queued.catch(() => undefined);
    return queued;
  };

  const enqueueConversationAppend = async <T>(
    chatId: string,
    conversationId: string,
    task: () => Promise<T>
  ): Promise<T> => {
    const cacheKey = toCacheKey(chatId, conversationId);
    const queued = (appendQueues.get(cacheKey) ?? Promise.resolve()).catch(() => undefined).then(task);
    appendQueues.set(cacheKey, queued);

    try {
      return await queued;
    } finally {
      if (appendQueues.get(cacheKey) === queued) {
        appendQueues.delete(cacheKey);
      }
    }
  };

  const awaitPendingAppend = async (chatId: string, conversationId: string): Promise<void> => {
    const queue = appendQueues.get(toCacheKey(chatId, conversationId));
    if (queue) {
      await queue.catch(() => undefined);
    }
  };

  const appendEventInternal = async (
    chatId: string,
    conversationId: string,
    event: ConversationEvent,
    trace?: TraceContext
  ): Promise<void> => {
    const target = conversationPath(chatId, conversationId);
    await ensureConversationDir(path.dirname(target));
    await fs.appendFile(target, `${serializeConversationEvent(event)}\n`, "utf8");

    const cacheKey = toCacheKey(chatId, conversationId);
    const session = sessionCache.get(cacheKey);
    if (session) {
      applyEventToSession(session, event);
    }

    await params.observability?.record({
      event: "conversation.event.appended",
      trace: trace ? createChildTraceContext(trace, "state") : createTraceRootContext("state"),
      stage: "completed",
      chatId,
      conversationId,
      eventType: event.type,
      payload: event
    });
  };

  const createConversation = async (chatId: string, reason: string, trace?: TraceContext): Promise<string> => {
    const conversationId = createConversationId();
    const event: ConversationCreatedEvent = {
      type: "conversation_created",
      timestamp: new Date().toISOString(),
      chatId,
      conversationId,
      reason
    };

    await appendEventInternal(chatId, conversationId, event, trace);
    return conversationId;
  };

  const ensureCurrentConversationRecord = async (
    chatId: string,
    reason: string,
    trace?: TraceContext
  ): Promise<{ index: CurrentConversationsIndex; record: CurrentConversationRecord }> => {
    const current = await loadCurrentConversations();
    const existing = current[chatId];
    if (existing) {
      return {
        index: current,
        record: existing
      };
    }

    const conversationId = await createConversation(chatId, reason, trace);
    const record: CurrentConversationRecord = {
      conversationId,
      alias: null,
      runtime: createDefaultRuntimeProfile(defaults)
    };

    const next: CurrentConversationsIndex = {
      ...current,
      [chatId]: record
    };
    await saveCurrentConversations(next);
    return {
      index: next,
      record
    };
  };

  const saveStashesForChat = async (chatId: string, stashes: StashedConversationRecord[]): Promise<void> => {
    const index = await loadActiveConversations();
    const next = {
      ...index
    };
    if (stashes.length === 0) {
      delete next[chatId];
    } else {
      next[chatId] = sortStashes(stashes);
    }
    await saveActiveConversations(next);
  };

  return {
    async ensureActiveConversation(chatId): Promise<string> {
      return enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        return ensured.record.conversationId;
      });
    },

    async getActiveConversation(chatId): Promise<string | null> {
      const index = await loadCurrentConversations();
      return index[chatId]?.conversationId ?? null;
    },

    async getVerboseMode(chatId): Promise<boolean> {
      return enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        return ensured.record.runtime.verboseMode;
      });
    },

    async getThinkingEffort(chatId): Promise<ThinkingEffort> {
      return enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        return ensured.record.runtime.thinkingEffort;
      });
    },

    async setVerboseMode(chatId, enabled, options): Promise<void> {
      await enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start", options?.trace);
        if (ensured.record.runtime.verboseMode === enabled) {
          return;
        }

        const nextCurrent = {
          ...ensured.index,
          [chatId]: {
            ...ensured.record,
            runtime: {
              ...ensured.record.runtime,
              verboseMode: enabled
            }
          }
        };

        await saveCurrentConversations(nextCurrent);
        await params.observability?.record({
          event: "runtime.setting.updated",
          trace: options?.trace ? createChildTraceContext(options.trace, "state") : createTraceRootContext("state"),
          stage: "completed",
          chatId,
          conversationId: ensured.record.conversationId,
          setting: "verboseMode",
          value: enabled
        });
      });
    },

    async setThinkingEffort(chatId, effort, options): Promise<void> {
      await enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start", options?.trace);
        if (ensured.record.runtime.thinkingEffort === effort) {
          return;
        }

        const nextCurrent = {
          ...ensured.index,
          [chatId]: {
            ...ensured.record,
            runtime: {
              ...ensured.record.runtime,
              thinkingEffort: effort
            }
          }
        };

        await saveCurrentConversations(nextCurrent);
        await params.observability?.record({
          event: "runtime.setting.updated",
          trace: options?.trace ? createChildTraceContext(options.trace, "state") : createTraceRootContext("state"),
          stage: "completed",
          chatId,
          conversationId: ensured.record.conversationId,
          setting: "thinkingEffort",
          value: effort
        });
      });
    },

    async getActiveModelOverride(chatId): Promise<string | null> {
      return enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        return ensured.record.runtime.activeModelOverride;
      });
    },

    async setActiveModelOverride(chatId, modelId: string | null, options): Promise<void> {
      await enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start", options?.trace);
        const trimmed = modelId === null ? "" : modelId.trim();
        const normalizedModelId = trimmed.length > 0 ? trimmed : null;
        if (ensured.record.runtime.activeModelOverride === normalizedModelId) {
          return;
        }

        const nextCurrent = {
          ...ensured.index,
          [chatId]: {
            ...ensured.record,
            runtime: {
              ...ensured.record.runtime,
              activeModelOverride: normalizedModelId
            }
          }
        };

        await saveCurrentConversations(nextCurrent);
        await params.observability?.record({
          event: "runtime.setting.updated",
          trace: options?.trace ? createChildTraceContext(options.trace, "state") : createTraceRootContext("state"),
          stage: "completed",
          chatId,
          conversationId: ensured.record.conversationId,
          setting: "activeModelOverride",
          value: normalizedModelId
        });
      });
    },

    async getActiveWebSearchModelOverride(chatId): Promise<string | null> {
      return enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        return ensured.record.runtime.activeWebSearchModelOverride;
      });
    },

    async setActiveWebSearchModelOverride(chatId, modelId: string | null, options): Promise<void> {
      await enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start", options?.trace);
        const trimmed = modelId === null ? "" : modelId.trim();
        const normalizedModelId = trimmed.length > 0 ? trimmed : null;
        if (ensured.record.runtime.activeWebSearchModelOverride === normalizedModelId) {
          return;
        }

        const nextCurrent = {
          ...ensured.index,
          [chatId]: {
            ...ensured.record,
            runtime: {
              ...ensured.record.runtime,
              activeWebSearchModelOverride: normalizedModelId
            }
          }
        };

        await saveCurrentConversations(nextCurrent);
        await params.observability?.record({
          event: "runtime.setting.updated",
          trace: options?.trace ? createChildTraceContext(options.trace, "state") : createTraceRootContext("state"),
          stage: "completed",
          chatId,
          conversationId: ensured.record.conversationId,
          setting: "activeWebSearchModelOverride",
          value: normalizedModelId
        });
      });
    },

    async getLatestUsageSnapshot(chatId): Promise<ProviderUsageSnapshot | null> {
      return enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        const snapshot = ensured.record.runtime.latestUsage;
        return snapshot ? cloneUsageSnapshot(snapshot) : null;
      });
    },

    async setLatestUsageSnapshot(chatId, usage): Promise<void> {
      await enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        const nextCurrent = {
          ...ensured.index,
          [chatId]: {
            ...ensured.record,
            runtime: {
              ...ensured.record.runtime,
              latestUsage: cloneUsageSnapshot(usage)
            }
          }
        };

        await saveCurrentConversations(nextCurrent);
      });
    },

    async getToolResultStats(chatId): Promise<ToolResultStats> {
      return enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        return cloneToolResultStats(ensured.record.runtime.toolResults);
      });
    },

    async recordToolResult(chatId, event): Promise<void> {
      await enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        const existing = ensured.record.runtime.toolResults;
        const normalizedTool = event.tool.trim();
        const nextByTool =
          normalizedTool.length > 0
            ? {
                ...existing.byTool,
                [normalizedTool]: (existing.byTool[normalizedTool] ?? 0) + 1
              }
            : { ...existing.byTool };
        const nextStats: ToolResultStats = {
          total: existing.total + 1,
          success: existing.success + (event.success ? 1 : 0),
          fail: existing.fail + (event.success ? 0 : 1),
          byTool: nextByTool
        };

        const nextCurrent = {
          ...ensured.index,
          [chatId]: {
            ...ensured.record,
            runtime: {
              ...ensured.record.runtime,
              toolResults: nextStats
            }
          }
        };

        await saveCurrentConversations(nextCurrent);
      });
    },

    async getCompactionCount(chatId): Promise<number> {
      return enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        return ensured.record.runtime.compactionCount;
      });
    },

    async incrementCompactionCount(chatId): Promise<number> {
      return enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        const nextCount = ensured.record.runtime.compactionCount + 1;
        const nextCurrent = {
          ...ensured.index,
          [chatId]: {
            ...ensured.record,
            runtime: {
              ...ensured.record.runtime,
              compactionCount: nextCount
            }
          }
        };

        await saveCurrentConversations(nextCurrent);
        return nextCount;
      });
    },

    async listStashedConversations(chatId): Promise<StashedConversationSummary[]> {
      return enqueueMutation(async () => {
        const stashes = await loadActiveConversations();
        return sortStashes(stashes[chatId] ?? []).map((item) => toStashSummary(item));
      });
    },

    async completeNewSelection(chatId, target, reason, options): Promise<{
      archivedConversationId: string | null;
      conversationId: string;
      alias: string | null;
    }> {
      return enqueueMutation(async () => {
        const currentIndex = await loadCurrentConversations();
        const activeIndex = await loadActiveConversations();

        const existingCurrent = currentIndex[chatId] ?? null;
        let archivedConversationId: string | null = null;

        if (existingCurrent) {
          archivedConversationId = existingCurrent.conversationId;
          const archiveEvent: ConversationArchiveEvent = {
            type: "conversation_archived",
            timestamp: new Date().toISOString(),
            chatId,
            conversationId: existingCurrent.conversationId,
            reason
          };

          await enqueueConversationAppend(chatId, existingCurrent.conversationId, async () => {
            await appendEventInternal(chatId, existingCurrent.conversationId, archiveEvent, options?.trace);
          });
        }

        const stashes = sortStashes(activeIndex[chatId] ?? []);
        let nextCurrent: CurrentConversationRecord;
        let nextStashes = [...stashes];

        if (target.type === "new") {
          const conversationId = await createConversation(chatId, reason, options?.trace);
          nextCurrent = {
            conversationId,
            alias: null,
            runtime: createDefaultRuntimeProfile(defaults)
          };
        } else {
          const selected = stashes.find((item) => item.conversationId === target.conversationId);
          if (!selected) {
            throw new Error("stashed conversation not found");
          }

          nextCurrent = {
            conversationId: selected.conversationId,
            alias: selected.alias,
            runtime: cloneRuntimeProfile(selected.runtime)
          };
          nextStashes = stashes.filter((item) => item.conversationId !== selected.conversationId);
        }

        const nextCurrentIndex = {
          ...currentIndex,
          [chatId]: nextCurrent
        };
        await saveCurrentConversations(nextCurrentIndex);
        await saveStashesForChat(chatId, nextStashes);

        return {
          archivedConversationId,
          conversationId: nextCurrent.conversationId,
          alias: nextCurrent.alias
        };
      });
    },

    async completeStashSelection(chatId, alias, target, reason, options): Promise<{
      stashedConversationId: string;
      stashedAlias: string;
      conversationId: string;
      alias: string | null;
    }> {
      return enqueueMutation(async () => {
        const normalizedAlias = alias.trim();
        if (normalizedAlias.length === 0) {
          throw new Error("stash alias is required");
        }

        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start", options?.trace);
        const activeIndex = await loadActiveConversations();
        const current = ensured.record;

        const stashes = sortStashes(activeIndex[chatId] ?? []);
        const withoutCurrent = stashes.filter((item) => item.conversationId !== current.conversationId);
        const existingAliases = new Set(withoutCurrent.map((item) => item.alias));
        const resolvedAlias = resolveStashAlias(normalizedAlias, existingAliases);

        const stashedRecord: StashedConversationRecord = {
          conversationId: current.conversationId,
          alias: resolvedAlias,
          stashedAt: new Date().toISOString(),
          runtime: cloneRuntimeProfile(current.runtime)
        };

        let nextStashes = sortStashes([...withoutCurrent, stashedRecord]);
        let nextCurrent: CurrentConversationRecord;

        if (target.type === "new") {
          const conversationId = await createConversation(chatId, reason, options?.trace);
          nextCurrent = {
            conversationId,
            alias: null,
            runtime: createDefaultRuntimeProfile(defaults)
          };
        } else {
          const selected = nextStashes.find((item) => item.conversationId === target.conversationId);
          if (!selected) {
            throw new Error("stashed conversation not found");
          }

          nextCurrent = {
            conversationId: selected.conversationId,
            alias: selected.alias,
            runtime: cloneRuntimeProfile(selected.runtime)
          };
          nextStashes = nextStashes.filter((item) => item.conversationId !== selected.conversationId);
        }

        const nextCurrentIndex = {
          ...ensured.index,
          [chatId]: nextCurrent
        };
        await saveCurrentConversations(nextCurrentIndex);
        await saveStashesForChat(chatId, nextStashes);

        return {
          stashedConversationId: stashedRecord.conversationId,
          stashedAlias: stashedRecord.alias,
          conversationId: nextCurrent.conversationId,
          alias: nextCurrent.alias
        };
      });
    },

    async appendUserMessageAndGetPromptContext(paramsInput): Promise<{
      promptCountBeforeAppend: number;
      historyAfterAppend: PromptMessage[];
    }> {
      return enqueueConversationAppend(paramsInput.chatId, paramsInput.conversationId, async () => {
        const session = await loadConversationSession(paramsInput.chatId, paramsInput.conversationId);
        const promptCountBeforeAppend = session.promptMessageCount;

        const event: MessageEvent = {
          type: "message",
          timestamp: new Date().toISOString(),
          chatId: paramsInput.chatId,
          conversationId: paramsInput.conversationId,
          role: "user",
          content: paramsInput.content,
          senderId: paramsInput.senderId,
          senderName: paramsInput.senderName,
          telegramMessageId: paramsInput.telegramMessageId
        };

        await appendEventInternal(paramsInput.chatId, paramsInput.conversationId, event, paramsInput.trace);
        const historyAfterAppend = getBoundedHistory(session.promptMessages, paramsInput.historyLimit);
        return {
          promptCountBeforeAppend,
          historyAfterAppend
        };
      });
    },

    async appendUserMessage(paramsInput): Promise<void> {
      await enqueueConversationAppend(paramsInput.chatId, paramsInput.conversationId, async () => {
        const event: MessageEvent = {
          type: "message",
          timestamp: new Date().toISOString(),
          chatId: paramsInput.chatId,
          conversationId: paramsInput.conversationId,
          role: "user",
          content: paramsInput.content,
          senderId: paramsInput.senderId,
          senderName: paramsInput.senderName,
          telegramMessageId: paramsInput.telegramMessageId
        };

        await appendEventInternal(paramsInput.chatId, paramsInput.conversationId, event, paramsInput.trace);
      });
    },

    async appendAssistantMessage(paramsInput): Promise<void> {
      await enqueueConversationAppend(paramsInput.chatId, paramsInput.conversationId, async () => {
        const event: MessageEvent = {
          type: "message",
          timestamp: new Date().toISOString(),
          chatId: paramsInput.chatId,
          conversationId: paramsInput.conversationId,
          role: "assistant",
          content: paramsInput.content,
          senderId: null,
          senderName: null,
          telegramMessageId: null
        };

        await appendEventInternal(paramsInput.chatId, paramsInput.conversationId, event, paramsInput.trace);
      });
    },

    async appendProviderFailure(paramsInput): Promise<void> {
      await enqueueConversationAppend(paramsInput.chatId, paramsInput.conversationId, async () => {
        const event: ProviderFailureEvent = {
          type: "provider_failure",
          timestamp: new Date().toISOString(),
          chatId: paramsInput.chatId,
          conversationId: paramsInput.conversationId,
          kind: paramsInput.kind as ProviderErrorKind,
          statusCode: paramsInput.statusCode,
          attempts: paramsInput.attempts,
          message: paramsInput.message,
          telegramMessageId: paramsInput.telegramMessageId
        };

        await appendEventInternal(paramsInput.chatId, paramsInput.conversationId, event, paramsInput.trace);
      });
    },

    async getPromptHistory(chatId, conversationId, limit): Promise<PromptMessage[]> {
      await awaitPendingAppend(chatId, conversationId);
      const session = await loadConversationSession(chatId, conversationId);
      return getBoundedHistory(session.promptMessages, limit);
    },

    async getPromptMessageCount(chatId, conversationId): Promise<number> {
      await awaitPendingAppend(chatId, conversationId);
      const session = await loadConversationSession(chatId, conversationId);
      return session.promptMessageCount;
    },

    getHealth() {
      return {
        cachedSessions: sessionCache.size,
        maxCachedSessions: sessionCacheMaxEntries,
        queuedAppends: appendQueues.size,
        evictedSessions
      };
    }
  };
}
