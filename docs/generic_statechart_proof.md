# Generic Statechart Proof

**Bead:** pi-experiment-generic-statechart-proof (P1)  
**Date:** 2026-06-02  
**Proof artifact:** `tests/generic_statechart_proof.test.ts` (58 test cases, 0 src/ changes)

---

## What this proves

The pi-experiment harness already routes any arbitrary YAML-defined workflow with
**zero source-code changes**. State names, outcome vocabulary, event taxonomy,
terminal states, scheduler priority, skill resolution, and gate mechanics are all
derived solely from the `harness.yaml` config at runtime.

---

## Proof scenario

A fully non-SDLC **incident-management** workflow is used as the counterexample domain:

| Dimension        | SDLC (production harness.yaml)                     | Custom (proof fixture)                          |
|------------------|----------------------------------------------------|-------------------------------------------------|
| State names      | Planning → AdversarialPreReview → Implementation → AdversarialPostReview → completed | Intake → Triage → Resolve → archived |
| Advance outcome  | SUCCESS                                            | PROMOTE                                         |
| Failed outcome   | FAILURE                                            | RETURN                                          |
| Blocked outcome  | BLOCKED                                            | PARK                                            |
| Terminal state   | completed                                          | archived                                        |
| Custom events    | (none)                                             | DOMAIN_AUDIT                                    |
| Custom skills    | planner, reviewer, implementer                     | intake-classifier, incident-resolver, audit-trail |

No file in `src/` was modified to make this work.

---

## Acceptance criteria satisfied

### AC-1: ConfigLoader accepts and validates the custom config

`ConfigLoader.load()` loads the incident YAML without error. `validateSemantics()`
confirms that all transition targets are declared states or the configured terminal
(`archived`). Mis-configured targets (pointing to an undeclared state) throw the
expected validation error.

### AC-2: FlowManager routing is purely YAML-driven

- `isTerminalState('archived', cfg)` → `true`; `isTerminalState('completed', cfg)` → `false` (custom terminal overrides hard-coded default)
- `outcomeCategory('PROMOTE')` → `'advance'`; `('RETURN')` → `'failed'`; `('PARK')` → `'blocked'`
- `isAdvanceOutcome('PROMOTE')` → `true`; `('RETURN')`, `('PARK')` → `false`
- `FlowManager.nextState` follows every edge in the YAML transitions map:
  - Intake + PROMOTE → Triage
  - Triage + PROMOTE → Resolve
  - Resolve + PROMOTE → archived
  - Resolve + RETURN → Triage (back-routing)
  - Intake/Triage + PARK → archived (early termination)
- `FlowManager.initialState(cfg)` returns `'Intake'` (no hard-coded SDLC default)
- The terminal + advance combination `isTerminalState('archived') && isAdvanceOutcome('PROMOTE')` evaluates to `true`, correctly firing the merge-gate trigger

### AC-3: Gate mechanics fire for custom advance outcome PROMOTE

`isAdvanceOutcome('PROMOTE', cfg)` is `true`, meaning the completion-gate check
in extension.ts (`if (isAdvanceOutcome(outcome, config))`) evaluates to true on
a PROMOTE signal — not just on SUCCESS.

Checklist gate simulation on the `Resolve` state:
- With no recorded ticks: `missingMandatoryChecklistItems` returns `['Root cause identified', 'Fix applied and verified']` — gate blocks.
- With both mandatory items ticked: returns `[]` — gate passes.
- Optional `'Post-mortem documented'` never blocks regardless of whether it is ticked.

### AC-4 (GOLDEN): real harness.yaml /micromanage routing is unchanged

The production `harness.yaml` is loaded by `ConfigLoader` (no path override) and
asserted to be byte-identical to its pre-genericization behaviour:

