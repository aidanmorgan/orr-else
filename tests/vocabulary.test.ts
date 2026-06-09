/**
 * vocabulary.test.ts — pi-experiment-amq0.11
 *
 * Tests for the code-owned typed vocabulary module (src/core/vocabulary.ts).
 *
 * ACCEPTANCE CRITERIA (all AC from amq0.11):
 *
 * 1. Vocabulary completeness — each vocabulary exports all its members.
 * 2. The ONE wired boundary parser (parseToolEvidenceSummaryMode) is FAIL-CLOSED:
 *    - Valid members parse to ok:true + value.
 *    - Unknown strings → ok:false (rejected before gate/state).
 *    - Case-folded strings (wrong case) → ok:false.
 *    - null/undefined → ok:false.
 *    - Empty string → ok:false.
 *    - A value REMOVED from the vocabulary → ok:false (backwards-enforcing).
 * 3. The parser is LOAD-BEARING at the real boundary (validateToolEvidenceHandle):
 *    a handle with an unknown summaryMode is rejected by the validator.
 * 4. Serialized JSON/schema string values are UNCHANGED — the as-const members
 *    match the historic literal strings exactly (no persisted-record breakage).
 * 5. assertNever works as an exhaustive-switch helper.
 *
 * NOTE: parsers for internally-produced vocabularies (ArtifactQueryStatus,
 * PathContextStatus, GateOutcomeKind, RequiredToolAuditState, ProbeStatus,
 * GateDecision, RetryDecision, RetryNextRoute) have been DELETED — those values
 * are computed in-process, never read from a persisted string. Compile-time
 * types are the enforcement mechanism for those vocabularies.
 */

import { describe, it, expect } from 'vitest';
import {
  // Vocabulary objects + types
  ArtifactQueryStatus,
  PathContextStatus,
  GateOutcomeKind,
  RequiredToolAuditState,
  ProbeStatus,
  GateDecision,
  RetryDecision,
  RetryNextRoute,
  ToolEvidenceSummaryMode,
  // The ONE wired boundary parser
  parseToolEvidenceSummaryMode,
  // Exhaustive switch helper
  assertNever,
  type VocabularyParseError,
} from '../src/core/vocabulary.js';
import {
  validateToolEvidenceHandle,
  TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
} from '../src/core/ToolEvidenceHandle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Verify a parser rejects a given value (ok:false). */
function assertRejects(
  parser: (raw: unknown) => { ok: boolean },
  value: unknown,
  label: string
): void {
  const result = parser(value);
  expect(result.ok, `${label}: expected ok:false for ${JSON.stringify(value)}`).toBe(false);
}

/** Verify a parser accepts a given value (ok:true + correct value). */
function assertAccepts<T>(
  parser: (raw: unknown) => { ok: boolean; value?: T },
  value: T,
  label: string
): void {
  const result = parser(value as unknown);
  expect(result.ok, `${label}: expected ok:true for ${JSON.stringify(value)}`).toBe(true);
  if (result.ok) {
    expect((result as { value: T }).value).toBe(value);
  }
}

// ---------------------------------------------------------------------------
// AC4: Serialized string values are UNCHANGED (persisted records stable)
// ---------------------------------------------------------------------------

