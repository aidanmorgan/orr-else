import { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BeadId } from '../types/index.js';
import { Logger } from './Logger.js';
import { Observability } from './Observability.js';
import { EventStore } from './EventStore.js';
import { postHarnessSignal } from './HarnessApiClient.js';
import {
  TeammateEventType,
  Component,
  BuiltInToolName,
  PluginToolName,
  EventName,
  DomainEventName,
  WorkerDefaults,
  PiEventName
} from '../constants/index.js';
import { FlowManager } from './FlowManager.js';
import { ConfigLoader, type HarnessConfig } from './ConfigLoader.js';
import { createTeammateEventIdempotencyKey, type ContextRestartRequestedEvent } from './TeammateEvents.js';
import { getConfiguredProjectToolNames } from '../plugins/projectTools.js';
import { getConfiguredPiToolNames } from './PiIntegration.js';
import type { RuntimePlugin } from './RuntimeServices.js';

/**
 * Resolved worker-process identity and environment context, built once at the
 * composition root (extension.ts) and injected into Teammate so the class
 * itself contains zero direct process.env reads.
 */
export interface WorkerContext {
  beadId: BeadId | undefined;
  stateId: string | undefined;
  projectRoot: string;
  worktreePath: string | undefined;
  workerId: string;
  actionId: string;
}

