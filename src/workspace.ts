import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { REPO_ROOT, type Config } from "./config.js";

// Where a skill comes from: the agent's workspace, or the box (its provisioning, read-only).
export type SkillScope = "workspace" | "box";
export type Skill = { name: string; description: string; path: string; scope: SkillScope };
export type Problem = { scope: SkillScope; text: string };

export const MEMORY_WARN_LINES = 150;
// Box context is in every conversation's prompt: warn past this, leave files out past the max.
export const CONTEXT_WARN_BYTES = 32 * 1024;
export const CONTEXT_MAX_BYTES = 128 * 1024;

type Dirs = Pick<Config, "home" | "boxDir">;

export function workspaceDir(home: string): string {
  return path.join(home, "workspace");
}

export function boxPaths(boxDir: string) {
  return { context: path.join(boxDir, "context.d"), skills: path.join(boxDir, "skills.d") };
}

// Copies workspace-template/ into the workspace, never overwriting existing files.
export function bootstrapWorkspace(home: string): string[] {
  const created: string[] = [];
  const copy = (from: string, to: string) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        copy(src, dst);
      } else if (!fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        created.push(path.relative(workspaceDir(home), dst));
      }
    }
  };
  fs.mkdirSync(workspaceDir(home), { recursive: true });
  copy(path.join(REPO_ROOT, "workspace-template"), workspaceDir(home));
  return created;
}

// ---------------------------------------------------------------- skills (agentskills.io)

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

