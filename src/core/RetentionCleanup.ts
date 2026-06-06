import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { resolveProjectFrom } from './Paths.js';
import { Logger } from './Logger.js';
import {
  Component,
  DomainEventName,
  EventStoreDefaults,
  OperationalArtifactPath,
  ProjectToolDefaults,
  REPLAY_CRITICAL_EVENT_TYPES,
  RetentionDefaults
} from '../constants/index.js';
import { BeadEventIndex } from './BeadEventIndex.js';
import { JsonlEventLog } from './JsonlEventLog.js';
import type { Clock } from './Clock.js';
import type { EventStore } from './EventStore.js';
import type { RetentionConfig } from './domain/StateModels.js';

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
  /** Number of non-critical events dropped during JSONL compaction (0 when compaction disabled). */
  eventsCompacted: number;
}

/**
 * Summary of a single JSONL compaction run.
 */
export interface CompactionSummary {
  filesProcessed: number;
  eventsKept: number;
  eventsDropped: number;
  bytesReclaimed: number;
  errors: number;
  /** Basenames of primary JSONL files that were successfully rewritten (compacted). */
  compactedFileBasenames: Set<string>;
}

/**
 * Describes a single harness-owned area to clean up.
 */
interface RetentionArea {
  name: string;
  relativePath: string;
}

/**
 * Relative path of the single PROJECT-scoped tool-output archive (0yt5.27).
 * Matches the structure emitted by ToolCallPathFactory:
 *   .pi/tool-output/{beadId}/{stateId}/{actionId}/{toolName}/{invocationId}/…
 * The first path segment is the beadId, so retention is per-bead and live-aware.
 */
const TOOL_OUTPUT_DIR = OperationalArtifactPath.PI_TOOL_OUTPUT_DIR;

/**
 * The harness-owned directories that are eligible for retention cleanup.
 * These are ONLY the harness's own log/.tmp/.trash areas — never project
 * source files or worktree content.
 */
const RETENTION_AREAS: readonly RetentionArea[] = [
  { name: 'logs', relativePath: OperationalArtifactPath.PI_LOGS_DIR },
  { name: 'tmp', relativePath: OperationalArtifactPath.TEMP_DIR },
  { name: 'trash', relativePath: OperationalArtifactPath.PI_TRASH_DIR },
  // OTEL traces (.pi/otel/traces-*.jsonl) grow unbounded otherwise; subject to
  // the same max-age reclaim as the other harness-owned areas, plus a max-bytes
  // rotation pass (see scanOtelArea).
  { name: 'otel', relativePath: OperationalArtifactPath.PI_OTEL_DIR }
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
 * - The .pi/tool-output subtree receives per-bead, live-aware treatment (see scanToolOutputArea).
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
 * Max-bytes rotation pass for OTEL trace files (`.pi/otel/traces-*.jsonl`).
 *
 * The standard age-based scan (RETENTION_AREAS `otel` entry) removes traces that
 * are older than maxAgeMs, but an active process can write a single trace file
 * that grows without bound while still being recent.  This pass bounds the size:
 * any `traces-*.jsonl` whose size exceeds `maxBytes` is removed (rotated), so the
 * next span write recreates a fresh file.
 *
 * Only top-level `traces-*.jsonl` files are considered — directories, symlinks,
 * and non-trace files are left untouched.  Bytes removed are added to the same
 * `otel` area summary so the caller's totals stay accurate.
 */
function scanOtelMaxBytesArea(otelRoot: string, maxBytes: number, summary: RetentionAreaSummary): void {
  if (!fs.existsSync(otelRoot)) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(otelRoot, { withFileTypes: true });
  } catch (error) {
    summary.errors++;
    Logger.debug(Component.RETENTION, 'Failed to read otel dir for max-bytes rotation', { error: String(error) });
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith('traces-') || !entry.name.endsWith('.jsonl')) continue;

    const filePath = path.join(otelRoot, entry.name);
    let stat: fs.Stats;
    try {
      // lstatSync: never follow a symlink masquerading as a trace file.
      stat = fs.lstatSync(filePath);
    } catch (error) {
      summary.errors++;
      Logger.debug(Component.RETENTION, 'Failed to stat otel trace file', { error: String(error) });
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    if (stat.size <= maxBytes) continue;

    const bytes = stat.size;
    const removeCounts = { filesRemoved: 0, dirsRemoved: 0, errors: 0 };
    removeRecursive(filePath, removeCounts);
    summary.filesRemoved += removeCounts.filesRemoved;
    summary.errors += removeCounts.errors;
    if (removeCounts.filesRemoved > 0) summary.bytesReclaimed += bytes;
  }
}

