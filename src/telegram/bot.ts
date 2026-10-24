import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, GrammyError, type Api } from "grammy";
import { type Agent, type TurnHandle, TurnAbortedError } from "../agent.js";
import { type Config, EFFORTS, type Effort, expandHome, resolveModel } from "../config.js";
import { errorMessage, log } from "../log.js";
import { readInbox, notificationNotice } from "../inbox.js";
import { type Jobs, formatDuration, jobNotice } from "../jobs.js";
import type { ConversationMeta, Store } from "../state.js";
import { compileInstructions, loadSkills, type Skill, workspaceDir } from "../workspace.js";
import { escapeHtml, formatReply, splitPlainText } from "./format.js";

export type Health = { lastPollAt: number | null };

const TYPING_EVERY_MS = 4000;
const WATCH_EVERY_MS = 1000;
const JOB_RETENTION_MS = 7 * 86_400_000;
const STATUS_EDIT_EVERY_MS = 2000;
const NO_PREVIEW = { link_preview_options: { is_disabled: true } } as const;

const BUILTIN_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "new", description: "Start a fresh conversation" },
  { command: "stop", description: "Stop the running turn" },
  { command: "status", description: "Model, cwd, usage" },
  { command: "model", description: "Show or switch model" },
  { command: "thinking", description: "Show or set reasoning effort" },
  { command: "cwd", description: "Show or set working directory" },
  { command: "jobs", description: "List background jobs, or /jobs stop <id>" },
  { command: "debug", description: "Toggle debug logging" }
];

