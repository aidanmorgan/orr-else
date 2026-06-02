import { describe, expect, it } from 'vitest';
import {
  createTeammateEventIdempotencyKey,
  decideTeammateEventProcessing,
  findAppliedTeammateSignal,
  validateTeammateEvent
} from '../src/core/TeammateEvents.js';
import { DomainEventName } from '../src/constants/index.js';

function transitionedEvent(overrides: Record<string, unknown> = {}) {
  const base = {
    type: 'STATE_TRANSITIONED' as const,
    beadId: 'pi-experiment-proof',
    workerId: 'worker-1',
    stateId: 'Implementation',
    timestamp: 1_779_000_000_000,
    actionId: 'surgical-execution',
    transitionEvent: 'SUCCESS',
    summary: 'Implementation completed.',
    evidence: 'Detailed evidence from submit_checkpoint.',
    handover: 'Detailed handover from submit_checkpoint.'
  };
  return {
    ...base,
    idempotencyKey: createTeammateEventIdempotencyKey(base),
    ...overrides
  };
}

describe('TeammateEvents', () => {
  it('validates typed state-transition events with required semantic fields', () => {
    const result = validateTeammateEvent(transitionedEvent());

    expect(result.ok).toBe(true);
    expect(result.event?.type).toBe('STATE_TRANSITIONED');
  });

  it('validates harness restart requests as status-mutating teammate events', () => {
    const result = validateTeammateEvent(transitionedEvent({
      type: 'HARNESS_RESTART_REQUESTED',
      transitionEvent: 'HARNESS_RESTART',
      summary: 'Transient transport failure.',
      evidence: 'WebSocket error observed by Pi.',
      handover: 'Retry Planning in a fresh harness session.'
    }));

    expect(result.ok).toBe(true);
    expect(result.event?.type).toBe('HARNESS_RESTART_REQUESTED');
  });

  it('rejects checkpoint and transition events missing action, transition, summary, evidence, or handover', () => {
    const result = validateTeammateEvent(transitionedEvent({ evidence: '' }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('evidence');
  });

  it('uses idempotency keys for duplicate suppression and state ids for order checks', () => {
    const event = transitionedEvent();
    expect(decideTeammateEventProcessing(event as any, new Set([event.idempotencyKey]), 'Implementation')).toEqual({
      action: 'duplicate',
      reason: 'Already processed idempotency key'
    });

    const outOfOrder = decideTeammateEventProcessing(event as any, new Set(), 'AdversarialPostReview');
    // Out-of-order signals are categorized as OUT_OF_ORDER (distinct from plain IGNORE),
    // so operators can tell a stale/superseded signal from an unrelated ignore decision.
    expect(outOfOrder.action).toBe('out_of_order');
    expect(outOfOrder.reason).toContain('Out-of-order');

    expect(decideTeammateEventProcessing(event as any, new Set(), 'Implementation')).toEqual({ action: 'accept' });
  });

  it('categorizes an out-of-order signal as OUT_OF_ORDER (not IGNORE or DUPLICATE)', () => {
    // A signal whose stateId does not match the current coordinator bead state
    // must be categorized as OUT_OF_ORDER, which is a distinct value from IGNORE
    // and DUPLICATE.  This allows operators to distinguish stale/superseded
    // signals from other decisions without changing the no-double-mutation guarantee.
    const event = transitionedEvent({ stateId: 'PlanningPhase' });
    const decision = decideTeammateEventProcessing(event as any, new Set(), 'ImplementationPhase');

    expect(decision.action).toBe('out_of_order');
    expect(decision.action).not.toBe('ignore');
    expect(decision.action).not.toBe('duplicate');
    expect(decision.reason).toContain('PlanningPhase');
    expect(decision.reason).toContain('ImplementationPhase');
  });

  it('builds semantic idempotency keys that are stable across retry timestamps', () => {
    const base = transitionedEvent();
    const first = createTeammateEventIdempotencyKey({ ...base, timestamp: 1_779_000_000_001 } as any);
    const retry = createTeammateEventIdempotencyKey({ ...base, timestamp: 1_779_000_000_999 } as any);

    expect(first).toBe(retry);

    const heartbeat = {
      type: 'HEARTBEAT' as const,
      beadId: 'pi-experiment-proof',
      workerId: 'worker-1',
      stateId: 'Implementation',
      timestamp: 1
    };
    expect(createTeammateEventIdempotencyKey(heartbeat)).toBe(
      createTeammateEventIdempotencyKey({ ...heartbeat, timestamp: 2 })
    );
  });

  it('does not mutate the input body and returns a new event object with truncated handover', () => {
    // Build an event with a handover that exceeds the 8 KiB write limit (8192 bytes).
    const longHandover = 'x'.repeat(9000);
    const input = transitionedEvent({ handover: longHandover });

    // Freeze the input so any in-place write throws a TypeError in strict mode.
    const frozen = Object.freeze(input);

    const result = validateTeammateEvent(frozen);

    expect(result.ok).toBe(true);
    // (a) Input object must NOT be mutated — the original handover is intact.
    expect(frozen.handover).toBe(longHandover);
    // (b) Returned event is a distinct object (referential inequality).
    expect(result.event).not.toBe(frozen);
    // (c) Returned event carries the truncated handover.
    expect(result.event?.handover.length).toBeLessThan(longHandover.length);
    expect(result.event?.handover).toContain('[handover truncated at');
  });

  it('recognizes already-applied semantic signals from durable events', () => {
    const event = transitionedEvent();
    const applied = findAppliedTeammateSignal([
      {
        type: DomainEventName.STATE_TRANSITION_APPLIED,
        data: {
          beadId: event.beadId,
          fromState: event.stateId,
          actionId: event.actionId,
          transitionEvent: event.transitionEvent
        }
      }
    ], event as any);

    expect(applied?.type).toBe(DomainEventName.STATE_TRANSITION_APPLIED);
  });
});
