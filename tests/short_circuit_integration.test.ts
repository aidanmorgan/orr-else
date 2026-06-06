/**
 * pi-experiment-zog2.16 — Genuine integration tests for short-circuit exit wiring.
 *
 * BLOCKING FINDING FIX: The existing tests/tool_result_recorder.test.ts only calls
 * recorder.recordShortCircuit() directly with hardcoded inputs. These tests drive the
 * REAL production exit paths and assert that:
 *   (a) emitted events carry toolResult.outputFile (TOOL_INVOCATION_FAILED) or
 *       top-level outputFile (PROJECT_TOOL_FAILED), AND
 *   (b) a real EventStore + runVerifierGate treats the tool as TOOL_REJECTED
 *       (invoked-but-failed, state 'failed') — not TOOL_NOT_INVOKED — and STILL BLOCKS.
 *
 * Each test would fail if the zog2.16 wiring were removed from the production code.
 *
 * Exit paths covered:
 *   1. wrapPluginTool validation rejection (checkToolValidationRules) — site 1
 *   2. wrapPluginTool circuit-breaker short-circuit — site 3
 *   3. executeConfiguredProjectTool deprecated-tool rejection — site 5
 *   4. preflightProjectTool extension-type rejection — site 6
 *
 * Verifier gate assertion (AC3): for the deprecated-tool case, we drive
 * runVerifierGate against a real EventStore that recorded the PROJECT_TOOL_FAILED
 * event and assert the gate reports TOOL_REJECTED (not TOOL_NOT_INVOKED) and blocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import orrElseExtension from '../src/extension.js';
import { EnvVars, ProcessFlag, PiEventName, DomainEventName, ToolResultStatus, ProjectToolType } from '../src/constants/index.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { ToolCallPathFactory } from '../src/core/ToolCallPathFactory.js';
import { executeConfiguredProjectTool } from '../src/plugins/projectTools.js';
import { runVerifierGate, VerifierGateBlockKind } from '../src/core/VerifierGate.js';
import { Logger } from '../src/core/Logger.js';
import type { ProjectCommandToolConfig } from '../src/core/domain/StateModels.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function fakePi() {
  const tools: any[] = [];
  const callbacks: Record<string, Function> = {};

  return {
    tools,
    callbacks,
    pi: {
      on: (name: string, callback: Function) => { callbacks[name] = callback; },
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: () => {},
      getActiveTools: () => [] as string[],
      setActiveTools: () => {},
      setThinkingLevel: () => {},
      setModel: async () => true,
      sendUserMessage: () => {},
    } as any,
  };
}

const HEADLESS_TOOL_CONTEXT = { hasUI: false, shutdown: () => {} } as any;

/** Read every JSONL event line from a project's .pi/events dir. */
function readEventStoreLines(projectRoot: string): Array<Record<string, unknown>> {
  const eventsDir = path.join(projectRoot, '.pi', 'events');
  if (!fs.existsSync(eventsDir)) return [];
  const files = fs.readdirSync(eventsDir).filter(f => f.endsWith('.jsonl'));
  const lines: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(eventsDir, file), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }
  return lines;
}

// ── Env save/restore helpers ──────────────────────────────────────────────────

