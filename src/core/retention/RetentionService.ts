/**
 * RetentionService — orchestrates retention cleanup via injected adapters.
 *
 * Coordinates RetentionScanner, EventLogCompactor, RetentionReporter, and
 * RetentionPlanner. Accepts injected ports for EventStore (event recording)
 * and the live-bead resolver.
 *
 * Constructed directly by RetentionScheduler (pi-experiment-amq0.17 removed
 * the RetentionCleanup pass-through layer — no-backcompat).
 *
 * pi-experiment-amq0.17: extracted from RetentionCleanup; pass-through deleted.
 */

import { nodeLogger as Logger } from '../Logger.js'
import { Component, OperationalArtifactPath } from '../../constants/infra.js';
import { resolveProjectFrom } from '../Paths.js';
import {
  scanArea,
  scanOtelMaxBytesArea,
  scanToolOutputArea,
  type ToolOutputBudget
} from './RetentionScanner.js';
import {
  runEventStoreCompaction,
  invalidateBeadIndexAfterCompaction,
  type CompactionRunSummary
} from './EventLogCompactor.js';
import {
  reportRetentionResult,
  logCompactionResult,
  type RetentionEventRecorder
} from './RetentionReporter.js';
import {
  STANDARD_RETENTION_AREAS,
  TOOL_OUTPUT_AREA_PATH,
  type ResolvedRetentionConfig
} from './RetentionPlanner.js';
import type { RetentionAreaSummary, RetentionCleanupResult } from './RetentionTypes.js';
import type { Clock } from '../Clock.js';
import type { BeadId } from '../../types/ids.js';

/** Port for projecting the current bead state/action (gate-before-reclaim carve-out). */
export interface BeadStateProjectionPort {
  projectBeadStateChart(beadId: BeadId): Promise<{
    currentState?: string;
    activeActionId?: string;
  }>;
}

/** Combined event port for RetentionService. */
export interface RetentionServiceEventPort extends RetentionEventRecorder {
  projectBeadStateChart(beadId: BeadId): Promise<{
    currentState?: string;
    activeActionId?: string;
  }>;
}

/**
 * Injected log adapter so the scanner/compactor don't touch the Logger singleton.
 */
function makeLogAdapter() {
  return (level: 'debug' | 'warn' | 'info', msg: string, meta?: Record<string, unknown>) => {
    if (level === 'debug') Logger.debug(Component.RETENTION, msg, meta);
    else if (level === 'warn') Logger.warn(Component.RETENTION, msg, meta);
    else Logger.info(Component.RETENTION, msg, meta);
  };
}

/**
 * RetentionService — the central coordinator for a single retention run.
 *
 * Constructed per-run from config; stateless across runs (all state is local
 * to `run()`).
 */
export class RetentionService {
  constructor(
    private readonly projectRoot: string,
    private readonly clock: Clock,
    private readonly eventPort: RetentionServiceEventPort,
    private readonly config: ResolvedRetentionConfig,
    private readonly liveBeadIds: (() => Set<string> | Promise<Set<string>>) | null
  ) {}

  /**
   * Run retention cleanup across all configured harness areas.
   * Returns an aggregate result with per-area summaries.
   */
  public async run(): Promise<RetentionCleanupResult> {
    const nowMs = this.clock.now();
    const log = makeLogAdapter();
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

    for (const area of STANDARD_RETENTION_AREAS) {
      const areaRoot = resolveProjectFrom(this.projectRoot, area.relativePath);
      const summary = scanArea(areaRoot, area.name, nowMs, this.config.maxAgeMs, log);
      // Bound OTEL traces by size as well as age: a recent-but-huge traces-*.jsonl
      // is rotated even though the age scan above would keep it.
      if (area.otelMaxBytesPass) {
        scanOtelMaxBytesArea(areaRoot, this.config.otelMaxBytes, summary, log);
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
    //
    // cp8u: batch ceilings bound the number of files/dirs removed per run to
    // prevent million-file cleanup spikes from legacy scratch accumulation.
    const toolOutputBudget: ToolOutputBudget = {
      filesRemaining: this.config.maxToolCallFilesPerRun,
      dirsRemaining: this.config.maxToolCallDirsPerRun,
      ceilingHit: false
    };
    const toolOutputRoot = resolveProjectFrom(this.projectRoot, TOOL_OUTPUT_AREA_PATH);
    areas.push(scanToolOutputArea(toolOutputRoot, nowMs, this.config.maxAgeMs, resolvedLiveBeadIds, currentTransitions, toolOutputBudget, log));

    const totalFilesRemoved = areas.reduce((acc, a) => acc + a.filesRemoved, 0);
    const totalDirsRemoved = areas.reduce((acc, a) => acc + a.dirsRemoved, 0);
    const totalBytesReclaimed = areas.reduce((acc, a) => acc + a.bytesReclaimed, 0);
    const totalErrors = areas.reduce((acc, a) => acc + a.errors, 0);

    // ── Event-JSONL compaction ──────────────────────────────────────────────
    let compactionSummary: CompactionRunSummary = {
      filesProcessed: 0,
      eventsKept: 0,
      eventsDropped: 0,
      bytesReclaimed: 0,
      errors: 0,
      compactedFileBasenames: new Set<string>()
    };

    if (this.config.compactionEnabled) {
      const eventsDir = resolveProjectFrom(this.projectRoot, OperationalArtifactPath.PI_EVENTS_DIR);
      compactionSummary = await runEventStoreCompaction(
        eventsDir,
        nowMs,
        this.config.compactionWindowMs,
        resolvedLiveBeadIds,
        (msg, meta) => Logger.warn(Component.RETENTION, msg, meta)
      );

      // MUST-FIX 2: After compaction rewrites primary JSONL files, the by-bead
      // index markers store stale byte offsets. Invalidate every affected bead index.
      await invalidateBeadIndexAfterCompaction(
        eventsDir,
        compactionSummary.compactedFileBasenames,
        (msg, meta) => Logger.warn(Component.RETENTION, msg, meta)
      );

      logCompactionResult(compactionSummary);
    }

    const result: RetentionCleanupResult = {
      areas,
      totalFilesRemoved,
      totalDirsRemoved,
      totalBytesReclaimed,
      totalErrors,
      eventsCompacted: compactionSummary.eventsDropped,
      backpressureActive: toolOutputBudget.ceilingHit
    };

    await reportRetentionResult(
      result,
      compactionSummary,
      this.config.diskHealthWarnBytes,
      this.config.maxToolCallFilesPerRun,
      this.config.maxToolCallDirsPerRun,
      this.eventPort
    );

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
        const projection = await this.eventPort.projectBeadStateChart(beadId as BeadId);
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
