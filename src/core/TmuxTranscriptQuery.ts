/**
 * TmuxTranscriptQuery — bounded, progressive-disclosure query engine for tmux
 * pane transcripts written to .pi/logs/tmux/.
 *
 * Design goals (pi-experiment-6q0y.25):
 * - Query by pane ID, bead ID, worker ID, or latest pointer (AC1 — full).
 * - Default response: metadata + at most 80 tail lines after deterministic redaction (AC2).
 * - Search mode: at most 10 hits with at most 2 context lines per hit (AC3).
 * - Missing panes / expired transcripts return structured not_found responses (AC4).
 * - Redaction is applied BEFORE truncation; path traversal is rejected (AC5).
 *
 * Bead-ID and worker-ID resolution:
 *   The bead→pane mapping is already persisted to disk via TEAMMATE_SPAWNED domain
 *   events recorded by teammates.ts. Each event payload includes { beadId, stateId,
 *   workerId, paneId }. When an EventStore handle is provided, resolution by beadId or
 *   workerId reads all events, filters to TEAMMATE_SPAWNED events matching the given
 *   identifier, takes the latest event that carries a paneId (deterministic by event
 *   insertion order), and delegates to the standard paneId read path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DomainEventName } from '../constants/domain.js';
import { OperationalArtifactPath, PaneTranscriptDefaults, sanitizePaneId } from '../constants/infra.js';
import type { EventStore } from './EventStore.js';
import type { DomainEvent } from './EventStoreTypes.js';
import { redactPaneText } from './PaneTextRedactor.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of tail lines returned in default mode. */
export const TRANSCRIPT_TAIL_LINES = 80;

/** Maximum number of search hits returned in search mode. */
export const SEARCH_MAX_HITS = 10;

/** Number of context lines returned on each side of a search hit. */
export const SEARCH_CONTEXT_LINES = 2;

// ─── Input / Output types ─────────────────────────────────────────────────────

export interface TmuxTranscriptQueryInput {
  /**
   * Pane ID (e.g. "%42") — read transcript for this specific pane.
   * Mutually exclusive with latest, beadId, workerId.
   */
  paneId?: string;
  /**
   * When true, read the transcript pointed to by current.path (the most recently
   * written pane transcript). Mutually exclusive with paneId, beadId, workerId.
   */
  latest?: boolean;
  /**
   * Bead ID — resolve to pane via the latest TEAMMATE_SPAWNED event for this bead.
   * Requires EventStore access. Mutually exclusive with paneId, latest, workerId.
   */
  beadId?: string;
  /**
   * Worker ID — resolve to pane via the latest TEAMMATE_SPAWNED event for this worker.
   * Requires EventStore access. Mutually exclusive with paneId, latest, beadId.
   */
  workerId?: string;
  /**
   * Search term — return up to SEARCH_MAX_HITS matches with SEARCH_CONTEXT_LINES
   * context lines each. Case-insensitive. When absent, default tail mode is used.
   */
  search?: string;
}

export interface TmuxTranscriptMetadata {
  paneId: string;
  transcriptPath: string;
  transcriptBytes: number;
  totalLines: number;
}

export interface TmuxTranscriptResult {
  status: 'found';
  metadata: TmuxTranscriptMetadata;
  /** Tail lines (after redaction and truncation). */
  tailLines: string[];
  /** Whether the result was truncated to TRANSCRIPT_TAIL_LINES. */
  truncated: boolean;
}

