# Telegram Draft Streaming Bubble and Final Reply

This document is the deep dive for the most fragile user-facing area in the Telegram runtime:

- the ephemeral draft streaming bubble
- the permanent final reply
- the boundary between them

This area has been difficult because one assistant turn is presented to the user through two different Telegram surfaces:

1. a temporary, continuously updated draft bubble
2. one or more permanent reply messages

Those two surfaces share the same underlying model activity, but they do not behave the same way, they do not fail the same way, and the permanent reply policy can still differ by outcome.

The goal of this doc is to make three things explicit:

1. what the code does today
2. what the user should experience
3. what future changes should preserve or improve

Primary code paths:

- `src/telegram/text-dispatch.ts`
- `src/telegram/stream-transcript.ts`
- `src/telegram/outbound.ts`
- `src/telegram/assistant-format.ts`
- `src/telegram/bot.ts`
- `src/telegram/message-split.ts`

## 1. Why this area is hard

The runtime is trying to do all of these at once:

- show progress quickly
- avoid spammy permanent messages
- preserve useful tool activity context
- avoid duplicating the answer
- make transcript promotion to the final reply explicit
- survive Telegram rate limits and draft failures
- handle interruption and stale-turn suppression cleanly

That means a single assistant turn can move through several user-visible modes:

```text
user sends message
   |
   v
optional spinner-only draft
   |
   v
draft bubble with tool notices and assistant char counter
   |
   +--> maybe updates `Assistant: <n> chars`
   +--> maybe resets when too large
   +--> maybe fails and gets disabled
   +--> maybe gets suppressed by interruption
   |
   v
result arrives from router
   |
   +--> reply         -> permanent final reply
   +--> fallback      -> permanent fallback reply
   +--> unauthorized  -> permanent unauthorized reply
   +--> ignore        -> no permanent reply
```

The trouble is not just rendering. The trouble is policy:

- which parts belong only in the draft bubble?
- which parts must survive into the final reply?
- which parts should survive into the permanent reply on each outcome?
- when does a stale turn stop being allowed to emit output?

## 2. Terminology

This doc uses these terms consistently:

- `draft bubble`: the ephemeral Telegram bubble sent via `ctx.replyWithDraft(...)`
- `spinner frame`: one of the rotating symbols `◐`, `◓`, `◑`, `◒`
- `final reply`: the permanent Telegram reply path sent via `ctx.reply(...)`
- `extra reply`: a permanent reply sent before the main final reply; the Telegram dispatcher still supports this shape, but model tool activity currently stays in the transcript-backed main reply path
- `transcript`: the internal ordered record of streamed tool notices, system notes, and committed text blocks
- `cleanText`: the router's returned `result.text` after outbound attachment markers are stripped
- `success path`: `MessageRouteResult.type === "reply"`
- `fallback path`: `MessageRouteResult.type === "fallback"`

## 3. The user-facing contract

If we strip away implementation details, the intended contract is:

### 3.1 Draft bubble

- The draft bubble is optional UX, not the source of truth.
- It should appear quickly so the user feels the turn is alive.
- It should preserve tool and system progress chronologically.
- It should show assistant progress without streaming assistant prose verbatim; the current design uses a whole-turn character counter.
- It may disappear, reset, or stop updating without breaking the turn.
- If it fails, the turn should still try to deliver a correct final reply.

### 3.2 Final reply

- The final reply is the authoritative record of the turn.
- On success, it should contain the meaningful user-facing story of the turn.
- On fallback, it should use the same transcript-backed assembly as `reply`, including already-committed text blocks, tool notices, and system notes.
- It should not duplicate content the user already sees inside the same permanent message.
- It should preserve ordering and send semantics even when chunked.

### 3.3 Interruption

- Once a turn becomes stale, it must stop sending user-visible output.
- Drafts may already have been shown before interruption.
- Permanent output from the stale turn must be suppressed.

That last rule is especially important. It is better to lose a stale draft than to send a wrong permanent answer after a newer turn has taken over.

### 3.4 Current headline rules

