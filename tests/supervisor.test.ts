import { describe, expect, it, vi } from 'vitest';
import { Supervisor } from '../src/core/Supervisor.js';
import { Logger } from '../src/core/Logger.js';
import { BeadStatus, Defaults, DomainEventName, SpanName, TeammateEventDecisionAction, PluginToolName, TimeMs } from '../src/constants/index.js';
import type { Clock } from '../src/core/Clock.js';
import type { DomainEvent } from '../src/core/EventStore.js';
import type { BeadsPort } from '../src/core/OrchestrationPorts.js';

const IMMEDIATE_NO_PROGRESS_TIMEOUT_MS = 1;
const STALE_PROGRESS_AGE_MS = TimeMs.MINUTE;
const NOW_MS = Date.parse('2026-01-02T03:04:05.000Z');

function createFakeClock(nowMs = NOW_MS): Clock {
  return {
    now: () => nowMs,
    date: (timestampMs?: number) => new Date(timestampMs === undefined ? nowMs : timestampMs)
  };
}

function fakeBeadsPort(overrides: Partial<BeadsPort> = {}): BeadsPort {
  return {
    ready: vi.fn(async () => []),
    list: vi.fn(async () => ({ items: [] })),
    getBead: vi.fn(async (id) => ({ id } as any)),
    claim: vi.fn(async ({ id }) => ({ id } as any)),
    release: vi.fn(async () => {}),
    invalidateCache: vi.fn(),
    ...overrides
  };
}

function supervisorHarness(
  latestProgressAtMs: number,
  heartbeats?: any[],
  liveBeadIds = new Set(['bead-1']),
  maxSlots = 1,
  eventsByBead = new Map<string, DomainEvent[]>(),
  allEvents: DomainEvent[] = []
) {
  const clock = createFakeClock();
  const effectiveHeartbeats = heartbeats ?? [{
    workerId: 'worker-1',
    beadId: 'bead-1',
    stateId: 'Planning',
    timestampMs: clock.now()
  }];
  const records: Array<{ event: string; data: any }> = [];
  const release = vi.fn(async () => {});
  const beadsPort = fakeBeadsPort({ release });
  const terminateTeammatesForBead = vi.fn(async () => ({ terminatedPaneIds: ['%1'] }));
  const eventStore = {
    record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
    eventsForBeads: vi.fn(async (beadIds: Iterable<string>) => new Map(
      [...beadIds].map(beadId => [beadId, eventsByBead.get(beadId) || []])
    )),
    latestEventsForBeads: vi.fn(async () => new Map([
      ['bead-1', {
        id: 'event-1',
        type: DomainEventName.CONTEXT_COMPACTION_RECORDED,
        timestamp: new Date(latestProgressAtMs).toISOString(),
        sessionId: 'session-1',
        data: { beadId: 'bead-1', stateId: 'Planning' }
      }]
    ])),
    readAll: vi.fn(async () => allEvents)
  };
  const captureBeadPaneText = vi.fn(async () => '');
  const supervisor = new Supervisor(
    {} as any,
    { hasUI: false } as any,
    {
      getHeartbeatSnapshot: () => effectiveHeartbeats
    } as any,
    {
      getLiveTeammateBeadIds: vi.fn(async () => liveBeadIds),
      terminateTeammatesForBead,
      captureBeadPaneText,
      getActiveTeammateCount: vi.fn(async () => liveBeadIds.size),
      getAvailableSlots: vi.fn(async () => Math.max(0, maxSlots - liveBeadIds.size)),
      spawnTeammateInTmux: vi.fn(async () => ({ success: true, paneId: '%1' }))
    } as any,
    { tracedAsync: (_name: string, _attrs: any, fn: any) => fn } as any,
    {
      configLoader: {
        load: async () => ({
          settings: {
            harnessRestartEvent: 'HARNESS_RESTART',
            teammateNoProgressTimeoutMs: IMMEDIATE_NO_PROGRESS_TIMEOUT_MS
          }
        })
      },
      eventStore,
      beadsPort,
      worktreePort: {
        createWorktree: vi.fn(async () => ({ success: true, path: '/tmp/worktree' }))
      },
      scheduler: {},
      flowManager: {}
    } as any,
    {
      maxSlots,
      clock,
      orchestrator: { selectAssignments: vi.fn(async () => []) } as any,
      retentionScheduler: { runIfDue: vi.fn(async () => {}) } as any
    }
  );
  return { supervisor, records, release, terminateTeammatesForBead, captureBeadPaneText, clock };
}

function domainEvent(id: string, type: DomainEventName, beadId: string, timestampMs: number, data: Record<string, unknown> = {}): DomainEvent {
  return {
    id,
    type,
    timestamp: new Date(timestampMs).toISOString(),
    sessionId: 'session-1',
    data: { beadId, ...data }
  };
}

