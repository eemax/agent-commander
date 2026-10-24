# Agent Commander v1 Spec (locked 2026-10-07)

A minimal, single-process Telegram bot. It runs agent turns on OpenRouter through `@openrouter/agent`, gives the model one local tool (bash), and stores conversations as JSONL. Background and the reasoning behind these choices are in [assessment.md](assessment.md).

## Constraints

- One Telegram bot, one process, run in the foreground. Supervise it with systemd or launchd. The CLI has three commands: `acmd` (runs the bot in the foreground), `acmd status [--json]` and `acmd notify`. There is no detached mode.
- One provider: OpenRouter, reached only through `@openrouter/agent`, with the exact version pinned. SDK imports live only in `src/agent.ts`.
- Persistence is files only (JSONL plus small JSON indexes). No database.
- None of these: subagents, MCP, approvals or permissions, plugins, Docker.

## Turn execution

- `callModel` receives the model, the reasoning effort, the instructions, the tools, `state` (the JSONL StateAccessor), `signal`, `hooks`, and `doomLoop: true`.
- There is **no step cap**. The only guards are:
  - `doomLoop`, the SDK's detector for repeated identical calls,
  - the optional per-turn `maxCost` from config,
  - `/stop`.
- Compaction uses OpenRouter's `context-compression` plugin (middle-out). Our own summarization comes later.
- Reasoning is requested at the configured effort. It is never shown to the user, but reasoning items are persisted in the state.
- **Steering:** a user message that arrives during a turn goes to `result.queueUserMessage(text)`. If the SDK cannot deliver it (the model is already writing its final answer), it becomes the next turn as soon as the current one ends.

## Tools

