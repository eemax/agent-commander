import { describe, expect, it, vi } from "vitest";
import { buildResolvedRequestBody } from "../src/provider/auth-mode-contracts.js";
import { createAuthModeRegistry } from "../src/provider/auth-mode-registry.js";

function mockCodexAuth() {
  return {
    getAccessToken: vi.fn().mockResolvedValue("codex-access-token"),
    getAccountId: vi.fn().mockReturnValue("acct-123"),
    forceRefresh: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn()
  };
}

describe("AuthModeRegistry", () => {
  describe("api adapter", () => {
    it("allows http transport", () => {
      const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: null });
      const result = registry.normalizeTransport("api", "http");
      expect(result).toEqual({ transport: "http", changed: false, reason: null });
    });

    it("allows wss transport", () => {
      const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: null });
      const result = registry.normalizeTransport("api", "wss");
      expect(result).toEqual({ transport: "wss", changed: false, reason: null });
    });

    it("is always available", () => {
      const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: null });
      const adapter = registry.get("api");
      expect(adapter.availability()).toEqual({ ok: true });
    });

    it("has statelessToolLoop = false", () => {
      const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: null });
      const adapter = registry.get("api");
      expect(adapter.describe().capabilities.statelessToolLoop).toBe(false);
    });

    it("resolves request with api URL and headers", async () => {
      const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: null });
      const adapter = registry.get("api");
      const resolved = await adapter.resolveRequest();
      expect(resolved.httpUrl).toBe("https://api.openai.com/v1/responses");
      expect(resolved.wsUrl).toBe("wss://api.openai.com/v1/responses");
      expect(resolved.headers.authorization).toBe("Bearer sk-test");
      expect(resolved.extraBodyFields).toEqual({});
      expect(resolved.stripBodyFields).toEqual([]);
    });
  });

  describe("codex adapter", () => {
    it("allows http transport", () => {
      const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: mockCodexAuth() });
      const result = registry.normalizeTransport("codex", "http");
      expect(result).toEqual({ transport: "http", changed: false, reason: null });
    });

    it("allows wss transport", () => {
      const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: mockCodexAuth() });
      const result = registry.normalizeTransport("codex", "wss");
      expect(result).toEqual({ transport: "wss", changed: false, reason: null });
    });

    it("is available when codexAuth is present", () => {
      const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: mockCodexAuth() });
      const adapter = registry.get("codex");
      expect(adapter.availability()).toEqual({ ok: true });
    });

    it("is unavailable when codexAuth is null", () => {
      const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: null });
      const adapter = registry.get("codex");
      const avail = adapter.availability();
      expect(avail.ok).toBe(false);
      if (!avail.ok) {
        expect(avail.reason).toContain("auth.json");
      }
    });

    it("has statelessToolLoop = true", () => {
      const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: mockCodexAuth() });
      const adapter = registry.get("codex");
      expect(adapter.describe().capabilities.statelessToolLoop).toBe(true);
    });

    it("resolves request with codex URL and headers", async () => {
      const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: mockCodexAuth() });
      const adapter = registry.get("codex");
      const resolved = await adapter.resolveRequest();
      expect(resolved.httpUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(resolved.wsUrl).toBe("wss://chatgpt.com/backend-api/codex/responses");
      expect(resolved.headers.authorization).toBe("Bearer codex-access-token");
      expect(resolved.headers["chatgpt-account-id"]).toBe("acct-123");
      expect(resolved.extraBodyFields).toEqual({ store: false });
      expect(resolved.stripBodyFields).toEqual([
        "prompt_cache_key",
        "prompt_cache_retention",
        "previous_response_id"
      ]);
    });

    it("resolveRequest throws when codexAuth is null", async () => {
      const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth: null });
      const adapter = registry.get("codex");
      await expect(adapter.resolveRequest()).rejects.toThrow("not found at startup");
    });

    it("onTurnStart calls codexAuth.reload", () => {
      const codexAuth = mockCodexAuth();
      const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth });
      const adapter = registry.get("codex");
      adapter.onTurnStart?.();
      expect(codexAuth.reload).toHaveBeenCalledOnce();
    });

    it("onUnauthorized calls codexAuth.forceRefresh", async () => {
      const codexAuth = mockCodexAuth();
      const registry = createAuthModeRegistry({ apiKey: "sk-test", codexAuth });
      const adapter = registry.get("codex");
      await adapter.onUnauthorized?.();
      expect(codexAuth.forceRefresh).toHaveBeenCalledOnce();
    });
  });
});

describe("buildResolvedRequestBody", () => {
  it("merges extra body fields", () => {
    const result = buildResolvedRequestBody(
      { model: "gpt-4", input: [] },
      {
        httpUrl: "", wsUrl: "", headers: {},
        extraBodyFields: { store: false },
        stripBodyFields: []
      },
      { includeStream: false }
    );
    expect(result).toEqual({ model: "gpt-4", input: [], store: false });
  });

  it("strips specified body fields", () => {
    const result = buildResolvedRequestBody(
      { model: "gpt-4", prompt_cache_key: "abc", input: [] },
      {
        httpUrl: "", wsUrl: "", headers: {},
        extraBodyFields: {},
        stripBodyFields: ["prompt_cache_key"]
      },
      { includeStream: false }
    );
    expect(result).toEqual({ model: "gpt-4", input: [] });
  });

  it("adds stream:true when includeStream is true", () => {
    const result = buildResolvedRequestBody(
      { model: "gpt-4" },
      {
        httpUrl: "", wsUrl: "", headers: {},
        extraBodyFields: {},
        stripBodyFields: []
      },
      { includeStream: true }
    );
    expect(result.stream).toBe(true);
  });

  it("does not add stream when includeStream is false", () => {
    const result = buildResolvedRequestBody(
      { model: "gpt-4" },
      {
        httpUrl: "", wsUrl: "", headers: {},
        extraBodyFields: {},
        stripBodyFields: []
      },
      { includeStream: false }
    );
    expect(result.stream).toBeUndefined();
  });

  it("extra body fields override original body fields", () => {
    const result = buildResolvedRequestBody(
      { model: "gpt-4", store: true },
      {
        httpUrl: "", wsUrl: "", headers: {},
        extraBodyFields: { store: false },
        stripBodyFields: []
      },
      { includeStream: false }
    );
    expect(result.store).toBe(false);
  });
});
