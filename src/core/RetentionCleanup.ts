import * as fs from 'fs';
import * as path from 'path';
import { resolveProjectFrom } from './Paths.js';
import { Logger } from './Logger.js';
import { Component, DomainEventName, OperationalArtifactPath, RetentionDefaults } from '../constants/index.js';
import type { Clock } from './Clock.js';
import type { EventStore } from './EventStore.js';

/**
 * Per-area summary produced by a single retention scan.
 * Bounded to counts and aggregate bytes — no path dumps.
 */
export interface RetentionAreaSummary {
  area: string;
  entriesScanned: number;
  filesRemoved: number;
  dirsRemoved: number;
  bytesReclaimed: number;
  errors: number;
}

/**
 * Aggregate result across all scanned areas.
 */
export interface RetentionCleanupResult {
  areas: RetentionAreaSummary[];
  totalFilesRemoved: number;
  totalDirsRemoved: number;
  totalBytesReclaimed: number;
  totalErrors: number;
}

/**
 * Describes a single harness-owned area to clean up.
 */
interface RetentionArea {
  name: string;
  relativePath: string;
}

/**
 * Relative path of the per-bead tool-call scratch directories inside .tmp.
 * Matches the structure emitted by ToolCallPathFactory: .tmp/tool-calls/{beadId}/…
 */
const TOOL_CALLS_SUBDIR = 'tool-calls';

/**
 * The harness-owned directories that are eligible for retention cleanup.
 * These are ONLY the harness's own log/.tmp/.trash areas — never project
 * source files or worktree content.
 */
const RETENTION_AREAS: readonly RetentionArea[] = [
  { name: 'logs', relativePath: OperationalArtifactPath.PI_LOGS_DIR },
  { name: 'tmp', relativePath: OperationalArtifactPath.TEMP_DIR },
  { name: 'trash', relativePath: OperationalArtifactPath.PI_TRASH_DIR }
] as const;

/**
 * Recursively calculates the total byte size of a directory entry.
 * Returns 0 if the path cannot be stat'd (already gone, permission error, etc.).
 *
 * Uses lstatSync so symlinks are NEVER followed — a symlink contributes 0 bytes
 * and is not recursed into.
 */
