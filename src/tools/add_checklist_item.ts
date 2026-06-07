/**
 * add_checklist_item — tool-local RTK summary contract for the add_checklist_item built-in.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * This module is the TOOL-LOCAL owner of the RTK summary for add_checklist_item.
 * The harness validator enforces rtkSummary.owningFile === 'src/tools/add_checklist_item.ts'.
 *
 * MODEL-FACING RESPONSE: the bounded acknowledgment (item added or rejected).
 * The canonical handle is NOT included in the model-facing response.
 */

import { createHash } from 'node:crypto';
import type { ToolEvidenceRtkSummary } from '../core/ToolEvidenceHandle.js';

export const ADD_CHECKLIST_ITEM_TOOL_NAME = 'add_checklist_item';

/**
 * AddChecklistItemRtkSummary — compact, deterministic summary of an
 * add_checklist_item invocation.
 */
export interface AddChecklistItemRtkSummary {
  /** Whether the item was successfully added. */
  added: boolean;
  /** Whether the item was declared mandatory. */
  mandatory: boolean;
  /** Brief preview of the item text (truncated to 120 chars). */
  textPreview: string;
}

export const ADD_CHECKLIST_ITEM_SCHEMA_DESCRIPTOR = {
  added: 'boolean',
  mandatory: 'boolean',
  textPreview: 'string',
} as const;

export function computeAddChecklistItemSchemaHash(): string {
  const canonical = JSON.stringify(ADD_CHECKLIST_ITEM_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export const ADD_CHECKLIST_ITEM_SCHEMA_HASH: string = computeAddChecklistItemSchemaHash();

const MAX_TEXT_PREVIEW_CHARS = 120;

/**
 * Build the tool-local RTK summary for an add_checklist_item invocation.
 * Called from the registry factory in builtin_rtk_registry.ts.
 */
export function buildAddChecklistItemRtkSummary(params: {
  result: unknown;
  text: string;
  mandatory: boolean;
}): ToolEvidenceRtkSummary {
  const resultStr = typeof params.result === 'string' ? params.result : JSON.stringify(params.result ?? '');
  const added = !resultStr.startsWith('REJECTED') && !resultStr.startsWith('Error:');
  const summary: AddChecklistItemRtkSummary = {
    added,
    mandatory: params.mandatory,
    textPreview: params.text.slice(0, MAX_TEXT_PREVIEW_CHARS),
  };
  return {
    schemaTypeName: 'AddChecklistItemRtkSummary',
    owningFile: 'src/tools/add_checklist_item.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: ADD_CHECKLIST_ITEM_SCHEMA_HASH,
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'checklist-item-add-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: { textPreviewChars: MAX_TEXT_PREVIEW_CHARS },
    omissionSemantics: `textPreview is truncated to ${MAX_TEXT_PREVIEW_CHARS} chars; full item text is in the event store`,
    summary: summary as unknown as Record<string, unknown>,
  };
}
