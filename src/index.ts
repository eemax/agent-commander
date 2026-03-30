#!/usr/bin/env node
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeLogPath } from "./cli/control-store.js";
import { runCli } from "./cli/index.js";
import { createLogger } from "./logger.js";

function resolveRepoRoot(): string {
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(runtimeDir, "..");
}

async function main(): Promise<void> {
  const exitCode = await runCli({
    repoRoot: resolveRepoRoot(),
    argv: process.argv.slice(2)
  });

  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  if (process.argv.slice(2)[0] === "__runtime") {
    createLogger("error", {
      filePath: runtimeLogPath(resolveRepoRoot()),
      writeToConsole: false
    }).error(`fatal: ${message}`);
  } else {
    console.error(`${new Date().toISOString()} [ERROR] fatal: ${message}`);
  }
  process.exit(1);
});
