/**
 * Tests for stable-block-digest-based provider prompt cache key injection.
 *
 * pi-experiment-6q0y.7: Use stable block digest as provider prompt cache key.
 *
 * These tests drive the REAL registerProviderRequestCap hook and assert the
 * injected prompt_cache_key. Every assertion is load-bearing: if the wiring
 * were absent, the cache key would be absent or wrong.
 */
import { describe, it, expect } from 'vitest';
import {
  registerProviderRequestCap,
  isOpenAIResponsesPayload,
  injectOpenAIPromptCacheKey,
  PROVIDER_CACHE_KEY_PREFIX,
  type ProviderRequestCapSession
} from '../src/extension/PiObservers.js';
import { PiEventName } from '../src/constants/infra.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal fake Pi API that captures the BEFORE_PROVIDER_REQUEST handler so
 * tests can invoke it directly without standing up the full extension.
 */
function makeFakePi() {
  const handlers: Record<string, Function> = {};
  return {
    pi: {
      on: (name: string, handler: Function) => { handlers[name] = handler; }
    } as any,
    handlers
  };
}

/** Create a minimal ProviderRequestCapSession with the given digest IDs. */
function makeSession(digestIds: string[] = []): ProviderRequestCapSession {
  return {
    providerRequestCapRegistered: false,
    recordedPromptDigestIds: new Set(digestIds)
  };
}

/** Build a minimal OpenAI Responses API payload (has `input`, no `max_tokens`). */
function makeOpenAIResponsesPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gpt-5.5',
    input: [{ role: 'user', content: 'hello' }],
    stream: true,
    prompt_cache_key: undefined,
    store: false,
    ...overrides
  };
}

/** Build a minimal OpenAI Codex payload (has `input` + `instructions`, no `max_tokens`). */
function makeCodexPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'codex-mini-latest',
    store: false,
    stream: true,
    instructions: 'You are a helpful assistant.',
    input: [{ role: 'user', content: 'hello' }],
    prompt_cache_key: undefined,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    ...overrides
  };
}

/** Build a minimal Anthropic messages payload (has `messages` + `max_tokens`). */
function makeAnthropicPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-opus-4-5',
    max_tokens: 64000,
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Unit: isOpenAIResponsesPayload
// ---------------------------------------------------------------------------

