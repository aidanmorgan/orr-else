/**
 * active_tool_set_resolver.test.ts
 *
 * pi-experiment-6q0y.1: Deterministic state/action active-tool-set resolver.
 *
 * Tests the REAL resolver (resolveActiveToolSet + lintActiveToolSets) with real
 * HarnessConfig fixtures. All assertions are load-bearing — no vacuous checks.
 *
 * AC coverage:
 *   AC1 — default behavior (no activeTools declared) exposes all tools.
 *   AC1 — state-level activeTools narrows the active set.
 *   AC1 — action-level activeTools overrides the state-level set.
 *   AC2 — unknown tool names fail startup lint with state/action path.
 *   AC2 — duplicate tool names fail startup lint.
 *   AC2 — required tools absent from declared activeTools fail startup lint.
 *   AC3 — resolved set is sorted regardless of YAML declaration order.
 *   AC4 — at least 6 unit tests (there are more here).
 *   AC5 — resolver is pure (no LLM calls; tested by calling it synchronously).
 */

import { describe, it, expect } from 'vitest';
import {
  resolveActiveToolSet,
  lintActiveToolSets,
} from '../src/core/ActiveToolSetResolver.js';
import { EventName } from '../src/constants/domain.js';
import type { HarnessConfig, SDLCState } from '../src/core/domain/StateModels.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid HarnessConfig with the given tools and states.
 * States must be fully described; this helper fills in the surrounding skeleton.
 */
function makeConfig(
  toolNames: string[],
  states: Record<string, Partial<SDLCState> & { actions: SDLCState['actions']; transitions: SDLCState['transitions'] }>
): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: 'test',
      agentTurnTimeoutMs: 3600000,
      processReapIntervalMs: 60000,
      harnessRestartEvent: EventName.HARNESS_RESTART,
      contextRestartEvent: EventName.CONTEXT_RESTART,
      defaultModel: 'gpt-4',
      defaultProvider: 'openai',
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 5,
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    statechart: {
      terminalStates: ['done'],
      advanceOutcomes: ['SUCCESS'],
      failedOutcomes: ['FAILURE'],
      blockedOutcomes: ['BLOCKED'],
    },
    tools: toolNames.map(name => ({
      name,
      type: 'command' as const,
      command: 'node',
    })),
    states: Object.fromEntries(
      Object.entries(states).map(([id, s]) => [
        id,
        {
          id,
          identity: { role: 'R', expertise: 'E', constraints: [] },
          transitions: { SUCCESS: 'done', FAILURE: id },
          ...s,
        },
      ])
    ) as HarnessConfig['states'],
  } as HarnessConfig;
}

// ---------------------------------------------------------------------------
// AC1 & AC3: Default — no activeTools declared
// ---------------------------------------------------------------------------

