# Architecture

## Goals

Agent Commander is intentionally small:

- one process
- one entrypoint (`src/index.ts`)
- one channel (Telegram)
- one provider (OpenAI)
- JSONL local state

## Runtime Components

### Boot

- `src/index.ts`
  Entrypoint delegating to runtime bootstrap.
- `src/runtime/bootstrap.ts`
  Composition root for config/workspace/harness/provider/router wiring, and Telegram startup.
- `src/runtime/contracts.ts`
  Core runtime interfaces (`Config`, `StateStore`, `WorkspaceCatalog`, `RuntimeLogger`, provider transport contracts).
- `src/config.ts`
  Loads strict nested `config/config.json` via Zod, writes template on missing config, and normalizes path fields.

### Shared

- `src/types.ts`
  Core TypeScript types: prompt roles, thinking effort levels, cache retention, and Telegram message/callback structures.
- `src/utils.ts`
  Shared utility functions (`isPlainObject`, `asRecord`, `normalizeNonEmptyString`, type guards for `ThinkingEffort`/`CacheRetention`).
- `src/catalog-utils.ts`
  Generic `createCatalogResolver<T>()` factory for ID/alias-based catalog lookup, used by model and web-search catalogs.
- `src/agents.ts`
  Multi-agent manifest loading, per-agent config merging (`deepMerge`), and bot-token uniqueness validation.
- `src/model-catalog.ts`
  OpenAI model catalog entries and resolver (thin wrapper over `catalog-utils`).
- `src/web-search-catalog.ts`
  Web search preset catalog entries and resolver (thin wrapper over `catalog-utils`).

### State

- `src/state/conversations.ts`
  JSONL persistence + current conversation index + stashed active conversations + conversation-scoped runtime profiles + per-conversation append queues + bounded session cache eviction limited to current/stashed conversations.
- `src/state/events.ts`
  Typed conversation-event codec for JSONL parse/serialize.
- `src/context.ts`
  Compiles first-turn bootstrap instructions and writes per-conversation context snapshots.
- `src/workspace.ts`
  Bootstraps `paths.workspace_root` (`AGENTS.md`, `SOUL.md`, and default skill), loads `config/SYSTEM.md` from the config directory, validates skill frontmatter, builds command catalog, and uses manifest hash + mtime checks to skip no-change refresh rebuilds.

### Provider

- `src/provider.ts`
  OpenAI provider wiring and tool-loop integration. Selects HTTP or WebSocket transport based on the conversation's `transportMode` setting.
- `src/provider/responses-transport.ts`
  HTTP+SSE transport. Each tool-loop turn is an independent `POST /v1/responses` with `stream: true`. Retry logic with exponential backoff.
- `src/provider/ws-transport.ts`
  WebSocket transport. Maintains one persistent `wss://api.openai.com/v1/responses` socket per active WS conversation (`chatId → WsConnection` map). Sends `response.create` messages; receives the same streaming event types as SSE. See **Transport Modes** below.
- `src/provider/sse-parser.ts`
  SSE event parser for the HTTP transport. Exports `parseCompletedPayload()` which is reused by the WS transport.
- `src/provider/sanitize.ts`
  Shared `sanitizeReason()` for whitespace normalization, Bearer/API-key redaction, and length truncation of provider failure reasons.
- `src/provider/auth-mode-contracts.ts`
  `AuthModeAdapter` interface defining per-mode policy: capabilities (allowed transports, stateless flag), availability checks, request resolution (URL, headers, body rules), and 401 recovery hooks. Also exports `buildResolvedRequestBody()` for applying adapter body rules.
- `src/provider/auth-mode-registry.ts`
  Static registry mapping `AuthMode → AuthModeAdapter`. Provides `normalizeTransport()` to validate requested transport against mode capabilities.
- `src/provider/auth-modes/api.ts`
  API key adapter: standard `api.openai.com/v1/responses` endpoint, `Bearer` auth header, stateful tool loop (`previous_response_id` chaining).
- `src/provider/auth-modes/codex.ts`
  Codex ChatGPT adapter: `chatgpt.com/backend-api/codex/responses` endpoint, OAuth token + `ChatGPT-Account-Id` headers, stateless tool loop (accumulates full history), strips cache/response-id fields, adds `store: false`. Reloads credentials from `~/.codex/auth.json` on each turn.
- `src/provider/request-executor.ts`
  Composes the auth mode registry with HTTP and WebSocket transports. Handles `onTurnStart` credential reload, transport normalization, and 401 recovery delegation.
