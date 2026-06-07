/**
 * ToolEvidenceHandle — canonical coordinator-side evidence contract for Orr Else.
 *
 * DESIGN INTENT
 * -------------
 * This module defines the SINGLE source of truth that the coordinator uses to
 * reason about what a tool produced and whether that production can satisfy a
 * semantic gate. It unifies the overlapping shapes in the codebase:
 *
 *   ToolResultBase             — thin "did it run" base (src/contract.ts)
 *   PROJECT_TOOL event fields  — FLAT shape in EventStore
 *   Wrapped plugin toolResult  — NESTED shape in EventStore
 *   ToolCallPathFactory paths  — raw output archive paths
 *   verifier ctx.toolOutputs   — paths-only map into VerifyContext
 *   RTK inventory entries      — per-tool raw/compact contract (RtkContract.ts)
 *
 * CONTRACT LAYER ONLY
 * -------------------
 * This module ships:
 *   - TypeScript interfaces  (ToolEvidenceHandle + sub-types)
 *   - A JSON schema object   (TOOL_EVIDENCE_HANDLE_SCHEMA)
 *   - A structural validator (validateToolEvidenceHandle) — fail-closed
 *   - A migration-debt adapter for ToolResultBase (toolResultBaseToMigrationDebt)
 *
 * It does NOT ship any summarizer framework. Each tool owns its own RTK summary
 * TypeScript implementation; this module defines only the shape those summaries
 * must conform to when attached to a handle.
 *
 * FORBIDDEN (explicitly)
 * ----------------------
 *   - LLM-generated summaries
 *   - Prompt-based summarizers
 *   - Generic summary-extraction frameworks
 *   - Shared extractor registries
 *   - Non-TypeScript summarizers (rtkSummary.owningFile must end with .ts)
 *   - Model-facing raw output on the handle (rawOutput, modelFacingRawOutput)
 *   - Using rawTransportArchivePaths as a semantic gate (they are separate)
 *
 * STATUS vs VERDICT SEPARATION (AC2)
 * -----------------------------------
 *   runStatus       — Did the tool EXECUTE to completion? (PASSED | REJECTED)
 *                     This matches ToolResultBase.status semantics exactly.
 *                     A REJECTED tool never reached the semantic verifier.
 *   verifierVerdict — What did the semantic verifier decide? (PASS | FAIL | NOT_APPLICABLE)
 *                     Present ONLY when a verify() callback ran and produced a result.
 *                     A PASSED tool may still have verdict=FAIL (semantic failure).
 *                     A REJECTED tool has no verifierVerdict (it never ran).
 *
 * TOOLRESULTBASE MIGRATION DEBT (AC5)
 * ------------------------------------
 * toolResultBaseToMigrationDebt() maps a ToolResultBase to a partial,
 * INTENTIONALLY INCOMPLETE handle that is clearly marked _migrationDebt: true.
 * It MUST NOT become a permanent gate path — tools must migrate to emit full
 * ToolEvidenceHandle instances directly. The adapter result deliberately FAILS
 * validateToolEvidenceHandle because it lacks invocationId, schemaVersion,
 * admittedHarnessFingerprint, and admittedExecutionBoundary.
 *
 * See: src/contract.ts (ToolResultBase, VerifyContext, VerifyVerdict)
 *      src/core/RtkContract.ts (RtkContractEntry)
 *      src/core/VerifierGate.ts (runVerifierGate, VerifierGateBlockKind)
 *      src/core/ToolCallPathFactory.ts (ToolCallPathAllocation)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolResultBase, ToolRunStatus } from '../contract.js';

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/** Bump when the handle shape changes in a backwards-incompatible way. */
export const TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Supporting literal union types
// ---------------------------------------------------------------------------

/**
 * Did the tool EXECUTE to completion?
 * Re-exported from contract.ts — NOT a local redefinition (AC2 of zog2.15).
 * Mirrors ToolResultBase.status — NOT a semantic pass/fail verdict.
 *
 *   PASSED      — the tool ran to completion; its raw output is durable.
 *   REJECTED    — the tool could not complete (transport, timeout, input, infra).
 *   UNAVAILABLE — the tool binary / MCP server was not found. Always blocks gate.
 */
export type ToolEvidenceRunStatus = ToolRunStatus;

/**
 * Why a REJECTED tool failed.
 * Mirrors ToolResultBase.failureCategory exactly.
 */
export type ToolEvidenceFailureCategory = 'TRANSPORT' | 'TIMEOUT' | 'INPUT' | 'INFRA';

/**
 * What the semantic verifier decided about this tool's output.
 * DISTINCT from ToolEvidenceRunStatus.
 *
 *   PASS            — the verify() callback returned VerifyVerdict.PASS.
 *   FAIL            — the verify() callback returned VerifyVerdict.FAIL.
 *   NOT_APPLICABLE  — no verify() callback is registered; gate ignores it.
 */
export type ToolEvidenceVerifierVerdict = 'PASS' | 'FAIL' | 'NOT_APPLICABLE';

/**
 * How this handle summarises the tool's semantic output for the model.
 *
 *   summary — a deterministic, code-owned RTK summary is available.
 *   none    — no RTK summary; noSummaryReason explains why.
 */
export type ToolEvidenceSummaryMode = 'summary' | 'none';

// ---------------------------------------------------------------------------
// RTK summary shape (owned by each tool, validated by this contract)
// ---------------------------------------------------------------------------

