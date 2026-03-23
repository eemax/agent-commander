import { describe, expect, it } from "vitest";
import { normalizeHistory } from "../src/provider/history.js";
import type { PromptMessage } from "../src/types.js";

describe("normalizeHistory", () => {
  it("passes through string content unchanged", () => {
    const history: PromptMessage[] = [
      { role: "user", content: "Hello", createdAt: "2024-01-01T00:00:00Z", senderId: "1", senderName: "Alice" },
      { role: "assistant", content: "Hi there!", createdAt: "2024-01-01T00:00:01Z", senderId: null, senderName: null }
    ];

    const result = normalizeHistory(history);
    expect(result).toEqual([
      { type: "message", role: "user", content: "Hello" },
      { type: "message", role: "assistant", content: "Hi there!" }
    ]);
  });

  it("maps TextContentPart to OpenAI input_text", () => {
    const history: PromptMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Look at this" }],
        createdAt: "2024-01-01T00:00:00Z",
        senderId: "1",
        senderName: "Alice"
      }
    ];

    const result = normalizeHistory(history);
    expect(result[0]!.content).toEqual([
      { type: "input_text", text: "Look at this" }
    ]);
  });

  it("maps ImageContentPart to OpenAI input_image with data URL", () => {
    const history: PromptMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", mimeType: "image/jpeg", base64: "AQID" }
        ],
        createdAt: "2024-01-01T00:00:00Z",
        senderId: "1",
        senderName: "Alice"
      }
    ];

    const result = normalizeHistory(history);
    expect(result[0]!.content).toEqual([
      { type: "input_image", image_url: "data:image/jpeg;base64,AQID", detail: "auto" }
    ]);
  });

  it("maps FileContentPart to OpenAI input_file with data URL", () => {
    const history: PromptMessage[] = [
      {
        role: "user",
        content: [
          { type: "file", mimeType: "application/pdf", base64: "JVBER", fileName: "doc.pdf" }
        ],
        createdAt: "2024-01-01T00:00:00Z",
        senderId: "1",
        senderName: "Alice"
      }
    ];

    const result = normalizeHistory(history);
    expect(result[0]!.content).toEqual([
      { type: "input_file", filename: "doc.pdf", file_data: "data:application/pdf;base64,JVBER" }
    ]);
  });

  it("maps mixed ContentPart array correctly", () => {
    const history: PromptMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Here is an image and a file" },
          { type: "image", mimeType: "image/png", base64: "iVBOR" },
          { type: "file", mimeType: "application/pdf", base64: "JVBER", fileName: "report.pdf" }
        ],
        createdAt: "2024-01-01T00:00:00Z",
        senderId: "1",
        senderName: "Alice"
      }
    ];

    const result = normalizeHistory(history);
    const content = result[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    expect((content as unknown[]).length).toBe(3);
    expect((content as Array<{ type: string }>)[0]!.type).toBe("input_text");
    expect((content as Array<{ type: string }>)[1]!.type).toBe("input_image");
    expect((content as Array<{ type: string }>)[2]!.type).toBe("input_file");
  });
});
