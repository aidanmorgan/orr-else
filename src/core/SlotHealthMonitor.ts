/**
 * SlotHealthMonitor — owns capacity checking and inactive-worker recovery signals.
 *
 * pi-experiment-amq0.2: extracted from Supervisor so slot-health logic is testable
 * in isolation with fake ports, no tmux, no bd.
 *
 * Responsibilities:
 *   - Collect slot-health snapshots (live vs tracked bead counts, heartbeat staleness).
 *   - Record TEAMMATE_SLOT_HEALTH_CHECKED and TEAMMATE_CAPACITY_UNDERFILLED events.
 *   - Detect and recover inactive beads (no-progress timeout + final-blocked pane).
 *   - Manage heartbeat-only live-gap orphan detection lifecycle.
 */

import { asBeadId } from '../types/index.js';
import { Logger } from './Logger.js';
import { SignalingServer } from './SignalingServer.js';
import {
  AgentFailureSummary,
  BeadStatus,
  Component,
  DomainEventName,
  EventName,
  PluginToolName,
  QuarantineReason,
  SupervisorDefaults,
  TeammateEventType,
  TERMINAL_BEAD_STATUSES,
} from '../constants/index.js';
import { detectFinalBlockedState, ScanCategory } from './PaneTranscriptScanner.js';
import { deriveRestartId } from './RestartCorrelation.js';
import {
  routeFailure,
  compactDescriptor,
  FailureClass,
  LifecyclePhase,
  RetryBudget,
  AuthorityLevel,
  NextAction,
} from './FailureTaxonomy.js';
import type { DomainEvent, ProjectionCapableStore } from './EventStoreTypes.js';
import type { BeadsPort, TeammateSpawner } from './OrchestrationPorts.js';
import type { ConfigLoaderPort } from './SupervisorPorts.js';
import type { Clock } from './Clock.js';
import type { BeadId } from '../types/ids.js';

// ---------------------------------------------------------------------------
// FINAL_BLOCKED_CONFIRM_POLLS constant (same value as in Supervisor)
// ---------------------------------------------------------------------------
const FINAL_BLOCKED_CONFIRM_POLLS = 2;

// ---------------------------------------------------------------------------
// SlotHealthSnapshot — matches the private interface in Supervisor verbatim
// ---------------------------------------------------------------------------

export interface SlotHealthSnapshot {
  observedLiveBeadIds: string[];
  effectiveLiveBeadIds: string[];
  noProgressTimeoutMs: number;
  heartbeatByBead: Map<string, number>;
  heartbeatDetails: ReturnType<SignalingServer['getHeartbeatSnapshot']>;
  latestProgressEvents: Map<string, DomainEvent>;
  staleHeartbeatBeadIds: string[];
  inactiveBeadIds: string[];
  staleBeadIds: string[];
  heartbeatOnlyStaleBeadIds: string[];
  expectedCount: number;
  trackedBeadIds: string[];
  missingTrackedBeadIds: string[];
  activeCount: number;
  workingCount: number;
  heartbeatOnlyLiveGaps: string[];
  trackedOnlyBeadIds: string[];
  paneOnlyBeadIds: string[];
  restartingBeadIds: string[];
  releasedBeadIds: string[];
}

// ---------------------------------------------------------------------------
// SlotHealthMonitor
// ---------------------------------------------------------------------------

export class SlotHealthMonitor {
  private lastSlotHealthEventMs = 0;
  private lastLoggedSlotHealthDigest = '';
  private lastCapacityUnderfillDigest = '';
  private releasedThisTick: string[] = [];

  /** Per-bead count of consecutive polls detecting final-blocked pane. */
  readonly finalBlockedPollCounts = new Map<string, number>();

  /** Per-bead consecutive heartbeat-only gap count. */
  readonly heartbeatOnlyGapCounts = new Map<string, number>();
  readonly heartbeatOnlyGapFirstSeenMs = new Map<string, number>();
  readonly suppressedHeartbeatOnlyGaps = new Set<string>();