// A woken reply is marked ⏰. Glued onto a line that starts a markdown block (heading, code
// fence, list, quote, table) the marker would break that block, so it goes on its own line then.
export function markWoken(reply: string): string {
  return /^(#{1,6}\s|```|~~~|[-*+]\s|\d+[.)]\s|>|\|)/.test(reply) ? `⏰\n\n${reply}` : `⏰ ${reply}`;
}

// A known command (built-in or skill). Anything else starting with "/", such as a path or a
// typo, is an ordinary message for the agent.
export function parseCommand(text: string, skillCommands: string[]): { command: string; arg: string } | null {
  const match = /^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const command = match[1]!.toLowerCase();
  const known =
    command === "start" || command === "help" || BUILTIN_COMMANDS.some((c) => c.command === command) || skillCommands.includes(command);
  return known ? { command, arg: match[2]?.trim() ?? "" } : null;
}

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
  private kind: "command" | "description" = "command";
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
    const text = escapeHtml(oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine);
    return this.kind === "command" ? `⚙️ <code>${text}</code>` : `⚙️ ${text}`;
  }

  update(label: string, kind: "command" | "description"): void {
    if (this.closed) return;
    this.latest = label;
    this.kind = kind;
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

// Something for the agent: a user message, or a wake-up (job finished, `acmd notify`).
type QueueItem = { text: string; wake: boolean };

// A chat's work in progress: the running turn (while the model works) and items that arrived
// after it stopped accepting steers. Exists from the first turn until the queue drains.
type ChatRun = {
  turn: TurnHandle | null;
  queued: QueueItem[];
  steeredWakes: Set<string>; // wake texts steered into the running turn
  finished: Promise<void>;
};

export class TelegramApp {
  readonly bot: Bot;
  readonly health: Health = { lastPollAt: null };
  private readonly runs = new Map<number, ChatRun>();
  // Quiet notes (a job that ended without an exit status) waiting for the chat's next turn.
  private readonly notes = new Map<number, string[]>();
  private watchTimer: NodeJS.Timeout | null = null;
  private lastPruneAt = 0;

  constructor(
    token: string,
    private readonly config: Config,
    private readonly store: Store,
    private readonly agent: Agent,
    private readonly jobs: Jobs
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
    this.watchTimer = setInterval(() => this.watch(), WATCH_EVERY_MS);
    await this.bot.start({
      drop_pending_updates: false,
      allowed_updates: ["message"],
      onStart: (me) => onReady(me.username)
    });
  }

  async stop(): Promise<void> {
    if (this.watchTimer) clearInterval(this.watchTimer);
    await this.bot.stop();
    await Promise.allSettled([...this.runs.keys()].map((chatId) => this.cancel(chatId)));
  }

  // Stops the running turn, drops queued user messages and waits until the chat is idle. Queued
  // wake-ups are kept as notes for the next turn: stopping shouldn't start a turn, nor lose news.
  private async cancel(chatId: number): Promise<boolean> {
    const run = this.runs.get(chatId);
    if (!run) return false;
    const wakes = run.queued.filter((i) => i.wake).map((i) => i.text);
    if (wakes.length > 0) this.notes.set(chatId, [...(this.notes.get(chatId) ?? []), ...wakes]);
    run.queued.length = 0;
    run.turn?.abort();
    await run.finished;
    return true;
  }

  // Delivers ended background jobs and inbox notifications. Jobs keep running across acmd
  // restarts, so this also picks up whatever finished while acmd was down.
  private watch(): void {
    try {
      for (const job of this.jobs.sweep()) {
        const chatId = Number(job.chatId);
        if (this.config.allowlist.includes(job.chatId)) {
          const notice = jobNotice(this.jobs, job, this.store.current(job.chatId)?.id ?? null);
          this.deliver(chatId, notice, job.state === "exited" ? "wake" : "note");
        }
        this.jobs.markDelivered(job.id);
      }
      for (const { file, notification } of readInbox(this.store.stateDir)) {
        if (this.config.allowlist.includes(notification.chatId)) {
          this.deliver(Number(notification.chatId), notificationNotice(notification), "wake");
        } else {
          log.warn("dropping notification for a chat not on the allowlist");
        }
        fs.rmSync(file, { force: true });
      }
      if (Date.now() - this.lastPruneAt > 3_600_000) {
        this.lastPruneAt = Date.now();
        const removed = this.jobs.prune(JOB_RETENTION_MS);
        if (removed > 0) log.debug("pruned old jobs", { removed });
      }
    } catch (error) {
      log.error("watch failed", { error: errorMessage(error) });
    }
  }

  // A wake starts a turn when the chat is idle (or steers the running one); a note waits for
  // the next turn so it costs nothing on its own.
  private deliver(chatId: number, text: string, kind: "wake" | "note"): void {
    log.debug("deliver", { kind, chars: text.length });
    if (kind === "note") {
      const run = this.runs.get(chatId);
      if (run?.turn) run.turn.steer(text);
      else this.notes.set(chatId, [...(this.notes.get(chatId) ?? []), text]);
      return;
    }
    const meta = this.conversation(chatId);
    meta.wakeups = (meta.wakeups ?? 0) + 1;
    this.store.saveMeta(meta);
    this.enqueue(chatId, { text, wake: true });
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
        instructions: compileInstructions(this.config.home, this.config.bash)
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
    const command = parseCommand(text, this.skills().map((sk) => skillCommand(sk.name)));
    if (command) return this.onCommand(chatId, command.command, command.arg);
    if (this.enqueue(chatId, { text, wake: false })) {
      await this.bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: "👀" }]).catch(() => {});
    }
  }

  // Starts a turn, or hands the item to the work in progress. Returns true when it was handed over.
  private enqueue(chatId: number, item: QueueItem): boolean {
    const run = this.runs.get(chatId);
    if (run) {
      if (run.turn) {
        run.turn.steer(item.text);
        if (item.wake) run.steeredWakes.add(item.text);
      } else {
        run.queued.push(item);
      }
      return true;
    }
    const fresh: ChatRun = { turn: null, queued: [item], steeredWakes: new Set(), finished: Promise.resolve() };
    fresh.finished = this.drain(chatId, fresh).finally(() => this.runs.delete(chatId));
    this.runs.set(chatId, fresh);
    return false;
  }

  private async drain(chatId: number, run: ChatRun): Promise<void> {
    while (run.queued.length > 0) {
      const items = run.queued.splice(0);
      const notes = this.notes.get(chatId) ?? [];
      this.notes.delete(chatId);
      const input = [...notes, ...items.map((i) => i.text)].join("\n\n");
      const woken = items.every((i) => i.wake);
      await this.runTurn(chatId, run, input, woken).catch((error) => log.error("turn crashed", { error: errorMessage(error) }));
    }
  }

  private async runTurn(chatId: number, run: ChatRun, input: string, woken: boolean): Promise<void> {
    const meta = this.conversation(chatId);
    const status = new ToolStatus(this.bot.api, chatId);
    // The last indicator is awaited before replying: one landing after the reply would show
    // "typing…" for another five seconds.
    let typingSent: Promise<unknown> = Promise.resolve();
    const typing = () => {
      typingSent = this.bot.api.sendChatAction(chatId, "typing").catch(() => {});
    };
    typing();
    const typingTimer = setInterval(typing, TYPING_EVERY_MS);
    log.debug("turn start", { conversation: meta.id, model: meta.model, chars: input.length, woken });

    const handle = this.agent.startTurn(meta, input, { onToolStart: (label, kind) => status.update(label, kind) });
    run.turn = handle;
    let reply: string;
    let stopped = false;
    try {
      const result = await handle.done;
      reply = result.text.trim() || "_(no text reply)_";
      if (woken) reply = markWoken(reply);
      log.debug("turn done", { conversation: meta.id, cost: result.usage.cost.toFixed(5) });
    } catch (error) {
      if (error instanceof TurnAbortedError) {
        stopped = true;
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
    const wakeTexts = run.steeredWakes;
    run.steeredWakes = new Set();
    if (late.length > 0 && stopped) {
      // A stopped turn starts nothing new; what it never saw goes along with the next turn.
      this.notes.set(chatId, [...(this.notes.get(chatId) ?? []), ...late]);
    } else if (late.length > 0) {
      log.debug("steer arrived too late, running it next", { count: late.length });
      run.queued.unshift(...late.map((text) => ({ text, wake: wakeTexts.has(text) })));
    }
    await Promise.all([status.clear(), typingSent]);
    await this.reply(chatId, reply).catch((error) => log.error("reply failed", { error: errorMessage(error) }));
  }

  private async onCommand(chatId: number, command: string, arg: string): Promise<void> {
    switch (command) {
      case "start":
      case "help":
        return this.reply(
          chatId,
          [
            "Send a message to talk to the agent. Messages sent while it works steer the running turn.",
            "The agent can run background jobs; when one finishes it picks up on its own (replies marked ⏰).",
            "",
            ...BUILTIN_COMMANDS.map((c) => `/${c.command}: ${c.description}`),
            "/<skill>: use a workspace skill for one turn"
          ].join("\n")
        );
      case "new": {
        await this.cancel(chatId);
        // Job and notification notices still matter in the new conversation; old steers don't.
        const keep = (this.notes.get(chatId) ?? []).filter((n) => n.startsWith("[acmd]"));
        if (keep.length > 0) this.notes.set(chatId, keep);
        else this.notes.delete(chatId);
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
      case "jobs":
        return this.jobsCommand(chatId, arg);
      case "debug": {
        if (arg === "on" || arg === "off") log.setDebug(arg === "on");
        else if (arg) return this.reply(chatId, "Usage: /debug [on|off]");
        log.info(`debug logging ${log.isDebug() ? "on" : "off"}`);
        return this.reply(chatId, `Debug logging is ${log.isDebug() ? "on" : "off"}.`);
      }
      default: {
        const skill = this.skills().find((s) => skillCommand(s.name) === command);
        if (!skill) return; // parseCommand only lets known skills through
        const input = `Use the "${skill.name}" skill for this request: read ${skill.path} first and follow it.\n\n${arg}`.trim();
        this.enqueue(chatId, { text: input, wake: false });
        return;
      }
    }
  }

  private async jobsCommand(chatId: number, arg: string): Promise<void> {
    const stop = /^stop\s+(\d+)$/.exec(arg);
    if (stop) {
      const id = Number(stop[1]);
      const job = this.jobs.get(id);
      if (!job || job.chatId !== String(chatId)) return this.reply(chatId, `No job ${id}.`);
      if (job.state !== "running") return this.reply(chatId, `Job ${id} already ended.`);
      return this.reply(chatId, this.jobs.stop(id) ? `Stopping job ${id}; the agent will hear how it ended.` : `Could not signal job ${id}.`);
    }
    if (arg) return this.reply(chatId, "Usage: /jobs or /jobs stop <id>");
    const mine = this.jobs.list().filter((j) => j.chatId === String(chatId));
    const running = mine.filter((j) => j.state === "running");
    const ended = mine.filter((j) => j.state !== "running").slice(0, 5);
    if (mine.length === 0) return this.reply(chatId, "No background jobs.");
    const oneLine = (cmd: string) => {
      const flat = cmd.replace(/\s+/g, " ").trim();
      return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
    };
    const lines: string[] = [];
    if (running.length > 0) {
      lines.push("**Running**");
      for (const j of running) lines.push(`${j.id} · ${formatDuration(Date.now() - Date.parse(j.startedAt))} · \`${oneLine(j.command)}\``);
    }
    if (ended.length > 0) {
      lines.push("**Recent**");
      for (const j of ended) {
        const how = j.state === "exited" ? `exit ${j.exitCode}` : "lost";
        lines.push(`${j.id} · ${how} · \`${oneLine(j.command)}\``);
      }
    }
    return this.reply(chatId, lines.join("\n"));
  }

  private statusText(chatId: number): string {
    const meta = this.conversation(chatId);
    const running = this.jobs.running().filter((j) => j.chatId === String(chatId)).length;
    const model = resolveModel(this.config, meta.model);
    return [
      `**Model:** ${meta.model}${model ? ` (\`${model.id}\`)` : ""}`,
      `**Thinking:** ${meta.effort}`,
      `**Cwd:** \`${shortPath(meta.cwd)}\``,
      `**Conversation:** ${meta.turns} turns · $${meta.usage.cost.toFixed(4)} · started ${meta.createdAt.slice(0, 16).replace("T", " ")} UTC`,
      `**Context:** ${meta.lastContextTokens === null ? "–" : `${formatTokens(meta.lastContextTokens)} tokens`}`,
      `**Jobs:** ${running} running · ${meta.wakeups ?? 0} wake-ups this conversation`,
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
