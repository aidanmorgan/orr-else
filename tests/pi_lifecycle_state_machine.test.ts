/**
 * pi-experiment-1elr.10: Pi lifecycle state machine tests.
 *
 * Covers all 8 acceptance-criteria scenarios:
 *   1. Normal lifecycle (EXTENSION_LOADED → SESSION_ACTIVE → WORKER_ADMITTED → SESSION_SHUTDOWN)
 *   2. Repeated session_start (duplicate observer registration → LIFECYCLE_VIOLATION)
 *   3. before_agent_start before session_start (admission out of order → LIFECYCLE_VIOLATION)
 *   4. resources_discover failure (error during skill-path resolution)
 *   5. shutdown during active tool run (shutdown-with-active-run diagnostic)
 *   6. reload/restart idempotency (machine resets; session-scoped fields cleared)
 *   7. duplicate observer registration (duplicate SESSION_START → violation)
 *   8. invalid lifecycle event ordering (arbitrary invalid transitions)
 *
 * ORPHAN GUARD: for each enforcement point, a test that REMOVES the enforcement
 * check verifies the test would fail (mutation-check pattern). The enforcement
 * removal test asserts that calling transition() returns ok:false for invalid
 * sequences — if the machine were removed, these tests would fail.
 */

import { describe, it, expect } from 'vitest';
import {
  PiLifecycleState,
  PiLifecycleEvent,
  SupervisorHealthStage,
  RunMode,
  LifecycleViolationKind,
  createLifecycleMachineState,
  transition,
  applyTransition,
  buildLifecycleEventFields,
  buildResourcesDiscoverFailure,
  ALL_TRANSITIONS,
} from '../src/core/PiLifecycleStateMachine.js';
import {
  FailureClass,
  LifecyclePhase,
  NextAction,
  routeFailure,
  RetryBudget,
  AuthorityLevel,
} from '../src/core/FailureTaxonomy.js';

// ---------------------------------------------------------------------------
// Helper: advance machine through a sequence of events, assert each ok
// ---------------------------------------------------------------------------

function advanceThrough(
  events: PiLifecycleEvent[],
  expectedStates?: PiLifecycleState[]
): ReturnType<typeof createLifecycleMachineState> {
  const machine = createLifecycleMachineState();
  for (let i = 0; i < events.length; i++) {
    const result = transition(machine, events[i]);
    expect(result.ok, `Event ${events[i]} in state ${machine.currentState} should succeed`).toBe(true);
    if (result.ok) {
      applyTransition(machine, result);
    }
    if (expectedStates) {
      expect(machine.currentState).toBe(expectedStates[i]);
    }
  }
  return machine;
}

// ---------------------------------------------------------------------------
// 1. Normal lifecycle
// ---------------------------------------------------------------------------