// The YAML frontmatter of a SKILL.md, or null when there is none or it doesn't parse.
// `lenient` is set when it only parsed after quoting values that contain ": " (a common
// slip: `description: Use when: …`), as the Agent Skills client guide recommends.
export function parseFrontmatter(content: string): { fields: Record<string, unknown>; lenient: boolean } | null {
  const match = FRONTMATTER.exec(content);
  if (!match) return null;
  const asMap = (text: string) => {
    const value: unknown = parseYaml(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  };
  try {
    const fields = asMap(match[1]!);
    return fields ? { fields, lenient: false } : null;
  } catch {
    const quoted = match[1]!
      .split(/\r?\n/)
      .map((line) => {
        const m = /^([A-Za-z][\w-]*):[ \t]+(.*\S)[ \t]*$/.exec(line);
        return m && m[2]!.includes(": ") && !/^["'|>]/.test(m[2]!) ? `${m[1]}: ${JSON.stringify(m[2])}` : line;
      })
      .join("\n");
    try {
      const fields = asMap(quoted);
      return fields ? { fields, lenient: true } : null;
    } catch {
      return null;
    }
  }
}

// Agent Skills spec: 1-64 lowercase letters and digits, single hyphens between them.
const SKILL_NAME = /^[\p{Ll}\p{Nd}]+(?:-[\p{Ll}\p{Nd}]+)*$/u;
const SKILL_FIELDS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);

// The Telegram command for a skill: /<name> with hyphens as underscores (at most 32 characters).
export function skillCommand(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
}

// Reads every <root>/<dir>/SKILL.md. A skill that breaks the spec in a way a reader can live
// with (a name that doesn't match its folder, a long description) is loaded and reported; one
// without a name or description, or without parseable frontmatter, is skipped and reported.
function scanSkills(root: string, scope: SkillScope, shown: string): { skills: Skill[]; problems: Problem[] } {
  const skills: Skill[] = [];
  const problems: Problem[] = [];
  const problem = (text: string) => problems.push({ scope, text });
  let entries: string[];
  try {
    entries = fs.readdirSync(root).sort();
  } catch {
    return { skills, problems };
  }
  for (const dir of entries) {
    if (dir.startsWith(".") || dir === "node_modules") continue;
    const where = `${shown}/${dir}`;
    try {
      if (!fs.statSync(path.join(root, dir)).isDirectory()) continue;
    } catch {
      continue; // a dangling link
    }
    const file = path.join(root, dir, "SKILL.md");
    if (!fs.existsSync(file)) {
      problem(`${where} has no SKILL.md`);
      continue;
    }
    const parsed = parseFrontmatter(fs.readFileSync(file, "utf8"));
    if (!parsed) {
      problem(`${where}/SKILL.md needs YAML frontmatter (--- name, description ---)`);
      continue;
    }
    const { fields, lenient } = parsed;
    const name = typeof fields.name === "string" ? fields.name.trim() : "";
    const description = typeof fields.description === "string" ? fields.description.trim().replace(/\s+/g, " ") : "";
    if (!name || !description) {
      problem(`${where}/SKILL.md needs name and description in its frontmatter`);
      continue;
    }
    if (lenient) problem(`${where}/SKILL.md: frontmatter isn't valid YAML (quote values that contain ": ")`);
    if (!SKILL_NAME.test(name) || name.length > 64) {
      problem(`${where}: name "${name}" should be 1-64 lowercase letters and digits with single hyphens between`);
    }
    if (name !== dir) problem(`${where}: name "${name}" should match its folder name`);
    if (name.length > 32) problem(`${where}: name over 32 characters, so its Telegram command is cut to /${skillCommand(name)}`);
    if (description.length > 1024) problem(`${where}: description is ${description.length} characters (at most 1024)`);
    if (fields.compatibility !== undefined && (typeof fields.compatibility !== "string" || fields.compatibility.length > 500)) {
      problem(`${where}: compatibility should be text of at most 500 characters`);
    }
    if (
      fields.metadata !== undefined &&
      (typeof fields.metadata !== "object" ||
        fields.metadata === null ||
        Array.isArray(fields.metadata) ||
        Object.values(fields.metadata).some((v) => typeof v !== "string"))
    ) {
      problem(`${where}: metadata should map names to text values`);
    }
    const unknown = Object.keys(fields).filter((k) => !SKILL_FIELDS.has(k));
    if (unknown.length > 0) problem(`${where}: unknown frontmatter field ${unknown.join(", ")}`);
    skills.push({ name, description, path: file, scope });
  }
  return { skills, problems };
}

// The workspace's skills and the box's, by name. A workspace skill overrides a box skill of
// the same name; within one place, the first folder (by name) wins.
export function loadSkills(dirs: Dirs): { skills: Skill[]; problems: Problem[] } {
  const box = boxPaths(dirs.boxDir);
  const ws = scanSkills(path.join(workspaceDir(dirs.home), "skills"), "workspace", "skills");
  const fromBox = scanSkills(box.skills, "box", box.skills);
  const problems = [...ws.problems, ...fromBox.problems];
  const byName = new Map<string, Skill>();
  for (const skill of [...ws.skills, ...fromBox.skills]) {
    const first = byName.get(skill.name);
    if (!first) {
      byName.set(skill.name, skill);
    } else if (first.scope === skill.scope) {
      problems.push({ scope: skill.scope, text: `two skills are named "${skill.name}" (${first.path}, ${skill.path}); the first one is used` });
    } else {
      problems.push({ scope: "workspace", text: `skills/${path.basename(path.dirname(first.path))} overrides the box's skill "${skill.name}" (${skill.path})` });
    }
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const commands = new Map<string, string>();
  for (const skill of skills) {
    const other = commands.get(skillCommand(skill.name));
    if (other) problems.push({ scope: skill.scope, text: `skills "${other}" and "${skill.name}" share the Telegram command /${skillCommand(skill.name)}` });
    commands.set(skillCommand(skill.name), skill.name);
  }
  return { skills, problems };
}

// ---------------------------------------------------------------- box context

export type ContextFile = { path: string; content: string };

// context.d/*.md in name order (number them: 10-box.md, 20-apps.md). Dotfiles, other files
// and empty ones are skipped.
export function loadBoxContext(boxDir: string): { dir: string; exists: boolean; files: ContextFile[]; bytes: number; problems: string[] } {
  const dir = boxPaths(boxDir).context;
  const files: ContextFile[] = [];
  const problems: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return { dir, exists: false, files, bytes: 0, problems };
  }
  let bytes = 0;
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".md")) continue;
    const file = path.join(dir, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      const content = fs.readFileSync(file, "utf8").trim();
      if (!content) continue;
      const size = Buffer.byteLength(content);
      if (bytes + size > CONTEXT_MAX_BYTES) {
        problems.push(`${name} left out: box context would pass ${CONTEXT_MAX_BYTES / 1024} KB`);
        continue;
      }
      bytes += size;
      files.push({ path: file, content });
    } catch (error) {
      problems.push(`${name}: ${(error as Error).message}`);
    }
  }
  if (bytes > CONTEXT_WARN_BYTES) {
    problems.push(
      `box context is ${Math.round(bytes / 1024)} KB, keep it under ${CONTEXT_WARN_BYTES / 1024} KB (it's in every prompt; move procedures into skills)`
    );
  }
  return { dir, exists: true, files, bytes, problems };
}

// ---------------------------------------------------------------- instructions

function readOptional(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
}

