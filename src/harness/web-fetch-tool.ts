import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDef } from "./types.js";
import { webFetchInputSchema, type WebFetchInput } from "./schemas.js";

const execFileAsync = promisify(execFile);
const DEFUDDLE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export type DefuddleRunner = (url: string, timeoutMs: number) => Promise<{ markdown: string }>;

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatDefuddleError(error: unknown): string {
  const nodeError = error as NodeJS.ErrnoException & { stderr?: string };
  if (nodeError?.code === "ENOENT") {
    return "defuddle command not found";
  }

  const message = error instanceof Error ? error.message : String(error);
  const stderr = readNonEmptyString(nodeError?.stderr);
  return stderr ? `${message} (${stderr})` : message;
}

async function defaultDefuddleRunner(url: string, timeoutMs: number): Promise<{ markdown: string }> {
  try {
    const { stdout } = await execFileAsync("defuddle", ["parse", url, "--md"], {
      timeout: timeoutMs,
      maxBuffer: DEFUDDLE_MAX_BUFFER_BYTES
    });
    const markdown = stdout.trim();
    if (markdown.length === 0) {
      throw new Error("defuddle returned empty content");
    }
    return { markdown };
  } catch (error) {
    throw new Error(formatDefuddleError(error));
  }
}

export function createWebFetchTool(
  deps: { runDefuddle?: DefuddleRunner } = {}
): ToolDef<typeof webFetchInputSchema> {
  const runDefuddle = deps.runDefuddle ?? defaultDefuddleRunner;

  return {
    name: "web_fetch",
    description: "Fetch content from a specific URL using defuddle markdown extraction.",
    schema: webFetchInputSchema,
    async run(ctx, input: WebFetchInput) {
      try {
        const result = await runDefuddle(input.url, ctx.config.execTimeoutMs);
        return {
          url: input.url,
          mode: "defuddle",
          content: result.markdown
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Defuddle fetch failed: ${message}`);
      }
    }
  };
}
