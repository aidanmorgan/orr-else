/**
 * Coordinator action-selection and completion-tracking helpers.
 *
 * Encapsulates the cohesive cluster of functions that govern how the
 * coordinator picks the active action for a bead, tracks completed actions,
 * and classifies teammate event outcomes.
 *
 * Pure functions — no process.env reads, no I/O, no state mutations.
 */

import { createHash } from 'node:crypto';
import type { HarnessConfig, ResolvedHarnessConfig } from '../core/ConfigLoader.js';
import type { ChecklistItem } from '../core/ProtocolParser.js';
import type { Bead } from '../types/index.js';
import { SDLCState, TeammateAction, type StateContextPolicyConfig } from '../core/domain/StateModels.js';
import { outcomeCategory } from '../core/FlowManager.js';
import { ActionCompletionKey, ActionContextMode, ActionRunContext, ActionType, BeadStatus, StateContextPolicy, TeammateEventType } from '../constants/domain.js';

// ── state context policy ──────────────────────────────────────────────────────

/**
 * Resolved context policy for a state (pi-experiment-6q0y.44).
 *
 * Always normalized to the structured form so callers don't branch on string vs object.
 */
export interface ResolvedStateContextPolicy {
  mode: StateContextPolicy;
  /** Present only when mode = NAMED_CONTINUATION; the stable context anchor key. */
  contextKey?: string;
  /**
   * Present when this state produces a Pi session that a subsequent
   * namedContinuation state should resume (write-side of continuation).
   * Set from contextPolicy.producesContextKey on the structured form.
   */
  producesContextKey?: string;
}

/**
 * Resolve the effective context policy for a state (pi-experiment-6q0y.44).
 *
 * Normalises the raw declaration (string shorthand or structured object) to the
 * typed ResolvedStateContextPolicy shape.  Falls back to freshSubagent when the
 * state or its contextPolicy declaration is absent — this default ensures that
 * consumers (e.g. cerdiwen) that do not declare a contextPolicy are unaffected.
 *
 * Called by the coordinator spawn/continuation decision path in Supervisor so
 * the policy is applied on the REAL path (not just declared and linted).
 */
export function resolveStateContextPolicy(
  stateId: string,
  config: ResolvedHarnessConfig
): ResolvedStateContextPolicy {
  const state = config.states?.[stateId];
  const raw = state?.contextPolicy;

  // Default: fresh sub-agent (absent or undefined → freshSubagent).
  if (!raw) {
    return { mode: StateContextPolicy.FRESH_SUBAGENT };
  }

  // String shorthand: contextPolicy: freshSubagent | namedContinuation
  if (typeof raw === 'string') {
    const mode = raw === StateContextPolicy.NAMED_CONTINUATION
      ? StateContextPolicy.NAMED_CONTINUATION
      : StateContextPolicy.FRESH_SUBAGENT;
    return { mode };
  }

  // Structured: contextPolicy: { mode, contextKey, producesContextKey }
  const structured = raw as StateContextPolicyConfig;
  const mode = structured.mode === StateContextPolicy.NAMED_CONTINUATION
    ? StateContextPolicy.NAMED_CONTINUATION
    : StateContextPolicy.FRESH_SUBAGENT;
  return {
    mode,
    ...(mode === StateContextPolicy.NAMED_CONTINUATION && structured.contextKey
      ? { contextKey: structured.contextKey }
      : {}),
    ...(structured.producesContextKey
      ? { producesContextKey: structured.producesContextKey }
      : {})
  };
}

// ── AC3: legacy 'same' contextMode rejection ─────────────────────────────────

/**
 * Reject legacy `same` contextMode declarations (pi-experiment-6q0y.44 AC3).
 *
 * @testHelperOnly — The LOAD-BEARING rejection is ConfigLoader.validateNoLegacySameContextMode
 * (wired into validateSemantics, called at startup). This copy is exported for
 * test isolation only: tests that do not go through ConfigLoader can call this
 * function directly without triggering a circular import.
 *
 * Do NOT call this from production code — use ConfigLoader.validateSemantics instead.
 */
export function rejectLegacySameContextMode(config: ResolvedHarnessConfig): void {
  const rejectSame = (location: string, mode: string | undefined) => {
    if (mode === ActionContextMode.SAME) {
      throw new Error(
        `${location} declares contextMode: "same" which is a legacy no-compat mode. ` +
        `"same" has been removed. Convert to an explicit named continuation: ` +
        `contextPolicy: { mode: namedContinuation, contextKey: "yourKey" } on the state ` +
        `and remove the per-action contextMode.`
      );
    }
  };

  for (const [stateId, state] of Object.entries(config.states || {})) {
    rejectSame(`State "${stateId}"`, state?.defaultActionContextMode);
    for (const action of state?.actions || []) {
      rejectSame(`State "${stateId}" action "${action.id}"`, action.contextMode);
    }
  }
  // Also check global settings.defaultActionContextMode
  rejectSame('settings', config.settings?.defaultActionContextMode);
}

