/**
 * BeadStateProjection – pure projection logic extracted from EventStore.
 * Structural split only; all semantics are byte-identical to the original.
 *
 * Responsibilities:
 *  - projectBeadStateChartFromEvents  (WI-24 stateChart-authoritative restart fields)
 *  - projectBeadFromEvents            (HarnessBeadMetadata projection, delegates to stateChart)
 *  - Text compaction helpers (handover truncation, lifecycle-failure summaries)
 *  - Workflow-scoping helpers (actionKey prefix, eventAppliesToWorkflow, completedAction)
 */

import { isRecord, mergeReplacingArraysAndDeletingUndefined } from './RecordUtils.js';
import { isRestartTransition } from './EventUtils.js';
import {
  ActionCompletionKey,
  AgentFailureCode,
  AgentFailureSummary,
  BeadStatus,
  DomainEventName,
  EventName,
  EventProjectionDefaults,
  MergeAndCommitStatus,
  RestartKind,
  ReviewArtifactKind,
  TeammateEventType
} from '../constants/index.js';
import type { HarnessBeadMetadata } from '../types/index.js';
import type {
  DomainEvent,
  EventProjectionOptions,
  BeadStateChartProjection,
  BeadStateTransitionProjection
} from './EventStoreTypes.js';

/**
 * Event types that represent supervisor-internal scheduling bookkeeping rather
 * than genuine bead activity, and therefore must NOT advance `lastActivity`.
 * See the quarantine self-invalidation regression (kwdh).
 */
const NON_ACTIVITY_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  DomainEventName.BEAD_QUARANTINED
]);

/** Shape of each entry inside a dynamicChecklists run-bucket's `items` array. */
interface DynamicChecklistItem {
  text: string;
  mandatory?: boolean;
  type?: string;
  metadata?: { source?: string };
}

/** Shape of a dynamicChecklists run-bucket value. */
interface DynamicChecklistRun {
  items?: DynamicChecklistItem[];
  updatedAt?: string;
  [key: string]: unknown;
}

export class BeadStateProjection {
  // ---------------------------------------------------------------------------
  // Text compaction helpers
  // ---------------------------------------------------------------------------

  private includeDetails(options?: EventProjectionOptions): boolean {
    return options?.includeDetails !== false;
  }

