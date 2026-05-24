import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/core/Orchestrator.js';
import { BeadsDefaults, BeadsIssueStatus, PluginToolName } from '../src/constants/index.js';

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
                  assigned_to: 'Orr Else',
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
                  assigned_to: 'Orr Else',
                  dependencies: [],
                  changed_files: [],
                  logs: [],
                  retryCount: 0,
                  compactionCount: 0,
                  totalExecutionTimeMs: 0,
                  handovers: {},
                  completedActionIds: [],
                  lastActivity: new Date(0).toISOString(),
                  lease: { owner: 'Orr Else', expiresAt: new Date(Date.now() + 60_000).toISOString() },
                  leaseSessionId: 'session-old'
                },
                {
                  id: 'cerdiwen-leased',
                  title: 'Already leased',
                  status: 'RequirementsAnalysis',
                  assigned_to: 'Orr Else',
                  dependencies: [],
                  changed_files: [],
                  logs: [],
                  retryCount: 0,
                  compactionCount: 0,
                  totalExecutionTimeMs: 0,
                  handovers: {},
                  completedActionIds: [],
                  lastActivity: new Date(0).toISOString(),
                  lease: { owner: 'Orr Else', expiresAt: new Date(Date.now() + 60_000).toISOString() },
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
    expect(calls.find(call => call.name === PluginToolName.BD_LIST)?.args.limit).toBe(
      BeadsDefaults.IN_PROGRESS_RECOVERY_SCAN_MULTIPLIER * 6
    );
  });
});
