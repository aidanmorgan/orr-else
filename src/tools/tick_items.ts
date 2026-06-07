/**
 * tick_items — tool-local RTK summary contract for the tick_items built-in.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for tick_items.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/tick_items.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded tick result (checked items + count).
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const TICK_ITEMS_TOOL_NAME = 'tick_items';

/**
 * TickItemsRtkSummary — compact, deterministic summary of a tick_items invocation.
 */
export interface TickItemsRtkSummary {
  /** Number of items successfully ticked. */
  checkedCount: number;
  /** Whether the invocation was rejected (evidence missing, item not found, etc.). */
  rejected: boolean;
}

export const TICK_ITEMS_SCHEMA_DESCRIPTOR = {
  checkedCount: 'number',
  rejected: 'boolean',
} as const;

export function computeTickItemsSchemaHash(): string {
  const canonical = JSON.stringify(TICK_ITEMS_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const TICK_ITEMS_SCHEMA_HASH: string = computeTickItemsSchemaHash();

/**
 * Build the tool-local RTK summary for a tick_items invocation.
 * Called from the BUILTIN_RTK_SUMMARY_REGISTRY factory; assembled into a handle by wrapPluginTool.
 */
export function buildTickItemsRtkSummary(result: unknown): ToolEvidenceRtkSummary {
  let checkedCount = 0;
  let rejected = false;
  if (result !== null && typeof result === 'object') {
    const rec = result as Record<string, unknown>;
    if (rec.status === 'REJECTED') {
      rejected = true;
    } else if (typeof rec.count === 'number') {
      checkedCount = rec.count;
    } else if (Array.isArray(rec.checked)) {
      checkedCount = rec.checked.length;
    }
  }

  const summary: TickItemsRtkSummary = { checkedCount, rejected };

  return {
    schemaTypeName: 'TickItemsRtkSummary',
    owningFile: 'src/tools/tick_items.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: TICK_ITEMS_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'tick-items-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: {},
    omissionSemantics: 'tick_items produces a complete bounded result; no items are omitted',
    summary: summary as unknown as Record<string, unknown>,
  };
}
