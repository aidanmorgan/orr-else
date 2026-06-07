/**
 * builtin_handles.ts — shared canonical-handle infrastructure for Orr Else built-in tools.
 *
 * pi-experiment-zog2.2 (producer-side)
 *
 * SCOPE
 * -----
 * This module provides:
 *   1. A helper for resolving execution identity from the harness env vars.
 *   2. A function to assemble and write a full ToolEvidenceHandle given a summary + path.
 *   3. A function to build a rejected handle for failed/non-completing invocations.
 *
 * OWNERSHIP MODEL (AC3 + zog2.7)
 * --------------------------------
 * Each built-in tool's RTK summary is owned by its tool module (e.g. src/tools/harness_status.ts).
 * wrapPluginTool queries BUILTIN_RTK_SUMMARY_REGISTRY (builtin_rtk_registry.ts) after execute()
 * to get the tool-local summary, then calls assembleAndWriteBuiltInHandle() (SUCCEEDED path) or
 * buildRejectedBuiltInHandle() (FAILED path) to produce the ToolEvidenceHandle attached to the
 * event-store record as `evidenceHandle`. The model-facing response is never modified.
 *
 * FORBIDDEN (AC3 + zog2.7)
 * -------------------------
 *   - Generating RTK summaries (each tool owns its own summary in its own module)
 *   - Hard-coding schema types for specific tools (those live in tool modules)
 *   - Shared summarizer registries
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { EnvVars } from '../constants/index.js';
import {
  TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
  type ToolEvidenceHandle,
  type ToolEvidenceRtkSummary,
} from '../core/ToolEvidenceHandle.js';

// ---------------------------------------------------------------------------
// Execution identity resolver
// ---------------------------------------------------------------------------

/**
 * Resolved execution identity for a single built-in tool invocation.
 */
export interface BuiltInExecutionIdentity {
  readonly toolOutputRoot: string;
  readonly admittedHarnessFingerprint: string;
  readonly admittedExecutionBoundary: string;
}

/**
 * Resolve harness-injected execution identity from env vars.
 * Returns best-effort values; falls back gracefully when vars are absent.
 *
 * Called at invocation time (inside execute()) — NOT at module load.
 */
export function resolveBuiltInExecutionIdentity(): BuiltInExecutionIdentity {
  const projectRoot = process.env[EnvVars.PROJECT_ROOT] || process.cwd();
  const toolOutputRoot = path.resolve(projectRoot, '.pi', 'tool-output');
  // PI_HARNESS_FINGERPRINT is not in the EnvVars const (injected by the harness build pipeline).
  const admittedHarnessFingerprint = process.env['PI_HARNESS_FINGERPRINT'] || 'unknown';
  const beadId = process.env[EnvVars.BEAD_ID] || 'unknown';
  const stateId = process.env[EnvVars.STATE_ID] || 'unknown';
  const actionId = process.env[EnvVars.ACTION_ID] || 'unknown';
  const admittedExecutionBoundary = `bead:${beadId}/state:${stateId}/action:${actionId}`;
  return { toolOutputRoot, admittedHarnessFingerprint, admittedExecutionBoundary };
}

// ---------------------------------------------------------------------------
// Handle assembler (called by wrapPluginTool, not by individual tools)
// ---------------------------------------------------------------------------

/**
 * Assemble a canonical ToolEvidenceHandle for a built-in tool invocation and
 * write the handle JSON as the semantic artifact to disk.
 *
 * Called by wrapPluginTool AFTER persistPluginToolRawResult has allocated the
 * output directory. The handle JSON is written alongside plugin-raw.json.
 *
 * runStatus must reflect the actual outcome:
 *   'PASSED'   — tool ran to completion (successful or failure result).
 *   'REJECTED' — tool did not complete (thrown exception, circuit open, etc.).
 *
 * Returns the handle (with semanticArtifactPath pointing to the written file).
 * On any write error the error is swallowed and a handle without a disk artifact
 * is returned (no semantic path) — the tool result is never blocked by storage.
 */
export function assembleAndWriteBuiltInHandle(params: {
  toolName: string;
  invocationId: string;
  outputDir: string;
  rtkSummary: ToolEvidenceRtkSummary;
  runStatus?: 'PASSED' | 'REJECTED';
}): ToolEvidenceHandle {
  const identity = resolveBuiltInExecutionIdentity();
  const handleFilePath = path.join(params.outputDir, 'builtin-evidence.json');
  const runStatus = params.runStatus ?? 'PASSED';

  // Build a preliminary handle without the self-referential semanticArtifactPath first.
  const preliminaryHandle: ToolEvidenceHandle = {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: params.toolName,
    invocationId: params.invocationId,
    runStatus,
    semanticArtifactPath: handleFilePath,
    toolOutputRoot: identity.toolOutputRoot,
    summaryMode: 'summary',
    rtkSummary: params.rtkSummary,
    admittedHarnessFingerprint: identity.admittedHarnessFingerprint,
    admittedExecutionBoundary: identity.admittedExecutionBoundary,
  };

  // Write the handle JSON to disk as the semantic artifact.
  try {
    const content = JSON.stringify(preliminaryHandle, null, 2);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const finalHandle: ToolEvidenceHandle = {
      ...preliminaryHandle,
      semanticArtifactBytes: Buffer.byteLength(content, 'utf8'),
      semanticArtifactSha256: sha256,
    };
    // Write the final handle (with sha256) to disk.
    fs.mkdirSync(params.outputDir, { recursive: true });
    fs.writeFileSync(handleFilePath, JSON.stringify(finalHandle, null, 2), 'utf8');
    return finalHandle;
  } catch {
    // Write failed — return the handle without byte/sha256 (file may not exist).
    // The event-store record still carries the handle for coordinator/audit use.
    return preliminaryHandle;
  }
}

/**
 * Build a canonical ToolEvidenceHandle for a REJECTED built-in tool invocation.
 * Used when a tool exits early (validation reject, no active run, etc.).
 *
 * summaryMode='none' with a reason is the correct shape for REJECTED runs.
 * REJECTED handles do NOT require a semanticArtifactPath.
 */
export function buildRejectedBuiltInHandle(params: {
  toolName: string;
  invocationId: string;
  noSummaryReason: string;
  failureCategory?: 'INPUT' | 'INFRA' | 'TRANSPORT' | 'TIMEOUT';
}): ToolEvidenceHandle {
  const identity = resolveBuiltInExecutionIdentity();
  return {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: params.toolName,
    invocationId: params.invocationId,
    runStatus: 'REJECTED',
    ...(params.failureCategory ? { failureCategory: params.failureCategory } : {}),
    toolOutputRoot: identity.toolOutputRoot,
    summaryMode: 'none',
    noSummaryReason: params.noSummaryReason,
    admittedHarnessFingerprint: identity.admittedHarnessFingerprint,
    admittedExecutionBoundary: identity.admittedExecutionBoundary,
  };
}

// Re-export for convenience
export { TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION };
