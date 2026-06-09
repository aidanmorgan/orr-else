/**
 * BeadSpawnCoordinator — owns the claim → [worktree] → record → spawn → release
 * transaction for a single bead assignment.
 *
 * pi-experiment-amq0.2: extracted from Supervisor so the spawn transaction is
 * testable without tmux, bd, or a full RuntimeServices bag.
 *
 * Narrow ports injected at construction time:
 *   beadsPort      — BD_CLAIM / BD_RELEASE
 *   worktreePort   — CREATE_WORKTREE
 *   eventStore     — domain event recording
 *   factory        — spawnTeammateInTmux (TeammateSpawner)
 *   observability  — span recording
 *   configLoader   — read per-spawn config
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ScoredBead } from './Scheduler.js';
import type { HarnessConfig } from './ConfigLoader.js';
import { Logger, type LoggerPort } from './Logger.js';
import { Observability } from './Observability.js';
import { App, DomainEventName, QuarantineReason, StateContextPolicy } from '../constants/domain.js';
import { Component, Defaults, OtelAttr, SpanName } from '../constants/infra.js';
import { mcpBackedRequiredToolNames, type McpBridgeHealth } from './McpTransportPreflight.js';
import { McpBridgeHealthService } from './McpBridgeHealthService.js';
import {
  resolveStateContextPolicy,
  evaluateContinuationAdmission,
  buildContextInstanceRecord,
  type ContextKeyRecord,
} from '../extension/CoordinatorController.js';
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
import type { WorktreeProvisioningMode } from './domain/StateModels.js';
import type { ProjectionCapableStore } from './EventStoreTypes.js';
import type { BeadsPort, WorktreePort, TeammateSpawner, SpawnOptions } from './OrchestrationPorts.js';
import type { ConfigLoaderPort, FlowManagerPort } from './SupervisorPorts.js';

// ---------------------------------------------------------------------------
// Quarantine types (local to the coordinator spawn path)
// ---------------------------------------------------------------------------

interface QuarantineEntry {
  reason: QuarantineReason;
  signature: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// BeadSpawnCoordinator
// ---------------------------------------------------------------------------

export class BeadSpawnCoordinator {
  /** In-memory quarantine map: beadId → QuarantineEntry. */
  readonly quarantine = new Map<string, QuarantineEntry>();
  /**
   * Beads whose quarantine entry was rehydrated from a durable BEAD_QUARANTINED
   * event. Used to emit BEAD_QUARANTINE_CLEARED when a rehydrated entry is lifted.
   */
  readonly rehydratedQuarantineBeadIds = new Set<string>();

  /**
   * Context key store for named-continuation spawns (pi-experiment-6q0y.44 AC7).
   * Maps contextKey → ContextKeyRecord.
   */
  readonly contextKeyStore = new Map<string, ContextKeyRecord>();

  constructor(
    private readonly beadsPort: BeadsPort,
    private readonly worktreePort: WorktreePort,
    private readonly eventStore: ProjectionCapableStore,
    private readonly factory: TeammateSpawner,
    private readonly observability: Observability,
    private readonly configLoader: ConfigLoaderPort,
    private readonly flowManager: FlowManagerPort,
    private readonly projectRoot: string,
    private readonly clockNow: () => number,
    private readonly clockDate: (ms?: number) => Date,
    private readonly mcpBridgeHealthService: McpBridgeHealthService = new McpBridgeHealthService(),
    private readonly logger: LoggerPort = Logger
  ) {}

  // ---------------------------------------------------------------------------
  // Taxonomy helpers (moved verbatim from Supervisor)
  // ---------------------------------------------------------------------------

  taxonomyFields(
    failureClass: FailureClass,
    lifecyclePhase: LifecyclePhase,
    retryBudget: RetryBudget
  ): { taxonomyClass: string; lifecyclePhase: string; taxonomyRowId: string; taxonomyAction: string; retryBudget: string } {
    const result = routeFailure({ failureClass, lifecyclePhase, retryBudget, authorityLevel: AuthorityLevel.HARNESS });
    const desc = compactDescriptor(result);
    return {
      taxonomyClass: desc.cls,
      lifecyclePhase,
      taxonomyRowId: desc.rowId,
      taxonomyAction: desc.action,
      retryBudget,
    };
  }

  routeTaxonomy(
    failureClass: FailureClass,
    lifecyclePhase: LifecyclePhase,
    retryBudget: RetryBudget
  ) {
    return routeFailure({ failureClass, lifecyclePhase, retryBudget, authorityLevel: AuthorityLevel.HARNESS });
  }

  // ---------------------------------------------------------------------------
  // Quarantine helpers (moved verbatim from Supervisor)
  // ---------------------------------------------------------------------------

  private quarantineSignatureFor(bead: { status: string; lastActivity?: string }): string {
    return `${bead.status}:${bead.lastActivity || ''}`;
  }

  classifyWorktreeError(errorText: string): QuarantineReason {
    const lower = errorText.toLowerCase();
    if (lower.includes('already checked out') || lower.includes('is already checked out')) {
      return QuarantineReason.ALREADY_CHECKED_OUT;
    }
    if (
      lower.includes('invalid reference') ||
      lower.includes('not a valid object name') ||
      lower.includes('invalid branch') ||
      lower.includes('bad revision') ||
      (lower.includes('pathspec') && lower.includes('did not match'))
    ) {
      return QuarantineReason.INVALID_BRANCH_REF;
    }
    if (lower.includes('already exists') || lower.includes('file exists') || lower.includes('path is already')) {
      return QuarantineReason.WORKTREE_PATH_TAKEN;
    }
    return QuarantineReason.UNKNOWN;
  }

  async isQuarantined(bead: { id: string; status: string; lastActivity?: string }): Promise<boolean> {
    const entry = this.quarantine.get(bead.id);
    if (!entry) return false;
    const currentSig = this.quarantineSignatureFor(bead);
    if (currentSig !== entry.signature) {
      const wasRehydrated = this.rehydratedQuarantineBeadIds.has(bead.id);
      this.quarantine.delete(bead.id);
      this.rehydratedQuarantineBeadIds.delete(bead.id);
      if (wasRehydrated) {
        await this.eventStore.record(DomainEventName.BEAD_QUARANTINE_CLEARED, {
          beadId: bead.id,
          reason: entry.reason,
          previousSignature: entry.signature,
          currentSignature: currentSig
        }).catch(() => {});
        this.logger.info(Component.SUPERVISOR, 'Rehydrated quarantine cleared — bead eligible for retry', {
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

  async quarantineBead(
    bead: { id: string; status: string; lastActivity?: string },
    reason: QuarantineReason,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const signature = this.quarantineSignatureFor(bead);
    this.quarantine.set(bead.id, { reason, signature, details });
    await this.eventStore.record(DomainEventName.BEAD_QUARANTINED, {
      beadId: bead.id,
      reason,
      signature,
      ...details
    }).catch(() => {});
    this.logger.warn(Component.SUPERVISOR, 'Bead quarantined by supervisor preflight', {
      beadId: bead.id,
      reason,
      ...details
    });
  }

  /** Rehydrate quarantine map from durable BEAD_QUARANTINED events on restart. */
  async rehydrateQuarantinesFromEvents(events?: import('./EventStoreTypes.js').DomainEvent[]): Promise<void> {
    try {
      const allEvents = events ?? await this.eventStore.readAll();
      const latestByBead = new Map<string, import('./EventStoreTypes.js').DomainEvent>();
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
        this.logger.info(Component.SUPERVISOR, 'Rehydrated bead quarantines from event store on startup', { rehydrated });
      }
    } catch (error) {
      this.logger.warn(Component.SUPERVISOR, 'Unable to rehydrate quarantines from event store; quarantine state is in-memory only this session', { error: String(error) });
    }
  }

  // ---------------------------------------------------------------------------
  // MCP preflight helpers (moved verbatim from Supervisor)
  // ---------------------------------------------------------------------------

  getMcpBridgeHealth(): McpBridgeHealth | undefined {
    return this.mcpBridgeHealthService.getCachedHealth();
  }

  requiredMcpToolNamesForBead(stateId: string, config: HarnessConfig): string[] {
    const state = config.states?.[stateId];
    if (!state) return [];

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

  async runMcpPreflightForTools(mcpToolNames: string[]): Promise<McpBridgeHealth> {
    return this.mcpBridgeHealthService.check(
      mcpToolNames,
      (data) => this.eventStore.record(DomainEventName.MCP_TRANSPORT_PREFLIGHT_FAILED, data)
    );
  }

  // ---------------------------------------------------------------------------
  // Worktree allocation policy (moved verbatim from Supervisor)
  // ---------------------------------------------------------------------------

  resolveWorktreeProvisioning(stateId: string, config: HarnessConfig): boolean {
    const stateConfig = config.states?.[stateId];
    if (stateConfig?.provisionWorktree !== undefined) {
      return stateConfig.provisionWorktree;
    }
    const policyDefault: WorktreeProvisioningMode = config.settings?.worktreePolicy?.default ?? 'always';
    return policyDefault !== 'never';
  }

  // ---------------------------------------------------------------------------
  // Config digest (moved verbatim from Supervisor)
  // ---------------------------------------------------------------------------

  computeConfigDigest(): string {
    try {
      const configPath = this.configLoader.getConfigPath();
      const contents = fs.readFileSync(configPath);
      return createHash('sha256').update(contents).digest('hex');
    } catch {
      return 'unknown';
    }
  }

  // ---------------------------------------------------------------------------
  // Release after pause (moved verbatim from Supervisor)
  // ---------------------------------------------------------------------------

  async releaseClaimedAfterPause(
    claimed: { id: string },
    pausedUntilMs: number,
    pausedReason: string,
    markBeadExited: (id: string, opts?: { preserveInactiveRestartBackoff?: boolean }) => void
  ): Promise<void> {
    await this.beadsPort.release(claimed.id).catch((error: unknown) => {
      this.logger.warn(Component.SUPERVISOR, 'Unable to release Bead lease after scheduling pause', {
        beadId: claimed.id,
        error: String(error)
      });
    });
    markBeadExited(claimed.id, { preserveInactiveRestartBackoff: true });
    this.logger.warn(Component.SUPERVISOR, 'Stopped assignment dispatch after scheduling pause', {
      beadId: claimed.id,
      pauseUntil: this.clockDate(pausedUntilMs).toISOString(),
      reason: pausedReason
    });
  }

  // ---------------------------------------------------------------------------
  // Core spawn transaction (moved verbatim from Supervisor)
  // ---------------------------------------------------------------------------

  /**
   * Claim one bead, conditionally provision its worktree, record the event,
   * and spawn a teammate. Owns the full claim → [worktree] → record → spawn
   * sequence for a single bead, including releasing the lease on every failure path.
   *
   * Returns:
   *   'spawned'     — success.
   *   'paused'      — scheduling pause detected mid-flight; caller should break the loop.
   *   'quarantined' — worktree creation failed and the bead was quarantined.
   *   throws        — hard failure (spawn failure or unexpected error).
   */
  async claimAndSpawnBead(
    bead: ScoredBead & { stateId: string },
    config: HarnessConfig,
    ctx: ExtensionContext,
    isSchedulingPaused: () => boolean,
    pausedUntilMs: () => number,
    pausedReason: () => string,
    isStopping: () => boolean,
    startedBeads: Set<string>,
    startedBeadAtMs: Map<string, number>,
    markBeadExited: (id: string, opts?: { preserveInactiveRestartBackoff?: boolean }) => void
  ): Promise<'spawned' | 'paused' | 'quarantined'> {
    if ((ctx as any).hasUI) (ctx as any).ui.setStatus(Component.ORR_ELSE.toLowerCase(), `Claiming ${bead.id}...`);

    const claimed = await this.beadsPort.claim({
      id: bead.id,
      owner: App.DISPLAY_NAME,
      stateId: bead.stateId,
      leaseTtlMs: config.settings?.agentTurnTimeoutMs || Defaults.LEASE_TTL_MS
    }, ctx);

    if (isSchedulingPaused()) {
      await this.releaseClaimedAfterPause(claimed, pausedUntilMs(), pausedReason(), markBeadExited);
      return 'paused';
    }

    if (isStopping()) {
      await this.beadsPort.release(claimed.id).catch(() => {});
      startedBeads.delete(claimed.id);
      return 'paused';
    }

    const needsWorktree = this.resolveWorktreeProvisioning(bead.stateId, config);
    let worktreePath: string;

    if (needsWorktree) {
      const result = await this.worktreePort.createWorktree(claimed.id, ctx);
      worktreePath = result.path ?? '';
      if (result.success !== true || !worktreePath) {
        await this.beadsPort.release(claimed.id).catch(() => {});
        startedBeads.delete(claimed.id);
        startedBeadAtMs.delete(claimed.id);
        const errorText = result.error || `Failed to provision worktree for ${claimed.id}`;
        const quarantineReason = this.classifyWorktreeError(errorText);
        await this.quarantineBead(bead, quarantineReason, this.taxonomyFields(FailureClass.STARTUP_SUBSTRATE, LifecyclePhase.SPAWN, RetryBudget.AVAILABLE));
        return 'quarantined';
      }
      await this.eventStore.record(DomainEventName.WORKTREE_PROVISIONED, { beadId: claimed.id, worktreePath });
    } else {
      if (config.version === 2) {
        await this.beadsPort.release(claimed.id).catch(() => {});
        startedBeads.delete(claimed.id);
        startedBeadAtMs.delete(claimed.id);
        await this.quarantineBead(bead, QuarantineReason.V2_ISOLATED_WORKTREE_REQUIRED, {
          ...this.taxonomyFields(FailureClass.STARTUP_SUBSTRATE, LifecyclePhase.SPAWN, RetryBudget.AVAILABLE),
          stateId: bead.stateId,
          diagnostic:
            `v2 spawn invariant violated: state "${bead.stateId}" has provisionWorktree: false ` +
            `but v2 harness forbids running workers at the project root. ` +
            `Either set provisionWorktree: true on this state or remove it to use the v2 default (isolated worktree).`
        });
        return 'quarantined';
      }
      worktreePath = this.projectRoot;
      this.logger.info(Component.SUPERVISOR, `Worktree provisioning skipped for state ${bead.stateId}; teammate will run at project root`, {
        beadId: claimed.id,
        stateId: bead.stateId
      });
    }

    if (isSchedulingPaused()) {
      await this.releaseClaimedAfterPause(claimed, pausedUntilMs(), pausedReason(), markBeadExited);
      return 'paused';
    }

    if ((ctx as any).hasUI) (ctx as any).ui.setStatus(Component.ORR_ELSE.toLowerCase(), `Spawning ${bead.id} (${bead.stateId})...`);

    const contextPolicy = resolveStateContextPolicy(bead.stateId, config);
    let spawnContextKey: string | undefined;
    let isResumption = false;

    if (contextPolicy.mode === StateContextPolicy.NAMED_CONTINUATION && contextPolicy.contextKey) {
      const storedRecord = this.contextKeyStore.get(contextPolicy.contextKey);
      const consumingConfigDigest = this.computeConfigDigest();
      const admission = evaluateContinuationAdmission({
        contextKey: contextPolicy.contextKey,
        storedRecord,
        beadId: claimed.id,
        consumingStateId: bead.stateId,
        consumingConfigDigest
      });

      if (!admission.admitted) {
        await this.eventStore.record(DomainEventName.CONTEXT_CONTINUATION_DENIED, {
          beadId: claimed.id,
          stateId: bead.stateId,
          contextKey: contextPolicy.contextKey,
          reason: admission.reason
        }).catch(() => {});
        this.logger.warn(Component.SUPERVISOR, 'Named-continuation admission denied — spawning fresh', {
          beadId: claimed.id,
          stateId: bead.stateId,
          contextKey: contextPolicy.contextKey,
          reason: admission.reason
        });
      } else {
        spawnContextKey = admission.sessionPath;
        isResumption = true;
        this.logger.info(Component.SUPERVISOR, 'Named-continuation admission granted — resuming session', {
          beadId: claimed.id,
          stateId: bead.stateId,
          contextKey: contextPolicy.contextKey,
          sessionPath: admission.sessionPath
        });
      }
    }
    const spawnOptions: SpawnOptions | undefined =
      spawnContextKey !== undefined
        ? { contextKey: spawnContextKey }
        : contextPolicy.producesContextKey !== undefined
          ? { persistSessionForKey: contextPolicy.producesContextKey }
          : undefined;

    const spawnStartMs = Date.now();
    const spawned = await this.factory.spawnTeammateInTmux(claimed.id, bead.stateId, worktreePath, ctx, spawnOptions);
    const spawnEndMs = Date.now();

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
      await this.beadsPort.release(claimed.id).catch(() => {});
      throw new Error(spawned.error || `Failed to spawn teammate for ${claimed.id}`);
    }

    const contextInstanceId = spawned.paneId
      ? `ctx-${claimed.id}-${bead.stateId}-${spawnStartMs}`
      : `ctx-${claimed.id}-${bead.stateId}`;
    const instanceRecord = buildContextInstanceRecord({
      contextInstanceId,
      beadId: claimed.id,
      stateId: bead.stateId,
      config,
      piSessionPath: spawnContextKey ?? spawned.piSessionPath,
      isResumption
    });
    await this.eventStore.record(DomainEventName.CONTEXT_INSTANCE_RECORDED, instanceRecord).catch(() => {});

    if (contextPolicy.producesContextKey && spawned.piSessionPath) {
      const configDigest = this.computeConfigDigest();
      const record: ContextKeyRecord = {
        piSessionPath: spawned.piSessionPath,
        beadId: claimed.id,
        sourceStateId: bead.stateId,
        sourceActionId: '',
        configDigest,
        terminal: false
      };
      this.contextKeyStore.set(contextPolicy.producesContextKey, record);
      this.logger.info(Component.SUPERVISOR, 'Stored Pi session path for named continuation (AC7 record)', {
        beadId: claimed.id,
        stateId: bead.stateId,
        producesContextKey: contextPolicy.producesContextKey,
        piSessionPath: spawned.piSessionPath,
        configDigest
      });
    }

    this.logger.info(Component.SUPERVISOR, `Teammate spawned for ${bead.id} in phase ${bead.stateId}`);
    return 'spawned';
  }
}
