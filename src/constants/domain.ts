/**
 * Domain vocabulary for Orr Else.
 *
 * Enums, literal vocabularies, default statechart outcome names,
 * action/tool discriminator values, and shared contract constants.
 *
 * This module is a dependency leaf for domain modules — it must NOT import
 * from infrastructure, process, fs, logger singletons, or plugin-specific
 * defaults. Those live in src/constants/infra.ts beside their owning adapters.
 */

// ---------------------------------------------------------------------------
// Application identity
// ---------------------------------------------------------------------------

export const App = {
  NAME: 'orr-else',
  DISPLAY_NAME: 'Orr Else',
  SERVICE_NAME: 'orr-else',
  TRACER_NAME: 'orr-else.core',
  VERSION: '0.1.0',
  COORDINATOR_ID: 'coordinator',
  TURN_ACTION_ID: 'turn',
  UNKNOWN_MODEL: 'unknown'
} as const;

// ---------------------------------------------------------------------------
// Bead lifecycle / status vocabulary
// ---------------------------------------------------------------------------

/**
 * Global Bead Statuses
 */
export enum BeadStatus {
  READY = 'ready',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  BLOCKED = 'blocked',
  DEFERRED = 'deferred',
  FAILED = 'failed'
}

export enum BeadsIssueStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  CLOSED = 'closed',
  DONE = 'done',
  BLOCKED = 'blocked',
  DEFERRED = 'deferred'
}

export const TERMINAL_BEAD_STATUSES = new Set<string>([
  BeadStatus.COMPLETED,
  BeadStatus.FAILED,
  BeadStatus.BLOCKED,
  BeadStatus.DEFERRED,
  BeadsIssueStatus.CLOSED,
  BeadsIssueStatus.DONE
]);

/**
 * Coarse sink statuses that a statechart transition may legally target.
 *
 * When a transition target equals one of these values the bead leaves the
 * active statechart flow (it is not spawned as a worker) and is coerced to the
 * corresponding BeadStatus.  This is distinct from a defined state (which
 * spawns a worker) or a declared terminal state (which merges/closes the bead).
 *
 * Valid coarse-sink targets:
 *   'completed' — success terminal; bead is merged and closed.
 *   'blocked'   — bead is paused; coordinator emits STATE_BLOCKED and sets
 *                 BLOCKED coarse status via shouldPersistBlockedBeadStatus.
 *   'deferred'  — bead is shelved; similar routing to DEFERRED coarse status.
 */
export const RECOGNIZED_COARSE_SINK_STATUSES = new Set<string>([
  BeadStatus.COMPLETED,
  BeadStatus.BLOCKED,
  BeadStatus.DEFERRED
]);

// ---------------------------------------------------------------------------
// State machine events / outcomes
// ---------------------------------------------------------------------------

/**
 * Standard State Machine Events / Outcomes
 */
export enum EventName {
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
  BLOCKED = 'BLOCKED',
  RESTART = 'RESTART',
  HARNESS_RESTART = 'HARNESS_RESTART',
  CONTEXT_RESTART = 'CONTEXT_RESTART'
}

export enum RestartKind {
  HARNESS = 'harness',
  CONTEXT = 'context'
}

export enum MergeAndCommitStatus {
  STARTED = 'started',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed'
}

/**
 * Structured reason codes for quarantining a bead after a worktree-creation failure.
 * Quarantined beads are skipped on subsequent scans until their signature changes.
 */
export enum QuarantineReason {
  /** Branch ref is invalid (e.g. detached HEAD, bad ref syntax). */
  INVALID_BRANCH_REF = 'INVALID_BRANCH_REF',
  /** Branch is already checked out in another worktree. */
  ALREADY_CHECKED_OUT = 'ALREADY_CHECKED_OUT',
  /** Target worktree path already exists on disk. */
  WORKTREE_PATH_TAKEN = 'WORKTREE_PATH_TAKEN',
  /** Restart would respawn into the same non-routable terminal tool failure. */
  NON_ROUTABLE_TERMINAL_FAILURE_LIMIT = 'NON_ROUTABLE_TERMINAL_FAILURE_LIMIT',
  /**
   * pi-experiment-ek2j: v2 spawn invariant — isolated worktree is mandatory.
   * A v2 state was configured with provisionWorktree: false (no-worktree path)
   * but v2 forbids running at the project root. Fail-closed: the worker must
   * NOT run without an isolated worktree.
   */
  V2_ISOLATED_WORKTREE_REQUIRED = 'V2_ISOLATED_WORKTREE_REQUIRED',
  /** Worktree creation failed for an unclassified reason. */
  UNKNOWN = 'UNKNOWN'
}

/**
 * Reason codes for preserving a worktree instead of auto-removing it after merge.
 * Surfaced in WORKTREE_AUTO_REMOVE_PRESERVED domain events.
 */
export enum WorktreePreserveReason {
  /** The worktree has uncommitted or untracked changes. */
  DIRTY = 'DIRTY',
  /** A live teammate pane is still using this bead's worktree. */
  ACTIVE = 'ACTIVE',
  /** The bead branch has commits not yet merged into the target branch. */
  UNMERGED = 'UNMERGED',
  /** Liveness could not be determined; preserving conservatively. */
  UNKNOWN = 'UNKNOWN'
}

// ---------------------------------------------------------------------------
// Domain event names
// ---------------------------------------------------------------------------

