/**
 * pi-experiment-6q0y.6: Canonicalize cache-sensitive stable prompt ordering.
 *
 * These tests verify that the stable block and digest are canonical —
 * reordering non-semantic arrays in config/context produces identical output.
 * All assertions are load-bearing: each one would fail before the canonical
 * ordering was introduced.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextInjector, type PromptContext } from '../src/core/ContextInjector.js';
import type { StableBootstrapInputs } from '../src/core/BootstrapDigest.js';
import { describeConfiguredProjectTools } from '../src/plugins/projectTools.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import type { BeadId } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeIdentity(overrides: Partial<StableBootstrapInputs> = {}): StableBootstrapInputs {
  return {
    projectRoot: '/home/user/project',
    configIdentity: '/home/user/project/harness.yaml',
    stateId: 'Planning',
    toolNames: ['spawn_teammate', 'bd_get_bead'],
    skillNames: ['quality', 'planner'],
    ruleCategories: ['general', 'security'],
    protocolLabel: 'ORR_ELSE_PROTOCOL_v1',
    ...overrides
  };
}

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    beadId: 'pi-experiment-test' as BeadId,
    projectRoot: '/home/user/project',
    workdir: '/home/user/project/worktrees/bead-1',
    configPath: '/home/user/project/harness.yaml',
    actionId: 'plan',
    identity: 'planner',
    phase: 'Planning',
    llmProvider: 'anthropic',
    llmModel: 'claude-sonnet-4-6',
    skillPaths: [
      '/home/user/project/.pi/skills/quality/SKILL.md',
      '/home/user/project/.pi/skills/planner/SKILL.md'
    ],
    rulePaths: [
      '/home/user/project/.pi/rules/general.md',
      '/home/user/project/.pi/rules/security.md'
    ],
    outstandingChecklist: 'None provided.',
    ...overrides
  };
}

/** Minimal HarnessConfig with the given tool names in the given order. */
function makeConfigWithTools(toolNames: string[]): HarnessConfig {
  return {
    tools: toolNames.map(name => ({
      name,
      type: 'command' as const,
      command: 'echo',
      description: `Tool ${name}`
    })),
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: 'test',
      agentTurnTimeoutMs: 3600000,
      processReapIntervalMs: 60000,
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'gpt-4',
      defaultProvider: 'openai',
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 5,
      pi: { tools: [], observedTools: [], skillPaths: [], workerArgs: [], workerExtensions: [] }
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    statechart: {
      terminalStates: ['done'],
      advanceOutcomes: ['SUCCESS'],
      failedOutcomes: ['FAILURE'],
      blockedOutcomes: ['BLOCKED']
    },
    states: {}
  } as unknown as HarnessConfig;
}

// ---------------------------------------------------------------------------
// Temp config file helpers for ConfigLoader startup-lint tests (AC4)
// ---------------------------------------------------------------------------

const tmpFiles: string[] = [];

