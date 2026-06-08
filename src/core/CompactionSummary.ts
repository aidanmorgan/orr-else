/**
 * pi-experiment-6q0y.35: Deterministic context compaction summary artifact.
 *
 * Generates a bounded (≤12KB) JSON summary artifact derived exclusively from
 * schema-valid events. The summary is a NON-AUTHORITATIVE digest — it NEVER
 * satisfies any artifact-first gate or route condition.
 *
 * DESIGN CONSTRAINTS (from spec ACs):
 *   AC2 NO-OP  — when disabled, this module is never called; no side effects.
 *   AC3 BOUNDED — the artifact JSON must not exceed 12KB (12_288 bytes).
 *   AC4 SCHEMA-VALID-ONLY — summary derived only from schema-valid events
 *       (fail-closed reads, post-jxdk). Synthetic events are excluded.
 *   AC5 EVIDENCE-REFS — artifact/tool refs include path, bytes, sha256 where available.
 *   AC6 NO-BODY — no raw tool output, source, log, or transcript body.
 *       Only capped scalar previews (≤200 chars) + structured evidence refs.
 *   AC7 NON-AUTHORITATIVE — summary.nonAuthoritative: true always.
 *       The pointer event also carries nonAuthoritative: true.
 *   DETERMINISM — same event history → byte-identical artifact.
 *       No Date.now(), Math.random(), or insertion-order-dependent maps.
 *
 * MODULE EXPORTS:
 *   buildCompactionSummary()      — pure derivation from events (no I/O)
 *   writeCompactionSummaryArtifact() — write JSON to disk, return bytes+sha256
 *   buildCompactionSummaryPointerPayload() — event payload for the pointer event
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DomainEventName } from '../constants/index.js';
import type { DomainEvent } from './EventStoreTypes.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum artifact size in bytes (AC3). */
export const COMPACTION_SUMMARY_MAX_BYTES = 12_288;

/** Schema version for the compaction summary artifact. */
export const COMPACTION_SUMMARY_SCHEMA_VERSION = '1.0.0';

/**
 * Maximum number of evidence refs retained (most-recent after dedup).
 * Bounds the artifact size when a bead has many tool-success events.
 */
export const EVIDENCE_REFS_CAP = 20;

/**
 * Maximum number of source event IDs retained (most-recent after dedup).
 * Bounds the artifact size when a bead has a large event history.
 */
export const SOURCE_EVENT_IDS_CAP = 50;

/**
 * Maximum characters for a capped scalar preview (AC6: no raw bodies).
 * Text longer than this is truncated + marked "[truncated]".
 */
const SCALAR_PREVIEW_CAP = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A capped scalar preview: the original string truncated to SCALAR_PREVIEW_CAP
 * characters. Never a raw body — only short descriptive text fields.
 */
export type CappedPreview = string;

/**
 * Reference to an artifact or tool output (AC5).
 * path/bytes/sha256 are included where available.
 * NO raw body is ever included (AC6).
 */
export interface EvidenceRef {
  /** Absolute or project-relative path to the artifact. */
  path?: string;
  /** File size in bytes when the artifact exists on disk. */
  bytes?: number;
  /** Full hex SHA-256 of the artifact file (AC5). */
  sha256?: string;
  /** Tool name that produced this artifact, when known. */
  tool?: string;
  /** The domain event ID this ref was extracted from. */
  sourceEventId?: string;
}

/**
 * A checkpoint submission record derived from CHECKPOINT_SUBMITTED events.
 */
export interface CheckpointRef {
  /** The source event ID. */
  eventId: string;
  /** State at time of checkpoint. */
  stateId?: string;
  /** Capped text preview (AC6). */
  summary?: CappedPreview;
}

/**
 * A blocker record derived from BEAD_STATUS_UPDATED(blocked) or similar events.
 */
export interface BlockerRef {
  /** The source event ID. */
  eventId: string;
  /** Capped reason preview (AC6). */
  reason?: CappedPreview;
}

/**
 * The deterministic compaction summary artifact shape (AC4).
 * Derived ONLY from schema-valid events.
 */