function saveEnv(...keys: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ── Site 1: wrapPluginTool validation rejection ───────────────────────────────

describe('zog2.16 integration: wrapPluginTool validation-rejection carries toolResult.outputFile', () => {
  let tempRoot: string;
  let worktreePath: string;
  let savedEnv: Record<string, string | undefined>;
  let savedCwd: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    savedEnv = saveEnv(
      EnvVars.WORKER_MODE, EnvVars.BEAD_ID, EnvVars.STATE_ID,
      EnvVars.ACTION_ID, EnvVars.PROJECT_ROOT, EnvVars.WORKTREE_PATH,
    );
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zog2-16-validation-')));
    worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
  });

  afterEach(async () => {
    restoreEnv(savedEnv);
    process.chdir(savedCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('TOOL_INVOCATION_FAILED emitted by checkToolValidationRules carries toolResult.outputFile', async () => {
    // harness.yaml: prerequisite_tool must be called before guarded_tool (validationRules)
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
tools:
  - name: prerequisite_tool
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'prerequisite_tool', status: 'PASSED' }));"
  - name: guarded_tool
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'guarded_tool', status: 'PASSED' }));"
    validationRules:
      - tool: prerequisite_tool
        condition: called
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);

    // Ensure the log dir exists to prevent Logger ENOENT during async teardown
    fs.mkdirSync(path.join(tempRoot, '.pi', 'logs'), { recursive: true });

    process.chdir(tempRoot);
    process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
    process.env[EnvVars.BEAD_ID] = 'bd-validation-rejection';
    process.env[EnvVars.STATE_ID] = 'Planning';
    process.env[EnvVars.ACTION_ID] = 'formulate-plan';
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = worktreePath;

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
    await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

    const guardedTool = harness.tools.find((t: any) => t.name === 'guarded_tool');
    expect(guardedTool).toBeDefined();

    // Invoke guarded_tool WITHOUT calling prerequisite_tool first → validation rejection
    const result = await guardedTool.execute('guarded-call', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);

    // Model-facing output is unchanged (a rejection string returned to the model)
    expect(typeof result === 'string' || (result && typeof result === 'object')).toBe(true);

    await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
    await new Promise(r => setTimeout(r, 50));
    Logger.close();

    // AC1: the TOOL_INVOCATION_FAILED event must carry toolResult.outputFile
    const events = readEventStoreLines(tempRoot);
    const failedEvent = events.find(
      (e: any) => e.type === DomainEventName.TOOL_INVOCATION_FAILED
        && e.data?.tool === 'guarded_tool'
    );
    expect(failedEvent).toBeDefined();

    const toolResult = (failedEvent as any).data?.toolResult;
    expect(toolResult).toBeDefined();
    expect(typeof toolResult.outputFile).toBe('string');
    expect(toolResult.outputFile.length).toBeGreaterThan(0);
    expect(fs.existsSync(toolResult.outputFile)).toBe(true);
    expect(toolResult.status).toBe(ToolResultStatus.REJECTED);

    // The artifact on disk must contain the expected fields (AC2)
    const artifact = JSON.parse(fs.readFileSync(toolResult.outputFile, 'utf8'));
    expect(artifact.status).toBe(ToolResultStatus.REJECTED);
    expect(artifact.failureCategory).toBe('INPUT');
    expect(artifact.schemaId).toContain('short-circuit-failure-artifact');
    expect(artifact.rejectionReason).toContain('PROTOCOL VIOLATION');
  });
});

// ── Site 3: wrapPluginTool circuit-breaker short-circuit ──────────────────────

