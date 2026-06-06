/**
 * pi-experiment-40o9 — enforce required reviewArtifacts.shipPostReview in the
 * completion gate.
 *
 * When settings.reviewArtifacts.shipPostReview.required is true and the active
 * state matches the configured state, both pre_signal_audit(SUCCESS) and
 * signal_completion(SUCCESS) must REJECT until a matching SHIP_POST_REVIEW event
 * exists for the current bead/state/action with artifactKind='shipPostReview'.
 *
 * Acceptance criteria:
 *   AC1 — pre_signal_audit(SUCCESS) REJECTS until a matching SHIP_POST_REVIEW exists.
 *   AC2 — signal_completion(SUCCESS) applies the same rejection (cannot bypass with checklist).
 *   AC3 — submit_review_artifact records deterministic fields the gate matches on.
 *   AC4 — states where required=false or unconfigured keep their current behavior.
 *   AC5 — Tests cover: rejection without the artifact, success with it, and manual-
 *          checklist-only false-progress attempt.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateGateReadiness } from '../src/extension/WorkerRunController.js';
import {
  ActionType,
  BuiltInToolName,
  DomainEventName,
  EnvVars,
  EventName,
  PiEventName,
  ProcessFlag,
  ReviewArtifactKind
} from '../src/constants/index.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import type { SDLCState, TeammateAction } from '../src/core/domain/StateModels.js';
import type { ActiveRun } from '../src/extension/SessionTypes.js';
import type { BeadStateChartProjection } from '../src/core/EventStoreTypes.js';
import orrElseExtension from '../src/extension.js';

// ── handler-level test helper ────────────────────────────────────────────────
// Mirrors the fakePi / HEADLESS_TOOL_CONTEXT pattern used in pi_extension.test.ts
// so AC1/AC2 tests invoke the REAL pre_signal_audit and signal_completion handlers.
function fakePi() {
  const tools: any[] = [];
  const callbacks: Record<string, Function> = {};
  return {
    tools,
    callbacks,
    pi: {
      on: (name: string, callback: Function) => { callbacks[name] = callback; },
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: (_name: string, _options: any) => {},
      getActiveTools: () => [] as string[],
      setActiveTools: (_names: string[]) => {},
      setThinkingLevel: () => {},
      setModel: async () => true,
      sendUserMessage: () => {}
    } as any
  };
}
const HEADLESS_CTX = { hasUI: false, shutdown: () => {} } as any;

// ── shared timestamps for current-run scoping ─────────────────────────────────
// INIT_TIMESTAMP = when the current run started (STATE_RUN_INITIALIZED).
// ARTIFACT_TIMESTAMP = when an artifact was recorded during this run (after init).
// STALE_ARTIFACT_TIMESTAMP = before init — simulates a prior-run artifact.
const INIT_TIMESTAMP = '2024-01-01T10:00:00.000Z';
const ARTIFACT_TIMESTAMP = '2024-01-01T10:05:00.000Z';   // after init
const STALE_ARTIFACT_TIMESTAMP = '2024-01-01T09:55:00.000Z'; // before init

// ── helpers ───────────────────────────────────────────────────────────────────

function makeAction(overrides: Partial<TeammateAction> = {}): TeammateAction {
  return {
    id: 'review',
    type: ActionType.PROMPT,
    ...overrides
  };
}

function makeState(overrides: Partial<SDLCState> = {}): SDLCState {
  return {
    id: 'AdversarialPostReview',
    identity: { role: 'R', expertise: 'E', constraints: [] },
    actions: [],
    transitions: {},
    ...overrides
  } as unknown as SDLCState;
}

/**
 * Make a HarnessConfig with reviewArtifacts.shipPostReview configured.
 * When required=true, the gate must block SUCCESS until a SHIP_POST_REVIEW
 * event is recorded.
 */
function makeConfig(reviewArtifacts?: HarnessConfig['settings']['reviewArtifacts']): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 2,
      handoverTemplate: 'test',
      agentTurnTimeoutMs: 3600000,
      processReapIntervalMs: 60000,
      startState: 'AdversarialPostReview',
      harnessRestartEvent: EventName.HARNESS_RESTART,
      contextRestartEvent: EventName.CONTEXT_RESTART,
      defaultModel: 'gpt-4',
      defaultProvider: 'openai',
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 5,
      reviewArtifacts
    },
    scheduler: { weights: { waitTime: 1, executionTime: 0.5, progress: 2, penalty: 1 } },
    states: {}
  } as unknown as HarnessConfig;
}

