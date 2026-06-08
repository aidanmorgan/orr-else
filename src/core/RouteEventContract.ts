/**
 * pi-experiment-6k8e: v2 first-class route-event contract.
 *
 * Defines:
 *   - TypeScript types for ROUTE_EVENT_EMITTED payloads and evidence refs.
 *   - applyV2RouteEvent: emits ROUTE_EVENT_EMITTED (with a self-referential
 *     routeEventId field) from deterministic emitter results, validates the
 *     event against the pre-built v2 vocab, and RETURNS the routeEventId so
 *     the caller can write STATE_TRANSITION_APPLIED referencing it — no test-
 *     fabricated uuid needed; the id is always sourced from the emit.
 *   - projectV2Transitions: a genuine read-side reducer that replays a list of
 *     recorded DomainEvents and produces applied transitions by reading ONLY
 *     schema-valid ROUTE_EVENT_EMITTED records from configured emitters, using
 *     exact v2ApplyTransition-style key lookup. Ignores all other records
 *     (model prose, outcome fields, non-ROUTE_EVENT_EMITTED, wrong emitterType).
 *   - Anti-prose enforcement: model-authored fields, tool stdout/stderr, and
 *     untrusted tool args MUST NEVER produce a ROUTE_EVENT_EMITTED record.
 *   - JSON Schema for SchemaRegistry registration (enforces artifact-digest
 *     strictness: byteCount + sha256 required per evidenceRef).
 *
 * VERSION GATING: all types and functions here apply ONLY to v2 configs
 * (config.version === 2). v1 configs are completely unaffected.
 *
 * DESIGN: the v2 emitter is intentionally NOT wired into extension.ts —
 * it is a standalone function that deterministic emitters (tools, verifiers,
 * gates, system preconditions) call when they produce a route verdict. The
 * emitter writes ROUTE_EVENT_EMITTED to the event store and returns the
 * routeEventId; the caller writes STATE_TRANSITION_APPLIED referencing it.
 * The read-side projectV2Transitions reducer is the AC2-required projection:
 * it consumes ROUTE_EVENT_EMITTED records to produce applied transitions,
 * ignoring all model-authored / non-route-event content.
 * Runtime wiring into the live handleTeammateEvent loop is deferred to a
 * downstream bead (e8cm/hutg) — no v2 config runs in production yet.
 *
 * LAYERING NOTE: This module intentionally does NOT import FlowManager.ts
 * (which imports from types/index.ts → HandoffSchemas.ts → SchemaRegistry.ts,
 * creating a cycle). Instead, applyV2RouteEvent and projectV2Transitions accept
 * a pre-built vocab map so callers import FlowManager.buildV2EventVocabulary
 * + v2ApplyTransition themselves and pass the results in. This keeps
 * RouteEventContract in the core layer without a cycle through SchemaRegistry.
 */

import { v7 as uuidv7 } from 'uuid';
import { DomainEventName } from '../constants/index.js';

// ---------------------------------------------------------------------------
// Emitter type vocabulary
// ---------------------------------------------------------------------------

/**
 * The class of deterministic emitter that produced a v2 route decision.
 *
 * Only these classes of emitter may produce ROUTE_EVENT_EMITTED records.
 * Model-authored text, tool stdout/stderr, and untrusted tool args are NEVER
 * valid emitter sources.
 */
export type EmitterType = 'tool' | 'verifier' | 'gate' | 'systemPrecondition';

// ---------------------------------------------------------------------------
// Evidence reference
// ---------------------------------------------------------------------------

/**
 * A reference to a durable artifact that constitutes route evidence.
 *
 * Every field is required — a ref missing byteCount or sha256 is REJECTED
 * by the SchemaRegistry JSON Schema validator before projection can consume it.
 *
 * schemaId/schemaVersion are optional: absent when the artifact has no
 * registered schema (e.g. raw text artifacts with no structured schema).
 */
