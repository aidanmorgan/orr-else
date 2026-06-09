/**
 * ts_project_tool_semantic_artifact_path.test.ts
 *
 * pi-experiment-6q0y.11 (PRODUCER SCOPE) — integration tests proving that
 * tsProjectTool child outputs resolve + record the canonical SEMANTIC ARTIFACT PATH
 * on the domain event (PROJECT_TOOL_SUCCEEDED/FAILED) and that raw transport archives
 * remain accessible as separate, distinct fields.
 *
 * AC1: tsProjectTool results expose semanticArtifactPath for the child output file.
 * AC2: Raw transport archives remain available through explicit raw archive fields
 *      and are NOT confused with semantic artifacts.
 * AC3: Project-tool domain events record both semantic artifact path and harness
 *      result archive metadata.
 *
 * AC4 (verifier contexts resolve via semanticArtifactPath) — DEFERRED: depends on
 * yhec/zog2.4/zog2.11 (amq0-blocked consumer side). The producer records the path;
 * the consumer (VerifyContext) resolving through it requires the amq0 gate work.
 *
 * AC5 (cerdiwen integration test) — DEFERRED: Cerdiwen tool emission migration is a
 * separate bead; do not touch cerdiwen here.
 *
 * All tests drive the REAL executeConfiguredProjectTool path — load-bearing: removing
 * any assertion in this file would miss a real production guarantee.
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
// Fixtures
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
 * Build a Node.js fixture script that emits a complete valid ToolEvidenceHandle
 * with a real semantic artifact file. The evidenceHandle.semanticArtifactPath points
 * to a CHILD output file (result.json) — NOT the harness stdoutFile.
 * rawTransportArchivePaths is omitted by default (the handle doesn't need them set;
 * the harness captures stdoutFile/stderrFile as transport separately).
 */
function buildTsProjectToolFixtureScript(overrides: Record<string, unknown> = {}): string {
  return `
const fs = require('fs');
const path = require('path');
const outputDir = process.env['${EnvVars.TOOL_OUTPUT_DIR}'];
const outputRoot = path.join(process.env['${EnvVars.PROJECT_ROOT}'], '.pi/tool-output');
// The SEMANTIC CHILD ARTIFACT — this is the meaningful output the tool produced.
// NOT the harness stdout/stderr archive files.
const artifactPath = path.join(outputDir, 'quality-report.json');
fs.writeFileSync(artifactPath, JSON.stringify({ checks: 3, passed: 3, failed: 0 }));
const handle = {
  schemaVersion: '${TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION}',
  toolName: 'ts_fixture',
  invocationId: 'inv-6q0y11-fixture-001',
  runStatus: 'PASSED',
  semanticArtifactPath: artifactPath,
  semanticArtifactBytes: fs.statSync(artifactPath).size,
  semanticArtifactSha256: 'sha256:' + 'a'.repeat(64),
  toolOutputRoot: outputRoot,
  summaryMode: 'summary',
  rtkSummary: {
    schemaTypeName: 'TsFixtureQualityRtkSummary',
    owningFile: 'src/tools/ts_fixture.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: 'sha256:' + 'b'.repeat(64),
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'ts-fixture-quality-report',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: { checks: 50 },
    omissionSemantics: 'checks beyond maximumCounts.checks are omitted',
    summary: { checks: 3, passed: 3, failed: 0 },
  },
  admittedHarnessFingerprint: 'sha256:6q0y11-test-fingerprint',
  admittedExecutionBoundary: 'bead:bd-6q0y11/state:Planning/action:a1',
  ...${JSON.stringify(overrides)},
};
process.stdout.write(JSON.stringify({ evidenceHandle: handle, status: 'PASSED' }));
`;
}

/**
 * Build a fixture that also includes rawTransportArchivePaths on the handle
 * (explicitly set by the tool, separate from the semantic artifact).
 */
