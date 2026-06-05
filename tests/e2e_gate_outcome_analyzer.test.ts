/**
 * pi-experiment-0yt5.30 — unit tests for the VERIFIABLE CORE of the dedicated
 * cerdiwen gate e2e: the durable-event-log outcome analyzer.
 *
 * These tests build THREE real-schema DomainEvent[] sequences BY HAND (matching
 * the exact envelopes recorded by the coordinator — VERIFY_EVALUATED with the
 * VerifierGate perTool shape + STATE_TRANSITION_APPLIED with beadId/fromState/
 * nextState/actionId) and assert that:
 *   (a) advance-on-present+valid   ⇒ 'advanced'
 *   (b) block-on-absent-artifact   ⇒ 'blocked_absent'
 *   (c) block-on-present-but-FAIL  ⇒ 'blocked_fail' (surfacing tool + reasons)
 * and that the three assertion helpers PASS on the matching analysis AND THROW
 * on a mismatched expectation (proving non-vacuity).
 *
 * This is the in-repo proof; the live run over real cerdiwen beads is the human
 * step (scripts/e2e/cerdiwen-gate-e2e.mjs).
 */
import { describe, it, expect } from 'vitest';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';
import { DomainEventName } from '../src/constants/index.js';
import { VerifyVerdict } from '../src/contract.js';
import {
  analyzeGateOutcomes,
  assertAdvancedOnValid,
  assertBlockedOnAbsentArtifact,
  assertBlockedOnPresentButFail
} from '../src/e2e/gateOutcomeAnalyzer.js';

let seq = 0;
function evt(type: string, data: Record<string, unknown>): DomainEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    type,
    timestamp: new Date(2026, 5, 4, 0, 0, seq).toISOString(),
    sessionId: 'sess-e2e',
    data
  };
}

function verifyEvaluated(
  beadId: string,
  stateId: string,
  actionId: string,
  blocked: boolean,
  perTool: Array<{ tool: string; verdict?: VerifyVerdict; reasons: string[]; durationMs?: number; threw?: boolean }>
): DomainEvent {
  return evt(DomainEventName.VERIFY_EVALUATED, {
    beadId,
    stateId,
    actionId,
    blocked,
    perTool: perTool.map(p => ({
      tool: p.tool,
      verdict: p.verdict,
      reasons: p.reasons,
      durationMs: p.durationMs ?? 1,
      threw: p.threw
    }))
  });
}

function stateTransition(
  beadId: string,
  fromState: string,
  nextState: string,
  actionId: string
): DomainEvent {
  return evt(DomainEventName.STATE_TRANSITION_APPLIED, {
    beadId,
    fromState,
    nextState,
    actionId,
    transitionEvent: 'COMPLETE'
  });
}

// (a) advance-on-present+valid: gate passes (all PASS/NOT_APPLICABLE), then a
//     REAL advance (fromState !== nextState) is recorded.
function advanceSeq(): DomainEvent[] {
  return [
    verifyEvaluated('cerdiwen-formalizable', 'RequirementsAnalysis', 'verify', false, [
      { tool: 'artifact_validator', verdict: VerifyVerdict.PASS, reasons: ['smt_lib artifact present and valid'] },
      { tool: 'smt_lib', verdict: VerifyVerdict.PASS, reasons: ['SMT-LIB model produced + checked'] }
    ]),
    stateTransition('cerdiwen-formalizable', 'RequirementsAnalysis', 'Implementation', 'verify')
  ];
}

// (b) block-on-absent-artifact: gate blocks; the required tool DID NOT RUN
//     (perTool entry with NO verdict + "not invoked" reason); NO advance — the
//     coordinator records a self-loop transition.
function absentSeq(): DomainEvent[] {
  return [
    verifyEvaluated('cerdiwen-absent-artifact', 'RequirementsAnalysis', 'verify', true, [
      { tool: 'smt_lib', verdict: undefined, reasons: ['required tool smt_lib was not invoked for this transition'] }
    ]),
    // self-loop (block) — NOT an advance.
    stateTransition('cerdiwen-absent-artifact', 'RequirementsAnalysis', 'RequirementsAnalysis', 'verify')
  ];
}

// (c) block-on-present-but-FAIL: gate blocks; the tool RAN but verdict FAIL with
//     reasons (injected sonarqube qualityGate ERROR). NO advance.
function failSeq(): DomainEvent[] {
  return [
    verifyEvaluated('cerdiwen-quality-gate-fail', 'Implementation', 'verify', true, [
      {
        tool: 'sonarqube',
        verdict: VerifyVerdict.FAIL,
        reasons: ['sonarqube quality gate status ERROR', 'new_blocker_violations: 2 (threshold 0)']
      }
    ]),
    stateTransition('cerdiwen-quality-gate-fail', 'Implementation', 'Implementation', 'verify')
  ];
}

