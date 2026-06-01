import { describe, expect, it, vi } from 'vitest';
import { Supervisor } from '../src/core/Supervisor.js';
import { Logger } from '../src/core/Logger.js';
import { BeadStatus, Defaults, DomainEventName, PluginToolName, TimeMs } from '../src/constants/index.js';
import type { Clock } from '../src/core/Clock.js';
import type { DomainEvent } from '../src/core/EventStore.js';

const IMMEDIATE_NO_PROGRESS_TIMEOUT_MS = 1;
const STALE_PROGRESS_AGE_MS = TimeMs.MINUTE;
const NOW_MS = Date.parse('2026-01-02T03:04:05.000Z');

function createFakeClock(nowMs = NOW_MS): Clock {
  return {
    now: () => nowMs,
    date: (timestampMs?: number) => new Date(timestampMs === undefined ? nowMs : timestampMs)
  };
}

function supervisorHarness(
  latestProgressAtMs: number,
  heartbeats?: any[],
  liveBeadIds = new Set(['bead-1']),
  maxSlots = 1,
  eventsByBead = new Map<string, DomainEvent[]>()
) {
  const clock = createFakeClock();
  const effectiveHeartbeats = heartbeats ?? [{
    workerId: 'worker-1',
    beadId: 'bead-1',
    stateId: 'Planning',
    timestampMs: clock.now()
  }];
  const records: Array<{ event: string; data: any }> = [];
  const release = vi.fn(async () => ({ id: 'bead-1' }));
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
    ]))
  };
  const supervisor = new Supervisor(
    {} as any,
    { hasUI: false } as any,
    {
      getHeartbeatSnapshot: () => effectiveHeartbeats
    } as any,
    {
      getLiveTeammateBeadIds: vi.fn(async () => liveBeadIds),
      terminateTeammatesForBead
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
      plugins: {
        bd: {
          tools: [{ name: 'bd_release', execute: release }]
        }
      }
    } as any,
    { maxSlots, clock }
  );
  return { supervisor, records, release, terminateTeammatesForBead, clock };
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
    expect(release).toHaveBeenCalledWith({ id: 'bead-1' });
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
    expect(release).toHaveBeenCalledWith({ id: 'bead-1' });
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
    (supervisor as any).inactiveRestartedAtMs.set('bead-1', clock.now());

    supervisor.markBeadExited('bead-1', { preserveInactiveRestartBackoff: true });

    expect((supervisor as any).startedBeads.has('bead-1')).toBe(false);
    expect((supervisor as any).startedBeadAtMs.has('bead-1')).toBe(false);
    expect((supervisor as any).missingStartedBeadChecks.has('bead-1')).toBe(false);
    expect((supervisor as any).inactiveRestartedAtMs.has('bead-1')).toBe(true);
  });

  it('releaseClaimedAfterPause clears claimed/active state and preserves inactiveRestartedAtMs backoff', async () => {
    const { supervisor, release, clock } = supervisorHarness(NOW_MS);
    const claimedBead = { id: 'bead-1' } as any;

    // Populate all four tracking maps to mirror a normally-started bead
    (supervisor as any).startedBeads.add('bead-1');
    (supervisor as any).startedBeadAtMs.set('bead-1', clock.now());
    (supervisor as any).missingStartedBeadChecks.set('bead-1', 2);
    // inactiveRestartedAtMs holds the backoff timestamp — must survive the release
    (supervisor as any).inactiveRestartedAtMs.set('bead-1', clock.now() - TimeMs.MINUTE);

    // Trigger a pause so releaseClaimedAfterPause is reachable, then call it directly
    await (supervisor as any).releaseClaimedAfterPause(claimedBead);

    // Claimed/active tracking maps must be cleared
    expect((supervisor as any).startedBeads.has('bead-1')).toBe(false);
    expect((supervisor as any).startedBeadAtMs.has('bead-1')).toBe(false);
    expect((supervisor as any).missingStartedBeadChecks.has('bead-1')).toBe(false);
    // Backoff timestamp must NOT be reset — this is the WI-26 invariant
    expect((supervisor as any).inactiveRestartedAtMs.has('bead-1')).toBe(true);
    // The bd_release tool must have been called to drop the lease
    expect(release).toHaveBeenCalledWith({ id: 'bead-1' });
  });

  it('claimAndSpawnBead releases lease when worktree provisioning fails', async () => {
    const claim = vi.fn(async () => ({ id: 'bead-1' }));
    const release = vi.fn(async () => ({}));
    const createWorktree = vi.fn(async () => ({ success: false, error: 'disk full' }));
    const records: Array<{ event: string; data: any }> = [];
    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      { getLiveTeammateBeadIds: vi.fn(async () => new Set()), spawnTeammateInTmux: vi.fn() } as any,
      { tracedAsync: (_n: string, _a: any, fn: any) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        eventStore: {
          record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
          eventsForBeads: vi.fn(async () => new Map())
        },
        plugins: {
          bd: { tools: [
            { name: 'bd_claim', execute: claim },
            { name: 'bd_release', execute: release }
          ]},
          git: { tools: [{ name: 'create_worktree', execute: createWorktree }] }
        }
      } as any,
      { maxSlots: 1, clock: createFakeClock() }
    );

    const bead = { id: 'bead-1', stateId: 'Planning', score: 0 } as any;
    const config = { settings: {} } as any;
    await expect((supervisor as any).claimAndSpawnBead(bead, config)).rejects.toThrow('disk full');
    expect(release).toHaveBeenCalledWith({ id: 'bead-1' });
  });

  it('claimAndSpawnBead releases lease when spawn fails', async () => {
    const claim = vi.fn(async () => ({ id: 'bead-1' }));
    const release = vi.fn(async () => ({}));
    const createWorktree = vi.fn(async () => ({ success: true, path: '/tmp/bead-1' }));
    const spawnTeammateInTmux = vi.fn(async () => ({ success: false, error: 'tmux unavailable' }));
    const records: Array<{ event: string; data: any }> = [];
    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      { getLiveTeammateBeadIds: vi.fn(async () => new Set()), spawnTeammateInTmux } as any,
      { tracedAsync: (_n: string, _a: any, fn: any) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        eventStore: {
          record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
          eventsForBeads: vi.fn(async () => new Map())
        },
        plugins: {
          bd: { tools: [
            { name: 'bd_claim', execute: claim },
            { name: 'bd_release', execute: release }
          ]},
          git: { tools: [{ name: 'create_worktree', execute: createWorktree }] }
        }
      } as any,
      { maxSlots: 1, clock: createFakeClock() }
    );

    const bead = { id: 'bead-1', stateId: 'Planning', score: 0 } as any;
    const config = { settings: {} } as any;
    await expect((supervisor as any).claimAndSpawnBead(bead, config)).rejects.toThrow('tmux unavailable');
    expect(release).toHaveBeenCalledWith({ id: 'bead-1' });
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
    release.mockResolvedValueOnce({ id: 'bead-missing', tombstoned: true });

    await (supervisor as any).reconcileStartedBeads();

    // Release must be called exactly once — no retry loop
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ id: 'bead-missing' });
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
});
