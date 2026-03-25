# Status

Non-obvious operational details, external constraints, and known gotchas.

## External Service Constraints

### Codex proxy (`chatgpt.com/backend-api/codex/responses`)

- **Undocumented endpoint.** Same one Codex CLI uses — breakage there would surface first.
- **Requires `store: false`** in every request body. Server doesn't persist responses to disk, only in connection-local memory. If the connection drops, `previous_response_id` references are lost.
- **SSE without content-type header.** The proxy omits `content-type: text/event-stream`. The transport falls back to body-peeking (`/^\s*(?:event|data):/m`) to detect SSE format. Fragile if the proxy ever changes response shape.
- **Only Codex-supported models.** Using an API-key model (e.g. `gpt-5.4-mini`) against the codex proxy returns 400. Must use `gpt-5.3-codex` or equivalent.
- **OAuth scope is proxy-only.** ChatGPT tokens cannot authenticate against `api.openai.com/v1/responses` (rejected with "Missing scopes: api.responses.write"). No fallback to public API.

### OpenAI WebSocket

- **60-minute server-enforced connection limit.** We rotate at 55 minutes proactively. In-flight requests defer rotation until completion, so a long tool loop can exceed 55 min on one socket.
- **Auth fingerprint controls socket reuse.** Fingerprint = adapter ID + URL + sorted headers. Token refresh changes the fingerprint, forcing reconnect — so codex mode reconnects roughly every hour (refresh margin).

## Authentication Gotchas

### Token refresh timing

`REFRESH_MARGIN_SEC = 3600` — tokens are refreshed **1 hour** before expiry, not the 5 minutes the design doc originally specified. This is conservative but means frequent refreshes during extended sessions.

### Concurrent refresh serialization

Multiple `getAccessToken()` calls during an in-flight refresh all await the same promise. If the refresh hangs (network), all callers block. No independent timeout on the refresh promise — only the HTTP-level timeout applies.

### `~/.codex/auth.json` shared state

Both Codex CLI and agent-commander read/write this file. Atomic writes (`.tmp` + rename) reduce corruption, but concurrent writes can desync refresh tokens (last writer wins). If agent-commander writes and then crashes, Codex CLI may have stale tokens on next start.

### Disk write failures are non-fatal

If auth.json can't be written after a successful refresh, the error is logged as a warning. In-memory state is fine, but next process restart uses the old (possibly expired) tokens from disk.

### Reload skipped during refresh

`reload()` checks for an in-flight refresh and silently skips if one is active (logged as warning). New tokens from disk won't be adopted until the current refresh completes.

## Stateless Tool Loop (Codex Mode)

- **History cap: 200 items** beyond initial input (`MAX_STATELESS_HISTORY_ITEMS`). Older items are dropped — long tool loops lose early context.
- **Response IDs are stripped** before accumulating history. The codex proxy doesn't persist IDs with `store: false`, so referencing them later would 404.
- **Subagent pause/resume** persists `accumulatedInput` instead of `previous_response_id`. Losing the accumulated input breaks multi-step subagent tasks.

## Tool Loop Guards

- **Failure breaker:** N consecutive identical failures (same tool + args + error code) abort the loop. Threshold is `runtime.tool_failure_breaker_threshold` (default 4). Slightly different args reset the counter, so the model can get stuck in near-identical error spirals.
- **Workflow timeout checked between iterations**, not mid-request. Actual wall-clock time can exceed the configured timeout by one full request duration (up to `openai.timeout_ms`).
- **Poll guard:** Detects infinite `process poll`/`process log` loops via output fingerprinting. Max `tool_poll_max_attempts` consecutive unchanged polls or `tool_idle_output_threshold_ms` of unchanged output. Fast-polling processes with repeating output patterns can trigger false positives.

## Operational Notes

- **Auth mode switch clears context.** Switching `/auth` mid-conversation is effectively a reset — stateful (API) and stateless (codex) modes are incompatible, so history doesn't carry over.
- **No nested subagents.** `subagents` tool is excluded from the scoped harness — max delegation depth is 1.
- **Subagent CWD is static.** Inherited from supervisor at spawn time, fixed for the task lifetime. Does not track supervisor CWD changes.
- **Telegram message split at 4096 chars.** Code blocks may be broken across splits. Structure is preserved best-effort but not perfectly.
- **SSE stream without `response.completed` throws hard.** Network drops mid-stream result in `SyntaxError`, not a retryable failure. The tool loop surfaces this as a provider failure and aborts.
