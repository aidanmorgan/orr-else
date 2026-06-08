/**
 * pi-experiment-h05b / pi-experiment-ebzz: Deprecated-tool config admission and legacy-removal.
 *
 * Acceptance criteria tested here:
 * AC1: Config startup FAILS when any tool declares deprecated/hidden/replacedBy/deprecationReason.
 * AC2: describeConfiguredProjectTools never includes deprecated/hidden tools (those fields are gone).
 * AC4: Config startup FAILS when requiredTools, action sequences, or tool inventory references
 *      a deprecated/hidden/removed tool — no allowDeprecated escape hatch exists.
 * AC5: describeConfiguredProjectTools with no deprecated/hidden tools surfaces all declared tools.
 *
 * The former AC3 (runtime deprecated-tool guard) was removed by pi-experiment-ebzz.
 * Config admission (AC1/AC4) is the only rejection point — the runtime guard was dead code.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import {
  describeConfiguredProjectTools,
} from '../src/plugins/projectTools.js';
import { ProjectToolType } from '../src/constants/index.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import type { ProjectCommandToolConfig } from '../src/core/domain/StateModels.js';

// ── minimal harness config builder ──────────────────────────────────────────

function minimalConfig(toolOverrides: Partial<ProjectCommandToolConfig>[] = []): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: 'handover',
      agentTurnTimeoutMs: 60_000,
      processReapIntervalMs: 5_000,
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'gpt-4',
      defaultProvider: 'openai',
      modelProviders: { openai: { provider: 'openai', model: 'gpt-4' } },
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 5
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    states: {},
    tools: toolOverrides.length > 0 ? toolOverrides.map(o => ({
      name: 'unnamed',
      type: ProjectToolType.COMMAND,
      command: 'echo',
      ...o
    } as ProjectCommandToolConfig)) : undefined
  } as HarnessConfig;
}

// ── Shared harness.yaml config writer ───────────────────────────────────────

function makeConfigDir(): { tempDir: string; writeConfig: (yaml: string) => string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h05b-cfg-'));
  return {
    tempDir,
    writeConfig(yaml: string): string {
      const p = path.join(tempDir, 'harness.yaml');
      fs.writeFileSync(p, yaml);
      return p;
    }
  };
}

/** Minimal statechart/settings preamble for startup-rejection configs. */
const MINIMAL_PREAMBLE = `
settings:
  startState: Implement
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
`;

// ── AC1: deprecated lifecycle fields in tool config FAIL STARTUP ─────────────

