# ACMD Lifecycle CLI and Detached Runtime Control

Status: proposed
Owner: Codex
Date: 2026-03-27

## Summary

Implement a real `acmd` lifecycle CLI that can:

- run the runtime in the foreground
- start the runtime in detached mode so the terminal is freed
- target either `all` configured agents or one selected agent such as `main` or `ysera`
- stop or restart the active detached runtime
- inspect configured agents and runtime state
- tail runtime logs
- run a local preflight doctor command

The design should preserve Agent Commander's core shape:

- one channel: Telegram
- one provider: OpenAI
- JSON/JSONL local state only
- no external daemon manager
- no plugin system

The most important architectural choice is:

1. keep one active runtime process per repository in v1
2. allow that one runtime to boot either all agents or a filtered subset
3. do not introduce one OS process per agent in v1

This gives us the operational UX the user wants without turning `acmd` into a mini process supervisor framework.

## Background

Today:

- the package already exposes a global `acmd` binary via [`package.json`](../../package.json)
- [`src/index.ts`](../../src/index.ts) does not parse CLI args; it always starts the runtime
- [`src/runtime/bootstrap.ts`](../../src/runtime/bootstrap.ts) loads every configured agent and starts them in one foreground process
- [`config/agents.json`](../../config/agents.json) already contains the canonical list of agents and aliases

This means the project already has:

- a stable global command name
- multi-agent startup
- per-agent namespaced paths

What it does not have yet is:

- a lifecycle control surface
- detached startup
- runtime state tracking for `start` / `stop` / `restart`
- a supported way to run only one selected agent

## Problem Statement

The current workflow is good for development but weak for day-to-day operations:

- `npm run dev` occupies the terminal
- there is no first-class `acmd start all`
- there is no runtime state file or pid tracking
- there is no built-in `restart --rebuild` path
- there is no simple `list` or `doctor` command

The user wants `acmd` to become the operational entrypoint for the runtime, not just the compiled binary name.

## Goals

- Add a first-class CLI with explicit subcommands.
- Keep current bare invocation behavior backward-compatible.
- Allow `all` or one selected agent to boot.
- Support detached startup without PM2/systemd/Docker.
- Persist minimal runtime-control state in repo-local JSON/JSONL files.
- Make restart flows predictable and safe.
- Keep implementation small, explicit, and testable.
- Preserve the current runtime's single-process mental model.

## Non-Goals

- Auto-restart or crash-loop supervision.
- Running multiple detached runtimes in parallel from the same repo in v1.
- One background OS process per configured agent.
- Remote admin API, sockets, or HTTP control plane.
- Editing config files from the CLI.
- Hot reload or file watching in v1.
- Replacing `npm run dev` with a source-watching development experience in v1.

## Product Model

### One Active Runtime Per Repo

V1 should support exactly one active detached runtime per repository checkout.

That runtime may be started with one selector:

- `all`
- one agent id
- one agent alias

Examples:

- `acmd start all`
- `acmd start main`
- `acmd start ysera`

This means:

- `start all` starts one runtime process that boots both `default` and `ysera`
- `start main` starts one runtime process that boots only the `default` agent
- `start ysera` starts one runtime process that boots only the `ysera` agent

This does not mean:

- one detached process for `default`
- one detached process for `ysera`
- a long-lived supervisor process managing multiple child runtimes

### Why This Is The Right V1

This choice aligns with the documented project goals in [`docs/architecture.md`](../architecture.md):

- one process
- one entrypoint
- small operational model

It also avoids the hardest failure mode in a Telegram polling app: accidentally starting overlapping processes for the same bot token.

## Intended Use Cases

`acmd` should be best at:

- starting the normal bot fleet quickly
- restarting after a code or config change
- rebuilding before restart
- checking which agents are configured and which ones are active
- tailing detached logs
- validating whether startup will succeed before actually starting

`acmd` should not try to be:

- a hosting platform
- a scheduler
- a deployment orchestrator
- a crash recovery daemon

## Command Surface

### Primary Commands

```bash
acmd run [selector]
acmd start [selector] [--rebuild]
acmd stop [selector|all] [--force]
acmd restart [selector] [--rebuild] [--force]
acmd list [--json]
acmd logs [selector|all] [-f|--follow] [--lines N]
acmd doctor [selector] [--json]
acmd help
acmd --version
```

### Selector Rules

