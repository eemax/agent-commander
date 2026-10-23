import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, GrammyError, type Api } from "grammy";
import { type Agent, type TurnHandle, TurnAbortedError } from "../agent.js";
import { type Config, EFFORTS, type Effort, expandHome, resolveModel } from "../config.js";
import { errorMessage, log } from "../log.js";
import type { ConversationMeta, Store } from "../state.js";
import { compileInstructions, loadSkills, type Skill, workspaceDir } from "../workspace.js";
import { escapeHtml, formatReply, splitPlainText } from "./format.js";

export type Health = { lastPollAt: number | null };

const TYPING_EVERY_MS = 4000;
const STATUS_EDIT_EVERY_MS = 2000;
const NO_PREVIEW = { link_preview_options: { is_disabled: true } } as const;

const BUILTIN_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "new", description: "Start a fresh conversation" },
  { command: "stop", description: "Stop the running turn" },
  { command: "status", description: "Model, cwd, usage" },
  { command: "model", description: "Show or switch model" },
  { command: "thinking", description: "Show or set reasoning effort" },
  { command: "cwd", description: "Show or set working directory" },
  { command: "debug", description: "Toggle debug logging" }
];

export function skillCommand(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
}

function shortPath(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// One status message showing the latest tool call, edited in place and deleted at the end.
class ToolStatus {
  private messageId: number | null = null;
  private creating: Promise<void> | null = null;
  private latest = "";
  private shown = "";
  private lastEditAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly api: Api,
    private readonly chatId: number
  ) {}

  private render(label: string): string {
    const oneLine = label.replace(/\s+/g, " ").trim();
    return `⚙️ <code>${escapeHtml(oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine)}</code>`;
  }

  update(label: string): void {
    if (this.closed) return;
    this.latest = label;
    if (this.messageId === null && this.creating === null) {
      this.shown = label;
      this.lastEditAt = Date.now();
      this.creating = this.api
        .sendMessage(this.chatId, this.render(label), { parse_mode: "HTML", disable_notification: true })
        .then((m) => {
          this.messageId = m.message_id;
        })
        .catch((error) => log.debug("status message failed", { error: errorMessage(error) }));
      return;
    }
    if (this.timer) return;
    const wait = Math.max(0, this.lastEditAt + STATUS_EDIT_EVERY_MS - Date.now());
    this.timer = setTimeout(() => void this.flush(), wait);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    await this.creating;
    if (this.closed || this.messageId === null || this.latest === this.shown) return;
    this.shown = this.latest;
    this.lastEditAt = Date.now();
    await this.api
      .editMessageText(this.chatId, this.messageId, this.render(this.latest), { parse_mode: "HTML" })
      .catch((error) => log.debug("status edit failed", { error: errorMessage(error) }));
  }

  async clear(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.creating;
    if (this.messageId !== null) await this.api.deleteMessage(this.chatId, this.messageId).catch(() => {});
  }
}

// A chat's work in progress: the running turn (while the model works) and messages that
// arrived after it stopped accepting steers. Exists from the first turn until the queue drains.
type ChatRun = {
  turn: TurnHandle | null;
  queued: string[];
  finished: Promise<void>;
};

export class TelegramApp {
  readonly bot: Bot;
  readonly health: Health = { lastPollAt: null };
  private readonly runs = new Map<number, ChatRun>();

  constructor(
    token: string,
    private readonly config: Config,
    private readonly store: Store,
    private readonly agent: Agent
  ) {
    this.bot = new Bot(token);
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
    this.bot.api.config.use(async (prev, method, payload, signal) => {
      const result = await prev(method, payload, signal);
      if (method === "getUpdates" && result.ok) this.health.lastPollAt = Date.now();
      return result;
    });
    this.bot.on("message", (ctx) => {
      const { chat, from } = ctx.message;
      if (chat.type !== "private" || !this.config.allowlist.includes(String(from.id))) {
        log.debug("ignored message", { chat_type: chat.type, from: from.id });
        return;
      }
      const handled =
        ctx.message.text !== undefined
          ? this.onText(chat.id, ctx.message.message_id, ctx.message.text)
          : this.reply(chat.id, "Only text messages are supported for now.");
      return handled.catch((error) => log.error("message handler failed", { error: errorMessage(error) }));
    });
    this.bot.catch((error) => log.error("telegram middleware error", { error: errorMessage(error.error) }));
  }

