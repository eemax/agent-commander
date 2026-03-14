import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceManager } from "../src/workspace.js";
import { makeConfig } from "./helpers.js";

describe("workspace manager", () => {
  it("bootstraps AGENTS.md, SOUL.md, and a test skill when no skills exist", async () => {
    const config = makeConfig();
    const manager = createWorkspaceManager(config);

    await manager.bootstrap();
    const snapshot = manager.getSnapshot();

    expect(fs.existsSync(path.join(config.paths.workspaceRoot, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(config.paths.workspaceRoot, "SOUL.md"))).toBe(true);
    expect(fs.existsSync(path.join(config.paths.workspaceRoot, "skills", "test-skill", "SKILL.md"))).toBe(true);
    expect(snapshot.soulPath).toBe(path.join(config.paths.workspaceRoot, "SOUL.md"));
    expect(snapshot.soulContent).toContain("## Identity");
    expect(snapshot.soulSha256).toEqual(expect.any(String));
    expect(snapshot.skills.map((item) => item.slug)).toContain("test_skill");
    expect(snapshot.commands.map((item) => item.command)).toContain("test_skill");
  });

  it("does not recreate test skill when other skills already exist", async () => {
    const config = makeConfig();
    const skillPath = path.join(config.paths.workspaceRoot, "skills", "research", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(
      skillPath,
      "---\nname: Research\ndescription: Research helper\n---\n\n# Research\n",
      "utf8"
    );

    const manager = createWorkspaceManager(config);
    await manager.bootstrap();
    const snapshot = manager.getSnapshot();

    expect(fs.existsSync(path.join(config.paths.workspaceRoot, "skills", "test-skill", "SKILL.md"))).toBe(false);
    expect(snapshot.skills.map((item) => item.slug)).toEqual(["research"]);
    expect(snapshot.commands.map((item) => item.command)).toContain("research");
  });

  it("fails startup when a skill frontmatter is invalid", async () => {
    const config = makeConfig();
    const badSkillPath = path.join(config.paths.workspaceRoot, "skills", "broken", "SKILL.md");
    fs.mkdirSync(path.dirname(badSkillPath), { recursive: true });
    fs.writeFileSync(badSkillPath, "# no frontmatter\n", "utf8");

    const manager = createWorkspaceManager(config);
    await expect(manager.bootstrap()).rejects.toThrow("Missing YAML frontmatter");
  });

  it("refresh updates command catalog when skills change", async () => {
    const config = makeConfig();
    const manager = createWorkspaceManager(config);
    await manager.bootstrap();

    const skillPath = path.join(config.paths.workspaceRoot, "skills", "research", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(
      skillPath,
      "---\nname: Research\ndescription: Research helper\n---\n\n# Research\n",
      "utf8"
    );

    const refreshed = await manager.refresh();
    expect(refreshed.changed).toBe(true);
    expect(refreshed.snapshot.commands.map((item) => item.command)).toContain("research");
  });

  it("refresh detects SOUL.md changes", async () => {
    const config = makeConfig();
    const manager = createWorkspaceManager(config);
    await manager.bootstrap();

    const soulPath = path.join(config.paths.workspaceRoot, "SOUL.md");
    fs.writeFileSync(soulPath, "## Identity\nChanged contract.\n", "utf8");

    const refreshed = await manager.refresh();
    expect(refreshed.changed).toBe(true);
    expect(refreshed.snapshot.soulContent).toContain("Changed contract.");
  });

  it("skips full rebuild when manifest has not changed", async () => {
    const config = makeConfig();
    const manager = createWorkspaceManager(config);
    await manager.bootstrap();

    const refreshed = await manager.refresh();
    expect(refreshed.changed).toBe(false);

    const health = manager.getHealth();
    expect(health.refreshCalls).toBeGreaterThanOrEqual(1);
    expect(health.refreshNoChange).toBeGreaterThanOrEqual(1);
    expect(health.lastManifestHash).toEqual(expect.any(String));
  });
});
