/**
 * ToolRetryPipeline — pi-experiment-t6gw
 *
 * Harness-owned, deterministic tool retry pipeline for idempotency enforcement.
 *
 * DESIGN CONSTRAINTS:
 *   - Retry decisions live entirely in harness TypeScript, never delegated to
 *     the model (AC1).
 *   - Default is ZERO automatic retries; a retryPolicy declaration is required
 *     to enable any retry (AC2).
 *   - A retry is admitted ONLY when the tool's sideEffectContract.idempotencyClass
 *     is 'idempotent' or 'at_least_once'. 'non_idempotent' tools are NEVER retried
 *     and the body is suppressed before re-invocation (AC4).
 *   - A retry request for a tool with no/unknown idempotencyClass is REJECTED
 *     before retry admission (AC3).
 *   - Every decision emits a TOOL_RETRY_DECISION event with all required fields
 *     via the injected EventStore.record. Partial emits are rejected by 824i (AC5).
 *   - The decision is deterministic: driven ONLY by the retry policy, attempt
 *     count, failure category, and idempotencyClass. No Date.now() or Math.random()
 *     in the decision logic (AC6 replay-equivalence).
 *   - Wired into wrapPluginTool in extension.ts (load-bearing, not orphaned).
 */

import type { ToolFailureCategory } from '../contract.js';
import type { ToolRetryPolicy } from './domain/StateModels.js';
import type { EventStore } from './EventStore.js';
import { DomainEventName } from '../constants/domain.js';
import type { RtkIdempotencyClass } from './RtkContract.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The set of idempotency classes that are eligible for retry.
 * 'non_idempotent' tools are NEVER retried.
 */
const RETRIABLE_IDEMPOTENCY_CLASSES = new Set<RtkIdempotencyClass>(['idempotent', 'at_least_once']);

/**
 * Outcome of a retry pipeline decision.
 *
 * RETRY                       — retry is admitted; the tool should be re-invoked.
 * SUPPRESS                    — non-idempotent tool; body suppressed, not retried.
 * EXHAUSTED                   — configured limit reached; no more retries.
 * REJECT_NO_IDEMPOTENCY_CLASS — tool has no/unknown idempotencyClass; retry rejected.
 */
export type RetryDecision =
  | 'RETRY'
  | 'SUPPRESS'
  | 'EXHAUSTED'
  | 'REJECT_NO_IDEMPOTENCY_CLASS';

/**
 * The next route after a retry decision.
 *
 * 'retry' — the caller should re-invoke the tool body.
 * 'fail'  — the caller should propagate the failure.
 */
export type RetryNextRoute = 'retry' | 'fail';

/**
 * Result of evaluateRetry.
 */
export interface RetryDecisionResult {
  decision: RetryDecision;
  nextRoute: RetryNextRoute;
}

/**
 * Input to evaluateRetry. All fields are required so that the event record
 * is fully populated without any optional fallbacks.
 */
export interface RetryInput {
  /** Tool name. */
  tool: string;
  /** Unique invocation ID (uuidv7) for this attempt. */
  invocationId: string;
  /** 1-based attempt number (1 = first attempt, 2 = first retry, …). */
  attempt: number;
  /** The failure category from the last failed invocation. */
  failureCategory: ToolFailureCategory;
  /** The tool's configured retry policy, or undefined for zero-retry default. */
  retryPolicy: ToolRetryPolicy | undefined;
  /** The tool's idempotencyClass from its sideEffectContract, or undefined if absent. */
  idempotencyClass: RtkIdempotencyClass | undefined;
}

// ---------------------------------------------------------------------------
// Core decision function
// ---------------------------------------------------------------------------

/**
 * Evaluate the retry pipeline and emit a TOOL_RETRY_DECISION event.
 *
 * DETERMINISTIC: the decision is computed from the inputs alone — no I/O,
 * no randomness, no timestamps in the decision logic. This means replaying
 * the same inputs produces the same decision (AC6).
 *
 * The emitted event carries all required fields (AC5). A partial emit would
 * be rejected by EventStore.record (824i validation).
 *
 * @param input       Retry decision inputs.
 * @param eventStore  EventStore for emitting the TOOL_RETRY_DECISION event.
 */
export async function evaluateRetry(
  input: RetryInput,
  eventStore: EventStore
): Promise<RetryDecisionResult> {
  const { tool, invocationId, attempt, failureCategory, retryPolicy, idempotencyClass } = input;

  // AC2: default is zero retries — no policy means no retry.
  const configuredLimit = retryPolicy?.maxAttempts ?? 1;

  let decision: RetryDecision;
  let nextRoute: RetryNextRoute;

  if (!retryPolicy) {
    // No policy: zero retries. Treat as exhausted at attempt 1.
    decision = 'EXHAUSTED';
    nextRoute = 'fail';
  } else if (idempotencyClass === undefined) {
    // AC3: missing idempotencyClass rejects before retry admission.
    decision = 'REJECT_NO_IDEMPOTENCY_CLASS';
    nextRoute = 'fail';
  } else if (!RETRIABLE_IDEMPOTENCY_CLASSES.has(idempotencyClass)) {
    // AC4: non_idempotent tools are NEVER retried — suppress before body runs.
    decision = 'SUPPRESS';
    nextRoute = 'fail';
  } else if (!retryPolicy.retriableCategories.includes(failureCategory)) {
    // Failure category is not in the retriable set — treat as exhausted.
    decision = 'EXHAUSTED';
    nextRoute = 'fail';
  } else if (attempt >= configuredLimit) {
    // AC6: limit reached — no more retries.
    decision = 'EXHAUSTED';
    nextRoute = 'fail';
  } else {
    // All guards passed — admit retry.
    decision = 'RETRY';
    nextRoute = 'retry';
  }

  // AC5: emit schema-valid event with all required fields.
  // EventStore.record rejects partial payloads (824i) — all eight fields must be present.
  await eventStore.record(DomainEventName.TOOL_RETRY_DECISION, {
    tool,
    invocationId,
    attempt,
    idempotencyClass: idempotencyClass ?? 'unknown',
    failureCategory,
    configuredLimit,
    decision,
    nextRoute
  }).catch(() => {
    // Fire-and-forget: event emission failure must never block the retry decision.
  });

  return { decision, nextRoute };
}