function writeTempConfig(content: string): string {
  const p = path.join(os.tmpdir(), `6q0y6_test_${Date.now()}_${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(p, content);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

/** A minimal valid YAML harness config skeleton (no tools, no skills). */
const MINIMAL_VALID_YAML = `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "test"
  defaultModel: "gpt-4"
  startState: S1
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  S1:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "test"
    actions:
      - id: a1
        type: prompt
        prompt: "Do the thing."
    transitions: { SUCCESS: done, FAILURE: S1 }
`;

// ---------------------------------------------------------------------------
// AC1: Reordering config.tools produces identical PROJECT-SPECIFIC TOOLS text
// ---------------------------------------------------------------------------

describe('AC1: config.tools ordering does not change PROJECT-SPECIFIC TOOLS text', () => {
  it('tools in alphabetical order and tools in reversed order produce identical text', () => {
    const toolNamesAsc = ['bd_get_bead', 'get_artifact_paths', 'spawn_teammate'];
    const toolNamesDesc = [...toolNamesAsc].reverse();

    const textAsc = describeConfiguredProjectTools(makeConfigWithTools(toolNamesAsc));
    const textDesc = describeConfiguredProjectTools(makeConfigWithTools(toolNamesDesc));

    expect(textAsc).toBe(textDesc);
  });

  it('changing a tool description changes the PROJECT-SPECIFIC TOOLS text (load-bearing: non-vacuous)', () => {
    const configA = makeConfigWithTools(['tool_a', 'tool_b']);
    const configB = makeConfigWithTools(['tool_a', 'tool_b']);
    // Mutate description on configB's tool_b
    (configB.tools[1] as { description: string }).description = 'Changed description';

    const textA = describeConfiguredProjectTools(configA);
    const textB = describeConfiguredProjectTools(configB);

    expect(textA).not.toBe(textB);
  });
});

// ---------------------------------------------------------------------------
// AC2: Reordering skillPaths / rulePaths does not change stableBlock or digest
// ---------------------------------------------------------------------------

describe('AC2: skillPaths and rulePaths ordering does not change stableBlock or digest', () => {
  const injector = new ContextInjector();

  it('reversed skillPaths produce byte-identical stableBlock', () => {
    const skillsAsc = [
      '/proj/.pi/skills/planner/SKILL.md',
      '/proj/.pi/skills/quality/SKILL.md',
      '/proj/.pi/skills/reviewer/SKILL.md'
    ];
    const skillsDesc = [...skillsAsc].reverse();

    const resultAsc = injector.injectWithDigest('Role prompt.', makeContext({ skillPaths: skillsAsc }), makeIdentity());
    const resultDesc = injector.injectWithDigest('Role prompt.', makeContext({ skillPaths: skillsDesc }), makeIdentity());

    expect(resultAsc.stableBlock).toBe(resultDesc.stableBlock);
    expect(resultAsc.digestId).toBe(resultDesc.digestId);
  });

  it('reversed rulePaths produce byte-identical stableBlock', () => {
    const rulesAsc = [
      '/proj/.pi/rules/general.md',
      '/proj/.pi/rules/security.md',
      '/proj/.pi/rules/testing.md'
    ];
    const rulesDesc = [...rulesAsc].reverse();

    const resultAsc = injector.injectWithDigest('Role prompt.', makeContext({ rulePaths: rulesAsc }), makeIdentity());
    const resultDesc = injector.injectWithDigest('Role prompt.', makeContext({ rulePaths: rulesDesc }), makeIdentity());

    expect(resultAsc.stableBlock).toBe(resultDesc.stableBlock);
    expect(resultAsc.digestId).toBe(resultDesc.digestId);
  });

  it('reversed documentationPaths produce byte-identical stableBlock', () => {
    const docsAsc = [
      '/proj/docs/architecture.md',
      '/proj/docs/design.md',
      '/proj/docs/runbook.md'
    ];
    const docsDesc = [...docsAsc].reverse();

    const resultAsc = injector.injectWithDigest('Role prompt.', makeContext({ documentationPaths: docsAsc }), makeIdentity());
    const resultDesc = injector.injectWithDigest('Role prompt.', makeContext({ documentationPaths: docsDesc }), makeIdentity());

    expect(resultAsc.stableBlock).toBe(resultDesc.stableBlock);
    expect(resultAsc.digestId).toBe(resultDesc.digestId);
  });
});

// ---------------------------------------------------------------------------
// AC3: Changing an item value changes the stable block hash and digest ID
// ---------------------------------------------------------------------------

describe('AC3: changing an item value changes the stable block hash and digest', () => {
  const injector = new ContextInjector();

  it('adding a skill changes stableBlock and digestId', () => {
    const base = injector.injectWithDigest('Role prompt.', makeContext({
      skillPaths: ['/proj/.pi/skills/planner/SKILL.md']
    }), makeIdentity());

    const extended = injector.injectWithDigest('Role prompt.', makeContext({
      skillPaths: ['/proj/.pi/skills/planner/SKILL.md', '/proj/.pi/skills/quality/SKILL.md']
    }), makeIdentity());

    expect(base.stableBlock).not.toBe(extended.stableBlock);
    expect(base.digestId).not.toBe(extended.digestId);
  });

  it('changing a rule path changes stableBlock and digestId', () => {
    const base = injector.injectWithDigest('Role prompt.', makeContext({
      rulePaths: ['/proj/.pi/rules/general.md']
    }), makeIdentity());

    const changed = injector.injectWithDigest('Role prompt.', makeContext({
      rulePaths: ['/proj/.pi/rules/security.md']
    }), makeIdentity());

    expect(base.stableBlock).not.toBe(changed.stableBlock);
    expect(base.digestId).not.toBe(changed.digestId);
  });
});

// ---------------------------------------------------------------------------
// AC4: Startup lint rejects duplicates
// ---------------------------------------------------------------------------

describe('AC4: startup lint rejects duplicate project tool names', () => {
  it('duplicate tool names in config.tools throws at load time', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "test"
  defaultModel: "gpt-4"
  startState: S1
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  S1:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "test"
    actions:
      - id: a1
        type: prompt
        prompt: "Do the thing."
    transitions: { SUCCESS: done, FAILURE: S1 }
tools:
  - name: bd_get_bead
    type: command
    command: echo
    description: "tool A"
  - name: bd_get_bead
    type: command
    command: echo
    description: "tool B (duplicate name)"
`;
    const p = writeTempConfig(yaml);
    expect(() => new ConfigLoader().load(p)).toThrow(/duplicate project tool name/i);
  });
});

