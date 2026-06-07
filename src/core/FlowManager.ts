import { SDLCState } from "./domain/StateModels.js";
import { Bead } from "../types/index.js";
import { BeadStatus, EventName, RestartKind } from "../constants/index.js";
import { HarnessConfig } from "./ConfigLoader.js";
import { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
 * Requires a statechart block with terminalStates — configs without one are
 * rejected at startup by ConfigLoader.
 */
export function isTerminalState(stateId: string, config: HarnessConfig): boolean {
  const sc = config.statechart;
  if (!sc) {
    throw new Error(
      'isTerminalState: config has no statechart block. ' +
      'All configs must declare a statechart — rejected at ConfigLoader.load().'
    );
  }
  return sc.terminalStates.includes(stateId);
}

/**
 * Classifies an outcome string against the configured vocabulary.
 *
 * Returns:
 *  - 'advance'  — outcome is in advanceOutcomes
 *  - 'failed'   — outcome is in failedOutcomes
 *  - 'blocked'  — outcome is in blockedOutcomes
 *  - 'custom'   — outcome is in customOutcomes
 *  - 'failed'   — fallback for all missing, falsy, or undeclared outcomes (fail-closed)
 *
 * Requires a statechart block — configs without one are rejected at startup by
 * ConfigLoader. Missing/falsy/unknown outcomes always return 'failed' — there
 * is no default vocabulary fallback.
 */
export function outcomeCategory(
  outcome: string | null | undefined,
  config: HarnessConfig
): 'advance' | 'failed' | 'blocked' | 'custom' {
  // Missing/falsy outcomes always fail closed — no advance fallback.
  if (!outcome || typeof outcome !== 'string') {
    return 'failed';
  }

  const sc = config.statechart;
  if (!sc) {
    // No statechart block: all outcomes fail closed. Configs without a statechart
    // are rejected at load time; this path is only reachable from in-memory test fixtures.
    return 'failed';
  }

  const advance = sc.advanceOutcomes ?? [];
  const failed = sc.failedOutcomes ?? [];
  const blocked = sc.blockedOutcomes ?? [];
  const custom = sc.customOutcomes ?? [];

  const normalized = outcome.toUpperCase();
  if (advance.map(o => o.toUpperCase()).includes(normalized)) return 'advance';
  if (failed.map(o => o.toUpperCase()).includes(normalized)) return 'failed';
  if (blocked.map(o => o.toUpperCase()).includes(normalized)) return 'blocked';
  if (custom.map(o => o.toUpperCase()).includes(normalized)) return 'custom';
  // Unknown outcome: always fail closed — no default vocabulary fallback.
  return 'failed';
}

/**
 * Returns true iff `outcome` is in the configured advance-outcomes set.
 *
 * A falsy/missing outcome returns false. Requires a statechart block — configs
 * without one are rejected at startup by ConfigLoader.
 */
export function isAdvanceOutcome(outcome: string | null | undefined, config: HarnessConfig): boolean {
  if (!outcome || typeof outcome !== 'string') return false;
  return outcomeCategory(outcome, config) === 'advance';
}

/**
 * Builds the set of declared outcome keys for a config.
 *
 * Returns null for a statechart block that declares ONLY terminalStates/initialState —
 * this signals "no explicit vocab" and the caller treats all outcomes as permissive.
 * Such configs are rejected at ConfigLoader.load() time; the null return here exists
 * only for in-memory test fixtures that construct a statechart with only terminalStates.
 *
 * Returns a Set of the full declared vocabulary when at least one outcome list is
 * declared. Each outcome is stored upper-cased for case-insensitive matching.
 *
 * Note: configs without a statechart block are rejected at ConfigLoader.load() time.
 * Passing such a config at runtime returns null (treated as permissive by the caller).
 */
export function declaredOutcomeVocabulary(config: HarnessConfig): Set<string> | null {
  const sc = config.statechart;
  if (!sc) {
    // No statechart block: no declared vocabulary. Configs without a statechart are
    // rejected at load time; return null so in-memory test fixtures behave permissively.
    return null;
  }
  // Only activate strict mode when the author explicitly declared at least one
  // outcome list.  A block with only terminalStates/initialState is still
  // considered "no explicit vocab" and returns null so the caller can apply
  // permissive behaviour.
  const hasExplicitVocab =
    sc.advanceOutcomes !== undefined ||
    sc.failedOutcomes !== undefined ||
    sc.blockedOutcomes !== undefined ||
    sc.customOutcomes !== undefined;
  if (!hasExplicitVocab) return null;
  return new Set([
    ...(sc.advanceOutcomes ?? []),
    ...(sc.failedOutcomes ?? []),
    ...(sc.blockedOutcomes ?? []),
    ...(sc.customOutcomes ?? []),
  ].map(o => o.toUpperCase()));
}

/**
 * Returns true iff `outcome` is in the declared vocabulary for this config.
 *
 * Always strict: only declared outcomes are valid. A statechart block with only
 * terminalStates/initialState (no outcome lists) returns null from
 * declaredOutcomeVocabulary and is treated as permissive (all outcomes declared).
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
