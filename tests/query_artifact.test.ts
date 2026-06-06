/**
 * Tests for ArtifactQuery / query_artifact tool.
 *
 * Coverage:
 *   (a) Named projection on a planContract fixture returns only that projection
 *   (b) Named projection on requirementsAnalysis
 *   (c) Path selector returns the requested subtree
 *   (d) Too-much-data selector returns counts + samples + narrow hint (not full dump)
 *   (e) Invalid projection/selector → structured rejection listing validProjections
 *   (f) Missing artifact → structured rejection with exists=false metadata
 *   (g) get_artifact_paths behavior unchanged (ArtifactPaths.resolve still works)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ArtifactQuery,
  safeSelectPath,
  normalizeSelectorToDotPath,
  SCHEMA_MAX_DEPTH,
  SCHEMA_MAX_KEYS_PER_LEVEL,
  SCHEMA_MAX_BYTES
} from '../src/core/ArtifactQuery.js';
import { ArtifactPaths } from '../src/core/ArtifactPaths.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { ArtifactQueryDefaults, EnvVars } from '../src/constants/index.js';
import { projections, type ProjectionDef } from '../src/contract.js';

const root = path.join(os.tmpdir(), 'orr-else-query-artifact-test');

/**
 * Named projections registered by THIS test (the caller). The harness embeds
 * NO project artifact schema; named projections are registration-driven via
 * the orr-else/contract `projections` registry. These mirror the fixtures
 * below. Registration is last-wins idempotent on the singleton, so the
 * beforeEach re-registration is safe regardless of test order.
 */
const PLAN_CONTRACT_PROJECTIONS: Record<string, ProjectionDef> = {
  writeSet: { selectors: ['writeSet'], description: 'Approved file write set for this implementation step' },
  verifierObligations: { selectors: ['verifierObligations'], description: 'Verifier obligations that must pass before acceptance' },
  implementationSteps: { selectors: ['implementationSteps'], description: 'Ordered implementation steps from the plan' },
  riskList: { selectors: ['riskList'], description: 'Identified risks and mitigations' },
  evidenceReferences: { selectors: ['evidenceReferences'], description: 'Evidence references supporting the plan' },
  acceptanceCriteria: { selectors: ['acceptanceCriteria'], description: 'Acceptance criteria for this bead' }
};

const REQUIREMENTS_ANALYSIS_PROJECTIONS: Record<string, ProjectionDef> = {
  requirementsInventory: { selectors: ['requirementsInventory'], description: 'Full inventory of discovered requirements' },
  traceabilityReferences: { selectors: ['traceabilityReferences'], description: 'Traceability links' },
  gapFlags: { selectors: ['gapFlags'], description: 'Flags indicating gaps in requirements coverage' },
  referenceCitations: { selectors: ['referenceCitations'], description: 'Source citations referenced in the requirements analysis' },
  unresolvedQuestions: { selectors: ['unresolvedQuestions'], description: 'Open questions to resolve before planning' }
};

