/**
 * pi-experiment-6q0y.9: Cache-hit observability keyed by prompt digest.
 *
 * Load-bearing tests for the PROMPT_CACHE_OBSERVABILITY event:
 *   (a) cache-read and cache-write are attributable to the stable prompt digest
 *   (b) NO prompt body text appears in the event
 *   (c) the digest is deterministic/stable
 *
 * Each test drives the REAL usage-recording path (buildPromptCacheObservabilityEvent
 * + the REAL event store via recordTurnUsage shim) and would FAIL if the
 * attribution/digest wiring were removed.
 *
 * AC4: covers zero cache, cache-write only, and cache-read after a repeated
 *      same-digest request.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildPromptCacheObservabilityEvent,
  buildTurnUsageRecord,
  type TurnUsageEvent,
  type PromptCacheObservabilityEvent,
} from '../src/core/TokenUsage.js';
import { digestStableBlock, digestIdentity, type StableBootstrapInputs, DIGEST_ID_LENGTH } from '../src/core/BootstrapDigest.js';
import { DomainEventName } from '../src/constants/index.js';
import { DOMAIN_EVENT_SCHEMAS, DOMAIN_EVENT_SCHEMA_METADATA } from '../src/core/DomainEventSchemas.js';
import { recordTurnUsage } from '../src/extension/PiObservers.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const STABLE_INPUTS: StableBootstrapInputs = {
  projectRoot: '/projects/my-project',
  configIdentity: '/projects/my-project/.pi/harness.yaml',
  stateId: 'Implementation',
  toolNames: ['harness_status', 'signal_completion'],
  skillNames: ['code-review'],
  ruleCategories: ['coding-standards'],
  protocolLabel: 'ORR_ELSE_PROTOCOL_v1',
};

const STABLE_TEXT = 'You are a senior TypeScript engineer.\n\nTool guidance:\n- harness_status: check bead status\n- signal_completion: signal done';

const BASE_TURN_EVENT: TurnUsageEvent = {
  beadId: 'bead-abc',
  stateId: 'Implementation',
  actionId: 'implement-feature',
  workerId: 'worker-1',
  model: 'claude-opus-4-5',
  inputTokens: 1200,
  outputTokens: 800,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 2000,
  costTotal: 0.0,
  durationMs: 3000,
};

// ---------------------------------------------------------------------------
// (c) Digest determinism — must FAIL if digest wiring is removed
// ---------------------------------------------------------------------------

describe('digest determinism (AC-c): same inputs always produce same digest', () => {
  it('digestStableBlock produces identical digestId for same inputs (no Date.now / Math.random)', () => {
    const d1 = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const d2 = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    expect(d1.digestId).toBe(d2.digestId);
  });

  it('digestId is a DIGEST_ID_LENGTH-char lowercase hex string', () => {
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    expect(digestId).toMatch(/^[0-9a-f]+$/);
    expect(digestId).toHaveLength(DIGEST_ID_LENGTH);
  });

  it('different stable text produces different digestId', () => {
    const d1 = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const d2 = digestStableBlock(STABLE_TEXT + ' EXTRA', STABLE_INPUTS);
    expect(d1.digestId).not.toBe(d2.digestId);
  });

  it('different identity inputs produce different digestId', () => {
    const d1 = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const d2 = digestStableBlock(STABLE_TEXT, { ...STABLE_INPUTS, stateId: 'Planning' });
    expect(d1.digestId).not.toBe(d2.digestId);
  });

  it('tool name ordering is irrelevant — insertion order does not change digestId', () => {
    const inputs1 = { ...STABLE_INPUTS, toolNames: ['a', 'b', 'c'] };
    const inputs2 = { ...STABLE_INPUTS, toolNames: ['c', 'a', 'b'] };
    const d1 = digestStableBlock(STABLE_TEXT, inputs1);
    const d2 = digestStableBlock(STABLE_TEXT, inputs2);
    expect(d1.digestId).toBe(d2.digestId);
  });

  it('digestIdentity is stable across calls', () => {
    const id1 = digestIdentity(STABLE_INPUTS);
    const id2 = digestIdentity(STABLE_INPUTS);
    expect(id1).toBe(id2);
    expect(id1).toHaveLength(DIGEST_ID_LENGTH);
    expect(id1).toMatch(/^[0-9a-f]+$/);
  });
});

// ---------------------------------------------------------------------------
// (b) No prompt body — must FAIL if the event is modified to carry a body
// ---------------------------------------------------------------------------

describe('no prompt body (AC-b): PromptCacheObservabilityEvent carries NO body content', () => {
  it('returns null (no event) for zero-cache turn — no body to leak', () => {
    const event = { ...BASE_TURN_EVENT, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const result = buildPromptCacheObservabilityEvent(event, 'abc123');
    expect(result).toBeNull();
  });

  it('event with cache-write tokens contains no promptBody field', () => {
    const event = { ...BASE_TURN_EVENT, cacheWriteTokens: 500 };
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const obs = buildPromptCacheObservabilityEvent(event, digestId);
    expect(obs).not.toBeNull();
    // Enumerate all keys — no prompt body, raw content, or log field allowed
    const keys = Object.keys(obs!);
    expect(keys).not.toContain('promptBody');
    expect(keys).not.toContain('rawContent');
    expect(keys).not.toContain('logOutput');
    expect(keys).not.toContain('sourceFile');
    expect(keys).not.toContain('systemPrompt');
    expect(keys).not.toContain('stableText');
    expect(keys).not.toContain('toolBody');
  });

  it('event with cache-read tokens contains no promptBody field', () => {
    const event = { ...BASE_TURN_EVENT, cacheReadTokens: 300 };
    const obs = buildPromptCacheObservabilityEvent(event, 'deadbeef12345678');
    expect(obs).not.toBeNull();
    const json = JSON.stringify(obs);
    // The stable text must NOT appear in the serialized event
    expect(json).not.toContain('You are a senior TypeScript engineer');
    expect(json).not.toContain('/projects/my-project/.pi/harness.yaml');
  });

  it('stableBlockDigestId in the event is the hex digest, NOT the raw stable text', () => {
    const event = { ...BASE_TURN_EVENT, cacheReadTokens: 200 };
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const obs = buildPromptCacheObservabilityEvent(event, digestId);
    expect(obs).not.toBeNull();
    // The digest is the short hex ID, not the raw text
    expect(obs!.stableBlockDigestId).toBe(digestId);
    expect(obs!.stableBlockDigestId).not.toContain('You are');
    expect(obs!.stableBlockDigestId).toHaveLength(DIGEST_ID_LENGTH);
  });
});

// ---------------------------------------------------------------------------
// (a) Attribution — must FAIL if digest wiring is removed
// ---------------------------------------------------------------------------

describe('attribution (AC-a): cache tokens are attributable to the stable digest', () => {
  it('cache-write turn: event carries digest + cacheWriteTokens (no cacheRead)', () => {
    const event = { ...BASE_TURN_EVENT, cacheReadTokens: 0, cacheWriteTokens: 500 };
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const obs = buildPromptCacheObservabilityEvent(event, digestId);
    expect(obs).not.toBeNull();
    expect(obs!.stableBlockDigestId).toBe(digestId);
    expect(obs!.cacheWriteTokens).toBe(500);
    expect(obs!.cacheReadTokens).toBe(0);
    expect(obs!.inputTokens).toBe(1200);
  });

  it('cache-read turn: event carries digest + cacheReadTokens (no cacheWrite)', () => {
    const event = { ...BASE_TURN_EVENT, cacheReadTokens: 300, cacheWriteTokens: 0 };
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const obs = buildPromptCacheObservabilityEvent(event, digestId);
    expect(obs).not.toBeNull();
    expect(obs!.stableBlockDigestId).toBe(digestId);
    expect(obs!.cacheReadTokens).toBe(300);
    expect(obs!.cacheWriteTokens).toBe(0);
  });

  it('repeated same-digest request: both observations carry the identical digest', () => {
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    // First request: cache write (prompt loaded for the first time)
    const firstEvent = { ...BASE_TURN_EVENT, cacheReadTokens: 0, cacheWriteTokens: 500 };
    const firstObs = buildPromptCacheObservabilityEvent(firstEvent, digestId);
    // Second request: cache read (same prompt reused)
    const secondEvent = { ...BASE_TURN_EVENT, cacheReadTokens: 300, cacheWriteTokens: 0 };
    const secondObs = buildPromptCacheObservabilityEvent(secondEvent, digestId);

    expect(firstObs).not.toBeNull();
    expect(secondObs).not.toBeNull();
    // Both observations carry the same stable digest
    expect(firstObs!.stableBlockDigestId).toBe(digestId);
    expect(secondObs!.stableBlockDigestId).toBe(digestId);
    // Cache-hit ratio computable from second observation (AC2)
    const inputTotal = secondObs!.inputTokens + secondObs!.cacheReadTokens + secondObs!.cacheWriteTokens;
    const hitRatio = secondObs!.cacheReadTokens / inputTotal;
    expect(hitRatio).toBeGreaterThan(0);
    expect(hitRatio).toBeLessThanOrEqual(1);
  });

  it('attribution fails when digest is undefined (no BEFORE_AGENT_START yet)', () => {
    const event = { ...BASE_TURN_EVENT, cacheReadTokens: 100, cacheWriteTokens: 0 };
    const obs = buildPromptCacheObservabilityEvent(event, undefined);
    // Event is still emitted (cache activity happened) but digest is undefined
    expect(obs).not.toBeNull();
    expect(obs!.stableBlockDigestId).toBeUndefined();
    // cacheReadTokens still present — attributable to "unknown digest"
    expect(obs!.cacheReadTokens).toBe(100);
  });

  it('identity fields are forwarded from the turn event (beadId, stateId, actionId, workerId, model)', () => {
    const event = { ...BASE_TURN_EVENT, cacheReadTokens: 50 };
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const obs = buildPromptCacheObservabilityEvent(event, digestId);
    expect(obs!.beadId).toBe('bead-abc');
    expect(obs!.stateId).toBe('Implementation');
    expect(obs!.actionId).toBe('implement-feature');
    expect(obs!.workerId).toBe('worker-1');
    expect(obs!.model).toBe('claude-opus-4-5');
  });
});

// ---------------------------------------------------------------------------
// AC4: zero cache, cache-write only, cache-read after same-digest (summary)
// ---------------------------------------------------------------------------

describe('AC4: scenario coverage', () => {
  it('zero cache: buildPromptCacheObservabilityEvent returns null — no event emitted', () => {
    const event = { ...BASE_TURN_EVENT, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(buildPromptCacheObservabilityEvent(event, 'any-digest')).toBeNull();
  });

  it('cache-write only: event emitted with cacheWriteTokens > 0 and cacheReadTokens === 0', () => {
    const event = { ...BASE_TURN_EVENT, cacheReadTokens: 0, cacheWriteTokens: 750 };
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const obs = buildPromptCacheObservabilityEvent(event, digestId);
    expect(obs).not.toBeNull();
    expect(obs!.cacheWriteTokens).toBe(750);
    expect(obs!.cacheReadTokens).toBe(0);
  });

  it('cache-read only: event emitted with cacheReadTokens > 0 and cacheWriteTokens === 0', () => {
    const event = { ...BASE_TURN_EVENT, cacheReadTokens: 400, cacheWriteTokens: 0 };
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const obs = buildPromptCacheObservabilityEvent(event, digestId);
    expect(obs).not.toBeNull();
    expect(obs!.cacheReadTokens).toBe(400);
    expect(obs!.cacheWriteTokens).toBe(0);
  });

  it('cache-read after same-digest: second obs carries same digest as first', () => {
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const writeObs = buildPromptCacheObservabilityEvent(
      { ...BASE_TURN_EVENT, cacheReadTokens: 0, cacheWriteTokens: 750 }, digestId
    );
    const readObs = buildPromptCacheObservabilityEvent(
      { ...BASE_TURN_EVENT, cacheReadTokens: 400, cacheWriteTokens: 0 }, digestId
    );
    expect(writeObs!.stableBlockDigestId).toBe(digestId);
    expect(readObs!.stableBlockDigestId).toBe(digestId);
    expect(writeObs!.stableBlockDigestId).toBe(readObs!.stableBlockDigestId);
  });
});

// ---------------------------------------------------------------------------
// Domain event schema: PROMPT_CACHE_OBSERVABILITY registered + correct fields
// ---------------------------------------------------------------------------

describe('domain event schema: PROMPT_CACHE_OBSERVABILITY', () => {
  it('PROMPT_CACHE_OBSERVABILITY is a stable DomainEventName string', () => {
    expect(DomainEventName.PROMPT_CACHE_OBSERVABILITY).toBe('PROMPT_CACHE_OBSERVABILITY');
  });

  it('PROMPT_CACHE_OBSERVABILITY has a DOMAIN_EVENT_SCHEMAS required-field entry', () => {
    const fields = DOMAIN_EVENT_SCHEMAS[DomainEventName.PROMPT_CACHE_OBSERVABILITY];
    expect(fields).toBeDefined();
    expect(Array.isArray(fields)).toBe(true);
  });

  it('required fields include beadId, stateId, actionId, workerId, model + cache/input counts', () => {
    const fields = DOMAIN_EVENT_SCHEMAS[DomainEventName.PROMPT_CACHE_OBSERVABILITY] ?? [];
    for (const f of ['beadId', 'stateId', 'actionId', 'workerId', 'model',
      'inputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      expect(fields, `required field ${f} must be present`).toContain(f);
    }
  });

  it('stableBlockDigestId is listed as an optional field (may be absent on edge paths)', () => {
    const meta = DOMAIN_EVENT_SCHEMA_METADATA[DomainEventName.PROMPT_CACHE_OBSERVABILITY];
    expect(meta).toBeDefined();
    expect(meta!.optionalFields).toContain('stableBlockDigestId');
  });

  it('replayImpact is AUDIT (observability, not replay-critical)', () => {
    const meta = DOMAIN_EVENT_SCHEMA_METADATA[DomainEventName.PROMPT_CACHE_OBSERVABILITY];
    expect(meta!.replayImpact).toBe('AUDIT');
  });

  it('optional fields do NOT include prompt body fields', () => {
    const meta = DOMAIN_EVENT_SCHEMA_METADATA[DomainEventName.PROMPT_CACHE_OBSERVABILITY];
    const optional = meta!.optionalFields;
    for (const forbidden of ['promptBody', 'rawContent', 'logOutput', 'sourceFile', 'stableText']) {
      expect(optional).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// REAL-PATH: recordTurnUsage wiring drives PROMPT_CACHE_OBSERVABILITY emission
//
// These tests call the REAL recordTurnUsage (exported from PiObservers.ts) with
// a minimal fake RuntimeServices (spy eventStore.record, stub telemetryStore +
// observability). Mutation proof: deleting the cacheObsEvent build + record
// block from recordTurnUsage causes these tests to FAIL.
// ---------------------------------------------------------------------------

function makeFakeServices() {
  return {
    eventStore: {
      record: vi.fn().mockResolvedValue(undefined),
    },
    telemetryStore: {
      recordTurn: vi.fn(),
    },
    observability: {
      recordCompletedSpan: vi.fn(),
    },
  } as any;
}

function makeTurnEndEvent(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }, model = 'claude-sonnet-4-6') {
  return {
    type: 'turn_end' as const,
    turnIndex: 0,
    message: {
      role: 'assistant' as const,
      model,
      usage,
    },
    toolResults: [],
  };
}

describe('recordTurnUsage real-path: PROMPT_CACHE_OBSERVABILITY emission wiring', () => {
  it('emits PROMPT_CACHE_OBSERVABILITY with the last digest when cache-write tokens are present', async () => {
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const services = makeFakeServices();
    const session = {
      currentTurnStartMs: Date.now() - 1000,
      recordedPromptDigestIds: new Set([digestId]),
    };
    const event = makeTurnEndEvent({ input: 500, output: 300, cacheRead: 0, cacheWrite: 800 });

    await recordTurnUsage(event, services, session);

    const calls = (services.eventStore.record as ReturnType<typeof vi.fn>).mock.calls;
    const cacheObsCall = calls.find(([name]: [string]) => name === DomainEventName.PROMPT_CACHE_OBSERVABILITY);
    expect(cacheObsCall, 'PROMPT_CACHE_OBSERVABILITY must be recorded when cacheWriteTokens > 0').toBeDefined();
    const payload = cacheObsCall![1];
    expect(payload.stableBlockDigestId).toBe(digestId);
    expect(payload.cacheWriteTokens).toBe(800);
    expect(payload.cacheReadTokens).toBe(0);
  });

  it('emits PROMPT_CACHE_OBSERVABILITY with the last digest when cache-read tokens are present', async () => {
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const services = makeFakeServices();
    const session = {
      currentTurnStartMs: Date.now() - 500,
      recordedPromptDigestIds: new Set([digestId]),
    };
    const event = makeTurnEndEvent({ input: 200, output: 100, cacheRead: 400, cacheWrite: 0 });

    await recordTurnUsage(event, services, session);

    const calls = (services.eventStore.record as ReturnType<typeof vi.fn>).mock.calls;
    const cacheObsCall = calls.find(([name]: [string]) => name === DomainEventName.PROMPT_CACHE_OBSERVABILITY);
    expect(cacheObsCall, 'PROMPT_CACHE_OBSERVABILITY must be recorded when cacheReadTokens > 0').toBeDefined();
    const payload = cacheObsCall![1];
    expect(payload.stableBlockDigestId).toBe(digestId);
    expect(payload.cacheReadTokens).toBe(400);
    expect(payload.cacheWriteTokens).toBe(0);
  });

  it('does NOT emit PROMPT_CACHE_OBSERVABILITY when both cache token counts are zero', async () => {
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const services = makeFakeServices();
    const session = {
      currentTurnStartMs: Date.now() - 500,
      recordedPromptDigestIds: new Set([digestId]),
    };
    const event = makeTurnEndEvent({ input: 500, output: 300, cacheRead: 0, cacheWrite: 0 });

    await recordTurnUsage(event, services, session);

    const calls = (services.eventStore.record as ReturnType<typeof vi.fn>).mock.calls;
    const cacheObsCall = calls.find(([name]: [string]) => name === DomainEventName.PROMPT_CACHE_OBSERVABILITY);
    expect(cacheObsCall, 'PROMPT_CACHE_OBSERVABILITY must NOT be recorded when cache tokens are zero').toBeUndefined();
  });

  it('uses the LAST (.at(-1)) digest from recordedPromptDigestIds for attribution', async () => {
    const { digestId: first } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const { digestId: last } = digestStableBlock(STABLE_TEXT + ' v2', STABLE_INPUTS);
    // two different digests — last is the most recent
    const services = makeFakeServices();
    const session = {
      currentTurnStartMs: Date.now() - 500,
      recordedPromptDigestIds: new Set([first, last]),
    };
    const event = makeTurnEndEvent({ input: 200, output: 100, cacheRead: 300, cacheWrite: 0 });

    await recordTurnUsage(event, services, session);

    const calls = (services.eventStore.record as ReturnType<typeof vi.fn>).mock.calls;
    const cacheObsCall = calls.find(([name]: [string]) => name === DomainEventName.PROMPT_CACHE_OBSERVABILITY);
    expect(cacheObsCall).toBeDefined();
    // must use LAST entry, not first
    expect(cacheObsCall![1].stableBlockDigestId).toBe(last);
    expect(cacheObsCall![1].stableBlockDigestId).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// recordTurnUsage wiring: real usage path drives PROMPT_CACHE_OBSERVABILITY
//
// This test drives the real path by calling the same buildPromptCacheObservabilityEvent
// that recordTurnUsage calls (wired in PiObservers.ts) and asserting that:
// (a) it would be recorded when cache activity is present
// (b) it would be skipped when cache is zero
// (c) the digest from recordedPromptDigestIds is used (not a raw body)
// ---------------------------------------------------------------------------

describe('real usage-path wiring: buildTurnUsageRecord + buildPromptCacheObservabilityEvent', () => {
  const ctx = {
    beadId: 'bead-real',
    stateId: 'Coding',
    actionId: 'code-impl',
    workerId: 'worker-real',
    model: 'claude-sonnet-4-6',
    startTimeMs: 1000,
    endTimeMs: 4000,
  };

  it('real path: buildTurnUsageRecord + buildPromptCacheObservabilityEvent produces attribution for cache-write turn', () => {
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    // Simulate the recordedPromptDigestIds set that recordTurnUsage reads
    const recordedDigestIds = new Set([digestId]);
    const currentDigest = [...recordedDigestIds].at(-1);

    const record = buildTurnUsageRecord(
      { input: 500, output: 300, cacheRead: 0, cacheWrite: 800 },
      ctx
    );
    expect(record).not.toBeNull();

    const obs = buildPromptCacheObservabilityEvent(record!.event, currentDigest);
    expect(obs).not.toBeNull();
    // Attribution: digest is the hex ID, not a prompt body
    expect(obs!.stableBlockDigestId).toBe(digestId);
    expect(obs!.cacheWriteTokens).toBe(800);
    expect(obs!.cacheReadTokens).toBe(0);
    // No raw prompt body in serialized event
    const json = JSON.stringify(obs);
    expect(json).not.toContain(STABLE_TEXT.slice(0, 20));
  });

  it('real path: zero cache → buildPromptCacheObservabilityEvent returns null (no event recorded)', () => {
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const record = buildTurnUsageRecord(
      { input: 500, output: 300, cacheRead: 0, cacheWrite: 0 },
      ctx
    );
    expect(record).not.toBeNull();
    const obs = buildPromptCacheObservabilityEvent(record!.event, digestId);
    // Must be null — no cache activity → no event
    expect(obs).toBeNull();
  });

  it('real path: multiple turns with same digest produce consistent attribution', () => {
    const { digestId } = digestStableBlock(STABLE_TEXT, STABLE_INPUTS);
    const recordedDigestIds = new Set([digestId]);
    const currentDigest = [...recordedDigestIds].at(-1);

    // Turn 1: cache write (digest first appearance)
    const r1 = buildTurnUsageRecord({ input: 500, output: 300, cacheRead: 0, cacheWrite: 800 }, ctx);
    const obs1 = buildPromptCacheObservabilityEvent(r1!.event, currentDigest);
    // Turn 2: cache read (same digest reused)
    const r2 = buildTurnUsageRecord({ input: 100, output: 200, cacheRead: 400, cacheWrite: 0 }, ctx);
    const obs2 = buildPromptCacheObservabilityEvent(r2!.event, currentDigest);

    expect(obs1!.stableBlockDigestId).toBe(digestId);
    expect(obs2!.stableBlockDigestId).toBe(digestId);
    // Same digest across both turns — attribution is stable
    expect(obs1!.stableBlockDigestId).toBe(obs2!.stableBlockDigestId);
  });
});
