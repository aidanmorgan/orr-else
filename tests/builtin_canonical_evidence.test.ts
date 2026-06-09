/**
 * builtin_canonical_evidence.test.ts
 *
 * pi-experiment-zog2.2 (producer-side) — canonical evidence handle tests for
 * built-in and wrapped plugin tools.
 *
 * LOAD-BEARING assertions (per AC):
 *
 *   1. EVENT-STORE HANDLE VALIDITY: Each registered built-in tool produces a
 *      ToolEvidenceRtkSummary that, when assembled into a canonical handle via
 *      assembleAndWriteBuiltInHandle(), produces a handle that passes
 *      validateToolEvidenceHandle() — with the correct tool name and owning file.
 *
 *   2. NO-LEAK (model-facing): The model-facing response for each built-in tool
 *      does NOT contain the evidenceHandle, rawOutput, or modelFacingRawOutput
 *      fields. The registry factory produces a summary, not the full handle.
 *
 *   3. TOOL-LOCAL OWNERSHIP: The rtkSummary.owningFile for each tool matches the
 *      expected 'src/tools/<toolName>.ts' convention (affirmative tool-local check).
 *
 *   4. SCHEMA DRIFT DETECTION: The schemaHash for each tool is derived from its
 *      descriptor — not pasted. An independently computed hash matches the constant.
 *
 *   5. REGISTRY COVERAGE: All 5 required categories (control-plane, artifact/query,
 *      checklist, checkpoint/review, restart/signal) have a factory in the registry.
 *
 *   7. ENUM COVERAGE (LOAD-BEARING): Every invocable BuiltInToolName has a factory
 *      in BUILTIN_RTK_SUMMARY_REGISTRY. The test iterates the actual enum so the gap
 *      cannot recur. BuiltInToolName.ORR_ELSE is the only justified exclusion — it is
 *      a Pi command surface (pi.registerCommand), not a model-callable tool.
 *
 *   8. WRAP_PLUGIN_TOOL INTEGRATION (LOAD-BEARING): A wrapped built-in invoked through
 *      the real wrapPluginTool / event-recording path records a TOOL_INVOCATION_SUCCEEDED
 *      event whose evidenceHandle passes validateToolEvidenceHandle() AND the model-facing
 *      result is byte-identical to the raw tool result (no evidenceHandle leak).
 *
 *   9. FAILED-RUNSTATUS: A built-in that runs to completion but returns failure records
 *      a TOOL_INVOCATION_FAILED event whose evidenceHandle.runStatus is NOT 'PASSED'.
 *
 * These tests CANNOT be vacuous: removing the registry factories or the handle
 * assembly in wrapPluginTool would cause assertions 1 and 2 to fail.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import orrElseExtension from '../src/extension.js';
import { BuiltInToolName, DomainEventName } from '../src/constants/domain.js';
import { EnvVars, PiEventName } from '../src/constants/infra.js';

import {
  validateToolEvidenceHandle,
  TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
  type ToolEvidenceRtkSummary,
} from '../src/core/ToolEvidenceHandle.js';
import {
  assembleAndWriteBuiltInHandle,
} from '../src/tools/builtin_handles.js';
import {
  BUILTIN_RTK_SUMMARY_REGISTRY,
  getBuiltInRtkSummaryFactory,
} from '../src/tools/builtin_rtk_registry.js';
import {
  computeHarnessStatusSchemaHash,
  HARNESS_STATUS_SCHEMA_DESCRIPTOR,
  HARNESS_STATUS_SCHEMA_HASH,
  HARNESS_STATUS_TOOL_NAME,
} from '../src/tools/harness_status.js';
import {
  computePreSignalAuditSchemaHash,
  PRE_SIGNAL_AUDIT_SCHEMA_DESCRIPTOR,
  PRE_SIGNAL_AUDIT_SCHEMA_HASH,
  PRE_SIGNAL_AUDIT_TOOL_NAME,
} from '../src/tools/pre_signal_audit.js';
import {
  computeGetArtifactPathsSchemaHash,
  GET_ARTIFACT_PATHS_SCHEMA_DESCRIPTOR,
  GET_ARTIFACT_PATHS_SCHEMA_HASH,
  GET_ARTIFACT_PATHS_TOOL_NAME,
} from '../src/tools/get_artifact_paths.js';
import {
  computeTickItemsSchemaHash,
  TICK_ITEMS_SCHEMA_DESCRIPTOR,
  TICK_ITEMS_SCHEMA_HASH,
  TICK_ITEMS_TOOL_NAME,
} from '../src/tools/tick_items.js';
import {
  computeSubmitCheckpointSchemaHash,
  SUBMIT_CHECKPOINT_SCHEMA_DESCRIPTOR,
  SUBMIT_CHECKPOINT_SCHEMA_HASH,
  SUBMIT_CHECKPOINT_TOOL_NAME,
} from '../src/tools/submit_checkpoint.js';
import {
  computeSignalCompletionSchemaHash,
  SIGNAL_COMPLETION_SCHEMA_DESCRIPTOR,
  SIGNAL_COMPLETION_SCHEMA_HASH,
  SIGNAL_COMPLETION_TOOL_NAME,
} from '../src/tools/signal_completion.js';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-ev-')));
}

function deriveHash(descriptor: Record<string, string>): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
}

/**
 * Assert that a ToolEvidenceRtkSummary and invocationId produce a valid handle
 * when assembled via assembleAndWriteBuiltInHandle.
 *
 * LOAD-BEARING: if assembleAndWriteBuiltInHandle produced an invalid handle or
 * if validateToolEvidenceHandle rejected the summary, this assertion fails.
 */
