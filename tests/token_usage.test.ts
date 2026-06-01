import { describe, it, expect } from 'vitest';
import { buildTurnUsageRecord } from '../src/core/TokenUsage.js';

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
