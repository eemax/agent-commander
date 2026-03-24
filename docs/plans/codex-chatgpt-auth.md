# Codex ChatGPT OAuth Authentication

## Overview

Add support for authenticating to OpenAI using Codex CLI's ChatGPT OAuth
credentials (`~/.codex/auth.json`) as an alternative to a raw API key. This
lets users who have a ChatGPT Plus/Pro subscription use their subscription
credits instead of paying for separate API usage.

### Key Discovery

ChatGPT OAuth tokens **do not work** with `api.openai.com/v1/responses`.
The server rejects them with `401 Missing scopes: api.responses.write`,
because the OAuth scopes are limited to `openid`, `profile`, `email`,
`offline_access`, `api.connectors.read`, `api.connectors.invoke`.

Codex CLI routes ChatGPT-authenticated requests through a **different
endpoint**:

```
https://chatgpt.com/backend-api/codex/responses
```

This proxy accepts the ChatGPT OAuth access token and enforces three
constraints:
- `stream` must be `true`
- `store` must be `false`
- Model must be a Codex-supported model (e.g. `gpt-5.3-codex`)

The `stream: true` constraint is not a problem — agent-commander already
streams all responses. The `store: false` constraint is also compatible since
we manage our own conversation state via `previous_response_id` chaining
(which still works server-side even without storage).

## Auth flow

```
┌────────────────────┐
│  ~/.codex/auth.json │
│  refresh_token      │
│  account_id         │
└────────┬───────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│  POST https://auth.openai.com/oauth/token  │
│  grant_type=refresh_token                  │
│  refresh_token=<token>                     │
│  client_id=app_EMoamEEZ73f0CkXaXp7hrann   │
│                                            │
│  Response: { access_token, id_token,       │
│              refresh_token, expires_in }   │
└────────┬───────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────┐
│  POST https://chatgpt.com/backend-api/codex/   │
│       responses                                │
│                                                │
│  Headers:                                      │
│    Authorization: Bearer <access_token>        │
│    ChatGPT-Account-Id: <account_id>            │
│    Content-Type: application/json              │
│                                                │
│  Body:                                         │
│    { model, instructions, input, tools,        │
│      stream: true, store: false, ... }         │
└────────────────────────────────────────────────┘
```

### Token lifecycle

| Field           | TTL                         | Notes                                         |
|-----------------|-----------------------------|-----------------------------------------------|
| `access_token`  | ~10 days (`expires_in`)     | JWT with `aud: https://api.openai.com/v1`     |
| `id_token`      | ~1 hour                     | Short-lived, not needed for API calls         |
| `refresh_token` | Long-lived (rotating)       | Each refresh may return a new refresh_token   |
| `account_id`    | Permanent per ChatGPT acct  | Sent as `ChatGPT-Account-Id` header           |

The access token should be refreshed proactively before expiry. Codex itself
refreshes during active use. We should refresh when < 5 minutes remain.

If a refresh returns a new `refresh_token`, we must write it back to
`~/.codex/auth.json` so Codex CLI stays in sync.

## Exact differences between modes

The two auth modes are identical from the tool loop upward. The only
differences are at the transport layer:

| Concern                    | `api_key` mode                              | `codex_chatgpt` mode                                    |
|----------------------------|---------------------------------------------|----------------------------------------------------------|
| **Base URL**               | `https://api.openai.com/v1/responses`       | `https://chatgpt.com/backend-api/codex/responses`        |
| **Auth header**            | `Authorization: Bearer <API_KEY>`           | `Authorization: Bearer <oauth_access_token>`             |
| **Extra header**           | —                                           | `ChatGPT-Account-Id: <account_id>`                       |
| **`store` body field**     | Not set (server default: `true`)            | `false` (required by proxy)                              |
| **Billing**                | OpenAI API usage-based billing              | ChatGPT Plus/Pro subscription credits                    |
| **Allowed models**         | Any model available to your API key         | Codex-supported models only (e.g. `gpt-5.3-codex`)      |
| **Token management**       | Static key, no refresh                      | OAuth refresh via `auth.openai.com/oauth/token`          |

Everything else is unchanged:

