/**
 * canonical_evidence_producer.test.ts
 *
 * pi-experiment-zog2.3 (producer-half) — integration tests for canonical evidence
 * emission and validation in executeConfiguredProjectTool.
 *
 * Tests drive harness command tools via a fixture tool that opts into canonical
 * evidence by emitting an `evidenceHandle` in its JSON stdout. Cerdiwen tools
 * (legacy) are NOT touched — they remain on the non-canonical path.
 *
 * Scenarios covered (all load-bearing per bead AC):
 *   1. PASSED  — valid canonical handle recorded; result carries canonical evidence.
 *   2. REJECTED — invalid handle (missing semanticArtifactPath); deterministic error.
 *   3. TIMEOUT  — tool times out; non-canonical path (no stdout evidenceHandle).
 *   4. ENOENT   — command not found; UNAVAILABLE; non-canonical.
 *   5. Old child ToolResultBase rejection — evidenceHandle IS a ToolResultBase shape.
 *   6. Command-envelope rejection — semanticArtifactPath points to stdoutFile.
 *   7. Large raw output — transport archived (not semantic); no canonical path.
 *   8. Missing RTK summary on PASSED — summaryMode='none' rejected on canonical path.
 *   9. Non-TypeScript RTK summary — owningFile ends with .js; rejected.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { ToolCallPathFactory } from '../src/core/ToolCallPathFactory.js';
import { CwdMode, DomainEventName, ProjectToolType, ToolResultStatus } from '../src/constants/domain.js';
import { EnvVars } from '../src/constants/infra.js';
import type { ProjectCommandToolConfig } from '../src/core/domain/StateModels.js';
import { executeConfiguredProjectTool } from '../src/plugins/projectTools.js';
import { TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION } from '../src/core/ToolEvidenceHandle.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function writeMinimalHarnessConfig(projectRoot: string): void {
  fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), `
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
}

/**
 * Build a valid ToolEvidenceHandle JSON string for use in fixture scripts.
 * The semanticArtifactPath must be inside the tool output dir — the fixture
 * script writes the artifact to PI_TOOL_OUTPUT_DIR/result.json.
 */
function validEvidenceHandle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: 'canonical_fixture',
    invocationId: 'inv-fixture-001',
    runStatus: 'PASSED',
    semanticArtifactPath: '__ARTIFACT_PATH__', // replaced by fixture at runtime
    semanticArtifactBytes: 42,
    semanticArtifactSha256: 'sha256:' + 'a'.repeat(64),
    toolOutputRoot: '__OUTPUT_ROOT__', // replaced by fixture at runtime
    summaryMode: 'summary',
    rtkSummary: {
      schemaTypeName: 'CanonicalFixtureRtkSummary',
      owningFile: 'src/tools/canonical_fixture.ts',
      summarySchemaVersion: '1.0.0',
      schemaHash: 'sha256:' + 'b'.repeat(64),
      deterministicSummaryVersion: '1.0.0',
      inputArtifactSchemaId: 'canonical-fixture-result',
      inputArtifactSchemaVersion: '1.0.0',
      maximumCounts: { results: 10 },
      omissionSemantics: 'results beyond maximumCounts.results are omitted',
      summary: { resultCount: 1, ok: true },
    },
    admittedHarnessFingerprint: 'sha256:test-fingerprint',
    admittedExecutionBoundary: 'bead:bd-1/state:Planning/action:a1',
    ...overrides,
  };
}

/**
 * Build a Node.js fixture script that:
 *   1. Writes the semantic artifact to PI_TOOL_OUTPUT_DIR/result.json.
 *   2. Prints a JSON stdout containing `evidenceHandle` with the correct paths.
 *
 * The evidenceHandle is merged with `handleOverrides` so tests can inject
 * invalid/edge-case fields without forking the whole script.
 */
