import * as fs from "node:fs";
import * as path from "node:path";
import type { ConversationState, StateAccessor } from "@openrouter/agent";
import { ulid } from "ulid";
import type { Effort } from "./config.js";
import { log } from "./log.js";

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  cost: number;
};

export type ConversationMeta = {
  id: string;
  chatId: string;
  createdAt: string;
  updatedAt: string;
  model: string; // alias
  effort: Effort;
  cwd: string;
  turns: number;
  usage: Usage;
  lastContextTokens: number | null;
  wakeups?: number; // turns started or steered by background jobs and notifications
  sdk: Omit<ConversationState, "messages"> | null;
};

export type UsageRecord = { ts: string; conversationId: string; model: string } & Usage;

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, cost: 0 });

export function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function readJsonl(file: string): unknown[] {
  if (!fs.existsSync(file)) return [];
  const items: unknown[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      log.warn("skipping malformed jsonl line", { file: path.basename(file) });
    }
  }
  return items;
}

export class Store {
  readonly stateDir: string;
  readonly conversationsDir: string;
  readonly archiveDir: string;
  private readonly currentFile: string;
  private readonly usageFile: string;
  // Per conversation: how many items are on disk and the JSON of the last one.
  private readonly persisted = new Map<string, { count: number; last: string | null }>();
  // One live meta object per conversation, so concurrent updates (turn usage, /model) never clobber each other.
  private readonly metas = new Map<string, ConversationMeta>();

  constructor(home: string) {
    this.stateDir = path.join(home, "state");
    this.conversationsDir = path.join(this.stateDir, "conversations");
    this.archiveDir = path.join(this.stateDir, "archive");
    this.currentFile = path.join(this.stateDir, "current.json");
    this.usageFile = path.join(this.stateDir, "usage.jsonl");
    fs.mkdirSync(this.conversationsDir, { recursive: true });
    fs.mkdirSync(this.archiveDir, { recursive: true });
  }

  private file(id: string, ext: "jsonl" | "meta.json" | "instructions.md"): string {
    return path.join(this.conversationsDir, `${id}.${ext}`);
  }

  private readCurrent(): Record<string, string> {
    if (!fs.existsSync(this.currentFile)) return {};
    return JSON.parse(fs.readFileSync(this.currentFile, "utf8")) as Record<string, string>;
  }

  private writeCurrent(map: Record<string, string>): void {
    atomicWrite(this.currentFile, `${JSON.stringify(map, null, 2)}\n`);
  }

  current(chatId: string): ConversationMeta | null {
    const id = this.readCurrent()[chatId];
    if (!id) return null;
    const cached = this.metas.get(id);
    if (cached) return cached;
    if (!fs.existsSync(this.file(id, "meta.json"))) return null;
    const meta = JSON.parse(fs.readFileSync(this.file(id, "meta.json"), "utf8")) as ConversationMeta;
    this.metas.set(id, meta);
    return meta;
  }

  create(chatId: string, init: { model: string; effort: Effort; cwd: string; instructions: string }): ConversationMeta {
    const now = new Date().toISOString();
    const meta: ConversationMeta = {
      id: `conv_${ulid()}`,
      chatId,
      createdAt: now,
      updatedAt: now,
      model: init.model,
      effort: init.effort,
      cwd: init.cwd,
      turns: 0,
      usage: emptyUsage(),
      lastContextTokens: null,
      wakeups: 0,
      sdk: null
    };
    fs.writeFileSync(this.file(meta.id, "instructions.md"), init.instructions);
    this.saveMeta(meta);
    this.metas.set(meta.id, meta);
    this.writeCurrent({ ...this.readCurrent(), [chatId]: meta.id });
    return meta;
  }

  // Moves the chat's current conversation into the archive.
  archive(chatId: string): void {
    const map = this.readCurrent();
    const id = map[chatId];
    if (!id) return;
    for (const ext of ["jsonl", "meta.json", "instructions.md"] as const) {
      const from = this.file(id, ext);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(this.archiveDir, path.basename(from)));
    }
    this.persisted.delete(id);
    this.metas.delete(id);
    delete map[chatId];
    this.writeCurrent(map);
  }

  saveMeta(meta: ConversationMeta): void {
    meta.updatedAt = new Date().toISOString();
    atomicWrite(this.file(meta.id, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }

  instructions(meta: ConversationMeta): string {
    return fs.readFileSync(this.file(meta.id, "instructions.md"), "utf8");
  }

  // SDK conversation state backed by an append-only JSONL of items plus the meta file.
  accessor(meta: ConversationMeta): StateAccessor {
    const jsonl = this.file(meta.id, "jsonl");
    return {
      load: async () => {
        const messages = readJsonl(jsonl);
        this.persisted.set(meta.id, { count: messages.length, last: messages.length ? JSON.stringify(messages.at(-1)) : null });
        if (!meta.sdk && messages.length === 0) return null;
        const now = Date.now();
        const base = meta.sdk ?? { id: meta.id, status: "complete", createdAt: now, updatedAt: now };
        return { ...base, messages } as ConversationState;
      },
      save: async (state) => {
        const { messages, ...rest } = state;
        const items: unknown[] = Array.isArray(messages) ? messages : [messages];
        const prior = this.persisted.get(meta.id) ?? this.diskInfo(jsonl);
        const prefixIntact =
          items.length >= prior.count && (prior.count === 0 || JSON.stringify(items[prior.count - 1]) === prior.last);
        if (prefixIntact) {
          const fresh = items.slice(prior.count);
          if (fresh.length > 0) fs.appendFileSync(jsonl, fresh.map((i) => `${JSON.stringify(i)}\n`).join(""));
        } else {
          log.debug("conversation history rewritten", { conversation: meta.id });
          atomicWrite(jsonl, items.map((i) => `${JSON.stringify(i)}\n`).join(""));
        }
        this.persisted.set(meta.id, { count: items.length, last: items.length ? JSON.stringify(items.at(-1)) : null });
        meta.sdk = rest;
        this.saveMeta(meta);
      }
    };
  }

  private diskInfo(jsonl: string): { count: number; last: string | null } {
    const items = readJsonl(jsonl);
    return { count: items.length, last: items.length ? JSON.stringify(items.at(-1)) : null };
  }

  // Item texts of user messages, used to confirm a steer reached the model.
  userTexts(meta: ConversationMeta): string[] {
    const texts: string[] = [];
    for (const item of readJsonl(this.file(meta.id, "jsonl")) as Array<{ role?: string; content?: unknown }>) {
      if (item.role !== "user") continue;
      if (typeof item.content === "string") texts.push(item.content);
      else if (Array.isArray(item.content)) {
        for (const part of item.content as Array<{ text?: string }>) if (part.text) texts.push(part.text);
      }
    }
    return texts;
  }

  recordUsage(record: UsageRecord): void {
    fs.appendFileSync(this.usageFile, `${JSON.stringify(record)}\n`);
  }

  usageSince(sinceMs: number): UsageRecord[] {
    return (readJsonl(this.usageFile) as UsageRecord[]).filter((r) => Date.parse(r.ts) >= sinceMs);
  }

  conversationCount(): number {
    const count = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith(".meta.json")).length;
    return count(this.conversationsDir) + count(this.archiveDir);
  }
}
