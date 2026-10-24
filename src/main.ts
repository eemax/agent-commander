#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "./agent.js";
import { REPO_ROOT, loadConfig, loadSecrets } from "./config.js";
import { NOTIFY_MAX_CHARS, writeNotification } from "./inbox.js";
import { Jobs } from "./jobs.js";
import { errorMessage, log } from "./log.js";
import { Store } from "./state.js";
import { StatusWriter, buildStatus, printStatus, statusPaths } from "./status.js";
import { TelegramApp } from "./telegram/bot.js";
import { toolEnv } from "./tools/bash.js";
import { bootstrapWorkspace, workspaceDir } from "./workspace.js";

function readVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] });
    return `${pkg.version}+${sha.toString().trim()}`;
  } catch {
    return pkg.version;
  }
}

async function runDaemon(): Promise<void> {
  // Read once: a deploy moves git HEAD while this process keeps running the old build.
  const version = readVersion();
  const config = loadConfig();
  const secrets = loadSecrets();
  const created = bootstrapWorkspace(config.home);
  const store = new Store(config.home);
  const jobs = new Jobs(store.stateDir, toolEnv);
  const agent = new Agent(config, secrets.openrouterApiKey, store, jobs);
  const app = new TelegramApp(secrets.telegramBotToken, config, store, agent, jobs);
  const status = new StatusWriter(config, secrets.openrouterApiKey, app.bot.api, () => app.health.lastPollAt, version);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    setTimeout(() => {
      console.error("error: shutdown took longer than 20 s, exiting");
      process.exit(1);
    }, 20_000).unref();
    status.stop();
    await app.stop().catch((error) => log.warn("telegram stop failed", { error: errorMessage(error) }));
    const turns = store.usageSince(Date.parse(status.startedAt)).length;
    status.writeRunRecord({
      started_at: status.startedAt,
      finished_at: new Date().toISOString(),
      status: "ok",
      error: null,
      summary: `acmd ${version} · ${turns} turns this run · stopped by ${signal}`
    });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: errorMessage(reason) }));
  process.on("SIGUSR2", () => {
    log.setDebug(!log.isDebug());
    log.info(`debug logging ${log.isDebug() ? "on" : "off"}`);
  });

  status.start();
  await app.start((username) => {
    log.info("acmd ready", {
      version,
      bot: `@${username}`,
      model: config.models[0]!.alias,
      workspace: workspaceDir(config.home),
      allowlist: config.allowlist.length,
      seeded: created.length > 0 ? created.join(",") : undefined
    });
  });
}

const USAGE = `usage:
  acmd                                  run the bot in the foreground
  acmd status [--json]                  health and meta numbers
  acmd notify [--chat <id>] [--source <label>] [text]
                                        wake the agent with a message (text or stdin)`;

function readStdin(): string {
  return process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
}

// Queues a notification for the daemon, which wakes the agent with it (now, or when it starts).
function notify(args: string[]): void {
  const config = loadConfig();
  let chatId = config.allowlist[0]!;
  let source = "acmd notify";
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--chat" || arg === "--source") {
      const value = args[++i];
      if (!value) throw new Error(`${arg} needs a value`);
      if (arg === "--chat") chatId = value;
      else source = value;
    } else {
      words.push(arg);
    }
  }
  if (!config.allowlist.includes(chatId)) throw new Error(`chat ${chatId} is not on telegram.allowlist`);
  let text = (words.length > 0 ? words.join(" ") : readStdin()).trim();
  if (!text) throw new Error("nothing to send: pass the message as arguments or on stdin");
  if (text.length > NOTIFY_MAX_CHARS) text = `${text.slice(0, NOTIFY_MAX_CHARS)}\n[... truncated]`;
  const store = new Store(config.home);
  writeNotification(store.stateDir, { chatId, text, source });
  const statusFile = statusPaths(config.home).status;
  const beat = fs.existsSync(statusFile) ? Date.now() - Date.parse(JSON.parse(fs.readFileSync(statusFile, "utf8")).heartbeat_at) : Infinity;
  if (beat > 3 * 60_000) console.error("warning: acmd does not seem to be running; the notification is delivered when it starts");
}

async function main(): Promise<void> {
  if (process.env.ACMD_DEBUG === "1") log.setDebug(true);
  const [command, ...rest] = process.argv.slice(2);
  if (command === "status") {
    const config = loadConfig();
    printStatus(buildStatus(config, new Store(config.home)), rest.includes("--json"));
    return;
  }
  if (command === "notify") {
    notify(rest);
    return;
  }
  if (command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command !== undefined) throw new Error(`unknown command "${command}": see acmd help`);
  await runDaemon();
}

main().catch((error) => {
  if (error instanceof Error && error.stack && log.isDebug()) console.error(error.stack);
  console.error(`error: ${errorMessage(error)}`);
  process.exit(1);
});
