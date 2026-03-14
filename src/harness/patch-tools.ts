import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ToolDef } from "./types.js";
import { applyPatchInputSchema, type ApplyPatchInput } from "./schemas.js";
import { resolveToolPath } from "./path-utils.js";

type CodexPatchLine = {
  kind: "context" | "add" | "remove";
  text: string;
};

type CodexPatchHunk = {
  lines: CodexPatchLine[];
};

type CodexPatchOperation =
  | {
      kind: "add";
      filePath: string;
      lines: string[];
    }
  | {
      kind: "delete";
      filePath: string;
    }
  | {
      kind: "update";
      filePath: string;
      moveTo: string | null;
      hunks: CodexPatchHunk[];
    };

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function isCodexPatchHeader(line: string): boolean {
  return (
    line.startsWith("*** Add File: ") ||
    line.startsWith("*** Delete File: ") ||
    line.startsWith("*** Update File: ")
  );
}

function findSequence(haystack: string[], needle: string[], startIndex: number): number {
  if (needle.length === 0) {
    return startIndex;
  }

  for (let index = startIndex; index <= haystack.length - needle.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return index;
    }
  }

  return -1;
}

function splitContent(content: string): { lines: string[]; trailingNewline: boolean } {
  const normalized = normalizeNewlines(content);
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");

  if (trailingNewline) {
    lines.pop();
  }

  return { lines, trailingNewline };
}

function joinContent(lines: string[], trailingNewline: boolean): string {
  const joined = lines.join("\n");
  return trailingNewline ? `${joined}\n` : joined;
}

function parseCodexUpdateLines(rawLines: string[]): { moveTo: string | null; hunks: CodexPatchHunk[] } {
  let moveTo: string | null = null;
  const hunks: CodexPatchHunk[] = [];
  let currentHunk: CodexPatchLine[] = [];

  const flushCurrentHunk = (): void => {
    if (currentHunk.length === 0) {
      return;
    }
    hunks.push({ lines: currentHunk });
    currentHunk = [];
  };

  for (const line of rawLines) {
    if (line.startsWith("*** Move to: ")) {
      moveTo = line.slice("*** Move to: ".length).trim();
      continue;
    }

    if (line === "*** End of File") {
      continue;
    }

    if (line.startsWith("@@")) {
      flushCurrentHunk();
      continue;
    }

    if (line.length > 0 && (line[0] === " " || line[0] === "+" || line[0] === "-")) {
      currentHunk.push({
        kind: line[0] === " " ? "context" : line[0] === "+" ? "add" : "remove",
        text: line.slice(1)
      });
      continue;
    }

    if (line.trim().length === 0) {
      continue;
    }

    throw new Error(`Invalid Codex patch line: ${line}`);
  }

  flushCurrentHunk();
  return { moveTo, hunks };
}

function parseCodexPatch(patch: string): CodexPatchOperation[] | null {
  const lines = normalizeNewlines(patch).split("\n");
  if (lines[0]?.trim() !== "*** Begin Patch") {
    return null;
  }

  const operations: CodexPatchOperation[] = [];
  let index = 1;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (line === "*** End Patch") {
      return operations;
    }

    if (line.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length).trim();
      index += 1;

      const contentLines: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (current === "*** End Patch" || isCodexPatchHeader(current)) {
          break;
        }
        if (current.trim().length === 0) {
          index += 1;
          continue;
        }
        if (!current.startsWith("+")) {
          throw new Error(`Invalid add-file line in Codex patch: ${current}`);
        }
        contentLines.push(current.slice(1));
        index += 1;
      }

      operations.push({
        kind: "add",
        filePath,
        lines: contentLines
      });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const filePath = line.slice("*** Delete File: ".length).trim();
      operations.push({
        kind: "delete",
        filePath
      });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const filePath = line.slice("*** Update File: ".length).trim();
      index += 1;

      const updateLines: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (current === "*** End Patch" || isCodexPatchHeader(current)) {
          break;
        }
        updateLines.push(current);
        index += 1;
      }

      const parsedUpdate = parseCodexUpdateLines(updateLines);
      operations.push({
        kind: "update",
        filePath,
        moveTo: parsedUpdate.moveTo,
        hunks: parsedUpdate.hunks
      });
      continue;
    }

    throw new Error(`Invalid Codex patch header: ${line}`);
  }

  throw new Error("Invalid Codex patch: missing *** End Patch marker");
}

