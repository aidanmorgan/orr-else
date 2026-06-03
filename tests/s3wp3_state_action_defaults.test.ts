/**
 * s3wp.3: state and action defaults runtime-backed
 *
 * Tests that resolveActionContextMode, resolveActionHandoverRequired, and
 * actionRunContext honor the inheritance chain:
 *   per-action → per-state (defaultActionContextMode/handoverRequired) → global settings
 *
 * Also tests the ConfigLoader YAML-level surface for defaultActionContextMode and
 * handoverRequired fields.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveActionContextMode,
  resolveActionHandoverRequired,
  actionRunContext
} from '../src/extension/CoordinatorController.js';
import { ActionContextMode, ActionRunContext, ActionType, EventName } from '../src/constants/index.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import type { SDLCState, TeammateAction } from '../src/core/domain/StateModels.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeAction(overrides: Partial<TeammateAction> = {}): TeammateAction {
  return {
    id: 'a1',
    type: ActionType.PROMPT,
    ...overrides
  };
}

function makeState(overrides: Partial<SDLCState> = {}): SDLCState {
  return {
    id: 'TestState',
    identity: { role: 'R', expertise: 'E', constraints: [] },
    actions: [],
    transitions: {},
    ...overrides
  } as unknown as SDLCState;
}

function makeConfig(overrides: Partial<HarnessConfig['settings']> = {}): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 2,
      handoverTemplate: 'test',
      agentTurnTimeoutMs: 3600000,
      processReapIntervalMs: 60000,
      startState: 'TestState',
      harnessRestartEvent: EventName.HARNESS_RESTART,
      contextRestartEvent: EventName.CONTEXT_RESTART,
      defaultModel: 'gpt-4',
      defaultProvider: 'openai',
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 5,
      ...overrides
    },
    scheduler: { weights: { waitTime: 1, executionTime: 0.5, progress: 2, penalty: 1 } },
    states: {}
  } as unknown as HarnessConfig;
}

// ── resolveActionContextMode ──────────────────────────────────────────────────

describe('resolveActionContextMode (s3wp.3)', () => {
  it('returns per-action contextMode when set (highest priority)', () => {
    const action = makeAction({ contextMode: ActionContextMode.SUBAGENT });
    const state = makeState({ defaultActionContextMode: ActionContextMode.SAME });
    const config = makeConfig({ defaultActionContextMode: ActionContextMode.ONE_SHOT });

    expect(resolveActionContextMode(action, state, config)).toBe(ActionContextMode.SUBAGENT);
  });

  it('falls back to state.defaultActionContextMode when action.contextMode is absent', () => {
    const action = makeAction(); // no contextMode
    const state = makeState({ defaultActionContextMode: ActionContextMode.ONE_SHOT });
    const config = makeConfig({ defaultActionContextMode: ActionContextMode.SUBAGENT });

    expect(resolveActionContextMode(action, state, config)).toBe(ActionContextMode.ONE_SHOT);
  });

  it('falls back to settings.defaultActionContextMode when neither action nor state set it', () => {
    const action = makeAction();
    const state = makeState(); // no defaultActionContextMode
    const config = makeConfig({ defaultActionContextMode: ActionContextMode.SUBAGENT });

    expect(resolveActionContextMode(action, state, config)).toBe(ActionContextMode.SUBAGENT);
  });

  it('returns undefined when no level sets contextMode', () => {
    const action = makeAction();
    const state = makeState();
    const config = makeConfig();

    expect(resolveActionContextMode(action, state, config)).toBeUndefined();
  });

  it('works without state and config (backwards compat — per-action only)', () => {
    const action = makeAction({ contextMode: ActionContextMode.SAME });
    expect(resolveActionContextMode(action)).toBe(ActionContextMode.SAME);
  });

  it('returns undefined when called with no args set (no state, no config)', () => {
    const action = makeAction();
    expect(resolveActionContextMode(action)).toBeUndefined();
  });
});

// ── resolveActionHandoverRequired ────────────────────────────────────────────

describe('resolveActionHandoverRequired (s3wp.3)', () => {
  it('returns per-action handoverRequired when set (highest priority)', () => {
    const action = makeAction({ handoverRequired: true });
    const state = makeState({ handoverRequired: false });
    expect(resolveActionHandoverRequired(action, state)).toBe(true);
  });

  it('per-action false overrides state true', () => {
    const action = makeAction({ handoverRequired: false });
    const state = makeState({ handoverRequired: true });
    expect(resolveActionHandoverRequired(action, state)).toBe(false);
  });

  it('falls back to state.handoverRequired when action has no explicit value', () => {
    const action = makeAction(); // no handoverRequired
    const state = makeState({ handoverRequired: true });
    expect(resolveActionHandoverRequired(action, state)).toBe(true);
  });

  it('returns false (default) when neither action nor state set handoverRequired', () => {
    const action = makeAction();
    const state = makeState();
    expect(resolveActionHandoverRequired(action, state)).toBe(false);
  });

  it('returns false when called without state', () => {
    const action = makeAction();
    expect(resolveActionHandoverRequired(action)).toBe(false);
  });

  it('per-action true without state is true', () => {
    const action = makeAction({ handoverRequired: true });
    expect(resolveActionHandoverRequired(action)).toBe(true);
  });
});

// ── actionRunContext with inheritance ────────────────────────────────────────

describe('actionRunContext with s3wp.3 inheritance', () => {
  it('SUBAGENT contextMode → FRESH (per-action, direct)', () => {
    const action = makeAction({ contextMode: ActionContextMode.SUBAGENT });
    expect(actionRunContext(action)).toBe(ActionRunContext.FRESH);
  });

  it('ONE_SHOT contextMode → FRESH (per-action)', () => {
    const action = makeAction({ contextMode: ActionContextMode.ONE_SHOT });
    expect(actionRunContext(action)).toBe(ActionRunContext.FRESH);
  });

  it('SAME contextMode → PARENT (per-action)', () => {
    const action = makeAction({ contextMode: ActionContextMode.SAME });
    expect(actionRunContext(action)).toBe(ActionRunContext.PARENT);
  });

  it('state.defaultActionContextMode=SUBAGENT propagates to action when action has no contextMode', () => {
    const action = makeAction(); // no contextMode
    const state = makeState({ defaultActionContextMode: ActionContextMode.SUBAGENT });
    const config = makeConfig();

    expect(actionRunContext(action, state, config)).toBe(ActionRunContext.FRESH);
  });

  it('state.defaultActionContextMode=ONE_SHOT propagates to action', () => {
    const action = makeAction();
    const state = makeState({ defaultActionContextMode: ActionContextMode.ONE_SHOT });
    const config = makeConfig();

    expect(actionRunContext(action, state, config)).toBe(ActionRunContext.FRESH);
  });

  it('settings.defaultActionContextMode=SUBAGENT propagates when neither action nor state set it', () => {
    const action = makeAction();
    const state = makeState();
    const config = makeConfig({ defaultActionContextMode: ActionContextMode.SUBAGENT });

    expect(actionRunContext(action, state, config)).toBe(ActionRunContext.FRESH);
  });

  it('per-action SAME overrides state SUBAGENT default → PARENT', () => {
    const action = makeAction({ contextMode: ActionContextMode.SAME });
    const state = makeState({ defaultActionContextMode: ActionContextMode.SUBAGENT });
    const config = makeConfig({ defaultActionContextMode: ActionContextMode.SUBAGENT });

    expect(actionRunContext(action, state, config)).toBe(ActionRunContext.PARENT);
  });

  it('action.context=fresh still produces FRESH regardless of contextMode', () => {
    // The legacy action.context field must still work
    const action = makeAction({ context: ActionRunContext.FRESH, contextMode: ActionContextMode.SAME });
    expect(actionRunContext(action)).toBe(ActionRunContext.FRESH);
  });

  it('no contextMode anywhere → PARENT (default behavior preserved)', () => {
    const action = makeAction();
    const state = makeState();
    const config = makeConfig();
    expect(actionRunContext(action, state, config)).toBe(ActionRunContext.PARENT);
  });

  it('backwards compat: actionRunContext(action) with one arg still works', () => {
    // Pre-s3wp.3 call sites pass only the action — must not break
    const fresh = makeAction({ contextMode: ActionContextMode.SUBAGENT });
    const parent = makeAction({ contextMode: ActionContextMode.SAME });
    const neither = makeAction();

    expect(actionRunContext(fresh)).toBe(ActionRunContext.FRESH);
    expect(actionRunContext(parent)).toBe(ActionRunContext.PARENT);
    expect(actionRunContext(neither)).toBe(ActionRunContext.PARENT);
  });
});

// ── selectActiveAction honors state-level defaultActionContextMode ────────────

describe('selectActiveAction honors state-level defaultActionContextMode (s3wp.3)', () => {
  it('when state.defaultActionContextMode=subagent, prompt action resolves to FRESH and is selected last', async () => {
    // Import here to avoid circular issues
    const { selectActiveAction } = await import('../src/extension/CoordinatorController.js');

    const action1: TeammateAction = { id: 'a1', type: ActionType.PROMPT };
    const action2: TeammateAction = { id: 'a2', type: ActionType.PROMPT };

    // When state.defaultActionContextMode=subagent, all prompt actions → FRESH
    // selectActiveAction prefers PARENT+PROMPT first, so with all-FRESH it falls
    // back to the FRESH finder which picks action1.
    const state = makeState({
      defaultActionContextMode: ActionContextMode.SUBAGENT,
      actions: [action1, action2]
    });
    const config = makeConfig();

    const selected = selectActiveAction(config, 'TestState', state);
    expect(selected?.id).toBe('a1');
    // Verify the resolved context is FRESH
    expect(actionRunContext(selected!, state, config)).toBe(ActionRunContext.FRESH);
  });
});
