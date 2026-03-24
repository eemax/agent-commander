# Audit Plan: Codex ChatGPT OAuth Authentication

**Commit:** `Add Codex ChatGPT OAuth authentication with mid-conversation switching`
**Scope:** 23 files changed, 526 insertions, 51 deletions (2 new files)

## Objective

Deep audit of the codex auth feature for correctness, security, edge cases, and consistency with existing patterns. The auditor should read every changed file end-to-end and verify each concern below.

---

## 1. Security Audit

### 1.1 Token handling
- [ ] `src/auth/codex-auth.ts`: Verify access tokens and refresh tokens are never logged in plaintext. Check all `logger.info`/`logger.warn` calls — do any leak token values?
- [ ] Verify the JWT decode in `decodeJwtExp()` only reads the `exp` claim and doesn't expose other claims in logs or errors
- [ ] Confirm the refresh token POST body uses `application/x-www-form-urlencoded` (not JSON) — match what the real OAuth endpoint expects
- [ ] Verify `writeBackAuthFile()` uses atomic write (tmp + rename) and doesn't leave partial files on crash
- [ ] Check file permissions: does the tmp file or rewritten auth.json preserve the original file's permissions? Should it restrict to 0600?

### 1.2 Header redaction
- [ ] `src/provider/responses-transport.ts`: Verify `redactHeaders()` catches `chatgpt-account-id` and `authorization` in codex mode logs
- [ ] Check observability events: do any log the full request headers without redaction? Search for `authParams.headers` being passed to observability records

### 1.3 Secret leakage in errors
- [ ] When token refresh fails, does the error message include the refresh token or access token?
- [ ] When a 400/401 is returned, does the logged response body contain token fragments?
- [ ] Check `sanitizeReason()` in sanitize.ts — does it catch Bearer tokens in error messages from the chatgpt proxy?

### 1.4 Config validation
- [ ] `src/config.ts`: When `auth_mode: "codex"`, verify API key is truly optional and not validated
- [ ] Verify a config with `auth_mode: "api"` and no API key still fails (regression check)

---

## 2. Correctness Audit