export interface CompactionSummary {
  /** Schema version for forward compatibility. */
  schemaVersion: string;
  /** The bead this summary covers. */
  beadId: string;
  /** The state this summary covers. */
  stateId: string;
  /**
   * The last action ID observed in ACTION_COMPLETED events for this bead/state.
   * Absent when no ACTION_COMPLETED was found.
   */
  lastActionId?: string;
  /**
   * Number of CONTEXT_COMPACTION_RECORDED events seen for this bead.
   * Represents how many Pi.dev autocompactions have occurred.
   */
  compactionCount: number;
  /**
   * Latest checkpoints: most recent CHECKPOINT_SUBMITTED events (up to 5).
   * Sorted by event order (most recent last). AC6: no raw body.
   */
  latestCheckpoints: CheckpointRef[];
  /**
   * Blockers: BEAD_STATUS_UPDATED events where status was 'blocked' (up to 5).
   * AC6: capped reason preview only.
   */
  blockers: BlockerRef[];
  /**
   * Next action hint: capped text from the most recent checkpoint.summary if present.
   * AC6: ≤200 chars.
   */
  nextActionHint?: CappedPreview;
  /**
   * Evidence refs: artifact/tool references extracted from schema-valid events (AC5).
   * Includes tool outputs, semantic artifact paths. NO raw bodies (AC6).
   */
  evidenceRefs: EvidenceRef[];
  /**
   * IDs of schema-valid events this summary was derived from.
   * Used in the pointer event's sourceEventIds field (AC7).
   */
  sourceEventIds: string[];
  /**
   * ALWAYS true. This summary is a non-authoritative digest.
   * It CANNOT satisfy any artifact-first gate or route condition (AC7).
   */
  nonAuthoritative: true;
}

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

/** Input to buildCompactionSummary. */
export interface CompactionSummaryInput {
  /** Bead ID for this summary. */
  beadId: string;
  /** State ID for this summary. */
  stateId: string;
  /**
   * Schema-valid events from EventStore.eventsForBead() (fail-closed reads, post-jxdk).
   * The caller is responsible for passing only schema-valid events (AC4).
   * Synthetic events must NOT be passed here.
   */
  events: DomainEvent[];
}

// ---------------------------------------------------------------------------
// Output of writing the artifact to disk
// ---------------------------------------------------------------------------

/** Result of writeCompactionSummaryArtifact. */
export interface WrittenArtifact {
  /** Absolute path where the artifact was written. */
  artifactPath: string;
  /** File size in bytes. */
  artifactBytes: number;
  /** Full hex SHA-256 digest of the file. */
  artifactSha256: string;
}

// ---------------------------------------------------------------------------
// Pure derivation logic (no I/O)
// ---------------------------------------------------------------------------

function capPreview(text: string | undefined): CappedPreview | undefined {
  if (text === undefined || text === null) return undefined;
  const s = String(text);
  if (s.length <= SCALAR_PREVIEW_CAP) return s;
  return s.slice(0, SCALAR_PREVIEW_CAP) + '… [truncated]';
}

/**
 * Extract evidence refs from a schema-valid event (AC5/AC6).
 *
 * Inspects known fields that carry artifact path/bytes/sha256 metadata.
 * NEVER inlines raw tool output or body — only structured refs.
 */
function extractEvidenceRefs(event: DomainEvent): EvidenceRef[] {
  const data = event.data as Record<string, unknown>;
  const refs: EvidenceRef[] = [];

  // semanticArtifactPath from PROJECT_TOOL_SUCCEEDED / TOOL_INVOCATION_SUCCEEDED
  const semanticPath = data['semanticArtifactPath'];
  if (typeof semanticPath === 'string' && semanticPath.length > 0) {
    const ref: EvidenceRef = {
      path: semanticPath,
      sourceEventId: event.id
    };
    const bytes = data['semanticArtifactBytes'];
    if (typeof bytes === 'number') ref.bytes = bytes;
    const sha256 = data['semanticArtifactSha256'];
    if (typeof sha256 === 'string' && sha256.length > 0) ref.sha256 = sha256;
    const tool = data['tool'];
    if (typeof tool === 'string' && tool.length > 0) ref.tool = tool;
    refs.push(ref);
  }

  // outputFile from PROJECT_TOOL_SUCCEEDED (harness wrapper archive)
  const outputFile = data['outputFile'];
  if (typeof outputFile === 'string' && outputFile.length > 0
    && outputFile !== semanticPath) {
    const ref: EvidenceRef = {
      path: outputFile,
      sourceEventId: event.id
    };
    const tool = data['tool'];
    if (typeof tool === 'string' && tool.length > 0) ref.tool = tool;
    refs.push(ref);
  }

  return refs;
}