  async start(onReady: (username: string) => void): Promise<void> {
    await this.syncCommands();
    await this.bot.start({
      drop_pending_updates: false,
      allowed_updates: ["message"],
      onStart: (me) => onReady(me.username)
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    await Promise.allSettled([...this.runs.keys()].map((chatId) => this.cancel(chatId)));
  }

  // Stops the running turn, drops queued messages and waits until the chat is idle.
  private async cancel(chatId: number): Promise<boolean> {
    const run = this.runs.get(chatId);
    if (!run) return false;
    run.queued.length = 0;
    run.turn?.abort();
    await run.finished;
    return true;
  }

  private skills(): Skill[] {
    return loadSkills(workspaceDir(this.config.home)).skills;
  }

  private async syncCommands(): Promise<void> {
    const skills = this.skills().map((s) => ({ command: skillCommand(s.name), description: s.description.slice(0, 256) }));
    const builtin = new Set(BUILTIN_COMMANDS.map((c) => c.command));
    await this.bot.api
      .setMyCommands([...BUILTIN_COMMANDS, ...skills.filter((s) => !builtin.has(s.command))].slice(0, 100))
      .catch((error) => log.warn("could not register commands", { error: errorMessage(error) }));
  }

  private conversation(chatId: number): ConversationMeta {
    return (
      this.store.current(String(chatId)) ??
      this.store.create(String(chatId), {
        model: this.config.models[0]!.alias,
        effort: this.config.defaultEffort,
        cwd: workspaceDir(this.config.home),
        instructions: compileInstructions(this.config.home)
      })
    );
  }

  private async reply(chatId: number, markdown: string): Promise<void> {
    for (const chunk of formatReply(markdown)) {
      try {
        await this.bot.api.sendMessage(chatId, chunk.html, { parse_mode: "HTML", ...NO_PREVIEW });
      } catch (error) {
        if (!(error instanceof GrammyError) || error.error_code !== 400) throw error;
        log.debug("html rejected, sending plain text", { reason: error.description });
        for (const part of splitPlainText(chunk.plain)) await this.bot.api.sendMessage(chatId, part, NO_PREVIEW);
      }
    }
  }

  private async onText(chatId: number, messageId: number, text: string): Promise<void> {
    if (text.startsWith("/")) return this.onCommand(chatId, text);
    if (this.enqueue(chatId, text)) {
      await this.bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: "👀" }]).catch(() => {});
    }
  }

  // Starts a turn, or hands the text to the work in progress. Returns true when it was handed over.
  private enqueue(chatId: number, text: string): boolean {
    const run = this.runs.get(chatId);
    if (run) {
      if (run.turn) run.turn.steer(text);
      else run.queued.push(text);
      return true;
    }
    const fresh: ChatRun = { turn: null, queued: [text], finished: Promise.resolve() };
    fresh.finished = this.drain(chatId, fresh).finally(() => this.runs.delete(chatId));
    this.runs.set(chatId, fresh);
    return false;
  }

  private async drain(chatId: number, run: ChatRun): Promise<void> {
    while (run.queued.length > 0) {
      const input = run.queued.splice(0).join("\n\n");
      await this.runTurn(chatId, run, input).catch((error) => log.error("turn crashed", { error: errorMessage(error) }));
    }
  }

  private async runTurn(chatId: number, run: ChatRun, input: string): Promise<void> {
    const meta = this.conversation(chatId);
    const status = new ToolStatus(this.bot.api, chatId);
    const typing = () => void this.bot.api.sendChatAction(chatId, "typing").catch(() => {});
    typing();
    const typingTimer = setInterval(typing, TYPING_EVERY_MS);
    log.debug("turn start", { conversation: meta.id, model: meta.model, chars: input.length });

    const handle = this.agent.startTurn(meta, input, { onToolStart: (label) => status.update(label) });
    run.turn = handle;
    let reply: string;
    try {
      const result = await handle.done;
      reply = result.text.trim() || "_(no text reply)_";
      log.debug("turn done", { conversation: meta.id, cost: result.usage.cost.toFixed(5) });
    } catch (error) {
      if (error instanceof TurnAbortedError) {
        reply = "⏹ Stopped.";
      } else {
        log.error("turn failed", { conversation: meta.id, error: errorMessage(error).slice(0, 500) });
        reply = `⚠️ Turn failed: ${errorMessage(error).replace(/\s+/g, " ").slice(0, 300)}`;
      }
    } finally {
      // From here on, new messages queue up for the next turn instead of steering this one.
      run.turn = null;
      clearInterval(typingTimer);
    }
    const late = handle.undeliveredSteers();
    if (late.length > 0) {
      log.debug("steer arrived too late, running it next", { count: late.length });
      run.queued.unshift(...late);
    }
    await status.clear();
    await this.reply(chatId, reply).catch((error) => log.error("reply failed", { error: errorMessage(error) }));
  }

  private async onCommand(chatId: number, text: string): Promise<void> {
    const match = /^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!match) return this.reply(chatId, "Unknown command. Try /help.");
    const command = match[1]!.toLowerCase();
    const arg = match[2]?.trim() ?? "";

    switch (command) {
      case "start":
      case "help":
        return this.reply(
          chatId,
          [
            "Send a message to talk to the agent. Messages sent while it works steer the running turn.",
            "",
            ...BUILTIN_COMMANDS.map((c) => `/${c.command}: ${c.description}`),
            "/<skill>: use a workspace skill for one turn"
          ].join("\n")
        );
      case "new": {
        await this.cancel(chatId);
        this.store.archive(String(chatId));
        const meta = this.conversation(chatId);
        await this.syncCommands();
        return this.reply(chatId, `🆕 New conversation · ${meta.model} · ${meta.effort}`);
      }
      case "stop": {
        if (!this.runs.has(chatId)) return this.reply(chatId, "Nothing is running.");
        void this.cancel(chatId); // the turn replies "Stopped." itself
        return;
      }
      case "status":
        return this.reply(chatId, this.statusText(chatId));
      case "model":
        return this.modelCommand(chatId, arg);
      case "thinking":
        return this.thinkingCommand(chatId, arg);
      case "cwd":
        return this.cwdCommand(chatId, arg);
      case "debug": {
        if (arg === "on" || arg === "off") log.setDebug(arg === "on");
        else if (arg) return this.reply(chatId, "Usage: /debug [on|off]");
        log.info(`debug logging ${log.isDebug() ? "on" : "off"}`);
        return this.reply(chatId, `Debug logging is ${log.isDebug() ? "on" : "off"}.`);
      }
      default: {
        const skill = this.skills().find((s) => skillCommand(s.name) === command);
        if (!skill) return this.reply(chatId, `Unknown command /${command}. Try /help.`);
        const input = `Use the "${skill.name}" skill for this request: read ${skill.path} first and follow it.\n\n${arg}`.trim();
        this.enqueue(chatId, input);
        return;
      }
    }
  }

  private statusText(chatId: number): string {
    const meta = this.conversation(chatId);
    const model = resolveModel(this.config, meta.model);
    return [
      `**Model:** ${meta.model}${model ? ` (\`${model.id}\`)` : ""}`,
      `**Thinking:** ${meta.effort}`,
      `**Cwd:** \`${shortPath(meta.cwd)}\``,
      `**Conversation:** ${meta.turns} turns · $${meta.usage.cost.toFixed(4)} · started ${meta.createdAt.slice(0, 16).replace("T", " ")} UTC`,
      `**Context:** ${meta.lastContextTokens === null ? "–" : `${formatTokens(meta.lastContextTokens)} tokens`}`,
      `**Running:** ${this.runs.has(chatId) ? "yes" : "no"} · **Debug:** ${log.isDebug() ? "on" : "off"}`
    ].join("\n");
  }

  private async modelCommand(chatId: number, arg: string): Promise<void> {
    const meta = this.conversation(chatId);
    if (!arg) {
      const lines = this.config.models.map((m) => `${m.alias === meta.model ? "▸" : "  "} **${m.alias}**: \`${m.id}\``);
      return this.reply(chatId, ["Models (use /model <alias>):", ...lines].join("\n"));
    }
    const model = resolveModel(this.config, arg);
    if (!model) return this.reply(chatId, `Unknown model "${arg}". Send /model to list them.`);
    meta.model = model.alias;
    this.store.saveMeta(meta);
    const note = this.runs.has(chatId) ? " (from the next turn)" : "";
    return this.reply(chatId, `Model set to **${model.alias}** (\`${model.id}\`)${note}.`);
  }

  private async thinkingCommand(chatId: number, arg: string): Promise<void> {
    const meta = this.conversation(chatId);
    if (!arg) return this.reply(chatId, `Thinking: **${meta.effort}**. Options: ${EFFORTS.join(", ")}.`);
    if (!(EFFORTS as readonly string[]).includes(arg)) return this.reply(chatId, `Options: ${EFFORTS.join(", ")}.`);
    meta.effort = arg as Effort;
    this.store.saveMeta(meta);
    return this.reply(chatId, `Thinking set to **${meta.effort}**.`);
  }

  private async cwdCommand(chatId: number, arg: string): Promise<void> {
    const meta = this.conversation(chatId);
    if (!arg) return this.reply(chatId, `Cwd: \`${shortPath(meta.cwd)}\``);
    const target = path.resolve(meta.cwd, expandHome(arg));
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return this.reply(chatId, `Not a directory: \`${shortPath(target)}\``);
    }
    meta.cwd = target;
    this.store.saveMeta(meta);
    return this.reply(chatId, `Cwd set to \`${shortPath(target)}\`.`);
  }
}
