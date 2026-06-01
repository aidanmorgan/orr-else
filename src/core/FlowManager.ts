import { SDLCState } from "./domain/StateModels.js";
import { Bead } from "../types/index.js";
import { BeadStatus, EventName, RestartKind } from "../constants/index.js";
import { HarnessConfig } from "./ConfigLoader.js";
import { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