/**
 * Build a minimal set of mocked services for evaluateGateReadiness.
 *
 * All advance-outcome sub-gates (checklist, required tools, write-set,
 * transactional, provenance) are mocked to PASS so that the only variable
 * is the reviewArtifacts dimension being tested.
 *
 * reviewArtifacts defaults to an empty array (no artifact recorded).
 */
function makeMinimalServices(stateChartProjection: Partial<BeadStateChartProjection> = {}) {
  const projection: BeadStateChartProjection = {
    beadId: 'bd-test',
    handovers: {},
    completedActionIds: [],
    checkedItems: {},
    addedChecklistItems: [],
    checkpoints: [],
    reviewArtifacts: [],
    transitions: [],
    ...stateChartProjection
  };

  return {
    flowManager: {
      nextState: vi.fn().mockReturnValue('completed')
    },
    eventStore: {
      latestProjectToolFailureLimitEvent: vi.fn().mockResolvedValue(undefined),
      projectBead: vi.fn().mockResolvedValue({ checklists: {} }),
      projectBeadStateChart: vi.fn().mockResolvedValue(projection),
      eventsForBead: vi.fn().mockResolvedValue([
        // promptProvenanceResolutionFailed=true → warn-only, allows completion.
        // timestamp is required for current-run scoping in §5a.
        {
          id: 'evt-init-1',
          type: DomainEventName.STATE_RUN_INITIALIZED,
          timestamp: INIT_TIMESTAMP,
          sessionId: 's1',
          data: {
            beadId: 'bd-test',
            stateId: 'AdversarialPostReview',
            actionId: 'review',
            promptProvenanceResolutionFailed: true
          }
        }
      ])
    },
    requiredToolResolver: {
      resolve: vi.fn().mockResolvedValue({ toolNames: [] })
    },
    planWriteSet: {
      validatePlanContract: vi.fn().mockResolvedValue({ passed: true }),
      resolve: vi.fn().mockResolvedValue({ allowedWriteSet: [] })
    },
    transactionalStateGuard: {
      validateSuccessReadOnly: vi.fn().mockResolvedValue({ passed: true })
    },
    configLoader: {
      load: vi.fn().mockResolvedValue({}),
      getConfigPath: vi.fn().mockReturnValue('/fake/harness.yaml')
    },
    artifactPaths: {
      resolve: vi.fn().mockResolvedValue({ artifactPaths: {} })
    },
    projectRoot: '/fake/root'
  } as any;
}

function makeActiveRun(overrides: Partial<ActiveRun> = {}): ActiveRun {
  const action = makeAction(overrides.action as Partial<TeammateAction> ?? {});
  const state: SDLCState = {
    ...(overrides.state ?? makeState()),
    actions: [action],
    transitions: { SUCCESS: 'completed', FAILURE: 'AdversarialPostReview' }
  };
  return {
    beadId: 'bd-test',
    stateId: 'AdversarialPostReview',
    state,
    action,
    requiredItems: [],
    startedAt: Date.now(),
    worklogManager: { appendEntry: vi.fn() } as any,
    checkpointAccepted: true,   // checkpoint gate passes by default
    parentSequenceCompleted: false,
    completedActionIds: [],
    handoverSummary: undefined,
    ...overrides
  };
}

const obs = {
  getToolResult: vi.fn().mockReturnValue(undefined)
} as any;

// ── AC1 + AC5(a): REJECTS when required=true and no artifact recorded ─────────

