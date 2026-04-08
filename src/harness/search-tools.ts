import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import * as readline from "node:readline";
import type { Readable } from "node:stream";
import type { ToolDef } from "./types.js";
import { resolveToolPath } from "./path-utils.js";
import {
  globInputSchema,
  grepInputSchema,
  type GlobInput,
  type GrepInput
} from "./schemas.js";

const GLOB_RESULT_LIMIT = 2_000;
const GREP_MATCH_LIMIT = 1_000;
const STDERR_CAPTURE_LIMIT = 32_000;
const MAX_MATCH_TEXT_CHARS = 4_000;
const EXCLUDE_GIT_GLOBS = ["!.git", "!.git/**"];
const GLOB_PARTIAL_WARNING = "Some directories could not be listed; results may be incomplete.";
const GREP_PARTIAL_WARNING = "Some files could not be searched; results may be incomplete.";

type RipgrepChild = ChildProcessByStdio<null, Readable, Readable>;
type RipgrepSpawner = (args: string[], cwd: string) => RipgrepChild;

type RipgrepExit = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
};

type RipgrepMessage = {
  type?: string;
  data?: unknown;
};

type RipgrepMatch = {
  path: string;
  line: number;
  text: string;
};

type ParsedGrepOutput = {
  matches: RipgrepMatch[];
  totalMatches: number;
  filesStarted: number;
  filesCompleted: number;
  filesScannedFromSummary: number | null;
  lastFileScanned: string | null;
};

type GrepToolResult = {
  path: string;
  matches: RipgrepMatch[];
  filesScanned: number;
  truncated: boolean;
  partial?: true;
  warning?: string;
  matchLimit?: number;
  outputLimit?: number;
  lastFileScanned?: string | null;
  note?: string;
};

function defaultRipgrepSpawner(args: string[], cwd: string): RipgrepChild {
  return spawn("rg", args, {
    cwd,
    env: {
      ...process.env,
      RIPGREP_CONFIG_PATH: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatRipgrepSpawnError(error: unknown): string {
  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError?.code === "ENOENT") {
    return "ripgrep (rg) is required but not found in PATH";
  }

  const message = error instanceof Error ? error.message : String(error);
  return `failed to spawn ripgrep: ${message}`;
}

function normalizeOutputPath(rawPath: string, cwd: string): string {
  if (!path.isAbsolute(rawPath)) {
    const normalized = path.normalize(rawPath);
    if (normalized === ".") {
      return ".";
    }
    if (normalized.startsWith(`.${path.sep}`)) {
      return normalized.slice(2);
    }
    return normalized;
  }

  const relative = path.relative(cwd, rawPath);
  if (relative.length === 0) {
    return ".";
  }

  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return rawPath;
  }

  return relative;
}

function decodeRipgrepValue(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.text === "string") {
    return value.text;
  }

  if (typeof value.bytes === "string") {
    try {
      return Buffer.from(value.bytes, "base64").toString("utf8");
    } catch {
      return null;
    }
  }

  return null;
}

function extractRipgrepPath(data: Record<string, unknown>, cwd: string): string | null {
  const rawPath = decodeRipgrepValue(data.path);
  if (rawPath === null || rawPath.length === 0) {
    return null;
  }
  return normalizeOutputPath(rawPath, cwd);
}

function extractRipgrepLineText(data: Record<string, unknown>): string | null {
  const rawLine = decodeRipgrepValue(data.lines);
  if (rawLine === null) {
    return null;
  }
  const line = rawLine.split(/\r?\n/, 1)[0] ?? "";
  if (line.length <= MAX_MATCH_TEXT_CHARS) {
    return line;
  }

  const omittedChars = line.length - MAX_MATCH_TEXT_CHARS;
  return `${line.slice(0, MAX_MATCH_TEXT_CHARS)}... [+${omittedChars} chars]`;
}

function appendCapturedText(buffer: string, chunk: string): string {
  const remaining = STDERR_CAPTURE_LIMIT - buffer.length;
  if (remaining <= 0) {
    return buffer;
  }

  if (chunk.length <= remaining) {
    return `${buffer}${chunk}`;
  }

  return `${buffer}${chunk.slice(0, remaining)}`;
}

function safeKill(child: RipgrepChild): void {
  if (child.killed) {
    return;
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // Ignore kill failures during cleanup.
  }
}

async function ensureSearchPath(
  defaultCwd: string,
  inputPath: string | undefined,
  options: {
    allowFiles: boolean;
  }
): Promise<{
  resolvedPath: string;
  rgPathArg: string;
}> {
  const rawPath = inputPath ?? ".";
  const resolvedPath = resolveToolPath(defaultCwd, rawPath);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolvedPath);
  } catch {
    throw new Error(`Search path does not exist: ${resolvedPath}`);
  }

  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`Search path is not a file or directory: ${resolvedPath}`);
  }
  if (!options.allowFiles && stat.isFile()) {
    throw new Error(`Search path must be a directory for glob: ${resolvedPath}`);
  }

  return {
    resolvedPath,
    rgPathArg: path.isAbsolute(rawPath) ? resolvedPath : rawPath
  };
}

