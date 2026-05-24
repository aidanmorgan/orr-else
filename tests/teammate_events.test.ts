import { describe, expect, it } from 'vitest';
import {
  createTeammateEventIdempotencyKey,
  decideTeammateEventProcessing,
  validateTeammateEvent
} from '../src/core/TeammateEvents.js';

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
});