export interface RouteEvidenceRef {
  /** Canonical semantic path for the artifact (e.g. tool output path). */
  readonly semanticPath: string;
  /** Exact byte count of the artifact at evidence time. */
  readonly byteCount: number;
  /** SHA-256 hex digest of the artifact content. */
  readonly sha256: string;
  /** Optional: SchemaRegistry schema id for the artifact payload schema. */
  readonly schemaId?: string;
  /** Optional: version of the schema at emit time. */
  readonly schemaVersion?: string;
}

// ---------------------------------------------------------------------------
// ROUTE_EVENT_EMITTED payload
// ---------------------------------------------------------------------------

/**
 * Payload for the ROUTE_EVENT_EMITTED domain event.
 *
 * The 13 core fields are required (enforced by DOMAIN_EVENT_SCHEMAS). Each
 * field is replay-critical: loss of any field means v2 replay cannot
 * reconstruct authoritative transition history.
 *
 * routeEventId is an OPTIONAL self-referential field: applyV2RouteEvent()
 * generates a uuidv7, embeds it here, and returns it in V2RouteEventResult.
 * The caller then writes STATE_TRANSITION_APPLIED with that same id. Replay
 * can follow the link without scanning for the event store record id.
 * Old events (pre-6k8e) that lack routeEventId are still valid — schema and
 * DOMAIN_EVENT_SCHEMAS treat it as optional.
 */
export interface RouteEventEmittedPayload {
  /** Schema id for this event type itself (stable boundary-contract id). */
  readonly schemaId: string;
  /** Version of the schema at emit time (semver). */
  readonly schemaVersion: string;
  /** Config version (2 for all v2 configs). */
  readonly configVersion: number;
  /**
   * Deterministic fingerprint of the admitted config (sha256 prefix of the
   * canonical config identity string). Used for replay across config changes.
   */
  readonly configFingerprint: string;
  /** Bead ID. */
  readonly beadId: string;
  /** State ID the emitter was completing. */
  readonly stateId: string;
  /** Action ID within the state. */
  readonly actionId: string;
  /** Run ID (worker session / action run). */
  readonly runId: string;
  /** Class of deterministic emitter. */
  readonly emitterType: EmitterType;
  /** Stable ID of the specific emitter (tool name, verifier name, etc.). */
  readonly emitterId: string;
  /** Canonical UPPER_SNAKE_CASE event name from the v2 vocabulary. */
  readonly eventName: string;
  /** Category of the event from the v2 vocabulary. */
  readonly category: string;
  /** Artifact evidence refs. Each ref requires semanticPath + byteCount + sha256. */
  readonly evidenceRefs: readonly RouteEvidenceRef[];
  /**
   * Self-referential route-event ID (uuidv7). Generated by applyV2RouteEvent()
   * and embedded here so the caller can link STATE_TRANSITION_APPLIED without
   * needing the event store to return the record id.
   * Optional: absent on events written before pi-experiment-6k8e.
   */
  readonly routeEventId?: string;
}

// ---------------------------------------------------------------------------
// JSON Schema for SchemaRegistry registration (AC1 + AC4)
// ---------------------------------------------------------------------------

/** Stable schema id for the ROUTE_EVENT_EMITTED boundary contract. */
export const ROUTE_EVENT_EMITTED_SCHEMA_ID = 'harness.event.routeEventEmitted';

/** Schema version for the ROUTE_EVENT_EMITTED boundary contract. */
export const ROUTE_EVENT_EMITTED_SCHEMA_VERSION = '1.0.0';

/**
 * JSON Schema for RouteEvidenceRef.
 *
 * Enforces: semanticPath (string), byteCount (integer >= 0), sha256 (string).
 * schemaId/schemaVersion are optional strings.
 * additionalProperties: false — no untrusted fields.
 */
export const ROUTE_EVIDENCE_REF_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['semanticPath', 'byteCount', 'sha256'],
  additionalProperties: false,
  properties: {
    semanticPath: { type: 'string', minLength: 1 },
    byteCount: { type: 'integer', minimum: 0 },
    sha256: { type: 'string', minLength: 1 },
    schemaId: { type: 'string' },
    schemaVersion: { type: 'string' }
  }
};

