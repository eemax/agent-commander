import * as fs from "node:fs";
import * as path from "node:path";

export type EnvSecrets = {
  telegramBotToken: string | null;
  openaiApiKey: string | null;
  webSearchApiKey: string | null;
};

const SECRET_KEYS = [
  { field: "telegramBotToken", suffix: "TELEGRAM_BOT_TOKEN" },
  { field: "openaiApiKey", suffix: "OPENAI_API_KEY" },
  { field: "webSearchApiKey", suffix: "PERPLEXITY_API_KEY" }
] as const;

function parseDotEnv(content: string): Record<string, string> {
  const output: Record<string, string> = {};
  const lines = content.split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(trimmed);
    if (!match || !match[1]) {
      continue;
    }

    const rawValue = match[2] ?? "";
    const singleQuoted = rawValue.startsWith("'") && rawValue.endsWith("'");
    const doubleQuoted = rawValue.startsWith("\"") && rawValue.endsWith("\"");
    output[match[1]] = singleQuoted || doubleQuoted ? rawValue.slice(1, -1) : rawValue.trim();
  }

  return output;
}

function normalizeSecret(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "replace_me") {
    return null;
  }

  return trimmed;
}

function agentIdToEnvPrefix(agentId: string): string {
  return agentId.toUpperCase().replace(/-/g, "_");
}

export function loadEnvFile(repoRoot: string): Record<string, string> {
  const envPath = path.resolve(repoRoot, ".env");
  const fromFile = fs.existsSync(envPath) ? parseDotEnv(fs.readFileSync(envPath, "utf8")) : {};

  const merged = { ...fromFile };
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      merged[key] = value;
    }
  }

  return merged;
}

export function extractAgentSecrets(envMap: Record<string, string>, agentId: string): EnvSecrets {
  const prefix = agentIdToEnvPrefix(agentId);

  const secrets: EnvSecrets = {
    telegramBotToken: null,
    openaiApiKey: null,
    webSearchApiKey: null
  };

  for (const { field, suffix } of SECRET_KEYS) {
    const envKey = `${prefix}_${suffix}`;
    const value = normalizeSecret(envMap[envKey]);
    secrets[field] = value;
  }

  return secrets;
}