  /** Per-bead count of inactive-restart recoveries this session. */
  readonly inactiveRestartCountByBead = new Map<string, number>();
  /** Timestamp at which the last inactive restart was issued, per bead. */
  readonly inactiveRestartedAtMs = new Map<string, number>();

  constructor(
    private readonly eventStore: ProjectionCapableStore,
    private readonly configLoader: ConfigLoaderPort,
    private readonly factory: TeammateSpawner,
    private readonly server: SignalingServer,
    private readonly beadsPort: BeadsPort,
    private readonly maxSlots: number,
    private readonly clock: Clock,
    /** Read-only view of the beads currently tracked as started by the coordinator. */
    private readonly startedBeads: ReadonlySet<string>,
    private readonly startedBeadAtMs: ReadonlyMap<string, number>,
    private readonly lastMissingStartedBeadIds: () => ReadonlySet<string>,
    private readonly pruneDurablyInactiveStartedBeads: (liveBeadIds: Set<string>) => Promise<void>,
    /** Callback invoked when a bead should be marked exited (shared tracking state). */
    private readonly markBeadExited: (id: string, opts?: { preserveInactiveRestartBackoff?: boolean }) => void,
    /** Callback invoked when a bead is quarantined (shared quarantine state). */
    private readonly quarantineBead: (
      bead: { id: string; status: string; lastActivity?: string },
      reason: QuarantineReason,
      details?: Record<string, unknown>
    ) => Promise<void>,
    private readonly taxonomyFields: (
      cls: FailureClass,
      phase: LifecyclePhase,
      budget: RetryBudget
    ) => { taxonomyClass: string; lifecyclePhase: string; taxonomyRowId: string; taxonomyAction: string; retryBudget: string },
    private readonly routeTaxonomy: (
      cls: FailureClass,
      phase: LifecyclePhase,
      budget: RetryBudget
    ) => ReturnType<typeof routeFailure>,
    private readonly harnessRestartEvent: () => Promise<string>,
    private readonly isSchedulingPaused: () => boolean
  ) {}

  /** Expose releasedThisTick for recording in slot-health snapshot. */
  addReleasedThisTick(beadId: string): void {
    this.releasedThisTick.push(beadId);
  }

  // ---------------------------------------------------------------------------
  // Retry budget (moved verbatim from Supervisor)
  // ---------------------------------------------------------------------------

  retryBudgetFor(beadId: string): RetryBudget {
    const count = this.inactiveRestartCountByBead.get(beadId) ?? 0;
    return count > SupervisorDefaults.MAX_INACTIVE_RESTARTS
      ? RetryBudget.EXHAUSTED
      : RetryBudget.AVAILABLE;
  }

  // ---------------------------------------------------------------------------
  // Latest state from heartbeat (moved verbatim from Supervisor)
  // ---------------------------------------------------------------------------

  private latestStateForBead(beadId: string, heartbeatDetails: ReturnType<SignalingServer['getHeartbeatSnapshot']>): string | undefined {
    return heartbeatDetails
      .filter(heartbeat => heartbeat.beadId === beadId && heartbeat.stateId)
      .sort((a, b) => b.timestampMs - a.timestampMs)[0]?.stateId;
  }

  // ---------------------------------------------------------------------------
  // collectSlotHealthSnapshot (moved verbatim from Supervisor)
  // ---------------------------------------------------------------------------