describe('zog2.16 integration: wrapPluginTool circuit-breaker carries toolResult.outputFile', () => {
  let tempRoot: string;
  let worktreePath: string;
  let savedEnv: Record<string, string | undefined>;
  let savedCwd: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    savedEnv = saveEnv(
      EnvVars.WORKER_MODE, EnvVars.BEAD_ID, EnvVars.STATE_ID,
      EnvVars.ACTION_ID, EnvVars.PROJECT_ROOT, EnvVars.WORKTREE_PATH,
    );
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zog2-16-circuit-breaker-')));
    worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
  });

  afterEach(async () => {
    restoreEnv(savedEnv);
    process.chdir(savedCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('TOOL_INVOCATION_FAILED emitted by circuit-breaker carries toolResult.outputFile', async () => {
    // The default maxConsecutiveFailures is 3. The tool must fail 3 consecutive times
    // so the 4th call hits the open breaker and produces the short-circuit event.
    // Note: maxConsecutiveFailures is not in the harness.yaml schema, so we use
    // the default of 3 instead of overriding it.
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
tools:
  - name: flaky_verifier
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'flaky_verifier', status: 'REJECTED' })); process.exit(1);"
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    // Ensure the log dir exists to prevent Logger ENOENT during async teardown
    fs.mkdirSync(path.join(tempRoot, '.pi', 'logs'), { recursive: true });

    process.chdir(tempRoot);
    process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
    process.env[EnvVars.BEAD_ID] = 'bd-circuit-breaker';
    process.env[EnvVars.STATE_ID] = 'Planning';
    process.env[EnvVars.ACTION_ID] = 'formulate-plan';
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = worktreePath;

    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
    await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

    const flakyTool = harness.tools.find((t: any) => t.name === 'flaky_verifier');
    expect(flakyTool).toBeDefined();

    // Exhaust the default maxConsecutiveFailures (3): each call runs the tool and fails
    await flakyTool.execute('fail-1', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
    await flakyTool.execute('fail-2', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
    await flakyTool.execute('fail-3', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
    // 4th call: breaker is now open → short-circuit (no actual tool execution)
    await flakyTool.execute('circuit-open', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);

    await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
    await new Promise(r => setTimeout(r, 50));
    Logger.close();

    const events = readEventStoreLines(tempRoot);
    // The circuit-open event has reason 'circuit-open' in the result field
    const circuitEvent = events.find(
      (e: any) =>
        e.type === DomainEventName.TOOL_INVOCATION_FAILED
        && e.data?.tool === 'flaky_verifier'
        && e.data?.result?.reason === 'circuit-open'
    );
    expect(circuitEvent).toBeDefined();

    // AC1: toolResult.outputFile must be present and non-empty
    const toolResult = (circuitEvent as any).data?.toolResult;
    expect(toolResult).toBeDefined();
    expect(typeof toolResult.outputFile).toBe('string');
    expect(toolResult.outputFile.length).toBeGreaterThan(0);
    expect(fs.existsSync(toolResult.outputFile)).toBe(true);
    expect(toolResult.status).toBe(ToolResultStatus.REJECTED);
    expect(toolResult.failureCategory).toBe('INFRA');

    // Artifact on disk: required fields (AC2)
    const artifact = JSON.parse(fs.readFileSync(toolResult.outputFile, 'utf8'));
    expect(artifact.status).toBe(ToolResultStatus.REJECTED);
    expect(artifact.rejectionReason).toContain('circuit open');
    expect(artifact.schemaId).toContain('short-circuit-failure-artifact');
  });
});

// ── Site 5: deprecated-tool rejection + verifier gate TOOL_REJECTED (AC3) ────

describe('zog2.16 integration: deprecated-tool rejection carries outputFile + verifier sees TOOL_REJECTED', () => {
  let tempRoot: string;
  let tempWorktree: string;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let toolCallPathFactory: ToolCallPathFactory;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv(EnvVars.PROJECT_ROOT, EnvVars.WORKTREE_PATH);
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zog2-16-deprecated-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-depr-1');
    fs.mkdirSync(tempWorktree, { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-depr-${process.pid}`);
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempWorktree;
  });

  afterEach(() => {
    configLoader.reset();
    restoreEnv(savedEnv);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('PROJECT_TOOL_FAILED for deprecated tool carries top-level outputFile', async () => {
    const deprecatedTool: ProjectCommandToolConfig & { deprecated: boolean; deprecationReason: string } = {
      name: 'old_verifier',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stdout.write("should never run");'],
      deprecated: true,
      deprecationReason: 'replaced by new_verifier',
    };

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, deprecatedTool,
      { beadId: 'bd-depr-1', stateId: 'Planning', actionId: 'analyze' },
      {} as any, undefined, new Map(), tempRoot,
    );

    // Model-facing result: REJECTED with a message
    expect((result as any).status).toBe(ToolResultStatus.REJECTED);
    expect((result as any).message).toContain('deprecated');

    // AC1: PROJECT_TOOL_FAILED event must carry top-level outputFile
    const events = await eventStore.eventsForBead('bd-depr-1');
    const failedEvent = events.find(
      e => e.type === DomainEventName.PROJECT_TOOL_FAILED && e.data?.tool === 'old_verifier'
    );
    expect(failedEvent).toBeDefined();
    expect(typeof failedEvent!.data.outputFile).toBe('string');
    expect(failedEvent!.data.outputFile.length).toBeGreaterThan(0);
    expect(fs.existsSync(failedEvent!.data.outputFile as string)).toBe(true);

    // AC2: artifact fields
    const artifact = JSON.parse(fs.readFileSync(failedEvent!.data.outputFile as string, 'utf8'));
    expect(artifact.status).toBe(ToolResultStatus.REJECTED);
    expect(artifact.failureCategory).toBe('INPUT');
    expect(artifact.schemaId).toContain('short-circuit-failure-artifact');
  });

  // AC3: verifier gate must see TOOL_REJECTED (not TOOL_NOT_INVOKED) and STILL BLOCK
  it('runVerifierGate reports TOOL_REJECTED for deprecated-tool rejection and blocks (AC3)', async () => {
    const deprecatedTool: ProjectCommandToolConfig & { deprecated: boolean } = {
      name: 'gated_old_verifier',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stdout.write("should never run");'],
      deprecated: true,
    };

    await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, deprecatedTool,
      { beadId: 'bd-depr-1', stateId: 'Planning', actionId: 'audit' },
      {} as any, undefined, new Map(), tempRoot,
    );

    // Give the async eventStore record calls time to flush
    await new Promise(r => setTimeout(r, 20));

    // runVerifierGate against the real EventStore — the event recorded above must
    // make the gate see TOOL_REJECTED, not TOOL_NOT_INVOKED, and block.
    const gateResult = await runVerifierGate(
      { beadId: 'bd-depr-1', stateId: 'Planning', actionId: 'audit', writeSet: [], artifacts: {} },
      ['gated_old_verifier'],
      eventStore,
    );

    expect(gateResult.pass).toBe(false);
    expect(gateResult.failures).toHaveLength(1);
    // The gate must NOT treat the tool as never-invoked — it WAS invoked but rejected
    expect(gateResult.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_REJECTED);
    expect(gateResult.failures[0].tool).toBe('gated_old_verifier');
    // Verifier gate blocks (does not satisfy requiredTools presence check)
    expect(gateResult.pass).toBe(false);
  });
});

// ── Site 6: extension-type preflight rejection carries outputFile ─────────────

describe('zog2.16 integration: extension-type preflight rejection carries top-level outputFile', () => {
  let tempRoot: string;
  let tempWorktree: string;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let toolCallPathFactory: ToolCallPathFactory;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv(EnvVars.PROJECT_ROOT, EnvVars.WORKTREE_PATH);
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zog2-16-extension-type-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-ext-1');
    fs.mkdirSync(tempWorktree, { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-ext-${process.pid}`);
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempWorktree;
  });

  afterEach(() => {
    configLoader.reset();
    restoreEnv(savedEnv);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('PROJECT_TOOL_FAILED for extension-type tool carries top-level outputFile', async () => {
    const extensionTool = {
      name: 'native_symbol_index',
      type: ProjectToolType.EXTENSION,
    } as any;

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, extensionTool,
      { beadId: 'bd-ext-1', stateId: 'Planning', actionId: 'check' },
      {} as any, undefined, new Map(), tempRoot,
    );

    // Model-facing result: REJECTED with an explanatory message
    expect((result as any).status).toBe(ToolResultStatus.REJECTED);
    expect((result as any).message).toContain('cannot be executed directly');

    // AC1: PROJECT_TOOL_FAILED event must carry top-level outputFile
    const events = await eventStore.eventsForBead('bd-ext-1');
    const failedEvent = events.find(
      e => e.type === DomainEventName.PROJECT_TOOL_FAILED && e.data?.tool === 'native_symbol_index'
    );
    expect(failedEvent).toBeDefined();
    expect(typeof failedEvent!.data.outputFile).toBe('string');
    expect(failedEvent!.data.outputFile.length).toBeGreaterThan(0);
    expect(fs.existsSync(failedEvent!.data.outputFile as string)).toBe(true);
    expect(failedEvent!.data.failureCategory ?? (failedEvent!.data.result as any)?.failureCategory)
      .toBeTruthy();

    // AC2: artifact on disk has required fields
    const artifact = JSON.parse(fs.readFileSync(failedEvent!.data.outputFile as string, 'utf8'));
    expect(artifact.status).toBe(ToolResultStatus.REJECTED);
    expect(artifact.failureCategory).toBe('INFRA');
    expect(artifact.schemaId).toContain('short-circuit-failure-artifact');
    expect(artifact.rejectionReason).toContain('cannot be executed directly');
  });

  // AC3: verifier gate sees TOOL_REJECTED for extension-type and blocks
  it('runVerifierGate reports TOOL_REJECTED for extension-type rejection and blocks (AC3)', async () => {
    const extensionTool = {
      name: 'gated_extension_tool',
      type: ProjectToolType.EXTENSION,
    } as any;

    await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, extensionTool,
      { beadId: 'bd-ext-1', stateId: 'Planning', actionId: 'gate-check' },
      {} as any, undefined, new Map(), tempRoot,
    );

    await new Promise(r => setTimeout(r, 20));

    const gateResult = await runVerifierGate(
      { beadId: 'bd-ext-1', stateId: 'Planning', actionId: 'gate-check', writeSet: [], artifacts: {} },
      ['gated_extension_tool'],
      eventStore,
    );

    expect(gateResult.pass).toBe(false);
    expect(gateResult.failures).toHaveLength(1);
    expect(gateResult.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_REJECTED);
    expect(gateResult.failures[0].tool).toBe('gated_extension_tool');
  });
});