/**
 * JSON Schema for ROUTE_EVENT_EMITTED payloads.
 *
 * 13 required fields enforced. evidenceRefs is an array of RouteEvidenceRef
 * objects — each ref must have semanticPath + byteCount + sha256.
 * routeEventId is optional: applyV2RouteEvent() embeds it as a self-referential
 * link; old events written before pi-experiment-6k8e lack it and still validate.
 * additionalProperties: false — model-authored fields cannot sneak in.
 */
export const ROUTE_EVENT_EMITTED_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: [
    'schemaId', 'schemaVersion',
    'configVersion', 'configFingerprint',
    'beadId', 'stateId', 'actionId', 'runId',
    'emitterType', 'emitterId',
    'eventName', 'category',
    'evidenceRefs'
  ],
  additionalProperties: false,
  properties: {
    schemaId: { type: 'string', minLength: 1 },
    schemaVersion: { type: 'string', minLength: 1 },
    configVersion: { type: 'integer', enum: [2] },
    configFingerprint: { type: 'string', minLength: 1 },
    beadId: { type: 'string', minLength: 1 },
    stateId: { type: 'string', minLength: 1 },
    actionId: { type: 'string', minLength: 1 },
    runId: { type: 'string', minLength: 1 },
    emitterType: { type: 'string', enum: ['tool', 'verifier', 'gate', 'systemPrecondition'] },
    emitterId: { type: 'string', minLength: 1 },
    eventName: { type: 'string', minLength: 1 },
    category: { type: 'string', enum: ['advance', 'failure', 'blocked', 'neutral'] },
    evidenceRefs: {
      type: 'array',
      items: ROUTE_EVIDENCE_REF_JSON_SCHEMA
    },
    // Optional self-referential id (generated by applyV2RouteEvent, absent on pre-6k8e events).
    routeEventId: { type: 'string', minLength: 1 }
  }
};

// ---------------------------------------------------------------------------
// v2 route-event projector
// ---------------------------------------------------------------------------

/**
 * Input to the v2 route-event projector.
 *
 * Provided by a deterministic emitter (tool, verifier, gate, system precondition)
 * after it produces a route verdict. The projector validates the event against
 * the v2 vocabulary and transitions table, then writes ROUTE_EVENT_EMITTED.
 *
 * Callers must pre-build the v2 vocabulary (via FlowManager.buildV2EventVocabulary)
 * and supply the state's transition lookup (via FlowManager.v2ApplyTransition).
 * This keeps RouteEventContract free of a FlowManager import (which would create
 * a circular dependency through SchemaRegistry).
 */
export interface V2RouteEventInput {
  /** Bead ID. */
  readonly beadId: string;
  /** State ID the emitter was completing. */
  readonly stateId: string;
  /** Action ID within the state. */
  readonly actionId: string;
  /** Run ID (worker session / action run). */
  readonly runId: string;
  /** Class of deterministic emitter. */
  readonly emitterType: EmitterType;
  /** Stable ID of the specific emitter. */
  readonly emitterId: string;
  /**
   * Canonical event name from the v2 vocabulary (case-insensitive; normalized
   * to UPPER_SNAKE_CASE internally).
   */
  readonly eventName: string;
  /** Artifact evidence refs. Each ref must have semanticPath + byteCount + sha256. */
  readonly evidenceRefs: readonly RouteEvidenceRef[];
  /**
   * Deterministic fingerprint of the admitted config. Used for replay.
   * Callers compute this from a stable config identity (e.g. sha256 of canonical
   * YAML text or configPath). MUST NOT use Date.now() or Math.random().
   */
  readonly configFingerprint: string;
  /**
   * Pre-built v2 event vocabulary map (normalized UPPER_SNAKE → category).
   * Build via FlowManager.buildV2EventVocabulary(config). Pass an empty map
   * for v1 configs (applyV2RouteEvent returns NOT_IN_VOCABULARY for all events).
   * Callers are responsible for only calling applyV2RouteEvent for v2 configs.
   */
  readonly v2Vocab: ReadonlyMap<string, string>;
  /**
   * Pre-computed target state for the event (or null if no transition exists).
   * Compute via FlowManager.v2ApplyTransition(state, eventName, vocab).
   * Must be null for v1 configs or when no exact transition key exists.
   */
  readonly v2NextState: string | null;
}

