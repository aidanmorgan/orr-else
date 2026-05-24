import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, spawn } from 'child_process';
import { createBdPlugin, parseFlatListOutput, parseReadyPlainOutput } from '../src/plugins/bd.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';

const { promisifyCustom } = vi.hoisted(() => ({
  promisifyCustom: Symbol.for('nodejs.util.promisify.custom')
}));

vi.mock('child_process', () => {
  function bdOutput(bin: string, args: string[], options: any) {
    if (bin !== 'bd') throw new Error(`unexpected binary: ${bin}`);
    expect(options.maxBuffer).toBeGreaterThan(1024 * 1024);
    if (args.includes('ready')) return `
📋 Ready work (1 issues with no active blockers):

1. [● P1] [task] bd-1: Ready
   Assignee: Aidan Morgan
`;
    if (args.includes('list')) return '○ bd-1 [● P1] [task] @Aidan Morgan - Ready\n';
    if (args.includes('export') && args.includes('--all')) return `${'x'.repeat(210000)}\n`;
    if (args.includes('export')) return '{"id":"bd-1","title":"Exported"}\n';
    if (args.includes('import')) {
      expect(options.input).toBe('{"title":"Imported"}\n');
      return '{"created":1,"updated":0}';
    }
    return '{}';
  }

  return {
    execFile: Object.assign(
      vi.fn((bin: string, args: string[], options: any, callback: Function) => {
        callback(null, bdOutput(bin, args, options), '');
      }),
      {
        [promisifyCustom]: vi.fn(async (bin: string, args: string[], options: any) => ({
          stdout: bdOutput(bin, args, options),
          stderr: ''
        }))
      }
    ),
    spawn: vi.fn((bin: string, args: string[]) => {
      const handlers: Record<string, Function> = {};
      const stdoutHandlers: Record<string, Function> = {};
      const stderrHandlers: Record<string, Function> = {};
      const output = bdOutput(bin, args, { maxBuffer: 64 * 1024 * 1024, input: '{"title":"Imported"}\n' });
      const child = {
        stdout: {
          on: vi.fn((event: string, handler: Function) => {
            stdoutHandlers[event] = handler;
            return child.stdout;
          })
        },
        stderr: {
          on: vi.fn((event: string, handler: Function) => {
            stderrHandlers[event] = handler;
            return child.stderr;
          })
        },
        stdin: {
          end: vi.fn((input: string) => {
            expect(input).toBe('{"title":"Imported"}\n');
            queueMicrotask(() => {
              stdoutHandlers.data?.(Buffer.from(output));
              stderrHandlers.data?.(Buffer.from(''));
              handlers.close?.(0);
            });
          })
        },
        on: vi.fn((event: string, handler: Function) => {
          handlers[event] = handler;
          return child;
        }),
        kill: vi.fn()
      };
      return child;
    })
  };
});

let bdPlugin: ReturnType<typeof createBdPlugin>;

