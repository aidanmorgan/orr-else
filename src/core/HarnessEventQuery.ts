/**
 * HarnessEventQuery — bounded, schema-shaped, progressive-disclosure query tool
 * for harness domain events.
 *
 * Design goals (pi-experiment-6q0y.22):
 * - Agents get bounded visibility into domain events without reading raw logs.
 * - Default mode returns counts + latest event metadata — no full event data
 *   (token-efficient; AC2).
 * - Detail mode caps at 100 events and truncates string fields to 300 chars (AC3).
 * - A 10,000-event fixture query returns under 24 KB in default summary mode (AC4).
 * - Malformed / skipped records are counted, never inlined (AC5).
 * - Filters: beadId, eventTypes, state, action, time range, limit, cursor (AC1).
 */

import type { EventStore } from './EventStore.js';
import type { DomainEvent } from './EventStoreTypes.js';
import type { BeadId } from '../types/ids.js';
import { isRecord } from './RecordUtils.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of events returned in detail mode. */
export const DETAIL_MAX_EVENTS = 100;

/** Maximum character length for string fields in detail-mode event payloads. */
export const STRING_TRUNCATE_LENGTH = 300;

/** Maximum byte size for the serialized summary-mode result (24 KB). */
export const SUMMARY_MAX_BYTES = 24_000;

// ─── Input / Output types ─────────────────────────────────────────────────────

export interface HarnessEventQueryInput {
  /**
   * Bead ID to filter events by. When provided, only events whose data.beadId
   * or data.id matches this value are returned.
   * Mutually exclusive with readAll (when absent, all events are scanned).
   */
  beadId?: string;
  /**
   * Array of event type strings to include. When absent or empty, all event
   * types are returned.
   */
  eventTypes?: string[];
  /**
   * Filter by state ID (data.stateId or data.fromState or data.nextState).
   */
  stateId?: string;
  /**
   * Filter by action ID (data.actionId).
   */
  actionId?: string;
  /**
   * ISO 8601 timestamp — only events on or after this time are returned.
   */
  fromTime?: string;
  /**
   * ISO 8601 timestamp — only events before or at this time are returned.
   */
  toTime?: string;
  /**
   * Maximum number of events to return in detail mode.
   * Capped at DETAIL_MAX_EVENTS (100). Ignored in summary mode (default).
   */
  limit?: number;
  /**
   * Opaque pagination cursor (event ID) — only events whose ID sorts after
   * this cursor are returned (exclusive).
   */
  cursor?: string;
  /**
   * When true, return full (truncated) event payloads up to DETAIL_MAX_EVENTS.
   * Default (false): return counts + latest event metadata only.
   */
  detail?: boolean;
}

/** Minimal event metadata returned in summary mode (no full data payloads). */
export interface EventMetadataSummary {
  eventId: string;
  type: string;
  timestamp: string;
  sessionId: string;
  beadId?: string;
  stateId?: string;
  actionId?: string;
}

/** A single event record in detail mode — strings capped at STRING_TRUNCATE_LENGTH. */
export interface BoundedEventRecord {
  eventId: string;
  type: string;
  timestamp: string;
  sessionId: string;
  data: Record<string, unknown>;
}

export interface HarnessEventQuerySummary {
  status: 'summary';
  totalMatched: number;
  /** Number of records skipped due to parse/shape errors. */
  skippedCount: number;
  /** Cursor to use to page forward (last returned event ID), or null when exhausted. */
  nextCursor: string | null;
  /** Count by event type across all matched events (not just the window). */
  countByType: Record<string, number>;
  /** Metadata for the most recently timestamped matched event. */
  latestEvent: EventMetadataSummary | null;
  /** Byte estimate for this response payload. */
  byteCount: number;
}

export interface HarnessEventQueryDetail {
  status: 'detail';
  totalMatched: number;
  returnedCount: number;
  /** Number of records skipped due to parse/shape errors. */
  skippedCount: number;
  /** Cursor to use to page forward (last returned event ID), or null when exhausted. */
  nextCursor: string | null;
  /** Bounded events — strings truncated to STRING_TRUNCATE_LENGTH chars. */
  events: BoundedEventRecord[];
}

export interface HarnessEventQueryRejection {
  status: 'rejected';
  reason: string;
}

export type HarnessEventQueryResult =
  | HarnessEventQuerySummary
  | HarnessEventQueryDetail
  | HarnessEventQueryRejection;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Extract the bead ID from an event's data payload, matching EventStore conventions. */
function beadIdFrom(event: DomainEvent): string | undefined {
  const data = event.data;
  if (typeof data.beadId === 'string') return data.beadId;
  if (typeof data.id === 'string') return data.id;
  return undefined;
}

/**
 * Truncate all string values in a data record to STRING_TRUNCATE_LENGTH.
 * Recursion depth is bounded to 4 levels to avoid pathological nesting.
 */
function truncateStrings(
  value: unknown,
  depth = 0
): unknown {
  if (depth > 4) return value;
  if (typeof value === 'string') {
    return value.length > STRING_TRUNCATE_LENGTH
      ? value.slice(0, STRING_TRUNCATE_LENGTH) + '…'
      : value;
  }
  if (Array.isArray(value)) {
    return value.map(item => truncateStrings(item, depth + 1));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = truncateStrings(v, depth + 1);
    }
    return result;
  }
  return value;
}

/** Build EventMetadataSummary from a DomainEvent without including full data. */
function toMetadataSummary(event: DomainEvent): EventMetadataSummary {
  const data = event.data;
  const stateId =
    typeof data.stateId === 'string' ? data.stateId :
    typeof data.fromState === 'string' ? data.fromState :
    typeof data.nextState === 'string' ? data.nextState :
    undefined;
  return {
    eventId: String(event.id),
    type: String(event.type),
    timestamp: String(event.timestamp),
    sessionId: String(event.sessionId),
    beadId: beadIdFrom(event),
    stateId,
    actionId: typeof data.actionId === 'string' ? data.actionId : undefined
  };
}

