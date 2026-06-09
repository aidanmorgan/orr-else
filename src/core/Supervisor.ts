import { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Bead, BeadId, asBeadId, asStateId, type StateId } from '../types/index.js';
import { Logger } from './Logger.js';
import { Observability } from './Observability.js';
import { SignalingServer } from './SignalingServer.js';
import { DomainEventName, EventName, QuarantineReason, RestartKind, TERMINAL_BEAD_STATUSES, TeammateEventDecisionAction, TeammateEventType } from '../constants/domain.js';
import { Component, Defaults, SupervisorDefaults } from '../constants/infra.js';
import { Orchestrator } from './Orchestrator.js';
import type { ScoredBead } from './Scheduler.js';
import type { DomainEvent, ProjectionCapableStore } from './EventStore.js';
import type { BeadsPort, WorktreePort, TeammateSpawner } from './OrchestrationPorts.js';
import { systemClock } from './Clock.js';
import type { Clock } from './Clock.js';
import type { HarnessConfig } from './ConfigLoader.js';
import { projectToolFailureLimitSuggestedOutcome } from './ProjectToolFailureLimit.js';
import {
  FailureClass,
  LifecyclePhase,
  RetryBudget,
  NextAction,
} from './FailureTaxonomy.js';
import type { EventStore } from './EventStore.js';
import { BeadSpawnCoordinator } from './BeadSpawnCoordinator.js';
import { SupervisorRecoveryService } from './SupervisorRecoveryService.js';
import { SlotHealthMonitor } from './SlotHealthMonitor.js';
import { RetentionScheduler } from './RetentionScheduler.js';
import type { McpBridgeHealth } from './McpTransportPreflight.js';

// ---------------------------------------------------------------------------
// Narrow services interface (replaces broad RuntimeServices in the constructor)
// ---------------------------------------------------------------------------

/**
 * Narrow services bag accepted by the Supervisor constructor.
 * Only the dependencies the Supervisor actually uses — not the full RuntimeServices.
 *
 * pi-experiment-amq0.2: extracted from RuntimeServices to keep Supervisor's
 * dependency surface minimal and testable.
 *
 * configLoader.load() accepts both sync (HarnessConfig) and async (Promise<HarnessConfig>)
 * return types so that the production ConfigLoader (sync) and test fakes (async) both satisfy
 * this interface without wrapping.
 */
export interface SupervisorServices {
  eventStore: ProjectionCapableStore;
  configLoader: {
    // Accepts sync (HarnessConfig) and async (Promise<HarnessConfig>) return values
    // so that the production ConfigLoader and test fakes both satisfy this interface.
    load(): HarnessConfig | Promise<HarnessConfig>;
    getConfigPath(): string;
  };
  beadsPort: BeadsPort;
  worktreePort: WorktreePort;
  flowManager: {
    nextState(state: unknown, outcome: string, fallbackStateId?: string): string;
  };
  /** Absolute path to the project root. Used by RetentionScheduler. */
  projectRoot: string;
}

export interface SupervisorOptions {
  maxSlots: number;
  requestedBeadId?: string;
  clock?: Clock;
  /**
   * Pre-built Orchestrator for assignment selection.
   * Required — constructed at the composition root (extension.ts) and injected here.
   * pi-experiment-amq0.2: no construct-fallback; Orchestrator is always injected.
   */
  orchestrator: Orchestrator;
  /**
   * Pre-built RetentionScheduler for retention timing.
   * Required — constructed at the composition root (extension.ts) and injected here.
   * pi-experiment-amq0.2: no construct-fallback; RetentionScheduler is always injected.
   */
  retentionScheduler: RetentionScheduler;
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

export class Supervisor {
  private interval?: NodeJS.Timeout;
  private startedBeads = new Set<string>();
  private startedBeadAtMs = new Map<string, number>();
  private missingStartedBeadChecks = new Map<string, number>();
  private processedSignals = new Set<string>();
  private stepInProgress = false;
  private stopping = false;
  private schedulingPausedUntilMs = 0;
  private schedulingPausedReason = '';
  // Track the pauseUntil value at which the SCHEDULING_PAUSED domain event was
  // last emitted so we fire it exactly once per distinct pause window (not on
  // every poll).
  private lastSchedulingPausedEventMs = 0;
  // Throttle the low-frequency pause heartbeat: at most once per
  // PAUSE_HEARTBEAT_INTERVAL_MS while pause is active.
  private lastPauseHeartbeatMs = 0;
  private lastMissingStartedBeadIds = new Set<string>();
  private readonly clock: Clock;

