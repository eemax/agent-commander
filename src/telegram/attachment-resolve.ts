import type { ContentPart } from "../types.js";
import type { DownloadedFile } from "./file-download.js";
import type { RuntimeLogger } from "../runtime/contracts.js";

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp"
]);

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".csv", ".xml", ".yaml", ".yml", ".toml", ".ini",
  ".log", ".sh", ".py", ".js", ".ts", ".html", ".css", ".sql",
  ".rs", ".go", ".java", ".c", ".cpp", ".h", ".rb", ".swift", ".kt"
]);

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/x-sh",
  "application/javascript",
  "application/typescript",
  "application/sql",
  "application/x-python"
]);

function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith("text/");
}

function isTextExtension(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}

function decodeUtf8Strict(buffer: Buffer): string | null {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return decoder.decode(buffer);
  } catch {
    return null;
  }
}

export function resolveAttachmentContentParts(params: {
  downloaded: DownloadedFile[];
  logger: RuntimeLogger;
  maxTextBytes?: number;
}): { parts: ContentPart[]; rejected: string[] } {
  const { downloaded, logger } = params;
  const parts: ContentPart[] = [];
  const rejected: string[] = [];

  for (const file of downloaded) {
    if (IMAGE_MIME_TYPES.has(file.mimeType)) {
      parts.push({
        type: "image",
        mimeType: file.mimeType,
        base64: file.buffer.toString("base64")
      });
      logger.debug(`attachment-resolve: image ${file.fileName} (${file.mimeType})`);
    } else if (file.mimeType === "application/pdf") {
      parts.push({
        type: "file",
        mimeType: file.mimeType,
        base64: file.buffer.toString("base64"),
        fileName: file.fileName
      });
      logger.debug(`attachment-resolve: pdf ${file.fileName}`);
    } else if (isTextMime(file.mimeType) || TEXT_MIME_TYPES.has(file.mimeType) || isTextExtension(file.fileName)) {
      const maxBytes = params.maxTextBytes ?? Infinity;
      const needsTruncation = Number.isFinite(maxBytes) && file.buffer.byteLength > maxBytes;
      const sourceBuffer = needsTruncation ? file.buffer.subarray(0, maxBytes) : file.buffer;
      const textContent = decodeUtf8Strict(sourceBuffer)
        ?? (needsTruncation ? new TextDecoder("utf-8", { fatal: false }).decode(sourceBuffer) : null);
      if (textContent === null) {
        rejected.push(`${file.fileName}: not valid UTF-8 text`);
        logger.debug(`attachment-resolve: rejected ${file.fileName} (invalid UTF-8)`);
        continue;
      }
      const safeName = file.fileName.replace(/`/g, "'");
      const suffix = needsTruncation
        ? `\n\n[Truncated: file is ${Math.round(file.buffer.byteLength / 1024)}KB, showing first ${Math.round(maxBytes / 1024)}KB]`
        : "";
      parts.push({
        type: "text",
        text: `\`${safeName}\`:\n${textContent}${suffix}`
      });
      if (needsTruncation) {
        logger.info(`attachment-resolve: truncated ${file.fileName} from ${file.buffer.byteLength} to ${maxBytes} bytes`);
      }
      logger.debug(`attachment-resolve: text file ${file.fileName} (${file.mimeType})`);
    } else {
      rejected.push(file.mimeType);
      logger.debug(`attachment-resolve: rejected ${file.fileName} (${file.mimeType})`);
    }
  }

  return { parts, rejected };
}
