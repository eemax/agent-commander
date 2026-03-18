# Project Status

Current stability, known constraints, and recommended next steps.

## Current state

- **Fork state:** hard-forked from platform architecture into minimal runtime
- **Channel:** Telegram only
- **Provider:** OpenAI only
- **Persistence:** JSONL conversations + active-conversation index
- **Entry point:** `src/index.ts`
- **Latest checkpoint:** runtime composition layer (nested config schema, JSONL state store, bounded process buffers, manifest-based workspace refresh, readable app logger)
- **Observability:** available via `observability.enabled`

## What is stable

- Startup validation path
- Workspace bootstrap + skill frontmatter validation
- JSONL conversation/session rotation via `/new`
- Inbound normalize → route → provider → outbound flow
- Local unit/integration test suites for core runtime modules
- JSONL-only state path (SQLite startup cleanup removed)

## Refactor checkpoint (v0.2.0)

- **Runtime composition:** `src/runtime/bootstrap.ts` is the composition root; `src/runtime/contracts.ts` defines core interfaces
- **Config:** strict nested `config.json` schema validated by Zod; unknown keys fail fast
- **Conversation store:** per-conversation append queues, atomic JSON writes, bounded LRU cache with deterministic eviction
- **Provider:** canonical OpenAI type module across transport/tool-loop; SSE parser split out
- **Harness:** bounded output buffers with truncation metrics surfaced in `/status`

## Runbook

```bash
npm install                          # 1. install deps
npm run dev                          # 2. first run creates config.json template
# create .env with DEFAULT_TELEGRAM_BOT_TOKEN and DEFAULT_OPENAI_API_KEY
# edit config.json: set access.allowed_sender_ids
npm run dev                          # 3. start runtime
# verify with a Telegram message to the bot
```

## Verification

```bash
npm run lint
npm run typecheck
npm run build
npm test
```

All four pass at latest checkpoint.

## Known constraints

- No webhook mode (polling only)
- No circuit-breaker or provider failover
- No daemonization/restart supervisor
- No feature flag system
- Conversation cache assumes single-process, single-writer semantics

## Recommended next tasks

1. Add Telegram integration test harness with a controllable Bot API mock
2. Add rate-limited periodic health logging for state/workspace/process counters
3. Add release automation for npm package publication