  // ---------------------------------------------------------------------------
  // Extracted sub-services (pi-experiment-amq0.2)
  // ---------------------------------------------------------------------------
  private readonly spawnCoordinator: BeadSpawnCoordinator;
  private readonly recoveryService: SupervisorRecoveryService;
  private readonly slotHealthMonitor: SlotHealthMonitor;
  private readonly retentionScheduler: RetentionScheduler;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    private readonly server: SignalingServer,
    private readonly factory: TeammateSpawner,
    private readonly observability: Observability,
    private readonly services: SupervisorServices,
    private readonly options: SupervisorOptions
  ) {
    this.clock = options.clock || systemClock;

    this.recoveryService = new SupervisorRecoveryService(services.eventStore);

    this.spawnCoordinator = new BeadSpawnCoordinator(
      services.beadsPort,
      services.worktreePort,
      services.eventStore,
      factory,
      observability,
      services.configLoader,
      services.flowManager,
      services.projectRoot,
      () => this.clock.now(),
      (ms?: number) => this.clock.date(ms)
    );

    this.slotHealthMonitor = new SlotHealthMonitor(
      services.eventStore,
      services.configLoader,
      factory,
      server,
      services.beadsPort,
      options.maxSlots,
      this.clock,
      this.startedBeads,
      this.startedBeadAtMs,
      () => this.lastMissingStartedBeadIds,
      (liveBeadIds) => this.pruneDurablyInactiveStartedBeads(liveBeadIds),
      (id, opts) => this.markBeadExited(id, opts),
      (bead, reason, details) => this.spawnCoordinator.quarantineBead(bead, reason, details),
      (cls, phase, budget) => this.spawnCoordinator.taxonomyFields(cls, phase, budget),
      (cls, phase, budget) => this.spawnCoordinator.routeTaxonomy(cls, phase, budget),
      () => this.harnessRestartEvent(),
      () => this.isSchedulingPaused()
    );

    this.retentionScheduler = options.retentionScheduler;
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
    // all startup helpers so coordinator boot makes exactly one O(events) scan.
    let startupEvents: DomainEvent[] = [];
    try {
      startupEvents = await this.eventStore.readAll();
    } catch (error) {
      Logger.warn(Component.SUPERVISOR, 'Unable to read event store on startup; signal-state restore skipped', { error: String(error) });
    }
    const rebuiltSignals = await this.recoveryService.rebuildProcessedSignalsFromEvents(startupEvents);
    for (const key of rebuiltSignals) {
      this.processedSignals.add(key);
    }
    await this.recoveryService.reconcileUnacknowledgedSignalIntents(startupEvents);
    await this.spawnCoordinator.rehydrateQuarantinesFromEvents(startupEvents);

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
    return this.spawnCoordinator.getMcpBridgeHealth();
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
        const projection = await this.eventStore.projectBead(asBeadId(beadId), { includeDetails: false });
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
    // finalBlockedPollCounts, inactiveRestartedAtMs, inactiveRestartCountByBead
    // are owned by SlotHealthMonitor (pi-experiment-amq0.2).
    this.slotHealthMonitor.finalBlockedPollCounts.delete(id);
    if (!options.preserveInactiveRestartBackoff) {
      this.slotHealthMonitor.inactiveRestartedAtMs.delete(id);
      this.slotHealthMonitor.inactiveRestartCountByBead.delete(id);
    }
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
    const pauseUntilIso = this.clock.date(pauseUntilMs).toISOString();
    // Fire SCHEDULING_PAUSED exactly once per distinct pauseUntil value so
    // operators see a single clean enter-event rather than per-poll noise.
    // SCHEDULING_PAUSED is the sole canonical capacity-pause event (j0tp).
    // It carries reason + pauseUntil + l3k4 taxonomy fields (PROVIDER_LIMIT × RUNNING → SCHEDULING_PAUSE).
    if (pauseUntilMs !== this.lastSchedulingPausedEventMs) {
      this.lastSchedulingPausedEventMs = pauseUntilMs;
      this.lastPauseHeartbeatMs = this.clock.now();
      void this.eventStore.record(DomainEventName.SCHEDULING_PAUSED, {
        pauseUntil: pauseUntilIso,
        reason,
        // n8fg taxonomy: PROVIDER_LIMIT × RUNNING → SCHEDULING_PAUSE (budget irrelevant for this class)
        ...this.spawnCoordinator.taxonomyFields(FailureClass.PROVIDER_LIMIT, LifecyclePhase.RUNNING, RetryBudget.AVAILABLE)
      }).catch(() => {});
      Logger.warn(Component.SUPERVISOR, 'Scheduling paused; entering quiet capacity-pause mode', {
        pauseUntil: pauseUntilIso,
        reason
      });
    }
  }

