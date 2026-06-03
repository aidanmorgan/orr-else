/**
 * Per-invocation session state types shared between extension.ts and
 * controller modules. These are pure interfaces — no process.env reads.
 */

import type { BeadId } from '../types/index.js';
import type { SDLCState, TeammateAction } from '../core/domain/StateModels.js';
import type { ChecklistItem } from '../core/ProtocolParser.js';
import type { ProgressManager } from '../core/ProgressManager.js';
import type { WorklogManager } from '../core/WorklogManager.js';
import type { DomainEvent } from '../core/EventStore.js';

export interface ActiveRun {
  beadId: BeadId;
  stateId: string;
  state: SDLCState;
  action: TeammateAction;
  requiredItems: ChecklistItem[];
  startedAt: number;
  worktreePath?: string;
  progressManager?: ProgressManager;
  worklogManager: WorklogManager;
  checkpointAccepted: boolean;
  /**
   * The summary provided to submit_checkpoint, set when the checkpoint is
   * accepted.  Used by the handoverRequired gate in evaluateGateReadiness:
   * when an action declares handoverRequired=true, this summary must be
   * substantive (>= HandoverRequiredDefaults.MIN_SUMMARY_CHARS) before the
   * advance-outcome gate allows completion.
   */
  handoverSummary?: string;
  parentSequenceCompleted: boolean;
  completedActionIds: string[];
  terminalFailureLimitScanned?: boolean;
  terminalFailureLimitScan?: Promise<DomainEvent | undefined>;
  terminalFailureLimitEvent?: DomainEvent;
  terminalFailureLimitResult?: Record<string, unknown>;
}
