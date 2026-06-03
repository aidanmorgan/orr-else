import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import orrElseExtension, { isHarnessTransientFailure, shouldPersistBlockedBeadStatus } from '../src/extension.js';
import { FlowManager } from '../src/core/FlowManager.js';
import { Teammate } from '../src/core/Teammate.js';
import { TeammateFactory } from '../src/plugins/teammates.js';
import { BuiltInToolName, DomainEventName, EnvVars, NativePiToolName, PiEventName, PluginToolName, ProcessFlag } from '../src/constants/index.js';
import { setBridgeProbeForTest, resetMcpBridgeHealthCache } from '../src/core/McpTransportPreflight.js';

function fakePi() {
  const tools: any[] = [];
  const commands: Record<string, any> = {};
  const callbacks: Record<string, Function> = {};
  let activeTools: string[] = [];

  return {
    tools,
    commands,
    callbacks,
    pi: {
      on: (name: string, callback: Function) => {
        callbacks[name] = callback;
      },
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: (name: string, options: any) => {
        commands[name] = options;
      },
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => {
        activeTools = names;
      },
      setThinkingLevel: () => {},
      setModel: async () => true,
      sendUserMessage: () => {}
    } as any
  };
}

const HEADLESS_TOOL_CONTEXT = { hasUI: false, shutdown: () => {} } as any;

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function startSignalAckServer(receivedEvents: unknown[], status = 200): Promise<Server> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (body) receivedEvents.push(JSON.parse(body));
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status >= 200 && status < 300 ? { ok: true } : { error: 'rejected' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  process.env[EnvVars.API_BASE] = `http://127.0.0.1:${address.port}`;
  return server;
}

