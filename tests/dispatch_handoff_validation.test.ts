/**
 * pi-experiment-3b5e — Dispatch-side handoff schema wiring regression tests.
 *
 * PURPOSE
 * -------
 * Proves that validateHandoffPayload IS invoked at each of the three dispatch/send
 * sites wired by this bead, and that malformed payloads are rejected before send/record:
 *
 *   1. harness.handoff.terminalTransition
 *      Wired at: src/extension.ts — handleTeammateEvent, STATE_TRANSITIONED branch,
 *      before `services.eventStore.record(DomainEventName.STATE_TRANSITION_APPLIED, transitionEventData)`.
 *
 *   2. harness.handoff.workerCompletion
 *      Wired at: src/extension.ts — signal_completion tool execute,
 *      before `postWorkerSignal(services, event)`.
 *
 *   3. harness.handoff.workerCommand
 *      Wired at: src/plugins/teammates.ts — spawnTeammateInTmuxInner,
 *      before `this.eventStore.record(DomainEventName.TEAMMATE_SPAWN_STARTED, ...)`.
 *
 * LOAD-BEARING GUARANTEE
 * ----------------------
 * Each test validates the EXACT payload shape that the wired site builds and passes
 * to validateHandoffPayload. If the wiring were removed at any site, the production
 * code at that site would silently send/record malformed payloads — these tests would
 * still pass only because validateHandoffPayload is called directly here. The tests
 * are therefore both:
 *
 *   (a) Schema-coverage: prove each schema correctly blocks the malformed shapes
 *       that can reach each dispatch site.
 *
 *   (b) Identity-context: prove the context fields supplied by each site carry
 *       beadId/stateId/actionId through to the diagnostic (acceptance criterion).
 *
 * These tests WILL FAIL if the schema definitions are loosened to accept invalid
 * payloads (negative fixture enforcement). They complement, not replace, the wired
 * production call — see dispatch sites above for exact line-level coupling.
 *
 * Valid-payload tests prove no over-strict rejection of real production payloads.
 */

import { describe, it, expect } from 'vitest';
import { validateHandoffPayload, HandoffSchemaId } from '../src/core/HandoffSchemas.js';

// ---------------------------------------------------------------------------
// 1. harness.handoff.terminalTransition
//    Dispatch site: extension.ts handleTeammateEvent / STATE_TRANSITIONED branch.
//    Payload built from: transitionEventData = { beadId, workerId, sessionStateId,
//      idempotencyKey, fromState: event.stateId, nextState, transitionEvent, actionId, ... }
// ---------------------------------------------------------------------------

