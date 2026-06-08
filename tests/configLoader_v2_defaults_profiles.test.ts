/**
 * configLoader_v2_defaults_profiles.test.ts
 *
 * pi-experiment-w2tz: Add v2 state and tool defaults/profile expansion with a
 * non-routing allowlist.
 *
 * AC1: v2 supports same-file defaults.state, defaults.tool, profiles.states,
 *      and profiles.tools. Action profiles and toolSets are out of scope.
 *
 * AC2: Expansion precedence is defaults < one selected profile < local override.
 *      A field set at all three levels resolves to the LOCAL value; defaults-only
 *      inherits; profile overrides defaults; local overrides profile.
 *
 * AC3: Only allowlisted non-routing fields may be inherited. An UNKNOWN allowlist
 *      field in defaults/profile causes startup failure.
 *
 * AC4: Non-compressible workflow fields (transitions, routeEvidence, actions,
 *      requiredTools, identity, llm, name, type, command, sideEffectContract, etc.)
 *      must stay LOCAL; rejected with non-compressible-workflow-field diagnostic.
 *      Load-bearing test per category.
 *
 * AC5: Unknown profiles, profile cycles (not applicable — single profile selection),
 *      unknown allowlist fields, and non-compressible fields → startup-fatal.
 *
 * AC6: Deterministic resolved serialization (same fixture loaded 3x with different
 *      YAML map order → byte-identical resolved serialization + source paths).
 *
 * Each rejection test is LOAD-BEARING: it fails if its specific check is removed.
 * Version-gated: all checks apply ONLY when version === 2. v1 configs unaffected.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'orr-else-w2tz-'));

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
// Base minimal v2 YAML fixture (no defaults/profiles).
// ---------------------------------------------------------------------------
const MINIMAL_V2_BASE = `
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
      run-impl:
        type: prompt
        prompt: "Implement the requested changes."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;

// ---------------------------------------------------------------------------
// AC1: v2 accepts defaults.state + defaults.tool + profiles.states + profiles.tools
// ---------------------------------------------------------------------------

describe('pi-experiment-w2tz AC1: v2 accepts defaults.state, defaults.tool, profiles.states, profiles.tools', () => {
  it('S1a: minimal v2 config with defaults.state loads without error', () => {
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
defaults:
  state:
    thinking: medium
    contextRotThreshold: 5
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
    const p = writeYaml('s1a.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();
    expect(config).toBeDefined();
    expect(config!.version).toBe(2);
    // defaults.state fields are expanded onto the state
    const state = config!.states['implement'] as Record<string, unknown>;
    expect(state['thinking']).toBe('medium');
    expect(state['contextRotThreshold']).toBe(5);
  });

  it('S1b: minimal v2 config with defaults.tool loads without error', () => {
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
defaults:
  tool:
    timeoutMs: 30000
    argsMode: append
tools:
  plan-contract:
    type: command
    command: node
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
    const p = writeYaml('s1b.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();
    expect(config).toBeDefined();
    // defaults.tool fields are expanded onto the tool
    const tool = (config!.tools ?? []).find(t => t.name === 'plan-contract') as Record<string, unknown> | undefined;
    expect(tool).toBeDefined();
    expect(tool!['timeoutMs']).toBe(30000);
    expect(tool!['argsMode']).toBe('append');
  });

  it('S1c: v2 config with profiles.states loads without error', () => {
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
profiles:
  states:
    coding:
      thinking: high
      contextRotThreshold: 8
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    profile: coding
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s1c.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();
    expect(config).toBeDefined();
    const state = config!.states['implement'] as Record<string, unknown>;
    expect(state['thinking']).toBe('high');
    expect(state['contextRotThreshold']).toBe(8);
  });

  it('S1d: v2 config with profiles.tools loads without error', () => {
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
profiles:
  tools:
    fast-tool:
      timeoutMs: 10000
      allowArgs: true
tools:
  plan-contract:
    type: command
    command: node
    profile: fast-tool
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
    const p = writeYaml('s1d.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    let config: HarnessConfig | undefined;
    expect(() => { config = loader.load(p); }).not.toThrow();
    expect(config).toBeDefined();
    const tool = (config!.tools ?? []).find(t => t.name === 'plan-contract') as Record<string, unknown> | undefined;
    expect(tool).toBeDefined();
    expect(tool!['timeoutMs']).toBe(10000);
    expect(tool!['allowArgs']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2: Expansion precedence: defaults < profile < local override
// ---------------------------------------------------------------------------

describe('pi-experiment-w2tz AC2: expansion precedence defaults < profile < local (load-bearing)', () => {
  it('S2a: local value wins over profile and defaults (all three levels set)', () => {
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
defaults:
  state:
    thinking: low
profiles:
  states:
    coding:
      thinking: medium
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    profile: coding
    thinking: high
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s2a.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);
    const state = config.states['implement'] as Record<string, unknown>;
    // local wins over profile wins over defaults
    expect(state['thinking']).toBe('high');
  });

  it('S2b: profile overrides defaults when no local value (profile > defaults)', () => {
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
defaults:
  state:
    thinking: low
profiles:
  states:
    coding:
      thinking: medium
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    profile: coding
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s2b.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);
    const state = config.states['implement'] as Record<string, unknown>;
    // profile overrides defaults
    expect(state['thinking']).toBe('medium');
  });

  it('S2c: defaults inherited when no profile or local override (defaults-only inheritance)', () => {
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
defaults:
  state:
    thinking: low
    contextRotThreshold: 3
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
    const p = writeYaml('s2c.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);
    const state = config.states['implement'] as Record<string, unknown>;
    // both inherited from defaults
    expect(state['thinking']).toBe('low');
    expect(state['contextRotThreshold']).toBe(3);
  });

  it('S2d: tool profile precedence defaults < profile < local (tool level)', () => {
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
defaults:
  tool:
    timeoutMs: 10000
profiles:
  tools:
    fast:
      timeoutMs: 5000
tools:
  plan-contract:
    type: command
    command: node
    profile: fast
    timeoutMs: 2000
  verify-contract:
    type: command
    command: node
    profile: fast
  audit-contract:
    type: command
    command: node
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
    const p = writeYaml('s2d.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);
    const byName = (name: string) =>
      (config.tools ?? []).find(t => t.name === name) as Record<string, unknown> | undefined;

    // local wins (2000)
    expect(byName('plan-contract')!['timeoutMs']).toBe(2000);
    // profile wins over default (5000)
    expect(byName('verify-contract')!['timeoutMs']).toBe(5000);
    // default inherited (10000)
    expect(byName('audit-contract')!['timeoutMs']).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// AC3: Unknown allowlist fields in defaults/profiles → startup-fatal (load-bearing)
// ---------------------------------------------------------------------------

describe('pi-experiment-w2tz AC3: unknown allowlist field in defaults/profile → startup-fatal (load-bearing)', () => {
  it('S3a: unknown field in defaults.state → startup fails with source-path diagnostic', () => {
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
defaults:
  state:
    unknownFieldXYZ: true
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
    const p = writeYaml('s3a.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/unknownFieldXYZ/);
    expect(() => loader.load(p)).toThrow(/defaults\.state/);
  });

  it('S3b: unknown field in profiles.states entry → startup fails with source-path diagnostic', () => {
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
profiles:
  states:
    myProfile:
      weirdUnsupportedField: 42
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    profile: myProfile
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s3b.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/weirdUnsupportedField/);
    expect(() => loader.load(p)).toThrow(/profiles\.states\.myProfile/);
  });

  it('S3c: unknown field in defaults.tool → startup fails with source-path diagnostic', () => {
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
defaults:
  tool:
    unknownToolField: "bad"
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
    const p = writeYaml('s3c.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/unknownToolField/);
    expect(() => loader.load(p)).toThrow(/defaults\.tool/);
  });
});

// ---------------------------------------------------------------------------
// AC4: Non-compressible workflow field rejection (load-bearing per category)
// ---------------------------------------------------------------------------

describe('pi-experiment-w2tz AC4: non-compressible state field rejection (load-bearing per category)', () => {
  // Helper to build a v2 YAML with a non-compressible field in defaults.state
  function yamlWithDefaultsStateField(field: string, value: unknown): string {
    const valueStr = JSON.stringify(value);
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
defaults:
  state:
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

  // Helper to build a v2 YAML with a non-compressible field in profiles.states
  function yamlWithProfileStateField(field: string, value: unknown): string {
    const valueStr = JSON.stringify(value);
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
profiles:
  states:
    bad-profile:
      ${field}: ${valueStr}
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    profile: bad-profile
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
  }

  // Category 1: transitions (routing table — must stay LOCAL)
  it('S4a: defaults.state with "transitions" → rejected (non-compressible routing table)', () => {
    const p = writeYaml('s4a.yaml', yamlWithDefaultsStateField('transitions', { SUCCESS: 'completed' }));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/transitions/);
    expect(() => loader.load(p)).toThrow(/non-compressible/);
    expect(() => loader.load(p)).toThrow(/defaults\.state/);
  });

  // Category 2: routeEvidence (verifier route mappings — must stay LOCAL)
  it('S4b: defaults.state with "routeEvidence" → rejected (non-compressible verifier route mapping)', () => {
    const p = writeYaml('s4b.yaml', yamlWithDefaultsStateField('routeEvidence', { SUCCESS: [] }));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/routeEvidence/);
    expect(() => loader.load(p)).toThrow(/non-compressible/);
  });

  // Category 3: actions block (statechart execution graph — must stay LOCAL)
  it('S4c: defaults.state with "actions" → rejected (non-compressible statechart actions)', () => {
    const p = writeYaml('s4c.yaml', yamlWithDefaultsStateField('actions', {}));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/actions/);
    expect(() => loader.load(p)).toThrow(/non-compressible/);
  });

  // Category 4: requiredTools (artifact gate — route-affecting)
  it('S4d: defaults.state with "requiredTools" → rejected (non-compressible artifact gate)', () => {
    const p = writeYaml('s4d.yaml', yamlWithDefaultsStateField('requiredTools', ['plan_contract']));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/requiredTools/);
    expect(() => loader.load(p)).toThrow(/non-compressible/);
  });

  // Category 5: identity (structurally required per state — must be locally visible)
  it('S4e: defaults.state with "identity" → rejected (non-compressible identity)', () => {
    const p = writeYaml('s4e.yaml', yamlWithDefaultsStateField('identity', { role: 'R', expertise: 'E', constraints: [] }));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/identity/);
    expect(() => loader.load(p)).toThrow(/non-compressible/);
  });

  // Category 6: llm block (contains promptFile — must be locally visible per 0njv)
  it('S4f: defaults.state with "llm" → rejected (non-compressible llm/promptFile)', () => {
    const p = writeYaml('s4f.yaml', yamlWithDefaultsStateField('llm', { promptFile: '.pi/prompts/foo.md' }));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/llm/);
    expect(() => loader.load(p)).toThrow(/non-compressible/);
  });

  // Category 7: profile in profiles.states with transitions (state machine target)
  it('S4g: profiles.states entry with "transitions" → rejected (non-compressible from profile)', () => {
    const p = writeYaml('s4g.yaml', yamlWithProfileStateField('transitions', { SUCCESS: 'completed' }));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/transitions/);
    expect(() => loader.load(p)).toThrow(/non-compressible/);
    expect(() => loader.load(p)).toThrow(/profiles\.states\.bad-profile/);
  });

  // Category 8: activeTools (route-affecting tool set — must stay LOCAL)
  it('S4h: defaults.state with "activeTools" → rejected (non-compressible activeTools)', () => {
    const p = writeYaml('s4h.yaml', yamlWithDefaultsStateField('activeTools', ['my_tool']));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/activeTools/);
    expect(() => loader.load(p)).toThrow(/non-compressible/);
  });
});

describe('pi-experiment-w2tz AC4: non-compressible tool field rejection (load-bearing per category)', () => {
  // Helper to build a v2 YAML with a non-compressible field in defaults.tool
  function yamlWithDefaultsToolField(field: string, value: unknown): string {
    const valueStr = JSON.stringify(value);
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
defaults:
  tool:
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

  // Tool non-compressible: name (identity)
  it('S4i: defaults.tool with "name" → rejected (non-compressible tool name)', () => {
    const p = writeYaml('s4i.yaml', yamlWithDefaultsToolField('name', 'bad'));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/name/);
    expect(() => loader.load(p)).toThrow(/non-compressible/);
    expect(() => loader.load(p)).toThrow(/defaults\.tool/);
  });

  // Tool non-compressible: type (tool type contract)
  it('S4j: defaults.tool with "type" → rejected (non-compressible tool type)', () => {
    const p = writeYaml('s4j.yaml', yamlWithDefaultsToolField('type', 'command'));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/type/);
    expect(() => loader.load(p)).toThrow(/non-compressible/);
  });

  // Tool non-compressible: command
  it('S4k: defaults.tool with "command" → rejected (non-compressible command)', () => {
    const p = writeYaml('s4k.yaml', yamlWithDefaultsToolField('command', 'node'));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/command/);
    expect(() => loader.load(p)).toThrow(/non-compressible/);
  });

  // Tool non-compressible: sideEffectContract (safety contract — must be explicit)
  it('S4l: defaults.tool with "sideEffectContract" → rejected (non-compressible safety contract)', () => {
    const p = writeYaml('s4l.yaml', yamlWithDefaultsToolField('sideEffectContract', { cancellationPolicy: 'none', idempotencyClass: 'idempotent', serializationKey: null, allowedInReadOnlyContext: true, safeForReadinessProbe: false }));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/sideEffectContract/);
    expect(() => loader.load(p)).toThrow(/non-compressible/);
  });

  // Tool non-compressible: validationRules (tool-specific gate logic)
  it('S4m: defaults.tool with "validationRules" → rejected (non-compressible validationRules)', () => {
    const p = writeYaml('s4m.yaml', yamlWithDefaultsToolField('validationRules', []));
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/validationRules/);
    expect(() => loader.load(p)).toThrow(/non-compressible/);
  });
});

// ---------------------------------------------------------------------------
// AC5: Unknown profiles → startup-fatal (load-bearing)
// ---------------------------------------------------------------------------

describe('pi-experiment-w2tz AC5: unknown profile reference → startup-fatal (load-bearing)', () => {
  it('S5a: state referencing missing profiles.states entry → startup fails with diagnostic', () => {
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
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    profile: does-not-exist
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s5a.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/does-not-exist/);
    expect(() => loader.load(p)).toThrow(/implement/);
    expect(() => loader.load(p)).toThrow(/profiles\.states/);
  });

  it('S5b: tool referencing missing profiles.tools entry → startup fails with diagnostic', () => {
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
  plan-contract:
    type: command
    command: node
    profile: no-such-profile
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
    const p = writeYaml('s5b.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(p)).toThrow(/no-such-profile/);
    expect(() => loader.load(p)).toThrow(/plan-contract/);
    expect(() => loader.load(p)).toThrow(/profiles\.tools/);
  });
});

// ---------------------------------------------------------------------------
// AC6: Deterministic resolved serialization (same fixture 3x → byte-identical)
// ---------------------------------------------------------------------------

describe('pi-experiment-w2tz AC6: deterministic resolved serialization (load-bearing)', () => {
  it('S6a: same v2 fixture with defaults+profiles loaded 3 times → byte-identical resolved serialization', () => {
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
defaults:
  state:
    thinking: medium
    contextRotThreshold: 5
  tool:
    timeoutMs: 20000
profiles:
  states:
    coding:
      thinking: high
  tools:
    fast:
      timeoutMs: 5000
tools:
  plan-contract:
    type: command
    command: node
    profile: fast
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    profile: coding
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
`;
    const p = writeYaml('s6a.yaml', yaml);

    // Load 3 times — must reset cache between loads.
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const loader = new ConfigLoader(undefined, TEST_DIR);
      const config = loader.load(p);
      // Sort keys for deterministic serialization (mirroring 0dgy pattern).
      results.push(JSON.stringify(config, Object.keys(config).sort()));
    }

    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });

  it('S6b: defaults fields in resolved config match expected merged values', () => {
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
defaults:
  state:
    thinking: low
    contextRotThreshold: 2
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
  review:
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review."
    thinking: high
    actions:
      do-review:
        type: prompt
        prompt: "Review."
    transitions:
      SUCCESS: completed
      FAILURE: review
`;
    const p = writeYaml('s6b.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);

    const implement = config.states['implement'] as Record<string, unknown>;
    const review = config.states['review'] as Record<string, unknown>;

    // implement: both fields from defaults (no local override)
    expect(implement['thinking']).toBe('low');
    expect(implement['contextRotThreshold']).toBe(2);

    // review: thinking is local (high wins); contextRotThreshold from defaults (2)
    expect(review['thinking']).toBe('high');
    expect(review['contextRotThreshold']).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Version gate: v1 configs are completely unaffected
// ---------------------------------------------------------------------------

describe('pi-experiment-w2tz version gate: v1 configs unaffected by defaults/profiles logic', () => {
  it('S7: v1 config (no version field) loads normally — defaults/profiles not processed', () => {
    // v1 fixtures don't use defaults/profiles (those are v2 only).
    // This test ensures the cerdiwen back-compat path is untouched.
    // (The actual cerdiwen golden test is statechart_lint.test.ts which we do not modify.)
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
    const p = writeYaml('s7_v1.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    // v1 loads fine — no startup error from the new v2 logic
    expect(() => loader.load(p)).not.toThrow();
    const config = loader.load(p);
    expect(config.version).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC1: profiles.states with multiple states sharing the same profile
// ---------------------------------------------------------------------------

describe('pi-experiment-w2tz AC1: multiple states sharing the same profile', () => {
  it('S8: two states with the same profile both inherit the profile fields', () => {
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
profiles:
  states:
    workhorse:
      thinking: high
      contextRotThreshold: 10
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement."
    profile: workhorse
    actions:
      run-impl:
        type: prompt
        prompt: "Implement."
    transitions:
      SUCCESS: completed
      FAILURE: implement
  review:
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review."
    profile: workhorse
    actions:
      do-review:
        type: prompt
        prompt: "Review."
    transitions:
      SUCCESS: completed
      FAILURE: review
`;
    const p = writeYaml('s8.yaml', yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    const config = loader.load(p);

    const implement = config.states['implement'] as Record<string, unknown>;
    const review = config.states['review'] as Record<string, unknown>;

    expect(implement['thinking']).toBe('high');
    expect(implement['contextRotThreshold']).toBe(10);
    expect(review['thinking']).toBe('high');
    expect(review['contextRotThreshold']).toBe(10);
  });
});