/**
 * Build a deterministic compaction summary from schema-valid events (AC4).
 *
 * DETERMINISTIC: same event list → byte-identical output.
 * No Date.now(), Math.random(), or non-deterministic ordering.
 * Events are processed in array order (EventStore guarantees append order).
 *
 * AC6: no raw tool output, source, log, or transcript body.
 *   Only capped scalar previews (≤SCALAR_PREVIEW_CAP chars).
 */
export function buildCompactionSummary(input: CompactionSummaryInput): CompactionSummary {
  const { beadId, stateId, events } = input;

  let compactionCount = 0;
  let lastActionId: string | undefined;
  const checkpoints: CheckpointRef[] = [];
  const blockers: BlockerRef[] = [];
  const evidenceRefs: EvidenceRef[] = [];
  const sourceEventIds: string[] = [];

  for (const event of events) {
    const data = event.data as Record<string, unknown>;
    const eventId = event.id;

    switch (event.type) {
      case DomainEventName.CONTEXT_COMPACTION_RECORDED: {
        // Count how many Pi.dev autocompactions have occurred (AC4).
        compactionCount++;
        sourceEventIds.push(eventId);
        break;
      }

      case DomainEventName.ACTION_COMPLETED: {
        // Track last completed action ID.
        const actionId = data['actionId'];
        if (typeof actionId === 'string' && actionId.length > 0) {
          lastActionId = actionId;
        }
        sourceEventIds.push(eventId);
        break;
      }

      case DomainEventName.CHECKPOINT_SUBMITTED: {
        // Collect latest checkpoints (AC4: only schema-valid events).
        const checkpointStateId = data['stateId'];
        const summaryText = data['summary'] ?? data['note'] ?? data['text'];
        checkpoints.push({
          eventId,
          stateId: typeof checkpointStateId === 'string' ? checkpointStateId : undefined,
          summary: capPreview(typeof summaryText === 'string' ? summaryText : undefined)
        });
        sourceEventIds.push(eventId);
        break;
      }

      case DomainEventName.BEAD_STATUS_UPDATED: {
        // Record blocked status events as blockers.
        const status = data['status'];
        if (status === 'blocked') {
          const reason = data['reason'];
          blockers.push({
            eventId,
            reason: capPreview(typeof reason === 'string' ? reason : undefined)
          });
          sourceEventIds.push(eventId);
        }
        break;
      }

      case DomainEventName.PROJECT_TOOL_SUCCEEDED:
      case DomainEventName.TOOL_INVOCATION_SUCCEEDED: {
        // Extract evidence refs from tool success events (AC5).
        const refs = extractEvidenceRefs(event);
        if (refs.length > 0) {
          evidenceRefs.push(...refs);
          sourceEventIds.push(eventId);
        }
        break;
      }

      default:
        // All other event types: not used in the summary (AC4/AC6).
        break;
    }
  }

  // Keep only the 5 most recent checkpoints (bounded summary, AC3).
  const latestCheckpoints = checkpoints.slice(-5);

  // Keep only the 5 most recent blockers.
  const latestBlockers = blockers.slice(-5);

  // nextActionHint: capped text from the most recent checkpoint summary.
  const lastCheckpointSummary = latestCheckpoints.length > 0
    ? latestCheckpoints[latestCheckpoints.length - 1]!.summary
    : undefined;
  const nextActionHint = lastCheckpointSummary ?? undefined;

  // Deduplicate sourceEventIds while preserving first-seen order, then cap.
  const seenIds = new Set<string>();
  const dedupedSourceIds: string[] = [];
  for (const id of sourceEventIds) {
    if (!seenIds.has(id)) {
      seenIds.add(id);
      dedupedSourceIds.push(id);
    }
  }
  // Keep only the most-recent SOURCE_EVENT_IDS_CAP IDs so a large bead doesn't
  // overflow the 12KB limit (latent bug fix flagged in adversarial review).
  const boundedSourceIds = dedupedSourceIds.slice(-SOURCE_EVENT_IDS_CAP);

  // Deduplicate evidenceRefs by path (keep first seen per path), then cap.
  const seenPaths = new Set<string>();
  const dedupedRefs: EvidenceRef[] = [];
  for (const ref of evidenceRefs) {
    const key = ref.path ?? JSON.stringify(ref);
    if (!seenPaths.has(key)) {
      seenPaths.add(key);
      dedupedRefs.push(ref);
    }
  }
  // Keep only the most-recent EVIDENCE_REFS_CAP refs so a bead with many
  // tool-success events degrades gracefully instead of hitting the 12KB throw.
  const boundedRefs = dedupedRefs.slice(-EVIDENCE_REFS_CAP);

  return {
    schemaVersion: COMPACTION_SUMMARY_SCHEMA_VERSION,
    beadId,
    stateId,
    ...(lastActionId !== undefined ? { lastActionId } : {}),
    compactionCount,
    latestCheckpoints,
    blockers: latestBlockers,
    ...(nextActionHint !== undefined ? { nextActionHint } : {}),
    evidenceRefs: boundedRefs,
    sourceEventIds: boundedSourceIds,
    nonAuthoritative: true
  };
}

