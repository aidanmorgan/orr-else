/**
 * pi-experiment-jvx3: Code-owned LLM responsibility matrix — adversarial false-progress tests.
 *
 * This file has two parts:
 *
 * PART 1 — MATRIX INTEGRITY (load-bearing structure checks)
 *   Proves the typed matrix is complete, all deterministic-only domains are named,
 *   and every entry references a real guardFile/guardSymbol.
 *
 * PART 2 — ADVERSARIAL FALSE-PROGRESS TESTS
 *   Three adversarial scenarios prove the boundary holds over the REAL code paths:
 *
 *   (a) PROSE-CLAIM-WITHOUT-ROUTE-EVENT: an LLM "I completed / transition to X" prose
 *       claim WITHOUT a route event + validated artifact → does NOT advance state.
 *       LOAD-BEARING: test fails if the ROUTE_EVENT_EMITTED gate in projectV2Transitions
 *       is removed (emitterType guard bypassed → model-authored fields advance state).
 *
 *   (b) REVIEW-PROSE-WITHOUT-GATE: review-approval prose ("looks good, approved") WITHOUT
 *       a verifier-gate pass / validated artifact → does NOT satisfy the gate.
 *       LOAD-BEARING: test fails if runVerifierGate is bypassed (approval prose substituted).
 *
 *   (c) COMPACTION-SUMMARY-NON-AUTHORITATIVE: a compaction summary (nonAuthoritative: true)
 *       is NOT authoritative for progress even when it claims a state has been completed.
 *       LOAD-BEARING: test fails if replayProjectV2Transitions treats
 *       COMPACTION_SUMMARY_RECORDED as a route event.
 *
 * Each LOAD-BEARING test includes a mutation comment naming the exact guard whose removal
 * would cause the test to fail — confirming the guard, not just describing it.
 *
 * VERSION-GATED: all v2-path tests use v2 vocabulary and route-event machinery.
 * v1/cerdiwen are completely unaffected.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  RESPONSIBILITY_MATRIX,
  RESPONSIBILITY_MAP,
  DETERMINISTIC_ONLY_DOMAINS,
  type AuthorityDomain,
} from '../src/core/LlmResponsibilityMatrix.js';

import {
  projectV2Transitions,
  replayProjectV2Transitions,
  applyV2RouteEvent,
  type ProjectableEvent,
  type RouteEventStore,
  type RouteEvidenceRef,
} from '../src/core/RouteEventContract.js';

import {
  runVerifierGate,
  type VerifierGateContext,
  type VerifierGateEventStore,
} from '../src/core/VerifierGate.js';

import { ConfigLoader } from '../src/core/ConfigLoader.js';

import { VerifyVerdict, type VerifyContext, type VerifyResult } from '../src/contract.js';

import {
  buildCompactionSummaryPointerPayload,
  buildCompactionSummary,
} from '../src/core/CompactionSummary.js';

import { DomainEventName } from '../src/constants/domain.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';
import type { BeadId, StateId, ActionId, ToolName } from '../src/types/ids.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal v2 vocabulary for projection tests. */
const V2_VOCAB = new Map<string, string>([
  ['PLAN_ACCEPTED', 'advance'],
  ['PLAN_REJECTED', 'failure'],
  ['BLOCKED', 'blocked'],
  ['SUCCESS', 'advance'],
  ['FAILURE', 'failure'],
]);

/** State with one transition: PLAN_ACCEPTED → completed. */
const STATES: Record<string, { transitions?: Record<string, string> }> = {
  implement: { transitions: { PLAN_ACCEPTED: 'completed', SUCCESS: 'completed' } },
  completed: {},
};

function stateFor(stateId: string) {
  return STATES[stateId];
}

/** A stable evidence ref (satisfies byteCount + sha256 requirements). */
const VALID_EVIDENCE_REF: RouteEvidenceRef = {
  semanticPath: 'artifacts/plan.json',
  byteCount: 512,
  sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
};

/** Minimal in-memory event store for route event tests. */
function makeStore(): { store: RouteEventStore; recorded: Array<{ type: string; data: unknown }> } {
  const recorded: Array<{ type: string; data: unknown }> = [];
  const store: RouteEventStore = {
    async record(event: string, data: unknown): Promise<void> {
      recorded.push({ type: event, data });
    },
  };
  return { store, recorded };
}

