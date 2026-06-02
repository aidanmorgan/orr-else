import { BeadStatus, EventName, RestartKind, TeammateEventType } from '../constants/index.js';
import type { BeadId } from './ids.js';

export type { BeadId } from './ids.js';

/**
 * Shared mutable holder for the SignalingServer's bound address (WI-7).
 * Created once in createRuntimeServices, mutated by startOrrElse after the
 * server binds. All TeammateFactory instances that hold a reference to this
 * object see the bound port at spawn time — no process.env mutation required.
 */
export interface ApiAddress {
  port?: string;
  base?: string;
}

export interface Bead {
  id: BeadId;
  title: string;
  status: string;
  priority?: number;
  description?: string;
  notes?: string;
  acceptance_criteria?: string;
  assigned_to?: string;
  worktree_path?: string;
  changed_files: string[];
  logs: string[];
  dependencies: BeadId[];
  checklists?: Record<string, { checked: boolean; evidence?: string }>;
  checkedItemsTruncated?: boolean;
  dynamicChecklists?: Record<string, unknown>;
  retryCount: number;
  compactionCount: number;
  lastActivity: string;
  subState?: string;
  totalExecutionTimeMs: number;
  handovers: Record<string, string>;
  handoversTruncated?: boolean;
  completedActionIds: string[];
  completedActionIdsTruncated?: boolean;
  restartRequested?: boolean;
  restartKind?: RestartKind | string;
  restartEvent?: string;
  restartFromState?: string;
  restartTargetState?: string;
  lease?: {
    owner: string;
    expiresAt: string;
  };
  leaseSessionId?: string;
}

export interface BeadDependencyRecord {
  issue_id: string;
  depends_on_id: string;
  type?: string;
  created_at?: string;
  created_by?: string;
}

export interface BeadCommentRecord {
  id: string;
  issue_id: string;
  author?: string;
  text: string;
  created_at: string;
}

export interface HarnessBeadMetadata {
  status?: string;
  notes?: string;
  assigned_to?: string;
  worktree_path?: string;
  changed_files?: string[];
  logs?: string[];
  checklists?: Record<string, { checked: boolean; evidence?: string }>;
  dynamicChecklists?: Record<string, unknown>;
  retryCount?: number;
  compactionCount?: number;
  lastActivity?: string;
  subState?: string;
  totalExecutionTimeMs?: number;
  handovers?: Record<string, string>;
  completedActionIds?: string[];
  restartRequested?: boolean;
  restartKind?: RestartKind | string;
  restartEvent?: string;
  restartFromState?: string;
  restartTargetState?: string;
  lease?: {
    owner: string;
    expiresAt: string;
  };
  leaseSessionId?: string;
  /** Set when a BEAD_TOMBSTONED event has been recorded — the task-store
   *  record no longer exists and this Bead must not be scheduled or counted
   *  as live/ready work. */
  tombstoned?: boolean;
}

export interface BeadsIssueRecord {
  _type?: 'issue';
  id: string;
  title: string;
  description?: string;
  acceptance_criteria?: string;
  notes?: string;
  status?: string;
  priority?: number;
  issue_type?: string;
  owner?: string;
  assignee?: string;
  created_at?: string;
  created_by?: string;
  updated_at?: string;
  labels?: string[];
  dependencies?: BeadDependencyRecord[];
  comments?: BeadCommentRecord[];
  dependency_count?: number;
  dependent_count?: number;
  comment_count?: number;
  [key: string]: unknown;
}

export interface TeammateSignal {
  beadId: BeadId;
  status: EventName | BeadStatus;
  summary: string;
  nextPhase?: string;
  handover?: string;
  event?: string;
  workerId?: string;
  actionId?: string;
  transitionEvent?: string;
  evidence?: string;
  idempotencyKey?: string;
}

export interface BeadPayload {
  title: string;
  status?: BeadStatus;
  description?: string;
  notes?: string;
  assigned_to?: string;
  worktree_path?: string;
  dependencies?: BeadId[];
}

export type {
  CheckpointAcceptedEvent,
  ContextRestartRequestedEvent,
  HeartbeatEvent,
  StateBlockedEvent,
  StateFailedEvent,
  StateStartedEvent,
  StateTransitionedEvent,
  StatusMutatingTeammateEventType,
  TeammateEvent,
  TeammateEventDecision,
  TeammateEventType,
  TeammateEventValidationResult,
  TeammateExitedEvent,
  TeammateStartedEvent
} from '../core/TeammateEvents.js';
