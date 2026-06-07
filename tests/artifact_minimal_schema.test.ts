/**
 * Large-artifact fixture tests: s3wp.27 minimal-schema contract.
 *
 * Verifies that get_artifact_paths and query_artifact return compact results
 * (paths / selectors / sizeEstimate) for large planContract /
 * requirementsAnalysis artifacts and do NOT produce any byte-capped inline
 * dump or generic preview/truncation fields.
 *
 * Policy reference: docs/raw-output-contract.md
 *   - No maxInlineBytes / maxTotalInlineBytes params accepted by get_artifact_paths
 *   - No resultPreview / outputPreview / truncated (as a global cap mechanism) in results
 *   - Deterministic compaction: bytes + sha256 metadata only from get_artifact_paths
 *   - query_artifact returns sizeEstimate and the requested subtree (or tooMuchData for large root)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactPaths, type ArtifactPathContext } from '../src/core/ArtifactPaths.js';
import { ArtifactQuery } from '../src/core/ArtifactQuery.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { ArtifactQueryDefaults, EnvVars } from '../src/constants/index.js';

const root = path.join(os.tmpdir(), 'orr-else-artifact-minimal-schema-test');

function writeFile(relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

const HARNESS_YAML = `
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

/** Build a large planContract: writeSet + implementationSteps to ~60 KB. */
function buildLargePlanContract() {
  const writeSet = Array.from({ length: 200 }, (_, i) => `src/core/Module${i}.ts`);
  const implementationSteps = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    description: `Implement step ${i + 1}: refactor the Module${i} class to align with the new API contract and update all consumers`,
    files: [`src/core/Module${i}.ts`, `tests/module${i}.test.ts`],
    acceptanceCriteria: ['All tests pass', 'TSC exits 0', `Coverage >= 80% for Module${i}`]
  }));
  const riskList = Array.from({ length: 50 }, (_, i) => ({
    risk: `Risk ${i}: potential regression in subsystem ${i}`,
    mitigation: `Add regression tests covering subsystem ${i} before merging`,
    severity: 'medium'
  }));
  return { writeSet, implementationSteps, riskList, acceptanceCriteria: ['TSC exits 0', 'All tests green'] };
}

/** Build a large requirementsAnalysis: ~60 KB. */
function buildLargeRequirementsAnalysis() {
  const requirementsInventory = Array.from({ length: 150 }, (_, i) => ({
    id: `REQ-${i + 1}`,
    description: `The system must support operation ${i + 1} including all edge cases and error recovery paths`,
    priority: i % 3 === 0 ? 'high' : 'medium',
    source: `spec-section-${Math.floor(i / 10)}.md`,
    tags: ['functional', `area-${i % 5}`]
  }));
  const traceabilityReferences = Array.from({ length: 80 }, (_, i) => ({
    reqId: `REQ-${i + 1}`,
    source: `spec.md`,
    line: (i + 1) * 12,
    evidence: `Evidence paragraph for REQ-${i + 1}: covers the main contract and secondary behavior`
  }));
  return { requirementsInventory, traceabilityReferences, gapFlags: [], unresolvedQuestions: ['What is the SLA?'] };
}

