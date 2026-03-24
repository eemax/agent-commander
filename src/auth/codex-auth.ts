import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeLogger } from "../runtime/contracts.js";

export type CodexAuthManager = {
  /** Returns a valid access token, refreshing if needed. */
  getAccessToken(): Promise<string>;
  /** Returns the ChatGPT account ID. */
  getAccountId(): string;
  /** Force-refresh now (e.g. after a 401). */
  forceRefresh(): Promise<void>;
  /** Re-read ~/.codex/auth.json from disk, adopting new credentials if changed. */
  reload(): void;
};

type CodexAuthState = {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number; // unix epoch seconds
};

const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_MARGIN_SEC = 3600; // refresh 1 hour early

export type CodexAuthDeps = {
  fetchImpl?: typeof fetch;
  nowSec?: () => number;
};

export function createCodexAuthManager(
  logger: RuntimeLogger,
  deps: CodexAuthDeps = {}
): CodexAuthManager {
  const fetchFn = deps.fetchImpl ?? fetch;
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));

  let state: CodexAuthState | null = null;
  let refreshPromise: Promise<void> | null = null;

  function loadAuthFile(): CodexAuthState {
    const raw = readFileSync(CODEX_AUTH_PATH, "utf-8");
    const parsed = JSON.parse(raw) as {
      tokens?: {
        access_token?: string;
        refresh_token?: string;
        account_id?: string;
      };
    };

    const tokens = parsed.tokens;
    if (!tokens?.access_token || !tokens?.refresh_token || !tokens?.account_id) {
      throw new Error(
        `codex-auth: ~/.codex/auth.json is missing required token fields (access_token, refresh_token, account_id)`
      );
    }

    const expiresAt = decodeJwtExp(tokens.access_token);

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accountId: tokens.account_id,
      expiresAt
    };
  }

  function decodeJwtExp(jwt: string): number {
    const parts = jwt.split(".");
    if (parts.length !== 3) {
      throw new Error("codex-auth: access_token is not a valid JWT");
    }
    // Base64url decode the payload
    let claims: { exp?: number };
    try {
      const payload = Buffer.from(parts[1]!, "base64url").toString("utf-8");
      claims = JSON.parse(payload) as { exp?: number };
    } catch {
      throw new Error("codex-auth: access_token JWT payload is not valid base64/JSON");
    }
    if (typeof claims.exp !== "number") {
      throw new Error("codex-auth: JWT payload missing exp claim");
    }
    return claims.exp;
  }

  function needsRefresh(): boolean {
    if (!state) return true;
    return nowSec() + REFRESH_MARGIN_SEC >= state.expiresAt;
  }

  function reloadFromDisk(): void {
    if (refreshPromise) return; // Don't mutate state during an in-flight refresh
    try {
      const disk = loadAuthFile();
      if (
        !state ||
        disk.accountId !== state.accountId ||
        disk.refreshToken !== state.refreshToken
      ) {
        logger.info(
          `codex-auth: credentials changed on disk (account=${disk.accountId}), reloading`
        );
        state = disk;
      }
    } catch (err) {
      logger.warn(`codex-auth: failed to reload auth.json from disk: ${err}`);
    }
  }

  async function doRefresh(): Promise<void> {
    reloadFromDisk();
    if (!state) {
      state = loadAuthFile();
    }

    logger.info("codex-auth: refreshing access token");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: state.refreshToken,
      client_id: CLIENT_ID
    });

    const response = await fetchFn(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable)");
      const safeText = text.slice(0, 200).replace(/Bearer\s+[A-Za-z0-9._\-=]+/gi, "Bearer [REDACTED]");
      throw new Error(
        `codex-auth: token refresh failed (${response.status}): ${safeText}`
      );
    }

    const result = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const newAccessToken = result.access_token;
    const newRefreshToken = result.refresh_token ?? state.refreshToken;
    const expiresAt = result.expires_in
      ? nowSec() + result.expires_in
      : decodeJwtExp(newAccessToken);

    state = {
      ...state,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt
    };

    // Write back updated tokens atomically
    writeBackAuthFile(state);
    logger.info(`codex-auth: token refreshed, expires at ${new Date(expiresAt * 1000).toISOString()}`);
  }

  function writeBackAuthFile(s: CodexAuthState): void {
    try {
      const raw = readFileSync(CODEX_AUTH_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const tokens = (parsed.tokens ?? {}) as Record<string, unknown>;
      tokens.access_token = s.accessToken;
      tokens.refresh_token = s.refreshToken;
      parsed.tokens = tokens;
      parsed.last_refresh = new Date().toISOString();

      const tmpPath = CODEX_AUTH_PATH + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
      chmodSync(tmpPath, 0o600);
      renameSync(tmpPath, CODEX_AUTH_PATH);
    } catch (err) {
      logger.warn(`codex-auth: failed to write back auth.json: ${err}`);
    }
  }

  async function ensureValid(): Promise<void> {
    if (!state) {
      state = loadAuthFile();
    }
    if (needsRefresh()) {
      // Serialize concurrent refresh calls
      if (!refreshPromise) {
        refreshPromise = doRefresh().finally(() => {
          refreshPromise = null;
        });
      }
      await refreshPromise;
    }
  }

  // Eagerly load to fail fast if auth.json is missing/invalid
  state = loadAuthFile();
  logger.info(
    `codex-auth: loaded credentials for account ${state.accountId}, ` +
    `token expires ${new Date(state.expiresAt * 1000).toISOString()}`
  );

  return {
    async getAccessToken(): Promise<string> {
      await ensureValid();
      return state!.accessToken;
    },

    getAccountId(): string {
      return state!.accountId;
    },

    async forceRefresh(): Promise<void> {
      if (!refreshPromise) {
        refreshPromise = doRefresh().finally(() => {
          refreshPromise = null;
        });
      }
      await refreshPromise;
    },

    reload(): void {
      reloadFromDisk();
    }
  };
}
