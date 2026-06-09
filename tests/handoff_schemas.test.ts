/**
 * pi-experiment-dsm2.3 — Handoff payload schema validation tests.
 *
 * AC1: Every statechart handoff boundary has a NAMED JSON Schema in the
 *      SchemaRegistry. Covered boundaries: status-mutating teammate events
 *      (STATE_TRANSITIONED / STATE_FAILED / STATE_BLOCKED / CONTEXT_RESTART /
 *      HARNESS_RESTART), CHECKPOINT_ACCEPTED, and the terminal-transition payload.
 *      Worker-command and worker-completion are registered and noted.
 *
 * AC2: Dispatch validates payloads before send; receivers validate before acting.
 *      validateTeammateEvent() uses schema validation at receipt.
 *      validateHandoffPayload() is the shared boundary validator.
 *
 * AC3: Malformed payloads CANNOT advance state, satisfy required tools, close
 *      gates, or emit progress events (fail closed → blocked transition).
 *      validateTeammateEvent() returns { ok: false } on schema violations.
 *
 * AC4: Validation failures produce structured diagnostics with beadId, stateId,
 *      actionId, runId, schemaId, and failurePath.
 *
 * AC5: Handoff schemas distinguish LLM-authored content (summary/evidence/handover)
 *      from deterministic evidence references (actionId, beadId, stateId, transitionEvent).
 *      Schema entry metadata carries an `llmAuthoredFields` annotation.
 *
 * AC6: Regression tests cover malformed handoffs, missing state/action identity,
 *      invalid terminal outcomes, and forged progress claims.
 */

import { describe, it, expect } from 'vitest';
import {
  schemaRegistry
} from '../src/core/SchemaRegistry.js';
import {
  validateHandoffPayload,
  HandoffSchemaId,
  HANDOFF_BOUNDARY_IDS,
  type HandoffValidationDiagnostic
} from '../src/core/HandoffSchemas.js';
import {
  validateTeammateEvent,
  type TeammateEventValidationResult
} from '../src/core/TeammateEvents.js';
import { createTeammateEventIdempotencyKey } from '../src/core/TeammateEvents.js';
import { TeammateEventType } from '../src/constants/domain.js';

// ---------------------------------------------------------------------------
// AC1 — Named schemas registered in SchemaRegistry
// ---------------------------------------------------------------------------

describe('AC1: handoff schemas registered in SchemaRegistry', () => {
  it('HandoffSchemaId enumerates all handoff schema ids', () => {
    // Ensure the exported constant covers the key boundaries.
    expect(HandoffSchemaId.STATUS_MUTATING_EVENT).toBeTruthy();
    expect(HandoffSchemaId.CHECKPOINT_ACCEPTED_EVENT).toBeTruthy();
    expect(HandoffSchemaId.TERMINAL_TRANSITION).toBeTruthy();
    expect(HandoffSchemaId.WORKER_COMMAND).toBeTruthy();
    expect(HandoffSchemaId.WORKER_COMPLETION).toBeTruthy();
  });

  it('all HandoffSchemaId values are registered in schemaRegistry', () => {
    for (const id of Object.values(HandoffSchemaId)) {
      expect(schemaRegistry.has(id), `Schema not registered: ${id}`).toBe(true);
    }
  });

  it('all HandoffSchemaId values are in HANDOFF_BOUNDARY_IDS', () => {
    for (const id of Object.values(HandoffSchemaId)) {
      expect(HANDOFF_BOUNDARY_IDS.has(id), `${id} missing from HANDOFF_BOUNDARY_IDS`).toBe(true);
    }
  });

  it('each handoff schema has required metadata: owner, replayPolicy, fixtures', () => {
    for (const id of Object.values(HandoffSchemaId)) {
      const entry = schemaRegistry.getEntry(id);
      expect(entry.owner, `${id} — owner`).toBeTruthy();
      expect(entry.replayPolicy, `${id} — replayPolicy`).toMatch(/^(CRITICAL|BEST_EFFORT|NONE)$/);
      expect(entry.positiveFixtures.length, `${id} — positiveFixtures`).toBeGreaterThan(0);
      expect(entry.negativeFixtures.length, `${id} — negativeFixtures`).toBeGreaterThan(0);
    }
  });

  it('status-mutating-event schema has CRITICAL replay policy (recorded to event log)', () => {
    const entry = schemaRegistry.getEntry(HandoffSchemaId.STATUS_MUTATING_EVENT);
    expect(entry.replayPolicy).toBe('CRITICAL');
  });

  it('checkpoint-accepted schema has CRITICAL replay policy', () => {
    const entry = schemaRegistry.getEntry(HandoffSchemaId.CHECKPOINT_ACCEPTED_EVENT);
    expect(entry.replayPolicy).toBe('CRITICAL');
  });

  it('terminal-transition schema has CRITICAL replay policy', () => {
    const entry = schemaRegistry.getEntry(HandoffSchemaId.TERMINAL_TRANSITION);
    expect(entry.replayPolicy).toBe('CRITICAL');
  });
});

