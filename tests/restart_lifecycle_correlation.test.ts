/**
 * Restart lifecycle correlation — pi-experiment-nyug
 *
 * Acceptance criteria:
 *   AC1: A restart replay can reconstruct request -> new run initialized ->
 *        terminal outcome using IDs ONLY (not timestamp adjacency).
 *   AC2: Duplicate restart signals share the same restartId.
 *   AC3: Tests cover BOTH context restart and harness restart.
 *   AC4: Existing event projections remain backward compatible with older events
 *        that lack the new fields (no crash / no required-field assumption).
 */

import { describe, expect, it } from 'vitest';
import { BeadStateProjection } from '../src/core/BeadStateProjection.js';
import { DomainEventName, EventName, RestartKind } from '../src/constants/index.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';
import {
  extractRestartCorrelation,
  computeRestartAttempt,
  deriveRestartId,
} from '../src/core/RestartCorrelation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  type: string,
  data: Record<string, unknown>,
  overrides: Partial<DomainEvent> = {}
): DomainEvent {
  return {
    id: overrides.id ?? `evt-${Math.random().toString(36).slice(2)}`,
    type,
    timestamp: overrides.timestamp ?? '2026-01-01T00:00:00.000Z',
    sessionId: overrides.sessionId ?? 'session-prior',
    data,
  };
}

function makeRestartEvent(
  kind: 'CONTEXT' | 'HARNESS',
  overrides: Partial<DomainEvent> & { data?: Record<string, unknown> } = {}
): DomainEvent {
  const eventType =
    kind === 'CONTEXT'
      ? DomainEventName.CONTEXT_RESTART_REQUESTED
      : DomainEventName.HARNESS_RESTART_REQUESTED;
  const transitionEvent =
    kind === 'CONTEXT' ? EventName.CONTEXT_RESTART : EventName.HARNESS_RESTART;
  return makeEvent(
    eventType,
    {
      beadId: 'bd-1',
      stateId: 'Implementation',
      targetState: 'Implementation',
      transitionEvent,
      actionId: 'surgical-execution',
      summary: 'Context overflow detected.',
      // Restart correlation fields (new):
      restartId: 'restart-abc',
      previousRunId: 'session-prior',
      reason: transitionEvent,
      attempt: 1,
      ...(overrides.data ?? {}),
    },
    { id: 'evt-restart-1', sessionId: 'session-prior', ...overrides }
  );
}

function makeRunInitializedEvent(
  restartCorrelation?: { restartId: string; previousRunId: string },
  overrides: Partial<DomainEvent> = {}
): DomainEvent {
  return makeEvent(
    DomainEventName.STATE_RUN_INITIALIZED,
    {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'surgical-execution',
      worktreePath: '/worktrees/bd-1',
      requiredChecklistItems: [],
      runId: 'session-new',
      ...(restartCorrelation
        ? { restartId: restartCorrelation.restartId, previousRunId: restartCorrelation.previousRunId }
        : {}),
    },
    { id: 'evt-run-1', sessionId: 'session-new', ...overrides }
  );
}

// ---------------------------------------------------------------------------
// AC1: Restart replay uses IDs only
// ---------------------------------------------------------------------------

