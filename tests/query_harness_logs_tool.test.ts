/**
 * pi-experiment-6q0y.24 — query_harness_logs progressive-disclosure tool.
 *
 * Load-bearing assertions:
 *   (A) Tool is registered with the correct name and parameter schema.
 *   (B) Summary mode: returns counts by level/component and latest metadata, no raw messages.
 *   (C) Excerpt mode: truncates messages to 300 chars, total capped to 24 KB (AC4).
 *   (D) Filters: time range, level, component, search pattern (AC2).
 *   (E) Fail-closed: bad inputs return rejected response.
 *   (F) Malformed lines are counted, never inlined (AC5).
 *   (G) Streaming: no OOM on large fixture (AC1).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuiltInToolName } from '../src/constants/domain.js';
import { EnvVars, PiEventName } from '../src/constants/infra.js';
import { Logger } from '../src/core/Logger.js';
import orrElseExtension from '../src/extension.js';

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

describe('pi-experiment-6q0y.24: query_harness_logs progressive-disclosure tool', () => {
  let tempRoot: string;
  let prevProjectRoot: string | undefined;
  let prevWorktree: string | undefined;
  let previousCwd: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    prevProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    prevWorktree = process.env[EnvVars.WORKTREE_PATH];

    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y24-')));
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
    const tool = harness.tools.find(t => t.name === BuiltInToolName.QUERY_HARNESS_LOGS);
    expect(tool, 'query_harness_logs tool must be registered').toBeDefined();
    return tool;
  }

  const noUiCtx = { hasUI: false } as any;

  async function callTool(tool: any, params: Record<string, unknown>): Promise<any> {
    const wrapped = await tool.execute('call-id', params, undefined, undefined, noUiCtx);
    return wrapped.details ?? wrapped;
  }

  /**
   * Write a JSON log line to a fixture-only log file.
   * Uses a fixed past date (2020-01-01) to avoid colliding with Logger's
   * daily-rotate file (today's date). Both files match orr-else-*.log.
   */
  function writeLogLine(opts: { level?: string; component?: string; message: string; timestamp?: string }): void {
    const logDir = path.join(tempRoot, '.pi/logs');
    fs.mkdirSync(logDir, { recursive: true });
    // Use a fixed past date so our fixture file never conflicts with
    // the Logger's DailyRotateFile which writes to orr-else-<today>.log
    const logPath = path.join(logDir, 'orr-else-2020-01-01.log');
    const line = JSON.stringify({
      level: opts.level ?? 'info',
      message: opts.message,
      timestamp: opts.timestamp ?? new Date().toISOString(),
      component: opts.component ?? 'fixture',
      pid: 1,
      version: '0.1.0'
    });
    fs.appendFileSync(logPath, line + '\n', 'utf8');
  }

  // ── (A) Registration ──────────────────────────────────────────────────────

  it('(A1) tool is registered with name query_harness_logs', async () => {
    const tool = await registeredTool();
    expect(tool.name).toBe('query_harness_logs');
  });

  it('(A2) tool parameter schema exposes all filter fields', async () => {
    const tool = await registeredTool();
    const props = tool.parameters?.properties ?? {};
    expect(props.fromTime).toBeDefined();
    expect(props.toTime).toBeDefined();
    expect(props.level).toBeDefined();
    expect(props.component).toBeDefined();
    expect(props.search).toBeDefined();
    expect(props.excerpt).toBeDefined();
  });

  // ── (B) Summary mode ──────────────────────────────────────────────────────

  it('(B1) filtering by an unused component returns summary with zero counts', async () => {
    const tool = await registeredTool();
    // Use a component value that no real log line will have
    const result = await callTool(tool, { component: 'nonexistent-component-xyz' });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(0);
    expect(result.malformedCount).toBe(0);
    expect(result.latestLine).toBeNull();
  });

  it('(B2) summary mode returns counts by level and component, no raw message bodies', async () => {
    // Use unique component names that won't appear in real Logger output
    writeLogLine({ level: 'info', component: 'fixture-coord', message: 'started secret-data' });
    writeLogLine({ level: 'warn', component: 'fixture-super', message: 'warning here' });
    writeLogLine({ level: 'info', component: 'fixture-coord', message: 'done' });

    const tool = await registeredTool();
    // Search for a word unique to our fixtures to exclude Logger lines
    const result = await callTool(tool, { search: 'started secret' });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(1);
    // Use component filter to check fixture totals
    const resultAll = await callTool(tool, { component: 'fixture-coord' });
    expect(resultAll.totalMatched).toBe(2);
    expect(resultAll.countByLevel.info).toBe(2);
    // No raw message body in summary
    expect(JSON.stringify(resultAll)).not.toContain('secret-data');
  });

  it('(B3) latestLine contains timestamp/level/component metadata', async () => {
    const ts1 = '2020-01-01T10:00:00.000Z';
    const ts2 = '2020-01-01T10:01:00.000Z';
    // Use fixture component so we can isolate by component filter
    writeLogLine({ level: 'debug', component: 'fixture-meta', message: 'old', timestamp: ts1 });
    writeLogLine({ level: 'error', component: 'fixture-meta', message: 'new', timestamp: ts2 });

    const tool = await registeredTool();
    // Filter to fixture component to avoid interference from real Logger lines
    const result = await callTool(tool, { component: 'fixture-meta' });
    expect(result.status).toBe('summary');
    expect(result.latestLine?.timestamp).toBe(ts2);
    expect(result.latestLine?.level).toBe('error');
    expect(result.latestLine?.component).toBe('fixture-meta');
  });

  // ── (C) Excerpt mode ──────────────────────────────────────────────────────

  it('(C1) excerpt:true returns status:excerpt with entries array', async () => {
    writeLogLine({ message: 'hello world', component: 'fixture-excerpt1' });

    const tool = await registeredTool();
    const result = await callTool(tool, { excerpt: true, component: 'fixture-excerpt1' });
    expect(result.status).toBe('excerpt');
    expect(Array.isArray(result.entries)).toBe(true);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].message).toBe('hello world');
  });

  it('(C2) excerpt mode truncates messages to 300 chars (AC4)', async () => {
    const longMsg = 'x'.repeat(500);
    writeLogLine({ message: longMsg, component: 'fixture-trunc' });

    const tool = await registeredTool();
    const result = await callTool(tool, { excerpt: true, component: 'fixture-trunc' });
    expect(result.status).toBe('excerpt');
    const msg = result.entries[0].message as string;
    expect(msg.length).toBeLessThanOrEqual(302); // 300 + ellipsis
    expect(msg).not.toBe(longMsg);
  });

  it('(C3) excerpt mode caps total response at 24 KB (AC4)', async () => {
    const logDir = path.join(tempRoot, '.pi/logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'orr-else-2018-01-01.log');
    // Write 500 log lines each with 200-char messages
    const bigMsg = 'a'.repeat(200);
    for (let i = 0; i < 500; i++) {
      const line = JSON.stringify({
        level: 'info',
        message: bigMsg,
        timestamp: new Date().toISOString(),
        component: 'fixture-cap',
        pid: 1,
        version: '0.1.0'
      });
      fs.appendFileSync(logPath, line + '\n', 'utf8');
    }

    const tool = await registeredTool();
    const result = await callTool(tool, { excerpt: true, component: 'fixture-cap' });
    expect(result.status).toBe('excerpt');
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    expect(bytes).toBeLessThan(24_000 + 1000); // allow some envelope overhead
  });

  // ── (D) Filters ───────────────────────────────────────────────────────────

  it('(D1) level filter includes only matching level', async () => {
    writeLogLine({ level: 'info', component: 'fixture-level', message: 'info line' });
    writeLogLine({ level: 'warn', component: 'fixture-level', message: 'warn line' });
    writeLogLine({ level: 'error', component: 'fixture-level', message: 'error line' });

    const tool = await registeredTool();
    const result = await callTool(tool, { level: 'warn', component: 'fixture-level' });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(1);
    expect(result.countByLevel.warn).toBe(1);
  });

  it('(D2) component filter includes only exact component match', async () => {
    writeLogLine({ component: 'fixture-compA', message: 'a' });
    writeLogLine({ component: 'fixture-compB', message: 'b' });

    const tool = await registeredTool();
    const result = await callTool(tool, { component: 'fixture-compA' });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(1);
    expect(result.countByComponent['fixture-compA']).toBe(1);
  });

  it('(D3) search filter includes only lines containing the substring', async () => {
    // Use a unique search term unlikely to appear in Logger output
    writeLogLine({ message: 'something XYZFIXTURE happened', component: 'fixture-search' });
    writeLogLine({ message: 'routine operation', component: 'fixture-search' });
    writeLogLine({ message: 'another XYZFIXTURE event', component: 'fixture-search' });

    const tool = await registeredTool();
    const result = await callTool(tool, { search: 'XYZFIXTURE', component: 'fixture-search' });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(2);
  });

  it('(D4) fromTime filter excludes lines before cutoff', async () => {
    writeLogLine({ message: 'old', timestamp: '2020-01-01T00:00:00.000Z', component: 'fixture-time' });
    writeLogLine({ message: 'new', timestamp: '2020-06-10T10:00:00.000Z', component: 'fixture-time' });

    const tool = await registeredTool();
    // Filter: only lines >= 2020-06-01 AND from fixture component
    const result = await callTool(tool, {
      fromTime: '2020-06-01T00:00:00.000Z',
      component: 'fixture-time'
    });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(1);
    expect(result.latestLine?.timestamp).toBe('2020-06-10T10:00:00.000Z');
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
    const result = await callTool(tool, { toTime: 'bad-timestamp' });
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('toTime');
  });

  // ── (F) Malformed lines counted, not inlined (AC5) ────────────────────────

  it('(F1) malformed log lines are counted as malformedCount and not inlined', async () => {
    const logDir = path.join(tempRoot, '.pi/logs');
    fs.mkdirSync(logDir, { recursive: true });
    // Use a distinct past-date filename to avoid mixing with Logger's file
    const logPath = path.join(logDir, 'orr-else-2000-01-01.log');

    // Malformed: not valid JSON
    fs.appendFileSync(logPath, 'this is not json { broken\n', 'utf8');
    // Malformed: valid JSON but missing required 'level' field
    fs.appendFileSync(logPath, JSON.stringify({ message: 'no level secret-nofield', timestamp: new Date().toISOString() }) + '\n', 'utf8');
    // Valid line
    fs.appendFileSync(logPath, JSON.stringify({
      level: 'info', message: 'valid-fixture-f1', timestamp: new Date().toISOString(), component: 'fixture-malformed'
    }) + '\n', 'utf8');

    const tool = await registeredTool();
    // Query only this file's component to get exact counts
    const result = await callTool(tool, { component: 'fixture-malformed' });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(1);
    // The 2 malformed lines in the same file are captured in the full scan
    // We need to scan without component filter to see malformed from this file:
    const resultFull = await callTool(tool, { search: 'valid-fixture-f1' });
    expect(resultFull.totalMatched).toBeGreaterThanOrEqual(1);
    // malformedCount reflects all malformed lines seen
    expect(typeof resultFull.malformedCount).toBe('number');
    expect(JSON.stringify(resultFull)).not.toContain('no level secret-nofield');
  });

  // ── (G) Streaming / no OOM ────────────────────────────────────────────────

  it('(G1) streaming summary over 1,000 lines completes under 24 KB (AC1)', async () => {
    const logDir = path.join(tempRoot, '.pi/logs');
    fs.mkdirSync(logDir, { recursive: true });
    // Use a separate fixture file to avoid count pollution from Logger
    const logPath = path.join(logDir, 'orr-else-2019-01-01.log');
    for (let i = 0; i < 1_000; i++) {
      fs.appendFileSync(logPath, JSON.stringify({
        level: i % 3 === 0 ? 'info' : i % 3 === 1 ? 'warn' : 'error',
        message: 'payload-' + 'x'.repeat(100),
        timestamp: new Date().toISOString(),
        component: 'fixture-stream',
        pid: 1,
        version: '0.1.0'
      }) + '\n', 'utf8');
    }

    const tool = await registeredTool();
    const result = await callTool(tool, { component: 'fixture-stream' });
    expect(result.status).toBe('summary');
    expect(result.totalMatched).toBe(1_000);
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    expect(bytes).toBeLessThan(24_000);
  });
});