export enum DomainEventName {
  AGENT_TURN_FAILED = 'AGENT_TURN_FAILED',
  ASSIGNMENT_FAILED = 'ASSIGNMENT_FAILED',
  BEADS_COMMAND_FAILED = 'BEADS_COMMAND_FAILED',
  BEADS_COMMAND_STARTED = 'BEADS_COMMAND_STARTED',
  BEADS_COMMAND_SUCCEEDED = 'BEADS_COMMAND_SUCCEEDED',
  BEAD_CLAIMED = 'BEAD_CLAIMED',
  BEAD_CLOSED = 'BEAD_CLOSED',
  BEAD_CREATED = 'BEAD_CREATED',
  BEAD_RELEASED = 'BEAD_RELEASED',
  BEAD_STATUS_UPDATED = 'BEAD_STATUS_UPDATED',
  BEAD_TOMBSTONED = 'BEAD_TOMBSTONED',
  ACTION_COMPLETED = 'ACTION_COMPLETED',
  CHECKLIST_ITEM_ADDED = 'CHECKLIST_ITEM_ADDED',
  CHECKLIST_ITEM_TICKED = 'CHECKLIST_ITEM_TICKED',
  CHECKPOINT_SUBMITTED = 'CHECKPOINT_SUBMITTED',
  CONTEXT_COMPACTION_RECORDED = 'CONTEXT_COMPACTION_RECORDED',
  CONTEXT_RESTART_REQUESTED = 'CONTEXT_RESTART_REQUESTED',
  FEATURE_LIST_UPDATED = 'FEATURE_LIST_UPDATED',
  GIT_LOCK_ACQUIRED = 'GIT_LOCK_ACQUIRED',
  GIT_INDEX_UNSTAGED = 'GIT_INDEX_UNSTAGED',
  GIT_LOCK_RELEASED = 'GIT_LOCK_RELEASED',
  HARNESS_STARTED = 'HARNESS_STARTED',
  HARNESS_API_BOUND = 'HARNESS_API_BOUND',
  HARNESS_STOPPED = 'HARNESS_STOPPED',
  HARNESS_RESTART_REQUESTED = 'HARNESS_RESTART_REQUESTED',
  HARNESS_CAPACITY_LIMIT_REACHED = 'HARNESS_CAPACITY_LIMIT_REACHED',
  HEARTBEAT_RECORDED = 'HEARTBEAT_RECORDED',
  MAILBOX_MESSAGE_DELETED = 'MAILBOX_MESSAGE_DELETED',
  MAILBOX_MESSAGE_SENT = 'MAILBOX_MESSAGE_SENT',
  MERGE_AND_COMMIT_FAILED = 'MERGE_AND_COMMIT_FAILED',
  MERGE_AND_COMMIT_STARTED = 'MERGE_AND_COMMIT_STARTED',
  MERGE_AND_COMMIT_SUCCEEDED = 'MERGE_AND_COMMIT_SUCCEEDED',
  PLUGIN_FILE_CREATED = 'PLUGIN_FILE_CREATED',
  PROGRESS_FILE_INITIALIZED = 'PROGRESS_FILE_INITIALIZED',
  PROGRESS_LOG_APPENDED = 'PROGRESS_LOG_APPENDED',
  PROJECT_TOOL_FAILED = 'PROJECT_TOOL_FAILED',
  PROJECT_TOOL_OUTPUT_DIR_PREPARED = 'PROJECT_TOOL_OUTPUT_DIR_PREPARED',
  PROJECT_TOOL_STARTED = 'PROJECT_TOOL_STARTED',
  PROJECT_TOOL_SUCCEEDED = 'PROJECT_TOOL_SUCCEEDED',
  SHIP_POST_REVIEW = 'SHIP_POST_REVIEW',
  SIGNAL_ACKNOWLEDGED = 'SIGNAL_ACKNOWLEDGED',
  SIGNAL_INTENT_RECORDED = 'SIGNAL_INTENT_RECORDED',
  PI_BASE_PROMPT_DRIFT = 'PI_BASE_PROMPT_DRIFT',
  STATE_TRANSITION_APPLIED = 'STATE_TRANSITION_APPLIED',
  STATE_RUN_INITIALIZED = 'STATE_RUN_INITIALIZED',
  STATE_PROMPT_ASSEMBLED = 'STATE_PROMPT_ASSEMBLED',
  TEAMMATE_EVENT = 'TEAMMATE_EVENT',
  TEAMMATE_SIGNAL_FAILED = 'TEAMMATE_SIGNAL_FAILED',
  TEAMMATE_DEAD_PANES_REMOVED = 'TEAMMATE_DEAD_PANES_REMOVED',
  TEAMMATE_CAPACITY_UNDERFILLED = 'TEAMMATE_CAPACITY_UNDERFILLED',
  TEAMMATE_PANE_SCAN_FAILED = 'TEAMMATE_PANE_SCAN_FAILED',
  TEAMMATE_PROCESS_EXITED = 'TEAMMATE_PROCESS_EXITED',
  TEAMMATE_SLOT_HEALTH_CHECKED = 'TEAMMATE_SLOT_HEALTH_CHECKED',
  TEAMMATE_SPAWNED = 'TEAMMATE_SPAWNED',
  TEAMMATE_SPAWN_FAILED = 'TEAMMATE_SPAWN_FAILED',
  TEAMMATE_SPAWN_REJECTED = 'TEAMMATE_SPAWN_REJECTED',
  TEAMMATE_SPAWN_STARTED = 'TEAMMATE_SPAWN_STARTED',
  TOKEN_USAGE_RECORDED = 'TOKEN_USAGE_RECORDED',
  /**
   * pi-experiment-6q0y.15: model-turn token/cost accounting. Distinct from
   * TOOL_PAYLOAD_ACCOUNTED — this records provider-reported usage for one
   * assistant turn (input/output/cache tokens + cost + duration).
   * Never carries prompt bodies or raw content.
   */
  MODEL_TURN_USAGE_RECORDED = 'MODEL_TURN_USAGE_RECORDED',
  /**
   * pi-experiment-6q0y.15: tool-payload byte/token accounting. Distinct from
   * MODEL_TURN_USAGE_RECORDED — this records the model-facing byte/token estimate
   * for a single tool invocation result payload.
   * Never carries raw tool output bodies or source files.
   */
  TOOL_PAYLOAD_ACCOUNTED = 'TOOL_PAYLOAD_ACCOUNTED',
  /**
   * pi-experiment-6q0y.9: cache-hit observability keyed by prompt digest.
   *
   * Emitted alongside TOKEN_USAGE_RECORDED when a turn reports non-zero
   * cache-read or cache-write token counts. Carries the stable prompt digest
   * (stableBlockDigestId) + cache/input token counts so cache-hit ratios are
   * computable per digest WITHOUT logging prompt bodies.
   *
   * cacheHitRatio = cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)
   *
   * stableBlockDigestId is absent when no digest has been recorded yet for the
   * current run (edge case: first turn before BEFORE_AGENT_START has fired).
   * Carries NO raw prompt body, tool body, or source content (AC3).
   */
  PROMPT_CACHE_OBSERVABILITY = 'PROMPT_CACHE_OBSERVABILITY',
  TOOL_INVOCATION_FAILED = 'TOOL_INVOCATION_FAILED',
  TOOL_INVOCATION_STARTED = 'TOOL_INVOCATION_STARTED',
  TOOL_INVOCATION_SUCCEEDED = 'TOOL_INVOCATION_SUCCEEDED',
  FILE_ACCESS_ATTEMPTED = 'FILE_ACCESS_ATTEMPTED',
  FILE_ACCESS_REJECTED = 'FILE_ACCESS_REJECTED',
  FILE_DELETE_CONVERTED_TO_TRASH = 'FILE_DELETE_CONVERTED_TO_TRASH',
  /** A write to a declared writable system artifact was permitted outside the
   * plan write set (path-class systemArtifact). Audit trail for g9ye. */
  SYSTEM_ARTIFACT_WRITE_PERMITTED = 'SYSTEM_ARTIFACT_WRITE_PERMITTED',
  FILE_MUTATION_REJECTED = 'FILE_MUTATION_REJECTED',
  TRANSACTIONAL_STATE_AUTO_RESTORE_FAILED = 'TRANSACTIONAL_STATE_AUTO_RESTORE_FAILED',
  TRANSACTIONAL_STATE_AUTO_RESTORE_STARTED = 'TRANSACTIONAL_STATE_AUTO_RESTORE_STARTED',
  TRANSACTIONAL_STATE_AUTO_RESTORE_SUCCEEDED = 'TRANSACTIONAL_STATE_AUTO_RESTORE_SUCCEEDED',
  TRANSACTIONAL_STATE_REJECTED = 'TRANSACTIONAL_STATE_REJECTED',
  WORKTREE_CREATE_FAILED = 'WORKTREE_CREATE_FAILED',
  WORKTREE_CREATED = 'WORKTREE_CREATED',
  WORKTREE_EXCLUDES_CONFIGURED = 'WORKTREE_EXCLUDES_CONFIGURED',
  WORKTREE_PROVISIONED = 'WORKTREE_PROVISIONED',
  WORKTREE_REUSED = 'WORKTREE_REUSED',
  WORKTREE_REMOVE_FAILED = 'WORKTREE_REMOVE_FAILED',
  WORKTREE_REMOVE_SKIPPED = 'WORKTREE_REMOVE_SKIPPED',
  WORKTREE_REMOVED = 'WORKTREE_REMOVED',
  WORKTREE_AUTO_REMOVED = 'WORKTREE_AUTO_REMOVED',
  WORKTREE_AUTO_REMOVE_PRESERVED = 'WORKTREE_AUTO_REMOVE_PRESERVED',
  BEAD_QUARANTINED = 'BEAD_QUARANTINED',
  BEAD_QUARANTINE_REHYDRATED = 'BEAD_QUARANTINE_REHYDRATED',
  BEAD_QUARANTINE_CLEARED = 'BEAD_QUARANTINE_CLEARED',
  WORKLOG_ENTRY_APPENDED = 'WORKLOG_ENTRY_APPENDED',
  RETENTION_CLEANUP_COMPLETED = 'RETENTION_CLEANUP_COMPLETED',
  RETENTION_DISK_HEALTH = 'RETENTION_DISK_HEALTH',
  DIST_ARTIFACT_STALE = 'DIST_ARTIFACT_STALE',
  PATH_CONTEXT_RESOLVED = 'PATH_CONTEXT_RESOLVED',
  /**
   * Recorded once per COORDINATOR-side verifier gate run (0yt5.20 AC6). Carries
   * { beadId, stateId, actionId, perTool: [{tool, verdict, reasons, durationMs,
   * timedOut?, threw?}], blocked }. Diagnostic only — the gate verdict is the
   * binding authority; this event explains WHY a transition was blocked/advanced.
   */
  VERIFY_EVALUATED = 'VERIFY_EVALUATED',
  PRE_SIGNAL_AUDIT_PERFORMED = 'PRE_SIGNAL_AUDIT_PERFORMED',
  SIGNAL_INTENT_RECONCILED = 'SIGNAL_INTENT_RECONCILED',
  /**
   * Recorded ONCE when the MCP bridge module (or a specific server transport)
   * fails its coordinator-side preflight probe. Subsequent spawn-loop iterations
   * that hit the same failure do NOT record a new event — they reuse the cached
   * health status so failures are collapsed rather than per-worker-rediscovered.
   */
  MCP_TRANSPORT_PREFLIGHT_FAILED = 'MCP_TRANSPORT_PREFLIGHT_FAILED',
  /**
   * Emitted when a heartbeat-only live gap (a beadId present in heartbeat
   * snapshots but absent from the live pane/tracked set) persists for N
   * consecutive health checks or longer than the configured TTL.  Signals
   * that the heartbeating worker is orphaned and the harness is taking action
   * (suppressing + releasing the stale entry) to prevent indefinite noise.
   */
  HEARTBEAT_ONLY_GAP_ORPHANED = 'HEARTBEAT_ONLY_GAP_ORPHANED',
  /**
   * Recorded once per teammate spawn to capture context-instance identity
   * (pi-experiment-6q0y.44 AC6): mode, beadId, stateId, promptDigest, active
   * tools, skill profile, and whether this is a resumption of a prior session.
   * Enables replay reconstruction without raw conversation history.
   */
  CONTEXT_INSTANCE_RECORDED = 'CONTEXT_INSTANCE_RECORDED',
  /**
   * Recorded when a namedContinuation spawn is DENIED by the admission gate
   * (pi-experiment-6q0y.44 AC7).  Carries reason + bead/state/contextKey.
   * The spawn falls back to freshSubagent when admission fails.
   */
  CONTEXT_CONTINUATION_DENIED = 'CONTEXT_CONTINUATION_DENIED',
  /**
   * Emitted once at coordinator startup after config is loaded (pi-experiment-6q0y.44 AC5).
   * Carries the deterministic SHA-256 fingerprint of the resolved context-policy table
   * (all states' modes, contextKeys, producesContextKeys, active tools, skill profiles).
   * Enables drift detection: a fingerprint change between runs indicates a policy change.
   */
  CONTEXT_POLICY_FINGERPRINT_RECORDED = 'CONTEXT_POLICY_FINGERPRINT_RECORDED',
  /**
   * Emitted exactly ONCE when the supervisor enters a capacity-pause mode
   * (scheduling suspended until pauseUntil).  Carries: { reason, pauseUntil }.
   * Subsequent polls within the same pause window emit no additional events —
   * the coordinator instead emits a low-frequency SCHEDULING_PAUSE_HEARTBEAT
   * at most once per PAUSE_HEARTBEAT_INTERVAL_MS to confirm the pause is still
   * active.  A new SCHEDULING_PAUSED event fires if pauseUntil is extended.
   */
  SCHEDULING_PAUSED = 'SCHEDULING_PAUSED',
  /**
   * Emitted at most once per PAUSE_HEARTBEAT_INTERVAL_MS while scheduling
   * remains paused. Carries: { reason, pauseUntil }.  Bounds operator-visible
   * log volume during long capacity pauses.
   */
  SCHEDULING_PAUSE_HEARTBEAT = 'SCHEDULING_PAUSE_HEARTBEAT',
  /**
   * Emitted once per readiness-probe invocation (pi-experiment-8ieq).
   *
   * Carries: { tool, configPath, probeStatus, elapsedMs, gateDec,
   *   bytes?, sha256?, semanticArtifactPath? }.
   *
   * probeStatus — 'PASSED' | 'REJECTED' | 'UNSAFE' | 'TIMEOUT' | 'OVERSIZE'
   * gateDec     — 'ADMIT' | 'DENY'  (startup admission outcome for this probe)
   *
   * NO raw output bodies are logged — only byte count and sha256 digest.
   * elapsedMs is provided by the injected Clock (deterministic in tests).
   */
  PROJECT_TOOL_PROBE_COMPLETED = 'PROJECT_TOOL_PROBE_COMPLETED',

