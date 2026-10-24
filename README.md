# agent-commander (acmd)

A minimal, single-process Telegram agent. It runs on [OpenRouter](https://openrouter.ai) through the official `@openrouter/agent` SDK and has one local tool, `bash`, plus OpenRouter's server-side web search and fetch. Conversations are stored as JSONL on disk.

The design is in [docs/spec-v1.md](docs/spec-v1.md). The reasoning behind it is in [docs/assessment.md](docs/assessment.md).

## Setup

Requires Node 22.12+ and git.

```bash
npm install
cp .env.example .env                        # TELEGRAM_BOT_TOKEN, OPENROUTER_API_KEY
cp config/config.example.json config/config.json   # set telegram.allowlist to your user id
npm run build
npm start                                   # foreground; Ctrl-C stops it cleanly
```

On first start, `~/.acmd/workspace` is created from `workspace-template/`. It holds AGENTS.md, MEMORY.md and skills, and is yours and the agent's to edit. Conversations live in `~/.acmd/state`.

## Telling the agent about its machine

An agent on a server should know what runs there, where things live, and which rules apply, and that knowledge should stay current without anyone editing the agent's own notes. Whatever sets up the machine (an install script, Ansible, a dotfiles repo) writes it to the **box directory**, `/etc/acmd` by default (`box_dir` in the config):

```
/etc/acmd/context.d/10-box.md            # facts and rules: in every conversation's prompt
/etc/acmd/context.d/20-apps.md           # (all *.md files, in name order; keep the total under 32 KB)
/etc/acmd/skills.d/deploy-app/SKILL.md   # procedures, read only when a task needs them
```

- **Context** is what the agent should always know: the machine's purpose, layout, services, repos, what needs asking first, where the docs are. It's read-only for the agent and wins over its memory when they disagree.
- **Skills** are [Agent Skills](https://agentskills.io/specification) (`SKILL.md` with `name` and `description` frontmatter, optional `scripts/` and `references/`): runbooks the agent follows when a task matches. They're listed with the workspace's own skills, which override one of the same name, and `/<name>` runs one from Telegram.
- **Live state** (what's failing, what just ran) doesn't belong in these files: point the context at a command that prints it, such as [beacon](https://github.com/eemax/beacon)'s `beacon brief`.

Rewrite the files whenever the machine changes; each new conversation (`/new`) reads them. `acmd status` checks them (`box`). Details: [docs/spec-v1.md](docs/spec-v1.md) → Home, workspace, box and skills.

## Running on a server

Use [deploy/acmd.service](deploy/acmd.service) with systemd, and read logs with `journalctl -fu acmd`. Debug logging is off by default. Toggle it with `/debug on|off` in Telegram or `systemctl kill -s USR2 acmd`, or start with `ACMD_DEBUG=1`.

```bash
acmd status          # human-readable health and meta numbers
acmd status --json   # same, for beacon (eemax/beacon APPS.md)
acmd notify "text"   # wake the agent (timers, scripts); also reads stdin
```

## Telegram commands

`/new` `/stop` `/status` `/model [alias]` `/thinking [level]` `/cwd [path]` `/jobs [stop <id>]` `/debug [on|off]` `/<skill>`

A message sent while a turn is running steers that turn. The agent can run commands as background jobs; when one exits, the agent picks up on its own (replies marked ⏰). Anything can wake it with `acmd notify "text"`, e.g. a systemd timer.

## Development

```bash
npm run dev        # run from source
npm run typecheck && npm run lint && npm test && npm run build
```
