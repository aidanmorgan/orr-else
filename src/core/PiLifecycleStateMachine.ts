/**
 * pi-experiment-1elr.10: Deterministic Pi lifecycle state machine.
 *
 * PURPOSE
 * -------
 * Models the Pi host lifecycle as a code-owned, deterministic state machine.
 * All lifecycle handlers in extension.ts MUST call transition() before mutating
 * session state, registering tools, starting workers, injecting prompts, or
 * shutting down observability.
 *
 * Invalid ordering, duplicate non-idempotent events, and lifecycle violations
 * produce FailureClass.LIFECYCLE_VIOLATION diagnostics via the central n8fg
 * taxonomy table (routeFailure). No ad-hoc throws or local boolean guards.
 *
 * STATES
 * ------
 * EXTENSION_LOADED → RESOURCES_DISCOVERED → SESSION_ACTIVE → WORKER_ADMITTED
 *   → WORKER_ACTIVE (during tool/provider events) → SESSION_SHUTDOWN
 *   → RELOADED (on reload, returns to RESOURCES_DISCOVERED or SESSION_ACTIVE)
 *
 * DESIGN PRINCIPLES
 * -----------------
 * - All transition decisions are PURE and SYNCHRONOUS (no Date.now/Math.random).
 * - Timestamps belong in event payloads only, not in transition logic.
 * - Idempotency keys are deterministic (state × event).
 * - The machine is a plain object + pure function — no classes, no EventEmitter.
 */

import {
  FailureClass,
  LifecyclePhase,
  NextAction,
  RetryBudget,
  AuthorityLevel,
  routeFailure,
  type RoutingResult,
} from './FailureTaxonomy.js';

// ---------------------------------------------------------------------------
// PiLifecycleState — the set of states the extension can be in
// ---------------------------------------------------------------------------

/**
 * Typed Pi extension lifecycle states.
 *
 * Transitions are defined in ALLOWED_TRANSITIONS below. Any (from, event) pair
 * not listed there is an invalid transition and produces a LIFECYCLE_VIOLATION.
 */
export enum PiLifecycleState {
  /** Extension function has been invoked; no Pi events have fired yet. */
  EXTENSION_LOADED = 'EXTENSION_LOADED',
  /** RESOURCES_DISCOVER fired; skill paths resolved. */
  RESOURCES_DISCOVERED = 'RESOURCES_DISCOVERED',
  /** SESSION_START fired; observability, tools, and teammates initialised. */
  SESSION_ACTIVE = 'SESSION_ACTIVE',
  /** Worker mode: BEFORE_AGENT_START fired; run initialised, admission complete. */
  WORKER_ADMITTED = 'WORKER_ADMITTED',
  /** Worker mode: active tool or provider event is being processed. */
  WORKER_ACTIVE = 'WORKER_ACTIVE',
  /** SESSION_SHUTDOWN fired; supervisor stopped, observability flushed. */
  SESSION_SHUTDOWN = 'SESSION_SHUTDOWN',
  /**
   * Extension reloaded (new Pi instance after reload/restart).
   * This is a transient state — transition() immediately advances to
   * EXTENSION_LOADED for the new invocation.
   */
  RELOADED = 'RELOADED',
}

// ---------------------------------------------------------------------------
// PiLifecycleEvent — the lifecycle events that drive transitions
// ---------------------------------------------------------------------------

/**
 * Typed Pi lifecycle events.  Each corresponds to a Pi host callback or a
 * harness-internal lifecycle action (tool turn start/end, reload, restart).
 */
export enum PiLifecycleEvent {
  /** Extension function called (orrElseExtension invoked). */
  EXTENSION_LOAD = 'EXTENSION_LOAD',
  /** Pi fired RESOURCES_DISCOVER. */
  RESOURCES_DISCOVER = 'RESOURCES_DISCOVER',
  /** Pi fired SESSION_START. */
  SESSION_START = 'SESSION_START',
  /**
   * Worker mode: Pi fired BEFORE_AGENT_START with an active run.
   * Non-worker mode: BEFORE_AGENT_START is a no-op (not an admission event).
   */
  BEFORE_AGENT_START = 'BEFORE_AGENT_START',
  /** A tool or provider event is being processed. */
  TOOL_EVENT_START = 'TOOL_EVENT_START',
  /** A tool or provider event completed. */
  TOOL_EVENT_END = 'TOOL_EVENT_END',
  /** Pi fired SESSION_SHUTDOWN. */
  SESSION_SHUTDOWN = 'SESSION_SHUTDOWN',
  /** Reload: orrElseExtension is being called again (Pi reloading). */
  RELOAD = 'RELOAD',
  /**
   * Restart after shutdown: session-scoped fields reset, re-admission begins.
   * The machine resets to EXTENSION_LOADED for the new session.
   */
  RESTART = 'RESTART',
}

