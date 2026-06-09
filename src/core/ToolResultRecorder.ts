/**
 * ToolResultRecorder — canonical evidence writer for short-circuit tool exits.
 *
 * pi-experiment-zog2.16
 *
 * PROBLEM
 * -------
 * Several tool exit paths in wrapPluginTool (circuit-breaker, terminal-failure-
 * limit, validation-reject, worker-merge-guard) and in projectTools (deprecated,
 * extension-type, backpressure) emit TOOL_INVOCATION_FAILED or PROJECT_TOOL_FAILED
 * events WITHOUT a durable verifier-visible result handle:
 *
 *   - TOOL_INVOCATION_FAILED short-circuit exits lack `toolResult.outputFile`, so
 *     EventStore.toolResultEventMatches returns false → latestToolResultEvent
 *     returns undefined → VerifierGate treats it as TOOL_NOT_INVOKED.
 *
 *   - PROJECT_TOOL_FAILED short-circuit exits without `outputFile` are not
 *     protected by the RetentionCleanup compaction guard and may be dropped.
 *
 * SOLUTION
 * --------
 * ToolResultRecorder.recordShortCircuit() writes a minimal, content-addressed
 * failure artifact to disk and returns a ToolResultBase so callers can attach
 * it as `toolResult` on TOOL_INVOCATION_FAILED events or as `outputFile` on
 * PROJECT_TOOL_FAILED events.
 *
 * ARTIFACT FIELDS (AC2)
 * ---------------------
 * The written JSON artifact contains:
 *   path               — absolute path to this artifact (self-referential)
 *   byteCount          — byte size of the artifact JSON
 *   sha256             — hex SHA-256 of the artifact JSON content
 *   invocationId       — the tool invocation id (from ToolCallPathFactory)
 *   status             — REJECTED (always for short-circuit exits)
 *   failureCategory    — INPUT | INFRA | TRANSPORT | TIMEOUT
 *   schemaId           — 'short-circuit-failure-artifact/1.0.0'
 *   admittedFingerprint — harness build fingerprint (best-effort from env)
 *   executionBoundaryRef — 'bead:{beadId}/state:{stateId}/action:{actionId}'
 *   rejectionReason    — the human-readable reason string
 *
 * RETURNED ToolResultBase
 * -----------------------
 *   tool               — the tool name
 *   status             — REJECTED
 *   outputFile         — the absolute path to the written artifact
 *   outputFileBytes    — byte count of the artifact
 *   failureCategory    — mirrors the artifact's failureCategory
 *
 * MODEL-FACING SHAPE (AC5)
 * -------------------------
 * The ToolResultBase returned is attached to events as harness-side metadata
 * (toolResult field on TOOL_INVOCATION_FAILED, outputFile on PROJECT_TOOL_FAILED).
 * It is NOT a model-facing result — the model-facing output (the error string
 * returned by wrapPluginTool) is UNCHANGED. This is purely an additive annotation
 * on the event payload.
 *
 * COMPACTION SAFETY (AC4)
 * -------------------------
 * Evidence helpers isEvidenceBearingToolInvocationFailedEvent and
 * isEvidenceBearingProjectToolFailedEvent are exported for use by RetentionCleanup's
 * JSONL compaction guard. Events with a recorder-written artifact survive compaction
 * because they carry toolResult.outputFile / outputFile, which the compaction guard
 * already checks.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolResultBase } from '../contract.js';
import { ToolCallPathFactory } from './ToolCallPathFactory.js';
import { nodeLogger as Logger } from './Logger.js'
import { ToolResultStatus } from '../constants/domain.js';
import { Component } from '../constants/infra.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Filename of the minimal failure artifact written by recordShortCircuit(). */
export const SHORT_CIRCUIT_ARTIFACT_FILE_NAME = 'short-circuit.json';

