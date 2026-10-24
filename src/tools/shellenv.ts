// The login shell's environment (PATH from nvm/cargo/uv, exported secrets, …), captured once
// and reused, so each command can start a plain `bash -c` instead of paying for a login shell
// (≈0.4 s with nvm). When a file the login shell reads changes (a profile, a new key in
// ~/.secrets), the next command re-captures it first; a background refresh every few minutes
// catches the rest (files those source indirectly, like nvm's).
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { errorMessage, log } from "../log.js";

const REFRESH_MS = 5 * 60_000;
// Per-shell bookkeeping that must not be carried into another shell. The SSH session variables
// matter too: Debian's bash sources ~/.bashrc (nvm and all, ≈0.3 s) in any non-interactive shell
// that sees SSH_CLIENT with SHLVL < 2, i.e. it would think sshd started it.
const SHELL_LOCAL = new Set(["PWD", "OLDPWD", "SHLVL", "_", "SSH_CLIENT", "SSH2_CLIENT", "SSH_CONNECTION", "SSH_TTY"]);
const CAPTURE = ["/bin/bash", ["-lc", "env -0"]] as const;
const captureOptions = () => ({ cwd: os.homedir(), env: process.env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });

let cached: { env: NodeJS.ProcessEnv; at: number; fingerprint: string } | null = null;
let refreshing = false;

// What a bash login shell reads (bash(1) INVOCATION), plus this box's ~/.agentrc and the
// ~/.secrets/*.env it exports. Missing files are fine.
function profileFiles(home: string): { files: string[]; dirs: string[] } {
  return {
    files: [
      "/etc/profile",
      "/etc/bash.bashrc",
      "/etc/environment",
      path.join(home, ".bash_profile"),
      path.join(home, ".bash_login"),
      path.join(home, ".profile"),
      path.join(home, ".bashrc"),
      path.join(home, ".agentrc")
    ],
    dirs: ["/etc/profile.d", path.join(home, ".secrets")]
  };
}

// Changes when any of those files is edited, added or removed. A few dozen stats: microseconds.
export function profileFingerprint(home = os.homedir()): string {
  const { files, dirs } = profileFiles(home);
  const parts: string[] = [];
  const add = (p: string) => {
    try {
      const st = fs.statSync(p);
      parts.push(`${p}:${st.mtimeMs}:${st.size}`);
    } catch {
      // absent
    }
  };
  for (const file of files) add(file);
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of names) add(path.join(dir, name));
  }
  return parts.join("|");
}

// For tests: forget the snapshot.
export function resetLoginEnv(): void {
  cached = null;
  refreshing = false;
}

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
  // Taken before capturing, so an edit made during the capture still triggers another one.
  const fingerprint = profileFingerprint();
  return new Promise((resolve) => {
    execFile(CAPTURE[0], [...CAPTURE[1]], { ...captureOptions(), encoding: "utf8" }, (error, stdout) => {
      refreshing = false;
      try {
        if (error) throw error;
        cached = { env: accept(stdout), at: Date.now(), fingerprint };
      } catch (err) {
        // Keep a good snapshot over a failed refresh; retry at the next interval.
        cached = cached ? { ...cached, at: Date.now() } : { env: fallback(err), at: Date.now(), fingerprint };
      }
      resolve();
    });
  });
}

function captureNow(fingerprint: string): NodeJS.ProcessEnv {
  try {
    const out = execFileSync(CAPTURE[0], [...CAPTURE[1]], { ...captureOptions(), stdio: ["ignore", "pipe", "ignore"] });
    cached = { env: accept(out.toString("utf8")), at: Date.now(), fingerprint };
  } catch (error) {
    cached = cached ? { ...cached, at: Date.now(), fingerprint } : { env: fallback(error), at: Date.now(), fingerprint };
  }
  return cached.env;
}

export function loginEnv(): NodeJS.ProcessEnv {
  const fingerprint = profileFingerprint();
  // First use before the startup warm-up finished, or a profile/secrets file changed: capture
  // now, so this very command sees the change.
  if (!cached || cached.fingerprint !== fingerprint) {
    if (cached) log.debug("shell profile changed, refreshing the login environment");
    return captureNow(fingerprint);
  }
  if (Date.now() - cached.at >= REFRESH_MS) void refreshLoginEnv();
  return cached.env;
}
