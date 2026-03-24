import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { extractAttachMarkers, resolveOutboundAttachment } from "../src/telegram/outbound-attachments.js";
import { createTempDir } from "./helpers.js";
import type { RuntimeLogger } from "../src/runtime/contracts.js";

function makeLogger(): RuntimeLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined)
  } as unknown as RuntimeLogger;
}

/* ------------------------------------------------------------------ */
/*  extractAttachMarkers                                              */
/* ------------------------------------------------------------------ */
describe("extractAttachMarkers", () => {
  it("extracts markers from HTML comments", () => {
    const result = extractAttachMarkers("hello <!-- attach: /tmp/file.png --> world");
    expect(result.markers).toEqual(["/tmp/file.png"]);
    expect(result.cleanText).toBe("hello  world");
  });

  it("handles multiple markers", () => {
    const result = extractAttachMarkers(
      "<!-- attach: /a.png -->text<!-- attach: /b.pdf -->"
    );
    expect(result.markers).toEqual(["/a.png", "/b.pdf"]);
    expect(result.cleanText).toBe("text");
  });

  it("trims whitespace in paths", () => {
    const result = extractAttachMarkers("<!-- attach:   /tmp/file.png   -->");
    expect(result.markers).toEqual(["/tmp/file.png"]);
  });

  it("ignores empty markers", () => {
    const result = extractAttachMarkers("<!-- attach:  -->");
    expect(result.markers).toEqual([]);
  });

  it("returns unchanged text when no markers", () => {
    const result = extractAttachMarkers("no markers here");
    expect(result.cleanText).toBe("no markers here");
    expect(result.markers).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  resolveOutboundAttachment                                         */
/* ------------------------------------------------------------------ */
describe("resolveOutboundAttachment", () => {
  it("rejects non-absolute paths", async () => {
    const logger = makeLogger();
    const result = await resolveOutboundAttachment("relative/path.txt", logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns null for missing files", async () => {
    const logger = makeLogger();
    const result = await resolveOutboundAttachment("/nonexistent/path.txt", logger);
    expect(result).toBeNull();
  });

  it("returns null for directories", async () => {
    const logger = makeLogger();
    const dir = createTempDir();
    const result = await resolveOutboundAttachment(dir, logger);
    expect(result).toBeNull();
  });

  it("resolves a valid file with correct MIME type", async () => {
    const logger = makeLogger();
    const dir = createTempDir();
    const filePath = path.join(dir, "test.json");
    await fs.writeFile(filePath, '{"key": "value"}');

    const result = await resolveOutboundAttachment(filePath, logger);
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe("test.json");
    expect(result!.mimeType).toBe("application/json");
    expect(result!.sendAsPhoto).toBe(false);
  });

  it("sets sendAsPhoto for photo extensions", async () => {
    const logger = makeLogger();
    const dir = createTempDir();
    const filePath = path.join(dir, "image.png");
    await fs.writeFile(filePath, Buffer.alloc(100));

    const result = await resolveOutboundAttachment(filePath, logger);
    expect(result!.sendAsPhoto).toBe(true);
    expect(result!.mimeType).toBe("image/png");
  });

  it("falls back to application/octet-stream for unknown extensions", async () => {
    const logger = makeLogger();
    const dir = createTempDir();
    const filePath = path.join(dir, "data.xyz");
    await fs.writeFile(filePath, "data");

    const result = await resolveOutboundAttachment(filePath, logger);
    expect(result!.mimeType).toBe("application/octet-stream");
  });
});
