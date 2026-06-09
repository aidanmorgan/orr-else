/**
 * FailureTaxonomy — authoritative deterministic failure classification and run-mode routing.
 *
 * pi-experiment-n8fg
 *
 * PURPOSE
 * -------
 * Every failure the harness can encounter falls into exactly one FailureClass.
 * Every FailureClass × LifecyclePhase × RetryBudget × AuthorityLevel combination
 * maps to exactly one NextAction via an exhaustive routing table.
 *
 * NO LLM / prompt text is involved at any routing step.  routeFailure() is a
 * pure, synchronous TypeScript function: same key → same result, always.
 *
 * USAGE
 * -----
 * Startup admission, scheduler, supervisor, event-store, tool invocation, and
 * audit surfaces all import from this module and call routeFailure().  They do
 * NOT define their own local categories — this IS the taxonomy.
 *
 * l3k4 (supervisor wiring) and other beads wire existing surfaces to consume
 * these results; this bead only defines the taxonomy + API.
 */

// ---------------------------------------------------------------------------
// Failure classes — code-owned, exhaustive
// ---------------------------------------------------------------------------

/**
 * Canonical failure classes for the harness.  Each value maps to a distinct
 * failure domain.  No failure is allowed to be unclassified at routing time.
 *
 * Do NOT add values to this enum from parallel beads — extend here only.
 * Do NOT put these constants in src/constants/domain.ts; they live here to
 * avoid merge conflicts with parallel beads that modify that file.
 */
export enum FailureClass {
  /** Config file missing, unparseable, or schema-invalid. */
  CONFIG_ERROR = 'config_error',
  /** Host OS / node process / fs substrate unavailable at startup. */
  STARTUP_SUBSTRATE = 'startup_substrate',
  /** Project tool, MCP backend, or external service not ready. */
  BACKEND_READINESS = 'backend_readiness',
  /** Provider usage limit, quota exhausted, or out-of-credits. */
  PROVIDER_LIMIT = 'provider_limit',
  /** Network blip, websocket drop, response-header timeout, or connection reset. */
  TRANSIENT_TRANSPORT = 'transient_transport',
  /** Tmux pane death, teammate process exit, or heartbeat-only orphan. */
  WORKER_PROCESS_LOSS = 'worker_process_loss',
  /** Verifier gate blocked transition; artifact absent or verify() returned false. */
  VERIFIER_GATE = 'verifier_gate',
  /** Event-store append, read, schema, or index failure. */
  EVENT_STORE = 'event_store',
  /** Disk space pressure or retention-cleanup failure (ENOSPC, disk health warn). */
  RETENTION_PRESSURE = 'retention_pressure',
  /** File-access policy rejection or sandbox permission denied. */
  SANDBOX_PERMISSION = 'sandbox_permission',
  /** Signal arrived for wrong state, duplicate, or out-of-order lifecycle event. */
  LIFECYCLE_VIOLATION = 'lifecycle_violation',
  /** Operator-placed external blocker (mailbox BLOCKER, explicit STATE_BLOCKED). */
  OPERATOR_BLOCKER = 'operator_blocker',
}

// ---------------------------------------------------------------------------
// Lifecycle phases — when did the failure occur?
// ---------------------------------------------------------------------------

/** Lifecycle phase in which the failure was detected. */
export enum LifecyclePhase {
  /** Before the harness event loop begins (config load, event-store open, etc.). */
  STARTUP = 'startup',
  /** During bead claim, worktree creation, or MCP preflight before spawn. */
  SPAWN = 'spawn',
  /** During active teammate execution (agent turn, tool invocation, etc.). */
  RUNNING = 'running',
  /** During state gate evaluation or statechart transition decision. */
  TRANSITION = 'transition',
  /** During coordinator shutdown or cleanup. */
  SHUTDOWN = 'shutdown',
}

// ---------------------------------------------------------------------------
// Routing key dimensions
// ---------------------------------------------------------------------------

/** Whether the per-bead retry budget has been consumed. */
export enum RetryBudget {
  /** Retries remain for this failure class + bead combination. */
  AVAILABLE = 'available',
  /** Retry budget exhausted — no more retries permitted. */
  EXHAUSTED = 'exhausted',
}

/**
 * Which authority level is invoking the routing decision.
 * HARNESS = coordinator core; TOOL = project-tool or plugin surface.
 * Authority level can modulate action severity (e.g. TOOL failures during
 * RUNNING may downgrade to WARNING vs TERMINAL_REJECT).
 */
export enum AuthorityLevel {
  HARNESS = 'harness',
  TOOL = 'tool',
}

// ---------------------------------------------------------------------------
// Next actions — exactly 7; every table row maps to exactly one
// ---------------------------------------------------------------------------

/**
 * The seven deterministic next actions the harness can take.
 * No failure routing result may produce a value outside this set.
 */