export interface TmuxTranscriptSearchHit {
  lineNumber: number;
  line: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface TmuxTranscriptSearchResult {
  status: 'search';
  metadata: TmuxTranscriptMetadata;
  hits: TmuxTranscriptSearchHit[];
  totalHits: number;
  /** Whether hits were capped at SEARCH_MAX_HITS. */
  capped: boolean;
}

export interface TmuxTranscriptNotFound {
  status: 'not_found';
  reason: string;
}

export interface TmuxTranscriptRejection {
  status: 'rejected';
  reason: string;
}

export type TmuxTranscriptQueryResult =
  | TmuxTranscriptResult
  | TmuxTranscriptSearchResult
  | TmuxTranscriptNotFound
  | TmuxTranscriptRejection;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Convert a pane ID to the safe filename form used by teammates.ts. */
function paneIdToFilename(paneId: string): string {
  return sanitizePaneId(paneId) + PaneTranscriptDefaults.FILE_SUFFIX;
}

function buildMetadata(paneId: string, transcriptPath: string, lines: string[]): TmuxTranscriptMetadata {
  let transcriptBytes = 0;
  try {
    transcriptBytes = fs.statSync(transcriptPath).size;
  } catch {
    /* best-effort */
  }
  return {
    paneId,
    transcriptPath,
    transcriptBytes,
    totalLines: lines.length
  };
}

// ─── TmuxTranscriptQuery class ────────────────────────────────────────────────

export class TmuxTranscriptQuery {
  constructor(
    private readonly projectRoot: string,
    private readonly eventStore?: EventStore
  ) {}

  public async query(input: TmuxTranscriptQueryInput): Promise<TmuxTranscriptQueryResult> {
    // Resolve beadId/workerId to paneId via TEAMMATE_SPAWNED events
    if (input.beadId || input.workerId) {
      return this.resolveViaEvent(input);
    }

    const transcriptDir = path.join(
      this.projectRoot,
      OperationalArtifactPath.PI_TMUX_TRANSCRIPTS_DIR
    );

    // Resolve transcript path
    let resolvedPaneId: string;
    let transcriptPath: string;

    if (input.paneId) {
      resolvedPaneId = input.paneId;
      // Path traversal guard: pane ID must not contain path separators or ..
      if (
        resolvedPaneId.includes('/') ||
        resolvedPaneId.includes('\\') ||
        resolvedPaneId.includes('..')
      ) {
        return {
          status: 'rejected',
          reason: `paneId contains illegal path characters: "${resolvedPaneId}"`
        };
      }
      const filename = paneIdToFilename(resolvedPaneId);
      transcriptPath = path.join(transcriptDir, filename);
      // Path traversal guard: resolved path must stay inside transcriptDir
      const resolvedTranscript = path.resolve(transcriptPath);
      const resolvedDir = path.resolve(transcriptDir);
      if (!resolvedTranscript.startsWith(resolvedDir + path.sep) && resolvedTranscript !== resolvedDir) {
        return {
          status: 'rejected',
          reason: `Resolved transcript path escapes the transcript directory.`
        };
      }
    } else if (input.latest) {
      const pointerPath = path.join(transcriptDir, PaneTranscriptDefaults.POINTER_FILENAME);
      let pointed: string;
      try {
        pointed = fs.readFileSync(pointerPath, 'utf8').trim();
      } catch {
        return { status: 'not_found', reason: 'No current transcript pointer found. No pane transcript has been recorded yet.' };
      }
      // Path traversal guard: pointer must stay inside transcriptDir
      const resolvedPointed = path.resolve(pointed);
      const resolvedDir = path.resolve(transcriptDir);
      if (!resolvedPointed.startsWith(resolvedDir + path.sep) && resolvedPointed !== resolvedDir) {
        return {
          status: 'rejected',
          reason: `Pointer target escapes the transcript directory.`
        };
      }
      transcriptPath = resolvedPointed;
      // Derive pane ID from filename: strip suffix
      const basename = path.basename(transcriptPath);
      resolvedPaneId = basename.endsWith(PaneTranscriptDefaults.FILE_SUFFIX)
        ? basename.slice(0, -PaneTranscriptDefaults.FILE_SUFFIX.length)
        : basename;
    } else {
      return {
        status: 'rejected',
        reason: 'One of paneId, latest:true, beadId, or workerId must be provided.'
      };
    }

    // Read transcript
    let rawContent: string;
    try {
      rawContent = fs.readFileSync(transcriptPath, 'utf8');
    } catch {
      return {
        status: 'not_found',
        reason: `Transcript not found for pane "${resolvedPaneId}". The pane may be expired or not yet recorded.`
      };
    }

    // Redaction BEFORE truncation (AC5)
    const redacted = redactPaneText(rawContent);
    const allLines = redacted.split('\n');
    const metadata = buildMetadata(resolvedPaneId, transcriptPath, allLines);

    if (input.search) {
      return this.buildSearchResult(metadata, allLines, input.search);
    }
    return this.buildTailResult(metadata, allLines);
  }

