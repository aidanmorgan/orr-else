import { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BeadId } from '../types/index.js';
import { Logger } from './Logger.js';
import { Observability } from './Observability.js';
import { EventStore } from './EventStore.js';
import { postHarnessSignal } from './HarnessApiClient.js';
import {
  EnvVars,
  TeammateEventType,
  Component,
  BuiltInToolName,
  PluginToolName,
  EventName,
  DomainEventName,
  WorkerDefaults,
  PiEventName
} from '../constants/index.js';
import { setProjectRoot } from './Paths.js';
import { FlowManager } from './FlowManager.js';
import { ConfigLoader } from './ConfigLoader.js';
import { createTeammateEventIdempotencyKey, type ContextRestartRequestedEvent } from './TeammateEvents.js';
import { getConfiguredProjectToolNames } from '../plugins/projectTools.js';
import { getConfiguredPiToolNames } from './PiIntegration.js';
import type { RuntimePlugin } from './RuntimeServices.js';

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
    private readonly qualityPlugin: RuntimePlugin
  ) {}

  public async start() {
    return this.observability.tracedAsync('teammate_mode', {}, async () => this.startInner())();
  }

  private async startInner() {
    const beadId = process.env[EnvVars.BEAD_ID] as BeadId | undefined;
    const stateId = process.env[EnvVars.STATE_ID];
    const projectRoot = process.env[EnvVars.PROJECT_ROOT] || process.cwd();
    const worktreePath = process.env[EnvVars.WORKTREE_PATH] || undefined;
    
    if (!beadId || !stateId) {
      Logger.error(Component.TEAMMATE, 'Teammate mode started without required environment variables', { beadId, stateId });
      return;
    }

    setProjectRoot(projectRoot);
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

    // 1. Context Health Monitoring (Programmatic Compaction Tracking)
    let compactionCount = 0;
    this.pi.on(PiEventName.SESSION_COMPACT, () => {
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
        this.triggerAutoRestart(beadId!, stateId!, compactionCount).catch(error => {
          Logger.error(Component.TEAMMATE, 'Failed to trigger programmatic auto-restart', { error: String(error) });
        });
      }
    });

    // 2. Heartbeat logic with consecutive-failure tracking. The signaling
    // server is a known single-point-of-failure (production telemetry: 210
    // heartbeat NetworkErrors + 154 transport-error harness restarts). One
    // failure is logged once at warn; subsequent consecutive failures fall
    // to debug so they don't flood the log. The first heartbeat to succeed
    // after a streak emits a recovery message.
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

    // End turn on abort
    this.ctx.signal?.addEventListener('abort', () => clearInterval(heartbeat), { once: true });
  }

  private async sendHeartbeat(beadId: string, stateId: string) {
    const heartbeatTool = this.bdPlugin.tools.find(t => t.name === PluginToolName.BD_HEARTBEAT)!;
    await heartbeatTool.execute({
      workerId: process.env[EnvVars.WORKER_ID] || `worker-${process.pid}`,
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
      workerId: process.env[EnvVars.WORKER_ID] || `worker-${process.pid}`,
      stateId,
      timestamp: Date.now(),
      actionId: process.env[EnvVars.ACTION_ID] || WorkerDefaults.AUTO_CONTEXT_RESTART_ACTION_ID,
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
