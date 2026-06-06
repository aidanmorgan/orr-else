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
  WORKER_COMPLETION:         'harness.handoff.workerCompletion'
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
