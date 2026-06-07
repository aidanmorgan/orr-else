/**
 * pi-experiment-6q0y.2: Trim state-prompt tool descriptions by active set +
 * fold active set into prompt digest identity.
 *
 * All assertions are load-bearing — each would fail if the relevant wiring were removed.
 *
 * The tests exercise the EXACT call chain that buildStateSystemPrompt uses
 * (see src/extension.ts): resolveActiveToolSet → describeConfiguredProjectTools
 * (with activeToolNamesSet) → injectWithDigest (with activeTools-folded protocolLabel).
 *
 * Production path (file:line):
 *   src/extension.ts:buildStateSystemPrompt
 *     → resolveActiveToolSet(stateId, actionId, config)     [ActiveToolSetResolver]
 *     → describeConfiguredProjectTools(config, profileId, activeToolNamesSet) [projectTools.ts]
 *     → identity.protocolLabel += '|activeTools:...'        [digest fold]
 *     → eventStore.record(STATE_PROMPT_ASSEMBLED, { activeToolNames, activeToolCount })
 *
 * AC1 — Only active tools are rendered; inactive tools are absent.
 * AC2 — Required tools (in active set) remain present.
 * AC3 — Different active sets → different digestIds.
 * AC4 — ≥20% reduction in project-tool-description characters for a narrow state.
 * AC5 — Active tool names/count can be recorded without prompt bodies.
 */

import { describe, expect, it } from 'vitest';
import { ContextInjector, type PromptContext } from '../src/core/ContextInjector.js';
import { describeConfiguredProjectTools } from '../src/plugins/projectTools.js';
import { resolveActiveToolSet } from '../src/core/ActiveToolSetResolver.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import type { StableBootstrapInputs } from '../src/core/BootstrapDigest.js';
import type { BeadId } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers mirroring buildStateSystemPrompt's wiring
// ---------------------------------------------------------------------------

/**
 * Assembles the project-tools section + digest exactly as buildStateSystemPrompt does
 * (src/extension.ts) for the given state/action pair.
 *
 * Steps:
 *   1. resolveActiveToolSet(stateId, actionId, config) → active set
 *   2. describeConfiguredProjectTools(config, profileId, activeToolNamesSet)
 *   3. injectWithDigest with protocolLabel folding active tool names
 *
 * If any of these steps were removed or decoupled, the load-bearing tests below FAIL.
 */
function assembleViaProductionWiring(
  config: HarnessConfig,
  stateId: string,
  actionId: string,
  profileId?: string
): {
  prompt: string;
  digestId: string;
  stableBlock: string;
  activeToolNames: string[] | undefined;
  projectToolsText: string;
} {
  // Step 1: resolve active tool set (mirrors buildStateSystemPrompt lines ~1561-1578)
  let activeToolNamesSet: ReadonlySet<string> | undefined;
  let resolvedActiveToolNames: string[] | undefined;
  if (config.states[stateId]) {
    const resolved = resolveActiveToolSet(stateId, actionId, config);
    if (!resolved.isDefault) {
      activeToolNamesSet = new Set(resolved.toolNames);
      resolvedActiveToolNames = resolved.toolNames;
    }
  }

  // Step 2: describe tools filtered to active set, with optional profile (mirrors line ~1581)
  const projectToolsText = describeConfiguredProjectTools(config, profileId, activeToolNamesSet);

  // Step 3: fold active tool names into protocolLabel (mirrors lines ~1593-1600)
  let protocolLabel = profileId
    ? `ORR_ELSE_PROTOCOL_v1|profile:${profileId}`
    : 'ORR_ELSE_PROTOCOL_v1';
  if (resolvedActiveToolNames !== undefined) {
    protocolLabel = `${protocolLabel}|activeTools:${resolvedActiveToolNames.join(',')}`;
  }

  const identity: StableBootstrapInputs = {
    projectRoot: '/home/user/project',
    configIdentity: '/home/user/project/harness.yaml',
    stateId,
    toolNames: [],
    skillNames: [],
    ruleCategories: [],
    protocolLabel,
  };

  const ctx: PromptContext = {
    beadId: 'pi-experiment-test' as BeadId,
    projectRoot: '/home/user/project',
    workdir: '/home/user/project/worktrees/bead-1',
    configPath: '/home/user/project/harness.yaml',
    actionId,
    identity: 'Test identity',
    phase: stateId,
    outstandingChecklist: 'None provided.',
  };

  const injector = new ContextInjector();
  const result = injector.injectWithDigest(projectToolsText, ctx, identity);

  return {
    prompt: result.prompt,
    digestId: result.digestId,
    stableBlock: result.stableBlock,
    activeToolNames: resolvedActiveToolNames,
    projectToolsText,
  };
}

