/**
 * PromptBudgetAdmission — pi-experiment-6q0y.17
 *
 * Deterministic prompt-size accounting and opt-in hard prompt-budget admission.
 *
 * DESIGN:
 *   - Computing sizes is always a no-op when no budget policy is configured (AC1).
 *   - When a policy IS configured and limits are exceeded, the admission returns
 *     `exceeded: true` with the route to use — the caller (BEFORE_AGENT_START) must
 *     then fail before issuing the first model request (AC4).
 *   - No prompt body ever appears in the result — only hashes, bytes, and token
 *     estimates from the existing hashPromptSegment() surface (AC5).
 *   - Token estimator: `Math.ceil(byteLength / TOKEN_ESTIMATE_DIVISOR)` — the same
 *     deterministic heuristic (4 chars ≈ 1 token) used throughout the harness.
 *     Deterministic: no Date.now() / Math.random(). Uses injected Clock only for
 *     event timestamps (none here — Clock is not needed in this module).
 *
 * PRECEDENCE (AC3): action > state > settings.
 *   Only the innermost declared policy is used — there is no field-level merging.
 */

import type { PromptBudgetPolicy } from './domain/StateModels.js';
import type { HarnessConfig } from './ConfigLoader.js';
import { hashPromptSegment } from './PiBasePromptAdmission.js';

export type { PromptBudgetPolicy };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Sizing measurements for all four prompt segments.
 * Contains ONLY hashes, byte counts, and token estimates — never prompt text.
 */
export interface PromptSizing {
  readonly stableBlockBytes: number;
  readonly stableBlockTokens: number;
  readonly stableBlockHash: string;
  readonly piBasePromptBytes: number;
  readonly piBasePromptTokens: number;
  readonly piBasePromptHash: string;
  readonly volatileSuffixBytes: number;
  readonly volatileSuffixTokens: number;
  readonly volatileSuffixHash: string;
  readonly finalPromptBytes: number;
  readonly finalPromptTokens: number;
  readonly finalPromptHash: string;
}

/**
 * Result of prompt-budget admission.
 *
 * When `exceeded` is false (or no policy is configured), the caller proceeds
 * normally.  When `exceeded` is true, the caller must fail the worker before
 * the first model request (AC4) and emit a PROMPT_BUDGET_ADMISSION event.
 */
export interface PromptBudgetAdmissionResult {
  /** Byte/token sizing for all four segments — always computed. */
  readonly sizing: PromptSizing;
  /** The policy that was resolved and applied (undefined = no policy configured). */
  readonly resolvedPolicy: PromptBudgetPolicy | undefined;
  /** The scope at which the policy was resolved ('action' | 'state' | 'settings'). */
  readonly limitScope: 'action' | 'state' | 'settings' | undefined;
  /** True when a policy is configured AND a limit is exceeded. AC4 trigger. */
  readonly exceeded: boolean;
  /** The deterministic route to use when exceeded. Undefined when not exceeded. */
  readonly route: string | undefined;
}

// ---------------------------------------------------------------------------
// Policy resolution (AC3: action > state > settings)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective prompt-budget policy for the current run context.
 *
 * Precedence: action > state > settings (AC3).
 * Returns undefined when no policy is configured at any scope (true no-op, AC1).
 */