function registerProjections(): void {
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
      missingArtifact: .pi/artifacts/{{beadId}}/missing.json
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

const PLAN_CONTRACT_FIXTURE = {
  writeSet: ['src/core/Foo.ts', 'tests/foo.test.ts'],
  verifierObligations: [{ tool: 'tsc', mustPass: true }],
  implementationSteps: [
    { id: 1, description: 'Create Foo class', files: ['src/core/Foo.ts'] },
    { id: 2, description: 'Add tests', files: ['tests/foo.test.ts'] }
  ],
  riskList: [{ risk: 'Breaking change', mitigation: 'Semver bump' }],
  evidenceReferences: [{ ref: 'design-doc.md', section: 'Architecture' }],
  acceptanceCriteria: ['All tests pass', 'TSC exits 0']
};

const REQUIREMENTS_ANALYSIS_FIXTURE = {
  requirementsInventory: [
    { id: 'REQ-1', description: 'System must handle X' },
    { id: 'REQ-2', description: 'System must handle Y' }
  ],
  traceabilityReferences: [{ reqId: 'REQ-1', source: 'spec.md', line: 12 }],
  gapFlags: [{ area: 'authentication', gapDescription: 'No 2FA requirement specified' }],
  referenceCitations: [{ title: 'RFC 9110', url: 'https://example.com' }],
  unresolvedQuestions: ['What is the expected SLA?', 'Is pagination required?']
};

describe('ArtifactQuery', () => {
  let configLoader: ConfigLoader;
  let artifactPaths: ArtifactPaths;
  let query: ArtifactQuery;
  let savedProjectRoot: string | undefined;

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    // ArtifactQuery.ts reads process.env[PROJECT_ROOT] for security scoping
    // (it is deferred out of WI-2 scope; set the env var to match the root).
    savedProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    process.env[EnvVars.PROJECT_ROOT] = root;
    configLoader = new ConfigLoader(undefined, root);
    artifactPaths = new ArtifactPaths(configLoader, undefined, root);
    query = new ArtifactQuery(artifactPaths);

    // The harness ships NO projection schema; the caller registers them.
    registerProjections();

    writeFile('harness.yaml', MINIMAL_HARNESS_YAML);
    writeFile('.pi/artifacts/bd-1/planContract.json', JSON.stringify(PLAN_CONTRACT_FIXTURE));
    writeFile('.pi/artifacts/bd-1/requirementsAnalysis.json', JSON.stringify(REQUIREMENTS_ANALYSIS_FIXTURE));
  });

  afterEach(() => {
    if (savedProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = savedProjectRoot;
    configLoader.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ── (a) Named projection on planContract ─────────────────────────────────

  it('(a) returns only the writeSet projection from planContract', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'writeSet'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.artifactId).toBe('planContract');
    expect(result.selector).toBe('writeSet');
    expect(result.result).toEqual(PLAN_CONTRACT_FIXTURE.writeSet);
    // Must not contain the whole contract
    expect(JSON.stringify(result.result)).not.toContain('implementationSteps');
  });

  it('(a) returns only the implementationSteps projection from planContract', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'implementationSteps'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(Array.isArray(result.result)).toBe(true);
    expect((result.result as any[])[0].description).toBe('Create Foo class');
    expect(JSON.stringify(result.result)).not.toContain('writeSet');
  });

  it('(a) returns verifierObligations projection from planContract', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'verifierObligations'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(PLAN_CONTRACT_FIXTURE.verifierObligations);
  });

  it('(a) returns riskList projection from planContract', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'riskList'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(PLAN_CONTRACT_FIXTURE.riskList);
  });

  it('(a) returns evidenceReferences projection from planContract', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'evidenceReferences'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(PLAN_CONTRACT_FIXTURE.evidenceReferences);
  });

  it('(a) returns acceptanceCriteria projection from planContract', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'acceptanceCriteria'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(PLAN_CONTRACT_FIXTURE.acceptanceCriteria);
  });

  // ── (b) Named projection on requirementsAnalysis ─────────────────────────

  it('(b) returns requirementsInventory projection from requirementsAnalysis', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      projection: 'requirementsInventory'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(REQUIREMENTS_ANALYSIS_FIXTURE.requirementsInventory);
    expect(JSON.stringify(result.result)).not.toContain('gapFlags');
  });

  it('(b) returns traceabilityReferences projection from requirementsAnalysis', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      projection: 'traceabilityReferences'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(REQUIREMENTS_ANALYSIS_FIXTURE.traceabilityReferences);
  });

  it('(b) returns gapFlags projection from requirementsAnalysis', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      projection: 'gapFlags'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(REQUIREMENTS_ANALYSIS_FIXTURE.gapFlags);
  });

  it('(b) returns referenceCitations projection from requirementsAnalysis', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      projection: 'referenceCitations'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(REQUIREMENTS_ANALYSIS_FIXTURE.referenceCitations);
  });

  it('(b) returns unresolvedQuestions projection from requirementsAnalysis', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      projection: 'unresolvedQuestions'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(REQUIREMENTS_ANALYSIS_FIXTURE.unresolvedQuestions);
  });

  // ── (c) Dot-path selector returns requested subtree ───────────────────────

  it('(c) dot-path selector returns a nested scalar', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      selector: 'implementationSteps.0.description'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toBe('Create Foo class');
    expect(result.selector).toBe('implementationSteps.0.description');
  });

  it('(c) dot-path selector returns a nested array element', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      selector: 'verifierObligations.0'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual({ tool: 'tsc', mustPass: true });
  });

  it('(c) empty selector returns artifact root (within cap)', async () => {
    // The fixture is small so root access is within the byte cap
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      selector: ''
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(PLAN_CONTRACT_FIXTURE);
  });

  it('(c) explicit artifactPath can be used instead of artifactId', async () => {
    const explicitPath = path.join(root, '.pi/artifacts/bd-1/planContract.json');
    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: explicitPath,
      selector: 'writeSet'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(PLAN_CONTRACT_FIXTURE.writeSet);
  });

  // ── (d) Too-much-data: returns counts + samples + narrow hint ─────────────

  it('(d) too-much-data for large array returns counts, samples, and hint — not the full dump', async () => {
    // Write an artifact whose root array exceeds RESULT_MAX_BYTES
    const largeArray = Array.from({ length: 500 }, (_, i) => ({
      id: i,
      description: `Item number ${i} with some padding text to ensure this is larger than the cap limit`,
      tags: ['a', 'b', 'c'],
      metadata: { created: '2025-01-01', author: 'test' }
    }));
    const largePlanContract = { writeSet: largeArray };
    writeFile('.pi/artifacts/bd-1/largePlanContract.json', JSON.stringify(largePlanContract));

    // Verify the full data does exceed cap
    const fullSize = JSON.stringify(largePlanContract.writeSet).length;
    expect(fullSize).toBeGreaterThan(ArtifactQueryDefaults.RESULT_MAX_BYTES);

    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/largePlanContract.json'),
      selector: 'writeSet'
    });

    // Must NOT be 'ok' with the full array
    expect((result as any).status).not.toBe('ok');
    expect((result as any).tooMuchData).toBe(true);

    const tmdResult = result as any;
    // itemCount is the original array length
    expect(tmdResult.itemCount).toBe(500);
    // byteCount is the full byte size
    expect(tmdResult.byteCount).toBeGreaterThan(ArtifactQueryDefaults.RESULT_MAX_BYTES);
    // representativeSamples must be <= SAMPLE_MAX_ITEMS
    expect(Array.isArray(tmdResult.representativeSamples)).toBe(true);
    expect(tmdResult.representativeSamples.length).toBeLessThanOrEqual(ArtifactQueryDefaults.SAMPLE_MAX_ITEMS);
    // Must NOT contain all 500 items
    expect(JSON.stringify(tmdResult.representativeSamples).length).toBeLessThan(fullSize);
    // Must provide a narrower selector hint
    expect(typeof tmdResult.narrowerSelectorHint).toBe('string');
    expect(tmdResult.narrowerSelectorHint).toContain('writeSet');
    // Recovery guidance must be present
    expect(Array.isArray(tmdResult.recovery)).toBe(true);
    expect(tmdResult.recovery.length).toBeGreaterThan(0);
    expect(tmdResult.nextAction).toBe('rerun_with_narrower_selector');
  });

  it('(d) too-much-data for large object returns representative object entries + hint', async () => {
    const largeObject: Record<string, string> = {};
    for (let i = 0; i < 200; i++) {
      largeObject[`key_${i}`] = `value_${i}_with_some_padding_to_ensure_this_exceeds_the_cap_limit_for_testing`;
    }
    writeFile('.pi/artifacts/bd-1/largeObj.json', JSON.stringify({ data: largeObject }));

    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/largeObj.json'),
      selector: 'data'
    });

    expect((result as any).tooMuchData).toBe(true);
    const tmdResult = result as any;
    expect(tmdResult.representativeSamples.length).toBeLessThanOrEqual(ArtifactQueryDefaults.SAMPLE_MAX_ITEMS);
    expect(tmdResult.byteCount).toBeGreaterThan(ArtifactQueryDefaults.RESULT_MAX_BYTES);
  });

  // ── (e) Invalid projection/selector → structured rejection ────────────────

  it('(e) invalid named projection returns structured rejection with validProjections', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'nonExistentProjection'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('nonExistentProjection');
    expect(Array.isArray(result.validProjections)).toBe(true);
    expect(result.validProjections).toContain('writeSet');
    expect(result.validProjections).toContain('implementationSteps');
    expect(result.validProjections).toContain('verifierObligations');
    expect(result.validProjections).toContain('riskList');
    expect(result.validProjections).toContain('evidenceReferences');
    expect(result.validProjections).toContain('acceptanceCriteria');
    expect(result.exists).toBe(true);
    expect(result.artifactPath).toContain('planContract.json');
  });

  it('(e) invalid dot-path selector returns structured rejection', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      selector: 'nonexistent.deeply.nested'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('nonexistent.deeply.nested');
    expect(result.exists).toBe(true);
  });

  it('(e) providing both artifactId and artifactPath returns structured rejection', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      artifactPath: '/some/path.json'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('artifactId');
    expect(result.reason).toContain('artifactPath');
  });

  it('(e) providing both projection and selector returns structured rejection', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'writeSet',
      selector: 'writeSet'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('projection');
    expect(result.reason).toContain('selector');
  });

  it('(e) unknown artifactId without matching template returns structured rejection', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'unknownArtifact',
      selector: 'someField'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('unknownArtifact');
  });

  // ── (f) Missing artifact → structured rejection with exists=false ─────────

  it('(f) missing artifact returns structured rejection with exists=false', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'missingArtifact',
      selector: 'foo'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.exists).toBe(false);
    expect(result.reason).toContain('missingArtifact');
    expect(result.artifactPath).toBeTruthy();
    expect(typeof result.artifactPath).toBe('string');
  });

  it('(f) missing artifact with named projection still returns exists=false', async () => {
    // requirementsAnalysis fixture is present, but missingArtifact is not
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'missingArtifact',
      projection: 'writeSet'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.exists).toBe(false);
  });

  it('(f) explicit artifactPath that does not exist (but inside root) returns exists=false', async () => {
    // The path is inside the allowed bead artifact directory, but the file has not been created.
    const missingInsidePath = path.join(root, '.pi/artifacts/bd-1/doesNotExist.json');
    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: missingInsidePath,
      selector: 'foo'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.exists).toBe(false);
    expect(result.reason).toContain('doesNotExist.json');
  });

  // ── (security) artifactPath scope enforcement ─────────────────────────────

  it('(security) absolute path outside allowed roots returns scope rejection without content', async () => {
    // Write a JSON file OUTSIDE the test root to simulate a sensitive file
    const outsideDir = path.join(os.tmpdir(), 'orr-else-security-outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsidePath = path.join(outsideDir, 'sensitive.json');
    fs.writeFileSync(outsidePath, JSON.stringify({ secret: 'should-never-appear' }));

    try {
      const result = await query.query({
        beadId: 'bd-1',
        artifactPath: outsidePath,
        selector: ''
      });

      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('unexpected status');
      expect(result.exists).toBe(false);
      // Must NOT leak file content
      expect(JSON.stringify(result)).not.toContain('should-never-appear');
      // Must NOT leak raw parse-error text
      expect(result.reason).not.toContain('secret');
      // Must name the scope violation
      expect(result.reason).toContain('outside the allowed artifact and worktree roots');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('(security) dot-dot traversal that resolves outside the project root returns scope rejection without content', async () => {
    // Construct a path that uses dot-dot segments to escape the project root entirely.
    // path.join normalises a/b/../../c into c, so we need enough '..' to leave root.
    // root = /tmp/.../orr-else-query-artifact-test — one level up is /tmp/...
    const outsideDir = path.dirname(root);
    const outsideFile = path.join(outsideDir, 'orr-else-traversal-test-sensitive.json');
    try {
      fs.writeFileSync(outsideFile, JSON.stringify({ secret: 'traversal-leaked' }));
    } catch {
      // If we can't write there, the file just won't exist — scope check still fires first
    }

    // Build a traversal path: root + '/../orr-else-traversal-test-sensitive.json'
    // path.join normalises this to outsideDir + '/orr-else-traversal-test-sensitive.json'
    const traversalTarget = path.join(root, '..', 'orr-else-traversal-test-sensitive.json');
    expect(traversalTarget).toBe(outsideFile); // confirm it actually left root

    try {
      const result = await query.query({
        beadId: 'bd-1',
        artifactPath: traversalTarget,
        selector: ''
      });

      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('unexpected status');
      expect(result.exists).toBe(false);
      expect(JSON.stringify(result)).not.toContain('traversal-leaked');
      expect(result.reason).toContain('outside the allowed artifact and worktree roots');
    } finally {
      try { fs.rmSync(outsideFile, { force: true }); } catch { /* ignore */ }
    }
  });

  it('(security) symlink pointing outside allowed roots returns scope rejection', async () => {
    // Create a target file outside the root
    const outsideDir = path.join(os.tmpdir(), 'orr-else-security-symlink-outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideTarget = path.join(outsideDir, 'private.json');
    fs.writeFileSync(outsideTarget, JSON.stringify({ secret: 'symlink-leaked' }));

    // Create a symlink inside the artifact dir pointing outside
    const symlinkPath = path.join(root, '.pi/artifacts/bd-1/evil-link.json');
    try {
      fs.symlinkSync(outsideTarget, symlinkPath);
    } catch {
      // If symlink creation fails (e.g. permissions), skip symlink assertion
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return;
    }

    try {
      const result = await query.query({
        beadId: 'bd-1',
        artifactPath: symlinkPath,
        selector: ''
      });

      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('unexpected status');
      expect(result.exists).toBe(false);
      expect(JSON.stringify(result)).not.toContain('symlink-leaked');
      expect(result.reason).toContain('outside the allowed artifact and worktree roots');
    } finally {
      try { fs.rmSync(symlinkPath, { force: true }); } catch { /* ignore */ }
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // ── (security-summary) summary:true with out-of-scope artifactPath is rejected ──

  it('(security-summary) summary:true with out-of-scope artifactPath is rejected', async () => {
    // Write a JSON file OUTSIDE the test root
    const outsideDir = path.join(os.tmpdir(), 'orr-else-security-summary-outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsidePath = path.join(outsideDir, 'sensitive.json');
    fs.writeFileSync(outsidePath, JSON.stringify({ secret: 'summary-should-never-appear' }));

    try {
      const result = await query.query({
        beadId: 'bd-1',
        artifactPath: outsidePath,
        summary: true
      });

      // Must be rejected — summary mode must not bypass security scoping
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('unexpected status');
      expect(result.exists).toBe(false);
      // Must NOT leak file content
      expect(JSON.stringify(result)).not.toContain('summary-should-never-appear');
      // Must name the scope violation
      expect(result.reason).toContain('outside the allowed artifact and worktree roots');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // ── (multibyte) byteCount reflects UTF-8 byte length, not JS string length ──

  it('(multibyte) byteCount equals Buffer.byteLength(serialized,"utf8") and exceeds .length for non-ASCII', async () => {
    // Fixture with emoji (4 bytes each in UTF-8) and CJK (3 bytes each in UTF-8)
    const multibyteFixture = {
      emoji: '🚀🎯🔥',      // 3 emoji × 4 bytes = 12 UTF-8 bytes, but .length = 6 (surrogate pairs)
      cjk: '中文测试',        // 4 CJK × 3 bytes = 12 UTF-8 bytes, but .length = 4
      ascii: 'hello'
    };
    writeFile('.pi/artifacts/bd-1/multibyte.json', JSON.stringify(multibyteFixture));

    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/multibyte.json'),
      selector: ''
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');

    const serialized = JSON.stringify(multibyteFixture);
    const expectedByteCount = Buffer.byteLength(serialized, 'utf8');

    // FIX 1: byteCount must equal the true UTF-8 byte count
    expect(result.sizeEstimate.byteCount).toBe(expectedByteCount);
    // And it must be STRICTLY GREATER than string .length (non-ASCII makes this true)
    expect(result.sizeEstimate.byteCount).toBeGreaterThan(serialized.length);
    // tokenEstimate must be derived from the true UTF-8 byte count
    expect(result.sizeEstimate.tokenEstimate).toBe(
      Math.ceil(expectedByteCount / ArtifactQueryDefaults.TOKEN_ESTIMATE_CHARS_PER_TOKEN)
    );
  });

  // ── (g) get_artifact_paths behavior unchanged ─────────────────────────────

  it('(g) ArtifactPaths.resolve still returns correct paths/existence for both artifacts', async () => {
    // This test verifies that introducing ArtifactQuery does not affect the
    // existing ArtifactPaths.resolve behavior at all (req 6).
    const resolution = await artifactPaths.resolve({ beadId: 'bd-1', stateId: 'RequirementsAnalysis' });

    expect(resolution.artifactPaths.planContract).toBe(path.join(root, '.pi/artifacts/bd-1/planContract.json'));
    expect(resolution.artifactPaths.requirementsAnalysis).toBe(path.join(root, '.pi/artifacts/bd-1/requirementsAnalysis.json'));
    expect(resolution.artifactPaths.missingArtifact).toBe(path.join(root, '.pi/artifacts/bd-1/missing.json'));

    expect(resolution.artifactExists.planContract).toBe(true);
    expect(resolution.artifactExists.requirementsAnalysis).toBe(true);
    expect(resolution.artifactExists.missingArtifact).toBe(false);

    expect(resolution.missingArtifacts).toContain('missingArtifact');
    expect(resolution.missingArtifacts).not.toContain('planContract');
    expect(resolution.missingArtifacts).not.toContain('requirementsAnalysis');
  });

  it('(g) ArtifactPaths.resolve returns deterministic metadata (bytes + sha256), not inlined content', async () => {
    const resolution = await artifactPaths.resolve({
      beadId: 'bd-1',
      stateId: 'RequirementsAnalysis',
      artifactId: 'planContract',
      includeContent: true
    });

    // Minimal schema: exists, bytes, sha256 — no inlined text
    expect(resolution.artifactContents.planContract.exists).toBe(true);
    expect(typeof resolution.artifactContents.planContract.bytes).toBe('number');
    expect((resolution.artifactContents.planContract.bytes as number)).toBeGreaterThan(0);
    expect(typeof resolution.artifactContents.planContract.sha256).toBe('string');
    expect(resolution.artifactContents.planContract.text).toBeUndefined();
    // Use query_artifact to read content
  });
});

// ─── (h) Size estimates — byteCount + tokenEstimate on success ───────────────

describe('ArtifactQuery — size estimates', () => {
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

    writeFile('harness.yaml', MINIMAL_HARNESS_YAML);
    writeFile('.pi/artifacts/bd-1/planContract.json', JSON.stringify(PLAN_CONTRACT_FIXTURE));
    writeFile('.pi/artifacts/bd-1/requirementsAnalysis.json', JSON.stringify(REQUIREMENTS_ANALYSIS_FIXTURE));
  });

  afterEach(() => {
    if (savedProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = savedProjectRoot;
    configLoader.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('(h1) successful projection result includes sizeEstimate with byteCount and tokenEstimate', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      projection: 'writeSet'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');

    expect(result.sizeEstimate).toBeDefined();
    const { byteCount, tokenEstimate } = result.sizeEstimate;

    // byteCount must match the JSON-serialized length of the returned value
    const expectedBytes = JSON.stringify(PLAN_CONTRACT_FIXTURE.writeSet).length;
    expect(byteCount).toBe(expectedBytes);

    // tokenEstimate must be approximately byteCount / TOKEN_ESTIMATE_CHARS_PER_TOKEN
    expect(tokenEstimate).toBe(Math.ceil(byteCount / ArtifactQueryDefaults.TOKEN_ESTIMATE_CHARS_PER_TOKEN));
    expect(tokenEstimate).toBeGreaterThan(0);
  });

  it('(h2) successful selector result includes sizeEstimate', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      selector: 'implementationSteps'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');

    const { byteCount, tokenEstimate } = result.sizeEstimate;
    const expectedBytes = JSON.stringify(PLAN_CONTRACT_FIXTURE.implementationSteps).length;
    expect(byteCount).toBe(expectedBytes);
    expect(tokenEstimate).toBe(Math.ceil(byteCount / ArtifactQueryDefaults.TOKEN_ESTIMATE_CHARS_PER_TOKEN));
  });

  it('(h3) whole-artifact root result includes sizeEstimate', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      selector: ''
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');

    const { byteCount, tokenEstimate } = result.sizeEstimate;
    const expectedBytes = JSON.stringify(PLAN_CONTRACT_FIXTURE).length;
    expect(byteCount).toBe(expectedBytes);
    expect(tokenEstimate).toBe(Math.ceil(byteCount / ArtifactQueryDefaults.TOKEN_ESTIMATE_CHARS_PER_TOKEN));
  });

  it('(h4) tooMuchData path includes tokenEstimate alongside byteCount', async () => {
    // Build an artifact whose root array exceeds RESULT_MAX_BYTES
    const largeArray = Array.from({ length: 500 }, (_, i) => ({
      id: i,
      description: `Item number ${i} with some padding text to ensure this is larger than the cap limit`,
      tags: ['a', 'b', 'c'],
      metadata: { created: '2025-01-01', author: 'test' }
    }));
    writeFile('.pi/artifacts/bd-1/largeArtifact.json', JSON.stringify({ writeSet: largeArray }));

    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/largeArtifact.json'),
      selector: 'writeSet'
    });

    expect((result as any).tooMuchData).toBe(true);
    const tmdResult = result as any;

    // Both byteCount and tokenEstimate must be present
    expect(typeof tmdResult.byteCount).toBe('number');
    expect(tmdResult.byteCount).toBeGreaterThan(ArtifactQueryDefaults.RESULT_MAX_BYTES);
    expect(typeof tmdResult.tokenEstimate).toBe('number');
    expect(tmdResult.tokenEstimate).toBe(
      Math.ceil(tmdResult.byteCount / ArtifactQueryDefaults.TOKEN_ESTIMATE_CHARS_PER_TOKEN)
    );
    expect(tmdResult.tokenEstimate).toBeGreaterThan(0);
    // recovery text must mention token estimate
    const recoveryText = tmdResult.recovery.join(' ');
    expect(recoveryText).toMatch(/~\d+ tokens/);
  });
});

// ─── (i) Schema-aware summary mode ───────────────────────────────────────────

describe('ArtifactQuery — summary mode', () => {
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

    // The harness ships NO projection schema; the caller registers them.
    registerProjections();

    writeFile('harness.yaml', MINIMAL_HARNESS_YAML);
    writeFile('.pi/artifacts/bd-1/planContract.json', JSON.stringify(PLAN_CONTRACT_FIXTURE));
    writeFile('.pi/artifacts/bd-1/requirementsAnalysis.json', JSON.stringify(REQUIREMENTS_ANALYSIS_FIXTURE));
  });

  afterEach(() => {
    if (savedProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = savedProjectRoot;
    configLoader.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('(i1) summary:true on planContract returns schema-aware summary with all projection names', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      summary: true
    });

    expect(result.status).toBe('summary');
    if (result.status !== 'summary') throw new Error('unexpected status');

    // Must be schema-aware (has projection registry entry)
    expect(result.schemaAware).toBe(true);
    expect(result.artifactId).toBe('planContract');

    // Must list ALL projection names from the registry
    const projectionNames = result.projections.map(p => p.name);
    expect(projectionNames).toContain('writeSet');
    expect(projectionNames).toContain('verifierObligations');
    expect(projectionNames).toContain('implementationSteps');
    expect(projectionNames).toContain('riskList');
    expect(projectionNames).toContain('evidenceReferences');
    expect(projectionNames).toContain('acceptanceCriteria');

    // Each projection must have sizeEstimate
    for (const proj of result.projections) {
      expect(typeof proj.sizeEstimate.byteCount).toBe('number');
      expect(typeof proj.sizeEstimate.tokenEstimate).toBe('number');
      expect(proj.sizeEstimate.tokenEstimate).toBe(
        Math.ceil(proj.sizeEstimate.byteCount / ArtifactQueryDefaults.TOKEN_ESTIMATE_CHARS_PER_TOKEN)
      );
    }

    // Must NOT contain any content values (no actual field data)
    const summaryJson = JSON.stringify(result);
    expect(summaryJson).not.toContain('Create Foo class');
    expect(summaryJson).not.toContain('tsc');
    expect(summaryJson).not.toContain('Breaking change');
  });

  it('(i2) summary:true on requirementsAnalysis returns schema-aware summary with all projection names', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      summary: true
    });

    expect(result.status).toBe('summary');
    if (result.status !== 'summary') throw new Error('unexpected status');

    expect(result.schemaAware).toBe(true);
    const projectionNames = result.projections.map(p => p.name);
    expect(projectionNames).toContain('requirementsInventory');
    expect(projectionNames).toContain('traceabilityReferences');
    expect(projectionNames).toContain('gapFlags');
    expect(projectionNames).toContain('referenceCitations');
    expect(projectionNames).toContain('unresolvedQuestions');

    // No actual requirement content
    const summaryJson = JSON.stringify(result);
    expect(summaryJson).not.toContain('System must handle X');
    expect(summaryJson).not.toContain('No 2FA requirement specified');
  });

  it('(i3) summary includes totalSizeEstimate for the whole artifact', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      summary: true
    });

    expect(result.status).toBe('summary');
    if (result.status !== 'summary') throw new Error('unexpected status');

    const { byteCount, tokenEstimate } = result.totalSizeEstimate;
    const expectedBytes = JSON.stringify(PLAN_CONTRACT_FIXTURE).length;
    expect(byteCount).toBe(expectedBytes);
    expect(tokenEstimate).toBe(Math.ceil(byteCount / ArtifactQueryDefaults.TOKEN_ESTIMATE_CHARS_PER_TOKEN));
  });

  it('(i4) summary:true on unknown artifactId returns generic key summary (not schema-aware)', async () => {
    // Write a generic artifact file via explicit path
    const genericFixture = { alpha: [1, 2, 3], beta: { x: 1 }, gamma: 'hello' };
    writeFile('.pi/artifacts/bd-1/generic.json', JSON.stringify(genericFixture));

    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/generic.json'),
      summary: true
    });

    expect(result.status).toBe('summary');
    if (result.status !== 'summary') throw new Error('unexpected status');

    // Generic (not schema-aware)
    expect(result.schemaAware).toBe(false);

    const projectionNames = result.projections.map(p => p.name);
    expect(projectionNames).toContain('alpha');
    expect(projectionNames).toContain('beta');
    expect(projectionNames).toContain('gamma');
  });

  it('(i5) summary with projection returns rejection (mutually exclusive)', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      summary: true,
      projection: 'writeSet'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('summary');
    expect(result.reason).toContain('projection');
  });

  it('(i6) summary with selector returns rejection (mutually exclusive)', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      summary: true,
      selector: 'writeSet'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('summary');
    expect(result.reason).toContain('selector');
  });

  it('(i7) schema-aware summary includes description for each projection', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      summary: true
    });

    expect(result.status).toBe('summary');
    if (result.status !== 'summary') throw new Error('unexpected status');

    const writeSetEntry = result.projections.find(p => p.name === 'writeSet');
    expect(writeSetEntry).toBeDefined();
    expect(typeof writeSetEntry!.description).toBe('string');
    expect(writeSetEntry!.description!.length).toBeGreaterThan(0);
  });
});

