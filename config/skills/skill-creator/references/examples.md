# Technical Reference Examples

Use these as compact blueprints for creating `agent-commander` skills from source material.

## Example 1: GitHub CLI Tool

### Source to inspect first

- GitHub repo README
- CLI help output
- `docs/` pages or `--help` text

### Target skill

`repo-release-notes`

### Derived command

`/repo_release_notes`

### Use when

Create release notes from a CLI repo by reading the repo docs first, identifying the core user jobs, and turning the repeated workflow into a one-shot skill.

### Recommended structure

- `SKILL.md`
- `references/usage.md` only if the CLI has non-obvious flags or workflows
- `scripts/` only if a repeated parse or extraction step is fragile

### `SKILL.md` shape

```markdown
---
name: repo-release-notes
description: Draft release notes for a CLI repo from its README, help text, and docs. Use when creating a one-shot skill for a specific GitHub tool or repository workflow.
---

# Repo Release Notes

## Overview

Inspect the source repo first, then turn the observed CLI workflow into a concise one-shot skill.

## Workflow

1. Read the repo README, CLI help, and any docs pages.
2. Identify the primary task, inputs, outputs, and repeated steps.
3. Keep `SKILL.md` lean and add `references/` only for details that would clutter the body.
4. Validate the final `name`, folder slug, and `/repo_release_notes` command against the harness rules.
```

### Why this works

- The description names the capability and the source context.
- The skill stays one-shot, which matches `agent-commander` command invocation.
- Optional resources appear only when the repo has enough depth to justify them.

---

## Example 2: Docs-Site Skill

### Source to inspect first

- Product docs site
- API reference pages
- Quickstart or tutorial pages

### Target skill

`api-docs-summarizer`

### Derived command

`/api_docs_summarizer`

### Use when

Turn a docs site into a focused skill that summarizes usage, extracts canonical workflows, and preserves only the rules the user will actually need.

### Recommended structure

- `SKILL.md`
- `references/endpoints.md` if the docs contain a dense API surface
- `references/examples.md` if the docs include many usage patterns

### Why this works

- The source inspection step comes before writing anything.
- The description stays specific enough that the user can tell when to invoke it for docs-driven skill creation.
- References carry dense API facts so `SKILL.md` stays short.

---

## Example 3: Minimal Skill Skeleton

### Target skill

`calendar-importer`

### Derived command

`/calendar_importer`

### Minimal layout

- `SKILL.md`
- No `references/` unless the source actually has reusable detail worth splitting out

### Minimal `SKILL.md`

```markdown
---
name: calendar-importer
description: Create a one-shot skill that imports calendar data from source material. Use when building a new agent-commander skill from a repo, docs site, or brief.
---

# Calendar Importer

## Overview

Inspect the source first, then write the smallest skill that captures the real workflow.

## Workflow

1. Read the source material and identify the core job, inputs, outputs, and constraints.
2. Decide whether any details belong in `references/` or can stay in the body.
3. Keep the instructions imperative, concise, and one-shot.
4. Check that the folder name and `/calendar_importer` command are valid for the harness.

## Constraints

- Keep frontmatter to `name` and `description` only.
- Keep the description short enough to display cleanly in the skill list.
- Do not add unused resource directories.
```

### Why this works

- It models the smallest useful skill.
- It shows the derived command explicitly.
- It keeps optional resources contingent on real need, not habit.