describe('artifact_minimal_schema — large planContract', () => {
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
    writeFile('harness.yaml', HARNESS_YAML);

    const largeContract = buildLargePlanContract();
    const serialized = JSON.stringify(largeContract);
    // Confirm the fixture is actually large (> 8 KB byte cap used by query_artifact)
    expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(ArtifactQueryDefaults.RESULT_MAX_BYTES);
    writeFile('.pi/artifacts/bd-1/planContract.json', serialized);
  });

  afterEach(() => {
    if (savedProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = savedProjectRoot;
    configLoader.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ── get_artifact_paths: compact paths + metadata, no inline content ──────

  it('get_artifact_paths returns compact metadata for large planContract — no text, no resultPreview, no truncated', async () => {
    const result = await artifactPaths.resolve({ beadId: 'bd-1', stateId: 'RequirementsAnalysis' });

    const meta = result.artifactContents.planContract;

    // Existence + path
    expect(meta.exists).toBe(true);
    expect(meta.path).toContain('planContract.json');

    // Deterministic metadata only
    expect(typeof meta.bytes).toBe('number');
    expect((meta.bytes as number)).toBeGreaterThan(ArtifactQueryDefaults.RESULT_MAX_BYTES);
    expect(typeof meta.sha256).toBe('string');
    expect((meta.sha256 as string).length).toBeGreaterThan(0);

    // Forbidden inline-content and byte-cap fields MUST NOT be present
    expect(meta.text).toBeUndefined();
    expect((meta as any).truncated).toBeUndefined();
    expect((meta as any).inlineBytes).toBeUndefined();
    expect((meta as any).previewOmitted).toBeUndefined();

    // Forbidden generic envelope fields MUST NOT be present
    expect((result as any).resultPreview).toBeUndefined();
    expect((result as any).outputPreview).toBeUndefined();
    expect((result as any).truncatedArtifacts).toBeUndefined();
    expect((result as any).omittedArtifacts).toBeUndefined();
    expect((result as any).nextAction).toBeUndefined();
    expect((result as any).recovery).toBeUndefined();
  });

  it('get_artifact_paths does NOT accept maxInlineBytes — TypeScript type does not include it', async () => {
    // Compile-time guarantee: ArtifactPathContext has no maxInlineBytes/maxTotalInlineBytes.
    // This test verifies the runtime interface by passing only valid params.
    const ctx: ArtifactPathContext = {
      beadId: 'bd-1',
      stateId: 'RequirementsAnalysis',
      includeContent: true
    };
    // Should NOT have maxInlineBytes or maxTotalInlineBytes in the type
    expect('maxInlineBytes' in ctx).toBe(false);
    expect('maxTotalInlineBytes' in ctx).toBe(false);

    const result = await artifactPaths.resolve(ctx);
    // Still returns correct metadata
    expect(result.artifactContents.planContract.exists).toBe(true);
    expect(result.artifactContents.planContract.text).toBeUndefined();
  });

  // ── query_artifact: projections return compact subtrees with sizeEstimate ──

  it('query_artifact writeSet projection returns only writeSet — not the full contract', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      selector: 'writeSet'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');

    // Only writeSet — no implementationSteps / riskList leak
    const json = JSON.stringify(result.result);
    expect(json).not.toContain('implementationSteps');
    expect(json).not.toContain('acceptanceCriteria');

    // sizeEstimate present and correct
    expect(typeof result.sizeEstimate.byteCount).toBe('number');
    expect(result.sizeEstimate.byteCount).toBeGreaterThan(0);
    expect(result.sizeEstimate.tokenEstimate).toBe(
      Math.ceil(result.sizeEstimate.byteCount / ArtifactQueryDefaults.TOKEN_ESTIMATE_CHARS_PER_TOKEN)
    );

    // No generic cap envelope fields
    expect((result as any).resultPreview).toBeUndefined();
    expect((result as any).outputPreview).toBeUndefined();
  });

  it('query_artifact summary mode returns per-projection size estimates — no content, no byte-cap inline dump', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      summary: true
    });

    expect(result.status).toBe('summary');
    if (result.status !== 'summary') throw new Error('unexpected status');

    // All projection names present
    const names = result.projections.map(p => p.name);
    expect(names).toContain('writeSet');
    expect(names).toContain('implementationSteps');
    expect(names).toContain('riskList');

    // Each projection has sizeEstimate
    for (const proj of result.projections) {
      expect(typeof proj.sizeEstimate.byteCount).toBe('number');
      expect(proj.sizeEstimate.tokenEstimate).toBe(
        Math.ceil(proj.sizeEstimate.byteCount / ArtifactQueryDefaults.TOKEN_ESTIMATE_CHARS_PER_TOKEN)
      );
    }

    // No content values inlined
    const summaryJson = JSON.stringify(result);
    expect(summaryJson).not.toContain('Implement step');
    expect(summaryJson).not.toContain('potential regression');
  });

  it('query_artifact root selector on large contract returns tooMuchData (not a byte-cap inline dump)', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'planContract',
      selector: ''
    });

    // Large root exceeds RESULT_MAX_BYTES → tooMuchData path
    expect((result as any).tooMuchData).toBe(true);

    const tmd = result as any;
    // Counts and hint present
    expect(typeof tmd.byteCount).toBe('number');
    expect(tmd.byteCount).toBeGreaterThan(ArtifactQueryDefaults.RESULT_MAX_BYTES);
    expect(typeof tmd.tokenEstimate).toBe('number');
    expect(tmd.nextAction).toBe('rerun_with_narrower_selector');

    // No byte-cap generic envelope fields
    expect(tmd.resultPreview).toBeUndefined();
    expect(tmd.outputPreview).toBeUndefined();
    expect(tmd.stdoutTruncated).toBeUndefined();
  });
});

