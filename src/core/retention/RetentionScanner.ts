/**
 * RetentionScanner — filesystem scanning and reclaim operations for harness-owned areas.
 *
 * Uses only fs (no Logger singleton, no EventStore, no process globals).
 * Logger calls are injected via a `log` callback so this module remains
 * testable without a real Logger.
 *
 * pi-experiment-amq0.17: extracted from RetentionCleanup.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RetentionAreaSummary } from './RetentionTypes.js';
import { resolveExemptSegments, isExemptCurrentTransition, hasExceededAge } from './ToolOutputRetentionPolicy.js';

export type { LogFn };

/** Minimal log callback — callers inject Logger.warn / Logger.debug etc. */
type LogFn = (level: 'debug' | 'warn' | 'info', msg: string, meta?: Record<string, unknown>) => void;

/** No-op log function used when no logger is injected. */
const noop: LogFn = () => {};

/**
 * Mutable budget tracker for the tool-output area batch ceilings.
 * Both ceilings apply across the entire tool-output scan pass; when either is
 * reached the scan stops processing further bead entries.
 */
export interface ToolOutputBudget {
  filesRemaining: number;
  dirsRemaining: number;
  /** Set to true when the scan was stopped early because a ceiling was hit. */
  ceilingHit: boolean;
}

/**
 * Recursively calculates the total byte size of a directory entry.
 * Returns 0 if the path cannot be stat'd (already gone, permission error, etc.).
 *
 * Uses lstatSync so symlinks are NEVER followed — a symlink contributes 0 bytes
 * and is not recursed into.
 */
