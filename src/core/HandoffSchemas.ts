/**
 * HandoffSchemas — JSON Schema registrations for statechart/handoff boundaries.
 *
 * PURPOSE (pi-experiment-dsm2.3)
 * ------------------------------
 * Registers named JSON Schemas in the SchemaRegistry for every key handoff
 * boundary in the harness dispatch/receive path:
 *
 *   1. harness.handoff.statusMutatingEvent  — STATE_TRANSITIONED / STATE_FAILED /
 *      STATE_BLOCKED / CONTEXT_RESTART / HARNESS_RESTART payloads (CRITICAL replay).
 *
 *   2. harness.handoff.checkpointAcceptedEvent — CHECKPOINT_ACCEPTED payload
 *      (CRITICAL replay — drives action completion accounting).
 *
 *   3. harness.handoff.terminalTransition — the payload recorded as
 *      STATE_TRANSITION_APPLIED when advancing to a terminal state (CRITICAL).
 *
 *   4. harness.handoff.workerCommand — the envelope used when starting a worker
 *      (BEST_EFFORT; not currently persisted to event log, but traced).
 *
 *   5. harness.handoff.workerCompletion — the completion record after a worker
 *      finishes a state (BEST_EFFORT).
 *
 * FIELD DISTINCTION ANNOTATION
 * -----------------------------
 * Each SchemaRegistryEntry carries two additional metadata arrays (beyond the
 * standard SchemaRegistryEntry interface) that distinguish:
 *
 *   llmAuthoredFields          — narrative fields the model writes (summary,
 *                                evidence, handover). Content is LLM-authored;
 *                                the harness validates only structural type (string)
 *                                and minimum length — NOT semantic content.
 *
 *   deterministicEvidenceFields — fields set by harness machinery (beadId, stateId,
 *                                actionId, transitionEvent, idempotencyKey). Values
 *                                are structurally deterministic, never model-invented.
 *
 * FAIL-CLOSED VALIDATION
 * ----------------------
 * validateHandoffPayload(schemaId, payload, context?) is the shared boundary
 * validator. It returns { valid: true } | { valid: false, diagnostic: ... }.
 *
 * A non-valid result is a DETERMINISTIC BLOCKED transition signal — the caller
 * must NOT advance state, satisfy required tools, close gates, or emit progress
 * events. The diagnostic carries structured fields for observability.
 *
 * IMPORTANT: This module only REGISTERS schemas and exposes the validator helper.
 * It does NOT touch model-facing tool output or domain-event semantics.
 */

import { schemaRegistry, type SchemaRegistryEntry } from './SchemaRegistry.js';
import type { ValidateFunction } from 'ajv';

// ---------------------------------------------------------------------------
// Stable schema ids for the handoff boundary contracts
// ---------------------------------------------------------------------------

/** Stable schema ids for the handoff/statechart boundary contracts (dsm2.3). */
export const HandoffSchemaId = {
  STATUS_MUTATING_EVENT:     'harness.handoff.statusMutatingEvent',
  CHECKPOINT_ACCEPTED_EVENT: 'harness.handoff.checkpointAcceptedEvent',
  TERMINAL_TRANSITION:       'harness.handoff.terminalTransition',
  WORKER_COMMAND:            'harness.handoff.workerCommand',
  WORKER_COMPLETION:         'harness.handoff.workerCompletion',
  /** pi-experiment-6q0y.40: fan-out branch result payload (per-branch outcome + evidence). */
  FANOUT_BRANCH_RESULT:      'harness.fanout.branchResult',
  /** pi-experiment-6q0y.40: joined outcome after all fan-out branches complete. */
  FANOUT_JOINED_OUTCOME:     'harness.fanout.joinedOutcome',
  /**
   * pi-experiment-6q0y.36: evidence-aware restart handoff contract.
   *
   * Registered for every CONTEXT_RESTART_REQUESTED / HARNESS_RESTART_REQUESTED
   * handoff. Validates that a restart carries deterministic evidenceRefs plus
   * either a handoverArtifactPath or a configured compaction-artifact pointer.
   * Summary-only restarts (no evidenceRefs, no artifact) FAIL this schema.
   */
  RESTART_HANDOFF_CONTRACT:  'harness.restart.handoffContract'
} as const;

export type HandoffSchemaId = typeof HandoffSchemaId[keyof typeof HandoffSchemaId];

// ---------------------------------------------------------------------------
// Handoff diagnostic type
// ---------------------------------------------------------------------------

/**
 * Structured validation failure diagnostic emitted at every handoff boundary.
 *
 * Fields map directly to AC4 acceptance criteria:
 *   beadId      — the bead being processed (from context or payload).
 *   stateId     — the state at the handoff boundary.
 *   actionId    — the action within the state.
 *   runId       — optional run/session identifier from context.
 *   schemaId    — the registry id of the schema that rejected the payload.
 *   failurePath — human-readable array of AJV error paths/messages.
 */
export interface HandoffValidationDiagnostic {
  beadId?: string;
  stateId?: string;
  actionId?: string;
  runId?: string;
  schemaId: string;
  failurePath: string[];
}

/** Context fields supplied by the call site (extends the diagnostic with identity). */
export interface HandoffValidationContext {
  beadId?: string;
  stateId?: string;
  actionId?: string;
  runId?: string;
}

export type HandoffValidationResult =
  | { valid: true }
  | { valid: false; diagnostic: HandoffValidationDiagnostic };

// ---------------------------------------------------------------------------
// Extended schema entry type (adds field-distinction metadata)
// ---------------------------------------------------------------------------

/**
 * Extended schema entry with field-distinction annotations.
 * These are passed as extra properties alongside the standard SchemaRegistryEntry
 * fields. The registry stores them as part of the entry's shape.
 */
interface AnnotatedHandoffEntry extends SchemaRegistryEntry {
  /** Fields authored by the LLM model (structural type-check only; never semantic). */
  readonly llmAuthoredFields?: readonly string[];
  /** Fields set deterministically by harness machinery (never model-invented). */
  readonly deterministicEvidenceFields?: readonly string[];
}

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

/**
 * 1. harness.handoff.statusMutatingEvent
 *
 * The payload shape for status-mutating teammate events:
 *   STATE_TRANSITIONED, STATE_FAILED, STATE_BLOCKED,
 *   CONTEXT_RESTART_REQUESTED, HARNESS_RESTART_REQUESTED.
 *
 * LLM-authored fields:   summary, evidence, handover
 * Deterministic fields:  beadId, stateId, actionId, transitionEvent,
 *                        workerId, idempotencyKey, timestamp
 */
const statusMutatingEventEntry: AnnotatedHandoffEntry = {
  id: HandoffSchemaId.STATUS_MUTATING_EVENT,
  version: '1.0.0',
  owner: 'src/core/TeammateEvents.ts',
  replayPolicy: 'CRITICAL',
  compatibilityPolicy: 'ADDITIVE_ONLY',
  llmAuthoredFields: ['summary', 'evidence', 'handover'],
  deterministicEvidenceFields: [
    'beadId', 'stateId', 'actionId', 'transitionEvent',
    'workerId', 'idempotencyKey', 'timestamp', 'type'
  ],
  jsonSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: [
      'type', 'beadId', 'workerId', 'stateId',
      'timestamp', 'idempotencyKey',
      'actionId', 'transitionEvent', 'summary', 'evidence', 'handover'
    ],
    additionalProperties: true,
    properties: {
      type:            { type: 'string', minLength: 1 },
      beadId:          { type: 'string', minLength: 1 },
      workerId:        { type: 'string', minLength: 1 },
      stateId:         { type: 'string', minLength: 1 },
      timestamp:       { type: 'number' },
      idempotencyKey:  { type: 'string', minLength: 1 },
      sessionStateId:  { type: 'string' },
      actionId:        { type: 'string', minLength: 1 },
      transitionEvent: { type: 'string', minLength: 1 },
      // LLM-authored: structural type only — not semantic.
      summary:         { type: 'string', minLength: 1 },
      evidence:        { type: 'string', minLength: 1 },
      handover:        { type: 'string', minLength: 1 }
    }
  },
  positiveFixtures: [
    {
      label: 'well-formed STATE_TRANSITIONED payload',
      value: {
        type: 'STATE_TRANSITIONED',
        beadId: 'pi-experiment-test',
        workerId: 'worker-1',
        stateId: 'Planning',
        timestamp: 1_779_000_000_000,
        idempotencyKey: 'STATE_TRANSITIONED-pi-experiment-test-worker-1-session-Planning-formulate-plan-SUCCESS',
        actionId: 'formulate-plan',
        transitionEvent: 'SUCCESS',
        summary: 'All tasks complete.',
        evidence: 'submit_checkpoint evidence.',
        handover: 'Handover to next phase.'
      }
    },
    {
      label: 'STATE_FAILED payload',
      value: {
        type: 'STATE_FAILED',
        beadId: 'pi-experiment-test',
        workerId: 'worker-1',
        stateId: 'Planning',
        timestamp: 1_779_000_000_001,
        idempotencyKey: 'STATE_FAILED-pi-experiment-test-worker-1-session-Planning-formulate-plan-FAILURE',
        actionId: 'formulate-plan',
        transitionEvent: 'FAILURE',
        summary: 'Could not complete.',
        evidence: 'Error logs attached.',
        handover: 'Failed handover.'
      }
    },
    {
      label: 'STATE_TRANSITIONED with optional sessionStateId',
      value: {
        type: 'STATE_TRANSITIONED',
        beadId: 'pi-experiment-test',
        workerId: 'worker-2',
        stateId: 'Implementation',
        sessionStateId: 'session-abc',
        timestamp: 1_779_000_000_002,
        idempotencyKey: 'STATE_TRANSITIONED-pi-experiment-test-worker-2-session-abc-Implementation-impl-SUCCESS',
        actionId: 'implement',
        transitionEvent: 'SUCCESS',
        summary: 'Implementation done.',
        evidence: 'All tests pass.',
        handover: 'Code is in branch feature/x.'
      }
    }
  ],
  negativeFixtures: [
    {
      label: 'missing required beadId',
      value: {
        type: 'STATE_TRANSITIONED',
        workerId: 'worker-1',
        stateId: 'Planning',
        timestamp: 1_779_000_000_000,
        idempotencyKey: 'key',
        actionId: 'formulate-plan',
        transitionEvent: 'SUCCESS',
        summary: 'done',
        evidence: 'ev',
        handover: 'ho'
      }
    },
    {
      label: 'missing required actionId (missing state identity)',
      value: {
        type: 'STATE_TRANSITIONED',
        beadId: 'pi-experiment-test',
        workerId: 'worker-1',
        stateId: 'Planning',
        timestamp: 1_779_000_000_000,
        idempotencyKey: 'key',
        transitionEvent: 'SUCCESS',
        summary: 'done',
        evidence: 'ev',
        handover: 'ho'
      }
    },
    {
      label: 'non-string summary (forged progress claim)',
      value: {
        type: 'STATE_TRANSITIONED',
        beadId: 'pi-experiment-test',
        workerId: 'worker-1',
        stateId: 'Planning',
        timestamp: 1_779_000_000_000,
        idempotencyKey: 'key',
        actionId: 'formulate-plan',
        transitionEvent: 'SUCCESS',
        summary: { injected: true },
        evidence: 'ev',
        handover: 'ho'
      }
    },
    {
      label: 'non-number timestamp',
      value: {
        type: 'STATE_TRANSITIONED',
        beadId: 'pi-experiment-test',
        workerId: 'worker-1',
        stateId: 'Planning',
        timestamp: 'not-a-number',
        idempotencyKey: 'key',
        actionId: 'formulate-plan',
        transitionEvent: 'SUCCESS',
        summary: 'done',
        evidence: 'ev',
        handover: 'ho'
      }
    },
    {
      label: 'missing handover',
      value: {
        type: 'STATE_TRANSITIONED',
        beadId: 'pi-experiment-test',
        workerId: 'worker-1',
        stateId: 'Planning',
        timestamp: 1_779_000_000_000,
        idempotencyKey: 'key',
        actionId: 'formulate-plan',
        transitionEvent: 'SUCCESS',
        summary: 'done',
        evidence: 'ev'
      }
    }
  ]
};

/**
 * 2. harness.handoff.checkpointAcceptedEvent
 *
 * The payload for CHECKPOINT_ACCEPTED signals. actionId is deterministic
 * (set by the harness completion protocol); no LLM-authored content.
 */