describe('reviewArtifacts gate — AC1/AC5a: blocks SUCCESS when required=true and no artifact', () => {
  it('blocks with a descriptive reason identifying the missing SHIP_POST_REVIEW', async () => {
    const config = makeConfig({
      shipPostReview: { state: 'AdversarialPostReview', required: true }
    });
    const run = makeActiveRun();
    // No SHIP_POST_REVIEW recorded — reviewArtifacts is empty
    const services = makeMinimalServices({ reviewArtifacts: [] });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.reviewArtifactSatisfied).toBe(false);
    expect(gate.ready).toBe(false);
    expect(gate.blockingEvidence.some(e =>
      e.includes('SHIP_POST_REVIEW') || e.includes('shipPostReview') || e.includes('review artifact')
    )).toBe(true);
    // Reason must mention the configured state
    expect(gate.blockingEvidence.some(e => e.includes('AdversarialPostReview'))).toBe(true);
  });

  it('blocks when a SHIP_POST_REVIEW exists for a DIFFERENT stateId', async () => {
    const config = makeConfig({
      shipPostReview: { state: 'AdversarialPostReview', required: true }
    });
    const run = makeActiveRun();
    // Artifact recorded for a different state
    const services = makeMinimalServices({
      reviewArtifacts: [{
        eventType: DomainEventName.SHIP_POST_REVIEW,
        artifactKind: ReviewArtifactKind.SHIP_POST_REVIEW,
        stateId: 'OtherState',       // wrong state
        actionId: 'review',
        verdict: 'APPROVED',
        outcome: 'SUCCESS',
        timestamp: ARTIFACT_TIMESTAMP,
        sessionId: 's1'
      }]
    });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.reviewArtifactSatisfied).toBe(false);
    expect(gate.ready).toBe(false);
  });
});

// ── AC1 + AC5(b): PASSES when matching SHIP_POST_REVIEW is recorded ──────────

describe('reviewArtifacts gate — AC1/AC5b: allows SUCCESS when artifact is present', () => {
  it('allows SUCCESS when a matching SHIP_POST_REVIEW exists for the current state', async () => {
    const config = makeConfig({
      shipPostReview: { state: 'AdversarialPostReview', required: true }
    });
    const run = makeActiveRun();
    const services = makeMinimalServices({
      reviewArtifacts: [{
        eventType: DomainEventName.SHIP_POST_REVIEW,
        artifactKind: ReviewArtifactKind.SHIP_POST_REVIEW,
        stateId: 'AdversarialPostReview',
        actionId: 'review',
        verdict: 'APPROVED',
        outcome: 'SUCCESS',
        timestamp: ARTIFACT_TIMESTAMP,
        sessionId: 's1'
      }]
    });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.reviewArtifactSatisfied).toBe(true);
    // With all other gates mocked to pass, gate should be ready
    expect(gate.ready).toBe(true);
    expect(gate.blockingEvidence.some(e =>
      e.includes('SHIP_POST_REVIEW') || e.includes('shipPostReview') || e.includes('review artifact')
    )).toBe(false);
  });

  it('allows SUCCESS when required state is not configured (applies to any state)', async () => {
    // No state filter — artifact for any state satisfies the requirement
    const config = makeConfig({
      shipPostReview: { required: true }  // no state restriction
    });
    const run = makeActiveRun();
    const services = makeMinimalServices({
      reviewArtifacts: [{
        eventType: DomainEventName.SHIP_POST_REVIEW,
        artifactKind: ReviewArtifactKind.SHIP_POST_REVIEW,
        stateId: 'AdversarialPostReview',
        actionId: 'review',
        timestamp: ARTIFACT_TIMESTAMP,
        sessionId: 's1'
      }]
    });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.reviewArtifactSatisfied).toBe(true);
    expect(gate.ready).toBe(true);
  });
});

// ── AC4: unconfigured / required=false keeps current behavior ─────────────────

describe('reviewArtifacts gate — AC4: no block when unconfigured or required=false', () => {
  it('does not block when reviewArtifacts is not configured', async () => {
    const config = makeConfig(undefined); // no reviewArtifacts
    const run = makeActiveRun();
    const services = makeMinimalServices({ reviewArtifacts: [] });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.reviewArtifactSatisfied).toBe(true);
    expect(gate.ready).toBe(true);
  });

  it('does not block when required=false even with no artifact recorded', async () => {
    const config = makeConfig({
      shipPostReview: { state: 'AdversarialPostReview', required: false }
    });
    const run = makeActiveRun();
    const services = makeMinimalServices({ reviewArtifacts: [] });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.reviewArtifactSatisfied).toBe(true);
    expect(gate.ready).toBe(true);
  });

  it('does not block when state is configured for a different state than active', async () => {
    // Active state is AdversarialPostReview but config targets Implementing
    const config = makeConfig({
      shipPostReview: { state: 'Implementing', required: true }
    });
    const run = makeActiveRun(); // stateId: AdversarialPostReview
    const services = makeMinimalServices({ reviewArtifacts: [] });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    // Gate does not apply because active state != configured state
    expect(gate.reviewArtifactSatisfied).toBe(true);
    expect(gate.ready).toBe(true);
  });

  it('reviewArtifactSatisfied=true for non-advance outcomes regardless of config', async () => {
    // FAILURE outcome is not an advance outcome — gate must not fire
    const config = makeConfig({
      shipPostReview: { state: 'AdversarialPostReview', required: true }
    });
    const run = makeActiveRun({ checkpointAccepted: true });
    const services = makeMinimalServices({ reviewArtifacts: [] });

    const gate = await evaluateGateReadiness(run, 'FAILURE', services, { activeRun: run }, obs, config, true);

    // Gate must NOT push to blockingEvidence for FAILURE outcome
    expect(gate.blockingEvidence.some(e =>
      e.includes('SHIP_POST_REVIEW') || e.includes('shipPostReview') || e.includes('review artifact')
    )).toBe(false);
  });
});

