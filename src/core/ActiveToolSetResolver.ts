/**
 * ActiveToolSetResolver — deterministic state/action active-tool-set resolution.
 *
 * pi-experiment-6q0y.1
 *
 * Given a state and optional action, resolves which tools are "active" (exposed
 * to the teammate) as a sorted, deduplicated set.
 *
 * Resolution rules:
 *   1. Default (no activeTools on state or action): all tools in config.tools.
 *   2. State-level activeTools: narrows the active set to exactly those names.
 *   3. Action-level activeTools: further overrides the state-level set (not additive).
 *      If both state and action declare activeTools, the action's list wins.
 *
 * Required-tool inclusion: any requiredTools declared on the state or action that
 * are not already in the resolved active set are force-included and the resolution
 * is rejected at lint time (startup-fatal error). This ensures requiredTools can
 * never silently be absent from the active set.
 *
 * Startup lint enforces:
 *   - Unknown tool names (not in config.tools) → startup-fatal error with state/action path.
 *   - Duplicate tool names in a single activeTools list → startup-fatal error.
 *   - Required tools missing from the declared active set → startup-fatal error.
 *
 * The resolved set is sorted alphabetically for determinism regardless of
 * YAML declaration order.
 *
 * This module is pure TypeScript and performs no LLM calls or runtime prompt inspection.
 */

import type { HarnessConfig, SDLCState, TeammateAction, RequiredTool } from './domain/StateModels.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The resolved active tool set for a state/action pair. */
export interface ResolvedActiveToolSet {
  /** Sorted, deduplicated list of active tool names. */
  toolNames: string[];
  /** True when no activeTools were declared — full tool set was used. */
  isDefault: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requiredToolName(rt: RequiredTool): string {
  return typeof rt === 'string' ? rt : rt.name;
}

function allToolNames(config: HarnessConfig): string[] {
  return (config.tools ?? []).map(t => t.name);
}

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the active tool set for a (stateId, actionId?) pair.
 *
 * @param stateId - The state to resolve for.
 * @param actionId - Optional action id within the state (narrows further if action declares activeTools).
 * @param config - The loaded harness config.
 * @returns The resolved active tool set (sorted, deduplicated).
 *
 * Throws with a descriptive startup-fatal message when:
 *   - stateId does not exist in config.states
 *   - actionId is provided but does not exist in state.actions
 *   - activeTools lists an unknown tool name
 *   - activeTools lists a duplicate tool name
 *   - A requiredTool is missing from an explicit activeTools declaration
 */
export function resolveActiveToolSet(
  stateId: string,
  actionId: string | undefined,
  config: HarnessConfig
): ResolvedActiveToolSet {
  const state = config.states[stateId];
  if (!state) {
    throw new Error(
      `ActiveToolSetResolver: state "${stateId}" does not exist in config. ` +
      `Known states: ${Object.keys(config.states).sort().join(', ')}.`
    );
  }

  const knownTools = new Set(allToolNames(config));

  // Resolve the effective activeTools list and whether it is default.
  let effectiveActiveTools: string[] | undefined;
  let isDefault = true;

  // State-level activeTools.
  if (state.activeTools !== undefined) {
    isDefault = false;
    effectiveActiveTools = state.activeTools;
    lintActiveToolList(state.activeTools, knownTools, `State "${stateId}"`, state, undefined, config);
  }

  // Action-level activeTools (overrides state-level when present).
  if (actionId !== undefined) {
    const action = findAction(state, actionId, stateId);
    if (action.activeTools !== undefined) {
      isDefault = false;
      effectiveActiveTools = action.activeTools;
      lintActiveToolList(action.activeTools, knownTools, `State "${stateId}" action "${actionId}"`, state, action, config);
    }
  }

  let toolNames: string[];
  if (effectiveActiveTools === undefined) {
    // Default: all tools.
    toolNames = [...knownTools].sort();
  } else {
    toolNames = [...new Set(effectiveActiveTools)].sort();
  }

  return { toolNames, isDefault };
}

// ---------------------------------------------------------------------------
// Config-wide lint (called from ConfigLoader.validateSemantics)
// ---------------------------------------------------------------------------

/**
 * Lint all states and actions in the config for activeTools correctness.
 *
 * Fails startup with a descriptive error when:
 *   - An activeTools list references an unknown tool name.
 *   - An activeTools list contains duplicates.
 *   - A requiredTool is absent from a declared (non-default) activeTools set.
 *
 * Called once per config load — pure lint, no side effects.
 */
export function lintActiveToolSets(config: HarnessConfig): void {
  const knownTools = new Set(allToolNames(config));

  for (const [stateId, state] of Object.entries(config.states ?? {})) {
    if (state.activeTools !== undefined) {
      lintActiveToolList(state.activeTools, knownTools, `State "${stateId}"`, state, undefined, config);
    }

    for (const action of state.actions ?? []) {
      if (action.activeTools !== undefined) {
        const location = `State "${stateId}" action "${action.id}"`;
        lintActiveToolList(action.activeTools, knownTools, location, state, action, config);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function findAction(state: SDLCState, actionId: string, stateId: string): TeammateAction {
  const action = (state.actions ?? []).find(a => a.id === actionId);
  if (!action) {
    const known = (state.actions ?? []).map(a => a.id).join(', ') || '(none)';
    throw new Error(
      `ActiveToolSetResolver: action "${actionId}" does not exist in state "${stateId}". ` +
      `Known actions: ${known}.`
    );
  }
  return action;
}

/**
 * Lint a single activeTools list at the given location.
 *
 * Checks:
 *   1. No unknown tool names.
 *   2. No duplicates within the list.
 *   3. All requiredTools (state-level + action-level) are included in the list.
 */
function lintActiveToolList(
  activeTools: string[],
  knownTools: Set<string>,
  location: string,
  state: SDLCState,
  action: TeammateAction | undefined,
  config: HarnessConfig
): void {
  // 1. Unknown tool names.
  const unknown = activeTools.filter(name => !knownTools.has(name));
  if (unknown.length > 0) {
    const knownList = [...knownTools].sort().join(', ') || '(none declared)';
    throw new Error(
      `${location} activeTools references unknown tool name(s): ${unknown.map(n => `"${n}"`).join(', ')}. ` +
      `Known tools: ${knownList}. ` +
      `Declare the tool in config.tools or correct the name.`
    );
  }

  // 2. Duplicates within the list.
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const name of activeTools) {
    if (seen.has(name)) {
      duplicates.push(name);
    }
    seen.add(name);
  }
  if (duplicates.length > 0) {
    throw new Error(
      `${location} activeTools contains duplicate tool name(s): ${duplicates.map(n => `"${n}"`).join(', ')}. ` +
      `Each tool name must appear at most once in activeTools.`
    );
  }

  // 3. Required tools must be included in the active set.
  const activeSet = new Set(activeTools);
  const requiredSources: RequiredTool[] = [
    ...(state.requiredTools ?? []),
    ...(action?.requiredTools ?? []),
  ];
  const missingRequired = requiredSources
    .map(rt => requiredToolName(rt))
    .filter(name => knownTools.has(name) && !activeSet.has(name));

  if (missingRequired.length > 0) {
    throw new Error(
      `${location} activeTools is declared but is missing required tool(s): ` +
      `${missingRequired.map(n => `"${n}"`).join(', ')}. ` +
      `Required tools must be included in activeTools when activeTools is explicitly declared. ` +
      `Add the missing tool(s) to activeTools or remove them from requiredTools.`
    );
  }

  // Unused config parameter guard (referenced only for context in future).
  void config;
}