/**
 * Sanitize a state/action identifier into the on-disk path segment produced by
 * ToolCallPathFactory, so the live-bead current-transition carve-out matches the
 * directory names actually written under .pi/tool-output/{bead}/{state}/{action}.
 */
function toolOutputSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value || fallback)
    .replace(ProjectToolDefaults.UNSAFE_PATH_SEGMENT_PATTERN, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : fallback;
}

/**
 * Reclaim AGED prior-transition subtrees under a LIVE bead's tool-output dir,
 * while EXEMPTING the bead's CURRENT (latest) state/action subtree.
 *
 * GATE-BEFORE-RECLAIM (binding, a1j1 NOTES):
 * The coordinator verify() gate for a transition runs while that transition is
 * the bead's CURRENT state/action.  Its outputFiles (result.json / mcp-raw.json
 * under .pi/tool-output/{bead}/{currentState}/{currentAction}/…) MUST NOT be
 * reclaimed before the gate has run.  We therefore key the carve-out off the
 * bead's CURRENT state/action (NOT pure mtime): the current subtree is exempt
 * regardless of age, and only already-passed PRIOR transitions age out.
 *
 * Fail-safe: when the current state/action is unknown (currentState undefined,
 * e.g. no events projected yet) the whole live bead dir is preserved — we never
 * reclaim a live bead's archive when we cannot prove which transition is current.
 */
function reclaimLiveBeadPriorTransitions(
  beadDirPath: string,
  currentState: string | undefined,
  currentActionId: string | undefined,
  nowMs: number,
  maxAgeMs: number,
  summary: RetentionAreaSummary
): void {
  // Cannot determine the current transition — preserve the entire live bead dir.
  if (!currentState) return;

  const exemptState = toolOutputSegment(currentState, ProjectToolDefaults.UNSPECIFIED_STATE_ID);
  const exemptAction = toolOutputSegment(currentActionId, ProjectToolDefaults.UNSPECIFIED_ACTION_ID);

  let stateDirs: fs.Dirent[];
  try {
    stateDirs = fs.readdirSync(beadDirPath, { withFileTypes: true });
  } catch (error) {
    summary.errors++;
    Logger.debug(Component.RETENTION, 'Failed to read live bead dir for prior-transition reclaim', { error: String(error) });
    return;
  }

  for (const stateEntry of stateDirs) {
    if (!stateEntry.isDirectory()) continue;
    const statePath = path.join(beadDirPath, stateEntry.name);

    let actionDirs: fs.Dirent[];
    try {
      actionDirs = fs.readdirSync(statePath, { withFileTypes: true });
    } catch (error) {
      summary.errors++;
      Logger.debug(Component.RETENTION, 'Failed to read live bead state dir during reclaim', { error: String(error) });
      continue;
    }

    for (const actionEntry of actionDirs) {
      if (!actionEntry.isDirectory()) continue;
      // GATE-BEFORE-RECLAIM carve-out: never reclaim the CURRENT state/action
      // subtree of a live bead — its coordinator gate may not have run yet.
      if (stateEntry.name === exemptState && actionEntry.name === exemptAction) continue;

      const actionPath = path.join(statePath, actionEntry.name);
      let mtimeMs: number;
      try {
        mtimeMs = fs.lstatSync(actionPath).mtimeMs;
      } catch (error) {
        summary.errors++;
        Logger.debug(Component.RETENTION, 'Failed to stat live bead action dir during reclaim', { error: String(error) });
        continue;
      }

      if (nowMs - mtimeMs < maxAgeMs) continue; // not yet aged out

      const bytes = calcSizeBytes(actionPath);
      const removeCounts = { filesRemoved: 0, dirsRemoved: 0, errors: 0 };
      removeRecursive(actionPath, removeCounts);
      summary.filesRemoved += removeCounts.filesRemoved;
      summary.dirsRemoved += removeCounts.dirsRemoved;
      summary.errors += removeCounts.errors;
      summary.bytesReclaimed += bytes;
    }
  }
}

