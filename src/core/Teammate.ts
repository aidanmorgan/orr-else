import { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BeadId, WorkerId, StateId, ActionId } from '../types/index.js';
import { nodeLogger as Logger } from './Logger.js'
import { Observability } from './Observability.js';
import { EventStore } from './EventStore.js';
import { postHarnessSignal } from './HarnessApiClient.js';
import { BuiltInToolName, DomainEventName, EventName, PluginToolName, TeammateEventType } from '../constants/domain.js';
import { Component, PiEventName, WorkerDefaults } from '../constants/infra.js';
import { FlowManager } from './FlowManager.js';
import { ConfigLoader, type HarnessConfig } from './ConfigLoader.js';
import { createTeammateEventIdempotencyKey, type ContextRestartRequestedEvent } from './TeammateEvents.js';
import { getConfiguredPiToolNames } from './WorkerResourceResolver.js';
import { resolveActiveToolSet } from './ActiveToolSetResolver.js';
import * as path from 'node:path';
import {
  buildCompactionSummary,
  writeCompactionSummaryArtifact,
  buildCompactionSummaryPointerPayload
} from './CompactionSummary.js';
import type { CompactionFallbackConfig } from './domain/StateModels.js';
import { resolveCompactionPointer } from './RestartHandoffValidation.js';

/**
 * Port for resolving the names of configured project tools to activate in a
 * teammate session. Injected at construction time so Teammate.ts has no
 * dependency on concrete plugin implementations (WI-5).
 */
export type ProjectToolNameResolver = (config: HarnessConfig) => string[];
import type { RuntimePlugin } from './RuntimeServices.js';

/**
 * Resolved worker-process identity and environment context, built once at the
 * composition root (extension.ts) and injected into Teammate so the class
 * itself contains zero direct process.env reads.
 */
export interface WorkerContext {
  beadId: BeadId | undefined;
  stateId: StateId | undefined;
  projectRoot: string;
  worktreePath: string | undefined;
  workerId: WorkerId;
  actionId: ActionId;
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
    private readonly workerContext: WorkerContext,
    private readonly projectToolNameResolver: ProjectToolNameResolver = () => []
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

    // pi-experiment-6q0y.3: resolve the active project tool set for this state/action
    // boundary. When activeTools is declared on the state or action, only the resolved
    // subset is exposed; otherwise all project tools remain callable (default path).
    //
    // Granularity: worker entry is STATE-level. The actionId in WorkerContext comes
    // from env(ACTION_ID) || AUTO_CONTEXT_RESTART_ACTION_ID. In production, PI_ACTION_ID
    // is never set at spawn — the real action is selected worker-side after startup —
    // so actionId is always the sentinel. Passing the sentinel to resolveActiveToolSet
    // would throw (no state declares an 'auto-context-restart' action). Instead:
    //   - When actionId IS the sentinel: resolve at state level (actionId = undefined).
    //   - When actionId is a real value (set explicitly, e.g. in tests or future
    //     harnesses that do pre-select the action): use it for action-level refinement.
    //
    // If stateId is absent from config.states (e.g. minimal test configs, partial
    // config fixtures), fall back to all project tools — the state declared no
    // restriction. Genuine resolver errors (unknown tool names, duplicates) propagate
    // as startup-fatal; the "state not found" branch is not a misconfiguration when
    // the config has no state declarations.
    const resolvedProjectTools = (() => {
      if (!stateId) return this.projectToolNameResolver(config);
      if (!config.states[stateId as string]) return this.projectToolNameResolver(config);
      const isSentinel =
        (this.workerContext.actionId as string) === WorkerDefaults.AUTO_CONTEXT_RESTART_ACTION_ID;
      const effectiveActionId = isSentinel ? undefined : (this.workerContext.actionId as string);
      const resolved = resolveActiveToolSet(stateId as string, effectiveActionId, config);
      return resolved.isDefault ? this.projectToolNameResolver(config) : resolved.toolNames;
    })();