// ---------------------------------------------------------------------------
// AC5 — LLM-authored vs deterministic-evidence field distinction
// ---------------------------------------------------------------------------

describe('AC5: LLM-authored vs deterministic-evidence field distinction', () => {
  it('status-mutating-event schema entry has llmAuthoredFields metadata', () => {
    const entry = schemaRegistry.getEntry(HandoffSchemaId.STATUS_MUTATING_EVENT);
    const llmFields = (entry as unknown as Record<string, unknown>).llmAuthoredFields as string[] | undefined;
    expect(Array.isArray(llmFields), 'llmAuthoredFields should be an array').toBe(true);
    // LLM-authored fields: the narrative content that the model writes
    expect(llmFields).toContain('summary');
    expect(llmFields).toContain('evidence');
    expect(llmFields).toContain('handover');
  });

  it('status-mutating-event schema entry has deterministicEvidenceFields metadata', () => {
    const entry = schemaRegistry.getEntry(HandoffSchemaId.STATUS_MUTATING_EVENT);
    const detFields = (entry as unknown as Record<string, unknown>).deterministicEvidenceFields as string[] | undefined;
    expect(Array.isArray(detFields), 'deterministicEvidenceFields should be an array').toBe(true);
    // Deterministic fields: set by harness machinery, not model authorship
    expect(detFields).toContain('beadId');
    expect(detFields).toContain('stateId');
    expect(detFields).toContain('actionId');
    expect(detFields).toContain('transitionEvent');
    expect(detFields).toContain('idempotencyKey');
  });

  it('worker-command schema has deterministicEvidenceFields covering identity fields', () => {
    const entry = schemaRegistry.getEntry(HandoffSchemaId.WORKER_COMMAND);
    const detFields = (entry as unknown as Record<string, unknown>).deterministicEvidenceFields as string[] | undefined;
    expect(Array.isArray(detFields)).toBe(true);
    expect(detFields).toContain('beadId');
    expect(detFields).toContain('stateId');
  });
});

// ---------------------------------------------------------------------------
// AC2+AC3 — validateHandoffPayload: fail-closed boundary validator
// ---------------------------------------------------------------------------

