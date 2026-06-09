/**
 * v2_replay_quarantine.test.ts
 *
 * pi-experiment-e8cm: Add v2 route-event replay quarantine and projection tests.
 *
 * Proves v2 event-driven routing is DETERMINISTIC across restart/replay with ONE
 * explicit invalid-event policy: replay QUARANTINES invalid/undeclared route events
 * into schema-valid diagnostic events and CONTINUES projection from the last valid
 * workflow state. Invalid events NEVER affect progress.
 *
 * AC1: v2 replay uses schema-valid route events + applied-transition records +
 *      declared event vocabulary + exact transition tables ONLY. Old default-outcome
 *      events + model-authored route fields are NOT treated as advance/failure/terminal.
 *      LOAD-BEARING: each anti-prose/anti-v1 test fails if the gate is removed.
 *
 * AC2: Invalid/undeclared/stale route events are QUARANTINED deterministically and
 *      CANNOT affect projected progress. Four quarantine reasons covered.
 *      LOAD-BEARING per reason: test injects bad event into valid fixture → asserts
 *      quarantine diagnostic produced AND projection does NOT advance past last valid.
 *
 * AC3: Replay produces stable PER-EVENT projection snapshots (not only final-state).
 *      Multi-state valid run replayed → per-event snapshots match expected state sequence.
 *
 * AC4: Terminal state reached ONLY via a valid STATE_TRANSITION_APPLIED referencing
 *      a DECLARED terminal transition event. Old SUCCESS / undeclared event / model-
 *      authored outcome → does NOT mark terminal. LOAD-BEARING.
 *
 * AC5: Tests cover valid replay, invalid-event quarantine (undeclared, schema-invalid,
 *      duplicate-idempotency, stale-config-fingerprint), terminal-route enforcement,
 *      old-outcome-fallback absence, model-authored-route-fields ignored.
 *
 * Version-gated: v1/cerdiwen golden unaffected.
 * Deterministic: no Date.now() or Math.random() in projection/quarantine.
 */

import { describe, it, expect } from 'vitest';

import {
  replayProjectV2Transitions,
  projectV2Transitions,
  ROUTE_EVENT_EMITTED_SCHEMA_ID,
  ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
  type ProjectableEvent,
  type V2ReplayProjectionOptions,
  type RouteEventQuarantinedPayload,
} from '../src/core/RouteEventContract.js';
import { DomainEventName } from '../src/constants/domain.js';
import { DOMAIN_EVENT_SCHEMA_METADATA, DOMAIN_EVENT_SCHEMAS } from '../src/core/DomainEventSchemas.js';

// ---------------------------------------------------------------------------
// Shared fixtures and helpers
// ---------------------------------------------------------------------------

/**
 * Minimal v2 vocabulary: two advance events + one failure + one blocked.
 * Used across all tests to avoid config file I/O — these are projection-only tests.
 */
const VOCAB = new Map<string, string>([
  ['PLAN_ACCEPTED', 'advance'],
  ['POST_REVIEW_ACCEPTED', 'advance'],
  ['FAILURE', 'failure'],
  ['BLOCKED', 'blocked'],
  ['REQUIREMENTS_NEEDED', 'neutral'],
]);

/**
 * Minimal three-state v2 statechart:
 *   Planning → (PLAN_ACCEPTED) → Implementing → (POST_REVIEW_ACCEPTED) → completed
 *   All failure/blocked events self-loop back to the same state.
 */
const STATES: Record<string, { transitions: Record<string, string> }> = {
  Planning: {
    transitions: {
      PLAN_ACCEPTED: 'Implementing',
      FAILURE: 'Planning',
      BLOCKED: 'Planning',
    }
  },
  Implementing: {
    transitions: {
      POST_REVIEW_ACCEPTED: 'completed',
      FAILURE: 'Implementing',
      BLOCKED: 'Implementing',
    }
  },
  completed: { transitions: {} },
};

const TERMINAL_STATES = new Set(['completed']);

function stateFor(stateId: string): { transitions: Record<string, string> } | undefined {
  return STATES[stateId];
}

function isTerminalState(stateId: string): boolean {
  return TERMINAL_STATES.has(stateId);
}

const DEFAULT_FINGERPRINT = 'abcdef1234567890';
const ALT_FINGERPRINT = '0987654321fedcba';

/** Build a valid ROUTE_EVENT_EMITTED record. */
function makeRouteEvent(overrides: Partial<{
  routeEventId: string;
  eventName: string;
  emitterType: string;
  emitterId: string;
  stateId: string;
  actionId: string;
  configFingerprint: string;
  beadId: string;
  category: string;
}>): ProjectableEvent {
  const eventName = overrides.eventName ?? 'PLAN_ACCEPTED';
  const category = overrides.category ?? (VOCAB.get(eventName.toUpperCase()) ?? 'advance');
  return {
    type: DomainEventName.ROUTE_EVENT_EMITTED,
    data: {
      schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
      schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
      configVersion: 2,
      configFingerprint: overrides.configFingerprint ?? DEFAULT_FINGERPRINT,
      beadId: overrides.beadId ?? 'bead-e8cm-001',
      stateId: overrides.stateId ?? 'Planning',
      actionId: overrides.actionId ?? 'plan_action',
      runId: 'run-e8cm-001',
      emitterType: overrides.emitterType ?? 'verifier',
      emitterId: overrides.emitterId ?? 'plan_verifier',
      eventName,
      category,
      evidenceRefs: [],
      routeEventId: overrides.routeEventId ?? `evt-${eventName.toLowerCase()}-001`,
    }
  };
}

/**
 * Valid multi-state fixture: Planning → Implementing → completed.
 * Three ROUTE_EVENT_EMITTED records produce two state transitions + terminal.
 */
function makeValidMultiStateFixture(): ProjectableEvent[] {
  return [
    // Non-route events (should be invisible to projection)
    { type: DomainEventName.BEAD_CLAIMED, data: { beadId: 'bead-001' } },
    // First route event: Planning → Implementing
    makeRouteEvent({
      routeEventId: 'evt-plan-accepted-001',
      eventName: 'PLAN_ACCEPTED',
      stateId: 'Planning',
      emitterType: 'verifier',
      emitterId: 'plan_verifier',
    }),
    // Non-route event (invisible)
    { type: DomainEventName.ACTION_COMPLETED, data: { beadId: 'bead-001', stateId: 'Implementing' } },
    // Second route event: Implementing → completed (terminal)
    makeRouteEvent({
      routeEventId: 'evt-post-review-001',
      eventName: 'POST_REVIEW_ACCEPTED',
      stateId: 'Implementing',
      emitterType: 'gate',
      emitterId: 'review_gate',
      category: 'advance',
    }),
  ];
}