export enum NextAction {
  /** Abort harness startup with a fatal error. No spawn attempted. */
  STARTUP_FAIL = 'startup_fail',
  /** Suspend scheduling until the capacity-pause window expires. */
  SCHEDULING_PAUSE = 'scheduling_pause',
  /** Place bead in quarantine; skip it until its signature changes. */
  QUARANTINE = 'quarantine',
  /** Increment retry counter and retry within the configured budget. */
  BOUNDED_RETRY = 'bounded_retry',
  /** Block the statechart transition; bead remains in current state. */
  STATE_TRANSITION_BLOCK = 'state_transition_block',
  /** Permanently reject; bead moves to terminal FAILED status. */
  TERMINAL_REJECT = 'terminal_reject',
  /** Emit a warning event and continue without changing bead status. */
  WARNING = 'warning',
}

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/** Key used to look up the routing table row. */
export interface RoutingKey {
  failureClass: FailureClass;
  lifecyclePhase: LifecyclePhase;
  retryBudget: RetryBudget;
  authorityLevel: AuthorityLevel;
}

/** Result returned by routeFailure(). */
export interface RoutingResult {
  /** The unique row identifier in the routing table. */
  rowId: string;
  /** The single deterministic next action for this key combination. */
  nextAction: NextAction;
  /** Human-readable description of the routing decision (for logs/audit). */
  description: string;
}

/**
 * Compact descriptor for status and audit surfaces.
 * Intentionally small — fits on one log line or in a tight JSON payload.
 */
export interface CompactDescriptor {
  /** The failure class string. */
  cls: string;
  /** The routing table row ID. */
  rowId: string;
  /** The next action string. */
  action: string;
}

// ---------------------------------------------------------------------------
// Frozen exported lists — bypass-prevention: these are the ONLY valid values
// ---------------------------------------------------------------------------

/** All valid FailureClass values. Frozen — cannot be mutated at runtime. */
export const ALL_FAILURE_CLASSES: readonly FailureClass[] = Object.freeze([
  FailureClass.CONFIG_ERROR,
  FailureClass.STARTUP_SUBSTRATE,
  FailureClass.BACKEND_READINESS,
  FailureClass.PROVIDER_LIMIT,
  FailureClass.TRANSIENT_TRANSPORT,
  FailureClass.WORKER_PROCESS_LOSS,
  FailureClass.VERIFIER_GATE,
  FailureClass.EVENT_STORE,
  FailureClass.RETENTION_PRESSURE,
  FailureClass.SANDBOX_PERMISSION,
  FailureClass.LIFECYCLE_VIOLATION,
  FailureClass.OPERATOR_BLOCKER,
]);

/** All valid LifecyclePhase values. Frozen — cannot be mutated at runtime. */
export const ALL_LIFECYCLE_PHASES: readonly LifecyclePhase[] = Object.freeze([
  LifecyclePhase.STARTUP,
  LifecyclePhase.SPAWN,
  LifecyclePhase.RUNNING,
  LifecyclePhase.TRANSITION,
  LifecyclePhase.SHUTDOWN,
]);

// ---------------------------------------------------------------------------
// Internal routing table
// ---------------------------------------------------------------------------

/**
 * Internal row definition — one entry per (class, phase, budget, authority) combination
 * that needs a non-default action.
 *
 * DEFAULT RULE (applied when no specific row matches):
 *   budget=AVAILABLE  → BOUNDED_RETRY
 *   budget=EXHAUSTED  → SCHEDULING_PAUSE
 * This ensures every cell is covered without listing all 240 combinations explicitly.
 *
 * Row IDs follow the convention: <class>.<phase>[.<budget>][.<authority>]
 * The narrower the match, the longer the ID.
 */
interface TableRow {
  rowId: string;
  failureClass: FailureClass;
  lifecyclePhase: LifecyclePhase;
  /** undefined = matches any budget */
  retryBudget?: RetryBudget;
  /** undefined = matches any authority */
  authorityLevel?: AuthorityLevel;
  nextAction: NextAction;
  description: string;
}

/**
 * The exhaustive routing table.
 *
 * Resolution order: most specific match first (by number of defined fields).
 * Rows are tried top-to-bottom; the FIRST match wins.
 *
 * Design principle: fatal/irreversible outcomes are listed explicitly.
 * Retryable/soft outcomes fall through to the default rule.
 */
