import { createHash } from 'node:crypto';
import { BeadId } from '../types/ids.js';
import {
  DomainEventName,
  EventName,
  EventProjectionDefaults,
  TeammateEventDecisionAction,
  TeammateEventType
} from '../constants/index.js';

export { TeammateEventType };

export type StatusMutatingTeammateEventType = 
  | TeammateEventType.STATE_TRANSITIONED
  | TeammateEventType.STATE_FAILED
  | TeammateEventType.STATE_BLOCKED
  | TeammateEventType.CONTEXT_RESTART_REQUESTED
  | TeammateEventType.HARNESS_RESTART_REQUESTED;

export const STATUS_MUTATING_EVENT_TYPES: Set<TeammateEventType> = new Set([
  TeammateEventType.STATE_TRANSITIONED,
  TeammateEventType.STATE_FAILED,
  TeammateEventType.STATE_BLOCKED,
  TeammateEventType.CONTEXT_RESTART_REQUESTED,
  TeammateEventType.HARNESS_RESTART_REQUESTED
]);

export function isStatusMutatingTeammateEvent(event: TeammateEvent): boolean {
  return STATUS_MUTATING_EVENT_TYPES.has(event.type as TeammateEventType);
}

export interface TeammateEventBase {
  type: TeammateEventType | string;
  beadId: BeadId;
  workerId: string;
  sessionStateId?: string;
  stateId: string;
  timestamp: number;
  idempotencyKey: string;
}

export interface TeammateStartedEvent extends TeammateEventBase {
  type: TeammateEventType.TEAMMATE_STARTED;
  pid: number;
}

export interface StateStartedEvent extends TeammateEventBase {
  type: TeammateEventType.STATE_STARTED;
}

export interface CheckpointAcceptedEvent extends TeammateEventBase {
  type: TeammateEventType.CHECKPOINT_ACCEPTED;
  actionId: string;
}

export interface StateTransitionedEvent extends TeammateEventBase {
  type: TeammateEventType.STATE_TRANSITIONED;
  actionId: string;
  transitionEvent: string;
  summary: string;
  evidence: string;
  handover: string;
}

export interface StateFailedEvent extends TeammateEventBase {
  type: TeammateEventType.STATE_FAILED;
  actionId: string;
  transitionEvent: EventName.FAILURE;
  summary: string;
  evidence: string;
  handover: string;
}

export interface StateBlockedEvent extends TeammateEventBase {
  type: TeammateEventType.STATE_BLOCKED;
  actionId: string;
  transitionEvent: EventName.BLOCKED;
  summary: string;
  evidence: string;
  handover: string;
}

export interface ContextRestartRequestedEvent extends TeammateEventBase {
  type: TeammateEventType.CONTEXT_RESTART_REQUESTED;
  actionId: string;
  transitionEvent: string;
  summary: string;
  evidence: string;
  handover: string;
}

export interface HarnessRestartRequestedEvent extends TeammateEventBase {
  type: TeammateEventType.HARNESS_RESTART_REQUESTED;
  actionId: string;
  transitionEvent: string;
  summary: string;
  evidence: string;
  handover: string;
}

export interface HeartbeatEvent extends TeammateEventBase {
  type: TeammateEventType.HEARTBEAT;
  pid?: number;
}

export interface TeammateExitedEvent extends TeammateEventBase {
  type: TeammateEventType.TEAMMATE_EXITED;
  summary: string;
  pauseUntilMs?: number;
  capacityLimited?: boolean;
}

export type TeammateEvent = 
  | TeammateStartedEvent
  | StateStartedEvent
  | CheckpointAcceptedEvent
  | StateTransitionedEvent
  | StateFailedEvent
  | StateBlockedEvent
  | ContextRestartRequestedEvent
  | HarnessRestartRequestedEvent
  | HeartbeatEvent
  | TeammateExitedEvent;

function hashText(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);
}

function keyPart(value: unknown, fallback = 'none'): string {
  const raw = String(value ?? fallback).trim() || fallback;
  return raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || fallback;
}

export function createTeammateEventIdempotencyKey(event: Partial<TeammateEvent>): string {
  const type = keyPart(event.type, 'UNKNOWN_EVENT');
  const beadId = keyPart(event.beadId, 'unknown-bead');
  const workerId = keyPart(event.workerId, 'unknown-worker');
  const stateId = keyPart(event.stateId, 'unknown-state');
  const anyEvent = event as Record<string, unknown>;

  if (event.type === TeammateEventType.HEARTBEAT) {
    return [type, beadId, workerId, stateId, 'liveness'].join('-');
  }

  if (event.type === TeammateEventType.CHECKPOINT_ACCEPTED) {
    return [
      type,
      beadId,
      workerId,
      keyPart(event.sessionStateId, 'session'),
      stateId,
      keyPart(anyEvent.actionId, 'action')
    ].join('-');
  }

  if (event.type && STATUS_MUTATING_EVENT_TYPES.has(event.type as TeammateEventType)) {
    return [
      type,
      beadId,
      workerId,
      keyPart(event.sessionStateId, 'session'),
      stateId,
      keyPart(anyEvent.actionId, 'action'),
      keyPart(anyEvent.transitionEvent, 'transition')
    ].join('-');
  }

  if (event.type === TeammateEventType.TEAMMATE_EXITED) {
    return [type, beadId, workerId, stateId, hashText(anyEvent.summary)].join('-');
  }

  const semanticPayload = { ...anyEvent };
  delete semanticPayload.timestamp;
  delete semanticPayload.idempotencyKey;
  return [type, beadId, workerId, stateId, hashText(semanticPayload)].join('-');
}

