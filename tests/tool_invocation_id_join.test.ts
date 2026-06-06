/**
 * dl9r: Canonical toolInvocationId join tests.
 *
 * AC1: For a plugin tool invocation, querying by toolInvocationId joins EXACTLY
 *      ONE start event, one terminal event, and the token-usage accounting.
 *
 * AC2: For a project tool invocation, querying by toolInvocationId joins EXACTLY
 *      ONE PROJECT_TOOL_STARTED, one terminal event (PROJECT_TOOL_SUCCEEDED /
 *      PROJECT_TOOL_FAILED), and they carry the same id.
 *
 * AC4: Model-facing tool results do not contain toolInvocationId (harness-only).
 *
 * OTel span coverage is verified separately in observability.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { ToolCallPathFactory } from '../src/core/ToolCallPathFactory.js';
import {
  DomainEventName,
  EnvVars,
  PiEventName,
  ProcessFlag,
  ProjectToolType,
  ToolResultStatus
} from '../src/constants/index.js';
import { executeConfiguredProjectTool } from '../src/plugins/projectTools.js';
import type { ProjectCommandToolConfig } from '../src/core/domain/StateModels.js';
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

// ── AC2: Project tool invocation id join ─────────────────────────────────────

describe('toolInvocationId join — project tool (AC2)', () => {
  let tempRoot: string;
  let tempWorktree: string;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let toolCallPathFactory: ToolCallPathFactory;
  let prevProjectRoot: string | undefined;
  let prevWorktreePath: string | undefined;

  beforeEach(() => {
    prevProjectRoot = process.env[EnvVars.PROJECT_ROOT];
    prevWorktreePath = process.env[EnvVars.WORKTREE_PATH];

    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-dl9r-pt-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-1');
    fs.mkdirSync(tempWorktree, { recursive: true });
    writeMinimalHarnessConfig(tempRoot);

    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-dl9r-pt-${process.pid}`);

    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempWorktree;
  });

  afterEach(() => {
    configLoader.reset();
    eventStore.setSessionId(`test-dl9r-pt-${process.pid}-reset`);
    if (prevProjectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = prevProjectRoot;
    if (prevWorktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = prevWorktreePath;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('STARTED and SUCCEEDED events carry the same toolInvocationId (join by id)', async () => {
    const tool: ProjectCommandToolConfig = {
      name: 'echo_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stdout.write(JSON.stringify({ status: "PASSED", value: 42 }))']
    };

    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'analyze' },
      {} as any, undefined, new Map()
    );

    // AC4: model-facing result has no toolInvocationId
    expect((result as any).toolInvocationId).toBeUndefined();

    const events = await eventStore.eventsForBead('bd-1');
    const started = events.filter(e => e.type === DomainEventName.PROJECT_TOOL_STARTED && e.data?.tool === 'echo_tool');
    const terminal = events.filter(e =>
      (e.type === DomainEventName.PROJECT_TOOL_SUCCEEDED || e.type === DomainEventName.PROJECT_TOOL_FAILED) &&
      e.data?.tool === 'echo_tool'
    );

    // Exactly one start and one terminal event
    expect(started).toHaveLength(1);
    expect(terminal).toHaveLength(1);

    const startedId = started[0].data?.toolInvocationId as string | undefined;
    const terminalId = terminal[0].data?.toolInvocationId as string | undefined;

    // Both events carry a toolInvocationId
    expect(typeof startedId).toBe('string');
    expect(startedId!.length).toBeGreaterThan(0);

    // The terminal event carries the SAME id as the start event
    expect(terminalId).toBe(startedId);
  });

  it('STARTED and FAILED events carry the same toolInvocationId when the tool fails', async () => {
    const tool: ProjectCommandToolConfig = {
      name: 'failing_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.exit(1)']
    };

    await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, tool,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'analyze' },
      {} as any, undefined, new Map()
    );

    const events = await eventStore.eventsForBead('bd-1');
    const started = events.filter(e => e.type === DomainEventName.PROJECT_TOOL_STARTED && e.data?.tool === 'failing_tool');
    const failed = events.filter(e => e.type === DomainEventName.PROJECT_TOOL_FAILED && e.data?.tool === 'failing_tool');

    expect(started).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const startedId = started[0].data?.toolInvocationId as string | undefined;
    const failedId = failed[0].data?.toolInvocationId as string | undefined;

    expect(typeof startedId).toBe('string');
    expect(failedId).toBe(startedId);
  });
});

// ── AC1: Plugin tool invocation id join ──────────────────────────────────────

function fakePiForJoinTest() {
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

function readEventStoreLinesForJoinTest(dir: string): Array<Record<string, unknown>> {
  const eventsDir = path.join(dir, '.pi', 'events');
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

const HEADLESS_CTX_FOR_JOIN = { hasUI: false, shutdown: () => {} } as any;

describe('toolInvocationId join — plugin tool (AC1 + AC3)', () => {
  it('STARTED, SUCCEEDED, and TOKEN_USAGE_RECORDED events share the same non-empty toolInvocationId', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-dl9r-plugin-join-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: probe_join_tool
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'probe_join_tool', status: 'PASSED', value: 1 }));"
states:
  Planning:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    actions:
      - id: probe-action
        type: prompt
        prompt: "Probe"
    requiredTools: [probe_join_tool]
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    let harness: ReturnType<typeof fakePiForJoinTest> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-dl9r-plugin';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'probe-action';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePiForJoinTest();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const probeTool = harness.tools.find((t: any) => t.name === 'probe_join_tool');
      expect(probeTool).toBeDefined();

      // Single invocation — non-cached
      const modelResult = await probeTool.execute('call-dl9r-1', {}, undefined, undefined, HEADLESS_CTX_FOR_JOIN);

      // Allow async event-store writes to flush
      await new Promise(resolve => setTimeout(resolve, 50));

      const events = readEventStoreLinesForJoinTest(tempRoot);

      const started = events.filter(
        (e: any) => e.type === DomainEventName.TOOL_INVOCATION_STARTED && e.data?.tool === 'probe_join_tool'
      );
      const terminal = events.filter(
        (e: any) => (e.type === DomainEventName.TOOL_INVOCATION_SUCCEEDED || e.type === DomainEventName.TOOL_INVOCATION_FAILED)
          && e.data?.tool === 'probe_join_tool'
      );
      const tokenUsage = events.filter(
        (e: any) => e.type === DomainEventName.TOKEN_USAGE_RECORDED && e.data?.tool === 'probe_join_tool'
      );

      // Exactly one of each
      expect(started).toHaveLength(1);
      expect(terminal).toHaveLength(1);
      expect(tokenUsage).toHaveLength(1);

      const startedId = (started[0] as any).data?.toolInvocationId as string | undefined;
      const terminalId = (terminal[0] as any).data?.toolInvocationId as string | undefined;
      const tokenId = (tokenUsage[0] as any).data?.toolInvocationId as string | undefined;

      // All three carry a non-empty toolInvocationId
      expect(typeof startedId).toBe('string');
      expect(startedId!.length).toBeGreaterThan(0);
      expect(terminalId).toBe(startedId);
      expect(tokenId).toBe(startedId);

      // AC4: model-facing result must not expose toolInvocationId
      expect((modelResult as any).toolInvocationId).toBeUndefined();
      // Pi content array also has no toolInvocationId
      const contentText = (modelResult as any)?.content?.[0]?.text ?? '';
      expect(contentText).not.toContain('toolInvocationId');
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnv.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnv.workerMode;
      if (previousEnv.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnv.beadId;
      if (previousEnv.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnv.stateId;
      if (previousEnv.actionId === undefined) delete process.env[EnvVars.ACTION_ID];
      else process.env[EnvVars.ACTION_ID] = previousEnv.actionId;
      if (previousEnv.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnv.projectRoot;
      if (previousEnv.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnv.worktreePath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('two sequential plugin invocations produce two distinct toolInvocationIds', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-dl9r-plugin-two-ids-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: distinct_id_tool
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'distinct_id_tool', status: 'PASSED' }));"
states:
  Planning:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    actions:
      - id: probe-action
        type: prompt
        prompt: "Probe"
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    let harness: ReturnType<typeof fakePiForJoinTest> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-dl9r-two-ids';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'probe-action';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePiForJoinTest();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const probeTool = harness.tools.find((t: any) => t.name === 'distinct_id_tool');
      expect(probeTool).toBeDefined();

      await probeTool.execute('call-dl9r-a', {}, undefined, undefined, HEADLESS_CTX_FOR_JOIN);
      await probeTool.execute('call-dl9r-b', {}, undefined, undefined, HEADLESS_CTX_FOR_JOIN);

      await new Promise(resolve => setTimeout(resolve, 50));

      const events = readEventStoreLinesForJoinTest(tempRoot);
      const started = events.filter(
        (e: any) => e.type === DomainEventName.TOOL_INVOCATION_STARTED && e.data?.tool === 'distinct_id_tool'
      );

      // Each invocation emits its own STARTED event
      expect(started).toHaveLength(2);

      const id1 = (started[0] as any).data?.toolInvocationId as string;
      const id2 = (started[1] as any).data?.toolInvocationId as string;

      expect(typeof id1).toBe('string');
      expect(id1.length).toBeGreaterThan(0);
      expect(id2).not.toBe(id1);
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnv.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnv.workerMode;
      if (previousEnv.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnv.beadId;
      if (previousEnv.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnv.stateId;
      if (previousEnv.actionId === undefined) delete process.env[EnvVars.ACTION_ID];
      else process.env[EnvVars.ACTION_ID] = previousEnv.actionId;
      if (previousEnv.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnv.projectRoot;
      if (previousEnv.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnv.worktreePath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ── Constants wiring ──────────────────────────────────────────────────────────

describe('toolInvocationId constant wiring (dl9r)', () => {
  it('OtelAttr.ORR_ELSE_TOOL_INVOCATION_ID is defined and has the expected value', async () => {
    const { OtelAttr } = await import('../src/constants/index.js');
    expect(OtelAttr.ORR_ELSE_TOOL_INVOCATION_ID).toBe('orr_else.tool_invocation_id');
  });

  it('buildToolTokenAccounting accepts toolInvocationId and includes it in the record', async () => {
    const { buildToolTokenAccounting } = await import('../src/core/TokenUsage.js');
    const id = '01935c28-abcd-7abc-def0-999999999999';
    const accounting = buildToolTokenAccounting('my_tool', 'bead-1', 'Planning', 'act-1', 'output', false, id);
    expect(accounting.toolInvocationId).toBe(id);
    // Accounting record must NOT appear on model-facing result
    expect(typeof accounting.modelFacingBytes).toBe('number');
    expect(typeof accounting.estimatedTokens).toBe('number');
  });
});
