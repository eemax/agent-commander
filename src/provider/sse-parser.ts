import type { OpenAIResponsesResponse } from "./openai-types.js";

export type StreamParseResult = {
  payload: OpenAIResponsesResponse;
  emittedTextDelta: boolean;
};

function parseSseField(line: string): { field: string; value: string } | null {
  const separator = line.indexOf(":");
  if (separator < 0) {
    return null;
  }

  const field = line.slice(0, separator).trim();
  const rawValue = line.slice(separator + 1);
  const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
  return { field, value };
}

function parseCompletedPayload(eventPayload: unknown): OpenAIResponsesResponse | null {
  if (!eventPayload || typeof eventPayload !== "object") {
    return null;
  }

  const root = eventPayload as Record<string, unknown>;
  const candidate =
    root.response && typeof root.response === "object"
      ? (root.response as Record<string, unknown>)
      : root;

  if (!("id" in candidate || "output" in candidate || "output_text" in candidate)) {
    return null;
  }

  return candidate as OpenAIResponsesResponse;
}

export async function parseOpenAIStream(params: {
  response: Response;
  onTextDelta?: (delta: string) => void | Promise<void>;
}): Promise<StreamParseResult> {
  const body = params.response.body;
  if (!body) {
    throw new SyntaxError("OpenAI SSE response body is empty");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completedPayload: OpenAIResponsesResponse | null = null;
  let emittedTextDelta = false;

  const processEventBlock = async (block: string): Promise<void> => {
    const trimmed = block.trim();
    if (trimmed.length === 0) {
      return;
    }

    let eventName = "message";
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
      if (line.startsWith(":")) {
        continue;
      }

      const parsedField = parseSseField(line);
      if (!parsedField) {
        continue;
      }

      if (parsedField.field === "event") {
        eventName = parsedField.value.trim();
        continue;
      }

      if (parsedField.field === "data") {
        dataLines.push(parsedField.value);
      }
    }

    if (dataLines.length === 0) {
      return;
    }

    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SyntaxError(`Invalid SSE payload for ${eventName}: ${message}`);
    }

    const eventType =
      eventName === "message" &&
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { type?: unknown }).type === "string"
        ? (parsed as { type: string }).type
        : eventName;

    if (eventType === "response.output_text.delta" && typeof (parsed as { delta?: unknown }).delta === "string") {
      const delta = (parsed as { delta: string }).delta;
      if (delta.length > 0) {
        emittedTextDelta = true;
        await params.onTextDelta?.(delta);
      }
      return;
    }

    if (eventType === "response.completed") {
      completedPayload = parseCompletedPayload(parsed);
      if (!completedPayload) {
        throw new SyntaxError("OpenAI streaming response.completed event did not include a response payload");
      }
      return;
    }

    if (eventType === "error") {
      const message =
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { error?: unknown }).error === "object" &&
        (parsed as { error: { message?: unknown } }).error &&
        typeof (parsed as { error: { message?: unknown } }).error.message === "string"
          ? (parsed as { error: { message: string } }).error.message
          : "OpenAI SSE returned an error event";

      throw new Error(message);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n?/g, "\n");

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const eventBlock = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      await processEventBlock(eventBlock);
      boundary = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  buffer = buffer.replace(/\r\n?/g, "\n");
  if (buffer.trim().length > 0) {
    await processEventBlock(buffer);
  }

  if (!completedPayload) {
    throw new SyntaxError("OpenAI streaming response ended without response.completed");
  }

  return {
    payload: completedPayload,
    emittedTextDelta
  };
}
