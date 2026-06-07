/**
 * Tests for Anthropic system cache-block split at the Orr Else stable boundary.
 *
 * pi-experiment-6q0y.8: Split Anthropic system cache block at the Orr Else stable boundary.
 *
 * Every assertion is load-bearing: if the split were absent, the cache-controlled
 * block would contain volatile content (beadId, worktreePath, checklist) that
 * changes per run, defeating prompt cache reuse.
 */
import { describe, it, expect } from 'vitest';
import {
  registerProviderRequestCap,
  extractSingleAnthropicSystemBlock,
  splitAnthropicSystemCacheBlock,
  ANTHROPIC_VOLATILE_BOUNDARY,
  type ProviderRequestCapSession
} from '../src/extension/PiObservers.js';
import { PiEventName } from '../src/constants/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal fake Pi API that captures BEFORE_PROVIDER_REQUEST so tests can invoke
 * the real handler without standing up the full extension.
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

function makeSession(digestIds: string[] = []): ProviderRequestCapSession {
  return {
    providerRequestCapRegistered: false,
    recordedPromptDigestIds: new Set(digestIds)
  };
}

/**
 * Build a representative stable block that ContextInjector would produce.
 * Contains no bead ID, worktree path, or checklist.
 */
function makeStableBlock(): string {
  return [
    '### SYSTEM CONTEXT',
    'PROJECT_ROOT: /home/user/project',
    'CONFIG_PATH: /home/user/project/harness.yaml',
    'PHASE: implement',
    'STATE_IDENTITY: worker',
    '',
    '### ROLE INSTRUCTIONS',
    'You are a coding agent. Follow the project rules carefully.'
  ].join('\n');
}

/**
 * Build a representative volatile suffix that ContextInjector appends after the
 * stable block.  Always starts with "### RUN CONTEXT\nBEAD_ID: ...".
 */
function makeVolatileSuffix(beadId = 'pi-experiment-abc1.2', workdir = '/home/user/project-wt/abc1.2'): string {
  return [
    '### RUN CONTEXT',
    `BEAD_ID: ${beadId}`,
    `WORKING_DIRECTORY: ${workdir}`,
    '',
    '### OUTSTANDING CHECKLIST',
    '- [ ] Implement feature X',
    '- [ ] Write tests'
  ].join('\n');
}

/**
 * Build a fully assembled system prompt matching ContextInjector's output:
 *   stableBlock + "\n\n" + volatileSuffix
 */
function makeAssembledPrompt(stableBlock = makeStableBlock(), volatileSuffix = makeVolatileSuffix()): string {
  return `${stableBlock}\n\n${volatileSuffix}`;
}

/**
 * Build a minimal Anthropic payload with a single system text block.
 * The provider places the fully assembled prompt in this single block with
 * cache_control already applied.
 */
function makeAnthropicPayload(
  systemText: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    model: 'claude-opus-4-5',
    max_tokens: 1000,
    messages: [{ role: 'user', content: 'hello' }],
    system: [
      {
        type: 'text',
        text: systemText,
        cache_control: { type: 'ephemeral' }
      }
    ],
    ...overrides
  };
}

/**
 * Build a minimal OpenAI Responses payload (has `input`, no `max_tokens`).
 * Used to confirm non-Anthropic payloads are not mutated.
 */
function makeOpenAIPayload(): Record<string, unknown> {
  return {
    model: 'gpt-5.5',
    input: [{ role: 'user', content: 'hello' }],
    stream: true,
    store: false
  };
}

// ---------------------------------------------------------------------------
// Unit: extractSingleAnthropicSystemBlock
// ---------------------------------------------------------------------------