    // Activate tools for teammate
    this.flowManager.activateTools(this.pi, [
      BuiltInToolName.TICK_ITEMS,
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
      ...resolvedProjectTools,
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
    // Guard: emit at most one remote restart signal per worker process lifecycle.
    // After the first CONTEXT_RESTART_REQUESTED is posted, subsequent compactions
    // still record a durable CONTEXT_COMPACTION_RECORDED event (evidence preserved)
    // but do NOT post another remote signal (r06o AC4).
    let restartSignalSent = false;
    // Guard: emit at most one CONTEXT_COMPACTION_WARNING per worker lifecycle.
    let warningSent = false;

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

      // pi-experiment-6q0y.35: when compactionSummary is enabled for this state,
      // generate the deterministic JSON artifact and record the pointer event.
      // No-op when absent or disabled (AC1/AC2).
      const stateConfig = config.states[stateId as string] as {
        compactionSummary?: { enabled: boolean; compactionRoute?: string };
        compactionFallback?: CompactionFallbackConfig;
      } | undefined;
      if (stateConfig?.compactionSummary?.enabled === true) {
        void this.generateCompactionSummary(beadId, stateId, stateConfig.compactionSummary.compactionRoute).catch(error => {
          Logger.warn(Component.TEAMMATE, 'Failed to generate compaction summary', { beadId, stateId, error: String(error) });
        });
      }

      // pi-experiment-6q0y.37: optional per-state compaction warning + fallback restart.
      // DEFAULT DISABLED — no-op when compactionFallback is absent or enabled:false (AC1/AC6).
      const fallbackCfg = stateConfig?.compactionFallback;
      if (fallbackCfg?.enabled === true) {
        const warnThreshold = fallbackCfg.warnThreshold ?? 1;
        const autoThreshold = fallbackCfg.autoThreshold ?? (warnThreshold + 1);

        // AC2: first warning threshold — record CONTEXT_COMPACTION_WARNING, NO restart.
        if (!warningSent && compactionCount >= warnThreshold && compactionCount < autoThreshold) {
          warningSent = true;
          Logger.info(Component.TEAMMATE, 'Compaction warning threshold reached', { beadId, compactionCount, warnThreshold });
          void this.eventStore.record(DomainEventName.CONTEXT_COMPACTION_WARNING, {
            beadId,
            stateId,
            compactionCount,
            warnThreshold
          }).catch(error => {
            Logger.warn(Component.TEAMMATE, 'Failed to record compaction warning', { beadId, error: String(error) });
          });
        }

        // AC3/AC4: auto threshold — post exactly one evidence-aware restart per lifecycle.
        // AC5: duplicate suppression — restartSignalSent guards subsequent compactions.
        if (compactionCount >= autoThreshold) {
          if (restartSignalSent) {
            // Duplicate suppression: diagnostic evidence already recorded above (CONTEXT_COMPACTION_RECORDED).
            Logger.info(Component.TEAMMATE, 'Compaction fallback threshold exceeded again; restart already requested', {
              beadId,
              compactionCount
            });
            return;
          }

          restartSignalSent = true;
          Logger.info(Component.TEAMMATE, 'Compaction fallback threshold reached. Triggering evidence-aware fallback restart.', {
            beadId,
            compactionCount,
            autoThreshold
          });

          if (this.ctx.hasUI) {
            this.ctx.ui.notify('Compaction fallback threshold reached. Harness is posting a deterministic restart request.', 'warning');
          }

          // Trigger evidence-aware fallback restart (AC3/AC4: carries compaction-artifact pointer + evidence refs).
          this.triggerFallbackRestart(beadId, stateId, compactionCount).catch(error => {
            Logger.error(Component.TEAMMATE, 'Failed to trigger compaction fallback restart', { error: String(error) });
          });
          return;
        }
      }

      // AC1/AC6: states without compactionFallback.enabled:true receive NO harness-forced
      // compaction restart. Pi.dev autocompaction is the only behavior (default).
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

  /**
   * pi-experiment-6q0y.35: Generate the deterministic compaction summary artifact
   * and record the COMPACTION_SUMMARY_RECORDED pointer event (AC3–AC7).
   *
   * Called only when compactionSummary.enabled:true is configured for the state.
   * Reads schema-valid events via eventsForBead (fail-closed, post-jxdk).
   * Writes the artifact under <projectRoot>/.pi/artifacts/<beadId>/compaction-summary.json.
   * Records COMPACTION_SUMMARY_RECORDED with nonAuthoritative:true (AC7).
   * compactionRoute is included as metadata in the pointer event — no direct routing.
   */
  private async generateCompactionSummary(
    beadId: string,
    stateId: string,
    compactionRoute: string | undefined
  ): Promise<void> {
    const events = await this.eventStore.eventsForBead(beadId as BeadId);
    const summary = buildCompactionSummary({ beadId, stateId, events });
    const artifactPath = path.join(
      this.workerContext.projectRoot,
      '.pi', 'artifacts', beadId, 'compaction-summary.json'
    );
    const written = writeCompactionSummaryArtifact(summary, artifactPath);
    const payload = buildCompactionSummaryPointerPayload(beadId, stateId, written, summary.sourceEventIds);
    await this.eventStore.record(DomainEventName.COMPACTION_SUMMARY_RECORDED, {
      ...payload,
      ...(compactionRoute !== undefined ? { compactionRoute } : {})
    });
    Logger.info(Component.TEAMMATE, 'Compaction summary written', {
      beadId,
      stateId,
      artifactPath: written.artifactPath,
      artifactBytes: written.artifactBytes
    });
  }

  /**
   * pi-experiment-6q0y.37: Trigger a deterministic evidence-aware fallback restart.
   *
   * AC3/AC4: posts EXACTLY ONE evidence-aware restart per worker lifecycle,
   * carrying the 6q0y.35 compaction-artifact pointer + evidence refs.
   * NEVER a generic one-line summary.
   *
   * The compaction pointer is resolved from the bead's prior events
   * (COMPACTION_SUMMARY_RECORDED written by generateCompactionSummary).
   * ConfigLoader lint guarantees compactionSummary.enabled:true is co-declared
   * whenever compactionFallback.enabled:true — so a pointer is always present.
   * If absent at runtime despite the lint, records a diagnostic and does NOT
   * post any restart (fail-closed; never a generic one-line summary).
   *
   * AC5: duplicate suppression is enforced by the restartSignalSent guard in
   * setupCompactionMonitor — this method is called at most once per lifecycle.
   */
  private async triggerFallbackRestart(beadId: string, stateId: string, compactionCount: number) {
    const config = await this.configLoader.load();
    const priorEvents = await this.eventStore.eventsForBead(beadId as BeadId);
    const compactionPointer = resolveCompactionPointer(priorEvents);

    if (!compactionPointer) {
      // No compaction pointer available — AC4: never post a generic one-line restart.
      // ConfigLoader lint (validateCompactionFallbackDeclarations) guarantees that
      // compactionSummary.enabled:true is co-declared, so this branch is unreachable
      // in valid configs. Record a diagnostic and do NOT post any restart signal.
      Logger.error(Component.TEAMMATE, 'Compaction fallback: no COMPACTION_SUMMARY_RECORDED found; skipping restart (lint should have prevented this)', {
        beadId,
        stateId,
        compactionCount
      });
      return;
    }

    // Build evidence refs from the compaction pointer (AC4: deterministic + non-generic).
    const evidenceRefs = [{
      schemaId: 'compaction-summary',
      semanticArtifactPath: compactionPointer.artifactPath,
      bytes: compactionPointer.artifactBytes,
      sha256: compactionPointer.artifactSha256,
      sourceEventIds: compactionPointer.sourceEventIds
    }];

    const narrativeSummary =
      `COMPACTION FALLBACK RESTART: Auto-threshold reached (Count: ${compactionCount}). ` +
      `Evidence-aware restart triggered by harness compaction policy. ` +
      `Compaction artifact: ${compactionPointer.artifactPath}`;

    const event = {
      type: TeammateEventType.CONTEXT_RESTART_REQUESTED,
      beadId: beadId as BeadId,
      workerId: this.workerContext.workerId,
      stateId: stateId as StateId,
      timestamp: Date.now(),
      actionId: this.workerContext.actionId,
      transitionEvent: config.settings.contextRestartEvent || EventName.CONTEXT_RESTART,
      summary: narrativeSummary,
      evidence: narrativeSummary,
      handover: narrativeSummary
    } satisfies Omit<ContextRestartRequestedEvent, 'idempotencyKey'>;

    const signal: ContextRestartRequestedEvent & { evidenceRefs: typeof evidenceRefs } = {
      ...event,
      idempotencyKey: createTeammateEventIdempotencyKey(event),
      evidenceRefs
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

    // Allow a moment for the signal to propagate before shutting down.
    setTimeout(() => this.ctx.shutdown(), WorkerDefaults.SHUTDOWN_AFTER_RESTART_MS);
  }

}
