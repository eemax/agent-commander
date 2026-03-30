# ExecPlan Mode Workflow

This workflow is ExecPlan-only.
Use it for all non-trivial planning and execution handled by this skill.

## 1) Decide Whether to Enter ExecPlan Mode

Enter ExecPlan mode when any are true:

- Task requires edits across multiple files or directories.
- Task includes architecture/design tradeoffs or unclear implementation direction.
- Task includes refactoring, migrations, or backward-compatibility risk.
- Task has high blast radius (build, data, API, security, or production behavior impact).
- User explicitly asks for a plan first.
- User requests an ExecPlan/executable spec/PLANS.md-style workflow.

Skip this skill for simple single-step, low-risk requests.

## 2) Pre-Execution Analysis

Before implementation, produce a planning pass:

1. Restate objective in one concise paragraph.
2. List files/components to inspect.
3. List files/components likely to modify.
4. Build ordered milestones with dependencies.
5. Identify risk points and rollback requirements.
6. Choose Minimal vs Full ExecPlan (per `exec-plan.md` size policy).
7. If the task is likely multi-turn, multi-file, or decision-heavy, create a durable note in `notes/` up front.

Do not begin edits until the initial ExecPlan is written.

## 3) Build the Initial ExecPlan

Use `references/exec-plan.md` as strict template.

Must include all required sections and be self-contained:

- Define terms.
- Name exact repo-relative paths.
- Provide exact commands, working directories, and expected observations.
- State behavior-based acceptance criteria.

## 4) Execute by Milestone

1. Announce current milestone.
2. Execute concrete steps.
3. Capture evidence.
4. Update living sections:
   - Progress
   - Surprises & Discoveries
   - Decision Log
   - Outcomes & Retrospective
   - durable note / decision journal in `notes/`
5. Move to next milestone unless blocked.

Do not ask generic “what next?” questions mid-flow.

## 5) Pause / Blocker Protocol

Pause only for:

- required authorization,
- missing prerequisites,
- or critical ambiguity that materially changes scope/risk.

When paused, report:

1. What is blocked.
2. Why autonomous continuation is unsafe.
3. Minimal options to unblock.
4. Exact ExecPlan updates made before pausing.

## 6) Change-of-Plan Protocol

When implementation deviates from original path:

1. Record decision and rationale in `Decision Log`.
2. Update remaining milestones and dependencies.
3. Reflect state in `Progress`.
4. Add any unexpected findings to `Surprises & Discoveries`.

## 7) Validation and Completion

Before marking complete:

1. Run behavior-based validation commands.
2. Compare observed behavior to acceptance criteria.
3. Run the quality checklist from `exec-plan.md`.
4. Update `Outcomes & Retrospective` with what shipped, what remains, and known risks.
5. End the validation summary with `Confirmed`, `Inferred`, and `Unverified`.
6. Leave plan restart-ready for another contributor.
