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
    configPath: path.join(root, "config.json"),
    telegram: {
      botToken: "telegram-token",
      streamingEnabled: true,
      streamingMinUpdateMs: 100,
      assistantFormat: "plain_text"
    },
    openai: {
      apiKey: "openai-key",
      model: "gpt-4.1-mini",
      models: [
        {
          id: "gpt-4.1-mini",
          aliases: ["mini"],
          contextWindow: null,
          maxOutputTokens: null,
          defaultThinking: "medium",
          compactionTokens: null,
          compactionThreshold: 1
        },
        {
          id: "gpt-5.3-codex",
          aliases: ["codex", "g53c"],
          contextWindow: 400_000,
          maxOutputTokens: 8_000,
          defaultThinking: "high",
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
      defaultVerbose: true,
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
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000,
      webSearch: {
        apiKey: null,
        model: "sonar",
        models: [
          { id: "sonar", aliases: ["search"] },
          { id: "sonar-pro", aliases: ["search-pro"] }
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
        models: (overrides.tools?.webSearch?.models as Config["tools"]["webSearch"]["models"] | undefined) ?? base.tools.webSearch.models
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
    }
  };
}
