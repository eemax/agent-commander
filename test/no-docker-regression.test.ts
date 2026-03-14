import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function collectFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

describe("runtime source", () => {
  it("does not reference container runtime checks", () => {
    const files = collectFiles(path.resolve("src"));
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8").toLowerCase();
      expect(content).not.toContain("docker");
      expect(content).not.toContain("container runtime");
    }
  });

  it("does not ship docker-specific files in project root", () => {
    expect(fs.existsSync(path.resolve("Dockerfile"))).toBe(false);
    expect(fs.existsSync(path.resolve("docker-compose.yml"))).toBe(false);
    expect(fs.existsSync(path.resolve("docker-setup.sh"))).toBe(false);
  });

  it("does not include docker scripts in package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    const scripts = Object.values(pkg.scripts ?? {});
    for (const script of scripts) {
      expect(script.toLowerCase()).not.toContain("docker");
    }
  });
});