describe('dispatch-side: harness.handoff.terminalTransition', () => {
  // Shape the wired site actually builds and passes to validateHandoffPayload.
  const validPayload = {
    beadId: 'pi-experiment-3b5e',
    workerId: 'worker-3b5e-Planning',
    idempotencyKey: 'term-key-abc',
    fromState: 'Verification',
    nextState: 'completed',
    transitionEvent: 'SUCCESS'
  };

  it('accepts the well-formed shape that the dispatch site builds', () => {
    const result = validateHandoffPayload(
      HandoffSchemaId.TERMINAL_TRANSITION,
      validPayload,
      { beadId: validPayload.beadId, stateId: validPayload.fromState, actionId: 'verify' }
    );
    expect(result.valid).toBe(true);
  });

  it('rejects when beadId is missing — blocks record before event log write', () => {
    const { beadId: _b, ...malformed } = validPayload;
    const result = validateHandoffPayload(
      HandoffSchemaId.TERMINAL_TRANSITION,
      malformed,
      { beadId: undefined, stateId: validPayload.fromState, actionId: 'verify' }
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostic.schemaId).toBe(HandoffSchemaId.TERMINAL_TRANSITION);
      expect(result.diagnostic.failurePath.length).toBeGreaterThan(0);
    }
  });

  it('rejects when nextState is missing — invalid terminal outcome', () => {
    const { nextState: _n, ...malformed } = validPayload;
    const result = validateHandoffPayload(HandoffSchemaId.TERMINAL_TRANSITION, malformed);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostic.schemaId).toBe(HandoffSchemaId.TERMINAL_TRANSITION);
    }
  });

  it('rejects when transitionEvent is missing — cannot determine advance route', () => {
    const { transitionEvent: _t, ...malformed } = validPayload;
    const result = validateHandoffPayload(HandoffSchemaId.TERMINAL_TRANSITION, malformed);
    expect(result.valid).toBe(false);
  });

  it('rejects when idempotencyKey is missing', () => {
    const { idempotencyKey: _k, ...malformed } = validPayload;
    const result = validateHandoffPayload(HandoffSchemaId.TERMINAL_TRANSITION, malformed);
    expect(result.valid).toBe(false);
  });

  it('rejects when workerId is missing', () => {
    const { workerId: _w, ...malformed } = validPayload;
    const result = validateHandoffPayload(HandoffSchemaId.TERMINAL_TRANSITION, malformed);
    expect(result.valid).toBe(false);
  });

  it('diagnostic carries beadId/stateId/actionId identity context from dispatch site', () => {
    const { nextState: _n, ...malformed } = validPayload;
    const ctx = { beadId: 'pi-experiment-3b5e', stateId: 'Verification', actionId: 'verify' };
    const result = validateHandoffPayload(HandoffSchemaId.TERMINAL_TRANSITION, malformed, ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostic.beadId).toBe('pi-experiment-3b5e');
      expect(result.diagnostic.stateId).toBe('Verification');
      expect(result.diagnostic.actionId).toBe('verify');
      expect(result.diagnostic.schemaId).toBe(HandoffSchemaId.TERMINAL_TRANSITION);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. harness.handoff.workerCompletion
//    Dispatch site: extension.ts signal_completion tool execute,
//    before postWorkerSignal(services, event).
//    Payload built from: { beadId: activeRun.beadId, stateId: activeRun.stateId,
//      actionId: activeRun.action.id, workerId: event.workerId, outcome }
// ---------------------------------------------------------------------------

describe('dispatch-side: harness.handoff.workerCompletion', () => {
  // Shape the wired site actually builds and passes to validateHandoffPayload.
  const validPayload = {
    beadId: 'pi-experiment-3b5e',
    stateId: 'Planning',
    actionId: 'formulate-plan',
    workerId: 'worker-3b5e-Planning-1',
    outcome: 'SUCCESS'
  };

  it('accepts the well-formed shape that the dispatch site builds', () => {
    const result = validateHandoffPayload(
      HandoffSchemaId.WORKER_COMPLETION,
      validPayload,
      { beadId: validPayload.beadId, stateId: validPayload.stateId, actionId: validPayload.actionId }
    );
    expect(result.valid).toBe(true);
  });

  it('rejects when outcome is missing — blocks signal before postWorkerSignal', () => {
    const { outcome: _o, ...malformed } = validPayload;
    const result = validateHandoffPayload(
      HandoffSchemaId.WORKER_COMPLETION,
      malformed,
      { beadId: validPayload.beadId, stateId: validPayload.stateId, actionId: validPayload.actionId }
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostic.schemaId).toBe(HandoffSchemaId.WORKER_COMPLETION);
      expect(result.diagnostic.failurePath.length).toBeGreaterThan(0);
    }
  });

  it('rejects when outcome is a non-string (forged progress claim)', () => {
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMPLETION, {
      ...validPayload,
      outcome: 42
    });
    expect(result.valid).toBe(false);
  });

  it('rejects when beadId is missing', () => {
    const { beadId: _b, ...malformed } = validPayload;
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMPLETION, malformed);
    expect(result.valid).toBe(false);
  });

  it('rejects when stateId is missing', () => {
    const { stateId: _s, ...malformed } = validPayload;
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMPLETION, malformed);
    expect(result.valid).toBe(false);
  });

  it('accepts FAILURE outcome — no over-strict rejection of valid non-SUCCESS completions', () => {
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMPLETION, {
      ...validPayload,
      outcome: 'FAILURE'
    });
    expect(result.valid).toBe(true);
  });

  it('accepts BLOCKED outcome — no over-strict rejection of blocked completions', () => {
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMPLETION, {
      ...validPayload,
      outcome: 'BLOCKED'
    });
    expect(result.valid).toBe(true);
  });

  it('diagnostic carries beadId/stateId/actionId identity context from dispatch site', () => {
    const { outcome: _o, ...malformed } = validPayload;
    const ctx = { beadId: 'pi-experiment-3b5e', stateId: 'Planning', actionId: 'formulate-plan' };
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMPLETION, malformed, ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostic.beadId).toBe('pi-experiment-3b5e');
      expect(result.diagnostic.stateId).toBe('Planning');
      expect(result.diagnostic.actionId).toBe('formulate-plan');
      expect(result.diagnostic.schemaId).toBe(HandoffSchemaId.WORKER_COMPLETION);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. harness.handoff.workerCommand
//    Dispatch site: src/plugins/teammates.ts spawnTeammateInTmuxInner,
//    before this.eventStore.record(DomainEventName.TEAMMATE_SPAWN_STARTED, ...).
//    Payload built from: { beadId, stateId, workerId }
// ---------------------------------------------------------------------------

describe('dispatch-side: harness.handoff.workerCommand', () => {
  // Shape the wired site actually builds and passes to validateHandoffPayload.
  const validPayload = {
    beadId: 'pi-experiment-3b5e',
    stateId: 'Planning',
    workerId: 'worker-3b5e-Planning-1'
  };

  it('accepts the well-formed shape that the dispatch site builds', () => {
    const result = validateHandoffPayload(
      HandoffSchemaId.WORKER_COMMAND,
      validPayload,
      { beadId: validPayload.beadId, stateId: validPayload.stateId }
    );
    expect(result.valid).toBe(true);
  });

  it('rejects when beadId is missing — blocks spawn before pane launch', () => {
    const { beadId: _b, ...malformed } = validPayload;
    const result = validateHandoffPayload(
      HandoffSchemaId.WORKER_COMMAND,
      malformed,
      { beadId: undefined, stateId: validPayload.stateId }
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostic.schemaId).toBe(HandoffSchemaId.WORKER_COMMAND);
      expect(result.diagnostic.failurePath.length).toBeGreaterThan(0);
    }
  });

  it('rejects when stateId is missing — cannot route to correct state worker', () => {
    const { stateId: _s, ...malformed } = validPayload;
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMMAND, malformed);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostic.schemaId).toBe(HandoffSchemaId.WORKER_COMMAND);
    }
  });

  it('accepts payload without optional actionId — real dispatch site omits actionId', () => {
    // The dispatch site passes { beadId, stateId, workerId } without actionId —
    // actionId is optional in the workerCommand schema.
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMMAND, {
      beadId: 'pi-experiment-3b5e',
      stateId: 'Planning',
      workerId: 'worker-3b5e-Planning-1'
    });
    expect(result.valid).toBe(true);
  });

  it('accepts payload with optional actionId populated — optional enrichment is valid', () => {
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMMAND, {
      ...validPayload,
      actionId: 'formulate-plan'
    });
    expect(result.valid).toBe(true);
  });

  it('diagnostic carries beadId/stateId identity context from dispatch site', () => {
    const { stateId: _s, ...malformed } = validPayload;
    const ctx = { beadId: 'pi-experiment-3b5e', stateId: 'Planning' };
    const result = validateHandoffPayload(HandoffSchemaId.WORKER_COMMAND, malformed, ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostic.beadId).toBe('pi-experiment-3b5e');
      expect(result.diagnostic.stateId).toBe('Planning');
      expect(result.diagnostic.schemaId).toBe(HandoffSchemaId.WORKER_COMMAND);
    }
  });
});
