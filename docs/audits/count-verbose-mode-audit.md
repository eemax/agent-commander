# Audit Plan: Count Verbose Mode

**Feature:** Alternative "count" verbose tool calls mode alongside existing "full" mode
**Scope:** 13 source files changed, 6 test files updated

## Objective

Audit the count verbose mode feature for correctness, backward compatibility, UI behavior, and consistency with existing patterns. The auditor should read every changed file and verify each concern below.

---

## 1. Type System & Config Audit

### 1.1 VerboseMode type
- [ ] `src/types.ts`: Verify `VERBOSE_MODE_VALUES` contains exactly `["full", "count", "off"]` and `VerboseMode` is derived from it
- [ ] `src/utils.ts`: Verify `isVerboseMode()` type guard uses a `Set` constructed from `VERBOSE_MODE_VALUES` (same pattern as `isThinkingEffort`, `isCacheRetention`, etc.)
- [ ] Verify `VERBOSE_MODE_VALUES` and `VerboseMode` are exported from `types.ts`
- [ ] Verify `isVerboseMode` is exported from `utils.ts`

### 1.2 Config schema
- [ ] `src/config.ts`: Verify `DEFAULT_CONFIG_TEMPLATE.runtime.default_verbose` is `"full"` (not `true`)
- [ ] Verify Zod schema for `default_verbose` accepts both `VerboseMode` strings and booleans via `z.union([z.enum(...), z.boolean().transform(...)])`
- [ ] Verify `true` transforms to `"full"` and `false` transforms to `"off"` in the boolean branch
- [ ] Verify the transform return type annotation is correct (no `as const` on ternary — should use explicit return type)
- [ ] Verify `Config.runtime.defaultVerbose` type in `src/runtime/contracts.ts` is `VerboseMode` (not `boolean`)

### 1.3 Config propagation
- [ ] `src/runtime/bootstrap.ts`: Verify `config.runtime.defaultVerbose` is passed through to `createConversationStore()` as `defaultVerboseMode`
- [ ] Verify no intermediate mapping step loses the type (trace the value from Zod output → `Config` type → bootstrap → conversation store)

---

## 2. State Layer Audit

### 2.1 ConversationRuntimeProfile
- [ ] `src/state/conversations.ts`: Verify `verboseMode` field type is `VerboseMode` (not `boolean`)
- [ ] Verify `createDefaultRuntimeProfile()` assigns from `params.defaultVerboseMode` (type `VerboseMode`)
- [ ] Verify `cloneRuntimeProfile()` copies `verboseMode` through (type flows automatically)

### 2.2 Normalization (backward compatibility)
- [ ] `normalizeRuntimeProfile()`: Verify it handles all legacy cases:
  - `isVerboseMode(value.verboseMode)` → pass through (valid string)
  - `value.verboseMode === true` → normalize to `"full"`
  - `value.verboseMode === false` → normalize to `"off"`
  - Any other value → fall back to `defaults.defaultVerboseMode`
- [ ] Verify the evaluation order is correct (check `isVerboseMode` first, then boolean checks, then default)
- [ ] Manually test: create a conversation JSON file with `"verboseMode": true`, load it, verify it reads as `"full"`
- [ ] Same test with `"verboseMode": false` → `"off"`
- [ ] Same test with `"verboseMode": "count"` → `"count"`
- [ ] Same test with `"verboseMode": "garbage"` → falls back to config default

### 2.3 Defaults fallback
- [ ] Verify the `defaults` object in the store constructor uses `params.defaultVerboseMode ?? "full"` (not `?? true`)

### 2.4 StateStore interface
- [ ] `src/runtime/contracts.ts`: Verify `getVerboseMode()` returns `Promise<VerboseMode>`
- [ ] Verify `setVerboseMode()` accepts `mode: VerboseMode` (not `enabled: boolean`)
- [ ] Verify the `VerboseMode` import is present in contracts.ts