const ROUTING_TABLE: readonly TableRow[] = Object.freeze([
  // ─── CONFIG_ERROR ──────────────────────────────────────────────────────────
  // Config errors are always fatal at startup; at any other phase they are
  // terminal (config cannot change mid-run without restart).
  {
    rowId: 'config_error.startup',
    failureClass: FailureClass.CONFIG_ERROR,
    lifecyclePhase: LifecyclePhase.STARTUP,
    nextAction: NextAction.STARTUP_FAIL,
    description: 'Config schema/parse error at harness startup — abort before any spawn.'
  },
  {
    rowId: 'config_error.spawn',
    failureClass: FailureClass.CONFIG_ERROR,
    lifecyclePhase: LifecyclePhase.SPAWN,
    nextAction: NextAction.TERMINAL_REJECT,
    description: 'Config error detected during spawn preflight — permanently reject bead.'
  },
  {
    rowId: 'config_error.running',
    failureClass: FailureClass.CONFIG_ERROR,
    lifecyclePhase: LifecyclePhase.RUNNING,
    nextAction: NextAction.TERMINAL_REJECT,
    description: 'Config error detected during active run — permanently reject bead.'
  },
  {
    rowId: 'config_error.transition',
    failureClass: FailureClass.CONFIG_ERROR,
    lifecyclePhase: LifecyclePhase.TRANSITION,
    nextAction: NextAction.TERMINAL_REJECT,
    description: 'Config error detected at transition — permanently reject bead.'
  },
  {
    rowId: 'config_error.shutdown',
    failureClass: FailureClass.CONFIG_ERROR,
    lifecyclePhase: LifecyclePhase.SHUTDOWN,
    nextAction: NextAction.WARNING,
    description: 'Config error during shutdown — emit warning, harness already stopping.'
  },

  // ─── STARTUP_SUBSTRATE ─────────────────────────────────────────────────────
  // Substrate (fs, node, OS) failures at startup are fatal.
  // At spawn they quarantine the bead (retry when substrate recovers = signature changes).
  // At running/shutdown they are warnings (substrate was healthy when started).
  {
    rowId: 'startup_substrate.startup',
    failureClass: FailureClass.STARTUP_SUBSTRATE,
    lifecyclePhase: LifecyclePhase.STARTUP,
    nextAction: NextAction.STARTUP_FAIL,
    description: 'Host OS / fs substrate unavailable at startup — abort harness.'
  },
  {
    rowId: 'startup_substrate.spawn',
    failureClass: FailureClass.STARTUP_SUBSTRATE,
    lifecyclePhase: LifecyclePhase.SPAWN,
    nextAction: NextAction.QUARANTINE,
    description: 'Substrate failure during worktree/spawn preflight — quarantine bead.'
  },
  {
    rowId: 'startup_substrate.running',
    failureClass: FailureClass.STARTUP_SUBSTRATE,
    lifecyclePhase: LifecyclePhase.RUNNING,
    nextAction: NextAction.WARNING,
    description: 'Substrate degradation during active run — emit warning, continue.'
  },
  {
    rowId: 'startup_substrate.transition',
    failureClass: FailureClass.STARTUP_SUBSTRATE,
    lifecyclePhase: LifecyclePhase.TRANSITION,
    nextAction: NextAction.STATE_TRANSITION_BLOCK,
    description: 'Substrate error at transition — block until substrate recovers.'
  },
  {
    rowId: 'startup_substrate.shutdown',
    failureClass: FailureClass.STARTUP_SUBSTRATE,
    lifecyclePhase: LifecyclePhase.SHUTDOWN,
    nextAction: NextAction.WARNING,
    description: 'Substrate error during shutdown — emit warning, continue stopping.'
  },

  // ─── BACKEND_READINESS ─────────────────────────────────────────────────────
  // MCP or project-tool backend not ready.
  // Fatal at startup (preflight must pass before the loop begins).
  // Quarantine at spawn (MCP preflight collapsed-health gate).
  // Pause scheduling at running/transition when budget exhausted (backend needs time to recover).
  {
    rowId: 'backend_readiness.startup',
    failureClass: FailureClass.BACKEND_READINESS,
    lifecyclePhase: LifecyclePhase.STARTUP,
    nextAction: NextAction.STARTUP_FAIL,
    description: 'Required backend unavailable at startup — abort harness.'
  },
  {
    rowId: 'backend_readiness.spawn',
    failureClass: FailureClass.BACKEND_READINESS,
    lifecyclePhase: LifecyclePhase.SPAWN,
    nextAction: NextAction.QUARANTINE,
    description: 'MCP/backend unavailable during spawn preflight — quarantine bead.'
  },
  {
    rowId: 'backend_readiness.running.available',
    failureClass: FailureClass.BACKEND_READINESS,
    lifecyclePhase: LifecyclePhase.RUNNING,
    retryBudget: RetryBudget.AVAILABLE,
    nextAction: NextAction.BOUNDED_RETRY,
    description: 'Backend temporarily unavailable during run — retry within budget.'
  },
  {
    rowId: 'backend_readiness.running.exhausted',
    failureClass: FailureClass.BACKEND_READINESS,
    lifecyclePhase: LifecyclePhase.RUNNING,
    retryBudget: RetryBudget.EXHAUSTED,
    nextAction: NextAction.SCHEDULING_PAUSE,
    description: 'Backend unavailable, retries exhausted — pause scheduling.'
  },
  {
    rowId: 'backend_readiness.transition',
    failureClass: FailureClass.BACKEND_READINESS,
    lifecyclePhase: LifecyclePhase.TRANSITION,
    nextAction: NextAction.STATE_TRANSITION_BLOCK,
    description: 'Backend unavailable at transition — block until available.'
  },
  {
    rowId: 'backend_readiness.shutdown',
    failureClass: FailureClass.BACKEND_READINESS,
    lifecyclePhase: LifecyclePhase.SHUTDOWN,
    nextAction: NextAction.WARNING,
    description: 'Backend unavailable during shutdown — emit warning, continue stopping.'
  },

  // ─── PROVIDER_LIMIT ────────────────────────────────────────────────────────
  // Usage-limit / quota pause — always SCHEDULING_PAUSE regardless of budget.
  // At startup it is fatal (no point running if provider is already at limit).
  // At transition it blocks (operator must resolve the limit before advancing).
  {
    rowId: 'provider_limit.startup',
    failureClass: FailureClass.PROVIDER_LIMIT,
    lifecyclePhase: LifecyclePhase.STARTUP,
    nextAction: NextAction.STARTUP_FAIL,
    description: 'Provider usage limit hit before harness event loop started — abort.'
  },
  {
    rowId: 'provider_limit.spawn',
    failureClass: FailureClass.PROVIDER_LIMIT,
    lifecyclePhase: LifecyclePhase.SPAWN,
    nextAction: NextAction.SCHEDULING_PAUSE,
    description: 'Provider limit hit during spawn — pause scheduling.'
  },
  {
    rowId: 'provider_limit.running',
    failureClass: FailureClass.PROVIDER_LIMIT,
    lifecyclePhase: LifecyclePhase.RUNNING,
    nextAction: NextAction.SCHEDULING_PAUSE,
    description: 'Provider usage limit / out-of-credits during run — pause scheduling.'
  },
  {
    rowId: 'provider_limit.transition',
    failureClass: FailureClass.PROVIDER_LIMIT,
    lifecyclePhase: LifecyclePhase.TRANSITION,
    nextAction: NextAction.STATE_TRANSITION_BLOCK,
    description: 'Provider limit at transition — block until limit clears.'
  },
  {
    rowId: 'provider_limit.shutdown',
    failureClass: FailureClass.PROVIDER_LIMIT,
    lifecyclePhase: LifecyclePhase.SHUTDOWN,
    nextAction: NextAction.WARNING,
    description: 'Provider limit during shutdown — emit warning, continue stopping.'
  },

  // ─── TRANSIENT_TRANSPORT ───────────────────────────────────────────────────
  // Network blips, websocket drops, connection resets.
  // Budget-sensitive: retry while budget available, pause when exhausted.
  {
    rowId: 'transient_transport.startup',
    failureClass: FailureClass.TRANSIENT_TRANSPORT,
    lifecyclePhase: LifecyclePhase.STARTUP,
    nextAction: NextAction.STARTUP_FAIL,
    description: 'Transport failure at startup — abort (cannot proceed without network).'
  },
  {
    rowId: 'transient_transport.spawn.available',
    failureClass: FailureClass.TRANSIENT_TRANSPORT,
    lifecyclePhase: LifecyclePhase.SPAWN,
    retryBudget: RetryBudget.AVAILABLE,
    nextAction: NextAction.BOUNDED_RETRY,
    description: 'Transport blip during spawn — retry within budget.'
  },
  {
    rowId: 'transient_transport.spawn.exhausted',
    failureClass: FailureClass.TRANSIENT_TRANSPORT,
    lifecyclePhase: LifecyclePhase.SPAWN,
    retryBudget: RetryBudget.EXHAUSTED,
    nextAction: NextAction.QUARANTINE,
    description: 'Transport failure at spawn, budget exhausted — quarantine bead.'
  },
  {
    rowId: 'transient_transport.running.available',
    failureClass: FailureClass.TRANSIENT_TRANSPORT,
    lifecyclePhase: LifecyclePhase.RUNNING,
    retryBudget: RetryBudget.AVAILABLE,
    nextAction: NextAction.BOUNDED_RETRY,
    description: 'Transient transport failure during run — retry within budget.'
  },
  {
    rowId: 'transient_transport.running.exhausted',
    failureClass: FailureClass.TRANSIENT_TRANSPORT,
    lifecyclePhase: LifecyclePhase.RUNNING,
    retryBudget: RetryBudget.EXHAUSTED,
    nextAction: NextAction.SCHEDULING_PAUSE,
    description: 'Transient transport failures exhausted budget — pause scheduling.'
  },
  {
    rowId: 'transient_transport.transition.available',
    failureClass: FailureClass.TRANSIENT_TRANSPORT,
    lifecyclePhase: LifecyclePhase.TRANSITION,
    retryBudget: RetryBudget.AVAILABLE,
    nextAction: NextAction.BOUNDED_RETRY,
    description: 'Transport failure at transition — retry within budget.'
  },
  {
    rowId: 'transient_transport.transition.exhausted',
    failureClass: FailureClass.TRANSIENT_TRANSPORT,
    lifecyclePhase: LifecyclePhase.TRANSITION,
    retryBudget: RetryBudget.EXHAUSTED,
    nextAction: NextAction.STATE_TRANSITION_BLOCK,
    description: 'Transport failures at transition exhausted — block transition.'
  },
  {
    rowId: 'transient_transport.shutdown',
    failureClass: FailureClass.TRANSIENT_TRANSPORT,
    lifecyclePhase: LifecyclePhase.SHUTDOWN,
    nextAction: NextAction.WARNING,
    description: 'Transport error during shutdown — emit warning, continue stopping.'
  },

  // ─── WORKER_PROCESS_LOSS ───────────────────────────────────────────────────
  // Tmux pane death, teammate exit, heartbeat-only orphan.
  // Budget-sensitive: bounded retry while available, quarantine when exhausted.
  {
    rowId: 'worker_process_loss.startup',
    failureClass: FailureClass.WORKER_PROCESS_LOSS,
    lifecyclePhase: LifecyclePhase.STARTUP,
    nextAction: NextAction.STARTUP_FAIL,
    description: 'Worker substrate (tmux/pane) unavailable at startup — abort.'
  },
  {
    rowId: 'worker_process_loss.spawn.available',
    failureClass: FailureClass.WORKER_PROCESS_LOSS,
    lifecyclePhase: LifecyclePhase.SPAWN,
    retryBudget: RetryBudget.AVAILABLE,
    nextAction: NextAction.BOUNDED_RETRY,
    description: 'Spawn failed — worker process lost; retry within budget.'
  },
  {
    rowId: 'worker_process_loss.spawn.exhausted',
    failureClass: FailureClass.WORKER_PROCESS_LOSS,
    lifecyclePhase: LifecyclePhase.SPAWN,
    retryBudget: RetryBudget.EXHAUSTED,
    nextAction: NextAction.QUARANTINE,
    description: 'Spawn retries exhausted for worker process loss — quarantine bead.'
  },
  {
    rowId: 'worker_process_loss.running.available',
    failureClass: FailureClass.WORKER_PROCESS_LOSS,
    lifecyclePhase: LifecyclePhase.RUNNING,
    retryBudget: RetryBudget.AVAILABLE,
    nextAction: NextAction.BOUNDED_RETRY,
    description: 'Teammate process exited during run — bounded retry within budget.'
  },
  {
    rowId: 'worker_process_loss.running.exhausted',
    failureClass: FailureClass.WORKER_PROCESS_LOSS,
    lifecyclePhase: LifecyclePhase.RUNNING,
    retryBudget: RetryBudget.EXHAUSTED,
    nextAction: NextAction.QUARANTINE,
    description: 'Repeated worker process loss, budget exhausted — quarantine bead.'
  },
  {
    rowId: 'worker_process_loss.transition',
    failureClass: FailureClass.WORKER_PROCESS_LOSS,
    lifecyclePhase: LifecyclePhase.TRANSITION,
    nextAction: NextAction.STATE_TRANSITION_BLOCK,
    description: 'Worker lost at transition — block until re-spawned.'
  },
  {
    rowId: 'worker_process_loss.shutdown',
    failureClass: FailureClass.WORKER_PROCESS_LOSS,
    lifecyclePhase: LifecyclePhase.SHUTDOWN,
    nextAction: NextAction.WARNING,
    description: 'Worker lost during shutdown — expected; emit warning only.'
  },

  // ─── VERIFIER_GATE ─────────────────────────────────────────────────────────
  // Gate blocked transition — always STATE_TRANSITION_BLOCK (gate IS the authority).
  // At startup it is fatal (gate should not fire before the loop begins, but if it does
  // something structural is wrong). At running it blocks the transition.
  {
    rowId: 'verifier_gate.startup',
    failureClass: FailureClass.VERIFIER_GATE,
    lifecyclePhase: LifecyclePhase.STARTUP,
    nextAction: NextAction.STARTUP_FAIL,
    description: 'Verifier gate fired at startup (structural error) — abort harness.'
  },
  {
    rowId: 'verifier_gate.spawn',
    failureClass: FailureClass.VERIFIER_GATE,
    lifecyclePhase: LifecyclePhase.SPAWN,
    nextAction: NextAction.QUARANTINE,
    description: 'Gate failure during spawn preflight — quarantine bead.'
  },
  {
    rowId: 'verifier_gate.running',
    failureClass: FailureClass.VERIFIER_GATE,
    lifecyclePhase: LifecyclePhase.RUNNING,
    nextAction: NextAction.STATE_TRANSITION_BLOCK,
    description: 'Verifier gate blocked transition during run — hold bead in current state.'
  },
  {
    rowId: 'verifier_gate.transition',
    failureClass: FailureClass.VERIFIER_GATE,
    lifecyclePhase: LifecyclePhase.TRANSITION,
    nextAction: NextAction.STATE_TRANSITION_BLOCK,
    description: 'Verifier gate blocked explicit transition — hold bead in current state.'
  },
  {
    rowId: 'verifier_gate.shutdown',
    failureClass: FailureClass.VERIFIER_GATE,
    lifecyclePhase: LifecyclePhase.SHUTDOWN,
    nextAction: NextAction.WARNING,
    description: 'Gate fired during shutdown — emit warning, harness already stopping.'
  },

  // ─── EVENT_STORE ───────────────────────────────────────────────────────────
  // Event-store failures at startup are fatal (no durable log = cannot run safely).
  // At running they are best-effort warnings (append failures don't halt the bead).
  // At transition they block (we need the store to record the transition safely).
  {
    rowId: 'event_store.startup',
    failureClass: FailureClass.EVENT_STORE,
    lifecyclePhase: LifecyclePhase.STARTUP,
    nextAction: NextAction.STARTUP_FAIL,
    description: 'Event store unavailable at startup — abort (cannot run without durable log).'
  },
  {
    rowId: 'event_store.spawn',
    failureClass: FailureClass.EVENT_STORE,
    lifecyclePhase: LifecyclePhase.SPAWN,
    nextAction: NextAction.QUARANTINE,
    description: 'Event store failure during spawn — quarantine bead (audit trail at risk).'
  },
  {
    rowId: 'event_store.running',
    failureClass: FailureClass.EVENT_STORE,
    lifecyclePhase: LifecyclePhase.RUNNING,
    nextAction: NextAction.WARNING,
    description: 'Event store append/read failure during run — best-effort warning, continue.'
  },
  {
    rowId: 'event_store.transition',
    failureClass: FailureClass.EVENT_STORE,
    lifecyclePhase: LifecyclePhase.TRANSITION,
    nextAction: NextAction.STATE_TRANSITION_BLOCK,
    description: 'Event store failure at transition — block until store is stable.'
  },
  {
    rowId: 'event_store.shutdown',
    failureClass: FailureClass.EVENT_STORE,
    lifecyclePhase: LifecyclePhase.SHUTDOWN,
    nextAction: NextAction.WARNING,
    description: 'Event store failure during shutdown — emit warning, continue stopping.'
  },

  // ─── RETENTION_PRESSURE ────────────────────────────────────────────────────
  // Disk-space / retention pressure — always WARNING (best-effort cleanup).
  // The harness continues; operator must intervene if disk is truly exhausted.
  {
    rowId: 'retention_pressure.startup',
    failureClass: FailureClass.RETENTION_PRESSURE,
    lifecyclePhase: LifecyclePhase.STARTUP,
    nextAction: NextAction.WARNING,
    description: 'Disk/retention pressure at startup — warn; harness continues.'
  },
  {
    rowId: 'retention_pressure.spawn',
    failureClass: FailureClass.RETENTION_PRESSURE,
    lifecyclePhase: LifecyclePhase.SPAWN,
    nextAction: NextAction.WARNING,
    description: 'Disk pressure during spawn — warn; spawn proceeds.'
  },
  {
    rowId: 'retention_pressure.running',
    failureClass: FailureClass.RETENTION_PRESSURE,
    lifecyclePhase: LifecyclePhase.RUNNING,
    nextAction: NextAction.WARNING,
    description: 'Disk pressure during run — warn; bead continues.'
  },
  {
    rowId: 'retention_pressure.transition',
    failureClass: FailureClass.RETENTION_PRESSURE,
    lifecyclePhase: LifecyclePhase.TRANSITION,
    nextAction: NextAction.WARNING,
    description: 'Disk pressure at transition — warn; transition allowed to proceed.'
  },
  {
    rowId: 'retention_pressure.shutdown',
    failureClass: FailureClass.RETENTION_PRESSURE,
    lifecyclePhase: LifecyclePhase.SHUTDOWN,
    nextAction: NextAction.WARNING,
    description: 'Disk pressure during shutdown — warn; continue stopping.'
  },

  // ─── SANDBOX_PERMISSION ────────────────────────────────────────────────────
  // File-access policy rejection or permission denied.
  // Always TERMINAL_REJECT during an active bead run (model violated policy).
  // At startup / spawn → STARTUP_FAIL / QUARANTINE (infrastructure misconfiguration).
  {
    rowId: 'sandbox_permission.startup',
    failureClass: FailureClass.SANDBOX_PERMISSION,
    lifecyclePhase: LifecyclePhase.STARTUP,
    nextAction: NextAction.STARTUP_FAIL,
    description: 'Permission / sandbox misconfiguration at startup — abort.'
  },
  {
    rowId: 'sandbox_permission.spawn',
    failureClass: FailureClass.SANDBOX_PERMISSION,
    lifecyclePhase: LifecyclePhase.SPAWN,
    nextAction: NextAction.QUARANTINE,
    description: 'Permission error during spawn — quarantine bead.'
  },
  {
    rowId: 'sandbox_permission.running',
    failureClass: FailureClass.SANDBOX_PERMISSION,
    lifecyclePhase: LifecyclePhase.RUNNING,
    nextAction: NextAction.TERMINAL_REJECT,
    description: 'File-access policy violation during run — permanently reject bead.'
  },
  {
    rowId: 'sandbox_permission.transition',
    failureClass: FailureClass.SANDBOX_PERMISSION,
    lifecyclePhase: LifecyclePhase.TRANSITION,
    nextAction: NextAction.TERMINAL_REJECT,
    description: 'Permission violation at transition — permanently reject bead.'
  },
  {
    rowId: 'sandbox_permission.shutdown',
    failureClass: FailureClass.SANDBOX_PERMISSION,
    lifecyclePhase: LifecyclePhase.SHUTDOWN,
    nextAction: NextAction.WARNING,
    description: 'Permission error during shutdown — emit warning, continue stopping.'
  },

  // ─── LIFECYCLE_VIOLATION ───────────────────────────────────────────────────
  // Out-of-order signal, duplicate event, state-mismatch — always TERMINAL_REJECT
  // (the model is confused or the system is inconsistent).
  // At startup it is fatal. At shutdown it is a warning.
  {
    rowId: 'lifecycle_violation.startup',
    failureClass: FailureClass.LIFECYCLE_VIOLATION,
    lifecyclePhase: LifecyclePhase.STARTUP,
    nextAction: NextAction.STARTUP_FAIL,
    description: 'Lifecycle invariant violated at startup — abort.'
  },
  {
    rowId: 'lifecycle_violation.spawn',
    failureClass: FailureClass.LIFECYCLE_VIOLATION,
    lifecyclePhase: LifecyclePhase.SPAWN,
    nextAction: NextAction.TERMINAL_REJECT,
    description: 'Lifecycle violation at spawn — permanently reject bead.'
  },
  {
    rowId: 'lifecycle_violation.running',
    failureClass: FailureClass.LIFECYCLE_VIOLATION,
    lifecyclePhase: LifecyclePhase.RUNNING,
    nextAction: NextAction.TERMINAL_REJECT,
    description: 'Lifecycle violation during run — permanently reject bead.'
  },
  {
    rowId: 'lifecycle_violation.transition',
    failureClass: FailureClass.LIFECYCLE_VIOLATION,
    lifecyclePhase: LifecyclePhase.TRANSITION,
    nextAction: NextAction.TERMINAL_REJECT,
    description: 'Lifecycle violation at transition — permanently reject bead.'
  },
  {
    rowId: 'lifecycle_violation.shutdown',
    failureClass: FailureClass.LIFECYCLE_VIOLATION,
    lifecyclePhase: LifecyclePhase.SHUTDOWN,
    nextAction: NextAction.WARNING,
    description: 'Lifecycle violation during shutdown — emit warning, continue stopping.'
  },

  // ─── OPERATOR_BLOCKER ──────────────────────────────────────────────────────
  // Explicit operator-placed block — always STATE_TRANSITION_BLOCK (or startup fail).
  // Operator authority is respected; bead waits for operator to resolve.
  {
    rowId: 'operator_blocker.startup',
    failureClass: FailureClass.OPERATOR_BLOCKER,
    lifecyclePhase: LifecyclePhase.STARTUP,
    nextAction: NextAction.STARTUP_FAIL,
    description: 'Operator blocker present at startup — abort until operator resolves.'
  },
  {
    rowId: 'operator_blocker.spawn',
    failureClass: FailureClass.OPERATOR_BLOCKER,
    lifecyclePhase: LifecyclePhase.SPAWN,
    nextAction: NextAction.QUARANTINE,
    description: 'Operator blocker detected at spawn — quarantine bead.'
  },
  {
    rowId: 'operator_blocker.running',
    failureClass: FailureClass.OPERATOR_BLOCKER,
    lifecyclePhase: LifecyclePhase.RUNNING,
    nextAction: NextAction.STATE_TRANSITION_BLOCK,
    description: 'Operator blocker (mailbox BLOCKER / STATE_BLOCKED) — block bead.'
  },
  {
    rowId: 'operator_blocker.transition',
    failureClass: FailureClass.OPERATOR_BLOCKER,
    lifecyclePhase: LifecyclePhase.TRANSITION,
    nextAction: NextAction.STATE_TRANSITION_BLOCK,
    description: 'Operator blocker at transition — hold bead in current state.'
  },
  {
    rowId: 'operator_blocker.shutdown',
    failureClass: FailureClass.OPERATOR_BLOCKER,
    lifecyclePhase: LifecyclePhase.SHUTDOWN,
    nextAction: NextAction.WARNING,
    description: 'Operator blocker during shutdown — emit warning, continue stopping.'
  },
]);