  async collectSlotHealthSnapshot(): Promise<SlotHealthSnapshot> {
    this.releasedThisTick = [];

    const liveBeadIds = [...await this.factory.getLiveTeammateBeadIds()].sort();
    await this.pruneDurablyInactiveStartedBeads(new Set(liveBeadIds));
    const config = await this.configLoader.load();
    const noProgressTimeoutMs = config.settings.teammateNoProgressTimeoutMs || SupervisorDefaults.NO_PROGRESS_TIMEOUT_MS;
    const heartbeatByBead = new Map<string, number>();
    for (const heartbeat of this.server.getHeartbeatSnapshot()) {
      if (!heartbeat.beadId) continue;
      const previous = heartbeatByBead.get(heartbeat.beadId) || 0;
      heartbeatByBead.set(heartbeat.beadId, Math.max(previous, heartbeat.timestampMs));
    }
    const heartbeatDetails = this.server.getHeartbeatSnapshot();
    const latestProgressEvents = await this.eventStore.latestEventsForBeads(liveBeadIds.map(asBeadId), {
      excludeTypes: [DomainEventName.HEARTBEAT_RECORDED, DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED],
      excludeTeammateEventTypes: [TeammateEventType.HEARTBEAT],
      excludeToolNames: [PluginToolName.BD_HEARTBEAT]
    });

    const now = this.clock.now();
    const staleHeartbeatBeadIds = liveBeadIds.filter(beadId => {
      const lastHeartbeatMs = heartbeatByBead.get(beadId) || 0;
      if (!lastHeartbeatMs) {
        const startedAtMs = this.startedBeadAtMs.get(beadId) || 0;
        return startedAtMs > 0 && now - startedAtMs > SupervisorDefaults.STARTUP_HEARTBEAT_GRACE_MS;
      }
      return now - lastHeartbeatMs > SupervisorDefaults.STALE_HEARTBEAT_MS;
    });
    const inactiveBeadIds = liveBeadIds.filter(beadId => {
      const latestProgress = latestProgressEvents.get(asBeadId(beadId));
      const latestProgressMs = latestProgress ? Date.parse(latestProgress.timestamp) : this.startedBeadAtMs.get(beadId) || 0;
      return Number.isFinite(latestProgressMs) && latestProgressMs > 0 && now - latestProgressMs > noProgressTimeoutMs;
    });
    const staleBeadIds = [...new Set(inactiveBeadIds)].sort();
    const heartbeatOnlyStaleBeadIds = staleHeartbeatBeadIds
      .filter(beadId => !staleBeadIds.includes(beadId))
      .sort();
    const expectedCount = this.maxSlots;
    const trackedBeadIds = [...this.startedBeads].sort();
    const missingTrackedBeadIds = trackedBeadIds
      .filter(beadId => !liveBeadIds.includes(beadId) || this.lastMissingStartedBeadIds().has(beadId));
    const effectiveLiveBeadIds = liveBeadIds.filter(beadId => !missingTrackedBeadIds.includes(beadId));
    const activeCount = effectiveLiveBeadIds.length;
    const workingCount = activeCount - staleBeadIds.filter(beadId => effectiveLiveBeadIds.includes(beadId)).length;

    for (const beadId of liveBeadIds) {
      if (this.suppressedHeartbeatOnlyGaps.has(beadId)) {
        this.suppressedHeartbeatOnlyGaps.delete(beadId);
        this.heartbeatOnlyGapCounts.delete(beadId);
        this.heartbeatOnlyGapFirstSeenMs.delete(beadId);
      }
    }
    const heartbeatOnlyLiveGaps = [...heartbeatByBead.keys()]
      .filter(beadId => !liveBeadIds.includes(beadId) && !this.suppressedHeartbeatOnlyGaps.has(beadId))
      .sort();

    const trackedSet = new Set(trackedBeadIds);
    const liveSet = new Set(liveBeadIds);
    const trackedOnlyBeadIds = trackedBeadIds.filter(id => !liveSet.has(id)).sort();
    const paneOnlyBeadIds = liveBeadIds.filter(id => !trackedSet.has(id)).sort();
    const restartingBeadIds = [...this.inactiveRestartedAtMs.keys()]
      .filter(id => now - (this.inactiveRestartedAtMs.get(id) || 0) < noProgressTimeoutMs)
      .sort();
    const releasedBeadIds = [...new Set(this.releasedThisTick)].sort();

    return {
      observedLiveBeadIds: liveBeadIds,
      effectiveLiveBeadIds,
      noProgressTimeoutMs,
      heartbeatByBead,
      heartbeatDetails,
      latestProgressEvents,
      staleHeartbeatBeadIds,
      inactiveBeadIds,
      staleBeadIds,
      heartbeatOnlyStaleBeadIds,
      expectedCount,
      trackedBeadIds,
      missingTrackedBeadIds,
      activeCount,
      workingCount,
      heartbeatOnlyLiveGaps,
      trackedOnlyBeadIds,
      paneOnlyBeadIds,
      restartingBeadIds,
      releasedBeadIds
    };
  }

