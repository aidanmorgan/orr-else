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
import { outcomeCategory } from '../core/FlowManager.js';
import {
  TeammateEventType,
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

/**
 * Maps an outcome string to the correct TeammateEventType using the configured
 * statechart vocabulary.  With no statechart block the defaults reproduce the
 * old hard-coded literals exactly:
 *   FAILURE → STATE_FAILED, BLOCKED → STATE_BLOCKED, anything else → STATE_TRANSITIONED.
 */
export function teammateEventTypeForOutcome(outcome: string, config: HarnessConfig): TeammateEventType {
  const category = outcomeCategory(outcome, config);
  if (category === 'failed') return TeammateEventType.STATE_FAILED;
  if (category === 'blocked') return TeammateEventType.STATE_BLOCKED;
  return TeammateEventType.STATE_TRANSITIONED;
}

export function shouldPersistBlockedBeadStatus(eventType: string, nextState: string, _config: HarnessConfig): boolean {
  // `eventType` is a TeammateEventType (e.g. 'STATE_BLOCKED'), not an outcome string.
  // Passing it to outcomeCategory was dead code for default config and misleading.
  // The existing checks are correct and sufficient:
  //   - STATE_BLOCKED event type → always persist blocked status
  //   - nextState === BLOCKED    → state machine landed in blocked state
  return eventType === TeammateEventType.STATE_BLOCKED
    || nextState === BeadStatus.BLOCKED;
}
