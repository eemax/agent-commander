import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RuntimeLogger } from "../runtime/contracts.js";

export type OutboundAttachment = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  sendAsPhoto: boolean;
};

const TELEGRAM_DOC_MAX_BYTES = 50 * 1024 * 1024;
const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

const PHOTO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const ATTACH_MARKER_REGEX = /<!--\s*attach:\s*(.+?)\s*-->/g;

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
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".sql": "text/plain",
  ".log": "text/plain"
};

export function extractAttachMarkers(text: string): { cleanText: string; markers: string[] } {
  const markers: string[] = [];

  const cleanText = text.replace(ATTACH_MARKER_REGEX, (_match, filePath: string) => {
    const trimmed = filePath.trim();
    if (trimmed.length > 0) {
      markers.push(trimmed);
    }
    return "";
  });

  return { cleanText, markers };
}

export async function resolveOutboundAttachment(
  filePath: string,
  logger: RuntimeLogger
): Promise<OutboundAttachment | null> {
  if (!path.isAbsolute(filePath)) {
    logger.warn(`outbound-attachment: rejected non-absolute path: ${filePath}`);
    return null;
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    logger.warn(`outbound-attachment: file not found: ${filePath}`);
    return null;
  }

  if (!stat.isFile()) {
    logger.warn(`outbound-attachment: not a regular file: ${filePath}`);
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();
  const isPhoto = PHOTO_EXTENSIONS.has(ext);
  const maxBytes = isPhoto ? TELEGRAM_PHOTO_MAX_BYTES : TELEGRAM_DOC_MAX_BYTES;

  if (stat.size > maxBytes) {
    const limitMB = Math.round(maxBytes / (1024 * 1024));
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    logger.warn(`outbound-attachment: file too large (${sizeMB} MB, limit ${limitMB} MB): ${filePath}`);
    return null;
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`outbound-attachment: failed to read file: ${filePath}: ${message}`);
    return null;
  }

  const fileName = path.basename(filePath);
  const mimeType = EXTENSION_MIME_MAP[ext] ?? "application/octet-stream";

  return {
    buffer,
    fileName,
    mimeType,
    sendAsPhoto: isPhoto
  };
}
