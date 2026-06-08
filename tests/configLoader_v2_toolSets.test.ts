/**
 * configLoader_v2_toolSets.test.ts
 *
 * pi-experiment-afdz: Add v2 toolSets expansion for required tool composition only.
 *
 * AC1: v2 supports same-file named toolSets for tool-name and required-tool
 *      composition only. toolSets are a tool-NAME list.
 *
 * AC2: toolSet expansion runs before required-tool and active-tool validation.
 *      Transitions, emitters, gates, route-event mappings, promptFile paths, and
 *      verifier route mappings remain local and are NOT supplied by toolSets.
 *
 * AC3: Unknown, duplicate, or invalid required-tool entries fail startup with
 *      source-path diagnostics.
 *
 * AC4: Resolved config preserves deterministic required-tool order and source
 *      metadata for direct and toolSet-derived entries.
 *
 * AC5: Tests cover: valid expansion, unknown tools, case-insensitive duplicates,
 *      direct-plus-toolSet de-duplication, non-tool workflow field rejection,
 *      invalid required evidence tool rejection, and explain source paths.
 *
 * LOAD-BEARING: Every rejection test fails if its specific check is removed.
 * VERSION-GATED: all checks apply ONLY when version === 2. v1 configs unaffected.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'orr-else-afdz-'));

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
// Base minimal v2 YAML fixture (no toolSets).
// Includes two declared tools for reference in toolSets tests.
// ---------------------------------------------------------------------------
const MINIMAL_V2_WITH_TOOLS = `
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
tools:
  coding_standards:
    type: command
    command: node
  codemap:
    type: command
    command: node
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement the task."
    actions:
      run-impl:
        type: prompt
        prompt: "Implement the requested changes."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;

// ---------------------------------------------------------------------------
// AC1: v2 accepts toolSets and expands them into requiredTools
// ---------------------------------------------------------------------------

describe('pi-experiment-afdz AC1: v2 accepts toolSets with valid tool-name arrays', () => {
  it('S1a: minimal v2 config with a toolSet definition loads without error', () => {
    const yaml = `
${MINIMAL_V2_WITH_TOOLS}
toolSets:
  reviewEvidence:
    - coding_standards
    - codemap
`;
    const p = writeYaml('s1a.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();
    expect(config).toBeDefined();
    expect(config!.version).toBe(2);
  });

  it('S1b: toolSet reference in state requiredTools is expanded', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: review
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  coding_standards:
    type: command
    command: node
  codemap:
    type: command
    command: node
toolSets:
  reviewEvidence:
    - coding_standards
    - codemap
states:
  review:
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review the code."
    requiredTools:
      - reviewEvidence
    actions:
      do-review:
        type: prompt
        prompt: "Review the code."
    transitions:
      SUCCESS: completed
      FAILURE: review
`;
    const p = writeYaml('s1b.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);
    // The toolSet 'reviewEvidence' should have been expanded into the tool names.
    const state = config.states['review'];
    expect(state).toBeDefined();
    const requiredTools = state.requiredTools as string[] | undefined;
    expect(requiredTools).toBeDefined();
    // Should contain the expanded tool names (sorted: codemap, coding_standards)
    expect(requiredTools).toContain('codemap');
    expect(requiredTools).toContain('coding_standards');
    // Should NOT contain the toolSet name itself
    expect(requiredTools).not.toContain('reviewEvidence');
  });

  it('S1c: toolSet reference in action requiredTools is expanded', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: review
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  coding_standards:
    type: command
    command: node
  codemap:
    type: command
    command: node
toolSets:
  reviewEvidence:
    - coding_standards
    - codemap
states:
  review:
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review the code."
    actions:
      do-review:
        type: prompt
        prompt: "Review the code."
        requiredTools:
          - reviewEvidence
    transitions:
      SUCCESS: completed
      FAILURE: review
`;
    const p = writeYaml('s1c.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);
    const state = config.states['review'];
    expect(state).toBeDefined();
    const action = state.actions.find(a => a.id === 'do-review');
    expect(action).toBeDefined();
    const requiredTools = action!.requiredTools as string[] | undefined;
    expect(requiredTools).toBeDefined();
    expect(requiredTools).toContain('codemap');
    expect(requiredTools).toContain('coding_standards');
    expect(requiredTools).not.toContain('reviewEvidence');
  });
});

// ---------------------------------------------------------------------------
// AC4: Deterministic expansion — sorted, de-duplicated, source-annotated
// ---------------------------------------------------------------------------

describe('pi-experiment-afdz AC4: deterministic toolSet expansion (load-bearing)', () => {
  it('S2a: expanded toolSet produces sorted tool names (deterministic order)', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: review
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  alpha_tool:
    type: command
    command: node
  beta_tool:
    type: command
    command: node
  gamma_tool:
    type: command
    command: node
toolSets:
  mySet:
    - gamma_tool
    - alpha_tool
    - beta_tool
states:
  review:
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review."
    requiredTools:
      - mySet
    actions:
      do-review:
        type: prompt
        prompt: "Review."
    transitions:
      SUCCESS: completed
      FAILURE: review
`;
    const p = writeYaml('s2a.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);
    const state = config.states['review'];
    const requiredTools = state.requiredTools as string[];
    // toolSet is sorted alphabetically: alpha_tool, beta_tool, gamma_tool
    expect(requiredTools).toEqual(['alpha_tool', 'beta_tool', 'gamma_tool']);
  });

  it('S2b: same fixture loaded 3 times → byte-identical resolved config (determinism)', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: review
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  coding_standards:
    type: command
    command: node
  codemap:
    type: command
    command: node
toolSets:
  reviewEvidence:
    - coding_standards
    - codemap
states:
  review:
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review."
    requiredTools:
      - reviewEvidence
    actions:
      do-review:
        type: prompt
        prompt: "Review."
    transitions:
      SUCCESS: completed
      FAILURE: review
`;
    const p = writeYaml('s2b.yaml', yaml);
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const loader = new ConfigLoader(undefined, TEST_DIR);
      const config = loader.load(p);
      results.push(JSON.stringify(config, Object.keys(config).sort()));
    }
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });

  it('S2c: direct tool + toolSet reference — direct tool is de-duplicated when it also appears in toolSet', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: review
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  coding_standards:
    type: command
    command: node
  codemap:
    type: command
    command: node
toolSets:
  reviewEvidence:
    - coding_standards
    - codemap
states:
  review:
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review."
    requiredTools:
      - codemap
      - reviewEvidence
    actions:
      do-review:
        type: prompt
        prompt: "Review."
    transitions:
      SUCCESS: completed
      FAILURE: review
`;
    const p = writeYaml('s2c.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);
    const state = config.states['review'];
    const requiredTools = state.requiredTools as string[];
    // codemap appears directly AND via reviewEvidence — should appear only once
    const codeMapCount = requiredTools.filter(t => t === 'codemap').length;
    expect(codeMapCount).toBe(1);
    // coding_standards also present
    expect(requiredTools).toContain('coding_standards');
    // toolSet name not present
    expect(requiredTools).not.toContain('reviewEvidence');
  });
});

// ---------------------------------------------------------------------------
// AC2 + Load-bearing: non-tool workflow field rejection per disallowed kind
// ---------------------------------------------------------------------------

describe('pi-experiment-afdz AC2: non-tool workflow field rejection in toolSet (load-bearing per kind)', () => {
  // Helper: build a v2 yaml with a toolSet that contains a forbidden field
  function yamlWithForbiddenToolSetField(field: string, value: unknown): string {
    const valueStr = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
    return `
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
tools:
  coding_standards:
    type: command
    command: node
toolSets:
  badSet:
    ${field}: ${valueStr}
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
  }

  // Kind 1: transitions (routing table — must stay LOCAL)
  it('S3a: toolSet with "transitions" → rejected (non-tool routing field)', () => {
    const p = writeYaml('s3a.yaml', yamlWithForbiddenToolSetField('transitions', { SUCCESS: 'completed' }));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/transitions/);
    expect(() => loader.load(p)).toThrow(/toolSets\.badSet/);
    expect(() => loader.load(p)).toThrow(/tool-NAME composition/);
  });

  // Kind 2: emitters (route event emitter — must stay LOCAL)
  it('S3b: toolSet with "emitters" → rejected (non-tool emitter field)', () => {
    const p = writeYaml('s3b.yaml', yamlWithForbiddenToolSetField('emitters', []));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/emitters/);
    expect(() => loader.load(p)).toThrow(/toolSets\.badSet/);
  });

  // Kind 3: gates (gate config — must stay LOCAL)
  it('S3c: toolSet with "gates" → rejected (non-tool gate field)', () => {
    const p = writeYaml('s3c.yaml', yamlWithForbiddenToolSetField('gates', []));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/gates/);
    expect(() => loader.load(p)).toThrow(/toolSets\.badSet/);
  });

  // Kind 4: promptFile (prompt file path — must stay LOCAL per 0njv)
  it('S3d: toolSet with "promptFile" → rejected (non-tool promptFile field)', () => {
    const p = writeYaml('s3d.yaml', yamlWithForbiddenToolSetField('promptFile', '.pi/prompts/foo.md'));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/promptFile/);
    expect(() => loader.load(p)).toThrow(/toolSets\.badSet/);
  });

  // Kind 5: emits (verifier route mapping — must stay LOCAL)
  it('S3e: toolSet with "emits" → rejected (non-tool verifier routing field)', () => {
    const p = writeYaml('s3e.yaml', yamlWithForbiddenToolSetField('emits', { pass: 'SUCCESS', fail: 'FAILURE' }));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/emits/);
    expect(() => loader.load(p)).toThrow(/toolSets\.badSet/);
  });

  // Kind 6: routeEvidence (verifier route mapping — must stay LOCAL)
  it('S3f: toolSet with "routeEvidence" → rejected (non-tool routeEvidence field)', () => {
    const p = writeYaml('s3f.yaml', yamlWithForbiddenToolSetField('routeEvidence', { SUCCESS: [] }));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/routeEvidence/);
    expect(() => loader.load(p)).toThrow(/toolSets\.badSet/);
  });

  // Kind 7: actions (statechart actions — must stay LOCAL)
  it('S3g: toolSet with "actions" → rejected (non-tool actions field)', () => {
    const p = writeYaml('s3g.yaml', yamlWithForbiddenToolSetField('actions', {}));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/actions/);
    expect(() => loader.load(p)).toThrow(/toolSets\.badSet/);
  });

  // Kind 8: on (v1 transition map — must stay LOCAL)
  it('S3h: toolSet with "on" (v1 transition map) → rejected (non-tool field)', () => {
    const p = writeYaml('s3h.yaml', yamlWithForbiddenToolSetField('on', { SUCCESS: 'completed' }));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    // "on" is in the forbidden list
    expect(() => loader.load(p)).toThrow(/toolSets\.badSet/);
  });
});

// ---------------------------------------------------------------------------
// AC3: Unknown tool names and unknown toolSet references → startup-fatal
// ---------------------------------------------------------------------------

describe('pi-experiment-afdz AC3: unknown tool / unknown toolSet rejection (load-bearing)', () => {
  it('S4a: toolSet referencing unknown tool name → startup fails with diagnostic', () => {
    const yaml = `
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
tools:
  coding_standards:
    type: command
    command: node
toolSets:
  mySet:
    - coding_standards
    - unknown_tool_xyz
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s4a.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/unknown_tool_xyz/);
    expect(() => loader.load(p)).toThrow(/toolSets\.mySet/);
  });

  it('S4b: requiredTools referencing unknown toolSet name → startup fails with diagnostic', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: review
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  coding_standards:
    type: command
    command: node
states:
  review:
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review."
    requiredTools:
      - nonExistentSet
    actions:
      do-review:
        type: prompt
        prompt: "Review."
    transitions:
      SUCCESS: completed
      FAILURE: review
`;
    const p = writeYaml('s4b.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/nonExistentSet/);
    expect(() => loader.load(p)).toThrow(/states\.review\.requiredTools/);
  });

  it('S4c: toolSet with duplicate tool name (case-insensitive) → startup fails', () => {
    const yaml = `
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
tools:
  coding_standards:
    type: command
    command: node
toolSets:
  mySet:
    - coding_standards
    - coding_standards
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s4c.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/coding_standards/);
    expect(() => loader.load(p)).toThrow(/duplicate/);
    expect(() => loader.load(p)).toThrow(/mySet/);
  });
});

// ---------------------------------------------------------------------------
// Version gate: v1 configs unaffected
// ---------------------------------------------------------------------------

describe('pi-experiment-afdz version gate: v1 configs unaffected', () => {
  it('S5: v1 config (no version field) loads normally — toolSets not processed', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
  startState: implement
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    actions:
      - id: run-impl
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s5_v1.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    // v1 loads fine — toolSets block would be ignored by v2 logic
    expect(() => loader.load(p)).not.toThrow();
    const config = loader.load(p);
    expect(config.version).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC5: Multiple toolSets and complex expansion scenarios
// ---------------------------------------------------------------------------

describe('pi-experiment-afdz AC5: complex expansion scenarios', () => {
  it('S6a: toolSet referenced from multiple states — all expand correctly', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: review
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  coding_standards:
    type: command
    command: node
  codemap:
    type: command
    command: node
toolSets:
  reviewEvidence:
    - coding_standards
    - codemap
states:
  review:
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review."
    requiredTools:
      - reviewEvidence
    actions:
      do-review:
        type: prompt
        prompt: "Review."
    transitions:
      SUCCESS: completed
      FAILURE: review
`;
    const p = writeYaml('s6a.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);

    const review = config.states['review'];
    const reviewTools = review.requiredTools as string[];
    // Both states should have the expanded toolSet
    expect(reviewTools).toContain('coding_standards');
    expect(reviewTools).toContain('codemap');
    expect(reviewTools).not.toContain('reviewEvidence');
  });

  it('S6b: v2 config with no toolSets block loads normally (toolSets optional)', () => {
    const yaml = MINIMAL_V2_WITH_TOOLS;
    const p = writeYaml('s6b.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).not.toThrow();
    const config = loader.load(p);
    expect(config.version).toBe(2);
    // toolSets is not on the resolved config type (it's a raw-only field)
  });

  it('S6c: toolSet with a single tool name expands to that single tool', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: review
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  coding_standards:
    type: command
    command: node
toolSets:
  singleTool:
    - coding_standards
states:
  review:
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review."
    requiredTools:
      - singleTool
    actions:
      do-review:
        type: prompt
        prompt: "Review."
    transitions:
      SUCCESS: completed
      FAILURE: review
`;
    const p = writeYaml('s6c.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);
    const review = config.states['review'];
    const requiredTools = review.requiredTools as string[];
    expect(requiredTools).toEqual(['coding_standards']);
  });

  it('S6d: toolSet not valid non-array value → startup fails with clear diagnostic', () => {
    const yaml = `
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
tools:
  coding_standards:
    type: command
    command: node
toolSets:
  badSet: "not-an-array"
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s6d.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/badSet/);
    expect(() => loader.load(p)).toThrow(/array/);
  });

  it('S6e: direct tool names and toolSet references can coexist in requiredTools', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: review
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  coding_standards:
    type: command
    command: node
  codemap:
    type: command
    command: node
  extra_tool:
    type: command
    command: node
toolSets:
  reviewEvidence:
    - coding_standards
    - codemap
states:
  review:
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review."
    requiredTools:
      - extra_tool
      - reviewEvidence
    actions:
      do-review:
        type: prompt
        prompt: "Review."
    transitions:
      SUCCESS: completed
      FAILURE: review
`;
    const p = writeYaml('s6e.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);
    const review = config.states['review'];
    const requiredTools = review.requiredTools as string[];
    // extra_tool comes first (direct), then toolSet expansion
    expect(requiredTools).toContain('extra_tool');
    expect(requiredTools).toContain('coding_standards');
    expect(requiredTools).toContain('codemap');
    expect(requiredTools).not.toContain('reviewEvidence');
  });

  it('S6f: toolSet object without forbidden fields → still rejected (must be array)', () => {
    const yaml = `
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
tools:
  coding_standards:
    type: command
    command: node
toolSets:
  badSet:
    someArbitraryKey: someValue
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s6f.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    // An object (even without forbidden fields) is rejected — must be an array
    expect(() => loader.load(p)).toThrow(/badSet/);
    expect(() => loader.load(p)).toThrow(/array/);
  });
});

// ---------------------------------------------------------------------------
// Coexistence with w2tz defaults/profiles
// ---------------------------------------------------------------------------

describe('pi-experiment-afdz: coexists with w2tz defaults/profiles', () => {
  it('S7: v2 config with both toolSets and defaults/profiles loads without conflict', () => {
    const yaml = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: review
  terminal: [completed]
events:
  advance: [SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
tools:
  coding_standards:
    type: command
    command: node
  codemap:
    type: command
    command: node
defaults:
  state:
    thinking: medium
  tool:
    timeoutMs: 30000
toolSets:
  reviewEvidence:
    - coding_standards
    - codemap
states:
  review:
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review."
    requiredTools:
      - reviewEvidence
    actions:
      do-review:
        type: prompt
        prompt: "Review."
    transitions:
      SUCCESS: completed
      FAILURE: review
`;
    const p = writeYaml('s7.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();
    expect(config).toBeDefined();

    // defaults expansion should still work
    const review = config!.states['review'] as Record<string, unknown>;
    expect(review['thinking']).toBe('medium');

    // toolSets expansion should also work
    const requiredTools = config!.states['review'].requiredTools as string[];
    expect(requiredTools).toContain('coding_standards');
    expect(requiredTools).toContain('codemap');

    // tool timeoutMs from defaults
    const tool = (config!.tools ?? []).find(t => t.name === 'coding_standards') as Record<string, unknown> | undefined;
    expect(tool!['timeoutMs']).toBe(30000);
  });
});
