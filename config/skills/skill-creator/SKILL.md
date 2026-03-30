---
name: skill-creator
description: Create new agent-commander skills from repos, docs sites, package pages, or briefs. Use when authoring a one-shot /<slug> skill or refining an existing skill for the agent-commander harness.
---

# Skill Creator

## Overview

Build agent-commander skills as compact one-shot capabilities: source-inspect-first, concise metadata, and only the resources that the skill actually needs.
Optimize for clear `/slug` invocation, parser-safe frontmatter, and minimal context overhead.

## Load References

1. Read `references/workflow.md` before creating or updating any skill.
2. Read `references/examples.md` when drafting the skill shape, resource layout, or output template.
3. Read `references/anti-patterns.md` when debugging weak invocation guidance, parser issues, or unnecessary resources.

## Workflow

1. Inspect the source first.
   - Read the repo, docs page, package page, or brief before writing the skill.
   - Identify the real job, the boundaries, and the repeated work.

2. Define the skill scope.
   - State what the new skill should do.
   - State what is out of scope.
   - Prefer a narrow, one-shot use case over a broad helper mode.

3. Choose the skill identity.
   - Pick a lowercase hyphen-case folder name.
   - Derive the final `/command` from the name and check it for collisions.
   - Keep the name stable and easy to invoke in `agent-commander`.

4. Partition resources.
   - Use `references/` for long details that should load on demand.
   - Use `scripts/` only for repeated or correctness-critical operations.
   - Use `assets/` only for templates or output artifacts that should be copied.
   - Do not create unused directories.

5. Draft `SKILL.md` last.
   - Keep frontmatter to `name` and `description` only.
   - Keep both fields single-line, plain, and parser-safe.
   - Make `description` concise enough for the skill list and avoid the 256-character truncation path.
   - Keep the body procedural and lean; push detail into references.

6. Validate against the harness.
   - Confirm the derived command matches the harness pattern and does not collide with core commands.
   - Confirm the skill can be invoked as a one-shot `/<slug>` command.
   - Confirm the skill does not depend on packaging scripts or non-existent scaffold tooling.

7. Return a complete skill draft.
   - Include the proposed folder path and derived `/command`.
   - Include the final `SKILL.md` content and any optional resource contents.
   - Include validation results, assumptions, and unresolved unknowns.

## Hard Constraints

- Use lowercase, digits, and hyphens for skill folder names by default.
- Do not add README/INSTALL guides/changelogs.
- Do not duplicate the same guidance in multiple files.
- Do not create unused resource directories.
- Do not leave TODO placeholders.
- Do not assume silent activation; agent-commander skills are user-invoked.

## Output Requirements for Skill-Build Tasks

Return:

1. Proposed folder path and derived `/command`
2. Final file contents
3. Validation results
4. Assumptions and unresolved unknowns
