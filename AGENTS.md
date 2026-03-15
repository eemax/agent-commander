# AGENTS.md

Agent Commander is a minimal, single-process Telegram-first AI runtime.

## Constraints (non-negotiable)

- One channel: Telegram (no Discord, Slack, webhooks, etc.)
- One provider: OpenAI Responses API (no Anthropic, no multi-provider)
- One process: foreground Node.js, no daemon/service manager
- JSONL-only persistence: no database, no SQLite
- No plugin/extension system: new capabilities go in core source
- No Docker/container runtime dependencies

## Quick orientation

```
src/index.ts                    CLI entrypoint
src/runtime/bootstrap.ts        Composition root (wires everything)
src/runtime/contracts.ts        Core interfaces (Config, StateStore, WorkspaceCatalog, ProviderTransport)
src/config.ts                   Zod-validated config loading
src/routing.ts                  Message router entry point
src/provider.ts                 OpenAI provider + tool-loop integration
src/agent/tool-loop.ts          Provider-agnostic tool execution loop
src/harness/                    Local trusted tools (bash, files, web)
src/state/conversations.ts      JSONL persistence + LRU cache
src/telegram/bot.ts             grammY bot wiring
src/workspace.ts                Workspace bootstrap + skill loading
~/.agent-commander/             Runtime workspace (AGENTS.md, SOUL.md, skills/)
.agent-commander/               Local state (conversations, logs, snapshots)
```

## Development commands

```bash
npm install          # install deps
npm run dev          # run from TypeScript source
npm run build        # compile to dist/
npm start            # run compiled output
npm run lint         # oxlint
npm run typecheck    # tsc --noEmit
npm test             # vitest run
```

All four checks (lint, typecheck, build, test) must pass before any handoff.

## Config

`config.json` at repo root, strict Zod schema. Required fields:
- `telegram.bot_token`
- `openai.api_key`
- `access.allowed_sender_ids` (at least one real ID)

See `docs/config-reference.md` for the full schema. See `config.example.json` for a working template.

## Message flow

Telegram update → normalize → gatekeep (sender allowlist) → route (command or assistant turn) → provider (OpenAI) → tool loop (if needed) → persist to JSONL → reply via Telegram

## Documentation map

- `docs/README.md` — index of all documentation
- `docs/architecture.md` — system design and component layout
- `docs/config-reference.md` — canonical config.json schema
- `docs/tools.md` — tool harness reference (all tool schemas and behaviors)
- `docs/user-guide.md` — setup, commands, and operational guide
- `docs/contributing.md` — coding standards and scope guardrails
- `docs/changelog.md` — release history and architectural decisions
- `docs/status.md` — current stability, known constraints, next tasks

## Key patterns

- Tool output envelope: `{ ok, summary, data|error, meta? }` — always JSON, always snake_case
- IDs are ULIDs: `conv_<ulid>`, `proc_<ulid>` — lexically time-ordered
- Context injection happens once per conversation (first model turn only)
- Workspace refresh uses manifest hash + mtime to skip no-change rebuilds
- Config unknown keys = hard startup failure (strict schema)
