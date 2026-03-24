import { describe, expect, it } from "vitest";
import {
  assertValidCommandName,
  buildCommandCatalog,
  parseTelegramCommand,
  toTelegramCommand
} from "../src/telegram/commands.js";

describe("telegram command registry", () => {
  it("builds core + skill command catalog", () => {
    const catalog = buildCommandCatalog([
      {
        name: "Research",
        description: "Research helper",
        path: "/tmp/research/SKILL.md",
        content: "---"
      }
    ]);

    expect(catalog.map((item) => item.command)).toContain("start");
    expect(catalog.map((item) => item.command)).toContain("new");
    expect(catalog.map((item) => item.command)).toContain("stash");
    expect(catalog.map((item) => item.command)).toContain("cwd");
    expect(catalog.map((item) => item.command)).toContain("verbose");
    expect(catalog.map((item) => item.command)).toContain("thinking");
    expect(catalog.map((item) => item.command)).toContain("cache");
    expect(catalog.map((item) => item.command)).toContain("model");
    expect(catalog.map((item) => item.command)).toContain("models");
    expect(catalog.map((item) => item.command)).toContain("research");
  });

  it("rejects skill command collisions with core commands", () => {
    expect(() =>
      buildCommandCatalog([
        {
          name: "status",
          description: "conflict",
          path: "/tmp/bad/SKILL.md",
          content: "---"
        }
      ])
    ).toThrow("Skill command collision");
  });

  it("parses telegram commands and args", () => {
    expect(parseTelegramCommand("/bash echo hi")).toEqual({
      command: "bash",
      args: "echo hi"
    });
    expect(parseTelegramCommand("/verbose on")).toEqual({
      command: "verbose",
      args: "on"
    });
    expect(parseTelegramCommand("/model codex")).toEqual({
      command: "model",
      args: "codex"
    });
    expect(parseTelegramCommand("/cache 24h")).toEqual({
      command: "cache",
      args: "24h"
    });
    expect(parseTelegramCommand("/models")).toEqual({
      command: "models",
      args: ""
    });
    expect(parseTelegramCommand("/cwd /tmp/project")).toEqual({
      command: "cwd",
      args: "/tmp/project"
    });
    expect(parseTelegramCommand("/stash deep_work")).toEqual({
      command: "stash",
      args: "deep_work"
    });

    expect(parseTelegramCommand("hello")).toBeNull();
  });

  it("normalizes names into telegram commands and validates format", () => {
    expect(toTelegramCommand("test-skill")).toBe("test_skill");
    expect(() => assertValidCommandName("1bad", "/tmp/skill")).toThrow("Invalid skill command name");
  });
});