- Draft assistant text is never rendered verbatim; the bubble shows `Assistant: <n> chars` for the whole turn instead.
- `telegram.draft_bubble_max_chars` remains the outer reset cap for the whole bubble.
- Draft overflow is explicit: the visible bubble resets to a spinner-only `◐` frame instead of silently failing.
- When reset happens, the overflowing content seeds the next draft page instead of being dropped.
- `reply` and `fallback` share the same transcript-backed final-text assembly through `buildFinalReplyText(cleanText)`.
- Final assistant formatting preserves visible blank lines between paragraphs and other block-level elements before chunking runs.
- Permanent reply chunking searches backward from `4096` down to `3000`, preferring `\n\n`, then `\n`, then space, then a hard split.

## 4. Current architecture for this area

```text
provider.generateReply(...)
   |
   +--> onTextDelta(delta)
   +--> onToolCallNotice(notice)
   +--> onLifecycleEvent(event)
   |
   v
dispatchTelegramTextMessage()
   |
   +--> StreamTranscript
   +--> sendDraft(...)
   +--> sendReply(...)
   +--> shouldSuppressOutput()
   |
   v
bot.ts
   |
   +--> ctx.replyWithDraft(...)
   +--> ctx.reply(...)
   +--> ctx.replyWithPhoto/Document(...)
```

The split is deliberate:

- `text-dispatch.ts` owns the behavior contract
- `stream-transcript.ts` owns transcript accumulation and rendering
- `outbound.ts` owns formatting and chunking of permanent replies
- `bot.ts` owns actual Telegram API calls and retry wrappers

## 5. The current lifecycle in detail

### 5.1 Before the first delta

When `dispatchTelegramTextMessage()` starts:

- it records `telegram.inbound.received`
- creates a new `StreamTranscript`
- initializes draft-state bookkeeping
- builds a `MessageStreamingSink` for the provider

No bubble is shown immediately at function start. The first bubble is created lazily when the provider emits a stream event that needs user-visible feedback.

### 5.2 First visible draft: spinner-only bubble

The first time text or tool activity arrives, `ensureTypingStarted()` tries to send:

```text
◐
```

This is important because it establishes a user-visible bubble before enough transcript exists for a meaningful draft.

Conceptually:

```text
time --->

provider starts
   |
   +--> first delta/tool notice
           |
           v
       sendDraft("◐")
```

If that first draft send fails, draft streaming is disabled for the rest of the turn, but the turn continues.

That behavior is intentional:

- draft UX is best-effort
- final reply delivery is mandatory

### 5.3 Streaming text into the bubble

When the provider emits `onTextDelta(delta)`:

```text
onTextDelta(delta)
   |
   +--> ensure spinner bubble exists
   +--> stop spinner worker
   +--> transcript.appendTextDelta(delta)
   +--> maybe flush draft
   +--> restart spinner worker
```

The draft bubble does not update on every character unconditionally. Updates are throttled by `draftMinUpdateMs`.

That produces behavior like this:

```text
incoming deltas:   "Hel"   "lo"   "!"
clock:               0      20    120
min update:         1000ms

visible drafts:
1. "◐"
2. "Hello!"
```

So the bubble is not a faithful frame-by-frame mirror. It is a throttled rendering of the current transcript state.

### 5.4 Streaming tool notices into the bubble

Tool activity goes through `onToolCallNotice(notice)`.

There are four cases:

### Case A: persistent notice

Example:

```text
📖 Read: `foo.ts`
```

This becomes a `tool_notice` transcript entry.

Raw non-empty string notices are normalized into this persistent case by default. That conservative fallback means transport-level heuristics cannot accidentally downgrade a notice into draft-only behavior. Draft-only latest-tool-notice rendering happens only when the caller explicitly sends a structured `{ kind: "latest_tool_notice", text }` event.

### Case B: cumulative summary update

Successful tool calls update a cumulative count summary such as:

```text
📖 Read x1
```

then later:

```text
📖 Read x1
✍️ Write x1
```

This summary is stored separately from chronological notices so the draft can keep one running count block while the final reply includes only the cumulative summary.

### Case C: latest tool notice

Structured tool-call notices refresh a draft-only "latest tool notice" block such as:

```text
📖 Read: `foo.ts`
```

