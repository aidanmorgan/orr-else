/**
 * get_artifact_paths — tool-local RTK summary contract for the get_artifact_paths built-in.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for get_artifact_paths.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/get_artifact_paths.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded artifact path resolution result (paths + existence).
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const GET_ARTIFACT_PATHS_TOOL_NAME = 'get_artifact_paths';

/**
 * GetArtifactPathsRtkSummary — compact, deterministic summary of a get_artifact_paths invocation.
 */
export interface GetArtifactPathsRtkSummary {
  /** Number of artifact paths resolved. */
  resolvedCount: number;
  /** Number of artifacts that exist on disk. */
  existingCount: number;
  /** Number of artifacts that are missing on disk. */
  missingCount: number;
  /** The bead id queried. */
  beadId?: string;
  /** The state id queried. */
  stateId?: string;
}

export const GET_ARTIFACT_PATHS_SCHEMA_DESCRIPTOR = {
  beadId: 'string|undefined',
  existingCount: 'number',
  missingCount: 'number',
  resolvedCount: 'number',
  stateId: 'string|undefined',
} as const;

export function computeGetArtifactPathsSchemaHash(): string {
  const canonical = JSON.stringify(GET_ARTIFACT_PATHS_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const GET_ARTIFACT_PATHS_SCHEMA_HASH: string = computeGetArtifactPathsSchemaHash();

/**
 * Build the tool-local RTK summary for a get_artifact_paths invocation.
 * Called from the BUILTIN_RTK_SUMMARY_REGISTRY factory; assembled into a handle by wrapPluginTool.
 */
export function buildGetArtifactPathsRtkSummary(params: {
  result: unknown;
  beadId?: string;
  stateId?: string;
}): ToolEvidenceRtkSummary {
  // Derive counts from the result shape — deterministic, pure TypeScript.
  let resolvedCount = 0;
  let existingCount = 0;
  let missingCount = 0;
  const result = params.result;
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    const rec = result as Record<string, unknown>;
    if (Array.isArray(rec.paths)) resolvedCount = rec.paths.length;
    if (Array.isArray(rec.existing)) existingCount = rec.existing.length;
    if (Array.isArray(rec.missing)) missingCount = rec.missing.length;
    // Also handle flat existence map: { [artifactId]: { path, exists } }
    if (resolvedCount === 0 && typeof rec === 'object') {
      for (const v of Object.values(rec)) {
        if (v !== null && typeof v === 'object' && 'path' in (v as object)) {
          resolvedCount += 1;
          if ((v as Record<string, unknown>).exists === true) existingCount += 1;
          else missingCount += 1;
        }
      }
    }
  }

  const summary: GetArtifactPathsRtkSummary = {
    resolvedCount,
    existingCount,
    missingCount,
    ...(params.beadId !== undefined ? { beadId: params.beadId } : {}),
    ...(params.stateId !== undefined ? { stateId: params.stateId } : {}),
  };

  return {
    schemaTypeName: 'GetArtifactPathsRtkSummary',
    owningFile: 'src/tools/get_artifact_paths.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: GET_ARTIFACT_PATHS_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'artifact-paths-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: {},
    omissionSemantics: 'get_artifact_paths returns all declared artifact paths; no items are omitted',
    summary: summary as unknown as Record<string, unknown>,
  };
}