  /**
   * Resolve beadId or workerId to a paneId via persisted TEAMMATE_SPAWNED events,
   * then delegate to the standard paneId read path.
   *
   * Takes the LATEST TEAMMATE_SPAWNED event (by insertion order) that matches the
   * given identifier AND carries a paneId. Latest-wins is deterministic: when a
   * bead is re-spawned, the newest spawn's pane is authoritative.
   */
  private async resolveViaEvent(input: TmuxTranscriptQueryInput): Promise<TmuxTranscriptQueryResult> {
    if (!this.eventStore) {
      return {
        status: 'not_found',
        reason: 'EventStore not available — cannot resolve by beadId or workerId.'
      };
    }

    const label = input.beadId ? `beadId "${input.beadId}"` : `workerId "${input.workerId}"`;

    let allEvents: { events: DomainEvent[]; skippedCount: number };
    try {
      allEvents = await this.eventStore.readAllRaw();
    } catch {
      return {
        status: 'not_found',
        reason: `Failed to read events while resolving ${label}.`
      };
    }

    // Filter to TEAMMATE_SPAWNED events matching the identifier, preserve insertion order
    const spawns = allEvents.events.filter(e => {
      if (e.type !== DomainEventName.TEAMMATE_SPAWNED) return false;
      if (input.beadId) return e.data['beadId'] === input.beadId;
      return e.data['workerId'] === input.workerId;
    });

    // Latest-wins: last in insertion order that has a paneId
    let resolvedPaneId: string | undefined;
    for (let i = spawns.length - 1; i >= 0; i--) {
      const paneId = spawns[i].data['paneId'];
      if (typeof paneId === 'string' && paneId.length > 0) {
        resolvedPaneId = paneId;
        break;
      }
    }

    if (!resolvedPaneId) {
      return {
        status: 'not_found',
        reason: `No TEAMMATE_SPAWNED event with a paneId found for ${label}.`
      };
    }

    return this.query({ paneId: resolvedPaneId, search: input.search });
  }

  private buildTailResult(
    metadata: TmuxTranscriptMetadata,
    lines: string[]
  ): TmuxTranscriptResult {
    const truncated = lines.length > TRANSCRIPT_TAIL_LINES;
    const tailLines = truncated ? lines.slice(-TRANSCRIPT_TAIL_LINES) : lines;
    return {
      status: 'found',
      metadata,
      tailLines,
      truncated
    };
  }

  private buildSearchResult(
    metadata: TmuxTranscriptMetadata,
    lines: string[],
    search: string
  ): TmuxTranscriptSearchResult {
    const lowerSearch = search.toLowerCase();
    const hits: TmuxTranscriptSearchHit[] = [];
    let totalHits = 0;

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(lowerSearch)) continue;
      totalHits++;
      if (hits.length < SEARCH_MAX_HITS) {
        const contextBefore = lines.slice(Math.max(0, i - SEARCH_CONTEXT_LINES), i);
        const contextAfter = lines.slice(i + 1, i + 1 + SEARCH_CONTEXT_LINES);
        hits.push({
          lineNumber: i + 1,
          line: lines[i],
          contextBefore,
          contextAfter
        });
      }
    }

    return {
      status: 'search',
      metadata,
      hits,
      totalHits,
      capped: totalHits > SEARCH_MAX_HITS
    };
  }
}
