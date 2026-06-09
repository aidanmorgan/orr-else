import { describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../src/core/Orchestrator.js';
import { FlowManager } from '../src/core/FlowManager.js';
import { App, BeadsIssueStatus, PluginToolName } from '../src/constants/domain.js';
import { BeadsDefaults } from '../src/constants/infra.js';
import type { BeadsPort } from '../src/core/OrchestrationPorts.js';
import type { Bead } from '../src/types/index.js';

function fakeBead(id: string, status: string, overrides: Partial<Bead> = {}): Bead {
  return {
    id: id as any,
    title: id,
    status,
    assigned_to: undefined,
    dependencies: [],
    changed_files: [],
    logs: [],
    retryCount: 0,
    compactionCount: 0,
    totalExecutionTimeMs: 0,
    handovers: {},
    completedActionIds: [],
    lastActivity: new Date(0).toISOString(),
    ...overrides
  };
}

describe('Orchestrator', () => {
  it('resumes Orr Else-owned in-progress beads without a current-session active lease when ready backlog is short', async () => {
    const calls: Array<{ name: string; args: any }> = [];
    const beadsPort: BeadsPort = {
      ready: vi.fn(async (args) => {
        calls.push({ name: PluginToolName.BD_READY, args });
        return [];
      }),
      list: vi.fn(async (args) => {
        calls.push({ name: PluginToolName.BD_LIST, args });
        return {
          items: [
            fakeBead('cerdiwen-resume', 'RequirementsAnalysis', {
              assigned_to: App.DISPLAY_NAME
            }),
            fakeBead('cerdiwen-old-session-lease', 'RequirementsAnalysis', {
              assigned_to: App.DISPLAY_NAME,
              lease: { owner: App.DISPLAY_NAME, expiresAt: new Date(Date.now() + 60_000).toISOString() },
              leaseSessionId: 'session-old'
            }),
            fakeBead('cerdiwen-leased', 'RequirementsAnalysis', {
              assigned_to: App.DISPLAY_NAME,
              lease: { owner: App.DISPLAY_NAME, expiresAt: new Date(Date.now() + 60_000).toISOString() },
              leaseSessionId: 'session-current'
            })
          ]
        };
      }),
      getBead: vi.fn(async (id) => fakeBead(id, 'RequirementsAnalysis')),
      claim: vi.fn(async ({ id }) => fakeBead(id, 'RequirementsAnalysis')),
      release: vi.fn(async () => {})
    };
    const orchestrator = new Orchestrator(
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn, getSessionId: () => 'session-current' } as any,
      { load: async () => ({ settings: { maxConcurrentSlots: 6 }, states: { RequirementsAnalysis: {} }, scheduler: {} }) } as any,
      { stateForBead: (bead: any) => bead.status } as any,
      { sortBacklog: async (beads: any[]) => beads.map((bead, index) => ({ ...bead, score: index })) } as any,
      beadsPort,
      6
    );

    const assignments = await orchestrator.selectAssignments(2);

    expect(assignments.map(bead => bead.id)).toEqual(['cerdiwen-resume', 'cerdiwen-old-session-lease']);
    expect(calls.find(call => call.name === PluginToolName.BD_LIST)?.args.status).toBe(BeadsIssueStatus.IN_PROGRESS);
    expect(calls.find(call => call.name === PluginToolName.BD_LIST)?.args.includeProjection).toBe(true);
    expect(calls.find(call => call.name === PluginToolName.BD_LIST)?.args.limit).toBe(
      BeadsDefaults.IN_PROGRESS_RECOVERY_SCAN_MULTIPLIER * 6
    );
  });

  it('keeps resumable in-progress work in the candidate pool when ready backlog is full', async () => {
    const ready = Array.from({ length: 10 }, (_, index) => fakeBead(`cerdiwen-ready-${index}`, 'ready'));
    const calls: Array<{ name: string; args: any }> = [];
    const beadsPort: BeadsPort = {
      ready: vi.fn(async (args) => {
        calls.push({ name: PluginToolName.BD_READY, args });
        return ready;
      }),
      list: vi.fn(async (args) => {
        calls.push({ name: PluginToolName.BD_LIST, args });
        return {
          items: [
            fakeBead('cerdiwen-resume', 'Planning', { assigned_to: App.DISPLAY_NAME })
          ]
        };
      }),
      getBead: vi.fn(async (id) => fakeBead(id, 'ready')),
      claim: vi.fn(async ({ id }) => fakeBead(id, 'ready')),
      release: vi.fn(async () => {})
    };
    const orchestrator = new Orchestrator(
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn, getSessionId: () => 'session-current' } as any,
      { load: async () => ({ settings: { maxConcurrentSlots: 6, startState: 'RequirementsAnalysis' }, states: { RequirementsAnalysis: {}, Planning: {} }, scheduler: {} }) } as any,
      { stateForBead: (bead: any) => bead.status === 'ready' ? 'RequirementsAnalysis' : bead.status } as any,
      {
        sortBacklog: async (beads: any[]) => beads
          .map((bead) => ({ ...bead, score: bead.id === 'cerdiwen-resume' ? 100 : 0 }))
          .sort((a: any, b: any) => b.score - a.score)
      } as any,
      beadsPort,
      6
    );

    const assignments = await orchestrator.selectAssignments(1);

    expect(assignments.map(bead => bead.id)).toEqual(['cerdiwen-resume']);
    expect(calls.some(call => call.name === PluginToolName.BD_LIST)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // BEAD C — split-brain immunity: selectAssignments routes from the
  // event-store projection (bead.status / bead.restartTargetState), not from
  // Beads native metadata. Even with GARBAGE metadata the projection wins.
  // ---------------------------------------------------------------------------

  it('(BEAD-C) selectAssignments routes from the event projection even when Beads metadata claims a wrong status', async () => {
    // Arrange: the BeadsPort returns a Bead whose status field is set to the
    // projection-derived value ("Implementation"), but imagine the raw Beads
    // native metadata said "Planning" — the port's normalizeIssueWithProjection
    // already applied the projection before returning. This test proves that
    // selectAssignments + the REAL FlowManager.stateForBead consume ONLY the
    // projected bead.status, never touching any raw Beads metadata.
    //
    // REAL FlowManager wiring: we use new FlowManager() (same as scheduler.test.ts)
    // so that stateForBead is the production implementation, not a hand-written
    // lambda. If FlowManager.stateForBead ever consulted a non-existent raw
    // metadata field (or incorrectly fell back to startState), this test would
    // return stateId == "Planning" instead of "Implementation" and fail.
    const splitBrainBead = fakeBead('cerdiwen-splitbrain', 'Implementation', {
      assigned_to: App.DISPLAY_NAME,
      // The raw Beads metadata WOULD say 'Planning' — but normalizeIssueWithProjection
      // already replaced it with the projection-correct value in bead.status.
      // There is no raw metadata field on the Bead type, proving the isolation.
    });

    const beadsPort: BeadsPort = {
      ready: vi.fn(async () => [splitBrainBead]),
      list: vi.fn(async () => ({ items: [] })),
      getBead: vi.fn(async () => splitBrainBead),
      claim: vi.fn(async ({ id }) => fakeBead(id, 'Implementation')),
      release: vi.fn(async () => {})
    };

    const realConfig = {
      settings: { maxConcurrentSlots: 4, startState: 'Planning' },
      states: {
        Planning: { transitions: { SUCCESS: 'Implementation' }, on: {} },
        Implementation: { transitions: { SUCCESS: 'completed' }, on: {} }
      },
      scheduler: {}
    };

    const orchestrator = new Orchestrator(
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn, getSessionId: () => 'session-x' } as any,
      { load: async () => realConfig } as any,
      // REAL FlowManager — stateForBead reads bead.status and bead.restartTargetState,
      // not any hypothetical raw metadata. A regression that made it consult the
      // wrong field would return 'Planning' (startState) and fail the stateId assertion.
      new FlowManager(),
      { sortBacklog: async (beads: any[]) => beads.map(b => ({ ...b, score: 1 })) } as any,
      beadsPort,
      4
    );

    const assignments = await orchestrator.selectAssignments(2);

    // Must have selected cerdiwen-splitbrain with stateId from the projection
    expect(assignments).toHaveLength(1);
    expect(assignments[0].id).toBe('cerdiwen-splitbrain');
    // stateId must come from the projected bead.status ('Implementation'), NOT
    // from any metadata fallback (which would give 'Planning').
    expect(assignments[0].stateId).toBe('Implementation');
    expect(assignments[0].stateId).not.toBe('Planning');
  });

  it('(BEAD-C) selectAssignments with restartTargetState follows event-projection restart field over any metadata status', async () => {
    // Arrange: a bead that has restartRequested=true and restartTargetState="Planning"
    // (set by the event store projection). Even if bead.status says "Implementation",
    // the restart signal from the projection must take priority.
    //
    // REAL FlowManager wiring: FlowManager.stateForBead checks restartTargetState
    // first (before bead.status). A regression that dropped the restartTargetState
    // priority check would return 'Implementation' instead of 'Planning' and fail.
    const restartBead = fakeBead('cerdiwen-restart', 'Implementation', {
      assigned_to: App.DISPLAY_NAME,
      restartRequested: true,
      restartTargetState: 'Planning'
    });

    const beadsPort: BeadsPort = {
      ready: vi.fn(async () => [restartBead]),
      list: vi.fn(async () => ({ items: [] })),
      getBead: vi.fn(async () => restartBead),
      claim: vi.fn(async ({ id }) => fakeBead(id, 'Planning')),
      release: vi.fn(async () => {})
    };

    const realConfig = {
      settings: { maxConcurrentSlots: 4, startState: 'Planning' },
      states: {
        Planning: { transitions: { SUCCESS: 'Implementation' }, on: {} },
        Implementation: { transitions: { SUCCESS: 'completed' }, on: {} }
      },
      scheduler: {}
    };

    const orchestrator = new Orchestrator(
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn, getSessionId: () => 'session-y' } as any,
      { load: async () => realConfig } as any,
      // REAL FlowManager — stateForBead checks restartRequested + restartTargetState
      // FIRST, before falling back to bead.status. Removing that priority check
      // in FlowManager would make this return 'Implementation' and fail the assertion.
      new FlowManager(),
      { sortBacklog: async (beads: any[]) => beads.map(b => ({ ...b, score: 1 })) } as any,
      beadsPort,
      4
    );

    const assignments = await orchestrator.selectAssignments(2);

    expect(assignments).toHaveLength(1);
    expect(assignments[0].id).toBe('cerdiwen-restart');
    // stateId must be restartTargetState from the event-store projection ('Planning'),
    // NOT bead.status ('Implementation') — restartTargetState wins.
    expect(assignments[0].stateId).toBe('Planning');
    expect(assignments[0].stateId).not.toBe('Implementation');
  });

  it('recovers Orr Else-owned open beads whose event projection is already in a statechart phase', async () => {
    const ready = Array.from({ length: 10 }, (_, index) => fakeBead(`cerdiwen-ready-${index}`, 'ready'));
    const calls: Array<{ name: string; args: any }> = [];
    const beadsPort: BeadsPort = {
      ready: vi.fn(async (args) => {
        calls.push({ name: PluginToolName.BD_READY, args });
        return ready;
      }),
      list: vi.fn(async (args) => {
        calls.push({ name: PluginToolName.BD_LIST, args });
        if (args.status === BeadsIssueStatus.OPEN) {
          return {
            items: [
              fakeBead('cerdiwen-ss9qw', 'Implementation', {
                assigned_to: App.DISPLAY_NAME,
                lastActivity: new Date().toISOString()
              })
            ]
          };
        }
        return { items: [] };
      }),
      getBead: vi.fn(async (id) => fakeBead(id, 'ready')),
      claim: vi.fn(async ({ id }) => fakeBead(id, 'ready')),
      release: vi.fn(async () => {})
    };
    const orchestrator = new Orchestrator(
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn, getSessionId: () => 'session-current' } as any,
      { load: async () => ({ settings: { maxConcurrentSlots: 6, startState: 'RequirementsAnalysis' }, states: { RequirementsAnalysis: {}, Implementation: {} }, scheduler: {} }) } as any,
      { stateForBead: (bead: any) => bead.status === 'ready' ? 'RequirementsAnalysis' : bead.status } as any,
      {
        sortBacklog: async (beads: any[]) => beads
          .map((bead) => ({ ...bead, score: bead.id === 'cerdiwen-ss9qw' ? 100 : 0 }))
          .sort((a: any, b: any) => b.score - a.score)
      } as any,
      beadsPort,
      6
    );

    const assignments = await orchestrator.selectAssignments(1);

    expect(assignments.map(bead => bead.id)).toEqual(['cerdiwen-ss9qw']);
    expect(calls.some(call => call.name === PluginToolName.BD_LIST && call.args.status === BeadsIssueStatus.OPEN)).toBe(true);
  });
});