// ---------------------------------------------------------------------------
// SupervisorHealthStage — health classification for capacity/lifecycle events
// ---------------------------------------------------------------------------

/**
 * Health classification for the supervisor / coordinator at the time an event
 * is emitted. Carried on health/capacity/lifecycle domain events so operators
 * can correlate health state with event context.
 *
 * Values are conservative — only report HEALTHY when all sub-conditions pass.
 */
export enum SupervisorHealthStage {
  /** Supervisor not yet initialised (pre SESSION_START). */
  NOT_INITIALISED = 'NOT_INITIALISED',
  /** Supervisor started; no active slots yet. */
  IDLE = 'IDLE',
  /** Supervisor running; ≥1 active slots. */
  ACTIVE = 'ACTIVE',
  /** Supervisor in capacity-pause mode (scheduling suspended). */
  PAUSED = 'PAUSED',
  /** Supervisor stopped or session shutting down. */
  STOPPED = 'STOPPED',
  /** Health state is unknown (e.g. pre-initialisation error). */
  UNKNOWN = 'UNKNOWN',
}

// ---------------------------------------------------------------------------
// RunMode — coordinator vs worker distinction
// ---------------------------------------------------------------------------

/**
 * Whether this Pi process instance is running as a coordinator or a worker.
 * Determined once at SESSION_START by environment variables (WORKER_MODE,
 * BEAD_ID, STATE_ID) and immutable for the lifetime of the session.
 */
export enum RunMode {
  /** This process is the Orr Else coordinator (drives supervisor + teammates). */
  COORDINATOR = 'COORDINATOR',
  /** This process is a worker/teammate spawned by the coordinator. */
  WORKER = 'WORKER',
  /** Run mode is not yet determined (pre SESSION_START). */
  UNKNOWN = 'UNKNOWN',
}

// ---------------------------------------------------------------------------
// Transition table — the ONLY allowed transitions
// ---------------------------------------------------------------------------

/**
 * The exhaustive set of allowed (fromState, event) → toState transitions.
 *
 * Any (fromState, event) pair absent from this table is INVALID and will
 * produce a LIFECYCLE_VIOLATION diagnostic.
 *
 * Idempotent transitions are marked with idempotent:true. Firing them again
 * in the same state is silently accepted (returns the current state without
 * a violation).
 */
interface TransitionRow {
  from: PiLifecycleState;
  event: PiLifecycleEvent;
  to: PiLifecycleState;
  /**
   * When true, re-firing this event in the same state is accepted without
   * a violation (the machine stays in `to`).
   *
   * SESSION_START is non-idempotent: a second SESSION_START in SESSION_ACTIVE
   * state is a LIFECYCLE_VIOLATION (duplicate observer registration).
   *
   * TOOL_EVENT_START/END are non-idempotent within WORKER_ADMITTED but
   * idempotent within WORKER_ACTIVE (nested tool events).
   */
  idempotent: boolean;
}

