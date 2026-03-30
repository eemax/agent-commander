# Agent Commander (acmd)

A minimal, single-process Telegram bot runtime backed by OpenAI with local tool execution and JSONL persistence.

## What it does

- Routes Telegram messages to OpenAI (Responses API with streaming and reasoning)
- Executes local tools: `bash`, `process`, file operations, `web_search`, `web_fetch`
- Persists conversations as append-only JSONL files
- Bootstraps a workspace at `~/.workspace/` for system prompts (`AGENTS.md`, `SOUL.md`) and skills

## Quickstart

```bash
# 1. Install Node.js 22.12+, then:
npm install

# 2. Create .env defaults for credentials
cp .env.example .env
# edit .env:
#    - DEFAULT_TELEGRAM_BOT_TOKEN
#    - DEFAULT_OPENAI_API_KEY
#    - DEFAULT_PERPLEXITY_API_KEY (optional; enables web_search)

# 3. Edit config/agents.json and set per-agent allowlists:
#    - telegram_allowlist (Telegram sender IDs)

# 4. Start in the foreground
npm run dev

# Or build + install the CLI, then run detached
npm run build
npm run link:global   # makes `acmd` available system-wide (once)
acmd start
```

## Telegram commands

| Command | Description |
|---------|-------------|
| `/start` | Start conversation |
| `/new` | Start fresh conversation immediately |
| `/new from` | Restore stashed conversation (inline menu) |
| `/stash <name>` | Archive current conversation under an alias |
| `/stash list` | List archived conversations |
| `/status` | Concise runtime status (model, tokens, budget) |
| `/status full` | Extended diagnostics (tool stats, cache metrics) |
| `/stop` | Graceful shutdown |
| `/bash <cmd>` | Execute shell command in workspace |
| `/cwd <path>` | Set working directory for this conversation |
| `/thinking <level>` | Set reasoning effort (`none\|minimal\|low\|medium\|high\|xhigh`) |
| `/cache <in_memory\|24h>` | Set prompt cache retention mode |
| `/model <id-or-alias>` | Switch active model |
| `/models` | List configured models |
| `/search <id-or-alias>` | Switch web search preset |
| `/transport <http\|wss>` | Switch API transport mode |
| `/auth <api\|codex>` | Switch authentication mode |
| `/steer <message>` | Inject guidance into active tool loop |
| `/<skill_slug>` | One-shot skill invocation |

## Development

```bash
npm run dev          # foreground runtime from TypeScript source
npm run build        # compile to dist/
npm start            # foreground runtime from dist/
acmd help            # lifecycle CLI help
acmd status          # detached runtime status
acmd start           # start detached runtime from dist/
acmd stop            # stop detached runtime
acmd restart         # restart detached runtime
acmd doctor          # offline preflight checks
npm run link:global  # install global acmd CLI
npm run unlink:global
npm run lint         # oxlint
npm run typecheck    # tsc --noEmit
npm test             # vitest run
```

## Documentation

| Document | Audience | Content |
|----------|----------|---------|
| [AGENTS.md](AGENTS.md) | AI agents | Bootstrap context, constraints, file map |
| [docs/](docs/README.md) | Everyone | Documentation index |
| [docs/architecture.md](docs/architecture.md) | Developers | System design and message flow |
| [docs/config-reference.md](docs/config-reference.md) | Everyone | Full config/config.json schema |
| [docs/telegram/architecture.md](docs/telegram/architecture.md) | Developers | Telegram transport deep dive, transcript-backed final replies, and outbound chunking |
| [docs/telegram/draft-streaming-and-final-reply.md](docs/telegram/draft-streaming-and-final-reply.md) | Developers | Draft reset semantics, transcript assembly, formatting, and chunking details |
| [docs/tools.md](docs/tools.md) | Developers | Tool harness reference |
| [docs/subagents.md](docs/subagents.md) | Developers | Subagent lifecycle, inheritance, and observability |
| [docs/user-guide.md](docs/user-guide.md) | Users | Setup, commands, observability, troubleshooting |

## License

MIT
