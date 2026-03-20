import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createObservabilitySink, createTraceRootContext } from "../src/observability.js";
import { createResponsesRequestWithRetry } from "../src/provider/responses-transport.js";
import { createTempDir, makeConfig } from "./helpers.js";

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function makeSseResponse(events: Array<{ event?: string; data: unknown }>): Response {
  const payload = events
    .map((entry) => {
      const parts: string[] = [];
      if (entry.event) {
        parts.push(`event: ${entry.event}`);
      }
      parts.push(`data: ${typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data)}`);
      return `${parts.join("\n")}\n\n`;
    })
    .join("");

  return new Response(payload, {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  });
}

describe("createResponsesRequestWithRetry", () => {
  it("parses SSE output deltas and returns response.completed payload", async () => {
    const fetchMock = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>().mockResolvedValue(
      makeSseResponse([
        {
          event: "response.output_text.delta",
          data: { type: "response.output_text.delta", delta: "Hel" }
        },
        {
          event: "response.output_text.delta",
          data: { type: "response.output_text.delta", delta: "lo" }
        },
        {
          event: "response.completed",
          data: {
            type: "response.completed",
            response: { id: "resp_1", output_text: "Hello", output: [] }
          }
        }
      ])
    );

    const request = createResponsesRequestWithRetry(makeConfig({ openai: { maxRetries: 0 } }), makeLogger(), {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const deltas: string[] = [];
    const result = await request({ model: "gpt-4.1-mini", input: [] }, "chat-1", {
      onTextDelta: (delta) => {
        deltas.push(delta);
      }
    });

    expect(result.attempt).toBe(1);
    expect(result.payload).toEqual({
      id: "resp_1",
      output_text: "Hello",
      output: []
    });
    expect(deltas).toEqual(["Hel", "lo"]);

    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>;
    expect(body.stream).toBe(true);
  });

  it("retries transient HTTP failures before first streamed event", async () => {
    const sleepMock = vi.fn(async (_ms: number) => {});
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        makeSseResponse([
          {
            event: "response.completed",
            data: { type: "response.completed", response: { id: "resp_1", output_text: "done" } }
          }
        ])
      );

    const request = createResponsesRequestWithRetry(
      makeConfig({ openai: { maxRetries: 2, retryBaseMs: 100, retryMaxMs: 500 } }),
      makeLogger(),
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        sleepImpl: sleepMock,
        randomImpl: () => 0.5
      }
    );

    await expect(request({ model: "gpt-4.1-mini", input: [] }, "chat-2")).resolves.toMatchObject({
      attempt: 2,
      payload: { output_text: "done" }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledOnce();
  });

  it("does not retry when stream fails after partial output", async () => {
    const root = createTempDir("acmd-provider-transport-stream-failure-");
    const observabilityPath = path.join(root, "observability.jsonl");
    const sleepMock = vi.fn(async (_ms: number) => {});
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockResolvedValue(
        new Response(
          [
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","delta":"Hi"}',
            "",
            "event: response.completed",
            "data: {not-json}",
            ""
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          }
        )
      );

    const request = createResponsesRequestWithRetry(
      makeConfig({ openai: { maxRetries: 2 }, observability: { enabled: true } }),
      makeLogger(),
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        sleepImpl: sleepMock,
        observability: createObservabilitySink({
          enabled: true,
          logPath: observabilityPath
        })
      }
    );

    const deltas: string[] = [];
    await expect(
      request({ model: "gpt-4.1-mini", input: [] }, "chat-3", {
        trace: createTraceRootContext("provider"),
        onTextDelta: (delta) => {
          deltas.push(delta);
        }
      })
    ).rejects.toMatchObject({
      name: "ProviderError",
      kind: "invalid_response",
      attempts: 1
    });

    expect(deltas).toEqual(["Hi"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();

    const entries = fs
      .readFileSync(observabilityPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const completed = entries.find((entry) => entry.event === "provider.openai.request.completed");
    expect(completed).toBeDefined();
    expect(completed).toEqual(
      expect.objectContaining({
        ok: false,
        stage: "failed"
      })
    );
    expect(completed?.stream).toEqual(
      expect.objectContaining({
        deltaCount: 1,
        deltaChars: 2,
        partialOutput: true
      })
    );
  });

  it("captures OpenAI error detail fields for non-2xx JSON responses", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Unsupported parameter: reasoning.effort",
            type: "invalid_request_error",
            code: "unsupported_parameter",
            param: "reasoning.effort"
          }
        }),
        {
          status: 400,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req_abc123"
          }
        }
      )
    );

    const request = createResponsesRequestWithRetry(makeConfig({ openai: { maxRetries: 0 } }), makeLogger(), {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    await expect(request({ model: "gpt-4.1-mini", input: [] }, "chat-http-400")).rejects.toMatchObject({
      name: "ProviderError",
      kind: "client_error",
      statusCode: 400,
      attempts: 1,
      detail: {
        openaiErrorType: "invalid_request_error",
        openaiErrorCode: "unsupported_parameter",
        openaiErrorParam: "reasoning.effort",
        requestId: "req_abc123"
      }
    });
  });

  it("marks local timeout aborts as local_timeout", async () => {
    const fetchMock = vi.fn((_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const signal = init?.signal;
      return new Promise<Response>((_, reject) => {
        if (!signal) {
          reject(new Error("missing signal"));
          return;
        }

        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }

        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const request = createResponsesRequestWithRetry(
      makeConfig({
        openai: {
          timeoutMs: 5,
          maxRetries: 0
        }
      }),
      makeLogger(),
      {
        fetchImpl: fetchMock as unknown as typeof fetch
      }
    );

    await expect(request({ model: "gpt-4.1-mini", input: [] }, "chat-timeout-local")).rejects.toMatchObject({
      name: "ProviderError",
      kind: "timeout",
      detail: {
        timedOutBy: "local_timeout"
      }
    });
  });

  it("marks upstream aborts as upstream_abort and avoids retries", async () => {
    const fetchMock = vi.fn((_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }

      return Promise.reject(new Error("expected aborted signal"));
    });

    const abortController = new AbortController();
    abortController.abort();
    const request = createResponsesRequestWithRetry(makeConfig({ openai: { maxRetries: 2 } }), makeLogger(), {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    await expect(
      request({ model: "gpt-4.1-mini", input: [] }, "chat-timeout-upstream", {
        abortSignal: abortController.signal
      })
    ).rejects.toMatchObject({
      name: "ProviderError",
      kind: "timeout",
      attempts: 1,
      retryable: false,
      detail: {
        timedOutBy: "upstream_abort"
      }
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