const checkpointAcceptedEventEntry: AnnotatedHandoffEntry = {
  id: HandoffSchemaId.CHECKPOINT_ACCEPTED_EVENT,
  version: '1.0.0',
  owner: 'src/core/TeammateEvents.ts',
  replayPolicy: 'CRITICAL',
  compatibilityPolicy: 'ADDITIVE_ONLY',
  llmAuthoredFields: [],
  deterministicEvidenceFields: [
    'type', 'beadId', 'workerId', 'stateId', 'timestamp',
    'idempotencyKey', 'actionId'
  ],
  jsonSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['type', 'beadId', 'workerId', 'stateId', 'timestamp', 'idempotencyKey', 'actionId'],
    additionalProperties: true,
    properties: {
      type:           { type: 'string', minLength: 1 },
      beadId:         { type: 'string', minLength: 1 },
      workerId:       { type: 'string', minLength: 1 },
      stateId:        { type: 'string', minLength: 1 },
      timestamp:      { type: 'number' },
      idempotencyKey: { type: 'string', minLength: 1 },
      actionId:       { type: 'string', minLength: 1 },
      sessionStateId: { type: 'string' }
    }
  },
  positiveFixtures: [
    {
      label: 'minimal CHECKPOINT_ACCEPTED payload',
      value: {
        type: 'CHECKPOINT_ACCEPTED',
        beadId: 'pi-experiment-test',
        workerId: 'worker-1',
        stateId: 'Planning',
        timestamp: 1_779_000_000_000,
        idempotencyKey: 'CHECKPOINT_ACCEPTED-pi-experiment-test-worker-1-session-Planning-formulate-plan',
        actionId: 'formulate-plan'
      }
    }
  ],
  negativeFixtures: [
    {
      label: 'missing required actionId (missing action identity)',
      value: {
        type: 'CHECKPOINT_ACCEPTED',
        beadId: 'pi-experiment-test',
        workerId: 'worker-1',
        stateId: 'Planning',
        timestamp: 1_779_000_000_000,
        idempotencyKey: 'key'
      }
    },
    {
      label: 'missing beadId',
      value: {
        type: 'CHECKPOINT_ACCEPTED',
        workerId: 'worker-1',
        stateId: 'Planning',
        timestamp: 1_779_000_000_000,
        idempotencyKey: 'key',
        actionId: 'formulate-plan'
      }
    }
  ]
};

/**
 * 3. harness.handoff.terminalTransition
 *
 * The payload recorded as STATE_TRANSITION_APPLIED when the transition
 * targets a terminal state. All fields are deterministic — no LLM-authored content.
 */
const terminalTransitionEntry: AnnotatedHandoffEntry = {
  id: HandoffSchemaId.TERMINAL_TRANSITION,
  version: '1.0.0',
  owner: 'src/extension.ts',
  replayPolicy: 'CRITICAL',
  compatibilityPolicy: 'ADDITIVE_ONLY',
  llmAuthoredFields: [],
  deterministicEvidenceFields: [
    'beadId', 'fromState', 'nextState', 'transitionEvent',
    'workerId', 'idempotencyKey'
  ],
  jsonSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['beadId', 'fromState', 'nextState', 'transitionEvent', 'workerId', 'idempotencyKey'],
    additionalProperties: true,
    properties: {
      beadId:          { type: 'string', minLength: 1 },
      fromState:       { type: 'string', minLength: 1 },
      nextState:       { type: 'string', minLength: 1 },
      transitionEvent: { type: 'string', minLength: 1 },
      workerId:        { type: 'string', minLength: 1 },
      idempotencyKey:  { type: 'string', minLength: 1 },
      sessionStateId:  { type: 'string' },
      actionId:        { type: 'string' },
      actionKey:       { type: 'string' },
      summary:         { type: 'string' },
      evidence:        { type: 'string' },
      handover:        { type: 'string' }
    }
  },
  positiveFixtures: [
    {
      label: 'minimal terminal transition payload',
      value: {
        beadId: 'pi-experiment-test',
        fromState: 'Verification',
        nextState: 'completed',
        transitionEvent: 'SUCCESS',
        workerId: 'worker-1',
        idempotencyKey: 'term-key-1'
      }
    },
    {
      label: 'terminal transition with optional actionId and summary',
      value: {
        beadId: 'pi-experiment-test',
        fromState: 'Verification',
        nextState: 'completed',
        transitionEvent: 'SUCCESS',
        workerId: 'worker-1',
        idempotencyKey: 'term-key-2',
        actionId: 'verify',
        summary: 'All verification passed.'
      }
    }
  ],
  negativeFixtures: [
    {
      label: 'missing nextState (invalid terminal outcome)',
      value: {
        beadId: 'pi-experiment-test',
        fromState: 'Verification',
        transitionEvent: 'SUCCESS',
        workerId: 'worker-1',
        idempotencyKey: 'term-key-1'
      }
    },
    {
      label: 'missing transitionEvent',
      value: {
        beadId: 'pi-experiment-test',
        fromState: 'Verification',
        nextState: 'completed',
        workerId: 'worker-1',
        idempotencyKey: 'term-key-1'
      }
    },
    {
      label: 'missing beadId',
      value: {
        fromState: 'Verification',
        nextState: 'completed',
        transitionEvent: 'SUCCESS',
        workerId: 'worker-1',
        idempotencyKey: 'term-key-1'
      }
    }
  ]
};

/**
 * 4. harness.handoff.workerCommand
 *
 * The envelope carried when the coordinator dispatches a worker command
 * (starting a worker for a given bead/state/action). All fields are
 * deterministic — set by coordinator machinery.
 */
const workerCommandEntry: AnnotatedHandoffEntry = {
  id: HandoffSchemaId.WORKER_COMMAND,
  version: '1.0.0',
  owner: 'src/core/Teammate.ts',
  replayPolicy: 'BEST_EFFORT',
  compatibilityPolicy: 'ADDITIVE_ONLY',
  llmAuthoredFields: [],
  deterministicEvidenceFields: ['beadId', 'stateId', 'actionId', 'workerId'],
  jsonSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['beadId', 'stateId'],
    additionalProperties: true,
    properties: {
      beadId:   { type: 'string', minLength: 1 },
      stateId:  { type: 'string', minLength: 1 },
      actionId: { type: 'string' },
      workerId: { type: 'string' }
    }
  },
  positiveFixtures: [
    {
      label: 'minimal worker command (beadId + stateId)',
      value: { beadId: 'pi-experiment-test', stateId: 'Planning' }
    },
    {
      label: 'worker command with actionId and workerId',
      value: {
        beadId: 'pi-experiment-test',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        workerId: 'worker-1'
      }
    }
  ],
  negativeFixtures: [
    {
      label: 'missing beadId',
      value: { stateId: 'Planning', actionId: 'formulate-plan' }
    },
    {
      label: 'missing stateId',
      value: { beadId: 'pi-experiment-test', actionId: 'formulate-plan' }
    }
  ]
};

/**
 * 5. harness.handoff.workerCompletion
 *
 * The completion record after a worker finishes a state. The outcome field
 * is required and must be a string (validated structurally). Workers set
 * this deterministically from the configured outcome vocabulary.
 */
