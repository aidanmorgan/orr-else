/**
 * Tests for provider-request budget preflight (pi-experiment-6q0y.16).
 *
 * AC7 requires:
 *   - Disabled-by-default: no-op when policy absent or disabled.
 *   - Enabled rejection: the REAL BEFORE_PROVIDER_REQUEST hook blocks an
 *     over-budget request before the provider is called.
 *   - Under-budget: byte-identical payloads are not rejected.
 *   - Rejection event schema validity: buildBudgetRejectionEvent produces the
 *     required fields (AC5).
 *
 * All integration tests drive the REAL registerProviderRequestCap hook via the
 * same fake-Pi pattern used by provider_cache_key.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  computeRequestSizing,
  resolveCeiling,
  checkBudgetCeilings,
  buildBudgetRejectionEvent,
  lintProviderBudgetPolicy,
  type ProviderBudgetPolicy,
  type ProviderBudgetCeiling
} from '../src/core/ProviderBudgetPreflight.js';
import {
  registerProviderRequestCap,
  type ProviderRequestCapSession
} from '../src/extension/PiObservers.js';
import { PiEventName } from '../src/constants/infra.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakePi() {
  const handlers: Record<string, Function> = {};
  return {
    pi: { on: (name: string, handler: Function) => { handlers[name] = handler; } } as any,
    handlers
  };
}

function makeSession(
  digestIds: string[] = [],
  budgetPolicy?: ProviderBudgetPolicy
): ProviderRequestCapSession {
  return {
    providerRequestCapRegistered: false,
    recordedPromptDigestIds: new Set(digestIds),
    ...(budgetPolicy !== undefined ? { providerBudgetPolicy: budgetPolicy } : {})
  };
}

/** Anthropic payload — carries max_tokens. */
function makeAnthropicPayload(maxTokens = 32000): Record<string, unknown> {
  return {
    model: 'claude-opus-4-5',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: 'hello' }],
    system: [{ type: 'text', text: 'You are a helpful assistant.' }]
  };
}

/** OpenAI Responses payload — carries `input`, no max_tokens. */
function makeOpenAIPayload(): Record<string, unknown> {
  return {
    model: 'gpt-5.5',
    input: [{ role: 'user', content: 'hello' }],
    stream: true
  };
}

// ---------------------------------------------------------------------------
// Unit: computeRequestSizing
// ---------------------------------------------------------------------------

