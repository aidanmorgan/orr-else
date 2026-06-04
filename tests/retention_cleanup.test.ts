import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RetentionCleanup } from '../src/core/RetentionCleanup.js';
import {
  DomainEventName,
  EventStoreDefaults,
  REPLAY_CRITICAL_EVENT_TYPES,
  RetentionDefaults
} from '../src/constants/index.js';
import { BeadStateProjection } from '../src/core/BeadStateProjection.js';
import { EventStore } from '../src/core/EventStore.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Logger } from '../src/core/Logger.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';
import type { Clock } from '../src/core/Clock.js';
import type { RetentionConfig } from '../src/core/domain/StateModels.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Fixed "now" used throughout tests. */
const NOW_MS = Date.parse('2026-03-15T12:00:00.000Z');

function fakeClock(nowMs = NOW_MS): Clock {
  return {
    now: () => nowMs,
    date: (ts?: number) => new Date(ts === undefined ? nowMs : ts)
  };
}

function fakeEventStore() {
  const records: Array<{ event: string; data: unknown }> = [];
  return {
    record: vi.fn(async (event: string, data: unknown) => {
      records.push({ event, data });
    }),
    records
  };
}

/**
 * Create a temporary project root with the standard harness-owned directories
 * (.pi/logs, .tmp, .pi/.trash, .pi/events) pre-created.
 */
function makeTmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
  fs.mkdirSync(path.join(root, '.pi', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.pi', 'events'), { recursive: true });
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, '.pi', '.trash'), { recursive: true });
  return root;
}

/**
 * Write a file and then explicitly set its mtime.
 */
function writeFileWithMtime(filePath: string, content: string, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  const mtimeSec = mtimeMs / 1000;
  fs.utimesSync(filePath, mtimeSec, mtimeSec);
}

/**
 * Create a directory and set its mtime.
 */
function makeDirWithMtime(dirPath: string, mtimeMs: number): void {
  fs.mkdirSync(dirPath, { recursive: true });
  const mtimeSec = mtimeMs / 1000;
  fs.utimesSync(dirPath, mtimeSec, mtimeSec);
}

/**
 * Build a DomainEvent fixture.
 */
function makeEvent(
  type: string,
  beadId: string,
  timestampMs: number,
  extra: Record<string, unknown> = {}
): DomainEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    timestamp: new Date(timestampMs).toISOString(),
    sessionId: 'test-session',
    data: { beadId, ...extra }
  };
}

/**
 * Write an array of events as a JSONL file and set its mtime.
 */
function writeEventsJsonl(filePath: string, events: DomainEvent[], mtimeMs?: number): void {
  const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, content);
  if (mtimeMs !== undefined) {
    const s = mtimeMs / 1000;
    fs.utimesSync(filePath, s, s);
  }
}

/**
 * Read a JSONL file and parse all lines into DomainEvent objects (skipping blanks/invalid).
 */
function readEventsJsonl(filePath: string): DomainEvent[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split('\n')
    .filter(l => l.trim())
    .map(l => {
      try { return JSON.parse(l) as DomainEvent; } catch { return null; }
    })
    .filter((e): e is DomainEvent => e !== null);
}

/**
 * Project a list of events to a BeadStateChartProjection (the canonical oracle).
 * This is what compaction must preserve exactly.
 */
function project(events: DomainEvent[], beadId: string) {
  const projection = new BeadStateProjection();
  return projection.projectBeadStateChartFromEvents(beadId, events);
}

/**
 * Project a list of events to a HarnessBeadMetadata projection (the second oracle).
 */
function projectMeta(events: DomainEvent[], beadId: string) {
  const projection = new BeadStateProjection();
  return projection.projectBeadFromEvents(beadId, events);
}

// ---------------------------------------------------------------------------
// Tests (original suite — unchanged behavior)
// ---------------------------------------------------------------------------

