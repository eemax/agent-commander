import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProviderFunctionTool } from "./harness/types.js";
import type { SkillDefinition, WorkspaceSnapshot } from "./types.js";

function toSha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function formatSkillsXml(skills: SkillDefinition[]): string {
  if (skills.length === 0) {
    return "<available_skills>\nNo skills are currently available in the workspace.\n</available_skills>";
  }

  const entries = skills
    .map((skill) => `<skill name="${skill.name}" path="${skill.path}">\n${skill.description}\n</skill>`)
    .join("\n");

  return `<available_skills>\n${entries}\n</available_skills>`;
}

export function buildConversationBootstrapInstructions(params: {
  workspace: WorkspaceSnapshot;
}): string {
  const systemContent = params.workspace.systemContent.trim();
  const soulContent = params.workspace.soulContent.trim();
  const agentsContent = params.workspace.agentsContent.trim();

  const sections: string[] = [];

  if (systemContent.length > 0) {
    sections.push(`<system>\n${systemContent}\n</system>`);
  }

  sections.push(
    [
      "<operating_contracts>",
      `<contract name="SOUL.md" kind="behavior_spec">`,
      soulContent.length > 0 ? soulContent : "No SOUL.md content is available.",
      "</contract>",
      `<contract name="AGENTS.md" kind="agent_spec">`,
      agentsContent.length > 0 ? agentsContent : "No AGENTS.md content is available.",
      "</contract>",
      "</operating_contracts>"
    ].join("\n")
  );

  sections.push(formatSkillsXml(params.workspace.skills));

  return sections.join("\n").trim();
}

export function buildSkillInvocationInstructions(params: {
  skill: SkillDefinition;
  baseInstructions: string;
}): string {
  return [
    params.baseInstructions.trim(),
    "",
    `One-shot skill invocation: /${params.skill.slug}`,
    `Skill name: ${params.skill.name}`,
    `Skill description: ${params.skill.description}`,
    "Skill file (full content):",
    params.skill.content.trim(),
    "",
    "Apply this skill only for this request. Do not persist skill activation across future turns unless the user invokes it again."
  ]
    .join("\n")
    .trim();
}

export async function writeConversationContextSnapshot(params: {
  contextSnapshotsDir: string;
  chatId: string;
  conversationId: string;
  workspace: WorkspaceSnapshot;
  harnessTools: ProviderFunctionTool[];
  compiledInstructions: string;
}): Promise<string> {
  const chatFolder = encodeURIComponent(params.chatId);
  const outMarkdownPath = path.join(params.contextSnapshotsDir, chatFolder, `${params.conversationId}.md`);

  const payload = {
    generatedAt: new Date().toISOString(),
    chatId: params.chatId,
    conversationId: params.conversationId,
    workspaceRoot: params.workspace.workspaceRoot,
    systemPath: params.workspace.systemPath,
    systemSha256: params.workspace.systemSha256,
    agentsPath: params.workspace.agentsPath,
    agentsSha256: params.workspace.agentsSha256,
    soulPath: params.workspace.soulPath,
    soulSha256: params.workspace.soulSha256,
    tools: params.harnessTools.map((tool) => ({
      name: tool.name,
      description: tool.description
    })),
    skills: params.workspace.skills.map((skill) => ({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      path: skill.path,
      sha256: toSha256(skill.content)
    })),
    instructionsFormat: "hybrid_markdown_embedded_json_v1",
    instructionsPath: outMarkdownPath,
    instructionsSha256: toSha256(params.compiledInstructions)
  };

  const markdownSnapshot = [
    params.compiledInstructions.trim(),
    "",
    "<!-- acmd:snapshot-metadata:start -->",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "<!-- acmd:snapshot-metadata:end -->",
    ""
  ].join("\n");

  await fs.mkdir(path.dirname(outMarkdownPath), { recursive: true });
  await fs.writeFile(outMarkdownPath, markdownSnapshot, "utf8");
  return outMarkdownPath;
}
