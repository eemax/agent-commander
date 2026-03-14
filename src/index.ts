#!/usr/bin/env node
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startRuntime } from "./runtime/bootstrap.js";

function resolveRepoRoot(): string {
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(runtimeDir, "..");
}

async function main(): Promise<void> {
  await startRuntime(resolveRepoRoot());
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`${new Date().toISOString()} [ERROR] fatal: ${message}`);
  process.exit(1);
});
