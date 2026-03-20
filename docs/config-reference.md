# Config Reference

This is the canonical `config.json` shape.

## Notes

- `config.json` must exist at repo root.
- If missing, runtime writes a template and exits.
- Root shape is strict: unknown keys fail startup.
- Relative paths resolve from repo root.
- `~` expands to the user home directory.

## Required Fields

- One Telegram token source:
  - `DEFAULT_TELEGRAM_BOT_TOKEN` in environment/`.env`
- One OpenAI API key source:
  - `DEFAULT_OPENAI_API_KEY` in environment/`.env`
- `agents.json` with at least one agent entry (default is auto-created) and per-agent `telegram_allowlist`

## Schema

### `telegram`

- `streaming_enabled`: boolean, default `true`
- `streaming_min_update_ms`: positive integer, default `100`
- `assistant_format`: `"plain_text" | "markdown_to_html"`, default `"plain_text"`

### `openai`

- `model`: non-empty string, default `"gpt-4.1-mini"`
- `models`: non-empty array of model catalog entries, default includes:
  - `gpt-4.1-mini` (alias: `mini`, unknown context window)
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

Transport mode (`http` or `wss`) is a per-conversation runtime setting, not a config field. Switch with `/transport http|wss`. See [architecture.md](architecture.md#transport-modes) for details.

### `runtime`

- `log_level`: `"debug" | "info" | "warn" | "error"`, default `"info"`
- `prompt_history_limit`: positive integer or `null`, default `20`
  - when set to `null`, the full conversation message history is sent (no count-based truncation)
- `default_verbose`: boolean, default `true` (applied to newly created conversations)
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
- `app_log_flush_interval_ms`: positive integer, default `1000`
- `message_queue_mode`: `"batch" | "multi_turn"`, default `"batch"`
  - controls how messages sent during an active turn are processed after the turn completes
  - `"batch"`: all queued messages are combined (joined with `\n\n`) and sent as a single follow-up turn
  - `"multi_turn"`: queued messages are fired one at a time, each as its own sequential turn

### `agents.json`

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
- `completed_session_retention_ms`: positive integer, default `3600000`
- `max_completed_sessions`: positive integer, default `500`
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

- `workspace_root`: path string, default `"~/.agent-commander"`
- `conversations_dir`: path string, default `".agent-commander/conversations"`
- `stashed_conversations_path`: path string, default `".agent-commander/stashed-conversations.json"` (stash pool)
- `active_conversations_path`: path string, default `".agent-commander/active-conversations.json"` (current active selection)
- `context_snapshots_dir`: path string, default `".agent-commander/context-snapshots"`
- `app_log_path`: path string, default `".agent-commander/app.log"`

No automatic migration is performed from the previous filename layout. If you need to preserve existing data, move/rename files manually.

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