  /**
   * Emitted once per harness retry-pipeline decision (pi-experiment-t6gw).
   *
   * Carries: { tool, invocationId, attempt, idempotencyClass, failureCategory,
   *   configuredLimit, decision, nextRoute }.
   *
   * decision   — 'RETRY' | 'SUPPRESS' | 'EXHAUSTED' | 'REJECT_NO_IDEMPOTENCY_CLASS'
   * nextRoute  — 'retry' | 'fail' (what happens next after this decision)
   *
   * All fields are required — partial emits are rejected by EventStore.record.
   * Deterministic: no Date.now() or Math.random() in the decision logic.
   */
  TOOL_RETRY_DECISION = 'TOOL_RETRY_DECISION',

  /**
   * Emitted when a prompt-budget admission check runs (pi-experiment-6q0y.17).
   *
   * Carries: { beadId?, stateId?, actionId?, configPath,
   *   stableBlockBytes, stableBlockTokens, stableBlockHash,
   *   piBasePromptBytes, piBasePromptTokens, piBasePromptHash,
   *   volatileSuffixBytes, volatileSuffixTokens, volatileSuffixHash,
   *   finalPromptBytes, finalPromptTokens, finalPromptHash,
   *   limitBytes?, limitTokens?, limitScope, exceeded, route? }.
   *
   * Only emitted when a budget policy is configured AND the limit is exceeded
   * (AC4). With no budget configured this event is NEVER emitted (true no-op).
   *
   * NO prompt body is ever included — only hashes, byte counts, token estimates,
   * config path, state/action identity, and route (AC5).
   */
  PROMPT_BUDGET_ADMISSION = 'PROMPT_BUDGET_ADMISSION',

