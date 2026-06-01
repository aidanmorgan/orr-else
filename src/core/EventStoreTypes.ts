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