describe('AC1: default behavior (no activeTools) exposes all tools', () => {
  it('returns all tool names when neither state nor action declares activeTools', () => {
    const config = makeConfig(['tool_a', 'tool_b', 'tool_c'], {
      Alpha: {
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    const result = resolveActiveToolSet('Alpha', undefined, config);

    expect(result.isDefault).toBe(true);
    expect(result.toolNames).toEqual(['tool_a', 'tool_b', 'tool_c']);
  });

  it('returns empty list when config declares no tools (default — full exposure is empty)', () => {
    const config = makeConfig([], {
      Alpha: {
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    const result = resolveActiveToolSet('Alpha', undefined, config);

    expect(result.isDefault).toBe(true);
    expect(result.toolNames).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC1: State-level activeTools narrows the set
// ---------------------------------------------------------------------------

describe('AC1: state-level activeTools narrows the active tool set', () => {
  it('resolved set contains only the state-declared tools', () => {
    const config = makeConfig(['tool_a', 'tool_b', 'tool_c'], {
      Alpha: {
        activeTools: ['tool_b', 'tool_c'],
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    const result = resolveActiveToolSet('Alpha', undefined, config);

    expect(result.isDefault).toBe(false);
    expect(result.toolNames).toEqual(['tool_b', 'tool_c']);
    // tool_a is excluded
    expect(result.toolNames).not.toContain('tool_a');
  });

  it('state with single activeTools entry resolves to exactly that tool', () => {
    const config = makeConfig(['tool_a', 'tool_b'], {
      Alpha: {
        activeTools: ['tool_a'],
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    const result = resolveActiveToolSet('Alpha', undefined, config);

    expect(result.isDefault).toBe(false);
    expect(result.toolNames).toEqual(['tool_a']);
  });
});

// ---------------------------------------------------------------------------
// AC1: Action-level activeTools overrides state-level
// ---------------------------------------------------------------------------

describe('AC1: action-level activeTools overrides state-level', () => {
  it('action activeTools overrides state activeTools when both are declared', () => {
    const config = makeConfig(['tool_a', 'tool_b', 'tool_c'], {
      Alpha: {
        activeTools: ['tool_a', 'tool_b'],
        actions: [
          {
            id: 'go',
            type: 'prompt' as const,
            activeTools: ['tool_c'],
          },
        ],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    const result = resolveActiveToolSet('Alpha', 'go', config);

    // Action wins: only tool_c is active, not tool_a or tool_b
    expect(result.isDefault).toBe(false);
    expect(result.toolNames).toEqual(['tool_c']);
  });

  it('action activeTools is used when state has no activeTools', () => {
    const config = makeConfig(['tool_a', 'tool_b', 'tool_c'], {
      Alpha: {
        actions: [
          {
            id: 'go',
            type: 'prompt' as const,
            activeTools: ['tool_a', 'tool_c'],
          },
        ],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    const result = resolveActiveToolSet('Alpha', 'go', config);

    expect(result.isDefault).toBe(false);
    expect(result.toolNames).toEqual(['tool_a', 'tool_c']);
  });

  it('when actionId is not provided, state-level activeTools is used even if actions declare activeTools', () => {
    const config = makeConfig(['tool_a', 'tool_b', 'tool_c'], {
      Alpha: {
        activeTools: ['tool_b'],
        actions: [
          {
            id: 'go',
            type: 'prompt' as const,
            activeTools: ['tool_a'],
          },
        ],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    // Without actionId — uses state-level
    const result = resolveActiveToolSet('Alpha', undefined, config);

    expect(result.isDefault).toBe(false);
    expect(result.toolNames).toEqual(['tool_b']);
  });
});

// ---------------------------------------------------------------------------
// AC3: Sorted and stable under YAML order changes
// ---------------------------------------------------------------------------

describe('AC3: resolved set is sorted and stable regardless of declaration order', () => {
  it('activeTools in reverse alphabetical order resolves to sorted set', () => {
    const config = makeConfig(['tool_a', 'tool_b', 'tool_c'], {
      Alpha: {
        activeTools: ['tool_c', 'tool_a', 'tool_b'],
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    const result = resolveActiveToolSet('Alpha', undefined, config);

    expect(result.toolNames).toEqual(['tool_a', 'tool_b', 'tool_c']);
  });

  it('default set (no activeTools) is also sorted', () => {
    // Tools declared in non-alphabetical order in config
    const config = makeConfig(['zebra_tool', 'alpha_tool', 'mango_tool'], {
      Alpha: {
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    const result = resolveActiveToolSet('Alpha', undefined, config);

    expect(result.toolNames).toEqual(['alpha_tool', 'mango_tool', 'zebra_tool']);
  });
});

// ---------------------------------------------------------------------------
// AC2: Unknown tool names fail lint
// ---------------------------------------------------------------------------

describe('AC2: unknown tool names in activeTools fail startup lint', () => {
  it('state activeTools with unknown tool name throws with state path in message', () => {
    const config = makeConfig(['tool_a'], {
      Alpha: {
        activeTools: ['tool_a', 'nonexistent_tool'],
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    expect(() => resolveActiveToolSet('Alpha', undefined, config))
      .toThrow(/nonexistent_tool/);
    expect(() => resolveActiveToolSet('Alpha', undefined, config))
      .toThrow(/State "Alpha"/);
  });

  it('action activeTools with unknown tool name throws with state+action path in message', () => {
    const config = makeConfig(['tool_a'], {
      Alpha: {
        actions: [
          {
            id: 'go',
            type: 'prompt' as const,
            activeTools: ['tool_a', 'ghost_tool'],
          },
        ],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    expect(() => resolveActiveToolSet('Alpha', 'go', config))
      .toThrow(/ghost_tool/);
    expect(() => resolveActiveToolSet('Alpha', 'go', config))
      .toThrow(/action "go"/);
  });

  it('lintActiveToolSets catches unknown tool names across all states', () => {
    const config = makeConfig(['tool_a'], {
      Alpha: {
        activeTools: ['tool_a', 'does_not_exist'],
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    expect(() => lintActiveToolSets(config)).toThrow(/does_not_exist/);
  });
});

// ---------------------------------------------------------------------------
// AC2: Duplicate tool names fail lint
// ---------------------------------------------------------------------------

describe('AC2: duplicate tool names in activeTools fail startup lint', () => {
  it('state activeTools with duplicate entries throws with state path in message', () => {
    const config = makeConfig(['tool_a', 'tool_b'], {
      Alpha: {
        activeTools: ['tool_a', 'tool_b', 'tool_a'],
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    expect(() => resolveActiveToolSet('Alpha', undefined, config))
      .toThrow(/duplicate/i);
    expect(() => resolveActiveToolSet('Alpha', undefined, config))
      .toThrow(/tool_a/);
  });

  it('action activeTools with duplicate entries throws with action path in message', () => {
    const config = makeConfig(['tool_a'], {
      Alpha: {
        actions: [
          {
            id: 'go',
            type: 'prompt' as const,
            activeTools: ['tool_a', 'tool_a'],
          },
        ],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    expect(() => resolveActiveToolSet('Alpha', 'go', config))
      .toThrow(/duplicate/i);
  });

  it('lintActiveToolSets catches duplicates in action activeTools', () => {
    const config = makeConfig(['tool_a', 'tool_b'], {
      Alpha: {
        actions: [
          {
            id: 'go',
            type: 'prompt' as const,
            activeTools: ['tool_a', 'tool_b', 'tool_b'],
          },
        ],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    expect(() => lintActiveToolSets(config)).toThrow(/duplicate/i);
  });
});

// ---------------------------------------------------------------------------
// AC2: Required tools missing from declared activeTools fail lint
// ---------------------------------------------------------------------------

describe('AC2: required tools absent from declared activeTools fail startup lint', () => {
  it('state-level requiredTool absent from state activeTools throws', () => {
    const config = makeConfig(['tool_a', 'required_tool'], {
      Alpha: {
        activeTools: ['tool_a'],  // required_tool is NOT here
        requiredTools: ['required_tool'],
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    expect(() => resolveActiveToolSet('Alpha', undefined, config))
      .toThrow(/required_tool/);
    expect(() => resolveActiveToolSet('Alpha', undefined, config))
      .toThrow(/required/i);
  });

  it('action-level requiredTool absent from action activeTools throws', () => {
    const config = makeConfig(['tool_a', 'required_tool'], {
      Alpha: {
        actions: [
          {
            id: 'go',
            type: 'prompt' as const,
            activeTools: ['tool_a'],  // required_tool missing
            requiredTools: ['required_tool'],
          },
        ],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    expect(() => resolveActiveToolSet('Alpha', 'go', config))
      .toThrow(/required_tool/);
  });

  it('required tool included in activeTools does NOT throw', () => {
    const config = makeConfig(['tool_a', 'required_tool'], {
      Alpha: {
        activeTools: ['tool_a', 'required_tool'],
        requiredTools: ['required_tool'],
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    expect(() => resolveActiveToolSet('Alpha', undefined, config)).not.toThrow();
    const result = resolveActiveToolSet('Alpha', undefined, config);
    expect(result.toolNames).toContain('required_tool');
  });

  it('lintActiveToolSets detects required tool missing from state activeTools', () => {
    const config = makeConfig(['tool_a', 'gated_tool'], {
      Alpha: {
        activeTools: ['tool_a'],   // gated_tool missing from active set
        requiredTools: [{ name: 'gated_tool', expectsVerify: false }],
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    expect(() => lintActiveToolSets(config)).toThrow(/gated_tool/);
  });
});

// ---------------------------------------------------------------------------
// AC3 + AC1: Multi-state config — each state resolves independently
// ---------------------------------------------------------------------------

describe('multi-state config: each state resolves its own active set', () => {
  it('different states with different activeTools resolve independently', () => {
    const config = makeConfig(['tool_a', 'tool_b', 'tool_c'], {
      Alpha: {
        activeTools: ['tool_a'],
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
      Bravo: {
        activeTools: ['tool_b', 'tool_c'],
        actions: [{ id: 'run', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Bravo' },
      },
    });

    const alphaResult = resolveActiveToolSet('Alpha', undefined, config);
    const bravoResult = resolveActiveToolSet('Bravo', undefined, config);

    expect(alphaResult.toolNames).toEqual(['tool_a']);
    expect(bravoResult.toolNames).toEqual(['tool_b', 'tool_c']);
  });

  it('one state with no activeTools gets full set; another with activeTools gets subset', () => {
    const config = makeConfig(['tool_a', 'tool_b'], {
      Alpha: {
        // No activeTools — full set
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
      Bravo: {
        activeTools: ['tool_a'],
        actions: [{ id: 'run', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Bravo' },
      },
    });

    const alphaResult = resolveActiveToolSet('Alpha', undefined, config);
    const bravoResult = resolveActiveToolSet('Bravo', undefined, config);

    expect(alphaResult.isDefault).toBe(true);
    expect(alphaResult.toolNames).toEqual(['tool_a', 'tool_b']);

    expect(bravoResult.isDefault).toBe(false);
    expect(bravoResult.toolNames).toEqual(['tool_a']);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('throws with descriptive message for unknown stateId', () => {
    const config = makeConfig(['tool_a'], {
      Alpha: {
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    expect(() => resolveActiveToolSet('NonExistent', undefined, config))
      .toThrow(/NonExistent/);
  });

  it('throws with descriptive message for unknown actionId', () => {
    const config = makeConfig(['tool_a'], {
      Alpha: {
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    expect(() => resolveActiveToolSet('Alpha', 'ghost_action', config))
      .toThrow(/ghost_action/);
  });

  it('lintActiveToolSets succeeds on config with no activeTools declared anywhere', () => {
    const config = makeConfig(['tool_a', 'tool_b'], {
      Alpha: {
        actions: [{ id: 'go', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    expect(() => lintActiveToolSets(config)).not.toThrow();
  });

  it('lintActiveToolSets succeeds on config with valid activeTools on both state and action', () => {
    const config = makeConfig(['tool_a', 'tool_b', 'tool_c'], {
      Alpha: {
        activeTools: ['tool_a', 'tool_b'],
        actions: [
          {
            id: 'go',
            type: 'prompt' as const,
            activeTools: ['tool_a'],
          },
        ],
        transitions: { SUCCESS: 'done', FAILURE: 'Alpha' },
      },
    });

    expect(() => lintActiveToolSets(config)).not.toThrow();
  });
});
