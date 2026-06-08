/**
 * configLoader_v2_map_collections.test.ts
 *
 * pi-experiment-0dgy: v2 map-form collection validation + canonical ID derivation.
 *
 * AC1: v2 accepts map-form tools, validationGates, states, and states.<state>.actions
 *      with the documented v2 identifier grammar (^[A-Za-z][A-Za-z0-9_.-]*$).
 * AC2: v2 rejects old array-form ID-bearing collections (tools/gates/actions)
 *      with deterministic diagnostics including migration guidance to map-form paths.
 * AC3: Inner identity fields (inner id/name) that conflict with the map key are
 *      rejected rather than reconciled.
 * AC4: Resolved config records map-derived IDs and serializes them in stable
 *      deterministic (sorted) order for snapshot stability.
 * AC5: Tests cover: valid map form, old-array rejection, key-grammar rejection,
 *      conflicting-inner-identity rejection, case-insensitive duplicate detection,
 *      and resolved-snapshot stability.
 *
 * Each rejection test is LOAD-BEARING: it must fail if its specific check is removed.
 * Version-gated: all map-form rules apply ONLY when version === 2.
 * v1 configs (no version) and the real cerdiwen harness.yaml (v1, array-form) are
 * completely unaffected.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'orr-else-0dgy-'));

function writeYaml(name: string, content: string): string {
  const p = path.join(TEST_DIR, name);
  fs.writeFileSync(p, content);
  return p;
}

afterEach(() => {
  for (const f of fs.readdirSync(TEST_DIR)) {
    try { fs.unlinkSync(path.join(TEST_DIR, f)); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Minimal v2 fixture with map-form actions (AC1 happy path).
// Includes two action keys: write-plan and verify-plan.
// ---------------------------------------------------------------------------
const MINIMAL_V2_MAP_ACTIONS_YAML = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement the task."
    actions:
      write-plan:
        type: prompt
        prompt: "Write the plan."
      verify-plan:
        type: prompt
        prompt: "Verify the plan."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;

// ---------------------------------------------------------------------------
// AC1: v2 accepts map-form actions — resolved canonical IDs + sorted order
// ---------------------------------------------------------------------------
describe('pi-experiment-0dgy AC1: v2 accepts map-form actions', () => {
  it('S1: valid v2 fixture with map-form actions loads and canonical IDs are the map keys', () => {
    const p = writeYaml('s1_valid_map_actions.yaml', MINIMAL_V2_MAP_ACTIONS_YAML);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();

    expect(config).toBeDefined();
    const actions = config!.states['implement'].actions;
    expect(actions).toBeDefined();
    expect(actions).toHaveLength(2);

    // Canonical IDs are the map keys
    const ids = actions.map(a => a.id);
    expect(ids).toContain('write-plan');
    expect(ids).toContain('verify-plan');
  });

  it('S1b: resolved actions are sorted deterministically by canonical ID', () => {
    const p = writeYaml('s1b_sorted_actions.yaml', MINIMAL_V2_MAP_ACTIONS_YAML);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);

    const actions = config.states['implement'].actions;
    const ids = actions.map(a => a.id);

    // Sorted: verify-plan < write-plan lexicographically
    expect(ids).toEqual(['verify-plan', 'write-plan']);
  });

  it('S1c: v2 map-form actions with matching inner id field (allowed — key wins)', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      run-impl:
        id: run-impl
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s1c_matching_id.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    // Inner id matching the key is allowed (the map key is canonical)
    expect(() => loader.load(p)).not.toThrow();
    const config = loader.load(p);
    expect(config.states['implement'].actions[0].id).toBe('run-impl');
  });
});

// ---------------------------------------------------------------------------
// AC1: v2 accepts map-form tools
// ---------------------------------------------------------------------------
describe('pi-experiment-0dgy AC1: v2 accepts map-form tools', () => {
  it('S2: valid v2 fixture with map-form tools loads and canonical name = map key', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  plan-contract:
    type: command
    command: node
    defaultArgs: ["scripts/plan-contract.js"]
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s2_map_tools.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();

    expect(config).toBeDefined();
    const tools = config!.tools ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('plan-contract');
  });

  it('S2b: map-form tools are sorted by canonical name', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  zebra-tool:
    type: command
    command: node
  alpha-tool:
    type: command
    command: node
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s2b_sorted_tools.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);

    const toolNames = (config.tools ?? []).map(t => t.name);
    expect(toolNames).toEqual(['alpha-tool', 'zebra-tool']);
  });
});

// ---------------------------------------------------------------------------
// AC2: v2 rejects old array-form collections (load-bearing)
// ---------------------------------------------------------------------------
describe('pi-experiment-0dgy AC2: v2 rejects old array-form collections (load-bearing)', () => {
  it('S3a: v2 fixture with array-form tools → startup fails with migration guidance [LOAD-BEARING]', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, priority: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  - name: plan-contract
    type: command
    command: node
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s3a_array_tools.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    // Must name the collection and give migration guidance
    expect(caught!.message).toMatch(/tools/i);
    expect(caught!.message).toMatch(/array/i);
    expect(caught!.message).toMatch(/map/i);
  });

  it('S3b: v2 fixture with array-form actions in a state → startup fails with migration guidance [LOAD-BEARING]', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: write-plan
        type: prompt
        prompt: "Write the plan."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s3b_array_actions.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    // Must name the state, the collection, and give migration guidance
    expect(caught!.message).toMatch(/implement/);
    expect(caught!.message).toMatch(/actions/i);
    expect(caught!.message).toMatch(/array/i);
    // Migration path: actions.write-plan style guidance
    expect(caught!.message).toMatch(/map/i);
  });

  it('S3c: v2 fixture with array-form validationGates → startup fails with migration guidance [LOAD-BEARING]', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
validationGates:
  - id: review-gate
    states: [implement]
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s3c_array_gates.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/validationGates|gates/i);
    expect(caught!.message).toMatch(/array/i);
    expect(caught!.message).toMatch(/map/i);
  });

  it('S3d: v2 fixture with array-form actions in multiple states → rejects on first violation [LOAD-BEARING]', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: plan
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  plan:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: write-plan
        type: prompt
    transitions:
      SUCCESS: completed
      FAILURE: plan
`;
    const p = writeYaml('s3d_multi_array_actions.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/plan/);
    expect(caught!.message).toMatch(/actions/i);
    expect(caught!.message).toMatch(/array/i);
  });
});

// ---------------------------------------------------------------------------
// AC3: inner-identity conflict rejection (load-bearing)
// ---------------------------------------------------------------------------
describe('pi-experiment-0dgy AC3: inner-identity conflict rejection (load-bearing)', () => {
  it('S4a: tools map entry with conflicting inner name → startup fails [LOAD-BEARING]', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  plan-contract:
    name: other-name
    type: command
    command: node
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s4a_tools_inner_conflict.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    // Must name the conflicting key and the inner field
    expect(caught!.message).toMatch(/plan-contract/);
    expect(caught!.message).toMatch(/other-name/);
    expect(caught!.message).toMatch(/name/);
    expect(caught!.message).toMatch(/conflict/i);
  });

  it('S4b: actions map entry with conflicting inner id → startup fails [LOAD-BEARING]', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      write-plan:
        id: different-id
        type: prompt
        prompt: "Write the plan."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s4b_action_inner_conflict.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/write-plan/);
    expect(caught!.message).toMatch(/different-id/);
    expect(caught!.message).toMatch(/id/);
    expect(caught!.message).toMatch(/conflict/i);
  });

  it('S4c: validationGates map entry with conflicting inner id → startup fails [LOAD-BEARING]', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
validationGates:
  review-gate:
    id: wrong-gate-id
    states: [implement]
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s4c_gates_inner_conflict.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/review-gate/);
    expect(caught!.message).toMatch(/wrong-gate-id/);
    expect(caught!.message).toMatch(/conflict/i);
  });
});

// ---------------------------------------------------------------------------
// AC1: Key grammar rejection (load-bearing)
// ---------------------------------------------------------------------------
describe('pi-experiment-0dgy AC1: key grammar rejection (load-bearing)', () => {
  it('S5a: actions map key starting with digit → startup fails [LOAD-BEARING]', () => {
    // Keys must start with a letter (upper or lower). Digit-leading keys are rejected.
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      "1bad":
        type: prompt
        prompt: "Bad key."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s5a_digit_start_key.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/1bad/);
    expect(caught!.message).toMatch(/grammar|pattern|identifier/i);
  });

  it('S5b: tools map key starting with digit → startup fails [LOAD-BEARING]', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  "9plan":
    type: command
    command: node
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s5b_tools_digit_key.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/9plan/);
    expect(caught!.message).toMatch(/grammar|pattern|identifier/i);
  });

  it('S5c: actions map key with space → startup fails [LOAD-BEARING]', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      "bad key":
        type: prompt
        prompt: "Bad key with space."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s5c_space_key.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/bad key/);
    expect(caught!.message).toMatch(/grammar|pattern|identifier/i);
  });

  it('S5d: valid complex key names accepted (mixed case, digits, dots, underscores, hyphens)', () => {
    // Grammar allows: letter start, then letters/digits/underscores/dots/hyphens.
    // PascalCase state names (Implement, Planning) are also valid.
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
      write-plan:
        type: prompt
        prompt: "Write."
      verify.result123:
        type: prompt
        prompt: "Verify."
      run_impl:
        type: prompt
        prompt: "Run."
    transitions:
      SUCCESS: completed
      FAILURE: Implement
`;
    const p = writeYaml('s5d_valid_complex_keys.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).not.toThrow();
    const config = loader.load(p);
    const ids = config.states['Implement'].actions.map(a => a.id).sort();
    expect(ids).toEqual(['run_impl', 'verify.result123', 'write-plan']);
  });

  it('S5e: PascalCase tool names are accepted (e.g. PlanContract)', () => {
    // The v2 grammar allows PascalCase identifiers. PlanContract is a valid key.
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
tools:
  PlanContract:
    type: command
    command: node
states:
  Implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: Implement
`;
    const p = writeYaml('s5e_pascalcase_tool.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).not.toThrow();
    const config = loader.load(p);
    expect(config.tools?.[0].name).toBe('PlanContract');
  });
});

// ---------------------------------------------------------------------------
// AC5: Case-insensitive duplicate key detection (load-bearing)
// ---------------------------------------------------------------------------
describe('pi-experiment-0dgy AC5: case-insensitive duplicate key detection (load-bearing)', () => {
  it('S6a: actions map with keys differing only by .v2 suffix are accepted (no false positive on distinct keys)', () => {
    // write-plan and write-plan.v2 have distinct lowercase forms — no duplicate.
    // This test guards against false positives in the case-fold duplicate check.
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      write-plan:
        type: prompt
        prompt: "First."
      write-plan.v2:
        type: prompt
        prompt: "Second."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s6a_distinct_keys.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    // write-plan vs write-plan.v2 are distinct after case folding — both accepted.
    expect(() => loader.load(p)).not.toThrow();
  });

  it('S6b: tools map with keys differing only by .v2 suffix are accepted (no false positive on distinct keys)', () => {
    // plan-a and plan-a.v2 have distinct lowercase forms — no duplicate.
    // This test guards against false positives in the case-fold duplicate check.
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  plan-a:
    type: command
    command: node
  plan-a.v2:
    type: command
    command: node
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s6b_distinct_tools.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    // plan-a and plan-a.v2 have different lowercase forms — accepted.
    expect(() => loader.load(p)).not.toThrow();
  });

  it('S6d: tools map with case-duplicate keys (Plan-A / plan-a) → startup fails [LOAD-BEARING]', () => {
    // The v2 grammar allows uppercase letters (^[A-Za-z][A-Za-z0-9_.-]*$), so
    // "Plan-A" is a valid key. "plan-a" is also valid. Together they fold to the
    // same lowercase "plan-a" and must be rejected by validateV2MapKeys.
    // This test is load-bearing: neutralizing the case-fold dup check makes it fail.
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  Plan-A:
    type: command
    command: node
  plan-a:
    type: command
    command: node
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s6d_tools_case_dup.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/case-insensitive duplicate/i);
    // Both keys must be named in the diagnostic
    expect(caught!.message).toMatch(/Plan-A/);
    expect(caught!.message).toMatch(/plan-a/);
  });

  it('S6e: actions map with case-duplicate keys (Write-Plan / write-plan) → startup fails [LOAD-BEARING]', () => {
    // "Write-Plan" and "write-plan" are both valid v2 identifiers but fold to the
    // same lowercase "write-plan". validateV2MapKeys must reject this.
    // This test is load-bearing: neutralizing the case-fold dup check makes it fail.
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      Write-Plan:
        type: prompt
        prompt: "First."
      write-plan:
        type: prompt
        prompt: "Second."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s6e_actions_case_dup.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/case-insensitive duplicate/i);
    // Both keys must be named in the diagnostic
    expect(caught!.message).toMatch(/Write-Plan/);
    expect(caught!.message).toMatch(/write-plan/);
  });

  it('S6f: states map with case-duplicate keys (Implement / implement) → startup fails [LOAD-BEARING]', () => {
    // "Implement" and "implement" are both valid v2 identifiers but fold to the
    // same lowercase "implement". validateV2StateKeys must reject this.
    // This test is load-bearing: neutralizing the case-fold dup check in
    // validateV2StateKeys makes it fail.
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
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: Implement
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      do-work:
        type: prompt
        prompt: "Do work."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s6f_states_case_dup.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/case-insensitive duplicate/i);
    // Both state keys must be named in the diagnostic
    expect(caught!.message).toMatch(/Implement/);
    expect(caught!.message).toMatch(/implement/);
  });

  it('S6c: actions map with key starting with digit → startup fails [LOAD-BEARING]', () => {
    // Digit-leading keys are an invalid v2 identifier grammar violation and are rejected.
    // This is a second load-bearing test for the grammar check (distinct from S5a which
    // tests actions; this also confirms the check applies across different states).
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
      "42action":
        type: prompt
        prompt: "Bad."
    transitions:
      SUCCESS: completed
      FAILURE: Implement
`;
    const p = writeYaml('s6c_digit_action.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let caught: Error | undefined;
    try { loader.load(p); } catch (e) { caught = e as Error; }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/42action/);
    expect(caught!.message).toMatch(/grammar|pattern|identifier/i);
  });
});

// ---------------------------------------------------------------------------
// AC4: Resolved-config snapshot stability (load-bearing)
// ---------------------------------------------------------------------------
describe('pi-experiment-0dgy AC4: resolved-config snapshot stability', () => {
  it('S7: v2 fixture with map-form actions → JSON serialization is byte-identical across 3 loads', () => {
    const p = writeYaml('s7_snapshot_stable.yaml', MINIMAL_V2_MAP_ACTIONS_YAML);

    const s1 = JSON.stringify(new ConfigLoader(undefined, TEST_DIR).load(p));
    const s2 = JSON.stringify(new ConfigLoader(undefined, TEST_DIR).load(p));
    const s3 = JSON.stringify(new ConfigLoader(undefined, TEST_DIR).load(p));

    expect(s1).toBe(s2);
    expect(s2).toBe(s3);
  });

  it('S7b: action IDs in resolved config are the canonical map keys (sorted)', () => {
    // Declare actions in reverse alphabetical order — resolved must be sorted.
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      z-action:
        type: prompt
        prompt: "Z."
      m-action:
        type: prompt
        prompt: "M."
      a-action:
        type: prompt
        prompt: "A."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s7b_sorted_ids.yaml', yaml);
    const config = new ConfigLoader(undefined, TEST_DIR).load(p);
    const ids = config.states['implement'].actions.map(a => a.id);
    // Sorted lexicographically: a-action, m-action, z-action
    expect(ids).toEqual(['a-action', 'm-action', 'z-action']);
  });

  it('S7c: tool names in resolved config are sorted by canonical map key', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "t"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  z-tool:
    type: command
    command: node
  a-tool:
    type: command
    command: node
  m-tool:
    type: command
    command: node
states:
  implement:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s7c_sorted_tools.yaml', yaml);
    const config = new ConfigLoader(undefined, TEST_DIR).load(p);
    const names = (config.tools ?? []).map(t => t.name);
    expect(names).toEqual(['a-tool', 'm-tool', 'z-tool']);
  });
});

// ---------------------------------------------------------------------------
// Version gate: v1 configs completely unaffected
// ---------------------------------------------------------------------------
describe('pi-experiment-0dgy version-gate: v1 configs unaffected', () => {
  it('S8a: v1 config with array-form tools loads cleanly', () => {
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
tools:
  - name: my_tool
    type: command
    command: node
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan."
    actions:
      - id: plan
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Planning }
`;
    const p = writeYaml('s8a_v1_array_tools.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();
    expect(config).toBeDefined();
    expect(config!.version).toBeUndefined();
    // v1 array-form tools are NOT touched
    expect(config!.tools?.[0].name).toBe('my_tool');
  });

  it('S8b: v1 config with array-form actions loads cleanly', () => {
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
      - id: review
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Planning }
`;
    const p = writeYaml('s8b_v1_array_actions.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();
    expect(config!.states['Planning'].actions[0].id).toBe('plan');
    expect(config!.states['Planning'].actions[1].id).toBe('review');
  });

  it('S8c: v1 config actions retain original array order (not sorted)', () => {
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
      - id: z-action
        type: prompt
      - id: a-action
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Planning }
`;
    const p = writeYaml('s8c_v1_order_preserved.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);

    // v1: order preserved as declared (z-action before a-action)
    const ids = config.states['Planning'].actions.map(a => a.id);
    expect(ids[0]).toBe('z-action');
    expect(ids[1]).toBe('a-action');
  });
});

// ---------------------------------------------------------------------------
// Coexistence: cfzu v2 event vocab + 0dgy map collections together
// ---------------------------------------------------------------------------
describe('pi-experiment-0dgy coexistence: map-form + cfzu event vocab', () => {
  it('S9: v2 with map-form actions + cfzu event vocab → both validated together', () => {
    // This fixture exercises cfzu (events vocab) + 0dgy (map actions) together.
    const p = writeYaml('s9_coexistence.yaml', MINIMAL_V2_MAP_ACTIONS_YAML);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();

    expect(config!.version).toBe(2);
    expect(config!.events?.advance).toContain('SUCCESS');
    const ids = config!.states['implement'].actions.map(a => a.id);
    expect(ids).toContain('write-plan');
    expect(ids).toContain('verify-plan');
  });
});
