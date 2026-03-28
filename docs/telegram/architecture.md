# Telegram Module Architecture

This document explains how the Telegram runtime works in Agent Commander from process startup down to a sent reply.

Scope:

- polling and bot bootstrap
- inbound Telegram message normalization
- authorization and workspace refresh
- command routing vs assistant turns
- per-chat turn interruption and queueing
- streaming drafts, typing indicators, and final replies
- callback query handling
- JSONL persistence touchpoints

The Telegram runtime is intentionally thin: `src/telegram/*` handles Telegram-specific I/O and UX, while `src/routing/*`, `src/provider.ts`, and `src/state/conversations.ts` own the actual conversation logic.

## 1. Startup wiring

```text
+----------------------+
| src/index.ts         |
+----------+-----------+
           |
           v
+----------------------+
| startRuntime()       |
| src/runtime/         |
| bootstrap.ts         |
+----------+-----------+
           |
           v
+----------------------+
| bootstrapAgentRuntime|
+----------+-----------+
           |
           +--> createWorkspaceManager()
           +--> createConversationStore()
           +--> createToolHarness()
           +--> createOpenAIProvider()
           +--> createMessageRouter()
           |
           v
+----------------------+
| createTelegramBot()  |
| src/telegram/bot.ts  |
+----------+-----------+
           |
           +--> new Bot(token)              (grammY polling bot)
           +--> syncCommands()              (setMyCommands)
           +--> bot.on(message, ...)
           +--> bot.on(callback_query, ...)
           +--> bot.catch(...)
           |
           v
+----------------------+
| bot.start()          |
| long polling active  |
+----------------------+
```

What matters here:

- The process is a single foreground Node.js runtime. There is no webhook server and no daemon layer.
- `createTelegramBot()` is passed already-built handlers from the router, so Telegram code does not decide business logic on its own.
- Telegram commands are synced once at startup, then re-synced later if workspace refresh detects command catalog changes.

Key source files:

- `src/runtime/bootstrap.ts`
- `src/telegram/bot.ts`
- `src/workspace.ts`

## 2. High-level message path

```text
Telegram update
   |
   v
grammY event handler
   |
   v
normalizeTelegramMessage()
   |
   v
createTelegramAttachmentResolver()
   |
   v
dispatchTelegramTextMessage()
   |
   +--> inbound observability
   +--> streaming UX hooks
   +--> final outbound send logic
   |
   v
router.handleIncomingMessage()
   |
   +--> gatekeeping
   +--> command parsing
   +--> turn manager / queueing
   +--> assistant turn
   |
   v
provider.generateReply()
   |
   +--> tool loop
   +--> text deltas
   +--> lifecycle events
   |
   v
conversation store append
   |
   v
Telegram final reply / files / keyboard
```

The important design split is:

- `src/telegram/bot.ts` owns grammY integration and concrete Telegram API calls.
- `src/telegram/text-dispatch.ts` owns Telegram reply UX: draft bubbles, typing, reactions, and final send ordering.
- `src/routing.ts` decides whether the inbound thing is blocked, queued, a command, or an assistant turn.
- `src/routing/assistant-turn.ts` runs the OpenAI turn and persistence.

## 3. Exact flow for an inbound text or media message

### 3.1 Entry in `src/telegram/bot.ts`

`createTelegramBot()` registers one handler for these update types:

- `message:text`
- `message:photo`
- `message:document`
- `message:video`
- `message:audio`
- `message:voice`
- `message:animation`

That handler does this:

1. Normalize the grammY `Context` into a small internal shape with `chatId`, `messageId`, `senderId`, `text`, `attachments`, and `receivedAt`.
2. Create a root observability trace for the inbound event.
3. Build a lazy attachment resolver for Telegram files.
4. Call `dispatchTelegramTextMessage(...)`.

### 3.2 Normalization

`normalizeTelegramMessage()` in `src/telegram/normalize.ts` converts Telegram payloads into `NormalizedTelegramMessage`.

Important details:

- caption text is treated like message text
- only supported inbound media types are normalized
- the largest photo size is selected
- messages with no text and no supported attachments are ignored