function calcSizeBytes(entryPath: string): number {
  try {
    const stat = fs.lstatSync(entryPath);
    // Symlinks: do not follow, contribute 0 to the reclaimed-bytes count.
    if (stat.isSymbolicLink()) return 0;
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;

    let total = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(entryPath, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      total += calcSizeBytes(path.join(entryPath, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Recursively removes a directory and all its contents.
 * Returns counts of files/dirs removed.
 *
 * Uses lstatSync so symlinks are detected before stat resolves through them.
 * Symlinks are treated as LEAVES — they are unlinked directly and the cleaner
 * NEVER descends into the link target (which may be outside the harness roots).
 */
function removeRecursive(
  entryPath: string,
  summary: Pick<RetentionAreaSummary, 'filesRemoved' | 'dirsRemoved' | 'errors'>
): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(entryPath);
  } catch {
    // Already gone — no-op.
    return;
  }

  // Symlinks are always leaves: unlink the link itself, never follow or recurse.
  if (stat.isSymbolicLink()) {
    try {
      fs.unlinkSync(entryPath);
      summary.filesRemoved++;
    } catch (error) {
      summary.errors++;
      Logger.debug(Component.RETENTION, 'Failed to remove symlink during retention cleanup', { error: String(error) });
    }
    return;
  }

  if (stat.isFile()) {
    try {
      fs.unlinkSync(entryPath);
      summary.filesRemoved++;
    } catch (error) {
      summary.errors++;
      Logger.debug(Component.RETENTION, 'Failed to remove file during retention cleanup', { error: String(error) });
    }
    return;
  }

  if (stat.isDirectory()) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(entryPath, { withFileTypes: true });
    } catch (error) {
      summary.errors++;
      Logger.debug(Component.RETENTION, 'Failed to read directory during retention cleanup', { error: String(error) });
      return;
    }
    for (const entry of entries) {
      removeRecursive(path.join(entryPath, entry.name), summary);
    }
    try {
      fs.rmdirSync(entryPath);
      summary.dirsRemoved++;
    } catch (error) {
      summary.errors++;
      Logger.debug(Component.RETENTION, 'Failed to remove directory during retention cleanup', { error: String(error) });
    }
  }
}

/**
 * Scans the top-level entries of a single harness-owned directory.
 * Removes entries whose mtime is older than the age threshold.
 *
 * SAFETY NOTES:
 * - Operates only on the directory rooted at `areaRoot`, never on source files.
 * - Uses lstatSync so symlinks inside the area are detected as symlinks and
 *   treated as leaves — the cleaner never escapes the harness roots via a link.
 * - The .tmp/tool-calls subtree receives special treatment (see scanToolCallsArea).
 * - If the directory does not exist, returns a zeroed summary (no-op).
 * - Per-entry errors are caught and counted; they do not abort the scan.
 */
function scanArea(areaRoot: string, areaName: string, nowMs: number, maxAgeMs: number): RetentionAreaSummary {
  const summary: RetentionAreaSummary = {
    area: areaName,
    entriesScanned: 0,
    filesRemoved: 0,
    dirsRemoved: 0,
    bytesReclaimed: 0,
    errors: 0
  };

  // Missing directory is a no-op, not an error.
  if (!fs.existsSync(areaRoot)) return summary;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(areaRoot, { withFileTypes: true });
  } catch (error) {
    summary.errors++;
    Logger.warn(Component.RETENTION, 'Failed to read retention area root', {
      area: areaName,
      error: String(error)
    });
    return summary;
  }

  for (const entry of entries) {
    const entryPath = path.join(areaRoot, entry.name);
    summary.entriesScanned++;

    let mtimeMs: number;
    try {
      // lstatSync: never follow symlinks — use the link's own mtime, not the target's.
      const stat = fs.lstatSync(entryPath);
      mtimeMs = stat.mtimeMs;
    } catch (error) {
      summary.errors++;
      Logger.debug(Component.RETENTION, 'Failed to stat entry during retention scan', { error: String(error) });
      continue;
    }

    const ageMs = nowMs - mtimeMs;
    if (ageMs < maxAgeMs) {
      // Entry is recent enough — keep it.
      continue;
    }

    // Measure bytes before removal so we can report reclaimed space.
    const bytes = calcSizeBytes(entryPath);

    const removeCounts = { filesRemoved: 0, dirsRemoved: 0, errors: 0 };
    removeRecursive(entryPath, removeCounts);

    summary.filesRemoved += removeCounts.filesRemoved;
    summary.dirsRemoved += removeCounts.dirsRemoved;
    summary.errors += removeCounts.errors;
    summary.bytesReclaimed += bytes;
  }

  return summary;
}

/**
 * Special-case scanner for `.tmp/tool-calls`.
 *
 * The top-level `tool-calls` dir mtime only bumps when a NEW per-bead subdir is
 * created.  If no new bead has started recently the dir looks old even though an
 * active bead may still be writing inside it.  Blanket-deleting by the top-level
 * mtime would silently destroy a running bead's scratch tree.
 *
 * Instead this function descends ONE level to the per-bead dirs
 * (`.tmp/tool-calls/{beadId}`) and:
 *   - SKIPS any {beadId} dir whose beadId is in the live set (never removed).
 *   - For non-live bead dirs, removes the dir if its own mtime is older than
 *     the age threshold (the per-bead dir mtime bumps when new state subdirs are
 *     created inside it — adequate as a conservative proxy for "active").
 *
 * The `tool-calls` parent dir itself is NEVER removed.
 *
 * Fail-safe: if liveBeadIds resolution threw, the caller passes `null` here and
 * this function returns a zeroed summary (skip the entire area rather than risk
 * deleting an active bead's scratch tree).
 */
