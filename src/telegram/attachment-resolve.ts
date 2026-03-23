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
  ".log", ".env", ".sh", ".py", ".js", ".ts", ".html", ".css", ".sql",
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

export function resolveAttachmentContentParts(params: {
  downloaded: DownloadedFile[];
  logger: RuntimeLogger;
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
      const textContent = file.buffer.toString("utf-8");
      parts.push({
        type: "text",
        text: `\`${file.fileName}\`:\n${textContent}`
      });
      logger.debug(`attachment-resolve: text file ${file.fileName} (${file.mimeType})`);
    } else {
      rejected.push(file.mimeType);
      logger.debug(`attachment-resolve: rejected ${file.fileName} (${file.mimeType})`);
    }
  }

  return { parts, rejected };
}
