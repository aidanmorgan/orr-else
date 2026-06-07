/**
 * read_path_context — tool-local RTK summary contract for the read_path_context built-in.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for read_path_context.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/read_path_context.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded path context result (file listing or content).
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const READ_PATH_CONTEXT_TOOL_NAME = 'read_path_context';

/**
 * ReadPathContextRtkSummary — compact, deterministic summary of a read_path_context invocation.
 */
export interface ReadPathContextRtkSummary {
  /** Whether the path context was successfully resolved. */
  resolved: boolean;
  /** Number of entries returned (files/directories listed, or 1 for file content). */
  entryCount: number;
  /** Whether the result was offset/limited (pagination applied). */
  paginated: boolean;
}

export const READ_PATH_CONTEXT_SCHEMA_DESCRIPTOR = {
  entryCount: 'number',
  paginated: 'boolean',
  resolved: 'boolean',
} as const;

export function computeReadPathContextSchemaHash(): string {
  const canonical = JSON.stringify(READ_PATH_CONTEXT_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const READ_PATH_CONTEXT_SCHEMA_HASH: string = computeReadPathContextSchemaHash();

/**
 * Build the tool-local RTK summary for a read_path_context invocation.
 * Called from the registry factory in builtin_rtk_registry.ts.
 */
export function buildReadPathContextRtkSummary(params: {
  result: unknown;
}): ToolEvidenceRtkSummary {
  let resolved = false;
  let entryCount = 0;
  let paginated = false;

  const result = params.result;
  if (result !== null && result !== undefined) {
    if (typeof result === 'string') {
      resolved = result.length > 0 && !result.startsWith('REJECTED') && !result.startsWith('Error:');
      entryCount = resolved ? 1 : 0;
    } else if (typeof result === 'object') {
      const rec = result as Record<string, unknown>;
      resolved = !('error' in rec);
      if (Array.isArray(rec.entries)) {
        entryCount = rec.entries.length;
      } else if (Array.isArray(rec.files)) {
        entryCount = rec.files.length;
      } else if (typeof rec.content === 'string') {
        entryCount = 1;
      } else if (resolved) {
        entryCount = 1;
      }
      paginated = typeof rec.offset === 'number' || typeof rec.limit === 'number';
    }
  }

  const summary: ReadPathContextRtkSummary = { resolved, entryCount, paginated };
  return {
    schemaTypeName: 'ReadPathContextRtkSummary',
    owningFile: 'src/tools/read_path_context.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: READ_PATH_CONTEXT_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'path-context-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: {},
    omissionSemantics: 'read_path_context returns a bounded result; full content lives in the file system',
    summary: summary as unknown as Record<string, unknown>,
  };
}