### 2.5 get/setVerboseMode implementation
- [ ] `src/state/conversations.ts`: Verify `getVerboseMode()` return type annotation is `Promise<VerboseMode>`
- [ ] Verify `setVerboseMode()` parameter is named `mode` (not `enabled`) and typed as `VerboseMode`
- [ ] Verify the observability record still fires with `setting: "verboseMode"` and `value: mode`
- [ ] Verify the equality check (`ensured.record.runtime.verboseMode === mode`) short-circuits correctly for all three string values

### 2.6 All `defaultVerboseMode` parameter types
- [ ] Grep for all occurrences of `defaultVerboseMode` in `conversations.ts` — verify ALL are typed `VerboseMode` (not `boolean`)
- [ ] Check `ConversationStoreParams`, `createDefaultRuntimeProfile` params, `normalizeRuntimeProfile` defaults, `parseCurrentConversationsIndex` defaults, `parseActiveConversationsIndex` defaults

---

## 3. Formatter Audit

### 3.1 CountAccumulatorEntry type
- [ ] `src/routing/formatters.ts`: Verify `CountAccumulatorEntry` has fields: `emoji`, `label`, `count`, `failed`, `chars`, `trackChars`
- [ ] Verify `failed` is `number` (not optional)

### 3.2 TOOL_META mapping
- [ ] Verify all tool names registered in `src/harness/index.ts` have a corresponding entry in `TOOL_META`
- [ ] Verify emoji/label assignments are sensible:
  - `read_file` → 📖 Read (trackChars: true)
  - `write_file` → ✍️ Write (trackChars: true)
  - `bash` → 🐚 Bash (trackChars: true)
  - `replace_in_file` → 🔁 Replace (trackChars: false)
  - `apply_patch` → 🩹 Patch (trackChars: false)
  - `process` → ⚙️ Process (trackChars: false)
  - `web_fetch` → 🔗 Web fetch (trackChars: true)
  - `web_search` → 🔎 Web search (trackChars: true)
  - `subagents` → 🤖 Subagent (trackChars: false)
- [ ] Verify unknown tools fall back to `{ emoji: "🔧", label: report.tool, trackChars: false }`

### 3.3 extractCountUpdate char extraction
- [ ] Verify chars are only extracted when `meta.trackChars && report.success` (failed calls should not contribute to char count)
- [ ] Verify `read_file` extracts `result.content.length` — cross-reference with `formatVerboseToolCallNotice` line ~268 to confirm field name
- [ ] Verify `write_file` extracts `args.content.length` first, falls back to `result.size` — cross-reference with full-mode formatter lines ~275-278
- [ ] Verify `bash` extracts `result.combined.length` first, falls back to `result.stdout.length` — cross-reference with `getExecCompletedOutput` in `process-manager.ts` to confirm result shape
- [ ] Verify `web_fetch` extracts `result.content.length` — cross-reference with `web-fetch-tool.ts` return shape `{ url, mode, content }`
- [ ] Verify `web_search` extracts `result.response_text.length` — cross-reference with `web-search-tool.ts` return shape `{ query, model, response_text, citations, search_results }`
- [ ] Verify the `success` field is returned in the `CountUpdate` and correctly reflects `report.success`

### 3.4 formatCountModeBuffer output
- [ ] Verify output format: `{emoji} {label} ×{count}` for each tool type
- [ ] Verify char suffix format: ` ({compactNumber} chars)` — only when `trackChars && chars > 0`
- [ ] Verify failed suffix format: ` · {N} failed` — only when `failed > 0`
- [ ] Verify tools are listed in insertion order (Map iteration order = first-seen order)
- [ ] Verify lines are joined with `\n` (not `\n\n`)
- [ ] Verify `formatCompactNumber()` is used for char counts (not raw numbers)
- [ ] Edge case: verify a tool with only failed calls shows `×N · N failed` with 0 chars (no char suffix)

### 3.5 Process tool emoji consistency
- [ ] Verify the process tool emoji in `TOOL_META` matches the one in `formatVerboseToolCallNotice` (both should be ⚙️)
- [ ] Verify the old `>_` prefix is no longer used anywhere

---

## 4. Assistant Turn Logic Audit

### 4.1 Verbose mode resolution
- [ ] `src/routing/assistant-turn.ts`: Verify `verboseMode` is fetched from `conversations.getVerboseMode()` (not `verboseEnabled`)
- [ ] Verify no references to `verboseEnabled` remain in the source (only in pre-existing test files)

