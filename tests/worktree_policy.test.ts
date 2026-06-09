/**
 * Tests for the state worktree allocation policy (pi-experiment-s3wp.5 / pi-experiment-145m).
 *
 * Encodes the invariants:
 *   1. Missing settings.worktreePolicy.default → startup-fatal (ConfigLoader rejects at load).
 *   2. settings.worktreePolicy.default = 'always': every state receives a worktree.
 *   3. settings.worktreePolicy.default = 'never': no state receives a worktree
 *      unless it has an explicit provisionWorktree: true override.
 *   4. Per-state provisionWorktree overrides the policy default:
 *        provisionWorktree: true  → worktree provisioned even when policy is 'never'
 *        provisionWorktree: false → no worktree even when policy is 'always'
 *   5. resolveWorktreeProvisioning is a pure function accessible on the
 *      Supervisor instance — tests exercise it directly and through scanAndSpawn.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DomainEventName } from '../src/constants/domain.js';
import type { Clock } from '../src/core/Clock.js';
import type { BeadsPort, WorktreePort } from '../src/core/OrchestrationPorts.js';
import { Supervisor } from '../src/core/Supervisor.js';
import { fakeProjectionStore } from './support/fakeProjectionStore.js';

// Shared mutable orchestrator mock — injected directly into Supervisor options
// (pi-experiment-amq0.2: no vi.mock needed; orchestrator is now a required inject).
const orchestratorMock = {
  selectAssignments: vi.fn()
};

function fakeOrchestrator() {
  return orchestratorMock as any;
}

function fakeRetentionScheduler() {
  return { runIfDue: vi.fn(async () => {}) } as any;
}

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

/** Build a minimal Supervisor with the given harness config. */
function buildSupervisor(
  configOverride: Record<string, unknown>,
  {
    createWorktree = vi.fn(async () => ({ success: true, path: '/tmp/worktree' })),
    spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%1' })),
    claim = vi.fn(async ({ id }: { id: string }) => ({ id } as any)),
    release = vi.fn(async () => {})
  } = {}
) {
  const clock = createFakeClock();
  const records: Array<{ event: string; data: unknown }> = [];
  const supervisor = new Supervisor(
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
        load: async () => configOverride
      },
      flowManager: {},
      scheduler: {},
      eventStore: fakeProjectionStore({
        record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); })
      }),
      beadsPort: fakeBeadsPort({ claim, release }),
      worktreePort: fakeWorktreePort({ createWorktree }),
      projectRoot: '/project/root'
    } as any,
    { maxSlots: 2, clock, orchestrator: fakeOrchestrator(), retentionScheduler: fakeRetentionScheduler() }
  );
  return { supervisor, records, createWorktree, spawnTeammateInTmux, claim, release };
}

// ---------------------------------------------------------------------------
// Direct unit tests for resolveWorktreeProvisioning
// ---------------------------------------------------------------------------

