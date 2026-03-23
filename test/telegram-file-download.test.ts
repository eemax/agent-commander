import { describe, expect, it, vi, beforeEach } from "vitest";
import { downloadTelegramFile, FileTooLargeError } from "../src/telegram/file-download.js";

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};

function createMockBot(options: {
  filePath?: string;
  fileData?: Buffer;
  httpStatus?: number;
}) {
  const { filePath = "photos/file_0.jpg", fileData = Buffer.from("fake-image-data"), httpStatus = 200 } = options;

  const mockFetch = vi.fn().mockResolvedValue({
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    arrayBuffer: async () => fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength)
  });

  vi.stubGlobal("fetch", mockFetch);

  return {
    bot: {
      token: "test-token",
      api: {
        getFile: vi.fn().mockResolvedValue({ file_path: filePath })
      }
    } as never,
    mockFetch
  };
}

describe("downloadTelegramFile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads a file successfully", async () => {
    const fileData = Buffer.from("image-bytes");
    const { bot } = createMockBot({ fileData });

    const result = await downloadTelegramFile({
      bot,
      fileId: "file-123",
      declaredMimeType: "image/jpeg",
      declaredFileName: "photo.jpg",
      declaredFileSize: fileData.length,
      maxSizeBytes: 10 * 1024 * 1024,
      timeoutMs: 5000,
      logger: noopLogger
    });

    expect(result.buffer).toEqual(fileData);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.fileName).toBe("photo.jpg");
  });

  it("fast-rejects when declared file size exceeds limit", async () => {
    const { bot } = createMockBot({});

    await expect(
      downloadTelegramFile({
        bot,
        fileId: "file-123",
        declaredMimeType: "image/jpeg",
        declaredFileName: "huge.jpg",
        declaredFileSize: 20 * 1024 * 1024,
        maxSizeBytes: 10 * 1024 * 1024,
        timeoutMs: 5000,
        logger: noopLogger
      })
    ).rejects.toThrow(FileTooLargeError);
  });

  it("rejects when downloaded buffer exceeds limit", async () => {
    const largeData = Buffer.alloc(100);
    const { bot } = createMockBot({ fileData: largeData });

    await expect(
      downloadTelegramFile({
        bot,
        fileId: "file-123",
        declaredMimeType: "image/jpeg",
        declaredFileName: "photo.jpg",
        declaredFileSize: null,
        maxSizeBytes: 50,
        timeoutMs: 5000,
        logger: noopLogger
      })
    ).rejects.toThrow(FileTooLargeError);
  });

  it("throws when Telegram returns no file_path", async () => {
    const bot = {
      token: "test-token",
      api: {
        getFile: vi.fn().mockResolvedValue({ file_path: undefined })
      }
    } as never;

    await expect(
      downloadTelegramFile({
        bot,
        fileId: "file-123",
        declaredMimeType: null,
        declaredFileName: null,
        declaredFileSize: null,
        maxSizeBytes: 10 * 1024 * 1024,
        timeoutMs: 5000,
        logger: noopLogger
      })
    ).rejects.toThrow("no file_path");
  });

  it("throws on HTTP error", async () => {
    const { bot } = createMockBot({ httpStatus: 404 });

    await expect(
      downloadTelegramFile({
        bot,
        fileId: "file-123",
        declaredMimeType: "image/jpeg",
        declaredFileName: "photo.jpg",
        declaredFileSize: null,
        maxSizeBytes: 10 * 1024 * 1024,
        timeoutMs: 5000,
        logger: noopLogger
      })
    ).rejects.toThrow("HTTP 404");
  });

  it("infers MIME type from file extension when not declared", async () => {
    const { bot } = createMockBot({ filePath: "documents/report.pdf" });

    const result = await downloadTelegramFile({
      bot,
      fileId: "file-123",
      declaredMimeType: null,
      declaredFileName: null,
      declaredFileSize: null,
      maxSizeBytes: 10 * 1024 * 1024,
      timeoutMs: 5000,
      logger: noopLogger
    });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.fileName).toBe("report.pdf");
  });

  it("rejects file_path containing path traversal", async () => {
    const { bot } = createMockBot({ filePath: "../../etc/passwd" });

    await expect(
      downloadTelegramFile({
        bot,
        fileId: "file-123",
        declaredMimeType: null,
        declaredFileName: null,
        declaredFileSize: null,
        maxSizeBytes: 10 * 1024 * 1024,
        timeoutMs: 5000,
        logger: noopLogger
      })
    ).rejects.toThrow("Invalid file_path");
  });

  it("rejects file_path with unexpected characters", async () => {
    const { bot } = createMockBot({ filePath: "photos/file name.jpg" });

    await expect(
      downloadTelegramFile({
        bot,
        fileId: "file-123",
        declaredMimeType: null,
        declaredFileName: null,
        declaredFileSize: null,
        maxSizeBytes: 10 * 1024 * 1024,
        timeoutMs: 5000,
        logger: noopLogger
      })
    ).rejects.toThrow("Invalid file_path");
  });

  it("falls back to octet-stream for unknown extension", async () => {
    const { bot } = createMockBot({ filePath: "files/data.xyz" });

    const result = await downloadTelegramFile({
      bot,
      fileId: "file-123",
      declaredMimeType: null,
      declaredFileName: null,
      declaredFileSize: null,
      maxSizeBytes: 10 * 1024 * 1024,
      timeoutMs: 5000,
      logger: noopLogger
    });

    expect(result.mimeType).toBe("application/octet-stream");
  });
});
