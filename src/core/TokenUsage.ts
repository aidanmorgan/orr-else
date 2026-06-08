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
 * Serialize a tool result value to the exact string form that the model
 * receives as `content[0].text` (pi-experiment-6q0y.18 AC1).
 *
 * This is the SINGLE canonical serialization used by BOTH the model-facing
 * toolResult() return value AND the byte accounting, so metered bytes always
 * match the actual payload. Callers must not re-implement this logic.
 *
 * Logic: plain string values are used as-is; everything else is pretty-printed
 * JSON (2-space indent) — matching toolResult() in extension.ts exactly.
 */
export function serializeToolResultText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/**
 * Compute the UTF-8 byte length of a tool result as it will appear in
 * `content[0].text` sent to the model. Returns 0 when serialization fails.
 *
 * Uses serializeToolResultText so the metered bytes EXACTLY match the model-
 * facing payload (AC1 — no drift between accounting and actual content).
 */
export function estimateResultBytes(value: unknown): number {
  try {
    return Buffer.byteLength(serializeToolResultText(value), 'utf8');
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

// ---------------------------------------------------------------------------
// pi-experiment-6q0y.15: strict, schema-validated accounting shapes
//
// These are the event payload types for MODEL_TURN_USAGE_RECORDED and
// TOOL_PAYLOAD_ACCOUNTED. They are DISTINCT from each other:
//   - ModelTurnAccountingEvent  → one per assistant turn; provider-reported
//     token counts, cost, and duration. Never carries prompt bodies.
//   - ToolPayloadAccountingEvent → one per tool invocation result; model-facing
//     byte/token estimate. Never carries raw tool output bodies.
//
// JSON Schemas for both shapes are registered in SchemaRegistry.ts
// (harness.accounting.modelTurnUsage / harness.accounting.toolPayload).
// DOMAIN_EVENT_SCHEMAS entries live in DomainEventSchemas.ts.
// ---------------------------------------------------------------------------

/**
 * Schema-validated payload for MODEL_TURN_USAGE_RECORDED events
 * (pi-experiment-6q0y.15).
 *
 * Carries provider-reported token usage and cost for one assistant turn.
 * MUST NOT include prompt bodies, raw message content, or source files.
 *
 * OTel scalar attributes (gen_ai.usage.*) mirror these fields for tracing
 * but are NOT authoritative for replay — the event payload is the record.
 */
export interface ModelTurnAccountingEvent {
  /** Stable bead identifier — always present (writer guarantees this). */
  beadId: string;
  /** State name the turn ran in — always present. */
  stateId: string;
  /** Action id within the state — always present. */
  actionId: string;
  /** Worker id that executed the turn — always present. */
  workerId: string;
  /** Provider-reported model identifier (e.g. "claude-opus-4-5"). */
  model: string;
  /** Provider name (e.g. "anthropic", "openai"). Optional — not all code paths know it. */
  provider?: string;
  /** Provider-reported input token count (not counting cache hits/writes). */
  inputTokens: number;
  /** Provider-reported output token count. */
  outputTokens: number;
  /** Provider-reported cache-read token count (0 when not applicable). */
  cacheReadTokens: number;
  /** Provider-reported cache-write token count (0 when not applicable). */
  cacheWriteTokens: number;
  /** Total tokens: provider value if available, else sum of the four counts above. */
  totalTokens: number;
  /** Total cost in USD (0 when not reported). */
  costTotal: number;
  /** Wall-clock duration for the full turn in milliseconds. */
  durationMs: number;
  /**
   * Idempotency key — a stable identifier for this specific turn that lets
   * replayers deduplicate retried writes. Computed as `${actionId}:${workerId}:${stateId}`.
   * Optional: absent on legacy events that predate 6q0y.15.
   */
  idempotencyKey?: string;
}

/**
 * Schema-validated payload for TOOL_PAYLOAD_ACCOUNTED events
 * (pi-experiment-6q0y.15).
 *
 * Carries the model-facing byte and token estimate for ONE tool invocation.
 * MUST NOT include raw tool output bodies, source files, or logs.
 *
 * OTel scalar attributes mirror modelFacingBytes and estimatedTokens for
 * tracing but are NOT authoritative for replay.
 */
export interface ToolPayloadAccountingEvent {
  /** Registered tool name — always present (writer guarantees this). */
  tool: string;
  /** Bead identifier — present when the tool ran in a bead context; undefined otherwise. */
  beadId?: string;
  /** State identifier — present when available. */
  stateId?: string;
  /** Action identifier — present when available. */
  actionId?: string;
  /** Canonical invocation identifier from TOOL_INVOCATION_* events. */
  toolInvocationId?: string;
  /** Byte length of the JSON-serialised model-facing result (no raw body stored). */
  modelFacingBytes: number;
  /** Estimated token count: ceil(modelFacingBytes / 4). */
  estimatedTokens: number;
  /** Whether the result was served from the in-session cache. */
  cached: boolean;
  /**
   * Idempotency key — a stable identifier to deduplicate retried writes.
   * Computed as `${toolInvocationId ?? tool}:${beadId ?? 'global'}`.
   * Optional: absent on legacy events that predate 6q0y.15.
   */
  idempotencyKey?: string;
}

/**
 * Build the idempotency key for a ModelTurnAccountingEvent.
 * Stable across retries because it uses writer-guaranteed fields only.
 */
export function buildModelTurnIdempotencyKey(actionId: string, workerId: string, stateId: string): string {
  return `${actionId}:${workerId}:${stateId}`;
}

/**
 * Build the idempotency key for a ToolPayloadAccountingEvent.
 */
export function buildToolPayloadIdempotencyKey(
  tool: string,
  toolInvocationId: string | undefined,
  beadId: string | undefined
): string {
  return `${toolInvocationId ?? tool}:${beadId ?? 'global'}`;
}

// ---------------------------------------------------------------------------
// pi-experiment-6q0y.9: cache-hit observability keyed by prompt digest
// ---------------------------------------------------------------------------

/**
 * Payload for PROMPT_CACHE_OBSERVABILITY events.
 *
 * Emitted when a turn reports non-zero cache-read or cache-write token counts.
 * Carries enough data to compute per-digest cache-hit ratios without storing
 * any prompt body, tool body, or raw source content.
 *
 * cacheHitRatio = cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)
 */
export interface PromptCacheObservabilityEvent {
  /** Stable bead identifier — always present. */
  beadId: string;
  /** State name the turn ran in — always present. */
  stateId: string;
  /** Action id within the state — always present. */
  actionId: string;
  /** Worker id that executed the turn — always present. */
  workerId: string;
  /** Provider-reported model identifier. */
  model: string;
  /**
   * Deterministic stable-block digest ID (from digestStableBlock / digestIdentity).
   * Absent when no digest has been recorded yet for the current run.
   * MUST NOT be a raw prompt body — only the 16-char hex digest ID.
   */
  stableBlockDigestId: string | undefined;
  /** Provider-reported input token count (not counting cache hits/writes). */
  inputTokens: number;
  /** Provider-reported cache-read token count. */
  cacheReadTokens: number;
  /** Provider-reported cache-write token count. */
  cacheWriteTokens: number;
}

/**
 * Build a PromptCacheObservabilityEvent from a completed turn's usage data.
 *
 * Returns null when both cacheReadTokens and cacheWriteTokens are zero —
 * there is nothing to observe when no caching activity occurred.
 *
 * Pure function: no Date.now() or Math.random().
 */
export function buildPromptCacheObservabilityEvent(
  event: TurnUsageEvent,
  stableBlockDigestId: string | undefined
): PromptCacheObservabilityEvent | null {
  if (event.cacheReadTokens === 0 && event.cacheWriteTokens === 0) return null;
  return {
    beadId: event.beadId,
    stateId: event.stateId,
    actionId: event.actionId,
    workerId: event.workerId,
    model: event.model,
    stableBlockDigestId,
    inputTokens: event.inputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens
  };
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
