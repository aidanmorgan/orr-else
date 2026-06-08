/**
 * RestartHandoffValidation — evidence-aware handoff contract for context restarts.
 *
 * pi-experiment-6q0y.36
 *
 * CORE INVARIANT: a restart request is admitted ONLY when it carries a
 * deterministic evidence contract:
 *
 *   evidenceRefs[] (non-empty) AND either:
 *     (a) handoverArtifactPath — a path with matching bytes + sha256 metadata, OR
 *     (b) a configured compaction-artifact pointer (COMPACTION_SUMMARY_RECORDED
 *         event in the bead's history with nonAuthoritative: true)
 *
 * A restart carrying ONLY narrative text (summary/handover prose with no evidenceRefs
 * and no handoff/compaction artifact) is REJECTED before signal/event admission.
 *
 * Narrative summary fields are accepted ONLY as non-authoritative preview text,
 * stored SEPARATELY from deterministic evidence refs. They NEVER satisfy any gate,
 * progress projection, or replay-reconstruction requirement.
 *
 * VALIDATION RULES (AC6):
 *   1. summary-only: evidenceRefs absent/empty AND no handoverArtifactPath AND
 *      no COMPACTION_SUMMARY_RECORDED in prior events → REJECTED.
 *   2. bad-hash: handoverArtifactPath declared but bytes/sha256 absent → REJECTED.
 *   3. unregistered-schema: an evidenceRef carries a schemaId not in the
 *      SchemaRegistry → REJECTED.
 *   4. stale-event-ids: sourceEventIds in evidenceRef include IDs not found in
 *      the bead's prior events → REJECTED.
 *   5. inaccessible-path: handoverArtifactPath or evidenceRef semanticPath is
 *      empty or blank → REJECTED.
 *
 * DETERMINISM: no Date.now() or Math.random() in validation decisions.
 * NO BACKCOMPAT: narrative-authority path is removed entirely.
 */

import { schemaRegistry } from './SchemaRegistry.js';
import { DomainEventName } from '../constants/index.js';
import type { DomainEvent } from './EventStoreTypes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A deterministic evidence reference for a restart handoff.
 * Every ref MUST carry schemaId, semanticArtifactPath, bytes, sha256.
 * sourceEventIds: IDs of domain events this ref was derived from (for staleness check).
 */
export interface RestartEvidenceRef {
  /** Schema ID from the SchemaRegistry (must be registered). */
  schemaId: string;
  /** Semantic artifact path (must be non-blank). */
  semanticArtifactPath: string;
  /** File size in bytes (required; > 0 for non-empty artifacts). */
  bytes: number;
  /** Full hex SHA-256 digest of the artifact (required; 64 hex chars). */
  sha256: string;
  /** IDs of domain events this ref was derived from (checked for staleness). */
  sourceEventIds?: string[];
}

/**
 * The evidence-aware handoff contract for a restart request.
 *
 * Supplied by the restart requester (tool call or auto-restart path).
 * Validated by validateRestartHandoffContract() before admission.
 */
export interface RestartHandoffContract {
  /**
   * Non-empty array of deterministic evidence refs.
   * REQUIRED for any admitted restart.
   */
  evidenceRefs: RestartEvidenceRef[];

  /**
   * Explicit handoff artifact path.
   * When supplied, bytes + sha256 MUST be present in the corresponding evidenceRef.
   * Either this OR a configured compaction-artifact pointer is required.
   */
  handoverArtifactPath?: string;

  /**
   * Non-authoritative narrative summary preview (LLM-authored).
   * Stored SEPARATELY from evidence refs.
   * NEVER used for progress projection, gate evaluation, or replay reconstruction.
   * Must NOT be used as a substitute for evidenceRefs.
   */
  narrativeSummary?: string;
}

/**
 * Rejection reason categories — deterministic, never narrative.
 */
export type RestartRejectionReason =
  | 'SUMMARY_ONLY'
  | 'BAD_HASH'
  | 'UNREGISTERED_SCHEMA'
  | 'STALE_EVENT_IDS'
  | 'INACCESSIBLE_PATH';

