# Agents Handover

## Current Status

- Fork state: hard-forked from platform architecture into minimal runtime.
- Channel: Telegram only.
- Provider: OpenAI only.
- Persistence: JSONL conversations + active-conversation index.
- Entry point: `src/index.ts`.
- Latest refactor checkpoint: runtime composition layer landed (nested config schema, JSONL state store, bounded process buffers, manifest-based workspace refresh, readable app logger).
- Full observability mode: available via `observability.enabled` and `observability.log_path`.

## What Is Stable

- startup validation path
- workspace bootstrap + skill frontmatter validation
- JSONL conversation/session rotation via `/new`
- inbound normalize -> route -> provider -> outbound flow
- local unit/integration test suites for core runtime modules
- JSONL-only state path (SQLite startup cleanup removed)

## Refactor Checkpoint (Current)

- Runtime composition:
  - `src/runtime/bootstrap.ts` is the new composition root.
  - `src/runtime/contracts.ts` defines core runtime interfaces.
- Config redesign:
  - strict nested `config.json` schema validated by Zod.
  - unknown keys fail fast.
- Conversation store redesign:
  - per-conversation append queues and atomic JSON writes for index/settings.
  - bounded LRU-like cache with deterministic eviction and health counters.
- Provider modularization:
  - canonical OpenAI type module used across transport/tool-loop.
  - SSE parser split out from transport.
- Harness/process updates:
  - bounded output buffers with truncation metrics surfaced in `/status`.

## Runbook

1. Install deps: `npm install`
2. Run once to create `config.json`: `npm run dev`
3. Set `telegram.bot_token`, `openai.api_key`, and `access.allowed_sender_ids` in `config.json`
4. Run: `npm run dev`
5. Verify with Telegram message to bot

## Verification Commands

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm test`

Latest checkpoint validation (executed): all four commands pass.

## Known Constraints

- no webhook mode yet (polling runtime)
- no circuit-breaker or provider failover strategy
- no daemonization/restart supervisor inside project
- no feature flag system
- conversation cache assumes single-process, single-writer runtime semantics

## Recommended Next Engineering Tasks

1. Add Telegram integration test harness with a controllable Bot API mock.
2. Add rate-limited periodic health logging for state/workspace/process counters.
3. Add release automation for npm package publication.
