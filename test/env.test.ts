import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnvFile, extractAgentSecrets } from "../src/env.js";
import { createTempDir } from "./helpers.js";

describe("loadEnvFile", () => {
  it("returns process env values when .env does not exist", () => {
    const root = createTempDir("acmd-env-missing-");
    process.env.DEFAULT_OPENAI_API_KEY = "process-oa";

    const result = loadEnvFile(root);
    expect(result.DEFAULT_OPENAI_API_KEY).toBe("process-oa");

    delete process.env.DEFAULT_OPENAI_API_KEY;
  });

  it("parses .env file into key-value map", () => {
    const root = createTempDir("acmd-env-parse-");
    fs.writeFileSync(path.join(root, ".env"), "FOO=bar\nBAZ=qux\n", "utf8");

    const result = loadEnvFile(root);
    expect(result.FOO).toBe("bar");
    expect(result.BAZ).toBe("qux");
  });

  it("handles comments and empty lines", () => {
    const root = createTempDir("acmd-env-comments-");
    fs.writeFileSync(path.join(root, ".env"), "# comment\n\nKEY=value\n", "utf8");

    const result = loadEnvFile(root);
    expect(result.KEY).toBe("value");
  });
});

describe("extractAgentSecrets", () => {
  it("extracts prefixed secrets for a named agent", () => {
    const envMap = {
      CODER_TELEGRAM_BOT_TOKEN: "tg-coder",
      CODER_OPENAI_API_KEY: "oa-coder",
      CODER_PERPLEXITY_API_KEY: "pplx-coder"
    };

    const secrets = extractAgentSecrets(envMap, "coder");
    expect(secrets).toEqual({
      telegramBotToken: "tg-coder",
      openaiApiKey: "oa-coder",
      webSearchApiKey: "pplx-coder"
    });
  });

  it("returns null for missing keys", () => {
    const secrets = extractAgentSecrets({}, "coder");
    expect(secrets).toEqual({
      telegramBotToken: null,
      openaiApiKey: null,
      webSearchApiKey: null
    });
  });

  it("trims whitespace and ignores empty values", () => {
    const envMap = { CODER_OPENAI_API_KEY: "  ", CODER_TELEGRAM_BOT_TOKEN: " tok " };
    const secrets = extractAgentSecrets(envMap, "coder");
    expect(secrets.openaiApiKey).toBeNull();
    expect(secrets.telegramBotToken).toBe("tok");
  });

  it("converts hyphens in agent id to underscores for prefix", () => {
    const envMap = { MY_AGENT_OPENAI_API_KEY: "oa-key" };
    const secrets = extractAgentSecrets(envMap, "my-agent");
    expect(secrets.openaiApiKey).toBe("oa-key");
  });

  it("uses DEFAULT_* keys for default agent", () => {
    const envMap = {
      DEFAULT_OPENAI_API_KEY: "oa-default",
      DEFAULT_TELEGRAM_BOT_TOKEN: "tg-default",
      DEFAULT_PERPLEXITY_API_KEY: "pplx-default"
    };

    const secrets = extractAgentSecrets(envMap, "default");
    expect(secrets).toEqual({
      telegramBotToken: "tg-default",
      openaiApiKey: "oa-default",
      webSearchApiKey: "pplx-default"
    });
  });

  it("does not fall back to unprefixed keys", () => {
    const envMap = {
      OPENAI_API_KEY: "oa-unprefixed",
      TELEGRAM_BOT_TOKEN: "tg-unprefixed",
      PERPLEXITY_API_KEY: "pplx-unprefixed"
    };

    const secrets = extractAgentSecrets(envMap, "default");
    expect(secrets).toEqual({
      telegramBotToken: null,
      openaiApiKey: null,
      webSearchApiKey: null
    });
  });
});
