# Codex ChatGPT OAuth Authentication — Audit Findings

**Audited:** 2026-03-24
**Scope:** Commit `2042bfa` — 23 files changed, 526 insertions, 51 deletions
**Audit plan:** `docs/audits/codex-chatgpt-auth-audit.md`

---

## Critical

### C1. `chatgpt-account-id` not redacted in observability logs

**Location:** `src/provider/responses-transport.ts:32`
**Description:** `redactHeaders()` used regex `/authorization|api[-_]?key/i` which does not match the `chatgpt-account-id` header. This header, containing the ChatGPT account identifier, was passed unredacted to observability records at line 137.
**Impact:** Account ID leaks to any configured observability sink in codex mode.
**Fix applied:** Added `chatgpt-account-id` to the redaction regex.

### C2. Token refresh error body not sanitized

**Location:** `src/auth/codex-auth.ts:108-111`
**Description:** On refresh failure, up to 200 chars of the HTTP response body were included in the thrown error without sanitization. If the OAuth endpoint returned token fragments in error responses, they would propagate to `logger.warn` at `responses-transport.ts:298`.
**Impact:** Potential token exposure in logs from misconfigured or misbehaving OAuth endpoints.
**Fix applied:** Added inline Bearer token redaction to the error text before inclusion in the error message.

---

## High

### H1. No file permissions enforced on auth.json write-back

**Location:** `src/auth/codex-auth.ts:148-150`
**Description:** `writeFileSync` created the temp file with default permissions (typically 0644), making OAuth tokens world-readable on shared systems. The `renameSync` preserved those permissive defaults.
**Impact:** Refresh tokens and access tokens readable by other users on multi-user systems.
**Fix applied:** Added `chmodSync(tmpPath, 0o600)` after `writeFileSync` and before `renameSync`.

### H2. JWT decode throws unclear errors on invalid base64

**Location:** `src/auth/codex-auth.ts:75-76`
**Description:** Invalid base64 in the JWT payload caused `Buffer.from` or `JSON.parse` to throw generic errors (e.g. "Unexpected end of JSON input") instead of the clear "not a valid JWT" message.
**Impact:** Confusing error messages; potential for token content in stack traces.
**Fix applied:** Wrapped base64 decode + JSON parse in try/catch with clear error: "access_token JWT payload is not valid base64/JSON".

### H3. Bearer token regex misses `=` padding characters

**Location:** `src/provider/sanitize.ts:6`
**Description:** Pattern `/Bearer\s+[A-Za-z0-9._-]+/gi` did not include `=` in the character class. Base64-padded tokens like `Bearer eyJ...9==` would be partially redacted to `Bearer [REDACTED]==`, leaking padding characters.
**Impact:** Minor token metadata leakage (padding length reveals token size modulo 3).
**Fix applied:** Added `=` to character class: `[A-Za-z0-9._\-=]+`.

---

## Medium

### M1. No unit tests for CodexAuthManager or TransportAuthResolver

**Location:** Test coverage gap
**Description:** No test files existed for `src/auth/codex-auth.ts` or codex-specific paths in `src/provider/transport-auth.ts`. Error paths (malformed JWT, failed refresh, concurrent serialization) were completely untested.
**Fix applied:** Added `test/auth.codex-auth.test.ts` (12 tests) and `test/provider.transport-auth.test.ts` (11 tests).

---

## Verified Correct (no action needed)

| Check | Location | Status |
|-------|----------|--------|
| Refresh POST uses `application/x-www-form-urlencoded` | `codex-auth.ts:95-104` | Correct |
| Refresh margin is 3600s (1 hour) | `codex-auth.ts:25` | Correct |
| Concurrent refresh serialized via shared promise | `codex-auth.ts:162-168` | Correct |
| `forceRefresh()` uses same serialization | `codex-auth.ts:189-194` | Correct |
| New refresh_token written back; old preserved if absent | `codex-auth.ts:121,129` | Correct |
| Atomic write (tmp + rename) for auth.json | `codex-auth.ts:148-150` | Correct |
| `stripBodyFields` runs after `extraBodyFields` merge | `responses-transport.ts:114-121` | Correct |
| `store: false` only in codex mode | `transport-auth.ts:38` | Correct |
| `stream: true` preserved (not in strip list) | `responses-transport.ts:116` | Correct |
| Subagents hardcode `codexAuth: null` | `subagent-worker.ts:207` | Correct |
| 401 retry re-resolves headers (fresh token) | `responses-transport.ts:112` | Correct |
| `on401("api")` is a safe no-op | `transport-auth.ts:55-58` | Correct |
| `on401("codex")` with null manager doesn't throw | `transport-auth.ts:56` | Correct |
| Config default template has `"api"` | `config.ts:27` | Correct |
| Zod schema default is `"api"` | `config.ts:180` | Correct |
| `/auth` command follows `/transport` pattern | `core-commands.ts:751-790` | Correct |
| `authMode` in ConversationRuntimeProfile | `conversations.ts:37` | Correct |
| `normalizeRuntimeProfile` falls back to config default | `conversations.ts:301` | Correct |
| `authMode` propagated through conversation switching | `conversations.ts:1284,1358` | Correct |
| `/status` displays auth mode | `formatters.ts:555` | Correct |
| Codex mode forces transport to `http` | `provider.ts:124` | Correct |
| `effectiveAuthMode` uses config fallback (not hardcoded) | `provider.ts:122` | Correct |

---

## Files Modified

| File | Change |
|------|--------|
| `src/provider/responses-transport.ts` | Added `chatgpt-account-id` to header redaction regex |
| `src/auth/codex-auth.ts` | Sanitized refresh error body, added `chmodSync(0o600)`, hardened JWT decode |
| `src/provider/sanitize.ts` | Added `=` to Bearer token regex character class |
| `test/auth.codex-auth.test.ts` | New — 12 tests for CodexAuthManager |
| `test/provider.transport-auth.test.ts` | New — 11 tests for TransportAuthResolver |