function buildCanonicalFixtureScript(handleOverrides: Record<string, unknown> = {}): string {
  const baseHandle = validEvidenceHandle(handleOverrides);
  const handleJson = JSON.stringify(baseHandle);
  return `
const fs = require('fs');
const path = require('path');
const outputDir = process.env['${EnvVars.TOOL_OUTPUT_DIR}'];
const outputRoot = path.join(process.env['${EnvVars.PROJECT_ROOT}'], '.pi/tool-output');
const artifactPath = path.join(outputDir, 'result.json');
fs.writeFileSync(artifactPath, JSON.stringify({ ok: true }));

// Build the handle with runtime-resolved paths
const handle = ${handleJson};
handle.semanticArtifactPath = artifactPath;
handle.toolOutputRoot = outputRoot;

process.stdout.write(JSON.stringify({ evidenceHandle: handle, status: 'PASSED' }));
`;
}

/**
 * A fixture command tool definition that opts into canonical evidence.
 */
function canonicalFixtureTool(script: string, name = 'canonical_fixture'): ProjectCommandToolConfig {
  return {
    name,
    type: ProjectToolType.COMMAND,
    command: process.execPath,
    defaultArgs: ['-e', script],
    cwd: CwdMode.WORKTREE,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('canonical evidence producer (zog2.3)', () => {
  let tempRoot: string;
  let tempWorktree: string;
  let prevProjectRoot: string | undefined;
  let prevWorktree: string | undefined;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let toolCallPathFactory: ToolCallPathFactory;

  beforeEach(() => {
    prevProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    prevWorktree = process.env[EnvVars.WORKTREE_PATH];

    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-canonical-evidence-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-1');
    fs.mkdirSync(tempWorktree, { recursive: true });
    writeMinimalHarnessConfig(tempRoot);

    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-canonical-${process.pid}`);

    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempWorktree;
  });

  afterEach(() => {
    configLoader.reset();
    eventStore.setSessionId(`test-canonical-${process.pid}-reset`);
    if (prevProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = prevProjectRoot;
    if (prevWorktree === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = prevWorktree;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  // ── 1. PASSED: valid canonical handle is accepted, result passes through ──

  it('accepts a valid canonical evidence handle from a fixture command tool (PASSED)', async () => {
    const script = buildCanonicalFixtureScript();
    const tool = canonicalFixtureTool(script);

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    // The command succeeded — canonical path accepted; result passes through.
    expect(result.status).toBe(ToolResultStatus.PASSED);
    // No canonical rejection marker on a valid handle.
    expect((result as any).canonicalEvidenceErrors).toBeUndefined();

    // Event store records a PROJECT_TOOL_SUCCEEDED event.
    const events = await eventStore.eventsForBead('bd-1');
    const succeeded = events.find(e => e.type === DomainEventName.PROJECT_TOOL_SUCCEEDED && e.data?.tool === 'canonical_fixture');
    expect(succeeded).toBeDefined();
  });

  // ── 2. REJECTED: missing semanticArtifactPath on a PASSED canonical tool ──

  it('rejects a canonical-path tool that emits PASSED without semanticArtifactPath (missing artifact)', async () => {
    // Emit a handle with runStatus='PASSED' but no semanticArtifactPath.
    const script = `
const fs = require('fs');
const path = require('path');
const outputDir = process.env['${EnvVars.TOOL_OUTPUT_DIR}'];
const outputRoot = path.join(process.env['${EnvVars.PROJECT_ROOT}'], '.pi/tool-output');
const handle = {
  schemaVersion: '${TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION}',
  toolName: 'canonical_fixture',
  invocationId: 'inv-no-artifact',
  runStatus: 'PASSED',
  // semanticArtifactPath intentionally absent
  toolOutputRoot: outputRoot,
  summaryMode: 'summary',
  rtkSummary: {
    schemaTypeName: 'CanonicalFixtureRtkSummary',
    owningFile: 'src/tools/canonical_fixture.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: 'sha256:' + 'b'.repeat(64),
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'canonical-fixture-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: { results: 10 },
    omissionSemantics: 'results beyond maximumCounts.results are omitted',
    summary: { resultCount: 0 },
  },
  admittedHarnessFingerprint: 'sha256:test-fingerprint',
  admittedExecutionBoundary: 'bead:bd-1/state:Planning/action:a1',
};
process.stdout.write(JSON.stringify({ evidenceHandle: handle }));
`;
    const tool = canonicalFixtureTool(script);

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect((result as any).canonicalEvidenceErrors).toBeDefined();
    expect((result as any).canonicalEvidenceErrors.some(
      (e: string) => e.includes('semanticArtifactPath') && e.includes('required for PASSED runs')
    )).toBe(true);
    expect((result as any).message).toContain('REJECTED');
    expect((result as any).message).toContain('canonical_fixture');

    // Event store records a PROJECT_TOOL_FAILED event.
    const events = await eventStore.eventsForBead('bd-1');
    const failed = events.find(e => e.type === DomainEventName.PROJECT_TOOL_FAILED && e.data?.tool === 'canonical_fixture');
    expect(failed).toBeDefined();
    expect(failed?.data?.status).toBe(ToolResultStatus.REJECTED);
  });

  // ── 3. TIMEOUT: tool times out — non-canonical (no evidenceHandle in stdout) ──

  it('treats a timed-out command tool as non-canonical (no evidenceHandle emitted on timeout)', async () => {
    // Sleep longer than the tool timeout; the subprocess never prints stdout.
    const timeoutScript = `
const sab = new SharedArrayBuffer(4);
Atomics.wait(new Int32Array(sab), 0, 0, 10000);
`;
    const tool: ProjectCommandToolConfig = {
      name: 'timeout_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', timeoutScript],
      cwd: CwdMode.WORKTREE,
      timeoutMs: 200, // force a quick timeout
    };

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    // Timed out — REJECTED, non-canonical (no canonicalEvidenceErrors).
    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect((result as any).timedOut).toBe(true);
    expect((result as any).canonicalEvidenceErrors).toBeUndefined();
    // CRITICAL: cerdiwen-style legacy tools must still work — no canonical rejection.
    expect((result as any).failureCategory).not.toBe('INPUT');
  });

  // ── 4. ENOENT: command not found — non-canonical path (no stdout emitted) ──
  // execa with reject:false resolves for ENOENT; the harness returns REJECTED
  // (commandFailureStatus path via error.code='ENOENT' is only in the catch branch).
  // Either way, no evidenceHandle is emitted so canonical checks are NOT triggered.

  it('does not apply canonical evidence checks when the command binary is missing (ENOENT/no stdout)', async () => {
    const tool: ProjectCommandToolConfig = {
      name: 'missing_command_tool',
      type: ProjectToolType.COMMAND,
      command: '/nonexistent/path/to/command-that-does-not-exist',
      defaultArgs: [],
      cwd: CwdMode.WORKTREE,
    };

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    // Command failed (ENOENT) — no stdout evidenceHandle emitted, so canonical
    // checks are never triggered. Result is REJECTED or UNAVAILABLE.
    expect([ToolResultStatus.REJECTED, ToolResultStatus.UNAVAILABLE]).toContain(result.status);
    expect((result as any).canonicalEvidenceErrors).toBeUndefined();
  });

  // ── 5. Old child ToolResultBase rejection ──
  // The evidenceHandle field ITSELF is a ToolResultBase shape (has tool/status/outputFile).

  it('rejects a canonical-path tool whose evidenceHandle is a ToolResultBase shape (legacy migration debt)', async () => {
    const script = `
const handle = {
  tool: 'canonical_fixture',
  status: 'PASSED',
  outputFile: '/some/path/output.json'
};
process.stdout.write(JSON.stringify({ evidenceHandle: handle }));
`;
    const tool = canonicalFixtureTool(script);

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect((result as any).canonicalEvidenceErrors).toBeDefined();
    expect((result as any).canonicalEvidenceErrors.some(
      (e: string) => e.includes('ToolResultBase')
    )).toBe(true);
  });

  // ── 6. Command-envelope rejection: semanticArtifactPath === stdoutFile ──

  it('rejects a canonical-path tool that uses stdoutFile as semanticArtifactPath (transport-as-semantic)', async () => {
    const script = `
const path = require('path');
const outputDir = process.env['${EnvVars.TOOL_OUTPUT_DIR}'];
const outputRoot = path.join(process.env['${EnvVars.PROJECT_ROOT}'], '.pi/tool-output');
// stdoutFile is the file that captures stdout — it's a raw transport archive.
// A tool MUST NOT point semanticArtifactPath at its own stdoutFile.
const stdoutFile = path.join(outputDir, 'stdout.log');
const handle = {
  schemaVersion: '${TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION}',
  toolName: 'canonical_fixture',
  invocationId: 'inv-transport-as-semantic',
  runStatus: 'PASSED',
  semanticArtifactPath: stdoutFile, // THIS IS THE VIOLATION
  toolOutputRoot: outputRoot,
  summaryMode: 'summary',
  rtkSummary: {
    schemaTypeName: 'CanonicalFixtureRtkSummary',
    owningFile: 'src/tools/canonical_fixture.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: 'sha256:' + 'b'.repeat(64),
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'canonical-fixture-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: { results: 10 },
    omissionSemantics: 'results beyond maximumCounts.results are omitted',
    summary: { resultCount: 0 },
  },
  admittedHarnessFingerprint: 'sha256:test-fingerprint',
  admittedExecutionBoundary: 'bead:bd-1/state:Planning/action:a1',
};
// Also write to stdout so the stdoutFile path actually matches
process.stdout.write(JSON.stringify({ evidenceHandle: handle }));
`;
    const tool = canonicalFixtureTool(script);

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect((result as any).canonicalEvidenceErrors).toBeDefined();
    expect((result as any).canonicalEvidenceErrors.some(
      (e: string) => e.includes('transport') || e.includes('stdoutFile') || e.includes('stderrFile')
    )).toBe(true);
  });

  // ── 7. Large raw output — transport evidence only; non-canonical path ──
  // A tool that writes large stdout but does NOT emit an evidenceHandle
  // goes through the legacy path — no canonical evidence checks triggered.

  it('archives large raw output as transport evidence only (non-canonical legacy tool)', async () => {
    // Write 50 KiB of data to stdout without an evidenceHandle.
    const script = `
const big = 'x'.repeat(50 * 1024);
process.stdout.write(big);
`;
    const tool: ProjectCommandToolConfig = {
      name: 'large_output_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', script],
      cwd: CwdMode.WORKTREE,
    };

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    // Tool passes (non-zero stdout, exit 0) — canonical checks NOT triggered.
    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect((result as any).canonicalEvidenceErrors).toBeUndefined();
    // stdoutFile exists and is a transport archive reference.
    expect(typeof (result as any).stdoutFile).toBe('string');
    expect(fs.existsSync((result as any).stdoutFile)).toBe(true);
    // Large raw output is archived in full (transport evidence).
    expect((result as any).stdoutBytes).toBeGreaterThanOrEqual(50 * 1024);
  });

  // ── 8. Missing RTK summary on PASSED canonical tool ──
  // summaryMode='none' is not admissible for PASSED runs on the canonical path.

  it('rejects a PASSED canonical-path tool with summaryMode="none" (RTK summary required)', async () => {
    const script = `
const fs = require('fs');
const path = require('path');
const outputDir = process.env['${EnvVars.TOOL_OUTPUT_DIR}'];
const outputRoot = path.join(process.env['${EnvVars.PROJECT_ROOT}'], '.pi/tool-output');
const artifactPath = path.join(outputDir, 'result.json');
fs.writeFileSync(artifactPath, JSON.stringify({ ok: true }));
const handle = {
  schemaVersion: '${TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION}',
  toolName: 'canonical_fixture',
  invocationId: 'inv-no-summary',
  runStatus: 'PASSED',
  semanticArtifactPath: artifactPath,
  toolOutputRoot: outputRoot,
  summaryMode: 'none',
  noSummaryReason: 'testing that this is rejected on canonical path',
  admittedHarnessFingerprint: 'sha256:test-fingerprint',
  admittedExecutionBoundary: 'bead:bd-1/state:Planning/action:a1',
};
process.stdout.write(JSON.stringify({ evidenceHandle: handle }));
`;
    const tool = canonicalFixtureTool(script);

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect((result as any).canonicalEvidenceErrors).toBeDefined();
    expect((result as any).canonicalEvidenceErrors.some(
      (e: string) => e.includes('summaryMode') || e.includes('rtkSummary') || e.includes('summary')
    )).toBe(true);
  });

  // ── 9. Non-TypeScript RTK summary ──
  // owningFile must end with .ts; a .js owningFile must be rejected.

  it('rejects a canonical-path tool whose rtkSummary.owningFile does not end with .ts (non-TypeScript summarizer)', async () => {
    const script = `
const fs = require('fs');
const path = require('path');
const outputDir = process.env['${EnvVars.TOOL_OUTPUT_DIR}'];
const outputRoot = path.join(process.env['${EnvVars.PROJECT_ROOT}'], '.pi/tool-output');
const artifactPath = path.join(outputDir, 'result.json');
fs.writeFileSync(artifactPath, JSON.stringify({ ok: true }));
const handle = {
  schemaVersion: '${TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION}',
  toolName: 'canonical_fixture',
  invocationId: 'inv-js-summarizer',
  runStatus: 'PASSED',
  semanticArtifactPath: artifactPath,
  toolOutputRoot: outputRoot,
  summaryMode: 'summary',
  rtkSummary: {
    schemaTypeName: 'CanonicalFixtureRtkSummary',
    owningFile: 'src/tools/canonical_fixture.js', // VIOLATION: must end with .ts
    summarySchemaVersion: '1.0.0',
    schemaHash: 'sha256:' + 'c'.repeat(64),
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'canonical-fixture-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: { results: 10 },
    omissionSemantics: 'results beyond maximumCounts.results are omitted',
    summary: { resultCount: 0 },
  },
  admittedHarnessFingerprint: 'sha256:test-fingerprint',
  admittedExecutionBoundary: 'bead:bd-1/state:Planning/action:a1',
};
process.stdout.write(JSON.stringify({ evidenceHandle: handle }));
`;
    const tool = canonicalFixtureTool(script);

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect((result as any).canonicalEvidenceErrors).toBeDefined();
    expect((result as any).canonicalEvidenceErrors.some(
      (e: string) => e.includes('.ts') || e.includes('TypeScript')
    )).toBe(true);
  });

  // ── 10. Production-path: project-tool owningFile on-disk check fires via projectRoot threading ──
  //
  // LOAD-BEARING: this test drives the REAL executeConfiguredProjectTool path and
  // proves the 6q0y.12 on-disk existence check fires in production. It fails if
  // projectRoot is NOT threaded into extractCanonicalEvidence (i.e. the check
  // stays dead). Removing the projectRoot argument from the extractCanonicalEvidence
  // call in projectTools.ts causes this test to emit valid:true instead of REJECTED.

  it('rejects a canonical-path tool whose project-tool rtkSummary.owningFile does not exist on disk (production-path 6q0y.12 threading)', async () => {
    // Emit a handle with a project-tool owningFile (.pi/project-tools/...) that does NOT
    // exist on disk under tempRoot (the projectRoot set via process.env).
    const nonExistentOwningFile = '.pi/project-tools/nonexistent_production_tool.ts';
    const script = `
const fs = require('fs');
const path = require('path');
const outputDir = process.env['${EnvVars.TOOL_OUTPUT_DIR}'];
const outputRoot = path.join(process.env['${EnvVars.PROJECT_ROOT}'], '.pi/tool-output');
const artifactPath = path.join(outputDir, 'result.json');
fs.writeFileSync(artifactPath, JSON.stringify({ ok: true }));
const handle = {
  schemaVersion: '${TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION}',
  toolName: 'canonical_fixture',
  invocationId: 'inv-prod-path-disk-check',
  runStatus: 'PASSED',
  semanticArtifactPath: artifactPath,
  toolOutputRoot: outputRoot,
  summaryMode: 'summary',
  rtkSummary: {
    schemaTypeName: 'NonexistentProductionToolRtkSummary',
    owningFile: '${nonExistentOwningFile}',
    summarySchemaVersion: '1.0.0',
    schemaHash: 'sha256:' + 'd'.repeat(64),
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'nonexistent-tool-output',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: { results: 10 },
    omissionSemantics: 'results beyond maximumCounts.results are omitted',
    summary: { resultCount: 1 },
  },
  admittedHarnessFingerprint: 'sha256:test-fingerprint',
  admittedExecutionBoundary: 'bead:bd-1/state:Planning/action:a1',
};
process.stdout.write(JSON.stringify({ evidenceHandle: handle, status: 'PASSED' }));
`;
    const tool = canonicalFixtureTool(script);

    // tempRoot is set as process.env[EnvVars.PROJECT_ROOT] in beforeEach.
    // The file .pi/project-tools/nonexistent_production_tool.ts does NOT exist there.
    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    // LOAD-BEARING: the on-disk existence check fires via projectRoot threading.
    // If projectRoot were NOT threaded, the evidenceHandle would pass (no disk check)
    // and result.status would be PASSED instead of REJECTED.
    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect((result as any).canonicalEvidenceErrors).toBeDefined();
    expect((result as any).canonicalEvidenceErrors.some(
      (e: string) => e.includes('owningFile') && (e.includes('does not exist') || e.includes('6q0y.12'))
    )).toBe(true);
  });

  it('accepts a canonical-path tool whose project-tool rtkSummary.owningFile EXISTS on disk (production-path 6q0y.12 threading)', async () => {
    // Create the owningFile on disk under tempRoot so the on-disk check passes.
    const existingOwningFile = '.pi/project-tools/real_production_tool.ts';
    const absOwningFile = `${tempRoot}/${existingOwningFile}`;
    fs.mkdirSync(`${tempRoot}/.pi/project-tools`, { recursive: true });
    fs.writeFileSync(absOwningFile, '// real project-tool stub\nexport {};\n', 'utf8');

    const script = `
const fs = require('fs');
const path = require('path');
const outputDir = process.env['${EnvVars.TOOL_OUTPUT_DIR}'];
const outputRoot = path.join(process.env['${EnvVars.PROJECT_ROOT}'], '.pi/tool-output');
const artifactPath = path.join(outputDir, 'result.json');
fs.writeFileSync(artifactPath, JSON.stringify({ ok: true }));
const handle = {
  schemaVersion: '${TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION}',
  toolName: 'canonical_fixture',
  invocationId: 'inv-prod-path-disk-check-ok',
  runStatus: 'PASSED',
  semanticArtifactPath: artifactPath,
  toolOutputRoot: outputRoot,
  summaryMode: 'summary',
  rtkSummary: {
    schemaTypeName: 'RealProductionToolRtkSummary',
    owningFile: '${existingOwningFile}',
    summarySchemaVersion: '1.0.0',
    schemaHash: 'sha256:' + 'e'.repeat(64),
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'real-tool-output',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: { results: 10 },
    omissionSemantics: 'results beyond maximumCounts.results are omitted',
    summary: { resultCount: 1 },
  },
  admittedHarnessFingerprint: 'sha256:test-fingerprint',
  admittedExecutionBoundary: 'bead:bd-1/state:Planning/action:a1',
};
process.stdout.write(JSON.stringify({ evidenceHandle: handle, status: 'PASSED' }));
`;
    const tool = canonicalFixtureTool(script);

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    // owningFile exists on disk — on-disk check passes; result is PASSED.
    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect((result as any).canonicalEvidenceErrors).toBeUndefined();
  });

  // ── Legacy (non-canonical) tools are completely unaffected ──
  // A tool that emits a non-JSON stdout (or JSON without evidenceHandle) stays
  // on the legacy path. This is the critical cerdiwen-safety property.

  it('does not apply canonical evidence checks to tools that emit no evidenceHandle (legacy path)', async () => {
    const script = `
// Legacy tool: prints structured JSON but no evidenceHandle field.
process.stdout.write(JSON.stringify({ tool: 'legacy_tool', status: 'PASSED', results: [1, 2, 3] }));
`;
    const tool: ProjectCommandToolConfig = {
      name: 'legacy_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', script],
      cwd: CwdMode.WORKTREE,
    };

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    // Legacy tool is accepted without canonical evidence checks.
    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect((result as any).canonicalEvidenceErrors).toBeUndefined();
  });
});
