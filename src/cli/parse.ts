import type { CliParseResult } from "./types.js";

function parseFlagSet(args: string[], allowed: string[]): { ok: true; flags: Set<string> } | { ok: false; error: string } {
  const supported = new Set(allowed);
  const flags = new Set<string>();

  for (const arg of args) {
    if (!arg.startsWith("--")) {
      return {
        ok: false,
        error: `Unexpected argument: ${arg}`
      };
    }
    if (!supported.has(arg)) {
      return {
        ok: false,
        error: `Unknown flag: ${arg}`
      };
    }
    flags.add(arg);
  }

  return { ok: true, flags };
}

export function parseCliCommand(argv: string[]): CliParseResult {
  if (argv.length === 0) {
    return {
      ok: true,
      command: { name: "help" }
    };
  }

  const [command, ...rest] = argv;

  switch (command) {
    case "help":
      if (rest.length > 0) {
        return { ok: false, error: `Unexpected argument: ${rest[0]}` };
      }
      return {
        ok: true,
        command: { name: "help" }
      };
    case "status":
      if (rest.length > 0) {
        return { ok: false, error: `Unexpected argument: ${rest[0]}` };
      }
      return {
        ok: true,
        command: { name: "status" }
      };
    case "start": {
      const parsed = parseFlagSet(rest, ["--rebuild"]);
      if (!parsed.ok) {
        return parsed;
      }
      return {
        ok: true,
        command: { name: "start", rebuild: parsed.flags.has("--rebuild") }
      };
    }
    case "stop":
      if (rest.length > 0) {
        return { ok: false, error: `Unexpected argument: ${rest[0]}` };
      }
      return {
        ok: true,
        command: { name: "stop" }
      };
    case "restart": {
      const parsed = parseFlagSet(rest, ["--rebuild"]);
      if (!parsed.ok) {
        return parsed;
      }
      return {
        ok: true,
        command: { name: "restart", rebuild: parsed.flags.has("--rebuild") }
      };
    }
    case "doctor":
      if (rest.length > 0) {
        return { ok: false, error: `Unexpected argument: ${rest[0]}` };
      }
      return {
        ok: true,
        command: { name: "doctor" }
      };
    case "__runtime": {
      if (rest.length === 0) {
        return {
          ok: true,
          command: { name: "__runtime", instanceId: null }
        };
      }

      if (rest.length === 2 && rest[0] === "--instance-id" && rest[1].trim().length > 0) {
        return {
          ok: true,
          command: { name: "__runtime", instanceId: rest[1] }
        };
      }

      return {
        ok: false,
        error: "Usage: __runtime [--instance-id <id>]"
      };
    }
    default:
      return {
        ok: false,
        error: `Unknown command: ${command}`
      };
  }
}
