// Meta status for beacon (eemax/beacon APPS.md): the daemon writes state/status.json,
// `acmd status [--json]` reads it plus the disk. The CLI never touches the network.
import * as fs from "node:fs";
import * as path from "node:path";
import { OpenRouter } from "@openrouter/sdk";
import type { Api } from "grammy";
import type { Config } from "./config.js";
import { errorMessage, log } from "./log.js";
import { atomicWrite, type Store } from "./state.js";
import { checkWorkspace, workspaceDir } from "./workspace.js";

const HEARTBEAT_MS = 60_000;
const CHECKS_EVERY_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

type CheckStatus = "ok" | "warn" | "fail";
export type Check = { name: string; status: CheckStatus; detail: string };

export type StatusFile = {
  version: string;
  started_at: string;
  heartbeat_at: string;
  last_poll_at: string | null;
  credits: number | null;
  checks: Check[];
  checks_at: string | null;
};

export type RunRecord = {
  started_at: string;
  finished_at: string | null;
  status: "ok" | "failed";
  error: string | null;
  summary: string;
};

type Metric = { key: string; label: string; value: number; unit: string; primary?: boolean; labels?: Record<string, string> };

export function statusPaths(home: string) {
  const stateDir = path.join(home, "state");
  return { status: path.join(stateDir, "status.json"), lastRun: path.join(stateDir, "last-run.json") };
}

function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

// Check details give times, not ages: they're read minutes later (beacon collects every
// minute, lookout polls every five), so "28 s ago" would be wrong by the time anyone sees it.
function clock(iso: string): string {
  return `${iso.slice(11, 16)} UTC`;
}

// ---- daemon side ----

export class StatusWriter {
  private file: StatusFile;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private checksTimer: NodeJS.Timeout | null = null;
  private readonly openrouter: OpenRouter;

  constructor(
    private readonly config: Config,
    apiKey: string,
    private readonly telegram: Api,
    private readonly lastPollAt: () => number | null,
    version: string
  ) {
    this.openrouter = new OpenRouter({ apiKey });
    const now = new Date().toISOString();
    this.file = { version, started_at: now, heartbeat_at: now, last_poll_at: null, credits: null, checks: [], checks_at: null };
  }

  get startedAt(): string {
    return this.file.started_at;
  }

  start(): void {
    this.write();
    this.heartbeatTimer = setInterval(() => this.write(), HEARTBEAT_MS);
    void this.runChecks();
    this.checksTimer = setInterval(() => void this.runChecks(), CHECKS_EVERY_MS);
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.checksTimer) clearInterval(this.checksTimer);
  }

  private write(): void {
    const poll = this.lastPollAt();
    this.file.heartbeat_at = new Date().toISOString();
    this.file.last_poll_at = poll ? new Date(poll).toISOString() : null;
    try {
      atomicWrite(statusPaths(this.config.home).status, `${JSON.stringify(this.file, null, 2)}\n`);
    } catch (error) {
      log.warn("could not write status file", { error: errorMessage(error) });
    }
  }

  async runChecks(): Promise<void> {
    const checks: Check[] = [];

    try {
      const me = await this.telegram.getMe();
      checks.push({ name: "telegram_token", status: "ok", detail: `@${me.username}` });
    } catch (error) {
      checks.push({ name: "telegram_token", status: "fail", detail: `getMe failed: ${errorMessage(error).slice(0, 120)}` });
    }

    try {
      const credits = await this.openrouter.credits.getCredits();
      const left = credits.data.totalCredits - credits.data.totalUsage;
      this.file.credits = left;
      checks.push({ name: "openrouter", status: "ok", detail: "key valid" });
      const status: CheckStatus = left <= 0 ? "fail" : left < this.config.creditsWarnUsd ? "warn" : "ok";
      checks.push({ name: "credits", status, detail: `$${left.toFixed(2)} left` });
    } catch (error) {
      checks.push({ name: "openrouter", status: "fail", detail: `credits request failed: ${errorMessage(error).slice(0, 120)}` });
    }

    try {
      const page = await this.openrouter.models.list();
      const available = new Set(page.result.data.map((m) => m.id));
      const missing = this.config.models.filter((m) => !available.has(m.id));
      const defaultMissing = missing.some((m) => m.alias === this.config.models[0]!.alias);
      checks.push(
        missing.length === 0
          ? { name: "models", status: "ok", detail: `all ${this.config.models.length} configured models available` }
          : {
              name: "models",
              status: defaultMissing ? "fail" : "warn",
              detail: `not on OpenRouter: ${missing.map((m) => m.id).join(", ")}`
            }
      );
    } catch (error) {
      checks.push({ name: "models", status: "warn", detail: `model list unavailable: ${errorMessage(error).slice(0, 120)}` });
    }

    this.file.checks = checks;
    this.file.checks_at = new Date().toISOString();
    for (const c of checks) if (c.status !== "ok") log.warn(`check ${c.name}: ${c.status}`, { detail: c.detail });
    this.write();
  }

  writeRunRecord(record: RunRecord): void {
    atomicWrite(statusPaths(this.config.home).lastRun, `${JSON.stringify(record, null, 2)}\n`);
  }
}

// ---- CLI side ----

