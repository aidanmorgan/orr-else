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
import { DomainEventName } from '../src/constants/index.js';
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
    { maxSlots: 2, clock }
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
    expect((supervisor as any).resolveWorktreeProvisioning('Planning', config)).toBe(true);
  });

  it('returns false when policy.default = "never" and no per-state override', () => {
    const config = {
      settings: { worktreePolicy: { default: 'never' } },
      states: { Planning: {} }
    };
    const { supervisor } = buildSupervisor(config);
    expect((supervisor as any).resolveWorktreeProvisioning('Planning', config)).toBe(false);
  });

  it('per-state provisionWorktree: true overrides policy.default = "never"', () => {
    const config = {
      settings: { worktreePolicy: { default: 'never' } },
      states: { Implementation: { provisionWorktree: true } }
    };
    const { supervisor } = buildSupervisor(config);
    expect((supervisor as any).resolveWorktreeProvisioning('Implementation', config)).toBe(true);
  });

  it('per-state provisionWorktree: false overrides policy.default = "always"', () => {
    const config = {
      settings: { worktreePolicy: { default: 'always' } },
      states: { Planning: { provisionWorktree: false } }
    };
    const { supervisor } = buildSupervisor(config);
    expect((supervisor as any).resolveWorktreeProvisioning('Planning', config)).toBe(false);
  });

  it('returns true for unknown state when policy.default = "always"', () => {
    const config = {
      settings: { worktreePolicy: { default: 'always' } },
      states: { Planning: {} }
    };
    const { supervisor } = buildSupervisor(config);
    expect((supervisor as any).resolveWorktreeProvisioning('UnknownState', config)).toBe(true);
  });

  it('returns false for unknown state when policy.default = "never"', () => {
    const config = {
      settings: { worktreePolicy: { default: 'never' } },
      states: {}
    };
    const { supervisor } = buildSupervisor(config);
    expect((supervisor as any).resolveWorktreeProvisioning('UnknownState', config)).toBe(false);
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
    expect(spawnTeammateInTmux).toHaveBeenCalledWith('bead-impl', 'Implementation', '/tmp/worktree', expect.anything());
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
    expect(spawnTeammateInTmux).toHaveBeenCalledWith('bead-plan', 'Planning', '/project/root', expect.anything());
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
    expect(spawn1).toHaveBeenCalledWith('bead-plan', 'Planning', '/project/root', expect.anything());

    // Second scan: Implementation — worktree provisioned
    const { supervisor: supervisor2, createWorktree: cw2, spawnTeammateInTmux: spawn2 } = buildSupervisor(config);
    await (supervisor2 as any).scanAndSpawn();
    expect(cw2).toHaveBeenCalledTimes(1);
    expect(spawn2).toHaveBeenCalledWith('bead-impl', 'Implementation', '/tmp/worktree', expect.anything());
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
      'bead-review', 'AdversarialPreReview', '/project/root', expect.anything()
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
    expect((supervisor as any).quarantine.has('bead-fail')).toBe(true);
    expect((supervisor as any).quarantine.get('bead-fail').reason).toBe('ALREADY_CHECKED_OUT');
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
    expect(spawnTeammateInTmux).toHaveBeenCalledWith('bead-nr', 'Planning', '/project/root', expect.anything());
    expect((supervisor as any).quarantine.size).toBe(0);
    expect(records.some(r => r.event === DomainEventName.BEAD_QUARANTINED)).toBe(false);
  });
});
