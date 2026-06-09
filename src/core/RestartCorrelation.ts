/**
 * Restart lifecycle correlation utilities — pi-experiment-nyug / pi-experiment-q8tl.
 *
 * Provides helpers for generating and extracting restart correlation IDs so
 * that operators can reconstruct the lifecycle chain:
 *
 *   CONTEXT_RESTART_REQUESTED / HARNESS_RESTART_REQUESTED
 *     → STATE_RUN_INITIALIZED (via restartId)
 *     → terminal outcome (same runId)
 *
 * Design constraints:
 *  - restartId is derived deterministically from the signal's idempotencyKey
 *    so duplicate signals (same idempotencyKey) produce the same restartId.
 *  - No new env vars — the worker reads correlation from the event store.
 *  - Explicit-only: restartId and targetState are required on every production
 *    restart event (pi-experiment-q8tl). Malformed records missing restartId
 *    are rejected with a descriptive error rather than silently returning undefined.
 *    There is NO fallback from targetState to stateId — cross-state restarts
 *    require explicit targetState.
 */

import { createHash } from 'node:crypto';
import { DomainEventName } from '../constants/domain.js';
import type { DomainEvent } from './EventStoreTypes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RestartCorrelation {
  /** Stable ID derived from the restart signal's idempotencyKey. */
  restartId: string;
  /**
   * The sessionStateId of the worker that issued the restart signal.
   * Optional: supervisor-triggered restarts have no prior worker session ID.
   */
  previousRunId?: string;
}

// ---------------------------------------------------------------------------
// restartId derivation
// ---------------------------------------------------------------------------

/**
 * Derive a stable restartId from an idempotency key.
 *
 * Using a deterministic derivation (SHA-256 prefix) means that two signals
 * with the same idempotencyKey — i.e., duplicate restart requests — always
 * produce the same restartId. This satisfies AC2 without requiring in-process
 * state.
 */
export function deriveRestartId(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// attempt counter
// ---------------------------------------------------------------------------

/**
 * Compute the restart attempt number for a bead+state combination.
 *
 * Counts CONTEXT_RESTART_REQUESTED and HARNESS_RESTART_REQUESTED events that
 * target `stateId` in the supplied event list and returns count + 1 (so the
 * first restart is attempt 1).
 *
 * This is intended to be called BEFORE recording the new restart event so that
 * the resulting attempt number is accurate.
 */
export function computeRestartAttempt(
  events: DomainEvent[],
  beadId: string,
  stateId: string
): number {
  let count = 0;
  for (const event of events) {
    if (
      event.type !== DomainEventName.CONTEXT_RESTART_REQUESTED &&
      event.type !== DomainEventName.HARNESS_RESTART_REQUESTED
    ) {
      continue;
    }
    const data = event.data as Record<string, unknown>;
    if (data.beadId === beadId && data.stateId === stateId) {
      count++;
    }
  }
  return count + 1;
}

// ---------------------------------------------------------------------------
// extractRestartCorrelation
// ---------------------------------------------------------------------------

/**
 * Extract restart correlation from the event history for a bead+state.
 *
 * Returns the correlation (restartId + previousRunId) from the most recent
 * CONTEXT_RESTART_REQUESTED or HARNESS_RESTART_REQUESTED event for the given
 * beadId+stateId, PROVIDED that no STATE_RUN_INITIALIZED has occurred after it.
 * Once a run is initialized the restart is "consumed" and subsequent calls
 * return undefined.
 *
 * Matching is performed ONLY on the explicit targetState field — there is no
 * fallback to stateId. A restart event lacking targetState or restartId is
 * malformed and throws a descriptive error (pi-experiment-q8tl).
 *
 * This is the WORKER-SIDE reader: called during STATE_RUN_INITIALIZED recording
 * to carry restartId + previousRunId forward.
 *
 * @throws {Error} when a matching restart event is missing restartId or
 *   targetState — the caller must not silently proceed without a valid correlation.
 */
export function extractRestartCorrelation(
  events: DomainEvent[],
  beadId: string,
  stateId: string
): RestartCorrelation | undefined {
  // Walk events in reverse chronological order.
  for (const event of [...events].reverse()) {
    const data = event.data as Record<string, unknown>;

    // If we find a STATE_RUN_INITIALIZED for this bead+state first, the restart
    // is already consumed — no correlation to carry forward.
    if (
      event.type === DomainEventName.STATE_RUN_INITIALIZED &&
      data.beadId === beadId &&
      data.stateId === stateId
    ) {
      return undefined;
    }

    if (
      (event.type === DomainEventName.CONTEXT_RESTART_REQUESTED ||
        event.type === DomainEventName.HARNESS_RESTART_REQUESTED) &&
      data.beadId === beadId
    ) {
      // Match ONLY by explicit targetState — no stateId fallback (pi-experiment-q8tl).
      if (typeof data.targetState !== 'string') {
        throw new Error(
          `Malformed restart event ${event.id} (${event.type}): missing required field targetState. ` +
          `beadId=${String(data.beadId)} stateId=${String(data.stateId)}`
        );
      }

      if (data.targetState !== stateId) continue;

      // restartId is required on all production restart events (pi-experiment-q8tl).
      if (typeof data.restartId !== 'string') {
        throw new Error(
          `Malformed restart event ${event.id} (${event.type}): missing required field restartId. ` +
          `beadId=${String(data.beadId)} targetState=${data.targetState}`
        );
      }

      const previousRunId =
        typeof data.previousRunId === 'string' ? data.previousRunId : undefined;

      return { restartId: data.restartId, previousRunId };
    }
  }

  return undefined;
}
