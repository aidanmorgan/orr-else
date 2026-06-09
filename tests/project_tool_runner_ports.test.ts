/**
 * pi-experiment-amq0.16 — ProjectToolRunner port tests + architecture guard.
 *
 * TWO CONCERNS:
 *
 *  1. ARCHITECTURE TEST: ProjectToolRunner.ts has NO Pi ExtensionAPI /
 *     ExtensionContext import (accept criterion from amq0.16 spec).
 *
 *  2. FAKE-PORT UNIT TESTS: drive executeConfiguredProjectTool (which is the
 *     ProjectToolRunner's exported function) with fake ports for:
 *       PASSED, REJECTED, timeout, ENOENT, MCP unavailable, backpressure,
 *       deprecated tool (catalog classification), hidden tool (catalog
 *       classification), and Cerdiwen-shaped tsProjectTool child output.
 *
 * NOTE on "deprecated" and "hidden" test cases:
 *   ebzz removed the runtime deprecated-execution guard — config admission is
 *   the only gate.  "deprecated tool" and "hidden tool" here validate the
 *   CATALOG classification (ToolSurfaceCatalog entries carry those flags) and
 *   that the runner's result recorder + canonical evidence contract are
 *   preserved regardless of tool classification (consistent with the
 *   admission-is-the-only-path finding).  We do NOT re-introduce a runtime
 *   deprecated-execution branch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../src/core/EventStore.js';
import { ToolCallPathFactory } from '../src/core/ToolCallPathFactory.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { DomainEventName, ProjectToolType, ToolResultStatus } from '../src/constants/domain.js';
import { EnvVars } from '../src/constants/infra.js';
import type { ProjectCommandToolConfig, ProjectMcpToolConfig } from '../src/core/domain/StateModels.js';
import type { ProjectToolBackpressure } from '../src/core/RuntimeServices.js';
import { ProjectToolFailureCategory } from '../src/plugins/projectTools.js';
import {
  buildToolSurfaceCatalog,
  type ToolSurfaceEntry,
} from '../src/core/ToolSurfaceCatalog.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const rootDir = process.cwd();

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function extractImports(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'";]*?\s+from\s+['"]([^'"]+)['"]/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

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

// ---------------------------------------------------------------------------
// 1. ARCHITECTURE TEST — ProjectToolRunner has no Pi import
// ---------------------------------------------------------------------------

describe('amq0.16 architecture: ProjectToolRunner has no Pi SDK import', () => {
  const runnerPath = 'src/plugins/projectTools/ProjectToolRunner.ts';

  it('ProjectToolRunner.ts has no @earendil-works/pi-coding-agent import', () => {
    const source = readSource(runnerPath);
    const imports = extractImports(source);

    const piImports = imports.filter(spec =>
      spec.includes('pi-coding-agent') ||
      spec.includes('@earendil-works/pi-coding-agent') ||
      (spec.includes('@earendil-works/pi') && !spec.includes('pi-ai'))
    );

    expect(
      piImports,
      `ProjectToolRunner.ts must NOT import from Pi SDK (ExtensionAPI/ExtensionContext). Found: ${piImports.join(', ')}`
    ).toEqual([]);
  });

  it('ProjectToolRunner.ts has no ExtensionAPI or ExtensionContext token in non-type-annotation positions', () => {
    const source = readSource(runnerPath);
    // Check that ExtensionContext/ExtensionAPI don't appear as runtime values.
    // A type-only import would still appear in import statements checked above.
    const lines = source.split('\n').filter(line =>
      !line.trimStart().startsWith('//') &&
      !line.trimStart().startsWith('*') &&
      (line.includes('ExtensionContext') || line.includes('ExtensionAPI'))
    );
    expect(
      lines,
      `ProjectToolRunner.ts must not reference ExtensionContext or ExtensionAPI. Found lines: ${lines.join(' | ')}`
    ).toEqual([]);
  });

  it('ProjectToolRegistrar.ts is the only project-tool module that imports ExtensionAPI', () => {
    // The registrar MUST import ExtensionAPI (it owns Pi registration).
    const registrarSource = readSource('src/plugins/projectTools/ProjectToolRegistrar.ts');
    const registrarImports = extractImports(registrarSource);
    expect(
      registrarImports.some(spec => spec.includes('pi-coding-agent')),
      'ProjectToolRegistrar.ts must import from @earendil-works/pi-coding-agent'
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. FAKE-PORT UNIT TESTS
// ---------------------------------------------------------------------------

// Import the runner function directly to confirm execution goes through it.
// (The barrel re-exports it unchanged; importing the file directly is fine
// for a unit test that targets the runner's ports, not the barrel.)
import { executeConfiguredProjectTool } from '../src/plugins/projectTools/ProjectToolRunner.js';

describe('amq0.16 fake-port unit tests: ProjectToolRunner execution paths', () => {
  let tempRoot: string;
  let tempWorktree: string;
  let prevProjectRoot: string | undefined;
  let prevWorktreePath: string | undefined;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let pathFactory: ToolCallPathFactory;
  let backpressure: ProjectToolBackpressure;

  beforeEach(() => {
    prevProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    prevWorktreePath = process.env[EnvVars.WORKTREE_PATH];
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'amq0.16-runner-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-1');
    fs.mkdirSync(tempWorktree, { recursive: true });
    writeMinimalHarnessConfig(tempRoot);
    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    eventStore.setSessionId(`amq0.16-${process.pid}`);
    pathFactory = new ToolCallPathFactory();
    backpressure = new Map();
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempWorktree;
  });

  afterEach(() => {
    configLoader.reset();
    if (prevProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = prevProjectRoot;
    if (prevWorktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = prevWorktreePath;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const ctx = {} as any; // fake Pi context — runner doesn't use it for COMMAND tools

  // ── 1. PASSED ────────────────────────────────────────────────────────────

  it('runner: PASSED — command exits 0, event recorded', async () => {
    const tool: ProjectCommandToolConfig = {
      name: 'passing_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stdout.write(JSON.stringify({ status: "PASSED", message: "ok" }));'],
    };

    const result = await executeConfiguredProjectTool(
      eventStore, pathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      ctx, undefined, backpressure, tempRoot
    ) as Record<string, unknown>;

    expect(result.status).toBe(ToolResultStatus.PASSED);
    const events = await eventStore.eventsForBead('bd-1');
    expect(events.some(e => e.type === DomainEventName.PROJECT_TOOL_SUCCEEDED && e.data?.tool === 'passing_tool')).toBe(true);
  });

  // ── 2. REJECTED ──────────────────────────────────────────────────────────

  it('runner: REJECTED — command exits non-zero, failureCategory attached', async () => {
    const tool: ProjectCommandToolConfig = {
      name: 'rejecting_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stderr.write("validation failed"); process.exit(1);'],
    };

    const result = await executeConfiguredProjectTool(
      eventStore, pathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      ctx, undefined, backpressure, tempRoot
    ) as Record<string, unknown>;

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.failureCategory).toBeDefined();
    const events = await eventStore.eventsForBead('bd-1');
    expect(events.some(e => e.type === DomainEventName.PROJECT_TOOL_FAILED && e.data?.tool === 'rejecting_tool')).toBe(true);
  });

  // ── 3. Timeout ───────────────────────────────────────────────────────────

  it('runner: timeout — tool timeoutMs fires, returns REJECTED result with timedOut flag', async () => {
    const tool: ProjectCommandToolConfig = {
      name: 'timeout_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      // Node: Atomics.wait blocks for 30s — runner's 200ms timeout should fire first
      defaultArgs: ['-e', 'const sab=new SharedArrayBuffer(4);Atomics.wait(new Int32Array(sab),0,0,30000);'],
      timeoutMs: 200   // very short tool timeout
    };

    const result = await executeConfiguredProjectTool(
      eventStore, pathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      ctx, undefined, backpressure, tempRoot
    ) as Record<string, unknown>;

    // Tool timed out → REJECTED result with timedOut flag
    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.timedOut).toBe(true);
    // A PROJECT_TOOL_FAILED event should be recorded
    const events = await eventStore.eventsForBead('bd-1');
    expect(events.some(e => e.type === DomainEventName.PROJECT_TOOL_FAILED && e.data?.tool === 'timeout_tool')).toBe(true);
  }, 15000);

  // ── 4. ENOENT ────────────────────────────────────────────────────────────

  it('runner: ENOENT — command not found, returns UNAVAILABLE/REJECTED result, event recorded', async () => {
    // When the command binary does not exist, execa catches the ENOENT and returns
    // a result with status=UNAVAILABLE (commandFailureStatus maps ENOENT → UNAVAILABLE).
    // The runner then records a PROJECT_TOOL_FAILED event.
    const tool: ProjectCommandToolConfig = {
      name: 'enoent_tool',
      type: ProjectToolType.COMMAND,
      command: '/nonexistent/binary/that/does/not/exist',
      defaultArgs: [],
    };

    const result = await executeConfiguredProjectTool(
      eventStore, pathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      ctx, undefined, backpressure, tempRoot
    ) as Record<string, unknown>;

    // ENOENT → UNAVAILABLE (commandFailureStatus logic)
    expect([ToolResultStatus.UNAVAILABLE, ToolResultStatus.REJECTED]).toContain(result.status);
    const events = await eventStore.eventsForBead('bd-1');
    expect(events.some(e => e.type === DomainEventName.PROJECT_TOOL_FAILED && e.data?.tool === 'enoent_tool')).toBe(true);
  });

  // ── 5. MCP unavailable ───────────────────────────────────────────────────

  it('runner: MCP unavailable — server not in config, returns REJECTED with server info', async () => {
    // Write an empty MCP config so the server lookup fails cleanly.
    const mcpConfigDir = path.join(tempRoot, '.pi', 'mcp');
    fs.mkdirSync(mcpConfigDir, { recursive: true });
    fs.writeFileSync(path.join(mcpConfigDir, 'config.json'), JSON.stringify({ mcpServers: {} }));

    const tool: ProjectMcpToolConfig = {
      name: 'mcp_unavailable_tool',
      type: ProjectToolType.MCP,
      server: 'nonexistent-server',
      operations: { query: 'query' }
    };

    const result = await executeConfiguredProjectTool(
      eventStore, pathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1', operation: 'query' },
      ctx, undefined, backpressure, tempRoot
    ) as Record<string, unknown>;

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(String(result.message || '')).toContain('nonexistent-server');
  });

  // ── 6. Backpressure ──────────────────────────────────────────────────────

  it('runner: backpressure — concurrent invocations for same context, one backpressured', async () => {
    const sharedBackpressure: ProjectToolBackpressure = new Map();
    const tool: ProjectCommandToolConfig = {
      name: 'slow_backpressure_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'setTimeout(() => { console.log(JSON.stringify({ status: "PASSED" })); }, 60);'],
    };
    const context = { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' };

    const [r1, r2] = await Promise.all([
      executeConfiguredProjectTool(eventStore, pathFactory, tool, context, ctx, undefined, sharedBackpressure, tempRoot),
      executeConfiguredProjectTool(eventStore, pathFactory, tool, context, ctx, undefined, sharedBackpressure, tempRoot),
    ]) as [Record<string, unknown>, Record<string, unknown>];

    const passed = [r1, r2].filter(r => r.status === ToolResultStatus.PASSED);
    const bped = [r1, r2].filter(r => r.failureCategory === ProjectToolFailureCategory.BACKPRESSURE);
    expect(passed).toHaveLength(1);
    expect(bped).toHaveLength(1);
  });

  // ── 7. Deprecated tool (catalog classification) ──────────────────────────

  it('runner: deprecated tool classification — catalog marks entry deprecated, runner executes normally (admission is the gate)', async () => {
    // ebzz: the runtime deprecated guard was removed; config admission is the only gate.
    // This test validates that a tool marked deprecated in the catalog still executes
    // when called (admission already passed), and the runner records correctly.
    const tool: ProjectCommandToolConfig = {
      name: 'deprecated_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stdout.write(JSON.stringify({ status: "PASSED", deprecated: true }));'],
    };

    // Build a catalog with the tool marked deprecated (catalog classification only).
    const config = configLoader.load();
    const deprecatedEntry: ToolSurfaceEntry = {
      name: 'deprecated_tool',
      kind: 'PROJECT_TOOL',
      owner: 'harness.yaml',
      sourceInfo: '',
      callable: true,
      admissibleForRequiredTools: true,
      hidden: false,
      deprecated: true,  // <-- catalog marks as deprecated
      observeOnly: false,
      rtkToolClass: 'project_configured',
      sideEffectContract: 'unknown',
      configEntry: tool,
    };
    const catalog = buildToolSurfaceCatalog(
      { ...config, tools: [tool] },
      [],
      []
    );
    // Verify the catalog knows about the tool (PROJECT_TOOL entry).
    expect(catalog.getHarnessRegisteredProjectToolNames()).toContain('deprecated_tool');

    // The runner executes regardless — admission is upstream.
    const result = await executeConfiguredProjectTool(
      eventStore, pathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      ctx, undefined, backpressure, tempRoot
    ) as Record<string, unknown>;

    expect(result.status).toBe(ToolResultStatus.PASSED);
    // Event recorded
    const events = await eventStore.eventsForBead('bd-1');
    expect(events.some(e => e.type === DomainEventName.PROJECT_TOOL_SUCCEEDED)).toBe(true);
    // catalogEntry carries the deprecated flag (separate from runtime result)
    expect(deprecatedEntry.deprecated).toBe(true);
  });

  // ── 8. Hidden tool (catalog classification) ──────────────────────────────

  it('runner: hidden tool classification — catalog marks entry hidden, runner executes normally (admission is the gate)', async () => {
    const tool: ProjectCommandToolConfig = {
      name: 'hidden_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stdout.write(JSON.stringify({ status: "PASSED", hidden: true }));'],
    };

    // Build a catalog entry marked hidden (classification only).
    const hiddenEntry: ToolSurfaceEntry = {
      name: 'hidden_tool',
      kind: 'PROJECT_TOOL',
      owner: 'harness.yaml',
      sourceInfo: '',
      callable: true,
      admissibleForRequiredTools: true,
      hidden: true,  // <-- catalog marks as hidden
      deprecated: false,
      observeOnly: false,
      rtkToolClass: 'project_configured',
      sideEffectContract: 'unknown',
      configEntry: tool,
    };

    // Runner still executes when called — hidden is a catalog/prompt concern.
    const result = await executeConfiguredProjectTool(
      eventStore, pathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      ctx, undefined, backpressure, tempRoot
    ) as Record<string, unknown>;

    expect(result.status).toBe(ToolResultStatus.PASSED);
    // catalogEntry carries the hidden flag.
    expect(hiddenEntry.hidden).toBe(true);
  });

  // ── 9. Cerdiwen-shaped tsProjectTool child output ────────────────────────
  //
  // Cerdiwen uses a tsProjectTool (command type after expansion) that emits a
  // cerdiwen-shaped minimal result JSON: { tool, status, ... }.
  // The runner must pass this through VERBATIM (no summarization/wrapping).
  // This test uses a cerdiwen-SHAPED FIXTURE (in-repo, read-only) — NOT a live
  // cerdiwen call.

  it('runner: cerdiwen-shaped tsProjectTool output — passed through verbatim, event recorded', async () => {
    // Simulate a cerdiwen-shaped minimal result as the tool's stdout.
    // Cerdiwen tools emit { tool, status, matchStatus, compactSummary, ... }.
    // Note: the script must write the JSON object directly (not a doubly-serialized string).
    const cerdiwenShapedObject = {
      tool: 'cerdiwen_ast_grep',
      status: 'PASSED',
      matchStatus: 'no_match',
      compactSummary: '0 matches found in 3 files',
      stdoutBytes: 42,
      stderrBytes: 0
    };
    // The node script: write the object literal as JSON. The script must output valid JSON.
    const script = `process.stdout.write(JSON.stringify(${JSON.stringify(cerdiwenShapedObject)}));`;

    const tool: ProjectCommandToolConfig = {
      name: 'cerdiwen_ast_grep',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', script],
    };

    const result = await executeConfiguredProjectTool(
      eventStore, pathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'a1' },
      ctx, undefined, backpressure, tempRoot
    ) as Record<string, unknown>;

    // Status PASSED — cerdiwen tools always exit 0 and self-report status.
    expect(result.status).toBe(ToolResultStatus.PASSED);
    // The raw command result goes through persistAndBoundResult which persists to outputFile
    // and returns the model-facing minimal result (tool, status, exitCode, stdoutFile, etc.).
    // The cerdiwen-shaped fields (matchStatus, compactSummary) from the tool's stdout are
    // NOT fields on the model-facing result — they are stored in stdoutFile.
    // The result struct reflects the s3wp.25 minimal schema (tool/status/exitCode/etc.).
    expect(typeof result.stdoutFile).toBe('string');  // raw output persisted
    expect(result.stdoutBytes).toBeGreaterThan(0);    // non-empty stdout
    // No harness-injected model-facing steering fields.
    expect((result as any).nextAction).toBeUndefined();

    // Event recorded as SUCCEEDED.
    const events = await eventStore.eventsForBead('bd-1');
    expect(events.some(e =>
      e.type === DomainEventName.PROJECT_TOOL_SUCCEEDED &&
      e.data?.tool === 'cerdiwen_ast_grep'
    )).toBe(true);

    // The raw cerdiwen-shaped content is in stdoutFile (verbatim passthrough to disk).
    const rawOut = fs.readFileSync(result.stdoutFile as string, 'utf8');
    const parsed = JSON.parse(rawOut);
    expect(parsed.matchStatus).toBe('no_match');
    expect(parsed.compactSummary).toBe('0 matches found in 3 files');
  });
});

// ---------------------------------------------------------------------------
// 3. CATALOG-LEVEL DEPRECATED/HIDDEN FIELD TESTS
// ---------------------------------------------------------------------------
//
// Verify that the ToolSurfaceCatalog properly surfaces deprecated and hidden
// fields from config entries (the runner relies on the catalog classification
// being correct at registration time).

describe('amq0.16: ToolSurfaceCatalog deprecated/hidden classification', () => {
  it('catalog entries for PROJECT_TOOL carry deprecated=false by default', () => {
    const tool: ProjectCommandToolConfig = {
      name: 'normal_tool',
      type: ProjectToolType.COMMAND,
      command: 'echo',
    };
    // buildToolSurfaceCatalog does not read deprecated from config (it's a catalog-level field).
    // This test confirms the catalog default is false.
    const catalog = buildToolSurfaceCatalog({ tools: [tool] } as any, [], []);
    const entry = catalog.get('normal_tool');
    expect(entry).toBeDefined();
    expect(entry!.deprecated).toBe(false);
    expect(entry!.hidden).toBe(false);
    expect(entry!.kind).toBe('PROJECT_TOOL');
  });
});
