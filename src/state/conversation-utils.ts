import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProviderFailureSummary, StashedConversationSummary, ToolResultStats } from "../runtime/contracts.js";
import type { PromptMessage, ProviderErrorKind, ProviderUsageSnapshot, ThinkingEffort, CacheRetention, TransportMode, AuthMode } from "../types.js";
import { isPlainObject, normalizeNonEmptyString, isThinkingEffort, isCacheRetention, isTransportMode, isAuthMode } from "../utils.js";
import type { MessageEvent } from "./events.js";
import type {
  ConversationRuntimeProfile,
  StashedConversationRecord,
  ActiveConversationsIndex,
  CurrentConversationsIndex
} from "./conversation-types.js";

export function toCacheKey(chatId: string, conversationId: string): string {
  return `${chatId}\u0000${conversationId}`;
}

export function toPromptMessage(event: MessageEvent): PromptMessage {
  return {
    role: event.role,
    content: event.content,
    createdAt: event.timestamp,
    senderId: event.senderId,
    senderName: event.senderName
  };
}

export function getBoundedHistory(messages: PromptMessage[], limit: number | null): PromptMessage[] {
  if (limit === null) {
    return [...messages];
  }

  if (messages.length <= limit) {
    return [...messages];
  }

  return messages.slice(messages.length - limit);
}

export async function atomicWriteJson(targetPath: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, targetPath);
}

export const PROVIDER_ERROR_KIND_SET: ReadonlySet<string> = new Set([
  "timeout",
  "network",
  "rate_limit",
  "server_error",
  "client_error",
  "invalid_response",
  "unknown"
]);

export function isProviderErrorKind(value: unknown): value is ProviderErrorKind {
  return typeof value === "string" && PROVIDER_ERROR_KIND_SET.has(value);
}

export function isUsageNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

export function isUsageNumberOrUndefined(value: unknown): value is number | null | undefined {
  return value === undefined || isUsageNumber(value);
}