  // ---------------------------------------------------------------------------
  // recordSlotHealth (moved verbatim from Supervisor)
  // ---------------------------------------------------------------------------

  async recordSlotHealth(stage: string): Promise<void> {
    const now = this.clock.now();
    if (now - this.lastSlotHealthEventMs < SupervisorDefaults.SLOT_HEALTH_EVENT_INTERVAL_MS) return;
    this.lastSlotHealthEventMs = now;

    const snapshot = await this.collectSlotHealthSnapshot();
    const {
      observedLiveBeadIds,
      effectiveLiveBeadIds,
      noProgressTimeoutMs,
      heartbeatByBead,
      heartbeatDetails,
      latestProgressEvents,
      staleHeartbeatBeadIds,
      inactiveBeadIds,
      staleBeadIds,
      heartbeatOnlyStaleBeadIds,
      expectedCount,
      trackedBeadIds,
      missingTrackedBeadIds,
      activeCount,
      workingCount,
      heartbeatOnlyLiveGaps,
      trackedOnlyBeadIds,
      paneOnlyBeadIds,
      restartingBeadIds,
      releasedBeadIds
    } = snapshot;

    await this.eventStore.record(DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED, {
      stage,
      expectedCount,
      activeCount,
      workingCount,
      liveBeadIds: effectiveLiveBeadIds,
      observedLiveBeadIds,
      staleBeadIds,
      staleHeartbeatBeadIds,
      heartbeatOnlyStaleBeadIds,
      inactiveBeadIds,
      trackedBeadIds,
      missingTrackedBeadIds,
      heartbeatOnlyLiveGaps,
      trackedOnlyBeadIds,
      paneOnlyBeadIds,
      restartingBeadIds,
      releasedBeadIds
    }).catch(() => {});

    const details = {
      expectedCount,
      activeCount,
      workingCount,
      liveBeadIds: effectiveLiveBeadIds,
      missingTrackedBeadIds,
      staleBeadIds,
      heartbeatOnlyStaleBeadIds,
      trackedOnlyBeadIds,
      paneOnlyBeadIds,
      restartingBeadIds,
      releasedBeadIds
    };
    const digest = `${expectedCount}/${workingCount}/${activeCount}|${missingTrackedBeadIds.join(',')}|${staleBeadIds.join(',')}|${heartbeatOnlyStaleBeadIds.join(',')}|${trackedOnlyBeadIds.join(',')}|${paneOnlyBeadIds.join(',')}`;
    if (digest !== this.lastLoggedSlotHealthDigest) {
      this.lastLoggedSlotHealthDigest = digest;
      const isUnderfilled = activeCount < expectedCount || staleBeadIds.length > 0 || heartbeatOnlyStaleBeadIds.length > 0;
      if (isUnderfilled && this.isSchedulingPaused()) {
        // Silently absorb the digest change.
      } else if (isUnderfilled) {
        Logger.warn(Component.SUPERVISOR, 'Teammate slot health check found underfilled or stale work', details);
      } else {
        Logger.info(Component.SUPERVISOR, 'Teammate slot health check passed', details);
      }
    }

    await this.recordCapacityUnderfill({
      stage,
      expectedCount,
      activeCount,
      workingCount,
      liveBeadIds: effectiveLiveBeadIds,
      trackedBeadIds,
      missingTrackedBeadIds,
      heartbeatOnlyLiveGaps,
      heartbeatByBead,
      staleBeadIds,
      heartbeatOnlyStaleBeadIds
    });

    await this.recoverOrphanHeartbeatGaps(heartbeatOnlyLiveGaps, heartbeatDetails, now);
    await this.recoverInactiveBeads(inactiveBeadIds, effectiveLiveBeadIds, latestProgressEvents, heartbeatDetails, noProgressTimeoutMs);
  }

