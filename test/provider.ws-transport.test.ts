import { describe, expect, it, vi, afterEach } from "vitest";
import { createWsTransportManager, type WsTransportDeps } from "../src/provider/ws-transport.js";
import type { AuthModeAdapter } from "../src/provider/auth-mode-contracts.js";
import { makeConfig } from "./helpers.js";

const mockAdapter: AuthModeAdapter = {
  id: "api",
  describe: () => ({
    label: "API",
    capabilities: { allowedTransports: ["http", "wss"] as const, defaultTransport: "http" as const, statelessToolLoop: false }
  }),
  availability: () => ({ ok: true }),
  async resolveRequest() {
    return {
      httpUrl: "https://api.openai.com/v1/responses",
      wsUrl: "wss://api.openai.com/v1/responses",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      extraBodyFields: {},
      stripBodyFields: []
    };
  }
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
    const manager = createWsTransportManager(config, makeLogger(), makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    const promise = manager.sendResponseCreate(
      { model: "gpt-5.4-mini", input: [], stream: true, background: false },
      "chat-1",
      { authModeAdapter: mockAdapter }
    );

    // Wait for socket creation.
    await vi.waitFor(() => expect(createdSockets).toHaveLength(1));
    const ws = createdSockets[0]!;

    // Wait for send.
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

    const envelope = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(envelope.type).toBe("response.create");
    expect(envelope.model).toBe("gpt-5.4-mini");
    expect(envelope).not.toHaveProperty("stream");
    expect(envelope).not.toHaveProperty("background");
    expect(envelope).not.toHaveProperty("prompt_cache_key");
    expect(envelope).not.toHaveProperty("prompt_cache_retention");

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
    const manager = createWsTransportManager(config, makeLogger(), makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    const deltas: string[] = [];
    const promise = manager.sendResponseCreate(
      { model: "gpt-5.4-mini", input: [] },
      "chat-2",
      { authModeAdapter: mockAdapter, onTextDelta: (d) => { deltas.push(d); } }
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
    const manager = createWsTransportManager(config, makeLogger(), makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    // Track concurrent delta handlers.
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const deltas: string[] = [];

    const promise = manager.sendResponseCreate(
      { model: "gpt-5.4-mini", input: [] },
      "chat-serial",
      {
        authModeAdapter: mockAdapter,
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
    const manager = createWsTransportManager(config, makeLogger(), makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    const promise = manager.sendResponseCreate(
      { model: "gpt-5.4-mini", input: [] },
      "chat-err",
      { authModeAdapter: mockAdapter }
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
    const manager = createWsTransportManager(config, makeLogger(), makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    const promise = manager.sendResponseCreate(
      { model: "gpt-5.4-mini", input: [] },
      "chat-close",
      { authModeAdapter: mockAdapter }
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
    const manager = createWsTransportManager(config, makeLogger(), makeDeps());

    const ac = new AbortController();
    ac.abort();

    await expect(
      manager.sendResponseCreate(
        { model: "gpt-5.4-mini", input: [] },
        "chat-preabort",
        { authModeAdapter: mockAdapter, abortSignal: ac.signal }
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
    const manager = createWsTransportManager(config, makeLogger(), makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    // Launch first request and wait for it to be fully wired.
    const p1 = manager.sendResponseCreate({ model: "gpt-5.4-mini", input: [] }, "chat-A", { authModeAdapter: mockAdapter });
    await vi.waitFor(() => expect(createdSockets[0]?.sent).toHaveLength(1));
    createdSockets[0]!._receiveMessage({
      type: "response.completed",
      response: { id: "resp_a", output_text: "ok", output: [] }
    });
    await p1;

    // Launch second request on different chatId.
    const p2 = manager.sendResponseCreate({ model: "gpt-5.4-mini", input: [] }, "chat-B", { authModeAdapter: mockAdapter });
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
    const manager = createWsTransportManager(config, makeLogger(), makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    // First request.
    const p1 = manager.sendResponseCreate({ model: "gpt-5.4-mini", input: [] }, "chat-reuse", { authModeAdapter: mockAdapter });
    await vi.waitFor(() => expect(createdSockets).toHaveLength(1));
    const ws = createdSockets[0]!;
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

    ws._receiveMessage({
      type: "response.completed",
      response: { id: "resp_r1", output_text: "first", output: [] }
    });
    await p1;

    // Second request should reuse the same socket.
    const p2 = manager.sendResponseCreate({ model: "gpt-5.4-mini", input: [] }, "chat-reuse", { authModeAdapter: mockAdapter });
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

  it("strips prompt_cache_key and prompt_cache_retention from WSS envelope", async () => {
    const config = makeConfig({ openai: { timeoutMs: 5_000 } });
    const manager = createWsTransportManager(config, makeLogger(), makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    const promise = manager.sendResponseCreate(
      {
        model: "gpt-5.4-mini",
        input: [],
        prompt_cache_key: "acmd:123:conv_1",
        prompt_cache_retention: "in_memory"
      },
      "chat-cache",
      { authModeAdapter: mockAdapter }
    );

    await vi.waitFor(() => expect(createdSockets).toHaveLength(1));
    const ws = createdSockets[0]!;
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

    const envelope = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(envelope.type).toBe("response.create");
    expect(envelope.model).toBe("gpt-5.4-mini");
    expect(envelope).not.toHaveProperty("prompt_cache_key");
    expect(envelope).not.toHaveProperty("prompt_cache_retention");

    ws._receiveMessage({
      type: "response.completed",
      response: { id: "resp_c", output_text: "ok", output: [] }
    });
    await promise;

    manager.closeAll();
  });

  it("opens new socket when auth mode changes for the same chatId", async () => {
    const codexAdapter: AuthModeAdapter = {
      id: "codex",
      describe: () => ({
        label: "Codex",
        capabilities: { allowedTransports: ["http", "wss"] as const, defaultTransport: "http" as const, statelessToolLoop: true }
      }),
      availability: () => ({ ok: true }),
      async resolveRequest() {
        return {
          httpUrl: "https://chatgpt.com/backend-api/codex/responses",
          wsUrl: "wss://chatgpt.com/backend-api/codex/responses",
          headers: { "content-type": "application/json", authorization: "Bearer codex-token" },
          extraBodyFields: { store: false },
          stripBodyFields: ["prompt_cache_key", "prompt_cache_retention", "previous_response_id"]
        };
      }
    };

    const config = makeConfig({ openai: { timeoutMs: 5_000 } });
    const manager = createWsTransportManager(config, makeLogger(), makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    // First request with api adapter.
    const p1 = manager.sendResponseCreate({ model: "gpt-5.4-mini", input: [] }, "chat-switch", { authModeAdapter: mockAdapter });
    await vi.waitFor(() => expect(createdSockets).toHaveLength(1));
    const ws1 = createdSockets[0]!;
    await vi.waitFor(() => expect(ws1.sent).toHaveLength(1));

    ws1._receiveMessage({
      type: "response.completed",
      response: { id: "resp_s1", output_text: "first", output: [] }
    });
    await p1;

    // Second request with codex adapter on same chatId — should open new socket.
    const p2 = manager.sendResponseCreate({ model: "gpt-5.4-mini", input: [] }, "chat-switch", { authModeAdapter: codexAdapter });
    await vi.waitFor(() => expect(createdSockets).toHaveLength(2));
    const ws2 = createdSockets[1]!;
    await vi.waitFor(() => expect(ws2.sent).toHaveLength(1));

    // Old socket was torn down.
    expect(ws1.closed).toBe(true);
    // New socket connects to codex URL.
    expect(ws2.url).toBe("wss://chatgpt.com/backend-api/codex/responses");

    ws2._receiveMessage({
      type: "response.completed",
      response: { id: "resp_s2", output_text: "second", output: [] }
    });
    await p2;

    manager.closeAll();
  });

  it("opens new socket when credentials refresh for the same adapter", async () => {
    let tokenVersion = "token-A";
    const refreshableAdapter: AuthModeAdapter = {
      id: "codex",
      describe: () => ({
        label: "Codex",
        capabilities: { allowedTransports: ["http", "wss"] as const, defaultTransport: "http" as const, statelessToolLoop: true }
      }),
      availability: () => ({ ok: true }),
      async resolveRequest() {
        return {
          httpUrl: "https://chatgpt.com/backend-api/codex/responses",
          wsUrl: "wss://chatgpt.com/backend-api/codex/responses",
          headers: { "content-type": "application/json", authorization: `Bearer ${tokenVersion}` },
          extraBodyFields: { store: false },
          stripBodyFields: ["prompt_cache_key", "prompt_cache_retention", "previous_response_id"]
        };
      }
    };

    const config = makeConfig({ openai: { timeoutMs: 5_000 } });
    const manager = createWsTransportManager(config, makeLogger(), makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    // First request with token-A.
    const p1 = manager.sendResponseCreate({ model: "gpt-5.4-mini", input: [] }, "chat-cred", { authModeAdapter: refreshableAdapter });
    await vi.waitFor(() => expect(createdSockets).toHaveLength(1));
    const ws1 = createdSockets[0]!;
    await vi.waitFor(() => expect(ws1.sent).toHaveLength(1));

    ws1._receiveMessage({
      type: "response.completed",
      response: { id: "resp_c1", output_text: "first", output: [] }
    });
    await p1;

    // Simulate credential refresh.
    tokenVersion = "token-B";

    // Second request — same adapter but new credentials should open new socket.
    const p2 = manager.sendResponseCreate({ model: "gpt-5.4-mini", input: [] }, "chat-cred", { authModeAdapter: refreshableAdapter });
    await vi.waitFor(() => expect(createdSockets).toHaveLength(2));
    const ws2 = createdSockets[1]!;
    await vi.waitFor(() => expect(ws2.sent).toHaveLength(1));

    expect(ws1.closed).toBe(true);

    ws2._receiveMessage({
      type: "response.completed",
      response: { id: "resp_c2", output_text: "second", output: [] }
    });
    await p2;

    manager.closeAll();
  });

  it("stale socket onclose does not tear down replacement after auth reconnect", async () => {
    let tokenVersion = "token-A";
    const refreshableAdapter: AuthModeAdapter = {
      id: "codex",
      describe: () => ({
        label: "Codex",
        capabilities: { allowedTransports: ["http", "wss"] as const, defaultTransport: "http" as const, statelessToolLoop: true }
      }),
      availability: () => ({ ok: true }),
      async resolveRequest() {
        return {
          httpUrl: "https://chatgpt.com/backend-api/codex/responses",
          wsUrl: "wss://chatgpt.com/backend-api/codex/responses",
          headers: { "content-type": "application/json", authorization: `Bearer ${tokenVersion}` },
          extraBodyFields: { store: false },
          stripBodyFields: ["prompt_cache_key", "prompt_cache_retention", "previous_response_id"]
        };
      }
    };

    const config = makeConfig({ openai: { timeoutMs: 5_000 } });
    const manager = createWsTransportManager(config, makeLogger(), makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    // First request with token-A.
    const p1 = manager.sendResponseCreate({ model: "gpt-5.4-mini", input: [] }, "chat-race", { authModeAdapter: refreshableAdapter });
    await vi.waitFor(() => expect(createdSockets).toHaveLength(1));
    const ws1 = createdSockets[0]!;
    await vi.waitFor(() => expect(ws1.sent).toHaveLength(1));

    ws1._receiveMessage({
      type: "response.completed",
      response: { id: "resp_r1", output_text: "first", output: [] }
    });
    await p1;

    // Capture the old onclose handler before token refresh triggers reconnect.
    const oldOnclose = ws1.onclose!;

    // Simulate credential refresh.
    tokenVersion = "token-B";

    // Second request — triggers auth reconnect, tears down old socket, opens new one.
    const p2 = manager.sendResponseCreate({ model: "gpt-5.4-mini", input: [] }, "chat-race", { authModeAdapter: refreshableAdapter });
    await vi.waitFor(() => expect(createdSockets).toHaveLength(2));
    const ws2 = createdSockets[1]!;
    await vi.waitFor(() => expect(ws2.sent).toHaveLength(1));

    // Old socket was torn down.
    expect(ws1.closed).toBe(true);

    // Now simulate the stale socket's onclose firing AFTER the replacement is stored.
    // Without the fix, this would tear down ws2.
    oldOnclose({ code: 1000, reason: "client-close" });

    // The replacement socket should still be alive and usable.
    expect(ws2.closed).toBe(false);

    // Complete the second request to prove the new socket works.
    ws2._receiveMessage({
      type: "response.completed",
      response: { id: "resp_r2", output_text: "second", output: [] }
    });
    const result = await p2;
    expect(result.payload.output_text).toBe("second");

    manager.closeAll();
  });

  it("reconnects when only chatgpt-account-id changes", async () => {
    let accountId = "account-A";
    const accountAdapter: AuthModeAdapter = {
      id: "codex",
      describe: () => ({
        label: "Codex",
        capabilities: { allowedTransports: ["http", "wss"] as const, defaultTransport: "http" as const, statelessToolLoop: true }
      }),
      availability: () => ({ ok: true }),
      async resolveRequest() {
        return {
          httpUrl: "https://chatgpt.com/backend-api/codex/responses",
          wsUrl: "wss://chatgpt.com/backend-api/codex/responses",
          headers: { "content-type": "application/json", authorization: "Bearer same-token", "chatgpt-account-id": accountId },
          extraBodyFields: { store: false },
          stripBodyFields: ["prompt_cache_key", "prompt_cache_retention", "previous_response_id"]
        };
      }
    };

    const config = makeConfig({ openai: { timeoutMs: 5_000 } });
    const manager = createWsTransportManager(config, makeLogger(), makeDeps({
      WebSocketImpl: trackingSockets()
    }));

    // First request with account-A.
    const p1 = manager.sendResponseCreate({ model: "gpt-5.4-mini", input: [] }, "chat-acct", { authModeAdapter: accountAdapter });
    await vi.waitFor(() => expect(createdSockets).toHaveLength(1));
    const ws1 = createdSockets[0]!;
    await vi.waitFor(() => expect(ws1.sent).toHaveLength(1));

    ws1._receiveMessage({
      type: "response.completed",
      response: { id: "resp_a1", output_text: "first", output: [] }
    });
    await p1;

    // Switch account — same token, different account-id.
    accountId = "account-B";

    // Second request should open new socket because account-id changed.
    const p2 = manager.sendResponseCreate({ model: "gpt-5.4-mini", input: [] }, "chat-acct", { authModeAdapter: accountAdapter });
    await vi.waitFor(() => expect(createdSockets).toHaveLength(2));
    const ws2 = createdSockets[1]!;
    await vi.waitFor(() => expect(ws2.sent).toHaveLength(1));

    expect(ws1.closed).toBe(true);

    ws2._receiveMessage({
      type: "response.completed",
      response: { id: "resp_a2", output_text: "second", output: [] }
    });
    await p2;

    manager.closeAll();
  });
});
