/**
 * pi-experiment-ne2w: v2 gate aggregation — callable evaluateV2Gate.
 *
 * Provides:
 *   evaluateV2Gate(gateConfig, checkResults, emitOptions) → Promise<V2GateAggregateResult>
 *
 * Given a v2 gate config (allOf or anyOf operator + ordered checks + precedence lists)
 * and the results of running ALL listed checks (no short-circuit — callers MUST evaluate
 * every check before calling this function), the aggregator:
 *
 *   1. Validates that exactly one of allOf/anyOf is present (programming-time guard).
 *   2. Applies the operator logic to determine the final verdict:
 *        allOf: PASS if all checks pass; else BLOCKED > FAILURE (by precedence).
 *        anyOf: PASS if any check passes; else BLOCKED > FAILURE (by precedence).
 *   3. Selects the winning event using configured precedence lists (no short-circuit:
 *        ALL checks have been evaluated and their evidence is recorded regardless).
 *   4. Calls applyV2RouteEvent ONCE with the winning event + ALL evidence refs.
 *   5. Returns the V2GateAggregateResult (one emitted event, all evidence).
 *
 * NO SHORT-CIRCUIT (AC2/AC4):
 *   The caller is responsible for running all checks before calling evaluateV2Gate.
 *   This function NEVER skips check results — it processes every entry in checkResults
 *   and includes ALL evidence in the emitted route event, even for non-deciding checks.
 *
 * EXACTLY ONE ROUTE EVENT (AC2):
 *   applyV2RouteEvent is called ONCE. The event includes all evidence refs from
 *   all checks (deciding and non-deciding alike).
 *
 * DETERMINISM: no Date.now() or Math.random() in operator/verdict/precedence logic.
 * uuidv7() is used internally by applyV2RouteEvent for routeEventId only.
 *
 * VERSION-GATED: v2 only. Do NOT call for v1 configs.
 */

import {
  applyV2RouteEvent,
  type V2RouteEventResult,
  type RouteEvidenceRef,
  type RouteEventStore,
} from './RouteEventContract.js';
import type { V2GateConfig, V2GateCheckResult } from './domain/StateModels.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Result of evaluating a v2 gate with allOf or anyOf aggregation.
 */
export interface V2GateAggregateResult {
  /**
   * The final verdict chosen by the gate operator + precedence rules.
   * 'pass' | 'fail' | 'blocked'
   */
  readonly verdict: 'pass' | 'fail' | 'blocked';
  /**
   * The normalized UPPER_SNAKE event name emitted (exactly one per gate evaluation).
   */
  readonly eventName: string;
  /**
   * ALL evidence refs from all evaluated checks, in check-configured order.
   * Non-deciding checks are included (AC4: all evidence recorded).
   */
  readonly allEvidence: readonly RouteEvidenceRef[];
  /**
   * The V2RouteEventResult from applyV2RouteEvent (contains routeEventId, etc.).
   * Check .emitted before using other fields.
   */
  readonly routeEventResult: V2RouteEventResult;
}

// ---------------------------------------------------------------------------
// Emit options (identity context for applyV2RouteEvent)
// ---------------------------------------------------------------------------

/**
 * Identity context required to emit the ROUTE_EVENT_EMITTED domain event.
 * Mirrors the identity fields in EmitActionRouteEventOptions (hutg).
 */
