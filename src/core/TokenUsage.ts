import type { TurnTelemetry } from './Telemetry.js';

// ---- Per-tool token accounting (s3wp.16) ----
//
// Local constant — intentionally NOT imported from src/constants/index.ts so that
// this module can be used and tested without a constants dependency.  The value (4)
// matches TOKEN_ESTIMATE_CHARS_PER_TOKEN in both constants/index.ts and
// plugins/projectTools/constants.ts.
const TOOL_TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

/**
 * Accounting record for a single plugin/built-in tool invocation.
 * Stored in the event store as telemetry; never injected into the model-facing result.
 */
export interface ToolTokenAccounting {
  /** Registered tool name. */
  tool: string;
  /** Canonical invocation identifier — the same id carried on TOOL_INVOCATION_* events. */
  toolInvocationId: string | undefined;
  /** Bead identifier when available (undefined in non-worker mode). */
  beadId: string | undefined;
  /** State identifier when available. */
  stateId: string | undefined;
  /** Action identifier when available. */
  actionId: string | undefined;
  /** Byte length of the JSON-serialized model-facing result. */
  modelFacingBytes: number;
  /** Estimated token count: ceil(modelFacingBytes / 4). */
  estimatedTokens: number;
  /** Whether the result was served from the in-session cache (no new tool execution). */
  cached: boolean;
}

/**
 * Estimate the UTF-8 byte length of a value when serialized to the string form
 * the model receives (plain string values are used as-is; everything else is
 * JSON-serialized).  Returns 0 when serialization fails.
 *
 * This mirrors the logic in toolResult() in extension.ts:
 *   typeof value === 'string' ? value : JSON.stringify(value, null, 2)
 * We use compact JSON here (no pretty-print) for a conservative byte estimate;
 * the difference is whitespace, which has negligible token cost.
 */
export function estimateResultBytes(value: unknown): number {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return Buffer.byteLength(serialized, 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Estimate the model-facing token cost of a tool result using the standard
 * chars-per-token heuristic (4 bytes ≈ 1 token).
 */
export function estimateResultTokens(value: unknown): number {
  return Math.ceil(estimateResultBytes(value) / TOOL_TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

/**
 * Build a ToolTokenAccounting record for a completed tool invocation.
 * The `modelFacingResult` is the value returned by execute() BEFORE toolResult()
 * wraps it — i.e., the raw result the model will ultimately see as serialized text.
 * This function is pure and does NOT mutate the result.
 */
export function buildToolTokenAccounting(
  tool: string,
  beadId: string | undefined,
  stateId: string | undefined,
  actionId: string | undefined,
  modelFacingResult: unknown,
  cached: boolean = false,
  toolInvocationId: string | undefined = undefined
): ToolTokenAccounting {
  const modelFacingBytes = estimateResultBytes(modelFacingResult);
  const estimatedTokens = Math.ceil(modelFacingBytes / TOOL_TOKEN_ESTIMATE_CHARS_PER_TOKEN);
  return { tool, toolInvocationId, beadId, stateId, actionId, modelFacingBytes, estimatedTokens, cached };
}

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
