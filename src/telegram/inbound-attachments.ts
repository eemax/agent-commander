import type { Bot } from "grammy";
import { Semaphore } from "../concurrency.js";
import type { AttachmentResolver } from "../message-queue.js";
import type { RuntimeLogger } from "../runtime/contracts.js";
import type { ContentPart, NormalizedTelegramMessage } from "../types.js";
import { resolveAttachmentContentParts } from "./attachment-resolve.js";
import { downloadTelegramFile, FileTooLargeError, type DownloadedFile } from "./file-download.js";

export function createTelegramAttachmentResolver(params: {
  bot: Bot;
  message: NormalizedTelegramMessage;
  isAuthorizedSender: (senderId: string) => boolean;
  logger: RuntimeLogger;
  maxFileSizeBytes: number;
  fileDownloadTimeoutMs: number;
  maxTextAttachmentBytes: number;
  downloadSemaphore: Semaphore;
}): AttachmentResolver | undefined {
  const { message } = params;
  if (!message.attachments || message.attachments.length === 0 || !params.isAuthorizedSender(message.senderId)) {
    return undefined;
  }

  return async () => {
    const downloaded: DownloadedFile[] = [];
    const errors: string[] = [];

    for (const attachment of message.attachments!) {
      await params.downloadSemaphore.acquire();
      try {
        const file = await downloadTelegramFile({
          bot: params.bot,
          fileId: attachment.fileId,
          declaredMimeType: attachment.mimeType,
          declaredFileName: attachment.fileName,
          declaredFileSize: attachment.fileSize,
          maxSizeBytes: params.maxFileSizeBytes,
          timeoutMs: params.fileDownloadTimeoutMs,
          logger: params.logger
        });
        downloaded.push(file);
      } catch (error) {
        if (error instanceof FileTooLargeError) {
          errors.push(
            `File too large (${Math.round(error.fileSize / 1024 / 1024)}MB). Maximum size is ${Math.round(
              params.maxFileSizeBytes / 1024 / 1024
            )}MB.`
          );
        } else {
          const msg = error instanceof Error ? error.message : String(error);
          params.logger.error(`telegram: file download failed: ${msg}`);
          errors.push("Failed to download file.");
        }
      } finally {
        params.downloadSemaphore.release();
      }
    }

    const { parts, rejected } = resolveAttachmentContentParts({
      downloaded,
      logger: params.logger,
      maxTextBytes: params.maxTextAttachmentBytes
    });

    for (const mime of rejected) {
      errors.push(`Unsupported file type: ${mime}. I can process images, PDFs, and text files.`);
    }

    let userContent: string | ContentPart[] | undefined;
    if (parts.length > 0) {
      const contentParts: ContentPart[] = [];
      if (message.text.length > 0) {
        contentParts.push({ type: "text", text: message.text });
      }
      contentParts.push(...parts);
      userContent = contentParts;
    }

    return { userContent, errors };
  };
}
