---
name: skill-creator
description: Create or improve a skill in the workspace, in the Agent Skills format. Use when the user asks for a new skill or to change one, or when a workflow you repeat deserves one.
---

# Creating a skill

A skill is a folder `skills/<name>/` in the workspace with a `SKILL.md`, plus optional `scripts/`, `references/` and `assets/`. It follows the open Agent Skills format (https://agentskills.io/specification), so it also works in Claude Code, Codex and other agents.

## Steps

1. Agree on what the skill is for in one sentence, and when it should be used. If a box skill (in the box's `skills.d/`) already covers it, use that one instead; a workspace skill with the same name would override it.
2. Pick `<name>`: 1-64 characters, lowercase letters, digits and single hyphens (`deploy-app`; not `Deploy_App`, `-x` or `a--b`). The folder must have the same name. Telegram offers it as `/<name>` with hyphens as underscores, cut at 32 characters, so keep it short.
3. Create `skills/<name>/SKILL.md`, starting with YAML frontmatter. `name` and `description` are required. The description (at most 1024 characters) is all the agent sees when choosing a skill, so say what it does *and when to use it*, with the words a request would contain:

   ```
   ---
   name: <name>
   description: <what it does>. Use when <trigger>.
   ---
   ```

   Quote a value that contains `: ` (`description: "Use when: …"`). Optional fields: `license`, `compatibility` (at most 500 characters, only when it needs something specific: a tool, network access), `metadata` (a map of text values, e.g. `author`, `version`). Nothing else goes in the frontmatter.

4. Write the body as instructions to a capable colleague: the goal, the steps, the commands, the gotchas, and how to verify the result. Prefer concrete commands over prose. Keep SKILL.md under ~200 lines (the spec's limit is 500): the whole file is read each time the skill is used. Move long reference material to `references/<topic>.md` and reusable code to `scripts/`, link them with paths relative to the skill folder (`[the API notes](references/api.md)`, `scripts/check.sh`), one level deep, and say in the body when to read or run each.
5. Validate: the frontmatter parses (`head -6 skills/<name>/SKILL.md`), the name matches the folder, scripts run. `acmd status` lists skill problems under `workspace`.
6. Tell the user the skill exists and that it is available from the next conversation (/new).

## Improving a skill

When a skill misfired, fix the instructions where they were ambiguous instead of adding special cases, and keep the description accurate: a skill that is never picked usually has a vague description.