// ── AC5(c): manual-checklist-only false-progress cannot bypass the gate ────────

describe('reviewArtifacts gate — AC5c: checklist ticking cannot bypass the gate', () => {
  it('blocks SUCCESS even when all checklist items are ticked but artifact is missing', async () => {
    const config = makeConfig({
      shipPostReview: { state: 'AdversarialPostReview', required: true }
    });
    const run = makeActiveRun({
      requiredItems: [], // no required checklist items (all ticked)
      checkpointAccepted: true
    });
    // No SHIP_POST_REVIEW recorded
    const services = makeMinimalServices({ reviewArtifacts: [] });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    // Checklist is satisfied (no required items), but reviewArtifact is not
    expect(gate.missingChecklistItems).toHaveLength(0);
    expect(gate.reviewArtifactSatisfied).toBe(false);
    expect(gate.ready).toBe(false);
    expect(gate.blockingEvidence.some(e =>
      e.includes('SHIP_POST_REVIEW') || e.includes('shipPostReview') || e.includes('review artifact')
    )).toBe(true);
  });
});

// ── AC3: submit_review_artifact event shape the gate matches on ────────────────

describe('reviewArtifacts gate — AC3: event fields the gate matches on', () => {
  it('matches on artifactKind=shipPostReview and stateId when state is configured', async () => {
    const config = makeConfig({
      shipPostReview: { state: 'AdversarialPostReview', required: true }
    });
    const run = makeActiveRun();
    // Artifact with wrong artifactKind — should NOT satisfy the gate
    const services = makeMinimalServices({
      reviewArtifacts: [{
        eventType: DomainEventName.SHIP_POST_REVIEW,
        artifactKind: 'someOtherKind',   // wrong kind
        stateId: 'AdversarialPostReview',
        actionId: 'review',
        timestamp: ARTIFACT_TIMESTAMP,
        sessionId: 's1'
      }]
    });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.reviewArtifactSatisfied).toBe(false);
    expect(gate.ready).toBe(false);
  });

  it('matches successfully on beadId-scoped projection with correct stateId and artifactKind', async () => {
    const config = makeConfig({
      shipPostReview: { state: 'AdversarialPostReview', required: true }
    });
    const run = makeActiveRun();
    const services = makeMinimalServices({
      reviewArtifacts: [{
        eventType: DomainEventName.SHIP_POST_REVIEW,
        artifactKind: ReviewArtifactKind.SHIP_POST_REVIEW,  // 'shipPostReview'
        stateId: 'AdversarialPostReview',
        actionId: 'review',
        verdict: 'APPROVED',
        outcome: 'SUCCESS',
        timestamp: ARTIFACT_TIMESTAMP,
        sessionId: 's1'
      }]
    });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.reviewArtifactSatisfied).toBe(true);
    expect(gate.ready).toBe(true);
  });

  it('AC3 verdict/outcome: non-advance outcome (FAILURE) on current-run artifact is rejected', async () => {
    const config = makeConfig({
      shipPostReview: { state: 'AdversarialPostReview', required: true }
    });
    const run = makeActiveRun();
    // Artifact is within the current run (timestamp after init) but carries a
    // rejecting outcome — the gate must NOT be satisfied.
    // Use FAILURE which is a known non-advance outcome in the default config.
    const services = makeMinimalServices({
      reviewArtifacts: [{
        eventType: DomainEventName.SHIP_POST_REVIEW,
        artifactKind: ReviewArtifactKind.SHIP_POST_REVIEW,
        stateId: 'AdversarialPostReview',
        actionId: 'review',
        verdict: 'REJECTED',
        outcome: 'FAILURE',   // known non-advance outcome
        timestamp: ARTIFACT_TIMESTAMP,
        sessionId: 's1'
      }]
    });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.reviewArtifactSatisfied).toBe(false);
    expect(gate.ready).toBe(false);
  });

  it('AC3 verdict/outcome: advance outcome (SUCCESS) on current-run artifact satisfies the gate', async () => {
    const config = makeConfig({
      shipPostReview: { state: 'AdversarialPostReview', required: true }
    });
    const run = makeActiveRun();
    const services = makeMinimalServices({
      reviewArtifacts: [{
        eventType: DomainEventName.SHIP_POST_REVIEW,
        artifactKind: ReviewArtifactKind.SHIP_POST_REVIEW,
        stateId: 'AdversarialPostReview',
        actionId: 'review',
        verdict: 'APPROVED',
        outcome: 'SUCCESS',
        timestamp: ARTIFACT_TIMESTAMP,
        sessionId: 's1'
      }]
    });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.reviewArtifactSatisfied).toBe(true);
    expect(gate.ready).toBe(true);
  });

  it('AC3 verdict/outcome: artifact with no outcome field satisfies the gate (outcome-absent = not rejecting)', async () => {
    // When the submitter does not record an outcome, we do not penalise them.
    const config = makeConfig({
      shipPostReview: { state: 'AdversarialPostReview', required: true }
    });
    const run = makeActiveRun();
    const services = makeMinimalServices({
      reviewArtifacts: [{
        eventType: DomainEventName.SHIP_POST_REVIEW,
        artifactKind: ReviewArtifactKind.SHIP_POST_REVIEW,
        stateId: 'AdversarialPostReview',
        actionId: 'review',
        // no outcome field
        timestamp: ARTIFACT_TIMESTAMP,
        sessionId: 's1'
      }]
    });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.reviewArtifactSatisfied).toBe(true);
    expect(gate.ready).toBe(true);
  });
});