describe('RetentionCleanup', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── Age filtering ─────────────────────────────────────────────────────────

  it('removes files older than the 2-day threshold', async () => {
    const oldFile = path.join(tmpRoot, '.pi', 'logs', 'old.log');
    const oldMtime = NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS; // 1 hour past the threshold
    writeFileWithMtime(oldFile, 'old content', oldMtime);

    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(tmpRoot, fakeClock(), es as any, TWO_DAYS_MS);
    const result = await cleanup.run();

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(result.totalFilesRemoved).toBeGreaterThanOrEqual(1);
    expect(result.totalBytesReclaimed).toBeGreaterThan(0);
  });

  it('keeps files newer than the 2-day threshold', async () => {
    const newFile = path.join(tmpRoot, '.pi', 'logs', 'new.log');
    const newMtime = NOW_MS - ONE_HOUR_MS; // well within the threshold
    writeFileWithMtime(newFile, 'new content', newMtime);

    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(tmpRoot, fakeClock(), es as any, TWO_DAYS_MS);
    await cleanup.run();

    expect(fs.existsSync(newFile)).toBe(true);
  });

  it('removes old directory trees in .tmp (non-tool-calls entries)', async () => {
    // Place the old dir directly under .tmp (not inside tool-calls), so the
    // generic top-level age scan applies.  The tool-calls subdir requires a live
    // bead supplier (tested separately in the live-bead protection suite).
    const oldDir = path.join(tmpRoot, '.tmp', 'scratch-old');
    const oldMtime = NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS;
    const nestedFile = path.join(oldDir, 'some-output.json');
    writeFileWithMtime(nestedFile, '{}', oldMtime);
    makeDirWithMtime(oldDir, oldMtime);

    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(tmpRoot, fakeClock(), es as any, TWO_DAYS_MS);
    const result = await cleanup.run();

    expect(fs.existsSync(oldDir)).toBe(false);
    expect(result.totalDirsRemoved).toBeGreaterThanOrEqual(1);
  });

  it('removes old tool-calls bead dirs in .tmp when a live-bead supplier is provided with an empty live set', async () => {
    const beadDir = path.join(tmpRoot, '.tmp', 'tool-calls', 'bead-1');
    const oldMtime = NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS;
    const nestedFile = path.join(beadDir, 'state', 'output.json');
    writeFileWithMtime(nestedFile, '{}', oldMtime);
    makeDirWithMtime(beadDir, oldMtime);

    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(),
      es as any,
      TWO_DAYS_MS,
      () => new Set() // empty live set — bead-1 is not live, so its dir is eligible
    );
    const result = await cleanup.run();

    expect(fs.existsSync(beadDir)).toBe(false);
    expect(result.totalDirsRemoved).toBeGreaterThanOrEqual(1);
  });

  it('removes old entries in .pi/.trash', async () => {
    const oldTrash = path.join(tmpRoot, '.pi', '.trash', 'bead-old');
    const oldMtime = NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS;
    const trashedFile = path.join(oldTrash, 'some-file.ts');
    writeFileWithMtime(trashedFile, 'deleted', oldMtime);
    makeDirWithMtime(oldTrash, oldMtime);

    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(tmpRoot, fakeClock(), es as any, TWO_DAYS_MS);
    const result = await cleanup.run();

    expect(fs.existsSync(oldTrash)).toBe(false);
    expect(result.totalDirsRemoved).toBeGreaterThanOrEqual(1);
  });

  it('keeps newer entries alongside older ones in the same area', async () => {
    const logsDir = path.join(tmpRoot, '.pi', 'logs');

    const oldFile = path.join(logsDir, 'old.log');
    writeFileWithMtime(oldFile, 'old', NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS);

    const newFile = path.join(logsDir, 'new.log');
    writeFileWithMtime(newFile, 'new', NOW_MS - ONE_HOUR_MS);

    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(tmpRoot, fakeClock(), es as any, TWO_DAYS_MS);
    await cleanup.run();

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
  });

  // ── Bounded output ────────────────────────────────────────────────────────

  it('emits a RETENTION_CLEANUP_COMPLETED event with counts only (no path list)', async () => {
    const oldFile = path.join(tmpRoot, '.pi', 'logs', 'old.log');
    writeFileWithMtime(oldFile, 'data', NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS);

    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(tmpRoot, fakeClock(), es as any, TWO_DAYS_MS);
    await cleanup.run();

    expect(es.record).toHaveBeenCalledWith(
      'RETENTION_CLEANUP_COMPLETED',
      expect.any(Object)
    );
    const cleanupCall = es.record.mock.calls.find(([event]) => event === 'RETENTION_CLEANUP_COMPLETED');
    expect(cleanupCall).toBeDefined();
    const [, eventData] = cleanupCall as [string, Record<string, unknown>];

    // Must have aggregate counts.
    expect(typeof eventData.totalFilesRemoved).toBe('number');
    expect(typeof eventData.totalDirsRemoved).toBe('number');
    expect(typeof eventData.totalBytesReclaimed).toBe('number');
    expect(typeof eventData.totalErrors).toBe('number');

    // Must NOT contain a raw list of removed paths.
    const serialized = JSON.stringify(eventData);
    expect(serialized).not.toContain(oldFile);
    expect(serialized).not.toContain(path.join(tmpRoot, '.pi', 'logs'));
  });

  it('emits the event even when nothing is removed', async () => {
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(tmpRoot, fakeClock(), es as any, TWO_DAYS_MS);
    await cleanup.run();

    expect(es.record).toHaveBeenCalledWith('RETENTION_CLEANUP_COMPLETED', expect.any(Object));
    const cleanupCall = es.record.mock.calls.find(([event]) => event === 'RETENTION_CLEANUP_COMPLETED');
    const [, eventData] = cleanupCall as [string, Record<string, unknown>];
    expect(eventData.totalFilesRemoved).toBe(0);
    expect(eventData.totalDirsRemoved).toBe(0);
  });

  // ── Missing-directory no-op ───────────────────────────────────────────────

  it('treats a missing harness area directory as a no-op (does not throw)', async () => {
    // Remove all pre-created harness directories so all areas are absent.
    fs.rmSync(path.join(tmpRoot, '.pi'), { recursive: true, force: true });
    fs.rmSync(path.join(tmpRoot, '.tmp'), { recursive: true, force: true });

    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(tmpRoot, fakeClock(), es as any, TWO_DAYS_MS);

    await expect(cleanup.run()).resolves.toMatchObject({
      totalFilesRemoved: 0,
      totalDirsRemoved: 0,
      totalErrors: 0
    });
  });

  // ── Per-entry error isolation ─────────────────────────────────────────────

  it('continues scanning other entries after a single per-entry stat error', async () => {
    const logsDir = path.join(tmpRoot, '.pi', 'logs');

    // Create a valid old file that should be removed.
    const oldFile = path.join(logsDir, 'removable.log');
    writeFileWithMtime(oldFile, 'old', NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS);

    // Cause a stat error for a phantom directory entry by writing a symlink
    // pointing to a non-existent target, then set its mtime to be old.
    // statSync() on a broken symlink throws on some platforms (ENOENT).
    // We will create the broken symlink to trigger the per-entry error path.
    const brokenLink = path.join(logsDir, 'broken-link');
    try {
      fs.symlinkSync('/nonexistent-path-that-does-not-exist-12345', brokenLink);
      // Set the symlink's mtime via lutimes if available, or skip.
      try {
        fs.lutimesSync(brokenLink, (NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS) / 1000, (NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS) / 1000);
      } catch {
        // lutimes is not available on all platforms; silently skip.
      }
    } catch {
      // If symlink creation fails (e.g. permissions), just skip this part.
    }

    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(tmpRoot, fakeClock(), es as any, TWO_DAYS_MS);

    // Should not throw, regardless of symlink behaviour.
    const result = await cleanup.run();

    // The valid old file should still be removed.
    // (The broken symlink may or may not be removed depending on platform behaviour.)
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(result).toMatchObject({
      totalFilesRemoved: expect.any(Number),
      totalDirsRemoved: expect.any(Number),
      totalErrors: expect.any(Number)
    });
  });

  // ── Named constants ───────────────────────────────────────────────────────

  it('uses RetentionDefaults.MAX_AGE_MS = 2 days by default', () => {
    expect(RetentionDefaults.MAX_AGE_MS).toBe(TWO_DAYS_MS);
  });

  it('uses RetentionDefaults.CLEANUP_INTERVAL_MS = 1 hour by default', () => {
    expect(RetentionDefaults.CLEANUP_INTERVAL_MS).toBe(ONE_HOUR_MS);
  });

  // ── eventsCompacted field present ─────────────────────────────────────────

  it('always includes eventsCompacted field in result (0 when compaction disabled)', async () => {
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(tmpRoot, fakeClock(), es as any, TWO_DAYS_MS);
    const result = await cleanup.run();
    expect(result.eventsCompacted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FIX 1: Symlink confinement — symlink target outside harness roots is never touched
// ---------------------------------------------------------------------------

describe('RetentionCleanup symlink confinement', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('removes a symlink to an external directory without touching the link target', async () => {
    // Create a real external directory with a file OUTSIDE the harness roots.
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-external-'));
    const externalFile = path.join(externalDir, 'important.ts');
    fs.writeFileSync(externalFile, 'real source code');

    try {
      // Place a symlink inside .pi/.trash pointing at the external directory.
      // This simulates a user trashing a symlink that points into the source tree.
      const symlinkInTrash = path.join(tmpRoot, '.pi', '.trash', 'linked-dir');
      fs.symlinkSync(externalDir, symlinkInTrash);

      // Set the symlink's own mtime to be well past the threshold so cleanup
      // considers it old enough to remove (lutimes on the link, not the target).
      const oldMtimeSec = (NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS) / 1000;
      try {
        fs.lutimesSync(symlinkInTrash, oldMtimeSec, oldMtimeSec);
      } catch {
        // lutimes unavailable on this platform — skip the mtime set; the symlink
        // was just created (recent mtime) so the cleanup may keep it, which is also
        // safe. We only assert on the external directory, not the link removal.
      }

      const es = fakeEventStore();
      const cleanup = new RetentionCleanup(tmpRoot, fakeClock(), es as any, TWO_DAYS_MS);
      await cleanup.run();

      // The external directory and its file MUST remain completely untouched.
      expect(fs.existsSync(externalDir)).toBe(true);
      expect(fs.existsSync(externalFile)).toBe(true);
      expect(fs.readFileSync(externalFile, 'utf8')).toBe('real source code');

      // The symlink itself should have been removed (if mtime was settable and old).
      // We assert only on the external target — whether the symlink itself was
      // removed depends on lutimes availability, which is platform-specific.
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('removes a broken symlink (dangling link) without throwing', async () => {
    const brokenLink = path.join(tmpRoot, '.pi', '.trash', 'broken');
    fs.symlinkSync('/nonexistent-path-does-not-exist-99999', brokenLink);
    const oldMtimeSec = (NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS) / 1000;
    try {
      fs.lutimesSync(brokenLink, oldMtimeSec, oldMtimeSec);
    } catch { /* lutimes unavailable */ }

    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(tmpRoot, fakeClock(), es as any, TWO_DAYS_MS);
    // Must not throw regardless of platform symlink/mtime behaviour.
    await expect(cleanup.run()).resolves.toMatchObject({
      totalErrors: expect.any(Number)
    });
  });
});

// ---------------------------------------------------------------------------
// FIX 2: Live-bead protection for .tmp/tool-calls
// ---------------------------------------------------------------------------

describe('RetentionCleanup tool-calls live-bead protection', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('preserves a tool-calls bead dir whose beadId is in the live set even when mtime is old', async () => {
    const liveBeadId = 'bead-live-001';
    const liveBeadDir = path.join(tmpRoot, '.tmp', 'tool-calls', liveBeadId);
    const liveFile = path.join(liveBeadDir, 'Planning', 'tool-output.json');
    const oldMtime = NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS;
    writeFileWithMtime(liveFile, '{}', oldMtime);
    makeDirWithMtime(liveBeadDir, oldMtime);

    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(),
      es as any,
      TWO_DAYS_MS,
      () => new Set([liveBeadId])
    );
    await cleanup.run();

    // The live bead directory must NOT have been removed.
    expect(fs.existsSync(liveBeadDir)).toBe(true);
    expect(fs.existsSync(liveFile)).toBe(true);
  });

  it('removes a tool-calls bead dir whose beadId is NOT in the live set when mtime is old', async () => {
    const deadBeadId = 'bead-dead-002';
    const deadBeadDir = path.join(tmpRoot, '.tmp', 'tool-calls', deadBeadId);
    const deadFile = path.join(deadBeadDir, 'Planning', 'tool-output.json');
    const oldMtime = NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS;
    writeFileWithMtime(deadFile, '{}', oldMtime);
    makeDirWithMtime(deadBeadDir, oldMtime);

    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(),
      es as any,
      TWO_DAYS_MS,
      () => new Set(['some-other-live-bead'])
    );
    const result = await cleanup.run();

    expect(fs.existsSync(deadBeadDir)).toBe(false);
    expect(result.totalDirsRemoved).toBeGreaterThanOrEqual(1);
  });

  it('preserves a live bead dir while removing a dead bead dir in the same tool-calls area', async () => {
    const liveBeadId = 'bead-live-003';
    const deadBeadId = 'bead-dead-003';
    const oldMtime = NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS;

    const liveBeadDir = path.join(tmpRoot, '.tmp', 'tool-calls', liveBeadId);
    writeFileWithMtime(path.join(liveBeadDir, 'out.json'), '{}', oldMtime);
    makeDirWithMtime(liveBeadDir, oldMtime);

    const deadBeadDir = path.join(tmpRoot, '.tmp', 'tool-calls', deadBeadId);
    writeFileWithMtime(path.join(deadBeadDir, 'out.json'), '{}', oldMtime);
    makeDirWithMtime(deadBeadDir, oldMtime);

    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(),
      es as any,
      TWO_DAYS_MS,
      () => new Set([liveBeadId])
    );
    await cleanup.run();

    expect(fs.existsSync(liveBeadDir)).toBe(true);
    expect(fs.existsSync(deadBeadDir)).toBe(false);
  });

  it('does NOT remove the tool-calls parent directory itself', async () => {
    const toolCallsRoot = path.join(tmpRoot, '.tmp', 'tool-calls');
    fs.mkdirSync(toolCallsRoot, { recursive: true });
    const oldMtimeSec = (NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS) / 1000;
    fs.utimesSync(toolCallsRoot, oldMtimeSec, oldMtimeSec);

    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(),
      es as any,
      TWO_DAYS_MS,
      () => new Set()
    );
    await cleanup.run();

    // The tool-calls parent dir must never be deleted by retention cleanup.
    expect(fs.existsSync(toolCallsRoot)).toBe(true);
  });

  it('skips the entire tool-calls area when liveBeadIds supplier throws (fail-safe)', async () => {
    const beadId = 'bead-would-be-deleted';
    const beadDir = path.join(tmpRoot, '.tmp', 'tool-calls', beadId);
    const beadFile = path.join(beadDir, 'out.json');
    const oldMtime = NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS;
    writeFileWithMtime(beadFile, '{}', oldMtime);
    makeDirWithMtime(beadDir, oldMtime);

    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(),
      es as any,
      TWO_DAYS_MS,
      () => { throw new Error('beadsPort unavailable'); }
    );

    // Must not throw; fail-safe skips tool-calls area entirely.
    const result = await cleanup.run();
    expect(result).toMatchObject({ totalErrors: expect.any(Number) });

    // The bead dir must be untouched because the area was skipped.
    expect(fs.existsSync(beadDir)).toBe(true);
    expect(fs.existsSync(beadFile)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Supervisor throttle: retention cleanup is invoked at most once per interval
// ---------------------------------------------------------------------------

describe('Supervisor retention cleanup throttle', () => {
  it('runs cleanup immediately on first call and skips subsequent calls within the interval', async () => {
    const clock = fakeClock(NOW_MS);
    const runMock = vi.fn(async () => ({
      areas: [],
      totalFilesRemoved: 0,
      totalDirsRemoved: 0,
      totalBytesReclaimed: 0,
      totalErrors: 0,
      eventsCompacted: 0
    }));

    // We directly exercise the throttle logic in isolation by mimicking what
    // Supervisor.runRetentionCleanupIfDue() does: compare clock.now() against
    // lastRetentionCleanupMs using CLEANUP_INTERVAL_MS.
    let lastRunMs = 0;

    async function runIfDue(nowMs: number): Promise<boolean> {
      if (nowMs - lastRunMs < RetentionDefaults.CLEANUP_INTERVAL_MS) return false;
      lastRunMs = nowMs;
      await runMock();
      return true;
    }

    // First call — should run.
    expect(await runIfDue(NOW_MS)).toBe(true);
    expect(runMock).toHaveBeenCalledTimes(1);

    // Second call within the same hour — should NOT run.
    expect(await runIfDue(NOW_MS + ONE_HOUR_MS / 2)).toBe(false);
    expect(runMock).toHaveBeenCalledTimes(1);

    // Third call after the interval has elapsed — should run.
    expect(await runIfDue(NOW_MS + ONE_HOUR_MS + 1)).toBe(true);
    expect(runMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// REPLAY-CRITICAL event set completeness
// ---------------------------------------------------------------------------

describe('REPLAY_CRITICAL_EVENT_TYPES completeness', () => {
  it('contains all event types consumed by BeadStateProjection.projectBeadStateChartFromEvents', () => {
    // Every event type that appears in the switch/case in BeadStateProjection
    // must be in REPLAY_CRITICAL_EVENT_TYPES. This is a structural guard.
    const expectedCritical = [
      DomainEventName.BEAD_CLAIMED,
      DomainEventName.STATE_RUN_INITIALIZED,
      DomainEventName.ACTION_COMPLETED,
      DomainEventName.TEAMMATE_SPAWNED,
      DomainEventName.STATE_TRANSITION_APPLIED,
      DomainEventName.CONTEXT_RESTART_REQUESTED,
      DomainEventName.HARNESS_RESTART_REQUESTED,
      DomainEventName.CHECKLIST_ITEM_TICKED,
      DomainEventName.CHECKLIST_ITEM_ADDED,
      DomainEventName.CHECKPOINT_SUBMITTED,
      DomainEventName.CONTEXT_COMPACTION_RECORDED,
      DomainEventName.WORKTREE_CREATED,
      DomainEventName.WORKTREE_REUSED,
      DomainEventName.WORKTREE_PROVISIONED,
      DomainEventName.WORKTREE_REMOVED,
      DomainEventName.MERGE_AND_COMMIT_STARTED,
      DomainEventName.MERGE_AND_COMMIT_SUCCEEDED,
      DomainEventName.MERGE_AND_COMMIT_FAILED,
      DomainEventName.BEAD_STATUS_UPDATED,
      DomainEventName.BEAD_CLOSED,
      DomainEventName.BEAD_RELEASED,
      DomainEventName.BEAD_TOMBSTONED,
      // Slot-health pruning: Supervisor.hasDurableInactiveEvent (eventsForBeads)
      DomainEventName.TEAMMATE_PROCESS_EXITED,
      // Project-tool circuit breaker: projectToolFailureLimit (eventsForActiveProjectToolRun)
      DomainEventName.PROJECT_TOOL_FAILED,
    ];
    for (const eventType of expectedCritical) {
      expect(
        REPLAY_CRITICAL_EVENT_TYPES.has(eventType),
        `Expected REPLAY_CRITICAL_EVENT_TYPES to contain ${eventType}`
      ).toBe(true);
    }
  });

  it('does NOT contain pure telemetry events that are compactable', () => {
    // These events appear nowhere in BeadStateProjection switch/case arms —
    // they are safe to compact away.
    const compactable = [
      DomainEventName.HEARTBEAT_RECORDED,
      DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED,
      DomainEventName.TOKEN_USAGE_RECORDED,
      DomainEventName.BEADS_COMMAND_STARTED,
      DomainEventName.BEADS_COMMAND_SUCCEEDED,
      DomainEventName.RETENTION_CLEANUP_COMPLETED,
      DomainEventName.TOOL_INVOCATION_STARTED,
      DomainEventName.TOOL_INVOCATION_SUCCEEDED,
    ];
    for (const eventType of compactable) {
      expect(
        REPLAY_CRITICAL_EVENT_TYPES.has(eventType),
        `Expected REPLAY_CRITICAL_EVENT_TYPES NOT to contain compactable ${eventType}`
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// MANDATORY ORACLE: Replay-equality property test
//
// Proof: compaction(events) produces the same BeadStateChartProjection as
// the raw event log. This is the canonical "compaction preserves the source
// of truth" proof required by the bead spec.
// ---------------------------------------------------------------------------

describe('RetentionCleanup — MANDATORY replay-equality oracle', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('preserves projected BeadStateChartProjection after compacting old telemetry events', async () => {
    const beadId = 'bd-oracle-test';
    // All replay-critical events are "old" (beyond compaction window) to stress-test the guard.
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;
    // Telemetry events are also old.
    const oldTelemetryMs = NOW_MS - SEVEN_DAYS_MS - 2 * ONE_HOUR_MS;

    // A representative bead lifecycle: replay-critical events mixed with telemetry.
    const rawEvents: DomainEvent[] = [
      // REPLAY-CRITICAL: these must NEVER be dropped.
      makeEvent(DomainEventName.BEAD_CLAIMED, beadId, oldMs, { stateId: 'Planning', owner: 'worker-1', lease: { owner: 'worker-1', expiresAt: new Date(oldMs + ONE_HOUR_MS).toISOString() } }),
      // Telemetry: safe to compact.
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldTelemetryMs, { stateId: 'Planning' }),
      // REPLAY-CRITICAL
      makeEvent(DomainEventName.STATE_RUN_INITIALIZED, beadId, oldMs + 1000, { stateId: 'Planning', actionId: 'formulate-plan' }),
      // Telemetry
      makeEvent(DomainEventName.TOOL_INVOCATION_STARTED, beadId, oldTelemetryMs + 2000, { tool: 'bash' }),
      // REPLAY-CRITICAL
      makeEvent(DomainEventName.WORKTREE_CREATED, beadId, oldMs + 2000, { path: '/tmp/worktrees/bd-oracle', branchName: 'bead/bd-oracle' }),
      // REPLAY-CRITICAL
      makeEvent(DomainEventName.CHECKPOINT_SUBMITTED, beadId, oldMs + 3000, { stateId: 'Planning', actionId: 'formulate-plan', summary: 'Plan complete', evidence: 'IMPLEMENTATION_PLAN.md' }),
      // Telemetry
      makeEvent(DomainEventName.TOKEN_USAGE_RECORDED, beadId, oldTelemetryMs + 4000, { inputTokens: 100, outputTokens: 200 }),
      // REPLAY-CRITICAL
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, beadId, oldMs + 4000, {
        fromState: 'Planning',
        nextState: 'Implementation',
        transitionEvent: 'SUCCESS',
        actionId: 'formulate-plan',
        actionKey: 'state=Planning/action=formulate-plan'
      }),
      // Telemetry
      makeEvent(DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED, beadId, oldTelemetryMs + 5000, {}),
      // REPLAY-CRITICAL
      makeEvent(DomainEventName.STATE_RUN_INITIALIZED, beadId, oldMs + 5000, { stateId: 'Implementation', actionId: 'surgical-execution' }),
      // REPLAY-CRITICAL
      makeEvent(DomainEventName.CHECKLIST_ITEM_TICKED, beadId, oldMs + 6000, { stateId: 'Implementation', text: 'Tests pass', evidence: 'vitest: 42 passed' }),
      // REPLAY-CRITICAL
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, beadId, oldMs + 7000, {
        fromState: 'Implementation',
        nextState: 'completed',
        transitionEvent: 'SUCCESS',
        actionId: 'surgical-execution',
        actionKey: 'state=Implementation/action=surgical-execution'
      }),
      // REPLAY-CRITICAL
      makeEvent(DomainEventName.MERGE_AND_COMMIT_SUCCEEDED, beadId, oldMs + 8000, { branchName: 'bead/bd-oracle', targetBranch: 'main' }),
      // REPLAY-CRITICAL
      makeEvent(DomainEventName.BEAD_CLOSED, beadId, oldMs + 9000, { status: 'completed' }),
      // Telemetry
      makeEvent(DomainEventName.RETENTION_CLEANUP_COMPLETED, beadId, oldTelemetryMs + 10000, { totalFilesRemoved: 5 }),
    ];

    // Write the raw events to a JSONL file in the events directory.
    const eventsFile = path.join(tmpRoot, '.pi', 'events', 'project.jsonl');
    writeEventsJsonl(eventsFile, rawEvents);

    // Project state from raw events (the oracle ground truth).
    const rawProjection = project(rawEvents, beadId);

    // Run compaction with liveBeadIds = empty set (bead is complete, not live).
    const retentionConfig: RetentionConfig = {
      compactionEnabled: true,
      compactionWindowMs: SEVEN_DAYS_MS, // 7 days — all old events are eligible
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(NOW_MS),
      es as any,
      TWO_DAYS_MS,
      () => new Set(), // empty live set
      retentionConfig
    );
    const result = await cleanup.run();

    // Compaction must have dropped some events (the telemetry ones).
    expect(result.eventsCompacted).toBeGreaterThan(0);

    // Read back the compacted events.
    const compactedEvents = readEventsJsonl(eventsFile);

    // PROJECT from the compacted events — this must equal the raw projection.
    const compactedProjection = project(compactedEvents, beadId);
    const compactedMetaProjection = projectMeta(compactedEvents, beadId);
    const rawMetaProjection = projectMeta(rawEvents, beadId);

    // ── THE MANDATORY ORACLE ─────────────────────────────────────────────────
    // Deep equality on the semantically meaningful projection state.  We exclude
    // `lastEventId` and `lastUpdatedAt` / `lastActivity` from both projections
    // because these audit fields legitimately change after compaction (they track
    // the last event seen, and compaction removes some events).  Every other field
    // must be byte-identical: state, transitions, checklist, worktree, merge, etc.
    const { lastEventId: _rawLei, lastUpdatedAt: _rawLua, ...rawCoreProjection } = rawProjection;
    const { lastEventId: _cmpLei, lastUpdatedAt: _cmpLua, ...compactedCoreProjection } = compactedProjection;
    expect(compactedCoreProjection).toEqual(rawCoreProjection);

    // HarnessBeadMetadata oracle: exclude lastActivity (same rationale).
    const { lastActivity: _rawLa, ...rawCoreMeta } = rawMetaProjection;
    const { lastActivity: _cmpLa, ...compactedCoreMeta } = compactedMetaProjection;
    expect(compactedCoreMeta).toEqual(rawCoreMeta);
  });

  it('replay-critical events are NEVER dropped even when older than the compaction window', async () => {
    const beadId = 'bd-never-drop';
    const veryOldMs = NOW_MS - 30 * 24 * 60 * 60 * 1000; // 30 days old

    // Only replay-critical events, all very old.
    const criticalOnlyEvents: DomainEvent[] = [
      makeEvent(DomainEventName.BEAD_CLAIMED, beadId, veryOldMs, { stateId: 'Planning' }),
      makeEvent(DomainEventName.STATE_RUN_INITIALIZED, beadId, veryOldMs + 1000, { stateId: 'Planning', actionId: 'formulate-plan' }),
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, beadId, veryOldMs + 2000, {
        fromState: 'Planning',
        nextState: 'Implementation',
        transitionEvent: 'SUCCESS',
        actionId: 'formulate-plan',
        actionKey: 'state=Planning/action=formulate-plan'
      }),
      makeEvent(DomainEventName.BEAD_CLOSED, beadId, veryOldMs + 3000, { status: 'completed' }),
    ];

    const eventsFile = path.join(tmpRoot, '.pi', 'events', 'project.jsonl');
    writeEventsJsonl(eventsFile, criticalOnlyEvents);

    const retentionConfig: RetentionConfig = {
      compactionEnabled: true,
      compactionWindowMs: ONE_HOUR_MS, // extremely short — everything is old
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(NOW_MS),
      es as any,
      TWO_DAYS_MS,
      () => new Set(),
      retentionConfig
    );
    await cleanup.run();

    const remaining = readEventsJsonl(eventsFile);

    // All critical events must survive compaction.
    expect(remaining).toHaveLength(criticalOnlyEvents.length);
    for (const event of criticalOnlyEvents) {
      expect(remaining.some(e => e.id === event.id)).toBe(true);
    }
  });

  it('non-critical telemetry older than the window is dropped; recent telemetry is kept', async () => {
    const beadId = 'bd-telemetry-age';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS; // old — eligible for compaction
    const recentMs = NOW_MS - ONE_HOUR_MS; // recent — must be kept

    const events: DomainEvent[] = [
      // REPLAY-CRITICAL: old but must not be dropped
      makeEvent(DomainEventName.BEAD_CLAIMED, beadId, oldMs, { stateId: 'Planning' }),
      // Old telemetry: must be dropped
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs + 1000, {}),
      makeEvent(DomainEventName.TOKEN_USAGE_RECORDED, beadId, oldMs + 2000, {}),
      // Recent telemetry: must be kept (not old enough to compact)
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, recentMs, {}),
    ];

    const eventsFile = path.join(tmpRoot, '.pi', 'events', 'project.jsonl');
    writeEventsJsonl(eventsFile, events);

    const retentionConfig: RetentionConfig = {
      compactionEnabled: true,
      compactionWindowMs: SEVEN_DAYS_MS,
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(NOW_MS),
      es as any,
      TWO_DAYS_MS,
      () => new Set(),
      retentionConfig
    );
    const result = await cleanup.run();

    expect(result.eventsCompacted).toBe(2); // The two old telemetry events.

    const remaining = readEventsJsonl(eventsFile);
    const remainingTypes = remaining.map(e => e.type);

    // Critical event preserved.
    expect(remainingTypes).toContain(DomainEventName.BEAD_CLAIMED);
    // Old telemetry dropped.
    expect(remaining.filter(e => e.type === DomainEventName.HEARTBEAT_RECORDED && e.timestamp === new Date(oldMs + 1000).toISOString())).toHaveLength(0);
    expect(remaining.filter(e => e.type === DomainEventName.TOKEN_USAGE_RECORDED)).toHaveLength(0);
    // Recent heartbeat kept.
    expect(remaining.filter(e => e.type === DomainEventName.HEARTBEAT_RECORDED && e.timestamp === new Date(recentMs).toISOString())).toHaveLength(1);
  });

  it('live bead events are NEVER compacted regardless of age or event type', async () => {
    const liveBeadId = 'bd-live-protected';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;

    const events: DomainEvent[] = [
      // Non-critical but belongs to a live bead — must be kept.
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, liveBeadId, oldMs, {}),
      makeEvent(DomainEventName.TOKEN_USAGE_RECORDED, liveBeadId, oldMs + 1000, {}),
      // Critical + live.
      makeEvent(DomainEventName.BEAD_CLAIMED, liveBeadId, oldMs + 2000, { stateId: 'Planning' }),
    ];

    const eventsFile = path.join(tmpRoot, '.pi', 'events', 'project.jsonl');
    writeEventsJsonl(eventsFile, events);

    const retentionConfig: RetentionConfig = {
      compactionEnabled: true,
      compactionWindowMs: ONE_HOUR_MS, // very short — everything is "old"
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(NOW_MS),
      es as any,
      TWO_DAYS_MS,
      () => new Set([liveBeadId]), // liveBeadId is live
      retentionConfig
    );
    const result = await cleanup.run();

    // Nothing should be compacted — all events belong to the live bead.
    expect(result.eventsCompacted).toBe(0);

    const remaining = readEventsJsonl(eventsFile);
    expect(remaining).toHaveLength(events.length);
  });

  it('compaction is skipped entirely when liveBeadIds supplier throws (fail-safe)', async () => {
    const beadId = 'bd-failsafe';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;

    const events: DomainEvent[] = [
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs, {}),
      makeEvent(DomainEventName.BEAD_CLAIMED, beadId, oldMs + 1000, { stateId: 'Planning' }),
    ];

    const eventsFile = path.join(tmpRoot, '.pi', 'events', 'project.jsonl');
    writeEventsJsonl(eventsFile, events);

    const retentionConfig: RetentionConfig = {
      compactionEnabled: true,
      compactionWindowMs: ONE_HOUR_MS,
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(NOW_MS),
      es as any,
      TWO_DAYS_MS,
      () => { throw new Error('live bead resolution failed'); },
      retentionConfig
    );

    // Must not throw.
    const result = await cleanup.run();
    expect(result.eventsCompacted).toBe(0);

    // Events must be untouched.
    const remaining = readEventsJsonl(eventsFile);
    expect(remaining).toHaveLength(events.length);
  });

  it('by-bead index files are NEVER touched during compaction', async () => {
    const beadId = 'bd-index-safety';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;

    // Create a primary events file.
    const eventsFile = path.join(tmpRoot, '.pi', 'events', 'project.jsonl');
    writeEventsJsonl(eventsFile, [
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs, {}),
    ]);

    // Create a by-bead index directory and index file.
    const indexDir = path.join(tmpRoot, '.pi', 'events', 'by-bead');
    fs.mkdirSync(indexDir, { recursive: true });
    const indexFile = path.join(indexDir, `${beadId}.jsonl`);
    const indexContent = JSON.stringify(makeEvent(DomainEventName.BEAD_CLAIMED, beadId, oldMs, { stateId: 'Planning' })) + '\n';
    fs.writeFileSync(indexFile, indexContent);

    const retentionConfig: RetentionConfig = {
      compactionEnabled: true,
      compactionWindowMs: ONE_HOUR_MS,
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(NOW_MS),
      es as any,
      TWO_DAYS_MS,
      () => new Set(),
      retentionConfig
    );
    await cleanup.run();

    // The index file must be completely unchanged.
    expect(fs.existsSync(indexFile)).toBe(true);
    expect(fs.readFileSync(indexFile, 'utf8')).toBe(indexContent);
  });
});

// ---------------------------------------------------------------------------
// Retention config: backward-safe defaults and config-driven behavior
// ---------------------------------------------------------------------------

describe('RetentionCleanup — retention config', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('compaction is disabled by default (no retentionConfig) — events are preserved', async () => {
    const beadId = 'bd-default-no-compact';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;

    const events: DomainEvent[] = [
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs, {}),
      makeEvent(DomainEventName.BEAD_CLAIMED, beadId, oldMs + 1000, { stateId: 'Planning' }),
    ];

    const eventsFile = path.join(tmpRoot, '.pi', 'events', 'project.jsonl');
    writeEventsJsonl(eventsFile, events);

    // No retentionConfig provided — compaction must be disabled (backward-safe).
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(tmpRoot, fakeClock(), es as any);
    const result = await cleanup.run();

    expect(result.eventsCompacted).toBe(0);

    // File must be untouched.
    const remaining = readEventsJsonl(eventsFile);
    expect(remaining).toHaveLength(events.length);
  });

  it('compaction is disabled when compactionEnabled: false in retentionConfig', async () => {
    const beadId = 'bd-disabled-compact';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;

    const events: DomainEvent[] = [
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs, {}),
    ];

    const eventsFile = path.join(tmpRoot, '.pi', 'events', 'project.jsonl');
    writeEventsJsonl(eventsFile, events);

    const retentionConfig: RetentionConfig = { compactionEnabled: false };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(),
      es as any,
      TWO_DAYS_MS,
      () => new Set(),
      retentionConfig
    );
    const result = await cleanup.run();

    expect(result.eventsCompacted).toBe(0);
    const remaining = readEventsJsonl(eventsFile);
    expect(remaining).toHaveLength(1);
  });

  it('respects configured maxAgeMs instead of RetentionDefaults.MAX_AGE_MS', async () => {
    const logsDir = path.join(tmpRoot, '.pi', 'logs');
    const shortMaxAgeMs = ONE_HOUR_MS * 2; // 2 hours

    // File is 3 hours old — old enough with a 2-hour threshold but within 2-day default.
    const slightlyOldFile = path.join(logsDir, 'slightly-old.log');
    writeFileWithMtime(slightlyOldFile, 'content', NOW_MS - ONE_HOUR_MS * 3);

    const retentionConfig: RetentionConfig = { maxAgeMs: shortMaxAgeMs };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(),
      es as any,
      TWO_DAYS_MS, // positional maxAgeMs — should be overridden by retentionConfig.maxAgeMs
      null,
      retentionConfig
    );
    await cleanup.run();

    // With a 2-hour threshold, a 3-hour-old file must be removed.
    expect(fs.existsSync(slightlyOldFile)).toBe(false);
  });

  it('compactionWindowMs controls which events are eligible for compaction', async () => {
    const beadId = 'bd-window-test';
    const twoHoursOldMs = NOW_MS - ONE_HOUR_MS * 2;
    const oneHourOldMs = NOW_MS - ONE_HOUR_MS;

    const events: DomainEvent[] = [
      // 2 hours old: eligible if window is 1 hour.
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, twoHoursOldMs, {}),
      // 1 hour old: NOT eligible if window is 2 hours.
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oneHourOldMs, {}),
    ];

    const eventsFile = path.join(tmpRoot, '.pi', 'events', 'project.jsonl');
    writeEventsJsonl(eventsFile, events);

    const retentionConfig: RetentionConfig = {
      compactionEnabled: true,
      compactionWindowMs: ONE_HOUR_MS * 1.5, // 1.5 hours: drops 2h-old, keeps 1h-old
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(NOW_MS),
      es as any,
      TWO_DAYS_MS,
      () => new Set(),
      retentionConfig
    );
    const result = await cleanup.run();

    expect(result.eventsCompacted).toBe(1); // Only the 2-hour-old heartbeat.
    const remaining = readEventsJsonl(eventsFile);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].timestamp).toBe(events[1].timestamp); // The 1-hour-old one survived.
  });
});