const TRANSITION_TABLE: readonly TransitionRow[] = Object.freeze([
  // ── Extension load ──────────────────────────────────────────────────────────
  // First load: start from nothing (represented by a synthetic UNDEFINED state
  // handled specially in transition()).
  {
    from: PiLifecycleState.EXTENSION_LOADED,
    event: PiLifecycleEvent.EXTENSION_LOAD,
    to: PiLifecycleState.EXTENSION_LOADED,
    idempotent: true, // Re-entering extension load (reload path) is safe.
  },

  // ── Resources discover ──────────────────────────────────────────────────────
  {
    from: PiLifecycleState.EXTENSION_LOADED,
    event: PiLifecycleEvent.RESOURCES_DISCOVER,
    to: PiLifecycleState.RESOURCES_DISCOVERED,
    idempotent: false,
  },
  {
    // RESOURCES_DISCOVER may fire again after reload before the next SESSION_START.
    from: PiLifecycleState.RESOURCES_DISCOVERED,
    event: PiLifecycleEvent.RESOURCES_DISCOVER,
    to: PiLifecycleState.RESOURCES_DISCOVERED,
    idempotent: true,
  },

  // ── Session start ───────────────────────────────────────────────────────────
  {
    from: PiLifecycleState.EXTENSION_LOADED,
    event: PiLifecycleEvent.SESSION_START,
    to: PiLifecycleState.SESSION_ACTIVE,
    idempotent: false,
  },
  {
    from: PiLifecycleState.RESOURCES_DISCOVERED,
    event: PiLifecycleEvent.SESSION_START,
    to: PiLifecycleState.SESSION_ACTIVE,
    idempotent: false,
  },
  // Duplicate SESSION_START in SESSION_ACTIVE → violation (duplicate observer registration).
  // NOT listed here → falls through to violation path.

  // ── Before agent start (worker mode only) ───────────────────────────────────
  {
    from: PiLifecycleState.SESSION_ACTIVE,
    event: PiLifecycleEvent.BEFORE_AGENT_START,
    to: PiLifecycleState.WORKER_ADMITTED,
    idempotent: false,
  },
  {
    // Subsequent BEFORE_AGENT_START calls in the same run (multi-turn).
    from: PiLifecycleState.WORKER_ADMITTED,
    event: PiLifecycleEvent.BEFORE_AGENT_START,
    to: PiLifecycleState.WORKER_ADMITTED,
    idempotent: true,
  },
  {
    // BEFORE_AGENT_START after a tool turn completed: back to WORKER_ADMITTED.
    from: PiLifecycleState.WORKER_ACTIVE,
    event: PiLifecycleEvent.BEFORE_AGENT_START,
    to: PiLifecycleState.WORKER_ADMITTED,
    idempotent: false,
  },

  // ── Tool events ─────────────────────────────────────────────────────────────
  {
    from: PiLifecycleState.WORKER_ADMITTED,
    event: PiLifecycleEvent.TOOL_EVENT_START,
    to: PiLifecycleState.WORKER_ACTIVE,
    idempotent: false,
  },
  {
    // Nested/concurrent tool events while already active.
    from: PiLifecycleState.WORKER_ACTIVE,
    event: PiLifecycleEvent.TOOL_EVENT_START,
    to: PiLifecycleState.WORKER_ACTIVE,
    idempotent: true,
  },
  {
    from: PiLifecycleState.WORKER_ACTIVE,
    event: PiLifecycleEvent.TOOL_EVENT_END,
    to: PiLifecycleState.WORKER_ADMITTED,
    idempotent: false,
  },
  {
    // Tool events in SESSION_ACTIVE (coordinator mode): coordinator observes
    // native Pi tool events without entering WORKER_ADMITTED.
    from: PiLifecycleState.SESSION_ACTIVE,
    event: PiLifecycleEvent.TOOL_EVENT_START,
    to: PiLifecycleState.SESSION_ACTIVE,
    idempotent: true,
  },
  {
    from: PiLifecycleState.SESSION_ACTIVE,
    event: PiLifecycleEvent.TOOL_EVENT_END,
    to: PiLifecycleState.SESSION_ACTIVE,
    idempotent: true,
  },

  // ── Session shutdown ─────────────────────────────────────────────────────────
  {
    from: PiLifecycleState.SESSION_ACTIVE,
    event: PiLifecycleEvent.SESSION_SHUTDOWN,
    to: PiLifecycleState.SESSION_SHUTDOWN,
    idempotent: false,
  },
  {
    from: PiLifecycleState.WORKER_ADMITTED,
    event: PiLifecycleEvent.SESSION_SHUTDOWN,
    to: PiLifecycleState.SESSION_SHUTDOWN,
    idempotent: false,
  },
  {
    // Shutdown during active tool turn — produces a diagnostic (shutdown-with-active-run).
    // The machine still transitions to SHUTDOWN so cleanup can proceed.
    from: PiLifecycleState.WORKER_ACTIVE,
    event: PiLifecycleEvent.SESSION_SHUTDOWN,
    to: PiLifecycleState.SESSION_SHUTDOWN,
    idempotent: false,
  },
  {
    from: PiLifecycleState.RESOURCES_DISCOVERED,
    event: PiLifecycleEvent.SESSION_SHUTDOWN,
    to: PiLifecycleState.SESSION_SHUTDOWN,
    idempotent: false,
  },
  {
    from: PiLifecycleState.EXTENSION_LOADED,
    event: PiLifecycleEvent.SESSION_SHUTDOWN,
    to: PiLifecycleState.SESSION_SHUTDOWN,
    idempotent: false,
  },
  {
    // Idempotent: double-shutdown is fine.
    from: PiLifecycleState.SESSION_SHUTDOWN,
    event: PiLifecycleEvent.SESSION_SHUTDOWN,
    to: PiLifecycleState.SESSION_SHUTDOWN,
    idempotent: true,
  },

  // ── Reload ───────────────────────────────────────────────────────────────────
  {
    // Reload from any non-shutdown state: Pi reloads the extension with a new pi instance.
    from: PiLifecycleState.SESSION_ACTIVE,
    event: PiLifecycleEvent.RELOAD,
    to: PiLifecycleState.EXTENSION_LOADED,
    idempotent: false,
  },
  {
    from: PiLifecycleState.SESSION_SHUTDOWN,
    event: PiLifecycleEvent.RELOAD,
    to: PiLifecycleState.EXTENSION_LOADED,
    idempotent: false,
  },
  {
    from: PiLifecycleState.EXTENSION_LOADED,
    event: PiLifecycleEvent.RELOAD,
    to: PiLifecycleState.EXTENSION_LOADED,
    idempotent: true,
  },
  {
    from: PiLifecycleState.RESOURCES_DISCOVERED,
    event: PiLifecycleEvent.RELOAD,
    to: PiLifecycleState.EXTENSION_LOADED,
    idempotent: false,
  },

  // ── Restart ──────────────────────────────────────────────────────────────────
  {
    // Restart after shutdown: session-scoped fields will be reset by the caller;
    // the machine returns to EXTENSION_LOADED to accept a new SESSION_START.
    from: PiLifecycleState.SESSION_SHUTDOWN,
    event: PiLifecycleEvent.RESTART,
    to: PiLifecycleState.EXTENSION_LOADED,
    idempotent: false,
  },
  {
    // Restart from WORKER_ADMITTED (CONTEXT_RESTART_REQUESTED path).
    from: PiLifecycleState.WORKER_ADMITTED,
    event: PiLifecycleEvent.RESTART,
    to: PiLifecycleState.SESSION_SHUTDOWN,
    idempotent: false,
  },
  {
    // Restart from WORKER_ACTIVE (tool is still running when restart is signaled).
    from: PiLifecycleState.WORKER_ACTIVE,
    event: PiLifecycleEvent.RESTART,
    to: PiLifecycleState.SESSION_SHUTDOWN,
    idempotent: false,
  },
]);

