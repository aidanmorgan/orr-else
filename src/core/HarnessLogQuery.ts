/**
 * HarnessLogQuery — bounded, progressive-disclosure query engine for harness log files.
 *
 * Design goals (pi-experiment-6q0y.24):
 * - Streams .pi/logs/orr-else-*.log without loading all logs into memory (AC1).
 * - Filters: time range, level, component, event-type text, search pattern (AC2).
 * - Default mode returns counts by level/component and latest metadata, NOT raw messages (AC3).
 * - Excerpt mode truncates messages to 300 chars and total response to 24 KB (AC4).
 * - Malformed log lines are counted and surfaced deterministically (AC5).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { OperationalArtifactPath, LoggingDefaults } from '../constants/infra.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Maximum char length for a single log message in excerpt mode. */
export const LOG_MESSAGE_MAX_CHARS = 300;

/** Maximum byte size for the serialized excerpt-mode response (24 KB). */
export const LOG_RESPONSE_MAX_BYTES = 24_000;

// ─── Input / Output types ─────────────────────────────────────────────────────

export interface HarnessLogQueryInput {
  /** ISO 8601 lower bound — only log lines at or after this time. */
  fromTime?: string;
  /** ISO 8601 upper bound — only log lines at or before this time. */
  toTime?: string;
  /** Filter by log level (e.g. 'info', 'warn', 'error', 'debug'). Case-insensitive. */
  level?: string;
  /** Filter by component field value (exact match). */
  component?: string;
  /** Filter by substring in the message field. Case-insensitive. */
  search?: string;
  /**
   * When true, return truncated log message excerpts (up to LOG_MESSAGE_MAX_CHARS)
   * capped to LOG_RESPONSE_MAX_BYTES total. Default false: return counts only.
   */
  excerpt?: boolean;
}

export interface HarnessLogSummary {
  status: 'summary';
  totalMatched: number;
  malformedCount: number;
  /** Count of matched lines by level. */
  countByLevel: Record<string, number>;
  /** Count of matched lines by component. */
  countByComponent: Record<string, number>;
  /** Metadata for the most recently timestamped matched line (no message body). */
  latestLine: { timestamp: string; level: string; component?: string } | null;
}

export interface HarnessLogExcerptEntry {
  timestamp: string;
  level: string;
  component?: string;
  /** Message truncated to LOG_MESSAGE_MAX_CHARS. */
  message: string;
}

export interface HarnessLogExcerpt {
  status: 'excerpt';
  totalMatched: number;
  returnedCount: number;
  malformedCount: number;
  /** Whether the response was capped at LOG_RESPONSE_MAX_BYTES. */
  capped: boolean;
  entries: HarnessLogExcerptEntry[];
}

export interface HarnessLogRejection {
  status: 'rejected';
  reason: string;
}

export type HarnessLogQueryResult =
  | HarnessLogSummary
  | HarnessLogExcerpt
  | HarnessLogRejection;

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface ParsedLogLine {
  timestamp: string;
  level: string;
  component?: string;
  message: string;
}

function parseLogLine(line: string): ParsedLogLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== 'object' || obj === null) return null;
    const rec = obj as Record<string, unknown>;
    if (typeof rec.timestamp !== 'string' || typeof rec.level !== 'string') return null;
    return {
      timestamp: rec.timestamp,
      level: rec.level,
      component: typeof rec.component === 'string' ? rec.component : undefined,
      message: typeof rec.message === 'string' ? rec.message : ''
    };
  } catch {
    return null;
  }
}

function passesFilters(line: ParsedLogLine, input: HarnessLogQueryInput): boolean {
  if (input.fromTime) {
    const ts = Date.parse(line.timestamp);
    const from = Date.parse(input.fromTime);
    if (isNaN(from) || ts < from) return false;
  }
  if (input.toTime) {
    const ts = Date.parse(line.timestamp);
    const to = Date.parse(input.toTime);
    if (isNaN(to) || ts > to) return false;
  }
  if (input.level) {
    if (line.level.toLowerCase() !== input.level.toLowerCase()) return false;
  }
  if (input.component) {
    if (line.component !== input.component) return false;
  }
  if (input.search) {
    if (!line.message.toLowerCase().includes(input.search.toLowerCase())) return false;
  }
  return true;
}

// ─── HarnessLogQuery class ────────────────────────────────────────────────────

export class HarnessLogQuery {
  constructor(private readonly projectRoot: string) {}