const workerCompletionEntry: AnnotatedHandoffEntry = {
  id: HandoffSchemaId.WORKER_COMPLETION,
  version: '1.0.0',
  owner: 'src/extension/SignalController.ts',
  replayPolicy: 'BEST_EFFORT',
  compatibilityPolicy: 'ADDITIVE_ONLY',
  llmAuthoredFields: [],
  deterministicEvidenceFields: ['beadId', 'stateId', 'actionId', 'workerId', 'outcome'],
  jsonSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['beadId', 'stateId', 'outcome'],
    additionalProperties: true,
    properties: {
      beadId:   { type: 'string', minLength: 1 },
      stateId:  { type: 'string', minLength: 1 },
      actionId: { type: 'string' },
      workerId: { type: 'string' },
      outcome:  { type: 'string', minLength: 1 }
    }
  },
  positiveFixtures: [
    {
      label: 'minimal worker completion',
      value: { beadId: 'pi-experiment-test', stateId: 'Planning', outcome: 'SUCCESS' }
    },
    {
      label: 'worker completion with all fields',
      value: {
        beadId: 'pi-experiment-test',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        workerId: 'worker-1',
        outcome: 'FAILURE'
      }
    }
  ],
  negativeFixtures: [
    {
      label: 'missing outcome (forged progress claim)',
      value: { beadId: 'pi-experiment-test', stateId: 'Planning', workerId: 'worker-1' }
    },
    {
      label: 'non-string outcome',
      value: { beadId: 'pi-experiment-test', stateId: 'Planning', outcome: 42 }
    },
    {
      label: 'missing beadId',
      value: { stateId: 'Planning', outcome: 'SUCCESS' }
    }
  ]
};

// ---------------------------------------------------------------------------
// pi-experiment-6q0y.40: Fan-out branch schemas
//
// These schemas define the data contracts for parallel (fan-out) branch
// execution in the harness statechart:
//
//   harness.fanout.branchResult   — per-branch outcome record produced when a
//                                   fan-out branch completes (AC1).
//   harness.fanout.joinedOutcome  — the joined outcome payload assembled after
//                                   all branches complete (AC2).
//
// PRODUCER SCOPE (6q0y.40)
// -------------------------
// This bead defines + registers the schemas and the deterministic `collect`
// reducer.  The verifier-verdict-consumption join (AC1 "join rejects branches
// whose verifier verdict ...") is DEFERRED to the amq0 consumer chain
// (yhec/zog2.4/zog2.11) and MUST NOT be faked here.
// ---------------------------------------------------------------------------

/**
 * Declared vocabulary for branch status in a fan-out branch result.
 * A BranchStatus outside this set is rejected by the join validator (AC3).
 */
export const BRANCH_STATUS_VOCAB = ['succeeded', 'failed', 'blocked', 'cancelled'] as const;
export type BranchStatus = typeof BRANCH_STATUS_VOCAB[number];

/**
 * Declared vocabulary for branch outcomes in a fan-out branch result.
 * 'SUCCESS' and 'FAILURE' are the canonical statechart transition events;
 * 'BLOCKED' and 'CANCELLED' are additional terminal conditions.
 */
export const BRANCH_OUTCOME_VOCAB = ['SUCCESS', 'FAILURE', 'BLOCKED', 'CANCELLED'] as const;
export type BranchOutcome = typeof BRANCH_OUTCOME_VOCAB[number];

/** Outcome-precedence table: when multiple branches end in different outcomes,
 *  the joined route is selected by the highest-precedence outcome present.
 *  Lower index = higher precedence (BLOCKED > FAILURE > CANCELLED > SUCCESS). */
export const OUTCOME_PRECEDENCE: readonly BranchOutcome[] = ['BLOCKED', 'FAILURE', 'CANCELLED', 'SUCCESS'];

/**
 * A typed reference to an artifact produced by a fan-out branch.
 * This is the evidence contract: branches MUST NOT rely on summary prose.
 */
export interface BranchArtifactRef {
  /** Semantic path declared in the harness plan (e.g. "implementation/src/foo.ts"). */
  semanticPath: string;
  /** Size of the artifact in bytes (required for evidence accounting). */
  bytes: number;
  /** SHA-256 hex digest of the artifact content (required for integrity checks). */
  sha256: string;
}

/**
 * A per-branch result produced when a fan-out branch completes.
 * All fields are deterministic (set by branch machinery); the optional `summary`
 * field is explicitly non-authoritative — the join reads typed fields only (AC4).
 */
export interface FanoutBranchResult {
  /** Stable identifier for this branch within the fan-out set (e.g. "branch-tests"). */
  branchId: string;
  /** The statechart state ID this branch was executing. */
  stateId: string;
  /** The action ID within the state. */
  actionId: string;
  /** Context instance ID (worker/session scope, for replay deduplication). */
  contextInstanceId: string;
  /** Outcome from the declared vocabulary (SUCCESS/FAILURE/BLOCKED/CANCELLED). */
  outcome: BranchOutcome;
  /** Branch completion status from the declared vocabulary. */
  branchStatus: BranchStatus;
  /** Artifact evidence references produced by this branch. */
  artifactRefs: BranchArtifactRef[];
  /**
   * Non-authoritative narrative summary (LLM-authored).
   * The join MUST NOT use this to make routing decisions; it reads
   * typed outcome/evidence fields only (AC4).
   */
  summary?: string;
  /** Optional: error details if the branch failed/was blocked. */
  errorDetail?: string;
}

/**
 * The joined outcome payload assembled after all fan-out branches complete.
 * Produced by the deterministic `collect` reducer (AC5).
 */
export interface FanoutJoinedOutcome {
  /** All branch results, in sorted branch order. */
  branches: FanoutBranchResult[];
  /** The selected transition event (from OUTCOME_PRECEDENCE table) (AC6). */
  selectedRoute: BranchOutcome;
  /** All branch errors collected in sorted branch order (AC6). */
  collectedErrors: Array<{ branchId: string; outcome: BranchOutcome; errorDetail?: string }>;
  /** Number of branches that succeeded. */
  succeededCount: number;
  /** Number of branches that failed or were blocked or cancelled. */
  failedCount: number;
}

// ---------------------------------------------------------------------------
// Fan-out branch result schema entry (harness.fanout.branchResult)
// ---------------------------------------------------------------------------