/** Build a valid ROUTE_EVENT_EMITTED projectable event (from a deterministic emitter). */
function makeValidRouteEvent(overrides: Partial<Record<string, unknown>> = {}): ProjectableEvent {
  return {
    type: DomainEventName.ROUTE_EVENT_EMITTED,
    data: {
      schemaId: 'harness.event.routeEventEmitted',
      schemaVersion: '1.0.0',
      configVersion: 2,
      configFingerprint: 'test-fingerprint-abc',
      beadId: 'bead-001',
      stateId: 'implement',
      actionId: 'verify-plan',
      runId: 'run-001',
      emitterType: 'verifier',
      emitterId: 'plan-verifier',
      eventName: 'PLAN_ACCEPTED',
      category: 'advance',
      evidenceRefs: [VALID_EVIDENCE_REF],
      routeEventId: 'route-evt-001',
      ...overrides,
    },
  };
}

// ===========================================================================
// PART 1: Matrix integrity checks
// ===========================================================================

describe('pi-experiment-jvx3 — responsibility matrix integrity', () => {
  it('matrix is non-empty and all entries have required fields', () => {
    expect(RESPONSIBILITY_MATRIX.length).toBeGreaterThan(0);
    for (const entry of RESPONSIBILITY_MATRIX) {
      expect(entry.domain).toBeTruthy();
      expect(typeof entry.allowed).toBe('boolean');
      expect(entry.guardFile).toBeTruthy();
      expect(entry.guardSymbol).toBeTruthy();
      expect(entry.note).toBeTruthy();
    }
  });

  it('every AuthorityDomain listed in the union has exactly one matrix entry', () => {
    // Enumerate every domain that appears in RESPONSIBILITY_MAP.
    // The compile-time check in LlmResponsibilityMatrix.ts verifies
    // completeness statically; this test verifies it at runtime too.
    const expectedDomains: AuthorityDomain[] = [
      'stateTransitions',
      'routeEventSelection',
      'requiredToolSatisfaction',
      'artifactValidation',
      'schemaValidation',
      'rtkSummaries',
      'traceability',
      'testPassFail',
      'eventReplay',
      'startupReadiness',
      'budgetEnforcement',
      'loopDetection',
      'planningReviewExplain',
      'codeEditsUnderGuards',
    ];
    for (const domain of expectedDomains) {
      expect(RESPONSIBILITY_MAP.has(domain), `missing matrix entry for domain: ${domain}`).toBe(true);
    }
    // No extra domains.
    expect(RESPONSIBILITY_MAP.size).toBe(expectedDomains.length);
  });

  it('deterministic-only domains (allowed: false) are enumerated in DETERMINISTIC_ONLY_DOMAINS', () => {
    const matrixFalse = RESPONSIBILITY_MATRIX.filter(e => !e.allowed).map(e => e.domain);
    for (const d of matrixFalse) {
      expect(DETERMINISTIC_ONLY_DOMAINS.has(d)).toBe(true);
    }
    expect(DETERMINISTIC_ONLY_DOMAINS.size).toBe(matrixFalse.length);
  });

  it('stateTransitions entry is deterministic-only and names the real guard', () => {
    const entry = RESPONSIBILITY_MAP.get('stateTransitions');
    expect(entry).toBeDefined();
    expect(entry!.allowed).toBe(false);
    expect(entry!.guardFile).toBe('src/core/RouteEventContract.ts');
    expect(entry!.guardSymbol).toContain('projectV2Transitions');
  });

  it('routeEventSelection entry is deterministic-only and names the real guard', () => {
    const entry = RESPONSIBILITY_MAP.get('routeEventSelection');
    expect(entry).toBeDefined();
    expect(entry!.allowed).toBe(false);
    expect(entry!.guardFile).toBe('src/core/ActionRouteEventEmitter.ts');
    expect(entry!.guardSymbol).toContain('emitActionRouteEvent');
  });

  it('requiredToolSatisfaction entry is deterministic-only and names VerifierGate', () => {
    const entry = RESPONSIBILITY_MAP.get('requiredToolSatisfaction');
    expect(entry).toBeDefined();
    expect(entry!.allowed).toBe(false);
    expect(entry!.guardFile).toBe('src/core/VerifierGate.ts');
    expect(entry!.guardSymbol).toContain('runVerifierGate');
  });

  it('eventReplay entry is deterministic-only and names replayProjectV2Transitions', () => {
    const entry = RESPONSIBILITY_MAP.get('eventReplay');
    expect(entry).toBeDefined();
    expect(entry!.allowed).toBe(false);
    expect(entry!.guardFile).toBe('src/core/RouteEventContract.ts');
    expect(entry!.guardSymbol).toContain('replayProjectV2Transitions');
  });

  it('loopDetection entry is deterministic-only and names LoopDetector', () => {
    const entry = RESPONSIBILITY_MAP.get('loopDetection');
    expect(entry).toBeDefined();
    expect(entry!.allowed).toBe(false);
    expect(entry!.guardFile).toBe('src/core/LoopDetector.ts');
    expect(entry!.guardSymbol).toContain('LoopDetector');
  });

  it('budgetEnforcement entry is deterministic-only and names RuntimeBudgetTracker', () => {
    const entry = RESPONSIBILITY_MAP.get('budgetEnforcement');
    expect(entry).toBeDefined();
    expect(entry!.allowed).toBe(false);
    expect(entry!.guardFile).toBe('src/core/RuntimeBudgetTracker.ts');
    expect(entry!.guardSymbol).toContain('RuntimeBudgetTracker');
  });

  it('planningReviewExplain entry is LLM-allowed (but bounded)', () => {
    const entry = RESPONSIBILITY_MAP.get('planningReviewExplain');
    expect(entry).toBeDefined();
    expect(entry!.allowed).toBe(true);
  });

  it('codeEditsUnderGuards entry is LLM-allowed (but bounded)', () => {
    const entry = RESPONSIBILITY_MAP.get('codeEditsUnderGuards');
    expect(entry).toBeDefined();
    expect(entry!.allowed).toBe(true);
  });
});

