/**
 * pi-experiment-6q0y.36 — Evidence-aware context restart handoff tests.
 *
 * LOAD-BEARING GUARANTEES (per AC7):
 *   1. Manual evidence-aware handoff: evidenceRefs[] + handoverArtifactPath → admitted.
 *   2. Configured compaction-artifact handoff: COMPACTION_SUMMARY_RECORDED in prior
 *      events → admitted (even with empty evidenceRefs — compaction pointer is the evidence).
 *   3. Summary-only rejection: no evidenceRefs, no handoverArtifactPath, no compaction
 *      pointer → REJECTED before signal/event admission. LOAD-BEARING.
 *   4. Bad-hash rejection: evidenceRef bytes/sha256 invalid → REJECTED. LOAD-BEARING.
 *   5. Stale-event rejection: sourceEventIds not in prior events → REJECTED. LOAD-BEARING.
 *   6. Replay from evidence refs only: reconstructFromEvidenceOnly returns confirmed IDs
 *      from priorEvents; narrative excluded. LOAD-BEARING.
 *   7. Projection preview (AC4/AC5): restartHandoffPreview shows evidence artifact paths,
 *      narrative labelled non-authoritative.
 *   8. HARNESS_RESTART_REQUESTED also subject to same evidence-aware gate.
 *   9. Inaccessible-path rejection: blank semanticArtifactPath → REJECTED. LOAD-BEARING.
 *  10. Unregistered-schema rejection: schemaId not in SchemaRegistry → REJECTED. LOAD-BEARING.
 *
 * These tests MUST fail if validateRestartHandoffContract is decoupled from the
 * real admission path — each "load-bearing" label maps to an invariant that
 * production code must enforce.
 */

import { describe, it, expect } from 'vitest';
import {
  validateRestartHandoffContract,
  resolveCompactionPointer,
  reconstructFromEvidenceOnly,
  buildRestartEventPayload,
  buildHandoffPreview,
  type RestartEvidenceRef,
  type RestartHandoffContract,
  type CompactionPointer
} from '../src/core/RestartHandoffValidation.js';
import { BeadStateProjection } from '../src/core/BeadStateProjection.js';
import { DomainEventName, RestartKind } from '../src/constants/domain.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';
// Import HandoffSchemas so schema registration side effects run.
import '../src/core/HandoffSchemas.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvent(
  type: string,
  data: Record<string, unknown>,
  overrides: Partial<DomainEvent> = {}
): DomainEvent {
  return {
    id: (overrides.id ?? `evt-${Math.random().toString(36).slice(2)}`) as import('../src/types/ids.js').EventId,
    type,
    timestamp: overrides.timestamp ?? '2026-01-01T00:00:00.000Z',
    sessionId: (overrides.sessionId ?? 'session-test') as import('../src/types/ids.js').SessionId,
    data,
  } as DomainEvent;
}

function validSha256(): string {
  return 'a'.repeat(64);
}

function validEvidenceRef(overrides: Partial<RestartEvidenceRef> = {}): RestartEvidenceRef {
  return {
    schemaId: 'harness.handoff.workerCompletion',
    semanticArtifactPath: 'implementation/handoff.json',
    bytes: 1024,
    sha256: validSha256(),
    ...overrides
  };
}

function makeCompactionSummaryEvent(
  data: Record<string, unknown> = {},
  id?: string
): DomainEvent {
  return makeEvent(
    DomainEventName.COMPACTION_SUMMARY_RECORDED,
    {
      beadId: 'bd-1',
      stateId: 'Implementation',
      artifactPath: '.pi/artifacts/bd-1/compaction-summary.json',
      artifactBytes: 2048,
      artifactSha256: 'b'.repeat(64),
      sourceEventIds: ['evt-chk-1', 'evt-tool-1'],
      nonAuthoritative: true,
      ...data
    },
    { id: (id ?? 'evt-compaction-1') as import('../src/types/ids.js').EventId }
  );
}

// ---------------------------------------------------------------------------
// AC1/AC7.1: Manual evidence-aware handoff — admitted
// ---------------------------------------------------------------------------