describe('computeRequestSizing', () => {
  it('returns non-zero requestBytes for a non-empty payload', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(), 'digest-abc');
    expect(sizing.requestBytes).toBeGreaterThan(0);
  });

  it('sets provider=anthropic for a payload with numeric max_tokens', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(), undefined);
    expect(sizing.provider).toBe('anthropic');
  });

  it('sets provider=openai for a payload with `input` and no max_tokens', () => {
    const sizing = computeRequestSizing(makeOpenAIPayload(), undefined);
    expect(sizing.provider).toBe('openai');
  });

  it('sets provider=unknown for an unrecognised payload shape', () => {
    const sizing = computeRequestSizing({ some_field: 'value' }, undefined);
    expect(sizing.provider).toBe('unknown');
  });

  it('populates model from the payload', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(), undefined);
    expect(sizing.model).toBe('claude-opus-4-5');
  });

  it('sets model=unknown when the payload has no model field', () => {
    const sizing = computeRequestSizing({ input: [] }, undefined);
    expect(sizing.model).toBe('unknown');
  });

  it('reads max_tokens as requestedOutputTokens for Anthropic payloads', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(8000), undefined);
    expect(sizing.requestedOutputTokens).toBe(8000);
  });

  it('reads max_output_tokens as requestedOutputTokens for OpenAI payloads', () => {
    const payload = { model: 'gpt-5.5', input: [], max_output_tokens: 4096 };
    const sizing = computeRequestSizing(payload, undefined);
    expect(sizing.requestedOutputTokens).toBe(4096);
  });

  it('sets requestedOutputTokens=0 when neither field is present', () => {
    const sizing = computeRequestSizing(makeOpenAIPayload(), undefined);
    expect(sizing.requestedOutputTokens).toBe(0);
  });

  it('computes estimatedInputTokens = ceil(requestBytes / 4)', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(), undefined);
    expect(sizing.estimatedInputTokens).toBe(Math.ceil(sizing.requestBytes / 4));
  });

  it('computes reservedTotal = estimatedInputTokens + requestedOutputTokens', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(5000), undefined);
    expect(sizing.reservedTotal).toBe(sizing.estimatedInputTokens + sizing.requestedOutputTokens);
  });

  it('passes digestId through unchanged', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(), 'stable-digest-123');
    expect(sizing.digestId).toBe('stable-digest-123');
  });

  it('sets digestId=undefined when not provided', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(), undefined);
    expect(sizing.digestId).toBeUndefined();
  });

  it('returns a non-negative byte count for null payload (does not throw)', () => {
    // null serialises to "null" (4 bytes) — not zero, but the function does not throw.
    const sizing = computeRequestSizing(null, undefined);
    expect(sizing.requestBytes).toBeGreaterThanOrEqual(0);
  });

  it('does not store the payload body in the sizing record', () => {
    const secret = 'SUPER_SECRET_PROMPT_BODY';
    const payload = { model: 'test', input: [{ role: 'user', content: secret }] };
    const sizing = computeRequestSizing(payload, undefined);
    // The sizing record must not contain the secret body string.
    expect(JSON.stringify(sizing)).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// Unit: resolveCeiling
// ---------------------------------------------------------------------------

describe('resolveCeiling', () => {
  const policy: ProviderBudgetPolicy = {
    enabled: true,
    ceilings: {
      anthropic: { maxRequestBytes: 100000, action: 'warn' },
      'anthropic:claude-opus-4-5': { maxRequestBytes: 50000, action: 'block' },
      openai: { maxEstimatedInputTokens: 20000, action: 'warn' }
    }
  };

  it('returns the provider:model ceiling when a specific key matches', () => {
    const ceiling = resolveCeiling(policy, 'anthropic', 'claude-opus-4-5');
    expect(ceiling?.maxRequestBytes).toBe(50000);
    expect(ceiling?.action).toBe('block');
  });

  it('falls back to provider-level ceiling when no model-specific key exists', () => {
    const ceiling = resolveCeiling(policy, 'anthropic', 'claude-haiku-3-5');
    expect(ceiling?.maxRequestBytes).toBe(100000);
    expect(ceiling?.action).toBe('warn');
  });

  it('returns undefined when neither provider nor provider:model key exists', () => {
    const ceiling = resolveCeiling(policy, 'unknown', 'some-model');
    expect(ceiling).toBeUndefined();
  });

  it('returns the provider ceiling for openai', () => {
    const ceiling = resolveCeiling(policy, 'openai', 'gpt-5.5');
    expect(ceiling?.maxEstimatedInputTokens).toBe(20000);
  });
});

// ---------------------------------------------------------------------------
// Unit: checkBudgetCeilings
// ---------------------------------------------------------------------------

describe('checkBudgetCeilings', () => {
  it('returns null when all dimensions are within budget', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(1000), undefined);
    const ceiling: ProviderBudgetCeiling = {
      maxRequestBytes: 10_000_000,
      maxEstimatedInputTokens: 1_000_000,
      maxRequestedOutputTokens: 100_000,
      action: 'block'
    };
    expect(checkBudgetCeilings(sizing, ceiling)).toBeNull();
  });

  it('returns a requestBytes violation when bytes exceed the ceiling', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(), undefined);
    // Set a tiny ceiling so any real payload exceeds it.
    const ceiling: ProviderBudgetCeiling = { maxRequestBytes: 1, action: 'block' };
    const result = checkBudgetCeilings(sizing, ceiling);
    expect(result).not.toBeNull();
    expect(result?.dimension).toBe('requestBytes');
    expect(result?.actual).toBe(sizing.requestBytes);
    expect(result?.ceiling).toBe(1);
    expect(result?.action).toBe('block');
  });

  it('returns an estimatedInputTokens violation when tokens exceed the ceiling', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(), undefined);
    const ceiling: ProviderBudgetCeiling = { maxEstimatedInputTokens: 1, action: 'warn' };
    const result = checkBudgetCeilings(sizing, ceiling);
    expect(result?.dimension).toBe('estimatedInputTokens');
    expect(result?.action).toBe('warn');
  });

  it('returns a requestedOutputTokens violation when output reservation exceeds the ceiling', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(8000), undefined);
    const ceiling: ProviderBudgetCeiling = { maxRequestedOutputTokens: 100, action: 'block' };
    const result = checkBudgetCeilings(sizing, ceiling);
    expect(result?.dimension).toBe('requestedOutputTokens');
    expect(result?.actual).toBe(8000);
    expect(result?.ceiling).toBe(100);
  });

  it('prioritises requestBytes over estimatedInputTokens (first dimension checked)', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(), undefined);
    const ceiling: ProviderBudgetCeiling = {
      maxRequestBytes: 1,
      maxEstimatedInputTokens: 1,
      action: 'block'
    };
    const result = checkBudgetCeilings(sizing, ceiling);
    expect(result?.dimension).toBe('requestBytes');
  });

  it('returns null when ceiling has no limit fields at all', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(), undefined);
    // ceiling with only action set — all dimensions are unlimited
    const ceiling: ProviderBudgetCeiling = { action: 'warn' };
    expect(checkBudgetCeilings(sizing, ceiling)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit: buildBudgetRejectionEvent
// ---------------------------------------------------------------------------

describe('buildBudgetRejectionEvent', () => {
  it('AC5: produces all required fields without any request body content', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(8000), 'digest-xyz');
    const violation = { dimension: 'requestBytes' as const, actual: sizing.requestBytes, ceiling: 1, action: 'block' as const };
    const event = buildBudgetRejectionEvent(sizing, violation);

    // AC5 required fields:
    expect(event.provider).toBe('anthropic');
    expect(event.model).toBe('claude-opus-4-5');
    expect(event.digestId).toBe('digest-xyz');
    expect(event.requestBytes).toBe(sizing.requestBytes);
    expect(event.estimatedInputTokens).toBe(sizing.estimatedInputTokens);
    expect(event.requestedOutputTokens).toBe(8000);
    expect(event.reservedTotal).toBe(sizing.reservedTotal);
    expect(event.violatedDimension).toBe('requestBytes');
    expect(event.actualValue).toBe(sizing.requestBytes);
    expect(event.configuredCeiling).toBe(1);
    expect(event.action).toBe('block');
    expect(event.decision).toBe('blocked');

    // Must not carry any prompt bodies — check the entire serialised event.
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain('hello');
    expect(serialised).not.toContain('messages');
    expect(serialised).not.toContain('You are a helpful assistant');
  });

  it('sets decision=warned when action is warn', () => {
    const sizing = computeRequestSizing(makeAnthropicPayload(), undefined);
    const violation = { dimension: 'estimatedInputTokens' as const, actual: 999, ceiling: 1, action: 'warn' as const };
    const event = buildBudgetRejectionEvent(sizing, violation);
    expect(event.decision).toBe('warned');
    expect(event.action).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// Unit: lintProviderBudgetPolicy
// ---------------------------------------------------------------------------

describe('lintProviderBudgetPolicy', () => {
  it('returns no errors for a valid policy', () => {
    const policy: ProviderBudgetPolicy = {
      enabled: true,
      ceilings: {
        anthropic: { maxRequestBytes: 100000, action: 'warn' },
        'openai:gpt-5.5': { maxEstimatedInputTokens: 50000, action: 'block' }
      }
    };
    expect(lintProviderBudgetPolicy(policy)).toHaveLength(0);
  });

  it('AC6: rejects negative maxRequestBytes', () => {
    const policy: ProviderBudgetPolicy = {
      enabled: true,
      ceilings: { anthropic: { maxRequestBytes: -1, action: 'warn' } }
    };
    const errors = lintProviderBudgetPolicy(policy);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('maxRequestBytes');
    expect(errors[0]).toContain('non-negative');
  });

  it('AC6: rejects negative maxEstimatedInputTokens', () => {
    const policy: ProviderBudgetPolicy = {
      enabled: true,
      ceilings: { openai: { maxEstimatedInputTokens: -100, action: 'warn' } }
    };
    const errors = lintProviderBudgetPolicy(policy);
    expect(errors[0]).toContain('maxEstimatedInputTokens');
  });

  it('AC6: rejects negative maxRequestedOutputTokens', () => {
    const policy: ProviderBudgetPolicy = {
      enabled: true,
      ceilings: { anthropic: { maxRequestedOutputTokens: -1, action: 'block' } }
    };
    const errors = lintProviderBudgetPolicy(policy);
    expect(errors[0]).toContain('maxRequestedOutputTokens');
  });

  it('AC6: rejects unknown action values', () => {
    const policy = {
      enabled: true,
      ceilings: { anthropic: { maxRequestBytes: 100, action: 'ignore' as any } }
    };
    const errors = lintProviderBudgetPolicy(policy);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('action');
    expect(errors[0]).toContain('ignore');
  });

  it('returns no errors for an empty ceilings map', () => {
    const policy: ProviderBudgetPolicy = { enabled: false, ceilings: {} };
    expect(lintProviderBudgetPolicy(policy)).toHaveLength(0);
  });

  it('collects multiple errors from multiple ceiling keys', () => {
    const policy: ProviderBudgetPolicy = {
      enabled: true,
      ceilings: {
        anthropic: { maxRequestBytes: -1, action: 'warn' },
        openai: { maxEstimatedInputTokens: -5, action: 'block' }
      }
    };
    const errors = lintProviderBudgetPolicy(policy);
    expect(errors.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Integration: registerProviderRequestCap with budget preflight
//
// These tests drive the REAL BEFORE_PROVIDER_REQUEST hook with preflight
// ENABLED and prove a budget-exceeding request is acted on, AND prove
// default-off = no-op (AC7).
// ---------------------------------------------------------------------------

describe('registerProviderRequestCap — budget preflight integration', () => {
  // ── AC7: default-off = no-op ────────────────────────────────────────────

  it('AC7 default-off: no providerBudgetPolicy → request passes even when it would be huge', async () => {
    const { pi, handlers } = makeFakePi();
    // No providerBudgetPolicy in the session at all.
    const session = makeSession(['digest-abc']);
    registerProviderRequestCap(pi, session);

    // An Anthropic payload — the existing cap logic runs but budget preflight is absent.
    const payload = makeAnthropicPayload(32000);
    // Must not throw; must return normally.
    await expect(
      handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload })
    ).resolves.not.toThrow();
  });

  it('AC7 default-off: enabled=false → request is not rejected even when ceiling is exceeded', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['digest-abc'], {
      enabled: false,
      ceilings: {
        anthropic: { maxRequestBytes: 1, action: 'block' }
      }
    });
    registerProviderRequestCap(pi, session);

    const payload = makeAnthropicPayload(32000);
    // enabled=false → preflight disabled → no throw
    await expect(
      handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload })
    ).resolves.not.toThrow();
  });

  // ── AC4/AC7: enabled + block action → throws before provider call ───────

  it('AC4/AC7: enabled preflight BLOCKS a request that exceeds maxRequestBytes', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['digest-abc'], {
      enabled: true,
      ceilings: {
        // Set an absurdly small ceiling — any real payload will exceed it.
        anthropic: { maxRequestBytes: 1, action: 'block' }
      }
    });
    registerProviderRequestCap(pi, session);

    const payload = makeAnthropicPayload(32000);
    // The hook must throw when ceilings are exceeded with action=block.
    await expect(
      handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload })
    ).rejects.toThrow(/budget exceeded/i);
  });

  it('AC4/AC7: enabled preflight BLOCKS a request that exceeds maxRequestedOutputTokens', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['digest-xyz'], {
      enabled: true,
      ceilings: {
        anthropic: { maxRequestedOutputTokens: 100, action: 'block' }
      }
    });
    registerProviderRequestCap(pi, session);

    // Payload requests 32000 output tokens → exceeds ceiling of 100.
    const payload = makeAnthropicPayload(32000);
    await expect(
      handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload })
    ).rejects.toThrow(/budget exceeded/i);
  });

  it('AC4/AC7: enabled preflight WARNS (does not throw) when action=warn', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['digest-abc'], {
      enabled: true,
      ceilings: {
        anthropic: { maxRequestBytes: 1, action: 'warn' }
      }
    });
    registerProviderRequestCap(pi, session);

    const payload = makeAnthropicPayload(32000);
    // warn → must NOT throw; handler returns normally.
    await expect(
      handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload })
    ).resolves.not.toThrow();
  });

  // ── AC7: under-budget payloads are not rejected ─────────────────────────

  it('AC7: under-budget request is not rejected and payload is unchanged except cache metadata', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['digest-abc'], {
      enabled: true,
      ceilings: {
        // Very generous ceiling — well above any test payload.
        anthropic: { maxRequestBytes: 100_000_000, maxRequestedOutputTokens: 100_000, action: 'block' }
      }
    });
    registerProviderRequestCap(pi, session);

    const payload = makeAnthropicPayload(1000);
    const messagesBefore = JSON.stringify(payload['messages']);
    const systemBefore = JSON.stringify(payload['system']);

    // Must not throw.
    await expect(
      handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload })
    ).resolves.not.toThrow();

    // Messages are unchanged (prompt bodies are never mutated by preflight).
    expect(JSON.stringify(payload['messages'])).toBe(messagesBefore);
    // System prompt may be split by the Anthropic cache-block logic, but the
    // text content is preserved byte-for-byte across the split blocks.
    const systemAfter = payload['system'] as Array<{ text: string }>;
    if (Array.isArray(systemAfter) && systemAfter.length > 1) {
      // Reassemble — split preserves text byte-identically via '\n\n' separator.
      const reassembled = systemAfter.map(b => b.text).join('\n\n');
      const original = JSON.parse(systemBefore)[0]['text'] as string;
      expect(reassembled).toBe(original);
    }
  });

  // ── Determinism: two identical payloads produce the same accept/reject ───

  it('deterministic: same payload + same policy → same accept/reject decision', async () => {
    async function runOnce(payload: Record<string, unknown>): Promise<'ok' | 'rejected'> {
      const { pi, handlers } = makeFakePi();
      const session = makeSession(['same-digest'], {
        enabled: true,
        ceilings: {
          anthropic: { maxRequestBytes: 1, action: 'block' }
        }
      });
      registerProviderRequestCap(pi, session);
      try {
        await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });
        return 'ok';
      } catch {
        return 'rejected';
      }
    }

    const decisionA = await runOnce(makeAnthropicPayload(32000));
    const decisionB = await runOnce(makeAnthropicPayload(32000));
    expect(decisionA).toBe('rejected');
    expect(decisionB).toBe('rejected');
    expect(decisionA).toBe(decisionB);
  });

  // ── AC3: provider:model-specific ceilings ───────────────────────────────

  it('AC3: provider:model key overrides provider-level ceiling (more specific wins)', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['digest-abc'], {
      enabled: true,
      ceilings: {
        // Provider-level: generous ceiling (would pass).
        anthropic: { maxRequestBytes: 100_000_000, action: 'block' },
        // Model-specific: tiny ceiling (will block).
        'anthropic:claude-opus-4-5': { maxRequestBytes: 1, action: 'block' }
      }
    });
    registerProviderRequestCap(pi, session);

    const payload = makeAnthropicPayload(32000);
    // Model-specific ceiling should win → blocked.
    await expect(
      handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload })
    ).rejects.toThrow(/budget exceeded/i);
  });

  it('AC3: omitted ceiling for a provider means unlimited (no rejection)', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['digest-abc'], {
      enabled: true,
      ceilings: {
        // Only openai is configured; anthropic is absent → unlimited.
        openai: { maxRequestBytes: 1, action: 'block' }
      }
    });
    registerProviderRequestCap(pi, session);

    const payload = makeAnthropicPayload(32000);
    // No ceiling for anthropic → no rejection.
    await expect(
      handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload })
    ).resolves.not.toThrow();
  });
});