// ---------------------------------------------------------------------------
// Validation — validate all class and phase values at module load
// ---------------------------------------------------------------------------

const VALID_FAILURE_CLASSES = new Set<string>(ALL_FAILURE_CLASSES);
const VALID_LIFECYCLE_PHASES = new Set<string>(ALL_LIFECYCLE_PHASES);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Route a failure deterministically to exactly one next action.
 *
 * Resolution order:
 *   1. Find the most specific matching row in ROUTING_TABLE (class + phase + budget + authority).
 *   2. If none, find class + phase + budget match (any authority).
 *   3. If none, find class + phase match (any budget, any authority) → apply default budget rule.
 *   4. Apply fallback default: AVAILABLE→BOUNDED_RETRY, EXHAUSTED→SCHEDULING_PAUSE.
 *
 * Throws a descriptive Error if the class or phase is not in the taxonomy —
 * fail-fast on unknown values; no silent fallback to model inference.
 *
 * This function is PURE and SYNCHRONOUS.  It has no side effects and does not
 * call any external system.
 */
export function routeFailure(routingKey: RoutingKey): RoutingResult {
  const { failureClass, lifecyclePhase, retryBudget, authorityLevel } = routingKey;

  // Fail-fast on unknown class or phase — no silent fallback.
  if (!VALID_FAILURE_CLASSES.has(failureClass)) {
    throw new Error(
      `FailureTaxonomy: unknown failure class "${failureClass}". ` +
      `Valid classes: ${[...VALID_FAILURE_CLASSES].join(', ')}.`
    );
  }
  if (!VALID_LIFECYCLE_PHASES.has(lifecyclePhase)) {
    throw new Error(
      `FailureTaxonomy: unknown lifecycle phase "${lifecyclePhase}". ` +
      `Valid phases: ${[...VALID_LIFECYCLE_PHASES].join(', ')}.`
    );
  }

  // Pass 1: most specific — class + phase + budget + authority
  for (const row of ROUTING_TABLE) {
    if (
      row.failureClass === failureClass &&
      row.lifecyclePhase === lifecyclePhase &&
      row.retryBudget !== undefined && row.retryBudget === retryBudget &&
      row.authorityLevel !== undefined && row.authorityLevel === authorityLevel
    ) {
      return { rowId: row.rowId, nextAction: row.nextAction, description: row.description };
    }
  }

  // Pass 2: class + phase + budget (any authority)
  for (const row of ROUTING_TABLE) {
    if (
      row.failureClass === failureClass &&
      row.lifecyclePhase === lifecyclePhase &&
      row.retryBudget !== undefined && row.retryBudget === retryBudget &&
      row.authorityLevel === undefined
    ) {
      return { rowId: row.rowId, nextAction: row.nextAction, description: row.description };
    }
  }

  // Pass 3: class + phase (any budget, any authority) — apply default budget rule below
  for (const row of ROUTING_TABLE) {
    if (
      row.failureClass === failureClass &&
      row.lifecyclePhase === lifecyclePhase &&
      row.retryBudget === undefined &&
      row.authorityLevel === undefined
    ) {
      return { rowId: row.rowId, nextAction: row.nextAction, description: row.description };
    }
  }

  // Pass 4: fallback default (class + phase matched above but we need budget-sensitive default)
  // This path is only reached when the class+phase pair is covered by budget-specific rows
  // (e.g. running.available and running.exhausted) but the budget passed is neither AVAILABLE
  // nor EXHAUSTED — which should not happen with a well-typed caller.  Provide a safe fallback.
  const defaultAction = retryBudget === RetryBudget.EXHAUSTED
    ? NextAction.SCHEDULING_PAUSE
    : NextAction.BOUNDED_RETRY;
  const defaultRowId = `${failureClass}.${lifecyclePhase}.default`;
  return {
    rowId: defaultRowId,
    nextAction: defaultAction,
    description: `Default routing: ${failureClass} × ${lifecyclePhase} × ${retryBudget} → ${defaultAction}.`
  };
}

/**
 * Produce a compact descriptor for status and audit surfaces.
 * The descriptor is intentionally small — suitable for a single log field or
 * a compact JSON payload alongside the full routing result.
 */
export function compactDescriptor(result: RoutingResult): CompactDescriptor {
  return {
    cls: result.rowId.split('.')[0] ?? result.rowId,
    rowId: result.rowId,
    action: result.nextAction,
  };
}