// ===========================================================================
// PART 2(a): ADVERSARIAL — prose claim without route event does NOT advance
// ===========================================================================

describe('pi-experiment-jvx3 AC3(a) — prose claim without route event does NOT advance', () => {
  /**
   * LOAD-BEARING test (a): model-authored transition claim is ignored.
   *
   * Scenario: The LLM emits a domain event that looks like a route event but has
   * emitterType: 'model' (not a valid deterministic emitter class). The projector
   * must ignore it — state stays at 'implement', not 'completed'.
   *
   * MUTATION PROOF: If the emitterType guard in projectV2Transitions were removed
   * (i.e. if VALID_EMITTER_TYPES check were deleted), the model-authored event would
   * be treated as a valid route event and the state would advance to 'completed'.
   * This test would then fail on `expect(transitions).toHaveLength(0)`.
   *
   * The guard is at RouteEventContract.ts in projectV2Transitions, line:
   *   const VALID_EMITTER_TYPES = new Set(['tool','verifier','gate','systemPrecondition'])
   *   if (!VALID_EMITTER_TYPES.has(emitterType)) { continue; }
   */
  it(
    'LOAD-BEARING: model-authored ROUTE_EVENT_EMITTED with emitterType="model" is ignored by projection',
    () => {
      // A malicious model-authored event: the model wrote a ROUTE_EVENT_EMITTED record
      // claiming emitterType: 'model' and eventName: 'PLAN_ACCEPTED' (advance event).
      const modelAuthoredEvent: ProjectableEvent = {
        type: DomainEventName.ROUTE_EVENT_EMITTED,
        data: {
          schemaId: 'harness.event.routeEventEmitted',
          schemaVersion: '1.0.0',
          configVersion: 2,
          configFingerprint: 'test-fingerprint-abc',
          beadId: 'bead-001',
          stateId: 'implement',
          actionId: 'do-something',
          runId: 'run-001',
          // 'model' is NOT a valid EmitterType — deterministic emitters are:
          // 'tool' | 'verifier' | 'gate' | 'systemPrecondition'
          emitterType: 'model',
          emitterId: 'gpt-llm-claim',
          eventName: 'PLAN_ACCEPTED',  // advance event
          category: 'advance',
          evidenceRefs: [],
          routeEventId: 'fake-route-evt-001',
        },
      };

      const transitions = projectV2Transitions(
        [modelAuthoredEvent],
        V2_VOCAB,
        stateFor
      );

      // Guard: no transitions applied — the model-authored emitterType is rejected.
      // MUTATION: remove `!VALID_EMITTER_TYPES.has(emitterType)` guard →
      //   transitions.length becomes 1 and this assertion fails.
      expect(transitions).toHaveLength(0);
    }
  );

  it(
    'LOAD-BEARING: prose-style "outcome" event (non-ROUTE_EVENT_EMITTED type) is completely invisible to projection',
    () => {
      // Scenario: An old-style/model-authored event with a type that sounds like
      // it might convey a transition (e.g. the model writes some status update),
      // but is NOT ROUTE_EVENT_EMITTED. The projector MUST ignore it.
      const proseClaimEvent: ProjectableEvent = {
        type: 'AGENT_OUTCOME',  // not ROUTE_EVENT_EMITTED
        data: {
          outcome: 'SUCCESS',
          beadId: 'bead-001',
          stateId: 'implement',
          // Even if this contains all the right fields, it's not a route event
          eventName: 'PLAN_ACCEPTED',
          emitterType: 'tool',
          routeEventId: 'fake-route-evt-002',
        },
      };

      const transitions = projectV2Transitions(
        [proseClaimEvent],
        V2_VOCAB,
        stateFor
      );

      // Guard: non-ROUTE_EVENT_EMITTED events are unconditionally skipped.
      // MUTATION: remove the `event.type !== DomainEventName.ROUTE_EVENT_EMITTED` check →
      //   the projector would try to parse proseClaimEvent as a route event,
      //   potentially advancing state. This assertion would fail.
      expect(transitions).toHaveLength(0);
    }
  );

  it(
    'LOAD-BEARING: valid route event from a deterministic emitter DOES advance state (positive control)',
    () => {
      // Positive control: a properly-formed ROUTE_EVENT_EMITTED from a deterministic
      // emitter DOES produce a transition. This confirms the guard is selective, not broken.
      const validEvent = makeValidRouteEvent();

      const transitions = projectV2Transitions(
        [validEvent],
        V2_VOCAB,
        stateFor
      );

      // The valid event from a deterministic emitter DOES advance.
      expect(transitions).toHaveLength(1);
      expect(transitions[0]!.eventName).toBe('PLAN_ACCEPTED');
      expect(transitions[0]!.emitterType).toBe('verifier');
      expect(transitions[0]!.nextState).toBe('completed');
    }
  );

  it(
    'LOAD-BEARING: model-authored event quarantined by replayProjectV2Transitions — state does not advance',
    () => {
      // Same scenario as above but using the quarantining replay projector (e8cm).
      // A ROUTE_EVENT_EMITTED with emitterType: 'model' must be QUARANTINED
      // (SCHEMA_INVALID reason) and the state must NOT advance.
      //
      // MUTATION PROOF: If the SCHEMA_INVALID quarantine gate were removed from
      // replayProjectV2Transitions, the model-authored event would advance state
      // and the finalState assertion would fail.
      const modelAuthoredEvent: ProjectableEvent = {
        type: DomainEventName.ROUTE_EVENT_EMITTED,
        data: {
          schemaId: 'harness.event.routeEventEmitted',
          schemaVersion: '1.0.0',
          configVersion: 2,
          configFingerprint: 'fp-replay',
          beadId: 'bead-001',
          stateId: 'implement',
          actionId: 'do-something',
          runId: 'run-001',
          emitterType: 'model',   // invalid — not a deterministic emitter class
          emitterId: 'llm-claim',
          eventName: 'PLAN_ACCEPTED',
          category: 'advance',
          evidenceRefs: [],
          routeEventId: 'fake-replay-evt',
        },
      };

      const result = replayProjectV2Transitions(
        [modelAuthoredEvent],
        V2_VOCAB,
        stateFor,
        { initialState: 'implement' }
      );

      // State did NOT advance.
      expect(result.finalState).toBe('implement');
      // The model-authored event was quarantined.
      expect(result.quarantineDiagnostics).toHaveLength(1);
      expect(result.quarantineDiagnostics[0]!.reason).toBe('SCHEMA_INVALID');
      // No applied transitions.
      expect(result.appliedTransitions).toHaveLength(0);
    }
  );

  it(
    'LOAD-BEARING: route event missing routeEventId does not advance state (AC guard: routeEventId required)',
    () => {
      // A ROUTE_EVENT_EMITTED record that is otherwise well-formed but lacks routeEventId.
      // The projector requires routeEventId to link to STATE_TRANSITION_APPLIED.
      // Without it the event is skipped.
      //
      // MUTATION PROOF: If the `routeEventId.length === 0` check were removed from
      // projectV2Transitions, a routeEventId-less event could advance state.
      const noRouteIdEvent: ProjectableEvent = makeValidRouteEvent({ routeEventId: undefined });

      const transitions = projectV2Transitions(
        [noRouteIdEvent],
        V2_VOCAB,
        stateFor
      );

      // No transition: routeEventId is required.
      expect(transitions).toHaveLength(0);
    }
  );

  it(
    'LOAD-BEARING: route event with missing evidence (no byteCount + sha256) is rejected before projection',
    async () => {
      // An emitter that provides a route event but with invalid evidence refs
      // (missing byteCount) is rejected by applyV2RouteEvent BEFORE any projection.
      //
      // MUTATION PROOF: If validateEvidenceRefs were removed from applyV2RouteEvent,
      // invalid evidence would pass through and applyV2RouteEvent would return emitted:true.
      const { store } = makeStore();
      const invalidRef: RouteEvidenceRef = {
        semanticPath: 'artifacts/plan.json',
        byteCount: -1,  // invalid: negative
        sha256: '',     // invalid: empty
      };

      const result = await applyV2RouteEvent(
        {
          beadId: 'bead-001',
          stateId: 'implement',
          actionId: 'verify-plan',
          runId: 'run-001',
          emitterType: 'verifier',
          emitterId: 'plan-verifier',
          eventName: 'PLAN_ACCEPTED',
          evidenceRefs: [invalidRef],
          configFingerprint: 'fp-evidence-test',
          v2Vocab: V2_VOCAB,
          v2NextState: 'completed',
        },
        store
      );

      // Rejected before projection — INVALID_EVIDENCE.
      // MUTATION: remove validateEvidenceRefs call → result.emitted becomes true.
      expect(result.emitted).toBe(false);
      expect(result.rejectReason).toBe('INVALID_EVIDENCE');
    }
  );
});