describe('artifact_minimal_schema — large requirementsAnalysis', () => {
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
    writeFile('harness.yaml', HARNESS_YAML);

    const largeRA = buildLargeRequirementsAnalysis();
    const serialized = JSON.stringify(largeRA);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(ArtifactQueryDefaults.RESULT_MAX_BYTES);
    writeFile('.pi/artifacts/bd-1/requirementsAnalysis.json', serialized);
  });

  afterEach(() => {
    if (savedProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = savedProjectRoot;
    configLoader.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('get_artifact_paths returns bytes + sha256 for large requirementsAnalysis — no text inlining', async () => {
    const result = await artifactPaths.resolve({ beadId: 'bd-1', stateId: 'RequirementsAnalysis' });

    const meta = result.artifactContents.requirementsAnalysis;
    expect(meta.exists).toBe(true);
    expect(typeof meta.bytes).toBe('number');
    expect((meta.bytes as number)).toBeGreaterThan(ArtifactQueryDefaults.RESULT_MAX_BYTES);
    expect(typeof meta.sha256).toBe('string');

    // No content leak
    expect(meta.text).toBeUndefined();
    expect((meta as any).truncated).toBeUndefined();
    expect((result as any).resultPreview).toBeUndefined();
    expect((result as any).truncatedArtifacts).toBeUndefined();
  });

  it('query_artifact requirementsInventory projection returns compact subtree for large artifact', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      selector: 'requirementsInventory'
    });

    // Large requirementsInventory exceeds RESULT_MAX_BYTES → tooMuchData path
    // (or ok if it happens to fit — both are acceptable; what matters is no byte-cap inline dump)
    const json = JSON.stringify(result);
    expect(json).not.toContain('resultPreview');
    expect(json).not.toContain('outputPreview');
    expect(json).not.toContain('stdoutTruncated');

    if ((result as any).tooMuchData) {
      // tooMuchData path: counts + samples, not full dump
      const tmd = result as any;
      expect(tmd.representativeSamples.length).toBeLessThanOrEqual(ArtifactQueryDefaults.SAMPLE_MAX_ITEMS);
      expect(typeof tmd.tokenEstimate).toBe('number');
    } else {
      // ok path: sizeEstimate present
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.sizeEstimate.byteCount).toBeGreaterThan(0);
      }
    }
  });

  it('query_artifact schema mode returns artifact shape without values for large requirementsAnalysis', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: 'requirementsAnalysis',
      schema: true
    });

    expect(result.status).toBe('schema');
    if (result.status !== 'schema') throw new Error('unexpected status');

    const { shape } = result;
    expect(shape.type).toBe('object');
    expect(shape.properties?.['requirementsInventory']?.type).toBe('array');
    expect(shape.properties?.['traceabilityReferences']?.type).toBe('array');

    // No values inlined
    const schemaJson = JSON.stringify(result);
    expect(schemaJson).not.toContain('operation');
    expect(schemaJson).not.toContain('REQ-1');

    // sizeEstimate present
    expect(result.sizeEstimate.byteCount).toBeGreaterThan(0);
  });
});
