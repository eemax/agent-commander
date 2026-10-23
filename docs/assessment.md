# Rewrite Assessment: agent-commander-2026-04-08 → agent-commander

Date: 2026-10-06. Reference: `~/agent-commander-2026-04-08` (114 commits, ~22.7k src LOC, ~21.3k test LOC).

## Goal

A smaller runtime with the same product: a Telegram bot with local tools and JSONL state. It runs on **real official SDKs** and uses **OpenRouter** instead of OpenAI.

## The key finding

OpenRouter's official agent SDK, **`@openrouter/agent`** (v0.11.0, Aug 2026, Apache-2.0, built on `@openrouter/sdk` and zod v4), already provides most of the code the reference wrote by hand:

| Reference hand-rolled code | `@openrouter/agent` / OpenRouter feature |
|---|---|
| `agent/tool-loop.ts` and its step limits | `callModel({ tools, stopWhen: [stepCountIs(n), maxCost($)] })` |
| Poll-loop guard and failure breaker | `doomLoop` (observe → steer → block → stop), with a per-tool `loopKey` |
| Per-tool timeouts and abort propagation | `toolTimeoutMs`, `signal`, and `ctx.signal` in each tool |
| `/steer` and `steer-channel.ts` | `result.queueUserMessage(text)`, delivered at the next safe turn boundary |
| Zod → JSON schema, arg normalizer, validation hints | `tool({ inputSchema, outputSchema, execute })` |
| SSE parser, WSS transport, retry policy, request executor | SDK transport, `retryConfig`, and `RequestOptions.timeoutMs` |
| Streaming text deltas and tool notices | `getTextStream()`, `getReasoningStream()`, `getToolCallsStream()`, `getFullResponsesStream()` |
| Usage snapshot | `getResponse().usage` includes **cost** |
| Subagent manager, worker, schemas, tool, log (≈3.1k LOC) | `tool.agent()` child runs, background tasks, and the built-in `task` tool (check/steer/result/cancel) |
| Perplexity `web_search` | `serverTool` → `openrouter:web_search` (auto/native/Exa/Parallel engines) |
| `web_fetch` through the external `defuddle` CLI | `serverTool` → `openrouter:web_fetch` (the "openrouter" engine is free) |
| Custom trace/span observability | Hooks: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostModelCall`, `Stop`, … |
| Conversation persistence (text only) | `StateAccessor { load, save }` holding `ConversationState`: the full item history, status, pending approvals, and async tasks |
| OpenAI server-side compaction | `context-compression` plugin (middle-out). This is weaker; see the open questions. |
| — (new) | `requireApproval` and `awaiting_approval` state for human-in-the-loop checks on dangerous tools |

What the SDK does **not** cover, so we still own it: Telegram UX, the local tools (bash/process/files/rg), the workspace and skills, persistence on disk, config, and the CLI.

## Subsystem verdicts

| Subsystem | Ref LOC | Verdict | Notes |
|---|---:|---|---|
| Provider (HTTP/SSE, WSS, retry, auth modes, Codex OAuth, OpenAI types, usage) | 2,522 | **Delete** | Replaced by one thin `src/agent.ts` wrapper around `callModel` |
| Tool loop, tool output envelope, registry, arg normalizer | 2,743 | **Delete** | The SDK loop plus `tool()`. Keep a tiny `{ok, error}` convention only where it helps the model. |
| Subagents | 3,153 | **Replace** | `tool.agent()` with a scoped tool list. Drop the custom state machine, cursors, and the `[TASK_COMPLETE]` protocol. |
| Web search/fetch | 238 + 2 deps | **Replace** | OpenRouter server tools. Removes the Perplexity SDK, the defuddle CLI, and search presets. |
| Local tools (bash, process, files, patch, glob/grep) | 2,477 | **Keep, slim down** | See "Tools" below |
| Telegram (bot, drafts, transcript, format, split, attachments) | 2,784 | **Keep, redesign** | This is the real product value and the area with the most churn. Port the formatting and splitting logic, and rebuild the streaming state machine more simply. |
| Routing (commands, turn manager, queue, formatters) | 2,745 | **Keep, shrink a lot** | `formatters.ts` (761) and `core-commands.ts` (943) are mostly `/status` polish and removed modes |
| State, context, workspace | 2,462 | **Keep, rebuild on StateAccessor** | `conversations.ts` alone is 1,414 LOC |
| Config, agents, env, contracts, types | 2,030 | **Shrink** | About 70 knobs today. Target about 15. |
| CLI (detached acmd lifecycle) | 1,086 | **Question** | It contradicts the reference's own "foreground only" rule. Cut it, or keep just `start/stop/status`. |
| Observability and logs | 326 + 4 log files | **Collapse** | One JSONL event log fed by SDK hooks, plus stderr |

**Target size: about 4–6k src LOC** (down from ~22.7k).

## What to keep (proven decisions)

- **Product constraints:** Telegram only, one process, JSONL/files only (no database), no plugin system, no Docker.
- **Allowlist gatekeeping**, required for each bot.
- **Workspace model:** `SYSTEM.md` + `AGENTS.md` + `SOUL.md` + `skills/*/SKILL.md` with frontmatter, skills listed in the instructions, and `/<skill>` one-shot invocation. Skills can also load lazily through a `load_skill` tool that uses `nextTurnParams.instructions`, which is the SDK's own pattern.
- **Conversation lifecycle:** `/new`, `/stash <name>`, `/new from` (restore), plus archive and retention.
- **Per-conversation runtime profile:** cwd, model, thinking effort.
- **Message queue in batch mode** while a turn is active, and **`/steer`** (now `queueUserMessage`).
- **Telegram drafts** (`sendMessageDraft` / grammY `replyWithDraft`), markdown → Telegram HTML, HTML-tag-balanced chunking at 4096 characters, inbound images/PDFs/text, and outbound files through the `send-file` skill marker.
- **Tools:** `bash` (with yield → background session), `process` (poll/log/write/kill), `read_file`, `write_file`, `replace_in_file`, `glob`/`grep` through ripgrep.
- **IDs** are prefixed ULIDs. **Config** is strict zod (unknown keys fail startup). **Secrets** come only from `.env`.
- **Engineering bar:** lint, typecheck, build, and test must all pass before handoff.

## What to drop

- **OpenAI-only features:** the Codex/ChatGPT OAuth auth mode, the WSS transport, `previous_response_id` chaining, `/auth`, `/transport`, `/cache`, and `prompt_cache_retention`.
- **Perplexity and `/search` presets.** Search becomes a server tool, with the engine set in config.
- **The `apply_patch` unified-diff/`git apply`/`patch -p0` fallback chain.** Keep `replace_in_file` + `write_file`. Add the Codex `*** Begin Patch` format only if a GPT model needs it.
- **The `arg-normalizer` and hint generation** (SDK zod validation replaces them).
- **`tool_poll_*`, `tool_idle_output_threshold_ms`, `tool_heartbeat_interval_ms`, `tool_failure_breaker_threshold`.** `doomLoop` replaces all four.
- **Four separate logs** (tool-calls, subagents, observability, runtime) and their per-log retention knobs.
- **Context snapshot artifacts** with hash metadata. Optionally keep one debug dump of the compiled instructions.
- **Multi-agent `agents.json`.** Keep it only if more than one bot actually runs. See the open questions.

## What to improve

1. **Real history.** The reference saves only user and assistant *text* and replays the last 20 messages. Tool calls, tool results, and reasoning are lost between turns. `ConversationState.messages` keeps every item. **This is the biggest quality gain.** It requires a context budget: compression plus a summarize-on-threshold step.
2. **Model freedom.** OpenRouter model IDs (`anthropic/…`, `openai/…`, `google/…`). Provider routing and fallback through `models: [...]` and `provider`. Reasoning effort is unified through `reasoning.effort`.
3. **Cost visibility.** `/status` shows $ per turn and per conversation. A `maxCost` stop condition guards each turn.
4. **Prompt caching** uses `sessionId`/`promptCacheKey`, plus `cacheControl` for Anthropic models. Keep `instructions` byte-stable to protect cache hits.
5. **Approvals (optional, new).** `requireApproval` on risky `bash` patterns, resolved with a Telegram inline keyboard and resumed with `approveToolCalls`/`rejectToolCalls`.
6. **Telegram streaming.** The reference had more than 15 commits fixing drafts, typing indicators, and reply assembly. Rebuild it as **one renderer**: (text so far, current tool line, status) → throttled draft. Send the final message from the completed response, not from a reassembled transcript.
7. **Tests.** The reference had about one test LOC per src LOC and many tests were coupled to internals. Instead, write behaviour tests at the seams (Telegram in, tools, persistence round-trip) and use a fake `callModel` or recorded fixtures. Do not test the SDK's loop.
8. **Single seam for the SDK.** Keep every `@openrouter/agent` import in 1–2 files. The SDK is 0.x and the OpenRouter Responses API is still labeled beta, so pin exact versions.

## Proposed layout

```
src/
  main.ts              entry: load config → workspace → bot
  config.ts            zod schema (~15 keys) + .env secrets
  agent.ts             callModel wrapper: model, reasoning, tools, stopWhen, doomLoop, hooks, stream → callbacks
  state.ts             StateAccessor on disk + current/stash/archive index
  workspace.ts         SYSTEM/AGENTS/SOUL + skills catalog
  tools/
    bash.ts process.ts files.ts search.ts (rg) subagent.ts (tool.agent) index.ts
  telegram/
    bot.ts commands.ts stream.ts (draft renderer) format.ts (md→html + split) attachments.ts
  log.ts               one JSONL event sink (hooks feed it)
```

Persistence: `conversations/<chatId>/<convId>.jsonl` stays append-only. `save(state)` appends only the new items since the last save. A small `<convId>.meta.json` holds status, pending approvals, and the profile, and is written atomically. `load()` replays the file. This keeps the reference's JSONL rule while satisfying the SDK's state contract.

## Open decisions

1. **Compaction.** Use OpenRouter's `context-compression` (middle-out) only, or also our own summarization when usage passes N% of the model's context window? Recommended: both. Middle-out is the safety net; summarization handles quality.
2. **Multi-agent (several bots in one process).** Keep it or drop it? It adds deep-merged per-agent config.
3. **Detached CLI (`acmd start/stop/restart`).** Keep it or cut it? Suggested: cut it and document running under launchd, systemd, or tmux.
4. **Subagents.** Default to `tool.agent()`, or drop delegation entirely for v1? The SDK feature is young, so spike it first.
5. **Approvals for bash.** In v1 or later?
6. **MCP.** The SDK ships MCP support, but it conflicts with "no plugin system". Default: no.

## Risks

- `@openrouter/agent` is **0.x** and changes quickly. Pin it and keep it behind `agent.ts`.
- The OpenRouter **Responses API is beta**. Spike it with the target models first (streaming, reasoning, server tools, tool calls).
- Server tools run on OpenRouter: search costs about $0.005/request on Exa or Parallel, and native engines bill at the provider's price. Choose the engine in config.
- Background tasks and agent tools are scoped to a single run (`onRunEnd: drain|detach|cancel`). They do **not** replace our `process` sessions, which must outlive turns.
- `doomLoop` must exempt `process` polling (`loopKey: false`), or it will block legitimate polling.
- Zod v4 is required (the reference used zod 3 + `zod-to-json-schema`).

## Suggested first step

Build a 1-day spike: a `callModel` CLI script with `bash` + `read_file` + `openrouter:web_search`, streaming to stdout, a JSONL `StateAccessor`, `queueUserMessage` steering, and abort. Run it against 2–3 target models (one Anthropic, one OpenAI, one other). If it holds up, port Telegram next, since that is where most of the product value is.

## Sources

- OpenRouter Agent SDK overview: https://openrouter.ai/docs/agent-sdk/overview
- callModel reference: https://openrouter.ai/docs/agent-sdk/call-model
- TS SDK skill reference: https://openrouter.ai/skills/openrouter-typescript-sdk
- Agent SDK tutorial: https://openrouter.ai/blog/tutorials/agent-sdk-with-callmodel/
- Responses API (beta): https://openrouter.ai/docs/responses
- Web search server tool: https://openrouter.ai/docs/guides/features/server-tools/web-search
- Agentic web tools announcement: https://openrouter.ai/blog/announcements/agentic-web-tools/
- Type definitions inspected locally: `@openrouter/agent@0.11.0`
