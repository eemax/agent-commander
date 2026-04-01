import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { createConversationId } from "../id.js";
import type { ProviderFailureSummary, StashedConversationSummary, StateStore, ToolResultStats } from "../runtime/contracts.js";
import {
  createChildTraceContext,
  createTraceRootContext,
  type TraceContext
} from "../observability.js";
import type {
  PromptMessage,
  ProviderErrorKind,
  ProviderUsageSnapshot,
  ThinkingEffort,
  CacheRetention,
  TransportMode,
  AuthMode
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
import {
  type ConversationStorageBucket,
  activeConversationsIndexPath,
  conversationJsonlPath,
  conversationSnapshotPath,
  stashedConversationsIndexPath
} from "./conversation-paths.js";
import type {
  CurrentConversationRecord,
  StashedConversationRecord,
  ActiveConversationsIndex,
  CurrentConversationsIndex,
  ConversationSessionCache,
  ConversationStoreParams
} from "./conversation-types.js";
import {
  toCacheKey,
  toPromptMessage,
  getBoundedHistory,
  atomicWriteJson,
  cloneUsageSnapshot,
  cloneToolResultStats,
  cloneProviderFailureSummary,
  createDefaultRuntimeProfile,
  cloneRuntimeProfile,
  parseCurrentConversationsIndex,
  parseActiveConversationsIndex,
  cloneActiveConversationsIndex,
  sortStashes,
  resolveStashAlias,
  toStashSummary
} from "./conversation-utils.js";

export type ConversationStore = StateStore;

export function createConversationStore(params: ConversationStoreParams): ConversationStore {
  const sessionCacheMaxEntries = params.sessionCacheMaxEntries ?? 200;
  const archivedConversationsMaxCount = params.archivedConversationsMaxCount ?? null;
  const currentConversationsPath = activeConversationsIndexPath(params.conversationsDir);
  const stashedConversationsPath = stashedConversationsIndexPath(params.conversationsDir);
  const defaults = {
    defaultWorkingDirectory: params.defaultWorkingDirectory ?? process.cwd(),
    defaultThinkingEffort: params.defaultThinkingEffort ?? "medium",
    defaultCacheRetention: params.defaultCacheRetention ?? "in_memory",
    defaultAuthMode: params.defaultAuthMode ?? "api",
    defaultTransportMode: params.defaultTransportMode ?? "http"
  } as const;

  let activeConversationsCache: ActiveConversationsIndex | null = null;
  let currentConversationsCache: CurrentConversationsIndex | null = null;
  let mutationQueue: Promise<unknown> = Promise.resolve();
  let evictedSessions = 0;

  const sessionCache = new Map<string, ConversationSessionCache>();
  const appendQueues = new Map<string, Promise<unknown>>();
  const ensuredConversationDirs = new Map<string, Promise<void>>();

  const conversationPath = (
    bucket: ConversationStorageBucket,
    chatId: string,
    conversationId: string
  ): string => {
    return conversationJsonlPath(params.conversationsDir, bucket, chatId, conversationId);
  };

  const snapshotPath = (
    bucket: Exclude<ConversationStorageBucket, "archive">,
    chatId: string,
    conversationId: string
  ): string => {
    return conversationSnapshotPath(params.conversationsDir, bucket, chatId, conversationId);
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

  const ensureParentDir = async (targetPath: string): Promise<void> => {
    await ensureConversationDir(path.dirname(targetPath));
  };

  const touchSession = (cacheKey: string): ConversationSessionCache => {
    const session = sessionCache.get(cacheKey);
    if (!session) {
      throw new Error(`Missing session cache for ${cacheKey}`);
    }

    session.lastAccessMs = Date.now();
    return session;
  };

  const evictCachedSession = (cacheKey: string): void => {
    if (sessionCache.delete(cacheKey)) {
      evictedSessions += 1;
    }
  };

  const collectEligibleSessionCacheKeys = async (
    currentIndex?: CurrentConversationsIndex,
    activeIndex?: ActiveConversationsIndex
  ): Promise<Set<string>> => {
    const resolvedCurrent = currentIndex ?? await loadCurrentConversations();
    const resolvedActive = activeIndex ?? await loadActiveConversations();
    const eligible = new Set<string>();

    for (const [chatId, record] of Object.entries(resolvedCurrent)) {
      eligible.add(toCacheKey(chatId, record.conversationId));
    }

    for (const [chatId, stashes] of Object.entries(resolvedActive)) {
      for (const stash of stashes) {
        eligible.add(toCacheKey(chatId, stash.conversationId));
      }
    }

    return eligible;
  };

  const isSessionCacheEligible = async (
    chatId: string,
    conversationId: string,
    currentIndex?: CurrentConversationsIndex,
    activeIndex?: ActiveConversationsIndex
  ): Promise<boolean> => {
    const eligibleCacheKeys = await collectEligibleSessionCacheKeys(currentIndex, activeIndex);
    return eligibleCacheKeys.has(toCacheKey(chatId, conversationId));
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
      evictCachedSession(target.key);
    }
  };

  const synchronizeSessionCacheEligibility = async (
    currentIndex?: CurrentConversationsIndex,
    activeIndex?: ActiveConversationsIndex
  ): Promise<void> => {
    const eligibleCacheKeys = await collectEligibleSessionCacheKeys(currentIndex, activeIndex);
    for (const cacheKey of Array.from(sessionCache.keys())) {
      if (!eligibleCacheKeys.has(cacheKey)) {
        evictCachedSession(cacheKey);
      }
    }
    pruneSessionCache();
  };

  const applyEventToSession = (session: ConversationSessionCache, event: ConversationEvent): void => {
    if (event.type === "message") {
      session.promptMessageCount += 1;
      session.promptMessages.push(toPromptMessage(event));
    }
    session.lastAccessMs = Date.now();
  };

  const resolveConversationLocation = (
    chatId: string,
    conversationId: string,
    currentIndex: CurrentConversationsIndex,
    activeIndex: ActiveConversationsIndex
  ): ConversationStorageBucket => {
    if (currentIndex[chatId]?.conversationId === conversationId) {
      return "active";
    }

    if ((activeIndex[chatId] ?? []).some((item) => item.conversationId === conversationId)) {
      return "stashed";
    }

    return "archive";
  };

  const deleteIfExists = async (targetPath: string): Promise<void> => {
    try {
      await fs.unlink(targetPath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }
  };

  const renameIfExists = async (fromPath: string, toPath: string): Promise<void> => {
    try {
      await ensureParentDir(toPath);
      await fs.rename(fromPath, toPath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }
  };

  const listArchivedConversationFiles = async (): Promise<Array<{ filePath: string; mtimeMs: number }>> => {
    const archiveRoot = path.join(params.conversationsDir, "archive");
    let chatEntries: Dirent[];

    try {
      chatEntries = await fs.readdir(archiveRoot, { withFileTypes: true });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const files: Array<{ filePath: string; mtimeMs: number }> = [];
    for (const chatEntry of chatEntries) {
      if (!chatEntry.isDirectory()) {
        continue;
      }

      const chatDir = path.join(archiveRoot, chatEntry.name);
      const archivedEntries = await fs.readdir(chatDir, { withFileTypes: true });
      for (const archivedEntry of archivedEntries) {
        if (!archivedEntry.isFile() || !archivedEntry.name.endsWith(".jsonl")) {
          continue;
        }

        const filePath = path.join(chatDir, archivedEntry.name);
        const stats = await fs.stat(filePath);
        files.push({ filePath, mtimeMs: stats.mtimeMs });
      }
    }

    return files;
  };

  const pruneArchivedConversations = async (): Promise<void> => {
    if (archivedConversationsMaxCount === null) {
      return;
    }

    const archivedFiles = await listArchivedConversationFiles();
    if (archivedFiles.length <= archivedConversationsMaxCount) {
      return;
    }

    archivedFiles.sort((left, right) => {
      if (left.mtimeMs !== right.mtimeMs) {
        return left.mtimeMs - right.mtimeMs;
      }
      return left.filePath.localeCompare(right.filePath);
    });

    const overflow = archivedFiles.length - archivedConversationsMaxCount;
    for (let index = 0; index < overflow; index += 1) {
      const target = archivedFiles[index];
      if (!target) {
        continue;
      }
      await deleteIfExists(target.filePath);
    }
  };

  const loadActiveConversations = async (): Promise<ActiveConversationsIndex> => {
    if (activeConversationsCache) {
      return activeConversationsCache;
    }

    try {
      const raw = await fs.readFile(stashedConversationsPath, "utf8");
      activeConversationsCache = parseActiveConversationsIndex(raw, defaults, (msg) => console.warn(msg));
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
    await atomicWriteJson(stashedConversationsPath, cloneActiveConversationsIndex(next));
  };

  const loadCurrentConversations = async (): Promise<CurrentConversationsIndex> => {
    if (currentConversationsCache) {
      return currentConversationsCache;
    }

    try {
      const raw = await fs.readFile(currentConversationsPath, "utf8");
      currentConversationsCache = parseCurrentConversationsIndex(raw, defaults, (msg) => console.warn(msg));
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
    await atomicWriteJson(currentConversationsPath, next);
  };

  const loadConversationSession = async (chatId: string, conversationId: string): Promise<ConversationSessionCache> => {
    const cacheKey = toCacheKey(chatId, conversationId);
    const cached = sessionCache.get(cacheKey);
    if (cached) {
      return touchSession(cacheKey);
    }

    const cacheable = await isSessionCacheEligible(chatId, conversationId);
    const currentIndex = await loadCurrentConversations();
    const activeIndex = await loadActiveConversations();
    const target = conversationPath(
      resolveConversationLocation(chatId, conversationId, currentIndex, activeIndex),
      chatId,
      conversationId
    );
    let raw: string;

    try {
      raw = await fs.readFile(target, "utf8");
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        const emptySession: ConversationSessionCache = {
          promptMessages: [],
          promptMessageCount: 0,
          lastAccessMs: Date.now()
        };
        if (cacheable) {
          sessionCache.set(cacheKey, emptySession);
          pruneSessionCache();
        }
        return emptySession;
      }
      throw error;
    }

    const promptMessages: PromptMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const event = parseConversationEvent(trimmed, target);
        if (event.type === "message") {
          promptMessages.push(toPromptMessage(event));
        }
      } catch {
        // Skip malformed JSONL lines (e.g. from a crash mid-write)
        void params.observability?.record({
          event: "state.conversation.malformed_line",
          trace: createTraceRootContext("state"),
          stage: "warning",
          chatId,
          conversationId,
          path: target
        });
      }
    }

    const session: ConversationSessionCache = {
      promptMessages,
      promptMessageCount: promptMessages.length,
      lastAccessMs: Date.now()
    };
    if (cacheable) {
      sessionCache.set(cacheKey, session);
      pruneSessionCache();
    }
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

  const moveConversationArtifacts = async (paramsInput: {
    chatId: string;
    conversationId: string;
    from: Exclude<ConversationStorageBucket, "archive">;
    to: ConversationStorageBucket;
    archivedAt?: Date;
  }): Promise<void> => {
    await awaitPendingAppend(paramsInput.chatId, paramsInput.conversationId);

    const sourceJsonlPath = conversationPath(paramsInput.from, paramsInput.chatId, paramsInput.conversationId);
    if (paramsInput.to === "archive") {
      const targetJsonlPath = conversationPath("archive", paramsInput.chatId, paramsInput.conversationId);
      await ensureParentDir(targetJsonlPath);
      await fs.rename(sourceJsonlPath, targetJsonlPath);
      if (paramsInput.archivedAt) {
        await fs.utimes(targetJsonlPath, paramsInput.archivedAt, paramsInput.archivedAt);
      }
      await deleteIfExists(snapshotPath(paramsInput.from, paramsInput.chatId, paramsInput.conversationId));
      await pruneArchivedConversations();
      return;
    }

    const targetJsonlPath = conversationPath(paramsInput.to, paramsInput.chatId, paramsInput.conversationId);
    await ensureParentDir(targetJsonlPath);
    await fs.rename(sourceJsonlPath, targetJsonlPath);
    await renameIfExists(
      snapshotPath(paramsInput.from, paramsInput.chatId, paramsInput.conversationId),
      snapshotPath(paramsInput.to, paramsInput.chatId, paramsInput.conversationId)
    );
  };

  const appendEventInternal = async (
    chatId: string,
    conversationId: string,
    event: ConversationEvent,
    trace?: TraceContext,
    location?: ConversationStorageBucket
  ): Promise<void> => {
    const resolvedLocation =
      location ??
      resolveConversationLocation(
        chatId,
        conversationId,
        await loadCurrentConversations(),
        await loadActiveConversations()
      );
    const target = conversationPath(resolvedLocation, chatId, conversationId);
    await ensureParentDir(target);
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

    await appendEventInternal(chatId, conversationId, event, trace, "active");
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
    await synchronizeSessionCacheEligibility(next);
    return {
      index: next,
      record
    };
  };

  const withStashesForChat = (
    index: ActiveConversationsIndex,
    chatId: string,
    stashes: StashedConversationRecord[]
  ): ActiveConversationsIndex => {
    const next = {
      ...index
    };
    if (stashes.length === 0) {
      delete next[chatId];
    } else {
      next[chatId] = sortStashes(stashes);
    }
    return next;
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

    async getConversationRuntimeProfile(chatId) {
      const index = await loadCurrentConversations();
      const record = index[chatId];
      if (!record) return null;
      const rt = record.runtime;
      return {
        thinkingEffort: rt.thinkingEffort,
        cacheRetention: rt.cacheRetention,
        transportMode: rt.transportMode,
        authMode: rt.authMode,
        activeModelOverride: rt.activeModelOverride
      };
    },

    async getWorkingDirectory(chatId): Promise<string> {
      return enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        return ensured.record.runtime.workingDirectory;
      });
    },

    async setWorkingDirectory(chatId, cwd, options): Promise<void> {
      await enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start", options?.trace);
        const normalizedCwd = cwd.trim();
        if (normalizedCwd.length === 0 || ensured.record.runtime.workingDirectory === normalizedCwd) {
          return;
        }

        const nextCurrent = {
          ...ensured.index,
          [chatId]: {
            ...ensured.record,
            runtime: {
              ...ensured.record.runtime,
              workingDirectory: normalizedCwd
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
          setting: "workingDirectory",
          value: normalizedCwd
        });
      });
    },

    async getThinkingEffort(chatId): Promise<ThinkingEffort> {
      return enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        return ensured.record.runtime.thinkingEffort;
      });
    },

    async getCacheRetention(chatId): Promise<CacheRetention> {
      return enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        return ensured.record.runtime.cacheRetention;
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

    async setCacheRetention(chatId, mode, options): Promise<void> {
      await enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start", options?.trace);
        if (ensured.record.runtime.cacheRetention === mode) {
          return;
        }

        const nextCurrent = {
          ...ensured.index,
          [chatId]: {
            ...ensured.record,
            runtime: {
              ...ensured.record.runtime,
              cacheRetention: mode
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
          setting: "cacheRetention",
          value: mode
        });
      });
    },

    async getTransportMode(chatId): Promise<TransportMode> {
      return enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        return ensured.record.runtime.transportMode;
      });
    },

    async setTransportMode(chatId, mode: TransportMode, options): Promise<void> {
      await enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start", options?.trace);
        if (ensured.record.runtime.transportMode === mode) {
          return;
        }

        const nextCurrent = {
          ...ensured.index,
          [chatId]: {
            ...ensured.record,
            runtime: {
              ...ensured.record.runtime,
              transportMode: mode
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
          setting: "transportMode",
          value: mode
        });
      });
    },

    async getAuthMode(chatId): Promise<AuthMode> {
      return enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        return ensured.record.runtime.authMode;
      });
    },

    async setAuthMode(chatId, mode: AuthMode, options): Promise<void> {
      await enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start", options?.trace);
        if (ensured.record.runtime.authMode === mode) {
          return;
        }

        const nextCurrent = {
          ...ensured.index,
          [chatId]: {
            ...ensured.record,
            runtime: {
              ...ensured.record.runtime,
              authMode: mode
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
          setting: "authMode",
          value: mode
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
        const previousLastCacheHitAt = ensured.record.runtime.latestUsage?.lastCacheHitAt ?? null;
        const mergedUsage: ProviderUsageSnapshot = {
          ...cloneUsageSnapshot(usage),
          lastCacheHitAt: usage.lastCacheHitAt ?? previousLastCacheHitAt
        };
        const nextCurrent = {
          ...ensured.index,
          [chatId]: {
            ...ensured.record,
            runtime: {
              ...ensured.record.runtime,
              latestUsage: mergedUsage
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

    async flushTurnStats(chatId, stats): Promise<void> {
      if (stats.toolResults.length === 0 && stats.compactionIncrements === 0) return;
      await enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        const existing = ensured.record.runtime.toolResults;

        let total = existing.total;
        let success = existing.success;
        let fail = existing.fail;
        const byTool = { ...existing.byTool };
        for (const event of stats.toolResults) {
          total += 1;
          if (event.success) {
            success += 1;
          } else {
            fail += 1;
          }
          const normalizedTool = event.tool.trim();
          if (normalizedTool.length > 0) {
            byTool[normalizedTool] = (byTool[normalizedTool] ?? 0) + 1;
          }
        }

        const nextCurrent = {
          ...ensured.index,
          [chatId]: {
            ...ensured.record,
            runtime: {
              ...ensured.record.runtime,
              toolResults: { total, success, fail, byTool },
              compactionCount: ensured.record.runtime.compactionCount + stats.compactionIncrements
            }
          }
        };

        await saveCurrentConversations(nextCurrent);
      });
    },

    async getLastProviderFailure(chatId): Promise<ProviderFailureSummary | null> {
      return enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        const summary = ensured.record.runtime.lastProviderFailure;
        return summary ? cloneProviderFailureSummary(summary) : null;
      });
    },

    async setLastProviderFailure(chatId, failure): Promise<void> {
      await enqueueMutation(async () => {
        const ensured = await ensureCurrentConversationRecord(chatId, "auto_start");
        const nextSummary = failure ? cloneProviderFailureSummary(failure) : null;
        const currentSummary = ensured.record.runtime.lastProviderFailure;
        if (
          currentSummary?.at === nextSummary?.at &&
          currentSummary?.kind === nextSummary?.kind &&
          currentSummary?.statusCode === nextSummary?.statusCode &&
          currentSummary?.attempts === nextSummary?.attempts &&
          currentSummary?.reason === nextSummary?.reason
        ) {
          return;
        }

        const nextCurrent = {
          ...ensured.index,
          [chatId]: {
            ...ensured.record,
            runtime: {
              ...ensured.record.runtime,
              lastProviderFailure: nextSummary
            }
          }
        };
        await saveCurrentConversations(nextCurrent);
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
      runtime: {
        workingDirectory: string;
        thinkingEffort: ThinkingEffort;
        cacheRetention: CacheRetention;
        transportMode: TransportMode;
        authMode: AuthMode;
        activeModelOverride: string | null;
        activeWebSearchModelOverride: string | null;
      };
    }> {
      return enqueueMutation(async () => {
        const currentIndex = await loadCurrentConversations();
        const activeIndex = await loadActiveConversations();
        const stashes = sortStashes(activeIndex[chatId] ?? []);
        const selectedStash =
          target.type === "stash"
            ? stashes.find((item) => item.conversationId === target.conversationId) ?? null
            : null;

        // Validate stale menu selections before moving the current conversation.
        if (target.type === "stash" && !selectedStash) {
          throw new Error("stashed conversation not found");
        }

        const existingCurrent = currentIndex[chatId] ?? null;
        let archivedConversationId: string | null = null;
        let archivedAt: Date | null = null;

        if (existingCurrent) {
          archivedConversationId = existingCurrent.conversationId;
          archivedAt = new Date();
          const archiveEvent: ConversationArchiveEvent = {
            type: "conversation_archived",
            timestamp: archivedAt.toISOString(),
            chatId,
            conversationId: existingCurrent.conversationId,
            reason
          };

          await enqueueConversationAppend(chatId, existingCurrent.conversationId, async () => {
            await appendEventInternal(chatId, existingCurrent.conversationId, archiveEvent, options?.trace, "active");
          });
          await moveConversationArtifacts({
            chatId,
            conversationId: existingCurrent.conversationId,
            from: "active",
            to: "archive",
            archivedAt
          });
        }

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
          const selected = selectedStash;
          if (!selected) {
            throw new Error("stashed conversation not found");
          }

          await moveConversationArtifacts({
            chatId,
            conversationId: selected.conversationId,
            from: "stashed",
            to: "active"
          });

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
        const nextActiveIndex = withStashesForChat(activeIndex, chatId, nextStashes);
        await saveCurrentConversations(nextCurrentIndex);
        await saveActiveConversations(nextActiveIndex);
        await synchronizeSessionCacheEligibility(nextCurrentIndex, nextActiveIndex);

        return {
          archivedConversationId,
          conversationId: nextCurrent.conversationId,
          alias: nextCurrent.alias,
          runtime: {
            workingDirectory: nextCurrent.runtime.workingDirectory,
            thinkingEffort: nextCurrent.runtime.thinkingEffort,
            cacheRetention: nextCurrent.runtime.cacheRetention,
            transportMode: nextCurrent.runtime.transportMode,
            authMode: nextCurrent.runtime.authMode,
            activeModelOverride: nextCurrent.runtime.activeModelOverride,
            activeWebSearchModelOverride: nextCurrent.runtime.activeWebSearchModelOverride
          }
        };
      });
    },

    async completeStashSelection(chatId, alias, target, reason, options): Promise<{
      stashedConversationId: string;
      stashedAlias: string;
      conversationId: string;
      alias: string | null;
      runtime: {
        workingDirectory: string;
        thinkingEffort: ThinkingEffort;
        cacheRetention: CacheRetention;
        transportMode: TransportMode;
        authMode: AuthMode;
        activeModelOverride: string | null;
        activeWebSearchModelOverride: string | null;
      };
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
        const selectedStash =
          target.type === "stash"
            ? stashes.find((item) => item.conversationId === target.conversationId) ?? null
            : null;

        // Validate stale menu selections before moving the current conversation.
        if (target.type === "stash" && !selectedStash) {
          throw new Error("stashed conversation not found");
        }

        const withoutCurrent = stashes.filter((item) => item.conversationId !== current.conversationId);
        const existingAliases = new Set(withoutCurrent.map((item) => item.alias));
        const resolvedAlias = resolveStashAlias(normalizedAlias, existingAliases);

        const stashedRecord: StashedConversationRecord = {
          conversationId: current.conversationId,
          alias: resolvedAlias,
          stashedAt: new Date().toISOString(),
          runtime: cloneRuntimeProfile(current.runtime)
        };

        await moveConversationArtifacts({
          chatId,
          conversationId: current.conversationId,
          from: "active",
          to: "stashed"
        });

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
          const selected = selectedStash;
          if (!selected) {
            throw new Error("stashed conversation not found");
          }

          await moveConversationArtifacts({
            chatId,
            conversationId: selected.conversationId,
            from: "stashed",
            to: "active"
          });

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
        const nextActiveIndex = withStashesForChat(activeIndex, chatId, nextStashes);
        await saveCurrentConversations(nextCurrentIndex);
        await saveActiveConversations(nextActiveIndex);
        await synchronizeSessionCacheEligibility(nextCurrentIndex, nextActiveIndex);

        return {
          stashedConversationId: stashedRecord.conversationId,
          stashedAlias: stashedRecord.alias,
          conversationId: nextCurrent.conversationId,
          alias: nextCurrent.alias,
          runtime: {
            workingDirectory: nextCurrent.runtime.workingDirectory,
            thinkingEffort: nextCurrent.runtime.thinkingEffort,
            cacheRetention: nextCurrent.runtime.cacheRetention,
            transportMode: nextCurrent.runtime.transportMode,
            authMode: nextCurrent.runtime.authMode,
            activeModelOverride: nextCurrent.runtime.activeModelOverride,
            activeWebSearchModelOverride: nextCurrent.runtime.activeWebSearchModelOverride
          }
        };
      });
    },

    async appendUserMessageAndGetPromptContext(paramsInput): Promise<{
      promptCountBeforeAppend: number;
      historyAfterAppend: PromptMessage[];
    }> {
      return enqueueConversationAppend(paramsInput.chatId, paramsInput.conversationId, async () => {
        const cacheKey = toCacheKey(paramsInput.chatId, paramsInput.conversationId);
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
        if (sessionCache.get(cacheKey) !== session) {
          applyEventToSession(session, event);
        }
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