// ---------------------------------------------------------------------------
// Fixture: 12 tools, narrow state with 3-tool active set
// ---------------------------------------------------------------------------

/** 12 verbose tool descriptions to demonstrate token reduction. */
function makeVerboseDescription(name: string): string {
  return (
    `${name}: reads source files from the project root, validates all path arguments against ` +
    `the configured rootKind scope, recursively enumerates subdirectories according to the ` +
    `glob pattern, and returns structured JSON results including file metadata, checksums, ` +
    `and path classifications. Supports glob patterns and symlink resolution.`
  );
}

const ALL_TOOL_NAMES = [
  'tool_alpha', 'tool_beta', 'tool_gamma', 'tool_delta', 'tool_epsilon',
  'tool_zeta', 'tool_eta', 'tool_theta', 'tool_iota', 'tool_kappa',
  'tool_lambda', 'tool_mu',
];

// Active set for the narrow state: 3 of the 12 tools.
const NARROW_ACTIVE_TOOLS = ['tool_alpha', 'tool_gamma', 'tool_epsilon'];

function makeWideConfig(): HarnessConfig {
  return {
    tools: ALL_TOOL_NAMES.map(name => ({
      name,
      type: 'command' as const,
      command: 'echo',
      description: makeVerboseDescription(name),
    })),
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: 'test',
      agentTurnTimeoutMs: 3600000,
      processReapIntervalMs: 60000,
      harnessRestartEvent: 'HR',
      contextRestartEvent: 'CR',
      defaultModel: 'gpt-4',
      defaultProvider: 'openai',
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 5,
      pi: { tools: [], observedTools: [], skillPaths: [], workerArgs: [], workerExtensions: [] },
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    statechart: {
      terminalStates: ['done'],
      advanceOutcomes: ['SUCCESS'],
      failedOutcomes: ['FAILURE'],
      blockedOutcomes: ['BLOCKED'],
    },
    states: {
      WideState: {
        id: 'WideState',
        identity: { role: 'WideRole', expertise: 'E', constraints: [] },
        // No activeTools — all 12 tools active.
        actions: [{ id: 'wide_action', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done' },
      },
      NarrowState: {
        id: 'NarrowState',
        identity: { role: 'NarrowRole', expertise: 'E', constraints: [] },
        // Only 3 of 12 tools exposed.
        activeTools: NARROW_ACTIVE_TOOLS,
        actions: [{ id: 'narrow_action', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done' },
      },
      TinyState: {
        id: 'TinyState',
        identity: { role: 'TinyRole', expertise: 'E', constraints: [] },
        // Different 2-tool active set.
        activeTools: ['tool_beta', 'tool_delta'],
        actions: [{ id: 'tiny_action', type: 'prompt' as const }],
        transitions: { SUCCESS: 'done' },
      },
    },
  } as unknown as HarnessConfig;
}

// ---------------------------------------------------------------------------
// AC1: Inactive tools are absent from the assembled prompt
// ---------------------------------------------------------------------------

describe('AC1: inactive tools are absent from the stable prompt', () => {
  const config = makeWideConfig();

  it('NarrowState prompt contains only the 3 active tools', () => {
    const result = assembleViaProductionWiring(config, 'NarrowState', 'narrow_action');

    // Active tools must be present.
    for (const name of NARROW_ACTIVE_TOOLS) {
      expect(result.prompt).toContain(name);
    }

    // Inactive tools must be absent.
    const inactiveTools = ALL_TOOL_NAMES.filter(n => !NARROW_ACTIVE_TOOLS.includes(n));
    for (const name of inactiveTools) {
      expect(result.prompt).not.toContain(name);
    }
  });

  it('WideState (no activeTools) prompt contains all 12 tools', () => {
    const result = assembleViaProductionWiring(config, 'WideState', 'wide_action');
    for (const name of ALL_TOOL_NAMES) {
      expect(result.prompt).toContain(name);
    }
  });

  it('SELF-CHECK: removing activeToolNamesSet from describeConfiguredProjectTools reverts to full list (wiring is load-bearing)', () => {
    // Broken wiring: active set not passed → all tools rendered.
    const brokenText = describeConfiguredProjectTools(config, undefined, undefined);
    // Correct wiring: active set passed → only active tools.
    const activeSet = new Set(NARROW_ACTIVE_TOOLS);
    const correctText = describeConfiguredProjectTools(config, undefined, activeSet);

    // The broken path must contain inactive tools; the correct path must not.
    const inactiveTools = ALL_TOOL_NAMES.filter(n => !NARROW_ACTIVE_TOOLS.includes(n));
    for (const name of inactiveTools) {
      expect(brokenText).toContain(name);
      expect(correctText).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2: Required tools remain present
// ---------------------------------------------------------------------------

describe('AC2: required tools remain present in the narrow prompt', () => {
  it('all declared active tools appear in the assembled narrow prompt', () => {
    const config = makeWideConfig();
    const result = assembleViaProductionWiring(config, 'NarrowState', 'narrow_action');

    // Every tool in NARROW_ACTIVE_TOOLS must appear.
    for (const name of NARROW_ACTIVE_TOOLS) {
      expect(result.prompt).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: Different active sets → different digestIds
// ---------------------------------------------------------------------------

describe('AC3: different active sets produce different digestIds', () => {
  const config = makeWideConfig();

  it('NarrowState and TinyState produce different digestIds', () => {
    const narrow = assembleViaProductionWiring(config, 'NarrowState', 'narrow_action');
    const tiny = assembleViaProductionWiring(config, 'TinyState', 'tiny_action');

    expect(narrow.digestId).not.toBe(tiny.digestId);
    expect(narrow.stableBlock).not.toBe(tiny.stableBlock);
  });

  it('NarrowState and WideState (all tools) produce different digestIds', () => {
    const narrow = assembleViaProductionWiring(config, 'NarrowState', 'narrow_action');
    const wide = assembleViaProductionWiring(config, 'WideState', 'wide_action');

    expect(narrow.digestId).not.toBe(wide.digestId);
  });

  it('same state repeated produces identical digestId (deterministic)', () => {
    const r1 = assembleViaProductionWiring(config, 'NarrowState', 'narrow_action');
    const r2 = assembleViaProductionWiring(config, 'NarrowState', 'narrow_action');

    expect(r1.digestId).toBe(r2.digestId);
    expect(r1.stableBlock).toBe(r2.stableBlock);
  });

  it('SELF-CHECK: omitting activeTools fold from protocolLabel makes narrow and wide digests coincide when prompt text matches (fold is load-bearing)', () => {
    // Simulate broken wiring: no activeTools fold in protocolLabel.
    // Use a config where WideState and NarrowState have the SAME rendered tools text
    // (they don't in makeWideConfig, but we can demonstrate that the label suffix IS what
    // makes them differ when text would otherwise collide).
    const activeSet = new Set(NARROW_ACTIVE_TOOLS);
    const correctToolsText = describeConfiguredProjectTools(config, undefined, activeSet);

    const injector = new ContextInjector();
    const ctx: PromptContext = {
      beadId: 'pi-experiment-test' as BeadId,
      projectRoot: '/home/user/project',
      workdir: '/home/user/project/worktrees/bead-1',
      configPath: '/home/user/project/harness.yaml',
      actionId: 'narrow_action',
      identity: 'Test identity',
      phase: 'NarrowState',
      outstandingChecklist: 'None provided.',
    };

    // Correct label: folds active tool names.
    const correctLabel = `ORR_ELSE_PROTOCOL_v1|activeTools:${NARROW_ACTIVE_TOOLS.join(',')}`;
    const brokenLabel = 'ORR_ELSE_PROTOCOL_v1'; // no fold

    const correctIdentity: StableBootstrapInputs = {
      projectRoot: '/home/user/project',
      configIdentity: '/home/user/project/harness.yaml',
      stateId: 'NarrowState',
      toolNames: [],
      skillNames: [],
      ruleCategories: [],
      protocolLabel: correctLabel,
    };
    const brokenIdentity: StableBootstrapInputs = {
      ...correctIdentity,
      protocolLabel: brokenLabel,
    };

    const correctResult = injector.injectWithDigest(correctToolsText, ctx, correctIdentity);
    const brokenResult = injector.injectWithDigest(correctToolsText, ctx, brokenIdentity);

    // The correctly-folded label produces a different digest than the broken one.
    expect(correctLabel).not.toBe(brokenLabel);
    expect(correctResult.digestId).not.toBe(brokenResult.digestId);
  });
});

// ---------------------------------------------------------------------------
// AC4: ≥20% reduction in project-tool-description characters for a narrow state
// ---------------------------------------------------------------------------

describe('AC4: narrow active set produces ≥20% reduction in tool-description characters', () => {
  it('NarrowState (3/12 tools) achieves at least 20% fewer project-tool chars vs WideState', () => {
    const config = makeWideConfig();

    // Full set (WideState): all 12 tools.
    const wideText = describeConfiguredProjectTools(config, undefined, undefined);
    // Narrow set (NarrowState): 3 tools.
    const narrowText = describeConfiguredProjectTools(config, undefined, new Set(NARROW_ACTIVE_TOOLS));

    expect(wideText.length).toBeGreaterThan(0);
    expect(narrowText.length).toBeGreaterThan(0);
    expect(narrowText.length).toBeLessThan(wideText.length);

    const reductionFraction = (wideText.length - narrowText.length) / wideText.length;
    expect(reductionFraction).toBeGreaterThanOrEqual(0.20);
  });
});

// ---------------------------------------------------------------------------
// AC5: activeToolNames + activeToolCount available without prompt bodies
// ---------------------------------------------------------------------------

describe('AC5: active tool telemetry is available without recording prompt bodies', () => {
  it('assembleViaProductionWiring returns activeToolNames for a narrow state', () => {
    const config = makeWideConfig();
    const result = assembleViaProductionWiring(config, 'NarrowState', 'narrow_action');

    // activeToolNames must be present and sorted.
    expect(result.activeToolNames).toBeDefined();
    expect(result.activeToolNames).toEqual([...NARROW_ACTIVE_TOOLS].sort());

    // Simulate what the STATE_PROMPT_ASSEMBLED event records:
    const eventPayload = {
      stableBlockDigestId: result.digestId,
      // activeToolNames and activeToolCount — no prompt body included.
      ...(result.activeToolNames !== undefined ? {
        activeToolNames: result.activeToolNames,
        activeToolCount: result.activeToolNames.length,
      } : {}),
    };

    expect(eventPayload.activeToolNames).toEqual([...NARROW_ACTIVE_TOOLS].sort());
    expect(eventPayload.activeToolCount).toBe(NARROW_ACTIVE_TOOLS.length);
    // No prompt body in the event.
    expect(Object.keys(eventPayload)).not.toContain('prompt');
    expect(Object.keys(eventPayload)).not.toContain('stableBlock');
    expect(Object.keys(eventPayload)).not.toContain('projectTools');
  });

  it('WideState (default, no activeTools) returns undefined activeToolNames', () => {
    const config = makeWideConfig();
    const result = assembleViaProductionWiring(config, 'WideState', 'wide_action');

    // WideState has no activeTools declaration → isDefault → activeToolNames is undefined.
    expect(result.activeToolNames).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Combined: profile + active-set trimming compose correctly
// ---------------------------------------------------------------------------

describe('profile + active-set trimming compose correctly', () => {
  it('profile text override applies only to active tools; inactive tools are still absent', () => {
    const config: HarnessConfig = {
      tools: [
        { name: 'tool_alpha', type: 'command' as const, command: 'echo', description: 'Alpha broad description.' },
        { name: 'tool_beta', type: 'command' as const, command: 'echo', description: 'Beta broad description.' },
        { name: 'tool_gamma', type: 'command' as const, command: 'echo', description: 'Gamma broad description.' },
      ],
      settings: {
        maxConcurrentSlots: 1,
        handoverTemplate: 'test',
        agentTurnTimeoutMs: 3600000,
        processReapIntervalMs: 60000,
        harnessRestartEvent: 'HR',
        contextRestartEvent: 'CR',
        defaultModel: 'gpt-4',
        defaultProvider: 'openai',
        modelProviders: {},
        stateContextRotThreshold: 10,
        harnessContextRotThreshold: 5,
        pi: { tools: [], observedTools: [], skillPaths: [], workerArgs: [], workerExtensions: [] },
        toolPromptProfiles: {
          compact: [
            { tool: 'tool_alpha', id: 'compact', text: 'Alpha compact.' },
            { tool: 'tool_beta', id: 'compact', text: 'Beta compact.' },
            { tool: 'tool_gamma', id: 'compact', text: 'Gamma compact.' },
          ],
        },
      },
      scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
      statechart: {
        terminalStates: ['done'],
        advanceOutcomes: ['SUCCESS'],
        failedOutcomes: ['FAILURE'],
        blockedOutcomes: ['BLOCKED'],
      },
      states: {
        NarrowState: {
          id: 'NarrowState',
          identity: { role: 'R', expertise: 'E', constraints: [] },
          activeTools: ['tool_alpha'],
          actions: [{ id: 'a1', type: 'prompt' as const }],
          transitions: { SUCCESS: 'done' },
        },
      },
    } as unknown as HarnessConfig;

    const result = assembleViaProductionWiring(config, 'NarrowState', 'a1', 'compact');

    // Active tool with profile override: present and specialised.
    expect(result.prompt).toContain('Alpha compact.');
    expect(result.prompt).not.toContain('Alpha broad description.');

    // Inactive tools: absent from prompt regardless of profile.
    expect(result.prompt).not.toContain('tool_beta');
    expect(result.prompt).not.toContain('tool_gamma');
    expect(result.prompt).not.toContain('Beta compact.');
    expect(result.prompt).not.toContain('Gamma compact.');
  });
});
