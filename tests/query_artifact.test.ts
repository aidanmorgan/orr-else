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
import { ArtifactQuery, safeSelectPath } from '../src/core/ArtifactQuery.js';
import { ArtifactPaths } from '../src/core/ArtifactPaths.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { ArtifactQueryDefaults } from '../src/constants/index.js';
import { setProjectRoot } from '../src/core/Paths.js';

const root = path.join(os.tmpdir(), 'orr-else-query-artifact-test');

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
scheduler:
  weights:
    waitTime: 1
    executionTime: 1
    progress: 1
    penalty: 1
states:
  RequirementsAnalysis:
    identity:
      role: Requirements
      expertise: Analysis
      constraints: []
    baseInstructions: Analyze.
    actions: []
    transitions:
      SUCCESS: Planning
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

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    setProjectRoot(root);
    configLoader = new ConfigLoader();
    artifactPaths = new ArtifactPaths(configLoader);
    query = new ArtifactQuery(artifactPaths);

    writeFile('harness.yaml', MINIMAL_HARNESS_YAML);
    writeFile('.pi/artifacts/bd-1/planContract.json', JSON.stringify(PLAN_CONTRACT_FIXTURE));
    writeFile('.pi/artifacts/bd-1/requirementsAnalysis.json', JSON.stringify(REQUIREMENTS_ANALYSIS_FIXTURE));
  });

  afterEach(() => {
    configLoader.reset();
    setProjectRoot(process.cwd());
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

  it('(g) ArtifactPaths.resolve content preview still works correctly', async () => {
    const resolution = await artifactPaths.resolve({
      beadId: 'bd-1',
      stateId: 'RequirementsAnalysis',
      artifactId: 'planContract',
      includeContent: true
    });

    expect(resolution.artifactContents.planContract.exists).toBe(true);
    expect(resolution.artifactContents.planContract.text).toContain('writeSet');
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