/**
 * A tool-local, deterministic RTK summary attached to a ToolEvidenceHandle.
 *
 * RULES (AC3 + zog2.7, enforced by validator):
 *   - schemaTypeName: the TypeScript interface/type name declared in owningFile.
 *     Must be a non-empty string. MUST NOT be 'untyped_record' — that is the
 *     generic migration placeholder; admitted summaries require a concrete schema.
 *   - owningFile: the repo-relative .ts file that declares the summary type and
 *     produces this value. MUST end with .ts — this enforces TypeScript-only
 *     summarizers and forbids JS, Python, shell, or any non-TS path. MUST NOT be
 *     a generic harness framework file (e.g. src/core/ToolEvidenceHandle.ts).
 *     When the validator knows the expected tool name (opts.expectedToolName),
 *     owningFile MUST correspond to the tool's own module via the path convention
 *     src/tools/<toolName>.ts — affirmative check, not just a denylist.
 *   - summarySchemaVersion: a semver-style version string for the summary schema.
 *     Bump when the schema shape changes in a backwards-incompatible way.
 *   - schemaHash: a deterministic, stable hash of the summary schema definition
 *     (e.g. SHA-256 of the TypeScript interface text). Detects schema drift.
 *     Must be a non-empty string. Use 'sha256:<hex>' format.
 *   - deterministicSummaryVersion: version string of the summarization logic
 *     (not the schema — the algorithm version). Bump when summarizer behaviour
 *     changes for the same schema version. Format: semver or monotonic integer.
 *   - inputArtifactSchemaId: identifier for the input artifact schema this
 *     summary was produced from (e.g. the semantic artifact schema id).
 *   - inputArtifactSchemaVersion: version of the input artifact schema.
 *   - maximumCounts: the maximum item counts / truncation bounds this summary
 *     applies (e.g. max commit entries, max file paths). Documents the cap.
 *   - omissionSemantics: describes what the summary omits and how (e.g.
 *     'commits beyond limit are omitted; total count reported').
 *   - summary: the deterministic compact object returned by the tool's own
 *     TypeScript summarizer. The harness validates structure (all fields above);
 *     it does NOT inspect or constrain the summary payload content.
 *
 * FORBIDDEN (AC3 + zog2.7):
 *   - schemaTypeName === 'untyped_record' (generic fallback; not a real schema).
 *   - owningFile ending with .js, .py, .sh, .rb, or anything other than .ts.
 *   - owningFile pointing to a generic harness framework file.
 *   - owningFile belonging to a different tool's module (when expectedToolName known).
 *   - LLM-generated or prompt-based summary values.
 *   - Generic extraction frameworks or shared summarizer registries.
 *   - Omitting summarySchemaVersion, schemaHash, deterministicSummaryVersion,
 *     inputArtifactSchemaId, inputArtifactSchemaVersion, maximumCounts, or
 *     omissionSemantics.
 */
export interface ToolEvidenceRtkSummary {
  /**
   * TypeScript type/interface name of the summary schema (non-empty).
   * MUST NOT be 'untyped_record' — use a concrete schema type name.
   */
  readonly schemaTypeName: string;
  /**
   * Repo-relative path to the .ts file that declares the schema and produces
   * this summary. MUST end with .ts (enforced by validator). MUST NOT be a
   * generic harness framework file. When expectedToolName is known, MUST
   * correspond to the tool's own module (src/tools/<toolName>.ts convention).
   */
  readonly owningFile: string;
  /**
   * Semver-style version of the summary schema definition (e.g. '1.0.0').
   * Bump when the schema shape changes in a backwards-incompatible way.
   */
  readonly summarySchemaVersion: string;
  /**
   * Deterministic hash of the summary schema definition. Detects schema drift.
   * Format: 'sha256:<hex>' (64 hex digits). Use a stable hash of the TypeScript
   * interface text for the summary type declared in owningFile.
   */
  readonly schemaHash: string;
  /**
   * Version of the summarization algorithm/logic (not the schema).
   * Bump when summarizer behaviour changes for the same schema version.
   * Format: semver (e.g. '1.0.0') or monotonic integer string (e.g. '1').
   */
  readonly deterministicSummaryVersion: string;
  /**
   * Identifier for the input artifact schema this summary was produced from.
   * E.g. the schema id of the semantic artifact that was summarized.
   */
  readonly inputArtifactSchemaId: string;
  /**
   * Version of the input artifact schema (e.g. '1.0.0').
   * Bump when the input artifact schema changes in a backwards-incompatible way.
   */
  readonly inputArtifactSchemaVersion: string;
  /**
   * Maximum item counts / truncation bounds applied by this summary.
   * Documents the caps so consumers know what may be omitted.
   * E.g. { commits: 12, paths: 30 }
   */
  readonly maximumCounts: Record<string, number>;
  /**
   * Describes what the summary omits and how omissions are reported.
   * E.g. 'commits beyond maximumCounts.commits are omitted; outputLines reports total'
   */
  readonly omissionSemantics: string;
  /** The deterministic compact summary object. Content is tool-owned. */
  readonly summary: Record<string, unknown>;
}

/**
 * Generic harness framework files that are forbidden as rtkSummary.owningFile.
 * A tool-local summary must be owned by the tool's own TS module, not by any
 * shared harness framework file.
 *
 * zog2.7: this set is the explicit ban list for the generic-fallback prohibition.
 */
export const FORBIDDEN_GENERIC_SUMMARY_OWNER_FILES: ReadonlySet<string> = new Set([
  'src/core/ToolEvidenceHandle.ts',
  'src/core/RtkContract.ts',
  'src/core/VerifierGate.ts',
  'src/contract.ts',
]);

