/**
 * Typed contract, evaluator JSON Schema, validator, and build helper for
 * baseline verification artifacts produced by the harness verifier path
 * (e.g. run_quality_checks outcomes, artifact_validator verdicts).
 *
 * ## Canonical evaluator schema
 *
 * The exported `VERIFICATION_ARTIFACT_SCHEMA` is the CANONICAL JSON Schema
 * that an evaluator validates a VerificationArtifact against.  Producers
 * (e.g. the run_quality_checks plugin, a post-verification hook) call
 * `buildVerificationArtifact` to emit a conformant artifact, then persist or
 * forward it; evaluators call `validateVerificationArtifact` to parse an
 * unknown payload at the trust boundary and obtain a typed artifact with
 * structured errors on failure.
 *
 * ## Alignment with the harness's structured verification results
 *
 * A tool's own structured verification result conventionally carries
 * { status, counts, affectedPaths, representativeSamples, omissions,
 * nextAction } (the harness no longer defines or shapes this — it is tool-owned
 * as of 0yt5.16/0yt5.17).  The structured payload keys in
 * src/plugins/projectTools/constants.ts (StructuredPayloadSummaryKey) surface
 * `verdict`, `blocking_count`, `total_errors`, and `context_count` as
 * first-class evidence fields that the harness already emits for verifier
 * outcomes.  This contract maps those conventions to a typed, versioned
 * artifact shape that is stable for evaluator consumption:
 *
 *   verdict         ← quality.ts: 'passed'|'failed'; here 'pass'|'fail'
 *   counts.blocking ← blocking_count (structural finding count)
 *   counts.total    ← total_errors   (all findings)
 *   counts.warnings ← context_count  (advisory / context findings)
 *   tool            ← origin tool name (run_quality_checks, artifact_validator, …)
 *   evidenceRefs    ← opaque harness artifact handles (query_artifact artifactId/artifactPath)
 *
 * ## Adoption note (follow-on)
 *
 * This module is ADDITIVE — it is not wired into the live verifier path.
 * Adoption (having run_quality_checks emit a VerificationArtifact alongside
 * its existing structured result) is a follow-on task that touches quality.ts
 * and/or the result-envelope pipeline; kept out of scope here to stay surgical.
 */

// ---- Schema version ----

/** Bump when the contract shape changes in a backwards-incompatible way. */
export const VERIFICATION_ARTIFACT_SCHEMA_VERSION = '1.0.0';

// ---- Typed contract ----

/**
 * A structured baseline verification artifact emitted by the harness verifier
 * path and consumed by an evaluator to make pass/fail decisions with evidence.
 */
export interface VerificationArtifact {
  /** Identifies the schema revision.  Must equal VERIFICATION_ARTIFACT_SCHEMA_VERSION. */
  schemaVersion: string;

  /** Overall verdict: 'pass' when all blocking checks cleared, 'fail' otherwise. */
  verdict: 'pass' | 'fail';

  /** Name of the originating tool (e.g. 'run_quality_checks', 'artifact_validator'). */
  tool: string;

  /** Numeric summary counts extracted from the verifier result. */
  counts: VerificationCounts;

  /**
   * Opaque harness artifact handles (a query_artifact artifactId/artifactPath)
   * that a consumer can forward to query_artifact for detailed evidence.
   * Optional: not all verifier calls produce persistent artifacts.
   */
  evidenceRefs?: string[];

  /** Unix epoch millisecond timestamp of when this artifact was created. */
  createdAtMs?: number;
}

/** Count breakdown aligned with the harness's structured verifier payload fields. */
export interface VerificationCounts {
  /** Number of blocking findings (maps to blocking_count / rejectedCheckCount). */
  blocking: number;

  /** Total findings including warnings (maps to total_errors / total count). */
  total?: number;

  /** Advisory / context-only findings (maps to context_count). */
  warnings?: number;

  /** Number of checks that passed (maps to passedCheckCount). */
  passed?: number;
}

// ---- Evaluator JSON Schema ----