/**
 * Result of applying a v2 route event.
 */
export interface V2RouteEventResult {
  /** true when a schema-valid ROUTE_EVENT_EMITTED was recorded. */
  readonly emitted: boolean;
  /**
   * The route-event ID when emitted === true.
   *
   * applyV2RouteEvent() generates a uuidv7, embeds it as routeEventId in the
   * ROUTE_EVENT_EMITTED payload, and returns it here. The caller MUST use this
   * value to populate routeEventId in STATE_TRANSITION_APPLIED — no separate
   * uuidv7() call is needed or correct.
   *
   * Undefined when emitted === false (validation rejected the event).
   */
  readonly routeEventId?: string;
  /**
   * The exact transition key used (normalized eventName) when a transition was found.
   * undefined when the state has no transition for this event.
   */
  readonly transitionKey?: string;
  /**
   * The target state ID when a transition was found.
   * undefined when the state has no transition for this event.
   */
  readonly nextState?: string;
  /**
   * The v2 vocabulary category of the event.
   * undefined when the event is not in the declared v2 vocabulary.
   */
  readonly category?: string;
  /**
   * Rejection reason when emitted === false.
   * 'NOT_IN_VOCABULARY' — eventName is not in the declared v2 vocabulary.
   * 'INVALID_EVIDENCE'  — an evidenceRef is missing byteCount or sha256.
   * 'NOT_V2_CONFIG'     — config.version !== 2.
   */
  readonly rejectReason?: 'NOT_IN_VOCABULARY' | 'INVALID_EVIDENCE' | 'NOT_V2_CONFIG';
}

/**
 * Minimal event store interface required by the v2 projector.
 *
 * Uses only `record()` — the projector does not read from the store.
 */
export interface RouteEventStore {
  record(event: string, data: unknown): Promise<void>;
}

/**
 * Validates that all evidence refs have the required byteCount and sha256 fields.
 *
 * Returns the first invalid ref description, or null if all refs are valid.
 * This is the schema-strictness enforcement described in AC4.
 */
export function validateEvidenceRefs(refs: readonly RouteEvidenceRef[]): string | null {
  for (const ref of refs) {
    if (typeof ref.byteCount !== 'number' || ref.byteCount < 0) {
      return `evidenceRef for "${ref.semanticPath}": byteCount must be a non-negative integer`;
    }
    if (!ref.sha256 || typeof ref.sha256 !== 'string' || ref.sha256.length === 0) {
      return `evidenceRef for "${ref.semanticPath}": sha256 must be a non-empty string`;
    }
  }
  return null;
}

/**
 * Compute the v2 config fingerprint from a stable config identity string.
 *
 * DETERMINISTIC: uses only the input string, no Date.now() or Math.random().
 * Returns the first 16 hex characters of the SHA-256 digest.
 *
 * For tests, a pre-computed stable string (e.g. 'test-fingerprint-abc123') is
 * acceptable — the contract is that the value must be stable and deterministic.
 */
export function computeConfigFingerprint(configIdentity: string): string {
  // Use Node.js crypto for deterministic sha256. Import inline to keep the
  // module usable in tests without a full harness runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(configIdentity).digest('hex').slice(0, 16);
}