const fanoutBranchResultEntry: AnnotatedHandoffEntry = {
  id: HandoffSchemaId.FANOUT_BRANCH_RESULT,
  version: '1.0.0',
  owner: 'src/core/HandoffSchemas.ts',
  replayPolicy: 'CRITICAL',
  compatibilityPolicy: 'ADDITIVE_ONLY',
  llmAuthoredFields: ['summary'],
  deterministicEvidenceFields: [
    'branchId', 'stateId', 'actionId', 'contextInstanceId',
    'outcome', 'branchStatus', 'artifactRefs'
  ],
  jsonSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['branchId', 'stateId', 'actionId', 'contextInstanceId', 'outcome', 'branchStatus', 'artifactRefs'],
    additionalProperties: true,
    properties: {
      branchId:          { type: 'string', minLength: 1 },
      stateId:           { type: 'string', minLength: 1 },
      actionId:          { type: 'string', minLength: 1 },
      contextInstanceId: { type: 'string', minLength: 1 },
      outcome: {
        type: 'string',
        enum: [...BRANCH_OUTCOME_VOCAB]
      },
      branchStatus: {
        type: 'string',
        enum: [...BRANCH_STATUS_VOCAB]
      },
      artifactRefs: {
        type: 'array',
        items: {
          type: 'object',
          required: ['semanticPath', 'bytes', 'sha256'],
          additionalProperties: false,
          properties: {
            semanticPath: { type: 'string', minLength: 1 },
            bytes:        { type: 'integer', minimum: 0 },
            sha256:       { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-f]{64}$' }
          }
        }
      },
      // Non-authoritative narrative (AC4): structural string check only.
      summary:     { type: 'string' },
      errorDetail: { type: 'string' }
    }
  },
  positiveFixtures: [
    {
      label: 'successful branch with one artifact',
      value: {
        branchId: 'branch-tests',
        stateId: 'PostImplementation',
        actionId: 'run-tests',
        contextInstanceId: 'ctx-1',
        outcome: 'SUCCESS',
        branchStatus: 'succeeded',
        artifactRefs: [
          {
            semanticPath: 'implementation/src/foo.ts',
            bytes: 1024,
            sha256: 'a'.repeat(64)
          }
        ]
      }
    },
    {
      label: 'failed branch with error detail and no artifacts',
      value: {
        branchId: 'branch-review',
        stateId: 'PostImplementation',
        actionId: 'code-review',
        contextInstanceId: 'ctx-2',
        outcome: 'FAILURE',
        branchStatus: 'failed',
        artifactRefs: [],
        errorDetail: 'Review found blocking issues'
      }
    },
    {
      label: 'blocked branch with non-authoritative summary',
      value: {
        branchId: 'branch-audit',
        stateId: 'PostImplementation',
        actionId: 'test-audit',
        contextInstanceId: 'ctx-3',
        outcome: 'BLOCKED',
        branchStatus: 'blocked',
        artifactRefs: [],
        summary: 'Audit could not proceed due to missing dependency'
      }
    }
  ],
  negativeFixtures: [
    {
      label: 'missing required branchId',
      value: {
        stateId: 'PostImplementation',
        actionId: 'run-tests',
        contextInstanceId: 'ctx-1',
        outcome: 'SUCCESS',
        branchStatus: 'succeeded',
        artifactRefs: []
      }
    },
    {
      label: 'outcome outside declared vocabulary',
      value: {
        branchId: 'branch-tests',
        stateId: 'PostImplementation',
        actionId: 'run-tests',
        contextInstanceId: 'ctx-1',
        outcome: 'DONE',
        branchStatus: 'succeeded',
        artifactRefs: []
      }
    },
    {
      label: 'branchStatus outside declared vocabulary',
      value: {
        branchId: 'branch-tests',
        stateId: 'PostImplementation',
        actionId: 'run-tests',
        contextInstanceId: 'ctx-1',
        outcome: 'SUCCESS',
        branchStatus: 'completed',
        artifactRefs: []
      }
    },
    {
      label: 'artifactRef missing sha256',
      value: {
        branchId: 'branch-tests',
        stateId: 'PostImplementation',
        actionId: 'run-tests',
        contextInstanceId: 'ctx-1',
        outcome: 'SUCCESS',
        branchStatus: 'succeeded',
        artifactRefs: [
          { semanticPath: 'src/foo.ts', bytes: 100 }
        ]
      }
    },
    {
      label: 'artifactRef sha256 wrong length (not 64 hex chars)',
      value: {
        branchId: 'branch-tests',
        stateId: 'PostImplementation',
        actionId: 'run-tests',
        contextInstanceId: 'ctx-1',
        outcome: 'SUCCESS',
        branchStatus: 'succeeded',
        artifactRefs: [
          { semanticPath: 'src/foo.ts', bytes: 100, sha256: 'abc123' }
        ]
      }
    }
  ]
};

// ---------------------------------------------------------------------------
// Fan-out joined outcome schema entry (harness.fanout.joinedOutcome)
// ---------------------------------------------------------------------------

const fanoutJoinedOutcomeEntry: AnnotatedHandoffEntry = {
  id: HandoffSchemaId.FANOUT_JOINED_OUTCOME,
  version: '1.0.0',
  owner: 'src/core/HandoffSchemas.ts',
  replayPolicy: 'CRITICAL',
  compatibilityPolicy: 'ADDITIVE_ONLY',
  llmAuthoredFields: [],
  deterministicEvidenceFields: [
    'branches', 'selectedRoute', 'collectedErrors',
    'succeededCount', 'failedCount'
  ],
  jsonSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['branches', 'selectedRoute', 'collectedErrors', 'succeededCount', 'failedCount'],
    additionalProperties: true,
    properties: {
      branches: {
        type: 'array',
        items: {
          type: 'object',
          required: ['branchId', 'stateId', 'actionId', 'contextInstanceId', 'outcome', 'branchStatus', 'artifactRefs'],
          additionalProperties: true,
          properties: {
            branchId:          { type: 'string', minLength: 1 },
            stateId:           { type: 'string', minLength: 1 },
            actionId:          { type: 'string', minLength: 1 },
            contextInstanceId: { type: 'string', minLength: 1 },
            outcome:           { type: 'string', enum: [...BRANCH_OUTCOME_VOCAB] },
            branchStatus:      { type: 'string', enum: [...BRANCH_STATUS_VOCAB] },
            artifactRefs: {
              type: 'array',
              items: {
                type: 'object',
                required: ['semanticPath', 'bytes', 'sha256'],
                additionalProperties: false,
                properties: {
                  semanticPath: { type: 'string', minLength: 1 },
                  bytes:        { type: 'integer', minimum: 0 },
                  sha256:       { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-f]{64}$' }
                }
              }
            },
            summary:     { type: 'string' },
            errorDetail: { type: 'string' }
          }
        }
      },
      selectedRoute: {
        type: 'string',
        enum: [...BRANCH_OUTCOME_VOCAB]
      },
      collectedErrors: {
        type: 'array',
        items: {
          type: 'object',
          required: ['branchId', 'outcome'],
          additionalProperties: false,
          properties: {
            branchId:    { type: 'string', minLength: 1 },
            outcome:     { type: 'string', enum: [...BRANCH_OUTCOME_VOCAB] },
            errorDetail: { type: 'string' }
          }
        }
      },
      succeededCount: { type: 'integer', minimum: 0 },
      failedCount:    { type: 'integer', minimum: 0 }
    }
  },
  positiveFixtures: [
    {
      label: 'all-success join (two branches, zero errors)',
      value: {
        branches: [
          {
            branchId: 'branch-tests',
            stateId: 'PostImplementation',
            actionId: 'run-tests',
            contextInstanceId: 'ctx-1',
            outcome: 'SUCCESS',
            branchStatus: 'succeeded',
            artifactRefs: []
          },
          {
            branchId: 'branch-review',
            stateId: 'PostImplementation',
            actionId: 'code-review',
            contextInstanceId: 'ctx-2',
            outcome: 'SUCCESS',
            branchStatus: 'succeeded',
            artifactRefs: []
          }
        ],
        selectedRoute: 'SUCCESS',
        collectedErrors: [],
        succeededCount: 2,
        failedCount: 0
      }
    },
    {
      label: 'multi-error join (one success, one failure)',
      value: {
        branches: [
          {
            branchId: 'branch-tests',
            stateId: 'PostImplementation',
            actionId: 'run-tests',
            contextInstanceId: 'ctx-1',
            outcome: 'SUCCESS',
            branchStatus: 'succeeded',
            artifactRefs: []
          },
          {
            branchId: 'branch-review',
            stateId: 'PostImplementation',
            actionId: 'code-review',
            contextInstanceId: 'ctx-2',
            outcome: 'FAILURE',
            branchStatus: 'failed',
            artifactRefs: [],
            errorDetail: 'Blocking review findings'
          }
        ],
        selectedRoute: 'FAILURE',
        collectedErrors: [
          { branchId: 'branch-review', outcome: 'FAILURE', errorDetail: 'Blocking review findings' }
        ],
        succeededCount: 1,
        failedCount: 1
      }
    }
  ],
  negativeFixtures: [
    {
      label: 'missing required branches array',
      value: {
        selectedRoute: 'SUCCESS',
        collectedErrors: [],
        succeededCount: 0,
        failedCount: 0
      }
    },
    {
      label: 'selectedRoute outside declared vocabulary',
      value: {
        branches: [],
        selectedRoute: 'DONE',
        collectedErrors: [],
        succeededCount: 0,
        failedCount: 0
      }
    },
    {
      label: 'negative succeededCount',
      value: {
        branches: [],
        selectedRoute: 'SUCCESS',
        collectedErrors: [],
        succeededCount: -1,
        failedCount: 0
      }
    },
    {
      label: 'collectedErrors entry missing required branchId',
      value: {
        branches: [],
        selectedRoute: 'FAILURE',
        collectedErrors: [{ outcome: 'FAILURE' }],
        succeededCount: 0,
        failedCount: 1
      }
    }
  ]
};

