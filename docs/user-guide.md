# User Guide

## What Agent Commander Does

Agent Commander is a Telegram bot runtime that routes messages to OpenAI, can execute local harness tools, and persists chat sessions as JSONL files.

## Prerequisites

- Node.js 22.12+
- Telegram bot token from BotFather
- OpenAI API key

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` defaults:

```bash
cp .env.example .env
```

Set:

- `DEFAULT_TELEGRAM_BOT_TOKEN`
- `DEFAULT_OPENAI_API_KEY`
- `DEFAULT_PERPLEXITY_API_KEY` (optional, enables `web_search`)

3. Edit `config/agents.json` and fill required fields:

- `telegram_allowlist` for each agent

## Run

Development mode:

```bash
npm run dev
```

Build + run compiled output:

```bash
npm run build
npm start
```

Global CLI link (makes `acmd` available from anywhere):

```bash
npm run link:global
```

## Workspace Bootstrap

On startup, runtime ensures workspace at `paths.workspace_root` (default `~/.agent-commander/`) contains:

- `AGENTS.md`
- `SOUL.md`
- `skills/` directory

Additionally, `config/SYSTEM.md` (in the repo `config/` directory) is loaded if present and injected as the first context section.

If no skills exist yet, startup seeds `skills/test-skill/SKILL.md` as a sample.

Every `SKILL.md` must start with YAML frontmatter containing:

- `name`
- `description`

Startup fails if frontmatter is missing/invalid, slug generation is invalid, or skill command slugs collide with core commands.

## Conversation Persistence

- Current conversation per chat is tracked in `paths.active_conversations_path` (default `.agent-commander/active-conversations.json`).
- Stashed conversations per chat are tracked in `paths.stashed_conversations_path` (default `.agent-commander/stashed-conversations.json`).
- Conversation events are JSONL files in `paths.conversations_dir/<chatId>/<conversationId>.jsonl`.
- Conversation runtime profiles persist `verboseMode`, `thinkingEffort`, `cacheRetention`, `transportMode`, `authMode`, `activeModelOverride`, `latestUsage`, `toolResults`, `compactionCount`, and `lastProviderFailure`.
- `/new` immediately creates a fresh conversation (archiving the current one) and displays conversation defaults.
- `/new from` opens an inline menu to restore a stashed conversation or start fresh.
- `/stash <name>` stashes current conversation under an alias, then switches to selected stash or a new conversation.
- `/stash list` shows stashed conversations with alias, conversation tail, and relative stash age.
- No automatic migration is performed from the previous filename layout; move/rename old files manually if you want to keep prior state.
- New conversation and process session IDs are ULID-based (`conv_<ulid>`, `proc_<ulid>`), so they are lexically time-ordered.
- Runtime app logs are written as human-readable single-line text to `paths.app_log_path`.

## Context Injection

At the first model turn of each conversation, runtime injects:

- `<system>` — raw content from `config/SYSTEM.md` (omitted if file is empty or missing)
- `<operating_contracts>` containing:
  - `<contract name="SOUL.md" kind="behavior_spec">` — raw `SOUL.md` content (no heading-to-XML conversion)
  - `<contract name="AGENTS.md" kind="agent_spec">` — raw `AGENTS.md` content
- `<available_skills>` — each skill wrapped in `<skill name="..." path="...">`

Compiled snapshots are written to `paths.context_snapshots_dir` per conversation as a single `<conversationId>.md` file containing the compiled hybrid context with embedded JSON metadata (delimited by `<!-- acmd:snapshot-metadata:start -->` / `<!-- acmd:snapshot-metadata:end -->` markers).

## Telegram Commands

Core commands:

- `/start`
- `/new` (immediate fresh conversation)
- `/new from` (restore stashed conversation menu)
- `/stash <name>`
- `/stash list`
- `/status`
- `/status full` (extended diagnostics)
- `/cwd <absolute-path>`
- `/stop`
- `/bash <command>`
- `/verbose <full|count|off>`
- `/thinking <none|minimal|low|medium|high|xhigh>`
- `/cache <in_memory|24h>`
- `/model <id-or-alias>`
- `/models`
- `/search <id-or-alias>`
- `/transport <http|wss>`
- `/auth <api|codex>`
- `/steer <message>`

`/auth <api|codex>` switches the authentication mode for the current conversation. `api` uses a standard OpenAI API key; `codex` uses ChatGPT OAuth tokens from `~/.codex/auth.json`. Fails immediately if the selected mode's credentials are unavailable. Persisted in the conversation runtime profile.

`/steer <message>` injects guidance into an active tool loop without aborting the turn. The steer text is added as a user message before the model's next tool-loop iteration. When verbose mode is on, steer events appear in Telegram chat as `🎯 Steer: <message>`. If no turn is active, `/steer` returns an error.

`/new` immediately archives the current conversation and starts fresh, displaying conversation defaults (model, search model, thinking, cwd, cache, transport).
`/new from` and `/stash <name>` open Telegram inline-button menus listing stashed conversations plus `New`.
`/stash list` returns a text list of stashes without opening a menu.
Menus are single-use; stale callback clicks are rejected and require reopening the menu command.

`/model <id-or-alias>` switches the active model and applies that model's configured defaults to runtime thinking effort and cache retention.

`/cache <in_memory|24h>` switches prompt cache retention mode for the current conversation.
`/transport <http|wss>` switches the API transport for the current conversation. Default is set by `openai.default_transport` config (falls back to `http`). See [architecture.md](architecture.md#transport-modes) for details on each mode.
`/cwd <absolute-path>` sets the working directory for the current conversation. New conversations start with the configured default cwd.

`/status` returns the model/runtime emoji summary block (model, latest turn token usage including reasoning tokens, budget context-window pressure summary, prompt-cache hit metrics, runtime thinking/verbose mode, running process count, and active cwd).
Use `/status full` to include observability state and runtime health counters for process output truncation, tool-result aggregates, running/completed processes, and state/workspace counters:
- `tool.results_total`
- `tool.results_success`
- `tool.results_fail`
- `tool.results_by_name` (for example `Write=10, Bash=1`)
- `provider.last_failure_kind`
- `provider.last_failure_status`
- `provider.last_failure_attempts`
- `provider.last_failure_at`
- `provider.last_failure_reason`
The context denominator comes from `openai.models[].context_window` for the active model.
Status context summary:
- `budget`: peak per-call `input / (context_window - max_output_tokens)` when `openai.models[].max_output_tokens` is set and less than `context_window` (otherwise `n/a`)
Latest usage/cache metrics are persisted in the current conversation runtime profile, so status survives process restarts.
For tool-loop turns, usage is aggregated across all Responses API calls in that turn.

For model-facing tool workflow payloads, each `function_call_output.output` is a JSON-serialized normalized envelope:
- success: `{\"ok\": true, \"summary\": \"...\", \"data\": { ... }, \"meta\": { ... }? }`
- failure: `{\"ok\": false, \"summary\": \"...\", \"error\": { \"code\": \"...\", \"message\": \"...\", \"details\": { ... }?, \"retryable\": boolean? }, \"meta\": { ... }? }`
Normalization rules:
- `summary` is always present.
- `data` exists only for success, `error` exists only for failure.
- fields are snake_case.
- empty/noise fields are omitted (for example empty `stderr`, zero truncation counters).
These payloads are intended for model context, not user-facing Telegram replies.

When verbose mode is on, model-triggered tool calls are surfaced in Telegram. With draft streaming enabled, the live draft bubble keeps the tool/status chronology but collapses assistant text into a compact preview instead of streaming the whole answer verbatim. Those tool notices are still preserved in the final transcript-backed `reply`/`fallback` message. When streaming is unavailable, they may still be emitted as extra Telegram replies before the main final reply. Failed tool calls use `⚠️` and include a short error summary.
Workflow-progress events (`tool.workflow.progress`) are recorded to the observability JSONL log when `observability.enabled` is `true`, but are not surfaced in Telegram (no draft streaming or extra replies). Check `observability.log_path` directly for workflow diagnostics.

## Message Queueing

When a normal (non-command) message is sent while a turn is active, it is queued instead of aborting the running turn. The bot acknowledges with `Message queued (N pending)`.

After the active turn completes, queued messages are processed according to `runtime.message_queue_mode`:

- **`batch`** (default): All queued messages are combined (joined with double newline) and sent as a single follow-up turn.
- **`multi_turn`**: Queued messages are fired one at a time, each as its own sequential turn.

`/stop` aborts the active turn **and** clears all pending queued messages.
`/steer <message>` is not queued — it injects directly into the active tool loop.

Dynamic commands:

- `/<skill_slug>` for each workspace skill folder (one-shot invocation)

## Access Control

All incoming messages are authorized by sender ID only.
Senders not listed in the active agent's `telegram_allowlist` receive deterministic unauthorized replies.

## Key `config/config.json` Fields

For the full canonical list (all keys, types, defaults, and validation rules), see `docs/config-reference.md`.

Required:

- `DEFAULT_TELEGRAM_BOT_TOKEN`
- `DEFAULT_OPENAI_API_KEY`
- `config/agents.json` → `telegram_allowlist`

Common optional fields:

- `openai.model` (default `gpt-5.4-mini`)
- `openai.models` (catalog of switchable models with aliases and optional `context_window`, `max_output_tokens`, `default_thinking`, and `cache_retention`)
- `runtime.log_level` (`debug|info|warn|error`)
- `openai.auth_mode` (`api|codex`, default `api`)
- `openai.default_transport` (`http|wss`, default `http`)
- `runtime.default_verbose` (default `"full"`, applied to new conversations)
- `telegram.streaming_enabled` (default `true`)
- `telegram.streaming_min_update_ms` (default `1000`)
- `telegram.draft_bubble_max_chars` (default `1500`, reset safety cap for the compact draft bubble)
- `telegram.draft_preview_max_sentences` (default `3`, maximum number of sentence-like units kept in the assistant-text preview within the draft bubble)
- `telegram.draft_preview_max_chars` (default `280`, hard character cap for that assistant-text preview)
- `telegram.assistant_format` (`plain_text` by default, `markdown_to_html` to enable Markdown->HTML formatting for final assistant replies; `fallback`/`unauthorized` stay plain text)
- `telegram.acknowledged_emoji` (default `"off"`, set to an emoji like `"👍"` to react to messages when OpenAI accepts the request)
- `observability.enabled` (default `false`)
- `observability.log_path` (default `.agent-commander/observability.jsonl`)
- `observability.redaction.enabled` (default `true`)
- `observability.redaction.max_string_chars` (default `4000`)
- `observability.redaction.redact_keys` (default `authorization, api_key, token, secret, password, cookie, set-cookie`)
- `paths.workspace_root`
- `tools.default_cwd` (default: `paths.workspace_root`, usually `~/.agent-commander/`; used as the initial cwd for new conversations)
- `tools.default_shell` (default: `/bin/bash`)
- `paths.conversations_dir`
- `paths.stashed_conversations_path`
- `paths.active_conversations_path`
- `paths.context_snapshots_dir`
- `paths.app_log_path`
- Runtime/tool knobs (`runtime.*`, `tools.*`, and `openai.*` retry/timeout settings)
  - recommended guardrails are enabled by default:
    - `runtime.tool_workflow_timeout_ms` (default `120000`)
    - `runtime.tool_command_timeout_ms` (default `15000`)
    - `runtime.tool_poll_max_attempts` (default `5`)
    - `runtime.tool_idle_output_threshold_ms` (default `8000`)
    - `runtime.tool_heartbeat_interval_ms` (default `5000`)
    - `runtime.tool_cleanup_grace_ms` (default `3000`)

## Full Observability Mode

Breaking change:
- Observability event names and payload shapes now use the v2 trace-first schema.
- v1 event names are removed (no dual-write compatibility layer).

When `observability.enabled` is `true`, runtime appends detailed JSONL trace entries to `observability.log_path` for:

- `runtime.startup`
- `telegram.inbound.received`
- `telegram.outbound.draft.sent`
- `telegram.outbound.draft.failed`
- `telegram.outbound.reply.sent`
- `telegram.processing.failed`
- `telegram.middleware.failed`
- `routing.gatekeeping.checked`
- `routing.decision.made`
- `conversation.event.appended`
- `runtime.setting.updated`
- `provider.openai.request.started`
- `provider.openai.request.completed`
- `provider.openai.retry.scheduled`
- `provider.openai.request.failed_final`
- `tool.execution.completed`
- `tool.workflow.progress`
- `provider.ws.connected`
- `provider.ws.disconnected`
- `provider.ws.connection.idle_closed`
- `provider.ws.connection.reconnecting`
- `provider.ws.event.received`
- `provider.ws.request.started`
- `provider.ws.request.completed`
- `subagent.task.spawned`
- `subagent.task.state_change`
- `subagent.task.terminal`
- `subagent.supervisor.sent`
- `subagent.worker.question`
- `subagent.worker.result`
- `subagent.budget.warning`

Notes:

- Every event includes a trace envelope: `trace.traceId`, `trace.spanId`, `trace.parentSpanId`, `trace.origin`.
- Redaction/truncation is enabled by default via `observability.redaction.*`.
- If trace-file append fails, runtime logs a warning once per sink instance and continues processing.
- The trace file is append-only with no built-in size cap or rotation.

## Troubleshooting

### Startup fails: missing/invalid config

Check `config/config.json` exists, `.env` is present at repo root (or environment variables are exported), and credentials are non-placeholder values.

### Unauthorized responses

Ensure Telegram sender ID is present in the active agent's `telegram_allowlist`.

### Provider errors (4xx/5xx)

Verify `DEFAULT_OPENAI_API_KEY`, model name, and account quota/limits.
If observability is disabled, check `paths.app_log_path` for the structured final failure line (`reason`, OpenAI `type/code/param`, and `request_id`).

### OpenAI 400: invalid_function_parameters

If OpenAI returns an error like:

`Invalid schema for function 'process': schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'not' at the top level.`

the function tool `parameters` schema is not compliant. OpenAI Responses function tools require `parameters` to be a JSON Schema object root (`type: "object"`) and reject those keywords at the top level. Agent Commander normalizes exported tool schemas to a top-level object shape and flattens union-style roots into object properties.

### Skill command not available

Check `SKILL.md` frontmatter and command slug validity.

## Upgrade Workflow

1. Pull latest changes.
2. Run `npm install`.
3. Re-run validation commands:
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm test`
4. Restart process.
