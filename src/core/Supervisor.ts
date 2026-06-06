import { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Bead, BeadId } from '../types/index.js';
import { Logger } from './Logger.js';
import { Observability } from './Observability.js';
import { SignalingServer } from './SignalingServer.js';
import { AgentFailureSummary, App, Component, Defaults, DomainEventName, EventName, OtelAttr, PluginToolName, QuarantineReason, RestartKind, RetentionDefaults, SpanName, SupervisorDefaults, TeammateEventDecisionAction, TeammateEventType, TERMINAL_BEAD_STATUSES } from '../constants/index.js';
import { detectFinalBlockedState, ScanCategory } from './PaneTranscriptScanner.js';
import { Orchestrator } from './Orchestrator.js';
import type { ScoredBead } from './Scheduler.js';
import type { DomainEvent, ProjectionCapableStore } from './EventStore.js';
import type { RuntimeServices, WorktreeResult } from './RuntimeServices.js';
import type { BeadsPort, WorktreePort, TeammateSpawner } from './OrchestrationPorts.js';
import { systemClock } from './Clock.js';
import type { Clock } from './Clock.js';
import type { HarnessConfig } from './ConfigLoader.js';
import type { WorktreeProvisioningMode } from './domain/StateModels.js';
import { RetentionCleanup } from './RetentionCleanup.js';
import { checkMcpBridgeHealth, mcpBackedRequiredToolNames, type McpBridgeHealth } from './McpTransportPreflight.js';
import { projectToolFailureLimitSuggestedOutcome } from './ProjectToolFailureLimit.js';

export interface SupervisorOptions {
  maxSlots: number;
  requestedBeadId?: string;
  clock?: Clock;
}

/**
 * Number of consecutive supervisor polls on which a bead must be detected as
 * final-blocked before the early-trip recovery fires.  Requiring two consecutive
 * detections eliminates one-frame false kills caused by transient pane snapshots
 * that happen to end mid-stream on a matching line.
 *
 * Latency cost: ≈ 2 × POLL_INTERVAL_MS instead of 1 × POLL_INTERVAL_MS.
 * That is still far faster than the full noProgressTimeoutMs path.
 */
const FINAL_BLOCKED_CONFIRM_POLLS = 2;

/** Quarantine entry for a bead whose worktree creation repeatedly fails.
 * The bead is skipped on subsequent scans until its signature changes, preventing
 * repeated claim/release churn and slot-health thrash. */
interface QuarantineEntry {
  /** Structured reason code from the worktree-creation failure. */
  reason: QuarantineReason;
  /** State fingerprint that must change for the bead to be re-attempted.
   * Composed of the bead's status + updatedAt (or similar stable field) at the
   * time of quarantine so that a bead re-assignment or status change lifts the block. */
  signature: string;
  /** Optional diagnostic fields recorded with the quarantine event. */
  details?: Record<string, unknown>;
}

interface MissingStartedRestartDetails {
  restartKind?: string;
  restartEvent?: string;
  restartFromState?: string;
  restartTargetState?: string;
  sourceEventType?: string;
}

interface NonRoutableTerminalFailureLimitQuarantineDetails extends Record<string, unknown> {
  stateId: string;
  actionId: string;
  toolName: string;
  suggestedOutcome: string;
  configuredOutcomes: string[];
  suggestedOutcomeTransitionError: string;
  restartTargetState: string;
  restartEvent?: string;
  sourceEventType: string;
  sourceEventId?: string;
  sourceIdempotencyKey?: string;
  terminalFailureEventId?: string;
  terminalFailureEventTimestamp?: string;
}

/** Typed value object returned by `collectSlotHealthSnapshot`. Contains all
 * measured slot-health fields so that `recordSlotHealth` can record/log and
 * forward them to the remediation helpers without recomputing inline. */
interface SlotHealthSnapshot {
  /** Raw live bead IDs as returned by the factory (pre-exclusion). */
  observedLiveBeadIds: string[];
  /** Live bead IDs after missing-tracked beads are excluded. */
  effectiveLiveBeadIds: string[];
  /** Resolved no-progress timeout (config or default). */
  noProgressTimeoutMs: number;
  /** Latest heartbeat timestamp per bead, keyed by beadId. */
  heartbeatByBead: Map<string, number>;
  /** Full heartbeat detail records from the signaling server snapshot. */
  heartbeatDetails: ReturnType<SignalingServer['getHeartbeatSnapshot']>;
  /** Latest non-heartbeat/non-slot-health event per live bead. */
  latestProgressEvents: Map<string, DomainEvent>;
  /** Live beads whose heartbeat timestamp is stale (or absent past grace period). */
  staleHeartbeatBeadIds: string[];
  /** Live beads that have exceeded the no-progress timeout. */
  inactiveBeadIds: string[];
  /** Deduplicated, sorted stale-by-inactivity bead IDs (== inactiveBeadIds deduped). */
  staleBeadIds: string[];
  /** Beads stale only by heartbeat, not yet by progress timeout. */
  heartbeatOnlyStaleBeadIds: string[];
  /** Configured maximum number of teammate slots. */
  expectedCount: number;
  /** All beads ever started this session, sorted. */
  trackedBeadIds: string[];
  /** Tracked beads not present in the live set (or flagged as persistently missing). */
  missingTrackedBeadIds: string[];
  /** Number of effective live teammates. */
  activeCount: number;
  /** Number of active teammates that are not stale-by-inactivity. */
  workingCount: number;
  /** Heartbeating bead IDs that are not in the live-pane set. */
  heartbeatOnlyLiveGaps: string[];
  /**
   * Churn-diagnostic worker sets (s3wp.33).
   *
   * trackedOnly  — tracked by the supervisor but absent from the live pane set;
   *                these are workers that may have exited without a pane-death event.
   * paneOnly     — present in the live pane set but not tracked by the supervisor;
   *                these are orphaned panes (e.g. from a prior run).
   * restarting   — currently in inactive-restart backoff; a recovery was triggered
   *                and the new spawn has not yet appeared in the pane scan.
   * released     — durably pruned from tracking this tick (confirmed inactive events).
   */
  trackedOnlyBeadIds: string[];
  paneOnlyBeadIds: string[];
  restartingBeadIds: string[];
  releasedBeadIds: string[];
}