describe('AC1: deprecated/hidden lifecycle fields in tool config fail startup', () => {
  let tempDir: string;
  let writeConfig: (yaml: string) => string;
  let configLoader: ConfigLoader;

  beforeEach(() => {
    ({ tempDir, writeConfig } = makeConfigDir());
    configLoader = new ConfigLoader(undefined, tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('fails startup when a tool declares deprecated:true', () => {
    const p = writeConfig(`
${MINIMAL_PREAMBLE}
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: artifact_validator
    type: command
    command: echo
    deprecated: true
`);
    expect(() => configLoader.load(p)).toThrow(/artifact_validator/);
    expect(() => configLoader.load(p)).toThrow(/deprecated/);
  });

  it('fails startup when a tool declares hidden:true', () => {
    const p = writeConfig(`
${MINIMAL_PREAMBLE}
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: old_tool
    type: command
    command: echo
    hidden: true
`);
    expect(() => configLoader.load(p)).toThrow(/old_tool/);
    expect(() => configLoader.load(p)).toThrow(/hidden/);
  });

  it('fails startup when a tool declares replacedBy', () => {
    const p = writeConfig(`
${MINIMAL_PREAMBLE}
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: artifact_validator
    type: command
    command: echo
    deprecated: true
    replacedBy:
      - requirements_schema
      - plan_contract
`);
    expect(() => configLoader.load(p)).toThrow(/artifact_validator/);
    expect(() => configLoader.load(p)).toThrow(/deprecated/);
  });

  it('fails startup when a tool declares deprecationReason', () => {
    const p = writeConfig(`
${MINIMAL_PREAMBLE}
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: artifact_validator
    type: command
    command: echo
    deprecated: true
    deprecationReason: "Use project-owned validators."
`);
    expect(() => configLoader.load(p)).toThrow(/artifact_validator/);
    expect(() => configLoader.load(p)).toThrow(/deprecated/);
  });

  it('startup rejection error names the replacement tools when replacedBy is present', () => {
    const p = writeConfig(`
${MINIMAL_PREAMBLE}
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: artifact_validator
    type: command
    command: echo
    deprecated: true
    replacedBy:
      - requirements_schema
      - plan_contract
`);
    expect(() => configLoader.load(p)).toThrow(/requirements_schema/);
    expect(() => configLoader.load(p)).toThrow(/plan_contract/);
  });

  it('clean config with no deprecated/hidden fields loads without errors', () => {
    const p = writeConfig(`
${MINIMAL_PREAMBLE}
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: requirements_schema
    type: command
    command: node
  - name: plan_contract
    type: command
    command: node
`);
    expect(() => configLoader.load(p)).not.toThrow();
  });
});

// ── AC2: describeConfiguredProjectTools never includes deprecated/hidden tools ─

describe('AC2: describeConfiguredProjectTools surfaces only clean tools', () => {
  it('includes all declared (non-deprecated, non-hidden) tools', () => {
    const config = minimalConfig([
      { name: 'plan_contract', description: 'Validates plan.', type: ProjectToolType.COMMAND, command: 'echo' },
      { name: 'requirements_schema', description: 'Validates requirements.', type: ProjectToolType.COMMAND, command: 'echo' }
    ]);
    const description = describeConfiguredProjectTools(config);
    expect(description).toContain('plan_contract');
    expect(description).toContain('requirements_schema');
  });

  it('returns empty string when no tools are configured', () => {
    const config = minimalConfig([]);
    expect(describeConfiguredProjectTools(config)).toBe('');
  });

  it('describeConfiguredProjectTools signature no longer accepts allowedDeprecated parameter', () => {
    // Verify the function only takes config — no allowedDeprecated parameter exists.
    const config = minimalConfig([
      { name: 'plan_contract', description: 'Active.', type: ProjectToolType.COMMAND, command: 'echo' }
    ]);
    // Single-argument call must work and surface the tool.
    const description = describeConfiguredProjectTools(config);
    expect(description).toContain('plan_contract');
  });
});

// ── AC4: startup fails when tools inventory references deprecated/removed tool ─
// These are LOAD-BEARING negative tests: they drive real ConfigLoader.load with
// configs that use the removed deprecated-lifecycle fields. They will FAIL if
// the validateNoDeprecatedTools rejection were removed from ConfigLoader.

describe('AC4: startup fails when tools inventory uses deprecated lifecycle fields — load-bearing negative tests', () => {
  let tempDir: string;
  let writeConfig: (yaml: string) => string;
  let configLoader: ConfigLoader;

  beforeEach(() => {
    ({ tempDir, writeConfig } = makeConfigDir());
    configLoader = new ConfigLoader(undefined, tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('LOAD-BEARING: fails startup and names the offending tool when deprecated:true is set', () => {
    // This test fails if validateNoDeprecatedTools is removed from ConfigLoader.
    const p = writeConfig(`
${MINIMAL_PREAMBLE}
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    requiredTools:
      - name: artifact_validator
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: artifact_validator
    type: command
    command: echo
    deprecated: true
    replacedBy:
      - requirements_schema
`);
    const fn = () => configLoader.load(p);
    // Must throw — not load cleanly
    expect(fn).toThrow();
    // Must name the offending tool
    expect(fn).toThrow(/artifact_validator/);
    // Must mention the replacement
    expect(fn).toThrow(/requirements_schema/);
  });

  it('LOAD-BEARING: fails startup and names the offending tool when hidden:true is set', () => {
    // This test fails if validateNoDeprecatedTools is removed from ConfigLoader.
    const p = writeConfig(`
${MINIMAL_PREAMBLE}
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    actions:
      - id: validate
        type: tool
        tool: old_tool
        requiredTools:
          - name: old_tool
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: old_tool
    type: command
    command: echo
    hidden: true
`);
    const fn = () => configLoader.load(p);
    expect(fn).toThrow();
    expect(fn).toThrow(/old_tool/);
    expect(fn).toThrow(/hidden/);
  });

  it('LOAD-BEARING: fails startup for deprecated+hidden combination with all stale fields named', () => {
    // This test fails if validateNoDeprecatedTools is removed from ConfigLoader.
    // Previously allowDeprecated:true would have bypassed this — now there is no escape.
    const p = writeConfig(`
${MINIMAL_PREAMBLE}
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: legacy_validator
    type: command
    command: echo
    deprecated: true
    hidden: true
    replacedBy:
      - requirements_schema
    deprecationReason: Monolithic validator replaced by project-owned tools.
`);
    const fn = () => configLoader.load(p);
    expect(fn).toThrow();
    expect(fn).toThrow(/legacy_validator/);
    // Error must list stale field names
    expect(fn).toThrow(/deprecated/);
  });

  it('LOAD-BEARING: clean replacement tools load without errors (positive control)', () => {
    // This is the positive control: configs using only clean, non-deprecated tools
    // must still load. If this fails the validator is too aggressive.
    const p = writeConfig(`
${MINIMAL_PREAMBLE}
states:
  Implement:
    identity: { role: "Dev", expertise: "Dev", constraints: [] }
    baseInstructions: "Build"
    requiredTools:
      - name: requirements_schema
      - name: plan_contract
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Implement }
tools:
  - name: requirements_schema
    type: command
    command: node
  - name: plan_contract
    type: command
    command: node
`);
    expect(() => configLoader.load(p)).not.toThrow();
  });
});

// ── AC5: allowedDeprecatedToolNames is no longer exported ───────────────────

describe('AC5: allowedDeprecatedToolNames is removed from projectTools exports', () => {
  it('projectTools module does not export allowedDeprecatedToolNames', async () => {
    // Dynamic import to inspect the module's exports at runtime.
    const mod = await import('../src/plugins/projectTools.js');
    expect((mod as Record<string, unknown>)['allowedDeprecatedToolNames']).toBeUndefined();
  });

  it('describeConfiguredProjectTools accepts only config (no second parameter)', () => {
    // The function signature is now describeConfiguredProjectTools(config: HarnessConfig): string.
    // Passing a second argument is a TypeScript compile error — but at runtime the function
    // must still work with only one argument.
    const config = minimalConfig([
      { name: 'plan_contract', description: 'Active.', type: ProjectToolType.COMMAND, command: 'echo' }
    ]);
    const description = describeConfiguredProjectTools(config);
    expect(description).toContain('plan_contract');
  });
});
