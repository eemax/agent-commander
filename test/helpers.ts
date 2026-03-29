import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../src/runtime/contracts.js";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Set<infer U>
    ? Set<U>
    : T[K] extends Array<infer V>
      ? Array<DeepPartial<V>>
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

export function createTempDir(prefix = "acmd-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeConfig(overrides: DeepPartial<Config> = {}): Config {
  const root = createTempDir("acmd-config-");

  const base: Config = {
    agentId: "default",
    configPath: path.join(root, "config", "config.json"),
    repoRoot: root,
    telegram: {
      botToken: "telegram-token",
      streamingEnabled: true,
      streamingMinUpdateMs: 100,
      draftBubbleMaxChars: 1500,
      assistantFormat: "plain_text",
      maxFileSizeBytes: 10 * 1024 * 1024,
      fileDownloadTimeoutMs: 30_000,
      maxConcurrentDownloads: 4,
      maxTextAttachmentBytes: 204_800,
      acknowledgedEmoji: null
    },
    openai: {
      authMode: "api",
      defaultTransport: "http" as const,
      apiKey: "openai-key",
      model: "gpt-5.4-mini",
      models: [
        {
          id: "gpt-5.4-mini",
          aliases: ["mini"],
          contextWindow: null,
          maxOutputTokens: null,
          defaultThinking: "medium",
          cacheRetention: "in_memory",
          compactionTokens: null,
          compactionThreshold: 1
        },
        {
          id: "gpt-5.3-codex",
          aliases: ["codex", "g53c"],
          contextWindow: 400_000,
          maxOutputTokens: 8_000,
          defaultThinking: "high",
          cacheRetention: "24h",
          compactionTokens: null,
          compactionThreshold: 1
        }
      ],
      timeoutMs: 1_000,
      maxRetries: 2,
      retryBaseMs: 250,
      retryMaxMs: 2_000
    },
    runtime: {
      logLevel: "info",
      promptHistoryLimit: 20,
      toolLoopMaxSteps: 30,
      toolWorkflowTimeoutMs: 120_000,
      toolCommandTimeoutMs: 15_000,
      toolPollIntervalMs: 2_000,
      toolPollMaxAttempts: 5,
      toolIdleOutputThresholdMs: 8_000,
      toolHeartbeatIntervalMs: 5_000,
      toolCleanupGraceMs: 3_000,
      toolFailureBreakerThreshold: 4,
      sessionCacheMaxEntries: 200,
      appLogFlushIntervalMs: 1_000,
      messageQueueMode: "batch" as const
    },
    access: {
      allowedSenderIds: new Set(["user-1"])
    },
    tools: {
      defaultCwd: root,
      defaultShell: "/bin/bash",
      execTimeoutMs: 1_800_000,
      execYieldMs: 10_000,
      processLogTailLines: 200,
      logPath: path.join(root, ".agent-commander", "tool-calls.jsonl"),
      completedSessionRetentionMs: 900_000,
      maxCompletedSessions: 50,
      maxOutputChars: 200_000,
      webSearch: {
        apiKey: null,
        defaultPreset: "pro-search",
        presets: [
          { id: "fast-search", aliases: ["fast"] },
          { id: "pro-search", aliases: ["pro"] },
          { id: "deep-research", aliases: ["deep"] },
          { id: "advanced-deep-research", aliases: ["xdeep"] }
        ]
      }
    },
    paths: {
      workspaceRoot: path.join(root, "workspace"),
      conversationsDir: path.join(root, ".agent-commander", "conversations"),
      stashedConversationsPath: path.join(root, ".agent-commander", "stashed-conversations.json"),
      activeConversationsPath: path.join(root, ".agent-commander", "active-conversations.json"),
      contextSnapshotsDir: path.join(root, ".agent-commander", "context-snapshots"),
      appLogPath: path.join(root, ".agent-commander", "app.log")
    },
    observability: {
      enabled: false,
      logPath: path.join(root, ".agent-commander", "observability.jsonl"),
      redaction: {
        enabled: true,
        maxStringChars: 4_000,
        redactKeys: ["authorization", "api_key", "token", "secret", "password", "cookie", "set-cookie"]
      }
    },
    subagents: {
      enabled: true,
      defaultModel: "gpt-5.4-mini",
      maxConcurrentTasks: 10,
      defaultTimeBudgetSec: 900,
      defaultMaxTurns: 30,
      defaultMaxTotalTokens: 500_000,
      defaultHeartbeatIntervalSec: 30,
      defaultIdleTimeoutSec: 120,
      defaultStallTimeoutSec: 300,
      defaultRequirePlanByTurn: 3,
      recvMaxEvents: 100,
      recvDefaultWaitMs: 200,
      awaitMaxTimeoutMs: 30_000
    }
  };

  return {
    ...base,
    ...overrides,
    telegram: {
      ...base.telegram,
      ...overrides.telegram
    },
    openai: {
      ...base.openai,
      ...overrides.openai,
      models: (overrides.openai?.models as Config["openai"]["models"] | undefined) ?? base.openai.models
    },
    runtime: {
      ...base.runtime,
      ...overrides.runtime
    },
    access: {
      ...base.access,
      ...overrides.access
    },
    tools: {
      ...base.tools,
      ...overrides.tools,
      webSearch: {
        ...base.tools.webSearch,
        ...overrides.tools?.webSearch,
        presets: (overrides.tools?.webSearch?.presets as Config["tools"]["webSearch"]["presets"] | undefined) ?? base.tools.webSearch.presets
      }
    },
    paths: {
      ...base.paths,
      ...overrides.paths
    },
    observability: {
      ...base.observability,
      ...overrides.observability,
      redaction: {
        ...base.observability.redaction,
        ...overrides.observability?.redaction
      }
    },
    subagents: {
      ...base.subagents,
      ...overrides.subagents
    }
  };
}