  /**
   * Emitted when a configured tool-payload budget is exceeded and the harness
   * rejects the model-facing result BEFORE it reaches the model
   * (pi-experiment-6q0y.18 AC5 / AC6).
   *
   * Carries: { tool, beadId?, stateId?, actionId?, toolInvocationId?,
   *   actualBytes, limitBytes, outputFile?, decision, route }.
   *
   * Only emitted when a budget is configured AND the payload exceeds the limit.
   * With no budget configured this event is NEVER emitted (true no-op, AC2).
   *
   * NO raw tool-output body is ever included — only tool name, identity fields,
   * exact byte count, limit, artifact references, and the route (AC6).
   */
  TOOL_PAYLOAD_BUDGET_REJECTED = 'TOOL_PAYLOAD_BUDGET_REJECTED',

  /**
   * Emitted when a configured runtime budget is exceeded and the harness fails
   * BEFORE the next model/provider/tool spend (pi-experiment-6q0y.48 AC5).
   *
   * Carries: { budgetId, dimension, currentValue, limit,
   *   beadId?, stateId?, actionId?, nextRoute }.
   *
   * Only emitted when a runtime budget is configured AND a limit is exceeded.
   * With no runtime budget configured this event is NEVER emitted (true no-op, AC1).
   *
   * NO prompt body or raw tool output is ever included — only structured identity
   * fields, dimension name, numeric values, and the route (AC5).
   *
   * budgetId   — stable identifier: 'settings' | 'state:<id>' | 'action:<state>/<action>'.
   * dimension  — which limit was exceeded (e.g. 'modelCallCount', 'wallClockMs').
   * currentValue — accumulated value at the time the limit was exceeded.
   * limit      — the configured limit for that dimension.
   * nextRoute  — the configured route that will drive the deterministic outcome.
   */
  RUNTIME_BUDGET_EXCEEDED = 'RUNTIME_BUDGET_EXCEEDED',

  /**
   * Emitted when a terminal or advance route event is rejected because required
   * artifact evidence (declared in state.routeEvidence) is missing or
   * schema-invalid (pi-experiment-6q0y.46 AC3).
   *
   * Carries: { beadId, stateId, actionId, routeEvent, missingIds,
   *   remediationHint }.
   *
   * NO raw prompt or tool-output bodies — only identity fields, the missing
   * artifact/verifier IDs, and a deterministic remediation hint (AC3).
   * Deterministic: no Date.now() or Math.random() in the decision or event.
   *
   * beadId         — the bead attempting the transition.
   * stateId        — the state the bead was completing from.
   * actionId       — the action that completed (may be empty string).
   * routeEvent     — the attempted route/transition event name (e.g. 'SUCCESS').
   * missingIds     — array of tool/artifact names that are absent or FAIL.
   * remediationHint — deterministic guidance: which tools to invoke / artifacts to produce.
   */
  ROUTE_ADMISSION_REJECTED = 'ROUTE_ADMISSION_REJECTED',

  /**
   * Emitted when a CONTEXT_RESTART_REQUESTED or HARNESS_RESTART_REQUESTED signal
   * is rejected by the evidence-aware handoff validation gate (pi-experiment-6q0y.36 AC1/AC3).
   *
   * Carries: { beadId, stateId, actionId?, transitionEvent, idempotencyKey,
   *   rejections (array of {reason, diagnostic}), diagnostic (combined string) }.
   *
   * reason categories: SUMMARY_ONLY | BAD_HASH | UNREGISTERED_SCHEMA |
   *   STALE_EVENT_IDS | INACCESSIBLE_PATH.
   *
   * DIAGNOSTIC ONLY — no state mutation. The restart signal is NOT recorded and
   * the bead lease is released. The worker is signaled to ack + exit.
   * replayImpact: INFORMATIONAL (no state change).
   */
  RESTART_HANDOFF_REJECTED = 'RESTART_HANDOFF_REJECTED',

  /**
   * Emitted when a loop fingerprint counter reaches the configured maxLoops
   * threshold (pi-experiment-6q0y.49 AC5).
   *
   * Carries: { scope, fingerprint, count, max, routeEvent,
   *   beadId?, stateId?, actionId? }.
   *
   * scope      — LoopScope: toolCall | toolCallSemantic | failedRoute |
   *              verifierFail | blocker.
   * fingerprint — deterministic SHA-256 prefix of the normalized loop key
   *              (no raw prompt/tool bodies — AC1).
   * count      — current counter value at exceed time.
   * max        — configured maxLoops for this scope.
   * routeEvent — the route event that will be emitted to route the bead.
   *
   * Replay-critical: used by LoopDetector.rebuildFromEvents() to reconstruct
   * counter state after harness/context restart (AC7).
   */
  LOOP_DETECTED = 'LOOP_DETECTED',

