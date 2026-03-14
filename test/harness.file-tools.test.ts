import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createToolHarness } from "../src/harness/index.js";

function createHarnessRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createHarness(root: string) {
  return createToolHarness({
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
}

describe("file tools", () => {
  it("writes new files, overwrites files, and reads full/partial content", async () => {
    const root = createHarnessRoot("acmd-file-tools-");
    const harness = createHarness(root);

    await expect(
      harness.execute("write_file", {
        path: "nested/sample.txt",
        content: "line1\nline2\nline3\nline4"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        path: path.join(root, "nested/sample.txt")
      })
    );

    await expect(
      harness.execute("read_file", {
        path: "nested/sample.txt"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        path: path.join(root, "nested/sample.txt"),
        content: "line1\nline2\nline3\nline4",
        startLine: 1,
        endLine: 4,
        totalLines: 4,
        truncated: false
      })
    );

    await expect(
      harness.execute("read_file", {
        path: "nested/sample.txt",
        offsetLine: 2,
        limitLines: 2
      })
    ).resolves.toEqual(
      expect.objectContaining({
        content: "line2\nline3",
        startLine: 2,
        endLine: 3,
        totalLines: 4,
        truncated: true
      })
    );

    await expect(
      harness.execute("write_file", {
        path: "nested/sample.txt",
        content: "rewritten"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        size: 9
      })
    );

    expect(fs.readFileSync(path.join(root, "nested/sample.txt"), "utf8")).toBe("rewritten");
  });

  it("replaces exact text and rejects ambiguous or missing matches", async () => {
    const root = createHarnessRoot("acmd-replace-tools-");
    const harness = createHarness(root);

    fs.writeFileSync(path.join(root, "replace.txt"), "alpha beta alpha", "utf8");

    await expect(
      harness.execute("replace_in_file", {
        path: "replace.txt",
        oldText: "beta",
        newText: "BETA"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        replacements: 1
      })
    );

    await expect(
      harness.execute("replace_in_file", {
        path: "replace.txt",
        oldText: "alpha",
        newText: "ALPHA"
      })
    ).rejects.toThrow("oldText matched 2 times");

    await expect(
      harness.execute("replace_in_file", {
        path: "replace.txt",
        oldText: "alpha",
        newText: "ALPHA",
        replaceAll: true
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        replacements: 2
      })
    );

    await expect(
      harness.execute("replace_in_file", {
        path: "replace.txt",
        oldText: "missing",
        newText: "noop"
      })
    ).rejects.toThrow("oldText not found");
  });

  it("reports file/encoding errors", async () => {
    const root = createHarnessRoot("acmd-file-errors-");
    const harness = createHarness(root);

    await expect(
      harness.execute("read_file", {
        path: "does-not-exist.txt"
      })
    ).rejects.toThrow("File not found");

    await expect(
      harness.execute("write_file", {
        path: "x.txt",
        content: "hello",
        encoding: "utf16le"
      })
    ).rejects.toThrow("Invalid encoding");
  });
});