describe('analyzeGateOutcomes', () => {
  it('classifies advance-on-present+valid as advanced', () => {
    const analysis = analyzeGateOutcomes(advanceSeq());
    expect(analysis.transitions).toHaveLength(1);
    const t = analysis.transitions[0];
    expect(t.beadId).toBe('cerdiwen-formalizable');
    expect(t.outcome).toBe('advanced');
    expect(t.advanced).toBe(true);
    expect(t.blockingTools).toEqual([]);
  });

  it('does NOT mark advanced when no real state advance follows (self-loop only)', () => {
    // A blocked:false VERIFY_EVALUATED with ONLY a self-loop transition must not
    // be considered advanced — guards against treating a block self-loop as an
    // advance.
    const events: DomainEvent[] = [
      verifyEvaluated('b', 's', 'a', false, [{ tool: 't', verdict: VerifyVerdict.PASS, reasons: ['ok'] }]),
      stateTransition('b', 's', 's', 'a')
    ];
    const analysis = analyzeGateOutcomes(events);
    expect(analysis.transitions[0].outcome).toBe('advanced');
    expect(analysis.transitions[0].advanced).toBe(false);
  });

  it('classifies block-on-absent-artifact as blocked_absent (no verdict)', () => {
    const analysis = analyzeGateOutcomes(absentSeq());
    expect(analysis.transitions).toHaveLength(1);
    const t = analysis.transitions[0];
    expect(t.outcome).toBe('blocked_absent');
    expect(t.advanced).toBe(false);
    expect(t.blockingTools).toHaveLength(1);
    expect(t.blockingTools[0].tool).toBe('smt_lib');
    expect(t.blockingTools[0].verdict).toBeUndefined();
  });

  it('classifies block-on-present-but-FAIL as blocked_fail (surfaces tool + verdict + reasons)', () => {
    const analysis = analyzeGateOutcomes(failSeq());
    expect(analysis.transitions).toHaveLength(1);
    const t = analysis.transitions[0];
    expect(t.outcome).toBe('blocked_fail');
    expect(t.advanced).toBe(false);
    expect(t.blockingTools[0].tool).toBe('sonarqube');
    expect(t.blockingTools[0].verdict).toBe(VerifyVerdict.FAIL);
    expect(t.blockingTools[0].reasons.join(' ')).toContain('quality gate status ERROR');
  });

  it('handles all three sequences together, keyed independently', () => {
    const analysis = analyzeGateOutcomes([...advanceSeq(), ...absentSeq(), ...failSeq()]);
    const kinds = analysis.transitions.map(t => t.outcome).sort();
    expect(kinds).toEqual(['advanced', 'blocked_absent', 'blocked_fail']);
  });
});

describe('assertion helpers — pass on match', () => {
  const all = analyzeGateOutcomes([...advanceSeq(), ...absentSeq(), ...failSeq()]);

  it('assertAdvancedOnValid passes for the formalizable bead', () => {
    expect(() => assertAdvancedOnValid(all, 'cerdiwen-formalizable')).not.toThrow();
  });

  it('assertBlockedOnAbsentArtifact passes for the absent-artifact bead + smt_lib', () => {
    expect(() => assertBlockedOnAbsentArtifact(all, 'cerdiwen-absent-artifact', 'smt_lib')).not.toThrow();
  });

  it('assertBlockedOnPresentButFail passes and surfaces sonarqube reason text', () => {
    const hit = assertBlockedOnPresentButFail(all, 'cerdiwen-quality-gate-fail', 'sonarqube');
    const blocking = hit.blockingTools.find(b => b.tool === 'sonarqube');
    expect(blocking?.verdict).toBe(VerifyVerdict.FAIL);
    expect(blocking?.reasons.join(' ')).toContain('ERROR');
  });
});

describe('assertion helpers — throw on mismatch (non-vacuity)', () => {
  const all = analyzeGateOutcomes([...advanceSeq(), ...absentSeq(), ...failSeq()]);

  it('assertAdvancedOnValid throws when the bead actually blocked', () => {
    expect(() => assertAdvancedOnValid(all, 'cerdiwen-absent-artifact')).toThrow(/assertAdvancedOnValid FAILED/);
  });

  it('assertBlockedOnAbsentArtifact throws for the wrong tool name', () => {
    expect(() => assertBlockedOnAbsentArtifact(all, 'cerdiwen-absent-artifact', 'codemap')).toThrow(
      /assertBlockedOnAbsentArtifact FAILED/
    );
  });

  it('assertBlockedOnAbsentArtifact throws when the bead actually advanced', () => {
    expect(() => assertBlockedOnAbsentArtifact(all, 'cerdiwen-formalizable', 'smt_lib')).toThrow(
      /assertBlockedOnAbsentArtifact FAILED/
    );
  });

  it('assertBlockedOnPresentButFail throws when the block was an absent artifact, not a FAIL', () => {
    expect(() => assertBlockedOnPresentButFail(all, 'cerdiwen-absent-artifact', 'smt_lib')).toThrow(
      /assertBlockedOnPresentButFail FAILED/
    );
  });

  it('assertBlockedOnPresentButFail throws for the wrong tool name', () => {
    expect(() => assertBlockedOnPresentButFail(all, 'cerdiwen-quality-gate-fail', 'python_lsp')).toThrow(
      /assertBlockedOnPresentButFail FAILED/
    );
  });
});
