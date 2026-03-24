import { describe, it, expect } from "vitest";
import { extractAssistantText } from "../src/provider/response-text.js";
import { ProviderError } from "../src/provider-error.js";

describe("extractAssistantText", () => {
  it("returns output_text when present", () => {
    expect(extractAssistantText({ output_text: "hello world" })).toBe("hello world");
  });

  it("trims whitespace from output_text", () => {
    expect(extractAssistantText({ output_text: "  hello  " })).toBe("hello");
  });

  it("falls back to output[].text", () => {
    expect(
      extractAssistantText({
        output: [{ text: "chunk one" }, { text: "chunk two" }]
      })
    ).toBe("chunk one\nchunk two");
  });

  it("falls back to output[].content[].text", () => {
    expect(
      extractAssistantText({
        output: [
          {
            content: [
              { type: "output_text", text: "nested" },
              { type: "text", text: "also nested" }
            ]
          }
        ]
      })
    ).toBe("nested\nalso nested");
  });

  it("skips empty text items", () => {
    expect(
      extractAssistantText({
        output: [{ text: "" }, { text: "   " }, { text: "valid" }]
      })
    ).toBe("valid");
  });

  it("prefers output_text over output[].text", () => {
    expect(
      extractAssistantText({
        output_text: "preferred",
        output: [{ text: "fallback" }]
      })
    ).toBe("preferred");
  });

  it("throws ProviderError for empty response", () => {
    expect(() => extractAssistantText({})).toThrow(ProviderError);
    expect(() => extractAssistantText({ output: [] })).toThrow(ProviderError);
    expect(() => extractAssistantText({ output_text: "" })).toThrow(ProviderError);
  });

  it("throws with correct kind for empty response", () => {
    try {
      extractAssistantText({});
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).kind).toBe("invalid_response");
    }
  });
});
