import type { ChecklistItem } from './ProtocolParser.js';
import type { HarnessConfig, SDLCState, TeammateAction, ValidationGateConfig } from './domain/StateModels.js';

export type RecordedChecklist = Record<string, { checked?: boolean; evidence?: string }>;

function normalizeChecklistItem(item: ChecklistItem): ChecklistItem {
  return {
    ...item,
    mandatory: item.mandatory === true
  };
}

function appendChecklistItems(target: Map<string, ChecklistItem>, items: ChecklistItem[] | string | undefined) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item?.text) continue;

    const existing = target.get(item.text);
    if (!existing) {
      target.set(item.text, normalizeChecklistItem(item));
      continue;
    }

    if (item.mandatory === true) {
      existing.mandatory = true;
    }
  }
}

export interface ChecklistMergeResult {
  requiredItems: ChecklistItem[];
  addedItems: ChecklistItem[];
  existingItems: ChecklistItem[];
  upgradedItems: ChecklistItem[];
}

export function mergeChecklistItems(
  requiredItems: ChecklistItem[],
  additions: ChecklistItem[] | undefined
): ChecklistMergeResult {
  const merged = new Map<string, ChecklistItem>();
  appendChecklistItems(merged, requiredItems);

  const addedItems: ChecklistItem[] = [];
  const existingItems: ChecklistItem[] = [];
  const upgradedItems: ChecklistItem[] = [];

  for (const item of additions || []) {
    if (!item?.text) continue;
    const normalized = normalizeChecklistItem(item);
    const existing = merged.get(normalized.text);
    if (!existing) {
      merged.set(normalized.text, normalized);
      addedItems.push(normalized);
      continue;
    }

    existingItems.push(existing);
    if (normalized.mandatory && !existing.mandatory) {
      existing.mandatory = true;
      upgradedItems.push(existing);
    }
  }

  return {
    requiredItems: Array.from(merged.values()),
    addedItems,
    existingItems,
    upgradedItems
  };
}

function gateAppliesToState(gate: ValidationGateConfig, stateId: string | undefined): boolean {
  if (!stateId) return false;
  if (Array.isArray(gate.states)) return gate.states.includes(stateId);
  if (Array.isArray(gate.beforeStates)) return gate.beforeStates.includes(stateId);
  if (Array.isArray(gate.afterStates)) return gate.afterStates.includes(stateId);
  return true;
}

export function deriveChecklistItems(
  state: Pick<SDLCState, 'checklist'> | undefined,
  action: Pick<TeammateAction, 'checklist'> | undefined,
  config?: Pick<HarnessConfig, 'validationGates'>,
  stateId?: string
): ChecklistItem[] {
  const requiredItems = new Map<string, ChecklistItem>();
  for (const gate of config?.validationGates || []) {
    if (gate.required !== false && gateAppliesToState(gate, stateId)) {
      appendChecklistItems(requiredItems, gate.checklist);
    }
  }
  appendChecklistItems(requiredItems, state?.checklist);
  appendChecklistItems(requiredItems, action?.checklist);
  return Array.from(requiredItems.values());
}

export function missingMandatoryChecklistItems(
  requiredItems: ChecklistItem[],
  recordedChecklist: RecordedChecklist | undefined
): string[] {
  const checklist = recordedChecklist || {};
  return requiredItems
    .filter(item => item.mandatory && !checklist[item.text]?.checked)
    .map(item => item.text);
}