// ── AC5: deterministic context-policy fingerprint ────────────────────────────

/**
 * One row in the context-policy table (one state's resolved entry).
 */
export interface ContextPolicyTableRow {
  stateId: string;
  mode: string;
  contextKey?: string;
  producesContextKey?: string;
  activeTools: string[];
  skillProfile: string[];
}

/**
 * Compute a deterministic fingerprint of the resolved context-policy table for
 * all states in the config (pi-experiment-6q0y.44 AC5).
 *
 * The fingerprint is a stable SHA-256 hex digest over the sorted, serialized
 * policy table.  It changes whenever any state's mode, contextKey,
 * producesContextKey, active tools, or skill profile changes — providing a
 * single comparable value for startup-lint or drift detection.
 *
 * Returns both the digest and the full sorted table for logging.
 */
export function computeContextPolicyFingerprint(config: ResolvedHarnessConfig): {
  digest: string;
  table: ContextPolicyTableRow[];
} {
  const stateIds = Object.keys(config.states || {}).sort();
  const table: ContextPolicyTableRow[] = stateIds.map(stateId => {
    const policy = resolveStateContextPolicy(stateId, config);
    const state = config.states?.[stateId];
    const activeTools = (state?.activeTools || []).slice().sort();
    const skillProfile = (state?.skills || []).slice().sort();
    const row: ContextPolicyTableRow = {
      stateId,
      mode: policy.mode,
      activeTools,
      skillProfile
    };
    if (policy.contextKey) row.contextKey = policy.contextKey;
    if (policy.producesContextKey) row.producesContextKey = policy.producesContextKey;
    return row;
  });

  const canonical = JSON.stringify(table);
  const digest = createHash('sha256').update(canonical).digest('hex');
  return { digest, table };
}

// ── AC6: context instance record ─────────────────────────────────────────────

/**
 * Context instance record (pi-experiment-6q0y.44 AC6).
 *
 * Recorded at spawn time for every teammate.  Captures the context-identity
 * fields that distinguish one spawn from another for replay/reconstruction.
 */
export interface ContextInstanceRecord {
  /** Unique ID for this context instance (uuidv7 assigned at spawn time). */
  contextInstanceId: string;
  /** Whether this is a fresh context (freshSubagent) or a continuation. */
  mode: string;
  /** Bead ID of the spawned worker. */
  beadId: string;
  /** State ID being spawned. */
  stateId: string;
  /** Parent bead+state identity (from which this spawn was initiated). */
  parentBeadId?: string;
  /** Stable hash of the prompt content (digest of identity inputs). */
  promptDigest?: string;
  /** Active tool set for this spawn. */
  activeTools: string[];
  /** Skill profile for this spawn. */
  skillProfile: string[];
  /** The context key this spawn continues (namedContinuation only). */
  continuedContextKey?: string;
  /** The context key this spawn produces (write-side). */
  producedContextKey?: string;
  /** Pi session path used for this spawn (undefined for ephemeral --no-session spawns). */
  piSessionPath?: string;
  /** Whether this spawn resumes a prior Pi session. */
  isResumption: boolean;
}

/**
 * Build a context-instance record for a spawn event (pi-experiment-6q0y.44 AC6).
 */
export function buildContextInstanceRecord(params: {
  contextInstanceId: string;
  beadId: string;
  stateId: string;
  config: ResolvedHarnessConfig;
  promptDigest?: string;
  piSessionPath?: string;
  isResumption: boolean;
}): ContextInstanceRecord {
  const { contextInstanceId, beadId, stateId, config, promptDigest, piSessionPath, isResumption } = params;
  const policy = resolveStateContextPolicy(stateId, config);
  const state = config.states?.[stateId];
  const activeTools = (state?.activeTools || []).slice().sort();
  const skillProfile = (state?.skills || []).slice().sort();

  const record: ContextInstanceRecord = {
    contextInstanceId,
    mode: policy.mode,
    beadId,
    stateId,
    activeTools,
    skillProfile,
    isResumption
  };
  if (promptDigest) record.promptDigest = promptDigest;
  if (piSessionPath) record.piSessionPath = piSessionPath;
  if (policy.contextKey) record.continuedContextKey = policy.contextKey;
  if (policy.producesContextKey) record.producedContextKey = policy.producesContextKey;
  return record;
}

// ── AC7: continuation admission gate ─────────────────────────────────────────

/**
 * Record stored in the contextKeyStore for a produced Pi session
 * (pi-experiment-6q0y.44 AC7).
 *
 * Stored at WRITE time (when the producing spawn completes successfully).
 * Every field is required so the consuming admit-gate can enforce all constraints
 * without needing to re-derive them.
 */