// ── LOOP-BACK REGRESSION: stale artifact from prior attempt must not satisfy gate ──

describe('reviewArtifacts gate — loop-back: stale prior-run artifact is rejected', () => {
  it('rejects when the only SHIP_POST_REVIEW was recorded BEFORE the latest STATE_RUN_INITIALIZED', async () => {
    // Scenario: AdversarialPostReview looped (FAILURE → Implementation →
    // AdversarialPostReview). The OLD artifact from the first pass has a
    // timestamp BEFORE the latest STATE_RUN_INITIALIZED for this state.
    // The gate must NOT be satisfied by that stale artifact.
    const config = makeConfig({
      shipPostReview: { state: 'AdversarialPostReview', required: true }
    });
    const run = makeActiveRun();
    const services = makeMinimalServices({
      reviewArtifacts: [{
        eventType: DomainEventName.SHIP_POST_REVIEW,
        artifactKind: ReviewArtifactKind.SHIP_POST_REVIEW,
        stateId: 'AdversarialPostReview',
        actionId: 'review',
        verdict: 'APPROVED',
        outcome: 'SUCCESS',
        // STALE: recorded before the current-run STATE_RUN_INITIALIZED
        timestamp: STALE_ARTIFACT_TIMESTAMP,
        sessionId: 's0'
      }]
    });
    // eventsForBead has a STATE_RUN_INITIALIZED at INIT_TIMESTAMP (after the stale artifact)

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    // The stale artifact must NOT satisfy the gate — gate is blocked
    expect(gate.reviewArtifactSatisfied).toBe(false);
    expect(gate.ready).toBe(false);
    expect(gate.blockingEvidence.some(e =>
      e.includes('SHIP_POST_REVIEW') || e.includes('review artifact')
    )).toBe(true);
  });

  it('accepts when a FRESH artifact (post init) follows the stale one', async () => {
    // Same loop-back scenario but now a fresh artifact was submitted during the
    // current run — the gate must be satisfied.
    const config = makeConfig({
      shipPostReview: { state: 'AdversarialPostReview', required: true }
    });
    const run = makeActiveRun();
    const services = makeMinimalServices({
      reviewArtifacts: [
        {
          // stale (prior run)
          eventType: DomainEventName.SHIP_POST_REVIEW,
          artifactKind: ReviewArtifactKind.SHIP_POST_REVIEW,
          stateId: 'AdversarialPostReview',
          actionId: 'review',
          verdict: 'REJECTED',
          outcome: 'IMPLEMENTATION_DEFECT',
          timestamp: STALE_ARTIFACT_TIMESTAMP,
          sessionId: 's0'
        },
        {
          // fresh (current run — after INIT_TIMESTAMP)
          eventType: DomainEventName.SHIP_POST_REVIEW,
          artifactKind: ReviewArtifactKind.SHIP_POST_REVIEW,
          stateId: 'AdversarialPostReview',
          actionId: 'review',
          verdict: 'APPROVED',
          outcome: 'SUCCESS',
          timestamp: ARTIFACT_TIMESTAMP,
          sessionId: 's1'
        }
      ]
    });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.reviewArtifactSatisfied).toBe(true);
    expect(gate.ready).toBe(true);
  });

  it('rejects when the current-run artifact carries a non-advance outcome (rejecting review)', async () => {
    // Even if the artifact is within the current run, a rejecting outcome must
    // NOT satisfy the gate — you cannot ship with a REJECTED review.
    const config = makeConfig({
      shipPostReview: { state: 'AdversarialPostReview', required: true }
    });
    const run = makeActiveRun();
    const services = makeMinimalServices({
      reviewArtifacts: [{
        eventType: DomainEventName.SHIP_POST_REVIEW,
        artifactKind: ReviewArtifactKind.SHIP_POST_REVIEW,
        stateId: 'AdversarialPostReview',
        actionId: 'review',
        verdict: 'REJECTED',
        outcome: 'FAILURE',   // non-advance → rejecting
        timestamp: ARTIFACT_TIMESTAMP,
        sessionId: 's1'
      }]
    });

    const gate = await evaluateGateReadiness(run, 'SUCCESS', services, { activeRun: run }, obs, config, true);

    expect(gate.reviewArtifactSatisfied).toBe(false);
    expect(gate.ready).toBe(false);
  });
});