  /**
   * Emitted at most ONCE per fingerprint when the counter reaches maxLoops-1
   * (one before the hard limit) — the single warning diagnostic allowed by
   * AC6. Carries the same fields as LOOP_DETECTED.
   *
   * A LOOP_WARNING_DIAGNOSTIC event means: "the harness noticed this pattern
   * is recurring; if it recurs once more, a route event will fire."
   *
   * Replay-critical (same as LOOP_DETECTED): LoopDetector.rebuildFromEvents()
   * reads these to re-mark warnedFingerprints on restart (AC7).
   */
  LOOP_WARNING_DIAGNOSTIC = 'LOOP_WARNING_DIAGNOSTIC',

  /**
   * pi-experiment-6k8e: v2 first-class route-event contract.
   *
   * Emitted ONLY by configured deterministic emitters (tools, verifiers, gates,
   * system preconditions) when they produce a v2 route decision. Model-authored
   * fields (outcome/transitionEvent/nextPhase/route labels in prose), tool
   * stdout/stderr, and untrusted tool arguments MUST NEVER produce this event.
   *
   * Carries: { schemaId, schemaVersion, configVersion, configFingerprint,
   *   beadId, stateId, actionId, runId, emitterType, emitterId,
   *   eventName, category, evidenceRefs }.
   *
   * evidenceRefs: each ref includes { semanticPath, byteCount, sha256,
   *   schemaId?, schemaVersion? }.  A ref missing byteCount or sha256 is
   *   rejected by schema validation BEFORE any projection can consume it.
   *
   * Replay-critical: v2 BeadStateProjection consumes ONLY these events (plus
   * the admitted transition table) to produce STATE_TRANSITION_APPLIED v2
   * records that reference the route-event ID.
   *
   * version-gated: only emitted for configs with version === 2. v1 configs
   * are completely unaffected.
   */
  ROUTE_EVENT_EMITTED = 'ROUTE_EVENT_EMITTED',

  /**
   * pi-experiment-x0zh: v2 model-supplied route authority rejection diagnostic.
   *
   * Emitted (at most once per attempt) when a worker/model supplies a route
   * field on any surface in a v2 config and the coordinator rejects it before
   * projection.  Carries enough context for operators to identify the attempted
   * surface (signal_completion/submit_checkpoint/typed signal/state event/
   * failure-limit/review-artifact) and the rejected route label.
   *
   * NO workflow state transition or bead status mutation may result from these
   * rejected attempts — this event is DIAGNOSTIC ONLY.
   *
   * Carries: { beadId, stateId, actionId, surface, rejectedRoute, reason }.
   *
   * version-gated: only emitted for configs with version === 2.
   */
  V2_MODEL_ROUTE_REJECTED = 'V2_MODEL_ROUTE_REJECTED',

  /**
   * pi-experiment-e8cm: v2 replay quarantine diagnostic.
   *
   * Emitted during replay/projection when a ROUTE_EVENT_EMITTED record is
   * rejected for one of four deterministic reasons:
   *   UNDECLARED_EVENT         — eventName is not in the declared v2 vocabulary.
   *   SCHEMA_INVALID           — the record is missing required fields or has
   *                              an invalid emitterType (anti-prose guard).
   *   DUPLICATE_IDEMPOTENCY    — a route event with this routeEventId has
   *                              already been applied in the current projection.
   *   STALE_CONFIG_FINGERPRINT — the record's configFingerprint does not match
   *                              the expected fingerprint for this projection run.
   *
   * Projection CONTINUES from the last valid workflow state after quarantine.
   * The invalid event CANNOT advance, fail, block, or terminate progress.
   *
   * Carries: { routeEventId, schemaId, schemaVersion, configFingerprint,
   *   reason, lastValidState, eventName?, beadId? }.
   *
   * NO raw event bodies — only identity fields + quarantine reason + last-valid-state.
   * DETERMINISTIC: no Date.now() or Math.random() in quarantine logic.
   * DIAGNOSTIC ONLY — replayImpact: INFORMATIONAL.
   *
   * version-gated: only produced during v2 config replay.
   */
  V2_ROUTE_EVENT_QUARANTINED = 'V2_ROUTE_EVENT_QUARANTINED',

  /**
   * pi-experiment-ek2j: v2 runtime substrate preflight failure.
   *
   * Emitted ONCE at v2 coordinator startup when the tmux or git worktree
   * substrate check fails. Startup aborts immediately after this event —
   * no SignalingServer, Supervisor, or worker spawn may occur.
   *
   * Carries: { substrate, projectRoot, command?, sanitizedStderr?, diagnostic }.
   *
   * substrate    — 'tmux' | 'git-worktree'
   * projectRoot  — the project root under which the worktree probe ran
   * command      — the failed command string (tmux/git), if applicable
   * sanitizedStderr — redacted stderr (no secrets; max 500 chars), if captured
   * diagnostic   — human-readable deterministic failure description
   *
   * DETERMINISTIC: no Date.now() or Math.random() in the check or event.
   * VERSION-GATED: only emitted for configs with version === 2. v1 configs
   * and cerdiwen are completely unaffected.
   */
  V2_SUBSTRATE_PREFLIGHT_FAILED = 'V2_SUBSTRATE_PREFLIGHT_FAILED',

  /**
   * pi-experiment-6q0y.35: Replay-critical pointer event for the deterministic
   * context compaction summary artifact.
   *
   * Emitted ONLY when a state has compactionSummary.enabled:true configured.
   * DEFAULT DISABLED — absent when no compaction config is declared (AC1/AC2 no-op).
   *
   * Carries: { beadId, stateId, artifactPath, artifactBytes, artifactSha256,
   *   sourceEventIds, nonAuthoritative }.
   *
   * nonAuthoritative: ALWAYS true. The summary artifact is a digest only —
   *   it NEVER satisfies any artifact-first or route gate (AC7).
   *   A gate CANNOT use COMPACTION_SUMMARY_RECORDED as evidence.
   *
   * sourceEventIds: the event IDs of schema-valid events the summary was derived from.
   * artifactPath/artifactBytes/artifactSha256: stable refs to the written artifact.
   *
   * DETERMINISTIC: no Date.now() or Math.random() in summary generation.
   * REPLAY-CRITICAL: listed in REPLAY_CRITICAL_EVENT_TYPES so the pointer
   *   survives compaction and history reconstruction can locate the artifact.
   */
  COMPACTION_SUMMARY_RECORDED = 'COMPACTION_SUMMARY_RECORDED',