export class Teammate {
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    private readonly observability: Observability,
    private readonly configLoader: ConfigLoader,
    private readonly eventStore: EventStore,
    private readonly flowManager: FlowManager,
    private readonly bdPlugin: RuntimePlugin,
    private readonly gitPlugin: RuntimePlugin,
    private readonly mailboxPlugin: RuntimePlugin,
    private readonly qualityPlugin: RuntimePlugin,
    private readonly workerContext: WorkerContext
  ) {}

  public async start() {
    return this.observability.tracedAsync('teammate_mode', {}, async () => this.startInner())();
  }

  private async startInner() {
    const { beadId, stateId, projectRoot, worktreePath } = this.workerContext;

    if (!beadId || !stateId) {
      Logger.error(Component.TEAMMATE, 'Teammate mode started without required environment variables', { beadId, stateId });
      return;
    }

    // Direct the Logger's rotating-file transport to the correct project root
    // for this worker process. The root comes from WorkerContext (WI-6), not
    // from the mutable module global.
    Logger.configureProjectRoot(projectRoot);
    Logger.info(Component.TEAMMATE, 'Teammate mode activated', { beadId, stateId, worktreePath });
    const config = await this.configLoader.load();

    // Activate tools for teammate
    this.flowManager.activateTools(this.pi, [
      BuiltInToolName.TICK_ITEM,
      BuiltInToolName.GET_OUTSTANDING_TASKS,
      BuiltInToolName.SUBMIT_CHECKPOINT,
      BuiltInToolName.REQUEST_CONTEXT_RESTART,
      BuiltInToolName.REQUEST_HARNESS_RESTART,
      BuiltInToolName.GET_ARTIFACT_PATHS,
      BuiltInToolName.SIGNAL_COMPLETION,
      PluginToolName.BD_HEARTBEAT,
      ...this.bdPlugin.tools.map(t => t.name),
      ...this.gitPlugin.tools.map(t => t.name).filter(name => name !== PluginToolName.MERGE_AND_COMMIT),
      ...this.mailboxPlugin.tools.map(t => t.name),
      ...this.qualityPlugin.tools.map(t => t.name),
      ...getConfiguredProjectToolNames(config),
      ...getConfiguredPiToolNames(config)
    ]);

    const stopCompactionMonitor = this.setupCompactionMonitor(beadId, stateId, config);
    const stopHeartbeat = this.setupHeartbeat(beadId, stateId);

    // Tear down both monitors on abort (fixes SESSION_COMPACT listener accumulation leak)
    this.ctx.signal?.addEventListener('abort', () => {
      stopCompactionMonitor();
      stopHeartbeat();
    }, { once: true });
  }

  /** Sets up the SESSION_COMPACT compaction monitor. Returns a cleanup function that
   *  makes the registered listener a no-op (pi.on has no off(); the guard prevents
   *  side-effects after the teammate lifecycle ends). */
  private setupCompactionMonitor(
    beadId: string,
    stateId: string,
    config: HarnessConfig
  ): () => void {
    let compactionCount = 0;
    let active = true;

    this.pi.on(PiEventName.SESSION_COMPACT, () => {
      if (!active) return;

      compactionCount++;
      Logger.info(Component.TEAMMATE, 'Session auto-compacted by Pi', { beadId, compactionCount });
      void this.eventStore.record(DomainEventName.CONTEXT_COMPACTION_RECORDED, {
        beadId,
        stateId,
        compactionCount
      }).catch(error => {
        Logger.warn(Component.TEAMMATE, 'Failed to record compaction event', { beadId, error: String(error) });
      });

      const thresholds = config.settings.contextMonitor || {
        autoRestartCompactionCount: WorkerDefaults.AUTO_RESTART_COMPACTION_COUNT
      };
      if (compactionCount >= (thresholds.autoRestartCompactionCount || WorkerDefaults.AUTO_RESTART_COMPACTION_COUNT)) {
        Logger.info(Component.TEAMMATE, 'Compaction threshold reached. Programmatically triggering auto-restart to prevent implementation rot.', {
          beadId,
          compactionCount
        });

        if (this.ctx.hasUI) {
          this.ctx.ui.notify('Context rot detected (too many compactions). Harness is programmatically recycling session.', 'warning');
        }

        // Trigger auto-restart handover logic
        this.triggerAutoRestart(beadId, stateId, compactionCount).catch(error => {
          Logger.error(Component.TEAMMATE, 'Failed to trigger programmatic auto-restart', { error: String(error) });
        });
      }
    });

    return () => { active = false; };
  }

  /** Sets up the heartbeat interval. Returns a cleanup function that clears the interval.
   *
   * Consecutive-failure tracking: one failure is logged at warn; subsequent consecutive
   * failures fall to debug so they don't flood the log. The first heartbeat to succeed
   * after a streak emits a recovery message. */
  private setupHeartbeat(beadId: string, stateId: string): () => void {
    let consecutiveHeartbeatFailures = 0;
    const heartbeat = setInterval(() => {
      this.sendHeartbeat(beadId, stateId).then(() => {
        if (consecutiveHeartbeatFailures > 0) {
          Logger.info(Component.TEAMMATE, 'Worker heartbeat recovered', {
            beadId,
            previousFailures: consecutiveHeartbeatFailures
          });
          consecutiveHeartbeatFailures = 0;
        }
      }).catch(error => {
        consecutiveHeartbeatFailures += 1;
        const detail = { beadId, error: String(error), consecutiveFailures: consecutiveHeartbeatFailures };
        if (consecutiveHeartbeatFailures === 1) {
          Logger.warn(Component.TEAMMATE, 'Worker heartbeat failed', detail);
        } else {
          Logger.debug(Component.TEAMMATE, 'Worker heartbeat still failing', detail);
        }
      });
    }, WorkerDefaults.HEARTBEAT_INTERVAL_MS);

    return () => clearInterval(heartbeat);
  }

  private async sendHeartbeat(beadId: string, stateId: string) {
    const heartbeatTool = this.bdPlugin.tools.find(t => t.name === PluginToolName.BD_HEARTBEAT)!;
    await heartbeatTool.execute({
      workerId: this.workerContext.workerId,
      beadId,
      stateId,
      pid: process.pid
    });
  }

  private async triggerAutoRestart(beadId: string, stateId: string, compactionCount: number) {
    const config = await this.configLoader.load();
    const summary = `PROGRAMMATIC AUTO-RESTART: Compaction threshold reached (Count: ${compactionCount}). Teammate process was automatically recycled by the harness to prevent implementation rot caused by context pollution.`;
    const event = {
      type: TeammateEventType.CONTEXT_RESTART_REQUESTED,
      beadId: beadId as BeadId,
      workerId: this.workerContext.workerId,
      stateId,
      timestamp: Date.now(),
      actionId: this.workerContext.actionId,
      transitionEvent: config.settings.contextRestartEvent || EventName.CONTEXT_RESTART,
      summary,
      evidence: summary,
      handover: `AUTO-RESTART: Too many compactions (${compactionCount}). Fresh session required for quality.`
    } satisfies Omit<ContextRestartRequestedEvent, 'idempotencyKey'>;

    const signal: ContextRestartRequestedEvent = {
      ...event,
      idempotencyKey: createTeammateEventIdempotencyKey(event)
    };
    await this.eventStore.record(DomainEventName.SIGNAL_INTENT_RECORDED, signal);
    try {
      await postHarnessSignal(signal);
      await this.eventStore.record(DomainEventName.SIGNAL_ACKNOWLEDGED, signal);
    } catch (error) {
      await this.eventStore.record(DomainEventName.TEAMMATE_SIGNAL_FAILED, {
        ...signal,
        error: String(error)
      }).catch(() => {});
      throw error;
    }
    
    // Allow a moment for the signal to propagate before shutting down
    setTimeout(() => this.ctx.shutdown(), WorkerDefaults.SHUTDOWN_AFTER_RESTART_MS);
  }
}