  // ---------------------------------------------------------------------------
  // recordCapacityUnderfill (moved verbatim from Supervisor)
  // ---------------------------------------------------------------------------

  private async recordCapacityUnderfill(details: {
    stage: string;
    expectedCount: number;
    activeCount: number;
    workingCount: number;
    liveBeadIds: string[];
    trackedBeadIds: string[];
    missingTrackedBeadIds: string[];
    heartbeatOnlyLiveGaps: string[];
    heartbeatByBead: Map<string, number>;
    staleBeadIds: string[];
    heartbeatOnlyStaleBeadIds: string[];
  }): Promise<void> {
    if (details.activeCount >= details.expectedCount) return;

    const missingSlotCount = details.expectedCount - details.activeCount;
    const lastHeartbeatByBead = Object.fromEntries(
      [...details.heartbeatByBead.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([beadId, timestampMs]) => [beadId, this.clock.date(timestampMs).toISOString()])
    );
    const digest = [
      `${details.expectedCount}/${details.activeCount}`,
      details.liveBeadIds.join(','),
      details.trackedBeadIds.join(','),
      details.missingTrackedBeadIds.join(','),
      details.heartbeatOnlyLiveGaps.join(',')
    ].join('|');
    if (digest === this.lastCapacityUnderfillDigest) return;
    this.lastCapacityUnderfillDigest = digest;

    const eventData = {
      stage: details.stage,
      expectedCount: details.expectedCount,
      activeCount: details.activeCount,
      workingCount: details.workingCount,
      missingSlotCount,
      liveBeadIds: details.liveBeadIds,
      trackedBeadIds: details.trackedBeadIds,
      missingTrackedBeadIds: details.missingTrackedBeadIds,
      heartbeatOnlyLiveGaps: details.heartbeatOnlyLiveGaps,
      staleBeadIds: details.staleBeadIds,
      heartbeatOnlyStaleBeadIds: details.heartbeatOnlyStaleBeadIds,
      lastHeartbeatByBead
    };

    await this.eventStore.record(DomainEventName.TEAMMATE_CAPACITY_UNDERFILLED, eventData).catch(() => {});
    if (this.isSchedulingPaused()) return;
    Logger.warn(Component.SUPERVISOR, 'Teammate capacity underfilled', eventData);
  }

  // ---------------------------------------------------------------------------
  // recoverOrphanHeartbeatGaps (moved verbatim from Supervisor)
  // ---------------------------------------------------------------------------

