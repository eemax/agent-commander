import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createToolHarness } from "../src/harness/index.js";

function mkdtemp(prefix: string): string {
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

describe("apply_patch tool", () => {
  it("uses git apply inside git repositories", async () => {
    const root = mkdtemp("acmd-patch-git-");
    const harness = createHarness(root);

    fs.writeFileSync(path.join(root, "note.txt"), "one\n", "utf8");
    await harness.executeWithOwner("chat-1", "bash", { command: "git init", cwd: root });

    const patch = [
      "diff --git a/note.txt b/note.txt",
      "--- a/note.txt",
      "+++ b/note.txt",
      "@@ -1 +1 @@",
      "-one",
      "+two",
      ""
    ].join("\n");

    await expect(
      harness.execute("apply_patch", {
        patch,
        cwd: root
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        engine: "git-apply"
      })
    );

    expect(fs.readFileSync(path.join(root, "note.txt"), "utf8")).toBe("two\n");
  });

  it("falls back to patch utility outside git repositories", async () => {
    const root = mkdtemp("acmd-patch-fallback-");
    const harness = createHarness(root);

    fs.writeFileSync(path.join(root, "plain.txt"), "old\n", "utf8");

    const patch = [
      "--- plain.txt",
      "+++ plain.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      ""
    ].join("\n");

    await expect(
      harness.execute("apply_patch", {
        patch,
        cwd: root
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        engine: "patch"
      })
    );

    expect(fs.readFileSync(path.join(root, "plain.txt"), "utf8")).toBe("new\n");
  });

  it("surfaces patch failures", async () => {
    const root = mkdtemp("acmd-patch-fail-");
    const harness = createHarness(root);

    fs.writeFileSync(path.join(root, "target.txt"), "keep\n", "utf8");

    const invalidPatch = [
      "--- target.txt",
      "+++ target.txt",
      "@@ -1 +1 @@",
      "-different",
      "+new"
    ].join("\n");

    await expect(
      harness.execute("apply_patch", {
        patch: invalidPatch,
        cwd: root
      })
    ).rejects.toThrow(/patch failed|git apply failed/);
  });

  it("applies Codex-style patch envelopes", async () => {
    const root = mkdtemp("acmd-patch-codex-");
    const harness = createHarness(root);

    fs.writeFileSync(path.join(root, "app.py"), "def main():\n    print(\"one\")\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: app.py",
      "@@",
      " def main():",
      "-    print(\"one\")",
      "+    print(\"two\")",
      "*** End Patch",
      ""
    ].join("\n");

    await expect(
      harness.execute("apply_patch", {
        patch,
        cwd: root
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        engine: "codex",
        operations: 1
      })
    );

    expect(fs.readFileSync(path.join(root, "app.py"), "utf8")).toBe("def main():\n    print(\"two\")\n");
  });
});