// Pre-index for O(1) lookup: key = `${from}:${event}`
const TRANSITION_INDEX = new Map<string, TransitionRow>();
for (const row of TRANSITION_TABLE) {
  TRANSITION_INDEX.set(`${row.from}:${row.event}`, row);
}

// ---------------------------------------------------------------------------
// LifecycleViolationKind — specific violation subtypes for diagnostic context
// ---------------------------------------------------------------------------

/**
 * Specific kind of lifecycle violation. Carried on TransitionFailure so
 * callers can route/log the specific issue without re-parsing description text.
 */
export enum LifecycleViolationKind {
  /** Event arrived in a state where it is not allowed. */
  INVALID_ORDERING = 'INVALID_ORDERING',
  /** Non-idempotent event fired more than once (e.g. duplicate SESSION_START). */
  DUPLICATE_NON_IDEMPOTENT = 'DUPLICATE_NON_IDEMPOTENT',
  /** SESSION_SHUTDOWN arrived while a tool turn was actively running. */
  SHUTDOWN_WITH_ACTIVE_RUN = 'SHUTDOWN_WITH_ACTIVE_RUN',
  /** BEFORE_AGENT_START arrived before SESSION_START completed (worker admission). */
  BEFORE_AGENT_START_BEFORE_ADMISSION = 'BEFORE_AGENT_START_BEFORE_ADMISSION',
  /** RESOURCES_DISCOVER failed (config/skill-path resolution error). */
  RESOURCES_DISCOVER_FAILURE = 'RESOURCES_DISCOVER_FAILURE',
  /** A second observer registration was attempted for the same Pi event. */
  DUPLICATE_OBSERVER_REGISTRATION = 'DUPLICATE_OBSERVER_REGISTRATION',
}

