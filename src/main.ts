#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "./agent.js";
import { REPO_ROOT, loadConfig, loadSecrets } from "./config.js";
import { errorMessage, log } from "./log.js";
import { Store } from "./state.js";
import { StatusWriter, buildStatus, printStatus } from "./status.js";
import { TelegramApp } from "./telegram/bot.js";
import { bootstrapWorkspace, workspaceDir } from "./workspace.js";

function version(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] });
    return `${pkg.version}+${sha.toString().trim()}`;
  } catch {
    return pkg.version;
  }
}

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const secrets = loadSecrets();
  const created = bootstrapWorkspace(config.home);
  const store = new Store(config.home);
  const agent = new Agent(config, secrets.openrouterApiKey, store);
  const app = new TelegramApp(secrets.telegramBotToken, config, store, agent);
  const status = new StatusWriter(config, secrets.openrouterApiKey, app.bot.api, () => app.health.lastPollAt, version());

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
      summary: `acmd ${version()} · ${turns} turns this run · stopped by ${signal}`
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
      version: version(),
      bot: `@${username}`,
      model: config.models[0]!.alias,
      workspace: workspaceDir(config.home),
      allowlist: config.allowlist.length,
      seeded: created.length > 0 ? created.join(",") : undefined
    });
  });
}

async function main(): Promise<void> {
  if (process.env.ACMD_DEBUG === "1") log.setDebug(true);
  const [command, ...rest] = process.argv.slice(2);
  if (command === "status") {
    const config = loadConfig();
    printStatus(buildStatus(config, new Store(config.home)), rest.includes("--json"));
    return;
  }
  if (command === "help" || command === "--help") {
    console.log("usage: acmd            run the bot in the foreground\n       acmd status [--json]");
    return;
  }
  if (command !== undefined) throw new Error(`unknown command "${command}": use acmd or acmd status [--json]`);
  await runDaemon();
}

main().catch((error) => {
  if (error instanceof Error && error.stack && log.isDebug()) console.error(error.stack);
  console.error(`error: ${errorMessage(error)}`);
  process.exit(1);
});
