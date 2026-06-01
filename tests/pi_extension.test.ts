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
import { BuiltInToolName, EnvVars, NativePiToolName, PiEventName, PluginToolName, ProcessFlag } from '../src/constants/index.js';

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
        command: 1,
        nativeExtension: 1,
        nativeMcpFooterMeaning: expect.stringContaining('does not report Orr Else configured MCP-backed project tools')
      });
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
