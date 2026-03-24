import type { SkillDefinition, TelegramCommandDefinition } from "../types.js";

export type CoreCommandName =
  | "start"
  | "new"
  | "stash"
  | "status"
  | "cwd"
  | "stop"
  | "bash"
  | "verbose"
  | "thinking"
  | "cache"
  | "model"
  | "models"
  | "search"
  | "steer"
  | "transport";

export const CORE_COMMANDS: ReadonlyArray<TelegramCommandDefinition> = [
  {
    command: "start",
    description: "Show runtime status and help",
    kind: "core"
  },
  {
    command: "new",
    description: "Start fresh conversation (/new from to restore stashed)",
    kind: "core"
  },
  {
    command: "stash",
    description: "Stash current conversation: /stash <name> (or /stash list)",
    kind: "core"
  },
  {
    command: "status",
    description: "Show runtime summary (/status full for diagnostics)",
    kind: "core"
  },
  {
    command: "cwd",
    description: "Set cwd for this conversation: /cwd <absolute-path>",
    kind: "core"
  },
  {
    command: "stop",
    description: "Stop running tool sessions for this chat",
    kind: "core"
  },
  {
    command: "bash",
    description: "Run a shell command: /bash <command>",
    kind: "core"
  },
  {
    command: "verbose",
    description: "Tool-call updates: /verbose full|count|off",
    kind: "core"
  },
  {
    command: "thinking",
    description: "Set reasoning effort: /thinking <none|minimal|low|medium|high|xhigh>",
    kind: "core"
  },
  {
    command: "cache",
    description: "Set prompt cache retention: /cache <in_memory|24h>",
    kind: "core"
  },
  {
    command: "model",
    description: "Switch active model: /model <id-or-alias>",
    kind: "core"
  },
  {
    command: "models",
    description: "List available model ids and aliases",
    kind: "core"
  },
  {
    command: "search",
    description: "Switch web search model: /search <id-or-alias>",
    kind: "core"
  },
  {
    command: "steer",
    description: "Inject guidance into an active turn: /steer <message>",
    kind: "core"
  },
  {
    command: "transport",
    description: "Set API transport: /transport <http|wss>",
    kind: "core"
  },
  {
    command: "auth",
    description: "Set auth mode: /auth <api|codex>",
    kind: "core"
  }
] as const;

export const CORE_COMMAND_SET: ReadonlySet<string> = new Set(CORE_COMMANDS.map((item) => item.command));

const TELEGRAM_COMMAND_REGEX = /^[a-z][a-z0-9_]{0,31}$/;
const PARSE_COMMAND_REGEX = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/;

export type ParsedCommand = {
  command: string;
  args: string;
};

function normalizeDescription(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 256) {
    return trimmed;
  }
  return `${trimmed.slice(0, 253)}...`;
}

export function toTelegramCommand(name: string): string {
  return name.toLowerCase().replace(/[\s-]+/g, "_");
}

export function assertValidCommandName(name: string, sourcePath: string): void {
  const command = toTelegramCommand(name);
  if (!TELEGRAM_COMMAND_REGEX.test(command)) {
    throw new Error(`Invalid skill command name '${name}' from ${sourcePath}. Must match /^[a-z][a-z0-9_-]{0,31}$/`);
  }
}

export function buildCommandCatalog(skills: SkillDefinition[]): TelegramCommandDefinition[] {
  const commands: TelegramCommandDefinition[] = [...CORE_COMMANDS];
  const seen = new Set<string>(CORE_COMMAND_SET);

  for (const skill of skills) {
    const command = toTelegramCommand(skill.name);
    if (seen.has(command)) {
      throw new Error(`Skill command collision: '/${skill.name}'`);
    }

    seen.add(command);
    commands.push({
      command,
      description: normalizeDescription(skill.description),
      kind: "skill",
      skillName: skill.name
    });
  }

  return commands;
}

export function parseTelegramCommand(text: string): ParsedCommand | null {
  const match = text.match(PARSE_COMMAND_REGEX);
  if (!match) {
    return null;
  }

  const command = match[1]?.toLowerCase();
  if (!command) {
    return null;
  }

  const args = (match[3] ?? "").trim();
  return {
    command,
    args
  };
}
