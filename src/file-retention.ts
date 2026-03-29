import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

function trimToNewestLines(content: string, maxLines: number | null): string {
  if (maxLines === null) {
    return content;
  }

  const normalizedMaxLines = Math.max(1, Math.floor(maxLines));
  const lines = content.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  if (lines.length <= normalizedMaxLines) {
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  }

  return `${lines.slice(lines.length - normalizedMaxLines).join("\n")}\n`;
}

export async function appendTextWithTailRetention(params: {
  filePath: string;
  text: string;
  maxLines: number | null;
}): Promise<void> {
  await fsp.mkdir(path.dirname(params.filePath), { recursive: true });
  await fsp.appendFile(params.filePath, params.text, "utf8");

  if (params.maxLines === null) {
    return;
  }

  const existing = await fsp.readFile(params.filePath, "utf8");
  const trimmed = trimToNewestLines(existing, params.maxLines);
  if (trimmed !== existing) {
    await fsp.writeFile(params.filePath, trimmed, "utf8");
  }
}

export function appendTextWithTailRetentionSync(params: {
  filePath: string;
  text: string;
  maxLines: number | null;
}): void {
  fs.mkdirSync(path.dirname(params.filePath), { recursive: true });
  fs.appendFileSync(params.filePath, params.text, "utf8");

  if (params.maxLines === null) {
    return;
  }

  const existing = fs.readFileSync(params.filePath, "utf8");
  const trimmed = trimToNewestLines(existing, params.maxLines);
  if (trimmed !== existing) {
    fs.writeFileSync(params.filePath, trimmed, "utf8");
  }
}
