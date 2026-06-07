/**
 * signal_completion — tool-local RTK summary contract for the signal_completion built-in.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for signal_completion.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/signal_completion.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded acknowledgment or REJECTED message.
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const SIGNAL_COMPLETION_TOOL_NAME = 'signal_completion';

/**
 * SignalCompletionRtkSummary — compact, deterministic summary of a signal_completion invocation.
 */
export interface SignalCompletionRtkSummary {
  /** Whether the completion was accepted (not rejected by a gate). */
  accepted: boolean;
  /** The requested outcome (e.g. 'SUCCESS', 'FAILURE', 'BLOCKED'). */
  requestedOutcome: string;
  /** Brief reason if rejected (truncated to 200 chars). */
  rejectionPreview?: string;
}

export const SIGNAL_COMPLETION_SCHEMA_DESCRIPTOR = {
  accepted: 'boolean',
  rejectionPreview: 'string|undefined',
  requestedOutcome: 'string',
} as const;

export function computeSignalCompletionSchemaHash(): string {
  const canonical = JSON.stringify(SIGNAL_COMPLETION_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const SIGNAL_COMPLETION_SCHEMA_HASH: string = computeSignalCompletionSchemaHash();

const MAX_REJECTION_PREVIEW_CHARS = 200;

/**
 * Build the tool-local RTK summary for a signal_completion invocation.
 * Called from the BUILTIN_RTK_SUMMARY_REGISTRY factory; assembled into a handle by wrapPluginTool.
 *
 * accepted = true when the result does NOT start with 'REJECTED:'.
 */
export function buildSignalCompletionRtkSummary(params: {
  result: string;
  requestedOutcome: string;
}): ToolEvidenceRtkSummary {
  const accepted = !params.result.startsWith('REJECTED:') && !params.result.startsWith('Error:');
  const summary: SignalCompletionRtkSummary = {
    accepted,
    requestedOutcome: params.requestedOutcome,
    ...(!accepted ? { rejectionPreview: params.result.slice(0, MAX_REJECTION_PREVIEW_CHARS) } : {}),
  };

  return {
    schemaTypeName: 'SignalCompletionRtkSummary',
    owningFile: 'src/tools/signal_completion.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: SIGNAL_COMPLETION_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'signal-completion-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: { rejectionPreviewChars: MAX_REJECTION_PREVIEW_CHARS },
    omissionSemantics: `rejectionPreview is truncated to ${MAX_REJECTION_PREVIEW_CHARS} chars; full reason is in the event store`,
    summary: summary as unknown as Record<string, unknown>,
  };
}
