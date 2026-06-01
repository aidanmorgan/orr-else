import type { TurnTelemetry } from './Telemetry.js';

/** Token/cost usage as reported on a Pi assistant message (`message.usage`). */
export interface RawUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

export interface UsageContext {
  beadId: string;
  stateId: string;
  actionId: string;
  workerId: string;
  model: string;
  startTimeMs: number;
  endTimeMs: number;
}

/** Flat usage record persisted to the event store and OTEL for a single turn. */
export interface TurnUsageEvent {
  beadId: string;
  stateId: string;
  actionId: string;
  workerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costTotal: number;
  durationMs: number;
}

export interface TurnUsageRecord {
  telemetry: TurnTelemetry;
  event: TurnUsageEvent;
}

/**
 * Normalize a Pi `message.usage` payload plus turn context into the records the
 * harness persists: a `TurnTelemetry` for the in-process aggregate store and a
 * flat `TurnUsageEvent` for the JSONL event store / OTEL. Returns `null` when
 * there is no usage or the turn reported zero tokens (e.g. a cached no-op turn),
 * so callers can skip empty records.
 */
export function buildTurnUsageRecord(usage: RawUsage | undefined, ctx: UsageContext): TurnUsageRecord | null {
  if (!usage) return null;

  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
  if (totalTokens <= 0) return null;

  const costTotal = usage.cost?.total ?? 0;
  const durationMs = Math.max(0, ctx.endTimeMs - ctx.startTimeMs);

  return {
    telemetry: {
      beadId: ctx.beadId,
      phase: ctx.stateId,
      actionId: ctx.actionId,
      model: ctx.model,
      startTime: ctx.startTimeMs,
      endTime: ctx.endTimeMs,
      durationMs,
      promptTokens: input + cacheRead + cacheWrite,
      completionTokens: output,
      totalTokens,
      cost: costTotal
    },
    event: {
      beadId: ctx.beadId,
      stateId: ctx.stateId,
      actionId: ctx.actionId,
      workerId: ctx.workerId,
      model: ctx.model,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens,
      costTotal,
      durationMs
    }
  };
}