- omitted selector defaults to `all`
- `all` is a reserved keyword
- any other selector is resolved against agent `id` and `aliases`
- selector resolution is case-insensitive for lookup, but canonical output uses agent ids

Examples:

- `acmd run` -> same as `acmd run all`
- `acmd start main` -> canonical selector is `default`
- `acmd start ysera` -> canonical selector is `ysera`

### Backward Compatibility

Bare invocation should remain valid:

- `acmd` -> same as `acmd run all`
- `npm start` -> same as `node dist/index.js run all`
- `npm run dev` -> same as `tsx src/index.ts run all`

This preserves the current behavior while allowing the richer subcommands.

## Command Semantics

### `acmd run [selector]`

Foreground runtime.

Behavior:

- resolves selector
- starts the selected runtime in the current terminal
- streams logs to stdout/stderr
- blocks until stopped
- exits with the runtime's exit code

This is the command equivalent of the current behavior and should be the simplest path for local development or direct debugging.

### `acmd start [selector] [--rebuild]`

Detached runtime.

Behavior:

- optionally rebuilds first
- spawns a detached child runtime
- writes runtime-control state
- redirects child stdout/stderr to a combined detached log file
- waits for a readiness handshake up to a bounded timeout
- returns control to the shell

Success output should include:

- selector
- canonical agent ids
- pid
- instance id
- log path

### `acmd stop [selector|all] [--force]`

Stops the active detached runtime.

Behavior:

- `stop all` stops whatever active detached runtime exists
- `stop <selector>` only succeeds if the active runtime's canonical agent set exactly matches that selector
- sends `SIGTERM`
- waits up to a graceful shutdown timeout
- if `--force` is passed, escalates to `SIGKILL` after the timeout

Rationale:

- `stop all` is the clear "shut everything down" command
- `stop main` should not silently mutate a runtime that was started as `all`

### `acmd restart [selector] [--rebuild] [--force]`

Stop-then-start lifecycle command.

Behavior:

- if `--rebuild` is passed, build first while the existing runtime keeps running
- if build fails, keep the existing runtime untouched
- once build succeeds, stop the current runtime if present
- start the requested selector
- if no runtime is active, `restart` behaves like `start`

This is the safest semantics for a local operational command.

### `acmd list [--json]`

Displays:

- configured agents
- aliases
- config dirs
- current runtime status
- which configured agents are active under the current selector

Default text output should be human-readable.
`--json` should produce stable machine-readable output.

### `acmd logs [selector|all] [-f|--follow] [--lines N]`

Log viewing command.

Default rules:

- no selector or `all`: tail the detached combined runtime log
- specific agent selector: tail that agent's `paths.app_log_path`
- `--follow`: stream appended lines until interrupted
- `--lines N`: default to 100 lines

This gives a useful split:

- combined runtime log for lifecycle/debugging
- per-agent app log for day-to-day diagnostics

### `acmd doctor [selector] [--json]`

Runs startup preflight checks without starting Telegram polling.

Checks should include:

- manifest load and selector resolution
- config parse for the selected agents
- env secret presence for the selected agents
- auth-mode availability for the selected agents
- bot-token uniqueness within the selected set
- detached control directory writeability
- build artifact presence for compiled runtime mode
- active runtime state reconciliation

The command should not:

- connect to Telegram
- send provider requests
- modify runtime data beyond stale-state reconciliation

## Selector Model

Introduce a small canonical selector model:

```ts
type RuntimeSelector =
  | {
      raw: string;
      kind: "all";
      displayName: "all";
      canonicalKey: "all";
      agentIds: string[];
    }
  | {
      raw: string;
      kind: "agent";
      displayName: string;
      canonicalKey: string;
      agentIds: [string];
    };
```

Rules:

- `all` is reserved and may not be used as an agent id or alias
- selector comparison uses `canonicalKey`
- runtime state stores canonical ids, not aliases

Recommended additions to [`src/agents.ts`](../../src/agents.ts):

- `resolveAgentSelector(manifest, rawSelector)`
- `filterAgentsBySelector(manifest, selector)`
- manifest validation rejecting `all` as an id or alias

## Conflict Model

V1 should enforce one active detached runtime at a time.

### Start

- no runtime active -> start
- same canonical selector already running -> return non-zero "already running"
- different selector already running -> return non-zero with guidance to use `restart`

### Stop

