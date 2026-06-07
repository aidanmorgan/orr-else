/**
 * query_artifact — tool-local RTK summary contract for the query_artifact built-in.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for query_artifact.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/query_artifact.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded artifact query result (projection + counts).
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const QUERY_ARTIFACT_TOOL_NAME = 'query_artifact';

/**
 * QueryArtifactRtkSummary — compact, deterministic summary of a query_artifact invocation.
 */
export interface QueryArtifactRtkSummary {
  /** Whether the query matched any artifact (result was non-empty). */
  found: boolean;
  /** Whether the result was truncated/projected due to size limits. */
  truncated: boolean;
  /** Approximate byte size of the returned result (0 if not found). */
  resultBytes: number;
}

export const QUERY_ARTIFACT_SCHEMA_DESCRIPTOR = {
  found: 'boolean',
  resultBytes: 'number',
  truncated: 'boolean',
} as const;

export function computeQueryArtifactSchemaHash(): string {
  const canonical = JSON.stringify(QUERY_ARTIFACT_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const QUERY_ARTIFACT_SCHEMA_HASH: string = computeQueryArtifactSchemaHash();

/**
 * Build the tool-local RTK summary for a query_artifact invocation.
 * Called from the registry factory in builtin_rtk_registry.ts.
 */
export function buildQueryArtifactRtkSummary(params: {
  result: unknown;
}): ToolEvidenceRtkSummary {
  let found = false;
  let truncated = false;
  let resultBytes = 0;

  if (params.result !== null && params.result !== undefined) {
    const resultStr = typeof params.result === 'string'
      ? params.result
      : JSON.stringify(params.result);
    resultBytes = Buffer.byteLength(resultStr, 'utf8');
    found = resultStr.length > 0 && resultStr !== 'null' && resultStr !== '{}' && resultStr !== '[]';
    // A result is truncated if it carries a 'truncated' flag or a 'sample' field.
    if (typeof params.result === 'object' && params.result !== null) {
      const rec = params.result as Record<string, unknown>;
      truncated = rec.truncated === true || rec.isTruncated === true || 'sample' in rec;
    }
  }

  const summary: QueryArtifactRtkSummary = { found, truncated, resultBytes };
  return {
    schemaTypeName: 'QueryArtifactRtkSummary',
    owningFile: 'src/tools/query_artifact.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: QUERY_ARTIFACT_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'artifact-query-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: {},
    omissionSemantics: 'query_artifact returns a bounded projection; full data lives in the artifact store',
    summary: summary as unknown as Record<string, unknown>,
  };
}