  private async restoreCapacityPauseFromStore(): Promise<void> {
    const restored = await this.recoveryService.restoreCapacityPauseFromStore(() => this.clock.now());
    if (!restored) return;
    this.schedulingPausedUntilMs = restored.pauseUntilMs;
    this.schedulingPausedReason = restored.reason;
    Logger.warn(Component.SUPERVISOR, 'Restored scheduling pause from event store', {
      pauseUntil: this.pausedUntilIso(),
      reason: this.schedulingPausedReason
    });
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
      stateId: asStateId(stateId),
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

  /**
   * Claim one bead, provision its worktree, and spawn a teammate.
   * Delegates to BeadSpawnCoordinator — the single source of truth for
   * the claim → [worktree] → record → spawn transaction (pi-experiment-amq0.2).
   */
  private async claimAndSpawnBead(
    bead: ScoredBead & { stateId: string },
    config: HarnessConfig
  ): Promise<'spawned' | 'paused' | 'quarantined'> {
    return this.spawnCoordinator.claimAndSpawnBead(
      bead,
      config,
      this.ctx,
      () => this.isSchedulingPaused(),
      () => this.schedulingPausedUntilMs,
      () => this.schedulingPausedReason,
      () => this.stopping,
      this.startedBeads,
      this.startedBeadAtMs,
      (id, opts) => this.markBeadExited(id, opts)
    );
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
    const brandedBeadId = asBeadId(beadId);
    try {
      const projection = await this.eventStore.projectBead(brandedBeadId, { includeDetails: false });
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
      const events = await this.eventStore.eventsForBead(brandedBeadId);
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

    // pi-experiment-amq0.2: use the required injected orchestrator (no fallback).
    const assignments = await this.options.orchestrator.selectAssignments(slots, this.options.requestedBeadId, excludedBeadIds);

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
      if (TERMINAL_BEAD_STATUSES.has(bead.status)) {
        Logger.info(Component.SUPERVISOR, 'Preflight: skipping terminal bead', {
          beadId: bead.id,
          status: bead.status
        });
        continue;
      }
      if (await this.spawnCoordinator.isQuarantined(bead)) {
        Logger.info(Component.SUPERVISOR, 'Preflight: skipping quarantined bead (unchanged signature)', {
          beadId: bead.id,
          reason: this.spawnCoordinator.quarantine.get(bead.id)?.reason
        });
        continue;
      }

      const terminalRestartDetails = await this.nonRoutableTerminalFailureLimitRestartDetails(bead, config);
      if (terminalRestartDetails) {
        await this.spawnCoordinator.quarantineBead(
          bead,
          QuarantineReason.NON_ROUTABLE_TERMINAL_FAILURE_LIMIT,
          {
            ...terminalRestartDetails,
            ...this.spawnCoordinator.taxonomyFields(FailureClass.LIFECYCLE_VIOLATION, LifecyclePhase.SPAWN, RetryBudget.AVAILABLE)
          }
        );
        continue;
      }

      // PREFLIGHT: MCP transport health check (s3wp.32).
      const requiredMcpTools = this.spawnCoordinator.requiredMcpToolNamesForBead(bead.stateId, config);
      if (requiredMcpTools.length > 0) {
        const mcpHealth = await this.spawnCoordinator.runMcpPreflightForTools(requiredMcpTools);
        if (!mcpHealth.healthy) {
          const taxonomyRoute = this.spawnCoordinator.routeTaxonomy(FailureClass.BACKEND_READINESS, LifecyclePhase.SPAWN, RetryBudget.AVAILABLE);
          const fields = this.spawnCoordinator.taxonomyFields(FailureClass.BACKEND_READINESS, LifecyclePhase.SPAWN, RetryBudget.AVAILABLE);
          if (taxonomyRoute.nextAction === NextAction.QUARANTINE) {
            await this.spawnCoordinator.quarantineBead(bead, QuarantineReason.UNKNOWN, {
              ...fields,
              unavailableTools: mcpHealth.affectedToolNames,
              errorMessage: mcpHealth.message,
              taxonomyReason: 'MCP backend unavailable at spawn — BACKEND_READINESS × SPAWN → QUARANTINE'
            });
          } else {
            Logger.warn(Component.SUPERVISOR, 'Preflight: skipping bead — required MCP tools unavailable', {
              beadId: bead.id,
              stateId: bead.stateId,
              unavailableTools: mcpHealth.affectedToolNames,
              errorMessage: mcpHealth.message,
              ...fields
            });
          }
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
      groupedEvents = await this.eventStore.eventsForBeads(candidates.map(asBeadId));
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
      // Notify SlotHealthMonitor so released beads appear in the slot-health snapshot.
      for (const beadId of prunedBeadIds) {
        this.slotHealthMonitor.addReleasedThisTick(beadId);
      }
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
    for (const [beadId, restartedAtMs] of this.slotHealthMonitor.inactiveRestartedAtMs.entries()) {
      if (now - restartedAtMs >= noProgressTimeoutMs) {
        this.slotHealthMonitor.inactiveRestartedAtMs.delete(beadId);
      } else {
        blocked.push(beadId);
      }
    }
    return blocked.sort();
  }

  /**
   * Delegate slot-health recording to SlotHealthMonitor.
   * pi-experiment-amq0.2: SlotHealthMonitor is the single source of truth.
   */
  private async recordSlotHealth(stage: string): Promise<void> {
    return this.slotHealthMonitor.recordSlotHealth(stage);
  }

  /**
   * Delegate slot-health snapshot to SlotHealthMonitor.
   * Exposed for tests that call (supervisor as any).collectSlotHealthSnapshot().
   */
  private async collectSlotHealthSnapshot(): Promise<ReturnType<SlotHealthMonitor['collectSlotHealthSnapshot']>> {
    return this.slotHealthMonitor.collectSlotHealthSnapshot();
  }

  /**
   * Runs retention cleanup via the injected RetentionScheduler.
   * pi-experiment-amq0.2: RetentionScheduler is the single source of truth.
   */
  private async runRetentionCleanupIfDue(): Promise<void> {
    return this.retentionScheduler.runIfDue();
  }

  /**
   * Returns the config setting for harnessRestartEvent — used by SlotHealthMonitor
   * when requesting a harness restart for inactive beads.
   */
  private async harnessRestartEvent(): Promise<string> {
    try {
      const config = await this.services.configLoader.load();
      return config.settings?.harnessRestartEvent || '';
    } catch {
      return '';
    }
  }
}
