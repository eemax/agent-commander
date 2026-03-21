# Subagent Worker Implementation — v2 Spec

## Status

**v1 is complete and committed** (`8cf6028`). The full protocol surface is working:
- 7 tool actions: `spawn`, `recv`, `send`, `inspect`, `list`, `cancel`, `await`
- State machine with 11 states, 4 terminal
- Event protocol, budget enforcement, liveness, plan enforcement, observability
- 430 tests passing, clean type-check

**What's missing:** Real LLM worker execution. Tasks spawn, heartbeat, and sit in `running` forever because `NoOpWorker` does nothing. This spec covers building the real `SubagentWorker` that drives model inference and tool execution.

## Architecture Context

### How the orchestrator's own tool loop works

The orchestrator (main conversation) uses `runOpenAIToolLoop()` in `src/agent/tool-loop.ts`. It:
1. Sends a request to OpenAI via a transport (HTTP or WebSocket)
2. Gets back a response with optional `function_call` items
3. Executes each function call via the `ToolHarness`
4. Sends results back as `function_call_output` in the next request
5. Repeats until the model returns text without tool calls

Key signature:
```typescript
// src/agent/tool-loop.ts:160
runOpenAIToolLoop(params: {
  request: (body) => Promise<OpenAIResponsesResponse>;
  model: string;
  instructions: string;
  initialInput: OpenAIInputMessage[];
  thinkingEffort: ThinkingEffort;
  harness: ToolHarness;
  maxSteps: number | null;
  extractAssistantText: (response) => string;
  trace: TraceContext;
  abortSignal?: AbortSignal;
  steerChannel?: SteerChannel;
  onToolCall?: (event) => void;
  onToolProgress?: (event) => void;
  onResponse?: (response) => void;
  limits: { workflowTimeoutMs, commandTimeoutMs, pollIntervalMs, ... };
}): Promise<{ reply: string; finalResponse: OpenAIResponsesResponse }>
```

### How the provider creates a request function

`src/provider.ts` → `createOpenAIProvider()` creates a harness and request function, then wires them into `runOpenAIToolLoop`. The request function handles retries, streaming, and transport selection (HTTP/WS).

### How the SubagentManager interfaces with workers

```typescript
// src/harness/subagent-types.ts
type SubagentWorker = {
  start(task: SubagentTask): Promise<void>;  // Called on spawn
  stop(taskId: string, reason: string): Promise<void>;  // Called on cancel
  send(taskId: string, message: SupervisorMessage): Promise<void>;  // Called on send
};
```

The manager pushes events back through:
- `manager.pushWorkerEvent(taskId, kind, fields)` — worker reports progress/result/error
- `manager.recordTurnUsed(taskId)` — increment turn counter
- `manager.recordTokensUsed(taskId, count)` — increment token counter

### What the SubagentTask contains

When `start(task)` is called, the task has everything the worker needs:
- `task.goal` / `task.instructions` — the prompt
- `task.context` — arbitrary key-value context
- `task.artifacts` — file references
- `task.constraints` — budgets (time, turns, tokens), approval policy
- `task.execution.model` — resolved model ID from the catalog (e.g. `"gpt-5.4-mini"`)
- `task.execution.agentType` — `"coding"` (for now always this)
- `task.labels` — metadata

### Config available

The `SubagentManagerConfig` has `defaultModel` (already validated against `openai.models` catalog at config load time). The resolved model ID is stored on the task.

## Implementation Plan

### Step 1: Create `src/harness/subagent-worker.ts`

This is the core new file. It implements `SubagentWorker` and runs a tool loop per task.

```typescript
export function createSubagentWorker(deps: {
  config: Config;
  harness: ToolHarness;
  manager: SubagentManager;
  logger: RuntimeLogger;
  observability?: ObservabilitySink;
}): SubagentWorker
```

**`start(task)` implementation:**

1. Build the prompt from `task.goal`, `task.instructions`, and `task.context`
2. Resolve model settings from the catalog using `task.execution.model`
3. Create a scoped `ToolHarness` for the subagent:
   - The subagent should NOT have access to the `subagents` tool itself (spec invariant: no child spawning)
   - Consider creating a filtered tool set or using the existing `approval_policy` to block recursive spawn
4. Create a transport/request function (reuse `createResponsesRequestWithRetry` from `src/provider/responses-transport.ts`)
5. Create an `AbortController` keyed by `taskId` (for cancellation)
6. Run `runOpenAIToolLoop()` in the background (fire-and-forget with error handling)
7. Wire callbacks to push events back to the manager:
   - `onToolCall` → `pushWorkerEvent(taskId, "progress", ...)` or `pushWorkerEvent(taskId, "artifact", ...)`
   - `onToolProgress` → `pushWorkerEvent(taskId, "progress", ...)` with progress info
   - `onResponse` → `recordTurnUsed(taskId)`, extract usage for `recordTokensUsed(taskId, count)`
   - On completion → `pushWorkerEvent(taskId, "result", { result: { summary, outcome, ... } })`
   - On error → `pushWorkerEvent(taskId, "error", { error: { code, retryable, ... } })`

**`stop(taskId, reason)` implementation:**
- Abort the task's `AbortController`
- The tool loop will throw `ToolWorkflowAbortError`, which the worker catches and maps to a terminal event

**`send(taskId, message)` implementation:**
- Push the supervisor message into the task's `SteerChannel` (the tool loop already supports `steerChannel` for injecting messages between turns)
- This is how the orchestrator steers the subagent mid-execution

### Step 2: Wire the worker into `src/harness/index.ts`

Replace `NoOpWorker` with the real worker when creating the `SubagentManager`:

