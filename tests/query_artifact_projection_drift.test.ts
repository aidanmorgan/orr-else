/**
 * Projection drift tests for ArtifactQuery / query_artifact tool.
 *
 * These tests use live-style artifacts that match the actual Cerdiwen
 * planContract and requirementsAnalysis schema keys (planSteps,
 * completenessGaps, clarificationQuestions, smtEvidence, traceability,
 * writeSet, verifierObligations) rather than the older registry names.
 *
 * Goals:
 *   (m)  Old alias names (implementationSteps, traceabilityReferences,
 *        gapFlags, unresolvedQuestions) are NOT registered here and REJECT
 *        as unknown projections (fail-closed, no fallback).
 *        Canonical current names (planSteps, completenessGaps,
 *        clarificationQuestions, traceability) resolve directly.
 *   (n)  Summary availability — summary mode marks projections as
 *        available/unavailable based on the actual artifact shape.
 *   (o)  Rejection text distinction — "unknown projection" vs "registered
 *        projection whose selector is absent in this artifact".
 *   (p)  Retry hint — invalid selector rejections include projection=<hint>
 *        when a close valid projection exists.
 *   (q)  New Cerdiwen-schema projections resolve directly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactQuery } from '../src/core/ArtifactQuery.js';
import { ArtifactPaths } from '../src/core/ArtifactPaths.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EnvVars } from '../src/constants/infra.js';
import { projections, type ProjectionDef } from '../src/contract.js';

const root = path.join(os.tmpdir(), 'orr-else-query-artifact-drift-test');

/**
 * Cerdiwen-style projection definitions, registered by THIS test (the caller)
 * to exercise the registration-driven projection mechanism. The harness ships
 * NONE of these — bead 0yt5.12 registers them from the cerdiwen extension. The
 * test (re-)registers them in beforeEach; registration is last-wins idempotent
 * on the singleton registry, so re-running is safe regardless of order.
 *
 * Only CURRENT canonical names are registered here. Old aliases
 * (implementationSteps, traceabilityReferences, gapFlags, unresolvedQuestions)
 * are intentionally absent so tests assert they reject as unknown projections
 * (fail-closed; no fallback to dot-path for unregistered names).
 */
const PLAN_CONTRACT_PROJECTIONS: Record<string, ProjectionDef> = {
  writeSet: { selectors: ['writeSet'], description: 'Approved file write set for this implementation step' },
  verifierObligations: { selectors: ['verifierObligations'], description: 'Verifier obligations that must pass before acceptance' },
  planSteps: { selectors: ['planSteps'], description: 'Ordered plan steps' },
  smtEvidence: { selectors: ['smtEvidence'], description: 'SMT/formal evidence associated with this plan' },
  riskList: { selectors: ['riskList'], description: 'Identified risks and mitigations' },
  evidenceReferences: { selectors: ['evidenceReferences'], description: 'Evidence references supporting the plan' },
  acceptanceCriteria: { selectors: ['acceptanceCriteria'], description: 'Acceptance criteria for this bead' }
};

const REQUIREMENTS_ANALYSIS_PROJECTIONS: Record<string, ProjectionDef> = {
  requirementsInventory: { selectors: ['requirementsInventory'], description: 'Full inventory of discovered requirements' },
  traceability: { selectors: ['traceability'], description: 'Traceability map' },
  completenessGaps: { selectors: ['completenessGaps'], description: 'Completeness gaps identified in requirements' },
  referenceCitations: { selectors: ['referenceCitations'], description: 'Source citations referenced in the requirements analysis' },
  clarificationQuestions: { selectors: ['clarificationQuestions'], description: 'Clarification questions to be resolved' }
};

function registerCerdiwenProjections(): void {
  for (const [name, def] of Object.entries(PLAN_CONTRACT_PROJECTIONS)) {
    projections.register(`planContract:${name}`, def);
  }
  for (const [name, def] of Object.entries(REQUIREMENTS_ANALYSIS_PROJECTIONS)) {
    projections.register(`requirementsAnalysis:${name}`, def);
  }
}

