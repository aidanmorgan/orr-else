/**
 * pi-experiment-6q0y.22 — query_harness_events progressive-disclosure tool,
 * tested against the REAL registered tool via fakePi/orrElseExtension.
 *
 * Load-bearing assertions:
 *   (A) Tool is registered with the correct name and parameter schema.
 *   (B) Summary mode: returns counts + latestEvent metadata, no full payloads,
 *       under 24 KB for a 10,000-event fixture (AC4).
 *   (C) Detail mode: capped at 100 events, strings truncated to 300 chars (AC3).
 *   (D) Filters: beadId, eventTypes, stateId, actionId, time range, cursor (AC1).
 *   (E) Fail-closed: bad inputs return rejection (invalid time, etc.).
 *   (F) Malformed records counted as skippedCount, never inlined (AC5).
 *
 * NOTE: wrapPluginTool records a TOOL_INVOCATION_STARTED event before executing
 * the tool and TOOL_INVOCATION_SUCCEEDED after. Tests that count events therefore
 * use eventTypes filters targeting fixture event types only, so harness
 * observability events do not skew the count.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuiltInToolName } from '../src/constants/domain.js';
import { EnvVars, PiEventName } from '../src/constants/infra.js';
import { Logger } from '../src/core/Logger.js';
import orrElseExtension from '../src/extension.js';
import { writeFixtureEvent } from './support/TestEventStore.js';

// ─── Minimal harness fixture ──────────────────────────────────────────────────

const HARNESS_YAML = `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: ''
  defaultModel: gpt-5.5
  startState: Planning
  worktreePolicy:
    default: always
scheduler:
  weights:
    waitTime: 1
    executionTime: 1
    progress: 1
    penalty: 1
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity:
      role: Planner
      expertise: Planning
      constraints: []
    baseInstructions: Plan.
    actions:
      - id: a1
        type: prompt
    transitions:
      SUCCESS: completed
      FAILURE: Planning
`;

// ─── Fake Pi harness ──────────────────────────────────────────────────────────

function fakePi() {
  const tools: any[] = [];
  const callbacks: Record<string, Function> = {};
  return {
    tools,
    callbacks,
    pi: {
      on: (name: string, cb: Function) => { callbacks[name] = cb; },
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      setThinkingLevel: () => {},
      setModel: async () => true,
      sendUserMessage: () => {}
    } as any
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('pi-experiment-6q0y.22: query_harness_events progressive-disclosure tool', () => {
  let tempRoot: string;
  let prevProjectRoot: string | undefined;
  let prevWorktree: string | undefined;
  let previousCwd: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    prevProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    prevWorktree = process.env[EnvVars.WORKTREE_PATH];

    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y22-')));
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), HARNESS_YAML);

    process.chdir(tempRoot);
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempRoot;
  });

  afterEach(async () => {
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 200));
    process.chdir(previousCwd);
    if (prevProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = prevProjectRoot;
    if (prevWorktree === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = prevWorktree;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  async function registeredTool(): Promise<any> {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
    const tool = harness.tools.find(t => t.name === BuiltInToolName.QUERY_HARNESS_EVENTS);
    expect(tool, 'query_harness_events tool must be registered').toBeDefined();
    return tool;
  }

  const noUiCtx = { hasUI: false } as any;

  async function callTool(tool: any, params: Record<string, unknown>): Promise<any> {
    const wrapped = await tool.execute('call-id', params, undefined, undefined, noUiCtx);
    return wrapped.details ?? wrapped;
  }

  // ── (A) Registration ──────────────────────────────────────────────────────

  it('(A1) tool is registered with name query_harness_events', async () => {
    const tool = await registeredTool();
    expect(tool.name).toBe('query_harness_events');
  });

  it('(A2) tool parameter schema exposes all AC1 filter fields', async () => {
    const tool = await registeredTool();
    const props = tool.parameters?.properties ?? {};
    expect(props.beadId).toBeDefined();
    expect(props.eventTypes).toBeDefined();
    expect(props.stateId).toBeDefined();
    expect(props.actionId).toBeDefined();
    expect(props.fromTime).toBeDefined();
    expect(props.toTime).toBeDefined();
    expect(props.limit).toBeDefined();
    expect(props.cursor).toBeDefined();
    expect(props.detail).toBeDefined();
  });

  // ── (B) Summary mode ──────────────────────────────────────────────────────

  it('(B1) empty store: eventTypes filter for a type that does not exist returns totalMatched:0', async () => {
    // Use eventTypes to exclude the TOOL_INVOCATION_STARTED that wrapPluginTool writes
    const tool = await registeredTool();
    const result = await callTool(tool, { eventTypes: ['NONEXISTENT_TYPE'] });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(0);
    expect(result.countByType).toEqual({});
    expect(result.latestEvent).toBeNull();
  });

  it('(B2) summary mode returns metadata but does not inline event data payloads', async () => {
    await writeFixtureEvent(tempRoot, 'MY_FIXTURE_EVENT', {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'a1',
      secret: 'do-not-surface-this'
    });

    const tool = await registeredTool();
    // Filter to only MY_FIXTURE_EVENT to avoid TOOL_INVOCATION_STARTED counts
    const result = await callTool(tool, { eventTypes: ['MY_FIXTURE_EVENT'] });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(1);
    // No full data payload inlined
    expect(JSON.stringify(result)).not.toContain('do-not-surface-this');
    // latestEvent has metadata fields only
    expect(result.latestEvent).toBeDefined();
    expect(result.latestEvent.type).toBe('MY_FIXTURE_EVENT');
    expect(result.latestEvent.beadId).toBe('bd-1');
  });

  it('(B3) countByType groups events by type correctly', async () => {
    await writeFixtureEvent(tempRoot, 'FIXTURE_TYPE_A', { beadId: 'bd-1' });
    await writeFixtureEvent(tempRoot, 'FIXTURE_TYPE_A', { beadId: 'bd-1' });
    await writeFixtureEvent(tempRoot, 'FIXTURE_TYPE_B', { beadId: 'bd-1' });

    const tool = await registeredTool();
    // Filter to only fixture types
    const result = await callTool(tool, { eventTypes: ['FIXTURE_TYPE_A', 'FIXTURE_TYPE_B'] });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(3);
    expect(result.countByType['FIXTURE_TYPE_A']).toBe(2);
    expect(result.countByType['FIXTURE_TYPE_B']).toBe(1);
  });

  it('(B4) 10,000-event fixture returns under 24 KB in summary mode (AC4)', async () => {
    // Write 10,000 events directly for speed
    const eventsDir = path.join(tempRoot, '.pi/events');
    fs.mkdirSync(eventsDir, { recursive: true });
    const jsonlPath = path.join(eventsDir, `${path.basename(tempRoot)}.jsonl`);

    const lines: string[] = [];
    const now = new Date();
    for (let i = 0; i < 10_000; i++) {
      lines.push(JSON.stringify({
        id: `evt-${String(i).padStart(8, '0')}`,
        type: i % 5 === 0 ? 'FIXTURE_INIT' : `FIXTURE_TYPE_${i % 10}`,
        timestamp: new Date(now.getTime() + i).toISOString(),
        sessionId: 'session-fixture',
        data: {
          beadId: `bd-${i % 50}`,
          stateId: 'Planning',
          actionId: 'a1',
          payload: 'x'.repeat(100)
        }
      }));
    }
    fs.appendFileSync(jsonlPath, lines.join('\n') + '\n', 'utf8');

    const tool = await registeredTool();
    // Filter to fixture types only to avoid TOOL_INVOCATION_STARTED count pollution
    const fixtureTypes: string[] = [];
    for (let i = 0; i < 10; i++) fixtureTypes.push(`FIXTURE_TYPE_${i}`);
    fixtureTypes.push('FIXTURE_INIT');

    const result = await callTool(tool, { eventTypes: fixtureTypes });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(10_000);

    // Must be under 24 KB (AC4)
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    expect(bytes).toBeLessThan(24_000);
  });

  // ── (C) Detail mode ───────────────────────────────────────────────────────

  it('(C1) detail:true returns status:detail with events array', async () => {
    await writeFixtureEvent(tempRoot, 'FIXTURE_DETAIL_EVT', { beadId: 'bd-1', stateId: 'Planning' });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      detail: true,
      eventTypes: ['FIXTURE_DETAIL_EVT']
    });
    expect(result.status).toBe('detail');
    expect(Array.isArray(result.events)).toBe(true);
    expect(result.events.length).toBe(1);
    expect(result.events[0].type).toBe('FIXTURE_DETAIL_EVT');
  });

  it('(C2) detail mode caps at 100 events regardless of how many match (AC3)', async () => {
    const eventsDir = path.join(tempRoot, '.pi/events');
    fs.mkdirSync(eventsDir, { recursive: true });
    const jsonlPath = path.join(eventsDir, `${path.basename(tempRoot)}.jsonl`);

    const lines: string[] = [];
    for (let i = 0; i < 150; i++) {
      lines.push(JSON.stringify({
        id: `evt-${String(i).padStart(8, '0')}`,
        type: 'FIXTURE_CAP_EVT',
        timestamp: new Date(Date.now() + i).toISOString(),
        sessionId: 'test',
        data: { beadId: 'bd-1' }
      }));
    }
    fs.appendFileSync(jsonlPath, lines.join('\n') + '\n', 'utf8');

    const tool = await registeredTool();
    const result = await callTool(tool, { detail: true, eventTypes: ['FIXTURE_CAP_EVT'] });
    expect(result.status).toBe('detail');
    expect(result.totalMatched).toBe(150);
    expect(result.returnedCount).toBeLessThanOrEqual(100);
    expect(result.events.length).toBeLessThanOrEqual(100);
  });

  it('(C3) detail mode truncates long strings to 300 chars (AC3)', async () => {
    const longString = 'a'.repeat(500);
    await writeFixtureEvent(tempRoot, 'FIXTURE_TRUNC_EVT', {
      beadId: 'bd-1',
      bigField: longString
    });

    const tool = await registeredTool();
    const result = await callTool(tool, { detail: true, eventTypes: ['FIXTURE_TRUNC_EVT'] });
    expect(result.status).toBe('detail');
    const eventData = result.events[0].data;
    expect(typeof eventData.bigField).toBe('string');
    // Truncated to 300 chars + ellipsis character
    expect((eventData.bigField as string).length).toBeLessThanOrEqual(302);
    expect(eventData.bigField).not.toBe(longString);
  });

  it('(C4) detail mode respects limit param (capped at 100)', async () => {
    const eventsDir = path.join(tempRoot, '.pi/events');
    fs.mkdirSync(eventsDir, { recursive: true });
    const jsonlPath = path.join(eventsDir, `${path.basename(tempRoot)}.jsonl`);

    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(JSON.stringify({
        id: `evt-${String(i).padStart(8, '0')}`,
        type: 'FIXTURE_LIMIT_EVT',
        timestamp: new Date(Date.now() + i).toISOString(),
        sessionId: 'test',
        data: { beadId: 'bd-1' }
      }));
    }
    fs.appendFileSync(jsonlPath, lines.join('\n') + '\n', 'utf8');

    const tool = await registeredTool();
    const result = await callTool(tool, {
      detail: true,
      limit: 5,
      eventTypes: ['FIXTURE_LIMIT_EVT']
    });
    expect(result.status).toBe('detail');
    expect(result.events.length).toBe(5);
  });

  // ── (D) Filters ───────────────────────────────────────────────────────────

  it('(D1) beadId filter scopes results to one bead — eventTypes-isolated (AC1)', async () => {
    await writeFixtureEvent(tempRoot, 'FIXTURE_BEAD_EVT', { beadId: 'bd-target-1', stateId: 'Planning' });
    await writeFixtureEvent(tempRoot, 'FIXTURE_BEAD_EVT', { beadId: 'bd-other-2', stateId: 'Planning' });

    const tool = await registeredTool();
    // Use beadId filter: EventStore.eventsForBead scopes reads to one bead's JSONL index.
    // Combine with eventTypes to ensure only fixture events are counted.
    const result = await callTool(tool, {
      beadId: 'bd-target-1',
      eventTypes: ['FIXTURE_BEAD_EVT']
    });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(1);
    expect(result.latestEvent?.beadId).toBe('bd-target-1');
  });

  it('(D2) eventTypes filter includes only listed types (AC1)', async () => {
    await writeFixtureEvent(tempRoot, 'FIXTURE_INCLUDE', { beadId: 'bd-1' });
    await writeFixtureEvent(tempRoot, 'FIXTURE_EXCLUDE', { beadId: 'bd-1' });

    const tool = await registeredTool();
    const result = await callTool(tool, { eventTypes: ['FIXTURE_INCLUDE'] });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(1);
    expect(result.countByType['FIXTURE_INCLUDE']).toBe(1);
    expect(result.countByType['FIXTURE_EXCLUDE']).toBeUndefined();
  });

  it('(D3) stateId filter matches on data.stateId (AC1)', async () => {
    await writeFixtureEvent(tempRoot, 'FIXTURE_STATE_EVT', { beadId: 'bd-1', stateId: 'Planning' });
    await writeFixtureEvent(tempRoot, 'FIXTURE_STATE_EVT', { beadId: 'bd-1', stateId: 'Coding' });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      stateId: 'Planning',
      eventTypes: ['FIXTURE_STATE_EVT']
    });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(1);
  });

  it('(D4) actionId filter matches on data.actionId (AC1)', async () => {
    await writeFixtureEvent(tempRoot, 'FIXTURE_ACTION_EVT', { beadId: 'bd-1', actionId: 'action-yes' });
    await writeFixtureEvent(tempRoot, 'FIXTURE_ACTION_EVT', { beadId: 'bd-1', actionId: 'action-no' });

    const tool = await registeredTool();
    const result = await callTool(tool, {
      actionId: 'action-yes',
      eventTypes: ['FIXTURE_ACTION_EVT']
    });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(1);
  });

  it('(D5) fromTime filter excludes events before the cutoff (AC1)', async () => {
    const past = new Date(Date.now() - 10_000).toISOString();

    // Write one "old" event directly with a past timestamp
    const eventsDir = path.join(tempRoot, '.pi/events');
    fs.mkdirSync(eventsDir, { recursive: true });
    const jsonlPath = path.join(eventsDir, `${path.basename(tempRoot)}.jsonl`);
    fs.appendFileSync(jsonlPath, JSON.stringify({
      id: 'evt-old',
      type: 'FIXTURE_TIME_EVT',
      timestamp: past,
      sessionId: 'test',
      data: { beadId: 'bd-1', era: 'old' }
    }) + '\n', 'utf8');

    await writeFixtureEvent(tempRoot, 'FIXTURE_TIME_EVT', { beadId: 'bd-1', era: 'new' });

    const tool = await registeredTool();
    // fromTime cuts off 5 seconds ago — old event excluded, new event included
    const result = await callTool(tool, {
      fromTime: new Date(Date.now() - 5_000).toISOString(),
      eventTypes: ['FIXTURE_TIME_EVT']
    });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(1);
    // The new event (era:new) is the latest event; the old one is excluded
    expect(result.latestEvent).toBeDefined();
  });

  it('(D6) cursor filter pages forward — only events after cursor are returned (AC1)', async () => {
    const eventsDir = path.join(tempRoot, '.pi/events');
    fs.mkdirSync(eventsDir, { recursive: true });
    const jsonlPath = path.join(eventsDir, `${path.basename(tempRoot)}.jsonl`);

    // Write 3 events with ordered IDs (lexicographically sortable)
    const lines = [
      JSON.stringify({ id: 'cursor-001', type: 'FIXTURE_CURSOR_EVT', timestamp: new Date().toISOString(), sessionId: 'test', data: { beadId: 'bd-1' } }),
      JSON.stringify({ id: 'cursor-002', type: 'FIXTURE_CURSOR_EVT', timestamp: new Date().toISOString(), sessionId: 'test', data: { beadId: 'bd-1' } }),
      JSON.stringify({ id: 'cursor-003', type: 'FIXTURE_CURSOR_EVT', timestamp: new Date().toISOString(), sessionId: 'test', data: { beadId: 'bd-1' } })
    ];
    fs.appendFileSync(jsonlPath, lines.join('\n') + '\n', 'utf8');

    const tool = await registeredTool();
    // First page: all 3 fixture events
    const page1 = await callTool(tool, { detail: true, eventTypes: ['FIXTURE_CURSOR_EVT'] });
    expect(page1.totalMatched).toBe(3);
    expect(page1.events.length).toBe(3);

    // Second page: cursor after first event → 2 events remain
    const page2 = await callTool(tool, {
      detail: true,
      cursor: 'cursor-001',
      eventTypes: ['FIXTURE_CURSOR_EVT']
    });
    expect(page2.totalMatched).toBe(2);
    expect(page2.events.every((e: any) => e.eventId > 'cursor-001')).toBe(true);
  });

  // ── (E) Fail-closed on bad input ──────────────────────────────────────────

  it('(E1) invalid fromTime returns status:rejected', async () => {
    const tool = await registeredTool();
    const result = await callTool(tool, { fromTime: 'not-a-date' });
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('fromTime');
  });

  it('(E2) invalid toTime returns status:rejected', async () => {
    const tool = await registeredTool();
    const result = await callTool(tool, { toTime: 'bad-timestamp' });
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('toTime');
  });

  // ── (F) Malformed records counted, not inlined (AC5) ─────────────────────

  it('(F1) malformed records are counted as skippedCount===1 and not inlined', async () => {
    const eventsDir = path.join(tempRoot, '.pi/events');
    fs.mkdirSync(eventsDir, { recursive: true });
    const jsonlPath = path.join(eventsDir, `${path.basename(tempRoot)}.jsonl`);

    // Malformed: valid JSON object but missing 'type' (required shape field) —
    // EventStore.isDomainEvent rejects it, so it must be COUNTED not hidden.
    fs.appendFileSync(jsonlPath, JSON.stringify({
      id: 'evt-bad',
      // type: intentionally missing
      timestamp: new Date().toISOString(),
      sessionId: 'test',
      data: { secret: 'hidden-in-malformed', beadId: 'bd-malformed' }
    }) + '\n', 'utf8');

    // Valid event alongside the malformed one
    fs.appendFileSync(jsonlPath, JSON.stringify({
      id: 'evt-good',
      type: 'FIXTURE_GOOD_EVT',
      timestamp: new Date().toISOString(),
      sessionId: 'test',
      data: { beadId: 'bd-malformed' }
    }) + '\n', 'utf8');

    const tool = await registeredTool();
    // Query without beadId to exercise the readAllRaw() path (which counts
    // shape-invalid records). eventTypes filters to only the valid fixture type
    // so totalMatched reflects the valid event count only.
    const result = await callTool(tool, { eventTypes: ['FIXTURE_GOOD_EVT'] });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(1);
    // Load-bearing: the malformed record is COUNTED (AC5: not hidden, not inlined)
    expect(result.skippedCount).toBe(1);
    // Malformed data content never surfaced in the response
    expect(JSON.stringify(result)).not.toContain('hidden-in-malformed');
  });

  it('(F2) skippedCount field is present in summary and detail responses', async () => {
    // skippedCount is always reported — even when zero — so callers can assert
    // its presence without needing to construct truly-malformed fixtures
    // (the EventStore's isDomainEvent guard already pre-filters records that
    // lack type/timestamp strings before they reach HarnessEventQuery).
    await writeFixtureEvent(tempRoot, 'FIXTURE_SKIP_EVT', { beadId: 'bd-1' });

    const tool = await registeredTool();
    const summaryResult = await callTool(tool, { eventTypes: ['FIXTURE_SKIP_EVT'] });
    expect(summaryResult.status).toBe('summary');
    expect(typeof summaryResult.skippedCount).toBe('number');

    const detailResult = await callTool(tool, { detail: true, eventTypes: ['FIXTURE_SKIP_EVT'] });
    expect(detailResult.status).toBe('detail');
    expect(typeof detailResult.skippedCount).toBe('number');
  });

  it('(F3) nextCursor is present in summary mode when events match', async () => {
    await writeFixtureEvent(tempRoot, 'FIXTURE_CURSOR_PRESENT', { beadId: 'bd-1' });

    const tool = await registeredTool();
    const result = await callTool(tool, { eventTypes: ['FIXTURE_CURSOR_PRESENT'] });
    expect(result.status).toBe('summary');
    expect(result.nextCursor).not.toBeNull();
    expect(typeof result.nextCursor).toBe('string');
  });
});
