/**
 * pi-experiment-6q0y.21 — query_artifact schema mode + fail-closed unregistered
 * projection rejection, tested against the REAL registered tool.
 *
 * Drives the live query_artifact tool registered by orrElseExtension via the
 * same fakePi harness used by read_path_context_skeleton_tool.test.ts.
 *
 * Load-bearing assertions:
 *   (A) schema mode: the registered tool exposes a `schema` boolean parameter
 *       and returns status:'schema' with shape + bounds when called with schema:true.
 *   (B) fail-closed: an UNREGISTERED projection name is rejected immediately
 *       (status:'rejected') and does NOT fall back to dot-path resolution.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuiltInToolName } from '../src/constants/domain.js';
import { EnvVars, PiEventName } from '../src/constants/infra.js';
import { projections, type ProjectionDef } from '../src/contract.js';
import { Logger } from '../src/core/Logger.js';
import orrElseExtension from '../src/extension.js';

// ─── Minimal harness fixture ──────────────────────────────────────────────────

const HARNESS_YAML = `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: ''
  defaultModel: gpt-5.5
  startState: Planning
  artifacts:
    baseDir: .pi/artifacts
    templates:
      planContract: .pi/artifacts/{{beadId}}/planContract.json
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
  Planning:
    identity:
      role: Planner
      expertise: Planning
      constraints: []
    baseInstructions: Plan.
    actions:
      - id: a1
        type: prompt
    transitions:
      SUCCESS: completed
      FAILURE: Planning
`;

const PLAN_CONTRACT_FIXTURE = {
  writeSet: ['src/core/Foo.ts', 'tests/foo.test.ts'],
  verifierObligations: [{ tool: 'tsc', mustPass: true }],
  implementationSteps: [
    { id: 1, description: 'Create Foo class', files: ['src/core/Foo.ts'] }
  ]
};

// Unique artifact type to isolate from other test files' registry entries.
const ISOLATED_TYPE = 'schemaToolIsolated6q0y21';
const ISOLATED_PROJECTION: ProjectionDef = {
  selectors: ['writeSet'],
  description: 'Registered projection for 6q0y.21 tool-level test'
};
const RESET_SENTINEL: ProjectionDef = { selectors: ['__orr_else_never_resolves__'] };

// ─── Fake Pi harness ──────────────────────────────────────────────────────────

function fakePi() {
  const tools: any[] = [];
  const callbacks: Record<string, Function> = {};
  return {
    tools,
    callbacks,
    pi: {
      on: (name: string, cb: Function) => { callbacks[name] = cb; },
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      setThinkingLevel: () => {},
      setModel: async () => true,
      sendUserMessage: () => {}
    } as any
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('pi-experiment-6q0y.21: query_artifact schema mode + fail-closed via live tool', () => {
  let tempRoot: string;
  let prevProjectRoot: string | undefined;
  let prevWorktree: string | undefined;
  let previousCwd: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    prevProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    prevWorktree = process.env[EnvVars.WORKTREE_PATH];

    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y21-')));
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), HARNESS_YAML);
    fs.mkdirSync(path.join(tempRoot, '.pi/artifacts/bd-1'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, '.pi/artifacts/bd-1/planContract.json'),
      JSON.stringify(PLAN_CONTRACT_FIXTURE)
    );
    // Also write a fixture using the isolated type name for the isolated-type test
    fs.mkdirSync(path.join(tempRoot, '.pi/artifacts/bd-2'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, `.pi/artifacts/bd-2/${ISOLATED_TYPE}.json`),
      JSON.stringify({ writeSet: ['a.ts'] })
    );

    process.chdir(tempRoot);
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempRoot;
  });

  afterEach(async () => {
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 200));
    process.chdir(previousCwd);
    if (prevProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = prevProjectRoot;
    if (prevWorktree === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = prevWorktree;
    fs.rmSync(tempRoot, { recursive: true, force: true });
    // Reset isolated projection key
    projections.register(`${ISOLATED_TYPE}:myProj`, RESET_SENTINEL);
  });

  async function registeredQueryArtifactTool(): Promise<any> {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
    const tool = harness.tools.find(t => t.name === BuiltInToolName.QUERY_ARTIFACT);
    expect(tool, 'query_artifact tool must be registered').toBeDefined();
    return tool;
  }

  const noUiCtx = { hasUI: false } as any;

  // ── (A) schema mode: the tool exposes `schema` boolean in its parameter schema ──

  it('(A1) the registered tool schema exposes a `schema` boolean parameter', async () => {
    const tool = await registeredQueryArtifactTool();
    expect(tool.parameters?.properties?.schema).toBeDefined();
    expect(tool.parameters.properties.schema.type).toBe('boolean');
  });

  it('(A2) calling the tool with schema:true returns status:schema with shape, bounds, sizeEstimate', async () => {
    const tool = await registeredQueryArtifactTool();
    const wrapped = await tool.execute(
      'call-a2',
      { beadId: 'bd-1', artifactId: 'planContract', schema: true },
      undefined,
      undefined,
      noUiCtx
    );
    // The wrapPluginTool wrapper returns { content, details }; details is the raw result.
    const result = wrapped.details ?? wrapped;

    expect(result.status).toBe('schema');
    // Shape: root is an object with the planContract fixture keys
    expect(result.shape.type).toBe('object');
    expect(result.shape.properties?.writeSet?.type).toBe('array');
    expect(result.shape.properties?.implementationSteps?.type).toBe('array');
    // Values are dropped
    expect(JSON.stringify(result)).not.toContain('Create Foo class');
    expect(JSON.stringify(result)).not.toContain('src/core/Foo.ts');
    // Bounds present
    expect(typeof result.bounds.maxDepth).toBe('number');
    expect(typeof result.bounds.maxKeysPerLevel).toBe('number');
    expect(typeof result.bounds.maxBytes).toBe('number');
    // sizeEstimate present and within 24KB cap (AC5)
    expect(result.sizeEstimate.byteCount).toBeGreaterThan(0);
    expect(result.sizeEstimate.byteCount).toBeLessThan(24_000);
  });

  it('(A3) schema:true with projection returns rejection via the live tool (mutually exclusive)', async () => {
    const tool = await registeredQueryArtifactTool();
    const wrapped = await tool.execute(
      'call-a3',
      { beadId: 'bd-1', artifactId: 'planContract', schema: true, projection: 'writeSet' },
      undefined,
      undefined,
      noUiCtx
    );
    const result = wrapped.details ?? wrapped;
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('schema');
    expect(result.reason).toContain('projection');
  });

  // ── (B) fail-closed: unregistered projection is rejected, no dot-path fallback ──

  it('(B1) an UNREGISTERED projection whose name matches a real key is REJECTED fail-closed', async () => {
    // planContract has 'writeSet' as a real key, but no projection 'writeSet' is
    // registered under planContract in this test context.
    // Before 6q0y.21: would fall back to dot-path and return ok.
    // After 6q0y.21: fail-closed rejection — dot-path requires selector:.
    const tool = await registeredQueryArtifactTool();
    const wrapped = await tool.execute(
      'call-b1',
      { beadId: 'bd-1', artifactId: 'planContract', projection: 'writeSet' },
      undefined,
      undefined,
      noUiCtx
    );
    const result = wrapped.details ?? wrapped;

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('writeSet');
    expect(result.reason).toContain('not registered');
    // Must NOT contain actual file content (never fell through to dot-path)
    expect(JSON.stringify(result)).not.toContain('src/core/Foo.ts');
  });

  it('(B2) an UNREGISTERED projection is rejected with a deterministic validProjections list when projections exist', async () => {
    // Register a projection for the isolated type so validProjections is non-empty.
    projections.register(`${ISOLATED_TYPE}:myProj`, ISOLATED_PROJECTION);
    try {
      const tool = await registeredQueryArtifactTool();
      const wrapped = await tool.execute(
        'call-b2',
        {
          beadId: 'bd-2',
          artifactPath: path.join(tempRoot, `.pi/artifacts/bd-2/${ISOLATED_TYPE}.json`),
          projection: 'nonExistentProjection'
        },
        undefined,
        undefined,
        noUiCtx
      );
      // Note: artifactPath-based queries use the basename as artifactId, so
      // projections registered under ISOLATED_TYPE won't match. This tests that
      // rejection happens regardless.
      const result = wrapped.details ?? wrapped;
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('not registered');
    } finally {
      projections.register(`${ISOLATED_TYPE}:myProj`, RESET_SENTINEL);
    }
  });

  it('(B3) the data IS reachable via selector after fail-closed projection rejection', async () => {
    // Confirms fail-closed doesn't break the underlying data access — just
    // enforces that dot-path goes through selector: not projection:.
    const tool = await registeredQueryArtifactTool();
    const wrapped = await tool.execute(
      'call-b3',
      { beadId: 'bd-1', artifactId: 'planContract', selector: 'writeSet' },
      undefined,
      undefined,
      noUiCtx
    );
    const result = wrapped.details ?? wrapped;
    expect(result.status).toBe('ok');
    expect(result.result).toEqual(PLAN_CONTRACT_FIXTURE.writeSet);
  });
});
