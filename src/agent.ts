// The only module that talks to @openrouter/agent's run loop.
import { OpenRouter, maxCost, serverTool, tool, type ModelResult as SdkModelResult, type Tool } from "@openrouter/agent";
import { z } from "zod";
import { type Config, resolveModel } from "./config.js";
import { errorMessage, log } from "./log.js";
import { type ConversationMeta, type Store, type Usage, emptyUsage } from "./state.js";
import { runBash } from "./tools/bash.js";

type ModelResult = SdkModelResult<readonly Tool[]>;

export type TurnResult = {
  text: string;
  usage: Usage;
};

export type TurnHandle = {
  steer: (text: string) => void;
  abort: () => void;
  done: Promise<TurnResult>;
  // Steers that never reached the model (queued too late). Call after `done` settles.
  undeliveredSteers: () => string[];
};

export type TurnCallbacks = {
  onToolStart?: (label: string) => void;
};

export class TurnAbortedError extends Error {
  constructor() {
    super("turn stopped");
  }
}

const BASH_DESCRIPTION = [
  "Run a command with /bin/bash -lc in the conversation's working directory.",
  "Each call is a fresh shell: cd, exports and variables do not persist between calls.",
  "stdout and stderr are merged; long output keeps its head and tail.",
  "For anything long-running, start it in the background (nohup cmd > file.log 2>&1 &) and check the log later."
].join(" ");

function statusCodeOf(error: unknown): number | null {
  const code = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === "number" ? code : null;
}

// Removes each delivered text once, so a steer that repeats an older message is still tracked.
export function undelivered(steers: string[], newUserTexts: string[]): string[] {
  const pool = [...newUserTexts];
  return steers.filter((s) => {
    const i = pool.indexOf(s);
    if (i === -1) return true;
    pool.splice(i, 1);
    return false;
  });
}

// Retry server-side failures (5xx, mid-stream response.failed, network); never retry 4xx except 429.
export function isRetryable(error: unknown): boolean {
  const status = statusCodeOf(error);
  if (status !== null) return status === 429 || status >= 500;
  return /server_error|internal server error|overloaded|timeout|ECONNRESET|fetch failed|network/i.test(errorMessage(error));
}

export class Agent {
  private readonly client: OpenRouter;

  constructor(
    private readonly config: Config,
    apiKey: string,
    private readonly store: Store
  ) {
    this.client = new OpenRouter({
      apiKey,
      retryConfig: {
        strategy: "backoff",
        backoff: { initialInterval: 500, maxInterval: 8000, exponent: 2, maxElapsedTime: 30_000 },
        retryConnectionErrors: true
      }
    });
  }

