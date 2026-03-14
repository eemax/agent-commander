import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config, WorkspaceCatalog, WorkspaceCatalogHealth } from "./runtime/contracts.js";
import type { SkillDefinition, WorkspaceSnapshot } from "./types.js";
import { assertValidCommandSlug, buildCommandCatalog, toSkillCommandSlug } from "./telegram/commands.js";

const DEFAULT_AGENTS_CONTENT = `# AGENTS.md\n\nThis file is injected into the model context at the start of every new conversation.\nUpdate it to define runtime policies, goals, and workflow constraints for your agent.\n`;

const DEFAULT_SOUL_CONTENT = `## Identity
You are Ysera, an agent running inside Agent Commander.
You are not a generic assistant. You operate as a capable local agent with tools, files, and skills.

## Core Rules
- Be genuinely helpful, not performatively helpful.
- Be resourceful before asking questions.
- Check files, context, and tools before asking for missing information.
- Do not be sycophantic or overly flattering.
- Be concise when possible, thorough when needed.

## Voice
Authentic, grounded, and direct.
`;

const DEFAULT_TEST_SKILL = `---\nname: Test Skill\ndescription: A sample skill to verify skill loading and command registration.\n---\n\n# Test Skill\n\nUse this skill to validate the workspace bootstrap and one-shot skill invocation flow.\n`;

type ParsedFrontmatter = {
  name: string;
  description: string;
};

type WorkspaceManifest = {
  hash: string;
  agentsPath: string;
  soulPath: string;
  skillsDir: string;
  skillPaths: string[];
};

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function parseFrontmatter(content: string, filePath: string): ParsedFrontmatter {
  if (!content.startsWith("---\n")) {
    throw new Error(`Missing YAML frontmatter in ${filePath}`);
  }

  const closingIndex = content.indexOf("\n---", 4);
  if (closingIndex === -1) {
    throw new Error(`Unterminated YAML frontmatter in ${filePath}`);
  }

  const block = content.slice(4, closingIndex).trim();
  if (block.length === 0) {
    throw new Error(`Empty YAML frontmatter in ${filePath}`);
  }

  const values = new Map<string, string>();
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key.length > 0 && value.length > 0) {
      values.set(key, value);
    }
  }

  const name = values.get("name")?.trim() ?? "";
  const description = values.get("description")?.trim() ?? "";

  if (name.length === 0 || description.length === 0) {
    throw new Error(`Frontmatter in ${filePath} must include non-empty 'name' and 'description'`);
  }

  return {
    name,
    description
  };
}

async function ensureFile(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
    return;
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }
}

async function hasAnySkillFiles(skillsDir: string): Promise<boolean> {
  let folders: string[] = [];
  try {
    const listed = await fs.readdir(skillsDir, { withFileTypes: true });
    folders = listed.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return false;
  }

  for (const folder of folders) {
    const skillPath = path.join(skillsDir, folder, "SKILL.md");
    const signature = await fileStatsSignature(skillPath);
    if (signature) {
      return true;
    }
  }

  return false;
}

