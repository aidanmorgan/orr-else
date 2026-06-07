/**
 * pi-experiment-g0bi: Canonical domain-event schema registry.
 * pi-experiment-kutb: Extended with version, replayImpact, and optionalFields metadata.
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
 *   - CONTEXT/HARNESS_RESTART_REQUESTED: restartId and targetState required
 *     (pi-experiment-q8tl); all production writers now populate them. actionId
 *     and previousRunId remain optional (supervisor-triggered restarts omit them).
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
 *
 * KUTB EXTENSION (pi-experiment-kutb):
 *   DOMAIN_EVENT_SCHEMA_METADATA adds per-event:
 *   - version:       Schema version. Bump when required-field set changes.
 *   - replayImpact:  CRITICAL | INFORMATIONAL | AUDIT — how compaction treats the event.
 *   - optionalFields: Fields that are typed but NOT required (writer may omit them).
 *                    Consumers must tolerate absence. Documented here so replay
 *                    reconstruction logic can warn when expected-but-optional fields
 *                    are absent from historical events.
 *
 *   DOMAIN_EVENT_SCHEMAS (g0bi required-field map) is UNCHANGED.
 *   EventStore.validateProductionPayload() is UNCHANGED.
 */

import { DomainEventName } from '../constants/index.js';

// ---------------------------------------------------------------------------
// pi-experiment-kutb: per-event schema metadata
// ---------------------------------------------------------------------------

/**
 * How the absence of this event type from the event log affects replay
 * correctness.
 *
 * CRITICAL    — loss of this event type means replay cannot reconstruct
 *               authoritative bead/run state. Compaction must NEVER drop
 *               these events. Listed in REPLAY_CRITICAL_EVENT_TYPES.
 *
 * INFORMATIONAL — event feeds monitoring, slot-health, or observability but
 *               its loss does not break state reconstruction. May be compacted
 *               once the observation window passes.
 *
 * AUDIT       — pure telemetry / substrate record. Safe to compact.
 */
export type ReplayImpact = 'CRITICAL' | 'INFORMATIONAL' | 'AUDIT';

/**
 * Per-event richer metadata added by pi-experiment-kutb.
 *
 * - version:        Monotonic integer. Increment when the required-field set
 *                   or optionalFields list changes in a meaningful way.
 * - replayImpact:   Classification for compaction decisions.
 * - optionalFields: Fields that some writers supply and replay readers may
 *                   use if present, but that are NEVER required. Absence must
 *                   not crash projections or reconstruction logic.
 */
export interface DomainEventSchemaMetadata {
  readonly version: number;
  readonly replayImpact: ReplayImpact;
  readonly optionalFields: readonly string[];
}

/**
 * Per-event metadata map (pi-experiment-kutb).
 *
 * Key: DomainEventName (string literal)
 * Value: DomainEventSchemaMetadata
 *
 * Coverage mirrors DOMAIN_EVENT_SCHEMAS (g0bi) — every key present there
 * has a corresponding entry here. The required-field enforcement remains
 * in DOMAIN_EVENT_SCHEMAS; this map adds classification and optional-field
 * documentation only.
 */