describe('extractSingleAnthropicSystemBlock', () => {
  it('returns the block when system has exactly one text block', () => {
    const payload = makeAnthropicPayload('some text');
    const block = extractSingleAnthropicSystemBlock(payload);
    expect(block).not.toBeNull();
    expect(block!.type).toBe('text');
    expect(block!.text).toBe('some text');
  });

  it('returns null for null payload', () => {
    expect(extractSingleAnthropicSystemBlock(null)).toBeNull();
  });

  it('returns null for non-object', () => {
    expect(extractSingleAnthropicSystemBlock('string')).toBeNull();
  });

  it('returns null when max_tokens is absent (non-Anthropic)', () => {
    const payload = { input: [{ role: 'user', content: 'hi' }], system: [{ type: 'text', text: 'hello' }] };
    expect(extractSingleAnthropicSystemBlock(payload)).toBeNull();
  });

  it('returns null when system is absent', () => {
    const payload = { max_tokens: 1000, messages: [] };
    expect(extractSingleAnthropicSystemBlock(payload)).toBeNull();
  });

  it('returns null when system has more than one block', () => {
    const payload = {
      max_tokens: 1000,
      system: [
        { type: 'text', text: 'block one' },
        { type: 'text', text: 'block two' }
      ]
    };
    expect(extractSingleAnthropicSystemBlock(payload)).toBeNull();
  });

  it('returns null when system has zero blocks', () => {
    const payload = { max_tokens: 1000, system: [] };
    expect(extractSingleAnthropicSystemBlock(payload)).toBeNull();
  });

  it('returns null when system is not an array', () => {
    const payload = { max_tokens: 1000, system: 'plain string system prompt' };
    expect(extractSingleAnthropicSystemBlock(payload)).toBeNull();
  });

  it('returns null when the block type is not "text"', () => {
    const payload = {
      max_tokens: 1000,
      system: [{ type: 'image', source: {} }]
    };
    expect(extractSingleAnthropicSystemBlock(payload)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit: splitAnthropicSystemCacheBlock
// ---------------------------------------------------------------------------

describe('splitAnthropicSystemCacheBlock', () => {
  it('AC1: splits a single system block into two when the boundary is found', () => {
    const assembled = makeAssembledPrompt();
    const payload = makeAnthropicPayload(assembled);

    const result = splitAnthropicSystemCacheBlock(payload);

    expect(result).not.toBeNull();
    const system = (result as Record<string, unknown>)['system'] as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
  });

  it('AC1: block 0 text equals the stable block (no volatile content)', () => {
    const stable = makeStableBlock();
    const volatile = makeVolatileSuffix();
    const payload = makeAnthropicPayload(`${stable}\n\n${volatile}`);

    splitAnthropicSystemCacheBlock(payload);

    const system = payload['system'] as Array<Record<string, unknown>>;
    expect(system[0]['text']).toBe(stable);
  });

  it('AC1: block 1 text starts with "### RUN CONTEXT" (the volatile marker)', () => {
    const assembled = makeAssembledPrompt();
    const payload = makeAnthropicPayload(assembled);

    splitAnthropicSystemCacheBlock(payload);

    const system = payload['system'] as Array<Record<string, unknown>>;
    const block1Text = system[1]['text'] as string;
    expect(block1Text.startsWith('### RUN CONTEXT')).toBe(true);
  });

  it('AC2: only block 0 carries cache_control; block 1 has none', () => {
    const payload = makeAnthropicPayload(makeAssembledPrompt());

    splitAnthropicSystemCacheBlock(payload);

    const system = payload['system'] as Array<Record<string, unknown>>;
    expect(system[0]['cache_control']).toEqual({ type: 'ephemeral' });
    expect(system[1]['cache_control']).toBeUndefined();
  });

  it('AC3: block texts joined with "\\n\\n" reproduce the original byte-for-byte', () => {
    const original = makeAssembledPrompt();
    const payload = makeAnthropicPayload(original);

    splitAnthropicSystemCacheBlock(payload);

    const system = payload['system'] as Array<Record<string, unknown>>;
    const roundTrip = `${system[0]['text']}\n\n${system[1]['text']}`;
    expect(roundTrip).toBe(original);
  });

  it('AC4: block 0 (cache-controlled) does not contain the bead ID', () => {
    const beadId = 'pi-experiment-6q0y.8';
    const workdir = '/Users/aidan/dev/pi-experiment-wt/6q0y.8';
    const payload = makeAnthropicPayload(makeAssembledPrompt(makeStableBlock(), makeVolatileSuffix(beadId, workdir)));

    splitAnthropicSystemCacheBlock(payload);

    const system = payload['system'] as Array<Record<string, unknown>>;
    const stableText = system[0]['text'] as string;
    expect(stableText).not.toContain(beadId);
  });

  it('AC4: block 0 (cache-controlled) does not contain the worktree path', () => {
    const beadId = 'pi-experiment-6q0y.8';
    const workdir = '/Users/aidan/dev/pi-experiment-wt/6q0y.8';
    const payload = makeAnthropicPayload(makeAssembledPrompt(makeStableBlock(), makeVolatileSuffix(beadId, workdir)));

    splitAnthropicSystemCacheBlock(payload);

    const system = payload['system'] as Array<Record<string, unknown>>;
    const stableText = system[0]['text'] as string;
    expect(stableText).not.toContain(workdir);
  });

  it('AC4: block 0 (cache-controlled) does not contain checklist text', () => {
    const checklist = '- [ ] Implement feature X';
    const volatileWithChecklist = `### RUN CONTEXT\nBEAD_ID: test-bead\nWORKING_DIRECTORY: /tmp/wt\n\n### OUTSTANDING CHECKLIST\n${checklist}`;
    const payload = makeAnthropicPayload(`${makeStableBlock()}\n\n${volatileWithChecklist}`);

    splitAnthropicSystemCacheBlock(payload);

    const system = payload['system'] as Array<Record<string, unknown>>;
    const stableText = system[0]['text'] as string;
    expect(stableText).not.toContain(checklist);
  });

  it('returns null when no boundary is found (no volatile suffix)', () => {
    const payload = makeAnthropicPayload('Only stable text here — no RUN CONTEXT section.');
    expect(splitAnthropicSystemCacheBlock(payload)).toBeNull();
  });

  it('returns null when multi-block system has no block containing the boundary', () => {
    // Neither block contains '\n\n### RUN CONTEXT', so no split is possible.
    const payload: Record<string, unknown> = {
      max_tokens: 1000,
      system: [
        { type: 'text', text: 'block one', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'block two' }
      ]
    };
    expect(splitAnthropicSystemCacheBlock(payload)).toBeNull();
  });

  it('returns null for an OpenAI payload (no max_tokens)', () => {
    const payload = makeOpenAIPayload();
    expect(splitAnthropicSystemCacheBlock(payload)).toBeNull();
  });

  it('returns null for null', () => {
    expect(splitAnthropicSystemCacheBlock(null)).toBeNull();
  });

  it('preserves cache_control from the original block on block 0', () => {
    const customCacheControl = { type: 'ephemeral', ttl: '1h' };
    const payload: Record<string, unknown> = {
      max_tokens: 1000,
      system: [{ type: 'text', text: makeAssembledPrompt(), cache_control: customCacheControl }]
    };

    splitAnthropicSystemCacheBlock(payload);

    const system = payload['system'] as Array<Record<string, unknown>>;
    expect(system[0]['cache_control']).toEqual(customCacheControl);
  });

  it('splits correctly when a piBase block appears between stable and volatile', () => {
    // Assembled prompt: stableBlock + "\n\n" + piBase + "\n\n" + volatileSuffix
    const stable = makeStableBlock();
    const piBase = 'You are Claude Code, running in Pi.\nToday: 2026-06-07\nCWD: /home/user/project';
    const volatile = makeVolatileSuffix('pi-experiment-6q0y.8', '/home/user/project-wt/6q0y.8');
    const assembled = `${stable}\n\n${piBase}\n\n${volatile}`;
    const payload = makeAnthropicPayload(assembled);

    splitAnthropicSystemCacheBlock(payload);

    const system = payload['system'] as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    // Block 0 contains stable + piBase (everything before \n\n### RUN CONTEXT).
    expect(system[0]['text']).toBe(`${stable}\n\n${piBase}`);
    // Block 1 starts with the volatile suffix.
    expect((system[1]['text'] as string).startsWith('### RUN CONTEXT')).toBe(true);
    // Round-trip
    expect(`${system[0]['text']}\n\n${system[1]['text']}`).toBe(assembled);
  });

  // OAuth shape: system = [identity block, harness prompt block]
  // This is what @earendil-works/pi-ai anthropic.js buildParams produces under OAuth.
  // The harness systemPrompt (last block) contains the boundary; identity block must be preserved.
  it('OAuth shape: splits the boundary-containing block while preserving the identity block', () => {
    const harnessSuffix = makeVolatileSuffix('pi-experiment-6q0y.8', '/Users/aidan/dev/pi-experiment-wt/6q0y.8');
    const harnessText = `${makeStableBlock()}\n\n${harnessSuffix}`;
    const identityText = 'You are Claude Code, Anthropic\'s official CLI for Claude.';

    const payload: Record<string, unknown> = {
      model: 'claude-opus-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'hello' }],
      system: [
        { type: 'text', text: identityText, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: harnessText, cache_control: { type: 'ephemeral' } }
      ]
    };

    const result = splitAnthropicSystemCacheBlock(payload);

    // Split occurred.
    expect(result).not.toBeNull();
    const system = payload['system'] as Array<Record<string, unknown>>;
    // Original 2-block system becomes 3 blocks (identity + stable + volatile).
    expect(system).toHaveLength(3);

    // Block 0: identity block preserved unchanged with its cache_control.
    expect(system[0]['text']).toBe(identityText);
    expect(system[0]['cache_control']).toEqual({ type: 'ephemeral' });

    // Block 1: stable portion of harness prompt, cache_control kept.
    expect(system[1]['text']).toBe(makeStableBlock());
    expect(system[1]['cache_control']).toEqual({ type: 'ephemeral' });
    // Must not contain volatile content.
    expect(system[1]['text'] as string).not.toContain('pi-experiment-6q0y.8');
    expect(system[1]['text'] as string).not.toContain('/Users/aidan/dev/pi-experiment-wt/6q0y.8');

    // Block 2: volatile portion, NO cache_control.
    expect((system[2]['text'] as string).startsWith('### RUN CONTEXT')).toBe(true);
    expect(system[2]['cache_control']).toBeUndefined();
    expect(system[2]['text'] as string).toContain('pi-experiment-6q0y.8');

    // Round-trip: stable + '\n\n' + volatile === original harness block text.
    expect(`${system[1]['text']}\n\n${system[2]['text']}`).toBe(harnessText);
  });
});

// ---------------------------------------------------------------------------
// ANTHROPIC_VOLATILE_BOUNDARY constant
// ---------------------------------------------------------------------------

describe('ANTHROPIC_VOLATILE_BOUNDARY', () => {
  it('equals "\\n\\n### RUN CONTEXT"', () => {
    expect(ANTHROPIC_VOLATILE_BOUNDARY).toBe('\n\n### RUN CONTEXT');
  });
});

// ---------------------------------------------------------------------------
// Integration: registerProviderRequestCap drives the REAL hook
// ---------------------------------------------------------------------------

describe('registerProviderRequestCap — Anthropic system cache-block split', () => {
  it('AC1/AC2: splits system into [stable+cache_control, volatile+none] via the real hook', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['aabbccddeeff0011']);
    registerProviderRequestCap(pi, session);

    const assembled = makeAssembledPrompt();
    const payload = makeAnthropicPayload(assembled);
    const result = await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    // The hook must return the mutated payload.
    expect(result).toBe(payload);
    const system = payload['system'] as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    expect(system[0]['cache_control']).toEqual({ type: 'ephemeral' });
    expect(system[1]['cache_control']).toBeUndefined();
  });

  it('AC3: round-trip reproduces original system text byte-for-byte via the real hook', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['aabbccddeeff0011']);
    registerProviderRequestCap(pi, session);

    const original = makeAssembledPrompt();
    const payload = makeAnthropicPayload(original);
    await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    const system = payload['system'] as Array<Record<string, unknown>>;
    const roundTrip = `${system[0]['text']}\n\n${system[1]['text']}`;
    expect(roundTrip).toBe(original);
  });

  it('AC4: bead ID is absent from every cache-controlled block via the real hook', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['aabbccddeeff0011']);
    registerProviderRequestCap(pi, session);

    const beadId = 'pi-experiment-6q0y.8';
    const workdir = '/Users/aidan/dev/pi-experiment-wt/6q0y.8';
    const payload = makeAnthropicPayload(
      makeAssembledPrompt(makeStableBlock(), makeVolatileSuffix(beadId, workdir))
    );
    await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    const system = payload['system'] as Array<Record<string, unknown>>;
    for (const block of system) {
      if (block['cache_control']) {
        expect(block['text']).not.toContain(beadId);
      }
    }
  });

  it('AC4: worktree path is absent from every cache-controlled block via the real hook', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['aabbccddeeff0011']);
    registerProviderRequestCap(pi, session);

    const beadId = 'pi-experiment-6q0y.8';
    const workdir = '/Users/aidan/dev/pi-experiment-wt/6q0y.8';
    const payload = makeAnthropicPayload(
      makeAssembledPrompt(makeStableBlock(), makeVolatileSuffix(beadId, workdir))
    );
    await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    const system = payload['system'] as Array<Record<string, unknown>>;
    for (const block of system) {
      if (block['cache_control']) {
        expect(block['text']).not.toContain(workdir);
      }
    }
  });

  it('AC4: checklist text is absent from every cache-controlled block via the real hook', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['aabbccddeeff0011']);
    registerProviderRequestCap(pi, session);

    const checklist = '- [ ] Some checklist item that is very specific';
    const volatileWithChecklist = `### RUN CONTEXT\nBEAD_ID: test-bead\nWORKING_DIRECTORY: /tmp/wt\n\n### OUTSTANDING CHECKLIST\n${checklist}`;
    const payload = makeAnthropicPayload(`${makeStableBlock()}\n\n${volatileWithChecklist}`);
    await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    const system = payload['system'] as Array<Record<string, unknown>>;
    for (const block of system) {
      if (block['cache_control']) {
        expect(block['text']).not.toContain(checklist);
      }
    }
  });

  it('AC5 non-Anthropic: OpenAI Responses payload is not mutated by the system split', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['aabbccddeeff0011']);
    registerProviderRequestCap(pi, session);

    const payload = makeOpenAIPayload();
    const systemBefore = JSON.stringify(payload['system']);

    await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    // system was undefined before; must still be undefined (prompt_cache_key injected instead).
    expect(JSON.stringify(payload['system'])).toBe(systemBefore);
    // OpenAI path: prompt_cache_key injected, no system split.
    expect(payload['prompt_cache_key']).toBe('orr-else:aabbccddeeff0011');
  });

  it('Anthropic without boundary: returns undefined when no volatile suffix present', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['aabbccddeeff0011']);
    registerProviderRequestCap(pi, session);

    // Anthropic payload with system text that has no '### RUN CONTEXT' boundary.
    const payload = makeAnthropicPayload('Stable-only text. No volatile boundary here.');
    const result = await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    // No cap applied (max_tokens=1000 is under the default cap), no split, no OpenAI path.
    expect(result).toBeUndefined();
    // System is unchanged.
    const system = payload['system'] as Array<Record<string, unknown>>;
    expect(system).toHaveLength(1);
  });

  it('Anthropic capped AND split: both cap and system split are applied when max_tokens is over cap', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['aabbccddeeff0011']);
    registerProviderRequestCap(pi, session);

    const assembled = makeAssembledPrompt();
    // Use a very high max_tokens to trigger the cap path.
    const payload = makeAnthropicPayload(assembled, { max_tokens: 999_999 });
    const result = await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    // Hook must return the payload.
    expect(result).toBe(payload);
    // max_tokens must have been capped.
    expect((payload['max_tokens'] as number)).toBeLessThan(999_999);
    // System must have been split.
    const system = payload['system'] as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    expect(system[0]['cache_control']).toEqual({ type: 'ephemeral' });
    expect(system[1]['cache_control']).toBeUndefined();
  });

  // OAuth shape: system = [identity block, harness prompt block]
  // Under OAuth, buildParams in @earendil-works/pi-ai anthropic.js always prepends a
  // Claude Code identity block, producing system.length === 2. The old length===1 guard
  // caused splitAnthropicSystemCacheBlock to return null, leaving the entire assembled
  // prompt (incl. beadId/worktree/checklist) in a single cached block — the cache-
  // poisoning this bead was designed to fix.
  it('OAuth shape: identity block preserved, harness block split, beadId only in volatile via real hook', async () => {
    const { pi, handlers } = makeFakePi();
    const session = makeSession(['aabbccddeeff0011']);
    registerProviderRequestCap(pi, session);

    const beadId = 'pi-experiment-6q0y.8';
    const workdir = '/Users/aidan/dev/pi-experiment-wt/6q0y.8';
    const harnessSuffix = makeVolatileSuffix(beadId, workdir);
    const harnessText = `${makeStableBlock()}\n\n${harnessSuffix}`;
    const identityText = 'You are Claude Code, Anthropic\'s official CLI for Claude.';

    const payload: Record<string, unknown> = {
      model: 'claude-opus-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'hello' }],
      system: [
        { type: 'text', text: identityText, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: harnessText, cache_control: { type: 'ephemeral' } }
      ]
    };

    const result = await handlers[PiEventName.BEFORE_PROVIDER_REQUEST]({ payload });

    // Hook must return the mutated payload (split occurred).
    expect(result).toBe(payload);

    const system = payload['system'] as Array<Record<string, unknown>>;
    // 2-block OAuth system becomes 3 blocks: identity + stable + volatile.
    expect(system).toHaveLength(3);

    // Block 0: identity block preserved unchanged WITH its cache_control.
    expect(system[0]['text']).toBe(identityText);
    expect(system[0]['cache_control']).toEqual({ type: 'ephemeral' });

    // Block 1: stable portion of harness prompt, cache_control preserved.
    expect(system[1]['cache_control']).toEqual({ type: 'ephemeral' });
    expect(system[1]['text'] as string).not.toContain(beadId);
    expect(system[1]['text'] as string).not.toContain(workdir);
    expect(system[1]['text'] as string).not.toContain('### RUN CONTEXT');

    // Block 2: volatile portion — NO cache_control; beadId and worktree appear here.
    expect(system[2]['cache_control']).toBeUndefined();
    expect((system[2]['text'] as string).startsWith('### RUN CONTEXT')).toBe(true);
    expect(system[2]['text'] as string).toContain(beadId);
    expect(system[2]['text'] as string).toContain(workdir);

    // Round-trip: stable + '\n\n' + volatile === original harness block text.
    expect(`${system[1]['text']}\n\n${system[2]['text']}`).toBe(harnessText);
  });
});