async function fileStatsSignature(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return `${filePath}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

async function buildManifest(workspaceRoot: string): Promise<WorkspaceManifest> {
  const agentsPath = path.join(workspaceRoot, "AGENTS.md");
  const soulPath = path.join(workspaceRoot, "SOUL.md");
  const skillsDir = path.join(workspaceRoot, "skills");

  const entries: string[] = [];
  const agentsSignature = await fileStatsSignature(agentsPath);
  if (agentsSignature) {
    entries.push(agentsSignature);
  }
  const soulSignature = await fileStatsSignature(soulPath);
  if (soulSignature) {
    entries.push(soulSignature);
  }

  let skillFolders: string[] = [];
  try {
    const listed = await fs.readdir(skillsDir, { withFileTypes: true });
    skillFolders = listed.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    // Ignore missing skills dir during early bootstrap.
  }

  const skillPaths: string[] = [];
  for (const folder of skillFolders) {
    const skillPath = path.join(skillsDir, folder, "SKILL.md");
    const signature = await fileStatsSignature(skillPath);
    if (!signature) {
      continue;
    }
    entries.push(signature);
    skillPaths.push(skillPath);
  }

  return {
    hash: sha256(entries.join("\n")),
    agentsPath,
    soulPath,
    skillsDir,
    skillPaths
  };
}

async function loadSkillsFromManifest(manifest: WorkspaceManifest): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];

  for (const skillPath of manifest.skillPaths) {
    const content = await fs.readFile(skillPath, "utf8");
    const frontmatter = parseFrontmatter(content, skillPath);
    const folderName = path.basename(path.dirname(skillPath));
    const slug = toSkillCommandSlug(folderName);
    assertValidCommandSlug(slug, skillPath);

    skills.push({
      slug,
      name: frontmatter.name,
      description: frontmatter.description,
      path: skillPath,
      content
    });
  }

  skills.sort((left, right) => left.slug.localeCompare(right.slug));

  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.slug)) {
      throw new Error(`Duplicate skill command slug: ${skill.slug}`);
    }
    seen.add(skill.slug);
  }

  return skills;
}

async function buildSnapshot(config: Config, manifest: WorkspaceManifest): Promise<WorkspaceSnapshot> {
  const agentsContent = await fs.readFile(manifest.agentsPath, "utf8");
  const soulContent = await fs.readFile(manifest.soulPath, "utf8");
  const skills = await loadSkillsFromManifest(manifest);
  const commands = buildCommandCatalog(skills);

  const signature = sha256(
    JSON.stringify({
      agentsContent,
      soulContent,
      skills: skills.map((item) => ({
        slug: item.slug,
        name: item.name,
        description: item.description,
        path: item.path,
        hash: sha256(item.content)
      })),
      commands
    })
  );

  return {
    workspaceRoot: config.paths.workspaceRoot,
    agentsPath: manifest.agentsPath,
    agentsContent,
    agentsSha256: sha256(agentsContent),
    soulPath: manifest.soulPath,
    soulContent,
    soulSha256: sha256(soulContent),
    skillsDir: manifest.skillsDir,
    skills,
    commands,
    signature
  };
}

export type WorkspaceManager = WorkspaceCatalog;

export function createWorkspaceManager(config: Config): WorkspaceManager {
  let snapshot: WorkspaceSnapshot | null = null;
  let manifestHash: string | null = null;
  const health: WorkspaceCatalogHealth = {
    refreshCalls: 0,
    refreshNoChange: 0,
    lastManifestHash: null,
    lastSnapshotSignature: null
  };

  return {
    async bootstrap(): Promise<void> {
      const agentsPath = path.join(config.paths.workspaceRoot, "AGENTS.md");
      const soulPath = path.join(config.paths.workspaceRoot, "SOUL.md");
      const skillsDir = path.join(config.paths.workspaceRoot, "skills");
      const testSkillPath = path.join(skillsDir, "test-skill", "SKILL.md");

      await fs.mkdir(config.paths.workspaceRoot, { recursive: true });
      await fs.mkdir(skillsDir, { recursive: true });

      await ensureFile(agentsPath, DEFAULT_AGENTS_CONTENT);
      await ensureFile(soulPath, DEFAULT_SOUL_CONTENT);
      if (!(await hasAnySkillFiles(skillsDir))) {
        await ensureFile(testSkillPath, DEFAULT_TEST_SKILL);
      }

      const manifest = await buildManifest(config.paths.workspaceRoot);
      const loaded = await buildSnapshot(config, manifest);
      snapshot = loaded;
      manifestHash = manifest.hash;
      health.lastManifestHash = manifest.hash;
      health.lastSnapshotSignature = loaded.signature;
    },

    async refresh(): Promise<{ snapshot: WorkspaceSnapshot; changed: boolean }> {
      if (snapshot === null || manifestHash === null) {
        throw new Error("Workspace manager not bootstrapped");
      }

      health.refreshCalls += 1;

      const manifest = await buildManifest(config.paths.workspaceRoot);
      if (manifest.hash === manifestHash) {
        health.refreshNoChange += 1;
        return {
          snapshot,
          changed: false
        };
      }

      const next = await buildSnapshot(config, manifest);
      manifestHash = manifest.hash;
      health.lastManifestHash = manifest.hash;
      health.lastSnapshotSignature = next.signature;

      const changed = next.signature !== snapshot.signature;
      if (changed) {
        snapshot = next;
      }

      return {
        snapshot,
        changed
      };
    },

    getSnapshot(): WorkspaceSnapshot {
      if (snapshot === null) {
        throw new Error("Workspace manager not bootstrapped");
      }

      return snapshot;
    },

    getSkillBySlug(slug: string): SkillDefinition | null {
      if (snapshot === null) {
        throw new Error("Workspace manager not bootstrapped");
      }

      return snapshot.skills.find((item) => item.slug === slug) ?? null;
    },

    getHealth(): WorkspaceCatalogHealth {
      return {
        ...health
      };
    }
  };
}
