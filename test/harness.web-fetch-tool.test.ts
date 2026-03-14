import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createToolHarness } from "../src/harness/index.js";

function createHarnessRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("web_fetch tool", () => {
  it("uses defuddle markdown extraction by default", async () => {
    const root = createHarnessRoot("acmd-web-fetch-defuddle-");
    const runDefuddle = vi.fn(async () => ({
      markdown: "# Example\n\nHello from defuddle."
    }));

    const harness = createToolHarness(
      {
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
          maxTokens: 10_000,
          maxTokensPerPage: 4_096
        }
      },
      {
        runDefuddle
      }
    );

    const output = await harness.execute("web_fetch", {
      url: "https://example.com/article"
    });

    expect(runDefuddle).toHaveBeenCalledWith("https://example.com/article", 1_800_000);
    expect(output).toEqual({
      url: "https://example.com/article",
      mode: "defuddle",
      content: "# Example\n\nHello from defuddle."
    });
  });

  it("fails clearly when defuddle extraction fails", async () => {
    const root = createHarnessRoot("acmd-web-fetch-defuddle-error-");
    const runDefuddle = vi.fn(async () => {
      throw new Error("defuddle command not found");
    });

    const harness = createToolHarness(
      {
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
          maxTokens: 10_000,
          maxTokensPerPage: 4_096
        }
      },
      {
        runDefuddle
      }
    );

    await expect(
      harness.execute("web_fetch", {
        url: "https://example.com/article"
      })
    ).rejects.toThrow("Defuddle fetch failed: defuddle command not found");
  });

  it("normalizes url aliases and ignores legacy mode aliases before validation", async () => {
    const root = createHarnessRoot("acmd-web-fetch-alias-");
    const runDefuddle = vi.fn(async () => ({
      markdown: "alias mode content"
    }));

    const harness = createToolHarness(
      {
        defaultCwd: root,
        defaultShell: "/bin/bash",
        execTimeoutMs: 1_800_000,
        execYieldMs: 10_000,
        processLogTailLines: 200,
        logPath: ".agent-commander/tool-calls.jsonl",
        completedSessionRetentionMs: 3_600_000,
        maxCompletedSessions: 500,
        maxOutputChars: 200_000
      },
      {
        runDefuddle
      }
    );

    const output = await harness.execute("web_fetch", {
      link: "https://example.com/alias",
      fetchMode: "DEFUDDLE"
    });

    expect(runDefuddle).toHaveBeenCalledWith("https://example.com/alias", 1_800_000);
    expect(output).toEqual({
      url: "https://example.com/alias",
      mode: "defuddle",
      content: "alias mode content"
    });
  });

  it("fails even when web_search api key is missing", async () => {
    const root = createHarnessRoot("acmd-web-fetch-no-fallback-");
    const runDefuddle = vi.fn(async () => {
      throw new Error("defuddle command not found");
    });

    const harness = createToolHarness(
      {
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
          maxTokens: 10_000,
          maxTokensPerPage: 4_096
        }
      },
      {
        runDefuddle
      }
    );

    await expect(
      harness.execute("web_fetch", {
        url: "https://example.com/article"
      })
    ).rejects.toThrow("Defuddle fetch failed: defuddle command not found");
  });

  it("rejects non-http URLs", async () => {
    const root = createHarnessRoot("acmd-web-fetch-validate-");
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

    await expect(
      harness.execute("web_fetch", {
        url: "ftp://example.com/file.txt"
      })
    ).rejects.toThrow("Invalid arguments for web_fetch");
  });
});
