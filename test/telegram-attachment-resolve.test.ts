import { describe, expect, it } from "vitest";
import { resolveAttachmentContentParts } from "../src/telegram/attachment-resolve.js";
import type { DownloadedFile } from "../src/telegram/file-download.js";

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};

function makeFile(overrides: Partial<DownloadedFile> & { buffer?: Buffer }): DownloadedFile {
  return {
    buffer: Buffer.from("test"),
    mimeType: "application/octet-stream",
    fileName: "file.bin",
    ...overrides
  };
}

describe("resolveAttachmentContentParts", () => {
  it("resolves JPEG image to ImageContentPart", () => {
    const imageData = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const { parts, rejected } = resolveAttachmentContentParts({
      downloaded: [makeFile({ mimeType: "image/jpeg", fileName: "photo.jpg", buffer: imageData })],
      logger: noopLogger
    });

    expect(rejected).toHaveLength(0);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      type: "image",
      mimeType: "image/jpeg",
      base64: imageData.toString("base64")
    });
  });

  it("resolves PNG image to ImageContentPart", () => {
    const { parts, rejected } = resolveAttachmentContentParts({
      downloaded: [makeFile({ mimeType: "image/png", fileName: "screenshot.png" })],
      logger: noopLogger
    });

    expect(rejected).toHaveLength(0);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("image");
  });

  it("resolves GIF and WEBP images", () => {
    const { parts, rejected } = resolveAttachmentContentParts({
      downloaded: [
        makeFile({ mimeType: "image/gif", fileName: "anim.gif" }),
        makeFile({ mimeType: "image/webp", fileName: "photo.webp" })
      ],
      logger: noopLogger
    });

    expect(rejected).toHaveLength(0);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.type).toBe("image");
    expect(parts[1]!.type).toBe("image");
  });

  it("resolves PDF to FileContentPart", () => {
    const pdfData = Buffer.from("%PDF-1.4");
    const { parts, rejected } = resolveAttachmentContentParts({
      downloaded: [makeFile({ mimeType: "application/pdf", fileName: "doc.pdf", buffer: pdfData })],
      logger: noopLogger
    });

    expect(rejected).toHaveLength(0);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      type: "file",
      mimeType: "application/pdf",
      base64: pdfData.toString("base64"),
      fileName: "doc.pdf"
    });
  });

  it("resolves text file by MIME type to TextContentPart", () => {
    const content = "Hello, world!";
    const { parts, rejected } = resolveAttachmentContentParts({
      downloaded: [makeFile({ mimeType: "text/plain", fileName: "notes.txt", buffer: Buffer.from(content) })],
      logger: noopLogger
    });

    expect(rejected).toHaveLength(0);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      type: "text",
      text: "`notes.txt`:\nHello, world!"
    });
  });

  it("resolves markdown file by extension", () => {
    const content = "# Title\nContent";
    const { parts, rejected } = resolveAttachmentContentParts({
      downloaded: [makeFile({ mimeType: "application/octet-stream", fileName: "readme.md", buffer: Buffer.from(content) })],
      logger: noopLogger
    });

    expect(rejected).toHaveLength(0);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("text");
  });

  it("resolves JSON file by extension", () => {
    const { parts, rejected } = resolveAttachmentContentParts({
      downloaded: [makeFile({ mimeType: "application/json", fileName: "data.json", buffer: Buffer.from("{}") })],
      logger: noopLogger
    });

    expect(rejected).toHaveLength(0);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("text");
  });

  it("rejects unsupported MIME types", () => {
    const { parts, rejected } = resolveAttachmentContentParts({
      downloaded: [makeFile({ mimeType: "application/zip", fileName: "archive.zip" })],
      logger: noopLogger
    });

    expect(parts).toHaveLength(0);
    expect(rejected).toEqual(["application/zip"]);
  });

  it("resolves application/json as text via structured MIME type", () => {
    const content = '{"key": "value"}';
    const { parts, rejected } = resolveAttachmentContentParts({
      downloaded: [makeFile({ mimeType: "application/json", fileName: "data.json", buffer: Buffer.from(content) })],
      logger: noopLogger
    });

    expect(rejected).toHaveLength(0);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      type: "text",
      text: "`data.json`:\n{\"key\": \"value\"}"
    });
  });

  it("resolves application/xml as text via structured MIME type", () => {
    const { parts, rejected } = resolveAttachmentContentParts({
      downloaded: [makeFile({ mimeType: "application/xml", fileName: "config.xml", buffer: Buffer.from("<root/>") })],
      logger: noopLogger
    });

    expect(rejected).toHaveLength(0);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("text");
  });

  it("handles mixed batch of supported and unsupported files", () => {
    const { parts, rejected } = resolveAttachmentContentParts({
      downloaded: [
        makeFile({ mimeType: "image/jpeg", fileName: "photo.jpg" }),
        makeFile({ mimeType: "application/pdf", fileName: "doc.pdf" }),
        makeFile({ mimeType: "text/plain", fileName: "notes.txt", buffer: Buffer.from("notes") }),
        makeFile({ mimeType: "video/mp4", fileName: "video.mp4" })
      ],
      logger: noopLogger
    });

    expect(parts).toHaveLength(3);
    expect(parts[0]!.type).toBe("image");
    expect(parts[1]!.type).toBe("file");
    expect(parts[2]!.type).toBe("text");
    expect(rejected).toEqual(["video/mp4"]);
  });

  it("returns empty parts and rejected for empty input", () => {
    const { parts, rejected } = resolveAttachmentContentParts({
      downloaded: [],
      logger: noopLogger
    });

    expect(parts).toHaveLength(0);
    expect(rejected).toHaveLength(0);
  });
});