Only the newest tool notice stays visible in full inside the draft bubble; it does not get copied into the permanent final reply.

### Case D: empty notice

An empty string means "tool execution is in flight" but does not itself add visible transcript content.

This matters because the UI may need to keep the bubble feeling alive during tool execution even before a human-readable notice exists.

### 5.5 Why text and tools share one transcript

The draft bubble is not rendered directly from raw text deltas. Instead, `StreamTranscript` stores an ordered mixed timeline:

```text
[tool_notice]  "📖 Read: `foo.ts`"
[text_block]   "Reply text"
[tool_notice]  "✍️ Write: `bar.ts`"
[text_block]   "More reply text"
```

That transcript is still what powers the final permanent reply, while the draft bubble now renders a compact status surface from the same underlying state.

Without that transcript layer, the system would have to choose between:

- tool logs with no relation to the answer text
- answer text with no visible tool context
- duplicate verbose messages and final answer fragments

## 6. How `StreamTranscript` works

`StreamTranscript` is the local view-model for this entire area.

Its state can be visualized as:

```text
+-----------------------------------------------------+
| StreamTranscript                                    |
|-----------------------------------------------------|
| entries:                                            |
|   - tool_notice / text_block / system_note          |
| liveDraftText:                                      |
|   - in-progress, not yet committed text             |
| draftPageStart:                                     |
|   - hides older entries after a bubble reset        |
| draftLiveStart:                                     |
|   - hides older live text after a bubble reset      |
| draftPinnedEntryIndex:                              |
|   - re-shows replaced count summary after reset     |
+-----------------------------------------------------+
```

### 6.1 `liveDraftText`

Text deltas accumulate in `liveDraftText` until they are committed.

This is the still-being-written portion of the answer.

### 6.2 `commitLiveDraft()`

`commitLiveDraft()` turns accumulated draft text into a `text_block`.

It happens:

- automatically before tool notices and system notes
- manually once at finalization before building the final reply

That means mode switches like `text -> tool -> text` become explicit transcript structure instead of one undifferentiated string.

### 6.3 `renderDraft(limit)`

`renderDraft()` is for the ephemeral bubble.

Its key rule is:

- tool notices and system notes remain chronological
- assistant text is reduced to a whole-turn `Assistant: <n> chars` counter
- if the compact draft would still exceed the configured draft limit, the bubble resets and older content becomes hidden from draft rendering
- the overflow is reported explicitly so the dispatch layer can replace the bubble with a spinner-only reset frame

That looks like this:

```text
draft page 1 grows...
   |
   +--> exceeds draftBubbleMaxChars
           |
           v
       renderDraft() returns { kind: "reset" }
           |
           v
       dispatch sends "◐"
           |
           v
       next visible draft page starts with the overflowing content
```

In other words, the bubble is a compact status surface with paging as a safety valve.

This is deliberate UX policy. The goal is to show progress that feels on track without filling Telegram with a giant wall of partial answer text.

The reset is still best-effort, but it is no longer intentionally lossy:

- the overflow-triggering content seeds the next page instead of disappearing
- the permanent final reply still uses the full transcript and remains authoritative

### 6.4 `buildFinalReplyText(cleanText)`

`buildFinalReplyText()` is for the permanent `reply` and `fallback` paths.

Rules:

- if transcript is empty -> return `cleanText`
- if `cleanText` is empty -> return full transcript
- if the last transcript entry is a `text_block` exactly equal to `cleanText` -> do not append `cleanText` again
- otherwise -> return `fullTranscript + "\n\n" + cleanText`

This is the key anti-duplication rule.

Example:

```text
transcript:
  📖 Read: `foo.ts`
  Reply text

cleanText:
  Reply text

final permanent reply:
  📖 Read: `foo.ts`
  Reply text
```

But if the transcript ends in a tool notice instead:

```text
transcript:
  Reply
  ✍️ Write: `bar.ts`

cleanText:
  Reply

final permanent reply:
  Reply
  ✍️ Write: `bar.ts`

  Reply
```

That looks repetitive at first glance, but it is correct under the current policy because the transcript does not yet end with a text block equal to the final answer.

