/**
 * pi-experiment-0yt5.27 acceptance tests.
 *
 * Binding deliverable (per the bead NOTES, which supersede the description ACs):
 *  - Each tool invocation writes its raw output to a PER-INVOCATION-UNIQUE-LEAF,
 *    PROJECT-scoped path under {PROJECT_ROOT}/.pi/tool-output/{bead}/{state}/{action}/{tool}/…
 *    resolved against PROJECT_ROOT (NOT WORKTREE_PATH) so the COORDINATOR-only gate
 *    (running at PROJECT_ROOT, a different cwd than the worker's WORKTREE_PATH) can
 *    read worker-produced outputs.
 *  - There is ONE harness-dictated location: no double-persist across .pi/tool-output
 *    AND .tmp/tool-calls.
 *  - Every tool-result event carries status (+ outputFile); the LATEST event per
 *    (bead,state,action,tool) is what the gate reads (freshness on retry).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { ToolCallPathFactory } from '../src/core/ToolCallPathFactory.js';
import { BuiltInToolName, CwdMode, DomainEventName, ProjectToolType, ToolResultStatus } from '../src/constants/domain.js';
import { EnvVars, PiEventName } from '../src/constants/infra.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';
import type { ProjectCommandToolConfig } from '../src/core/domain/StateModels.js';
import { executeConfiguredProjectTool } from '../src/plugins/projectTools.js';
import orrElseExtension from '../src/extension.js';

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
 * A command tool that writes a deterministic JSON payload to its harness-assigned
 * outputFile and exits with the requested exit code. When `exitCode` arg is "1" the
 * process exits non-zero, producing a REJECTED run result.
 */
function exitCodeTool(): ProjectCommandToolConfig {
  const script = `
const fs = require('fs');
fs.writeFileSync(process.env.${EnvVars.TOOL_OUTPUT_FILE}, JSON.stringify({ ran: true, code: process.env.PROBE_EXIT_CODE || '0' }));
console.log('probe-stdout');
process.exit(Number(process.env.PROBE_EXIT_CODE || '0'));
`;
  return {
    name: 'exit_probe',
    type: ProjectToolType.COMMAND,
    command: process.execPath,
    defaultArgs: ['-e', script],
    cwd: CwdMode.WORKTREE,
    allowCwdOverride: true
  };
}

/** Latest tool-result event for the given (bead,state,action,tool) tuple. */
function latestToolResultEvent(
  events: DomainEvent[],
  beadId: string,
  stateId: string,
  actionId: string,
  tool: string
): DomainEvent | undefined {
  const matching = events.filter(event => {
    if (event.type !== DomainEventName.PROJECT_TOOL_SUCCEEDED && event.type !== DomainEventName.PROJECT_TOOL_FAILED) {
      return false;
    }
    const data = event.data as Record<string, unknown>;
    return data.beadId === beadId && data.stateId === stateId && data.actionId === actionId && data.tool === tool;
  });
  return matching.length > 0 ? matching[matching.length - 1] : undefined;
}