export interface V2GateEmitOptions {
  /** Bead ID. */
  readonly beadId: string;
  /** State ID the gate is completing. */
  readonly stateId: string;
  /** Action ID within the state (or gate ID if gate is top-level). */
  readonly actionId: string;
  /** Run ID (worker session / action run). */
  readonly runId: string;
  /** Deterministic fingerprint of the admitted config. */
  readonly configFingerprint: string;
  /** Pre-built v2 vocabulary map (normalized UPPER_SNAKE → category). */
  readonly v2Vocab: ReadonlyMap<string, string>;
  /** Pre-computed next state (from v2ApplyTransition), or null if no transition. */
  readonly v2NextState: string | null;
  /** Event store to record ROUTE_EVENT_EMITTED into. */
  readonly store: RouteEventStore;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Select the highest-precedence event from a set of candidate event names,
 * using the configured precedence list (first entry = highest priority).
 *
 * DETERMINISTIC: no Date.now/Math.random. Pure list scan.
 *
 * @param candidates   — set of candidate normalized event names.
 * @param precedence   — ordered precedence list (highest priority first).
 * @param category     — human-readable category label for error messages.
 * @param gateId       — gate ID for error messages.
 * @returns the winning event name.
 * @throws Error if no candidate is found in the precedence list (ambiguous gate —
 *         startup validation should have caught this, but we fail fast at runtime too).
 */
function selectByPrecedence(
  candidates: Set<string>,
  precedence: readonly string[],
  category: string,
  gateId: string
): string {
  for (const eventName of precedence) {
    if (candidates.has(eventName.toUpperCase())) {
      return eventName.toUpperCase();
    }
  }
  // Should not reach here if startup validation is correct.
  throw new Error(
    `v2 gate "${gateId}": ${category} precedence list does not cover event(s): ` +
    `${[...candidates].join(', ')}. ` +
    `Add all possible ${category} events to the gate's ${category === 'failure' ? 'failPrecedence' : 'blockPrecedence'} list.`
  );
}

// ---------------------------------------------------------------------------
// Main callable aggregator
// ---------------------------------------------------------------------------

/**
 * Evaluate a v2 gate by aggregating ALL check results.
 *
 * CALLERS MUST evaluate every check BEFORE calling this function.
 * The length of checkResults MUST equal the length of gateConfig.checks.
 * (One result per check, in the same configured order.)
 *
 * allOf semantics:
 *   - All checks passed → emit passEvent.
 *   - Any check blocked → blocked takes precedence over failure; choose by blockPrecedence.
 *   - Any check failed (no blocked) → choose by failPrecedence.
 *
 * anyOf semantics:
 *   - At least one check passed → emit passEvent.
 *   - All checks blocked (none passed) → choose by blockPrecedence.
 *   - All checks failed/blocked (none passed, some failed) → blocked > failure; choose by precedence.
 *
 * In both operators: BLOCKED events take precedence over FAILURE events.
 * Within each category: the configured precedence list determines the winner.
 * ALL evidence refs from ALL checks are included in the emitted route event (AC4).
 * EXACTLY ONE ROUTE_EVENT_EMITTED is written (AC2).
 *
 * @param gateConfig   — v2 gate config with operator, checks, passEvent, precedence lists.
 * @param checkResults — results for every check (in configured order, no short-circuit).
 * @param emitOptions  — identity context for applyV2RouteEvent.
 * @returns V2GateAggregateResult with verdict, eventName, allEvidence, routeEventResult.
 */
export async function evaluateV2Gate(
  gateConfig: V2GateConfig,
  checkResults: readonly V2GateCheckResult[],
  emitOptions: V2GateEmitOptions
): Promise<V2GateAggregateResult> {
  const { operator, passEvent, failPrecedence, blockPrecedence } = gateConfig;
  const gateId = gateConfig.id;

  // Collect ALL evidence from ALL checks (no short-circuit: AC4).
  const allEvidence: RouteEvidenceRef[] = [];
  for (const result of checkResults) {
    for (const ref of result.evidenceRefs) {
      allEvidence.push(ref);
    }
  }

  // Determine the final verdict + winning event using operator semantics.
  const passCount = checkResults.filter(r => r.verdict === 'pass').length;
  const blockedEvents = new Set<string>();
  const failureEvents = new Set<string>();

  for (const result of checkResults) {
    if (result.verdict === 'blocked') blockedEvents.add(result.eventName.toUpperCase());
    if (result.verdict === 'fail') failureEvents.add(result.eventName.toUpperCase());
  }

  let verdict: 'pass' | 'fail' | 'blocked';
  let winningEvent: string;

  if (operator === 'allOf') {
    // allOf: pass only if ALL checks passed.
    if (passCount === checkResults.length) {
      verdict = 'pass';
      winningEvent = passEvent.toUpperCase();
    } else if (blockedEvents.size > 0) {
      // Blocked takes precedence over failure.
      verdict = 'blocked';
      winningEvent = blockedEvents.size === 1
        ? [...blockedEvents][0]
        : selectByPrecedence(blockedEvents, blockPrecedence ?? [], 'blocked', gateId);
    } else {
      // At least one failure, no blocked.
      verdict = 'fail';
      winningEvent = failureEvents.size === 1
        ? [...failureEvents][0]
        : selectByPrecedence(failureEvents, failPrecedence ?? [], 'failure', gateId);
    }
  } else {
    // anyOf: pass if at least one check passed.
    if (passCount > 0) {
      verdict = 'pass';
      winningEvent = passEvent.toUpperCase();
    } else if (blockedEvents.size > 0 && failureEvents.size === 0) {
      // All non-passing checks are blocked.
      verdict = 'blocked';
      winningEvent = blockedEvents.size === 1
        ? [...blockedEvents][0]
        : selectByPrecedence(blockedEvents, blockPrecedence ?? [], 'blocked', gateId);
    } else if (blockedEvents.size > 0) {
      // Mixed: some blocked, some failed. Blocked takes precedence over failure.
      verdict = 'blocked';
      winningEvent = blockedEvents.size === 1
        ? [...blockedEvents][0]
        : selectByPrecedence(blockedEvents, blockPrecedence ?? [], 'blocked', gateId);
    } else {
      // All checks failed (none passed, none blocked).
      verdict = 'fail';
      winningEvent = failureEvents.size === 1
        ? [...failureEvents][0]
        : selectByPrecedence(failureEvents, failPrecedence ?? [], 'failure', gateId);
    }
  }

  // Emit EXACTLY ONE route event with ALL evidence (AC2 + AC4).
  const routeEventResult = await applyV2RouteEvent(
    {
      beadId: emitOptions.beadId,
      stateId: emitOptions.stateId,
      actionId: emitOptions.actionId,
      runId: emitOptions.runId,
      emitterType: 'gate',
      emitterId: gateId,
      eventName: winningEvent,
      evidenceRefs: allEvidence,
      configFingerprint: emitOptions.configFingerprint,
      v2Vocab: emitOptions.v2Vocab,
      v2NextState: emitOptions.v2NextState,
    },
    emitOptions.store
  );

  return {
    verdict,
    eventName: winningEvent,
    allEvidence,
    routeEventResult,
  };
}
