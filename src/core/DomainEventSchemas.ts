/**
 * pi-experiment-g0bi: Canonical domain-event schema registry.
 *
 * Defines required-field schemas for every replay-critical and startup-critical
 * domain event. This is the authoritative, code-owned contract for event shapes
 * consumed by:
 *   - BeadStateProjection (restart lifecycle reconstruction)
 *   - Supervisor (signal idempotency, slot-health pruning, startup rebuild)
 *   - VerifierGate (tool invocation correlation)
 *   - RetentionCleanup (replay + compaction)
 *   - Monitoring / observability
 *
 * DESIGN: extends (does not replace) the y2ax PRODUCTION_PAYLOAD_SCHEMAS map.
 * EventStore.validateProductionPayload() continues to work the same way —
 * this module is imported there to replace the inline two-entry constant with
 * a registry covering all replay-critical events.
 *
 * BACKWARD COMPATIBILITY:
 *   Required-field sets are INTENTIONALLY MINIMAL — only fields present in
 *   EVERY production write of that event, including test writes that do not
 *   use synthetic:true. Fields that appear in some writes but not others are
 *   NOT in the required set. This prevents false positives against older events
 *   or test fixtures that predate the registry.
 *
 *   Grandfathered / partial-shape writes:
 *   - PROJECT_TOOL_FAILED/SUCCEEDED: some test writes omit stateId/actionId
 *     (project_tools.test.ts:975); schema requires only beadId + tool.
 *   - STATE_TRANSITION_APPLIED: workerId is optional; schema requires
 *     beadId + fromState + nextState + transitionEvent.
 *   - CONTEXT/HARNESS_RESTART_REQUESTED: restartId added in pi-experiment-nyug;
 *     older test fixture writes (project_tools.test.ts:1027) omit it; schema
 *     requires only beadId + stateId + transitionEvent.
 *   - SIGNAL_ACKNOWLEDGED/INTENT_RECORDED: some test writes omit idempotencyKey
 *     (project_tools.test.ts:1117, synthetic_read_filter.test.ts:222);
 *     schema requires only beadId + type.
 *   - TEAMMATE_PROCESS_EXITED: Supervisor can write with only { beadId } when
 *     a pane goes missing without a restart; schema requires only beadId.
 *   - WORKTREE_PROVISIONED: single-field write in Supervisor; requires only beadId.
 *   - TEAMMATE_SPAWNED: requires beadId + stateId + workerId.
 *   - TOOL_INVOCATION_*: beadIdFromToolParams() returns string|undefined (extension.ts:416)
 *     and PiObservers.ts:149 does the same — beadId absent when no bead context;
 *     schema requires only tool.
 */

import { DomainEventName } from '../constants/index.js';

/**
 * The canonical required-field registry for domain events.
 *
 * Key: DomainEventName (string)
 * Value: tuple of field names that MUST be present (non-undefined) in every
 *        non-synthetic production write of that event.
 *
 * Source of truth for which events are covered:
 *   REPLAY_CRITICAL_EVENT_TYPES (src/constants/index.ts) — events that must
 *   never be compacted. All of those are covered here, plus startup/substrate
 *   events that feed monitoring (HARNESS_STARTED/STOPPED, BEAD_CREATED, etc.).
 */
