# Config Reference

This is the canonical `config/config.json` shape.

## Notes

- `config/config.json` must exist in the `config/` directory at repo root.
- If missing, runtime writes a template and exits.
- Root shape is strict: unknown keys fail startup.
- Relative paths resolve from repo root.
- `~` expands to the user home directory.
- `.env` remains at repo root (not in `config/`).

## Required Fields

- One Telegram token source:
  - `DEFAULT_TELEGRAM_BOT_TOKEN` in environment/`.env`
- One OpenAI API key source:
  - `DEFAULT_OPENAI_API_KEY` in environment/`.env`
- `config/agents.json` with at least one agent entry (default is auto-created) and per-agent `telegram_allowlist`

## Schema

### `telegram`

- `streaming_enabled`: boolean, default `true` — enables the Telegram draft bubble and streaming callbacks used to build transcript-backed final replies
- `streaming_min_update_ms`: positive integer, default `1000` — minimum interval between non-forced draft-bubble updates
- `draft_bubble_max_chars`: positive integer, default `1500` — reset safety cap for the compact draft bubble; long tool/status runs page when the rendered draft exceeds this size
- `assistant_format`: `"plain_text" | "markdown_to_html"`, default `"plain_text"` — formatting mode for final `reply` messages; `fallback` and `unauthorized` remain plain text
- `max_file_size_mb`: positive float, default `10` — attachment size limit
- `file_download_timeout_ms`: positive integer, default `30000` — timeout for Telegram file downloads
- `max_concurrent_downloads`: positive integer, default `4` — concurrent attachment download limit
- `acknowledged_emoji`: string, default `"off"` — emoji reaction added to the user's message when OpenAI accepts the request. Set to any valid Telegram reaction emoji (e.g. `"👍"`) to enable, or `"off"` to disable

### `openai`

- `auth_mode`: `"api" | "codex"`, default `"api"` — controls authentication mode. `api` uses a standard OpenAI API key (`DEFAULT_OPENAI_API_KEY`). `codex` reads ChatGPT OAuth tokens from `~/.codex/auth.json` and routes requests through `chatgpt.com/backend-api/codex/responses`; the API key is not required in codex mode. Per-conversation override via `/auth api|codex`.
- `model`: non-empty string, default `"gpt-5.4-mini"`
- `models`: non-empty array of model catalog entries, default includes:
  - `gpt-5.4-mini` (alias: `mini`, unknown context window)
  - `gpt-5.3-codex` (aliases: `codex`, `g53c`, context window `400000`)
  - each entry is:
    - `id`: non-empty string
    - `aliases`: string array, default `[]`
    - `context_window`: positive integer or `null` (use `null` when unknown)
    - `max_output_tokens`: positive integer or `null` (status budgeting hint; not sent to Responses API)
    - `default_thinking`: one of `none|minimal|low|medium|high|xhigh`, default `medium`
    - `cache_retention`: `"in_memory" | "24h"`, default `"in_memory"` — prompt cache retention mode used for Responses API `prompt_cache_retention`
    - `compaction_tokens`: positive integer or `null`, default `null` — base token budget for context compaction; `null` disables compaction
    - `compaction_threshold`: number `0.1`–`1`, default `1` — multiplier applied to `compaction_tokens`; the API receives `compact_threshold = floor(compaction_tokens * compaction_threshold)`
  - model IDs are unique (case-insensitive)
  - aliases are unique across all models and cannot collide with another model ID/alias
  - `openai.model` must match one configured `models[].id`
  - `/model <id-or-alias>` applies the selected model's `default_thinking` and `cache_retention` to runtime
  - `/cache <in_memory|24h>` overrides runtime prompt cache retention for the current conversation
  - `/status` uses `context_window` with per-turn usage snapshots to show:
    - `budget`: peak per-call `input / (context_window - max_output_tokens)` when `max_output_tokens` is known and smaller than `context_window` (otherwise `n/a`)
  - `/status full` also reports current-conversation tool-result aggregates (`tool.results_total`, `tool.results_success`, `tool.results_fail`, `tool.results_by_name`) persisted in conversation runtime profiles.
  - when `compaction_tokens` is set for the active model, each Responses API request includes `context_management: [{ type: "compaction", compact_threshold }]`; the server automatically compacts context when rendered tokens cross the threshold
- `timeout_ms`: positive integer, default `45000` — per-request timeout; applies to both HTTP and WebSocket transports
- `max_retries`: non-negative integer, default `2` — HTTP: retry attempts per request; WebSocket: reconnect attempts on connection failure
- `retry_base_ms`: positive integer, default `250` — base delay for exponential backoff (both transports)
- `retry_max_ms`: positive integer, default `2000`, must be `>= retry_base_ms` — max backoff delay (both transports)