## 7. Draft bubble rendering model

The draft bubble is no longer a raw mixed transcript render.

Current shape:

```text
status section:
  cumulative successful-tool count summary
  latest tool notice in full
  chronological persistent steer notices

assistant section:
  Assistant: <n> chars

final draft bubble:
  status section
  blank line (if both sections exist)
  assistant section
```

This creates recognizable user-facing patterns:

### 7.1 Tool notices followed by answer text

```text
draft bubble
-------------------------
📖 Read ×1
📖 Read: `foo.ts`

Assistant: 42 chars
-------------------------
```

### 7.2 Multiple tool notices only

```text
draft bubble
-------------------------
📖 Read ×1
✍️ Write ×1
✍️ Write: `bar.ts`
-------------------------
```

### 7.3 Text only

```text
draft bubble
-------------------------
Assistant: 11 chars
-------------------------
```

### 7.4 Spinner with no transcript yet

```text
draft bubble
-------------------------
◐
-------------------------
```

## 8. The spinner worker

There are really two draft mechanisms:

1. content flushes
2. spinner refreshes

The spinner worker periodically updates the draft with rotating frames when there is no new visible content to flush.

Conceptually:

```text
no new delta yet
   |
   +--> wait draftMinUpdateMs
   +--> render current draft
   +--> append spinner frame
   +--> sendDraft("current content\n◓")
```

This helps the bubble feel alive during pauses between model tokens or while tools are running.

Important details:

- spinner updates are stopped before text/tool updates mutate transcript state
- spinner updates restart afterward
- three consecutive spinner send failures stop the spinner worker

That is a resilience policy, not a correctness policy.

## 9. What happens when the draft bubble fails

Draft sending is explicitly best-effort.

Failure path:

```text
sendDraft(...) throws
   |
   v
disableDraft(error)
   |
   +--> mark draftDisabled = true
   +--> record observability event
   +--> call onDraftFailure(...)
   |
   v
continue the turn
```

After this:

- no more drafts are attempted
- transcript accumulation still continues
- final reply still uses transcript on success

This is important. Draft failure does not mean transcript failure.

So the system still aims to preserve the useful user-facing story in the final permanent reply even if the ephemeral bubble never worked.

## 10. Final reply assembly on success

Success path in `dispatchTelegramTextMessage()`:

```text
router returns { type: "reply", text, extraReplies?, inlineKeyboard? }
   |
   +--> flushDraft(true)
   +--> transcript.commitLiveDraft()
   +--> extract outbound attachment markers
   +--> send extraReplies first
   +--> finalText = transcript.buildFinalReplyText(cleanText)
   +--> send finalText as permanent reply
   +--> send outbound attachments
```

This means the final reply is not simply `result.text`.

It is potentially:

```text
full transcript

clean text
```

with deduplication when allowed.

### 10.1 Success-path ASCII example

```text
provider stream:
  tool notice: "📖 Read: `foo.ts`"
  text delta : "Here is"
  text delta : " the answer"

router result:
  { type: "reply", text: "Here is the answer" }

transcript:
  [tool_notice] "📖 Read: `foo.ts`"
  [text_block ] "Here is the answer"

final permanent reply:
  📖 Read: `foo.ts`
  Here is the answer
```

## 11. Final reply assembly on fallback

Fallback now uses the same assembly rule as `reply`.

Current path:

```text
router returns { type: "fallback", text, extraReplies? }
   |
   +--> flushDraft(true)
   +--> transcript.commitLiveDraft()
   +--> send extras first
   +--> finalText = transcript.buildFinalReplyText(cleanText)
   +--> send finalText
```

The transcript is included in the permanent fallback message when it contains committed entries.

That means fallback can permanently preserve:

- text blocks that were already streamed
- tool notices
- system notes

The only remaining fallback-specific distinction is outbound formatting: `fallback` still stays plain text, but its text content is assembled the same way as `reply`.

## 12. `ignore` and stale-turn suppression

`ignore` is the strongest suppression outcome.

If a turn is interrupted or otherwise becomes stale:

- drafts already sent cannot be unsent
- no permanent reply should be sent

Current logic:

```text
shouldSuppressOutput() === true
   |
   +--> suppress forced draft flush
   +--> suppress final replies
   +--> return { type: "ignore" }
```

This is tied to retained-turn abort state from `bot.ts`.

That means:

- a turn may have streamed some ephemeral content
- but once it loses ownership, it should stop producing permanent user-visible output

This is a critical invariant for correctness in multi-message chats.

## 13. Permanent reply formatting

After text-dispatch decides what permanent text to send, `bot.ts` and `outbound.ts` add a second user-facing layer:

```text
sendReply(text, meta)
   |
   +--> prepareTelegramReply(...)
   |      |
   |      +--> maybe markdown_to_html
   |      +--> maybe plain text fallback
   |
   +--> sendTelegramReplyChunks(...)
          |
          +--> splitTelegramMessage(...)
          +--> send chunks in order
          +--> inline keyboard only on last chunk
```

Formatting rules today:

- only `resultType === "reply"` is eligible for assistant Markdown formatting
- the compact draft bubble can also use HTML transport formatting when `assistant_format = "markdown_to_html"`, but it still renders the same compact status/counter surface
- the main final reply uses the full Telegram-safe Markdown-to-HTML renderer when `assistant_format = "markdown_to_html"`
- draft HTML uses the basic Telegram renderer rather than the full final-reply renderer, so it formats Markdown like backticks/emphasis without adding ZWSP auto-link breakers
- rendered block-level content preserves visible blank lines between paragraphs, lists, blockquotes, and code blocks
- extra replies use a simpler HTML renderer
- `fallback` and `unauthorized` stay plain text
- formatting failures fall back to plain text rather than breaking reply delivery

This means the user-visible "final reply" is actually the combination of:

1. transcript assembly policy
2. Markdown/HTML formatting policy
3. chunking policy
4. inline keyboard placement policy

## 14. Chunking and size limits

There are two relevant limits:

### Draft bubble

- hard Telegram limit: `4096`
- draft rendering target: `draftBubbleMaxChars`, default `1500`
- `bot.ts` also truncates draft text to `TELEGRAM_MESSAGE_LIMIT` before sending

The draft bubble is therefore intentionally much smaller than Telegram's maximum, and the renderer usually stays far below the cap because assistant text contributes only a character counter before paging is considered.

### Final reply

- `sendTelegramReplyChunks()` uses `splitTelegramMessage(...)`
- chunking happens after formatting choice is made
- the active splitter searches backward from `4096` down to `3000` for a natural break
- break priority is `\n\n`, then `\n`, then space, then a hard split at `4096`
- in HTML mode, the splitter preserves tag balance across chunk boundaries
- inline keyboards are attached only to the last chunk

One notable fact:

- `splitFinalReply()` exists in `src/telegram/message-split.ts`
- it is tested
- it is not currently used by the active send path

That is worth calling out because future work in this area should be careful not to assume that helper is already the production contract.

## 15. The most important current invariants

These are the rules future changes should preserve unless there is an explicit product decision to change them.

### Success and failure

- Draft failure must not cancel final reply delivery.
- `reply` and `fallback` use the same transcript-backed final assembly.
- `ignore` must not emit permanent replies.

### Ownership

- Only the current turn may emit permanent output.
- A stale turn may leave behind ephemeral draft history, but not permanent answer history.

### Ordering

- Extra replies are sent before the main reply.
- The main reply is the only place the inline keyboard should appear.
- Outbound attachments are sent after the main reply text.

### Deduplication

- Exact deduplication is allowed only when the transcript ends in a `text_block` equal to `cleanText`.
- Tool notices must never accidentally suppress the final answer just because they share a suffix.

### Bubble semantics

- The draft bubble is a small, compact status surface, not a permanent log.
- Bubble resets should be explicit: overflow becomes a spinner-only `◐` frame.
- The next visible page starts with the overflow-triggering content instead of dropping it.
- The cumulative summary and latest tool notice remain pinned when they still fit on the current page.

## 16. Known conceptual pain points

This area remains difficult because several concepts are still tightly coupled.

### Pain point 1: one transcript, two surfaces

The same transcript drives:

- ephemeral draft rendering
- success-path permanent reply assembly