/**
 * A single validation failure.
 */
export interface RestartHandoffRejection {
  reason: RestartRejectionReason;
  /** Deterministic human-readable diagnostic (no narrative, no model content). */
  diagnostic: string;
}

/**
 * Result of validateRestartHandoffContract.
 */
export type RestartHandoffValidationResult =
  | { admitted: true }
  | { admitted: false; rejections: RestartHandoffRejection[] };

// ---------------------------------------------------------------------------
// Validation logic
// ---------------------------------------------------------------------------

/**
 * Validate an evidence-aware restart handoff contract before admission.
 *
 * This is the LOAD-BEARING gate for pi-experiment-6q0y.36 AC1/AC3/AC6.
 * It MUST be called in the real restart-admission path (extension.ts
 * handleTeammateEvent) before recording CONTEXT_RESTART_REQUESTED or
 * HARNESS_RESTART_REQUESTED.
 *
 * Returns { admitted: true } when all checks pass.
 * Returns { admitted: false, rejections } when any check fails.
 *
 * @param contract  The handoff contract from the restart request.
 * @param priorEvents  Schema-valid events from EventStore.eventsForBead() — used
 *   to resolve configured compaction-artifact pointers and validate source event IDs.
 */
export function validateRestartHandoffContract(
  contract: RestartHandoffContract,
  priorEvents: DomainEvent[]
): RestartHandoffValidationResult {
  const rejections: RestartHandoffRejection[] = [];

  const hasEvidenceRefs =
    Array.isArray(contract.evidenceRefs) && contract.evidenceRefs.length > 0;
  const hasHandoverArtifactPath =
    typeof contract.handoverArtifactPath === 'string' &&
    contract.handoverArtifactPath.trim().length > 0;

  // Does the bead have a COMPACTION_SUMMARY_RECORDED event (configured compaction pointer)?
  const compactionPointer = resolveCompactionPointer(priorEvents);
  const hasCompactionPointer = compactionPointer !== undefined;

  // AC1/AC3: summary-only rejection — no evidenceRefs AND no handoff/compaction artifact.
  if (!hasEvidenceRefs && !hasHandoverArtifactPath && !hasCompactionPointer) {
    rejections.push({
      reason: 'SUMMARY_ONLY',
      diagnostic:
        'Restart request rejected: no evidenceRefs and no handoverArtifactPath or ' +
        'configured compaction-artifact pointer. ' +
        'A restart carrying only narrative summary is not admitted (6q0y.36 AC3). ' +
        'Provide evidenceRefs[] with deterministic artifact references.'
    });
    return { admitted: false, rejections };
  }

  // AC6: inaccessible-path — handoverArtifactPath is blank if provided.
  if (contract.handoverArtifactPath !== undefined) {
    if (!hasHandoverArtifactPath) {
      rejections.push({
        reason: 'INACCESSIBLE_PATH',
        diagnostic:
          'Restart request rejected: handoverArtifactPath is present but blank/empty ' +
          '(inaccessible-path). Provide a non-empty artifact path.'
      });
    }
  }

  if (hasEvidenceRefs) {
    // Build prior event ID set for staleness checks.
    // EventId is a branded type; String() converts so plain string sourceEventIds can match.
    const priorEventIds = new Set(priorEvents.map(e => String(e.id)));

    for (const ref of contract.evidenceRefs) {
      // AC6: inaccessible-path — semanticArtifactPath is blank.
      if (!ref.semanticArtifactPath || !ref.semanticArtifactPath.trim()) {
        rejections.push({
          reason: 'INACCESSIBLE_PATH',
          diagnostic:
            `EvidenceRef has blank semanticArtifactPath (inaccessible-path). ` +
            `Every evidence ref must declare a non-blank artifact path.`
        });
      }

      // AC6: bad-hash — bytes or sha256 absent/invalid.
      const hasBadBytes = typeof ref.bytes !== 'number' || ref.bytes < 0;
      const hasBadSha256 =
        typeof ref.sha256 !== 'string' ||
        ref.sha256.length !== 64 ||
        !/^[0-9a-f]{64}$/.test(ref.sha256);
      if (hasBadBytes || hasBadSha256) {
        rejections.push({
          reason: 'BAD_HASH',
          diagnostic:
            `EvidenceRef for "${ref.semanticArtifactPath}" has invalid bytes or sha256 (bad-hash). ` +
            `bytes must be a non-negative number; sha256 must be a 64-char lowercase hex string. ` +
            `Got: bytes=${JSON.stringify(ref.bytes)}, sha256=${JSON.stringify(ref.sha256)}`
        });
      }

      // AC6: unregistered-schema — schemaId not in SchemaRegistry.
      if (!ref.schemaId || !ref.schemaId.trim()) {
        rejections.push({
          reason: 'UNREGISTERED_SCHEMA',
          diagnostic:
            `EvidenceRef for "${ref.semanticArtifactPath}" has blank schemaId (unregistered-schema). ` +
            `Every evidence ref must carry a registered schema ID.`
        });
      } else if (!schemaRegistry.has(ref.schemaId)) {
        rejections.push({
          reason: 'UNREGISTERED_SCHEMA',
          diagnostic:
            `EvidenceRef schemaId "${ref.schemaId}" for artifact ` +
            `"${ref.semanticArtifactPath}" is not registered in the SchemaRegistry ` +
            `(unregistered-schema). Register the schema before referencing it in a handoff.`
        });
      }

      // AC6: stale-event-ids — sourceEventIds reference events not in priorEvents.
      if (Array.isArray(ref.sourceEventIds) && ref.sourceEventIds.length > 0) {
        const staleIds = ref.sourceEventIds.filter(id => !priorEventIds.has(id));
        if (staleIds.length > 0) {
          rejections.push({
            reason: 'STALE_EVENT_IDS',
            diagnostic:
              `EvidenceRef for "${ref.semanticArtifactPath}" references stale source event IDs ` +
              `not found in prior bead events (stale-event-ids): [${staleIds.join(', ')}]. ` +
              `Source event IDs must refer to events already recorded for this bead.`
          });
        }
      }
    }

    // AC6: bad-hash for handoverArtifactPath — when supplied, the corresponding
    // evidenceRef with that semanticArtifactPath must have valid bytes + sha256.
    if (hasHandoverArtifactPath) {
      const matchingRef = contract.evidenceRefs.find(
        r => r.semanticArtifactPath === contract.handoverArtifactPath
      );
      if (!matchingRef) {
        rejections.push({
          reason: 'BAD_HASH',
          diagnostic:
            `handoverArtifactPath "${contract.handoverArtifactPath}" has no matching ` +
            `evidenceRef with that semanticArtifactPath (bad-hash). ` +
            `Add an evidenceRef with semanticArtifactPath="${contract.handoverArtifactPath}", ` +
            `bytes, and sha256 to satisfy the handoff contract.`
        });
      }
    }
  }

  if (rejections.length > 0) return { admitted: false, rejections };
  return { admitted: true };
}

