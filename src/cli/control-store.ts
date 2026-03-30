import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RuntimeControlState, RuntimeControlStatus } from "./types.js";

const ACTIVE_RUNTIME_STATUSES: ReadonlySet<RuntimeControlStatus> = new Set(["starting", "running", "stopping"]);

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeStatus(value: unknown): value is RuntimeControlStatus {
  return value === "stopped" || value === "starting" || value === "running" || value === "stopping" || value === "failed";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function parseRuntimeControlState(raw: unknown, repoRoot: string): RuntimeControlState {
  if (!isRecord(raw)) {
    throw new Error("Invalid CLI state: expected object");
  }

  if (!isRuntimeStatus(raw.status)) {
    throw new Error("Invalid CLI state: status is missing or invalid");
  }

  const instanceId = raw.instance_id === null ? null : asNullableString(raw.instance_id);
  const pid = raw.pid === null ? null : asNullableNumber(raw.pid);
  const agentIds = Array.isArray(raw.agent_ids) ? raw.agent_ids.filter((item): item is string => typeof item === "string") : null;
  const startedAt = raw.started_at === null ? null : asNullableString(raw.started_at);
  const updatedAt = asNullableString(raw.updated_at);
  const stoppedAt = raw.stopped_at === null ? null : asNullableString(raw.stopped_at);
  const logPath = asNullableString(raw.log_path);
  const lastError = raw.last_error === null ? null : asNullableString(raw.last_error);

  if (instanceId === undefined || pid === undefined || agentIds === null || startedAt === undefined || updatedAt === null || stoppedAt === undefined || logPath === null || lastError === undefined) {
    throw new Error("Invalid CLI state: one or more required fields are missing");
  }

  return {
    instanceId,
    status: raw.status,
    pid,
    agentIds,
    startedAt,
    updatedAt,
    stoppedAt,
    logPath: path.resolve(repoRoot, logPath),
    lastError
  };
}

function serializeRuntimeControlState(state: RuntimeControlState, repoRoot: string): Record<string, unknown> {
  return {
    instance_id: state.instanceId,
    status: state.status,
    pid: state.pid,
    agent_ids: state.agentIds,
    started_at: state.startedAt,
    updated_at: state.updatedAt,
    stopped_at: state.stoppedAt,
    log_path: path.relative(repoRoot, state.logPath) || path.basename(state.logPath),
    last_error: state.lastError
  };
}

async function atomicWriteJson(targetPath: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, targetPath);
}

export function cliStateDirPath(repoRoot: string): string {
  return path.resolve(repoRoot, ".agent-commander");
}

export function cliStatePath(repoRoot: string): string {
  return path.join(cliStateDirPath(repoRoot), "cli.json");
}

export function runtimeLogPath(repoRoot: string): string {
  return path.join(cliStateDirPath(repoRoot), "runtime.log");
}

export function createDefaultRuntimeControlState(repoRoot: string): RuntimeControlState {
  return {
    instanceId: null,
    status: "stopped",
    pid: null,
    agentIds: [],
    startedAt: null,
    updatedAt: nowIso(),
    stoppedAt: null,
    logPath: runtimeLogPath(repoRoot),
    lastError: null
  };
}

export async function readRuntimeControlState(repoRoot: string): Promise<RuntimeControlState> {
  const statePath = cliStatePath(repoRoot);

  try {
    const raw = await fs.readFile(statePath, "utf8");
    return parseRuntimeControlState(JSON.parse(raw) as unknown, repoRoot);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
    if (errorCode === "ENOENT") {
      return createDefaultRuntimeControlState(repoRoot);
    }
    throw error;
  }
}

export async function writeRuntimeControlState(repoRoot: string, state: RuntimeControlState): Promise<RuntimeControlState> {
  const nextState: RuntimeControlState = {
    ...state,
    updatedAt: nowIso(),
    logPath: path.resolve(state.logPath)
  };
  await atomicWriteJson(cliStatePath(repoRoot), serializeRuntimeControlState(nextState, repoRoot));
  return nextState;
}

export function isRuntimeActive(state: RuntimeControlState): boolean {
  return ACTIVE_RUNTIME_STATUSES.has(state.status);
}

export function isProcessAlive(pid: number | null): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

export async function reconcileRuntimeControlState(repoRoot: string): Promise<{ state: RuntimeControlState; changed: boolean }> {
  const state = await readRuntimeControlState(repoRoot);

  if (!isRuntimeActive(state)) {
    return { state, changed: false };
  }

  if (state.pid === null || !isProcessAlive(state.pid)) {
    const reconciled = await writeRuntimeControlState(repoRoot, {
      ...state,
      status: "stopped",
      pid: null,
      stoppedAt: nowIso()
    });
    return {
      state: reconciled,
      changed: true
    };
  }

  return { state, changed: false };
}
