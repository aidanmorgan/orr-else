/**
 * vocabulary.ts — pi-experiment-amq0.11
 *
 * Canonical vocabulary module for all code-owned typed vocabularies in the
 * Orr Else harness.  This is the SINGLE consolidation point for deterministic-
 * behavior concepts that were previously scattered as ad-hoc string literals or
 * widened unions.
 *
 * REUSED (from existing typed sources — NOT redefined here):
 *   - ProjectToolRootKind / ProjectToolBuiltinRootKind (amq0.19 → constants/domain.ts)
 *   - PiLifecycleState / PiLifecycleEvent / RunMode / SupervisorHealthStage
 *     (1elr.10 → core/PiLifecycleStateMachine.ts)
 *   - ToolResultStatus (existing → constants/domain.ts)
 *   - ActionContextMode / ActionRunContext / ThinkingLevel (amq0.12 → constants/domain.ts)
 *   - ToolRunStatus / ToolFailureCategory (existing → contract.ts)
 *   - ProjectToolFailureCategory (existing → plugins/projectTools/failureCategory.ts)
 *
 * NEWLY TYPED HERE (the still-ad-hoc concepts amq0.11 owns):
 *   - ArtifactQueryStatus  ('ok' | 'rejected' | 'summary' | 'schema')
 *   - PathContextStatus    ('found' | 'not_found' | 'out_of_scope')
 *   - GateOutcomeKind      ('advanced' | 'blocked_absent' | 'blocked_fail')
 *   - RequiredToolAuditState ('passed' | 'failed' | 'never_invoked' | 'unavailable')
 *   - ProbeStatus          ('PASSED' | 'REJECTED' | 'UNSAFE' | 'TIMEOUT' | 'OVERSIZE')
 *   - GateDecision         ('ADMIT' | 'DENY')
 *   - RetryDecision        ('RETRY' | 'SUPPRESS' | 'EXHAUSTED' | 'REJECT_NO_IDEMPOTENCY_CLASS')
 *   - RetryNextRoute       ('retry' | 'fail')
 *   - ToolEvidenceSummaryMode ('summary' | 'none')
 *
 * BOUNDARY PARSER (one vocabulary has a genuine external-string boundary):
 *   - parseToolEvidenceSummaryMode — wired at validateToolEvidenceHandle in
 *     ToolEvidenceHandle.ts, which validates an unknown JSON record from the
 *     event store.  That is the real durable-string boundary; the parser is
 *     LOAD-BEARING there (unknown value → rejected before gate/state advance).
 *
 * All other vocabularies are internally-produced (computed in-process, never
 * read back from a persisted string source).  Their compile-time types are the
 * enforcement mechanism; no boundary parsers are needed.
 *
 * JSON/schema string values are deliberately UNCHANGED so persisted records
 * (event logs, configs) remain stable across this refactoring.
 *
 * DESIGN RULES (enforced):
 *   - Each parser rejects unknown values with a deterministic diagnostic.
 *   - No compat adapters, case-folding acceptance, or alias mapping.
 *   - No parallel copies of already-typed concepts.
 *   - Switches over the vocabularies below MUST use exhaustive handling.
 */

// ---------------------------------------------------------------------------
// ParseError — the fail-closed parse boundary result
// ---------------------------------------------------------------------------

/**
 * Returned by boundary parsers when a raw value does not belong to the typed
 * vocabulary.  The diagnostic is deterministic (no Date.now() / Math.random()).
 */
export interface VocabularyParseError {
  readonly ok: false;
  /** The vocabulary that was being parsed. */
  readonly vocabulary: string;
  /** The raw value that was rejected. */
  readonly received: unknown;
  /** Human-readable, deterministic rejection reason. */
  readonly diagnostic: string;
}

/**
 * Successful parse result.
 */
export interface VocabularyParseOk<T> {
  readonly ok: true;
  readonly value: T;
}

export type VocabularyParseResult<T> = VocabularyParseOk<T> | VocabularyParseError;

/** Build a fail-closed diagnostic for unknown vocabulary values. */
function parseError(vocabulary: string, received: unknown, allowed: readonly string[]): VocabularyParseError {
  return {
    ok: false,
    vocabulary,
    received,
    diagnostic:
      `Unknown ${vocabulary} value: ${JSON.stringify(received)}. ` +
      `Allowed values: ${allowed.map(v => JSON.stringify(v)).join(', ')}. ` +
      `Unknown values are rejected before they can satisfy a gate or advance state (amq0.11 fail-closed).`
  };
}