1. **`bash`**, executed locally (`src/tools/bash.ts`, `src/tools/output.ts`):
   - Input: `command`, optional `description` (shown in the Telegram status line instead of the command), optional `timeout_ms`, optional `background`.
   - **One execution path:** every command runs as a job (see below). Each call is a fresh `/bin/bash -c` in the conversation's cwd, in its own process group, with stdin `/dev/null`. Its environment is a snapshot of the login shell's (`bash -lc 'env -0'`, refreshed every 5 min; `src/tools/shellenv.ts`), so commands get nvm/cargo/uv PATHs and exported secrets without paying for a login shell on every call (≈0.36 s with nvm on ysera). The environment has no acmd credentials, plus `PAGER=cat`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0` and `DEBIAN_FRONTEND=noninteractive`, so nothing waits for input.
   - **cwd persists** across calls, like Claude Code. The command's EXIT trap records `$PWD`; a foreground call that ends in another existing directory updates the conversation cwd. Exports, variables and functions don't persist.
   - **Foreground** waits up to `timeout_ms`: default `bash.timeout_ms` (2 min), capped at `bash.max_timeout_ms` (10 min). If the command finishes, the call returns `{ exit_code, output, truncated, full_output?, cwd?, note? }`. **If it is still running, it is not killed:** the call returns `{ still_running, job_id, pgid, log, output so far, note }` and the job continues in the background (promoted). `/stop` kills the command's whole process group with SIGKILL.
   - **Output:** stdout and stderr are merged into the job log. The model gets a cleaned view: ANSI and OSC codes stripped, carriage-return progress bars collapsed to their final state, other control characters removed, and binary output replaced by `[binary output, N]`. It is capped at `bash.output_cap_chars` (40% head, 60% tail, read from both ends of the file, so a huge log is never loaded whole). When truncated, the full log is kept and its path returned, so the model can search it instead of re-running.
   - **Caps:** a foreground command is stopped (TERM) once its log passes 100 MB, a background job at 1 GB. The result or notice says so.
   - **Background** (`background: true`): starts the job without waiting, returning `{ job_id, pgid, log }`.
2. **`openrouter:web_search`** and **`openrouter:web_fetch`**: OpenRouter server tools with engine `auto`.

## Background jobs and wake-ups

The agent can do work that outlives a turn and pick it up again by itself, like Claude Code's background tasks. All three cases are one primitive: a background job whose exit wakes the agent.

| Need | Background command |
|---|---|
| Park long work | `npm run build` (or just run it: past the timeout it moves to the background by itself) |
| Check back in x minutes | `sleep 900; curl -s …/health` |
| Wait until something happens | `until grep -q READY app.log; do sleep 20; done` |

**Jobs** (`src/jobs.ts`), stored in `state/jobs/<id>/` (`job.json`, `output.log`, `exit`, `cwd`). Ids come from a persisted counter, so pruning never reuses one. Foreground calls are jobs too: their directory is deleted when the call finishes, unless the full output was handed to the model (then it's kept for the retention period). They join the sweep only when promoted, so a finished call is never also delivered. A foreground job whose call died with an earlier acmd process is adopted and reported like any background job.
- A detached wrapper shell runs `bash -c <command>` in the background with output going to `output.log`. Then it ignores TERM, INT and HUP (set after the fork, so the command keeps default handling), waits, and writes the exit code to `exit`. So `kill -- -<pgid>` (or `/jobs stop`) ends the command, and the wrapper still records exit 143.
- Jobs don't depend on acmd. They survive acmd restarts (the unit uses `KillMode=process`) and record their own outcome. Every second the daemon checks running jobs:
  - `exit` exists: **exited**.
  - The wrapper is gone without an exit file (SIGKILL), or the job is from an earlier boot (each job records the boot time, so a reused pid can't fake it): **lost**.
- Ended jobs are kept 7 days after delivery, then pruned.

**Delivery** (`src/telegram/bot.ts`). Every notice starts with `[acmd]`.
- **Exited job:** a **wake**, carrying the exit code, duration, command, cwd, log path and the last 20 lines (≤2,000 chars), plus "started in an earlier conversation" when relevant.
  - If the chat is idle, a wake starts a turn; the reply is prefixed with ⏰.
  - If a turn is running, it steers it.
  - If the turn is finishing, it queues.
- **Lost job:** a **note**. It steers a running turn, or else waits and goes along with the next turn, so it costs nothing on its own.
- **`/stop` and `/new`:** queued wake-ups become notes rather than being dropped. A stopped turn never starts a new one. `/new` keeps `[acmd]` notices and drops stale steers.
- **Counting:** the conversation counts its wake-ups, shown in `/status`. There is no hard limit.

**`acmd notify [--chat <id>] [--source <label>] [text|stdin]`** (`src/inbox.ts`) writes `state/inbox/<monotonic ulid>.json`. The daemon delivers it as a wake (`[acmd] Notification (<source>): …`) and deletes it, including ones written while it was down. The chat defaults to the first allowlisted id, and other chats are refused. This is how timers, cron jobs and scripts wake the agent, e.g. for scheduled checks. The prompt teaches the exact command.
2. **`openrouter:web_search`** and **`openrouter:web_fetch`**: OpenRouter server tools with engine `auto`.

## Telegram

- grammY, long polling.
- Handles **private chats only**. Senders not on the allowlist are ignored silently, with a debug log line only.
- **Reply:** final text → split the markdown at paragraph or code-block boundaries (each chunk under 4096 characters after conversion) → convert each chunk to HTML → send it. If Telegram rejects the HTML, resend that chunk as plain text.
- **Typing indicator:** `sendChatAction("typing")` every ~4s while a turn runs.
- **Tool activity:** one status message, `⚙️ <command>`. It is created on the first tool call, edited at most every ~2s, and deleted when the final reply is sent.
- **Errors:** a failed turn sends a short error reply. The bot never stays silent.
- No streaming, no drafts, no reasoning display.

## Commands

| Command | Behavior |
|---|---|
| `/new` | Archive the current conversation and start a fresh one |
| `/stop` | Abort the running turn |
| `/status` | Model, effort, cwd, tokens and cost (turn and conversation), context usage |
| `/model [alias\|id]` | With no argument, list the configured models. Otherwise switch models for this conversation. |
| `/thinking [level]` | Show or set the effort (`none, minimal, low, medium, high, xhigh, max`) |
| `/cwd [path]` | Show or set the working directory for this conversation |
| `/jobs [stop <id>]` | List running and recent background jobs, or stop one |
| `/debug [on\|off]` | Show or toggle debug logging at runtime |
| `/<skill>` | Run the skill's SKILL.md one time |

## Home, workspace and skills

Everything the runtime owns on disk lives under one home directory, `~/.acmd/` (configurable). The repo holds code only, so redeploying or re-cloning never touches conversations or the agent's files.

```
~/.acmd/
  workspace/                 the agent's home and default cwd; the agent may edit all of it
    AGENTS.md                who the agent is, who the user is, how to work (persona + rules in one file)
    MEMORY.md                short durable-memory index the agent maintains (keep under ~100 lines)
    memory/                  longer notes, linked from MEMORY.md
    skills/<name>/SKILL.md   Agent Skills format: frontmatter `name` + `description`, optional scripts/ and references/
  state/                     owned by the runtime; the agent should not edit it
    current.json
    conversations/<convId>.jsonl + .meta.json
    archive/
