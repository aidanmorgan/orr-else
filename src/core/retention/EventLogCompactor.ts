/**
 * EventLogCompactor — event-JSONL compaction without Logger/EventStore/process dependencies.
 *
 * Uses only fs and readline (no Logger singleton, no EventStore, no process globals).
 * Errors are surfaced via return values and an optional log callback.
 *
 * pi-experiment-amq0.17: extracted from RetentionCleanup.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { DomainEventName, REPLAY_CRITICAL_EVENT_TYPES } from '../../constants/domain.js';
import { EventStoreDefaults } from '../../constants/infra.js';
import { BeadEventIndex } from '../BeadEventIndex.js';
import { JsonlEventLog } from '../JsonlEventLog.js';

/**
 * Summary of a single JSONL compaction run.
 * Renamed from the RetentionCleanup-internal CompactionSummary to avoid
 * clashing with the CompactionSummary export in CompactionSummary.ts.
 */
export interface CompactionRunSummary {
  filesProcessed: number;
  eventsKept: number;
  eventsDropped: number;
  bytesReclaimed: number;
  errors: number;
  /** Basenames of primary JSONL files that were successfully rewritten (compacted). */
  compactedFileBasenames: Set<string>;
}

/** Minimal log callback — callers inject Logger.warn / Logger.debug etc. */
export type LogFn = (msg: string, meta?: Record<string, unknown>) => void;

/** No-op log function used when no logger is injected. */
const noop: LogFn = () => {};

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
export async function compactJsonlFile(
  filePath: string,
  nowMs: number,
  compactionWindowMs: number,
  liveBeadIds: Set<string>,
  warn: LogFn = noop
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
        // Two recorded shapes exist:
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
        // Note: compaction protection is based on the presence of an outputFile handle,
        // not on path-layout parsing. Path-layout parsing was removed from the matching
        // path (u7cl) — identity is determined solely by explicit canonical fields.
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
          (eventType === DomainEventName.PROJECT_TOOL_SUCCEEDED ||
           eventType === DomainEventName.PROJECT_TOOL_FAILED) &&
          typeof event.data?.outputFile === 'string' &&
          event.data.outputFile.length > 0
        ) {
          // zog2.16: PROJECT_TOOL_FAILED with outputFile = evidence-bearing short-circuit
          // rejection — must survive compaction so verifier gate can reconstruct tool status.
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
export async function runEventStoreCompaction(
  eventsDir: string,
  nowMs: number,
  compactionWindowMs: number,
  liveBeadIds: Set<string> | null,
  warn: LogFn = noop
): Promise<CompactionRunSummary> {
  const summary: CompactionRunSummary = {
    filesProcessed: 0,
    eventsKept: 0,
    eventsDropped: 0,
    bytesReclaimed: 0,
    errors: 0,
    compactedFileBasenames: new Set<string>()
  };

  // Fail-safe: skip if live-bead resolution failed.
  if (liveBeadIds === null) {
    warn('Skipping event-JSONL compaction: live bead IDs unavailable');
    return summary;
  }

  if (!fs.existsSync(eventsDir)) return summary;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(eventsDir, { withFileTypes: true });
  } catch (error) {
    summary.errors++;
    warn('Failed to read events directory for compaction', { error: String(error) });
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

    const result = await compactJsonlFile(filePath, nowMs, compactionWindowMs, liveBeadIds, warn);
    if (result.error) {
      summary.errors++;
      warn('Event-JSONL compaction failed for file', {
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
 * Invalidate by-bead index markers for compacted primary files.
 *
 * After compaction rewrites primary JSONL files, the by-bead index markers
 * store stale byte offsets (the primary shrank, so the stored offset may point
 * past EOF or into wrong bytes). Invalidate every affected bead index so the
 * next eventsForBead call rebuilds from offset 0 of the compacted file.
 */
export async function invalidateBeadIndexAfterCompaction(
  eventsDir: string,
  compactedFileBasenames: Set<string>,
  warn: LogFn = noop
): Promise<void> {
  if (compactedFileBasenames.size === 0) return;
  try {
    const beadIndex = new BeadEventIndex(new JsonlEventLog());
    await beadIndex.invalidateForSources(
      { dir: eventsDir },
      compactedFileBasenames
    );
  } catch (error) {
    warn('Failed to invalidate by-bead index after compaction', { error: String(error) });
  }
}
