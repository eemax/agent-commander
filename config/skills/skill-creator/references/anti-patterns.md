# Skill Anti-Patterns (agent-commander)

Use this file to catch the failure modes that make a skill confusing to invoke, misleading in scope, or invalid for harness loading.

## 1) Vague or Overly Broad Description

### Symptom

- The skill reads as relevant for unrelated requests or makes it unclear when the user should invoke it.

### Anti-pattern

- `description` says the skill "helps with skills" or covers too many workflows at once.

### Fix

- Name the source type, the core capability, and the intended use case.
- Keep the use-when guidance narrow enough that the user can tell when to invoke it.

---

## 2) Invalid or Colliding Command Name

### Symptom

- The skill loads, but the derived `/command` is invalid or collides with a core command.

### Anti-pattern

- Picking a name that turns into an invalid command slug.
- Reusing names that map to `/start`, `/new`, `/bash`, `/search`, `/model`, `/auth`, or another existing skill command.

### Fix

- Use lowercase hyphen-case for the folder and `name`.
- Check the derived command form before writing the skill.

---

## 3) Parser-Unsafe Frontmatter Assumptions

### Symptom

- The skill file looks valid to a human, but harness parsing fails or the name/description loads incorrectly.

### Anti-pattern

- Assuming full YAML features are supported.
- Using quoted, multiline, nested, or fancy frontmatter when a plain `key: value` line is enough.

### Fix

- Keep `name` and `description` as plain single-line values.
- Keep frontmatter limited to those two keys.
- Treat the loader as simple and strict, not YAML-complete.

---

## 4) One-Shot Skill Written Like a Persistent Mode

### Symptom

- The skill gives the wrong interaction model and leaks state across turns.

### Anti-pattern

- Writing instructions as if the skill stays active after a single command invocation.

### Fix

- Describe the skill as one-shot and user-invoked.
- Write the body as a short procedural runbook for the current request only.

---

## 5) Unused Resource Directories

### Symptom

- The skill folder is cluttered and it is unclear which files matter.

### Anti-pattern

- Adding `scripts/`, `references/`, or `assets/` because they seem expected, not because the skill needs them.

### Fix

- Add only the directories that carry real work.
- Prefer a minimal folder until repeated logic or dense detail justifies more structure.

---

## 6) Skipped Source Inspection

### Symptom

- The skill invents features, flags, or workflows that are not actually in the source material.

### Anti-pattern

- Writing the skill from memory or a guess before reading the repo, docs site, or brief.

### Fix

- Inspect the source first.
- Derive the core job, inputs, outputs, and constraints from what is actually present.

---

## 7) SKILL.md Too Long

### Symptom

- The skill becomes hard to load and hard to maintain.

### Anti-pattern

- Dumping detailed reference material into the body.

### Fix

- Keep `SKILL.md` procedural and lean.
- Move long or reusable detail into `references/`.
