/**
 * request_harness_restart — tool-local RTK summary contract for the request_harness_restart built-in.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for request_harness_restart.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/request_harness_restart.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded acknowledgment of the restart request.
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const REQUEST_HARNESS_RESTART_TOOL_NAME = 'request_harness_restart';

/**
 * RequestHarnessRestartRtkSummary — compact, deterministic summary of a
 * request_harness_restart invocation.
 */
export interface RequestHarnessRestartRtkSummary {
  /** Whether the restart request was accepted (not rejected). */
  accepted: boolean;
  /** Brief reason for the restart request (truncated to 200 chars). */
  reasonPreview: string;
}

export const REQUEST_HARNESS_RESTART_SCHEMA_DESCRIPTOR = {
  accepted: 'boolean',
  reasonPreview: 'string',
} as const;

export function computeRequestHarnessRestartSchemaHash(): string {
  const canonical = JSON.stringify(REQUEST_HARNESS_RESTART_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const REQUEST_HARNESS_RESTART_SCHEMA_HASH: string = computeRequestHarnessRestartSchemaHash();

const MAX_REASON_PREVIEW_CHARS = 200;

/**
 * Build the tool-local RTK summary for a request_harness_restart invocation.
 * Called from the registry factory in builtin_rtk_registry.ts.
 */
export function buildRequestHarnessRestartRtkSummary(params: {
  result: unknown;
  reason: string;
}): ToolEvidenceRtkSummary {
  const resultStr = typeof params.result === 'string' ? params.result : JSON.stringify(params.result ?? '');
  const accepted = !resultStr.startsWith('REJECTED') && !resultStr.startsWith('Error:');
  const summary: RequestHarnessRestartRtkSummary = {
    accepted,
    reasonPreview: params.reason.slice(0, MAX_REASON_PREVIEW_CHARS),
  };
  return {
    schemaTypeName: 'RequestHarnessRestartRtkSummary',
    owningFile: 'src/tools/request_harness_restart.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: REQUEST_HARNESS_RESTART_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'harness-restart-request',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: { reasonPreviewChars: MAX_REASON_PREVIEW_CHARS },
    omissionSemantics: `reasonPreview is truncated to ${MAX_REASON_PREVIEW_CHARS} chars; full reason is in the event store`,
    summary: summary as unknown as Record<string, unknown>,
  };
}
