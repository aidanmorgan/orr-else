/**
 * request_context_restart — tool-local RTK summary contract for the request_context_restart built-in.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for request_context_restart.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/request_context_restart.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded acknowledgment of the restart request.
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const REQUEST_CONTEXT_RESTART_TOOL_NAME = 'request_context_restart';

/**
 * RequestContextRestartRtkSummary — compact, deterministic summary of a
 * request_context_restart invocation.
 */
export interface RequestContextRestartRtkSummary {
  /** Whether the restart request was accepted (not rejected). */
  accepted: boolean;
  /** Brief reason for the restart request (truncated to 200 chars). */
  reasonPreview: string;
}

export const REQUEST_CONTEXT_RESTART_SCHEMA_DESCRIPTOR = {
  accepted: 'boolean',
  reasonPreview: 'string',
} as const;

export function computeRequestContextRestartSchemaHash(): string {
  const canonical = JSON.stringify(REQUEST_CONTEXT_RESTART_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const REQUEST_CONTEXT_RESTART_SCHEMA_HASH: string = computeRequestContextRestartSchemaHash();

const MAX_REASON_PREVIEW_CHARS = 200;

/**
 * Build the tool-local RTK summary for a request_context_restart invocation.
 * Called from the registry factory in builtin_rtk_registry.ts.
 */
export function buildRequestContextRestartRtkSummary(params: {
  result: unknown;
  reason: string;
}): ToolEvidenceRtkSummary {
  const resultStr = typeof params.result === 'string' ? params.result : JSON.stringify(params.result ?? '');
  const accepted = !resultStr.startsWith('REJECTED') && !resultStr.startsWith('Error:');
  const summary: RequestContextRestartRtkSummary = {
    accepted,
    reasonPreview: params.reason.slice(0, MAX_REASON_PREVIEW_CHARS),
  };
  return {
    schemaTypeName: 'RequestContextRestartRtkSummary',
    owningFile: 'src/tools/request_context_restart.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: REQUEST_CONTEXT_RESTART_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'context-restart-request',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: { reasonPreviewChars: MAX_REASON_PREVIEW_CHARS },
    omissionSemantics: `reasonPreview is truncated to ${MAX_REASON_PREVIEW_CHARS} chars; full reason is in the event store`,
    summary: summary as unknown as Record<string, unknown>,
  };
}
