# ExecPlan Reference (Hardened)

Use this reference for all ExecPlan Mode operations.
This skill is ExecPlan-only.

## 1) Activation Criteria + Trigger Phrase Map

Activate ExecPlan when any condition below is true:

- Work is multi-file, cross-module, migration-heavy, or architecturally significant.
- Work is likely multi-hour or multi-session.
- Work has meaningful blast radius (API, data, security, reliability, or production behavior).
- User asks for planning first.
- User asks for an executable specification.

Direct trigger phrases (case-insensitive) that force ExecPlan:

- `execplan`
- `exec plan`
- `executable spec`
- `executable specification`
- `plans.md`
- `living plan`
- `milestone plan`
- `long-form plan`
- `detailed implementation plan`

If uncertain, default to ExecPlan for safety and traceability.

## 2) Core Requirements (Non-Negotiable)

Every ExecPlan must be:

- **Self-contained**: executable by a newcomer using only this plan + repository.
- **Living**: actively updated as work progresses.
- **Outcome-focused**: proves behavior, not just code changes.
- **Explicit**: includes definitions, assumptions, paths, commands, expected results.
- **Restart-ready**: another contributor can continue from latest state.

Do not rely on hidden context.

## 3) Minimal vs Full ExecPlan Size Policy

Choose plan size before writing.

### Minimal ExecPlan (use when all are true)

- 1–3 files or one narrow subsystem.
- Low-to-moderate ambiguity.
- Limited rollback complexity.
- Expected completion in one concentrated session.

Guidance:

- Keep 2–4 milestones.
- Keep sections concise but complete.
- Still include all required headings.

### Full ExecPlan (default for most complex work)

Use when any are true:

- >3 files or multiple subsystems.
- Migrations, refactors, API/contract changes, or data model impact.
- Significant uncertainty requiring prototypes.
- Multi-session handoff likely.

Guidance:

- Use explicit milestone dependencies.
- Include richer risk and recovery notes.
- Add concrete evidence pointers in Artifacts.

## 4) Required Sections (Exact)

Include and maintain all sections:

1. `# <Short action-oriented title>`
2. `## Purpose / Big Picture`
3. `## Progress`
4. `## Surprises & Discoveries`
5. `## Decision Log`
6. `## Outcomes & Retrospective`
7. `## Context and Orientation`
8. `## Plan of Work`
9. `## Concrete Steps`
10. `## Validation and Acceptance`
11. `## Idempotence and Recovery`
12. `## Artifacts and Notes`
13. `## Interfaces and Dependencies`

Mandatory section behavior:

- `Progress`: timestamped checkboxes reflecting current reality.
- `Surprises & Discoveries`: unexpected findings + short evidence.
- `Decision Log`: important choices + rationale + date/author.
- `Outcomes & Retrospective`: updated at milestone boundaries and completion.
- `Artifacts and Notes`: include the durable note / decision-journal path when the task spans multiple turns, multiple files, or important decisions.

## 5) Writing and Formatting Rules

- Write for a newcomer; define unfamiliar terms at first mention.
- Use exact repository-relative file paths.
- Provide exact commands and working directories (`cwd`).
- State expected observations for commands when relevant.
- Prefer concrete nouns and verbs over vague language.
- Keep Markdown directly reusable as plan artifact.

## 6) Milestone Design Requirements

Each milestone should be independently verifiable and include:

- Goal/scope.
- New capability or artifact after completion.
- Commands to run.
- Evidence expected.
- Risks + rollback note (if applicable).

Use discovery/prototype milestones when uncertainty is high.
If sequencing changes, record it in `Decision Log` and `Progress`.

## 7) Execution Protocol

During implementation:

1. Execute milestones in order unless a logged decision changes order.
2. Continue without generic “what next?” prompts.
3. Pause only for genuine blockers (authorization, prerequisites, critical ambiguity).
4. At each pause or checkpoint, update living sections.
5. Keep risky operations paired with recovery instructions.

## 8) Validation Standard

Completion requires behavior-based evidence:

- Include exact test/run commands.
- Define success signals and failure indicators.
- Include at least one end-to-end observable scenario.
- For internal behavior, provide targeted tests/log evidence.
- Separate `Confirmed`, `Inferred`, and `Unverified` in the final validation summary.

Compilation/lint-only proof is insufficient for completion.

## 9) Quality Checklist (Run Before Returning)

Before returning any ExecPlan (or completion update), verify:

- [ ] Trigger criteria evaluated and ExecPlan size chosen (Minimal/Full) with reason.
- [ ] All required section headings present.
- [ ] `Progress` has timestamps and accurate check-state.
- [ ] `Decision Log` includes major decisions with rationale.
- [ ] `Surprises & Discoveries` reflects real findings or explicitly states none yet.
- [ ] Concrete Steps include exact commands, `cwd`, and expected observations.
- [ ] Validation includes behavior-based acceptance, not only static checks.
- [ ] Final validation summary separates `Confirmed`, `Inferred`, and `Unverified`.
- [ ] Idempotence/recovery is documented for risky steps.
- [ ] Plan is restart-ready for a new contributor.

## 10) Hardened ExecPlan Skeleton

# <Short, action-oriented description>

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current throughout execution.

Plan size: **<Minimal|Full>**
Reason: <one sentence>

## Purpose / Big Picture

<What user can do after this change and how to observe it.>

## Progress

- [x] (YYYY-MM-DD HH:MMZ) <Completed item>
- [ ] (YYYY-MM-DD HH:MMZ) <Planned item>
- [ ] (YYYY-MM-DD HH:MMZ) <Partial item (done: ...; remaining: ...)> 

## Surprises & Discoveries

- Observation: <Unexpected behavior or insight>
  Evidence: <short command output / file reference / test signal>

## Decision Log

- Decision: <What was chosen>
  Rationale: <Why>
  Date/Author: <YYYY-MM-DD, agent/user>

## Outcomes & Retrospective

<Current outcomes, remaining gaps, and lessons at this stage.>

## Context and Orientation

<Relevant code layout, terminology definitions, and current baseline state.>

## Plan of Work

<Milestone narrative with dependency notes and changed paths.>

## Concrete Steps

- (cwd: `<path>`) `<command>`
  - Expect: <key output/behavior>

## Validation and Acceptance

<Behavior-based checks, acceptance gates, and end-to-end scenario(s). End the section with `Confirmed`, `Inferred`, and `Unverified`.>

## Idempotence and Recovery

<Safe re-run guidance, rollback paths, and failure containment.>

## Artifacts and Notes

<Concise evidence snippets proving progress and correctness. Include the durable note / decision-journal path when required.>

## Interfaces and Dependencies

<Interfaces/contracts/libraries touched and expected signatures.>
