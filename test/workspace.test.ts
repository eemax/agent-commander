import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./tmp.js";
import { skillCommand } from "../src/telegram/bot.js";
import {
  checkBox,
  checkWorkspace,
  compileInstructions,
  CONTEXT_MAX_BYTES,
  CONTEXT_WARN_BYTES,
  loadBoxContext,
  loadSkills,
  parseFrontmatter
} from "../src/workspace.js";

const bash = { timeoutMs: 120_000, maxTimeoutMs: 600_000, outputCapChars: 30_000 };

function dirs() {
  const home = tempDir("ws");
  const boxDir = tempDir("box");
  fs.mkdirSync(path.join(home, "workspace", "skills"), { recursive: true });
  fs.writeFileSync(path.join(home, "workspace", "AGENTS.md"), "I am the agent.");
  return { home, boxDir, bash };
}

function skill(root: string, dir: string, frontmatter: string, body = "Do the thing.\n") {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
}

const wsSkills = (d: { home: string }) => path.join(d.home, "workspace", "skills");
const boxSkills = (d: { boxDir: string }) => path.join(d.boxDir, "skills.d");
const boxContext = (d: { boxDir: string }) => path.join(d.boxDir, "context.d");

describe("frontmatter", () => {
  it("is YAML", () => {
    expect(parseFrontmatter('---\nname: x\ndescription: "Does y"\n---\nbody')).toEqual({ fields: { name: "x", description: "Does y" }, lenient: false });
    expect(parseFrontmatter("---\nname: x\ndescription: >\n  Folded\n  text.\nmetadata:\n  author: me\n---\n")?.fields).toEqual({
      name: "x",
      description: "Folded text.\n",
      metadata: { author: "me" }
    });
    expect(parseFrontmatter("﻿---\r\nname: x\r\n---\r\n")?.fields).toEqual({ name: "x" });
  });

  it("reads unquoted colons leniently and flags it", () => {
    expect(parseFrontmatter("---\nname: x\ndescription: Use when: the user asks\n---\n")).toEqual({
      fields: { name: "x", description: "Use when: the user asks" },
      lenient: true
    });
  });

  it("is null without frontmatter or a mapping", () => {
    expect(parseFrontmatter("no frontmatter")).toBeNull();
    expect(parseFrontmatter("---\n- a list\n---\n")).toBeNull();
    expect(parseFrontmatter("---\nname: [unclosed\n---\n")).toBeNull();
  });
});

