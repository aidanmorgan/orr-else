/**
 * submit_review_artifact — tool-local RTK summary contract for the submit_review_artifact built-in.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for submit_review_artifact.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/submit_review_artifact.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded acknowledgment (accepted or rejected).
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const SUBMIT_REVIEW_ARTIFACT_TOOL_NAME = 'submit_review_artifact';

/**
 * SubmitReviewArtifactRtkSummary — compact, deterministic summary of a
 * submit_review_artifact invocation.
 */
export interface SubmitReviewArtifactRtkSummary {
  /** Whether the review artifact was successfully submitted. */
  submitted: boolean;
  /** The kind/type of review artifact submitted (e.g. 'shipPostReview'). */
  artifactKind: string;
}

export const SUBMIT_REVIEW_ARTIFACT_SCHEMA_DESCRIPTOR = {
  artifactKind: 'string',
  submitted: 'boolean',
} as const;

export function computeSubmitReviewArtifactSchemaHash(): string {
  const canonical = JSON.stringify(SUBMIT_REVIEW_ARTIFACT_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const SUBMIT_REVIEW_ARTIFACT_SCHEMA_HASH: string = computeSubmitReviewArtifactSchemaHash();

/**
 * Build the tool-local RTK summary for a submit_review_artifact invocation.
 * Called from the registry factory in builtin_rtk_registry.ts.
 */
export function buildSubmitReviewArtifactRtkSummary(params: {
  result: unknown;
  artifactKind: string;
}): ToolEvidenceRtkSummary {
  const resultStr = typeof params.result === 'string' ? params.result : JSON.stringify(params.result ?? '');
  const submitted = !resultStr.startsWith('REJECTED') && !resultStr.startsWith('Error:');
  const summary: SubmitReviewArtifactRtkSummary = {
    submitted,
    artifactKind: params.artifactKind,
  };
  return {
    schemaTypeName: 'SubmitReviewArtifactRtkSummary',
    owningFile: 'src/tools/submit_review_artifact.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: SUBMIT_REVIEW_ARTIFACT_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'review-artifact-submission',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: {},
    omissionSemantics: 'submit_review_artifact produces a complete bounded result; no items are omitted',
    summary: summary as unknown as Record<string, unknown>,
  };
}