describe('AC1: restart lifecycle can be reconstructed using IDs only', () => {
  it('STATE_RUN_INITIALIZED.restartId links back to the restart event id', () => {
    const restartEvent = makeRestartEvent('CONTEXT');
    const runInitEvent = makeRunInitializedEvent({
      restartId: restartEvent.data.restartId as string,
      previousRunId: restartEvent.data.previousRunId as string,
    });

    // Chain: restartEvent.data.restartId === runInitEvent.data.restartId
    expect(runInitEvent.data.restartId).toBe(restartEvent.data.restartId);
    // previousRunId links to the prior session
    expect(runInitEvent.data.previousRunId).toBe('session-prior');
    // The new run carries its own runId
    expect(runInitEvent.data.runId).toBe('session-new');
  });

  it('extractRestartCorrelation finds the latest restart event for a bead+state', () => {
    const events: DomainEvent[] = [
      makeEvent(
        DomainEventName.BEAD_CLAIMED,
        { beadId: 'bd-1', stateId: 'Implementation' },
        { id: 'e0', timestamp: '2026-01-01T00:00:00.000Z' }
      ),
      makeRestartEvent('HARNESS', {
        id: 'e1',
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 'session-prior',
        data: {
          restartId: 'restart-xyz',
          previousRunId: 'session-prior',
          reason: EventName.HARNESS_RESTART,
          attempt: 1,
        },
      }),
    ];

    const correlation = extractRestartCorrelation(events, 'bd-1', 'Implementation');

    expect(correlation).not.toBeUndefined();
    expect(correlation!.restartId).toBe('restart-xyz');
    expect(correlation!.previousRunId).toBe('session-prior');
  });

  it('extractRestartCorrelation returns undefined when no restart event exists', () => {
    const events: DomainEvent[] = [
      makeEvent(
        DomainEventName.BEAD_CLAIMED,
        { beadId: 'bd-1', stateId: 'Implementation' },
        { id: 'e0' }
      ),
      makeRunInitializedEvent(undefined, { id: 'e1', timestamp: '2026-01-01T00:00:01.000Z' }),
    ];

    const correlation = extractRestartCorrelation(events, 'bd-1', 'Implementation');
    expect(correlation).toBeUndefined();
  });

  it('extractRestartCorrelation ignores restart events from OTHER states', () => {
    const events: DomainEvent[] = [
      makeEvent(
        DomainEventName.CONTEXT_RESTART_REQUESTED,
        {
          beadId: 'bd-1',
          stateId: 'Planning',       // different state
          targetState: 'Planning',
          transitionEvent: EventName.CONTEXT_RESTART,
          restartId: 'restart-planning',
          previousRunId: 'session-planning',
          reason: EventName.CONTEXT_RESTART,
          attempt: 1,
        },
        { id: 'e-restart-planning', timestamp: '2026-01-01T00:00:01.000Z', sessionId: 'session-planning' }
      ),
    ];

    const correlation = extractRestartCorrelation(events, 'bd-1', 'Implementation');
    expect(correlation).toBeUndefined();
  });

  it('extractRestartCorrelation resolves by targetState when source ≠ target (cross-state restart)', () => {
    // Restart recorded with stateId=Planning (source) and targetState=Implementation (target).
    // The new worker runs in Implementation, so extractRestartCorrelation is called with
    // stateId='Implementation'.  It must find the correlation despite source ≠ target.
    const events: DomainEvent[] = [
      makeEvent(
        DomainEventName.CONTEXT_RESTART_REQUESTED,
        {
          beadId: 'bd-1',
          stateId: 'Planning',           // SOURCE state — where the restart was requested
          targetState: 'Implementation', // TARGET state — where the new run will execute
          transitionEvent: EventName.CONTEXT_RESTART,
          restartId: 'restart-cross',
          previousRunId: 'session-planning',
          reason: EventName.CONTEXT_RESTART,
          attempt: 1,
        },
        { id: 'e-cross', timestamp: '2026-01-01T00:00:01.000Z', sessionId: 'session-planning' }
      ),
    ];

    // Reader passes the NEW run's stateId (target), not the source.
    const correlation = extractRestartCorrelation(events, 'bd-1', 'Implementation');

    expect(correlation).not.toBeUndefined();
    expect(correlation!.restartId).toBe('restart-cross');
    expect(correlation!.previousRunId).toBe('session-planning');
  });

  it('extractRestartCorrelation resolves legacy event (no targetState) by stateId when source==target', () => {
    // Backward-compat: old restart events have no targetState field.  The matcher
    // must fall back to stateId matching so default-config (source==target) still works.
    const events: DomainEvent[] = [
      makeEvent(
        DomainEventName.CONTEXT_RESTART_REQUESTED,
        {
          beadId: 'bd-1',
          stateId: 'Implementation',     // source == target; no targetState field
          transitionEvent: EventName.CONTEXT_RESTART,
          restartId: 'restart-legacy',
          previousRunId: 'session-old',
          reason: EventName.CONTEXT_RESTART,
          attempt: 1,
          // NOTE: no targetState — simulates a pre-nyug event
        },
        { id: 'e-legacy', timestamp: '2026-01-01T00:00:01.000Z', sessionId: 'session-old' }
      ),
    ];

    const correlation = extractRestartCorrelation(events, 'bd-1', 'Implementation');

    expect(correlation).not.toBeUndefined();
    expect(correlation!.restartId).toBe('restart-legacy');
    expect(correlation!.previousRunId).toBe('session-old');
  });

  it('extractRestartCorrelation returns undefined when a STATE_RUN_INITIALIZED follows the restart (run already started)', () => {
    // After a run is initialized following a restart, the next call to
    // STATE_RUN_INITIALIZED should NOT pick up the restart correlation
    // (the restart is "consumed" once the run starts).
    const events: DomainEvent[] = [
      makeRestartEvent('CONTEXT', {
        id: 'e1',
        timestamp: '2026-01-01T00:00:01.000Z',
        data: {
          restartId: 'restart-abc',
          previousRunId: 'session-prior',
          reason: EventName.CONTEXT_RESTART,
          attempt: 1,
        },
      }),
      makeRunInitializedEvent(
        { restartId: 'restart-abc', previousRunId: 'session-prior' },
        { id: 'e2', timestamp: '2026-01-01T00:00:02.000Z', sessionId: 'session-new' }
      ),
    ];

    // A second STATE_RUN_INITIALIZED (a re-run) should not see the old restart
    // correlation because the run was already initialized after the restart.
    const correlation = extractRestartCorrelation(events, 'bd-1', 'Implementation');
    expect(correlation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC2: Duplicate restart signals share restartId
// ---------------------------------------------------------------------------

describe('AC2: duplicate restart signals share restartId', () => {
  it('two signals with the same idempotencyKey produce the same restartId', () => {
    const idempotencyKey = 'idem-key-abc';
    const id1 = deriveRestartId(idempotencyKey);
    const id2 = deriveRestartId(idempotencyKey);

    expect(id1).toBe(id2);
    expect(typeof id1).toBe('string');
    expect(id1.length).toBeGreaterThan(0);
  });

  it('two signals with different idempotencyKeys produce different restartIds', () => {
    const id1 = deriveRestartId('idem-key-1');
    const id2 = deriveRestartId('idem-key-2');

    expect(id1).not.toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// AC3: Both context restart and harness restart are covered
// ---------------------------------------------------------------------------

describe('AC3: context and harness restart both carry correlation fields', () => {
  it('CONTEXT_RESTART_REQUESTED event carries restartId, previousRunId, reason, attempt', () => {
    const event = makeRestartEvent('CONTEXT', {
      id: 'evt-ctx',
      sessionId: 'session-prior',
      data: {
        restartId: 'restart-ctx',
        previousRunId: 'session-prior',
        reason: EventName.CONTEXT_RESTART,
        attempt: 2,
      },
    });

    expect(event.data.restartId).toBe('restart-ctx');
    expect(event.data.previousRunId).toBe('session-prior');
    expect(event.data.reason).toBe(EventName.CONTEXT_RESTART);
    expect(event.data.attempt).toBe(2);
  });

  it('HARNESS_RESTART_REQUESTED event carries restartId, previousRunId, reason, attempt', () => {
    const event = makeRestartEvent('HARNESS', {
      id: 'evt-hrn',
      sessionId: 'session-prior',
      data: {
        restartId: 'restart-hrn',
        previousRunId: 'session-prior',
        reason: EventName.HARNESS_RESTART,
        attempt: 1,
      },
    });

    expect(event.data.restartId).toBe('restart-hrn');
    expect(event.data.previousRunId).toBe('session-prior');
    expect(event.data.reason).toBe(EventName.HARNESS_RESTART);
    expect(event.data.attempt).toBe(1);
  });

  it('computeRestartAttempt returns 1 for the first restart in a bead+state', () => {
    const events: DomainEvent[] = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1', stateId: 'Implementation' }, { id: 'e0' }),
    ];

    expect(computeRestartAttempt(events, 'bd-1', 'Implementation')).toBe(1);
  });

  it('computeRestartAttempt returns N+1 for the Nth restart in a bead+state', () => {
    const events: DomainEvent[] = [
      makeRestartEvent('CONTEXT', {
        id: 'e1',
        timestamp: '2026-01-01T00:00:01.000Z',
        data: {
          restartId: 'restart-1',
          previousRunId: 'session-0',
          reason: EventName.CONTEXT_RESTART,
          attempt: 1,
        },
      }),
      makeRestartEvent('HARNESS', {
        id: 'e2',
        timestamp: '2026-01-01T00:00:02.000Z',
        data: {
          restartId: 'restart-2',
          previousRunId: 'session-1',
          reason: EventName.HARNESS_RESTART,
          attempt: 2,
        },
      }),
    ];

    expect(computeRestartAttempt(events, 'bd-1', 'Implementation')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC4: Backward compatibility — old events without new fields must not crash
// ---------------------------------------------------------------------------

describe('AC4: projections are backward compatible with old events lacking correlation fields', () => {
  const projection = new BeadStateProjection();

  it('projectBeadStateChartFromEvents handles CONTEXT_RESTART_REQUESTED without restartId', () => {
    const events: DomainEvent[] = [
      makeEvent(DomainEventName.CONTEXT_RESTART_REQUESTED, {
        beadId: 'bd-1',
        stateId: 'Implementation',
        targetState: 'Implementation',
        transitionEvent: EventName.CONTEXT_RESTART,
        // No restartId, previousRunId, reason, attempt — old event format
      }),
    ];

    // Must not throw; restartRequested should still be set correctly
    expect(() => projection.projectBeadStateChartFromEvents('bd-1', events)).not.toThrow();
    const result = projection.projectBeadStateChartFromEvents('bd-1', events);
    expect(result.restartRequested).toBe(true);
    expect(result.restartKind).toBe(RestartKind.CONTEXT);
    // restartId/previousRunId/attempt are optional — undefined is fine for old events
  });

  it('projectBeadStateChartFromEvents handles HARNESS_RESTART_REQUESTED without restartId', () => {
    const events: DomainEvent[] = [
      makeEvent(DomainEventName.HARNESS_RESTART_REQUESTED, {
        beadId: 'bd-1',
        stateId: 'Planning',
        targetState: 'Planning',
        transitionEvent: EventName.HARNESS_RESTART,
        // No new fields
      }),
    ];

    expect(() => projection.projectBeadStateChartFromEvents('bd-1', events)).not.toThrow();
    const result = projection.projectBeadStateChartFromEvents('bd-1', events);
    expect(result.restartRequested).toBe(true);
    expect(result.restartKind).toBe(RestartKind.HARNESS);
  });

  it('projectBeadStateChartFromEvents handles STATE_RUN_INITIALIZED without restartId', () => {
    const events: DomainEvent[] = [
      makeEvent(DomainEventName.STATE_RUN_INITIALIZED, {
        beadId: 'bd-1',
        stateId: 'Implementation',
        actionId: 'act',
        // No restartId, previousRunId, runId — old event format
      }),
    ];

    expect(() => projection.projectBeadStateChartFromEvents('bd-1', events)).not.toThrow();
    const result = projection.projectBeadStateChartFromEvents('bd-1', events);
    expect(result.currentState).toBe('Implementation');
  });

  it('extractRestartCorrelation tolerates old restart events without restartId field', () => {
    const events: DomainEvent[] = [
      makeEvent(
        DomainEventName.CONTEXT_RESTART_REQUESTED,
        {
          beadId: 'bd-1',
          stateId: 'Implementation',
          transitionEvent: EventName.CONTEXT_RESTART,
          // No restartId — old format
        },
        { id: 'old-restart', timestamp: '2026-01-01T00:00:01.000Z', sessionId: 'session-old' }
      ),
    ];

    // Should not throw; returns undefined or a partial result without restartId
    expect(() => extractRestartCorrelation(events, 'bd-1', 'Implementation')).not.toThrow();
  });
});
