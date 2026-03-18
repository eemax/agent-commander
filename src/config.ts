import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { EnvSecrets } from "./env.js";
import type { Config, LogLevel, TelegramAssistantFormat } from "./runtime/contracts.js";
import type { WebSearchModelCatalogEntry } from "./web-search-catalog.js";
import { DEFAULT_OBSERVABILITY_REDACTION } from "./observability.js";
import { THINKING_EFFORT_VALUES, type ThinkingEffort } from "./types.js";

const LOG_LEVEL_VALUES = ["debug", "info", "warn", "error"] as const;
const TELEGRAM_ASSISTANT_FORMAT_VALUES = ["plain_text", "markdown_to_html"] as const;
const DEFAULT_TELEGRAM_BOT_TOKEN_KEY = "DEFAULT_TELEGRAM_BOT_TOKEN";
const DEFAULT_OPENAI_API_KEY_KEY = "DEFAULT_OPENAI_API_KEY";
const DEFAULT_PERPLEXITY_API_KEY_KEY = "DEFAULT_PERPLEXITY_API_KEY";

const DEFAULT_CONFIG_TEMPLATE = {
  telegram: {
    streaming_enabled: true,
    streaming_min_update_ms: 100,
    assistant_format: "plain_text"
  },
  openai: {
    model: "gpt-4.1-mini",
    models: [
      {
        id: "gpt-4.1-mini",
        aliases: ["mini"],
        context_window: null,
        max_output_tokens: null,
        default_thinking: "medium",
        compaction_tokens: null,
        compaction_threshold: 1
      },
      {
        id: "gpt-5.3-codex",
        aliases: ["codex", "g53c"],
        context_window: 400_000,
        max_output_tokens: null,
        default_thinking: "medium",
        compaction_tokens: null,
        compaction_threshold: 1
      }
    ],
    timeout_ms: 45_000,
    max_retries: 2,
    retry_base_ms: 250,
    retry_max_ms: 2_000
  },
  runtime: {
    log_level: "info",
    prompt_history_limit: 20,
    default_verbose: true,
    tool_loop_max_steps: 30,
    tool_workflow_timeout_ms: 120_000,
    tool_command_timeout_ms: 15_000,
    tool_poll_interval_ms: 2_000,
    tool_poll_max_attempts: 5,
    tool_idle_output_threshold_ms: 8_000,
    tool_heartbeat_interval_ms: 5_000,
    tool_cleanup_grace_ms: 3_000,
    tool_failure_breaker_threshold: 4,
    session_cache_max_entries: 200,
    app_log_flush_interval_ms: 1_000,
    message_queue_mode: "batch"
  },
  access: {
    allowed_sender_ids: ["replace_me"]
  },
  tools: {
    default_cwd: null,
    default_shell: "/bin/bash",
    exec_timeout_ms: 1_800_000,
    exec_yield_ms: 10_000,
    process_log_tail_lines: 200,
    log_path: ".agent-commander/tool-calls.jsonl",
    completed_session_retention_ms: 3_600_000,
    max_completed_sessions: 500,
    max_output_chars: 200_000,
    web_search: {
      model: "sonar",
      available_models: [
        { id: "sonar", aliases: ["search"] },
        { id: "sonar-pro", aliases: ["search-pro"] }
      ]
    }
  },
  paths: {
    workspace_root: "~/.agent-commander",
    conversations_dir: ".agent-commander/conversations",
    stashed_conversations_path: ".agent-commander/stashed-conversations.json",
    active_conversations_path: ".agent-commander/active-conversations.json",
    context_snapshots_dir: ".agent-commander/context-snapshots",
    app_log_path: ".agent-commander/app.log"
  },
  observability: {
    enabled: false,
    log_path: ".agent-commander/observability.jsonl",
    redaction: {
      enabled: DEFAULT_OBSERVABILITY_REDACTION.enabled,
      max_string_chars: DEFAULT_OBSERVABILITY_REDACTION.maxStringChars,
      redact_keys: [...DEFAULT_OBSERVABILITY_REDACTION.redactKeys]
    }
  }
} as const;

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().min(0);
const optionalNonEmptyString = z.string().trim().min(1);
const DEFAULT_OPENAI_MODELS = DEFAULT_CONFIG_TEMPLATE.openai.models.map((item) => ({
  id: item.id,
  aliases: [...item.aliases],
  context_window: item.context_window,
  max_output_tokens: item.max_output_tokens,
  default_thinking: item.default_thinking,
  compaction_tokens: item.compaction_tokens,
  compaction_threshold: item.compaction_threshold
}));
const DEFAULT_WEB_SEARCH_MODELS = DEFAULT_CONFIG_TEMPLATE.tools.web_search.available_models.map((item) => ({
  id: item.id,
  aliases: [...item.aliases]
}));
const webSearchModelSchema = z
  .object({
    id: optionalNonEmptyString,
    aliases: z.array(optionalNonEmptyString).default([])
  })
  .strict();

