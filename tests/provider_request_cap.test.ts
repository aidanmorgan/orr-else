import { describe, it, expect } from 'vitest';
import { capAnthropicMaxTokens, resolveMaxOutputTokens } from '../src/core/ProviderRequestCap.js';
import { ProviderRequestLimits } from '../src/constants/index.js';

describe('capAnthropicMaxTokens', () => {
  it('caps max_tokens above the cap and returns the mutated payload', () => {
    const payload = { model: 'claude-opus-4-5', max_tokens: 64000, messages: [] };
    const result = capAnthropicMaxTokens(payload, 32000);
    expect(result).toBe(payload);
    expect(payload.max_tokens).toBe(32000);
  });

  it('reduces an extended-thinking budget that would not fit the capped output', () => {
    const payload = {
      max_tokens: 64000,
      thinking: { type: 'enabled', budget_tokens: 60000 },
    };
    capAnthropicMaxTokens(payload, 32000, 4096);
    expect(payload.max_tokens).toBe(32000);
    // budget must stay below max_tokens (32000 - 4096 headroom).
    expect(payload.thinking.budget_tokens).toBe(32000 - 4096);
  });

  it('leaves a thinking budget that already fits within the cap', () => {
    const payload = {
      max_tokens: 64000,
      thinking: { type: 'enabled', budget_tokens: 8000 },
    };
    capAnthropicMaxTokens(payload, 32000, 4096);
    expect(payload.thinking.budget_tokens).toBe(8000);
  });

  it('returns null when max_tokens is already within the cap (no mutation)', () => {
    const payload = { max_tokens: 16000 };
    expect(capAnthropicMaxTokens(payload, 32000)).toBeNull();
    expect(payload.max_tokens).toBe(16000);
  });

  it('returns null for non-Anthropic payloads without a numeric max_tokens', () => {
    const openaiPayload = { model: 'gpt-5.5', max_output_tokens: 64000 } as Record<string, unknown>;
    expect(capAnthropicMaxTokens(openaiPayload, 32000)).toBeNull();
    expect(openaiPayload.max_output_tokens).toBe(64000);
  });

  it('returns null for null or non-object payloads', () => {
    expect(capAnthropicMaxTokens(null as unknown as { max_tokens?: unknown }, 32000)).toBeNull();
  });
});

describe('resolveMaxOutputTokens', () => {
  it('uses a positive integer override', () => {
    expect(resolveMaxOutputTokens('24000')).toBe(24000);
  });

  it('falls back to the default for undefined, empty, or invalid overrides', () => {
    const fallback = ProviderRequestLimits.ANTHROPIC_MAX_OUTPUT_TOKENS;
    expect(resolveMaxOutputTokens(undefined)).toBe(fallback);
    expect(resolveMaxOutputTokens('')).toBe(fallback);
    expect(resolveMaxOutputTokens('not-a-number')).toBe(fallback);
    expect(resolveMaxOutputTokens('-5')).toBe(fallback);
  });
});
