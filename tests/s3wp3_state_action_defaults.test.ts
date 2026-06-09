/**
 * s3wp.3: state and action defaults runtime-backed
 *
 * Tests that resolveActionContextMode, resolveActionHandoverRequired, and
 * actionRunContext honor the inheritance chain:
 *   per-action → per-state (defaultActionContextMode/handoverRequired) → global settings
 *
 * Also tests the ConfigLoader YAML-level surface for defaultActionContextMode and
 * handoverRequired fields.
 *
 * Includes gate-level tests proving handoverRequired is non-inert:
 * evaluateGateReadiness blocks SUCCESS when handoverRequired=true and no
 * substantive checkpoint summary exists, and allows it when the summary is present.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolveActionContextMode,
  resolveActionHandoverRequired,
  actionRunContext
} from '../src/extension/CoordinatorController.js';
import { evaluateGateReadiness } from '../src/extension/WorkerRunController.js';
import { ActionContextMode, ActionRunContext, ActionType, DomainEventName, EventName, ToolResultStatus } from '../src/constants/domain.js';
import { HandoverRequiredDefaults } from '../src/constants/infra.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import type { SDLCState, TeammateAction } from '../src/core/domain/StateModels.js';
import type { ActiveRun } from '../src/extension/SessionTypes.js';
import { TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION, type ToolEvidenceHandle } from '../src/core/ToolEvidenceHandle.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeAction(overrides: Partial<TeammateAction> = {}): TeammateAction {
  return {
    id: 'a1',
    type: ActionType.PROMPT,
    ...overrides
  };
}

function makeState(overrides: Partial<SDLCState> = {}): SDLCState {
  return {
    id: 'TestState',
    identity: { role: 'R', expertise: 'E', constraints: [] },
    actions: [],
    transitions: {},
    ...overrides
  } as unknown as SDLCState;
}

function makeConfig(overrides: Partial<HarnessConfig['settings']> = {}): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 2,
      handoverTemplate: 'test',
      agentTurnTimeoutMs: 3600000,
      processReapIntervalMs: 60000,
      startState: 'TestState',
      harnessRestartEvent: EventName.HARNESS_RESTART,
      contextRestartEvent: EventName.CONTEXT_RESTART,
      defaultModel: 'gpt-4',
      defaultProvider: 'openai',
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 5,
      ...overrides
    },
    scheduler: { weights: { waitTime: 1, executionTime: 0.5, progress: 2, penalty: 1 } },
    statechart: {
      terminalStates: ['completed'],
      advanceOutcomes: ['SUCCESS'],
      failedOutcomes: ['FAILURE'],
      blockedOutcomes: ['BLOCKED'],
      customOutcomes: []
    },
    states: {}
  } as unknown as HarnessConfig;
}

// ── resolveActionContextMode ──────────────────────────────────────────────────

describe('resolveActionContextMode (s3wp.3)', () => {
  it('returns per-action contextMode when set (highest priority)', () => {
    const action = makeAction({ contextMode: ActionContextMode.SUBAGENT });
    const state = makeState({ defaultActionContextMode: ActionContextMode.SAME });
    const config = makeConfig({ defaultActionContextMode: ActionContextMode.ONE_SHOT });

    expect(resolveActionContextMode(action, state, config)).toBe(ActionContextMode.SUBAGENT);
  });

  it('falls back to state.defaultActionContextMode when action.contextMode is absent', () => {
    const action = makeAction(); // no contextMode
    const state = makeState({ defaultActionContextMode: ActionContextMode.ONE_SHOT });
    const config = makeConfig({ defaultActionContextMode: ActionContextMode.SUBAGENT });

    expect(resolveActionContextMode(action, state, config)).toBe(ActionContextMode.ONE_SHOT);
  });

  it('falls back to settings.defaultActionContextMode when neither action nor state set it', () => {
    const action = makeAction();
    const state = makeState(); // no defaultActionContextMode
    const config = makeConfig({ defaultActionContextMode: ActionContextMode.SUBAGENT });

    expect(resolveActionContextMode(action, state, config)).toBe(ActionContextMode.SUBAGENT);
  });

  it('returns undefined when no level sets contextMode', () => {
    const action = makeAction();
    const state = makeState();
    const config = makeConfig();

    expect(resolveActionContextMode(action, state, config)).toBeUndefined();
  });

  it('works without state and config (backwards compat — per-action only)', () => {
    const action = makeAction({ contextMode: ActionContextMode.SAME });
    expect(resolveActionContextMode(action)).toBe(ActionContextMode.SAME);
  });

  it('returns undefined when called with no args set (no state, no config)', () => {
    const action = makeAction();
    expect(resolveActionContextMode(action)).toBeUndefined();
  });
});

// ── resolveActionHandoverRequired ────────────────────────────────────────────

describe('resolveActionHandoverRequired (s3wp.3)', () => {
  it('returns per-action handoverRequired when set (highest priority)', () => {
    const action = makeAction({ handoverRequired: true });
    const state = makeState({ handoverRequired: false });
    expect(resolveActionHandoverRequired(action, state)).toBe(true);
  });

  it('per-action false overrides state true', () => {
    const action = makeAction({ handoverRequired: false });
    const state = makeState({ handoverRequired: true });
    expect(resolveActionHandoverRequired(action, state)).toBe(false);
  });

  it('falls back to state.handoverRequired when action has no explicit value', () => {
    const action = makeAction(); // no handoverRequired
    const state = makeState({ handoverRequired: true });
    expect(resolveActionHandoverRequired(action, state)).toBe(true);
  });

  it('returns false (default) when neither action nor state set handoverRequired', () => {
    const action = makeAction();
    const state = makeState();
    expect(resolveActionHandoverRequired(action, state)).toBe(false);
  });

  it('returns false when called without state', () => {
    const action = makeAction();
    expect(resolveActionHandoverRequired(action)).toBe(false);
  });

  it('per-action true without state is true', () => {
    const action = makeAction({ handoverRequired: true });
    expect(resolveActionHandoverRequired(action)).toBe(true);
  });
});

// ── actionRunContext with inheritance ────────────────────────────────────────

describe('actionRunContext with s3wp.3 inheritance', () => {
  it('SUBAGENT contextMode → FRESH (per-action, direct)', () => {
    const action = makeAction({ contextMode: ActionContextMode.SUBAGENT });
    expect(actionRunContext(action)).toBe(ActionRunContext.FRESH);
  });

  it('ONE_SHOT contextMode → FRESH (per-action)', () => {
    const action = makeAction({ contextMode: ActionContextMode.ONE_SHOT });
    expect(actionRunContext(action)).toBe(ActionRunContext.FRESH);
  });

  it('SAME contextMode → PARENT (per-action)', () => {
    const action = makeAction({ contextMode: ActionContextMode.SAME });
    expect(actionRunContext(action)).toBe(ActionRunContext.PARENT);
  });

  it('state.defaultActionContextMode=SUBAGENT propagates to action when action has no contextMode', () => {
    const action = makeAction(); // no contextMode
    const state = makeState({ defaultActionContextMode: ActionContextMode.SUBAGENT });
    const config = makeConfig();

    expect(actionRunContext(action, state, config)).toBe(ActionRunContext.FRESH);
  });

  it('state.defaultActionContextMode=ONE_SHOT propagates to action', () => {
    const action = makeAction();
    const state = makeState({ defaultActionContextMode: ActionContextMode.ONE_SHOT });
    const config = makeConfig();

    expect(actionRunContext(action, state, config)).toBe(ActionRunContext.FRESH);
  });

  it('settings.defaultActionContextMode=SUBAGENT propagates when neither action nor state set it', () => {
    const action = makeAction();
    const state = makeState();
    const config = makeConfig({ defaultActionContextMode: ActionContextMode.SUBAGENT });

    expect(actionRunContext(action, state, config)).toBe(ActionRunContext.FRESH);
  });

  it('per-action SAME overrides state SUBAGENT default → PARENT', () => {
    const action = makeAction({ contextMode: ActionContextMode.SAME });
    const state = makeState({ defaultActionContextMode: ActionContextMode.SUBAGENT });
    const config = makeConfig({ defaultActionContextMode: ActionContextMode.SUBAGENT });

    expect(actionRunContext(action, state, config)).toBe(ActionRunContext.PARENT);
  });

  it('action.context=fresh still produces FRESH regardless of contextMode', () => {
    // The legacy action.context field must still work
    const action = makeAction({ context: ActionRunContext.FRESH, contextMode: ActionContextMode.SAME });
    expect(actionRunContext(action)).toBe(ActionRunContext.FRESH);
  });

  it('no contextMode anywhere → PARENT (default behavior preserved)', () => {
    const action = makeAction();
    const state = makeState();
    const config = makeConfig();
    expect(actionRunContext(action, state, config)).toBe(ActionRunContext.PARENT);
  });

  it('backwards compat: actionRunContext(action) with one arg still works', () => {
    // Pre-s3wp.3 call sites pass only the action — must not break
    const fresh = makeAction({ contextMode: ActionContextMode.SUBAGENT });
    const parent = makeAction({ contextMode: ActionContextMode.SAME });
    const neither = makeAction();

    expect(actionRunContext(fresh)).toBe(ActionRunContext.FRESH);
    expect(actionRunContext(parent)).toBe(ActionRunContext.PARENT);
    expect(actionRunContext(neither)).toBe(ActionRunContext.PARENT);
  });
});

// ── selectActiveAction honors state-level defaultActionContextMode ────────────

describe('selectActiveAction honors state-level defaultActionContextMode (s3wp.3)', () => {
  it('when state.defaultActionContextMode=subagent, prompt action resolves to FRESH and is selected last', async () => {
    // Import here to avoid circular issues
    const { selectActiveAction } = await import('../src/extension/CoordinatorController.js');

    const action1: TeammateAction = { id: 'a1', type: ActionType.PROMPT };
    const action2: TeammateAction = { id: 'a2', type: ActionType.PROMPT };

    // When state.defaultActionContextMode=subagent, all prompt actions → FRESH
    // selectActiveAction prefers PARENT+PROMPT first, so with all-FRESH it falls
    // back to the FRESH finder which picks action1.
    const state = makeState({
      defaultActionContextMode: ActionContextMode.SUBAGENT,
      actions: [action1, action2]
    });
    const config = makeConfig();

    const selected = selectActiveAction(config, 'TestState', state);
    expect(selected?.id).toBe('a1');
    // Verify the resolved context is FRESH
    expect(actionRunContext(selected!, state, config)).toBe(ActionRunContext.FRESH);
  });
});

// ── handoverRequired gate: evaluateGateReadiness integration ──────────────────
//
// Proves handoverRequired is non-inert (s3wp.3 REOPEN fix):
//   - When handoverRequired=true and no substantive checkpoint summary exists,
//     evaluateGateReadiness blocks SUCCESS (handoverSatisfied=false in blockingEvidence).
//   - When handoverRequired=true and a substantive summary was submitted,
//     the gate allows SUCCESS (handoverSatisfied=true, no handover blocking).
//   - When handoverRequired=false (default), the gate never blocks regardless.

/**
 * Build a minimal set of mocked services sufficient for evaluateGateReadiness
 * to exercise the handoverRequired gate.
 *
 * All advance-outcome sub-gates (checklist, required tools, write-set,
 * transactional, provenance) are mocked to PASS so that the only variable
 * is the handoverRequired dimension being tested.
 */
