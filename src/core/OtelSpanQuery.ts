/**
 * OtelSpanQuery — bounded, progressive-disclosure query engine for OTEL span files.
 *
 * Design goals (pi-experiment-6q0y.26):
 * - Streams .pi/otel/*.jsonl with filters: trace ID, span name, action, tool,
 *   status, time range (AC1).
 * - Summary mode: span count, error count, p50/p95/p99 durations, top slow span
 *   names (AC2).
 * - Detail mode caps spans at 100 and truncates attributes to 300 chars (AC3).
 * - Malformed/rotated records are counted, do not fail the whole query (AC4).
 * - Responses stay below 24 KB in summary mode (AC5).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { OperationalArtifactPath } from '../constants/infra.js';
import { OtelAttr } from '../constants/infra.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Maximum spans returned in detail mode. */
export const OTEL_DETAIL_MAX_SPANS = 100;

/** Maximum character length for attribute values in detail mode. */
export const OTEL_ATTR_MAX_CHARS = 300;

/** Maximum byte size for the serialized summary response (24 KB). */
export const OTEL_SUMMARY_MAX_BYTES = 24_000;

/** Maximum number of top-slow span names to surface in summary mode. */
export const OTEL_TOP_SLOW_COUNT = 10;

// ─── Input / Output types ─────────────────────────────────────────────────────

export interface OtelSpanQueryInput {
  /** Filter by trace ID (exact match). */
  traceId?: string;
  /** Filter by span name (substring, case-insensitive). */
  spanName?: string;
  /** Filter by action attribute (orr_else.action_id, substring). */
  action?: string;
  /** Filter by tool attribute (e.g. span name or tool invocation ID attribute, substring). */
  tool?: string;
  /** Filter by span status code: 'ok' or 'error'. */
  status?: 'ok' | 'error';
  /** ISO 8601 lower bound: only spans with startTimeUnixNano >= this time. */
  fromTime?: string;
  /** ISO 8601 upper bound: only spans with startTimeUnixNano <= this time. */
  toTime?: string;
  /**
   * When true, return up to OTEL_DETAIL_MAX_SPANS with attribute values truncated
   * to OTEL_ATTR_MAX_CHARS. Default false: return summary stats only.
   */
  detail?: boolean;
}

export interface OtelSpanDurationStats {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface OtelSpanSummary {
  status: 'summary';
  totalMatched: number;
  errorCount: number;
  malformedCount: number;
  durationStats: OtelSpanDurationStats | null;
  /** Top OTEL_TOP_SLOW_COUNT slowest span names by average duration. */
  topSlowSpanNames: Array<{ name: string; avgMs: number; count: number }>;
}

export interface OtelSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  durationMs: number;
  status: Record<string, unknown>;
  attributes: Record<string, unknown>;
}

export interface OtelSpanDetail {
  status: 'detail';
  totalMatched: number;
  returnedCount: number;
  malformedCount: number;
  /** Whether result was capped at OTEL_DETAIL_MAX_SPANS. */
  capped: boolean;
  spans: OtelSpanRecord[];
}

export interface OtelSpanRejection {
  status: 'rejected';
  reason: string;
}

export type OtelSpanQueryResult =
  | OtelSpanSummary
  | OtelSpanDetail
  | OtelSpanRejection;

// ─── Internal record shape from Observability.ts serializer ──────────────────

interface RawSpanRecord {
  traceId?: unknown;
  spanId?: unknown;
  parentSpanId?: unknown;
  name?: unknown;
  startTimeUnixNano?: unknown;
  endTimeUnixNano?: unknown;
  durationUnixNano?: unknown;
  status?: unknown;
  attributes?: unknown;
  events?: unknown;
  resource?: unknown;
  instrumentationScope?: unknown;
}

function parseSpanRecord(line: string): RawSpanRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
    return obj as RawSpanRecord;
  } catch {
    return null;
  }
}

function isValidSpan(rec: RawSpanRecord): boolean {
  return (
    typeof rec.traceId === 'string' &&
    typeof rec.spanId === 'string' &&
    typeof rec.name === 'string'
  );
}

/** Convert nanosecond string to milliseconds number. Returns NaN on failure. */
function nanoStringToMs(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  try {
    return Number(BigInt(value) / BigInt(1_000_000));
  } catch {
    return NaN;
  }
}

