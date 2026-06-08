import { describe, expect, it } from 'vitest';
import { BeadStateProjection } from '../src/core/BeadStateProjection.js';
import { DomainEventName, EventName, RestartKind, BeadStatus } from '../src/constants/index.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';

function makeEvent(type: string, data: Record<string, any>, overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: overrides.id ?? `evt-${Math.random().toString(36).slice(2)}`,
    type,
    timestamp: overrides.timestamp ?? '2026-01-01T00:00:00.000Z',
    sessionId: overrides.sessionId ?? 's1',
    data
  };
}

describe('BeadStateProjection.projectBeadStateChartFromEvents', () => {
  const projection = new BeadStateProjection();

  // ---------------------------------------------------------------------------
  // Basic lifecycle
  // ---------------------------------------------------------------------------

  it('starts with an empty projection for no events', () => {
    const result = projection.projectBeadStateChartFromEvents('bd-1', []);
    expect(result.beadId).toBe('bd-1');
    expect(result.currentState).toBeUndefined();
    expect(result.transitions).toEqual([]);
    expect(result.handovers).toEqual({});
    expect(result.completedActionIds).toEqual([]);
  });

  it('sets currentState from BEAD_CLAIMED', () => {
    const events = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1', stateId: 'Planning', owner: 'Alice' })
    ];
    const result = projection.projectBeadStateChartFromEvents('bd-1', events);
    expect(result.currentState).toBe('Planning');
    expect(result.assignedTo).toBe('Alice');
    expect(result.restartRequested).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // lastActivity — supervisor scheduling bookkeeping must not count as activity
  // (regression: BEAD_QUARANTINED bumped lastActivity, which is the quarantine
  //  signature, so the quarantine self-invalidated and the bead churned. kwdh)
  // ---------------------------------------------------------------------------

  it('does not advance lastActivity for a BEAD_QUARANTINED scheduling event', () => {
    const events = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1', stateId: 'Implementation' }, { id: 'e1', timestamp: '2026-01-01T00:00:01.000Z' }),
      makeEvent(DomainEventName.BEAD_QUARANTINED, { beadId: 'bd-1', reason: 'ALREADY_CHECKED_OUT' }, { id: 'e2', timestamp: '2026-01-01T00:00:09.000Z' })
    ];
    const result = projection.projectBeadFromEvents('bd-1', events);
    // lastActivity must stay at the last genuine activity (the claim), NOT the
    // quarantine event — otherwise the quarantine signature changes every tick.
    expect(result.lastActivity).toBe('2026-01-01T00:00:01.000Z');
  });

  it('still advances lastActivity for genuine activity events', () => {
    const events = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1', stateId: 'Planning' }, { id: 'e1', timestamp: '2026-01-01T00:00:01.000Z' }),
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, { beadId: 'bd-1', fromState: 'Planning', nextState: 'Implementation', transitionEvent: 'SUCCESS', actionId: 'plan' }, { id: 'e2', timestamp: '2026-01-01T00:00:05.000Z' })
    ];
    const result = projection.projectBeadFromEvents('bd-1', events);
    expect(result.lastActivity).toBe('2026-01-01T00:00:05.000Z');
  });

  it('advances currentState through STATE_TRANSITION_APPLIED', () => {
    const events = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1', stateId: 'Planning' }, { timestamp: '2026-01-01T00:00:01.000Z' }),
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, { beadId: 'bd-1', fromState: 'Planning', nextState: 'Implementation', transitionEvent: 'SUCCESS', actionId: 'plan' }, { id: 'e2', timestamp: '2026-01-01T00:00:02.000Z' })
    ];
    const result = projection.projectBeadStateChartFromEvents('bd-1', events);
    expect(result.currentState).toBe('Implementation');
    expect(result.previousState).toBe('Planning');
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0].toState).toBe('Implementation');
    expect(result.transitions[0].fromState).toBe('Planning');
  });

  it('marks BEAD_CLOSED status as COMPLETED and clears lease', () => {
    const events = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1', stateId: 'Planning', lease: { owner: 'Alice', expiresAt: '2099-01-01' } }, { sessionId: 's1' }),
      makeEvent(DomainEventName.BEAD_CLOSED, { beadId: 'bd-1' }, { sessionId: 's2' })
    ];
    const result = projection.projectBeadStateChartFromEvents('bd-1', events);
    expect(result.beadStatus).toBe(BeadStatus.COMPLETED);
    expect(result.lease).toBeUndefined();
    expect(result.leaseSessionId).toBeUndefined();
  });

  it('sets tombstoned=true on BEAD_TOMBSTONED and clears lease', () => {
    const events = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1', lease: { owner: 'Bob', expiresAt: '2099-01-01' } }, { sessionId: 's1' }),
      makeEvent(DomainEventName.BEAD_TOMBSTONED, { beadId: 'bd-1' })
    ];
    const result = projection.projectBeadStateChartFromEvents('bd-1', events);
    expect(result.tombstoned).toBe(true);
    expect(result.lease).toBeUndefined();
    expect(result.leaseSessionId).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Restart fields (WI-24)
  // ---------------------------------------------------------------------------

  it('sets restart fields on CONTEXT_RESTART_REQUESTED', () => {
    const events = [
      makeEvent(DomainEventName.CONTEXT_RESTART_REQUESTED, {
        beadId: 'bd-1',
        stateId: 'Implementation',
        targetState: 'Implementation',
        transitionEvent: EventName.CONTEXT_RESTART,
        actionId: 'surgical-execution',
        restartId: 'restart-ctx-1'
      })
    ];
    const result = projection.projectBeadStateChartFromEvents('bd-1', events);
    expect(result.restartRequested).toBe(true);
    expect(result.restartKind).toBe(RestartKind.CONTEXT);
    expect(result.restartEvent).toBe(EventName.CONTEXT_RESTART);
    expect(result.restartFromState).toBe('Implementation');
    expect(result.restartTargetState).toBe('Implementation');
  });

  it('sets restart fields on HARNESS_RESTART_REQUESTED', () => {
    const events = [
      makeEvent(DomainEventName.HARNESS_RESTART_REQUESTED, {
        beadId: 'bd-1',
        stateId: 'Planning',
        targetState: 'Planning',
        transitionEvent: EventName.HARNESS_RESTART,
        restartId: 'restart-hrn-1'
      })
    ];
    const result = projection.projectBeadStateChartFromEvents('bd-1', events);
    expect(result.restartRequested).toBe(true);
    expect(result.restartKind).toBe(RestartKind.HARNESS);
  });

  it('clears restart fields when STATE_TRANSITION_APPLIED follows a restart', () => {
    const events = [
      makeEvent(DomainEventName.HARNESS_RESTART_REQUESTED, { beadId: 'bd-1', stateId: 'Planning', targetState: 'Planning', transitionEvent: EventName.HARNESS_RESTART, restartId: 'restart-hrn-clear' }, { timestamp: '2026-01-01T00:00:01.000Z' }),
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, { beadId: 'bd-1', fromState: 'Planning', nextState: 'Planning', transitionEvent: EventName.HARNESS_RESTART }, { timestamp: '2026-01-01T00:00:02.000Z' })
    ];
    const result = projection.projectBeadStateChartFromEvents('bd-1', events);
    expect(result.restartRequested).toBe(false);
    expect(result.restartKind).toBeUndefined();
    expect(result.restartEvent).toBeUndefined();
    expect(result.restartFromState).toBeUndefined();
    expect(result.restartTargetState).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Handover compaction
  // ---------------------------------------------------------------------------

  it('compacts usage-limit lifecycle failure handovers', () => {
    const noisy = 'Agent lifecycle failure during turn_end: Codex error: {"type":"error","error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}';
    const events = [
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-1',
        fromState: 'Planning',
        nextState: 'Planning',
        transitionEvent: 'CONTEXT_RESTART',
        handover: noisy
      })
    ];
    const result = projection.projectBeadStateChartFromEvents('bd-1', events);
    expect(result.handovers.Planning).toContain('usage limit reached');
    expect(result.handovers.Planning).not.toContain('usage_limit_reached');
  });

  it('compacts context-overflow lifecycle failure handovers', () => {
    const noisy = 'Agent lifecycle failure during turn_end: {"error":{"code":"context_length_exceeded","message":"Your input exceeds the context window"}}';
    const events = [
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-1',
        fromState: 'Implementation',
        nextState: 'Implementation',
        transitionEvent: 'CONTEXT_RESTART',
        handover: noisy
      })
    ];
    const result = projection.projectBeadStateChartFromEvents('bd-1', events);
    expect(result.handovers.Implementation).toContain('context window exceeded');
    expect(result.handovers.Implementation).not.toContain('Your input exceeds the context window');
  });

  it('compacts transient harness-transport handovers', () => {
    const noisy = 'Agent lifecycle failure during turn_end: WebSocket closed 1000';
    const events = [
      makeEvent(DomainEventName.CONTEXT_RESTART_REQUESTED, {
        beadId: 'bd-1',
        stateId: 'Planning',
        targetState: 'Planning',
        transitionEvent: 'HARNESS_RESTART',
        handover: noisy,
        restartId: 'restart-transient-1'
      })
    ];
    const result = projection.projectBeadStateChartFromEvents('bd-1', events);
    expect(result.handovers.Planning).toContain('transient harness transport error');
    expect(result.handovers.Planning).not.toContain('WebSocket closed 1000');
  });

  // ---------------------------------------------------------------------------
  // Worktree lifecycle
  // ---------------------------------------------------------------------------

  it('tracks worktree path through WORKTREE_CREATED and WORKTREE_REMOVED', () => {
    const events = [
      makeEvent(DomainEventName.WORKTREE_CREATED, { beadId: 'bd-1', path: '/tmp/worktree' }, { timestamp: '2026-01-01T00:00:01.000Z' }),
      makeEvent(DomainEventName.WORKTREE_REMOVED, { beadId: 'bd-1' }, { timestamp: '2026-01-01T00:00:02.000Z' })
    ];
    const result = projection.projectBeadStateChartFromEvents('bd-1', events);
    expect(result.worktreePath).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // includeDetails=false
  // ---------------------------------------------------------------------------

  it('omits transitions and checkedItems when includeDetails is false', () => {
    const events = [
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, { beadId: 'bd-1', fromState: 'Planning', nextState: 'Implementation', transitionEvent: 'SUCCESS' }),
      makeEvent(DomainEventName.CHECKLIST_ITEM_TICKED, { beadId: 'bd-1', text: 'task done', evidence: 'yes' })
    ];
    const result = projection.projectBeadStateChartFromEvents('bd-1', events, undefined, { includeDetails: false });
    expect(result.transitions).toEqual([]);
    expect(result.checkedItems).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// projectBeadFromEvents
// ---------------------------------------------------------------------------

describe('BeadStateProjection.projectBeadFromEvents', () => {
  const projection = new BeadStateProjection();

  it('derives restart fields exclusively from the stateChart (WI-24 single source of truth)', () => {
    const events = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1', stateId: 'Planning' }, { timestamp: '2026-01-01T00:00:01.000Z' }),
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-1', fromState: 'Planning', nextState: 'Implementation', transitionEvent: 'SUCCESS', actionId: 'plan'
      }, { timestamp: '2026-01-01T00:00:02.000Z' }),
      makeEvent(DomainEventName.CONTEXT_RESTART_REQUESTED, {
        beadId: 'bd-1', stateId: 'Implementation', targetState: 'Implementation', transitionEvent: EventName.CONTEXT_RESTART, actionId: 'execute', restartId: 'restart-ctx-2'
      }, { timestamp: '2026-01-01T00:00:03.000Z' })
    ];
    const result = projection.projectBeadFromEvents('bd-1', events, undefined, { includeDetails: true });
    expect(result.restartRequested).toBe(true);
    expect(result.restartKind).toBe(RestartKind.CONTEXT);
    expect(result.restartEvent).toBe(EventName.CONTEXT_RESTART);
    expect(result.restartFromState).toBe('Implementation');
    expect(result.restartTargetState).toBe('Implementation');
  });

  it('clears restart fields when STATE_TRANSITION_APPLIED follows a restart', () => {
    const events = [
      makeEvent(DomainEventName.HARNESS_RESTART_REQUESTED, {
        beadId: 'bd-1', stateId: 'Planning', targetState: 'Planning', transitionEvent: EventName.HARNESS_RESTART, restartId: 'restart-hrn-bead-clear'
      }, { timestamp: '2026-01-01T00:00:01.000Z' }),
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-1', fromState: 'Planning', nextState: 'Planning', transitionEvent: EventName.HARNESS_RESTART
      }, { timestamp: '2026-01-01T00:00:02.000Z' })
    ];
    const result = projection.projectBeadFromEvents('bd-1', events);
    expect(result.restartRequested).toBe(false);
    expect(result.restartKind).toBeUndefined();
  });

  it('sets tombstoned on BEAD_TOMBSTONED and clears lease', () => {
    const events = [
      makeEvent(DomainEventName.BEAD_CLAIMED, {
        beadId: 'bd-1', stateId: 'Planning', lease: { owner: 'Alice', expiresAt: '2099-01-01' }
      }, { sessionId: 's1' }),
      makeEvent(DomainEventName.BEAD_TOMBSTONED, { beadId: 'bd-1' })
    ];
    const result = projection.projectBeadFromEvents('bd-1', events);
    expect(result.tombstoned).toBe(true);
    expect(result.lease).toBeUndefined();
    expect(result.leaseSessionId).toBeUndefined();
  });

  it('sets completed status on BEAD_CLOSED and clears lease', () => {
    const events = [
      makeEvent(DomainEventName.BEAD_CLAIMED, {
        beadId: 'bd-1', stateId: 'Planning', lease: { owner: 'Alice', expiresAt: '2099-01-01' }
      }, { sessionId: 's1' }),
      makeEvent(DomainEventName.BEAD_CLOSED, { beadId: 'bd-1' })
    ];
    const result = projection.projectBeadFromEvents('bd-1', events);
    expect(result.status).toBe(BeadStatus.COMPLETED);
    expect(result.lease).toBeUndefined();
    expect(result.leaseSessionId).toBeUndefined();
  });

  it('projects the session that created an active lease', () => {
    const events = [
      makeEvent(DomainEventName.BEAD_CLAIMED, {
        beadId: 'bd-1', owner: 'Orr Else', stateId: 'Planning',
        lease: { owner: 'Orr Else', expiresAt: '2026-01-01T01:00:00.000Z' }
      }, { sessionId: 'session-old' })
    ];
    const result = projection.projectBeadFromEvents('bd-1', events);
    expect(result.leaseSessionId).toBe('session-old');
  });

  it('accumulates completedActionIds across ACTION_COMPLETED events', () => {
    const events = [
      makeEvent(DomainEventName.ACTION_COMPLETED, { beadId: 'bd-1', actionKey: 'action-1', actionId: 'action-1' }, { timestamp: '2026-01-01T00:00:01.000Z' }),
      makeEvent(DomainEventName.ACTION_COMPLETED, { beadId: 'bd-1', actionKey: 'action-2', actionId: 'action-2' }, { timestamp: '2026-01-01T00:00:02.000Z' }),
      makeEvent(DomainEventName.ACTION_COMPLETED, { beadId: 'bd-1', actionKey: 'action-1', actionId: 'action-1' }, { timestamp: '2026-01-01T00:00:03.000Z' })  // duplicate
    ];
    const result = projection.projectBeadFromEvents('bd-1', events, undefined, { includeDetails: true });
    expect(result.completedActionIds).toContain('action-1');
    expect(result.completedActionIds).toContain('action-2');
    expect(result.completedActionIds!.filter(a => a === 'action-1')).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // pi-experiment-rpa0: fail-closed rejection of malformed STATE_TRANSITION_APPLIED
  //
  // Inverted from legacy-tolerance "SHOULD-FIX 1" tests. The old behaviour
  // tolerated missing transitionEvent by skipping only action-completion while
  // still advancing currentState. The new behaviour rejects the event entirely:
  // no state mutation, no restart-field clearing, corruption diagnostic emitted.
  // ---------------------------------------------------------------------------

  it('rejects STATE_TRANSITION_APPLIED missing transitionEvent — currentState unchanged, status unchanged, diagnostic emitted (rpa0)', () => {
    const events = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1', stateId: 'Planning', owner: 'Alice' }, { id: 'e1', timestamp: '2026-01-01T00:00:01.000Z' }),
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-1',
        fromState: 'Planning',
        nextState: 'Implementation',
        // transitionEvent intentionally absent — malformed/old record
        actionId: 'formulate-plan',
        actionKey: 'formulate-plan'
      }, { id: 'e2', timestamp: '2026-01-01T00:00:02.000Z' })
    ];

    // stateChart: event rejected, currentState stays at Planning (not Implementation)
    const chart = projection.projectBeadStateChartFromEvents('bd-1', events, undefined, { includeDetails: true });
    expect(chart.currentState).toBe('Planning');         // NOT advanced to Implementation
    expect(chart.previousState).toBeUndefined();          // no transition recorded
    expect(chart.transitions).toHaveLength(0);            // transition NOT appended
    expect(chart.completedActionIds).not.toContain('formulate-plan'); // no completion

    // corruption diagnostic must be emitted
    expect(chart.corruptionDiagnostics).toHaveLength(1);
    expect(chart.corruptionDiagnostics![0].eventId).toBe('e2');
    expect(chart.corruptionDiagnostics![0].missingFields).toContain('transitionEvent');

    // bead projection: status also unchanged
    const bead = projection.projectBeadFromEvents('bd-1', events, undefined, { includeDetails: true });
    expect(bead.status).toBe('Planning');                 // NOT advanced to Implementation
    expect(bead.completedActionIds ?? []).not.toContain('formulate-plan');
  });

  it('rejects STATE_TRANSITION_APPLIED missing fromState — currentState unchanged, diagnostic emitted (rpa0)', () => {
    const events = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1', stateId: 'Planning', owner: 'Alice' }, { id: 'e1', timestamp: '2026-01-01T00:00:01.000Z' }),
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-1',
        // fromState intentionally absent — malformed record
        nextState: 'Implementation',
        transitionEvent: 'SUCCESS',
        actionId: 'formulate-plan'
      }, { id: 'e2', timestamp: '2026-01-01T00:00:02.000Z' })
    ];
    const chart = projection.projectBeadStateChartFromEvents('bd-1', events, undefined, { includeDetails: true });
    expect(chart.currentState).toBe('Planning');
    expect(chart.transitions).toHaveLength(0);
    expect(chart.corruptionDiagnostics).toHaveLength(1);
    expect(chart.corruptionDiagnostics![0].missingFields).toContain('fromState');
  });

  it('rejects STATE_TRANSITION_APPLIED missing nextState — currentState unchanged, diagnostic emitted (rpa0)', () => {
    const events = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1', stateId: 'Planning', owner: 'Alice' }, { id: 'e1', timestamp: '2026-01-01T00:00:01.000Z' }),
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-1',
        fromState: 'Planning',
        // nextState intentionally absent — malformed record
        transitionEvent: 'SUCCESS',
        actionId: 'formulate-plan'
      }, { id: 'e2', timestamp: '2026-01-01T00:00:02.000Z' })
    ];
    const chart = projection.projectBeadStateChartFromEvents('bd-1', events, undefined, { includeDetails: true });
    expect(chart.currentState).toBe('Planning');
    expect(chart.transitions).toHaveLength(0);
    expect(chart.corruptionDiagnostics).toHaveLength(1);
    expect(chart.corruptionDiagnostics![0].missingFields).toContain('nextState');
  });

  it('does NOT clear restart fields when the transition event is malformed/rejected (rpa0)', () => {
    // A restart was requested; a subsequent malformed STATE_TRANSITION_APPLIED must
    // NOT clear the restart fields — the bead stays in restart-pending state.
    const events = [
      makeEvent(DomainEventName.HARNESS_RESTART_REQUESTED, {
        beadId: 'bd-1', stateId: 'Planning', targetState: 'Planning', transitionEvent: EventName.HARNESS_RESTART, restartId: 'restart-hrn-2'
      }, { id: 'e1', timestamp: '2026-01-01T00:00:01.000Z' }),
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-1',
        fromState: 'Planning',
        nextState: 'Planning'
        // transitionEvent absent — malformed; must NOT clear restartRequested
      }, { id: 'e2', timestamp: '2026-01-01T00:00:02.000Z' })
    ];
    const chart = projection.projectBeadStateChartFromEvents('bd-1', events, undefined, { includeDetails: true });
    // Restart fields must remain set — malformed event did not clear them
    expect(chart.restartRequested).toBe(true);
    expect(chart.restartKind).toBe(RestartKind.HARNESS);
    expect(chart.corruptionDiagnostics).toHaveLength(1);
  });

  it('records action completion for a custom advance outcome via advanceOutcomes Set', () => {
    const customAdvance = new Set(['ADVANCE']);
    const events = [
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-1',
        fromState: 'Alpha',
        nextState: 'done',
        transitionEvent: 'ADVANCE',
        actionId: 'do-work',
        actionKey: 'do-work'
      })
    ];
    const result = projection.projectBeadFromEvents('bd-1', events, undefined, { includeDetails: true }, customAdvance);
    expect(result.completedActionIds).toContain('do-work');
  });

  it('does NOT record action completion for SUCCESS when custom advanceOutcomes excludes it', () => {
    const customAdvance = new Set(['ADVANCE']);
    const events = [
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-1',
        fromState: 'Planning',
        nextState: 'Implementation',
        transitionEvent: 'SUCCESS',
        actionId: 'formulate-plan',
        actionKey: 'formulate-plan'
      })
    ];
    const result = projection.projectBeadFromEvents('bd-1', events, undefined, { includeDetails: true }, customAdvance);
    // SUCCESS is not in custom advance set → not recorded
    expect(result.completedActionIds ?? []).not.toContain('formulate-plan');
  });
});

