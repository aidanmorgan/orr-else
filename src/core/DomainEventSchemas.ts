/**
 * pi-experiment-g0bi: Canonical domain-event schema registry.
 * pi-experiment-kutb: Extended with version, replayImpact, and optionalFields metadata.
 * pi-experiment-824i: Removed permissive back-compat shims; all schemas require minimum fields.
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
 * NO BACKWARD COMPATIBILITY (pi-experiment-824i):
 *   Legacy partial-shape writes are REJECTED at record() time. There is no
 *   back-compat shim or grandfathering — older/partial payloads that omit
 *   now-required fields must not enter the event log.
 *
 *   Required-field policy:
 *   - PROJECT_TOOL_FAILED/SUCCEEDED: some test writes omit stateId/actionId
 *     (project_tools.test.ts:975); schema requires only tool.
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
 *   - CHECKLIST_ITEM_TICKED: requires beadId + text (pi-experiment-824i: no longer
 *     grandfathered with empty required-field list; partial payloads are rejected).
 *   - CHECKLIST_ITEM_ADDED: requires beadId + item (pi-experiment-824i: same).
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
 *   DOMAIN_EVENT_SCHEMAS (g0bi required-field map) is UNCHANGED except where
 *   pi-experiment-824i tightened previously-empty schemas.
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
    version: 2,
    replayImpact: 'CRITICAL',
    // workerId: absent in some test writes (project_tools.test.ts:1071).
    // actionId/handover: not always supplied; handover only on restart transitions.
    // v2 additive fields (pi-experiment-6k8e): routeEventId + transitionKey reference
    // the ROUTE_EVENT_EMITTED record that authorized this transition. Absent on v1
    // records (which use model-authored transitionEvent instead). Both are optional so
    // v1 records still validate against this schema — no v1 regression.
    optionalFields: ['workerId', 'actionId', 'handover', 'stateId', 'routeEventId', 'transitionKey']
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
    // outputFile: harness wrapper archive (0yt5.27); absent on short-circuit exits.
    // semanticArtifactPath: canonical child output path (6q0y.11); absent for legacy tools.
    // rawTransportArchivePaths: raw stdout/stderr archive paths (6q0y.11); absent for legacy tools.
    optionalFields: ['beadId', 'stateId', 'actionId', 'toolInvocationId', 'status', 'result',
      'outputFile', 'semanticArtifactPath', 'rawTransportArchivePaths']
  },
  [DomainEventName.PROJECT_TOOL_SUCCEEDED]: {
    version: 1,
    replayImpact: 'INFORMATIONAL',
    // outputFile: harness wrapper archive (0yt5.27).
    // semanticArtifactPath: canonical child output path (6q0y.11); absent for legacy tools.
    // rawTransportArchivePaths: raw stdout/stderr archive paths (6q0y.11); absent for legacy tools.
    optionalFields: ['beadId', 'stateId', 'actionId', 'toolInvocationId', 'status', 'result',
      'outputFile', 'semanticArtifactPath', 'rawTransportArchivePaths']
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
    version: 2,
    replayImpact: 'CRITICAL',
    // pi-experiment-824i: beadId and text are now required (removed grandfathered empty schema).
    // stateId/evidence/mandatory: present in most writes but not required.
    optionalFields: ['stateId', 'actionId', 'actionKey', 'evidence', 'mandatory']
  },
  [DomainEventName.CHECKLIST_ITEM_ADDED]: {
    version: 2,
    replayImpact: 'CRITICAL',
    // pi-experiment-824i: beadId and item are now required (removed grandfathered empty schema).
    // stateId/source/mandatory/type: present in most writes but not required.
    optionalFields: ['stateId', 'actionId', 'actionKey', 'source', 'mandatory', 'type']
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

  // ── Readiness probe (pi-experiment-8ieq) ──────────────────────────────────
  // Required: tool, configPath, probeStatus, elapsedMs, gateDec.
  // Optional: bytes, sha256, semanticArtifactPath (absent when probe did not
  //   produce an output artifact — e.g. UNSAFE / TIMEOUT / OVERSIZE probes).
  [DomainEventName.PROJECT_TOOL_PROBE_COMPLETED]: {
    version: 1,
    replayImpact: 'AUDIT',
    optionalFields: ['bytes', 'sha256', 'semanticArtifactPath']
  },

  // ── Retry pipeline decision (pi-experiment-t6gw) ──────────────────────────
  // All eight fields are required — partial emits are rejected by EventStore.
  // Deterministic: decision is driven only by configured policy + attempt count
  //   + closed failure category + tool side-effect contract (no Date.now()/
  //   Math.random()). Replay yields the same decisions.
  [DomainEventName.TOOL_RETRY_DECISION]: {
    version: 1,
    replayImpact: 'AUDIT',
    optionalFields: []
  },

  // ── Prompt-budget admission (pi-experiment-6q0y.17) ───────────────────────
  // Emitted ONLY when a budget policy is configured AND the final prompt exceeds
  // a limit. With no budget configured this event is NEVER emitted (true no-op).
  // Required fields carry the deterministic evidence: hashes, byte counts, token
  // estimates, config path, state/action identity, scope, and route.
  // NO prompt body is ever included (AC5).
  // Optional: beadId (absent when no bead context), actionId (absent when
  //   resolving at state scope), limitBytes/limitTokens (each may be absent when
  //   the policy declares only the other kind of limit).
  [DomainEventName.PROMPT_BUDGET_ADMISSION]: {
    version: 1,
    replayImpact: 'AUDIT',
    optionalFields: ['beadId', 'actionId', 'limitBytes', 'limitTokens']
  },

  // ── Tool-payload budget rejection (pi-experiment-6q0y.18) ─────────────────
  // Emitted ONLY when a tool-payload budget is configured AND a result exceeds
  // the limit. With no budget configured this event is NEVER emitted (true no-op).
  // Required fields: tool (name), actualBytes (exact bytes), limitBytes (the
  //   configured limit), decision (always 'REJECTED'), route (outcome route).
  // Optional: beadId/stateId/actionId/toolInvocationId (absent when no bead
  //   context), outputFile (artifact path when available — AC6 semantic ref).
  [DomainEventName.TOOL_PAYLOAD_BUDGET_REJECTED]: {
    version: 1,
    replayImpact: 'AUDIT',
    optionalFields: ['beadId', 'stateId', 'actionId', 'toolInvocationId', 'outputFile']
  },

  // ── Runtime budget exceeded (pi-experiment-6q0y.48) ───────────────────────
  // Emitted ONLY when a runtime budget is configured AND a hard limit is exceeded.
  // With no runtime budget configured this event is NEVER emitted (true no-op, AC1).
  // Required fields carry structured decision evidence: budgetId, dimension,
  //   currentValue, limit, nextRoute. No prompt body or raw tool output (AC5).
  // Optional: beadId/stateId/actionId (absent when no bead context).
  [DomainEventName.RUNTIME_BUDGET_EXCEEDED]: {
    version: 1,
    replayImpact: 'AUDIT',
    optionalFields: ['beadId', 'stateId', 'actionId']
  },

  // ── Loop detection (pi-experiment-6q0y.49) ────────────────────────────────
  // Always-on: events fired when the structural loop detector fires.
  // REPLAY-CRITICAL: rebuildFromEvents() uses these to reconstruct counter
  //   state after harness/context restart (AC7).
  // Required: scope, fingerprint (sha256 prefix — no raw bodies), count, max,
  //   routeEvent. Optional: beadId/stateId/actionId (absent when no active run).
  [DomainEventName.LOOP_DETECTED]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['beadId', 'stateId', 'actionId']
  },
  [DomainEventName.LOOP_WARNING_DIAGNOSTIC]: {
    version: 1,
    replayImpact: 'CRITICAL',
    optionalFields: ['beadId', 'stateId', 'actionId']
  },

  // ── v2 route-event contract (pi-experiment-6k8e) ──────────────────────────
  // ROUTE_EVENT_EMITTED: emitted ONLY by configured deterministic emitters
  //   (tools, verifiers, gates, system preconditions). Model-authored fields,
  //   tool stdout/stderr, and untrusted args MUST NEVER produce this event.
  //
  // Required: schemaId, schemaVersion, configVersion, configFingerprint,
  //   beadId, stateId, actionId, runId, emitterType, emitterId, eventName,
  //   category, evidenceRefs.
  //
  // evidenceRefs: each ref requires semanticPath, byteCount, sha256.
  //   A ref missing byteCount or sha256 is rejected by the SchemaRegistry
  //   JSON Schema validator BEFORE any projection can consume it.
  //
  // REPLAY-CRITICAL: v2 BeadStateProjection reads these to reconstruct
  //   authoritative transition history without relying on model-authored fields.
  [DomainEventName.ROUTE_EVENT_EMITTED]: {
    version: 2,
    replayImpact: 'CRITICAL',
    // All 13 required fields are listed in DOMAIN_EVENT_SCHEMAS below.
    // routeEventId: optional self-referential link generated by applyV2RouteEvent()
    //   and embedded in the payload so the caller can write STATE_TRANSITION_APPLIED
    //   referencing it without a separate uuid. Absent on pre-6k8e events.
    // schemaId/schemaVersion on each evidenceRef are optional (absent when the
    // referenced artifact has no schema registration — e.g. raw text artifacts).
    optionalFields: ['routeEventId']
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
  // CHECKLIST_ITEM_TICKED: pi-experiment-824i: requires beadId + text.
  //   extension.ts always writes both; partial-shape legacy writes (e.g.
  //   { text: 'Done' } without beadId) are rejected at record() time.
  // CHECKLIST_ITEM_ADDED: pi-experiment-824i: requires beadId + item.
  //   extension.ts always writes both.
  [DomainEventName.CHECKLIST_ITEM_TICKED]: ['beadId', 'text'],
  [DomainEventName.CHECKLIST_ITEM_ADDED]: ['beadId', 'item'],
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

  // ── Readiness probe (pi-experiment-8ieq) ──────────────────────────────────
  // All five fields are required: tool + configPath identify the probe;
  // probeStatus + elapsedMs + gateDec are the deterministic outcome evidence.
  [DomainEventName.PROJECT_TOOL_PROBE_COMPLETED]: [
    'tool', 'configPath', 'probeStatus', 'elapsedMs', 'gateDec'
  ],

  // ── Retry pipeline decision (pi-experiment-t6gw) ──────────────────────────
  // All eight fields are required: tool + invocationId identify the invocation;
  // attempt + idempotencyClass + failureCategory + configuredLimit encode the
  // decision inputs; decision + nextRoute encode the outcome.
  [DomainEventName.TOOL_RETRY_DECISION]: [
    'tool', 'invocationId', 'attempt', 'idempotencyClass',
    'failureCategory', 'configuredLimit', 'decision', 'nextRoute'
  ],

  // ── Prompt-budget admission (pi-experiment-6q0y.17) ───────────────────────
  // Required: all sizing fields (bytes + tokens + hash for each of the 4 segments),
  // configPath (identifies the policy source), stateId + limitScope + exceeded + route.
  // beadId + actionId are optional (absent when no bead context or state-scope policy).
  [DomainEventName.PROMPT_BUDGET_ADMISSION]: [
    'configPath', 'stateId', 'limitScope', 'exceeded', 'route',
    'stableBlockBytes', 'stableBlockTokens', 'stableBlockHash',
    'piBasePromptBytes', 'piBasePromptTokens', 'piBasePromptHash',
    'volatileSuffixBytes', 'volatileSuffixTokens', 'volatileSuffixHash',
    'finalPromptBytes', 'finalPromptTokens', 'finalPromptHash'
  ],

  // ── Tool-payload budget rejection (pi-experiment-6q0y.18) ────────────────
  // Required: tool (name), actualBytes (exact bytes from serializeToolResultText),
  //   limitBytes (configured limit), decision (always 'REJECTED'), route (outcome).
  // All optional: beadId/stateId/actionId/toolInvocationId (context), outputFile
  //   (semantic artifact path when persisted — AC6 ref without raw body).
  [DomainEventName.TOOL_PAYLOAD_BUDGET_REJECTED]: [
    'tool', 'actualBytes', 'limitBytes', 'decision', 'route'
  ],

  // ── Runtime budget exceeded (pi-experiment-6q0y.48) ──────────────────────
  // Required: budgetId (stable identifier for the policy scope), dimension (which
  //   limit was exceeded), currentValue (accumulated value), limit (configured
  //   limit), nextRoute (the outcome route). All identity fields (beadId,
  //   stateId, actionId) are optional — absent when no bead context.
  // NO prompt body or raw tool output: only structured identity + numeric fields.
  [DomainEventName.RUNTIME_BUDGET_EXCEEDED]: [
    'budgetId', 'dimension', 'currentValue', 'limit', 'nextRoute'
  ],

  // ── Loop detection (pi-experiment-6q0y.49) ────────────────────────────────
  // Required: scope (LoopScope), fingerprint (sha256 prefix — no raw bodies,
  //   AC1), count (current counter), max (configured limit), routeEvent.
  // Optional: beadId / stateId / actionId (context — absent when no active run).
  // Both events are REPLAY-CRITICAL (AC7): LoopDetector.rebuildFromEvents()
  // reads them to reconstruct counter state after harness/context restart.
  [DomainEventName.LOOP_DETECTED]: [
    'scope', 'fingerprint', 'count', 'max', 'routeEvent'
  ],
  [DomainEventName.LOOP_WARNING_DIAGNOSTIC]: [
    'scope', 'fingerprint', 'count', 'max', 'routeEvent'
  ],

  // ── v2 route-event contract (pi-experiment-6k8e) ──────────────────────────
  // All 13 fields are required — partial emits are rejected by EventStore.record().
  // Deterministic: no Date.now() or Math.random() in the event. Replay reaches
  // the same transition decisions without reading model-authored fields.
  //
  // schemaId/schemaVersion: stable identifiers for this event type itself (the
  //   payload schema id + version), enabling replay schema evolution tracking.
  // configVersion/configFingerprint: identifies the exact config that admitted
  //   this transition — critical for replay across config changes.
  // emitterType: 'tool' | 'verifier' | 'gate' | 'systemPrecondition' — the
  //   class of deterministic emitter that produced the route decision.
  // emitterId: stable id of the specific emitter (tool name, verifier name, etc).
  // eventName: canonical UPPER_SNAKE_CASE event name (e.g. 'PLAN_ACCEPTED').
  // category: 'advance' | 'failure' | 'blocked' | 'neutral' — from v2 vocab.
  // evidenceRefs: array of artifact references; each ref is validated by the
  //   SchemaRegistry JSON Schema (byteCount + sha256 required per ref).
  [DomainEventName.ROUTE_EVENT_EMITTED]: [
    'schemaId', 'schemaVersion',
    'configVersion', 'configFingerprint',
    'beadId', 'stateId', 'actionId', 'runId',
    'emitterType', 'emitterId',
    'eventName', 'category',
    'evidenceRefs'
  ],
};