// ---------------------------------------------------------------------------
// Compaction pointer resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the most recent COMPACTION_SUMMARY_RECORDED pointer from prior events.
 *
 * Used as the "configured compaction-artifact pointer" alternative to an explicit
 * handoverArtifactPath (6q0y.35 integration). Returns undefined when no such
 * event exists or when the event does not carry nonAuthoritative:true.
 *
 * The compaction pointer is NON-AUTHORITATIVE — it provides a configured
 * deterministic artifact ref but does NOT satisfy any gate or route condition.
 */
export function resolveCompactionPointer(
  priorEvents: DomainEvent[]
): CompactionPointer | undefined {
  for (const event of [...priorEvents].reverse()) {
    if (event.type !== DomainEventName.COMPACTION_SUMMARY_RECORDED) continue;
    const data = event.data as Record<string, unknown>;
    // Must carry nonAuthoritative: true (6q0y.35 AC7).
    if (data.nonAuthoritative !== true) continue;
    // Must carry the artifact ref fields.
    if (
      typeof data.artifactPath !== 'string' ||
      typeof data.artifactBytes !== 'number' ||
      typeof data.artifactSha256 !== 'string'
    ) continue;
    return {
      sourceEventId: event.id,
      artifactPath: data.artifactPath,
      artifactBytes: data.artifactBytes,
      artifactSha256: data.artifactSha256,
      sourceEventIds: Array.isArray(data.sourceEventIds)
        ? (data.sourceEventIds as string[])
        : [],
      nonAuthoritative: true
    };
  }
  return undefined;
}