  public async query(input: HarnessLogQueryInput): Promise<HarnessLogQueryResult> {
    // Validate time filters
    if (input.fromTime !== undefined && isNaN(Date.parse(input.fromTime))) {
      return { status: 'rejected', reason: `Invalid fromTime: "${input.fromTime}" is not a valid ISO 8601 timestamp.` };
    }
    if (input.toTime !== undefined && isNaN(Date.parse(input.toTime))) {
      return { status: 'rejected', reason: `Invalid toTime: "${input.toTime}" is not a valid ISO 8601 timestamp.` };
    }

    const logDir = path.join(this.projectRoot, OperationalArtifactPath.PI_LOGS_DIR);

    // Resolve log files matching orr-else-*.log
    let logFiles: string[] = [];
    try {
      const entries = fs.readdirSync(logDir);
      logFiles = entries
        .filter(e => e.startsWith('orr-else-') && e.endsWith('.log'))
        .map(e => path.join(logDir, e))
        .sort(); // chronological by filename date
    } catch {
      // Directory absent or unreadable — return empty summary
      return {
        status: 'summary',
        totalMatched: 0,
        malformedCount: 0,
        countByLevel: {},
        countByComponent: {},
        latestLine: null
      };
    }

    if (input.excerpt) {
      return this.queryExcerpt(logFiles, input);
    }
    return this.querySummary(logFiles, input);
  }

  private async querySummary(logFiles: string[], input: HarnessLogQueryInput): Promise<HarnessLogSummary> {
    let totalMatched = 0;
    let malformedCount = 0;
    const countByLevel: Record<string, number> = {};
    const countByComponent: Record<string, number> = {};
    let latestTimestamp = '';
    let latestLine: { timestamp: string; level: string; component?: string } | null = null;

    for (const filePath of logFiles) {
      await this.streamLines(filePath, (rawLine) => {
        const parsed = parseLogLine(rawLine);
        if (!parsed) {
          malformedCount++;
          return;
        }
        if (!passesFilters(parsed, input)) return;

        totalMatched++;
        countByLevel[parsed.level] = (countByLevel[parsed.level] ?? 0) + 1;
        if (parsed.component) {
          countByComponent[parsed.component] = (countByComponent[parsed.component] ?? 0) + 1;
        }
        if (parsed.timestamp > latestTimestamp) {
          latestTimestamp = parsed.timestamp;
          latestLine = { timestamp: parsed.timestamp, level: parsed.level, component: parsed.component };
        }
      });
    }

    return {
      status: 'summary',
      totalMatched,
      malformedCount,
      countByLevel,
      countByComponent,
      latestLine
    };
  }

  private async queryExcerpt(logFiles: string[], input: HarnessLogQueryInput): Promise<HarnessLogExcerpt> {
    let totalMatched = 0;
    let malformedCount = 0;
    const entries: HarnessLogExcerptEntry[] = [];
    let capReached = false;
    let currentBytes = 0;

    // Base overhead for the response envelope
    const envelopeOverhead = 200;
    currentBytes = envelopeOverhead;

    for (const filePath of logFiles) {
      await this.streamLines(filePath, (rawLine) => {
        const parsed = parseLogLine(rawLine);
        if (!parsed) {
          malformedCount++;
          return;
        }
        if (!passesFilters(parsed, input)) return;

        totalMatched++;
        if (!capReached) {
          const truncatedMsg = parsed.message.length > LOG_MESSAGE_MAX_CHARS
            ? parsed.message.slice(0, LOG_MESSAGE_MAX_CHARS) + '…'
            : parsed.message;

          const entry: HarnessLogExcerptEntry = {
            timestamp: parsed.timestamp,
            level: parsed.level,
            component: parsed.component,
            message: truncatedMsg
          };
          const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
          if (currentBytes + entryBytes > LOG_RESPONSE_MAX_BYTES) {
            capReached = true;
            // Continue to count totalMatched
          } else {
            currentBytes += entryBytes;
            entries.push(entry);
          }
        }
        // Continue counting totalMatched even after cap
      });
    }

    return {
      status: 'excerpt',
      totalMatched,
      returnedCount: entries.length,
      malformedCount,
      capped: capReached,
      entries
    };
  }

  /**
   * Stream a file line by line, calling `onLine` for each non-empty line.
   * Resolves when the file is fully read. Swallows read errors (missing files etc).
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
