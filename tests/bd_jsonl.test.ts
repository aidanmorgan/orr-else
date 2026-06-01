import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { createBdPlugin, parseFlatListOutput, parseReadyPlainOutput } from '../src/plugins/bd.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { App, BeadsDefaults, DomainEventName, StateChartToolDefaults, ToolDefaults } from '../src/constants/index.js';

const execaMock = vi.hoisted(() => {
  function bdOutput(args: string[], options: any) {
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
    if (args.includes('update')) return '[{"id":"bd-1","title":"Updated","status":"in_progress","priority":1}]';
    if (args.includes('show')) return '[{"id":"bd-1","title":"Shown","status":"in_progress","priority":1}]';
    return '{}';
  }

  return vi.fn(async (bin: string, args: string[], options: any = {}) => {
    if (bin !== 'bd') throw new Error(`unexpected binary: ${bin}`);
    return {
      stdout: bdOutput(args, options),
      stderr: ''
    };
  });
});

vi.mock('execa', () => {
  return { execa: execaMock };
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
    vi.mocked(execa).mockClear();
  });

  it('exports JSONL without adding JSON output mode', async () => {
    const result = await tool('bd_export_jsonl').execute({ includeMemories: true });
    expect(result).toBe('{"id":"bd-1","title":"Exported"}');

    const call = vi.mocked(execa).mock.calls[0];
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

    const call = vi.mocked(execa).mock.calls[0];
    expect(call[0]).toBe('bd');
    expect(call[1]).toContain('import');
    expect(call[1]).toContain('-');
    expect(call[1]).toContain('--dedup');
    expect(call[1]).toContain('--json');
    expect(call[2]?.input).toBe('{"title":"Imported"}\n');
  });

  it('exports project issues JSONL after mutating Beads commands', async () => {
    const result = await tool('bd_claim').execute({ id: 'bd-1' });

    expect(result.id).toBe('bd-1');
    const calls = vi.mocked(execa).mock.calls;
    expect(calls[0][1]).toEqual(expect.arrayContaining(['update', 'bd-1', '--claim', '--json']));

    const exportCall = calls.find(call => call[1].includes('export') && call[1].includes('--output'));
    expect(exportCall).toBeDefined();
    expect(exportCall?.[1]).not.toContain('--json');
    expect(exportCall?.[1].some(arg => arg.endsWith('.beads/issues.jsonl'))).toBe(true);
  });

  it('bounds ready-work reads with an explicit limit', async () => {
    const result = await tool('bd_ready').execute({ limit: 7 });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('bd-1');
    expect(result[0].priority).toBe(1);
    expect(result[0].assigned_to).toBe('Aidan Morgan');

    const call = vi.mocked(execa).mock.calls[0];
    expect(call[1]).toContain('ready');
    expect(call[1]).toContain('--limit');
    expect(call[1]).toContain('7');
    expect(call[1]).toContain('--plain');
    expect(call[1]).not.toContain('--json');
  });

  it('serializes concurrent bd CLI calls through a project lock', async () => {
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const readyOutput = `
📋 Ready work (1 issues with no active blockers):

1. [● P1] [task] bd-1: Ready
   Assignee: Aidan Morgan
`;
    const delayedReady = async (bin: string, _args: string[], _options: any = {}) => {
      if (bin !== 'bd') throw new Error(`unexpected binary: ${bin}`);
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      await new Promise(resolve => setTimeout(resolve, 25));
      activeCalls -= 1;
      return {
        stdout: readyOutput,
        stderr: ''
      };
    };
    vi.mocked(execa)
      .mockImplementationOnce(delayedReady)
      .mockImplementationOnce(delayedReady);

    await Promise.all([
      tool('bd_ready').execute({ limit: 1 }),
      tool('bd_ready').execute({ limit: 1 })
    ]);

    expect(maxActiveCalls).toBe(1);
  });

  it('keeps abandoned bd lock recovery below the wrapped tool timeout', () => {
    const worstCaseLockWaitMs = BeadsDefaults.CLI_LOCK_RETRIES * BeadsDefaults.CLI_LOCK_RETRY_MAX_MS;

    expect(BeadsDefaults.CLI_LOCK_STALE_MS).toBeLessThan(ToolDefaults.WRAPPER_TIMEOUT_MS);
    expect(worstCaseLockWaitMs + BeadsDefaults.CLI_TIMEOUT_MS).toBeLessThan(ToolDefaults.WRAPPER_TIMEOUT_MS);
  });

  it('does not pass Orr Else state names to bd --status', async () => {
    const result = await tool('bd_list').execute({ status: 'RequirementsAnalysis', limit: 5 });

    expect(result.filters).toEqual({ status: undefined, stateId: 'RequirementsAnalysis' });
    const call = vi.mocked(execa).mock.calls[0];
    expect(call[1]).toContain('list');
    expect(call[1]).not.toContain('--status');
    expect(call[1]).toContain('--limit');
    expect(call[1]).toContain('15');
  });

  it('passes native Beads statuses to bd --status', async () => {
    const result = await tool('bd_list').execute({ status: 'in_progress', limit: 5 });

    expect(result.filters).toEqual({ status: 'in_progress', stateId: undefined });
    expect(result.items[0].priority).toBe(1);
    const call = vi.mocked(execa).mock.calls[0];
    expect(call[1]).toContain('--status');
    expect(call[1]).toContain('in_progress');
  });

  it('uses fast native records for default bd_list reads', async () => {
    const listPlugin = createBdPlugin({
      projectBeads: async () => {
        throw new Error('projectBeads should not run for unfiltered bd_list');
      }
    } as any);
    const listTool = listPlugin.tools.find(candidate => candidate.name === 'bd_list');
    if (!listTool) throw new Error('missing bd_list');

    const result = await listTool.execute({ status: 'open', limit: 5 });

    expect(result.items[0]).toMatchObject({
      id: 'bd-1',
      title: 'Ready',
      status: 'ready',
      priority: 1,
      assigned_to: 'Aidan Morgan'
    });
  });

  it('keeps projection scheduling fields in state-filtered compact bd_list records', async () => {
    const projected = {
      status: 'Planning',
      assigned_to: App.DISPLAY_NAME,
      retryCount: 2,
      compactionCount: 1,
      totalExecutionTimeMs: 1234,
      lastActivity: '2026-01-01T00:00:00.000Z',
      restartRequested: true,
      restartKind: 'harness',
      restartEvent: 'HARNESS_RESTART',
      restartFromState: 'Planning',
      restartTargetState: 'Planning'
    };
    const listPlugin = createBdPlugin({
      projectBeads: async () => new Map([['bd-1', projected]])
    } as any);
    const listTool = listPlugin.tools.find(candidate => candidate.name === 'bd_list');
    if (!listTool) throw new Error('missing bd_list');

    const result = await listTool.execute({ status: 'Planning', limit: 5 });

    expect(result.items[0]).toMatchObject(projected);
    expect(result.items[0].priority).toBe(1);
  });

  it('can include projection metadata in native status bd_list records', async () => {
    const projected = {
      status: 'Planning',
      assigned_to: App.DISPLAY_NAME,
      lease: { owner: App.DISPLAY_NAME, expiresAt: '2026-01-01T00:00:00.000Z' },
      leaseSessionId: 'previous-session'
    };
    const listPlugin = createBdPlugin({
      projectBeads: async () => new Map([['bd-1', projected]])
    } as any);
    const listTool = listPlugin.tools.find(candidate => candidate.name === 'bd_list');
    if (!listTool) throw new Error('missing bd_list');

    const result = await listTool.execute({ status: 'in_progress', limit: 5, includeProjection: true });

    expect(result.filters).toEqual({ status: 'in_progress', stateId: undefined });
    expect(result.items[0]).toMatchObject({
      id: 'bd-1',
      status: 'Planning',
      assigned_to: App.DISPLAY_NAME,
      lease: projected.lease,
      leaseSessionId: 'previous-session'
    });
  });

  it('uses fast native records for default bd_get_bead reads', async () => {
    const getPlugin = createBdPlugin({
      projectBead: async () => {
        throw new Error('projectBead should not run for default bd_get_bead');
      }
    } as any);
    const getTool = getPlugin.tools.find(candidate => candidate.name === 'bd_get_bead');
    if (!getTool) throw new Error('missing bd_get_bead');

    const result = await getTool.execute({ id: 'bd-1' });

    expect(result).toMatchObject({
      id: 'bd-1',
      title: 'Shown',
      status: 'in_progress',
      priority: 1
    });
  });

  it('lets native closed status override stale projected state metadata', async () => {
    vi.mocked(execa).mockImplementationOnce(async (bin: string, args: string[], options: any = {}) => {
      if (bin !== 'bd') throw new Error(`unexpected binary: ${bin}`);
      expect(args).toContain('show');
      expect(options.maxBuffer).toBeGreaterThan(1024 * 1024);
      return {
        stdout: '[{"id":"bd-1","title":"Closed","status":"closed","priority":1}]',
        stderr: ''
      };
    });
    const getPlugin = createBdPlugin({
      projectBead: async () => ({
        status: 'RequirementsAnalysis',
        assigned_to: App.DISPLAY_NAME
      })
    } as any);
    const getTool = getPlugin.tools.find(candidate => candidate.name === 'bd_get_bead');
    if (!getTool) throw new Error('missing bd_get_bead');

    const result = await getTool.execute({ id: 'bd-1', includeDetails: true });

    expect(result).toMatchObject({
      id: 'bd-1',
      title: 'Closed',
      status: 'completed',
      priority: 1,
      assigned_to: App.DISPLAY_NAME
    });
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
    expect(compact.recentCompletedActionIds).toHaveLength(StateChartToolDefaults.RECENT_COMPLETED_ACTIONS);
    expect(compact.recentCheckpoints[0].summary.length).toBeLessThan(600);

    const detailed: any = await chartTool.execute({ id: 'bd-1', includeDetails: true });
    expect(detailed.checkedItems).toEqual({ a: { checked: true }, b: { checked: true } });
    expect(detailed.completedActionIdsTruncated).toBe(25 > StateChartToolDefaults.DETAIL_COMPLETED_ACTIONS);
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
    expect(detailed.completedActionIds).toHaveLength(StateChartToolDefaults.DETAIL_COMPLETED_ACTIONS);
    expect(detailed.completedActionIdsTruncated).toBe(true);
    expect(Object.keys(detailed.checkedItems)).toHaveLength(StateChartToolDefaults.DETAIL_CHECKED_ITEMS);
    expect(detailed.checkedItemsTruncated).toBe(true);
    expect(detailed.addedChecklistItems).toHaveLength(StateChartToolDefaults.DETAIL_ADDED_CHECKLIST_ITEMS);
    expect(detailed.checkpoints).toHaveLength(StateChartToolDefaults.DETAIL_CHECKPOINTS);
    expect(detailed.transitions).toHaveLength(StateChartToolDefaults.DETAIL_TRANSITIONS);
    expect(detailed.transitions[0].summary.length).toBeLessThan(600);
  });

  // --- BD_RELEASE missing-bead regression tests (pi-experiment-59au) ---

  it('BD_RELEASE does not throw and records BEAD_RELEASED + BEAD_TOMBSTONED when the bead no longer exists', async () => {
    // The fix: when getIssue throws "Bead <id> not found" during BD_RELEASE.execute,
    // the catch block records BEAD_RELEASED (tombstoned:true) and BEAD_TOMBSTONED,
    // then returns { id, tombstoned: true } instead of rethrowing.
    //
    // Pre-fix failure reason: BD_RELEASE had no try/catch around the getIssue call.
    // A missing bead caused getIssue to throw, which propagated out of execute —
    // meaning (a) execute threw instead of returning, (b) neither BEAD_RELEASED nor
    // BEAD_TOMBSTONED was recorded, and (c) the supervisor slot was NOT freed.
    const missingBeadId = 'bd-missing-59au';
    // Make execa return an empty array for 'show' so getIssue throws "Bead not found"
    vi.mocked(execa).mockImplementationOnce(async (bin: string, args: string[], _options: any = {}) => {
      if (bin !== 'bd') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('show')) {
        return { stdout: '[]', stderr: '' };
      }
      throw new Error('unexpected call during missing-bead test');
    });

    const recordedEvents: Array<{ event: string; data: any }> = [];
    const mockEventStore = {
      record: vi.fn(async (event: string, data: any) => {
        recordedEvents.push({ event, data });
      }),
      projectBead: vi.fn(async () => ({})),
      projectBeads: vi.fn(async () => new Map())
    } as any;

    const releaseTool = createBdPlugin(mockEventStore).tools.find(t => t.name === 'bd_release');
    if (!releaseTool) throw new Error('missing bd_release tool');

    // Must NOT throw — the fix catches the missing-bead error
    const result = await releaseTool.execute({ id: missingBeadId }) as any;

    // Returns the tombstone sentinel
    expect(result).toEqual({ id: missingBeadId, tombstoned: true });

    // Must record BEAD_RELEASED (with tombstoned:true) then BEAD_TOMBSTONED
    expect(recordedEvents).toContainEqual({
      event: DomainEventName.BEAD_RELEASED,
      data: expect.objectContaining({ beadId: missingBeadId, tombstoned: true })
    });
    expect(recordedEvents).toContainEqual({
      event: DomainEventName.BEAD_TOMBSTONED,
      data: expect.objectContaining({ beadId: missingBeadId })
    });

    // BEAD_RELEASED must appear before BEAD_TOMBSTONED (event ordering contract)
    const releasedIndex = recordedEvents.findIndex(e => e.event === DomainEventName.BEAD_RELEASED);
    const tombstonedIndex = recordedEvents.findIndex(e => e.event === DomainEventName.BEAD_TOMBSTONED);
    expect(releasedIndex).toBeLessThan(tombstonedIndex);
  });

  it('BD_RELEASE records only BEAD_RELEASED (no tombstone) for a bead that still exists', async () => {
    // Confirm the pre-existing happy path is unaffected by the fix.
    // Pre-fix failure reason: this test would still pass without the fix because
    // the normal (bead-present) path was unchanged — so this test guards that
    // the fix does not regress the normal release flow.
    const existingBeadId = 'bd-existing-59au';
    // The default execa mock already handles 'show' returning a valid record and
    // 'update' returning an updated record, but we need a custom show that returns
    // the right ID.  Override for this test.
    vi.mocked(execa).mockImplementation(async (bin: string, args: string[], _options: any = {}) => {
      if (bin !== 'bd') throw new Error(`unexpected binary: ${bin}`);
      if (args.includes('show')) {
        return {
          stdout: `[{"id":"${existingBeadId}","title":"Existing","status":"open","priority":1}]`,
          stderr: ''
        };
      }
      if (args.includes('update')) {
        return {
          stdout: `[{"id":"${existingBeadId}","title":"Existing","status":"open","priority":1}]`,
          stderr: ''
        };
      }
      if (args.includes('export')) {
        return { stdout: `{"id":"${existingBeadId}","title":"Existing"}`, stderr: '' };
      }
      return { stdout: '{}', stderr: '' };
    });

    const recordedEvents: Array<{ event: string; data: any }> = [];
    const mockEventStore = {
      record: vi.fn(async (event: string, data: any) => {
        recordedEvents.push({ event, data });
      }),
      projectBead: vi.fn(async () => ({})),
      projectBeads: vi.fn(async () => new Map())
    } as any;

    const releaseTool = createBdPlugin(mockEventStore).tools.find(t => t.name === 'bd_release');
    if (!releaseTool) throw new Error('missing bd_release tool');

    const result = await releaseTool.execute({ id: existingBeadId }) as any;

    // Returns a normal Bead record (not a tombstone sentinel)
    expect(result.id).toBe(existingBeadId);
    expect(result.tombstoned).toBeUndefined();

    // Records BEAD_RELEASED without a tombstone flag
    expect(recordedEvents).toContainEqual({
      event: DomainEventName.BEAD_RELEASED,
      data: expect.objectContaining({ beadId: existingBeadId })
    });
    const releasedEvent = recordedEvents.find(e => e.event === DomainEventName.BEAD_RELEASED);
    expect(releasedEvent?.data?.tombstoned).toBeUndefined();

    // Must NOT record BEAD_TOMBSTONED
    expect(recordedEvents.some(e => e.event === DomainEventName.BEAD_TOMBSTONED)).toBe(false);

    vi.mocked(execa).mockClear();
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
      priority: 1,
      status: 'open',
      assignee: 'Aidan Morgan'
    }]);

    expect(parseFlatListOutput('● cerdiwen-p44u1 [● P1] [task] - Normalize crypto shapes (blocked by: cerdiwen-d13pp, blocks: cerdiwen-0nerb)', 'in_progress')).toEqual([{
      id: 'cerdiwen-p44u1',
      title: 'Normalize crypto shapes',
      issue_type: 'task',
      priority: 1,
      status: 'in_progress',
      assignee: undefined
    }]);
  });
});