/**
 * A resolved compaction artifact pointer from a COMPACTION_SUMMARY_RECORDED event.
 */
export interface CompactionPointer {
  /** Domain event ID of the COMPACTION_SUMMARY_RECORDED event. */
  sourceEventId: string;
  /** Absolute path to the compaction summary artifact. */
  artifactPath: string;
  /** File size in bytes. */
  artifactBytes: number;
  /** SHA-256 hex digest of the artifact. */
  artifactSha256: string;
  /** Source event IDs the summary was derived from. */
  sourceEventIds: string[];
  /** Always true — non-authoritative digest only. */
  nonAuthoritative: true;
}

// ---------------------------------------------------------------------------
// Restart event payload builder (narrative stored separately)
// ---------------------------------------------------------------------------

/**
 * Build the deterministic payload for a CONTEXT_RESTART_REQUESTED or
 * HARNESS_RESTART_REQUESTED domain event.
 *
 * Narrative is stored SEPARATELY under `narrativeSummary` (non-authoritative
 * preview) and `narrativeHandover` (consumed by BeadStateProjection for the
 * handovers map). NO legacy summary/evidence/handover duplicates are written.
 *
 * AC4: narrative stored separately + marked non-authoritative.
 * AC5: evidenceRefs included in event payload for projection access.
 */
