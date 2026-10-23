---
name: skill-creator
description: Create or improve a skill in the workspace. Use when the user asks for a new skill, or when a repeated workflow deserves one.
---

# Creating a skill

A skill is a folder `skills/<name>/` in the workspace with a `SKILL.md`, plus optional `scripts/` and `references/`. Skills use the open Agent Skills format, so they also work in Claude Code and Codex.

## Steps

1. Agree on what the skill is for in one sentence, and when it should be used.
2. Create `skills/<name>/SKILL.md`. `<name>` is lowercase with hyphens; Telegram exposes it as `/<name>` (hyphens become underscores).
3. Start the file with frontmatter. Both fields are required, and the description is what decides when the skill gets used, so make it specific about *when*:

   ```
   ---
   name: <name>
   description: <what it does>. Use when <trigger>.
   ---
   ```

4. Write the body as instructions to a capable colleague: the goal, the steps, the commands, the gotchas, and how to verify the result. Prefer concrete commands over prose. Keep it under ~150 lines; move long reference material to `references/*.md` and reusable code to `scripts/`, and say in the body when to read or run them.
5. Validate: `head -5 skills/<name>/SKILL.md` shows the frontmatter, and any scripts run.
6. Tell the user the skill exists and that it is available from the next conversation (/new).

## Improving a skill

When a skill misfired, fix the instructions where they were ambiguous instead of adding special cases, and keep the description accurate.