/**
 * Special-case scanner for `.pi/tool-output` (0yt5.27).
 *
 * The top-level `tool-output` dir mtime only bumps when a NEW per-bead subdir is
 * created.  If no new bead has started recently the dir looks old even though an
 * active bead may still be writing inside it.  Blanket-deleting by the top-level
 * mtime would silently destroy a running bead's output tree.
 *
 * Instead this function descends ONE level to the per-bead dirs
 * (`.pi/tool-output/{beadId}`) and:
 *   - For LIVE beads, reclaims AGED PRIOR-transition subtrees
 *     (`{beadId}/{state}/{action}`) while EXEMPTING the bead's CURRENT
 *     state/action subtree (gate-before-reclaim carve-out — see
 *     reclaimLiveBeadPriorTransitions).  The current transition's outputFiles
 *     are never reclaimed before the coordinator gate has run.  When the current
 *     state/action is unknown the whole live bead dir is preserved (fail-safe).
 *   - For non-live bead dirs, removes the dir if its own mtime is older than
 *     the age threshold (the per-bead dir mtime bumps when new state subdirs are
 *     created inside it — adequate as a conservative proxy for "active").
 *
 * The `tool-output` parent dir itself is NEVER removed.
 *
 * Fail-safe: if liveBeadIds resolution threw, the caller passes `null` here and
 * this function returns a zeroed summary (skip the entire area rather than risk
 * deleting an active bead's output tree).
 */
