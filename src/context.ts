import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProviderFunctionTool } from "./harness/types.js";
import type { SkillDefinition, WorkspaceSnapshot } from "./types.js";

type MarkdownHeading = {
  level: number;
  title: string;
};

function toSha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function formatSkillSummaryMarkdown(skills: SkillDefinition[]): string {
  if (skills.length === 0) {
    return "No skills are currently available in the workspace.";
  }

  return skills.map((skill) => `- /${skill.slug}: ${skill.name} - ${skill.description}`).join("\n");
}

function parseMarkdownHeading(line: string): MarkdownHeading | null {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (!match) {
    return null;
  }

  const level = match[1].length;
  const rawTitle = (match[2] ?? "").replace(/\s+#+\s*$/, "").trim();
  if (rawTitle.length === 0) {
    return null;
  }

  return {
    level,
    title: rawTitle
  };
}

function toSnakeCaseTagName(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized : "section";
}

export function renderOperatingContractFromSoul(soulMarkdown: string): string {
  const lines = soulMarkdown.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  const openHeadings: Array<{ level: number; tag: string }> = [];

  const closeHeading = (): void => {
    const heading = openHeadings.pop();
    if (!heading) {
      return;
    }
    output.push(`</${heading.tag}>`);
  };

  for (const line of lines) {
    const heading = parseMarkdownHeading(line);
    if (!heading) {
      output.push(line);
      continue;
    }

    // H1 is ignored for wrapper generation.
    if (heading.level === 1) {
      continue;
    }

    while (openHeadings.length > 0 && openHeadings[openHeadings.length - 1]!.level >= heading.level) {
      closeHeading();
    }

    const tag = toSnakeCaseTagName(heading.title);
    output.push(`<${tag}>`);
    openHeadings.push({ level: heading.level, tag });
  }

  while (openHeadings.length > 0) {
    closeHeading();
  }

  return output.join("\n").trim();
}

export function buildConversationBootstrapInstructions(params: {
  workspace: WorkspaceSnapshot;
}): string {
  const agentsContent = params.workspace.agentsContent.trim();
  const operatingContractContent = renderOperatingContractFromSoul(params.workspace.soulContent);

  return [
    "<session>",
    "<operating_contract>",
    operatingContractContent.length > 0 ? operatingContractContent : "No SOUL.md content is available.",
    "</operating_contract>",
    "<environment>",
    "<skills>",
    formatSkillSummaryMarkdown(params.workspace.skills),
    "</skills>",
    "</environment>",
    "<reference_documents>",
    '<document name="AGENTS.md" kind="agent_spec">',
    agentsContent.length > 0 ? agentsContent : "No AGENTS.md content is available.",
    "</document>",
    "</reference_documents>",
    "</session>"
  ]
    .join("\n")
    .trim();
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