// ---------------------------------------------------------------------------
// pi-experiment-6q0y.36: Evidence-aware restart handoff contract
//
// harness.restart.handoffContract — registered for every CONTEXT_RESTART_REQUESTED
// / HARNESS_RESTART_REQUESTED boundary. Validates that a restart carries
// deterministic evidenceRefs[] plus either a handoverArtifactPath (with bytes +
// sha256) OR a configured compaction-artifact pointer.
//
// Summary-only restarts (no evidenceRefs, no artifact ref) FAIL this schema
// and are rejected BEFORE signal/event admission (AC1/AC3).
//
// FIELD DISTINCTION:
//   evidenceRefs[]          — deterministic evidence (authoritative)
//   handoverArtifactPath    — explicit artifact path (with bytes+sha256)
//   narrativeSummary        — non-authoritative preview (never used for progress)
//   narrativeNonAuthoritative — always true when narrative is present
// ---------------------------------------------------------------------------

const restartHandoffContractEntry: AnnotatedHandoffEntry = {
  id: HandoffSchemaId.RESTART_HANDOFF_CONTRACT,
  version: '1.0.0',
  owner: 'src/core/RestartHandoffValidation.ts',
  replayPolicy: 'CRITICAL',
  compatibilityPolicy: 'ADDITIVE_ONLY',
  llmAuthoredFields: ['narrativeSummary', 'narrativeEvidence', 'narrativeHandover'],
  deterministicEvidenceFields: [
    'beadId', 'stateId', 'actionId', 'transitionEvent',
    'restartId', 'targetState', 'evidenceRefs',
    'handoverArtifactPath'
  ],
  jsonSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['beadId', 'stateId', 'transitionEvent', 'restartId', 'targetState', 'evidenceRefs'],
    additionalProperties: true,
    properties: {
      beadId:          { type: 'string', minLength: 1 },
      stateId:         { type: 'string', minLength: 1 },
      transitionEvent: { type: 'string', minLength: 1 },
      restartId:       { type: 'string', minLength: 1 },
      targetState:     { type: 'string', minLength: 1 },
      // evidenceRefs: required array of deterministic artifact refs (AC1/AC2).
      // May be empty when a compactionPointer is present (configured compaction-artifact path).
      // Non-emptiness is enforced semantically by validateRestartHandoffContract,
      // not structurally here (to allow the auto-restart/compaction-pointer path).
      evidenceRefs: {
        type: 'array',
        items: {
          type: 'object',
          required: ['schemaId', 'semanticArtifactPath', 'bytes', 'sha256'],
          additionalProperties: true,
          properties: {
            schemaId:             { type: 'string', minLength: 1 },
            semanticArtifactPath: { type: 'string', minLength: 1 },
            bytes:                { type: 'integer', minimum: 0 },
            sha256:               { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-f]{64}$' },
            sourceEventIds:       { type: 'array', items: { type: 'string' } }
          }
        }
      },
      // handoverArtifactPath: optional explicit artifact path (AC1 path a).
      handoverArtifactPath: { type: 'string', minLength: 1 },
      // narrativeSummary: non-authoritative preview text (AC3/AC4). Structural type only.
      narrativeSummary:         { type: 'string' },
      narrativeEvidence:        { type: 'string' },
      narrativeHandover:        { type: 'string' },
      // narrativeNonAuthoritative: always true when narrative fields are present (AC4).
      narrativeNonAuthoritative: { type: 'boolean', enum: [true] }
    }
  },
  positiveFixtures: [
    {
      label: 'manual handoff with evidenceRefs + handoverArtifactPath',
      value: {
        beadId: 'pi-experiment-6q0y.36',
        stateId: 'Implementation',
        transitionEvent: 'CONTEXT_RESTART',
        restartId: 'a'.repeat(32),
        targetState: 'Implementation',
        evidenceRefs: [
          {
            schemaId: 'harness.handoff.workerCompletion',
            semanticArtifactPath: 'implementation/handoff.json',
            bytes: 1024,
            sha256: 'a'.repeat(64),
            sourceEventIds: []
          }
        ],
        handoverArtifactPath: 'implementation/handoff.json',
        narrativeSummary: 'Context overflow — restarting with evidence.',
        narrativeNonAuthoritative: true
      }
    },
    {
      label: 'configured compaction-artifact handoff (no explicit handoverArtifactPath)',
      value: {
        beadId: 'pi-experiment-6q0y.36',
        stateId: 'Implementation',
        transitionEvent: 'CONTEXT_RESTART',
        restartId: 'b'.repeat(32),
        targetState: 'Implementation',
        evidenceRefs: [
          {
            schemaId: 'harness.handoff.workerCompletion',
            semanticArtifactPath: '.pi/artifacts/pi-experiment-6q0y.36/compaction-summary.json',
            bytes: 2048,
            sha256: 'b'.repeat(64),
            sourceEventIds: ['evt-abc']
          }
        ]
      }
    }
  ],
  negativeFixtures: [
    {
      // Note: summary-only (evidenceRefs: []) is SEMANTICALLY rejected by
      // validateRestartHandoffContract, not STRUCTURALLY by this JSON schema.
      // The JSON schema only enforces structural type constraints on evidenceRefs items.
      // This fixture tests structural failure: evidenceRefs not an array.
      label: 'evidenceRefs must be an array (not a string)',
      value: {
        beadId: 'pi-experiment-6q0y.36',
        stateId: 'Implementation',
        transitionEvent: 'CONTEXT_RESTART',
        restartId: 'c'.repeat(32),
        targetState: 'Implementation',
        evidenceRefs: 'not-an-array'
      }
    },
    {
      label: 'evidenceRef missing sha256 (bad-hash)',
      value: {
        beadId: 'pi-experiment-6q0y.36',
        stateId: 'Implementation',
        transitionEvent: 'CONTEXT_RESTART',
        restartId: 'd'.repeat(32),
        targetState: 'Implementation',
        evidenceRefs: [
          {
            schemaId: 'harness.handoff.workerCompletion',
            semanticArtifactPath: 'implementation/handoff.json',
            bytes: 1024
          }
        ]
      }
    },
    {
      label: 'evidenceRef sha256 wrong length (not 64 hex chars)',
      value: {
        beadId: 'pi-experiment-6q0y.36',
        stateId: 'Implementation',
        transitionEvent: 'CONTEXT_RESTART',
        restartId: 'e'.repeat(32),
        targetState: 'Implementation',
        evidenceRefs: [
          {
            schemaId: 'harness.handoff.workerCompletion',
            semanticArtifactPath: 'implementation/handoff.json',
            bytes: 1024,
            sha256: 'abc123'
          }
        ]
      }
    },
    {
      label: 'missing beadId',
      value: {
        stateId: 'Implementation',
        transitionEvent: 'CONTEXT_RESTART',
        restartId: 'f'.repeat(32),
        targetState: 'Implementation',
        evidenceRefs: [
          {
            schemaId: 'harness.handoff.workerCompletion',
            semanticArtifactPath: 'implementation/handoff.json',
            bytes: 1024,
            sha256: 'a'.repeat(64)
          }
        ]
      }
    }
  ]
};