| Concern                          | Change? |
|----------------------------------|---------|
| `OpenAIResponsesRequestBody`     | No      |
| `OpenAIResponsesResponse`        | No      |
| `runOpenAIToolLoop`              | No      |
| `parseOpenAIStream` / SSE events | No      |
| `ToolHarness`, tool execution    | No      |
| `previous_response_id` chaining  | No — the chatgpt proxy retains in-flight session state even with `store: false` |
| WebSocket transport lifecycle    | No      |
| `Provider` type signature        | No      |
| `stream: true`                   | No — already hardcoded in `responses-transport.ts:115` for both modes |

The `store: false` field is the **only body-level difference**. It is
required by the chatgpt proxy but does not affect request/response shape or
tool loop behavior. `previous_response_id` chaining continues to work because
the proxy maintains session state for active connections independently of the
`store` flag (which controls long-term persistence, not in-flight memory).

## Implementation

### 1. New file: `src/auth/codex-auth.ts`

Responsible for reading, refreshing, and caching the Codex ChatGPT OAuth
tokens.

```typescript
// ── Types ──────────────────────────────────────────────────────────

export type CodexAuthTokens = {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number;          // unix epoch seconds
};

export type CodexAuthManager = {
  /** Returns a valid access token, refreshing if needed. */
  getAccessToken(): Promise<string>;
  /** Returns the ChatGPT account ID (static). */
  getAccountId(): string;
  /** Force-refresh now (e.g. after a 401). */
  forceRefresh(): Promise<void>;
};

// ── Constants ──────────────────────────────────────────────────────

const CODEX_AUTH_PATH = "~/.codex/auth.json";       // expandHome()
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_MARGIN_SEC = 300;                      // refresh 5min early

// ── auth.json schema ───────────────────────────────────────────────
//
// {
//   "auth_mode": "chatgpt",
//   "OPENAI_API_KEY": null,
//   "tokens": {
//     "id_token": "...",
//     "access_token": "...",
//     "refresh_token": "...",
//     "account_id": "06e4..."
//   },
//   "last_refresh": "2026-03-20T03:30:59.455774Z"
// }

// ── Core logic ─────────────────────────────────────────────────────

export function createCodexAuthManager(
  logger: RuntimeLogger
): CodexAuthManager;
```

**Implementation details:**

