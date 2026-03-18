# Contributing

Guidelines for contributors and AI agents making code changes to Agent Commander.

## Project shape

Agent Commander is a minimal runtime — read [AGENTS.md](../AGENTS.md) for the non-negotiable constraints. In short: one process, one channel (Telegram), one provider (OpenAI), JSONL state, no plugins.

## Repository layout

```
src/           Source code (TypeScript strict mode)
test/          Vitest test suite
docs/          Documentation
config.json    Runtime config (tracked; contains no secrets)
```

## Development commands

```bash
npm install        # install dependencies
npm run dev        # run from TypeScript source
npm run build      # compile to dist/
npm start          # run compiled output
npm run lint       # oxlint
npm run typecheck  # tsc --noEmit
npm test           # vitest run
```

## Coding rules

- TypeScript strict mode only
- Keep modules small and direct
- Prefer explicit runtime flow over generic abstraction layers
- Do not add framework-heavy abstractions
- Do not re-introduce plugin systems, multi-channel registries, daemon managers, or container runtime assumptions

## Scope guardrails

Do not:
- Add non-Telegram channels
- Add extra providers by default
- Reintroduce plugin/runtime extension systems
- Add Docker/container runtime dependencies
- Add UI/mobile/desktop app surfaces

## Testing expectations

- Add tests for behavior changes, not only happy paths
- Test failure paths
- Preserve startup failure clarity for missing/invalid config

## Pre-handoff checklist

All four must pass:

```bash
npm run lint
npm run typecheck
npm run build
npm test
```

## Change review checklist

- Does the change stay within one-channel/one-provider constraints?
- Does it add or reduce operational complexity?
- Are new `config.json` fields documented in `docs/config-reference.md`?
- Are failure paths tested?
- Does startup output remain clear and linear?
