/**
 * Shared type definitions for the EventStore module family.
 * Extracted so BeadEventIndex and BeadStateProjection can reference them
 * without creating a circular import with EventStore.
 *
 * EventStore re-exports all of these so existing callers are unaffected.
 */

import type { DomainEventName } from '../constants/index.js';
import type { HarnessBeadMetadata } from '../types/index.js';
import type { RestartKind, MergeAndCommitStatus } from '../constants/index.js';
import type { BeadId, EventId, SessionId, StateId, ActionId, ToolName } from '../types/ids.js';

/**
 * The CANONICAL tool-result base now lives in the harness-owned contract module
 * (`orr-else/contract`, src/contract.ts) so there is ONE definition shared by
 * the tools, the verifier, and this event-payload layer. We re-export it here
 * so existing callers that pull ToolResultBase off this module stay unaffected
 * (pi-experiment-0yt5.15 reconciles the pf7v duplicate).
 *
 * EventStoreTypes importing FROM the lean contract is fine; the contract must
 * never import EventStoreTypes (that would make the contract graph heavy).
 */
export type { ToolResultBase } from '../contract.js';

/**
 * The payload carried across the EventStore persistence boundary.
 *
 * Events are heterogeneous (one shape per DomainEventName), so the payload is a
 * structurally-open record of `unknown` values rather than `any`. `unknown`
 * forces every reader to narrow (via {@link isRecord}, an `as` cast, or a
 * comparison) before drilling in, so a typo on a field name is a compile error
 * instead of a silent `undefined` — exactly the safety `any` was throwing away.
 */
export type EventData = Record<string, unknown>;

export interface DomainEvent {
  id: EventId;
  type: DomainEventName | string;
  timestamp: string;
  sessionId: SessionId;
  data: EventData;
}

export interface EventProjectionOptions {
  includeDetails?: boolean;
}

export interface LatestEventFilterOptions {
  excludeTypes?: readonly string[];
  excludeTeammateEventTypes?: readonly string[];
  excludeToolNames?: readonly string[];
}

export interface ProjectToolFailureLimitFilterOptions {
  stateId?: StateId;
  actionId?: ActionId;
  terminalOnly?: boolean;
}

/**
 * Narrow read/record surface of the EventStore that the Supervisor (and the
 * coordinator-side artifact-presence gate, 0yt5.20) actually consume.
 *
 * Declaring this interface lets the Supervisor depend on a structural contract
 * rather than the concrete `EventStore` class, so test doubles are checked at
 * compile time: a mock typed against `ProjectionCapableStore` that omits a
 * method (e.g. `latestProjectToolFailureLimitEvent`) is a tsc error instead of
 * a runtime crash. The real `EventStore` class structurally satisfies this
 * interface (see the `_check` conformance assertion in EventStore.ts).
 *
 * It lists EVERY EventStore method the Supervisor calls — keep it in sync when
 * the Supervisor reaches for a new EventStore method.
 */
export interface ProjectionCapableStore {
  record(event: DomainEventName | string, data: unknown): Promise<void>;
  readAll(): Promise<DomainEvent[]>;
  projectBead(beadId: BeadId, options?: EventProjectionOptions): Promise<Partial<HarnessBeadMetadata>>;
  eventsForBead(beadId: BeadId): Promise<DomainEvent[]>;
  eventsForBeads(beadIds: Iterable<BeadId>): Promise<Map<BeadId, DomainEvent[]>>;
  latestEventsForBeads(beadIds: Iterable<BeadId>, options?: LatestEventFilterOptions): Promise<Map<BeadId, DomainEvent>>;
  latestEventByType(type: DomainEventName | string): Promise<DomainEvent | undefined>;
  latestProjectToolFailureLimitEvent(beadId: BeadId, options?: ProjectToolFailureLimitFilterOptions): Promise<DomainEvent | undefined>;
  /**
   * Latest tool-result event for one (beadId, stateId, actionId, tool) tuple.
   * Reconciles the FLAT (command/MCP) and NESTED (plugin) recorded shapes so
   * the coordinator-side verifier gate can recover a tool's outputFile + run
   * status (pi-experiment-0yt5.5).
   */
  latestToolResultEvent(beadId: BeadId, stateId: StateId, actionId: ActionId, tool: ToolName): Promise<DomainEvent | undefined>;
}

export interface BeadStateTransitionProjection {
  eventId: string;
  sessionId: string;
  timestamp: string;
  fromState?: string;
  toState?: string;
  transitionEvent?: string;
  actionId?: string;
  summary?: string;
  evidence?: string;
}

export interface BeadStateChartProjection {
  beadId: string;
  currentState?: string;
  previousState?: string;
  beadStatus?: string;
  activeActionId?: string;
  assignedTo?: string;
  lease?: HarnessBeadMetadata['lease'];
  leaseSessionId?: string;
  worktreePath?: string;
  /** True when a BEAD_TOMBSTONED event has been recorded for this Bead —
   *  the task-store record no longer exists and the Bead must not be
   *  scheduled or counted as live/ready work. */
  tombstoned?: boolean;
  handovers: Record<string, string>;
  completedActionIds: string[];
  compactionCount?: number;
  checkedItems: Record<string, { checked: boolean; evidence?: string }>;
  addedChecklistItems: Array<{ text?: string; mandatory?: boolean; type?: string; source?: string; stateId?: string; actionId?: string; timestamp: string }>;
  checkpoints: Array<{ actionId?: string; summary?: string; evidence?: string; timestamp: string; sessionId: string }>;
  reviewArtifacts: Array<{
    eventType: string;
    artifactKind?: string;
    stateId?: string;
    actionId?: string;
    summary?: string;
    verdict?: string;
    outcome?: string;
    timestamp: string;
    sessionId: string;
  }>;
  transitions: BeadStateTransitionProjection[];
  restartRequested?: boolean;
  restartKind?: RestartKind | string;
  restartEvent?: string;
  restartFromState?: string;
  restartTargetState?: string;
  mergeAndCommit?: {
    status: MergeAndCommitStatus;
    branchName?: string;
    targetBranch?: string;
    message?: string;
    error?: string;
    timestamp: string;
    sessionId: string;
  };
  lastEventId?: string;
  lastUpdatedAt?: string;
  /**
   * Deterministic corruption diagnostics (pi-experiment-rpa0).
   *
   * Each entry describes one event that was REJECTED by the fail-closed
   * transition guard — missing required fields on STATE_TRANSITION_APPLIED
   * prevented the event from altering bead state. Callers can surface these
   * for operator alerting or log analysis without crashing projection.
   */
  corruptionDiagnostics?: Array<{
    eventId: string;
    eventType: string;
    timestamp: string;
    missingFields: string[];
    reason: string;
  }>;
}
