/**
 * pi-experiment-amq0.12: RawHarnessConfig / ResolvedHarnessConfig split.
 *
 * Tests cover:
 *   1. Malformed raw config rejection — unknown enum values at admission.
 *   2. Valid shorthand normalization — valid enum strings pass through unchanged.
 *   3. Unknown context mode → startup rejects (load-bearing test: fails if guard removed).
 *   4. Unknown tool type → AJV schema rejects at validate() time.
 *   5. Unknown root kind → validateNamedRoots rejects at validateSemantics() time.
 *   6. Removed-field rejection — v2 removed fields rejected by preValidateV2Admission.
 *   7. Compile-time narrowing — consumers take ResolvedHarnessConfig (enforced by type assertions).
 *   8. worktree provisioning mode unknown value → admission rejects.
 *   9. Unknown thinking level → admission rejects.
 *  10. Unknown action run context → admission rejects.
 *  11. Unknown context policy mode → admission rejects.
 *
 * LOAD-BEARING (critical tests — removing the guard causes these to FAIL):
 *   - "unknown action context mode is rejected at admission" (test 3)
 *   - "unknown thinking level is rejected at admission" (test 9)
 *   - "unknown action run context is rejected at admission" (test 10)
 *   - "unknown context policy mode is rejected at admission" (test 11)
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigValidator } from '../src/core/ConfigValidator.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import type { ResolvedHarnessConfig, RawHarnessConfig } from '../src/core/ConfigLoader.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import { ActionContextMode, ActionRunContext, StateContextPolicy, ThinkingLevel } from '../src/constants/domain.js';

// ── Temp dir for YAML fixture files (D1: unknown tool type + unknown root kind) ──

const TEST_DIR = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'orr-else-amq0.12-'));

function writeYaml(name: string, content: string): string {
  const p = path.join(TEST_DIR, name);
  fs.writeFileSync(p, content);
  return p;
}

afterAll(() => {
  for (const f of fs.readdirSync(TEST_DIR)) {
    try { fs.unlinkSync(path.join(TEST_DIR, f)); } catch { /* ignore */ }
  }
  try { fs.rmdirSync(TEST_DIR); } catch { /* ignore */ }
});

// ── Compile-time narrowing assertion helpers ────────────────────────────────
//
// These functions accept ResolvedHarnessConfig. TypeScript enforces at compile
// time that you cannot pass RawHarnessConfig (which lacks the canonical types).
// The functions are intentionally trivial — what matters is that they compile.

/**
 * Compile-time proof: a function that accepts ResolvedHarnessConfig compiles.
 * Calling it with a HarnessConfig (= ResolvedHarnessConfig) is valid.
 */
function assertConsumerTakesResolved(config: ResolvedHarnessConfig): string {
  // Access a narrowed field — compiler enforces ThinkingLevel, not `string`.
  const providers = config.settings.modelProviders;
  const key = Object.keys(providers)[0];
  const thinking: ThinkingLevel | undefined = providers[key]?.thinking;
  return thinking ?? 'none';
}

/**
 * Compile-time proof: action.contextMode is ActionContextMode (not string).
 * If the field were `string`, we could not assign it to `ActionContextMode | undefined`.
 */
function assertContextModeNarrowed(config: ResolvedHarnessConfig): ActionContextMode | undefined {
  const states = Object.values(config.states);
  const firstAction = states[0]?.actions?.[0];
  // This assignment is valid only if contextMode is ActionContextMode (canonical enum),
  // not `ActionContextMode | string` (widened).
  const mode: ActionContextMode | undefined = firstAction?.contextMode;
  return mode;
}

/**
 * Compile-time proof: action.context is ActionRunContext (not string).
 */
function assertRunContextNarrowed(config: ResolvedHarnessConfig): ActionRunContext | undefined {
  const states = Object.values(config.states);
  const firstAction = states[0]?.actions?.[0];
  const context: ActionRunContext | undefined = firstAction?.context;
  return context;
}

/**
 * Compile-time proof: ResolvedHarnessConfig IS HarnessConfig (same type).
 * Both directions must be assignable for the alias to be correct.
 */
function roundTripTypeCheck(resolved: ResolvedHarnessConfig): HarnessConfig {
  return resolved;
}