describe("skills", () => {
  it("loads valid skills from the workspace and the box", () => {
    const d = dirs();
    skill(wsSkills(d), "notes", "name: notes\ndescription: Take notes. Use when asked to remember.");
    skill(boxSkills(d), "deploy-app", "name: deploy-app\ndescription: Deploy. Use when shipping.\nlicense: MIT\ncompatibility: Needs systemd\nmetadata:\n  owner: ops\nallowed-tools: Bash(git:*)");
    const { skills, problems } = loadSkills(d);
    expect(problems).toEqual([]);
    expect(skills).toEqual([
      { name: "deploy-app", description: "Deploy. Use when shipping.", path: path.join(boxSkills(d), "deploy-app", "SKILL.md"), scope: "box" },
      { name: "notes", description: "Take notes. Use when asked to remember.", path: path.join(wsSkills(d), "notes", "SKILL.md"), scope: "workspace" }
    ]);
    expect(checkWorkspace(d)).toEqual({ status: "ok", detail: "AGENTS.md present, 1 skills valid", skills: 2 });
    expect(checkBox(d).detail).toBe("0 context files (0.0 KB), 1 skill");
  });

  it("skips what can't be used and reports it", () => {
    const d = dirs();
    fs.mkdirSync(path.join(wsSkills(d), "empty"));
    skill(wsSkills(d), "nodesc", "name: nodesc");
    fs.mkdirSync(path.join(wsSkills(d), "nofm"));
    fs.writeFileSync(path.join(wsSkills(d), "nofm", "SKILL.md"), "# Just markdown");
    fs.mkdirSync(path.join(wsSkills(d), ".git"));
    fs.writeFileSync(path.join(wsSkills(d), "README.md"), "not a skill");
    const { skills, problems } = loadSkills(d);
    expect(skills).toEqual([]);
    expect(problems.map((p) => p.text)).toEqual([
      "skills/empty has no SKILL.md",
      "skills/nodesc/SKILL.md needs name and description in its frontmatter",
      "skills/nofm/SKILL.md needs YAML frontmatter (--- name, description ---)"
    ]);
    expect(checkWorkspace(d).status).toBe("warn");
  });

  it("loads skills that bend the spec, and reports how", () => {
    const d = dirs();
    skill(wsSkills(d), "folder", "name: Bad--Name\ndescription: x");
    skill(wsSkills(d), "long", `name: long\ndescription: ${"d".repeat(1100)}\ncompatibility: ${"c".repeat(501)}\nmetadata:\n  n: 1\nversion: 2`);
    skill(wsSkills(d), "colon", "name: colon\ndescription: Use when: asked");
    const { skills, problems } = loadSkills(d);
    expect(skills.map((s) => s.name)).toEqual(["Bad--Name", "colon", "long"]);
    expect(problems.map((p) => p.text)).toEqual([
      'skills/colon/SKILL.md: frontmatter isn\'t valid YAML (quote values that contain ": ")',
      'skills/folder: name "Bad--Name" should be 1-64 lowercase letters and digits with single hyphens between',
      'skills/folder: name "Bad--Name" should match its folder name',
      "skills/long: description is 1100 characters (at most 1024)",
      "skills/long: compatibility should be text of at most 500 characters",
      "skills/long: metadata should map names to text values",
      "skills/long: unknown frontmatter field version"
    ]);
  });

  it("lets a workspace skill override the box's, and flags duplicates", () => {
    const d = dirs();
    skill(wsSkills(d), "deploy", "name: deploy\ndescription: Mine.");
    skill(boxSkills(d), "deploy", "name: deploy\ndescription: The box's.");
    skill(boxSkills(d), "a-copy", "name: beacon\ndescription: First.");
    skill(boxSkills(d), "beacon", "name: beacon\ndescription: Second.");
    const { skills, problems } = loadSkills(d);
    expect(skills.map((s) => [s.name, s.description])).toEqual([
      ["beacon", "First."],
      ["deploy", "Mine."]
    ]);
    const text = problems.map((p) => `${p.scope}: ${p.text}`).join("\n");
    expect(text).toContain(`workspace: skills/deploy overrides the box's skill "deploy" (${path.join(boxSkills(d), "deploy", "SKILL.md")})`);
    expect(text).toMatch(/box: two skills are named "beacon" .*; the first one is used/);
    expect(checkWorkspace(d).status).toBe("warn");
    expect(checkBox(d).status).toBe("warn");
  });

  it("maps names to Telegram commands and flags clashes", () => {
    expect(skillCommand("skill-creator")).toBe("skill_creator");
    const d = dirs();
    const long = `a${"-b".repeat(20)}`;
    skill(wsSkills(d), long, `name: ${long}\ndescription: x`);
    skill(wsSkills(d), `${long}-c`, `name: ${long}-c\ndescription: y`);
    const text = loadSkills(d).problems.map((p) => p.text).join("\n");
    expect(text).toContain(`name over 32 characters, so its Telegram command is cut to /${skillCommand(long)}`);
    expect(text).toContain(`share the Telegram command /${skillCommand(long)}`);
  });
});