/** Build a successful parse result. */
function parseOk<T>(value: T): VocabularyParseOk<T> {
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// 1. ArtifactQueryStatus
//
// Discriminant of the ArtifactQueryResult discriminated union (ArtifactQuery.ts).
// Previously: raw string literals 'ok' | 'rejected' | 'summary' | 'schema'.
// Internally produced — no boundary parser needed; compile-time types enforce.
// ---------------------------------------------------------------------------

export const ArtifactQueryStatus = {
  OK: 'ok',
  REJECTED: 'rejected',
  SUMMARY: 'summary',
  SCHEMA: 'schema'
} as const satisfies Record<string, string>;

export type ArtifactQueryStatus = typeof ArtifactQueryStatus[keyof typeof ArtifactQueryStatus];

// ---------------------------------------------------------------------------
// 2. PathContextStatus
//
// Discriminant of PathContextResult (PathContext.ts).
// Previously: raw string literals 'found' | 'not_found' | 'out_of_scope'.
// Internally produced — no boundary parser needed; compile-time types enforce.
// ---------------------------------------------------------------------------

export const PathContextStatus = {
  FOUND: 'found',
  NOT_FOUND: 'not_found',
  OUT_OF_SCOPE: 'out_of_scope'
} as const satisfies Record<string, string>;

export type PathContextStatus = typeof PathContextStatus[keyof typeof PathContextStatus];

// ---------------------------------------------------------------------------
// 3. GateOutcomeKind
//
// Classification of a gated transition in the cerdiwen e2e analyzer.
// Previously: raw string literals 'advanced' | 'blocked_absent' | 'blocked_fail'.
// Internally produced — no boundary parser needed; compile-time types enforce.
// ---------------------------------------------------------------------------

export const GateOutcomeKind = {
  ADVANCED: 'advanced',
  BLOCKED_ABSENT: 'blocked_absent',
  BLOCKED_FAIL: 'blocked_fail'
} as const satisfies Record<string, string>;

export type GateOutcomeKind = typeof GateOutcomeKind[keyof typeof GateOutcomeKind];

// ---------------------------------------------------------------------------
// 4. RequiredToolAuditState
//
// Per-tool state in the worker-side required-tool audit (WorkerRunController.ts).
// Previously: widened union 'passed' | 'failed' | 'never_invoked' | 'unavailable'.
// Internally produced — no boundary parser needed; compile-time types enforce.
// ---------------------------------------------------------------------------

export const RequiredToolAuditState = {
  PASSED: 'passed',
  FAILED: 'failed',
  NEVER_INVOKED: 'never_invoked',
  UNAVAILABLE: 'unavailable'
} as const satisfies Record<string, string>;

export type RequiredToolAuditState = typeof RequiredToolAuditState[keyof typeof RequiredToolAuditState];

// ---------------------------------------------------------------------------
// 5. ProbeStatus
//
// Outcome of a single readiness-probe execution (readinessProbe.ts).
// Previously: string union type 'PASSED' | 'REJECTED' | 'UNSAFE' | 'TIMEOUT' | 'OVERSIZE'.
// Internally produced — no boundary parser needed; compile-time types enforce.
// ---------------------------------------------------------------------------

export const ProbeStatus = {
  PASSED: 'PASSED',
  REJECTED: 'REJECTED',
  UNSAFE: 'UNSAFE',
  TIMEOUT: 'TIMEOUT',
  OVERSIZE: 'OVERSIZE'
} as const satisfies Record<string, string>;

export type ProbeStatus = typeof ProbeStatus[keyof typeof ProbeStatus];

// ---------------------------------------------------------------------------
// 6. GateDecision
//
// Startup admission gate decision for a probe (readinessProbe.ts).
// Previously: string union type 'ADMIT' | 'DENY'.
// Internally produced — no boundary parser needed; compile-time types enforce.
// ---------------------------------------------------------------------------

export const GateDecision = {
  ADMIT: 'ADMIT',
  DENY: 'DENY'
} as const satisfies Record<string, string>;

export type GateDecision = typeof GateDecision[keyof typeof GateDecision];

// ---------------------------------------------------------------------------
// 7. RetryDecision
//
// Outcome of a retry pipeline decision (ToolRetryPipeline.ts).
// Previously: string union type 'RETRY' | 'SUPPRESS' | 'EXHAUSTED' | 'REJECT_NO_IDEMPOTENCY_CLASS'.
// Internally produced — no boundary parser needed; compile-time types enforce.
// ---------------------------------------------------------------------------

export const RetryDecision = {
  RETRY: 'RETRY',
  SUPPRESS: 'SUPPRESS',
  EXHAUSTED: 'EXHAUSTED',
  REJECT_NO_IDEMPOTENCY_CLASS: 'REJECT_NO_IDEMPOTENCY_CLASS'
} as const satisfies Record<string, string>;

export type RetryDecision = typeof RetryDecision[keyof typeof RetryDecision];

// ---------------------------------------------------------------------------
// 8. RetryNextRoute
//
// The next route after a retry pipeline decision (ToolRetryPipeline.ts).
// Previously: string union type 'retry' | 'fail'.
// Internally produced — no boundary parser needed; compile-time types enforce.
// ---------------------------------------------------------------------------

export const RetryNextRoute = {
  RETRY: 'retry',
  FAIL: 'fail'
} as const satisfies Record<string, string>;

export type RetryNextRoute = typeof RetryNextRoute[keyof typeof RetryNextRoute];

// ---------------------------------------------------------------------------
// 9. ToolEvidenceSummaryMode
//
// Whether an RTK summary is present on a ToolEvidenceHandle (ToolEvidenceHandle.ts).
// Previously: string union type 'summary' | 'none'.
//
// BOUNDARY PARSER WIRED: validateToolEvidenceHandle in ToolEvidenceHandle.ts
// reads `record['summaryMode']` from an unknown external JSON/event-store record.
// parseToolEvidenceSummaryMode is called there — it is LOAD-BEARING at that
// durable-string boundary (unknown/case-folded values are rejected BEFORE they
// can satisfy a gate or advance state).
// ---------------------------------------------------------------------------

export const ToolEvidenceSummaryMode = {
  SUMMARY: 'summary',
  NONE: 'none'
} as const satisfies Record<string, string>;

export type ToolEvidenceSummaryMode = typeof ToolEvidenceSummaryMode[keyof typeof ToolEvidenceSummaryMode];

const TOOL_EVIDENCE_SUMMARY_MODE_VALUES = Object.values(ToolEvidenceSummaryMode) as readonly ToolEvidenceSummaryMode[];

/**
 * Fail-closed parser for ToolEvidenceSummaryMode.
 *
 * WIRED at validateToolEvidenceHandle (ToolEvidenceHandle.ts): reads
 * `record['summaryMode']` from an unknown external value (JSON parsed from
 * the event store).  Unknown/case-folded/missing values are REJECTED BEFORE
 * they can satisfy a gate or advance state.
 *
 * LOAD-BEARING: removing this call in ToolEvidenceHandle.ts makes the
 * wiring test in tool_evidence_handle.test.ts fail (unknown value no longer
 * rejected at the real boundary).
 */
export function parseToolEvidenceSummaryMode(raw: unknown): VocabularyParseResult<ToolEvidenceSummaryMode> {
  if (typeof raw === 'string' && (TOOL_EVIDENCE_SUMMARY_MODE_VALUES as string[]).includes(raw)) {
    return parseOk(raw as ToolEvidenceSummaryMode);
  }
  return parseError('ToolEvidenceSummaryMode', raw, TOOL_EVIDENCE_SUMMARY_MODE_VALUES);
}

// ---------------------------------------------------------------------------
// Exhaustive switch helper
//
// Used at consuming sites to ensure all vocabulary members are handled.
// TypeScript will emit a type error if a new member is added to a vocabulary
// object and an existing switch does not handle it.
//
// WIRED: used in probeStatusToTaxonomy (readinessProbe.ts) — the default branch
// of that exhaustive switch calls assertNever so an unhandled ProbeStatus member
// is a compile error.
// ---------------------------------------------------------------------------

/**
 * Enforce exhaustive handling at the end of a switch-on-typed-vocab block.
 *
 * Usage:
 *   switch (status) {
 *     case ProbeStatus.UNSAFE:   return 'PROBE_UNSAFE';
 *     case ProbeStatus.TIMEOUT:  return 'PROBE_TIMEOUT';
 *     ...
 *     default: return assertNever(status);
 *   }
 *
 * If a new member is added to ProbeStatus and the switch is not updated,
 * TypeScript raises a type error on the assertNever call.
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unhandled vocabulary value: ${JSON.stringify(value)}`);
}
