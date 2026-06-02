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
 *  - 'advance'  — fallback (unknown outcomes treated as advance, same as old behaviour)
 *
 * With no statechart block the defaults reproduce the old hard-coded literals.
 *
 * A falsy / non-string outcome returns 'advance' (the safe default for
 * teammateEventTypeForOutcome → STATE_TRANSITIONED), which is why
 * isAdvanceOutcome has its own falsy guard returning false to preserve the
 * old `outcome === EventName.SUCCESS` semantics (false for missing outcome).
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
  // Unknown outcomes: treat as advance (preserves today's fallback behaviour
  // in teammateEventTypeForOutcome which returns STATE_TRANSITIONED for anything
  // that isn't FAILURE/BLOCKED).
  return 'advance';
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

export interface FlowManagerResult {
  status: BeadStatus;
  notes: string;
  retryCount: number;
  removeWorktree: boolean;
}

export interface RestartTransitionResult {
  kind: RestartKind | string;
  event: string;
  targetStateId: string;
}

export class FlowManager {
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

  public nextState(state: SDLCState, outcome: string): string {
    const explicit = state.on?.[outcome];
    const transition = explicit || state.transitions[outcome];
    if (!transition) {
      throw new Error(`No transition configured for outcome ${outcome} in state ${state.id}.`);
    }
    return transition;
  }

  public resolveFailedTeammateEventRetry(
    stateId: string,
    transitionEvent: string,
    bead: { retryCount: number },
    maxRetries = 5
  ): FlowManagerResult {
    const retryCount = (bead.retryCount || 0) + 1;
    if (retryCount >= maxRetries) {
      return {
        retryCount,
        status: BeadStatus.BLOCKED,
        notes: `CIRCUIT_BREAKER_TRIGGERED: Max retries reached.`,
        removeWorktree: true
      };
    }

    return {
      retryCount,
      status: stateId as BeadStatus, 
      notes: `RETRY: Automated recovery initiated.`,
      removeWorktree: false
    };
  }

  public resolveRestartTransition(
    bead: Bead,
    config: HarnessConfig
  ): RestartTransitionResult {
    const kind = bead.restartKind === RestartKind.HARNESS ? RestartKind.HARNESS : RestartKind.CONTEXT;
    const event = kind === RestartKind.HARNESS
      ? config.settings.harnessRestartEvent
      : config.settings.contextRestartEvent;
    const state = config.states[bead.restartFromState || bead.status];
    const targetStateId = state
      ? this.nextState(state, event)
      : bead.restartTargetState || bead.status || EventName.RESTART;
    return { kind, event, targetStateId };
  }

  public activateTools(pi: ExtensionAPI, toolNames: string[]) {
    if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') return;
    const active = new Set<string>(pi.getActiveTools());
    for (const name of toolNames) active.add(name);
    pi.setActiveTools([...active]);
  }
}
