import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolCallLogger } from "../src/harness/logger.js";
import { createTempDir } from "./helpers.js";

describe("ToolCallLogger", () => {
  it("keeps only the newest tool-call log lines when maxLines is configured", async () => {
    const root = createTempDir("acmd-tool-log-cap-");
    const logPath = path.join(root, "tool-calls.jsonl");
    const logger = new ToolCallLogger(logPath, root, 2);

    await logger.write({
      timestamp: "2026-03-29T00:00:00.000Z",
      startedAt: "2026-03-29T00:00:00.000Z",
      finishedAt: "2026-03-29T00:00:00.100Z",
      tool: "bash",
      args: { command: "one" },
      success: true,
      error: null
    });
    await logger.write({
      timestamp: "2026-03-29T00:00:01.000Z",
      startedAt: "2026-03-29T00:00:01.000Z",
      finishedAt: "2026-03-29T00:00:01.100Z",
      tool: "bash",
      args: { command: "two" },
      success: true,
      error: null
    });
    await logger.write({
      timestamp: "2026-03-29T00:00:02.000Z",
      startedAt: "2026-03-29T00:00:02.000Z",
      finishedAt: "2026-03-29T00:00:02.100Z",
      tool: "bash",
      args: { command: "three" },
      success: true,
      error: null
    });

    const entries = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => (entry.args as { command?: string }).command)).toEqual(["two", "three"]);
  });
});
