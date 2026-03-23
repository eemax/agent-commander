import type { PromptMessage, ContentPart } from "../types.js";
import type { OpenAIInputMessage, OpenAIContentBlock } from "./openai-types.js";

function mapContentPartToOpenAI(part: ContentPart): OpenAIContentBlock {
  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text };
    case "image":
      return {
        type: "input_image",
        image_url: `data:${part.mimeType};base64,${part.base64}`,
        detail: "auto"
      };
    case "file":
      return {
        type: "input_file",
        filename: part.fileName,
        file_data: `data:${part.mimeType};base64,${part.base64}`
      };
  }
}

export function normalizeHistory(history: PromptMessage[]): OpenAIInputMessage[] {
  return history.map((item) => ({
    type: "message",
    role: item.role,
    content: typeof item.content === "string"
      ? item.content
      : item.content.map(mapContentPartToOpenAI)
  }));
}