export function resolvePromptBudgetPolicy(
  config: HarnessConfig,
  stateId: string | undefined,
  actionId: string | undefined
): { policy: PromptBudgetPolicy; scope: 'action' | 'state' | 'settings' } | undefined {
  // Type alias for the settings fields added by AC7(b) named-override maps.
  const settings = config.settings as typeof config.settings & {
    promptBudgetStateOverrides?: Record<string, PromptBudgetPolicy>;
    promptBudgetActionOverrides?: Record<string, PromptBudgetPolicy>;
  };

  // ── Action scope (highest precedence) ────────────────────────────────────
  // 1. Structural: action.promptBudget (direct declaration on the action).
  if (stateId && actionId) {
    const state = config.states[stateId];
    if (state) {
      const action = (state.actions || []).find(a => a.id === actionId);
      if (action?.promptBudget) {
        return { policy: action.promptBudget, scope: 'action' };
      }
    }
  }

  // 2. Named action override: settings.promptBudgetActionOverrides["stateId/actionId"]
  //    (AC7(b) — key is validated against declared states/actions at startup).
  if (stateId && actionId) {
    const actionOverride = settings.promptBudgetActionOverrides?.[`${stateId}/${actionId}`];
    if (actionOverride) {
      return { policy: actionOverride, scope: 'action' };
    }
  }

  // ── State scope ───────────────────────────────────────────────────────────
  // 3. Structural: state.promptBudget (direct declaration on the state).
  if (stateId) {
    const state = config.states[stateId];
    if (state?.promptBudget) {
      return { policy: state.promptBudget, scope: 'state' };
    }
  }

  // 4. Named state override: settings.promptBudgetStateOverrides["stateId"]
  //    (AC7(b) — key is validated against declared states at startup).
  if (stateId) {
    const stateOverride = settings.promptBudgetStateOverrides?.[stateId];
    if (stateOverride) {
      return { policy: stateOverride, scope: 'state' };
    }
  }

  // ── Settings scope (lowest precedence) ───────────────────────────────────
  // 5. Global: settings.promptBudget (applies when no state/action policy is found).
  if (config.settings.promptBudget) {
    return { policy: config.settings.promptBudget, scope: 'settings' };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Sizing computation (AC2)
// ---------------------------------------------------------------------------

/**
 * Compute byte + token estimates for all four prompt segments.
 *
 * The four segments are:
 *   1. stableBlock — the cache-eligible leading prefix assembled by buildStateSystemPrompt.
 *   2. piBasePrompt — the Pi host-supplied base system prompt (event.systemPrompt).
 *   3. volatileSuffix — beadId, workdir, run paths, checklist context.
 *   4. finalPrompt — all segments joined as: stableBlock + "\n\n" + piBase + "\n\n" + volatileSuffix
 *      (piBase omitted when absent, matching extension.ts BEFORE_AGENT_START composition).
 *
 * SAFETY: prompt texts are hashed and discarded — only hashes/sizes are kept (AC5).
 */
export function computePromptSizing(inputs: {
  stableBlock: string;
  piBasePrompt: string | undefined;
  volatileSuffix: string;
}): PromptSizing {
  const { stableBlock, piBasePrompt, volatileSuffix } = inputs;

  const stableHash = hashPromptSegment(stableBlock);
  const piHash = hashPromptSegment(piBasePrompt);
  const suffixHash = hashPromptSegment(volatileSuffix);

  const finalText = piBasePrompt
    ? `${stableBlock}\n\n${piBasePrompt}\n\n${volatileSuffix}`
    : `${stableBlock}\n\n${volatileSuffix}`;
  const finalHash = hashPromptSegment(finalText);

  return {
    stableBlockBytes: stableHash.byteLength,
    stableBlockTokens: stableHash.estimatedTokens,
    stableBlockHash: stableHash.sha256,
    piBasePromptBytes: piHash.byteLength,
    piBasePromptTokens: piHash.estimatedTokens,
    piBasePromptHash: piHash.sha256,
    volatileSuffixBytes: suffixHash.byteLength,
    volatileSuffixTokens: suffixHash.estimatedTokens,
    volatileSuffixHash: suffixHash.sha256,
    finalPromptBytes: finalHash.byteLength,
    finalPromptTokens: finalHash.estimatedTokens,
    finalPromptHash: finalHash.sha256,
  };
}

// ---------------------------------------------------------------------------
// Admission evaluation (AC4)
// ---------------------------------------------------------------------------

/**
 * Evaluate prompt-budget admission for the current run context.
 *
 * Returns the sizing measurements and whether any configured limit is exceeded.
 * When no budget policy is configured, returns `exceeded: false` and
 * `resolvedPolicy: undefined` — guaranteed no-op (AC1).
 *
 * When a policy is configured and limits are exceeded:
 *   - `exceeded` is true
 *   - `route` is the policy's deterministic route
 *
 * Byte limit and token limit are OR-evaluated: exceeding EITHER triggers rejection.
 */
export function evaluatePromptBudgetAdmission(
  sizing: PromptSizing,
  config: HarnessConfig,
  stateId: string | undefined,
  actionId: string | undefined
): PromptBudgetAdmissionResult {
  const resolved = resolvePromptBudgetPolicy(config, stateId, actionId);

  if (!resolved) {
    return {
      sizing,
      resolvedPolicy: undefined,
      limitScope: undefined,
      exceeded: false,
      route: undefined,
    };
  }

  const { policy, scope } = resolved;
  let exceeded = false;
  if (policy.maxBytes !== undefined && sizing.finalPromptBytes > policy.maxBytes) exceeded = true;
  if (policy.maxTokens !== undefined && sizing.finalPromptTokens > policy.maxTokens) exceeded = true;

  return {
    sizing,
    resolvedPolicy: policy,
    limitScope: scope,
    exceeded,
    route: exceeded ? policy.route : undefined,
  };
}