export interface ContextKeyRecord {
  /** Absolute path to the Pi session file produced by the write-side spawn. */
  piSessionPath: string;
  /** Bead ID of the spawn that produced this session. */
  beadId: string;
  /** State ID of the spawn that produced this session (the "allowed source"). */
  sourceStateId: string;
  /** Action ID of the spawn that produced this session (the "allowed source action"). */
  sourceActionId: string;
  /** SHA-256 hex digest of the harness config file at the time of production. */
  configDigest: string;
  /**
   * Whether the producing lineage is terminal.
   * A terminal lineage means the producing bead has completed its lifecycle;
   * resuming from a terminal session is denied (stale session risk).
   */
  terminal: boolean;
}

/**
 * Admission result for a named-continuation spawn (pi-experiment-6q0y.44 AC7).
 */
export type ContinuationAdmissionResult =
  | { admitted: true; sessionPath: string }
  | { admitted: false; reason: string };

/**
 * Continuation admission gate (pi-experiment-6q0y.44 AC7).
 *
 * Validates that a namedContinuation spawn is safe to resume before any model
 * spend.  Fails closed (denied) on any constraint violation.
 *
 * Constraints checked (ALL must pass):
 *   1. contextKey must be non-empty.
 *   2. A stored record must exist (session was recorded by a producing spawn).
 *   3. The consuming bead's id must match the stored record's beadId
 *      (same-bead policy: only the bead that produced the session may resume it).
 *   4. The consuming bead's stateId must match the record's sourceStateId
 *      (source-state mismatch: only the same state type may resume its own context).
 *   5. The consuming run's configDigest must match the record's configDigest
 *      (incompatible config change → deny, force fresh context).
 *   6. The stored lineage must NOT be terminal
 *      (terminal sessions are complete and must not be re-opened).
 *
 * Returns { admitted: true, sessionPath } on success or { admitted: false, reason } on failure.
 */
export function evaluateContinuationAdmission(params: {
  contextKey: string;
  storedRecord: ContextKeyRecord | undefined;
  beadId: string;
  consumingStateId: string;
  consumingConfigDigest: string;
}): ContinuationAdmissionResult {
  const { contextKey, storedRecord, beadId, consumingStateId, consumingConfigDigest } = params;

  if (!contextKey || contextKey.trim().length === 0) {
    return {
      admitted: false,
      reason: `Continuation admission DENIED for bead="${beadId}" state="${consumingStateId}": contextKey is empty`
    };
  }

  if (!storedRecord || !storedRecord.piSessionPath || storedRecord.piSessionPath.trim().length === 0) {
    return {
      admitted: false,
      reason: `Continuation admission DENIED for bead="${beadId}" state="${consumingStateId}" key="${contextKey}": no prior session recorded`
    };
  }

  if (beadId !== storedRecord.beadId) {
    return {
      admitted: false,
      reason: `Continuation admission DENIED for bead="${beadId}" state="${consumingStateId}" key="${contextKey}": ` +
        `continuation denied: bead mismatch (stored ${storedRecord.beadId} != consuming ${beadId})`
    };
  }

  if (consumingStateId !== storedRecord.sourceStateId) {
    return {
      admitted: false,
      reason: `Continuation admission DENIED for bead="${beadId}" state="${consumingStateId}" key="${contextKey}": ` +
        `consuming state "${consumingStateId}" does not match allowed source state "${storedRecord.sourceStateId}" (source-state mismatch)`
    };
  }

  if (consumingConfigDigest !== storedRecord.configDigest) {
    return {
      admitted: false,
      reason: `Continuation admission DENIED for bead="${beadId}" state="${consumingStateId}" key="${contextKey}": ` +
        `config digest mismatch — consuming digest "${consumingConfigDigest}" != stored "${storedRecord.configDigest}" (incompatible config)`
    };
  }

  if (storedRecord.terminal) {
    return {
      admitted: false,
      reason: `Continuation admission DENIED for bead="${beadId}" state="${consumingStateId}" key="${contextKey}": ` +
        `stored lineage is terminal — session from bead "${storedRecord.beadId}" state "${storedRecord.sourceStateId}" has completed`
    };
  }

  return { admitted: true, sessionPath: storedRecord.piSessionPath };
}

// ── action context + completion key ──────────────────────────────────────────

/**
 * Resolve the effective contextMode for an action, honoring the inheritance chain:
 *   per-action contextMode → state.defaultActionContextMode → settings.defaultActionContextMode
 *
 * Returns the resolved string value (or undefined if none set at any level).
 * s3wp.3: makes state and global defaults operational.
 */