/** Convert startTimeUnixNano to Date.UTC milliseconds for time filtering. */
function nanoStringToUtcMs(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  try {
    return Number(BigInt(value) / BigInt(1_000_000));
  } catch {
    return NaN;
  }
}

function getStatusCode(rec: RawSpanRecord): string {
  if (
    rec.status !== null &&
    typeof rec.status === 'object' &&
    !Array.isArray(rec.status)
  ) {
    const s = rec.status as Record<string, unknown>;
    if (typeof s.code === 'number') {
      // OTEL status codes: 0=UNSET, 1=OK, 2=ERROR
      return s.code === 2 ? 'error' : 'ok';
    }
    if (typeof s.status === 'string') return s.status.toLowerCase();
  }
  return 'ok';
}

function truncateAttributes(attrs: unknown): Record<string, unknown> {
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > OTEL_ATTR_MAX_CHARS) {
      result[k] = v.slice(0, OTEL_ATTR_MAX_CHARS) + '…';
    } else {
      result[k] = v;
    }
  }
  return result;
}

function passesFilters(rec: RawSpanRecord, input: OtelSpanQueryInput): boolean {
  if (input.traceId) {
    if (rec.traceId !== input.traceId) return false;
  }
  if (input.spanName) {
    if (typeof rec.name !== 'string') return false;
    if (!rec.name.toLowerCase().includes(input.spanName.toLowerCase())) return false;
  }
  const attrs = (rec.attributes !== null && typeof rec.attributes === 'object' && !Array.isArray(rec.attributes))
    ? rec.attributes as Record<string, unknown>
    : {};

  if (input.action) {
    const actionVal = attrs[OtelAttr.ORR_ELSE_ACTION_ID];
    if (typeof actionVal !== 'string') return false;
    if (!actionVal.toLowerCase().includes(input.action.toLowerCase())) return false;
  }
  if (input.tool) {
    const toolInvId = attrs[OtelAttr.ORR_ELSE_TOOL_INVOCATION_ID];
    const spanName = typeof rec.name === 'string' ? rec.name : '';
    const matches =
      (typeof toolInvId === 'string' && toolInvId.toLowerCase().includes(input.tool.toLowerCase())) ||
      spanName.toLowerCase().includes(input.tool.toLowerCase());
    if (!matches) return false;
  }
  if (input.status) {
    const code = getStatusCode(rec);
    if (code !== input.status) return false;
  }
  if (input.fromTime) {
    const fromMs = Date.parse(input.fromTime);
    const startMs = nanoStringToUtcMs(rec.startTimeUnixNano);
    if (isNaN(fromMs) || isNaN(startMs) || startMs < fromMs) return false;
  }
  if (input.toTime) {
    const toMs = Date.parse(input.toTime);
    const startMs = nanoStringToUtcMs(rec.startTimeUnixNano);
    if (isNaN(toMs) || isNaN(startMs) || startMs > toMs) return false;
  }
  return true;
}

/** Compute p50/p95/p99 from sorted array of durations. */
function computePercentiles(sortedMs: number[]): OtelSpanDurationStats {
  const len = sortedMs.length;
  if (len === 0) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }
  const idx = (p: number) => Math.min(Math.ceil(p * len / 100) - 1, len - 1);
  return {
    p50Ms: sortedMs[idx(50)]!,
    p95Ms: sortedMs[idx(95)]!,
    p99Ms: sortedMs[idx(99)]!
  };
}

// ─── OtelSpanQuery class ──────────────────────────────────────────────────────

export class OtelSpanQuery {
  constructor(private readonly projectRoot: string) {}

  public async query(input: OtelSpanQueryInput): Promise<OtelSpanQueryResult> {
    // Validate time filters
    if (input.fromTime !== undefined && isNaN(Date.parse(input.fromTime))) {
      return { status: 'rejected', reason: `Invalid fromTime: "${input.fromTime}" is not a valid ISO 8601 timestamp.` };
    }
    if (input.toTime !== undefined && isNaN(Date.parse(input.toTime))) {
      return { status: 'rejected', reason: `Invalid toTime: "${input.toTime}" is not a valid ISO 8601 timestamp.` };
    }

    const otelDir = path.join(this.projectRoot, OperationalArtifactPath.PI_OTEL_DIR);

    let spanFiles: string[] = [];
    try {
      const entries = fs.readdirSync(otelDir);
      spanFiles = entries
        .filter(e => e.endsWith('.jsonl'))
        .map(e => path.join(otelDir, e))
        .sort();
    } catch {
      // Directory absent or unreadable
      if (input.detail) {
        return { status: 'detail', totalMatched: 0, returnedCount: 0, malformedCount: 0, capped: false, spans: [] };
      }
      return {
        status: 'summary',
        totalMatched: 0,
        errorCount: 0,
        malformedCount: 0,
        durationStats: null,
        topSlowSpanNames: []
      };
    }

    if (input.detail) {
      return this.queryDetail(spanFiles, input);
    }
    return this.querySummary(spanFiles, input);
  }

