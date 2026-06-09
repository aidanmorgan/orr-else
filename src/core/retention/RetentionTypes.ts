/**
 * Shared types for the retention subsystem.
 *
 * Defined here (not in RetentionCleanup.ts) to avoid circular imports between
 * RetentionCleanup.ts and the sub-role modules.
 *
 * pi-experiment-amq0.17.
 */

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
  /**
   * True when the tool-output area cleanup was stopped early because a
   * configured batch ceiling (maxToolCallFilesPerRun or maxToolCallDirsPerRun)
   * was reached before all eligible entries were processed.
   */
  backpressureActive: boolean;
}