- `src/auth/codex-auth.ts`
  Token lifecycle manager for Codex ChatGPT OAuth. Reads `~/.codex/auth.json`, proactively refreshes tokens (1-hour margin), serializes concurrent refreshes, and writes updated tokens back to disk atomically.
- `src/provider/*`
  Remaining provider internals: history normalization, response text extraction, retry policy, and canonical OpenAI type models.

### Agent

- `src/agent/tool-loop.ts`
  Provider-agnostic loop that executes function tool calls and sends native `function_call_output` payloads (`output` is a normalized JSON envelope with `ok`/`summary` and `data|error|meta`), with explicit workflow state transitions, heartbeat progress events, timeout budgets, poll-loop guards, failure breakers, and fail-path cleanup.
- `src/agent/model-tool-output.ts`
  Per-tool result normalization into a standard envelope. Organized by section: bash, process (dispatch map), file, patch, web.

### Harness

- `src/harness/*`
  Local trusted tool harness (`bash`, `process`, `read_file`, `write_file`, `replace_in_file`, `apply_patch`, `web_fetch`, optional `web_search`, optional `subagents`) with owner-scoped process sessions and shared path utilities. See [tools.md](tools.md) for the full tool reference.
  Exported tool schemas are normalized for OpenAI Responses function tools (`parameters` is always a JSON Schema object root with `type: "object"` and no top-level `anyOf`/`oneOf`/`allOf`/`enum`/`not`).
- `src/harness/subagent-*.ts`
  Managed subagent task system: typed event protocol with explicit state transitions, turn ownership, budget enforcement (turns/tokens/time), heartbeat-based liveness tracking, plan enforcement, and approval policies. `SubagentManager` is the stateful core (like `ProcessManager`); `subagent-tool.ts` exposes 7 actions (`spawn`, `recv`, `send`, `inspect`, `list`, `cancel`, `await`) via a discriminated-union tool. `SubagentWorker` drives real LLM inference via `runOpenAIToolLoop` with a scoped tool harness (all supervisor tools except `subagents`), inheriting the supervisor's per-conversation CWD. See [subagents.md](subagents.md) for the full reference.

### Routing

- `src/routing.ts`
  Router entrypoint wiring, delegating turn lifecycle to `TurnManager`.
- `src/routing/turn-manager.ts`
  Per-chat turn lifecycle: begin/release/abort turns, latest-turn tracking, and per-chat message queues.
- `src/routing/*`
  Routing internals split into gatekeeping, core-command handling, assistant-turn orchestration, and reply formatters.

### Telegram

- `src/telegram/commands.ts`
  Typed command registry + parsing (`/start`, `/new`, `/new from`, `/stash`, `/status` with optional `full` flag, `/cwd`, `/stop`, `/bash`, `/thinking`, `/cache`, `/model`, `/models`, `/search`, `/transport`, `/auth`, `/steer`, dynamic skill commands).
- `src/telegram/bot.ts`
  Telegram wiring, command registration sync (`setMyCommands`), text message + callback query dispatch (including inline keyboards and extra replies), and safe error replies.
- `src/telegram/text-dispatch.ts`
  Telegram reply UX coordinator for streaming drafts, reactions, transcript-backed final assembly, outbound ordering, and stale-turn suppression.
- `src/telegram/stream-transcript.ts`
  Ordered local transcript used to render resettable draft bubbles and assemble final `reply`/`fallback` text without duplicate trailing answers.
- `src/telegram/outbound.ts`
  Outbound reply preparation and chunk dispatch, including assistant-format selection and Telegram-safe splitting.
- `src/telegram/assistant-format.ts`
  Markdown/HTML rendering for assistant replies, preserving visible blank lines between block-level elements.
- `src/telegram/message-split.ts`
  Final-send chunk splitting with Telegram size limits and HTML tag balancing.

## End-to-End Message Flow

1. Telegram delivers an update to the bot (text message or callback query).
2. `normalizeTelegramMessage` / `normalizeTelegramCallbackQuery` produce normalized routing payloads.
3. Bot syncs command catalog at startup and on workspace catalog changes.
4. Router checks sender allowlist (`config/agents.json` → `telegram_allowlist` for the active agent).
5. Router handles command or normal turn:
- Core command (`/new`, `/new from`, `/stash`, `/status`, `/cwd`, `/stop`, `/bash`, `/thinking`, `/cache`, `/model`, `/models`, `/search`, `/transport`, `/auth`, `/steer`) handled directly.
- Conversation-menu callbacks are validated and handled via single-use menu tokens.
- Skill command (`/<skill_slug>`) triggers one-shot skill invocation.
- Normal text uses an atomic append+prompt-context read from conversation store and requests provider reply.
6. On first model turn of a conversation, router compiles and injects bootstrap hybrid wrapper+Markdown context and writes a single context snapshot artifact (`.md`) with embedded metadata JSON.
7. Provider may execute local harness tools during tool-loop.
  Tool definitions sent to OpenAI are normalized to function-tool schema requirements (object-root `parameters`, no top-level composite keywords).