/**
 * Canonical JSON Schema (draft-07) for VerificationArtifact.
 *
 * This is the schema that an EVALUATOR validates an unknown payload against
 * before trusting any of its fields.  It is intentionally minimal and
 * additive — non-required fields carry no default constraints so the schema
 * remains forwards-compatible with richer verifier outputs.
 */
export const VERIFICATION_ARTIFACT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'VerificationArtifact',
  title: 'VerificationArtifact',
  description:
    'Baseline verification artifact emitted by the harness verifier path. '
    + 'An evaluator validates an unknown payload against this schema before '
    + 'making pass/fail decisions.',
  type: 'object',
  required: ['schemaVersion', 'verdict', 'tool', 'counts'],
  additionalProperties: true,
  properties: {
    schemaVersion: {
      type: 'string',
      description: 'Schema revision identifier; must equal "' + VERIFICATION_ARTIFACT_SCHEMA_VERSION + '".',
      minLength: 1
    },
    verdict: {
      type: 'string',
      enum: ['pass', 'fail'],
      description: 'Overall verdict: pass when all blocking checks cleared, fail otherwise.'
    },
    tool: {
      type: 'string',
      description: 'Name of the originating tool.',
      minLength: 1
    },
    counts: {
      type: 'object',
      required: ['blocking'],
      additionalProperties: false,
      description: 'Numeric summary counts from the verifier result.',
      properties: {
        blocking: {
          type: 'integer',
          minimum: 0,
          description: 'Number of blocking findings.'
        },
        total: {
          type: 'integer',
          minimum: 0,
          description: 'Total findings including warnings.'
        },
        warnings: {
          type: 'integer',
          minimum: 0,
          description: 'Advisory / context-only findings.'
        },
        passed: {
          type: 'integer',
          minimum: 0,
          description: 'Number of checks that passed.'
        }
      }
    },
    evidenceRefs: {
      type: 'array',
      items: { type: 'string' },
      description: 'Opaque harness artifact handles for detailed evidence lookup.'
    },
    createdAtMs: {
      type: 'number',
      description: 'Unix epoch millisecond timestamp of artifact creation.'
    }
  }
} as const;

// ---- Validator ----

/** Successful validation result — typed artifact, no leakage of `any`. */
export type ValidVerificationArtifact = { valid: true; artifact: VerificationArtifact };
/** Failed validation result — structured error messages. */
export type InvalidVerificationArtifact = { valid: false; errors: string[] };

/**
 * Validates an unknown value against the VerificationArtifact contract.
 *
 * Parsing is done at the trust boundary: the function accepts `unknown` and
 * returns either a typed `VerificationArtifact` (on success) or a list of
 * structured error strings (on failure).  No `any` leaks into the return type.
 *
 * This is a hand-rolled structural validator aligned with the schema above so
 * no additional dependency is required (Ajv is already a project dependency
 * via ConfigLoader but is not imported here to keep this module pure and
 * independently testable without file I/O).
 */