// ---------------------------------------------------------------------------
// Disk-usage / backpressure health event
// ---------------------------------------------------------------------------

describe('RetentionCleanup — disk health event', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('emits RETENTION_DISK_HEALTH event when bytes reclaimed exceeds threshold', async () => {
    const logsDir = path.join(tmpRoot, '.pi', 'logs');
    // Write a large-ish old file (content is large enough to trigger the 1-byte threshold).
    const largeContent = 'x'.repeat(1000); // 1000 bytes
    const oldFile = path.join(logsDir, 'large-old.log');
    writeFileWithMtime(oldFile, largeContent, NOW_MS - TWO_DAYS_MS - ONE_HOUR_MS);

    const retentionConfig: RetentionConfig = {
      diskHealthWarnBytes: 100, // very low threshold — 1000 bytes will exceed it
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(),
      es as any,
      TWO_DAYS_MS,
      null,
      retentionConfig
    );
    await cleanup.run();

    // A RETENTION_DISK_HEALTH event must have been emitted.
    const healthCall = es.record.mock.calls.find(([event]) => event === DomainEventName.RETENTION_DISK_HEALTH);
    expect(healthCall).toBeDefined();
    const [, healthData] = healthCall as [string, Record<string, unknown>];
    expect(typeof healthData.totalBytesReclaimed).toBe('number');
    expect((healthData.totalBytesReclaimed as number)).toBeGreaterThan(0);
    expect(healthData.diskHealthWarnBytes).toBe(100);
  });

  it('does NOT emit RETENTION_DISK_HEALTH when bytes reclaimed is below threshold', async () => {
    // No files to reclaim — bytes = 0, which is always below any positive threshold.
    const retentionConfig: RetentionConfig = {
      diskHealthWarnBytes: RetentionDefaults.DISK_HEALTH_WARN_BYTES,
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(),
      es as any,
      TWO_DAYS_MS,
      null,
      retentionConfig
    );
    await cleanup.run();

    const healthCall = es.record.mock.calls.find(([event]) => event === DomainEventName.RETENTION_DISK_HEALTH);
    expect(healthCall).toBeUndefined();
  });

  it('RetentionDefaults.DISK_HEALTH_WARN_BYTES is a reasonable default (50 MiB)', () => {
    expect(RetentionDefaults.DISK_HEALTH_WARN_BYTES).toBe(50 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// MUST-FIX 1 oracle: signal events are NEVER dropped even when older than window
// ---------------------------------------------------------------------------

describe('RetentionCleanup — MUST-FIX 1: signal events are replay-critical', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('TEAMMATE_EVENT older than the compaction window is never dropped', async () => {
    const beadId = 'bd-signal-1';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;

    const events: DomainEvent[] = [
      makeEvent(DomainEventName.TEAMMATE_EVENT, beadId, oldMs, {
        type: 'CHECKPOINT_ACCEPTED',
        idempotencyKey: 'key-1',
        processingDecision: 'accept'
      }),
      // Non-critical telemetry that SHOULD be dropped
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs + 1000, {}),
    ];

    const eventsFile = path.join(tmpRoot, '.pi', 'events', 'project.jsonl');
    writeEventsJsonl(eventsFile, events);

    const retentionConfig: RetentionConfig = {
      compactionEnabled: true,
      compactionWindowMs: ONE_HOUR_MS, // very short — everything looks old
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(NOW_MS),
      es as any,
      TWO_DAYS_MS,
      () => new Set(),
      retentionConfig
    );
    const result = await cleanup.run();

    // Only the heartbeat should be dropped; TEAMMATE_EVENT must survive.
    expect(result.eventsCompacted).toBe(1);

    const remaining = readEventsJsonl(eventsFile);
    expect(remaining.some(e => e.type === DomainEventName.TEAMMATE_EVENT)).toBe(true);
    expect(remaining.some(e => e.type === DomainEventName.HEARTBEAT_RECORDED)).toBe(false);
  });

  it('SIGNAL_INTENT_RECORDED older than the compaction window is never dropped', async () => {
    const beadId = 'bd-signal-2';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;

    const events: DomainEvent[] = [
      makeEvent(DomainEventName.SIGNAL_INTENT_RECORDED, beadId, oldMs, {
        idempotencyKey: 'key-2',
        eventType: 'CHECKPOINT_ACCEPTED'
      }),
      makeEvent(DomainEventName.TOKEN_USAGE_RECORDED, beadId, oldMs + 1000, { inputTokens: 50 }),
    ];

    const eventsFile = path.join(tmpRoot, '.pi', 'events', 'project.jsonl');
    writeEventsJsonl(eventsFile, events);

    const retentionConfig: RetentionConfig = {
      compactionEnabled: true,
      compactionWindowMs: ONE_HOUR_MS,
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(NOW_MS),
      es as any,
      TWO_DAYS_MS,
      () => new Set(),
      retentionConfig
    );
    const result = await cleanup.run();

    expect(result.eventsCompacted).toBe(1); // Only TOKEN_USAGE_RECORDED
    const remaining = readEventsJsonl(eventsFile);
    expect(remaining.some(e => e.type === DomainEventName.SIGNAL_INTENT_RECORDED)).toBe(true);
  });

  it('SIGNAL_ACKNOWLEDGED older than the compaction window is never dropped', async () => {
    const beadId = 'bd-signal-3';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;

    const events: DomainEvent[] = [
      makeEvent(DomainEventName.SIGNAL_ACKNOWLEDGED, beadId, oldMs, { idempotencyKey: 'key-3' }),
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs + 1000, {}),
    ];

    const eventsFile = path.join(tmpRoot, '.pi', 'events', 'project.jsonl');
    writeEventsJsonl(eventsFile, events);

    const retentionConfig: RetentionConfig = {
      compactionEnabled: true,
      compactionWindowMs: ONE_HOUR_MS,
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(NOW_MS),
      es as any,
      TWO_DAYS_MS,
      () => new Set(),
      retentionConfig
    );
    const result = await cleanup.run();

    expect(result.eventsCompacted).toBe(1); // Only HEARTBEAT_RECORDED
    const remaining = readEventsJsonl(eventsFile);
    expect(remaining.some(e => e.type === DomainEventName.SIGNAL_ACKNOWLEDGED)).toBe(true);
  });

  it('SIGNAL_INTENT_RECONCILED older than the compaction window is never dropped', async () => {
    const beadId = 'bd-signal-4';
    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;

    const events: DomainEvent[] = [
      makeEvent(DomainEventName.SIGNAL_INTENT_RECONCILED, beadId, oldMs, { idempotencyKey: 'key-4' }),
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs + 1000, {}),
    ];

    const eventsFile = path.join(tmpRoot, '.pi', 'events', 'project.jsonl');
    writeEventsJsonl(eventsFile, events);

    const retentionConfig: RetentionConfig = {
      compactionEnabled: true,
      compactionWindowMs: ONE_HOUR_MS,
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(NOW_MS),
      es as any,
      TWO_DAYS_MS,
      () => new Set(),
      retentionConfig
    );
    const result = await cleanup.run();

    expect(result.eventsCompacted).toBe(1); // Only HEARTBEAT_RECORDED
    const remaining = readEventsJsonl(eventsFile);
    expect(remaining.some(e => e.type === DomainEventName.SIGNAL_INTENT_RECONCILED)).toBe(true);
  });

  it('REPLAY_CRITICAL_EVENT_TYPES contains all four signal-idempotency event types', () => {
    // Structural guard: verify the four signal types are in the set.
    expect(REPLAY_CRITICAL_EVENT_TYPES.has(DomainEventName.TEAMMATE_EVENT)).toBe(true);
    expect(REPLAY_CRITICAL_EVENT_TYPES.has(DomainEventName.SIGNAL_INTENT_RECORDED)).toBe(true);
    expect(REPLAY_CRITICAL_EVENT_TYPES.has(DomainEventName.SIGNAL_ACKNOWLEDGED)).toBe(true);
    expect(REPLAY_CRITICAL_EVENT_TYPES.has(DomainEventName.SIGNAL_INTENT_RECONCILED)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MUST-FIX 2 oracle: by-bead index is invalidated after primary compaction
// ---------------------------------------------------------------------------

describe('RetentionCleanup — MUST-FIX 2: by-bead index invalidated after compaction', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    Logger.close();
  });

  /**
   * Helper: write a .ready marker for beadId pointing to a specific primary-file
   * byte offset.  This simulates an existing (now stale) index marker.
   */
  function writeStaleIndexMarker(
    eventsDir: string,
    beadId: string,
    primaryBasename: string,
    offset: number
  ): { indexPath: string; markerPath: string } {
    const indexDir = path.join(eventsDir, EventStoreDefaults.BEAD_INDEX_DIR);
    fs.mkdirSync(indexDir, { recursive: true });

    const sanitized = beadId.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
    const indexPath = path.join(indexDir, `${sanitized}${EventStoreDefaults.INDEX_FILE_EXTENSION}`);
    const markerPath = `${indexPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`;

    // Write a minimal index JSONL and a .ready marker with the stale offset.
    fs.writeFileSync(indexPath, '');
    fs.writeFileSync(markerPath, JSON.stringify({ sources: { [primaryBasename]: offset } }));
    return { indexPath, markerPath };
  }

  it('deletes the .ready marker and index JSONL for beads whose primary was compacted', async () => {
    const beadId = 'bd-index-invalidate-1';
    const eventsDir = path.join(tmpRoot, '.pi', 'events');
    const primaryBasename = 'project.jsonl';
    const primaryPath = path.join(eventsDir, primaryBasename);

    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;

    // Write a primary with one old telemetry event (eligible for compaction).
    const events: DomainEvent[] = [
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldMs, {}),
    ];
    writeEventsJsonl(primaryPath, events);

    // Write a stale index marker claiming the full original byte size of the primary.
    const originalSize = fs.statSync(primaryPath).size;
    const { indexPath, markerPath } = writeStaleIndexMarker(
      eventsDir,
      beadId,
      primaryBasename,
      originalSize
    );

    // Verify preconditions.
    expect(fs.existsSync(indexPath)).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(true);

    // Run compaction — it will drop the heartbeat and shrink the primary.
    const retentionConfig: RetentionConfig = {
      compactionEnabled: true,
      compactionWindowMs: ONE_HOUR_MS, // very short — event is old
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(NOW_MS),
      es as any,
      TWO_DAYS_MS,
      () => new Set(), // bead is not live
      retentionConfig
    );
    await cleanup.run();

    // After compaction: the index JSONL and .ready marker must be deleted.
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(indexPath)).toBe(false);
  });

  it('does NOT invalidate index markers for primaries that were not compacted (no events dropped)', async () => {
    const beadId = 'bd-index-no-invalidate';
    const eventsDir = path.join(tmpRoot, '.pi', 'events');
    const primaryBasename = 'project.jsonl';
    const primaryPath = path.join(eventsDir, primaryBasename);

    const recentMs = NOW_MS - ONE_HOUR_MS; // within the compaction window

    // Write a primary with only a recent event (NOT eligible for compaction).
    const events: DomainEvent[] = [
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, recentMs, {}),
    ];
    writeEventsJsonl(primaryPath, events);

    const originalSize = fs.statSync(primaryPath).size;
    const { indexPath, markerPath } = writeStaleIndexMarker(
      eventsDir,
      beadId,
      primaryBasename,
      originalSize
    );

    const retentionConfig: RetentionConfig = {
      compactionEnabled: true,
      compactionWindowMs: SEVEN_DAYS_MS, // 7 days — recent event is within window, nothing dropped
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(NOW_MS),
      es as any,
      TWO_DAYS_MS,
      () => new Set(),
      retentionConfig
    );
    await cleanup.run();

    // Primary was NOT rewritten (nothing dropped), so index must remain intact.
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(indexPath)).toBe(true);
  });

  it('EventStore reads correct events after primary is compacted and index is invalidated', async () => {
    // This is the end-to-end MUST-FIX 2 proof:
    //  1. Pre-populate a primary JSONL and a stale by-bead index.
    //  2. Run compaction (drops old telemetry, rewrites primary).
    //  3. Create a fresh EventStore over the same directory.
    //  4. Read via eventsForBead (the index path) — must get the correct events.
    //  5. Assert projection matches the raw ground-truth projection.

    const beadId = 'bd-es-index-rebuild';
    const eventsDir = path.join(tmpRoot, '.pi', 'events');
    const primaryBasename = 'bd-es-index-rebuild.jsonl'; // use a custom name

    // Create a harness.yaml so ConfigLoader is happy.
    fs.writeFileSync(path.join(tmpRoot, 'harness.yaml'), `
settings:
  startState: Planning
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);

    const oldMs = NOW_MS - SEVEN_DAYS_MS - ONE_HOUR_MS;
    const oldTelemetryMs = NOW_MS - SEVEN_DAYS_MS - 2 * ONE_HOUR_MS;

    // Primary JSONL with two event types: a replay-critical one and old telemetry.
    const rawEvents: DomainEvent[] = [
      makeEvent(DomainEventName.BEAD_CLAIMED, beadId, oldMs, {
        stateId: 'Planning',
        owner: 'worker-1',
        lease: { owner: 'worker-1', expiresAt: new Date(oldMs + ONE_HOUR_MS).toISOString() }
      }),
      makeEvent(DomainEventName.HEARTBEAT_RECORDED, beadId, oldTelemetryMs, {}),
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, beadId, oldMs + 2000, {
        fromState: 'Planning',
        nextState: 'completed',
        transitionEvent: 'SUCCESS',
        actionId: 'plan',
        actionKey: 'state=Planning/action=plan'
      }),
      makeEvent(DomainEventName.BEAD_CLOSED, beadId, oldMs + 3000, { status: 'completed' }),
    ];

    // Ground truth: projection from the raw events (before compaction).
    const rawProjection = project(rawEvents, beadId);
    const rawMetaProjection = projectMeta(rawEvents, beadId);

    // Write raw events to the primary JSONL.
    const primaryPath = path.join(eventsDir, primaryBasename);
    writeEventsJsonl(primaryPath, rawEvents);
    const originalSize = fs.statSync(primaryPath).size;

    // Write a stale by-bead index pointing to the original (pre-compaction) byte size.
    // This simulates the state that would exist after the EventStore had previously
    // indexed this bead.  The stale marker will be invalidated by compaction.
    const { markerPath } = writeStaleIndexMarker(eventsDir, beadId, primaryBasename, originalSize);
    expect(fs.existsSync(markerPath)).toBe(true);

    // Run compaction — drops the heartbeat, rewrites the primary, invalidates the index.
    const retentionConfig: RetentionConfig = {
      compactionEnabled: true,
      compactionWindowMs: ONE_HOUR_MS, // very short — heartbeat is old
    };
    const es = fakeEventStore();
    const cleanup = new RetentionCleanup(
      tmpRoot,
      fakeClock(NOW_MS),
      es as any,
      TWO_DAYS_MS,
      () => new Set(),
      retentionConfig
    );
    const result = await cleanup.run();

    // Exactly one event (HEARTBEAT_RECORDED) should have been dropped.
    expect(result.eventsCompacted).toBe(1);

    // The stale index marker must be gone (invalidated by compaction).
    expect(fs.existsSync(markerPath)).toBe(false);

    // Build a fresh EventStore configured to read the custom primary filename.
    // We construct it with the same projectRoot but set the eventStore config to
    // point at our custom primary file name.
    const configLoader = new ConfigLoader(undefined, tmpRoot);
    // Override the event-store file name to match our custom primary.
    // We do this by creating an EventStore that uses a project name matching our file.
    // The EventStore derives the filename as `<projectName>.jsonl` from the directory basename.
    // Since tmpRoot basename is random, we instead write the events to a `<basename>.jsonl` file.
    // To make this work cleanly, we rename our custom primary to match the project-derived name.
    const projectBasename = path.basename(tmpRoot).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'project';
    const canonicalPrimaryPath = path.join(eventsDir, `${projectBasename}.jsonl`);

    // If we wrote to a custom basename, rename it to the canonical one expected by EventStore.
    if (primaryBasename !== `${projectBasename}.jsonl`) {
      fs.renameSync(primaryPath, canonicalPrimaryPath);
    }

    const freshEventStore = new EventStore(configLoader, undefined, undefined, tmpRoot);
    freshEventStore.setSessionId('fresh-session');

    // Read events via the index path (eventsForBead).
    const indexedEvents = await freshEventStore.eventsForBead(beadId);

    // The heartbeat must be gone; replay-critical events must be present.
    expect(indexedEvents.some(e => e.type === DomainEventName.HEARTBEAT_RECORDED)).toBe(false);
    expect(indexedEvents.some(e => e.type === DomainEventName.BEAD_CLAIMED)).toBe(true);
    expect(indexedEvents.some(e => e.type === DomainEventName.BEAD_CLOSED)).toBe(true);

    // Projection via the fresh EventStore must match the raw ground truth.
    const esProjection = await freshEventStore.projectBeadStateChart(beadId);
    const esMetaProjection = await freshEventStore.projectBead(beadId);

    // Exclude lastEventId / lastUpdatedAt / lastActivity — these legitimately
    // differ because compaction removed the heartbeat event.  Everything else
    // (state, transitions, status, worktree path, etc.) must be identical.
    const { lastEventId: _rawLei2, lastUpdatedAt: _rawLua2, ...rawCoreProjection2 } = rawProjection;
    const { lastEventId: _esLei2, lastUpdatedAt: _esLua2, ...esCoreProjection2 } = esProjection;
    expect(esCoreProjection2).toEqual(rawCoreProjection2);

    const { lastActivity: _rawLa2, ...rawCoreMeta2 } = rawMetaProjection;
    const { lastActivity: _esLa2, ...esCoreMeta2 } = esMetaProjection;
    expect(esCoreMeta2).toEqual(rawCoreMeta2);

    configLoader.reset();
  });
});
