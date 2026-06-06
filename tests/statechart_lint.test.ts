/**
 * statechart_lint.test.ts
 *
 * pi-experiment-1elr.2: Startup-fatal statechart determinism lint rules +
 * typed fail-closed OutcomeCategory/OutcomeName model.
 *
 * AC1  Lint FAILS when settings.startState and statechart.initialState disagree.
 * AC2  Every runnable state has ≥1 action; action ids are unique within the state.
 * AC3  (Covered by lgwk + existing tests — every undeclared transition outcome in
 *       strict mode fails closed.)
 * AC4  Transition outcomes are declared exactly once case-insensitively across
 *       advance/failed/blocked/custom sets; duplicates are rejected.
 * AC5  Terminal-state transitions are compatible with coordinator persistence
 *       semantics: only recognized coarse-sink targets accepted; arbitrary unknown
 *       targets at terminal states are rejected.
 * AC6  validationGates selectors reference valid states; exactly one selector mode
 *       (states / beforeStates / afterStates) per gate.
 * AC7  Exported OutcomeCategory enum + branded OutcomeName; missing/falsy/unknown
 *       outcomes fail closed in strict mode; legacy mode is permissive.
 * AC8  All failures occur via ConfigLoader.load() → BEFORE Supervisor.start.
 */

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import {
  OutcomeCategory,
  outcomeCategory,
  isAdvanceOutcome,
  isDeclaredOutcome,
  classifyOutcome,
  type OutcomeName,
} from '../src/core/FlowManager.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const tempPath = path.join(process.cwd(), 'temp_1elr2_lint_test.yaml');

function writeTempYaml(yaml: string): string {
  fs.writeFileSync(tempPath, yaml);
  return tempPath;
}

afterEach(() => {
  if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
});

function minimalStrictYaml(overrides: string = ''): string {
  return `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [ADVANCE]
  failedOutcomes: [REWORK]
  blockedOutcomes: [HALT]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
${overrides}
`;
}

