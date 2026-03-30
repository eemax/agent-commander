---
name: execplan-mode
description: ExecPlan-first planning and execution for complex, multi-step work. Use when requests involve architectural decisions, refactoring, migrations, multi-file edits, cross-module dependencies, long-running implementation, or non-trivial risk. Produces a self-contained living ExecPlan with milestones, Decision Log, Surprises & Discoveries, Outcomes & Retrospective, and evidence-based validation.
---

# ExecPlan Mode

## Overview

Use this skill to run complex work through a strict **ExecPlan** workflow.

This skill no longer supports hierarchical option gating (`1A`, `2B`, etc.).
All planning and execution should follow the ExecPlan protocol in the references.

## Load References

1. Read `references/workflow.md` before producing the plan.
2. Read `references/exec-plan.md` for strict template, trigger map, size policy, and quality bar.
3. Read `references/examples.md` for formatting patterns.

## Execute the ExecPlan Flow

1. Detect activation using the trigger map in `references/exec-plan.md`.
2. Choose **Minimal** vs **Full** ExecPlan using the size policy.
3. Build a self-contained executable plan with exact paths, commands, and expected observations.
4. Structure work into independently verifiable milestones.
5. Keep required living sections current at every meaningful pause:
   - `Progress`
   - `Surprises & Discoveries`
   - `Decision Log`
   - `Outcomes & Retrospective`
   - durable notes in `notes/` when the task spans multiple turns or important decisions
6. Execute milestone-to-milestone without generic “what next?” prompts.
7. Pause only for true blockers (authorization needs, missing prerequisites, or critical ambiguity).
8. Before reporting completion, run the quality checklist, provide behavior-based evidence, and separate `Confirmed`, `Inferred`, and `Unverified`.

## Non-Negotiable Rules

- Do not rely on unstated prior context; plan must be self-contained.
- Do not claim completion without observable behavioral validation.
- Resolve non-critical ambiguities autonomously and log rationale in `Decision Log`.
- Record all significant deviations from plan in `Decision Log` and reflect them in `Progress`.
- Keep the plan restart-ready so a new contributor can continue safely.
- For multi-turn or multi-file work, keep a concise decision journal in `notes/` and reference its path in `Artifacts and Notes`.

## Output Contract

Follow `references/exec-plan.md` exactly.
Every plan response must include:

1. `Purpose / Big Picture`
2. `Progress`
3. `Surprises & Discoveries`
4. `Decision Log`
5. `Outcomes & Retrospective`
6. `Context and Orientation`
7. `Plan of Work`
8. `Concrete Steps`
9. `Validation and Acceptance`
10. `Idempotence and Recovery`
11. `Artifacts and Notes`
12. `Interfaces and Dependencies`

Use `references/workflow.md` as operational procedure.
Use `references/examples.md` as response patterns.
Use `references/exec-plan.md` as strict formatting and quality requirements.