export class Supervisor {
  private interval?: NodeJS.Timeout;
  private startedBeads = new Set<string>();
  private startedBeadAtMs = new Map<string, number>();
  private missingStartedBeadChecks = new Map<string, number>();
  private inactiveRestartedAtMs = new Map<string, number>();
  private processedSignals = new Set<string>();
  private stepInProgress = false;
  private stopping = false;
  private lastSlotHealthEventMs = 0;
  private lastRetentionCleanupMs = 0;
  private schedulingPausedUntilMs = 0;
  private schedulingPausedReason = '';
  // Track the pauseUntil value at which the SCHEDULING_PAUSED domain event was
  // last emitted so we fire it exactly once per distinct pause window (not on
  // every poll).
  private lastSchedulingPausedEventMs = 0;
  // Throttle the low-frequency pause heartbeat: at most once per
  // PAUSE_HEARTBEAT_INTERVAL_MS while pause is active.
  private lastPauseHeartbeatMs = 0;
  // Throttle "underfilled or stale" slot warns: only emit when the digest
  // (expected/working counts + stale bead set) changes.
  private lastLoggedSlotHealthDigest = '';
  private lastCapacityUnderfillDigest = '';
  private lastMissingStartedBeadIds = new Set<string>();
  /** In-memory quarantine map: beadId → QuarantineEntry.
   * Quarantined beads are skipped during scanAndSpawn unless their signature changes.
   * Rehydrated on startup from BEAD_QUARANTINED events; cleared when signature changes. */
  private readonly quarantine = new Map<string, QuarantineEntry>();
  /**
   * Set of beadIds whose quarantine entry was rehydrated from a durable
   * BEAD_QUARANTINED event on coordinator restart (as opposed to established at
   * runtime this session).  Used to emit BEAD_QUARANTINE_CLEARED when a rehydrated
   * entry is lifted — providing a durable audit trail for the retry. */
  private readonly rehydratedQuarantineBeadIds = new Set<string>();
  /**
   * Per-bead count of consecutive supervisor polls on which the bead's pane was
   * detected as final-blocked.  Reset to zero when the bead is NOT detected as
   * blocked (i.e. pane shows progress).  Only when the count reaches
   * FINAL_BLOCKED_CONFIRM_POLLS does the early-trip recovery fire.
   *
   * This is a plain instance field (no static) so each Supervisor instance has
   * its own independent debounce state.
   */
  private readonly finalBlockedPollCounts = new Map<string, number>();
  /**
   * Beads pruned from startedBeads this tick by pruneDurablyInactiveStartedBeads.
   * Cleared at the start of each slot-health snapshot and populated during the prune
   * step so that `recordSlotHealth` can include them in the releasedBeadIds set.
   */
  private releasedThisTick: string[] = [];
  /**
   * Per-beadId count of consecutive slot-health checks on which the bead appeared
   * in heartbeatOnlyLiveGaps (heartbeat present, live pane absent).  Reset when the
   * bead re-appears in the live pane set or is suppressed after orphan detection.
   */
  private readonly heartbeatOnlyGapCounts = new Map<string, number>();
  /**
   * Timestamp (ms) at which a beadId first appeared in heartbeatOnlyLiveGaps this
   * session.  Used for the TTL-based orphan trigger.
   */
  private readonly heartbeatOnlyGapFirstSeenMs = new Map<string, number>();
  /**
   * Set of beadIds that have been declared orphaned and should be excluded from
   * future heartbeatOnlyLiveGaps reporting.  Cleared if the bead re-appears in
   * the live pane set (indicating a late pane-registration healed the gap).
   */
  private readonly suppressedHeartbeatOnlyGaps = new Set<string>();
  private readonly clock: Clock;
  /**
   * Cached MCP bridge health result (s3wp.32).
   * Set on first MCP preflight check; reused on subsequent scan-loop iterations
   * so the same module-load failure is not rediscovered per worker.
   * undefined = not yet probed.
   */
  private mcpBridgeHealth: McpBridgeHealth | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    private readonly server: SignalingServer,
    private readonly factory: TeammateSpawner,
    private readonly observability: Observability,
    private readonly services: RuntimeServices,
    private readonly options: SupervisorOptions
  ) {
    this.clock = options.clock || systemClock;
  }

  /**
   * Narrow read/record view of the event store the Supervisor depends on.
   *
   * Typing this accessor as {@link ProjectionCapableStore} (not the concrete
   * store class) makes the dependency a structural contract: every call site
   * below is checked against the interface, so removing a method the Supervisor
   * needs — e.g. latestProjectToolFailureLimitEvent — is a `tsc` error here
   * rather than a runtime "is not a function" crash inside a test double.
   */
  private get eventStore(): ProjectionCapableStore {
    return this.services.eventStore;
  }

  public async start() {
    await this.restoreCapacityPauseFromStore();
    // Single readAll() pass: fetch the full event log once and share it with
    // both startup helpers so coordinator boot makes exactly one O(events) scan
    // instead of two.
    let startupEvents: DomainEvent[] = [];
    try {
      startupEvents = await this.eventStore.readAll();
    } catch (error) {
      Logger.warn(Component.SUPERVISOR, 'Unable to read event store on startup; signal-state restore skipped', { error: String(error) });
    }
    await this.rebuildProcessedSignalsFromEvents(startupEvents);
    await this.reconcileUnacknowledgedSignalIntents(startupEvents);
    await this.rehydrateQuarantinesFromEvents(startupEvents);

    this.interval = setInterval(() => {
      this.step().catch(error => Logger.error(Component.SUPERVISOR, 'Supervisor poll failed', { error: String(error) }));
    }, Defaults.POLL_INTERVAL_MS);

    await this.step();
  }

  public stop() {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    this.server.stop();
    void this.eventStore.record(DomainEventName.HARNESS_STOPPED, {
      requestedBeadId: this.options.requestedBeadId
    }).catch(() => {});
  }

  public async getActiveTeammateCount(): Promise<number> {
    return await this.factory.getActiveTeammateCount();
  }

  /** Returns signaling server health for status reporting. */
  public getSignalingHealth(): { port: number | undefined; healthy: boolean } {
    return {
      port: this.server.getListeningPort(),
      healthy: this.server.isListening()
    };
  }

  /** Returns the last MCP bridge health result (s3wp.32).
   *  undefined if no MCP tool preflight has been run yet this session. */
  public getMcpBridgeHealth(): McpBridgeHealth | undefined {
    return this.mcpBridgeHealth;
  }

  /**
   * Returns a snapshot of all beads currently tracked as started by this
   * coordinator, paired with each bead's current stateId as projected from the
   * event store.  This is the single source of truth for per-teammate state —
   * it does NOT read Beads metadata.
   */
  public async getActiveAssignments(): Promise<Array<{ beadId: string; stateId: string }>> {
    const beadIds = [...this.startedBeads];
    if (beadIds.length === 0) return [];
    const assignments: Array<{ beadId: string; stateId: string }> = [];
    for (const beadId of beadIds) {
      let stateId = 'unknown';
      try {
        const projection = await this.eventStore.projectBead(beadId, { includeDetails: false });
        if (projection.status) stateId = String(projection.status);
      } catch {
        // best-effort — keep 'unknown'
      }
      assignments.push({ beadId, stateId });
    }
    return assignments;
  }

  public isBeadStarted(id: string): boolean {
    return this.startedBeads.has(id);
  }

  public markBeadExited(id: string, options: { preserveInactiveRestartBackoff?: boolean } = {}) {
    this.startedBeads.delete(id);
    this.startedBeadAtMs.delete(id);
    this.missingStartedBeadChecks.delete(id);
    this.finalBlockedPollCounts.delete(id);
    if (!options.preserveInactiveRestartBackoff) this.inactiveRestartedAtMs.delete(id);
  }

  public isSignalProcessed(key: string): boolean {
    return this.processedSignals.has(key);
  }

  public markSignalProcessed(key: string) {
    this.processedSignals.add(key);
  }

  public pauseSchedulingUntil(pauseUntilMs: number, reason: string): void {
    if (!Number.isFinite(pauseUntilMs) || pauseUntilMs <= this.clock.now()) return;
    if (pauseUntilMs <= this.schedulingPausedUntilMs) return;
    this.schedulingPausedUntilMs = pauseUntilMs;
    this.schedulingPausedReason = reason;
    // Persist the legacy HARNESS_CAPACITY_LIMIT_REACHED event (used by
    // restoreCapacityPauseFromStore on coordinator restart) and the new
    // SCHEDULING_PAUSED event (fired exactly once per distinct pause window).
    const pauseUntilIso = this.clock.date(pauseUntilMs).toISOString();
    void this.eventStore.record(DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED, {
      pauseUntil: pauseUntilIso,
      reason
    }).catch(() => {});
    // Fire SCHEDULING_PAUSED exactly once per distinct pauseUntil value so
    // operators see a single clean enter-event rather than per-poll noise.
    if (pauseUntilMs !== this.lastSchedulingPausedEventMs) {
      this.lastSchedulingPausedEventMs = pauseUntilMs;
      this.lastPauseHeartbeatMs = this.clock.now();
      void this.eventStore.record(DomainEventName.SCHEDULING_PAUSED, {
        pauseUntil: pauseUntilIso,
        reason
      }).catch(() => {});
      Logger.warn(Component.SUPERVISOR, 'Scheduling paused; entering quiet capacity-pause mode', {
        pauseUntil: pauseUntilIso,
        reason
      });
    }
  }

  private async restoreCapacityPauseFromStore(): Promise<void> {
    const latestCapacityEvent = await this.eventStore.latestEventByType(DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED).catch((error: unknown) => {
      Logger.warn(Component.SUPERVISOR, 'Unable to restore capacity pause from event store', { error: String(error) });
      return undefined;
    });
    const pauseUntilMs = Date.parse(String(latestCapacityEvent?.data?.pauseUntil || ''));
    if (!Number.isFinite(pauseUntilMs) || pauseUntilMs <= this.clock.now()) return;

    this.schedulingPausedUntilMs = pauseUntilMs;
    this.schedulingPausedReason = String(latestCapacityEvent?.data?.reason || latestCapacityEvent?.data?.summary || 'Harness capacity limit reached');
    Logger.warn(Component.SUPERVISOR, 'Restored scheduling pause from event store', {
      pauseUntil: this.pausedUntilIso(),
      reason: this.schedulingPausedReason
    });
  }

  /**
   * Rebuilds `processedSignals` from durable TEAMMATE_EVENT records so that
   * idempotency survives a coordinator restart.  Replays all TEAMMATE_EVENT
   * events whose processingDecision is ACCEPT and adds their idempotencyKey to
   * the in-memory set — identical to what markSignalProcessed() does on the
   * happy path.  Called once during start(), before the first supervisor step,
   * so re-delivered signals are recognized as duplicates even after a restart.
   *
   * Accepts an optional pre-fetched `events` array so that start() can share
   * a single readAll() pass with reconcileUnacknowledgedSignalIntents().  When
   * called without arguments (e.g. directly in tests) it fetches events itself.
   */
  private async rebuildProcessedSignalsFromEvents(events?: DomainEvent[]): Promise<void> {
    let rebuilt = 0;
    try {
      const allEvents = events ?? await this.eventStore.readAll();
      for (const event of allEvents) {
        if (event.type !== DomainEventName.TEAMMATE_EVENT) continue;
        const data = event.data || {};
        if (data.processingDecision !== TeammateEventDecisionAction.ACCEPT) continue;
        const key = String(data.idempotencyKey || '');
        if (!key) continue;
        this.processedSignals.add(key);
        rebuilt++;
      }
      if (rebuilt > 0) {
        Logger.info(Component.SUPERVISOR, 'Rebuilt processed-signal idempotency set from event store', { rebuilt });
      }
    } catch (error) {
      Logger.warn(Component.SUPERVISOR, 'Unable to rebuild processed-signal set from event store; idempotency layer is in-memory only this session', { error: String(error) });
    }
  }

  /**
   * Reconciles SIGNAL_INTENT_RECORDED events that have no corresponding
   * processed TEAMMATE_EVENT (by idempotencyKey).  An intent without a matching
   * accepted decision means the coordinator crashed or the POST failed after the
   * intent was written — the signal was never applied.  Emits a
   * SIGNAL_INTENT_RECONCILED event so operators can detect unacknowledged intents
   * without silently losing them.  The reconciliation itself is idempotent: an
   * intent that already has a SIGNAL_INTENT_RECONCILED event is skipped.
   *
   * Accepts an optional pre-fetched `events` array so that start() can share
   * a single readAll() pass with rebuildProcessedSignalsFromEvents().  When
   * called without arguments (e.g. directly in tests) it fetches events itself.
   */
  private async reconcileUnacknowledgedSignalIntents(events?: DomainEvent[]): Promise<void> {
    try {
      const allEvents = events ?? await this.eventStore.readAll();

      // Build the set of idempotency keys already processed (ACCEPT decision) or
      // already reconciled (a prior startup already emitted SIGNAL_INTENT_RECONCILED).
      const processedKeys = new Set<string>();
      const reconciledKeys = new Set<string>();
      const intentsByKey = new Map<string, DomainEvent>();

      for (const event of allEvents) {
        const data = event.data || {};
        const key = String(data.idempotencyKey || '');
        if (!key) continue;

        if (event.type === DomainEventName.SIGNAL_INTENT_RECORDED) {
          // Keep the first recorded intent per key (earliest write).
          if (!intentsByKey.has(key)) intentsByKey.set(key, event);
          continue;
        }
        if (event.type === DomainEventName.TEAMMATE_EVENT && data.processingDecision === TeammateEventDecisionAction.ACCEPT) {
          processedKeys.add(key);
          continue;
        }
        if (event.type === DomainEventName.SIGNAL_ACKNOWLEDGED) {
          processedKeys.add(key);
          continue;
        }
        if (event.type === DomainEventName.SIGNAL_INTENT_RECONCILED) {
          reconciledKeys.add(key);
        }
      }

      // Identify intents that were recorded but never applied and not yet reconciled.
      const unacknowledgedKeys = [...intentsByKey.keys()].filter(
        key => !processedKeys.has(key) && !reconciledKeys.has(key)
      );

      for (const key of unacknowledgedKeys) {
        const intentEvent = intentsByKey.get(key)!;
        const intentData = intentEvent.data || {};
        Logger.warn(Component.SUPERVISOR, 'Reconciling unacknowledged signal intent on startup', {
          idempotencyKey: key,
          beadId: intentData.beadId,
          type: intentData.type,
          stateId: intentData.stateId
        });
        await this.eventStore.record(DomainEventName.SIGNAL_INTENT_RECONCILED, {
          idempotencyKey: key,
          beadId: intentData.beadId,
          type: intentData.type,
          stateId: intentData.stateId,
          intentTimestamp: intentEvent.timestamp,
          reason: 'No processed TEAMMATE_EVENT or SIGNAL_ACKNOWLEDGED found for this intent after coordinator restart'
        }).catch(() => {});
      }

      if (unacknowledgedKeys.length > 0) {
        Logger.info(Component.SUPERVISOR, 'Signal intent reconciliation complete', { unacknowledgedCount: unacknowledgedKeys.length });
      }
    } catch (error) {
      Logger.warn(Component.SUPERVISOR, 'Unable to reconcile unacknowledged signal intents', { error: String(error) });
    }
  }

  /**
   * Rehydrates the in-memory quarantine map from durable BEAD_QUARANTINED events
   * on coordinator restart.  Replays the LATEST BEAD_QUARANTINED event per bead
   * and restores the quarantine entry so that scanAndSpawn skips unchanged-broken
   * beads without re-claiming, re-provisioning a worktree, or re-spawning.
   *
   * The rehydrated entry carries the signature recorded at quarantine time.  When
   * isQuarantined() is next called for that bead, the CURRENT bead signature is
   * compared against the stored one: if unchanged, the bead is still skipped; if
   * changed (bead state evolved externally), the entry is cleared and a
   * BEAD_QUARANTINE_CLEARED event is emitted so the retry is explained durably.
   *
   * Accepts an optional pre-fetched `events` array so that start() can share the
   * single readAll() pass with rebuildProcessedSignalsFromEvents() and
   * reconcileUnacknowledgedSignalIntents().
   */
  private async rehydrateQuarantinesFromEvents(events?: DomainEvent[]): Promise<void> {
    try {
      const allEvents = events ?? await this.eventStore.readAll();

      // Collect the LATEST BEAD_QUARANTINED event per beadId (last write wins).
      const latestByBead = new Map<string, DomainEvent>();
      for (const event of allEvents) {
        if (event.type !== DomainEventName.BEAD_QUARANTINED) continue;
        const beadId = String(event.data?.beadId || '');
        if (!beadId) continue;
        latestByBead.set(beadId, event);
      }

      let rehydrated = 0;
      for (const [beadId, event] of latestByBead) {
        const reason = String(event.data?.reason || '');
        const signature = String(event.data?.signature || '');
        if (!reason || !signature) continue;

        this.quarantine.set(beadId, { reason: reason as QuarantineReason, signature });
        this.rehydratedQuarantineBeadIds.add(beadId);
        rehydrated++;

        await this.eventStore.record(DomainEventName.BEAD_QUARANTINE_REHYDRATED, {
          beadId,
          reason,
          signature
        }).catch(() => {});
      }

      if (rehydrated > 0) {
        Logger.info(Component.SUPERVISOR, 'Rehydrated bead quarantines from event store on startup', { rehydrated });
      }
    } catch (error) {
      Logger.warn(Component.SUPERVISOR, 'Unable to rehydrate quarantines from event store; quarantine state is in-memory only this session', { error: String(error) });
    }
  }

  private isSchedulingPaused(): boolean {
    return this.schedulingPausedUntilMs > this.clock.now();
  }

  private pausedUntilIso(): string {
    return this.clock.date(this.schedulingPausedUntilMs).toISOString();
  }

  private reportPausedScheduling(): void {
    const pauseUntil = this.pausedUntilIso();
    if (this.ctx.hasUI) {
      this.ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), `Paused until ${pauseUntil}`);
    }
    // Emit a low-frequency heartbeat at most once per PAUSE_HEARTBEAT_INTERVAL_MS
    // so operators can confirm the pause is still active without flooding the log.
    const now = this.clock.now();
    if (now - this.lastPauseHeartbeatMs < SupervisorDefaults.PAUSE_HEARTBEAT_INTERVAL_MS) return;
    this.lastPauseHeartbeatMs = now;
    void this.eventStore.record(DomainEventName.SCHEDULING_PAUSE_HEARTBEAT, {
      pauseUntil,
      reason: this.schedulingPausedReason
    }).catch(() => {});
    Logger.warn(Component.SUPERVISOR, 'Scheduling still paused (capacity-pause heartbeat)', {
      pauseUntil,
      reason: this.schedulingPausedReason
    });
  }

  private beadsPort(): BeadsPort {
    return this.services.beadsPort;
  }

  private worktreePort(): WorktreePort {
    return this.services.worktreePort;
  }

  // ---------------------------------------------------------------------------
  // Quarantine helpers
  // ---------------------------------------------------------------------------

  /** Derive a stable signature for the given bead that captures the external
   * state that must CHANGE before a quarantined re-attempt is warranted.
   * Uses status + lastActivity so that a bead update, re-assignment, or any
   * activity timestamp bump by the user lifts the quarantine automatically.
   * Both fields are typed on Bead — no unsafe cast needed. */
  private quarantineSignatureFor(bead: Bead): string {
    return `${bead.status}:${bead.lastActivity || ''}`;
  }

  /** Classify a worktree-creation error string into a structured QuarantineReason. */
  private classifyWorktreeError(errorText: string): QuarantineReason {
    const lower = errorText.toLowerCase();
    // "already checked out" — git worktree add rejects a branch in use by another worktree
    if (lower.includes('already checked out') || lower.includes('is already checked out')) {
      return QuarantineReason.ALREADY_CHECKED_OUT;
    }
    // "invalid reference" / "invalid branch ref" / "not a valid object name"
    if (
      lower.includes('invalid reference') ||
      lower.includes('not a valid object name') ||
      lower.includes('invalid branch') ||
      lower.includes('bad revision') ||
      (lower.includes('pathspec') && lower.includes('did not match'))
    ) {
      return QuarantineReason.INVALID_BRANCH_REF;
    }
    // Worktree path already exists on disk (git worktree add refuses to clobber)
    if (lower.includes('already exists') || lower.includes('file exists') || lower.includes('path is already')) {
      return QuarantineReason.WORKTREE_PATH_TAKEN;
    }
    return QuarantineReason.UNKNOWN;
  }

  /** Returns true if the bead is currently quarantined with an UNCHANGED signature.
   * If the signature changed (bead state evolved externally) the quarantine entry is
   * cleared and the bead is eligible for a re-attempt.
   * When the cleared entry was rehydrated from a durable event, emits a
   * BEAD_QUARANTINE_CLEARED event so the retry is explained in the event log. */
  private async isQuarantined(bead: Bead): Promise<boolean> {
    const entry = this.quarantine.get(bead.id);
    if (!entry) return false;
    const currentSig = this.quarantineSignatureFor(bead);
    if (currentSig !== entry.signature) {
      // Signature changed — bead state evolved; clear quarantine and allow retry.
      const wasRehydrated = this.rehydratedQuarantineBeadIds.has(bead.id);
      this.quarantine.delete(bead.id);
      this.rehydratedQuarantineBeadIds.delete(bead.id);
      if (wasRehydrated) {
        // Emit a durable event so operators can trace the retry back to the cleared quarantine.
        await this.eventStore.record(DomainEventName.BEAD_QUARANTINE_CLEARED, {
          beadId: bead.id,
          reason: entry.reason,
          previousSignature: entry.signature,
          currentSignature: currentSig
        }).catch(() => {});
        Logger.info(Component.SUPERVISOR, 'Rehydrated quarantine cleared — bead eligible for retry', {
          beadId: bead.id,
          reason: entry.reason,
          previousSignature: entry.signature,
          currentSignature: currentSig
        });
      }
      return false;
    }
    return true;
  }

  /** Quarantine a bead with a structured reason + its current signature.
   * Emits a bounded BEAD_QUARANTINED event exactly once per quarantine entry
   * (subsequent ticks skip silently until the signature changes). */
  private async quarantineBead(bead: Bead, reason: QuarantineReason, details: Record<string, unknown> = {}): Promise<void> {
    const signature = this.quarantineSignatureFor(bead);
    this.quarantine.set(bead.id, { reason, signature, details });
    await this.eventStore.record(DomainEventName.BEAD_QUARANTINED, {
      beadId: bead.id,
      reason,
      signature,
      ...details
    }).catch(() => {});
    Logger.warn(Component.SUPERVISOR, 'Bead quarantined by supervisor preflight', {
      beadId: bead.id,
      reason,
      ...details
    });
  }

  private configuredOutcomesForState(stateId: string, config: HarnessConfig): string[] {
    const state = config.states?.[stateId];
    if (!state) return [];
    return [...new Set([
      ...Object.keys(state.on || {}),
      ...Object.keys(state.transitions || {})
    ])].sort();
  }

  private restartEventMatchesTarget(event: DomainEvent, stateId: string): boolean {
    const data = event.data || {};
    const targetState = String(data.targetState || data.restartTargetState || data.stateId || '');
    return targetState === stateId;
  }

  private latestHarnessRestartRequestEvent(events: DomainEvent[], stateId: string): DomainEvent | undefined {
    for (const event of [...events].reverse()) {
      const data = event.data || {};
      if (event.type === DomainEventName.HARNESS_RESTART_REQUESTED && this.restartEventMatchesTarget(event, stateId)) {
        return event;
      }
      if (
        event.type === DomainEventName.TEAMMATE_EVENT &&
        data.type === TeammateEventType.HARNESS_RESTART_REQUESTED &&
        data.processingDecision === TeammateEventDecisionAction.ACCEPT &&
        this.restartEventMatchesTarget(event, stateId)
      ) {
        return event;
      }
    }
    return undefined;
  }

  private eventAtOrAfter(candidate: DomainEvent, reference: DomainEvent): boolean {
    const candidateMs = Date.parse(candidate.timestamp);
    const referenceMs = Date.parse(reference.timestamp);
    if (Number.isFinite(candidateMs) && Number.isFinite(referenceMs) && candidateMs !== referenceMs) {
      return candidateMs > referenceMs;
    }
    return String(candidate.id || '').localeCompare(String(reference.id || '')) >= 0;
  }

  private async nonRoutableTerminalFailureLimitRestartDetails(
    bead: ScoredBead & { stateId: string },
    config: HarnessConfig
  ): Promise<NonRoutableTerminalFailureLimitQuarantineDetails | undefined> {
    const stateId = bead.stateId;
    const state = config.states?.[stateId];
    if (!state) return undefined;

    const terminalFailureEvent = await this.eventStore.latestProjectToolFailureLimitEvent(bead.id, {
      stateId,
      terminalOnly: true
    }).catch((error: unknown) => {
      Logger.warn(Component.SUPERVISOR, 'Unable to inspect terminal tool failure-limit before spawn', {
        beadId: bead.id,
        stateId,
        error: String(error)
      });
      return undefined;
    });
    if (!terminalFailureEvent) return undefined;

    const events = await this.eventStore.eventsForBead(bead.id).catch((error: unknown) => {
      Logger.warn(Component.SUPERVISOR, 'Unable to inspect restart events before spawn', {
        beadId: bead.id,
        stateId,
        error: String(error)
      });
      return [];
    });
    const restartEvent = this.latestHarnessRestartRequestEvent(events, stateId);
    if (!restartEvent || !this.eventAtOrAfter(restartEvent, terminalFailureEvent)) return undefined;

    // Event payloads are schemaless JSON keyed by string; read this one as a
    // loose record at the consumer boundary (the typed persistence boundary is
    // DomainEvent.data: EventData — pf7v). Field types are validated inline below.
    const terminalData = terminalFailureEvent.data as Record<string, any>;
    const result = terminalData.result || {};
    const failureLimit = result.failureLimit || {};
    const actionId = typeof terminalData.actionId === 'string' ? terminalData.actionId : '';
    if (!actionId) return undefined;

    const toolName = typeof terminalData.tool === 'string'
      ? terminalData.tool
      : typeof result.tool === 'string'
        ? result.tool
        : 'unknown';
    const toolDefinition = config.tools?.find(tool => tool.name === toolName);
    const suggestedOutcome = typeof failureLimit.suggestedOutcome === 'string'
      ? failureLimit.suggestedOutcome
      : projectToolFailureLimitSuggestedOutcome(toolDefinition, stateId, actionId) || EventName.BLOCKED;

    let suggestedOutcomeTransitionError = '';
    try {
      this.services.flowManager.nextState(state, suggestedOutcome, stateId);
      return undefined;
    } catch (error) {
      suggestedOutcomeTransitionError = String(error);
    }

    const restartData = restartEvent.data || {};
    return {
      stateId,
      actionId,
      toolName,
      suggestedOutcome,
      configuredOutcomes: this.configuredOutcomesForState(stateId, config),
      suggestedOutcomeTransitionError,
      restartTargetState: String(restartData.targetState || restartData.restartTargetState || restartData.stateId || stateId),
      restartEvent: String(restartData.transitionEvent || ''),
      sourceEventType: String(restartEvent.type),
      sourceEventId: restartEvent.id,
      sourceIdempotencyKey: typeof restartData.idempotencyKey === 'string' ? restartData.idempotencyKey : undefined,
      terminalFailureEventId: terminalFailureEvent.id,
      terminalFailureEventTimestamp: terminalFailureEvent.timestamp
    };
  }

  // ---------------------------------------------------------------------------
  // Worktree allocation policy
  // ---------------------------------------------------------------------------

  /**
   * Resolve whether a worktree should be provisioned for a given stateId,
   * according to the configured `settings.worktreePolicy` and per-state
   * `provisionWorktree` override.
   *
   * Resolution order (highest to lowest precedence):
   *   1. Per-state `provisionWorktree` (explicit boolean on the SDLCState)
   *   2. `settings.worktreePolicy.default` ('always' | 'never')
   *   3. Hard default: 'always' — every state gets a worktree (backward compat)
   *
   * This encodes the invariant described in AGENTS.md and the bead acceptance
   * criteria without altering existing behavior for configs that omit the field.
   */
  private resolveWorktreeProvisioning(stateId: string, config: HarnessConfig): boolean {
    const stateConfig = config.states?.[stateId];
    // 1. Per-state explicit override wins over everything.
    if (stateConfig?.provisionWorktree !== undefined) {
      return stateConfig.provisionWorktree;
    }
    // 2. Policy-level default.
    const policyDefault: WorktreeProvisioningMode = config.settings?.worktreePolicy?.default ?? 'always';
    return policyDefault !== 'never';
  }

  private async releaseClaimedAfterPause(claimed: Bead): Promise<void> {
    await this.beadsPort().release(claimed.id).catch((error: unknown) => {
      Logger.warn(Component.SUPERVISOR, 'Unable to release Bead lease after scheduling pause', {
        beadId: claimed.id,
        error: String(error)
      });
    });
    this.markBeadExited(claimed.id, { preserveInactiveRestartBackoff: true });
    Logger.warn(Component.SUPERVISOR, 'Stopped assignment dispatch after scheduling pause', {
      beadId: claimed.id,
      pauseUntil: this.pausedUntilIso(),
      reason: this.schedulingPausedReason
    });
  }

  /**
   * Return the names of MCP-backed required tools for the given bead/state (s3wp.32).
   *
   * Collects required tool names from both the state and all of its actions,
   * then filters to those backed by MCP-type project tools. The result is used
   * to gate spawning: if any required MCP tool is unhealthy, the bead is skipped.
   */
  private requiredMcpToolNamesForBead(
    stateId: string,
    config: HarnessConfig
  ): string[] {
    const state = config.states?.[stateId];
    if (!state) return [];

    // Collect required tool names from state-level and all action-level declarations.
    const requiredNames = new Set<string>();
    for (const tool of state.requiredTools || []) {
      const name = typeof tool === 'string' ? tool : tool.name;
      if (name) requiredNames.add(name);
    }
    for (const action of state.actions || []) {
      for (const tool of action.requiredTools || []) {
        const name = typeof tool === 'string' ? tool : tool.name;
        if (name) requiredNames.add(name);
      }
    }
    if (requiredNames.size === 0) return [];

    return mcpBackedRequiredToolNames([...requiredNames], config.tools || []);
  }

  /**
   * Run the MCP bridge preflight for a set of required MCP tool names (s3wp.32).
   *
   * Caches the result on this Supervisor instance so the same probe result is
   * reused across scan-loop iterations (collapsed health, not per-worker spam).
   * Records a single domain event on the first unique failure.
   */
  private async runMcpPreflightForTools(mcpToolNames: string[]): Promise<McpBridgeHealth> {
    const health = await checkMcpBridgeHealth(
      mcpToolNames,
      (data) => this.eventStore.record(DomainEventName.MCP_TRANSPORT_PREFLIGHT_FAILED, data)
    );
    // Cache on this Supervisor instance for harness_status reporting.
    if (!this.mcpBridgeHealth || (!this.mcpBridgeHealth.healthy && health.healthy)) {
      this.mcpBridgeHealth = health;
    }
    if (!health.healthy && this.mcpBridgeHealth?.healthy !== false) {
      this.mcpBridgeHealth = health;
    }
    return health;
  }

  /** Claim one bead, conditionally provision its worktree, record the event,
   * and spawn a teammate.  Owns the full claim → [worktree] → record → spawn
   * sequence for a single bead, including releasing the lease on every failure
   * path.
   *
   * Whether a worktree is provisioned is determined by `resolveWorktreeProvisioning`:
   *   1. Per-state `provisionWorktree` (explicit boolean override on the SDLCState)
   *   2. `settings.worktreePolicy.default` ('always' | 'never')
   *   3. Hard default: 'always' (preserves behavior for configs without the field)
   *
   * Returns:
   *   'spawned'     — success; continue to the next bead.
   *   'paused'      — scheduling pause detected mid-flight; caller should break the loop.
   *   'quarantined' — worktree creation failed and the bead was quarantined; caller skips
   *                   this bead but continues processing others (no slot consumed).
   *   throws        — hard failure (spawn failure or unexpected error); caller catches and records.
   */
  private async claimAndSpawnBead(
    bead: ScoredBead & { stateId: string },
    config: HarnessConfig
  ): Promise<'spawned' | 'paused' | 'quarantined'> {
    if (this.ctx.hasUI) this.ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), `Claiming ${bead.id}...`);

    const beadsPort = this.beadsPort();
    const worktreePort = this.worktreePort();

    const claimed = await beadsPort.claim({
      id: bead.id,
      owner: App.DISPLAY_NAME,
      stateId: bead.stateId,
      leaseTtlMs: config.settings?.agentTurnTimeoutMs || Defaults.LEASE_TTL_MS
    }, this.ctx);

    // Post-claim pause check: pause was detected while the claim was in-flight.
    // Release the lease we just acquired and signal the caller to break.
    if (this.isSchedulingPaused()) {
      await this.releaseClaimedAfterPause(claimed);
      return 'paused';
    }

    if (this.stopping) {
      await beadsPort.release(claimed.id).catch(() => {});
      this.startedBeads.delete(claimed.id);
      return 'paused';
    }

    // Worktree Allocation Policy
    // resolveWorktreeProvisioning checks per-state override then policy default.
    // Default is 'always' for backward compatibility.
    const needsWorktree = this.resolveWorktreeProvisioning(bead.stateId, config);
    let worktreePath: string;

    if (needsWorktree) {
      const result = await worktreePort.createWorktree(claimed.id, this.ctx);
      worktreePath = result.path ?? '';
      if (result.success !== true || !worktreePath) {
        // Release the lease before quarantining — preserves WI-11 lease integrity.
        await beadsPort.release(claimed.id).catch(() => {});
        this.startedBeads.delete(claimed.id);
        this.startedBeadAtMs.delete(claimed.id);
        // Classify and quarantine — emit once-per-quarantine structured event.
        const errorText = result.error || `Failed to provision worktree for ${claimed.id}`;
        const quarantineReason = this.classifyWorktreeError(errorText);
        await this.quarantineBead(bead, quarantineReason);
        return 'quarantined';
      }
      await this.eventStore.record(DomainEventName.WORKTREE_PROVISIONED, { beadId: claimed.id, worktreePath });
    } else {
      // No worktree for this state: use the project root so the teammate runs
      // in the shared checked-out tree (read-only states such as Planning/Review).
      worktreePath = this.services.projectRoot;
      Logger.info(Component.SUPERVISOR, `Worktree provisioning skipped for state ${bead.stateId}; teammate will run at project root`, {
        beadId: claimed.id,
        stateId: bead.stateId
      });
    }

    // Post-worktree pause check: pause was detected after worktree decision.
    // Release the lease and signal the caller to break.
    if (this.isSchedulingPaused()) {
      await this.releaseClaimedAfterPause(claimed);
      return 'paused';
    }

    if (this.ctx.hasUI) this.ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), `Spawning ${bead.id} (${bead.stateId})...`);

    const spawnStartMs = Date.now();
    const spawned = await this.factory.spawnTeammateInTmux(claimed.id, bead.stateId, worktreePath, this.ctx);
    const spawnEndMs = Date.now();

    // Emit a teammate_spawn span covering the tmux pane creation duration.
    try {
      this.observability.recordCompletedSpan(SpanName.TEAMMATE_SPAWN, {
        [OtelAttr.ORR_ELSE_BEAD_ID]: claimed.id,
        [OtelAttr.ORR_ELSE_STATE_ID]: bead.stateId,
        'spawn.success': spawned.success
      }, spawnStartMs, spawnEndMs);
    } catch {
      // Span emission is best-effort — never block the spawn path.
    }

    if (!spawned.success) {
      await beadsPort.release(claimed.id).catch(() => {});
      throw new Error(spawned.error || `Failed to spawn teammate for ${claimed.id}`);
    }
    Logger.info(Component.SUPERVISOR, `Teammate spawned for ${bead.id} in phase ${bead.stateId}`);
    return 'spawned';
  }

  private async step() {
    if (this.stopping || this.stepInProgress) return;
    this.stepInProgress = true;
    try {
      // FIX-1: invalidate the BeadsClient read cache at tick-start so that
      // mutations made by worker processes (separate bd instances, separate caches)
      // are visible to the coordinator's reads this tick.  Intra-tick dedup is
      // preserved — mutate() already invalidates after each mutation.
      this.services.beadsPort.invalidateCache();
      await this.observability.tracedAsync('supervisor_step', {}, async () => {
        await this.reconcileStartedBeads();
        await this.reconcileTerminalLiveBeads();
        await this.scanAndSpawn();
        await this.recordSlotHealth('after_scan');
        await this.runRetentionCleanupIfDue();
      })();
    } finally {
      this.stepInProgress = false;
    }
  }

  private async reconcileStartedBeads() {
    if (this.startedBeads.size === 0) return;
    const liveBeadIds = await this.factory.getLiveTeammateBeadIds();
    for (const beadId of [...this.startedBeads]) {
      if (liveBeadIds.has(beadId)) {
        this.missingStartedBeadChecks.delete(beadId);
        continue;
      }
      const missingChecks = (this.missingStartedBeadChecks.get(beadId) || 0) + 1;
      this.missingStartedBeadChecks.set(beadId, missingChecks);
      const restartDetails = await this.restartDetailsForMissingStartedBead(beadId);
      if (!restartDetails && missingChecks < Defaults.TEAMMATE_MISSING_REAP_THRESHOLD) continue;

      this.startedBeads.delete(beadId);
      this.startedBeadAtMs.delete(beadId);
      this.missingStartedBeadChecks.delete(beadId);
      const eventData = restartDetails
        ? {
          beadId,
          reason: 'restart_requested_missing_pane',
          missingChecks,
          ...restartDetails
        }
        : { beadId };
      Logger.warn(Component.SUPERVISOR, 'Teammate process is no longer active; releasing scheduler slot', eventData);
      await this.eventStore.record(DomainEventName.TEAMMATE_PROCESS_EXITED, eventData).catch(() => {});
      await this.beadsPort().release(beadId).catch((error: unknown) => {
        Logger.warn(Component.SUPERVISOR, 'Unable to release Bead lease for exited teammate', {
          beadId,
          error: String(error)
        });
      });
    }
  }

  private async restartDetailsForMissingStartedBead(beadId: string): Promise<MissingStartedRestartDetails | undefined> {
    try {
      const projection = await this.eventStore.projectBead(beadId, { includeDetails: false });
      if (projection?.restartRequested === true) {
        return {
          restartKind: projection.restartKind,
          restartEvent: projection.restartEvent,
          restartFromState: projection.restartFromState,
          restartTargetState: projection.restartTargetState,
          sourceEventType: 'projection'
        };
      }
    } catch (error) {
      Logger.warn(Component.SUPERVISOR, 'Unable to inspect missing started Bead restart projection', {
        beadId,
        error: String(error)
      });
    }

    try {
      const events = await this.eventStore.eventsForBead(beadId);
      for (const event of [...events].reverse()) {
        // Schemaless JSON payload; loose-record view at the consumer boundary (pf7v).
        const data = event.data as Record<string, any>;
        if (event.type === DomainEventName.HARNESS_RESTART_REQUESTED || event.type === DomainEventName.CONTEXT_RESTART_REQUESTED) {
          return {
            restartKind: event.type === DomainEventName.HARNESS_RESTART_REQUESTED ? RestartKind.HARNESS : RestartKind.CONTEXT,
            restartEvent: data.transitionEvent,
            restartFromState: data.stateId,
            restartTargetState: data.targetState || data.stateId,
            sourceEventType: String(event.type)
          };
        }
        if (
          event.type === DomainEventName.TEAMMATE_EVENT &&
          (data.type === TeammateEventType.HARNESS_RESTART_REQUESTED || data.type === TeammateEventType.CONTEXT_RESTART_REQUESTED) &&
          data.processingDecision === TeammateEventDecisionAction.ACCEPT
        ) {
          return {
            restartKind: data.type === TeammateEventType.HARNESS_RESTART_REQUESTED ? RestartKind.HARNESS : RestartKind.CONTEXT,
            restartEvent: data.transitionEvent,
            restartFromState: data.stateId,
            restartTargetState: data.targetState || data.stateId,
            sourceEventType: String(data.type)
          };
        }
      }
    } catch (error) {
      Logger.warn(Component.SUPERVISOR, 'Unable to inspect missing started Bead restart events', {
        beadId,
        error: String(error)
      });
    }

    return undefined;
  }

  private async reconcileTerminalLiveBeads(): Promise<void> {
    const liveBeadIds = await this.factory.getLiveTeammateBeadIds();
    if (liveBeadIds.size === 0) return;

    for (const beadId of liveBeadIds) {
      let bead: Bead;
      try {
        bead = await this.beadsPort().getBead(beadId);
      } catch (error) {
        Logger.warn(Component.SUPERVISOR, 'Unable to inspect live teammate Bead status', { beadId, error: String(error) });
        continue;
      }
      if (!TERMINAL_BEAD_STATUSES.has(bead.status)) continue;

      const summary = `Live teammate is running for terminal Bead status ${bead.status}; terminating.`;
      Logger.warn(Component.SUPERVISOR, 'Terminating live teammate for terminal Bead status', {
        beadId,
        status: bead.status
      });
      await this.factory.terminateTeammatesForBead(beadId, summary).catch(error => {
        Logger.warn(Component.SUPERVISOR, 'Unable to terminate terminal teammate panes', { beadId, error: String(error) });
      });
      await this.beadsPort().release(beadId).catch((error: unknown) => {
        Logger.warn(Component.SUPERVISOR, 'Unable to release terminal Bead after teammate termination', { beadId, error: String(error) });
      });
      this.markBeadExited(beadId);
    }
  }

  private async scanAndSpawn() {
    if (this.isSchedulingPaused()) {
      this.reportPausedScheduling();
      return;
    }

    const config = await this.services.configLoader.load();
    const noProgressTimeoutMs = config.settings.teammateNoProgressTimeoutMs || SupervisorDefaults.NO_PROGRESS_TIMEOUT_MS;
    const activeStartedBeads = await this.activeStartedBeadIds();
    const excludedBeadIds = new Set(activeStartedBeads);
    for (const beadId of this.backoffBlockedBeadIds(noProgressTimeoutMs)) {
      excludedBeadIds.add(beadId);
    }
    const trackedSlots = Math.max(0, this.options.maxSlots - activeStartedBeads.size);
    const slots = Math.min(trackedSlots, await this.factory.getAvailableSlots());
    if (slots <= 0) {
      if (this.ctx.hasUI) this.ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), 'All slots full');
      return;
    }

    if (this.ctx.hasUI) this.ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), `Scanning backlog (${slots} slots free)`);

    const orchestrator = new Orchestrator(
      this.observability,
      this.services.configLoader,
      this.services.flowManager,
      this.services.scheduler,
      this.services.beadsPort,
      this.options.maxSlots
    );
    const assignments = await orchestrator.selectAssignments(slots, this.options.requestedBeadId, excludedBeadIds);

    if (assignments.length === 0) {
      if (this.ctx.hasUI) this.ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), 'Idle (Backlog empty)');
    }

    for (const bead of assignments) {
      if (this.stopping) break;
      const currentSlots = Math.min(
        Math.max(0, this.options.maxSlots - (await this.activeStartedBeadIds()).size),
        await this.factory.getAvailableSlots()
      );
      if (currentSlots <= 0) break;

      // PREFLIGHT: skip terminal/closed beads before claiming a slot.
      // This prevents claiming/spawning a bead that has already reached a terminal
      // state externally (e.g. closed via another process between backlog scan and now).
      // Also skip beads currently quarantined with an unchanged signature (worktree
      // creation would fail again identically — no slot-health churn).
      if (TERMINAL_BEAD_STATUSES.has(bead.status)) {
        Logger.info(Component.SUPERVISOR, 'Preflight: skipping terminal bead', {
          beadId: bead.id,
          status: bead.status
        });
        continue;
      }
      if (await this.isQuarantined(bead)) {
        Logger.info(Component.SUPERVISOR, 'Preflight: skipping quarantined bead (unchanged signature)', {
          beadId: bead.id,
          reason: this.quarantine.get(bead.id)?.reason
        });
        continue;
      }

      const terminalRestartDetails = await this.nonRoutableTerminalFailureLimitRestartDetails(bead, config);
      if (terminalRestartDetails) {
        await this.quarantineBead(
          bead,
          QuarantineReason.NON_ROUTABLE_TERMINAL_FAILURE_LIMIT,
          terminalRestartDetails
        );
        continue;
      }

      // PREFLIGHT: MCP transport health check (s3wp.32).
      // If the bead's state has required MCP-backed tools and the bridge is
      // unhealthy, skip this bead without spawning. The failure is logged and
      // collapsed to a single domain event (not repeated per bead).
      const requiredMcpTools = this.requiredMcpToolNamesForBead(bead.stateId, config);
      if (requiredMcpTools.length > 0) {
        const mcpHealth = await this.runMcpPreflightForTools(requiredMcpTools);
        if (!mcpHealth.healthy) {
          Logger.warn(Component.SUPERVISOR, 'Preflight: skipping bead — required MCP tools unavailable', {
            beadId: bead.id,
            stateId: bead.stateId,
            unavailableTools: mcpHealth.affectedToolNames,
            errorMessage: mcpHealth.message
          });
          continue;
        }
      }

      this.startedBeads.add(bead.id);
      this.startedBeadAtMs.set(bead.id, this.clock.now());
      try {
        const result = await this.claimAndSpawnBead(bead, config);
        if (result === 'paused') break;
        // 'quarantined': lease already released inside claimAndSpawnBead; continue
        // to next bead (slot not consumed, no churn).
        if (result === 'quarantined') continue;
        // 'spawned': success.
      } catch (error) {
        this.startedBeads.delete(bead.id);
        this.startedBeadAtMs.delete(bead.id);
        await this.eventStore.record(DomainEventName.ASSIGNMENT_FAILED, {
          beadId: bead.id,
          stateId: bead.stateId,
          error: String(error)
        }).catch(() => {});
        Logger.error(Component.SUPERVISOR, 'Failed to claim or spawn teammate', { beadId: bead.id, error: String(error) });
        if (this.ctx.hasUI) this.ctx.ui.notify(`Failed to spawn ${bead.id}: ${String(error)}`, 'error');
      }
    }

    const activeCount = await this.factory.getActiveTeammateCount();
    if (this.ctx.hasUI && activeCount > 0) {
      this.ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), `Active: ${activeCount}/${this.options.maxSlots} slots`);
    }
  }

  private async activeStartedBeadIds(): Promise<Set<string>> {
    const liveBeadIds = await this.factory.getLiveTeammateBeadIds();
    await this.pruneDurablyInactiveStartedBeads(liveBeadIds);
    const missingStarted = [...this.startedBeads].filter(beadId => !liveBeadIds.has(beadId));
    this.lastMissingStartedBeadIds = new Set(missingStarted);
    if (missingStarted.length > 0) {
      Logger.warn(Component.SUPERVISOR, 'Ignoring tracked Beads without live teammate panes for capacity calculation', {
        missingStartedBeadIds: missingStarted.sort(),
        liveBeadIds: [...liveBeadIds].sort()
      });
    }
    return liveBeadIds;
  }

  private async pruneDurablyInactiveStartedBeads(liveBeadIds: Set<string>): Promise<void> {
    const candidates = [...this.startedBeads].filter(beadId => !liveBeadIds.has(beadId));
    if (candidates.length === 0) return;

    let groupedEvents: Map<string, DomainEvent[]>;
    try {
      groupedEvents = await this.eventStore.eventsForBeads(candidates);
    } catch (error) {
      Logger.warn(Component.SUPERVISOR, 'Unable to inspect tracked Bead release events', {
        beadIds: candidates.sort(),
        error: String(error)
      });
      return;
    }

    const prunedBeadIds: string[] = [];
    for (const beadId of candidates) {
      if (!this.hasDurableInactiveEvent(beadId, groupedEvents.get(beadId) || [])) continue;
      this.markBeadExited(beadId);
      prunedBeadIds.push(beadId);
    }

    if (prunedBeadIds.length > 0) {
      // Record released beads for inclusion in the current slot-health snapshot.
      this.releasedThisTick.push(...prunedBeadIds);
      Logger.info(Component.SUPERVISOR, 'Pruned released or exited Beads from slot health tracking', {
        beadIds: prunedBeadIds.sort()
      });
    }
  }

  private hasDurableInactiveEvent(beadId: string, events: DomainEvent[]): boolean {
    const startedAtMs = this.startedBeadAtMs.get(beadId) || 0;
    const relevantEvents = events
      .filter(event => {
        if (startedAtMs <= 0) return true;
        const timestampMs = Date.parse(event.timestamp);
        return Number.isFinite(timestampMs) && timestampMs >= startedAtMs;
      })
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    let latestTrackedState: 'active' | 'inactive' | undefined;

    for (const event of relevantEvents) {
      switch (event.type) {
        case DomainEventName.BEAD_CLAIMED:
        case DomainEventName.TEAMMATE_SPAWNED:
          latestTrackedState = 'active';
          break;
        case DomainEventName.BEAD_RELEASED:
        case DomainEventName.BEAD_CLOSED:
        case DomainEventName.TEAMMATE_PROCESS_EXITED:
        case DomainEventName.BEAD_TOMBSTONED:
          latestTrackedState = 'inactive';
          break;
        case DomainEventName.BEAD_STATUS_UPDATED:
          if (TERMINAL_BEAD_STATUSES.has(String(event.data?.status || ''))) {
            latestTrackedState = 'inactive';
          }
          break;
      }
    }

    return latestTrackedState === 'inactive';
  }

  private backoffBlockedBeadIds(noProgressTimeoutMs: number): string[] {
    const now = this.clock.now();
    const blocked: string[] = [];
    for (const [beadId, restartedAtMs] of this.inactiveRestartedAtMs.entries()) {
      if (now - restartedAtMs >= noProgressTimeoutMs) {
        this.inactiveRestartedAtMs.delete(beadId);
      } else {
        blocked.push(beadId);
      }
    }
    return blocked.sort();
  }

  private async collectSlotHealthSnapshot(): Promise<SlotHealthSnapshot> {
    // Clear the released-this-tick accumulator before the prune step so only
    // beads pruned during THIS snapshot are included in the churn report.
    this.releasedThisTick = [];

    const liveBeadIds = [...await this.factory.getLiveTeammateBeadIds()].sort();
    await this.pruneDurablyInactiveStartedBeads(new Set(liveBeadIds));
    const config = await this.services.configLoader.load();
    const noProgressTimeoutMs = config.settings.teammateNoProgressTimeoutMs || SupervisorDefaults.NO_PROGRESS_TIMEOUT_MS;
    const heartbeatByBead = new Map<string, number>();
    for (const heartbeat of this.server.getHeartbeatSnapshot()) {
      if (!heartbeat.beadId) continue;
      const previous = heartbeatByBead.get(heartbeat.beadId) || 0;
      heartbeatByBead.set(heartbeat.beadId, Math.max(previous, heartbeat.timestampMs));
    }
    const heartbeatDetails = this.server.getHeartbeatSnapshot();
    const latestProgressEvents = await this.eventStore.latestEventsForBeads(liveBeadIds, {
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
      const latestProgress = latestProgressEvents.get(beadId);
      const latestProgressMs = latestProgress ? Date.parse(latestProgress.timestamp) : this.startedBeadAtMs.get(beadId) || 0;
      return Number.isFinite(latestProgressMs) && latestProgressMs > 0 && now - latestProgressMs > noProgressTimeoutMs;
    });
    const staleBeadIds = [...new Set(inactiveBeadIds)].sort();
    const heartbeatOnlyStaleBeadIds = staleHeartbeatBeadIds
      .filter(beadId => !staleBeadIds.includes(beadId))
      .sort();
    const expectedCount = this.options.maxSlots;
    const trackedBeadIds = [...this.startedBeads].sort();
    const missingTrackedBeadIds = trackedBeadIds
      .filter(beadId => !liveBeadIds.includes(beadId) || this.lastMissingStartedBeadIds.has(beadId));
    const effectiveLiveBeadIds = liveBeadIds.filter(beadId => !missingTrackedBeadIds.includes(beadId));
    const activeCount = effectiveLiveBeadIds.length;
    const workingCount = activeCount - staleBeadIds.filter(beadId => effectiveLiveBeadIds.includes(beadId)).length;
    // Clear suppressed entries when the bead re-appears in the live pane set
    // (late pane-registration healed the gap; restart the lifecycle cleanly).
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

    // Churn-diagnostic sets (s3wp.33).
    // trackedOnly: tracked but not live → possible silent exit without pane-death event.
    const trackedSet = new Set(trackedBeadIds);
    const liveSet = new Set(liveBeadIds);
    const trackedOnlyBeadIds = trackedBeadIds.filter(id => !liveSet.has(id)).sort();
    // paneOnly: live but not tracked → orphaned pane from a prior run.
    const paneOnlyBeadIds = liveBeadIds.filter(id => !trackedSet.has(id)).sort();
    // restarting: currently in inactive-restart backoff.
    const restartingBeadIds = [...this.inactiveRestartedAtMs.keys()]
      .filter(id => now - (this.inactiveRestartedAtMs.get(id) || 0) < noProgressTimeoutMs)
      .sort();
    // released: durably pruned from tracking this tick.
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

  private async recordSlotHealth(stage: string): Promise<void> {
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
      // Churn-diagnostic sets (s3wp.33)
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
      // Churn-diagnostic sets (s3wp.33)
      trackedOnlyBeadIds,
      paneOnlyBeadIds,
      restartingBeadIds,
      releasedBeadIds
    };
    const digest = `${expectedCount}/${workingCount}/${activeCount}|${missingTrackedBeadIds.join(',')}|${staleBeadIds.join(',')}|${heartbeatOnlyStaleBeadIds.join(',')}|${trackedOnlyBeadIds.join(',')}|${paneOnlyBeadIds.join(',')}`;
    if (digest !== this.lastLoggedSlotHealthDigest) {
      this.lastLoggedSlotHealthDigest = digest;
      // While scheduling is intentionally paused, underfill is expected and
      // not actionable — suppress the warn to avoid log spam.
      const isUnderfilled = activeCount < expectedCount || staleBeadIds.length > 0 || heartbeatOnlyStaleBeadIds.length > 0;
      if (isUnderfilled && this.isSchedulingPaused()) {
        // Silently absorb the digest change; no operator-facing log.
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
    // Suppress the operator-facing underfilled warning while scheduling is
    // intentionally paused — underfill is expected and not actionable until
    // pause expiry, so the log entry would only add noise.
    if (this.isSchedulingPaused()) return;
    Logger.warn(Component.SUPERVISOR, 'Teammate capacity underfilled', eventData);
  }

  private latestStateForBead(beadId: string, heartbeatDetails: ReturnType<SignalingServer['getHeartbeatSnapshot']>): string | undefined {
    return heartbeatDetails
      .filter(heartbeat => heartbeat.beadId === beadId && heartbeat.stateId)
      .sort((a, b) => b.timestampMs - a.timestampMs)[0]?.stateId;
  }

  /**
   * Gives heartbeat-only live gaps an explicit deterministic lifecycle.
   *
   * A beadId in heartbeatOnlyLiveGaps has a heartbeat but no live tmux pane.
   * Left unchecked these entries repeat indefinitely, making health events noisy.
   *
   * Algorithm:
   *   1. For beadIds currently in the gap set: increment the consecutive-check
   *      counter; record firstSeen if new.
   *   2. For beadIds no longer in the gap set: reset their counters (healed).
   *   3. When a beadId exceeds orphanChecks consecutive detections OR its
   *      firstSeen age exceeds orphanTtlMs:
   *      a. Emit HEARTBEAT_ONLY_GAP_ORPHANED with diagnostic fields.
   *      b. Suppress the beadId from future heartbeatOnlyLiveGaps reporting.
   *      c. Attempt to release the bead lease (best-effort, never throws).
   */
  private async recoverOrphanHeartbeatGaps(
    heartbeatOnlyLiveGaps: string[],
    heartbeatDetails: ReturnType<SignalingServer['getHeartbeatSnapshot']>,
    nowMs: number
  ): Promise<void> {
    const config = await this.services.configLoader.load();
    const orphanChecks = config.settings.heartbeatOnlyGapOrphanChecks ?? SupervisorDefaults.HEARTBEAT_ONLY_GAP_ORPHAN_CHECKS;
    const orphanTtlMs = config.settings.heartbeatOnlyGapOrphanTtlMs ?? SupervisorDefaults.HEARTBEAT_ONLY_GAP_ORPHAN_TTL_MS;

    const currentGapSet = new Set(heartbeatOnlyLiveGaps);

    // Reset counters for beadIds that healed (no longer in gap set).
    for (const beadId of [...this.heartbeatOnlyGapCounts.keys()]) {
      if (!currentGapSet.has(beadId)) {
        this.heartbeatOnlyGapCounts.delete(beadId);
        this.heartbeatOnlyGapFirstSeenMs.delete(beadId);
      }
    }

    for (const beadId of heartbeatOnlyLiveGaps) {
      // Track first-seen timestamp.
      if (!this.heartbeatOnlyGapFirstSeenMs.has(beadId)) {
        this.heartbeatOnlyGapFirstSeenMs.set(beadId, nowMs);
      }

      // Increment consecutive-check counter.
      const prevCount = this.heartbeatOnlyGapCounts.get(beadId) ?? 0;
      const newCount = prevCount + 1;
      this.heartbeatOnlyGapCounts.set(beadId, newCount);

      const firstSeenMs = this.heartbeatOnlyGapFirstSeenMs.get(beadId)!;
      const ageMs = nowMs - firstSeenMs;
      const ttlExpired = ageMs >= orphanTtlMs;
      const thresholdReached = newCount >= orphanChecks;

      if (!ttlExpired && !thresholdReached) continue;

      // Determine reason string for the event.
      const reason = ttlExpired
        ? `heartbeat-only gap exceeded ttl (${ageMs}ms >= ${orphanTtlMs}ms)`
        : `heartbeat-only gap exceeded consecutive check threshold (${newCount} >= ${orphanChecks})`;

      // Collect worker IDs and last heartbeat timestamp for this beadId.
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

      // Suppress this beadId from future heartbeatOnlyLiveGaps + reset counters.
      this.suppressedHeartbeatOnlyGaps.add(beadId);
      this.heartbeatOnlyGapCounts.delete(beadId);
      this.heartbeatOnlyGapFirstSeenMs.delete(beadId);

      // Best-effort lease release — clears the stale server-side claim.
      await this.beadsPort().release(beadId).catch(error => {
        Logger.warn(Component.SUPERVISOR, 'Unable to release orphaned heartbeat-only gap bead', { beadId, error: String(error) });
      });
    }
  }

  private async recoverInactiveBeads(
    inactiveBeadIds: string[],
    effectiveLiveBeadIds: string[],
    latestProgressEvents: Map<string, DomainEvent>,
    heartbeatDetails: ReturnType<SignalingServer['getHeartbeatSnapshot']>,
    noProgressTimeoutMs: number
  ): Promise<void> {
    const config = await this.services.configLoader.load();

    // --- Early-trip: final-blocked pane detection ---
    // Check effective live beads that are not already past the no-progress
    // timeout and not in backoff for a terminal-blocked pane output.  When a
    // pane's final output is a blocked/fatal banner, the bead is stalled NOW —
    // no further progress will occur — so we recover it on this tick rather
    // than waiting for the full noProgressTimeoutMs to elapse.
    //
    // Guards applied per bead (BLOCKER A + C):
    //   1. captureBeadPaneText must exist on the factory (defensive, some test
    //      factories omit it).  If absent, skip the early-trip entirely.
    //   2. Skip beads already covered by the standard timeout path below.
    //   3. Skip beads still in inactive-restart backoff.
    //   4. Require TEMPORAL CORROBORATION (FINAL_BLOCKED_CONFIRM_POLLS = 2
    //      consecutive polls) before recovering, to avoid killing a bead on a
    //      single transient snapshot that happens to end on a matching line.
    //      The per-bead counter is reset when the pane shows no blocked signal.
    //
    // Metric: detection latency ≈ 2 × POLL_INTERVAL_MS instead of the full
    // noProgressTimeoutMs (~15 min), so the latency win is preserved while
    // one-frame false kills are eliminated.
    const hasCaptureBeadPaneText = typeof this.factory.captureBeadPaneText === 'function';
    if (hasCaptureBeadPaneText) {
      const inactiveSet = new Set(inactiveBeadIds);
      for (const beadId of effectiveLiveBeadIds) {
        // Skip beads already covered by the standard timeout path below.
        if (inactiveSet.has(beadId)) continue;

        // Skip beads whose backoff is still active (recently restarted).
        const lastRestartAtMs = this.inactiveRestartedAtMs.get(beadId) || 0;
        const now = this.clock.now();
        if (now - lastRestartAtMs < noProgressTimeoutMs) {
          // Also reset the debounce counter — bead is in backoff, not being checked.
          this.finalBlockedPollCounts.delete(beadId);
          continue;
        }

        // Capture the live pane snapshot to inspect for a terminal-blocked banner.
        const paneSnapshot = await this.factory.captureBeadPaneText(beadId).catch(() => '');
        if (!paneSnapshot) {
          this.finalBlockedPollCounts.delete(beadId);
          continue;
        }

        const finalBlockedResult = detectFinalBlockedState(paneSnapshot);
        if (!finalBlockedResult.blocked) {
          // Agent is progressing — reset the debounce counter.
          this.finalBlockedPollCounts.delete(beadId);
          continue;
        }

        // Increment the consecutive-detection counter (BLOCKER C debounce).
        const previousCount = this.finalBlockedPollCounts.get(beadId) ?? 0;
        const newCount = previousCount + 1;
        this.finalBlockedPollCounts.set(beadId, newCount);

        if (newCount < FINAL_BLOCKED_CONFIRM_POLLS) {
          // Not yet confirmed — wait for the next poll.
          Logger.info(Component.SUPERVISOR, 'Final-blocked pane candidate; awaiting temporal confirmation', {
            beadId,
            pollCount: newCount,
            requiredPolls: FINAL_BLOCKED_CONFIRM_POLLS,
            category: finalBlockedResult.category
          });
          continue;
        }

        // Confirmed on FINAL_BLOCKED_CONFIRM_POLLS consecutive polls: recover.
        this.finalBlockedPollCounts.delete(beadId);
        this.inactiveRestartedAtMs.set(beadId, now);

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
          evidenceLine: finalBlockedResult.evidenceLine
        });

        await this.eventStore.record(DomainEventName.AGENT_TURN_FAILED, {
          beadId,
          stateId,
          summary,
          paneSnapshot,
          error: summary
        }).catch(() => {});
        await this.eventStore.record(DomainEventName.HARNESS_RESTART_REQUESTED, {
          beadId,
          stateId,
          targetState: stateId,
          transitionEvent: config.settings.harnessRestartEvent || EventName.HARNESS_RESTART,
          summary,
          evidence,
          handover: summary
        }).catch(() => {});

        await this.factory.terminateTeammatesForBead(beadId, summary).catch(error => {
          Logger.warn(Component.SUPERVISOR, 'Unable to terminate final-blocked teammate panes', { beadId, error: String(error) });
        });
        await this.beadsPort().release(beadId).catch((error: unknown) => {
          Logger.warn(Component.SUPERVISOR, 'Unable to release final-blocked Bead after teammate termination', { beadId, error: String(error) });
        });
        this.markBeadExited(beadId, { preserveInactiveRestartBackoff: true });
      }
    }

    // --- Standard path: no-progress timeout recovery ---
    if (inactiveBeadIds.length === 0) return;

    for (const beadId of inactiveBeadIds) {
      const lastRestartAtMs = this.inactiveRestartedAtMs.get(beadId) || 0;
      const now = this.clock.now();
      if (now - lastRestartAtMs < noProgressTimeoutMs) continue;
      this.inactiveRestartedAtMs.set(beadId, now);

      const latestProgressEvent = latestProgressEvents.get(beadId);
      const stateId = this.latestStateForBead(beadId, heartbeatDetails) || String(latestProgressEvent?.data?.stateId || '');
      const summary = [
        AgentFailureSummary.NO_PROGRESS,
        `Last non-heartbeat event: ${latestProgressEvent?.type || 'none'} at ${latestProgressEvent?.timestamp || 'unknown'}.`,
        `Timeout: ${noProgressTimeoutMs}ms.`,
        AgentFailureSummary.EVENT_STORE_DETAILS
      ].join(' ');

      // Capture the live pane snapshot (reasoning already redacted) so
      // operators can see what the agent was doing at the time of inactivity
      // detection.  Errors are silently ignored — failure to capture pane
      // text must not block the restart path.
      const paneSnapshot = await this.factory.captureBeadPaneText(beadId).catch(() => '');
      const evidence = paneSnapshot
        ? `${summary}\n\nPane snapshot (reasoning redacted):\n${paneSnapshot}`
        : summary;

      await this.eventStore.record(DomainEventName.AGENT_TURN_FAILED, {
        beadId,
        stateId,
        summary,
        paneSnapshot: paneSnapshot || undefined,
        error: summary
      }).catch(() => {});
      await this.eventStore.record(DomainEventName.HARNESS_RESTART_REQUESTED, {
        beadId,
        stateId,
        targetState: stateId,
        transitionEvent: config.settings.harnessRestartEvent || EventName.HARNESS_RESTART,
        summary,
        evidence,
        handover: summary
      }).catch(() => {});

      await this.factory.terminateTeammatesForBead(beadId, summary).catch(error => {
        Logger.warn(Component.SUPERVISOR, 'Unable to terminate inactive teammate panes', { beadId, error: String(error) });
      });
      await this.beadsPort().release(beadId).catch((error: unknown) => {
        Logger.warn(Component.SUPERVISOR, 'Unable to release inactive Bead after teammate termination', { beadId, error: String(error) });
      });
      this.markBeadExited(beadId, { preserveInactiveRestartBackoff: true });
    }
  }

  /**
   * Runs retention cleanup at most once per RetentionDefaults.CLEANUP_INTERVAL_MS.
   * Removes files/dirs older than RetentionDefaults.MAX_AGE_MS from harness-owned
   * log, .tmp, and .trash areas. Errors are logged but never propagate —
   * cleanup failure must not disrupt the supervisor poll loop.
   *
   * Supplies the live bead ID set from the teammate spawner so that the
   * .pi/tool-output per-bead directories of running beads are never deleted.
   */
  private async runRetentionCleanupIfDue(): Promise<void> {
    const now = this.clock.now();
    if (now - this.lastRetentionCleanupMs < RetentionDefaults.CLEANUP_INTERVAL_MS) return;
    this.lastRetentionCleanupMs = now;

    // Source the retention/compaction policy from config so compaction can
    // actually run when enabled (the `retention` block in harness.yaml).
    // Without this, compactionEnabled is pinned to the
    // RetentionDefaults.COMPACTION_ENABLED (false) default and compaction
    // never runs regardless of config.
    const config = await this.services.configLoader.load();

    const cleanup = new RetentionCleanup(
      this.services.projectRoot,
      this.clock,
      // RetentionCleanup needs the full concrete store (not the narrow
      // ProjectionCapableStore the rest of the Supervisor consumes).
      this.services.eventStore,
      RetentionDefaults.MAX_AGE_MS,
      () => this.factory.getLiveTeammateBeadIds(),
      config.retention
    );

    await cleanup.run().catch(error => {
      Logger.warn(Component.SUPERVISOR, 'Retention cleanup failed unexpectedly', { error: String(error) });
    });
  }
}