// ---------------------------------------------------------------------------
// Transition result types
// ---------------------------------------------------------------------------

/**
 * A lifecycle violation: invalid transition detected.
 *
 * Contains both the structured taxonomy routing result and a violation-specific
 * kind so callers can take appropriate action without parsing description text.
 */
export interface TransitionFailure {
  ok: false;
  kind: LifecycleViolationKind;
  /** The state the machine was in when the violation was detected. */
  fromState: PiLifecycleState;
  /** The event that triggered the violation. */
  event: PiLifecycleEvent;
  /** Human-readable description of the violation. */
  description: string;
  /** Central taxonomy routing result (n8fg). */
  routingResult: RoutingResult;
  /**
   * The idempotency key for this violation — deterministic, no random.
   * Format: `lifecycle_violation:${fromState}:${event}`.
   */
  idempotencyKey: string;
}

/**
 * A successful lifecycle transition.
 */
export interface TransitionSuccess {
  ok: true;
  /** State BEFORE the transition. */
  fromState: PiLifecycleState;
  /** The event that triggered the transition. */
  event: PiLifecycleEvent;
  /** State AFTER the transition. */
  toState: PiLifecycleState;
  /**
   * True when the event was idempotent and the machine stayed in the same state
   * without any side effects. Callers should skip side effects on idempotent transitions.
   */
  wasIdempotent: boolean;
  /**
   * True when shutdown was detected while a tool run was active (WORKER_ACTIVE →
   * SESSION_SHUTDOWN transition). The caller should emit a diagnostic but proceed
   * with shutdown.
   */
  shutdownWithActiveRun: boolean;
}

export type TransitionResult = TransitionSuccess | TransitionFailure;

// ---------------------------------------------------------------------------
// LifecycleMachineState — mutable state held by the caller (extension.ts)
// ---------------------------------------------------------------------------

/**
 * The mutable state held by the lifecycle machine holder (ExtensionSession).
 *
 * Kept small and serialisable. The caller owns the struct and passes it to
 * every transition() call.
 */
export interface LifecycleMachineState {
  /** Current lifecycle state. */
  currentState: PiLifecycleState;
  /** Run mode determined at SESSION_START. */
  runMode: RunMode;
  /** Supervisor health stage. Updated by the caller on supervisor state changes. */
  supervisorHealthStage: SupervisorHealthStage;
}

/**
 * Create a fresh LifecycleMachineState for a new extension session.
 */
export function createLifecycleMachineState(): LifecycleMachineState {
  return {
    currentState: PiLifecycleState.EXTENSION_LOADED,
    runMode: RunMode.UNKNOWN,
    supervisorHealthStage: SupervisorHealthStage.NOT_INITIALISED,
  };
}

// ---------------------------------------------------------------------------
// Violation-kind classifier
// ---------------------------------------------------------------------------

function classifyViolation(
  fromState: PiLifecycleState,
  event: PiLifecycleEvent
): LifecycleViolationKind {
  // Duplicate SESSION_START → duplicate observer registration
  if (
    event === PiLifecycleEvent.SESSION_START &&
    fromState === PiLifecycleState.SESSION_ACTIVE
  ) {
    return LifecycleViolationKind.DUPLICATE_OBSERVER_REGISTRATION;
  }

  // BEFORE_AGENT_START before SESSION_START → admission out of order
  if (
    event === PiLifecycleEvent.BEFORE_AGENT_START &&
    fromState === PiLifecycleState.EXTENSION_LOADED
  ) {
    return LifecycleViolationKind.BEFORE_AGENT_START_BEFORE_ADMISSION;
  }

  // BEFORE_AGENT_START after resources_discover (no SESSION_START yet)
  if (
    event === PiLifecycleEvent.BEFORE_AGENT_START &&
    fromState === PiLifecycleState.RESOURCES_DISCOVERED
  ) {
    return LifecycleViolationKind.BEFORE_AGENT_START_BEFORE_ADMISSION;
  }

  // Default: invalid ordering
  return LifecycleViolationKind.INVALID_ORDERING;
}

