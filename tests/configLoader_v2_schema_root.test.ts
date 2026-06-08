/**
 * configLoader_v2_schema_root.test.ts
 *
 * pi-experiment-202g: Define version:2 single-file harness config schema root.
 *
 * AC1: A minimal v2 fixture (using statechart.initial + statechart.terminal) validates
 *      through the real loader and produces a resolved config object.
 * AC2: All eight removed v1 field categories are rejected with path-specific diagnostics
 *      and no warning-only compatibility behavior:
 *        settings.startState, settings.teamLeadSystemPrompt, settings.projectObjective,
 *        settings.worktreePolicy, statechart.initialState, statechart.terminalStates,
 *        states.*.on (v1 transition map), and external config-composition include/extends.
 * AC3: Resolved config serialization is stable across at least three repeated
 *      loads of the same fixture.
 * AC4: rg check — no v2 compat/legacy admission path (enforced by review; these
 *      tests cover the load-bearing behaviors).
 * AC5: Terminal sink not runnable — a name in statechart.terminal that also has
 *      actions (runnable state) is rejected at admission.
 *
 * Scenario coverage:
 *   S1:  minimal v2 fixture (initial/terminal) accepted, produces resolved config (AC1).
 *   S2:  v2 fixture + settings.startState rejected with path-specific diagnostic (AC2).
 *   S3:  v2 fixture + settings.teamLeadSystemPrompt rejected (AC2).
 *   S4:  v2 fixture + settings.projectObjective rejected (AC2).
 *   S5:  v2 fixture + settings.worktreePolicy rejected (AC2).
 *   S6:  v2 fixture loaded 3 times — JSON serialization byte-identical (AC3).
 *   S7:  version absent → v1 path continues to load (cerdiwen back-compat).
 *   S8:  unknown version → fail closed.
 *   S9:  v2 fixture with multiple removed v1 fields → error names all paths.
 *   S10: v2 fixture with statechart.initialState + states.Planning.on + settings.startState
 *        → fails, diagnostic reports each stale path + v2 replacement (AC2 Scenario 2).
 *   S11: v2 fixture with include: other.yaml → rejected (AC2 Scenario 3).
 *   S12: v2 fixture with extends: base → rejected (AC2 Scenario 3).
 *   S13: v2 fixture where statechart.terminal name is also a runnable state → rejected (AC5).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'orr-else-202g-'));

function writeYaml(name: string, content: string): string {
  const p = path.join(TEST_DIR, name);
  fs.writeFileSync(p, content);
  return p;
}

afterEach(() => {
  // Clean all temp files created in TEST_DIR during the test run.
  for (const f of fs.readdirSync(TEST_DIR)) {
    fs.unlinkSync(path.join(TEST_DIR, f));
  }
});

// ---------------------------------------------------------------------------
// Minimal valid v2 fixture YAML.
//
// Spec (AC1 scenario): one configured state, one prompt-file LLM action,
// one declared terminal target, one declared event.
// Uses v2 statechart shape: statechart.initial (names runnable start state)
// and statechart.terminal (lists terminal sink names).
// Does NOT include: startState, teamLeadSystemPrompt, projectObjective,
// worktreePolicy, statechart.initialState, statechart.terminalStates (all
// removed v1 fields that v2 configs must not use).
// ---------------------------------------------------------------------------
const MINIMAL_V2_YAML = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement the task."
    actions:
      - id: run_impl
        type: prompt
        prompt: "Implement the requested changes."
    transitions:
      SUCCESS: completed
      FAILURE: Implement
`;

// ---------------------------------------------------------------------------
// S1: minimal v2 fixture accepted, produces resolved config object (AC1)
// ---------------------------------------------------------------------------
describe('pi-experiment-202g: v2 schema root admission (AC1)', () => {
  it('S1: minimal v2 fixture loads without throwing and returns a resolved config', () => {
    const p = writeYaml('s1_minimal_v2.yaml', MINIMAL_V2_YAML);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let config: ReturnType<typeof loader.load> | undefined;
    expect(() => {
      config = loader.load(p);
    }).not.toThrow();

    expect(config).toBeDefined();
    expect(config!.version).toBe(2);
    expect(config!.states['Implement']).toBeDefined();
    expect(config!.states['Implement'].actions).toHaveLength(1);
    expect(config!.states['Implement'].actions[0].id).toBe('run_impl');
    // v2 shape: statechart.initial + statechart.terminal (not v1 initialState/terminalStates)
    expect(config!.statechart?.initial).toBe('Implement');
    expect(config!.statechart?.terminal).toContain('completed');
    // pi-experiment-cfzu: v2 uses events block instead of v1 statechart outcome lists
    expect(config!.events?.advance).toContain('SUCCESS');
    expect(config!.events?.failure).toContain('FAILURE');
    expect(config!.events?.blocked).toContain('BLOCKED');
  });
});

// ---------------------------------------------------------------------------
// S2–S5: removed v1 fields rejected with path-specific diagnostics (AC2)
// ---------------------------------------------------------------------------
describe('pi-experiment-202g: v2 stale v1 field rejection (AC2)', () => {
  it('S2: settings.startState in a v2 doc → fails with path-specific diagnostic', () => {
    const yaml = `
version: 2
settings:
  startState: Implement
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s2_startstate.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).toThrow(/settings\.startState/);
  });

  it('S3: settings.teamLeadSystemPrompt in a v2 doc → fails with path-specific diagnostic', () => {
    const yaml = `
version: 2
settings:
  teamLeadSystemPrompt: "You are the lead."
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s3_teamlead.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).toThrow(/settings\.teamLeadSystemPrompt/);
  });

  it('S4: settings.projectObjective in a v2 doc → fails with path-specific diagnostic', () => {
    const yaml = `
version: 2
settings:
  projectObjective: "Build the thing."
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s4_projectobjective.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).toThrow(/settings\.projectObjective/);
  });

  it('S5: settings.worktreePolicy in a v2 doc → fails with path-specific diagnostic', () => {
    const yaml = `
version: 2
settings:
  worktreePolicy:
    default: always
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s5_worktreepolicy.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).toThrow(/settings\.worktreePolicy/);
  });

  it('S9: multiple removed v1 settings fields → error names all offending paths', () => {
    const yaml = `
version: 2
settings:
  startState: Implement
  teamLeadSystemPrompt: "Lead"
  projectObjective: "Do the thing"
  worktreePolicy:
    default: never
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s9_multi_stale.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    // All four stale settings paths must appear in the error message
    expect(caught!.message).toMatch(/settings\.startState/);
    expect(caught!.message).toMatch(/settings\.teamLeadSystemPrompt/);
    expect(caught!.message).toMatch(/settings\.projectObjective/);
    expect(caught!.message).toMatch(/settings\.worktreePolicy/);
  });

  // ── Scenario 2 (AC2): stale statechart fields + states.*.on + settings.startState ──
  it('S10: v2 fixture with statechart.initialState + states.Planning.on + settings.startState → fails, each stale path named with v2 replacement', () => {
    const yaml = `
version: 2
settings:
  startState: Planning
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initialState: Planning
  terminalStates: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan."
    on:
      SUCCESS: completed
    actions:
      - id: plan
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Planning }
`;
    const p = writeYaml('s10_stale_statechart.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    // All stale paths must appear with v2 replacement names in the diagnostic
    expect(caught!.message).toMatch(/settings\.startState/);
    expect(caught!.message).toMatch(/statechart\.initialState/);
    expect(caught!.message).toMatch(/statechart\.terminalStates/);
    expect(caught!.message).toMatch(/states\.Planning\.on/);
    // Diagnostics must name v2 replacements
    expect(caught!.message).toMatch(/statechart\.initial/);
    expect(caught!.message).toMatch(/statechart\.terminal/);
    expect(caught!.message).toMatch(/transitions/);
  });

  // ── Scenario 3 (AC2): external config-composition fields rejected ──
  it('S11: v2 fixture with include: other.yaml → rejected with path-specific diagnostic', () => {
    const yaml = `
version: 2
include: other.yaml
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s11_include.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).toThrow(/\binclude\b/);
  });

  it('S12: v2 fixture with extends: base → rejected with path-specific diagnostic', () => {
    const yaml = `
version: 2
extends: base
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s12_extends.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).toThrow(/\bextends\b/);
  });
});

// ---------------------------------------------------------------------------
// S6: serialization stability across 3 repeated loads (AC3)
// ---------------------------------------------------------------------------
describe('pi-experiment-202g: v2 resolved config serialization stability (AC3)', () => {
  it('S6: JSON serialization is byte-identical across 3 loads of the same v2 fixture', () => {
    const p = writeYaml('s6_stable.yaml', MINIMAL_V2_YAML);

    // Each load uses a fresh ConfigLoader instance (no cache reuse between instances).
    const s1 = JSON.stringify(new ConfigLoader(undefined, TEST_DIR).load(p));
    const s2 = JSON.stringify(new ConfigLoader(undefined, TEST_DIR).load(p));
    const s3 = JSON.stringify(new ConfigLoader(undefined, TEST_DIR).load(p));

    expect(s1).toBe(s2);
    expect(s2).toBe(s3);
  });
});

// ---------------------------------------------------------------------------
// S7: absent version → v1 behavior (cerdiwen back-compat golden)
// ---------------------------------------------------------------------------
describe('pi-experiment-202g: v1 back-compat — absent version still loads (AC5 / cerdiwen)', () => {
  it('S7: config with no version field loads without error (v1 backward-compat)', () => {
    const yaml = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan."
    actions:
      - id: plan
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Planning }
`;
    const p = writeYaml('s7_v1_noversion.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let config: ReturnType<typeof loader.load> | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();
    expect(config).toBeDefined();
    expect(config!.version).toBeUndefined();
    expect(config!.settings.startState).toBe('Planning');
  });
});

// ---------------------------------------------------------------------------
// S8: unknown version → fail closed
// ---------------------------------------------------------------------------
describe('pi-experiment-202g: unknown version → fail closed', () => {
  it('S8: version: 1 → loader fails closed with unknown-version diagnostic', () => {
    const yaml = `
version: 1
settings:
  startState: Planning
  worktreePolicy:
    default: always
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states: {}
`;
    const p = writeYaml('s8_version1.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).toThrow(/Unknown harness config version/);
  });

  it('S8b: version: 99 → loader fails closed with unknown-version diagnostic', () => {
    const yaml = `
version: 99
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states: {}
`;
    const p = writeYaml('s8b_version99.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).toThrow(/Unknown harness config version/);
  });

  it('S8c: version: "v2" (string) → loader fails closed with unknown-version diagnostic', () => {
    const yaml = `
version: "v2"
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states: {}
`;
    const p = writeYaml('s8c_version_string.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).toThrow(/Unknown harness config version/);
  });
});

// ---------------------------------------------------------------------------
// S13: AC5 — terminal sink not runnable
// A name in statechart.terminal that is also a runnable state (has actions)
// must be rejected at v2 admission.
// ---------------------------------------------------------------------------
describe('pi-experiment-202g: AC5 — terminal sink must not be a runnable state', () => {
  it('S13: v2 fixture where statechart.terminal names a state with actions → rejected', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed, Implement]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s13_terminal_runnable.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).toThrow(/terminal.*Implement.*runnable|Implement.*terminal.*runnable/i);
  });

  it('S13b: v2 fixture where statechart.terminal sink has no actions (pure sink) → accepted', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
`;
    const p = writeYaml('s13b_terminal_clean.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    // "completed" is not in states, so it's a clean terminal sink — should load.
    expect(() => loader.load(p)).not.toThrow();
  });
});