function tool(name: string) {
  const found = bdPlugin.tools.find(candidate => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe('Beads JSONL compatibility tools', () => {
  beforeEach(() => {
    bdPlugin = createBdPlugin(new EventStore(new ConfigLoader()));
    vi.mocked(execFile).mockClear();
    vi.mocked((execFile as any)[promisifyCustom]).mockClear();
    vi.mocked(spawn).mockClear();
  });

  it('exports JSONL without adding JSON output mode', async () => {
    const result = await tool('bd_export_jsonl').execute({ includeMemories: true });
    expect(result).toBe('{"id":"bd-1","title":"Exported"}');

    const call = vi.mocked((execFile as any)[promisifyCustom]).mock.calls[0];
    expect(call[0]).toBe('bd');
    expect(call[1]).toContain('export');
    expect(call[1]).toContain('--include-memories');
    expect(call[1]).not.toContain('--json');
  });

  it('bounds large inline JSONL exports and asks callers to use outputPath', async () => {
    const result = await tool('bd_export_jsonl').execute({ all: true });

    expect(result.message).toContain('too large to return inline');
    expect(result.bytes).toBe(210000);
    expect(result.preview.length).toBe(4096);
  });

  it('imports JSONL through stdin with bd import upsert semantics', async () => {
    const result = await tool('bd_import_jsonl').execute({ jsonl: '{"title":"Imported"}\n', dedup: true });
    expect(result).toEqual({ created: 1, updated: 0 });

    const call = vi.mocked(spawn).mock.calls[0];
    expect(call[0]).toBe('bd');
    expect(call[1]).toContain('import');
    expect(call[1]).toContain('-');
    expect(call[1]).toContain('--dedup');
    expect(call[1]).toContain('--json');
  });

  it('bounds ready-work reads with an explicit limit', async () => {
    const result = await tool('bd_ready').execute({ limit: 7 });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('bd-1');
    expect(result[0].assigned_to).toBe('Aidan Morgan');

    const call = vi.mocked((execFile as any)[promisifyCustom]).mock.calls[0];
    expect(call[1]).toContain('ready');
    expect(call[1]).toContain('--limit');
    expect(call[1]).toContain('7');
    expect(call[1]).toContain('--plain');
    expect(call[1]).not.toContain('--json');
  });

  it('does not pass Orr Else state names to bd --status', async () => {
    const result = await tool('bd_list').execute({ status: 'RequirementsAnalysis', limit: 5 });

    expect(result.filters).toEqual({ status: undefined, stateId: 'RequirementsAnalysis' });
    const call = vi.mocked((execFile as any)[promisifyCustom]).mock.calls[0];
    expect(call[1]).toContain('list');
    expect(call[1]).not.toContain('--status');
    expect(call[1]).toContain('--limit');
    expect(call[1]).toContain('15');
  });

  it('passes native Beads statuses to bd --status', async () => {
    const result = await tool('bd_list').execute({ status: 'in_progress', limit: 5 });

    expect(result.filters).toEqual({ status: 'in_progress', stateId: undefined });
    const call = vi.mocked((execFile as any)[promisifyCustom]).mock.calls[0];
    expect(call[1]).toContain('--status');
    expect(call[1]).toContain('in_progress');
  });

  it('returns compact statechart projections by default', async () => {
    const chartPlugin = createBdPlugin({
      projectBeadStateChart: async () => ({
        beadId: 'bd-1',
        currentState: 'Planning',
        handovers: { Planning: 'ready' },
        completedActionIds: Array.from({ length: 25 }, (_, index) => `action-${index}`),
        checkedItems: { a: { checked: true }, b: { checked: true } },
        addedChecklistItems: [{ text: 'dynamic', mandatory: true, timestamp: '2026-01-01T00:00:00.000Z' }],
        checkpoints: [{
          actionId: 'a1',
          summary: 'x'.repeat(1000),
          evidence: 'evidence',
          timestamp: '2026-01-01T00:00:00.000Z',
          sessionId: 's1'
        }],
        transitions: [{
          eventId: 'e1',
          sessionId: 's1',
          timestamp: '2026-01-01T00:00:00.000Z',
          fromState: 'Planning',
          toState: 'Implementation',
          transitionEvent: 'SUCCESS',
          actionId: 'a1',
          summary: 'transition',
          evidence: 'evidence'
        }]
      })
    } as any);
    const chartTool = chartPlugin.tools.find(candidate => candidate.name === 'bd_get_state_chart');
    if (!chartTool) throw new Error('missing bd_get_state_chart');

    const compact: any = await chartTool.execute({ id: 'bd-1' });
    expect(compact.checkedItems).toBeUndefined();
    expect(compact.checkedItemCount).toBe(2);
    expect(compact.completedActionCount).toBe(25);
    expect(compact.recentCompletedActionIds).toHaveLength(20);
    expect(compact.recentCheckpoints[0].summary.length).toBeLessThan(600);

    const detailed: any = await chartTool.execute({ id: 'bd-1', includeDetails: true });
    expect(detailed.checkedItems).toEqual({ a: { checked: true }, b: { checked: true } });
    expect(detailed.completedActionIdsTruncated).toBe(false);
  });

  it('bounds detailed statechart projections', async () => {
    const checkedItems = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [`item-${index}`, { checked: true, evidence: `evidence-${index}` }])
    );
    const chartPlugin = createBdPlugin({
      projectBeadStateChart: async () => ({
        beadId: 'bd-1',
        currentState: 'Planning',
        handovers: {},
        completedActionIds: Array.from({ length: 120 }, (_, index) => `action-${index}`),
        checkedItems,
        addedChecklistItems: Array.from({ length: 70 }, (_, index) => ({
          text: `dynamic-${index}`,
          mandatory: true,
          timestamp: '2026-01-01T00:00:00.000Z'
        })),
        checkpoints: Array.from({ length: 30 }, (_, index) => ({
          actionId: `checkpoint-${index}`,
          summary: 's'.repeat(1000),
          evidence: 'e'.repeat(1000),
          timestamp: '2026-01-01T00:00:00.000Z',
          sessionId: 's1'
        })),
        transitions: Array.from({ length: 50 }, (_, index) => ({
          eventId: `event-${index}`,
          sessionId: 's1',
          timestamp: '2026-01-01T00:00:00.000Z',
          fromState: 'Planning',
          toState: 'Implementation',
          transitionEvent: 'SUCCESS',
          actionId: `action-${index}`,
          summary: 'transition'.repeat(100),
          evidence: 'evidence'.repeat(100)
        }))
      })
    } as any);
    const chartTool = chartPlugin.tools.find(candidate => candidate.name === 'bd_get_state_chart');
    if (!chartTool) throw new Error('missing bd_get_state_chart');

    const detailed: any = await chartTool.execute({ id: 'bd-1', includeDetails: true });
    expect(detailed.completedActionCount).toBe(120);
    expect(detailed.completedActionIds).toHaveLength(100);
    expect(detailed.completedActionIdsTruncated).toBe(true);
    expect(Object.keys(detailed.checkedItems)).toHaveLength(100);
    expect(detailed.checkedItemsTruncated).toBe(true);
    expect(detailed.addedChecklistItems).toHaveLength(50);
    expect(detailed.checkpoints).toHaveLength(20);
    expect(detailed.transitions).toHaveLength(40);
    expect(detailed.transitions[0].summary.length).toBeLessThan(600);
  });

  it('parses compact ready and list output without loading full JSON records', () => {
    expect(parseReadyPlainOutput(`
📋 Ready work (1 issues with no active blockers):

1. [● P1] [bug] cerdiwen-l7xr3: Fix compiler pytest collection blockers
   Assignee: Aidan Morgan
`)).toEqual([{
      id: 'cerdiwen-l7xr3',
      title: 'Fix compiler pytest collection blockers',
      issue_type: 'bug',
      status: 'open',
      assignee: 'Aidan Morgan'
    }]);

    expect(parseFlatListOutput('● cerdiwen-p44u1 [● P1] [task] - Normalize crypto shapes (blocked by: cerdiwen-d13pp, blocks: cerdiwen-0nerb)', 'in_progress')).toEqual([{
      id: 'cerdiwen-p44u1',
      title: 'Normalize crypto shapes',
      issue_type: 'task',
      status: 'in_progress',
      assignee: undefined
    }]);
  });
});