function scanToolCallsArea(
  toolCallsRoot: string,
  nowMs: number,
  maxAgeMs: number,
  liveBeadIds: Set<string> | null
): RetentionAreaSummary {
  const summary: RetentionAreaSummary = {
    area: 'tmp/tool-calls',
    entriesScanned: 0,
    filesRemoved: 0,
    dirsRemoved: 0,
    bytesReclaimed: 0,
    errors: 0
  };

  // Fail-safe: if live-bead resolution failed, skip the entire tool-calls area.
  if (liveBeadIds === null) {
    Logger.warn(Component.RETENTION, 'Skipping tool-calls retention: live bead IDs unavailable');
    return summary;
  }

  // Missing directory is a no-op.
  if (!fs.existsSync(toolCallsRoot)) return summary;

  let beadDirs: fs.Dirent[];
  try {
    beadDirs = fs.readdirSync(toolCallsRoot, { withFileTypes: true });
  } catch (error) {
    summary.errors++;
    Logger.warn(Component.RETENTION, 'Failed to read tool-calls directory during retention scan', {
      error: String(error)
    });
    return summary;
  }

  for (const entry of beadDirs) {
    const beadDirPath = path.join(toolCallsRoot, entry.name);
    const beadId = entry.name;
    summary.entriesScanned++;

    // Never delete a live bead's scratch tree, regardless of mtime.
    if (liveBeadIds.has(beadId)) continue;

    let mtimeMs: number;
    try {
      const stat = fs.lstatSync(beadDirPath);
      mtimeMs = stat.mtimeMs;
    } catch (error) {
      summary.errors++;
      Logger.debug(Component.RETENTION, 'Failed to stat bead dir during tool-calls retention scan', { error: String(error) });
      continue;
    }

    const ageMs = nowMs - mtimeMs;
    if (ageMs < maxAgeMs) continue;

    const bytes = calcSizeBytes(beadDirPath);
    const removeCounts = { filesRemoved: 0, dirsRemoved: 0, errors: 0 };
    removeRecursive(beadDirPath, removeCounts);

    summary.filesRemoved += removeCounts.filesRemoved;
    summary.dirsRemoved += removeCounts.dirsRemoved;
    summary.errors += removeCounts.errors;
    summary.bytesReclaimed += bytes;
  }

  return summary;
}

/**
 * Harness-managed retention cleanup.
 *
 * Scans the harness-owned log, .tmp, and .trash directories and removes
 * top-level entries (and their subtrees) whose mtime is older than
 * `RetentionDefaults.MAX_AGE_MS` (2 days).
 *
 * Design invariants:
 * - Only touches harness-owned areas (never project source files).
 * - Uses lstatSync everywhere — symlinks inside the areas are treated as
 *   leaves (unlinked directly) and NEVER followed into link targets.
 * - Uses an injected Clock (never Date.now() directly).
 * - Missing directories are silently skipped (no-op).
 * - Per-entry errors are isolated; they do not abort the overall scan.
 * - Emits a single bounded domain event with aggregate counts/bytes.
 * - Should only be invoked from the coordinator process.
 * - The .tmp/tool-calls area is scanned per-bead; live bead dirs are always
 *   skipped.  If liveBeadIds resolution throws, the whole tool-calls area is
 *   skipped (fail-safe).
 */
export class RetentionCleanup {
  constructor(
    private readonly projectRoot: string,
    private readonly clock: Clock,
    private readonly eventStore: EventStore,
    private readonly maxAgeMs: number = RetentionDefaults.MAX_AGE_MS,
    private readonly liveBeadIds: (() => Set<string> | Promise<Set<string>>) | null = null
  ) {}

