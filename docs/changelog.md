# Changelog

Release history and architectural decision log for Agent Commander.

## Releases

### Unreleased

- Added per-model context management (compaction) support via `compaction_tokens` and `compaction_threshold` config fields. When configured, requests to the OpenAI Responses API include `context_management` with the computed `compact_threshold`, enabling automatic server-side context compaction for long conversations.
- Added structured provider failure diagnostics: transport now classifies OpenAI failures into typed detail (`reason`, OpenAI `type/code/param`, `request_id`, `retry_after_ms`, timeout source), final routing failure logs include this detail in `app.log`, fallback text is reason-aware by failure kind, and `/status full` now shows the latest provider failure summary.
- Added `/steer <message>` command for mid-turn instruction injection. Pushes guidance into the active tool loop without aborting the turn; the model receives the steer text as a user message before its next tool-loop iteration. Verbose mode surfaces steer events in Telegram chat.
- Added message queueing during active turns. Normal messages sent while a turn is running are now queued instead of aborting the active turn. Queued messages are processed after the turn completes. Two configurable modes via `runtime.message_queue_mode`: `batch` (default, combines all queued messages into one follow-up turn) and `multi_turn` (fires queued messages one at a time as sequential turns). `/stop` clears the queue.
- Made Telegram bot handlers non-blocking so `/steer` and concurrent messages can be processed during active turns (fire-and-forget IIFE pattern for grammY sequential update processing).

### 0.2.0 — 2026-03-12

- Introduced runtime composition layer (`src/runtime/bootstrap.ts`) and explicit runtime contracts.
- Replaced flat config parsing with strict nested Zod schema (`telegram`, `openai`, `runtime`, `access`, `tools`, `paths`, `observability`).
- Added JSONL state store improvements: per-conversation append queues, atomic index/settings writes, and bounded deterministic session cache eviction.
- Added workspace refresh fast-path using manifest hash + mtime checks to skip full rebuilds on no-change turns.
- Removed per-message Telegram command sync; command sync now runs at startup and on catalog changes only.
- Switched app logger to readable single-line text output.
- Added bounded process output buffers with truncation metrics and exposed runtime health counters via `/status`.
- Extracted OpenAI SSE parser into its own module and unified OpenAI transport/tool-loop types in `src/provider/openai-types.ts`.
- Expanded test coverage for state-store cache eviction, concurrent append ordering, process output truncation, and workspace no-change refresh behavior.

### 0.1.1 — 2026-03-12

- Added native Telegram draft streaming (`sendMessageDraft`) for incremental assistant output updates.
- Added OpenAI Responses SSE parsing with streamed text delta forwarding and `response.completed` materialization.
- Added retry behavior that retries only before streamed partial output begins.
- Added runtime config knobs: `telegram.streaming_enabled` and `telegram.streaming_min_update_ms`.
- Kept final outbound assistant delivery as a normal Telegram message after draft streaming completes.
- Added streaming-focused tests for provider transport, provider callback forwarding, router streaming sink passthrough, and Telegram dispatch draft behavior.

### 0.1.0 — 2026-03-11

- Hard forked from OpenClaw into Agent Commander.
- Replaced CLI/platform runtime with a direct `src/index.ts` boot path.
- Reduced to Telegram-only channel support.
- Reduced to a single provider integration (OpenAI).
- Removed Docker/container runtime paths from active runtime.
- Removed plugin/extension runtime architecture.
- Removed UI/mobile/desktop and workspace fan-out surfaces.
- Replaced CI with a minimal install/lint/typecheck/build/test pipeline.

## Architectural Decision Log

### AD-001: Single-process runtime

- **Status:** Accepted
- **Date:** 2026-03-11
- **Decision:** Runtime is a direct foreground Node.js process.
- **Why:** Lowest operational complexity; easiest local debugging.
- **Consequence:** No daemon/service manager features in-scope.

### AD-002: Telegram-only channel

- **Status:** Accepted
- **Date:** 2026-03-11
- **Decision:** Telegram is the only supported inbound/outbound channel.
- **Why:** Removes multi-channel abstraction cost.
- **Consequence:** Any new channel would be an explicit product expansion.

### AD-003: OpenAI-only provider

- **Status:** Accepted
- **Date:** 2026-03-11
- **Decision:** Provider layer is a narrow OpenAI adapter.
- **Why:** Removes multi-provider orchestration complexity.
- **Consequence:** Provider failover/selection is out-of-scope.

### AD-004: JSONL local state

- **Status:** Accepted
- **Date:** 2026-03-11
- **Decision:** Keep minimal local persistence in repo-local JSONL conversation files.
- **Why:** Durable restart-safe history with low operational overhead and transparent archives.
- **Consequence:** No distributed/shared state semantics.

### AD-005: Config-file-first configuration

- **Status:** Accepted
- **Date:** 2026-03-11
- **Decision:** Configuration uses required repo-root `config.json` with strict startup validation.
- **Why:** Supports user-tinkerable runtime config and deterministic local startup behavior.
- **Consequence:** Missing/invalid config entries are hard startup failures.

### AD-006: No plugin/extension runtime

- **Status:** Accepted
- **Date:** 2026-03-11
- **Decision:** Remove plugin SDK/runtime and extension loading.
- **Why:** Fork goal prioritizes minimality over extensibility.
- **Consequence:** New capability work is done directly in core source.

### AD-007: JSONL-only state path

- **Status:** Accepted
- **Date:** 2026-03-11
- **Decision:** Keep runtime state on JSONL files and remove prior SQLite startup cleanup hooks.
- **Why:** Align runtime behavior with the fork's minimal local-state design and avoid mixed persistence paths.
- **Consequence:** State evolution should happen within JSONL schemas/codecs unless product direction explicitly changes.

## Revisit triggers

Re-open these decisions only if one of the following becomes a hard requirement:

- Multi-tenant deployment across machines
- Additional channels with equal priority to Telegram
- Provider redundancy/SLA requirements
- Third-party extension ecosystem as a product goal
