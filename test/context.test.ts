import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConversationBootstrapInstructions,
  buildSkillInvocationInstructions,
  writeConversationContextSnapshot
} from "../src/context.js";
import type { ProviderFunctionTool } from "../src/harness/types.js";
import type { WorkspaceSnapshot } from "../src/types.js";

function mkdtemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeWorkspace(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    workspaceRoot: "/tmp/workspace",
    systemPath: "/tmp/config/SYSTEM.md",
    systemContent: "You are an agent running inside Agent Commander.",
    systemSha256: "system-sha",
    agentsPath: "/tmp/workspace/AGENTS.md",
    agentsContent: [
      "# AGENTS.md",
      "Top-level intro & context",
      "## Header 2 Name",
      "Use <xml> safely.",
      "### Child Node!",
      "Child content",
      ""
    ].join("\n"),
    agentsSha256: "agents-sha",
    soulPath: "/tmp/workspace/SOUL.md",
    soulContent: [
      "# SOUL.md",
      "",
      "## Identity",
      "You are Ysera.",
      "",
      "## Core Rules!",
      "- Be useful.",
      "### Nested Direction",
      "Keep answers practical.",
      "",
      "## Voice",
      "Darker, melancholic, existential.",
      ""
    ].join("\n"),
    soulSha256: "soul-sha",
    skillsDir: "/tmp/workspace/skills",
    skills: [
      {
        slug: "research",
        name: "Research",
        description: "Find facts & summarize.",
        path: "/tmp/workspace/skills/research/SKILL.md",
        content: "---\nname: Research\ndescription: Find facts\n---\n# Research\n"
      }
    ],
    commands: [],
    signature: "sig",
    ...overrides
  };
}

describe("context compilation", () => {
  it("builds bootstrap instructions with system, contracts, and skills", () => {
    const instructions = buildConversationBootstrapInstructions({
      workspace: makeWorkspace()
    });

    expect(instructions).toContain("<system>");
    expect(instructions).toContain("You are an agent running inside Agent Commander.");
    expect(instructions).toContain("</system>");
    expect(instructions).toContain("<operating_contracts>");
    expect(instructions).toContain('<contract name="SOUL.md" kind="behavior_spec">');
    expect(instructions).toContain("## Identity");
    expect(instructions).toContain("## Core Rules!");
    expect(instructions).toContain("## Voice");
    expect(instructions).toContain("</contract>");
    expect(instructions).toContain('<contract name="AGENTS.md" kind="agent_spec">');
    expect(instructions).toContain("# AGENTS.md");
    expect(instructions).toContain("## Header 2 Name");
    expect(instructions).toContain("</operating_contracts>");
    expect(instructions).toContain("<available_skills>");
    expect(instructions).toContain('<skill name="Research" path="/tmp/workspace/skills/research/SKILL.md">');
    expect(instructions).toContain("Find facts & summarize.");
    expect(instructions).toContain("</skill>");
    expect(instructions).toContain("</available_skills>");

    // Old format elements should not appear
    expect(instructions).not.toContain("<session>");
    expect(instructions).not.toContain("<environment>");
    expect(instructions).not.toContain("<reference_documents>");
    expect(instructions).not.toContain("<identity>");
    expect(instructions).not.toContain("<core_rules>");
  });

  it("preserves SOUL.md markdown as-is without header-to-XML conversion", () => {
    const instructions = buildConversationBootstrapInstructions({
      workspace: makeWorkspace()
    });

    // Headings should appear as markdown, not as XML tags
    expect(instructions).toContain("## Identity");
    expect(instructions).toContain("## Core Rules!");
    expect(instructions).toContain("### Nested Direction");
    expect(instructions).toContain("## Voice");
    expect(instructions).not.toContain("<identity>");
    expect(instructions).not.toContain("<core_rules>");
    expect(instructions).not.toContain("<nested_direction>");
    expect(instructions).not.toContain("<voice>");
  });

  it("omits system section when SYSTEM.md is empty", () => {
    const instructions = buildConversationBootstrapInstructions({
      workspace: makeWorkspace({ systemContent: "" })
    });

    expect(instructions).not.toContain("<system>");
    expect(instructions).toContain("<operating_contracts>");
  });

  it("soul contract comes before agents contract", () => {
    const instructions = buildConversationBootstrapInstructions({
      workspace: makeWorkspace()
    });

    const soulIdx = instructions.indexOf('kind="behavior_spec"');
    const agentsIdx = instructions.indexOf('kind="agent_spec"');
    expect(soulIdx).toBeLessThan(agentsIdx);
  });

  it("keeps one-shot skill invocation text-only", () => {
    const workspace = makeWorkspace();
    const skill = workspace.skills[0];
    if (!skill) {
      throw new Error("Expected test workspace skill");
    }

    const instructions = buildSkillInvocationInstructions({
      skill,
      baseInstructions: "<system>bootstrap</system>"
    });

    expect(instructions).toContain("One-shot skill invocation: /research");
    expect(instructions).not.toContain("<skill_invocation>");
  });

  it("writes a single Markdown context snapshot with embedded metadata JSON", async () => {
    const root = mkdtemp("acmd-context-");
    const workspace = makeWorkspace();
    const tools: ProviderFunctionTool[] = [];
    const compiledInstructions = buildConversationBootstrapInstructions({
      workspace
    });

    const markdownPath = await writeConversationContextSnapshot({
      contextSnapshotsDir: root,
      chatId: "chat/1",
      conversationId: "conv_01TEST",
      workspace,
      harnessTools: tools,
      compiledInstructions
    });

    const folder = path.dirname(markdownPath);
    const jsonPath = path.join(folder, "conv_01TEST.json");
    expect(fs.existsSync(markdownPath)).toBe(true);
    expect(fs.existsSync(jsonPath)).toBe(false);

    const markdown = fs.readFileSync(markdownPath, "utf8");
    expect(markdown).toContain("<system>");
    expect(markdown).toContain("<!-- acmd:snapshot-metadata:start -->");
    expect(markdown).toContain("<!-- acmd:snapshot-metadata:end -->");

    const metadataMatch =
      /<!-- acmd:snapshot-metadata:start -->\n```json\n([\s\S]*?)\n```\n<!-- acmd:snapshot-metadata:end -->/.exec(
        markdown
      );
    expect(metadataMatch).not.toBeNull();

    const metadataJson = metadataMatch?.[1];
    if (!metadataJson) {
      throw new Error("Expected snapshot metadata JSON block");
    }

    const snapshot = JSON.parse(metadataJson) as {
      systemPath?: string;
      systemSha256?: string;
      soulPath?: string;
      soulSha256?: string;
      instructionsFormat?: string;
      instructionsPath?: string;
      instructionsSha256?: string;
    };
    expect(snapshot.systemPath).toBe(workspace.systemPath);
    expect(snapshot.systemSha256).toBe(workspace.systemSha256);
    expect(snapshot.soulPath).toBe(workspace.soulPath);
    expect(snapshot.soulSha256).toBe(workspace.soulSha256);
    expect(snapshot.instructionsFormat).toBe("hybrid_markdown_embedded_json_v1");
    expect(snapshot.instructionsPath).toBe(markdownPath);
    expect(typeof snapshot.instructionsSha256).toBe("string");
  });
});
