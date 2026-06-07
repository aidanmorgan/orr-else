/**
 * submit_checkpoint — tool-local RTK summary contract for the submit_checkpoint built-in.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for submit_checkpoint.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/submit_checkpoint.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded acknowledgment ('Checkpoint accepted and recorded.').
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const SUBMIT_CHECKPOINT_TOOL_NAME = 'submit_checkpoint';

/**
 * SubmitCheckpointRtkSummary — compact, deterministic summary of a submit_checkpoint invocation.
 */
export interface SubmitCheckpointRtkSummary {
  /** Whether the checkpoint was accepted (PASSED) or rejected. */
  accepted: boolean;
  /** Brief summary of what was submitted (truncated to 120 chars). */
  summaryPreview: string;
}

export const SUBMIT_CHECKPOINT_SCHEMA_DESCRIPTOR = {
  accepted: 'boolean',
  summaryPreview: 'string',
} as const;

export function computeSubmitCheckpointSchemaHash(): string {
  const canonical = JSON.stringify(SUBMIT_CHECKPOINT_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const SUBMIT_CHECKPOINT_SCHEMA_HASH: string = computeSubmitCheckpointSchemaHash();

const MAX_SUMMARY_PREVIEW_CHARS = 120;

/**
 * Build the tool-local RTK summary for a submit_checkpoint invocation.
 * Called from the BUILTIN_RTK_SUMMARY_REGISTRY factory; assembled into a handle by wrapPluginTool.
 */
export function buildSubmitCheckpointRtkSummary(params: {
  accepted: boolean;
  summaryText: string;
}): ToolEvidenceRtkSummary {
  const summaryPreview = params.summaryText.slice(0, MAX_SUMMARY_PREVIEW_CHARS);
  const summary: SubmitCheckpointRtkSummary = { accepted: params.accepted, summaryPreview };

  return {
    schemaTypeName: 'SubmitCheckpointRtkSummary',
    owningFile: 'src/tools/submit_checkpoint.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: SUBMIT_CHECKPOINT_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'checkpoint-submission',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: { summaryPreviewChars: MAX_SUMMARY_PREVIEW_CHARS },
    omissionSemantics: `summaryPreview is truncated to ${MAX_SUMMARY_PREVIEW_CHARS} chars; full summary is in the event store`,
    summary: summary as unknown as Record<string, unknown>,
  };
}