### 3.3 Lazy attachment resolution

`createTelegramAttachmentResolver()` in `src/telegram/inbound-attachments.ts` does not immediately download files. It returns a function that can later:

- download files through Telegram
- enforce size limits and timeouts
- bound concurrent downloads with a semaphore
- convert supported files into model-facing `ContentPart[]`
- return human-readable attachment errors

This is intentionally lazy so queued messages do not waste work downloading files that may never execute.

## 4. Telegram dispatch layer

`dispatchTelegramTextMessage()` in `src/telegram/text-dispatch.ts` is the Telegram UX coordinator.

It sits between the raw Telegram adapter and the router.

```text
dispatchTelegramTextMessage()
   |
   +--> record "telegram.inbound.received"
   +--> create StreamTranscript
   +--> build MessageStreamingSink callbacks
   |      |
   |      +--> onTextDelta()
   |      +--> onToolCallNotice()
   |      +--> onLifecycleEvent()
   |
   +--> call router.handleIncomingMessage(...)
   |
   +--> flush remaining draft
   +--> send extra replies first
   +--> send final reply
   +--> send extracted outbound attachments
   +--> finalize retained turn
```

Responsibilities here:

- record inbound Telegram observability
- render draft bubbles while the provider is streaming
- optionally send an acknowledged emoji reaction
- optionally refresh `typing` chat actions while the model is processing
- collect transcript text so the final reply can include the streamed timeline
- suppress stale output if the turn was aborted by a newer message

## 5. Router decisions

`router.handleIncomingMessage()` in `src/routing.ts` is where the message stops being "a Telegram event" and becomes "a runtime turn".

### 5.1 Gatekeeping

The first stop is `runMessageGatekeeping()` in `src/routing/gatekeeping.ts`.

```text
handleIncomingMessage()
   |
   v
runMessageGatekeeping()
   |
   +--> sender allowlist check
   +--> workspace.refresh() with debounce
   +--> if commands changed: onCommandCatalogChanged()
   |
   +--> unauthorized => immediate "unauthorized" result
   +--> allowed => continue
```

Important details:

- Telegram allowlisting comes from `config/agents.json` and is enforced before routing.
- Workspace refresh is piggybacked onto inbound traffic, so skill/command changes are discovered without a separate watcher.
- If refresh changes the command catalog, the bot resyncs Telegram slash commands.

### 5.2 Command parse vs normal text

After gatekeeping, the router calls `parseTelegramCommand(message.text)`.

There are four main branches:

1. Normal non-command message
2. `/steer`
3. `/stop`
4. Other core command or dynamic skill command

### 5.3 Per-chat active turn and queue behavior

Normal messages use `TurnManager` from `src/routing/turn-manager.ts`.

```text
chat receives message
   |
   +--> active turn exists?
         |
         +--> yes: queue the message for that chat
         |         return "Message queued (N pending)"
         |
         +--> no: resolve deferred attachments if needed
                   start a new turn now
```

This gives the Telegram runtime two important behaviors:

- each chat has at most one active assistant turn
- later messages can queue behind the active one instead of running concurrently

If a newer turn starts, `TurnManager.beginTurn()` aborts the previous one through `AbortController`.

### 5.4 `/steer`

`/steer <text>` does not start a new provider request. It pushes text into the active turn's `SteerChannel`, which the provider/tool loop can read mid-turn.

### 5.5 `/stop`

`/stop` aborts the active turn for the chat and clears its pending queue.

## 6. Assistant turn internals

When a message becomes a real assistant turn, the router calls `createAssistantTurnHandler()` from `src/routing/assistant-turn.ts`.

```text
runSingleTurn()
   |
   v
assistant-turn handler
   |
   +--> ensureActiveConversation(chatId)
   +--> read runtime profile
   +--> append user message to JSONL
   +--> build prompt context
   +--> maybe write first-turn context snapshot
   +--> provider.generateReply(...)
   |      |
   |      +--> streaming callbacks back into Telegram dispatch
   |      +--> local tool loop if model calls tools
   |
   +--> append assistant message on success
   +--> append provider_failure on provider error
   +--> flush turn stats
```

