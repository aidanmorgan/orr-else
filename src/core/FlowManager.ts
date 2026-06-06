import { SDLCState } from "./domain/StateModels.js";
import { Bead } from "../types/index.js";
import { BeadStatus, EventName, RestartKind } from "../constants/index.js";
import { HarnessConfig } from "./ConfigLoader.js";
import { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Statechart outcome-vocabulary defaults ───────────────────────────────────
// These reproduce today's hard-coded literals when no statechart block is
// present in the config.  All helpers below are pure, config-reads only.

const DEFAULT_TERMINAL_STATES: readonly string[] = [BeadStatus.COMPLETED];
const DEFAULT_ADVANCE_OUTCOMES: readonly string[] = [EventName.SUCCESS];
const DEFAULT_FAILED_OUTCOMES: readonly string[] = [EventName.FAILURE];
const DEFAULT_BLOCKED_OUTCOMES: readonly string[] = [EventName.BLOCKED];

/**
 * Returns true iff `stateId` is a configured terminal state.
 *
 * Default (no statechart block): ['completed'].
 */
export function isTerminalState(stateId: string, config: HarnessConfig): boolean {
  const terminals = config.statechart?.terminalStates ?? DEFAULT_TERMINAL_STATES;
  return terminals.includes(stateId);
}

/**
 * Classifies an outcome string against the configured vocabulary.
 *
 * Returns:
 *  - 'advance'  — outcome is in advanceOutcomes (default ['SUCCESS'])
 *  - 'failed'   — outcome is in failedOutcomes  (default ['FAILURE'])
 *  - 'blocked'  — outcome is in blockedOutcomes (default ['BLOCKED'])
 *  - 'custom'   — outcome is in customOutcomes
 *  - 'failed'   — fallback in strict mode (undeclared outcome must NOT advance)
 *  - 'advance'  — fallback in legacy mode (no explicit vocab; preserves old behaviour)
 *
 * With no explicit outcome vocabulary the defaults reproduce the old hard-coded
 * literals.
 *
 * A falsy / non-string outcome returns 'advance' (the safe default for
 * teammateEventTypeForOutcome → STATE_TRANSITIONED), which is why
 * isAdvanceOutcome has its own falsy guard returning false to preserve the
 * old `outcome === EventName.SUCCESS` semantics (false for missing outcome).
 *
 * In strict mode (explicit vocabulary declared) an undeclared outcome is
 * classified as 'failed', not 'advance', so it can never count as progress.
 */
export function outcomeCategory(
  outcome: string | null | undefined,
  config: HarnessConfig
): 'advance' | 'failed' | 'blocked' | 'custom' {
  if (!outcome || typeof outcome !== 'string') return 'advance';

  const sc = config.statechart;
  const advance = sc?.advanceOutcomes ?? DEFAULT_ADVANCE_OUTCOMES;
  const failed = sc?.failedOutcomes ?? DEFAULT_FAILED_OUTCOMES;
  const blocked = sc?.blockedOutcomes ?? DEFAULT_BLOCKED_OUTCOMES;
  const custom = sc?.customOutcomes ?? [];

  const normalized = outcome.toUpperCase();
  if (advance.map(o => o.toUpperCase()).includes(normalized)) return 'advance';
  if (failed.map(o => o.toUpperCase()).includes(normalized)) return 'failed';
  if (blocked.map(o => o.toUpperCase()).includes(normalized)) return 'blocked';
  if (custom.map(o => o.toUpperCase()).includes(normalized)) return 'custom';
  // Unknown outcome: in strict mode (explicit vocabulary declared) it must NOT
  // be treated as advance — that is the root-cause bug.  In legacy mode
  // (no explicit vocab) preserve the old fallback-to-advance behaviour so
  // configs that predate the statechart block keep working.
  const strictMode = declaredOutcomeVocabulary(config) !== null;
  return strictMode ? 'failed' : 'advance';
}

/**
 * Returns true iff `outcome` is in the configured advance-outcomes set.
 *
 * Default (no statechart block): equivalent to `outcome === 'SUCCESS'`.
 * A falsy/missing outcome returns false — matching the old literal-comparison
 * semantics where `undefined === 'SUCCESS'` was false.
 */
export function isAdvanceOutcome(outcome: string | null | undefined, config: HarnessConfig): boolean {
  if (!outcome || typeof outcome !== 'string') return false;
  return outcomeCategory(outcome, config) === 'advance';
}

/**
 * Builds the set of declared outcome keys for a config that has an EXPLICIT
 * outcome vocabulary (at least one of advanceOutcomes/failedOutcomes/
 * blockedOutcomes/customOutcomes declared in the statechart block).
 *
 * Returns null in two cases (both treated as legacy / permissive mode):
 *   - No statechart block at all.
 *   - A statechart block that declares ONLY terminalStates/initialState
 *     (no explicit outcome vocabulary).  Forcing a default {SUCCESS,FAILURE,
 *     BLOCKED} vocabulary on such configs would silently break them (AC4).
 */
export function declaredOutcomeVocabulary(config: HarnessConfig): Set<string> | null {
  const sc = config.statechart;
  if (!sc) return null;
  // Only activate strict mode when the author explicitly declared at least one
  // outcome list.  A block with only terminalStates/initialState is legacy.
  const hasExplicitVocab =
    sc.advanceOutcomes !== undefined ||
    sc.failedOutcomes !== undefined ||
    sc.blockedOutcomes !== undefined ||
    sc.customOutcomes !== undefined;
  if (!hasExplicitVocab) return null;
  return new Set([
    ...(sc.advanceOutcomes ?? DEFAULT_ADVANCE_OUTCOMES),
    ...(sc.failedOutcomes ?? DEFAULT_FAILED_OUTCOMES),
    ...(sc.blockedOutcomes ?? DEFAULT_BLOCKED_OUTCOMES),
    ...(sc.customOutcomes ?? []),
  ].map(o => o.toUpperCase()));
}

/**
 * Returns true iff `outcome` is in the declared vocabulary for this config.
 *
 * In strict mode (statechart block present): only declared outcomes are valid.
 * In legacy mode (no statechart block): all non-empty outcomes are permissible.
 *
 * Restart events (HARNESS_RESTART / CONTEXT_RESTART) are harness-internal and
 * are always considered declared regardless of mode.
 */
export function isDeclaredOutcome(outcome: string, config: HarnessConfig): boolean {
  const normalized = outcome.toUpperCase();
  // Restart events are always valid (harness-internal)
  if (
    normalized === 'HARNESS_RESTART' ||
    normalized === 'CONTEXT_RESTART'
  ) return true;
  const vocab = declaredOutcomeVocabulary(config);
  if (vocab === null) return true; // legacy mode: no restriction
  return vocab.has(normalized);
}

/**
 * Throws if `outcome` is not in the declared statechart vocabulary (strict
 * mode).  In legacy mode (no statechart block) this is a no-op.
 *
 * @param context  Short description of the call site (e.g. state name) for the
 *                 error message.
 */
export function assertDeclaredOutcome(outcome: string, config: HarnessConfig, context: string): void {
  if (!isDeclaredOutcome(outcome, config)) {
    const vocab = declaredOutcomeVocabulary(config);
    const declared = vocab ? [...vocab].join(', ') : '(none)';
    throw new Error(
      `Outcome "${outcome}" is not in the declared statechart vocabulary at ${context}. ` +
      `Declared outcomes: ${declared}. ` +
      `Add it to statechart advanceOutcomes/failedOutcomes/blockedOutcomes/customOutcomes to permit it.`
    );
  }
}

export interface RestartTransitionResult {
  kind: RestartKind | string;
  event: string;
  targetStateId: string;
}

export class FlowManager {
  private stateLabel(state: SDLCState, fallbackStateId?: string): string {
    return state.id || fallbackStateId || '<unknown>';
  }

  public initialState(config: HarnessConfig): string {
    const startState = config.settings.startState;
    if (!startState) {
      throw new Error('No startState configured. Set settings.startState to a state defined in the statechart.');
    }
    if (!config.states[startState]) {
      throw new Error(`Configured startState does not exist in statechart: ${startState}`);
    }
    return startState;
  }

  public stateForBead(bead: Bead, config: HarnessConfig): string {
    if (bead.restartRequested && bead.restartTargetState && config.states[bead.restartTargetState]) {
      return bead.restartTargetState;
    }

    if (config.states[bead.status]) return bead.status;
    if (bead.status === BeadStatus.READY) return this.initialState(config);

    throw new Error(`Bead ${bead.id} has status/state ${bead.status}, which is not configured as a runnable state.`);
  }

  public nextState(state: SDLCState, outcome: string, fallbackStateId?: string): string {
    const explicit = state.on?.[outcome];
    const transition = explicit || state.transitions[outcome];
    if (!transition) {
      throw new Error(`No transition configured for outcome ${outcome} in state ${this.stateLabel(state, fallbackStateId)}.`);
    }
    return transition;
  }

  public restartTargetState(state: SDLCState | undefined, stateId: string | undefined, event: string): string {
    const fallbackStateId = stateId || EventName.RESTART;
    if (!state) return fallbackStateId;
    return state.on?.[event] || state.transitions[event] || fallbackStateId;
  }

  public resolveRestartTransition(
    bead: Bead,
    config: HarnessConfig
  ): RestartTransitionResult {
    const kind = bead.restartKind === RestartKind.HARNESS ? RestartKind.HARNESS : RestartKind.CONTEXT;
    const event = kind === RestartKind.HARNESS
      ? config.settings.harnessRestartEvent
      : config.settings.contextRestartEvent;
    const stateId = bead.restartFromState || bead.status;
    const state = config.states[stateId];
    const targetStateId = this.restartTargetState(state, bead.restartTargetState || stateId, event);
    return { kind, event, targetStateId };
  }

  public activateTools(pi: ExtensionAPI, toolNames: string[]) {
    if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') return;
    const active = new Set<string>(pi.getActiveTools());
    for (const name of toolNames) active.add(name);
    pi.setActiveTools([...active]);
  }
}