export function isUsageSnapshot(value: unknown): value is ProviderUsageSnapshot {
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

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isToolResultByToolRecord(value: unknown): value is Record<string, number> {
  if (!isPlainObject(value)) {
    return false;
  }

  return Object.values(value).every((entry) => isNonNegativeInteger(entry));
}

export function isToolResultStatsRecord(value: unknown): value is ToolResultStats {
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

export function createEmptyToolResultStats(): ToolResultStats {
  return {
    total: 0,
    success: 0,
    fail: 0,
    byTool: {}
  };
}

export function cloneToolResultStats(stats: ToolResultStats): ToolResultStats {
  return {
    total: stats.total,
    success: stats.success,
    fail: stats.fail,
    byTool: { ...stats.byTool }
  };
}

export function cloneUsageSnapshot(snapshot: ProviderUsageSnapshot): ProviderUsageSnapshot {
  return { ...snapshot };
}

export function isProviderFailureSummary(value: unknown): value is ProviderFailureSummary {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    normalizeNonEmptyString(value.at) !== null &&
    isProviderErrorKind(value.kind) &&
    (value.statusCode === null || (typeof value.statusCode === "number" && Number.isInteger(value.statusCode))) &&
    isNonNegativeInteger(value.attempts) &&
    normalizeNonEmptyString(value.reason) !== null
  );
}

export function cloneProviderFailureSummary(value: ProviderFailureSummary): ProviderFailureSummary {
  return {
    at: value.at,
    kind: value.kind,
    statusCode: value.statusCode,
    attempts: value.attempts,
    reason: value.reason
  };
}

export function createDefaultRuntimeProfile(params: {
  defaultWorkingDirectory: string;
  defaultThinkingEffort: ThinkingEffort;
  defaultCacheRetention: CacheRetention;
  defaultAuthMode: AuthMode;
  defaultTransportMode: TransportMode;
}): ConversationRuntimeProfile {
  return {
    workingDirectory: params.defaultWorkingDirectory,
    thinkingEffort: params.defaultThinkingEffort,
    cacheRetention: params.defaultCacheRetention,
    transportMode: params.defaultTransportMode,
    authMode: params.defaultAuthMode,
    activeModelOverride: null,
    activeWebSearchModelOverride: null,
    latestUsage: null,
    toolResults: createEmptyToolResultStats(),
    compactionCount: 0,
    lastProviderFailure: null
  };
}

export function cloneRuntimeProfile(profile: ConversationRuntimeProfile): ConversationRuntimeProfile {
  return {
    workingDirectory: profile.workingDirectory,
    thinkingEffort: profile.thinkingEffort,
    cacheRetention: profile.cacheRetention,
    transportMode: profile.transportMode,
    authMode: profile.authMode,
    activeModelOverride: profile.activeModelOverride,
    activeWebSearchModelOverride: profile.activeWebSearchModelOverride,
    latestUsage: profile.latestUsage ? cloneUsageSnapshot(profile.latestUsage) : null,
    toolResults: cloneToolResultStats(profile.toolResults),
    compactionCount: profile.compactionCount,
    lastProviderFailure: profile.lastProviderFailure ? cloneProviderFailureSummary(profile.lastProviderFailure) : null
  };
}

export function normalizeRuntimeProfile(
  value: unknown,
  defaults: {
    defaultWorkingDirectory: string;
    defaultThinkingEffort: ThinkingEffort;
    defaultCacheRetention: CacheRetention;
    defaultAuthMode: AuthMode;
    defaultTransportMode: TransportMode;
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
    workingDirectory: normalizeNonEmptyString(value.workingDirectory) ?? defaults.defaultWorkingDirectory,
    thinkingEffort: isThinkingEffort(value.thinkingEffort) ? value.thinkingEffort : defaults.defaultThinkingEffort,
    cacheRetention: isCacheRetention(value.cacheRetention) ? value.cacheRetention : defaults.defaultCacheRetention,
    transportMode: isTransportMode(value.transportMode) ? value.transportMode : defaults.defaultTransportMode,
    authMode: isAuthMode(value.authMode) ? value.authMode : defaults.defaultAuthMode,
    activeModelOverride,
    activeWebSearchModelOverride,
    latestUsage: isUsageSnapshot(value.latestUsage) ? cloneUsageSnapshot(value.latestUsage) : null,
    toolResults: isToolResultStatsRecord(value.toolResults) ? cloneToolResultStats(value.toolResults) : createEmptyToolResultStats(),
    compactionCount: isNonNegativeInteger(value.compactionCount) ? value.compactionCount : 0,
    lastProviderFailure: isProviderFailureSummary(value.lastProviderFailure)
      ? cloneProviderFailureSummary(value.lastProviderFailure)
      : null
  };
}

export function parseCurrentConversationsIndex(
  raw: string,
  defaults: {
    defaultWorkingDirectory: string;
    defaultThinkingEffort: ThinkingEffort;
    defaultCacheRetention: CacheRetention;
    defaultAuthMode: AuthMode;
    defaultTransportMode: TransportMode;
  },
  warn?: (message: string) => void
): CurrentConversationsIndex {
  const parsed = JSON.parse(raw) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error("invalid current conversation index format");
  }

  const normalized: CurrentConversationsIndex = {};
  for (const [chatId, entry] of Object.entries(parsed)) {
    if (!isPlainObject(entry)) {
      warn?.(`current conversations index: skipping chat ${chatId} — entry is not a plain object`);
      continue;
    }

    const conversationId = normalizeNonEmptyString(entry.conversationId);
    if (!conversationId) {
      warn?.(`current conversations index: skipping chat ${chatId} — missing conversationId`);
      continue;
    }

    const aliasRaw = entry.alias;
    const alias = aliasRaw === null ? null : normalizeNonEmptyString(aliasRaw);
    const runtime = normalizeRuntimeProfile(entry.runtime, defaults);
    if (!runtime) {
      warn?.(`current conversations index: skipping chat ${chatId} — invalid runtime profile`);
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

export function parseActiveConversationsIndex(
  raw: string,
  defaults: {
    defaultWorkingDirectory: string;
    defaultThinkingEffort: ThinkingEffort;
    defaultCacheRetention: CacheRetention;
    defaultAuthMode: AuthMode;
    defaultTransportMode: TransportMode;
  },
  warn?: (message: string) => void
): ActiveConversationsIndex {
  const parsed = JSON.parse(raw) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error("invalid active conversation index format");
  }

  const normalized: ActiveConversationsIndex = {};
  for (const [chatId, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) {
      warn?.(`active conversations index: skipping chat ${chatId} — value is not an array`);
      continue;
    }

    const entries: StashedConversationRecord[] = [];
    for (const item of value) {
      if (!isPlainObject(item)) {
        warn?.(`active conversations index: skipping stash entry for chat ${chatId} — not a plain object`);
        continue;
      }

      const conversationId = normalizeNonEmptyString(item.conversationId);
      const alias = normalizeNonEmptyString(item.alias);
      const stashedAt = normalizeNonEmptyString(item.stashedAt);
      const runtime = normalizeRuntimeProfile(item.runtime, defaults);
      if (!conversationId || !alias || !stashedAt || !runtime) {
        warn?.(`active conversations index: skipping stash entry for chat ${chatId} — missing required fields`);
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

export function cloneActiveConversationsIndex(index: ActiveConversationsIndex): ActiveConversationsIndex {
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

export function sortStashes(stashes: StashedConversationRecord[]): StashedConversationRecord[] {
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

export function resolveStashAlias(baseAlias: string, existingAliases: ReadonlySet<string>): string {
  if (!existingAliases.has(baseAlias)) {
    return baseAlias;
  }

  let suffix = 2;
  while (existingAliases.has(`${baseAlias}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseAlias}-${suffix}`;
}

export function toStashSummary(item: StashedConversationRecord): StashedConversationSummary {
  return {
    conversationId: item.conversationId,
    alias: item.alias,
    stashedAt: item.stashedAt
  };
}