/** Schema id embedded in every artifact (bump on incompatible shape change). */
const SHORT_CIRCUIT_SCHEMA_ID = 'short-circuit-failure-artifact/1.0.0';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Failure category for short-circuit exits. Mirrors ToolResultBase.failureCategory. */
export type ShortCircuitFailureCategory = 'INPUT' | 'INFRA' | 'TRANSPORT' | 'TIMEOUT';

/** Input to recordShortCircuit(). */
export interface RecordShortCircuitInput {
  /** The tool name as registered with Pi. */
  readonly toolName: string;
  /** The canonical per-invocation UUID (from wrapPluginTool's toolInvocationId). */
  readonly invocationId: string;
  /** The bead id at the time of the rejection (may be undefined). */
  readonly beadId: string | undefined;
  /** The state id at the time of the rejection (may be undefined). */
  readonly stateId: string | undefined;
  /** The action id at the time of the rejection (may be undefined). */
  readonly actionId: string | undefined;
  /** Always REJECTED for short-circuit exits. */
  readonly status: ToolResultStatus.REJECTED;
  /** Why the tool was rejected. */
  readonly failureCategory: ShortCircuitFailureCategory;
  /** Human-readable reason string surfaced in the event. */
  readonly rejectionReason: string;
}

// ---------------------------------------------------------------------------
// Evidence predicate helpers (AC1 / AC4)
// ---------------------------------------------------------------------------

/**
 * Returns true when a TOOL_INVOCATION_FAILED event carries a toolResult.outputFile
 * (making it evidence-bearing and eligible for compaction protection).
 *
 * Used by tests verifying AC1 and AC4. Note: RetentionCleanup uses its own
 * equivalent inline guard rather than importing these helpers.
 */
export function isEvidenceBearingToolInvocationFailedEvent(
  event: { type: string; data: unknown }
): boolean {
  if (
    event.type !== 'TOOL_INVOCATION_FAILED' &&
    event.type !== 'TOOL_INVOCATION_SUCCEEDED'
  ) return false;
  const data = event.data as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== 'object') return false;
  const toolResult = data['toolResult'] as Record<string, unknown> | null | undefined;
  if (!toolResult || typeof toolResult !== 'object') return false;
  const outputFile = toolResult['outputFile'];
  return typeof outputFile === 'string' && outputFile.length > 0;
}

/**
 * Returns true when a PROJECT_TOOL_FAILED event carries an outputFile at the top
 * level (making it evidence-bearing and eligible for compaction protection).
 *
 * Used by tests verifying AC1 and AC4. Note: RetentionCleanup uses its own
 * equivalent inline guard rather than importing these helpers.
 */
export function isEvidenceBearingProjectToolFailedEvent(
  event: { type: string; data: unknown }
): boolean {
  if (event.type !== 'PROJECT_TOOL_FAILED') return false;
  const data = event.data as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== 'object') return false;
  const outputFile = data['outputFile'];
  return typeof outputFile === 'string' && outputFile.length > 0;
}

// ---------------------------------------------------------------------------
// ToolResultRecorder
// ---------------------------------------------------------------------------

/**
 * Writes a minimal failure artifact for a short-circuit tool exit and returns
 * a ToolResultBase that can be attached to TOOL_INVOCATION_FAILED events as
 * `toolResult`, or used as `outputFile` on PROJECT_TOOL_FAILED events.
 *
 * One instance is created per extension session and shared across all
 * wrapPluginTool and projectTools short-circuit exits.
 */
export class ToolResultRecorder {
  constructor(
    private readonly factory: ToolCallPathFactory,
    private readonly projectRoot: string
  ) {}