// ===========================================================================
// PART 2(b): ADVERSARIAL — review-approval prose without gate does NOT satisfy
// ===========================================================================

describe('pi-experiment-jvx3 AC3(b) — review-approval prose without verifier-gate pass does NOT satisfy gate', () => {
  /**
   * LOAD-BEARING test (b): "looks good, approved" prose cannot satisfy a verifier gate.
   *
   * Scenario: A required tool was never invoked (no tool-result event exists).
   * The model claims approval in prose, but the verifier gate must fail CLOSED
   * because no event is present for the required tool.
   *
   * MUTATION PROOF: If the TOOL_NOT_INVOKED check in runVerifierGate were removed
   * (i.e. if missing events were silently allowed), the gate would return pass=true.
   * This test would then fail on `expect(result.pass).toBe(false)`.
   *
   * The guard is at VerifierGate.ts in runVerifierGate:
   *   if (!event) {
   *     failures.push({ tool, kind: VerifierGateBlockKind.TOOL_NOT_INVOKED, ... });
   *     continue;
   *   }
   */
  it(
    'LOAD-BEARING: required tool with no event (never invoked) blocks the gate — review prose cannot substitute',
    async () => {
      // An event store that has no tool-result event for any tool.
      const emptyStore: VerifierGateEventStore = {
        async latestToolResultEvent(
          _beadId: BeadId,
          _stateId: StateId,
          _actionId: ActionId,
          _tool: ToolName
        ): Promise<DomainEvent | undefined> {
          return undefined;
        },
      };

      const ctx: VerifierGateContext = {
        beadId: 'bead-001' as BeadId,
        stateId: 'review' as StateId,
        actionId: 'verify-review' as ActionId,
        writeSet: [],
        artifacts: {},
      };

      // No registered verify() callbacks — registry is empty (default verifier).
      const result = await runVerifierGate(
        ctx,
        ['review_tool'],   // required tool
        emptyStore
      );

      // Gate MUST fail closed — the tool was never invoked.
      // MUTATION: remove the `if (!event)` guard → result.pass becomes true
      //   (the gate skips missing tools). This assertion fails.
      expect(result.pass).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]!.kind).toBe('TOOL_NOT_INVOKED');
    }
  );

  it(
    'LOAD-BEARING: a tool event with REJECTED status blocks the gate — approval prose cannot substitute',
    async () => {
      // A tool ran but got REJECTED. The model might claim "looks good" in prose,
      // but the gate reads the actual event status and fails closed.
      const rejectedEvent: DomainEvent = {
        id: 'evt-rejected',
        type: DomainEventName.PROJECT_TOOL_FAILED,
        data: {
          tool: 'review_tool',
          evidenceHandle: {
            schemaVersion: '1.0.0',
            toolName: 'review_tool',
            invocationId: 'inv-001',
            runStatus: 'REJECTED',
            failureCategory: 'TRANSPORT',
            toolOutputRoot: '/tmp/tools',
            summaryMode: 'none',
            noSummaryReason: 'tool rejected',
            admittedHarnessFingerprint: 'fp-test',
            admittedExecutionBoundary: 'bead-001/review/verify-review',
          },
        },
        timestamp: new Date().toISOString(),
      };

      const singleToolStore: VerifierGateEventStore = {
        async latestToolResultEvent(
          _beadId: BeadId,
          _stateId: StateId,
          _actionId: ActionId,
          tool: ToolName
        ): Promise<DomainEvent | undefined> {
          return tool === 'review_tool' ? rejectedEvent : undefined;
        },
      };

      const ctx: VerifierGateContext = {
        beadId: 'bead-001' as BeadId,
        stateId: 'review' as StateId,
        actionId: 'verify-review' as ActionId,
        writeSet: [],
        artifacts: {},
      };

      const result = await runVerifierGate(ctx, ['review_tool'], singleToolStore);

      // Gate MUST fail closed — tool was REJECTED.
      // MUTATION: remove the `statusClass === 'REJECTED'` guard in runVerifierGate →
      //   result.pass becomes true. This assertion fails.
      expect(result.pass).toBe(false);
      expect(result.failures[0]!.kind).toBe('TOOL_REJECTED');
    }
  );

  it(
    'LOAD-BEARING: verify() callback returning FAIL blocks the gate — override prose cannot substitute',
    async () => {
      // A tool ran PASSED and has a valid evidenceHandle, but its verify() returns FAIL.
      // The model might claim "the review passed", but the gate uses the verify() verdict.
      const passedEvent: DomainEvent = {
        id: 'evt-passed',
        type: DomainEventName.PROJECT_TOOL_SUCCEEDED,
        data: {
          tool: 'review_tool',
          evidenceHandle: {
            schemaVersion: '1.0.0',
            toolName: 'review_tool',
            invocationId: 'inv-002',
            runStatus: 'PASSED',
            semanticArtifactPath: '/tmp/tools/review_tool/review.json',
            semanticArtifactBytes: 256,
            semanticArtifactSha256: 'aabbcc',
            toolOutputRoot: '/tmp/tools',
            summaryMode: 'none',
            noSummaryReason: 'no summary produced',
            admittedHarnessFingerprint: 'fp-test',
            admittedExecutionBoundary: 'bead-001/review/verify-review',
          },
        },
        timestamp: new Date().toISOString(),
      };

      const passedToolStore: VerifierGateEventStore = {
        async latestToolResultEvent(
          _beadId: BeadId,
          _stateId: StateId,
          _actionId: ActionId,
          tool: ToolName
        ): Promise<DomainEvent | undefined> {
          return tool === 'review_tool' ? passedEvent : undefined;
        },
      };

      const ctx: VerifierGateContext = {
        beadId: 'bead-001' as BeadId,
        stateId: 'review' as StateId,
        actionId: 'verify-review' as ActionId,
        writeSet: [],
        artifacts: {},
      };

      // The verify() callback that always returns FAIL (models "review checks failed").
      const failingVerifyCallback = async (_ctx: VerifyContext): Promise<VerifyResult> => ({
        verdict: VerifyVerdict.FAIL,
        reasons: ['review_tool: required checks not met'],
      });

      // Registry: only 'review_tool' → failingVerifyCallback.
      const testRegistry = { get: (name: string) => name === 'review_tool' ? failingVerifyCallback : undefined };

      const result = await runVerifierGate(
        ctx,
        ['review_tool'],
        passedToolStore,
        { registry: testRegistry }
      );

      // Gate MUST fail closed — the verify() returned FAIL.
      // MUTATION: remove the `result.verdict === VerifyVerdict.FAIL` check →
      //   result.pass becomes true. This assertion fails.
      expect(result.pass).toBe(false);
      expect(result.failures[0]!.kind).toBe('VERIFY_FAIL');
      expect(result.failures[0]!.verdict).toBe(VerifyVerdict.FAIL);
    }
  );

  it(
    'LOAD-BEARING: verify() returning PASS with validated evidence does satisfy the gate (positive control)',
    async () => {
      // Positive control: a valid tool event + verify() returning PASS → gate passes.
      // This confirms the gate is selective, not universally broken.
      const passedEvent: DomainEvent = {
        id: 'evt-passed-ok',
        type: DomainEventName.PROJECT_TOOL_SUCCEEDED,
        data: {
          tool: 'review_tool',
          evidenceHandle: {
            schemaVersion: '1.0.0',
            toolName: 'review_tool',
            invocationId: 'inv-003',
            runStatus: 'PASSED',
            semanticArtifactPath: '/tmp/tools/review_tool/review-ok.json',
            semanticArtifactBytes: 512,
            semanticArtifactSha256: 'aabbccdd',
            toolOutputRoot: '/tmp/tools',
            summaryMode: 'none',
            noSummaryReason: 'no summary produced',
            admittedHarnessFingerprint: 'fp-test',
            admittedExecutionBoundary: 'bead-001/review/verify-review',
          },
        },
        timestamp: new Date().toISOString(),
      };

      const okToolStore: VerifierGateEventStore = {
        async latestToolResultEvent(
          _beadId: BeadId,
          _stateId: StateId,
          _actionId: ActionId,
          tool: ToolName
        ): Promise<DomainEvent | undefined> {
          return tool === 'review_tool' ? passedEvent : undefined;
        },
      };

      const ctx: VerifierGateContext = {
        beadId: 'bead-001' as BeadId,
        stateId: 'review' as StateId,
        actionId: 'verify-review' as ActionId,
        writeSet: [],
        artifacts: {},
      };

      const passingVerify = async (_ctx: VerifyContext): Promise<VerifyResult> => ({
        verdict: VerifyVerdict.PASS,
        reasons: ['all checks passed'],
      });
      const okRegistry = { get: (name: string) => name === 'review_tool' ? passingVerify : undefined };

      const result = await runVerifierGate(ctx, ['review_tool'], okToolStore, { registry: okRegistry });

      // Gate passes — verify() returned PASS, event is PASSED.
      expect(result.pass).toBe(true);
      expect(result.failures).toHaveLength(0);
    }
  );
});