function scanToolOutputArea(
  toolOutputRoot: string,
  nowMs: number,
  maxAgeMs: number,
  liveBeadIds: Set<string> | null,
  currentTransitions: Map<string, { currentState?: string; currentActionId?: string }>
): RetentionAreaSummary {
  const summary: RetentionAreaSummary = {
    area: 'pi/tool-output',
    entriesScanned: 0,
    filesRemoved: 0,
    dirsRemoved: 0,
    bytesReclaimed: 0,
    errors: 0
  };

  // Fail-safe: if live-bead resolution failed, skip the entire tool-output area.
  if (liveBeadIds === null) {
    Logger.warn(Component.RETENTION, 'Skipping tool-output retention: live bead IDs unavailable');
    return summary;
  }

  // Missing directory is a no-op.
  if (!fs.existsSync(toolOutputRoot)) return summary;

  let beadDirs: fs.Dirent[];
  try {
    beadDirs = fs.readdirSync(toolOutputRoot, { withFileTypes: true });
  } catch (error) {
    summary.errors++;
    Logger.warn(Component.RETENTION, 'Failed to read tool-output directory during retention scan', {
      error: String(error)
    });
    return summary;
  }

  for (const entry of beadDirs) {
    const beadDirPath = path.join(toolOutputRoot, entry.name);
    const beadId = entry.name;
    summary.entriesScanned++;

    // LIVE bead: never blanket-delete its tree.  Instead reclaim only AGED
    // PRIOR-transition subtrees, exempting the CURRENT state/action subtree
    // (gate-before-reclaim carve-out).  The current transition is keyed off the
    // bead's projected current state/action, NOT mtime.
    if (liveBeadIds.has(beadId)) {
      const current = currentTransitions.get(beadId);
      reclaimLiveBeadPriorTransitions(
        beadDirPath,
        current?.currentState,
        current?.currentActionId,
        nowMs,
        maxAgeMs,
        summary
      );
      continue;
    }

    let mtimeMs: number;
    try {
      const stat = fs.lstatSync(beadDirPath);
      mtimeMs = stat.mtimeMs;
    } catch (error) {
      summary.errors++;
      Logger.debug(Component.RETENTION, 'Failed to stat bead dir during tool-output retention scan', { error: String(error) });
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
 * Compact a single JSONL event file in-place.
 *
 * Reads the file line-by-line, drops events that are:
 *   1. NOT in REPLAY_CRITICAL_EVENT_TYPES, AND
 *   2. Older than `compactionWindowMs` milliseconds ago.
 *
 * Replay-critical events are NEVER dropped regardless of age.
 * Live-bead events are NEVER dropped (the beadId appears in `liveBeadIds`).
 *
 * SAFETY:
 * - Writes to a `.tmp` sibling first, then renames atomically (best-effort).
 * - If the source file is a symlink, uses lstatSync to detect and skips it
 *   entirely (never follow or rewrite symlink targets).
 * - If any error occurs, the original file is preserved (no partial writes).
 * - The by-bead index files (by-bead/*.jsonl) are NOT touched — they are
 *   append-only indexes managed by EventStore/BeadEventIndex.
 *
 * Returns counts for the caller to aggregate.
 */
async function compactJsonlFile(
  filePath: string,
  nowMs: number,
  compactionWindowMs: number,
  liveBeadIds: Set<string>
): Promise<{ eventsKept: number; eventsDropped: number; bytesReclaimed: number; error?: string }> {
  // Symlink safety: never rewrite through a symlink.
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return { eventsKept: 0, eventsDropped: 0, bytesReclaimed: 0, error: 'stat failed' };
  }
  if (stat.isSymbolicLink()) {
    return { eventsKept: 0, eventsDropped: 0, bytesReclaimed: 0 };
  }
  if (!stat.isFile()) {
    return { eventsKept: 0, eventsDropped: 0, bytesReclaimed: 0 };
  }

  const originalBytes = stat.size;
  const tmpPath = `${filePath}.compact.tmp`;

  let eventsKept = 0;
  let eventsDropped = 0;

  try {
    const writeStream = fs.createWriteStream(tmpPath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });

    await new Promise<void>((resolve, reject) => {
      writeStream.on('error', reject);

      rl.on('line', (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return; // skip blank lines

        let event: { type?: string; timestamp?: string; data?: { beadId?: string; outputFile?: string; toolResult?: { outputFile?: string } } };
        try {
          event = JSON.parse(trimmed);
        } catch {
          // Malformed line: keep it (do not silently drop data we cannot parse).
          writeStream.write(`${trimmed}\n`);
          eventsKept++;
          return;
        }

        const eventType = event.type;
        const beadId = event.data?.beadId;

        // SAFETY 1: never drop replay-critical events.
        if (eventType && REPLAY_CRITICAL_EVENT_TYPES.has(eventType)) {
          writeStream.write(`${trimmed}\n`);
          eventsKept++;
          return;
        }

        // SAFETY 1.5: never drop evidence-bearing tool-result events.
        //
        // Two recorded shapes are reconciled here (see EventStore.toolResultEventMatches):
        //
        // NESTED (wrapped plugin tools): TOOL_INVOCATION_SUCCEEDED / TOOL_INVOCATION_FAILED
        //   carry toolResult.outputFile at data.toolResult.outputFile.
        //
        // FLAT (command / MCP tools): PROJECT_TOOL_SUCCEEDED / PROJECT_TOOL_FAILED
        //   carry outputFile at the TOP LEVEL of data (data.outputFile), recorded in
        //   src/plugins/projectTools.ts as `outputFile: context.outputFile`.
        //
        // Both shapes are consumed by EventStore.latestToolResultEvent() as proof that a
        // required tool ran for the current bead/state/action. They must survive compaction
        // even when the bead is no longer live, so the verifier gate can still reconstruct
        // required-tool status from the event log.
        //
        // Events WITHOUT an outputFile (e.g. TOOL_INVOCATION_STARTED, or SUCCEEDED/FAILED
        // without an outputFile) are NOT evidence and remain compactable as pure telemetry.
        if (
          (eventType === DomainEventName.TOOL_INVOCATION_SUCCEEDED ||
           eventType === DomainEventName.TOOL_INVOCATION_FAILED) &&
          typeof event.data?.toolResult?.outputFile === 'string' &&
          event.data.toolResult.outputFile.length > 0
        ) {
          writeStream.write(`${trimmed}\n`);
          eventsKept++;
          return;
        }

        if (
          eventType === DomainEventName.PROJECT_TOOL_SUCCEEDED &&
          typeof event.data?.outputFile === 'string' &&
          event.data.outputFile.length > 0
        ) {
          writeStream.write(`${trimmed}\n`);
          eventsKept++;
          return;
        }

        // SAFETY 2: never drop events for live beads.
        if (beadId && liveBeadIds.has(beadId)) {
          writeStream.write(`${trimmed}\n`);
          eventsKept++;
          return;
        }

        // Age check: only drop if old enough.
        const ts = event.timestamp;
        if (ts) {
          const eventMs = Date.parse(ts);
          if (!isNaN(eventMs) && nowMs - eventMs >= compactionWindowMs) {
            // Old non-critical event — compact away.
            eventsDropped++;
            return;
          }
        }

        // Recent or unparseable timestamp — keep.
        writeStream.write(`${trimmed}\n`);
        eventsKept++;
      });

      rl.on('close', () => {
        writeStream.end(() => resolve());
      });

      rl.on('error', reject);
    });

    // Atomic rename: replace original with compacted version.
    fs.renameSync(tmpPath, filePath);

    let newStat: fs.Stats;
    try {
      newStat = fs.lstatSync(filePath);
    } catch {
      newStat = { size: 0 } as fs.Stats;
    }
    const bytesReclaimed = Math.max(0, originalBytes - newStat.size);

    return { eventsKept, eventsDropped, bytesReclaimed };
  } catch (error) {
    // Cleanup temp file if it exists.
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return { eventsKept: 0, eventsDropped: 0, bytesReclaimed: 0, error: String(error) };
  }
}

/**
 * Run event-JSONL compaction across all JSONL files in the events directory.
 *
 * ONLY compacts the primary JSONL files (*.jsonl in the events root).
 * The by-bead index directory (by-bead/) is NOT touched — index files are
 * append-only and managed by BeadEventIndex; compacting them would break
 * the index and corrupt single-bead projection reads.
 *
 * Live bead IDs passed in `liveBeadIds` are fully protected: events belonging
 * to any live bead are kept regardless of age or event type.
 *
 * Fail-safe: if `liveBeadIds` is null (resolution failed), compaction is
 * skipped entirely.
 */
async function runEventStoreCompaction(
  eventsDir: string,
  nowMs: number,
  compactionWindowMs: number,
  liveBeadIds: Set<string> | null
): Promise<CompactionSummary> {
  const summary: CompactionSummary = {
    filesProcessed: 0,
    eventsKept: 0,
    eventsDropped: 0,
    bytesReclaimed: 0,
    errors: 0,
    compactedFileBasenames: new Set<string>()
  };

  // Fail-safe: skip if live-bead resolution failed.
  if (liveBeadIds === null) {
    Logger.warn(Component.RETENTION, 'Skipping event-JSONL compaction: live bead IDs unavailable');
    return summary;
  }

  if (!fs.existsSync(eventsDir)) return summary;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(eventsDir, { withFileTypes: true });
  } catch (error) {
    summary.errors++;
    Logger.warn(Component.RETENTION, 'Failed to read events directory for compaction', { error: String(error) });
    return summary;
  }

  // The BEAD_INDEX_DIR sub-directory must never be touched.
  const indexDirName = EventStoreDefaults.BEAD_INDEX_DIR;

  for (const entry of entries) {
    // Skip sub-directories (including the by-bead index dir).
    if (entry.isDirectory()) continue;
    // Skip non-JSONL files.
    if (!entry.name.endsWith('.jsonl')) continue;
    // Extra guard: never descend into the index dir even if it somehow appears as a file.
    if (entry.name === indexDirName) continue;

    const filePath = path.join(eventsDir, entry.name);
    summary.filesProcessed++;

    const result = await compactJsonlFile(filePath, nowMs, compactionWindowMs, liveBeadIds);
    if (result.error) {
      summary.errors++;
      Logger.warn(Component.RETENTION, 'Event-JSONL compaction failed for file', {
        file: entry.name,
        error: result.error
      });
    } else {
      summary.eventsKept += result.eventsKept;
      summary.eventsDropped += result.eventsDropped;
      summary.bytesReclaimed += result.bytesReclaimed;
      // Track which primary files were successfully rewritten so the caller can
      // invalidate any stale by-bead index markers that reference them.
      if (result.eventsDropped > 0) {
        summary.compactedFileBasenames.add(entry.name);
      }
    }
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
 * - The .pi/tool-output area is scanned per-bead; live bead dirs are always
 *   skipped.  If liveBeadIds resolution throws, the whole tool-output area is
 *   skipped (fail-safe).
 * - When retention.compactionEnabled is true, also compacts event JSONL files
 *   by dropping non-replay-critical events older than compactionWindowMs.
 *   The REPLAY_CRITICAL_EVENT_TYPES set is NEVER compacted.
 * - Emits RETENTION_DISK_HEALTH when bytes reclaimed exceeds diskHealthWarnBytes.
 */
export class RetentionCleanup {
  private readonly maxAgeMs: number;
  private readonly compactionEnabled: boolean;
  private readonly compactionWindowMs: number;
  private readonly diskHealthWarnBytes: number;
  private readonly otelMaxBytes: number = RetentionDefaults.OTEL_MAX_BYTES;

  constructor(
    private readonly projectRoot: string,
    private readonly clock: Clock,
    private readonly eventStore: EventStore,
    maxAgeMs: number = RetentionDefaults.MAX_AGE_MS,
    private readonly liveBeadIds: (() => Set<string> | Promise<Set<string>>) | null = null,
    retentionConfig?: RetentionConfig
  ) {
    this.maxAgeMs = retentionConfig?.maxAgeMs ?? maxAgeMs;
    this.compactionEnabled = retentionConfig?.compactionEnabled ?? RetentionDefaults.COMPACTION_ENABLED;
    this.compactionWindowMs = retentionConfig?.compactionWindowMs ?? RetentionDefaults.COMPACTION_WINDOW_MS;
    this.diskHealthWarnBytes = retentionConfig?.diskHealthWarnBytes ?? RetentionDefaults.DISK_HEALTH_WARN_BYTES;
  }

  /**
   * Run retention cleanup across all configured harness areas.
   * Returns an aggregate result with per-area summaries.
   */
  public async run(): Promise<RetentionCleanupResult> {
    const nowMs = this.clock.now();
    const areas: RetentionAreaSummary[] = [];

    // Resolve live bead IDs once for the whole run.  Errors are caught here so
    // individual area scanners can receive null (fail-safe skip for tool-output).
    let resolvedLiveBeadIds: Set<string> | null = null;
    if (this.liveBeadIds !== null) {
      try {
        resolvedLiveBeadIds = await this.liveBeadIds();
      } catch (error) {
        Logger.warn(Component.RETENTION, 'Failed to resolve live bead IDs for retention cleanup; tool-output area will be skipped', {
          error: String(error)
        });
        // resolvedLiveBeadIds stays null — scanToolOutputArea will skip
      }
    }

    for (const area of RETENTION_AREAS) {
      const areaRoot = resolveProjectFrom(this.projectRoot, area.relativePath);
      const summary = scanArea(areaRoot, area.name, nowMs, this.maxAgeMs);
      // Bound OTEL traces by size as well as age: a recent-but-huge traces-*.jsonl
      // is rotated even though the age scan above would keep it.
      if (area.name === 'otel') {
        scanOtelMaxBytesArea(areaRoot, this.otelMaxBytes, summary);
      }
      areas.push(summary);
    }

    // Resolve the CURRENT (latest) state/action for each live bead so the
    // tool-output scan can exempt the in-flight transition subtree from reclaim
    // (gate-before-reclaim carve-out). Failures per bead leave the entry absent,
    // which makes scanToolOutputArea preserve that whole live bead dir (safe).
    const currentTransitions = await this.resolveCurrentTransitions(resolvedLiveBeadIds);

    // 0yt5.27: the single PROJECT-scoped tool-output archive (.pi/tool-output) is
    // scanned per-bead with live-bead awareness — its first path segment is the
    // beadId. For a live bead, only AGED PRIOR-transition subtrees are reclaimed;
    // the CURRENT state/action subtree is exempt. If liveBeadIds resolution failed
    // (resolvedLiveBeadIds === null) the whole area is skipped.
    const toolOutputRoot = resolveProjectFrom(this.projectRoot, TOOL_OUTPUT_DIR);
    areas.push(scanToolOutputArea(toolOutputRoot, nowMs, this.maxAgeMs, resolvedLiveBeadIds, currentTransitions));

    const totalFilesRemoved = areas.reduce((acc, a) => acc + a.filesRemoved, 0);
    const totalDirsRemoved = areas.reduce((acc, a) => acc + a.dirsRemoved, 0);
    const totalBytesReclaimed = areas.reduce((acc, a) => acc + a.bytesReclaimed, 0);
    const totalErrors = areas.reduce((acc, a) => acc + a.errors, 0);

    // ── Event-JSONL compaction ──────────────────────────────────────────────
    let compactionSummary: CompactionSummary = {
      filesProcessed: 0,
      eventsKept: 0,
      eventsDropped: 0,
      bytesReclaimed: 0,
      errors: 0,
      compactedFileBasenames: new Set<string>()
    };

    if (this.compactionEnabled) {
      const eventsDir = resolveProjectFrom(this.projectRoot, OperationalArtifactPath.PI_EVENTS_DIR);
      compactionSummary = await runEventStoreCompaction(
        eventsDir,
        nowMs,
        this.compactionWindowMs,
        resolvedLiveBeadIds
      );

      // MUST-FIX 2: After compaction rewrites primary JSONL files, the by-bead
      // index markers store stale byte offsets (the primary shrank, so the stored
      // offset may point past EOF or into wrong bytes).  Invalidate every affected
      // bead index so the next eventsForBead call rebuilds from offset 0 of the
      // compacted file.
      if (compactionSummary.compactedFileBasenames.size > 0) {
        try {
          const beadIndex = new BeadEventIndex(new JsonlEventLog());
          await beadIndex.invalidateForSources(
            { dir: eventsDir },
            compactionSummary.compactedFileBasenames
          );
        } catch (error) {
          Logger.warn(Component.RETENTION, 'Failed to invalidate by-bead index after compaction', {
            error: String(error)
          });
        }
      }

      if (compactionSummary.eventsDropped > 0 || compactionSummary.errors > 0) {
        Logger.info(Component.RETENTION, 'Event-JSONL compaction completed', {
          filesProcessed: compactionSummary.filesProcessed,
          eventsKept: compactionSummary.eventsKept,
          eventsDropped: compactionSummary.eventsDropped,
          bytesReclaimed: compactionSummary.bytesReclaimed,
          errors: compactionSummary.errors
        });
      }
    }

    const result: RetentionCleanupResult = {
      areas,
      totalFilesRemoved,
      totalDirsRemoved,
      totalBytesReclaimed,
      totalErrors,
      eventsCompacted: compactionSummary.eventsDropped
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
      eventsCompacted: compactionSummary.eventsDropped,
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

    // ── Disk-usage / backpressure health event ──────────────────────────────
    // Emit a RETENTION_DISK_HEALTH event when total bytes reclaimed (from both
    // filesystem cleanup and JSONL compaction) exceeds the configured threshold.
    // This provides write-backpressure visibility as a harness-health signal.
    const totalBytesFreed = totalBytesReclaimed + compactionSummary.bytesReclaimed;
    if (totalBytesFreed >= this.diskHealthWarnBytes) {
      await this.eventStore.record(DomainEventName.RETENTION_DISK_HEALTH, {
        totalBytesReclaimed: totalBytesFreed,
        filesystemBytesReclaimed: totalBytesReclaimed,
        compactionBytesReclaimed: compactionSummary.bytesReclaimed,
        eventsCompacted: compactionSummary.eventsDropped,
        diskHealthWarnBytes: this.diskHealthWarnBytes,
        message: `Retention reclaimed ${totalBytesFreed} bytes (threshold: ${this.diskHealthWarnBytes})`
      }).catch(error => {
        Logger.warn(Component.RETENTION, 'Failed to record RETENTION_DISK_HEALTH event', { error: String(error) });
      });
    }

    return result;
  }

  /**
   * Project the CURRENT (latest) state/action for each live bead from the event
   * store. This is the load-bearing input to the gate-before-reclaim carve-out:
   * the returned state/action identifies the in-flight transition subtree that
   * tool-output reclaim must EXEMPT (its coordinator gate may not have run yet).
   *
   * Per-bead projection errors are isolated — a missing entry causes
   * scanToolOutputArea to preserve that live bead's entire dir (fail-safe).
   * Returns an empty map when there are no live beads or the live set is null.
   */
  private async resolveCurrentTransitions(
    liveBeadIds: Set<string> | null
  ): Promise<Map<string, { currentState?: string; currentActionId?: string }>> {
    const map = new Map<string, { currentState?: string; currentActionId?: string }>();
    if (!liveBeadIds || liveBeadIds.size === 0) return map;

    for (const beadId of liveBeadIds) {
      try {
        const projection = await this.eventStore.projectBeadStateChart(beadId);
        map.set(beadId, {
          currentState: projection.currentState,
          currentActionId: projection.activeActionId
        });
      } catch (error) {
        Logger.debug(Component.RETENTION, 'Failed to project current transition for live bead; its tool-output dir will be fully preserved', {
          beadId,
          error: String(error)
        });
        // Leave the entry absent — scanToolOutputArea preserves the whole dir.
      }
    }

    return map;
  }
}
