import type {
  PromptMessage,
  ProviderUsageSnapshot,
  ProviderErrorKind,
  ProviderRequest,
  ThinkingEffort,
  SkillDefinition,
  WorkspaceSnapshot
} from "../types.js";
import type { TraceContext } from "../observability.js";
import type { WebSearchModelCatalogEntry } from "../web-search-catalog.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type TelegramAssistantFormat = "plain_text" | "markdown_to_html";
export type OpenAIModelCatalogEntry = {
  id: string;
  aliases: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  defaultThinking: ThinkingEffort;
  compactionTokens: number | null;
  compactionThreshold: number;
};

export type Config = {
  configPath: string;
  telegram: {
    botToken: string;
    streamingEnabled: boolean;
    streamingMinUpdateMs: number;
    assistantFormat: TelegramAssistantFormat;
  };
  openai: {
    apiKey: string;
    model: string;
    models: OpenAIModelCatalogEntry[];
    timeoutMs: number;
    maxRetries: number;
    retryBaseMs: number;
    retryMaxMs: number;
  };
  runtime: {
    logLevel: LogLevel;
    promptHistoryLimit: number | null;
    defaultVerbose: boolean;
    toolLoopMaxSteps: number | null;
    toolWorkflowTimeoutMs: number;
    toolCommandTimeoutMs: number;
    toolPollIntervalMs: number;
    toolPollMaxAttempts: number;
    toolIdleOutputThresholdMs: number;
    toolHeartbeatIntervalMs: number;
    toolCleanupGraceMs: number;
    toolFailureBreakerThreshold: number;
    sessionCacheMaxEntries: number;
    appLogFlushIntervalMs: number;
    messageQueueMode: "batch" | "multi_turn";
  };
  access: {
    allowedSenderIds: Set<string>;
  };
  tools: {
    defaultCwd: string;
    defaultShell: string;
    execTimeoutMs: number;
    execYieldMs: number;
    processLogTailLines: number;
    logPath: string;
    completedSessionRetentionMs: number;
    maxCompletedSessions: number;
    maxOutputChars: number;
    webSearch: {
      apiKey: string | null;
      model: string;
      models: WebSearchModelCatalogEntry[];
    };
  };
  paths: {
    workspaceRoot: string;
    conversationsDir: string;
    stashedConversationsPath: string;
    activeConversationsPath: string;
    contextSnapshotsDir: string;
    appLogPath: string;
  };
  observability: {
    enabled: boolean;
    logPath: string;
    redaction: {
      enabled: boolean;
      maxStringChars: number;
      redactKeys: string[];
    };
  };
};

export type RuntimeLogger = {
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type StateStoreHealth = {
  cachedSessions: number;
  maxCachedSessions: number;
  queuedAppends: number;
  evictedSessions: number;
};

export type ToolResultStats = {
  total: number;
  success: number;
  fail: number;
  byTool: Record<string, number>;
};

export type StashedConversationSummary = {
  conversationId: string;
  alias: string;
  stashedAt: string;
};

export type StateStore = {
  ensureActiveConversation(chatId: string): Promise<string>;
  getActiveConversation(chatId: string): Promise<string | null>;
  getVerboseMode(chatId: string): Promise<boolean>;
  setVerboseMode(chatId: string, enabled: boolean, options?: { trace?: TraceContext }): Promise<void>;
  getThinkingEffort(chatId: string): Promise<ThinkingEffort>;
  setThinkingEffort(chatId: string, effort: ThinkingEffort, options?: { trace?: TraceContext }): Promise<void>;
  getActiveModelOverride(chatId: string): Promise<string | null>;
  setActiveModelOverride(chatId: string, modelId: string | null, options?: { trace?: TraceContext }): Promise<void>;
  getActiveWebSearchModelOverride(chatId: string): Promise<string | null>;
  setActiveWebSearchModelOverride(chatId: string, modelId: string | null, options?: { trace?: TraceContext }): Promise<void>;
  getLatestUsageSnapshot(chatId: string): Promise<ProviderUsageSnapshot | null>;
  setLatestUsageSnapshot(chatId: string, usage: ProviderUsageSnapshot): Promise<void>;
  getToolResultStats(chatId: string): Promise<ToolResultStats>;
  recordToolResult(chatId: string, event: { tool: string; success: boolean }): Promise<void>;
  getCompactionCount(chatId: string): Promise<number>;
  incrementCompactionCount(chatId: string): Promise<number>;
  listStashedConversations(chatId: string): Promise<StashedConversationSummary[]>;
  completeNewSelection(
    chatId: string,
    target:
      | {
          type: "new";
        }
      | {
          type: "stash";
          conversationId: string;
        },
    reason: string,
    options?: { trace?: TraceContext }
  ): Promise<{
    archivedConversationId: string | null;
    conversationId: string;
    alias: string | null;
  }>;
  completeStashSelection(
    chatId: string,
    alias: string,
    target:
      | {
          type: "new";
        }
      | {
          type: "stash";
          conversationId: string;
        },
    reason: string,
    options?: { trace?: TraceContext }
  ): Promise<{
    stashedConversationId: string;
    stashedAlias: string;
    conversationId: string;
    alias: string | null;
  }>;
  appendUserMessageAndGetPromptContext(params: {
    chatId: string;
    conversationId: string;
    telegramMessageId: string;
    senderId: string;
    senderName: string;
    content: string;
    historyLimit: number | null;
    trace?: TraceContext;
  }): Promise<{
    promptCountBeforeAppend: number;
    historyAfterAppend: PromptMessage[];
  }>;
  appendUserMessage(params: {
    chatId: string;
    conversationId: string;
    telegramMessageId: string;
    senderId: string;
    senderName: string;
    content: string;
    trace?: TraceContext;
  }): Promise<void>;
  appendAssistantMessage(params: {
    chatId: string;
    conversationId: string;
    content: string;
    trace?: TraceContext;
  }): Promise<void>;
  appendProviderFailure(params: {
    chatId: string;
    conversationId: string;
    telegramMessageId: string;
    attempts: number;
    statusCode: number | null;
    kind: ProviderErrorKind;
    message: string;
    trace?: TraceContext;
  }): Promise<void>;
  getPromptHistory(chatId: string, conversationId: string, limit: number | null): Promise<PromptMessage[]>;
  getPromptMessageCount(chatId: string, conversationId: string): Promise<number>;
  getHealth(): StateStoreHealth;
};

export type WorkspaceCatalogHealth = {
  refreshCalls: number;
  refreshNoChange: number;
  lastManifestHash: string | null;
  lastSnapshotSignature: string | null;
};

export type WorkspaceCatalog = {
  bootstrap(): Promise<void>;
  refresh(): Promise<{ snapshot: WorkspaceSnapshot; changed: boolean }>;
  getSnapshot(): WorkspaceSnapshot;
  getSkillBySlug(slug: string): SkillDefinition | null;
  getHealth(): WorkspaceCatalogHealth;
};

export type ProviderTransport = {
  request(
    body: Record<string, unknown>,
    chatId: string,
    options?: {
      onTextDelta?: ProviderRequest["onTextDelta"];
      trace?: TraceContext;
      messageId?: string;
      abortSignal?: AbortSignal;
    }
  ): Promise<{
    payload: Record<string, unknown>;
    attempt: number;
  }>;
};
