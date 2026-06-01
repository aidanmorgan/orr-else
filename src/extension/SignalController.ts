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
import { postHarnessSignal } from '../core/HarnessApiClient.js';
import type { RuntimeServices } from '../core/RuntimeServices.js';
import { DomainEventName } from '../constants/index.js';
import type { TeammateEventType } from '../constants/index.js';

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
  fields: Partial<TeammateEvent> & Record<string, unknown>,
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

  try {
    await postHarnessSignal(event);
    await services.eventStore.record(DomainEventName.SIGNAL_ACKNOWLEDGED, teammateSignalEventData(event));
    return;
  } catch (error) {
    const applied = await hasAppliedTeammateSignal(services, event).catch(() => false);
    await services.eventStore.record(DomainEventName.TEAMMATE_SIGNAL_FAILED, {
      ...teammateSignalEventData(event),
      error: String(error),
      appliedAfterTransportFailure: applied
    }).catch(() => {});

    if (applied) {
      await services.eventStore.record(DomainEventName.SIGNAL_ACKNOWLEDGED, {
        ...teammateSignalEventData(event),
        source: 'event-store-reconcile'
      });
      return;
    }
    throw error;
  }
}