function makeMinimalServicesAndConfig(state: SDLCState) {
  const config = makeConfig();
  // Add the state to config so flowManager.nextState succeeds for SUCCESS
  (config.states as Record<string, SDLCState>)['TestState'] = {
    ...state,
    transitions: { SUCCESS: 'completed', FAILURE: 'TestState' }
  };

  const services = {
    flowManager: {
      nextState: vi.fn().mockReturnValue('completed')
    },
    eventStore: {
      latestProjectToolFailureLimitEvent: vi.fn().mockResolvedValue(undefined),
      projectBead: vi.fn().mockResolvedValue({ checklists: {} }),
      eventsForBead: vi.fn().mockResolvedValue([
        // A STATE_RUN_INITIALIZED with promptProvenanceResolutionFailed=true:
        // the provenance gate treats this as a warn-only path (allows completion).
        {
          type: 'STATE_RUN_INITIALIZED',
          data: {
            beadId: 'bd-test',
            stateId: 'TestState',
            actionId: 'a1',
            promptProvenanceResolutionFailed: true
          }
        }
      ])
    },
    requiredToolResolver: {
      resolve: vi.fn().mockResolvedValue({ toolNames: [] })
    },
    planWriteSet: {
      validatePlanContract: vi.fn().mockResolvedValue({ passed: true })
    },
    transactionalStateGuard: {
      validateSuccessReadOnly: vi.fn().mockResolvedValue({ passed: true })
    },
    configLoader: {
      load: vi.fn().mockResolvedValue(config),
      getConfigPath: vi.fn().mockReturnValue('/fake/harness.yaml')
    },
    projectRoot: '/fake/root'
  } as any;

  const obs = {
    getToolResult: vi.fn().mockReturnValue(undefined)
  } as any;

  return { services, obs, config };
}

