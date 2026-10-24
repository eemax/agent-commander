// Telegram's command menu: acmd's own commands, and the name a skill gets there.
export const BUILTIN_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "new", description: "Start a fresh conversation" },
  { command: "stop", description: "Stop the running turn" },
  { command: "status", description: "Model, cwd, usage" },
  { command: "model", description: "Show or switch model" },
  { command: "thinking", description: "Show or set reasoning effort" },
  { command: "cwd", description: "Show or set working directory" },
  { command: "jobs", description: "List background jobs, or /jobs stop <id>" },
  { command: "debug", description: "Toggle debug logging" }
];

// Commands a skill can't have: acmd's own, plus /start and /help (answered with the menu).
export const RESERVED_COMMANDS = new Set(["start", "help", ...BUILTIN_COMMANDS.map((c) => c.command)]);

// The Telegram command for a skill: /<name> with hyphens as underscores (at most 32 characters).
export function skillCommand(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
}
