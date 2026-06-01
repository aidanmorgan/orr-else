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
    expect(outOfOrder.action).toBe('ignore');
    expect(outOfOrder.reason).toContain('Out-of-order');

    expect(decideTeammateEventProcessing(event as any, new Set(), 'Implementation')).toEqual({ action: 'accept' });
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
