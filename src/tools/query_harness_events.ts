/**
 * query_harness_events — tool-local RTK summary contract for the query_harness_events built-in.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for query_harness_events.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/query_harness_events.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded event query result (matching events + count).
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const QUERY_HARNESS_EVENTS_TOOL_NAME = 'query_harness_events';

/**
 * QueryHarnessEventsRtkSummary — compact, deterministic summary of a
 * query_harness_events invocation.
 */
export interface QueryHarnessEventsRtkSummary {
  /** Number of events returned in the result. */
  returnedCount: number;
  /** Total events matching the query (may exceed returnedCount if capped). */
  totalMatchCount: number;
  /** Whether the result was capped/truncated due to a limit. */
  capped: boolean;
}

export const QUERY_HARNESS_EVENTS_SCHEMA_DESCRIPTOR = {
  capped: 'boolean',
  returnedCount: 'number',
  totalMatchCount: 'number',
} as const;

export function computeQueryHarnessEventsSchemaHash(): string {
  const canonical = JSON.stringify(QUERY_HARNESS_EVENTS_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const QUERY_HARNESS_EVENTS_SCHEMA_HASH: string = computeQueryHarnessEventsSchemaHash();

/**
 * Build the tool-local RTK summary for a query_harness_events invocation.
 * Called from the registry factory in builtin_rtk_registry.ts.
 */
export function buildQueryHarnessEventsRtkSummary(params: {
  result: unknown;
}): ToolEvidenceRtkSummary {
  let returnedCount = 0;
  let totalMatchCount = 0;
  let capped = false;

  const result = params.result;
  if (result !== null && result !== undefined && typeof result === 'object') {
    const rec = result as Record<string, unknown>;
    if (Array.isArray(rec.events)) {
      returnedCount = rec.events.length;
    } else if (Array.isArray(rec.results)) {
      returnedCount = rec.results.length;
    }
    totalMatchCount = typeof rec.total === 'number' ? rec.total : returnedCount;
    capped = rec.capped === true || rec.truncated === true || totalMatchCount > returnedCount;
  }

  const summary: QueryHarnessEventsRtkSummary = { returnedCount, totalMatchCount, capped };
  return {
    schemaTypeName: 'QueryHarnessEventsRtkSummary',
    owningFile: 'src/tools/query_harness_events.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: QUERY_HARNESS_EVENTS_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'harness-events-query-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: {},
    omissionSemantics: 'query_harness_events returns a bounded event window; full event log lives in the event store',
    summary: summary as unknown as Record<string, unknown>,
  };
}
