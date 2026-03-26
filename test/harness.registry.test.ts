import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolExecutionError } from "../src/harness/errors.js";
import { createToolHarness } from "../src/harness/index.js";
import { createObservabilitySink } from "../src/observability.js";

function createHarnessRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("tool registry", () => {
  it("registers exactly the eight canonical tools", () => {
    const root = createHarnessRoot("acmd-harness-registry-");
    const harness = createToolHarness({
      defaultCwd: root,
      defaultShell: "/bin/bash",
      execTimeoutMs: 1_800_000,
      execYieldMs: 10_000,
      processLogTailLines: 200,
      logPath: ".agent-commander/tool-calls.jsonl",
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000,
      subagents: {
        enabled: true,
        defaultModel: "gpt-5.4-mini",
        maxConcurrentTasks: 10,
        defaultTimeBudgetSec: 900,
        defaultMaxTurns: 30,
        defaultMaxTotalTokens: 500_000,
        defaultHeartbeatIntervalSec: 30,
        defaultIdleTimeoutSec: 120,
        defaultStallTimeoutSec: 300,
        defaultRequirePlanByTurn: 3,
        recvMaxEvents: 100,
        recvDefaultWaitMs: 200,
        awaitMaxTimeoutMs: 30_000
      }
    });

    const names = harness.registry
      .list()
      .map((tool) => tool.name)
      .sort();

    expect(names).toEqual([
      "apply_patch",
      "bash",
      "process",
      "read_file",
      "replace_in_file",
      "subagents",
      "web_fetch",
      "write_file"
    ]);

    const providerTools = harness.exportProviderTools();
    expect(providerTools).toHaveLength(8);
    for (const tool of providerTools) {
      expect(tool.type).toBe("function");
      expect(typeof tool.parameters).toBe("object");
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters).not.toHaveProperty("$schema");
      expect(tool.parameters).not.toHaveProperty("anyOf");
      expect(tool.parameters).not.toHaveProperty("oneOf");
      expect(tool.parameters).not.toHaveProperty("allOf");
      expect(tool.parameters).not.toHaveProperty("enum");
      expect(tool.parameters).not.toHaveProperty("not");
    }

    const processDefinition = providerTools.find((tool) => tool.name === "process");
    expect(processDefinition).toBeDefined();
    const processProperties = processDefinition?.parameters.properties as Record<string, unknown>;
    expect(processProperties).toBeDefined();
    expect(processDefinition?.parameters.required).toEqual(["action"]);

    const actionSchema = processProperties.action as Record<string, unknown>;
    expect(actionSchema.type).toBe("string");
    expect(actionSchema.enum).toEqual(["list", "poll", "log", "write", "kill", "clear", "remove"]);
  });

  it("registers web_search only when tools.webSearch.apiKey is configured", () => {
    const root = createHarnessRoot("acmd-harness-registry-web-search-");

    const disabledHarness = createToolHarness({
      defaultCwd: root,
      defaultShell: "/bin/bash",
      execTimeoutMs: 1_800_000,
      execYieldMs: 10_000,
      processLogTailLines: 200,
      logPath: ".agent-commander/tool-calls.jsonl",
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000,
      webSearch: {
        apiKey: null,
        defaultPreset: "sonar",
        presets: [{ id: "sonar", aliases: [] }]
      }
    });

    expect(disabledHarness.registry.list().map((tool) => tool.name)).toContain("web_fetch");
    expect(disabledHarness.registry.list().map((tool) => tool.name)).not.toContain("web_search");

    const enabledHarness = createToolHarness({
      defaultCwd: root,
      defaultShell: "/bin/bash",
      execTimeoutMs: 1_800_000,
      execYieldMs: 10_000,
      processLogTailLines: 200,
      logPath: ".agent-commander/tool-calls.jsonl",
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000,
      webSearch: {
        apiKey: "pplx-key",
        defaultPreset: "sonar",
        presets: [{ id: "sonar", aliases: [] }]
      }
    });

    expect(enabledHarness.registry.list().map((tool) => tool.name)).toContain("web_search");
    expect(enabledHarness.registry.list().map((tool) => tool.name)).toContain("web_fetch");
    expect(enabledHarness.exportProviderTools().find((tool) => tool.name === "web_search")).toBeDefined();
  });

  it("validates input before execution and logs tool calls", async () => {
    const root = createHarnessRoot("acmd-harness-validate-");
    const observabilityPath = path.join(root, ".agent-commander/observability.jsonl");
    const harness = createToolHarness({
      defaultCwd: root,
      defaultShell: "/bin/bash",
      execTimeoutMs: 1_800_000,
      execYieldMs: 10_000,
      processLogTailLines: 200,
      logPath: ".agent-commander/tool-calls.jsonl",
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
    maxOutputChars: 200_000
    }, {
      observability: createObservabilitySink({
        enabled: true,
        logPath: observabilityPath
      })
    });

    await expect(
      harness.execute("write_file", {
        path: "foo.txt"
      })
    ).rejects.toThrow("Invalid arguments for write_file");

    await expect(
      harness.execute("write_file", {
        path: "foo.txt",
        content: "ok"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        path: path.join(root, "foo.txt")
      })
    );

    const logPath = path.join(root, ".agent-commander/tool-calls.jsonl");
    const lines = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { tool: string; success: boolean; error: string | null });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual(
      expect.objectContaining({
        tool: "write_file",
        success: false
      })
    );
    expect(lines[1]).toEqual(
      expect.objectContaining({
        tool: "write_file",
        success: true,
        error: null
      })
    );

    const observabilityEntries = fs
      .readFileSync(observabilityPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const toolEntries = observabilityEntries.filter((entry) => entry.event === "tool.execution.completed");
    expect(toolEntries).toHaveLength(2);
    expect(toolEntries[0]).toEqual(
      expect.objectContaining({
        tool: "write_file",
        success: false
      })
    );
    expect(toolEntries[1]).toEqual(
      expect.objectContaining({
        tool: "write_file",
        success: true
      })
    );
    expect((toolEntries[1].result as { ok?: boolean }).ok).toBe(true);
  });

  it("returns structured validation errors with hints and expected fields", async () => {
    const root = createHarnessRoot("acmd-harness-structured-error-");
    const harness = createToolHarness({
      defaultCwd: root,
      defaultShell: "/bin/bash",
      execTimeoutMs: 1_800_000,
      execYieldMs: 10_000,
      processLogTailLines: 200,
      logPath: ".agent-commander/tool-calls.jsonl",
      completedSessionRetentionMs: 3_600_000,
      maxCompletedSessions: 500,
      maxOutputChars: 200_000
    });

    const error = await harness
      .execute("write_file", {
        path: "notes.txt"
      })
      .catch((err) => err);

    expect(error).toBeInstanceOf(ToolExecutionError);
    const payload = (error as ToolExecutionError).payload;
    expect(payload).toEqual(
      expect.objectContaining({
        ok: false,
        errorCode: "TOOL_VALIDATION_ERROR",
        retryable: true
      })
    );
    expect(payload.hints.length).toBeGreaterThan(0);
    expect(payload.expected).toEqual(
      expect.objectContaining({
        required: ["path", "content"]
      })
    );
  });
});
