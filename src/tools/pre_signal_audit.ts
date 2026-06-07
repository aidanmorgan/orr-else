/**
 * pre_signal_audit — tool-local RTK summary contract for the pre_signal_audit built-in.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for pre_signal_audit.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/pre_signal_audit.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded audit result (ready flag + blocking evidence).
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const PRE_SIGNAL_AUDIT_TOOL_NAME = 'pre_signal_audit';

/**
 * PreSignalAuditRtkSummary — compact, deterministic summary of a pre_signal_audit invocation.
 */
export interface PreSignalAuditRtkSummary {
  /** Whether the gate is ready for the requested outcome. */
  ready: boolean;
  /** The outcome that was evaluated. */
  outcome: string;
  /** Number of blocking evidence items. */
  blockingCount: number;
  /** Whether a checkpoint has been accepted. */
  checkpointAccepted?: boolean;
}

export const PRE_SIGNAL_AUDIT_SCHEMA_DESCRIPTOR = {
  blockingCount: 'number',
  checkpointAccepted: 'boolean|undefined',
  outcome: 'string',
  ready: 'boolean',
} as const;

export function computePreSignalAuditSchemaHash(): string {
  const canonical = JSON.stringify(PRE_SIGNAL_AUDIT_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const PRE_SIGNAL_AUDIT_SCHEMA_HASH: string = computePreSignalAuditSchemaHash();

/**
 * Build the tool-local RTK summary for a pre_signal_audit invocation.
 * Called from the BUILTIN_RTK_SUMMARY_REGISTRY factory; assembled into a handle by wrapPluginTool.
 */
export function buildPreSignalAuditRtkSummary(params: {
  ready: boolean;
  outcome: string;
  blockingCount: number;
  checkpointAccepted?: boolean;
}): ToolEvidenceRtkSummary {
  const summary: PreSignalAuditRtkSummary = {
    ready: params.ready,
    outcome: params.outcome,
    blockingCount: params.blockingCount,
    ...(params.checkpointAccepted !== undefined ? { checkpointAccepted: params.checkpointAccepted } : {}),
  };
  return {
    schemaTypeName: 'PreSignalAuditRtkSummary',
    owningFile: 'src/tools/pre_signal_audit.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: PRE_SIGNAL_AUDIT_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'pre-signal-audit-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: {},
    omissionSemantics: 'pre_signal_audit produces a complete bounded audit; no items are omitted',
    summary: summary as unknown as Record<string, unknown>,
  };
}