export const DOMAIN_EVENT_SCHEMA_METADATA: Readonly<Record<string, DomainEventSchemaMetadata>> = {
  // ── Core bead lifecycle ────────────────────────────────────────────────────
  [DomainEventName.BEAD_CLAIMED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    // stateId: present in claim writes; absent when a bead is claimed without
    // an initial state assignment (edge path in tests).
    // owner: carried inside lease object; top-level owner absent.
    optionalFields: ['stateId', 'owner', 'worktreePath']
  },
  [DomainEventName.BEAD_CLOSED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['stateId', 'reason']
  },
  [DomainEventName.BEAD_RELEASED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['reason']
  },
  [DomainEventName.BEAD_STATUS_UPDATED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['reason', 'stateId']
  },
  [DomainEventName.BEAD_TOMBSTONED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['reason', 'stateId']
  },

  // ── State execution ───────────────────────────────────────────────────────
  [DomainEventName.STATE_RUN_INITIALIZED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    // runId: present only when SESSION_STATE_ID env var is set (worker mode).
    // restartId/previousRunId: present only on restart-initiated runs (nyug).
    // actionKey, workflowVersion, worktreePath, promptProvenance: optional metadata.
    optionalFields: ['runId', 'restartId', 'previousRunId', 'actionKey', 'workflowVersion', 'worktreePath', 'promptProvenance']
  },
  [DomainEventName.STATE_TRANSITION_APPLIED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    // workerId: absent in some test writes (project_tools.test.ts:1071).
    // actionId/handover: not always supplied; handover only on restart transitions.
    optionalFields: ['workerId', 'actionId', 'handover', 'stateId']
  },
  [DomainEventName.ACTION_COMPLETED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    // result: the tool/action outcome object; always written by extension.ts
    // but left optional here because test writes sometimes omit it.
    optionalFields: ['result', 'workerId', 'runId']
  },

  // ── Restart lifecycle ─────────────────────────────────────────────────────
  [DomainEventName.CONTEXT_RESTART_REQUESTED]: {
    version: 2,
    replayImpact: 'CRITICAL',
    // restartId: required (pi-experiment-q8tl) — all writers now populate it.
    // targetState: required — all writers now populate it explicitly.
    // previousRunId: optional — only worker-sourced restarts carry the prior
    //   session ID; supervisor-triggered restarts have no prior worker session.
    // actionId: optional — supervisor-triggered restarts have no actionId.
    // handover: present on most signals; absent on supervisor-triggered ones.
    optionalFields: ['previousRunId', 'handover', 'actionId']
  },
  [DomainEventName.HARNESS_RESTART_REQUESTED]: {
    version: 2,
    replayImpact: 'CRITICAL',
    // restartId: required (pi-experiment-q8tl) — all writers now populate it.
    // targetState: required — all writers now populate it explicitly.
    // previousRunId: optional — supervisor-triggered restarts have no prior session.
    // actionId: optional — supervisor-triggered restarts have no actionId.
    optionalFields: ['previousRunId', 'handover', 'actionId']
  },

  // ── Teammate / worktree ────────────────────────────────────────────────────
  [DomainEventName.TEAMMATE_SPAWNED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['worktreePath', 'paneId', 'branchName']
  },
  [DomainEventName.WORKTREE_CREATED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['branchName', 'fromBranch', 'worktreePath']
  },
  [DomainEventName.WORKTREE_REUSED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['branchName', 'worktreePath']
  },
  [DomainEventName.WORKTREE_PROVISIONED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    // worktreePath: written by Supervisor but not guaranteed on all paths.
    optionalFields: ['worktreePath', 'branchName']
  },
  [DomainEventName.WORKTREE_REMOVED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['reason', 'branchName']
  },

  // ── Slot-health pruning ───────────────────────────────────────────────────
  [DomainEventName.TEAMMATE_PROCESS_EXITED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    // reason/terminatedPaneIds: absent when Supervisor writes only { beadId }.
    optionalFields: ['reason', 'terminatedPaneIds', 'workerId']
  },

  // ── Signal idempotency & intent reconciliation ─────────────────────────────
  [DomainEventName.TEAMMATE_EVENT]: {
    version: 1,
    replayImpact: 'CRITICAL',
    // idempotencyKey, stateId, workerId, processingReason: present in most writes
    // but not required (some test writes omit them).
    optionalFields: ['idempotencyKey', 'stateId', 'workerId', 'processingReason']
  },
  [DomainEventName.SIGNAL_INTENT_RECORDED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['idempotencyKey', 'stateId', 'workerId', 'targetState']
  },
  [DomainEventName.SIGNAL_ACKNOWLEDGED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['idempotencyKey', 'stateId', 'workerId']
  },
  [DomainEventName.SIGNAL_INTENT_RECONCILED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['type', 'stateId', 'reason']
  },

  // ── Project-tool circuit breaker ───────────────────────────────────────────
  [DomainEventName.PROJECT_TOOL_FAILED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    // beadId/stateId/actionId: optional — beadIdFromArgs() returns undefined
    // when called without bead context; stateId/actionId omitted in some tests.
    // toolInvocationId: always written by extension.ts path; absent in direct writes.
    optionalFields: ['beadId', 'stateId', 'actionId', 'toolInvocationId', 'status', 'result']
  },
  [DomainEventName.PROJECT_TOOL_SUCCEEDED]: {
    version: 1,
    replayImpact: 'INFORMATIONAL',
    optionalFields: ['beadId', 'stateId', 'actionId', 'toolInvocationId', 'status', 'result']
  },
  [DomainEventName.PROJECT_TOOL_STARTED]: {
    version: 1,
    replayImpact: 'INFORMATIONAL',
    optionalFields: ['beadId', 'stateId', 'actionId', 'toolInvocationId']
  },

  // ── Tool invocation correlation ────────────────────────────────────────────
  [DomainEventName.TOOL_INVOCATION_STARTED]: {
    version: 1,
    replayImpact: 'INFORMATIONAL',
    // beadId: absent when tool runs without bead context.
    // toolInvocationId: always generated by extension.ts (uuidv7); optional
    //   because older or direct writes may not supply it.
    // toolName: explicit identity alias for tool (dsm2.12); absent on legacy events.
    // stateId/actionId: populated by extension.ts (dsm2.12); absent on legacy events.
    optionalFields: ['beadId', 'toolInvocationId', 'params', 'stateId', 'actionId', 'toolName']
  },
  [DomainEventName.TOOL_INVOCATION_SUCCEEDED]: {
    version: 2,
    replayImpact: 'INFORMATIONAL',
    // toolName: explicit identity alias (dsm2.12); absent on legacy events.
    // stateId/actionId: explicit identity (dsm2.12); absent on legacy events
    //   (reader falls back to toolResult.outputFile path parsing for those).
    // toolCallId: Pi-native toolCallId (Pi observer path only); absent for
    //   extension.ts wrapped tools.
    // schemaId/schemaVersion: optional metadata for schema evolution tracking.
    optionalFields: ['beadId', 'toolInvocationId', 'rawFile', 'rawBytes', 'rawChecksum',
      'stateId', 'actionId', 'toolName', 'toolCallId', 'schemaId', 'schemaVersion',
      'cached', 'cacheAgeMs']
  },
  [DomainEventName.TOOL_INVOCATION_FAILED]: {
    version: 2,
    replayImpact: 'INFORMATIONAL',
    // toolName: explicit identity alias (dsm2.12); absent on legacy events.
    // stateId/actionId: explicit identity (dsm2.12); absent on legacy events.
    // toolCallId: Pi-native toolCallId (Pi observer path only).
    // schemaId/schemaVersion: optional metadata for schema evolution tracking.
    optionalFields: ['beadId', 'toolInvocationId', 'error', 'stateId', 'actionId',
      'toolName', 'toolCallId', 'schemaId', 'schemaVersion']
  },

  // ── Checklist / checkpoint (replay-critical) ──────────────────────────────
  [DomainEventName.CHECKLIST_ITEM_TICKED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    // beadId/stateId/text: present in most writes; beadId absent in some test fixtures.
    optionalFields: ['beadId', 'stateId', 'text', 'evidence', 'mandatory']
  },
  [DomainEventName.CHECKLIST_ITEM_ADDED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['beadId', 'stateId', 'text', 'mandatory', 'type']
  },
  [DomainEventName.CHECKPOINT_SUBMITTED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['actionId', 'workerId', 'outcome']
  },

  // ── Merge lifecycle (replay-critical) ────────────────────────────────────
  [DomainEventName.MERGE_AND_COMMIT_STARTED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['stateId', 'actionId', 'workerId']
  },
  [DomainEventName.MERGE_AND_COMMIT_SUCCEEDED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['stateId', 'actionId', 'commitSha', 'workerId']
  },
  [DomainEventName.MERGE_AND_COMMIT_FAILED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['stateId', 'actionId', 'reason', 'workerId']
  },

  // ── Context compaction counter ─────────────────────────────────────────────
  [DomainEventName.CONTEXT_COMPACTION_RECORDED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['stateId', 'actionId', 'count']
  },

  // ── Token accounting (pi-experiment-6q0y.15) ──────────────────────────────
  //
  // MODEL_TURN_USAGE_RECORDED: carries provider-reported token usage + cost for
  //   one assistant turn. beadId/stateId/actionId/workerId/model are always
  //   populated by PiObservers.ts (env vars with App.* fallbacks).
  //   provider and idempotencyKey are optional — new fields added by 6q0y.15;
  //   legacy events written before this bead lack them.
  [DomainEventName.MODEL_TURN_USAGE_RECORDED]: {
    version: 1,
    replayImpact: 'AUDIT',
    optionalFields: ['provider', 'idempotencyKey']
  },
  //
  // TOOL_PAYLOAD_ACCOUNTED: carries model-facing byte/token estimate for one
  //   tool invocation. tool is always present (definition.name). beadId/stateId/
  //   actionId/toolInvocationId/idempotencyKey are optional — absent when the tool
  //   runs without a bead context or on the legacy code path.
  [DomainEventName.TOOL_PAYLOAD_ACCOUNTED]: {
    version: 1,
    replayImpact: 'AUDIT',
    optionalFields: ['beadId', 'stateId', 'actionId', 'toolInvocationId', 'idempotencyKey']
  },

  // ── Startup / substrate events ─────────────────────────────────────────────
  [DomainEventName.BEAD_CREATED]: {
    version: 1,
    replayImpact: 'AUDIT',
    optionalFields: ['stateId', 'owner', 'description']
  },
  [DomainEventName.HARNESS_STARTED]: {
    version: 1,
    replayImpact: 'AUDIT',
    optionalFields: ['beadId', 'requestedBeadId', 'mode', 'version']
  },
  [DomainEventName.HARNESS_STOPPED]: {
    version: 1,
    replayImpact: 'AUDIT',
    optionalFields: ['beadId', 'requestedBeadId', 'reason', 'exitCode']
  },
};

