---
name: skill-creator
description: Create, improve, fix or test skills in the Agent Skills format (agentskills.io). Use this skill when the user asks for a new skill or to change one, says "make this repeatable" or "next time, do it like this" about a procedure, or when you just finished a multi-step task you would otherwise have to work out again (a deploy, a report, a recovery). Not for single facts or preferences, which go in memory.
---

# Creating a skill

A skill teaches a future you a procedure it would otherwise get wrong or have to work out
again. When choosing a skill you see only its name and description; the body is read when the
skill is picked; files in `references/`, `scripts/` and `assets/` only when the body says so.
Write for that order. The format is the open Agent Skills standard
(https://agentskills.io/specification), so the skill also works in Claude Code, Codex and
other agents.

## 1. Decide it should be a skill

- **A procedure, not a fact.** "The user's timezone is CET" belongs in MEMORY.md. "How to rotate the
  API key and redeploy" is a skill.
- **Not one already.** Check `<available_skills>`. Improve your own skill rather than adding a
  near-duplicate. Box skills (in the box's `skills.d/`) are read-only: a workspace skill of the
  same name overrides one and hides its future updates, so do that only on purpose, and tell
  the user.
- **One coherent job.** "Query the database and format the results" is one skill; adding
  database administration makes it two. Too broad won't trigger precisely, too narrow means
  several skills for one task.
- **Real material.** Build it from what actually happened: the commands that worked, the
  errors you hit, the corrections the user made, the runbooks, configs and repo docs involved.
  Generic advice ("handle errors appropriately") is worth nothing.

## 2. Name the folder

`skills/<name>/` in the workspace, with `<name>`: 1-64 characters, lowercase letters, digits
and single hyphens, not at the start or end (`deploy-app`; not `Deploy_App`, `-x` or `a--b`).
The `name` field must equal the folder name. Telegram offers it as `/<name>` with hyphens as
underscores, cut at 32 characters, and acmd's own commands (`/new`, `/status`, …) are taken.

## 3. Write the frontmatter

```
---
name: deploy-app
description: Build, test and deploy the app to production, and roll it back. Use this skill when the user asks to ship, release, deploy or roll back the app, or when a change is ready to go live, even if they only say "push it out". Not for local test runs.
---
```

- `name` and `description` are required. The description is all you will see when deciding,
  so it carries the triggering: say what it does and when to use it, phrased as "Use this
  skill when…", in terms of what the user wants rather than how it's done. Lean towards
  triggering: include the ways people ask without naming the topic. Say what it is *not* for
  when a neighbouring task could be confused with it. A few sentences, at most 1024 characters.
  "Helps with deploys." is useless.
- Quote a value that contains `: ` (`description: "Use when: …"`), or the YAML breaks.
- Optional: `license`, `compatibility` (at most 500 characters, only for real requirements:
  "Needs uv and network access"), `metadata` (text values, e.g. `version: "1.0"`). No other
  fields.

## 4. Write the body

Instructions to a capable colleague who knows the tools but not this job:

- **Add what you'd lack, leave out what you know.** For each line ask: would I get this wrong
  without it? If not, cut it. No explaining what HTTP or git is.
- **Steps with exact commands**, in order, with one default way to do each (not a menu of
  options). Be exact where it's fragile ("run exactly `scripts/migrate.sh --verify`"); where
  judgment is needed, say what to weigh and why instead of ALWAYS/NEVER rules.
- **A `## Gotchas` section**: facts about this environment that defy reasonable assumptions
  (the health endpoint says 200 while the database is down; files copied in need a `chown`).
  Often the most valuable part. Keep it in SKILL.md, not in a reference.
- **A check at the end**, and a loop for anything that can fail: do it, verify, fix, verify
  again; go on only when it passes.
- **An output template** when the result's shape matters (a report, a message, a file).
- **Keep it short:** the whole file is read each time. The standard's limit is 500 lines and
  about 5,000 tokens; most good skills are well under 150 lines. Move long material into
  `references/<topic>.md` (focused files, linked one level deep from SKILL.md) and say when to
  read each: "Read `references/errors.md` if the API returns anything but 200", not "see
  references/".
- **Scripts** (`scripts/`) for logic you would otherwise retype each time. Read
  [references/scripts.md](references/scripts.md) before writing one. List them in the body
  with the exact command to run each.
- Paths inside the skill are relative to its folder (`references/x.md`, `scripts/check.sh`).

## 5. Check it

1. `head -8 skills/<name>/SKILL.md`: the frontmatter is there; the name equals the folder.
2. `acmd status`: the `workspace` check lists anything that breaks the standard.
3. Run every script: `--help` and one real run.
4. Triggering: write 5 requests that should use the skill (different wordings, some that
   don't name the topic) and 3 near-misses that shouldn't. Read the description against each
   and tighten it until it would pick right.
5. Follow the skill once on a real or realistic task, step by step as written, and fix
   whatever you had to guess.

For a skill that matters (used often, or costly when wrong), do the fuller evaluation in
[references/testing.md](references/testing.md).

Then tell the user the skill exists, that it works from the next conversation (/new), and give
two or three requests to try it with.

## Improving a skill

- When it misfired, look at what you actually did (the commands in the conversation) and fix
  the instruction that was ambiguous or missing. Fix the general cause, not this one case.
- When it wasn't picked, or picked wrongly, fix the description by finding the category of
  request it missed. Don't paste the failed request's words in.
- When the user corrects you while you follow a skill, add the correction to its Gotchas.
- Remove instructions that turned out not to matter. Fewer, better instructions beat more.
