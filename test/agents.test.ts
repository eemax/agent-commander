import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentsManifest, loadAgentConfig, validateUniqueBotTokens, deepMerge } from "../src/agents.js";
import { createTempDir, makeConfig } from "./helpers.js";

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function minimalRootConfig(): Record<string, unknown> {
  return {
    telegram: {},
    openai: {},
    runtime: {},
    tools: {},
    paths: {},
    observability: {}
  };
}

describe("deepMerge", () => {
  it("merges nested objects at leaf level", () => {
    const base = { a: { b: 1, c: 2 }, d: 3 };
    const overlay = { a: { b: 10 } };
    expect(deepMerge(base, overlay)).toEqual({ a: { b: 10, c: 2 }, d: 3 });
  });

  it("replaces arrays entirely", () => {
    const base = { items: [1, 2, 3] };
    const overlay = { items: [4] };
    expect(deepMerge(base, overlay)).toEqual({ items: [4] });
  });

  it("explicit null overrides", () => {
    const base = { a: { b: 1 } };
    const overlay = { a: null };
    expect(deepMerge(base, overlay)).toEqual({ a: null });
  });

  it("returns base when overlay is undefined", () => {
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it("overlay adds new keys", () => {
    const base = { a: 1 };
    const overlay = { b: 2 };
    expect(deepMerge(base, overlay)).toEqual({ a: 1, b: 2 });
  });

  it("throws when depth exceeds limit", () => {
    let base: Record<string, unknown> = { leaf: 1 };
    let overlay: Record<string, unknown> = { leaf: 2 };
    for (let i = 0; i < 25; i++) {
      base = { child: base };
      overlay = { child: overlay };
    }
    expect(() => deepMerge(base, overlay)).toThrow("deepMerge exceeded max depth");
  });

  it("allows merges within depth limit", () => {
    let base: Record<string, unknown> = { leaf: 1 };
    let overlay: Record<string, unknown> = { leaf: 2 };
    for (let i = 0; i < 10; i++) {
      base = { child: base };
      overlay = { child: overlay };
    }
    expect(() => deepMerge(base, overlay)).not.toThrow();
  });
});

describe("loadAgentsManifest", () => {
  it("creates and returns single default agent when agents.json is missing", () => {
    const root = createTempDir("acmd-agents-missing-");
    const manifest = loadAgentsManifest(root);
    expect(manifest.agents).toHaveLength(1);
    expect(manifest.agents[0].id).toBe("default");
    expect(manifest.agents[0].configDir).toBe(".");

    const persisted = JSON.parse(fs.readFileSync(path.join(root, "config", "agents.json"), "utf8")) as {
      agents: Array<{ id: string; config_dir: string; telegram_allowlist: string[] }>;
    };
    expect(persisted.agents[0]?.id).toBe("default");
    expect(persisted.agents[0]?.config_dir).toBe(".");
    expect(persisted.agents[0]?.telegram_allowlist).toEqual([]);
  });

  it("loads agents from agents.json", () => {
    const root = createTempDir("acmd-agents-load-");
    fs.mkdirSync(path.join(root, "agents", "coder"), { recursive: true });
    writeJson(path.join(root, "config", "agents.json"), {
      agents: [
        { id: "default", aliases: ["main"], config_dir: ".", telegram_allowlist: ["1001"] },
        { id: "coder", aliases: ["dev"], config_dir: "./agents/coder", telegram_allowlist: ["1002"] }
      ]
    });

    const manifest = loadAgentsManifest(root);
    expect(manifest.agents).toHaveLength(2);
    expect(manifest.agents[0].id).toBe("default");
    expect(manifest.agents[1].id).toBe("coder");
    expect(manifest.agents[1].aliases).toEqual(["dev"]);
  });

  it("auto-prepends default agent if not listed", () => {
    const root = createTempDir("acmd-agents-nodefault-");
    fs.mkdirSync(path.join(root, "agents", "coder"), { recursive: true });
    writeJson(path.join(root, "config", "agents.json"), {
      agents: [{ id: "coder", aliases: [], config_dir: "./agents/coder", telegram_allowlist: [] }]
    });

    const manifest = loadAgentsManifest(root);
    expect(manifest.agents[0].id).toBe("default");
    expect(manifest.agents[1].id).toBe("coder");
  });

  it("rejects duplicate agent ids", () => {
    const root = createTempDir("acmd-agents-dup-");
    writeJson(path.join(root, "config", "agents.json"), {
      agents: [
        { id: "default", aliases: [], config_dir: "." },
        { id: "default", aliases: [], config_dir: ".", telegram_allowlist: [] }
      ]
    });

    expect(() => loadAgentsManifest(root)).toThrow("duplicate agent id");
  });

  it("rejects alias collision across agents", () => {
    const root = createTempDir("acmd-agents-alias-");
    fs.mkdirSync(path.join(root, "agents", "a"), { recursive: true });
    fs.mkdirSync(path.join(root, "agents", "b"), { recursive: true });
    writeJson(path.join(root, "config", "agents.json"), {
      agents: [
        { id: "agent-a", aliases: ["shared"], config_dir: "./agents/a", telegram_allowlist: [] },
        { id: "agent-b", aliases: ["shared"], config_dir: "./agents/b", telegram_allowlist: [] }
      ]
    });

    expect(() => loadAgentsManifest(root)).toThrow("collides");
  });

  it("rejects missing config_dir", () => {
    const root = createTempDir("acmd-agents-nodir-");
    writeJson(path.join(root, "config", "agents.json"), {
      agents: [{ id: "ghost", aliases: [], config_dir: "./does-not-exist", telegram_allowlist: [] }]
    });

    expect(() => loadAgentsManifest(root)).toThrow("does not exist");
  });
});

describe("loadAgentConfig", () => {
  it("loads config for default agent from root config.json", () => {
    const root = createTempDir("acmd-agentcfg-default-");
    writeJson(path.join(root, "config", "config.json"), minimalRootConfig());

    const config = loadAgentConfig(root, { id: "default", aliases: [], configDir: ".", telegramAllowlist: ["1001"] }, {
      telegramBotToken: "tg-default",
      openaiApiKey: "oa-default",
      webSearchApiKey: null
    });

    expect(config.agentId).toBe("default");
    expect(config.telegram.botToken).toBe("tg-default");
    expect(config.openai.apiKey).toBe("oa-default");
    expect(config.access.allowedSenderIds).toEqual(new Set(["1001"]));
  });

  it("deep merges agent config over root config", () => {
    const root = createTempDir("acmd-agentcfg-merge-");
    writeJson(path.join(root, "config", "config.json"), minimalRootConfig());

    const agentDir = path.join(root, "agents", "coder");
    fs.mkdirSync(agentDir, { recursive: true });
    writeJson(path.join(agentDir, "config.json"), {
      openai: { model: "gpt-5.3-codex" }
    });

    const config = loadAgentConfig(root, { id: "coder", aliases: [], configDir: "./agents/coder", telegramAllowlist: ["1002"] }, {
      telegramBotToken: "tg-coder",
      openaiApiKey: "oa-coder",
      webSearchApiKey: null
    });

    expect(config.agentId).toBe("coder");
    expect(config.telegram.botToken).toBe("tg-coder");
    expect(config.openai.model).toBe("gpt-5.3-codex");
    expect(config.openai.apiKey).toBe("oa-coder");
  });

  it("namespaces paths for non-default agents", () => {
    const root = createTempDir("acmd-agentcfg-paths-");
    writeJson(path.join(root, "config", "config.json"), minimalRootConfig());

    const agentDir = path.join(root, "agents", "coder");
    fs.mkdirSync(agentDir, { recursive: true });

    const config = loadAgentConfig(root, { id: "coder", aliases: [], configDir: "./agents/coder", telegramAllowlist: [] }, {
      telegramBotToken: "tg-coder",
      openaiApiKey: "oa-coder",
      webSearchApiKey: null
    });

    expect(config.paths.workspaceRoot).toContain("agents/coder");
    expect(config.paths.conversationsDir).toContain("agents/coder");
    expect(config.paths.appLogPath).toContain("agents/coder");
  });

  it("does not namespace paths for default agent", () => {
    const root = createTempDir("acmd-agentcfg-defpath-");
    writeJson(path.join(root, "config", "config.json"), minimalRootConfig());

    const config = loadAgentConfig(root, { id: "default", aliases: [], configDir: ".", telegramAllowlist: [] }, {
      telegramBotToken: "tg-default",
      openaiApiKey: "oa-default",
      webSearchApiKey: null
    });

    expect(config.paths.workspaceRoot).not.toContain("agents/default");
  });

  it("inherits all root config when agent config.json does not exist", () => {
    const root = createTempDir("acmd-agentcfg-nofile-");
    writeJson(path.join(root, "config", "config.json"), minimalRootConfig());

    const agentDir = path.join(root, "agents", "coder");
    fs.mkdirSync(agentDir, { recursive: true });

    const config = loadAgentConfig(root, { id: "coder", aliases: [], configDir: "./agents/coder", telegramAllowlist: [] }, {
      telegramBotToken: "tg-coder",
      openaiApiKey: "oa-coder",
      webSearchApiKey: null
    });

    expect(config.openai.model).toBe("gpt-5.4-mini");
    expect(config.telegram.botToken).toBe("tg-coder");
  });

  it("enforces env secrets for required credentials", () => {
    const root = createTempDir("acmd-agentcfg-missing-secrets-");
    writeJson(path.join(root, "config", "config.json"), minimalRootConfig());

    expect(() =>
      loadAgentConfig(root, { id: "default", aliases: [], configDir: ".", telegramAllowlist: [] }, {
        telegramBotToken: null,
        openaiApiKey: null,
        webSearchApiKey: null
      })
    ).toThrow("DEFAULT_TELEGRAM_BOT_TOKEN must be a non-empty string");
  });
});

describe("validateUniqueBotTokens", () => {
  it("passes with unique tokens", () => {
    const entries = [
      { agent: { id: "a", aliases: [], configDir: ".", telegramAllowlist: [] }, config: makeConfig({ telegram: { botToken: "t1" } }) },
      { agent: { id: "b", aliases: [], configDir: ".", telegramAllowlist: [] }, config: makeConfig({ telegram: { botToken: "t2" } }) }
    ];
    expect(() => validateUniqueBotTokens(entries)).not.toThrow();
  });

  it("throws on duplicate tokens", () => {
    const entries = [
      { agent: { id: "a", aliases: [], configDir: ".", telegramAllowlist: [] }, config: makeConfig({ telegram: { botToken: "same" } }) },
      { agent: { id: "b", aliases: [], configDir: ".", telegramAllowlist: [] }, config: makeConfig({ telegram: { botToken: "same" } }) }
    ];
    expect(() => validateUniqueBotTokens(entries)).toThrow("share the same Telegram bot token");
  });
});