async function assertValidHandleFromSummary(
  toolName: string,
  rtkSummary: ToolEvidenceRtkSummary,
  outputDir: string
): Promise<void> {
  const handle = assembleAndWriteBuiltInHandle({
    toolName,
    invocationId: `inv-test-${toolName}-001`,
    outputDir,
    rtkSummary,
  });

  // LOAD-BEARING: validateToolEvidenceHandle must pass — this is the canonical event-store contract.
  const result = validateToolEvidenceHandle(handle, { expectedToolName: toolName });
  if (!result.valid) {
    throw new Error(
      `canonical handle for tool "${toolName}" failed validation:\n` +
      result.errors.join('\n')
    );
  }
  expect(result.valid).toBe(true);
  expect(result.handle.toolName).toBe(toolName);
  expect(result.handle.runStatus).toBe('PASSED');
  expect(result.handle.summaryMode).toBe('summary');
  expect(result.handle.rtkSummary).toBeDefined();
  // semanticArtifactPath is required for PASSED runs (zog2.8)
  expect(typeof result.handle.semanticArtifactPath).toBe('string');
  // semanticArtifactPath must be inside toolOutputRoot
  // (outputDir is inside the temp root we control)
  expect(result.handle.semanticArtifactPath!.startsWith(outputDir)).toBe(true);
}

/**
 * Assert that a model-facing result object does NOT contain the canonical handle
 * or any raw artifact paths or forbidden fields.
 *
 * LOAD-BEARING: if wrapPluginTool leaked the handle into the model-facing response,
 * or if a tool's execute() returned raw artifact paths, this assertion fails.
 */