8. Router stores assistant reply or provider failure event in conversation JSONL and returns a `MessageRouteResult` to Telegram dispatch.
9. Telegram dispatch renders the final draft state, assembles transcript-backed final text for `reply`/`fallback`, then formats, chunks, and sends Telegram replies/files/keyboard.

## Persistence Model

### Stashed conversation pool (`stashed_conversations_path`)

- JSON object mapping `chatId -> stashed conversation list`.
- Each stash entry contains `conversationId`, `alias`, `stashedAt`, and a conversation runtime profile.

### Current conversation tree (`conversations_dir/current`)

- `active-conversations.json` maps `chatId -> current conversation record`.
- Each record contains `conversationId`, optional `alias`, and a conversation runtime profile.
- Runtime profile fields: `workingDirectory`, `thinkingEffort`, `cacheRetention`, `transportMode`, `authMode`, `activeModelOverride`, `activeWebSearchModelOverride`, `latestUsage`, `toolResults`, `compactionCount`, `lastProviderFailure`.
- `stashed-conversations.json` maps `chatId -> stashed conversation list`.
- Active conversation JSONL files live under `current/active/<chatId>/<conversationId>.jsonl`.
- Stashed conversation JSONL files live under `current/stashed/<chatId>/<conversationId>.jsonl`.
- No automatic migration is performed from the previous filename layout.

### Archived conversation tree (`conversations_dir/archive`)

- Archived conversation JSONL files live under `archive/<chatId>/<conversationId>.jsonl`.
- Optional retention can prune the oldest archived conversations globally after each archive move.

### Conversation events

- `conversation_created`
- `message` (`role=user|assistant`)
- `provider_failure`
- `conversation_archived`

Conversation events are decoded/encoded through the typed event codec in `src/state/events.ts`. Malformed JSONL lines (e.g. from a crash mid-write) are skipped with a warning rather than failing the entire load.

### Context snapshots

- Markdown file stores the compiled first-turn context (`<system>`, `<operating_contracts>` with SOUL and AGENTS contracts, `<available_skills>`) as raw markdown inside XML wrapper tags.
- Metadata JSON is embedded at EOF in a marker-delimited fenced block (`<!-- acmd:snapshot-metadata:start -->` ... `<!-- acmd:snapshot-metadata:end -->`) and includes SYSTEM/AGENTS/SOUL hashes, tool/skill metadata, compiled snapshot path, and instruction hash.
- Snapshots are stored beside current conversation JSONL files and are moved between `current/active` and `current/stashed` with the conversation. Archived conversations do not keep snapshots.

## Auth Modes

The provider supports two authentication modes, selected via `openai.auth_mode` config or per-conversation via `/auth`. Each mode is a self-contained adapter implementing `AuthModeAdapter` (defined in `src/provider/auth-mode-contracts.ts`), registered in a static registry (`src/provider/auth-mode-registry.ts`).

### API mode (`api`, default)

- Endpoint: `https://api.openai.com/v1/responses` (HTTP), `wss://api.openai.com/v1/responses` (WSS)
- Auth: `Authorization: Bearer <API_KEY>`
- Stateful tool loop: uses `previous_response_id` to chain turns
- Supports both HTTP and WebSocket transports

### Codex mode (`codex`)

- Endpoint: `https://chatgpt.com/backend-api/codex/responses` (HTTP and WSS)
- Auth: `Authorization: Bearer <oauth_access_token>` + `ChatGPT-Account-Id: <account_id>`
- Credentials: read from `~/.codex/auth.json` (Codex CLI format), reloaded on each turn
- Token refresh: proactive (1-hour margin) via `https://auth.openai.com/oauth/token`, serialized, atomic write-back
- Stateless tool loop: accumulates full conversation history (no `previous_response_id`), strips cache fields, adds `store: false`
- Supports both HTTP and WebSocket transports

### Request execution

`src/provider/request-executor.ts` composes the auth registry with both transports. On each turn: calls `adapter.onTurnStart()` (credential reload for codex), normalizes the requested transport against the adapter's capabilities, then dispatches to HTTP or WebSocket.

