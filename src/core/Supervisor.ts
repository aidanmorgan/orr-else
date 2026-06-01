import { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Bead, BeadId } from '../types/index.js';
import { Logger } from './Logger.js';
import { Observability } from './Observability.js';
import { SignalingServer } from './SignalingServer.js';
import { TeammateFactory } from '../plugins/teammates.js';
import { AgentFailureSummary, App, Component, Defaults, DomainEventName, EventName, PluginToolName, RestartKind, SupervisorDefaults, TeammateEventDecisionAction, TeammateEventType, TERMINAL_BEAD_STATUSES } from '../constants/index.js';
import { Orchestrator } from './Orchestrator.js';
import type { ScoredBead } from './Scheduler.js';
import type { DomainEvent } from './EventStore.js';
import type { RuntimeServices, RuntimeTool } from './RuntimeServices.js';
import { requireTool } from './ToolRegistry.js';
import { systemClock } from './Clock.js';
import type { Clock } from './Clock.js';
import type { HarnessConfig } from './ConfigLoader.js';

export interface SupervisorOptions {
  maxSlots: number;
  requestedBeadId?: string;
  clock?: Clock;
}

interface MissingStartedRestartDetails {
  restartKind?: string;
  restartEvent?: string;
  restartFromState?: string;
  restartTargetState?: string;
  sourceEventType?: string;
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
  private schedulingPausedUntilMs = 0;
  private schedulingPausedReason = '';
  // Throttle "scheduling paused" warns: only emit when pauseUntil changes,
  // otherwise the supervisor poll spams the log every POLL_INTERVAL_MS.
  private lastLoggedPausedUntilMs = 0;
  // Throttle "underfilled or stale" slot warns: only emit when the digest
  // (expected/working counts + stale bead set) changes.
  private lastLoggedSlotHealthDigest = '';
  private lastCapacityUnderfillDigest = '';
  private lastMissingStartedBeadIds = new Set<string>();
  private readonly clock: Clock;
  // Cached tool handles — resolved once on first use (see resolveToolHandles).
  private bdClaimTool?: RuntimeTool;
  private bdReleaseTool?: RuntimeTool;
  private createWorktreeTool?: RuntimeTool;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    private readonly server: SignalingServer,
    private readonly factory: TeammateFactory,
    private readonly observability: Observability,
    private readonly services: RuntimeServices,
    private readonly options: SupervisorOptions
  ) {
    this.clock = options.clock || systemClock;
  }

  public async start() {
    await this.restoreCapacityPauseFromEventStore();

    this.interval = setInterval(() => {
      this.step().catch(error => Logger.error(Component.SUPERVISOR, 'Supervisor poll failed', { error: String(error) }));
    }, Defaults.POLL_INTERVAL_MS);

    await this.step();
  }

  public stop() {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    this.server.stop();
    void this.services.eventStore.record(DomainEventName.HARNESS_STOPPED, {
      requestedBeadId: this.options.requestedBeadId
    }).catch(() => {});
  }

  public async getActiveTeammateCount(): Promise<number> {
    return await this.factory.getActiveTeammateCount();
  }

  public isBeadStarted(id: string): boolean {
    return this.startedBeads.has(id);
  }

  public markBeadExited(id: string, options: { preserveInactiveRestartBackoff?: boolean } = {}) {
    this.startedBeads.delete(id);
    this.startedBeadAtMs.delete(id);
    this.missingStartedBeadChecks.delete(id);
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
    void this.services.eventStore.record(DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED, {
      pauseUntil: this.clock.date(pauseUntilMs).toISOString(),
      reason
    }).catch(() => {});
    Logger.warn(Component.SUPERVISOR, 'Scheduling paused after harness capacity limit', {
      pauseUntil: this.clock.date(pauseUntilMs).toISOString(),
      reason
    });
  }

  private async restoreCapacityPauseFromEventStore(): Promise<void> {
    const latestCapacityEvent = await this.services.eventStore.latestEventByType(DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED).catch((error: unknown) => {
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
    if (this.schedulingPausedUntilMs === this.lastLoggedPausedUntilMs) return;
    this.lastLoggedPausedUntilMs = this.schedulingPausedUntilMs;
    Logger.warn(Component.SUPERVISOR, 'Skipping spawn while scheduling is paused', {
      pauseUntil,
      reason: this.schedulingPausedReason
    });
  }

  /** Lazily resolve and cache the bd_claim tool handle. Throws if not registered. */
  private requireBdClaimTool(): RuntimeTool {
    this.bdClaimTool ??= requireTool(this.services.plugins.bd, PluginToolName.BD_CLAIM);
    return this.bdClaimTool;
  }

  /** Lazily resolve and cache the bd_release tool handle. Throws if not registered. */
  private requireBdReleaseTool(): RuntimeTool {
    this.bdReleaseTool ??= requireTool(this.services.plugins.bd, PluginToolName.BD_RELEASE);
    return this.bdReleaseTool;
  }

  /** Lazily resolve and cache the create_worktree tool handle. Throws if not registered. */
  private requireCreateWorktreeTool(): RuntimeTool {
    this.createWorktreeTool ??= requireTool(this.services.plugins.git, PluginToolName.CREATE_WORKTREE);
    return this.createWorktreeTool;
  }

  private async releaseClaimedAfterPause(claimed: Bead): Promise<void> {
    await Promise.resolve(this.requireBdReleaseTool().execute({ id: claimed.id })).catch((error: unknown) => {
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

  /** Claim one bead, provision its worktree, record the event, and spawn a teammate.
   * Owns the full claim → worktree → record → spawn sequence for a single bead,
   * including releasing the lease on every failure path.
   * Returns true on success; throws on hard failure (caller catches and records). */
  private async claimAndSpawnBead(bead: ScoredBead & { stateId: string }, config: HarnessConfig): Promise<boolean> {
    if (this.ctx.hasUI) this.ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), `Claiming ${bead.id}...`);

    const bdClaimTool = this.requireBdClaimTool();
    const bdReleaseTool = this.requireBdReleaseTool();
    const createWorktreeTool = this.requireCreateWorktreeTool();

    const claimed = await bdClaimTool.execute({
      id: bead.id,
      owner: App.DISPLAY_NAME,
      stateId: bead.stateId,
      leaseTtlMs: config.settings?.agentTurnTimeoutMs || Defaults.LEASE_TTL_MS
    }, this.ctx) as Bead;

    // Post-claim pause check: pause was detected while the claim was in-flight.
    // Release the lease we just acquired and signal the caller to break.
    if (this.isSchedulingPaused()) {
      await this.releaseClaimedAfterPause(claimed);
      return false;
    }

    if (this.stopping) {
      await Promise.resolve(bdReleaseTool.execute({ id: claimed.id })).catch(() => {});
      this.startedBeads.delete(claimed.id);
      return false;
    }

    // Mandatory Worktree Isolation
    const result = await createWorktreeTool.execute({ beadId: claimed.id }, this.ctx);
    const worktreePath = (result as any)?.path;
    if ((result as any)?.success !== true || !worktreePath) {
      await Promise.resolve(bdReleaseTool.execute({ id: claimed.id })).catch(() => {});
      throw new Error((result as any)?.error || `Failed to provision mandatory worktree for ${claimed.id}`);
    }
    await this.services.eventStore.record(DomainEventName.WORKTREE_PROVISIONED, { beadId: claimed.id, worktreePath });

    // Post-worktree pause check: pause was detected after worktree provisioning.
    // Release the lease (worktree already provisioned) and signal the caller to break.
    if (this.isSchedulingPaused()) {
      await this.releaseClaimedAfterPause(claimed);
      return false;
    }

    if (this.ctx.hasUI) this.ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), `Spawning ${bead.id} (${bead.stateId})...`);

    const spawned = await this.factory.spawnTeammateInTmux(claimed.id, bead.stateId, worktreePath, this.ctx);
    if (!spawned.success) {
      await Promise.resolve(bdReleaseTool.execute({ id: claimed.id })).catch(() => {});
      throw new Error(spawned.error || `Failed to spawn teammate for ${claimed.id}`);
    }
    Logger.info(Component.SUPERVISOR, `Teammate spawned for ${bead.id} in phase ${bead.stateId}`);
    return true;
  }

  private async step() {
    if (this.stopping || this.stepInProgress) return;
    this.stepInProgress = true;
    try {
      await this.observability.tracedAsync('supervisor_step', {}, async () => {
        await this.reconcileStartedBeads();
        await this.reconcileTerminalLiveBeads();
        await this.scanAndSpawn();
        await this.recordSlotHealth('after_scan');
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
      await this.services.eventStore.record(DomainEventName.TEAMMATE_PROCESS_EXITED, eventData).catch(() => {});
      const releaseTool = this.services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_RELEASE);
      if (!releaseTool) {
        Logger.warn(Component.SUPERVISOR, 'Unable to release Bead lease for exited teammate; bd_release tool is unavailable', { beadId });
        continue;
      }
      await Promise.resolve(releaseTool.execute({ id: beadId })).catch((error: unknown) => {
        Logger.warn(Component.SUPERVISOR, 'Unable to release Bead lease for exited teammate', {
          beadId,
          error: String(error)
        });
      });
    }
  }

  private async restartDetailsForMissingStartedBead(beadId: string): Promise<MissingStartedRestartDetails | undefined> {
    try {
      const projection = await this.services.eventStore.projectBead(beadId, { includeDetails: false });
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
      const events = await this.services.eventStore.eventsForBead(beadId);
      for (const event of [...events].reverse()) {
        const data = event.data || {};
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

    const getBeadTool = this.services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_GET_BEAD);
    const releaseTool = this.services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_RELEASE);
    if (!getBeadTool) {
      Logger.warn(Component.SUPERVISOR, 'Unable to reconcile terminal live teammates; bd_get_bead tool is unavailable');
      return;
    }

    for (const beadId of liveBeadIds) {
      let bead: Bead;
      try {
        bead = await getBeadTool.execute({ id: beadId }) as Bead;
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
      if (releaseTool) {
        await Promise.resolve(releaseTool.execute({ id: beadId })).catch((error: unknown) => {
          Logger.warn(Component.SUPERVISOR, 'Unable to release terminal Bead after teammate termination', { beadId, error: String(error) });
        });
      }
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
      this.services.plugins.bd,
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
      this.startedBeads.add(bead.id);
      this.startedBeadAtMs.set(bead.id, this.clock.now());
      try {
        const spawned = await this.claimAndSpawnBead(bead, config);
        if (!spawned) break;
      } catch (error) {
        this.startedBeads.delete(bead.id);
        this.startedBeadAtMs.delete(bead.id);
        await this.services.eventStore.record(DomainEventName.ASSIGNMENT_FAILED, {
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
      groupedEvents = await this.services.eventStore.eventsForBeads(candidates);
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
    const latestProgressEvents = await this.services.eventStore.latestEventsForBeads(liveBeadIds, {
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
    const heartbeatOnlyLiveGaps = [...heartbeatByBead.keys()]
      .filter(beadId => !liveBeadIds.includes(beadId))
      .sort();

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
      heartbeatOnlyLiveGaps
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
      heartbeatOnlyLiveGaps
    } = snapshot;

    await this.services.eventStore.record(DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED, {
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
      heartbeatOnlyLiveGaps
    }).catch(() => {});

    const details = { expectedCount, activeCount, workingCount, liveBeadIds: effectiveLiveBeadIds, missingTrackedBeadIds, staleBeadIds, heartbeatOnlyStaleBeadIds };
    const digest = `${expectedCount}/${workingCount}/${activeCount}|${missingTrackedBeadIds.join(',')}|${staleBeadIds.join(',')}|${heartbeatOnlyStaleBeadIds.join(',')}`;
    if (digest !== this.lastLoggedSlotHealthDigest) {
      this.lastLoggedSlotHealthDigest = digest;
      if (activeCount < expectedCount || staleBeadIds.length > 0 || heartbeatOnlyStaleBeadIds.length > 0) {
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

    await this.recoverInactiveBeads(inactiveBeadIds, latestProgressEvents, heartbeatDetails, noProgressTimeoutMs);
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

    await this.services.eventStore.record(DomainEventName.TEAMMATE_CAPACITY_UNDERFILLED, eventData).catch(() => {});
    Logger.warn(Component.SUPERVISOR, 'Teammate capacity underfilled', eventData);
  }

  private latestStateForBead(beadId: string, heartbeatDetails: ReturnType<SignalingServer['getHeartbeatSnapshot']>): string | undefined {
    return heartbeatDetails
      .filter(heartbeat => heartbeat.beadId === beadId && heartbeat.stateId)
      .sort((a, b) => b.timestampMs - a.timestampMs)[0]?.stateId;
  }

  private async recoverInactiveBeads(
    inactiveBeadIds: string[],
    latestProgressEvents: Map<string, DomainEvent>,
    heartbeatDetails: ReturnType<SignalingServer['getHeartbeatSnapshot']>,
    noProgressTimeoutMs: number
  ): Promise<void> {
    if (inactiveBeadIds.length === 0) return;
    const config = await this.services.configLoader.load();
    const releaseTool = this.requireBdReleaseTool();

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

      await this.services.eventStore.record(DomainEventName.AGENT_TURN_FAILED, {
        beadId,
        stateId,
        summary,
        error: summary
      }).catch(() => {});
      await this.services.eventStore.record(DomainEventName.HARNESS_RESTART_REQUESTED, {
        beadId,
        stateId,
        targetState: stateId,
        transitionEvent: config.settings.harnessRestartEvent || EventName.HARNESS_RESTART,
        summary,
        evidence: summary,
        handover: summary
      }).catch(() => {});

      await this.factory.terminateTeammatesForBead(beadId, summary).catch(error => {
        Logger.warn(Component.SUPERVISOR, 'Unable to terminate inactive teammate panes', { beadId, error: String(error) });
      });
      await Promise.resolve(releaseTool.execute({ id: beadId })).catch((error: unknown) => {
        Logger.warn(Component.SUPERVISOR, 'Unable to release inactive Bead after teammate termination', { beadId, error: String(error) });
      });
      this.markBeadExited(beadId, { preserveInactiveRestartBackoff: true });
    }
  }
}