// ===========================================================================
// PART 2(c): ADVERSARIAL — compaction summary is non-authoritative for progress
// ===========================================================================

describe('pi-experiment-jvx3 AC3(c) — compaction summary is non-authoritative for progress', () => {
  /**
   * LOAD-BEARING test (c): compaction/branch summary is NOT authoritative for progress.
   *
   * Scenario: The event log contains a COMPACTION_SUMMARY_RECORDED event claiming
   * that the bead has completed state transitions. The replay projector must ignore
   * it — only ROUTE_EVENT_EMITTED records from deterministic emitters advance state.
   *
   * MUTATION PROOF: If replayProjectV2Transitions treated COMPACTION_SUMMARY_RECORDED
   * as a route event (i.e. removed the `event.type !== ROUTE_EVENT_EMITTED` gate),
   * the state might be advanced based on summary content. The finalState assertion
   * would fail — it would show 'completed' instead of 'implement'.
   *
   * The guard is at RouteEventContract.ts in replayProjectV2Transitions, line:
   *   if (event.type !== DomainEventName.ROUTE_EVENT_EMITTED) { continue; }
   */
  it(
    'LOAD-BEARING: COMPACTION_SUMMARY_RECORDED is invisible to replay projection — state stays at initialState',
    () => {
      // Build a compaction summary artifact in-memory.
      const summary = buildCompactionSummary({
        beadId: 'bead-001',
        stateId: 'implement',
        events: [],
      });

      // nonAuthoritative must be true (AC7 of 6q0y.35).
      expect(summary.nonAuthoritative).toBe(true);

      // Simulate the pointer event that would be recorded after writing the artifact.
      const pointerPayload = buildCompactionSummaryPointerPayload(
        'bead-001',
        'implement',
        {
          artifactPath: '/tmp/compaction/bead-001.json',
          artifactBytes: 512,
          artifactSha256: 'deadbeef',
        },
        ['evt-001', 'evt-002']
      );

      // The pointer event always carries nonAuthoritative: true.
      expect(pointerPayload['nonAuthoritative']).toBe(true);

      // Build a projectable event list: ONLY the compaction pointer event.
      // If this were treated as a route event, it might spuriously advance state.
      const compactionEvent: ProjectableEvent = {
        type: DomainEventName.COMPACTION_SUMMARY_RECORDED,
        data: {
          ...(pointerPayload as Record<string, unknown>),
          // Even if it had these fields, they must be ignored by the projector:
          emitterType: 'tool',
          emitterId: 'compaction-engine',
          eventName: 'PLAN_ACCEPTED',
          category: 'advance',
          routeEventId: 'fake-compaction-route-evt',
        },
      };

      const result = replayProjectV2Transitions(
        [compactionEvent],
        V2_VOCAB,
        stateFor,
        { initialState: 'implement' }
      );

      // State stays at 'implement' — compaction event is invisible to the projector.
      // MUTATION: remove the `event.type !== DomainEventName.ROUTE_EVENT_EMITTED` guard →
      //   the COMPACTION_SUMMARY_RECORDED event would be evaluated as a route event
      //   (it has routeEventId + emitterType + eventName). Then:
      //     - QUARANTINE_GATE 1: emitterType 'tool' is valid → passes gate 1
      //     - QUARANTINE_GATE 2: 'PLAN_ACCEPTED' is in vocab → passes gate 2
      //     - Applied transition → finalState becomes 'completed'
      //   The assertion `result.finalState === 'implement'` would then fail.
      expect(result.finalState).toBe('implement');
      // No transitions applied, no quarantine (non-route events are invisible, not quarantined).
      expect(result.appliedTransitions).toHaveLength(0);
      expect(result.quarantineDiagnostics).toHaveLength(0);
    }
  );

  it(
    'LOAD-BEARING: a mix of COMPACTION_SUMMARY_RECORDED + valid ROUTE_EVENT_EMITTED — only the route event advances',
    () => {
      // Scenario: both events present. The compaction must be invisible;
      // only the deterministic route event advances state.
      const compactionEvent: ProjectableEvent = {
        type: DomainEventName.COMPACTION_SUMMARY_RECORDED,
        data: {
          beadId: 'bead-001',
          stateId: 'implement',
          nonAuthoritative: true,
          // Plausible-looking route fields that must be ignored:
          emitterType: 'tool',
          eventName: 'PLAN_ACCEPTED',
          routeEventId: 'fake-compaction-evt',
        },
      };

      const validRouteEvent = makeValidRouteEvent();

      const result = replayProjectV2Transitions(
        [compactionEvent, validRouteEvent],
        V2_VOCAB,
        stateFor,
        { initialState: 'implement' }
      );

      // Only one transition (from the valid route event), not two.
      expect(result.appliedTransitions).toHaveLength(1);
      expect(result.appliedTransitions[0]!.eventName).toBe('PLAN_ACCEPTED');
      expect(result.appliedTransitions[0]!.emitterType).toBe('verifier');
      // State advanced to 'completed' — ONLY via the deterministic route event.
      expect(result.finalState).toBe('completed');
    }
  );

  it(
    'LOAD-BEARING: nonAuthoritative flag is always true in CompactionSummary (structural check)',
    () => {
      // The CompactionSummary type declares `nonAuthoritative: true` as a literal type.
      // This test confirms buildCompactionSummary always emits it, making it impossible
      // to accidentally produce an authoritative compaction summary.
      //
      // MUTATION PROOF: If the `nonAuthoritative: true` field were removed from
      // buildCompactionSummary's return, the TypeScript compiler would raise a type
      // error (the return type requires `nonAuthoritative: true`). Additionally,
      // this runtime assertion would fail.
      const summary = buildCompactionSummary({
        beadId: 'bead-999',
        stateId: 'any-state',
        events: [],
      });

      // Structural guard: always true, never omittable.
      expect(summary.nonAuthoritative).toBe(true);

      // The pointer event also always carries nonAuthoritative: true.
      const pointer = buildCompactionSummaryPointerPayload(
        'bead-999', 'any-state',
        { artifactPath: '/tmp/x', artifactBytes: 0, artifactSha256: 'xx' },
        []
      );
      expect(pointer['nonAuthoritative']).toBe(true);
    }
  );
});