function makeActiveRun(overrides: Partial<ActiveRun>): ActiveRun {
  const action = makeAction(overrides.action as Partial<TeammateAction> ?? {});
  const state: SDLCState = {
    ...(overrides.state ?? makeState()),
    actions: [action],
    transitions: { SUCCESS: 'completed', FAILURE: 'TestState' }
  };
  return {
    beadId: 'bd-test',
    stateId: 'TestState',
    state,
    action,
    requiredItems: [],
    startedAt: Date.now(),
    worklogManager: { appendEntry: vi.fn() } as any,
    checkpointAccepted: false,
    parentSequenceCompleted: false,
    completedActionIds: [],
    ...overrides
  };
}

describe('handoverRequired gate — evaluateGateReadiness (s3wp.3 non-inert fix)', () => {
  it('blocks SUCCESS when handoverRequired=true and no checkpoint was submitted', async () => {
    const action = makeAction({ handoverRequired: true });
    const state = makeState({ handoverRequired: true, actions: [action] });
    const run = makeActiveRun({
      action,
      state,
      checkpointAccepted: false,
      handoverSummary: undefined
    });

    const { services, obs, config } = makeMinimalServicesAndConfig(state);
    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.handoverSatisfied).toBe(false);
    // Both checkpoint gate and handover gate fire; at minimum the handover gate message is present
    expect(gate.blockingEvidence.some(e => e.includes('handoverRequired'))).toBe(true);
    expect(gate.ready).toBe(false);
  });

  it('blocks SUCCESS when handoverRequired=true, checkpoint submitted but summary is too short', async () => {
    const shortSummary = 'done'; // < HandoverRequiredDefaults.MIN_SUMMARY_CHARS
    expect(shortSummary.length).toBeLessThan(HandoverRequiredDefaults.MIN_SUMMARY_CHARS);

    const action = makeAction({ handoverRequired: true });
    const state = makeState({ handoverRequired: true, actions: [action] });
    const run = makeActiveRun({
      action,
      state,
      checkpointAccepted: true,     // checkpoint submitted (satisfies gate #6)
      handoverSummary: shortSummary  // but summary too short for handoverRequired gate
    });

    const { services, obs, config } = makeMinimalServicesAndConfig(state);
    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.handoverSatisfied).toBe(false);
    expect(gate.blockingEvidence.some(e => e.includes('handoverRequired'))).toBe(true);
    expect(gate.ready).toBe(false);
  });

  it('allows SUCCESS when handoverRequired=true and checkpoint has substantive summary', async () => {
    const substantiveSummary = 'This is a detailed summary with enough content to satisfy the gate requirement.';
    expect(substantiveSummary.length).toBeGreaterThanOrEqual(HandoverRequiredDefaults.MIN_SUMMARY_CHARS);

    const action = makeAction({ handoverRequired: true });
    const state = makeState({ handoverRequired: true, actions: [action] });
    const run = makeActiveRun({
      action,
      state,
      checkpointAccepted: true,
      handoverSummary: substantiveSummary
    });

    const { services, obs, config } = makeMinimalServicesAndConfig(state);
    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.handoverSatisfied).toBe(true);
    expect(gate.blockingEvidence.some(e => e.includes('handoverRequired'))).toBe(false);
    // All other gates are mocked to pass, so gate should be ready
    expect(gate.ready).toBe(true);
  });

  it('never blocks when handoverRequired=false (default), even with no checkpoint summary', async () => {
    const action = makeAction(); // no handoverRequired
    const state = makeState();   // no handoverRequired
    const run = makeActiveRun({
      action,
      state,
      checkpointAccepted: true,
      handoverSummary: undefined  // no summary
    });

    const { services, obs, config } = makeMinimalServicesAndConfig(state);
    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.handoverSatisfied).toBe(true);
    expect(gate.blockingEvidence.some(e => e.includes('handoverRequired'))).toBe(false);
  });

  it('handoverSatisfied is true for non-advance outcomes regardless of handoverRequired', async () => {
    // FAILURE outcome is not an advance outcome — handover gate must not fire
    const action = makeAction({ handoverRequired: true });
    const state = makeState({ handoverRequired: true, actions: [action] });
    const run = makeActiveRun({
      action,
      state,
      checkpointAccepted: false,   // no checkpoint
      handoverSummary: undefined
    });

    const { services, obs, config } = makeMinimalServicesAndConfig(state);
    const gate = await evaluateGateReadiness(run, 'FAILURE', services, { activeRun: run }, obs, config, true);

    // handoverSatisfied reflects the resolved value (false because handoverRequired=true and no summary)
    // but the gate must NOT push to blockingEvidence because FAILURE is not an advance outcome
    expect(gate.blockingEvidence.some(e => e.includes('handoverRequired'))).toBe(false);
  });
});