// ---------------------------------------------------------------------------
// ToolEvidenceHandle — the canonical contract
// ---------------------------------------------------------------------------

/**
 * ToolEvidenceHandle — the single coordinator-side evidence record for one
 * tool invocation within a (bead, state, action) attempt.
 *
 * FIELD GROUPS
 * ------------
 *
 * Identity
 *   schemaVersion              — handle schema revision (= TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION)
 *   toolName                   — the tool name as registered with Pi
 *   invocationId               — unique per-invocation id (from ToolCallPathAllocation)
 *
 * Execution status (NOT a semantic verdict — see AC2)
 *   runStatus                  — did the tool EXECUTE (PASSED | REJECTED)
 *   failureCategory            — why it was REJECTED (present only when REJECTED)
 *
 * Semantic artifact (the durable output that gates can inspect)
 *   semanticArtifactPath       — absolute path to the primary semantic output file.
 *                                Gate logic uses this path, not rawTransportArchivePaths.
 *                                REQUIRED for PASSED runs (zog2.8): every tool must persist
 *                                a schema-owned semantic artifact (even a minimal one for
 *                                control-plane tools); missing artifact paths are never
 *                                admissible evidence. May be absent for REJECTED/UNAVAILABLE.
 *   semanticArtifactBytes      — byte count of semanticArtifactPath (for accounting).
 *   semanticArtifactSha256     — hex SHA-256 of semanticArtifactPath (for integrity).
 *
 * Raw transport (separate from semantic artifact — AC2)
 *   rawTransportArchivePaths   — zero or more absolute paths to raw stdout/stderr/
 *                                output archives. These exist for durability and
 *                                harness observability ONLY. They are NOT the semantic
 *                                artifact and CANNOT satisfy artifact-presence gates.
 *
 * Path containment
 *   toolOutputRoot             — absolute path to PI_TOOL_OUTPUT_DIR for this project.
 *                                The validator checks that semanticArtifactPath (when
 *                                present) is inside this root.
 *
 * RTK summary (model-facing compact output — AC3)
 *   summaryMode                — 'summary' | 'none'
 *   rtkSummary                 — the deterministic compact summary (when summaryMode='summary')
 *   noSummaryReason            — why no summary exists (when summaryMode='none')
 *
 * Semantic verifier verdict (DISTINCT from runStatus — AC2)
 *   verifierVerdict            — PASS | FAIL | NOT_APPLICABLE (when a verifier ran)
 *
 * Admitted provenance (for audit and integrity — AC1)
 *   admittedHarnessFingerprint — harness build fingerprint at the time this handle
 *                                was produced (e.g. 'sha256:<distArtifactHash>').
 *   admittedExecutionBoundary  — the (bead, state, action) scope this handle was
 *                                produced in (e.g. 'bead:B1/state:S1/action:A1').
 *
 * FORBIDDEN FIELDS (AC2 — enforced by validator):
 *   rawOutput, modelFacingRawOutput — the handle MUST NOT expose raw tool stdout/stderr
 *                                     model-facing. Raw output lives in rawTransportArchivePaths
 *                                     and is accessed via query_artifact, not inlined here.
 */
export interface ToolEvidenceHandle {
  // ---- Identity ----
  readonly schemaVersion: string;
  readonly toolName: string;
  readonly invocationId: string;

  // ---- Execution status (not a semantic verdict) ----
  readonly runStatus: ToolEvidenceRunStatus;
  readonly failureCategory?: ToolEvidenceFailureCategory;

  // ---- Semantic artifact ----
  readonly semanticArtifactPath?: string;
  readonly semanticArtifactBytes?: number;
  readonly semanticArtifactSha256?: string;

  // ---- Raw transport (separate from semantic artifact) ----
  readonly rawTransportArchivePaths?: string[];

  // ---- Path containment ----
  readonly toolOutputRoot: string;

  // ---- RTK summary ----
  readonly summaryMode: ToolEvidenceSummaryMode;
  readonly rtkSummary?: ToolEvidenceRtkSummary;
  readonly noSummaryReason?: string;

  // ---- Semantic verifier verdict (distinct from runStatus) ----
  readonly verifierVerdict?: ToolEvidenceVerifierVerdict;

  // ---- Admitted provenance ----
  readonly admittedHarnessFingerprint: string;
  readonly admittedExecutionBoundary: string;
}

// ---------------------------------------------------------------------------
// JSON Schema (evaluator-facing, draft-07)
// ---------------------------------------------------------------------------

