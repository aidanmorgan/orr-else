import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BeadStatus, DomainEventName, TimeMs } from '../src/constants/index.js';
import type { Clock } from '../src/core/Clock.js';
import type { BeadsPort, WorktreePort } from '../src/core/OrchestrationPorts.js';

const orchestratorMock = vi.hoisted(() => ({
  selectAssignments: vi.fn()
}));

vi.mock('../src/core/Orchestrator.js', () => ({
  Orchestrator: vi.fn(function Orchestrator() {
    return {
      selectAssignments: orchestratorMock.selectAssignments
    };
  })
}));

import { Supervisor } from '../src/core/Supervisor.js';

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

function fakeWorktreePort(overrides: Partial<WorktreePort> = {}): WorktreePort {
  return {
    createWorktree: vi.fn(async () => ({ success: true, path: '/tmp/worktree' })),
    ...overrides
  };
}

describe('Supervisor capacity pause handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops the current assignment batch when a capacity pause starts after claim', async () => {
    let supervisor: Supervisor;
    const clock = createFakeClock();
    const records: Array<{ event: string; data: unknown }> = [];
    const claim = vi.fn(async ({ id, stateId }: { id: string; stateId: string }) => {
      supervisor.pauseSchedulingUntil(clock.now() + TimeMs.MINUTE, 'subscription capacity exhausted');
      return { id, status: stateId } as any;
    });
    const release = vi.fn(async () => {});
    const createWorktree = vi.fn(async () => ({ success: true, path: '/tmp/worktree' }));
    const spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%1' }));

    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-1', stateId: 'Planning', score: 2 },
      { id: 'bead-2', stateId: 'Implementation', score: 1 }
    ]);

    supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        getAvailableSlots: vi.fn(async () => 2),
        getActiveTeammateCount: vi.fn(async () => 0),
        spawnTeammateInTmux
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: {
          load: async () => ({ settings: {} })
        },
        flowManager: {},
        scheduler: {},
        eventStore: {
          record: vi.fn(async (event: string, data: unknown) => records.push({ event, data }))
        },
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: fakeWorktreePort({ createWorktree })
      } as any,
      { maxSlots: 2, clock }
    );

    await (supervisor as any).scanAndSpawn();

    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ id: 'bead-1' }), expect.anything());
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('bead-1');
    expect(createWorktree).not.toHaveBeenCalled();
    expect(spawnTeammateInTmux).not.toHaveBeenCalled();
    expect((supervisor as any).startedBeads.has('bead-1')).toBe(false);
    expect(records.some(record => record.event === DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED)).toBe(true);
  });

  it('restores an active capacity pause before scanning the backlog', async () => {
    const clock = createFakeClock();
    const claim = vi.fn(async () => ({ id: 'bead-1', status: 'Planning' } as any));
    const release = vi.fn(async () => {});
    const spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%1' }));
    const pauseUntil = clock.date(clock.now() + TimeMs.MINUTE).toISOString();

    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-1', stateId: 'Planning', score: 1 }
    ]);

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        getAvailableSlots: vi.fn(async () => 1),
        getActiveTeammateCount: vi.fn(async () => 0),
        spawnTeammateInTmux
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: {
          load: async () => ({ settings: {} })
        },
        flowManager: {},
        scheduler: {},
        eventStore: {
          record: vi.fn(async () => undefined),
          latestEventByType: vi.fn(async () => ({
            id: 'capacity-event',
            type: DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED,
            timestamp: clock.date().toISOString(),
            sessionId: 'previous-session',
            data: { pauseUntil, reason: 'subscription capacity exhausted' }
          }))
        },
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: fakeWorktreePort()
      } as any,
      { maxSlots: 1, clock }
    );

    await (supervisor as any).restoreCapacityPauseFromEventStore();
    await (supervisor as any).scanAndSpawn();

    expect(orchestratorMock.selectAssignments).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(spawnTeammateInTmux).not.toHaveBeenCalled();
  });

  it('uses live teammate panes, not stale tracked bead ids, when filling capacity', async () => {
    const clock = createFakeClock();
    const claim = vi.fn(async ({ id, stateId }: { id: string; stateId: string }) => ({ id, status: stateId } as any));
    const release = vi.fn(async () => {});
    const createWorktree = vi.fn(async () => ({ success: true, path: '/tmp/worktree' }));
    const spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%2' }));

    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-restarted', stateId: 'Planning', score: 2 }
    ]);

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set(['bead-live'])),
        getAvailableSlots: vi.fn(async () => 1),
        getActiveTeammateCount: vi.fn(async () => 2),
        spawnTeammateInTmux
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: {
          load: async () => ({ settings: {} })
        },
        flowManager: {},
        scheduler: {},
        eventStore: {
          record: vi.fn(async () => undefined)
        },
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: fakeWorktreePort({ createWorktree })
      } as any,
      { maxSlots: 2, clock }
    );
    (supervisor as any).startedBeads.add('bead-live');
    (supervisor as any).startedBeads.add('bead-stale');

    await (supervisor as any).scanAndSpawn();

    expect(orchestratorMock.selectAssignments).toHaveBeenCalledWith(
      1,
      undefined,
      new Set(['bead-live'])
    );
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ id: 'bead-restarted' }), expect.anything());
    expect(createWorktree).toHaveBeenCalledWith('bead-restarted', expect.anything());
    expect(spawnTeammateInTmux).toHaveBeenCalledWith('bead-restarted', 'Planning', '/tmp/worktree', expect.anything());
    expect(release).not.toHaveBeenCalled();
  });

  it('releases a missing restart-requested worker before scanning so capacity can respawn it', async () => {
    const clock = createFakeClock();
    const records: Array<{ event: string; data: any }> = [];
    let releasedRestart = false;
    let liveBeadIds = new Set(['bead-live']);
    const claim = vi.fn(async ({ id, stateId }: { id: string; stateId: string }) => ({ id, status: stateId } as any));
    const release = vi.fn(async (id: string) => {
      if (id === 'bead-restart') releasedRestart = true;
    });
    const getBead = vi.fn(async (id: string) => ({ id, status: 'Planning' } as any));
    const createWorktree = vi.fn(async () => ({ success: true, path: '/tmp/worktree' }));
    const spawnTeammateInTmux = vi.fn(async (beadId: string) => {
      liveBeadIds = new Set([...liveBeadIds, beadId]);
      return { success: true, paneId: '%2' };
    });

    orchestratorMock.selectAssignments.mockImplementation(async () => releasedRestart
      ? [{ id: 'bead-restart', stateId: 'Planning', score: 4 }]
      : []
    );

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set(liveBeadIds)),
        getAvailableSlots: vi.fn(async () => 1),
        getActiveTeammateCount: vi.fn(async () => liveBeadIds.size),
        spawnTeammateInTmux
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: {
          load: async () => ({ settings: {} })
        },
        flowManager: {},
        scheduler: {},
        eventStore: {
          record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
          projectBead: vi.fn(async (beadId: string) => beadId === 'bead-restart'
            ? {
              id: beadId,
              status: 'Planning',
              restartRequested: true,
              restartKind: 'harness',
              restartEvent: 'HARNESS_RESTART',
              restartFromState: 'Planning',
              restartTargetState: 'Planning'
            }
            : { id: beadId, status: 'Planning', restartRequested: false }),
          latestEventsForBeads: vi.fn(async () => new Map())
        },
        beadsPort: fakeBeadsPort({ claim, release: release as any, getBead }),
        worktreePort: fakeWorktreePort({ createWorktree })
      } as any,
      { maxSlots: 2, clock }
    );
    (supervisor as any).startedBeads.add('bead-live');
    (supervisor as any).startedBeads.add('bead-restart');
    (supervisor as any).startedBeadAtMs.set('bead-live', clock.now());
    (supervisor as any).startedBeadAtMs.set('bead-restart', clock.now() - TimeMs.SECOND);

    await (supervisor as any).step();

    expect(release).toHaveBeenCalledWith('bead-restart');
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(claim.mock.invocationCallOrder[0]);
    expect(orchestratorMock.selectAssignments).toHaveBeenCalledWith(
      1,
      undefined,
      new Set(['bead-live'])
    );
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ id: 'bead-restart' }), expect.anything());
    expect(createWorktree).toHaveBeenCalledWith('bead-restart', expect.anything());
    expect(spawnTeammateInTmux).toHaveBeenCalledWith('bead-restart', 'Planning', '/tmp/worktree', expect.anything());
    expect(records.find(record => record.event === DomainEventName.TEAMMATE_PROCESS_EXITED)?.data).toMatchObject({
      beadId: 'bead-restart',
      reason: 'restart_requested_missing_pane',
      restartKind: 'harness',
      restartEvent: 'HARNESS_RESTART'
    });
    expect((supervisor as any).startedBeads.has('bead-live')).toBe(true);
    expect((supervisor as any).startedBeads.has('bead-restart')).toBe(true);
  });

  it('excludes beads in inactive-restart backoff without consuming open capacity', async () => {
    const clock = createFakeClock();
    orchestratorMock.selectAssignments.mockResolvedValue([]);
    const claim = vi.fn(async () => ({ id: 'bead-cooling', status: 'Planning' } as any));

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        getAvailableSlots: vi.fn(async () => 2),
        getActiveTeammateCount: vi.fn(async () => 0),
        spawnTeammateInTmux: vi.fn(async () => ({ success: true, paneId: '%2' }))
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: {
          load: async () => ({
            settings: {
              teammateNoProgressTimeoutMs: TimeMs.MINUTE
            }
          })
        },
        flowManager: {},
        scheduler: {},
        eventStore: {
          record: vi.fn(async () => undefined)
        },
        beadsPort: fakeBeadsPort({ claim }),
        worktreePort: fakeWorktreePort()
      } as any,
      { maxSlots: 2, clock }
    );
    (supervisor as any).inactiveRestartedAtMs.set('bead-cooling', clock.now());

    await (supervisor as any).scanAndSpawn();

    expect(orchestratorMock.selectAssignments).toHaveBeenCalledWith(
      2,
      undefined,
      new Set(['bead-cooling'])
    );
    expect(claim).not.toHaveBeenCalled();
  });

  it('excludes live teammate panes after a coordinator restart even when startedBeads is empty', async () => {
    const clock = createFakeClock();
    const claim = vi.fn(async () => ({ id: 'bead-live', status: 'Planning' } as any));

    orchestratorMock.selectAssignments.mockResolvedValue([]);

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set(['bead-live'])),
        getAvailableSlots: vi.fn(async () => 1),
        getActiveTeammateCount: vi.fn(async () => 1),
        spawnTeammateInTmux: vi.fn(async () => ({ success: true, paneId: '%2' }))
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: {
          load: async () => ({ settings: {} })
        },
        flowManager: {},
        scheduler: {},
        eventStore: {
          record: vi.fn(async () => undefined)
        },
        beadsPort: fakeBeadsPort({ claim }),
        worktreePort: fakeWorktreePort()
      } as any,
      { maxSlots: 2, clock }
    );

    await (supervisor as any).scanAndSpawn();

    expect(orchestratorMock.selectAssignments).toHaveBeenCalledWith(
      1,
      undefined,
      new Set(['bead-live'])
    );
    expect(claim).not.toHaveBeenCalled();
  });

  it('terminates live teammate panes whose Beads are already terminal', async () => {
    const clock = createFakeClock();
    const getBead = vi.fn(async (id: string) => ({ id, status: BeadStatus.COMPLETED } as any));
    const release = vi.fn(async () => {});
    const terminateTeammatesForBead = vi.fn(async () => ({ terminatedPaneIds: ['%3'] }));

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set(['bead-closed'])),
        getAvailableSlots: vi.fn(async () => 0),
        getActiveTeammateCount: vi.fn(async () => 1),
        terminateTeammatesForBead
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: {
          load: async () => ({ settings: {} })
        },
        flowManager: {},
        scheduler: {},
        eventStore: {
          record: vi.fn(async () => undefined)
        },
        beadsPort: fakeBeadsPort({ getBead, release }),
        worktreePort: fakeWorktreePort()
      } as any,
      { maxSlots: 1, clock }
    );
    (supervisor as any).startedBeads.add('bead-closed');

    await (supervisor as any).reconcileTerminalLiveBeads();

    expect(getBead).toHaveBeenCalledWith('bead-closed');
    expect(terminateTeammatesForBead).toHaveBeenCalledWith(
      'bead-closed',
      expect.stringContaining('terminal Bead status completed')
    );
    expect(release).toHaveBeenCalledWith('bead-closed');
    expect((supervisor as any).startedBeads.has('bead-closed')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Spawn PREFLIGHT + QUARANTINE integration tests
  // ---------------------------------------------------------------------------

  it('preflight: terminal/closed bead is never claimed or spawned', async () => {
    const clock = createFakeClock();
    const claim = vi.fn(async ({ id, stateId }: { id: string; stateId: string }) => ({ id, status: stateId } as any));
    const release = vi.fn(async () => {});
    const createWorktree = vi.fn(async () => ({ success: true, path: '/tmp/worktree' }));
    const spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%1' }));

    // Orchestrator returns a terminal bead as a candidate
    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-terminal', stateId: 'Planning', score: 1, status: 'completed' }
    ]);

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        getAvailableSlots: vi.fn(async () => 1),
        getActiveTeammateCount: vi.fn(async () => 0),
        spawnTeammateInTmux
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        flowManager: {},
        scheduler: {},
        eventStore: { record: vi.fn(async () => undefined) },
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: fakeWorktreePort({ createWorktree })
      } as any,
      { maxSlots: 1, clock }
    );

    await (supervisor as any).scanAndSpawn();

    // Terminal bead must never be claimed or spawned
    expect(claim).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
    expect(spawnTeammateInTmux).not.toHaveBeenCalled();
  });

  it('quarantine: worktree failure quarantines bead with classified reason; not retried on next scan (slot health does not churn)', async () => {
    const clock = createFakeClock();
    const records: Array<{ event: string; data: unknown }> = [];
    const claim = vi.fn(async ({ id }: { id: string }) => ({ id, status: 'ready' } as any));
    const release = vi.fn(async () => {});
    // createWorktree fails with an "already checked out" error on first call;
    // subsequent calls should never happen (bead is quarantined)
    const createWorktree = vi.fn(async () => ({
      success: false,
      error: "fatal: 'bead/pi-experiment-bead-wt' is already checked out at '/some/path'"
    }));
    const spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%1' }));

    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-wt', stateId: 'Planning', score: 1, status: 'ready' }
    ]);

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        getAvailableSlots: vi.fn(async () => 1),
        getActiveTeammateCount: vi.fn(async () => 0),
        spawnTeammateInTmux
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        flowManager: {},
        scheduler: {},
        eventStore: { record: vi.fn(async (event: string, data: unknown) => records.push({ event, data })) },
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: fakeWorktreePort({ createWorktree })
      } as any,
      { maxSlots: 1, clock }
    );

    // SCAN 1: worktree creation fails → bead quarantined
    await (supervisor as any).scanAndSpawn();

    expect(claim).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(spawnTeammateInTmux).not.toHaveBeenCalled();

    // The quarantine entry must exist with the right reason
    expect((supervisor as any).quarantine.has('bead-wt')).toBe(true);
    expect((supervisor as any).quarantine.get('bead-wt').reason).toBe('ALREADY_CHECKED_OUT');

    // A structured BEAD_QUARANTINED event must have been emitted once
    expect(records.filter(r => r.event === DomainEventName.BEAD_QUARANTINED)).toHaveLength(1);

    // SCAN 2: bead signature unchanged → skip entirely; no additional claim/createWorktree
    await (supervisor as any).scanAndSpawn();

    expect(claim).toHaveBeenCalledTimes(1); // not called again
    expect(createWorktree).toHaveBeenCalledTimes(1); // not called again
    expect(spawnTeammateInTmux).not.toHaveBeenCalled();

    // The BEAD_QUARANTINED event is still emitted only once (not spammed each scan)
    expect(records.filter(r => r.event === DomainEventName.BEAD_QUARANTINED)).toHaveLength(1);
  });

  it('quarantine clears and allows re-attempt when bead signature changes (status changed)', async () => {
    const clock = createFakeClock();
    const records: Array<{ event: string; data: unknown }> = [];
    const release = vi.fn(async () => {});
    const createWorktree = vi.fn()
      // First call fails (worktree path taken)
      .mockResolvedValueOnce({ success: false, error: "fatal: already exists" })
      // Second call succeeds after quarantine is cleared
      .mockResolvedValueOnce({ success: true, path: '/tmp/worktree-bead-rq' });
    const spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%1' }));

    // First scan: bead has status='ready', lastActivity='2026-01-01'
    const beadV1 = { id: 'bead-rq', stateId: 'Planning', score: 1, status: 'ready', lastActivity: '2026-01-01T00:00:00.000Z' };
    // Second scan: bead has status='in_progress' AND updated lastActivity (signature changed on both axes)
    const beadV2 = { id: 'bead-rq', stateId: 'Planning', score: 1, status: 'in_progress', lastActivity: '2026-01-02T00:00:00.000Z' };

    orchestratorMock.selectAssignments
      .mockResolvedValueOnce([beadV1])
      .mockResolvedValueOnce([beadV2]);

    const claim = vi.fn(async ({ id }: { id: string }) => ({
      id,
      status: orchestratorMock.selectAssignments.mock.calls.length === 1 ? 'ready' : 'in_progress'
    } as any));

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        getAvailableSlots: vi.fn(async () => 1),
        getActiveTeammateCount: vi.fn(async () => 0),
        spawnTeammateInTmux
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        flowManager: {},
        scheduler: {},
        eventStore: { record: vi.fn(async (event: string, data: unknown) => records.push({ event, data })) },
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: fakeWorktreePort({ createWorktree })
      } as any,
      { maxSlots: 1, clock }
    );

    // SCAN 1: failure → quarantined
    await (supervisor as any).scanAndSpawn();
    expect((supervisor as any).quarantine.has('bead-rq')).toBe(true);
    expect(createWorktree).toHaveBeenCalledTimes(1);

    // SCAN 2: signature changed (beadV2) → quarantine cleared → re-attempted → succeeds
    await (supervisor as any).scanAndSpawn();
    expect((supervisor as any).quarantine.has('bead-rq')).toBe(false);
    expect(createWorktree).toHaveBeenCalledTimes(2);
    expect(spawnTeammateInTmux).toHaveBeenCalledTimes(1);
  });

  it('quarantine clears and allows re-attempt when ONLY lastActivity changes (status unchanged)', async () => {
    // Regression guard for the status-only signature bug:
    // A bead quarantined at status X + lastActivity T1, then re-scanned at the SAME
    // status X but a bumped lastActivity T2, must clear quarantine and be re-attempted.
    // With a status-only signature this test would fail: the bead would remain quarantined
    // because `status` did not change, even though `lastActivity` did.
    const clock = createFakeClock();
    const records: Array<{ event: string; data: unknown }> = [];
    const release = vi.fn(async () => {});
    const createWorktree = vi.fn()
      // First call fails (worktree path taken)
      .mockResolvedValueOnce({ success: false, error: "fatal: already exists" })
      // Second call succeeds after quarantine is cleared by lastActivity bump
      .mockResolvedValueOnce({ success: true, path: '/tmp/worktree-bead-ts' });
    const spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%1' }));

    // Both scans return the SAME status; only lastActivity changes between scans.
    const beadT1 = { id: 'bead-ts', stateId: 'Planning', score: 1, status: 'ready', lastActivity: '2026-01-01T00:00:00.000Z' };
    const beadT2 = { id: 'bead-ts', stateId: 'Planning', score: 1, status: 'ready', lastActivity: '2026-01-02T00:00:00.000Z' };

    orchestratorMock.selectAssignments
      .mockResolvedValueOnce([beadT1])
      .mockResolvedValueOnce([beadT2]);

    const claim = vi.fn(async ({ id }: { id: string }) => ({ id, status: 'ready' } as any));

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        getAvailableSlots: vi.fn(async () => 1),
        getActiveTeammateCount: vi.fn(async () => 0),
        spawnTeammateInTmux
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        flowManager: {},
        scheduler: {},
        eventStore: { record: vi.fn(async (event: string, data: unknown) => records.push({ event, data })) },
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: fakeWorktreePort({ createWorktree })
      } as any,
      { maxSlots: 1, clock }
    );

    // SCAN 1: worktree creation fails → bead quarantined with status='ready':T1 signature
    await (supervisor as any).scanAndSpawn();
    expect((supervisor as any).quarantine.has('bead-ts')).toBe(true);
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(spawnTeammateInTmux).not.toHaveBeenCalled();

    // SCAN 2: status unchanged but lastActivity bumped → signature differs → quarantine
    // CLEARS and createWorktree is called again, this time succeeding.
    await (supervisor as any).scanAndSpawn();
    expect((supervisor as any).quarantine.has('bead-ts')).toBe(false);
    expect(createWorktree).toHaveBeenCalledTimes(2);
    expect(spawnTeammateInTmux).toHaveBeenCalledTimes(1);
  });

  it('quarantine is NOT cleared when both status AND lastActivity are unchanged (no-churn invariant)', async () => {
    // Guard: a quarantined bead whose signature is completely unchanged must remain
    // quarantined — createWorktree must NOT be called a second time.
    const clock = createFakeClock();
    const records: Array<{ event: string; data: unknown }> = [];
    const release = vi.fn(async () => {});
    const createWorktree = vi.fn(async () => ({
      success: false,
      error: "fatal: already exists"
    }));
    const spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%1' }));

    // Both scans return the SAME status AND the same lastActivity.
    const beadUnchanged = { id: 'bead-nc', stateId: 'Planning', score: 1, status: 'ready', lastActivity: '2026-01-01T00:00:00.000Z' };

    orchestratorMock.selectAssignments
      .mockResolvedValueOnce([beadUnchanged])
      .mockResolvedValueOnce([beadUnchanged]);

    const claim = vi.fn(async ({ id }: { id: string }) => ({ id, status: 'ready' } as any));

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        getAvailableSlots: vi.fn(async () => 1),
        getActiveTeammateCount: vi.fn(async () => 0),
        spawnTeammateInTmux
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        flowManager: {},
        scheduler: {},
        eventStore: { record: vi.fn(async (event: string, data: unknown) => records.push({ event, data })) },
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: fakeWorktreePort({ createWorktree })
      } as any,
      { maxSlots: 1, clock }
    );

    // SCAN 1: failure → quarantined
    await (supervisor as any).scanAndSpawn();
    expect((supervisor as any).quarantine.has('bead-nc')).toBe(true);
    expect(createWorktree).toHaveBeenCalledTimes(1);

    // SCAN 2: signature completely unchanged → still quarantined, not retried
    await (supervisor as any).scanAndSpawn();
    expect((supervisor as any).quarantine.has('bead-nc')).toBe(true);
    expect(createWorktree).toHaveBeenCalledTimes(1); // no second attempt
    expect(spawnTeammateInTmux).not.toHaveBeenCalled();

    // BEAD_QUARANTINED event emitted exactly once (no spam per scan)
    expect(records.filter(r => r.event === 'BEAD_QUARANTINED')).toHaveLength(1);
  });

  it('quarantine path: lease is released and slot is not consumed (no leak)', async () => {
    const clock = createFakeClock();
    const release = vi.fn(async () => {});
    const createWorktree = vi.fn(async () => ({ success: false, error: 'not a valid object name refs/heads/bead/bad' }));
    const spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%1' }));

    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-leak', stateId: 'Planning', score: 1, status: 'ready' }
    ]);

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        getAvailableSlots: vi.fn(async () => 1),
        getActiveTeammateCount: vi.fn(async () => 0),
        spawnTeammateInTmux
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        flowManager: {},
        scheduler: {},
        eventStore: { record: vi.fn(async () => undefined) },
        beadsPort: fakeBeadsPort({ release }),
        worktreePort: fakeWorktreePort({ createWorktree })
      } as any,
      { maxSlots: 1, clock }
    );

    await (supervisor as any).scanAndSpawn();

    // Lease must be released (no leak)
    expect(release).toHaveBeenCalledWith('bead-leak');
    // startedBeads must not hold the quarantined bead (slot freed)
    expect((supervisor as any).startedBeads.has('bead-leak')).toBe(false);
    expect((supervisor as any).startedBeadAtMs.has('bead-leak')).toBe(false);
    // Error must be classified as INVALID_BRANCH_REF
    expect((supervisor as any).quarantine.get('bead-leak')?.reason).toBe('INVALID_BRANCH_REF');
  });
});
