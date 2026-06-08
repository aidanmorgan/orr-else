/**
 * pi-experiment-hutg: v2 action-level route-event emission contract.
 *
 * Provides the CALLABLE emission path:
 *
 *   emitActionRouteEvent(options) → Promise<V2RouteEventResult>
 *
 * Given a deterministic verdict (pass | fail | blocked | preconditionFailed) and an
 * ActionEmitsMapping, this function:
 *   1. Looks up the configured event name for the verdict.
 *   2. Calls applyV2RouteEvent (pi-experiment-6k8e) with the full identity + evidence.
 *   3. Returns the V2RouteEventResult (caller writes STATE_TRANSITION_APPLIED using
 *      result.routeEventId — no separate uuidv7 call needed).
 *
 * ANTI-PROSE ENFORCEMENT:
 *   The event name is chosen ONLY by (ActionEmitsMapping + deterministic verdict).
 *   Tool stdout/stderr, LLM prose, and model-provided args MUST NEVER be passed as
 *   the verdict — they are never inspected here. The caller is responsible for
 *   producing a deterministic verdict via TypeScript logic, NOT by parsing output.
 *
 * PRECONDITION GATE:
 *   When the verdict is 'preconditionFailed', this function emits the configured
 *   preconditionFailed event BEFORE the tool/verifier body is called. The caller
 *   must check for missing artifacts before invoking the tool/verifier body, then
 *   call this function with verdict 'preconditionFailed' if any artifact is missing.
 *   The caller must NOT call the tool/verifier body after a preconditionFailed emit.
 *
 * VERSION GATING: v2-only. Do NOT call for v1 configs (config.version !== 2).
 *
 * DETERMINISM: no Date.now() or Math.random() in the mapping/verdict/event path.
 * uuidv7() runtime IDs are used internally by applyV2RouteEvent for routeEventId.
 */

import {
  applyV2RouteEvent,
  type V2RouteEventResult,
  type RouteEvidenceRef,
  type RouteEventStore,
  type EmitterType,
} from './RouteEventContract.js';

// ---------------------------------------------------------------------------
// Verdict type
// ---------------------------------------------------------------------------

/**
 * Deterministic verdict produced by TypeScript logic in a tool or verifier.
 *
 * 'pass'              — the tool/verifier succeeded.
 * 'fail'              — the tool/verifier failed.
 * 'blocked'           — the tool/verifier is blocked (e.g. dependency not met).
 * 'preconditionFailed'— a required artifact is missing; emitted BEFORE the body runs.
 *
 * The verdict MUST be produced deterministically by TypeScript code — NEVER by
 * parsing tool stdout/stderr, LLM prose, or model-provided arguments.
 */
export type ActionVerdict = 'pass' | 'fail' | 'blocked' | 'preconditionFailed';

// ---------------------------------------------------------------------------
// Emits mapping (re-export for consumers who only import from this module)
// ---------------------------------------------------------------------------

/**
 * Config-owned mapping from ActionVerdict to declared v2 event names.
 * Mirrors the ActionEmitsMapping interface from StateModels.ts — re-declared
 * here to avoid a cross-layer import from RouteEventContract into domain types.
 */
export interface EmitsMapping {
  readonly pass: string;
  readonly fail: string;
  readonly blocked?: string;
  readonly preconditionFailed?: string;
}

// ---------------------------------------------------------------------------
// emitActionRouteEvent options
// ---------------------------------------------------------------------------

/**
 * Options for emitActionRouteEvent.
 *
 * All identity fields (beadId, stateId, actionId, runId, emitterId) must be
 * stable, deterministic identifiers — never runtime-generated values from
 * untrusted sources (tool stdout, model args, prose).
 */
