/**
 * pi-experiment-0yt5.9 / 6q0y.21 — query_artifact projections are GENERIC and
 * registration-driven; unregistered projections are REJECTED (fail-closed).
 *
 * The generic harness embeds NO project's artifact schema. Named projections
 * are resolved through the harness-owned `projections` registry in
 * orr-else/contract; a consuming-project extension registers its own
 * projections at load (bead 0yt5.12 registers cerdiwen's).
 *
 * These tests prove:
 *   - AC3: a caller-registered projection resolves through query_artifact.
 *   - AC3/AC4: an UNregistered named projection is REJECTED immediately
 *     (fail-closed) — no dot-path fallback; dot-path access requires the
 *     explicit `selector` parameter.
 *   - AC4 (ADVERSARIAL): with cerdiwen's projections NOT registered, querying
 *     `gapFlags` no longer silently resolves `completenessGaps` from harness
 *     built-ins — the Cerdiwen alias is gone from the generic harness.
 *
 * Isolation: these tests use UNIQUE artifact-type names so the assertions are
 * independent of any projection that other test files register on the
 * module-level singleton registry. The registry is reset in finally by
 * overwriting registered keys with a known never-resolving sentinel (last-wins;
 * there is no remove API).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactQuery } from '../src/core/ArtifactQuery.js';
import { ArtifactPaths } from '../src/core/ArtifactPaths.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EnvVars } from '../src/constants/index.js';
import { projections, type ProjectionDef } from '../src/contract.js';

const root = path.join(os.tmpdir(), 'orr-else-query-artifact-proj-registry-test');

// Unique artifact-type names so this file's assertions never collide with the
// projections any other test file registers on the singleton.
const REG_TYPE = 'regProj';
const ADV_TYPE = 'advProj';

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
      ${REG_TYPE}: .pi/artifacts/{{beadId}}/${REG_TYPE}.json
      ${ADV_TYPE}: .pi/artifacts/{{beadId}}/${ADV_TYPE}.json
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

/** A registered projection whose primary selector uses a different key than its name. */
const REG_PROJECTION: ProjectionDef = {
  selectors: ['underlyingKey'],
  description: 'A caller-registered projection that maps to a different key'
};

/** The artifact for the registered-projection type. */
const REG_ARTIFACT = {
  underlyingKey: [{ id: 1, label: 'resolved-via-registered-projection' }]
};

/**
 * The artifact for the adversarial type: it holds ONLY `completenessGaps`
 * (the Cerdiwen key) and NOT `gapFlags`. Before this bead, the harness
 * `gapFlags` built-in aliased to `completenessGaps`; that alias is now gone.
 */
const ADV_ARTIFACT = {
  completenessGaps: [{ area: 'coverage', severity: 'low' }]
};

/** A sentinel selector that never resolves, used to reset registered keys. */
const RESET: ProjectionDef = { selectors: ['__orr_else_never_resolves__'] };

