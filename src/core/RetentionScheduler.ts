/**
 * RetentionScheduler — owns retention timing and delegates cleanup execution
 * to RetentionService.
 *
 * pi-experiment-amq0.2: extracted from Supervisor so retention logic is
 * injectable and testable in isolation.
 *
 * pi-experiment-amq0.17: repointed to construct RetentionService directly
 * (RetentionCleanup deleted — no-backcompat).
 *
 * Responsibility: decide WHEN to run retention cleanup (interval gating) and
 * supply the live bead ID set to RetentionService so running beads' artifacts
 * are never deleted. Does NOT own the cleanup logic itself (that lives in
 * RetentionService + its sub-roles).
 */

import { Logger, type LoggerPort } from './Logger.js'
import { Component, RetentionDefaults } from '../constants/infra.js';
import { RetentionService } from './retention/RetentionService.js';
import { resolveRetentionConfig } from './retention/RetentionPlanner.js';
import type { EventStore } from './EventStore.js';
import type { Clock } from './Clock.js';
import type { ConfigLoaderPort } from './SupervisorPorts.js';
import type { TeammateSpawner } from './OrchestrationPorts.js';

export class RetentionScheduler {
  private lastRetentionCleanupMs = 0;
  private readonly logger: LoggerPort;

  constructor(
    private readonly projectRoot: string,
    private readonly clock: Clock,
    /** Full EventStore (not the narrow ProjectionCapableStore) — RetentionService requires the concrete class. */
    private readonly eventStore: EventStore,
    private readonly configLoader: ConfigLoaderPort,
    private readonly factory: Pick<TeammateSpawner, 'getLiveTeammateBeadIds'>,
    logger?: LoggerPort
  ) {
    this.logger = logger ?? Logger;
  }

  /**
   * Run retention cleanup if the interval has elapsed since the last run.
   * Errors from cleanup are logged but never propagate.
   */
  async runIfDue(): Promise<void> {
    const now = this.clock.now();
    if (now - this.lastRetentionCleanupMs < RetentionDefaults.CLEANUP_INTERVAL_MS) return;
    this.lastRetentionCleanupMs = now;

    const config = await this.configLoader.load();
    const resolvedConfig = resolveRetentionConfig(
      RetentionDefaults.MAX_AGE_MS,
      config.retention
    );

    const service = new RetentionService(
      this.projectRoot,
      this.clock,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.eventStore as any,
      resolvedConfig,
      () => this.factory.getLiveTeammateBeadIds()
    );

    await service.run().catch(error => {
      this.logger.warn(Component.SUPERVISOR, 'Retention cleanup failed unexpectedly', { error: String(error) });
    });
  }
}