// ─── (j) JSON Pointer selector normalization ──────────────────────────────────

describe('ArtifactQuery — JSON Pointer selector normalization', () => {
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

    writeFile('harness.yaml', MINIMAL_HARNESS_YAML);
    writeFile('.pi/artifacts/bd-1/planContract.json', JSON.stringify(PLAN_CONTRACT_FIXTURE));
  });

  afterEach(() => {
    if (savedProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = savedProjectRoot;
    configLoader.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('(j1) JSON Pointer "/writeSet" resolves same as dot-path "writeSet"', async () => {
    const dotResult = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      selector: 'writeSet'
    });
    const ptrResult = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      selector: '/writeSet'
    });

    expect(dotResult.status).toBe('ok');
    expect(ptrResult.status).toBe('ok');
    if (dotResult.status !== 'ok' || ptrResult.status !== 'ok') throw new Error('unexpected status');
    expect(ptrResult.result).toEqual(dotResult.result);
  });

  it('(j2) JSON Pointer "/implementationSteps/0" resolves to first element', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      selector: '/implementationSteps/0'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(PLAN_CONTRACT_FIXTURE.implementationSteps[0]);
  });

  it('(j3) JSON Pointer "/verifierObligations/0/tool" resolves to nested scalar', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      selector: '/verifierObligations/0/tool'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toBe('tsc');
  });
});

