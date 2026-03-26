import { describe, it, expect, vi } from "vitest";
import { parseCompletedPayload, parseOpenAIStream } from "../src/provider/sse-parser.js";

function makeSseResponse(rawSse: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(rawSse));
      controller.close();
    }
  });
  return new Response(stream);
}

/* ------------------------------------------------------------------ */
/*  parseCompletedPayload                                             */
/* ------------------------------------------------------------------ */
describe("parseCompletedPayload", () => {
  it("returns response from wrapped response key", () => {
    const result = parseCompletedPayload({
      response: { id: "resp_1", output_text: "hello" }
    });
    expect(result).toEqual({ id: "resp_1", output_text: "hello" });
  });

  it("returns response from flat root with output", () => {
    const result = parseCompletedPayload({ id: "resp_2", output: [] });
    expect(result).toEqual({ id: "resp_2", output: [] });
  });

  it("returns null for non-object", () => {
    expect(parseCompletedPayload(null)).toBeNull();
    expect(parseCompletedPayload("string")).toBeNull();
    expect(parseCompletedPayload(42)).toBeNull();
  });

  it("returns null when no recognizable keys", () => {
    expect(parseCompletedPayload({ foo: "bar" })).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  parseOpenAIStream                                                 */
/* ------------------------------------------------------------------ */
describe("parseOpenAIStream", () => {
  it("parses response.completed and returns payload", async () => {
    const sseText =
      `event: response.completed\ndata: ${JSON.stringify({ response: { id: "r1", output_text: "done" } })}\n\n`;
    const result = await parseOpenAIStream({ response: makeSseResponse(sseText) });
    expect(result.payload).toEqual({ id: "r1", output_text: "done" });
    expect(result.emittedTextDelta).toBe(false);
  });

  it("emits text deltas via onTextDelta", async () => {
    const deltas: string[] = [];
    const sseText = [
      `event: message\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "hel" })}\n\n`,
      `event: message\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "lo" })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ response: { id: "r1", output_text: "hello" } })}\n\n`
    ].join("");

    const result = await parseOpenAIStream({
      response: makeSseResponse(sseText),
      onTextDelta: (d) => { deltas.push(d); }
    });

    expect(deltas).toEqual(["hel", "lo"]);
    expect(result.emittedTextDelta).toBe(true);
  });

  it("ignores comment lines", async () => {
    const sseText = [
      `: this is a comment\n`,
      `event: response.completed\ndata: ${JSON.stringify({ response: { id: "r1", output: [] } })}\n\n`
    ].join("");

    const result = await parseOpenAIStream({ response: makeSseResponse(sseText) });
    expect(result.payload.id).toBe("r1");
  });

  it("handles [DONE] data", async () => {
    const sseText = [
      `event: response.completed\ndata: ${JSON.stringify({ response: { id: "r1", output: [] } })}\n\n`,
      `data: [DONE]\n\n`
    ].join("");

    const result = await parseOpenAIStream({ response: makeSseResponse(sseText) });
    expect(result.payload.id).toBe("r1");
  });

  it("throws SyntaxError on empty body", async () => {
    const response = new Response(null);
    await expect(parseOpenAIStream({ response })).rejects.toThrow(SyntaxError);
  });

  it("throws SyntaxError on invalid JSON in data lines", async () => {
    const sseText = `event: message\ndata: {invalid json\n\n`;
    await expect(parseOpenAIStream({ response: makeSseResponse(sseText) })).rejects.toThrow(SyntaxError);
  });

  it("throws on error event", async () => {
    const sseText = `event: message\ndata: ${JSON.stringify({ type: "error", error: { message: "bad request" } })}\n\n`;
    await expect(parseOpenAIStream({ response: makeSseResponse(sseText) })).rejects.toThrow("bad request");
  });

  it("throws when stream ends without response.completed", async () => {
    const sseText = `event: message\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n`;
    await expect(parseOpenAIStream({ response: makeSseResponse(sseText) })).rejects.toThrow(
      "ended without response.completed"
    );
  });

  it("handles \\r\\n line endings", async () => {
    const sseText =
      `event: response.completed\r\ndata: ${JSON.stringify({ response: { id: "r1", output: [] } })}\r\n\r\n`;
    const result = await parseOpenAIStream({ response: makeSseResponse(sseText) });
    expect(result.payload.id).toBe("r1");
  });

  it("skips empty text deltas", async () => {
    const deltas: string[] = [];
    const sseText = [
      `event: message\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "" })}\n\n`,
      `event: message\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "real" })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ response: { id: "r1", output_text: "real" } })}\n\n`
    ].join("");

    await parseOpenAIStream({
      response: makeSseResponse(sseText),
      onTextDelta: (d) => { deltas.push(d); }
    });
    expect(deltas).toEqual(["real"]);
  });

  it("calls onResponseCreated on response.created event", async () => {
    const onResponseCreated = vi.fn();
    const sseText = [
      `event: message\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r1" } })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ response: { id: "r1", output_text: "done" } })}\n\n`
    ].join("");

    await parseOpenAIStream({
      response: makeSseResponse(sseText),
      onResponseCreated
    });

    expect(onResponseCreated).toHaveBeenCalledTimes(1);
  });

  it("does not call onResponseCreated when event is absent", async () => {
    const onResponseCreated = vi.fn();
    const sseText = [
      `event: message\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ response: { id: "r1", output_text: "hi" } })}\n\n`
    ].join("");

    await parseOpenAIStream({
      response: makeSseResponse(sseText),
      onResponseCreated
    });

    expect(onResponseCreated).not.toHaveBeenCalled();
  });
});