export const TOOL_EVIDENCE_HANDLE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'ToolEvidenceHandle',
  title: 'ToolEvidenceHandle',
  description:
    'Canonical coordinator-side evidence record for one tool invocation. '
    + 'Separates execution status from semantic verifier verdict. '
    + 'Forbids model-facing raw output fields.',
  type: 'object',
  required: [
    'schemaVersion',
    'toolName',
    'invocationId',
    'runStatus',
    'toolOutputRoot',
    'summaryMode',
    'admittedHarnessFingerprint',
    'admittedExecutionBoundary',
  ],
  additionalProperties: false,
  // Forbidden model-facing raw output keys: not listed in properties, and
  // additionalProperties: false means any extra key FAILS validation.
  // The validator further explicitly rejects rawOutput and modelFacingRawOutput.
  properties: {
    schemaVersion: { type: 'string', minLength: 1 },
    toolName: { type: 'string', minLength: 1 },
    invocationId: { type: 'string', minLength: 1 },
    runStatus: { type: 'string', enum: ['PASSED', 'REJECTED', 'UNAVAILABLE'] },
    failureCategory: { type: 'string', enum: ['TRANSPORT', 'TIMEOUT', 'INPUT', 'INFRA'] },
    semanticArtifactPath: { type: 'string', minLength: 1 },
    semanticArtifactBytes: { type: 'integer', minimum: 0 },
    semanticArtifactSha256: { type: 'string', minLength: 1 },
    rawTransportArchivePaths: { type: 'array', items: { type: 'string' } },
    toolOutputRoot: { type: 'string', minLength: 1 },
    summaryMode: { type: 'string', enum: ['summary', 'none'] },
    rtkSummary: {
      type: 'object',
      required: [
        'schemaTypeName', 'owningFile', 'summarySchemaVersion', 'schemaHash',
        'deterministicSummaryVersion', 'inputArtifactSchemaId', 'inputArtifactSchemaVersion',
        'maximumCounts', 'omissionSemantics', 'summary'
      ],
      additionalProperties: false,
      properties: {
        schemaTypeName: { type: 'string', minLength: 1 },
        owningFile: { type: 'string', minLength: 1 },
        summarySchemaVersion: { type: 'string', minLength: 1 },
        schemaHash: { type: 'string', minLength: 1 },
        deterministicSummaryVersion: { type: 'string', minLength: 1 },
        inputArtifactSchemaId: { type: 'string', minLength: 1 },
        inputArtifactSchemaVersion: { type: 'string', minLength: 1 },
        maximumCounts: { type: 'object' },
        omissionSemantics: { type: 'string', minLength: 1 },
        summary: { type: 'object' }
      }
    },
    noSummaryReason: { type: 'string', minLength: 1 },
    verifierVerdict: { type: 'string', enum: ['PASS', 'FAIL', 'NOT_APPLICABLE'] },
    admittedHarnessFingerprint: { type: 'string', minLength: 1 },
    admittedExecutionBoundary: { type: 'string', minLength: 1 },
  }
} as const;

// ---------------------------------------------------------------------------
// Validator — fail-closed structural checker
// ---------------------------------------------------------------------------

/** Successful validation: a typed, immutable ToolEvidenceHandle. */
export type ValidToolEvidenceHandle = { valid: true; handle: ToolEvidenceHandle };
/** Failed validation: structured error list. Never empty when valid===false. */
export type InvalidToolEvidenceHandle = { valid: false; errors: string[] };

/**
 * Options for validateToolEvidenceHandle.
 *
 *   expectedToolName — when provided, the validator fails closed if
 *                      handle.toolName !== expectedToolName (AC4).
 *   projectRoot      — when provided, rtkSummary.owningFile paths that are
 *                      project-tool TS files (i.e. NOT under src/) are validated
 *                      to exist on disk at path.join(projectRoot, owningFile).
 *                      This enforces the pi-experiment-6q0y.12 contract: a summary's
 *                      declared owning TS file must correspond to a real project-tool
 *                      file, not just any arbitrary path string.
 */
export interface ValidateToolEvidenceHandleOptions {
  /** Fail closed if handle.toolName does not exactly match this string. */
  readonly expectedToolName?: string;
  /**
   * Absolute path to the project root. When provided, rtkSummary.owningFile
   * paths that are project-tool files (do NOT start with 'src/') are validated
   * to exist on disk at path.join(projectRoot, owningFile) (6q0y.12).
   */
  readonly projectRoot?: string;
}

/**
 * Validate an unknown value against the ToolEvidenceHandle contract.
 *
 * Fail-closed: ANY violation produces valid:false with ≥1 error strings.
 *
 * Checks enforced beyond structural type validation:
 *   - summaryMode='summary' requires rtkSummary to be present.
 *   - summaryMode='none' requires noSummaryReason to be present.
 *   - rtkSummary.owningFile must end with '.ts' (TypeScript-only, AC3).
 *   - rtkSummary.schemaTypeName must be a non-empty string.
 *   - semanticArtifactPath is REQUIRED for PASSED runs (zog2.8): every tool must
 *     persist a schema-owned semantic artifact; missing artifact paths are never
 *     admissible evidence. REJECTED/UNAVAILABLE runs may omit it.
 *   - semanticArtifactPath (when present) must be inside toolOutputRoot (AC4).
 *   - The handle must NOT contain rawOutput or modelFacingRawOutput keys (AC2).
 *   - verifierVerdict must be one of the allowed enum values when present.
 *   - opts.expectedToolName (when provided): handle.toolName must match exactly (AC4).
 *   - opts.projectRoot (when provided): project-tool owningFile paths are validated
 *     to exist on disk at path.join(projectRoot, owningFile) (6q0y.12).
 */
