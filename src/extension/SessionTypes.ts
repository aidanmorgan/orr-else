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
import type { RuntimeBudgetTracker } from '../core/RuntimeBudgetTracker.js';
import type { LoopDetector } from '../core/LoopDetector.js';
import type { ToolResultBase } from '../contract.js';

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

/**
 * The subset of per-invocation session state that ToolExecutionWrapper needs.
 *
 * pi-experiment-amq0.1: extracted so ToolExecutionWrapper can type its `session`
 * parameter without importing the full ExtensionSession from extension.ts.
 *
 * Only the fields actually READ or MUTATED by wrapPluginTool are included.
 */
export interface ToolExecutionSession {
  activeRun: ActiveRun | null;
  /** Per-(bead, tool) consecutive-failure counter.  Worker mode only. */
  toolBreakerFailures: Map<string, number>;
  /** In-session result memoisation for cacheable project tools. */
  toolResultCache: Map<string, { result: unknown; recordedAt: number; toolResult: ToolResultBase }>;
  /** Per-worker-run runtime budget tracker (6q0y.48). Null when no policy configured. */
  runtimeBudgetTracker: RuntimeBudgetTracker | null;
  /** Always-on structural loop detector (6q0y.49). Null before SESSION_START. */
  loopDetector: LoopDetector | null;
}