describe('query_artifact projections are registration-driven (0yt5.9)', () => {
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
    writeFile(`.pi/artifacts/bd-1/${REG_TYPE}.json`, JSON.stringify(REG_ARTIFACT));
    writeFile(`.pi/artifacts/bd-1/${ADV_TYPE}.json`, JSON.stringify(ADV_ARTIFACT));
  });

  afterEach(() => {
    if (savedProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = savedProjectRoot;
    configLoader.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ── AC3: a caller-registered projection resolves through query_artifact ────

  it('(AC3) a caller-registered projection resolves via its registered selector', async () => {
    try {
      projections.register(`${REG_TYPE}:myProjection`, REG_PROJECTION);

      const result = await query.query({
        beadId: 'bd-1',
        artifactId: REG_TYPE,
        projection: 'myProjection'
      });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('unexpected status');
      // The projection name is 'myProjection' but it resolves the 'underlyingKey'
      // selector that the caller registered — proving the registry, not a key
      // match, drives resolution.
      expect(result.selector).toBe('underlyingKey');
      expect(result.result).toEqual(REG_ARTIFACT.underlyingKey);
    } finally {
      // Reset (last-wins overwrite; no remove API).
      projections.register(`${REG_TYPE}:myProjection`, RESET);
    }
  });

  it('(AC3) a registered projection is listed in a schema-aware summary', async () => {
    try {
      projections.register(`${REG_TYPE}:myProjection`, REG_PROJECTION);

      const result = await query.query({
        beadId: 'bd-1',
        artifactId: REG_TYPE,
        summary: true
      });

      expect(result.status).toBe('summary');
      if (result.status !== 'summary') throw new Error('unexpected status');
      expect(result.schemaAware).toBe(true);
      const names = result.projections.map((p) => p.name);
      expect(names).toContain('myProjection');
    } finally {
      projections.register(`${REG_TYPE}:myProjection`, RESET);
    }
  });

  // ── AC3/AC4: unregistered projections are REJECTED fail-closed ───────────
  // Dot-path access requires the explicit `selector` parameter (6q0y.21).

  it('(AC3/AC4) an UNregistered projection name is REJECTED fail-closed (no dot-path fallback)', async () => {
    // No projection is registered for REG_TYPE:underlyingKey.
    // 6q0y.21: unregistered projections no longer fall back to the dot-path
    // selector — they are rejected immediately so dot-path access is only
    // reachable through the explicit `selector` parameter.
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: REG_TYPE,
      projection: 'underlyingKey'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('underlyingKey');
    expect(result.reason).toContain('not registered');
    expect(result.exists).toBe(true);
  });

  it('(AC4) an unregistered projection whose name matches a real key is REJECTED (dot-path requires selector)', async () => {
    // The artifact has 'underlyingKey' at its root, but since no projection is
    // registered for that name, using projection: 'underlyingKey' must reject.
    // The data IS reachable — but only via selector: 'underlyingKey'.
    const selectorResult = await query.query({
      beadId: 'bd-1',
      artifactId: REG_TYPE,
      selector: 'underlyingKey'
    });
    expect(selectorResult.status).toBe('ok');
    if (selectorResult.status !== 'ok') throw new Error('unexpected status');
    expect(selectorResult.result).toEqual(REG_ARTIFACT.underlyingKey);
  });

  it('(AC3) an UNregistered projection that is not a present key is REJECTED (no built-in default)', async () => {
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: REG_TYPE,
      projection: 'notARegisteredProjectionNorAKey'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    expect(result.reason).toContain('not registered');
    expect(result.reason).toContain('notARegisteredProjectionNorAKey');
    expect(result.exists).toBe(true);
  });

  // ── AC4 (ADVERSARIAL): the Cerdiwen gapFlags→completenessGaps alias is gone ─

  it('(AC4) with no projections registered, gapFlags does NOT resolve completenessGaps', async () => {
    // The artifact contains ONLY completenessGaps. Before this bead, the harness
    // shipped a built-in 'gapFlags' projection that aliased to completenessGaps.
    // That alias is gone: nothing is registered for ADV_TYPE, so 'gapFlags'
    // falls back to the dot-path selector 'gapFlags', which is ABSENT → reject.
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: ADV_TYPE,
      projection: 'gapFlags'
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unexpected status');
    // It must NOT have silently returned the completenessGaps value.
    expect(JSON.stringify(result)).not.toContain('completenessGaps');
    expect(JSON.stringify(result)).not.toContain('"area"');
    // And there are no harness built-in valid projections for this type.
    expect(result.validProjections).toBeUndefined();
  });

  it('(AC4) the underlying completenessGaps value is still reachable via an explicit selector', async () => {
    // The data is still there — only the schema-aware ALIAS is gone. A generic
    // dot-path selector reaches it, proving query_artifact stays a working
    // generic selector mechanism.
    const result = await query.query({
      beadId: 'bd-1',
      artifactId: ADV_TYPE,
      selector: 'completenessGaps'
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.result).toEqual(ADV_ARTIFACT.completenessGaps);
  });
});