const openAIModelSchema = z
  .object({
    id: optionalNonEmptyString,
    aliases: z.array(optionalNonEmptyString).default([]),
    context_window: positiveInt.nullable().default(null),
    max_output_tokens: positiveInt.nullable().default(null),
    default_thinking: z.enum(THINKING_EFFORT_VALUES).default("medium"),
    compaction_tokens: positiveInt.nullable().default(null),
    compaction_threshold: z.number().min(0.1).max(1).default(1)
  })
  .strict();

export const configSchema = z
  .object({
    telegram: z
      .object({
        streaming_enabled: z.boolean().default(DEFAULT_CONFIG_TEMPLATE.telegram.streaming_enabled),
        streaming_min_update_ms: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.telegram.streaming_min_update_ms),
        assistant_format: z
          .enum(TELEGRAM_ASSISTANT_FORMAT_VALUES)
          .default(DEFAULT_CONFIG_TEMPLATE.telegram.assistant_format as TelegramAssistantFormat)
      })
      .strict(),
    openai: z
      .object({
        model: optionalNonEmptyString.default(DEFAULT_CONFIG_TEMPLATE.openai.model),
        models: z.array(openAIModelSchema).min(1).default(DEFAULT_OPENAI_MODELS),
        timeout_ms: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.openai.timeout_ms),
        max_retries: nonNegativeInt.default(DEFAULT_CONFIG_TEMPLATE.openai.max_retries),
        retry_base_ms: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.openai.retry_base_ms),
        retry_max_ms: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.openai.retry_max_ms)
      })
      .strict(),
    runtime: z
      .object({
        log_level: z.enum(LOG_LEVEL_VALUES).default(DEFAULT_CONFIG_TEMPLATE.runtime.log_level as LogLevel),
        prompt_history_limit: positiveInt.nullable().default(DEFAULT_CONFIG_TEMPLATE.runtime.prompt_history_limit),
        default_verbose: z.boolean().default(DEFAULT_CONFIG_TEMPLATE.runtime.default_verbose),
        tool_loop_max_steps: z.number().int().positive().nullable().default(DEFAULT_CONFIG_TEMPLATE.runtime.tool_loop_max_steps),
        tool_workflow_timeout_ms: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.runtime.tool_workflow_timeout_ms),
        tool_command_timeout_ms: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.runtime.tool_command_timeout_ms),
        tool_poll_interval_ms: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.runtime.tool_poll_interval_ms),
        tool_poll_max_attempts: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.runtime.tool_poll_max_attempts),
        tool_idle_output_threshold_ms: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.runtime.tool_idle_output_threshold_ms),
        tool_heartbeat_interval_ms: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.runtime.tool_heartbeat_interval_ms),
        tool_cleanup_grace_ms: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.runtime.tool_cleanup_grace_ms),
        tool_failure_breaker_threshold: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.runtime.tool_failure_breaker_threshold),
        session_cache_max_entries: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.runtime.session_cache_max_entries),
        app_log_flush_interval_ms: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.runtime.app_log_flush_interval_ms),
        message_queue_mode: z.enum(["batch", "multi_turn"]).default(DEFAULT_CONFIG_TEMPLATE.runtime.message_queue_mode as "batch" | "multi_turn")
      })
      .strict(),
    access: z
      .object({
        allowed_sender_ids: z.array(z.string())
      })
      .strict(),
    tools: z
      .object({
        default_cwd: z.string().nullable().default(DEFAULT_CONFIG_TEMPLATE.tools.default_cwd),
        default_shell: optionalNonEmptyString.default(DEFAULT_CONFIG_TEMPLATE.tools.default_shell),
        exec_timeout_ms: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.tools.exec_timeout_ms),
        exec_yield_ms: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.tools.exec_yield_ms),
        process_log_tail_lines: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.tools.process_log_tail_lines),
        log_path: optionalNonEmptyString.default(DEFAULT_CONFIG_TEMPLATE.tools.log_path),
        completed_session_retention_ms: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.tools.completed_session_retention_ms),
        max_completed_sessions: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.tools.max_completed_sessions),
        max_output_chars: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.tools.max_output_chars),
        web_search: z
          .object({
            model: optionalNonEmptyString.default(DEFAULT_CONFIG_TEMPLATE.tools.web_search.model),
            available_models: z.array(webSearchModelSchema).min(1).default(DEFAULT_WEB_SEARCH_MODELS)
          })
          .strict()
          .default({})
      })
      .strict(),
    paths: z
      .object({
        workspace_root: optionalNonEmptyString.default(DEFAULT_CONFIG_TEMPLATE.paths.workspace_root),
        conversations_dir: optionalNonEmptyString.default(DEFAULT_CONFIG_TEMPLATE.paths.conversations_dir),
        stashed_conversations_path: optionalNonEmptyString.default(DEFAULT_CONFIG_TEMPLATE.paths.stashed_conversations_path),
        active_conversations_path: optionalNonEmptyString.default(DEFAULT_CONFIG_TEMPLATE.paths.active_conversations_path),
        context_snapshots_dir: optionalNonEmptyString.default(DEFAULT_CONFIG_TEMPLATE.paths.context_snapshots_dir),
        app_log_path: optionalNonEmptyString.default(DEFAULT_CONFIG_TEMPLATE.paths.app_log_path)
      })
      .strict(),
    observability: z
      .object({
        enabled: z.boolean().default(DEFAULT_CONFIG_TEMPLATE.observability.enabled),
        log_path: optionalNonEmptyString.default(DEFAULT_CONFIG_TEMPLATE.observability.log_path),
        redaction: z
          .object({
            enabled: z.boolean().default(DEFAULT_CONFIG_TEMPLATE.observability.redaction.enabled),
            max_string_chars: positiveInt.default(DEFAULT_CONFIG_TEMPLATE.observability.redaction.max_string_chars),
            redact_keys: z
              .array(optionalNonEmptyString)
              .default([...DEFAULT_CONFIG_TEMPLATE.observability.redaction.redact_keys])
          })
          .strict()
          .default({})
      })
      .strict()
  })
  .strict();

