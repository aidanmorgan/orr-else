/**
 * pi-experiment-amq0.2: fake-port unit tests for the extracted Supervisor services.
 *
 * Tests prove each service is independently testable via narrow fake ports —
 * no tmux, no bd, no full RuntimeServices bag required.
 *
 * Covered services:
 *   - SupervisorRecoveryService (rebuildProcessedSignals, reconcile intents, restore pause)
 *   - BeadSpawnCoordinator (quarantine helpers, worktree classification, MCP preflight)
 *   - RetentionScheduler (interval gating)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DomainEventName, QuarantineReason, TeammateEventDecisionAction } from '../src/constants/domain.js';
import type { DomainEvent } from '../src/core/EventStore.js';
import { SupervisorRecoveryService } from '../src/core/SupervisorRecoveryService.js';
import { BeadSpawnCoordinator } from '../src/core/BeadSpawnCoordinator.js';
import { RetentionScheduler } from '../src/core/RetentionScheduler.js';
import { RetentionService } from '../src/core/retention/RetentionService.js';
import { FailureClass, LifecyclePhase, RetryBudget } from '../src/core/FailureTaxonomy.js';

// ---------------------------------------------------------------------------
// Fake event store (narrow fake port — no imports from bd, tmux, etc.)
// ---------------------------------------------------------------------------

function fakeEventStore(overrides: Partial<{
  record: (event: string, data: unknown) => Promise<void>;
  readAll: () => Promise<DomainEvent[]>;
  latestEventByType: (type: string) => Promise<DomainEvent | undefined>;
  eventsForBeads: (beadIds: Iterable<unknown>) => Promise<Map<unknown, DomainEvent[]>>;
  latestEventsForBeads: (beadIds: Iterable<unknown>, opts?: unknown) => Promise<Map<unknown, DomainEvent>>;
  eventsForBead: (beadId: unknown) => Promise<DomainEvent[]>;
  projectBead: (beadId: unknown, opts?: unknown) => Promise<Record<string, unknown>>;
  latestProjectToolFailureLimitEvent: (beadId: unknown, opts?: unknown) => Promise<DomainEvent | undefined>;
  latestToolResultEvent: (...args: unknown[]) => Promise<DomainEvent | undefined>;
}> = {}) {
  const records: Array<{ event: string; data: unknown }> = [];
  return {
    records,
    store: {
      record: overrides.record ?? vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); }),
      readAll: overrides.readAll ?? vi.fn(async () => []),
      latestEventByType: overrides.latestEventByType ?? vi.fn(async () => undefined),
      eventsForBeads: overrides.eventsForBeads ?? vi.fn(async () => new Map()),
      latestEventsForBeads: overrides.latestEventsForBeads ?? vi.fn(async () => new Map()),
      eventsForBead: overrides.eventsForBead ?? vi.fn(async () => []),
      projectBead: overrides.projectBead ?? vi.fn(async () => ({})),
      latestProjectToolFailureLimitEvent: overrides.latestProjectToolFailureLimitEvent ?? vi.fn(async () => undefined),
      latestToolResultEvent: overrides.latestToolResultEvent ?? vi.fn(async () => undefined),
    }
  };
}

function domainEvent(id: string, type: string, timestampMs: number, data: Record<string, unknown> = {}): DomainEvent {
  return {
    id: id as any,
    type,
    timestamp: new Date(timestampMs).toISOString(),
    sessionId: 'session-1' as any,
    data
  };
}

const NOW_MS = Date.parse('2026-01-02T03:04:05.000Z');

// ===========================================================================
// SupervisorRecoveryService tests (fake-port, no tmux, no bd)
// ===========================================================================

describe('SupervisorRecoveryService — fake-port tests (amq0.2)', () => {
  it('rebuildProcessedSignalsFromEvents returns keys from ACCEPT TEAMMATE_EVENT records', async () => {
    const key1 = 'STATE_TRANSITIONED-bead-1-session-1';
    const key2 = 'STATE_TRANSITIONED-bead-2-session-2';
    const { store } = fakeEventStore({
      readAll: vi.fn(async () => [
        domainEvent('te-1', DomainEventName.TEAMMATE_EVENT, NOW_MS, {
          idempotencyKey: key1,
          processingDecision: TeammateEventDecisionAction.ACCEPT
        }),
        domainEvent('te-2', DomainEventName.TEAMMATE_EVENT, NOW_MS + 1, {
          idempotencyKey: key2,
          processingDecision: TeammateEventDecisionAction.DUPLICATE // DUPLICATE must NOT be rebuilt
        }),
        domainEvent('te-3', DomainEventName.TEAMMATE_EVENT, NOW_MS + 2, {
          idempotencyKey: 'key-no-decision' // missing processingDecision
        }),
      ])
    });
    const svc = new SupervisorRecoveryService(store as any);

    const rebuilt = await svc.rebuildProcessedSignalsFromEvents();

    expect(rebuilt.has(key1)).toBe(true);
    expect(rebuilt.has(key2)).toBe(false); // DUPLICATE not included
    expect(rebuilt.has('key-no-decision')).toBe(false);
    expect(rebuilt.size).toBe(1);
  });

  it('rebuildProcessedSignalsFromEvents uses pre-fetched events when provided (single readAll pass)', async () => {
    const { store } = fakeEventStore({
      readAll: vi.fn(async () => []) // should NOT be called when events are passed
    });
    const svc = new SupervisorRecoveryService(store as any);

    const preloadedEvents = [
      domainEvent('te-pre', DomainEventName.TEAMMATE_EVENT, NOW_MS, {
        idempotencyKey: 'pre-loaded-key',
        processingDecision: TeammateEventDecisionAction.ACCEPT
      })
    ];

    const rebuilt = await svc.rebuildProcessedSignalsFromEvents(preloadedEvents);

    expect(rebuilt.has('pre-loaded-key')).toBe(true);
    expect(store.readAll).not.toHaveBeenCalled();
  });

  it('reconcileUnacknowledgedSignalIntents emits SIGNAL_INTENT_RECONCILED for unacknowledged intents', async () => {
    const key = 'UNACKNOWLEDGED-KEY';
    const { store, records } = fakeEventStore({
      readAll: vi.fn(async () => [
        domainEvent('si-1', DomainEventName.SIGNAL_INTENT_RECORDED, NOW_MS, {
          beadId: 'bead-x',
          type: 'STATE_TRANSITIONED',
          stateId: 'Planning',
          idempotencyKey: key
        })
        // No matching TEAMMATE_EVENT ACCEPT for this key
      ])
    });
    const svc = new SupervisorRecoveryService(store as any);

    await svc.reconcileUnacknowledgedSignalIntents();

    const reconciled = records.find(r => r.event === DomainEventName.SIGNAL_INTENT_RECONCILED);
    expect(reconciled).toBeDefined();
    expect((reconciled!.data as any).idempotencyKey).toBe(key);
    expect((reconciled!.data as any).beadId).toBe('bead-x');
  });

  it('reconcileUnacknowledgedSignalIntents is idempotent — skips already-reconciled intents', async () => {
    const key = 'ALREADY-RECONCILED-KEY';
    const { store, records } = fakeEventStore({
      readAll: vi.fn(async () => [
        domainEvent('si-1', DomainEventName.SIGNAL_INTENT_RECORDED, NOW_MS - 1000, {
          idempotencyKey: key, beadId: 'b1', type: 'STATE_TRANSITIONED', stateId: 'Planning'
        }),
        domainEvent('sir-1', DomainEventName.SIGNAL_INTENT_RECONCILED, NOW_MS - 500, {
          idempotencyKey: key
        })
      ])
    });
    const svc = new SupervisorRecoveryService(store as any);

    await svc.reconcileUnacknowledgedSignalIntents();

    const reconciled = records.filter(r => r.event === DomainEventName.SIGNAL_INTENT_RECONCILED);
    expect(reconciled).toHaveLength(0); // already reconciled, no new event
  });

  it('reconcileUnacknowledgedSignalIntents skips intents with matching ACCEPT TEAMMATE_EVENT', async () => {
    const key = 'PROCESSED-KEY';
    const { store, records } = fakeEventStore({
      readAll: vi.fn(async () => [
        domainEvent('si-1', DomainEventName.SIGNAL_INTENT_RECORDED, NOW_MS - 1000, {
          idempotencyKey: key, beadId: 'b1', type: 'STATE_TRANSITIONED', stateId: 'Planning'
        }),
        domainEvent('te-1', DomainEventName.TEAMMATE_EVENT, NOW_MS - 500, {
          idempotencyKey: key,
          processingDecision: TeammateEventDecisionAction.ACCEPT
        })
      ])
    });
    const svc = new SupervisorRecoveryService(store as any);

    await svc.reconcileUnacknowledgedSignalIntents();

    expect(records.filter(r => r.event === DomainEventName.SIGNAL_INTENT_RECONCILED)).toHaveLength(0);
  });

  it('restoreCapacityPauseFromStore returns undefined when no active pause exists', async () => {
    const { store } = fakeEventStore({
      latestEventByType: vi.fn(async () => undefined)
    });
    const svc = new SupervisorRecoveryService(store as any);

    const result = await svc.restoreCapacityPauseFromStore(() => NOW_MS);

    expect(result).toBeUndefined();
  });

  it('restoreCapacityPauseFromStore returns pause state when an active SCHEDULING_PAUSED event exists', async () => {
    const pauseUntilMs = NOW_MS + 60_000;
    const { store } = fakeEventStore({
      latestEventByType: vi.fn(async () => domainEvent('sp-1', DomainEventName.SCHEDULING_PAUSED, NOW_MS - 1000, {
        pauseUntil: new Date(pauseUntilMs).toISOString(),
        reason: 'subscription limit'
      }))
    });
    const svc = new SupervisorRecoveryService(store as any);

    const result = await svc.restoreCapacityPauseFromStore(() => NOW_MS);

    expect(result).toBeDefined();
    expect(result!.pauseUntilMs).toBe(pauseUntilMs);
    expect(result!.reason).toBe('subscription limit');
  });

  it('restoreCapacityPauseFromStore returns undefined when pauseUntil is in the past', async () => {
    const pastPauseMs = NOW_MS - 1000;
    const { store } = fakeEventStore({
      latestEventByType: vi.fn(async () => domainEvent('sp-1', DomainEventName.SCHEDULING_PAUSED, NOW_MS - 2000, {
        pauseUntil: new Date(pastPauseMs).toISOString(),
        reason: 'expired'
      }))
    });
    const svc = new SupervisorRecoveryService(store as any);

    const result = await svc.restoreCapacityPauseFromStore(() => NOW_MS);

    expect(result).toBeUndefined();
  });
});

// ===========================================================================
// BeadSpawnCoordinator — quarantine helper tests (fake-port, no tmux, no bd)
// ===========================================================================

describe('BeadSpawnCoordinator — quarantine helpers, fake-port (amq0.2)', () => {
  function makeCoordinator(recordFn?: (event: string, data: unknown) => Promise<void>) {
    const records: Array<{ event: string; data: unknown }> = [];
    const store = {
      record: recordFn ?? vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); }),
      readAll: vi.fn(async () => []),
      latestEventByType: vi.fn(async () => undefined),
      eventsForBeads: vi.fn(async () => new Map()),
      latestEventsForBeads: vi.fn(async () => new Map()),
      eventsForBead: vi.fn(async () => []),
      projectBead: vi.fn(async () => ({})),
      latestProjectToolFailureLimitEvent: vi.fn(async () => undefined),
      latestToolResultEvent: vi.fn(async () => undefined),
    };
    const beadsPort = {
      ready: vi.fn(async () => []),
      list: vi.fn(async () => ({ items: [] })),
      getBead: vi.fn(async (id: string) => ({ id } as any)),
      claim: vi.fn(async ({ id }: { id: string }) => ({ id } as any)),
      release: vi.fn(async () => {}),
      updateStatus: vi.fn(async () => {}),
      invalidateCache: vi.fn()
    };
    const worktreePort = {
      createWorktree: vi.fn(async () => ({ success: true, path: '/tmp/worktree' }))
    };
    const factory = {
      spawnTeammateInTmux: vi.fn(async () => ({ success: true, paneId: '%1' })),
      getLiveTeammateBeadIds: vi.fn(async () => new Set()),
      getActiveTeammateCount: vi.fn(async () => 0),
      getAvailableSlots: vi.fn(async () => 1),
      terminateTeammatesForBead: vi.fn(async () => ({ terminatedPaneIds: [] })),
      captureBeadPaneText: vi.fn(async () => '')
    };
    const observability = {
      tracedAsync: (_n: string, _a: unknown, fn: unknown) => fn,
      recordCompletedSpan: vi.fn()
    };
    const configLoader = {
      load: vi.fn(async () => ({ settings: {}, states: {} })),
      getConfigPath: vi.fn(() => '/fake/config.yaml')
    };
    const flowManager = { nextState: vi.fn(() => 'NextState') };
    const coordinator = new BeadSpawnCoordinator(
      beadsPort as any,
      worktreePort as any,
      store as any,
      factory as any,
      observability as any,
      configLoader as any,
      flowManager as any,
      '/fake/project',
      () => NOW_MS,
      (ms?: number) => new Date(ms === undefined ? NOW_MS : ms)
    );
    return { coordinator, records, store, beadsPort, worktreePort, factory };
  }

  it('classifyWorktreeError returns ALREADY_CHECKED_OUT for checked-out error', () => {
    const { coordinator } = makeCoordinator();
    expect(coordinator.classifyWorktreeError("fatal: 'branch' is already checked out")).toBe(QuarantineReason.ALREADY_CHECKED_OUT);
  });

  it('classifyWorktreeError returns INVALID_BRANCH_REF for invalid reference', () => {
    const { coordinator } = makeCoordinator();
    expect(coordinator.classifyWorktreeError('fatal: invalid reference: refs/heads/bad')).toBe(QuarantineReason.INVALID_BRANCH_REF);
  });

  it('classifyWorktreeError returns WORKTREE_PATH_TAKEN for already exists', () => {
    const { coordinator } = makeCoordinator();
    expect(coordinator.classifyWorktreeError("fatal: '/path/to/worktree' already exists")).toBe(QuarantineReason.WORKTREE_PATH_TAKEN);
  });

  it('classifyWorktreeError returns UNKNOWN for unrecognized error', () => {
    const { coordinator } = makeCoordinator();
    expect(coordinator.classifyWorktreeError('disk full')).toBe(QuarantineReason.UNKNOWN);
  });

  it('isQuarantined returns false for an unknown bead', async () => {
    const { coordinator } = makeCoordinator();
    const bead = { id: 'bead-new', status: 'ready', lastActivity: '' };
    expect(await coordinator.isQuarantined(bead)).toBe(false);
  });

  it('isQuarantined returns true for a bead with unchanged quarantine signature', async () => {
    const { coordinator } = makeCoordinator();
    const bead = { id: 'bead-q', status: 'ready', lastActivity: '2026-01-01T00:00:00.000Z' };
    await coordinator.quarantineBead(bead, QuarantineReason.ALREADY_CHECKED_OUT);
    expect(await coordinator.isQuarantined(bead)).toBe(true);
  });

  it('isQuarantined clears entry and returns false when signature changes', async () => {
    const { coordinator } = makeCoordinator();
    const beadAtQuarantine = { id: 'bead-q', status: 'ready', lastActivity: '2026-01-01T00:00:00.000Z' };
    await coordinator.quarantineBead(beadAtQuarantine, QuarantineReason.ALREADY_CHECKED_OUT);

    const beadAfterUpdate = { id: 'bead-q', status: 'in_progress', lastActivity: '2026-01-02T00:00:00.000Z' };
    expect(await coordinator.isQuarantined(beadAfterUpdate)).toBe(false);
    expect(coordinator.quarantine.has('bead-q')).toBe(false);
  });

  it('quarantineBead emits BEAD_QUARANTINED event with reason and signature', async () => {
    const { coordinator, records } = makeCoordinator();
    const bead = { id: 'bead-q', status: 'ready', lastActivity: '2026-01-01T00:00:00.000Z' };
    await coordinator.quarantineBead(bead, QuarantineReason.INVALID_BRANCH_REF);

    const event = records.find(r => r.event === DomainEventName.BEAD_QUARANTINED);
    expect(event).toBeDefined();
    expect((event!.data as any).beadId).toBe('bead-q');
    expect((event!.data as any).reason).toBe(QuarantineReason.INVALID_BRANCH_REF);
    expect(typeof (event!.data as any).signature).toBe('string');
  });

  it('rehydrateQuarantinesFromEvents restores quarantine map from durable events', async () => {
    const { coordinator, records } = makeCoordinator();
    const quarantineEvents = [
      domainEvent('qe-1', DomainEventName.BEAD_QUARANTINED, NOW_MS - 1000, {
        beadId: 'bead-rehydrate',
        reason: QuarantineReason.ALREADY_CHECKED_OUT,
        signature: 'ready:2026-01-01T00:00:00.000Z'
      })
    ];
    // Override readAll to return the quarantine event
    (coordinator as any).eventStore.readAll.mockResolvedValue(quarantineEvents);

    await coordinator.rehydrateQuarantinesFromEvents();

    expect(coordinator.quarantine.has('bead-rehydrate')).toBe(true);
    expect(coordinator.quarantine.get('bead-rehydrate')?.reason).toBe(QuarantineReason.ALREADY_CHECKED_OUT);
    expect(coordinator.rehydratedQuarantineBeadIds.has('bead-rehydrate')).toBe(true);
    // BEAD_QUARANTINE_REHYDRATED event must be emitted
    expect(records.find(r => r.event === DomainEventName.BEAD_QUARANTINE_REHYDRATED)).toBeDefined();
  });

  it('rehydrateQuarantinesFromEvents emits BEAD_QUARANTINE_CLEARED when signature changes for rehydrated entry', async () => {
    const { coordinator, records } = makeCoordinator();
    const quarantineEvents = [
      domainEvent('qe-2', DomainEventName.BEAD_QUARANTINED, NOW_MS - 1000, {
        beadId: 'bead-rehydrate2',
        reason: QuarantineReason.WORKTREE_PATH_TAKEN,
        signature: 'ready:2026-01-01T00:00:00.000Z'
      })
    ];
    (coordinator as any).eventStore.readAll.mockResolvedValue(quarantineEvents);

    await coordinator.rehydrateQuarantinesFromEvents();

    // Signature changes — quarantine should be cleared with a BEAD_QUARANTINE_CLEARED event
    const beadChanged = { id: 'bead-rehydrate2', status: 'in_progress', lastActivity: '2026-02-01T00:00:00.000Z' };
    const result = await coordinator.isQuarantined(beadChanged);

    expect(result).toBe(false);
    expect(records.find(r => r.event === DomainEventName.BEAD_QUARANTINE_CLEARED)).toBeDefined();
  });

  it('requiredMcpToolNamesForBead returns empty array when no required tools configured', () => {
    const { coordinator } = makeCoordinator();
    const config = { settings: {}, states: { Planning: { actions: [], requiredTools: [] } } } as any;
    expect(coordinator.requiredMcpToolNamesForBead('Planning', config)).toEqual([]);
  });

  it('resolveWorktreeProvisioning returns true by default (always provision)', () => {
    const { coordinator } = makeCoordinator();
    const config = { settings: {} } as any;
    expect(coordinator.resolveWorktreeProvisioning('Planning', config)).toBe(true);
  });

  it('resolveWorktreeProvisioning respects per-state override', () => {
    const { coordinator } = makeCoordinator();
    const config = {
      settings: {},
      states: { Planning: { provisionWorktree: false } }
    } as any;
    expect(coordinator.resolveWorktreeProvisioning('Planning', config)).toBe(false);
  });

  it('taxonomyFields returns expected shape with all required keys', () => {
    const { coordinator } = makeCoordinator();
    const fields = coordinator.taxonomyFields(FailureClass.STARTUP_SUBSTRATE, LifecyclePhase.SPAWN, RetryBudget.AVAILABLE);
    expect(typeof fields.taxonomyClass).toBe('string');
    expect(typeof fields.lifecyclePhase).toBe('string');
    expect(typeof fields.taxonomyRowId).toBe('string');
    expect(typeof fields.taxonomyAction).toBe('string');
    expect(typeof fields.retryBudget).toBe('string');
  });
});

// ===========================================================================
// RetentionScheduler — interval gating tests (fake-port, no tmux, no bd)
// ===========================================================================

describe('RetentionScheduler — interval gating, fake-port (amq0.2)', () => {
  it('runIfDue does NOT run cleanup before the interval has elapsed', async () => {
    const runSpy = vi.fn(async () => ({ areas: [], totalFilesRemoved: 0, totalDirsRemoved: 0, totalBytesReclaimed: 0, totalErrors: 0, eventsCompacted: 0, backpressureActive: false }));
    // Spy on RetentionService.run() — RetentionScheduler constructs it directly.
    const runMock = vi.spyOn(RetentionService.prototype, 'run').mockImplementation(runSpy);

    let nowMs = NOW_MS;
    const clock = { now: () => nowMs, date: (ms?: number) => new Date(ms ?? nowMs) };
    const configLoader = { load: vi.fn(async () => ({ settings: {}, retention: undefined })), getConfigPath: vi.fn(() => '/fake') };
    const factory = { getLiveTeammateBeadIds: vi.fn(async () => new Set()) };
    const eventStore = {} as any; // RetentionCleanup mock never accesses it

    const scheduler = new RetentionScheduler(
      '/fake/project',
      clock,
      eventStore,
      configLoader as any,
      factory as any
    );

    // First call — should run (interval not yet elapsed)
    await scheduler.runIfDue();
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Second call immediately — interval not elapsed, should NOT run again
    await scheduler.runIfDue();
    expect(runSpy).toHaveBeenCalledTimes(1);

    runMock.mockRestore();
  });

  it('runIfDue runs cleanup after the interval has elapsed', async () => {
    const runSpy = vi.fn(async () => ({ areas: [], totalFilesRemoved: 0, totalDirsRemoved: 0, totalBytesReclaimed: 0, totalErrors: 0, eventsCompacted: 0, backpressureActive: false }));
    // Spy on RetentionService.run() — RetentionScheduler constructs it directly.
    const runMock = vi.spyOn(RetentionService.prototype, 'run').mockImplementation(runSpy);

    const { RetentionDefaults } = await import('../src/constants/infra.js');
    let nowMs = NOW_MS;
    const clock = { now: () => nowMs, date: (ms?: number) => new Date(ms ?? nowMs) };
    const configLoader = { load: vi.fn(async () => ({ settings: {}, retention: undefined })), getConfigPath: vi.fn(() => '/fake') };
    const factory = { getLiveTeammateBeadIds: vi.fn(async () => new Set()) };
    const eventStore = {} as any;

    const scheduler = new RetentionScheduler('/fake/project', clock, eventStore, configLoader as any, factory as any);

    // First run
    await scheduler.runIfDue();
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Advance past interval
    nowMs += RetentionDefaults.CLEANUP_INTERVAL_MS + 1;

    // Second run — interval elapsed, should run again
    await scheduler.runIfDue();
    expect(runSpy).toHaveBeenCalledTimes(2);

    runMock.mockRestore();
  });
});

// ===========================================================================
// Supervisor constructor accepts narrow interfaces (structural type check)
// ===========================================================================

describe('Supervisor constructor accepts SupervisorServices (amq0.2)', () => {
  it('SupervisorServices can be constructed with narrow fake ports — no RuntimeServices bag needed', async () => {
    // This test proves the Supervisor constructor works with the narrow
    // SupervisorServices interface (no scheduler, no observability, etc. in the bag).
    const { Supervisor } = await import('../src/core/Supervisor.js');

    const narrowServices = {
      eventStore: {
        record: vi.fn(async () => {}),
        readAll: vi.fn(async () => []),
        latestEventByType: vi.fn(async () => undefined),
        eventsForBeads: vi.fn(async () => new Map()),
        latestEventsForBeads: vi.fn(async () => new Map()),
        eventsForBead: vi.fn(async () => []),
        projectBead: vi.fn(async () => ({})),
        latestProjectToolFailureLimitEvent: vi.fn(async () => undefined),
        latestToolResultEvent: vi.fn(async () => undefined),
      },
      configLoader: {
        load: vi.fn(async () => ({ settings: {} })),
        getConfigPath: vi.fn(() => '/fake/config.yaml')
      },
      beadsPort: {
        ready: vi.fn(async () => []),
        list: vi.fn(async () => ({ items: [] })),
        getBead: vi.fn(async (id: string) => ({ id } as any)),
        claim: vi.fn(async ({ id }: { id: string }) => ({ id } as any)),
        release: vi.fn(async () => {}),
        updateStatus: vi.fn(async () => {}),
        invalidateCache: vi.fn()
      },
      worktreePort: {
        createWorktree: vi.fn(async () => ({ success: true, path: '/tmp/wt' }))
      },
      flowManager: {
        nextState: vi.fn(() => 'NextState')
      },
      projectRoot: '/fake/project'
      // No scheduler, no observability, no eventEmitter — only what Supervisor needs
    };

    // Should construct without error — proving narrow interface works
    expect(() => new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      { getLiveTeammateBeadIds: vi.fn(async () => new Set()), getActiveTeammateCount: vi.fn(async () => 0), getAvailableSlots: vi.fn(async () => 0), terminateTeammatesForBead: vi.fn(), captureBeadPaneText: vi.fn(async () => ''), spawnTeammateInTmux: vi.fn(async () => ({ success: true })) } as any,
      { tracedAsync: (_n: string, _a: unknown, fn: unknown) => fn, recordCompletedSpan: vi.fn() } as any,
      narrowServices as any,
      { maxSlots: 1 }
    )).not.toThrow();
  });

  it('Supervisor accepts an injected Orchestrator via options — no internal construction', async () => {
    // Proves that when an orchestrator is injected via options.orchestrator,
    // scanAndSpawn uses it directly instead of constructing a new one.
    const { Supervisor } = await import('../src/core/Supervisor.js');

    const mockSelectAssignments = vi.fn(async () => []);
    const injectedOrchestrator = { selectAssignments: mockSelectAssignments } as any;

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        getActiveTeammateCount: vi.fn(async () => 0),
        getAvailableSlots: vi.fn(async () => 1),
        terminateTeammatesForBead: vi.fn(),
        captureBeadPaneText: vi.fn(async () => ''),
        spawnTeammateInTmux: vi.fn(async () => ({ success: true }))
      } as any,
      { tracedAsync: (_n: string, _a: unknown, fn: unknown) => fn, recordCompletedSpan: vi.fn() } as any,
      {
        eventStore: {
          record: vi.fn(async () => {}),
          readAll: vi.fn(async () => []),
          latestEventByType: vi.fn(async () => undefined),
          eventsForBeads: vi.fn(async () => new Map()),
          latestEventsForBeads: vi.fn(async () => new Map()),
          eventsForBead: vi.fn(async () => []),
          projectBead: vi.fn(async () => ({})),
          latestProjectToolFailureLimitEvent: vi.fn(async () => undefined),
          latestToolResultEvent: vi.fn(async () => undefined),
        },
        configLoader: { load: vi.fn(async () => ({ settings: {} })), getConfigPath: vi.fn(() => '/fake') },
        beadsPort: { ready: vi.fn(async () => []), list: vi.fn(async () => ({ items: [] })), getBead: vi.fn(async (id: string) => ({ id } as any)), claim: vi.fn(async ({ id }: { id: string }) => ({ id } as any)), release: vi.fn(async () => {}), updateStatus: vi.fn(async () => {}), invalidateCache: vi.fn() },
        worktreePort: { createWorktree: vi.fn(async () => ({ success: true, path: '/tmp/wt' })) },
        flowManager: { nextState: vi.fn(() => 'NextState') },
        projectRoot: '/fake/project'
      } as any,
      {
        maxSlots: 1,
        orchestrator: injectedOrchestrator
      }
    );

    await (supervisor as any).scanAndSpawn();

    // The injected orchestrator's selectAssignments must have been called
    expect(mockSelectAssignments).toHaveBeenCalled();
  });
});