describe('serialized string values unchanged (amq0.11 AC4)', () => {
  it('ArtifactQueryStatus values match historic literals', () => {
    expect(ArtifactQueryStatus.OK).toBe('ok');
    expect(ArtifactQueryStatus.REJECTED).toBe('rejected');
    expect(ArtifactQueryStatus.SUMMARY).toBe('summary');
    expect(ArtifactQueryStatus.SCHEMA).toBe('schema');
  });

  it('PathContextStatus values match historic literals', () => {
    expect(PathContextStatus.FOUND).toBe('found');
    expect(PathContextStatus.NOT_FOUND).toBe('not_found');
    expect(PathContextStatus.OUT_OF_SCOPE).toBe('out_of_scope');
  });

  it('GateOutcomeKind values match historic literals', () => {
    expect(GateOutcomeKind.ADVANCED).toBe('advanced');
    expect(GateOutcomeKind.BLOCKED_ABSENT).toBe('blocked_absent');
    expect(GateOutcomeKind.BLOCKED_FAIL).toBe('blocked_fail');
  });

  it('RequiredToolAuditState values match historic literals', () => {
    expect(RequiredToolAuditState.PASSED).toBe('passed');
    expect(RequiredToolAuditState.FAILED).toBe('failed');
    expect(RequiredToolAuditState.NEVER_INVOKED).toBe('never_invoked');
    expect(RequiredToolAuditState.UNAVAILABLE).toBe('unavailable');
  });

  it('ProbeStatus values match historic literals', () => {
    expect(ProbeStatus.PASSED).toBe('PASSED');
    expect(ProbeStatus.REJECTED).toBe('REJECTED');
    expect(ProbeStatus.UNSAFE).toBe('UNSAFE');
    expect(ProbeStatus.TIMEOUT).toBe('TIMEOUT');
    expect(ProbeStatus.OVERSIZE).toBe('OVERSIZE');
  });

  it('GateDecision values match historic literals', () => {
    expect(GateDecision.ADMIT).toBe('ADMIT');
    expect(GateDecision.DENY).toBe('DENY');
  });

  it('RetryDecision values match historic literals', () => {
    expect(RetryDecision.RETRY).toBe('RETRY');
    expect(RetryDecision.SUPPRESS).toBe('SUPPRESS');
    expect(RetryDecision.EXHAUSTED).toBe('EXHAUSTED');
    expect(RetryDecision.REJECT_NO_IDEMPOTENCY_CLASS).toBe('REJECT_NO_IDEMPOTENCY_CLASS');
  });

  it('RetryNextRoute values match historic literals', () => {
    expect(RetryNextRoute.RETRY).toBe('retry');
    expect(RetryNextRoute.FAIL).toBe('fail');
  });

  it('ToolEvidenceSummaryMode values match historic literals', () => {
    expect(ToolEvidenceSummaryMode.SUMMARY).toBe('summary');
    expect(ToolEvidenceSummaryMode.NONE).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// AC2 + AC3 (load-bearing): parseToolEvidenceSummaryMode — the ONE wired parser
//
// This parser is wired at validateToolEvidenceHandle (ToolEvidenceHandle.ts),
// which reads `record['summaryMode']` from an unknown external JSON/event-store
// record. The parser rejects unknown values BEFORE they can satisfy a gate or
// advance state.
// ---------------------------------------------------------------------------

describe('parseToolEvidenceSummaryMode — fail-closed boundary parser (wired at validateToolEvidenceHandle)', () => {
  it('accepts all valid members', () => {
    assertAccepts(parseToolEvidenceSummaryMode, 'summary', 'summary');
    assertAccepts(parseToolEvidenceSummaryMode, 'none', 'none');
  });

  it('LOAD-BEARING: rejects unknown value', () => {
    assertRejects(parseToolEvidenceSummaryMode, 'partial', 'partial (not a member)');
  });

  it('rejects case-folded value', () => {
    assertRejects(parseToolEvidenceSummaryMode, 'SUMMARY', 'SUMMARY (wrong case)');
    assertRejects(parseToolEvidenceSummaryMode, 'None', 'None (wrong case)');
  });

  it('rejects null/undefined/empty', () => {
    assertRejects(parseToolEvidenceSummaryMode, null, 'null');
    assertRejects(parseToolEvidenceSummaryMode, undefined, 'undefined');
    assertRejects(parseToolEvidenceSummaryMode, '', 'empty string');
  });

  it('rejects a duplicate/alias value (e.g. "rtk")', () => {
    // 'rtk' is not a member — no alias mapping (no-backcompat).
    assertRejects(parseToolEvidenceSummaryMode, 'rtk', 'alias "rtk" (not a member)');
  });

  it('diagnostic includes vocabulary name and received value', () => {
    const result = parseToolEvidenceSummaryMode('bad_value');
    expect(result.ok).toBe(false);
    const error = result as VocabularyParseError;
    expect(error.vocabulary).toBe('ToolEvidenceSummaryMode');
    expect(error.received).toBe('bad_value');
    expect(error.diagnostic).toContain('ToolEvidenceSummaryMode');
    expect(error.diagnostic).toContain('"bad_value"');
  });
});

// ---------------------------------------------------------------------------
// AC3 (load-bearing wiring): parser is used at the REAL boundary
//
// validateToolEvidenceHandle calls parseToolEvidenceSummaryMode on the raw
// unknown record['summaryMode']. This proves the parser is not a self-tested
// orphan — it is wired at the durable external-string boundary.
//
// LOAD-BEARING: removing the parseToolEvidenceSummaryMode call from
// validateToolEvidenceHandle (e.g., replacing with a raw cast) would allow
// 'SUMMARY' (wrong case) and 'partial' (unknown) to bypass the gate check
// and the test below would fail to see a rejected handle.
// ---------------------------------------------------------------------------

describe('wiring: parseToolEvidenceSummaryMode is LOAD-BEARING at validateToolEvidenceHandle', () => {
  const TOOL_OUTPUT_ROOT = '/project/.pi/tool-output';

  function baseHandle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
      toolName: 'run_quality_checks',
      invocationId: 'inv-abc-123',
      runStatus: 'PASSED',
      semanticArtifactPath: `${TOOL_OUTPUT_ROOT}/b/s/a/run_quality_checks/inv/output/result.json`,
      toolOutputRoot: TOOL_OUTPUT_ROOT,
      summaryMode: 'none',
      noSummaryReason: 'no summary',
      admittedHarnessFingerprint: 'sha256:abcdef1234567890',
      admittedExecutionBoundary: 'bead:b/state:s/action:a',
      ...overrides
    };
  }

  it('valid summaryMode "none" is accepted through the real boundary', () => {
    const result = validateToolEvidenceHandle(baseHandle({ summaryMode: 'none' }));
    expect(result.valid).toBe(true);
  });

  it('valid summaryMode "summary" is accepted through the real boundary', () => {
    const handle = baseHandle({
      summaryMode: 'summary',
      noSummaryReason: undefined,
      rtkSummary: {
        schemaTypeName: 'MyRtkSummary',
        owningFile: 'src/tools/run_quality_checks.ts',
        summarySchemaVersion: '1.0.0',
        schemaHash: 'sha256:' + 'a'.repeat(64),
        deterministicSummaryVersion: '1.0.0',
        inputArtifactSchemaId: 'quality-checks',
        inputArtifactSchemaVersion: '1.0.0',
        maximumCounts: { checks: 10 },
        omissionSemantics: 'checks beyond limit omitted',
        summary: { passed: true }
      }
    });
    const result = validateToolEvidenceHandle(handle);
    expect(result.valid).toBe(true);
  });

  it('LOAD-BEARING: unknown summaryMode is REJECTED at the real boundary (fail-closed)', () => {
    // An unknown summaryMode ('partial' is not a ToolEvidenceSummaryMode member).
    // If parseToolEvidenceSummaryMode were removed from validateToolEvidenceHandle,
    // this unknown value would NOT be caught and the handle would pass validation.
    const result = validateToolEvidenceHandle(baseHandle({ summaryMode: 'partial' }));
    expect(result.valid).toBe(false);
    expect(result.valid ? '' : result.errors.join(',')).toContain('summaryMode');
  });

  it('LOAD-BEARING: case-folded summaryMode "SUMMARY" is REJECTED at the real boundary', () => {
    // Wrong case — no case-folding acceptance allowed (no-backcompat rule).
    // Removing the parser call would allow this to pass through unchecked.
    const result = validateToolEvidenceHandle(baseHandle({ summaryMode: 'SUMMARY' }));
    expect(result.valid).toBe(false);
    expect(result.valid ? '' : result.errors.join(',')).toContain('summaryMode');
  });

  it('LOAD-BEARING: null summaryMode is REJECTED at the real boundary', () => {
    const result = validateToolEvidenceHandle(baseHandle({ summaryMode: null }));
    expect(result.valid).toBe(false);
    expect(result.valid ? '' : result.errors.join(',')).toContain('summaryMode');
  });

  it('LOAD-BEARING: undefined summaryMode is REJECTED at the real boundary', () => {
    const { summaryMode: _omit, ...withoutMode } = baseHandle();
    const result = validateToolEvidenceHandle(withoutMode);
    expect(result.valid).toBe(false);
    expect(result.valid ? '' : result.errors.join(',')).toContain('summaryMode');
  });
});

// ---------------------------------------------------------------------------
// AC5: assertNever — exhaustive switch helper
//
// WIRED in probeStatusToTaxonomy (readinessProbe.ts): the default branch of
// that exhaustive switch calls assertNever so an unhandled ProbeStatus member
// is a compile error.
// ---------------------------------------------------------------------------

describe('assertNever — exhaustive switch helper (wired in readinessProbe.ts)', () => {
  it('throws on an unhandled value (simulates a switch default branch)', () => {
    expect(() => {
      assertNever('unexpected_value' as never);
    }).toThrow('Unhandled vocabulary value');
  });

  it('throws with the unhandled value in the error message', () => {
    expect(() => {
      assertNever('some_new_member' as never);
    }).toThrow('some_new_member');
  });

  it('accepts an optional custom message', () => {
    expect(() => {
      assertNever('x' as never, 'custom exhaustive error');
    }).toThrow('custom exhaustive error');
  });
});
