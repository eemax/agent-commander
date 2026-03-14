import type { PromptMessage } from "../types.js";
import type { OpenAIInputMessage } from "./openai-types.js";

export function normalizeHistory(history: PromptMessage[]): OpenAIInputMessage[] {
  return history.map((item) => ({
    type: "message",
    role: item.role,
    content: item.content
  }));
}
