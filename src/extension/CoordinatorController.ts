/**
 * Coordinator action-selection and completion-tracking helpers.
 *
 * Encapsulates the cohesive cluster of functions that govern how the
 * coordinator picks the active action for a bead, tracks completed actions,
 * and classifies teammate event outcomes.
 *
 * Pure functions — no process.env reads, no I/O, no state mutations.
 */

import type { HarnessConfig } from '../core/ConfigLoader.js';
import type { ChecklistItem } from '../core/ProtocolParser.js';
import type { Bead } from '../types/index.js';
import { SDLCState, TeammateAction } from '../core/domain/StateModels.js';
import {
  TeammateEventType,
  EventName,
  BeadStatus,
  ActionRunContext,
  ActionContextMode,
  ActionType,
  ActionCompletionKey
} from '../constants/index.js';

// ── action context + completion key ──────────────────────────────────────────

export function actionRunContext(action: TeammateAction): ActionRunContext {
  if (action.context === ActionRunContext.FRESH || action.contextMode === ActionContextMode.SUBAGENT) {
    return ActionRunContext.FRESH;
  }
  return ActionRunContext.PARENT;
}

export function actionCompletionKey(config: HarnessConfig, stateId: string, actionId: string): string {
  const workflowVersion = config.settings.workflowVersion?.trim();
  if (!workflowVersion) return actionId;
  return [
    `${ActionCompletionKey.WORKFLOW_PREFIX}=${workflowVersion}`,
    `${ActionCompletionKey.STATE_PREFIX}=${stateId}`,
    `${ActionCompletionKey.ACTION_PREFIX}=${actionId}`
  ].join(ActionCompletionKey.FIELD_SEPARATOR);
}

export function isActionCompleted(
  config: HarnessConfig,
  stateId: string,
  action: TeammateAction,
  completedActionIds: string[] = []
): boolean {
  return new Set(completedActionIds).has(actionCompletionKey(config, stateId, action.id));
}

export function selectActiveAction(
  config: HarnessConfig,
  stateId: string,
  state: SDLCState,
  actionId?: string,
  completedActionIds: string[] = []
): TeammateAction | undefined {
  if (actionId) return state.actions.find(candidate => candidate.id === actionId);
  const pending = state.actions.filter(candidate => !isActionCompleted(config, stateId, candidate, completedActionIds));
  const searchSpace = pending.length > 0 ? pending : state.actions;
  return searchSpace.find(candidate =>
    actionRunContext(candidate) === ActionRunContext.PARENT &&
    (candidate.type === ActionType.PROMPT || candidate.type === ActionType.CHECKLIST)
  ) || searchSpace.find(candidate => actionRunContext(candidate) === ActionRunContext.FRESH)
    || searchSpace.find(candidate => actionRunContext(candidate) === ActionRunContext.PARENT)
    || state.actions[0];
}

export function nextSequencedAction(
  config: HarnessConfig,
  stateId: string,
  state: SDLCState,
  justCompletedActionId: string,
  completedActionIds: string[] = []
): TeammateAction | undefined {
  const completedIndex = state.actions.findIndex(action => action.id === justCompletedActionId);
  if (completedIndex < 0) return undefined;
  const nextCompletedActionIds = [
    ...completedActionIds,
    actionCompletionKey(config, stateId, justCompletedActionId)
  ];
  return state.actions.slice(completedIndex + 1).find(action =>
    !isActionCompleted(config, stateId, action, nextCompletedActionIds)
  );
}

export function appendCompletedActionId(
  completedActionIds: string[] | undefined,
  stateId: string,
  actionId: string,
  config: HarnessConfig
): string[] {
  return [...new Set([
    ...(completedActionIds || []),
    actionCompletionKey(config, stateId, actionId)
  ])];
}

export function dynamicChecklistItemsForRun(bead: Bead, stateId: string, actionId: string): ChecklistItem[] {
  const runKey = `${stateId}/${actionId}`;
  const dynamicItems = ((bead as any).dynamicChecklists || {})[runKey]?.items;
  return Array.isArray(dynamicItems) ? dynamicItems as ChecklistItem[] : [];
}

// ── teammate event type + bead status helpers ─────────────────────────────────

export function teammateEventTypeForOutcome(outcome: string): TeammateEventType {
  const normalized = outcome.toUpperCase();
  if (normalized === EventName.FAILURE) return TeammateEventType.STATE_FAILED;
  if (normalized === EventName.BLOCKED) return TeammateEventType.STATE_BLOCKED;
  return TeammateEventType.STATE_TRANSITIONED;
}

export function shouldPersistBlockedBeadStatus(eventType: string, nextState: string): boolean {
  return eventType === TeammateEventType.STATE_BLOCKED || nextState === BeadStatus.BLOCKED;
}