  /**
   * pi-experiment-6q0y.37: Compaction warning event — first warning threshold reached.
   *
   * Emitted ONLY when a state has compactionFallback.enabled:true AND
   * compactionCount reaches the configured warnThreshold. NO restart request is
   * posted at this point (AC2 — warning only, no restart).
   *
   * DEFAULT DISABLED — absent when no compactionFallback config is declared (AC1/AC6 no-op).
   *
   * Carries: { beadId, stateId, compactionCount, warnThreshold }.
   *
   * DETERMINISTIC: no Date.now() or Math.random() in the decision.
   * replayImpact: INFORMATIONAL — diagnostic only, no state mutation.
   */
  CONTEXT_COMPACTION_WARNING = 'CONTEXT_COMPACTION_WARNING',
}

// ---------------------------------------------------------------------------
// Beads CLI vocabulary
// ---------------------------------------------------------------------------

export enum BeadsCliCommand {
  CLOSE = 'close',
  CREATE = 'create',
  IMPORT = 'import',
  UPDATE = 'update'
}

export const MUTATING_BEADS_COMMANDS = new Set<string>([
  BeadsCliCommand.CLOSE,
  BeadsCliCommand.CREATE,
  BeadsCliCommand.IMPORT,
  BeadsCliCommand.UPDATE
]);

// ---------------------------------------------------------------------------
// Tool result / evidence vocabulary
// ---------------------------------------------------------------------------

export enum ToolResultStatus {
  PASSED = 'PASSED',
  REJECTED = 'REJECTED',
  UNAVAILABLE = 'UNAVAILABLE'
}

export enum ToolValidationCondition {
  CALLED = 'called',
  PASSED = 'passed',
  SUCCEEDED = 'succeeded'
}

export enum ToolEvidenceSource {
  EVENT_STORE_COMPLETED_ACTION = 'event-store-completed-action'
}

// ---------------------------------------------------------------------------
// Extension / CLI vocabulary
// ---------------------------------------------------------------------------

export enum ExtensionCommandAction {
  STATUS = 'status',
  STOP = 'stop'
}

export enum CliOption {
  CONFIG = '--config',
  BEAD = '--bead',
  MAX_SLOTS = '--max-slots'
}

export const PiCliCommand = {
  PI: 'pi'
} as const;

// ---------------------------------------------------------------------------
// HTTP vocabulary (shared contract)
// ---------------------------------------------------------------------------

export enum HttpMethod {
  GET = 'GET',
  POST = 'POST'
}

export enum ApiPath {
  EVENTS = '/events',
  HEARTBEAT = '/heartbeat',
  HEARTBEATS = '/heartbeats',
  SIGNAL = '/signal',
  SIGNALS = '/signals'
}

// ---------------------------------------------------------------------------
// Teammate / signal event vocabulary
// ---------------------------------------------------------------------------

/**
 * Immutable generic framework lifecycle event taxonomy.
 *
 * These values form the GENERIC CORE contract for teammate signals — they map
 * to well-known framework semantics and are processed by the coordinator
 * without any configuration.  Do NOT add domain-specific event names here;
 * use `statechart.customEvents` in harness.yaml instead.
 *
 * Categories:
 *   Worker lifecycle  — TEAMMATE_STARTED, TEAMMATE_EXITED
 *   State entry/exit  — STATE_STARTED
 *   Checkpoint        — CHECKPOINT_ACCEPTED
 *   Transition        — STATE_TRANSITIONED
 *   Terminal failed   — STATE_FAILED
 *   Terminal blocked  — STATE_BLOCKED
 *   Restart signals   — CONTEXT_RESTART_REQUESTED, HARNESS_RESTART_REQUESTED
 *   Heartbeat         — HEARTBEAT
 */
export enum TeammateEventType {
  TEAMMATE_STARTED = 'TEAMMATE_STARTED',
  STATE_STARTED = 'STATE_STARTED',
  CHECKPOINT_ACCEPTED = 'CHECKPOINT_ACCEPTED',
  STATE_TRANSITIONED = 'STATE_TRANSITIONED',
  STATE_FAILED = 'STATE_FAILED',
  STATE_BLOCKED = 'STATE_BLOCKED',
  CONTEXT_RESTART_REQUESTED = 'CONTEXT_RESTART_REQUESTED',
  HARNESS_RESTART_REQUESTED = 'HARNESS_RESTART_REQUESTED',
  HEARTBEAT = 'HEARTBEAT',
  TEAMMATE_EXITED = 'TEAMMATE_EXITED',
  /**
   * pi-experiment-x0zh: v2 evidence-submitted signal.
   *
   * Posted by submit_action_evidence (worker side) in v2 configs after recording
   * evidence. Triggers the coordinator's deterministic gate (evaluateCoordinatorGate)
   * + emits mapping + route event + STATE_TRANSITION_APPLIED — no model-supplied
   * route authority. Only meaningful in v2 configs; ignored (no-op) in v1.
   */
  ACTION_EVIDENCE_SUBMITTED = 'ACTION_EVIDENCE_SUBMITTED'
}

export enum TeammateEventDecisionAction {
  ACCEPT = 'accept',
  IGNORE = 'ignore',
  DUPLICATE = 'duplicate',
  /** Signal's stateId does not match the current bead state — it arrived out of order or is stale. */
  OUT_OF_ORDER = 'out_of_order'
}

// ---------------------------------------------------------------------------
// Action / checklist vocabulary
// ---------------------------------------------------------------------------

/**
 * Teammate Action Types
 */
export enum ActionType {
  PROMPT = 'prompt',
  CHECKLIST = 'checklist',
  TOOL = 'tool',
  SCRIPT = 'script'
}

export enum ActionContextMode {
  SAME = 'same',
  ONE_SHOT = 'oneShot',
  SUBAGENT = 'subagent'
}

export enum ActionRunContext {
  PARENT = 'parent',
  FRESH = 'fresh'
}

/**
 * State-level context policy (pi-experiment-6q0y.44).
 *
 * Declares how a state's worker context is handled at spawn time:
 *
 *   freshSubagent      — spawn a new isolated sub-agent context for this state
 *                        (default; matches historical --no-session behaviour).
 *   namedContinuation  — continue a named prior-state context identified by
 *                        contextKey; the coordinator resolves the continuation
 *                        key and passes it to the spawn so the worker can
 *                        resume from a stable context anchor rather than
 *                        starting from scratch.
 *
 * The default when a state omits contextPolicy is freshSubagent.
 * Cerdiwen states that do not declare contextPolicy are unaffected.
 */
