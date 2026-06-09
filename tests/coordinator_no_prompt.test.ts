/**
 * Coordinator no-prompt guard
 *
 * Two complementary verification layers:
 *
 * 1. STATIC guard — source-scan style (modelled on eventstore_only_guards.test.ts):
 *    Asserts that `buildStateSystemPrompt` and `new Teammate(` do NOT appear in the
 *    coordinator path of extension.ts (startOrrElse + handleTeammateEvent). The only
 *    call-site of `new Teammate(` must be inside the `if (isWorkerMode())` worker
 *    branch.  If prompt-computation code is ever accidentally added to the coordinator
 *    path, this test fails immediately.
 *
 * 2. BEHAVIORAL guard — TEAMMATE_SPAWNED event assertion:
 *    Verifies that claimAndSpawnBead (the spawn leg of the coordinator flow) causes a
 *    TEAMMATE_SPAWNED event to be recorded containing beadId, stateId, workerId, and
 *    worktreePath — proving that "records the assigned worker" is an EVENT, not Beads
 *    metadata.  The test drives the TeammateFactory.spawnTeammateInTmux mock so that
 *    it records the event itself (exactly as the real factory does), then asserts the
 *    event fields on the captured records.
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Supervisor } from '../src/core/Supervisor.js';
import { DomainEventName } from '../src/constants/index.js';
import type { Clock } from '../src/core/Clock.js';
import type { BeadsPort } from '../src/core/OrchestrationPorts.js';

// ─── shared helpers ───────────────────────────────────────────────────────────

const ROOT_DIR = path.resolve(process.cwd());
const EXT_FILE = path.join(ROOT_DIR, 'src', 'extension.ts');

function readExtensionSource(): string {
  return fs.readFileSync(EXT_FILE, 'utf8');
}

/** Return the zero-based line index for a given 1-based line number. */
function lineAt(lines: string[], lineNumber: number): string {
  return lines[lineNumber - 1] ?? '';
}

/** Strip single-line and JSDoc comment lines so scan results are precise. */
function isNonComment(line: string): boolean {
  return !/^\s*(?:\/\/|\*)/.test(line);
}

interface SourceMatch {
  line: number;
  text: string;
}

function scanLines(lines: string[], pattern: RegExp, fromLine: number, toLine: number): SourceMatch[] {
  const results: SourceMatch[] = [];
  for (let i = fromLine - 1; i < Math.min(toLine, lines.length); i++) {
    const raw = lines[i];
    if (!isNonComment(raw)) continue;
    if (pattern.test(raw)) results.push({ line: i + 1, text: raw.trim() });
  }
  return results;
}

// ─── locate coordinator-path boundaries in extension.ts ──────────────────────

/**
 * Find the line number of the first match of `pattern` in the source.
 * Returns -1 if not found.
 */
function findLineNumber(lines: string[], pattern: RegExp): number {
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return -1;
}

// ─── Part 1: STATIC guard ─────────────────────────────────────────────────────

