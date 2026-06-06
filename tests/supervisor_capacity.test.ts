import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Logger } from '../src/core/Logger.js';
import { BeadStatus, DomainEventName, EventName, SupervisorDefaults, TimeMs } from '../src/constants/index.js';
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
import { fakeProjectionStore } from './support/fakeProjectionStore.js';

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
        eventStore: fakeProjectionStore({
          record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); })
        }),
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
        eventStore: fakeProjectionStore({
          latestEventByType: vi.fn(async () => ({
            id: 'capacity-event',
            type: DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED,
            timestamp: clock.date().toISOString(),
            sessionId: 'previous-session',
            data: { pauseUntil, reason: 'subscription capacity exhausted' }
          }))
        }),
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: fakeWorktreePort()
      } as any,
      { maxSlots: 1, clock }
    );

    await (supervisor as any).restoreCapacityPauseFromStore();
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
        eventStore: fakeProjectionStore(),
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
        eventStore: fakeProjectionStore({
          record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); }),
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
            : { id: beadId, status: 'Planning', restartRequested: false })
        }),
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

  it('quarantines non-routable terminal failure-limit restart requests before respawn', async () => {
    const clock = createFakeClock();
    const records: Array<{ event: string; data: any }> = [];
    const terminalFailure = {
      id: 'terminal-1',
      type: DomainEventName.PROJECT_TOOL_FAILED,
      timestamp: '2026-01-02T03:04:01.000Z',
      sessionId: 's1',
      data: {
        beadId: 'bead-loop',
        stateId: 'LessonCapture',
        actionId: 'capture-lesson',
        tool: 'artifact_validator',
        result: {
          failureLimit: {
            terminal: true,
            suggestedOutcome: EventName.FAILURE
          }
        }
      }
    };
    const restartRequest = {
      id: 'restart-1',
      type: DomainEventName.HARNESS_RESTART_REQUESTED,
      timestamp: '2026-01-02T03:04:02.000Z',
      sessionId: 's1',
      data: {
        beadId: 'bead-loop',
        stateId: 'LessonCapture',
        targetState: 'LessonCapture',
        transitionEvent: EventName.HARNESS_RESTART,
        idempotencyKey: 'restart-key'
      }
    };
    const claim = vi.fn(async () => ({ id: 'bead-loop', status: 'LessonCapture' } as any));
    const createWorktree = vi.fn(async () => ({ success: true, path: '/tmp/worktree' }));
    const spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%2' }));
    const nextState = vi.fn(() => {
      throw new Error('No transition configured for outcome FAILURE in state LessonCapture.');
    });

    orchestratorMock.selectAssignments.mockResolvedValue([
      {
        id: 'bead-loop',
        stateId: 'LessonCapture',
        score: 8,
        status: 'LessonCapture',
        lastActivity: '2026-01-02T03:04:00.000Z'
      }
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
          load: async () => ({
            settings: {},
            states: {
              LessonCapture: {
                actions: [],
                on: { [EventName.HARNESS_RESTART]: 'LessonCapture' },
                transitions: { [EventName.HARNESS_RESTART]: 'LessonCapture' }
              }
            },
            tools: [{ name: 'artifact_validator', type: 'command' }]
          })
        },
        flowManager: { nextState },
        scheduler: {},
        eventStore: {
          record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
          latestProjectToolFailureLimitEvent: vi.fn(async () => terminalFailure),
          eventsForBead: vi.fn(async () => [terminalFailure, restartRequest])
        },
        beadsPort: fakeBeadsPort({ claim }),
        worktreePort: fakeWorktreePort({ createWorktree })
      } as any,
      { maxSlots: 1, clock }
    );

    await (supervisor as any).scanAndSpawn();
    await (supervisor as any).scanAndSpawn();
    await (supervisor as any).scanAndSpawn();

    expect(claim).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
    expect(spawnTeammateInTmux).not.toHaveBeenCalled();
    expect(nextState).toHaveBeenCalledTimes(1);

    const quarantineEvents = records.filter(record => record.event === DomainEventName.BEAD_QUARANTINED);
    expect(quarantineEvents).toHaveLength(1);
    expect(quarantineEvents[0].data).toMatchObject({
      beadId: 'bead-loop',
      reason: 'NON_ROUTABLE_TERMINAL_FAILURE_LIMIT',
      stateId: 'LessonCapture',
      actionId: 'capture-lesson',
      toolName: 'artifact_validator',
      suggestedOutcome: EventName.FAILURE,
      configuredOutcomes: [EventName.HARNESS_RESTART],
      restartTargetState: 'LessonCapture',
      sourceEventId: 'restart-1',
      sourceIdempotencyKey: 'restart-key',
      terminalFailureEventId: 'terminal-1'
    });
    expect(quarantineEvents[0].data.suggestedOutcomeTransitionError).toContain('No transition configured');
  });

  it('does not quarantine routable terminal failure-limit restart requests', async () => {
    const clock = createFakeClock();
    const terminalFailure = {
      id: 'terminal-routable',
      type: DomainEventName.PROJECT_TOOL_FAILED,
      timestamp: '2026-01-02T03:04:01.000Z',
      sessionId: 's1',
      data: {
        beadId: 'bead-routable',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        tool: 'artifact_validator',
        result: {
          failureLimit: {
            terminal: true,
            suggestedOutcome: EventName.FAILURE
          }
        }
      }
    };
    const restartRequest = {
      id: 'restart-routable',
      type: DomainEventName.HARNESS_RESTART_REQUESTED,
      timestamp: '2026-01-02T03:04:02.000Z',
      sessionId: 's1',
      data: {
        beadId: 'bead-routable',
        stateId: 'Planning',
        targetState: 'Planning',
        transitionEvent: EventName.HARNESS_RESTART
      }
    };
    const claim = vi.fn(async ({ id, stateId }: { id: string; stateId: string }) => ({ id, status: stateId } as any));
    const createWorktree = vi.fn(async () => ({ success: true, path: '/tmp/worktree' }));
    const spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%2' }));
    const nextState = vi.fn(() => 'Planning');

    orchestratorMock.selectAssignments.mockResolvedValue([
      {
        id: 'bead-routable',
        stateId: 'Planning',
        score: 5,
        status: 'Planning',
        lastActivity: '2026-01-02T03:04:00.000Z'
      }
    ]);

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        getAvailableSlots: vi.fn(async () => 1),
        getActiveTeammateCount: vi.fn(async () => 1),
        spawnTeammateInTmux
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: {
          load: async () => ({
            settings: {},
            states: {
              Planning: {
                actions: [],
                on: {},
                transitions: {
                  [EventName.FAILURE]: 'Planning',
                  [EventName.HARNESS_RESTART]: 'Planning'
                }
              }
            },
            tools: [{ name: 'artifact_validator', type: 'command' }]
          })
        },
        flowManager: { nextState },
        scheduler: {},
        eventStore: {
          record: vi.fn(async () => undefined),
          latestProjectToolFailureLimitEvent: vi.fn(async () => terminalFailure),
          eventsForBead: vi.fn(async () => [terminalFailure, restartRequest])
        },
        beadsPort: fakeBeadsPort({ claim }),
        worktreePort: fakeWorktreePort({ createWorktree })
      } as any,
      { maxSlots: 1, clock }
    );

    await (supervisor as any).scanAndSpawn();

    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ id: 'bead-routable' }), expect.anything());
    expect(createWorktree).toHaveBeenCalledWith('bead-routable', expect.anything());
    expect(spawnTeammateInTmux).toHaveBeenCalledWith('bead-routable', 'Planning', '/tmp/worktree', expect.anything());
    expect(nextState).toHaveBeenCalledWith(expect.anything(), EventName.FAILURE, 'Planning');
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

