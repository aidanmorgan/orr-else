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
 *   (H) beadId/workerId resolution via persisted TEAMMATE_SPAWNED events (AC1).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuiltInToolName, DomainEventName } from '../src/constants/domain.js';
import { EnvVars, PiEventName, sanitizePaneId } from '../src/constants/infra.js';
import { Logger } from '../src/core/Logger.js';
import { writeFixtureEvent } from './support/TestEventStore.js';
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
    // Uses the shared sanitizePaneId from infra.ts — same function as teammates.ts writer.
    const filename = sanitizePaneId(paneId) + '.log';
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

  it('(C1) reasoning block opening BEFORE tail window still redacts secrets INSIDE tail window (AC5)', async () => {
    // Proves redaction is applied to the FULL transcript BEFORE the tail is sliced.
    //
    // Layout (90 lines total → truncated to last 80):
    //   line  0     : <thinking>  ← open marker falls OUTSIDE the 80-line tail
    //   lines 1-89  : 89 × "secret reasoning line N"  ← all in tail window
    //
    // Redact-before-truncation (correct):
    //   The redactor sees <thinking> on line 0, opens the block, suppresses all 89
    //   secret lines, and emits a single [reasoning redacted] placeholder.
    //   The tail slice contains only the placeholder — secrets are absent.
    //
    // Truncate-before-redact (wrong order — mutation catches this):
    //   The tail starts at line 10, so <thinking> is gone.  The redactor sees
    //   89 plain-text "secret reasoning line N" lines with no open marker and
    //   emits them unchanged — secrets appear in the output.
    const lines: string[] = [];
    lines.push('<thinking>');
    for (let i = 0; i < 89; i++) lines.push(`secret reasoning line ${i}`);
    // Total: 90 lines → tail = lines 10-89 (all secret lines, no open marker)

    writeTranscript('%55', lines.join('\n'));

    const tool = await registeredTool();
    const result = await callTool(tool, { paneId: '%55' });
    expect(result.status).toBe('found');
    const tailText = result.tailLines.join('\n');
    // Sensitive content must be absent when redaction precedes truncation.
    // If redaction were skipped (mutation), the 80-line tail slice would return
    // 80 raw "secret reasoning line N" lines — this assertion would then fail.
    expect(tailText).not.toContain('secret reasoning line');
    // The redactor replaces suppressed blocks with a placeholder.
    expect(tailText).toContain('[reasoning redacted]');
  });

  it('(C2) reasoning block in beadId-resolved transcript is redacted (AC5)', async () => {
    // Same redaction guarantee must hold on the beadId resolution path.
    // Transcript has a <thinking> block within the 80-line tail window.
    const lines: string[] = [];
    lines.push('<thinking>');
    for (let i = 0; i < 5; i++) lines.push(`bead secret reasoning ${i}`);
    lines.push('</thinking>');
    for (let i = 0; i < 10; i++) lines.push(`bead action line ${i}`);

    writeTranscript('%56', lines.join('\n'));
    await writeFixtureEvent(tempRoot, DomainEventName.TEAMMATE_SPAWNED, {
      beadId: 'bd-redact-test',
      stateId: 'Planning',
      workerId: 'w-redact-test',
      paneId: '%56'
    });

    const tool = await registeredTool();
    const result = await callTool(tool, { beadId: 'bd-redact-test' });
    expect(result.status).toBe('found');
    const tailText = result.tailLines.join('\n');
    expect(tailText).not.toContain('bead secret reasoning');
    expect(tailText).toContain('[reasoning redacted]');
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

  // ── (H) beadId / workerId resolution via TEAMMATE_SPAWNED events ─────────

  it('(H1) beadId resolves to the correct pane transcript', async () => {
    const content = 'beadId resolution output';
    writeTranscript('%30', content);
    await writeFixtureEvent(tempRoot, DomainEventName.TEAMMATE_SPAWNED, {
      beadId: 'bd-test-1',
      stateId: 'Planning',
      workerId: 'w-test-1',
      paneId: '%30'
    });

    const tool = await registeredTool();
    const result = await callTool(tool, { beadId: 'bd-test-1' });
    expect(result.status).toBe('found');
    expect(result.tailLines.join('\n')).toContain('beadId resolution output');
  });

  it('(H2) workerId resolves to the correct pane transcript', async () => {
    const content = 'workerId resolution output';
    writeTranscript('%31', content);
    await writeFixtureEvent(tempRoot, DomainEventName.TEAMMATE_SPAWNED, {
      beadId: 'bd-test-2',
      stateId: 'Planning',
      workerId: 'w-test-2',
      paneId: '%31'
    });

    const tool = await registeredTool();
    const result = await callTool(tool, { workerId: 'w-test-2' });
    expect(result.status).toBe('found');
    expect(result.tailLines.join('\n')).toContain('workerId resolution output');
  });

  it('(H3) latest-wins: multiple TEAMMATE_SPAWNED events for same bead — last pane wins', async () => {
    writeTranscript('%40', 'old pane content');
    writeTranscript('%41', 'new pane content');
    // Write first spawn, then a later spawn with a different pane.
    // writeFixtureEvent uses new Date().toISOString() for each call; adding a small
    // delay is not needed because we rely on event ID ordering (uuidv7 is time-ordered).
    await writeFixtureEvent(tempRoot, DomainEventName.TEAMMATE_SPAWNED, {
      beadId: 'bd-multi',
      stateId: 'Planning',
      workerId: 'w-multi-1',
      paneId: '%40'
    });
    // Second spawn written after first — higher timestamp/ID, so it's "latest"
    await writeFixtureEvent(tempRoot, DomainEventName.TEAMMATE_SPAWNED, {
      beadId: 'bd-multi',
      stateId: 'Planning',
      workerId: 'w-multi-2',
      paneId: '%41'
    });

    const tool = await registeredTool();
    const result = await callTool(tool, { beadId: 'bd-multi' });
    expect(result.status).toBe('found');
    // Must resolve to the LATEST spawn's pane (%41), not the first (%40)
    expect(result.tailLines.join('\n')).toContain('new pane content');
    expect(result.tailLines.join('\n')).not.toContain('old pane content');
  });

  it('(H4) beadId with no matching TEAMMATE_SPAWNED event returns not_found', async () => {
    const tool = await registeredTool();
    const result = await callTool(tool, { beadId: 'bd-nonexistent' });
    expect(result.status).toBe('not_found');
    expect(result.reason).toBeDefined();
  });

  it('(H5) beadId with TEAMMATE_SPAWNED missing paneId returns not_found', async () => {
    // Write a spawn event without a paneId field
    await writeFixtureEvent(tempRoot, DomainEventName.TEAMMATE_SPAWNED, {
      beadId: 'bd-no-pane',
      stateId: 'Planning',
      workerId: 'w-no-pane'
      // paneId intentionally omitted
    });

    const tool = await registeredTool();
    const result = await callTool(tool, { beadId: 'bd-no-pane' });
    expect(result.status).toBe('not_found');
    expect(result.reason).toBeDefined();
  });

  it('(H6) beadId with TEAMMATE_SPAWNED but missing transcript file returns not_found', async () => {
    // Record spawn event with a pane that has no transcript file on disk
    await writeFixtureEvent(tempRoot, DomainEventName.TEAMMATE_SPAWNED, {
      beadId: 'bd-missing-file',
      stateId: 'Planning',
      workerId: 'w-missing-file',
      paneId: '%99'
      // no transcript file written
    });

    const tool = await registeredTool();
    const result = await callTool(tool, { beadId: 'bd-missing-file' });
    expect(result.status).toBe('not_found');
    expect(result.reason).toBeDefined();
  });
});
