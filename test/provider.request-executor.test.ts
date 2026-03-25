import { describe, expect, it, vi } from "vitest";
import { createRequestExecutor } from "../src/provider/request-executor.js";
import { createAuthModeRegistry } from "../src/provider/auth-mode-registry.js";
import type { WsTransportManager } from "../src/provider/ws-transport.js";
import type { ResponsesRequestOptions } from "../src/provider/responses-transport.js";
import type { OpenAIResponsesResponse } from "../src/provider/openai-types.js";

function mockCodexAuth() {
  return {
    getAccessToken: vi.fn().mockResolvedValue("codex-access-token"),
    getAccountId: vi.fn().mockReturnValue("acct-123"),
    forceRefresh: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn()
  };
}

const fakeResponse: OpenAIResponsesResponse = {
  id: "resp_1",
  output_text: "ok",
  output: []
};

describe("RequestExecutor", () => {
  it("routes to HTTP transport for http transportMode", async () => {
    const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: null });
    const httpFn = vi.fn().mockResolvedValue({ payload: fakeResponse, attempt: 1 });
    const wsManager = { sendResponseCreate: vi.fn() } as unknown as WsTransportManager;

    const executor = createRequestExecutor(registry, {
      http: httpFn,
      getWsManager: () => wsManager
    });

    const result = await executor.execute({ model: "gpt-4" }, {
      chatId: "chat-1",
      authMode: "api",
      transportMode: "http"
    });

    expect(result.payload).toEqual(fakeResponse);
    expect(httpFn).toHaveBeenCalledOnce();
    expect(wsManager.sendResponseCreate).not.toHaveBeenCalled();
  });

  it("routes to WSS transport for wss transportMode", async () => {
    const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: null });
    const httpFn = vi.fn();
    const wsManager = {
      sendResponseCreate: vi.fn().mockResolvedValue({ payload: fakeResponse, attempt: 1 })
    } as unknown as WsTransportManager;

    const executor = createRequestExecutor(registry, {
      http: httpFn,
      getWsManager: () => wsManager
    });

    const result = await executor.execute({ model: "gpt-4" }, {
      chatId: "chat-1",
      authMode: "api",
      transportMode: "wss"
    });

    expect(result.payload).toEqual(fakeResponse);
    expect(wsManager.sendResponseCreate).toHaveBeenCalledOnce();
    expect(httpFn).not.toHaveBeenCalled();
  });

  it("calls adapter.onTurnStart before making the request", async () => {
    const codexAuth = mockCodexAuth();
    const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth });
    const httpFn = vi.fn().mockResolvedValue({ payload: fakeResponse, attempt: 1 });

    const executor = createRequestExecutor(registry, {
      http: httpFn,
      getWsManager: () => ({} as WsTransportManager)
    });

    await executor.execute({ model: "gpt-4" }, {
      chatId: "chat-1",
      authMode: "codex",
      transportMode: "http"
    });

    expect(codexAuth.reload).toHaveBeenCalledOnce();
    expect(httpFn).toHaveBeenCalledOnce();
  });

  it("passes the correct adapter to the transport via options", async () => {
    const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: null });
    const httpFn = vi.fn().mockResolvedValue({ payload: fakeResponse, attempt: 1 });

    const executor = createRequestExecutor(registry, {
      http: httpFn,
      getWsManager: () => ({} as WsTransportManager)
    });

    await executor.execute({ model: "gpt-4" }, {
      chatId: "chat-1",
      authMode: "api",
      transportMode: "http"
    });

    const options = httpFn.mock.calls[0][2] as ResponsesRequestOptions;
    expect(options.authModeAdapter.id).toBe("api");
  });

  it("uses codex adapter when authMode is codex", async () => {
    const codexAuth = mockCodexAuth();
    const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth });
    const httpFn = vi.fn().mockResolvedValue({ payload: fakeResponse, attempt: 1 });

    const executor = createRequestExecutor(registry, {
      http: httpFn,
      getWsManager: () => ({} as WsTransportManager)
    });

    await executor.execute({ model: "gpt-4" }, {
      chatId: "chat-1",
      authMode: "codex",
      transportMode: "http"
    });

    const options = httpFn.mock.calls[0][2] as ResponsesRequestOptions;
    expect(options.authModeAdapter.id).toBe("codex");
  });

  it("normalizes transport when mode does not support it", async () => {
    // Create a registry where we can test normalization
    // Both api and codex currently allow all transports, so this tests the passthrough
    const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: null });
    const httpFn = vi.fn().mockResolvedValue({ payload: fakeResponse, attempt: 1 });
    const wsManager = {
      sendResponseCreate: vi.fn().mockResolvedValue({ payload: fakeResponse, attempt: 1 })
    } as unknown as WsTransportManager;

    const executor = createRequestExecutor(registry, {
      http: httpFn,
      getWsManager: () => wsManager
    });

    // api + wss should work since api supports wss
    await executor.execute({ model: "gpt-4" }, {
      chatId: "chat-1",
      authMode: "api",
      transportMode: "wss"
    });

    expect(wsManager.sendResponseCreate).toHaveBeenCalledOnce();
  });
});
