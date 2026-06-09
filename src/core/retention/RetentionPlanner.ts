/**
 * RetentionPlanner — pure configuration-driven plan for retention scan areas.
 *
 * Produces the list of areas to scan and their per-area config from the
 * global retention settings. No filesystem I/O, no Logger, no EventStore,
 * no process globals.
 *
 * pi-experiment-amq0.17: extracted from RetentionCleanup.
 */

import { OperationalArtifactPath, RetentionDefaults } from '../../constants/infra.js';

/**
 * A single harness-owned area to clean up.
 */
export interface RetentionAreaPlan {
  /** Human-readable name used in summaries. */
  name: string;
  /** Project-relative path (from OperationalArtifactPath). */
  relativePath: string;
  /** Whether the OTEL max-bytes rotation pass should run after the age scan. */
  otelMaxBytesPass: boolean;
}

/**
 * Resolved config for a single retention run.
 * All optional fields from RetentionConfig are resolved to their defaults here.
 */
export interface ResolvedRetentionConfig {
  maxAgeMs: number;
  compactionEnabled: boolean;
  compactionWindowMs: number;
  diskHealthWarnBytes: number;
  otelMaxBytes: number;
  maxToolCallFilesPerRun: number;
  maxToolCallDirsPerRun: number;
}

/**
 * The harness-owned directories that are eligible for retention cleanup.
 * These are ONLY the harness's own log/.tmp/.trash areas — never project
 * source files or worktree content.
 */
export const STANDARD_RETENTION_AREAS: readonly RetentionAreaPlan[] = [
  { name: 'logs', relativePath: OperationalArtifactPath.PI_LOGS_DIR, otelMaxBytesPass: false },
  { name: 'tmp', relativePath: OperationalArtifactPath.TEMP_DIR, otelMaxBytesPass: false },
  { name: 'trash', relativePath: OperationalArtifactPath.PI_TRASH_DIR, otelMaxBytesPass: false },
  // OTEL traces (.pi/otel/traces-*.jsonl) grow unbounded otherwise; subject to
  // the same max-age reclaim as the other harness-owned areas, plus a max-bytes
  // rotation pass (see scanOtelMaxBytesArea in RetentionScanner).
  { name: 'otel', relativePath: OperationalArtifactPath.PI_OTEL_DIR, otelMaxBytesPass: true }
] as const;

/**
 * Relative path of the single PROJECT-scoped tool-output archive (0yt5.27).
 */
export const TOOL_OUTPUT_AREA_PATH = OperationalArtifactPath.PI_TOOL_OUTPUT_DIR;

/**
 * Resolve optional retention config fields to their defaults.
 * Pure — no I/O, no side effects.
 */
export function resolveRetentionConfig(
  maxAgeMsPositional: number,
  retentionConfig?: Partial<ResolvedRetentionConfig>
): ResolvedRetentionConfig {
  return {
    maxAgeMs: retentionConfig?.maxAgeMs ?? maxAgeMsPositional,
    compactionEnabled: retentionConfig?.compactionEnabled ?? RetentionDefaults.COMPACTION_ENABLED,
    compactionWindowMs: retentionConfig?.compactionWindowMs ?? RetentionDefaults.COMPACTION_WINDOW_MS,
    diskHealthWarnBytes: retentionConfig?.diskHealthWarnBytes ?? RetentionDefaults.DISK_HEALTH_WARN_BYTES,
    otelMaxBytes: retentionConfig?.otelMaxBytes ?? RetentionDefaults.OTEL_MAX_BYTES,
    maxToolCallFilesPerRun: retentionConfig?.maxToolCallFilesPerRun ?? RetentionDefaults.MAX_TOOL_CALL_FILES_PER_RUN,
    maxToolCallDirsPerRun: retentionConfig?.maxToolCallDirsPerRun ?? RetentionDefaults.MAX_TOOL_CALL_DIRS_PER_RUN
  };
}