export interface RecordedDomainEventLike {
  type: string;
  data?: Record<string, unknown>;
}

function eventDataMatches(event: TeammateEvent, data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  if (data.idempotencyKey && data.idempotencyKey === event.idempotencyKey) return true;

  const anyEvent = event as unknown as Record<string, unknown>;
  const stateMatches = (data.fromState || data.stateId) === event.stateId;
  const actionMatches = !anyEvent.actionId || data.actionId === anyEvent.actionId;
  const transitionMatches = !anyEvent.transitionEvent || data.transitionEvent === anyEvent.transitionEvent;
  return stateMatches && actionMatches && transitionMatches;
}

export function findAppliedTeammateSignal(
  events: readonly RecordedDomainEventLike[],
  event: TeammateEvent
): RecordedDomainEventLike | undefined {
  for (const recorded of events) {
    if (event.type === TeammateEventType.CHECKPOINT_ACCEPTED) {
      if (recorded.type === DomainEventName.CHECKPOINT_SUBMITTED && eventDataMatches(event, recorded.data)) {
        return recorded;
      }
      continue;
    }

    if (
      event.type === TeammateEventType.STATE_TRANSITIONED
      || event.type === TeammateEventType.STATE_FAILED
      || event.type === TeammateEventType.STATE_BLOCKED
    ) {
      if (recorded.type === DomainEventName.STATE_TRANSITION_APPLIED && eventDataMatches(event, recorded.data)) {
        return recorded;
      }
      continue;
    }

    if (event.type === TeammateEventType.CONTEXT_RESTART_REQUESTED) {
      if (recorded.type === DomainEventName.CONTEXT_RESTART_REQUESTED && eventDataMatches(event, recorded.data)) {
        return recorded;
      }
      continue;
    }

    if (event.type === TeammateEventType.HARNESS_RESTART_REQUESTED) {
      if (recorded.type === DomainEventName.HARNESS_RESTART_REQUESTED && eventDataMatches(event, recorded.data)) {
        return recorded;
      }
    }
  }
  return undefined;
}

export interface TeammateEventDecision {
  action: TeammateEventDecisionAction;
  reason?: string;
}

export function decideTeammateEventProcessing(
  event: TeammateEvent, 
  processedKeys: Set<string>, 
  currentStateId?: string
): TeammateEventDecision {
  if (processedKeys.has(event.idempotencyKey)) {
    return { action: TeammateEventDecisionAction.DUPLICATE, reason: 'Already processed idempotency key' };
  }

  // Heartbeats and startup signals are always acceptable regardless of phase
  if (event.type === TeammateEventType.HEARTBEAT || event.type === TeammateEventType.TEAMMATE_STARTED) {
    return { action: TeammateEventDecisionAction.ACCEPT };
  }

  // Phase signals must match the expected coordinator state for that Bead
  if (currentStateId && currentStateId !== event.stateId) {
    return {
      action: TeammateEventDecisionAction.IGNORE,
      reason: `Out-of-order teammate event for ${event.stateId}; current Bead state is ${currentStateId}`
    };
  }

  return { action: TeammateEventDecisionAction.ACCEPT };
}

export interface TeammateEventValidationResult {
  ok: boolean;
  error?: string;
  event?: TeammateEvent;
}

function requireStrings(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof obj[key] !== 'string' || !obj[key].trim()) {
      return `Missing required string field: ${key}`;
    }
  }
  return undefined;
}

export function validateTeammateEvent(value: unknown): TeammateEventValidationResult {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Event must be an object' };

  const obj = value as Record<string, unknown>;
  const baseError = requireStrings(obj, ['beadId', 'workerId', 'stateId', 'idempotencyKey']);
  if (baseError) return { ok: false, error: baseError };

  if (typeof obj.timestamp !== 'number') return { ok: false, error: 'timestamp must be a number' };
  if (!Object.values(TeammateEventType).includes(obj.type as TeammateEventType)) return { ok: false, error: `Invalid event type: ${obj.type}` };

  const type = obj.type as TeammateEventType;

  if (type === TeammateEventType.CHECKPOINT_ACCEPTED) {
    const error = requireStrings(obj, ['actionId']);
    if (error) return { ok: false, error };
  }

  if (
    type === TeammateEventType.STATE_TRANSITIONED
    || type === TeammateEventType.STATE_FAILED
    || type === TeammateEventType.STATE_BLOCKED
    || type === TeammateEventType.CONTEXT_RESTART_REQUESTED
    || type === TeammateEventType.HARNESS_RESTART_REQUESTED
  ) {
    const error = requireStrings(obj, ['actionId', 'transitionEvent', 'summary', 'evidence', 'handover']);
    if (error) return { ok: false, error };
    return { ok: true, event: { ...obj, handover: truncateHandover(obj.handover as string) } as TeammateEvent };
  }

  return { ok: true, event: obj as unknown as TeammateEvent };
}

function truncateHandover(handover: string): string {
  if (handover.length <= EventProjectionDefaults.HANDOVER_WRITE_MAX_BYTES) return handover;
  const head = handover.slice(0, EventProjectionDefaults.HANDOVER_WRITE_MAX_BYTES);
  return `${head}\n…[handover truncated at ${EventProjectionDefaults.HANDOVER_WRITE_MAX_BYTES} bytes; ${handover.length - EventProjectionDefaults.HANDOVER_WRITE_MAX_BYTES} bytes elided]`;
}