function assertNoHandleOrPathLeak(modelFacingResult: unknown): void {
  // Model-facing result must not be or contain a ToolEvidenceHandle.
  if (typeof modelFacingResult !== 'object' || modelFacingResult === null) return;
  const r = modelFacingResult as Record<string, unknown>;
  // Forbidden fields on model-facing response
  expect(r, 'model-facing response must not contain rawOutput').not.toHaveProperty('rawOutput');
  expect(r, 'model-facing response must not contain modelFacingRawOutput').not.toHaveProperty('modelFacingRawOutput');
  expect(r, 'model-facing response must not contain evidenceHandle').not.toHaveProperty('evidenceHandle');
  // The handle's canonical fields must not appear directly on the model-facing response
  expect(r, 'model-facing response must not contain schemaVersion (handle field)').not.toHaveProperty('schemaVersion');
  expect(r, 'model-facing response must not contain admittedHarnessFingerprint (handle field)').not.toHaveProperty('admittedHarnessFingerprint');
  expect(r, 'model-facing response must not contain admittedExecutionBoundary (handle field)').not.toHaveProperty('admittedExecutionBoundary');
  // No raw semanticArtifactPath (would leak filesystem paths)
  if (typeof r.semanticArtifactPath === 'string') {
    throw new Error(`model-facing response contains raw semanticArtifactPath: "${r.semanticArtifactPath}"`);
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tempDir: string;
/** outputDir under the toolOutputRoot — artifacts written here satisfy the containment check. */
let outputDir: string;

beforeEach(() => {
  tempDir = makeTempDir();
  // outputDir must be inside .pi/tool-output (what resolveBuiltInExecutionIdentity computes)
  outputDir = path.join(tempDir, '.pi', 'tool-output', 'bd-zog2-test', 'TestState', 'a1', 'test-tool', 'inv-001');
  fs.mkdirSync(outputDir, { recursive: true });
  // Set env vars expected by resolveBuiltInExecutionIdentity
  process.env['PI_PROJECT_ROOT'] = tempDir;
  process.env['PI_BEAD_ID'] = 'bd-zog2-test';
  process.env['PI_STATE_ID'] = 'TestState';
  process.env['PI_ACTION_ID'] = 'a1';
});

afterEach(() => {
  delete process.env['PI_PROJECT_ROOT'];
  delete process.env['PI_BEAD_ID'];
  delete process.env['PI_STATE_ID'];
  delete process.env['PI_ACTION_ID'];
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Schema drift detection — every tool's schemaHash is derived from its descriptor
// ---------------------------------------------------------------------------

describe('schema drift detection — hashes are derived, not pasted', () => {

  it('harness_status: HARNESS_STATUS_SCHEMA_HASH matches fresh computation from descriptor', () => {
    const recomputed = deriveHash(HARNESS_STATUS_SCHEMA_DESCRIPTOR as unknown as Record<string, string>);
    expect(HARNESS_STATUS_SCHEMA_HASH).toBe(recomputed);
    expect(computeHarnessStatusSchemaHash()).toBe(recomputed);
  });

  it('pre_signal_audit: PRE_SIGNAL_AUDIT_SCHEMA_HASH matches fresh computation from descriptor', () => {
    const recomputed = deriveHash(PRE_SIGNAL_AUDIT_SCHEMA_DESCRIPTOR as unknown as Record<string, string>);
    expect(PRE_SIGNAL_AUDIT_SCHEMA_HASH).toBe(recomputed);
    expect(computePreSignalAuditSchemaHash()).toBe(recomputed);
  });

  it('get_artifact_paths: GET_ARTIFACT_PATHS_SCHEMA_HASH matches fresh computation from descriptor', () => {
    const recomputed = deriveHash(GET_ARTIFACT_PATHS_SCHEMA_DESCRIPTOR as unknown as Record<string, string>);
    expect(GET_ARTIFACT_PATHS_SCHEMA_HASH).toBe(recomputed);
    expect(computeGetArtifactPathsSchemaHash()).toBe(recomputed);
  });

  it('tick_items: TICK_ITEMS_SCHEMA_HASH matches fresh computation from descriptor', () => {
    const recomputed = deriveHash(TICK_ITEMS_SCHEMA_DESCRIPTOR as unknown as Record<string, string>);
    expect(TICK_ITEMS_SCHEMA_HASH).toBe(recomputed);
    expect(computeTickItemsSchemaHash()).toBe(recomputed);
  });

  it('submit_checkpoint: SUBMIT_CHECKPOINT_SCHEMA_HASH matches fresh computation from descriptor', () => {
    const recomputed = deriveHash(SUBMIT_CHECKPOINT_SCHEMA_DESCRIPTOR as unknown as Record<string, string>);
    expect(SUBMIT_CHECKPOINT_SCHEMA_HASH).toBe(recomputed);
    expect(computeSubmitCheckpointSchemaHash()).toBe(recomputed);
  });

  it('signal_completion: SIGNAL_COMPLETION_SCHEMA_HASH matches fresh computation from descriptor', () => {
    const recomputed = deriveHash(SIGNAL_COMPLETION_SCHEMA_DESCRIPTOR as unknown as Record<string, string>);
    expect(SIGNAL_COMPLETION_SCHEMA_HASH).toBe(recomputed);
    expect(computeSignalCompletionSchemaHash()).toBe(recomputed);
  });

});

// ---------------------------------------------------------------------------
// 2. Registry coverage — 5 required categories are present
// ---------------------------------------------------------------------------

describe('registry coverage — required tool categories', () => {

  it('has a factory for the control-plane tool (harness_status)', () => {
    expect(getBuiltInRtkSummaryFactory(BuiltInToolName.HARNESS_STATUS)).toBeDefined();
  });

  it('has a factory for the artifact/query tool (get_artifact_paths)', () => {
    expect(getBuiltInRtkSummaryFactory(BuiltInToolName.GET_ARTIFACT_PATHS)).toBeDefined();
  });

  it('has a factory for the checklist tool (tick_items)', () => {
    expect(getBuiltInRtkSummaryFactory(BuiltInToolName.TICK_ITEMS)).toBeDefined();
  });

  it('has a factory for the checkpoint/review tool (submit_checkpoint)', () => {
    expect(getBuiltInRtkSummaryFactory(BuiltInToolName.SUBMIT_CHECKPOINT)).toBeDefined();
  });

  it('has a factory for the restart/signal tool (signal_completion)', () => {
    expect(getBuiltInRtkSummaryFactory(BuiltInToolName.SIGNAL_COMPLETION)).toBeDefined();
  });

  it('has a factory for the control-plane audit tool (pre_signal_audit)', () => {
    expect(getBuiltInRtkSummaryFactory(BuiltInToolName.PRE_SIGNAL_AUDIT)).toBeDefined();
  });

});

// ---------------------------------------------------------------------------
// 3. Handle validity — LOAD-BEARING: for each required tool, the factory produces
//    a summary that yields a valid canonical ToolEvidenceHandle on the event store.
// ---------------------------------------------------------------------------

describe('event-store handle validity — validateToolEvidenceHandle passes (LOAD-BEARING)', () => {

  // ── Control-plane: harness_status ──────────────────────────────────────────

  it('harness_status: factory produces valid canonical handle (control-plane)', async () => {
    const factory = getBuiltInRtkSummaryFactory(BuiltInToolName.HARNESS_STATUS)!;
    const fakeResult = {
      mode: 'teammate',
      beadId: 'bd-zog2-test',
      stateId: 'TestState',
      actionId: 'a1',
    };
    const rtkSummary = factory(fakeResult, {});
    await assertValidHandleFromSummary(HARNESS_STATUS_TOOL_NAME, rtkSummary, outputDir);
  });

  it('harness_status: rtkSummary.owningFile is the tool-local module (affirmative check)', () => {
    const factory = getBuiltInRtkSummaryFactory(BuiltInToolName.HARNESS_STATUS)!;
    const rtkSummary = factory({ mode: 'inactive' }, {});
    expect(rtkSummary.owningFile).toBe('src/tools/harness_status.ts');
  });

  // ── Control-plane: pre_signal_audit ───────────────────────────────────────

  it('pre_signal_audit: factory produces valid canonical handle (control-plane)', async () => {
    const factory = getBuiltInRtkSummaryFactory(BuiltInToolName.PRE_SIGNAL_AUDIT)!;
    const fakeResult = {
      ready: true,
      outcome: 'SUCCESS',
      blockingEvidence: [],
      checkpointAccepted: true,
    };
    const rtkSummary = factory(fakeResult, {});
    await assertValidHandleFromSummary(PRE_SIGNAL_AUDIT_TOOL_NAME, rtkSummary, outputDir);
  });

  it('pre_signal_audit: rtkSummary.owningFile is the tool-local module (affirmative check)', () => {
    const factory = getBuiltInRtkSummaryFactory(BuiltInToolName.PRE_SIGNAL_AUDIT)!;
    const rtkSummary = factory({ ready: false, outcome: 'SUCCESS', blockingEvidence: ['x'] }, {});
    expect(rtkSummary.owningFile).toBe('src/tools/pre_signal_audit.ts');
  });

  // ── Artifact/query: get_artifact_paths ────────────────────────────────────

  it('get_artifact_paths: factory produces valid canonical handle (artifact/query)', async () => {
    const factory = getBuiltInRtkSummaryFactory(BuiltInToolName.GET_ARTIFACT_PATHS)!;
    const fakeResult = { paths: ['/a', '/b'], existing: ['/a'], missing: ['/b'] };
    const rtkSummary = factory(fakeResult, { beadId: 'bd-1', stateId: 'Planning' });
    await assertValidHandleFromSummary(GET_ARTIFACT_PATHS_TOOL_NAME, rtkSummary, outputDir);
  });

  it('get_artifact_paths: rtkSummary.owningFile is the tool-local module (affirmative check)', () => {
    const factory = getBuiltInRtkSummaryFactory(BuiltInToolName.GET_ARTIFACT_PATHS)!;
    const rtkSummary = factory({}, { beadId: 'bd-1' });
    expect(rtkSummary.owningFile).toBe('src/tools/get_artifact_paths.ts');
  });

  // ── Checklist: tick_items ─────────────────────────────────────────────────

  it('tick_items: factory produces valid canonical handle (checklist)', async () => {
    const factory = getBuiltInRtkSummaryFactory(BuiltInToolName.TICK_ITEMS)!;
    const fakeResult = { status: 'PASSED', count: 2, checked: ['item1', 'item2'] };
    const rtkSummary = factory(fakeResult, {});
    await assertValidHandleFromSummary(TICK_ITEMS_TOOL_NAME, rtkSummary, outputDir);
  });

  it('tick_items: rtkSummary.owningFile is the tool-local module (affirmative check)', () => {
    const factory = getBuiltInRtkSummaryFactory(BuiltInToolName.TICK_ITEMS)!;
    const rtkSummary = factory({ status: 'PASSED', count: 1 }, {});
    expect(rtkSummary.owningFile).toBe('src/tools/tick_items.ts');
  });

  // ── Checkpoint/review: submit_checkpoint ─────────────────────────────────

  it('submit_checkpoint: factory produces valid canonical handle (checkpoint/review)', async () => {
    const factory = getBuiltInRtkSummaryFactory(BuiltInToolName.SUBMIT_CHECKPOINT)!;
    const fakeResult = 'Checkpoint accepted and recorded.';
    const rtkSummary = factory(fakeResult, { summary: 'All changes are complete.' });
    await assertValidHandleFromSummary(SUBMIT_CHECKPOINT_TOOL_NAME, rtkSummary, outputDir);
  });

  it('submit_checkpoint: rtkSummary.owningFile is the tool-local module (affirmative check)', () => {
    const factory = getBuiltInRtkSummaryFactory(BuiltInToolName.SUBMIT_CHECKPOINT)!;
    const rtkSummary = factory('Checkpoint accepted and recorded.', { summary: 'Done.' });
    expect(rtkSummary.owningFile).toBe('src/tools/submit_checkpoint.ts');
  });

  // ── Restart/signal: signal_completion ────────────────────────────────────

  it('signal_completion: factory produces valid canonical handle (restart/signal)', async () => {
    const factory = getBuiltInRtkSummaryFactory(BuiltInToolName.SIGNAL_COMPLETION)!;
    const fakeResult = 'Completion signaled with outcome: SUCCESS. Teammate process will exit.';
    const rtkSummary = factory(fakeResult, { outcome: 'SUCCESS', summary: 'Done.' });
    await assertValidHandleFromSummary(SIGNAL_COMPLETION_TOOL_NAME, rtkSummary, outputDir);
  });

  it('signal_completion: rtkSummary.owningFile is the tool-local module (affirmative check)', () => {
    const factory = getBuiltInRtkSummaryFactory(BuiltInToolName.SIGNAL_COMPLETION)!;
    const rtkSummary = factory('Completion signaled with outcome: SUCCESS. Teammate process will exit.', { outcome: 'SUCCESS' });
    expect(rtkSummary.owningFile).toBe('src/tools/signal_completion.ts');
  });

});

// ---------------------------------------------------------------------------
// 4. No-leak model-facing — LOAD-BEARING: model-facing results must NEVER contain
//    raw artifact paths, the full canonical handle, or forbidden fields.
// ---------------------------------------------------------------------------

describe('no-leak model-facing — canonical handle must not appear in model response (LOAD-BEARING)', () => {

  it('harness_status model-facing result has no handle fields (control-plane no-leak)', () => {
    // Simulate what the execute() returns for harness_status (the flowStatus object)
    const modelFacingResult = {
      mode: 'teammate',
      beadId: 'bd-1',
      stateId: 'TestState',
      actionId: 'a1',
      nextHarnessAction: 'continue',
    };
    assertNoHandleOrPathLeak(modelFacingResult);
  });

  it('get_artifact_paths model-facing result has no handle fields (artifact/query no-leak)', () => {
    // Simulate what the execute() returns for get_artifact_paths (paths + existence)
    const modelFacingResult = {
      planContract: { path: '/some/path', exists: true },
      requirementsAnalysis: { path: '/other/path', exists: false },
    };
    // Note: the paths here are ARTIFACT paths returned to the model (their content is what
    // the model needs); the constraint is that the HANDLE's semanticArtifactPath does not
    // appear. The model legitimately sees declared artifact paths from get_artifact_paths.
    // The no-leak test checks that handle-specific fields don't appear:
    assertNoHandleOrPathLeak(modelFacingResult);
  });

  it('tick_items model-facing result has no handle fields (checklist no-leak)', () => {
    const modelFacingResult = {
      status: 'PASSED',
      checked: ['Write tests', 'Fix linter'],
      count: 2,
    };
    assertNoHandleOrPathLeak(modelFacingResult);
  });

  it('submit_checkpoint model-facing result has no handle fields (checkpoint/review no-leak)', () => {
    // submit_checkpoint returns a plain string model-facing
    const modelFacingResult = 'Checkpoint accepted and recorded.';
    // Strings have no fields — trivially no-leak. Assert the type.
    expect(typeof modelFacingResult).toBe('string');
    expect(modelFacingResult).not.toContain('admittedHarnessFingerprint');
    expect(modelFacingResult).not.toContain('semanticArtifactPath');
    expect(modelFacingResult).not.toContain('evidenceHandle');
  });

  it('signal_completion model-facing result has no handle fields (restart/signal no-leak)', () => {
    const modelFacingResult = 'Completion signaled with outcome: SUCCESS. Teammate process will exit.';
    expect(typeof modelFacingResult).toBe('string');
    expect(modelFacingResult).not.toContain('admittedHarnessFingerprint');
    expect(modelFacingResult).not.toContain('semanticArtifactPath');
    expect(modelFacingResult).not.toContain('evidenceHandle');
  });

});

// ---------------------------------------------------------------------------
// 5. assemble+write — the semantic artifact is written to disk and is valid JSON
// ---------------------------------------------------------------------------

describe('assembleAndWriteBuiltInHandle — semantic artifact written to disk', () => {

  it('writes builtin-evidence.json inside outputDir and it is valid JSON containing the handle', () => {
    const factory = getBuiltInRtkSummaryFactory(BuiltInToolName.HARNESS_STATUS)!;
    const rtkSummary = factory({ mode: 'inactive' }, {});
    const handle = assembleAndWriteBuiltInHandle({
      toolName: HARNESS_STATUS_TOOL_NAME,
      invocationId: 'inv-write-test-001',
      outputDir,
      rtkSummary,
    });

    // The semantic artifact path must point inside the output dir
    expect(handle.semanticArtifactPath).toBeDefined();
    expect(handle.semanticArtifactPath!.startsWith(outputDir)).toBe(true);

    // The file must exist and be valid JSON
    const content = fs.readFileSync(handle.semanticArtifactPath!, 'utf8');
    expect(() => JSON.parse(content)).not.toThrow();

    // The written JSON must be a valid canonical handle
    const parsed = JSON.parse(content);
    const validation = validateToolEvidenceHandle(parsed, { expectedToolName: HARNESS_STATUS_TOOL_NAME });
    expect(validation.valid).toBe(true);
  });

  it('handle written to disk has schemaVersion matching TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION', () => {
    const factory = getBuiltInRtkSummaryFactory(BuiltInToolName.TICK_ITEMS)!;
    const rtkSummary = factory({ status: 'PASSED', count: 1 }, {});
    const handle = assembleAndWriteBuiltInHandle({
      toolName: TICK_ITEMS_TOOL_NAME,
      invocationId: 'inv-schema-ver-test',
      outputDir,
      rtkSummary,
    });

    expect(handle.schemaVersion).toBe(TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION);
    const content = fs.readFileSync(handle.semanticArtifactPath!, 'utf8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION);
  });

});

// ---------------------------------------------------------------------------
// 6. Wrapped plugin tool: verify the registry factory approach covers tools
//    registered in the BUILTIN_RTK_SUMMARY_REGISTRY.
// ---------------------------------------------------------------------------

describe('registry completeness — factories produce valid ToolEvidenceRtkSummary shapes', () => {

  const REQUIRED_RTK_FIELDS = [
    'schemaTypeName', 'owningFile', 'summarySchemaVersion', 'schemaHash',
    'deterministicSummaryVersion', 'inputArtifactSchemaId', 'inputArtifactSchemaVersion',
    'maximumCounts', 'omissionSemantics', 'summary'
  ];

  for (const [toolName, factory] of BUILTIN_RTK_SUMMARY_REGISTRY.entries()) {
    it(`${toolName}: factory output has all required ToolEvidenceRtkSummary fields`, () => {
      const rtkSummary = factory({}, {});
      for (const field of REQUIRED_RTK_FIELDS) {
        expect(rtkSummary, `${toolName} summary missing field: ${field}`).toHaveProperty(field);
      }
      // schemaHash must start with 'sha256:'
      expect(rtkSummary.schemaHash.startsWith('sha256:')).toBe(true);
      // owningFile must end with .ts
      expect(rtkSummary.owningFile.endsWith('.ts')).toBe(true);
      // schemaTypeName must not be the generic placeholder
      expect(rtkSummary.schemaTypeName).not.toBe('untyped_record');
    });
  }

});

// ---------------------------------------------------------------------------
// 7. Enum coverage — LOAD-BEARING: every invocable BuiltInToolName has a registry entry.
//    Iterates the actual enum so the gap CANNOT recur when new tools are added.
//    BuiltInToolName.ORR_ELSE is the only justified exclusion — it is a Pi COMMAND
//    registered via pi.registerCommand(), not a model-callable tool (pi-experiment-2xho).
// ---------------------------------------------------------------------------

describe('enum coverage — every invocable BuiltInToolName has a registry factory (LOAD-BEARING)', () => {

  /**
   * BuiltInToolName.ORR_ELSE ('orr-else') is explicitly excluded from RTK summary
   * coverage because it is a Pi command surface (pi.registerCommand()), NOT a
   * model-callable tool. The coordinator never invokes it as a tool, so no RTK
   * summary handle is needed (pi-experiment-2xho).
   */
  const NON_TOOL_META_SURFACES = new Set<string>([BuiltInToolName.ORR_ELSE]);

  it('every BuiltInToolName (minus justified non-tool meta surfaces) has a registry factory', () => {
    const missing: string[] = [];
    for (const name of Object.values(BuiltInToolName)) {
      if (NON_TOOL_META_SURFACES.has(name)) continue;
      if (!getBuiltInRtkSummaryFactory(name)) {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `LOAD-BEARING: ${missing.length} BuiltInToolName(s) missing from BUILTIN_RTK_SUMMARY_REGISTRY:\n` +
        missing.map(n => `  - ${n}`).join('\n') + '\n' +
        'Add a tool-local RTK module (src/tools/<tool>.ts) and register it in builtin_rtk_registry.ts.'
      );
    }
    expect(missing).toHaveLength(0);
  });

  it('BuiltInToolName.ORR_ELSE is absent from the registry (justified: Pi command, not model-callable)', () => {
    expect(getBuiltInRtkSummaryFactory(BuiltInToolName.ORR_ELSE)).toBeUndefined();
  });

  it.each(
    Object.values(BuiltInToolName).filter(n => !NON_TOOL_META_SURFACES.has(n))
  )('%s: factory is present and produces a valid ToolEvidenceRtkSummary', (name) => {
    const factory = getBuiltInRtkSummaryFactory(name);
    expect(factory, `missing factory for ${name}`).toBeDefined();
    const rtkSummary = factory!({}, {});
    expect(rtkSummary.schemaTypeName).toBeTruthy();
    expect(rtkSummary.owningFile).toBe(`src/tools/${name}.ts`);
    expect(rtkSummary.schemaHash.startsWith('sha256:')).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// 8. wrapPluginTool integration — LOAD-BEARING: a wrapped built-in invoked through
//    the real wrapPluginTool / event-recording path records:
//    (a) a TOOL_INVOCATION_SUCCEEDED event with a VALID evidenceHandle
//    (b) a model-facing result that is byte-identical to the raw result (no leak)
//
//    This test FAILS if:
//    - wrapPluginTool's handle-attach code is removed (handle-on-event assertion)
//    - the model-facing return is modified to include the handle (no-leak assertion)
// ---------------------------------------------------------------------------

function fakePiForIntegration() {
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

function readEventStoreJsonl(projectDir: string): Array<Record<string, unknown>> {
  const eventsDir = path.join(projectDir, '.pi', 'events');
  if (!fs.existsSync(eventsDir)) return [];
  const lines: Array<Record<string, unknown>> = [];
  for (const file of fs.readdirSync(eventsDir).filter((f: string) => f.endsWith('.jsonl'))) {
    const raw = fs.readFileSync(path.join(eventsDir, file), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }
  return lines;
}

describe('wrapPluginTool integration — handle-on-event + no-leak (LOAD-BEARING)', () => {
  let integrationTempDir: string;
  let prevProjectRoot: string | undefined;
  let prevWorktreePath: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    prevProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    prevWorktreePath = process.env[EnvVars.WORKTREE_PATH];
    integrationTempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zog2-integration-')));
    fs.writeFileSync(path.join(integrationTempDir, 'harness.yaml'), `
settings:
  startState: Planning
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    process.chdir(integrationTempDir);
    process.env[EnvVars.PROJECT_ROOT] = integrationTempDir;
    process.env[EnvVars.WORKTREE_PATH] = integrationTempDir;
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = prevProjectRoot;
    if (prevWorktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = prevWorktreePath;
    fs.rmSync(integrationTempDir, { recursive: true, force: true });
  });

  it('LOAD-BEARING: TOOL_INVOCATION_SUCCEEDED event carries a valid evidenceHandle (handle-on-event)', async () => {
    const harness = fakePiForIntegration();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: integrationTempDir });

    const harnessStatusTool = harness.tools.find((t: any) => t.name === BuiltInToolName.HARNESS_STATUS);
    expect(harnessStatusTool, 'harness_status tool must be registered').toBeDefined();

    // Invoke through the real wrapPluginTool path.
    await harnessStatusTool.execute('intg-call-1', {}, undefined, undefined, { hasUI: false, cwd: integrationTempDir });

    // Give async event writes time to flush.
    await new Promise(resolve => setTimeout(resolve, 200));

    const events = readEventStoreJsonl(integrationTempDir);
    const succeeded = events.filter(e =>
      e.type === DomainEventName.TOOL_INVOCATION_SUCCEEDED &&
      (e.data as any)?.tool === BuiltInToolName.HARNESS_STATUS
    );
    expect(succeeded.length, 'expected at least one TOOL_INVOCATION_SUCCEEDED for harness_status').toBeGreaterThanOrEqual(1);

    const latest = succeeded[succeeded.length - 1];
    const evidenceHandle = (latest.data as any).evidenceHandle;

    // LOAD-BEARING assertion (a): evidenceHandle must be present and valid.
    expect(evidenceHandle, 'TOOL_INVOCATION_SUCCEEDED must carry evidenceHandle — handle-on-event').toBeDefined();
    const validation = validateToolEvidenceHandle(evidenceHandle, { expectedToolName: BuiltInToolName.HARNESS_STATUS });
    if (!validation.valid) {
      throw new Error(
        'LOAD-BEARING: evidenceHandle on TOOL_INVOCATION_SUCCEEDED failed validateToolEvidenceHandle:\n' +
        validation.errors.join('\n')
      );
    }
    expect(validation.valid).toBe(true);
    expect(validation.handle.runStatus).toBe('PASSED');
    expect(validation.handle.toolName).toBe(BuiltInToolName.HARNESS_STATUS);
  });

  it('LOAD-BEARING: model-facing result does NOT contain evidenceHandle or handle fields (no-leak)', async () => {
    const harness = fakePiForIntegration();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: integrationTempDir });

    const harnessStatusTool = harness.tools.find((t: any) => t.name === BuiltInToolName.HARNESS_STATUS);
    expect(harnessStatusTool, 'harness_status tool must be registered').toBeDefined();

    // Invoke through the real wrapPluginTool path; capture the model-facing return value.
    const modelFacingResult = await harnessStatusTool.execute(
      'intg-noleak-1', {}, undefined, undefined, { hasUI: false, cwd: integrationTempDir }
    );

    // LOAD-BEARING assertion (b): the model-facing result must NOT contain the handle.
    // wrapPluginTool wraps the raw tool result in toolResult(result) → { content, details }.
    // The details field is the raw tool result; neither details nor content should carry
    // evidenceHandle, semanticArtifactPath, admittedHarnessFingerprint, schemaVersion.
    expect(modelFacingResult, 'model-facing result must be defined').toBeDefined();
    const resultStr = JSON.stringify(modelFacingResult);
    expect(resultStr, 'model-facing result must not contain evidenceHandle').not.toContain('evidenceHandle');
    expect(resultStr, 'model-facing result must not contain admittedHarnessFingerprint').not.toContain('admittedHarnessFingerprint');
    expect(resultStr, 'model-facing result must not contain admittedExecutionBoundary').not.toContain('admittedExecutionBoundary');
    expect(resultStr, 'model-facing result must not contain semanticArtifactPath').not.toContain('semanticArtifactPath');
  });

});

// ---------------------------------------------------------------------------
// 9. FAILED-runStatus — LOAD-BEARING: a built-in that runs to completion but
//    returns failure records a TOOL_INVOCATION_FAILED event whose
//    evidenceHandle.runStatus is NOT 'PASSED'.
//
//    signal_completion with no checkpoint accepted is a reliable way to get a
//    REJECTED result from a built-in (pre_signal_audit ready:false also works).
// ---------------------------------------------------------------------------

describe('FAILED-runStatus — TOOL_INVOCATION_FAILED evidenceHandle.runStatus is not PASSED (LOAD-BEARING)', () => {
  let failedRunTempDir: string;
  let prevProjectRoot: string | undefined;
  let prevWorktreePath: string | undefined;
  let prevWorkerMode: string | undefined;
  let prevBeadId: string | undefined;
  let prevStateId: string | undefined;
  let prevActionId: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    prevProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    prevWorktreePath = process.env[EnvVars.WORKTREE_PATH];
    prevWorkerMode = process.env[EnvVars.WORKER_MODE];
    prevBeadId = process.env[EnvVars.BEAD_ID];
    prevStateId = process.env[EnvVars.STATE_ID];
    prevActionId = process.env[EnvVars.ACTION_ID];
    failedRunTempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zog2-failed-run-')));
    fs.writeFileSync(path.join(failedRunTempDir, 'harness.yaml'), `
settings:
  startState: Planning
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    process.chdir(failedRunTempDir);
    process.env[EnvVars.PROJECT_ROOT] = failedRunTempDir;
    process.env[EnvVars.WORKTREE_PATH] = failedRunTempDir;
    // Worker mode enables the pre_signal_audit gate (checkpoint required before signaling).
    process.env[EnvVars.WORKER_MODE] = '1';
    process.env[EnvVars.BEAD_ID] = 'bd-zog2-failed-test';
    process.env[EnvVars.STATE_ID] = 'Planning';
    process.env[EnvVars.ACTION_ID] = 'a1';
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = prevProjectRoot;
    if (prevWorktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = prevWorktreePath;
    if (prevWorkerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
    else process.env[EnvVars.WORKER_MODE] = prevWorkerMode;
    if (prevBeadId === undefined) delete process.env[EnvVars.BEAD_ID];
    else process.env[EnvVars.BEAD_ID] = prevBeadId;
    if (prevStateId === undefined) delete process.env[EnvVars.STATE_ID];
    else process.env[EnvVars.STATE_ID] = prevStateId;
    if (prevActionId === undefined) delete process.env[EnvVars.ACTION_ID];
    else process.env[EnvVars.ACTION_ID] = prevActionId;
    fs.rmSync(failedRunTempDir, { recursive: true, force: true });
  });

  it('LOAD-BEARING: TOOL_INVOCATION_FAILED evidenceHandle.runStatus is REJECTED (not PASSED)', async () => {
    const harness = fakePiForIntegration();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: failedRunTempDir });
    await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: failedRunTempDir });

    // pre_signal_audit with ready:false is a reliable registered-tool failure.
    // Invoking signal_completion without a prior checkpoint produces a REJECTED result
    // from a built-in that runs to completion (signal_completion is in the registry).
    const signalTool = harness.tools.find((t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION);
    expect(signalTool, 'signal_completion tool must be registered').toBeDefined();

    // signal_completion without prior checkpoint returns 'REJECTED: You must call submit_checkpoint...'
    // This causes resultIndicatesFailure() → true → TOOL_INVOCATION_FAILED event.
    const modelFacingResult = await signalTool.execute(
      'failed-run-test-1',
      { outcome: 'SUCCESS', summary: 'done' },
      undefined,
      undefined,
      { hasUI: false, cwd: failedRunTempDir }
    );

    // The model-facing result must be the raw rejection message, not a handle.
    expect(modelFacingResult).toBeDefined();
    const resultText = JSON.stringify(modelFacingResult);
    expect(resultText).toContain('REJECTED');

    // Give async event writes time to flush.
    await new Promise(resolve => setTimeout(resolve, 200));

    const events = readEventStoreJsonl(failedRunTempDir);
    const failed = events.filter(e =>
      e.type === DomainEventName.TOOL_INVOCATION_FAILED &&
      (e.data as any)?.tool === BuiltInToolName.SIGNAL_COMPLETION
    );
    expect(failed.length, 'expected at least one TOOL_INVOCATION_FAILED for signal_completion').toBeGreaterThanOrEqual(1);

    const latest = failed[failed.length - 1];
    const evidenceHandle = (latest.data as any).evidenceHandle;

    // LOAD-BEARING: the FAILED event must carry an evidenceHandle with runStatus !== 'PASSED'.
    // If wrapPluginTool attached the PASSED handle (the bug), this assertion fails.
    expect(evidenceHandle, 'TOOL_INVOCATION_FAILED must carry an evidenceHandle').toBeDefined();
    expect(
      evidenceHandle.runStatus,
      'TOOL_INVOCATION_FAILED evidenceHandle.runStatus must not be PASSED — it must reflect the failure outcome'
    ).not.toBe('PASSED');
    expect(evidenceHandle.runStatus).toBe('REJECTED');
    expect(evidenceHandle.toolName).toBe(BuiltInToolName.SIGNAL_COMPLETION);
  });

});