export enum StateContextPolicy {
  FRESH_SUBAGENT = 'freshSubagent',
  NAMED_CONTINUATION = 'namedContinuation'
}

export enum ChecklistItemType {
  MANUAL = 'manual',
  TOOL = 'tool',
  SCRIPT = 'script'
}

export const ChecklistPromptSuffix = {
  MANDATORY: '(MANDATORY)',
  OPTIONAL: '(OPTIONAL)',
  TOOL: '(HARNESS TOOL CHECK)',
  SCRIPT: '(HARNESS SCRIPT CHECK)'
} as const;

export const CHECKLIST_PROMPT_SUFFIXES = Object.values(ChecklistPromptSuffix);

// ---------------------------------------------------------------------------
// Project tool type / root vocabulary
// ---------------------------------------------------------------------------

/**
 * Project Tool Types
 */
export enum ProjectToolType {
  COMMAND = 'command',
  EXTENSION = 'extension',
  MCP = 'mcp'
}

/**
 * pi-experiment-amq0.19: Single typed source for project-tool root kind vocabulary.
 *
 * Built-in root kinds understood by the harness path-normalization pipeline.
 * Named roots (from settings.roots) are also valid at runtime and are validated
 * at startup by ConfigValidator.validateNamedRoots.
 *
 * This is the SINGLE SOURCE OF TRUTH — all consumers import from here.
 * Do NOT re-declare this in plugin constants or domain models.
 */
export const ProjectToolRootKind = {
  WORKTREE: 'worktree',
  PROJECT: 'project',
  FRAMEWORK: 'framework',
  WORKSPACE: 'workspace'
} as const;

/** Union of the built-in root kind string literals. */
export type ProjectToolBuiltinRootKind = typeof ProjectToolRootKind[keyof typeof ProjectToolRootKind];

/**
 * CWD Modes for Project Tools
 */
export enum CwdMode {
  PROJECT = 'project',
  WORKTREE = 'worktree'
}

// ---------------------------------------------------------------------------
// LLM / model / provider vocabulary
// ---------------------------------------------------------------------------

/**
 * LLM Thinking Levels
 */
export enum ThinkingLevel {
  OFF = 'off',
  MINIMAL = 'minimal',
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  XHIGH = 'xhigh'
}

export enum ModelProviderKey {
  CLAUDE = 'claude',
  OPENAI = 'openai'
}

export enum LLMProviderName {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  OPENAI_CODEX = 'openai-codex'
}

/**
 * Substring tokens that, when present in a configured provider string, route
 * the teammate to a Pi subscription (OAuth) provider instead of an API-key
 * provider. Matching is case-insensitive. `claude` -> the Anthropic
 * (Claude Pro/Max) OAuth provider; `codex` -> the ChatGPT (Codex) OAuth
 * provider.
 */
export enum SubscriptionProviderToken {
  CLAUDE = 'claude',
  CODEX = 'codex'
}

// ---------------------------------------------------------------------------
// Built-in tool names
// ---------------------------------------------------------------------------

/**
 * Core Framework Control Plane Tools.
 * These are the ONLY tools that are hardcoded into the Orr Else protocol.
 * All other tools are plugins or project-specific configurations.
 */
export enum BuiltInToolName {
  ORR_ELSE = 'orr-else',
  TICK_ITEMS = 'tick_items',
  GET_OUTSTANDING_TASKS = 'get_outstanding_tasks',
  ADD_CHECKLIST_ITEM = 'add_checklist_item',
  SUBMIT_CHECKPOINT = 'submit_checkpoint',
  SUBMIT_REVIEW_ARTIFACT = 'submit_review_artifact',
  SIGNAL_COMPLETION = 'signal_completion',
  REQUEST_CONTEXT_RESTART = 'request_context_restart',
  REQUEST_HARNESS_RESTART = 'request_harness_restart',
  GET_ARTIFACT_PATHS = 'get_artifact_paths',
  QUERY_ARTIFACT = 'query_artifact',
  READ_PATH_CONTEXT = 'read_path_context',
  HARNESS_STATUS = 'harness_status',
  PRE_SIGNAL_AUDIT = 'pre_signal_audit',
  QUERY_HARNESS_EVENTS = 'query_harness_events',
  QUERY_TOOL_OUTPUT = 'query_tool_output',
  /**
   * pi-experiment-x0zh: v2 evidence-only completion surface.
   *
   * Workers in v2 configs submit artifact/evidence references with no
   * outcome/route field.  No workflow state transition results from this
   * call alone — transition requires a schema-valid deterministic route
   * event (ROUTE_EVENT_EMITTED) from a configured emitter.
   */
  SUBMIT_ACTION_EVIDENCE = 'submit_action_evidence'
}

// ---------------------------------------------------------------------------
// Review artifact vocabulary
// ---------------------------------------------------------------------------

export enum ReviewArtifactKind {
  SHIP_POST_REVIEW = 'shipPostReview'
}

export enum ReviewArtifactStore {
  EVENT_STORE = 'eventStore'
}

// ---------------------------------------------------------------------------
// Plugin tool names
// ---------------------------------------------------------------------------

/**
 * System Plugin Tool Names (Internal Plugins)
 * These are standard plugins provided by Orr Else but are NOT core protocol tools.
 */
export enum PluginToolName {
  BD_HEARTBEAT = 'bd_heartbeat',
  BD_READY = 'bd_ready',
  BD_LIST = 'bd_list',
  BD_EXPORT_JSONL = 'bd_export_jsonl',
  BD_IMPORT_JSONL = 'bd_import_jsonl',
  BD_CREATE = 'bd_create',
  BD_GET_BEAD = 'bd_get_bead',
  BD_GET_STATE_CHART = 'bd_get_state_chart',
  BD_CLAIM = 'bd_claim',
  BD_RELEASE = 'bd_release',
  BD_UPDATE_STATUS = 'bd_update_status',
  BD_GET_HEARTBEATS = 'bd_get_heartbeats',
  CREATE_WORKTREE = 'create_worktree',
  REMOVE_WORKTREE = 'remove_worktree',
  MERGE_AND_COMMIT = 'merge_and_commit',
  SEND_MAILBOX_MESSAGE = 'send_mailbox_message',
  CHECK_MAILBOX = 'check_mailbox',
  FETCH_MAILBOX_MESSAGE = 'fetch_mailbox_message',
  COMPRESS_SESSION_LOGS = 'compress_session_logs',
  SPAWN_TEAMMATE = 'spawn_teammate',
  CREATE_NEW_PLUGIN = 'create_new_plugin'
}

// ---------------------------------------------------------------------------
// Mailbox / feature vocabulary
// ---------------------------------------------------------------------------