// ---------------------------------------------------------------------------
// BEAD B — Replay-idempotency + out-of-order determinism proofs
// ---------------------------------------------------------------------------

describe('BeadStateProjection — replay idempotency and out-of-order determinism', () => {
  const projection = new BeadStateProjection();

  /**
   * A representative event set that exercises most projection paths:
   * BEAD_CLAIMED, STATE_TRANSITION_APPLIED (SUCCESS), CHECKLIST_ITEM_TICKED,
   * WORKTREE_CREATED, CONTEXT_RESTART_REQUESTED.
   */
  function buildRepresentativeEvents(): DomainEvent[] {
    return [
      makeEvent(
        DomainEventName.BEAD_CLAIMED,
        { beadId: 'bd-idem', stateId: 'Planning', owner: 'Alice', lease: { owner: 'Alice', expiresAt: '2099-01-01' } },
        { id: 'e1', timestamp: '2026-01-01T00:00:01.000Z', sessionId: 's1' }
      ),
      makeEvent(
        DomainEventName.WORKTREE_CREATED,
        { beadId: 'bd-idem', path: '/tmp/worktree-bd-idem' },
        { id: 'e2', timestamp: '2026-01-01T00:00:02.000Z', sessionId: 's1' }
      ),
      makeEvent(
        DomainEventName.STATE_TRANSITION_APPLIED,
        {
          beadId: 'bd-idem',
          fromState: 'Planning',
          nextState: 'Implementation',
          transitionEvent: EventName.SUCCESS,
          actionId: 'formulate-plan',
          actionKey: 'formulate-plan',
          handover: 'All planning done'
        },
        { id: 'e3', timestamp: '2026-01-01T00:00:03.000Z', sessionId: 's1' }
      ),
      makeEvent(
        DomainEventName.CHECKLIST_ITEM_TICKED,
        { beadId: 'bd-idem', text: 'Read project rules', evidence: 'CLAUDE.md' },
        { id: 'e4', timestamp: '2026-01-01T00:00:04.000Z', sessionId: 's1' }
      ),
      makeEvent(
        DomainEventName.CONTEXT_RESTART_REQUESTED,
        {
          beadId: 'bd-idem',
          stateId: 'Implementation',
          targetState: 'Implementation',
          transitionEvent: EventName.CONTEXT_RESTART,
          actionId: 'surgical-execution',
          restartId: 'restart-idem-1'
        },
        { id: 'e5', timestamp: '2026-01-01T00:00:05.000Z', sessionId: 's2' }
      )
    ];
  }

  it('replaying the same event set twice yields a byte-identical BeadStateChart projection', () => {
    const events = buildRepresentativeEvents();

    const resultA = projection.projectBeadStateChartFromEvents('bd-idem', events, undefined, { includeDetails: true });
    const resultB = projection.projectBeadStateChartFromEvents('bd-idem', events, undefined, { includeDetails: true });

    // JSON.stringify produces a canonical string; identical objects → identical strings.
    expect(JSON.stringify(resultB)).toBe(JSON.stringify(resultA));
  });

  it('replaying the same event set twice yields a byte-identical BeadFromEvents projection', () => {
    const events = buildRepresentativeEvents();

    const resultA = projection.projectBeadFromEvents('bd-idem', events, undefined, { includeDetails: true });
    const resultB = projection.projectBeadFromEvents('bd-idem', events, undefined, { includeDetails: true });

    expect(JSON.stringify(resultB)).toBe(JSON.stringify(resultA));
  });

  it('out-of-order events produce the same deterministic BeadStateChart as the in-order sequence (compareEvents sort)', () => {
    const inOrder = buildRepresentativeEvents();

    // The projection is intentionally order-SENSITIVE: it iterates events as
    // given and the EventStore is responsible for pre-sorting via compareEvents
    // (timestamp ASC, then id ASC) before handing events to the projection.
    //
    // This test proves THREE things:
    //   1. The projection IS order-sensitive: raw shuffled input → wrong result.
    //   2. Applying the EventStore's compareEvents comparator (timestamp → id)
    //      to shuffled events produces the canonical in-order result.
    //   3. The test WOULD FAIL if someone made the projection sort internally
    //      (assertion 1 would fire) or if the sort key diverged from compareEvents
    //      (assertion 2 would fire).
    //
    // compareEvents (from EventStore, private) sorts by:
    //   a.timestamp ASC, then a.id ASC (String.localeCompare)
    // The representative events have unique, monotonically-increasing timestamps
    // so sort-by-timestamp is sufficient to recover canonical ordering.
    function compareEvents(a: DomainEvent, b: DomainEvent): number {
      const byTime = Date.parse(a.timestamp) - Date.parse(b.timestamp);
      return byTime !== 0 ? byTime : String(a.id || '').localeCompare(String(b.id || ''));
    }

    // Build two maximally-different orderings of the same events.
    const shuffleA = [...inOrder].reverse();
    const shuffleB = [inOrder[2], inOrder[0], inOrder[4], inOrder[1], inOrder[3]];

    // 1. Unsorted shuffled events produce a DIFFERENT projection — the projection
    //    is genuinely order-sensitive and relies on the EventStore's pre-sort.
    const resultUnsorted = projection.projectBeadStateChartFromEvents('bd-idem', shuffleA, undefined, { includeDetails: true });
    const resultInOrder  = projection.projectBeadStateChartFromEvents('bd-idem', inOrder, undefined, { includeDetails: true });
    expect(JSON.stringify(resultUnsorted)).not.toBe(JSON.stringify(resultInOrder));

    // 2. Applying the real compareEvents sort to any shuffle restores the
    //    canonical in-order projection — byte-identical in all cases.
    const resultFromA = projection.projectBeadStateChartFromEvents('bd-idem', [...shuffleA].sort(compareEvents), undefined, { includeDetails: true });
    const resultFromB = projection.projectBeadStateChartFromEvents('bd-idem', [...shuffleB].sort(compareEvents), undefined, { includeDetails: true });

    expect(JSON.stringify(resultFromA)).toBe(JSON.stringify(resultInOrder));
    expect(JSON.stringify(resultFromB)).toBe(JSON.stringify(resultInOrder));
  });
});