  private async querySummary(spanFiles: string[], input: OtelSpanQueryInput): Promise<OtelSpanSummary> {
    let totalMatched = 0;
    let errorCount = 0;
    let malformedCount = 0;
    const durationsMs: number[] = [];
    const spanDurations: Map<string, { total: number; count: number }> = new Map();

    for (const filePath of spanFiles) {
      await this.streamLines(filePath, (rawLine) => {
        const rec = parseSpanRecord(rawLine);
        if (!rec || !isValidSpan(rec)) {
          malformedCount++;
          return;
        }
        if (!passesFilters(rec, input)) return;

        totalMatched++;
        if (getStatusCode(rec) === 'error') errorCount++;

        const durationMs = nanoStringToMs(rec.durationUnixNano);
        if (!isNaN(durationMs) && durationMs >= 0) {
          durationsMs.push(durationMs);
          const name = String(rec.name);
          const existing = spanDurations.get(name) ?? { total: 0, count: 0 };
          spanDurations.set(name, { total: existing.total + durationMs, count: existing.count + 1 });
        }
      });
    }

    durationsMs.sort((a, b) => a - b);
    const durationStats = durationsMs.length > 0 ? computePercentiles(durationsMs) : null;

    // Top slow span names by average duration
    const topSlowSpanNames = Array.from(spanDurations.entries())
      .map(([name, { total, count }]) => ({ name, avgMs: Math.round(total / count), count }))
      .sort((a, b) => b.avgMs - a.avgMs)
      .slice(0, OTEL_TOP_SLOW_COUNT);

    return {
      status: 'summary',
      totalMatched,
      errorCount,
      malformedCount,
      durationStats,
      topSlowSpanNames
    };
  }

  private async queryDetail(spanFiles: string[], input: OtelSpanQueryInput): Promise<OtelSpanDetail> {
    let totalMatched = 0;
    let malformedCount = 0;
    const spans: OtelSpanRecord[] = [];
    let capReached = false;

    for (const filePath of spanFiles) {
      await this.streamLines(filePath, (rawLine) => {
        const rec = parseSpanRecord(rawLine);
        if (!rec || !isValidSpan(rec)) {
          malformedCount++;
          return;
        }
        if (!passesFilters(rec, input)) return;

        totalMatched++;
        if (!capReached) {
          if (spans.length < OTEL_DETAIL_MAX_SPANS) {
            spans.push({
              traceId: String(rec.traceId),
              spanId: String(rec.spanId),
              parentSpanId: typeof rec.parentSpanId === 'string' ? rec.parentSpanId : undefined,
              name: String(rec.name),
              durationMs: Math.max(0, nanoStringToMs(rec.durationUnixNano) || 0),
              status: (rec.status !== null && typeof rec.status === 'object' && !Array.isArray(rec.status))
                ? rec.status as Record<string, unknown>
                : {},
              attributes: truncateAttributes(rec.attributes)
            });
          } else {
            capReached = true;
          }
        }
        // Continue counting totalMatched even after cap
      });
    }

    return {
      status: 'detail',
      totalMatched,
      returnedCount: spans.length,
      malformedCount,
      capped: capReached,
      spans
    };
  }

  /**
   * Stream a file line by line, calling `onLine` for each non-empty line.
   * Resolves when the file is fully read. Swallows read errors.
   */
  private streamLines(filePath: string, onLine: (line: string) => void): Promise<void> {
    return new Promise(resolve => {
      let stream: fs.ReadStream;
      try {
        stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      } catch {
        resolve();
        return;
      }
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (line.trim()) onLine(line);
      });
      rl.on('close', () => resolve());
      rl.on('error', () => resolve());
      stream.on('error', () => {
        rl.close();
        resolve();
      });
    });
  }
}