- `stop all` with runtime active -> stop it
- `stop all` with no runtime -> success no-op
- `stop <selector>` with exact canonical match -> stop it
- `stop <selector>` with different active selector -> non-zero explanatory error

### Restart

- no runtime active -> start requested selector
- same selector active -> stop then start
- different selector active -> replace it

This is intentionally explicit and avoids silent selector mutation on `start`.

## Runtime Control Architecture

### Hidden Internal Runtime Invocation

The detached child should be launched by invoking the same CLI with an internal command, for example:

```bash
node dist/index.js __runtime --selector all --instance-id rt_<ulid> --mode detached
```

Why:

- one binary path
- no duplicated startup code
- easy to test
- easy to keep backward-compatible

`__runtime` is internal only and not documented for users.

### CLI Parsing

Do not add a new dependency such as `commander`.

Implement a small explicit parser, for example:

- `src/cli/parse.ts`
- `src/cli/types.ts`
- `src/cli/usage.ts`

The parser should return a discriminated union and reject:

- unknown commands
- unknown flags
- repeated selectors
- malformed numeric values

### Runtime Boot Filtering

Refactor [`startRuntime`](../../src/runtime/bootstrap.ts) to accept options:

```ts
type StartRuntimeOptions = {
  selector?: RuntimeSelector;
  lifecycle?: {
    onReady?: (info: RuntimeReadyInfo) => Promise<void> | void;
    onShutdownStart?: (info: RuntimeShutdownInfo) => Promise<void> | void;
    onShutdownComplete?: (info: RuntimeExitInfo) => Promise<void> | void;
    onStartupError?: (error: unknown) => Promise<void> | void;
  };
};
```

Behavior changes:

- when no selector is passed, boot all agents
- when a selector is passed, only load configs for those agents
- only validate unique bot tokens within the selected set

Important:

- a broken `default` config must not block `acmd run ysera`
- a broken `ysera` config must not block `acmd run main`

### Readiness Handshake

Detached startup needs positive readiness confirmation.

Current code awaits `bot.start(...)`, which is a long-lived runtime call, so the child cannot simply write "ready" after `startRuntime` returns.

Recommended change:

- count `onStart` callbacks from each selected Telegram bot
- when all selected bots have called `onStart`, invoke `lifecycle.onReady`
- only then mark detached state as `running`

This gives the parent command a trustworthy startup signal.

## Runtime-Control Persistence

Use repo-local control files under:

```text
.agent-commander/control/
```

Recommended files:

```text
.agent-commander/control/runtime.json
.agent-commander/control/events.jsonl
.agent-commander/control/logs/runtime-<instance_id>.log
```

### `runtime.json`

Single snapshot file for the active or last-known runtime state.

Suggested shape:

```json
{
  "schema_version": 1,
  "instance_id": "rt_01HY...",
  "status": "starting",
  "mode": "detached",
  "selector": {
    "raw": "main",
    "canonical_key": "default",
    "kind": "agent",
    "agent_ids": ["default"]
  },
  "pid": 43122,
  "started_at": "2026-03-27T08:42:15.219Z",
  "updated_at": "2026-03-27T08:42:15.219Z",
  "repo_root": "/Users/ysera/agent-commander",
  "log_path": "/Users/ysera/agent-commander/.agent-commander/control/logs/runtime-rt_01HY....log",
  "last_error": null,
  "last_exit": null
}
```

Recommended status values:

- `starting`
- `running`
- `stopping`
- `exited`
- `failed`

### `events.jsonl`

Append-only lifecycle event log for debugging the control plane.

Suggested event types:

- `start_requested`
- `build_started`
- `build_succeeded`
- `build_failed`
- `spawned`
- `runtime_ready`
- `stop_requested`
- `force_kill_sent`
- `runtime_exited`
- `startup_failed`
- `stale_state_cleared`

This is not user-facing, but it will make `acmd` failures far easier to debug.

### Atomic Writes

All JSON control writes should use the same tmp-file-then-rename pattern already used in [`src/state/conversations.ts`](../../src/state/conversations.ts).

## Detached Spawn Design

### Spawn Strategy

Use Node's `spawn` with:

- `detached: true`
- `stdio: ["ignore", logFd, logFd]`
- `cwd: repoRoot`
- `env` inherited from the parent

Then call:

- `child.unref()`

The parent should not stay attached to the child process group after successful startup.

