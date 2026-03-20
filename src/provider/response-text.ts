import { ProviderError } from "../provider-error.js";
import type { OpenAIResponsesResponse } from "./openai-types.js";

export function extractAssistantText(payload: OpenAIResponsesResponse): string {
  const outputText = payload.output_text?.trim();
  if (outputText && outputText.length > 0) {
    return outputText;
  }

  const chunks: string[] = [];
  for (const item of payload.output ?? []) {
    if (typeof item.text === "string" && item.text.trim().length > 0) {
      chunks.push(item.text.trim());
      continue;
    }

    if (!Array.isArray(item.content)) {
      continue;
    }

    for (const contentItem of item.content) {
      if (
        (contentItem.type === "output_text" || contentItem.type === "text") &&
        typeof contentItem.text === "string" &&
        contentItem.text.trim().length > 0
      ) {
        chunks.push(contentItem.text.trim());
      }
    }
  }

  if (chunks.length > 0) {
    return chunks.join("\n");
  }

  throw new ProviderError({
    message: "Provider returned an empty response",
    kind: "invalid_response",
    attempts: 1,
    retryable: false,
    detail: {
      reason: "Provider returned an empty response",
      openaiErrorType: null,
      openaiErrorCode: null,
      openaiErrorParam: null,
      requestId: null,
      retryAfterMs: null,
      timedOutBy: null
    }
  });
}
