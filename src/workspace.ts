import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config, RuntimeLogger, WorkspaceCatalog, WorkspaceCatalogHealth } from "./runtime/contracts.js";
import type { SkillDefinition, WorkspaceSnapshot } from "./types.js";
import { assertValidCommandSlug, buildCommandCatalog, toSkillCommandSlug } from "./telegram/commands.js";

type ParsedFrontmatter = {
  name: string;
  description: string;
};

type WorkspaceManifest = {
  hash: string;
  systemPath: string;
  agentsPath: string;
  soulPath: string;
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

async function resolveFilePath(primary: string, ...fallbacks: string[]): Promise<string | null> {
  if (await fileStatsSignature(primary)) {
    return primary;
  }
  for (const fallback of fallbacks) {
    if (await fileStatsSignature(fallback)) {
      return fallback;
    }
  }
  return null;
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function scanSkillPaths(skillsDir: string): Promise<string[]> {
  let folders: string[] = [];
  try {
    const listed = await fs.readdir(skillsDir, { withFileTypes: true });
    folders = listed.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }

  const paths: string[] = [];
  for (const folder of folders) {
    const skillPath = path.join(skillsDir, folder, "SKILL.md");
    const signature = await fileStatsSignature(skillPath);
    if (signature) {
      paths.push(skillPath);
    }
  }
  return paths;
}

function mergeSkillPaths(primaryPaths: string[], fallbackPaths: string[]): string[] {
  const primarySlugs = new Set(primaryPaths.map((p) => path.basename(path.dirname(p))));
  const merged = [...primaryPaths];
  for (const fallbackPath of fallbackPaths) {
    const folder = path.basename(path.dirname(fallbackPath));
    if (!primarySlugs.has(folder)) {
      merged.push(fallbackPath);
    }
  }
  return merged;
}

async function buildManifest(
  workspaceRoot: string,
  configDir: string,
  systemPath: string,
  rootConfigDir?: string
): Promise<WorkspaceManifest> {
  const extraFallbacks = rootConfigDir && rootConfigDir !== configDir ? [rootConfigDir] : [];

  const agentsPath = await resolveFilePath(
    path.join(workspaceRoot, "AGENTS.md"),
    path.join(configDir, "AGENTS.md"),
    ...extraFallbacks.map((d) => path.join(d, "AGENTS.md"))
  );
  const soulPath = await resolveFilePath(
    path.join(workspaceRoot, "SOUL.md"),
    path.join(configDir, "SOUL.md"),
    ...extraFallbacks.map((d) => path.join(d, "SOUL.md"))
  );

  const entries: string[] = [];
  const systemSignature = await fileStatsSignature(systemPath);
  if (systemSignature) {
    entries.push(systemSignature);
  }
  if (agentsPath) {
    const sig = await fileStatsSignature(agentsPath);
    if (sig) entries.push(sig);
  }
  if (soulPath) {
    const sig = await fileStatsSignature(soulPath);
    if (sig) entries.push(sig);
  }

  const workspaceSkillPaths = await scanSkillPaths(path.join(workspaceRoot, "skills"));
  const configSkillPaths = await scanSkillPaths(path.join(configDir, "skills"));
  let skillPaths = mergeSkillPaths(workspaceSkillPaths, configSkillPaths);
  for (const dir of extraFallbacks) {
    const fallbackSkillPaths = await scanSkillPaths(path.join(dir, "skills"));
    skillPaths = mergeSkillPaths(skillPaths, fallbackSkillPaths);
  }

  for (const skillPath of skillPaths) {
    const signature = await fileStatsSignature(skillPath);
    if (signature) {
      entries.push(signature);
    }
  }

  return {
    hash: sha256(entries.join("\n")),
    systemPath,
    agentsPath: agentsPath ?? "",
    soulPath: soulPath ?? "",
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
  const systemContent = await readFileOrEmpty(manifest.systemPath);
  const agentsContent = manifest.agentsPath ? await readFileOrEmpty(manifest.agentsPath) : "";
  const soulContent = manifest.soulPath ? await readFileOrEmpty(manifest.soulPath) : "";
  const skills = await loadSkillsFromManifest(manifest);
  const commands = buildCommandCatalog(skills);

  const signature = sha256(
    JSON.stringify({
      systemContent,
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
    systemPath: manifest.systemPath,
    systemContent,
    systemSha256: sha256(systemContent),
    agentsPath: manifest.agentsPath,
    agentsContent,
    agentsSha256: sha256(agentsContent),
    soulPath: manifest.soulPath,
    soulContent,
    soulSha256: sha256(soulContent),
    skillsDir: path.join(config.paths.workspaceRoot, "skills"),
    skills,
    commands,
    signature
  };
}

export type WorkspaceManager = WorkspaceCatalog;

export function createWorkspaceManager(config: Config, logger?: RuntimeLogger): WorkspaceManager {
  const configDir = path.dirname(config.configPath);
  const rootConfigDir = path.join(config.repoRoot, "config");
  const systemPath = path.join(configDir, "SYSTEM.md");
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
      await fs.mkdir(config.paths.workspaceRoot, { recursive: true });
      await fs.mkdir(path.join(config.paths.workspaceRoot, "skills"), { recursive: true });

      const manifest = await buildManifest(config.paths.workspaceRoot, configDir, systemPath, rootConfigDir);

      if (!manifest.agentsPath) {
        logger?.warn("bootstrap: AGENTS.md not found in workspace or config directory");
      }
      if (!manifest.soulPath) {
        logger?.warn("bootstrap: SOUL.md not found in workspace or config directory");
      }
      if (manifest.skillPaths.length === 0) {
        logger?.warn("bootstrap: no skills found in workspace or config directory");
      }

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

      const manifest = await buildManifest(config.paths.workspaceRoot, configDir, systemPath, rootConfigDir);
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