export interface EmitActionRouteEventOptions {
  /** Config-owned emits mapping for this action. */
  readonly emits: EmitsMapping;
  /** Deterministic verdict from TypeScript logic. Never from stdout/model. */
  readonly verdict: ActionVerdict;
  /** Class of emitter: 'tool' or 'verifier'. */
  readonly emitterType: EmitterType;
  /** Stable ID of the specific emitter (tool name, verifier name, etc.). */
  readonly emitterId: string;
  /** Bead ID. */
  readonly beadId: string;
  /** State ID the emitter was completing. */
  readonly stateId: string;
  /** Action ID within the state. */
  readonly actionId: string;
  /** Run ID (worker session / action run). */
  readonly runId: string;
  /** Deterministic fingerprint of the admitted config. */
  readonly configFingerprint: string;
  /** Pre-built v2 vocabulary map (normalized UPPER_SNAKE → category). */
  readonly v2Vocab: ReadonlyMap<string, string>;
  /** Pre-computed next state (from v2ApplyTransition), or null if no transition. */
  readonly v2NextState: string | null;
  /** Artifact evidence refs. Each ref must have semanticPath + byteCount + sha256. */
  readonly evidenceRefs: readonly RouteEvidenceRef[];
  /** Event store to record ROUTE_EVENT_EMITTED into. */
  readonly store: RouteEventStore;
}

// ---------------------------------------------------------------------------
// Callable emission function (AC1 + AC2 load-bearing contract)
// ---------------------------------------------------------------------------

/**
 * Emit a route event for a v2 tool or verifier action.
 *
 * This is the load-bearing callable emission path introduced by pi-experiment-hutg.
 * It wires the ActionEmitsMapping + deterministic verdict through applyV2RouteEvent
 * (pi-experiment-6k8e) to produce a ROUTE_EVENT_EMITTED record.
 *
 * Steps:
 *   1. Look up the configured event name for the verdict in emits mapping.
 *   2. If no event is configured for this verdict (e.g. blocked without emits.blocked),
 *      return { emitted: false, rejectReason: 'NOT_IN_VOCABULARY' }.
 *   3. Call applyV2RouteEvent with the resolved event name + all identity/evidence fields.
 *   4. Return the V2RouteEventResult (with routeEventId for STATE_TRANSITION_APPLIED linkage).
 *
 * ANTI-PROSE GUARANTEE:
 *   The event name comes ONLY from the emits mapping keyed by verdict. The verdict
 *   MUST be a deterministic TypeScript value — this function has no access to and
 *   NEVER reads tool stdout, LLM prose, or model-provided arguments.
 *
 * PRECONDITION GATE:
 *   Call with verdict = 'preconditionFailed' BEFORE running the tool/verifier body
 *   when a required artifact is missing. Do NOT call the body after this returns.
 *
 * @param options - All required identity, evidence, and config-owned routing fields.
 * @returns V2RouteEventResult — check .emitted before using other fields.
 */
export async function emitActionRouteEvent(
  options: EmitActionRouteEventOptions
): Promise<V2RouteEventResult> {
  const {
    emits,
    verdict,
    emitterType,
    emitterId,
    beadId,
    stateId,
    actionId,
    runId,
    configFingerprint,
    v2Vocab,
    v2NextState,
    evidenceRefs,
    store,
  } = options;

  // Step 1: look up the configured event name for this verdict.
  let eventName: string | undefined;
  switch (verdict) {
    case 'pass':              eventName = emits.pass; break;
    case 'fail':              eventName = emits.fail; break;
    case 'blocked':           eventName = emits.blocked; break;
    case 'preconditionFailed': eventName = emits.preconditionFailed; break;
  }

  // Step 2: if no event configured for this verdict, return not-in-vocabulary.
  if (!eventName || !eventName.trim()) {
    return { emitted: false, rejectReason: 'NOT_IN_VOCABULARY' };
  }

  // Step 3: delegate to applyV2RouteEvent (6k8e) for schema validation, vocab check,
  // evidence strictness, uuidv7 routeEventId generation, and event store recording.
  // This is the ONLY path that produces ROUTE_EVENT_EMITTED for tool/verifier actions.
  return applyV2RouteEvent(
    {
      beadId,
      stateId,
      actionId,
      runId,
      emitterType,
      emitterId,
      eventName,
      evidenceRefs,
      configFingerprint,
      v2Vocab,
      v2NextState,
    },
    store
  );
}