## Transport Modes

The provider supports two transport modes for communicating with the OpenAI Responses API. Both use the same request body, tool loop, and streaming callbacks — the difference is purely at the network layer.

### HTTP+SSE (default unless `openai.default_transport` is `"wss"`)

- Each tool-loop turn is an independent `POST https://api.openai.com/v1/responses` with `stream: true`.
- Server streams back SSE events (`response.output_text.delta`, `response.completed`, `error`).
- Parsed by `sse-parser.ts` (buffered line-oriented SSE framing → JSON dispatch).
- Has its own retry loop with exponential backoff (`max_retries`, `retry_base_ms`, `retry_max_ms`).
- Stateless between turns — no persistent connection.

### WebSocket

- A single persistent `wss://api.openai.com/v1/responses` connection per conversation.
- Authenticated via `Authorization: Bearer` header at connection time (Node 22+ WebSocket).
- Each tool-loop turn sends a JSON message: `{ "type": "response.create", model, input, tools, ... }`.
- The `stream` and `background` fields are **not** included (they are HTTP-transport-specific).
- Server streams back the same event types as SSE, but as raw JSON WebSocket messages (no SSE framing).
- `response.completed` resolves the request; `error` rejects it.
- The WS transport has no per-request retry loop. Instead, it manages connection lifecycle:
  - **Reconnect on failure**: exponential backoff using the same `retry_base_ms`/`retry_max_ms`/`max_retries` config, applied at the connection level.
  - **Proactive rotation**: connections are closed and re-established after 55 minutes (OpenAI enforces a 60-minute limit).
  - **Idle cleanup**: connections with no requests for 5 minutes are closed.
  - **Mid-request failure**: if the socket drops during an in-flight request, the promise rejects with `ProviderError(kind: "network")` — the tool loop surfaces it as a provider failure.
- One socket per `chatId`. Concurrent WS conversations use separate sockets.
- **Message serialization**: `onmessage` processing is serialized via a promise chain so async `onTextDelta` callbacks (which include Telegram draft throttling) execute sequentially. This matches the SSE path's natural `for await` serialization and prevents concurrent delta handlers from bypassing the time-based draft throttle, which would flood the Telegram API with edit requests.

### Switching

- Per-conversation: `/transport http` or `/transport wss` (stored in `ConversationRuntimeProfile.transportMode`).
- Default is `openai.default_transport` (falls back to `http`). Resets to the configured default on `/new` or `/stash` (new conversation = fresh runtime profile).
- Auth-triggered reconnect: when the auth mode or credentials change mid-conversation, the WebSocket transport detects the change via a full-header fingerprint and opens a new socket. The fingerprint covers all auth headers (including `chatgpt-account-id`), so account switches also trigger reconnection.
- Visible in `/status` output on the settings line.
- The WS transport manager is lazily created on first WS request — zero overhead for HTTP-only usage.

### When to use WebSocket

OpenAI reports up to ~40% lower end-to-end latency for agentic workloads with many tool calls, because the server caches response state in connection-local memory across turns on the same socket. The benefit scales with the number of tool-call round trips in a single conversation.

Trade-offs:
- **`store=true` (default)**: responses are persisted server-side. Reconnects can continue `previous_response_id` chains because the server has a persisted copy.
- **`store=false` / ZDR**: responses exist only in connection-local cache. If the socket drops, `previous_response_id` references may fail with `previous_response_not_found`.

### Transport abstraction

Both transports return `{ payload: OpenAIResponsesResponse; attempt: number }`. The `request` callback in `runOpenAIToolLoop` is transport-agnostic — it receives a response payload regardless of how it was fetched. Selection happens in `src/provider.ts` based on `input.transportMode`.

## Error Handling

- Missing/invalid config fails startup.
- Unknown top-level/section config keys fail startup (strict schema).
- Invalid skill frontmatter or slug collisions fail startup.
- Provider failures return safe reason-aware fallback text, persist failure events, and emit structured provider diagnostics to `app.log`.
- Telegram middleware errors are logged and return safe internal-error reply.
- Runtime state is JSONL-only; no SQLite cleanup path is part of startup.

## Operational Notes

- Runtime is foreground-only; no daemon/service manager.
- Sender allowlist is mandatory.
- Logs go to stdout/stderr and repo-local app log file (human-readable single-line text).
- Observability JSONL is trace/span-first (`traceId`, `spanId`, `parentSpanId`, `origin`) and records Telegram I/O, routing decisions, state mutations, OpenAI request lifecycle, and tool execution lifecycle.
- No plugin loading path.