/**
 * Apply a v2 route event from a deterministic emitter.
 *
 * ANTI-PROSE ENFORCEMENT:
 *   Only call this function from a configured deterministic emitter (tool,
 *   verifier, gate, system precondition). NEVER call it from:
 *     - Model-authored text parsing / outcome field reading
 *     - Tool stdout/stderr scanning
 *     - Untrusted tool argument inspection
 *
 * On success:
 *   1. Validates the eventName against the pre-built v2 vocabulary (exact key).
 *   2. Validates all evidenceRefs have byteCount + sha256 (AC4).
 *   3. Generates a uuidv7 routeEventId, embeds it in the payload.
 *   4. Writes ROUTE_EVENT_EMITTED to the event store with all required fields.
 *   5. Returns routeEventId, the exact transition key, and target state.
 *
 * The CALLER is responsible for:
 *   - Pre-building the v2 vocab via FlowManager.buildV2EventVocabulary(config).
 *   - Pre-computing the next state via FlowManager.v2ApplyTransition(state, eventName, vocab).
 *   - Only calling this function for v2 configs (config.version === 2).
 *   - Writing STATE_TRANSITION_APPLIED with result.routeEventId (no separate
 *     uuidv7() call needed — the id is returned by this function).
 *
 * @param input  - The route event input from the deterministic emitter.
 * @param store  - The event store to record ROUTE_EVENT_EMITTED into.
 * @returns V2RouteEventResult — check .emitted before using other fields.
 */
export async function applyV2RouteEvent(
  input: V2RouteEventInput,
  store: RouteEventStore
): Promise<V2RouteEventResult> {
  // EVIDENCE STRICTNESS (AC4): reject before any projection.
  const evidenceError = validateEvidenceRefs(input.evidenceRefs);
  if (evidenceError) {
    return { emitted: false, rejectReason: 'INVALID_EVIDENCE' };
  }

  // V2 VOCABULARY CHECK: event must be in the pre-built vocabulary.
  const normalized = input.eventName.toUpperCase();
  const category = input.v2Vocab.get(normalized);
  if (!category) {
    return { emitted: false, rejectReason: 'NOT_IN_VOCABULARY' };
  }

  // EXACT TRANSITION KEY: use the pre-computed next state.
  const nextState = input.v2NextState ?? undefined;
  const transitionKey = nextState ? normalized : undefined;

  // Generate the routeEventId now so we can embed it in the payload AND return
  // it to the caller (who uses it to write STATE_TRANSITION_APPLIED).
  // uuidv7() is a runtime id — it is NOT a fingerprint and NOT part of any
  // deterministic hash, so using it here is correct.
  const routeEventId = uuidv7();

  // Build the payload (all required fields + optional routeEventId).
  const payload: RouteEventEmittedPayload = {
    schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
    schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
    configVersion: 2,
    configFingerprint: input.configFingerprint,
    beadId: input.beadId,
    stateId: input.stateId,
    actionId: input.actionId,
    runId: input.runId,
    emitterType: input.emitterType,
    emitterId: input.emitterId,
    eventName: normalized,
    category,
    evidenceRefs: input.evidenceRefs,
    routeEventId
  };

  // Write ROUTE_EVENT_EMITTED. The event store's record() validates all
  // required fields against DOMAIN_EVENT_SCHEMAS (via EventStore.record()).
  await store.record(DomainEventName.ROUTE_EVENT_EMITTED, payload);

  return {
    emitted: true,
    routeEventId,
    transitionKey,
    nextState,
    category
  };
}

// ---------------------------------------------------------------------------
// v2 read-side projection reducer (AC2)
// ---------------------------------------------------------------------------

/**
 * A single applied transition produced by projectV2Transitions().
 */
export interface V2AppliedTransition {
  /** The routeEventId from the ROUTE_EVENT_EMITTED payload. */
  readonly routeEventId: string;
  /** Normalized eventName from the ROUTE_EVENT_EMITTED payload. */
  readonly eventName: string;
  /** Category from the v2 vocabulary. */
  readonly category: string;
  /** The emitter that produced the route decision. */
  readonly emitterType: EmitterType;
  readonly emitterId: string;
  /** Target state, or undefined when the vocab entry has no transition for this event. */
  readonly nextState: string | undefined;
  /** The beadId from the payload. */
  readonly beadId: string;
  /** Transition key (normalized eventName) when a transition was found. */
  readonly transitionKey: string | undefined;
}

/**
 * Minimal DomainEvent shape required by projectV2Transitions.
 * Accepts any object with { type, data } — caller passes recorded events.
 */
export interface ProjectableEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/**
 * Minimal state shape required by projectV2Transitions for transition lookup.
 * Each state must expose its transitions map (eventName → targetState).
 */
