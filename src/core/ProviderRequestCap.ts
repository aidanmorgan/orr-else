import { ProviderRequestLimits } from '../constants/index.js';

interface AnthropicThinking {
  type?: string;
  budget_tokens?: number;
}

export interface CappableAnthropicPayload {
  max_tokens?: unknown;
  thinking?: AnthropicThinking;
}

/**
 * Cap an Anthropic messages payload's `max_tokens` (and, when present, its
 * extended-thinking `budget_tokens`) so a single request's reservation stays
 * inside the Claude subscription's included per-request claim instead of
 * spilling to (often-disabled) overage.
 *
 * Mutates and returns the payload when a cap was applied. Returns `null` when
 * the payload is not an Anthropic-shaped request (no numeric `max_tokens`) or
 * is already at or below the cap, so callers can leave non-Anthropic provider
 * requests (e.g. OpenAI/Codex) untouched.
 */
export function capAnthropicMaxTokens<T extends CappableAnthropicPayload>(
  payload: T,
  cap: number,
  minOutputHeadroom: number = ProviderRequestLimits.ANTHROPIC_MIN_OUTPUT_HEADROOM
): T | null {
  if (!payload || typeof payload !== 'object') return null;
  const maxTokens = payload.max_tokens;
  if (typeof maxTokens !== 'number') return null;
  if (maxTokens <= cap) return null;

  payload.max_tokens = cap;

  const thinking = payload.thinking;
  if (thinking && thinking.type === 'enabled' && typeof thinking.budget_tokens === 'number') {
    const maxBudget = cap - minOutputHeadroom;
    if (thinking.budget_tokens > maxBudget) {
      thinking.budget_tokens = Math.max(ProviderRequestLimits.ANTHROPIC_MIN_THINKING_BUDGET_TOKENS, maxBudget);
    }
  }

  return payload;
}

/**
 * Resolve the configured Anthropic max-output-token cap. A positive integer in
 * the override (the `ORR_ELSE_MAX_OUTPUT_TOKENS` env value) wins; otherwise the
 * built-in default applies. Lets the cap be tuned per run without a rebuild.
 */
export function resolveMaxOutputTokens(override: string | undefined): number {
  if (override !== undefined) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return ProviderRequestLimits.ANTHROPIC_MAX_OUTPUT_TOKENS;
}