// ---------------------------------------------------------------------------
// Anti-drift boundary inventory for handoff schemas (dsm2.3)
//
// Every HandoffSchemaId value MUST be in HANDOFF_BOUNDARY_IDS and registered.
// Conformance tests in tests/handoff_schemas.test.ts enforce this in both
// directions, making silent drift impossible.
// ---------------------------------------------------------------------------

/**
 * The complete set of handoff boundary-contract ids registered by this module.
 * Mirrors REQUIRED_BOUNDARY_IDS in SchemaRegistry.ts but scoped to dsm2.3
 * handoff schemas to avoid circular imports.
 */
export const HANDOFF_BOUNDARY_IDS: ReadonlySet<string> = new Set<string>(
  Object.values(HandoffSchemaId)
);

// ---------------------------------------------------------------------------
// Register all handoff schemas
// ---------------------------------------------------------------------------

schemaRegistry.register(statusMutatingEventEntry);
schemaRegistry.register(checkpointAcceptedEventEntry);
schemaRegistry.register(terminalTransitionEntry);
schemaRegistry.register(workerCommandEntry);
schemaRegistry.register(workerCompletionEntry);
schemaRegistry.register(fanoutBranchResultEntry);
schemaRegistry.register(fanoutJoinedOutcomeEntry);
schemaRegistry.register(restartHandoffContractEntry);

// ---------------------------------------------------------------------------
// validateHandoffPayload — the shared boundary validator
// ---------------------------------------------------------------------------

/**
 * Validate a payload against the named handoff schema (fail-closed).
 *
 * Returns { valid: true } when the payload satisfies the schema.
 * Returns { valid: false, diagnostic } when validation fails.
 *
 * The diagnostic carries structured context (beadId, stateId, actionId, runId,
 * schemaId, failurePath) for observability and triage.
 *
 * FAIL-CLOSED CONTRACT
 * --------------------
 * A non-valid result is a DETERMINISTIC BLOCKED transition signal.
 * Callers MUST NOT:
 *   - advance statechart state
 *   - satisfy required tool gates
 *   - close coordinator gates
 *   - emit progress events
 *
 * @param schemaId The registry id to validate against (must be registered).
 * @param payload  The value to validate.
 * @param context  Optional caller-supplied identity context enriching the diagnostic.
 */
