# Plan: Unify fallback with reply path (show all partials)

## Goal

Remove the "safe path" distinction for `fallback`. Fallback replies should include
the full transcript (tool notices, system notes, **and** partial text blocks) —
identical to how `reply` builds its final message. The user wants raw output, no
sanitization.

## Current behavior

1. **`reply` path** (`text-dispatch.ts:415-425`):
   calls `transcript.buildFinalReplyText(cleanText)` which uses
   `renderFullTranscript()` — all entry kinds included.

2. **`fallback` path** (`text-dispatch.ts:427-435`):
   sends `cleanText` only — transcript is deliberately excluded.

3. **`renderSafeTranscript()`** (`stream-transcript.ts:219-224`):
   filters to only `tool_notice` and `system_note`, excluding `text_block`.
   Currently unused in the dispatch paths but exists as the "safe" API.

## Changes

### 1. `src/telegram/text-dispatch.ts` — make fallback use the same assembly as reply

In the `case "fallback"` block (~line 427-435), change it to build the final text
through `transcript.buildFinalReplyText(cleanText)` instead of sending bare
`cleanText`. The block should also respect `result.origin` like `reply` does
(falling back to `"system"` if absent).

After this change the two cases are nearly identical — consider collapsing them
into a shared handler (e.g. `case "reply": case "fallback": { ... }`).

### 2. `src/telegram/stream-transcript.ts` — delete `renderSafeTranscript()`

This method exists solely to support the safe-path policy. With that policy gone,
remove it entirely. Grep for any remaining callers first (currently none in
dispatch, but check tests).

### 3. Tests — `test/telegram-dispatch.test.ts`

Update or remove any tests that assert fallback messages exclude transcript
content. Add/adjust a test confirming fallback now includes the full transcript
the same way `reply` does.

### 4. Docs

- `docs/telegram/draft-streaming-and-final-reply.md` §2 (glossary): remove or
  redefine `safe path`.
- §11 ("Final reply assembly on fallback"): rewrite to state fallback uses the
  same assembly as reply. Remove the "safety boundary" language.
- §13 transcript policy table (line ~809): update `fallback` row to show
  transcript is now included.
- `docs/telegram/architecture.md`: update any fallback-vs-reply distinction if
  present.

### 5. Verify no other consumers

Grep for `renderSafeTranscript`, `safe.*path`, and `"fallback"` across the
codebase to make sure nothing else depends on the old filtering behavior.

## Out of scope

- Changing `unauthorized` or `ignore` paths.
- Changing draft bubble behavior (already shows partials).
- Changing the `extraReplies` handling (already the same in both paths).
