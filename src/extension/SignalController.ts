/**
 * Signal posting controller.
 *
 * Encapsulates postWorkerSignal (with event-store reconcile path),
 * teammateSignalEventData, and buildWorkerEvent construction helpers.
 *
 * No process.env reads — the composition root resolves env values and passes
 * them in via the WorkerEnv parameter bag.
 */

import type { BeadId } from '../types/ids.js';
import type { TeammateEvent } from '../core/TeammateEvents.js';
import { createTeammateEventIdempotencyKey, findAppliedTeammateSignal } from '../core/TeammateEvents.js';
import { postHarnessSignal, CoordinatorRejectionError } from '../core/HarnessApiClient.js';
import type { RuntimeServices } from '../core/RuntimeServices.js';
import { DomainEventName } from '../constants/domain.js';
import { OtelAttr, SpanName } from '../constants/infra.js';
import type { TeammateEventType } from '../constants/domain.js';

// ── worker env resolved by the composition root ──────────────────────────────

/**
 * Env values resolved from process.env by extension.ts (the allowlisted
 * boundary) and passed into controllers as plain data.
 */
export interface WorkerEnv {
  workerId: string;
  sessionStateId: string | undefined;
  beadId: string | undefined;
  stateId: string | undefined;
}

// ── teammate signal helpers ───────────────────────────────────────────────────

export function teammateSignalEventData(event: TeammateEvent): Record<string, unknown> {
  const data: Record<string, unknown> = {
    type: event.type,
    beadId: event.beadId,
    workerId: event.workerId,
    sessionStateId: event.sessionStateId,
    stateId: event.stateId,
    idempotencyKey: event.idempotencyKey
  };
  const anyEvent = event as unknown as Record<string, unknown>;
  for (const key of ['actionId', 'transitionEvent', 'summary', 'evidence', 'handover']) {
    if (anyEvent[key] !== undefined) data[key] = anyEvent[key];
  }
  return data;
}

// ── worker event construction ────────────────────────────────────────────────

/**
 * Build a TeammateEvent with idempotency key.
 * Caller provides already-resolved env values via WorkerEnv.
 */
export function buildWorkerEventFrom(
  type: TeammateEventType,
  fields: Record<string, unknown>,
  env: WorkerEnv,
  unknownStateId: string
): TeammateEvent {
  const nextPhase = typeof fields.nextPhase === 'string' ? fields.nextPhase : undefined;
  const event: Record<string, unknown> = {
    ...fields,
    type,
    beadId: fields.beadId || env.beadId,
    workerId: env.workerId,
    sessionStateId: env.sessionStateId,
    stateId: fields.stateId || env.stateId || nextPhase || unknownStateId,
    timestamp: Date.now()
  };
  event.idempotencyKey = createTeammateEventIdempotencyKey(event as Partial<TeammateEvent>);
  return event as unknown as TeammateEvent;
}

// ── signal posting with reconcile ────────────────────────────────────────────

export async function hasAppliedTeammateSignal(services: RuntimeServices, event: TeammateEvent): Promise<boolean> {
  const events = await services.eventStore.eventsForBead(event.beadId);
  return findAppliedTeammateSignal(events, event) !== undefined;
}

export async function postWorkerSignal(services: RuntimeServices, event: TeammateEvent): Promise<void> {
  await services.eventStore.record(DomainEventName.SIGNAL_INTENT_RECORDED, teammateSignalEventData(event));

  const postStartMs = Date.now();
  let postError: unknown;

  try {
    await postHarnessSignal(event);
  } catch (err) {
    postError = err;
  }

  const postEndMs = Date.now();

  // Best-effort telemetry — never throw from here.
  try {
    services.observability.recordCompletedSpan(SpanName.SIGNAL_ACK, {
      [OtelAttr.ORR_ELSE_BEAD_ID]: event.beadId || undefined,
      [OtelAttr.ORR_ELSE_STATE_ID]: event.stateId || undefined,
      [OtelAttr.AGENT_EVENT_TYPE]: event.type,
      'signal.success': postError === undefined
    }, postStartMs, postEndMs);
  } catch { /* best-effort: telemetry must never affect signal posting */ }

  if (postError === undefined) {
    await services.eventStore.record(DomainEventName.SIGNAL_ACKNOWLEDGED, teammateSignalEventData(event));
    return;
  }

  // Coordinator rejection (ok !== true in response body): this is NOT a transport
  // failure and MUST NOT be reconciled via the event-store. Record a structured
  // rejection failure and re-throw — never record SIGNAL_ACKNOWLEDGED.
  if (postError instanceof CoordinatorRejectionError) {
    await services.eventStore.record(DomainEventName.TEAMMATE_SIGNAL_FAILED, {
      ...teammateSignalEventData(event),
      coordinatorRejection: true,
      rule: postError.rule,
      ...(postError.timedOut ? { timedOut: true } : {}),
      ...(postError.blocked ? { blocked: true } : {}),
      ...(postError.gate !== undefined ? { gate: postError.gate } : {}),
      error: postError.message
    }).catch(() => {});
    throw postError;
  }

  // Transport failure: attempt event-store reconcile before failing.
  const applied = await hasAppliedTeammateSignal(services, event).catch(() => false);
  await services.eventStore.record(DomainEventName.TEAMMATE_SIGNAL_FAILED, {
    ...teammateSignalEventData(event),
    error: String(postError),
    appliedAfterTransportFailure: applied
  }).catch(() => {});

  if (applied) {
    await services.eventStore.record(DomainEventName.SIGNAL_ACKNOWLEDGED, {
      ...teammateSignalEventData(event),
      source: 'event-store-reconcile'
    });
    return;
  }
  throw postError;
}
