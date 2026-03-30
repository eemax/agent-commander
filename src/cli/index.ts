import { closeSync, openSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "../logger.js";
import { createRuntimeInstanceId } from "../id.js";
import { loadAgentsManifest, loadAgentConfig, validateUniqueBotTokens } from "../agents.js";
import { loadEnvFile, extractAgentSecrets } from "../env.js";
import { startRuntime, type RuntimeLifecycleHooks } from "../runtime/bootstrap.js";
import { createAuthModeRegistry } from "../provider/auth-mode-registry.js";
import { createCodexAuthManager } from "../auth/codex-auth.js";
import {
  controlDirPath,
  createDefaultRuntimeControlState,
  isProcessAlive,
  isRuntimeActive,
  readRuntimeControlState,
  reconcileRuntimeControlState,
  runtimeLogPath,
  writeRuntimeControlState
} from "./control-store.js";
import { parseCliCommand } from "./parse.js";
import type { CliCommand, RuntimeControlState } from "./types.js";
import { renderUsage } from "./usage.js";

const START_READY_TIMEOUT_MS = 15_000;
const STOP_GRACE_TIMEOUT_MS = 10_000;
const STOP_FORCE_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 200;

type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

export type RunCliDeps = {
  repoRoot: string;
  argv: string[];
  io?: Partial<CliIo>;
  runBuild?: (repoRoot: string, io: CliIo) => Promise<number>;
  spawnDetachedRuntime?: (params: { repoRoot: string; logPath: string; instanceId: string }) => Promise<{ pid: number }>;
  startRuntime?: (repoRoot: string, hooks?: RuntimeLifecycleHooks) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  isRuntimeProcessAlive?: (pid: number | null) => boolean;
  signalRuntimeProcess?: (pid: number, signal: NodeJS.Signals) => void;
};

type DoctorCheck = {
  ok: boolean;
  label: string;
};

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500);
}

function createSilentLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  };
}

function defaultCliIo(): CliIo {
  return {
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    }
  };
}

async function defaultRunBuild(repoRoot: string, io: CliIo): Promise<number> {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

  return await new Promise<number>((resolve) => {
    const child = spawn(npmCommand, ["run", "build"], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit"
    });

    child.once("error", (error) => {
      io.stderr(`Build failed to start: ${sanitizeError(error)}`);
      resolve(1);
    });

    child.once("close", (code) => {
      resolve(code ?? 1);
    });
  });
}

async function defaultSpawnDetachedRuntime(params: {
  repoRoot: string;
  logPath: string;
  instanceId: string;
}): Promise<{ pid: number }> {
  await fs.mkdir(path.dirname(params.logPath), { recursive: true });
  const logFd = openSync(params.logPath, "w");

  try {
    const child = spawn(process.execPath, [path.join(params.repoRoot, "dist", "index.js"), "__runtime", "--instance-id", params.instanceId], {
      cwd: params.repoRoot,
      env: process.env,
      detached: true,
      stdio: ["ignore", logFd, logFd]
    });

    if (typeof child.pid !== "number" || child.pid <= 0) {
      throw new Error("Detached runtime did not report a valid pid");
    }

    child.unref();
    return { pid: child.pid };
  } finally {
    closeSync(logFd);
  }
}

async function ensureBuildArtifact(repoRoot: string): Promise<void> {
  const distIndexPath = path.join(repoRoot, "dist", "index.js");
  try {
    await fs.access(distIndexPath);
  } catch {
    throw new Error(`Build artifact missing: ${distIndexPath}. Run 'npm run build' or use 'acmd start --rebuild'.`);
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  sleeper: (ms: number) => Promise<void>,
  isAlive: (pid: number | null) => boolean
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await sleeper(POLL_INTERVAL_MS);
  }

  return !isAlive(pid);
}

function signalRuntimeProcess(pid: number, signal: NodeJS.Signals): void {
  const canSignalGroup = process.platform !== "win32";

  if (canSignalGroup) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // fall back to single-process signaling
    }
  }

  process.kill(pid, signal);
}

