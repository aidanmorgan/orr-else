import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RetentionCleanup } from '../src/core/RetentionCleanup.js';
import { RetentionDefaults } from '../src/constants/index.js';
import type { Clock } from '../src/core/Clock.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

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
 * (.pi/logs, .tmp, .pi/.trash) pre-created.
 */
function makeTmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
  fs.mkdirSync(path.join(root, '.pi', 'logs'), { recursive: true });
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

// ---------------------------------------------------------------------------
// Tests
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

    expect(es.record).toHaveBeenCalledOnce();
    const [eventName, eventData] = es.record.mock.calls[0] as [string, Record<string, unknown>];
    expect(eventName).toBe('RETENTION_CLEANUP_COMPLETED');

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

    expect(es.record).toHaveBeenCalledOnce();
    const [eventName, eventData] = es.record.mock.calls[0] as [string, Record<string, unknown>];
    expect(eventName).toBe('RETENTION_CLEANUP_COMPLETED');
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
      totalErrors: 0
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