describe('pi-experiment-0yt5.27: PROJECT-scoped per-tool output path', () => {
  let projectRoot: string;
  let worktreePath: string;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let pathFactory: ToolCallPathFactory;
  let prevProjectRoot: string | undefined;
  let prevWorktree: string | undefined;
  let prevExitCode: string | undefined;

  beforeEach(() => {
    prevProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    prevWorktree = process.env[EnvVars.WORKTREE_PATH];
    prevExitCode = process.env.PROBE_EXIT_CODE;
    projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-0yt5-27-')));
    // PROJECT_ROOT != WORKTREE_PATH (the worker runs in a per-bead worktree).
    worktreePath = path.join(projectRoot, 'worktrees', 'bd-27');
    fs.mkdirSync(worktreePath, { recursive: true });
    writeMinimalHarnessConfig(projectRoot);
    configLoader = new ConfigLoader(undefined, projectRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, projectRoot);
    eventStore.setSessionId(`test-${process.pid}`);
    pathFactory = new ToolCallPathFactory();
    process.env[EnvVars.PROJECT_ROOT] = projectRoot;
    process.env[EnvVars.WORKTREE_PATH] = worktreePath;
    delete process.env.PROBE_EXIT_CODE;
  });

  afterEach(() => {
    configLoader.reset();
    vi.restoreAllMocks();
    if (prevProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = prevProjectRoot;
    if (prevWorktree === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = prevWorktree;
    if (prevExitCode === undefined) delete process.env.PROBE_EXIT_CODE;
    else process.env.PROBE_EXIT_CODE = prevExitCode;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  // ── AC1: PROJECT-scoped, per-invocation-unique-leaf, coordinator-readable ──────
  it('AC1: writes raw output under {PROJECT_ROOT}/.pi/tool-output and the coordinator (cwd=PROJECT_ROOT) can read it', async () => {
    // PROJECT_ROOT and WORKTREE_PATH genuinely differ.
    expect(projectRoot).not.toBe(worktreePath);

    await executeConfiguredProjectTool(
      eventStore, pathFactory, exitCodeTool(),
      { beadId: 'bd-27', stateId: 'Planning', actionId: 'analyze' },
      {} as any, undefined, new Map()
    );

    const events = await eventStore.readAll();
    const latest = latestToolResultEvent(events, 'bd-27', 'Planning', 'analyze', 'exit_probe');
    expect(latest?.type).toBe(DomainEventName.PROJECT_TOOL_SUCCEEDED);
    const outputFile = (latest!.data as Record<string, unknown>).outputFile as string;

    // Resolved against PROJECT_ROOT, NOT WORKTREE_PATH, under the single canonical area.
    expect(path.isAbsolute(outputFile)).toBe(true);
    const toolOutputRoot = path.join(projectRoot, '.pi', 'tool-output');
    expect(outputFile.startsWith(toolOutputRoot + path.sep)).toBe(true);
    expect(outputFile.startsWith(worktreePath + path.sep)).toBe(false);
    // Per-invocation-unique leaf: bead/state/action/tool/<invocationId>/output/<file>.
    expect(outputFile).toContain(path.join('bd-27', 'Planning', 'analyze', 'exit_probe'));

    // The coordinator runs at PROJECT_ROOT (a different cwd than the worker's
    // worktree) — it can read the worker-produced output via the recorded path.
    // The canonical outputFile holds the persisted full tool-result envelope.
    const fromCoordinatorCwd = path.isAbsolute(outputFile)
      ? outputFile
      : path.resolve(projectRoot, outputFile);
    expect(fs.existsSync(fromCoordinatorCwd)).toBe(true);
    const payload = JSON.parse(fs.readFileSync(fromCoordinatorCwd, 'utf8'));
    expect(payload.tool).toBe('exit_probe');
    expect(payload.status).toBe(ToolResultStatus.PASSED);
  });

  // ── AC5: single archive location — no double-persist .pi/tool-output + .tmp/tool-calls
  it('AC5: persists to exactly ONE location (.pi/tool-output) and never to .tmp/tool-calls', async () => {
    await executeConfiguredProjectTool(
      eventStore, pathFactory, exitCodeTool(),
      { beadId: 'bd-27', stateId: 'Planning', actionId: 'single' },
      {} as any, undefined, new Map()
    );

    // The legacy .tmp/tool-calls location must not exist for this invocation.
    expect(fs.existsSync(path.join(projectRoot, '.tmp', 'tool-calls'))).toBe(false);
    expect(fs.existsSync(path.join(worktreePath, '.tmp', 'tool-calls'))).toBe(false);

    // Exactly one canonical tool-output tree exists for this tool.
    const toolDir = path.join(projectRoot, '.pi', 'tool-output', 'bd-27', 'Planning', 'single', 'exit_probe');
    expect(fs.existsSync(toolDir)).toBe(true);
    const invocationLeaves = fs.readdirSync(toolDir);
    expect(invocationLeaves.length).toBe(1);
  });

  // ── AC2: latest event recovers outputFile + status ────────────────────────────
  it('AC2: the latest tool-result event recovers outputFile + status', async () => {
    await executeConfiguredProjectTool(
      eventStore, pathFactory, exitCodeTool(),
      { beadId: 'bd-27', stateId: 'Planning', actionId: 'recover' },
      {} as any, undefined, new Map()
    );

    const events = await eventStore.readAll();
    const latest = latestToolResultEvent(events, 'bd-27', 'Planning', 'recover', 'exit_probe');
    const data = latest!.data as Record<string, unknown>;
    expect(data.status).toBe(ToolResultStatus.PASSED);
    expect(typeof data.outputFile).toBe('string');
    expect(fs.existsSync(data.outputFile as string)).toBe(true);
  });

  // ── AC4: a REJECTED (non-zero exit) run records status:REJECTED + failureCategory
  it('AC4: a REJECTED run records status:REJECTED + failureCategory (+ outputFile)', async () => {
    process.env.PROBE_EXIT_CODE = '1';
    await executeConfiguredProjectTool(
      eventStore, pathFactory, exitCodeTool(),
      { beadId: 'bd-27', stateId: 'Planning', actionId: 'reject' },
      {} as any, undefined, new Map()
    );

    const events = await eventStore.readAll();
    const latest = latestToolResultEvent(events, 'bd-27', 'Planning', 'reject', 'exit_probe');
    expect(latest?.type).toBe(DomainEventName.PROJECT_TOOL_FAILED);
    const data = latest!.data as Record<string, unknown>;
    expect(data.status).toBe(ToolResultStatus.REJECTED);
    expect(typeof data.failureCategory).toBe('string');
    expect(typeof data.outputFile).toBe('string');
  });

  // ── AC3: NEGATIVE freshness — a retried RAN-and-REJECTED invocation is the LATEST
  it('AC3: a retried run that REJECTED records a NEW latest event the gate would read (no stale pass)', async () => {
    const args = { beadId: 'bd-27', stateId: 'Planning', actionId: 'retry' };

    // First run PASSES and leaves a prior-run output leaf behind.
    await executeConfiguredProjectTool(
      eventStore, pathFactory, exitCodeTool(), args, {} as any, undefined, new Map()
    );
    const afterFirst = latestToolResultEvent(await eventStore.readAll(), 'bd-27', 'Planning', 'retry', 'exit_probe');
    expect(afterFirst?.type).toBe(DomainEventName.PROJECT_TOOL_SUCCEEDED);
    const firstOutputFile = (afterFirst!.data as Record<string, unknown>).outputFile as string;
    expect(fs.existsSync(firstOutputFile)).toBe(true);

    // Retry RANS and REJECTS (non-zero exit).
    process.env.PROBE_EXIT_CODE = '1';
    await executeConfiguredProjectTool(
      eventStore, pathFactory, exitCodeTool(), args, {} as any, undefined, new Map()
    );

    // The gate reads the LATEST event per (bead,state,action,tool) — it must be the
    // retry's REJECTED event, NOT the stale prior-run PASSED leaf.
    const latest = latestToolResultEvent(await eventStore.readAll(), 'bd-27', 'Planning', 'retry', 'exit_probe');
    expect(latest?.type).toBe(DomainEventName.PROJECT_TOOL_FAILED);
    const latestData = latest!.data as Record<string, unknown>;
    expect(latestData.status).toBe(ToolResultStatus.REJECTED);
    // The latest event points at a DIFFERENT (fresh) per-invocation leaf than the
    // stale prior-run file, so a presence check on the stale leaf cannot false-pass.
    expect(latestData.outputFile).not.toBe(firstOutputFile);
  });
});

// ── AC5 (plugin path): no throwaway id; typed ToolResultBase + outputFile on event
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

function readEventStoreLines(dir: string): Array<Record<string, unknown>> {
  const eventsDir = path.join(dir, '.pi', 'events');
  if (!fs.existsSync(eventsDir)) return [];
  const lines: Array<Record<string, unknown>> = [];
  for (const file of fs.readdirSync(eventsDir).filter(f => f.endsWith('.jsonl'))) {
    const raw = fs.readFileSync(path.join(eventsDir, file), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }
  return lines;
}

describe('pi-experiment-0yt5.27: plugin path records typed ToolResultBase + outputFile', () => {
  let previousCwd: string;
  let tempRoot: string;
  let prevProjectRoot: string | undefined;
  let prevWorktree: string | undefined;

  beforeEach(() => {
    previousCwd = process.cwd();
    prevProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    prevWorktree = process.env[EnvVars.WORKTREE_PATH];
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-0yt5-27-plugin-')));
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
`);
    process.chdir(tempRoot);
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempRoot;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (prevProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = prevProjectRoot;
    if (prevWorktree === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = prevWorktree;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('AC5: a wrapped plugin tool records toolResult{status,outputFile} pointing at .pi/tool-output (single location)', async () => {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

    const statusTool = harness.tools.find(tool => tool.name === BuiltInToolName.HARNESS_STATUS);
    expect(statusTool).toBeDefined();
    await statusTool.execute('call-1', {}, undefined, undefined, { hasUI: false, cwd: tempRoot });

    // Give the awaited persist + event record time to flush to disk.
    await new Promise(resolve => setTimeout(resolve, 150));

    const events = readEventStoreLines(tempRoot);
    const succeeded = events.filter(event =>
      event.type === DomainEventName.TOOL_INVOCATION_SUCCEEDED &&
      (event.data as any)?.tool === BuiltInToolName.HARNESS_STATUS
    );
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    const toolResult = (succeeded[succeeded.length - 1].data as any).toolResult;
    expect(toolResult).toBeDefined();
    expect(toolResult.tool).toBe(BuiltInToolName.HARNESS_STATUS);
    expect(toolResult.status).toBe(ToolResultStatus.PASSED);
    expect(typeof toolResult.outputFile).toBe('string');
    // Single canonical location — under .pi/tool-output, never .tmp/tool-calls.
    expect(toolResult.outputFile).toContain(path.join('.pi', 'tool-output'));
    expect(toolResult.outputFile).not.toContain(path.join('.tmp', 'tool-calls'));
    expect(typeof toolResult.outputFileBytes).toBe('number');
    expect(fs.existsSync(toolResult.outputFile)).toBe(true);
    // No double-persist: the legacy .tmp/tool-calls tree was not created.
    expect(fs.existsSync(path.join(tempRoot, '.tmp', 'tool-calls'))).toBe(false);
  });
});
