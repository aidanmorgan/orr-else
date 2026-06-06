import { describe, it, expect } from 'vitest';
import { buildTurnUsageRecord, buildToolTokenAccounting, estimateResultBytes, estimateResultTokens } from '../src/core/TokenUsage.js';

const ctx = {
  beadId: 'cerdiwen-1',
  stateId: 'Planning',
  actionId: 'formulate-plan',
  workerId: 'worker-1',
  model: 'gpt-5.5',
  startTimeMs: 1000,
  endTimeMs: 3500
};

describe('buildTurnUsageRecord', () => {
  it('normalizes a full usage payload into telemetry and event records', () => {
    const record = buildTurnUsageRecord(
      {
        input: 1200,
        output: 800,
        cacheRead: 300,
        cacheWrite: 100,
        totalTokens: 2400,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 }
      },
      ctx
    );
    expect(record).not.toBeNull();
    expect(record!.event).toMatchObject({
      beadId: 'cerdiwen-1',
      stateId: 'Planning',
      actionId: 'formulate-plan',
      workerId: 'worker-1',
      model: 'gpt-5.5',
      inputTokens: 1200,
      outputTokens: 800,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      totalTokens: 2400,
      costTotal: 0.33,
      durationMs: 2500
    });
    expect(record!.telemetry).toMatchObject({
      beadId: 'cerdiwen-1',
      phase: 'Planning',
      actionId: 'formulate-plan',
      promptTokens: 1600, // input + cacheRead + cacheWrite
      completionTokens: 800,
      totalTokens: 2400,
      cost: 0.33,
      durationMs: 2500
    });
  });

  it('derives totalTokens when not provided', () => {
    const record = buildTurnUsageRecord({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 }, ctx);
    expect(record!.event.totalTokens).toBe(20);
  });

  it('returns null when usage is missing', () => {
    expect(buildTurnUsageRecord(undefined, ctx)).toBeNull();
  });

  it('returns null for a zero-token turn', () => {
    expect(buildTurnUsageRecord({ input: 0, output: 0, totalTokens: 0 }, ctx)).toBeNull();
  });

  it('defaults cost to 0 when absent (e.g. flat-rate subscription)', () => {
    const record = buildTurnUsageRecord({ totalTokens: 100, input: 60, output: 40 }, ctx);
    expect(record!.event.costTotal).toBe(0);
  });

  it('clamps negative durations to 0', () => {
    const record = buildTurnUsageRecord({ totalTokens: 100 }, { ...ctx, startTimeMs: 5000, endTimeMs: 1000 });
    expect(record!.event.durationMs).toBe(0);
  });
});

// ---- Per-tool token accounting (s3wp.16) ----

describe('estimateResultBytes', () => {
  it('returns UTF-8 byte length for string values', () => {
    expect(estimateResultBytes('hello')).toBe(5);
  });

  it('returns UTF-8 byte length for multi-byte characters', () => {
    // '€' is 3 bytes in UTF-8
    expect(estimateResultBytes('€')).toBe(3);
  });

  it('serializes objects to JSON and returns byte length', () => {
    const obj = { status: 'ok', count: 42 };
    const expected = Buffer.byteLength(JSON.stringify(obj), 'utf8');
    expect(estimateResultBytes(obj)).toBe(expected);
  });

  it('returns 0 for circular references (unserializable)', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(estimateResultBytes(circular)).toBe(0);
  });
});

describe('estimateResultTokens', () => {
  it('returns ceil(bytes / 4) for a plain string', () => {
    // 'abcd' = 4 bytes => 1 token
    expect(estimateResultTokens('abcd')).toBe(1);
    // 'abcde' = 5 bytes => ceil(5/4) = 2 tokens
    expect(estimateResultTokens('abcde')).toBe(2);
  });

  it('returns 0 for empty string', () => {
    expect(estimateResultTokens('')).toBe(0);
  });
});

describe('buildToolTokenAccounting', () => {
  it('produces accounting for a string result without mutating the input', () => {
    const result = 'tool output text';
    const resultBefore = result;
    const accounting = buildToolTokenAccounting(
      'my_tool', 'bead-1', 'Planning', 'action-1', result
    );
    // Result must be byte-identical — no mutation
    expect(result).toBe(resultBefore);
    expect(accounting.tool).toBe('my_tool');
    expect(accounting.beadId).toBe('bead-1');
    expect(accounting.stateId).toBe('Planning');
    expect(accounting.actionId).toBe('action-1');
    expect(accounting.modelFacingBytes).toBe(Buffer.byteLength(result, 'utf8'));
    expect(accounting.estimatedTokens).toBe(Math.ceil(Buffer.byteLength(result, 'utf8') / 4));
    expect(accounting.cached).toBe(false);
    // toolInvocationId defaults to undefined when omitted
    expect(accounting.toolInvocationId).toBeUndefined();
  });

  it('threads toolInvocationId through the accounting record when provided', () => {
    const invocationId = '01935c28-1234-7abc-def0-123456789abc';
    const accounting = buildToolTokenAccounting(
      'my_tool', 'bead-1', 'Planning', 'action-1', 'result', false, invocationId
    );
    expect(accounting.toolInvocationId).toBe(invocationId);
  });

  it('produces accounting for an object result without mutating the input', () => {
    const result = { status: 'ok', files: ['a.ts', 'b.ts'] };
    const serializedBefore = JSON.stringify(result);
    const accounting = buildToolTokenAccounting(
      'obj_tool', undefined, undefined, undefined, result
    );
    // Object must be unchanged — deep-equal
    expect(JSON.stringify(result)).toBe(serializedBefore);
    const expectedBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    expect(accounting.modelFacingBytes).toBe(expectedBytes);
    expect(accounting.estimatedTokens).toBe(Math.ceil(expectedBytes / 4));
    expect(accounting.cached).toBe(false);
  });

  it('marks cached results correctly', () => {
    const accounting = buildToolTokenAccounting(
      'cached_tool', 'bead-2', 'Coding', 'act-2', 'cached result', true
    );
    expect(accounting.cached).toBe(true);
  });

  it('accounting does not add fields to the model-facing result object', () => {
    const result = { status: 'ok', value: 42 };
    const keysBefore = Object.keys(result).sort();
    buildToolTokenAccounting('tool', 'b', 's', 'a', result);
    // Public tool schema is unchanged — no new keys on result
    expect(Object.keys(result).sort()).toEqual(keysBefore);
  });

  it('computes schema-native compact result accounting correctly', () => {
    // Simulates a compact tool result with just a preview field
    const compactResult = { RESULT_PREVIEW: 'short summary', status: 'ok' };
    const accounting = buildToolTokenAccounting('compact_tool', 'b', 's', 'a', compactResult);
    expect(accounting.modelFacingBytes).toBeGreaterThan(0);
    expect(accounting.estimatedTokens).toBeGreaterThan(0);
    expect(accounting.tool).toBe('compact_tool');
  });
});
