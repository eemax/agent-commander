import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function collectSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (entry.isFile() && fullPath.endsWith(".ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

describe("sqlite cleanup removal", () => {
  it("does not include legacy sqlite startup cleanup wiring", () => {
    const entrypoint = fs.readFileSync(path.resolve("src/index.ts"), "utf8");
    expect(entrypoint).not.toContain("cleanupLegacySqlite");
    expect(entrypoint).not.toContain("legacy-cleanup");
  });

  it("does not hardcode sqlite state file paths in runtime source", () => {
    const files = collectSourceFiles(path.resolve("src"));

    for (const file of files) {
      const content = fs.readFileSync(file, "utf8").toLowerCase();
      expect(content).not.toContain("agent-commander.sqlite");
    }
  });
});
