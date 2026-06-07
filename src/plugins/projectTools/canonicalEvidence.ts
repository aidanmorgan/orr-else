/**
 * canonicalEvidence — opt-in canonical evidence extraction and validation for
 * command/tsProjectTool execution in executeConfiguredProjectTool.
 *
 * pi-experiment-zog2.3 (producer-half)
 *
 * DESIGN INTENT
 * -------------
 * A command/tsProjectTool subprocess opts into the canonical evidence path by
 * printing a JSON result object to stdout that includes an `evidenceHandle` field
 * containing a ToolEvidenceHandle-shaped object. The harness detects this opt-in
 * by looking for `evidenceHandle` in the raw command result's stdout JSON
 * (available as rawResult[ProjectToolResultKey.STDOUT] before the model-facing
 * result strips internal keys).
 *
 * OPT-IN SIGNAL
 * -------------
 * A tool is on the canonical evidence path if and only if the raw command result
 * (from executeCommandTool) carries a JSON-parseable stdout that contains an
 * `evidenceHandle` field at the top level. Legacy tools (cerdiwen tools etc.) that
 * do NOT emit `evidenceHandle` are untouched — their existing outputFile envelope
 * and legacy verify() behaviour are preserved.
 *
 * REJECTION RULES (for canonical-path tools only)
 * -----------------------------------------------
 * The validator rejects (REJECTED + deterministic error message) when:
 *   1. The evidenceHandle fails validateToolEvidenceHandle (structural).
 *   2. A PASSED run is missing semanticArtifactPath (zog2.8).
 *   3. The rtkSummary.owningFile does not end with .ts (non-TypeScript summarizer).
 *   4. The rtkSummary is absent on a PASSED handle (summaryMode must be 'summary').
 *   5. The command stdout itself is a child ToolResultBase payload (legacy shape).
 *   6. The semanticArtifactPath is a raw transport archive path (stdoutFile/stderrFile).
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 *   - Does NOT generate summaries from stdout/stderr (no generic summarizer).
 *   - Does NOT parse or inspect the rtkSummary.summary payload content.
 *   - Does NOT rewrite the command result envelope.
 *   - Does NOT touch legacy (non-canonical) tools.
 *
 * Package-internal — do not import from outside src/plugins/.
 */

import {
  validateToolEvidenceHandle,
  type ToolEvidenceHandle,
  type ValidToolEvidenceHandle,
  type InvalidToolEvidenceHandle,
} from '../../core/ToolEvidenceHandle.js';
import { isJsonRecord, parseJsonRecord } from './utils.js';
import { ProjectToolResultKey } from './constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The stdout key on a raw command result (before model-facing stripping).
 * Matches ProjectToolResultKey.STDOUT = 'stdout'.
 */
const STDOUT_KEY = ProjectToolResultKey.STDOUT;

/**
 * Key on the subprocess result JSON that signals canonical evidence opt-in.
 * A subprocess that writes a ToolEvidenceHandle to this key is on the canonical path.
 */
const EVIDENCE_HANDLE_KEY = 'evidenceHandle';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result from extractCanonicalEvidence().
 *
 * non-canonical  — the raw result has no evidenceHandle; tool is on legacy path.
 * valid          — evidenceHandle present and passes validateToolEvidenceHandle.
 * rejected       — evidenceHandle present but fails validation; error messages are deterministic.
 */
export type CanonicalEvidenceExtraction =
  | { readonly kind: 'non-canonical' }
  | { readonly kind: 'valid'; readonly handle: ToolEvidenceHandle; readonly validation: ValidToolEvidenceHandle }
  | { readonly kind: 'rejected'; readonly errors: string[]; readonly rejectionReason: string };

// ---------------------------------------------------------------------------
// extractCanonicalEvidence
// ---------------------------------------------------------------------------

/**
 * Extract and validate canonical evidence from a raw command tool result.
 *
 * Returns `{ kind: 'non-canonical' }` when the raw result has no evidenceHandle
 * in its stdout JSON — the tool is on the legacy path and is untouched.
 *
 * Returns `{ kind: 'valid', handle }` when the evidenceHandle passes all
 * validateToolEvidenceHandle checks and all canonical-path rules.
 *
 * Returns `{ kind: 'rejected', errors, rejectionReason }` when the tool is on
 * the canonical path (evidenceHandle present) but the handle fails validation.
 * The errors list is deterministic and suitable for a REJECTED tool result.
 *
 * @param rawResult   — the raw object returned by executeCommandTool (before
 *                      persistAndBoundResult strips internal keys).
 * @param projectRoot — absolute path to the project root. When provided, project-tool
 *                      rtkSummary.owningFile paths (not under src/) are validated to
 *                      exist on disk (6q0y.12 production threading).
 */
