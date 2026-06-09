/**
 * query_otel_spans — tool-local RTK summary contract for the query_otel_spans built-in.
 *
 * pi-experiment-6q0y.26 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for query_otel_spans.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/query_otel_spans.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded OTEL span query result (stats or bounded spans).
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const QUERY_OTEL_SPANS_TOOL_NAME = 'query_otel_spans';

/**
 * QueryOtelSpansRtkSummary — compact, deterministic summary of a
 * query_otel_spans invocation.
 */
export interface QueryOtelSpansRtkSummary {
  /** Total spans matched by the query. */
  totalMatched: number;
  /** Number of malformed/rotated records counted. */
  malformedCount: number;
  /** Whether the result was capped (detail mode). */
  capped: boolean;
}

export const QUERY_OTEL_SPANS_SCHEMA_DESCRIPTOR = {
  capped: 'boolean',
  malformedCount: 'number',
  totalMatched: 'number',
} as const;

export function computeQueryOtelSpansSchemaHash(): string {
  const canonical = JSON.stringify(QUERY_OTEL_SPANS_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const QUERY_OTEL_SPANS_SCHEMA_HASH: string = computeQueryOtelSpansSchemaHash();

/**
 * Build the tool-local RTK summary for a query_otel_spans invocation.
 * Called from the registry factory in builtin_rtk_registry.ts.
 */
export function buildQueryOtelSpansRtkSummary(params: {
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
    capped = rec.capped === true;
  }

  const summary: QueryOtelSpansRtkSummary = { totalMatched, malformedCount, capped };
  return {
    schemaTypeName: 'QueryOtelSpansRtkSummary',
    owningFile: 'src/tools/query_otel_spans.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: QUERY_OTEL_SPANS_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'otel-spans-query-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: {},
    omissionSemantics: 'query_otel_spans returns a bounded span window; full traces live in .pi/otel/',
    summary: summary as unknown as Record<string, unknown>,
  };
}
