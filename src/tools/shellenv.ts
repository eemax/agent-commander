// The login shell's environment (PATH from nvm/cargo/uv, exported secrets, …), captured once
// and reused, so each command can start a plain `bash -c` instead of paying for a login shell
// (≈0.4 s with nvm). Refreshed every few minutes so new tools and profile edits show up.
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import { errorMessage, log } from "../log.js";

const REFRESH_MS = 5 * 60_000;
// Per-shell bookkeeping that must not be carried into another shell.
const SHELL_LOCAL = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);

let cached: { env: NodeJS.ProcessEnv; at: number } | null = null;

export function parseEnv(nulSeparated: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const entry of nulSeparated.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (!SHELL_LOCAL.has(key)) env[key] = entry.slice(eq + 1);
  }
  return env;
}

export function loginEnv(now = Date.now()): NodeJS.ProcessEnv {
  if (cached && now - cached.at < REFRESH_MS) return cached.env;
  try {
    const out = execFileSync("/bin/bash", ["-lc", "env -0"], {
      cwd: os.homedir(),
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024
    });
    const env = parseEnv(out.toString("utf8"));
    if (!env.PATH) throw new Error("login shell reported no PATH");
    cached = { env, at: now };
  } catch (error) {
    log.warn("could not capture the login shell environment, using acmd's own", { error: errorMessage(error) });
    cached = { env: { ...process.env }, at: now };
  }
  return cached.env;
}
