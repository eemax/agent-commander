# Subagents

Subagents are disposable, protocol-driven work sessions that the supervisor can spawn to delegate tasks. Each subagent runs its own LLM tool loop with config-owned policy, liveness tracking, and a structured event protocol for supervisor–subagent communication.

## How It Works

1. The supervisor calls `subagents` tool with `action: "spawn"` and a task definition (goal, instructions, context, labels, completion contract).
2. The runtime creates a `SubagentTask`, starts a dedicated LLM tool loop for it, and returns a `taskId` + `cursor`.
3. The subagent works autonomously — calling tools, reasoning, making progress.
4. The supervisor polls events via `recv` or blocks via `await` to track progress.
5. When the subagent finishes, it emits a `result` event. If it gets stuck, it emits a `question` event and waits for supervisor guidance via `send`.

## What Subagents Inherit from the Supervisor

### Tools

Subagents get **all supervisor tools except `subagents`** (no recursive spawning). Specifically:

- `bash` — shell execution
- `process` — long-running process management
- `glob` — file discovery via ripgrep globs
- `grep` — text search via ripgrep
- `read_file` — file reading
- `write_file` — file creation/overwrite
- `replace_in_file` — text replacement
- `apply_patch` — unified diff / Codex patch application
- `web_fetch` — URL content extraction
- `web_search` — Perplexity search (if configured)

Tool filtering is in `src/harness/subagent-worker.ts` via `createScopedHarness()`.

### Working Directory (CWD)

Subagents **inherit the supervisor's per-conversation CWD** at spawn time. If the supervisor changed the working directory via `/cwd /some/path`, the subagent operates in that directory.

The CWD is resolved once at spawn via `resolveDefaultCwd(task.ownerId)` and baked into the scoped harness config. It does not change if the supervisor changes CWD mid-task.

### Skills

Subagents do **not** have access to skills. Skills are a routing-layer feature (triggered by `/<slug>` commands in Telegram) and are injected into the supervisor's system prompt only. The subagent's system instructions have no awareness of the skill catalog.

### Model and Inference Settings

| Setting | Subagent behavior |
|---------|-------------------|
| **Model** | Resolved from `subagents.default_model` in config (default: `gpt-5.4-mini`). |
| **Thinking effort** | Uses the resolved model's `default_thinking` from the model catalog. Does not inherit the supervisor's per-conversation `/thinking` override. |
| **Cache retention** | Hardcoded to `"in_memory"` for prompt cache. Does not inherit the supervisor's `/cache` override. |
| **Compaction** | Uses the resolved model's `compaction_tokens` and `compaction_threshold` from the model catalog. |
| **Auth mode** | Inherits the supervisor's per-conversation auth mode at spawn time (snapshot). If the supervisor is using codex mode, the subagent runs its tool loop in stateless mode (accumulating full history instead of using `previous_response_id`). |
| **Transport** | Inherits the supervisor's per-conversation transport mode at spawn time (snapshot). Does not change if the supervisor switches transport mid-task. |
| **Web search model** | Uses the global default preset (`tools.web_search.default_preset`). Does not inherit the supervisor's per-conversation `/search` override. |

## System Message

The subagent LLM receives a dynamically built system message (`instructions` field on the Responses API call) containing:

1. **Role preamble** — "You are a subagent working on a specific task assigned by a supervisor."
2. **Goal** — `task.goal`
3. **Instructions** — `task.instructions` (if provided)
4. **Context** — key-value entries from `task.context` (if any)
5. **Configured caps** — included only when `maxTurns`, `timeBudgetSec`, or `maxTotalTokens` are configured
6. **Completion protocol** — must end every non-tool-call response with `[TASK_COMPLETE]` or `[NEEDS_INPUT]`
7. **Asking for help** — instructions for using `[NEEDS_INPUT]` when blocked

The first user message is `task.goal` (so the goal appears in both system and user context).

Built by `buildSystemInstructions()` in `src/harness/subagent-worker.ts`.

## Task Lifecycle

```
queued → starting → running ──→ completed
                      │    ↘──→ failed
                      │    ↘──→ timed_out
                      │    ↘──→ cancelled
                      ↓
                 needs_steer ──→ (supervisor sends) → running
                 needs_input ──→ (supervisor sends) → running
                 stalled ──────→ failed
```

- **needs_steer**: subagent sent `[NEEDS_INPUT]` — waiting for supervisor guidance via `send`.
- **needs_input**: subagent requested user-facing input — waiting for supervisor to relay answer.
- **stalled**: no activity for `default_idle_timeout_sec` — auto-fails after `default_stall_timeout_sec`.
- Budget warnings fire at 80% of turns/tokens/time only when those caps are configured. Hard cutoff at 100%.

## Pause and Resume

When a subagent sends `[NEEDS_INPUT]`, the LLM tool loop pauses. Resume behavior depends on the auth mode:

- **API mode (stateful):** The `previous_response_id` is stored. On resume, a new tool loop iteration starts with the supervisor's message as a user turn and `previous_response_id` injected for conversation continuity.
- **Codex mode (stateless):** The `accumulatedInput` (full conversation history) is persisted instead. On resume, the tool loop reconstructs the full stateless input and continues without `previous_response_id`.

Both modes preserve the subagent's full conversation context across pause/resume cycles.

If the subagent is still running (hasn't paused), `send` injects the message via the steer channel instead — the same mechanism as `/steer` for the supervisor.

## Observability

When `observability.enabled` is `true`, the following events are emitted to `observability.log_path`:

| Event | When | Payload includes |
|-------|------|------------------|
| `subagent.task.spawned` | Task created | `title`, `goal`, `instructions`, `context`, `constraints`, `labels` |
| `subagent.task.state_change` | Non-terminal state transitions | `state`, `kind`, `turnOwnership`, `message` |
| `subagent.task.terminal` | Task reached terminal state | `state`, `kind`, `message`, `result`, `error`, `turnsUsed`, `tokensUsed`, `elapsedSec` |
| `subagent.supervisor.sent` | Supervisor message delivered | `directiveType`, `content`, `contentLength` |
| `subagent.worker.question` | Subagent needs input | `kind`, `message`, `options` |
| `subagent.worker.result` | Subagent produced result | `message`, `result`, `partialResult` |
| `subagent.budget.warning` | Budget 80% threshold | `resource`, `used`, `limit`, `percent` |
| `subagent.worker.start_failed` | Worker failed to start | `error` |
| `subagent.worker.send_failed` | Failed to deliver message | `error` |

All events include trace context (`traceId`, `spanId`) for correlation. Content fields are subject to the observability sink's truncation (`max_string_chars`) and redaction rules.

## Audit Log

When `subagents.enabled` is `true`, runtime also appends a dedicated audit stream to `subagents.log_path` (default: `.agent-commander/subagents.jsonl`).

This log is additive and distinct from `tool-calls.jsonl` and `observability.jsonl`. It captures:

- `supervisor_tool_call` — top-level `subagents` tool actions (`spawn`, `send`, `inspect`, etc.)
- `task_event` — every durable subagent event written by the manager
- `exchange` — full supervisor-to-subagent and subagent-to-supervisor messages
- `worker_tool_call` — subagent-internal tool executions with `owner_id` and `task_id` correlation

Entries are append-only JSONL, keyed around `task_id`, and use the same redaction/truncation behavior as observability.

## Terminal Retention

- Terminal tasks (`completed`, `failed`, `cancelled`, `timed_out`) are retained in memory for up to 10 minutes.
- The manager also caps retained terminal tasks at 20 and drops the oldest terminal entries first.
- Non-terminal tasks are never pruned by this retention pass, including `running`, `needs_steer`, `needs_input`, and `stalled`.
- When a terminal task is pruned, its task record, event stream, trace context, and latest progress snapshot are all removed together.

## Telegram Tool Notices

Subagent tool calls use action-specific messages instead of a generic "Tool: subagents" notice:

- `🤖 Spawn subagent: \`{title}\``
- `📥 Recv: {count} task(s)`
- `💬 Send to subagent: \`{task_id}\``
- `🔍 Inspect: \`{task_id}\``
- `📋 List subagents`
- `❌ Cancel: \`{task_id}\``
- `⏳ Await: \`{task_id}\``

Failed actions show `⚠️ Subagent \`{action}\` failed: {error}`.

## Configuration

All settings are in `config/config.json` under the `subagents` key. See [config-reference.md](config-reference.md#subagents) for the full schema.

If you are upgrading an older config, remove `default_require_plan_by_turn`; that setting was deleted and strict config validation now rejects it.

Key defaults:

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Register the subagents tool |
| `max_concurrent_tasks` | `10` | Simultaneous non-terminal tasks |
| `default_time_budget_sec` | `null` | Per-task time limit (`null` disables the cap) |
| `default_max_turns` | `null` | Per-task LLM turn limit (`null` disables the cap) |
| `default_max_total_tokens` | `null` | Per-task cumulative token limit (`null` disables the cap) |
| `default_model` | `gpt-5.4-mini` | Default model for subagent inference |

## Key Files

| File | Role |
|------|------|
| `src/harness/subagent-tool.ts` | Supervisor-facing tool (7 actions) |
| `src/harness/subagent-worker.ts` | LLM execution, scoped harness, system prompt |
| `src/harness/subagent-manager.ts` | State machine, event protocol, config-owned cap enforcement |
| `src/harness/subagent-types.ts` | Type definitions (task, event, result, constraints) |
| `src/harness/subagent-schemas.ts` | Zod input schemas for the tool |