export function validateVerificationArtifact(
  value: unknown
): ValidVerificationArtifact | InvalidVerificationArtifact {
  const errors: string[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, errors: ['root: must be a non-null object'] };
  }

  const record = value as Record<string, unknown>;

  // ---- schemaVersion ----
  if (typeof record['schemaVersion'] !== 'string' || record['schemaVersion'].length === 0) {
    errors.push('schemaVersion: must be a non-empty string');
  }

  // ---- verdict ----
  if (record['verdict'] !== 'pass' && record['verdict'] !== 'fail') {
    errors.push(`verdict: must be 'pass' or 'fail', got ${JSON.stringify(record['verdict'])}`);
  }

  // ---- tool ----
  if (typeof record['tool'] !== 'string' || record['tool'].length === 0) {
    errors.push('tool: must be a non-empty string');
  }

  // ---- counts ----
  const counts = record['counts'];
  if (typeof counts !== 'object' || counts === null || Array.isArray(counts)) {
    errors.push('counts: must be a non-null object');
  } else {
    const c = counts as Record<string, unknown>;

    if (typeof c['blocking'] !== 'number' || !Number.isInteger(c['blocking']) || c['blocking'] < 0) {
      errors.push('counts.blocking: must be a non-negative integer');
    }

    for (const optional of ['total', 'warnings', 'passed'] as const) {
      const v = c[optional];
      if (v !== undefined) {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
          errors.push(`counts.${optional}: must be a non-negative integer when present`);
        }
      }
    }
  }

  // ---- evidenceRefs (optional) ----
  const evidenceRefs = record['evidenceRefs'];
  if (evidenceRefs !== undefined) {
    if (!Array.isArray(evidenceRefs)) {
      errors.push('evidenceRefs: must be an array when present');
    } else {
      evidenceRefs.forEach((item, index) => {
        if (typeof item !== 'string') {
          errors.push(`evidenceRefs[${index}]: must be a string`);
        }
      });
    }
  }

  // ---- createdAtMs (optional) ----
  const createdAtMs = record['createdAtMs'];
  if (createdAtMs !== undefined && typeof createdAtMs !== 'number') {
    errors.push('createdAtMs: must be a number when present');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Safe cast: all required fields validated above.
  const artifact: VerificationArtifact = {
    schemaVersion: record['schemaVersion'] as string,
    verdict: record['verdict'] as 'pass' | 'fail',
    tool: record['tool'] as string,
    counts: buildCountsFromRecord(counts as Record<string, unknown>),
    ...(evidenceRefs !== undefined ? { evidenceRefs: evidenceRefs as string[] } : {}),
    ...(typeof createdAtMs === 'number' ? { createdAtMs } : {})
  };

  return { valid: true, artifact };
}

function buildCountsFromRecord(c: Record<string, unknown>): VerificationCounts {
  const counts: VerificationCounts = { blocking: c['blocking'] as number };
  if (typeof c['total'] === 'number') counts.total = c['total'];
  if (typeof c['warnings'] === 'number') counts.warnings = c['warnings'];
  if (typeof c['passed'] === 'number') counts.passed = c['passed'];
  return counts;
}

// ---- Build helper ----

/** Input to the build helper — the minimal verified result a producer has available. */
export interface VerificationArtifactInput {
  /** Overall verdict from the verifier. */
  verdict: 'pass' | 'fail';
  /** Count breakdown from the structured verifier result. */
  counts: VerificationCounts;
  /** Name of the originating tool.  Defaults to 'run_quality_checks'. */
  tool?: string;
  /** Opaque harness artifact handles to attach as evidence references. */
  evidenceRefs?: string[];
  /** Override creation timestamp (milliseconds since epoch); defaults to Date.now(). */
  createdAtMs?: number;
}

const DEFAULT_TOOL = 'run_quality_checks';

/**
 * Builds a conformant VerificationArtifact from a structured verifier result.
 *
 * Producers (e.g. the run_quality_checks plugin or a post-verification hook)
 * call this helper to obtain a schema-valid artifact without constructing the
 * object manually.  The returned artifact is immediately conformant with
 * `VERIFICATION_ARTIFACT_SCHEMA` and will pass `validateVerificationArtifact`.
 *
 * @example
 * ```ts
 * const artifact = buildVerificationArtifact({
 *   verdict: verdict === 'passed' ? 'pass' : 'fail',
 *   counts: { blocking: blockingCount, total: totalErrors, warnings: contextCount }
 * });
 * ```
 */
export function buildVerificationArtifact(input: VerificationArtifactInput): VerificationArtifact {
  const { verdict, counts, tool = DEFAULT_TOOL, evidenceRefs, createdAtMs } = input;
  return {
    schemaVersion: VERIFICATION_ARTIFACT_SCHEMA_VERSION,
    verdict,
    tool,
    counts,
    ...(evidenceRefs !== undefined && evidenceRefs.length > 0 ? { evidenceRefs } : {}),
    createdAtMs: createdAtMs ?? Date.now()
  };
}