// ── AC1 handler-level: pre_signal_audit REJECTS when artifact is missing ──────

describe('reviewArtifacts gate — AC1 handler-level: pre_signal_audit blocks missing artifact', () => {
  it('pre_signal_audit returns ready:false with SHIP_POST_REVIEW blocking evidence when required and missing', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-psa-review-artifact-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: AdversarialPostReview
  reviewArtifacts:
    shipPostReview:
      required: true
      state: AdversarialPostReview
      store: eventStore
  worktreePolicy:
    default: always
states:
  AdversarialPostReview:
    identity: { role: "Reviewer", expertise: "Adversarial review", constraints: [] }
    baseInstructions: "Review"
    actions:
      - id: review
        type: prompt
        prompt: "Review"
    transitions: { SUCCESS: completed, FAILURE: AdversarialPostReview }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-psa-review-ac1';
      process.env[EnvVars.STATE_ID] = 'AdversarialPostReview';
      process.env[EnvVars.ACTION_ID] = 'review';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const preSignalAudit = harness.tools.find((t: any) => t.name === BuiltInToolName.PRE_SIGNAL_AUDIT);
      expect(preSignalAudit).toBeDefined();

      // Do NOT call submit_review_artifact — the gate must block
      const auditResult = await preSignalAudit.execute('audit-call', {}, undefined, undefined, HEADLESS_CTX);
      const audit = auditResult.details;

      expect(audit.ready).toBe(false);
      // reviewArtifactSatisfied is an internal gate field not exposed by pre_signal_audit;
      // assert via ready:false and blockingEvidence instead.
      expect(audit.blockingEvidence.some((e: string) =>
        e.includes('SHIP_POST_REVIEW') || e.includes('review artifact') || e.includes('shipPostReview')
      )).toBe(true);
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnv.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnv.workerMode;
      if (previousEnv.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnv.beadId;
      if (previousEnv.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnv.stateId;
      if (previousEnv.actionId === undefined) delete process.env[EnvVars.ACTION_ID];
      else process.env[EnvVars.ACTION_ID] = previousEnv.actionId;
      if (previousEnv.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnv.projectRoot;
      if (previousEnv.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnv.worktreePath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ── AC2 handler-level: signal_completion REJECTS when artifact is missing ─────

describe('reviewArtifacts gate — AC2 handler-level: signal_completion blocks missing artifact', () => {
  it('signal_completion returns REJECTED mentioning SHIP_POST_REVIEW when required artifact is absent', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-sc-review-artifact-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: AdversarialPostReview
  reviewArtifacts:
    shipPostReview:
      required: true
      state: AdversarialPostReview
      store: eventStore
  worktreePolicy:
    default: always
states:
  AdversarialPostReview:
    identity: { role: "Reviewer", expertise: "Adversarial review", constraints: [] }
    baseInstructions: "Review"
    actions:
      - id: review
        type: prompt
        prompt: "Review"
    transitions: { SUCCESS: completed, FAILURE: AdversarialPostReview }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-sc-review-ac2';
      process.env[EnvVars.STATE_ID] = 'AdversarialPostReview';
      process.env[EnvVars.ACTION_ID] = 'review';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const submitCheckpoint = harness.tools.find((t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find((t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION);
      expect(submitCheckpoint).toBeDefined();
      expect(signalCompletion).toBeDefined();

      // Submit a checkpoint so that gate is not blocked by the checkpoint gate
      await submitCheckpoint.execute('ckpt', { summary: 'review done', evidence: 'evidence' }, undefined, undefined, HEADLESS_CTX);

      // Do NOT call submit_review_artifact — signal_completion must REJECT
      const result = await signalCompletion.execute('sc', { outcome: 'SUCCESS', summary: 'done' }, undefined, undefined, HEADLESS_CTX);

      expect(result.details).toMatch(/^REJECTED:/);
      expect(result.details).toMatch(/SHIP_POST_REVIEW|review artifact|shipPostReview/);
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnv.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnv.workerMode;
      if (previousEnv.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnv.beadId;
      if (previousEnv.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnv.stateId;
      if (previousEnv.actionId === undefined) delete process.env[EnvVars.ACTION_ID];
      else process.env[EnvVars.ACTION_ID] = previousEnv.actionId;
      if (previousEnv.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnv.projectRoot;
      if (previousEnv.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnv.worktreePath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('AC2: a ticked checklist does NOT bypass the reviewArtifacts gate', async () => {
    // This test specifically addresses the AC2 requirement: even if all checklist
    // items are ticked, signal_completion must still REJECT when the review
    // artifact is missing.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-sc-checklist-bypass-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: AdversarialPostReview
  reviewArtifacts:
    shipPostReview:
      required: true
      state: AdversarialPostReview
      store: eventStore
  worktreePolicy:
    default: always
states:
  AdversarialPostReview:
    identity: { role: "Reviewer", expertise: "Adversarial review", constraints: [] }
    baseInstructions: "Review"
    actions:
      - id: review
        type: prompt
        prompt: "Review"
    transitions: { SUCCESS: completed, FAILURE: AdversarialPostReview }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-sc-checklist-bypass';
      process.env[EnvVars.STATE_ID] = 'AdversarialPostReview';
      process.env[EnvVars.ACTION_ID] = 'review';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const submitCheckpoint = harness.tools.find((t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find((t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION);
      expect(submitCheckpoint).toBeDefined();
      expect(signalCompletion).toBeDefined();

      // Submit checkpoint — no required checklist items in this config, so checklist is satisfied
      await submitCheckpoint.execute('ckpt', { summary: 'all done', evidence: 'evidence' }, undefined, undefined, HEADLESS_CTX);

      // Still no review artifact — gate must block despite clean checklist
      const result = await signalCompletion.execute('sc', { outcome: 'SUCCESS', summary: 'done' }, undefined, undefined, HEADLESS_CTX);

      expect(result.details).toMatch(/^REJECTED:/);
      expect(result.details).toMatch(/SHIP_POST_REVIEW|review artifact|shipPostReview/);
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnv.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnv.workerMode;
      if (previousEnv.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnv.beadId;
      if (previousEnv.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnv.stateId;
      if (previousEnv.actionId === undefined) delete process.env[EnvVars.ACTION_ID];
      else process.env[EnvVars.ACTION_ID] = previousEnv.actionId;
      if (previousEnv.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnv.projectRoot;
      if (previousEnv.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnv.worktreePath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