  /**
   * Run retention cleanup across all configured harness areas.
   * Returns an aggregate result with per-area summaries.
   */
  public async run(): Promise<RetentionCleanupResult> {
    const nowMs = this.clock.now();
    const areas: RetentionAreaSummary[] = [];

    // Resolve live bead IDs once for the whole run.  Errors are caught here so
    // individual area scanners can receive null (fail-safe skip for tool-calls).
    let resolvedLiveBeadIds: Set<string> | null = null;
    if (this.liveBeadIds !== null) {
      try {
        resolvedLiveBeadIds = await this.liveBeadIds();
      } catch (error) {
        Logger.warn(Component.RETENTION, 'Failed to resolve live bead IDs for retention cleanup; tool-calls area will be skipped', {
          error: String(error)
        });
        // resolvedLiveBeadIds stays null — scanToolCallsArea will skip
      }
    }

    for (const area of RETENTION_AREAS) {
      const areaRoot = resolveProjectFrom(this.projectRoot, area.relativePath);

      if (area.relativePath === OperationalArtifactPath.TEMP_DIR) {
        // The .tmp area needs special handling: scan all top-level entries EXCEPT
        // the tool-calls subdir (which gets its own per-bead treatment below).
        const tmpSummary = scanAreaExcludingSubdir(areaRoot, area.name, nowMs, this.maxAgeMs, TOOL_CALLS_SUBDIR);
        areas.push(tmpSummary);

        // Scan the tool-calls subdir separately with live-bead awareness.
        const toolCallsRoot = path.join(areaRoot, TOOL_CALLS_SUBDIR);
        const toolCallsSummary = scanToolCallsArea(toolCallsRoot, nowMs, this.maxAgeMs, resolvedLiveBeadIds);
        areas.push(toolCallsSummary);
      } else {
        const summary = scanArea(areaRoot, area.name, nowMs, this.maxAgeMs);
        areas.push(summary);
      }
    }

    const totalFilesRemoved = areas.reduce((acc, a) => acc + a.filesRemoved, 0);
    const totalDirsRemoved = areas.reduce((acc, a) => acc + a.dirsRemoved, 0);
    const totalBytesReclaimed = areas.reduce((acc, a) => acc + a.bytesReclaimed, 0);
    const totalErrors = areas.reduce((acc, a) => acc + a.errors, 0);

    const result: RetentionCleanupResult = {
      areas,
      totalFilesRemoved,
      totalDirsRemoved,
      totalBytesReclaimed,
      totalErrors
    };

    // Only log/record when there is something noteworthy to report.
    const anythingRemoved = totalFilesRemoved > 0 || totalDirsRemoved > 0 || totalErrors > 0;
    if (anythingRemoved) {
      const areaSummaries = areas
        .filter(a => a.filesRemoved > 0 || a.dirsRemoved > 0 || a.errors > 0)
        .map(a => `${a.area}: ${a.filesRemoved}f/${a.dirsRemoved}d removed, ${a.bytesReclaimed}B reclaimed, ${a.errors} errors`);

      Logger.info(Component.RETENTION, 'Retention cleanup completed', {
        totalFilesRemoved,
        totalDirsRemoved,
        totalBytesReclaimed,
        totalErrors,
        areas: areaSummaries
      });
    }

    // Always record the domain event so operators can observe that cleanup ran.
    await this.eventStore.record(DomainEventName.RETENTION_CLEANUP_COMPLETED, {
      totalFilesRemoved,
      totalDirsRemoved,
      totalBytesReclaimed,
      totalErrors,
      areaNames: areas.map(a => a.area),
      areaSummaries: areas.map(a => ({
        area: a.area,
        entriesScanned: a.entriesScanned,
        filesRemoved: a.filesRemoved,
        dirsRemoved: a.dirsRemoved,
        bytesReclaimed: a.bytesReclaimed,
        errors: a.errors
      }))
    }).catch(error => {
      Logger.warn(Component.RETENTION, 'Failed to record RETENTION_CLEANUP_COMPLETED event', { error: String(error) });
    });

    return result;
  }
}

/**
 * Like scanArea but skips one named top-level subdirectory.
 * Used for the `.tmp` area so that `tool-calls` is excluded from the generic
 * top-level age scan and handled separately by scanToolCallsArea.
 */
function scanAreaExcludingSubdir(
  areaRoot: string,
  areaName: string,
  nowMs: number,
  maxAgeMs: number,
  excludedSubdir: string
): RetentionAreaSummary {
  const summary: RetentionAreaSummary = {
    area: areaName,
    entriesScanned: 0,
    filesRemoved: 0,
    dirsRemoved: 0,
    bytesReclaimed: 0,
    errors: 0
  };

  if (!fs.existsSync(areaRoot)) return summary;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(areaRoot, { withFileTypes: true });
  } catch (error) {
    summary.errors++;
    Logger.warn(Component.RETENTION, 'Failed to read retention area root', {
      area: areaName,
      error: String(error)
    });
    return summary;
  }

  for (const entry of entries) {
    if (entry.name === excludedSubdir) continue;

    const entryPath = path.join(areaRoot, entry.name);
    summary.entriesScanned++;

    let mtimeMs: number;
    try {
      const stat = fs.lstatSync(entryPath);
      mtimeMs = stat.mtimeMs;
    } catch (error) {
      summary.errors++;
      Logger.debug(Component.RETENTION, 'Failed to stat entry during retention scan', { error: String(error) });
      continue;
    }

    const ageMs = nowMs - mtimeMs;
    if (ageMs < maxAgeMs) continue;

    const bytes = calcSizeBytes(entryPath);
    const removeCounts = { filesRemoved: 0, dirsRemoved: 0, errors: 0 };
    removeRecursive(entryPath, removeCounts);

    summary.filesRemoved += removeCounts.filesRemoved;
    summary.dirsRemoved += removeCounts.dirsRemoved;
    summary.errors += removeCounts.errors;
    summary.bytesReclaimed += bytes;
  }

  return summary;
}