### 4.2 Count mode accumulator
- [ ] Verify `toolCallAccumulator` is `new Map<string, CountAccumulatorEntry>()`
- [ ] Verify `countModeBufferIndex` is initialized to `-1`
- [ ] Verify both are scoped inside the returned async function (per-turn lifetime, reset between turns)

### 4.3 onToolCall branching
- [ ] Verify `"full"` mode: existing behavior preserved identically (format + send/buffer)
- [ ] Verify `"count"` mode: calls `extractCountUpdate`, updates accumulator, calls `formatCountModeBuffer`, prefixes with `VERBOSE_REPLACE_PREFIX`
- [ ] Verify `"off"` mode: no notice is generated (neither full nor count)
- [ ] Verify `recordToolResult()` is always called regardless of verbose mode (it's outside the mode branching)

### 4.4 Count accumulator update logic
- [ ] Verify existing entry: `count += 1`, `chars += update.chars`, `failed += 1` if `!update.success`
- [ ] Verify new entry: `count: 1`, `failed: update.success ? 0 : 1`, `chars: update.chars`, plus emoji/label/trackChars from update
- [ ] Verify the Map key is `report.tool` (tool name string)

### 4.5 Streaming path (onToolCallNotice callback present)
- [ ] Verify notice is `VERBOSE_REPLACE_PREFIX + buffer` (entire buffer, not delta)
- [ ] Verify this is called on every tool call (not just new tool types) so counts update in real-time

### 4.6 Non-streaming path (verboseReplies array)
- [ ] Verify `countModeBufferIndex >= 0`: overwrites `verboseReplies[countModeBufferIndex]`
- [ ] Verify `countModeBufferIndex < 0`: pushes new entry, saves index
- [ ] Verify the stored string is the raw buffer (no `VERBOSE_REPLACE_PREFIX` — prefix is only for streaming)

### 4.7 Steer notice and fallback
- [ ] Verify steer notices (`onToolProgress` with `type === "steer"`) fire when `verboseMode !== "off"` (not just when `=== "full"`)
- [ ] Verify `includeDetail` in provider fallback text uses `verboseMode !== "off"` (not a boolean comparison)

---

## 5. Telegram Bot Audit

### 5.1 Replace prefix handling
- [ ] `src/telegram/bot.ts`: Verify `VERBOSE_REPLACE_PREFIX` is imported from `../routing/formatters.js`
- [ ] Verify the replace-prefix detection is the FIRST check after the `typeof`/empty guard in `onToolCallNotice`
- [ ] Verify when prefix detected: `toolCallBuffer` is SET (not appended), prefix is stripped
- [ ] Verify the `TELEGRAM_MESSAGE_LIMIT` truncation is applied to the stripped content
- [ ] Verify after replacing: `flushToolCallDraft(false)` and `startToolCallTypingIndicator()` are called
- [ ] Verify the replace path returns early (does NOT fall through to the append logic)
- [ ] Verify the replace path only flushes when `!textStreamingStarted` (matches intended behavior — once text streaming starts, tool call buffer is already committed)

### 5.2 Existing append logic preserved
- [ ] Verify the existing append logic (delimiter, candidate, overflow handling) is completely unchanged
- [ ] Verify `lateToolCallNotices` handling for `textStreamingStarted` is unchanged

### 5.3 Typing animation
- [ ] Verify the typing animation (`startToolCallTypingIndicator`) works correctly in count mode — it appends frames to `toolCallBuffer`, which now contains the count summary
- [ ] Verify rapid consecutive tool calls don't cause visual glitches (the `draftMinUpdateMs` throttle should handle this)

---

## 6. Command & UI Audit

### 6.1 /verbose command
- [ ] `src/routing/core-commands.ts`: Verify accepted arguments: `"full"` → `"full"`, `"count"` → `"count"`, `"off"` → `"off"`
- [ ] Verify no `"on"` alias exists (only the three canonical values are accepted)
- [ ] Verify no-argument shows usage and current mode: `Usage: /verbose <full|count|off>\nverbose mode: {current}`
- [ ] Verify invalid arguments also show the usage message (not an error)
- [ ] Verify reply text format: `verbose mode: full`, `verbose mode: count`, `verbose mode: off`

### 6.2 Telegram command description
- [ ] `src/telegram/commands.ts`: Verify description updated to mention `full|count|off` (not just `on|off`)

### 6.3 Status display
- [ ] `src/routing/formatters.ts` in `buildStatusReply()`: Verify verbose line shows mode name directly (`verbose: full`, `verbose: count`, `verbose: off`) instead of `verbose: on`/`verbose: off`
- [ ] Verify the parameter name changed from `verboseEnabled` to `verboseMode` in the `buildStatusReply` params type
- [ ] Verify all callers of `buildStatusReply` pass `verboseMode` (not `verboseEnabled`)

---

## 7. Test Coverage Audit

### 7.1 Updated test assertions
- [ ] `test/config.test.ts`: Verify `defaultVerbose` assertion changed from `true` to `"full"`
- [ ] `test/helpers.ts`: Verify `makeConfig()` uses `defaultVerbose: "full"` (not `true`)
- [ ] `test/conversations.test.ts`: Verify all `defaultVerboseMode` params use `"full"` or `"off"` (not booleans)
- [ ] Verify all `getVerboseMode()` assertions compare to `"full"`/`"off"` (not `true`/`false`)
- [ ] Verify all `setVerboseMode()` calls pass `"off"` or `"full"` (not `false`/`true`)
- [ ] `test/routing.test.ts`: Verify verbose command test expects `"full"` in usage text and mode display
- [ ] Verify status output assertion checks for `verbose: full` (not `verbose: on`)
- [ ] `test/routing.formatters.test.ts`: Verify `baseParams` uses `verboseMode: "off"` and overrides use `"full"`
- [ ] `test/harness.subagent-worker.test.ts`: Verify uses `defaultVerbose: "off"` (not `false`)

### 7.2 Missing test coverage (recommendations)
- [ ] No unit test for `extractCountUpdate()` — recommend tests for each tool type verifying emoji, label, chars, and trackChars
- [ ] No unit test for `formatCountModeBuffer()` — recommend tests for: single entry, multiple entries, entries with chars, entries without chars, entries with failures, mixed
- [ ] No unit test for backward-compatible normalization of persisted `verboseMode: true`/`false` — recommend explicit test case
- [ ] No integration test for `/verbose count` command — recommend adding
- [ ] No test for count mode accumulator behavior in assistant-turn (multiple calls of same tool type incrementing count)
- [ ] No test for the `VERBOSE_REPLACE_PREFIX` detection in the Telegram bot handler
- [ ] No test for the `failed` counter in count mode (tool call with `success: false` should increment `failed`)

---

## 8. Edge Cases

### 8.1 Empty state
- [ ] Verify count mode with zero tool calls produces no notice (accumulator is empty, `formatCountModeBuffer` returns empty string — does the empty string get sent?)
- [ ] If it does, verify the Telegram bot handles an empty replace-prefix notice gracefully

### 8.2 Very high tool counts
- [ ] Verify a turn with many distinct tool types (all 9+) stays under `TELEGRAM_MESSAGE_LIMIT` for the draft message
- [ ] Verify `formatCompactNumber` handles very large char counts (millions) correctly

### 8.3 Mode switching mid-conversation
- [ ] Switch from `full` to `count` between turns — verify the next turn starts with a fresh accumulator
- [ ] Switch from `count` to `full` between turns — verify full-mode notices are not prefixed with `VERBOSE_REPLACE_PREFIX`
- [ ] Switch from `count` to `off` mid-turn (via steer?) — verify behavior is consistent (steer can't change verbose mode mid-turn, so this should be safe)

### 8.4 Failed tool calls in count mode
- [ ] Verify a failed tool call increments both `count` and `failed`
- [ ] Verify a failed tool call does NOT add to `chars` (the `trackChars && report.success` guard prevents this)
- [ ] Verify the display: `🐚 Bash ×3 (2K chars) · 1 failed` — chars only count successful calls, failed count is separate