/**
 * Look up per-event schema metadata by event type string.
 *
 * Returns undefined when the event type has no metadata entry (unregistered
 * or dynamically-named events). Callers must tolerate undefined gracefully.
 */
export function getDomainEventMeta(eventType: string): DomainEventSchemaMetadata | undefined {
  return DOMAIN_EVENT_SCHEMA_METADATA[eventType];
}

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
  // pi-experiment-q8tl: restartId and targetState are now required.
  //   All production writers (extension.ts, Supervisor.ts) always populate them.
  //   previousRunId is optional — supervisor-triggered restarts have no prior
  //   worker session ID. actionId is optional — supervisor-triggered restarts
  //   have no actionId.
  [DomainEventName.CONTEXT_RESTART_REQUESTED]: ['beadId', 'stateId', 'transitionEvent', 'restartId', 'targetState'],
  [DomainEventName.HARNESS_RESTART_REQUESTED]: ['beadId', 'stateId', 'transitionEvent', 'restartId', 'targetState'],

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

  // ── Token accounting (pi-experiment-6q0y.15) ──────────────────────────────
  //
  // MODEL_TURN_USAGE_RECORDED: writer-guaranteed fields are all of
  //   beadId, stateId, actionId, workerId, model, inputTokens, outputTokens,
  //   cacheReadTokens, cacheWriteTokens, totalTokens, costTotal, durationMs.
  //   PiObservers.ts always provides them (env-var + App.* fallbacks mean they
  //   can never be undefined). provider + idempotencyKey are optional (new in
  //   6q0y.15; absent on legacy events).
  [DomainEventName.MODEL_TURN_USAGE_RECORDED]: [
    'beadId', 'stateId', 'actionId', 'workerId', 'model',
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
    'totalTokens', 'costTotal', 'durationMs'
  ],
  //
  // TOOL_PAYLOAD_ACCOUNTED: writer-guaranteed field is only `tool`
  //   (definition.name is always present). modelFacingBytes, estimatedTokens,
  //   and cached are also always written by buildToolTokenAccounting().
  //   beadId/stateId/actionId/toolInvocationId: absent when tool runs without
  //   a bead context; idempotencyKey: new in 6q0y.15, absent on legacy.
  [DomainEventName.TOOL_PAYLOAD_ACCOUNTED]: ['tool', 'modelFacingBytes', 'estimatedTokens', 'cached'],

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
