import { describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../src/core/Orchestrator.js';
import { App, BeadsDefaults, BeadsIssueStatus, PluginToolName } from '../src/constants/index.js';
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
