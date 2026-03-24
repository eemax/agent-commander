import { describe, expect, it, vi, afterEach } from "vitest";
import { createWsTransportManager, type WsTransportDeps } from "../src/provider/ws-transport.js";
import type { TransportAuthResolver } from "../src/provider/transport-auth.js";
import { makeConfig } from "./helpers.js";

const mockAuthResolver: TransportAuthResolver = {
  async resolve() {
    return {
      url: "https://api.openai.com/v1/responses",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      extraBodyFields: {},
      stripBodyFields: []
    };
  },
  async on401() {}
};

// ---------------------------------------------------------------------------
// Minimal mock WebSocket that mirrors the browser/Node 22+ WebSocket API
// surface used by ws-transport.ts.
// ---------------------------------------------------------------------------

type WsHandler = ((event: { data: string }) => void) | null;

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: WsHandler = null;

  sent: string[] = [];
  closed = false;

  constructor(
    public url: string,
    _protocols?: unknown
  ) {
    // Auto-open on next microtask so callers can attach handlers first.
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helper: push a server event through onmessage.
  _receiveMessage(data: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function makeDeps(overrides: Partial<WsTransportDeps> = {}): WsTransportDeps {
  return {
    WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    sleepImpl: async () => {},
    randomImpl: () => 0.5,
    nowMsImpl: () => 1_000_000,
    ...overrides
  };
}

// Track created sockets so tests can interact with them.
let createdSockets: MockWebSocket[] = [];
const originalMock = MockWebSocket;

function trackingSockets(): typeof WebSocket {
  return class extends originalMock {
    constructor(url: string, protocols?: unknown) {
      super(url, protocols);
      createdSockets.push(this);
    }
  } as unknown as typeof WebSocket;
}

afterEach(() => {
  createdSockets = [];
});

describe("createWsTransportManager", () => {
  it("sends correct response.create envelope without stream/background", async () => {
    const config = makeConfig({ openai: { timeoutMs: 5_000 } });
    const manager = createWsTransportManager(config, makeLogger(), mockAuthResolver, makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    const promise = manager.sendResponseCreate(
      { model: "gpt-4.1-mini", input: [], stream: true, background: false },
      "chat-1"
    );

    // Wait for socket creation.
    await vi.waitFor(() => expect(createdSockets).toHaveLength(1));
    const ws = createdSockets[0]!;

    // Wait for send.
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

    const envelope = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(envelope.type).toBe("response.create");
    expect(envelope.model).toBe("gpt-4.1-mini");
    expect(envelope).not.toHaveProperty("stream");
    expect(envelope).not.toHaveProperty("background");

    // Complete the request.
    ws._receiveMessage({
      type: "response.completed",
      response: { id: "resp_1", output_text: "ok", output: [] }
    });

    const result = await promise;
    expect(result.payload).toEqual({ id: "resp_1", output_text: "ok", output: [] });
    expect(result.attempt).toBe(1);

    manager.closeAll();
  });

  it("delivers text deltas via onTextDelta callback", async () => {
    const config = makeConfig({ openai: { timeoutMs: 5_000 } });
    const manager = createWsTransportManager(config, makeLogger(), mockAuthResolver, makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    const deltas: string[] = [];
    const promise = manager.sendResponseCreate(
      { model: "gpt-4.1-mini", input: [] },
      "chat-2",
      { onTextDelta: (d) => { deltas.push(d); } }
    );

    await vi.waitFor(() => expect(createdSockets).toHaveLength(1));
    const ws = createdSockets[0]!;
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

    ws._receiveMessage({ type: "response.output_text.delta", delta: "Hel" });
    ws._receiveMessage({ type: "response.output_text.delta", delta: "lo" });
    ws._receiveMessage({
      type: "response.completed",
      response: { id: "resp_2", output_text: "Hello", output: [] }
    });

    const result = await promise;
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result.payload.output_text).toBe("Hello");

    manager.closeAll();
  });

  it("serializes onmessage processing to prevent concurrent onTextDelta calls", async () => {
    const config = makeConfig({ openai: { timeoutMs: 5_000 } });
    const manager = createWsTransportManager(config, makeLogger(), mockAuthResolver, makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    // Track concurrent delta handlers.
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const deltas: string[] = [];

    const promise = manager.sendResponseCreate(
      { model: "gpt-4.1-mini", input: [] },
      "chat-serial",
      {
        onTextDelta: async (d) => {
          concurrentCount += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrentCount);
          deltas.push(d);
          // Simulate async work (like a Telegram API call).
          await new Promise((r) => setTimeout(r, 10));
          concurrentCount -= 1;
        }
      }
    );

    await vi.waitFor(() => expect(createdSockets).toHaveLength(1));
    const ws = createdSockets[0]!;
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

    // Fire 3 deltas synchronously — without serialization these would
    // all enter onTextDelta concurrently.
    ws._receiveMessage({ type: "response.output_text.delta", delta: "a" });
    ws._receiveMessage({ type: "response.output_text.delta", delta: "b" });
    ws._receiveMessage({ type: "response.output_text.delta", delta: "c" });
    ws._receiveMessage({
      type: "response.completed",
      response: { id: "resp_s", output_text: "abc", output: [] }
    });

    await promise;

    expect(deltas).toEqual(["a", "b", "c"]);
    // The key assertion: serialization means at most 1 concurrent handler.
    expect(maxConcurrent).toBe(1);

    manager.closeAll();
  });

  it("rejects with ProviderError on server error event", async () => {
    const config = makeConfig({ openai: { timeoutMs: 5_000 } });
    const manager = createWsTransportManager(config, makeLogger(), mockAuthResolver, makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    const promise = manager.sendResponseCreate(
      { model: "gpt-4.1-mini", input: [] },
      "chat-err"
    );

    await vi.waitFor(() => expect(createdSockets).toHaveLength(1));
    const ws = createdSockets[0]!;
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

    ws._receiveMessage({
      type: "error",
      error: { message: "model not found", type: "invalid_request_error", code: "model_not_found" }
    });

    await expect(promise).rejects.toMatchObject({
      name: "ProviderError",
      kind: "server_error",
      message: "model not found"
    });

    manager.closeAll();
  });

  it("rejects when socket closes mid-request", async () => {
    const config = makeConfig({ openai: { timeoutMs: 5_000 } });
    const manager = createWsTransportManager(config, makeLogger(), mockAuthResolver, makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    const promise = manager.sendResponseCreate(
      { model: "gpt-4.1-mini", input: [] },
      "chat-close"
    );

    await vi.waitFor(() => expect(createdSockets).toHaveLength(1));
    const ws = createdSockets[0]!;
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

    // Simulate server closing the socket.
    ws.readyState = MockWebSocket.CLOSED;
    ws.onclose?.({ code: 1006, reason: "abnormal" });

    await expect(promise).rejects.toMatchObject({
      name: "ProviderError",
      kind: "network"
    });
  });

  it("rejects pre-aborted requests immediately", async () => {
    const config = makeConfig({ openai: { timeoutMs: 5_000 } });
    const manager = createWsTransportManager(config, makeLogger(), mockAuthResolver, makeDeps());

    const ac = new AbortController();
    ac.abort();

    await expect(
      manager.sendResponseCreate(
        { model: "gpt-4.1-mini", input: [] },
        "chat-preabort",
        { abortSignal: ac.signal }
      )
    ).rejects.toMatchObject({
      name: "ProviderError",
      kind: "timeout",
      detail: { timedOutBy: "upstream_abort" }
    });

    manager.closeAll();
  });

  it("uses separate sockets for different chatIds", async () => {
    const config = makeConfig({ openai: { timeoutMs: 5_000 } });
    const manager = createWsTransportManager(config, makeLogger(), mockAuthResolver, makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    // Launch first request and wait for it to be fully wired.
    const p1 = manager.sendResponseCreate({ model: "gpt-4.1-mini", input: [] }, "chat-A");
    await vi.waitFor(() => expect(createdSockets[0]?.sent).toHaveLength(1));
    createdSockets[0]!._receiveMessage({
      type: "response.completed",
      response: { id: "resp_a", output_text: "ok", output: [] }
    });
    await p1;

    // Launch second request on different chatId.
    const p2 = manager.sendResponseCreate({ model: "gpt-4.1-mini", input: [] }, "chat-B");
    await vi.waitFor(() => expect(createdSockets[1]?.sent).toHaveLength(1));
    createdSockets[1]!._receiveMessage({
      type: "response.completed",
      response: { id: "resp_b", output_text: "ok", output: [] }
    });
    await p2;

    expect(createdSockets).toHaveLength(2);
    expect(createdSockets[0]).not.toBe(createdSockets[1]);

    manager.closeAll();
  });

  it("reuses existing open socket for same chatId", async () => {
    const config = makeConfig({ openai: { timeoutMs: 5_000 } });
    const manager = createWsTransportManager(config, makeLogger(), mockAuthResolver, makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    // First request.
    const p1 = manager.sendResponseCreate({ model: "gpt-4.1-mini", input: [] }, "chat-reuse");
    await vi.waitFor(() => expect(createdSockets).toHaveLength(1));
    const ws = createdSockets[0]!;
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

    ws._receiveMessage({
      type: "response.completed",
      response: { id: "resp_r1", output_text: "first", output: [] }
    });
    await p1;

    // Second request should reuse the same socket.
    const p2 = manager.sendResponseCreate({ model: "gpt-4.1-mini", input: [] }, "chat-reuse");
    await vi.waitFor(() => expect(ws.sent).toHaveLength(2));

    ws._receiveMessage({
      type: "response.completed",
      response: { id: "resp_r2", output_text: "second", output: [] }
    });
    await p2;

    // Only one socket was ever created.
    expect(createdSockets).toHaveLength(1);

    manager.closeAll();
  });
});