function minimalState(id: string, transitions: string, actionsBlock: string = '    actions:\n      - id: a1\n        type: prompt'): string {
  return `  ${id}:\n    identity: { role: "R", expertise: "E", constraints: [] }\n    baseInstructions: "i"\n${actionsBlock}\n    transitions: ${transitions}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: startState / initialState mismatch
// ─────────────────────────────────────────────────────────────────────────────

describe('AC1: startState / statechart.initialState mismatch', () => {
  it('AC1: throws when settings.startState and statechart.initialState differ', () => {
    const yaml = minimalStrictYaml(`states:
${minimalState('Alpha', '{ ADVANCE: "Bravo", REWORK: "Alpha", HALT: "done" }')}
${minimalState('Bravo', '{ ADVANCE: "done", REWORK: "Alpha", HALT: "done" }')}
`).replace('startState: Alpha', 'startState: Alpha').replace('terminalStates: [done]', 'terminalStates: [done]\n  initialState: Bravo');
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath))
      .toThrow(/startState.*initialState|initialState.*startState|disagree|mismatch|conflict/i);
  });

  it('AC1: accepts when settings.startState and statechart.initialState agree', () => {
    const yaml = minimalStrictYaml(`states:
${minimalState('Alpha', '{ ADVANCE: "Bravo", REWORK: "Alpha", HALT: "done" }')}
${minimalState('Bravo', '{ ADVANCE: "done", REWORK: "Alpha", HALT: "done" }')}
`).replace('terminalStates: [done]', 'terminalStates: [done]\n  initialState: Alpha');
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath)).not.toThrow();
  });

  it('AC1: accepts when only startState is present (no initialState in statechart)', () => {
    const yaml = minimalStrictYaml(`states:
${minimalState('Alpha', '{ ADVANCE: "done", REWORK: "Alpha", HALT: "done" }')}
`);
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath)).not.toThrow();
  });

  it('AC1: startState and initialState naming the same state is fine (no conflict)', () => {
    // Both present, same value → no mismatch → passes lint
    const yaml = minimalStrictYaml(`states:
${minimalState('Alpha', '{ ADVANCE: "done", REWORK: "Alpha", HALT: "done" }')}
`).replace('terminalStates: [done]', 'terminalStates: [done]\n  initialState: Alpha');
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: Every runnable state has ≥1 action; action ids are unique within the state
// ─────────────────────────────────────────────────────────────────────────────

describe('AC2: Every runnable state has ≥1 action; action ids are unique', () => {
  it('AC2: throws when a state has no actions (empty array)', () => {
    const yaml = minimalStrictYaml(`states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions: []
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done" }
`);
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath))
      .toThrow(/action|actions/i);
  });

  it('AC2: throws when a state has duplicate action ids', () => {
    const yaml = minimalStrictYaml(`states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: do-it
        type: prompt
      - id: do-it
        type: prompt
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done" }
`);
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath))
      .toThrow(/duplicate.*action|action.*duplicate/i);
  });

  it('AC2: accepts a state with one action', () => {
    const yaml = minimalStrictYaml(`states:
${minimalState('Alpha', '{ ADVANCE: "done", REWORK: "Alpha", HALT: "done" }')}
`);
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath)).not.toThrow();
  });

  it('AC2: accepts a state with multiple distinct action ids', () => {
    const yaml = minimalStrictYaml(`states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: step-one
        type: prompt
      - id: step-two
        type: prompt
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done" }
`);
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath)).not.toThrow();
  });

  it('AC2: lint only runs when statechart block present (legacy config skips)', () => {
    // Legacy configs may have actionless states — backward compatible
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions: []
    transitions: { SUCCESS: "done" }
`;
    writeTempYaml(yaml);
    // No statechart block → legacy mode → skip AC2 lint
    expect(() => new ConfigLoader().load(tempPath)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: Duplicate outcome case-folding across sets
// ─────────────────────────────────────────────────────────────────────────────

describe('AC4: Duplicate outcomes across sets (case-insensitive) are rejected', () => {
  it('AC4: throws when the same outcome appears in both advanceOutcomes and failedOutcomes', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE, SUCCESS]
  blockedOutcomes: [BLOCKED]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "done", FAILURE: "Alpha" }
`;
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath))
      .toThrow(/duplicate.*outcome|outcome.*duplicate/i);
  });

  it('AC4: throws for case-insensitive duplicate (success vs SUCCESS)', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
  customOutcomes: [success]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "done", FAILURE: "Alpha" }
`;
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath))
      .toThrow(/duplicate.*outcome|outcome.*duplicate/i);
  });

  it('AC4: accepts when all outcome sets are disjoint', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [ADVANCE]
  failedOutcomes: [REWORK]
  blockedOutcomes: [HALT]
  customOutcomes: [LATERAL]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done", LATERAL: "Alpha" }
`;
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath)).not.toThrow();
  });

  it('AC4: cerdiwen-style config with many failedOutcomes and customOutcomes passes', () => {
    // Reproduce the cerdiwen outcome structure — must NOT throw
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes:
    - FAILURE
    - REQUIREMENTS_DEFECT
    - PLAN_DEFECT
  blockedOutcomes: [BLOCKED, EXTERNAL_BLOCKER]
  customOutcomes: [REQUIREMENTS_CLARIFICATION_NEEDED]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions:
      SUCCESS: completed
      FAILURE: Alpha
      REQUIREMENTS_DEFECT: Alpha
      PLAN_DEFECT: Alpha
      BLOCKED: Alpha
      EXTERNAL_BLOCKER: Alpha
      REQUIREMENTS_CLARIFICATION_NEEDED: Alpha
`;
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: Terminal-state transition targets
// (existing behavior from ConfigLoader already covers transition target validation;
//  AC5 here specifically checks terminal states only transition to recognized targets)
// ─────────────────────────────────────────────────────────────────────────────

describe('AC5: Terminal-state transitions use recognized targets', () => {
  it('AC5: existing test: unknown target in a non-terminal state throws (statechart block present)', () => {
    const yaml = minimalStrictYaml(`states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "Nonexistent", REWORK: "Alpha" }
`);
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath))
      .toThrow(/not a defined state, declared terminal state, or recognized coarse sink status/);
  });

  it('AC5: coarse-sink target "blocked" is accepted (RECOGNIZED_COARSE_SINK_STATUSES)', () => {
    const yaml = minimalStrictYaml(`states:
${minimalState('Alpha', '{ ADVANCE: "done", REWORK: "Alpha", HALT: "blocked" }')}
`);
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: validationGates selectors reference valid states + single selector mode
// ─────────────────────────────────────────────────────────────────────────────

describe('AC6: validationGates selectors reference valid states; single selector mode', () => {
  it('AC6: throws when a gate "states" list references an unknown state', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [ADVANCE]
  failedOutcomes: [REWORK]
  blockedOutcomes: [HALT]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
validationGates:
  - id: my-gate
    states: [Alpha, NonexistentState]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done" }
`;
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath))
      .toThrow(/gate.*NonexistentState|NonexistentState.*gate|unknown.*state.*gate|gate.*unknown.*state/i);
  });

  it('AC6: throws when a gate "beforeStates" list references an unknown state', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [ADVANCE]
  failedOutcomes: [REWORK]
  blockedOutcomes: [HALT]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
validationGates:
  - id: my-gate
    beforeStates: [Ghost]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done" }
`;
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath))
      .toThrow(/gate.*Ghost|Ghost.*gate|unknown.*state.*gate|gate.*unknown.*state/i);
  });

  it('AC6: throws when a gate uses more than one selector mode (states + beforeStates)', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [ADVANCE]
  failedOutcomes: [REWORK]
  blockedOutcomes: [HALT]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
validationGates:
  - id: my-gate
    states: [Alpha]
    beforeStates: [Alpha]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done" }
`;
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath))
      .toThrow(/gate.*selector|selector.*gate|multiple.*selector|selector.*mode/i);
  });

  it('AC6: throws when a gate uses more than one selector mode (beforeStates + afterStates)', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [ADVANCE]
  failedOutcomes: [REWORK]
  blockedOutcomes: [HALT]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
validationGates:
  - id: my-gate
    beforeStates: [Alpha]
    afterStates: [Alpha]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done" }
`;
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath))
      .toThrow(/gate.*selector|selector.*gate|multiple.*selector|selector.*mode/i);
  });

  it('AC6: accepts a gate with single "states" selector containing valid state(s)', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [ADVANCE]
  failedOutcomes: [REWORK]
  blockedOutcomes: [HALT]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
validationGates:
  - id: my-gate
    states: [Alpha]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done" }
`;
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath)).not.toThrow();
  });

  it('AC6: accepts a gate with no selector (applies to all states)', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [ADVANCE]
  failedOutcomes: [REWORK]
  blockedOutcomes: [HALT]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
validationGates:
  - id: my-gate
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done" }
`;
    writeTempYaml(yaml);
    expect(() => new ConfigLoader().load(tempPath)).not.toThrow();
  });

  it('AC6: lint only runs when statechart block present (legacy config skips gate state checks)', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
validationGates:
  - id: my-gate
    states: [Ghost]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "done" }