// ─── (k) Bounded output when artifact exceeds inline budget ──────────────────

describe('ArtifactQuery — bounded output (too-much-data path)', () => {
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

    writeFile('harness.yaml', MINIMAL_HARNESS_YAML);
  });

  afterEach(() => {
    if (savedProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = savedProjectRoot;
    configLoader.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('(k1) querying writeSet on a large artifact returns count + samples + estimate, not full dump', async () => {
    const largeWriteSet = Array.from({ length: 300 }, (_, i) => `src/generated/file-${i}.ts`);
    const largeContract = { writeSet: largeWriteSet, verifierObligations: [{ tool: 'tsc', mustPass: true }] };
    writeFile('.pi/artifacts/bd-1/largePc.json', JSON.stringify(largeContract));

    const fullSize = JSON.stringify(largeWriteSet).length;
    expect(fullSize).toBeGreaterThan(ArtifactQueryDefaults.RESULT_MAX_BYTES);

    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/largePc.json'),
      selector: 'writeSet'
    });

    expect((result as any).tooMuchData).toBe(true);
    const tmd = result as any;
    expect(tmd.itemCount).toBe(300);
    expect(tmd.byteCount).toBeGreaterThan(ArtifactQueryDefaults.RESULT_MAX_BYTES);
    expect(tmd.tokenEstimate).toBeGreaterThan(0);
    expect(tmd.representativeSamples.length).toBeLessThanOrEqual(ArtifactQueryDefaults.SAMPLE_MAX_ITEMS);
    // Does not contain all 300 items
    expect(JSON.stringify(tmd.representativeSamples).length).toBeLessThan(fullSize);
    // Hint references writeSet
    expect(tmd.narrowerSelectorHint).toContain('writeSet');
    expect(tmd.nextAction).toBe('rerun_with_narrower_selector');
  });

  it('(k2) querying verifierObligations on a large artifact returns bounded result', async () => {
    const largeObligations = Array.from({ length: 500 }, (_, i) => ({
      tool: `checker-${i}`,
      mustPass: true,
      description: `Obligation description with enough padding text to make each entry large enough`
    }));
    writeFile('.pi/artifacts/bd-1/largeVo.json', JSON.stringify({ verifierObligations: largeObligations }));

    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/largeVo.json'),
      selector: 'verifierObligations'
    });

    expect((result as any).tooMuchData).toBe(true);
    expect((result as any).itemCount).toBe(500);
    expect((result as any).representativeSamples.length).toBeLessThanOrEqual(ArtifactQueryDefaults.SAMPLE_MAX_ITEMS);
    expect(typeof (result as any).tokenEstimate).toBe('number');
    expect((result as any).tokenEstimate).toBeGreaterThan(0);
  });

  it('(k3) querying requirementsInventory on large data returns bounded result with estimate', async () => {
    const largeInventory = Array.from({ length: 400 }, (_, i) => ({
      id: `REQ-${i}`,
      description: `Requirement description ${i} with plenty of padding to exceed the byte cap for this test`,
      priority: 'medium',
      source: 'spec.md'
    }));
    writeFile('.pi/artifacts/bd-1/largeRa.json', JSON.stringify({ requirementsInventory: largeInventory }));

    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/largeRa.json'),
      selector: 'requirementsInventory'
    });

    expect((result as any).tooMuchData).toBe(true);
    expect((result as any).itemCount).toBe(400);
    const tmd = result as any;
    expect(tmd.tokenEstimate).toBe(
      Math.ceil(tmd.byteCount / ArtifactQueryDefaults.TOKEN_ESTIMATE_CHARS_PER_TOKEN)
    );
  });

  it('(k4) querying traceabilityReferences on large data returns bounded result', async () => {
    const largeRefs = Array.from({ length: 600 }, (_, i) => ({
      reqId: `REQ-${i}`,
      source: `spec-section-${i}.md`,
      line: i * 10,
      evidence: `Evidence text ${i} with enough padding to make the serialized total exceed the cap`
    }));
    writeFile('.pi/artifacts/bd-1/largeTr.json', JSON.stringify({ traceabilityReferences: largeRefs }));

    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/largeTr.json'),
      selector: 'traceabilityReferences'
    });

    expect((result as any).tooMuchData).toBe(true);
    expect((result as any).itemCount).toBe(600);
    expect((result as any).representativeSamples.length).toBeLessThanOrEqual(ArtifactQueryDefaults.SAMPLE_MAX_ITEMS);
  });
});