export function extractCanonicalEvidence(rawResult: unknown, projectRoot?: string): CanonicalEvidenceExtraction {
  // Detect the opt-in signal: stdout JSON with an evidenceHandle field.
  const evidenceHandle = extractEvidenceHandleFromStdout(rawResult);
  if (evidenceHandle === undefined) {
    return { kind: 'non-canonical' };
  }

  // Tool is on the canonical path. Run all rejection checks.
  const errors: string[] = [];

  // ---- Check 1: Reject child ToolResultBase stdout payloads (legacy shape) ----
  // A ToolResultBase stdout payload has { tool, status, outputFile } at the top
  // level of the evidenceHandle — this is the legacy shape and is rejected.
  if (isLegacyToolResultBaseShape(evidenceHandle)) {
    errors.push(
      'canonical-path violation: evidenceHandle looks like a ToolResultBase payload ' +
      '(has "tool", "status", "outputFile" at the top level). ' +
      'Command tools on the canonical path must emit a ToolEvidenceHandle, ' +
      'not a ToolResultBase. The tool must write a ToolEvidenceHandle to PI_TOOL_OUTPUT_FILE ' +
      'and include it as evidenceHandle in its JSON stdout.'
    );
    return { kind: 'rejected', errors, rejectionReason: errors[0] };
  }

  // ---- Check 2: Reject command-result-envelope-as-semantic-evidence ----
  // If semanticArtifactPath is one of the raw transport archive paths
  // (stdoutFile or stderrFile), it cannot serve as the semantic artifact.
  const rawResult_record = isJsonRecord(rawResult) ? rawResult : {};
  const stdoutFile = typeof rawResult_record['stdoutFile'] === 'string' ? rawResult_record['stdoutFile'] : undefined;
  const stderrFile = typeof rawResult_record['stderrFile'] === 'string' ? rawResult_record['stderrFile'] : undefined;
  const handle_record = isJsonRecord(evidenceHandle) ? evidenceHandle : {};
  const semanticArtifactPath = typeof handle_record['semanticArtifactPath'] === 'string'
    ? handle_record['semanticArtifactPath']
    : undefined;

  if (semanticArtifactPath && (semanticArtifactPath === stdoutFile || semanticArtifactPath === stderrFile)) {
    errors.push(
      `canonical-path violation: semanticArtifactPath "${semanticArtifactPath}" is a raw transport ` +
      'archive path (stdoutFile or stderrFile). Raw transport archives are TRANSPORT evidence only ' +
      'and cannot serve as the semantic artifact. The tool must write a schema-owned semantic ' +
      'artifact file and set semanticArtifactPath to that file.'
    );
    return { kind: 'rejected', errors, rejectionReason: errors[0] };
  }

  // ---- Check 3: Full structural validation via validateToolEvidenceHandle ----
  const validation = validateToolEvidenceHandle(evidenceHandle, projectRoot !== undefined ? { projectRoot } : undefined);
  if (!validation.valid) {
    const errList = (validation as InvalidToolEvidenceHandle).errors;
    return {
      kind: 'rejected',
      errors: errList,
      rejectionReason:
        'canonical-path violation: evidenceHandle failed ToolEvidenceHandle validation: ' +
        errList.join('; ')
    };
  }

  const handle = (validation as ValidToolEvidenceHandle).handle;

  // ---- Check 4: PASSED runs require summaryMode='summary' with rtkSummary ----
  // The bead requires that PASSED canonical-path tools emit a tool-local RTK summary.
  // A PASSED tool with summaryMode='none' is rejected on the canonical path.
  if (handle.runStatus === 'PASSED' && handle.summaryMode !== 'summary') {
    errors.push(
      'canonical-path violation: PASSED canonical-path tools must emit summaryMode="summary" with ' +
      'a tool-local TypeScript RTK summary (rtkSummary). summaryMode="none" is not admissible for ' +
      'PASSED runs on the canonical evidence path — the tool must provide a deterministic RTK summary.'
    );
    return { kind: 'rejected', errors, rejectionReason: errors[0] };
  }

  // All checks passed.
  return { kind: 'valid', handle, validation: validation as ValidToolEvidenceHandle };
}

// ---------------------------------------------------------------------------
// buildCanonicalRejectionResult
// ---------------------------------------------------------------------------

/**
 * Build a deterministic REJECTED result object for a canonical-path tool that
 * failed evidence validation. The result shape matches the harness project-tool
 * contract (status, message, failureCategory, canonicalEvidenceErrors).
 *
 * @param toolName   — the tool name (from definition.name).
 * @param errors     — the deterministic error list from extractCanonicalEvidence.
 * @param rejection  — the primary rejection reason string.
 */
export function buildCanonicalRejectionResult(
  toolName: string,
  errors: string[],
  rejection: string
): Record<string, unknown> {
  return {
    tool: toolName,
    status: 'REJECTED',
    failureCategory: 'INPUT',
    message:
      `REJECTED: \`${toolName}\` is on the canonical evidence path but its evidenceHandle failed validation. ` +
      rejection,
    canonicalEvidenceErrors: errors,
    remediation: [
      'Ensure the tool emits a valid ToolEvidenceHandle as evidenceHandle in its JSON stdout.',
      'For PASSED runs: semanticArtifactPath must be set, inside toolOutputRoot, and rtkSummary must be present with a .ts owningFile.',
      'Do not use stdoutFile or stderrFile as semanticArtifactPath — these are transport archives only.',
      'Do not emit a ToolResultBase shape as evidenceHandle — use a full ToolEvidenceHandle instead.'
    ]
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Extract the evidenceHandle field from a raw command result's stdout JSON.
 * Returns undefined if the result has no stdout, the stdout is not JSON,
 * or the JSON has no evidenceHandle field.
 */
function extractEvidenceHandleFromStdout(rawResult: unknown): unknown | undefined {
  if (!isJsonRecord(rawResult)) return undefined;
  const stdoutText = rawResult[STDOUT_KEY];
  if (typeof stdoutText !== 'string') return undefined;
  const parsed = parseJsonRecord(stdoutText);
  if (!parsed) return undefined;
  if (!(EVIDENCE_HANDLE_KEY in parsed)) return undefined;
  return parsed[EVIDENCE_HANDLE_KEY];
}

/**
 * Detect a legacy ToolResultBase shape: an object with string `tool`,
 * string `status`, and string `outputFile` at the top level.
 * These are the legacy shapes that must be rejected on the canonical path.
 */
function isLegacyToolResultBaseShape(value: unknown): boolean {
  if (!isJsonRecord(value)) return false;
  return (
    typeof value['tool'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['outputFile'] === 'string'
  );
}