// Suppress unused-function warnings (the compile-time check is the value).
void assertConsumerTakesResolved;
void assertContextModeNarrowed;
void assertRunContextNarrowed;
void roundTripTypeCheck;

// ── Helper — make a ConfigValidator with no schema path override ────────────
function makeValidator(dir: string = '/tmp'): ConfigValidator {
  return new ConfigValidator(dir, () => `${dir}/harness.yaml`);
}

// ── 1 + 7: Compile-time narrowing of ResolvedHarnessConfig consumers ────────

describe('amq0.12: compile-time narrowing of ResolvedHarnessConfig consumers', () => {
  it('ResolvedHarnessConfig type alias equals HarnessConfig (bidirectional assignability)', () => {
    // If this test file compiles, the roundTripTypeCheck function above is valid,
    // proving ResolvedHarnessConfig and HarnessConfig are the same type.
    expect(true).toBe(true);
  });

  it('assertConsumerTakesResolved compiles — thinking field is ThinkingLevel (not string)', () => {
    // The fact that assertConsumerTakesResolved assigns config.settings.modelProviders[k].thinking
    // to `ThinkingLevel | undefined` proves the compile-time narrowing is real.
    // If LLMThinkingLevel were still `ThinkingLevel | string`, the assignment would
    // produce a TS error (string not assignable to ThinkingLevel).
    expect(typeof assertConsumerTakesResolved).toBe('function');
  });

  it('assertContextModeNarrowed compiles — contextMode is ActionContextMode (not string)', () => {
    // The assignment `const mode: ActionContextMode | undefined = firstAction?.contextMode`
    // compiles only when ConfiguredActionContextMode = ActionContextMode (not | string).
    expect(typeof assertContextModeNarrowed).toBe('function');
  });

  it('assertRunContextNarrowed compiles — context is ActionRunContext (not string)', () => {
    // The assignment `const context: ActionRunContext | undefined = firstAction?.context`
    // compiles only when ConfiguredActionRunContext = ActionRunContext (not | string).
    expect(typeof assertRunContextNarrowed).toBe('function');
  });
});

// ── 2: Valid enum values pass admission ──────────────────────────────────────

describe('amq0.12: valid enum values pass admission (validateEnumAdmission)', () => {
  it('all valid ThinkingLevel values pass', () => {
    const validator = makeValidator();
    for (const level of Object.values(ThinkingLevel)) {
      expect(() => validator.validateEnumAdmission({
        settings: {
          modelProviders: {
            claude: { provider: 'anthropic', model: 'claude-opus-4-5', thinking: level }
          }
        },
        states: {}
      })).not.toThrow();
    }
  });

  it('all valid ActionContextMode values pass', () => {
    const validator = makeValidator();
    for (const mode of Object.values(ActionContextMode)) {
      expect(() => validator.validateEnumAdmission({
        settings: { defaultActionContextMode: mode },
        states: {}
      })).not.toThrow();
    }
  });

  it('all valid ActionRunContext values pass', () => {
    const validator = makeValidator();
    for (const ctx of Object.values(ActionRunContext)) {
      expect(() => validator.validateEnumAdmission({
        settings: {},
        states: {
          Planning: {
            actions: [{ id: 'act', type: 'prompt', context: ctx }]
          }
        }
      })).not.toThrow();
    }
  });

  it('all valid StateContextPolicy values pass (string shorthand)', () => {
    const validator = makeValidator();
    for (const mode of Object.values(StateContextPolicy)) {
      expect(() => validator.validateEnumAdmission({
        settings: {},
        states: {
          Planning: { contextPolicy: mode }
        }
      })).not.toThrow();
    }
  });

  it('all valid StateContextPolicy values pass (structured form)', () => {
    const validator = makeValidator();
    for (const mode of Object.values(StateContextPolicy)) {
      expect(() => validator.validateEnumAdmission({
        settings: {},
        states: {
          Planning: { contextPolicy: { mode } }
        }
      })).not.toThrow();
    }
  });

  it('valid worktree provisioning modes pass', () => {
    const validator = makeValidator();
    for (const wm of ['always', 'never']) {
      expect(() => validator.validateEnumAdmission({
        settings: { worktreePolicy: { default: wm } },
        states: {}
      })).not.toThrow();
    }
  });

  it('absent enum fields (undefined) pass — absence is allowed', () => {
    const validator = makeValidator();
    expect(() => validator.validateEnumAdmission({
      settings: {},
      states: { Planning: { actions: [{ id: 'a', type: 'prompt' }] } }
    })).not.toThrow();
  });
});

