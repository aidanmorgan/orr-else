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

// ── Typed fail-closed outcome model (1elr.2) ─────────────────────────────────

/**
 * Typed enum for the four mutually-exclusive outcome categories.
 *
 * Replaces raw string literals in call sites that previously compared against
 * 'advance' | 'failed' | 'blocked' | 'custom'.  The enum values are kept
 * identical to the string literals so existing call sites using the string form
 * are compatible without changes.
 */
export enum OutcomeCategory {
  /** Outcome is in the configured advance-outcomes set → forward progress. */
  ADVANCE = 'advance',
  /** Outcome is in the configured failed-outcomes set, or is undeclared in strict mode. */
  FAILED = 'failed',
  /** Outcome is in the configured blocked-outcomes set. */
  BLOCKED = 'blocked',
  /** Outcome is in the configured custom-outcomes set. */
  CUSTOM = 'custom',
}

/**
 * Branded string type for an outcome name.
 *
 * Outcome names are always strings at runtime; the brand exists to help
 * call sites signal intent and enables future refinement without API churn.
 */
export type OutcomeName = string & { readonly __outcomeName: unique symbol };

/**
 * Typed, fail-closed outcome classification.
 *
 * Returns a typed `OutcomeCategory` enum value by delegating to
 * `outcomeCategory()`.  Always fail-closed: missing/falsy and undeclared
 * outcomes classify as FAILED, never ADVANCE.
 *
 * Prefer this function over `outcomeCategory()` in new code that needs the
 * typed enum.
 */
export function classifyOutcome(
  outcome: string | null | undefined,
  config: HarnessConfig
): OutcomeCategory {
  switch (outcomeCategory(outcome, config)) {
    case 'advance': return OutcomeCategory.ADVANCE;
    case 'failed':  return OutcomeCategory.FAILED;
    case 'blocked': return OutcomeCategory.BLOCKED;
    case 'custom':  return OutcomeCategory.CUSTOM;
  }
}

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
 *  - 'failed'   — fallback for all missing, falsy, or undeclared outcomes (fail-closed)
 *
 * With no explicit outcome vocabulary the defaults (SUCCESS/FAILURE/BLOCKED)
 * are used. Missing/falsy/unknown outcomes always return 'failed' — there is
 * no legacy advance fallback.
 */
export function outcomeCategory(
  outcome: string | null | undefined,
  config: HarnessConfig
): 'advance' | 'failed' | 'blocked' | 'custom' {
  // Missing/falsy outcomes always fail closed — no legacy advance fallback.
  if (!outcome || typeof outcome !== 'string') {
    return 'failed';
  }

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
  // Unknown outcome: always fail closed — no legacy advance fallback.
  return 'failed';
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
 * Builds the set of declared outcome keys for a config.
 *
 * Returns the full declared outcome vocabulary (always non-null). When the
 * statechart block has no explicit outcome lists, the default vocabulary
 * (SUCCESS/FAILURE/BLOCKED) is used so that unknown outcomes still fail
 * closed rather than defaulting to advance.
 *
 * Returns null only for a statechart block that declares ONLY
 * terminalStates/initialState — this signals "no explicit vocab, use
 * defaults" and is distinct from a missing statechart block.
 *
 * Note: a missing statechart block is rejected at ConfigLoader.load() time;
 * this function is a runtime helper and must behave correctly regardless.
 */
export function declaredOutcomeVocabulary(config: HarnessConfig): Set<string> | null {
  const sc = config.statechart;
  if (!sc) {
    // No statechart block: use the default vocabulary so unknown outcomes
    // do not silently advance. Configs without a statechart are rejected at
    // load time; this handles in-memory configs used in tests.
    return new Set([
      ...DEFAULT_ADVANCE_OUTCOMES,
      ...DEFAULT_FAILED_OUTCOMES,
      ...DEFAULT_BLOCKED_OUTCOMES,
    ].map(o => o.toUpperCase()));
  }
  // Only activate strict mode when the author explicitly declared at least one
  // outcome list.  A block with only terminalStates/initialState is still
  // considered "no explicit vocab" and returns null so the caller can apply
  // default vocabulary behaviour.
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
 * Always strict: only declared outcomes are valid. A config without an
 * explicit outcome vocabulary uses the default set (SUCCESS/FAILURE/BLOCKED).
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
  if (vocab === null) return true; // statechart block with only terminalStates: permissive
  return vocab.has(normalized);
}

/**
 * Throws if `outcome` is not in the declared statechart vocabulary.
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
