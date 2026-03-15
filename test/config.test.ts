import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfigTemplate, loadConfig } from "../src/config.js";
import { createTempDir } from "./helpers.js";

function writeConfig(dir: string, payload: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function minimalPayload(): Record<string, unknown> {
  return {
    telegram: {
      bot_token: "tg-token"
    },
    openai: {
      api_key: "oa-key"
    },
    runtime: {},
    access: {
      allowed_sender_ids: ["1001"]
    },
    tools: {},
    paths: {},
    observability: {}
  };
}

describe("loadConfig", () => {
  it("writes template and fails when config.json is missing", () => {
    const root = createTempDir("acmd-config-missing-");

    expect(() => loadConfig(root)).toThrow("Missing required config file");

    const created = fs.readFileSync(path.join(root, "config.json"), "utf8");
    expect(created).toContain("\"telegram\"");
    expect(created).toContain("\"allowed_sender_ids\"");
  });

  it("keeps config.example.json in sync with generated template keys", () => {
    const generated = JSON.parse(buildConfigTemplate()) as Record<string, unknown>;
    const trackedExample = JSON.parse(fs.readFileSync(path.resolve("config.example.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(trackedExample).sort()).toEqual(Object.keys(generated).sort());
  });

  it("loads required fields from nested config", () => {
    const root = createTempDir("acmd-config-required-");
    writeConfig(root, minimalPayload());

    const config = loadConfig(root);

    expect(config.telegram.botToken).toBe("tg-token");
    expect(config.openai.apiKey).toBe("oa-key");
    expect(config.access.allowedSenderIds).toEqual(new Set(["1001"]));
  });

  it("applies defaults and resolves repo-relative paths", () => {
    const root = createTempDir("acmd-config-defaults-");
    writeConfig(root, minimalPayload());

    const config = loadConfig(root);
    expect(config.telegram.streamingEnabled).toBe(true);
    expect(config.telegram.streamingMinUpdateMs).toBe(100);
    expect(config.telegram.assistantFormat).toBe("plain_text");
    expect(config.openai.model).toBe("gpt-4.1-mini");
    expect(config.openai.models.map((item) => item.id)).toContain("gpt-4.1-mini");
    expect(config.openai.models.find((item) => item.id === "gpt-5.3-codex")?.contextWindow).toBe(400000);
    expect(config.openai.models.find((item) => item.id === "gpt-5.3-codex")?.maxOutputTokens).toBeNull();
    expect(config.openai.models.find((item) => item.id === "gpt-5.3-codex")?.defaultThinking).toBe("medium");
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
    expect(config.tools.webSearch.model).toBe("sonar");
    expect(config.tools.webSearch.models.map((m) => m.id)).toContain("sonar");
    expect(config.paths.conversationsDir).toBe(path.join(root, ".agent-commander", "conversations"));
    expect(config.paths.stashedConversationsPath).toBe(path.join(root, ".agent-commander", "stashed-conversations.json"));
    expect(config.paths.activeConversationsPath).toBe(path.join(root, ".agent-commander", "active-conversations.json"));
    expect(config.paths.appLogPath).toBe(path.join(root, ".agent-commander", "app.log"));
  });

  it("loads tools.web_search overrides", () => {
    const root = createTempDir("acmd-config-web-search-");
    writeConfig(root, {
      ...minimalPayload(),
      tools: {
        web_search: {
          api_key: "pplx-key",
          model: "sonar-pro",
          available_models: [
            { id: "sonar", aliases: ["search"] },
            { id: "sonar-pro", aliases: ["search-pro"] }
          ]
        }
      }
    });

    const config = loadConfig(root);
    expect(config.tools.webSearch.apiKey).toBe("pplx-key");
    expect(config.tools.webSearch.model).toBe("sonar-pro");
    expect(config.tools.webSearch.models).toHaveLength(2);
  });

  it("treats tools.web_search.api_key placeholder as disabled", () => {
    const root = createTempDir("acmd-config-web-search-placeholder-");
    writeConfig(root, {
      ...minimalPayload(),
      tools: {
        web_search: {
          api_key: "replace_me"
        }
      }
    });

    const config = loadConfig(root);
    expect(config.tools.webSearch.apiKey).toBeNull();
  });

  it("accepts null runtime.prompt_history_limit as unbounded history", () => {
    const root = createTempDir("acmd-config-history-null-");
    writeConfig(root, {
      ...minimalPayload(),
      runtime: {
        prompt_history_limit: null
      }
    });

    const config = loadConfig(root);
    expect(config.runtime.promptHistoryLimit).toBeNull();
  });

  it("throws when allowed_sender_ids is empty", () => {
    const root = createTempDir("acmd-config-allowlist-");
    writeConfig(root, {
      ...minimalPayload(),
      access: {
        allowed_sender_ids: []
      }
    });

    expect(() => loadConfig(root)).toThrow("config.access.allowed_sender_ids must contain at least one sender ID");
  });

  it("throws for invalid retry bounds", () => {
    const root = createTempDir("acmd-config-retry-");
    writeConfig(root, {
      ...minimalPayload(),
      openai: {
        api_key: "oa-key",
        retry_base_ms: 1000,
        retry_max_ms: 500
      }
    });

    expect(() => loadConfig(root)).toThrow(
      "config.openai.retry_max_ms must be greater than or equal to config.openai.retry_base_ms"
    );
  });

  it("throws when default model is missing from openai.models", () => {
    const root = createTempDir("acmd-config-model-missing-");
    writeConfig(root, {
      ...minimalPayload(),
      openai: {
        api_key: "oa-key",
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

    expect(() => loadConfig(root)).toThrow("config.openai.model 'gpt-5.3-codex' is not present in config.openai.models");
  });

  it("throws when model ids or aliases collide", () => {
    const root = createTempDir("acmd-config-model-collision-");
    writeConfig(root, {
      ...minimalPayload(),
      openai: {
        api_key: "oa-key",
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

    expect(() => loadConfig(root)).toThrow("config.openai.models has alias collision");
  });

  it("loads per-model max_output_tokens when provided", () => {
    const root = createTempDir("acmd-config-max-output-");
    writeConfig(root, {
      ...minimalPayload(),
      openai: {
        api_key: "oa-key",
        model: "gpt-5.3-codex",
        models: [
          {
            id: "gpt-5.3-codex",
            aliases: ["codex"],
            context_window: 400000,
            max_output_tokens: 16000,
            default_thinking: "high"
          }
        ]
      }
    });

    const config = loadConfig(root);
    expect(config.openai.models[0]?.maxOutputTokens).toBe(16000);
    expect(config.openai.models[0]?.defaultThinking).toBe("high");
  });

  it("throws when model max_output_tokens is invalid", () => {
    const root = createTempDir("acmd-config-max-output-invalid-");
    writeConfig(root, {
      ...minimalPayload(),
      openai: {
        api_key: "oa-key",
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

    expect(() => loadConfig(root)).toThrow("config.openai.models.0.max_output_tokens");
  });

  it("throws when model max_output_tokens is non-integer", () => {
    const root = createTempDir("acmd-config-max-output-float-");
    writeConfig(root, {
      ...minimalPayload(),
      openai: {
        api_key: "oa-key",
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

    expect(() => loadConfig(root)).toThrow("config.openai.models.0.max_output_tokens");
  });

  it("throws when model default_thinking is invalid", () => {
    const root = createTempDir("acmd-config-default-thinking-invalid-");
    writeConfig(root, {
      ...minimalPayload(),
      openai: {
        api_key: "oa-key",
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

    expect(() => loadConfig(root)).toThrow("config.openai.models.0.default_thinking");
  });

  it("throws when strict nested shape is violated", () => {
    const root = createTempDir("acmd-config-shape-");
    writeConfig(root, {
      ...minimalPayload(),
      telegram: {
        bot_token: "tg-token",
        unknown_field: true
      }
    });

    expect(() => loadConfig(root)).toThrow("config.telegram: Unrecognized key(s) in object: 'unknown_field'");
  });

  it("throws when required secrets are placeholders", () => {
    const root = createTempDir("acmd-config-placeholder-");
    writeConfig(root, {
      ...minimalPayload(),
      telegram: {
        bot_token: "replace_me"
      }
    });

    expect(() => loadConfig(root)).toThrow("config.telegram.bot_token must be a non-empty string");
  });
});