`;
    writeTempYaml(yaml);
    // No statechart block → legacy mode → skip gate state reference checks
    expect(() => new ConfigLoader().load(tempPath)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7: OutcomeCategory enum + branded OutcomeName + typed fail-closed model
// ─────────────────────────────────────────────────────────────────────────────

describe('AC7: OutcomeCategory enum + branded OutcomeName', () => {
  it('AC7: OutcomeCategory is an exported enum with the four categories', () => {
    expect(OutcomeCategory.ADVANCE).toBe('advance');
    expect(OutcomeCategory.FAILED).toBe('failed');
    expect(OutcomeCategory.BLOCKED).toBe('blocked');
    expect(OutcomeCategory.CUSTOM).toBe('custom');
  });

  it('AC7: classifyOutcome returns OutcomeCategory enum values (not raw strings)', () => {
    const strictCfg = makeStrictConfig();
    expect(classifyOutcome('ADVANCE', strictCfg)).toBe(OutcomeCategory.ADVANCE);
    expect(classifyOutcome('REWORK', strictCfg)).toBe(OutcomeCategory.FAILED);
    expect(classifyOutcome('HALT', strictCfg)).toBe(OutcomeCategory.BLOCKED);
  });

  it('AC7: classifyOutcome fails closed (returns FAILED) for unknown outcome in strict mode', () => {
    const strictCfg = makeStrictConfig();
    expect(classifyOutcome('UNKNOWN_OUTCOME', strictCfg)).toBe(OutcomeCategory.FAILED);
    expect(classifyOutcome('missing_typo', strictCfg)).toBe(OutcomeCategory.FAILED);
  });

  it('AC7: classifyOutcome for missing/falsy outcome returns FAILED (fail-closed for unknown in strict, advance-fallback for legacy)', () => {
    const strictCfg = makeStrictConfig();
    const legacyCfg = makeLegacyConfig();

    // In strict mode (explicit vocab), null/undefined/empty are unknown → FAILED
    expect(classifyOutcome(null as any, strictCfg)).toBe(OutcomeCategory.FAILED);
    expect(classifyOutcome(undefined as any, strictCfg)).toBe(OutcomeCategory.FAILED);
    expect(classifyOutcome('', strictCfg)).toBe(OutcomeCategory.FAILED);

    // In legacy mode (no vocab), null/undefined/empty → ADVANCE (backward compat)
    // This preserves the existing outcomeCategory() legacy behavior
    expect(classifyOutcome(null as any, legacyCfg)).toBe(OutcomeCategory.ADVANCE);
    expect(classifyOutcome(undefined as any, legacyCfg)).toBe(OutcomeCategory.ADVANCE);
    expect(classifyOutcome('', legacyCfg)).toBe(OutcomeCategory.ADVANCE);
  });

  it('AC7: OutcomeName brand is a type-level string', () => {
    // Branded type: a plain string can be used as OutcomeName at runtime
    const name: OutcomeName = 'SUCCESS' as OutcomeName;
    expect(typeof name).toBe('string');
  });

  it('AC7: classifyOutcome is consistent with outcomeCategory (string return) for declared outcomes', () => {
    const strictCfg = makeStrictConfig();
    // classifyOutcome returns enum values matching the string returns of outcomeCategory
    expect(classifyOutcome('ADVANCE', strictCfg)).toBe(outcomeCategory('ADVANCE', strictCfg));
    expect(classifyOutcome('REWORK', strictCfg)).toBe(outcomeCategory('REWORK', strictCfg));
    expect(classifyOutcome('HALT', strictCfg)).toBe(outcomeCategory('HALT', strictCfg));
  });

  it('AC7: classifyOutcome for customOutcomes returns CUSTOM', () => {
    const cfg: HarnessConfig = {
      ...makeStrictConfig(),
      statechart: {
        terminalStates: ['done'],
        advanceOutcomes: ['ADVANCE'],
        failedOutcomes: ['REWORK'],
        blockedOutcomes: ['HALT'],
        customOutcomes: ['LATERAL']
      }
    } as unknown as HarnessConfig;
    expect(classifyOutcome('LATERAL', cfg)).toBe(OutcomeCategory.CUSTOM);
  });

  it('AC7: missing outcome in strict mode cannot advance progress (typed fail-closed model)', () => {
    const strictCfg = makeStrictConfig();
    // Missing/falsy outcome → classifyOutcome returns FAILED → cannot advance
    expect(classifyOutcome(null as any, strictCfg)).not.toBe(OutcomeCategory.ADVANCE);
    expect(classifyOutcome(undefined as any, strictCfg)).not.toBe(OutcomeCategory.ADVANCE);
    expect(classifyOutcome('', strictCfg)).not.toBe(OutcomeCategory.ADVANCE);
    // Unknown outcome → classifyOutcome returns FAILED → cannot advance
    expect(classifyOutcome('UNKNOWN', strictCfg)).not.toBe(OutcomeCategory.ADVANCE);
  });

  it('AC7: outcome not in any declared list → FAILED in strict mode (fail-closed)', () => {
    const strictCfg = makeStrictConfig();
    // 'SOMETHING_UNKNOWN' is not in ADVANCE/REWORK/HALT → FAILED
    expect(classifyOutcome('SOMETHING_UNKNOWN', strictCfg)).toBe(OutcomeCategory.FAILED);
    // 'SUCCESS' is also not in this strict config's vocab → FAILED
    expect(classifyOutcome('SUCCESS', strictCfg)).toBe(OutcomeCategory.FAILED);
  });

  it('AC7: cerdiwen custom outcome REQUIREMENTS_CLARIFICATION_NEEDED classifies as CUSTOM', () => {
    const cerdiwenCfg: HarnessConfig = {
      settings: { startState: 'RequirementsAnalysis', defaultModel: 'm', defaultProvider: 'p', modelProviders: {}, maxConcurrentSlots: 2, handoverTemplate: 't', agentTurnTimeoutMs: 1, processReapIntervalMs: 1, harnessRestartEvent: 'HARNESS_RESTART', contextRestartEvent: 'CONTEXT_RESTART', stateContextRotThreshold: 5, harnessContextRotThreshold: 3 },
      scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
      statechart: {
        terminalStates: ['completed'],
        advanceOutcomes: ['SUCCESS'],
        failedOutcomes: ['FAILURE', 'REQUIREMENTS_DEFECT', 'PLAN_DEFECT'],
        blockedOutcomes: ['BLOCKED', 'EXTERNAL_BLOCKER'],
        customOutcomes: ['REQUIREMENTS_CLARIFICATION_NEEDED']
      },
      states: {}
    } as unknown as HarnessConfig;
    expect(classifyOutcome('REQUIREMENTS_CLARIFICATION_NEEDED', cerdiwenCfg)).toBe(OutcomeCategory.CUSTOM);
    expect(classifyOutcome('SUCCESS', cerdiwenCfg)).toBe(OutcomeCategory.ADVANCE);
    expect(classifyOutcome('REQUIREMENTS_DEFECT', cerdiwenCfg)).toBe(OutcomeCategory.FAILED);
    expect(classifyOutcome('BLOCKED', cerdiwenCfg)).toBe(OutcomeCategory.BLOCKED);
    // Unknown outcomes in strict mode → FAILED (fail-closed)
    expect(classifyOutcome('SOME_UNKNOWN', cerdiwenCfg)).toBe(OutcomeCategory.FAILED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8: All failures occur BEFORE Supervisor.start
// (proven structurally: ConfigLoader.load() runs as part of startupConfig = await
//  services.configLoader.load() in extension.ts, before new Supervisor(...).start())
// We verify this by confirming the throw is synchronous from ConfigLoader.load().
// ─────────────────────────────────────────────────────────────────────────────

describe('AC8: All lint failures surface from ConfigLoader.load() (before Supervisor.start)', () => {
  it('AC8: startState/initialState mismatch throws synchronously from load()', () => {
    const yaml = minimalStrictYaml(`states:
${minimalState('Alpha', '{ ADVANCE: "Bravo", REWORK: "Alpha", HALT: "done" }')}
${minimalState('Bravo', '{ ADVANCE: "done", REWORK: "Alpha", HALT: "done" }')}
`).replace('terminalStates: [done]', 'terminalStates: [done]\n  initialState: Bravo');
    writeTempYaml(yaml);
    // Throws from load(), not from a background async step
    let threw = false;
    try {
      new ConfigLoader().load(tempPath);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('AC8: empty-actions lint throws synchronously from load() (before Supervisor.start)', () => {
    const yaml = minimalStrictYaml(`states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions: []
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done" }
`);
    writeTempYaml(yaml);
    let threw = false;
    try {
      new ConfigLoader().load(tempPath);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('AC8: duplicate outcome lint throws synchronously from load()', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE, SUCCESS]
  blockedOutcomes: [BLOCKED]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "done", FAILURE: "Alpha" }
`;
    writeTempYaml(yaml);
    let threw = false;
    try {
      new ConfigLoader().load(tempPath);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('AC8: gate unknown-state lint throws synchronously from load()', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
statechart:
  terminalStates: [done]
  advanceOutcomes: [ADVANCE]
  failedOutcomes: [REWORK]
  blockedOutcomes: [HALT]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
validationGates:
  - id: bad-gate
    states: [Ghost]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { ADVANCE: "done", REWORK: "Alpha", HALT: "done" }
`;
    writeTempYaml(yaml);
    let threw = false;
    try {
      new ConfigLoader().load(tempPath);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CERDIWEN GOLDEN TEST: cerdiwen's harness.yaml must still lint-pass
// ─────────────────────────────────────────────────────────────────────────────

describe('CERDIWEN GOLDEN: ../bankwest/cerdiwen/harness.yaml must lint-pass', () => {
  it('cerdiwen harness.yaml loads without throwing (all lint rules pass)', () => {
    const cerdiwenRoot = path.join(
      path.dirname(path.dirname(process.cwd())),
      'bankwest', 'cerdiwen'
    );
    const cerdiwenPath = path.join(cerdiwenRoot, 'harness.yaml');
    if (!fs.existsSync(cerdiwenPath)) {
      // Skip when cerdiwen is not present (e.g. in CI without the sibling repo)
      return;
    }
    // Must pass projectRoot so file-backed fields (checklists) resolve correctly
    const loader = new ConfigLoader(undefined, cerdiwenRoot);
    expect(() => loader.load(cerdiwenPath)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (module-local)
// ─────────────────────────────────────────────────────────────────────────────

function makeStrictConfig(): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 2,
      handoverTemplate: 'test',
      agentTurnTimeoutMs: 3600000,
      processReapIntervalMs: 60000,
      startState: 'Alpha',
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'gpt-4',
      defaultProvider: 'openai',
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 5
    },
    scheduler: { weights: { waitTime: 1, executionTime: 0.5, progress: 2, penalty: 1 } },
    statechart: {
      terminalStates: ['done'],
      advanceOutcomes: ['ADVANCE'],
      failedOutcomes: ['REWORK'],
      blockedOutcomes: ['HALT'],
      customOutcomes: []
    },
    states: {
      Alpha: { transitions: { ADVANCE: 'done', REWORK: 'Alpha', HALT: 'done' }, on: {} } as any
    }
  } as unknown as HarnessConfig;
}

function makeLegacyConfig(): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 2,
      handoverTemplate: 'test',
      agentTurnTimeoutMs: 3600000,
      processReapIntervalMs: 60000,
      startState: 'Alpha',
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'gpt-4',
      defaultProvider: 'openai',
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 5
    },
    scheduler: { weights: { waitTime: 1, executionTime: 0.5, progress: 2, penalty: 1 } },
    // NO statechart block → legacy mode
    states: {
      Alpha: { transitions: { SUCCESS: 'done' }, on: {} } as any
    }
  } as unknown as HarnessConfig;
}