export function validateHandoffPayload(
  schemaId: string,
  payload: unknown,
  context?: HandoffValidationContext
): HandoffValidationResult {
  let validate: ValidateFunction;
  try {
    validate = schemaRegistry.getValidator(schemaId);
  } catch (err) {
    // Schema not registered — fail closed with a registry error path.
    return {
      valid: false,
      diagnostic: {
        ...context,
        schemaId,
        failurePath: [`Schema registry error: ${String(err)}`]
      }
    };
  }

  const isValid = validate(payload);
  if (isValid) return { valid: true };

  // Build human-readable failure paths from AJV errors.
  const errors = validate.errors || [];
  const failurePath = errors.map(e => {
    const fieldPath = e.instancePath ? e.instancePath.replace(/^\//, '') : '';
    const message = e.message || 'validation failed';
    const missing = e.params && 'missingProperty' in e.params
      ? String((e.params as Record<string, unknown>).missingProperty)
      : undefined;
    if (missing) return `${missing}: ${message}`;
    if (fieldPath) return `${fieldPath}: ${message}`;
    return message;
  });

  return {
    valid: false,
    diagnostic: {
      ...context,
      schemaId,
      failurePath: failurePath.length > 0 ? failurePath : ['validation failed (no AJV error details)']
    }
  };
}

// ---------------------------------------------------------------------------
// pi-experiment-6q0y.40: Fan-out branch validation and deterministic reducer
// ---------------------------------------------------------------------------

/**
 * Structured validation error for fan-out branch validation (AC3).
 */
export interface FanoutValidationError {
  /** Category of the validation failure. */
  kind:
    | 'INVALID_SCHEMA'
    | 'DUPLICATE_BRANCH_ID'
    | 'MISSING_ARTIFACT'
    | 'HASH_MISMATCH'
    | 'UNVERIFIABLE_PATH';
  /** Branch ID that caused the error (if applicable). */
  branchId?: string;
  /** Human-readable description. */
  message: string;
}

/**
 * Result of validateFanoutBranches.
 */
export type FanoutValidationResult =
  | { valid: true }
  | { valid: false; errors: FanoutValidationError[] };

/**
 * Validate a set of fan-out branch results before joining (AC3).
 *
 * Rejects:
 *   - Any branch that fails schema validation (INVALID_SCHEMA)
 *   - Duplicate branch IDs (DUPLICATE_BRANCH_ID)
 *   - Branch artifact refs that are missing required fields (MISSING_ARTIFACT)
 *   - Branch artifact sha256 that does not match a provided content map (HASH_MISMATCH)
 *   - Semantic artifact paths that are empty/blank (UNVERIFIABLE_PATH)
 *
 * DEFERRED (amq0 consumer): verifier-verdict-based rejection is NOT implemented
 * here — that requires the amq0 consumer chain (yhec/zog2.4/zog2.11) which is
 * blocked. The schema validates structural shape only; verifier-verdict consumption
 * must be added by the amq0 consumer bead.
 *
 * @param branches   Array of unknown payloads to validate as FanoutBranchResult.
 * @param sha256Map  Optional map from semanticPath → expected sha256. When
 *                   provided, artifact sha256 values are cross-checked against
 *                   the map and HASH_MISMATCH is raised on discrepancy.
 */
export function validateFanoutBranches(
  branches: unknown[],
  sha256Map?: ReadonlyMap<string, string>
): FanoutValidationResult {
  const errors: FanoutValidationError[] = [];
  const seenIds = new Set<string>();
  const branchValidator = schemaRegistry.getValidator(HandoffSchemaId.FANOUT_BRANCH_RESULT);

  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i];

    // 1. Schema validation (INVALID_SCHEMA)
    const schemaValid = branchValidator(branch);
    if (!schemaValid) {
      const branchId = branch && typeof branch === 'object'
        ? String((branch as Record<string, unknown>).branchId ?? `branch[${i}]`)
        : `branch[${i}]`;
      const errPaths = (branchValidator.errors || [])
        .map(e => e.instancePath ? `${e.instancePath}: ${e.message}` : (e.message ?? 'validation failed'))
        .join('; ');
      errors.push({ kind: 'INVALID_SCHEMA', branchId, message: `Schema validation failed: ${errPaths}` });
      continue; // skip further checks for this branch — schema is not trustworthy
    }

    const b = branch as FanoutBranchResult;

    // 2. Duplicate branch IDs (DUPLICATE_BRANCH_ID)
    if (seenIds.has(b.branchId)) {
      errors.push({
        kind: 'DUPLICATE_BRANCH_ID',
        branchId: b.branchId,
        message: `Duplicate branch ID "${b.branchId}"`
      });
    } else {
      seenIds.add(b.branchId);
    }

    // 3. Artifact ref checks
    for (const ref of b.artifactRefs) {
      // UNVERIFIABLE_PATH: empty semantic path
      if (!ref.semanticPath || !ref.semanticPath.trim()) {
        errors.push({
          kind: 'UNVERIFIABLE_PATH',
          branchId: b.branchId,
          message: 'Artifact ref has empty/blank semanticPath (unverifiable)'
        });
      }

      // MISSING_ARTIFACT: zero bytes with a path (artifact declared but absent)
      if (ref.bytes === 0 && ref.semanticPath) {
        errors.push({
          kind: 'MISSING_ARTIFACT',
          branchId: b.branchId,
          message: `Artifact "${ref.semanticPath}" declares 0 bytes — artifact appears missing`
        });
      }

      // HASH_MISMATCH: sha256 does not match provided content map
      if (sha256Map && ref.semanticPath) {
        const expected = sha256Map.get(ref.semanticPath);
        if (expected !== undefined && expected !== ref.sha256) {
          errors.push({
            kind: 'HASH_MISMATCH',
            branchId: b.branchId,
            message: `Artifact "${ref.semanticPath}" sha256 mismatch: expected ${expected}, got ${ref.sha256}`
          });
        }
      }
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true };
}

/**
 * Configuration for the deterministic fan-out reducer.
 * Only `collect` mode is supported in the initial implementation (AC5).
 * Agent/LLM summarization reducers are explicitly rejected (AC5).
 */
export interface FanoutReducerConfig {
  /**
   * The reduction mode.  Only 'collect' is permitted in this implementation.
   * Passing any other value throws FanoutReducerError at runtime.
   */
  mode: 'collect';
}

/** Thrown when reduceFanoutBranches is called with an unsupported mode. */
export class FanoutReducerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FanoutReducerError';
  }
}

/**
 * Deterministically reduce a set of validated fan-out branch results into a
 * FanoutJoinedOutcome (AC5, AC6).
 *
 * Mode: `collect` only (AC5).
 *   - Preserves all branch results in sorted branch order (by branchId).
 *   - Collects all non-SUCCESS outcomes in sorted branch order (AC6).
 *   - Selects the joined route via the OUTCOME_PRECEDENCE table (AC6).
 *   - This is a pure function — no I/O, no randomness, fully replay-equivalent (AC7).
 *
 * DEFERRED: verifier-verdict-based route overrides are NOT implemented here.
 * The amq0 consumer bead must add that gate after the yhec/zog2.4/zog2.11 chain.
 *
 * @param branches  Validated FanoutBranchResult records (must all have passed
 *                  validateFanoutBranches first; this function does NOT re-validate).
 * @param config    Reducer configuration (mode must be 'collect').
 */
export function reduceFanoutBranches(
  branches: readonly FanoutBranchResult[],
  config: FanoutReducerConfig
): FanoutJoinedOutcome {
  if (config.mode !== 'collect') {
    throw new FanoutReducerError(
      `Unsupported reducer mode "${String(config.mode)}". ` +
      `Only "collect" is supported in this implementation. ` +
      `Agent/LLM summarization reducers are explicitly rejected for statechart progress decisions.`
    );
  }

  // Sort branches deterministically by branchId for replay equivalence (AC7).
  const sorted = [...branches].sort((a, b) => a.branchId.localeCompare(b.branchId));

  // Collect all non-SUCCESS branch errors in sorted order (AC6).
  const collectedErrors: FanoutJoinedOutcome['collectedErrors'] = sorted
    .filter(b => b.outcome !== 'SUCCESS')
    .map(b => ({
      branchId: b.branchId,
      outcome: b.outcome,
      ...(b.errorDetail !== undefined ? { errorDetail: b.errorDetail } : {})
    }));

  // Select the joined route via precedence table (AC6).
  // Find the highest-precedence outcome present among all branches.
  const outcomeSet = new Set(sorted.map(b => b.outcome));
  let selectedRoute: BranchOutcome = 'SUCCESS';
  for (const candidate of OUTCOME_PRECEDENCE) {
    if (outcomeSet.has(candidate)) {
      selectedRoute = candidate;
      break;
    }
  }

  const succeededCount = sorted.filter(b => b.outcome === 'SUCCESS').length;
  const failedCount = sorted.length - succeededCount;

  return {
    branches: sorted,
    selectedRoute,
    collectedErrors,
    succeededCount,
    failedCount
  };
}