describe('1. normal lifecycle — full happy path', () => {
  it('coordinator: EXTENSION_LOADED → RESOURCES_DISCOVERED → SESSION_ACTIVE → SESSION_SHUTDOWN', () => {
    const machine = advanceThrough(
      [
        PiLifecycleEvent.RESOURCES_DISCOVER,
        PiLifecycleEvent.SESSION_START,
        PiLifecycleEvent.SESSION_SHUTDOWN,
      ],
      [
        PiLifecycleState.RESOURCES_DISCOVERED,
        PiLifecycleState.SESSION_ACTIVE,
        PiLifecycleState.SESSION_SHUTDOWN,
      ]
    );
    expect(machine.currentState).toBe(PiLifecycleState.SESSION_SHUTDOWN);
  });

  it('worker: SESSION_ACTIVE → WORKER_ADMITTED → WORKER_ACTIVE → WORKER_ADMITTED → SESSION_SHUTDOWN', () => {
    const machine = createLifecycleMachineState();
    // Get to SESSION_ACTIVE
    const ssResult = transition(machine, PiLifecycleEvent.SESSION_START);
    expect(ssResult.ok).toBe(true);
    if (ssResult.ok) applyTransition(machine, ssResult);
    machine.runMode = RunMode.WORKER;

    // BEFORE_AGENT_START → WORKER_ADMITTED
    const bafResult = transition(machine, PiLifecycleEvent.BEFORE_AGENT_START);
    expect(bafResult.ok).toBe(true);
    if (bafResult.ok) {
      expect(bafResult.wasIdempotent).toBe(false);
      applyTransition(machine, bafResult);
    }
    expect(machine.currentState).toBe(PiLifecycleState.WORKER_ADMITTED);

    // TOOL_EVENT_START → WORKER_ACTIVE
    const toolStart = transition(machine, PiLifecycleEvent.TOOL_EVENT_START);
    expect(toolStart.ok).toBe(true);
    if (toolStart.ok) applyTransition(machine, toolStart);
    expect(machine.currentState).toBe(PiLifecycleState.WORKER_ACTIVE);

    // TOOL_EVENT_END → WORKER_ADMITTED
    const toolEnd = transition(machine, PiLifecycleEvent.TOOL_EVENT_END);
    expect(toolEnd.ok).toBe(true);
    if (toolEnd.ok) applyTransition(machine, toolEnd);
    expect(machine.currentState).toBe(PiLifecycleState.WORKER_ADMITTED);

    // SESSION_SHUTDOWN → SESSION_SHUTDOWN
    const shutResult = transition(machine, PiLifecycleEvent.SESSION_SHUTDOWN);
    expect(shutResult.ok).toBe(true);
    if (shutResult.ok) applyTransition(machine, shutResult);
    expect(machine.currentState).toBe(PiLifecycleState.SESSION_SHUTDOWN);
  });

  it('multi-turn worker: BEFORE_AGENT_START is idempotent in WORKER_ADMITTED', () => {
    const machine = createLifecycleMachineState();
    const ss = transition(machine, PiLifecycleEvent.SESSION_START);
    if (ss.ok) applyTransition(machine, ss);

    const baf1 = transition(machine, PiLifecycleEvent.BEFORE_AGENT_START);
    expect(baf1.ok).toBe(true);
    if (baf1.ok) {
      expect(baf1.wasIdempotent).toBe(false);
      applyTransition(machine, baf1);
    }
    expect(machine.currentState).toBe(PiLifecycleState.WORKER_ADMITTED);

    // Second BEFORE_AGENT_START in same state is idempotent
    const baf2 = transition(machine, PiLifecycleEvent.BEFORE_AGENT_START);
    expect(baf2.ok).toBe(true);
    if (baf2.ok) {
      expect(baf2.wasIdempotent).toBe(true);
    }
    expect(machine.currentState).toBe(PiLifecycleState.WORKER_ADMITTED);
  });

  it('RESOURCES_DISCOVER may fire before SESSION_START and is idempotent', () => {
    const machine = createLifecycleMachineState();

    const rd1 = transition(machine, PiLifecycleEvent.RESOURCES_DISCOVER);
    expect(rd1.ok).toBe(true);
    if (rd1.ok) applyTransition(machine, rd1);
    expect(machine.currentState).toBe(PiLifecycleState.RESOURCES_DISCOVERED);

    // Second RESOURCES_DISCOVER is idempotent
    const rd2 = transition(machine, PiLifecycleEvent.RESOURCES_DISCOVER);
    expect(rd2.ok).toBe(true);
    if (rd2.ok) {
      expect(rd2.wasIdempotent).toBe(true);
    }
    expect(machine.currentState).toBe(PiLifecycleState.RESOURCES_DISCOVERED);
  });
});

// ---------------------------------------------------------------------------
// 2. Repeated session_start — duplicate observer registration
// ---------------------------------------------------------------------------

describe('2. repeated SESSION_START → LIFECYCLE_VIOLATION (duplicate observer registration)', () => {
  it('second SESSION_START in SESSION_ACTIVE produces DUPLICATE_OBSERVER_REGISTRATION violation', () => {
    const machine = createLifecycleMachineState();
    const ss1 = transition(machine, PiLifecycleEvent.SESSION_START);
    expect(ss1.ok).toBe(true);
    if (ss1.ok) applyTransition(machine, ss1);
    expect(machine.currentState).toBe(PiLifecycleState.SESSION_ACTIVE);

    // Second SESSION_START in SESSION_ACTIVE → violation
    const ss2 = transition(machine, PiLifecycleEvent.SESSION_START);
    expect(ss2.ok).toBe(false);
    if (!ss2.ok) {
      expect(ss2.kind).toBe(LifecycleViolationKind.DUPLICATE_OBSERVER_REGISTRATION);
      expect(ss2.fromState).toBe(PiLifecycleState.SESSION_ACTIVE);
      expect(ss2.event).toBe(PiLifecycleEvent.SESSION_START);
      // Taxonomy: LIFECYCLE_VIOLATION → TERMINAL_REJECT at SPAWN phase
      expect(ss2.routingResult.nextAction).toBe(NextAction.TERMINAL_REJECT);
      // Idempotency key is deterministic
      expect(ss2.idempotencyKey).toBe(
        `lifecycle_violation:${PiLifecycleState.SESSION_ACTIVE}:${PiLifecycleEvent.SESSION_START}`
      );
    }
    // Machine state is NOT changed by a failed transition
    expect(machine.currentState).toBe(PiLifecycleState.SESSION_ACTIVE);
  });

  // ORPHAN GUARD: proves that the enforcement check is real by verifying that
  // calling transition() in SESSION_ACTIVE with SESSION_START returns ok:false.
  // If the enforcement were removed, this test would fail.
  it('[ORPHAN GUARD] removing lifecycle enforcement would break this test', () => {
    const machine = createLifecycleMachineState();
    const ss1 = transition(machine, PiLifecycleEvent.SESSION_START);
    if (ss1.ok) applyTransition(machine, ss1);

    // The machine MUST reject a second SESSION_START.
    // If enforcement were removed (transition returned ok:true always), this would fail.
    const ss2 = transition(machine, PiLifecycleEvent.SESSION_START);
    expect(ss2.ok).toBe(false);
    // Specifically: it must NOT succeed, because that would allow duplicate observers.
    expect(ss2.ok).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. BEFORE_AGENT_START before SESSION_START
// ---------------------------------------------------------------------------

describe('3. BEFORE_AGENT_START before SESSION_START → LIFECYCLE_VIOLATION', () => {
  it('BEFORE_AGENT_START in EXTENSION_LOADED → BEFORE_AGENT_START_BEFORE_ADMISSION', () => {
    const machine = createLifecycleMachineState();
    // No SESSION_START — try BEFORE_AGENT_START directly
    const baf = transition(machine, PiLifecycleEvent.BEFORE_AGENT_START);
    expect(baf.ok).toBe(false);
    if (!baf.ok) {
      expect(baf.kind).toBe(LifecycleViolationKind.BEFORE_AGENT_START_BEFORE_ADMISSION);
      expect(baf.fromState).toBe(PiLifecycleState.EXTENSION_LOADED);
      // Taxonomy: LIFECYCLE_VIOLATION → STARTUP_FAIL at STARTUP phase
      expect(baf.routingResult.nextAction).toBe(NextAction.STARTUP_FAIL);
    }
    expect(machine.currentState).toBe(PiLifecycleState.EXTENSION_LOADED);
  });

  it('BEFORE_AGENT_START in RESOURCES_DISCOVERED (before SESSION_START) → violation', () => {
    const machine = createLifecycleMachineState();
    const rd = transition(machine, PiLifecycleEvent.RESOURCES_DISCOVER);
    if (rd.ok) applyTransition(machine, rd);
    expect(machine.currentState).toBe(PiLifecycleState.RESOURCES_DISCOVERED);

    const baf = transition(machine, PiLifecycleEvent.BEFORE_AGENT_START);
    expect(baf.ok).toBe(false);
    if (!baf.ok) {
      expect(baf.kind).toBe(LifecycleViolationKind.BEFORE_AGENT_START_BEFORE_ADMISSION);
    }
  });

  // ORPHAN GUARD: proves that enforcement of BEFORE_AGENT_START ordering is real.
  it('[ORPHAN GUARD] BEFORE_AGENT_START without SESSION_START must be rejected', () => {
    const machine = createLifecycleMachineState();
    // The real extension.ts handler checks this result.ok === false and returns early.
    // If enforcement were removed, workers would start without a valid session.
    const baf = transition(machine, PiLifecycleEvent.BEFORE_AGENT_START);
    expect(baf.ok).toBe(false);
    // Verify it's specifically the admission ordering violation, not just "false".
    if (!baf.ok) {
      expect(baf.kind).toBe(LifecycleViolationKind.BEFORE_AGENT_START_BEFORE_ADMISSION);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. RESOURCES_DISCOVER failure
// ---------------------------------------------------------------------------

describe('4. RESOURCES_DISCOVER failure → LIFECYCLE_VIOLATION diagnostic', () => {
  it('buildResourcesDiscoverFailure returns RESOURCES_DISCOVER_FAILURE violation', () => {
    const machine = createLifecycleMachineState();
    const failure = buildResourcesDiscoverFailure(machine);
    expect(failure.ok).toBe(false);
    expect(failure.kind).toBe(LifecycleViolationKind.RESOURCES_DISCOVER_FAILURE);
    expect(failure.event).toBe(PiLifecycleEvent.RESOURCES_DISCOVER);
    // Taxonomy: LIFECYCLE_VIOLATION at STARTUP → STARTUP_FAIL
    expect(failure.routingResult.nextAction).toBe(NextAction.STARTUP_FAIL);
    // Machine state is NOT changed by a failure diagnostic
    expect(machine.currentState).toBe(PiLifecycleState.EXTENSION_LOADED);
  });

  it('buildResourcesDiscoverFailure idempotencyKey is deterministic', () => {
    const machine = createLifecycleMachineState();
    const f1 = buildResourcesDiscoverFailure(machine);
    const f2 = buildResourcesDiscoverFailure(machine);
    expect(f1.idempotencyKey).toBe(f2.idempotencyKey);
    // Contains no random component
    expect(f1.idempotencyKey).toContain('lifecycle_violation');
    expect(f1.idempotencyKey).toContain('RESOURCES_DISCOVER');
  });
});

// ---------------------------------------------------------------------------
// 5. Shutdown during active tool run
// ---------------------------------------------------------------------------

describe('5. shutdown during active tool run → shutdownWithActiveRun diagnostic', () => {
  it('SESSION_SHUTDOWN in WORKER_ACTIVE sets shutdownWithActiveRun:true', () => {
    const machine = createLifecycleMachineState();
    const ss = transition(machine, PiLifecycleEvent.SESSION_START);
    if (ss.ok) applyTransition(machine, ss);
    const baf = transition(machine, PiLifecycleEvent.BEFORE_AGENT_START);
    if (baf.ok) applyTransition(machine, baf);
    const toolStart = transition(machine, PiLifecycleEvent.TOOL_EVENT_START);
    if (toolStart.ok) applyTransition(machine, toolStart);
    expect(machine.currentState).toBe(PiLifecycleState.WORKER_ACTIVE);

    const shut = transition(machine, PiLifecycleEvent.SESSION_SHUTDOWN);
    expect(shut.ok).toBe(true);
    if (shut.ok) {
      expect(shut.shutdownWithActiveRun).toBe(true);
      expect(shut.fromState).toBe(PiLifecycleState.WORKER_ACTIVE);
      expect(shut.toState).toBe(PiLifecycleState.SESSION_SHUTDOWN);
      applyTransition(machine, shut);
    }
    expect(machine.currentState).toBe(PiLifecycleState.SESSION_SHUTDOWN);
  });

  it('SESSION_SHUTDOWN in SESSION_ACTIVE (no active run) does NOT set shutdownWithActiveRun', () => {
    const machine = createLifecycleMachineState();
    const ss = transition(machine, PiLifecycleEvent.SESSION_START);
    if (ss.ok) applyTransition(machine, ss);

    const shut = transition(machine, PiLifecycleEvent.SESSION_SHUTDOWN);
    expect(shut.ok).toBe(true);
    if (shut.ok) {
      expect(shut.shutdownWithActiveRun).toBe(false);
    }
  });

  // ORPHAN GUARD: the WORKER_ACTIVE → SESSION_SHUTDOWN transition must be allowed
  // (shutdown always proceeds) but must flag shutdownWithActiveRun for diagnostics.
  it('[ORPHAN GUARD] WORKER_ACTIVE → SESSION_SHUTDOWN must succeed AND flag active run', () => {
    const machine = createLifecycleMachineState();
    const ss = transition(machine, PiLifecycleEvent.SESSION_START);
    if (ss.ok) applyTransition(machine, ss);
    const baf = transition(machine, PiLifecycleEvent.BEFORE_AGENT_START);
    if (baf.ok) applyTransition(machine, baf);
    const toolStart = transition(machine, PiLifecycleEvent.TOOL_EVENT_START);
    if (toolStart.ok) applyTransition(machine, toolStart);

    const shut = transition(machine, PiLifecycleEvent.SESSION_SHUTDOWN);
    // Shutdown MUST succeed (cleanup is non-negotiable)
    expect(shut.ok).toBe(true);
    // AND it must flag the active run for diagnostics
    if (shut.ok) {
      expect(shut.shutdownWithActiveRun).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Reload / restart idempotency
// ---------------------------------------------------------------------------

describe('6. reload/restart idempotency', () => {
  it('RELOAD from SESSION_ACTIVE resets to EXTENSION_LOADED', () => {
    const machine = createLifecycleMachineState();
    machine.runMode = RunMode.COORDINATOR;
    machine.supervisorHealthStage = SupervisorHealthStage.ACTIVE;

    const ss = transition(machine, PiLifecycleEvent.SESSION_START);
    if (ss.ok) applyTransition(machine, ss);
    expect(machine.currentState).toBe(PiLifecycleState.SESSION_ACTIVE);

    const reload = transition(machine, PiLifecycleEvent.RELOAD);
    expect(reload.ok).toBe(true);
    if (reload.ok) applyTransition(machine, reload);
    expect(machine.currentState).toBe(PiLifecycleState.EXTENSION_LOADED);
  });

  it('RELOAD from EXTENSION_LOADED is idempotent', () => {
    const machine = createLifecycleMachineState();
    const reload = transition(machine, PiLifecycleEvent.RELOAD);
    expect(reload.ok).toBe(true);
    if (reload.ok) {
      expect(reload.wasIdempotent).toBe(true);
    }
    expect(machine.currentState).toBe(PiLifecycleState.EXTENSION_LOADED);
  });

  it('RESTART from SESSION_SHUTDOWN resets to EXTENSION_LOADED', () => {
    const machine = createLifecycleMachineState();
    const ss = transition(machine, PiLifecycleEvent.SESSION_START);
    if (ss.ok) applyTransition(machine, ss);
    const shut = transition(machine, PiLifecycleEvent.SESSION_SHUTDOWN);
    if (shut.ok) applyTransition(machine, shut);
    expect(machine.currentState).toBe(PiLifecycleState.SESSION_SHUTDOWN);

    const restart = transition(machine, PiLifecycleEvent.RESTART);
    expect(restart.ok).toBe(true);
    if (restart.ok) applyTransition(machine, restart);
    expect(machine.currentState).toBe(PiLifecycleState.EXTENSION_LOADED);
  });

  it('after restart, SESSION_START is accepted again (re-admission)', () => {
    const machine = createLifecycleMachineState();
    // Normal session → shutdown → restart
    const ss1 = transition(machine, PiLifecycleEvent.SESSION_START);
    if (ss1.ok) applyTransition(machine, ss1);
    const shut = transition(machine, PiLifecycleEvent.SESSION_SHUTDOWN);
    if (shut.ok) applyTransition(machine, shut);
    const restart = transition(machine, PiLifecycleEvent.RESTART);
    if (restart.ok) applyTransition(machine, restart);
    expect(machine.currentState).toBe(PiLifecycleState.EXTENSION_LOADED);

    // Fresh SESSION_START after restart must succeed
    const ss2 = transition(machine, PiLifecycleEvent.SESSION_START);
    expect(ss2.ok).toBe(true);
    if (ss2.ok) applyTransition(machine, ss2);
    expect(machine.currentState).toBe(PiLifecycleState.SESSION_ACTIVE);
  });
});

// ---------------------------------------------------------------------------
// 7. Duplicate observer registration (covered in §2, add explicit test here)
// ---------------------------------------------------------------------------

describe('7. duplicate observer registration', () => {
  it('SESSION_START in SESSION_ACTIVE → DUPLICATE_OBSERVER_REGISTRATION (n8fg taxonomy)', () => {
    const machine = createLifecycleMachineState();
    const ss = transition(machine, PiLifecycleEvent.SESSION_START);
    if (ss.ok) applyTransition(machine, ss);

    const ss2 = transition(machine, PiLifecycleEvent.SESSION_START);
    expect(ss2.ok).toBe(false);
    if (!ss2.ok) {
      // Uses central n8fg taxonomy, not ad-hoc throw
      expect(ss2.routingResult.rowId).toMatch(/lifecycle_violation/);
      expect(ss2.routingResult.nextAction).toBe(NextAction.TERMINAL_REJECT);
      expect(ss2.kind).toBe(LifecycleViolationKind.DUPLICATE_OBSERVER_REGISTRATION);
      // Description is human-readable
      expect(ss2.description).toContain('Duplicate observer registration');
    }
  });

  it('duplicate SESSION_START idempotencyKey is deterministic — same key always', () => {
    const machine1 = createLifecycleMachineState();
    const ss1a = transition(machine1, PiLifecycleEvent.SESSION_START);
    if (ss1a.ok) applyTransition(machine1, ss1a);
    const v1 = transition(machine1, PiLifecycleEvent.SESSION_START);

    const machine2 = createLifecycleMachineState();
    const ss2a = transition(machine2, PiLifecycleEvent.SESSION_START);
    if (ss2a.ok) applyTransition(machine2, ss2a);
    const v2 = transition(machine2, PiLifecycleEvent.SESSION_START);

    expect(v1.ok).toBe(false);
    expect(v2.ok).toBe(false);
    if (!v1.ok && !v2.ok) {
      // Same key regardless of when it fires — no Date.now()/random
      expect(v1.idempotencyKey).toBe(v2.idempotencyKey);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Invalid lifecycle event ordering
// ---------------------------------------------------------------------------

describe('8. invalid lifecycle event ordering', () => {
  it('TOOL_EVENT_START in EXTENSION_LOADED → INVALID_ORDERING', () => {
    const machine = createLifecycleMachineState();
    const result = transition(machine, PiLifecycleEvent.TOOL_EVENT_START);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe(LifecycleViolationKind.INVALID_ORDERING);
    }
  });

  it('TOOL_EVENT_END in SESSION_ACTIVE (coordinator mode) is idempotent — coordinators observe tool events without WORKER_ADMITTED', () => {
    const machine = createLifecycleMachineState();
    const ss = transition(machine, PiLifecycleEvent.SESSION_START);
    if (ss.ok) applyTransition(machine, ss);
    // Coordinators observe Pi native tool events in SESSION_ACTIVE (no worker run).
    // Both TOOL_EVENT_START and TOOL_EVENT_END are idempotent in this state.
    const result = transition(machine, PiLifecycleEvent.TOOL_EVENT_END);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wasIdempotent).toBe(true);
      expect(result.toState).toBe(PiLifecycleState.SESSION_ACTIVE);
    }
  });

  it('TOOL_EVENT_START in SESSION_SHUTDOWN → INVALID_ORDERING', () => {
    const machine = createLifecycleMachineState();
    const ss = transition(machine, PiLifecycleEvent.SESSION_START);
    if (ss.ok) applyTransition(machine, ss);
    const shut = transition(machine, PiLifecycleEvent.SESSION_SHUTDOWN);
    if (shut.ok) applyTransition(machine, shut);
    expect(machine.currentState).toBe(PiLifecycleState.SESSION_SHUTDOWN);

    const result = transition(machine, PiLifecycleEvent.TOOL_EVENT_START);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe(LifecycleViolationKind.INVALID_ORDERING);
    }
  });

  it('SESSION_START in WORKER_ADMITTED → INVALID_ORDERING (not duplicate observer)', () => {
    const machine = createLifecycleMachineState();
    const ss = transition(machine, PiLifecycleEvent.SESSION_START);
    if (ss.ok) applyTransition(machine, ss);
    const baf = transition(machine, PiLifecycleEvent.BEFORE_AGENT_START);
    if (baf.ok) applyTransition(machine, baf);
    expect(machine.currentState).toBe(PiLifecycleState.WORKER_ADMITTED);

    const ss2 = transition(machine, PiLifecycleEvent.SESSION_START);
    expect(ss2.ok).toBe(false);
    if (!ss2.ok) {
      // In WORKER_ADMITTED, SESSION_START is invalid ordering (not duplicate-observer)
      expect(ss2.kind).toBe(LifecycleViolationKind.INVALID_ORDERING);
    }
  });

  it('RESTART in SESSION_ACTIVE → INVALID_ORDERING (restart requires shutdown first)', () => {
    const machine = createLifecycleMachineState();
    const ss = transition(machine, PiLifecycleEvent.SESSION_START);
    if (ss.ok) applyTransition(machine, ss);

    // RESTART without prior SESSION_SHUTDOWN → invalid
    const restart = transition(machine, PiLifecycleEvent.RESTART);
    expect(restart.ok).toBe(false);
    if (!restart.ok) {
      expect(restart.kind).toBe(LifecycleViolationKind.INVALID_ORDERING);
    }
  });

  it('violation taxonomy uses n8fg routeFailure, not an ad-hoc value', () => {
    const machine = createLifecycleMachineState();
    const result = transition(machine, PiLifecycleEvent.TOOL_EVENT_START);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The routing result must match what routeFailure returns for the same inputs
      const expected = routeFailure({
        failureClass: FailureClass.LIFECYCLE_VIOLATION,
        lifecyclePhase: LifecyclePhase.STARTUP, // EXTENSION_LOADED → STARTUP
        retryBudget: RetryBudget.EXHAUSTED,
        authorityLevel: AuthorityLevel.HARNESS,
      });
      expect(result.routingResult.rowId).toBe(expected.rowId);
      expect(result.routingResult.nextAction).toBe(expected.nextAction);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: taxonomy routing — violations use n8fg taxonomy
// ---------------------------------------------------------------------------

describe('AC3: all violations route through central n8fg taxonomy', () => {
  it('LIFECYCLE_VIOLATION → TERMINAL_REJECT at SPAWN phase (SESSION_START duplicate)', () => {
    const result = routeFailure({
      failureClass: FailureClass.LIFECYCLE_VIOLATION,
      lifecyclePhase: LifecyclePhase.SPAWN,
      retryBudget: RetryBudget.EXHAUSTED,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.TERMINAL_REJECT);
    expect(result.rowId).toBe('lifecycle_violation.spawn');
  });

  it('LIFECYCLE_VIOLATION → STARTUP_FAIL at STARTUP phase (pre-session violation)', () => {
    const result = routeFailure({
      failureClass: FailureClass.LIFECYCLE_VIOLATION,
      lifecyclePhase: LifecyclePhase.STARTUP,
      retryBudget: RetryBudget.EXHAUSTED,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.STARTUP_FAIL);
    expect(result.rowId).toBe('lifecycle_violation.startup');
  });

  it('LIFECYCLE_VIOLATION → TERMINAL_REJECT at RUNNING phase', () => {
    const result = routeFailure({
      failureClass: FailureClass.LIFECYCLE_VIOLATION,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.EXHAUSTED,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.TERMINAL_REJECT);
    expect(result.rowId).toBe('lifecycle_violation.running');
  });

  it('LIFECYCLE_VIOLATION → WARNING at SHUTDOWN phase (graceful degradation)', () => {
    const result = routeFailure({
      failureClass: FailureClass.LIFECYCLE_VIOLATION,
      lifecyclePhase: LifecyclePhase.SHUTDOWN,
      retryBudget: RetryBudget.EXHAUSTED,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.WARNING);
    expect(result.rowId).toBe('lifecycle_violation.shutdown');
  });
});

// ---------------------------------------------------------------------------
// AC4: restart resets session-scoped fields (machine)
// ---------------------------------------------------------------------------

describe('AC4: restart resets lifecycle machine state', () => {
  it('createLifecycleMachineState returns clean initial state', () => {
    const machine = createLifecycleMachineState();
    expect(machine.currentState).toBe(PiLifecycleState.EXTENSION_LOADED);
    expect(machine.runMode).toBe(RunMode.UNKNOWN);
    expect(machine.supervisorHealthStage).toBe(SupervisorHealthStage.NOT_INITIALISED);
  });

  it('orrElseExtension restart: new session always starts from EXTENSION_LOADED', () => {
    // Each call to createLifecycleMachineState() (= each orrElseExtension call)
    // produces a clean machine — session isolation is structural.
    const machine1 = createLifecycleMachineState();
    machine1.runMode = RunMode.COORDINATOR;
    machine1.supervisorHealthStage = SupervisorHealthStage.ACTIVE;
    machine1.currentState = PiLifecycleState.SESSION_SHUTDOWN;

    // Simulate next extension invocation — completely independent machine.
    const machine2 = createLifecycleMachineState();
    expect(machine2.currentState).toBe(PiLifecycleState.EXTENSION_LOADED);
    expect(machine2.runMode).toBe(RunMode.UNKNOWN);
    expect(machine2.supervisorHealthStage).toBe(SupervisorHealthStage.NOT_INITIALISED);
    // machine1 state does NOT bleed into machine2
    expect(machine2.currentState).not.toBe(machine1.currentState);
  });
});

// ---------------------------------------------------------------------------
// AC5: lifecycle/health/runMode event fields
// ---------------------------------------------------------------------------

describe('AC5: buildLifecycleEventFields emits typed fields', () => {
  it('emits correct fields for an active coordinator session', () => {
    const machine = createLifecycleMachineState();
    machine.currentState = PiLifecycleState.SESSION_ACTIVE;
    machine.runMode = RunMode.COORDINATOR;
    machine.supervisorHealthStage = SupervisorHealthStage.ACTIVE;

    const fields = buildLifecycleEventFields(machine);
    expect(fields.lifecycleState).toBe(PiLifecycleState.SESSION_ACTIVE);
    expect(fields.runMode).toBe(RunMode.COORDINATOR);
    expect(fields.supervisorHealthStage).toBe(SupervisorHealthStage.ACTIVE);
  });

  it('emits correct fields for a worker in WORKER_ADMITTED', () => {
    const machine = createLifecycleMachineState();
    machine.currentState = PiLifecycleState.WORKER_ADMITTED;
    machine.runMode = RunMode.WORKER;
    machine.supervisorHealthStage = SupervisorHealthStage.IDLE;

    const fields = buildLifecycleEventFields(machine);
    expect(fields.lifecycleState).toBe(PiLifecycleState.WORKER_ADMITTED);
    expect(fields.runMode).toBe(RunMode.WORKER);
    expect(fields.supervisorHealthStage).toBe(SupervisorHealthStage.IDLE);
  });

  it('fields are a snapshot — mutating machine after call does not affect returned object', () => {
    const machine = createLifecycleMachineState();
    machine.currentState = PiLifecycleState.SESSION_ACTIVE;
    const fields = buildLifecycleEventFields(machine);
    machine.currentState = PiLifecycleState.SESSION_SHUTDOWN;
    // The snapshot was taken before the mutation
    expect(fields.lifecycleState).toBe(PiLifecycleState.SESSION_ACTIVE);
  });
});

// ---------------------------------------------------------------------------
// Determinism checks
// ---------------------------------------------------------------------------

describe('determinism: no Date.now/Math.random in transition logic', () => {
  it('same (fromState, event) always returns the same result', () => {
    const machine1 = createLifecycleMachineState();
    const machine2 = createLifecycleMachineState();
    // Both are fresh — same state
    const r1 = transition(machine1, PiLifecycleEvent.RESOURCES_DISCOVER);
    const r2 = transition(machine2, PiLifecycleEvent.RESOURCES_DISCOVER);
    expect(r1.ok).toBe(r2.ok);
    if (r1.ok && r2.ok) {
      expect(r1.toState).toBe(r2.toState);
      expect(r1.wasIdempotent).toBe(r2.wasIdempotent);
    }
  });

  it('violation idempotencyKey is deterministic (no random suffix)', () => {
    const machine = createLifecycleMachineState();
    const v1 = transition(machine, PiLifecycleEvent.TOOL_EVENT_START);
    const v2 = transition(machine, PiLifecycleEvent.TOOL_EVENT_START);
    expect(v1.ok).toBe(false);
    expect(v2.ok).toBe(false);
    if (!v1.ok && !v2.ok) {
      expect(v1.idempotencyKey).toBe(v2.idempotencyKey);
    }
  });
});

// ---------------------------------------------------------------------------
// Transition table coverage
// ---------------------------------------------------------------------------

describe('transition table coverage', () => {
  it('ALL_TRANSITIONS is exported and non-empty', () => {
    expect(Array.isArray(ALL_TRANSITIONS)).toBe(true);
    expect(ALL_TRANSITIONS.length).toBeGreaterThan(0);
  });

  it('EXTENSION_LOAD event is idempotent in EXTENSION_LOADED', () => {
    const machine = createLifecycleMachineState();
    const result = transition(machine, PiLifecycleEvent.EXTENSION_LOAD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wasIdempotent).toBe(true);
      expect(result.toState).toBe(PiLifecycleState.EXTENSION_LOADED);
    }
  });

  it('TOOL_EVENT_START is idempotent in WORKER_ACTIVE (nested tools)', () => {
    const machine = createLifecycleMachineState();
    const ss = transition(machine, PiLifecycleEvent.SESSION_START);
    if (ss.ok) applyTransition(machine, ss);
    const baf = transition(machine, PiLifecycleEvent.BEFORE_AGENT_START);
    if (baf.ok) applyTransition(machine, baf);
    const t1 = transition(machine, PiLifecycleEvent.TOOL_EVENT_START);
    if (t1.ok) applyTransition(machine, t1);
    expect(machine.currentState).toBe(PiLifecycleState.WORKER_ACTIVE);

    // Second TOOL_EVENT_START (nested) is idempotent
    const t2 = transition(machine, PiLifecycleEvent.TOOL_EVENT_START);
    expect(t2.ok).toBe(true);
    if (t2.ok) {
      expect(t2.wasIdempotent).toBe(true);
    }
  });

  it('coordinator tool events are idempotent (SESSION_ACTIVE stays SESSION_ACTIVE)', () => {
    const machine = createLifecycleMachineState();
    const ss = transition(machine, PiLifecycleEvent.SESSION_START);
    if (ss.ok) applyTransition(machine, ss);

    const toolStart = transition(machine, PiLifecycleEvent.TOOL_EVENT_START);
    expect(toolStart.ok).toBe(true);
    if (toolStart.ok) {
      expect(toolStart.wasIdempotent).toBe(true);
      expect(toolStart.toState).toBe(PiLifecycleState.SESSION_ACTIVE);
    }
  });
});