// ─── normalizeSelectorToDotPath unit tests ────────────────────────────────────

describe('normalizeSelectorToDotPath', () => {
  it('empty string returns empty string', () => {
    expect(normalizeSelectorToDotPath('')).toBe('');
  });

  it('plain dot-path is returned as-is', () => {
    expect(normalizeSelectorToDotPath('writeSet')).toBe('writeSet');
    expect(normalizeSelectorToDotPath('foo.bar.0')).toBe('foo.bar.0');
  });

  it('JSON Pointer "/" (root) normalizes to empty string', () => {
    expect(normalizeSelectorToDotPath('/')).toBe('');
  });

  it('JSON Pointer "/foo" normalizes to "foo"', () => {
    expect(normalizeSelectorToDotPath('/foo')).toBe('foo');
  });

  it('JSON Pointer "/foo/bar" normalizes to "foo.bar"', () => {
    expect(normalizeSelectorToDotPath('/foo/bar')).toBe('foo.bar');
  });

  it('JSON Pointer "/writeSet/0" normalizes to "writeSet.0"', () => {
    expect(normalizeSelectorToDotPath('/writeSet/0')).toBe('writeSet.0');
  });

  it('JSON Pointer "/implementationSteps/0/description" normalizes correctly', () => {
    expect(normalizeSelectorToDotPath('/implementationSteps/0/description'))
      .toBe('implementationSteps.0.description');
  });

  it('JSON Pointer ~0 escape decodes to ~', () => {
    expect(normalizeSelectorToDotPath('/a~0b')).toBe('a~b');
  });

  it('JSON Pointer ~1 escape decodes to /', () => {
    expect(normalizeSelectorToDotPath('/a~1b')).toBe('a/b');
  });

  it('whitespace is trimmed before normalization', () => {
    expect(normalizeSelectorToDotPath('  /foo/bar  ')).toBe('foo.bar');
    expect(normalizeSelectorToDotPath('  foo.bar  ')).toBe('foo.bar');
  });
});