export function calcSizeBytes(entryPath: string): number {
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
export function removeRecursive(
  entryPath: string,
  summary: Pick<RetentionAreaSummary, 'filesRemoved' | 'dirsRemoved' | 'errors'>,
  log: LogFn = noop
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
      log('debug', 'Failed to remove symlink during retention cleanup', { error: String(error) });
    }
    return;
  }

  if (stat.isFile()) {
    try {
      fs.unlinkSync(entryPath);
      summary.filesRemoved++;
    } catch (error) {
      summary.errors++;
      log('debug', 'Failed to remove file during retention cleanup', { error: String(error) });
    }
    return;
  }

  if (stat.isDirectory()) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(entryPath, { withFileTypes: true });
    } catch (error) {
      summary.errors++;
      log('debug', 'Failed to read directory during retention cleanup', { error: String(error) });
      return;
    }
    for (const entry of entries) {
      removeRecursive(path.join(entryPath, entry.name), summary, log);
    }
    try {
      fs.rmdirSync(entryPath);
      summary.dirsRemoved++;
    } catch (error) {
      summary.errors++;
      log('debug', 'Failed to remove directory during retention cleanup', { error: String(error) });
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
export function scanArea(
  areaRoot: string,
  areaName: string,
  nowMs: number,
  maxAgeMs: number,
  log: LogFn = noop
): RetentionAreaSummary {
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
    log('warn', 'Failed to read retention area root', { area: areaName, error: String(error) });
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
      log('debug', 'Failed to stat entry during retention scan', { error: String(error) });
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
    removeRecursive(entryPath, removeCounts, log);

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
export function scanOtelMaxBytesArea(
  otelRoot: string,
  maxBytes: number,
  summary: RetentionAreaSummary,
  log: LogFn = noop
): void {
  if (!fs.existsSync(otelRoot)) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(otelRoot, { withFileTypes: true });
  } catch (error) {
    summary.errors++;
    log('debug', 'Failed to read otel dir for max-bytes rotation', { error: String(error) });
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
      log('debug', 'Failed to stat otel trace file', { error: String(error) });
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    if (stat.size <= maxBytes) continue;

    const bytes = stat.size;
    const removeCounts = { filesRemoved: 0, dirsRemoved: 0, errors: 0 };
    removeRecursive(filePath, removeCounts, log);
    summary.filesRemoved += removeCounts.filesRemoved;
    summary.errors += removeCounts.errors;
    if (removeCounts.filesRemoved > 0) summary.bytesReclaimed += bytes;
  }
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
export function reclaimLiveBeadPriorTransitions(
  beadDirPath: string,
  currentState: string | undefined,
  currentActionId: string | undefined,
  nowMs: number,
  maxAgeMs: number,
  summary: RetentionAreaSummary,
  log: LogFn = noop
): void {
  const exemptSegments = resolveExemptSegments(currentState, currentActionId);
  // Cannot determine the current transition — preserve the entire live bead dir.
  if (!exemptSegments) return;

  let stateDirs: fs.Dirent[];
  try {
    stateDirs = fs.readdirSync(beadDirPath, { withFileTypes: true });
  } catch (error) {
    summary.errors++;
    log('debug', 'Failed to read live bead dir for prior-transition reclaim', { error: String(error) });
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
      log('debug', 'Failed to read live bead state dir during reclaim', { error: String(error) });
      continue;
    }

    for (const actionEntry of actionDirs) {
      if (!actionEntry.isDirectory()) continue;
      // GATE-BEFORE-RECLAIM carve-out: never reclaim the CURRENT state/action
      // subtree of a live bead — its coordinator gate may not have run yet.
      if (isExemptCurrentTransition(stateEntry.name, actionEntry.name, exemptSegments)) continue;

      const actionPath = path.join(statePath, actionEntry.name);
      let mtimeMs: number;
      try {
        mtimeMs = fs.lstatSync(actionPath).mtimeMs;
      } catch (error) {
        summary.errors++;
        log('debug', 'Failed to stat live bead action dir during reclaim', { error: String(error) });
        continue;
      }

      if (!hasExceededAge(mtimeMs, nowMs, maxAgeMs)) continue; // not yet aged out

      const bytes = calcSizeBytes(actionPath);
      const removeCounts = { filesRemoved: 0, dirsRemoved: 0, errors: 0 };
      removeRecursive(actionPath, removeCounts, log);
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
 *
 * Batch ceilings: `budget` bounds the total files/dirs removed in one pass.
 * When a ceiling is hit, budget.ceilingHit is set and no further bead entries
 * are processed.  Live-bead and evidence protections are NEVER relaxed by the
 * ceiling — the ceiling only stops scanning ADDITIONAL dead bead entries.
 */
export function scanToolOutputArea(
  toolOutputRoot: string,
  nowMs: number,
  maxAgeMs: number,
  liveBeadIds: Set<string> | null,
  currentTransitions: Map<string, { currentState?: string; currentActionId?: string }>,
  budget: ToolOutputBudget,
  log: LogFn = noop
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
    log('warn', 'Skipping tool-output retention: live bead IDs unavailable');
    return summary;
  }

  // Missing directory is a no-op.
  if (!fs.existsSync(toolOutputRoot)) return summary;

  let beadDirs: fs.Dirent[];
  try {
    beadDirs = fs.readdirSync(toolOutputRoot, { withFileTypes: true });
  } catch (error) {
    summary.errors++;
    log('warn', 'Failed to read tool-output directory during retention scan', { error: String(error) });
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
    // NOTE: live-bead processing is NOT subject to the batch ceiling — the
    // ceiling only halts processing of additional DEAD bead entries.
    if (liveBeadIds.has(beadId)) {
      const current = currentTransitions.get(beadId);
      reclaimLiveBeadPriorTransitions(
        beadDirPath,
        current?.currentState,
        current?.currentActionId,
        nowMs,
        maxAgeMs,
        summary,
        log
      );
      continue;
    }

    // Batch ceiling check: stop processing dead bead entries when a ceiling is hit.
    if (budget.filesRemaining <= 0 || budget.dirsRemaining <= 0) {
      budget.ceilingHit = true;
      log('info', 'Tool-output batch ceiling reached; deferring remaining dead bead entries', {
        filesRemaining: budget.filesRemaining,
        dirsRemaining: budget.dirsRemaining
      });
      break;
    }

    let mtimeMs: number;
    try {
      const stat = fs.lstatSync(beadDirPath);
      mtimeMs = stat.mtimeMs;
    } catch (error) {
      summary.errors++;
      log('debug', 'Failed to stat bead dir during tool-output retention scan', { error: String(error) });
      continue;
    }

    const ageMs = nowMs - mtimeMs;
    if (ageMs < maxAgeMs) continue;

    const bytes = calcSizeBytes(beadDirPath);
    const removeCounts = { filesRemoved: 0, dirsRemoved: 0, errors: 0 };
    removeRecursive(beadDirPath, removeCounts, log);

    summary.filesRemoved += removeCounts.filesRemoved;
    summary.dirsRemoved += removeCounts.dirsRemoved;
    summary.errors += removeCounts.errors;
    summary.bytesReclaimed += bytes;

    // Deduct from budget after removal so the ceiling is applied per-bead-dir.
    budget.filesRemaining -= removeCounts.filesRemoved;
    budget.dirsRemaining -= removeCounts.dirsRemoved;
  }

  return summary;
}