async function runRipgrepLines(params: {
  cwd: string;
  args: string[];
  timeoutMs: number;
  abortSignal?: AbortSignal;
  spawnRipgrep: RipgrepSpawner;
  onLine: (line: string, child: RipgrepChild) => void;
}): Promise<RipgrepExit> {
  const {
    cwd,
    args,
    timeoutMs,
    abortSignal,
    spawnRipgrep,
    onLine
  } = params;

  if (abortSignal?.aborted) {
    throw new Error("Ripgrep command was interrupted");
  }

  let child: RipgrepChild;
  try {
    child = spawnRipgrep(args, cwd);
  } catch (error) {
    throw new Error(formatRipgrepSpawnError(error));
  }

  const stdout = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity
  });

  let stderr = "";
  let timedOut = false;
  let interrupted = false;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = appendCapturedText(stderr, chunk);
  });

  const onAbort = (): void => {
    interrupted = true;
    safeKill(child);
  };

  abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (abortSignal?.aborted) {
    onAbort();
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    safeKill(child);
  }, timeoutMs);

  try {
    return await new Promise<RipgrepExit>((resolve, reject) => {
      let settled = false;
      let stdoutClosed = false;
      let childClosed = false;
      let exitCode: number | null = null;
      let signal: NodeJS.Signals | null = null;

      const cleanup = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        abortSignal?.removeEventListener("abort", onAbort);
        stdout.close();
      };

      const maybeResolve = (): void => {
        if (!stdoutClosed || !childClosed || settled) {
          return;
        }
        cleanup();

        if (timedOut) {
          reject(new Error(`Ripgrep command timed out after ${timeoutMs}ms`));
          return;
        }

        if (interrupted) {
          reject(new Error("Ripgrep command was interrupted"));
          return;
        }

        resolve({
          exitCode,
          signal,
          stderr: stderr.trim()
        });
      };

      stdout.on("line", (line) => {
        if (settled) {
          return;
        }
        try {
          onLine(line, child);
        } catch (error) {
          cleanup();
          safeKill(child);
          reject(error);
        }
      });

      stdout.on("close", () => {
        stdoutClosed = true;
        maybeResolve();
      });

      stdout.on("error", (error) => {
        cleanup();
        safeKill(child);
        reject(new Error(`Failed to read ripgrep output: ${error.message}`));
      });

      child.on("error", (error) => {
        cleanup();
        reject(new Error(formatRipgrepSpawnError(error)));
      });

      child.on("close", (code, childSignal) => {
        exitCode = code;
        signal = childSignal;
        childClosed = true;
        maybeResolve();
      });
    });
  } finally {
    clearTimeout(timeout);
    abortSignal?.removeEventListener("abort", onAbort);
  }
}

function buildGlobArgs(input: GlobInput, rgPathArg: string): string[] {
  return [
    "--files",
    "--hidden",
    ...EXCLUDE_GIT_GLOBS.flatMap((glob) => ["-g", glob]),
    "-g",
    input.pattern,
    "--",
    rgPathArg
  ];
}

