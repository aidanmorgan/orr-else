/**
 * Narrow port interfaces used by the Supervisor and its extracted sub-services.
 *
 * pi-experiment-amq0.2: decompose Supervisor into scheduling, spawning, recovery,
 * and retention services. Each port expresses exactly the dependency surface that
 * its consumer needs — no broad RuntimeServices bags.
 */

import type { HarnessConfig } from './ConfigLoader.js';
import type { ProjectionCapableStore } from './EventStoreTypes.js';
import type { BeadsPort, WorktreePort, TeammateSpawner } from './OrchestrationPorts.js';
import type { Clock } from './Clock.js';
import type { LoggerPort } from './Logger.js';
import type { McpBridgeHealthService } from './McpBridgeHealthService.js';

export type { ProjectionCapableStore };
export type { BeadsPort, WorktreePort, TeammateSpawner };

/**
 * Narrow config-loader surface consumed by the Supervisor and sub-services.
 * Only the two methods the Supervisor actually calls.
 */
export interface ConfigLoaderPort {
  // Accepts sync (HarnessConfig) and async (Promise<HarnessConfig>) return values
  // so that the production ConfigLoader (sync) and test fakes (async) both satisfy
  // this interface without wrapping.
  load(): HarnessConfig | Promise<HarnessConfig>;
  getConfigPath(): string;
}

/**
 * Narrow flow-manager surface consumed by the Supervisor's spawn-preflight path.
 * Only nextState() is needed for terminal-failure-limit quarantine detection.
 */
export interface FlowManagerPort {
  nextState(state: unknown, outcome: string, fallbackStateId?: string): string;
}

/**
 * Narrow services bag that replaces the full RuntimeServices in the Supervisor
 * constructor. Every field is the minimum interface the Supervisor (and its
 * injected sub-services) actually needs.
 */
export interface SupervisorServices {
  eventStore: ProjectionCapableStore;
  configLoader: ConfigLoaderPort;
  beadsPort: BeadsPort;
  worktreePort: WorktreePort;
  flowManager: FlowManagerPort;
  /** Absolute path to the project root. Used by RetentionScheduler. */
  projectRoot: string;
  /**
   * Per-runtime MCP bridge health service (amq0.3).
   * Optional for backward compat with tests that build SupervisorServices
   * without this field; BeadSpawnCoordinator will create a fresh instance
   * when not supplied.
   */
  mcpBridgeHealthService?: McpBridgeHealthService;
  /**
   * Per-runtime logger port (amq0.3).
   * Optional for backward compat; defaults to nodeLogger when not supplied.
   */
  logger?: LoggerPort;
}

/**
 * Quarantine entry for a bead whose worktree creation repeatedly fails.
 * Shared between BeadSpawnCoordinator and the Supervisor quarantine-tracking state.
 */
export interface QuarantineEntry {
  reason: string;
  signature: string;
  details?: Record<string, unknown>;
}

/**
 * Minimal interface that allows sub-services (e.g. SlotHealthMonitor,
 * BeadSpawnCoordinator) to quarantine a bead and check its quarantine status
 * without owning the quarantine map directly.
 */
export interface QuarantinePort {
  isQuarantined(bead: { id: string; status: string; lastActivity?: string }): Promise<boolean>;
  quarantineBead(
    bead: { id: string; status: string; lastActivity?: string },
    reason: string,
    details?: Record<string, unknown>
  ): Promise<void>;
}

/**
 * Bead tracking port: allows sub-services to read and modify the set of
 * beads currently tracked as "started" by the coordinator.
 */
export interface BeadTrackingPort {
  isBeadStarted(id: string): boolean;
  markBeadExited(id: string, options?: { preserveInactiveRestartBackoff?: boolean }): void;
  addStartedBead(id: string, startedAtMs: number): void;
  removeStartedBead(id: string): void;
}

/**
 * Scheduling-pause port: allows sub-services to check and set the capacity-pause state.
 */
export interface SchedulingPausePort {
  isSchedulingPaused(): boolean;
  pausedUntilIso(): string;
  schedulingPausedReason: string;
}

/**
 * Retry-budget port: allows BeadSpawnCoordinator and SlotHealthMonitor to determine
 * the correct retry budget for a given bead.
 */
export interface RetryBudgetPort {
  retryBudgetFor(beadId: string): string;
  incrementInactiveRestartCount(beadId: string): number;
  setInactiveRestartedAt(beadId: string, timestampMs: number): void;
}
