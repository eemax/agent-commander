import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolDef } from "./types.js";
import { resolveToolPath } from "./path-utils.js";
import {
  readFileInputSchema,
  replaceInFileInputSchema,
  writeFileInputSchema,
  type ReadFileInput,
  type ReplaceInFileInput,
  type WriteFileInput
} from "./schemas.js";

function normalizeEncoding(raw: string | undefined): BufferEncoding {
  const encoding = (raw ?? "utf8").toLowerCase();
  if (encoding === "utf8" || encoding === "utf-8") {
    return "utf8";
  }

  throw new Error(`Invalid encoding: ${raw ?? ""}`);
}

function countChar(content: string, char: string): number {
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === char) count++;
  }
  return count;
}

const LINE_SPLIT_REGEX = /\r?\n/;

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  return content.split(LINE_SPLIT_REGEX);
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;

  while (true) {
    const matchIndex = content.indexOf(needle, index);
    if (matchIndex === -1) {
      break;
    }
    count += 1;
    index = matchIndex + needle.length;
  }

  return count;
}

export const readFileTool: ToolDef<typeof readFileInputSchema> = {
  name: "read_file",
  description: "Read a text file exactly, with optional line-based slicing.",
  schema: readFileInputSchema,
  async run(ctx, input: ReadFileInput) {
    const targetPath = resolveToolPath(ctx.config.defaultCwd, input.path);
    const encoding = normalizeEncoding(input.encoding);

    let content: string;
    try {
      content = await fs.readFile(targetPath, { encoding });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        throw new Error(`File not found: ${targetPath}`);
      }
      throw new Error(`Failed to read file ${targetPath}: ${nodeError.message}`);
    }

    if (input.offsetLine === undefined && input.limitLines === undefined) {
      const totalLines = content.length === 0 ? 0 : countChar(content, "\n") + 1;
      return {
        path: targetPath,
        content,
        startLine: totalLines === 0 ? 0 : 1,
        endLine: totalLines,
        totalLines,
        truncated: false
      };
    }

    const lines = splitLines(content);
    const totalLines = lines.length;

    const offsetLine = input.offsetLine ?? 1;
    const startIndex = Math.max(0, offsetLine - 1);
    const endExclusive =
      input.limitLines === undefined ? totalLines : Math.min(totalLines, startIndex + input.limitLines);
    const selected = lines.slice(startIndex, endExclusive);

    const startLine = selected.length > 0 ? startIndex + 1 : Math.min(offsetLine, totalLines + 1);
    const endLine = selected.length > 0 ? startLine + selected.length - 1 : Math.min(startIndex, totalLines);
    const truncated = startIndex > 0 || endExclusive < totalLines;

    return {
      path: targetPath,
      content: selected.join("\n"),
      startLine,
      endLine,
      totalLines,
      truncated
    };
  }
};

export const writeFileTool: ToolDef<typeof writeFileInputSchema> = {
  name: "write_file",
  description: "Create or overwrite a file with exact content.",
  schema: writeFileInputSchema,
  async run(ctx, input: WriteFileInput) {
    const targetPath = resolveToolPath(ctx.config.defaultCwd, input.path);
    const encoding = normalizeEncoding(input.encoding);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    try {
      await fs.writeFile(targetPath, input.content, { encoding });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write file ${targetPath}: ${message}`);
    }

    return {
      ok: true,
      path: targetPath,
      size: Buffer.byteLength(input.content, encoding)
    };
  }
};

export const replaceInFileTool: ToolDef<typeof replaceInFileInputSchema> = {
  name: "replace_in_file",
  description:
    "Replace exact text in a file. Fails if no match or if multiple matches exist without replaceAll=true.",
  schema: replaceInFileInputSchema,
  async run(ctx, input: ReplaceInFileInput) {
    const targetPath = resolveToolPath(ctx.config.defaultCwd, input.path);

    let content: string;
    try {
      content = await fs.readFile(targetPath, { encoding: "utf8" });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        throw new Error(`File not found: ${targetPath}`);
      }
      throw new Error(`Failed to read file ${targetPath}: ${nodeError.message}`);
    }

    const firstIndex = content.indexOf(input.oldText);
    if (firstIndex === -1) {
      throw new Error("oldText not found");
    }

    if (input.replaceAll !== true) {
      const secondIndex = content.indexOf(input.oldText, firstIndex + input.oldText.length);
      if (secondIndex !== -1) {
        const occurrences = countOccurrences(content, input.oldText);
        throw new Error(
          `oldText matched ${occurrences} times; use replaceAll=true or make the match more specific`
        );
      }
      const updated = content.slice(0, firstIndex) + input.newText + content.slice(firstIndex + input.oldText.length);
      await fs.writeFile(targetPath, updated, "utf8");
      return { ok: true, path: targetPath, replacements: 1 };
    }

    const occurrences = countOccurrences(content, input.oldText);
    const updated = content.split(input.oldText).join(input.newText);
    await fs.writeFile(targetPath, updated, "utf8");
    return { ok: true, path: targetPath, replacements: occurrences };
  }
};