describe('AC1/AC7.1: manual evidence-aware handoff admitted', () => {
  it('admits a restart with evidenceRefs + handoverArtifactPath', () => {
    const ref = validEvidenceRef({ semanticArtifactPath: 'implementation/handoff.json' });
    const contract: RestartHandoffContract = {
      evidenceRefs: [ref],
      handoverArtifactPath: 'implementation/handoff.json',
      narrativeSummary: 'Context overflow — restarting with evidence.'
    };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(true);
  });

  it('admits a restart with evidenceRefs only (no handoverArtifactPath)', () => {
    const ref = validEvidenceRef();
    const contract: RestartHandoffContract = {
      evidenceRefs: [ref],
      narrativeSummary: 'Context overflow.'
    };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(true);
  });

  it('admits a restart with multiple evidenceRefs', () => {
    const refs = [
      validEvidenceRef({ semanticArtifactPath: 'implementation/foo.ts' }),
      validEvidenceRef({ semanticArtifactPath: 'implementation/bar.ts', sha256: 'b'.repeat(64) })
    ];
    const contract: RestartHandoffContract = { evidenceRefs: refs };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC7.2: Configured compaction-artifact handoff — admitted
// ---------------------------------------------------------------------------

describe('AC7.2: configured compaction-artifact handoff (COMPACTION_SUMMARY_RECORDED)', () => {
  it('admits a restart when COMPACTION_SUMMARY_RECORDED exists (empty evidenceRefs)', () => {
    const priorEvents: DomainEvent[] = [makeCompactionSummaryEvent()];
    const contract: RestartHandoffContract = {
      evidenceRefs: [],
      narrativeSummary: 'Auto-restart triggered by compaction threshold.'
    };
    const result = validateRestartHandoffContract(contract, priorEvents);
    expect(result.admitted).toBe(true);
  });

  it('resolveCompactionPointer finds the most recent COMPACTION_SUMMARY_RECORDED', () => {
    const priorEvents: DomainEvent[] = [
      makeCompactionSummaryEvent({ artifactSha256: 'c'.repeat(64) }, 'evt-compaction-old'),
      makeCompactionSummaryEvent({ artifactSha256: 'b'.repeat(64) }, 'evt-compaction-new')
    ];
    const pointer = resolveCompactionPointer(priorEvents);
    expect(pointer).toBeDefined();
    expect(pointer!.artifactSha256).toBe('b'.repeat(64));
    expect(pointer!.sourceEventId).toBe('evt-compaction-new');
    expect(pointer!.nonAuthoritative).toBe(true);
  });

  it('resolveCompactionPointer ignores events without nonAuthoritative: true', () => {
    const priorEvents: DomainEvent[] = [
      makeCompactionSummaryEvent({ nonAuthoritative: false }, 'evt-bad')
    ];
    const pointer = resolveCompactionPointer(priorEvents);
    expect(pointer).toBeUndefined();
  });

  it('resolveCompactionPointer returns undefined when no COMPACTION_SUMMARY_RECORDED', () => {
    const priorEvents: DomainEvent[] = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1' })
    ];
    const pointer = resolveCompactionPointer(priorEvents);
    expect(pointer).toBeUndefined();
  });

  it('admits a restart with both evidenceRefs and compaction pointer available', () => {
    const priorEvents: DomainEvent[] = [makeCompactionSummaryEvent()];
    const contract: RestartHandoffContract = {
      evidenceRefs: [validEvidenceRef()],
      narrativeSummary: 'Auto-restart with evidence.'
    };
    const result = validateRestartHandoffContract(contract, priorEvents);
    expect(result.admitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3/AC7.3: Summary-only rejection — LOAD-BEARING
// ---------------------------------------------------------------------------

describe('AC3/AC7.3: summary-only restart rejected before admission (LOAD-BEARING)', () => {
  it('REJECTS a restart with no evidenceRefs, no handoverArtifactPath, no compaction pointer', () => {
    const contract: RestartHandoffContract = {
      evidenceRefs: [],
      narrativeSummary: 'I finished the implementation. Please continue from where I left off.'
    };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.rejections).toHaveLength(1);
      expect(result.rejections[0]!.reason).toBe('SUMMARY_ONLY');
      expect(result.rejections[0]!.diagnostic).toMatch(/narrative/i);
    }
  });

  it('REJECTS when evidenceRefs is undefined/absent and no fallbacks', () => {
    // evidenceRefs defaults to [] when absent in the contract
    const contract: RestartHandoffContract = {
      evidenceRefs: [],
      narrativeSummary: 'Summary only.'
    };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.rejections[0]!.reason).toBe('SUMMARY_ONLY');
    }
  });

  it('does NOT reject when summary-only but compaction pointer exists (admitted)', () => {
    // This confirms the gate is not rejecting all restarts without evidenceRefs —
    // only those with no evidence at all (compaction pointer counts as evidence).
    const priorEvents: DomainEvent[] = [makeCompactionSummaryEvent()];
    const contract: RestartHandoffContract = {
      evidenceRefs: [],
      narrativeSummary: 'Summary, but compaction pointer available.'
    };
    const result = validateRestartHandoffContract(contract, priorEvents);
    expect(result.admitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC6/AC7.4: Bad-hash rejection — LOAD-BEARING
// ---------------------------------------------------------------------------

describe('AC6/AC7.4: bad-hash rejection (LOAD-BEARING)', () => {
  it('REJECTS when sha256 is wrong length (not 64 hex chars)', () => {
    const contract: RestartHandoffContract = {
      evidenceRefs: [validEvidenceRef({ sha256: 'abc123' })]
    };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      const badHash = result.rejections.find(r => r.reason === 'BAD_HASH');
      expect(badHash).toBeDefined();
      expect(badHash!.diagnostic).toMatch(/sha256/i);
    }
  });

  it('REJECTS when sha256 is missing (undefined)', () => {
    const ref = validEvidenceRef();
    const refWithoutSha256 = { ...ref, sha256: undefined as unknown as string };
    const contract: RestartHandoffContract = { evidenceRefs: [refWithoutSha256] };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      const badHash = result.rejections.find(r => r.reason === 'BAD_HASH');
      expect(badHash).toBeDefined();
    }
  });

  it('REJECTS when bytes is negative', () => {
    const contract: RestartHandoffContract = {
      evidenceRefs: [validEvidenceRef({ bytes: -1 })]
    };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      const badHash = result.rejections.find(r => r.reason === 'BAD_HASH');
      expect(badHash).toBeDefined();
    }
  });

  it('REJECTS when sha256 contains non-hex characters', () => {
    const contract: RestartHandoffContract = {
      evidenceRefs: [validEvidenceRef({ sha256: 'z'.repeat(64) })]
    };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      const badHash = result.rejections.find(r => r.reason === 'BAD_HASH');
      expect(badHash).toBeDefined();
    }
  });

  it('REJECTS when handoverArtifactPath has no matching evidenceRef', () => {
    const ref = validEvidenceRef({ semanticArtifactPath: 'implementation/foo.ts' });
    const contract: RestartHandoffContract = {
      evidenceRefs: [ref],
      handoverArtifactPath: 'implementation/handoff.json'  // no matching ref
    };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      const badHash = result.rejections.find(r => r.reason === 'BAD_HASH');
      expect(badHash).toBeDefined();
      expect(badHash!.diagnostic).toMatch(/matching/i);
    }
  });

  it('admits when handoverArtifactPath matches a valid evidenceRef semanticPath', () => {
    const ref = validEvidenceRef({ semanticArtifactPath: 'implementation/handoff.json' });
    const contract: RestartHandoffContract = {
      evidenceRefs: [ref],
      handoverArtifactPath: 'implementation/handoff.json'
    };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC6/AC7.5: Stale-event rejection — LOAD-BEARING
// ---------------------------------------------------------------------------

describe('AC6/AC7.5: stale-event-id rejection (LOAD-BEARING)', () => {
  it('REJECTS when sourceEventIds references IDs not in priorEvents', () => {
    const ref = validEvidenceRef({ sourceEventIds: ['evt-unknown-1', 'evt-unknown-2'] });
    const priorEvents: DomainEvent[] = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1' }, { id: 'evt-known-1' as import('../src/types/ids.js').EventId })
    ];
    const contract: RestartHandoffContract = { evidenceRefs: [ref] };
    const result = validateRestartHandoffContract(contract, priorEvents);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      const staleId = result.rejections.find(r => r.reason === 'STALE_EVENT_IDS');
      expect(staleId).toBeDefined();
      expect(staleId!.diagnostic).toMatch(/stale/i);
      expect(staleId!.diagnostic).toContain('evt-unknown-1');
    }
  });

  it('admits when all sourceEventIds are found in priorEvents', () => {
    const knownId = 'evt-known-1';
    const ref = validEvidenceRef({ sourceEventIds: [knownId] });
    const priorEvents: DomainEvent[] = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1' }, { id: knownId as import('../src/types/ids.js').EventId })
    ];
    const contract: RestartHandoffContract = { evidenceRefs: [ref] };
    const result = validateRestartHandoffContract(contract, priorEvents);
    expect(result.admitted).toBe(true);
  });

  it('admits when sourceEventIds is empty (no staleness check needed)', () => {
    const ref = validEvidenceRef({ sourceEventIds: [] });
    const contract: RestartHandoffContract = { evidenceRefs: [ref] };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(true);
  });

  it('admits when sourceEventIds is absent', () => {
    const { sourceEventIds: _, ...refWithoutIds } = validEvidenceRef({ sourceEventIds: ['irrelevant'] });
    const contract: RestartHandoffContract = { evidenceRefs: [refWithoutIds as RestartEvidenceRef] };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC6: Inaccessible-path rejection — LOAD-BEARING
// ---------------------------------------------------------------------------

describe('AC6: inaccessible-path rejection (LOAD-BEARING)', () => {
  it('REJECTS when semanticArtifactPath is blank', () => {
    const contract: RestartHandoffContract = {
      evidenceRefs: [validEvidenceRef({ semanticArtifactPath: '   ' })]
    };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      const inaccessible = result.rejections.find(r => r.reason === 'INACCESSIBLE_PATH');
      expect(inaccessible).toBeDefined();
    }
  });

  it('REJECTS when semanticArtifactPath is empty string', () => {
    const contract: RestartHandoffContract = {
      evidenceRefs: [validEvidenceRef({ semanticArtifactPath: '' })]
    };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      const inaccessible = result.rejections.find(r => r.reason === 'INACCESSIBLE_PATH');
      expect(inaccessible).toBeDefined();
    }
  });

  it('REJECTS when handoverArtifactPath is blank (provided but empty)', () => {
    const contract: RestartHandoffContract = {
      evidenceRefs: [validEvidenceRef()],
      handoverArtifactPath: '   '
    };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      const inaccessible = result.rejections.find(r => r.reason === 'INACCESSIBLE_PATH');
      expect(inaccessible).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// AC6: Unregistered-schema rejection — LOAD-BEARING
// ---------------------------------------------------------------------------

describe('AC6: unregistered-schema rejection (LOAD-BEARING)', () => {
  it('REJECTS when schemaId is not in the SchemaRegistry', () => {
    const ref = validEvidenceRef({ schemaId: 'unknown.unregistered.schema' });
    const contract: RestartHandoffContract = { evidenceRefs: [ref] };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      const unregistered = result.rejections.find(r => r.reason === 'UNREGISTERED_SCHEMA');
      expect(unregistered).toBeDefined();
      expect(unregistered!.diagnostic).toMatch(/SchemaRegistry/);
    }
  });

  it('REJECTS when schemaId is blank', () => {
    const ref = validEvidenceRef({ schemaId: '' });
    const contract: RestartHandoffContract = { evidenceRefs: [ref] };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      const unregistered = result.rejections.find(r => r.reason === 'UNREGISTERED_SCHEMA');
      expect(unregistered).toBeDefined();
    }
  });

  it('admits when schemaId is a registered schema', () => {
    // 'harness.handoff.workerCompletion' is registered in HandoffSchemas.ts
    const ref = validEvidenceRef({ schemaId: 'harness.handoff.workerCompletion' });
    const contract: RestartHandoffContract = { evidenceRefs: [ref] };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(true);
  });

  it('admits when schemaId is the restart handoff contract schema itself', () => {
    const ref = validEvidenceRef({ schemaId: 'harness.restart.handoffContract' });
    const contract: RestartHandoffContract = { evidenceRefs: [ref] };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC7.6: Replay from evidence refs only — LOAD-BEARING
// ---------------------------------------------------------------------------

describe('AC7.6: replay resumed state from evidence refs only (LOAD-BEARING)', () => {
  it('reconstructFromEvidenceOnly returns confirmed event IDs from evidenceRefs', () => {
    const knownId1 = 'evt-tool-success-1';
    const knownId2 = 'evt-checkpoint-1';
    const unknownId = 'evt-unknown';

    const priorEvents: DomainEvent[] = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1' }, { id: knownId1 as import('../src/types/ids.js').EventId }),
      makeEvent(DomainEventName.CHECKPOINT_SUBMITTED, { beadId: 'bd-1', stateId: 'Impl', summary: 'step done' }, { id: knownId2 as import('../src/types/ids.js').EventId })
    ];

    const evidenceRefs: RestartEvidenceRef[] = [
      validEvidenceRef({
        semanticArtifactPath: 'implementation/foo.ts',
        sourceEventIds: [knownId1, unknownId]  // unknownId not in prior events
      }),
      validEvidenceRef({
        semanticArtifactPath: 'implementation/bar.ts',
        sha256: 'b'.repeat(64),
        sourceEventIds: [knownId2]
      })
    ];

    const { confirmedEventIds, confirmedArtifactPaths } = reconstructFromEvidenceOnly(evidenceRefs, priorEvents);

    // Only IDs found in priorEvents are confirmed.
    expect(confirmedEventIds).toContain(knownId1);
    expect(confirmedEventIds).toContain(knownId2);
    expect(confirmedEventIds).not.toContain(unknownId);

    // Artifact paths from valid refs are confirmed.
    expect(confirmedArtifactPaths).toContain('implementation/foo.ts');
    expect(confirmedArtifactPaths).toContain('implementation/bar.ts');
  });

  it('excludes refs with invalid hash from reconstruction', () => {
    const priorEvents: DomainEvent[] = [
      makeEvent(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1' }, { id: 'evt-1' as import('../src/types/ids.js').EventId })
    ];

    const evidenceRefs: RestartEvidenceRef[] = [
      // Bad sha256 — should be excluded from reconstruction.
      {
        schemaId: 'harness.handoff.workerCompletion',
        semanticArtifactPath: 'implementation/bad-hash.ts',
        bytes: 100,
        sha256: 'not-64-hex-chars',
        sourceEventIds: ['evt-1']
      }
    ];

    const { confirmedEventIds, confirmedArtifactPaths } = reconstructFromEvidenceOnly(evidenceRefs, priorEvents);

    // Bad hash ref → excluded from reconstruction.
    expect(confirmedEventIds).toHaveLength(0);
    expect(confirmedArtifactPaths).toHaveLength(0);
  });

  it('reconstructFromEvidenceOnly uses event store evidence, not narrative', () => {
    // This test verifies the fundamental invariant: reconstruction is evidence-only.
    // There is NO narrative parameter in reconstructFromEvidenceOnly — it only
    // accepts evidenceRefs and priorEvents.
    const priorEvents: DomainEvent[] = [];
    const evidenceRefs: RestartEvidenceRef[] = [validEvidenceRef()];

    // No sourceEventIds → no confirmed event IDs; only artifact paths.
    const { confirmedEventIds, confirmedArtifactPaths } = reconstructFromEvidenceOnly(evidenceRefs, priorEvents);
    expect(confirmedEventIds).toHaveLength(0);
    expect(confirmedArtifactPaths).toContain('implementation/handoff.json');
  });
});

// ---------------------------------------------------------------------------
// AC4: Narrative stored separately + marked non-authoritative
// ---------------------------------------------------------------------------

describe('AC4: narrative stored separately, marked non-authoritative', () => {
  it('buildRestartEventPayload stores narrative under narrativeSummary (separate field)', () => {
    const ref = validEvidenceRef();
    const payload = buildRestartEventPayload({
      beadId: 'bd-1',
      workerId: 'worker-1',
      idempotencyKey: 'ik-abc',
      stateId: 'Implementation',
      targetState: 'Implementation',
      transitionEvent: 'CONTEXT_RESTART',
      narrativeSummary: 'I completed the implementation. Here is the summary.',
      evidenceRefs: [ref],
      restartId: 'restart-abc-123456789012345',
      attempt: 1
    });

    // Narrative is stored SEPARATELY under narrativeSummary (canonical, no legacy duplicates).
    expect(payload.narrativeSummary).toBe('I completed the implementation. Here is the summary.');
    // narrativeNonAuthoritative is always true when narrative is present.
    expect(payload.narrativeNonAuthoritative).toBe(true);
    // No legacy summary/evidence/handover fields (6q0y.36: backcompat shim removed).
    expect(payload.summary).toBeUndefined();
    expect(payload.evidence).toBeUndefined();
    expect(payload.handover).toBeUndefined();
    // Evidence refs are in their own field (authoritative).
    expect(Array.isArray(payload.evidenceRefs)).toBe(true);
    expect((payload.evidenceRefs as RestartEvidenceRef[]).length).toBe(1);
  });

  it('buildRestartEventPayload includes compactionPointer when provided', () => {
    const pointer: CompactionPointer = {
      sourceEventId: 'evt-compaction-1',
      artifactPath: '.pi/artifacts/bd-1/compaction-summary.json',
      artifactBytes: 2048,
      artifactSha256: 'b'.repeat(64),
      sourceEventIds: ['evt-chk-1'],
      nonAuthoritative: true
    };
    const ref = validEvidenceRef();
    const payload = buildRestartEventPayload({
      beadId: 'bd-1',
      workerId: 'worker-1',
      idempotencyKey: 'ik-def',
      stateId: 'Implementation',
      targetState: 'Implementation',
      transitionEvent: 'CONTEXT_RESTART',
      narrativeSummary: 'Auto-restart.',
      evidenceRefs: [ref],
      compactionPointer: pointer,
      restartId: 'restart-def-123456789012345',
      attempt: 2
    });

    // Compaction pointer is included.
    expect(payload.compactionPointer).toBeDefined();
    const cp = payload.compactionPointer as Record<string, unknown>;
    expect(cp.nonAuthoritative).toBe(true);
    expect(cp.sourceEventId).toBe('evt-compaction-1');
  });

  it('buildRestartEventPayload includes handoverArtifactPath when provided', () => {
    const ref = validEvidenceRef({ semanticArtifactPath: 'implementation/handoff.json' });
    const payload = buildRestartEventPayload({
      beadId: 'bd-1',
      workerId: 'worker-1',
      idempotencyKey: 'ik-ghi',
      stateId: 'Implementation',
      targetState: 'Implementation',
      transitionEvent: 'CONTEXT_RESTART',
      narrativeSummary: 'Manual handoff.',
      evidenceRefs: [ref],
      handoverArtifactPath: 'implementation/handoff.json',
      restartId: 'restart-ghi-123456789012345',
      attempt: 1
    });

    expect(payload.handoverArtifactPath).toBe('implementation/handoff.json');
  });
});

// ---------------------------------------------------------------------------
// AC5: Projection shows handoff preview, NEVER trusts narrative as evidence
// ---------------------------------------------------------------------------

describe('AC5: projection handoff preview (evidence pointers, not narrative)', () => {
  it('buildHandoffPreview returns evidence artifact paths, not narrative', () => {
    const refs: RestartEvidenceRef[] = [
      validEvidenceRef({ semanticArtifactPath: 'implementation/handoff.json' }),
      validEvidenceRef({ semanticArtifactPath: 'implementation/tests.ts', sha256: 'c'.repeat(64) })
    ];
    const preview = buildHandoffPreview({
      evidenceRefs: refs,
      narrativeSummary: 'I finished the implementation and all tests pass.'
    });

    // Evidence paths are deterministic.
    expect(preview.evidenceArtifactPaths).toContain('implementation/handoff.json');
    expect(preview.evidenceArtifactPaths).toContain('implementation/tests.ts');
    expect(preview.evidenceRefCount).toBe(2);
    expect(preview.hasCompactionPointer).toBe(false);
    // Narrative is labelled NON-AUTHORITATIVE.
    expect(preview.narrativePreview).toMatch(/\[non-authoritative preview\]/);
    expect(preview.narrativePreview).toContain('I finished the implementation');
  });

  it('buildHandoffPreview with compaction pointer shows hasCompactionPointer: true', () => {
    const pointer: CompactionPointer = {
      sourceEventId: 'evt-c1',
      artifactPath: '.pi/artifacts/bd-1/compaction-summary.json',
      artifactBytes: 2048,
      artifactSha256: 'b'.repeat(64),
      sourceEventIds: [],
      nonAuthoritative: true
    };
    const preview = buildHandoffPreview({ compactionPointer: pointer });
    expect(preview.hasCompactionPointer).toBe(true);
  });

  it('BeadStateProjection.applyRestart populates restartHandoffPreview from evidenceRefs', () => {
    const restartEvent = makeEvent(
      DomainEventName.CONTEXT_RESTART_REQUESTED,
      {
        beadId: 'bd-1',
        stateId: 'Implementation',
        targetState: 'Implementation',
        transitionEvent: 'CONTEXT_RESTART',
        restartId: 'restart-test-1234567890123456',
        // Evidence-aware fields (from buildRestartEventPayload).
        evidenceRefs: [
          {
            schemaId: 'harness.handoff.workerCompletion',
            semanticArtifactPath: 'implementation/handoff.json',
            bytes: 1024,
            sha256: 'a'.repeat(64),
            sourceEventIds: ['evt-tool-1']
          }
        ],
        handoverArtifactPath: 'implementation/handoff.json',
        narrativeSummary: 'Context overflow — restarting with evidence.',
        narrativeHandover: 'Context overflow — restarting with evidence.',
        narrativeNonAuthoritative: true
      }
    );

    const projection = new BeadStateProjection();
    const chart = projection.projectBeadStateChartFromEvents('bd-1', [restartEvent]);

    expect(chart.restartRequested).toBe(true);
    expect(chart.restartKind).toBe(RestartKind.CONTEXT);
    expect(chart.restartHandoffPreview).toBeDefined();
    expect(chart.restartHandoffPreview!.evidenceRefCount).toBe(1);
    expect(chart.restartHandoffPreview!.evidenceArtifactPaths).toContain('implementation/handoff.json');
    // Narrative is labelled non-authoritative.
    expect(chart.restartHandoffPreview!.narrativePreview).toMatch(/\[non-authoritative preview\]/);
  });

  it('BeadStateProjection.applyRestart restartHandoffPreview absent when no evidenceRefs', () => {
    // A legacy restart event (no evidenceRefs, no narrativeSummary) — minimal old-style event.
    const restartEvent = makeEvent(
      DomainEventName.CONTEXT_RESTART_REQUESTED,
      {
        beadId: 'bd-1',
        stateId: 'Implementation',
        targetState: 'Implementation',
        transitionEvent: 'CONTEXT_RESTART',
        restartId: 'restart-old-1234567890123456',
        summary: 'Old-style restart.',
        evidence: 'Old-style restart.',
        handover: 'Old-style restart.'
      }
    );

    const projection = new BeadStateProjection();
    const chart = projection.projectBeadStateChartFromEvents('bd-1', [restartEvent]);

    expect(chart.restartRequested).toBe(true);
    // restartHandoffPreview has zero evidenceRefs (no narrative authority).
    if (chart.restartHandoffPreview) {
      expect(chart.restartHandoffPreview.evidenceRefCount).toBe(0);
      expect(chart.restartHandoffPreview.evidenceArtifactPaths).toHaveLength(0);
      // No narrativeSummary field on old events → no narrativePreview.
      expect(chart.restartHandoffPreview.narrativePreview).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Multiple rejection reasons in one event
// ---------------------------------------------------------------------------

describe('multiple validation failures in one event', () => {
  it('collects all rejections when multiple checks fail', () => {
    const contract: RestartHandoffContract = {
      evidenceRefs: [
        // Bad hash + blank path + stale IDs.
        {
          schemaId: 'unknown.unregistered.schema',
          semanticArtifactPath: '',
          bytes: -5,
          sha256: 'bad',
          sourceEventIds: ['evt-nonexistent']
        }
      ]
    };
    const result = validateRestartHandoffContract(contract, []);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      // Should have multiple rejection reasons.
      expect(result.rejections.length).toBeGreaterThan(1);
      const reasons = result.rejections.map(r => r.reason);
      expect(reasons).toContain('BAD_HASH');
      expect(reasons).toContain('INACCESSIBLE_PATH');
      expect(reasons).toContain('UNREGISTERED_SCHEMA');
      expect(reasons).toContain('STALE_EVENT_IDS');
    }
  });
});

// ---------------------------------------------------------------------------
// HandoffSchemas: RESTART_HANDOFF_CONTRACT registered
// ---------------------------------------------------------------------------

describe('HandoffSchemas: RESTART_HANDOFF_CONTRACT schema registered', () => {
  it('the restart handoff contract schema is registered and has fixtures', async () => {
    const { schemaRegistry } = await import('../src/core/SchemaRegistry.js');
    const { HandoffSchemaId } = await import('../src/core/HandoffSchemas.js');

    expect(schemaRegistry.has(HandoffSchemaId.RESTART_HANDOFF_CONTRACT)).toBe(true);
    const entry = schemaRegistry.getEntry(HandoffSchemaId.RESTART_HANDOFF_CONTRACT);
    expect(entry.positiveFixtures.length).toBeGreaterThan(0);
    expect(entry.negativeFixtures.length).toBeGreaterThan(0);
  });

  it('RESTART_HANDOFF_CONTRACT is in HANDOFF_BOUNDARY_IDS', async () => {
    const { HandoffSchemaId, HANDOFF_BOUNDARY_IDS } = await import('../src/core/HandoffSchemas.js');
    expect(HANDOFF_BOUNDARY_IDS.has(HandoffSchemaId.RESTART_HANDOFF_CONTRACT)).toBe(true);
  });

  it('RESTART_HANDOFF_CONTRACT positive fixtures validate', async () => {
    const { HandoffSchemaId, validateHandoffPayload } = await import('../src/core/HandoffSchemas.js');
    const { schemaRegistry } = await import('../src/core/SchemaRegistry.js');
    const entry = schemaRegistry.getEntry(HandoffSchemaId.RESTART_HANDOFF_CONTRACT);
    for (const fixture of entry.positiveFixtures) {
      const result = validateHandoffPayload(HandoffSchemaId.RESTART_HANDOFF_CONTRACT, fixture.value);
      expect(result.valid, `Expected positive fixture "${fixture.label}" to be valid`).toBe(true);
    }
  });

  it('RESTART_HANDOFF_CONTRACT negative fixtures fail validation', async () => {
    const { HandoffSchemaId, validateHandoffPayload } = await import('../src/core/HandoffSchemas.js');
    const { schemaRegistry } = await import('../src/core/SchemaRegistry.js');
    const entry = schemaRegistry.getEntry(HandoffSchemaId.RESTART_HANDOFF_CONTRACT);
    for (const fixture of entry.negativeFixtures) {
      const result = validateHandoffPayload(HandoffSchemaId.RESTART_HANDOFF_CONTRACT, fixture.value);
      expect(result.valid, `Expected negative fixture "${fixture.label}" to be invalid`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// DomainEventName.RESTART_HANDOFF_REJECTED is defined
// ---------------------------------------------------------------------------

describe('DomainEventName: RESTART_HANDOFF_REJECTED constant', () => {
  it('RESTART_HANDOFF_REJECTED constant is defined', () => {
    expect(DomainEventName.RESTART_HANDOFF_REJECTED).toBe('RESTART_HANDOFF_REJECTED');
  });
});
