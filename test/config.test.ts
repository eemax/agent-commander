import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./tmp.js";
import { isRetryable, undelivered } from "../src/agent.js";
import { parseConfig, resolveModel } from "../src/config.js";
import { skillCommand } from "../src/telegram/bot.js";
import { checkWorkspace, compileInstructions, loadSkills, parseFrontmatter } from "../src/workspace.js";

const valid = {
  telegram: { allowlist: [123456789] },
  models: [
    { id: "deepseek/deepseek-v4.1-flash", alias: "flash" },
    { id: "moonshotai/kimi-k3", alias: "kimi" }
  ]
};

describe("config", () => {
  it("applies defaults and normalizes ids", () => {
    const c = parseConfig(valid);
    expect(c.allowlist).toEqual(["123456789"]);
    expect(c.defaultEffort).toBe("medium");
    expect(c.bash).toEqual({ timeoutMs: 120_000, maxTimeoutMs: 600_000, outputCapChars: 30_000 });
    expect(c.maxTurnCostUsd).toBeNull();
    expect(c.home).toBe(path.join(os.homedir(), ".acmd"));
  });

  it("refuses an empty allowlist", () => {
    expect(() => parseConfig({ ...valid, telegram: { allowlist: [] } })).toThrow(/allowlist is empty/);
  });

  it("refuses a max timeout below the default timeout", () => {
    expect(() => parseConfig({ ...valid, bash: { timeout_ms: 60_000, max_timeout_ms: 30_000 } })).toThrow(/max_timeout_ms/);
  });

  it("refuses unknown keys and duplicate aliases", () => {
    expect(() => parseConfig({ ...valid, extra: 1 })).toThrow();
    expect(() => parseConfig({ ...valid, models: [valid.models[0], valid.models[0]] })).toThrow(/duplicate alias/);
  });

  it("resolves models by alias or id", () => {
    const c = parseConfig(valid);
    expect(resolveModel(c, "kimi")?.id).toBe("moonshotai/kimi-k3");
    expect(resolveModel(c, "deepseek/deepseek-v4.1-flash")?.alias).toBe("flash");
    expect(resolveModel(c, "nope")).toBeNull();
  });
});

describe("retry policy", () => {
  it("retries server errors but not client errors", () => {
    expect(isRetryable(Object.assign(new Error("x"), { statusCode: 502 }))).toBe(true);
    expect(isRetryable(Object.assign(new Error("x"), { statusCode: 429 }))).toBe(true);
    expect(isRetryable(Object.assign(new Error("x"), { statusCode: 401 }))).toBe(false);
    expect(isRetryable(new Error('Response failed: {"code":"server_error"}'))).toBe(true);
    expect(isRetryable(new Error("invalid model"))).toBe(false);
  });
});

describe("steer tracking", () => {
  it("matches each delivered text once", () => {
    expect(undelivered(["a", "b"], ["a"])).toEqual(["b"]);
    expect(undelivered(["yes", "yes"], ["yes"])).toEqual(["yes"]);
    expect(undelivered(["x"], [])).toEqual(["x"]);
  });
});

describe("workspace", () => {
  it("parses frontmatter", () => {
    expect(parseFrontmatter('---\nname: x\ndescription: "Does y"\n---\nbody')).toEqual({ name: "x", description: "Does y" });
    expect(parseFrontmatter("no frontmatter")).toBeNull();
  });

  it("loads skills, flags broken ones and compiles instructions", () => {
    const home = tempDir("ws");
    const ws = path.join(home, "workspace");
    fs.mkdirSync(path.join(ws, "skills", "good"), { recursive: true });
    fs.mkdirSync(path.join(ws, "skills", "bad"), { recursive: true });
    fs.writeFileSync(path.join(ws, "skills", "good", "SKILL.md"), "---\nname: good\ndescription: Good skill.\n---\n");
    fs.writeFileSync(path.join(ws, "skills", "bad", "SKILL.md"), "no frontmatter");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "I am the agent.");

    fs.mkdirSync(path.join(ws, "skills", "good-copy"), { recursive: true });
    fs.writeFileSync(path.join(ws, "skills", "good-copy", "SKILL.md"), "---\nname: good\ndescription: Same name.\n---\n");
    const { skills, problems } = loadSkills(ws);
    expect(skills.map((s) => s.name)).toEqual(["good", "good"]);
    expect(problems.join("\n")).toMatch(/bad/);
    expect(problems.join("\n")).toMatch(/two skills are named "good"/);
    fs.rmSync(path.join(ws, "skills", "good-copy"), { recursive: true });
    expect(checkWorkspace(home).status).toBe("warn");

    const instructions = compileInstructions(home, { timeoutMs: 120_000, maxTimeoutMs: 600_000 });
    expect(instructions).toContain("I am the agent.");
    expect(instructions).toContain("- good: Good skill.");
    expect(instructions).not.toContain("Same name.");
    expect(instructions).toContain(ws);
    expect(instructions).not.toMatch(/\{\{\w+\}\}/);
    expect(instructions).toContain("(default 2 min, up to 10 min)");
    expect(instructions).toMatch(/notify "text"/);
  });

  it("maps skill names to Telegram commands", () => {
    expect(skillCommand("skill-creator")).toBe("skill_creator");
  });
});