export function validateToolEvidenceHandle(
  value: unknown,
  opts?: ValidateToolEvidenceHandleOptions
): ValidToolEvidenceHandle | InvalidToolEvidenceHandle {
  const errors: string[] = [];

  // ---- Root type check ----
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, errors: ['root: must be a non-null object'] };
  }

  const record = value as Record<string, unknown>;

  // ---- AC2: forbidden model-facing raw output fields ----
  // These are checked FIRST so the error message is unambiguous.
  if ('rawOutput' in record) {
    errors.push('rawOutput: forbidden — model-facing raw output must not appear on a ToolEvidenceHandle; use rawTransportArchivePaths for durable archive paths');
  }
  if ('modelFacingRawOutput' in record) {
    errors.push('modelFacingRawOutput: forbidden — model-facing raw output must not appear on a ToolEvidenceHandle');
  }

  // ---- schemaVersion ----
  if (typeof record['schemaVersion'] !== 'string' || record['schemaVersion'].length === 0) {
    errors.push('schemaVersion: must be a non-empty string');
  }

  // ---- toolName ----
  if (typeof record['toolName'] !== 'string' || record['toolName'].length === 0) {
    errors.push('toolName: must be a non-empty string');
  } else if (opts?.expectedToolName !== undefined && record['toolName'] !== opts.expectedToolName) {
    // AC4: mismatched tool name — fail closed.
    errors.push(
      `toolName: expected "${opts.expectedToolName}", got "${record['toolName']}" — tool name mismatch`
    );
  }

  // ---- invocationId ----
  if (typeof record['invocationId'] !== 'string' || record['invocationId'].length === 0) {
    errors.push('invocationId: must be a non-empty string');
  }

  // ---- runStatus ----
  const validRunStatuses: ToolEvidenceRunStatus[] = ['PASSED', 'REJECTED', 'UNAVAILABLE'];
  if (!validRunStatuses.includes(record['runStatus'] as ToolEvidenceRunStatus)) {
    errors.push(`runStatus: must be one of ${validRunStatuses.join('|')}, got ${JSON.stringify(record['runStatus'])}`);
  }

  // ---- failureCategory (optional) ----
  const failureCategory = record['failureCategory'];
  if (failureCategory !== undefined) {
    const allowed: ToolEvidenceFailureCategory[] = ['TRANSPORT', 'TIMEOUT', 'INPUT', 'INFRA'];
    if (!allowed.includes(failureCategory as ToolEvidenceFailureCategory)) {
      errors.push(`failureCategory: must be one of ${allowed.join('|')} when present, got ${JSON.stringify(failureCategory)}`);
    }
  }

  // ---- toolOutputRoot ----
  const toolOutputRoot = record['toolOutputRoot'];
  if (typeof toolOutputRoot !== 'string' || toolOutputRoot.length === 0) {
    errors.push('toolOutputRoot: must be a non-empty string');
  }

  // ---- semanticArtifactPath — REQUIRED for PASSED runs (zog2.8) ----
  // PASSED tools must persist a minimal schema-owned semantic artifact;
  // missing artifact paths are NEVER evidence (zog2.8 AC).
  // REJECTED/UNAVAILABLE tools may omit it (they did not complete).
  const semanticArtifactPath = record['semanticArtifactPath'];
  const runStatusForArtifactCheck = record['runStatus'];
  if (runStatusForArtifactCheck === 'PASSED' && (semanticArtifactPath === undefined || semanticArtifactPath === null || semanticArtifactPath === '')) {
    errors.push(
      'semanticArtifactPath: required for PASSED runs (zog2.8) — every tool must persist a schema-owned ' +
      'semantic artifact; missing artifact paths are not admissible evidence'
    );
  } else if (semanticArtifactPath !== undefined) {
    if (typeof semanticArtifactPath !== 'string' || semanticArtifactPath.length === 0) {
      errors.push('semanticArtifactPath: must be a non-empty string when present');
    } else if (typeof toolOutputRoot === 'string' && toolOutputRoot.length > 0) {
      if (!isInsideRoot(toolOutputRoot, semanticArtifactPath)) {
        errors.push(
          `semanticArtifactPath: must be inside toolOutputRoot "${toolOutputRoot}", ` +
          `got "${semanticArtifactPath}"`
        );
      }
    }
  }

  // ---- semanticArtifactBytes (optional) ----
  const semanticArtifactBytes = record['semanticArtifactBytes'];
  if (semanticArtifactBytes !== undefined) {
    if (typeof semanticArtifactBytes !== 'number' || !Number.isInteger(semanticArtifactBytes) || semanticArtifactBytes < 0) {
      errors.push('semanticArtifactBytes: must be a non-negative integer when present');
    }
  }

  // ---- semanticArtifactSha256 (optional) ----
  const semanticArtifactSha256 = record['semanticArtifactSha256'];
  if (semanticArtifactSha256 !== undefined) {
    if (typeof semanticArtifactSha256 !== 'string' || semanticArtifactSha256.length === 0) {
      errors.push('semanticArtifactSha256: must be a non-empty string when present');
    }
  }

  // ---- rawTransportArchivePaths (optional) ----
  const rawTransportArchivePaths = record['rawTransportArchivePaths'];
  if (rawTransportArchivePaths !== undefined) {
    if (!Array.isArray(rawTransportArchivePaths)) {
      errors.push('rawTransportArchivePaths: must be an array when present');
    } else {
      rawTransportArchivePaths.forEach((item, idx) => {
        if (typeof item !== 'string') {
          errors.push(`rawTransportArchivePaths[${idx}]: must be a string`);
        }
      });
    }
  }

  // ---- summaryMode ----
  const summaryMode = record['summaryMode'];
  if (summaryMode !== 'summary' && summaryMode !== 'none') {
    errors.push(`summaryMode: must be 'summary' or 'none', got ${JSON.stringify(summaryMode)}`);
  }

  // ---- rtkSummary + noSummaryReason (conditional on summaryMode) ----
  const rtkSummary = record['rtkSummary'];
  const noSummaryReason = record['noSummaryReason'];

  if (summaryMode === 'summary') {
    if (rtkSummary === undefined || rtkSummary === null) {
      errors.push('rtkSummary: required when summaryMode="summary"');
    } else {
      validateRtkSummary(rtkSummary, errors, opts?.expectedToolName, opts?.projectRoot);
    }
  } else if (summaryMode === 'none') {
    if (typeof noSummaryReason !== 'string' || noSummaryReason.length === 0) {
      errors.push('noSummaryReason: required (non-empty string) when summaryMode="none"');
    }
  }

  // ---- verifierVerdict (optional) ----
  const verifierVerdict = record['verifierVerdict'];
  if (verifierVerdict !== undefined) {
    const allowed: ToolEvidenceVerifierVerdict[] = ['PASS', 'FAIL', 'NOT_APPLICABLE'];
    if (!allowed.includes(verifierVerdict as ToolEvidenceVerifierVerdict)) {
      errors.push(`verifierVerdict: must be one of ${allowed.join('|')} when present, got ${JSON.stringify(verifierVerdict)}`);
    }
  }

  // ---- admittedHarnessFingerprint ----
  if (typeof record['admittedHarnessFingerprint'] !== 'string' || record['admittedHarnessFingerprint'].length === 0) {
    errors.push('admittedHarnessFingerprint: must be a non-empty string');
  }

  // ---- admittedExecutionBoundary ----
  if (typeof record['admittedExecutionBoundary'] !== 'string' || record['admittedExecutionBoundary'].length === 0) {
    errors.push('admittedExecutionBoundary: must be a non-empty string');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Safe cast: all required fields validated above.
  const handle: ToolEvidenceHandle = {
    schemaVersion: record['schemaVersion'] as string,
    toolName: record['toolName'] as string,
    invocationId: record['invocationId'] as string,
    runStatus: record['runStatus'] as ToolEvidenceRunStatus,
    ...(failureCategory !== undefined ? { failureCategory: failureCategory as ToolEvidenceFailureCategory } : {}),
    ...(semanticArtifactPath !== undefined ? { semanticArtifactPath: semanticArtifactPath as string } : {}),
    ...(typeof semanticArtifactBytes === 'number' ? { semanticArtifactBytes } : {}),
    ...(typeof semanticArtifactSha256 === 'string' ? { semanticArtifactSha256: semanticArtifactSha256 as string } : {}),
    ...(Array.isArray(rawTransportArchivePaths) ? { rawTransportArchivePaths: rawTransportArchivePaths as string[] } : {}),
    toolOutputRoot: record['toolOutputRoot'] as string,
    summaryMode: summaryMode as ToolEvidenceSummaryMode,
    ...(summaryMode === 'summary' && rtkSummary ? { rtkSummary: rtkSummary as ToolEvidenceRtkSummary } : {}),
    ...(typeof noSummaryReason === 'string' ? { noSummaryReason } : {}),
    ...(verifierVerdict !== undefined ? { verifierVerdict: verifierVerdict as ToolEvidenceVerifierVerdict } : {}),
    admittedHarnessFingerprint: record['admittedHarnessFingerprint'] as string,
    admittedExecutionBoundary: record['admittedExecutionBoundary'] as string,
  };

  return { valid: true, handle };
}

