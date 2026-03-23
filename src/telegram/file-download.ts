import { Bot } from "grammy";
import type { RuntimeLogger } from "../runtime/contracts.js";
import * as path from "node:path";

export type DownloadedFile = {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
};

const EXTENSION_MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".xml": "text/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/plain",
  ".ini": "text/plain",
  ".log": "text/plain",
  ".sh": "text/x-shellscript",
  ".py": "text/x-python",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".html": "text/html",
  ".css": "text/css",
  ".sql": "text/plain",
  ".rs": "text/plain",
  ".go": "text/plain",
  ".java": "text/plain",
  ".c": "text/plain",
  ".cpp": "text/plain",
  ".h": "text/plain",
  ".rb": "text/plain",
  ".swift": "text/plain",
  ".kt": "text/plain"
};

function inferMimeType(fileName: string | null): string | null {
  if (!fileName) return null;
  const ext = path.extname(fileName).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? null;
}

export class FileTooLargeError extends Error {
  constructor(
    public readonly fileSize: number,
    public readonly maxSize: number
  ) {
    super(`File size ${fileSize} exceeds limit ${maxSize}`);
    this.name = "FileTooLargeError";
  }
}

export async function downloadTelegramFile(params: {
  bot: Bot;
  fileId: string;
  declaredMimeType: string | null;
  declaredFileName: string | null;
  declaredFileSize: number | null;
  maxSizeBytes: number;
  timeoutMs: number;
  logger: RuntimeLogger;
}): Promise<DownloadedFile> {
  const { bot, fileId, declaredMimeType, declaredFileName, declaredFileSize, maxSizeBytes, timeoutMs, logger } = params;

  if (declaredFileSize !== null && declaredFileSize > maxSizeBytes) {
    throw new FileTooLargeError(declaredFileSize, maxSizeBytes);
  }

  const file = await bot.api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) {
    throw new Error(`Telegram returned no file_path for fileId=${fileId}`);
  }

  if (filePath.includes("..") || /[^a-zA-Z0-9_\-./]/.test(filePath)) {
    throw new Error(`Invalid file_path from Telegram: ${filePath}`);
  }

  const token = bot.token;
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;

  logger.debug(`file-download: fetching ${filePath} (declared size=${declaredFileSize})`);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Telegram file download failed: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length > maxSizeBytes) {
    throw new FileTooLargeError(buffer.length, maxSizeBytes);
  }

  const fileName = declaredFileName ?? path.basename(filePath);
  const mimeType = declaredMimeType ?? inferMimeType(fileName) ?? "application/octet-stream";

  logger.debug(`file-download: completed ${fileName} (${buffer.length} bytes, ${mimeType})`);

  return { buffer, mimeType, fileName };
}
