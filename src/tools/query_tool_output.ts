/**
 * query_tool_output — tool-local RTK summary contract for the query_tool_output built-in.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for query_tool_output.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/query_tool_output.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded tool-output query result (content + metadata).
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const QUERY_TOOL_OUTPUT_TOOL_NAME = 'query_tool_output';

/**
 * QueryToolOutputRtkSummary — compact, deterministic summary of a query_tool_output invocation.
 */
export interface QueryToolOutputRtkSummary {
  /** Whether the queried tool output was found. */
  found: boolean;
  /** Approximate byte size of the returned content (0 if not found). */
  contentBytes: number;
  /** Whether the content was truncated due to size limits. */
  truncated: boolean;
}

export const QUERY_TOOL_OUTPUT_SCHEMA_DESCRIPTOR = {
  contentBytes: 'number',
  found: 'boolean',
  truncated: 'boolean',
} as const;

export function computeQueryToolOutputSchemaHash(): string {
  const canonical = JSON.stringify(QUERY_TOOL_OUTPUT_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const QUERY_TOOL_OUTPUT_SCHEMA_HASH: string = computeQueryToolOutputSchemaHash();

/**
 * Build the tool-local RTK summary for a query_tool_output invocation.
 * Called from the registry factory in builtin_rtk_registry.ts.
 */
export function buildQueryToolOutputRtkSummary(params: {
  result: unknown;
}): ToolEvidenceRtkSummary {
  let found = false;
  let contentBytes = 0;
  let truncated = false;

  const result = params.result;
  if (result !== null && result !== undefined) {
    if (typeof result === 'string') {
      found = result.length > 0 && !result.startsWith('Error:') && !result.startsWith('REJECTED');
      contentBytes = Buffer.byteLength(result, 'utf8');
    } else if (typeof result === 'object') {
      const rec = result as Record<string, unknown>;
      found = !('error' in rec) && ('content' in rec || 'output' in rec || 'stdout' in rec);
      const content = rec.content ?? rec.output ?? rec.stdout;
      if (typeof content === 'string') {
        contentBytes = Buffer.byteLength(content, 'utf8');
      } else {
        contentBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
      }
      truncated = rec.truncated === true || rec.isTruncated === true;
    }
  }

  const summary: QueryToolOutputRtkSummary = { found, contentBytes, truncated };
  return {
    schemaTypeName: 'QueryToolOutputRtkSummary',
    owningFile: 'src/tools/query_tool_output.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: QUERY_TOOL_OUTPUT_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'tool-output-query-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: {},
    omissionSemantics: 'query_tool_output returns a bounded content window; full output lives in the tool-output archive',
    summary: summary as unknown as Record<string, unknown>,
  };
}