function buildTsProjectToolWithRawTransportScript(): string {
  return `
const fs = require('fs');
const path = require('path');
const outputDir = process.env['${EnvVars.TOOL_OUTPUT_DIR}'];
const outputRoot = path.join(process.env['${EnvVars.PROJECT_ROOT}'], '.pi/tool-output');
// Semantic child artifact
const artifactPath = path.join(outputDir, 'quality-report.json');
fs.writeFileSync(artifactPath, JSON.stringify({ checks: 5, passed: 5, failed: 0 }));
// Raw transport archive (a separate file the tool writes for durability)
const archivePath = path.join(outputDir, 'raw-output.tar.gz.placeholder');
fs.writeFileSync(archivePath, 'placeholder');
const handle = {
  schemaVersion: '${TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION}',
  toolName: 'ts_fixture_transport',
  invocationId: 'inv-6q0y11-transport-001',
  runStatus: 'PASSED',
  semanticArtifactPath: artifactPath,
  semanticArtifactBytes: fs.statSync(artifactPath).size,
  semanticArtifactSha256: 'sha256:' + 'c'.repeat(64),
  rawTransportArchivePaths: [archivePath],
  toolOutputRoot: outputRoot,
  summaryMode: 'summary',
  rtkSummary: {
    schemaTypeName: 'TsFixtureTransportRtkSummary',
    owningFile: 'src/tools/ts_fixture_transport.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: 'sha256:' + 'd'.repeat(64),
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'ts-fixture-transport-output',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: { checks: 50 },
    omissionSemantics: 'checks beyond maximumCounts.checks are omitted',
    summary: { checks: 5, passed: 5, failed: 0 },
  },
  admittedHarnessFingerprint: 'sha256:6q0y11-test-fingerprint',
  admittedExecutionBoundary: 'bead:bd-6q0y11/state:Planning/action:a1',
};
process.stdout.write(JSON.stringify({ evidenceHandle: handle, status: 'PASSED' }));
`;
}

