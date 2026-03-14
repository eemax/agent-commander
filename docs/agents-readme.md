# Agents README

This document is for contributors/agents making code changes.

## Repository Guidelines

### Project Shape

Agent Commander is a minimal runtime:

- Node.js host runtime (no Docker)
- Telegram as the only channel
- OpenAI as the only provider
- JSONL-backed local state
- single process and single entrypoint (`src/index.ts`)

### Structure

- Source: `src/`
- Tests: `test/`
- Docs: `docs/`

### Development Commands

- Install: `npm install`
- Dev run: `npm run dev`
- Build: `npm run build`
- Start built app: `npm start`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Tests: `npm test`

### Coding Rules

- Use TypeScript with strict typing.
- Keep modules small and direct.
- Avoid adding framework-heavy abstractions.
- Do not re-introduce plugin systems, multi-channel registries, daemon managers, or container runtime assumptions.
- Keep config env-driven unless there is a clear need for a config file.

## Scope Guardrails

Keep the project aligned to minimal runtime goals:

- do not add non-Telegram channels
- do not add extra providers by default
- do not reintroduce plugin/runtime extension systems
- do not add Docker/container runtime dependencies
- do not add UI/mobile/desktop app surfaces

## Coding Expectations

- TypeScript strict mode only.
- Keep files small and direct.
- Prefer explicit runtime flow over generic abstraction layers.
- Add tests for behavior changes, not only happy paths.
- Preserve startup failure clarity for missing/invalid config.

## Testing Standard

Before handoff, run:

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm test`

## Change Review Checklist

- Does the change keep one-channel/one-provider constraints?
- Does it add or reduce operational complexity?
- Are `config.json` fields documented in user docs?
- Are failure paths tested?
- Does startup output remain clear and linear?