// ── 0yt5.33: artifact-presence required-tool audit (evaluateGateReadiness) ────
//
// Proves the migrated required-tool readiness surface (pre_signal_audit's
// shared predicate) reports, PER required tool, its artifact-presence gate
// status sourced from the SAME inputs the coordinator binding gate uses:
//   - a MISSING required artifact (no tool-result event for this attempt) blocks
//     with the tool name + "never invoked" reason.
//   - a PRESENT-but-FAIL required artifact (latest tool-result status REJECTED)
//     blocks with the tool name + "did not pass" reason.
// Both are reported in requiredTools (state) AND blockingEvidence (tool + reason).

/**
 * Services double whose required-tool resolver returns the given tool names and
 * whose EventStore.latestToolResultEvent returns the supplied per-tool events.
 * All non-required-tool sub-gates are mocked to PASS so the only variable is the
 * artifact-presence required-tool dimension.
 */
function makeRequiredToolServices(
  state: SDLCState,
  toolNames: string[],
  eventByTool: Record<string, any | undefined>
) {
  const config = makeConfig();
  (config.states as Record<string, SDLCState>)['TestState'] = {
    ...state,
    transitions: { SUCCESS: 'completed', FAILURE: 'TestState' }
  };

  const services = {
    flowManager: { nextState: vi.fn().mockReturnValue('completed') },
    eventStore: {
      latestProjectToolFailureLimitEvent: vi.fn().mockResolvedValue(undefined),
      projectBead: vi.fn().mockResolvedValue({ checklists: {} }),
      eventsForBead: vi.fn().mockResolvedValue([
        {
          type: 'STATE_RUN_INITIALIZED',
          data: { beadId: 'bd-test', stateId: 'TestState', actionId: 'a1', promptProvenanceResolutionFailed: true }
        }
      ]),
      // The artifact-presence audit reuses runVerifierGate, which reads the
      // latest tool-result event per required tool from here.
      latestToolResultEvent: vi.fn().mockImplementation(
        (_beadId: string, _stateId: string, _actionId: string, tool: string) =>
          Promise.resolve(eventByTool[tool])
      )
    },
    requiredToolResolver: { resolve: vi.fn().mockResolvedValue({ toolNames }) },
    artifactPaths: { resolve: vi.fn().mockResolvedValue({ artifactPaths: {} }) },
    planWriteSet: {
      validatePlanContract: vi.fn().mockResolvedValue({ passed: true }),
      resolve: vi.fn().mockResolvedValue({ allowedWriteSet: [] })
    },
    transactionalStateGuard: { validateSuccessReadOnly: vi.fn().mockResolvedValue({ passed: true }) },
    configLoader: {
      load: vi.fn().mockResolvedValue(config),
      getConfigPath: vi.fn().mockReturnValue('/fake/harness.yaml')
    },
    projectRoot: '/fake/root'
  } as any;

  const obs = { getToolResult: vi.fn().mockReturnValue(undefined) } as any;
  return { services, obs, config };
}

