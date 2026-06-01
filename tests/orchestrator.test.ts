import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/core/Orchestrator.js';
import { App, BeadsDefaults, BeadsIssueStatus, PluginToolName } from '../src/constants/index.js';

describe('Orchestrator', () => {
  it('resumes Orr Else-owned in-progress beads without a current-session active lease when ready backlog is short', async () => {
    const calls: Array<{ name: string; args: any }> = [];
    const bdPlugin = {
      tools: [
        {
          name: PluginToolName.BD_READY,
          execute: async (args: any) => {
            calls.push({ name: PluginToolName.BD_READY, args });
            return [];
          }
        },
        {
          name: PluginToolName.BD_LIST,
          execute: async (args: any) => {
            calls.push({ name: PluginToolName.BD_LIST, args });
            return {
              items: [
                {
                  id: 'cerdiwen-resume',
                  title: 'Resume me',
                  status: 'RequirementsAnalysis',
                  assigned_to: App.DISPLAY_NAME,
                  dependencies: [],
                  changed_files: [],
                  logs: [],
                  retryCount: 0,
                  compactionCount: 0,
                  totalExecutionTimeMs: 0,
                  handovers: {},
                  completedActionIds: [],
                  lastActivity: new Date(0).toISOString()
                },
                {
                  id: 'cerdiwen-old-session-lease',
                  title: 'Resume old session lease',
                  status: 'RequirementsAnalysis',
                  assigned_to: App.DISPLAY_NAME,
                  dependencies: [],
                  changed_files: [],
                  logs: [],
                  retryCount: 0,
                  compactionCount: 0,
                  totalExecutionTimeMs: 0,
                  handovers: {},
                  completedActionIds: [],
                  lastActivity: new Date(0).toISOString(),
                  lease: { owner: App.DISPLAY_NAME, expiresAt: new Date(Date.now() + 60_000).toISOString() },
                  leaseSessionId: 'session-old'
                },
                {
                  id: 'cerdiwen-leased',
                  title: 'Already leased',
                  status: 'RequirementsAnalysis',
                  assigned_to: App.DISPLAY_NAME,
                  dependencies: [],
                  changed_files: [],
                  logs: [],
                  retryCount: 0,
                  compactionCount: 0,
                  totalExecutionTimeMs: 0,
                  handovers: {},
                  completedActionIds: [],
                  lastActivity: new Date(0).toISOString(),
                  lease: { owner: App.DISPLAY_NAME, expiresAt: new Date(Date.now() + 60_000).toISOString() },
                  leaseSessionId: 'session-current'
                }
              ]
            };
          }
        }
      ]
    };
    const orchestrator = new Orchestrator(
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn, getSessionId: () => 'session-current' } as any,
      { load: async () => ({ settings: { maxConcurrentSlots: 6 }, states: { RequirementsAnalysis: {} }, scheduler: {} }) } as any,
      { stateForBead: (bead: any) => bead.status } as any,
      { sortBacklog: async (beads: any[]) => beads.map((bead, index) => ({ ...bead, score: index })) } as any,
      bdPlugin as any,
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
    const ready = Array.from({ length: 10 }, (_, index) => ({
      id: `cerdiwen-ready-${index}`,
      title: `Ready ${index}`,
      status: 'ready',
      dependencies: [],
      changed_files: [],
      logs: [],
      retryCount: 0,
      compactionCount: 0,
      totalExecutionTimeMs: 0,
      handovers: {},
      completedActionIds: [],
      lastActivity: new Date(0).toISOString()
    }));
    const calls: Array<{ name: string; args: any }> = [];
    const bdPlugin = {
      tools: [
        {
          name: PluginToolName.BD_READY,
          execute: async (args: any) => {
            calls.push({ name: PluginToolName.BD_READY, args });
            return ready;
          }
        },
        {
          name: PluginToolName.BD_LIST,
          execute: async (args: any) => {
            calls.push({ name: PluginToolName.BD_LIST, args });
            return {
              items: [
                {
                  id: 'cerdiwen-resume',
                  title: 'Resume me',
                  status: 'Planning',
                  assigned_to: App.DISPLAY_NAME,
                  dependencies: [],
                  changed_files: [],
                  logs: [],
                  retryCount: 0,
                  compactionCount: 0,
                  totalExecutionTimeMs: 0,
                  handovers: {},
                  completedActionIds: [],
                  lastActivity: new Date(0).toISOString()
                }
              ]
            };
          }
        }
      ]
    };
    const orchestrator = new Orchestrator(
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn, getSessionId: () => 'session-current' } as any,
      { load: async () => ({ settings: { maxConcurrentSlots: 6, startState: 'RequirementsAnalysis' }, states: { RequirementsAnalysis: {}, Planning: {} }, scheduler: {} }) } as any,
      { stateForBead: (bead: any) => bead.status === 'ready' ? 'RequirementsAnalysis' : bead.status } as any,
      {
        sortBacklog: async (beads: any[]) => beads
          .map((bead) => ({ ...bead, score: bead.id === 'cerdiwen-resume' ? 100 : 0 }))
          .sort((a, b) => b.score - a.score)
      } as any,
      bdPlugin as any,
      6
    );

    const assignments = await orchestrator.selectAssignments(1);

    expect(assignments.map(bead => bead.id)).toEqual(['cerdiwen-resume']);
    expect(calls.some(call => call.name === PluginToolName.BD_LIST)).toBe(true);
  });

  it('recovers Orr Else-owned open beads whose event projection is already in a statechart phase', async () => {
    const ready = Array.from({ length: 10 }, (_, index) => ({
      id: `cerdiwen-ready-${index}`,
      title: `Ready ${index}`,
      status: 'ready',
      dependencies: [],
      changed_files: [],
      logs: [],
      retryCount: 0,
      compactionCount: 0,
      totalExecutionTimeMs: 0,
      handovers: {},
      completedActionIds: [],
      lastActivity: new Date(0).toISOString()
    }));
    const calls: Array<{ name: string; args: any }> = [];
    const bdPlugin = {
      tools: [
        {
          name: PluginToolName.BD_READY,
          execute: async (args: any) => {
            calls.push({ name: PluginToolName.BD_READY, args });
            return ready;
          }
        },
        {
          name: PluginToolName.BD_LIST,
          execute: async (args: any) => {
            calls.push({ name: PluginToolName.BD_LIST, args });
            if (args.status === BeadsIssueStatus.OPEN) {
              return {
                items: [
                  {
                    id: 'cerdiwen-ss9qw',
                    title: 'Projected implementation work',
                    status: 'Implementation',
                    assigned_to: App.DISPLAY_NAME,
                    dependencies: [],
                    changed_files: [],
                    logs: [],
                    retryCount: 0,
                    compactionCount: 0,
                    totalExecutionTimeMs: 0,
                    handovers: {},
                    completedActionIds: [],
                    lastActivity: new Date().toISOString()
                  }
                ]
              };
            }
            return { items: [] };
          }
        }
      ]
    };
    const orchestrator = new Orchestrator(
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn, getSessionId: () => 'session-current' } as any,
      { load: async () => ({ settings: { maxConcurrentSlots: 6, startState: 'RequirementsAnalysis' }, states: { RequirementsAnalysis: {}, Implementation: {} }, scheduler: {} }) } as any,
      { stateForBead: (bead: any) => bead.status === 'ready' ? 'RequirementsAnalysis' : bead.status } as any,
      {
        sortBacklog: async (beads: any[]) => beads
          .map((bead) => ({ ...bead, score: bead.id === 'cerdiwen-ss9qw' ? 100 : 0 }))
          .sort((a, b) => b.score - a.score)
      } as any,
      bdPlugin as any,
      6
    );

    const assignments = await orchestrator.selectAssignments(1);

    expect(assignments.map(bead => bead.id)).toEqual(['cerdiwen-ss9qw']);
    expect(calls.some(call => call.name === PluginToolName.BD_LIST && call.args.status === BeadsIssueStatus.OPEN)).toBe(true);
  });
});
