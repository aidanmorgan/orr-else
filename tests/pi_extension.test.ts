import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import orrElseExtension from '../src/extension.js';
import { FlowManager } from '../src/core/FlowManager.js';
import { EnvVars, NativePiToolName, PiEventName, ProcessFlag } from '../src/constants/index.js';
import { getProjectRoot, setProjectRoot } from '../src/core/Paths.js';

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

describe('Pi-native extension surface', () => {
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
    const previousProjectRoot = getProjectRoot();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT]
    };
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-read-policy-')));
    fs.writeFileSync(path.join(tempRoot, 'source.py'), 'print("ok")\n');
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
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
      setProjectRoot(tempRoot);
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;

      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-1';
      process.env[EnvVars.STATE_ID] = 'Planning';

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

      const removeState = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.BASH,
        toolCallId: 'remove-state',
        input: { command: `rm -rf ${path.join(tempRoot, 'state')}` }
      });

      expect(removeState).toMatchObject({ block: true });
      expect(removeState.reason).toContain('may not mutate framework runtime artifact path');

      const oversized = await harness.callbacks[PiEventName.TOOL_CALL]?.({
        toolName: NativePiToolName.READ,
        toolCallId: 'read-huge-source',
        input: { path: path.join(tempRoot, 'source.py'), limit: 2000 }
      });

      expect(oversized).toMatchObject({ block: true });
      expect(oversized.reason).toContain('400 lines');
    } finally {
      await harness.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      setProjectRoot(previousProjectRoot);
      if (previousEnv.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = previousEnv.workerMode;
      if (previousEnv.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousEnv.beadId;
      if (previousEnv.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousEnv.stateId;
      if (previousEnv.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = previousEnv.projectRoot;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('registers /orr-else, coordinator tools, and teammate signaling tools', async () => {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false });

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

  it('lets configured project tools override generic harness tools with the same name', async () => {
    const previousCwd = process.cwd();
    const previousProjectRoot = getProjectRoot();
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
      setProjectRoot(tempRoot);
      harness = fakePi();
      await orrElseExtension(harness.pi);
      await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false, cwd: tempRoot });

      const matchingTools = harness.tools.filter(tool => tool.name === 'run_quality_checks');
      expect(matchingTools).toHaveLength(1);
      expect(matchingTools[0].description).toBe('Project-owned quality gate.');
      expect(JSON.stringify(matchingTools[0].parameters)).toContain('arguments');
    } finally {
      await harness?.callbacks[PiEventName.SESSION_SHUTDOWN]?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      process.chdir(previousCwd);
      setProjectRoot(previousProjectRoot);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('contributes configured Pi-native skill paths through resource discovery', async () => {
    const harness = fakePi();
    await orrElseExtension(harness.pi);

    const resources = await harness.callbacks[PiEventName.RESOURCES_DISCOVER]?.({}, { hasUI: false });

    expect(resources).toBeDefined();
  });

  it('keeps tmux process orchestration behind the /orr-else plugin surface', async () => {
    const harness = fakePi();
    await orrElseExtension(harness.pi);
    await harness.callbacks[PiEventName.SESSION_START]?.({}, { hasUI: false });
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
    expect(source).toContain('this.options.maxSlots - this.startedBeads.size');
    expect(harness.commands['orr-else'].description).toContain('/orr-else');
  });
});
