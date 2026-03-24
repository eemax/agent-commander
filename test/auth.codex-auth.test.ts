import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexAuthManager } from "../src/auth/codex-auth.js";
import type { RuntimeLogger } from "../src/runtime/contracts.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  chmodSync: vi.fn()
}));

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRenameSync = vi.mocked(renameSync);
const mockChmodSync = vi.mocked(chmodSync);

function makeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

function makeAuthJson(accessToken: string, refreshToken = "rt_test", accountId = "acct_123"): string {
  return JSON.stringify({
    tokens: { access_token: accessToken, refresh_token: refreshToken, account_id: accountId }
  });
}

function makeLogger(): RuntimeLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function mockFetchOk(body: Record<string, unknown>): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }) as unknown as typeof fetch;
}

function mockFetchFail(status: number, body: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => body
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("createCodexAuthManager", () => {
  const FUTURE_EXP = Math.floor(Date.now() / 1000) + 7200; // 2 hours from now
  const PAST_EXP = Math.floor(Date.now() / 1000) - 100; // expired

  it("loads credentials and returns accountId and accessToken", async () => {
    const jwt = makeJwt(FUTURE_EXP);
    mockReadFileSync.mockReturnValue(makeAuthJson(jwt));

    const mgr = createCodexAuthManager(makeLogger());

    expect(mgr.getAccountId()).toBe("acct_123");
    expect(await mgr.getAccessToken()).toBe(jwt);
  });

  it("throws when tokens field is missing", () => {
    mockReadFileSync.mockReturnValue("{}");

    expect(() => createCodexAuthManager(makeLogger())).toThrow(
      "missing required token fields"
    );
  });

  it("throws for access_token that is not a valid JWT (not 3 segments)", () => {
    mockReadFileSync.mockReturnValue(makeAuthJson("not-a-jwt"));

    expect(() => createCodexAuthManager(makeLogger())).toThrow(
      "not a valid JWT"
    );
  });

  it("throws for access_token with invalid base64 payload", () => {
    mockReadFileSync.mockReturnValue(makeAuthJson("a.!!!.c"));

    expect(() => createCodexAuthManager(makeLogger())).toThrow(
      "not valid base64/JSON"
    );
  });

  it("throws when JWT payload is missing exp claim", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "no-exp" })).toString("base64url");
    const jwt = `${header}.${payload}.sig`;
    mockReadFileSync.mockReturnValue(makeAuthJson(jwt));

    expect(() => createCodexAuthManager(makeLogger())).toThrow(
      "missing exp claim"
    );
  });

  it("refreshes an expired token and writes back auth file", async () => {
    const expiredJwt = makeJwt(PAST_EXP);
    const newJwt = makeJwt(FUTURE_EXP);
    const nowSec = () => Math.floor(Date.now() / 1000);

    // First call: eager load. Subsequent calls: writeBackAuthFile re-reads.
    mockReadFileSync.mockReturnValue(makeAuthJson(expiredJwt));

    const fetchImpl = mockFetchOk({
      access_token: newJwt,
      expires_in: 3600
    });

    const mgr = createCodexAuthManager(makeLogger(), { fetchImpl, nowSec });

    const token = await mgr.getAccessToken();
    expect(token).toBe(newJwt);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(mockChmodSync).toHaveBeenCalled();
    expect(mockRenameSync).toHaveBeenCalled();
  });

  it("throws with status code on failed refresh", async () => {
    const expiredJwt = makeJwt(PAST_EXP);
    mockReadFileSync.mockReturnValue(makeAuthJson(expiredJwt));

    const fetchImpl = mockFetchFail(401, "Unauthorized");

    const mgr = createCodexAuthManager(makeLogger(), {
      fetchImpl,
      nowSec: () => Math.floor(Date.now() / 1000)
    });

    await expect(mgr.getAccessToken()).rejects.toThrow("token refresh failed (401)");
  });

  it("sanitizes Bearer tokens in error response body", async () => {
    const expiredJwt = makeJwt(PAST_EXP);
    mockReadFileSync.mockReturnValue(makeAuthJson(expiredJwt));

    const bodyWithBearer = "Error: Bearer eyJabc123.xyz.456 was invalid";
    const fetchImpl = mockFetchFail(400, bodyWithBearer);

    const mgr = createCodexAuthManager(makeLogger(), {
      fetchImpl,
      nowSec: () => Math.floor(Date.now() / 1000)
    });

    const err = await mgr.getAccessToken().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Bearer [REDACTED]");
    expect((err as Error).message).not.toContain("eyJabc123");
  });

  it("serializes concurrent getAccessToken calls (fetch called once)", async () => {
    const expiredJwt = makeJwt(PAST_EXP);
    const newJwt = makeJwt(FUTURE_EXP);
    mockReadFileSync.mockReturnValue(makeAuthJson(expiredJwt));

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: newJwt, expires_in: 7200 })
    }) as unknown as typeof fetch;

    const mgr = createCodexAuthManager(makeLogger(), {
      fetchImpl,
      nowSec: () => Math.floor(Date.now() / 1000)
    });

    const [t1, t2] = await Promise.all([mgr.getAccessToken(), mgr.getAccessToken()]);

    expect(t1).toBe(newJwt);
    expect(t2).toBe(newJwt);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("serializes forceRefresh with concurrent getAccessToken", async () => {
    const expiredJwt = makeJwt(PAST_EXP);
    const newJwt = makeJwt(FUTURE_EXP);
    mockReadFileSync.mockReturnValue(makeAuthJson(expiredJwt));

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: newJwt, expires_in: 7200 })
    }) as unknown as typeof fetch;

    const mgr = createCodexAuthManager(makeLogger(), {
      fetchImpl,
      nowSec: () => Math.floor(Date.now() / 1000)
    });

    await Promise.all([mgr.forceRefresh(), mgr.getAccessToken()]);

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("uses new refresh_token from response, preserves old one when absent", async () => {
    const expiredJwt = makeJwt(PAST_EXP);
    const newJwt1 = makeJwt(FUTURE_EXP);
    const newJwt2 = makeJwt(FUTURE_EXP + 7200);

    // Track the last written content so reloadFromDisk sees updated tokens
    let lastWritten = makeAuthJson(expiredJwt, "rt_original");
    mockReadFileSync.mockImplementation(() => lastWritten);
    mockWriteFileSync.mockImplementation((_path, content) => {
      lastWritten = content as string;
    });

    // First refresh: returns a new refresh_token
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: newJwt1, refresh_token: "rt_new", expires_in: 3600 })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: newJwt2, expires_in: 3600 })
      }) as unknown as typeof fetch;

    const now = Math.floor(Date.now() / 1000);
    const mgr = createCodexAuthManager(makeLogger(), {
      fetchImpl,
      nowSec: () => now
    });

    // First refresh: new refresh_token provided
    await mgr.forceRefresh();

    // Inspect the writeFileSync call to verify refresh_token was updated
    const firstWriteCall = mockWriteFileSync.mock.calls[0]!;
    const firstWritten = JSON.parse(firstWriteCall[1] as string) as { tokens: { refresh_token: string } };
    expect(firstWritten.tokens.refresh_token).toBe("rt_new");

    // Second refresh: no refresh_token in response → old one preserved
    await mgr.forceRefresh();

    const secondWriteCall = mockWriteFileSync.mock.calls[1]!;
    const secondWritten = JSON.parse(secondWriteCall[1] as string) as { tokens: { refresh_token: string } };
    expect(secondWritten.tokens.refresh_token).toBe("rt_new");
  });

  it("sets chmod 0o600 on the tmp file", async () => {
    const expiredJwt = makeJwt(PAST_EXP);
    const newJwt = makeJwt(FUTURE_EXP);
    mockReadFileSync.mockReturnValue(makeAuthJson(expiredJwt));

    const fetchImpl = mockFetchOk({ access_token: newJwt, expires_in: 3600 });

    const mgr = createCodexAuthManager(makeLogger(), {
      fetchImpl,
      nowSec: () => Math.floor(Date.now() / 1000)
    });

    await mgr.getAccessToken();

    expect(mockChmodSync).toHaveBeenCalledWith(expect.stringContaining(".tmp"), 0o600);
  });

  it("picks up changed credentials from disk via reload()", () => {
    const jwt1 = makeJwt(FUTURE_EXP);
    const jwt2 = makeJwt(FUTURE_EXP);
    mockReadFileSync.mockReturnValue(makeAuthJson(jwt1, "rt_old", "acct_old"));

    const logger = makeLogger();
    const mgr = createCodexAuthManager(logger);

    expect(mgr.getAccountId()).toBe("acct_old");

    // Simulate changing ~/.codex/auth.json to a different account
    mockReadFileSync.mockReturnValue(makeAuthJson(jwt2, "rt_new", "acct_new"));
    mgr.reload();

    expect(mgr.getAccountId()).toBe("acct_new");
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("credentials changed on disk (account=acct_new)")
    );
  });

  it("reload() tolerates unreadable file and keeps cached state", () => {
    const jwt = makeJwt(FUTURE_EXP);
    mockReadFileSync.mockReturnValue(makeAuthJson(jwt, "rt_test", "acct_original"));

    const logger = makeLogger();
    const mgr = createCodexAuthManager(logger);
    expect(mgr.getAccountId()).toBe("acct_original");

    // Simulate file being temporarily unreadable
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(() => mgr.reload()).not.toThrow();
    expect(mgr.getAccountId()).toBe("acct_original");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to reload auth.json from disk")
    );
  });

  it("reload() is a no-op when credentials have not changed", () => {
    const jwt = makeJwt(FUTURE_EXP);
    mockReadFileSync.mockReturnValue(makeAuthJson(jwt, "rt_same", "acct_same"));

    const logger = makeLogger();
    const mgr = createCodexAuthManager(logger);

    // Clear the initial load log
    vi.mocked(logger.info).mockClear();

    mgr.reload();

    // Should not log "credentials changed" since nothing changed
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("credentials changed on disk")
    );
  });
});
