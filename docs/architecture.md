# Architecture

## Goals

Agent Commander is intentionally small:

- one process
- one entrypoint (`src/index.ts`)
- one channel (Telegram)
- one provider (OpenAI)
- JSONL local state

## Runtime Components

- `src/index.ts`
  Entrypoint delegating to runtime bootstrap.
- `src/runtime/bootstrap.ts`
  Composition root for config/workspace/harness/provider/router wiring, and Telegram startup.
- `src/runtime/contracts.ts`
  Core runtime interfaces (`Config`, `StateStore`, `WorkspaceCatalog`, `RuntimeLogger`, provider transport contracts).
- `src/config.ts`
  Loads strict nested `config.json` via Zod, writes template on missing config, and normalizes path fields.
- `src/workspace.ts`
  Bootstraps `paths.workspace_root` (`AGENTS.md`, `SOUL.md`, and default skill), validates skill frontmatter, builds command catalog, and uses manifest hash + mtime checks to skip no-change refresh rebuilds.
- `src/state/conversations.ts`
  JSONL persistence + current conversation index + stashed active conversations + conversation-scoped runtime profiles + per-conversation append queues + bounded deterministic session cache eviction.
- `src/state/events.ts`
  Typed conversation-event codec for JSONL parse/serialize.
- `src/context.ts`
  Compiles first-turn bootstrap instructions and writes per-conversation context snapshots.
- `src/provider.ts`
  OpenAI provider wiring and tool-loop integration.
- `src/provider/*`
  Provider internals split into history normalization, response text extraction, retry policy, SSE parser, canonical OpenAI type models, and HTTP transport.
- `src/agent/tool-loop.ts`
  Provider-agnostic loop that executes function tool calls and sends native `function_call_output` payloads (`output` is a normalized JSON envelope with `ok`/`summary` and `data|error|meta`), with explicit workflow state transitions, heartbeat progress events, timeout budgets, poll-loop guards, failure breakers, and fail-path cleanup.
- `src/harness/*`
  Local trusted tool harness (`bash`, `process`, `read_file`, `write_file`, `replace_in_file`, `apply_patch`, `web_fetch`, optional `web_search`) with owner-scoped process sessions and shared path utilities. See [tools.md](tools.md) for the full tool reference.
  Exported tool schemas are normalized for OpenAI Responses function tools (`parameters` is always a JSON Schema object root with `type: "object"` and no top-level `anyOf`/`oneOf`/`allOf`/`enum`/`not`).
- `src/routing.ts`
  Router entrypoint wiring, including per-chat turn interruption (new message aborts stale in-flight turn).
- `src/routing/*`
  Routing internals split into gatekeeping, core-command handling, assistant-turn orchestration, and reply formatters.
- `src/telegram/commands.ts`
  Typed command registry + parsing (`/start`, `/new`, `/stash`, `/status` with optional `full` flag, `/cwd`, `/stop`, `/bash`, `/verbose`, `/thinking`, `/cache`, `/model`, `/models`, dynamic skill commands).
- `src/telegram/bot.ts`
  Telegram wiring, command registration sync (`setMyCommands`), text message + callback query dispatch (including inline keyboards and extra verbose replies), and safe error replies.

## End-to-End Message Flow

1. Telegram delivers an update to the bot (text message or callback query).
2. `normalizeTelegramMessage` / `normalizeTelegramCallbackQuery` produce normalized routing payloads.
3. Bot syncs command catalog at startup and on workspace catalog changes.
4. Router checks sender allowlist (`agents.json` → `telegram_allowlist` for the active agent).
5. Router handles command or normal turn:
- Core command (`/new`, `/stash`, `/status`, `/cwd`, `/stop`, `/bash`, `/verbose`, `/thinking`, `/cache`, `/model`, `/models`) handled directly.
- Conversation-menu callbacks are validated and handled via single-use menu tokens.
- Skill command (`/<skill_slug>`) triggers one-shot skill invocation.
- Normal text uses an atomic append+prompt-context read from conversation store and requests provider reply.
6. On first model turn of a conversation, router compiles and injects bootstrap hybrid wrapper+Markdown context and writes a single context snapshot artifact (`.md`) with embedded metadata JSON.
7. Provider may execute local harness tools during tool-loop.
  Tool definitions sent to OpenAI are normalized to function-tool schema requirements (object-root `parameters`, no top-level composite keywords).
8. Router stores assistant reply or provider failure event in conversation JSONL and returns Telegram response.

## Persistence Model

### Stashed conversation pool (`stashed_conversations_path`)

- JSON object mapping `chatId -> stashed conversation list`.
- Each stash entry contains `conversationId`, `alias`, `stashedAt`, and a conversation runtime profile.

### Active conversation index (`active_conversations_path`)

- JSON object mapping `chatId -> current conversation record`.
- Each record contains `conversationId`, optional `alias`, and a conversation runtime profile.
- Runtime profile fields: `workingDirectory`, `verboseMode`, `thinkingEffort`, `cacheRetention`, `activeModelOverride`, `activeWebSearchModelOverride`, `latestUsage`, `toolResults`, `compactionCount`.
- Default filenames are `.agent-commander/stashed-conversations.json` and `.agent-commander/active-conversations.json`.
- No automatic migration is performed from the previous filename layout.

### Conversation events (`conversations_dir/<chatId>/<conversationId>.jsonl`)

- `conversation_created`
- `message` (`role=user|assistant`)
- `provider_failure`
- `conversation_archived`

Conversation events are decoded/encoded through the typed event codec in `src/state/events.ts`.

### Context snapshots (`context_snapshots_dir/<chatId>/<conversationId>.md`)

- Markdown file stores the compiled first-turn context (`<session>`, `<operating_contract>`, `<environment>`, `<reference_documents>`) using wrapper tags with Markdown section bodies.
- Metadata JSON is embedded at EOF in a marker-delimited fenced block (`<!-- acmd:snapshot-metadata:start -->` ... `<!-- acmd:snapshot-metadata:end -->`) and includes AGENTS/SOUL hashes, tool/skill metadata, compiled snapshot path, and instruction hash.

## Error Handling

- Missing/invalid config fails startup.
- Unknown top-level/section config keys fail startup (strict schema).
- Invalid skill frontmatter or slug collisions fail startup.
- Provider failures return deterministic fallback text and persist failure events.
- Telegram middleware errors are logged and return safe internal-error reply.
- Runtime state is JSONL-only; no SQLite cleanup path is part of startup.

## Operational Notes

- Runtime is foreground-only; no daemon/service manager.
- Sender allowlist is mandatory.
- Logs go to stdout/stderr and repo-local app log file (human-readable single-line text).
- Observability JSONL is trace/span-first (`traceId`, `spanId`, `parentSpanId`, `origin`) and records Telegram I/O, routing decisions, state mutations, OpenAI request lifecycle, and tool execution lifecycle.
- No plugin loading path.