  /**
   * Write a minimal failure artifact to disk and return a ToolResultBase.
   *
   * On error, the artifact write is SWALLOWED (like persistPluginToolRawResult)
   * and an empty-path handle is returned — a persistence failure must never
   * prevent the caller from emitting the event or returning the model-facing result.
   */
  public async recordShortCircuit(input: RecordShortCircuitInput): Promise<ToolResultBase> {
    const {
      toolName,
      invocationId,
      beadId,
      stateId,
      actionId,
      status,
      failureCategory,
      rejectionReason,
    } = input;

    // Allocate the per-invocation path from the factory.
    let allocation: import('./ToolCallPathFactory.js').ToolCallPathAllocation;
    try {
      allocation = this.factory.allocate({
        beadId,
        stateId,
        actionId,
        toolName,
        toolInvocationId: invocationId,
        projectRoot: this.projectRoot,
        worktreePath: this.projectRoot,
      });
    } catch (error) {
      Logger.warn(Component.PROJECT_TOOLS, 'ToolResultRecorder: failed to allocate path for short-circuit artifact', {
        tool: toolName, invocationId, error: String(error)
      });
      // Return a minimal stub that at least carries status so callers can proceed.
      return { tool: toolName, status, failureCategory, outputFile: '', outputFileBytes: 0 };
    }

    const artifactPath = path.join(allocation.outputDir, SHORT_CIRCUIT_ARTIFACT_FILE_NAME);
    const executionBoundaryRef = `bead:${beadId ?? 'unknown'}/state:${stateId ?? 'unknown'}/action:${actionId ?? 'unknown'}`;
    // Fingerprint is best-effort metadata for audit; 'unknown' is acceptable when
    // the env var is absent. Direct process.env reads are disallowed by the
    // runtime_env_guard, so we keep this as a static placeholder.
    const admittedFingerprint = 'unknown';

    // Build the artifact content first (without sha256) so we can hash it.
    const artifactWithoutHash = {
      path: artifactPath,
      byteCount: 0, // placeholder; replaced after serialization
      sha256: '',   // placeholder; replaced after hashing
      invocationId,
      status,
      failureCategory,
      schemaId: SHORT_CIRCUIT_SCHEMA_ID,
      admittedFingerprint,
      executionBoundaryRef,
      rejectionReason,
    };

    // Serialize, hash, then re-serialize with the hash included.
    let serialized: string;
    let digest: string;
    try {
      const preliminary = JSON.stringify(artifactWithoutHash);
      digest = createHash('sha256').update(preliminary).digest('hex');
      const finalArtifact = {
        ...artifactWithoutHash,
        byteCount: Buffer.byteLength(preliminary, 'utf8'),
        sha256: digest,
      };
      // Re-hash with the final shape (including sha256 of the preliminary)
      serialized = JSON.stringify(finalArtifact);
      // The sha256 field records the hash of the preliminary (without self-hash),
      // so readers can verify: sha256(JSON.stringify({...artifact, sha256:'', byteCount:0})) === artifact.sha256
    } catch (error) {
      Logger.warn(Component.PROJECT_TOOLS, 'ToolResultRecorder: failed to serialize short-circuit artifact', {
        tool: toolName, invocationId, error: String(error)
      });
      return { tool: toolName, status, failureCategory, outputFile: '', outputFileBytes: 0 };
    }

    const byteCount = Buffer.byteLength(serialized, 'utf8');

    try {
      await fs.promises.mkdir(allocation.outputDir, { recursive: true });
      await fs.promises.writeFile(artifactPath, serialized, 'utf8');
      Logger.debug(Component.PROJECT_TOOLS, 'ToolResultRecorder: wrote short-circuit artifact', {
        tool: toolName, invocationId, artifactPath, byteCount, failureCategory
      });
    } catch (error) {
      Logger.warn(Component.PROJECT_TOOLS, 'ToolResultRecorder: failed to write short-circuit artifact', {
        tool: toolName, invocationId, artifactPath, error: String(error)
      });
      // Return stub — the event still gets emitted; the artifact is just absent.
      return { tool: toolName, status, failureCategory, outputFile: '', outputFileBytes: 0 };
    }

    return {
      tool: toolName,
      status,
      failureCategory,
      outputFile: artifactPath,
      outputFileBytes: byteCount,
    };
  }
}
