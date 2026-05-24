import { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Bead, BeadId } from '../types/index.js';
import { Logger } from './Logger.js';
import { Observability } from './Observability.js';
import { SignalingServer } from './SignalingServer.js';
import { TeammateFactory } from '../plugins/teammates.js';
import { AgentFailureSummary, Component, Defaults, DomainEventName, EventName, PluginToolName, SupervisorDefaults, TeammateEventType } from '../constants/index.js';
import { Orchestrator } from './Orchestrator.js';
import type { DomainEvent } from './EventStore.js';
import type { RuntimeServices } from './RuntimeServices.js';

export interface SupervisorOptions {
  maxSlots: number;
  requestedBeadId?: string;
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

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    private readonly server: SignalingServer,
    private readonly factory: TeammateFactory,
    private readonly observability: Observability,
    private readonly services: RuntimeServices,
    private readonly options: SupervisorOptions
  ) {}

  public async start() {
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

  public markBeadExited(id: string) {
    this.startedBeads.delete(id);
    this.startedBeadAtMs.delete(id);
    this.missingStartedBeadChecks.delete(id);
    this.inactiveRestartedAtMs.delete(id);
  }

  public isSignalProcessed(key: string): boolean {
    return this.processedSignals.has(key);
  }

  public markSignalProcessed(key: string) {
    this.processedSignals.add(key);
  }

  public pauseSchedulingUntil(pauseUntilMs: number, reason: string): void {
    if (!Number.isFinite(pauseUntilMs) || pauseUntilMs <= Date.now()) return;
    if (pauseUntilMs <= this.schedulingPausedUntilMs) return;
    this.schedulingPausedUntilMs = pauseUntilMs;
    this.schedulingPausedReason = reason;
    void this.services.eventStore.record(DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED, {
      pauseUntil: new Date(pauseUntilMs).toISOString(),
      reason
    }).catch(() => {});
    Logger.warn(Component.SUPERVISOR, 'Scheduling paused after harness capacity limit', {
      pauseUntil: new Date(pauseUntilMs).toISOString(),
      reason
    });
  }

  private async step() {
    if (this.stopping || this.stepInProgress) return;
    this.stepInProgress = true;
    try {
      await this.observability.tracedAsync('supervisor_step', {}, async () => {
        await this.reconcileStartedBeads();
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
      if (missingChecks < Defaults.TEAMMATE_MISSING_REAP_THRESHOLD) continue;

      this.startedBeads.delete(beadId);
      this.startedBeadAtMs.delete(beadId);
      this.missingStartedBeadChecks.delete(beadId);
      Logger.warn(Component.SUPERVISOR, 'Teammate process is no longer active; releasing scheduler slot', { beadId });
      await this.services.eventStore.record(DomainEventName.TEAMMATE_PROCESS_EXITED, { beadId }).catch(() => {});
    }
  }

  private async scanAndSpawn() {
    if (this.schedulingPausedUntilMs > Date.now()) {
      const pauseUntil = new Date(this.schedulingPausedUntilMs).toISOString();
      if (this.ctx.hasUI) {
        this.ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), `Paused until ${pauseUntil}`);
      }
      Logger.warn(Component.SUPERVISOR, 'Skipping spawn while scheduling is paused', {
        pauseUntil,
        reason: this.schedulingPausedReason
      });
      return;
    }

    const trackedSlots = Math.max(0, this.options.maxSlots - this.startedBeads.size);
    const slots = Math.min(trackedSlots, await this.factory.getAvailableSlots());
    if (slots <= 0) {
      if (this.ctx.hasUI) this.ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), 'All slots full');
      return;
    }

    if (this.ctx.hasUI) this.ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), `Scanning backlog (${slots} slots free)`);

    const config = await this.services.configLoader.load();
    const orchestrator = new Orchestrator(
      this.observability,
      this.services.configLoader,
      this.services.flowManager,
      this.services.scheduler,
      this.services.plugins.bd,
      this.options.maxSlots
    );
    const assignments = await orchestrator.selectAssignments(slots, this.options.requestedBeadId, this.startedBeads);

    if (assignments.length === 0) {
      if (this.ctx.hasUI) this.ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), 'Idle (Backlog empty)');
    }

    for (const bead of assignments) {
      if (this.stopping) break;
      const currentSlots = Math.min(
        Math.max(0, this.options.maxSlots - this.startedBeads.size),
        await this.factory.getAvailableSlots()
      );
      if (currentSlots <= 0) break;
      this.startedBeads.add(bead.id);
      this.startedBeadAtMs.set(bead.id, Date.now());
      try {
        if (this.ctx.hasUI) this.ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), `Claiming ${bead.id}...`);
        
        const claimTool = this.services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_CLAIM)!;
        const claimed = await claimTool.execute({
          id: bead.id,
          owner: 'Orr Else',
          stateId: bead.stateId,
          leaseTtlMs: config.settings?.agentTurnTimeoutMs || Defaults.LEASE_TTL_MS
        }, this.ctx) as Bead;

        if (this.stopping) {
          await Promise.resolve(this.services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_RELEASE)!.execute({ id: claimed.id })).catch(() => {});
          this.startedBeads.delete(claimed.id);
          break;
        }

        // Mandatory Worktree Isolation
        const createWorktreeTool = this.services.plugins.git.tools.find(t => t.name === PluginToolName.CREATE_WORKTREE)!;
        const result = await createWorktreeTool.execute({ beadId: claimed.id }, this.ctx);
        const worktreePath = (result as any)?.path;
        if ((result as any)?.success !== true || !worktreePath) {
          await Promise.resolve(this.services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_RELEASE)!.execute({ id: claimed.id })).catch(() => {});
          throw new Error((result as any)?.error || `Failed to provision mandatory worktree for ${claimed.id}`);
        }
        await this.services.eventStore.record(DomainEventName.WORKTREE_PROVISIONED, { beadId: claimed.id, worktreePath });

        if (this.ctx.hasUI) this.ctx.ui.setStatus(Component.ORR_ELSE.toLowerCase(), `Spawning ${bead.id} (${bead.stateId})...`);
        
        const spawned = await this.factory.spawnTeammateInTmux(claimed.id, bead.stateId, worktreePath, this.ctx);
        if (!spawned.success) {
          await Promise.resolve(this.services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_RELEASE)!.execute({ id: claimed.id })).catch(() => {});
          throw new Error(spawned.error || `Failed to spawn teammate for ${claimed.id}`);
        }
        Logger.info(Component.SUPERVISOR, `Teammate spawned for ${bead.id} in phase ${bead.stateId}`);
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

  private async recordSlotHealth(stage: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastSlotHealthEventMs < SupervisorDefaults.SLOT_HEALTH_EVENT_INTERVAL_MS) return;
    this.lastSlotHealthEventMs = now;

    const liveBeadIds = [...await this.factory.getLiveTeammateBeadIds()].sort();
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
    const staleBeadIds = [...new Set([...staleHeartbeatBeadIds, ...inactiveBeadIds])].sort();
    const activeCount = liveBeadIds.length;
    const workingCount = activeCount - staleBeadIds.length;
    const expectedCount = this.options.maxSlots;

    await this.services.eventStore.record(DomainEventName.TEAMMATE_SLOT_HEALTH_CHECKED, {
      stage,
      expectedCount,
      activeCount,
      workingCount,
      liveBeadIds,
      staleBeadIds,
      staleHeartbeatBeadIds,
      inactiveBeadIds,
      trackedBeadIds: [...this.startedBeads].sort()
    }).catch(() => {});

    const details = { expectedCount, activeCount, workingCount, liveBeadIds, staleBeadIds };
    if (activeCount < expectedCount || staleBeadIds.length > 0) {
      Logger.warn(Component.SUPERVISOR, 'Teammate slot health check found underfilled or stale work', details);
    } else {
      Logger.info(Component.SUPERVISOR, 'Teammate slot health check passed', details);
    }

    await this.recoverInactiveBeads(inactiveBeadIds, latestProgressEvents, heartbeatDetails, noProgressTimeoutMs);
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
    const releaseTool = this.services.plugins.bd.tools.find(t => t.name === PluginToolName.BD_RELEASE)!;

    for (const beadId of inactiveBeadIds) {
      const lastRestartAtMs = this.inactiveRestartedAtMs.get(beadId) || 0;
      if (Date.now() - lastRestartAtMs < noProgressTimeoutMs) continue;
      this.inactiveRestartedAtMs.set(beadId, Date.now());

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
      this.markBeadExited(beadId);
    }
  }
}
