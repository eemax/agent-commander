# Technical Skill-Creation Workflow

## 1) Input Contract

Collect only what is required:

- Skill name
- Source material and where it lives
- Desired new-skill behavior
- Core capability boundaries (what is in/out)
- Required resources (`scripts`, `references`, `assets`)

If the source is a repo, docs site, package page, or brief, inspect it first before drafting the skill.
If examples are missing, infer 2-3 realistic use cases and state the assumptions.

## 2) Use-When Guidance

Write `description` as the invocation spec.

Include:

- Primary capability
- Concrete use-when contexts (tasks, file types, workflows)
- Scope boundaries for precision
- One-shot behavior for `/<slug>` invocation

Avoid:

- Generic statements like "helps with many tasks"
- Silent-activation language
- Body-only invocation logic

### Harness rules to keep in view

- `name` and `description` are the only frontmatter keys.
- Keep both fields single-line and plain; the harness parses frontmatter with simple line splitting.
- Default to lowercase hyphen-case for folder and skill name.
- Derive the final command with `toTelegramCommand` behavior: spaces and hyphens become underscores.
- The command must match `^[a-z][a-z0-9_]{0,31}$`.
- Check for collisions with core commands such as `/start`, `/new`, `/bash`, `/search`, `/model`, and `/auth`.
- Keep the description short enough to remain readable in the skill list and to avoid truncation past 256 characters.

## 3) Resource Partitioning

Use this split:

- `scripts/`: deterministic or repeated operations
- `references/`: detailed docs loaded on demand
- `assets/`: templates/boilerplate for outputs

Decision rule:

- If logic is repeated >= 2 times or fragile, prefer script.
- If content is long and advisory, prefer reference.
- If content is copied into outputs, prefer asset.
- If the skill does not need a resource, do not create the directory.

## 4) Authoring Order

1. Inspect the source material and extract the real job, boundaries, and recurring patterns.
2. Choose the skill name, folder slug, and derived command.
3. Decide whether `references/`, `scripts/`, or `assets/` are actually needed.
4. Build resources first when they prevent repetition or errors.
5. Write `SKILL.md` last.
6. Keep `SKILL.md` procedural and compact.

`SKILL.md` minimum shape:

- Overview
- Which references to read and when
- Step workflow
- Hard constraints

## 5) Validation and Review

Use a manual harness checklist:

- Confirm `SKILL.md` starts with valid frontmatter and only `name` and `description`.
- Confirm the folder name matches the skill name.
- Confirm the derived command is valid and does not collide with a core command.
- Confirm the body matches a one-shot `/<slug>` skill, not a persistent mode.
- Confirm any `references/`, `scripts/`, and `assets/` directories are used.
- Confirm the draft does not assume scaffold or packaging tooling that does not exist.
- Confirm the final deliverable includes the proposed folder path, `/command`, file contents, validation results, assumptions, and unresolved unknowns.

## 6) Quality Gates

Before finalizing, verify:

- Invocation precision: useful for intended tasks, not simple unrelated tasks
- Progressive disclosure: `SKILL.md` stays lean and references hold the details
- Operational clarity: no ambiguous steps, no hidden assumptions
- Reusability: instructions work across repos, docs sites, package pages, and briefs
- Harness compatibility: command rules and frontmatter rules match `agent-commander`

## 7) Fast Iteration Loop

When the skill underperforms:

1. Capture exact failure pattern.
2. Patch the skill description or workflow step.
3. Add missing reference detail only if it prevents recurrence.
4. Re-check the harness rules and re-draft the deliverable.
