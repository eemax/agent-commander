import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceManager } from "../src/workspace.js";
import { makeConfig } from "./helpers.js";

function writeSkill(dir: string, folder: string, name: string, description: string): void {
  const skillPath = path.join(dir, "skills", folder, "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(
    skillPath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8"
  );
}

describe("workspace manager", () => {
  describe("AGENTS.md resolution", () => {
    it("resolves from workspaceRoot when present", async () => {
      const config = makeConfig();
      const agentsPath = path.join(config.paths.workspaceRoot, "AGENTS.md");
      fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
      fs.writeFileSync(agentsPath, "# AGENTS workspace\n", "utf8");

      const manager = createWorkspaceManager(config);
      await manager.bootstrap();
      const snapshot = manager.getSnapshot();

      expect(snapshot.agentsPath).toBe(agentsPath);
      expect(snapshot.agentsContent).toContain("AGENTS workspace");
    });

    it("falls back to configDir when not in workspaceRoot", async () => {
      const config = makeConfig();
      const configDir = path.dirname(config.configPath);
      const fallbackPath = path.join(configDir, "AGENTS.md");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(fallbackPath, "# AGENTS config\n", "utf8");

      const manager = createWorkspaceManager(config);
      await manager.bootstrap();
      const snapshot = manager.getSnapshot();

      expect(snapshot.agentsPath).toBe(fallbackPath);
      expect(snapshot.agentsContent).toContain("AGENTS config");
    });

    it("workspaceRoot takes precedence over configDir", async () => {
      const config = makeConfig();
      const configDir = path.dirname(config.configPath);
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "AGENTS.md"), "# AGENTS config\n", "utf8");

      const workspacePath = path.join(config.paths.workspaceRoot, "AGENTS.md");
      fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
      fs.writeFileSync(workspacePath, "# AGENTS workspace\n", "utf8");

      const manager = createWorkspaceManager(config);
      await manager.bootstrap();
      const snapshot = manager.getSnapshot();

      expect(snapshot.agentsPath).toBe(workspacePath);
      expect(snapshot.agentsContent).toContain("AGENTS workspace");
    });

    it("returns empty content when not found in either location", async () => {
      const config = makeConfig();
      const manager = createWorkspaceManager(config);
      await manager.bootstrap();
      const snapshot = manager.getSnapshot();

      expect(snapshot.agentsPath).toBe("");
      expect(snapshot.agentsContent).toBe("");
    });
  });

  describe("SOUL.md resolution", () => {
    it("resolves from workspaceRoot when present", async () => {
      const config = makeConfig();
      const soulPath = path.join(config.paths.workspaceRoot, "SOUL.md");
      fs.mkdirSync(path.dirname(soulPath), { recursive: true });
      fs.writeFileSync(soulPath, "## Identity\nWorkspace soul.\n", "utf8");

      const manager = createWorkspaceManager(config);
      await manager.bootstrap();
      const snapshot = manager.getSnapshot();

      expect(snapshot.soulPath).toBe(soulPath);
      expect(snapshot.soulContent).toContain("Workspace soul");
    });

    it("falls back to configDir when not in workspaceRoot", async () => {
      const config = makeConfig();
      const configDir = path.dirname(config.configPath);
      const fallbackPath = path.join(configDir, "SOUL.md");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(fallbackPath, "## Identity\nConfig soul.\n", "utf8");

      const manager = createWorkspaceManager(config);
      await manager.bootstrap();
      const snapshot = manager.getSnapshot();

      expect(snapshot.soulPath).toBe(fallbackPath);
      expect(snapshot.soulContent).toContain("Config soul");
    });

    it("returns empty content when not found in either location", async () => {
      const config = makeConfig();
      const manager = createWorkspaceManager(config);
      await manager.bootstrap();
      const snapshot = manager.getSnapshot();

      expect(snapshot.soulPath).toBe("");
      expect(snapshot.soulContent).toBe("");
    });
  });

  describe("skill resolution", () => {
    it("loads skills from workspaceRoot", async () => {
      const config = makeConfig();
      writeSkill(config.paths.workspaceRoot, "research", "Research", "Research helper");

      const manager = createWorkspaceManager(config);
      await manager.bootstrap();
      const snapshot = manager.getSnapshot();

      expect(snapshot.skills.map((s) => s.slug)).toEqual(["research"]);
      expect(snapshot.commands.map((c) => c.command)).toContain("research");
    });

    it("loads skills from configDir", async () => {
      const config = makeConfig();
      const configDir = path.dirname(config.configPath);
      writeSkill(configDir, "analyze", "Analyze", "Analysis helper");

      const manager = createWorkspaceManager(config);
      await manager.bootstrap();
      const snapshot = manager.getSnapshot();

      expect(snapshot.skills.map((s) => s.slug)).toEqual(["analyze"]);
    });

    it("merges skills from both directories, workspaceRoot wins on collision", async () => {
      const config = makeConfig();
      const configDir = path.dirname(config.configPath);

      writeSkill(config.paths.workspaceRoot, "shared", "Shared Workspace", "From workspace");
      writeSkill(config.paths.workspaceRoot, "ws-only", "WS Only", "Workspace only skill");
      writeSkill(configDir, "shared", "Shared Config", "From config");
      writeSkill(configDir, "cfg-only", "Config Only", "Config only skill");

      const manager = createWorkspaceManager(config);
      await manager.bootstrap();
      const snapshot = manager.getSnapshot();

      const slugs = snapshot.skills.map((s) => s.slug).sort();
      expect(slugs).toEqual(["cfg_only", "shared", "ws_only"]);

      const shared = snapshot.skills.find((s) => s.slug === "shared");
      expect(shared?.name).toBe("Shared Workspace");
      expect(shared?.description).toBe("From workspace");
    });

    it("returns empty skills when none found in either directory", async () => {
      const config = makeConfig();
      const manager = createWorkspaceManager(config);
      await manager.bootstrap();
      const snapshot = manager.getSnapshot();

      expect(snapshot.skills).toEqual([]);
      expect(snapshot.commands.filter((c) => c.kind === "skill")).toEqual([]);
    });

    it("fails startup when a skill frontmatter is invalid", async () => {
      const config = makeConfig();
      const badSkillPath = path.join(config.paths.workspaceRoot, "skills", "broken", "SKILL.md");
      fs.mkdirSync(path.dirname(badSkillPath), { recursive: true });
      fs.writeFileSync(badSkillPath, "# no frontmatter\n", "utf8");

      const manager = createWorkspaceManager(config);
      await expect(manager.bootstrap()).rejects.toThrow("Missing YAML frontmatter");
    });
  });

  describe("refresh", () => {
    it("detects SOUL.md changes", async () => {
      const config = makeConfig();
      const soulPath = path.join(config.paths.workspaceRoot, "SOUL.md");
      fs.mkdirSync(path.dirname(soulPath), { recursive: true });
      fs.writeFileSync(soulPath, "## Identity\nOriginal.\n", "utf8");

      const manager = createWorkspaceManager(config);
      await manager.bootstrap();

      fs.writeFileSync(soulPath, "## Identity\nChanged contract.\n", "utf8");

      const refreshed = await manager.refresh();
      expect(refreshed.changed).toBe(true);
      expect(refreshed.snapshot.soulContent).toContain("Changed contract.");
    });

    it("detects new skills added", async () => {
      const config = makeConfig();
      const manager = createWorkspaceManager(config);
      await manager.bootstrap();

      writeSkill(config.paths.workspaceRoot, "research", "Research", "Research helper");

      const refreshed = await manager.refresh();
      expect(refreshed.changed).toBe(true);
      expect(refreshed.snapshot.commands.map((c) => c.command)).toContain("research");
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

  describe("logging", () => {
    it("warns when files are missing from both locations", async () => {
      const config = makeConfig();
      const warnings: string[] = [];
      const logger = {
        debug: () => {},
        info: () => {},
        warn: (msg: string) => { warnings.push(msg); },
        error: () => {}
      };

      const manager = createWorkspaceManager(config, logger);
      await manager.bootstrap();

      expect(warnings).toContain("bootstrap: AGENTS.md not found in workspace or config directory");
      expect(warnings).toContain("bootstrap: SOUL.md not found in workspace or config directory");
      expect(warnings).toContain("bootstrap: no skills found in workspace or config directory");
    });
  });
});