describe('isOpenAIResponsesPayload', () => {
  it('returns true for an OpenAI Responses payload (has input, no numeric max_tokens)', () => {
    expect(isOpenAIResponsesPayload(makeOpenAIResponsesPayload())).toBe(true);
  });

  it('returns true for an OpenAI Codex payload (has input + instructions)', () => {
    expect(isOpenAIResponsesPayload(makeCodexPayload())).toBe(true);
  });

  it('returns false for an Anthropic payload (has numeric max_tokens)', () => {
    expect(isOpenAIResponsesPayload(makeAnthropicPayload())).toBe(false);
  });

  it('returns false for a payload that has max_tokens=0 (numeric)', () => {
    expect(isOpenAIResponsesPayload({ input: [], max_tokens: 0 })).toBe(false);
  });

  it('returns false when input is absent', () => {
    expect(isOpenAIResponsesPayload({ model: 'gpt-5.5', messages: [] })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isOpenAIResponsesPayload(null)).toBe(false);
  });

  it('returns false for a non-object', () => {
    expect(isOpenAIResponsesPayload('not-an-object')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit: injectOpenAIPromptCacheKey
// ---------------------------------------------------------------------------

describe('injectOpenAIPromptCacheKey', () => {
  it('sets prompt_cache_key to orr-else:<digestId> and returns the payload', () => {
    const payload: Record<string, unknown> = { model: 'gpt-5.5', input: [] };
    const result = injectOpenAIPromptCacheKey(payload, 'abcd1234ef56789a');
    expect(result).toBe(payload);
    expect(payload['prompt_cache_key']).toBe('orr-else:abcd1234ef56789a');
  });

  it('returns undefined when digestId is undefined (no mutation)', () => {
    const payload: Record<string, unknown> = { model: 'gpt-5.5', input: [] };
    const result = injectOpenAIPromptCacheKey(payload, undefined);
    expect(result).toBeUndefined();
    expect(payload['prompt_cache_key']).toBeUndefined();
  });

  it('returns undefined when the key is already the correct value (idempotent)', () => {
    const digestId = 'abcd1234ef56789a';
    const key = `${PROVIDER_CACHE_KEY_PREFIX}:${digestId}`;
    const payload: Record<string, unknown> = { prompt_cache_key: key };
    expect(injectOpenAIPromptCacheKey(payload, digestId)).toBeUndefined();
    expect(payload['prompt_cache_key']).toBe(key);
  });

  it('overwrites a stale prompt_cache_key with the new digest-derived key', () => {
    const payload: Record<string, unknown> = { prompt_cache_key: 'old-volatile-session-id' };
    injectOpenAIPromptCacheKey(payload, 'abcd1234ef56789a');
    expect(payload['prompt_cache_key']).toBe('orr-else:abcd1234ef56789a');
  });
});

// ---------------------------------------------------------------------------
// Integration: registerProviderRequestCap drives the REAL hook
//
// These tests drive the actual hook handler registered by registerProviderRequestCap
// and confirm the prompt_cache_key wiring is load-bearing (would fail if not wired).
// ---------------------------------------------------------------------------

describe('registerProviderRequestCap — prompt cache key injection', () => {
  it('AC1/AC2: injects orr-else:<digestId> as prompt_cache_key on an OpenAI Responses payload', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['aabbccddeeff0011']);
    registerProviderRequestCap(pi, session);

    const payload = makeOpenAIResponsesPayload();
    const result = await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    // The hook must return the mutated payload (not undefined).
    expect(result).toBe(payload);
    // The cache key must be the stable-block-digest-derived value.
    expect(payload['prompt_cache_key']).toBe('orr-else:aabbccddeeff0011');
  });

  it('AC1/AC2: injects orr-else:<digestId> as prompt_cache_key on a Codex payload', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['abcdef1234567890']);
    registerProviderRequestCap(pi, session);

    const payload = makeCodexPayload();
    const result = await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    expect(result).toBe(payload);
    expect(payload['prompt_cache_key']).toBe('orr-else:abcdef1234567890');
  });

  it('AC2: same digest → same cache key regardless of which bead invoked it', async () => {
    // Two "runs" (different bead IDs) share the same stable block digest.
    const digestId = '1122334455667788';

    async function simulateRun(): Promise<unknown> {
      const { pi, handlers } = makeFakePi();
      const session = makeSession([digestId]);
      registerProviderRequestCap(pi, session);
      const payload = makeOpenAIResponsesPayload();
      return handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });
    }

    const resultA = await simulateRun() as Record<string, unknown>;
    const resultB = await simulateRun() as Record<string, unknown>;

    expect(resultA['prompt_cache_key']).toBe(`orr-else:${digestId}`);
    expect(resultB['prompt_cache_key']).toBe(`orr-else:${digestId}`);
    // Both runs produce the same cache key — deterministic, not volatile.
    expect(resultA['prompt_cache_key']).toBe(resultB['prompt_cache_key']);
  });

  it('AC3: different digest → different cache key', async () => {
    const digestA = 'aaaa111122223333';
    const digestB = 'bbbb444455556666';

    async function cacheKeyFor(digestId: string): Promise<unknown> {
      const { pi, handlers } = makeFakePi();
      const session = makeSession([digestId]);
      registerProviderRequestCap(pi, session);
      const payload = makeOpenAIResponsesPayload();
      await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });
      return payload['prompt_cache_key'];
    }

    expect(await cacheKeyFor(digestA)).toBe(`orr-else:${digestA}`);
    expect(await cacheKeyFor(digestB)).toBe(`orr-else:${digestB}`);
    expect(await cacheKeyFor(digestA)).not.toBe(await cacheKeyFor(digestB));
  });

  it('AC4: Anthropic payload is not mutated (max_tokens cap logic runs instead)', async () => {
    const { pi, handlers } = makeFakePi();
    // Session with a digest — should not affect Anthropic payloads.
    const session = makeSession(['digest1234567890']);
    registerProviderRequestCap(pi, session);

    // Anthropic payload with max_tokens below the cap → returns null from capAnthropicMaxTokens.
    const payload = makeAnthropicPayload({ max_tokens: 1000 });
    const result = await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    // capAnthropicMaxTokens returns null (already within cap) → hook returns undefined.
    expect(result).toBeUndefined();
    // The Anthropic payload must NOT have prompt_cache_key injected.
    expect(payload['prompt_cache_key']).toBeUndefined();
  });

  it('AC4: non-object payload is not mutated and returns undefined', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['digest1234567890']);
    registerProviderRequestCap(pi, session);

    const result = await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload: null });
    expect(result).toBeUndefined();

    const result2 = await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload: 'string' });
    expect(result2).toBeUndefined();
  });

  it('AC4: unknown object payload without `input` is not mutated', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['digest1234567890']);
    registerProviderRequestCap(pi, session);

    const payload: Record<string, unknown> = { some_other_field: 'value' };
    const result = await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    expect(result).toBeUndefined();
    expect(payload['prompt_cache_key']).toBeUndefined();
  });

  it('AC5: prompt text is byte-identical before and after the hook (no text mutation)', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['digest1234567890']);
    registerProviderRequestCap(pi, session);

    const originalInput = [
      { role: 'system', content: 'You are a planner. Stable text content goes here.' },
      { role: 'user', content: 'Task description here.' }
    ];
    const payload = makeOpenAIResponsesPayload({ input: originalInput });
    const inputBefore = JSON.stringify(payload['input']);

    await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    // The input array must be byte-identical after the hook.
    expect(JSON.stringify(payload['input'])).toBe(inputBefore);
  });

  it('uses the most-recently-added digest when the set contains multiple entries', async () => {
    // In practice recordedPromptDigestIds has one entry per run, but we test
    // that the hook picks the last (most recent) when multiple are present.
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['older1111aaaabbbb', 'newer2222ccccdddd']);
    registerProviderRequestCap(pi, session);

    const payload = makeOpenAIResponsesPayload();
    await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    expect(payload['prompt_cache_key']).toBe('orr-else:newer2222ccccdddd');
  });

  it('does not inject a cache key when no digest has been recorded yet', async () => {
    // Simulates a race where BEFORE_PROVIDER_REQUEST fires before BEFORE_AGENT_START.
    const { pi, handlers } = makeFakePi();
    const session = makeSession([]); // empty set
    registerProviderRequestCap(pi, session);

    const payload = makeOpenAIResponsesPayload();
    const result = await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    expect(result).toBeUndefined();
    // prompt_cache_key remains whatever it was (undefined in our test payload).
    expect(payload['prompt_cache_key']).toBeUndefined();
  });

  it('is idempotent: calling the hook twice with the same digest produces the same result', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['deadbeef12345678']);
    registerProviderRequestCap(pi, session);

    const payload = makeOpenAIResponsesPayload();
    await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });
    const afterFirst = payload['prompt_cache_key'];

    // Second call: key is already set — hook should return undefined (no re-mutation).
    const result2 = await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });
    expect(result2).toBeUndefined();
    expect(payload['prompt_cache_key']).toBe(afterFirst);
  });
});