Important state-store touchpoints in `src/state/conversations.ts`:

- `ensureActiveConversation()`
- `appendUserMessageAndGetPromptContext()`
- `appendAssistantMessage()`
- `appendProviderFailure()`
- `setLatestUsageSnapshot()`
- `flushTurnStats()`

Persistence model:

- active conversation selection lives in JSON
- conversation history is append-only JSONL
- Telegram message IDs are stored on user and provider-failure events

## 7. Streaming drafts and typing behavior

The Telegram UX during model generation is more than a plain "wait then reply".

`dispatchTelegramTextMessage()` builds a `MessageStreamingSink` and passes it into the router, which passes it into the provider.

### 7.1 Text deltas

```text
provider text delta
   |
   v
onTextDelta(delta)
   |
   +--> ensure first draft bubble exists
   +--> stop spinner worker
   +--> append delta to StreamTranscript
   +--> maybe flush draft to Telegram
   +--> restart spinner worker
```

### 7.2 Tool notices

Verbose tool notices use the same draft pipeline:

```text
provider tool event
   |
   v
assistant-turn formatter
   |
   v
onToolCallNotice(notice)
   |
   +--> append/replace tool notice in StreamTranscript
   +--> maybe flush draft
```

Count-mode tool updates can replace the previous tool notice instead of appending a new line, which is why `StreamTranscript` supports replace semantics.

### 7.3 Lifecycle events

Provider lifecycle callbacks drive Telegram-specific UX:

- `response_acknowledged` -> optional emoji reaction via `ctx.react(...)`
- `response_processing_started` -> start repeating `typing` chat action

The typing action is refreshed on an interval until the provider call settles.

### 7.4 Why `StreamTranscript` exists

`src/telegram/stream-transcript.ts` keeps an ordered local transcript of:

- streamed assistant text
- tool notices
- system notes

It serves two outputs:

1. a draft bubble that can reset when it gets too large
2. a final reply that can include the already-streamed text without duplication

Conceptually:

```text
stream events
   |
   +--> tool notice: "running bash"
   +--> text delta: "Here is the result..."
   +--> text delta: "more text"
   |
   v
StreamTranscript
   |
   +--> renderDraft(limit)         for temporary draft bubbles
   +--> buildFinalReplyText(text)  for the final `reply`/`fallback` text
```

## 8. Final outbound send path

After `router.handleIncomingMessage()` returns a `MessageRouteResult`, the Telegram dispatch layer decides how to send it.

### 8.1 Result types

Supported result types are:

- `reply`
- `fallback`
- `unauthorized`
- `ignore`

### 8.2 Send ordering

On the text-message dispatch path, `reply` and `fallback` share the same final-text policy, but the operations happen in this order:

1. send any `extraReplies` first
2. build the main text with `transcript.buildFinalReplyText(cleanText)`
3. send the main text
4. attach inline keyboard only to the last chunk of the main reply
5. send extracted outbound attachments afterward

### 8.3 Formatting and chunking

`src/telegram/outbound.ts` does two Telegram-specific transformations:

- `prepareTelegramReply()` optionally converts assistant Markdown to Telegram-safe HTML
- `sendTelegramReplyChunks()` splits oversized text to stay under Telegram message limits

`src/telegram/bot.ts` then calls grammY methods such as:

- `ctx.reply(...)`
- `ctx.replyWithDraft(...)`
- `ctx.replyWithPhoto(...)`
- `ctx.replyWithDocument(...)`
- `ctx.replyWithChatAction("typing")`

All outbound sends go through a small retry wrapper that parses Telegram rate-limit errors and backs off before retrying.

## 9. Retained turns and why queue draining happens late

One subtle but important detail is turn retention.

The router normally wants to release a turn as soon as the assistant logic finishes. That would be too early for Telegram, because the bot may still be:

- flushing the final draft
- sending extra replies
- sending the main reply
- uploading outbound attachments

So `src/telegram/bot.ts` passes a `retain()` hook into the router. The router then gives back a `RetainedTurnHandle` with:

- `abortSignal`
- `finalize()`

