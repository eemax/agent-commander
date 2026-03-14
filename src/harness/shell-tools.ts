import * as fs from "node:fs/promises";
import type { ToolDef } from "./types.js";
import { bashInputSchema, processInputSchema, type BashInput, type ProcessInput } from "./schemas.js";
import { resolveToolPath } from "./path-utils.js";

async function ensureValidCwd(cwd: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(cwd);
  } catch {
    throw new Error(`Invalid cwd: ${cwd}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`Invalid cwd: ${cwd}`);
  }
}

function resolveShell(inputShell: string | undefined, fallbackShell: string): string {
  return inputShell ?? fallbackShell;
}

function requireOwnerId(ownerId: string | null): string {
  if (!ownerId) {
    throw new Error("Missing owner context for shell tool execution");
  }
  return ownerId;
}

export const bashTool: ToolDef<typeof bashInputSchema> = {
  name: "bash",
  description:
    "Run a bash shell command in the local environment. Returns completed output or a running session for long-running commands.",
  schema: bashInputSchema,
  async run(ctx, input: BashInput) {
    const ownerId = requireOwnerId(ctx.ownerId);
    const cwd = resolveToolPath(ctx.config.defaultCwd, input.cwd ?? ctx.config.defaultCwd);
    await ensureValidCwd(cwd);

    const shell = resolveShell(input.shell, ctx.config.defaultShell);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...input.env
    };

    const timeoutMs = input.timeoutMs ?? ctx.config.execTimeoutMs;
    const yieldMs = input.yieldMs ?? ctx.config.execYieldMs;
    const background = input.background ?? false;

    const session = await ctx.processManager.startCommand({
      ownerId,
      command: input.command,
      cwd,
      shell,
      env,
      timeoutMs
    });

    if (background) {
      return {
        status: "running",
        sessionId: session.sessionId,
        pid: session.pid,
        tail: "",
        truncatedCombinedChars: 0
      };
    }

    const finished = await ctx.processManager.waitForCompletion(session.sessionId, yieldMs);
    if (finished) {
      return ctx.processManager.getExecCompletedOutput(session.sessionId, ownerId);
    }

    const running = ctx.processManager.getRunningTail(session.sessionId, ownerId);
    return {
      status: "running",
      sessionId: running.sessionId,
      pid: running.pid,
      tail: running.tail,
      truncatedCombinedChars: running.truncatedCombinedChars
    };
  }
};

export const processTool: ToolDef<typeof processInputSchema> = {
  name: "process",
  description:
    "Manage long-running bash sessions. Actions: list(); poll(sessionId); log(sessionId, tailLines?); write(sessionId, input); kill(sessionId, signal?); clear(sessionId); remove(sessionId).",
  schema: processInputSchema,
  async run(ctx, input: ProcessInput) {
    const ownerId = requireOwnerId(ctx.ownerId);

    switch (input.action) {
      case "list":
        return {
          sessions: ctx.processManager.listSessionsByOwner(ownerId)
        };
      case "poll":
        return ctx.processManager.pollSession(input.sessionId, ownerId);
      case "log":
        return ctx.processManager.logSession(
          input.sessionId,
          input.tailLines ?? ctx.config.processLogTailLines,
          ownerId
        );
      case "write":
        return ctx.processManager.writeToSession(input.sessionId, input.input, ownerId);
      case "kill":
        return ctx.processManager.killSession(
          input.sessionId,
          (input.signal as NodeJS.Signals | undefined) ?? "SIGTERM",
          ownerId
        );
      case "clear":
        return ctx.processManager.clearPending(input.sessionId, ownerId);
      case "remove":
        return ctx.processManager.removeSession(input.sessionId, ownerId);
      default:
        throw new Error(`Unsupported process action: ${(input as { action: string }).action}`);
    }
  }
};
