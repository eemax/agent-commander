import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createTempDir } from "./helpers.js";

function writeConfig(dir: string, payload: Record<string, unknown>): void {
  const configDir = path.join(dir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function minimalPayload(): Record<string, unknown> {
  return {
    telegram: {},
    openai: {},
    runtime: {},
    tools: {},
    paths: {},
    observability: {}
  };
}

function withDefaultSecrets(
  values: Partial<
    Record<"DEFAULT_TELEGRAM_BOT_TOKEN" | "DEFAULT_OPENAI_API_KEY" | "DEFAULT_PERPLEXITY_API_KEY", string | null>
  >,
  run: () => void
): void {
  const keys = ["DEFAULT_TELEGRAM_BOT_TOKEN", "DEFAULT_OPENAI_API_KEY", "DEFAULT_PERPLEXITY_API_KEY"] as const;
  const previous = new Map<(typeof keys)[number], string | undefined>();

  for (const key of keys) {
    previous.set(key, process.env[key]);
    const nextValue = values[key];
    if (typeof nextValue === "string") {
      process.env[key] = nextValue;
    } else {
      delete process.env[key];
    }
  }

  try {
    run();
  } finally {
    for (const key of keys) {
      const priorValue = previous.get(key);
      if (typeof priorValue === "string") {
        process.env[key] = priorValue;
      } else {
        delete process.env[key];
      }
    }
  }
}

function loadConfigWithRequiredDefaults(root: string): ReturnType<typeof loadConfig> {
  let resolved: ReturnType<typeof loadConfig> | undefined;
  withDefaultSecrets(
    {
      DEFAULT_TELEGRAM_BOT_TOKEN: "tg-default",
      DEFAULT_OPENAI_API_KEY: "oa-default"
    },
    () => {
      resolved = loadConfig(root);
    }
  );
  if (!resolved) {
    throw new Error("failed to resolve config with defaults");
  }
  return resolved;
}

describe("loadConfig", () => {
  it("writes template and fails when config.json is missing", () => {
    const root = createTempDir("acmd-config-missing-");

    expect(() => loadConfig(root)).toThrow("Missing required config file");

    const created = fs.readFileSync(path.join(root, "config", "config.json"), "utf8");
    expect(created).toContain("\"telegram\"");
    expect(created).toContain("\"tools\"");
  });

  it("loads required fields from nested config", () => {
    const root = createTempDir("acmd-config-required-");
    writeConfig(root, minimalPayload());

    const config = loadConfigWithRequiredDefaults(root);

    expect(config.telegram.botToken).toBe("tg-default");
    expect(config.openai.apiKey).toBe("oa-default");
    expect(config.access.allowedSenderIds).toEqual(new Set());
  });

  it("applies defaults and resolves repo-relative paths", () => {
    const root = createTempDir("acmd-config-defaults-");
    writeConfig(root, minimalPayload());

    const config = loadConfigWithRequiredDefaults(root);
    expect(config.telegram.streamingEnabled).toBe(true);
    expect(config.telegram.streamingMinUpdateMs).toBe(100);
    expect(config.telegram.assistantFormat).toBe("plain_text");
    expect(config.openai.model).toBe("gpt-4.1-mini");
    expect(config.openai.models.map((item) => item.id)).toContain("gpt-4.1-mini");
    expect(config.openai.models.find((item) => item.id === "gpt-5.3-codex")?.contextWindow).toBe(400000);
    expect(config.openai.models.find((item) => item.id === "gpt-5.3-codex")?.maxOutputTokens).toBeNull();
    expect(config.openai.models.find((item) => item.id === "gpt-5.3-codex")?.defaultThinking).toBe("medium");
    expect(config.openai.models.find((item) => item.id === "gpt-5.3-codex")?.cacheRetention).toBe("in_memory");
    expect(config.runtime.logLevel).toBe("info");
    expect(config.runtime.defaultVerbose).toBe(true);
    expect(config.runtime.toolLoopMaxSteps).toBe(30);
    expect(config.runtime.toolWorkflowTimeoutMs).toBe(120000);
    expect(config.runtime.toolCommandTimeoutMs).toBe(15000);
    expect(config.runtime.toolPollIntervalMs).toBe(2000);
    expect(config.runtime.toolPollMaxAttempts).toBe(5);
    expect(config.runtime.toolIdleOutputThresholdMs).toBe(8000);
    expect(config.runtime.toolHeartbeatIntervalMs).toBe(5000);
    expect(config.runtime.toolCleanupGraceMs).toBe(3000);
    expect(config.runtime.toolFailureBreakerThreshold).toBe(4);
    expect(config.observability.enabled).toBe(false);
    expect(config.observability.logPath).toBe(path.join(root, ".agent-commander", "observability.jsonl"));
    expect(config.observability.redaction.enabled).toBe(true);
    expect(config.observability.redaction.maxStringChars).toBe(4000);
    expect(config.observability.redaction.redactKeys).toContain("authorization");
    expect(config.runtime.promptHistoryLimit).toBe(20);
    expect(config.paths.workspaceRoot).toContain(path.join(".agent-commander"));
    expect(config.tools.defaultCwd).toBe(config.paths.workspaceRoot);
    expect(config.tools.defaultShell).toBe("/bin/bash");
    expect(config.tools.logPath).toBe(path.join(root, ".agent-commander", "tool-calls.jsonl"));
    expect(config.tools.webSearch.apiKey).toBeNull();
    expect(config.tools.webSearch.defaultPreset).toBe("pro-search");
    expect(config.tools.webSearch.presets.map((m) => m.id)).toContain("pro-search");
    expect(config.paths.conversationsDir).toBe(path.join(root, ".agent-commander", "conversations"));
    expect(config.paths.stashedConversationsPath).toBe(path.join(root, ".agent-commander", "stashed-conversations.json"));
    expect(config.paths.activeConversationsPath).toBe(path.join(root, ".agent-commander", "active-conversations.json"));
    expect(config.paths.appLogPath).toBe(path.join(root, ".agent-commander", "app.log"));
  });

  it("loads tools.web_search preset overrides", () => {
    const root = createTempDir("acmd-config-web-search-");
    writeConfig(root, {
      ...minimalPayload(),
      tools: {
        web_search: {
          default_preset: "deep-research",
          presets: [
            { id: "fast-search", aliases: ["fast"] },
            { id: "deep-research", aliases: ["deep"] }
          ]
        }
      }
    });

    const config = loadConfigWithRequiredDefaults(root);
    expect(config.tools.webSearch.apiKey).toBeNull();
    expect(config.tools.webSearch.defaultPreset).toBe("deep-research");
    expect(config.tools.webSearch.presets).toHaveLength(2);
  });

  it("loads default credentials from .env defaults", () => {
    const root = createTempDir("acmd-config-dotenv-defaults-");
    writeConfig(root, minimalPayload());
    fs.writeFileSync(
      path.join(root, ".env"),
      [
        "DEFAULT_TELEGRAM_BOT_TOKEN=tg-from-dotenv",
        "DEFAULT_OPENAI_API_KEY=oa-from-dotenv",
        "DEFAULT_PERPLEXITY_API_KEY=pplx-from-dotenv"
      ].join("\n"),
      "utf8"
    );

    withDefaultSecrets({}, () => {
      const config = loadConfig(root);
      expect(config.telegram.botToken).toBe("tg-from-dotenv");
      expect(config.openai.apiKey).toBe("oa-from-dotenv");
      expect(config.tools.webSearch.apiKey).toBe("pplx-from-dotenv");
    });
  });

  it("prefers process.env defaults over .env defaults", () => {
    const root = createTempDir("acmd-config-dotenv-process-defaults-");
    writeConfig(root, minimalPayload());
    fs.writeFileSync(
      path.join(root, ".env"),
      [
        "DEFAULT_TELEGRAM_BOT_TOKEN=tg-from-dotenv",
        "DEFAULT_OPENAI_API_KEY=oa-from-dotenv",
        "DEFAULT_PERPLEXITY_API_KEY=pplx-from-dotenv"
      ].join("\n"),
      "utf8"
    );

    withDefaultSecrets(
      {
        DEFAULT_TELEGRAM_BOT_TOKEN: "tg-from-process",
        DEFAULT_OPENAI_API_KEY: "oa-from-process",
        DEFAULT_PERPLEXITY_API_KEY: "pplx-from-process"
      },
      () => {
        const config = loadConfig(root);
        expect(config.telegram.botToken).toBe("tg-from-process");
        expect(config.openai.apiKey).toBe("oa-from-process");
        expect(config.tools.webSearch.apiKey).toBe("pplx-from-process");
      }
    );
  });

  it("rejects deprecated credential keys in config.json", () => {
    const root = createTempDir("acmd-config-legacy-keys-");
    writeConfig(root, {
      ...minimalPayload(),
      telegram: {
        bot_token: "legacy"
      },
      openai: {
        api_key: "legacy"
      },
      tools: {
        web_search: {
          api_key: "legacy"
        }
      }
    });

    withDefaultSecrets(
      {
        DEFAULT_TELEGRAM_BOT_TOKEN: "tg-from-process",
        DEFAULT_OPENAI_API_KEY: "oa-from-process"
      },
      () => {
        expect(() => loadConfig(root)).toThrow("config.telegram: Unrecognized key(s) in object: 'bot_token'");
      }
    );
  });

  it("accepts null runtime.prompt_history_limit as unbounded history", () => {
    const root = createTempDir("acmd-config-history-null-");
    writeConfig(root, {
      ...minimalPayload(),
      runtime: {
        prompt_history_limit: null
      }
    });

    const config = loadConfigWithRequiredDefaults(root);
    expect(config.runtime.promptHistoryLimit).toBeNull();
  });

  it("throws for invalid retry bounds", () => {
    const root = createTempDir("acmd-config-retry-");
    writeConfig(root, {
      ...minimalPayload(),
      openai: {
        retry_base_ms: 1000,
        retry_max_ms: 500
      }
    });

    expect(() => loadConfigWithRequiredDefaults(root)).toThrow(
      "config.openai.retry_max_ms must be greater than or equal to config.openai.retry_base_ms"
    );
  });

  it("throws when default model is missing from openai.models", () => {
    const root = createTempDir("acmd-config-model-missing-");
    writeConfig(root, {
      ...minimalPayload(),
      openai: {
        model: "gpt-5.3-codex",
        models: [
          {
            id: "gpt-4.1-mini",
            aliases: ["mini"],
            context_window: null
          }
        ]
      }
    });

    expect(() => loadConfigWithRequiredDefaults(root)).toThrow(
      "config.openai.model 'gpt-5.3-codex' is not present in config.openai.models"
    );
  });

  it("throws when model ids or aliases collide", () => {
    const root = createTempDir("acmd-config-model-collision-");
    writeConfig(root, {
      ...minimalPayload(),
      openai: {
        model: "gpt-4.1-mini",
        models: [
          {
            id: "gpt-4.1-mini",
            aliases: ["mini"],
            context_window: null
          },
          {
            id: "gpt-5.3-codex",
            aliases: ["mini"],
            context_window: 400000
          }
        ]
      }
    });

    expect(() => loadConfigWithRequiredDefaults(root)).toThrow("config.openai.models has alias collision");
  });

  it("loads per-model max_output_tokens when provided", () => {
    const root = createTempDir("acmd-config-max-output-");
    writeConfig(root, {
      ...minimalPayload(),
      openai: {
        model: "gpt-5.3-codex",
        models: [
          {
            id: "gpt-5.3-codex",
            aliases: ["codex"],
            context_window: 400000,
            max_output_tokens: 16000,
            default_thinking: "high",
            cache_retention: "24h"
          }
        ]
      }
    });

    const config = loadConfigWithRequiredDefaults(root);
    expect(config.openai.models[0]?.maxOutputTokens).toBe(16000);
    expect(config.openai.models[0]?.defaultThinking).toBe("high");
    expect(config.openai.models[0]?.cacheRetention).toBe("24h");
  });

  it("throws when model max_output_tokens is invalid", () => {
    const root = createTempDir("acmd-config-max-output-invalid-");
    writeConfig(root, {
      ...minimalPayload(),
      openai: {
        model: "gpt-5.3-codex",
        models: [
          {
            id: "gpt-5.3-codex",
            aliases: ["codex"],
            context_window: 400000,
            max_output_tokens: 0
          }
        ]
      }
    });

    expect(() => loadConfigWithRequiredDefaults(root)).toThrow("config.openai.models.0.max_output_tokens");
  });

  it("throws when model max_output_tokens is non-integer", () => {
    const root = createTempDir("acmd-config-max-output-float-");
    writeConfig(root, {
      ...minimalPayload(),
      openai: {
        model: "gpt-5.3-codex",
        models: [
          {
            id: "gpt-5.3-codex",
            aliases: ["codex"],
            context_window: 400000,
            max_output_tokens: 1024.5
          }
        ]
      }
    });

    expect(() => loadConfigWithRequiredDefaults(root)).toThrow("config.openai.models.0.max_output_tokens");
  });

  it("throws when model default_thinking is invalid", () => {
    const root = createTempDir("acmd-config-default-thinking-invalid-");
    writeConfig(root, {
      ...minimalPayload(),
      openai: {
        model: "gpt-5.3-codex",
        models: [
          {
            id: "gpt-5.3-codex",
            aliases: ["codex"],
            context_window: 400000,
            default_thinking: "ultra"
          }
        ]
      }
    });

    expect(() => loadConfigWithRequiredDefaults(root)).toThrow("config.openai.models.0.default_thinking");
  });

  it("throws when model cache_retention is invalid", () => {
    const root = createTempDir("acmd-config-cache-retention-invalid-");
    writeConfig(root, {
      ...minimalPayload(),
      openai: {
        model: "gpt-5.3-codex",
        models: [
          {
            id: "gpt-5.3-codex",
            aliases: ["codex"],
            context_window: 400000,
            cache_retention: "7d"
          }
        ]
      }
    });

    expect(() => loadConfigWithRequiredDefaults(root)).toThrow("config.openai.models.0.cache_retention");
  });

  it("throws when strict nested shape is violated", () => {
    const root = createTempDir("acmd-config-shape-");
    writeConfig(root, {
      ...minimalPayload(),
      telegram: {
        unknown_field: true
      }
    });

    expect(() => loadConfigWithRequiredDefaults(root)).toThrow("config.telegram: Unrecognized key(s) in object: 'unknown_field'");
  });

  it("throws when required DEFAULT_* env vars are missing", () => {
    const root = createTempDir("acmd-config-placeholder-");
    writeConfig(root, minimalPayload());

    withDefaultSecrets({}, () => {
      expect(() => loadConfig(root)).toThrow("DEFAULT_TELEGRAM_BOT_TOKEN must be a non-empty string");
    });
  });
});
