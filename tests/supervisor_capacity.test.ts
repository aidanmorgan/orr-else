import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BeadStatus, DomainEventName, PluginToolName, TimeMs } from '../src/constants/index.js';
import type { Clock } from '../src/core/Clock.js';

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
      return { id, status: stateId };
    });
    const release = vi.fn(async () => ({ success: true }));
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
        plugins: {
          bd: {
            tools: [
              { name: PluginToolName.BD_CLAIM, execute: claim },
              { name: PluginToolName.BD_RELEASE, execute: release }
            ]
          },
          git: {
            tools: [
              { name: PluginToolName.CREATE_WORKTREE, execute: createWorktree }
            ]
          }
        }
      } as any,
      { maxSlots: 2, clock }
    );

    await (supervisor as any).scanAndSpawn();

    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ id: 'bead-1' }), expect.anything());
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ id: 'bead-1' });
    expect(createWorktree).not.toHaveBeenCalled();
    expect(spawnTeammateInTmux).not.toHaveBeenCalled();
    expect((supervisor as any).startedBeads.has('bead-1')).toBe(false);
    expect(records.some(record => record.event === DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED)).toBe(true);
  });

  it('restores an active capacity pause before scanning the backlog', async () => {
    const clock = createFakeClock();
    const claim = vi.fn(async () => ({ id: 'bead-1', status: 'Planning' }));
    const release = vi.fn(async () => ({ success: true }));
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
        plugins: {
          bd: {
            tools: [
              { name: PluginToolName.BD_CLAIM, execute: claim },
              { name: PluginToolName.BD_RELEASE, execute: release }
            ]
          }
        }
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
    const claim = vi.fn(async ({ id, stateId }: { id: string; stateId: string }) => ({ id, status: stateId }));
    const release = vi.fn(async () => ({ success: true }));
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
        plugins: {
          bd: {
            tools: [
              { name: PluginToolName.BD_CLAIM, execute: claim },
              { name: PluginToolName.BD_RELEASE, execute: release }
            ]
          },
          git: {
            tools: [
              { name: PluginToolName.CREATE_WORKTREE, execute: createWorktree }
            ]
          }
        }
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
    expect(createWorktree).toHaveBeenCalledWith({ beadId: 'bead-restarted' }, expect.anything());
    expect(spawnTeammateInTmux).toHaveBeenCalledWith('bead-restarted', 'Planning', '/tmp/worktree', expect.anything());
    expect(release).not.toHaveBeenCalled();
  });

  it('releases a missing restart-requested worker before scanning so capacity can respawn it', async () => {
    const clock = createFakeClock();
    const records: Array<{ event: string; data: any }> = [];
    let releasedRestart = false;
    let liveBeadIds = new Set(['bead-live']);
    const claim = vi.fn(async ({ id, stateId }: { id: string; stateId: string }) => ({ id, status: stateId }));
    const release = vi.fn(async ({ id }: { id: string }) => {
      if (id === 'bead-restart') releasedRestart = true;
      return { success: true };
    });
    const getBead = vi.fn(async () => ({ id: 'bead-live', status: 'Planning' }));
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
        plugins: {
          bd: {
            tools: [
              { name: PluginToolName.BD_CLAIM, execute: claim },
              { name: PluginToolName.BD_RELEASE, execute: release },
              { name: PluginToolName.BD_GET_BEAD, execute: getBead }
            ]
          },
          git: {
            tools: [
              { name: PluginToolName.CREATE_WORKTREE, execute: createWorktree }
            ]
          }
        }
      } as any,
      { maxSlots: 2, clock }
    );
    (supervisor as any).startedBeads.add('bead-live');
    (supervisor as any).startedBeads.add('bead-restart');
    (supervisor as any).startedBeadAtMs.set('bead-live', clock.now());
    (supervisor as any).startedBeadAtMs.set('bead-restart', clock.now() - TimeMs.SECOND);

    await (supervisor as any).step();

    expect(release).toHaveBeenCalledWith({ id: 'bead-restart' });
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(claim.mock.invocationCallOrder[0]);
    expect(orchestratorMock.selectAssignments).toHaveBeenCalledWith(
      1,
      undefined,
      new Set(['bead-live'])
    );
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ id: 'bead-restart' }), expect.anything());
    expect(createWorktree).toHaveBeenCalledWith({ beadId: 'bead-restart' }, expect.anything());
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
    const claim = vi.fn(async () => ({ id: 'bead-cooling', status: 'Planning' }));

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
        plugins: {
          bd: {
            tools: [
              { name: PluginToolName.BD_CLAIM, execute: claim }
            ]
          },
          git: {
            tools: [
              { name: PluginToolName.CREATE_WORKTREE, execute: vi.fn() }
            ]
          }
        }
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
    const claim = vi.fn(async () => ({ id: 'bead-live', status: 'Planning' }));

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
        plugins: {
          bd: {
            tools: [
              { name: PluginToolName.BD_CLAIM, execute: claim }
            ]
          },
          git: {
            tools: [
              { name: PluginToolName.CREATE_WORKTREE, execute: vi.fn() }
            ]
          }
        }
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
    const getBead = vi.fn(async () => ({ id: 'bead-closed', status: BeadStatus.COMPLETED }));
    const release = vi.fn(async () => ({ success: true }));
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
        plugins: {
          bd: {
            tools: [
              { name: PluginToolName.BD_GET_BEAD, execute: getBead },
              { name: PluginToolName.BD_RELEASE, execute: release }
            ]
          }
        }
      } as any,
      { maxSlots: 1, clock }
    );
    (supervisor as any).startedBeads.add('bead-closed');

    await (supervisor as any).reconcileTerminalLiveBeads();

    expect(getBead).toHaveBeenCalledWith({ id: 'bead-closed' });
    expect(terminateTeammatesForBead).toHaveBeenCalledWith(
      'bead-closed',
      expect.stringContaining('terminal Bead status completed')
    );
    expect(release).toHaveBeenCalledWith({ id: 'bead-closed' });
    expect((supervisor as any).startedBeads.has('bead-closed')).toBe(false);
  });
});