export enum MailboxMessageType {
  REQUEST = 'REQUEST',
  INFO = 'INFO',
  BLOCKER = 'BLOCKER',
  STEER = 'STEER'
}

export enum FeatureStatus {
  TODO = 'todo',
  IN_PROGRESS = 'in-progress',
  COMPLETED = 'completed',
  FAILED = 'failed'
}

// ---------------------------------------------------------------------------
// Action completion key (shared contract)
// ---------------------------------------------------------------------------

export const ActionCompletionKey = {
  FIELD_SEPARATOR: '/',
  WORKFLOW_PREFIX: 'workflow',
  STATE_PREFIX: 'state',
  ACTION_PREFIX: 'action'
} as const;

// ---------------------------------------------------------------------------
// Prompt provenance kind
// ---------------------------------------------------------------------------

/**
 * Kinds of prompt/config files tracked in run provenance.
 * Each entry in a PromptProvenanceRecord corresponds to one of these kinds.
 */
export enum PromptProvenanceKind {
  GOAL_PROMPT = 'goalPrompt',
  STATE_PROMPT = 'statePrompt',
  SKILL_PROMPT = 'skillPrompt',
  HARNESS_CONFIG = 'harnessConfig'
}

// ---------------------------------------------------------------------------
// Replay critical event types
// ---------------------------------------------------------------------------

/**
 * REPLAY_CRITICAL_EVENT_TYPES — the complete set of DomainEventNames that MUST
 * never be compacted away from the primary event JSONL.
 *
 * There are three consumers that require completeness:
 *
 *  1. BeadStateProjection.projectBeadStateChartFromEvents /
 *     BeadStateProjection.projectBeadFromEvents — read via eventsForBead() and
 *     switch on event type to rebuild per-bead projected state.
 *
 *  2. Supervisor.rebuildProcessedSignalsFromEvents — reads the FULL log via
 *     readAll() on startup to reconstruct the in-memory idempotency set; it
 *     filters on TEAMMATE_EVENT events whose processingDecision === ACCEPT.
 *     Dropping these breaks signal idempotency across coordinator restarts
 *     (double-processing of already-handled signals).
 *
 *  3. Supervisor.reconcileUnacknowledgedSignalIntents — reads the FULL log via
 *     readAll() on startup to find SIGNAL_INTENT_RECORDED events that were never
 *     acknowledged; it also consults SIGNAL_ACKNOWLEDGED, TEAMMATE_EVENT, and
 *     SIGNAL_INTENT_RECONCILED to determine which intents have been handled.
 *     Dropping any of these breaks intent reconciliation.
 *
 *  4. Supervisor.hasDurableInactiveEvent / pruneDurablyInactiveStartedBeads —
 *     reads events via eventsForBeads() and switches on TEAMMATE_PROCESS_EXITED
 *     to determine whether a started bead's slot is durably inactive and should
 *     be pruned. Dropping these breaks slot-health pruning across restarts.
 *
 *  5. projectTools/preflight.ts projectToolFailureLimit /
 *     eventsForActiveProjectToolRun — reads events via eventsForBead() and
 *     switches on PROJECT_TOOL_FAILED to enforce consecutive-failure circuit
 *     breaking. Dropping these causes the failure counter to reset silently
 *     after compaction, defeating the circuit breaker.
 *
 * Non-critical (compactable) events are pure telemetry not consumed by any of
 * the above: heartbeats, slot-health, token-usage, command lifecycle events,
 * tool-invocation events, etc.
 */
export const REPLAY_CRITICAL_EVENT_TYPES = new Set<string>([
  // Core bead lifecycle — both projection methods consume these
  DomainEventName.BEAD_CLAIMED,
  DomainEventName.BEAD_CLOSED,
  DomainEventName.BEAD_RELEASED,
  DomainEventName.BEAD_STATUS_UPDATED,
  DomainEventName.BEAD_TOMBSTONED,
  // State execution
  DomainEventName.STATE_RUN_INITIALIZED,
  DomainEventName.STATE_TRANSITION_APPLIED,
  DomainEventName.ACTION_COMPLETED,
  // Teammate / worktree
  DomainEventName.TEAMMATE_SPAWNED,
  DomainEventName.WORKTREE_CREATED,
  DomainEventName.WORKTREE_REUSED,
  DomainEventName.WORKTREE_PROVISIONED,
  DomainEventName.WORKTREE_REMOVED,
  // Restart signals
  DomainEventName.CONTEXT_RESTART_REQUESTED,
  DomainEventName.HARNESS_RESTART_REQUESTED,
  // Checklist / checkpoint
  DomainEventName.CHECKLIST_ITEM_TICKED,
  DomainEventName.CHECKLIST_ITEM_ADDED,
  DomainEventName.CHECKPOINT_SUBMITTED,
  // Compaction counter
  DomainEventName.CONTEXT_COMPACTION_RECORDED,
  // Merge lifecycle
  DomainEventName.MERGE_AND_COMMIT_STARTED,
  DomainEventName.MERGE_AND_COMMIT_SUCCEEDED,
  DomainEventName.MERGE_AND_COMMIT_FAILED,
  // Signal idempotency & intent reconciliation — read via readAll() by the
  // Supervisor on every coordinator startup (see consumers 2 and 3 above).
  // Dropping these silently breaks cross-restart signal deduplication and
  // unacknowledged-intent detection.
  DomainEventName.TEAMMATE_EVENT,
  DomainEventName.SIGNAL_INTENT_RECORDED,
  DomainEventName.SIGNAL_ACKNOWLEDGED,
  DomainEventName.SIGNAL_INTENT_RECONCILED,
  // Slot-health pruning — Supervisor.hasDurableInactiveEvent switches on this
  // via eventsForBeads() to decide if a started bead is durably inactive
  // (consumer 4 above).
  DomainEventName.TEAMMATE_PROCESS_EXITED,
  // Project-tool circuit breaker — projectToolFailureLimit switches on this
  // via eventsForActiveProjectToolRun() to enforce per-bead failure limits
  // (consumer 5 above).
  DomainEventName.PROJECT_TOOL_FAILED,
  // v2 route-event contract (pi-experiment-6k8e): the v2 BeadStateProjection
  // reads these to reconstruct which transitions were applied from deterministic
  // emitter decisions. Loss of these events means v2 replay cannot reconstruct
  // authoritative transition history.
  DomainEventName.ROUTE_EVENT_EMITTED,
  // Compaction summary pointer (pi-experiment-6q0y.35): replay-critical so
  // history reconstruction can locate the compaction summary artifact after
  // compaction. Only emitted when compactionSummary.enabled:true is configured.
  DomainEventName.COMPACTION_SUMMARY_RECORDED,
]);