### Startup Sequence

Recommended `acmd start` flow:

1. reconcile current runtime state
2. fail if a conflicting runtime is already active
3. if `--rebuild`, run `npm run build`
4. create `instance_id`
5. write `runtime.json` with `status: starting`
6. append `start_requested` event
7. spawn detached child with `__runtime`
8. update `runtime.json` with the child's pid
9. wait up to `START_READY_TIMEOUT_MS` for:
   - `runtime.json.status` to become `running`, or
   - `runtime.json.status` to become `failed`, or
   - child death
10. on success, print runtime summary and exit 0

Recommended timeout:

- `START_READY_TIMEOUT_MS = 15000`

If timeout expires but the process is still alive and state remains `starting`:

- return success with a warning
- print the log path
- leave status as `starting`

That avoids false negatives on slow startup while still surfacing uncertainty.

### Child Startup Failure Handling

The internal child process should:

- catch top-level startup errors
- write `runtime.json.status = "failed"`
- serialize a short sanitized `last_error`
- append `startup_failed` event
- exit non-zero

This lets `acmd start` report a clean failure instead of only "spawned pid X".

## Graceful Shutdown and Cleanup

### Problem

Today the runtime signal handler in [`src/runtime/bootstrap.ts`](../../src/runtime/bootstrap.ts) stops Telegram bots and exits immediately.

That is not sufficient for detached lifecycle management because:

- running harness shell processes may remain alive
- running subagents may continue
- shutdown timing is undefined

### Required Change

Add a top-level runtime cleanup path before exit.

Recommended additions:

- `ToolHarness.shutdown(): Promise<void>`
- `ProcessManager.terminateAllRunningSessions(options): Promise<{ terminated: number; forced: number }>`
- call `subagentManager.shutdown()` if enabled

Suggested shutdown order:

1. set runtime-control status to `stopping`
2. stop Telegram polling
3. terminate running process sessions gracefully
4. stop subagents
5. flush logs if needed
6. mark runtime as `exited`
7. append `runtime_exited` event
8. exit process

The shutdown path must be:

- async
- idempotent
- safe to call from `SIGINT` and `SIGTERM`

### Stop Timeout

Recommended defaults:

- graceful wait: 15000 ms
- force-kill only when explicitly requested by the CLI

This keeps `stop` predictable and conservative.

## Logging Design

The project already writes:

- stdout/stderr logs
- per-agent app logs via `paths.app_log_path`

Detached mode should add one combined runtime log for the detached child.

### Combined Detached Log

Purpose:

- startup diagnostics
- CLI lifecycle debugging
- easy `acmd logs all`

Suggested path:

```text
.agent-commander/control/logs/runtime-<instance_id>.log
```

### Per-Agent Logs

Do not replace or move current app logs.

`acmd logs <agent>` should resolve that agent's config and tail its `paths.app_log_path`.

This preserves the current logging model and avoids inventing a new agent-log format.

## `doctor` Design

`acmd doctor` should be a preflight command, not a hidden startup path.

### Output

Text mode should print one line per check.

Example:

```text
ok    manifest loaded
ok    selector resolved: default
ok    config parsed: default
ok    auth available: codex
warn  dist build exists but may be stale
ok    control dir writable
ok    no active detached runtime
```

### Checks

For the selected runtime:

- manifest parse
- selector resolution
- config parse
- secret presence
- auth availability
- token uniqueness
- log/control path parent dirs can be created

For the repository:

- detached runtime state is reconciled
- stale pid/state is cleared
- build artifact exists for compiled mode

### Recommendation

Do not attempt full bootstrap in `doctor`.

Instead, reuse the same parsing and auth-availability helpers the real startup path uses.

## Restart Semantics With `--rebuild`

This command should be intentionally safer than a naive stop-build-start sequence.

Recommended flow:

1. if a runtime is active and `--rebuild` is passed:
   - run `npm run build` first
   - if build fails, abort restart and leave the current runtime running
2. stop the current runtime
3. start the requested selector

This avoids unnecessary downtime caused by a broken build.

## Error Handling

### Stale Runtime State

Every lifecycle command should begin by reconciling `runtime.json`.

If the file says `running` or `starting` but the pid is dead:

- mark state as `exited`
- append `stale_state_cleared`
- continue

### PID Safety

V1 can use `process.kill(pid, 0)` liveness checks plus the stored `instance_id`.

