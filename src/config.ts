import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

const configSchema = z.strictObject({
  telegram: z.strictObject({
    allowlist: z
      .array(z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String))
      .min(1, "telegram.allowlist is empty: add your Telegram user id")
  }),
  models: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        alias: z.string().regex(/^[a-z0-9_-]+$/, "model alias must be lowercase letters, digits, - or _")
      })
    )
    .min(1, "models is empty: add at least one OpenRouter model id"),
  default_effort: z.enum(EFFORTS).default("medium"),
  home: z.string().default("~/.acmd"),
  box_dir: z.string().default("/etc/acmd"),
  bash: z
    .strictObject({
      timeout_ms: z.number().int().positive().default(120_000),
      max_timeout_ms: z.number().int().positive().default(600_000),
      output_cap_chars: z.number().int().min(1000).default(30_000)
    })
    .prefault({}),
  max_turn_cost_usd: z.number().positive().nullable().default(null),
  credits_warn_usd: z.number().nonnegative().default(5)
});

export type ModelEntry = { id: string; alias: string };

export type Config = {
  allowlist: string[];
  models: ModelEntry[];
  defaultEffort: Effort;
  home: string;
  // The machine's own context and skills, kept by whoever provisions it (context.d/, skills.d/).
  boxDir: string;
  bash: { timeoutMs: number; maxTimeoutMs: number; outputCapChars: number };
  maxTurnCostUsd: number | null;
  creditsWarnUsd: number;
};

export type Secrets = { telegramBotToken: string; openrouterApiKey: string };

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new Error(`config ${where}${issue.message}`);
  }
  const c = result.data;
  if (c.bash.max_timeout_ms < c.bash.timeout_ms) throw new Error("config bash: max_timeout_ms must be at least timeout_ms");
  const aliases = new Set<string>();
  for (const m of c.models) {
    if (aliases.has(m.alias)) throw new Error(`config models: duplicate alias "${m.alias}"`);
    aliases.add(m.alias);
  }
  return {
    allowlist: c.telegram.allowlist,
    models: c.models,
    defaultEffort: c.default_effort,
    home: path.resolve(expandHome(c.home)),
    boxDir: path.resolve(expandHome(c.box_dir)),
    bash: { timeoutMs: c.bash.timeout_ms, maxTimeoutMs: c.bash.max_timeout_ms, outputCapChars: c.bash.output_cap_chars },
    maxTurnCostUsd: c.max_turn_cost_usd,
    creditsWarnUsd: c.credits_warn_usd
  };
}

export function configPath(): string {
  return process.env.ACMD_CONFIG ?? path.join(REPO_ROOT, "config", "config.json");
}

export function loadConfig(): Config {
  const file = configPath();
  if (!fs.existsSync(file)) {
    throw new Error(`config file not found at ${file}: copy config/config.example.json to config/config.json`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`config file ${file} is not valid JSON: ${(error as Error).message}`);
  }
  return parseConfig(raw);
}

export function loadSecrets(): Secrets {
  const envFile = path.join(REPO_ROOT, ".env");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim() ?? "";
  if (!telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN is not set: add it to .env");
  if (!openrouterApiKey) throw new Error("OPENROUTER_API_KEY is not set: add it to .env");
  return { telegramBotToken, openrouterApiKey };
}

export function resolveModel(config: Config, aliasOrId: string): ModelEntry | null {
  return config.models.find((m) => m.alias === aliasOrId || m.id === aliasOrId) ?? null;
}
