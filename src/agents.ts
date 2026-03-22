import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { Config } from "./runtime/contracts.js";
import type { EnvSecrets } from "./env.js";
import {
  readJsonFile,
  configSchema,
  buildConfigFromParsed,
  formatZodError,
  type ParsedConfig
} from "./config.js";
import { isPlainObject } from "./utils.js";

export type AgentDefinition = {
  id: string;
  aliases: string[];
  configDir: string;
  telegramAllowlist: string[];
};

export type AgentsManifest = {
  agents: AgentDefinition[];
};

const agentSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*$/, "agent id must be lowercase alphanumeric (hyphens/underscores allowed), starting with a letter"),
    aliases: z.array(z.string().trim().min(1)).default([]),
    config_dir: z.string().trim().min(1),
    telegram_allowlist: z.array(z.string()).default([])
  })
  .strict();

const agentsJsonSchema = z
  .object({
    agents: z.array(agentSchema).default([])
  })
  .strict();

const DEFAULT_AGENT: AgentDefinition = { id: "default", aliases: [], configDir: ".", telegramAllowlist: [] };

function writeDefaultManifest(manifestPath: string): void {
  const payload = {
    agents: [{ id: "default", aliases: [], config_dir: ".", telegram_allowlist: [] }]
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function loadAgentsManifest(repoRoot: string): AgentsManifest {
  const manifestPath = path.resolve(repoRoot, "config", "agents.json");

  if (!fs.existsSync(manifestPath)) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeDefaultManifest(manifestPath);
    return { agents: [DEFAULT_AGENT] };
  }

  const raw = readJsonFile(manifestPath);
  const parsed = agentsJsonSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid agents.json: ${formatZodError(parsed.error)}`);
  }

  const agents: AgentDefinition[] = parsed.data.agents.map((a) => ({
    id: a.id,
    aliases: a.aliases,
    configDir: a.config_dir,
    telegramAllowlist: a.telegram_allowlist
  }));

  if (!agents.some((a) => a.id === "default")) {
    agents.unshift(DEFAULT_AGENT);
  }

  validateAgentManifest(agents, repoRoot);
  return { agents };
}

function validateAgentManifest(agents: AgentDefinition[], repoRoot: string): void {
  const seenIds = new Map<string, string>();
  const seenLookups = new Map<string, string>();

  for (const agent of agents) {
    const idKey = agent.id.toLowerCase();
    if (seenIds.has(idKey)) {
      throw new Error(`agents.json: duplicate agent id "${agent.id}"`);
    }
    seenIds.set(idKey, agent.id);

    const priorLookup = seenLookups.get(idKey);
    if (priorLookup && priorLookup !== agent.id) {
      throw new Error(`agents.json: "${idKey}" collides between agents "${priorLookup}" and "${agent.id}"`);
    }
    seenLookups.set(idKey, agent.id);

    for (const alias of agent.aliases) {
      const aliasKey = alias.toLowerCase();
      const owner = seenLookups.get(aliasKey);
      if (owner && owner !== agent.id) {
        throw new Error(`agents.json: alias "${alias}" on agent "${agent.id}" collides with agent "${owner}"`);
      }
      seenLookups.set(aliasKey, agent.id);
    }

    const configDirAbs = path.resolve(repoRoot, agent.configDir);
    if (!fs.existsSync(configDirAbs)) {
      throw new Error(`agents.json: config_dir "${agent.configDir}" for agent "${agent.id}" does not exist`);
    }
  }
}

const DEEP_MERGE_MAX_DEPTH = 20;

export function deepMerge(base: unknown, overlay: unknown, depth: number = 0): unknown {
  if (overlay === undefined) return base;
  if (overlay === null) return null;

  if (depth >= DEEP_MERGE_MAX_DEPTH) {
    throw new Error(`deepMerge exceeded max depth (${DEEP_MERGE_MAX_DEPTH})`);
  }

  if (isPlainObject(base) && isPlainObject(overlay)) {
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(overlay as Record<string, unknown>)) {
      result[key] = deepMerge(result[key], value, depth + 1);
    }
    return result;
  }

  return overlay;
}

const DEFAULT_PATH_SEGMENTS = {
  workspace_root: ".agent-commander",
  conversations_dir: ".agent-commander/conversations",
  stashed_conversations_path: ".agent-commander/stashed-conversations.json",
  active_conversations_path: ".agent-commander/active-conversations.json",
  context_snapshots_dir: ".agent-commander/context-snapshots",
  app_log_path: ".agent-commander/app.log"
} as const;

const DEFAULT_TOOL_LOG_SEGMENT = ".agent-commander/tool-calls.jsonl";
const DEFAULT_OBS_LOG_SEGMENT = ".agent-commander/observability.jsonl";

function namespaceDefaultPaths(merged: Record<string, unknown>, agentId: string, agentRaw: Record<string, unknown>): void {
  if (agentId === "default") return;

  const agentRawPaths = agentRaw.paths as Record<string, unknown> | undefined;
  const paths = merged.paths as Record<string, unknown> | undefined;
  if (paths) {
    for (const [key, defaultValue] of Object.entries(DEFAULT_PATH_SEGMENTS)) {
      if (agentRawPaths?.[key] !== undefined) continue;
      if (paths[key] === undefined || paths[key] === `~/${defaultValue}` || paths[key] === defaultValue) {
        const namespaced = defaultValue.replace(".agent-commander", `.agent-commander/agents/${agentId}`);
        paths[key] = key === "workspace_root" ? `~/${namespaced}` : namespaced;
      }
    }
  }

  const agentRawTools = agentRaw.tools as Record<string, unknown> | undefined;
  const tools = merged.tools as Record<string, unknown> | undefined;
  if (tools) {
    if (agentRawTools?.log_path === undefined) {
      if (tools.log_path === undefined || tools.log_path === DEFAULT_TOOL_LOG_SEGMENT) {
        tools.log_path = DEFAULT_TOOL_LOG_SEGMENT.replace(".agent-commander", `.agent-commander/agents/${agentId}`);
      }
    }
  }

  const agentRawObs = agentRaw.observability as Record<string, unknown> | undefined;
  const obs = merged.observability as Record<string, unknown> | undefined;
  if (obs) {
    if (agentRawObs?.log_path === undefined) {
      if (obs.log_path === undefined || obs.log_path === DEFAULT_OBS_LOG_SEGMENT) {
        obs.log_path = DEFAULT_OBS_LOG_SEGMENT.replace(".agent-commander", `.agent-commander/agents/${agentId}`);
      }
    }
  }
}

export function loadAgentConfig(
  repoRoot: string,
  agent: AgentDefinition,
  envSecrets: EnvSecrets
): Config {
  const rootConfigPath = path.resolve(repoRoot, "config", "config.json");
  let rootRaw: unknown = {};
  if (fs.existsSync(rootConfigPath)) {
    rootRaw = readJsonFile(rootConfigPath);
  }

  let agentRaw: unknown = {};
  const agentConfigDir = path.resolve(repoRoot, agent.configDir);
  const agentConfigPath = path.resolve(agentConfigDir, "config.json");
  if (agent.configDir !== "." && fs.existsSync(agentConfigPath)) {
    agentRaw = readJsonFile(agentConfigPath);
  }

  const merged = deepMerge(rootRaw, agentRaw) as Record<string, unknown>;

  namespaceDefaultPaths(merged, agent.id, agentRaw as Record<string, unknown>);

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`Invalid config for agent "${agent.id}": ${formatZodError(parsed.error)}`);
  }

  const configPath = agent.configDir === "." ? rootConfigPath : agentConfigPath;
  return buildConfigFromParsed(parsed.data as ParsedConfig, configPath, repoRoot, agent.id, envSecrets, agent.telegramAllowlist);
}

export function validateUniqueBotTokens(
  agentConfigs: Array<{ agent: AgentDefinition; config: Config }>
): void {
  const seen = new Map<string, string>();
  for (const { agent, config } of agentConfigs) {
    const token = config.telegram.botToken;
    const existing = seen.get(token);
    if (existing) {
      throw new Error(
        `Agents "${existing}" and "${agent.id}" share the same Telegram bot token. Each agent must have a unique token.`
      );
    }
    seen.set(token, agent.id);
  }
}
