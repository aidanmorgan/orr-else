/**
 * harness_status — tool-local RTK summary contract for the harness_status built-in.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * DESIGN (AC3 + zog2.7)
 * ----------------------
 * This module is the TOOL-LOCAL owner of:
 *   - HarnessStatusRtkSummary: the TypeScript interface for the compact summary.
 *   - HARNESS_STATUS_SCHEMA_DESCRIPTOR: stable descriptor used to derive schemaHash.
 *   - computeHarnessStatusSchemaHash(): deterministic hash function.
 *   - buildHarnessStatusRtkSummary(): constructs the RTK summary for an invocation.
 *
 * The harness validator (validateToolEvidenceHandle with expectedToolName='harness_status')
 * will enforce rtkSummary.owningFile === 'src/tools/harness_status.ts'.
 *
 * MODEL-FACING RESPONSE
 * ----------------------
 * The model-facing response for harness_status is the bounded `flowStatus` object.
 * The canonical handle is NOT included — the handle is event-store only and is
 * never attached to the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

// ---------------------------------------------------------------------------
// Tool name constant
// ---------------------------------------------------------------------------

export const HARNESS_STATUS_TOOL_NAME = 'harness_status';

// ---------------------------------------------------------------------------
// RTK summary schema (tool-local — zog2.7)
// ---------------------------------------------------------------------------

/**
 * HarnessStatusRtkSummary — the TypeScript-owned, deterministic RTK summary
 * for a harness_status invocation.
 *
 * Fields mirror the model-facing flowStatus response; raw operational details
 * (env vars, path internals) are excluded.
 */
export interface HarnessStatusRtkSummary {
  /** Whether a flow is active on the coordinator. */
  flowActive: boolean;
  /** Current bead id, if any. */
  beadId?: string;
  /** Current state id, if any. */
  stateId?: string;
  /** Current action id, if any. */
  actionId?: string;
  /** Max concurrent slots configured. */
  maxSlots?: number;
  /** Whether auto-continue is enabled. */
  autoContinue?: boolean;
}

/**
 * Stable, canonicalizable descriptor of the HarnessStatusRtkSummary schema fields.
 * The schemaHash is DERIVED from JSON.stringify of this descriptor.
 *
 * Ordering is canonical (alphabetical) so the stringification is stable.
 */
export const HARNESS_STATUS_SCHEMA_DESCRIPTOR = {
  actionId: 'string|undefined',
  autoContinue: 'boolean|undefined',
  beadId: 'string|undefined',
  flowActive: 'boolean',
  maxSlots: 'number|undefined',
  stateId: 'string|undefined',
} as const;

/**
 * Compute the schemaHash for HARNESS_STATUS_SCHEMA_DESCRIPTOR.
 * Returns 'sha256:<hex>' — the canonical format required by the contract.
 *
 * Exported so conformance tests can independently recompute and compare.
 */
export function computeHarnessStatusSchemaHash(): string {
  const canonical = JSON.stringify(HARNESS_STATUS_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

/**
 * The derived schemaHash for the harness_status summary schema.
 * Computed once at module load from HARNESS_STATUS_SCHEMA_DESCRIPTOR.
 * Never pasted — always derived so it tracks the descriptor.
 */
export const HARNESS_STATUS_SCHEMA_HASH: string = computeHarnessStatusSchemaHash();

// ---------------------------------------------------------------------------
// RTK summary builder (tool-local — called from execute() in extension.ts)
// ---------------------------------------------------------------------------

/**
 * Build the tool-local RTK summary for a harness_status invocation.
 *
 * This function is called from the execute() body in extension.ts. The returned
 * summary is passed to the BUILTIN_RTK_SUMMARY_REGISTRY factory so that
 * wrapPluginTool can assemble the full canonical ToolEvidenceHandle and put it
 * on the event-store record. The model-facing response never sees this value.
 */
export function buildHarnessStatusRtkSummary(params: {
  flowActive: boolean;
  beadId?: string;
  stateId?: string;
  actionId?: string;
  maxSlots?: number;
  autoContinue?: boolean;
}): ToolEvidenceRtkSummary {
  const summary: HarnessStatusRtkSummary = {
    flowActive: params.flowActive,
    ...(params.beadId !== undefined ? { beadId: params.beadId } : {}),
    ...(params.stateId !== undefined ? { stateId: params.stateId } : {}),
    ...(params.actionId !== undefined ? { actionId: params.actionId } : {}),
    ...(params.maxSlots !== undefined ? { maxSlots: params.maxSlots } : {}),
    ...(params.autoContinue !== undefined ? { autoContinue: params.autoContinue } : {}),
  };
  return {
    schemaTypeName: 'HarnessStatusRtkSummary',
    owningFile: 'src/tools/harness_status.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: HARNESS_STATUS_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'harness-flow-status',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: {},
    omissionSemantics: 'harness_status produces a complete bounded snapshot; no items are omitted',
    summary: summary as unknown as Record<string, unknown>,
  };
}