describe('Pi-native extension surface', () => {
  it('persists blocked Beads for blocked teammate outcomes', () => {
    expect(shouldPersistBlockedBeadStatus('STATE_BLOCKED', 'Planning')).toBe(true);
    expect(shouldPersistBlockedBeadStatus('STATE_FAILED', 'blocked')).toBe(true);
    expect(shouldPersistBlockedBeadStatus('STATE_FAILED', 'Planning')).toBe(false);
  });

  it('classifies Codex SSE response-header timeouts as transient harness failures', () => {
    expect(isHarnessTransientFailure('Codex SSE response headers timed out after 10000ms')).toBe(true);
  });

  it('routes failed teammate events through the configured failure edge before retrying', () => {
    const retry = new FlowManager().resolveFailedTeammateEventRetry(
      'Implementation',
      'FAILURE',
      { retryCount: 1 }
    );

    expect(retry.retryCount).toBe(2);
    expect(retry.status).toBe('Implementation');
    expect(retry.notes).toContain('RETRY');
    expect(retry.removeWorktree).toBe(false);
  });

  it('distinguishes harness restart routes from context restart routes', () => {
    const config = {
      settings: {
        harnessRestartEvent: 'HARNESS_RESTART',
        contextRestartEvent: 'CONTEXT_RESTART'
      },
      states: {
        Planning: {
          on: {
            HARNESS_RESTART: 'Planning',
            CONTEXT_RESTART: 'RecoveryPlanning'
          },
          transitions: { SUCCESS: 'completed', FAILURE: 'Planning' }
        },
        RecoveryPlanning: {
          transitions: { SUCCESS: 'completed', FAILURE: 'RecoveryPlanning' }
        }
      }
    } as any;
    const bead = {
      id: 'pi-experiment-restart-route' as any,
      title: 'restart route',
      status: 'Planning',
      changed_files: [],
      logs: [],
      dependencies: [],
      retryCount: 0,
      compactionCount: 0,
      lastActivity: '2026-05-23T00:00:00.000Z',
      totalExecutionTimeMs: 0,
      handovers: {},
      completedActionIds: []
    };

    const flowManager = new FlowManager();
    expect(flowManager.resolveRestartTransition({ ...bead, restartKind: 'harness' }, config)).toMatchObject({
      kind: 'harness',
      event: 'HARNESS_RESTART',
      targetStateId: 'Planning'
    });
    expect(flowManager.resolveRestartTransition({ ...bead, restartKind: 'context' }, config)).toMatchObject({
      kind: 'context',
      event: 'CONTEXT_RESTART',
      targetStateId: 'RecoveryPlanning'
    });
  });

  it('blocks teammate access to framework runtime artifacts', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-read-policy-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'source.py'), 'print("ok")\n');
    fs.writeFileSync(path.join(worktreePath, 'source.py'), 'print("ok")\n');
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  artifacts:
    baseDir: .pi/artifacts
    templates:
      planContract: .pi/artifacts/{{beadId}}/plan-contract.json
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    const harness = fakePi();

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-1';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      process.chdir(worktreePath);

      const result = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.READ,
        toolCallId: 'read-progress',
        input: { path: path.join(tempRoot, 'PROGRESS.md') }
      });

      expect(result).toMatchObject({ block: true });
      expect(result.reason).toContain('bd_get_state_chart');

      const stateLog = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.READ,
        toolCallId: 'read-state-log',
        input: { path: path.join(tempRoot, 'state/logs/orr-else-2026-05-24.log') }
      });

      expect(stateLog).toMatchObject({ block: true });
      expect(stateLog.reason).toContain('framework runtime artifacts');

      const readArtifact = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.READ,
        toolCallId: 'read-artifact',
        input: { path: path.join(tempRoot, '.pi/artifacts/bd-1/plan-contract.json'), limit: 80 }
      });

      expect(readArtifact).toMatchObject({ block: true });
      expect(readArtifact.reason).toContain('get_artifact_paths');

      const readProjectToolOutput = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.READ,
        toolCallId: 'read-project-tool-output',
        input: { path: path.join(tempRoot, '.tmp/tool-calls/bd-1/Planning/tool/result.json'), limit: 80 }
      });

      expect(readProjectToolOutput).toMatchObject({ block: true });
      expect(readProjectToolOutput.reason).toContain('may not read project-tool output archives directly');

      const readOutside = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.READ,
        toolCallId: 'read-outside',
        input: { path: path.join(tempRoot, 'source.py'), limit: 10 }
      });

      expect(readOutside).toMatchObject({ block: true });
      expect(readOutside.reason).toContain('may only read files inside this Bead worktree');

      const writeRuntime = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.WRITE,
        toolCallId: 'write-runtime',
        input: { path: path.join(tempRoot, '.pi/events/project.jsonl'), content: '{}' }
      });

      expect(writeRuntime).toMatchObject({ block: true });
      expect(writeRuntime.reason).toContain('may not modify framework runtime artifacts');

      const editTemp = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.EDIT,
        toolCallId: 'edit-temp',
        input: { filePath: path.join(tempRoot, '.tmp/tool-calls/output.json') }
      });

      expect(editTemp).toMatchObject({ block: true });
      expect(editTemp.reason).toContain('may not modify framework runtime artifacts');

      const writeOutside = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.WRITE,
        toolCallId: 'write-outside',
        input: { path: path.join(tempRoot, 'outside.txt'), content: 'nope' }
      });

      expect(writeOutside).toMatchObject({ block: true });
      expect(writeOutside.reason).toContain('may only mutate files inside this Bead worktree');

      const writeArtifact = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.WRITE,
        toolCallId: 'write-artifact',
        input: {
          path: path.join(tempRoot, '.pi/artifacts/bd-1/plan-contract.json'),
          content: '{}'
        }
      });

      expect(writeArtifact).toBeUndefined();

      const editPlanContract = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.EDIT,
        toolCallId: 'edit-plan-contract',
        input: {
          filePath: path.join(tempRoot, '.pi/artifacts/bd-1/plan-contract.json'),
          oldString: '{}',
          newString: '{"writeSet":[]}'
        }
      });

      expect(editPlanContract).toMatchObject({
        block: true,
        nextAction: 'replace_plan_contract_with_full_write'
      });
      expect(editPlanContract.reason).toContain('full `write` payload');
      expect(editPlanContract.recovery).toEqual(expect.arrayContaining([
        expect.stringContaining('complete plan-contract JSON'),
        expect.stringContaining('validate the full write set'),
        expect.stringContaining('Do not retry a partial edit or patch')
      ]));

      const writeInside = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.WRITE,
        toolCallId: 'write-inside',
        input: { path: path.join(worktreePath, 'inside.txt'), content: 'ok' }
      });

      expect(writeInside).toBeUndefined();

      const editInside = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.EDIT,
        toolCallId: 'edit-inside',
        input: {
          filePath: path.join(worktreePath, 'source.py'),
          oldString: 'print("ok")',
          newString: 'print("still ok")'
        }
      });

      expect(editInside).toBeUndefined();

      const removeState = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.BASH,
        toolCallId: 'remove-state',
        input: { command: `rm -rf ${path.join(tempRoot, 'state')}` }
      });

      expect(removeState).toMatchObject({ block: true });
      expect(removeState.reason).toContain('may not modify framework runtime artifacts');

      const deleteEvent = {
        toolName: NativePiToolName.BASH,
        toolCallId: 'delete-file',
        input: { command: 'rm delete-me.txt' }
      };
      const deleteConversion = await harness.callbacks[PiEventName.TOOL_CALL]?.(deleteEvent);

      expect(deleteConversion).toBeUndefined();
      expect(deleteEvent.input.command).toContain('trash_cli.js');
      expect(deleteEvent.input).toMatchObject({ __orrElseDeleteConverted: true });

      const deleteOutside = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.BASH,
        toolCallId: 'delete-outside',
        input: { command: `rm ${path.join(tempRoot, 'outside-delete.txt')}` }
      });

      expect(deleteOutside).toMatchObject({ block: true });
      expect(deleteOutside.reason).toContain('may only mutate files inside this Bead worktree');

      const redirectOutside = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.BASH,
        toolCallId: 'redirect-outside',
        input: { command: `printf ok > ${path.join(tempRoot, 'outside-output.txt')}` }
      });

      expect(redirectOutside).toMatchObject({ block: true });
      expect(redirectOutside.reason).toContain('may only mutate files inside this Bead worktree');

      const oversized = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.READ,
        toolCallId: 'read-huge-source',
        input: { path: path.join(worktreePath, 'source.py'), limit: 2000 }
      });

      expect(oversized).toMatchObject({ block: true });
      expect(oversized.reason).toContain('400 lines');
    } finally {
      await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnv.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnv.workerMode;
      if (previousEnv.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnv.beadId;
      if (previousEnv.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnv.stateId;
      if (previousEnv.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnv.projectRoot;
      if (previousEnv.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnv.worktreePath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('registers /orr-else, coordinator tools, and teammate signaling tools', async () => {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);

    const toolNames = harness.tools.map(tool => tool.name);
    expect(harness.commands['orr-else']).toBeDefined();
    expect(toolNames).toContain('harness_status');
    expect(toolNames).toContain('tick_item');
    expect(toolNames).toContain('add_checklist_item');
    expect(toolNames).toContain('submit_checkpoint');
    expect(toolNames).toContain('request_context_restart');
    expect(toolNames).toContain('request_harness_restart');
    expect(toolNames).toContain(`spawn_${'teammate'}`);
    expect(toolNames).toContain(`signal_${'completion'}`);
    expect(harness.commands['orr-else'].description).toContain('--config');
  });

  it('requires a durable checkpoint before completion can be signaled', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-checkpoint-gate-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
tools:
  - name: codemap
    type: mcp
    server: codemap
    operations: [get_structure]
  - name: reference_docs
    type: mcp
    server: chroma
    operations:
      query: chroma_query_documents
  - name: ast_grep
    type: command
    command: node
    defaultArgs: ["-e", "console.log(JSON.stringify({ tool: 'ast_grep', status: 'PASSED' }))"]
  - name: native_symbol_index
    type: extension
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
    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-checkpoint-gate';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const submitCheckpoint = harness.tools.find(tool => tool.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);
      const harnessStatus = harness.tools.find(tool => tool.name === BuiltInToolName.HARNESS_STATUS);

      const status = await harnessStatus.execute('status', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      expect(status.details).toMatchObject({
        mode: 'teammate',
        beadId: 'bd-checkpoint-gate',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        checkpoint: { accepted: false }
      });
      expect(status.details.configuredProjectTools).toMatchObject({
        total: 4,
        mcpBacked: 2,
        mcpBackedToolNames: expect.arrayContaining(['codemap', 'reference_docs']),
        command: 1,
        nativeExtension: 1,
        nativeMcpFooterMeaning: expect.stringContaining('does not report Orr Else configured MCP-backed project tools')
      });
      expect(status.details.configuredProjectTools.mcpBackedToolNames).toHaveLength(2);
      expect(status.details.nextHarnessAction).toContain(BuiltInToolName.SUBMIT_CHECKPOINT);

      const earlyCompletion = await signalCompletion.execute('signal-before-checkpoint', {
        outcome: 'SUCCESS',
        summary: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      expect(earlyCompletion.details).toContain('REJECTED: You must call `submit_checkpoint`');

      const checkpoint = await submitCheckpoint.execute('checkpoint', {
        summary: 'checkpoint summary',
        evidence: 'checkpoint evidence'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const completion = await signalCompletion.execute('signal-after-checkpoint', {
        outcome: 'SUCCESS',
        summary: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      expect(checkpoint.details).toBe('Checkpoint accepted and recorded.');
      expect(completion.details).toContain('Completion signaled with outcome: SUCCESS');
      expect(receivedEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'CHECKPOINT_ACCEPTED' }),
        expect.objectContaining({ type: 'STATE_TRANSITIONED' })
      ]));
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
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
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps completion blocked when checkpoint signal delivery fails', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-checkpoint-reject-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
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
    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      server = await startSignalAckServer(receivedEvents, 400);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-checkpoint-reject';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const submitCheckpoint = harness.tools.find(tool => tool.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);
      const harnessStatus = harness.tools.find(tool => tool.name === BuiltInToolName.HARNESS_STATUS);

      const checkpoint = await submitCheckpoint.execute('checkpoint', {
        summary: 'checkpoint summary',
        evidence: 'checkpoint evidence'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const status = await harnessStatus.execute('status', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const completion = await signalCompletion.execute('signal-after-rejected-checkpoint', {
        outcome: 'SUCCESS',
        summary: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      expect(checkpoint.details).toContain('Error:');
      expect(status.details.checkpoint).toMatchObject({ accepted: false });
      expect(completion.details).toContain('REJECTED: You must call `submit_checkpoint`');
      expect(receivedEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'CHECKPOINT_ACCEPTED' })
      ]));
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
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
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects SUCCESS when an action-level required tool was not invoked', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-action-required-tool-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
tools:
  - name: action_gate
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'action_gate', status: 'PASSED' }));"
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
        requiredTools: [action_gate]
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-action-required-tool';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      delete process.env[EnvVars.API_BASE];
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      const completion = await signalCompletion.execute('signal-success', {
        outcome: 'SUCCESS',
        summary: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      expect(completion.details).toContain('REJECTED: Protocol Violation');
      expect(completion.details).toContain('Tool `action_gate` was NEVER invoked.');
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
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects SUCCESS when the latest required tool result failed after an earlier pass', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-required-tool-latest-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
tools:
  - name: evidence_gate
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "const mode = process.argv[1]; console.log(JSON.stringify({ tool: 'evidence_gate', status: mode === 'pass' ? 'PASSED' : 'REJECTED' })); process.exit(mode === 'pass' ? 0 : 1);"
    argsMode: append
    allowArgs: true
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
    requiredTools: [evidence_gate]
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-latest-required-tool';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const evidenceGate = harness.tools.find(tool => tool.name === 'evidence_gate');
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      const passResult = await evidenceGate.execute('gate-pass', { arguments: { argv: ['pass'] } }, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const failResult = await evidenceGate.execute('gate-fail', { arguments: { argv: ['fail'] } }, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const completion = await signalCompletion.execute('signal-success', {
        outcome: 'SUCCESS',
        summary: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      expect(passResult.details.status).toBe('PASSED');
      expect(failResult.details.status).toBe('REJECTED');
      expect(completion.details).toContain('REJECTED: Protocol Violation');
      expect(completion.details).toContain('Tool `evidence_gate` did not pass');
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

  it('blocks further tool work and SUCCESS after a terminal verifier failure', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-terminal-verifier-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
tools:
  - name: evidence_gate
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'evidence_gate', status: 'REJECTED' })); process.exit(1);"
    failureLimit:
      maxFailuresPerState: 1
      suggestedOutcome: FAILURE
      terminal: true
  - name: followup_probe
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'followup_probe', status: 'PASSED' }));"
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
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-terminal-verifier';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const evidenceGate = harness.tools.find(tool => tool.name === 'evidence_gate');
      const followupProbe = harness.tools.find(tool => tool.name === 'followup_probe');
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      const verifier = await evidenceGate.execute('gate-fail', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const blockedTool = await followupProbe.execute('followup', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const completion = await signalCompletion.execute('signal-success', {
        outcome: 'SUCCESS',
        summary: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      expect(verifier.details).toMatchObject({
        status: 'REJECTED',
        failureLimit: {
          failureCount: 1,
          maxFailures: 1,
          suggestedOutcome: 'FAILURE',
          terminal: true
        }
      });
      expect(blockedTool.details).toContain('terminal failure limit already reached');
      expect(blockedTool.details).toContain('outcome `FAILURE`');
      expect(completion.details).toContain('REJECTED: terminal failure limit already reached');
      expect(completion.details).toContain('MUST signal outcome `FAILURE`');
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

  it('enforces recorded project-tool routing hints before generic failure-limit outcomes', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-terminal-routing-hint-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
tools:
  - name: artifact_validator
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'artifact_validator', status: 'REJECTED', routingHint: { suggestedOutcome: 'REQUIREMENTS_DEFECT' } })); process.exit(1);"
    failureLimit:
      maxFailuresPerState: 1
      suggestedOutcome: FAILURE
      terminal: true
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
    requiredTools: []
    on: { REQUIREMENTS_DEFECT: "RequirementsAnalysis" }
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
  RequirementsAnalysis:
    identity: { role: "Analyst", expertise: "Requirements", constraints: [] }
    baseInstructions: "Analyze"
    actions:
      - id: analyze
        type: prompt
        prompt: "Analyze"
    requiredTools: []
    transitions: { SUCCESS: "Planning", FAILURE: "RequirementsAnalysis" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-terminal-routing-hint';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const artifactValidator = harness.tools.find(tool => tool.name === 'artifact_validator');
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      const verifier = await artifactValidator.execute('gate-fail', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const completion = await signalCompletion.execute('signal-failure', {
        outcome: 'FAILURE',
        summary: 'route failure'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      expect(verifier.details).toMatchObject({
        status: 'REJECTED',
        failureLimit: {
          failureCount: 1,
          maxFailures: 1,
          suggestedOutcome: 'REQUIREMENTS_DEFECT',
          terminal: true
        }
      });
      expect(completion.details).toContain('REJECTED: terminal failure limit already reached');
      expect(completion.details).toContain('MUST signal outcome `REQUIREMENTS_DEFECT`');
      expect(completion.details).toContain('outcome `FAILURE` is not permitted');
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

  it('lets configured project tools override generic harness tools with the same name', async () => {
    const previousCwd = process.cwd();
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-project-tool-override-')));
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
tools:
  - name: run_quality_checks
    type: command
    description: Project-owned quality gate.
    command: node
    defaultArgs: ["-e", "console.log('project quality')"]
    argsMode: append
    allowArgs: true
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      harness = fakePi();
      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

      const matchingTools = harness.tools.filter(tool => tool.name === 'run_quality_checks');
      expect(matchingTools).toHaveLength(1);
      expect(matchingTools[0].description).toContain('Project-owned quality gate.');
      expect(matchingTools[0].description).toContain('artifactRef is an opaque harness handle');
      expect(JSON.stringify(matchingTools[0].parameters)).toContain('arguments');
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('contributes configured Pi-native skill paths through resource discovery', async () => {
    const harness = fakePi();
    await orrElseExtension(harness.pi);

    const resources = await harness.callbacks[PiEventName.RESOURCES_DISCOVER]?.({}, HEADLESS_TOOL_CONTEXT);

    expect(resources).toBeDefined();
  });

  it('records AGENT_TURN_FAILED and posts STATE_BLOCKED when worker-mode teammate.start() rejects', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-bootstrap-fail-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
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
    const receivedEvents: unknown[] = [];
    let server: Server | undefined;
    let harness: ReturnType<typeof fakePi> | undefined;
    const startSpy = vi.spyOn(Teammate.prototype, 'start').mockRejectedValue(new Error('bootstrap exploded'));

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-bootstrap-fail';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      // SESSION_START triggers initializeWorkerRun then teammate.start() in worker mode
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot, shutdown: () => {} });

      // A STATE_BLOCKED signal must have been posted to the coordinator before SESSION_START resolved
      expect(receivedEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'STATE_BLOCKED', beadId: 'bd-bootstrap-fail' })
      ]));
    } finally {
      startSpy.mockRestore();
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
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
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps tmux process orchestration behind the /orr-else plugin surface', async () => {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);
    const root = process.cwd();
    const files = fs.readdirSync(path.join(root, 'src'), { recursive: true })
      .filter(file => typeof file === 'string' && file.endsWith('.ts'))
      .map(file => path.join(root, 'src', file));
    const source = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');

    expect(source).toContain('t' + 'mux');
    expect(source).toContain('PI_' + 'BEAD_ID');
    expect(source).toContain('PI_' + 'STATE_ID');
    expect(source).toContain('signal_' + 'completion');
    expect(source).toContain('spawn_' + 'teammate');
    expect(source).toContain('activeStartedBeadIds');
    expect(harness.commands['orr-else'].description).toContain('/orr-else');
  });

  it('re-registers tools on a second independent invocation (no guard short-circuit)', async () => {
    // First invocation
    const harness1 = fakePi();
    await orrElseExtension(harness1.pi);
    await harness1.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);
    const toolsAfterFirst = harness1.tools.map(t => t.name);

    // Second invocation against a completely separate pi object + session.
    // Before the fix, the six registration-guard booleans were module-level and
    // never reset, so SESSION_START on the second pi would call the guard
    // branches (e.g. `if (!artifactPathsToolRegistered)`) and find them already
    // true — meaning the artifact-paths tool, compatibility-context tool, and
    // other guarded tools would NOT be registered on harness2.pi.
    const harness2 = fakePi();
    await orrElseExtension(harness2.pi);
    await harness2.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);
    const toolsAfterSecond = harness2.tools.map(t => t.name);

    // Both invocations must register the same guarded tools on their respective pi
    expect(toolsAfterFirst).toContain(BuiltInToolName.GET_ARTIFACT_PATHS);
    expect(toolsAfterFirst).toContain(BuiltInToolName.GET_COMPATIBILITY_CONTEXT);

    expect(toolsAfterSecond).toContain(BuiltInToolName.GET_ARTIFACT_PATHS);
    expect(toolsAfterSecond).toContain(BuiltInToolName.GET_COMPATIBILITY_CONTEXT);

    // The two invocations must have independent tool arrays (not sharing state)
    expect(harness1.tools).not.toBe(harness2.tools);
    expect(harness1.tools.length).toBeGreaterThan(0);
    expect(harness2.tools.length).toBe(harness1.tools.length);

    // Commands are registered independently too
    expect(harness1.commands['orr-else']).toBeDefined();
    expect(harness2.commands['orr-else']).toBeDefined();
    expect(harness1.commands['orr-else']).not.toBe(harness2.commands['orr-else']);
  });

  it('does not add duplicate process listeners on a second invocation (process-global guard)', async () => {
    // Snapshot listener counts BEFORE the second invocation.
    // processLifecycleObserversRegistered is module-level, so the first
    // invocation (in the test above, or in previous tests in this file) already
    // ran registerProcessLifecycleObservers().  We take a baseline here to be
    // self-contained regardless of test-execution order.
    const before = {
      beforeExit: process.listenerCount('beforeExit'),
      exit: process.listenerCount('exit'),
      uncaughtExceptionMonitor: process.listenerCount('uncaughtExceptionMonitor'),
      unhandledRejection: process.listenerCount('unhandledRejection'),
    };

    // Perform a full second invocation (orrElseExtension + SESSION_START).
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);

    // Listener counts must be unchanged — the module-global guard must have
    // prevented registerProcessLifecycleObservers() from adding more process
    // listeners.  If processLifecycleObserversRegistered were on the per-session
    // ExtensionSession (always false at creation), this invocation would add 4
    // more permanent listeners and these assertions would fail.
    expect(process.listenerCount('beforeExit')).toBe(before.beforeExit);
    expect(process.listenerCount('exit')).toBe(before.exit);
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before.uncaughtExceptionMonitor);
    expect(process.listenerCount('unhandledRejection')).toBe(before.unhandledRejection);

    // Sanity: the second invocation must still have registered the per-pi tools.
    expect(harness.tools.map(t => t.name)).toContain(BuiltInToolName.GET_ARTIFACT_PATHS);
  });
});

describe('WI-20 — TeammateFactory dedup', () => {
  /**
   * SESSION_START always fires before /orr-else can be invoked.  The dedup
   * guarantee is: SESSION_START constructs one TeammateFactory and stores it on
   * the session; startOrrElse (coordinator) reuses session.teammateFactory
   * instead of constructing a second one.  Worker processes never call
   * startOrrElse, so SESSION_START is their only construction site.
   *
   * We verify the invariant via two observable proxies:
   *   1. The spawn_teammate tool is registered after SESSION_START, proving
   *      the factory was built and passed to teammatePlugin().
   *   2. TeammateFactory.prototype.ensureAgentsWindow is spied upon.  It is
   *      called exactly once inside startOrrElse (on the coordinator factory).
   *      If startOrrElse were to construct a second TeammateFactory and call
   *      ensureAgentsWindow on it, the spy would fire on a different instance
   *      than the one captured during SESSION_START; we assert they are the
   *      same object.
   */

  let instancesCaptured: TeammateFactory[] = [];
  let ensureWindowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    instancesCaptured = [];
    // Spy on ensureAgentsWindow (public, called only in startOrrElse).
    // Capture `this` so we can check instance identity later.
    ensureWindowSpy = vi.spyOn(TeammateFactory.prototype, 'ensureAgentsWindow').mockImplementation(
      async function (this: TeammateFactory) {
        instancesCaptured.push(this);
      }
    );
  });

  afterEach(() => {
    ensureWindowSpy.mockRestore();
    instancesCaptured = [];
  });

  it('SESSION_START registers the spawn_teammate tool (factory was constructed)', async () => {
    // Non-worker (coordinator) context — isWorkerMode() returns false.
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);

    const toolNames = harness.tools.map((t: any) => t.name);
    expect(toolNames).toContain(PluginToolName.SPAWN_TEAMMATE);
  });

  it('worker SESSION_START also registers the spawn_teammate tool (worker gets a factory)', async () => {
    // Worker processes never call startOrrElse; SESSION_START is their sole
    // factory construction site.  Confirm the tool is still registered.
    const previousWorkerMode = process.env[EnvVars.WORKER_MODE];
    const previousBeadId = process.env[EnvVars.BEAD_ID];
    const previousStateId = process.env[EnvVars.STATE_ID];
    try {
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-worker-factory-test';
      process.env[EnvVars.STATE_ID] = 'Planning';

      const harness = fakePi();
      await orrElseExtension(harness.pi);
      // In worker mode SESSION_START triggers initializeWorkerRun + Teammate.start();
      // mock start() so it doesn't try real tmux/signaling work.
      const startSpy = vi.spyOn(Teammate.prototype, 'start').mockResolvedValue(undefined as any);
      try {
        await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);
      } finally {
        startSpy.mockRestore();
      }

      const toolNames = harness.tools.map((t: any) => t.name);
      expect(toolNames).toContain(PluginToolName.SPAWN_TEAMMATE);
    } finally {
      if (previousWorkerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousWorkerMode;
      if (previousBeadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousBeadId;
      if (previousStateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousStateId;
    }
  });

  it('coordinator /orr-else reuses the SESSION_START factory (ensureAgentsWindow fires on the spawn_teammate instance)', async () => {
    // Lifecycle: SESSION_START fires first → factory stored on session.
    // /orr-else command → startOrrElse runs → picks up session.teammateFactory
    // via the `session.teammateFactory ??= new TeammateFactory(...)` guard.
    // The ensureAgentsWindow spy is called on the reused factory instance, which
    // must be the SAME OBJECT that backs the spawn_teammate tool.
    //
    // We make startOrrElse's SignalingServer and Supervisor no-ops so the
    // command can complete without real tmux/network infrastructure.
    const { SignalingServer } = await import('../src/core/SignalingServer.js');
    const { Supervisor } = await import('../src/core/Supervisor.js');

    const signalingStartSpy = vi.spyOn(SignalingServer.prototype, 'start').mockResolvedValue(19999);
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined as any);

    // Capture the factory instance closed over by the spawn_teammate tool by
    // intercepting spawnTeammateInTmux (only reachable via the tool's execute).
    const spawnToolFactories: TeammateFactory[] = [];
    const spawnSpy = vi.spyOn(TeammateFactory.prototype, 'spawnTeammateInTmux').mockImplementation(
      async function (this: TeammateFactory) {
        spawnToolFactories.push(this);
        return { success: true };
      }
    );

    try {
      const harness = fakePi();
      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);

      // Invoke /orr-else to trigger startOrrElse.
      const commandHandler = harness.commands[BuiltInToolName.ORR_ELSE]?.handler;
      expect(commandHandler).toBeDefined();
      await commandHandler('--bead bd-coordinator-test', {
        ui: { notify: () => {} },
        hasUI: true
      } as any);

      // ensureAgentsWindow must have been called exactly once (in startOrrElse).
      expect(ensureWindowSpy).toHaveBeenCalledTimes(1);
      expect(instancesCaptured).toHaveLength(1);

      // === SAME-INSTANCE ASSERTION ===
      // Call the spawn_teammate tool's execute so we can capture `this` on the
      // factory it closed over.  The factory closed over at SESSION_START time
      // must be the same object that startOrrElse received via ??=.
      const spawnTool = harness.tools.find((t: any) => t.name === PluginToolName.SPAWN_TEAMMATE);
      expect(spawnTool).toBeDefined();
      // The registered tool is wrapped (wrapPluginTool): execute(toolCallId, params, signal, onUpdate, ctx).
      await spawnTool.execute('probe-call-id', { beadId: 'bd-probe', stateId: 'Planning', worktreePath: '/tmp/probe' }, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      expect(spawnToolFactories).toHaveLength(1);
      // The factory that backs spawn_teammate (SESSION_START factory) must be the
      // identical object on which ensureAgentsWindow was called (startOrrElse factory).
      expect(spawnToolFactories[0]).toBe(instancesCaptured[0]);
    } finally {
      signalingStartSpy.mockRestore();
      supervisorStartSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it('--max-slots CLI override is applied to the reused SESSION_START factory', async () => {
    // Regression test for WI-20 MUST-FIX 1:
    // SESSION_START builds the factory with config.settings.maxConcurrentSlots (or
    // Defaults.MAX_SLOTS if absent).  When /orr-else --max-slots 7 is invoked,
    // startOrrElse must call factory.setMaxSlots(7) so the CLI value wins.
    // Without the fix, the factory retains the config value and getMaxSlots() != 7.
    // With the fix, getMaxSlots() returns 7 (PASS).
    const { SignalingServer } = await import('../src/core/SignalingServer.js');
    const { Supervisor } = await import('../src/core/Supervisor.js');

    const signalingStartSpy = vi.spyOn(SignalingServer.prototype, 'start').mockResolvedValue(19999);
    const supervisorStartSpy = vi.spyOn(Supervisor.prototype, 'start').mockResolvedValue(undefined as any);
    try {
      const harness = fakePi();
      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);

      const commandHandler = harness.commands[BuiltInToolName.ORR_ELSE]?.handler;
      expect(commandHandler).toBeDefined();
      // Pass --max-slots 7 explicitly.  The config does NOT set maxConcurrentSlots
      // (defaults to Defaults.MAX_SLOTS), so 7 is always a distinct override value.
      await commandHandler('--bead bd-slots-test --max-slots 7', {
        ui: { notify: () => {} },
        hasUI: true
      } as any);

      // instancesCaptured[0] is the SESSION_START factory (same object used by
      // startOrrElse, proved by the prior same-instance test).
      // After the fix, setMaxSlots(7) has been applied to it.
      expect(instancesCaptured).toHaveLength(1);
      expect(instancesCaptured[0].getMaxSlots()).toBe(7);
    } finally {
      signalingStartSpy.mockRestore();
      supervisorStartSpy.mockRestore();
    }
  });
});

// ── Helpers shared by pre_signal_audit tests ──────────────────────────────────

function readEventStoreLines(dir: string): Array<Record<string, unknown>> {
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

describe('pre_signal_audit', () => {
  it('reports never_invoked for a required tool that was not called (ready: false, blocking evidence)', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-psa-missing-tool-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
tools:
  - name: required_verifier
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'required_verifier', status: 'PASSED' }));"
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
    requiredTools: [required_verifier]
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-psa-missing-tool';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const preSignalAudit = harness.tools.find((t: any) => t.name === BuiltInToolName.PRE_SIGNAL_AUDIT);
      expect(preSignalAudit).toBeDefined();

      // Do NOT invoke required_verifier — audit should report it as never_invoked
      const auditResult = await preSignalAudit.execute('audit-call', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const audit = auditResult.details;

      expect(audit.ready).toBe(false);
      expect(audit.requiredTools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'required_verifier', state: 'never_invoked' })
        ])
      );
      expect(audit.blockingEvidence).toEqual(
        expect.arrayContaining([
          expect.stringContaining('required_verifier')
        ])
      );
      expect(audit.blockingEvidence.some((e: string) => e.includes('never invoked'))).toBe(true);

      // Wait briefly for the async event store write to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify PRE_SIGNAL_AUDIT_PERFORMED domain event was recorded
      const events = readEventStoreLines(tempRoot);
      const auditEvent = events.find(
        (e: any) => e.type === DomainEventName.PRE_SIGNAL_AUDIT_PERFORMED
      );
      expect(auditEvent).toBeDefined();
      expect((auditEvent as any).data.ready).toBe(false);
      expect((auditEvent as any).data.blockingCount).toBeGreaterThan(0);
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

  it('reports terminal failure limit reached (ready: false, correct suggestedOutcome in blocking evidence)', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-psa-terminal-fail-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
tools:
  - name: terminal_verifier
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'terminal_verifier', status: 'REJECTED' })); process.exit(1);"
    failureLimit:
      maxFailuresPerState: 1
      suggestedOutcome: FAILURE
      terminal: true
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
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-psa-terminal-fail';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const terminalVerifier = harness.tools.find((t: any) => t.name === 'terminal_verifier');
      const preSignalAudit = harness.tools.find((t: any) => t.name === BuiltInToolName.PRE_SIGNAL_AUDIT);
      expect(preSignalAudit).toBeDefined();

      // Trigger the terminal failure
      await terminalVerifier.execute('fail', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Now audit should report terminal failure limit reached
      const auditResult = await preSignalAudit.execute('audit-after-terminal', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const audit = auditResult.details;

      expect(audit.ready).toBe(false);
      expect(audit.terminalFailureLimit).toMatchObject({ reached: true, failedTool: 'terminal_verifier', suggestedOutcome: 'FAILURE' });
      expect(audit.requiredOutcome).toBe('FAILURE');
      expect(audit.blockingEvidence).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Terminal failure limit')
        ])
      );

      // Verify domain event recorded
      await new Promise(resolve => setTimeout(resolve, 50));
      const events = readEventStoreLines(tempRoot);
      const auditEvents = events.filter(
        (e: any) => e.type === DomainEventName.PRE_SIGNAL_AUDIT_PERFORMED
      );
      expect(auditEvents.length).toBeGreaterThan(0);
      expect((auditEvents[0] as any).data.ready).toBe(false);
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

  it('reports ready: true when all required tools passed and no terminal failure (all-clear path)', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-psa-all-clear-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
tools:
  - name: passing_gate
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'passing_gate', status: 'PASSED' }));"
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
    requiredTools: [passing_gate]
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;
    let server: Server | undefined;
    const receivedEvents: unknown[] = [];

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-psa-all-clear';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const passingGate = harness.tools.find((t: any) => t.name === 'passing_gate');
      const submitCheckpoint = harness.tools.find((t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const preSignalAudit = harness.tools.find((t: any) => t.name === BuiltInToolName.PRE_SIGNAL_AUDIT);
      expect(preSignalAudit).toBeDefined();

      // Run the required tool (it passes)
      await passingGate.execute('gate-pass', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Accept checkpoint
      await submitCheckpoint.execute('checkpoint', {
        summary: 'all done',
        evidence: 'all green'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Now audit should report ready: true
      const auditResult = await preSignalAudit.execute('audit-all-clear', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const audit = auditResult.details;

      expect(audit.ready).toBe(true);
      expect(audit.blockingEvidence).toEqual([]);
      expect(audit.requiredTools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'passing_gate', state: 'passed' })
        ])
      );
      expect(audit.terminalFailureLimit).toMatchObject({ reached: false });
      expect(audit.checkpointAccepted).toBe(true);

      // Verify PRE_SIGNAL_AUDIT_PERFORMED domain event recorded with ready: true
      await new Promise(resolve => setTimeout(resolve, 50));
      const events = readEventStoreLines(tempRoot);
      const allClearAudit = events.find(
        (e: any) => e.type === DomainEventName.PRE_SIGNAL_AUDIT_PERFORMED && (e as any).data.ready === true
      );
      expect(allClearAudit).toBeDefined();
      expect((allClearAudit as any).data.blockingCount).toBe(0);
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
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

  // ── Gate equivalence tests (proving audit.ready == real gate accept) ──────

  it('equivalence: all-clear — audit ready:true agrees with signal_completion ACCEPTED', async () => {
    // Proves the shared evaluateGateReadiness predicate: when every gate passes,
    // both the audit and the real signal_completion agree the outcome is accepted.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-psa-equiv-allclear-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
tools:
  - name: passing_verifier
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'passing_verifier', status: 'PASSED' }));"
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
    requiredTools: [passing_verifier]
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;
    let server: Server | undefined;
    const receivedEvents: unknown[] = [];

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-psa-equiv-allclear';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const passingVerifier = harness.tools.find((t: any) => t.name === 'passing_verifier');
      const submitCheckpoint = harness.tools.find((t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const preSignalAudit = harness.tools.find((t: any) => t.name === BuiltInToolName.PRE_SIGNAL_AUDIT);
      const signalCompletion = harness.tools.find((t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION);

      // Satisfy all gates
      await passingVerifier.execute('gate-pass', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      await submitCheckpoint.execute('checkpoint', {
        summary: 'all done',
        evidence: 'all green'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Audit must report ready: true
      const auditResult = await preSignalAudit.execute('audit-all-clear', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const audit = auditResult.details;
      expect(audit.ready).toBe(true);
      expect(audit.blockingEvidence).toEqual([]);

      // The real signal_completion('SUCCESS') must ALSO accept (not REJECTED)
      const completion = await signalCompletion.execute('signal-success', {
        outcome: 'SUCCESS',
        summary: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      expect(completion.details).not.toContain('REJECTED');
      expect(completion.details).toContain('Completion signaled with outcome: SUCCESS');

      // Sanity: server received a STATE_TRANSITIONED event
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(receivedEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'STATE_TRANSITIONED' })
      ]));
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
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
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('equivalence: write-set reject — audit ready:false and signal_completion REJECTED when plan contract has gitignored path', async () => {
    // Proves that the SUCCESS-only planWriteSet.validatePlanContract gate is now
    // checked by evaluateGateReadiness: both the audit AND signal_completion
    // reject when the plan contract lists a gitignored file.
    // (Previously the audit omitted this gate — false positive; now it catches it.)
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-psa-equiv-writeset-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath, { recursive: true });

    const beadId = 'bd-psa-equiv-writeset';
    const planContractDir = path.join(tempRoot, '.pi', 'artifacts', beadId);
    const planContractPath = path.join(planContractDir, 'plan-contract.json');

    // Set up worktree as a git repo so that git ls-files and git check-ignore work
    const { execa: exec } = await import('execa');
    await exec('git', ['init'], { cwd: worktreePath });
    await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: worktreePath });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: worktreePath });

    // Add a gitignore that ignores 'secret.txt'
    fs.writeFileSync(path.join(worktreePath, '.gitignore'), 'secret.txt\n');
    await exec('git', ['add', '.gitignore'], { cwd: worktreePath });
    await exec('git', ['commit', '-m', 'init', '--allow-empty-message'], { cwd: worktreePath });

    // Create the plan contract listing the gitignored path
    fs.mkdirSync(planContractDir, { recursive: true });
    fs.writeFileSync(planContractPath, JSON.stringify({ writeSet: ['secret.txt'] }));

    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Implementation
  transactionalState:
    enabled: true
    requireWriteSet: true
  artifacts:
    baseDir: .pi/artifacts
    templates:
      planContract: .pi/artifacts/{{beadId}}/plan-contract.json
states:
  Implementation:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement"
    actions:
      - id: do-work
        type: prompt
        prompt: "Work"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Implementation" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;
    let server: Server | undefined;
    const receivedEvents: unknown[] = [];

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = beadId;
      process.env[EnvVars.STATE_ID] = 'Implementation';
      process.env[EnvVars.ACTION_ID] = 'do-work';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const submitCheckpoint = harness.tools.find((t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const preSignalAudit = harness.tools.find((t: any) => t.name === BuiltInToolName.PRE_SIGNAL_AUDIT);
      const signalCompletion = harness.tools.find((t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION);

      // Accept checkpoint so checkpoint gate is not the blocking reason
      await submitCheckpoint.execute('checkpoint', {
        summary: 'checkpoint evidence',
        evidence: 'ok'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // The plan contract lists 'secret.txt' which is gitignored — this should block
      const auditResult = await preSignalAudit.execute('audit-writeset-fail', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const audit = auditResult.details;

      // Audit must report ready: false, capturing the write-set gate that was
      // previously omitted from pre_signal_audit (false-positive fix).
      expect(audit.ready).toBe(false);
      expect(audit.writeSetValid).toBe(false);
      expect(audit.blockingEvidence).toEqual(
        expect.arrayContaining([
          expect.stringContaining('write-set')
        ])
      );

      // The REAL signal_completion('SUCCESS') must ALSO reject for the same reason
      const completion = await signalCompletion.execute('signal-success', {
        outcome: 'SUCCESS',
        summary: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      expect(completion.details).toContain('REJECTED');
      expect(completion.details).toContain('Plan write-set preflight failed');

      // Sanity: no STATE_TRANSITIONED event was sent
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(receivedEvents.some((e: any) => e.type === 'STATE_TRANSITIONED')).toBe(false);
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
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
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('equivalence: non-SUCCESS outcome — audit(FAILURE) ready:true and signal_completion(FAILURE) accepted after terminal failure', async () => {
    // Proves the outcome dimension is correctly propagated: when a terminal verifier
    // failure mandates FAILURE, the audit evaluated with outcome:FAILURE reports
    // ready:true (does not apply SUCCESS-only gates), and signal_completion(FAILURE)
    // is accepted. Previously the audit always evaluated SUCCESS-only gates even for
    // non-SUCCESS outcomes — a false-negative that would say ready:false for FAILURE.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-psa-equiv-nonsucc-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
tools:
  - name: mandatory_checker
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'mandatory_checker', status: 'PASSED' }));"
  - name: terminal_gate
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'terminal_gate', status: 'REJECTED' })); process.exit(1);"
    failureLimit:
      maxFailuresPerState: 1
      suggestedOutcome: FAILURE
      terminal: true
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
    requiredTools: [mandatory_checker]
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;
    let server: Server | undefined;
    const receivedEvents: unknown[] = [];

    try {
      server = await startSignalAckServer(receivedEvents);
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-psa-equiv-nonsucc';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const terminalGate = harness.tools.find((t: any) => t.name === 'terminal_gate');
      const submitCheckpoint = harness.tools.find((t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const preSignalAudit = harness.tools.find((t: any) => t.name === BuiltInToolName.PRE_SIGNAL_AUDIT);
      const signalCompletion = harness.tools.find((t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION);

      // Trigger terminal failure — now FAILURE outcome is required
      await terminalGate.execute('gate-fail', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Accept checkpoint (required for any signal to go through)
      await submitCheckpoint.execute('checkpoint', {
        summary: 'forced to signal failure',
        evidence: 'terminal gate failed'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // mandatory_checker is required for SUCCESS but NOT for FAILURE.
      // We intentionally skip it to confirm FAILURE path ignores SUCCESS-only gates.

      // Audit with outcome: FAILURE — must report ready: true
      // (terminal limit requires FAILURE, checkpoint is accepted, no FAILURE-path gates blocking)
      const auditFailureResult = await preSignalAudit.execute('audit-failure', {
        outcome: 'FAILURE'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const auditFailure = auditFailureResult.details;
      expect(auditFailure.ready).toBe(true);
      expect(auditFailure.blockingEvidence).toEqual([]);
      expect(auditFailure.outcome).toBe('FAILURE');

      // Audit with default outcome (SUCCESS) — must report ready: false because
      // the terminal limit blocks SUCCESS and mandatory_checker was not invoked.
      const auditSuccessResult = await preSignalAudit.execute('audit-success', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const auditSuccess = auditSuccessResult.details;
      expect(auditSuccess.ready).toBe(false);

      // The real signal_completion('FAILURE') must ALSO accept
      const completion = await signalCompletion.execute('signal-failure', {
        outcome: 'FAILURE',
        summary: 'forced failure after terminal gate'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      expect(completion.details).not.toContain('REJECTED');
      expect(completion.details).toContain('Completion signaled with outcome: FAILURE');

      // Sanity: server received a STATE_FAILED event for FAILURE
      // (FAILURE outcome maps to STATE_FAILED, not STATE_TRANSITIONED)
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(receivedEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'STATE_FAILED' })
      ]));
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
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
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ── s3wp.32 Part 3: pre_signal_audit MCP bridge unavailability surface ────────
//
// Acceptance criterion 3 of s3wp.32: pre_signal_audit must surface MCP bridge
// unavailability for the active bead's required MCP-backed tools when the bridge
// is down.  This mirrors the harness_status and scheduling surfaces (Parts 1+2).

describe('pre_signal_audit — s3wp.32: MCP bridge unavailability (3rd required surface)', () => {
  beforeEach(() => {
    resetMcpBridgeHealthCache();
    setBridgeProbeForTest(undefined);
  });

  afterEach(() => {
    resetMcpBridgeHealthCache();
    setBridgeProbeForTest(undefined);
  });

  it('marks required MCP-backed tools as unavailable when the bridge is down', async () => {
    // Simulate missing @modelcontextprotocol/sdk bridge
    setBridgeProbeForTest(async () => ({
      ok: false as const,
      errorMessage: "Cannot find module '@modelcontextprotocol/sdk/dist/cjs/dist/cjs/client/index.js'",
      errorType: 'Error'
    }));

    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-psa-mcp-down-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    // harness.yaml with an MCP-type required tool (codemap)
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
tools:
  - name: codemap
    type: mcp
    server: codemap-server
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
    requiredTools: [codemap]
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-psa-mcp-down';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const preSignalAudit = harness.tools.find((t: any) => t.name === BuiltInToolName.PRE_SIGNAL_AUDIT);
      expect(preSignalAudit).toBeDefined();

      // Do NOT invoke codemap — audit should report it as unavailable (not never_invoked)
      // because the MCP bridge is down
      const auditResult = await preSignalAudit.execute('audit-mcp-down', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const audit = auditResult.details;

      // ready must be false — MCP unavailability is a blocking infra condition
      expect(audit.ready).toBe(false);

      // The required tool entry for codemap must have state='unavailable'
      const codemapEntry = audit.requiredTools?.find((t: any) => t.name === 'codemap');
      expect(codemapEntry).toBeDefined();
      expect(codemapEntry?.state).toBe('unavailable');
      // reason must name the bridge failure
      expect(codemapEntry?.reason).toContain('MCP bridge down');

      // blockingEvidence must surface the infra blocker with tool name and remediation
      expect(audit.blockingEvidence).toEqual(
        expect.arrayContaining([
          expect.stringContaining('codemap')
        ])
      );
      expect(audit.blockingEvidence.some((e: string) => e.includes('MCP bridge down'))).toBe(true);
      // remediation text should mention the fix
      expect(audit.blockingEvidence.some((e: string) => e.includes('@modelcontextprotocol/sdk'))).toBe(true);
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

  it('does NOT mark required tools as unavailable when the MCP bridge is healthy', async () => {
    // Bridge is healthy — no MCP unavailability signal should appear
    setBridgeProbeForTest(async () => ({ ok: true as const }));

    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-psa-mcp-healthy-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
tools:
  - name: codemap
    type: mcp
    server: codemap-server
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
    requiredTools: [codemap]
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-psa-mcp-healthy';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const preSignalAudit = harness.tools.find((t: any) => t.name === BuiltInToolName.PRE_SIGNAL_AUDIT);
      expect(preSignalAudit).toBeDefined();

      // codemap not invoked — bridge is healthy so state should be never_invoked (not unavailable)
      const auditResult = await preSignalAudit.execute('audit-mcp-healthy', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const audit = auditResult.details;

      // The codemap entry must be never_invoked (not unavailable)
      const codemapEntry = audit.requiredTools?.find((t: any) => t.name === 'codemap');
      expect(codemapEntry).toBeDefined();
      expect(codemapEntry?.state).toBe('never_invoked');
      expect(codemapEntry?.reason).toBeUndefined();

      // blockingEvidence must NOT mention MCP bridge
      expect(audit.blockingEvidence.some((e: string) => e.includes('MCP bridge down'))).toBe(false);
      expect(audit.blockingEvidence.some((e: string) => e.includes('unavailable'))).toBe(false);
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

// ── Part A (mis): zero-target scan gate tests ─────────────────────────────────
//
// A scan result with scannedTargetCount === 0 must NOT satisfy a required
// verifier gate even when its status field is PASSED.  The model must rerun
// the scan against at least one real target for the evidence to count.

describe('signal_completion gate — zero-target scan as required verifier evidence (mis Part A)', () => {
  it('rejects SUCCESS when a required tool returned status=PASSED but scannedTargetCount=0 (vacuous evidence)', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-zero-target-gate-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    // The tool returns status=PASSED but scannedTargetCount=0 — vacuous scan.
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: AdversarialPreReview
tools:
  - name: zero_target_verifier
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'zero_target_verifier', status: 'PASSED', scannedTargetCount: 0 }));"
states:
  AdversarialPreReview:
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review"
    actions:
      - id: adversarial-pre-review
        type: prompt
        prompt: "Review"
    requiredTools: [zero_target_verifier]
    transitions: { SUCCESS: "completed", FAILURE: "AdversarialPreReview" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-zero-target-gate';
      process.env[EnvVars.STATE_ID] = 'AdversarialPreReview';
      process.env[EnvVars.ACTION_ID] = 'adversarial-pre-review';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const zeroTargetTool = harness.tools.find((t: any) => t.name === 'zero_target_verifier');
      const signalCompletion = harness.tools.find((t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION);

      // Invoke the tool: returns PASSED but with zero scanned targets.
      await zeroTargetTool.execute('zero-scan', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // signal_completion with SUCCESS should be REJECTED — the zero-target scan
      // is not accepted as passing verifier evidence.
      const completion = await signalCompletion.execute('signal-success', {
        outcome: 'SUCCESS',
        summary: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      expect(completion.details).toContain('REJECTED: Protocol Violation');
      // Must surface the zero-target scan as the blocking reason.
      expect(completion.details).toContain('zero_target_verifier');
      expect(completion.details).toMatch(/zero.scanned.targets|zero-target scan|zero scanned targets/i);
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

  it('accepts SUCCESS when a required tool returned status=PASSED with scannedTargetCount>=1 (real evidence — no regression)', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-nonzero-target-gate-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    const receivedEvents: unknown[] = [];
    // Tool returns status=PASSED with scannedTargetCount=2 — real scan evidence.
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: AdversarialPreReview
tools:
  - name: real_target_verifier
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'real_target_verifier', status: 'PASSED', scannedTargetCount: 2 }));"
states:
  AdversarialPreReview:
    identity: { role: "Reviewer", expertise: "Review", constraints: [] }
    baseInstructions: "Review"
    actions:
      - id: adversarial-pre-review
        type: prompt
        prompt: "Review"
    requiredTools: [real_target_verifier]
    transitions: { SUCCESS: "completed", FAILURE: "AdversarialPreReview" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;
    let server: import('node:http').Server | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-nonzero-target-gate';
      process.env[EnvVars.STATE_ID] = 'AdversarialPreReview';
      process.env[EnvVars.ACTION_ID] = 'adversarial-pre-review';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      server = await startSignalAckServer(receivedEvents);
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const realTargetTool = harness.tools.find((t: any) => t.name === 'real_target_verifier');
      const submitCheckpoint = harness.tools.find((t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find((t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION);

      // Invoke the tool with real (non-zero) scan targets.
      await realTargetTool.execute('real-scan', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Submit a checkpoint so signal_completion can proceed.
      await submitCheckpoint.execute('checkpoint', { summary: 'checkpoint' }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // signal_completion with SUCCESS should ACCEPT — scannedTargetCount=2 is real evidence.
      const completion = await signalCompletion.execute('signal-real-success', {
        outcome: 'SUCCESS',
        summary: 'done with real targets'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Must NOT be rejected on zero-target grounds.
      expect(completion.details).not.toContain('zero.scanned.targets');
      expect(completion.details).not.toContain('zero-target scan');
      // Should succeed (or fail for unrelated gate reasons — the key assertion is
      // that the zero-target check did NOT fire).
      const wasRejectedForZeroTargets =
        typeof completion.details === 'string'
        && /zero.scanned.targets|zero-target scan|zero scanned targets/i.test(completion.details);
      expect(wasRejectedForZeroTargets).toBe(false);
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
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
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ── signal_completion enforcement: handoverRequired (gate-6a binding) ─────────
//
// s3wp.3 REOPEN fix: signal_completion SUCCESS must be REJECTED when
// handoverRequired=true and no/short handoverSummary, and ACCEPTED when a
// substantive summary exists. These tests drive the REAL signal_completion
// handler (not just evaluateGateReadiness), confirming gate-6a is enforcing.
describe('signal_completion gate — handoverRequired enforcement (s3wp.3)', () => {
  // ── shared helpers ──────────────────────────────────────────────────────────

  function makeHarnessYamlHandover(handoverRequired: boolean): string {
    const handoverLine = handoverRequired ? '        handoverRequired: true' : '';
    return `settings:
  startState: Planning
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
${handoverLine}
    transitions: { SUCCESS: completed, FAILURE: Planning }
`;
  }

  async function setupHandoverHarness(
    tempRoot: string,
    worktreePath: string,
    beadId: string,
    handoverRequired: boolean
  ): Promise<ReturnType<typeof fakePi>> {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), makeHarnessYamlHandover(handoverRequired));
    process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
    process.env[EnvVars.BEAD_ID] = beadId;
    process.env[EnvVars.STATE_ID] = 'Planning';
    process.env[EnvVars.ACTION_ID] = 'formulate-plan';
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = worktreePath;
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
    await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });
    return harness;
  }

  it('rejects SUCCESS when handoverRequired=true and no checkpoint summary was submitted', async () => {
    // The real signal_completion handler must REJECT when the action declares
    // handoverRequired=true and submit_checkpoint was never called.
    // (Checkpoint gate fires first; both gates block — the key assertion is REJECTED.)
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-handover-no-summary-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      harness = await setupHandoverHarness(tempRoot, worktreePath, 'bd-handover-no-summary', true);

      const signalCompletion = harness.tools.find((t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION);
      // Do NOT call submit_checkpoint — no handover summary recorded.
      const result = await signalCompletion.execute('signal-no-handover', {
        outcome: 'SUCCESS',
        summary: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Must be REJECTED (checkpoint gate or handover gate — both block)
      expect(result.details).toContain('REJECTED');
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
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects SUCCESS when handoverRequired=true and checkpoint summary is too short', async () => {
    // submit_checkpoint is called but with a trivially short summary ("done" < MIN_SUMMARY_CHARS=20 chars).
    // The checkpoint gate is satisfied but the handoverRequired gate must still REJECT signal_completion SUCCESS.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-handover-short-summary-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    const receivedEvents: unknown[] = [];
    let harness: ReturnType<typeof fakePi> | undefined;
    let server: import('node:http').Server | undefined;

    try {
      process.chdir(tempRoot);
      server = await startSignalAckServer(receivedEvents);
      harness = await setupHandoverHarness(tempRoot, worktreePath, 'bd-handover-short-summary', true);

      const submitCheckpoint = harness.tools.find((t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find((t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION);

      // Short summary: 4 chars < MIN_SUMMARY_CHARS=20
      const shortSummary = 'done';
      await submitCheckpoint.execute('checkpoint', {
        summary: shortSummary,
        evidence: shortSummary
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const result = await signalCompletion.execute('signal-short-handover', {
        outcome: 'SUCCESS',
        summary: shortSummary
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Must be REJECTED with the handoverRequired blocking reason
      expect(result.details).toContain('REJECTED');
      expect(result.details).toContain('handoverRequired');
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
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
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('accepts SUCCESS when handoverRequired=true and checkpoint has substantive summary', async () => {
    // A checkpoint with a summary of >= MIN_SUMMARY_CHARS=20 characters satisfies the
    // handoverRequired gate — signal_completion SUCCESS must be ACCEPTED.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-handover-ok-summary-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    const receivedEvents: unknown[] = [];
    let harness: ReturnType<typeof fakePi> | undefined;
    let server: import('node:http').Server | undefined;

    try {
      process.chdir(tempRoot);
      server = await startSignalAckServer(receivedEvents);
      harness = await setupHandoverHarness(tempRoot, worktreePath, 'bd-handover-ok-summary', true);

      const submitCheckpoint = harness.tools.find((t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find((t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION);

      // Substantive summary: well over MIN_SUMMARY_CHARS=20
      const substantiveSummary = 'Completed planning phase with full analysis of requirements and acceptance criteria.';
      await submitCheckpoint.execute('checkpoint', {
        summary: substantiveSummary,
        evidence: substantiveSummary
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const result = await signalCompletion.execute('signal-with-handover', {
        outcome: 'SUCCESS',
        summary: substantiveSummary
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Must NOT be rejected for handoverRequired — gate is satisfied
      expect(result.details).not.toContain('handoverRequired');
      expect(result.details).toContain('Completion signaled with outcome: SUCCESS');
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
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
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('accepts SUCCESS when handoverRequired=false (default), even with only a short summary', async () => {
    // When handoverRequired is not set (defaults to false), the handover gate
    // must be silent — signal_completion SUCCESS must be ACCEPTED.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-handover-not-required-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    const receivedEvents: unknown[] = [];
    let harness: ReturnType<typeof fakePi> | undefined;
    let server: import('node:http').Server | undefined;

    try {
      process.chdir(tempRoot);
      server = await startSignalAckServer(receivedEvents);
      // handoverRequired=false (not set → default false)
      harness = await setupHandoverHarness(tempRoot, worktreePath, 'bd-handover-not-required', false);

      const submitCheckpoint = harness.tools.find((t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find((t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION);

      // Short summary — fine when handoverRequired=false
      await submitCheckpoint.execute('checkpoint', {
        summary: 'done',
        evidence: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const result = await signalCompletion.execute('signal-no-handover-required', {
        outcome: 'SUCCESS',
        summary: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Must NOT be rejected for handoverRequired (field not set → gate is silent)
      expect(result.details).not.toContain('handoverRequired');
      expect(result.details).toContain('Completion signaled with outcome: SUCCESS');
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
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
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('accepts FAILURE when handoverRequired=true (handover gate never fires on non-advance outcomes)', async () => {
    // FAILURE is not an advance outcome — the handoverRequired gate must be silent
    // even when handoverRequired=true and only a short summary was submitted.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
      apiBase: process.env[EnvVars.API_BASE]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-handover-failure-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    const receivedEvents: unknown[] = [];
    let harness: ReturnType<typeof fakePi> | undefined;
    let server: import('node:http').Server | undefined;

    try {
      process.chdir(tempRoot);
      server = await startSignalAckServer(receivedEvents);
      // handoverRequired=true but we will signal FAILURE (non-advance outcome)
      harness = await setupHandoverHarness(tempRoot, worktreePath, 'bd-handover-failure', true);

      const submitCheckpoint = harness.tools.find((t: any) => t.name === BuiltInToolName.SUBMIT_CHECKPOINT);
      const signalCompletion = harness.tools.find((t: any) => t.name === BuiltInToolName.SIGNAL_COMPLETION);

      // Short summary — would fail the handover gate if this were SUCCESS
      await submitCheckpoint.execute('checkpoint', {
        summary: 'done',
        evidence: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const result = await signalCompletion.execute('signal-failure-handover', {
        outcome: 'FAILURE',
        summary: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Must NOT be rejected for handoverRequired on a FAILURE outcome
      expect(result.details).not.toContain('handoverRequired');
      expect(result.details).toContain('Completion signaled with outcome: FAILURE');
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await closeServer(server);
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
      if (previousEnv.apiBase === undefined) delete process.env[EnvVars.API_BASE];
      else process.env[EnvVars.API_BASE] = previousEnv.apiBase;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