// ---------------------------------------------------------------------------
// Artifact-readability validator (AC4 — unreadable artifact fail-closed)
// ---------------------------------------------------------------------------

/** Successful artifact-readability check. */
export type ArtifactReadable = { readable: true };
/** Failed artifact-readability check: structured error. */
export type ArtifactUnreadable = { readable: false; error: string };

/**
 * Verify that the semanticArtifactPath on a validated handle exists and is
 * readable (AC4 — "unreadable artifact" fail-closed case).
 *
 * Kept separate from validateToolEvidenceHandle so callers who only need
 * structural validation do not pay filesystem I/O cost.
 *
 * Returns readable:true when:
 *   - handle.semanticArtifactPath is undefined (no artifact to check).
 *   - the path exists and is readable.
 *
 * Returns readable:false (fail-closed) when:
 *   - the path is set but the file does not exist.
 *   - the path is set but the file is not readable (permissions).
 */
export function validateToolEvidenceArtifact(
  handle: ToolEvidenceHandle
): ArtifactReadable | ArtifactUnreadable {
  if (handle.semanticArtifactPath === undefined) {
    return { readable: true };
  }
  try {
    fs.accessSync(handle.semanticArtifactPath, fs.constants.R_OK);
    return { readable: true };
  } catch {
    return {
      readable: false,
      error: `semanticArtifactPath not readable: "${handle.semanticArtifactPath}"`
    };
  }
}

// ---------------------------------------------------------------------------
// Private validator helpers
// ---------------------------------------------------------------------------

/** Check whether `candidate` is inside or equal to `root` (no path traversal). */
function isInsideRoot(root: string, candidate: string): boolean {
  // Resolve both paths to absolute, normalised forms so that `..` segments
  // cannot escape the root (e.g. "/root/../../etc/passwd" is rejected).
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  // Must be either equal to root or start with root + '/'
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + '/');
}

/**
 * Derive the expected owning file path for a tool from its name.
 * Convention: src/tools/<toolName>.ts
 * This is the affirmative tool-local check: when expectedToolName is known,
 * the owningFile must correspond to the tool's own module.
 */
function expectedOwningFileForTool(toolName: string): string {
  return `src/tools/${toolName}.ts`;
}