- `terminalStates: ['completed']`, `advanceOutcomes: ['SUCCESS']`, `failedOutcomes: ['FAILURE']`, `blockedOutcomes: ['BLOCKED']`
- `startState: Planning` / `FlowManager.initialState()` returns `'Planning'`
- `AdversarialPostReview + SUCCESS → completed` (the key production merge path)
- `isTerminalState('completed') && isAdvanceOutcome('SUCCESS')` → `true` (merge fires)
- `Planning + SUCCESS → AdversarialPreReview`, `Implementation + SUCCESS → AdversarialPostReview`
- `outcomeCategory(SUCCESS/FAILURE/BLOCKED)` returns `advance/failed/blocked` (identical to old literals)

### AC-5: Scheduler priority scores from custom graph

`Scheduler.sortBacklog()` seeds its BFS from `config.statechart.terminalStates`
(`['archived']`). For the custom graph (linear chain Intake→Triage→Resolve→archived):
- All three states receive a non-zero score.
- `Resolve` (BFS distance 1) scores higher than `Intake` (distance 2+), confirming progress-weighted priority.
- If terminal detection were hard-coded to `'completed'`, BFS would find no reachable nodes and all scores would be 0. Positive scores prove YAML-driven routing.

### AC-6: Custom event taxonomy (DOMAIN_AUDIT)

`validateTeammateEvent(event, config.statechart.customEvents)`:
- Accepts a `DOMAIN_AUDIT` event when the array `['DOMAIN_AUDIT']` is passed.
- Accepts via `Set<string>` overload as well.
- Rejects an undeclared event `COMPLIANCE_SCAN` with `'Invalid event type'`.
- Rejects `DOMAIN_AUDIT` when no `allowedCustomEvents` argument is provided (backward-compat: enum-only mode).

### AC-7: Skill resolution keyed on arbitrary stateId — no role inference

`resolvePiSkillPathsForState(cfg, root, stateId)`:
- `Resolve` with `skills: ['incident-resolver']` resolves to exactly one skill — not `planner`/`reviewer`/`implementer` even when those directories exist.
- `Intake` with `skills: ['intake-classifier', 'audit-trail']` resolves both in declared order.
- Each state gets only its own skills; no cross-state contamination.

### AC-8: Full state-machine walk Intake→Triage→Resolve→archived

A complete simulated coordinator walk through the happy path:
1. `FlowManager.initialState(cfg)` → `Intake`
2. `Intake + PROMOTE` → `Triage` (not terminal)
3. `Triage + PROMOTE` → `Resolve` (not terminal)
4. `Resolve + PROMOTE` → `archived` (terminal — workflow done)

Retry path: `Resolve + RETURN` → `Triage`, then `Triage + PROMOTE` → `Resolve`, then `Resolve + PROMOTE` → `archived`.

Blocked path: `Triage + PARK` → `archived` (terminal via blocked outcome).

**No SDLC literal** (`Planning`, `Implementation`, `SUCCESS`, `completed`, etc.) appears anywhere in the walk. The walk is driven entirely by the YAML fixture.

---

## The metric

> **A complete non-SDLC workflow (incident management, 3 non-trivial states, 3 custom outcomes, 1 custom event) routes end-to-end with 0 code edits to `src/`.**

---

## No src/ changes required

The following modules were confirmed to contain no hard-coded SDLC state names or
role literals in their routing/identity logic (enforced by the existing regression
guard at `tests/generic_identity.test.ts`):

- `src/core/FlowManager.ts`
- `src/core/Scheduler.ts`
- `src/core/BeadStateProjection.ts`
- `src/core/PiIntegration.ts`
- `src/extension/CoordinatorController.ts`
- `src/extension/WorkerRunController.ts`

The proof file (`tests/generic_statechart_proof.test.ts`) was the only file added.
No `src/` file was touched. This is the genericity claim: the harness was already
generic before this bead ran.

---

## Reproducibility

```
npx tsc --noEmit   # must exit 0
npx vitest run     # must pass all 54 test files including generic_statechart_proof
```

Both commands pass with 0 errors (54 test files, 1061 tests as of this proof run).