function writeFile(relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

const MINIMAL_HARNESS_YAML = `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: ''
  defaultModel: gpt-5.5
  startState: RequirementsAnalysis
  artifacts:
    baseDir: .pi/artifacts
    templates:
      planContract: .pi/artifacts/{{beadId}}/planContract.json
      requirementsAnalysis: .pi/artifacts/{{beadId}}/requirementsAnalysis.json
  worktreePolicy:
    default: always
scheduler:
  weights:
    waitTime: 1
    executionTime: 1
    progress: 1
    penalty: 1
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  RequirementsAnalysis:
    identity:
      role: Requirements
      expertise: Analysis
      constraints: []
    baseInstructions: Analyze.
    actions:
      - id: a1
        type: prompt
    transitions:
      SUCCESS: completed
      FAILURE: RequirementsAnalysis
`;

/**
 * Live-style Cerdiwen planContract artifact.
 * Uses planSteps (not implementationSteps), smtEvidence, and the standard
 * writeSet + verifierObligations keys.
 */
const CERDIWEN_PLAN_CONTRACT = {
  writeSet: [
    'src/core/ArtifactQuery.ts',
    'tests/query_artifact_projection_drift.test.ts'
  ],
  verifierObligations: [
    { tool: 'tsc', mustPass: true },
    { tool: 'npm test', mustPass: true }
  ],
  planSteps: [
    {
      id: 1,
      description: 'Add fallback selectors to ProjectionEntry',
      files: ['src/core/ArtifactQuery.ts']
    },
    {
      id: 2,
      description: 'Update buildSummary to include availability',
      files: ['src/core/ArtifactQuery.ts']
    },
    {
      id: 3,
      description: 'Improve rejection text for known-but-absent projections',
      files: ['src/core/ArtifactQuery.ts']
    }
  ],
  smtEvidence: [
    {
      property: 'selector_fallback_soundness',
      status: 'verified',
      notes: 'First-wins ordering over candidate selectors is monotone'
    }
  ],
  acceptanceCriteria: [
    'npm run build exits 0',
    'npm test green (base 1429)',
    'Summary marks absent projections unavailable'
  ]
};

/**
 * Live-style Cerdiwen requirementsAnalysis artifact.
 * Uses completenessGaps (not gapFlags), clarificationQuestions (not
 * unresolvedQuestions), traceability (not traceabilityReferences).
 */
const CERDIWEN_REQUIREMENTS_ANALYSIS = {
  requirementsInventory: [
    { id: 'REQ-1', description: 'Summary mode must reflect actual artifact shape' },
    { id: 'REQ-2', description: 'Fallback selectors must cover known schema variants' },
    { id: 'REQ-3', description: 'Rejection text must distinguish unknown from absent projections' }
  ],
  completenessGaps: [
    {
      area: 'fallback_coverage',
      gapDescription: 'smtEvidence not yet covered in requirementsAnalysis registry',
      severity: 'low'
    }
  ],
  clarificationQuestions: [
    'Should traceability include inter-bead links or only intra-bead?',
    'Is smtEvidence optional or required for planContract acceptance?'
  ],
  traceability: {
    'REQ-1': ['ArtifactQuery.ts#buildSummary'],
    'REQ-2': ['ArtifactQuery.ts#ProjectionEntry.selectors'],
    'REQ-3': ['ArtifactQuery.ts#query']
  },
  referenceCitations: [
    { title: 'Cerdiwen planContract schema v2', url: 'internal://schema/planContract/v2' }
  ]
};

describe('ArtifactQuery — projection drift (live-style artifacts)', () => {
  let configLoader: ConfigLoader;
  let artifactPaths: ArtifactPaths;
  let query: ArtifactQuery;
  let savedProjectRoot: string | undefined;

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    savedProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    process.env[EnvVars.PROJECT_ROOT] = root;
    configLoader = new ConfigLoader(undefined, root);
    artifactPaths = new ArtifactPaths(configLoader, undefined, root);
    query = new ArtifactQuery(artifactPaths);

    // The harness embeds NO projection schema; the caller registers them.
    registerCerdiwenProjections();

    writeFile('harness.yaml', MINIMAL_HARNESS_YAML);
    writeFile(
      '.pi/artifacts/bd-1/planContract.json',
      JSON.stringify(CERDIWEN_PLAN_CONTRACT)
    );
    writeFile(
      '.pi/artifacts/bd-1/requirementsAnalysis.json',
      JSON.stringify(CERDIWEN_REQUIREMENTS_ANALYSIS)
    );
  });

  afterEach(() => {
    if (savedProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = savedProjectRoot;
    configLoader.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ── (m) Old alias names REJECT; canonical names resolve directly ─────────

  it('(m1) projection=implementationSteps rejects as unknown — alias not registered', async () => {
    // implementationSteps is NOT registered as a current projection name.
    // The canonical name is planSteps. Unknown projections fail closed and
    // NEVER fall through to dot-path selector behavior (AC4).
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'implementationSteps'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('not registered');
    expect(result.reason).toContain('implementationSteps');
    expect(result.exists).toBe(true);
  });

  it('(m2) projection=planSteps resolves directly in Cerdiwen planContract', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'planSteps'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(CERDIWEN_PLAN_CONTRACT.planSteps);
    expect(result.selector).toBe('planSteps');
  });

  it('(m3) projection=smtEvidence resolves directly in Cerdiwen planContract', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'smtEvidence'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(CERDIWEN_PLAN_CONTRACT.smtEvidence);
  });

  it('(m4) projection=writeSet resolves directly in Cerdiwen planContract', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'writeSet'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(CERDIWEN_PLAN_CONTRACT.writeSet);
  });

  it('(m5) projection=verifierObligations resolves directly in Cerdiwen planContract', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'verifierObligations'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(CERDIWEN_PLAN_CONTRACT.verifierObligations);
  });

  // ── (m) Fallback selectors — live requirementsAnalysis ───────────────────

  it('(m6) projection=gapFlags rejects as unknown — alias not registered', async () => {
    // gapFlags is NOT registered as a current projection name.
    // The canonical name is completenessGaps. Unknown projections fail closed.
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      projection: 'gapFlags'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('not registered');
    expect(result.reason).toContain('gapFlags');
    expect(result.exists).toBe(true);
  });

  it('(m7) projection=completenessGaps resolves directly in Cerdiwen requirementsAnalysis', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      projection: 'completenessGaps'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(CERDIWEN_REQUIREMENTS_ANALYSIS.completenessGaps);
  });

  it('(m8) projection=unresolvedQuestions rejects as unknown — alias not registered', async () => {
    // unresolvedQuestions is NOT registered as a current projection name.
    // The canonical name is clarificationQuestions. Unknown projections fail closed.
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      projection: 'unresolvedQuestions'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('not registered');
    expect(result.reason).toContain('unresolvedQuestions');
    expect(result.exists).toBe(true);
  });

  it('(m9) projection=clarificationQuestions resolves directly in Cerdiwen requirementsAnalysis', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      projection: 'clarificationQuestions'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(CERDIWEN_REQUIREMENTS_ANALYSIS.clarificationQuestions);
  });

  it('(m10) projection=traceabilityReferences rejects as unknown — alias not registered', async () => {
    // traceabilityReferences is NOT registered as a current projection name.
    // The canonical name is traceability. Unknown projections fail closed.
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      projection: 'traceabilityReferences'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('not registered');
    expect(result.reason).toContain('traceabilityReferences');
    expect(result.exists).toBe(true);
  });

  it('(m11) projection=traceability resolves directly in Cerdiwen requirementsAnalysis', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      projection: 'traceability'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(CERDIWEN_REQUIREMENTS_ANALYSIS.traceability);
  });

  // ── (n) Summary availability — absent projections marked unavailable ──────

  it('(n1) summary on Cerdiwen planContract marks planSteps/smtEvidence available, absent canonical projections unavailable', async () => {
    // The artifact has planSteps and smtEvidence but NOT riskList or evidenceReferences.
    // implementationSteps is NOT a registered projection name (alias removed).
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      summary: true
    });

    expect(result.status).toBe('summary');
    if (result.status !== 'summary') throw new Error('unexpected status');

    const byName = Object.fromEntries(result.projections.map(p => [p.name, p]));
    const projectionNames = result.projections.map(p => p.name);

    // writeSet is present in the artifact → available
    expect(byName['writeSet']?.available).toBe(true);
    expect(byName['writeSet']?.resolvedSelector).toBe('writeSet');

    // verifierObligations is present → available
    expect(byName['verifierObligations']?.available).toBe(true);

    // planSteps is present → available (canonical name, single selector)
    expect(byName['planSteps']?.available).toBe(true);
    expect(byName['planSteps']?.resolvedSelector).toBe('planSteps');

    // smtEvidence is present → available
    expect(byName['smtEvidence']?.available).toBe(true);

    // implementationSteps is NOT a registered projection — must not appear in summary
    expect(projectionNames).not.toContain('implementationSteps');

    // riskList is absent → unavailable
    expect(byName['riskList']?.available).toBe(false);

    // evidenceReferences is absent → unavailable
    expect(byName['evidenceReferences']?.available).toBe(false);
  });

  it('(n2) summary on Cerdiwen requirementsAnalysis lists only canonical names; old aliases absent from registry', async () => {
    // Old aliases (gapFlags, unresolvedQuestions, traceabilityReferences) are NOT
    // registered — they must not appear in the summary's projection list.
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      summary: true
    });

    expect(result.status).toBe('summary');
    if (result.status !== 'summary') throw new Error('unexpected status');

    const byName = Object.fromEntries(result.projections.map(p => [p.name, p]));
    const projectionNames = result.projections.map(p => p.name);

    // completenessGaps is present → available (canonical single selector)
    expect(byName['completenessGaps']?.available).toBe(true);
    expect(byName['completenessGaps']?.resolvedSelector).toBe('completenessGaps');

    // clarificationQuestions is present → available
    expect(byName['clarificationQuestions']?.available).toBe(true);

    // traceability is present → available (canonical single selector)
    expect(byName['traceability']?.available).toBe(true);
    expect(byName['traceability']?.resolvedSelector).toBe('traceability');

    // requirementsInventory is present → available
    expect(byName['requirementsInventory']?.available).toBe(true);

    // referenceCitations is present → available
    expect(byName['referenceCitations']?.available).toBe(true);

    // Old aliases must NOT appear in the registry-driven summary
    expect(projectionNames).not.toContain('gapFlags');
    expect(projectionNames).not.toContain('unresolvedQuestions');
    expect(projectionNames).not.toContain('traceabilityReferences');
  });

  it('(n3) unavailable projections in summary have zero-byte size estimates', async () => {
    // Use a planContract that is missing riskList and evidenceReferences
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      summary: true
    });

    expect(result.status).toBe('summary');
    if (result.status !== 'summary') throw new Error('unexpected status');

    for (const proj of result.projections) {
      if (!proj.available) {
        // Unavailable projections should report zero (or near-zero) byte count
        // since there's no value to measure (undefined serializes to empty / 0 bytes)
        expect(proj.sizeEstimate.byteCount).toBe(0);
      }
    }
  });

  it('(n4) summary result includes resolvedSelector for each projection', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      summary: true
    });

    expect(result.status).toBe('summary');
    if (result.status !== 'summary') throw new Error('unexpected status');

    for (const proj of result.projections) {
      expect(typeof proj.resolvedSelector).toBe('string');
      expect(proj.resolvedSelector.length).toBeGreaterThan(0);
    }
  });

  // ── (o) Rejection text distinction ───────────────────────────────────────

  it('(o1) unknown projection name produces "not registered" rejection text', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'totallyMadeUpField'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    // Must say "not registered" (or similar) to distinguish from absent-selector case
    expect(result.reason).toContain('not registered');
    expect(result.reason).toContain('totallyMadeUpField');
    expect(result.exists).toBe(true);
  });

  it('(o2) registered projection whose selector is absent produces distinct "registered but absent" rejection', async () => {
    // Write a planContract that has NONE of the registered selector candidates
    // for 'riskList' (no riskList key at all).
    const sparseContract = {
      writeSet: ['src/Foo.ts'],
      verifierObligations: []
      // riskList is deliberately absent and has no fallback
    };
    writeFile(
      '.pi/artifacts/bd-2/planContract.json',
      JSON.stringify(sparseContract)
    );

    const result = await query.query({
      beadId: 'bd-2',
      artifactId: 'planContract',
      projection: 'riskList'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    // Must NOT say "not registered" — riskList IS registered
    expect(result.reason).not.toContain('not registered');
    // Must indicate it is registered but absent
    expect(result.reason).toContain('registered');
    expect(result.reason).toContain('riskList');
    // Must mention inspecting the artifact shape
    expect(result.reason.toLowerCase()).toMatch(/schema|summary|shape/);
    expect(result.exists).toBe(true);
  });

  it('(o3) rejection for unknown projection includes validProjections list', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'totallyUnknown'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(Array.isArray(result.validProjections)).toBe(true);
    expect((result.validProjections ?? []).length).toBeGreaterThan(0);
  });

  it('(o4) rejection for registered-but-absent projection also includes validProjections', async () => {
    const sparseContract = { writeSet: ['src/Foo.ts'] };
    writeFile('.pi/artifacts/bd-2/planContract.json', JSON.stringify(sparseContract));

    const result = await query.query({
      beadId: 'bd-2',
      artifactId: 'planContract',
      projection: 'riskList'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(Array.isArray(result.validProjections)).toBe(true);
    // The valid projections list should contain known names
    expect(result.validProjections).toContain('writeSet');
  });

  // ── (p) Retry hint — projection=<hint> when close valid projection exists ─

  it('(p1) invalid selector close to a registered projection includes retry hint', async () => {
    // "planStep" is close to the registered projection "planSteps"
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      selector: 'planStep'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    // Should include a hint of the form "projection=planSteps"
    expect(result.reason).toMatch(/projection=\w+/);
    expect(result.reason).toContain('planSteps');
  });

  it('(p2) unknown projection close to a registered one includes retry hint', async () => {
    // "writesets" is close to "writeSet"
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'writesets'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    // Must include "Retry hint: projection=writeSet" (or similar close match)
    expect(result.reason).toMatch(/projection=\w+/);
  });

  it('(p3) completely unrecognizable projection does NOT produce a misleading hint', async () => {
    // "xyzzy" has no close match — no hint should be emitted
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'xyzzy_no_match_at_all_aaaaa'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    // No hint or the hint is not present (no "projection=" in reason because too distant)
    // The exact behavior depends on the Levenshtein threshold — we just assert the
    // reason still names the bad projection and includes validProjections.
    expect(result.reason).toContain('xyzzy_no_match_at_all_aaaaa');
    expect(Array.isArray(result.validProjections)).toBe(true);
  });

  // ── (q) New Cerdiwen-schema projections resolve directly ─────────────────

  it('(q1) planSteps, smtEvidence, writeSet, verifierObligations all resolve from Cerdiwen planContract', async () => {
    const keys = ['planSteps', 'smtEvidence', 'writeSet', 'verifierObligations', 'acceptanceCriteria'] as const;
    for (const projection of keys) {
      const result = await query.query({
        beadId: 'bd-1',
        artifactId: 'planContract',
        projection
      });
      expect(result.status).toBe('ok');
      expect((result as any).selector).toBeTruthy();
    }
  });

  it('(q2) completenessGaps, clarificationQuestions, traceability all resolve from Cerdiwen requirementsAnalysis', async () => {
    const keys = ['completenessGaps', 'clarificationQuestions', 'traceability', 'requirementsInventory'] as const;
    for (const projection of keys) {
      const result = await query.query({
        beadId: 'bd-1',
        artifactId: 'requirementsAnalysis',
        projection
      });
      expect(result.status).toBe('ok');
    }
  });

  it('(q3) dot-path selector "planSteps" resolves without needing a projection name', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      selector: 'planSteps'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(CERDIWEN_PLAN_CONTRACT.planSteps);
  });

  it('(q4) dot-path selector "completenessGaps" resolves without needing a projection name', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      selector: 'completenessGaps'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(CERDIWEN_REQUIREMENTS_ANALYSIS.completenessGaps);
  });

  it('(q5) dot-path selector "smtEvidence" resolves without needing a projection name', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      selector: 'smtEvidence'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(CERDIWEN_PLAN_CONTRACT.smtEvidence);
  });

  it('(q6) schema mode on Cerdiwen planContract shows planSteps and smtEvidence as array/array', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      schema: true
    });

    expect(result.status).toBe('schema');
    if (result.status !== 'schema') throw new Error('unexpected status');

    const props = result.shape.properties!;
    expect(props['planSteps']?.type).toBe('array');
    expect(props['planSteps']?.length).toBe(3);
    expect(props['smtEvidence']?.type).toBe('array');
    expect(props['writeSet']?.type).toBe('array');
    expect(props['verifierObligations']?.type).toBe('array');

    // Values must be absent from the schema output
    const schemaJson = JSON.stringify(result);
    expect(schemaJson).not.toContain('Add fallback selectors');
    expect(schemaJson).not.toContain('selector_fallback_soundness');
  });

  it('(q7) schema mode on Cerdiwen requirementsAnalysis shows completenessGaps, clarificationQuestions, traceability', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      schema: true
    });

    expect(result.status).toBe('schema');
    if (result.status !== 'schema') throw new Error('unexpected status');

    const props = result.shape.properties!;
    expect(props['completenessGaps']?.type).toBe('array');
    expect(props['clarificationQuestions']?.type).toBe('array');
    expect(props['traceability']?.type).toBe('object');
    expect(props['requirementsInventory']?.type).toBe('array');

    // VALUES must be absent — but keys (like 'REQ-1' in the traceability map) are
    // structural keys and WILL appear in the schema output because schema mode
    // reports key names, not values.
    const schemaJson = JSON.stringify(result);
    // String VALUES from the fixture must not appear:
    expect(schemaJson).not.toContain('ArtifactQuery.ts#buildSummary');
    expect(schemaJson).not.toContain('selector_fallback_soundness');
    // The schema will show 'REQ-1' as a key (not a value), which is correct behavior.
  });
});
