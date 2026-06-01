import { Bead } from '../types/index.js';
import { Scheduler, ScoredBead } from './Scheduler.js';
import { ConfigLoader } from './ConfigLoader.js';
import { Logger } from './Logger.js';
import { Observability } from './Observability.js';
import { App, BeadsDefaults, BeadsIssueStatus, Component, Defaults, PluginToolName, TERMINAL_BEAD_STATUSES } from '../constants/index.js';
import { FlowManager } from './FlowManager.js';
import type { BeadsPort } from './OrchestrationPorts.js';

/**
 * Plugin-native backlog helper.
 */
export class Orchestrator {
  constructor(
    private readonly observability: Observability,
    private readonly configLoader: ConfigLoader,
    private readonly flowManager: FlowManager,
    private readonly scheduler: Scheduler,
    private readonly beadsPort: BeadsPort,
    private readonly maxSlots: number = Defaults.MAX_SLOTS
  ) {}

  public async getMaxSlots(): Promise<number> {
    const config = await this.configLoader.load();
    return config.settings?.maxConcurrentSlots || Defaults.MAX_SLOTS;
  }

  private backlogScanLimit(availableSlots: number): number {
    return Math.max(
      BeadsDefaults.READY_SCAN_MIN_LIMIT,
      this.maxSlots,
      availableSlots * BeadsDefaults.READY_SCAN_MULTIPLIER
    );
  }

  private inProgressRecoveryScanLimit(readyLimit: number): number {
    return Math.max(
      readyLimit,
      BeadsDefaults.IN_PROGRESS_RECOVERY_SCAN_MIN_LIMIT,
      this.maxSlots * BeadsDefaults.IN_PROGRESS_RECOVERY_SCAN_MULTIPLIER
    );
  }

  private hasActiveLease(bead: Bead): boolean {
    const expiresAt = bead.lease?.expiresAt;
    if (!expiresAt) return false;
    if (bead.leaseSessionId && bead.leaseSessionId !== this.observability.getSessionId()) return false;
    const expiresAtMs = new Date(expiresAt).getTime();
    return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
  }

  private isResumableHarnessWork(bead: Bead): boolean {
    return bead.assigned_to === App.DISPLAY_NAME
      && !this.hasActiveLease(bead)
      && !TERMINAL_BEAD_STATUSES.has(bead.status);
  }

  private async recoverResumableStatus(
    byId: Map<string, Bead>,
    status: BeadsIssueStatus,
    limit: number
  ): Promise<void> {
    const listed = await this.beadsPort.list({
      status,
      limit: this.inProgressRecoveryScanLimit(limit),
      includeProjection: true,
      includeNotesPreview: false
    });
    for (const bead of listed.items || []) {
      if (byId.has(bead.id)) continue;
      if (!this.isResumableHarnessWork(bead)) continue;
      byId.set(bead.id, bead);
    }
  }

  private async assignmentBacklog(limit: number): Promise<Bead[]> {
    const ready = await this.beadsPort.ready({ limit });
    const byId = new Map<string, Bead>();
    for (const bead of ready) byId.set(bead.id, bead);

    await this.recoverResumableStatus(byId, BeadsIssueStatus.IN_PROGRESS, limit);
    await this.recoverResumableStatus(byId, BeadsIssueStatus.OPEN, limit);

    return [...byId.values()];
  }

  public async readyBacklog(): Promise<ScoredBead[]> {
    return this.observability.tracedAsync('orchestrator_backlog', {}, async () => {
      const maxSlots = await this.getMaxSlots();
      const backlog = await this.assignmentBacklog(this.backlogScanLimit(maxSlots));
      const active = backlog.filter(bead => !TERMINAL_BEAD_STATUSES.has(bead.status));

      const sorted = await this.scheduler.sortBacklog(active);
      return sorted.slice(0, maxSlots);
    })();
  }

  public async selectAssignments(
    availableSlots: number,
    requestedBeadId?: string,
    alreadyStarted: Set<string> = new Set()
  ): Promise<Array<ScoredBead & { stateId: string }>> {
    const config = await this.configLoader.load();
    if (requestedBeadId && alreadyStarted.has(requestedBeadId)) return [];

    const backlog = requestedBeadId
      ? [await this.beadsPort.getBead(requestedBeadId)]
      : await this.assignmentBacklog(this.backlogScanLimit(availableSlots));

    const active = backlog.filter(bead =>
      !alreadyStarted.has(bead.id) &&
      !TERMINAL_BEAD_STATUSES.has(bead.status)
    );

    const scored = await this.scheduler.sortBacklog(active);
    const assignments: Array<ScoredBead & { stateId: string }> = [];
    for (const bead of scored) {
      if (assignments.length >= availableSlots) break;
      const stateId = this.flowManager.stateForBead(bead, config);
      if (!config.states[stateId]) {
        Logger.warn(Component.ORCHESTRATOR, 'Skipping Bead with unknown configured state', { beadId: bead.id, stateId });
        continue;
      }
      assignments.push({ ...bead, stateId });
    }

    Logger.info(Component.ORCHESTRATOR, 'Orchestrator selected assignments', {
      assignments: assignments.map(bead => ({ id: bead.id, stateId: bead.stateId, score: bead.score }))
    });
    return assignments;
  }

  public async step(): Promise<ScoredBead[]> {
    return this.observability.tracedAsync('orchestrator_step', {}, async () => {
      const ready = await this.readyBacklog();
      Logger.info(Component.ORCHESTRATOR, 'Orchestrator backlog inspected', {
        ready: ready.map(bead => bead.id)
      });
      return ready;
    })();
  }
}