function ensureConfigTemplate(configPath: string): void {
  const template = `${JSON.stringify(DEFAULT_CONFIG_TEMPLATE, null, 2)}\n`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, template, "utf8");
}

export function expandHome(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

export function resolveConfigPath(repoRoot: string, candidate: string): string {
  const expanded = expandHome(candidate);
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  return path.resolve(repoRoot, expanded);
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const issuePath = issue.path.length > 0 ? `config.${issue.path.join(".")}` : "config";
      return `${issuePath}: ${issue.message}`;
    })
    .join("; ");
}

export function readRawConfig(configPath: string): unknown {
  if (!fs.existsSync(configPath)) {
    ensureConfigTemplate(configPath);
    throw new Error(
      `Missing required config file: ${configPath}. A template has been created; update required fields and restart.`
    );
  }

  return readJsonFile(configPath);
}

export function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`);
  }
}

function normalizeSecretCandidate(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "replace_me") {
    return null;
  }
  return trimmed;
}

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

function readDotEnvDefaults(repoRoot: string): Record<string, string> {
  const envPath = path.resolve(repoRoot, ".env");
  if (!fs.existsSync(envPath)) {
    return {};
  }
  return parseDotEnv(fs.readFileSync(envPath, "utf8"));
}

function resolveDefaultSecret(dotEnvValues: Record<string, string>, key: string): string | null {
  const fromProcess = normalizeSecretCandidate(process.env[key]);
  if (fromProcess !== null) {
    return fromProcess;
  }
  return normalizeSecretCandidate(dotEnvValues[key]);
}

function normalizeAllowedSenderIds(value: string[]): Set<string> {
  const ids = value
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== "replace_me");
  if (ids.length === 0) {
    throw new Error("config.access.allowed_sender_ids must contain at least one sender ID");
  }
  return new Set(ids);
}

function normalizeOpenAIModels(
  models: Array<{
    id: string;
    aliases: string[];
    context_window: number | null;
    max_output_tokens: number | null;
    default_thinking: ThinkingEffort;
    compaction_tokens: number | null;
    compaction_threshold: number;
  }>,
  defaultModelId: string
): Config["openai"]["models"] {
  const normalized: Config["openai"]["models"] = [];
  const seenModelIds = new Map<string, string>();
  const lookupOwner = new Map<string, string>();

  for (const item of models) {
    const id = item.id.trim();
    const idKey = id.toLowerCase();
    const priorId = seenModelIds.get(idKey);
    if (priorId) {
      throw new Error(`config.openai.models has duplicate model id: ${id} (already defined as ${priorId})`);
    }
    seenModelIds.set(idKey, id);

    const seenAliases = new Set<string>();
    const aliases: string[] = [];
    for (const rawAlias of item.aliases) {
      const alias = rawAlias.trim();
      const aliasKey = alias.toLowerCase();
      if (aliasKey === idKey || seenAliases.has(aliasKey)) {
        continue;
      }
      seenAliases.add(aliasKey);
      aliases.push(alias);
    }

    for (const lookupKey of [idKey, ...aliases.map((alias) => alias.toLowerCase())]) {
      const owner = lookupOwner.get(lookupKey);
      if (owner && owner !== id) {
        throw new Error(`config.openai.models has alias collision: '${lookupKey}' used by both ${owner} and ${id}`);
      }
      lookupOwner.set(lookupKey, id);
    }

    normalized.push({
      id,
      aliases,
      contextWindow: item.context_window,
      maxOutputTokens: item.max_output_tokens,
      defaultThinking: item.default_thinking,
      compactionTokens: item.compaction_tokens,
      compactionThreshold: item.compaction_threshold
    });
  }

  if (!normalized.some((item) => item.id === defaultModelId)) {
    throw new Error(`config.openai.model '${defaultModelId}' is not present in config.openai.models`);
  }

  return normalized;
}

function normalizeWebSearchModels(
  models: Array<{ id: string; aliases: string[] }>,
  defaultModelId: string
): WebSearchModelCatalogEntry[] {
  const normalized: WebSearchModelCatalogEntry[] = [];
  const seenModelIds = new Map<string, string>();
  const lookupOwner = new Map<string, string>();

  for (const item of models) {
    const id = item.id.trim();
    const idKey = id.toLowerCase();
    const priorId = seenModelIds.get(idKey);
    if (priorId) {
      throw new Error(`config.tools.web_search.available_models has duplicate model id: ${id} (already defined as ${priorId})`);
    }
    seenModelIds.set(idKey, id);

    const seenAliases = new Set<string>();
    const aliases: string[] = [];
    for (const rawAlias of item.aliases) {
      const alias = rawAlias.trim();
      const aliasKey = alias.toLowerCase();
      if (aliasKey === idKey || seenAliases.has(aliasKey)) {
        continue;
      }
      seenAliases.add(aliasKey);
      aliases.push(alias);
    }

    for (const lookupKey of [idKey, ...aliases.map((alias) => alias.toLowerCase())]) {
      const owner = lookupOwner.get(lookupKey);
      if (owner && owner !== id) {
        throw new Error(`config.tools.web_search.available_models has alias collision: '${lookupKey}' used by both ${owner} and ${id}`);
      }
      lookupOwner.set(lookupKey, id);
    }

    normalized.push({ id, aliases });
  }

  if (!normalized.some((item) => item.id === defaultModelId)) {
    throw new Error(`config.tools.web_search.model '${defaultModelId}' is not present in config.tools.web_search.available_models`);
  }

  return normalized;
}

function requireSecret(value: string | null, pathLabel: string): string {
  const trimmed = normalizeSecretCandidate(value);
  if (trimmed === null) {
    throw new Error(`${pathLabel} must be a non-empty string`);
  }
  return trimmed;
}

function defaultSecretKey(agentId: string, suffix: string): string {
  return `${agentId.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

export type ParsedConfig = z.infer<typeof configSchema>;

export function buildConfigFromParsed(
  config: ParsedConfig,
  configPath: string,
  repoRoot: string,
  agentId = "default",
  secrets: EnvSecrets
): Config {
  const telegramKey = defaultSecretKey(agentId, "TELEGRAM_BOT_TOKEN");
  const openaiKey = defaultSecretKey(agentId, "OPENAI_API_KEY");
  const telegramBotToken = requireSecret(secrets.telegramBotToken, telegramKey);
  const openAIApiKey = requireSecret(secrets.openaiApiKey, openaiKey);
  const defaultPerplexityApiKey = normalizeSecretCandidate(secrets.webSearchApiKey);

  if (config.openai.retry_max_ms < config.openai.retry_base_ms) {
    throw new Error("config.openai.retry_max_ms must be greater than or equal to config.openai.retry_base_ms");
  }
  const openAIModels = normalizeOpenAIModels(config.openai.models, config.openai.model);
  const webSearchModels = normalizeWebSearchModels(config.tools.web_search.available_models, config.tools.web_search.model);

  const workspaceRoot = resolveConfigPath(repoRoot, config.paths.workspace_root);
  const defaultCwdInput = config.tools.default_cwd ?? config.paths.workspace_root;

  return {
    agentId,
    configPath,
    telegram: {
      botToken: telegramBotToken,
      streamingEnabled: config.telegram.streaming_enabled,
      streamingMinUpdateMs: config.telegram.streaming_min_update_ms,
      assistantFormat: config.telegram.assistant_format
    },
    openai: {
      apiKey: openAIApiKey,
      model: config.openai.model,
      models: openAIModels,
      timeoutMs: config.openai.timeout_ms,
      maxRetries: config.openai.max_retries,
      retryBaseMs: config.openai.retry_base_ms,
      retryMaxMs: config.openai.retry_max_ms
    },
    runtime: {
      logLevel: config.runtime.log_level,
      promptHistoryLimit: config.runtime.prompt_history_limit,
      defaultVerbose: config.runtime.default_verbose,
      toolLoopMaxSteps: config.runtime.tool_loop_max_steps,
      toolWorkflowTimeoutMs: config.runtime.tool_workflow_timeout_ms,
      toolCommandTimeoutMs: config.runtime.tool_command_timeout_ms,
      toolPollIntervalMs: config.runtime.tool_poll_interval_ms,
      toolPollMaxAttempts: config.runtime.tool_poll_max_attempts,
      toolIdleOutputThresholdMs: config.runtime.tool_idle_output_threshold_ms,
      toolHeartbeatIntervalMs: config.runtime.tool_heartbeat_interval_ms,
      toolCleanupGraceMs: config.runtime.tool_cleanup_grace_ms,
      toolFailureBreakerThreshold: config.runtime.tool_failure_breaker_threshold,
      sessionCacheMaxEntries: config.runtime.session_cache_max_entries,
      appLogFlushIntervalMs: config.runtime.app_log_flush_interval_ms,
      messageQueueMode: config.runtime.message_queue_mode
    },
    access: {
      allowedSenderIds: normalizeAllowedSenderIds(config.access.allowed_sender_ids)
    },
    tools: {
      defaultCwd: resolveConfigPath(repoRoot, defaultCwdInput),
      defaultShell: config.tools.default_shell,
      execTimeoutMs: config.tools.exec_timeout_ms,
      execYieldMs: config.tools.exec_yield_ms,
      processLogTailLines: config.tools.process_log_tail_lines,
      logPath: resolveConfigPath(repoRoot, config.tools.log_path),
      completedSessionRetentionMs: config.tools.completed_session_retention_ms,
      maxCompletedSessions: config.tools.max_completed_sessions,
      maxOutputChars: config.tools.max_output_chars,
      webSearch: {
        apiKey: defaultPerplexityApiKey,
        model: config.tools.web_search.model,
        models: webSearchModels
      }
    },
    paths: {
      workspaceRoot,
      conversationsDir: resolveConfigPath(repoRoot, config.paths.conversations_dir),
      stashedConversationsPath: resolveConfigPath(repoRoot, config.paths.stashed_conversations_path),
      activeConversationsPath: resolveConfigPath(repoRoot, config.paths.active_conversations_path),
      contextSnapshotsDir: resolveConfigPath(repoRoot, config.paths.context_snapshots_dir),
      appLogPath: resolveConfigPath(repoRoot, config.paths.app_log_path)
    },
    observability: {
      enabled: config.observability.enabled,
      logPath: resolveConfigPath(repoRoot, config.observability.log_path),
      redaction: {
        enabled: config.observability.redaction.enabled,
        maxStringChars: config.observability.redaction.max_string_chars,
        redactKeys: [...config.observability.redaction.redact_keys]
      }
    }
  };
}

export function loadConfig(repoRoot = process.cwd()): Config {
  const configPath = path.resolve(repoRoot, "config.json");
  const raw = readRawConfig(configPath);
  const dotEnvDefaults = readDotEnvDefaults(repoRoot);

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config in ${configPath}: ${formatZodError(parsed.error)}`);
  }

  const secrets: EnvSecrets = {
    telegramBotToken: resolveDefaultSecret(dotEnvDefaults, DEFAULT_TELEGRAM_BOT_TOKEN_KEY),
    openaiApiKey: resolveDefaultSecret(dotEnvDefaults, DEFAULT_OPENAI_API_KEY_KEY),
    webSearchApiKey: resolveDefaultSecret(dotEnvDefaults, DEFAULT_PERPLEXITY_API_KEY_KEY)
  };

  return buildConfigFromParsed(parsed.data, configPath, repoRoot, "default", secrets);
}

export function buildConfigTemplate(): string {
  return `${JSON.stringify(DEFAULT_CONFIG_TEMPLATE, null, 2)}\n`;
}