```typescript
const subagentWorker = createSubagentWorker({
  config, harness: /* the harness itself */, manager, logger, observability
});
const subagentManager = new SubagentManager(config, subagentWorker, observability);
```

**Circular dependency note:** The worker needs the manager (to push events), and the manager needs the worker (to call start/stop/send). Two approaches:
- **Option A (recommended):** Create the manager with `NoOpWorker` first, then create the worker with a reference to the manager, then call `manager.setWorker(worker)` (add a setter method)
- **Option B:** Pass the manager as a lazy getter `() => SubagentManager` to the worker

### Step 3: Scope the subagent's tool access

The subagent should NOT have access to spawn more subagents (spec invariant `no_child_spawn: true`). Options:
- Create a separate `ToolHarness` for subagent use that doesn't register the `subagents` tool
- Or use `ToolRegistry.execute()` to reject calls to `"subagents"` from a subagent context by checking context flags

The simplest approach: create the subagent's harness WITHOUT registering `subagentsTool`. The `createToolHarness` function already conditionally registers tools.

### Step 4: Handle plan enforcement integration

The tool loop should emit a `checkpoint` event with a plan early on. The worker can:
- Include plan-extraction instructions in the system prompt
- Parse the model's first response for a plan structure
- Push a `checkpoint` event with the plan to satisfy `require_plan_by_turn`

Alternatively, let the model use its own judgment — if it doesn't emit a plan, the manager's existing enforcement kicks in (transitions to `needs_steer` after N turns).

### Step 5: Handle approval policy

When `task.constraints.approvalPolicy.requiresSupervisorFor` includes certain action types, the worker should:
1. Before executing a tool call that matches a restricted action, pause execution
2. Push a `decision_request` event to the manager
3. Wait for the orchestrator to respond via `send` (the `SteerChannel` can carry this)
4. Resume or skip the tool call based on the response

This is the most complex part and could be deferred to a follow-up. For an initial working version, the approval policy can be documented but not enforced at the worker level.

### Step 6: Token tracking

`onResponse` from `runOpenAIToolLoop` gives access to `OpenAIResponsesResponse`. Extract usage:
```typescript
// The response object has usage fields
const inputTokens = response.usage?.input_tokens ?? 0;
const outputTokens = response.usage?.output_tokens ?? 0;
manager.recordTokensUsed(taskId, inputTokens + outputTokens);
```

This feeds into the budget enforcement system that already works.

### Step 7: Structured result construction

When the tool loop completes (model returns final text), the worker should construct a `TaskResult`:
```typescript
{
  summary: reply,  // The model's final text response
  outcome: "success",
  confidence: 1.0,
  deliverables: [],  // Could be populated from artifact events
  evidence: [],
  openIssues: [],
  recommendedNextSteps: []
}
```

For richer results, the system prompt can instruct the model to end with a structured JSON block that the worker parses.

### Step 8: Tests

Add tests in `test/harness.subagent-worker.test.ts`:
- Mock the transport (return canned OpenAI responses)
- Verify that `start()` triggers a tool loop and pushes events back to the manager
- Verify that `stop()` aborts the running loop
- Verify that `send()` injects messages via steer channel
- Verify token/turn tracking
- Verify the subagent cannot call the `subagents` tool

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/harness/subagent-types.ts` | All domain types including `SubagentWorker` interface |
| `src/harness/subagent-manager.ts` | Stateful manager — call `pushWorkerEvent`, `recordTurnUsed`, `recordTokensUsed` |
| `src/harness/subagent-tool.ts` | Tool definition — you shouldn't need to modify this |
| `src/harness/subagent-schemas.ts` | Zod schemas — you shouldn't need to modify this |
| `src/agent/tool-loop.ts` | `runOpenAIToolLoop()` — the loop to reuse |
| `src/provider.ts` | `createOpenAIProvider()` — reference for how to set up a request function |
| `src/provider/responses-transport.ts` | `createResponsesRequestWithRetry()` — the request function factory |
| `src/harness/index.ts` | Where the manager + worker are created and wired |
| `src/steer-channel.ts` | `SteerChannel` type — `push(message)` / `drain()` |
| `src/runtime/contracts.ts` | `Config` type with `subagents` section |

## Risks & Open Questions

1. **Circular dependency (manager ↔ worker):** Needs a setter or lazy pattern. See Step 2.
2. **Tool access scoping:** Subagents must not spawn children. Need a separate harness or registry filter.
3. **Approval policy enforcement:** Complex to implement properly. Recommend deferring to a follow-up and just logging a warning when a restricted action is attempted.
4. **SteerChannel for supervisor messages:** The existing `SteerChannel` is a simple `push/drain` queue. Verify it works for injecting mid-loop messages into the subagent's tool loop.
5. **Concurrency:** Multiple subagent tool loops run concurrently. Ensure the harness (especially `ProcessManager`) handles concurrent access correctly. Each subagent should probably get its own `ownerId` scoping.
6. **Model catalog resolution:** The `task.execution.model` is already a resolved model ID (validated at config load). But the tool loop needs the full `OpenAIModelCatalogEntry` to get `defaultThinking`, `contextWindow`, `compactionTokens`, etc. Use `resolveModelReference()` from `src/model-catalog.ts` at worker start time.
7. **Context window pressure:** Subagent tool loops running long tasks will accumulate context. Use the existing compaction mechanism (`compactionTokens` / `compactionThreshold` from the model catalog entry).

## Out of Scope for This Phase

- `resume` action (cancel + re-spawn is sufficient)
- Task dependency DAGs
- Persistent cross-session memory for subagents
- Event stream compaction API
- Real sandbox/network isolation