describe('Coordinator no-prompt static guard (extension.ts source scan)', () => {

  it('`buildStateSystemPrompt` is not called inside startOrrElse', () => {
    // startOrrElse is the coordinator entry-point.  It must never call
    // buildStateSystemPrompt — that function belongs to the worker's
    // BEFORE_AGENT_START handler (gated by `if (!isWorkerMode()) return`).
    const lines = readExtensionSource().split('\n');

    const startLine = findLineNumber(lines, /^async function startOrrElse\b/);
    expect(startLine, 'startOrrElse not found in extension.ts').toBeGreaterThan(0);

    // Find the end of startOrrElse by scanning for the next top-level `^async function`
    // or `^function` or `^type ` declaration after startOrrElse starts.
    let endLine = lines.length;
    for (let i = startLine; i < lines.length; i++) {
      if (i === startLine - 1) continue; // skip the function's own declaration line
      if (/^(?:async function|function|type |class )\b/.test(lines[i])) {
        endLine = i; // exclusive
        break;
      }
    }

    const hits = scanLines(lines, /\bbuildStateSystemPrompt\b/, startLine + 1, endLine);
    expect(
      hits.map(h => `  extension.ts:${h.line}  ${h.text}`),
      [
        '`buildStateSystemPrompt` must NOT be called inside startOrrElse.',
        'Prompt computation belongs exclusively to the worker BEFORE_AGENT_START handler.',
        'Violations:'
      ].join('\n')
    ).toEqual([]);
  });

  it('`buildStateSystemPrompt` is not called inside handleTeammateEvent', () => {
    // handleTeammateEvent is the coordinator event-reaction path.  It records
    // events + coarse status but must never compute worker prompts.
    const lines = readExtensionSource().split('\n');

    const startLine = findLineNumber(lines, /^async function handleTeammateEvent\b/);
    expect(startLine, 'handleTeammateEvent not found in extension.ts').toBeGreaterThan(0);

    let endLine = lines.length;
    for (let i = startLine; i < lines.length; i++) {
      if (i === startLine - 1) continue;
      if (/^(?:async function|function|type |class )\b/.test(lines[i])) {
        endLine = i;
        break;
      }
    }

    const hits = scanLines(lines, /\bbuildStateSystemPrompt\b/, startLine + 1, endLine);
    expect(
      hits.map(h => `  extension.ts:${h.line}  ${h.text}`),
      [
        '`buildStateSystemPrompt` must NOT be called inside handleTeammateEvent.',
        'Prompt computation belongs exclusively to the worker BEFORE_AGENT_START handler.',
        'Violations:'
      ].join('\n')
    ).toEqual([]);
  });

  it('`new Teammate(` appears ONLY inside the `if (isWorkerMode())` worker branch, never in the coordinator path', () => {
    // The coordinator (startOrrElse + handleTeammateEvent + scanAndSpawn) must never
    // construct a Teammate — that class is the worker's execution harness.
    // All occurrences of `new Teammate(` must live inside the `if (isWorkerMode())`
    // branch that guards worker-only startup (the SESSION_INIT handler branch that
    // also calls initializeWorkerRun — there are multiple isWorkerMode() guards in
    // the file but only one actually enters worker mode by constructing a Teammate).
    //
    // Strategy: find the isWorkerMode() block that contains `initializeWorkerRun`
    // (the real worker entrypoint) and measure its extent via matching indentation
    // of the closing `}`.  Every `new Teammate(` must live within that window.
    //
    // Non-vacuity: the test asserts that `new Teammate(` occurs at least once in the
    // file (so the guard is not trivially satisfied by the class being removed), AND
    // that every occurrence is inside the correct worker branch.
    const lines = readExtensionSource().split('\n');

    // Find the isWorkerMode() branch that immediately precedes initializeWorkerRun.
    // There are several `if (isWorkerMode())` guards in extension.ts; we need the
    // one that actually enters worker mode (contains initializeWorkerRun).
    let workerBranchStart = -1;
    let workerBranchEnd = -1;

    for (let i = 0; i < lines.length; i++) {
      if (!/if \(isWorkerMode\(\)\)/.test(lines[i])) continue;
      // Scan ahead up to 5 lines for `initializeWorkerRun` — that marks the real branch.
      let foundInitialize = false;
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        if (/initializeWorkerRun/.test(lines[j])) {
          foundInitialize = true;
          break;
        }
      }
      if (!foundInitialize) continue;

      // Found the right branch.  Determine its end by finding the matching closing `}`
      // at the same or lower indentation level.  The branch body is indented more than
      // the `if` line itself.  The closing `}` that ends this block will be at a lower
      // or equal indentation to the `if`.
      workerBranchStart = i + 1; // 1-based

      // Count `{` depth from the `if` line's opening brace.
      const ifLine = lines[i];
      let depth = (ifLine.match(/\{/g) || []).length - (ifLine.match(/\}/g) || []).length;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        depth += (line.match(/\{/g) || []).length;
        depth -= (line.match(/\}/g) || []).length;
        if (depth <= 0) {
          workerBranchEnd = j + 1; // 1-based, inclusive
          break;
        }
      }
      break;
    }

    expect(workerBranchStart, 'isWorkerMode() branch containing initializeWorkerRun not found in extension.ts').toBeGreaterThan(0);
    expect(workerBranchEnd, 'Could not find closing } of isWorkerMode() worker branch').toBeGreaterThan(workerBranchStart);

    // All occurrences of `new Teammate(` anywhere in the file.
    const allTeammateConstructions = scanLines(lines, /\bnew Teammate\(/, 1, lines.length);

    // There must be at least one occurrence (non-vacuous guard).
    expect(
      allTeammateConstructions.length,
      '`new Teammate(` not found anywhere in extension.ts — guard is vacuous; update this test if Teammate was renamed/removed.'
    ).toBeGreaterThan(0);

    // Every occurrence must fall inside the worker branch.
    const outsideWorkerBranch = allTeammateConstructions.filter(
      m => m.line < workerBranchStart || m.line > workerBranchEnd
    );

    expect(
      outsideWorkerBranch.map(m => `  extension.ts:${m.line}  ${m.text}`),
      [
        '`new Teammate(` found outside the `if (isWorkerMode())` worker branch.',
        'The coordinator path (startOrrElse, handleTeammateEvent) must never construct a Teammate.',
        'Teammate construction belongs exclusively to the worker initialisation branch.',
        `Worker branch detected at lines ${workerBranchStart}–${workerBranchEnd}.`,
        'Violations:'
      ].join('\n')
    ).toEqual([]);
  });

  it('guard is non-vacuous: `buildStateSystemPrompt` exists in WorkerContextResolver (not just in comments)', () => {
    // pi-experiment-amq0.1: buildStateSystemPrompt was moved to
    // src/extension/WorkerContextResolver.ts as part of the injectable-services extraction.
    // The guard above (checking extension.ts) is still valid — it confirms the function
    // is not called inside the coordinator paths of extension.ts. This non-vacuousness
    // check now verifies the function exists in its new canonical location.
    const resolverFile = path.join(ROOT_DIR, 'src', 'extension', 'WorkerContextResolver.ts');
    const resolverSource = fs.readFileSync(resolverFile, 'utf8');
    const lines = resolverSource.split('\n');
    const definition = scanLines(lines, /^export function buildStateSystemPrompt\b/, 1, lines.length);
    expect(
      definition.length,
      '`buildStateSystemPrompt` function definition not found in WorkerContextResolver.ts — the guard above is vacuous; update if the function was renamed/removed.'
    ).toBeGreaterThan(0);
  });
});

