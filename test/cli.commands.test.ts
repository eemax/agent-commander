import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import {
  createDefaultRuntimeControlState,
  readRuntimeControlState,
  runtimeLogPath,
  writeRuntimeControlState
} from "../src/cli/control-store.js";
import { createTempDir } from "./helpers.js";

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function minimalRootConfig(): Record<string, unknown> {
  return {
    telegram: {},
    openai: {},
    runtime: {},
    tools: {},
    paths: {},
    observability: {}
  };
}

function setupRepo(options: {
  withEnv?: boolean;
  withBuild?: boolean;
  withSecondAgent?: boolean;
} = {}): string {
  const root = createTempDir("acmd-cli-cmds-");
  const withEnv = options.withEnv ?? true;
  const withBuild = options.withBuild ?? true;
  const withSecondAgent = options.withSecondAgent ?? true;

  writeJson(path.join(root, "config", "config.json"), minimalRootConfig());
  const agents = [
    { id: "default", aliases: ["main"], config_dir: ".", telegram_allowlist: ["1001"] }
  ];
  if (withSecondAgent) {
    fs.mkdirSync(path.join(root, ".agent-commander", "ysera"), { recursive: true });
    agents.push({ id: "ysera", aliases: ["ysera"], config_dir: ".agent-commander/ysera", telegram_allowlist: ["1001"] });
  }
  writeJson(path.join(root, "config", "agents.json"), { agents });

  if (withEnv) {
    fs.writeFileSync(
      path.join(root, ".env"),
      [
        "DEFAULT_TELEGRAM_BOT_TOKEN=tg-default",
        "DEFAULT_OPENAI_API_KEY=oa-default",
        "YSERA_TELEGRAM_BOT_TOKEN=tg-ysera",
        "YSERA_OPENAI_API_KEY=oa-ysera"
      ].join("\n"),
      "utf8"
    );
  }

  if (withBuild) {
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "index.js"), "console.log('stub');\n", "utf8");
  }

  return root;
}

function captureIo(): { stdout: string[]; stderr: string[] } {
  return {
    stdout: [],
    stderr: []
  };
}