// ---------------------------------------------------------------------------
// Main transition function — pure, synchronous
// ---------------------------------------------------------------------------

/**
 * Attempt a lifecycle transition.
 *
 * This is a PURE SYNCHRONOUS function. It has no side effects — it only reads
 * the current state from `machine` and returns a TransitionResult. The caller
 * is responsible for:
 *   1. Mutating `machine.currentState` if `result.ok === true`.
 *   2. Emitting domain events and/or diagnostics based on the result.
 *   3. Skipping side effects when `result.wasIdempotent === true`.
 *
 * DETERMINISM: no Date.now() or Math.random() in this function. Timestamps
 * belong in the event payload layer.
 */
export function transition(
  machine: Readonly<LifecycleMachineState>,
  event: PiLifecycleEvent
): TransitionResult {
  const fromState = machine.currentState;
  const row = TRANSITION_INDEX.get(`${fromState}:${event}`);

  if (!row) {
    // No allowed transition found → LIFECYCLE_VIOLATION
    const kind = classifyViolation(fromState, event);
    const description = buildViolationDescription(fromState, event, kind);
    const lifecyclePhase = stateToLifecyclePhase(fromState);
    const routingResult = routeFailure({
      failureClass: FailureClass.LIFECYCLE_VIOLATION,
      lifecyclePhase,
      retryBudget: RetryBudget.EXHAUSTED,
      authorityLevel: AuthorityLevel.HARNESS,
    });

    return {
      ok: false,
      kind,
      fromState,
      event,
      description,
      routingResult,
      idempotencyKey: `lifecycle_violation:${fromState}:${event}`,
    };
  }

  // Allowed transition found.
  const toState = row.to;
  const wasIdempotent = row.idempotent && fromState === toState;

  // Special diagnostic: shutdown while active run is running.
  const shutdownWithActiveRun =
    event === PiLifecycleEvent.SESSION_SHUTDOWN &&
    fromState === PiLifecycleState.WORKER_ACTIVE;

  return {
    ok: true,
    fromState,
    event,
    toState,
    wasIdempotent,
    shutdownWithActiveRun,
  };
}

/**
 * Apply a transition result to the mutable machine state.
 *
 * Call this AFTER confirming result.ok === true. Returns the new state.
 * Kept separate from transition() to preserve the pure-function contract.
 */
