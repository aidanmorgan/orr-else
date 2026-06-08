/**
 * configLoader_v2_adapter_worktree_rejection.test.ts
 *
 * pi-experiment-ux5e: Reject configurable worker/workspace/worktree options in v2 config.
 *
 * In v2, tmux workers and isolated git worktrees are MANDATORY — not configurable.
 * Any field that tries to configure worker adapters, workspace adapters, backlog
 * adapters, worktree policy, or per-state worktree overrides MUST be rejected at
 * config load time with a clear diagnostic.
 *
 * AC1: v2 schema admits teammate concurrency (runtime.teammates) but no
 *      worker/workspace/backlog adapter selection fields.
 * AC2: v2 schema rejects harness-wide worktree policy (runtime.worktreePolicy)
 *      and per-state worktree override fields (states.*.provisionWorktree).
 * AC3: Diagnostics state tmux workers and isolated git worktrees are mandatory
 *      framework behavior.
 * AC4: Resolved v2 config has no adapter/worktree policy fields that
 *      implementation code could branch on.
 * AC5: Tests cover adapter rejection, worktree policy rejection, per-state
 *      override rejection, valid concurrency, and resolved-config absence of
 *      adapter knobs.
 *
 * VERSION GATE: All rejections are v2-only (version: 2).
 * v1 configs (including cerdiwen) are UNAFFECTED.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'orr-else-ux5e-'));

function writeYaml(name: string, content: string): string {
  const p = path.join(TEST_DIR, name);
  fs.writeFileSync(p, content);
  return p;
}

afterEach(() => {
  for (const f of fs.readdirSync(TEST_DIR)) {
    fs.unlinkSync(path.join(TEST_DIR, f));
  }
});

// ---------------------------------------------------------------------------
// Shared minimal v2 base (no adapter/worktree fields).
// Used as a template for fixtures that add the forbidden fields.
// ---------------------------------------------------------------------------
const MINIMAL_V2_BASE = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implementation
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implementation:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement the task."
    actions:
      run_impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: Implementation
`;

// ---------------------------------------------------------------------------
// AC1 / Scenario 1: runtime.adapters.worker + runtime.adapters.workspace rejected
// ---------------------------------------------------------------------------
describe('pi-experiment-ux5e: AC1 — runtime.adapters.worker and runtime.adapters.workspace rejected', () => {
  it('rejects runtime.adapters.worker: docker in a v2 fixture', () => {
    const yaml = MINIMAL_V2_BASE + `
runtime:
  adapters:
    worker: docker
`;
    const p = writeYaml('adapter_worker.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let err: Error | undefined;
    try { loader.load(p); } catch (e) { err = e as Error; }

    expect(err).toBeDefined();
    expect(err!.message).toMatch(/runtime\.adapters\.worker/);
    // AC3: diagnostic must mention tmux/mandatory
    expect(err!.message).toMatch(/tmux/i);
  });

  it('rejects runtime.adapters.workspace: projectRoot in a v2 fixture', () => {
    const yaml = MINIMAL_V2_BASE + `
runtime:
  adapters:
    workspace: projectRoot
`;
    const p = writeYaml('adapter_workspace.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let err: Error | undefined;
    try { loader.load(p); } catch (e) { err = e as Error; }

    expect(err).toBeDefined();
    expect(err!.message).toMatch(/runtime\.adapters\.workspace/);
    expect(err!.message).toMatch(/tmux|worktree/i);
  });

  it('rejects both runtime.adapters.worker and runtime.adapters.workspace together', () => {
    // Scenario: Configure both adapters — assert BOTH paths are named in the diagnostic.
    const yaml = MINIMAL_V2_BASE + `
runtime:
  adapters:
    worker: docker
    workspace: projectRoot
`;
    const p = writeYaml('adapter_both.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let err: Error | undefined;
    try { loader.load(p); } catch (e) { err = e as Error; }

    expect(err).toBeDefined();
    expect(err!.message).toMatch(/runtime\.adapters\.worker/);
    expect(err!.message).toMatch(/runtime\.adapters\.workspace/);
    // AC3: explains adapters are not configurable
    expect(err!.message).toMatch(/not configurable/i);
    expect(err!.message).toMatch(/tmux/i);
  });

  it('rejects runtime.adapters.backlog in a v2 fixture', () => {
    const yaml = MINIMAL_V2_BASE + `
runtime:
  adapters:
    backlog: custom
`;
    const p = writeYaml('adapter_backlog.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let err: Error | undefined;
    try { loader.load(p); } catch (e) { err = e as Error; }

    expect(err).toBeDefined();
    expect(err!.message).toMatch(/runtime\.adapters\.backlog/);
    expect(err!.message).toMatch(/not configurable/i);
  });
});

// ---------------------------------------------------------------------------
// AC2 / Scenario 2: runtime.worktreePolicy and states.*.provisionWorktree rejected
// ---------------------------------------------------------------------------
describe('pi-experiment-ux5e: AC2 — runtime.worktreePolicy and per-state provisionWorktree rejected', () => {
  it('rejects runtime.worktreePolicy.default: never in a v2 fixture', () => {
    const yaml = MINIMAL_V2_BASE + `
runtime:
  worktreePolicy:
    default: never
`;
    const p = writeYaml('runtime_worktreepolicy.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let err: Error | undefined;
    try { loader.load(p); } catch (e) { err = e as Error; }

    expect(err).toBeDefined();
    expect(err!.message).toMatch(/runtime\.worktreePolicy/);
    // AC3: isolated git worktrees are mandatory
    expect(err!.message).toMatch(/worktree/i);
    expect(err!.message).toMatch(/mandatory|not configurable/i);
  });

  it('rejects states.Implementation.provisionWorktree: false in a v2 fixture', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implementation
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implementation:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    provisionWorktree: false
    actions:
      run_impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: Implementation
`;
    const p = writeYaml('state_provisionworktree_false.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let err: Error | undefined;
    try { loader.load(p); } catch (e) { err = e as Error; }

    expect(err).toBeDefined();
    expect(err!.message).toMatch(/states\.Implementation\.provisionWorktree/);
    // AC3: isolated git worktrees are mandatory
    expect(err!.message).toMatch(/worktree/i);
    expect(err!.message).toMatch(/mandatory|not configurable/i);
  });

  it('rejects both runtime.worktreePolicy and states.*.provisionWorktree together — both named', () => {
    // Scenario: both worktree overrides declared → both rejected in one diagnostic.
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implementation
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
runtime:
  worktreePolicy:
    default: never
states:
  Implementation:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    provisionWorktree: false
    actions:
      run_impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: Implementation
`;
    const p = writeYaml('both_worktree_fields.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let err: Error | undefined;
    try { loader.load(p); } catch (e) { err = e as Error; }

    expect(err).toBeDefined();
    expect(err!.message).toMatch(/runtime\.worktreePolicy/);
    expect(err!.message).toMatch(/states\.Implementation\.provisionWorktree/);
  });

  it('rejects states.*.provisionWorktree: true as well (mandatory means no override)', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implementation
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implementation:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    provisionWorktree: true
    actions:
      run_impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: Implementation
`;
    const p = writeYaml('state_provisionworktree_true.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let err: Error | undefined;
    try { loader.load(p); } catch (e) { err = e as Error; }

    expect(err).toBeDefined();
    expect(err!.message).toMatch(/states\.Implementation\.provisionWorktree/);
  });
});

// ---------------------------------------------------------------------------
// AC1 / Scenario 3: runtime.teammates admitted; no adapter knobs in resolved config
// ---------------------------------------------------------------------------
describe('pi-experiment-ux5e: AC1 — runtime.teammates concurrency admitted without adapter rejection', () => {
  it('admits runtime.teammates: 6 without rejecting', () => {
    // Scenario: configure only runtime.teammates — no adapter fields — should load.
    const yaml = MINIMAL_V2_BASE + `
runtime:
  teammates: 6
`;
    const p = writeYaml('runtime_teammates.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let config: ReturnType<typeof loader.load> | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();
    expect(config).toBeDefined();
    expect(config!.version).toBe(2);
  });

  it('admits empty runtime block (no adapter/worktree fields declared)', () => {
    const yaml = MINIMAL_V2_BASE + `
runtime: {}
`;
    const p = writeYaml('runtime_empty.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC4: Resolved v2 config has no adapter/worktree policy fields
// ---------------------------------------------------------------------------
describe('pi-experiment-ux5e: AC4 — resolved v2 config has no adapter/worktree policy fields', () => {
  it('resolved v2 config has no settings.worktreePolicy field', () => {
    // settings.worktreePolicy is already rejected by 202g; confirm it's absent in resolved config.
    const p = writeYaml('resolved_no_worktreepolicy.yaml', MINIMAL_V2_BASE);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    const config = loader.load(p);
    expect(config.version).toBe(2);
    // settings.worktreePolicy must not appear in the resolved v2 config
    expect((config.settings as Record<string, unknown>)['worktreePolicy']).toBeUndefined();
  });

  it('resolved v2 config has no runtime.adapters fields', () => {
    const p = writeYaml('resolved_no_adapters.yaml', MINIMAL_V2_BASE);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    const config = loader.load(p);
    // runtime block (if present) must not have adapters
    const runtime = (config as unknown as Record<string, unknown>)['runtime'] as Record<string, unknown> | undefined;
    expect(runtime?.['adapters']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC5: settings.pi.workerArgs and settings.pi.workerExtensions rejected in v2
// ---------------------------------------------------------------------------
describe('pi-experiment-ux5e: AC5 — settings.pi.workerArgs and workerExtensions rejected in v2', () => {
  it('rejects settings.pi.workerArgs in a v2 fixture', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
  pi:
    workerArgs: ["--some-flag"]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implementation
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implementation:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    actions:
      run_impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: Implementation
`;
    const p = writeYaml('pi_workerargs.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let err: Error | undefined;
    try { loader.load(p); } catch (e) { err = e as Error; }

    expect(err).toBeDefined();
    expect(err!.message).toMatch(/settings\.pi\.workerArgs/);
    // AC3: tmux workers are mandatory
    expect(err!.message).toMatch(/tmux/i);
    expect(err!.message).toMatch(/mandatory|not configurable/i);
  });

  it('rejects settings.pi.workerExtensions in a v2 fixture', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
  pi:
    workerExtensions: ["some-ext"]
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Implementation
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Implementation:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    actions:
      run_impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: Implementation
`;
    const p = writeYaml('pi_workerextensions.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let err: Error | undefined;
    try { loader.load(p); } catch (e) { err = e as Error; }

    expect(err).toBeDefined();
    expect(err!.message).toMatch(/settings\.pi\.workerExtensions/);
    expect(err!.message).toMatch(/tmux/i);
    expect(err!.message).toMatch(/mandatory|not configurable/i);
  });
});

// ---------------------------------------------------------------------------
// VERSION GATE: v1 configs with these fields are UNAFFECTED
// ---------------------------------------------------------------------------
describe('pi-experiment-ux5e: VERSION GATE — v1 configs with worktree/adapter fields load without error', () => {
  it('v1 config with settings.worktreePolicy loads without error (cerdiwen back-compat)', () => {
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
    const p = writeYaml('v1_worktreepolicy.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    let config: ReturnType<typeof loader.load> | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();
    expect(config!.version).toBeUndefined();
    // v1 config retains worktreePolicy
    expect((config!.settings as Record<string, unknown>)['worktreePolicy']).toBeDefined();
  });

  it('v1 config with states.*.provisionWorktree loads without error', () => {
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
    provisionWorktree: true
    actions:
      - id: plan
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Planning }
`;
    const p = writeYaml('v1_provision_worktree.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).not.toThrow();
  });

  it('v1 config with settings.pi.workerArgs loads without error', () => {
    const yaml = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
  maxConcurrentSlots: 2
  handoverTemplate: "t"
  pi:
    workerArgs: ["--some-flag"]
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
    const p = writeYaml('v1_workerargs.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);

    expect(() => loader.load(p)).not.toThrow();
  });
});
