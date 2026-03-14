# Agent Commander (acmd)

Agent Commander is a Telegram-first agent runtime with:

- one process on Node.js
- one provider (OpenAI)
- local trusted tool harness (`bash`, `process`, file/patch tools, optional `web_search` via Perplexity)
- JSONL conversation/session persistence
- workspace bootstrap at `~/.agent-commander/` for `AGENTS.md`, `SOUL.md`, and skills

## Quickstart

1. Install Node.js 22.12+.
2. Install dependencies:

```bash
npm install
```

3. Create `config.json` in repo root from the tracked template:

```bash
cp config.example.json config.json
```

4. Edit `config.json` and set at minimum:

- `telegram.bot_token`
- `openai.api_key`
- `access.allowed_sender_ids` (non-empty)

5. Run again:

```bash
npm run dev
```

## Core Runtime Behavior

- Conversations are per chat and persisted in repo-local JSONL files under `.agent-commander/conversations/`.
- Current conversation selection (and its runtime profile) is persisted in `.agent-commander/active-conversations.json`.
- Stashed conversations are persisted in `.agent-commander/stashed-conversations.json`.
- No automatic migration is performed from the previous filename layout; existing files are ignored unless moved manually.
- `/new` opens an inline menu; the current conversation is archived when a menu option is selected.
- `/stash <name>` stashes the current conversation under an alias, then switches to a selected stash or a new conversation.
- `/stash list` lists stashed conversations (alias, conversation tail, relative stash age).
- `/bash` runs in `paths.workspace_root` by default unless `tools.default_cwd` is set.
- `/bash` uses `/bin/bash` by default (configurable via `tools.default_shell`).
- `/verbose on|off` toggles model tool-call trace messages in Telegram for the current conversation.
- Tool workflows are guarded by default with bounded timeouts, polling limits, heartbeat progress, loop breakers, and fail-path cleanup.
- Tool-loop `function_call_output` payloads use native Responses format with a normalized envelope: `ok`, `summary`, `data` or `error`, and optional `meta` (snake_case, noise omitted).
- `/thinking <none|minimal|low|medium|high|xhigh>` sets OpenAI reasoning effort for the current conversation.
- `/model <id-or-alias>` switches the active model for the current conversation and applies that model's configured default thinking effort.
- `/models` lists configured models, aliases, and active selection.
- On the first model turn of each conversation, runtime injects hybrid wrapper+Markdown context sections:
  `<session>`, `<operating_contract>`, `<environment>`, and `<reference_documents>`.
- Context snapshots are written as a single `.md` file containing compiled context plus embedded JSON metadata.
- Skills expose direct Telegram commands via folder-derived slugs (for example `skills/test-skill` -> `/test_skill`).
- Skill commands are one-shot invocations (active for that request only).
- App runtime logs are human-readable text lines in `.agent-commander/app.log`.
- Optional full observability mode writes detailed runtime traces (Telegram I/O, routing, conversation events, OpenAI requests/responses, and tool outputs) to JSONL when `observability.enabled` is set to `true`.

## Built-in Telegram Commands

- `/start`
- `/new`
- `/stash <name>`
- `/stash list`
- `/status`
- `/status full` (extended diagnostics)
- `/stop`
- `/bash <command>`
- `/verbose <on|off>`
- `/thinking <none|minimal|low|medium|high|xhigh>`
- `/model <id-or-alias>`
- `/models`
- `/<skill_slug>` for each workspace skill

`/status` now shows a concise emoji summary by default (including running process count). Use `/status full` for detailed runtime diagnostics including tool workflow counters and current-conversation tool-result totals (`tool.results_total`, `tool.results_success`, `tool.results_fail`, `tool.results_by_name`). For budget context math, configure `openai.models[].max_output_tokens`.

## Commands

- `npm run dev` - run from TypeScript source
- `npm run build` - compile runtime source to `dist/`
- `npm start` - run compiled runtime
- `npm run link:global` - install `acmd` into global npm bin
- `npm run unlink:global` - remove global `acmd` link
- `npm test` - run tests
- `npm run lint` - lint source
- `npm run typecheck` - type-check without emit

## Full Observability (Opt-In)

Set these optional `config.json` keys when you need exhaustive runtime tracing:

- `observability.enabled` (default: `false`)
- `observability.log_path` (default: `.agent-commander/observability.jsonl`)
- `observability.redaction.enabled` (default: `true`)
- `observability.redaction.max_string_chars` (default: `4000`)
- `observability.redaction.redact_keys` (default includes `authorization`, `api_key`, `token`, `secret`, `password`, `cookie`, `set-cookie`)
- `telegram.streaming_enabled` (default: `true`)
- `telegram.streaming_min_update_ms` (default: `100`)
- `telegram.assistant_format` (default: `plain_text`; set `markdown_to_html` to enable Telegram HTML formatting for final assistant replies)

This mode uses a trace-first event schema (v2) and emits correlated `traceId`/`spanId` envelopes across Telegram, routing, provider, state, and tool events. v1 observability event names are removed. Redaction/truncation is configurable via `observability.redaction.*`.
When observability is enabled, tool workflow progress is streamed via Telegram drafts (independent of verbose mode), including short workflows.
If JSONL appends fail, runtime emits a warning once per sink instance and continues without crashing.

## Documentation

- `docs/architecture.md`
- `docs/config-reference.md`
- `docs/agents-log.md`
- `docs/agents-handover.md`
- `docs/agents-readme.md`
- `docs/user-guide.md`
