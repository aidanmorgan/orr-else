/**
 * RuntimeBudgetTracker — pi-experiment-6q0y.48
 *
 * Optional per-bead/per-state/per-action runtime budget enforcement.
 * DISABLED BY DEFAULT — no policy configured = guaranteed no-op (AC1).
 *
 * DESIGN:
 *   - One tracker instance per worker run (created in initializeWorkerRun, cleared
 *     between runs). The tracker accumulates counters from the harness lifecycle:
 *     model calls, tokens (estimated + provider-reported), wall-clock ms (via
 *     injected Clock), retry count, per-tool failure count, verifier failure count,
 *     and tool-result payload bytes.
 *
 *   - Each dimension is checked at the REAL pre-spend hook for that dimension:
 *       model-call count / estimated input tokens / provider total tokens / wall-clock:
 *         → checked in BEFORE_PROVIDER_REQUEST (same hook as 6q0y.17 prompt budget).
 *       retry count: → checked in wrapPluginTool before evaluateRetry (retry loop).
 *       per-tool failure count / tool-result payload bytes:
 *         → checked in wrapPluginTool (same path as 6q0y.18 payload budget).
 *       verifier failure count: → checked in CoordinatorVerifierGate hook.
 *
 *   - Policy resolution (AC2): action > state > settings (mirrors 6q0y.17/.18).
 *     Absent at all scopes = zero configured budgets (true no-op, AC1).
 *
 *   - When a limit is exceeded, the tracker returns the configured route so the
 *     caller can fail BEFORE the next spend and drive the deterministic outcome
 *     via postWorkerSignal (same mechanism as 6q0y.17, AC4).
 *
 *   - Budget decision events (AC5): carry budgetId, dimension, currentValue,
 *     limit, stateId, actionId, beadId, nextRoute — NO prompt or raw tool output.
 *
 *   - Deterministic: no Date.now() / Math.random() in decision logic. Wall-clock
 *     is read from the injected Clock (fake clock in tests, AC7).
 */

import type { Clock } from './Clock.js';
import type { RuntimeBudgetPolicy } from './domain/StateModels.js';
import type { HarnessConfig } from './ConfigLoader.js';
import type { EventStore } from './EventStore.js';
import { DomainEventName } from '../constants/index.js';

export type { RuntimeBudgetPolicy };

// ---------------------------------------------------------------------------
// Dimension names (AC3)
// ---------------------------------------------------------------------------

/**
 * Enumeration of all metered dimensions (AC3).
 * Each dimension maps to one configurable limit in RuntimeBudgetPolicy.
 */
export type RuntimeBudgetDimension =
  | 'modelCallCount'
  | 'estimatedInputTokens'
  | 'providerTotalTokens'
  | 'wallClockMs'
  | 'retryCount'
  | 'toolFailureCount'
  | 'verifierFailureCount'
  | 'toolPayloadBytes';

// ---------------------------------------------------------------------------
// Check result
// ---------------------------------------------------------------------------

/**
 * Result of a runtime budget check.
 *
 * When `exceeded` is false the caller proceeds normally (no-op).
 * When `exceeded` is true, the caller must fail before the next spend and
 * route through `route` (AC4).
 */
export interface RuntimeBudgetCheckResult {
  exceeded: boolean;
  /** Violated dimension — undefined when not exceeded. */
  dimension: RuntimeBudgetDimension | undefined;
  /** Current accumulated value — undefined when not exceeded. */
  currentValue: number | undefined;
  /** Configured limit — undefined when not exceeded. */
  limit: number | undefined;
  /** Deterministic route to use when exceeded. Undefined when not exceeded. */
  route: string | undefined;
  /** Budget ID for event tracing — undefined when not exceeded. */
  budgetId: string | undefined;
}

/** The exceeded=false sentinel — used by all no-op returns. */
const NOT_EXCEEDED: RuntimeBudgetCheckResult = {
  exceeded: false,
  dimension: undefined,
  currentValue: undefined,
  limit: undefined,
  route: undefined,
  budgetId: undefined,
};

// ---------------------------------------------------------------------------
// Accumulated counters (mutable, per worker run)
// ---------------------------------------------------------------------------

interface Counters {
  modelCallCount: number;
  estimatedInputTokens: number;
  providerTotalTokens: number;
  wallClockStartMs: number;  // set at tracker creation (run start)
  retryCount: number;
  toolFailureCount: number;
  verifierFailureCount: number;
  toolPayloadBytes: number;
}

// ---------------------------------------------------------------------------
// Policy resolution (AC2: action > state > settings)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective runtime-budget policy for the current run context.
 *
 * Precedence: action > state > settings (AC2).
 * Returns undefined when no policy is configured at any scope (true no-op, AC1).
 */