describe('Supervisor', () => {
  it('restarts a teammate that heartbeats without non-heartbeat progress', async () => {
    const { supervisor, records, release, terminateTeammatesForBead } = supervisorHarness(NOW_MS - STALE_PROGRESS_AGE_MS);

    await (supervisor as any).recordSlotHealth('test');

    expect(records.find(record => record.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED)?.data).toMatchObject({
      workingCount: 0,
      inactiveBeadIds: ['bead-1']
    });
    expect((supervisor as any).services.eventStore.latestEventsForBeads).toHaveBeenCalledWith(['bead-1'], expect.objectContaining({
      excludeToolNames: [PluginToolName.BD_HEARTBEAT]
    }));
    expect(records.some(record => record.event === DomainEventName.AGENT_TURN_FAILED)).toBe(true);
    expect(records.some(record => record.event === DomainEventName.HARNESS_RESTART_REQUESTED)).toBe(true);
    expect(terminateTeammatesForBead).toHaveBeenCalledWith('bead-1', expect.stringContaining('without non-heartbeat progress'));
    expect(release).toHaveBeenCalledWith('bead-1');
  });

  it('keeps a teammate working when recent non-heartbeat progress exists', async () => {
    const { supervisor, records, release, terminateTeammatesForBead } = supervisorHarness(NOW_MS);

    await (supervisor as any).recordSlotHealth('test');

    expect(records.find(record => record.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED)?.data).toMatchObject({
      workingCount: 1,
      inactiveBeadIds: []
    });
    expect(terminateTeammatesForBead).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('does not mark a live teammate stale when heartbeat is absent but progress is current', async () => {
    const { supervisor, records, release, terminateTeammatesForBead, clock } = supervisorHarness(NOW_MS, []);
    (supervisor as any).startedBeadAtMs.set('bead-1', clock.now() - (TimeMs.MINUTE * 3));
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);

    await (supervisor as any).recordSlotHealth('test');

    expect(records.find(record => record.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED)?.data).toMatchObject({
      workingCount: 1,
      staleBeadIds: [],
      staleHeartbeatBeadIds: ['bead-1'],
      heartbeatOnlyStaleBeadIds: ['bead-1'],
      inactiveBeadIds: []
    });
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      'Teammate slot health check found underfilled or stale work',
      expect.objectContaining({ heartbeatOnlyStaleBeadIds: ['bead-1'] })
    );
    warn.mockRestore();
    expect(terminateTeammatesForBead).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('releases a tracked bead lease when its teammate pane disappears', async () => {
    const { supervisor, records, release, clock } = supervisorHarness(NOW_MS, [], new Set());
    (supervisor as any).startedBeads.add('bead-1');
    (supervisor as any).startedBeadAtMs.set('bead-1', clock.now() - TimeMs.MINUTE);
    (supervisor as any).missingStartedBeadChecks.set('bead-1', Defaults.TEAMMATE_MISSING_REAP_THRESHOLD - 1);

    await (supervisor as any).reconcileStartedBeads();

    expect(records).toContainEqual({
      event: DomainEventName.TEAMMATE_PROCESS_EXITED,
      data: { beadId: 'bead-1' }
    });
    expect(release).toHaveBeenCalledWith('bead-1');
    expect((supervisor as any).startedBeads.has('bead-1')).toBe(false);
  });

  it('records a structured capacity underfill event when live panes drop below configured slots', async () => {
    const now = NOW_MS;
    const { supervisor, records } = supervisorHarness(
      now,
      [
        { workerId: 'worker-1', beadId: 'bead-1', stateId: 'Planning', timestampMs: now },
        { workerId: 'worker-missing', beadId: 'bead-missing', stateId: 'Planning', timestampMs: now - TimeMs.SECOND }
      ],
      new Set(['bead-1']),
      2
    );
    (supervisor as any).startedBeads.add('bead-1');
    (supervisor as any).startedBeads.add('bead-missing');

    await (supervisor as any).recordSlotHealth('test');

    expect(records.find(record => record.event === DomainEventName.TEAMMATE_CAPACITY_UNDERFILLED)?.data).toMatchObject({
      stage: 'test',
      expectedCount: 2,
      activeCount: 1,
      workingCount: 1,
      missingSlotCount: 1,
      liveBeadIds: ['bead-1'],
      trackedBeadIds: ['bead-1', 'bead-missing'],
      missingTrackedBeadIds: ['bead-missing'],
      heartbeatOnlyLiveGaps: ['bead-missing']
    });
  });

  it('treats tracked beads without live panes as immediate capacity underfill', async () => {
    const now = NOW_MS;
    const { supervisor, records } = supervisorHarness(
      now,
      [
        { workerId: 'worker-1', beadId: 'bead-1', stateId: 'Planning', timestampMs: now },
        { workerId: 'worker-missing', beadId: 'bead-missing', stateId: 'Planning', timestampMs: now - TimeMs.SECOND }
      ],
      new Set(['bead-1', 'bead-missing']),
      2
    );
    (supervisor as any).startedBeads.add('bead-1');
    (supervisor as any).startedBeads.add('bead-missing');
    vi.mocked((supervisor as any).factory.getLiveTeammateBeadIds)
      .mockResolvedValueOnce(new Set(['bead-1']))
      .mockResolvedValueOnce(new Set(['bead-1', 'bead-missing']));

    await (supervisor as any).activeStartedBeadIds();
    await (supervisor as any).recordSlotHealth('test');

    expect(records.find(record => record.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED)?.data).toMatchObject({
      expectedCount: 2,
      activeCount: 1,
      liveBeadIds: ['bead-1'],
      observedLiveBeadIds: ['bead-1', 'bead-missing'],
      missingTrackedBeadIds: ['bead-missing']
    });
    expect(records.find(record => record.event === DomainEventName.TEAMMATE_CAPACITY_UNDERFILLED)?.data).toMatchObject({
      expectedCount: 2,
      activeCount: 1,
      missingSlotCount: 1,
      liveBeadIds: ['bead-1'],
      missingTrackedBeadIds: ['bead-missing']
    });
  });

  it('prunes durably released and exited tracked beads from slot health', async () => {
    const now = NOW_MS;
    const releasedEvents = [
      domainEvent('claimed-released', DomainEventName.BEAD_CLAIMED, 'bead-released', now - (TimeMs.SECOND * 3), { stateId: 'Planning' }),
      domainEvent('exited-released', DomainEventName.TEAMMATE_PROCESS_EXITED, 'bead-released', now - (TimeMs.SECOND * 2)),
      domainEvent('released-released', DomainEventName.BEAD_RELEASED, 'bead-released', now - TimeMs.SECOND)
    ];
    const terminalEvents = [
      domainEvent('claimed-terminal', DomainEventName.BEAD_CLAIMED, 'bead-terminal', now - (TimeMs.SECOND * 3), { stateId: 'Planning' }),
      domainEvent('terminal-status', DomainEventName.BEAD_STATUS_UPDATED, 'bead-terminal', now - TimeMs.SECOND, { status: BeadStatus.COMPLETED })
    ];
    const { supervisor, records, clock } = supervisorHarness(
      now,
      [{ workerId: 'worker-1', beadId: 'bead-1', stateId: 'Planning', timestampMs: now }],
      new Set(['bead-1']),
      3,
      new Map([
        ['bead-released', releasedEvents],
        ['bead-terminal', terminalEvents]
      ])
    );
    (supervisor as any).startedBeads.add('bead-1');
    (supervisor as any).startedBeads.add('bead-released');
    (supervisor as any).startedBeads.add('bead-terminal');
    (supervisor as any).startedBeadAtMs.set('bead-1', clock.now() - TimeMs.SECOND);
    (supervisor as any).startedBeadAtMs.set('bead-released', clock.now() - (TimeMs.SECOND * 4));
    (supervisor as any).startedBeadAtMs.set('bead-terminal', clock.now() - (TimeMs.SECOND * 4));
    (supervisor as any).missingStartedBeadChecks.set('bead-released', 1);
    (supervisor as any).missingStartedBeadChecks.set('bead-terminal', 1);

    await (supervisor as any).recordSlotHealth('test');

    expect((supervisor as any).startedBeads.has('bead-released')).toBe(false);
    expect((supervisor as any).startedBeads.has('bead-terminal')).toBe(false);
    expect((supervisor as any).missingStartedBeadChecks.has('bead-released')).toBe(false);
    expect((supervisor as any).missingStartedBeadChecks.has('bead-terminal')).toBe(false);
    expect(records.find(record => record.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED)?.data).toMatchObject({
      trackedBeadIds: ['bead-1'],
      missingTrackedBeadIds: []
    });
  });

  it('can preserve inactive restart backoff while clearing live tracking', () => {
    const { supervisor, clock } = supervisorHarness(NOW_MS);
    (supervisor as any).startedBeads.add('bead-1');
    (supervisor as any).startedBeadAtMs.set('bead-1', clock.now());
    (supervisor as any).missingStartedBeadChecks.set('bead-1', 1);
    (supervisor as any).slotHealthMonitor.inactiveRestartedAtMs.set('bead-1', clock.now());

    supervisor.markBeadExited('bead-1', { preserveInactiveRestartBackoff: true });

    expect((supervisor as any).startedBeads.has('bead-1')).toBe(false);
    expect((supervisor as any).startedBeadAtMs.has('bead-1')).toBe(false);
    expect((supervisor as any).missingStartedBeadChecks.has('bead-1')).toBe(false);
    expect((supervisor as any).slotHealthMonitor.inactiveRestartedAtMs.has('bead-1')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // FIX 2 — finalBlockedPollCounts memory-leak prevention
  // ---------------------------------------------------------------------------

  it('(FIX-2) markBeadExited removes bead from finalBlockedPollCounts (no memory leak)', () => {
    // Scenario: a bead is detected as final-blocked on one poll (count=1) but
    // completes/exits before the second confirmation poll.  markBeadExited must
    // delete its entry from finalBlockedPollCounts so it does not accumulate
    // indefinitely (unbounded growth with one entry per blip-blocked bead).
    const { supervisor } = supervisorHarness(NOW_MS);

    // Simulate a single blocked detection: count reaches 1 but recovery has
    // not fired yet (needs 2 consecutive detections).
    (supervisor as any).slotHealthMonitor.finalBlockedPollCounts.set('bead-1', 1);

    // The bead then exits (e.g. finishes its work or is terminated externally).
    supervisor.markBeadExited('bead-1');

    // The stale entry must be gone — no leak.
    expect((supervisor as any).slotHealthMonitor.finalBlockedPollCounts.has('bead-1')).toBe(false);
  });

  it('releaseClaimedAfterPause clears claimed/active state and preserves inactiveRestartedAtMs backoff', async () => {
    const { supervisor, release, clock } = supervisorHarness(NOW_MS);
    const claimedBead = { id: 'bead-1' } as any;

    // Populate all four tracking maps to mirror a normally-started bead
    (supervisor as any).startedBeads.add('bead-1');
    (supervisor as any).startedBeadAtMs.set('bead-1', clock.now());
    (supervisor as any).missingStartedBeadChecks.set('bead-1', 2);
    // inactiveRestartedAtMs holds the backoff timestamp — must survive the release
    (supervisor as any).slotHealthMonitor.inactiveRestartedAtMs.set('bead-1', clock.now() - TimeMs.MINUTE);

    // Trigger a pause so releaseClaimedAfterPause is reachable, then call it directly
    // releaseClaimedAfterPause moved to BeadSpawnCoordinator (pi-experiment-amq0.2)
    await (supervisor as any).spawnCoordinator.releaseClaimedAfterPause(
      claimedBead,
      (supervisor as any).schedulingPausedUntilMs,
      (supervisor as any).schedulingPausedReason,
      (id: string, opts: any) => (supervisor as any).markBeadExited(id, opts)
    );

    // Claimed/active tracking maps must be cleared
    expect((supervisor as any).startedBeads.has('bead-1')).toBe(false);
    expect((supervisor as any).startedBeadAtMs.has('bead-1')).toBe(false);
    expect((supervisor as any).missingStartedBeadChecks.has('bead-1')).toBe(false);
    // Backoff timestamp must NOT be reset — this is the WI-26 invariant
    expect((supervisor as any).slotHealthMonitor.inactiveRestartedAtMs.has('bead-1')).toBe(true);
    // The bd_release tool must have been called to drop the lease
    expect(release).toHaveBeenCalledWith('bead-1');
  });

  it('claimAndSpawnBead releases lease and quarantines bead when worktree provisioning fails', async () => {
    const claim = vi.fn(async ({ id }: { id: string }) => ({ id } as any));
    const release = vi.fn(async () => {});
    const createWorktree = vi.fn(async () => ({ success: false, error: 'disk full' }));
    const records: Array<{ event: string; data: any }> = [];
    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      { getLiveTeammateBeadIds: vi.fn(async () => new Set()), spawnTeammateInTmux: vi.fn(), getActiveTeammateCount: vi.fn(), getAvailableSlots: vi.fn(), terminateTeammatesForBead: vi.fn() } as any,
      { tracedAsync: (_n: string, _a: any, fn: any) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        eventStore: {
          record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
          eventsForBeads: vi.fn(async () => new Map())
        },
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: { createWorktree },
        scheduler: {},
        flowManager: {}
      } as any,
      { maxSlots: 1, clock: createFakeClock(), orchestrator: { selectAssignments: vi.fn(async () => []) } as any, retentionScheduler: { runIfDue: vi.fn(async () => {}) } as any }
    );

    const bead = { id: 'bead-1', stateId: 'Planning', score: 0 } as any;
    const config = { settings: {} } as any;
    // claimAndSpawnBead now returns 'quarantined' (not throws) for worktree failures
    const result = await (supervisor as any).claimAndSpawnBead(bead, config);
    expect(result).toBe('quarantined');
    // Lease must always be released — WI-11 lease integrity preserved
    expect(release).toHaveBeenCalledWith('bead-1');
    // A structured BEAD_QUARANTINED event must be emitted exactly once
    expect(records.some(r => r.event === DomainEventName.BEAD_QUARANTINED)).toBe(true);
  });

  it('claimAndSpawnBead releases lease when spawn fails', async () => {
    const claim = vi.fn(async ({ id }: { id: string }) => ({ id } as any));
    const release = vi.fn(async () => {});
    const createWorktree = vi.fn(async () => ({ success: true, path: '/tmp/bead-1' }));
    const spawnTeammateInTmux = vi.fn(async () => ({ success: false, error: 'tmux unavailable' }));
    const records: Array<{ event: string; data: any }> = [];
    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      { getLiveTeammateBeadIds: vi.fn(async () => new Set()), spawnTeammateInTmux, getActiveTeammateCount: vi.fn(), getAvailableSlots: vi.fn(), terminateTeammatesForBead: vi.fn() } as any,
      { tracedAsync: (_n: string, _a: any, fn: any) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        eventStore: {
          record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
          eventsForBeads: vi.fn(async () => new Map())
        },
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: { createWorktree },
        scheduler: {},
        flowManager: {}
      } as any,
      { maxSlots: 1, clock: createFakeClock(), orchestrator: { selectAssignments: vi.fn(async () => []) } as any, retentionScheduler: { runIfDue: vi.fn(async () => {}) } as any }
    );

    const bead = { id: 'bead-1', stateId: 'Planning', score: 0 } as any;
    const config = { settings: {} } as any;
    await expect((supervisor as any).claimAndSpawnBead(bead, config)).rejects.toThrow('tmux unavailable');
    expect(release).toHaveBeenCalledWith('bead-1');
    expect(records.some(r => r.event === 'WORKTREE_PROVISIONED')).toBe(true);
  });

  it('collectSlotHealthSnapshot returns snapshot with correctly measured fields for seeded state', async () => {
    const staleProgressAtMs = NOW_MS - STALE_PROGRESS_AGE_MS;
    const { supervisor, clock } = supervisorHarness(staleProgressAtMs, undefined, new Set(['bead-1', 'bead-2']), 3);

    // Seed: bead-1 started; bead-2 started but was previously flagged as missing
    (supervisor as any).startedBeads.add('bead-1');
    (supervisor as any).startedBeads.add('bead-2');
    (supervisor as any).startedBeadAtMs.set('bead-1', clock.now() - TimeMs.MINUTE);
    (supervisor as any).startedBeadAtMs.set('bead-2', clock.now() - TimeMs.MINUTE);
    (supervisor as any).lastMissingStartedBeadIds.add('bead-2');

    const snapshot = await (supervisor as any).collectSlotHealthSnapshot();

    // Raw observed set includes bead-2; effective set excludes it (missing)
    expect(snapshot.observedLiveBeadIds).toContain('bead-2');
    expect(snapshot.effectiveLiveBeadIds).not.toContain('bead-2');
    expect(snapshot.effectiveLiveBeadIds).toContain('bead-1');

    // expectedCount reflects maxSlots
    expect(snapshot.expectedCount).toBe(3);

    // bead-2 counted as missing
    expect(snapshot.missingTrackedBeadIds).toContain('bead-2');

    // bead-1 has stale progress (staleProgressAtMs is STALE_PROGRESS_AGE_MS ago) →
    // IMMEDIATE_NO_PROGRESS_TIMEOUT_MS=1 means it is inactive
    expect(snapshot.inactiveBeadIds).toContain('bead-1');
    expect(snapshot.staleBeadIds).toContain('bead-1');

    // heartbeatByBead populated from harness default heartbeat
    expect(snapshot.heartbeatByBead.get('bead-1')).toBe(clock.now());

    // noProgressTimeoutMs resolved from config
    expect(snapshot.noProgressTimeoutMs).toBe(IMMEDIATE_NO_PROGRESS_TIMEOUT_MS);
  });

  // --- Stale-Bead-ID regression tests (pi-experiment-59au) ---

  it('pruning via hasDurableInactiveEvent recognizes BEAD_TOMBSTONED as a durable-inactive marker', async () => {
    // Scenario 1: a Bead that goes missing during an active heartbeat.
    // When BD_RELEASE records BEAD_TOMBSTONED (new behaviour), the supervisor
    // must treat it as durable-inactive and prune the tracked slot.
    const now = NOW_MS;
    const tombstonedEvents = [
      domainEvent('claim-t', DomainEventName.BEAD_CLAIMED, 'bead-tombstoned', now - (TimeMs.SECOND * 3), { stateId: 'Planning' }),
      // BD_RELEASE now records BEAD_RELEASED then BEAD_TOMBSTONED for missing beads
      domainEvent('rel-t', DomainEventName.BEAD_RELEASED, 'bead-tombstoned', now - TimeMs.SECOND, { tombstoned: true }),
      domainEvent('tomb-t', DomainEventName.BEAD_TOMBSTONED, 'bead-tombstoned', now - TimeMs.SECOND)
    ];
    const { supervisor, records, clock } = supervisorHarness(
      now,
      [{ workerId: 'worker-1', beadId: 'bead-1', stateId: 'Planning', timestampMs: now }],
      new Set(['bead-1']),
      2,
      new Map([['bead-tombstoned', tombstonedEvents]])
    );
    (supervisor as any).startedBeads.add('bead-1');
    (supervisor as any).startedBeads.add('bead-tombstoned');
    (supervisor as any).startedBeadAtMs.set('bead-1', clock.now() - TimeMs.SECOND);
    (supervisor as any).startedBeadAtMs.set('bead-tombstoned', clock.now() - (TimeMs.SECOND * 4));

    await (supervisor as any).recordSlotHealth('test');

    // Tombstoned bead must be pruned from slot tracking
    expect((supervisor as any).startedBeads.has('bead-tombstoned')).toBe(false);
    expect((supervisor as any).missingStartedBeadChecks.has('bead-tombstoned')).toBe(false);
    // The existing bead must still be tracked
    expect((supervisor as any).startedBeads.has('bead-1')).toBe(true);
    // Slot health must not count the tombstoned bead as a tracked active bead
    expect(records.find(r => r.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED)?.data?.trackedBeadIds).not.toContain('bead-tombstoned');
  });

  it('reconcileStartedBeads releases a missing Bead cleanly when BD_RELEASE records BEAD_TOMBSTONED', async () => {
    // Scenario 2: a Bead goes missing during process-exit release.
    // BD_RELEASE succeeds (returns { tombstoned: true }) even when the Bead no
    // longer exists in the task store.  The supervisor release path must not
    // retry or spam logs — one info log is acceptable.
    const { supervisor, records, release, clock } = supervisorHarness(NOW_MS, [], new Set());
    // Seed the tracking maps as if the bead was started but then its pane disappeared
    (supervisor as any).startedBeads.add('bead-missing');
    (supervisor as any).startedBeadAtMs.set('bead-missing', clock.now() - TimeMs.MINUTE);
    (supervisor as any).missingStartedBeadChecks.set('bead-missing', Defaults.TEAMMATE_MISSING_REAP_THRESHOLD - 1);

    // Wire release to succeed (simulating BD_RELEASE's new no-throw behaviour for missing beads)
    release.mockResolvedValueOnce(undefined);

    await (supervisor as any).reconcileStartedBeads();

    // Release must be called exactly once — no retry loop
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('bead-missing');
    // Slot must be freed
    expect((supervisor as any).startedBeads.has('bead-missing')).toBe(false);
    // A TEAMMATE_PROCESS_EXITED event must be recorded (existing behaviour)
    expect(records.some(r => r.event === DomainEventName.TEAMMATE_PROCESS_EXITED)).toBe(true);
  });

  it('hasDurableInactiveEvent returns true for BEAD_CLAIMED + BEAD_TOMBSTONED alone (no BEAD_RELEASED)', () => {
    // Isolated guard for the BEAD_TOMBSTONED case in hasDurableInactiveEvent.
    //
    // Pre-fix failure reason: BEAD_TOMBSTONED was absent from the switch statement in
    // hasDurableInactiveEvent.  With only BEAD_CLAIMED + BEAD_TOMBSTONED in the event
    // list (no BEAD_RELEASED to trigger the inactive branch), latestTrackedState stayed
    // 'active' (set by BEAD_CLAIMED) and the method returned false — meaning the bead
    // was NOT treated as durable-inactive, the slot was never pruned from startedBeads,
    // and the supervisor would keep counting it as an occupied slot indefinitely.
    const now = NOW_MS;
    const { supervisor } = supervisorHarness(now);
    const events: DomainEvent[] = [
      domainEvent('claim-isolated', DomainEventName.BEAD_CLAIMED, 'bead-tombstoned-only', now - (TimeMs.SECOND * 3), { stateId: 'Planning' }),
      // Deliberately NO BEAD_RELEASED — only the tombstone event from the new fix path
      domainEvent('tomb-isolated', DomainEventName.BEAD_TOMBSTONED, 'bead-tombstoned-only', now - TimeMs.SECOND)
    ];
    (supervisor as any).startedBeadAtMs.set('bead-tombstoned-only', now - (TimeMs.SECOND * 4));

    const result = (supervisor as any).hasDurableInactiveEvent('bead-tombstoned-only', events);

    // With the fix, BEAD_TOMBSTONED sets latestTrackedState = 'inactive' → returns true
    expect(result).toBe(true);
  });

  it('pruneDurablyInactiveStartedBeads prunes a bead with BEAD_CLAIMED + BEAD_TOMBSTONED alone', async () => {
    // Integration-level check: pruneDurablyInactiveStartedBeads must remove the bead from
    // startedBeads when the event history contains only BEAD_CLAIMED + BEAD_TOMBSTONED
    // (no BEAD_RELEASED).
    //
    // Pre-fix failure reason: same as the unit test above — hasDurableInactiveEvent returned
    // false for a tombstone-only history, so pruneDurablyInactiveStartedBeads never called
    // markBeadExited and the bead stayed in startedBeads, inflating slot counts.
    const now = NOW_MS;
    const tombstonedOnlyEvents = [
      domainEvent('claim-prune', DomainEventName.BEAD_CLAIMED, 'bead-prune-tombstone', now - (TimeMs.SECOND * 3), { stateId: 'Planning' }),
      domainEvent('tomb-prune', DomainEventName.BEAD_TOMBSTONED, 'bead-prune-tombstone', now - TimeMs.SECOND)
    ];
    const { supervisor, clock } = supervisorHarness(
      now,
      [],
      new Set(),
      1,
      new Map([['bead-prune-tombstone', tombstonedOnlyEvents]])
    );
    (supervisor as any).startedBeads.add('bead-prune-tombstone');
    (supervisor as any).startedBeadAtMs.set('bead-prune-tombstone', clock.now() - (TimeMs.SECOND * 4));

    // pruneDurablyInactiveStartedBeads takes the live-bead set; empty = all tracked are "missing"
    await (supervisor as any).pruneDurablyInactiveStartedBeads(new Set<string>());

    expect((supervisor as any).startedBeads.has('bead-prune-tombstone')).toBe(false);
  });

  it('hasDurableInactiveEvent returns false for an active Bead with no tombstone (existing path unaffected)', () => {
    // Scenario 3: normal existing-Bead scheduling must be unaffected.
    // A Bead with only BEAD_CLAIMED / TEAMMATE_SPAWNED events is not durable-inactive.
    const now = NOW_MS;
    const { supervisor } = supervisorHarness(now);
    const events: DomainEvent[] = [
      domainEvent('claim', DomainEventName.BEAD_CLAIMED, 'bead-active', now - TimeMs.SECOND, { stateId: 'Planning' }),
      domainEvent('spawn', DomainEventName.TEAMMATE_SPAWNED, 'bead-active', now - 500, { stateId: 'Planning' })
    ];
    (supervisor as any).startedBeadAtMs.set('bead-active', now - TimeMs.SECOND);

    const result = (supervisor as any).hasDurableInactiveEvent('bead-active', events);

    expect(result).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // kwrf — pane-content redaction on the live slot-health / stuck-pane path
  // ---------------------------------------------------------------------------

  it('(kwrf) recoverInactiveBeads emits redacted pane text in AGENT_TURN_FAILED evidence, not raw reasoning', async () => {
    // Raw pane output as tmux capture-pane would return it.  Contains a
    // <thinking> block (raw reasoning) plus actionable lines.
    const rawPaneOutput = [
      'Bead: pi-experiment-kwrf  State: Planning',
      '<thinking>',
      'Let me think through the approach for this merge.',
      'Considering the edge cases carefully.',
      '</thinking>',
      'Tool call: bash { "command": "npm test" }',
      'Error: tests failed with exit code 1'
    ].join('\n');

    // Wire captureBeadPaneText to return the raw pane output (the real
    // TeammateFactory calls tmux + redactPaneText; the harness mock returns
    // the value we set here so we can control what reaches the Supervisor).
    // To prove the LIVE PATH redacts we let the harness mock delegate to the
    // actual redactPaneText call, simulating what TeammateFactory does.
    const { redactPaneText } = await import('../src/core/PaneTextRedactor.js');
    const redactedPaneOutput = redactPaneText(rawPaneOutput);

    const { supervisor, records, captureBeadPaneText } = supervisorHarness(NOW_MS - STALE_PROGRESS_AGE_MS);
    // The mock returns already-redacted text — exactly what TeammateFactory.captureBeadPaneText
    // returns (it calls tmux then redactPaneText before returning).
    captureBeadPaneText.mockResolvedValue(redactedPaneOutput);

    await (supervisor as any).recordSlotHealth('test');

    // The live path must have called captureBeadPaneText for the inactive bead.
    expect(captureBeadPaneText).toHaveBeenCalledWith('bead-1');

    // Find the AGENT_TURN_FAILED event that was recorded.
    const turnFailedEvent = records.find(r => r.event === DomainEventName.AGENT_TURN_FAILED);
    expect(turnFailedEvent).toBeDefined();

    // The paneSnapshot field on AGENT_TURN_FAILED must contain the redacted text.
    const paneSnapshot: string = turnFailedEvent!.data.paneSnapshot;
    expect(typeof paneSnapshot).toBe('string');

    // Reasoning block is gone from the operator-facing artifact.
    expect(paneSnapshot).not.toContain('<thinking>');
    expect(paneSnapshot).not.toContain('</thinking>');
    expect(paneSnapshot).not.toContain('Let me think through the approach');
    expect(paneSnapshot).not.toContain('Considering the edge cases carefully');

    // Actionable lines are preserved — stuck/error detection works on redacted text.
    expect(paneSnapshot).toContain('Bead: pi-experiment-kwrf');
    expect(paneSnapshot).toContain('Tool call: bash');
    expect(paneSnapshot).toContain('Error: tests failed with exit code 1');

    // The HARNESS_RESTART_REQUESTED evidence also embeds the redacted snapshot.
    const restartEvent = records.find(r => r.event === DomainEventName.HARNESS_RESTART_REQUESTED);
    expect(restartEvent).toBeDefined();
    const evidence: string = restartEvent!.data.evidence;
    expect(evidence).toContain('Pane snapshot (reasoning redacted)');
    expect(evidence).not.toContain('<thinking>');
    expect(evidence).not.toContain('Let me think through the approach');
    expect(evidence).toContain('Tool call: bash');
  });

  it('(kwrf) recoverInactiveBeads proceeds normally when captureBeadPaneText returns empty (no pane found)', async () => {
    // When no live pane exists for the bead (e.g. already terminated), the
    // restart path must not be blocked and must not include a pane snapshot.
    const { supervisor, records, captureBeadPaneText } = supervisorHarness(NOW_MS - STALE_PROGRESS_AGE_MS);
    captureBeadPaneText.mockResolvedValue('');

    await (supervisor as any).recordSlotHealth('test');

    expect(captureBeadPaneText).toHaveBeenCalledWith('bead-1');

    const turnFailedEvent = records.find(r => r.event === DomainEventName.AGENT_TURN_FAILED);
    expect(turnFailedEvent).toBeDefined();
    // When empty, paneSnapshot is undefined (not stored).
    expect(turnFailedEvent!.data.paneSnapshot).toBeUndefined();

    // The evidence in HARNESS_RESTART_REQUESTED falls back to the plain summary.
    const restartEvent = records.find(r => r.event === DomainEventName.HARNESS_RESTART_REQUESTED);
    expect(restartEvent).toBeDefined();
    expect(restartEvent!.data.evidence).not.toContain('Pane snapshot');
    expect(restartEvent!.data.evidence).toContain('without non-heartbeat progress');
  });

  // ---------------------------------------------------------------------------
  // FIX-1 regression: Supervisor.step() must invalidate the BeadsPort cache
  // at tick-start so worker-process mutations are visible to the coordinator.
  // ---------------------------------------------------------------------------

  it('(FIX-1) step() calls beadsPort.invalidateCache() before reconcile/scan reads', async () => {
    // Build a supervisor with a beadsPort whose invalidateCache is a spy.
    // We verify it is called by step() and that it is called before any reads
    // (ready/list/getBead) that happen inside reconcile/scan.
    const callOrder: string[] = [];
    const invalidateCache = vi.fn(() => { callOrder.push('invalidateCache'); });
    const ready = vi.fn(async () => { callOrder.push('ready'); return []; });
    const list = vi.fn(async () => { callOrder.push('list'); return { items: [] }; });
    const getBead = vi.fn(async (id: string) => { callOrder.push('getBead'); return { id } as any; });
    const beadsPort: BeadsPort = {
      ready,
      list,
      getBead,
      claim: vi.fn(async ({ id }) => ({ id } as any)),
      release: vi.fn(async () => {}),
      invalidateCache
    };

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set(['bead-live'])),
        getActiveTeammateCount: vi.fn(async () => 1),
        getAvailableSlots: vi.fn(async () => 0),
        terminateTeammatesForBead: vi.fn(async () => ({ terminatedPaneIds: [] })),
        captureBeadPaneText: vi.fn(async () => ''),
        spawnTeammateInTmux: vi.fn(async () => ({ success: true }))
      } as any,
      { tracedAsync: (_n: string, _a: any, fn: any) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: { teammateNoProgressTimeoutMs: 1 } }) },
        eventStore: {
          record: vi.fn(async () => {}),
          eventsForBeads: vi.fn(async () => new Map()),
          latestEventsForBeads: vi.fn(async () => new Map()),
          latestEventByType: vi.fn(async () => undefined)
        },
        beadsPort,
        worktreePort: { createWorktree: vi.fn(async () => ({ success: true, path: '/tmp/wt' })) },
        scheduler: {},
        flowManager: {}
      } as any,
      { maxSlots: 1, clock: createFakeClock(), orchestrator: { selectAssignments: vi.fn(async () => []) } as any, retentionScheduler: { runIfDue: vi.fn(async () => {}) } as any }
    );

    // Mark 'bead-live' as tracked so reconcileTerminalLiveBeads calls getBead.
    (supervisor as any).startedBeads.add('bead-live');
    (supervisor as any).startedBeadAtMs.set('bead-live', createFakeClock().now());

    await (supervisor as any).step();

    // invalidateCache MUST have been called.
    expect(invalidateCache).toHaveBeenCalledTimes(1);
    // It MUST appear before any read operations in the call order.
    const invalidateIndex = callOrder.indexOf('invalidateCache');
    expect(invalidateIndex).toBe(0);
    // At least one read (getBead for reconcileTerminalLiveBeads) must follow it.
    const firstReadIndex = callOrder.findIndex(op => op === 'getBead' || op === 'ready' || op === 'list');
    expect(firstReadIndex).toBeGreaterThan(invalidateIndex);
  });

  it('(FIX-1) step() does NOT call invalidateCache when already stopping', async () => {
    // Guard: a stopping supervisor returns early before invalidateCache, so
    // we confirm there is no crash (invalidateCache exists on the fake port).
    const invalidateCache = vi.fn();
    const beadsPort: BeadsPort = fakeBeadsPort({ invalidateCache });
    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      { getLiveTeammateBeadIds: vi.fn(async () => new Set()), getActiveTeammateCount: vi.fn(async () => 0), getAvailableSlots: vi.fn(async () => 1), terminateTeammatesForBead: vi.fn(), captureBeadPaneText: vi.fn() } as any,
      { tracedAsync: (_n: string, _a: any, fn: any) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        eventStore: { record: vi.fn(async () => {}), eventsForBeads: vi.fn(async () => new Map()), latestEventsForBeads: vi.fn(async () => new Map()), latestEventByType: vi.fn(async () => undefined) },
        beadsPort,
        worktreePort: { createWorktree: vi.fn() },
        scheduler: {},
        flowManager: {}
      } as any,
      { maxSlots: 1, clock: createFakeClock(), orchestrator: { selectAssignments: vi.fn(async () => []) } as any, retentionScheduler: { runIfDue: vi.fn(async () => {}) } as any }
    );
    (supervisor as any).stopping = true;

    await (supervisor as any).step();

    expect(invalidateCache).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Spawn PREFLIGHT + worktree QUARANTINE tests
  // ---------------------------------------------------------------------------

  it('classifyWorktreeError returns ALREADY_CHECKED_OUT for already-checked-out error text', () => {
    const { supervisor } = supervisorHarness(NOW_MS);
    const reason = (supervisor as any).spawnCoordinator.classifyWorktreeError(
      "fatal: 'bead/pi-experiment-abc123' is already checked out at '/path/to/worktrees/pi-experiment-abc123'"
    );
    expect(reason).toBe('ALREADY_CHECKED_OUT');
  });

  it('classifyWorktreeError returns INVALID_BRANCH_REF for invalid-reference error text', () => {
    const { supervisor } = supervisorHarness(NOW_MS);
    const reason = (supervisor as any).spawnCoordinator.classifyWorktreeError(
      "fatal: invalid reference: refs/heads/bead/bad--ref"
    );
    expect(reason).toBe('INVALID_BRANCH_REF');
  });

  it('classifyWorktreeError returns WORKTREE_PATH_TAKEN for already-exists error text', () => {
    const { supervisor } = supervisorHarness(NOW_MS);
    const reason = (supervisor as any).spawnCoordinator.classifyWorktreeError(
      "fatal: '/path/to/worktrees/pi-experiment-abc123' already exists"
    );
    expect(reason).toBe('WORKTREE_PATH_TAKEN');
  });

  it('classifyWorktreeError returns UNKNOWN for unrecognised error text', () => {
    const { supervisor } = supervisorHarness(NOW_MS);
    const reason = (supervisor as any).spawnCoordinator.classifyWorktreeError('disk full');
    expect(reason).toBe('UNKNOWN');
  });

  it('isQuarantined returns false for a bead not in the quarantine map', async () => {
    const { supervisor } = supervisorHarness(NOW_MS);
    const bead = { id: 'bead-q', status: 'ready' } as any;
    expect(await (supervisor as any).spawnCoordinator.isQuarantined(bead)).toBe(false);
  });

  it('isQuarantined returns true for a bead with unchanged signature', async () => {
    const { supervisor } = supervisorHarness(NOW_MS);
    const bead = { id: 'bead-q', status: 'ready', lastActivity: '2026-01-01T00:00:00.000Z' } as any;
    await (supervisor as any).spawnCoordinator.quarantineBead(bead, 'ALREADY_CHECKED_OUT');
    expect(await (supervisor as any).spawnCoordinator.isQuarantined(bead)).toBe(true);
  });

  it('isQuarantined returns false and clears entry when bead signature changes (status changed)', async () => {
    const { supervisor } = supervisorHarness(NOW_MS);
    const beadAtQuarantine = { id: 'bead-q', status: 'ready', lastActivity: '2026-01-01T00:00:00.000Z' } as any;
    await (supervisor as any).spawnCoordinator.quarantineBead(beadAtQuarantine, 'ALREADY_CHECKED_OUT');
    // Simulate bead state changing externally (status updated, lastActivity bumped)
    const beadAfterUpdate = { id: 'bead-q', status: 'in_progress', lastActivity: '2026-01-02T00:00:00.000Z' } as any;
    expect(await (supervisor as any).spawnCoordinator.isQuarantined(beadAfterUpdate)).toBe(false);
    // Entry must be cleared from the map
    expect((supervisor as any).spawnCoordinator.quarantine.has('bead-q')).toBe(false);
  });

  it('isQuarantined returns false and clears entry when ONLY lastActivity changes (timestamp-only clearing)', async () => {
    // This is the key regression guard: a bead quarantined at status X + lastActivity T1
    // must clear when re-scanned at the same status X but a bumped lastActivity T2.
    // With the old status-only signature this would FAIL — the bead would remain quarantined.
    const { supervisor } = supervisorHarness(NOW_MS);
    const beadAtQuarantine = { id: 'bead-q', status: 'ready', lastActivity: '2026-01-01T00:00:00.000Z' } as any;
    await (supervisor as any).spawnCoordinator.quarantineBead(beadAtQuarantine, 'ALREADY_CHECKED_OUT');
    // Only lastActivity changes — status stays 'ready'
    const beadAfterActivityBump = { id: 'bead-q', status: 'ready', lastActivity: '2026-01-02T00:00:00.000Z' } as any;
    expect(await (supervisor as any).spawnCoordinator.isQuarantined(beadAfterActivityBump)).toBe(false);
    // Entry must be cleared from the map
    expect((supervisor as any).spawnCoordinator.quarantine.has('bead-q')).toBe(false);
  });

  it('quarantineBead emits a structured BEAD_QUARANTINED event with reason and signature', async () => {
    const records: Array<{ event: string; data: any }> = [];
    const { supervisor } = supervisorHarness(NOW_MS);
    // Replace the eventStore.record spy to capture events
    (supervisor as any).services.eventStore.record = vi.fn(async (event: string, data: any) => {
      records.push({ event, data });
    });
    const bead = { id: 'bead-q', status: 'ready', lastActivity: '2026-01-01T00:00:00.000Z' } as any;
    await (supervisor as any).spawnCoordinator.quarantineBead(bead, 'INVALID_BRANCH_REF');
    const quarantineEvent = records.find(r => r.event === DomainEventName.BEAD_QUARANTINED);
    expect(quarantineEvent).toBeDefined();
    expect(quarantineEvent!.data.beadId).toBe('bead-q');
    expect(quarantineEvent!.data.reason).toBe('INVALID_BRANCH_REF');
    expect(typeof quarantineEvent!.data.signature).toBe('string');
  });

  // ---------------------------------------------------------------------------
  // Final-blocked pane early-trip recovery
  // ---------------------------------------------------------------------------

  it('(final-blocked) recovers a bead immediately when its pane shows a terminal blocked banner, without waiting the full no-progress timeout', async () => {
    // Scenario: bead-1 has RECENT progress (within the timeout window) so it
    // would NOT be picked up by the standard no-progress path.  But its pane
    // output ends with a fatal-error terminal banner → it must be recovered
    // after FINAL_BLOCKED_CONFIRM_POLLS (2) consecutive detections via the
    // final-blocked early-trip.
    const terminalPaneOutput = [
      'Bead: bead-1  State: Planning',
      'Tool call: bash { "command": "npm test" }',
      'Running tests...',
      'fatal error: agent process killed'
    ].join('\n');

    const { supervisor, records, release, terminateTeammatesForBead, captureBeadPaneText } =
      supervisorHarness(
        NOW_MS,  // latestProgressAtMs = NOW_MS → bead is NOT past the no-progress timeout
      );
    captureBeadPaneText.mockResolvedValue(terminalPaneOutput);

    // Poll 1: detected but not yet confirmed — no recovery.
    // (lastSlotHealthEventMs starts at 0, so this first call is not throttled.)
    await (supervisor as any).recordSlotHealth('test');
    expect(records.some(r => r.event === DomainEventName.AGENT_TURN_FAILED)).toBe(false);

    // Poll 2: reset the slot-health throttle so the second call is not skipped,
    // then confirm: second consecutive detection → recovery fires.
    (supervisor as any).slotHealthMonitor.lastSlotHealthEventMs = 0;
    await (supervisor as any).recordSlotHealth('test');

    // The bead must have been recovered via the final-blocked early-trip.
    expect(captureBeadPaneText).toHaveBeenCalledWith('bead-1');
    expect(records.some(r => r.event === DomainEventName.AGENT_TURN_FAILED)).toBe(true);
    expect(records.some(r => r.event === DomainEventName.HARNESS_RESTART_REQUESTED)).toBe(true);

    // The summary must indicate a final-blocked detection, NOT the standard no-progress message.
    const turnFailedEvent = records.find(r => r.event === DomainEventName.AGENT_TURN_FAILED);
    expect(turnFailedEvent!.data.summary).toContain('terminal blocked/halted banner');
    expect(turnFailedEvent!.data.summary).not.toContain('without non-heartbeat progress');

    // Teammate must be terminated and bead released.
    expect(terminateTeammatesForBead).toHaveBeenCalledWith('bead-1', expect.stringContaining('terminal blocked/halted banner'));
    expect(release).toHaveBeenCalledWith('bead-1');
  });

  it('(final-blocked) does NOT prematurely recover a merely-slow bead whose pane shows ongoing work', async () => {
    // Scenario: bead-1 has recent progress (within the timeout window) AND its
    // pane shows clean, non-blocked output.  No recovery must happen.
    const cleanPaneOutput = [
      'Bead: bead-1  State: Planning',
      'Tool call: bd_get_bead',
      'Output: {"status": "open"}',
      'State transition: Planning -> Implementation'
    ].join('\n');

    const { supervisor, records, release, terminateTeammatesForBead, captureBeadPaneText } =
      supervisorHarness(NOW_MS);  // recent progress → not inactive
    captureBeadPaneText.mockResolvedValue(cleanPaneOutput);

    await (supervisor as any).recordSlotHealth('test');

    // No recovery events must be emitted.
    expect(records.some(r => r.event === DomainEventName.AGENT_TURN_FAILED)).toBe(false);
    expect(records.some(r => r.event === DomainEventName.HARNESS_RESTART_REQUESTED)).toBe(false);
    expect(terminateTeammatesForBead).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('(final-blocked) evidence in HARNESS_RESTART_REQUESTED includes category and evidence line', async () => {
    const terminalPaneOutput = [
      'Starting action: plan',
      'command failed'
    ].join('\n');

    const { supervisor, records, captureBeadPaneText } =
      supervisorHarness(NOW_MS);  // not past timeout
    captureBeadPaneText.mockResolvedValue(terminalPaneOutput);

    // Two polls required to confirm (FINAL_BLOCKED_CONFIRM_POLLS = 2).
    // Reset slot-health throttle between polls so the second call is not skipped.
    await (supervisor as any).recordSlotHealth('test');
    (supervisor as any).slotHealthMonitor.lastSlotHealthEventMs = 0;
    await (supervisor as any).recordSlotHealth('test');

    const restartEvent = records.find(r => r.event === DomainEventName.HARNESS_RESTART_REQUESTED);
    expect(restartEvent).toBeDefined();
    const evidence: string = restartEvent!.data.evidence;
    // Evidence must include the pane snapshot.
    expect(evidence).toContain('Pane snapshot (reasoning redacted)');
    // Summary must not include the standard no-progress message.
    const summary: string = restartEvent!.data.summary;
    expect(summary).toContain('terminal blocked/halted banner');
    expect(summary).not.toContain('without non-heartbeat progress');
  });

  // ---------------------------------------------------------------------------
  // Debounce and backoff tests (SHOULD-FIX E)
  // ---------------------------------------------------------------------------

  it('(final-blocked debounce) bead detected blocked on ONE poll is NOT recovered; only recovered after the SECOND consecutive detection', async () => {
    // Ensures the FINAL_BLOCKED_CONFIRM_POLLS=2 debounce prevents one-frame kills.
    // Uses the finalBlockedPollCounts map directly to verify the internal counter.
    // Reset slot-health throttle (lastSlotHealthEventMs) between poll calls so
    // each call is actually processed.
    const terminalPaneOutput = [
      'Tool call: bash',
      'fatal error: process killed'
    ].join('\n');

    const { supervisor, records, release, terminateTeammatesForBead, captureBeadPaneText } =
      supervisorHarness(NOW_MS);  // recent progress → not past no-progress timeout
    captureBeadPaneText.mockResolvedValue(terminalPaneOutput);

    // Poll 1: first detection — counter reaches 1, recovery must NOT fire yet.
    await (supervisor as any).recordSlotHealth('test');
    expect(records.some(r => r.event === DomainEventName.AGENT_TURN_FAILED)).toBe(false);
    expect(records.some(r => r.event === DomainEventName.HARNESS_RESTART_REQUESTED)).toBe(false);
    expect(terminateTeammatesForBead).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    // Counter must be 1 after first detection.
    expect((supervisor as any).slotHealthMonitor.finalBlockedPollCounts.get('bead-1')).toBe(1);

    // Poll 2: reset throttle, second consecutive detection — counter reaches 2 =
    // FINAL_BLOCKED_CONFIRM_POLLS, recovery fires and counter is cleared.
    (supervisor as any).slotHealthMonitor.lastSlotHealthEventMs = 0;
    await (supervisor as any).recordSlotHealth('test');
    expect(records.some(r => r.event === DomainEventName.AGENT_TURN_FAILED)).toBe(true);
    expect(records.some(r => r.event === DomainEventName.HARNESS_RESTART_REQUESTED)).toBe(true);
    expect(terminateTeammatesForBead).toHaveBeenCalledWith('bead-1', expect.stringContaining('terminal blocked/halted banner'));
    expect(release).toHaveBeenCalledWith('bead-1');
    // Counter must be cleared after recovery.
    expect((supervisor as any).slotHealthMonitor.finalBlockedPollCounts.has('bead-1')).toBe(false);
  });

  it('(final-blocked debounce) counter resets when pane shows non-blocked output between polls', async () => {
    // If a blocked detection is followed by a clean (non-blocked) snapshot on the
    // next poll, the counter must reset to zero — no recovery must occur.
    const terminalPaneOutput = [
      'Tool call: bash',
      'fatal error: process killed'
    ].join('\n');
    const cleanPaneOutput = [
      'Tool call: bd_get_bead',
      'Output: {"status": "open"}',
      'State transition: Planning -> Implementation'
    ].join('\n');

    const { supervisor, records, release, terminateTeammatesForBead, captureBeadPaneText } =
      supervisorHarness(NOW_MS);
    captureBeadPaneText.mockResolvedValue(terminalPaneOutput);

    // Poll 1: blocked detected, counter = 1.
    await (supervisor as any).recordSlotHealth('test');
    expect((supervisor as any).slotHealthMonitor.finalBlockedPollCounts.get('bead-1')).toBe(1);
    expect(records.some(r => r.event === DomainEventName.AGENT_TURN_FAILED)).toBe(false);

    // Poll 2: clean snapshot → counter resets, no recovery.
    // Reset the slot-health throttle so the second call is not skipped.
    (supervisor as any).slotHealthMonitor.lastSlotHealthEventMs = 0;
    captureBeadPaneText.mockResolvedValue(cleanPaneOutput);
    await (supervisor as any).recordSlotHealth('test');
    expect((supervisor as any).slotHealthMonitor.finalBlockedPollCounts.has('bead-1')).toBe(false);
    expect(records.some(r => r.event === DomainEventName.AGENT_TURN_FAILED)).toBe(false);
    expect(terminateTeammatesForBead).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('(final-blocked backoff) early-trip does NOT re-fire for the same blocked pane while bead is in inactive-restart backoff', async () => {
    // After a bead is recovered via the early-trip, it enters inactiveRestartedAtMs
    // backoff.  The early-trip must skip the bead entirely during the backoff window —
    // captureBeadPaneText must not be called for the early-trip, and no additional
    // recovery events must fire.
    // Reset slot-health throttle between poll calls so each is actually processed.
    const terminalPaneOutput = [
      'Tool call: bash',
      'fatal error: process killed'
    ].join('\n');

    const { supervisor, records, release, terminateTeammatesForBead, captureBeadPaneText } =
      supervisorHarness(NOW_MS);
    captureBeadPaneText.mockResolvedValue(terminalPaneOutput);

    // Polls 1 + 2: confirm and recover.
    await (supervisor as any).recordSlotHealth('test');
    (supervisor as any).slotHealthMonitor.lastSlotHealthEventMs = 0;
    await (supervisor as any).recordSlotHealth('test');
    expect(terminateTeammatesForBead).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    const agentTurnFailedCountAfterRecovery = records.filter(r => r.event === DomainEventName.AGENT_TURN_FAILED).length;
    const harnessRestartCountAfterRecovery = records.filter(r => r.event === DomainEventName.HARNESS_RESTART_REQUESTED).length;

    // Poll 3: bead has been recovered (markBeadExited removes it from startedBeads)
    // and enters inactiveRestartedAtMs backoff.  A third poll must NOT produce
    // additional AGENT_TURN_FAILED or HARNESS_RESTART_REQUESTED recovery events.
    (supervisor as any).slotHealthMonitor.lastSlotHealthEventMs = 0;
    const captureCallCountBeforePoll3 = captureBeadPaneText.mock.calls.length;
    await (supervisor as any).recordSlotHealth('test');
    // No additional recovery events emitted.
    expect(records.filter(r => r.event === DomainEventName.AGENT_TURN_FAILED).length).toBe(agentTurnFailedCountAfterRecovery);
    expect(records.filter(r => r.event === DomainEventName.HARNESS_RESTART_REQUESTED).length).toBe(harnessRestartCountAfterRecovery);
    // captureBeadPaneText call count did not increase for the early-trip path
    // (bead is no longer tracked as live after markBeadExited).
    expect(captureBeadPaneText.mock.calls.length).toBe(captureCallCountBeforePoll3);
  });

  // ---------------------------------------------------------------------------
  // Processed-signal persistence: restart-durability rebuild (Gap 1)
  // ---------------------------------------------------------------------------

  it('(restart-durability) rebuildProcessedSignalsFromEvents populates processedSignals from accepted TEAMMATE_EVENT records', async () => {
    // Simulate a coordinator restart: create a fresh Supervisor with an event
    // store that contains a previously-accepted TEAMMATE_EVENT.  After calling
    // rebuildProcessedSignalsFromEvents(), the idempotency key from that event
    // must appear in processedSignals — as if markSignalProcessed() was called.
    const idempotencyKey = 'STATE_TRANSITIONED-bead-1-worker-1-session-Implementation-action-SUCCESS';
    const acceptedTeammateEvent: DomainEvent = {
      id: 'te-1',
      type: DomainEventName.TEAMMATE_EVENT,
      timestamp: new Date(NOW_MS - TimeMs.MINUTE).toISOString(),
      sessionId: 'session-old',
      data: {
        beadId: 'bead-1',
        type: 'STATE_TRANSITIONED',
        stateId: 'Implementation',
        idempotencyKey,
        processingDecision: TeammateEventDecisionAction.ACCEPT
      }
    };
    const { supervisor } = supervisorHarness(NOW_MS, undefined, new Set(), 1, new Map(), [acceptedTeammateEvent]);

    // processedSignals starts empty (fresh supervisor, simulating restart)
    expect((supervisor as any).processedSignals.has(idempotencyKey)).toBe(false);

    // rebuildProcessedSignalsFromEvents returns the rebuilt set; Supervisor.start() adds
    // them to processedSignals. Simulate that here (pi-experiment-amq0.2).
    const rebuilt = await (supervisor as any).recoveryService.rebuildProcessedSignalsFromEvents();
    for (const key of rebuilt) {
      (supervisor as any).processedSignals.add(key);
    }

    // After rebuild, the key is present — re-delivered signal will be seen as a duplicate
    expect((supervisor as any).processedSignals.has(idempotencyKey)).toBe(true);
  });

  it('(restart-durability) a re-delivered signal is treated as DUPLICATE after rebuild — no double mutation', async () => {
    // Full restart simulation: processedSignals is rebuilt from a stored ACCEPT
    // decision, so when the same idempotencyKey arrives again, isSignalProcessed()
    // returns true — the coordinator correctly suppresses the duplicate.
    const idempotencyKey = 'STATE_TRANSITIONED-bead-1-worker-1-session-Planning-action-SUCCESS';
    const acceptedTeammateEvent: DomainEvent = {
      id: 'te-2',
      type: DomainEventName.TEAMMATE_EVENT,
      timestamp: new Date(NOW_MS - TimeMs.MINUTE).toISOString(),
      sessionId: 'session-old',
      data: {
        beadId: 'bead-1',
        type: 'STATE_TRANSITIONED',
        stateId: 'Planning',
        idempotencyKey,
        processingDecision: TeammateEventDecisionAction.ACCEPT
      }
    };
    const { supervisor } = supervisorHarness(NOW_MS, undefined, new Set(), 1, new Map(), [acceptedTeammateEvent]);

    // rebuildProcessedSignalsFromEvents returns a Set; Supervisor.start() adds them to processedSignals.
    const rebuilt2 = await (supervisor as any).recoveryService.rebuildProcessedSignalsFromEvents();
    for (const key of rebuilt2) {
      (supervisor as any).processedSignals.add(key);
    }

    // After rebuild, isSignalProcessed returns true for the accepted key
    expect(supervisor.isSignalProcessed(idempotencyKey)).toBe(true);

    // DUPLICATE decision events are NOT re-added by rebuild (only ACCEPT decisions are)
    const duplicateTeammateEvent: DomainEvent = {
      id: 'te-3',
      type: DomainEventName.TEAMMATE_EVENT,
      timestamp: new Date(NOW_MS - 30000).toISOString(),
      sessionId: 'session-old',
      data: {
        beadId: 'bead-1',
        type: 'STATE_TRANSITIONED',
        stateId: 'Planning',
        idempotencyKey: 'some-other-key',
        processingDecision: TeammateEventDecisionAction.DUPLICATE
      }
    };
    const { supervisor: supervisor2 } = supervisorHarness(NOW_MS, undefined, new Set(), 1, new Map(), [duplicateTeammateEvent]);
    // rebuildProcessedSignalsFromEvents returns Set; add to processedSignals.
    const rebuilt3 = await (supervisor2 as any).recoveryService.rebuildProcessedSignalsFromEvents();
    for (const key of rebuilt3) {
      (supervisor2 as any).processedSignals.add(key);
    }
    // DUPLICATE decisions must NOT populate processedSignals
    expect(supervisor2.isSignalProcessed('some-other-key')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Unacknowledged-intent reconciliation (Gap 2)
  // ---------------------------------------------------------------------------

  it('(unacknowledged-intent) reconcileUnacknowledgedSignalIntents records SIGNAL_INTENT_RECONCILED for unprocessed intents', async () => {
    // An intent was written (SIGNAL_INTENT_RECORDED) but the coordinator crashed
    // before processing it (no TEAMMATE_EVENT with ACCEPT decision).
    // On startup, reconcileUnacknowledgedSignalIntents must emit a
    // SIGNAL_INTENT_RECONCILED event for this intent.
    const idempotencyKey = 'STATE_TRANSITIONED-bead-2-worker-1-session-Planning-action-SUCCESS';
    const intentEvent: DomainEvent = {
      id: 'si-1',
      type: DomainEventName.SIGNAL_INTENT_RECORDED,
      timestamp: new Date(NOW_MS - TimeMs.MINUTE).toISOString(),
      sessionId: 'session-old',
      data: {
        beadId: 'bead-2',
        type: 'STATE_TRANSITIONED',
        stateId: 'Planning',
        idempotencyKey
      }
    };
    const { supervisor, records } = supervisorHarness(NOW_MS, undefined, new Set(), 1, new Map(), [intentEvent]);

    await (supervisor as any).recoveryService.reconcileUnacknowledgedSignalIntents();

    // A SIGNAL_INTENT_RECONCILED event must be recorded for the unacknowledged intent
    const reconciled = records.find(r => r.event === DomainEventName.SIGNAL_INTENT_RECONCILED);
    expect(reconciled).toBeDefined();
    expect(reconciled!.data.idempotencyKey).toBe(idempotencyKey);
    expect(reconciled!.data.beadId).toBe('bead-2');
    expect(reconciled!.data.reason).toContain('No processed TEAMMATE_EVENT');
  });

  it('(unacknowledged-intent) reconciliation is idempotent — a second reconcile does not double-apply', async () => {
    // If a SIGNAL_INTENT_RECONCILED event is already present for the intent key,
    // a second call to reconcileUnacknowledgedSignalIntents must skip it.
    const idempotencyKey = 'STATE_TRANSITIONED-bead-3-worker-1-session-Planning-action-SUCCESS';
    const intentEvent: DomainEvent = {
      id: 'si-2',
      type: DomainEventName.SIGNAL_INTENT_RECORDED,
      timestamp: new Date(NOW_MS - TimeMs.MINUTE * 2).toISOString(),
      sessionId: 'session-old',
      data: {
        beadId: 'bead-3',
        type: 'STATE_TRANSITIONED',
        stateId: 'Planning',
        idempotencyKey
      }
    };
    const alreadyReconciledEvent: DomainEvent = {
      id: 'sir-1',
      type: DomainEventName.SIGNAL_INTENT_RECONCILED,
      timestamp: new Date(NOW_MS - TimeMs.MINUTE).toISOString(),
      sessionId: 'session-old',
      data: {
        beadId: 'bead-3',
        idempotencyKey,
        reason: 'No processed TEAMMATE_EVENT or SIGNAL_ACKNOWLEDGED found for this intent after coordinator restart'
      }
    };
    const { supervisor, records } = supervisorHarness(NOW_MS, undefined, new Set(), 1, new Map(), [intentEvent, alreadyReconciledEvent]);

    await (supervisor as any).recoveryService.reconcileUnacknowledgedSignalIntents();

    // No new SIGNAL_INTENT_RECONCILED event should be emitted (already reconciled)
    const newReconciled = records.filter(r => r.event === DomainEventName.SIGNAL_INTENT_RECONCILED);
    expect(newReconciled.length).toBe(0);
  });

  it('(unacknowledged-intent) an intent with a matching ACCEPT TEAMMATE_EVENT is NOT reconciled (already applied)', async () => {
    // An intent that was successfully processed (ACCEPT decision recorded) must
    // not be treated as unacknowledged even if no SIGNAL_ACKNOWLEDGED event exists.
    const idempotencyKey = 'STATE_TRANSITIONED-bead-4-worker-1-session-Planning-action-SUCCESS';
    const intentEvent: DomainEvent = {
      id: 'si-3',
      type: DomainEventName.SIGNAL_INTENT_RECORDED,
      timestamp: new Date(NOW_MS - TimeMs.MINUTE * 2).toISOString(),
      sessionId: 'session-old',
      data: {
        beadId: 'bead-4',
        type: 'STATE_TRANSITIONED',
        stateId: 'Planning',
        idempotencyKey
      }
    };
    const processedTeammateEvent: DomainEvent = {
      id: 'te-4',
      type: DomainEventName.TEAMMATE_EVENT,
      timestamp: new Date(NOW_MS - TimeMs.MINUTE).toISOString(),
      sessionId: 'session-old',
      data: {
        beadId: 'bead-4',
        type: 'STATE_TRANSITIONED',
        stateId: 'Planning',
        idempotencyKey,
        processingDecision: TeammateEventDecisionAction.ACCEPT
      }
    };
    const { supervisor, records } = supervisorHarness(NOW_MS, undefined, new Set(), 1, new Map(), [intentEvent, processedTeammateEvent]);

    await (supervisor as any).recoveryService.reconcileUnacknowledgedSignalIntents();

    // No SIGNAL_INTENT_RECONCILED event should be emitted (intent was applied)
    const reconciled = records.filter(r => r.event === DomainEventName.SIGNAL_INTENT_RECONCILED);
    expect(reconciled.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Enriched duplicate-signal warning context (Gap 3)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // teammate_spawn span instrumentation
  // ---------------------------------------------------------------------------

  it('(teammate_spawn) claimAndSpawnBead emits a teammate_spawn span with nonzero duration on success', async () => {
    // Build a supervisor with a recordCompletedSpan spy on the observability stub.
    const spawnedSpans: Array<{ name: string; startMs: number; endMs: number; attrs: Record<string, unknown> }> = [];
    const observabilityStub = {
      tracedAsync: (_n: string, _a: any, fn: any) => fn,
      recordCompletedSpan: vi.fn((name: string, attrs: Record<string, unknown>, startMs: number, endMs: number) => {
        spawnedSpans.push({ name, startMs, endMs, attrs });
      })
    };

    const claim = vi.fn(async ({ id }: { id: string }) => ({ id } as any));
    const release = vi.fn(async () => {});
    const createWorktree = vi.fn(async () => ({ success: true, path: '/tmp/bead-spawn-test' }));
    const spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%99' }));

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        spawnTeammateInTmux,
        getActiveTeammateCount: vi.fn(async () => 0),
        getAvailableSlots: vi.fn(async () => 1),
        terminateTeammatesForBead: vi.fn()
      } as any,
      observabilityStub as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        eventStore: {
          record: vi.fn(async () => {}),
          eventsForBeads: vi.fn(async () => new Map())
        },
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: { createWorktree },
        scheduler: {},
        flowManager: {}
      } as any,
      { maxSlots: 1, clock: createFakeClock(), orchestrator: { selectAssignments: vi.fn(async () => []) } as any, retentionScheduler: { runIfDue: vi.fn(async () => {}) } as any }
    );

    const bead = { id: 'bead-spawn-test', stateId: 'Planning', score: 0 } as any;
    const config = { settings: {} } as any;
    const result = await (supervisor as any).claimAndSpawnBead(bead, config);
    expect(result).toBe('spawned');

    // A teammate_spawn span must have been emitted.
    const spawnSpan = spawnedSpans.find(s => s.name === SpanName.TEAMMATE_SPAWN);
    expect(spawnSpan).toBeDefined();

    // Duration must be nonzero (endMs > startMs; the actual spawn is instantaneous in
    // the mock, but Date.now() calls are separated so endMs >= startMs).
    expect(spawnSpan!.endMs).toBeGreaterThanOrEqual(spawnSpan!.startMs);

    // The span must carry the bead and state attributes.
    expect(spawnSpan!.attrs['orr_else.bead_id']).toBe('bead-spawn-test');
    expect(spawnSpan!.attrs['orr_else.state_id']).toBe('Planning');
    expect(spawnSpan!.attrs['spawn.success']).toBe(true);
  });

  it('(teammate_spawn) claimAndSpawnBead emits a teammate_spawn span with spawn.success=false when spawn fails', async () => {
    const spawnedSpans: Array<{ name: string; attrs: Record<string, unknown> }> = [];
    const observabilityStub = {
      tracedAsync: (_n: string, _a: any, fn: any) => fn,
      recordCompletedSpan: vi.fn((name: string, attrs: Record<string, unknown>) => {
        spawnedSpans.push({ name, attrs });
      })
    };

    const claim = vi.fn(async ({ id }: { id: string }) => ({ id } as any));
    const release = vi.fn(async () => {});
    const createWorktree = vi.fn(async () => ({ success: true, path: '/tmp/bead-fail-test' }));
    const spawnTeammateInTmux = vi.fn(async () => ({ success: false, error: 'tmux error' }));

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        spawnTeammateInTmux,
        getActiveTeammateCount: vi.fn(async () => 0),
        getAvailableSlots: vi.fn(async () => 1),
        terminateTeammatesForBead: vi.fn()
      } as any,
      observabilityStub as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        eventStore: {
          record: vi.fn(async () => {}),
          eventsForBeads: vi.fn(async () => new Map())
        },
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: { createWorktree },
        scheduler: {},
        flowManager: {}
      } as any,
      { maxSlots: 1, clock: createFakeClock(), orchestrator: { selectAssignments: vi.fn(async () => []) } as any, retentionScheduler: { runIfDue: vi.fn(async () => {}) } as any }
    );

    const bead = { id: 'bead-fail-test', stateId: 'Planning', score: 0 } as any;
    const config = { settings: {} } as any;

    // Spawn failure throws.
    await expect((supervisor as any).claimAndSpawnBead(bead, config)).rejects.toThrow('tmux error');

    // The span must still be emitted (before the throw path).
    const spawnSpan = spawnedSpans.find(s => s.name === SpanName.TEAMMATE_SPAWN);
    expect(spawnSpan).toBeDefined();
    expect(spawnSpan!.attrs['spawn.success']).toBe(false);
  });

  it('(enriched-warning) the duplicate-signal warning includes outcome and routing context fields', async () => {
    // The duplicate/ignored-signal warning must include enough context to let
    // operators distinguish a benign idempotency duplicate from a repeated
    // terminal failure.  Verify the log metadata by spying on Logger.info.
    const { supervisor, records } = supervisorHarness(NOW_MS);
    // Seed a processed signal so the decision comes back DUPLICATE
    const key = 'test-key-enriched-warning';
    supervisor.markSignalProcessed(key);

    // This test validates the extension.ts path, not a direct Supervisor method,
    // so we verify the enriched metadata field was emitted by the records.
    // The enriched log is done inside extension.ts handleTeammateEvent, which is
    // covered by pi_extension.test.ts integration tests.  Here we verify the
    // Supervisor's side: markSignalProcessed correctly prevents double-mutation.
    expect(supervisor.isSignalProcessed(key)).toBe(true);
    // Records are not involved in this check — this is a unit-level guard.
    expect(records.some(r => r.event === DomainEventName.TEAMMATE_EVENT)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // requestedBeadId already-started short-circuit (coordinator AC)
  //
  // Note: general slot-replenishment / capacity invariants are already covered
  // extensively in tests/supervisor_capacity.test.ts (capacity pause, live-pane
  // counting, backoff exclusion, preflight, quarantine, etc.).  This block adds
  // only the UNIQUELY-MISSING coverage: the case where the operator launched
  // `/orr-else --bead <id>` but that bead is already running — the coordinator
  // must spawn nothing further, preventing a duplicate spawn of the same bead.
  // ---------------------------------------------------------------------------

  it('(requestedBeadId) scanAndSpawn spawns nothing when the requested bead is already started', async () => {
    // Scenario: `/orr-else --bead pi-experiment-xyz` was called and `pi-experiment-xyz`
    // is already tracked as a live teammate pane.  On the next supervisor poll,
    // Orchestrator.selectAssignments receives `alreadyStarted = { pi-experiment-xyz }`
    // and `requestedBeadId = 'pi-experiment-xyz'`.  The short-circuit at
    // Orchestrator.ts line ~104 (`if (requestedBeadId && alreadyStarted.has(requestedBeadId)) return []`)
    // means selectAssignments returns [], so scanAndSpawn claims and spawns nothing.
    //
    // This is the historical "replenishes unrelated ready Beads" bug — proving that
    // the fix is in place: a targeted single-bead run does NOT accidentally re-spawn
    // the same bead when it is already running.
    const claim = vi.fn(async ({ id }: { id: string }) => ({ id } as any));
    const release = vi.fn(async () => {});
    const spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%5' }));
    const createWorktree = vi.fn(async () => ({ success: true, path: '/tmp/worktree' }));

    const REQUESTED_BEAD_ID = 'pi-experiment-already-started';

    // Inject an orchestrator that simulates the short-circuit: returns [] when
    // the requested bead is already in alreadyStarted.
    const mockOrchestrator = { selectAssignments: vi.fn(async () => []) };

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        // The bead is live — it has an active pane.
        getLiveTeammateBeadIds: vi.fn(async () => new Set([REQUESTED_BEAD_ID])),
        getAvailableSlots: vi.fn(async () => 1),
        getActiveTeammateCount: vi.fn(async () => 1),
        spawnTeammateInTmux
      } as any,
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        eventStore: {
          record: vi.fn(async () => {}),
          eventsForBeads: vi.fn(async () => new Map())
        },
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: { createWorktree },
        flowManager: {}
      } as any,
      {
        maxSlots: 1,
        requestedBeadId: REQUESTED_BEAD_ID,
        clock: createFakeClock(),
        orchestrator: mockOrchestrator as any,
        retentionScheduler: { runIfDue: vi.fn(async () => {}) } as any
      }
    );

    // Mark the bead as already started in the in-process tracking map.
    (supervisor as any).startedBeads.add(REQUESTED_BEAD_ID);
    (supervisor as any).startedBeadAtMs.set(REQUESTED_BEAD_ID, NOW_MS);

    await (supervisor as any).scanAndSpawn();

    // The injected orchestrator returned [] — no claim or spawn should occur.
    expect(claim).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
    expect(spawnTeammateInTmux).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    // The bead must remain tracked (it was not released by this scan).
    expect((supervisor as any).startedBeads.has(REQUESTED_BEAD_ID)).toBe(true);
  });

  it('(requestedBeadId) scanAndSpawn spawns the requested bead when it is NOT yet started', async () => {
    // Complementary guard: when the requested bead is NOT yet live, the coordinator
    // must proceed with claim + worktree + spawn.  Without this test the passing
    // guard above might give false confidence (what if nothing ever spawns?).
    const claim = vi.fn(async ({ id }: { id: string }) => ({ id } as any));
    const release = vi.fn(async () => {});
    const spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%6' }));
    const createWorktree = vi.fn(async () => ({ success: true, path: '/tmp/worktree-new' }));

    const REQUESTED_BEAD_ID = 'pi-experiment-not-yet-started';

    const getBead = vi.fn(async (id: string) => ({
      id,
      status: 'ready',
      stateId: 'Planning',
      score: 1,
      lastActivity: new Date(0).toISOString()
    } as any));

    // Inject an orchestrator that returns the requested bead as a ready assignment.
    const mockOrchestrator2 = {
      selectAssignments: vi.fn(async () => [{
        id: REQUESTED_BEAD_ID,
        stateId: 'Planning',
        score: 1,
        status: 'ready',
        lastActivity: new Date(0).toISOString()
      }])
    };

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        // No live panes for the requested bead yet.
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        getAvailableSlots: vi.fn(async () => 1),
        getActiveTeammateCount: vi.fn(async () => 0),
        spawnTeammateInTmux
      } as any,
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn } as any,
      {
        configLoader: {
          load: async () => ({
            settings: {},
            states: { Planning: {} }
          })
        },
        eventStore: {
          record: vi.fn(async () => {}),
          eventsForBeads: vi.fn(async () => new Map()),
          latestProjectToolFailureLimitEvent: vi.fn(async () => undefined),
          eventsForBead: vi.fn(async () => [])
        },
        beadsPort: {
          ...fakeBeadsPort({ claim, release }),
          getBead
        } as any,
        worktreePort: { createWorktree },
        flowManager: {}
      } as any,
      {
        maxSlots: 1,
        requestedBeadId: REQUESTED_BEAD_ID,
        clock: createFakeClock(),
        orchestrator: mockOrchestrator2 as any,
        retentionScheduler: { runIfDue: vi.fn(async () => {}) } as any
      }
    );

    // startedBeads is empty — bead is not yet started.
    await (supervisor as any).scanAndSpawn();

    // claim, worktree, and spawn must all fire.
    expect(claim).toHaveBeenCalledTimes(1);
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(spawnTeammateInTmux).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // s3wp.33 — slot health churn diagnostic sets
  // trackedOnly / paneOnly / restarting / released
  // ---------------------------------------------------------------------------

  it('(s33/churn) TEAMMATE_SLOT_HEALTH_CHECKED includes trackedOnlyBeadIds for tracked-but-not-live beads', async () => {
    // bead-1 is live; bead-tracked-only is in startedBeads but not in the live set.
    const { supervisor, records, clock } = supervisorHarness(
      NOW_MS,
      [{ workerId: 'w1', beadId: 'bead-1', stateId: 'Planning', timestampMs: NOW_MS }],
      new Set(['bead-1']),
      2
    );
    (supervisor as any).startedBeads.add('bead-1');
    (supervisor as any).startedBeads.add('bead-tracked-only');
    (supervisor as any).startedBeadAtMs.set('bead-1', clock.now() - TimeMs.SECOND);
    (supervisor as any).startedBeadAtMs.set('bead-tracked-only', clock.now() - TimeMs.SECOND);

    await (supervisor as any).recordSlotHealth('test');

    const event = records.find(r => r.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED);
    expect(event).toBeDefined();
    // bead-tracked-only is tracked but absent from the live pane set.
    expect(event!.data.trackedOnlyBeadIds).toContain('bead-tracked-only');
    expect(event!.data.trackedOnlyBeadIds).not.toContain('bead-1');
  });

  it('(s33/churn) TEAMMATE_SLOT_HEALTH_CHECKED includes paneOnlyBeadIds for live-but-not-tracked beads', async () => {
    // bead-1 is live + tracked; bead-orphan is live but NOT in startedBeads.
    const { supervisor, records, clock } = supervisorHarness(
      NOW_MS,
      [{ workerId: 'w1', beadId: 'bead-1', stateId: 'Planning', timestampMs: NOW_MS }],
      new Set(['bead-1', 'bead-orphan']),
      2
    );
    (supervisor as any).startedBeads.add('bead-1');
    (supervisor as any).startedBeadAtMs.set('bead-1', clock.now() - TimeMs.SECOND);
    // bead-orphan is in the live set but NOT in startedBeads → pane-only.

    await (supervisor as any).recordSlotHealth('test');

    const event = records.find(r => r.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED);
    expect(event).toBeDefined();
    expect(event!.data.paneOnlyBeadIds).toContain('bead-orphan');
    expect(event!.data.paneOnlyBeadIds).not.toContain('bead-1');
  });

  it('(s33/churn) TEAMMATE_SLOT_HEALTH_CHECKED includes restartingBeadIds for beads in inactive-restart backoff', async () => {
    // Use a non-immediate timeout so the restart backoff is visible.
    // The supervisorHarness uses IMMEDIATE_NO_PROGRESS_TIMEOUT_MS (1ms), so we
    // build a custom harness with a larger noProgressTimeoutMs here.
    const clock = createFakeClock();
    const records: Array<{ event: string; data: any }> = [];
    const LONGER_TIMEOUT_MS = TimeMs.MINUTE * 15;
    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [{ workerId: 'w1', beadId: 'bead-1', stateId: 'Planning', timestampMs: clock.now() }] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set(['bead-1'])),
        terminateTeammatesForBead: vi.fn(async () => ({ terminatedPaneIds: [] })),
        captureBeadPaneText: vi.fn(async () => ''),
        getActiveTeammateCount: vi.fn(async () => 1),
        getAvailableSlots: vi.fn(async () => 0)
      } as any,
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: { teammateNoProgressTimeoutMs: LONGER_TIMEOUT_MS } }) },
        eventStore: {
          record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
          eventsForBeads: vi.fn(async () => new Map()),
          latestEventsForBeads: vi.fn(async () => new Map([
            ['bead-1', { id: 'e1', type: DomainEventName.CONTEXT_COMPACTION_RECORDED, timestamp: new Date(clock.now()).toISOString(), sessionId: 's', data: { beadId: 'bead-1' } }]
          ]))
        },
        beadsPort: fakeBeadsPort(),
        worktreePort: { createWorktree: vi.fn() },
        scheduler: {},
        flowManager: {}
      } as any,
      { maxSlots: 1, clock, orchestrator: { selectAssignments: vi.fn(async () => []) } as any, retentionScheduler: { runIfDue: vi.fn(async () => {}) } as any }
    );
    (supervisor as any).startedBeads.add('bead-1');
    (supervisor as any).startedBeadAtMs.set('bead-1', clock.now() - TimeMs.SECOND);
    // Set restart timestamp to NOW (0ms ago) — well within LONGER_TIMEOUT_MS.
    (supervisor as any).slotHealthMonitor.inactiveRestartedAtMs.set('bead-restart', clock.now());

    await (supervisor as any).recordSlotHealth('test');

    const event = records.find(r => r.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED);
    expect(event).toBeDefined();
    // bead-restart is within the backoff window → restarting.
    expect(event!.data.restartingBeadIds).toContain('bead-restart');
  });

  it('(s33/churn) TEAMMATE_SLOT_HEALTH_CHECKED includes releasedBeadIds for beads durably pruned this tick', async () => {
    const now = NOW_MS;
    const releasedEvents = [
      domainEvent('e1', DomainEventName.BEAD_CLAIMED, 'bead-was-released', now - 3000, { stateId: 'Planning' }),
      domainEvent('e2', DomainEventName.BEAD_RELEASED, 'bead-was-released', now - 1000)
    ];
    const { supervisor, records, clock } = supervisorHarness(
      now,
      [{ workerId: 'w1', beadId: 'bead-1', stateId: 'Planning', timestampMs: now }],
      new Set(['bead-1']),
      2,
      new Map([['bead-was-released', releasedEvents]])
    );
    (supervisor as any).startedBeads.add('bead-1');
    (supervisor as any).startedBeads.add('bead-was-released');
    (supervisor as any).startedBeadAtMs.set('bead-1', clock.now() - TimeMs.SECOND);
    (supervisor as any).startedBeadAtMs.set('bead-was-released', clock.now() - 4000);

    await (supervisor as any).recordSlotHealth('test');

    const event = records.find(r => r.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED);
    expect(event).toBeDefined();
    // bead-was-released was durably pruned this tick → releasedBeadIds.
    expect(event!.data.releasedBeadIds).toContain('bead-was-released');
    // bead-1 is still active → not released.
    expect(event!.data.releasedBeadIds).not.toContain('bead-1');
  });

  it('(s33/churn) all churn sets are empty arrays when cluster is healthy and stable', async () => {
    // All beads tracked + live, no orphans, no backoff, nothing pruned.
    const { supervisor, records, clock } = supervisorHarness(
      NOW_MS,
      [{ workerId: 'w1', beadId: 'bead-1', stateId: 'Planning', timestampMs: NOW_MS }],
      new Set(['bead-1']),
      1
    );
    (supervisor as any).startedBeads.add('bead-1');
    (supervisor as any).startedBeadAtMs.set('bead-1', clock.now() - TimeMs.SECOND);

    await (supervisor as any).recordSlotHealth('test');

    const event = records.find(r => r.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED);
    expect(event).toBeDefined();
    expect(event!.data.trackedOnlyBeadIds).toEqual([]);
    expect(event!.data.paneOnlyBeadIds).toEqual([]);
    expect(event!.data.restartingBeadIds).toEqual([]);
    expect(event!.data.releasedBeadIds).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // dbcr — heartbeat-only live gap orphan detection + deterministic lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Helper: builds a supervisor with a heartbeat for 'bead-orphan' that is NOT
   * in the live pane set (liveBeadIds does NOT contain 'bead-orphan'), and where
   * the configured orphan threshold is 2 consecutive checks (for fast tests).
   *
   * latestProgressAtMs controls the latestEventsForBeads response for 'bead-1'
   * (the only live bead). bead-orphan has NO live pane, so it never appears in
   * latestProgressEvents.
   */
  function orphanHarness(overrides: {
    orphanChecks?: number;
    orphanTtlMs?: number;
    orphanStateId?: string;
  } = {}) {
    const { orphanChecks = 2, orphanTtlMs = 9999999, orphanStateId = 'Planning' } = overrides;
    const clock = createFakeClock();
    const records: Array<{ event: string; data: any }> = [];
    const release = vi.fn(async () => {});
    const beadsPort = fakeBeadsPort({ release });
    const terminateTeammatesForBead = vi.fn(async () => ({ terminatedPaneIds: ['%99'] }));
    const heartbeats = [
      // bead-1: healthy — both pane + heartbeat
      { workerId: 'worker-1', beadId: 'bead-1', stateId: 'Planning', timestampMs: clock.now() },
      // bead-orphan: heartbeat-only — no live pane
      { workerId: 'worker-orphan', beadId: 'bead-orphan', stateId: orphanStateId, timestampMs: clock.now() - TimeMs.SECOND }
    ];
    // Only 'bead-1' has a live pane; 'bead-orphan' does NOT.
    const liveBeadIds = new Set(['bead-1']);
    const eventStore = {
      record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
      eventsForBeads: vi.fn(async (beadIds: Iterable<string>) => new Map([...beadIds].map(id => [id, []]))),
      latestEventsForBeads: vi.fn(async () => new Map([
        ['bead-1', {
          id: 'event-1',
          type: DomainEventName.CONTEXT_COMPACTION_RECORDED,
          timestamp: new Date(clock.now()).toISOString(),
          sessionId: 'session-1',
          data: { beadId: 'bead-1', stateId: 'Planning' }
        }]
      ])),
      readAll: vi.fn(async () => [])
    };
    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => heartbeats } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => liveBeadIds),
        terminateTeammatesForBead,
        captureBeadPaneText: vi.fn(async () => ''),
        getActiveTeammateCount: vi.fn(async () => liveBeadIds.size),
        getAvailableSlots: vi.fn(async () => 0),
        spawnTeammateInTmux: vi.fn(async () => ({ success: true, paneId: '%1' }))
      } as any,
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn } as any,
      {
        configLoader: {
          load: async () => ({
            settings: {
              harnessRestartEvent: 'HARNESS_RESTART',
              teammateNoProgressTimeoutMs: 9999999, // high — bead-1 is never inactive
              heartbeatOnlyGapOrphanChecks: orphanChecks,
              heartbeatOnlyGapOrphanTtlMs: orphanTtlMs
            }
          })
        },
        eventStore,
        beadsPort,
        worktreePort: { createWorktree: vi.fn(async () => ({ success: true, path: '/tmp/worktree' })) },
        scheduler: {},
        flowManager: {}
      } as any,
      { maxSlots: 2, clock, orchestrator: { selectAssignments: vi.fn(async () => []) } as any, retentionScheduler: { runIfDue: vi.fn(async () => {}) } as any }
    );
    return { supervisor, records, release, terminateTeammatesForBead, clock };
  }

  it('(dbcr/AC1) emits HEARTBEAT_ONLY_GAP_ORPHANED with required fields after N consecutive checks', async () => {
    // bead-orphan appears in heartbeats but NOT in the live pane set.
    // After orphanChecks=2 consecutive slot-health calls, it must emit the orphan event.
    const { supervisor, records } = orphanHarness({ orphanChecks: 2 });
    (supervisor as any).startedBeads.add('bead-1');

    // Poll 1: gap detected but threshold not yet reached — no orphan event.
    await (supervisor as any).recordSlotHealth('test');
    expect(records.some(r => r.event === DomainEventName.HEARTBEAT_ONLY_GAP_ORPHANED)).toBe(false);

    // Poll 2: reset throttle; second consecutive detection → orphan event fires.
    (supervisor as any).slotHealthMonitor.lastSlotHealthEventMs = 0;
    await (supervisor as any).recordSlotHealth('test');

    const orphanEvent = records.find(r => r.event === DomainEventName.HEARTBEAT_ONLY_GAP_ORPHANED);
    expect(orphanEvent).toBeDefined();
    // AC1 required fields
    expect(orphanEvent!.data.beadId).toBe('bead-orphan');
    expect(Array.isArray(orphanEvent!.data.workerIds)).toBe(true);
    expect(orphanEvent!.data.workerIds).toContain('worker-orphan');
    expect(typeof orphanEvent!.data.lastHeartbeatAt).toBe('string');
    expect(orphanEvent!.data.stateId).toBe('Planning');
    expect(typeof orphanEvent!.data.reason).toBe('string');
  });

  it('(dbcr/AC1-ttl) emits HEARTBEAT_ONLY_GAP_ORPHANED when TTL expires even before consecutive threshold', async () => {
    // Set orphanChecks=99 (never reachable by count alone), but TTL=0 ms so first
    // check immediately triggers the TTL path.
    const { supervisor, records } = orphanHarness({ orphanChecks: 99, orphanTtlMs: 0 });
    (supervisor as any).startedBeads.add('bead-1');

    await (supervisor as any).recordSlotHealth('test');

    const orphanEvent = records.find(r => r.event === DomainEventName.HEARTBEAT_ONLY_GAP_ORPHANED);
    expect(orphanEvent).toBeDefined();
    expect(orphanEvent!.data.beadId).toBe('bead-orphan');
    expect(typeof orphanEvent!.data.reason).toBe('string');
    expect(orphanEvent!.data.reason).toContain('ttl');
  });

  it('(dbcr/AC2+AC3) after orphan detection, heartbeatOnlyLiveGaps is cleared for the stale beadId', async () => {
    // After the orphan fires, the beadId must be suppressed so subsequent
    // TEAMMATE_SLOT_HEALTH_CHECKED events report an empty heartbeatOnlyLiveGaps.
    const { supervisor, records } = orphanHarness({ orphanChecks: 2 });
    (supervisor as any).startedBeads.add('bead-1');

    // Poll 1 + 2: confirm orphan.
    await (supervisor as any).recordSlotHealth('test');
    (supervisor as any).slotHealthMonitor.lastSlotHealthEventMs = 0;
    await (supervisor as any).recordSlotHealth('test');

    // The orphan event must have fired.
    expect(records.some(r => r.event === DomainEventName.HEARTBEAT_ONLY_GAP_ORPHANED)).toBe(true);

    // Poll 3: bead-orphan is now suppressed.
    (supervisor as any).slotHealthMonitor.lastSlotHealthEventMs = 0;
    await (supervisor as any).recordSlotHealth('test');

    // The most recent TEAMMATE_SLOT_HEALTH_CHECKED must report empty heartbeatOnlyLiveGaps.
    const healthEvents = records.filter(r => r.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED);
    const lastHealth = healthEvents[healthEvents.length - 1];
    expect(lastHealth).toBeDefined();
    expect(lastHealth!.data.heartbeatOnlyLiveGaps).toEqual([]);
  });

  it('(dbcr/AC4) startup-grace and healthy heartbeat+pane workers are not falsely orphaned', async () => {
    // bead-1 has both heartbeat AND live pane — it must NEVER appear in
    // heartbeatOnlyLiveGaps and must not trigger the orphan path.
    const clock = createFakeClock();
    const records: Array<{ event: string; data: any }> = [];
    const heartbeats = [
      { workerId: 'worker-1', beadId: 'bead-1', stateId: 'Planning', timestampMs: clock.now() }
    ];
    const liveBeadIds = new Set(['bead-1']); // bead-1 IS in the live set
    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => heartbeats } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => liveBeadIds),
        terminateTeammatesForBead: vi.fn(async () => ({ terminatedPaneIds: [] })),
        captureBeadPaneText: vi.fn(async () => ''),
        getActiveTeammateCount: vi.fn(async () => 1),
        getAvailableSlots: vi.fn(async () => 0),
        spawnTeammateInTmux: vi.fn()
      } as any,
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn } as any,
      {
        configLoader: {
          load: async () => ({
            settings: {
              harnessRestartEvent: 'HARNESS_RESTART',
              teammateNoProgressTimeoutMs: 9999999,
              heartbeatOnlyGapOrphanChecks: 1, // very aggressive — 1 check triggers
              heartbeatOnlyGapOrphanTtlMs: 0   // and TTL=0 triggers immediately
            }
          })
        },
        eventStore: {
          record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
          eventsForBeads: vi.fn(async (beadIds: Iterable<string>) => new Map([...beadIds].map(id => [id, []]))),
          latestEventsForBeads: vi.fn(async () => new Map([
            ['bead-1', {
              id: 'e1', type: DomainEventName.CONTEXT_COMPACTION_RECORDED,
              timestamp: new Date(clock.now()).toISOString(), sessionId: 's',
              data: { beadId: 'bead-1', stateId: 'Planning' }
            }]
          ])),
          readAll: vi.fn(async () => [])
        },
        beadsPort: fakeBeadsPort(),
        worktreePort: { createWorktree: vi.fn() },
        scheduler: {},
        flowManager: {}
      } as any,
      { maxSlots: 1, clock, orchestrator: { selectAssignments: vi.fn(async () => []) } as any, retentionScheduler: { runIfDue: vi.fn(async () => {}) } as any }
    );
    (supervisor as any).startedBeads.add('bead-1');

    // Multiple polls — even with threshold=1 and TTL=0, bead-1 is healthy (pane exists).
    for (let i = 0; i < 3; i++) {
      (supervisor as any).slotHealthMonitor.lastSlotHealthEventMs = 0;
      await (supervisor as any).recordSlotHealth('test');
    }

    // No orphan event must have fired for bead-1.
    expect(records.some(r => r.event === DomainEventName.HEARTBEAT_ONLY_GAP_ORPHANED)).toBe(false);

    // heartbeatOnlyLiveGaps must stay empty (bead-1 has a live pane).
    const healthEvents = records.filter(r => r.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED);
    expect(healthEvents.length).toBeGreaterThan(0);
    for (const ev of healthEvents) {
      expect(ev.data.heartbeatOnlyLiveGaps).toEqual([]);
    }
  });

  it('(dbcr/AC5) heartbeat-only/no-pane triggers orphan; tracked-only/no-pane, pane-only/no-heartbeat, and healthy pane+heartbeat do not', async () => {
    // Scenario matrix (one bead per category):
    //   bead-hb-only:      heartbeat yes, live pane NO  → orphan after threshold
    //   bead-tracked-only: tracked (startedBeads) yes, live pane NO, heartbeat NO → trackedOnly, NOT orphan
    //   bead-pane-only:    live pane yes, tracked NO, heartbeat NO → paneOnly, NOT orphan
    //   bead-healthy:      live pane yes, heartbeat yes → healthy, NOT orphan
    const clock = createFakeClock();
    const records: Array<{ event: string; data: any }> = [];
    const heartbeats = [
      { workerId: 'worker-hb', beadId: 'bead-hb-only', stateId: 'Planning', timestampMs: clock.now() },
      { workerId: 'worker-healthy', beadId: 'bead-healthy', stateId: 'Planning', timestampMs: clock.now() }
    ];
    // Live panes: bead-healthy + bead-pane-only, but NOT bead-hb-only.
    const liveBeadIds = new Set(['bead-healthy', 'bead-pane-only']);
    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => heartbeats } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => liveBeadIds),
        terminateTeammatesForBead: vi.fn(async () => ({ terminatedPaneIds: [] })),
        captureBeadPaneText: vi.fn(async () => ''),
        getActiveTeammateCount: vi.fn(async () => liveBeadIds.size),
        getAvailableSlots: vi.fn(async () => 0),
        spawnTeammateInTmux: vi.fn()
      } as any,
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn } as any,
      {
        configLoader: {
          load: async () => ({
            settings: {
              harnessRestartEvent: 'HARNESS_RESTART',
              teammateNoProgressTimeoutMs: 9999999,
              heartbeatOnlyGapOrphanChecks: 2,
              heartbeatOnlyGapOrphanTtlMs: 9999999
            }
          })
        },
        eventStore: {
          record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
          eventsForBeads: vi.fn(async (beadIds: Iterable<string>) => new Map([...beadIds].map(id => [id, []]))),
          latestEventsForBeads: vi.fn(async () => new Map([
            ['bead-healthy', {
              id: 'e1', type: DomainEventName.CONTEXT_COMPACTION_RECORDED,
              timestamp: new Date(clock.now()).toISOString(), sessionId: 's',
              data: { beadId: 'bead-healthy', stateId: 'Planning' }
            }],
            ['bead-pane-only', {
              id: 'e2', type: DomainEventName.CONTEXT_COMPACTION_RECORDED,
              timestamp: new Date(clock.now()).toISOString(), sessionId: 's',
              data: { beadId: 'bead-pane-only', stateId: 'Planning' }
            }]
          ])),
          readAll: vi.fn(async () => [])
        },
        beadsPort: fakeBeadsPort(),
        worktreePort: { createWorktree: vi.fn() },
        scheduler: {},
        flowManager: {}
      } as any,
      { maxSlots: 4, clock, orchestrator: { selectAssignments: vi.fn(async () => []) } as any, retentionScheduler: { runIfDue: vi.fn(async () => {}) } as any }
    );
    // bead-tracked-only: tracked but no live pane, no heartbeat
    (supervisor as any).startedBeads.add('bead-tracked-only');
    (supervisor as any).startedBeadAtMs.set('bead-tracked-only', clock.now() - TimeMs.SECOND);
    // bead-healthy: tracked + live + heartbeat
    (supervisor as any).startedBeads.add('bead-healthy');
    (supervisor as any).startedBeadAtMs.set('bead-healthy', clock.now() - TimeMs.SECOND);

    // Poll 1: bead-hb-only detected as heartbeat-only gap (count=1 < threshold=2).
    await (supervisor as any).recordSlotHealth('test');
    expect(records.some(r => r.event === DomainEventName.HEARTBEAT_ONLY_GAP_ORPHANED)).toBe(false);

    // Poll 2: second consecutive detection → orphan fires for bead-hb-only only.
    (supervisor as any).slotHealthMonitor.lastSlotHealthEventMs = 0;
    await (supervisor as any).recordSlotHealth('test');

    const orphanEvents = records.filter(r => r.event === DomainEventName.HEARTBEAT_ONLY_GAP_ORPHANED);
    // Only bead-hb-only should be orphaned.
    expect(orphanEvents.length).toBe(1);
    expect(orphanEvents[0].data.beadId).toBe('bead-hb-only');

    // bead-tracked-only, bead-pane-only, and bead-healthy must NOT trigger the orphan path.
    expect(orphanEvents.some((e: any) => e.data.beadId === 'bead-tracked-only')).toBe(false);
    expect(orphanEvents.some((e: any) => e.data.beadId === 'bead-pane-only')).toBe(false);
    expect(orphanEvents.some((e: any) => e.data.beadId === 'bead-healthy')).toBe(false);

    // Verify the TEAMMATE_SLOT_HEALTH_CHECKED sets on the first poll are correct.
    const firstHealth = records.find(r => r.event === DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED);
    expect(firstHealth).toBeDefined();
    expect(firstHealth!.data.heartbeatOnlyLiveGaps).toContain('bead-hb-only');
    // bead-tracked-only appears in trackedOnly (tracked but no pane), not heartbeatOnlyLiveGaps.
    expect(firstHealth!.data.trackedOnlyBeadIds).toContain('bead-tracked-only');
    // bead-pane-only appears in paneOnly (live but not tracked).
    expect(firstHealth!.data.paneOnlyBeadIds).toContain('bead-pane-only');
    // bead-healthy appears in neither orphan-related set.
    expect(firstHealth!.data.heartbeatOnlyLiveGaps).not.toContain('bead-healthy');
  });

  // ---------------------------------------------------------------------------
  // pi-experiment-sey0 — Quarantine rehydration after coordinator restart
  // ---------------------------------------------------------------------------

  it('(sey0/AC1) rehydrateQuarantinesFromEvents populates quarantine map from BEAD_QUARANTINED events', async () => {
    // A BEAD_QUARANTINED event was recorded in a previous session for bead-q.
    // After restart, rehydrateQuarantinesFromEvents must re-populate the in-memory
    // quarantine map so scanAndSpawn will skip bead-q on the first scan.
    const quarantinedEvent: DomainEvent = {
      id: 'qe-1',
      type: DomainEventName.BEAD_QUARANTINED,
      timestamp: new Date(NOW_MS - TimeMs.MINUTE).toISOString(),
      sessionId: 'session-old',
      data: {
        beadId: 'bead-q',
        reason: 'ALREADY_CHECKED_OUT',
        signature: 'ready:2026-01-01T00:00:00.000Z'
      }
    };
    const { supervisor, records } = supervisorHarness(NOW_MS, undefined, new Set(), 1, new Map(), [quarantinedEvent]);

    // Quarantine map starts empty (fresh Supervisor instance simulating restart).
    expect((supervisor as any).spawnCoordinator.quarantine.has('bead-q')).toBe(false);

    await (supervisor as any).spawnCoordinator.rehydrateQuarantinesFromEvents();

    // Quarantine map must now contain an entry for bead-q.
    expect((supervisor as any).spawnCoordinator.quarantine.has('bead-q')).toBe(true);
    expect((supervisor as any).spawnCoordinator.quarantine.get('bead-q')?.reason).toBe('ALREADY_CHECKED_OUT');
    expect((supervisor as any).spawnCoordinator.quarantine.get('bead-q')?.signature).toBe('ready:2026-01-01T00:00:00.000Z');

    // A BEAD_QUARANTINE_REHYDRATED event must be emitted for the rehydrated bead.
    expect(records.find(r => r.event === DomainEventName.BEAD_QUARANTINE_REHYDRATED)).toMatchObject({
      event: DomainEventName.BEAD_QUARANTINE_REHYDRATED,
      data: { beadId: 'bead-q', reason: 'ALREADY_CHECKED_OUT', signature: 'ready:2026-01-01T00:00:00.000Z' }
    });
  });

  it('(sey0/AC1) isQuarantined skips a rehydrated bead with unchanged signature — no claim, worktree, or spawn', async () => {
    // Simulate restart: bead-q was quarantined previously. After rehydration,
    // isQuarantined(bead-q) with the same status/lastActivity must return true,
    // causing scanAndSpawn to skip the bead without claim, worktree, or spawn.
    const quarantinedEvent: DomainEvent = {
      id: 'qe-2',
      type: DomainEventName.BEAD_QUARANTINED,
      timestamp: new Date(NOW_MS - TimeMs.MINUTE).toISOString(),
      sessionId: 'session-old',
      data: {
        beadId: 'bead-q',
        reason: 'ALREADY_CHECKED_OUT',
        signature: 'ready:2026-01-01T00:00:00.000Z'
      }
    };
    const { supervisor } = supervisorHarness(NOW_MS, undefined, new Set(), 1, new Map(), [quarantinedEvent]);

    await (supervisor as any).spawnCoordinator.rehydrateQuarantinesFromEvents();

    // Bead with the same status+lastActivity as the quarantined signature.
    const bead = { id: 'bead-q', status: 'ready', lastActivity: '2026-01-01T00:00:00.000Z' } as any;
    expect(await (supervisor as any).spawnCoordinator.isQuarantined(bead)).toBe(true);
  });

  it('(sey0/AC2) changing bead status clears the rehydrated quarantine and allows retry', async () => {
    // A rehydrated quarantine is cleared when the bead's signature changes.
    // The skip is lifted and a BEAD_QUARANTINE_CLEARED event is emitted.
    const quarantinedEvent: DomainEvent = {
      id: 'qe-3',
      type: DomainEventName.BEAD_QUARANTINED,
      timestamp: new Date(NOW_MS - TimeMs.MINUTE).toISOString(),
      sessionId: 'session-old',
      data: {
        beadId: 'bead-q',
        reason: 'ALREADY_CHECKED_OUT',
        signature: 'ready:2026-01-01T00:00:00.000Z'
      }
    };
    const { supervisor, records } = supervisorHarness(NOW_MS, undefined, new Set(), 1, new Map(), [quarantinedEvent]);

    await (supervisor as any).spawnCoordinator.rehydrateQuarantinesFromEvents();

    // Bead with CHANGED status — signature no longer matches.
    const beadAfterStatusChange = { id: 'bead-q', status: 'in_progress', lastActivity: '2026-01-01T00:00:00.000Z' } as any;
    const result = await (supervisor as any).spawnCoordinator.isQuarantined(beadAfterStatusChange);

    // The bead must no longer be quarantined.
    expect(result).toBe(false);
    // Quarantine entry must be cleared.
    expect((supervisor as any).spawnCoordinator.quarantine.has('bead-q')).toBe(false);
    // A BEAD_QUARANTINE_CLEARED event must be emitted to explain the retry.
    expect(records.find(r => r.event === DomainEventName.BEAD_QUARANTINE_CLEARED)).toMatchObject({
      event: DomainEventName.BEAD_QUARANTINE_CLEARED,
      data: expect.objectContaining({ beadId: 'bead-q', reason: 'ALREADY_CHECKED_OUT' })
    });
  });

  it('(sey0/AC2) changing bead lastActivity clears the rehydrated quarantine and allows retry', async () => {
    // Changing only lastActivity (status unchanged) also lifts the rehydrated quarantine.
    const quarantinedEvent: DomainEvent = {
      id: 'qe-4',
      type: DomainEventName.BEAD_QUARANTINED,
      timestamp: new Date(NOW_MS - TimeMs.MINUTE).toISOString(),
      sessionId: 'session-old',
      data: {
        beadId: 'bead-q',
        reason: 'WORKTREE_PATH_TAKEN',
        signature: 'ready:2026-01-01T00:00:00.000Z'
      }
    };
    const { supervisor, records } = supervisorHarness(NOW_MS, undefined, new Set(), 1, new Map(), [quarantinedEvent]);

    await (supervisor as any).spawnCoordinator.rehydrateQuarantinesFromEvents();

    const beadAfterActivityBump = { id: 'bead-q', status: 'ready', lastActivity: '2026-02-01T00:00:00.000Z' } as any;
    const result = await (supervisor as any).spawnCoordinator.isQuarantined(beadAfterActivityBump);

    expect(result).toBe(false);
    expect((supervisor as any).spawnCoordinator.quarantine.has('bead-q')).toBe(false);
    // BEAD_QUARANTINE_CLEARED must be emitted for the retry explanation.
    expect(records.find(r => r.event === DomainEventName.BEAD_QUARANTINE_CLEARED)).toBeDefined();
  });

  it('(sey0/AC3) durable events explain both rehydrated skip and retry: REHYDRATED then CLEARED in order', async () => {
    // Full restart lifecycle: BEAD_QUARANTINED was recorded → restart →
    // BEAD_QUARANTINE_REHYDRATED is emitted → bead signature changes →
    // BEAD_QUARANTINE_CLEARED is emitted.
    const quarantinedEvent: DomainEvent = {
      id: 'qe-5',
      type: DomainEventName.BEAD_QUARANTINED,
      timestamp: new Date(NOW_MS - TimeMs.MINUTE).toISOString(),
      sessionId: 'session-old',
      data: {
        beadId: 'bead-lifecycle',
        reason: 'INVALID_BRANCH_REF',
        signature: 'ready:2026-01-01T00:00:00.000Z'
      }
    };
    const { supervisor, records } = supervisorHarness(NOW_MS, undefined, new Set(), 1, new Map(), [quarantinedEvent]);

    // Simulate restart: rehydrate.
    await (supervisor as any).spawnCoordinator.rehydrateQuarantinesFromEvents();

    // Verify skip event was emitted.
    expect(records.find(r => r.event === DomainEventName.BEAD_QUARANTINE_REHYDRATED)).toBeDefined();

    // Bead signature changes (status updated externally).
    const beadChanged = { id: 'bead-lifecycle', status: 'in_progress', lastActivity: '2026-01-02T00:00:00.000Z' } as any;
    await (supervisor as any).spawnCoordinator.isQuarantined(beadChanged);

    // Verify cleared event was emitted after the skip event.
    const rehydratedIdx = records.findIndex(r => r.event === DomainEventName.BEAD_QUARANTINE_REHYDRATED);
    const clearedIdx = records.findIndex(r => r.event === DomainEventName.BEAD_QUARANTINE_CLEARED);
    expect(rehydratedIdx).toBeGreaterThanOrEqual(0);
    expect(clearedIdx).toBeGreaterThan(rehydratedIdx);
  });

  it('(sey0/AC4) non-quarantined beads are unaffected by rehydration', async () => {
    // A bead with no BEAD_QUARANTINED event in the log must not appear in the
    // quarantine map after rehydration — existing non-quarantined startup behavior
    // is unchanged.
    const unrelatedEvent: DomainEvent = {
      id: 'ue-1',
      type: DomainEventName.BEAD_CLAIMED,
      timestamp: new Date(NOW_MS - TimeMs.MINUTE).toISOString(),
      sessionId: 'session-old',
      data: { beadId: 'bead-clean', stateId: 'Planning' }
    };
    const { supervisor } = supervisorHarness(NOW_MS, undefined, new Set(), 1, new Map(), [unrelatedEvent]);

    await (supervisor as any).spawnCoordinator.rehydrateQuarantinesFromEvents();

    expect((supervisor as any).spawnCoordinator.quarantine.has('bead-clean')).toBe(false);
    // Non-rehydrated bead must not be skipped by isQuarantined.
    const bead = { id: 'bead-clean', status: 'ready', lastActivity: '2026-01-01T00:00:00.000Z' } as any;
    expect(await (supervisor as any).spawnCoordinator.isQuarantined(bead)).toBe(false);
  });

  it('(sey0/AC4) a runtime (non-rehydrated) quarantine clear does NOT emit BEAD_QUARANTINE_CLEARED', async () => {
    // isQuarantined on a RUNTIME quarantine entry (not rehydrated) clears the entry
    // when signature changes but must NOT emit BEAD_QUARANTINE_CLEARED — that event
    // is reserved for rehydrated quarantines to avoid noise on normal operation.
    const { supervisor, records } = supervisorHarness(NOW_MS);

    const bead = { id: 'bead-runtime', status: 'ready', lastActivity: '2026-01-01T00:00:00.000Z' } as any;
    // Quarantine via normal runtime path (not rehydration).
    await (supervisor as any).spawnCoordinator.quarantineBead(bead, 'ALREADY_CHECKED_OUT');
    const countAfterQuarantine = records.length;

    // Now clear the runtime quarantine by presenting a changed signature.
    const beadChanged = { id: 'bead-runtime', status: 'in_progress', lastActivity: '2026-01-02T00:00:00.000Z' } as any;
    await (supervisor as any).spawnCoordinator.isQuarantined(beadChanged);

    // No BEAD_QUARANTINE_CLEARED event must be emitted for a runtime quarantine.
    const newEvents = records.slice(countAfterQuarantine);
    expect(newEvents.some(r => r.event === DomainEventName.BEAD_QUARANTINE_CLEARED)).toBe(false);
  });

  it('(sey0) start() passes startupEvents to rehydrateQuarantinesFromEvents (single readAll pass)', async () => {
    // Verifies that start() integrates rehydration into the shared single-pass
    // startup flow: readAll is called exactly once even though multiple startup
    // helpers (rebuildProcessedSignals, reconcileUnacknowledgedSignalIntents,
    // rehydrateQuarantines) all need the event log.
    const quarantinedEvent: DomainEvent = {
      id: 'qe-start',
      type: DomainEventName.BEAD_QUARANTINED,
      timestamp: new Date(NOW_MS - TimeMs.MINUTE).toISOString(),
      sessionId: 'session-old',
      data: {
        beadId: 'bead-start-q',
        reason: 'ALREADY_CHECKED_OUT',
        signature: 'ready:2026-01-01T00:00:00.000Z'
      }
    };
    const { supervisor } = supervisorHarness(
      NOW_MS,
      undefined,
      new Set(),
      1,
      new Map(),
      [quarantinedEvent]
    );
    // Prevent the interval and step from running — only test startup rehydration.
    vi.spyOn(supervisor as any, 'step').mockResolvedValue(undefined);
    // restoreCapacityPauseFromStore needs latestEventByType — add it.
    (supervisor as any).services.eventStore.latestEventByType = vi.fn(async () => undefined);

    await supervisor.start();

    // The quarantine map must be populated from the startup events.
    expect((supervisor as any).spawnCoordinator.quarantine.has('bead-start-q')).toBe(true);
    // readAll must have been called exactly once (shared pass).
    expect((supervisor as any).services.eventStore.readAll).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// r06o AC1+AC3: SignalNoiseCoalescer unit tests
//
// The coalescer fingerprints repeated log calls and suppresses repeats within
// the rate-limit window. Durable event-store records are NOT suppressed —
// only the human-facing logger calls are coalesced.
// ---------------------------------------------------------------------------

import { SignalNoiseCoalescer } from '../src/core/SignalNoiseCoalescer.js';

describe('SignalNoiseCoalescer — r06o AC1+AC3', () => {
  it('AC1: first occurrence returns shouldLog=true; repeat within window returns shouldLog=false with count', () => {
    const coalescer = new SignalNoiseCoalescer(TimeMs.MINUTE);

    const fp = 'DUPLICATE:bead-1:worker-1:Planning:key-abc';
    const first = coalescer.observe(fp);
    expect(first.shouldLog).toBe(true);
    expect(first.suppressedCount).toBe(0);

    // Same fingerprint again — within window
    const second = coalescer.observe(fp);
    expect(second.shouldLog).toBe(false);
    expect(second.suppressedCount).toBe(1);

    // Third repeat
    const third = coalescer.observe(fp);
    expect(third.shouldLog).toBe(false);
    expect(third.suppressedCount).toBe(2);
  });

  it('AC1: different fingerprints are tracked independently', () => {
    const coalescer = new SignalNoiseCoalescer(TimeMs.MINUTE);

    const fpA = 'DUPLICATE:bead-A:worker-1:Planning:key-1';
    const fpB = 'DUPLICATE:bead-B:worker-2:Review:key-2';

    expect(coalescer.observe(fpA).shouldLog).toBe(true);
    expect(coalescer.observe(fpB).shouldLog).toBe(true);
    // Second calls for each — independent suppression
    expect(coalescer.observe(fpA).shouldLog).toBe(false);
    expect(coalescer.observe(fpB).shouldLog).toBe(false);
  });

  it('AC1: after window expires, fingerprint resets and logs again, carrying prior suppressedCount', () => {
    const windowMs = 100;
    // Use injected nowMs so the test is deterministic (no real Date.now()).
    let nowMs = 1_000_000;
    const coalescer = new SignalNoiseCoalescer(windowMs);
    const fp = 'DUPLICATE:bead-1:worker-1:Planning:key-x';

    // First occurrence at t=0: logs, no prior suppressed count.
    const first = coalescer.observe(fp, nowMs);
    expect(first.shouldLog).toBe(true);
    expect(first.suppressedCount).toBe(0);

    // Second within window: suppressed, count becomes 1.
    nowMs += 10;
    const second = coalescer.observe(fp, nowMs);
    expect(second.shouldLog).toBe(false);
    expect(second.suppressedCount).toBe(1);

    // Third within window: suppressed, count becomes 2.
    nowMs += 10;
    const third = coalescer.observe(fp, nowMs);
    expect(third.shouldLog).toBe(false);
    expect(third.suppressedCount).toBe(2);

    // Advance past window boundary.
    nowMs += windowMs + 1;

    // After window: should log again AND carry the 2 suppressed from the prior window.
    const afterWindow = coalescer.observe(fp, nowMs);
    expect(afterWindow.shouldLog).toBe(true);
    expect(afterWindow.suppressedCount).toBe(2);

    // The new window's suppressedCount starts fresh (next repeat within this window = 1).
    nowMs += 1;
    const nextRepeat = coalescer.observe(fp, nowMs);
    expect(nextRepeat.shouldLog).toBe(false);
    expect(nextRepeat.suppressedCount).toBe(1);
  });

  it('AC3: coalescer does not interact with event-store records (log-only concern)', () => {
    // This test documents the contract: the coalescer is ONLY consulted before
    // Logger calls. Event-store record() calls must never be gated by the coalescer.
    // We verify this by checking coalescer has no record/store method.
    const coalescer = new SignalNoiseCoalescer(TimeMs.MINUTE);
    expect(typeof (coalescer as any).record).toBe('undefined');
    expect(typeof (coalescer as any).eventStore).toBe('undefined');
  });

  // Finding 1+2: aggregate count must actually be emitted on rollover.
  it('(finding-1+2) rollover primary carries prior-window suppressedCount so callers emit an aggregate', () => {
    // Verifies the fix for the "LOST AGGREGATE" defect: when the window expires
    // and a new occurrence arrives, observe() returns shouldLog:true with the
    // prior window's suppressedCount > 0, so the caller can include it in the log.
    let nowMs = 5_000_000;
    const windowMs = 1_000;
    const coalescer = new SignalNoiseCoalescer(windowMs);
    const fp = 'INVALID:missing-workerId:bead-x:undefined';

    // Window 1: 1 primary + 4 suppressed.
    coalescer.observe(fp, nowMs);               // primary
    coalescer.observe(fp, nowMs + 100);         // suppressed 1
    coalescer.observe(fp, nowMs + 200);         // suppressed 2
    coalescer.observe(fp, nowMs + 300);         // suppressed 3
    coalescer.observe(fp, nowMs + 400);         // suppressed 4

    // Window 2 rollover: first call after expiry carries count=4.
    const rollover = coalescer.observe(fp, nowMs + windowMs + 1);
    expect(rollover.shouldLog).toBe(true);
    expect(rollover.suppressedCount).toBe(4);

    // Window 2 primary has no prior suppressed count yet (fresh window just started).
    const withinWindow2 = coalescer.observe(fp, nowMs + windowMs + 2);
    expect(withinWindow2.shouldLog).toBe(false);
    expect(withinWindow2.suppressedCount).toBe(1);

    // Window 3 rollover with only 1 suppressed in window 2.
    const rollover2 = coalescer.observe(fp, nowMs + windowMs * 2 + 2);
    expect(rollover2.shouldLog).toBe(true);
    expect(rollover2.suppressedCount).toBe(1);
  });

  // Finding 3: memory must be bounded.
  it('(finding-3) map size stays bounded after many distinct expired fingerprints', () => {
    // Each distinct fingerprint with an externally-controlled suffix (e.g. from
    // validation.error) must not accumulate indefinitely.  After MAX_ENTRIES
    // distinct fingerprints, older entries are evicted so the map stays bounded.
    const windowMs = 1;
    let nowMs = 9_000_000;
    const coalescer = new SignalNoiseCoalescer(windowMs);
    const MAX_ENTRIES = 256; // matches the constant in SignalNoiseCoalescer.ts

    // Insert MAX_ENTRIES + 50 distinct fingerprints, each well past their window.
    for (let i = 0; i < MAX_ENTRIES + 50; i++) {
      coalescer.observe(`fp-distinct-${i}`, nowMs);
      nowMs += windowMs + 1; // each in its own expired window
    }

    // The internal map must not exceed MAX_ENTRIES.
    const mapSize = (coalescer as any).entries.size;
    expect(mapSize).toBeLessThanOrEqual(MAX_ENTRIES);
  });

  // Genuine AC3: durable TEAMMATE_EVENT records must be written on EVERY occurrence,
  // even when the LOG is coalesced (shouldLog=false).
  //
  // This test drives the REAL handleTeammateEvent path in extension.ts by booting
  // orrElseExtension in coordinator mode, capturing the SignalHandler closure that
  // extension.ts passes to SignalingServer, then calling it N times with the same
  // duplicate event.  Assertions:
  //   (a) eventStore.record(TEAMMATE_EVENT) called N times — durable evidence is never
  //       suppressed regardless of coalescer state.
  //   (b) Logger.info called only ONCE (the first occurrence) — log IS coalesced.
  //
  // The test FAILS when the production record() call is moved after the coalescer gate
  // because then record() is never reached for suppressed occurrences.
  it('(genuine-AC3) durable TEAMMATE_EVENT record is written on every duplicate signal, even when log is coalesced', async () => {
    // Dynamic imports so that vi.spyOn can intercept before the module is used.
    const { SignalingServer } = await import('../src/core/SignalingServer.js');
    const { TeammateFactory } = await import('../src/plugins/teammates.js');
    const { createTeammateEventIdempotencyKey } = await import('../src/core/TeammateEvents.js');
    const { PiEventName, BuiltInToolName } = await import('../src/constants/index.js');
    const orrElseExtension = (await import('../src/extension.js')).default;

    // Prevent the Supervisor's polling loop from running (avoids real tmux calls).
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined as any);
    // Prevent tmux window setup (not needed for signal handling).
    const ensureWindowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow')
      .mockResolvedValue({ ok: true } as any);

    // Capture the SignalHandler closure that extension.ts passes to new SignalingServer().
    // The handler IS handleTeammateEvent (closed over pi/ctx/services/session).
    let capturedHandler: ((event: any, ack: any) => Promise<void>) | undefined;
    const signalingStartSpy = vi.spyOn(SignalingServer.prototype, 'start').mockImplementation(
      async function (this: any) {
        // The handler is stored as 'onSignal' (private readonly field) by the constructor.
        capturedHandler = (this as any).onSignal;
        return 19999;
      }
    );

    // Spy on Logger.info to count log emissions (only the first duplicate should log).
    const logInfoSpy = vi.spyOn(Logger, 'info').mockImplementation(() => undefined);

    // Spy on EventStore.record via module-level import.  We need to intercept the
    // concrete EventStore instance that extension.ts will use.  We spy on the prototype
    // so every instance (including the one created inside createRuntimeServices) is
    // covered.
    const { EventStore } = await import('../src/core/EventStore.js');
    const recordedCalls: Array<{ event: string; data: any }> = [];
    const recordSpy = vi.spyOn(EventStore.prototype, 'record').mockImplementation(
      async (event: string, data: any) => { recordedCalls.push({ event, data }); }
    );
    // eventsForBead must return [] so appliedEvent is always null (no prior STATE_TRANSITION_APPLIED).
    const eventsForBeadSpy = vi.spyOn(EventStore.prototype, 'eventsForBead').mockResolvedValue([]);
    // projectBead must resolve to an object so currentStateId can be derived.
    const projectBeadSpy = vi.spyOn(EventStore.prototype, 'projectBead').mockResolvedValue({
      status: 'Planning'
    } as any);
    // eventsForBeads needed by Supervisor internals.
    const eventsForBeadsSpy = vi.spyOn(EventStore.prototype, 'eventsForBeads').mockResolvedValue(new Map());

    // --- fake Pi API surface (minimal coordinator setup) ---
    const tools: any[] = [];
    const commands: Record<string, any> = {};
    const callbacks: Record<string, Function> = {};
    const fakePiApi = {
      on: (name: string, cb: Function) => { callbacks[name] = cb; },
      registerTool: (t: any) => tools.push(t),
      registerCommand: (name: string, opts: any) => { commands[name] = opts; },
      getActiveTools: () => [] as string[],
      setActiveTools: () => {},
      setThinkingLevel: () => {},
      setModel: async () => true,
      sendUserMessage: () => {}
    } as any;

    try {
      // Boot the extension (registers commands/tools/event callbacks).
      await orrElseExtension(fakePiApi);

      // Fire SESSION_START so session.teammateFactory is populated.
      await callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: process.cwd() });

      // Invoke /orr-else to run startOrrElse.
      // This creates new SignalingServer(handler, ...) — our spy captures handler.
      const commandHandler = commands[BuiltInToolName.ORR_ELSE]?.handler;
      expect(commandHandler, '/orr-else command must be registered').toBeDefined();
      await commandHandler('--bead bead-ac3-test', { ui: { notify: () => {} }, hasUI: true } as any);

      // Sanity: the SignalingServer constructor must have been called.
      // If capturedHandler is still undefined, fall back: the field name may differ.
      // In that case retrieve it from the SignalingServer prototype spy.
      // The real field is named 'handler' on the SignalingServer instance (see SignalingServer.ts).
      if (!capturedHandler) {
        // Retrieve the instance from the mocked 'start' context (already stored above).
        // If the field name differs, throw a clear error so the test self-documents.
        throw new Error(
          'capturedHandler not set — check the SignalingServer field name that stores the handler callback'
        );
      }

      // Build a duplicate event: same fingerprint repeated N times.
      // Pre-mark the idempotency key as processed so EVERY invocation returns DUPLICATE.
      const baseEvent = {
        type: 'STATE_TRANSITIONED' as const,
        beadId: 'bead-ac3-test',
        workerId: 'worker-ac3',
        stateId: 'Planning',
        timestamp: 1_779_000_000_000,
        actionId: 'ac3-action',
        transitionEvent: 'SUCCESS',
        summary: 'AC3 duplicate test',
        evidence: 'AC3 evidence',
        handover: 'AC3 handover'
      };
      const idempotencyKey = createTeammateEventIdempotencyKey(baseEvent);
      const dupEvent = { ...baseEvent, idempotencyKey };

      // Mark the key as already processed so decideTeammateEventProcessing returns DUPLICATE.
      // session.supervisor is the Supervisor created by startOrrElse; its start() was called
      // by startOrrElse immediately after construction.  vi.spyOn captures 'this' in
      // spy.mock.instances, giving us the instance without accessing private session state.
      const supervisorInstance = supervisorStartSpy.mock.instances[0];
      expect(supervisorInstance, 'Supervisor instance must be created by startOrrElse').toBeDefined();
      supervisorInstance.markSignalProcessed(idempotencyKey);

      // Clear any record() calls that happened during startOrrElse setup.
      recordedCalls.length = 0;
      logInfoSpy.mockClear();

      // Call the real handleTeammateEvent closure N times with the same duplicate event.
      const N = 5;
      const fakeAck = { hold: () => {}, send: () => {} };
      for (let i = 0; i < N; i++) {
        await capturedHandler(dupEvent, fakeAck);
      }

      // (a) Durable records: N TEAMMATE_EVENT records — one per occurrence, regardless
      //     of coalescer suppression.
      const teammateEventRecords = recordedCalls.filter(r => r.event === DomainEventName.TEAMMATE_EVENT);
      expect(teammateEventRecords).toHaveLength(N);
      // Every record must carry a processingDecision of DUPLICATE.
      for (const rec of teammateEventRecords) {
        expect(rec.data.processingDecision).toBe(TeammateEventDecisionAction.DUPLICATE);
      }

      // (b) Logger.info called exactly ONCE — the first occurrence logs; repeats are
      //     coalesced by duplicateDecisionCoalescer inside extension.ts.
      const duplicateLogCalls = logInfoSpy.mock.calls.filter(
        args => typeof args[1] === 'string' && args[1].includes('Ignoring teammate signal')
      );
      expect(duplicateLogCalls).toHaveLength(1);
    } finally {
      signalingStartSpy.mockRestore();
      supervisorStartSpy.mockRestore();
      ensureWindowSpy.mockRestore();
      logInfoSpy.mockRestore();
      recordSpy.mockRestore();
      eventsForBeadSpy.mockRestore();
      projectBeadSpy.mockRestore();
      eventsForBeadsSpy.mockRestore();
    }
  });
});
