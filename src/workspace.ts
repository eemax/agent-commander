import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPO_ROOT } from "./config.js";

export type Skill = { name: string; description: string; path: string };

export const MEMORY_WARN_LINES = 150;

export function workspaceDir(home: string): string {
  return path.join(home, "workspace");
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

export function parseFrontmatter(content: string): Record<string, string> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const value = line.slice(sep + 1).trim().replace(/^["']|["']$/g, "");
    fields[line.slice(0, sep).trim().toLowerCase()] = value;
  }
  return fields;
}

export function loadSkills(workspace: string): { skills: Skill[]; problems: string[] } {
  const skills: Skill[] = [];
  const problems: string[] = [];
  const root = path.join(workspace, "skills");
  if (!fs.existsSync(root)) return { skills, problems };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) {
      problems.push(`skills/${entry.name} has no SKILL.md`);
      continue;
    }
    const fields = parseFrontmatter(fs.readFileSync(file, "utf8"));
    if (!fields?.name || !fields.description) {
      problems.push(`skills/${entry.name}/SKILL.md needs name and description frontmatter`);
      continue;
    }
    skills.push({ name: fields.name, description: fields.description, path: file });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, problems };
}

function readOptional(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
}

// Compiled once per conversation and then frozen, so the prompt-cache prefix stays stable.
export function compileInstructions(home: string): string {
  const workspace = workspaceDir(home);
  const vars: Record<string, string> = {
    workspace,
    home,
    date: new Date().toISOString().slice(0, 10),
    host: os.hostname(),
    os: `${os.type()} ${os.release()} (${os.arch()})`
  };
  const runtime = fs
    .readFileSync(path.join(REPO_ROOT, "src", "prompt.md"), "utf8")
    .replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole)
    .trim();
  const { skills } = loadSkills(workspace);
  const skillIndex = skills.map((s) => `- ${s.name}: ${s.description} (${s.path})`).join("\n");
  return [
    runtime,
    `<agents_md path="${path.join(workspace, "AGENTS.md")}">\n${readOptional(path.join(workspace, "AGENTS.md"))}\n</agents_md>`,
    `<memory path="${path.join(workspace, "MEMORY.md")}">\n${readOptional(path.join(workspace, "MEMORY.md"))}\n</memory>`,
    `<skills>\n${skillIndex || "(none yet)"}\n</skills>`
  ].join("\n\n");
}

export function checkWorkspace(home: string): { status: "ok" | "warn"; detail: string; skills: number } {
  const workspace = workspaceDir(home);
  const problems: string[] = [];
  if (!fs.existsSync(path.join(workspace, "AGENTS.md"))) problems.push("AGENTS.md missing");
  const { skills, problems: skillProblems } = loadSkills(workspace);
  problems.push(...skillProblems);
  const memoryLines = readOptional(path.join(workspace, "MEMORY.md")).split("\n").length;
  if (memoryLines > MEMORY_WARN_LINES) problems.push(`MEMORY.md is ${memoryLines} lines (keep it under ${MEMORY_WARN_LINES})`);
  if (problems.length > 0) return { status: "warn", detail: problems.join("; "), skills: skills.length };
  return { status: "ok", detail: `AGENTS.md present, ${skills.length} skills valid`, skills: skills.length };
}