  private async recoverOrphanHeartbeatGaps(
    heartbeatOnlyLiveGaps: string[],
    heartbeatDetails: ReturnType<SignalingServer['getHeartbeatSnapshot']>,
    nowMs: number
  ): Promise<void> {
    const config = await this.configLoader.load();
    const orphanChecks = config.settings.heartbeatOnlyGapOrphanChecks ?? SupervisorDefaults.HEARTBEAT_ONLY_GAP_ORPHAN_CHECKS;
    const orphanTtlMs = config.settings.heartbeatOnlyGapOrphanTtlMs ?? SupervisorDefaults.HEARTBEAT_ONLY_GAP_ORPHAN_TTL_MS;

    const currentGapSet = new Set(heartbeatOnlyLiveGaps);

    for (const beadId of [...this.heartbeatOnlyGapCounts.keys()]) {
      if (!currentGapSet.has(beadId)) {
        this.heartbeatOnlyGapCounts.delete(beadId);
        this.heartbeatOnlyGapFirstSeenMs.delete(beadId);
      }
    }

    for (const beadId of heartbeatOnlyLiveGaps) {
      if (!this.heartbeatOnlyGapFirstSeenMs.has(beadId)) {
        this.heartbeatOnlyGapFirstSeenMs.set(beadId, nowMs);
      }

      const prevCount = this.heartbeatOnlyGapCounts.get(beadId) ?? 0;
      const newCount = prevCount + 1;
      this.heartbeatOnlyGapCounts.set(beadId, newCount);

      const firstSeenMs = this.heartbeatOnlyGapFirstSeenMs.get(beadId)!;
      const ageMs = nowMs - firstSeenMs;
      const ttlExpired = ageMs >= orphanTtlMs;
      const thresholdReached = newCount >= orphanChecks;

      if (!ttlExpired && !thresholdReached) continue;

      const reason = ttlExpired
        ? `heartbeat-only gap exceeded ttl (${ageMs}ms >= ${orphanTtlMs}ms)`
        : `heartbeat-only gap exceeded consecutive check threshold (${newCount} >= ${orphanChecks})`;

      const beadHeartbeats = heartbeatDetails.filter(h => h.beadId === beadId);
      const workerIds = [...new Set(beadHeartbeats.map(h => h.workerId))];
      const lastHeartbeatMs = Math.max(...beadHeartbeats.map(h => h.timestampMs), 0);
      const lastHeartbeatAt = lastHeartbeatMs > 0 ? this.clock.date(lastHeartbeatMs).toISOString() : undefined;
      const stateId = this.latestStateForBead(beadId, heartbeatDetails);

      Logger.warn(Component.SUPERVISOR, 'Heartbeat-only live gap declared orphaned; suppressing', {
        beadId,
        workerIds,
        lastHeartbeatAt,
        stateId,
        reason
      });

      await this.eventStore.record(DomainEventName.HEARTBEAT_ONLY_GAP_ORPHANED, {
        beadId,
        workerIds,
        lastHeartbeatAt,
        stateId,
        reason
      }).catch(() => {});

      this.suppressedHeartbeatOnlyGaps.add(beadId);
      this.heartbeatOnlyGapCounts.delete(beadId);
      this.heartbeatOnlyGapFirstSeenMs.delete(beadId);

      await this.beadsPort.release(beadId).catch(error => {
        Logger.warn(Component.SUPERVISOR, 'Unable to release orphaned heartbeat-only gap bead', { beadId, error: String(error) });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // recoverInactiveBeads (moved verbatim from Supervisor)
  // ---------------------------------------------------------------------------

  async recoverInactiveBeads(
    inactiveBeadIds: string[],
    effectiveLiveBeadIds: string[],
    latestProgressEvents: Map<string, DomainEvent>,
    heartbeatDetails: ReturnType<SignalingServer['getHeartbeatSnapshot']>,
    noProgressTimeoutMs: number
  ): Promise<void> {
    const config = await this.configLoader.load();
    const harnessRestartEvent = await this.harnessRestartEvent();

    const hasCaptureBeadPaneText = typeof this.factory.captureBeadPaneText === 'function';
    if (hasCaptureBeadPaneText) {
      const inactiveSet = new Set(inactiveBeadIds);
      for (const beadId of effectiveLiveBeadIds) {
        if (inactiveSet.has(beadId)) continue;

        const lastRestartAtMs = this.inactiveRestartedAtMs.get(beadId) || 0;
        const now = this.clock.now();
        if (now - lastRestartAtMs < noProgressTimeoutMs) {
          this.finalBlockedPollCounts.delete(beadId);
          continue;
        }

        const paneSnapshot = await this.factory.captureBeadPaneText(beadId).catch(() => '');
        if (!paneSnapshot) {
          this.finalBlockedPollCounts.delete(beadId);
          continue;
        }

        const finalBlockedResult = detectFinalBlockedState(paneSnapshot);
        if (!finalBlockedResult.blocked) {
          this.finalBlockedPollCounts.delete(beadId);
          continue;
        }

        const previousCount = this.finalBlockedPollCounts.get(beadId) ?? 0;
        const newCount = previousCount + 1;
        this.finalBlockedPollCounts.set(beadId, newCount);

        if (newCount < FINAL_BLOCKED_CONFIRM_POLLS) {
          Logger.info(Component.SUPERVISOR, 'Final-blocked pane candidate; awaiting temporal confirmation', {
            beadId,
            pollCount: newCount,
            requiredPolls: FINAL_BLOCKED_CONFIRM_POLLS,
            category: finalBlockedResult.category
          });
          continue;
        }

        this.finalBlockedPollCounts.delete(beadId);
        const now2 = this.clock.now();
        this.inactiveRestartedAtMs.set(beadId, now2);

        const prevRestartCount = this.inactiveRestartCountByBead.get(beadId) ?? 0;
        this.inactiveRestartCountByBead.set(beadId, prevRestartCount + 1);
        const budget = this.retryBudgetFor(beadId);

        const taxonomyRoute = this.routeTaxonomy(FailureClass.WORKER_PROCESS_LOSS, LifecyclePhase.RUNNING, budget);
        const fields = this.taxonomyFields(FailureClass.WORKER_PROCESS_LOSS, LifecyclePhase.RUNNING, budget);

        const latestProgressEvent = latestProgressEvents.get(beadId);
        const stateId = this.latestStateForBead(beadId, heartbeatDetails) || String(latestProgressEvent?.data?.stateId || '');
        const blockedCategory: ScanCategory | string = finalBlockedResult.category ?? ScanCategory.PANIC_FATAL;
        const blockedEvidence = finalBlockedResult.evidenceLine
          ? ` Evidence: "${finalBlockedResult.evidenceLine}".`
          : '';
        const summary = [
          AgentFailureSummary.FINAL_BLOCKED,
          `Detected category: ${blockedCategory}.${blockedEvidence}`,
          `Last non-heartbeat event: ${latestProgressEvent?.type || 'none'} at ${latestProgressEvent?.timestamp || 'unknown'}.`,
          AgentFailureSummary.EVENT_STORE_DETAILS
        ].join(' ');
        const evidence = `${summary}\n\nPane snapshot (reasoning redacted):\n${paneSnapshot}`;

        Logger.warn(Component.SUPERVISOR, 'Final-blocked pane detected; recovering bead immediately', {
          beadId,
          stateId,
          category: blockedCategory,
          evidenceLine: finalBlockedResult.evidenceLine,
          taxonomyAction: taxonomyRoute.nextAction,
          restartCount: prevRestartCount + 1,
          budget
        });

        await this.eventStore.record(DomainEventName.AGENT_TURN_FAILED, {
          beadId,
          stateId,
          summary,
          paneSnapshot,
          error: summary,
          ...fields
        }).catch(() => {});

        if (taxonomyRoute.nextAction === NextAction.QUARANTINE) {
          const beadObj = await this.beadsPort.getBead(beadId).catch(() => undefined);
          if (beadObj) {
            await this.quarantineBead(beadObj, QuarantineReason.UNKNOWN, {
              ...fields,
              summary,
              reason: 'Worker process loss retry budget exhausted — final-blocked'
            });
          } else {
            Logger.warn(Component.SUPERVISOR, 'Unable to fetch bead for quarantine after budget exhaustion; skipping quarantine entry', { beadId });
          }
        } else {
          const finalBlockedRestartKey = `supervisor-final-blocked-${beadId}-${stateId}-${now2}`;
          await this.eventStore.record(DomainEventName.HARNESS_RESTART_REQUESTED, {
            beadId,
            stateId,
            targetState: stateId,
            transitionEvent: harnessRestartEvent || EventName.HARNESS_RESTART,
            summary,
            evidence,
            handover: summary,
            restartId: deriveRestartId(finalBlockedRestartKey)
          }).catch(() => {});
        }

        await this.factory.terminateTeammatesForBead(beadId, summary).catch(error => {
          Logger.warn(Component.SUPERVISOR, 'Unable to terminate final-blocked teammate panes', { beadId, error: String(error) });
        });
        await this.beadsPort.release(beadId).catch((error: unknown) => {
          Logger.warn(Component.SUPERVISOR, 'Unable to release final-blocked Bead after teammate termination', { beadId, error: String(error) });
        });
        this.markBeadExited(beadId, { preserveInactiveRestartBackoff: true });
      }
    }

    if (inactiveBeadIds.length === 0) return;

    for (const beadId of inactiveBeadIds) {
      const lastRestartAtMs = this.inactiveRestartedAtMs.get(beadId) || 0;
      const now = this.clock.now();
      if (now - lastRestartAtMs < noProgressTimeoutMs) continue;
      this.inactiveRestartedAtMs.set(beadId, now);

      const prevRestartCount = this.inactiveRestartCountByBead.get(beadId) ?? 0;
      this.inactiveRestartCountByBead.set(beadId, prevRestartCount + 1);
      const budget = this.retryBudgetFor(beadId);

      const taxonomyRoute = this.routeTaxonomy(FailureClass.WORKER_PROCESS_LOSS, LifecyclePhase.RUNNING, budget);
      const fields = this.taxonomyFields(FailureClass.WORKER_PROCESS_LOSS, LifecyclePhase.RUNNING, budget);

      const latestProgressEvent = latestProgressEvents.get(beadId);
      const stateId = this.latestStateForBead(beadId, heartbeatDetails) || String(latestProgressEvent?.data?.stateId || '');
      const summary = [
        AgentFailureSummary.NO_PROGRESS,
        `Last non-heartbeat event: ${latestProgressEvent?.type || 'none'} at ${latestProgressEvent?.timestamp || 'unknown'}.`,
        `Timeout: ${noProgressTimeoutMs}ms.`,
        AgentFailureSummary.EVENT_STORE_DETAILS
      ].join(' ');

      const paneSnapshot = await this.factory.captureBeadPaneText(beadId).catch(() => '');
      const evidence = paneSnapshot
        ? `${summary}\n\nPane snapshot (reasoning redacted):\n${paneSnapshot}`
        : summary;

      await this.eventStore.record(DomainEventName.AGENT_TURN_FAILED, {
        beadId,
        stateId,
        summary,
        paneSnapshot: paneSnapshot || undefined,
        error: summary,
        ...fields
      }).catch(() => {});

      if (taxonomyRoute.nextAction === NextAction.QUARANTINE) {
        const beadObj = await this.beadsPort.getBead(beadId).catch(() => undefined);
        if (beadObj) {
          await this.quarantineBead(beadObj, QuarantineReason.UNKNOWN, {
            ...fields,
            summary,
            reason: 'Worker process loss retry budget exhausted — no-progress timeout'
          });
        } else {
          Logger.warn(Component.SUPERVISOR, 'Unable to fetch bead for quarantine after budget exhaustion; skipping quarantine entry', { beadId });
        }
      } else {
        const noProgressRestartKey = `supervisor-no-progress-${beadId}-${stateId}-${now}`;
        await this.eventStore.record(DomainEventName.HARNESS_RESTART_REQUESTED, {
          beadId,
          stateId,
          targetState: stateId,
          transitionEvent: harnessRestartEvent || EventName.HARNESS_RESTART,
          summary,
          evidence,
          handover: summary,
          restartId: deriveRestartId(noProgressRestartKey)
        }).catch(() => {});
      }

      await this.factory.terminateTeammatesForBead(beadId, summary).catch(error => {
        Logger.warn(Component.SUPERVISOR, 'Unable to terminate inactive teammate panes', { beadId, error: String(error) });
      });
      await this.beadsPort.release(beadId).catch((error: unknown) => {
        Logger.warn(Component.SUPERVISOR, 'Unable to release inactive Bead after teammate termination', { beadId, error: String(error) });
      });
      this.markBeadExited(beadId, { preserveInactiveRestartBackoff: true });
    }
  }
}
