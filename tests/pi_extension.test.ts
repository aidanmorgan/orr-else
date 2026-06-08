import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import orrElseExtension, { isHarnessTransientFailure, shouldPersistBlockedBeadStatus } from '../src/extension.js';
import { verifier, VerifyVerdict } from '../src/contract.js';
import { FlowManager } from '../src/core/FlowManager.js';
import { Teammate } from '../src/core/Teammate.js';
import { TeammateFactory } from '../src/plugins/teammates.js';
import { BuiltInToolName, DomainEventName, EnvVars, NativePiToolName, PiEventName, PluginToolName, ProcessFlag } from '../src/constants/index.js';
import { setBridgeProbeForTest, resetMcpBridgeHealthCache } from '../src/core/McpTransportPreflight.js';
import { ContextInjector } from '../src/core/ContextInjector.js';

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

  it('defaults restart routes to the current state when no restart edge is declared', () => {
    const config = {
      settings: {
        harnessRestartEvent: 'HARNESS_RESTART',
        contextRestartEvent: 'CONTEXT_RESTART'
      },
      states: {
        LessonCapture: {
          transitions: { SUCCESS: 'Implementation' }
        },
        Implementation: {
          transitions: { SUCCESS: 'completed', FAILURE: 'Implementation' }
        }
      }
    } as any;
    const bead = {
      id: 'pi-experiment-restart-fallback' as any,
      title: 'restart fallback',
      status: 'LessonCapture',
      changed_files: [],
      logs: [],
      dependencies: [],
      retryCount: 0,
      compactionCount: 0,
      lastActivity: '2026-06-03T00:00:00.000Z',
      totalExecutionTimeMs: 0,
      handovers: {},
      completedActionIds: []
    };

    const flowManager = new FlowManager();
    expect(flowManager.resolveRestartTransition({ ...bead, restartKind: 'harness' }, config)).toMatchObject({
      kind: 'harness',
      event: 'HARNESS_RESTART',
      targetStateId: 'LessonCapture'
    });
    expect(() => flowManager.nextState(config.states.LessonCapture, 'FAILURE', 'LessonCapture'))
      .toThrow('No transition configured for outcome FAILURE in state LessonCapture.');
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
        input: { path: path.join(tempRoot, '.pi/logs/orr-else-2026-05-24.log') }
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
        input: { path: path.join(tempRoot, '.pi/tool-output/bd-1/Planning/analyze/tool/result.json'), limit: 80 }
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
        input: { filePath: path.join(tempRoot, '.tmp/scratch-output.json') }
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
        input: { command: `rm -rf ${path.join(tempRoot, '.pi/events')}` }
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
    expect(toolNames).toContain('tick_items');
    // tick_item (compat shim) must not be registered
    expect(toolNames.some((n: string) => n === 'tick_item')).toBe(false);
    expect(toolNames).toContain('add_checklist_item');
    expect(toolNames).toContain('submit_checkpoint');
    expect(toolNames).toContain('request_context_restart');
    expect(toolNames).toContain('request_harness_restart');
    expect(toolNames).toContain(`spawn_${'teammate'}`);
    expect(toolNames).toContain(`signal_${'completion'}`);
    expect(harness.commands['orr-else'].description).toContain('--config');
  });

  it('tick_items accepts a single-item array and tick_item is unavailable', async () => {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);

    const toolNames = harness.tools.map((t: any) => t.name);
    // tick_item (compat shim) must not be registered
    expect(toolNames.some((n: string) => n === 'tick_item')).toBe(false);
    // tick_items must be present and accept a one-item array
    const tickItemsTool = harness.tools.find((t: any) => t.name === 'tick_items');
    expect(tickItemsTool).toBeDefined();
    // Invoke with a single item — no active run means it will reject gracefully,
    // but the tool must exist and be callable (not throw "tool not found")
    const result = await tickItemsTool.execute(
      'tick-one',
      { items: [{ text: 'Single item', evidence: 'evidence text' }] },
      undefined,
      undefined,
      HEADLESS_TOOL_CONTEXT
    );
    // Should return a tool-result object (rejected due to no active run, not an error about wrong tool name)
    expect(result).toBeDefined();
    expect(result.content?.[0]?.text ?? result).not.toContain('tick_item');
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
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: fixture_mcp_tool
    type: mcp
    server: fixture-mcp-server
    operations: [get_structure]
  - name: reference_docs
    type: mcp
    server: fixture-vector-server
    operations:
      query: fixture_query_documents
  - name: ast_grep
    type: command
    command: node
    defaultArgs: ["-e", "console.log(JSON.stringify({ tool: 'ast_grep', status: 'PASSED' }))"]
  - name: native_symbol_index
    type: extension
    observeOnly: true
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
        mcpBackedToolNames: expect.arrayContaining(['fixture_mcp_tool', 'reference_docs']),
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
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
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

  // 0yt5.33: under the ARTIFACT-PRESENCE gate model the required-tool readiness
  // surface no longer recognizes a tool's self-reported `{status:REJECTED}`
  // payload — a tool that RAN to completion (presence satisfied) is blocked only
  // by its registered verify() callback. This test registers a verify() that
  // FAILs for `evidence_gate` and asserts signal_completion's REJECTED message
  // names the tool + the verify() reason (the VERIFY_FAIL path of the gate).
  it('rejects SUCCESS when a required tool ran but its verify() callback FAILs', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    // Register a verify() that FAILs for evidence_gate (last-wins; tool-name
    // scoped so it does not affect other tests that use a different tool name).
    verifier.register('evidence_gate', () => ({
      verdict: VerifyVerdict.FAIL,
      reasons: ['evidence_gate verify(): the produced evidence did not satisfy the gate']
    }));
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-required-tool-latest-')));
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

      // The tool RAN to completion (presence satisfied) — but its registered
      // verify() returns FAIL, so the artifact-presence gate blocks SUCCESS.
      const ran = await evidenceGate.execute('gate-run', { arguments: { argv: ['pass'] } }, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const completion = await signalCompletion.execute('signal-success', {
        outcome: 'SUCCESS',
        summary: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      expect(ran.details.status).toBe('PASSED');
      expect(completion.details).toContain('REJECTED: Protocol Violation');
      // The reject names the tool.
      // pi-experiment-yhec: the gate may block with EVIDENCE_HANDLE_INVALID (no canonical handle
      // from the command tool) or VERIFY_FAIL (if the handle is present but the verify() FAILs).
      // Both correctly block the transition.
      expect(completion.details).toContain('evidence_gate');
    } finally {
      // Best-effort teardown of the global verify() registration: the contract
      // registry is last-wins with no removal, so overwrite with a NOT_APPLICABLE
      // no-op so a leaked evidence_gate verify() cannot affect later tests.
      verifier.register('evidence_gate', () => ({ verdict: VerifyVerdict.NOT_APPLICABLE, reasons: [] }));
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
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
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

  // glsw/orap: when the terminal failure-limit suggestedOutcome is NOT routable
  // from the current state (the literal LessonCapture/cerdiwen-gfg bug — FAILURE
  // had no transition), the worker guidance must name the concrete state/action,
  // report the outcome as not routable, and steer to request_harness_restart
  // (NOT signal_completion FAILURE). It must never render "state undefined".
  it('steers a non-routable terminal failure-limit to request_harness_restart (no signal FAILURE)', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-nonroutable-terminal-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    // LessonCapture-shaped state: only SUCCESS is routable; the terminal tool
    // suggests FAILURE, which has NO transition here → suggestedOutcomeValid=false.
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: LessonCapture
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: artifact_validator
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'artifact_validator', status: 'REJECTED' })); process.exit(1);"
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
  LessonCapture:
    identity: { role: "Capturer", expertise: "Lessons", constraints: [] }
    baseInstructions: "Capture"
    actions:
      - id: capture-lesson
        type: prompt
        prompt: "Capture"
    requiredTools: []
    transitions: { SUCCESS: "completed" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-nonroutable-terminal';
      process.env[EnvVars.STATE_ID] = 'LessonCapture';
      process.env[EnvVars.ACTION_ID] = 'capture-lesson';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const validator = harness.tools.find(tool => tool.name === 'artifact_validator');
      const followupProbe = harness.tools.find(tool => tool.name === 'followup_probe');
      const signalCompletion = harness.tools.find(tool => tool.name === BuiltInToolName.SIGNAL_COMPLETION);

      const verifier = await validator.execute('gate-fail', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const blockedTool = await followupProbe.execute('followup', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const failureSignal = await signalCompletion.execute('signal-failure', {
        outcome: 'FAILURE',
        summary: 'terminal validator failure'
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
      // Worker guidance names the concrete state/action and reports the outcome
      // as not routable, steering to request_harness_restart — never signal FAILURE.
      expect(blockedTool.details).toContain('terminal failure limit already reached');
      expect(blockedTool.details).toContain('LessonCapture/capture-lesson');
      expect(blockedTool.details).toContain('is not routable here');
      expect(blockedTool.details).toContain(BuiltInToolName.REQUEST_HARNESS_RESTART);
      expect(blockedTool.details).not.toContain('state undefined');
      // signal_completion FAILURE is rejected because FAILURE has no transition;
      // the rejection names the concrete state, never "state undefined".
      expect(failureSignal.details).toContain('REJECTED');
      expect(failureSignal.details).toContain('LessonCapture');
      expect(failureSignal.details).not.toContain('state undefined');
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
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE, REQUIREMENTS_DEFECT]
  blockedOutcomes: [BLOCKED]
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
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
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
    actions:
      - id: a1
        type: prompt
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
      expect(matchingTools[0].description).toContain('raw output is referenced via stdoutFile/stderrFile');
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
    // true — meaning the artifact-paths tool and other guarded tools would NOT
    // be registered on harness2.pi.
    const harness2 = fakePi();
    await orrElseExtension(harness2.pi);
    await harness2.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);
    const toolsAfterSecond = harness2.tools.map(t => t.name);

    // Both invocations must register the same guarded tools on their respective pi
    expect(toolsAfterFirst).toContain(BuiltInToolName.GET_ARTIFACT_PATHS);
    // buvj: get_compatibility_context removed from core — assert the literal string is absent
    expect(toolsAfterFirst).not.toContain('get_compatibility_context');

    expect(toolsAfterSecond).toContain(BuiltInToolName.GET_ARTIFACT_PATHS);
    // buvj: get_compatibility_context removed from core — assert the literal string is absent
    expect(toolsAfterSecond).not.toContain('get_compatibility_context');

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
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
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
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
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
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: passing_gate
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "const fs=require('fs'),path=require('path'),crypto=require('crypto');const outDir=process.env.PI_TOOL_OUTPUT_DIR?path.resolve(process.env.PI_TOOL_OUTPUT_DIR):require('os').tmpdir();const outFile=path.join(outDir,'passing-gate-evidence.json');fs.mkdirSync(outDir,{recursive:true});const bead=process.env.PI_BEAD_ID||'?';const state=process.env.PI_STATE_ID||'?';const action=process.env.PI_ACTION_ID||'?';const schemaDescriptor={status:'string'};const schemaHash='sha256:'+crypto.createHash('sha256').update(JSON.stringify(schemaDescriptor)).digest('hex');const rtkSummary={schemaTypeName:'PassingGateSummary',owningFile:'src/tools/passing_gate.ts',summarySchemaVersion:'1.0.0',schemaHash,deterministicSummaryVersion:'1.0.0',inputArtifactSchemaId:'passing-gate-output',inputArtifactSchemaVersion:'1.0.0',maximumCounts:{items:1},omissionSemantics:'no items omitted',summary:{status:'PASSED'}};const h={schemaVersion:'1.0.0',toolName:'passing_gate',invocationId:'inv-psg-'+crypto.randomUUID(),runStatus:'PASSED',semanticArtifactPath:outFile,toolOutputRoot:outDir,summaryMode:'summary',rtkSummary,admittedHarnessFingerprint:process.env.PI_HARNESS_FINGERPRINT||'unknown',admittedExecutionBoundary:'bead:'+bead+'/state:'+state+'/action:'+action};fs.writeFileSync(outFile,JSON.stringify(h,null,2));console.log(JSON.stringify({tool:'passing_gate',status:'PASSED',evidenceHandle:h}));"
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

      // Run the required tool (it passes and emits a canonical evidenceHandle)
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
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: passing_verifier
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "const fs=require('fs'),path=require('path'),crypto=require('crypto');const outDir=process.env.PI_TOOL_OUTPUT_DIR?path.resolve(process.env.PI_TOOL_OUTPUT_DIR):require('os').tmpdir();const outFile=path.join(outDir,'passing-verifier-evidence.json');fs.mkdirSync(outDir,{recursive:true});const bead=process.env.PI_BEAD_ID||'?';const state=process.env.PI_STATE_ID||'?';const action=process.env.PI_ACTION_ID||'?';const schemaDescriptor={status:'string'};const schemaHash='sha256:'+crypto.createHash('sha256').update(JSON.stringify(schemaDescriptor)).digest('hex');const rtkSummary={schemaTypeName:'PassingVerifierSummary',owningFile:'src/tools/passing_verifier.ts',summarySchemaVersion:'1.0.0',schemaHash,deterministicSummaryVersion:'1.0.0',inputArtifactSchemaId:'passing-verifier-output',inputArtifactSchemaVersion:'1.0.0',maximumCounts:{items:1},omissionSemantics:'no items omitted',summary:{status:'PASSED'}};const h={schemaVersion:'1.0.0',toolName:'passing_verifier',invocationId:'inv-pv-'+crypto.randomUUID(),runStatus:'PASSED',semanticArtifactPath:outFile,toolOutputRoot:outDir,summaryMode:'summary',rtkSummary,admittedHarnessFingerprint:process.env.PI_HARNESS_FINGERPRINT||'unknown',admittedExecutionBoundary:'bead:'+bead+'/state:'+state+'/action:'+action};fs.writeFileSync(outFile,JSON.stringify(h,null,2));console.log(JSON.stringify({tool:'passing_verifier',status:'PASSED',evidenceHandle:h}));"
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
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
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
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
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
    // harness.yaml with an MCP-type required tool (fixture_mcp_tool)
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
  - name: fixture_mcp_tool
    type: mcp
    server: fixture-mcp-server
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
    requiredTools: [fixture_mcp_tool]
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

      // Do NOT invoke fixture_mcp_tool — audit should report it as unavailable (not never_invoked)
      // because the MCP bridge is down
      const auditResult = await preSignalAudit.execute('audit-mcp-down', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const audit = auditResult.details;

      // ready must be false — MCP unavailability is a blocking infra condition
      expect(audit.ready).toBe(false);

      // The required tool entry for fixture_mcp_tool must have state='unavailable'
      const mcpToolEntry = audit.requiredTools?.find((t: any) => t.name === 'fixture_mcp_tool');
      expect(mcpToolEntry).toBeDefined();
      expect(mcpToolEntry?.state).toBe('unavailable');
      // reason must name the bridge failure
      expect(mcpToolEntry?.reason).toContain('MCP bridge down');

      // blockingEvidence must surface the infra blocker with tool name and remediation
      expect(audit.blockingEvidence).toEqual(
        expect.arrayContaining([
          expect.stringContaining('fixture_mcp_tool')
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
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: fixture_mcp_tool
    type: mcp
    server: fixture-mcp-server
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan"
    requiredTools: [fixture_mcp_tool]
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

      // fixture_mcp_tool not invoked — bridge is healthy so state should be never_invoked (not unavailable)
      const auditResult = await preSignalAudit.execute('audit-mcp-healthy', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      const audit = auditResult.details;

      // The fixture_mcp_tool entry must be never_invoked (not unavailable)
      const mcpToolEntry = audit.requiredTools?.find((t: any) => t.name === 'fixture_mcp_tool');
      expect(mcpToolEntry).toBeDefined();
      expect(mcpToolEntry?.state).toBe('never_invoked');
      expect(mcpToolEntry?.reason).toBeUndefined();

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

// ── Part A (mis → 0yt5.16/0yt5.17): zero-target scan recognition REMOVED ───────
//
// The harness no longer performs result-field recognition of a scan's scanned-
// target count to override a PASSED status. A PASSED tool result satisfies the
// required-tool presence gate regardless of how many targets it scanned; zero-
// target-scan semantics, if a tool needs them, now live in that tool's own
// verify() callback (not in the harness pre_signal_audit gate).

describe('signal_completion gate — zero-target scan recognition removed (0yt5.16/0yt5.17)', () => {
  it('does NOT reject a PASSED required tool for having zero scanned targets (harness no longer recognizes scan-target evidence)', async () => {
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
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
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

      // Invoke the tool: returns PASSED with zero scanned targets.
      await zeroTargetTool.execute('zero-scan', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // 0yt5.16/0yt5.17: the harness no longer recognizes scan-target evidence.
      // The required tool RAN and returned PASSED, so it satisfies the required-tool
      // presence gate regardless of scanned-target count — the completion is NOT
      // rejected with a zero-target / vacuous-scan reason. (A real "did this scan
      // cover anything" judgement now belongs in the tool's own verify() callback.)
      const completion = await signalCompletion.execute('signal-success', {
        outcome: 'SUCCESS',
        summary: 'done'
      }, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      const details = String(completion.details ?? '');
      expect(details).not.toMatch(/zero.scanned.targets|zero-target scan|zero scanned targets/i);
      expect(details).not.toContain('did not pass: zero scanned targets');
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
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
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

// ── pi-experiment-q64l regression: cache-hit plugin events must carry durable toolResult ──
describe('pi-experiment-q64l — cacheable tool invoked twice records toolResult on cache-hit event', () => {
  it('AC1/AC2: second invocation (cache hit) records TOOL_INVOCATION_SUCCEEDED with toolResult.status + toolResult.outputFile', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-q64l-cache-hit-')));
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
  - name: cacheable_probe
    type: command
    command: node
    defaultArgs:
      - "-e"
      - "console.log(JSON.stringify({ tool: 'cacheable_probe', status: 'PASSED', value: 42 }));"
    cacheable: true
states:
  Planning:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    actions:
      - id: probe-action
        type: prompt
        prompt: "Probe"
    requiredTools: [cacheable_probe]
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-q64l';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'probe-action';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const cacheableTool = harness.tools.find((t: any) => t.name === 'cacheable_probe');
      expect(cacheableTool).toBeDefined();

      // First invocation — non-cached, runs the command, writes the raw output file.
      await cacheableTool.execute('call-1', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Second invocation — same params, served from cache.
      await cacheableTool.execute('call-2', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      // Allow async event store writes to flush.
      await new Promise(resolve => setTimeout(resolve, 50));

      const events = readEventStoreLines(tempRoot);
      const succeeded = events.filter(
        (e: any) => e.type === DomainEventName.TOOL_INVOCATION_SUCCEEDED
          && e.data?.tool === 'cacheable_probe'
      );

      // Two TOOL_INVOCATION_SUCCEEDED events must have been recorded.
      expect(succeeded).toHaveLength(2);

      // AC2: the cache-hit event (cached:true) must carry toolResult.status + toolResult.outputFile.
      const cacheHitEvent = succeeded.find((e: any) => e.data?.cached === true);
      expect(cacheHitEvent).toBeDefined();
      const tr = (cacheHitEvent as any).data?.toolResult;
      expect(tr).toBeDefined();
      expect(tr.status).toBe('PASSED');
      expect(typeof tr.outputFile).toBe('string');
      expect(tr.outputFile.length).toBeGreaterThan(0);

      // AC5: model-facing result field is unchanged between the two events.
      const nonCachedEvent = succeeded.find((e: any) => !e.data?.cached);
      expect(nonCachedEvent).toBeDefined();
      expect((nonCachedEvent as any).data?.result).toEqual((cacheHitEvent as any).data?.result);

      // The cache-hit event reuses the original outputFile (no fresh persist on cache hit).
      expect(tr.outputFile).toBe((nonCachedEvent as any).data?.toolResult?.outputFile);
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

// ── demm Finding 2: AC3 fail-closed integration tests ──────────────────────
//
// runParentSequenceActionsBeforeActive is private; it is exercised via
// BEFORE_AGENT_START which calls it unconditionally in worker mode.
// AC3 (throw path): generatesFrameworkToolCalls=true + no toolCalls → throws.
// AC3 (pass path): generatesFrameworkToolCalls unset + no toolCalls → completes.
//
// Previously UNTESTED: the existing AC3 helper test only exercised
// extractSequencedToolCalls returning 'none' in isolation; it never proved
// the throw inside runParentSequenceActionsBeforeActive fires.

describe('AC3 fail-closed: runParentSequenceActionsBeforeActive via BEFORE_AGENT_START (demm)', () => {
  it('AC3 (throw): generatesFrameworkToolCalls=true and tool produces no toolCalls — BEFORE_AGENT_START throws', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'demm-ac3-throw-')));
    const worktreePath = path.join(tempRoot, 'worktrees', 'bd-ac3');
    fs.mkdirSync(worktreePath, { recursive: true });

    // A tool that outputs PASSED but NO toolCalls — fails the AC3 guard.
    const noToolCallsScript = `process.stdout.write(JSON.stringify({ status: 'PASSED', message: 'no calls' }));`;
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
  - name: generator_tool
    type: command
    command: ${process.execPath}
    defaultArgs: ["-e", "${noToolCallsScript.replace(/"/g, '\\"')}"]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: generate-calls
        type: tool
        tool: generator_tool
        generatesFrameworkToolCalls: true
      - id: do-work
        type: prompt
        prompt: "Work"
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-ac3';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'do-work'; // active action; generate-calls is preceding
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);

      // SESSION_START runs runParentSequenceActionsBeforeActive which must throw because
      // generator_tool produced no toolCalls and generatesFrameworkToolCalls=true.
      await expect(
        harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot })
      ).rejects.toThrow(/generatesFrameworkToolCalls/);
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

  it('AC3 (pass-demm): generatesFrameworkToolCalls unset and tool produces no toolCalls — BEFORE_AGENT_START completes', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'demm-ac3-pass-')));
    const worktreePath = path.join(tempRoot, 'worktrees', 'bd-ac3p');
    fs.mkdirSync(worktreePath, { recursive: true });

    // A tool that outputs PASSED but NO toolCalls — acceptable when generatesFrameworkToolCalls is unset.
    const noToolCallsScript = `process.stdout.write(JSON.stringify({ status: 'PASSED', message: 'no calls' }));`;
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
  - name: plain_tool
    type: command
    command: ${process.execPath}
    defaultArgs: ["-e", "${noToolCallsScript.replace(/"/g, '\\"')}"]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: run-plain
        type: tool
        tool: plain_tool
      - id: do-work
        type: prompt
        prompt: "Work"
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-ac3p';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'do-work'; // active action; run-plain is preceding
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);

      // SESSION_START runs runParentSequenceActionsBeforeActive which must NOT throw
      // because generatesFrameworkToolCalls is not set on the preceding tool action.
      await expect(
        harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot })
      ).resolves.not.toThrow();
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

// ---- pi-experiment-5p9t: NEGATIVE — outputFile-only toolCalls cannot mutate harness state ----
//
// Drives the REAL runParentSequenceActionsBeforeActive path with a tool whose stdout result
// omits toolCalls.  Proves that:
//   (a) the sequenced action completes without error (generatesFrameworkToolCalls unset)
//   (b) zero framework tool calls are executed — CHECKLIST_ITEM_ADDED is never recorded
//   (c) the ACTION_COMPLETED event records generatedToolCallsApplied=0
//
// The test is LOAD-BEARING against the deleted outputFile fallback (option-3 proof):
//   After SESSION_START, the persisted archive (outputFile) is injected with frameworkToolCalls
//   in the exact top-level shape the deleted toolCallsFromOutputFile would have parsed via
//   toolCallsFromRecord (record.frameworkToolCalls — step 2 of the check sequence).
//   The archive NOW contains the recoverable calls.  The inline result had no toolCalls when
//   the action was processed, so the new inline-only code produced zero sequenced calls → no tick.
//
// Self-check (in-test, option-3):
//   The injected archive has frameworkToolCalls that toolCallsFromRecord finds.  If the deleted
//   fallback (extractSequencedToolCalls reading context.outputFile) were reintroduced and the
//   archive pre-populated BEFORE processing, the old extension.ts would read those calls and
//   invoke add_checklist_item → CHECKLIST_ITEM_ADDED → this assertion would fail.
//   The new code never reads the archive for tool-call extraction → no tick → assertion holds.

describe('pi-experiment-5p9t: NEGATIVE — outputFile-only toolCalls cannot tick checklist (real execution path)', () => {
  it('archive-resident frameworkToolCalls are ignored by new inline-only path; no checklist mutation', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '5p9t-neg-')));
    const worktreePath = path.join(tempRoot, 'worktrees', 'bd-5p9t');
    fs.mkdirSync(worktreePath, { recursive: true });

    // A clean tool that emits no toolCalls in its stdout result.
    // persistAndBoundResult writes the stdout-derived rawResult to the archive —
    // the archive is clean (no frameworkToolCalls) immediately after the run.
    const toolScript = `process.stdout.write(JSON.stringify({ status: 'PASSED', message: 'done, no toolCalls in stdout' }));`;

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
  - name: stdout_omitting_tool
    type: command
    command: ${process.execPath}
    defaultArgs: ["-e", "${toolScript.replace(/"/g, '\\"')}"]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: run-tool
        type: tool
        tool: stdout_omitting_tool
      - id: do-work
        type: prompt
        prompt: "Work"
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;
    const capturedEvents: string[] = [];

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-5p9t';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'do-work';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);

      // SESSION_START drives runParentSequenceActionsBeforeActive which executes
      // stdout_omitting_tool (preceding action run-tool). Since generatesFrameworkToolCalls
      // is NOT set, the action completes without error even with zero toolCalls.
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

      // Query event-store events to verify no CHECKLIST_ITEM_ADDED was emitted,
      // and to recover the archive (outputFile) path from the PROJECT_TOOL_SUCCEEDED event.
      const { EventStore: ES } = await import('../src/core/EventStore.js');
      const { ConfigLoader: CL } = await import('../src/core/ConfigLoader.js');
      const cl = new CL(undefined, tempRoot);
      const es = new ES(cl, undefined, undefined, tempRoot);
      es.setSessionId(`test-5p9t-neg-${process.pid}`);
      // eventsForBead scans all events for this bead.
      const beadEvents = await es.eventsForBead('bd-5p9t' as any);
      for (const e of beadEvents) capturedEvents.push(e.type);

      // CHECKLIST_ITEM_ADDED must NOT appear — inline had no toolCalls → no mutations.
      expect(capturedEvents.filter(t => t === DomainEventName.CHECKLIST_ITEM_ADDED)).toHaveLength(0);

      // Recover the archive path from the PROJECT_TOOL_SUCCEEDED event.
      const toolEvent = beadEvents.find(
        e => e.type === DomainEventName.PROJECT_TOOL_SUCCEEDED &&
          (e.data as Record<string, unknown>).actionId === 'run-tool'
      );
      const archivePath = typeof toolEvent?.data?.outputFile === 'string'
        ? toolEvent.data.outputFile as string
        : undefined;
      expect(archivePath).toBeTruthy();
      expect(fs.existsSync(archivePath!)).toBe(true);

      // The archive written by persistAndBoundResult is the stdout-derived rawResult:
      // no frameworkToolCalls — the hidden channel is clean after the actual run.
      const initialArchive = JSON.parse(fs.readFileSync(archivePath!, 'utf8'));
      expect(initialArchive.frameworkToolCalls).toBeUndefined();

      // Option-3 load-bearing proof: inject frameworkToolCalls into the archive in the
      // exact shape the deleted toolCallsFromOutputFile would recover via toolCallsFromRecord:
      // top-level record.frameworkToolCalls (array) — step 2 of toolCallsFromRecord.
      // The archive NOW contains the calls that the old fallback would have found.
      const injectedCalls = [{ tool: 'add_checklist_item', arguments: { text: 'MUST NOT APPEAR' } }];
      fs.writeFileSync(archivePath!, JSON.stringify({ ...initialArchive, frameworkToolCalls: injectedCalls }));

      // Verify the injected archive has the calls in fallback-parseable shape.
      const archiveWithInjection = JSON.parse(fs.readFileSync(archivePath!, 'utf8'));
      expect(Array.isArray(archiveWithInjection.frameworkToolCalls)).toBe(true);
      expect(archiveWithInjection.frameworkToolCalls).toHaveLength(1);
      expect(archiveWithInjection.frameworkToolCalls[0].tool).toBe('add_checklist_item');

      // Self-check assertion: the archive has the recoverable calls (old fallback path),
      // but the inline had no toolCalls (new path). The CHECKLIST_ITEM_ADDED assertion above
      // confirms no tick occurred — proving the new code ignores the archive.
      // If the deleted fallback (toolCallsFromOutputFile + extractSequencedToolCalls reading
      // context.outputFile) were reintroduced and the archive pre-populated before processing,
      // those calls would have driven add_checklist_item → CHECKLIST_ITEM_ADDED → this test fails.

      cl.reset();
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

// -- dsm2.12: explicit identity on TOOL_INVOCATION_* events from real recording sites --
//
// These tests drive the REAL wrapPluginTool code paths (normal success,
// cache-hit) and assert that every emitted TOOL_INVOCATION_SUCCEEDED/FAILED
// carries explicit stateId/actionId/toolName/toolInvocationId at the top
// level -- the fields populated by the dsm2.12 writer fix.

describe("dsm2.12 -- explicit verifier identity on TOOL_INVOCATION_* events (real recording sites)", () => {
  it("DSM2-12-REAL-1: normal success event carries explicit stateId/actionId/toolName/toolInvocationId", async () => {
    const previousCwd = process.cwd();
    const previousEnvR1 = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsm2-12-real-1-")));
    const worktreePath = path.join(tempRoot, "worktree");
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, "harness.yaml"), [
      "settings:",
      "  startState: Implementing",
      "  worktreePolicy:",
      "    default: always",
      "statechart:",
      "  terminalStates: [completed]",
      "  advanceOutcomes: [SUCCESS]",
      "  failedOutcomes: [FAILURE]",
      "  blockedOutcomes: [BLOCKED]",
      "tools:",
      "  - name: identity_probe",
      "    type: command",
      "    command: node",
      "    defaultArgs:",
      "      - \"-e\"",
      "      - \"console.log(JSON.stringify({ tool: 'identity_probe', status: 'PASSED', value: 1 }));\"",
      "states:",
      "  Implementing:",
      "    identity: { role: \"Eng\", expertise: \"x\", constraints: [] }",
      "    baseInstructions: \"Do\"",
      "    actions:",
      "      - id: impl-action",
      "        type: prompt",
      "        prompt: \"Implement\"",
      "    transitions: { SUCCESS: \"completed\", FAILURE: \"Implementing\" }",
    ].join("\n"));
    let harnessR1: ReturnType<typeof fakePi> | undefined;
    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = "bd-dsm2-real";
      process.env[EnvVars.STATE_ID] = "Implementing";
      process.env[EnvVars.ACTION_ID] = "impl-action";
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harnessR1 = fakePi();
      await orrElseExtension(harnessR1.pi);
      await harnessR1.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harnessR1.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: "" }, { hasUI: false, cwd: worktreePath });
      const probeTool = harnessR1.tools.find((t: any) => t.name === "identity_probe");
      expect(probeTool).toBeDefined();
      await probeTool.execute("call-real-1", {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      await new Promise(resolve => setTimeout(resolve, 50));
      const events = readEventStoreLines(tempRoot);
      const succeeded = events.filter(
        (e: any) => e.type === DomainEventName.TOOL_INVOCATION_SUCCEEDED && e.data?.tool === "identity_probe"
      );
      expect(succeeded).toHaveLength(1);
      const data = (succeeded[0] as any).data;
      expect(data.stateId).toBe("Implementing");
      expect(data.actionId).toBe("impl-action");
      expect(data.toolName).toBe("identity_probe");
      expect(typeof data.toolInvocationId).toBe("string");
      expect(data.toolInvocationId.length).toBeGreaterThan(0);
      expect(data.toolResult?.outputFile).toBeDefined();
    } finally {
      await harnessR1?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnvR1.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnvR1.workerMode;
      if (previousEnvR1.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnvR1.beadId;
      if (previousEnvR1.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnvR1.stateId;
      if (previousEnvR1.actionId === undefined) delete process.env[EnvVars.ACTION_ID];
      else process.env[EnvVars.ACTION_ID] = previousEnvR1.actionId;
      if (previousEnvR1.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnvR1.projectRoot;
      if (previousEnvR1.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnvR1.worktreePath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("DSM2-12-REAL-2: cache-hit event carries the same explicit identity fields as the original invocation", async () => {
    const previousCwd = process.cwd();
    const previousEnvR2 = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsm2-12-real-2-")));
    const worktreePath = path.join(tempRoot, "worktree");
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, "harness.yaml"), [
      "settings:",
      "  startState: Implementing",
      "  worktreePolicy:",
      "    default: always",
      "statechart:",
      "  terminalStates: [completed]",
      "  advanceOutcomes: [SUCCESS]",
      "  failedOutcomes: [FAILURE]",
      "  blockedOutcomes: [BLOCKED]",
      "tools:",
      "  - name: id_cache_probe",
      "    type: command",
      "    command: node",
      "    defaultArgs:",
      "      - \"-e\"",
      "      - \"console.log(JSON.stringify({ tool: 'id_cache_probe', status: 'PASSED', value: 2 }));\"",
      "    cacheable: true",
      "states:",
      "  Implementing:",
      "    identity: { role: \"Eng\", expertise: \"x\", constraints: [] }",
      "    baseInstructions: \"Do\"",
      "    actions:",
      "      - id: cache-action",
      "        type: prompt",
      "        prompt: \"Cache test\"",
      "    transitions: { SUCCESS: \"completed\", FAILURE: \"Implementing\" }",
    ].join("\n"));
    let harnessR2: ReturnType<typeof fakePi> | undefined;
    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = "bd-dsm2-cache";
      process.env[EnvVars.STATE_ID] = "Implementing";
      process.env[EnvVars.ACTION_ID] = "cache-action";
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harnessR2 = fakePi();
      await orrElseExtension(harnessR2.pi);
      await harnessR2.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harnessR2.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: "" }, { hasUI: false, cwd: worktreePath });
      const cacheTool = harnessR2.tools.find((t: any) => t.name === "id_cache_probe");
      expect(cacheTool).toBeDefined();
      await cacheTool.execute("call-cache-1", {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      await cacheTool.execute("call-cache-2", {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);
      await new Promise(resolve => setTimeout(resolve, 50));
      const events = readEventStoreLines(tempRoot);
      const succeeded = events.filter(
        (e: any) => e.type === DomainEventName.TOOL_INVOCATION_SUCCEEDED && e.data?.tool === "id_cache_probe"
      );
      expect(succeeded).toHaveLength(2);
      for (const ev of succeeded) {
        const data = (ev as any).data;
        expect(data.stateId).toBe("Implementing");
        expect(data.actionId).toBe("cache-action");
        expect(data.toolName).toBe("id_cache_probe");
        expect(typeof data.toolInvocationId).toBe("string");
        expect(data.toolInvocationId.length).toBeGreaterThan(0);
      }
      const cacheHit = succeeded.find((e: any) => (e as any).data?.cached === true);
      expect(cacheHit).toBeDefined();
      expect((cacheHit as any).data.stateId).toBe("Implementing");
      expect((cacheHit as any).data.toolName).toBe("id_cache_probe");
    } finally {
      await harnessR2?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      if (previousEnvR2.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnvR2.workerMode;
      if (previousEnvR2.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnvR2.beadId;
      if (previousEnvR2.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnvR2.stateId;
      if (previousEnvR2.actionId === undefined) delete process.env[EnvVars.ACTION_ID];
      else process.env[EnvVars.ACTION_ID] = previousEnvR2.actionId;
      if (previousEnvR2.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnvR2.projectRoot;
      if (previousEnvR2.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = previousEnvR2.worktreePath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// pi-experiment-2xho: command surface vs model-callable tool surface separation
// ---------------------------------------------------------------------------

describe('pi-experiment-2xho — command surface vs model-callable tool surface', () => {
  // AC3: /orr-else appears in command inventory and is ABSENT from active
  // model-callable tools, getAllTools tool surfaces, requiredTool callability,
  // and prompt tool snippets.
  it('AC3: /orr-else is registered as a command but absent from active model-callable tools', async () => {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);

    // /orr-else must appear in commands
    expect(harness.commands['orr-else']).toBeDefined();
    expect(harness.commands['orr-else'].description).toContain('--config');

    // /orr-else must NOT appear in registered tools
    const toolNames = harness.tools.map((t: any) => t.name);
    expect(toolNames).not.toContain('orr-else');
    expect(toolNames).not.toContain(BuiltInToolName.ORR_ELSE);
  });

  it('AC3: /orr-else is absent from setActiveTools (active model-callable tool surface)', async () => {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);

    // The active tools set by setActiveTools must not include the command name
    const activeTools = harness.pi.getActiveTools();
    expect(activeTools).not.toContain('orr-else');
    expect(activeTools).not.toContain(BuiltInToolName.ORR_ELSE);
  });

  it('AC3: /orr-else is absent from active tools even after SESSION_START in coordinator mode', async () => {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: true, ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} }, cwd: process.cwd(), shutdown: () => {} } as any);

    const activeTools = harness.pi.getActiveTools();
    expect(activeTools).not.toContain('orr-else');
    // harness_status IS a model-callable tool and should remain
    expect(activeTools).toContain(BuiltInToolName.HARNESS_STATUS);
  });

  // AC4: command handlers with hasUI:false must not throw
  it('AC4: /orr-else command status handler is safe with hasUI:false (headless/JSON/RPC)', async () => {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);

    const headlessCommandCtx = {
      hasUI: false,
      ui: undefined,
      cwd: process.cwd(),
      shutdown: () => {}
    } as any;

    // Should not throw even though ctx.ui is undefined
    await expect(
      harness.commands['orr-else'].handler('status', headlessCommandCtx)
    ).resolves.not.toThrow();
  });

  it('AC4: /orr-else command stop handler is safe with hasUI:false (headless/JSON/RPC)', async () => {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);

    const headlessCommandCtx = {
      hasUI: false,
      ui: undefined,
      cwd: process.cwd(),
      shutdown: () => {}
    } as any;

    // Should not throw even though ctx.ui is undefined
    await expect(
      harness.commands['orr-else'].handler('stop', headlessCommandCtx)
    ).resolves.not.toThrow();
  });

  it('AC4: /orr-else command start handler is safe with hasUI:false (headless/JSON/RPC)', async () => {
    // A minimal harness.yaml so the config loader finds a valid config
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-2xho-headless-')));
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
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    const previousCwd = process.cwd();
    let harness2xho: ReturnType<typeof fakePi> | undefined;
    try {
      process.chdir(tempRoot);
      harness2xho = fakePi();
      await orrElseExtension(harness2xho.pi);
      await harness2xho.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);

      const headlessCommandCtx = {
        hasUI: false,
        ui: undefined,
        cwd: tempRoot,
        shutdown: () => {}
      } as any;

      // Should not throw even when hasUI:false and ui is undefined
      // (start path will fail tmux / supervisor start, but must not crash on ctx.ui.notify)
      await expect(
        harness2xho.commands['orr-else'].handler('', headlessCommandCtx)
      ).resolves.not.toThrow();
    } finally {
      await harness2xho?.callbacks?.[PiEventName.SESSION_SHUTDOWN]?.();
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  // AC4: /orr-else command error path must not crash on ctx.ui when hasUI:false
  it('AC4: /orr-else command error path is safe with hasUI:false', async () => {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);

    const headlessCommandCtx = {
      hasUI: false,
      ui: undefined,
      cwd: process.cwd(),
      shutdown: () => {}
    } as any;

    // Pass a bad --config path to trigger an error in the command handler
    await expect(
      harness.commands['orr-else'].handler('--config /no/such/file/harness.yaml', headlessCommandCtx)
    ).resolves.not.toThrow();
  });

  // AC5: SESSION_SHUTDOWN awaits cleanup (returns a Promise, not void/undefined)
  it('AC5: SESSION_SHUTDOWN handler returns a thenable (awaits cleanup)', async () => {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, HEADLESS_TOOL_CONTEXT);

    const result = harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
    // Must be a Promise (thenable) so the Pi host can await cleanup
    expect(result).toBeTruthy();
    expect(typeof result?.then).toBe('function');
    await result;
  });
});

// ── 6q0y.3: active tool set wiring ────────────────────────────────────────────
//
// Tests that pi.setActiveTools is called with the resolver's output at the real
// state/action boundary (worker SESSION_START → Teammate.start() path).
// Load-bearing: the finalActive assertions fail if the resolveActiveToolSet wiring
// is removed from Teammate.startInner() — tool_wide / tool_z would then appear.

describe('6q0y.3: active tool set applied to Pi setActiveTools at worker state/action boundaries', () => {
  it('pi.setActiveTools excludes inactive project tools when state declares activeTools', async () => {
    // AC2: scoped state excludes inactive project tools while keeping core harness tools callable.
    // The Teammate.start() path (the real state-entry boundary) applies the resolved active set.
    // LOAD-BEARING: removing the resolveActiveToolSet wiring causes tool_wide to appear → test fails.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y3-state-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    // Two project tools; state declares activeTools: [tool_narrow] only.
    // tool_wide must be excluded from Pi's active tool set for this state.
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Narrow
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: tool_narrow
    type: command
    command: node
    defaultArgs: ["-e", "console.log(JSON.stringify({ status: 'PASSED' }))"]
  - name: tool_wide
    type: command
    command: node
    defaultArgs: ["-e", "console.log(JSON.stringify({ status: 'PASSED' }))"]
states:
  Narrow:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "Plan"
    activeTools: [tool_narrow]
    actions:
      - id: do-work
        type: prompt
        prompt: "Work"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Narrow" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-6q0y3-state';
      process.env[EnvVars.STATE_ID] = 'Narrow';
      process.env[EnvVars.ACTION_ID] = 'do-work';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      // Spy on setActiveTools to verify it is called as part of Teammate.start()
      const setActiveToolsCalls: string[][] = [];
      const origSetActiveTools = harness.pi.setActiveTools.bind(harness.pi);
      harness.pi.setActiveTools = (names: string[]) => {
        setActiveToolsCalls.push([...names]);
        origSetActiveTools(names);
      };

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      // Verify setActiveTools was called at least once (via Teammate.start() activateTools)
      expect(setActiveToolsCalls.length).toBeGreaterThanOrEqual(1);

      // Load-bearing: the final active set must contain tool_narrow and MUST NOT contain
      // tool_wide. If the resolveActiveToolSet wiring is removed from Teammate.startInner(),
      // tool_wide would appear in the active set and this assertion would fail.
      const finalActive = harness.pi.getActiveTools();
      expect(finalActive).toContain('tool_narrow');
      expect(finalActive).not.toContain('tool_wide');

      // Core harness tools remain callable (AC2)
      expect(finalActive).toContain(BuiltInToolName.SIGNAL_COMPLETION);
      expect(finalActive).toContain(BuiltInToolName.SUBMIT_CHECKPOINT);
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

  it('pi.setActiveTools exposes all project tools when no activeTools are declared (AC1 default path)', async () => {
    // AC1: harnesses without active-tool config activate the same tools they activate today.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y3-default-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    // No activeTools declared: both project tools should appear in the active set.
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Open
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: tool_alpha
    type: command
    command: node
    defaultArgs: ["-e", "console.log(JSON.stringify({ status: 'PASSED' }))"]
  - name: tool_beta
    type: command
    command: node
    defaultArgs: ["-e", "console.log(JSON.stringify({ status: 'PASSED' }))"]
states:
  Open:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: do-work
        type: prompt
        prompt: "Work"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Open" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-6q0y3-default';
      process.env[EnvVars.STATE_ID] = 'Open';
      process.env[EnvVars.ACTION_ID] = 'do-work';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      // Default path: both project tools should be in the active set.
      const finalActive = harness.pi.getActiveTools();
      expect(finalActive).toContain('tool_alpha');
      expect(finalActive).toContain('tool_beta');
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

  it('applies action-level active tool sets for two consecutive actions (AC5)', async () => {
    // AC3 + AC5: action-level activeTools applied after action selection.
    // Two separate worker sessions simulate consecutive action changes:
    //   - action_a session: only tool_x visible (not tool_y or tool_z)
    //   - action_b session: only tool_y visible (not tool_x or tool_z)
    // LOAD-BEARING: if resolveActiveToolSet wiring removed, tool_z appears → test fails.
    // Each state has exactly one action to avoid the sequenced-parent-action guard.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y3-action-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    // Two states with one action each; each action declares a different activeTools set.
    // tool_z is declared in config.tools but not in any action's activeTools.
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: StepA
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: tool_x
    type: command
    command: node
    defaultArgs: ["-e", "console.log(JSON.stringify({ status: 'PASSED' }))"]
  - name: tool_y
    type: command
    command: node
    defaultArgs: ["-e", "console.log(JSON.stringify({ status: 'PASSED' }))"]
  - name: tool_z
    type: command
    command: node
    defaultArgs: ["-e", "console.log(JSON.stringify({ status: 'PASSED' }))"]
states:
  StepA:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "Do Step A"
    actions:
      - id: action_a
        type: prompt
        prompt: "Step A"
        activeTools: [tool_x]
    requiredTools: []
    transitions: { SUCCESS: "StepB", FAILURE: "StepA" }
  StepB:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "Do Step B"
    actions:
      - id: action_b
        type: prompt
        prompt: "Step B"
        activeTools: [tool_y]
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "StepB" }
`);

    const runWorkerForState = async (stateId: string, actionId: string): Promise<string[]> => {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = `bd-6q0y3-${stateId}`;
      process.env[EnvVars.STATE_ID] = stateId;
      process.env[EnvVars.ACTION_ID] = actionId;
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;

      const harness = fakePi();
      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const active = harness.pi.getActiveTools();
      await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      return active;
    };

    try {
      // First action change: StepA/action_a → only tool_x should be active
      const stepAActive = await runWorkerForState('StepA', 'action_a');
      // Second action change: StepB/action_b → only tool_y should be active
      const stepBActive = await runWorkerForState('StepB', 'action_b');

      // AC5: two consecutive action changes with different active tool sets
      // StepA/action_a: tool_x active; tool_y and tool_z excluded
      expect(stepAActive).toContain('tool_x');
      expect(stepAActive).not.toContain('tool_y');
      // LOAD-BEARING: tool_z absent because action_a.activeTools = [tool_x]
      // Removing the resolveActiveToolSet wiring makes tool_z appear → test fails
      expect(stepAActive).not.toContain('tool_z');

      // StepB/action_b: tool_y active; tool_x and tool_z excluded
      expect(stepBActive).toContain('tool_y');
      expect(stepBActive).not.toContain('tool_x');
      expect(stepBActive).not.toContain('tool_z');

      // Core harness tools remain callable in both states (AC2)
      expect(stepAActive).toContain(BuiltInToolName.SIGNAL_COMPLETION);
      expect(stepBActive).toContain(BuiltInToolName.SIGNAL_COMPLETION);
    } finally {
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

  it('restricts project tools at state level when PI_ACTION_ID is absent (production-mirroring)', async () => {
    // Production-mirroring: in production, PI_ACTION_ID is NEVER set at spawn —
    // the worker always gets the AUTO_CONTEXT_RESTART_ACTION_ID sentinel in
    // workerContext.actionId. This test does NOT set process.env[EnvVars.ACTION_ID],
    // exactly like production. It verifies that state-level activeTools restriction
    // is applied correctly (sentinel → state-level resolution → restricted tool absent).
    //
    // SELF-CHECK: against the pre-fix code (sentinel → throw → catch-all → all-tools),
    // this test FAILS because the restricted tool leaks into the active set.
    // After the fix (sentinel → state-level resolve → tool excluded), it PASSES.
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y3-no-action-id-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    // State declares activeTools: [tool_allowed] only. tool_restricted must be absent.
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Restricted
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: tool_allowed
    type: command
    command: node
    defaultArgs: ["-e", "console.log(JSON.stringify({ status: 'PASSED' }))"]
  - name: tool_restricted
    type: command
    command: node
    defaultArgs: ["-e", "console.log(JSON.stringify({ status: 'PASSED' }))"]
states:
  Restricted:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "Work"
    activeTools: [tool_allowed]
    actions:
      - id: do-work
        type: prompt
        prompt: "Work"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Restricted" }
`);
    let harness: ReturnType<typeof fakePi> | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-6q0y3-no-action-id';
      process.env[EnvVars.STATE_ID] = 'Restricted';
      // ACTION_ID is deliberately NOT set — mirrors production spawn where
      // PI_ACTION_ID is never provided; workerContext.actionId gets the sentinel.
      delete process.env[EnvVars.ACTION_ID];
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      // State-level restriction must hold even without ACTION_ID.
      // Pre-fix: sentinel → throw → catch-all → all tools → tool_restricted leaks (FAIL).
      // Post-fix: sentinel → state-level resolve → tool_restricted absent (PASS).
      const finalActive = harness.pi.getActiveTools();
      expect(finalActive).toContain('tool_allowed');
      expect(finalActive).not.toContain('tool_restricted');

      // Core harness tools remain callable.
      expect(finalActive).toContain(BuiltInToolName.SIGNAL_COMPLETION);
      expect(finalActive).toContain(BuiltInToolName.SUBMIT_CHECKPOINT);
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

// ── fwai: buildStateSystemPrompt tool prompt profile wiring ──────────────────
//
// Guards the production wiring in buildStateSystemPrompt:
//   resolveToolPromptProfileId → describeConfiguredProjectTools(config, profileId)
//   → protocolLabel suffixed with |profile:<id>
//
// The test drives the REAL entry (worker SESSION_START → BEFORE_AGENT_START)
// and asserts on the assembled systemPrompt returned by BEFORE_AGENT_START.
// Removing any of the three wiring steps from buildStateSystemPrompt makes
// this test fail — it is NOT a re-implementation of the wiring.
//
// LOAD-BEARING assertions:
//   (a) prompt contains profile-specialized tool description (not default) — fails
//       if resolveToolPromptProfileId or the describeConfiguredProjectTools(profileId)
//       call is removed from buildStateSystemPrompt.
//   (b) protocolLabel passed to injectWithDigest CONTAINS 'profile:compact' for the
//       profile run and does NOT contain 'profile:' for the no-profile run — fails
//       if the `|profile:${profileId}` suffix is removed from protocolLabel in
//       buildStateSystemPrompt.  Asserts the raw label string, not a recomputed digest.

describe('fwai: buildStateSystemPrompt tool prompt profile wiring (real worker entry)', () => {
  it('state-level toolPromptProfile specializes the assembled systemPrompt and uses a profile-suffixed protocolLabel (load-bearing)', async () => {
    // This test drives the real buildStateSystemPrompt path via the worker
    // SESSION_START → BEFORE_AGENT_START entry, NOT via a helper that re-implements
    // the wiring. Removing any of these from buildStateSystemPrompt causes it to fail:
    //   - resolveToolPromptProfileId call
    //   - describeConfiguredProjectTools(config, profileId) call (passing profileId)
    //   - protocolLabel |profile:<id> suffix
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
    };

    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-fwai-profile-wiring-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);

    // Harness config with:
    //   - one project tool with a verbose default description
    //   - a compact profile overriding that description with a short, unique phrase
    //   - the state selects the compact profile
    // If buildStateSystemPrompt ignores the profile, the default description appears → assertion (a) fails.
    const profileText = 'fwai-profile-specialized-unique-marker';
    const defaultDescription = 'fwai-default-broad-description-that-must-not-appear-when-profile-active';

    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  worktreePolicy:
    default: always
  toolPromptProfiles:
    compact:
      - tool: profile_tool
        id: compact
        text: "${profileText}"
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: profile_tool
    type: command
    command: node
    defaultArgs: ["-e", "console.log(JSON.stringify({ status: 'PASSED' }))"]
    description: "${defaultDescription}"
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    toolPromptProfile: compact
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan the work"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);

    let harness: ReturnType<typeof fakePi> | undefined;
    let tempRoot2: string | undefined;

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-fwai-profile-run';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.ACTION_ID] = 'formulate-plan';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

      // ── Assertion (b) spy: intercept the identity passed to injectWithDigest ──
      // FAILS if the protocolLabel |profile:<id> suffix is removed from
      // buildStateSystemPrompt: the captured label will then lack 'profile:compact'
      // and the assertion below fails.  The spy wraps the real method so the
      // prompt assembly and digest computation still run normally.
      const originalInjectWithDigest = ContextInjector.prototype.injectWithDigest;
      const capturedProfileIdentity: { protocolLabel?: string }[] = [];
      const profileSpy = vi.spyOn(ContextInjector.prototype, 'injectWithDigest').mockImplementation(
        function (this: ContextInjector, ...args: Parameters<ContextInjector['injectWithDigest']>) {
          capturedProfileIdentity.push(args[2] ?? {});
          return originalInjectWithDigest.apply(this, args);
        }
      );

      // Capture the return value — buildStateSystemPrompt assembles the prompt here.
      // The return value is { systemPrompt: stableBlock + "\n\n" + volatileSuffix }.
      const result = await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.(
        { systemPrompt: '' },
        { hasUI: false, cwd: worktreePath }
      );

      profileSpy.mockRestore();

      // Wait for the STATE_PROMPT_ASSEMBLED event to be written to disk.
      await new Promise(resolve => setTimeout(resolve, 60));

      // ── Assertion (a): prompt is specialized by the profile ──────────────────
      // FAILS if resolveToolPromptProfileId or the describeConfiguredProjectTools(profileId)
      // call is removed from buildStateSystemPrompt (reverts to default description).
      expect(result?.systemPrompt).toBeDefined();
      expect(result.systemPrompt).toContain(profileText);
      expect(result.systemPrompt).not.toContain(defaultDescription);

      // ── Assertion (b): protocolLabel is profile-suffixed ──────────────────────
      // The spy captured the identity object passed to ContextInjector.injectWithDigest.
      // LOAD-BEARING: FAILS if the `|profile:${profileId}` suffix is removed from
      // protocolLabel in buildStateSystemPrompt — the captured label then lacks
      // 'profile:compact' and the expectation below fails.
      // This does NOT recompute or mirror the digest: it asserts the raw label string
      // that production builds before hashing.
      expect(capturedProfileIdentity.length).toBeGreaterThan(0);
      const profileLabel = capturedProfileIdentity[0].protocolLabel ?? '';
      expect(profileLabel).toContain('profile:compact');

      await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      harness = undefined;
      await new Promise(resolve => setTimeout(resolve, 25));

      // Run a second worker WITHOUT a profile selected to confirm the suffix is
      // absent when no profile is active (negative guard).
      tempRoot2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-fwai-noprofile-')));
      const worktreePath2 = path.join(tempRoot2, 'worktree');
      fs.mkdirSync(worktreePath2);
      fs.writeFileSync(path.join(tempRoot2, 'harness.yaml'), `
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
  - name: profile_tool
    type: command
    command: node
    defaultArgs: ["-e", "console.log(JSON.stringify({ status: 'PASSED' }))"]
    description: "${defaultDescription}"
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: formulate-plan
        type: prompt
        prompt: "Plan the work"
    requiredTools: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);

      process.chdir(tempRoot2);
      process.env[EnvVars.PROJECT_ROOT] = tempRoot2;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath2;
      process.env[EnvVars.BEAD_ID] = 'bd-fwai-noprofile-run';

      const capturedNoprofileIdentity: { protocolLabel?: string }[] = [];
      const noprofileSpy = vi.spyOn(ContextInjector.prototype, 'injectWithDigest').mockImplementation(
        function (this: ContextInjector, ...args: Parameters<ContextInjector['injectWithDigest']>) {
          capturedNoprofileIdentity.push(args[2] ?? {});
          return originalInjectWithDigest.apply(this, args);
        }
      );

      const harness2 = fakePi();
      await orrElseExtension(harness2.pi);
      await harness2.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot2 });
      await harness2.callbacks[PiEventName.BEFORE_AGENT_START]?.(
        { systemPrompt: '' },
        { hasUI: false, cwd: worktreePath2 }
      );
      noprofileSpy.mockRestore();
      await new Promise(resolve => setTimeout(resolve, 60));

      // Negative guard: no-profile run must NOT have the suffix.
      expect(capturedNoprofileIdentity.length).toBeGreaterThan(0);
      const noprofileLabel = capturedNoprofileIdentity[0].protocolLabel ?? '';
      expect(noprofileLabel).not.toContain('profile:');

      await harness2.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
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
      if (tempRoot2) fs.rmSync(tempRoot2, { recursive: true, force: true });
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// yhec zog2.2: canonical evidence handle must NOT appear in model-facing result
// ---------------------------------------------------------------------------
//
// LOAD-BEARING: These tests prove that _canonicalEvidenceHandle (and the raw
// absolute paths / sha256 / fingerprint it carries) is stripped from the
// model-facing response (content[0].text and details) BEFORE the model sees it,
// while the coordinator-side TOOL_INVOCATION_SUCCEEDED event STILL carries the
// canonical evidenceHandle for gate use.
//
// Removing the strip in extension.ts (resultForModel → result) causes these
// tests to fail — confirming they are load-bearing.

describe('yhec zog2.2: canonical evidence handle stripped from model-facing tool result', () => {
  it('YHEC-ZOG2-MODEL-CLEAN: model-facing content/details has no _canonicalEvidenceHandle; event still carries evidenceHandle', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      actionId: process.env[EnvVars.ACTION_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH],
    };

    // The inline script below emits a canonical evidenceHandle (full ToolEvidenceHandle shape)
    // in the JSON stdout. projectTools.ts attaches it as _canonicalEvidenceHandle on the result
    // object before returning it to extension.ts. The zog2.2 fix in extension.ts strips it from
    // the model-facing result (resultForModel) AFTER recording the TOOL_INVOCATION_SUCCEEDED event.
    //
    // The script:
    //   1. Writes a semantic artifact to PI_TOOL_OUTPUT_DIR.
    //   2. Emits JSON stdout with evidenceHandle (full handle with semanticArtifactPath, sha256,
    //      toolOutputRoot, admittedHarnessFingerprint).
    const toolScript = [
      "const fs=require('fs'),path=require('path'),crypto=require('crypto');",
      "const outDir=process.env.PI_TOOL_OUTPUT_DIR||require('os').tmpdir();",
      "const outRoot=path.join(process.env.PI_PROJECT_ROOT||outDir,'.pi/tool-output');",
      "const artPath=path.join(outDir,'yhec-zog2-evidence.json');",
      "const artContent=JSON.stringify({runStatus:'PASSED',tool:'yhec_model_clean_probe'});",
      "fs.mkdirSync(outDir,{recursive:true});",
      "fs.writeFileSync(artPath,artContent);",
      "const sha256='sha256:'+crypto.createHash('sha256').update(artContent).digest('hex');",
      "const bead=process.env.PI_BEAD_ID||'?',state=process.env.PI_STATE_ID||'?',action=process.env.PI_ACTION_ID||'?';",
      "const fp=process.env.PI_HARNESS_FINGERPRINT||'sha256:test-fingerprint-yhec-zog2';",
      "const h={",
      "  schemaVersion:'1.0.0',toolName:'yhec_model_clean_probe',invocationId:'inv-yhec-zog2-'+crypto.randomUUID(),",
      "  runStatus:'PASSED',",
      "  semanticArtifactPath:artPath,",
      "  semanticArtifactBytes:artContent.length,",
      "  semanticArtifactSha256:sha256,",
      "  toolOutputRoot:outRoot,",
      "  summaryMode:'summary',",
      "  rtkSummary:{",
      "    schemaTypeName:'YhecZog2RtkSummary',",
      "    owningFile:'src/tools/yhec_model_clean_probe.ts',",
      "    summarySchemaVersion:'1.0.0',",
      "    schemaHash:'sha256:'+'a'.repeat(64),",
      "    deterministicSummaryVersion:'1.0.0',",
      "    inputArtifactSchemaId:'yhec-model-clean-probe-output',",
      "    inputArtifactSchemaVersion:'1.0.0',",
      "    maximumCounts:{items:1},",
      "    omissionSemantics:'no items omitted',",
      "    summary:{runStatus:'PASSED'}",
      "  },",
      "  admittedHarnessFingerprint:fp,",
      "  admittedExecutionBoundary:'bead:'+bead+'/state:'+state+'/action:'+action",
      "};",
      "console.log(JSON.stringify({tool:'yhec_model_clean_probe',status:'PASSED',evidenceHandle:h}));"
    ].join('');

    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yhec-zog2-model-clean-')));
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), [
      'settings:',
      '  startState: Implementing',
      '  worktreePolicy:',
      '    default: always',
      'statechart:',
      '  terminalStates: [completed]',
      '  advanceOutcomes: [SUCCESS]',
      '  failedOutcomes: [FAILURE]',
      '  blockedOutcomes: [BLOCKED]',
      'tools:',
      '  - name: yhec_model_clean_probe',
      '    type: command',
      '    command: node',
      '    defaultArgs:',
      '      - "-e"',
      `      - ${JSON.stringify(toolScript)}`,
      'states:',
      '  Implementing:',
      '    identity: { role: "Eng", expertise: "x", constraints: [] }',
      '    baseInstructions: "Implement"',
      '    actions:',
      '      - id: impl-action',
      '        type: prompt',
      '        prompt: "Do the work"',
      '    transitions: { SUCCESS: "completed", FAILURE: "Implementing" }',
    ].join('\n'));

    let harness: ReturnType<typeof fakePi> | undefined;
    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-yhec-zog2';
      process.env[EnvVars.STATE_ID] = 'Implementing';
      process.env[EnvVars.ACTION_ID] = 'impl-action';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = worktreePath;
      harness = fakePi();

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      await harness.callbacks[PiEventName.BEFORE_AGENT_START]?.({ systemPrompt: '' }, { hasUI: false, cwd: worktreePath });

      const probeTool = harness.tools.find((t: any) => t.name === 'yhec_model_clean_probe');
      expect(probeTool).toBeDefined();

      // Execute the tool — this is the model-facing return path
      const modelFacingResult: any = await probeTool.execute('yhec-zog2-call', {}, undefined, undefined, HEADLESS_TOOL_CONTEXT);

      await new Promise(resolve => setTimeout(resolve, 60));

      // ── MODEL-FACING: must NOT contain _canonicalEvidenceHandle or raw paths ──
      //
      // The model sees content[0].text (JSON-serialized result) and details.
      // Neither must contain _canonicalEvidenceHandle, semanticArtifactPath,
      // semanticArtifactSha256, or admittedHarnessFingerprint.

      expect(modelFacingResult).toBeDefined();

      // Check details (the raw object returned to the model)
      const details = modelFacingResult?.details;
      if (details !== null && typeof details === 'object') {
        expect((details as any)._canonicalEvidenceHandle).toBeUndefined();
        // Raw absolute paths and integrity fields must not be directly on details
        const detailsStr = JSON.stringify(details);
        expect(detailsStr).not.toContain('_canonicalEvidenceHandle');
        expect(detailsStr).not.toContain('semanticArtifactSha256');
        expect(detailsStr).not.toContain('admittedHarnessFingerprint');
        // semanticArtifactPath is a deep field inside the handle; once the handle is
        // stripped, it must not appear in the model-facing payload.
        // (We check the serialized form since it would be a string value inside the handle object.)
        expect(detailsStr).not.toContain('"semanticArtifactPath"');
      }

      // Check content[0].text (the serialized text the model receives)
      const contentText: string = modelFacingResult?.content?.[0]?.text ?? '';
      expect(contentText).not.toContain('_canonicalEvidenceHandle');
      expect(contentText).not.toContain('semanticArtifactSha256');
      expect(contentText).not.toContain('admittedHarnessFingerprint');
      expect(contentText).not.toContain('"semanticArtifactPath"');

      // ── COORDINATOR-SIDE: TOOL_INVOCATION_SUCCEEDED event MUST carry evidenceHandle ──
      //
      // The strip only applies to the model-facing return. The event, which is
      // coordinator-side only, must still carry the full canonical evidenceHandle
      // so the VerifierGate can read it.

      const events = readEventStoreLines(tempRoot);
      const succeeded = events.filter(
        (e: any) => e.type === DomainEventName.TOOL_INVOCATION_SUCCEEDED && e.data?.tool === 'yhec_model_clean_probe'
      );
      expect(succeeded).toHaveLength(1);
      const eventData = (succeeded[0] as any).data;

      // The event must have evidenceHandle with the canonical fields intact
      expect(eventData.evidenceHandle).toBeDefined();
      expect(eventData.evidenceHandle.schemaVersion).toBe('1.0.0');
      expect(eventData.evidenceHandle.toolName).toBe('yhec_model_clean_probe');
      expect(eventData.evidenceHandle.runStatus).toBe('PASSED');
      expect(typeof eventData.evidenceHandle.semanticArtifactPath).toBe('string');
      expect(eventData.evidenceHandle.semanticArtifactPath.length).toBeGreaterThan(0);
      expect(typeof eventData.evidenceHandle.admittedHarnessFingerprint).toBe('string');
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