That is powerful, but it means every change to transcript semantics risks affecting both surfaces.

### Pain point 2: mode switching

Sequences like:

```text
text -> tool -> text -> tool -> text
```

are valid and common. They are also where duplication and ordering bugs tend to appear.

### Pain point 3: bubble reset vs final permanence

The draft bubble intentionally forgets older content after reset, but now carries the overflowing content forward into the next page.

The final reply intentionally does not forget the full transcript on success.

That asymmetry is correct, but easy to get wrong in code.

### Pain point 4: silent differences between outcomes

`reply` and `fallback` now share transcript assembly, while `ignore` still suppresses permanent output.

If that policy lives only in conditionals instead of an explicit model, it is easy to regress.

### Pain point 5: formatting happens after assembly

The final reply text is built first and formatted second.

That means issues can appear at either layer:

- transcript assembly bug
- formatting bug
- chunking bug
- keyboard/chunk boundary bug

## 17. Recommended future vision

The future vision for this area should be:

### 17.1 Make the user-facing model explicit

Treat the draft bubble and final reply as two separate render targets from a first-class view model.

Desired shape:

```text
+--------------------------------------------------+
| TurnPresentationModel                            |
|--------------------------------------------------|
| draft_surface                                    |
|   - visible bubble text                          |
|   - spinner state                                |
|   - reset/page state                             |
|                                                  |
| final_surface                                    |
|   - success text                                 |
|   - fallback text                                |
|   - extras                                        |
|   - attachments                                  |
|   - keyboard                                     |
|                                                  |
| policy                                           |
|   - can_show_partial_text?                       |
|   - can_promote_transcript_to_final?             |
|   - must_suppress_output?                        |
+--------------------------------------------------+
```

Today, parts of this exist, but they are spread across `text-dispatch.ts`, `stream-transcript.ts`, and `outbound.ts`.

### 17.2 Make outcome policy table-driven

The contract should be easy to read in one place.

Recommended table:

```text
Outcome        Draft allowed   Transcript in final   Permanent reply?
-------------  --------------  --------------------  ----------------
reply          yes             yes                   yes
fallback       yes             yes                   yes
unauthorized   no/irrelevant   no                    yes
ignore         maybe started   no                    no
stale turn     maybe started   no                    no
```

### 17.3 Keep draft UX best-effort

Do not let draft reliability become a prerequisite for correct answers.

This is already the right policy and should remain so.

### 17.4 Test the whole user-visible path, not just raw strings

This area benefits most from tests that assert:

- draft call sequence
- permanent reply call sequence
- final formatted text
- chunk ordering
- inline keyboard placement
- stale-turn suppression

The sharpest regressions in this area are often integration-shaped rather than pure-string-shaped.

### 17.5 Prefer explicit rendering phases

The mental model should stay simple:

```text
phase 1: stream events into transcript
phase 2: render ephemeral draft from transcript
phase 3: resolve outcome policy
phase 4: render permanent reply from transcript + outcome
phase 5: format, chunk, send
```

Whenever those phases blur together, bugs become harder to reason about.

## 18. Recommended design guardrails for future changes

Any future change in this area should be checked against this list:

- Does it change what the user sees in the draft bubble?
- Does it change what survives into the permanent final reply?
- Does it intentionally change `reply`, `fallback`, and `ignore` policy?
- Does it preserve stale-turn suppression?
- Does it preserve dedup rules?
- Does it preserve chunk ordering and keyboard placement?
- Does it behave correctly when draft sends fail?
- Does it behave correctly when tool notices and text interleave repeatedly?

If the answer is not obvious, the change probably needs:

- a transcript-level test
- a dispatch-level test
- and a short update to this doc

## 19. Condensed mental model

If you need the shortest accurate explanation, use this:

```text
Draft bubble:
  ephemeral, throttled, compact, resettable, best-effort, partial

Final reply:
  permanent, authoritative, policy-driven, formatted, chunked
```

And the key architectural truth is:

```text
same underlying turn
   ->
same transcript
   ->
different render policies for ephemeral vs permanent output
```

That is the core idea this area should continue to refine rather than obscure.