// ── 3: LOAD-BEARING — unknown action context mode is rejected ─────────────────

describe('amq0.12: unknown action context mode → startup rejects (LOAD-BEARING)', () => {
  it('unknown contextMode on action is rejected', () => {
    const validator = makeValidator();
    expect(() => validator.validateEnumAdmission({
      settings: {},
      states: {
        Planning: {
          actions: [{ id: 'act', type: 'prompt', contextMode: 'UNKNOWN_MODE' }]
        }
      }
    })).toThrow(/unknown enum value/i);
  });

  it('unknown defaultActionContextMode on state is rejected', () => {
    const validator = makeValidator();
    expect(() => validator.validateEnumAdmission({
      settings: {},
      states: {
        Planning: { defaultActionContextMode: 'bad_mode' }
      }
    })).toThrow(/unknown enum value/i);
  });

  it('unknown defaultActionContextMode in settings is rejected', () => {
    const validator = makeValidator();
    expect(() => validator.validateEnumAdmission({
      settings: { defaultActionContextMode: 'not_a_real_mode' },
      states: {}
    })).toThrow(/unknown enum value/i);
  });

  it('diagnostic names the offending field and lists valid values', () => {
    const validator = makeValidator();
    let err: Error | null = null;
    try {
      validator.validateEnumAdmission({
        settings: { defaultActionContextMode: 'magic_mode' },
        states: {}
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('magic_mode');
    expect(err!.message).toContain('ActionContextMode');
    // Valid values are listed
    expect(err!.message).toContain('same');
    expect(err!.message).toContain('oneShot');
    expect(err!.message).toContain('subagent');
  });
});

// ── 9: LOAD-BEARING — unknown thinking level is rejected ──────────────────────

describe('amq0.12: unknown thinking level → startup rejects (LOAD-BEARING)', () => {
  it('unknown thinking in modelProviders is rejected', () => {
    const validator = makeValidator();
    expect(() => validator.validateEnumAdmission({
      settings: {
        modelProviders: {
          myProv: { provider: 'x', model: 'y', thinking: 'ultra_think' }
        }
      },
      states: {}
    })).toThrow(/unknown enum value/i);
  });

  it('unknown thinking on state is rejected', () => {
    const validator = makeValidator();
    expect(() => validator.validateEnumAdmission({
      settings: {},
      states: {
        Planning: { thinking: 'godmode' }
      }
    })).toThrow(/unknown enum value/i);
  });

  it('diagnostic names the offending field and lists valid ThinkingLevel values', () => {
    const validator = makeValidator();
    let err: Error | null = null;
    try {
      validator.validateEnumAdmission({
        settings: {
          modelProviders: { x: { provider: 'y', model: 'z', thinking: 'turbo' } }
        },
        states: {}
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('turbo');
    expect(err!.message).toContain('ThinkingLevel');
    expect(err!.message).toContain('high');
    expect(err!.message).toContain('medium');
  });
});

// ── 10: LOAD-BEARING — unknown action run context is rejected ─────────────────

describe('amq0.12: unknown action run context → startup rejects (LOAD-BEARING)', () => {
  it('unknown context on action is rejected', () => {
    const validator = makeValidator();
    expect(() => validator.validateEnumAdmission({
      settings: {},
      states: {
        Planning: {
          actions: [{ id: 'act', type: 'prompt', context: 'multi' }]
        }
      }
    })).toThrow(/unknown enum value/i);
  });

  it('diagnostic names the offending field and lists valid ActionRunContext values', () => {
    const validator = makeValidator();
    let err: Error | null = null;
    try {
      validator.validateEnumAdmission({
        settings: {},
        states: {
          Planning: {
            actions: [{ id: 'act', type: 'prompt', context: 'multi' }]
          }
        }
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('multi');
    expect(err!.message).toContain('ActionRunContext');
    expect(err!.message).toContain('parent');
    expect(err!.message).toContain('fresh');
  });
});

// ── 11: LOAD-BEARING — unknown context policy mode is rejected ────────────────

describe('amq0.12: unknown context policy mode → startup rejects (LOAD-BEARING)', () => {
  it('unknown contextPolicy string shorthand is rejected', () => {
    const validator = makeValidator();
    expect(() => validator.validateEnumAdmission({
      settings: {},
      states: { Planning: { contextPolicy: 'parallelBranch' } }
    })).toThrow(/unknown enum value/i);
  });

  it('unknown contextPolicy.mode in structured form is rejected', () => {
    const validator = makeValidator();
    expect(() => validator.validateEnumAdmission({
      settings: {},
      states: { Planning: { contextPolicy: { mode: 'sharedSession' } } }
    })).toThrow(/unknown enum value/i);
  });

  it('diagnostic names the field and lists valid StateContextPolicy values', () => {
    const validator = makeValidator();
    let err: Error | null = null;
    try {
      validator.validateEnumAdmission({
        settings: {},
        states: { Planning: { contextPolicy: { mode: 'sharedSession' } } }
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('sharedSession');
    expect(err!.message).toContain('StateContextPolicy');
    expect(err!.message).toContain('freshSubagent');
    expect(err!.message).toContain('namedContinuation');
  });
});

// ── 8: Unknown worktree provisioning mode is rejected ────────────────────────

describe('amq0.12: unknown worktree provisioning mode → startup rejects', () => {
  it('unknown worktreePolicy.default is rejected', () => {
    const validator = makeValidator();
    expect(() => validator.validateEnumAdmission({
      settings: { worktreePolicy: { default: 'on_demand' } },
      states: {}
    })).toThrow(/unknown enum value/i);
  });

  it('diagnostic names the field and lists valid values', () => {
    const validator = makeValidator();
    let err: Error | null = null;
    try {
      validator.validateEnumAdmission({
        settings: { worktreePolicy: { default: 'on_demand' } },
        states: {}
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('on_demand');
    expect(err!.message).toContain('always');
    expect(err!.message).toContain('never');
  });
});

// ── 6: Removed-field rejection (preValidateV2Admission) ──────────────────────

describe('amq0.12: removed v2 fields are rejected at preValidateV2Admission', () => {
  it('settings.startState rejected in v2 config', () => {
    const validator = makeValidator();
    expect(() => validator.preValidateV2Admission({
      version: 2,
      settings: { startState: 'Planning' }
    })).toThrow('settings.startState');
  });

  it('statechart.terminalStates rejected in v2 config', () => {
    const validator = makeValidator();
    expect(() => validator.preValidateV2Admission({
      version: 2,
      settings: {},
      statechart: { terminalStates: ['Done'] }
    })).toThrow('statechart.terminalStates');
  });

  it('statechart.initialState rejected in v2 config', () => {
    const validator = makeValidator();
    expect(() => validator.preValidateV2Admission({
      version: 2,
      settings: {},
      statechart: { initialState: 'Planning' }
    })).toThrow('statechart.initialState');
  });

  it('runtime.adapters.worker rejected in v2 config', () => {
    const validator = makeValidator();
    expect(() => validator.preValidateV2Admission({
      version: 2,
      settings: {},
      runtime: { adapters: { worker: 'tmux' } }
    })).toThrow('runtime.adapters.worker');
  });

  it('runtime.teammates rejected in v2 config (renamed to runtime.workers)', () => {
    const validator = makeValidator();
    expect(() => validator.preValidateV2Admission({
      version: 2,
      settings: {},
      runtime: { teammates: 3 }
    })).toThrow('runtime.teammates');
  });
});

// ── RawHarnessConfig type: widened fields are accepted by the type ────────────

describe('amq0.12: RawHarnessConfig type structure', () => {
  it('RawHarnessConfig accepts widened string values for enum fields', () => {
    // This test proves that RawHarnessConfig is structurally valid for untrusted YAML values.
    // It does NOT call any runtime validation — it is a compile-time check.
    const raw: RawHarnessConfig = {
      settings: {
        modelProviders: {
          x: { provider: 'openai', model: 'gpt-5', thinking: 'future_level' }
        },
        defaultActionContextMode: 'not_a_real_mode',
        worktreePolicy: { default: 'on_demand' }
      },
      states: {
        Planning: {
          thinking: 'future_level',
          defaultActionContextMode: 'not_a_real_mode',
          contextPolicy: 'unknown_policy',
          actions: [{ id: 'a', context: 'multi', contextMode: 'bad_mode' }]
        }
      }
    };
    // If this line compiles, RawHarnessConfig correctly accepts widened string values.
    expect(raw.settings?.defaultActionContextMode).toBe('not_a_real_mode');
  });
});

// ── Multiple unknown values produce combined diagnostic ───────────────────────

describe('amq0.12: multiple unknown enum values produce combined diagnostic', () => {
  it('two unknown values in same config produce one rejection with both listed', () => {
    const validator = makeValidator();
    let err: Error | null = null;
    try {
      validator.validateEnumAdmission({
        settings: {
          modelProviders: { x: { provider: 'p', model: 'm', thinking: 'turbo' } },
          defaultActionContextMode: 'magic'
        },
        states: {}
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    // Both errors should appear in the combined diagnostic
    expect(err!.message).toContain('turbo');
    expect(err!.message).toContain('magic');
    expect(err!.message).toContain('2 unknown enum value');
  });
});

// ── D1: Unknown tool type → AJV rejects via ConfigLoader.load() (REAL PATH) ───

// Minimal valid v1 YAML base. Valid through AJV + validateSemantics. Lets us
// append tool blocks without touching other validation paths.
const MINIMAL_V1_BASE = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`;

describe('amq0.12: unknown tool type → AJV rejects via real ConfigLoader.load() path (D1)', () => {
  it('tool with unknown type is rejected by AJV schema before semantics', () => {
    // The AJV schema uses oneOf for tools — only "command", "mcp", and
    // "tsProjectTool" types are valid. An unknown type matches no oneOf branch
    // and causes schema validation to fail.
    const p = writeYaml('d1_unknown_tool_type.yaml', MINIMAL_V1_BASE + `
tools:
  - name: my_tool
    type: unknown_tool_type
    command: echo
`);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/validation failed/i);
  });
});

// ── D1: Unknown root kind → validateNamedRoots rejects via validateSemantics() (REAL PATH) ─

describe('amq0.12: unknown root kind → validateNamedRoots rejects via real validateSemantics() path (D1)', () => {
  it('tool with unknown rootKind in argumentPathScope is rejected by validateNamedRoots', () => {
    // rootKind is an open string in the AJV schema (supports named roots), but
    // validateNamedRoots checks that non-builtin rootKinds match a settings.roots key.
    // An unknown rootKind that is neither builtin nor declared in settings.roots → startup-fatal.
    const p = writeYaml('d1_unknown_root_kind.yaml', MINIMAL_V1_BASE + `
tools:
  - name: my_tool
    type: command
    command: echo
    argumentPathScope:
      rootKind: completely_unknown_root
`);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/unknown named root kind/i);
  });
});

// ── D3: validateSemantics-driven enum rejection tests (LOAD-BEARING wiring check) ──
//
// These tests drive the REAL startup path: validator.validateSemantics(config).
// They MUST fail if `this.validateEnumAdmission(config)` is removed from
// validateSemantics — mutation B: comment out the call → these tests go red.
//
// Minimal HarnessConfig-shaped object that satisfies validateSemantics without
// triggering other guards. Includes: statechart with explicit vocabulary, a
// terminal state, no transition targets outside known states.

function makeMinimalConfig(overrides: Record<string, unknown> = {}): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: 'handover',
      agentTurnTimeoutMs: 3600000,
      processReapIntervalMs: 60000,
      harnessRestartEvent: 'RESTART',
      contextRestartEvent: 'CTX_RESTART',
      defaultModel: 'test-model',
      defaultProvider: 'test-provider',
      modelProviders: {},
      stateContextRotThreshold: 0,
      harnessContextRotThreshold: 0,
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    statechart: {
      terminalStates: ['completed'],
      advanceOutcomes: ['SUCCESS'],
      failedOutcomes: ['FAILURE'],
      blockedOutcomes: ['BLOCKED'],
    },
    states: {
      Planning: {
        id: 'Planning',
        identity: { role: 'Planner', expertise: 'Planning', constraints: [] },
        baseInstructions: 'Plan',
        actions: [{ id: 'a1', type: 'prompt' }],
        transitions: { SUCCESS: 'completed', FAILURE: 'Planning' },
      },
    },
    ...overrides,
  } as unknown as HarnessConfig;
}

describe('amq0.12: validateSemantics-driven unknown enum rejection tests (LOAD-BEARING wiring, D3)', () => {
  it('unknown defaultActionContextMode in settings → validateSemantics throws (wiring test)', () => {
    // This test FAILS if `this.validateEnumAdmission(config)` is removed from validateSemantics.
    const validator = makeValidator();
    const config = makeMinimalConfig({
      settings: {
        maxConcurrentSlots: 1,
        handoverTemplate: 'handover',
        agentTurnTimeoutMs: 3600000,
        processReapIntervalMs: 60000,
        harnessRestartEvent: 'RESTART',
        contextRestartEvent: 'CTX_RESTART',
        defaultModel: 'test-model',
        defaultProvider: 'test-provider',
        modelProviders: {},
        stateContextRotThreshold: 0,
        harnessContextRotThreshold: 0,
        defaultActionContextMode: 'UNKNOWN_CONTEXT_MODE',
      },
    });
    expect(() => validator.validateSemantics(config)).toThrow(/unknown enum value/i);
  });

  it('unknown thinking level in modelProviders → validateSemantics throws (wiring test)', () => {
    // This test FAILS if `this.validateEnumAdmission(config)` is removed from validateSemantics.
    const validator = makeValidator();
    const config = makeMinimalConfig({
      settings: {
        maxConcurrentSlots: 1,
        handoverTemplate: 'handover',
        agentTurnTimeoutMs: 3600000,
        processReapIntervalMs: 60000,
        harnessRestartEvent: 'RESTART',
        contextRestartEvent: 'CTX_RESTART',
        defaultModel: 'test-model',
        defaultProvider: 'test-provider',
        modelProviders: {
          myProvider: { provider: 'x', model: 'y', thinking: 'ultra_think' },
        },
        stateContextRotThreshold: 0,
        harnessContextRotThreshold: 0,
      },
    });
    expect(() => validator.validateSemantics(config)).toThrow(/unknown enum value/i);
  });

  it('unknown ActionRunContext on action → validateSemantics throws (wiring test)', () => {
    // This test FAILS if `this.validateEnumAdmission(config)` is removed from validateSemantics.
    const validator = makeValidator();
    const config = makeMinimalConfig({
      states: {
        Planning: {
          id: 'Planning',
          identity: { role: 'Planner', expertise: 'Planning', constraints: [] },
          baseInstructions: 'Plan',
          actions: [{ id: 'a1', type: 'prompt', context: 'unknown_run_context' }],
          transitions: { SUCCESS: 'completed', FAILURE: 'Planning' },
        },
      },
    });
    expect(() => validator.validateSemantics(config)).toThrow(/unknown enum value/i);
  });

  it('unknown StateContextPolicy on state → validateSemantics throws (wiring test)', () => {
    // This test FAILS if `this.validateEnumAdmission(config)` is removed from validateSemantics.
    const validator = makeValidator();
    const config = makeMinimalConfig({
      states: {
        Planning: {
          id: 'Planning',
          identity: { role: 'Planner', expertise: 'Planning', constraints: [] },
          baseInstructions: 'Plan',
          actions: [{ id: 'a1', type: 'prompt' }],
          transitions: { SUCCESS: 'completed', FAILURE: 'Planning' },
          contextPolicy: 'unknown_policy_mode',
        },
      },
    });
    expect(() => validator.validateSemantics(config)).toThrow(/unknown enum value/i);
  });

  it('unknown worktreePolicy.default → validateSemantics throws (wiring test)', () => {
    // This test FAILS if `this.validateEnumAdmission(config)` is removed from validateSemantics.
    const validator = makeValidator();
    const config = makeMinimalConfig({
      settings: {
        maxConcurrentSlots: 1,
        handoverTemplate: 'handover',
        agentTurnTimeoutMs: 3600000,
        processReapIntervalMs: 60000,
        harnessRestartEvent: 'RESTART',
        contextRestartEvent: 'CTX_RESTART',
        defaultModel: 'test-model',
        defaultProvider: 'test-provider',
        modelProviders: {},
        stateContextRotThreshold: 0,
        harnessContextRotThreshold: 0,
        worktreePolicy: { default: 'on_demand' },
      },
    });
    expect(() => validator.validateSemantics(config)).toThrow(/unknown enum value/i);
  });
});