  private truncateText(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}... [truncated; full value remains in the event store]`;
  }

  private lifecycleFailureSummary(value: string): string | undefined {
    const normalized = value.toLowerCase();
    if (
      normalized.includes(AgentFailureCode.USAGE_LIMIT_REACHED)
      || normalized.includes('usage limit has been reached')
    ) {
      return `${AgentFailureSummary.USAGE_LIMIT} ${AgentFailureSummary.EVENT_STORE_DETAILS}`;
    }
    if (
      normalized.includes(AgentFailureCode.CONTEXT_LENGTH_EXCEEDED)
      || normalized.includes('context length exceeded')
      || normalized.includes('context window')
    ) {
      return `${AgentFailureSummary.CONTEXT_OVERFLOW} ${AgentFailureSummary.EVENT_STORE_DETAILS}`;
    }
    if (
      normalized.includes(AgentFailureCode.WEBSOCKET_ERROR)
      || normalized.includes(AgentFailureCode.WEBSOCKET_CLOSED)
      || normalized.includes(AgentFailureCode.CONNECTION_RESET)
      || normalized.includes(AgentFailureCode.NETWORK_ERROR)
    ) {
      return `${AgentFailureSummary.HARNESS_TRANSIENT} ${AgentFailureSummary.EVENT_STORE_DETAILS}`;
    }
    return undefined;
  }

  private compactHandover(value: string): string {
    return this.lifecycleFailureSummary(value)
      || this.truncateText(value, EventProjectionDefaults.HANDOVER_PREVIEW_CHARS);
  }

  private compactDetail(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    return this.compactHandover(value);
  }

  private compactHandovers(handovers: Record<string, unknown>): Record<string, string> {
    const compacted: Record<string, string> = {};
    for (const [stateId, handover] of Object.entries(handovers)) {
      if (typeof handover === 'string') compacted[stateId] = this.compactHandover(handover);
    }
    return compacted;
  }

  // ---------------------------------------------------------------------------
  // Workflow-scoping helpers
  // ---------------------------------------------------------------------------

  private workflowActionPrefix(workflowVersion?: string): string | undefined {
    const normalized = workflowVersion?.trim();
    if (!normalized) return undefined;
    return `${ActionCompletionKey.WORKFLOW_PREFIX}=${normalized}${ActionCompletionKey.FIELD_SEPARATOR}`;
  }

  /**
   * Reads an event's payload as a loose, string-keyed JSON record.
   *
   * The persistence boundary types `DomainEvent.data` as `EventData`
   * (Record<string, unknown>) so producers/readers narrow explicitly (pf7v).
   * This projection consumes dozens of optional, event-type-specific fields and
   * validates each inline (`typeof`, truthiness) before use, so it reads the
   * payload through this single documented widening rather than `as`-casting at
   * every field — matching the `Record<string, any>` shape its own helpers
   * (`eventAppliesToWorkflow`, `completedActionFromData`) already accept.
   */
  private eventData(event: DomainEvent): Record<string, any> {
    return event.data;
  }

  private eventAppliesToWorkflow(data: Record<string, any>, workflowVersion?: string): boolean {
    const prefix = this.workflowActionPrefix(workflowVersion);
    if (!prefix) return true;
    return typeof data.actionKey === 'string' && data.actionKey.startsWith(prefix);
  }

  private completedActionFromData(data: Record<string, any>, workflowVersion?: string): unknown {
    if (!workflowVersion?.trim()) return data.actionKey || data.actionId;
    return this.eventAppliesToWorkflow(data, workflowVersion) ? data.actionKey : undefined;
  }

  // ---------------------------------------------------------------------------
  // Advance-outcome predicate helper
  // ---------------------------------------------------------------------------

  /**
   * Default advance-outcome set — must NOT import FlowManager or ConfigLoader
   * (layering constraint: core must not depend on plugins).  When callers thread
   * an explicit set the default is not used.
   */
  private static readonly DEFAULT_ADVANCE_OUTCOMES: ReadonlySet<string> = new Set([EventName.SUCCESS]);

  private makeAdvancePredicate(advanceOutcomes?: Set<string>): (outcome: string | null | undefined) => boolean {
    const set = advanceOutcomes ?? BeadStateProjection.DEFAULT_ADVANCE_OUTCOMES;
    // A falsy/missing outcome must return false — matching the old literal-comparison
    // semantics where `undefined === EventName.SUCCESS` was false (no action-completion
    // recorded for legacy/replayed STATE_TRANSITION_APPLIED events with no transitionEvent).
    return (outcome: string | null | undefined) => {
      if (!outcome || typeof outcome !== 'string') return false;
      return set.has(outcome.toUpperCase()) || set.has(outcome);
    };
  }

  // ---------------------------------------------------------------------------
  // projectBeadStateChartFromEvents
  // ---------------------------------------------------------------------------

  projectBeadStateChartFromEvents(
    beadId: string,
    events: DomainEvent[],
    workflowVersion?: string,
    options: EventProjectionOptions = {},
    advanceOutcomes?: Set<string>
  ): BeadStateChartProjection {
    const isAdvanceOutcome = this.makeAdvancePredicate(advanceOutcomes);
    const includeDetails = this.includeDetails(options);
    const projection: BeadStateChartProjection = {
      beadId,
      handovers: {},
      completedActionIds: [],
      checkedItems: {},
      addedChecklistItems: [],
      checkpoints: [],
      reviewArtifacts: [],
      transitions: []
    };

    const completeAction = (actionId: unknown): void => {
      if (typeof actionId !== 'string' || !actionId) return;
      projection.completedActionIds = [
        ...new Set([...projection.completedActionIds, actionId])
      ];
    };

    const applyRestart = (event: DomainEvent, kind: RestartKind): void => {
      const data = this.eventData(event);
      projection.restartRequested = true;
      projection.restartKind = kind;
      projection.restartEvent = data.transitionEvent;
      projection.restartFromState = data.stateId;
      projection.restartTargetState = data.targetState || data.stateId;
      if (data.targetState) projection.currentState = data.targetState;
      if (includeDetails) completeAction(this.completedActionFromData(data, workflowVersion));
      if (includeDetails && this.eventAppliesToWorkflow(data, workflowVersion) && typeof data.handover === 'string' && data.stateId) {
        projection.handovers[data.stateId] = this.compactHandover(data.handover);
      }
    };

    for (const event of events) {
      const data = this.eventData(event);
      // Synthetic events are filtered at the EventStore read layer (eventsForBeads).
      // This guard is retained so BeadStateProjection remains correct when called
      // directly (e.g. in unit tests) with a raw event list that may include
      // synthetic events — it does not fire in production (events are pre-filtered).
      if (data.synthetic === true) continue;
      projection.lastEventId = event.id;
      projection.lastUpdatedAt = event.timestamp;

      if (includeDetails && data.artifactKind === ReviewArtifactKind.SHIP_POST_REVIEW) {
        projection.reviewArtifacts.push({
          eventType: event.type,
          artifactKind: data.artifactKind,
          stateId: data.stateId,
          actionId: data.actionId,
          summary: this.compactDetail(data.summary),
          verdict: typeof data.verdict === 'string' ? data.verdict : undefined,
          outcome: typeof data.outcome === 'string' ? data.outcome : undefined,
          timestamp: event.timestamp,
          sessionId: event.sessionId
        });
      }

      switch (event.type) {
        case DomainEventName.BEAD_CLAIMED:
          projection.currentState = data.stateId || projection.currentState;
          projection.assignedTo = data.owner || projection.assignedTo;
          projection.lease = data.lease || projection.lease;
          projection.leaseSessionId = data.lease ? event.sessionId : projection.leaseSessionId;
          projection.restartRequested = data.restartRequested || false;
          projection.restartKind = data.restartKind;
          projection.restartEvent = data.restartEvent;
          projection.restartFromState = data.restartFromState;
          projection.restartTargetState = data.restartTargetState;
          break;
        case DomainEventName.STATE_RUN_INITIALIZED:
          if (this.eventAppliesToWorkflow(data, workflowVersion)) {
            projection.currentState = data.stateId || projection.currentState;
            projection.activeActionId = data.actionId || projection.activeActionId;
          }
          break;
        case DomainEventName.ACTION_COMPLETED:
          if (includeDetails) completeAction(this.completedActionFromData(data, workflowVersion));
          break;
        case DomainEventName.TEAMMATE_SPAWNED:
          projection.currentState = data.stateId || projection.currentState;
          projection.worktreePath = data.worktreePath || projection.worktreePath;
          break;
        case DomainEventName.STATE_TRANSITION_APPLIED:
          if (this.eventAppliesToWorkflow(data, workflowVersion)) {
            projection.previousState = data.fromState || projection.currentState;
            projection.currentState = data.nextState || projection.currentState;
            projection.activeActionId = undefined;
            if (includeDetails) {
              const transition: BeadStateTransitionProjection = {
                eventId: event.id,
                sessionId: event.sessionId,
                timestamp: event.timestamp,
                fromState: data.fromState,
                toState: data.nextState,
                transitionEvent: data.transitionEvent,
                actionId: data.actionId,
                summary: this.compactDetail(data.summary),
                evidence: this.compactDetail(data.evidence)
              };
              projection.transitions.push(transition);
            }
          }
          if (includeDetails && this.eventAppliesToWorkflow(data, workflowVersion) && typeof data.handover === 'string' && data.fromState) {
            projection.handovers[data.fromState] = this.compactHandover(data.handover);
          }
          if (includeDetails && isAdvanceOutcome(data.transitionEvent)) completeAction(this.completedActionFromData(data, workflowVersion));
          projection.restartRequested = false;
          projection.restartKind = undefined;
          projection.restartEvent = undefined;
          projection.restartFromState = undefined;
          projection.restartTargetState = undefined;
          break;
        case DomainEventName.CONTEXT_RESTART_REQUESTED:
          applyRestart(event, RestartKind.CONTEXT);
          break;
        case DomainEventName.HARNESS_RESTART_REQUESTED:
          applyRestart(event, RestartKind.HARNESS);
          break;
        case DomainEventName.CHECKLIST_ITEM_TICKED:
          if (includeDetails && this.eventAppliesToWorkflow(data, workflowVersion) && typeof data.text === 'string') {
            projection.checkedItems[data.text] = { checked: true, evidence: data.evidence };
          }
          break;
        case DomainEventName.CHECKLIST_ITEM_ADDED:
          if (includeDetails && this.eventAppliesToWorkflow(data, workflowVersion) && (data.item?.text || data.text)) {
            const text = data.item?.text || data.text;
            const existing = projection.addedChecklistItems.find(item =>
              item.text === text &&
              item.stateId === data.stateId &&
              item.actionId === data.actionId
            );
            const nextItem = {
              text,
              mandatory: data.item?.mandatory ?? data.mandatory,
              type: data.item?.type || data.type,
              source: data.source,
              stateId: data.stateId,
              actionId: data.actionId,
              timestamp: event.timestamp
            };
            if (existing) {
              if (nextItem.mandatory === true) existing.mandatory = true;
              existing.type = existing.type || nextItem.type;
              existing.source = existing.source || nextItem.source;
              existing.timestamp = nextItem.timestamp;
            } else {
              projection.addedChecklistItems.push(nextItem);
            }
          }
          break;
        case DomainEventName.CHECKPOINT_SUBMITTED:
          if (includeDetails && this.eventAppliesToWorkflow(data, workflowVersion)) {
            projection.checkpoints.push({
              actionId: data.actionId,
              summary: this.compactDetail(data.summary),
              evidence: this.compactDetail(data.evidence),
              timestamp: event.timestamp,
              sessionId: event.sessionId
            });
          }
          break;
        case DomainEventName.CONTEXT_COMPACTION_RECORDED:
          projection.compactionCount = data.compactionCount || projection.compactionCount;
          break;
        case DomainEventName.WORKTREE_CREATED:
        case DomainEventName.WORKTREE_REUSED:
        case DomainEventName.WORKTREE_PROVISIONED:
          projection.worktreePath = data.path || data.worktreePath || projection.worktreePath;
          break;
        case DomainEventName.WORKTREE_REMOVED:
          projection.worktreePath = undefined;
          break;
        case DomainEventName.MERGE_AND_COMMIT_STARTED:
          projection.mergeAndCommit = {
            status: MergeAndCommitStatus.STARTED,
            branchName: data.branchName,
            targetBranch: data.targetBranch,
            message: data.message,
            timestamp: event.timestamp,
            sessionId: event.sessionId
          };
          break;
        case DomainEventName.MERGE_AND_COMMIT_SUCCEEDED:
          projection.mergeAndCommit = {
            status: MergeAndCommitStatus.SUCCEEDED,
            branchName: data.branchName,
            targetBranch: data.targetBranch,
            message: data.message,
            timestamp: event.timestamp,
            sessionId: event.sessionId
          };
          break;
        case DomainEventName.MERGE_AND_COMMIT_FAILED:
          projection.mergeAndCommit = {
            status: MergeAndCommitStatus.FAILED,
            targetBranch: data.targetBranch,
            error: data.error,
            timestamp: event.timestamp,
            sessionId: event.sessionId
          };
          break;
        case DomainEventName.BEAD_STATUS_UPDATED:
          projection.beadStatus = data.status || projection.beadStatus;
          break;
        case DomainEventName.BEAD_CLOSED:
          projection.beadStatus = BeadStatus.COMPLETED;
          projection.currentState = projection.currentState || BeadStatus.COMPLETED;
          projection.lease = undefined;
          projection.leaseSessionId = undefined;
          break;
        case DomainEventName.BEAD_RELEASED:
          projection.lease = undefined;
          projection.leaseSessionId = undefined;
          break;
        case DomainEventName.BEAD_TOMBSTONED:
          projection.tombstoned = true;
          projection.lease = undefined;
          projection.leaseSessionId = undefined;
          break;
      }
    }

    return projection;
  }

  // ---------------------------------------------------------------------------
  // projectBeadFromEvents
  // ---------------------------------------------------------------------------

  projectBeadFromEvents(
    beadId: string,
    events: DomainEvent[],
    workflowVersion?: string,
    options: EventProjectionOptions = {},
    advanceOutcomes?: Set<string>
  ): Partial<HarnessBeadMetadata> {
    const isAdvanceOutcome = this.makeAdvancePredicate(advanceOutcomes);
    const projection: Partial<HarnessBeadMetadata> = {};
    const includeDetails = this.includeDetails(options);
    for (const event of events) {
      const data = this.eventData(event);
      // Synthetic events are filtered at the EventStore read layer (eventsForBeads).
      // This guard is retained so BeadStateProjection remains correct when called
      // directly (e.g. in unit tests) with a raw event list that may include
      // synthetic events — it does not fire in production (events are pre-filtered).
      if (data.synthetic === true) continue;
      // lastActivity tracks genuine bead activity. Supervisor-internal scheduling
      // bookkeeping (e.g. BEAD_QUARANTINED) must NOT advance it: the quarantine
      // signature is derived from status+lastActivity, so bumping lastActivity on
      // the quarantine event itself would clear the quarantine on the next scan
      // and churn the bead every tick (kwdh).
      if (!NON_ACTIVITY_EVENT_TYPES.has(event.type)) {
        projection.lastActivity = event.timestamp;
      }
      switch (event.type) {
        case DomainEventName.BEAD_CLAIMED:
          Object.assign(projection, mergeReplacingArraysAndDeletingUndefined(projection, {
            status: data.stateId,
            assigned_to: data.owner,
            lease: data.lease,
            leaseSessionId: data.lease ? event.sessionId : undefined,
            restartRequested: data.restartRequested,
            restartKind: data.restartKind,
            restartEvent: data.restartEvent,
            restartFromState: data.restartFromState,
            restartTargetState: data.restartTargetState
          }));
          break;
        case DomainEventName.WORKTREE_CREATED:
        case DomainEventName.WORKTREE_REUSED:
        case DomainEventName.WORKTREE_PROVISIONED:
          if (data.path || data.worktreePath) projection.worktree_path = data.path || data.worktreePath;
          break;
        case DomainEventName.WORKTREE_REMOVED:
          delete projection.worktree_path;
          break;
        case DomainEventName.TEAMMATE_SPAWNED:
          if (data.stateId) projection.status = data.stateId;
          if (data.worktreePath) projection.worktree_path = data.worktreePath;
          break;
        case DomainEventName.STATE_RUN_INITIALIZED:
          if (this.eventAppliesToWorkflow(data, workflowVersion) && data.stateId) projection.status = data.stateId;
          break;
        case DomainEventName.ACTION_COMPLETED:
          {
            const completedAction = this.completedActionFromData(data, workflowVersion);
            if (!completedAction || typeof completedAction !== 'string') break;
            projection.completedActionIds = [
              ...new Set([...(projection.completedActionIds || []), completedAction])
            ];
          }
          break;
        case DomainEventName.STATE_TRANSITION_APPLIED:
          if (this.eventAppliesToWorkflow(data, workflowVersion) && data.nextState) projection.status = data.nextState;
          if (includeDetails && this.eventAppliesToWorkflow(data, workflowVersion) && data.handover && data.fromState) {
              projection.handovers = {
                ...(projection.handovers || {}),
                [data.fromState]: this.compactHandover(data.handover)
              };
            }
          if (isAdvanceOutcome(data.transitionEvent)) {
            const completedAction = this.completedActionFromData(data, workflowVersion);
            if (completedAction && typeof completedAction === 'string') {
              projection.completedActionIds = [
                ...new Set([...(projection.completedActionIds || []), completedAction])
              ];
            }
          }
          break;
        case DomainEventName.CONTEXT_RESTART_REQUESTED:
        case DomainEventName.HARNESS_RESTART_REQUESTED:
          break;
        case DomainEventName.BEAD_RELEASED:
          delete projection.lease;
          delete projection.leaseSessionId;
          break;
        case DomainEventName.BEAD_TOMBSTONED:
          projection.tombstoned = true;
          delete projection.lease;
          delete projection.leaseSessionId;
          break;
        case DomainEventName.BEAD_STATUS_UPDATED:
          if (data.status) projection.status = data.status;
          break;
        case DomainEventName.BEAD_CLOSED:
          projection.status = BeadStatus.COMPLETED;
          delete projection.lease;
          delete projection.leaseSessionId;
          break;
        case DomainEventName.CHECKLIST_ITEM_TICKED:
          if (includeDetails && this.eventAppliesToWorkflow(data, workflowVersion) && typeof data.text === 'string') {
            projection.checklists = {
              ...(projection.checklists || {}),
              [data.text]: { checked: true, evidence: data.evidence }
            };
          }
          break;
        case DomainEventName.CONTEXT_COMPACTION_RECORDED:
          if (typeof data.compactionCount === 'number') projection.compactionCount = data.compactionCount;
          break;
      }
    }

    const stateChart = this.projectBeadStateChartFromEvents(beadId, events, workflowVersion, options, advanceOutcomes);
    const workflowScoped = !!workflowVersion?.trim();
    if (stateChart.currentState) projection.status = stateChart.currentState;
    if (stateChart.beadStatus) projection.status = stateChart.beadStatus;
    if (stateChart.worktreePath) projection.worktree_path = stateChart.worktreePath;
    if (includeDetails && isRecord(projection.handovers)) {
      projection.handovers = this.compactHandovers(projection.handovers);
    }
    if (includeDetails && (Object.keys(stateChart.handovers).length > 0 || workflowScoped)) projection.handovers = stateChart.handovers;
    if (includeDetails && (stateChart.completedActionIds.length > 0 || workflowScoped)) projection.completedActionIds = stateChart.completedActionIds;
    if (stateChart.compactionCount !== undefined) projection.compactionCount = stateChart.compactionCount;
    if (includeDetails && (Object.keys(stateChart.checkedItems).length > 0 || workflowScoped)) projection.checklists = stateChart.checkedItems;
    if (stateChart.assignedTo) projection.assigned_to = stateChart.assignedTo;
    if (stateChart.lease) projection.lease = stateChart.lease;
    if (stateChart.leaseSessionId) projection.leaseSessionId = stateChart.leaseSessionId;
    if (stateChart.restartRequested !== undefined) projection.restartRequested = stateChart.restartRequested;
    projection.restartKind = stateChart.restartKind;
    projection.restartEvent = stateChart.restartEvent;
    projection.restartFromState = stateChart.restartFromState;
    projection.restartTargetState = stateChart.restartTargetState;
    if (stateChart.tombstoned) projection.tombstoned = true;

    if (includeDetails) {
      const dynamicChecklists: Record<string, DynamicChecklistRun> = workflowScoped
        ? {}
        : Object.fromEntries(
            Object.entries(projection.dynamicChecklists || {}).map(([k, v]) => [k, (v || {}) as DynamicChecklistRun])
          );
      for (const item of stateChart.addedChecklistItems) {
        if (!item.text || !item.stateId || !item.actionId) continue;
        const runKey = `${item.stateId}/${item.actionId}`;
        const existingRun: DynamicChecklistRun = dynamicChecklists[runKey] || {};
        const existingItems: DynamicChecklistItem[] = Array.from(
          new Map(
            (Array.isArray(existingRun.items) ? existingRun.items : [])
              .filter((candidate: DynamicChecklistItem) => candidate?.text)
              .map((candidate: DynamicChecklistItem) => [candidate.text, candidate])
          ).values()
        );
        const existingItem = existingItems.find((candidate: DynamicChecklistItem) => candidate?.text === item.text);
        const projectedItem: DynamicChecklistItem = {
          text: item.text,
          mandatory: item.mandatory,
          type: item.type,
          metadata: { source: item.source }
        };
        const items: DynamicChecklistItem[] = existingItem
          ? existingItems.map((candidate: DynamicChecklistItem) => {
              if (candidate?.text !== item.text) return candidate;
              return {
                ...candidate,
                mandatory: candidate.mandatory === true || item.mandatory === true,
                type: candidate.type || item.type,
                metadata: {
                  ...(candidate.metadata || {}),
                  source: candidate.metadata?.source || item.source
                }
              };
            })
          : [...existingItems, projectedItem];
        dynamicChecklists[runKey] = {
          ...existingRun,
          updatedAt: item.timestamp,
          items
        };
      }
      if (Object.keys(dynamicChecklists).length > 0 || workflowScoped) {
        projection.dynamicChecklists = dynamicChecklists;
      }
    }

    return projection;
  }
}