export function resolveActionContextMode(
  action: TeammateAction,
  state?: SDLCState,
  config?: ResolvedHarnessConfig
): string | undefined {
  return action.contextMode
    ?? state?.defaultActionContextMode
    ?? config?.settings.defaultActionContextMode;
}

/**
 * Resolve whether handover is required for an action, honoring the inheritance chain:
 *   per-action handoverRequired → state.handoverRequired
 *
 * Returns the effective boolean (false when not set at any level — opt-in semantics).
 * s3wp.3: makes state-level handoverRequired default operational.
 */
export function resolveActionHandoverRequired(
  action: TeammateAction,
  state?: SDLCState
): boolean {
  if (action.handoverRequired !== undefined) return action.handoverRequired;
  if (state?.handoverRequired !== undefined) return state.handoverRequired;
  return false;
}

/**
 * Determine whether an action runs in a fresh (subagent/oneShot) or parent context.
 *
 * Resolution (s3wp.3): per-action contextMode → state.defaultActionContextMode →
 * settings.defaultActionContextMode → action.context field.
 *
 * 'subagent' and 'oneShot' → FRESH context (new Pi session).
 * 'same' or unset → PARENT context (continue in the current session).
 *
 * The optional state and config parameters enable the inheritance chain.
 * When omitted, falls back to the pre-s3wp.3 behavior (per-action only).
 */
export function actionRunContext(
  action: TeammateAction,
  state?: SDLCState,
  config?: ResolvedHarnessConfig
): ActionRunContext {
  if (action.context === ActionRunContext.FRESH) {
    return ActionRunContext.FRESH;
  }
  const effectiveContextMode = resolveActionContextMode(action, state, config);
  if (
    effectiveContextMode === ActionContextMode.SUBAGENT ||
    effectiveContextMode === ActionContextMode.ONE_SHOT
  ) {
    return ActionRunContext.FRESH;
  }
  return ActionRunContext.PARENT;
}

export function actionCompletionKey(config: ResolvedHarnessConfig, stateId: string, actionId: string): string {
  const workflowVersion = config.settings.workflowVersion?.trim();
  if (!workflowVersion) return actionId;
  return [
    `${ActionCompletionKey.WORKFLOW_PREFIX}=${workflowVersion}`,
    `${ActionCompletionKey.STATE_PREFIX}=${stateId}`,
    `${ActionCompletionKey.ACTION_PREFIX}=${actionId}`
  ].join(ActionCompletionKey.FIELD_SEPARATOR);
}

export function isActionCompleted(
  config: ResolvedHarnessConfig,
  stateId: string,
  action: TeammateAction,
  completedActionIds: string[] = []
): boolean {
  return new Set(completedActionIds).has(actionCompletionKey(config, stateId, action.id));
}

export function selectActiveAction(
  config: ResolvedHarnessConfig,
  stateId: string,
  state: SDLCState,
  actionId?: string,
  completedActionIds: string[] = []
): TeammateAction | undefined {
  if (actionId) return state.actions.find(candidate => candidate.id === actionId);
  const pending = state.actions.filter(candidate => !isActionCompleted(config, stateId, candidate, completedActionIds));
  const searchSpace = pending.length > 0 ? pending : state.actions;
  return searchSpace.find(candidate =>
    actionRunContext(candidate, state, config) === ActionRunContext.PARENT &&
    (candidate.type === ActionType.PROMPT || candidate.type === ActionType.CHECKLIST)
  ) || searchSpace.find(candidate => actionRunContext(candidate, state, config) === ActionRunContext.FRESH)
    || searchSpace.find(candidate => actionRunContext(candidate, state, config) === ActionRunContext.PARENT)
    || state.actions[0];
}

export function nextSequencedAction(
  config: ResolvedHarnessConfig,
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
  config: ResolvedHarnessConfig
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
export function teammateEventTypeForOutcome(outcome: string, config: ResolvedHarnessConfig): TeammateEventType {
  const category = outcomeCategory(outcome, config);
  if (category === 'failed') return TeammateEventType.STATE_FAILED;
  if (category === 'blocked') return TeammateEventType.STATE_BLOCKED;
  return TeammateEventType.STATE_TRANSITIONED;
}

export function shouldPersistBlockedBeadStatus(eventType: string, nextState: string, _config: ResolvedHarnessConfig): boolean {
  // `eventType` is a TeammateEventType (e.g. 'STATE_BLOCKED'), not an outcome string.
  // Passing it to outcomeCategory was dead code for default config and misleading.
  // The existing checks are correct and sufficient:
  //   - STATE_BLOCKED event type → always persist blocked status
  //   - nextState === BLOCKED    → state machine landed in blocked state
  return eventType === TeammateEventType.STATE_BLOCKED
    || nextState === BeadStatus.BLOCKED;
}