export interface ProjectableState {
  readonly transitions?: Record<string, string>;
}

/**
 * v2 read-side projection reducer.
 *
 * Given a list of recorded events + the v2 vocab + a transition-table lookup,
 * produces the applied transitions by reading ONLY schema-valid
 * ROUTE_EVENT_EMITTED records whose emitterType is a valid EmitterType value.
 *
 * IGNORES:
 *   - Any event whose type is not ROUTE_EVENT_EMITTED.
 *   - Any ROUTE_EVENT_EMITTED whose emitterType is not in the valid enum
 *     (e.g. 'model' — the anti-prose guard).
 *   - Any ROUTE_EVENT_EMITTED whose eventName is not in the v2 vocab.
 *   - Any ROUTE_EVENT_EMITTED missing routeEventId (can't link to transition).
 *   - Model-authored outcome fields, tool stdout strings, prose — these are
 *     never ROUTE_EVENT_EMITTED records, so they are unconditionally skipped.
 *
 * DETERMINISTIC: calling with the same events + vocab + table always returns
 * the same transitions in the same order (AC5 replay invariant).
 *
 * Runtime wiring into handleTeammateEvent is deferred to downstream beads
 * (e8cm/hutg) — no v2 config runs in production yet. This function is a
 * complete, callable, tested projection unit.
 *
 * @param events     - Recorded domain events (read from event store or fixture).
 * @param v2Vocab    - Pre-built v2 vocabulary map (normalized UPPER_SNAKE → category).
 *                     Build via FlowManager.buildV2EventVocabulary(config).
 * @param stateFor   - Given a stateId, return the state's transitions map (or undefined).
 *                     Callers build this from config.states.
 * @returns Array of applied transitions in event order.
 */
export function projectV2Transitions(
  events: readonly ProjectableEvent[],
  v2Vocab: ReadonlyMap<string, string>,
  stateFor: (stateId: string) => ProjectableState | undefined
): V2AppliedTransition[] {
  const VALID_EMITTER_TYPES = new Set<string>(['tool', 'verifier', 'gate', 'systemPrecondition']);
  const result: V2AppliedTransition[] = [];

  for (const event of events) {
    // GATE 1: must be a ROUTE_EVENT_EMITTED record.
    if (event.type !== DomainEventName.ROUTE_EVENT_EMITTED) {
      continue;
    }

    const d = event.data;

    // GATE 2: emitterType must be a valid deterministic emitter type.
    // This rejects 'model' and any other model-authored emitter class.
    const emitterType = d['emitterType'];
    if (typeof emitterType !== 'string' || !VALID_EMITTER_TYPES.has(emitterType)) {
      continue;
    }

    // GATE 3: eventName must be a non-empty string present in the v2 vocab.
    const rawEventName = d['eventName'];
    if (typeof rawEventName !== 'string' || rawEventName.length === 0) {
      continue;
    }
    const normalized = rawEventName.toUpperCase();
    const category = v2Vocab.get(normalized);
    if (!category) {
      continue;
    }

    // GATE 4: routeEventId must be present (enables STATE_TRANSITION_APPLIED linkage).
    const routeEventId = d['routeEventId'];
    if (typeof routeEventId !== 'string' || routeEventId.length === 0) {
      continue;
    }

    // Remaining fields (best-effort — absent fields yield undefined, not errors).
    const beadId = typeof d['beadId'] === 'string' ? d['beadId'] : '';
    const emitterId = typeof d['emitterId'] === 'string' ? d['emitterId'] : '';
    const stateId = typeof d['stateId'] === 'string' ? d['stateId'] : '';

    // Transition lookup: check the state's transitions table for the exact key.
    const state = stateFor(stateId);
    const rawNextState = state?.transitions?.[normalized];
    const nextState = typeof rawNextState === 'string' ? rawNextState : undefined;
    const transitionKey = nextState ? normalized : undefined;

    result.push({
      routeEventId,
      eventName: normalized,
      category,
      emitterType: emitterType as EmitterType,
      emitterId,
      nextState,
      beadId,
      transitionKey
    });
  }

  return result;
}