- `default_transport`: `"http" | "wss"`, default `"http"` — sets the transport mode for new conversations and any provider path that omits an explicit transport. Per-conversation override via `/transport http|wss`. See [architecture.md](architecture.md#transport-modes) for details.

### `runtime`

- `log_level`: `"debug" | "info" | "warn" | "error"`, default `"info"`
- `prompt_history_limit`: positive integer or `null`, default `20`
  - when set to `null`, the full conversation message history is sent (no count-based truncation)
- `tool_loop_max_steps`: positive integer or `null`, default `30`
- `tool_workflow_timeout_ms`: positive integer, default `120000`
- `tool_command_timeout_ms`: positive integer, default `15000`
- `tool_poll_interval_ms`: positive integer, default `2000`
- `tool_poll_max_attempts`: positive integer, default `5`
- `tool_idle_output_threshold_ms`: positive integer, default `8000`
- `tool_heartbeat_interval_ms`: positive integer, default `5000`
- `tool_cleanup_grace_ms`: positive integer, default `3000`
- `tool_failure_breaker_threshold`: positive integer, default `4`
- `session_cache_max_entries`: positive integer, default `200`
  - maximum in-memory conversation sessions across the current active conversation plus any stashed conversations
  - when `/stash <name>` moves the current conversation into the stash pool, that conversation remains cache-eligible through the transition
  - archived, non-stashed conversations are read from JSONL on demand and are not retained in the session cache
- `message_queue_mode`: `"batch" | "multi_turn"`, default `"batch"`
  - controls how messages sent during an active turn are processed after the turn completes
  - `"batch"`: all queued messages are combined (joined with `\n\n`) and sent as a single follow-up turn
  - `"multi_turn"`: queued messages are fired one at a time, each as its own sequential turn

### `config/agents.json`

- `agents`: array of agent definitions
  - `id`: lowercase identifier
  - `aliases`: string array
  - `config_dir`: path to agent-local config overlay directory
  - `telegram_allowlist`: string array of allowed sender IDs for this bot

### `tools`

- `default_cwd`: string or `null`, default `null` (`null` means `paths.workspace_root`); this is the initial cwd for new conversations and the fallback cwd when no per-conversation override is set
- `default_shell`: non-empty string, default `"/bin/bash"`
- `exec_timeout_ms`: positive integer, default `1800000`
- `exec_yield_ms`: positive integer, default `10000`
- `process_log_tail_lines`: positive integer, default `200`
- `log_path`: path string, default `".agent-commander/tool-calls.jsonl"`
- `completed_session_retention_ms`: positive integer, default `900000`
- `max_completed_sessions`: positive integer, default `50`
- `max_output_chars`: positive integer, default `200000`
- `web_search`: object (optional, defaults shown)
  - API key source: `DEFAULT_PERPLEXITY_API_KEY` (optional)
    - when unset, the `web_search` tool is disabled at startup (warning only; no startup failure)
  - `default_preset`: non-empty string, default `"pro-search"` — active Perplexity preset for search calls
  - `presets`: array of preset catalog entries for web search, default:
    - `fast-search` (alias: `fast`)
    - `pro-search` (alias: `pro`)
    - `deep-research` (alias: `deep`)
    - `advanced-deep-research` (alias: `xdeep`)
    - each entry is:
      - `id`: non-empty string
      - `aliases`: string array, default `[]`

### `paths`

- `workspace_root`: path string, default `"~/.workspace"`
- `conversations_dir`: path string, default `".agent-commander/conversations"`

`conversations_dir` is the storage root for the conversation tree:

- `current/active-conversations.json`
- `current/stashed-conversations.json`
- `current/active/<chatId>/<conversationId>.jsonl`
- `current/stashed/<chatId>/<conversationId>.jsonl`
- `archive/<chatId>/<conversationId>.jsonl`

Context snapshots are stored beside current conversation JSONL files as `<conversationId>.md`; archived conversations do not retain snapshots.

No automatic migration is performed from older layouts. If you need to preserve existing data, move/rename files manually.

### `retention`

- `archived_conversations_max_count`: positive integer or `null`, default `null`
  - when set, keeps only the newest archived conversation JSONL files across the whole agent store
  - current and stashed conversations are never counted toward this cap
- `logs.tool_calls_max_lines`: positive integer or `null`, default `null`
- `logs.subagents_max_lines`: positive integer or `null`, default `null`
- `logs.observability_max_lines`: positive integer or `null`, default `null`
- `logs.runtime_max_lines`: positive integer or `null`, default `null` — caps detached runtime logging in `./.agent-commander/runtime.log`

For each log cap, `null` disables trimming. When enabled, the file keeps only the newest `N` lines after each append/flush.

### `subagents`

- `enabled`: boolean, default `true` — register the subagents tool
- `log_path`: path string, default `".agent-commander/subagents.jsonl"` — append-only audit log for supervisor subagent calls, task events, exchanges, and subagent-internal tool activity
- `default_model`: non-empty string, default `"gpt-5.4-mini"` — model used for subagent inference when not overridden per-task
- `max_concurrent_tasks`: positive integer, default `10` — cap on simultaneous non-terminal tasks
- `default_time_budget_sec`: positive integer, default `900` — per-task time limit
- `default_max_turns`: positive integer, default `30` — per-task turn limit
- `default_max_total_tokens`: positive integer, default `500000` — per-task cumulative token limit
- `default_heartbeat_interval_sec`: positive integer, default `30` — runtime heartbeat period
- `default_idle_timeout_sec`: positive integer, default `120` — idle duration before stall detection
- `default_stall_timeout_sec`: positive integer, default `300` — stall duration before failure
- `default_require_plan_by_turn`: non-negative integer, default `3` — plan checkpoint deadline (0 disables)
- `recv_max_events`: positive integer, default `100` — max events per recv call
- `recv_default_wait_ms`: non-negative integer, default `200` — default long-poll wait
- `await_max_timeout_ms`: positive integer, default `30000` — cap on await timeout

The entire section is optional with defaults; existing config files work without modification. When `enabled` is `false`, the `subagents` tool is not registered.

### `observability`

- `enabled`: boolean, default `false`
- `log_path`: path string, default `".agent-commander/observability.jsonl"`
- `redaction`: object (defaults shown)
  - `enabled`: boolean, default `true`
  - `max_string_chars`: positive integer, default `4000`
  - `redact_keys`: non-empty string array, default:
    - `authorization`
    - `api_key`
    - `token`
    - `secret`
    - `password`
    - `cookie`
    - `set-cookie`

Observability file-write failures are non-fatal; runtime logs a warning once per sink instance and continues.
