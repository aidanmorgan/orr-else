/**
 * query_harness_logs — tool-local RTK summary contract for the query_harness_logs built-in.
 *
 * pi-experiment-6q0y.24 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for query_harness_logs.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/query_harness_logs.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded harness-log query result (counts + optional excerpts).
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const QUERY_HARNESS_LOGS_TOOL_NAME = 'query_harness_logs';

/**
 * QueryHarnessLogsRtkSummary — compact, deterministic summary of a
 * query_harness_logs invocation.
 */
export interface QueryHarnessLogsRtkSummary {
  /** Total log lines matched by the query. */
  totalMatched: number;
  /** Number of malformed lines counted but not inlined. */
  malformedCount: number;
  /** Whether the response was truncated/capped (excerpt mode). */
  capped: boolean;
}

export const QUERY_HARNESS_LOGS_SCHEMA_DESCRIPTOR = {
  capped: 'boolean',
  malformedCount: 'number',
  totalMatched: 'number',
} as const;

export function computeQueryHarnessLogsSchemaHash(): string {
  const canonical = JSON.stringify(QUERY_HARNESS_LOGS_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const QUERY_HARNESS_LOGS_SCHEMA_HASH: string = computeQueryHarnessLogsSchemaHash();

/**
 * Build the tool-local RTK summary for a query_harness_logs invocation.
 * Called from the registry factory in builtin_rtk_registry.ts.
 */
export function buildQueryHarnessLogsRtkSummary(params: {
  result: unknown;
}): ToolEvidenceRtkSummary {
  let totalMatched = 0;
  let malformedCount = 0;
  let capped = false;

  const result = params.result;
  if (result !== null && result !== undefined && typeof result === 'object') {
    const rec = result as Record<string, unknown>;
    if (typeof rec.totalMatched === 'number') totalMatched = rec.totalMatched;
    if (typeof rec.malformedCount === 'number') malformedCount = rec.malformedCount;
    capped = rec.capped === true || rec.status === 'excerpt';
  }

  const summary: QueryHarnessLogsRtkSummary = { totalMatched, malformedCount, capped };
  return {
    schemaTypeName: 'QueryHarnessLogsRtkSummary',
    owningFile: 'src/tools/query_harness_logs.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: QUERY_HARNESS_LOGS_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'harness-logs-query-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: {},
    omissionSemantics: 'query_harness_logs returns a bounded log window; full logs live in .pi/logs/',
    summary: summary as unknown as Record<string, unknown>,
  };
}
