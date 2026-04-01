import type { ProviderFailureSummary, ToolResultStats } from "../runtime/contracts.js";
import type { ObservabilitySink } from "../observability.js";
import type { PromptMessage, ProviderUsageSnapshot, ThinkingEffort, CacheRetention, TransportMode, AuthMode } from "../types.js";

export type ConversationRuntimeProfile = {
  workingDirectory: string;
  thinkingEffort: ThinkingEffort;
  cacheRetention: CacheRetention;
  transportMode: TransportMode;
  authMode: AuthMode;
  activeModelOverride: string | null;
  activeWebSearchModelOverride: string | null;
  latestUsage: ProviderUsageSnapshot | null;
  toolResults: ToolResultStats;
  compactionCount: number;
  lastProviderFailure: ProviderFailureSummary | null;
};

export type CurrentConversationRecord = {
  conversationId: string;
  alias: string | null;
  runtime: ConversationRuntimeProfile;
};

export type StashedConversationRecord = {
  conversationId: string;
  alias: string;
  stashedAt: string;
  runtime: ConversationRuntimeProfile;
};

export type ActiveConversationsIndex = Record<string, StashedConversationRecord[]>;
export type CurrentConversationsIndex = Record<string, CurrentConversationRecord>;

export type ConversationSessionCache = {
  promptMessages: PromptMessage[];
  promptMessageCount: number;
  lastAccessMs: number;
};

export type ConversationStoreParams = {
  conversationsDir: string;
  defaultWorkingDirectory?: string;
  defaultThinkingEffort?: ThinkingEffort;
  defaultCacheRetention?: CacheRetention;
  defaultAuthMode?: AuthMode;
  defaultTransportMode?: TransportMode;
  sessionCacheMaxEntries?: number;
  archivedConversationsMaxCount?: number | null;
  observability?: ObservabilitySink;
};
