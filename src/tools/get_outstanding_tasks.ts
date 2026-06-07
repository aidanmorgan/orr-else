/**
 * get_outstanding_tasks — tool-local RTK summary contract for the get_outstanding_tasks built-in.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for get_outstanding_tasks.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/get_outstanding_tasks.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded checklist snapshot (pending + completed counts).
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const GET_OUTSTANDING_TASKS_TOOL_NAME = 'get_outstanding_tasks';

/**
 * GetOutstandingTasksRtkSummary — compact, deterministic summary of a
 * get_outstanding_tasks invocation.
 */
export interface GetOutstandingTasksRtkSummary {
  /** Total number of checklist items returned. */
  totalCount: number;
  /** Number of items still pending (not yet ticked). */
  pendingCount: number;
  /** Number of items that have been completed. */
  completedCount: number;
  /** Number of mandatory items that are still pending. */
  mandatoryPendingCount: number;
}

export const GET_OUTSTANDING_TASKS_SCHEMA_DESCRIPTOR = {
  completedCount: 'number',
  mandatoryPendingCount: 'number',
  pendingCount: 'number',
  totalCount: 'number',
} as const;

export function computeGetOutstandingTasksSchemaHash(): string {
  const canonical = JSON.stringify(GET_OUTSTANDING_TASKS_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const GET_OUTSTANDING_TASKS_SCHEMA_HASH: string = computeGetOutstandingTasksSchemaHash();

/**
 * Build the tool-local RTK summary for a get_outstanding_tasks invocation.
 * Called from the registry factory in builtin_rtk_registry.ts.
 */
export function buildGetOutstandingTasksRtkSummary(params: {
  totalCount: number;
  pendingCount: number;
  completedCount: number;
  mandatoryPendingCount: number;
}): ToolEvidenceRtkSummary {
  const summary: GetOutstandingTasksRtkSummary = {
    totalCount: params.totalCount,
    pendingCount: params.pendingCount,
    completedCount: params.completedCount,
    mandatoryPendingCount: params.mandatoryPendingCount,
  };
  return {
    schemaTypeName: 'GetOutstandingTasksRtkSummary',
    owningFile: 'src/tools/get_outstanding_tasks.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: GET_OUTSTANDING_TASKS_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'outstanding-tasks-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: {},
    omissionSemantics: 'get_outstanding_tasks returns a complete bounded checklist snapshot; no items are omitted',
    summary: summary as unknown as Record<string, unknown>,
  };
}
