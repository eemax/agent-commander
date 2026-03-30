# ExecPlan Examples (ExecPlan Mode)

Use these templates to format ExecPlan responses.
This skill is ExecPlan-only.

## Example 1: Minimal ExecPlan

### Scenario

Add a request ID to API error responses in one service module and corresponding tests.

### ExecPlan Response (Abbreviated)

# Add request IDs to API error responses

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current throughout execution.
In every completion-oriented validation summary, separate `Confirmed`, `Inferred`, and `Unverified`.

Plan size: **Minimal**
Reason: Single subsystem, limited files, low ambiguity.

## Purpose / Big Picture

After this change, clients can correlate any API error with server logs using `requestId` returned in error payloads.

## Progress

- [x] (2026-03-24 16:05Z) Located error serializer and current API error tests.
- [ ] (2026-03-24 16:05Z) Add `requestId` to error payload serializer.
- [ ] (2026-03-24 16:05Z) Update tests and validate behavior.

## Surprises & Discoveries

- Observation: one legacy route bypasses shared serializer.
  Evidence: `src/api/routes/legacy.ts` builds error payload inline.

## Decision Log

- Decision: patch shared serializer now and create follow-up task for legacy route unification.
  Rationale: delivers user-visible value with low-risk scope.
  Date/Author: 2026-03-24, agent

## Outcomes & Retrospective

Initial analysis complete; implementation pending.

## Context and Orientation

`src/api/errors/serialize.ts` builds normalized error responses. `src/api/errors/serialize.test.ts` validates payload shape.

## Plan of Work

Milestone 1: update serializer output contract and route context plumbing.
Milestone 2: update tests and verify one end-to-end failing request path.

## Concrete Steps

- (cwd: `repo-root`) `npm test -- src/api/errors/serialize.test.ts`
  - Expect: current baseline tests pass before edits.
- (cwd: `repo-root`) `npm run test:api -- --grep "error payload"`
  - Expect: route-level error payload checks pass with new `requestId` field.

## Validation and Acceptance

Trigger a known failing API request and confirm JSON error includes `requestId`. Verify same ID appears in server logs for that request.

## Idempotence and Recovery

Code-only change; safe to re-run tests repeatedly. If regression appears, revert serializer commit and restore previous payload contract.

## Artifacts and Notes

Add sample failing request/response pair and one log line showing matching `requestId`.

## Interfaces and Dependencies

No new external dependencies. Internal contract update: `serializeError(ctx)` returns `{ code, message, requestId }`.

---

## Example 2: Full ExecPlan

### Scenario

Implement audit logging across API write endpoints with searchable admin UI.

### ExecPlan Response (Abbreviated)

# Add end-to-end audit logging with admin query interface

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current throughout execution.
In every completion-oriented validation summary, separate `Confirmed`, `Inferred`, and `Unverified`.

Plan size: **Full**
Reason: Multi-subsystem change (API, storage, UI), moderate uncertainty, multi-session risk.

## Purpose / Big Picture

Administrators can inspect who changed critical records, what changed, and when, then filter results in the admin UI.

## Progress

- [x] (2026-03-24 15:10Z) Identified write paths and middleware hooks.
- [ ] (2026-03-24 15:10Z) Add audit event schema and storage.
- [ ] (2026-03-24 15:10Z) Instrument write endpoints/services.
- [ ] (2026-03-24 15:10Z) Add admin query API.
- [ ] (2026-03-24 15:10Z) Build UI table + filters.
- [ ] (2026-03-24 15:10Z) Validate end-to-end and regressions.

## Surprises & Discoveries

- Observation: bulk update endpoint bypasses shared mutation service.
  Evidence: `src/api/routes/bulkUpdate.ts` writes directly via repository.

## Decision Log

- Decision: instrument service-layer writes plus direct-write route.
  Rationale: complete coverage now without blocking on architecture refactor.
  Date/Author: 2026-03-24, agent

## Outcomes & Retrospective

Pending completion; risk of missing write-path coverage reduced during analysis.

## Context and Orientation

`src/api/routes/*.ts` handles HTTP entry points. `src/services/entityService.ts` contains most mutation logic. `src/admin/pages/AuditLog.tsx` is target UI. “Audit event” = immutable metadata for a mutation (actor, action, target, diff, timestamp).

## Plan of Work

Milestone 1: storage model + migration.
Milestone 2: write-path instrumentation.
Milestone 3: admin query API.
Milestone 4: admin UI.
Milestone 5: validation + docs.

## Concrete Steps

- (cwd: `repo-root`) `npm run test:api`
  - Expect: pre-change API suite baseline passes.
- (cwd: `repo-root`) `npm run test:ui`
  - Expect: pre-change UI suite baseline passes.

## Validation and Acceptance

Create/update entity as admin and confirm matching audit row appears in UI with actor, action, target, and timestamp. Filter by target ID/time range and confirm deterministic results. Run API+UI tests: new audit assertions fail before implementation and pass after.

## Idempotence and Recovery

Audit schema migration is additive and re-runnable via migration tracking. If UI rollout lags, backend collection remains active and non-breaking.

## Artifacts and Notes

Include migration output, passing tests, and one sample `GET /admin/audit` response payload.

## Interfaces and Dependencies

Add `recordAuditEvent(event: AuditEventInput): Promise<void>` in `src/audit/store.ts`. Add `GET /admin/audit` with `actorId`, `entityId`, `from`, `to`, `limit`, `cursor`.