/**
 * Return true when `owningFile` is a project-tool TS file rather than a
 * harness-owned source file. The convention is: harness files start with 'src/';
 * project-tool files are everything else (e.g. '.pi/project-tools/foo.ts').
 * Only called after the '.ts' extension check has already passed.
 *
 * 6q0y.12: used to decide whether to apply the on-disk existence check.
 */
function isProjectToolOwningFile(owningFile: string): boolean {
  return !owningFile.startsWith('src/');
}

/**
 * Return true when `absoluteFilePath` exists on disk as a regular file.
 * Fail-closed: returns false on any filesystem error.
 *
 * 6q0y.12: used to verify that a declared project-tool owningFile actually exists.
 */
function projectToolFileExists(absoluteFilePath: string): boolean {
  try {
    return fs.statSync(absoluteFilePath).isFile();
  } catch {
    return false;
  }
}

/** Validate rtkSummary sub-object, pushing errors into the provided array. */
function validateRtkSummary(rtkSummary: unknown, errors: string[], expectedToolName?: string, projectRoot?: string): void {
  if (typeof rtkSummary !== 'object' || rtkSummary === null || Array.isArray(rtkSummary)) {
    errors.push('rtkSummary: must be a non-null object');
    return;
  }
  const s = rtkSummary as Record<string, unknown>;

  // schemaTypeName: must be non-empty AND must not be the generic 'untyped_record' (zog2.7)
  if (typeof s['schemaTypeName'] !== 'string' || s['schemaTypeName'].length === 0) {
    errors.push('rtkSummary.schemaTypeName: must be a non-empty string');
  } else if (s['schemaTypeName'] === 'untyped_record') {
    errors.push(
      'rtkSummary.schemaTypeName: "untyped_record" is the generic migration placeholder and is ' +
      'forbidden in admitted RTK summaries (zog2.7). Declare a concrete tool-local TypeScript ' +
      'schema type name (e.g. "GitHistoryRtkSummary").'
    );
  }

  // owningFile: must end with .ts (TypeScript-only — AC3) AND must not be a generic harness file (zog2.7)
  // PRIMARY rule (affirmative): when expectedToolName is known, owningFile MUST be the tool's own module.
  // SECONDARY rule (denylist): owningFile must not be any known generic harness framework file.
  // TERTIARY rule (6q0y.12): for project-tool TS files (not under src/), when projectRoot is known,
  //   owningFile MUST exist on disk at path.join(projectRoot, owningFile).
  if (typeof s['owningFile'] !== 'string' || s['owningFile'].length === 0) {
    errors.push('rtkSummary.owningFile: must be a non-empty string');
  } else if (!s['owningFile'].endsWith('.ts')) {
    errors.push(
      `rtkSummary.owningFile: must end with .ts (TypeScript-only summarizers required); ` +
      `got "${s['owningFile']}". Non-TypeScript summarizers are forbidden.`
    );
  } else if (FORBIDDEN_GENERIC_SUMMARY_OWNER_FILES.has(s['owningFile'] as string)) {
    errors.push(
      `rtkSummary.owningFile: "${s['owningFile']}" is a generic harness framework file and is ` +
      'forbidden as a summary owner (zog2.7). The owning file must be the tool\'s own TypeScript ' +
      'module, not a shared harness file.'
    );
  } else if (expectedToolName !== undefined) {
    // Affirmative tool-local check (zog2.7): owningFile must be the tool's own module.
    // Convention: src/tools/<toolName>.ts
    const expectedFile = expectedOwningFileForTool(expectedToolName);
    if (s['owningFile'] !== expectedFile) {
      errors.push(
        `rtkSummary.owningFile: expected "${expectedFile}" for tool "${expectedToolName}" ` +
        `(affirmative tool-local check, zog2.7); got "${s['owningFile']}". ` +
        'The summary owningFile must be the tool\'s own TypeScript module.'
      );
    }
  } else if (projectRoot !== undefined && isProjectToolOwningFile(s['owningFile'] as string)) {
    // Project-tool owning file validation (6q0y.12): when projectRoot is provided and the
    // owningFile is a project-tool TS file (not under src/), verify it exists on disk.
    // This ensures the summary's declared owning TS file corresponds to a REAL project-tool
    // file — not an arbitrary invented path string.
    const absoluteOwningFile = path.join(projectRoot, s['owningFile'] as string);
    if (!projectToolFileExists(absoluteOwningFile)) {
      errors.push(
        `rtkSummary.owningFile: project-tool file "${s['owningFile']}" does not exist at ` +
        `"${absoluteOwningFile}" (6q0y.12). The declared owning TS file must exist as a real ` +
        'project-tool TypeScript file under the project root. ' +
        'Check that the file is committed and the path matches exactly.'
      );
    }
  }

  // summarySchemaVersion: required (zog2.7)
  if (typeof s['summarySchemaVersion'] !== 'string' || s['summarySchemaVersion'].length === 0) {
    errors.push('rtkSummary.summarySchemaVersion: must be a non-empty string (e.g. "1.0.0") — required by zog2.7');
  }

  // schemaHash: required, must start with 'sha256:' or be non-empty (zog2.7)
  if (typeof s['schemaHash'] !== 'string' || s['schemaHash'].length === 0) {
    errors.push('rtkSummary.schemaHash: must be a non-empty string (format: "sha256:<hex>") — required by zog2.7');
  } else if (!s['schemaHash'].startsWith('sha256:') && !s['schemaHash'].startsWith('hash:')) {
    errors.push(
      `rtkSummary.schemaHash: must start with "sha256:" (got "${s['schemaHash']}"). ` +
      'Use a deterministic hash of the TypeScript summary interface text (e.g. "sha256:abcdef...").'
    );
  }

  // deterministicSummaryVersion: required (zog2.7)
  if (typeof s['deterministicSummaryVersion'] !== 'string' || s['deterministicSummaryVersion'].length === 0) {
    errors.push('rtkSummary.deterministicSummaryVersion: must be a non-empty string (e.g. "1.0.0" or "1") — required by zog2.7');
  }

  // inputArtifactSchemaId: required (zog2.7 — AC metadata)
  if (typeof s['inputArtifactSchemaId'] !== 'string' || s['inputArtifactSchemaId'].length === 0) {
    errors.push('rtkSummary.inputArtifactSchemaId: must be a non-empty string — required by zog2.7');
  }

  // inputArtifactSchemaVersion: required (zog2.7 — AC metadata)
  if (typeof s['inputArtifactSchemaVersion'] !== 'string' || s['inputArtifactSchemaVersion'].length === 0) {
    errors.push('rtkSummary.inputArtifactSchemaVersion: must be a non-empty string — required by zog2.7');
  }

  // maximumCounts: required, must be a non-null object (zog2.7 — AC metadata)
  if (typeof s['maximumCounts'] !== 'object' || s['maximumCounts'] === null || Array.isArray(s['maximumCounts'])) {
    errors.push('rtkSummary.maximumCounts: must be a non-null object (e.g. { commits: 12, paths: 30 }) — required by zog2.7');
  }

  // omissionSemantics: required, non-empty string (zog2.7 — AC metadata)
  if (typeof s['omissionSemantics'] !== 'string' || s['omissionSemantics'].length === 0) {
    errors.push('rtkSummary.omissionSemantics: must be a non-empty string describing omission behaviour — required by zog2.7');
  }

  // summary: must be a non-null object
  if (typeof s['summary'] !== 'object' || s['summary'] === null || Array.isArray(s['summary'])) {
    errors.push('rtkSummary.summary: must be a non-null object');
  }
}