describe('Supervisor.resolveWorktreeProvisioning — pure policy resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when policy.default = "always" and no per-state override', () => {
    const config = {
      settings: { worktreePolicy: { default: 'always' } },
      states: { Planning: {} }
    };
    const { supervisor } = buildSupervisor(config);
    expect((supervisor as any).spawnCoordinator.resolveWorktreeProvisioning('Planning', config)).toBe(true);
  });

  it('returns false when policy.default = "never" and no per-state override', () => {
    const config = {
      settings: { worktreePolicy: { default: 'never' } },
      states: { Planning: {} }
    };
    const { supervisor } = buildSupervisor(config);
    expect((supervisor as any).spawnCoordinator.resolveWorktreeProvisioning('Planning', config)).toBe(false);
  });

  it('per-state provisionWorktree: true overrides policy.default = "never"', () => {
    const config = {
      settings: { worktreePolicy: { default: 'never' } },
      states: { Implementation: { provisionWorktree: true } }
    };
    const { supervisor } = buildSupervisor(config);
    expect((supervisor as any).spawnCoordinator.resolveWorktreeProvisioning('Implementation', config)).toBe(true);
  });

  it('per-state provisionWorktree: false overrides policy.default = "always"', () => {
    const config = {
      settings: { worktreePolicy: { default: 'always' } },
      states: { Planning: { provisionWorktree: false } }
    };
    const { supervisor } = buildSupervisor(config);
    expect((supervisor as any).spawnCoordinator.resolveWorktreeProvisioning('Planning', config)).toBe(false);
  });

  it('returns true for unknown state when policy.default = "always"', () => {
    const config = {
      settings: { worktreePolicy: { default: 'always' } },
      states: { Planning: {} }
    };
    const { supervisor } = buildSupervisor(config);
    expect((supervisor as any).spawnCoordinator.resolveWorktreeProvisioning('UnknownState', config)).toBe(true);
  });

  it('returns false for unknown state when policy.default = "never"', () => {
    const config = {
      settings: { worktreePolicy: { default: 'never' } },
      states: {}
    };
    const { supervisor } = buildSupervisor(config);
    expect((supervisor as any).spawnCoordinator.resolveWorktreeProvisioning('UnknownState', config)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: policy enforced through scanAndSpawn
// ---------------------------------------------------------------------------

describe('Supervisor worktree policy — integration via scanAndSpawn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('provisions a worktree when policy.default = "always"', async () => {
    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-impl', stateId: 'Implementation', score: 1, status: 'ready' }
    ]);

    const { supervisor, createWorktree, spawnTeammateInTmux } = buildSupervisor({
      settings: { worktreePolicy: { default: 'always' } },
      states: { Implementation: {} }
    });

    await (supervisor as any).scanAndSpawn();

    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(spawnTeammateInTmux).toHaveBeenCalledWith('bead-impl', 'Implementation', '/tmp/worktree', expect.anything(), undefined);
  });

  it('skips worktree creation when policy.default = "never" and no per-state override', async () => {
    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-plan', stateId: 'Planning', score: 1, status: 'ready' }
    ]);

    const { supervisor, createWorktree, spawnTeammateInTmux, records } = buildSupervisor({
      settings: { worktreePolicy: { default: 'never' } },
      states: { Planning: {} }
    });

    await (supervisor as any).scanAndSpawn();

    // No worktree should be created
    expect(createWorktree).not.toHaveBeenCalled();
    // Teammate spawned at project root
    expect(spawnTeammateInTmux).toHaveBeenCalledWith('bead-plan', 'Planning', '/project/root', expect.anything(), undefined);
    // No WORKTREE_PROVISIONED event
    expect(records.some(r => r.event === DomainEventName.WORKTREE_PROVISIONED)).toBe(false);
  });

  it('skips worktree for policy=never but provisions for state with provisionWorktree: true', async () => {
    orchestratorMock.selectAssignments
      .mockResolvedValueOnce([{ id: 'bead-plan', stateId: 'Planning', score: 2, status: 'ready' }])
      .mockResolvedValueOnce([{ id: 'bead-impl', stateId: 'Implementation', score: 1, status: 'ready' }]);

    const config = {
      settings: { worktreePolicy: { default: 'never' } },
      states: {
        Planning: {},
        Implementation: { provisionWorktree: true }
      }
    };

    // First scan: Planning — no worktree
    const { supervisor: supervisor1, createWorktree: cw1, spawnTeammateInTmux: spawn1 } = buildSupervisor(config);
    await (supervisor1 as any).scanAndSpawn();
    expect(cw1).not.toHaveBeenCalled();
    expect(spawn1).toHaveBeenCalledWith('bead-plan', 'Planning', '/project/root', expect.anything(), undefined);

    // Second scan: Implementation — worktree provisioned
    const { supervisor: supervisor2, createWorktree: cw2, spawnTeammateInTmux: spawn2 } = buildSupervisor(config);
    await (supervisor2 as any).scanAndSpawn();
    expect(cw2).toHaveBeenCalledTimes(1);
    expect(spawn2).toHaveBeenCalledWith('bead-impl', 'Implementation', '/tmp/worktree', expect.anything(), undefined);
  });

  it('skips worktree for state with provisionWorktree: false even when policy.default = "always"', async () => {
    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-review', stateId: 'AdversarialPreReview', score: 1, status: 'ready' }
    ]);

    const { supervisor, createWorktree, spawnTeammateInTmux, records } = buildSupervisor({
      settings: { worktreePolicy: { default: 'always' } },
      states: { AdversarialPreReview: { provisionWorktree: false } }
    });

    await (supervisor as any).scanAndSpawn();

    expect(createWorktree).not.toHaveBeenCalled();
    expect(spawnTeammateInTmux).toHaveBeenCalledWith(
      'bead-review', 'AdversarialPreReview', '/project/root', expect.anything(), undefined
    );
    expect(records.some(r => r.event === DomainEventName.WORKTREE_PROVISIONED)).toBe(false);
  });

  it('quarantine path still works when needsWorktree=true and createWorktree fails', async () => {
    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-fail', stateId: 'Implementation', score: 1, status: 'ready' }
    ]);

    const failingCreateWorktree = vi.fn(async () => ({
      success: false,
      error: "fatal: 'bead/bead-fail' is already checked out at '/somewhere'"
    }));

    const { supervisor, spawnTeammateInTmux, release } = buildSupervisor(
      {
        settings: { worktreePolicy: { default: 'always' } },
        states: { Implementation: { provisionWorktree: true } }
      },
      { createWorktree: failingCreateWorktree }
    );

    await (supervisor as any).scanAndSpawn();

    // Lease must be released, no spawn
    expect(release).toHaveBeenCalledWith('bead-fail');
    expect(spawnTeammateInTmux).not.toHaveBeenCalled();
    expect((supervisor as any).spawnCoordinator.quarantine.has('bead-fail')).toBe(true);
    expect((supervisor as any).spawnCoordinator.quarantine.get('bead-fail').reason).toBe('ALREADY_CHECKED_OUT');
  });

  it('no quarantine attempt when needsWorktree=false (project root path)', async () => {
    // When worktree is not needed, a worktree failure cannot occur —
    // the quarantine path is unreachable. This test asserts the bypass.
    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-nr', stateId: 'Planning', score: 1, status: 'ready' }
    ]);

    // createWorktree is set to fail, but should never be called
    const failingCreateWorktree = vi.fn(async () => ({ success: false, error: 'simulated failure' }));

    const { supervisor, spawnTeammateInTmux, records } = buildSupervisor(
      {
        settings: { worktreePolicy: { default: 'never' } },
        states: { Planning: {} }
      },
      { createWorktree: failingCreateWorktree }
    );

    await (supervisor as any).scanAndSpawn();

    expect(failingCreateWorktree).not.toHaveBeenCalled();
    expect(spawnTeammateInTmux).toHaveBeenCalledWith('bead-nr', 'Planning', '/project/root', expect.anything(), undefined);
    expect((supervisor as any).spawnCoordinator.quarantine.size).toBe(0);
    expect(records.some(r => r.event === DomainEventName.BEAD_QUARANTINED)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LOAD-BEARING: pi-experiment-ek2j v2 spawn invariants (AC3 + AC4)
// ---------------------------------------------------------------------------

describe('ek2j v2 spawn invariants — isolated worktree mandatory, no project-root fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * LOAD-BEARING (AC3): A v2 worker spawn provisions an isolated worktree and
   * records a WORKTREE_PROVISIONED event carrying the isolated worktree path.
   *
   * This test FAILS if the WORKTREE_PROVISIONED record is removed or if the
   * worktreePath is absent from the WORKTREE_PROVISIONED payload.
   */
  it('(AC3 load-bearing) v2 spawn provisions isolated worktree and records WORKTREE_PROVISIONED with path', async () => {
    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-v2-spawn', stateId: 'Implementation', score: 1, status: 'ready' }
    ]);

    const { supervisor, createWorktree, spawnTeammateInTmux, records } = buildSupervisor({
      version: 2,
      settings: { maxConcurrentSlots: 1 },
      states: { Implementation: {} }
    });

    await (supervisor as any).scanAndSpawn();

    // Isolated worktree must be provisioned.
    expect(createWorktree).toHaveBeenCalledTimes(1);

    // WORKTREE_PROVISIONED event must be recorded with the isolated worktree path.
    const provisionedEvent = records.find(r => r.event === DomainEventName.WORKTREE_PROVISIONED);
    expect(provisionedEvent).toBeDefined();
    expect((provisionedEvent!.data as any).worktreePath).toBe('/tmp/worktree');
    expect((provisionedEvent!.data as any).beadId).toBe('bead-v2-spawn');

    // Teammate must be spawned at the isolated path (NOT project root).
    expect(spawnTeammateInTmux).toHaveBeenCalledWith(
      'bead-v2-spawn', 'Implementation', '/tmp/worktree', expect.anything(), undefined
    );
  });

  /**
   * LOAD-BEARING (AC4): When worktree creation FAILS for a v2 worker spawn,
   * the spawn FAILS CLOSED — the worker must NOT run at the project root.
   *
   * This test FAILS if the v2 fail-closed guard is removed (the bead would
   * instead be spawned at /project/root, violating AC4).
   */
  it('(AC4 load-bearing) v2 spawn: worktree creation failure → fail-closed, no project-root fallback', async () => {
    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-v2-fail', stateId: 'Implementation', score: 1, status: 'ready' }
    ]);

    const failingCreateWorktree = vi.fn(async () => ({
      success: false,
      error: 'fatal: worktree creation failed'
    }));
    const release = vi.fn(async () => {});

    const { supervisor, spawnTeammateInTmux, records } = buildSupervisor(
      {
        version: 2,
        settings: { maxConcurrentSlots: 1 },
        states: { Implementation: {} }
      },
      { createWorktree: failingCreateWorktree, release }
    );

    await (supervisor as any).scanAndSpawn();

    // Worktree creation was attempted.
    expect(failingCreateWorktree).toHaveBeenCalledTimes(1);

    // Fail-closed: NO teammate spawned (especially not at project root).
    expect(spawnTeammateInTmux).not.toHaveBeenCalled();

    // Bead must be quarantined with a structured diagnostic.
    expect(records.some(r => r.event === DomainEventName.BEAD_QUARANTINED)).toBe(true);

    // Lease must be released.
    expect(release).toHaveBeenCalledWith('bead-v2-fail');
  });

  /**
   * v1 spawn: project-root fallback is preserved for states with
   * worktreePolicy.default = 'never' (existing behavior, unregressed).
   */
  it('v1 spawn: project-root fallback preserved (version-gated, v1 unaffected)', async () => {
    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-v1', stateId: 'Planning', score: 1, status: 'ready' }
    ]);

    const { supervisor, createWorktree, spawnTeammateInTmux } = buildSupervisor({
      // No version field → v1 behavior.
      settings: { worktreePolicy: { default: 'never' } },
      states: { Planning: {} }
    });

    await (supervisor as any).scanAndSpawn();

    // No worktree created for v1 never-policy state.
    expect(createWorktree).not.toHaveBeenCalled();
    // Teammate runs at project root — v1 behavior preserved.
    expect(spawnTeammateInTmux).toHaveBeenCalledWith(
      'bead-v1', 'Planning', '/project/root', expect.anything(), undefined
    );
  });

  /**
   * v2 spawn: state with provisionWorktree: false is fail-closed (no project-root fallback).
   * Version-gated: this path only triggers for version: 2 configs.
   */
  it('(AC4 load-bearing) v2 spawn: state provisionWorktree: false → fail-closed, quarantined with V2_ISOLATED_WORKTREE_REQUIRED', async () => {
    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-v2-no-wt', stateId: 'Review', score: 1, status: 'ready' }
    ]);

    const createWorktree = vi.fn(async () => ({ success: true, path: '/tmp/worktree' }));
    const release = vi.fn(async () => {});

    const { supervisor, spawnTeammateInTmux, records } = buildSupervisor(
      {
        version: 2,
        settings: { maxConcurrentSlots: 1 },
        states: { Review: { provisionWorktree: false } }
      },
      { createWorktree, release }
    );

    await (supervisor as any).scanAndSpawn();

    // createWorktree must NOT be called — the fail-closed fires before provisioning.
    expect(createWorktree).not.toHaveBeenCalled();
    // Teammate must NOT be spawned (at project root or anywhere else).
    expect(spawnTeammateInTmux).not.toHaveBeenCalled();
    // Lease released.
    expect(release).toHaveBeenCalledWith('bead-v2-no-wt');
    // Bead quarantined with V2_ISOLATED_WORKTREE_REQUIRED reason.
    const quarantineEvent = records.find(r => r.event === DomainEventName.BEAD_QUARANTINED);
    expect(quarantineEvent).toBeDefined();
    expect((quarantineEvent!.data as any).reason).toBe('V2_ISOLATED_WORKTREE_REQUIRED');
  });
});
