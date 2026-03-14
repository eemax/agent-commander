import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConversationBootstrapInstructions,
  buildSkillInvocationInstructions,
  renderOperatingContractFromSoul,
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
  it("builds session bootstrap instructions", () => {
    const instructions = buildConversationBootstrapInstructions({
      workspace: makeWorkspace()
    });

    expect(instructions).toContain("<session>");
    expect(instructions).not.toContain("<base_instructions>");
    expect(instructions).toContain("<operating_contract>");
    expect(instructions).toContain("<identity>");
    expect(instructions).toContain("<core_rules>");
    expect(instructions).toContain("<nested_direction>");
    expect(instructions).not.toContain("<available_tools>");
    expect(instructions).not.toContain("<available_skills>");
    expect(instructions).toContain("<environment>");
    expect(instructions).toContain("<skills>");
    expect(instructions).toContain("<reference_documents>");
    expect(instructions).toContain('<document name="AGENTS.md" kind="agent_spec">');
    expect(instructions).toContain("# AGENTS.md");
    expect(instructions).toContain("## Header 2 Name");
    expect(instructions).toContain("- /research: Research - Find facts & summarize.");
    expect(instructions).not.toContain("<tools>");
    expect(instructions).not.toContain("- bash: Run shell & return output");
    expect(instructions).not.toContain("<tool>");
    expect(instructions).not.toContain("<skill>");
  });

  it("converts SOUL markdown H2+ headings into nested XML wrappers", () => {
    const rendered = renderOperatingContractFromSoul([
      "# Root Title",
      "Preface text.",
      "",
      "## Core Rules!",
      "- rule a",
      "### Focus & Scope",
      "Be explicit.",
      "## Voice",
      "Authentic.",
      ""
    ].join("\n"));

    expect(rendered).not.toContain("# Root Title");
    expect(rendered).toContain("Preface text.");
    expect(rendered).toContain("<core_rules>");
    expect(rendered).toContain("</core_rules>");
    expect(rendered).toContain("<focus_scope>");
    expect(rendered).toContain("- rule a");
    expect(rendered).toContain("Be explicit.");
    expect(rendered).toContain("<voice>");
    expect(rendered).toContain("Authentic.");
  });

  it("keeps one-shot skill invocation text-only", () => {
    const workspace = makeWorkspace();
    const skill = workspace.skills[0];
    if (!skill) {
      throw new Error("Expected test workspace skill");
    }

    const instructions = buildSkillInvocationInstructions({
      skill,
      baseInstructions: "<session>bootstrap</session>"
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
    expect(markdown).toContain("<session>");
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
      soulPath?: string;
      soulSha256?: string;
      instructionsFormat?: string;
      instructionsPath?: string;
      instructionsSha256?: string;
    };
    expect(snapshot.soulPath).toBe(workspace.soulPath);
    expect(snapshot.soulSha256).toBe(workspace.soulSha256);
    expect(snapshot.instructionsFormat).toBe("hybrid_markdown_embedded_json_v1");
    expect(snapshot.instructionsPath).toBe(markdownPath);
    expect(typeof snapshot.instructionsSha256).toBe("string");
  });
});