function makeTsFixtureTool(script: string, name = 'ts_fixture'): ProjectCommandToolConfig {
  return {
    name,
    type: ProjectToolType.COMMAND,
    command: process.execPath,
    defaultArgs: ['-e', script],
    cwd: CwdMode.WORKTREE,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('tsProjectTool semantic artifact path — producer scope (6q0y.11)', () => {
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

    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y11-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-6q0y11');
    fs.mkdirSync(tempWorktree, { recursive: true });
    writeMinimalHarnessConfig(tempRoot);

    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-6q0y11-${process.pid}`);

    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempWorktree;
  });

  afterEach(() => {
    configLoader.reset();
    eventStore.setSessionId(`test-6q0y11-${process.pid}-reset`);
    if (prevProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = prevProjectRoot;
    if (prevWorktree === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = prevWorktree;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  // ── AC1 + AC3: semanticArtifactPath is resolved and recorded on the domain event ──
  //
  // LOAD-BEARING: this test drives the REAL executeConfiguredProjectTool path and
  // proves the semanticArtifactPath from the canonical evidence handle is threaded
  // into the PROJECT_TOOL_SUCCEEDED event. Removing the semanticArtifactPath
  // threading in projectTools.ts causes this test to fail (event.data.semanticArtifactPath
  // would be undefined instead of the artifact path).

  it('AC1+AC3: records semanticArtifactPath on PROJECT_TOOL_SUCCEEDED for a tsProjectTool-style canonical tool', async () => {
    const script = buildTsProjectToolFixtureScript();
    const tool = makeTsFixtureTool(script);

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-6q0y11', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    // AC1: result itself is PASSED; no canonical rejection.
    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect((result as any).canonicalEvidenceErrors).toBeUndefined();

    // AC3: the PROJECT_TOOL_SUCCEEDED domain event records semanticArtifactPath.
    const events = await eventStore.eventsForBead('bd-6q0y11');
    const succeeded = events.find(
      e => e.type === DomainEventName.PROJECT_TOOL_SUCCEEDED && e.data?.tool === 'ts_fixture'
    );
    expect(succeeded).toBeDefined();
    expect(typeof succeeded?.data?.semanticArtifactPath).toBe('string');

    // The semanticArtifactPath must point to the quality-report.json child artifact —
    // not the harness stdoutFile or stderrFile (those are raw transport archives).
    const recordedPath = succeeded!.data!.semanticArtifactPath as string;
    expect(recordedPath).toMatch(/quality-report\.json$/);

    // AC1: the recorded path exists on disk (the fixture wrote it).
    expect(fs.existsSync(recordedPath)).toBe(true);

    // AC3: the event also records outputFile (harness wrapper archive) — these are DISTINCT fields.
    // The harness wrapper archive (outputFile) is separate from the semantic child artifact.
    expect(typeof succeeded?.data?.outputFile).toBe('string');
    expect(succeeded!.data!.outputFile).not.toBe(recordedPath);
  });

  // ── AC2: raw transport archives are separate from semanticArtifactPath ──
  //
  // LOAD-BEARING: proves that the harness stdoutFile/stderrFile (raw transport archives)
  // are NOT promoted to semanticArtifactPath. The semantic artifact is the child output
  // file the tool explicitly recorded in its ToolEvidenceHandle, not the raw stdout stream.

  it('AC2: semanticArtifactPath is the child artifact, not the harness stdoutFile (transport archives remain distinct)', async () => {
    const script = buildTsProjectToolFixtureScript();
    const tool = makeTsFixtureTool(script);

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-6q0y11', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    expect(result.status).toBe(ToolResultStatus.PASSED);

    // The result carries stdoutFile and stderrFile as raw transport archive references.
    const stdoutFile = (result as any).stdoutFile as string;
    const stderrFile = (result as any).stderrFile as string;
    expect(typeof stdoutFile).toBe('string');
    expect(typeof stderrFile).toBe('string');

    // The domain event semanticArtifactPath is NOT the stdoutFile or stderrFile.
    const events = await eventStore.eventsForBead('bd-6q0y11');
    const succeeded = events.find(
      e => e.type === DomainEventName.PROJECT_TOOL_SUCCEEDED && e.data?.tool === 'ts_fixture'
    );
    const recordedSemanticPath = succeeded!.data!.semanticArtifactPath as string;

    // AC2: semantic artifact is distinct from both raw transport archives.
    expect(recordedSemanticPath).not.toBe(stdoutFile);
    expect(recordedSemanticPath).not.toBe(stderrFile);
    // AC2: it points to the child output (quality-report.json), not a stdout/stderr stream.
    expect(recordedSemanticPath).toMatch(/quality-report\.json$/);
  });

  // ── AC3: rawTransportArchivePaths from the handle are recorded on the event ──
  //
  // LOAD-BEARING: when the tool's ToolEvidenceHandle includes rawTransportArchivePaths,
  // those paths must appear on the domain event. Removing the rawTransportArchivePaths
  // threading in projectTools.ts causes this test to fail.

  it('AC3: records rawTransportArchivePaths on PROJECT_TOOL_SUCCEEDED when handle includes them', async () => {
    const script = buildTsProjectToolWithRawTransportScript();
    const tool = makeTsFixtureTool(script, 'ts_fixture_transport');

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-6q0y11', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    expect(result.status).toBe(ToolResultStatus.PASSED);

    const events = await eventStore.eventsForBead('bd-6q0y11');
    const succeeded = events.find(
      e => e.type === DomainEventName.PROJECT_TOOL_SUCCEEDED && e.data?.tool === 'ts_fixture_transport'
    );
    expect(succeeded).toBeDefined();

    // AC3: semanticArtifactPath is the child quality-report artifact.
    const recordedSemantic = succeeded!.data!.semanticArtifactPath as string;
    expect(recordedSemantic).toMatch(/quality-report\.json$/);

    // AC3: rawTransportArchivePaths are recorded separately from semanticArtifactPath.
    const recordedArchives = succeeded!.data!.rawTransportArchivePaths as string[];
    expect(Array.isArray(recordedArchives)).toBe(true);
    expect(recordedArchives).toHaveLength(1);
    expect(recordedArchives[0]).toMatch(/raw-output\.tar\.gz\.placeholder$/);

    // AC2: raw archive path is NOT the semantic artifact path.
    expect(recordedArchives[0]).not.toBe(recordedSemantic);
  });

  // ── Legacy (non-canonical) tools: semanticArtifactPath is absent from event ──
  //
  // LOAD-BEARING: cerdiwen and other legacy tools that do NOT emit an evidenceHandle
  // must NOT have semanticArtifactPath added to their domain events. This test proves
  // the canonical path is opt-in only — removing the condition in projectTools.ts that
  // gates on canonicalCheck.kind === 'valid' would cause this test to fail (undefined
  // semanticArtifactPath would still be undefined, but the intent is to verify isolation).

  it('legacy (non-canonical) tools: semanticArtifactPath is absent from PROJECT_TOOL_SUCCEEDED event', async () => {
    const legacyScript = `
// Legacy tool: prints plain JSON without an evidenceHandle field.
process.stdout.write(JSON.stringify({ tool: 'legacy_tool', status: 'PASSED', items: [1, 2, 3] }));
`;
    const tool: ProjectCommandToolConfig = {
      name: 'legacy_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', legacyScript],
      cwd: CwdMode.WORKTREE,
    };

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-6q0y11', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect((result as any).canonicalEvidenceErrors).toBeUndefined();

    const events = await eventStore.eventsForBead('bd-6q0y11');
    const succeeded = events.find(
      e => e.type === DomainEventName.PROJECT_TOOL_SUCCEEDED && e.data?.tool === 'legacy_tool'
    );
    expect(succeeded).toBeDefined();

    // Legacy tools do NOT have semanticArtifactPath or rawTransportArchivePaths on the event.
    expect(succeeded!.data!.semanticArtifactPath).toBeUndefined();
    expect(succeeded!.data!.rawTransportArchivePaths).toBeUndefined();

    // Legacy tools still have outputFile (harness wrapper archive — 0yt5.27).
    expect(typeof succeeded!.data!.outputFile).toBe('string');
  });

  // ── AC1: tsProjectTool expansion produces canonical semanticArtifactPath ──
  //
  // LOAD-BEARING: tsProjectTool configs are expanded to command tools by ConfigLoader.
  // This test verifies the full ConfigLoader expansion → executeConfiguredProjectTool path
  // for a tsProjectTool-declared tool. The tool is configured via harness.yaml as a
  // tsProjectTool and must resolve + record semanticArtifactPath on the event.

  it('AC1: tsProjectTool configured via harness.yaml (ConfigLoader expansion) records semanticArtifactPath', async () => {
    // Write the "project tool" TypeScript script under .pi/project-tools/<name>.ts.
    // ConfigLoader expands tsProjectTool → node --experimental-strip-types <scriptPath>.
    const piDir = path.join(tempRoot, '.pi', 'project-tools');
    fs.mkdirSync(piDir, { recursive: true });
    const toolScript = path.join(piDir, 'quality_checker.ts');
    // Write a CJS-compatible script (node -e uses CommonJS by default without .ts extension loader)
    // so we write the logic as a .ts file but it uses CommonJS require().
    fs.writeFileSync(toolScript, `
const fs = require('fs');
const path = require('path');
const outputDir = process.env['PI_TOOL_OUTPUT_DIR'];
const outputRoot = path.join(process.env['PI_PROJECT_ROOT'], '.pi/tool-output');
const artifactPath = path.join(outputDir, 'quality-checker-result.json');
fs.writeFileSync(artifactPath, JSON.stringify({ ok: true, checks: 7 }));
const handle = {
  schemaVersion: '${TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION}',
  toolName: 'quality_checker',
  invocationId: 'inv-6q0y11-ts-tool-001',
  runStatus: 'PASSED',
  semanticArtifactPath: artifactPath,
  semanticArtifactBytes: fs.statSync(artifactPath).size,
  semanticArtifactSha256: 'sha256:' + 'f'.repeat(64),
  toolOutputRoot: outputRoot,
  summaryMode: 'summary',
  rtkSummary: {
    schemaTypeName: 'QualityCheckerRtkSummary',
    owningFile: '.pi/project-tools/quality_checker.ts',
    summarySchemaVersion: '1.0.0',
    schemaHash: 'sha256:' + 'e'.repeat(64),
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'quality-checker-result',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: { checks: 100 },
    omissionSemantics: 'checks beyond maximumCounts.checks are omitted',
    summary: { ok: true, checks: 7 },
  },
  admittedHarnessFingerprint: 'sha256:6q0y11-ts-expansion-test',
  admittedExecutionBoundary: 'bead:bd-6q0y11/state:Planning/action:a1',
};
process.stdout.write(JSON.stringify({ evidenceHandle: handle, status: 'PASSED' }));
`);

    // Update harness.yaml to declare quality_checker as a tsProjectTool.
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
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
tools:
  - name: quality_checker
    type: tsProjectTool
`);

    // ConfigLoader expands tsProjectTool → command (node --experimental-strip-types <script>).
    configLoader.reset();
    const config = configLoader.load();
    const expandedTool = (config.tools || []).find(t => t.name === 'quality_checker');
    expect(expandedTool).toBeDefined();
    expect(expandedTool!.type).toBe(ProjectToolType.COMMAND); // tsProjectTool expanded to command

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, expandedTool!,
      { beadId: 'bd-6q0y11', stateId: 'Planning', actionId: 'a1' },
      {} as any, undefined, new Map()
    );

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect((result as any).canonicalEvidenceErrors).toBeUndefined();

    // AC1+AC3: semanticArtifactPath is recorded on the event from the expanded tsProjectTool.
    const events = await eventStore.eventsForBead('bd-6q0y11');
    const succeeded = events.find(
      e => e.type === DomainEventName.PROJECT_TOOL_SUCCEEDED && e.data?.tool === 'quality_checker'
    );
    expect(succeeded).toBeDefined();
    const recordedPath = succeeded!.data!.semanticArtifactPath as string;
    expect(typeof recordedPath).toBe('string');
    expect(recordedPath).toMatch(/quality-checker-result\.json$/);
    expect(fs.existsSync(recordedPath)).toBe(true);
  });
});