export function resolveRuntimeBudgetPolicy(
  config: HarnessConfig,
  stateId: string | undefined,
  actionId: string | undefined
): { policy: RuntimeBudgetPolicy; scope: 'action' | 'state' | 'settings'; budgetId: string } | undefined {
  const settings = config.settings as typeof config.settings & {
    runtimeBudget?: RuntimeBudgetPolicy;
  };

  // ── Action scope (highest precedence) ────────────────────────────────────
  if (stateId && actionId) {
    const state = config.states[stateId];
    if (state) {
      const action = (state.actions || []).find(a => a.id === actionId);
      const actionPolicy = (action as { runtimeBudget?: RuntimeBudgetPolicy } | undefined)?.runtimeBudget;
      if (actionPolicy) {
        return { policy: actionPolicy, scope: 'action', budgetId: `action:${stateId}/${actionId}` };
      }
    }
  }

  // ── State scope ───────────────────────────────────────────────────────────
  if (stateId) {
    const state = config.states[stateId];
    const statePolicy = (state as { runtimeBudget?: RuntimeBudgetPolicy } | undefined)?.runtimeBudget;
    if (statePolicy) {
      return { policy: statePolicy, scope: 'state', budgetId: `state:${stateId}` };
    }
  }

  // ── Settings scope (lowest precedence) ───────────────────────────────────
  if (settings.runtimeBudget) {
    return { policy: settings.runtimeBudget, scope: 'settings', budgetId: 'settings' };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// RuntimeBudgetTracker class
// ---------------------------------------------------------------------------

/**
 * Per-worker-run runtime budget accumulator and enforcement gate.
 *
 * Lifecycle:
 *   1. Created at initializeWorkerRun (or the first BEFORE_PROVIDER_REQUEST
 *      that finds a policy configured).
 *   2. Fed by the harness lifecycle (model calls, tokens, wall-clock, etc.).
 *   3. Checked at real pre-spend hooks (BEFORE_PROVIDER_REQUEST, retry loop,
 *      wrapPluginTool, verifier gate).
 *   4. Discarded at session teardown or next run initialization.
 *
 * AC1: when no policy is configured, check() always returns NOT_EXCEEDED.
 * AC7: wall-clock reads the injected Clock — deterministic in tests.
 */
export class RuntimeBudgetTracker {
  private readonly counters: Counters;
  private readonly policy: RuntimeBudgetPolicy;
  private readonly budgetId: string;
  private readonly beadId: string | undefined;
  private readonly stateId: string | undefined;
  private readonly actionId: string | undefined;
  private readonly clock: Clock;

  constructor(opts: {
    policy: RuntimeBudgetPolicy;
    budgetId: string;
    beadId: string | undefined;
    stateId: string | undefined;
    actionId: string | undefined;
    clock: Clock;
  }) {
    this.policy = opts.policy;
    this.budgetId = opts.budgetId;
    this.beadId = opts.beadId;
    this.stateId = opts.stateId;
    this.actionId = opts.actionId;
    this.clock = opts.clock;
    this.counters = {
      modelCallCount: 0,
      estimatedInputTokens: 0,
      providerTotalTokens: 0,
      wallClockStartMs: this.clock.now(),
      retryCount: 0,
      toolFailureCount: 0,
      verifierFailureCount: 0,
      toolPayloadBytes: 0,
    };
  }

  // ── Accumulation methods (called from lifecycle hooks) ────────────────────

  /** Called at each model-call pre-spend (BEFORE_PROVIDER_REQUEST) to count the call. */
  recordModelCall(): void {
    this.counters.modelCallCount += 1;
  }

  /** Accumulate estimated input tokens (call before counting the model call). */
  recordEstimatedInputTokens(tokens: number): void {
    this.counters.estimatedInputTokens += tokens;
  }

  /** Accumulate provider-reported total tokens (from TOKEN_USAGE_RECORDED / TURN_END). */
  recordProviderTotalTokens(tokens: number): void {
    this.counters.providerTotalTokens += tokens;
  }

  /** Increment retry count (called before admitting a retry). */
  recordRetry(): void {
    this.counters.retryCount += 1;
  }

  /** Increment tool failure count (called after a tool invocation fails). */
  recordToolFailure(): void {
    this.counters.toolFailureCount += 1;
  }

  /** Increment verifier failure count (called after a verifier gate rejects). */
  recordVerifierFailure(): void {
    this.counters.verifierFailureCount += 1;
  }

  /** Accumulate tool-result payload bytes (called after each tool result). */
  recordToolPayloadBytes(bytes: number): void {
    this.counters.toolPayloadBytes += bytes;
  }

  // ── Check methods (called at real pre-spend hooks) ────────────────────────

  /**
   * Check all limits applicable to a pre-provider-request context:
   *   - modelCallCount (BEFORE recording the current call)
   *   - estimatedInputTokens
   *   - providerTotalTokens
   *   - wallClockMs
   *
   * Returns the first exceeded dimension, or NOT_EXCEEDED.
   * NOTE: the caller should call recordModelCall() AFTER this check passes.
   */
  checkPreProviderRequest(): RuntimeBudgetCheckResult {
    const p = this.policy;
    const c = this.counters;

    // model-call count: check BEFORE counting the call
    if (p.maxModelCalls !== undefined && c.modelCallCount >= p.maxModelCalls) {
      return this.buildResult('modelCallCount', c.modelCallCount, p.maxModelCalls, p.route);
    }

    // estimated input tokens accumulated so far
    if (p.maxEstimatedInputTokens !== undefined && c.estimatedInputTokens >= p.maxEstimatedInputTokens) {
      return this.buildResult('estimatedInputTokens', c.estimatedInputTokens, p.maxEstimatedInputTokens, p.route);
    }

    // provider total tokens accumulated so far
    if (p.maxProviderTotalTokens !== undefined && c.providerTotalTokens >= p.maxProviderTotalTokens) {
      return this.buildResult('providerTotalTokens', c.providerTotalTokens, p.maxProviderTotalTokens, p.route);
    }

    // wall-clock milliseconds elapsed since run start
    const elapsedMs = this.clock.now() - c.wallClockStartMs;
    if (p.maxWallClockMs !== undefined && elapsedMs >= p.maxWallClockMs) {
      return this.buildResult('wallClockMs', elapsedMs, p.maxWallClockMs, p.route);
    }

    return NOT_EXCEEDED;
  }

  /**
   * Check the retry count limit BEFORE admitting a retry.
   * Called from wrapPluginTool before evaluateRetry.
   */
  checkPreRetry(): RuntimeBudgetCheckResult {
    const p = this.policy;
    const c = this.counters;
    if (p.maxRetries !== undefined && c.retryCount >= p.maxRetries) {
      return this.buildResult('retryCount', c.retryCount, p.maxRetries, p.route);
    }
    return NOT_EXCEEDED;
  }

  /**
   * Check the per-tool failure count and tool-payload bytes limits.
   * Called from wrapPluginTool after a tool failure / before payload return.
   */
  checkPreToolResult(opts: { toolFailures?: boolean; payloadBytes?: number }): RuntimeBudgetCheckResult {
    const p = this.policy;
    const c = this.counters;

    if (opts.toolFailures && p.maxToolFailures !== undefined && c.toolFailureCount >= p.maxToolFailures) {
      return this.buildResult('toolFailureCount', c.toolFailureCount, p.maxToolFailures, p.route);
    }

    if (opts.payloadBytes !== undefined && p.maxToolPayloadBytes !== undefined &&
        c.toolPayloadBytes + opts.payloadBytes > p.maxToolPayloadBytes) {
      const projected = c.toolPayloadBytes + opts.payloadBytes;
      return this.buildResult('toolPayloadBytes', projected, p.maxToolPayloadBytes, p.route);
    }

    return NOT_EXCEEDED;
  }

  /**
   * Check the verifier failure count limit BEFORE the verifier gate runs.
   */
  checkPreVerifier(): RuntimeBudgetCheckResult {
    const p = this.policy;
    const c = this.counters;
    if (p.maxVerifierFailures !== undefined && c.verifierFailureCount >= p.maxVerifierFailures) {
      return this.buildResult('verifierFailureCount', c.verifierFailureCount, p.maxVerifierFailures, p.route);
    }
    return NOT_EXCEEDED;
  }

  // ── Event emission ────────────────────────────────────────────────────────

  /**
   * Emit a RUNTIME_BUDGET_EXCEEDED event. Fire-and-forget — never throws.
   * Carries only structured identity fields + dimension info — no prompt body
   * or raw tool output (AC5).
   */
  async emitExceededEvent(
    result: RuntimeBudgetCheckResult,
    eventStore: EventStore
  ): Promise<void> {
    if (!result.exceeded) return;
    await eventStore.record(DomainEventName.RUNTIME_BUDGET_EXCEEDED, {
      budgetId: result.budgetId,
      dimension: result.dimension,
      currentValue: result.currentValue,
      limit: result.limit,
      beadId: this.beadId,
      stateId: this.stateId,
      actionId: this.actionId,
      nextRoute: result.route,
    }).catch(() => {
      // Fire-and-forget: event emission failure must never block enforcement.
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private buildResult(
    dimension: RuntimeBudgetDimension,
    currentValue: number,
    limit: number,
    route: string
  ): RuntimeBudgetCheckResult {
    return {
      exceeded: true,
      dimension,
      currentValue,
      limit,
      route,
      budgetId: this.budgetId,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory helper (used in extension.ts)
// ---------------------------------------------------------------------------

/**
 * Create a RuntimeBudgetTracker for the current run, or return null when no
 * policy is configured at any scope (true no-op, AC1).
 */
export function createRuntimeBudgetTracker(
  config: HarnessConfig,
  context: {
    beadId: string | undefined;
    stateId: string | undefined;
    actionId: string | undefined;
    clock: Clock;
  }
): RuntimeBudgetTracker | null {
  const resolved = resolveRuntimeBudgetPolicy(config, context.stateId, context.actionId);
  if (!resolved) return null;
  return new RuntimeBudgetTracker({
    policy: resolved.policy,
    budgetId: resolved.budgetId,
    beadId: context.beadId,
    stateId: context.stateId,
    actionId: context.actionId,
    clock: context.clock,
  });
}
