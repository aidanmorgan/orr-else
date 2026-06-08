/**
 * Test-only helpers for building canonical ToolEvidenceHandle objects
 * and VerifyContext instances with evidenceHandles.
 *
 * pi-experiment-yhec: VerifyContext now uses evidenceHandles (validated
 * canonical handles) instead of the old path-only toolOutputs map.
 * These helpers replace ctxWith(toolOutputs) and FakeToolResultStore.setFlat
 * patterns that provided only raw output paths.
 */

import type { ToolEvidenceHandle } from '../../src/core/ToolEvidenceHandle.js';
import type { VerifyContext, VerifyEvidenceHandle } from '../../src/contract.js';
import { TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION } from '../../src/core/ToolEvidenceHandle.js';

/**
 * Build a minimal valid ToolEvidenceHandle for a PASSED run.
 * All required fields are present; override any field by spreading.
 *
 * toolOutputRoot defaults to the directory containing semanticArtifactPath
 * so the path-containment check passes.
 */
export function makePassedHandle(params: {
  toolName: string;
  semanticArtifactPath: string;
  toolOutputRoot?: string;
  invocationId?: string;
  admittedHarnessFingerprint?: string;
  admittedExecutionBoundary?: string;
}): ToolEvidenceHandle {
  const toolOutputRoot = params.toolOutputRoot ?? deriveRoot(params.semanticArtifactPath);
  return {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: params.toolName,
    invocationId: params.invocationId ?? 'inv-test-001',
    runStatus: 'PASSED',
    semanticArtifactPath: params.semanticArtifactPath,
    toolOutputRoot,
    summaryMode: 'none',
    noSummaryReason: 'test fixture — no RTK summary',
    admittedHarnessFingerprint: params.admittedHarnessFingerprint ?? 'sha256:test-fingerprint',
    admittedExecutionBoundary: params.admittedExecutionBoundary ?? 'bead:bd-1/state:Implementing/action:code',
  };
}

/**
 * Build a minimal valid ToolEvidenceHandle for a REJECTED run.
 */
export function makeRejectedHandle(params: {
  toolName: string;
  toolOutputRoot: string;
  invocationId?: string;
  failureCategory?: 'TRANSPORT' | 'TIMEOUT' | 'INPUT' | 'INFRA';
  admittedHarnessFingerprint?: string;
  admittedExecutionBoundary?: string;
}): ToolEvidenceHandle {
  return {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: params.toolName,
    invocationId: params.invocationId ?? 'inv-test-rejected-001',
    runStatus: 'REJECTED',
    ...(params.failureCategory ? { failureCategory: params.failureCategory } : {}),
    toolOutputRoot: params.toolOutputRoot,
    summaryMode: 'none',
    noSummaryReason: 'test fixture — REJECTED run',
    admittedHarnessFingerprint: params.admittedHarnessFingerprint ?? 'sha256:test-fingerprint',
    admittedExecutionBoundary: params.admittedExecutionBoundary ?? 'bead:bd-1/state:Implementing/action:code',
  };
}

/**
 * Build a minimal valid ToolEvidenceHandle for an UNAVAILABLE run.
 */
export function makeUnavailableHandle(params: {
  toolName: string;
  toolOutputRoot: string;
  invocationId?: string;
  admittedHarnessFingerprint?: string;
  admittedExecutionBoundary?: string;
}): ToolEvidenceHandle {
  return {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: params.toolName,
    invocationId: params.invocationId ?? 'inv-test-unavailable-001',
    runStatus: 'UNAVAILABLE',
    toolOutputRoot: params.toolOutputRoot,
    summaryMode: 'none',
    noSummaryReason: 'test fixture — UNAVAILABLE run',
    admittedHarnessFingerprint: params.admittedHarnessFingerprint ?? 'sha256:test-fingerprint',
    admittedExecutionBoundary: params.admittedExecutionBoundary ?? 'bead:bd-1/state:Implementing/action:code',
  };
}

/**
 * Build a VerifyContext with evidenceHandles for the given tool → handle map.
 * Use in place of ctxWith(toolOutputs).
 */
export function ctxWithHandles(
  handles: Record<string, VerifyEvidenceHandle>,
  overrides: Partial<Omit<VerifyContext, 'evidenceHandles'>> = {}
): VerifyContext {
  return {
    beadId: 'bead-1',
    stateId: 'state-1',
    actionId: 'action-1',
    writeSet: [],
    artifacts: {},
    evidenceHandles: handles,
    ...overrides,
  };
}

/**
 * Derive a sensible toolOutputRoot from a semanticArtifactPath.
 * Returns the directory containing the path as the root.
 */
function deriveRoot(artifactPath: string): string {
  const idx = artifactPath.lastIndexOf('/');
  return idx > 0 ? artifactPath.slice(0, idx) : '/';
}