```

- **Ownership split:**
  - `src/prompt.md` in the repo is versioned with the code. It describes the runtime: the bash tool and its limits, background jobs and `acmd notify`, web tools, Telegram formatting rules, and how skills and memory work.
  - The workspace holds the user's own content: AGENTS.md, memory and skills.
- **Instructions** are `prompt.md` + `AGENTS.md` + `MEMORY.md` + a skills index (name, description, path). They are compiled **once, when the conversation is created**, and saved next to it (`<convId>.instructions.md`), so they stay byte-identical across restarts. That keeps the prompt-cache prefix byte-stable. Edits made during a conversation, to skills, memory or AGENTS.md, take effect at the next `/new`.
- **Skills** follow the open Agent Skills format (`SKILL.md` with `name`/`description` frontmatter), so they also work with Claude Code and Codex. Only the index goes into the prompt. The model reads the full skill with `cat` when it needs it. `/<name>` forces a skill for one turn.
- **Memory:** `MEMORY.md` is the index that is always loaded. Details go in `memory/*.md` and are read on demand. The prompt tells the agent when to write memory (decisions, preferences, ongoing work) and to keep the index short.
- **Bootstrap:** on first start, a missing `workspace/` is seeded from `workspace-template/` in the repo. That includes a starter AGENTS.md, an empty MEMORY.md, and a `skill-creator` skill so the agent can write new skills. Existing files are never overwritten.

## Persistence

- `state/conversations/<convId>.jsonl` is append-only: one SDK item per line, and `save()` appends only the new items.
- `state/conversations/<convId>.meta.json` holds status, model, effort, cwd, usage and cost. It is written atomically.
- `state/current.json` records the current conversation ID. `/new` moves the old conversation into `state/archive/`.

## Logging

- Always on: startup banner (version, model, workspace, allowlist size, "ready"), warnings, errors.
- Debug, off by default: turns, tool calls (command, exit code, duration), model calls (tokens, cost), steering, ignored senders.
- Toggle with `/debug on|off` or `SIGUSR2`. The toggle lives in memory only and resets on restart.
- Output goes to stdout/stderr, so journald captures it under systemd.

## Observability (beacon, per eemax/beacon APPS.md)

acmd is a long-running daemon. systemd and beacon already capture process start/stop, outcome, exit code, restarts and memory, so acmd reports **only facts it alone knows**, as plain JSON. It has no beacon dependency; a ~20-line adapter on the box maps the JSON.

**Process contract**
- Runs as a systemd `Type=simple` service. The repo ships `deploy/acmd.service`.
- **SIGTERM shuts it down cleanly:** stop polling, abort the running turn, flush state and the run record, then exit (143 is fine). The run shows as *stopped*, not *failed*.
- A fatal error ends with **one plain sentence on the last output line**, e.g. `error: config telegram.allowlist is empty: add your Telegram user id`. Any stack trace goes before it.
- No secrets and no message content ever appear in output, status or records. That includes no user or assistant text.

**`acmd status [--json]`** is read-only, takes under 1s, makes no network calls, and always exits 0 unless it can't read anything.
- It reports **meta facts about the app**: its spend, what it holds, and whether its setup is sane. It says nothing about live sessions, the current conversation, or per-turn activity.
- The daemon writes `state/status.json` atomically every 60s. The CLI reads that file plus sizes and counts on disk.
- The shape follows APPS.md (`healthy`, `problems`, `metrics`, `checks`, `last_run`). Example:

```jsonc
{
  "healthy": true,
  "problems": [],
  "metrics": [
    { "key": "credits.remaining",  "label": "OpenRouter credits", "value": 18.40, "unit": "usd",   "primary": true },
    { "key": "cost.7d",            "label": "Spend (7 d)",        "value": 4.12,  "unit": "usd",   "primary": true },
    { "key": "cost.30d",           "label": "Spend (30 d)",       "value": 15.80, "unit": "usd" },
    { "key": "conversations.total","label": "Conversations",      "value": 214,   "unit": "count", "primary": true },
    { "key": "skills.total",       "label": "Skills",             "value": 9,     "unit": "count", "primary": true },
    { "key": "memory.notes",       "label": "Memory notes",       "value": 23,    "unit": "count" },
    { "key": "workspace.size",     "label": "Workspace on disk",  "value": 1048576, "unit": "bytes" },
    { "key": "state.size",         "label": "State on disk",      "value": 5242880, "unit": "bytes" },
    { "key": "cost.30d", "label": "Spend (30 d)", "value": 11.30, "unit": "usd", "labels": { "model": "kimi" } },
    { "key": "cost.30d", "label": "Spend (30 d)", "value": 4.50,  "unit": "usd", "labels": { "model": "flash" } }
  ],
  "checks": [
    { "name": "event_loop", "status": "ok", "detail": "last heartbeat 2026-10-23T06:58:12Z" },
    { "name": "telegram",   "status": "ok", "detail": "token valid, polling" },
    { "name": "openrouter", "status": "ok", "detail": "key valid" },
    { "name": "credits",    "status": "ok", "detail": "$18.40 left" },
    { "name": "models",     "status": "ok", "detail": "all 4 configured models available" },
    { "name": "workspace",  "status": "ok", "detail": "AGENTS.md present, 9 skills valid" }
  ],
  "last_run": { "started_at": "…", "finished_at": null, "status": "ok", "error": null,
                "summary": "acmd 1a2b3c4 · up since Oct 20 · default model flash" }
}
```

- **Spend** (7 d, 30 d, and 30 d per model alias) is summed from conversation `.meta.json` files. The per-model label set is bounded by the configured aliases.
- The **meta checks** run every ~15 min in the daemon, and the results are cached in `status.json`. The status command itself stays offline.

  | Check | ok | warn | fail |
  |---|---|---|---|
  | `event_loop` | heartbeat fresh | heartbeat older than 3 min | heartbeat older than 10 min (hung) |
  | `telegram` | `getMe` succeeds and polling is alive | — | token rejected, or no successful poll for 5 min |
  | `openrouter` | key accepted | — | key rejected |
  | `credits` | balance at or above `credits_warn_usd` | balance below `credits_warn_usd` (default $5) | balance at or below $0 |
  | `models` | every configured model ID is in OpenRouter's model list | a configured model has been deprecated or removed | the default model is missing |
  | `workspace` | AGENTS.md exists, every SKILL.md parses (name and description present), MEMORY.md is a sane size | any of those is off | — |
- **Run record:** a run is one process lifetime. `last_run.started_at` is the process start time. On shutdown, the run record is written to `state/last-run.json` (`ok`, or `failed` with `error`), and its `summary` gives the version, uptime and default model.
- **Deploys:** the install script logs `beacon event deploy --component acmd …`, only when the git SHA changed.

## Config

`config/config.json` (strict zod; unknown keys fail startup) plus `.env`:

```jsonc
{
  "telegram": { "allowlist": ["<user id>"] },          // must be non-empty
  "models": [                                            // first = default
    { "id": "deepseek/deepseek-v4.1-flash", "alias": "flash" },
    { "id": "moonshotai/kimi-k3",           "alias": "kimi" },
    { "id": "z-ai/glm-5.3",                 "alias": "glm" },
    { "id": "deepseek/deepseek-v4-pro",     "alias": "dspro" }
  ],
  "default_effort": "medium",
  "home": "~/.acmd",
  "bash": { "timeout_ms": 120000, "max_timeout_ms": 600000, "output_cap_chars": 30000 },
  "max_turn_cost_usd": null,                             // optional
  "credits_warn_usd": 5                                  // status check threshold
}
```

`.env`: `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`.

## Deferred to v2+

- Attachments in and out, built into the runtime (not done as a skill).
- Summarization-based compaction.
- More local tools, added only if bash-only measurably fails.