/** Build BoundedEventRecord from a DomainEvent with string truncation. */
function toBoundedRecord(event: DomainEvent): BoundedEventRecord {
  return {
    eventId: String(event.id),
    type: String(event.type),
    timestamp: String(event.timestamp),
    sessionId: String(event.sessionId),
    data: truncateStrings(event.data, 0) as Record<string, unknown>
  };
}

/** Returns true when `event` passes the given time + identity filters. */
function passesFilters(
  event: DomainEvent,
  input: HarnessEventQueryInput
): boolean {
  // Event type filter
  if (input.eventTypes && input.eventTypes.length > 0) {
    if (!input.eventTypes.includes(String(event.type))) return false;
  }

  // State filter — any of stateId / fromState / nextState
  if (input.stateId) {
    const data = event.data;
    const matches =
      data.stateId === input.stateId ||
      data.fromState === input.stateId ||
      data.nextState === input.stateId;
    if (!matches) return false;
  }

  // Action filter
  if (input.actionId) {
    if (event.data.actionId !== input.actionId) return false;
  }

  // Time range filters
  if (input.fromTime) {
    const ts = Date.parse(event.timestamp);
    const from = Date.parse(input.fromTime);
    if (isNaN(from) || ts < from) return false;
  }
  if (input.toTime) {
    const ts = Date.parse(event.timestamp);
    const to = Date.parse(input.toTime);
    if (isNaN(to) || ts > to) return false;
  }

  // Cursor filter — skip events at or before the cursor event ID
  // Events are sorted by timestamp+id so we compare IDs lexicographically
  // (UUIDs v7 have lexicographic time ordering).
  if (input.cursor) {
    if (String(event.id) <= input.cursor) return false;
  }

  return true;
}

// ─── HarnessEventQuery class ──────────────────────────────────────────────────

export class HarnessEventQuery {
  constructor(private readonly eventStore: EventStore) {}

  public async query(input: HarnessEventQueryInput): Promise<HarnessEventQueryResult> {
    // Validate time filters
    if (input.fromTime !== undefined && isNaN(Date.parse(input.fromTime))) {
      return {
        status: 'rejected',
        reason: `Invalid fromTime: "${input.fromTime}" is not a valid ISO 8601 timestamp.`
      };
    }
    if (input.toTime !== undefined && isNaN(Date.parse(input.toTime))) {
      return {
        status: 'rejected',
        reason: `Invalid toTime: "${input.toTime}" is not a valid ISO 8601 timestamp.`
      };
    }

    // Fetch raw events
    let rawEvents: DomainEvent[];
    let skippedCount = 0;
    try {
      if (input.beadId) {
        rawEvents = await this.eventStore.eventsForBead(input.beadId as BeadId);
      } else {
        const raw = await this.eventStore.readAllRaw();
        rawEvents = raw.events;
        skippedCount = raw.skippedCount;
      }
    } catch {
      return {
        status: 'rejected',
        reason: 'Failed to read events from the event store. The store may not be initialized for this context.'
      };
    }

    // Filter — count skipped malformed records
    const matched: DomainEvent[] = [];
    for (const event of rawEvents) {
      // Shape guard: events must have type + timestamp strings
      if (typeof event.type !== 'string' || typeof event.timestamp !== 'string') {
        skippedCount++;
        continue;
      }
      if (!passesFilters(event, input)) continue;
      matched.push(event);
    }

    const totalMatched = matched.length;

    if (input.detail) {
      return this.buildDetailResult(matched, totalMatched, skippedCount, input);
    }
    return this.buildSummaryResult(matched, totalMatched, skippedCount);
  }

  private buildSummaryResult(
    matched: DomainEvent[],
    totalMatched: number,
    skippedCount: number
  ): HarnessEventQuerySummary {
    // Count by type
    const countByType: Record<string, number> = {};
    let latestEvent: DomainEvent | null = null;
    for (const event of matched) {
      const type = String(event.type);
      countByType[type] = (countByType[type] ?? 0) + 1;
      if (!latestEvent || event.timestamp > latestEvent.timestamp) {
        latestEvent = event;
      }
    }

    const latestMeta: EventMetadataSummary | null = latestEvent
      ? toMetadataSummary(latestEvent)
      : null;

    // nextCursor: last event id, or null
    const nextCursor = matched.length > 0 ? String(matched[matched.length - 1].id) : null;

    const payload: Omit<HarnessEventQuerySummary, 'byteCount'> = {
      status: 'summary',
      totalMatched,
      skippedCount,
      nextCursor,
      countByType,
      latestEvent: latestMeta
    };

    const byteCount = Buffer.byteLength(JSON.stringify(payload), 'utf8');

    return { ...payload, byteCount };
  }

  private buildDetailResult(
    matched: DomainEvent[],
    totalMatched: number,
    skippedCount: number,
    input: HarnessEventQueryInput
  ): HarnessEventQueryDetail {
    const cap = Math.min(
      typeof input.limit === 'number' && input.limit > 0 ? input.limit : DETAIL_MAX_EVENTS,
      DETAIL_MAX_EVENTS
    );
    const window = matched.slice(0, cap);
    const events = window.map(toBoundedRecord);
    const nextCursor = window.length > 0 ? String(window[window.length - 1].id) : null;

    return {
      status: 'detail',
      totalMatched,
      returnedCount: events.length,
      skippedCount,
      nextCursor,
      events
    };
  }
}