describe('artifact-presence required-tool audit — evaluateGateReadiness (0yt5.33)', () => {
  it('reports a MISSING required artifact AND a present-but-FAIL artifact, each with the tool name + reason', async () => {
    const MISSING_TOOL = 'missing_tool';
    const FAIL_TOOL = 'fail_tool';

    const action = makeAction();
    const state = makeState({ actions: [action] });
    const run = makeActiveRun({
      action,
      state,
      checkpointAccepted: true,
      handoverSummary: 'A detailed substantive checkpoint summary so the handover gate does not interfere here.'
    });

    // MISSING_TOOL: no tool-result event (artifact absent / did-not-run).
    // FAIL_TOOL: a tool-result event whose run status is REJECTED (present but FAIL).
    const failToolOutputRoot = '.pi/tool-output';
    const failToolHandle: ToolEvidenceHandle = {
      schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
      toolName: FAIL_TOOL,
      invocationId: 'inv-fail-tool-1',
      runStatus: 'REJECTED',
      failureCategory: 'INFRA',
      toolOutputRoot: failToolOutputRoot,
      summaryMode: 'none',
      noSummaryReason: 's3wp3 test fixture — REJECTED',
      admittedHarnessFingerprint: 'sha256:test-fp',
      admittedExecutionBoundary: 'bead:bd-test/state:TestState/action:a1',
    };
    const { services, obs, config } = makeRequiredToolServices(
      state,
      [MISSING_TOOL, FAIL_TOOL],
      {
        [MISSING_TOOL]: undefined,
        [FAIL_TOOL]: {
          type: DomainEventName.PROJECT_TOOL_SUCCEEDED,
          data: {
            beadId: 'bd-test',
            stateId: 'TestState',
            actionId: 'a1',
            tool: FAIL_TOOL,
            status: ToolResultStatus.REJECTED,
            outputFile: '.pi/tool-output/bd-test/TestState/a1/fail_tool/inv/out.json',
            evidenceHandle: failToolHandle
          }
        }
      }
    );

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.ready).toBe(false);

    // Per-tool structured state.
    const missingEntry = gate.requiredTools.find(t => t.name === MISSING_TOOL);
    const failEntry = gate.requiredTools.find(t => t.name === FAIL_TOOL);
    expect(missingEntry?.state).toBe('never_invoked');
    expect(failEntry?.state).toBe('failed');

    // The MISSING artifact block names the tool + carries a reason.
    const missingBlock = gate.blockingEvidence.find(e => e.includes(MISSING_TOOL));
    expect(missingBlock).toBeDefined();
    expect(missingBlock).toContain('never invoked');

    // The present-but-FAIL block names the tool + carries a reason.
    const failBlock = gate.blockingEvidence.find(e => e.includes(FAIL_TOOL));
    expect(failBlock).toBeDefined();
    expect(failBlock).toMatch(/did not pass|REJECTED/);

    // toolAuditFailures (reused verbatim by signal_completion) also names both.
    expect(gate.toolAuditFailures.some(f => f.includes(MISSING_TOOL))).toBe(true);
    expect(gate.toolAuditFailures.some(f => f.includes(FAIL_TOOL))).toBe(true);
  });

  it('reports a present + passing required artifact as passed (no block)', async () => {
    const OK_TOOL = 'ok_tool';
    const action = makeAction();
    const state = makeState({ actions: [action] });
    const run = makeActiveRun({
      action,
      state,
      checkpointAccepted: true,
      handoverSummary: 'A detailed substantive checkpoint summary so the handover gate does not interfere here.'
    });

    // Present, status PASSED, and no registered verify() callback ⇒ passes the
    // artifact-presence gate (presence satisfied, no semantic verifier to fail).
    // pi-experiment-yhec: write a real file for the readability check.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3wp3-ok-'));
    try {
    const okOutputFile = path.join(tmpDir, 'ok_tool', 'out.json');
    fs.mkdirSync(path.dirname(okOutputFile), { recursive: true });
    fs.writeFileSync(okOutputFile, '{"ok":true}');
    const okHandle: ToolEvidenceHandle = {
      schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
      toolName: OK_TOOL,
      invocationId: 'inv-ok-tool-1',
      runStatus: 'PASSED',
      semanticArtifactPath: okOutputFile,
      toolOutputRoot: tmpDir,
      summaryMode: 'none',
      noSummaryReason: 's3wp3 test fixture — PASSED',
      admittedHarnessFingerprint: 'sha256:test-fp',
      admittedExecutionBoundary: 'bead:bd-test/state:TestState/action:a1',
    };
    const { services, obs, config } = makeRequiredToolServices(state, [OK_TOOL], {
      [OK_TOOL]: {
        type: DomainEventName.PROJECT_TOOL_SUCCEEDED,
        data: {
          beadId: 'bd-test',
          stateId: 'TestState',
          actionId: 'a1',
          tool: OK_TOOL,
          status: ToolResultStatus.PASSED,
          outputFile: okOutputFile,
          evidenceHandle: okHandle
        }
      }
    });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.requiredTools.find(t => t.name === OK_TOOL)?.state).toBe('passed');
    expect(gate.blockingEvidence.some(e => e.includes(OK_TOOL))).toBe(false);
    expect(gate.ready).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