  startTurn(meta: ConversationMeta, input: string, callbacks: TurnCallbacks = {}): TurnHandle {
    const controller = new AbortController();
    const steers: string[] = [];
    const userTextsBefore = this.store.userTexts(meta).length;
    // User texts added during this turn, minus the turn's own input.
    const newUserTexts = () => {
      const texts = this.store.userTexts(meta).slice(userTextsBefore);
      const own = texts.indexOf(input);
      if (own !== -1) texts.splice(own, 1);
      return texts;
    };
    let current: ModelResult | null = null;

    const run = async (): Promise<TurnResult> => {
      const model = resolveModel(this.config, meta.model) ?? this.config.models[0]!;
      const bash = tool({
        name: "bash",
        description: BASH_DESCRIPTION,
        inputSchema: z.object({
          command: z.string().describe("The bash command to run"),
          timeout_ms: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(`Timeout in ms (default ${this.config.bash.timeoutMs}). Raise it for known-slow commands.`)
        }),
        // Repeating the same command (polling a log, re-running tests) is legitimate.
        loopKey: false,
        execute: async ({ command, timeout_ms }, ctx) =>
          runBash({
            command,
            cwd: meta.cwd,
            timeoutMs: timeout_ms ?? this.config.bash.timeoutMs,
            outputCapChars: this.config.bash.outputCapChars,
            signal: ctx?.signal
          })
      });
      // Summed per model call from the PostModelCall hook, so aborted and retried runs count too.
      const usage = emptyUsage();
      const tools = [bash, serverTool({ type: "openrouter:web_search" }), serverTool({ type: "openrouter:web_fetch" })];

      const call = (turnInput: string | []) =>
        this.client.callModel({
          model: model.id,
          instructions: this.store.instructions(meta),
          input: turnInput as string,
          tools,
          state: this.store.accessor(meta),
          sessionId: meta.id,
          reasoning: { effort: meta.effort },
          plugins: [{ id: "context-compression" }],
          doomLoop: true,
          signal: controller.signal,
          ...(this.config.maxTurnCostUsd !== null ? { stopWhen: maxCost(this.config.maxTurnCostUsd) } : {}),
          hooks: {
            PreToolUse: [
              {
                handler: (payload) => {
                  const command = typeof payload.toolInput.command === "string" ? payload.toolInput.command : "";
                  log.debug("tool start", { tool: payload.toolName, command });
                  callbacks.onToolStart?.(command || payload.toolName);
                }
              }
            ],
            PostToolUse: [
              {
                handler: (payload) => {
                  const output = payload.toolOutput as { exit_code?: number | null; timed_out?: boolean } | null;
                  log.debug("tool done", {
                    tool: payload.toolName,
                    exit_code: output?.exit_code,
                    timed_out: output?.timed_out,
                    ms: Math.round(payload.durationMs)
                  });
                }
              }
            ],
            PostToolUseFailure: [{ handler: (payload) => log.debug("tool failed", { tool: payload.toolName }) }],
            PostModelCall: [
              {
                handler: (payload) => {
                  log.debug("model call", {
                    model: payload.model,
                    type: payload.turnType,
                    ms: Math.round(payload.durationMs),
                    in: payload.usage?.inputTokens,
                    cached: payload.usage?.cachedTokens,
                    out: payload.usage?.outputTokens,
                    cost: payload.usage?.cost
                  });
                  if (!payload.usage) return;
                  usage.inputTokens += payload.usage.inputTokens;
                  usage.outputTokens += payload.usage.outputTokens;
                  usage.cachedTokens += payload.usage.cachedTokens;
                  usage.reasoningTokens += payload.usage.reasoningTokens;
                  usage.cost += payload.usage.cost ?? 0;
                  meta.lastContextTokens = payload.usage.inputTokens + payload.usage.outputTokens;
                }
              }
            ],
            DoomLoopDetected: [
              { handler: (payload) => log.debug("loop detected", { detector: payload.detector, action: payload.action }) }
            ]
          }
        });

      let text: string;
      try {
        current = call(input);
        try {
          text = await current.getText();
        } catch (error) {
          if (controller.signal.aborted || !isRetryable(error)) throw error;
          // The SDK persists the user message only once the first response arrives. If it made it
          // to disk, resume from the saved history (keeping finished tool rounds); otherwise resend it.
          const persisted = this.store.userTexts(meta).length > userTextsBefore;
          log.warn("model call failed, retrying once", { resume: persisted, reason: errorMessage(error).slice(0, 200) });
          current = call(persisted ? [] : input);
          for (const s of undelivered(steers, newUserTexts())) current.queueUserMessage(s);
          text = await current.getText();
        }
      } catch (error) {
        if (controller.signal.aborted) throw new TurnAbortedError();
        throw error;
      } finally {
        this.recordUsage(meta, model.alias, usage);
      }

      return { text, usage };
    };

    return {
      steer: (text) => {
        steers.push(text);
        current?.queueUserMessage(text);
        log.debug("steer queued", { chars: text.length });
      },
      abort: () => {
        controller.abort(new TurnAbortedError());
        // The signal alone does not interrupt a response that is still generating; cancel() does.
        current?.cancel().catch(() => {});
      },
      done: run(),
      undeliveredSteers: () => undelivered(steers, newUserTexts())
    };
  }

  private recordUsage(meta: ConversationMeta, model: string, usage: Usage): void {
    meta.turns += 1;
    for (const key of Object.keys(usage) as Array<keyof Usage>) meta.usage[key] += usage[key];
    this.store.saveMeta(meta);
    this.store.recordUsage({ ts: new Date().toISOString(), conversationId: meta.id, model, ...usage });
    log.debug("turn usage", { model, cost: usage.cost.toFixed(5), in: usage.inputTokens, out: usage.outputTokens });
  }
}