This is acceptable for a local CLI, but it should be documented as best-effort rather than perfect proof against pid reuse.

### Build Failures

- `start --rebuild`: fail before spawning
- `restart --rebuild`: fail before stopping the current runtime

### Selector Errors

Unknown selectors should produce a friendly error that also shows known ids and aliases.

### Already Running

Starting the same selector twice should not silently succeed.

Return non-zero with a message like:

```text
Runtime already running for selector "all" (pid 43122). Use `acmd restart all` or `acmd stop all`.
```

## Proposed Module Changes

### New Modules

- `src/cli/parse.ts`
- `src/cli/types.ts`
- `src/cli/usage.ts`
- `src/cli/control-store.ts`
- `src/cli/runtime-state.ts`
- `src/cli/spawn-runtime.ts`
- `src/cli/commands/run.ts`
- `src/cli/commands/start.ts`
- `src/cli/commands/stop.ts`
- `src/cli/commands/restart.ts`
- `src/cli/commands/list.ts`
- `src/cli/commands/logs.ts`
- `src/cli/commands/doctor.ts`

### Existing Modules To Refactor

- [`src/index.ts`](../../src/index.ts)
  - turn into the real CLI entrypoint
- [`src/runtime/bootstrap.ts`](../../src/runtime/bootstrap.ts)
  - add selector filtering and lifecycle hooks
- [`src/agents.ts`](../../src/agents.ts)
  - add selector resolution and reserved-word validation
- [`src/harness/index.ts`](../../src/harness/index.ts)
  - expose shutdown hook
- [`src/harness/process-manager.ts`](../../src/harness/process-manager.ts)
  - add bulk terminate support

## Documentation Changes

If this ships, update:

- [`README.md`](../../README.md)
  - quickstart and operations section
- [`docs/user-guide.md`](../user-guide.md)
  - new CLI commands and detached usage
- [`docs/architecture.md`](../architecture.md)
  - replace "foreground-only" wording with "foreground by default, detachable via `acmd start`"
- [`docs/contributing.md`](../contributing.md)
  - clarify that `acmd` detached mode is allowed, while external daemon managers remain out of scope

No config schema changes are required for v1.

## Testing Plan

### Unit Tests

- CLI argv parsing
- selector resolution
- reserved `all` validation
- runtime-state atomic writes
- stale-state reconciliation
- conflict detection
- log-path resolution

### Integration Tests

- `run main` only bootstraps `default`
- `run ysera` only bootstraps `ysera`
- `start all` writes `starting` then `running`
- child startup failure writes `failed`
- `stop all` sends `SIGTERM` and updates state
- `restart all --rebuild` builds before stop
- rebuild failure leaves current runtime alive
- `logs ysera` resolves the correct app log path
- shutdown terminates active harness processes and subagents

### Test Strategy Notes

Prefer dependency injection over real detached child processes in most tests.

Examples:

- inject `spawn`
- inject `kill`
- inject clock/time helpers
- inject filesystem roots

Keep one or two higher-level integration tests for the actual detached spawn handshake.

## Rollout Plan

### Phase 1

- add CLI parser
- add selector resolution
- keep bare invocation compatibility
- refactor bootstrap to accept selectors

### Phase 2

- add detached control store
- add `start` / `stop` / `restart`
- add readiness hooks
- add runtime cleanup path

### Phase 3

- add `list`
- add `logs`
- add `doctor`
- update docs

## Recommendation

Ship this in the following order:

1. selector-aware foreground `run`
2. detached `start` / `stop` / `restart`
3. `list`, `logs`, and `doctor`

That order keeps the early changes small and useful while building toward the full operational UX.

## Deferred Follow-Ups

These are reasonable future ideas, but they should not be part of v1:

- `acmd dev` for source-mode detached startup through `tsx`
- `acmd status` as a richer alias for `list`
- colored terminal output
- log filtering by level
- crash auto-restart policy
- multiple concurrent non-overlapping runtimes per repo

## Final Recommendation

The best version of this feature is not "make `acmd` a daemon manager".

The best version is:

- one small explicit CLI
- one active runtime per repo
- selector-based startup for `all` or a single agent
- detached start with clear state and logs
- safe restart with optional rebuild
- no hidden external infrastructure

That gives the user the operational command surface they want while keeping Agent Commander recognizably small.