// ---------------------------------------------------------------------------
// ToolResultBase migration-debt adapter (AC5)
// ---------------------------------------------------------------------------

/**
 * MIGRATION DEBT ADAPTER — TEMPORARY, do not use as a permanent gate path.
 *
 * Maps a ToolResultBase (the old thin "did it run" shape from src/contract.ts)
 * to a partial handle that carries the fields ToolResultBase knows about.
 *
 * WHY THIS EXISTS
 * ---------------
 * During migration (zog2.2+), individual tools will be updated to emit full
 * ToolEvidenceHandle instances. Until a tool is migrated, the coordinator may
 * encounter ToolResultBase instances from the EventStore. This adapter bridges
 * that gap by producing a partial handle that:
 *   - maps tool → toolName, status → runStatus, failureCategory → failureCategory
 *   - uses outputFile as a CANDIDATE semanticArtifactPath (REJECTED tools: absent)
 *   - uses outputFileBytes as semanticArtifactBytes (PASSED only)
 *   - sets _migrationDebt: true so callers can detect and reject it as non-authoritative
 *
 * WHAT IT CANNOT DO
 * -----------------
 *   - It does NOT know invocationId, schemaVersion, admittedHarnessFingerprint,
 *     admittedExecutionBoundary, summaryMode, rtkSummary, or verifierVerdict.
 *   - The returned value FAILS validateToolEvidenceHandle intentionally.
 *   - It MUST NOT be used as the gate's definitive semanticArtifactPath resolver.
 *
 * @param base         — the ToolResultBase from EventStore or a tool result.
 * @param toolOutputRoot — absolute path to PI_TOOL_OUTPUT_DIR for this project.
 */
export function toolResultBaseToMigrationDebt(
  base: ToolResultBase,
  toolOutputRoot: string
): MigrationDebtHandle {
  const isPassed = base.status === 'PASSED';
  return {
    _migrationDebt: true as const,
    toolName: base.tool,
    runStatus: base.status as ToolEvidenceRunStatus,
    ...(base.failureCategory ? { failureCategory: base.failureCategory as ToolEvidenceFailureCategory } : {}),
    // REJECTED tools never completed — their outputFile is not a reliable semantic artifact.
    ...(isPassed && base.outputFile
      ? {
        semanticArtifactPath: base.outputFile,
        semanticArtifactBytes: base.outputFileBytes
      }
      : {}),
    toolOutputRoot,
    // These fields are unknown from ToolResultBase — they must be filled by the migrating tool.
    // Deliberately absent so validateToolEvidenceHandle fails on the debt handle.
  };
}

/**
 * The partial, INTENTIONALLY INCOMPLETE handle produced by the migration-debt
 * adapter. It FAILS validateToolEvidenceHandle by design.
 *
 * @see toolResultBaseToMigrationDebt
 */
export interface MigrationDebtHandle {
  /** Always true — signals this is a migration-debt handle, not a full handle. */
  readonly _migrationDebt: true;
  readonly toolName: string;
  readonly runStatus: ToolEvidenceRunStatus;
  readonly failureCategory?: ToolEvidenceFailureCategory;
  /**
   * CANDIDATE semanticArtifactPath from ToolResultBase.outputFile.
   * Present ONLY for PASSED runs. NOT authoritative — the real path may differ
   * once the tool is migrated to emit a full ToolEvidenceHandle.
   */
  readonly semanticArtifactPath?: string;
  readonly semanticArtifactBytes?: number;
  readonly toolOutputRoot: string;
}