export function applyTransition(
  machine: LifecycleMachineState,
  result: TransitionSuccess
): PiLifecycleState {
  machine.currentState = result.toState;
  return result.toState;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a PiLifecycleState to the appropriate LifecyclePhase for taxonomy routing.
 *
 * Maps the Pi-specific lifecycle concepts onto the n8fg LifecyclePhase taxonomy
 * so violation diagnostics carry the correct phase context.
 */
function stateToLifecyclePhase(state: PiLifecycleState): LifecyclePhase {
  switch (state) {
    case PiLifecycleState.EXTENSION_LOADED:
    case PiLifecycleState.RESOURCES_DISCOVERED:
      return LifecyclePhase.STARTUP;
    case PiLifecycleState.SESSION_ACTIVE:
    case PiLifecycleState.WORKER_ADMITTED:
      return LifecyclePhase.SPAWN;
    case PiLifecycleState.WORKER_ACTIVE:
      return LifecyclePhase.RUNNING;
    case PiLifecycleState.SESSION_SHUTDOWN:
      return LifecyclePhase.SHUTDOWN;
    case PiLifecycleState.RELOADED:
      return LifecyclePhase.TRANSITION;
    default: {
      // Exhaustive check — TypeScript will error if a state is not handled.
      const _exhaustive: never = state;
      return LifecyclePhase.RUNNING;
    }
  }
}

function buildViolationDescription(
  fromState: PiLifecycleState,
  event: PiLifecycleEvent,
  kind: LifecycleViolationKind
): string {
  switch (kind) {
    case LifecycleViolationKind.DUPLICATE_OBSERVER_REGISTRATION:
      return (
        `Duplicate observer registration: SESSION_START fired again in ${fromState}. ` +
        `Pi observers must be registered exactly once per session.`
      );
    case LifecycleViolationKind.BEFORE_AGENT_START_BEFORE_ADMISSION:
      return (
        `BEFORE_AGENT_START arrived before admission: event=${event}, state=${fromState}. ` +
        `SESSION_START must complete before BEFORE_AGENT_START can be processed.`
      );
    case LifecycleViolationKind.DUPLICATE_NON_IDEMPOTENT:
      return (
        `Duplicate non-idempotent event: event=${event} fired again in ${fromState}. ` +
        `This event is non-idempotent and must not be repeated in the same state.`
      );
    case LifecycleViolationKind.SHUTDOWN_WITH_ACTIVE_RUN:
      return (
        `SESSION_SHUTDOWN arrived while a tool turn was active (${fromState}). ` +
        `Cleanup will proceed but the active tool invocation may be interrupted.`
      );
    case LifecycleViolationKind.RESOURCES_DISCOVER_FAILURE:
      return (
        `RESOURCES_DISCOVER failed in state ${fromState}. ` +
        `Skill-path resolution error prevents resource registration.`
      );
    case LifecycleViolationKind.INVALID_ORDERING:
      return (
        `Invalid lifecycle event ordering: event=${event} is not allowed in state=${fromState}. ` +
        `Check the TRANSITION_TABLE for allowed (from, event) pairs.`
      );
  }
}

/**
 * Build a resources-discover failure TransitionFailure without attempting
 * a state transition. Used when the RESOURCES_DISCOVER handler encounters
 * an error during skill-path resolution.
 *
 * The lifecycle state is NOT advanced — the machine stays in its current state
 * so a subsequent retry can try again.
 */
export function buildResourcesDiscoverFailure(
  machine: Readonly<LifecycleMachineState>
): TransitionFailure {
  const fromState = machine.currentState;
  const kind = LifecycleViolationKind.RESOURCES_DISCOVER_FAILURE;
  const description = buildViolationDescription(fromState, PiLifecycleEvent.RESOURCES_DISCOVER, kind);
  const routingResult = routeFailure({
    failureClass: FailureClass.LIFECYCLE_VIOLATION,
    lifecyclePhase: LifecyclePhase.STARTUP,
    retryBudget: RetryBudget.EXHAUSTED,
    authorityLevel: AuthorityLevel.HARNESS,
  });
  return {
    ok: false,
    kind,
    fromState,
    event: PiLifecycleEvent.RESOURCES_DISCOVER,
    description,
    routingResult,
    idempotencyKey: `lifecycle_violation:${fromState}:${PiLifecycleEvent.RESOURCES_DISCOVER}:failure`,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle field builder for domain event payloads (AC5)
// ---------------------------------------------------------------------------

/**
 * Build the lifecycle/health/runMode fields to include on health, capacity, and
 * lifecycle domain events (AC5 — typed fields through the schema-validated path).
 *
 * Callers spread this into their event payload. Example:
 *
 *   await eventStore.record(DomainEventName.HARNESS_STARTED, {
 *     ...buildLifecycleEventFields(machine),
 *     beadId: '...',
 *     ...
 *   });
 */
export function buildLifecycleEventFields(machine: Readonly<LifecycleMachineState>): {
  lifecycleState: PiLifecycleState;
  supervisorHealthStage: SupervisorHealthStage;
  runMode: RunMode;
} {
  return {
    lifecycleState: machine.currentState,
    supervisorHealthStage: machine.supervisorHealthStage,
    runMode: machine.runMode,
  };
}

/**
 * Exported read-only snapshot of the transition table.
 * Used by tests to confirm coverage of all declared transitions.
 */
export const ALL_TRANSITIONS: readonly TransitionRow[] = TRANSITION_TABLE;

/**
 * Re-export LifecyclePhase for convenience — callers that route lifecycle
 * violations need it for routeFailure() calls and it should come from the
 * single taxonomy source (n8fg), not be duplicated here.
 */
export { LifecyclePhase } from './FailureTaxonomy.js';
