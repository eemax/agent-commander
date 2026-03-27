# Tool Harness Reference

Agent Commander exposes a set of local trusted tools to the model via the OpenAI function calling interface. All tools execute within the runtime process and return normalized JSON envelopes.

## Output envelope

Every tool result follows a consistent shape:

```jsonc
// success
{ "ok": true, "summary": "...", "data": { ... }, "meta": { ... }? }

// failure
{ "ok": false, "summary": "...", "error": { "code": "...", "message": "...", "details": { ... }?, "retryable": true|false }, "meta": { ... }? }
```

- `summary` is always present (short human-readable description)
- `data` exists only on success, `error` only on failure
- Fields are snake_case; empty/noise fields are omitted

## Tools

### `bash`

Run a shell command in the local environment.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | string | yes | — | Shell command to execute |
| `cwd` | string | no | active conversation cwd (falls back to `tools.default_cwd`) | Working directory |
| `env` | object | no | — | Environment variables (string key-value pairs) |
| `timeoutMs` | integer | no | `tools.exec_timeout_ms` | Command timeout in ms |
| `yieldMs` | integer | no | `tools.exec_yield_ms` | Max wait before returning running status |
| `background` | boolean | no | false | Return immediately with sessionId |
| `shell` | string | no | `tools.default_shell` | Shell executable path |

**Behavior:**
- Validates `cwd` is an existing directory before execution
- If `background=true`, returns a `sessionId` immediately without waiting
- If command completes within `yieldMs`, returns completed output
- If command is still running after `yieldMs`, returns running tail + `sessionId` for polling via `process`
- Output truncated at `tools.max_output_chars` (default 200K chars)

### `process`

Manage long-running bash sessions. Uses a discriminated union on `action`.

#### `action: "list"`

List all active sessions for the current owner. No additional parameters.

#### `action: "poll"`

Get new output since last poll.

| Parameter | Type | Required |
|-----------|------|----------|
| `sessionId` | string | yes |

Returns delta output (only unread content since last poll/clear).

#### `action: "log"`

Get tail of combined output.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `sessionId` | string | yes | — |
| `tailLines` | integer | no | `tools.process_log_tail_lines` |

Returns last N lines (absolute, not delta).

#### `action: "write"`

Write to a running process's stdin.

| Parameter | Type | Required |
|-----------|------|----------|
| `sessionId` | string | yes |
| `input` | string | yes |

#### `action: "kill"`

Send a signal to a running process.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `sessionId` | string | yes | — |
| `signal` | string | no | `"SIGTERM"` |

Signals the process group (falls back to child process on non-Unix).

#### `action: "clear"`

Reset read offsets without discarding output. Useful to re-read output via subsequent `poll`.

| Parameter | Type | Required |
|-----------|------|----------|
| `sessionId` | string | yes |

#### `action: "remove"`

Delete a completed session record. Fails if the process is still running.

| Parameter | Type | Required |
|-----------|------|----------|
| `sessionId` | string | yes |

**Process lifecycle:**
- Sessions are owner-scoped — only the creating owner can access them
- Completed sessions auto-prune after `tools.completed_session_retention_ms` or when exceeding `tools.max_completed_sessions`
- Output per stream (stdout, stderr, combined) is independently bounded by `tools.max_output_chars`
- Timed-out processes receive SIGKILL and are flagged as timed out

### `read_file`

Read a text file with optional line-based slicing.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `path` | string | yes | — |
| `offsetLine` | integer | no | 1 |
| `limitLines` | integer | no | all |
| `encoding` | string | no | `"utf8"` |

**Returns:** `path`, `content`, `startLine`, `endLine`, `totalLines`, `truncated`

- Line numbers are 1-indexed
- Only `utf8`/`utf-8` encoding is supported
- Missing files raise `"File not found"` error

### `write_file`

Create or overwrite a file with exact content.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `path` | string | yes | — |
| `content` | string | yes | — |
| `encoding` | string | no | `"utf8"` |

**Returns:** `path`, `size` (byte length)

- Automatically creates parent directories
- Overwrites existing files completely

### `replace_in_file`

Replace exact text in a file.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `path` | string | yes | — |
| `oldText` | string | yes | — |
| `newText` | string | yes | — |
| `replaceAll` | boolean | no | false |

**Returns:** `path`, `replacements` (count)

- Exact substring matching (not regex)
- Fails if `oldText` not found
- Fails if multiple matches exist and `replaceAll` is not `true`
- `newText` can be empty for deletion

### `apply_patch`

Apply patch text. Supports unified diffs and Codex-style patch blocks.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `patch` | string | yes | — |
| `cwd` | string | no | workspace root |

**Patch formats:**

1. **Codex format** — detected by `*** Begin Patch` marker:
   - `*** Add File: path` — create new file (lines prefixed with `+`)
   - `*** Delete File: path` — remove file
   - `*** Update File: path` — modify file with hunks (`@@` separator, ` `/`+`/`-` line prefixes)
   - `*** Move to: newpath` — rename during update
   - `*** End Patch` — terminator

2. **Unified diff** — auto-detected if not Codex:
   - In git repos: applied via `git apply --recount --whitespace=nowarn`
   - Non-git repos: falls back to `patch -p0 -u`

**Returns:** `engine` (`"codex"` | `"git-apply"` | `"patch"`), `operations` (count, Codex only)

### `web_search`

Search the web via Perplexity API.

| Parameter | Type | Required |
|-----------|------|----------|
| `query` | string | yes |

**Returns:** `query`, `model`, `response_text`, `citations`, `search_results`

- Requires `DEFAULT_PERPLEXITY_API_KEY` to be set (disabled when unset)
- Preset determined by `tools.web_search.default_preset` and `tools.web_search.presets`

