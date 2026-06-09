/**
 * RetentionReporter — logging and event recording for retention cleanup results.
 *
 * Accepts injected EventStore and Logger ports (not the singletons directly),
 * so it can be tested with fakes.
 *
 * pi-experiment-amq0.17: extracted from RetentionCleanup.
 */

import { nodeLogger as Logger } from '../Logger.js'
import { DomainEventName } from '../../constants/domain.js';
import { Component } from '../../constants/infra.js';
import type { RetentionAreaSummary, RetentionCleanupResult } from './RetentionTypes.js';
import type { CompactionRunSummary } from './EventLogCompactor.js';

/** Minimal EventStore port for retention reporting. */
export interface RetentionEventRecorder {
  record(eventName: string, data: Record<string, unknown>): Promise<void>;
}

/**
 * Log the retention cleanup result and record domain events.
 *
 * Records RETENTION_CLEANUP_COMPLETED always, and RETENTION_DISK_HEALTH when
 * bytes reclaimed exceeds the threshold or backpressure is active.
 */
export async function reportRetentionResult(
  result: RetentionCleanupResult,
  compactionSummary: CompactionRunSummary,
  diskHealthWarnBytes: number,
  maxToolCallFilesPerRun: number,
  maxToolCallDirsPerRun: number,
  eventRecorder: RetentionEventRecorder
): Promise<void> {
  const { areas, totalFilesRemoved, totalDirsRemoved, totalBytesReclaimed, totalErrors, backpressureActive } = result;

  // Only log when there is something noteworthy to report.
  const anythingRemoved = totalFilesRemoved > 0 || totalDirsRemoved > 0 || totalErrors > 0 || backpressureActive;
  if (anythingRemoved) {
    const areaSummaries = areas
      .filter((a: RetentionAreaSummary) => a.filesRemoved > 0 || a.dirsRemoved > 0 || a.errors > 0)
      .map((a: RetentionAreaSummary) => `${a.area}: ${a.filesRemoved}f/${a.dirsRemoved}d removed, ${a.bytesReclaimed}B reclaimed, ${a.errors} errors`);

    Logger.info(Component.RETENTION, 'Retention cleanup completed', {
      totalFilesRemoved,
      totalDirsRemoved,
      totalBytesReclaimed,
      totalErrors,
      backpressureActive,
      areas: areaSummaries
    });
  }

  // Always record the domain event so operators can observe that cleanup ran.
  await eventRecorder.record(DomainEventName.RETENTION_CLEANUP_COMPLETED, {
    totalFilesRemoved,
    totalDirsRemoved,
    totalBytesReclaimed,
    totalErrors,
    eventsCompacted: compactionSummary.eventsDropped,
    areaNames: areas.map((a: RetentionAreaSummary) => a.area),
    areaSummaries: areas.map((a: RetentionAreaSummary) => ({
      area: a.area,
      entriesScanned: a.entriesScanned,
      filesRemoved: a.filesRemoved,
      dirsRemoved: a.dirsRemoved,
      bytesReclaimed: a.bytesReclaimed,
      errors: a.errors
    }))
  }).catch((error: unknown) => {
    Logger.warn(Component.RETENTION, 'Failed to record RETENTION_CLEANUP_COMPLETED event', { error: String(error) });
  });

  // ── Disk-usage / backpressure health event ──────────────────────────────
  // Emit a RETENTION_DISK_HEALTH event when total bytes reclaimed (from both
  // filesystem cleanup and JSONL compaction) exceeds the configured threshold,
  // OR when the tool-output batch ceiling was hit (backpressure is active).
  const totalBytesFreed = totalBytesReclaimed + compactionSummary.bytesReclaimed;
  const toolOutputArea = areas.find((a: RetentionAreaSummary) => a.area === 'pi/tool-output');
  if (totalBytesFreed >= diskHealthWarnBytes || backpressureActive) {
    await eventRecorder.record(DomainEventName.RETENTION_DISK_HEALTH, {
      totalBytesReclaimed: totalBytesFreed,
      filesystemBytesReclaimed: totalBytesReclaimed,
      compactionBytesReclaimed: compactionSummary.bytesReclaimed,
      eventsCompacted: compactionSummary.eventsDropped,
      diskHealthWarnBytes,
      backpressureActive,
      toolCallFilesRemovedThisRun: toolOutputArea?.filesRemoved ?? 0,
      toolCallDirsRemovedThisRun: toolOutputArea?.dirsRemoved ?? 0,
      maxToolCallFilesPerRun,
      maxToolCallDirsPerRun,
      message: backpressureActive
        ? `Retention batch ceiling hit (files≤${maxToolCallFilesPerRun}, dirs≤${maxToolCallDirsPerRun}); deferred remaining tool-call artifacts`
        : `Retention reclaimed ${totalBytesFreed} bytes (threshold: ${diskHealthWarnBytes})`
    }).catch((error: unknown) => {
      Logger.warn(Component.RETENTION, 'Failed to record RETENTION_DISK_HEALTH event', { error: String(error) });
    });
  }
}

/**
 * Log event-JSONL compaction result if anything was compacted or errored.
 */
export function logCompactionResult(compactionSummary: CompactionRunSummary): void {
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