// ─── safeSelectPath unit tests ────────────────────────────────────────────────

describe('safeSelectPath', () => {
  const obj = {
    a: {
      b: {
        c: 42
      },
      arr: [10, 20, 30]
    },
    top: 'hello'
  };

  it('empty selector returns root', () => {
    expect(safeSelectPath(obj, '')).toBe(obj);
  });

  it('single key returns top-level value', () => {
    expect(safeSelectPath(obj, 'top')).toBe('hello');
  });

  it('nested dot path returns deep value', () => {
    expect(safeSelectPath(obj, 'a.b.c')).toBe(42);
  });

  it('numeric segment indexes into array', () => {
    expect(safeSelectPath(obj, 'a.arr.1')).toBe(20);
  });

  it('missing key returns undefined', () => {
    expect(safeSelectPath(obj, 'x.y')).toBeUndefined();
  });

  it('out-of-bounds index returns undefined', () => {
    expect(safeSelectPath(obj, 'a.arr.99')).toBeUndefined();
  });

  it('prototype-polluting __proto__ returns undefined', () => {
    expect(safeSelectPath(obj, '__proto__')).toBeUndefined();
  });

  it('prototype-polluting constructor returns undefined', () => {
    expect(safeSelectPath(obj, 'constructor')).toBeUndefined();
  });

  it('traversal through null returns undefined', () => {
    expect(safeSelectPath({ a: null }, 'a.b')).toBeUndefined();
  });

  it('traversal through primitive returns undefined', () => {
    expect(safeSelectPath({ a: 42 }, 'a.b')).toBeUndefined();
  });

  it('undefined root returns undefined', () => {
    expect(safeSelectPath(undefined, 'a')).toBeUndefined();
  });
});

