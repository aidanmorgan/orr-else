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

export interface DomainEvent {
  id: string;
  type: DomainEventName | string;
  timestamp: string;
  sessionId: string;
  data: any;
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
  stateId?: string;
  actionId?: string;
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
  projectBead(beadId: string, options?: EventProjectionOptions): Promise<Partial<HarnessBeadMetadata>>;
  eventsForBead(beadId: string): Promise<DomainEvent[]>;
  eventsForBeads(beadIds: Iterable<string>): Promise<Map<string, DomainEvent[]>>;
  latestEventsForBeads(beadIds: Iterable<string>, options?: LatestEventFilterOptions): Promise<Map<string, DomainEvent>>;
  latestEventByType(type: DomainEventName | string): Promise<DomainEvent | undefined>;
  latestProjectToolFailureLimitEvent(beadId: string, options?: ProjectToolFailureLimitFilterOptions): Promise<DomainEvent | undefined>;
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
}