// ---------------------------------------------------------------------------
// Quiet capacity-pause mode (xg4v)
// ---------------------------------------------------------------------------

describe('Supervisor quiet capacity-pause mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeMutableClock(startMs: number) {
    let nowMs = startMs;
    return {
      now: () => nowMs,
      date: (timestampMs?: number) => new Date(timestampMs === undefined ? nowMs : timestampMs),
      advance: (deltaMs: number) => { nowMs += deltaMs; }
    };
  }

  function makePauseSupervisor(clock: ReturnType<typeof makeMutableClock>) {
    const records: Array<{ event: string; data: unknown }> = [];
    orchestratorMock.selectAssignments.mockResolvedValue([]);
    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        getAvailableSlots: vi.fn(async () => 2),
        getActiveTeammateCount: vi.fn(async () => 0),
        spawnTeammateInTmux: vi.fn(async () => ({ success: false, error: 'should not be called' }))
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        flowManager: {},
        scheduler: {},
        eventStore: fakeProjectionStore({
          record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); })
        }),
        beadsPort: fakeBeadsPort(),
        worktreePort: fakeWorktreePort()
      } as any,
      { maxSlots: 2, clock }
    );
    return { supervisor, records };
  }

  // AC1: A usage-limit pause records exactly ONE SCHEDULING_PAUSED event with
  // reason + pauseUntil on the first call to pauseSchedulingUntil().
  it('AC1: records exactly ONE SCHEDULING_PAUSED event with reason+pauseUntil on pause enter', async () => {
    const clock = makeMutableClock(NOW_MS);
    const { supervisor, records } = makePauseSupervisor(clock);

    const pauseUntilMs = clock.now() + TimeMs.HOUR;
    supervisor.pauseSchedulingUntil(pauseUntilMs, 'usage_limit_reached');

    const pausedEvents = records.filter(r => r.event === DomainEventName.SCHEDULING_PAUSED);
    expect(pausedEvents).toHaveLength(1);
    expect(pausedEvents[0].data).toMatchObject({
      reason: 'usage_limit_reached',
      pauseUntil: clock.date(pauseUntilMs).toISOString()
    });

    // Calling again with the same value must NOT fire a second event
    supervisor.pauseSchedulingUntil(pauseUntilMs, 'usage_limit_reached');
    expect(records.filter(r => r.event === DomainEventName.SCHEDULING_PAUSED)).toHaveLength(1);
  });

  // AC2: No repeated spawn attempts occur before pauseUntil.
  it('AC2: no spawn attempts occur while pause is active', async () => {
    const clock = makeMutableClock(NOW_MS);
    const { supervisor } = makePauseSupervisor(clock);
    const spawnSpy = (supervisor as any).factory.spawnTeammateInTmux;

    supervisor.pauseSchedulingUntil(clock.now() + TimeMs.HOUR, 'usage_limit_reached');

    // Run scanAndSpawn multiple times — none should attempt to spawn
    for (let i = 0; i < 5; i++) {
      await (supervisor as any).scanAndSpawn();
    }
    expect(orchestratorMock.selectAssignments).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  // AC3: Operator logs include no more than ONE paused heartbeat per 30 minutes.
  it('AC3: heartbeat event fires at most once per PAUSE_HEARTBEAT_INTERVAL_MS', async () => {
    const clock = makeMutableClock(NOW_MS);
    const { supervisor, records } = makePauseSupervisor(clock);

    supervisor.pauseSchedulingUntil(clock.now() + 2 * TimeMs.HOUR, 'usage_limit_reached');

    // First call: lastPauseHeartbeatMs was set to now() in pauseSchedulingUntil,
    // so reportPausedScheduling should NOT emit another heartbeat yet.
    await (supervisor as any).scanAndSpawn();
    await (supervisor as any).scanAndSpawn();

    // Advance by less than the interval
    clock.advance(SupervisorDefaults.PAUSE_HEARTBEAT_INTERVAL_MS - TimeMs.SECOND);
    await (supervisor as any).scanAndSpawn();
    await (supervisor as any).scanAndSpawn();

    // Still at most 0 heartbeats fired (initial enter was the only event so far)
    const heartbeats0 = records.filter(r => r.event === DomainEventName.SCHEDULING_PAUSE_HEARTBEAT);
    expect(heartbeats0.length).toBe(0);

    // Advance past the interval
    clock.advance(TimeMs.SECOND * 2);
    await (supervisor as any).scanAndSpawn();

    const heartbeats1 = records.filter(r => r.event === DomainEventName.SCHEDULING_PAUSE_HEARTBEAT);
    expect(heartbeats1).toHaveLength(1);
    expect(heartbeats1[0].data).toMatchObject({ reason: 'usage_limit_reached' });

    // Another batch of calls within the interval must NOT add more heartbeats
    for (let i = 0; i < 5; i++) {
      clock.advance(TimeMs.SECOND);
      await (supervisor as any).scanAndSpawn();
    }
    expect(records.filter(r => r.event === DomainEventName.SCHEDULING_PAUSE_HEARTBEAT)).toHaveLength(1);
  });

  // AC4a: The 'Teammate capacity underfilled' Logger.warn is suppressed while the
  // capacity-pause is active (Supervisor.ts recordCapacityUnderfill guard ~line 1582)
  // and fires exactly once after the pause expires.
  it('AC4a: Logger.warn "Teammate capacity underfilled" is suppressed while paused and fires after expiry', async () => {
    const clock = makeMutableClock(NOW_MS);
    const records: Array<{ event: string; data: unknown }> = [];
    orchestratorMock.selectAssignments.mockResolvedValue([]);

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()), // no live beads → underfilled
        getAvailableSlots: vi.fn(async () => 2),
        getActiveTeammateCount: vi.fn(async () => 0),
        spawnTeammateInTmux: vi.fn(async () => ({ success: false, error: 'no' }))
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        flowManager: {},
        scheduler: {},
        eventStore: fakeProjectionStore({
          record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); })
        }),
        beadsPort: fakeBeadsPort(),
        worktreePort: fakeWorktreePort()
      } as any,
      { maxSlots: 2, clock }
    );

    const pauseDurationMs = TimeMs.MINUTE;
    supervisor.pauseSchedulingUntil(clock.now() + pauseDurationMs, 'usage_limit_reached');

    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    try {
      // WHILE PAUSED: recordSlotHealth triggers recordCapacityUnderfill.
      // The guard at Supervisor.ts:1582 must suppress the Logger.warn call.
      await (supervisor as any).recordSlotHealth('test_paused');

      // Durable event IS still recorded (audit trail must be intact)
      expect(records.filter(r => r.event === DomainEventName.TEAMMATE_CAPACITY_UNDERFILLED).length).toBeGreaterThanOrEqual(1);

      // Logger.warn must NOT have been called with the underfilled message
      expect(warn).not.toHaveBeenCalledWith(
        expect.any(String),
        'Teammate capacity underfilled',
        expect.anything()
      );

      // AFTER PAUSE EXPIRES: advance clock past pause + slot-health throttle,
      // reset digests so the event + warn fire fresh.
      clock.advance(pauseDurationMs + TimeMs.SECOND + SupervisorDefaults.SLOT_HEALTH_EVENT_INTERVAL_MS);
      expect((supervisor as any).isSchedulingPaused()).toBe(false);

      // Reset digests so recordCapacityUnderfill sees a new digest and emits again
      (supervisor as any).lastCapacityUnderfillDigest = '';
      (supervisor as any).lastLoggedSlotHealthDigest = '';

      warn.mockClear();
      await (supervisor as any).recordSlotHealth('test_resumed');

      // Now the guard is cleared — Logger.warn MUST be called with the underfilled message
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        'Teammate capacity underfilled',
        expect.anything()
      );
    } finally {
      warn.mockRestore();
    }
  });

  // AC4b: The 'Teammate slot health check found underfilled or stale work' Logger.warn
  // is suppressed while the capacity-pause is active (Supervisor.ts ~lines 1505-1506).
  it('AC4b: Logger.warn "slot health underfilled" is suppressed while paused; durable event still recorded', async () => {
    const clock = makeMutableClock(NOW_MS);
    const records: Array<{ event: string; data: unknown }> = [];
    orchestratorMock.selectAssignments.mockResolvedValue([]);

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()), // no live beads → underfilled
        getAvailableSlots: vi.fn(async () => 2),
        getActiveTeammateCount: vi.fn(async () => 0),
        spawnTeammateInTmux: vi.fn(async () => ({ success: false, error: 'no' }))
      } as any,
      { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        flowManager: {},
        scheduler: {},
        eventStore: fakeProjectionStore({
          record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); })
        }),
        beadsPort: fakeBeadsPort(),
        worktreePort: fakeWorktreePort()
      } as any,
      { maxSlots: 2, clock }
    );

    supervisor.pauseSchedulingUntil(clock.now() + TimeMs.HOUR, 'usage_limit_reached');

    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    try {
      // WHILE PAUSED: the slot-health underfilled branch (Supervisor.ts:1505-1506)
      // must absorb the digest change silently — no Logger.warn emitted.
      await (supervisor as any).recordSlotHealth('test_slot_health_paused');

      // Durable TEAMMATE_CAPACITY_UNDERFILLED event IS still recorded
      expect(records.filter(r => r.event === DomainEventName.TEAMMATE_CAPACITY_UNDERFILLED).length).toBeGreaterThanOrEqual(1);

      // Logger.warn must NOT have been called with the slot-health underfilled message
      expect(warn).not.toHaveBeenCalledWith(
        expect.any(String),
        'Teammate slot health check found underfilled or stale work',
        expect.anything()
      );
    } finally {
      warn.mockRestore();
    }
  });

  // AC5: Normal scheduling resumes automatically after pause expiry.
  it('AC5: scheduling resumes automatically after pause expiry', async () => {
    const clock = makeMutableClock(NOW_MS);
    const { supervisor } = makePauseSupervisor(clock);

    const pauseUntilMs = clock.now() + TimeMs.MINUTE;
    supervisor.pauseSchedulingUntil(pauseUntilMs, 'usage_limit_reached');

    // While paused: selectAssignments must not be called
    await (supervisor as any).scanAndSpawn();
    expect(orchestratorMock.selectAssignments).not.toHaveBeenCalled();

    // Advance past the pause window
    clock.advance(TimeMs.MINUTE + TimeMs.SECOND);

    // Now pause is expired — isSchedulingPaused() should return false
    expect((supervisor as any).isSchedulingPaused()).toBe(false);

    // scanAndSpawn should now proceed to selectAssignments
    await (supervisor as any).scanAndSpawn();
    expect(orchestratorMock.selectAssignments).toHaveBeenCalledTimes(1);
  });
});