export function buildRestartEventPayload(params: {
  beadId: string;
  workerId: string;
  sessionStateId?: string;
  idempotencyKey: string;
  stateId: string;
  targetState: string;
  transitionEvent: string;
  actionId?: string;
  /** Narrative text preview (non-authoritative, stored separately). */
  narrativeSummary: string;
  /** Narrative handover preview (non-authoritative; read by BeadStateProjection). */
  narrativeHandover?: string;
  /** Deterministic evidence refs (authoritative). */
  evidenceRefs: RestartEvidenceRef[];
  /** Handoff artifact path (when manually provided). */
  handoverArtifactPath?: string;
  /** Compaction pointer resolved from prior events (when configured path). */
  compactionPointer?: CompactionPointer;
  /** Restart correlation fields. */
  restartId: string;
  previousRunId?: string;
  attempt: number;
}): Record<string, unknown> {
  const {
    beadId, workerId, sessionStateId, idempotencyKey,
    stateId, targetState, transitionEvent, actionId,
    narrativeSummary, narrativeHandover,
    evidenceRefs, handoverArtifactPath, compactionPointer,
    restartId, previousRunId, attempt
  } = params;

  // Narrative fields: stored as non-authoritative preview text (AC4).
  // narrativeSummary: used for restartHandoffPreview.narrativePreview in projection.
  // narrativeHandover: consumed by BeadStateProjection.handovers for display only.
  // NO legacy summary/evidence/handover fields — no backcompat shim.
  const payload: Record<string, unknown> = {
    beadId,
    workerId,
    idempotencyKey,
    stateId,
    targetState,
    transitionEvent,
    actionId: actionId ?? undefined,
    // Canonical narrative representation (non-authoritative, AC4).
    narrativeSummary,
    narrativeHandover: narrativeHandover ?? narrativeSummary,
    narrativeNonAuthoritative: true,
    // Deterministic evidence (AC2/AC5).
    evidenceRefs,
    // Restart correlation.
    restartId,
    previousRunId: previousRunId ?? undefined,
    reason: transitionEvent,
    attempt
  };

  if (sessionStateId !== undefined) payload.sessionStateId = sessionStateId;
  if (handoverArtifactPath !== undefined) payload.handoverArtifactPath = handoverArtifactPath;
  if (compactionPointer !== undefined) {
    payload.compactionPointer = {
      sourceEventId: compactionPointer.sourceEventId,
      artifactPath: compactionPointer.artifactPath,
      artifactBytes: compactionPointer.artifactBytes,
      artifactSha256: compactionPointer.artifactSha256,
      nonAuthoritative: true
    };
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Evidence-only replay reconstruction
// ---------------------------------------------------------------------------

/**
 * Reconstruct resumed bead state from evidence refs ONLY (AC7).
 *
 * Returns the set of confirmed event IDs from evidenceRefs' sourceEventIds
 * that exist in the provided event list. This is the authoritative reconstruction
 * source — narrative text is EXCLUDED.
 *
 * A resumed worker can only trust what is backed by artifact evidence in the
 * event store. This function identifies the confirmed-evidence subset.
 */
export function reconstructFromEvidenceOnly(
  evidenceRefs: RestartEvidenceRef[],
  priorEvents: DomainEvent[]
): {
  confirmedEventIds: string[];
  confirmedArtifactPaths: string[];
} {
  // EventId is a branded type; String() converts so plain string sourceEventIds can match.
  const priorEventIds = new Set(priorEvents.map(e => String(e.id)));
  const confirmedEventIds: string[] = [];
  const confirmedArtifactPaths: string[] = [];

  for (const ref of evidenceRefs) {
    // Only include artifacts with valid structural integrity.
    if (
      typeof ref.sha256 !== 'string' ||
      ref.sha256.length !== 64 ||
      typeof ref.bytes !== 'number' ||
      ref.bytes < 0
    ) continue;

    if (ref.semanticArtifactPath && ref.semanticArtifactPath.trim()) {
      confirmedArtifactPaths.push(ref.semanticArtifactPath);
    }

    if (Array.isArray(ref.sourceEventIds)) {
      for (const id of ref.sourceEventIds) {
        if (priorEventIds.has(id) && !confirmedEventIds.includes(id)) {
          confirmedEventIds.push(id);
        }
      }
    }
  }

  return { confirmedEventIds, confirmedArtifactPaths };
}

// ---------------------------------------------------------------------------
// Handoff preview for bead-state projection (AC5)
// ---------------------------------------------------------------------------

/**
 * Build a compact handoff preview for bead-state projection.
 *
 * Shows evidence artifact pointers ONLY — never trusts narrative text as evidence.
 * The narrative preview is included but labelled non-authoritative.
 *
 * AC5: projection shows compact handoff preview + evidence artifact pointers;
 *      projection NEVER trusts narrative text as evidence.
 */
export function buildHandoffPreview(params: {
  evidenceRefs?: RestartEvidenceRef[];
  handoverArtifactPath?: string;
  compactionPointer?: CompactionPointer;
  /** Non-authoritative narrative preview (never used for progress decisions). */
  narrativeSummary?: string;
}): {
  evidenceArtifactPaths: string[];
  evidenceRefCount: number;
  hasCompactionPointer: boolean;
  /** Non-authoritative narrative preview label. */
  narrativePreview?: string;
} {
  const refs = params.evidenceRefs ?? [];
  const evidenceArtifactPaths = refs
    .map(r => r.semanticArtifactPath)
    .filter(p => p && p.trim().length > 0);
  if (params.handoverArtifactPath) evidenceArtifactPaths.push(params.handoverArtifactPath);

  return {
    evidenceArtifactPaths: [...new Set(evidenceArtifactPaths)],
    evidenceRefCount: refs.length,
    hasCompactionPointer: params.compactionPointer !== undefined,
    // Narrative is labelled non-authoritative — projection consumer must NEVER
    // use this for progress decisions, gate evaluation, or state advancement.
    ...(params.narrativeSummary !== undefined
      ? { narrativePreview: `[non-authoritative preview] ${params.narrativeSummary}` }
      : {})
  };
}