function applyCodexHunks(existingLines: string[], hunks: CodexPatchHunk[]): string[] {
  let cursor = 0;
  const output: string[] = [];

  for (const hunk of hunks) {
    const oldChunk: string[] = [];
    const newChunk: string[] = [];

    for (const line of hunk.lines) {
      if (line.kind === "context") {
        oldChunk.push(line.text);
        newChunk.push(line.text);
        continue;
      }

      if (line.kind === "remove") {
        oldChunk.push(line.text);
        continue;
      }

      newChunk.push(line.text);
    }

    const matchIndex =
      oldChunk.length === 0 ? cursor : findSequence(existingLines, oldChunk, cursor);

    if (matchIndex < 0) {
      throw new Error("Codex patch hunk did not match file content");
    }

    output.push(...existingLines.slice(cursor, matchIndex));
    output.push(...newChunk);
    cursor = matchIndex + oldChunk.length;
  }

  output.push(...existingLines.slice(cursor));
  return output;
}

async function applyCodexPatch(cwd: string, operations: CodexPatchOperation[]): Promise<void> {
  for (const operation of operations) {
    if (operation.kind === "add") {
      const targetPath = resolveToolPath(cwd, operation.filePath);
      const existing = await fs
        .stat(targetPath)
        .then(() => true)
        .catch(() => false);
      if (existing) {
        throw new Error(`Add file failed: ${operation.filePath} already exists`);
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const content = operation.lines.length > 0 ? `${operation.lines.join("\n")}\n` : "";
      await fs.writeFile(targetPath, content, "utf8");
      continue;
    }

    if (operation.kind === "delete") {
      const targetPath = resolveToolPath(cwd, operation.filePath);
      try {
        await fs.rm(targetPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Delete file failed for ${operation.filePath}: ${message}`);
      }
      continue;
    }

    const sourcePath = resolveToolPath(cwd, operation.filePath);
    const destinationPath = operation.moveTo ? resolveToolPath(cwd, operation.moveTo) : sourcePath;

    const sourceContent = await fs.readFile(sourcePath, "utf8").catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Update file failed for ${operation.filePath}: ${message}`);
    });

    const parsed = splitContent(sourceContent);
    const updatedLines = applyCodexHunks(parsed.lines, operation.hunks);
    const updatedContent = joinContent(updatedLines, parsed.trailingNewline);

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, updatedContent, "utf8");

    if (destinationPath !== sourcePath) {
      await fs.rm(sourcePath).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Move file cleanup failed for ${operation.filePath}: ${message}`);
      });
    }
  }
}

async function runCommand(params: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      stdio: "pipe"
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      reject(new Error(`Unknown spawn error: ${error.message}`));
    });

    child.once("close", (code) => {
      resolve({
        exitCode: code,
        stdout,
        stderr
      });
    });
  });
}

async function isGitRepository(cwd: string): Promise<boolean> {
  const result = await runCommand({
    command: "git",
    args: ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
    cwd
  }).catch(() => null);

  if (!result) {
    return false;
  }

  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export const applyPatchTool: ToolDef<typeof applyPatchInputSchema> = {
  name: "apply_patch",
  description: "Apply patch text. Supports unified diffs and Codex-style *** Begin Patch blocks.",
  schema: applyPatchInputSchema,
  async run(ctx, input: ApplyPatchInput) {
    const cwd = resolveToolPath(ctx.config.defaultCwd, input.cwd ?? ctx.config.defaultCwd);
    const codexOperations = parseCodexPatch(input.patch);
    if (codexOperations !== null) {
      await applyCodexPatch(cwd, codexOperations);
      return {
        ok: true,
        engine: "codex",
        stdout: "",
        stderr: "",
        operations: codexOperations.length
      };
    }

    let tempDir = "";
    let patchPath = "";

    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-commander-patch-"));
      patchPath = path.join(tempDir, "change.patch");
      await fs.writeFile(patchPath, input.patch, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Temp file creation failed: ${message}`);
    }

    try {
      const useGitApply = await isGitRepository(cwd);

      if (useGitApply) {
        const result = await runCommand({
          command: "git",
          args: ["apply", "--verbose", "--recount", "--whitespace=nowarn", patchPath],
          cwd
        });

        if (result.exitCode !== 0) {
          throw new Error(`git apply failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
        }

        return {
          ok: true,
          engine: "git-apply",
          stdout: result.stdout,
          stderr: result.stderr,
          operations: null
        };
      }

      const fallback = await runCommand({
        command: "patch",
        args: ["-p0", "-u", "-i", patchPath, "-d", cwd],
        cwd
      });

      if (fallback.exitCode !== 0) {
        throw new Error(`patch failed (exit ${fallback.exitCode}): ${fallback.stderr || fallback.stdout}`);
      }

      return {
        ok: true,
        engine: "patch",
        stdout: fallback.stdout,
        stderr: fallback.stderr,
        operations: null
      };
    } finally {
      if (tempDir.length > 0) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
  }
};
