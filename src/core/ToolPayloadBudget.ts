/**
 * ToolPayloadBudget — pi-experiment-6q0y.18
 *
 * Deterministic tool-result byte accounting and opt-in hard payload-budget
 * enforcement. Mirrors the shape of PromptBudgetAdmission (6q0y.17).
 *
 * DESIGN:
 *   - Policy resolution is always a no-op when no budget is configured (AC2).
 *   - When a policy IS configured and the serialized payload exceeds the limit,
 *     the caller must reject the model-facing result BEFORE returning it (AC5).
 *   - Byte counting uses serializeToolResultText() — the SAME serialization as
 *     toolResult() in extension.ts — so metered bytes exactly match the actual
 *     content[0].text Pi receives (AC1 exact-match guarantee).
 *   - No raw tool-output body appears in any event or result — only byte counts,
 *     limits, tool identity, artifact refs, and the route (AC6).
 *   - Deterministic: no Date.now() / Math.random() in the decision logic.
 *
 * POLICY RESOLUTION (AC4): per-tool > default.
 *   settings.toolPayloadBudgetByTool[toolName] takes precedence over
 *   settings.toolPayloadBudget (global default).
 *   Absent at both levels → unlimited for that result path (true no-op).
 */

import type { ToolPayloadBudgetPolicy } from './domain/StateModels.js';
import type { HarnessConfig } from './ConfigLoader.js';
import { serializeToolResultText } from './TokenUsage.js';

export type { ToolPayloadBudgetPolicy };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of tool-payload budget evaluation.
 *
 * When `exceeded` is false (or no policy is configured), the caller proceeds
 * normally. When `exceeded` is true, the caller must reject the model-facing
 * result and emit a TOOL_PAYLOAD_BUDGET_REJECTED event (AC5).
 */
export interface ToolPayloadBudgetResult {
  /**
   * The exact byte length of the model-facing serialized text.
   * Computed from serializeToolResultText() — matches content[0].text exactly (AC1).
   */
  readonly actualBytes: number;
  /**
   * The serialized string that WILL be sent to the model.
   * Stored here so the caller uses this exact string — no re-serialization drift.
   */
  readonly serializedText: string;
  /** The policy that was resolved (undefined = no policy configured). */
  readonly resolvedPolicy: ToolPayloadBudgetPolicy | undefined;
  /** True when a policy is configured AND actualBytes > limitBytes. */
  readonly exceeded: boolean;
  /** The deterministic route to use when exceeded. Undefined when not exceeded. */
  readonly route: string | undefined;
}

// ---------------------------------------------------------------------------
// Policy resolution (per-tool > default)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective tool-payload budget policy for a given tool name.
 *
 * Precedence: toolPayloadBudgetByTool[toolName] > toolPayloadBudget (default).
 * Returns undefined when no policy is configured at any level (true no-op, AC2).
 */
export function resolveToolPayloadBudgetPolicy(
  config: HarnessConfig,
  toolName: string
): ToolPayloadBudgetPolicy | undefined {
  const settings = config.settings as typeof config.settings & {
    toolPayloadBudget?: ToolPayloadBudgetPolicy;
    toolPayloadBudgetByTool?: Record<string, ToolPayloadBudgetPolicy>;
  };

  // Per-tool declaration takes precedence over the global default.
  const perTool = settings.toolPayloadBudgetByTool?.[toolName];
  if (perTool) return perTool;

  // Global default.
  return settings.toolPayloadBudget;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate tool-payload budget admission for a single tool result.
 *
 * Serializes the value to the exact model-facing text (AC1), counts the bytes,
 * and checks against the resolved policy. Returns the byte count, serialized
 * text, and whether the limit is exceeded.
 *
 * When no policy is configured, returns exceeded: false and serializedText
 * for the caller to use — guaranteed no-op (AC2).
 *
 * Deterministic: same inputs → same outputs. No Date.now()/Math.random().
 */
export function evaluateToolPayloadBudget(
  toolName: string,
  result: unknown,
  config: HarnessConfig
): ToolPayloadBudgetResult {
  const serializedText = serializeToolResultText(result);
  const actualBytes = Buffer.byteLength(serializedText, 'utf8');
  const policy = resolveToolPayloadBudgetPolicy(config, toolName);

  if (!policy) {
    return {
      actualBytes,
      serializedText,
      resolvedPolicy: undefined,
      exceeded: false,
      route: undefined,
    };
  }

  const exceeded = actualBytes > policy.maxBytes;
  return {
    actualBytes,
    serializedText,
    resolvedPolicy: policy,
    exceeded,
    route: exceeded ? policy.route : undefined,
  };
}
