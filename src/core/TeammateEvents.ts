import { BeadId } from '../types/index.js';
import { EventName, TeammateEventDecisionAction, TeammateEventType } from '../constants/index.js';

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

export function createTeammateEventIdempotencyKey(event: Partial<TeammateEvent>): string {
  return `${event.type}-${event.beadId}-${event.workerId}-${event.timestamp}`;
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

function requireStrings(obj: any, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof obj[key] !== 'string' || !obj[key].trim()) {
      return `Missing required string field: ${key}`;
    }
  }
  return undefined;
}

export function validateTeammateEvent(value: any): TeammateEventValidationResult {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Event must be an object' };
  
  const baseError = requireStrings(value, ['beadId', 'workerId', 'stateId', 'idempotencyKey']);
  if (baseError) return { ok: false, error: baseError };
  
  if (typeof value.timestamp !== 'number') return { ok: false, error: 'timestamp must be a number' };
  if (!Object.values(TeammateEventType).includes(value.type)) return { ok: false, error: `Invalid event type: ${value.type}` };

  const type = value.type as TeammateEventType;

  if (type === TeammateEventType.CHECKPOINT_ACCEPTED) {
    const error = requireStrings(value, ['actionId']);
    if (error) return { ok: false, error };
  }

  if (
    type === TeammateEventType.STATE_TRANSITIONED
    || type === TeammateEventType.STATE_FAILED
    || type === TeammateEventType.STATE_BLOCKED
    || type === TeammateEventType.CONTEXT_RESTART_REQUESTED
    || type === TeammateEventType.HARNESS_RESTART_REQUESTED
  ) {
    const error = requireStrings(value, ['actionId', 'transitionEvent', 'summary', 'evidence', 'handover']);
    if (error) return { ok: false, error };
  }

  return { ok: true, event: value as TeammateEvent };
}
