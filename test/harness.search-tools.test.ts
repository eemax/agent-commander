import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createToolHarness } from "../src/harness/index.js";
import { createGlobTool, createGrepTool } from "../src/harness/search-tools.js";
import type { ToolContext } from "../src/harness/types.js";

function createHarnessRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createHarness(root: string, overrides: { maxOutputChars?: number } = {}) {
  return createToolHarness({
    defaultCwd: root,
    defaultShell: "/bin/bash",
    execTimeoutMs: 30_000,
    execYieldMs: 10_000,
    processLogTailLines: 200,
    logPath: ".agent-commander/tool-calls.jsonl",
    completedSessionRetentionMs: 3_600_000,
    maxCompletedSessions: 500,
    maxOutputChars: overrides.maxOutputChars ?? 200_000
  });
}

const hasRipgrep = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
const describeWithRg = hasRipgrep ? describe : describe.skip;

describeWithRg("search tools", () => {
  it("glob respects .gitignore, includes hidden files, and excludes .git", async () => {
    const root = createHarnessRoot("acmd-glob-tool-");
    const harness = createHarness(root);

    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "config.txt"), "ignored\n", "utf8");
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n", "utf8");
    fs.mkdirSync(path.join(root, "ignored"), { recursive: true });
    fs.writeFileSync(path.join(root, "ignored", "skip.txt"), "skip\n", "utf8");
    fs.writeFileSync(path.join(root, ".hidden.txt"), "hidden\n", "utf8");
    fs.writeFileSync(path.join(root, "src.txt"), "visible\n", "utf8");

    const result = await harness.execute("glob", {
      pattern: "**/*.txt",
      path: "."
    });

    expect(result).toEqual(
      expect.objectContaining({
        path: root,
        matches: [".hidden.txt", "src.txt"],
        truncated: false
      })
    );
  });

  it("glob truncates after the configured result limit", async () => {
    const root = createHarnessRoot("acmd-glob-limit-");
    const harness = createHarness(root);

    for (let index = 0; index < 2_001; index += 1) {
      fs.writeFileSync(path.join(root, `file_${String(index).padStart(4, "0")}.txt`), "x\n", "utf8");
    }

    const result = await harness.execute("glob", {
      pattern: "*.txt"
    });

    expect(result).toEqual(
      expect.objectContaining({
        truncated: true,
        resultLimit: 2_000
      })
    );
    expect((result as { matches: string[] }).matches).toHaveLength(2_000);
    expect((result as { note: string }).note).toContain("2000 paths");
  });

  it("glob rejects file paths and requires a directory search root", async () => {
    const root = createHarnessRoot("acmd-glob-file-path-");
    const harness = createHarness(root);

    fs.writeFileSync(path.join(root, "src.txt"), "visible\n", "utf8");

    await expect(
      harness.execute("glob", {
        pattern: "*.txt",
        path: "src.txt"
      })
    ).rejects.toThrow("Search path must be a directory for glob");
  });

  it("glob returns partial results when some directories cannot be listed", async () => {
    const root = createHarnessRoot("acmd-glob-partial-");
    const harness = createHarness(root);
    const unreadableDir = path.join(root, "bad");

    fs.mkdirSync(path.join(root, "ok"), { recursive: true });
    fs.mkdirSync(unreadableDir, { recursive: true });
    fs.writeFileSync(path.join(root, "ok", "file.txt"), "visible\n", "utf8");
    fs.writeFileSync(path.join(unreadableDir, "file.txt"), "hidden\n", "utf8");
    fs.chmodSync(unreadableDir, 0o000);

    try {
      const result = await harness.execute("glob", {
        pattern: "*.txt",
        path: "."
      }) as {
        matches: string[];
        partial?: boolean;
        warning?: string;
        truncated: boolean;
      };

      expect(result.matches).toEqual(["ok/file.txt"]);
      expect(result.partial).toBe(true);
      expect(result.warning).toContain("results may be incomplete");
      expect(result.truncated).toBe(false);
    } finally {
      fs.chmodSync(unreadableDir, 0o755);
    }
  });

  it("grep respects .gitignore, includes hidden files, and excludes .git", async () => {
    const root = createHarnessRoot("acmd-grep-tool-");
    const harness = createHarness(root);

    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "config.txt"), "findme\n", "utf8");
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n", "utf8");
    fs.mkdirSync(path.join(root, "ignored"), { recursive: true });
    fs.writeFileSync(path.join(root, "ignored", "skip.txt"), "findme\n", "utf8");
    fs.mkdirSync(path.join(root, ".config"), { recursive: true });
    fs.writeFileSync(path.join(root, ".config", "settings.txt"), "findme\n", "utf8");
    fs.writeFileSync(path.join(root, "src.txt"), "findme\n", "utf8");

    const result = await harness.execute("grep", {
      pattern: "findme",
      path: "."
    }) as {
      path: string;
      matches: Array<{ path: string; line: number; text: string }>;
      filesScanned: number;
      truncated: boolean;
    };

    expect(result.path).toBe(root);
    expect(result.truncated).toBe(false);
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.matches).toEqual([
      { path: ".config/settings.txt", line: 1, text: "findme" },
      { path: "src.txt", line: 1, text: "findme" }
    ]);
  });

  it("grep supports literal mode, case-insensitive mode, and single-file paths", async () => {
    const root = createHarnessRoot("acmd-grep-modes-");
    const harness = createHarness(root);

    fs.writeFileSync(path.join(root, "sample.txt"), "abc\na.c\nFindMe\n", "utf8");

    const literal = await harness.execute("grep", {
      pattern: "a.c",
      path: "sample.txt",
      literal: true
    }) as {
      matches: Array<{ path: string; line: number; text: string }>;
    };

    expect(literal.matches).toEqual([
      { path: "sample.txt", line: 2, text: "a.c" }
    ]);

    const caseInsensitive = await harness.execute("grep", {
      pattern: "findme",
      path: "sample.txt",
      caseSensitive: false
    }) as {
      matches: Array<{ path: string; line: number; text: string }>;
    };

    expect(caseInsensitive.matches).toEqual([
      { path: "sample.txt", line: 3, text: "FindMe" }
    ]);
  });

  it("grep clips very long matching lines", async () => {
    const root = createHarnessRoot("acmd-grep-long-lines-");
    const harness = createHarness(root);

    const longLine = `${"x".repeat(4_500)}needle`;
    fs.writeFileSync(path.join(root, "sample.txt"), `${longLine}\n`, "utf8");

    const result = await harness.execute("grep", {
      pattern: "needle",
      path: "sample.txt"
    }) as {
      matches: Array<{ path: string; line: number; text: string }>;
    };

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.text).toContain("[+");
    expect((result.matches[0]?.text ?? "").length).toBeLessThan(longLine.length);
  });

  it("grep truncates after the match limit and returns actionable metadata", async () => {
    const root = createHarnessRoot("acmd-grep-limit-");
    const harness = createHarness(root);

    for (let index = 0; index < 200; index += 1) {
      const dir = path.join(root, `d${String(index).padStart(3, "0")}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "file.txt"),
        Array.from({ length: 10 }, (_, line) => `match_line_${line}`).join("\n"),
        "utf8"
      );
    }

    const result = await harness.execute("grep", {
      pattern: "match_line",
      path: "."
    }) as {
      matches: Array<{ path: string; line: number; text: string }>;
      filesScanned: number;
      truncated: boolean;
      matchLimit: number;
      lastFileScanned: string | null;
      note: string;
    };

    expect(result.matches).toHaveLength(1_000);
    expect(result.truncated).toBe(true);
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.matchLimit).toBe(1_000);
    expect(result.lastFileScanned).toBeTruthy();
    expect(result.note).toContain("1000 matching lines");
  });

  it("grep trims matches to stay within maxOutputChars", async () => {
    const root = createHarnessRoot("acmd-grep-output-limit-");
    const harness = createHarness(root, { maxOutputChars: 8_000 });
    const repeatedLine = `${"x".repeat(200)}needle`;

    fs.writeFileSync(
      path.join(root, "sample.txt"),
      Array.from({ length: 100 }, () => repeatedLine).join("\n"),
      "utf8"
    );

    const result = await harness.execute("grep", {
      pattern: "needle",
      path: "sample.txt"
    }) as {
      matches: Array<{ path: string; line: number; text: string }>;
      truncated: boolean;
      outputLimit?: number;
      note?: string;
    };

    expect(result.matches.length).toBeLessThan(100);
    expect(result.truncated).toBe(true);
    expect(result.outputLimit).toBe(8_000);
    expect(result.note).toContain("Output limit reached");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(8_000);
  });

  it("grep surfaces invalid regex errors", async () => {
    const root = createHarnessRoot("acmd-grep-invalid-regex-");
    const harness = createHarness(root);

    fs.writeFileSync(path.join(root, "src.txt"), "findme\n", "utf8");

    await expect(
      harness.execute("grep", {
        pattern: "(",
        path: "."
      })
    ).rejects.toThrow("regex parse error");
  });

  it("glob and grep reject missing search paths before spawning ripgrep", async () => {
    const root = createHarnessRoot("acmd-search-missing-path-");
    const harness = createHarness(root);

    await expect(
      harness.execute("glob", {
        pattern: "*.txt",
        path: "missing"
      })
    ).rejects.toThrow("Search path does not exist");

    await expect(
      harness.execute("grep", {
        pattern: "findme",
        path: "missing"
      })
    ).rejects.toThrow("Search path does not exist");
  });
});

describe("search tools without ripgrep", () => {
  function createMinimalContext(
    root: string,
    overrides: Partial<ToolContext> & {
      execTimeoutMs?: number;
    } = {}
  ): ToolContext {
    return {
      config: {
        defaultCwd: root,
        defaultShell: "/bin/bash",
        execTimeoutMs: overrides.execTimeoutMs ?? 30_000,
        execYieldMs: 10_000,
        processLogTailLines: 200,
        logPath: path.join(root, ".agent-commander/tool-calls.jsonl"),
        completedSessionRetentionMs: 3_600_000,
        maxCompletedSessions: 500,
        maxOutputChars: 200_000
      },
      processManager: {} as ToolContext["processManager"],
      logger: {} as ToolContext["logger"],
      metrics: {
        toolSuccessCount: 0,
        toolFailureCount: 0,
        errorCodeCounts: {},
        workflowsStarted: 0,
        workflowsSucceeded: 0,
        workflowsFailed: 0,
        workflowsTimedOut: 0,
        workflowsInterrupted: 0,
        workflowsCleanupErrors: 0,
        workflowLoopBreakerTrips: 0
      },
      ownerId: null,
      ...overrides
    };
  }

  function spawnNodeScript(script: string) {
    return spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  it("maps rg spawn failures to a clear error message", async () => {
    const root = createHarnessRoot("acmd-search-no-rg-");
    fs.writeFileSync(path.join(root, "src.txt"), "hello\n", "utf8");

    const tool = createGrepTool({
      spawnRipgrep() {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
    });

    await expect(
      tool.run(createMinimalContext(root), {
        pattern: "hello",
        path: "."
      })
    ).rejects.toThrow("ripgrep (rg) is required but not found in PATH");

    const glob = createGlobTool({
      spawnRipgrep() {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
    });

    await expect(
      glob.run(createMinimalContext(root), {
        pattern: "*.txt",
        path: "."
      })
    ).rejects.toThrow("ripgrep (rg) is required but not found in PATH");
  });

  it("returns partial results when ripgrep exits with code 2 after emitting matches", async () => {
    const root = createHarnessRoot("acmd-search-partial-");
    fs.writeFileSync(path.join(root, "src.txt"), "findme\n", "utf8");

    const script = [
      "console.log(JSON.stringify({ type: 'begin', data: { path: { text: './src.txt' } } }));",
      "console.log(JSON.stringify({ type: 'match', data: { path: { text: './src.txt' }, line_number: 1, lines: { text: 'findme\\n' } } }));",
      "console.log(JSON.stringify({ type: 'summary', data: { stats: { searches: 1 } } }));",
      "process.exit(2);"
    ].join("");

    const tool = createGrepTool({
      spawnRipgrep() {
        return spawnNodeScript(script);
      }
    });

    const result = await tool.run(createMinimalContext(root), {
      pattern: "findme",
      path: "."
    }) as {
      partial?: boolean;
      warning?: string;
      filesScanned: number;
      matches: Array<{ path: string; line: number; text: string }>;
    };

    expect(result.partial).toBe(true);
    expect(result.warning).toContain("results may be incomplete");
    expect(result.filesScanned).toBe(1);
    expect(result.matches).toEqual([
      { path: "src.txt", line: 1, text: "findme" }
    ]);
  });

  it("uses approximate file counts in the truncation note when ripgrep is stopped before summary", async () => {
    const root = createHarnessRoot("acmd-search-truncated-no-summary-");
    fs.writeFileSync(path.join(root, "src.txt"), "findme\n", "utf8");

    const script = [
      "console.log(JSON.stringify({ type: 'begin', data: { path: { text: './src.txt' } } }));",
      "for (let index = 1; index <= 1001; index += 1) {",
      "  console.log(JSON.stringify({ type: 'match', data: { path: { text: './src.txt' }, line_number: index, lines: { text: 'findme\\n' } } }));",
      "}",
      "setTimeout(() => process.exit(0), 5000);"
    ].join("");

    const tool = createGrepTool({
      spawnRipgrep() {
        return spawnNodeScript(script);
      }
    });

    const result = await tool.run(createMinimalContext(root), {
      pattern: "findme",
      path: "."
    }) as {
      filesScanned: number;
      truncated: boolean;
      matchLimit?: number;
      note?: string;
    };

    expect(result.filesScanned).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.matchLimit).toBe(1_000);
    expect(result.note).toContain("after touching 1 file");
  });

  it("rejects immediately when the abort signal is already aborted", async () => {
    const root = createHarnessRoot("acmd-search-aborted-");
    fs.writeFileSync(path.join(root, "src.txt"), "findme\n", "utf8");

    const controller = new AbortController();
    controller.abort();

    let spawnCalls = 0;
    const tool = createGrepTool({
      spawnRipgrep() {
        spawnCalls += 1;
        return spawnNodeScript("process.exit(0);");
      }
    });

    await expect(
      tool.run(createMinimalContext(root, { abortSignal: controller.signal }), {
        pattern: "findme",
        path: "."
      })
    ).rejects.toThrow("Ripgrep command was interrupted");

    expect(spawnCalls).toBe(0);
  });

  it("times out long-running ripgrep commands", async () => {
    const root = createHarnessRoot("acmd-search-timeout-");
    fs.writeFileSync(path.join(root, "src.txt"), "findme\n", "utf8");

    const tool = createGrepTool({
      spawnRipgrep() {
        return spawnNodeScript("setTimeout(() => process.exit(0), 250);");
      }
    });

    await expect(
      tool.run(createMinimalContext(root, { execTimeoutMs: 25 }), {
        pattern: "findme",
        path: "."
      })
    ).rejects.toThrow("Ripgrep command timed out after 25ms");
  });
});