### `web_fetch`

Fetch content from a URL and extract as markdown.

| Parameter | Type | Required |
|-----------|------|----------|
| `url` | string | yes |

**Returns:** `url`, `mode` (`"defuddle"`), `content` (extracted markdown)

- URL must be valid HTTP(S)
- Uses external `defuddle` CLI tool (`defuddle parse {url} --md`)
- Timeout inherited from `tools.exec_timeout_ms`
- Max buffer: 8 MB
- Fails if `defuddle` is not installed or returns empty output

### `subagents`

Manage subagent tasks — disposable, protocol-driven work sessions. Uses a discriminated union on `action`.

#### `action: "spawn"`

Create and start a new subagent task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task.title` | string | yes | Short human-readable label |
| `task.goal` | string | yes | What success looks like |
| `task.instructions` | string | yes | Behavioral guidance for the subagent |
| `task.context` | object | no | Arbitrary key-value context |
| `task.artifacts` | array | no | Files/resources available to subagent |
| `task.constraints` | object | no | Budget and policy overrides (see below) |
| `task.execution` | object | no | Agent type, model, liveness config |
| `task.completion_contract` | object | no | Require summary/structured result |
| `task.labels` | object | no | Arbitrary string labels for filtering |

**Constraints (all optional, defaults from config):**
- `time_budget_sec`, `max_turns`, `max_total_tokens` — budget limits
- `require_plan_by_turn` — plan enforcement deadline (0 to disable)
- `sandbox`, `network` — execution environment
- `approval_policy` — action permissions (`can_edit_code`, `can_run_tests`, `can_open_pr`, `requires_supervisor_for`)

**Completion contract:**
- `require_final_summary` — final reply must contain a concise human summary
- `require_structured_result` — final reply must include a machine-readable `TASK_RESULT` payload
- Structured result fields: `summary`, `outcome`, `confirmed`, `inferred`, `unverified`, `deliverables`, `open_issues`, `recommended_next_steps`, `decision_journal`

**Returns:** `taskId`, `state`, `cursor`, `leaseExpiresAt`, `startedAt`

#### `action: "recv"`

Poll events from one or more tasks. Non-blocking.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tasks` | object | yes | Map of `taskId → lastCursor` |
| `wait_ms` | integer | no | Long-poll wait (default from config) |
| `max_events` | integer | no | Max events returned (capped by config) |

**Returns:** `events` array, `cursors` map (updated per-task cursors for next call)

#### `action: "send"`

Send a steering message to a task that needs input.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | yes | Target task |
| `message.role` | `"supervisor"` | yes | Always "supervisor" |
| `message.content` | string | yes | Message content |
| `message.directive_type` | string | no | `guidance` (default), `correction`, `override`, `approval`, `answer` |

Only valid when `turn_ownership` is `supervisor` or `user`. Returns error if task is terminal or worker is busy.

#### `action: "inspect"`

Get current snapshot of a task.

| Parameter | Type | Required |
|-----------|------|----------|
| `task_id` | string | yes |

**Returns:** Full `TaskSnapshot` including state, progress, budget usage, awaiting info, result/error.

#### `action: "list"`

List tasks matching optional filters.

| Parameter | Type | Required |
|-----------|------|----------|
| `filter.states` | string[] | no |
| `filter.labels` | object | no |

#### `action: "cancel"`

Terminate a task from any non-terminal state.

| Parameter | Type | Required |
|-----------|------|----------|
| `task_id` | string | yes |
| `reason` | string | yes |

#### `action: "await"`

Block until a condition is met or timeout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | yes | Task to wait on |
| `until` | string[] | yes | Conditions: `requires_response`, `terminal`, `any_event`, `progress` |
| `timeout_ms` | integer | yes | Max wait (capped by config `await_max_timeout_ms`) |

**Task lifecycle:**
- Tasks transition through: `queued → starting → running` on spawn
- Runtime emits heartbeats, detects stalls, enforces budgets (turns, tokens, time)
- Budget warnings emitted at 80% usage; hard cutoff at 100% → `timed_out`
- Plan enforcement: if no checkpoint with plan by `require_plan_by_turn`, task → `needs_steer`
- Terminal states: `completed`, `failed`, `cancelled`, `timed_out`
- Every spawned task is guaranteed to reach a terminal state
- Final structured results are expected to separate `confirmed`, `inferred`, and `unverified`

**Observability events:**
- `subagent.task.spawned` — task created (includes goal, instructions, context)
- `subagent.task.state_change` — non-terminal state transitions (`needs_steer`, `needs_input`, `stalled`)
- `subagent.task.terminal` — task reached terminal state (includes result/error payloads)
- `subagent.supervisor.sent` — supervisor message delivered (includes content)
- `subagent.worker.question` — subagent needs supervisor input
- `subagent.worker.result` — subagent produced a result
- `subagent.budget.warning` — budget 80% threshold crossed

See [subagents.md](subagents.md) for the full subagent reference (inheritance, system message, lifecycle).

## Tool registry internals

Tools are registered at startup via `ToolRegistry`. Schema conversion for OpenAI:
- Zod schemas are converted to JSON Schema 7 via `zod-to-json-schema`
- Top-level `anyOf`/`oneOf`/`allOf` are flattened into object properties (OpenAI requires `type: "object"` root)
- Provider tool definitions are cached and invalidated on new registrations

Error handling on invalid tool calls:
- Unknown tool name: `TOOL_VALIDATION_ERROR` (retryable, with hint)
- Invalid arguments: `TOOL_VALIDATION_ERROR` (retryable, with auto-generated hints for type mismatches, missing fields, etc.)
- Execution errors: preserved with original error structure and retryability flag