function duration(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// How the agent invokes `acmd notify` from its shell.
function notifyCommand(): string {
  if (fs.existsSync("/usr/local/bin/acmd")) return "acmd notify";
  const config = process.env.ACMD_CONFIG ? `ACMD_CONFIG=${shellQuote(process.env.ACMD_CONFIG)} ` : "";
  return `${config}${shellQuote(process.execPath)} ${shellQuote(path.join(REPO_ROOT, "dist", "main.js"))} notify`;
}

// Compiled once per conversation and then frozen, so the prompt-cache prefix stays stable.
export function compileInstructions(config: Pick<Config, "home" | "boxDir" | "bash">): string {
  const workspace = workspaceDir(config.home);
  const box = boxPaths(config.boxDir);
  const vars: Record<string, string> = {
    workspace,
    home: config.home,
    box_context: box.context,
    box_skills: box.skills,
    timeout: duration(config.bash.timeoutMs),
    max_timeout: duration(config.bash.maxTimeoutMs),
    notify: notifyCommand(),
    date: new Date().toISOString().slice(0, 10),
    host: os.hostname(),
    os: `${os.type()} ${os.release()} (${os.arch()})`
  };
  const runtime = fs
    .readFileSync(path.join(REPO_ROOT, "src", "prompt.md"), "utf8")
    .replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole)
    .trim();
  const sections = [runtime];
  const context = loadBoxContext(config.boxDir);
  if (context.files.length > 0) {
    const files = context.files.map((f) => `<file path="${xml(f.path)}">\n${f.content}\n</file>`).join("\n\n");
    sections.push(`<box_context dir="${xml(context.dir)}">\n${files}\n</box_context>`);
  }
  sections.push(
    `<agents_md path="${xml(path.join(workspace, "AGENTS.md"))}">\n${readOptional(path.join(workspace, "AGENTS.md"))}\n</agents_md>`,
    `<memory path="${xml(path.join(workspace, "MEMORY.md"))}">\n${readOptional(path.join(workspace, "MEMORY.md"))}\n</memory>`
  );
  const { skills } = loadSkills(config);
  if (skills.length > 0) {
    const entries = skills.map(
      (s) =>
        `  <skill>\n    <name>${xml(s.name)}</name>\n    <description>${xml(s.description)}</description>\n    <location>${xml(s.path)}</location>\n  </skill>`
    );
    sections.push(`<available_skills>\n${entries.join("\n")}\n</available_skills>`);
  }
  return sections.join("\n\n");
}

// ---------------------------------------------------------------- checks (acmd status)

type CheckResult = { status: "ok" | "warn"; detail: string };

export function checkWorkspace(dirs: Dirs): CheckResult & { skills: number } {
  const workspace = workspaceDir(dirs.home);
  const problems: string[] = [];
  if (!fs.existsSync(path.join(workspace, "AGENTS.md"))) problems.push("AGENTS.md missing");
  const { skills, problems: skillProblems } = loadSkills(dirs);
  problems.push(...skillProblems.filter((p) => p.scope === "workspace").map((p) => p.text));
  const memoryLines = readOptional(path.join(workspace, "MEMORY.md")).split("\n").length;
  if (memoryLines > MEMORY_WARN_LINES) problems.push(`MEMORY.md is ${memoryLines} lines (keep it under ${MEMORY_WARN_LINES})`);
  const own = skills.filter((s) => s.scope === "workspace").length;
  if (problems.length > 0) return { status: "warn", detail: problems.join("; "), skills: skills.length };
  return { status: "ok", detail: `AGENTS.md present, ${own} skills valid`, skills: skills.length };
}

export function checkBox(dirs: Dirs): CheckResult & { bytes: number } {
  const context = loadBoxContext(dirs.boxDir);
  const { skills, problems: skillProblems } = loadSkills(dirs);
  const boxSkills = skills.filter((s) => s.scope === "box").length;
  const problems = [...context.problems, ...skillProblems.filter((p) => p.scope === "box").map((p) => p.text)];
  if (problems.length > 0) return { status: "warn", detail: problems.join("; "), bytes: context.bytes };
  if (!context.exists && !fs.existsSync(boxPaths(dirs.boxDir).skills)) {
    return { status: "ok", detail: `none (${dirs.boxDir} has no context.d or skills.d)`, bytes: 0 };
  }
  const n = context.files.length;
  return {
    status: "ok",
    detail: `${n} context ${n === 1 ? "file" : "files"} (${(context.bytes / 1024).toFixed(1)} KB), ${boxSkills} ${boxSkills === 1 ? "skill" : "skills"}`,
    bytes: context.bytes
  };
}
