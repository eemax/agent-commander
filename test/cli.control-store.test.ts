import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cliStatePath,
  createDefaultRuntimeControlState,
  readRuntimeControlState,
  reconcileRuntimeControlState,
  runtimeLogPath,
  writeRuntimeControlState
} from "../src/cli/control-store.js";
import { createTempDir } from "./helpers.js";

describe("cli control store", () => {
  it("returns a default stopped state when cli.json is missing", async () => {
    const root = createTempDir("acmd-cli-state-default-");
    const state = await readRuntimeControlState(root);

    expect(state.status).toBe("stopped");
    expect(state.pid).toBeNull();
    expect(state.logPath).toBe(runtimeLogPath(root));
  });

  it("round-trips runtime control state through disk", async () => {
    const root = createTempDir("acmd-cli-state-write-");
    const written = await writeRuntimeControlState(root, {
      ...createDefaultRuntimeControlState(root),
      instanceId: "rt_test",
      status: "running",
      pid: 1234,
      agentIds: ["default", "ysera"],
      startedAt: "2026-03-30T00:00:00.000Z"
    });

    const loaded = await readRuntimeControlState(root);
    expect(loaded).toEqual(written);
    expect(cliStatePath(root)).toContain(path.join(".agent-commander", "cli.json"));
  });

  it("reconciles stale active state when pid is missing", async () => {
    const root = createTempDir("acmd-cli-state-reconcile-");
    await writeRuntimeControlState(root, {
      ...createDefaultRuntimeControlState(root),
      instanceId: "rt_stale",
      status: "running",
      pid: null,
      agentIds: ["default"],
      startedAt: "2026-03-30T00:00:00.000Z"
    });

    const result = await reconcileRuntimeControlState(root);
    expect(result.changed).toBe(true);
    expect(result.state.status).toBe("stopped");
    expect(result.state.pid).toBeNull();
    expect(result.state.stoppedAt).not.toBeNull();
  });
});