function buildGrepArgs(input: GrepInput, rgPathArg: string): string[] {
  const args = [
    "--json",
    "--no-messages",
    "--hidden",
    ...EXCLUDE_GIT_GLOBS.flatMap((glob) => ["-g", glob])
  ];

  if (input.literal === true) {
    args.push("-F");
  }
  if (input.caseSensitive === false) {
    args.push("-i");
  }

  args.push("-e", input.pattern, "--", rgPathArg);
  return args;
}

function parseGrepMessage(line: string, cwd: string, parsed: ParsedGrepOutput): void {
  if (line.trim().length === 0) {
    return;
  }

  let message: RipgrepMessage;
  try {
    message = JSON.parse(line) as RipgrepMessage;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ripgrep output: ${detail}`);
  }

  if (!isRecord(message.data) || typeof message.type !== "string") {
    throw new Error("Ripgrep output contained an invalid message");
  }

  const currentPath = extractRipgrepPath(message.data, cwd);
  if (currentPath !== null) {
    parsed.lastFileScanned = currentPath;
  }

  switch (message.type) {
    case "begin":
      parsed.filesStarted += 1;
      break;
    case "end":
      parsed.filesCompleted += 1;
      break;
    case "match": {
      parsed.totalMatches += 1;
      if (parsed.totalMatches > GREP_MATCH_LIMIT) {
        return;
      }

      const lineNumber = message.data.line_number;
      if (typeof lineNumber !== "number" || !Number.isFinite(lineNumber)) {
        throw new Error("Ripgrep output did not include a valid line number");
      }

      const text = extractRipgrepLineText(message.data);
      if (text === null) {
        throw new Error("Ripgrep output did not include match text");
      }

      parsed.matches.push({
        path: parsed.lastFileScanned ?? "",
        line: lineNumber,
        text
      });
      break;
    }
    case "summary": {
      const stats = isRecord(message.data.stats) ? message.data.stats : null;
      const searches = stats?.searches;
      if (typeof searches === "number" && Number.isFinite(searches)) {
        parsed.filesScannedFromSummary = searches;
      }
      break;
    }
    default:
      break;
  }
}

function buildGrepNote(params: {
  filesScanned: number;
  approximateFilesScanned: boolean;
  truncatedByMatchLimit: boolean;
  truncatedByOutputLimit: boolean;
  maxOutputChars: number;
}): string | undefined {
  const reasons: string[] = [];

  if (params.truncatedByMatchLimit) {
    const fileLabel = params.filesScanned === 1 ? "file" : "files";
    const verb = params.approximateFilesScanned ? "touching" : "scanning";
    reasons.push(`Result limit reached (${GREP_MATCH_LIMIT} matching lines after ${verb} ${params.filesScanned} ${fileLabel}).`);
  }
  if (params.truncatedByOutputLimit) {
    reasons.push(`Output limit reached (${params.maxOutputChars} chars).`);
  }

  if (reasons.length === 0) {
    return undefined;
  }

  reasons.push("Narrow with a more specific pattern or search a subdirectory via the path argument.");
  return reasons.join(" ");
}

function resolveFilesScanned(
  parsed: ParsedGrepOutput,
  truncatedByMatchLimit: boolean
): {
  count: number;
  approximate: boolean;
} {
  if (parsed.filesScannedFromSummary !== null) {
    return {
      count: parsed.filesScannedFromSummary,
      approximate: false
    };
  }

  if (truncatedByMatchLimit) {
    return {
      count: parsed.filesStarted,
      approximate: parsed.filesStarted !== parsed.filesCompleted
    };
  }

  return {
    count: parsed.filesCompleted,
    approximate: false
  };
}

function buildGrepToolResult(params: {
  resolvedPath: string;
  matches: RipgrepMatch[];
  filesScanned: number;
  approximateFilesScanned: boolean;
  lastFileScanned: string | null;
  partial: boolean;
  truncatedByMatchLimit: boolean;
  truncatedByOutputLimit: boolean;
  maxOutputChars: number;
}): GrepToolResult {
  const note = buildGrepNote({
    filesScanned: params.filesScanned,
    approximateFilesScanned: params.approximateFilesScanned,
    truncatedByMatchLimit: params.truncatedByMatchLimit,
    truncatedByOutputLimit: params.truncatedByOutputLimit,
    maxOutputChars: params.maxOutputChars
  });

  return {
    path: params.resolvedPath,
    matches: params.matches,
    filesScanned: params.filesScanned,
    truncated: params.truncatedByMatchLimit || params.truncatedByOutputLimit,
    ...(params.partial
      ? {
          partial: true,
          warning: GREP_PARTIAL_WARNING
        }
      : {}),
    ...(params.truncatedByMatchLimit
      ? {
          matchLimit: GREP_MATCH_LIMIT
        }
      : {}),
    ...((params.truncatedByMatchLimit || params.truncatedByOutputLimit) && params.lastFileScanned !== null
      ? {
          lastFileScanned: params.lastFileScanned
        }
      : {}),
    ...(params.truncatedByOutputLimit
      ? {
          outputLimit: params.maxOutputChars
        }
      : {}),
    ...(note
      ? {
          note
        }
      : {})
  };
}

function measureGrepEnvelopeChars(result: GrepToolResult): number {
  const data: Record<string, unknown> = {
    matches: result.matches,
    search_path: result.path
  };

  const meta: Record<string, unknown> = {
    files_scanned: result.filesScanned
  };
  if (result.truncated) {
    meta.truncated = true;
  }
  if (result.partial) {
    meta.partial = true;
  }
  if (result.matchLimit !== undefined) {
    meta.match_limit = result.matchLimit;
  }
  if (result.outputLimit !== undefined) {
    meta.output_limit = result.outputLimit;
  }
  if (result.lastFileScanned) {
    meta.last_file_scanned = result.lastFileScanned;
  }
  if (result.warning) {
    meta.warning = result.warning;
  }
  if (result.note) {
    meta.note = result.note;
  }

  const envelope = {
    ok: true,
    summary:
      result.matches.length === 0
        ? "Grep found no matches."
        : `Grep found ${result.matches.length} matching line(s).`,
    data,
    ...(Object.keys(meta).length > 0 ? { meta } : {})
  };

  return JSON.stringify(envelope).length;
}

export function createGlobTool(
  deps: {
    spawnRipgrep?: RipgrepSpawner;
  } = {}
): ToolDef<typeof globInputSchema> {
  const spawnRipgrep = deps.spawnRipgrep ?? defaultRipgrepSpawner;

  return {
    name: "glob",
    description:
      "Find files matching a glob pattern via ripgrep. Respects .gitignore, includes hidden files, and excludes .git.",
    schema: globInputSchema,
    async run(ctx, input: GlobInput) {
      const { resolvedPath, rgPathArg } = await ensureSearchPath(ctx.config.defaultCwd, input.path, {
        allowFiles: false
      });
      const args = buildGlobArgs(input, rgPathArg);

      const matches: string[] = [];
      let totalMatches = 0;

      const result = await runRipgrepLines({
        cwd: ctx.config.defaultCwd,
        args,
        timeoutMs: ctx.config.execTimeoutMs,
        abortSignal: ctx.abortSignal,
        spawnRipgrep,
        onLine(line, child) {
          if (line.length === 0) {
            return;
          }

          totalMatches += 1;
          if (totalMatches > GLOB_RESULT_LIMIT) {
            safeKill(child);
            return;
          }

          matches.push(normalizeOutputPath(line, ctx.config.defaultCwd));
        }
      });

      matches.sort();
      const partial = result.exitCode === 2 && matches.length > 0;
      const truncated = totalMatches > GLOB_RESULT_LIMIT;

      if (result.exitCode !== 0 && result.exitCode !== 1 && !truncated && !partial) {
        const detail = result.stderr.length > 0
          ? result.stderr
          : result.signal
            ? `ripgrep terminated with signal ${result.signal}`
            : `ripgrep exited with status ${String(result.exitCode)}`;
        throw new Error(`Ripgrep glob failed: ${detail}`);
      }

      return {
        path: resolvedPath,
        matches,
        truncated,
        ...(partial
          ? {
              partial: true,
              warning: GLOB_PARTIAL_WARNING
            }
          : {}),
        ...(truncated
          ? {
            resultLimit: GLOB_RESULT_LIMIT,
            note: `Result limit reached (${GLOB_RESULT_LIMIT} paths). Use a more specific pattern or search a subdirectory via the path argument.`
          }
          : {})
      };
    }
  };
}

export function createGrepTool(
  deps: {
    spawnRipgrep?: RipgrepSpawner;
  } = {}
): ToolDef<typeof grepInputSchema> {
  const spawnRipgrep = deps.spawnRipgrep ?? defaultRipgrepSpawner;

  return {
    name: "grep",
    description:
      "Search text files with ripgrep regex semantics. Respects .gitignore, includes hidden files, and excludes .git.",
    schema: grepInputSchema,
    async run(ctx, input: GrepInput) {
      const { resolvedPath, rgPathArg } = await ensureSearchPath(ctx.config.defaultCwd, input.path, {
        allowFiles: true
      });
      const args = buildGrepArgs(input, rgPathArg);

      const parsed: ParsedGrepOutput = {
        matches: [],
        totalMatches: 0,
        filesStarted: 0,
        filesCompleted: 0,
        filesScannedFromSummary: null,
        lastFileScanned: null
      };

      const result = await runRipgrepLines({
        cwd: ctx.config.defaultCwd,
        args,
        timeoutMs: ctx.config.execTimeoutMs,
        abortSignal: ctx.abortSignal,
        spawnRipgrep,
        onLine(line, child) {
          parseGrepMessage(line, ctx.config.defaultCwd, parsed);
          if (parsed.totalMatches > GREP_MATCH_LIMIT) {
            safeKill(child);
          }
        }
      });

      const truncatedByMatchLimit = parsed.totalMatches > GREP_MATCH_LIMIT;
      const filesScannedInfo = resolveFilesScanned(parsed, truncatedByMatchLimit);
      const partial =
        result.exitCode === 2 &&
        result.stderr.length === 0 &&
        filesScannedInfo.count > 0 &&
        !truncatedByMatchLimit;

      parsed.matches.sort((left, right) => {
        if (left.path !== right.path) {
          return left.path.localeCompare(right.path);
        }
        return left.line - right.line;
      });

      if (result.exitCode !== 0 && result.exitCode !== 1 && !partial && !truncatedByMatchLimit) {
        const detail = result.stderr.length > 0
          ? result.stderr
          : result.signal
            ? `ripgrep terminated with signal ${result.signal}`
            : `ripgrep exited with status ${String(result.exitCode)}`;
        throw new Error(`Ripgrep search failed: ${detail}`);
      }

      let matches = [...parsed.matches];
      let truncatedByOutputLimit = false;
      let grepResult = buildGrepToolResult({
        resolvedPath,
        matches,
        filesScanned: filesScannedInfo.count,
        approximateFilesScanned: filesScannedInfo.approximate,
        lastFileScanned: parsed.lastFileScanned,
        partial,
        truncatedByMatchLimit,
        truncatedByOutputLimit,
        maxOutputChars: ctx.config.maxOutputChars
      });

      if (measureGrepEnvelopeChars(grepResult) > ctx.config.maxOutputChars) {
        truncatedByOutputLimit = true;
        grepResult = buildGrepToolResult({
          resolvedPath,
          matches,
          filesScanned: filesScannedInfo.count,
          approximateFilesScanned: filesScannedInfo.approximate,
          lastFileScanned: parsed.lastFileScanned,
          partial,
          truncatedByMatchLimit,
          truncatedByOutputLimit,
          maxOutputChars: ctx.config.maxOutputChars
        });

        while (matches.length > 0 && measureGrepEnvelopeChars(grepResult) > ctx.config.maxOutputChars) {
          matches.pop();
          grepResult = buildGrepToolResult({
            resolvedPath,
            matches,
            filesScanned: filesScannedInfo.count,
            approximateFilesScanned: filesScannedInfo.approximate,
            lastFileScanned: parsed.lastFileScanned,
            partial,
            truncatedByMatchLimit,
            truncatedByOutputLimit,
            maxOutputChars: ctx.config.maxOutputChars
          });
        }
      }

      return grepResult;
    }
  };
}

export const globTool = createGlobTool();
export const grepTool = createGrepTool();