describe("box context", () => {
  it("reads context.d/*.md in name order", () => {
    const d = dirs();
    fs.mkdirSync(boxContext(d));
    fs.writeFileSync(path.join(boxContext(d), "20-apps.md"), "# Apps\n");
    fs.writeFileSync(path.join(boxContext(d), "10-box.md"), "# The box\n\n");
    fs.writeFileSync(path.join(boxContext(d), "30-empty.md"), "  \n");
    fs.writeFileSync(path.join(boxContext(d), ".hidden.md"), "secret");
    fs.writeFileSync(path.join(boxContext(d), "notes.txt"), "not markdown");
    const ctx = loadBoxContext(d.boxDir);
    expect(ctx.files.map((f) => [path.basename(f.path), f.content])).toEqual([
      ["10-box.md", "# The box"],
      ["20-apps.md", "# Apps"]
    ]);
    expect(ctx.problems).toEqual([]);
    expect(checkBox(d)).toEqual({ status: "ok", detail: "2 context files (0.0 KB), 0 skills", bytes: 15 });
  });

  it("is optional", () => {
    const d = dirs();
    expect(loadBoxContext(d.boxDir)).toMatchObject({ exists: false, files: [], bytes: 0 });
    expect(checkBox(d)).toEqual({ status: "ok", detail: `none (${d.boxDir} has no context.d or skills.d)`, bytes: 0 });
  });

  it("warns when it grows, and leaves out what passes the limit", () => {
    const d = dirs();
    fs.mkdirSync(boxContext(d));
    fs.writeFileSync(path.join(boxContext(d), "10-big.md"), "x".repeat(CONTEXT_WARN_BYTES + 1));
    expect(checkBox(d).detail).toMatch(/box context is 32 KB, keep it under 32 KB/);
    fs.writeFileSync(path.join(boxContext(d), "20-huge.md"), "y".repeat(CONTEXT_MAX_BYTES));
    const ctx = loadBoxContext(d.boxDir);
    expect(ctx.files.map((f) => path.basename(f.path))).toEqual(["10-big.md"]);
    expect(ctx.problems[0]).toBe("20-huge.md left out: box context would pass 128 KB");
  });
});

describe("instructions", () => {
  it("compile the runtime, box context, AGENTS.md, memory and the skills catalog", () => {
    const d = dirs();
    fs.writeFileSync(path.join(d.home, "workspace", "MEMORY.md"), "- a fact");
    fs.mkdirSync(boxContext(d));
    fs.writeFileSync(path.join(boxContext(d), "10-box.md"), "This box runs <things> & stuff.");
    skill(wsSkills(d), "notes", 'name: notes\ndescription: "Notes & <tags>."');
    skill(boxSkills(d), "beacon", "name: beacon\ndescription: Box status.");
    const text = compileInstructions(d);
    expect(text).not.toMatch(/\{\{\w+\}\}/);
    expect(text).toContain("(default 2 min, up to 10 min)");
    expect(text).toMatch(/notify "text"/);
    expect(text).toContain(`\`${boxContext(d)}/*.md\``);
    expect(text).toContain(`<box_context dir="${boxContext(d)}">\n<file path="${path.join(boxContext(d), "10-box.md")}">\nThis box runs <things> & stuff.\n</file>\n</box_context>`);
    expect(text).toContain("I am the agent.");
    expect(text).toContain("- a fact");
    expect(text).toContain(
      `<available_skills>\n  <skill>\n    <name>beacon</name>\n    <description>Box status.</description>\n    <location>${path.join(boxSkills(d), "beacon", "SKILL.md")}</location>\n  </skill>\n  <skill>\n    <name>notes</name>\n    <description>Notes &amp; &lt;tags&gt;.</description>`
    );
    // Box context comes before the agent's own files, the catalog last.
    expect(text.indexOf("<box_context dir")).toBeLessThan(text.indexOf("<agents_md"));
    expect(text.indexOf("<memory")).toBeLessThan(text.indexOf("<available_skills>\n"));
  });

  it("leave out empty sections", () => {
    const d = dirs();
    const text = compileInstructions(d);
    expect(text).not.toContain("<box_context dir");
    expect(text).not.toContain("<available_skills>\n");
    expect(text).toContain("<agents_md");
  });
});