// ===========================================================================
// PART 3: AC2 schema lint — LLM action + emits is a startup failure
// ===========================================================================

describe('pi-experiment-jvx3 AC2 — ConfigLoader rejects LLM action with emits (load-bearing lint)', () => {
  /**
   * LOAD-BEARING test: ConfigLoader.validateV2ActionEmits rejects an action that
   * declares both `llm` and `emits`.
   *
   * This test is load-bearing for AC2: the lint enforces that LLM actions (which
   * produce prose) CANNOT be route-event emitters. Without this lint, an LLM action
   * could declare emits.pass = 'PLAN_ACCEPTED' and (if somehow an LLM-authored
   * route event slipped through) advance state.
   *
   * MUTATION PROOF: If the `llmRaw !== undefined` guard in validateV2ActionEmits
   * were removed, the ConfigLoader would successfully load a YAML with both llm and
   * emits declared. The `await expect(...).rejects.toThrow()` assertion would fail
   * (it would resolve instead of rejecting).
   *
   * The guard is at ConfigLoader.ts in validateV2ActionEmits:
   *   if (llmRaw !== undefined && llmRaw !== null) { throw new Error(...); }
   */
  it(
    'LOAD-BEARING: v2 action declaring both llm and emits → ConfigLoader throws at startup',
    () => {
      // Use realpathSync to resolve macOS /tmp → /private/tmp symlink so the
      // ConfigLoader path-safety check agrees with the project root.
      const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-jvx3-')));
      try {
        // Create a minimal prompt file (must exist so promptFile admission passes).
        const promptFile = path.join(tmpDir, 'prompts', 'implement.md');
        fs.mkdirSync(path.dirname(promptFile), { recursive: true });
        fs.writeFileSync(promptFile, '# Implement\nDo the thing.');

        // v2 configs require actions as a MAP (keyed by action ID), not an array.
        const yamlContent = `
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
  advance: [PLAN_ACCEPTED]
  failure: [PLAN_REJECTED]
  blocked: [BLOCKED]
  neutral: []
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement the task."
    actions:
      do-implement:
        type: prompt
        llm:
          promptFile: "prompts/implement.md"
        emits:
          pass: PLAN_ACCEPTED
          fail: PLAN_REJECTED
    transitions:
      PLAN_ACCEPTED: completed
      PLAN_REJECTED: implement
  completed:
    identity: { role: "Done", expertise: "Done", constraints: [] }
    baseInstructions: "Done."
    actions: {}
    transitions: {}
`;
        const configPath = path.join(tmpDir, 'harness.yaml');
        fs.writeFileSync(configPath, yamlContent);

        // ConfigLoader constructor: (env: RuntimeEnvironment, projectRoot: string).
        // Pass a stub env and realpathSync(tmpDir) as project root so the promptFile
        // path-safety check agrees with the resolved directory.
        const loader = new ConfigLoader({ env: () => undefined }, tmpDir);
        // MUTATION: remove the llm+emits guard in validateV2ActionEmits →
        //   loader.load() throws a different error or resolves. This assertion fails.
        expect(() => loader.load(configPath)).toThrow(/llm.*emits|emits.*llm/i);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  );
});