// ---------------------------------------------------------------------------
// Artifact serialization (deterministic)
// ---------------------------------------------------------------------------

/**
 * Serialize a CompactionSummary to a deterministic JSON string.
 *
 * Uses a stable key order so byte-identical inputs produce byte-identical output.
 * Throws if the serialized artifact exceeds COMPACTION_SUMMARY_MAX_BYTES (AC3).
 */
export function serializeCompactionSummary(summary: CompactionSummary): string {
  // JSON.stringify is deterministic for the same object structure.
  // The summary builder above uses stable insertion order (no Maps/Sets as
  // final values, no Date.now()).
  const json = JSON.stringify(summary, null, 2);
  const byteLength = Buffer.byteLength(json, 'utf8');
  if (byteLength > COMPACTION_SUMMARY_MAX_BYTES) {
    throw new Error(
      `Compaction summary artifact exceeds 12KB limit: ${byteLength} bytes. ` +
      `This is a harness bug — the summary builder must bound all collections. ` +
      `beadId=${summary.beadId} stateId=${summary.stateId}`
    );
  }
  return json;
}

// ---------------------------------------------------------------------------
// Disk write
// ---------------------------------------------------------------------------

/**
 * Write a CompactionSummary artifact to disk and return bytes + sha256 (AC5).
 *
 * Creates parent directories if needed. The artifact path must be provided by
 * the caller (derived from harness artifact path conventions).
 *
 * @param summary  The built summary (output of buildCompactionSummary).
 * @param artifactPath  Absolute path where the artifact should be written.
 * @returns WrittenArtifact with path, bytes, sha256.
 */
export function writeCompactionSummaryArtifact(
  summary: CompactionSummary,
  artifactPath: string
): WrittenArtifact {
  const json = serializeCompactionSummary(summary);
  const buf = Buffer.from(json, 'utf8');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, buf);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return {
    artifactPath,
    artifactBytes: buf.byteLength,
    artifactSha256: sha256
  };
}

// ---------------------------------------------------------------------------
// Pointer event payload builder (AC7)
// ---------------------------------------------------------------------------

/**
 * Build the COMPACTION_SUMMARY_RECORDED event payload (AC7).
 *
 * nonAuthoritative is ALWAYS true — the summary NEVER satisfies any gate.
 * sourceEventIds: the IDs of schema-valid events the summary was derived from.
 */
export function buildCompactionSummaryPointerPayload(
  beadId: string,
  stateId: string,
  written: WrittenArtifact,
  sourceEventIds: string[]
): Record<string, unknown> {
  return {
    beadId,
    stateId,
    artifactPath: written.artifactPath,
    artifactBytes: written.artifactBytes,
    artifactSha256: written.artifactSha256,
    sourceEventIds,
    nonAuthoritative: true
  };
}