- `createCodexAuthManager` reads `~/.codex/auth.json` on first call.
- Decodes the access token JWT to extract `exp` claim (base64url decode of
  payload segment — no crypto verification needed, we're the token holder).
- `getAccessToken()` checks if `now + REFRESH_MARGIN_SEC > expiresAt`. If so,
  calls the refresh endpoint.
- Refresh call:
  ```
  POST https://auth.openai.com/oauth/token
  Content-Type: application/x-www-form-urlencoded

  grant_type=refresh_token
  &refresh_token=<current_refresh_token>
  &client_id=app_EMoamEEZ73f0CkXaXp7hrann
  ```
- On success: update in-memory state, write updated tokens back to
  `~/.codex/auth.json` (atomic write: write to `.tmp`, rename).
- On failure: log error, throw. Caller can fall back to API key if configured.
- Serialize concurrent refresh calls — if a refresh is in-flight, other
  callers await the same promise.

### 2. New config option: `openai.authMode`

Add to the config schema (`src/config.ts` configSchema):

```typescript
authMode: z.enum(["api_key", "codex_chatgpt"]).default("api_key")
```

And to the `Config` type (`src/runtime/contracts.ts`):

```typescript
openai: {
  authMode: "api_key" | "codex_chatgpt";   // ← new
  apiKey: string;                            // existing (may be empty when codex_chatgpt)
  // ... rest unchanged
};
```

When `authMode` is `"codex_chatgpt"`:
- `apiKey` validation is skipped (it can be empty/placeholder).
- The `CodexAuthManager` is created during bootstrap.
- A different base URL and header-building strategy are used by the transports.

**Config resolution in `config.ts`:**

```typescript
// In buildConfigFromParsed(), after resolving secrets:
const authMode = parsed.openai?.authMode ?? "api_key";
if (authMode === "api_key") {
  requireSecret(secrets.openaiApiKey, "OPENAI_API_KEY");
} else {
  // codex_chatgpt — API key not required, verify auth.json exists
  verifyCodexAuthFile();
}
```

### 3. Modify transport: base URL and headers

Both `responses-transport.ts` and `ws-transport.ts` need to use different
URLs and headers when in `codex_chatgpt` mode.

**Approach:** Extract URL and header construction into a shared
`TransportAuth` interface, injected into both transports.

```typescript
// src/provider/transport-auth.ts

export type TransportAuth = {
  /** Base HTTP URL for the responses endpoint. */
  httpUrl: string;
  /** Base WSS URL for the responses endpoint. */
  wssUrl: string;
  /** Build auth headers for a request. May be async (token refresh). */
  getHeaders(): Promise<Record<string, string>>;
  /** Extra body fields to merge into every request. */
  extraBodyFields: Record<string, unknown>;
  /** Called on 401 to attempt recovery before retry. */
  on401?(): Promise<void>;
};
```

**Two implementations:**

```typescript
// API key mode (current behavior)
function createApiKeyTransportAuth(apiKey: string): TransportAuth {
  return {
    httpUrl: "https://api.openai.com/v1/responses",
    wssUrl: "wss://api.openai.com/v1/responses",
    getHeaders: async () => ({
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    }),
    extraBodyFields: {},
  };
}

// Codex ChatGPT mode
function createCodexTransportAuth(
  authManager: CodexAuthManager
): TransportAuth {
  return {
    httpUrl: "https://chatgpt.com/backend-api/codex/responses",
    wssUrl: "wss://chatgpt.com/backend-api/codex/responses",  // if supported
    getHeaders: async () => ({
      "content-type": "application/json",
      authorization: `Bearer ${await authManager.getAccessToken()}`,
      "chatgpt-account-id": authManager.getAccountId(),
    }),
    extraBodyFields: {
      store: false,    // required by chatgpt proxy; not set by current code
      // stream: true is NOT needed here — already hardcoded in
      // responses-transport.ts line 115. WSS strips the field (line 392).
    },
    on401: () => authManager.forceRefresh(),
  };
}
```

### 4. Modify `responses-transport.ts`

**Current code (lines 109-116):**
```typescript
const requestHeaders = {
  "content-type": "application/json",
  authorization: `Bearer ${config.openai.apiKey}`
};
const requestBodyPayload = { ...body, stream: true };
```

**New code:**
```typescript
const requestHeaders = await transportAuth.getHeaders();
const requestBodyPayload = {
  ...body,
  stream: true,
  ...transportAuth.extraBodyFields,
};
```

**URL change (line 25):**
```typescript
// Before:
const url = OPENAI_RESPONSES_URL;
// After:
const url = transportAuth.httpUrl;
```

**401 handling:** In the retry loop, when a 401 is received and
`transportAuth.on401` exists, call it before the next retry attempt.
This triggers a token refresh for Codex auth mode.

The function signature changes:

```typescript
// Before:
export function createResponsesRequestWithRetry(
  config: Config,
  logger: RuntimeLogger,
  deps?: ProviderTransportDeps
): RequestFn;

// After:
export function createResponsesRequestWithRetry(
  config: Config,
  logger: RuntimeLogger,
  transportAuth: TransportAuth,     // ← new
  deps?: ProviderTransportDeps
): RequestFn;
```

### 5. Modify `ws-transport.ts`

Same pattern. The WebSocket URL and auth headers come from `TransportAuth`.

```typescript
// Before (line 123):
const ws = new WsImpl(OPENAI_WS_URL, {
  headers: { authorization: `Bearer ${config.openai.apiKey}` }
});

// After:
const headers = await transportAuth.getHeaders();
const ws = new WsImpl(transportAuth.wssUrl, { headers });
```

**Note:** WebSocket support on the `chatgpt.com` proxy is unconfirmed. If
WSS connections to `chatgpt.com/backend-api/codex/responses` are rejected,
force HTTP+SSE transport when in `codex_chatgpt` mode. This can be done in
the provider by overriding `transportMode` to `"http"` regardless of the
conversation setting. This is a safe default since the HTTP/SSE path is the
primary path and has full feature parity.

The function signature changes:

```typescript
// Before:
export function createWsTransportManager(
  config: Config,
  logger: RuntimeLogger,
  deps?: ProviderTransportDeps
): WsTransportManager;

// After:
export function createWsTransportManager(
  config: Config,
  logger: RuntimeLogger,
  transportAuth: TransportAuth,     // ← new
  deps?: ProviderTransportDeps
): WsTransportManager;
```

### 6. Modify `provider.ts`

Create the `TransportAuth` instance and pass it to both transports.

```typescript
// In createOpenAIProvider():

const transportAuth = config.openai.authMode === "codex_chatgpt"
  ? createCodexTransportAuth(codexAuthManager!)
  : createApiKeyTransportAuth(config.openai.apiKey);

const requestWithRetry = createResponsesRequestWithRetry(
  config, logger, transportAuth, deps
);
const wsManager = createWsTransportManager(
  config, logger, transportAuth, deps
);
```

When `codex_chatgpt` mode: if WSS is unsupported, override transport mode:

```typescript
// In the request() function inside generateReply():
const effectiveTransport =
  config.openai.authMode === "codex_chatgpt" ? "http" : input.transportMode;
```

### 7. Modify `bootstrap.ts`

When `authMode === "codex_chatgpt"`, create the `CodexAuthManager` during
bootstrap and pass it through to the provider.

```typescript
// In bootstrapAgentRuntime():

let codexAuthManager: CodexAuthManager | undefined;
if (config.openai.authMode === "codex_chatgpt") {
  codexAuthManager = createCodexAuthManager(logger);
}

// Pass to createOpenAIProvider() — add optional param
const provider = createOpenAIProvider(config, logger, {
  ...deps,
  codexAuthManager,
});
```

### 8. Modify `env.ts` / secret validation

When `authMode === "codex_chatgpt"`, the `OPENAI_API_KEY` secret is not
required. Adjust `extractAgentSecrets()` and `requireSecret()` calls:

```typescript
// In buildConfigFromParsed():
if (authMode === "api_key") {
  openaiApiKey = requireSecret(secrets.openaiApiKey, envKeyName);
} else {
  openaiApiKey = secrets.openaiApiKey ?? "";  // empty is OK
}
```

## Config example

```jsonc
// config/config.json
{
  "openai": {
    "authMode": "codex_chatgpt",   // ← use ChatGPT subscription
    "model": "gpt-5.3-codex",
    // apiKey not needed in .env when using codex_chatgpt
  }
}
```

## File change summary

| File                                 | Change                                       |
|--------------------------------------|----------------------------------------------|
| `src/auth/codex-auth.ts`            | **New.** Token read/refresh/cache manager.    |
| `src/provider/transport-auth.ts`    | **New.** `TransportAuth` interface + 2 impls. |
| `src/provider/responses-transport.ts`| Accept `TransportAuth`, use for URL/headers.  |
| `src/provider/ws-transport.ts`       | Accept `TransportAuth`, use for URL/headers.  |
| `src/provider.ts`                    | Create `TransportAuth`, pass to transports.   |
| `src/config.ts`                      | Add `authMode` to schema, conditional key validation. |
| `src/runtime/contracts.ts`           | Add `authMode` to `Config.openai`.            |
| `src/runtime/bootstrap.ts`           | Create `CodexAuthManager` when needed.        |
| `src/env.ts`                         | Skip API key requirement for codex_chatgpt.   |

## Risks and mitigations

| Risk                                          | Mitigation                                                |
|-----------------------------------------------|-----------------------------------------------------------|
| `chatgpt.com/backend-api/codex` is undocumented and may change | This is the same endpoint Codex CLI uses; breakage would affect Codex too. Pin to known behavior, add version user-agent. |
| WSS may not be supported on the chatgpt proxy | Default to HTTP+SSE for codex_chatgpt mode. Test WSS during implementation; enable if it works. |
| Refresh token rotation may desync with Codex CLI | Write updated refresh_token back to `auth.json` atomically. Both tools can coexist since they both refresh-then-write. |
| Model restrictions (only Codex models allowed) | Document the restriction. The models in config.json already use `gpt-5.3-codex`. If a non-Codex model is configured, the proxy will return a clear 400 error. |
| Rate limits / credit exhaustion               | The proxy returns `usage_limit_reached` with `resets_at` timestamp. Map to existing retry-policy as a non-retryable error with a clear user message. |
| Token refresh during active request           | Serialize refresh. If a 401 is received mid-stream, the retry loop calls `on401()` to refresh, then retries the request. |

## Testing

1. **Unit:** Mock the token endpoint, verify refresh logic, expiry detection,
   concurrent serialization, auth.json write-back.
2. **Integration:** With a real `~/.codex/auth.json`, make a single streaming
   request to the chatgpt proxy endpoint. Verify SSE events parse correctly
   and the response completes.
3. **E2E:** Full conversation loop with tool calls using codex_chatgpt auth.
   Verify tool loop works identically to api_key mode.
4. **Fallback:** Test 401 → refresh → retry path. Test expired refresh_token
   → clear error message.
