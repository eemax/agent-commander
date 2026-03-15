import type { SkillDefinition, TelegramCommandDefinition } from "../types.js";

export type CoreCommandName =
  | "start"
  | "new"
  | "stash"
  | "status"
  | "stop"
  | "bash"
  | "verbose"
  | "thinking"
  | "model"
  | "models"
  | "search";

export const CORE_COMMANDS: ReadonlyArray<TelegramCommandDefinition> = [
  {
    command: "start",
    description: "Show runtime status and help",
    kind: "core"
  },
  {
    command: "new",
    description: "Switch conversation menu (archives current on selection)",
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
    description: "Toggle tool-call updates: /verbose on|off",
    kind: "core"
  },
  {
    command: "thinking",
    description: "Set reasoning effort: /thinking <none|minimal|low|medium|high|xhigh>",
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
  }
] as const;

export const CORE_COMMAND_SET: ReadonlySet<string> = new Set(CORE_COMMANDS.map((item) => item.command));

const TELEGRAM_COMMAND_REGEX = /^[a-z][a-z0-9_]{0,31}$/;

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

export function toSkillCommandSlug(rawFolderName: string): string {
  const normalized = rawFolderName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return normalized;
}

export function assertValidCommandSlug(slug: string, sourcePath: string): void {
  if (!TELEGRAM_COMMAND_REGEX.test(slug)) {
    throw new Error(`Invalid skill command slug '${slug}' from ${sourcePath}`);
  }
}

export function buildCommandCatalog(skills: SkillDefinition[]): TelegramCommandDefinition[] {
  const commands: TelegramCommandDefinition[] = [...CORE_COMMANDS];
  const seen = new Set<string>(CORE_COMMAND_SET);

  for (const skill of skills) {
    if (seen.has(skill.slug)) {
      throw new Error(`Skill command collision: '/${skill.slug}'`);
    }

    seen.add(skill.slug);
    commands.push({
      command: skill.slug,
      description: normalizeDescription(skill.description),
      kind: "skill",
      skillSlug: skill.slug
    });
  }

  return commands;
}

export function parseTelegramCommand(text: string): ParsedCommand | null {
  const match = text.match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/);
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