// ---------------------------------------------------------------------------
// AC1: Old outcome events + model-authored fields are NOT treated as route authority
// ---------------------------------------------------------------------------

describe('AC1: old outcome events + model-authored route fields ignored (LOAD-BEARING)', () => {
  const options: V2ReplayProjectionOptions = {
    initialState: 'Planning',
    expectedConfigFingerprint: DEFAULT_FINGERPRINT,
    isTerminalState,
  };

  it('LOAD-BEARING: non-ROUTE_EVENT_EMITTED events (old SUCCESS, model outcome) do not advance state', () => {
    // A log with only non-ROUTE_EVENT_EMITTED events must leave state unchanged.
    // If the anti-prose guard (gate 1) were removed, some of these might match later gates.
    const events: ProjectableEvent[] = [
      // Old v1 SUCCESS outcome event (not ROUTE_EVENT_EMITTED)
      { type: 'SUCCESS', data: { beadId: 'bead-001', eventName: 'SUCCESS', category: 'advance' } },
      // Model-authored STATE_TRANSITION_APPLIED (also not a route event)
      {
        type: DomainEventName.STATE_TRANSITION_APPLIED,
        data: {
          beadId: 'bead-001', fromState: 'Planning', nextState: 'completed',
          transitionEvent: 'SUCCESS', routeEventId: 'fake-001'
        }
      },
      // Model-authored TEAMMATE_EVENT with outcome field
      {
        type: DomainEventName.TEAMMATE_EVENT,
        data: {
          beadId: 'bead-001', stateId: 'Planning', eventName: 'PLAN_ACCEPTED',
          category: 'advance', emitterType: 'verifier', routeEventId: 'fake-002'
        }
      },
    ];

    const result = replayProjectV2Transitions(events, VOCAB, stateFor, options);

    // State must NOT advance — all events are invisible to quarantine
    expect(result.finalState).toBe('Planning');
    expect(result.appliedTransitions).toHaveLength(0);
    // No quarantine diagnostics — non-ROUTE_EVENT_EMITTED records are invisible, not quarantined
    expect(result.quarantineDiagnostics).toHaveLength(0);
    expect(result.isTerminal).toBe(false);
    expect(result.snapshots).toHaveLength(0);
  });

  it('LOAD-BEARING: model-authored route fields without v2 schema validity → not advance/terminal', () => {
    // A ROUTE_EVENT_EMITTED record with emitterType='model' (anti-prose gate).
    // Even though it has a valid eventName, the invalid emitterType quarantines it.
    const modelAuthoredEvent: ProjectableEvent = {
      type: DomainEventName.ROUTE_EVENT_EMITTED,
      data: {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
        schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
        configVersion: 2,
        configFingerprint: DEFAULT_FINGERPRINT,
        beadId: 'bead-001',
        stateId: 'Planning',
        actionId: 'plan_action',
        runId: 'run-001',
        emitterType: 'model',  // ← invalid emitter type (anti-prose)
        emitterId: 'llm-prose',
        eventName: 'PLAN_ACCEPTED',
        category: 'advance',
        evidenceRefs: [],
        routeEventId: 'model-route-001',
      }
    };

    const result = replayProjectV2Transitions([modelAuthoredEvent], VOCAB, stateFor, options);

    // LOAD-BEARING: state must not advance — model-authored emitterType quarantined
    expect(result.finalState).toBe('Planning');
    expect(result.appliedTransitions).toHaveLength(0);
    expect(result.quarantineDiagnostics).toHaveLength(1);
    expect(result.quarantineDiagnostics[0]!.reason).toBe('SCHEMA_INVALID');
    expect(result.isTerminal).toBe(false);
    // If the emitterType gate is removed, state would advance to Implementing — test would fail
  });

  it('LOAD-BEARING: old default-outcome pattern (SUCCESS via non-route-event path) → no terminal', () => {
    // Only a valid ROUTE_EVENT_EMITTED referencing POST_REVIEW_ACCEPTED can reach completed.
    // A raw 'SUCCESS' event type (old v1 pattern) must not mark terminal.
    const events: ProjectableEvent[] = [
      // Old-style SUCCESS event — NOT ROUTE_EVENT_EMITTED
      { type: 'SUCCESS', data: { beadId: 'bead-001', transitionEvent: 'SUCCESS' } },
      // Even a valid STATE_TRANSITION_APPLIED without a backing ROUTE_EVENT_EMITTED is ignored
      {
        type: DomainEventName.STATE_TRANSITION_APPLIED,
        data: { beadId: 'bead-001', fromState: 'Planning', nextState: 'completed', transitionEvent: 'SUCCESS' }
      },
    ];

    const result = replayProjectV2Transitions(events, VOCAB, stateFor, options);
    expect(result.isTerminal).toBe(false);
    expect(result.finalState).toBe('Planning');
    expect(result.appliedTransitions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC2: Quarantine — SCHEMA_INVALID (missing routeEventId / invalid emitterType)
// ---------------------------------------------------------------------------

describe('AC2: SCHEMA_INVALID quarantine — invalid emitterType or missing routeEventId (LOAD-BEARING)', () => {
  const options: V2ReplayProjectionOptions = {
    initialState: 'Planning',
    expectedConfigFingerprint: DEFAULT_FINGERPRINT,
    isTerminalState,
  };

  it('LOAD-BEARING: ROUTE_EVENT_EMITTED with missing routeEventId is quarantined, state does not advance', () => {
    // Without routeEventId the event cannot be linked to STATE_TRANSITION_APPLIED.
    // The quarantine gate rejects it deterministically.
    const missingIdEvent: ProjectableEvent = {
      type: DomainEventName.ROUTE_EVENT_EMITTED,
      data: {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
        schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
        configVersion: 2,
        configFingerprint: DEFAULT_FINGERPRINT,
        beadId: 'bead-001',
        stateId: 'Planning',
        actionId: 'plan_action',
        runId: 'run-001',
        emitterType: 'verifier',
        emitterId: 'plan_verifier',
        eventName: 'PLAN_ACCEPTED',
        category: 'advance',
        evidenceRefs: [],
        // routeEventId: absent ← quarantine trigger
      }
    };

    const result = replayProjectV2Transitions([missingIdEvent], VOCAB, stateFor, options);

    // LOAD-BEARING: state must not advance; diagnostic must be produced.
    // If the routeEventId gate were removed, this event would advance to Implementing.
    expect(result.finalState).toBe('Planning');
    expect(result.appliedTransitions).toHaveLength(0);
    expect(result.quarantineDiagnostics).toHaveLength(1);
    const diag = result.quarantineDiagnostics[0]!;
    expect(diag.reason).toBe('SCHEMA_INVALID');
    expect(diag.lastValidState).toBe('Planning');
    expect(diag.schemaId).toBe(ROUTE_EVENT_EMITTED_SCHEMA_ID);
    expect(diag.configFingerprint).toBe(DEFAULT_FINGERPRINT);
  });

  it('LOAD-BEARING: ROUTE_EVENT_EMITTED with invalid emitterType is quarantined (SCHEMA_INVALID), state unchanged', () => {
    // emitterType='model' is not in the valid deterministic emitter set.
    const badEmitterEvent: ProjectableEvent = {
      type: DomainEventName.ROUTE_EVENT_EMITTED,
      data: {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
        schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
        configVersion: 2,
        configFingerprint: DEFAULT_FINGERPRINT,
        beadId: 'bead-001',
        stateId: 'Planning',
        actionId: 'plan_action',
        runId: 'run-001',
        emitterType: 'llm_model',  // ← not in valid set
        emitterId: 'llm_output_parser',
        eventName: 'PLAN_ACCEPTED',
        category: 'advance',
        evidenceRefs: [],
        routeEventId: 'bad-emitter-001',
      }
    };

    // Also a valid event to confirm projection continues correctly after quarantine
    const validEvent = makeRouteEvent({
      routeEventId: 'valid-after-bad-001',
      eventName: 'PLAN_ACCEPTED',
      stateId: 'Planning',
    });

    const result = replayProjectV2Transitions([badEmitterEvent, validEvent], VOCAB, stateFor, options);

    // LOAD-BEARING: bad event quarantined; valid event still applied
    expect(result.quarantineDiagnostics).toHaveLength(1);
    expect(result.quarantineDiagnostics[0]!.reason).toBe('SCHEMA_INVALID');
    // Valid event advances state
    expect(result.appliedTransitions).toHaveLength(1);
    expect(result.finalState).toBe('Implementing');
    // If the emitterType gate is removed, quarantine would be 0 and transitions would be 2.
  });

  it('LOAD-BEARING: ROUTE_EVENT_EMITTED with missing eventName is quarantined (SCHEMA_INVALID)', () => {
    const noEventNameRecord: ProjectableEvent = {
      type: DomainEventName.ROUTE_EVENT_EMITTED,
      data: {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
        schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
        configVersion: 2,
        configFingerprint: DEFAULT_FINGERPRINT,
        beadId: 'bead-001',
        stateId: 'Planning',
        actionId: 'plan_action',
        runId: 'run-001',
        emitterType: 'verifier',
        emitterId: 'plan_verifier',
        // eventName: absent ← quarantine trigger
        category: 'advance',
        evidenceRefs: [],
        routeEventId: 'no-event-name-001',
      }
    };

    const result = replayProjectV2Transitions([noEventNameRecord], VOCAB, stateFor, options);

    expect(result.quarantineDiagnostics).toHaveLength(1);
    expect(result.quarantineDiagnostics[0]!.reason).toBe('SCHEMA_INVALID');
    expect(result.finalState).toBe('Planning');
    expect(result.appliedTransitions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC2: Quarantine — UNDECLARED_EVENT
// ---------------------------------------------------------------------------

describe('AC2: UNDECLARED_EVENT quarantine — eventName not in v2 vocabulary (LOAD-BEARING)', () => {
  const options: V2ReplayProjectionOptions = {
    initialState: 'Planning',
    expectedConfigFingerprint: DEFAULT_FINGERPRINT,
    isTerminalState,
  };

  it('LOAD-BEARING: undeclared eventName in ROUTE_EVENT_EMITTED is quarantined, state does not advance', () => {
    // An event name not in the declared vocab — common from stale config or v1 events.
    const undeclaredEvent: ProjectableEvent = {
      type: DomainEventName.ROUTE_EVENT_EMITTED,
      data: {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
        schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
        configVersion: 2,
        configFingerprint: DEFAULT_FINGERPRINT,
        beadId: 'bead-001',
        stateId: 'Planning',
        actionId: 'plan_action',
        runId: 'run-001',
        emitterType: 'verifier',
        emitterId: 'plan_verifier',
        eventName: 'CUSTOM_UNDECLARED_EVENT',  // ← not in VOCAB
        category: 'advance',
        evidenceRefs: [],
        routeEventId: 'undeclared-001',
      }
    };

    const result = replayProjectV2Transitions([undeclaredEvent], VOCAB, stateFor, options);

    // LOAD-BEARING: quarantine produced; state unchanged
    // If the vocab gate is removed, this event would look for a transition (and skip since
    // no transition key exists for CUSTOM_UNDECLARED_EVENT, but the test is about the quarantine).
    expect(result.quarantineDiagnostics).toHaveLength(1);
    const diag = result.quarantineDiagnostics[0]!;
    expect(diag.reason).toBe('UNDECLARED_EVENT');
    expect(diag.lastValidState).toBe('Planning');
    expect(diag.eventName).toBe('CUSTOM_UNDECLARED_EVENT');
    expect(diag.routeEventId).toBe('undeclared-001');
    expect(result.finalState).toBe('Planning');
    expect(result.appliedTransitions).toHaveLength(0);
  });

  it('LOAD-BEARING: injection of undeclared event into valid fixture — preceding transitions unaffected', () => {
    // Fixture: valid Planning → Implementing, then undeclared event, then valid Implementing → completed.
    const undeclaredInjected: ProjectableEvent = {
      type: DomainEventName.ROUTE_EVENT_EMITTED,
      data: {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
        schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
        configVersion: 2,
        configFingerprint: DEFAULT_FINGERPRINT,
        beadId: 'bead-001',
        stateId: 'Implementing',
        actionId: 'impl_action',
        runId: 'run-001',
        emitterType: 'gate',
        emitterId: 'impl_gate',
        eventName: 'OLD_V1_ADVANCE_EVENT',  // ← not in new vocab
        category: 'advance',
        evidenceRefs: [],
        routeEventId: 'undeclared-injected-001',
      }
    };

    const events: ProjectableEvent[] = [
      makeRouteEvent({ routeEventId: 'evt-plan-001', eventName: 'PLAN_ACCEPTED', stateId: 'Planning' }),
      undeclaredInjected,  // ← bad event injected between valid events
      makeRouteEvent({ routeEventId: 'evt-review-001', eventName: 'POST_REVIEW_ACCEPTED', stateId: 'Implementing' }),
    ];

    const result = replayProjectV2Transitions(events, VOCAB, stateFor, options);

    // Two valid transitions applied; undeclared event quarantined but does NOT block the rest
    expect(result.appliedTransitions).toHaveLength(2);
    expect(result.quarantineDiagnostics).toHaveLength(1);
    expect(result.quarantineDiagnostics[0]!.reason).toBe('UNDECLARED_EVENT');
    // State progresses correctly despite the injected bad event
    expect(result.finalState).toBe('completed');
    expect(result.isTerminal).toBe(true);
    // If the vocab gate were removed, the undeclared event would attempt a transition
    // (and fail to find one — but the quarantine diagnostic would be absent, breaking this test).
  });
});

// ---------------------------------------------------------------------------
// AC2: Quarantine — STALE_CONFIG_FINGERPRINT
// ---------------------------------------------------------------------------

describe('AC2: STALE_CONFIG_FINGERPRINT quarantine — configFingerprint mismatch (LOAD-BEARING)', () => {
  it('LOAD-BEARING: ROUTE_EVENT_EMITTED with wrong configFingerprint is quarantined, state unchanged', () => {
    const staleEvent: ProjectableEvent = {
      type: DomainEventName.ROUTE_EVENT_EMITTED,
      data: {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
        schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
        configVersion: 2,
        configFingerprint: ALT_FINGERPRINT,  // ← stale (differs from DEFAULT_FINGERPRINT)
        beadId: 'bead-001',
        stateId: 'Planning',
        actionId: 'plan_action',
        runId: 'run-001',
        emitterType: 'verifier',
        emitterId: 'plan_verifier',
        eventName: 'PLAN_ACCEPTED',
        category: 'advance',
        evidenceRefs: [],
        routeEventId: 'stale-fp-001',
      }
    };

    const options: V2ReplayProjectionOptions = {
      initialState: 'Planning',
      expectedConfigFingerprint: DEFAULT_FINGERPRINT,  // ← expected fingerprint
      isTerminalState,
    };

    const result = replayProjectV2Transitions([staleEvent], VOCAB, stateFor, options);

    // LOAD-BEARING: stale fingerprint → quarantine; state not advanced
    // If the fingerprint gate is removed, this event would advance to Implementing.
    expect(result.quarantineDiagnostics).toHaveLength(1);
    const diag = result.quarantineDiagnostics[0]!;
    expect(diag.reason).toBe('STALE_CONFIG_FINGERPRINT');
    expect(diag.configFingerprint).toBe(ALT_FINGERPRINT);
    expect(diag.lastValidState).toBe('Planning');
    expect(result.finalState).toBe('Planning');
    expect(result.appliedTransitions).toHaveLength(0);
  });

  it('LOAD-BEARING: stale-fingerprint event injected between valid events — surrounding transitions unaffected', () => {
    const options: V2ReplayProjectionOptions = {
      initialState: 'Planning',
      expectedConfigFingerprint: DEFAULT_FINGERPRINT,
      isTerminalState,
    };

    const events: ProjectableEvent[] = [
      makeRouteEvent({ routeEventId: 'evt-plan-001', eventName: 'PLAN_ACCEPTED', stateId: 'Planning' }),
      // Stale fingerprint event injected after Planning → Implementing
      {
        type: DomainEventName.ROUTE_EVENT_EMITTED,
        data: {
          schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
          schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
          configVersion: 2,
          configFingerprint: ALT_FINGERPRINT,  // ← stale
          beadId: 'bead-001',
          stateId: 'Implementing',
          actionId: 'impl_action',
          runId: 'run-old',
          emitterType: 'gate',
          emitterId: 'old_gate',
          eventName: 'POST_REVIEW_ACCEPTED',
          category: 'advance',
          evidenceRefs: [],
          routeEventId: 'stale-fp-injected-001',
        }
      },
    ];

    const result = replayProjectV2Transitions(events, VOCAB, stateFor, options);

    // First valid transition applied; stale fingerprint event quarantined
    expect(result.appliedTransitions).toHaveLength(1);
    expect(result.appliedTransitions[0]!.eventName).toBe('PLAN_ACCEPTED');
    expect(result.quarantineDiagnostics).toHaveLength(1);
    expect(result.quarantineDiagnostics[0]!.reason).toBe('STALE_CONFIG_FINGERPRINT');
    // Terminal NOT reached — stale fingerprint event cannot advance to completed
    expect(result.isTerminal).toBe(false);
    expect(result.finalState).toBe('Implementing');
  });

  it('no expectedConfigFingerprint configured → no fingerprint check, all matching-vocab events apply', () => {
    // When expectedConfigFingerprint is absent, the fingerprint gate is skipped.
    const options: V2ReplayProjectionOptions = {
      initialState: 'Planning',
      // no expectedConfigFingerprint
      isTerminalState,
    };

    const events: ProjectableEvent[] = [
      makeRouteEvent({ routeEventId: 'evt-plan-001', eventName: 'PLAN_ACCEPTED', configFingerprint: ALT_FINGERPRINT }),
    ];

    const result = replayProjectV2Transitions(events, VOCAB, stateFor, options);

    // Without fingerprint check, event applies despite different fingerprint
    expect(result.appliedTransitions).toHaveLength(1);
    expect(result.quarantineDiagnostics).toHaveLength(0);
    expect(result.finalState).toBe('Implementing');
  });
});

// ---------------------------------------------------------------------------
// AC2: Quarantine — DUPLICATE_IDEMPOTENCY
// ---------------------------------------------------------------------------

describe('AC2: DUPLICATE_IDEMPOTENCY quarantine — repeated routeEventId (LOAD-BEARING)', () => {
  const options: V2ReplayProjectionOptions = {
    initialState: 'Planning',
    expectedConfigFingerprint: DEFAULT_FINGERPRINT,
    isTerminalState,
  };

  it('LOAD-BEARING: duplicate routeEventId is quarantined, does not advance state twice', () => {
    // The same routeEventId appearing twice — second occurrence must be quarantined.
    const firstEvent = makeRouteEvent({
      routeEventId: 'duplicate-route-001',
      eventName: 'PLAN_ACCEPTED',
      stateId: 'Planning',
    });

    // Exact duplicate (same routeEventId, same event)
    const duplicateEvent = makeRouteEvent({
      routeEventId: 'duplicate-route-001',  // ← same id
      eventName: 'PLAN_ACCEPTED',
      stateId: 'Planning',
    });

    const result = replayProjectV2Transitions([firstEvent, duplicateEvent], VOCAB, stateFor, options);

    // LOAD-BEARING: first applied; second quarantined with DUPLICATE_IDEMPOTENCY
    // If the idempotency gate is removed, the duplicate would be applied again and the
    // transition count would be 2.
    expect(result.appliedTransitions).toHaveLength(1);
    expect(result.quarantineDiagnostics).toHaveLength(1);
    const diag = result.quarantineDiagnostics[0]!;
    expect(diag.reason).toBe('DUPLICATE_IDEMPOTENCY');
    expect(diag.routeEventId).toBe('duplicate-route-001');
    // State advanced once to Implementing, then stayed there (duplicate quarantined)
    expect(result.finalState).toBe('Implementing');
  });

  it('LOAD-BEARING: duplicate injection into multi-state fixture — duplicate does not re-advance, terminal not duplicated', () => {
    const events: ProjectableEvent[] = [
      makeRouteEvent({ routeEventId: 'evt-plan-001', eventName: 'PLAN_ACCEPTED', stateId: 'Planning' }),
      makeRouteEvent({ routeEventId: 'evt-review-001', eventName: 'POST_REVIEW_ACCEPTED', stateId: 'Implementing' }),
      // Replay artifact: POST_REVIEW_ACCEPTED re-appears (network duplicate or journal replay)
      makeRouteEvent({ routeEventId: 'evt-review-001', eventName: 'POST_REVIEW_ACCEPTED', stateId: 'Implementing' }),
    ];

    const result = replayProjectV2Transitions(events, VOCAB, stateFor, options);

    // Two unique events applied; duplicate quarantined
    expect(result.appliedTransitions).toHaveLength(2);
    expect(result.quarantineDiagnostics).toHaveLength(1);
    expect(result.quarantineDiagnostics[0]!.reason).toBe('DUPLICATE_IDEMPOTENCY');
    // Terminal reached once — duplicate does not re-trigger
    expect(result.isTerminal).toBe(true);
    expect(result.terminalRouteEventId).toBe('evt-review-001');
    expect(result.finalState).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// AC3: Per-event projection snapshots — deterministic replay
// ---------------------------------------------------------------------------

describe('AC3: per-event projection snapshots — deterministic multi-state replay', () => {
  const options: V2ReplayProjectionOptions = {
    initialState: 'Planning',
    expectedConfigFingerprint: DEFAULT_FINGERPRINT,
    isTerminalState,
  };

  it('valid multi-state replay produces correct per-event snapshots in order', () => {
    const events = makeValidMultiStateFixture();
    const result = replayProjectV2Transitions(events, VOCAB, stateFor, options);

    // Two ROUTE_EVENT_EMITTED records → two snapshots.
    // Non-route events produce no snapshots.
    expect(result.snapshots).toHaveLength(2);

    // Snapshot 0: after PLAN_ACCEPTED — Planning → Implementing
    const snap0 = result.snapshots[0]!;
    expect(snap0.snapshotIndex).toBe(0);
    expect(snap0.sourceEventType).toBe(DomainEventName.ROUTE_EVENT_EMITTED);
    expect(snap0.currentState).toBe('Implementing');
    expect(snap0.appliedTransitions).toHaveLength(1);
    expect(snap0.appliedTransitions[0]!.eventName).toBe('PLAN_ACCEPTED');
    expect(snap0.quarantineDiagnostics).toHaveLength(0);
    expect(snap0.isTerminal).toBe(false);
    expect(snap0.terminalRouteEventId).toBeUndefined();

    // Snapshot 1: after POST_REVIEW_ACCEPTED — Implementing → completed (terminal)
    const snap1 = result.snapshots[1]!;
    expect(snap1.snapshotIndex).toBe(1);
    expect(snap1.currentState).toBe('completed');
    expect(snap1.appliedTransitions).toHaveLength(2);
    expect(snap1.appliedTransitions[1]!.eventName).toBe('POST_REVIEW_ACCEPTED');
    expect(snap1.isTerminal).toBe(true);
    expect(snap1.terminalRouteEventId).toBe('evt-post-review-001');
  });

  it('snapshot per quarantined event also produced (quarantine snapshot carries unchanged state)', () => {
    const events: ProjectableEvent[] = [
      makeRouteEvent({ routeEventId: 'evt-plan-001', eventName: 'PLAN_ACCEPTED', stateId: 'Planning' }),
      // Quarantine event (undeclared) — produces a snapshot with unchanged state
      {
        type: DomainEventName.ROUTE_EVENT_EMITTED,
        data: {
          schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
          schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
          configVersion: 2,
          configFingerprint: DEFAULT_FINGERPRINT,
          beadId: 'bead-001',
          stateId: 'Implementing',
          actionId: 'impl_action',
          runId: 'run-001',
          emitterType: 'verifier',
          emitterId: 'impl_verifier',
          eventName: 'STALE_UNDECLARED_EVENT',
          category: 'advance',
          evidenceRefs: [],
          routeEventId: 'stale-evt-001',
        }
      },
      makeRouteEvent({ routeEventId: 'evt-review-001', eventName: 'POST_REVIEW_ACCEPTED', stateId: 'Implementing' }),
    ];

    const result = replayProjectV2Transitions(events, VOCAB, stateFor, options);

    // Three ROUTE_EVENT_EMITTED records → three snapshots
    expect(result.snapshots).toHaveLength(3);

    // Snapshot 0: valid PLAN_ACCEPTED
    expect(result.snapshots[0]!.currentState).toBe('Implementing');
    expect(result.snapshots[0]!.quarantineDiagnostics).toHaveLength(0);

    // Snapshot 1: quarantine snapshot — state unchanged (still Implementing)
    expect(result.snapshots[1]!.currentState).toBe('Implementing');
    expect(result.snapshots[1]!.quarantineDiagnostics).toHaveLength(1);
    expect(result.snapshots[1]!.quarantineDiagnostics[0]!.reason).toBe('UNDECLARED_EVENT');
    expect(result.snapshots[1]!.appliedTransitions).toHaveLength(1);  // only PLAN_ACCEPTED

    // Snapshot 2: valid POST_REVIEW_ACCEPTED → terminal
    expect(result.snapshots[2]!.currentState).toBe('completed');
    expect(result.snapshots[2]!.isTerminal).toBe(true);
  });

  it('AC3 determinism proof: identical event log replayed twice produces identical snapshots', () => {
    const events = makeValidMultiStateFixture();

    const result1 = replayProjectV2Transitions(events, VOCAB, stateFor, options);
    const result2 = replayProjectV2Transitions(events, VOCAB, stateFor, options);

    // Same number of snapshots
    expect(result1.snapshots).toHaveLength(result2.snapshots.length);

    // Each snapshot matches exactly
    for (let i = 0; i < result1.snapshots.length; i++) {
      const s1 = result1.snapshots[i]!;
      const s2 = result2.snapshots[i]!;
      expect(s1.currentState).toBe(s2.currentState);
      expect(s1.isTerminal).toBe(s2.isTerminal);
      expect(s1.terminalRouteEventId).toBe(s2.terminalRouteEventId);
      expect(s1.appliedTransitions.length).toBe(s2.appliedTransitions.length);
      expect(s1.quarantineDiagnostics.length).toBe(s2.quarantineDiagnostics.length);
      for (let j = 0; j < s1.appliedTransitions.length; j++) {
        expect(s1.appliedTransitions[j]!.routeEventId).toBe(s2.appliedTransitions[j]!.routeEventId);
        expect(s1.appliedTransitions[j]!.eventName).toBe(s2.appliedTransitions[j]!.eventName);
        expect(s1.appliedTransitions[j]!.nextState).toBe(s2.appliedTransitions[j]!.nextState);
      }
    }

    // Final state and terminal status match
    expect(result1.finalState).toBe(result2.finalState);
    expect(result1.isTerminal).toBe(result2.isTerminal);
    expect(result1.terminalRouteEventId).toBe(result2.terminalRouteEventId);
    expect(result1.appliedTransitions.length).toBe(result2.appliedTransitions.length);
  });

  it('snapshots are independent copies — mutating one does not affect others', () => {
    const events = makeValidMultiStateFixture();
    const result = replayProjectV2Transitions(events, VOCAB, stateFor, options);

    // Verify that snapshot[0] appliedTransitions is a snapshot (copy), not a live reference
    const snap0TransitionCount = result.snapshots[0]!.appliedTransitions.length;
    const snap1TransitionCount = result.snapshots[1]!.appliedTransitions.length;

    // snap0 should have 1 transition (before the second event)
    expect(snap0TransitionCount).toBe(1);
    // snap1 should have 2 transitions (after both events)
    expect(snap1TransitionCount).toBe(2);

    // They are separate arrays (snap0 does not include snap1's transition)
    expect(result.snapshots[0]!.appliedTransitions[1]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC4: Terminal state enforcement — only via valid declared terminal transition
// ---------------------------------------------------------------------------

describe('AC4: terminal state enforcement — valid declared transition only (LOAD-BEARING)', () => {
  it('LOAD-BEARING: terminal reached ONLY via valid POST_REVIEW_ACCEPTED transition', () => {
    const options: V2ReplayProjectionOptions = {
      initialState: 'Planning',
      expectedConfigFingerprint: DEFAULT_FINGERPRINT,
      isTerminalState,
    };

    const events: ProjectableEvent[] = [
      makeRouteEvent({ routeEventId: 'evt-plan-001', eventName: 'PLAN_ACCEPTED', stateId: 'Planning' }),
      makeRouteEvent({ routeEventId: 'evt-review-001', eventName: 'POST_REVIEW_ACCEPTED', stateId: 'Implementing' }),
    ];

    const result = replayProjectV2Transitions(events, VOCAB, stateFor, options);

    expect(result.isTerminal).toBe(true);
    expect(result.terminalRouteEventId).toBe('evt-review-001');
    expect(result.finalState).toBe('completed');
  });

  it('LOAD-BEARING: old SUCCESS event (non-ROUTE_EVENT_EMITTED) does NOT mark terminal', () => {
    const options: V2ReplayProjectionOptions = {
      initialState: 'Implementing',
      expectedConfigFingerprint: DEFAULT_FINGERPRINT,
      isTerminalState,
    };

    // Old v1 SUCCESS event (not ROUTE_EVENT_EMITTED) appearing in a v2 replay log
    const events: ProjectableEvent[] = [
      { type: 'SUCCESS', data: { beadId: 'bead-001', transitionEvent: 'SUCCESS' } },
      { type: DomainEventName.STATE_TRANSITION_APPLIED, data: {
        beadId: 'bead-001', fromState: 'Implementing', nextState: 'completed',
        transitionEvent: 'SUCCESS'
      }},
    ];

    const result = replayProjectV2Transitions(events, VOCAB, stateFor, options);

    // LOAD-BEARING: terminal must NOT be reached via old SUCCESS path
    expect(result.isTerminal).toBe(false);
    expect(result.terminalRouteEventId).toBeUndefined();
    expect(result.finalState).toBe('Implementing');
    expect(result.appliedTransitions).toHaveLength(0);
  });

  it('LOAD-BEARING: undeclared event pointing to completed state → quarantined, NOT terminal', () => {
    const options: V2ReplayProjectionOptions = {
      initialState: 'Implementing',
      expectedConfigFingerprint: DEFAULT_FINGERPRINT,
      isTerminalState,
    };

    // Undeclared event with stateId=Implementing and nextState would be completed if allowed
    const undeclaredTerminalAttempt: ProjectableEvent = {
      type: DomainEventName.ROUTE_EVENT_EMITTED,
      data: {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
        schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
        configVersion: 2,
        configFingerprint: DEFAULT_FINGERPRINT,
        beadId: 'bead-001',
        stateId: 'Implementing',
        actionId: 'impl_action',
        runId: 'run-001',
        emitterType: 'verifier',
        emitterId: 'impl_verifier',
        eventName: 'UNDECLARED_COMPLETE_EVENT',  // ← not in vocab
        category: 'advance',
        evidenceRefs: [],
        routeEventId: 'undeclared-terminal-001',
      }
    };

    const result = replayProjectV2Transitions([undeclaredTerminalAttempt], VOCAB, stateFor, options);

    // LOAD-BEARING: undeclared event is quarantined; terminal NOT reached
    // If the vocab gate is removed, the event would attempt to look up the transition
    // (and might or might not find one) — but the quarantine diagnostic would be absent.
    expect(result.isTerminal).toBe(false);
    expect(result.terminalRouteEventId).toBeUndefined();
    expect(result.quarantineDiagnostics).toHaveLength(1);
    expect(result.quarantineDiagnostics[0]!.reason).toBe('UNDECLARED_EVENT');
    expect(result.finalState).toBe('Implementing');
  });

  it('LOAD-BEARING: model-authored route field (invalid emitterType) pointing toward terminal → quarantined, NOT terminal', () => {
    const options: V2ReplayProjectionOptions = {
      initialState: 'Implementing',
      expectedConfigFingerprint: DEFAULT_FINGERPRINT,
      isTerminalState,
    };

    const modelTerminalAttempt: ProjectableEvent = {
      type: DomainEventName.ROUTE_EVENT_EMITTED,
      data: {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
        schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
        configVersion: 2,
        configFingerprint: DEFAULT_FINGERPRINT,
        beadId: 'bead-001',
        stateId: 'Implementing',
        actionId: 'impl_action',
        runId: 'run-001',
        emitterType: 'model',  // ← invalid emitterType
        emitterId: 'llm-parser',
        eventName: 'POST_REVIEW_ACCEPTED',
        category: 'advance',
        evidenceRefs: [],
        routeEventId: 'model-terminal-001',
      }
    };

    const result = replayProjectV2Transitions([modelTerminalAttempt], VOCAB, stateFor, options);

    // LOAD-BEARING: schema-invalid emitterType quarantined; terminal NOT reached
    expect(result.isTerminal).toBe(false);
    expect(result.terminalRouteEventId).toBeUndefined();
    expect(result.quarantineDiagnostics).toHaveLength(1);
    expect(result.quarantineDiagnostics[0]!.reason).toBe('SCHEMA_INVALID');
    expect(result.finalState).toBe('Implementing');
  });

  it('isTerminalState absent → isTerminal always false (no terminal detection configured)', () => {
    const options: V2ReplayProjectionOptions = {
      initialState: 'Planning',
      // isTerminalState: not provided
    };

    const events: ProjectableEvent[] = [
      makeRouteEvent({ routeEventId: 'evt-plan-001', eventName: 'PLAN_ACCEPTED', stateId: 'Planning' }),
      makeRouteEvent({ routeEventId: 'evt-review-001', eventName: 'POST_REVIEW_ACCEPTED', stateId: 'Implementing' }),
    ];

    const result = replayProjectV2Transitions(events, VOCAB, stateFor, options);

    // State transitions correctly but terminal detection is disabled
    expect(result.finalState).toBe('completed');
    expect(result.appliedTransitions).toHaveLength(2);
    expect(result.isTerminal).toBe(false);
    expect(result.terminalRouteEventId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC5: Additional coverage — quarantine diagnostic schema validity
// ---------------------------------------------------------------------------

describe('AC5: quarantine diagnostic schema validity + DomainEventName registration', () => {
  it('V2_ROUTE_EVENT_QUARANTINED is defined in DomainEventName', () => {
    expect(DomainEventName.V2_ROUTE_EVENT_QUARANTINED).toBe('V2_ROUTE_EVENT_QUARANTINED');
  });

  it('V2_ROUTE_EVENT_QUARANTINED has schema metadata in DOMAIN_EVENT_SCHEMA_METADATA', () => {
    const meta = DOMAIN_EVENT_SCHEMA_METADATA[DomainEventName.V2_ROUTE_EVENT_QUARANTINED];
    expect(meta).toBeDefined();
    expect(meta!.replayImpact).toBe('INFORMATIONAL');
    expect(meta!.version).toBe(1);
    expect(meta!.optionalFields).toContain('eventName');
    expect(meta!.optionalFields).toContain('beadId');
  });

  it('V2_ROUTE_EVENT_QUARANTINED required fields match quarantine payload contract', () => {
    const schema = DOMAIN_EVENT_SCHEMAS[DomainEventName.V2_ROUTE_EVENT_QUARANTINED];
    expect(schema).toBeDefined();
    expect(schema).toContain('routeEventId');
    expect(schema).toContain('schemaId');
    expect(schema).toContain('configFingerprint');
    expect(schema).toContain('reason');
    expect(schema).toContain('lastValidState');
  });

  it('V2_ROUTE_EVENT_QUARANTINED is NOT in REPLAY_CRITICAL_EVENT_TYPES (diagnostic only)', async () => {
    const { REPLAY_CRITICAL_EVENT_TYPES } = await import('../src/constants/domain.js');
    expect(REPLAY_CRITICAL_EVENT_TYPES.has(DomainEventName.V2_ROUTE_EVENT_QUARANTINED)).toBe(false);
  });

  it('quarantine diagnostic carries required identity fields, no raw event bodies', () => {
    const options: V2ReplayProjectionOptions = {
      initialState: 'Planning',
      expectedConfigFingerprint: DEFAULT_FINGERPRINT,
      isTerminalState,
    };

    const badEvent: ProjectableEvent = {
      type: DomainEventName.ROUTE_EVENT_EMITTED,
      data: {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
        schemaVersion: '1.0.0',
        configVersion: 2,
        configFingerprint: DEFAULT_FINGERPRINT,
        beadId: 'bead-diag-001',
        stateId: 'Planning',
        actionId: 'plan_action',
        runId: 'run-001',
        emitterType: 'verifier',
        emitterId: 'plan_verifier',
        eventName: 'UNDECLARED_DIAGNOSTIC_TEST',
        category: 'advance',
        evidenceRefs: [],
        routeEventId: 'diag-test-001',
      }
    };

    const result = replayProjectV2Transitions([badEvent], VOCAB, stateFor, options);

    expect(result.quarantineDiagnostics).toHaveLength(1);
    const diag = result.quarantineDiagnostics[0]!;

    // Required fields
    expect(diag.routeEventId).toBe('diag-test-001');
    expect(diag.schemaId).toBe(ROUTE_EVENT_EMITTED_SCHEMA_ID);
    expect(diag.configFingerprint).toBe(DEFAULT_FINGERPRINT);
    expect(diag.reason).toBe('UNDECLARED_EVENT');
    expect(diag.lastValidState).toBe('Planning');

    // Optional identity fields (no raw bodies)
    expect(diag.eventName).toBe('UNDECLARED_DIAGNOSTIC_TEST');
    expect(diag.beadId).toBe('bead-diag-001');
    expect(diag.schemaVersion).toBe('1.0.0');

    // No raw event body fields — only identity
    // (TypeScript enforces this via RouteEventQuarantinedPayload shape)
    const diagKeys = Object.keys(diag);
    expect(diagKeys).not.toContain('evidenceRefs');
    expect(diagKeys).not.toContain('emitterId');
    expect(diagKeys).not.toContain('runId');
    expect(diagKeys).not.toContain('actionId');
  });
});

// ---------------------------------------------------------------------------
// Version gating: v1 / cerdiwen unaffected
// ---------------------------------------------------------------------------

describe('Version gating: v1 and projectV2Transitions unaffected by e8cm quarantine', () => {
  it('projectV2Transitions (6k8e baseline) is unchanged — still silently ignores invalid events', () => {
    // projectV2Transitions silently ignores bad events (no quarantine logic).
    // This is the existing behavior — e8cm adds replayProjectV2Transitions alongside it.
    const invalidRecord: ProjectableEvent = {
      type: DomainEventName.ROUTE_EVENT_EMITTED,
      data: {
        emitterType: 'model',  // invalid
        eventName: 'PLAN_ACCEPTED',
        routeEventId: 'old-proj-001',
      }
    };

    const transitions = projectV2Transitions([invalidRecord], VOCAB, stateFor);

    // Original projectV2Transitions silently ignores → no quarantine, no transitions
    expect(transitions).toHaveLength(0);
  });

  it('replayProjectV2Transitions with empty vocab → all ROUTE_EVENT_EMITTED records quarantined as SCHEMA_INVALID or UNDECLARED_EVENT', () => {
    // Simulate v1 with empty vocab — no events should advance
    const emptyVocab = new Map<string, string>();
    const options: V2ReplayProjectionOptions = {
      initialState: 'Planning',
    };

    const events: ProjectableEvent[] = [
      makeRouteEvent({ routeEventId: 'evt-001', eventName: 'PLAN_ACCEPTED', stateId: 'Planning' }),
    ];

    const result = replayProjectV2Transitions(events, emptyVocab, stateFor, options);

    // With empty vocab, PLAN_ACCEPTED is undeclared → quarantined
    expect(result.quarantineDiagnostics).toHaveLength(1);
    expect(result.quarantineDiagnostics[0]!.reason).toBe('UNDECLARED_EVENT');
    expect(result.finalState).toBe('Planning');
    expect(result.appliedTransitions).toHaveLength(0);
  });

  it('empty event log → zero snapshots, zero transitions, zero diagnostics', () => {
    const options: V2ReplayProjectionOptions = {
      initialState: 'Planning',
      expectedConfigFingerprint: DEFAULT_FINGERPRINT,
      isTerminalState,
    };

    const result = replayProjectV2Transitions([], VOCAB, stateFor, options);

    expect(result.snapshots).toHaveLength(0);
    expect(result.appliedTransitions).toHaveLength(0);
    expect(result.quarantineDiagnostics).toHaveLength(0);
    expect(result.finalState).toBe('Planning');
    expect(result.isTerminal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mixed fixture: multiple quarantine reasons in one log
// ---------------------------------------------------------------------------

describe('Mixed fixture: multiple quarantine reasons in one replay log', () => {
  const options: V2ReplayProjectionOptions = {
    initialState: 'Planning',
    expectedConfigFingerprint: DEFAULT_FINGERPRINT,
    isTerminalState,
  };

  it('mixed valid + four quarantine reasons in one log — correct snapshot sequence + final state', () => {
    const events: ProjectableEvent[] = [
      // 1. Valid: Planning → Implementing
      makeRouteEvent({ routeEventId: 'evt-plan-001', eventName: 'PLAN_ACCEPTED', stateId: 'Planning' }),

      // 2. SCHEMA_INVALID: missing routeEventId
      {
        type: DomainEventName.ROUTE_EVENT_EMITTED,
        data: {
          schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
          schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
          configVersion: 2,
          configFingerprint: DEFAULT_FINGERPRINT,
          beadId: 'bead-001',
          stateId: 'Implementing',
          actionId: 'action-a',
          runId: 'run-001',
          emitterType: 'verifier',
          emitterId: 'verifier-a',
          eventName: 'POST_REVIEW_ACCEPTED',
          category: 'advance',
          evidenceRefs: [],
          // routeEventId: absent ← SCHEMA_INVALID
        }
      },

      // 3. UNDECLARED_EVENT: eventName not in vocab
      {
        type: DomainEventName.ROUTE_EVENT_EMITTED,
        data: {
          schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
          schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
          configVersion: 2,
          configFingerprint: DEFAULT_FINGERPRINT,
          beadId: 'bead-001',
          stateId: 'Implementing',
          actionId: 'action-b',
          runId: 'run-001',
          emitterType: 'gate',
          emitterId: 'gate-b',
          eventName: 'OLD_V1_SUCCESS',
          category: 'advance',
          evidenceRefs: [],
          routeEventId: 'undeclared-mixed-001',
        }
      },

      // 4. STALE_CONFIG_FINGERPRINT: wrong fingerprint
      {
        type: DomainEventName.ROUTE_EVENT_EMITTED,
        data: {
          schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
          schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
          configVersion: 2,
          configFingerprint: ALT_FINGERPRINT,  // ← stale
          beadId: 'bead-001',
          stateId: 'Implementing',
          actionId: 'action-c',
          runId: 'run-001',
          emitterType: 'verifier',
          emitterId: 'verifier-c',
          eventName: 'POST_REVIEW_ACCEPTED',
          category: 'advance',
          evidenceRefs: [],
          routeEventId: 'stale-mixed-001',
        }
      },

      // 5. Valid: Implementing → completed (terminal)
      makeRouteEvent({
        routeEventId: 'evt-review-001',
        eventName: 'POST_REVIEW_ACCEPTED',
        stateId: 'Implementing',
        emitterType: 'gate',
        emitterId: 'review_gate',
      }),

      // 6. DUPLICATE_IDEMPOTENCY: same routeEventId as #5
      makeRouteEvent({
        routeEventId: 'evt-review-001',  // ← duplicate
        eventName: 'POST_REVIEW_ACCEPTED',
        stateId: 'Implementing',
        emitterType: 'gate',
        emitterId: 'review_gate',
      }),
    ];

    const result = replayProjectV2Transitions(events, VOCAB, stateFor, options);

    // 2 valid transitions applied
    expect(result.appliedTransitions).toHaveLength(2);
    expect(result.appliedTransitions[0]!.eventName).toBe('PLAN_ACCEPTED');
    expect(result.appliedTransitions[1]!.eventName).toBe('POST_REVIEW_ACCEPTED');

    // 4 quarantine diagnostics (one per quarantine reason)
    expect(result.quarantineDiagnostics).toHaveLength(4);
    const reasons = result.quarantineDiagnostics.map(d => d.reason);
    expect(reasons).toContain('SCHEMA_INVALID');
    expect(reasons).toContain('UNDECLARED_EVENT');
    expect(reasons).toContain('STALE_CONFIG_FINGERPRINT');
    expect(reasons).toContain('DUPLICATE_IDEMPOTENCY');

    // Terminal reached via valid transition
    expect(result.isTerminal).toBe(true);
    expect(result.terminalRouteEventId).toBe('evt-review-001');
    expect(result.finalState).toBe('completed');

    // 6 snapshots total (one per ROUTE_EVENT_EMITTED record)
    expect(result.snapshots).toHaveLength(6);

    // Snapshots are monotonically indexed
    for (let i = 0; i < result.snapshots.length; i++) {
      expect(result.snapshots[i]!.snapshotIndex).toBe(i);
    }
  });
});