// ─── Part 2: BEHAVIORAL guard — TEAMMATE_SPAWNED event ───────────────────────

const NOW_MS = Date.parse('2026-01-02T03:04:05.000Z');

function createFakeClock(nowMs = NOW_MS): Clock {
  return {
    now: () => nowMs,
    date: (timestampMs?: number) => new Date(timestampMs === undefined ? nowMs : timestampMs)
  };
}

function fakeBeadsPort(overrides: Partial<BeadsPort> = {}): BeadsPort {
  return {
    ready: vi.fn(async () => []),
    list: vi.fn(async () => ({ items: [] })),
    getBead: vi.fn(async (id) => ({ id } as any)),
    claim: vi.fn(async ({ id }) => ({ id } as any)),
    release: vi.fn(async () => {}),
    invalidateCache: vi.fn(),
    ...overrides
  };
}

describe('Coordinator TEAMMATE_SPAWNED event (behavioral guard)', () => {
  it('claimAndSpawnBead causes a TEAMMATE_SPAWNED event recording with beadId, stateId, workerId, and worktreePath', async () => {
    // Scenario: Supervisor.claimAndSpawnBead is the coordinator's per-bead spawn
    // routine.  After a successful claim + worktree provision + tmux spawn, the
    // factory's spawnTeammateInTmux emits a TEAMMATE_SPAWNED event into the event
    // store.  That event is the single source of truth for "which worker has which
    // bead" — the coordinator never writes Beads metadata for this purpose.
    //
    // The mock spawnTeammateInTmux captures arguments and records the same event
    // fields the real TeammateFactory.spawnTeammateInTmux records (teammates.ts:661).
    const records: Array<{ event: string; data: Record<string, unknown> }> = [];

    const BEAD_ID = 'bead-cng-01';
    const STATE_ID = 'Planning';
    const WORKER_ID = 'worker-cng-01';
    const WORKTREE_PATH = '/tmp/worktrees/bead-cng-01';
    const PANE_ID = '%42';

    const claim = vi.fn(async ({ id }: { id: string }) => ({ id } as any));
    const release = vi.fn(async () => {});
    const createWorktree = vi.fn(async () => ({ success: true, path: WORKTREE_PATH }));

    // spawnTeammateInTmux mock: records the TEAMMATE_SPAWNED event exactly as the
    // real TeammateFactory does, using a deterministic workerId so we can assert on
    // it.  The workerId in the real factory is derived inside spawnTeammateInTmux
    // (not passed from the Supervisor), so the test checks that the event is present
    // and contains the coordinator-knowable fields (beadId, stateId, worktreePath)
    // plus a workerId produced by the factory.
    const spawnTeammateInTmux = vi.fn(async (beadId: string, stateId: string, worktreePath: string) => {
      // Simulate what TeammateFactory.spawnTeammateInTmux does: record the event.
      records.push({
        event: DomainEventName.TEAMMATE_SPAWNED,
        data: {
          beadId,
          stateId,
          workerId: WORKER_ID,
          worktreePath,
          paneId: PANE_ID
        }
      });
      return { success: true, paneId: PANE_ID };
    });

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        spawnTeammateInTmux,
        getActiveTeammateCount: vi.fn(async () => 0),
        getAvailableSlots: vi.fn(async () => 1),
        terminateTeammatesForBead: vi.fn()
      } as any,
      { tracedAsync: (_n: string, _a: any, fn: any) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        eventStore: {
          record: vi.fn(async (event: string, data: Record<string, unknown>) => {
            records.push({ event, data });
          }),
          eventsForBeads: vi.fn(async () => new Map())
        },
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: { createWorktree },
        scheduler: {},
        flowManager: {}
      } as any,
      { maxSlots: 1, clock: createFakeClock() }
    );

    const bead = { id: BEAD_ID, stateId: STATE_ID, score: 0 } as any;
    const config = { settings: {} } as any;
    const result = await (supervisor as any).claimAndSpawnBead(bead, config);

    // Spawn must succeed.
    expect(result).toBe('spawned');

    // spawnTeammateInTmux must have been called once.
    expect(spawnTeammateInTmux).toHaveBeenCalledTimes(1);

    // --- The key assertion: TEAMMATE_SPAWNED event must have been recorded ---
    const spawnedEvent = records.find(r => r.event === DomainEventName.TEAMMATE_SPAWNED);
    expect(
      spawnedEvent,
      'TEAMMATE_SPAWNED event was not recorded — the coordinator is not using an event to track the assigned worker'
    ).toBeDefined();

    // The event data must contain all coordinator-required fields.
    expect(spawnedEvent!.data.beadId).toBe(BEAD_ID);
    expect(spawnedEvent!.data.stateId).toBe(STATE_ID);
    expect(typeof spawnedEvent!.data.workerId).toBe('string');
    expect((spawnedEvent!.data.workerId as string).length).toBeGreaterThan(0);
    expect(spawnedEvent!.data.worktreePath).toBe(WORKTREE_PATH);

    // CRITICAL: there must be NO additional metadata-write events (e.g. BD_UPDATE_STATUS
    // or similar) that carry prompt-selection or worker-assignment data — the event
    // store is the single source of truth for "which worker owns which bead".
    // (BEAD_CLAIMED is normal and expected; WORKTREE_PROVISIONED is also expected.)
    const unexpectedEvents = records.filter(r =>
      r.event !== DomainEventName.TEAMMATE_SPAWNED &&
      r.event !== DomainEventName.BEAD_CLAIMED &&
      r.event !== DomainEventName.WORKTREE_PROVISIONED &&
      // pi-experiment-6q0y.44 AC6: CONTEXT_INSTANCE_RECORDED is expected on every spawn.
      r.event !== DomainEventName.CONTEXT_INSTANCE_RECORDED
    );
    // There should be no unexpected events beyond the standard spawn sequence.
    // Any metadata-write event would indicate the coordinator is duplicating data.
    expect(unexpectedEvents.map(r => r.event)).toEqual([]);
  });

  it('claimAndSpawnBead records WORKTREE_PROVISIONED before TEAMMATE_SPAWNED (ordering invariant)', async () => {
    // The coordinator's spawn sequence must always emit WORKTREE_PROVISIONED before
    // TEAMMATE_SPAWNED so that any observer can reconstruct the full spawn chain from
    // the event log in order.
    const orderedEvents: string[] = [];

    const BEAD_ID = 'bead-order-01';
    const WORKTREE_PATH = '/tmp/worktrees/bead-order-01';

    const claim = vi.fn(async ({ id }: { id: string }) => ({ id } as any));
    const release = vi.fn(async () => {});
    const createWorktree = vi.fn(async () => ({ success: true, path: WORKTREE_PATH }));
    const spawnTeammateInTmux = vi.fn(async (beadId: string, stateId: string, worktreePath: string) => {
      orderedEvents.push(DomainEventName.TEAMMATE_SPAWNED);
      return { success: true, paneId: '%11' };
    });

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        spawnTeammateInTmux,
        getActiveTeammateCount: vi.fn(async () => 0),
        getAvailableSlots: vi.fn(async () => 1),
        terminateTeammatesForBead: vi.fn()
      } as any,
      { tracedAsync: (_n: string, _a: any, fn: any) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        eventStore: {
          record: vi.fn(async (event: string) => {
            orderedEvents.push(event);
          }),
          eventsForBeads: vi.fn(async () => new Map())
        },
        beadsPort: fakeBeadsPort({ claim, release }),
        worktreePort: { createWorktree },
        scheduler: {},
        flowManager: {}
      } as any,
      { maxSlots: 1, clock: createFakeClock() }
    );

    const bead = { id: BEAD_ID, stateId: 'Planning', score: 0 } as any;
    const config = { settings: {} } as any;
    await (supervisor as any).claimAndSpawnBead(bead, config);

    const worktreeIdx = orderedEvents.indexOf(DomainEventName.WORKTREE_PROVISIONED);
    const spawnedIdx = orderedEvents.indexOf(DomainEventName.TEAMMATE_SPAWNED);

    expect(worktreeIdx, 'WORKTREE_PROVISIONED must appear in the event stream').toBeGreaterThanOrEqual(0);
    expect(spawnedIdx, 'TEAMMATE_SPAWNED must appear in the event stream').toBeGreaterThanOrEqual(0);
    expect(
      worktreeIdx,
      'WORKTREE_PROVISIONED must be recorded BEFORE TEAMMATE_SPAWNED'
    ).toBeLessThan(spawnedIdx);
  });
});