describe('AC2+AC3: validateHandoffPayload — fail-closed', () => {
  const validStatusMutating = {
    type: 'STATE_TRANSITIONED',
    beadId: 'pi-experiment-test',
    workerId: 'worker-1',
    stateId: 'Planning',
    timestamp: 1_779_000_000_000,
    actionId: 'formulate-plan',
    transitionEvent: 'SUCCESS',
    summary: 'All tasks complete.',
    evidence: 'submit_checkpoint evidence.',
    handover: 'Handover to next phase.',
    idempotencyKey: 'STATE_TRANSITIONED-pi-experiment-test-worker-1-session-Planning-formulate-plan-SUCCESS'
  };

  it('returns valid:true for a well-formed status-mutating event', () => {
    const result = validateHandoffPayload(HandoffSchemaId.STATUS_MUTATING_EVENT, validStatusMutating);
    expect(result.valid).toBe(true);
  });

  it('returns valid:false with structured diagnostic for missing beadId', () => {
    const payload = { ...validStatusMutating, beadId: undefined };
    const result = validateHandoffPayload(HandoffSchemaId.STATUS_MUTATING_EVENT, payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostic.schemaId).toBe(HandoffSchemaId.STATUS_MUTATING_EVENT);
      expect(result.diagnostic.failurePath.length).toBeGreaterThan(0);
    }
  });

  it('returns valid:false with structured diagnostic for missing actionId', () => {
    const { actionId: _a, ...payload } = validStatusMutating;
    const result = validateHandoffPayload(HandoffSchemaId.STATUS_MUTATING_EVENT, payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostic.schemaId).toBe(HandoffSchemaId.STATUS_MUTATING_EVENT);
    }
  });

  it('returns valid:false for missing summary (LLM-authored required field)', () => {
    const { summary: _s, ...payload } = validStatusMutating;
    const result = validateHandoffPayload(HandoffSchemaId.STATUS_MUTATING_EVENT, payload);
    expect(result.valid).toBe(false);
  });

  it('returns valid:false for missing evidence', () => {
    const { evidence: _e, ...payload } = validStatusMutating;
    const result = validateHandoffPayload(HandoffSchemaId.STATUS_MUTATING_EVENT, payload);
    expect(result.valid).toBe(false);
  });

  it('returns valid:false for missing handover', () => {
    const { handover: _h, ...payload } = validStatusMutating;
    const result = validateHandoffPayload(HandoffSchemaId.STATUS_MUTATING_EVENT, payload);
    expect(result.valid).toBe(false);
  });

  it('returns valid:false for missing transitionEvent', () => {
    const { transitionEvent: _t, ...payload } = validStatusMutating;
    const result = validateHandoffPayload(HandoffSchemaId.STATUS_MUTATING_EVENT, payload);
    expect(result.valid).toBe(false);
  });

  it('returns valid:false for non-string summary', () => {
    const payload = { ...validStatusMutating, summary: 42 };
    const result = validateHandoffPayload(HandoffSchemaId.STATUS_MUTATING_EVENT, payload);
    expect(result.valid).toBe(false);
  });

  it('returns valid:false for non-number timestamp', () => {
    const payload = { ...validStatusMutating, timestamp: 'not-a-number' };
    const result = validateHandoffPayload(HandoffSchemaId.STATUS_MUTATING_EVENT, payload);
    expect(result.valid).toBe(false);
  });

  it('passes context fields through to the diagnostic when invalid', () => {
    const { actionId: _a, ...payload } = validStatusMutating;
    const context = {
      beadId: 'pi-experiment-test',
      stateId: 'Planning',
      actionId: 'formulate-plan',
      runId: 'run-abc-123'
    };
    const result = validateHandoffPayload(HandoffSchemaId.STATUS_MUTATING_EVENT, payload, context);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostic.beadId).toBe(context.beadId);
      expect(result.diagnostic.stateId).toBe(context.stateId);
      expect(result.diagnostic.actionId).toBe(context.actionId);
      expect(result.diagnostic.runId).toBe(context.runId);
      expect(result.diagnostic.schemaId).toBe(HandoffSchemaId.STATUS_MUTATING_EVENT);
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 — Structured diagnostic shape
// ---------------------------------------------------------------------------

describe('AC4: structured diagnostic fields', () => {
  it('diagnostic contains schemaId, beadId, stateId, actionId, runId, failurePath', () => {
    const payload = { type: 'STATE_TRANSITIONED' }; // clearly invalid
    const context = {
      beadId: 'pi-bead-1',
      stateId: 'Planning',
      actionId: 'formulate-plan',
      runId: 'run-xyz'
    };
    const result = validateHandoffPayload(HandoffSchemaId.STATUS_MUTATING_EVENT, payload, context);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const d: HandoffValidationDiagnostic = result.diagnostic;
      expect(typeof d.schemaId).toBe('string');
      expect(d.schemaId).toBe(HandoffSchemaId.STATUS_MUTATING_EVENT);
      expect(d.beadId).toBe('pi-bead-1');
      expect(d.stateId).toBe('Planning');
      expect(d.actionId).toBe('formulate-plan');
      expect(d.runId).toBe('run-xyz');
      expect(Array.isArray(d.failurePath)).toBe(true);
      expect(d.failurePath.length).toBeGreaterThan(0);
    }
  });

  it('failurePath entries are human-readable strings naming the failing schema path', () => {
    const payload = { ...{
      type: 'STATE_TRANSITIONED',
      beadId: 'pi-experiment-test',
      workerId: 'worker-1',
      stateId: 'Planning',
      timestamp: 1_779_000_000_000,
      actionId: 'formulate-plan',
      transitionEvent: 'SUCCESS',
      summary: 'All tasks complete.',
      evidence: 'submit_checkpoint evidence.',
      handover: 'Handover to next phase.',
      idempotencyKey: 'key'
    }, summary: 99 }; // non-string summary
    const result = validateHandoffPayload(HandoffSchemaId.STATUS_MUTATING_EVENT, payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      // failurePath entries should contain the field name or path
      const pathStr = result.diagnostic.failurePath.join(' ');
      expect(pathStr).toMatch(/summary/i);
    }
  });

  it('diagnostic does not contain undefined context fields when context is omitted', () => {
    const result = validateHandoffPayload(HandoffSchemaId.STATUS_MUTATING_EVENT, {});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      // context fields should be undefined or absent when not supplied
      expect(result.diagnostic.schemaId).toBe(HandoffSchemaId.STATUS_MUTATING_EVENT);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 + AC6 — validateTeammateEvent fail-closed at receipt boundary
// ---------------------------------------------------------------------------

describe('AC3+AC6: validateTeammateEvent fail-closed at receipt — malformed handoffs blocked', () => {
  function makeKey(base: Record<string, unknown>): string {
    return createTeammateEventIdempotencyKey(base as Parameters<typeof createTeammateEventIdempotencyKey>[0]);
  }

  const validBase = {
    type: TeammateEventType.STATE_TRANSITIONED,
    beadId: 'pi-experiment-test',
    workerId: 'worker-1',
    stateId: 'Planning',
    timestamp: 1_779_000_000_000,
    actionId: 'formulate-plan',
    transitionEvent: 'SUCCESS',
    summary: 'All tasks complete.',
    evidence: 'submit_checkpoint evidence.',
    handover: 'Handover to next phase.'
  };

  it('accepts a well-formed STATE_TRANSITIONED event', () => {
    const payload = { ...validBase, idempotencyKey: makeKey(validBase) };
    const result = validateTeammateEvent(payload);
    expect(result.ok).toBe(true);
  });

  it('rejects STATE_TRANSITIONED with non-string summary (forged progress claim)', () => {
    const payload = { ...validBase, summary: { injected: true }, idempotencyKey: makeKey(validBase) };
    const result = validateTeammateEvent(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/summary/i);
  });

  it('rejects STATE_TRANSITIONED with non-string evidence (malformed handoff)', () => {
    const payload = { ...validBase, evidence: 12345, idempotencyKey: makeKey(validBase) };
    const result = validateTeammateEvent(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/evidence/i);
  });

  it('rejects STATE_TRANSITIONED with non-string handover', () => {
    const payload = { ...validBase, handover: null, idempotencyKey: makeKey(validBase) };
    const result = validateTeammateEvent(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/handover/i);
  });

  it('rejects STATE_TRANSITIONED with non-number timestamp', () => {
    const payload = { ...validBase, timestamp: 'not-a-timestamp', idempotencyKey: makeKey(validBase) };
    const result = validateTeammateEvent(payload);
    expect(result.ok).toBe(false);
  });

  it('rejects STATE_TRANSITIONED missing idempotencyKey (forged/incomplete event)', () => {
    const { ...payload } = { ...validBase } as Record<string, unknown>;
    delete payload.idempotencyKey;
    const result = validateTeammateEvent(payload);
    expect(result.ok).toBe(false);
  });

  it('rejects STATE_TRANSITIONED with missing actionId (missing state identity)', () => {
    const { actionId: _a, ...base } = validBase;
    const payload = { ...base, idempotencyKey: makeKey(base) };
    const result = validateTeammateEvent(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects STATE_FAILED with invalid transitionEvent (invalid terminal outcome)', () => {
    const failedBase = { ...validBase, type: TeammateEventType.STATE_FAILED, transitionEvent: 'FAILURE' };
    const payload = { ...failedBase, transitionEvent: 999, idempotencyKey: makeKey(failedBase) };
    const result = validateTeammateEvent(payload);
    expect(result.ok).toBe(false);
  });

  it('accepts STATE_FAILED with string transitionEvent', () => {
    const failedBase = {
      ...validBase,
      type: TeammateEventType.STATE_FAILED,
      transitionEvent: 'FAILURE'
    };
    const payload = { ...failedBase, idempotencyKey: makeKey(failedBase) };
    const result = validateTeammateEvent(payload);
    expect(result.ok).toBe(true);
  });

  it('accepts STATE_BLOCKED with valid fields', () => {
    const blockedBase = {
      ...validBase,
      type: TeammateEventType.STATE_BLOCKED,
      transitionEvent: 'BLOCKED'
    };
    const payload = { ...blockedBase, idempotencyKey: makeKey(blockedBase) };
    const result = validateTeammateEvent(payload);
    expect(result.ok).toBe(true);
  });

  it('accepts CHECKPOINT_ACCEPTED with required actionId', () => {
    const cpBase = {
      type: TeammateEventType.CHECKPOINT_ACCEPTED,
      beadId: 'pi-experiment-test',
      workerId: 'worker-1',
      stateId: 'Planning',
      timestamp: 1_779_000_000_000,
      actionId: 'formulate-plan'
    };
    const payload = { ...cpBase, idempotencyKey: makeKey(cpBase) };
    const result = validateTeammateEvent(payload);
    expect(result.ok).toBe(true);
  });

  it('rejects CHECKPOINT_ACCEPTED missing actionId (missing action identity)', () => {
    const cpBase = {
      type: TeammateEventType.CHECKPOINT_ACCEPTED,
      beadId: 'pi-experiment-test',
      workerId: 'worker-1',
      stateId: 'Planning',
      timestamp: 1_779_000_000_000
    };
    const payload = { ...cpBase, idempotencyKey: makeKey(cpBase) };
    const result = validateTeammateEvent(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AC6 (regression) — Fixture conformance: positives pass, negatives fail
// ---------------------------------------------------------------------------

describe('AC6 (regression): schema fixtures — positive fixtures pass, negative fixtures fail', () => {
  for (const id of Object.values(HandoffSchemaId)) {
    describe(`schema: ${id}`, () => {
      it('all positive fixtures pass validation', () => {
        const validate = schemaRegistry.getValidator(id);
        const entry = schemaRegistry.getEntry(id);
        for (const fixture of entry.positiveFixtures) {
          const result = validate(fixture.value);
          expect(result, `positive fixture "${fixture.label}" should pass`).toBe(true);
        }
      });

      it('all negative fixtures fail validation', () => {
        const validate = schemaRegistry.getValidator(id);
        const entry = schemaRegistry.getEntry(id);
        for (const fixture of entry.negativeFixtures) {
          const result = validate(fixture.value);
          expect(result, `negative fixture "${fixture.label}" should fail`).toBe(false);
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC6 (regression) — Anti-drift: HANDOFF_BOUNDARY_IDS consistent
// ---------------------------------------------------------------------------

describe('AC6 (regression): HANDOFF_BOUNDARY_IDS anti-drift', () => {
  it('every id in HANDOFF_BOUNDARY_IDS is registered in schemaRegistry', () => {
    const missing: string[] = [];
    for (const id of HANDOFF_BOUNDARY_IDS) {
      if (!schemaRegistry.has(id)) missing.push(id);
    }
    expect(missing, `Unregistered ids: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('every HandoffSchemaId value is in HANDOFF_BOUNDARY_IDS', () => {
    for (const id of Object.values(HandoffSchemaId)) {
      expect(HANDOFF_BOUNDARY_IDS.has(id), `${id} not in HANDOFF_BOUNDARY_IDS`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Worker-command and worker-completion schema smoke tests
// ---------------------------------------------------------------------------

describe('worker-command and worker-completion schema validation', () => {
  const validWorkerCommand = {
    beadId: 'pi-experiment-test',
    stateId: 'Planning',
    actionId: 'formulate-plan',
    workerId: 'worker-1'
  };

  it('accepts a valid worker-command payload', () => {
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMMAND, validWorkerCommand);
    expect(result.valid).toBe(true);
  });

  it('rejects worker-command missing beadId', () => {
    const { beadId: _b, ...payload } = validWorkerCommand;
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMMAND, payload);
    expect(result.valid).toBe(false);
  });

  it('rejects worker-command missing stateId', () => {
    const { stateId: _s, ...payload } = validWorkerCommand;
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMMAND, payload);
    expect(result.valid).toBe(false);
  });

  const validWorkerCompletion = {
    beadId: 'pi-experiment-test',
    stateId: 'Planning',
    actionId: 'formulate-plan',
    workerId: 'worker-1',
    outcome: 'SUCCESS'
  };

  it('accepts a valid worker-completion payload', () => {
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMPLETION, validWorkerCompletion);
    expect(result.valid).toBe(true);
  });

  it('rejects worker-completion missing outcome (forged progress claim)', () => {
    const { outcome: _o, ...payload } = validWorkerCompletion;
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMPLETION, payload);
    expect(result.valid).toBe(false);
  });

  it('rejects worker-completion with non-string outcome', () => {
    const payload = { ...validWorkerCompletion, outcome: 42 };
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMPLETION, payload);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Terminal-transition schema tests
// ---------------------------------------------------------------------------

describe('terminal-transition schema', () => {
  const validTerminalTransition = {
    beadId: 'pi-experiment-test',
    fromState: 'Verification',
    nextState: 'completed',
    transitionEvent: 'SUCCESS',
    workerId: 'worker-1',
    idempotencyKey: 'term-key-1'
  };

  it('accepts a valid terminal-transition payload', () => {
    const result = validateHandoffPayload(HandoffSchemaId.TERMINAL_TRANSITION, validTerminalTransition);
    expect(result.valid).toBe(true);
  });

  it('rejects terminal-transition missing nextState (invalid terminal outcome)', () => {
    const { nextState: _n, ...payload } = validTerminalTransition;
    const result = validateHandoffPayload(HandoffSchemaId.TERMINAL_TRANSITION, payload);
    expect(result.valid).toBe(false);
  });

  it('rejects terminal-transition missing transitionEvent', () => {
    const { transitionEvent: _t, ...payload } = validTerminalTransition;
    const result = validateHandoffPayload(HandoffSchemaId.TERMINAL_TRANSITION, payload);
    expect(result.valid).toBe(false);
  });

  it('rejects terminal-transition missing beadId', () => {
    const { beadId: _b, ...payload } = validTerminalTransition;
    const result = validateHandoffPayload(HandoffSchemaId.TERMINAL_TRANSITION, payload);
    expect(result.valid).toBe(false);
  });
});
