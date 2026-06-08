/**
 * submit_action_evidence — tool-local RTK summary contract for the
 * submit_action_evidence built-in (pi-experiment-x0zh).
 *
 * v2 evidence-only completion surface. Workers submit artifact/evidence
 * references with no outcome/route field. No workflow state transition
 * results from this call alone — routing requires a schema-valid
 * deterministic route event (ROUTE_EVENT_EMITTED) from a configured emitter.
 *
 * MODEL-FACING RESPONSE: a bounded acknowledgement or REJECTED message.
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const SUBMIT_ACTION_EVIDENCE_TOOL_NAME = 'submit_action_evidence';

/**
 * SubmitActionEvidenceRtkSummary — compact, deterministic summary of a
 * submit_action_evidence invocation.
 */
export interface SubmitActionEvidenceRtkSummary {
  /** Whether the evidence was accepted (PASSED status). */
  accepted: boolean;
  /** Brief summary preview (truncated to 120 chars). */
  summaryPreview: string;
  /** Number of artifact paths submitted. */
  artifactPathCount: number;
}

export const SUBMIT_ACTION_EVIDENCE_SCHEMA_DESCRIPTOR = {
  accepted: 'boolean',
  summaryPreview: 'string',
  artifactPathCount: 'number',
} as const;

export function computeSubmitActionEvidenceSchemaHash(): string {
  const canonical = JSON.stringify(SUBMIT_ACTION_EVIDENCE_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const SUBMIT_ACTION_EVIDENCE_SCHEMA_HASH: string = computeSubmitActionEvidenceSchemaHash();

const MAX_SUMMARY_PREVIEW_CHARS = 120;

/**
 * Build the tool-local RTK summary for a submit_action_evidence invocation.
 * Called from the BUILTIN_RTK_SUMMARY_REGISTRY factory; assembled into a handle
 * by wrapPluginTool.
 */
export function buildSubmitActionEvidenceRtkSummary(params: {
  result: unknown;
  summaryText: string;
  artifactPathCount: number;
}): ToolEvidenceRtkSummary {
  const r = params.result;
  const accepted = (
    (r !== null && typeof r === 'object' && (r as Record<string, unknown>)['status'] === 'PASSED') ||
    (typeof r === 'string' && !r.startsWith('REJECTED:') && !r.startsWith('Error:'))
  );
  const summaryPreview = params.summaryText.slice(0, MAX_SUMMARY_PREVIEW_CHARS);

  const summary: SubmitActionEvidenceRtkSummary = {
    accepted,
    summaryPreview,
    artifactPathCount: params.artifactPathCount,
  };

  return {
    schemaTypeName: 'SubmitActionEvidenceRtkSummary',
    owningFile: 'src/tools/submit_action_evidence.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: SUBMIT_ACTION_EVIDENCE_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'action-evidence-submission',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: { summaryPreviewChars: MAX_SUMMARY_PREVIEW_CHARS },
    omissionSemantics: `summaryPreview is truncated to ${MAX_SUMMARY_PREVIEW_CHARS} chars; full summary is in the event store`,
    summary: summary as unknown as Record<string, unknown>,
  };
}