function formatStatusLines(state: RuntimeControlState, configuredAgentIds: string[]): string[] {
  return [
    `Status: ${state.status}`,
    `PID: ${state.pid ?? "none"}`,
    `Configured agents: ${configuredAgentIds.join(", ") || "none"}`,
    `Active agents: ${state.agentIds.join(", ") || "none"}`,
    `Started: ${state.startedAt ?? "never"}`,
    `Stopped: ${state.stoppedAt ?? "not stopped"}`,
    `Log: ${state.logPath}`,
    `Last error: ${state.lastError ?? "none"}`
  ];
}

function hasLiveRuntimeProcess(
  state: RuntimeControlState,
  isAlive: (pid: number | null) => boolean
): boolean {
  return state.pid !== null && isAlive(state.pid);
}

async function checkControlDirectoryAvailable(repoRoot: string): Promise<void> {
  const controlDir = controlDirPath(repoRoot);

  try {
    const stat = await fs.stat(controlDir);
    if (!stat.isDirectory()) {
      throw new Error("Control path exists but is not a directory");
    }

    const probePath = path.join(controlDir, `.doctor-${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(probePath, "ok\n", "utf8");
    await fs.unlink(probePath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const parentDir = path.dirname(controlDir);

  try {
    const parentStat = await fs.stat(parentDir);
    if (!parentStat.isDirectory()) {
      throw new Error("Control directory parent exists but is not a directory");
    }
    await fs.access(parentDir, fs.constants.W_OK | fs.constants.X_OK);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  await fs.access(repoRoot, fs.constants.W_OK | fs.constants.X_OK);
}

async function runStatus(repoRoot: string, io: CliIo): Promise<number> {
  const manifest = loadAgentsManifest(repoRoot);
  const { state } = await reconcileRuntimeControlState(repoRoot);

  for (const line of formatStatusLines(state, manifest.agents.map((agent) => agent.id))) {
    io.stdout(line);
  }

  return 0;
}

async function runStop(
  repoRoot: string,
  io: CliIo,
  sleeper: (ms: number) => Promise<void>,
  isAlive: (pid: number | null) => boolean,
  sendSignal: (pid: number, signal: NodeJS.Signals) => void
): Promise<number> {
  const { state } = await reconcileRuntimeControlState(repoRoot);
  const livePid = hasLiveRuntimeProcess(state, isAlive);

  if (!isRuntimeActive(state) && !livePid) {
    io.stdout("No detached runtime is running.");
    return 0;
  }

  if (state.pid === null) {
    const stopped = await writeRuntimeControlState(repoRoot, {
      ...state,
      status: "stopped",
      pid: null,
      stoppedAt: new Date().toISOString()
    });
    io.stdout(`Detached runtime already stopped. Status is now ${stopped.status}.`);
    return 0;
  }

  let stoppingState = await writeRuntimeControlState(repoRoot, {
    ...state,
    status: "stopping"
  });

  sendSignal(state.pid, "SIGTERM");
  let exited = await waitForProcessExit(state.pid, STOP_GRACE_TIMEOUT_MS, sleeper, isAlive);
  let forced = false;

  if (!exited) {
    forced = true;
    sendSignal(state.pid, "SIGKILL");
    exited = await waitForProcessExit(state.pid, STOP_FORCE_TIMEOUT_MS, sleeper, isAlive);
  }

  if (!exited) {
    stoppingState = await writeRuntimeControlState(repoRoot, {
      ...stoppingState,
      status: "stopping",
      pid: state.pid,
      stoppedAt: null,
      lastError: `Detached runtime did not exit after SIGKILL. pid=${state.pid}`
    });
    io.stderr(`Detached runtime did not stop cleanly. pid=${state.pid} may still be running. Log: ${stoppingState.logPath}`);
    return 1;
  }

  stoppingState = await writeRuntimeControlState(repoRoot, {
    ...stoppingState,
    status: "stopped",
    pid: null,
    stoppedAt: new Date().toISOString(),
    lastError: forced ? `Runtime required SIGKILL after ${STOP_GRACE_TIMEOUT_MS}ms.` : null
  });

  io.stdout(
    forced
      ? `Detached runtime stopped after force-kill. Log: ${stoppingState.logPath}`
      : `Detached runtime stopped. Log: ${stoppingState.logPath}`
  );

  return exited ? 0 : 1;
}

async function waitForRuntimeReady(
  repoRoot: string,
  instanceId: string,
  pid: number,
  sleeper: (ms: number) => Promise<void>,
  isAlive: (pid: number | null) => boolean
): Promise<{ ok: true; state: RuntimeControlState; warning?: string } | { ok: false; error: string; state: RuntimeControlState }> {
  const deadline = Date.now() + START_READY_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const state = await readRuntimeControlState(repoRoot);

    if (state.instanceId === instanceId && state.status === "running") {
      return { ok: true, state };
    }

    if (state.instanceId === instanceId && state.status === "failed") {
      return {
        ok: false,
        error: state.lastError ?? "Detached runtime failed during startup.",
        state
      };
    }

    if (!isAlive(pid)) {
      const failedState = await writeRuntimeControlState(repoRoot, {
        ...state,
        instanceId,
        status: "failed",
        pid: null,
        stoppedAt: new Date().toISOString(),
        lastError: state.lastError ?? "Detached runtime exited before reporting readiness."
      });
      return {
        ok: false,
        error: failedState.lastError ?? "Detached runtime exited before reporting readiness.",
        state: failedState
      };
    }

    await sleeper(POLL_INTERVAL_MS);
  }

  const state = await readRuntimeControlState(repoRoot);
  return {
    ok: true,
    state,
    warning: `Detached runtime is still starting. Check ${state.logPath} if it does not become ready soon.`
  };
}

async function runStart(
  repoRoot: string,
  io: CliIo,
  options: { rebuild: boolean },
  deps: {
    runBuild: (repoRoot: string, io: CliIo) => Promise<number>;
    spawnDetachedRuntime: (params: { repoRoot: string; logPath: string; instanceId: string }) => Promise<{ pid: number }>;
    sleep: (ms: number) => Promise<void>;
    isProcessAlive: (pid: number | null) => boolean;
  }
): Promise<number> {
  const manifest = loadAgentsManifest(repoRoot);
  const { state } = await reconcileRuntimeControlState(repoRoot);

  if (isRuntimeActive(state) || hasLiveRuntimeProcess(state, deps.isProcessAlive)) {
    throw new Error(`Detached runtime already running (pid ${state.pid ?? "unknown"}). Use 'acmd stop' or 'acmd restart'.`);
  }

  if (options.rebuild) {
    io.stdout("Rebuilding dist/ before start...");
    const buildExitCode = await deps.runBuild(repoRoot, io);
    if (buildExitCode !== 0) {
      throw new Error(`Build failed with exit code ${buildExitCode}.`);
    }
  } else {
    await ensureBuildArtifact(repoRoot);
  }

  const instanceId = createRuntimeInstanceId();
  const logPath = runtimeLogPath(repoRoot);
  const startedAt = new Date().toISOString();
  let nextState = await writeRuntimeControlState(repoRoot, {
    instanceId,
    status: "starting",
    pid: null,
    agentIds: manifest.agents.map((agent) => agent.id),
    startedAt,
    updatedAt: startedAt,
    stoppedAt: null,
    logPath,
    lastError: null
  });

  try {
    const spawned = await deps.spawnDetachedRuntime({ repoRoot, logPath, instanceId });
    nextState = await writeRuntimeControlState(repoRoot, {
      ...nextState,
      pid: spawned.pid
    });

    const ready = await waitForRuntimeReady(repoRoot, instanceId, spawned.pid, deps.sleep, deps.isProcessAlive);
    if (!ready.ok) {
      throw new Error(ready.error);
    }

    io.stdout(`Detached runtime ${ready.state.status}. pid=${spawned.pid}`);
    io.stdout(`Agents: ${ready.state.agentIds.join(", ")}`);
    io.stdout(`Log: ${ready.state.logPath}`);
    if (ready.warning) {
      io.stdout(`Warning: ${ready.warning}`);
    }
    return 0;
  } catch (error) {
    await writeRuntimeControlState(repoRoot, {
      ...nextState,
      status: "failed",
      pid: null,
      stoppedAt: new Date().toISOString(),
      lastError: sanitizeError(error)
    });
    throw error;
  }
}

async function runRestart(
  repoRoot: string,
  io: CliIo,
  options: { rebuild: boolean },
  deps: {
    runBuild: (repoRoot: string, io: CliIo) => Promise<number>;
    spawnDetachedRuntime: (params: { repoRoot: string; logPath: string; instanceId: string }) => Promise<{ pid: number }>;
    sleep: (ms: number) => Promise<void>;
    isProcessAlive: (pid: number | null) => boolean;
    signalRuntimeProcess: (pid: number, signal: NodeJS.Signals) => void;
  }
): Promise<number> {
  const { state } = await reconcileRuntimeControlState(repoRoot);

  if (options.rebuild) {
    io.stdout("Rebuilding dist/ before restart...");
    const buildExitCode = await deps.runBuild(repoRoot, io);
    if (buildExitCode !== 0) {
      throw new Error(`Build failed with exit code ${buildExitCode}.`);
    }
  } else {
    await ensureBuildArtifact(repoRoot);
  }

  if (isRuntimeActive(state) || hasLiveRuntimeProcess(state, deps.isProcessAlive)) {
    const stopExitCode = await runStop(repoRoot, io, deps.sleep, deps.isProcessAlive, deps.signalRuntimeProcess);
    if (stopExitCode !== 0) {
      throw new Error("Detached runtime did not stop cleanly. Resolve the running process before restarting.");
    }
  }

  return await runStart(repoRoot, io, { rebuild: false }, deps);
}

async function runDoctor(repoRoot: string, io: CliIo): Promise<number> {
  const checks: DoctorCheck[] = [];
  const envMap = loadEnvFile(repoRoot);
  const silentLogger = createSilentLogger();

  let manifest;
  try {
    manifest = loadAgentsManifest(repoRoot);
    checks.push({ ok: true, label: `manifest loaded (${manifest.agents.length} agents)` });
  } catch (error) {
    checks.push({ ok: false, label: `manifest load failed: ${sanitizeError(error)}` });
    for (const check of checks) {
      io.stdout(`${check.ok ? "ok  " : "fail"} ${check.label}`);
    }
    return 1;
  }

  const loadedConfigs: Array<{ agent: (typeof manifest.agents)[number]; config: Awaited<ReturnType<typeof loadAgentConfig>> }> = [];

  for (const agent of manifest.agents) {
    try {
      const config = loadAgentConfig(repoRoot, agent, extractAgentSecrets(envMap, agent.id));
      loadedConfigs.push({ agent, config });
      checks.push({ ok: true, label: `config parsed: ${agent.id}` });
    } catch (error) {
      checks.push({ ok: false, label: `config invalid: ${agent.id} (${sanitizeError(error)})` });
    }
  }

  try {
    validateUniqueBotTokens(loadedConfigs);
    checks.push({ ok: true, label: "bot tokens are unique" });
  } catch (error) {
    checks.push({ ok: false, label: `bot token validation failed: ${sanitizeError(error)}` });
  }

  let codexAuth = null;
  try {
    codexAuth = createCodexAuthManager(silentLogger);
  } catch {
    codexAuth = null;
  }

  for (const { agent, config } of loadedConfigs) {
    const registry = createAuthModeRegistry({
      apiKey: config.openai.apiKey,
      codexAuth
    });
    const availability = registry.get(config.openai.authMode).availability();
    checks.push({
      ok: availability.ok,
      label: availability.ok
        ? `auth available: ${agent.id} (${config.openai.authMode})`
        : `auth unavailable: ${agent.id} (${config.openai.authMode}) - ${availability.reason}`
    });
  }

  try {
    await checkControlDirectoryAvailable(repoRoot);
    checks.push({ ok: true, label: "control directory writable" });
  } catch (error) {
    checks.push({ ok: false, label: `control directory unavailable: ${sanitizeError(error)}` });
  }

  try {
    await ensureBuildArtifact(repoRoot);
    checks.push({ ok: true, label: "build artifact present" });
  } catch (error) {
    checks.push({ ok: false, label: sanitizeError(error) });
  }

  try {
    const { state, changed } = await reconcileRuntimeControlState(repoRoot);
    checks.push({
      ok: true,
      label: changed
        ? `stale runtime state reconciled (status=${state.status})`
        : `runtime state healthy (status=${state.status})`
    });
  } catch (error) {
    checks.push({ ok: false, label: `runtime state reconciliation failed: ${sanitizeError(error)}` });
  }

  for (const check of checks) {
    io.stdout(`${check.ok ? "ok  " : "fail"} ${check.label}`);
  }

  return checks.every((check) => check.ok) ? 0 : 1;
}

async function runInternalRuntime(
  repoRoot: string,
  instanceId: string | null,
  runtimeStarter: (repoRoot: string, hooks?: RuntimeLifecycleHooks) => Promise<void>
): Promise<number> {
  const hooks: RuntimeLifecycleHooks | undefined = instanceId
    ? {
        onReady: async () => {
          const current = await readRuntimeControlState(repoRoot);
          if (current.instanceId !== instanceId) {
            return;
          }

          await writeRuntimeControlState(repoRoot, {
            ...current,
            status: "running",
            pid: process.pid,
            stoppedAt: null,
            lastError: null
          });
        },
        onShutdown: async ({ error }) => {
          const current = await readRuntimeControlState(repoRoot);
          if (current.instanceId !== instanceId) {
            return;
          }

          await writeRuntimeControlState(repoRoot, {
            ...current,
            status: "stopped",
            pid: null,
            stoppedAt: new Date().toISOString(),
            lastError: error ? sanitizeError(error) : current.lastError
          });
        },
        onStartupError: async (error) => {
          const current = await readRuntimeControlState(repoRoot);
          const baseState = current.instanceId === instanceId ? current : createDefaultRuntimeControlState(repoRoot);
          await writeRuntimeControlState(repoRoot, {
            ...baseState,
            instanceId,
            status: "failed",
            pid: null,
            agentIds: baseState.agentIds,
            stoppedAt: new Date().toISOString(),
            lastError: sanitizeError(error)
          });
        }
      }
    : undefined;

  try {
    await runtimeStarter(repoRoot, hooks);
    return 0;
  } catch {
    return 1;
  }
}

export async function runCli(deps: RunCliDeps): Promise<number> {
  const io: CliIo = {
    ...defaultCliIo(),
    ...deps.io
  };
  const parsed = parseCliCommand(deps.argv);

  if (!parsed.ok) {
    io.stderr(parsed.error);
    io.stderr(renderUsage());
    return 1;
  }

  const command: CliCommand = parsed.command;
  const runBuild = deps.runBuild ?? defaultRunBuild;
  const spawnDetachedRuntime = deps.spawnDetachedRuntime ?? defaultSpawnDetachedRuntime;
  const runtimeStarter = deps.startRuntime ?? startRuntime;
  const sleeper = deps.sleep ?? sleep;
  const runtimeIsAlive = deps.isRuntimeProcessAlive ?? isProcessAlive;
  const sendRuntimeSignal = deps.signalRuntimeProcess ?? signalRuntimeProcess;

  try {
    switch (command.name) {
      case "help":
        io.stdout(renderUsage());
        return 0;
      case "status":
        return await runStatus(deps.repoRoot, io);
      case "start":
        return await runStart(deps.repoRoot, io, { rebuild: command.rebuild }, {
          runBuild,
          spawnDetachedRuntime,
          sleep: sleeper,
          isProcessAlive: runtimeIsAlive
        });
      case "stop":
        return await runStop(deps.repoRoot, io, sleeper, runtimeIsAlive, sendRuntimeSignal);
      case "restart":
        return await runRestart(deps.repoRoot, io, { rebuild: command.rebuild }, {
          runBuild,
          spawnDetachedRuntime,
          sleep: sleeper,
          isProcessAlive: runtimeIsAlive,
          signalRuntimeProcess: sendRuntimeSignal
        });
      case "doctor":
        return await runDoctor(deps.repoRoot, io);
      case "__runtime":
        return await runInternalRuntime(deps.repoRoot, command.instanceId, runtimeStarter);
      default:
        return 1;
    }
  } catch (error) {
    io.stderr(sanitizeError(error));
    return 1;
  }
}