### 2.1 TransportAuthResolver
- [ ] `src/provider/transport-auth.ts`: Verify both `"api"` and `"codex"` paths return all required fields (`url`, `headers`, `extraBodyFields`, `stripBodyFields`)
- [ ] Verify `on401("api")` is a no-op (doesn't accidentally refresh)
- [ ] Verify `on401("codex")` with `codexAuth: null` doesn't throw

### 2.2 Body field stripping
- [ ] `responses-transport.ts`: Verify `stripBodyFields` removes `prompt_cache_key` and `prompt_cache_retention` for codex mode
- [ ] Verify stripping happens AFTER `extraBodyFields` are merged (order matters if both set a key)
- [ ] `ws-transport.ts`: Same verification for the WebSocket envelope
- [ ] Check that `store: false` is correctly set in codex mode and NOT set in api mode
- [ ] Verify `stream: true` is still present after stripping (it shouldn't be in `stripBodyFields`)

### 2.3 Auth mode threading
- [ ] Trace the full path: `assistant-turn.ts` fetches `authMode` from state → passes to `provider.generateReply()` via `ProviderRequest.authMode` → provider reads it → passes to transport options → transport resolves via `authResolver`
- [ ] Verify `effectiveAuthMode` fallback in `provider.ts` uses `config.openai.authMode` (not hardcoded "api")
- [ ] Verify codex mode forces `effectiveTransport = "http"` (WSS bypass)

### 2.4 Per-chat state
- [ ] `src/state/conversations.ts`: Verify `authMode` is included in `ConversationRuntimeProfile`, `createDefaultRuntimeProfile()`, `cloneRuntimeProfile()`, `normalizeRuntimeProfile()`
- [ ] Verify `normalizeRuntimeProfile()` falls back to `defaults.defaultAuthMode` (not hardcoded "api") for persisted conversations missing the field
- [ ] Verify `authMode` is in `ConversationSwitchRuntime` and both `completeNewSelection` and `completeStashSelection` return it
- [ ] Verify `/new` and `/stash` commands preserve or reset `authMode` correctly

### 2.5 401 retry logic
- [ ] `responses-transport.ts`: Verify the 401+codex recovery only makes `lastFailure.retryable = true` (doesn't skip attempt counting)
- [ ] Verify a 401 in `"api"` mode is still non-retryable (no regression)
- [ ] Verify that after `on401()` refresh, the next retry re-resolves headers via `authResolver.resolve()` (i.e., gets the fresh token, not the stale one)

### 2.6 Token lifecycle
- [ ] `codex-auth.ts`: Verify concurrent `getAccessToken()` calls serialize on a single refresh promise
- [ ] Verify `forceRefresh()` also serializes (doesn't stack with an in-flight `getAccessToken` refresh)
- [ ] Verify the refresh margin is 3600 seconds (1 hour)
- [ ] Verify that after a successful refresh, `expiresAt` is updated from either `expires_in` or JWT decode
- [ ] Verify that if the refresh endpoint returns a new `refresh_token`, it's written back; if it doesn't, the old one is preserved

---

## 3. Edge Case Audit

### 3.1 Missing auth.json
- [ ] Bootstrap with `auth_mode: "codex"` and no `~/.codex/auth.json` → should throw a startup error
- [ ] Bootstrap with `auth_mode: "api"` and no `~/.codex/auth.json` → should log info, `codexAuth = undefined`, continue normally
- [ ] `/auth codex` when `codexAuth` is null → should the command itself check this, or does it only fail on next request? Verify which and whether the UX is acceptable

### 3.2 Malformed auth.json
- [ ] Missing `tokens` key → clear error
- [ ] Missing `access_token` in tokens → clear error
- [ ] Invalid JWT in `access_token` (not 3 segments) → clear error
- [ ] JWT missing `exp` claim → clear error
- [ ] Valid JWT but already expired → should trigger immediate refresh on first `getAccessToken()`

### 3.3 Mid-conversation switching
- [ ] Switch from `api` to `codex` mid-conversation → does `previous_response_id` chaining break? (Different backend won't have the previous response ID)
- [ ] Switch from `codex` to `api` → same concern
- [ ] Switch to `codex` while transport is `wss` → verify transport is forced to `http` AND the state is persisted

### 3.4 Concurrent requests
- [ ] Two chats simultaneously using different auth modes → verify they don't share state (auth resolver is stateless per-call, but CodexAuthManager is shared)
- [ ] Token refresh during an active streaming request → verify the in-flight request uses its already-resolved token, not the refreshed one

---

## 4. Consistency Audit

### 4.1 Pattern compliance
- [ ] Verify `/auth` command follows the exact same pattern as `/transport` in core-commands.ts (args parsing, validation, state set, reply format)
- [ ] Verify `getAuthMode()`/`setAuthMode()` in conversations.ts follow the exact pattern of `getTransportMode()`/`setTransportMode()`
- [ ] Verify `authMode` in `ConversationSwitchRuntime` is positioned consistently with other fields
- [ ] Verify the `CORE_COMMANDS` entry for `auth` follows the format of existing entries

### 4.2 Status display
- [ ] `/status` includes `auth: <mode>` in the settings line
- [ ] `/status full` (diagnostics mode) also shows it
- [ ] `formatConversationDefaults()` includes `auth: <mode>`
- [ ] The ordering in the status line is logical (`transport` before `auth` makes sense since they're related)

### 4.3 Config template
- [ ] `DEFAULT_CONFIG_TEMPLATE` includes `auth_mode: "api"`
- [ ] Zod schema default is `"api"`
- [ ] Config type (`Config.openai.authMode`) matches the Zod output type

### 4.4 Subagent isolation
- [ ] `src/harness/subagent-worker.ts`: Confirm `codexAuth: null` is hardcoded — subagents must not use subscription credits
- [ ] Verify this doesn't break when parent is in codex mode

---

## 5. Test Coverage Audit

### 5.1 Existing test updates
- [ ] `test/helpers.ts`: `makeConfig()` includes `authMode: "api"` in openai config
- [ ] `test/harness.subagent-worker.test.ts`: same
- [ ] `test/provider.responses-transport.test.ts`: all `createResponsesRequestWithRetry` calls include `mockAuthResolver`
- [ ] `test/provider.ws-transport.test.ts`: all `createWsTransportManager` calls include `mockAuthResolver`
- [ ] `test/routing.formatters.test.ts`: `baseParams` includes `authMode` and status line assertion updated

### 5.2 Missing test coverage (recommendations)
- [ ] No unit tests for `CodexAuthManager` — recommend adding tests for: successful refresh, failed refresh, concurrent serialization, expired token detection, malformed JWT handling
- [ ] No unit tests for `TransportAuthResolver` — recommend adding tests for: api mode resolution, codex mode resolution, codex with null manager, on401 behavior
- [ ] No integration test for the `/auth` command — recommend adding to routing tests
- [ ] No test for `stripBodyFields` behavior — recommend verifying prompt_cache fields are removed
- [ ] No test for 401→refresh→retry flow in codex mode

---

## 6. Documentation Audit

- [ ] `docs/plans/codex-chatgpt-auth.md`: Is this still accurate after implementation, or does it describe the pre-implementation plan? Should it be updated or archived?
- [ ] `config/config.json`: Now has `auth_mode: "codex"` as the default — is this intentional for this deployment? Document that this requires `~/.codex/auth.json`

---

## Deliverables

The auditor should produce:
1. A findings document listing issues by severity (critical / high / medium / low / info)
2. Code fixes for any critical or high issues found
3. Recommended test additions for missing coverage (with priority ordering)
