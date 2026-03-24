import { describe, expect, it, vi } from "vitest";
import { createTransportAuthResolver } from "../src/provider/transport-auth.js";

function mockCodexAuth() {
  return {
    getAccessToken: vi.fn().mockResolvedValue("codex-access-token"),
    getAccountId: vi.fn().mockReturnValue("acct-123"),
    forceRefresh: vi.fn().mockResolvedValue(undefined)
  };
}

describe("TransportAuthResolver", () => {
  describe("resolve('api')", () => {
    it("returns correct URL", async () => {
      const resolver = createTransportAuthResolver({ apiKey: "sk-test", codexAuth: null });
      const result = await resolver.resolve("api");
      expect(result.url).toBe("https://api.openai.com/v1/responses");
    });

    it("returns correct headers", async () => {
      const resolver = createTransportAuthResolver({ apiKey: "sk-test", codexAuth: null });
      const result = await resolver.resolve("api");
      expect(result.headers).toEqual({
        "content-type": "application/json",
        authorization: "Bearer sk-test"
      });
    });

    it("returns empty extraBodyFields and stripBodyFields", async () => {
      const resolver = createTransportAuthResolver({ apiKey: "sk-test", codexAuth: null });
      const result = await resolver.resolve("api");
      expect(result.extraBodyFields).toEqual({});
      expect(result.stripBodyFields).toEqual([]);
    });
  });

  describe("resolve('codex')", () => {
    it("returns correct URL", async () => {
      const resolver = createTransportAuthResolver({ apiKey: "sk-test", codexAuth: mockCodexAuth() });
      const result = await resolver.resolve("codex");
      expect(result.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    });

    it("returns correct headers", async () => {
      const codexAuth = mockCodexAuth();
      const resolver = createTransportAuthResolver({ apiKey: "sk-test", codexAuth });
      const result = await resolver.resolve("codex");
      expect(result.headers).toEqual({
        "content-type": "application/json",
        authorization: "Bearer codex-access-token",
        "chatgpt-account-id": "acct-123"
      });
    });

    it("returns store:false in extraBodyFields", async () => {
      const resolver = createTransportAuthResolver({ apiKey: "sk-test", codexAuth: mockCodexAuth() });
      const result = await resolver.resolve("codex");
      expect(result.extraBodyFields).toEqual({ store: false });
    });

    it("strips prompt_cache_key and prompt_cache_retention", async () => {
      const resolver = createTransportAuthResolver({ apiKey: "sk-test", codexAuth: mockCodexAuth() });
      const result = await resolver.resolve("codex");
      expect(result.stripBodyFields).toEqual(["prompt_cache_key", "prompt_cache_retention"]);
    });

    it("throws when codexAuth is null", async () => {
      const resolver = createTransportAuthResolver({ apiKey: "sk-test", codexAuth: null });
      await expect(resolver.resolve("codex")).rejects.toThrow("not found at startup");
    });
  });

  describe("on401", () => {
    it("api mode does not call forceRefresh", async () => {
      const codexAuth = mockCodexAuth();
      const resolver = createTransportAuthResolver({ apiKey: "sk-test", codexAuth });
      await resolver.on401("api");
      expect(codexAuth.forceRefresh).not.toHaveBeenCalled();
    });

    it("codex mode calls forceRefresh once", async () => {
      const codexAuth = mockCodexAuth();
      const resolver = createTransportAuthResolver({ apiKey: "sk-test", codexAuth });
      await resolver.on401("codex");
      expect(codexAuth.forceRefresh).toHaveBeenCalledOnce();
    });

    it("codex mode with null codexAuth does not throw", async () => {
      const resolver = createTransportAuthResolver({ apiKey: "sk-test", codexAuth: null });
      await expect(resolver.on401("codex")).resolves.toBeUndefined();
    });
  });
});