export function buildStatus(config: Config, store: Store, now = Date.now()) {
  const paths = statusPaths(config.home);
  const file: StatusFile | null = fs.existsSync(paths.status) ? JSON.parse(fs.readFileSync(paths.status, "utf8")) : null;
  const lastRun: RunRecord | null = fs.existsSync(paths.lastRun) ? JSON.parse(fs.readFileSync(paths.lastRun, "utf8")) : null;

  const checks: Check[] = [];
  if (!file) {
    checks.push({ name: "daemon", status: "fail", detail: "no status file: acmd has never run with this home" });
  } else if (lastRun && lastRun.finished_at && Date.parse(lastRun.started_at) >= Date.parse(file.started_at)) {
    checks.push({ name: "daemon", status: "warn", detail: `not running (stopped ${lastRun.finished_at.slice(0, 16).replace("T", " ")} UTC)` });
  } else {
    const beat = now - Date.parse(file.heartbeat_at);
    checks.push({
      name: "event_loop",
      status: beat > 10 * 60_000 ? "fail" : beat > 3 * 60_000 ? "warn" : "ok",
      detail: beat > 3 * 60_000 ? `no heartbeat since ${clock(file.heartbeat_at)}` : `last heartbeat ${clock(file.heartbeat_at)}`
    });
    const poll = file.last_poll_at ? now - Date.parse(file.last_poll_at) : null;
    const starting = poll === null && now - Date.parse(file.started_at) < 2 * 60_000;
    checks.push({
      name: "telegram",
      status: starting ? "ok" : poll === null || poll > 5 * 60_000 ? "fail" : "ok",
      detail: starting
        ? "starting"
        : poll === null
          ? "no successful poll since start"
          : poll > 5 * 60_000
            ? `no successful poll since ${clock(file.last_poll_at!)}`
            : `last poll ${clock(file.last_poll_at!)}`
    });
    checks.push(...file.checks);
  }
  const ws = checkWorkspace(config.home);
  checks.push({ name: "workspace", status: ws.status, detail: ws.detail });

  const week = store.usageSince(now - 7 * DAY_MS);
  const month = store.usageSince(now - 30 * DAY_MS);
  const sum = (rows: typeof month) => Math.round(rows.reduce((t, r) => t + r.cost, 0) * 10_000) / 10_000;
  const memoryDir = path.join(workspaceDir(config.home), "memory");
  const metrics: Metric[] = [];
  if (file?.credits != null) {
    metrics.push({ key: "credits.remaining", label: "OpenRouter credits", value: Math.round(file.credits * 100) / 100, unit: "usd", primary: true });
  }
  metrics.push(
    { key: "cost.7d", label: "Spend (7 d)", value: sum(week), unit: "usd", primary: true },
    { key: "cost.30d", label: "Spend (30 d)", value: sum(month), unit: "usd" },
    { key: "conversations.total", label: "Conversations", value: store.conversationCount(), unit: "count", primary: true },
    { key: "skills.total", label: "Skills", value: ws.skills, unit: "count", primary: true },
    {
      key: "memory.notes",
      label: "Memory notes",
      value: fs.existsSync(memoryDir) ? fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md")).length : 0,
      unit: "count"
    },
    { key: "workspace.size", label: "Workspace on disk", value: dirSize(workspaceDir(config.home)), unit: "bytes" },
    { key: "state.size", label: "State on disk", value: dirSize(store.stateDir), unit: "bytes" }
  );
  for (const model of config.models) {
    metrics.push({
      key: "cost.30d",
      label: "Spend (30 d)",
      value: sum(month.filter((r) => r.model === model.alias)),
      unit: "usd",
      labels: { model: model.alias }
    });
  }

  const problems = checks.filter((c) => c.status !== "ok").map((c) => `${c.name}: ${c.detail}`);
  const running = file && (!lastRun || Date.parse(lastRun.started_at) < Date.parse(file.started_at));
  const last_run: RunRecord | null = running
    ? {
        started_at: file.started_at,
        finished_at: null,
        status: "ok",
        error: null,
        summary: `acmd ${file.version} · up since ${file.started_at.slice(0, 16).replace("T", " ")} UTC · default model ${config.models[0]!.alias}`
      }
    : lastRun;

  return { healthy: !checks.some((c) => c.status === "fail"), problems, metrics, checks, last_run };
}

export function printStatus(status: ReturnType<typeof buildStatus>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  const icon = { ok: "✓", warn: "!", fail: "✗" } as const;
  console.log(status.healthy ? "acmd: healthy" : "acmd: UNHEALTHY");
  if (status.last_run) console.log(`  ${status.last_run.summary}`);
  console.log("");
  for (const c of status.checks) console.log(`  ${icon[c.status]} ${c.name.padEnd(15)} ${c.detail}`);
  console.log("");
  for (const m of status.metrics) {
    const value = m.unit === "usd" ? `$${m.value.toFixed(2)}` : m.unit === "bytes" ? `${(m.value / 1_048_576).toFixed(1)} MB` : String(m.value);
    const label = m.labels ? `${m.label} [${Object.values(m.labels).join(", ")}]` : m.label;
    console.log(`  ${label.padEnd(28)} ${value}`);
  }
}