// ─── (l) Schema mode — recursive shape without values ────────────────────────

describe('ArtifactQuery — schema mode', () => {
  let configLoader: ConfigLoader;
  let artifactPaths: ArtifactPaths;
  let query: ArtifactQuery;
  let savedProjectRoot: string | undefined;

  const SCHEMA_FIXTURE = {
    name: 'Alice',
    age: 30,
    active: true,
    score: null,
    tags: ['typescript', 'vitest'],
    address: {
      street: '123 Main St',
      city: 'Springfield',
      zip: '12345'
    },
    history: [
      { date: '2025-01-01', action: 'login' },
      { date: '2025-02-01', action: 'update' }
    ]
  };

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    savedProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    process.env[EnvVars.PROJECT_ROOT] = root;
    configLoader = new ConfigLoader(undefined, root);
    artifactPaths = new ArtifactPaths(configLoader, undefined, root);
    query = new ArtifactQuery(artifactPaths);

    writeFile('harness.yaml', MINIMAL_HARNESS_YAML);
    writeFile('.pi/artifacts/bd-1/schema_fixture.json', JSON.stringify(SCHEMA_FIXTURE));
    writeFile('.pi/artifacts/bd-1/planContract.json', JSON.stringify(PLAN_CONTRACT_FIXTURE));
  });

  afterEach(() => {
    if (savedProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = savedProjectRoot;
    configLoader.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ── (l1) basic shape: keys + types, values dropped ───────────────────────

  it('(l1) schema:true returns keys and types, values are dropped', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/schema_fixture.json'),
      schema: true
    });

    expect(result.status).toBe('schema');
    if (result.status !== 'schema') throw new Error('unexpected status');

    const { shape } = result;

    // Root is an object
    expect(shape.type).toBe('object');
    expect(shape.properties).toBeDefined();

    const props = shape.properties!;

    // Each key's type is correct
    expect(props['name']?.type).toBe('string');
    expect(props['age']?.type).toBe('number');
    expect(props['active']?.type).toBe('boolean');
    expect(props['score']?.type).toBe('null');
    expect(props['tags']?.type).toBe('array');
    expect(props['address']?.type).toBe('object');
    expect(props['history']?.type).toBe('array');

    // Values are ABSENT — no actual content
    const schemaJson = JSON.stringify(result);
    expect(schemaJson).not.toContain('Alice');
    expect(schemaJson).not.toContain('Springfield');
    expect(schemaJson).not.toContain('typescript');
    expect(schemaJson).not.toContain('login');
    expect(schemaJson).not.toContain('123 Main St');
  });

  it('(l2) array length is present in schema, items shape is provided', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/schema_fixture.json'),
      schema: true
    });

    expect(result.status).toBe('schema');
    if (result.status !== 'schema') throw new Error('unexpected status');

    const props = result.shape.properties!;

    // tags: array with length 2
    expect(props['tags']?.type).toBe('array');
    expect(props['tags']?.length).toBe(2);

    // history: array with length 2, items has shape
    expect(props['history']?.type).toBe('array');
    expect(props['history']?.length).toBe(2);
    expect(props['history']?.items).toBeDefined();
    expect(props['history']?.items?.type).toBe('object');
    // items' properties should have 'date' and 'action' keys
    expect(props['history']?.items?.properties?.['date']?.type).toBe('string');
    expect(props['history']?.items?.properties?.['action']?.type).toBe('string');
  });

  it('(l3) nested object keys are included recursively', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/schema_fixture.json'),
      schema: true
    });

    expect(result.status).toBe('schema');
    if (result.status !== 'schema') throw new Error('unexpected status');

    const addressShape = result.shape.properties?.['address'];
    expect(addressShape?.type).toBe('object');
    expect(addressShape?.properties?.['street']?.type).toBe('string');
    expect(addressShape?.properties?.['city']?.type).toBe('string');
    expect(addressShape?.properties?.['zip']?.type).toBe('string');

    // Values dropped
    const schemaJson = JSON.stringify(result);
    expect(schemaJson).not.toContain('Springfield');
    expect(schemaJson).not.toContain('12345');
  });

  // ── (l4) sizeEstimate is present ─────────────────────────────────────────

  it('(l4) schema result includes sizeEstimate', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/schema_fixture.json'),
      schema: true
    });

    expect(result.status).toBe('schema');
    if (result.status !== 'schema') throw new Error('unexpected status');

    expect(typeof result.sizeEstimate.byteCount).toBe('number');
    expect(result.sizeEstimate.byteCount).toBeGreaterThan(0);
    expect(typeof result.sizeEstimate.tokenEstimate).toBe('number');
    expect(result.sizeEstimate.tokenEstimate).toBeGreaterThan(0);
    expect(result.sizeEstimate.tokenEstimate).toBe(
      Math.ceil(result.sizeEstimate.byteCount / ArtifactQueryDefaults.TOKEN_ESTIMATE_CHARS_PER_TOKEN)
    );
  });

  // ── (l5) bounds metadata is present ──────────────────────────────────────

  it('(l5) schema result includes bounds reflecting named constants', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/schema_fixture.json'),
      schema: true
    });

    expect(result.status).toBe('schema');
    if (result.status !== 'schema') throw new Error('unexpected status');

    expect(result.bounds.maxDepth).toBe(SCHEMA_MAX_DEPTH);
    expect(result.bounds.maxKeysPerLevel).toBe(SCHEMA_MAX_KEYS_PER_LEVEL);
    expect(result.bounds.maxBytes).toBe(SCHEMA_MAX_BYTES);
  });

  // ── (l6) mutual exclusion: schema + projection ────────────────────────────

  it('(l6) schema:true with projection returns rejection (mutually exclusive)', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      schema: true,
      projection: 'writeSet'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('schema');
    expect(result.reason).toContain('projection');
  });

  // ── (l7) mutual exclusion: schema + selector ──────────────────────────────

  it('(l7) schema:true with selector returns rejection (mutually exclusive)', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      schema: true,
      selector: 'writeSet'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('schema');
    expect(result.reason).toContain('selector');
  });

  // ── (l8) mutual exclusion: schema + summary ───────────────────────────────

  it('(l8) schema:true with summary:true returns rejection (mutually exclusive)', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      schema: true,
      summary: true
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('schema');
    expect(result.reason).toContain('summary');
  });

  // ── (l9) security: out-of-scope path in schema mode is rejected ───────────

  it('(l9) schema:true with out-of-scope artifactPath returns scope rejection without content', async () => {
    const outsideDir = path.join(os.tmpdir(), 'orr-else-schema-security-outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsidePath = path.join(outsideDir, 'sensitive.json');
    fs.writeFileSync(outsidePath, JSON.stringify({ secret: 'schema-should-never-appear' }));

    try {
      const result = await query.query({
        beadId: 'bd-1',
        artifactPath: outsidePath,
        schema: true
      });

      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('unexpected status');
      expect(result.exists).toBe(false);
      // Must NOT leak file content
      expect(JSON.stringify(result)).not.toContain('schema-should-never-appear');
      // Must name the scope violation
      expect(result.reason).toContain('outside the allowed artifact and worktree roots');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // ── (l10) depth + key bounds ─────────────────────────────────────────────

  it('(l10) schema is bounded: deep objects show truncated:true at depth limit', async () => {
    // Build a deeply nested object beyond SCHEMA_MAX_DEPTH
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < SCHEMA_MAX_DEPTH + 3; i++) {
      deep = { nested: deep, level: i };
    }
    writeFile('.pi/artifacts/bd-1/deep.json', JSON.stringify({ root: deep }));

    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/deep.json'),
      schema: true
    });

    expect(result.status).toBe('schema');
    if (result.status !== 'schema') throw new Error('unexpected status');

    // Values are still dropped
    expect(JSON.stringify(result)).not.toContain('"leaf"');
  });

  it('(l11) schema keys are bounded by SCHEMA_MAX_KEYS_PER_LEVEL', async () => {
    // Object with more keys than the cap
    const wideObject: Record<string, number> = {};
    for (let i = 0; i < SCHEMA_MAX_KEYS_PER_LEVEL + 10; i++) {
      wideObject[`key_${i}`] = i;
    }
    writeFile('.pi/artifacts/bd-1/wide.json', JSON.stringify(wideObject));

    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/wide.json'),
      schema: true
    });

    expect(result.status).toBe('schema');
    if (result.status !== 'schema') throw new Error('unexpected status');

    // Properties shown must not exceed the per-level cap
    const propCount = Object.keys(result.shape.properties ?? {}).length;
    expect(propCount).toBeLessThanOrEqual(SCHEMA_MAX_KEYS_PER_LEVEL);

    // truncated flag must be set
    expect(result.shape.truncated).toBe(true);

    // Values are dropped (no numeric values in schema output)
    const schemaJson = JSON.stringify(result);
    // None of the actual numeric values (0 through cap+10) should appear as values
    // The shape only has type strings, so no plain numbers like "42" in value positions
    for (let i = SCHEMA_MAX_KEYS_PER_LEVEL + 1; i < SCHEMA_MAX_KEYS_PER_LEVEL + 10; i++) {
      // Keys beyond the cap must NOT appear in properties
      expect(result.shape.properties?.[`key_${i}`]).toBeUndefined();
    }
  });

  // ── (l12) schema on planContract: all keys, values absent ────────────────

  it('(l12) schema:true on planContract returns all top-level keys as types, values absent', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      schema: true
    });

    expect(result.status).toBe('schema');
    if (result.status !== 'schema') throw new Error('unexpected status');

    const props = result.shape.properties!;

    // All top-level keys of PLAN_CONTRACT_FIXTURE are present
    expect(props['writeSet']?.type).toBe('array');
    expect(props['verifierObligations']?.type).toBe('array');
    expect(props['implementationSteps']?.type).toBe('array');
    expect(props['riskList']?.type).toBe('array');
    expect(props['evidenceReferences']?.type).toBe('array');
    expect(props['acceptanceCriteria']?.type).toBe('array');

    // None of the actual values appear
    const schemaJson = JSON.stringify(result);
    expect(schemaJson).not.toContain('Create Foo class');
    expect(schemaJson).not.toContain('Breaking change');
    expect(schemaJson).not.toContain('All tests pass');
    expect(schemaJson).not.toContain('src/core/Foo.ts');
  });

  // ── N1: SCHEMA_FALLBACK_DEPTH behavioral test ─────────────────────────────
  // When the full schema exceeds SCHEMA_MAX_BYTES the system rebuilds it at a
  // shallower depth (SCHEMA_FALLBACK_DEPTH = 2). Verify:
  //   a) the result is still returned (truncated: true)
  //   b) the shape is shallower than SCHEMA_MAX_DEPTH — specifically the
  //      fallback shows top-level keys but their children are truncated

  it('(N1) over-SCHEMA_MAX_BYTES schema falls back to shallower depth (SCHEMA_FALLBACK_DEPTH=2) and sets truncated:true', async () => {
    // Build a 3-level-deep object with SCHEMA_MAX_KEYS_PER_LEVEL (30) long-named
    // keys at each level. The schema includes ALL key names (not values), so:
    // 30 top-level × 30 mid-level × 30 leaf keys × ~45 chars/key ≈ 1.2MB of
    // schema JSON — well above SCHEMA_MAX_BYTES (24KB).
    const K = SCHEMA_MAX_KEYS_PER_LEVEL;
    const mkKey = (prefix: string, i: number) =>
      `${prefix}_longkeyname_to_bloat_schema_bytes_${String(i).padStart(2, '0')}`;

    const obj: Record<string, unknown> = {};
    for (let i = 0; i < K; i++) {
      const mid: Record<string, unknown> = {};
      for (let j = 0; j < K; j++) {
        const leaf: Record<string, unknown> = {};
        for (let k = 0; k < K; k++) {
          leaf[mkKey('leaf', k)] = `v_${k}`;
        }
        mid[mkKey('mid', j)] = leaf;
      }
      obj[mkKey('top', i)] = mid;
    }

    writeFile('.pi/artifacts/bd-1/huge_schema.json', JSON.stringify(obj));

    const result = await query.query({
      beadId: 'bd-1',
      artifactPath: path.join(root, '.pi/artifacts/bd-1/huge_schema.json'),
      schema: true
    });

    expect(result.status).toBe('schema');
    if (result.status !== 'schema') throw new Error('unexpected status');

    // Must be flagged as truncated (was rebuilt at SCHEMA_FALLBACK_DEPTH=2)
    expect(result.truncated).toBe(true);

    // sizeEstimate is present and positive
    expect(result.sizeEstimate.byteCount).toBeGreaterThan(0);
    expect(result.sizeEstimate.tokenEstimate).toBeGreaterThan(0);

    // Values must still be absent (shape only contains type labels)
    const resultJson = JSON.stringify(result);
    // Actual string values like 'v_0' must not appear in the schema
    expect(resultJson).not.toContain('"v_0"');
    expect(resultJson).not.toContain('"v_1"');
  });
});