That lets Telegram keep the turn in a "finalizing" phase until all outbound work is done.

```text
assistant logic done
   |
   +--> router marks turn as finalizing
   +--> Telegram dispatch sends final outbound messages
   +--> onSettled() calls retainedTurn.finalize()
   +--> queue drain starts only now
```

This avoids starting the next queued message before the previous one has fully finished its Telegram-side output.

## 10. Callback query flow

Inline keyboard presses use a separate path in `src/telegram/bot.ts`.

```text
Telegram callback_query:data
   |
   v
normalizeTelegramCallbackQuery()
   |
   v
ctx.answerCallbackQuery()
   |
   v
router.handleIncomingCallbackQuery()
   |
   +--> gatekeeping
   +--> abort active turn for that chat
   +--> coreCommands.handleCallbackQuery()
   |
   v
send callback reply chunks
```

Important differences from normal messages:

- callback queries never go through the assistant-turn path directly
- the router only asks core command handling to resolve them
- an active turn for that chat is aborted before the callback action runs
- the bot answers the callback query immediately on the Telegram side to clear the loading UI

## 11. Error handling

There are three main error layers:

### 11.1 Per-message processing failure

If message processing throws inside the async Telegram handler:

- the error is logged
- `telegram.processing.failed` is recorded
- the user receives a generic internal-error reply

### 11.2 Callback processing failure

If callback handling fails:

- the error is logged
- observability records the failure
- the bot best-effort answers the callback query with `"Internal error"`
- the user gets a generic reply message

### 11.3 grammY middleware failure

`bot.catch(...)` is the outer safety net for grammY middleware failures and records `telegram.middleware.failed`.

## 12. Observability events along the path

Common events emitted by the Telegram path:

- `telegram.inbound.received`
- `telegram.outbound.draft.sent`
- `telegram.outbound.draft.failed`
- `telegram.outbound.acknowledged.sent`
- `telegram.outbound.acknowledged.failed`
- `telegram.outbound.processing.started`
- `telegram.outbound.processing.stopped`
- `telegram.outbound.reply.sent`
- `telegram.processing.failed`
- `telegram.middleware.failed`
- `routing.gatekeeping.checked`
- `routing.message.queued`
- `routing.turn.interrupted`
- `routing.decision.made`

These events are useful because the Telegram layer and the router both emit traces, so a single chat turn can be reconstructed from inbound update to final reply.

## 13. Condensed end-to-end map

```text
Telegram API
   |
   v
grammY Bot polling loop
   |
   +--> message:text/photo/document/video/audio/voice/animation
   |      |
   |      v
   |   normalizeTelegramMessage
   |      |
   |      v
   |   createTelegramAttachmentResolver
   |      |
   |      v
   |   dispatchTelegramTextMessage
   |      |
   |      +--> draft bubble / typing / reaction UX
   |      +--> StreamTranscript
   |      |
   |      v
   |   router.handleIncomingMessage
   |      |
   |      +--> gatekeeping
   |      +--> workspace refresh + command sync
   |      +--> command parse
   |      +--> queue or begin turn
   |      |
   |      v
   |   assistant-turn handler
   |      |
   |      +--> JSONL append user message
   |      +--> provider.generateReply
   |      |      |
   |      |      +--> tools
   |      |      +--> streaming deltas
   |      |
   |      +--> JSONL append assistant reply or provider failure
   |      |
   |      v
   |   Telegram dispatch sends final text + files
   |      |
   |      v
   |   retained turn finalized, queue drained
   |
   +--> callback_query:data
          |
          v
       normalizeTelegramCallbackQuery
          |
          v
       router.handleIncomingCallbackQuery
          |
          +--> gatekeeping
          +--> abort active turn
          +--> core callback handler
          |
          v
       Telegram reply
```

## 14. Mental model

If you want the shortest accurate description, it is this:

```text
grammY adapter
   -> Telegram dispatch UX layer
   -> router
   -> assistant turn
   -> OpenAI provider + tools
   -> JSONL store
   -> Telegram outbound sender
```

The Telegram module is therefore not the "AI runtime" itself. It is the transport adapter plus response UX shell around the runtime core.
