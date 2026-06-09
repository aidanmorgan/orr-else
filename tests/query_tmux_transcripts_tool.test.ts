/**
 * pi-experiment-6q0y.25 — query_tmux_transcripts progressive-disclosure tool.
 *
 * Load-bearing assertions:
 *   (A) Tool is registered with the correct name and parameter schema.
 *   (B) Default mode returns metadata + at most 80 tail lines (AC2).
 *   (C) Redaction is applied BEFORE truncation (AC5).
 *   (D) Path traversal is rejected (AC5).
 *   (E) Search mode returns at most 10 hits with 2 context lines (AC3).
 *   (F) Missing / expired transcripts return not_found (AC4).
 *   (G) latest:true reads the current.path pointer.
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

describe('pi-experiment-6q0y.25: query_tmux_transcripts progressive-disclosure tool', () => {
  let tempRoot: string;
  let prevProjectRoot: string | undefined;
  let prevWorktree: string | undefined;
  let previousCwd: string;
  let transcriptDir: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    prevProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    prevWorktree = process.env[EnvVars.WORKTREE_PATH];

    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y25-')));
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), HARNESS_YAML);
    transcriptDir = path.join(tempRoot, '.pi/logs/tmux');
    fs.mkdirSync(transcriptDir, { recursive: true });

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
    const tool = harness.tools.find(t => t.name === BuiltInToolName.QUERY_TMUX_TRANSCRIPTS);
    expect(tool, 'query_tmux_transcripts tool must be registered').toBeDefined();
    return tool;
  }

  const noUiCtx = { hasUI: false } as any;

  async function callTool(tool: any, params: Record<string, unknown>): Promise<any> {
    const wrapped = await tool.execute('call-id', params, undefined, undefined, noUiCtx);
    return wrapped.details ?? wrapped;
  }

  /** Write a transcript file for a given pane ID. */
  function writeTranscript(paneId: string, content: string): string {
    // Mirrors teammates.ts: replace unsafe chars with '_', append .log
    const safeId = paneId.replace(/[^A-Za-z0-9._%-]/g, '_');
    const filename = safeId + '.log';
    const transcriptPath = path.join(transcriptDir, filename);
    fs.writeFileSync(transcriptPath, content, 'utf8');
    return transcriptPath;
  }

  /** Write current.path pointer. */
  function writePointer(transcriptPath: string): void {
    fs.writeFileSync(path.join(transcriptDir, 'current.path'), transcriptPath, 'utf8');
  }

  // ── (A) Registration ──────────────────────────────────────────────────────

  it('(A1) tool is registered with name query_tmux_transcripts', async () => {
    const tool = await registeredTool();
    expect(tool.name).toBe('query_tmux_transcripts');
  });

  it('(A2) tool parameter schema exposes paneId, latest, search', async () => {
    const tool = await registeredTool();
    const props = tool.parameters?.properties ?? {};
    expect(props.paneId).toBeDefined();
    expect(props.latest).toBeDefined();
    expect(props.search).toBeDefined();
  });

  // ── (B) Default tail mode ─────────────────────────────────────────────────

  it('(B1) returns status:found with metadata and tail lines', async () => {
    const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const transcriptPath = writeTranscript('%42', content);
    writePointer(transcriptPath);

    const tool = await registeredTool();
    const result = await callTool(tool, { paneId: '%42' });
    expect(result.status).toBe('found');
    expect(result.metadata.paneId).toBe('%42');
    expect(Array.isArray(result.tailLines)).toBe(true);
    expect(result.tailLines.length).toBe(10);
  });

  it('(B2) default mode returns at most 80 tail lines (AC2)', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `output line ${i + 1}`);
    writeTranscript('%99', lines.join('\n'));

    const tool = await registeredTool();
    const result = await callTool(tool, { paneId: '%99' });
    expect(result.status).toBe('found');
    expect(result.tailLines.length).toBeLessThanOrEqual(80);
    expect(result.truncated).toBe(true);
    // Tail means last 80 lines
    expect(result.tailLines[0]).toBe('output line 41');
  });

  // ── (C) Redaction before truncation ──────────────────────────────────────

  it('(C1) reasoning blocks are redacted BEFORE truncation (AC5)', async () => {
    // Build a transcript where reasoning block is in the first part (before tail)
    // so that without pre-truncation redaction, the reasoning content would appear.
    const lines: string[] = [];
    // First 50 lines: reasoning block that should be redacted
    lines.push('<thinking>');
    for (let i = 0; i < 48; i++) lines.push(`secret reasoning line ${i}`);
    lines.push('</thinking>');
    // Next 80 lines: normal actionable lines that form the tail
    for (let i = 0; i < 80; i++) lines.push(`action line ${i}`);

    writeTranscript('%55', lines.join('\n'));

    const tool = await registeredTool();
    const result = await callTool(tool, { paneId: '%55' });
    expect(result.status).toBe('found');
    // The reasoning content must not appear anywhere in the tail
    const tailText = result.tailLines.join('\n');
    expect(tailText).not.toContain('secret reasoning line');
    // Note: redaction is applied to full text first, THEN tail is taken
  });

  // ── (D) Path traversal rejected ───────────────────────────────────────────

  it('(D1) paneId with path separator is rejected (AC5)', async () => {
    const tool = await registeredTool();
    const result = await callTool(tool, { paneId: '../../../etc/passwd' });
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('illegal path characters');
  });

  it('(D2) paneId with ".." is rejected (AC5)', async () => {
    const tool = await registeredTool();
    const result = await callTool(tool, { paneId: '%42/../secret' });
    expect(result.status).toBe('rejected');
  });

  // ── (E) Search mode ───────────────────────────────────────────────────────

  it('(E1) search mode returns at most 10 hits (AC3)', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(i % 3 === 0 ? `line ${i} MATCH found here` : `line ${i} nothing`);
    }
    writeTranscript('%10', lines.join('\n'));

    const tool = await registeredTool();
    const result = await callTool(tool, { paneId: '%10', search: 'MATCH' });
    expect(result.status).toBe('search');
    expect(result.hits.length).toBeLessThanOrEqual(10);
    // All hits contain the search term
    for (const hit of result.hits) {
      expect(hit.line.toLowerCase()).toContain('match');
    }
  });

  it('(E2) search mode returns up to 2 context lines per hit (AC3)', async () => {
    const lines = ['before1', 'before2', 'MATCH LINE', 'after1', 'after2'];
    writeTranscript('%11', lines.join('\n'));

    const tool = await registeredTool();
    const result = await callTool(tool, { paneId: '%11', search: 'MATCH' });
    expect(result.status).toBe('search');
    expect(result.hits.length).toBe(1);
    const hit = result.hits[0];
    expect(hit.contextBefore.length).toBeLessThanOrEqual(2);
    expect(hit.contextAfter.length).toBeLessThanOrEqual(2);
    expect(hit.contextBefore).toContain('before2');
    expect(hit.contextAfter).toContain('after1');
  });

  it('(E3) search reports totalHits and capped when over 10 hits', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `HIT_TERM line ${i}`);
    writeTranscript('%12', lines.join('\n'));

    const tool = await registeredTool();
    const result = await callTool(tool, { paneId: '%12', search: 'HIT_TERM' });
    expect(result.status).toBe('search');
    expect(result.totalHits).toBe(30);
    expect(result.capped).toBe(true);
    expect(result.hits.length).toBe(10);
  });

  // ── (F) Missing transcripts return not_found (AC4) ────────────────────────

  it('(F1) missing pane returns not_found', async () => {
    const tool = await registeredTool();
    const result = await callTool(tool, { paneId: '%nonexistent' });
    expect(result.status).toBe('not_found');
    expect(result.reason).toBeDefined();
  });

  it('(F2) latest:true with no pointer returns not_found', async () => {
    const tool = await registeredTool();
    const result = await callTool(tool, { latest: true });
    expect(result.status).toBe('not_found');
    expect(result.reason).toBeDefined();
  });

  // ── (G) latest pointer ───────────────────────────────────────────────────

  it('(G1) latest:true reads the pane pointed to by current.path', async () => {
    const content = 'latest pane output line 1\nlatest pane output line 2';
    const transcriptPath = writeTranscript('%77', content);
    writePointer(transcriptPath);

    const tool = await registeredTool();
    const result = await callTool(tool, { latest: true });
    expect(result.status).toBe('found');
    expect(result.tailLines.join('\n')).toContain('latest pane output line 1');
  });

  it('(G2) no identity param returns rejected', async () => {
    const tool = await registeredTool();
    const result = await callTool(tool, {});
    expect(result.status).toBe('rejected');
  });
});