export const DOMAIN_EVENT_SCHEMAS: Readonly<Record<string, readonly string[]>> = {
  // ── Core bead lifecycle ────────────────────────────────────────────────────
  // Both projection methods switch on these; BeadStateProjection.projectBead*
  // reads beadId + status from every BEAD_* event.
  [DomainEventName.BEAD_CLAIMED]: ['beadId', 'lease'],
  [DomainEventName.BEAD_CLOSED]: ['beadId'],
  [DomainEventName.BEAD_RELEASED]: ['beadId'],
  [DomainEventName.BEAD_STATUS_UPDATED]: ['beadId', 'status'],
  [DomainEventName.BEAD_TOMBSTONED]: ['beadId'],

  // ── State execution ───────────────────────────────────────────────────────
  // STATE_RUN_INITIALIZED: all three fields set by every writer
  //   (WorkerRunController, tests, Teammate auto-restart).
  [DomainEventName.STATE_RUN_INITIALIZED]: ['beadId', 'stateId', 'actionId'],

  // STATE_TRANSITION_APPLIED: workerId is optional (absent in some test writes
  //   project_tools.test.ts:1071). fromState/nextState/transitionEvent are
  //   always present in production writes.
  [DomainEventName.STATE_TRANSITION_APPLIED]: ['beadId', 'fromState', 'nextState', 'transitionEvent'],

  // ACTION_COMPLETED: written only by extension.ts with all three fields.
  [DomainEventName.ACTION_COMPLETED]: ['beadId', 'stateId', 'actionId'],

  // ── Restart lifecycle ─────────────────────────────────────────────────────
  // restartId (added pi-experiment-nyug) is absent in older test fixtures
  // (project_tools.test.ts:1027). Require only the invariant minimal set.
  [DomainEventName.CONTEXT_RESTART_REQUESTED]: ['beadId', 'stateId', 'transitionEvent'],
  [DomainEventName.HARNESS_RESTART_REQUESTED]: ['beadId', 'stateId', 'transitionEvent'],

  // ── Teammate / worktree ────────────────────────────────────────────────────
  [DomainEventName.TEAMMATE_SPAWNED]: ['beadId', 'stateId', 'workerId'],
  [DomainEventName.WORKTREE_CREATED]: ['beadId', 'path'],
  [DomainEventName.WORKTREE_REUSED]: ['beadId', 'path'],
  // WORKTREE_PROVISIONED: Supervisor writes only { beadId, worktreePath }.
  // Requiring both would fail if worktreePath is absent in edge paths;
  // beadId is the minimal invariant.
  [DomainEventName.WORKTREE_PROVISIONED]: ['beadId'],
  [DomainEventName.WORKTREE_REMOVED]: ['beadId', 'path'],

  // ── Slot-health pruning ───────────────────────────────────────────────────
  // TEAMMATE_PROCESS_EXITED: Supervisor path at Supervisor.ts:1027 writes
  //   only { beadId } (no reason) when a pane goes missing; teammates.ts
  //   writes { beadId, reason, terminatedPaneIds }. Only beadId is invariant.
  [DomainEventName.TEAMMATE_PROCESS_EXITED]: ['beadId'],

  // ── Signal idempotency & intent reconciliation ─────────────────────────────
  // Both SIGNAL_ACKNOWLEDGED and SIGNAL_INTENT_RECORDED: some test writes
  //   (project_tools.test.ts:1117, synthetic_read_filter.test.ts:222) omit
  //   idempotencyKey. type + beadId are always present.
  [DomainEventName.TEAMMATE_EVENT]: ['beadId', 'type', 'processingDecision'],
  [DomainEventName.SIGNAL_INTENT_RECORDED]: ['beadId', 'type'],
  [DomainEventName.SIGNAL_ACKNOWLEDGED]: ['beadId', 'type'],
  [DomainEventName.SIGNAL_INTENT_RECONCILED]: ['beadId'],

  // ── Project-tool circuit breaker ───────────────────────────────────────────
  // beadId is NOT in the required set for PROJECT_TOOL_* events: beadIdFromArgs()
  //   returns undefined when a tool is invoked without a bead context (e.g. the
  //   test at project_tools.test.ts:2715 calls execute({}, {} as any) with no
  //   args, so beadId is undefined in the payload). tool is always provided by
  //   every writer (definition.name). stateId + actionId are also excluded
  //   (project_tools.test.ts:975 omits them).
  [DomainEventName.PROJECT_TOOL_FAILED]: ['tool'],
  [DomainEventName.PROJECT_TOOL_SUCCEEDED]: ['tool'],
  [DomainEventName.PROJECT_TOOL_STARTED]: ['tool'],

  // ── Tool invocation correlation ────────────────────────────────────────────
  // beadId is NOT in the required set: beadIdFromToolParams() (extension.ts:416)
  //   and PiObservers.ts:149 both return string|undefined — when a tool runs
  //   without a bead context, beadId is undefined in the payload. Requiring it
  //   causes record() to throw and breaks the tool invocation. tool is always
  //   provided (definition.name / event.toolName), so only tool is required.
  [DomainEventName.TOOL_INVOCATION_STARTED]: ['tool'],
  [DomainEventName.TOOL_INVOCATION_SUCCEEDED]: ['tool'],
  [DomainEventName.TOOL_INVOCATION_FAILED]: ['tool'],

  // ── Checklist / checkpoint (replay-critical) ──────────────────────────────
  // CHECKLIST_ITEM_TICKED/ADDED: registered but with NO required fields.
  //   Existing tests write these without beadId
  //   (eventstore_payload_validation.test.ts:229 tests the "schema-free event
  //   passes through" invariant using CHECKLIST_ITEM_TICKED { text: 'Done' }).
  //   These events are replay-critical but accept any payload shape — requiring
  //   beadId would break existing test fixtures. Empty list = registered but
  //   no field enforcement.
  [DomainEventName.CHECKLIST_ITEM_TICKED]: [],
  [DomainEventName.CHECKLIST_ITEM_ADDED]: [],
  // CHECKPOINT_SUBMITTED: beadId + stateId always present in all writes.
  [DomainEventName.CHECKPOINT_SUBMITTED]: ['beadId', 'stateId'],

  // ── Merge lifecycle (replay-critical) ────────────────────────────────────
  [DomainEventName.MERGE_AND_COMMIT_STARTED]: ['beadId'],
  [DomainEventName.MERGE_AND_COMMIT_SUCCEEDED]: ['beadId'],
  [DomainEventName.MERGE_AND_COMMIT_FAILED]: ['beadId'],

  // ── Context compaction counter ─────────────────────────────────────────────
  [DomainEventName.CONTEXT_COMPACTION_RECORDED]: ['beadId'],

  // ── Startup / substrate events ─────────────────────────────────────────────
  // These are not in REPLAY_CRITICAL_EVENT_TYPES but feed monitoring, startup
  // audit, and observability — worth a schema to catch field-thin writes.
  // NOTE: HARNESS_STARTED/STOPPED do not guarantee any specific data field
  //   (beadId is optional in worker mode; requestedBeadId may be absent);
  //   they are registered here for documentation completeness but with an
  //   empty required-field list so they do not break any existing write.
  //   BEAD_CREATED always carries beadId from bd.ts:741.
  [DomainEventName.BEAD_CREATED]: ['beadId'],
  [DomainEventName.HARNESS_STARTED]: [],
  [DomainEventName.HARNESS_STOPPED]: [],
};
