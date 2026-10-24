// The login shell's environment (PATH from nvm/cargo/uv, exported secrets, …), captured once
// and reused, so each command can start a plain `bash -c` instead of paying for a login shell
// (≈0.4 s with nvm). Refreshed in the background every few minutes so new tools and profile
// edits show up without ever making a command wait.
import { execFile, execFileSync } from "node:child_process";
import * as os from "node:os";
import { errorMessage, log } from "../log.js";

const REFRESH_MS = 5 * 60_000;
// Per-shell bookkeeping that must not be carried into another shell. The SSH session variables
// matter too: Debian's bash sources ~/.bashrc (nvm and all, ≈0.3 s) in any non-interactive shell
// that sees SSH_CLIENT with SHLVL < 2, i.e. it would think sshd started it.
const SHELL_LOCAL = new Set(["PWD", "OLDPWD", "SHLVL", "_", "SSH_CLIENT", "SSH2_CLIENT", "SSH_CONNECTION", "SSH_TTY"]);
const CAPTURE = ["/bin/bash", ["-lc", "env -0"]] as const;
const CAPTURE_OPTIONS = { cwd: os.homedir(), env: process.env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 };

let cached: { env: NodeJS.ProcessEnv; at: number } | null = null;
let refreshing = false;

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

function accept(output: string): NodeJS.ProcessEnv {
  const env = parseEnv(output);
  if (!env.PATH) throw new Error("login shell reported no PATH");
  return env;
}

function fallback(error: unknown): NodeJS.ProcessEnv {
  log.warn("could not capture the login shell environment, using acmd's own", { error: errorMessage(error) });
  return { ...process.env };
}

// Refreshes in the background; commands keep using the previous snapshot meanwhile.
export function refreshLoginEnv(): Promise<void> {
  if (refreshing) return Promise.resolve();
  refreshing = true;
  return new Promise((resolve) => {
    execFile(CAPTURE[0], [...CAPTURE[1]], { ...CAPTURE_OPTIONS, encoding: "utf8" }, (error, stdout) => {
      refreshing = false;
      try {
        if (error) throw error;
        cached = { env: accept(stdout), at: Date.now() };
      } catch (err) {
        // Keep a good snapshot over a failed refresh; retry at the next interval.
        cached = cached ? { env: cached.env, at: Date.now() } : { env: fallback(err), at: Date.now() };
      }
      resolve();
    });
  });
}

export function loginEnv(): NodeJS.ProcessEnv {
  if (cached) {
    if (Date.now() - cached.at >= REFRESH_MS) void refreshLoginEnv();
    return cached.env;
  }
  // First use before the startup warm-up finished: capture synchronously, once.
  try {
    cached = { env: accept(execFileSync(CAPTURE[0], [...CAPTURE[1]], { ...CAPTURE_OPTIONS, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8")), at: Date.now() };
  } catch (error) {
    cached = { env: fallback(error), at: Date.now() };
  }
  return cached.env;
}