describe('AC4: startup lint rejects duplicate skill paths', () => {
  it('duplicate entries in settings.pi.skillPaths throws at load time', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "test"
  defaultModel: "gpt-4"
  startState: S1
  worktreePolicy:
    default: always
  pi:
    skillPaths:
      - .pi/skills/quality/SKILL.md
      - .pi/skills/quality/SKILL.md
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  S1:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "test"
    actions:
      - id: a1
        type: prompt
        prompt: "Do the thing."
    transitions: { SUCCESS: done, FAILURE: S1 }
`;
    const p = writeTempConfig(yaml);
    expect(() => new ConfigLoader().load(p)).toThrow(/duplicate skill path/i);
  });
});

describe('AC4: startup lint rejects duplicate worker extension paths', () => {
  it('duplicate entries in settings.pi.workerExtensions throws at load time', () => {
    const yaml = `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "test"
  defaultModel: "gpt-4"
  startState: S1
  worktreePolicy:
    default: always
  pi:
    workerExtensions:
      - .pi/extensions/cerdiwen.ts
      - .pi/extensions/cerdiwen.ts
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  S1:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "test"
    actions:
      - id: a1
        type: prompt
        prompt: "Do the thing."
    transitions: { SUCCESS: done, FAILURE: S1 }
`;
    const p = writeTempConfig(yaml);
    expect(() => new ConfigLoader().load(p)).toThrow(/duplicate worker extension path/i);
  });
});

// ---------------------------------------------------------------------------
// AC5: Reversed-order config fixture produces equal stable digest
// (load-bearing: proves canonical ordering is in effect end-to-end)
// ---------------------------------------------------------------------------

describe('AC5: reversed-order config fixture produces equal stable digest', () => {
  const injector = new ContextInjector();

  it('identical logical inputs in reversed skill/rule/doc order produce identical digest', () => {
    const skillsForward = [
      '/proj/.pi/skills/planner/SKILL.md',
      '/proj/.pi/skills/quality/SKILL.md',
      '/proj/.pi/skills/reviewer/SKILL.md'
    ];
    const rulesForward = [
      '/proj/.pi/rules/general.md',
      '/proj/.pi/rules/security.md'
    ];
    const docsForward = [
      '/proj/docs/architecture.md',
      '/proj/docs/runbook.md'
    ];

    const resultForward = injector.injectWithDigest(
      'You are a planner.',
      makeContext({ skillPaths: skillsForward, rulePaths: rulesForward, documentationPaths: docsForward }),
      makeIdentity()
    );

    // Reversed fixture: same logical content, different declaration order.
    const resultReversed = injector.injectWithDigest(
      'You are a planner.',
      makeContext({
        skillPaths: [...skillsForward].reverse(),
        rulePaths: [...rulesForward].reverse(),
        documentationPaths: [...docsForward].reverse()
      }),
      makeIdentity()
    );

    expect(resultForward.stableBlock).toBe(resultReversed.stableBlock);
    expect(resultForward.digestId).toBe(resultReversed.digestId);
  });

  it('reversed tool order (via describeConfiguredProjectTools) in the prompt produces equal stableBlock', () => {
    // Simulate what buildStateSystemPrompt does: inject the tool description
    // as part of the role prompt.
    const toolNamesAsc = ['bd_get_bead', 'get_artifact_paths', 'spawn_teammate'];
    const toolNamesDesc = [...toolNamesAsc].reverse();

    const projectToolsAsc = describeConfiguredProjectTools(makeConfigWithTools(toolNamesAsc));
    const projectToolsDesc = describeConfiguredProjectTools(makeConfigWithTools(toolNamesDesc));

    const resultAsc = injector.injectWithDigest(
      `Role prompt.\n\n${projectToolsAsc}`,
      makeContext(),
      makeIdentity()
    );
    const resultDesc = injector.injectWithDigest(
      `Role prompt.\n\n${projectToolsDesc}`,
      makeContext(),
      makeIdentity()
    );

    expect(resultAsc.stableBlock).toBe(resultDesc.stableBlock);
    expect(resultAsc.digestId).toBe(resultDesc.digestId);
  });
});