describe("cli commands", () => {
  it("starts a detached runtime and waits for running state", async () => {
    const root = setupRepo();
    const io = captureIo();

    const exitCode = await runCli({
      repoRoot: root,
      argv: ["start"],
      io: {
        stdout: (line) => {
          io.stdout.push(line);
        },
        stderr: (line) => {
          io.stderr.push(line);
        }
      },
      spawnDetachedRuntime: async () => {
        setTimeout(() => {
          void (async () => {
            const current = await readRuntimeControlState(root);
            await writeRuntimeControlState(root, {
              ...current,
              status: "running",
              pid: process.pid
            });
          })();
        }, 0);
        return { pid: process.pid };
      }
    });

    const state = await readRuntimeControlState(root);
    expect(exitCode).toBe(0);
    expect(state.status).toBe("running");
    expect(state.pid).toBe(process.pid);
    expect(state.agentIds).toEqual(["default", "ysera"]);
    expect(io.stdout.some((line) => line.includes("Detached runtime running"))).toBe(true);
    expect(io.stderr).toEqual([]);
  });

  it("refuses to start when a detached runtime is already active", async () => {
    const root = setupRepo();
    const io = captureIo();
    await writeRuntimeControlState(root, {
      ...createDefaultRuntimeControlState(root),
      instanceId: "rt_live",
      status: "running",
      pid: process.pid,
      agentIds: ["default", "ysera"],
      startedAt: "2026-03-30T00:00:00.000Z",
      logPath: runtimeLogPath(root)
    });

    const exitCode = await runCli({
      repoRoot: root,
      argv: ["start"],
      io: {
        stdout: (line) => {
          io.stdout.push(line);
        },
        stderr: (line) => {
          io.stderr.push(line);
        }
      }
    });

    expect(exitCode).toBe(1);
    expect(io.stderr.some((line) => line.includes("Detached runtime already running"))).toBe(true);
  });

  it("treats stop as a no-op when nothing is running", async () => {
    const root = setupRepo();
    const io = captureIo();

    const exitCode = await runCli({
      repoRoot: root,
      argv: ["stop"],
      io: {
        stdout: (line) => {
          io.stdout.push(line);
        },
        stderr: (line) => {
          io.stderr.push(line);
        }
      }
    });

    expect(exitCode).toBe(0);
    expect(io.stdout).toContain("No detached runtime is running.");
    expect(io.stderr).toEqual([]);
  });

  it("forces a stuck runtime to stop after the grace timeout", async () => {
    vi.useFakeTimers();
    let alive = true;
    const signals: NodeJS.Signals[] = [];

    try {
      const root = setupRepo();
      const io = captureIo();
      await writeRuntimeControlState(root, {
        ...createDefaultRuntimeControlState(root),
        instanceId: "rt_stuck",
        status: "running",
        pid: process.pid,
        agentIds: ["default", "ysera"],
        startedAt: "2026-03-30T00:00:00.000Z",
        logPath: runtimeLogPath(root)
      });

      const exitCode = await runCli({
        repoRoot: root,
        argv: ["stop"],
        io: {
          stdout: (line) => {
            io.stdout.push(line);
          },
          stderr: (line) => {
            io.stderr.push(line);
          }
        },
        sleep: async (ms) => {
          await vi.advanceTimersByTimeAsync(ms);
        },
        isRuntimeProcessAlive: () => alive,
        signalRuntimeProcess: (_pid, signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") {
            alive = false;
          }
        }
      });

      const state = await readRuntimeControlState(root);
      expect(exitCode).toBe(0);
      expect(state.status).toBe("stopped");
      expect(state.pid).toBeNull();
      expect(state.lastError).toBe("Runtime required SIGKILL after 10000ms.");
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the current runtime running when restart --rebuild fails to build", async () => {
    const root = setupRepo();
    const io = captureIo();
    const initialState = await writeRuntimeControlState(root, {
      ...createDefaultRuntimeControlState(root),
      instanceId: "rt_current",
      status: "running",
      pid: process.pid,
      agentIds: ["default", "ysera"],
      startedAt: "2026-03-30T00:00:00.000Z",
      logPath: runtimeLogPath(root)
    });

    const exitCode = await runCli({
      repoRoot: root,
      argv: ["restart", "--rebuild"],
      io: {
        stdout: (line) => {
          io.stdout.push(line);
        },
        stderr: (line) => {
          io.stderr.push(line);
        }
      },
      runBuild: async () => 1
    });

    const state = await readRuntimeControlState(root);
    expect(exitCode).toBe(1);
    expect(state).toEqual(initialState);
    expect(io.stderr.some((line) => line.includes("Build failed with exit code 1"))).toBe(true);
  });

  it("refuses to restart when the existing runtime does not stop cleanly", async () => {
    vi.useFakeTimers();
    const spawnDetachedRuntime = vi.fn();
    const signals: NodeJS.Signals[] = [];

    try {
      const root = setupRepo();
      const io = captureIo();
      await writeRuntimeControlState(root, {
        ...createDefaultRuntimeControlState(root),
        instanceId: "rt_stuck",
        status: "running",
        pid: process.pid,
        agentIds: ["default", "ysera"],
        startedAt: "2026-03-30T00:00:00.000Z",
        logPath: runtimeLogPath(root)
      });

      const exitCode = await runCli({
        repoRoot: root,
        argv: ["restart"],
        io: {
          stdout: (line) => {
            io.stdout.push(line);
          },
          stderr: (line) => {
            io.stderr.push(line);
          }
        },
        sleep: async (ms) => {
          await vi.advanceTimersByTimeAsync(ms);
        },
        isRuntimeProcessAlive: () => true,
        signalRuntimeProcess: (_pid, signal) => {
          signals.push(signal);
        },
        spawnDetachedRuntime
      });

      const state = await readRuntimeControlState(root);
      expect(exitCode).toBe(1);
      expect(spawnDetachedRuntime).not.toHaveBeenCalled();
      expect(state.status).toBe("stopping");
      expect(state.pid).toBe(process.pid);
      expect(state.lastError).toBe(`Detached runtime did not exit after SIGKILL. pid=${process.pid}`);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(io.stderr.some((line) => line.includes("did not stop cleanly"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doctor fails on missing env, missing build artifacts, and unwritable control dir", async () => {
    const root = setupRepo({ withEnv: false, withBuild: false, withSecondAgent: false });
    fs.mkdirSync(path.join(root, ".agent-commander"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent-commander", "control"), "not-a-directory\n", "utf8");
    const io = captureIo();

    const exitCode = await runCli({
      repoRoot: root,
      argv: ["doctor"],
      io: {
        stdout: (line) => {
          io.stdout.push(line);
        },
        stderr: (line) => {
          io.stderr.push(line);
        }
      }
    });

    expect(exitCode).toBe(1);
    expect(io.stdout.some((line) => line.includes("fail config invalid: default"))).toBe(true);
    expect(io.stdout.some((line) => line.includes("fail control directory unavailable"))).toBe(true);
    expect(io.stdout.some((line) => line.includes("fail Build artifact missing"))).toBe(true);
  });

  it("doctor does not create the control directory when it only checks availability", async () => {
    const root = setupRepo({ withSecondAgent: false });
    const io = captureIo();

    const exitCode = await runCli({
      repoRoot: root,
      argv: ["doctor"],
      io: {
        stdout: (line) => {
          io.stdout.push(line);
        },
        stderr: (line) => {
          io.stderr.push(line);
        }
      }
    });

    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(root, ".agent-commander", "control"))).toBe(false);
    expect(io.stdout.some((line) => line.includes("ok   control directory writable"))).toBe(true);
  });
});
