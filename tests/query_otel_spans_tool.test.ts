/**
 * pi-experiment-6q0y.26 — query_otel_spans progressive-disclosure tool.
 *
 * Load-bearing assertions:
 *   (A) Tool is registered with the correct name and parameter schema.
 *   (B) Summary mode: span count, error count, p50/p95/p99 durations, top slow names (AC2).
 *   (C) Detail mode: caps at 100, truncates attributes to 300 chars (AC3).
 *   (D) Filters: traceId, spanName, status, time range (AC1).
 *   (E) Fail-closed: bad time inputs return rejected.
 *   (F) Malformed records are counted, query does not fail (AC4).
 *   (G) Summary response stays under 24 KB for large fixtures (AC5).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuiltInToolName } from '../src/constants/domain.js';
import { EnvVars, PiEventName } from '../src/constants/infra.js';
import { Logger } from '../src/core/Logger.js';
import orrElseExtension from '../src/extension.js';

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

// ─── OTEL span fixture builder ────────────────────────────────────────────────

function makeSpanRecord(opts: {
  traceId?: string;
  spanId?: string;
  name?: string;
  durationMs?: number;
  statusCode?: number;
  attributes?: Record<string, unknown>;
  startTimeUnixNano?: string;
}): string {
  const durationMs = opts.durationMs ?? 100;
  const durationNano = BigInt(durationMs) * BigInt(1_000_000);
  const startMs = Date.now();
  const startNano = BigInt(startMs) * BigInt(1_000_000);
  const endNano = startNano + durationNano;
  return JSON.stringify({
    traceId: opts.traceId ?? 'trace-abc',
    spanId: opts.spanId ?? `span-${Math.random().toString(36).slice(2)}`,
    name: opts.name ?? 'test_span',
    startTimeUnixNano: opts.startTimeUnixNano ?? startNano.toString(),
    endTimeUnixNano: endNano.toString(),
    durationUnixNano: durationNano.toString(),
    status: { code: opts.statusCode ?? 1 }, // 1=OK, 2=ERROR
    attributes: opts.attributes ?? {},
    events: [],
    resource: {},
    instrumentationScope: {}
  });
}

describe('pi-experiment-6q0y.26: query_otel_spans progressive-disclosure tool', () => {
  let tempRoot: string;
  let prevProjectRoot: string | undefined;
  let prevWorktree: string | undefined;
  let previousCwd: string;
  let otelDir: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    prevProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    prevWorktree = process.env[EnvVars.WORKTREE_PATH];

    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y26-')));
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), HARNESS_YAML);
    otelDir = path.join(tempRoot, '.pi/otel');
    fs.mkdirSync(otelDir, { recursive: true });

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
    const tool = harness.tools.find(t => t.name === BuiltInToolName.QUERY_OTEL_SPANS);
    expect(tool, 'query_otel_spans tool must be registered').toBeDefined();
    return tool;
  }

  const noUiCtx = { hasUI: false } as any;

  async function callTool(tool: any, params: Record<string, unknown>): Promise<any> {
    const wrapped = await tool.execute('call-id', params, undefined, undefined, noUiCtx);
    return wrapped.details ?? wrapped;
  }

  function writeSpans(filename: string, lines: string[]): void {
    fs.appendFileSync(path.join(otelDir, filename), lines.join('\n') + '\n', 'utf8');
  }

  // ── (A) Registration ──────────────────────────────────────────────────────

  it('(A1) tool is registered with name query_otel_spans', async () => {
    const tool = await registeredTool();
    expect(tool.name).toBe('query_otel_spans');
  });

  it('(A2) tool parameter schema exposes all filter fields', async () => {
    const tool = await registeredTool();
    const props = tool.parameters?.properties ?? {};
    expect(props.traceId).toBeDefined();
    expect(props.spanName).toBeDefined();
    expect(props.action).toBeDefined();
    expect(props.tool).toBeDefined();
    expect(props.status).toBeDefined();
    expect(props.fromTime).toBeDefined();
    expect(props.toTime).toBeDefined();
    expect(props.detail).toBeDefined();
  });

  // ── (B) Summary mode ──────────────────────────────────────────────────────

  it('(B1) empty otel dir returns summary with zero counts', async () => {
    const tool = await registeredTool();
    const result = await callTool(tool, {});
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(result.malformedCount).toBe(0);
    expect(result.durationStats).toBeNull();
    expect(result.topSlowSpanNames).toEqual([]);
  });

  it('(B2) summary mode counts spans and errors', async () => {
    writeSpans('traces-001.jsonl', [
      makeSpanRecord({ name: 'span_ok', durationMs: 50, statusCode: 1 }),
      makeSpanRecord({ name: 'span_err', durationMs: 200, statusCode: 2 }),
      makeSpanRecord({ name: 'span_ok', durationMs: 100, statusCode: 1 })
    ]);

    const tool = await registeredTool();
    const result = await callTool(tool, {});
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(3);
    expect(result.errorCount).toBe(1);
  });

  it('(B3) summary mode computes duration percentiles', async () => {
    // 10 spans with durations 10ms, 20ms, ..., 100ms
    const spans = Array.from({ length: 10 }, (_, i) =>
      makeSpanRecord({ durationMs: (i + 1) * 10 })
    );
    writeSpans('traces-002.jsonl', spans);

    const tool = await registeredTool();
    const result = await callTool(tool, {});
    expect(result.status).toBe('summary');
    expect(result.durationStats).not.toBeNull();
    expect(result.durationStats.p50Ms).toBeGreaterThan(0);
    expect(result.durationStats.p95Ms).toBeGreaterThanOrEqual(result.durationStats.p50Ms);
    expect(result.durationStats.p99Ms).toBeGreaterThanOrEqual(result.durationStats.p95Ms);
  });

  it('(B4) summary mode surfaces top slow span names', async () => {
    writeSpans('traces-003.jsonl', [
      makeSpanRecord({ name: 'slow_op', durationMs: 1000 }),
      makeSpanRecord({ name: 'fast_op', durationMs: 10 }),
      makeSpanRecord({ name: 'slow_op', durationMs: 2000 })
    ]);

    const tool = await registeredTool();
    const result = await callTool(tool, {});
    expect(result.status).toBe('summary');
    expect(result.topSlowSpanNames.length).toBeGreaterThan(0);
    // slow_op should appear first (highest average)
    expect(result.topSlowSpanNames[0].name).toBe('slow_op');
    expect(result.topSlowSpanNames[0].count).toBe(2);
  });

  // ── (C) Detail mode ───────────────────────────────────────────────────────

  it('(C1) detail:true returns status:detail with spans array', async () => {
    writeSpans('traces-004.jsonl', [makeSpanRecord({ name: 'my_span' })]);

    const tool = await registeredTool();
    const result = await callTool(tool, { detail: true });
    expect(result.status).toBe('detail');
    expect(Array.isArray(result.spans)).toBe(true);
    expect(result.spans.length).toBe(1);
    expect(result.spans[0].name).toBe('my_span');
  });

  it('(C2) detail mode caps at 100 spans (AC3)', async () => {
    const spans = Array.from({ length: 150 }, (_, i) =>
      makeSpanRecord({ name: `span_${i}` })
    );
    writeSpans('traces-005.jsonl', spans);

    const tool = await registeredTool();
    const result = await callTool(tool, { detail: true });
    expect(result.status).toBe('detail');
    expect(result.totalMatched).toBe(150);
    expect(result.spans.length).toBeLessThanOrEqual(100);
    expect(result.capped).toBe(true);
  });

  it('(C3) detail mode truncates attribute values to 300 chars (AC3)', async () => {
    const longAttr = 'v'.repeat(500);
    writeSpans('traces-006.jsonl', [
      makeSpanRecord({ attributes: { 'bigAttr': longAttr } })
    ]);

    const tool = await registeredTool();
    const result = await callTool(tool, { detail: true });
    expect(result.status).toBe('detail');
    const attrVal = result.spans[0].attributes['bigAttr'] as string;
    expect(typeof attrVal).toBe('string');
    expect(attrVal.length).toBeLessThanOrEqual(302); // 300 + ellipsis
    expect(attrVal).not.toBe(longAttr);
  });

  // ── (D) Filters ───────────────────────────────────────────────────────────

  it('(D1) traceId filter includes only matching trace (AC1)', async () => {
    writeSpans('traces-007.jsonl', [
      makeSpanRecord({ traceId: 'trace-aaa', name: 'span1' }),
      makeSpanRecord({ traceId: 'trace-bbb', name: 'span2' })
    ]);

    const tool = await registeredTool();
    const result = await callTool(tool, { detail: true, traceId: 'trace-aaa' });
    expect(result.status).toBe('detail');
    expect(result.spans.length).toBe(1);
    expect(result.spans[0].name).toBe('span1');
  });

  it('(D2) spanName filter is substring and case-insensitive', async () => {
    writeSpans('traces-008.jsonl', [
      makeSpanRecord({ name: 'llm_turn' }),
      makeSpanRecord({ name: 'teammate_spawn' })
    ]);

    const tool = await registeredTool();
    const result = await callTool(tool, { detail: true, spanName: 'LLM' });
    expect(result.status).toBe('detail');
    expect(result.spans.length).toBe(1);
    expect(result.spans[0].name).toBe('llm_turn');
  });

  it('(D3) status filter includes only matching status', async () => {
    writeSpans('traces-009.jsonl', [
      makeSpanRecord({ statusCode: 1, name: 'ok_span' }),
      makeSpanRecord({ statusCode: 2, name: 'err_span' })
    ]);

    const tool = await registeredTool();
    const errResult = await callTool(tool, { detail: true, status: 'error' });
    expect(errResult.spans.length).toBe(1);
    expect(errResult.spans[0].name).toBe('err_span');
  });

  // ── (E) Fail-closed ───────────────────────────────────────────────────────

  it('(E1) invalid fromTime returns status:rejected', async () => {
    const tool = await registeredTool();
    const result = await callTool(tool, { fromTime: 'not-a-date' });
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('fromTime');
  });

  it('(E2) invalid toTime returns status:rejected', async () => {
    const tool = await registeredTool();
    const result = await callTool(tool, { toTime: 'bad-ts' });
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('toTime');
  });

  // ── (F) Malformed records counted, not fatal (AC4) ────────────────────────

  it('(F1) malformed JSONL lines are counted as malformedCount and query succeeds', async () => {
    const otelPath = path.join(otelDir, 'traces-010.jsonl');
    // Non-JSON line
    fs.appendFileSync(otelPath, 'this is not json\n', 'utf8');
    // JSON but not a valid span (missing required fields)
    fs.appendFileSync(otelPath, JSON.stringify({ partial: 'no traceId or spanId' }) + '\n', 'utf8');
    // Valid span
    fs.appendFileSync(otelPath, makeSpanRecord({ name: 'good_span' }) + '\n', 'utf8');

    const tool = await registeredTool();
    const result = await callTool(tool, {});
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(1);
    expect(result.malformedCount).toBe(2);
  });

  // ── (G) 24 KB cap for summary with large fixture (AC5) ───────────────────

  it('(G1) summary mode stays under 24 KB for 1,000-span fixture', async () => {
    const spans = Array.from({ length: 1_000 }, (_, i) =>
      makeSpanRecord({ name: `span_name_${i % 20}`, durationMs: i * 5 })
    );
    writeSpans('traces-big.jsonl', spans);

    const tool = await registeredTool();
    const result = await callTool(tool, {});
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(1_000);
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    expect(bytes).toBeLessThan(24_000);
  });
});
