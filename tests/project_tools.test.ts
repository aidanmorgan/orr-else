import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { ToolCallPathFactory } from '../src/core/ToolCallPathFactory.js';
import { CommandErrorCode, CwdMode, DomainEventName, EnvVars, EventName, ProjectToolDefaults, ProjectToolType, TeammateEventType, ToolResultStatus } from '../src/constants/index.js';
import type { ProjectCommandToolConfig, ProjectMcpToolConfig } from '../src/core/domain/StateModels.js';
import { classifyProjectToolFailure, describeConfiguredProjectTools, executeConfiguredProjectTool, extractSequencedToolCalls, toolCallsFromOutputFile, isAcceptedMaxBufferFailure, isSuccessfulCommandExitCode, mcpToolRequestTimeoutMs, normalizeCommandArguments, normalizeMcpPathArguments, ProjectToolBackpressure, ProjectToolFailureCategory, projectToolFailureLimitSuggestedOutcome, registerConfiguredProjectTools, resolveContextField, shouldSerializeCommandTool, shouldSerializeMcpTool } from '../src/plugins/projectTools.js';
import { toolCallsFromRecord } from '../src/plugins/projectTools/commandExecutor.js';
import { summarizeToolResult, persistAndBoundResult } from '../src/plugins/projectTools/resultEnvelope.js';
import type { ProjectToolExecutionContext } from '../src/plugins/projectTools/types.js';
import { resolveStructuredInvocation } from '../src/plugins/projectTools/structuredInvocation.js';
import { frameworkRootFromConfig } from '../src/plugins/projectTools/contextHelpers.js';

const EnvProbeField = {
  CWD: 'cwd',
  PROJECT_ROOT: 'projectRoot',
  WORKTREE_PATH: 'worktreePath',
  TOOL_INVOCATION_ID: 'toolInvocationId',
  CALL_DIR: 'callDir',
  OUTPUT_DIR: 'outputDir',
  OUTPUT_FILE: 'outputFile',
  TMP_DIR: 'tmpDir',
  TMPDIR: 'tmpdir',
  TOOL_WORKING_DIR: 'toolWorkingDir'
} as const;

function writeMinimalHarnessConfig(projectRoot: string): void {
  fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), `
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
}

function envProbeTool(cwd: CwdMode): ProjectCommandToolConfig {
  const script = `
const fs = require('fs');
const path = require('path');
const payload = {
  cwd: process.cwd(),
  projectRoot: process.env.${EnvVars.PROJECT_ROOT},
  worktreePath: process.env.${EnvVars.WORKTREE_PATH},
  toolInvocationId: process.env.${EnvVars.TOOL_INVOCATION_ID},
  callDir: process.env.${EnvVars.TOOL_CALL_DIR},
  outputDir: process.env.${EnvVars.TOOL_OUTPUT_DIR},
  outputFile: process.env.${EnvVars.TOOL_OUTPUT_FILE},
  tmpDir: process.env.${EnvVars.TOOL_TMP_DIR},
  tmpdir: process.env.TMPDIR,
  toolWorkingDir: process.env.${EnvVars.TOOL_WORKING_DIR}
};
fs.writeFileSync(path.join(payload.outputDir, 'probe.json'), JSON.stringify(payload));
fs.writeFileSync(payload.outputFile, JSON.stringify(payload));
console.log(JSON.stringify(payload));
`;

  return {
    name: 'env_probe',
    type: ProjectToolType.COMMAND,
    command: process.execPath,
    defaultArgs: ['-e', script],
    cwd,
    allowCwdOverride: true,
  };
}

describe('project tool command arguments', () => {
  let tempRoot: string;
  let tempWorktree: string;
  let previousProjectRootEnv: string | undefined;
  let previousWorktreeEnv: string | undefined;
  let previousFrameworkRootEnv: string | undefined;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let toolCallPathFactory: ToolCallPathFactory;

  beforeEach(() => {
    previousProjectRootEnv = process.env[EnvVars.PROJECT_ROOT];
    previousWorktreeEnv = process.env[EnvVars.WORKTREE_PATH];
    previousFrameworkRootEnv = process.env[EnvVars.FRAMEWORK_ROOT];
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-project-tools-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-1');
    fs.mkdirSync(tempWorktree, { recursive: true });
    writeMinimalHarnessConfig(tempRoot);
    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-${process.pid}`);
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempWorktree;
  });

  afterEach(() => {
    configLoader.reset();
    vi.restoreAllMocks();
    eventStore.setSessionId(`test-${process.pid}-reset`);
    if (previousProjectRootEnv === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = previousProjectRootEnv;
    if (previousWorktreeEnv === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = previousWorktreeEnv;
    if (previousFrameworkRootEnv === undefined) delete process.env[EnvVars.FRAMEWORK_ROOT];
    else process.env[EnvVars.FRAMEWORK_ROOT] = previousFrameworkRootEnv;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('treats argv as explicit positional arguments instead of a flag', () => {
    expect(normalizeCommandArguments({
      argv: ['run', '--lang', 'ts', '-p', 'completedActionIds', 'src']
    })).toEqual(['run', '--lang', 'ts', '-p', 'completedActionIds', 'src']);
  });

  it('still converts ordinary object keys to stable flags', () => {
    expect(normalizeCommandArguments({
      timeoutSeconds: 30,
      includeHidden: true,
      ignored: false
    })).toEqual(['--timeout-seconds', '30', '--include-hidden']);
  });

  it('preserves explicit dashed object keys without duplicating dashes', () => {
    expect(normalizeCommandArguments({
      '--filter': 'type_spec',
      '-p': 'VariableDecl($$$)',
      '----dryRun': true
    })).toEqual(['--filter', 'type_spec', '-p', 'VariableDecl($$$)', '--dry-run']);
  });

  it('keeps project tool control parameters out of command arguments', () => {
    expect(normalizeCommandArguments({
      cwd: CwdMode.WORKTREE,
      cwdMode: CwdMode.PROJECT,
      query: 'rules'
    })).toEqual(['--query', 'rules']);
  });

  it('normalizes configured command positional paths into the active worktree', async () => {
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'argv_probe',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1) }));', '--'],
      argsMode: 'append',
      allowArgs: true,
      cwd: CwdMode.WORKTREE,
      argumentPathScope: {
        root: CwdMode.WORKTREE,
        virtualRoots: ['/workspace/worktrees/{{beadId}}', '/workspace'],
        positionals: true
      },
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze',
      arguments: {
        argv: ['/workspace/worktrees/bd-1/packages/example.py', '-k', 'selector']
      }
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    // s3wp.25: stdout is in stdoutFile, not inline on result
    expect(JSON.parse(fs.readFileSync(result.stdoutFile!, 'utf8')).argv).toEqual([
      path.join(tempWorktree, 'packages/example.py'),
      '-k',
      'selector'
    ]);
    expect(result.normalizedPathArguments).toEqual(['argv[0]']);
  });

  it('normalizes configured command positional paths into a framework root', async () => {
    const frameworkRoot = path.join(tempRoot, 'framework');
    fs.mkdirSync(path.join(frameworkRoot, 'tests'), { recursive: true });

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'framework_argv_probe',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), frameworkRoot: process.env.ORR_ELSE_FRAMEWORK_ROOT }));', '--'],
      argsMode: 'append',
      allowArgs: true,
      cwd: CwdMode.WORKTREE,
      argumentPathScope: {
        rootKind: 'framework',
        virtualRoots: ['/workspace/framework'],
        positionals: true
      },
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze',
      frameworkRoot,
      arguments: {
        argv: ['/workspace/framework/tests/teammates.test.ts']
      }
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    // s3wp.25: stdout is in stdoutFile
    expect(JSON.parse(fs.readFileSync(result.stdoutFile!, 'utf8'))).toEqual({
      argv: [path.join(frameworkRoot, 'tests/teammates.test.ts')],
      frameworkRoot
    });
    expect(result.normalizedPathArguments).toEqual(['argv[0]']);
  });

  it('accepts absolute framework-root command paths for configured coding standards tools without framework env', async () => {
    delete process.env[EnvVars.FRAMEWORK_ROOT];
    const frameworkRoot = tempRoot;
    const frameworkPath = path.join(frameworkRoot, 'tests', 'teammates.test.ts');
    fs.mkdirSync(path.dirname(frameworkPath), { recursive: true });
    fs.writeFileSync(frameworkPath, 'test content');

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'coding_standards',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1) }));', '--'],
      argsMode: 'append',
      allowArgs: true,
      cwd: CwdMode.WORKTREE,
      argumentPathScope: {
        rootKind: 'framework',
        positionals: true
      },
    }, {
      beadId: 'bd-1',
      stateId: 'AdversarialPreReview',
      actionId: 'coding-standards',
      arguments: {
        argv: [frameworkPath]
      }
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    // s3wp.25: stdout is in stdoutFile
    expect(JSON.parse(fs.readFileSync(result.stdoutFile!, 'utf8')).argv).toEqual([frameworkPath]);
    expect(result.normalizedPathArguments).toEqual(['argv[0]']);
  });

  it('rejects command paths outside a configured framework root', async () => {
    const frameworkRoot = path.join(tempRoot, 'framework');
    fs.mkdirSync(frameworkRoot, { recursive: true });
    const marker = path.join(tempRoot, 'framework-command-ran.txt');

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'framework_path_guarded',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`],
      argsMode: 'append',
      allowArgs: true,
      cwd: CwdMode.WORKTREE,
      argumentPathScope: {
        rootKind: 'framework',
        positionals: true
      },
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze',
      frameworkRoot,
      arguments: {
        argv: [path.join(tempWorktree, 'tests/example.py')]
      }
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.message).toContain('escapes configured framework root');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('rejects unrelated absolute framework command paths with root-relative remediation without framework env', async () => {
    delete process.env[EnvVars.FRAMEWORK_ROOT];
    const frameworkRoot = tempRoot;
    fs.mkdirSync(frameworkRoot, { recursive: true });
    const unrelatedPath = path.join(`${tempRoot}-unrelated`, 'tests', 'teammates.test.ts');
    const marker = path.join(tempRoot, 'framework-unrelated-command-ran.txt');

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'coding_standards',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`],
      argsMode: 'append',
      allowArgs: true,
      cwd: CwdMode.WORKTREE,
      argumentPathScope: {
        rootKind: 'framework',
        positionals: true
      },
    }, {
      beadId: 'bd-1',
      stateId: 'AdversarialPreReview',
      actionId: 'coding-standards',
      arguments: {
        argv: [unrelatedPath]
      }
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.message).toContain('escapes configured framework root');
    expect(result.message).toContain(unrelatedPath);
    expect(result.message).toContain(`Allowed root: ${frameworkRoot}`);
    expect(result.message).toContain('Expected relative form: <path-relative-to-framework-root>');
    expect(result.remediation).toEqual(expect.arrayContaining([
      expect.stringContaining(frameworkRoot),
      expect.stringContaining('<path-relative-to-framework-root>'),
      expect.stringContaining('unrelated absolute paths')
    ]));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('normalizes configured command flag paths into the active worktree', async () => {
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'argv_probe',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1) }));', '--'],
      argsMode: 'append',
      allowArgs: true,
      cwd: CwdMode.WORKTREE,
      argumentPathScope: {
        root: CwdMode.WORKTREE,
        virtualRoots: ['/workspace'],
        flags: ['--changed-file']
      },
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze',
      arguments: {
        argv: ['--changed-file=/workspace/packages/example.py']
      }
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    // s3wp.25: stdout is in stdoutFile
    expect(JSON.parse(fs.readFileSync(result.stdoutFile!, 'utf8')).argv).toEqual([
      `--changed-file=${path.join(tempWorktree, 'packages/example.py')}`
    ]);
    expect(result.normalizedPathArguments).toEqual(['--changed-file']);
  });

  it('rejects configured command paths outside the active worktree before execution', async () => {
    const marker = path.join(tempRoot, 'command-ran.txt');
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'path_guarded',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`],
      argsMode: 'append',
      allowArgs: true,
      cwd: CwdMode.WORKTREE,
      argumentPathScope: {
        root: CwdMode.WORKTREE,
        positionals: true
      },
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze',
      arguments: {
        argv: [path.join(tempRoot, 'outside.py')]
      }
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.failureCategory).toBe(ProjectToolFailureCategory.TOOL_INPUT_ERROR);
    expect(result.message).toContain('escapes configured worktree root');
    expect(result.rejectedPathArgument).toMatchObject({
      name: 'argv[0]',
      value: path.join(tempRoot, 'outside.py')
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('rejects relative command path escapes before execution', async () => {
    const marker = path.join(tempRoot, 'relative-command-ran.txt');
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'path_guarded',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`],
      argsMode: 'append',
      allowArgs: true,
      cwd: CwdMode.WORKTREE,
      argumentPathScope: {
        root: CwdMode.WORKTREE,
        positionals: true
      },
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze',
      arguments: {
        argv: ['../bd-2/tests/example.py']
      }
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.message).toContain('escapes configured worktree root');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('allows command tools to configure success exit codes', () => {
    const tool = {
      name: 'ast_grep',
      type: ProjectToolType.COMMAND,
      command: 'ast-grep',
      successExitCodes: [0, 1]
    };

    expect(isSuccessfulCommandExitCode(tool, 0)).toBe(true);
    expect(isSuccessfulCommandExitCode(tool, 1)).toBe(true);
    expect(isSuccessfulCommandExitCode(tool, 8)).toBe(false);
  });

  it('serializes MCP project-tool calls when the config sets serialize:true (generic, name-agnostic)', () => {
    expect(shouldSerializeMcpTool({ type: ProjectToolType.MCP, serialize: true })).toBe(true);
    expect(shouldSerializeMcpTool({ type: ProjectToolType.MCP, serialize: false })).toBe(false);
    expect(shouldSerializeMcpTool({ type: ProjectToolType.MCP })).toBe(false);
    // serialize only applies to MCP tools, never command tools.
    expect(shouldSerializeMcpTool({ type: ProjectToolType.COMMAND, serialize: true } as any)).toBe(false);
  });

  it('keeps serialized MCP tool client timeouts above the server timeout (driven by serialize flag)', () => {
    const serializedTool: ProjectMcpToolConfig = {
      name: 'stateful_tool',
      type: ProjectToolType.MCP,
      server: 'stateful-server',
      serialize: true
    };
    const concurrentTool: ProjectMcpToolConfig = {
      name: 'concurrent_tool',
      type: ProjectToolType.MCP,
      server: 'concurrent-server'
    };

    expect(mcpToolRequestTimeoutMs(serializedTool)).toBeGreaterThan(120_000);
    expect(mcpToolRequestTimeoutMs(concurrentTool)).toBe(60_000);
    expect(mcpToolRequestTimeoutMs({ ...serializedTool, timeoutMs: 240_000 })).toBe(240_000);
  });

  it('returns structured backpressure when a serialize:true MCP lock acquisition times out', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    // Reject ONLY the MCP project-tool lock; let the shared events-JSONL append
    // lock (a .jsonl path) succeed so event recording is unaffected (13op).
    vi.spyOn(lockfile, 'lock').mockImplementation(async (target: string) => {
      if (String(target).includes('orr-else-mcp-tool-locks')) {
        throw new Error('Lock file is already being held');
      }
      return (async () => {}) as () => Promise<void>;
    });
    const tool: ProjectMcpToolConfig = {
      name: 'stateful_tool',
      type: ProjectToolType.MCP,
      server: 'stateful-server',
      serialize: true
    };
    const context = {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'inspect-symbols'
    };

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, {
      ...context,
      operation: 'definition',
      arguments: { path: 'example.py' }
    }, {} as any, undefined, new Map());

    // 0yt5.16/0yt5.17: no harness nextAction steering; the backpressure result is
    // passed through verbatim.
    expect(result).toMatchObject({
      tool: 'stateful_tool',
      server: 'stateful-server',
      status: ToolResultStatus.REJECTED,
      failureCategory: ProjectToolFailureCategory.BACKPRESSURE,
      lockTimeout: true
    });
    expect((result as any).nextAction).toBeUndefined();
    expect((result as any).message).toContain('could not acquire the serialized MCP project-tool lock');
    expect((result as any).lockMetadata).toMatchObject({
      scope: 'project',
      waitedMs: 0,
      tool: 'stateful_tool',
      server: 'stateful-server'
    });
    expect(JSON.stringify((result as any).lockMetadata)).not.toContain(tempRoot);
    expect(JSON.stringify((result as any).lockMetadata)).not.toContain(tempWorktree);

    const events = await eventStore.eventsForBead('bd-1');
    const failed = events.find(event =>
      event.type === DomainEventName.PROJECT_TOOL_FAILED &&
      event.data?.tool === 'stateful_tool'
    );
    expect(failed?.data?.failureCategory).toBe(ProjectToolFailureCategory.BACKPRESSURE);
    expect(failed?.data?.result).toMatchObject({
      status: ToolResultStatus.REJECTED,
      failureCategory: ProjectToolFailureCategory.BACKPRESSURE,
      lockTimeout: true,
      lockMetadata: {
        scope: 'project',
        waitedMs: 0,
        tool: 'stateful_tool',
        server: 'stateful-server'
      }
    });
    expect(failed?.data?.result?.nextAction).toBeUndefined();
    expect(JSON.stringify(failed?.data?.result)).not.toContain(tempRoot);
    expect(JSON.stringify(failed?.data?.result)).not.toContain(tempWorktree);
  });

  it('serializes command project-tool calls when the config sets serialize:true (covers tsProjectTool expansion)', () => {
    expect(shouldSerializeCommandTool({ type: ProjectToolType.COMMAND, serialize: true })).toBe(true);
    expect(shouldSerializeCommandTool({ type: ProjectToolType.COMMAND, serialize: false })).toBe(false);
    expect(shouldSerializeCommandTool({ type: ProjectToolType.COMMAND })).toBe(false);
    // serialize only applies to command tools here, never MCP tools.
    expect(shouldSerializeCommandTool({ type: ProjectToolType.MCP, serialize: true } as any)).toBe(false);
  });

  // ── Concurrency: mutual exclusion for serialize:true command/ts tools (AC2/AC3) ──
  //
  // Each invocation appends `start <id>` and `end <id>` to a shared marker file
  // with a fixed blocking sleep in between (Atomics.wait — a real wall-clock
  // sleep, no busy-spin, deterministic). When two invocations of the SAME
  // serialized tool run concurrently the cross-process lock forces them to run
  // back-to-back, so the marker sequence must be [start X, end X, start Y, end Y]
  // — never interleaved.
  function mutualExclusionScript(markerFile: string): string {
    return `
const fs = require('fs');
const id = process.argv[1];
const marker = ${JSON.stringify(markerFile)};
function blockingSleep(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}
fs.appendFileSync(marker, 'start ' + id + '\\n');
blockingSleep(150);
fs.appendFileSync(marker, 'end ' + id + '\\n');
process.stdout.write(JSON.stringify({ id, done: true }));
`;
  }

  function serializedCommandTool(script: string, name = 'serial_marker'): ProjectCommandToolConfig {
    return {
      name,
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', script, '--'],
      argsMode: 'append',
      allowArgs: true,
      serialize: true
    };
  }

  function runMarkerTool(tool: ProjectCommandToolConfig, id: string) {
    return executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: `marker-${id}`,
      arguments: { argv: [id] }
    }, {} as any, undefined, new Map());
  }

  function assertNoInterleave(sequence: string[]): void {
    // Walk pairs: every `start X` must be immediately followed by `end X`.
    for (let i = 0; i < sequence.length; i += 2) {
      const open = sequence[i];
      const close = sequence[i + 1];
      expect(open?.startsWith('start ')).toBe(true);
      expect(close?.startsWith('end ')).toBe(true);
      expect(close.slice('end '.length)).toBe(open.slice('start '.length));
    }
  }

  it('serialized command tools do NOT overlap across concurrent invocations (mutual exclusion)', async () => {
    const markerFile = path.join(tempRoot, 'serial-markers.txt');
    fs.writeFileSync(markerFile, '');
    const tool = serializedCommandTool(mutualExclusionScript(markerFile));

    const [a, b] = await Promise.all([runMarkerTool(tool, 'A'), runMarkerTool(tool, 'B')]);
    expect(a.status).toBe(ToolResultStatus.PASSED);
    expect(b.status).toBe(ToolResultStatus.PASSED);

    const sequence = fs.readFileSync(markerFile, 'utf8').trim().split('\n').filter(Boolean);
    expect(sequence.length).toBe(4);
    assertNoInterleave(sequence);
  });

  it('serialized tsProjectTool tools do NOT overlap (serialize survives tsProjectTool expansion)', async () => {
    // Drive the tsProjectTool shorthand through the ConfigLoader so we exercise
    // the real expansion path (tsProjectTool -> type: command, serialize preserved).
    const scriptDir = path.join(tempRoot, '.pi', 'project-tools');
    fs.mkdirSync(scriptDir, { recursive: true });
    const markerFile = path.join(tempRoot, 'ts-serial-markers.txt');
    fs.writeFileSync(markerFile, '');
    const scriptPath = path.join(scriptDir, 'serial_ts.ts');
    fs.writeFileSync(scriptPath, mutualExclusionScript(markerFile));

    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  eventStore:
    enabled: true
  worktreePolicy:
    default: always
tools:
  - name: serial_ts
    type: tsProjectTool
    description: "serialized ts tool"
    serialize: true
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
    configLoader.reset();
    const config = configLoader.load();
    const expanded = (config.tools || []).find(t => t.name === 'serial_ts') as ProjectCommandToolConfig | undefined;
    expect(expanded).toBeDefined();
    expect(expanded!.type).toBe(ProjectToolType.COMMAND);
    // serialize survived the tsProjectTool -> command expansion.
    expect(expanded!.serialize).toBe(true);
    expect(shouldSerializeCommandTool(expanded!)).toBe(true);

    const [a, b] = await Promise.all([runMarkerTool(expanded!, 'A'), runMarkerTool(expanded!, 'B')]);
    expect(a.status).toBe(ToolResultStatus.PASSED);
    expect(b.status).toBe(ToolResultStatus.PASSED);

    const sequence = fs.readFileSync(markerFile, 'utf8').trim().split('\n').filter(Boolean);
    expect(sequence.length).toBe(4);
    assertNoInterleave(sequence);
  });

  it('non-serialized command tools ARE allowed to run concurrently', async () => {
    // Rendezvous proof of genuine overlap (deterministic, not timing-based):
    // each invocation writes its own start marker, then polls until it observes
    // the OTHER invocation's start marker before finishing. If the two ran
    // concurrently both observe each other and both complete; if they were
    // (wrongly) serialized the first would block waiting for the second's start
    // and time out. No serialize flag here, so concurrency must be allowed.
    const markerDir = path.join(tempRoot, 'rendezvous');
    fs.mkdirSync(markerDir, { recursive: true });
    const script = `
const fs = require('fs');
const path = require('path');
const id = process.argv[1];
const other = id === 'A' ? 'B' : 'A';
const dir = ${JSON.stringify(markerDir)};
function blockingSleep(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}
fs.writeFileSync(path.join(dir, id + '.start'), '1');
const deadline = Date.now() + 4000;
let sawOther = false;
while (Date.now() < deadline) {
  if (fs.existsSync(path.join(dir, other + '.start'))) { sawOther = true; break; }
  blockingSleep(10);
}
process.stdout.write(JSON.stringify({ id, sawOther }));
process.exit(sawOther ? 0 : 1);
`;
    const tool: ProjectCommandToolConfig = {
      name: 'concurrent_marker',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', script, '--'],
      argsMode: 'append',
      allowArgs: true
      // no serialize — concurrency must be allowed.
    };

    const [a, b] = await Promise.all([runMarkerTool(tool, 'A'), runMarkerTool(tool, 'B')]);
    expect(a.status).toBe(ToolResultStatus.PASSED);
    expect(b.status).toBe(ToolResultStatus.PASSED);
    expect(JSON.parse(fs.readFileSync(a.stdoutFile!, 'utf8')).sawOther).toBe(true);
    expect(JSON.parse(fs.readFileSync(b.stdoutFile!, 'utf8')).sawOther).toBe(true);
  });

  it('returns structured backpressure when a serialize:true command lock acquisition times out (AC4)', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    // Reject ONLY the command project-tool lock; let the shared events-JSONL
    // append lock (a .jsonl path) succeed so event recording is unaffected.
    vi.spyOn(lockfile, 'lock').mockImplementation(async (target: string) => {
      if (String(target).includes('orr-else-command-tool-locks')) {
        throw new Error('Lock file is already being held');
      }
      return (async () => {}) as () => Promise<void>;
    });
    const tool: ProjectCommandToolConfig = {
      name: 'serial_command',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stdout.write("never runs")'],
      serialize: true
    };

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'serial'
    }, {} as any, undefined, new Map());

    // 0yt5.16/0yt5.17: the harness no longer attaches nextAction steering; the
    // lock-timeout backpressure result (tool/status/failureCategory/lockTimeout +
    // lockMetadata + message) is still produced and passed through verbatim.
    expect(result).toMatchObject({
      tool: 'serial_command',
      status: ToolResultStatus.REJECTED,
      failureCategory: ProjectToolFailureCategory.BACKPRESSURE,
      lockTimeout: true
    });
    expect((result as any).nextAction).toBeUndefined();
    expect((result as any).message).toContain('could not acquire the serialized project-tool lock');
    expect((result as any).lockMetadata).toMatchObject({
      scope: 'project',
      waitedMs: 0,
      tool: 'serial_command'
    });
    // No absolute project/worktree paths leak into the model-facing metadata.
    expect(JSON.stringify((result as any).lockMetadata)).not.toContain(tempRoot);
    expect(JSON.stringify((result as any).lockMetadata)).not.toContain(tempWorktree);
  });

  it('rejects configured non-zero success exit codes when stderr contains an error', async () => {
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'ast_grep',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'console.error("missing path"); process.exit(1);'],
      successExitCodes: [0, 1]
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.exitCode).toBe(1);
    // s3wp.25: raw stderr is in stderrFile; stderrHint is the compact classification excerpt
    expect((result as any).stderrHint).toContain('missing path');
  });

  // The harness no longer recognizes no-match by tool name (the cerdiwen ast_grep
  // tool self-parses and sets matchStatus in its own minimal result). These tests
  // now assert the GENERIC no-match steering that remains: attachProjectToolSteering
  // routes record_no_match for ANY tool result that already carries matchStatus.
  it('allows command tools to opt into accepted max-buffer truncation', () => {
    const tool = {
      name: 'ast_grep',
      type: ProjectToolType.COMMAND,
      command: 'ast-grep',
      acceptMaxBuffer: true
    };

    expect(isAcceptedMaxBufferFailure(tool, { code: CommandErrorCode.MAX_BUFFER })).toBe(true);
    expect(isAcceptedMaxBufferFailure({ ...tool, acceptMaxBuffer: false }, { code: CommandErrorCode.MAX_BUFFER })).toBe(false);
    expect(isAcceptedMaxBufferFailure(tool, { code: 'ENOENT' })).toBe(false);
  });

  it('rejects verifier retries after the configured per-state failure limit', async () => {
    const tool: ProjectCommandToolConfig = {
      name: 'pytest',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stderr.write("failed verifier"); process.exit(1);'],
      cwd: CwdMode.WORKTREE,
      failureLimit: {
        maxFailuresPerState: 1,
        suggestedOutcome: 'BLOCKED',
        terminal: true
      }
    };

    const context = {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'surgical-execution'
    };
    const first = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());
    const second = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());

    expect(first).toMatchObject({
      tool: 'pytest',
      status: ToolResultStatus.REJECTED,
      failureLimit: {
        failureCount: 1,
        maxFailures: 1,
        suggestedOutcome: 'BLOCKED',
        terminal: true
      }
    });
    expect(second).toMatchObject({
      tool: 'pytest',
      status: ToolResultStatus.REJECTED,
      failureLimit: {
        failureCount: 1,
        maxFailures: 1,
        suggestedOutcome: 'BLOCKED',
        terminal: true
      }
    });
  });

  it('does not count infrastructure ENOSPC failures toward verifier failure limits', async () => {
    const tool: ProjectCommandToolConfig = {
      name: 'pytest',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stderr.write("No space left on device (os error 28)"); process.exit(1);'],
      cwd: CwdMode.WORKTREE,
      failureLimit: {
        maxFailuresPerState: 1,
        suggestedOutcome: 'BLOCKED',
        terminal: true
      }
    };
    const context = {
      beadId: 'bd-1',
      stateId: 'AdversarialPostReview',
      actionId: 'adversarial-code-review'
    };

    const first = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());
    const second = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());

    expect(first).toMatchObject({ tool: 'pytest', status: ToolResultStatus.REJECTED });
    expect(second).toMatchObject({ tool: 'pytest', status: ToolResultStatus.REJECTED });
    expect((first as any).failureLimit).toBeUndefined();
    expect((second as any).failureLimit).toBeUndefined();
  });

  it('backpressures concurrent configured project-tool invocations for the same worker action', async () => {
    const sharedBackpressure: ProjectToolBackpressure = new Map();
    const tool: ProjectCommandToolConfig = {
      name: 'slow_probe',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'setTimeout(() => { console.log(JSON.stringify({ tool: "slow_probe", status: "PASSED" })); }, 80);'],
      cwd: CwdMode.WORKTREE
    };
    const context = {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'formulate-plan'
    };

    const results = await Promise.all([
      executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, sharedBackpressure),
      executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, sharedBackpressure),
      executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, sharedBackpressure)
    ]);

    expect(results.filter(result => (result as any).status === ToolResultStatus.PASSED)).toHaveLength(1);
    const backpressured = results.filter(result => (result as any).failureCategory === ProjectToolFailureCategory.BACKPRESSURE);
    expect(backpressured).toHaveLength(2);
    expect((backpressured[0] as any).nextAction).toBe('wait_for_in_flight_result');
    expect((backpressured[0] as any).message).toContain('already running');

    const events = await eventStore.eventsForBead('bd-1');
    expect(events.filter(event =>
      event.type === DomainEventName.PROJECT_TOOL_STARTED &&
      event.data?.tool === 'slow_probe'
    )).toHaveLength(1);
    expect(events.filter(event =>
      event.type === DomainEventName.PROJECT_TOOL_FAILED &&
      event.data?.tool === 'slow_probe' &&
      event.data?.failureCategory === ProjectToolFailureCategory.BACKPRESSURE
    )).toHaveLength(2);
  });

  it('independent backpressure holders do not share in-flight state', async () => {
    const holderA: ProjectToolBackpressure = new Map();
    const holderB: ProjectToolBackpressure = new Map();
    const tool: ProjectCommandToolConfig = {
      name: 'slow_probe_isolation',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'setTimeout(() => { console.log(JSON.stringify({ tool: "slow_probe_isolation", status: "PASSED" })); }, 80);'],
      cwd: CwdMode.WORKTREE
    };
    const context = {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'formulate-plan'
    };

    // Reserve via holderA — holderB must NOT see the in-flight entry
    const resultsA = await Promise.all([
      executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, holderA),
      executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, holderA)
    ]);
    // holderB is completely independent — both calls should proceed without backpressure
    const resultsB = await Promise.all([
      executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, holderB),
      executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, holderB)
    ]);

    // holderA: one success, one backpressured
    expect(resultsA.filter(r => (r as any).status === ToolResultStatus.PASSED)).toHaveLength(1);
    expect(resultsA.filter(r => (r as any).failureCategory === ProjectToolFailureCategory.BACKPRESSURE)).toHaveLength(1);

    // holderB: independent — its own pair is unaffected by holderA
    // One succeeds and one is backpressured within its own holder
    expect(resultsB.filter(r => (r as any).status === ToolResultStatus.PASSED)).toHaveLength(1);
    expect(resultsB.filter(r => (r as any).failureCategory === ProjectToolFailureCategory.BACKPRESSURE)).toHaveLength(1);

    // Crucially: holderA reserves don't bleed into holderB and vice versa
    expect(holderA.size).toBe(0); // fully released after both calls complete
    expect(holderB.size).toBe(0);
  });

  it('reserve and release on the injected holder behave exactly as before', async () => {
    const backpressure: ProjectToolBackpressure = new Map();
    const tool: ProjectCommandToolConfig = {
      name: 'reserve_release_probe',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'console.log(JSON.stringify({ tool: "reserve_release_probe", status: "PASSED" }));'],
      cwd: CwdMode.WORKTREE
    };
    const context = {
      beadId: 'bd-2',
      stateId: 'Planning',
      actionId: 'reserve-release-action'
    };

    // Map is empty before the call
    expect(backpressure.size).toBe(0);

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, backpressure);

    // Call succeeds
    expect((result as any).status).toBe(ToolResultStatus.PASSED);
    // Map is empty after release (finally block ran)
    expect(backpressure.size).toBe(0);

    // A second sequential call on the same context succeeds — the first was released
    const result2 = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, backpressure);
    expect((result2 as any).status).toBe(ToolResultStatus.PASSED);
    expect(backpressure.size).toBe(0);
  });

  it('ignores legacy unscoped failures when enforcing per-state failure limits', async () => {
    const tool: ProjectCommandToolConfig = {
      name: 'pytest',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stdout.write(JSON.stringify({ tool: "pytest", status: "PASSED" }));'],
      cwd: CwdMode.WORKTREE,
      failureLimit: {
        maxFailuresPerState: 1,
        suggestedOutcome: 'BLOCKED',
        terminal: true
      }
    };

    const context = {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'surgical-execution'
    };
    await eventStore.record(DomainEventName.PROJECT_TOOL_FAILED, {
      beadId: context.beadId,
      tool: tool.name,
      type: tool.type,
      status: ToolResultStatus.REJECTED,
      result: {
        failureLimit: {
          failureCount: 1,
          maxFailures: 1,
          suggestedOutcome: 'FAILURE',
          terminal: true
        }
      }
    });

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());

    expect(result).toMatchObject({
      tool: 'pytest',
      status: ToolResultStatus.PASSED
    });
  });

  it('keeps project tool failure limits across a context restart in the same state action', async () => {
    const tool: ProjectCommandToolConfig = {
      name: 'pytest',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stderr.write("failed verifier"); process.exit(1);'],
      cwd: CwdMode.WORKTREE,
      failureLimit: {
        maxFailuresPerState: 1,
        suggestedOutcome: 'BLOCKED',
        terminal: true
      }
    };
    const context = {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'surgical-execution'
    };

    await eventStore.record(DomainEventName.STATE_RUN_INITIALIZED, context);
    await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());
    const terminalRetry = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());
    expect(terminalRetry).toMatchObject({
      failureLimit: {
        failureCount: 1,
        terminal: true
      }
    });

    await eventStore.record(DomainEventName.CONTEXT_RESTART_REQUESTED, {
      ...context,
      targetState: context.stateId,
      transitionEvent: EventName.CONTEXT_RESTART
    });
    await eventStore.record(DomainEventName.STATE_RUN_INITIALIZED, context);
    const restartedRetry = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());
    expect(restartedRetry).toMatchObject({
      failureLimit: {
        failureCount: 2,
        terminal: true
      }
    });
  });

  it('resets project tool failure limits after a non-restart state transition', async () => {
    const tool: ProjectCommandToolConfig = {
      name: 'pytest',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stderr.write("failed verifier"); process.exit(1);'],
      cwd: CwdMode.WORKTREE,
      failureLimit: {
        maxFailuresPerState: 1,
        suggestedOutcome: 'BLOCKED',
        terminal: true
      }
    };
    const context = {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'surgical-execution'
    };

    await eventStore.record(DomainEventName.STATE_RUN_INITIALIZED, context);
    await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());
    const terminalRetry = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());
    expect(terminalRetry).toMatchObject({
      failureLimit: {
        failureCount: 1,
        terminal: true
      }
    });

    await eventStore.record(DomainEventName.STATE_TRANSITION_APPLIED, {
      ...context,
      fromState: context.stateId,
      nextState: context.stateId,
      transitionEvent: EventName.BLOCKED
    });
    await eventStore.record(DomainEventName.STATE_RUN_INITIALIZED, context);
    const freshRunFailure = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());
    expect(freshRunFailure).toMatchObject({
      status: ToolResultStatus.REJECTED,
      failureLimit: {
        failureCount: 1,
        terminal: true
      }
    });
  });

  it('resets project tool failure limits after an acknowledged terminal outcome starts a fresh run', async () => {
    const tool: ProjectCommandToolConfig = {
      name: 'artifact_validator',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stderr.write("invalid artifact"); process.exit(1);'],
      cwd: CwdMode.WORKTREE,
      failureLimit: {
        maxFailuresPerState: 1,
        suggestedOutcome: EventName.FAILURE,
        terminal: true
      }
    };
    const context = {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'formulate-plan'
    };

    await eventStore.record(DomainEventName.STATE_RUN_INITIALIZED, context);
    await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());
    const terminalRetry = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());
    expect(terminalRetry).toMatchObject({
      failureLimit: {
        failureCount: 1,
        terminal: true
      }
    });

    await eventStore.record(DomainEventName.SIGNAL_ACKNOWLEDGED, {
      type: TeammateEventType.STATE_FAILED,
      ...context,
      transitionEvent: EventName.FAILURE
    });
    await eventStore.record(DomainEventName.STATE_RUN_INITIALIZED, context);
    const freshRunFailure = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());

    expect(freshRunFailure).toMatchObject({
      status: ToolResultStatus.REJECTED,
      failureLimit: {
        failureCount: 1,
        terminal: true
      }
    });
  });

  it('uses state-specific project tool failure-limit routing outcomes', async () => {
    const tool: ProjectCommandToolConfig = {
      name: 'pytest',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stderr.write("failed verifier"); process.exit(1);'],
      cwd: CwdMode.WORKTREE,
      failureLimit: {
        maxFailuresPerState: 1,
        suggestedOutcome: 'BLOCKED',
        suggestedOutcomeByState: {
          AdversarialPostReview: 'TEST_FAILURE'
        },
        terminal: true
      }
    };

    expect(projectToolFailureLimitSuggestedOutcome(tool, 'Implementation', 'surgical-execution')).toBe('BLOCKED');
    expect(projectToolFailureLimitSuggestedOutcome(tool, 'AdversarialPostReview', 'adversarial-code-review')).toBe('TEST_FAILURE');

    const context = {
      beadId: 'bd-1',
      stateId: 'AdversarialPostReview',
      actionId: 'adversarial-code-review'
    };
    await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());
    const second = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());

    expect(second).toMatchObject({
      failureLimit: {
        suggestedOutcome: 'TEST_FAILURE',
        terminal: true
      }
    });
  });

  it('preserves structured routing hints when a project tool reaches its failure limit', async () => {
    const payload = JSON.stringify({
      tool: 'artifact_validator',
      status: ToolResultStatus.REJECTED,
      routingHint: {
        suggestedOutcome: 'REQUIREMENTS_DEFECT',
        reason: 'Consumed requirements analysis is stale.'
      }
    });
    const tool: ProjectCommandToolConfig = {
      name: 'artifact_validator',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `process.stdout.write(${JSON.stringify(payload)}); process.exit(1);`],
      cwd: CwdMode.WORKTREE,
      failureLimit: {
        maxFailuresPerState: 1,
        suggestedOutcome: 'FAILURE',
        terminal: true
      }
    };
    const context = {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'formulate-plan'
    };

    const first = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());
    const second = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any, undefined, new Map());

    // 0yt5.16/0yt5.17: failure-limit still derives suggestedOutcome from the tool's
    // routingHint and attaches failureCategory + remediation; the harness no longer
    // attaches nextAction steering.
    expect(first).toMatchObject({
      status: ToolResultStatus.REJECTED,
      failureCategory: ProjectToolFailureCategory.TERMINAL_GATE,
      failureLimit: {
        suggestedOutcome: 'REQUIREMENTS_DEFECT',
        terminal: true
      }
    });
    expect((first as any).nextAction).toBeUndefined();
    expect(second).toMatchObject({
      status: ToolResultStatus.REJECTED,
      failureCategory: ProjectToolFailureCategory.TERMINAL_GATE,
      failureLimit: {
        suggestedOutcome: 'REQUIREMENTS_DEFECT',
        terminal: true
      }
    });
    expect((second as any).nextAction).toBeUndefined();
    expect(second.remediation).toEqual(expect.arrayContaining([
      expect.stringContaining('terminal gate has already produced the routing decision')
    ]));
  });

  it('rejects artifact_validator unsupported output-control flags before execution', async () => {
    const marker = path.join(tempRoot, 'artifact-validator-ran.txt');
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'artifact_validator',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`],
      cwd: CwdMode.WORKTREE,
      allowArgs: true,
      argsMode: 'append'
    }, {
      beadId: 'bd-1',
      stateId: 'AdversarialPreReview',
      actionId: 'artifact-validation',
      arguments: {
        argv: ['planContract', '--output-limit', '20000']
      }
    }, {} as any, undefined, new Map());

    // 0yt5.16/0yt5.17: the pre-execution output-control-flag rejection still fires
    // (tool/status/failureCategory/unsupportedOutputControlFlag + remediation); the
    // harness no longer attaches nextAction steering.
    expect(result).toMatchObject({
      tool: 'artifact_validator',
      status: ToolResultStatus.REJECTED,
      failureCategory: ProjectToolFailureCategory.TOOL_INPUT_ERROR,
      unsupportedOutputControlFlag: '--output-limit'
    });
    expect((result as any).nextAction).toBeUndefined();
    expect(result.message).toContain('does not support output-control flag --output-limit');
    expect(result.remediation).toEqual(expect.arrayContaining([
      expect.stringContaining('structuredResult'),
      expect.stringContaining('compactSummary'),
      expect.stringContaining('stdoutFile/stderrFile'),
      expect.stringContaining('supported harness retrieval patterns')
    ]));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('suppresses raw stdout/stderr and keeps structuredResult when artifact_validator has no unsupported output-control flag', async () => {
    // When a structuredResult is present (produced here by structuredPayloadSummary from
    // the checks array), raw stdout/stderr are suppressed from the model-facing result per
    // the generalized hasStructuredModelSummary suppression rule.  The compact structured
    // payload and metadata fields remain visible; the archive preserves the full raw output.
    const payload = JSON.stringify({
      tool: 'artifact_validator',
      status: ToolResultStatus.PASSED,
      artifact: 'planContract',
      checks: [
        { name: 'schema', status: ToolResultStatus.PASSED, message: 'valid' }
      ]
    });
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'artifact_validator',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `process.stdout.write(${JSON.stringify(payload)});`, '--'],
      cwd: CwdMode.WORKTREE,
      allowArgs: true,
      argsMode: 'append',
    }, {
      beadId: 'bd-1',
      stateId: 'AdversarialPreReview',
      actionId: 'artifact-validation',
      arguments: {
        argv: ['planContract']
      }
    }, {} as any, undefined, new Map());

    // s3wp.25 minimal schema: compact metadata fields are retained
    expect(result).toMatchObject({
      tool: 'artifact_validator',
      status: ToolResultStatus.PASSED,
      stdoutBytes: Buffer.byteLength(payload),
      stderrBytes: 0
    });
    // 0yt5.16/0yt5.17: the harness no longer attaches nextAction steering.
    expect((result as any).nextAction).toBeUndefined();
    // stdoutTruncated/stderrTruncated/maxBufferExceeded are no longer present (s3wp.25)
    expect((result as any).stdoutTruncated).toBeUndefined();
    expect((result as any).stderrTruncated).toBeUndefined();
    expect((result as any).maxBufferExceeded).toBeUndefined();
    // structuredResult is present (passedCheckCount from the checks array)
    const structuredResult = (result as any).structuredResult;
    expect(structuredResult).toBeDefined();
    expect(structuredResult.passedCheckCount).toBe(1);
    expect(structuredResult.rejectedCheckCount).toBe(0);
    // Raw stdout/stderr are not in the model-facing result (s3wp.25)
    expect((result as any).stdout).toBeUndefined();
    expect((result as any).stderr).toBeUndefined();
    // stdoutFile/stderrFile are now visible (raw refs)
    expect(typeof result.stdoutFile).toBe('string');
    expect(typeof result.stderrFile).toBe('string');
    // No output-control flag issues
    expect(result.unsupportedOutputControlFlag).toBeUndefined();
    expect(result.failureCategory).toBeUndefined();
    expect(result.remediation).toBeUndefined();
  });

  it('classifies representative project-tool failures for agent remediation', () => {
    const tool = { name: 'fixture_mcp_tool' } as ProjectCommandToolConfig;

    expect(classifyProjectToolFailure(tool, {
      status: ToolResultStatus.REJECTED,
      failureLimit: { terminal: true }
    })).toBe(ProjectToolFailureCategory.TERMINAL_GATE);
    expect(classifyProjectToolFailure(tool, {
      status: ToolResultStatus.UNAVAILABLE,
      message: 'command not found'
    })).toBe(ProjectToolFailureCategory.UNAVAILABLE);
    expect(classifyProjectToolFailure(tool, {
      status: ToolResultStatus.REJECTED,
      message: 'MCP project tool fixture_mcp_tool path argument path escapes configured root'
    })).toBe(ProjectToolFailureCategory.TOOL_INPUT_ERROR);
    expect(classifyProjectToolFailure(tool, {
      status: ToolResultStatus.REJECTED,
      timedOut: true,
      message: 'request timed out'
    })).toBe(ProjectToolFailureCategory.TRANSIENT_TRANSPORT);
    expect(classifyProjectToolFailure(tool, {
      status: ToolResultStatus.REJECTED,
      message: 'dirty worktree contains files outside approved write set'
    })).toBe(ProjectToolFailureCategory.WORKTREE_STATE_ERROR);
    expect(classifyProjectToolFailure(tool, {
      status: ToolResultStatus.REJECTED,
      exitCode: 1,
      stderr: 'tests failed'
    })).toBe(ProjectToolFailureCategory.VERIFIER_FAILED);
  });

  it('streams large command output to per-call files instead of failing on max buffer', async () => {
    const outputBytes = 200_000;
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'large_stdout',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `process.stdout.write('x'.repeat(${outputBytes}));`],
      cwd: CwdMode.WORKTREE,
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    // s3wp.25: maxBufferExceeded/stdoutTruncated no longer in model-facing result
    expect((result as any).maxBufferExceeded).toBeUndefined();
    expect((result as any).stdoutTruncated).toBeUndefined();
    expect(result.stdoutBytes).toBe(outputBytes);
    // 0yt5.16/0yt5.17: the harness no longer runs a high-volume summarizer or
    // attaches nextAction steering — the large result is passed through verbatim
    // (raw persisted to stdoutFile; byte count surfaced).
    expect((result as any).nextAction).toBeUndefined();
    // s3wp.25: raw output is in stdoutFile/stderrFile; no outputArchive envelope
    expect(typeof result.stdoutFile).toBe('string');
    expect(typeof result.stderrFile).toBe('string');
    expect((result as any).outputArchive).toBeUndefined();
    // stdoutFile should be an absolute path to the stdout log
    expect(path.isAbsolute(result.stdoutFile!)).toBe(true);
    expect(result.stdoutFile).toContain('stdout.log');
  });

  // s3wp.24/s3wp.25: >10MB fixture test — raw files complete, model-facing result minimal
  it('s3wp.25 fixture: command emitting >10MB stdout/stderr persists complete raw bytes; model-facing has NO inline text', async () => {
    // Each of stdout and stderr emits >10MB.  The raw file must match byte-for-byte;
    // the model-facing result must NOT contain raw stdout, stderr, or preview fields.
    const stdoutMB = 11; // 11 MiB stdout
    const stderrMB = 11; // 11 MiB stderr
    const stdoutBytes = stdoutMB * 1024 * 1024;
    const stderrBytes = stderrMB * 1024 * 1024;

    // We generate deterministic content: a repeating pattern so we can checksum it.
    const stdoutPattern = 'STDOUT-LINE-DATA-FIXTURE '; // 25 bytes
    const stderrPattern = 'STDERR-LINE-DATA-FIXTURE '; // 25 bytes
    const stdoutRepeat = Math.ceil(stdoutBytes / stdoutPattern.length);
    const stderrRepeat = Math.ceil(stderrBytes / stderrPattern.length);
    const expectedStdout = stdoutPattern.repeat(stdoutRepeat).slice(0, stdoutBytes);
    const expectedStderr = stderrPattern.repeat(stderrRepeat).slice(0, stderrBytes);

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'large_fixture_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `
          const pattern = ${JSON.stringify(stdoutPattern)};
          const n = ${stdoutRepeat};
          const out = pattern.repeat(n).slice(0, ${stdoutBytes});
          process.stdout.write(out);
          const ep = ${JSON.stringify(stderrPattern)};
          const en = ${stderrRepeat};
          const err = ep.repeat(en).slice(0, ${stderrBytes});
          process.stderr.write(err);
        `
      ],
      cwd: CwdMode.WORKTREE,
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'fixture'
    }, {} as any, undefined, new Map());

    // s3wp.25: model-facing JSON must NOT include raw stdout/stderr or previews
    expect(result.stdout).toBeUndefined();
    expect(result.stderr).toBeUndefined();
    expect((result as any).stdoutTruncated).toBeUndefined();
    expect((result as any).stderrTruncated).toBeUndefined();
    expect((result as any).outputTruncated).toBeUndefined();
    expect((result as any).outputArchive).toBeUndefined();
    // s3wp.6: generic summarizer fires for large PASSED tools - resultPreview may be present
    // as a compact summary (tool-name-agnostic behavior).
    expect((result as any).diagnosticFacts).toBeUndefined();
    expect((result as any).outputPreview).toBeUndefined();

    // s3wp.25: stdoutFile and stderrFile are present and point to actual files
    expect(typeof result.stdoutFile).toBe('string');
    expect(typeof result.stderrFile).toBe('string');
    expect(fs.existsSync(result.stdoutFile!)).toBe(true);
    expect(fs.existsSync(result.stderrFile!)).toBe(true);

    // Byte count must match exactly
    const rawStdoutStat = fs.statSync(result.stdoutFile!);
    const rawStderrStat = fs.statSync(result.stderrFile!);
    expect(rawStdoutStat.size).toBe(stdoutBytes);
    expect(rawStderrStat.size).toBe(stderrBytes);
    expect(result.stdoutBytes).toBe(stdoutBytes);
    expect(result.stderrBytes).toBe(stderrBytes);

    // SHA-256 of raw file must match SHA-256 of expected content
    const { createHash } = await import('node:crypto');
    const rawStdoutContent = fs.readFileSync(result.stdoutFile!);
    const rawStderrContent = fs.readFileSync(result.stderrFile!);
    const stdoutHash = createHash('sha256').update(rawStdoutContent).digest('hex');
    const stderrHash = createHash('sha256').update(rawStderrContent).digest('hex');
    const expectedStdoutHash = createHash('sha256').update(Buffer.from(expectedStdout)).digest('hex');
    const expectedStderrHash = createHash('sha256').update(Buffer.from(expectedStderr)).digest('hex');
    expect(stdoutHash).toBe(expectedStdoutHash);
    expect(stderrHash).toBe(expectedStderrHash);
  }, 60_000); // 60s timeout for large I/O

  it('no-summary regression guard: raw MCP content appears in resultPreview when no diagnosticSummary', async () => {
    // DEFECT 1 guard: ensure hasDiagnosticSummary=false does not suppress normal MCP previews.
    // Uses a non-diagnostic MCP tool name so applyDiagnosticModelSummary returns no summary.
    const mcpContent = {
      content: [{ type: 'text', text: 'symbol fixture_unique_lookup_symbol found at packages/engine.py:42' }]
    };

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'fixture_mcp_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'fixture_mcp_tool',
          status: 'PASSED',
          result: ${JSON.stringify(mcpContent)}
        }))`
      ],
      cwd: CwdMode.WORKTREE
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    // No diagnosticSummary: the model sees the minimal schema
    expect(result.diagnosticSummary).toBeUndefined();
    // s3wp.25: raw MCP content is in stdoutFile, not inline in the model-facing result.
    // The model-facing result has stdoutFile reference instead.
    expect(typeof result.stdoutFile).toBe('string');
    // Raw content IS available in the file
    const rawContent = fs.readFileSync(result.stdoutFile!, 'utf8');
    expect(rawContent).toContain('fixture_unique_lookup_symbol');
  });

  // 0yt5.17 AC2/AC3: the harness performs NO truncation/capping/size-backstop and
  // NO summarization — persistAndBoundResult persists the FULL raw result to
  // outputFile and returns the tool's result VERBATIM (minus internal-only raw
  // stream keys that are not part of the tool's result).
  function passthroughContext(label: string): ProjectToolExecutionContext {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orr-else-passthrough-${label}-`));
    return {
      templateContext: { toolInvocationId: 'inv-1', toolName: 'verbatim_tool' } as any,
      cwd: dir,
      callDir: dir,
      outputDir: dir,
      outputFile: path.join(dir, 'output.json'),
      tmpDir: path.join(dir, 'tmp'),
      hostEnv: {}
    };
  }

  it('AC2: passes a very large (5MB) ToolResultBase result through UNCHANGED (no cap/truncation/warning)', async () => {
    const big = 'A'.repeat(5 * 1024 * 1024); // 5 MiB
    const definition = { name: 'verbatim_tool', type: ProjectToolType.MCP } as ProjectMcpToolConfig;
    const toolResult = {
      tool: 'verbatim_tool',
      status: ToolResultStatus.PASSED,
      structuredResult: { findings: 1, blob: big }
    };
    const context = passthroughContext('5mb');

    const modelFacing = await persistAndBoundResult(definition, toolResult, context) as Record<string, unknown>;

    // (a) returned result is UNCHANGED — no rejection, no truncation, no warning injected
    expect(modelFacing.tool).toBe('verbatim_tool');
    expect(modelFacing.status).toBe(ToolResultStatus.PASSED);
    expect((modelFacing.structuredResult as any).blob).toBe(big);
    expect((modelFacing.structuredResult as any).blob.length).toBe(5 * 1024 * 1024);
    // No size-backstop / oversize / warning fields appear.
    expect(modelFacing.outputTruncated).toBeUndefined();
    expect(modelFacing.warning).toBeUndefined();
    expect(modelFacing.oversize).toBeUndefined();
    // (b) the FULL raw result is persisted verbatim to outputFile (the archive).
    const persisted = fs.readFileSync(context.outputFile, 'utf8');
    expect(persisted).toContain(big);
  });

  it('AC3 NEGATIVE: a result containing a literal "[truncated 999 bytes]" string passes through VERBATIM', async () => {
    const literal = 'diagnostic line\n[truncated 999 bytes]\nmore output';
    const definition = { name: 'verbatim_tool', type: ProjectToolType.MCP } as ProjectMcpToolConfig;
    const toolResult = {
      tool: 'verbatim_tool',
      status: ToolResultStatus.PASSED,
      structuredResult: { message: literal }
    };
    const context = passthroughContext('literal');

    const modelFacing = await persistAndBoundResult(definition, toolResult, context) as Record<string, unknown>;

    // The literal marker is preserved untouched in the model-facing result...
    expect((modelFacing.structuredResult as any).message).toBe(literal);
    // ...and verbatim in the persisted archive.
    const persisted = fs.readFileSync(context.outputFile, 'utf8');
    expect(persisted).toContain('[truncated 999 bytes]');
  });

  it('bounds inline project tool observations while preserving structured rejection summaries', async () => {
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'structured_json_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'artifact_validator',
          status: 'REJECTED',
          artifact: 'planContract',
          routingHint: 'rewrite the plan contract',
          checks: [
            { name: 'schema', status: 'PASSED', message: 'valid' },
            { name: 'write-set-gitignored', status: 'REJECTED', message: 'planned write set contains ignored files' }
          ],
          errors_by_tool: {
            semgrep: [
              { tool: 'semgrep', file: 'src/example.py', line: 12, code: 'rule.id', message: 'blocking finding', blocking: true }
            ]
          },
          filler: 'x'.repeat(20000)
        })); process.exit(1);`
      ],
      cwd: CwdMode.WORKTREE,
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    const structuredResult = result.structuredResult as any;

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    // s3wp.24/s3wp.25: outputTruncated/outputAccess/outputArchive no longer present
    expect((result as any).outputTruncated).toBeUndefined();
    expect((result as any).outputAccess).toBeUndefined();
    expect((result as any).outputArchive).toBeUndefined();
    expect(result.stdout).toBeUndefined();
    expect(result.outputFile).toBeUndefined();
    expect(structuredResult.artifact).toBe('planContract');
    expect(structuredResult.rejectedCheckCount).toBe(1);
    expect(structuredResult.rejectedChecks).toEqual([
      { name: 'write-set-gitignored', message: 'planned write set contains ignored files' }
    ]);
    expect(structuredResult.errorsByTool[0].group).toBe('semgrep');
    expect(structuredResult.errorsByTool[0].samples[0].code).toBe('rule.id');
  });

  it('describes configured MCP operations, argument contracts, defaults, and usage notes', () => {
    const description = describeConfiguredProjectTools({
      tools: [
        {
          name: 'reference_docs',
          type: ProjectToolType.MCP,
          description: 'Query reference documentation.',
          server: 'fixture-vector-server',
          operations: {
            query: 'fixture_query_documents',
            get: 'fixture_get_documents'
          },
          argumentAllowlist: {
            query: ['collection_name', 'query_texts'],
            get: ['collection_name', 'ids']
          },
          argumentDefaults: {
            query: { collection_name: 'reference_docs' }
          },
          pathArguments: {
            query: { path: { root: CwdMode.WORKTREE } }
          },
          usageNotes: ['Returned ids are vector-store document ids, not filesystem paths.']
        }
      ]
    } as any);

    expect(description).toContain('query -> fixture_query_documents');
    expect(description).toContain('get -> fixture_get_documents');
    expect(description).toContain('query(collection_name, query_texts)');
    expect(description).toContain('get(collection_name, ids)');
    expect(description).toContain('query defaults {"collection_name":"reference_docs"}');
    expect(description).toContain('query(path)');
    expect(description).toContain('Returned ids are vector-store document ids, not filesystem paths.');
    expect(description).toContain('raw-output file references (stdoutFile/stderrFile), treat them as archive guidance');
    expect(description).toContain('first decide from compactSummary, structuredResult, and toolCalls');
    expect(description).toContain('Prefer one narrow project-tool call at a time');
    expect(description).toContain('rerun narrower only for a named missing fact or decision blocker');
    expect(description).toContain('Pi UI native MCP server count reports only Pi-adapter connections');
  });

  it('normalizes configured MCP path arguments into the active worktree', () => {
    const result = normalizeMcpPathArguments({
      name: 'fixture_mcp_tool',
      type: ProjectToolType.MCP,
      server: 'fixture_mcp_tool',
      operations: { structure: 'get_structure' },
      pathArguments: {
        structure: {
          path: {
            root: CwdMode.WORKTREE,
            virtualRoots: ['/workspace/worktrees/{{beadId}}', '/workspace']
          }
        }
      }
    }, 'structure', 'get_structure', {
      path: '/workspace/worktrees/bd-1/packages/example',
      depth: 2
    }, {
      projectRoot: tempRoot,
      worktreePath: tempWorktree,
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze',
      toolName: 'fixture_mcp_tool'
    });

    expect(result.arguments).toEqual({
      path: path.join(tempWorktree, 'packages/example'),
      depth: 2
    });
    expect(result.normalizedPathArguments).toEqual(['path']);
  });

  it('normalizes diagnostic-tool filePath arguments into the active worktree', () => {
    const result = normalizeMcpPathArguments({
      name: 'fixture_diagnostic_tool',
      type: ProjectToolType.MCP,
      server: 'fixture-diagnostic-server',
      operations: {
        diagnostics: 'diagnostics',
        hover: 'hover'
      },
      argumentAllowlist: {
        diagnostics: ['filePath', 'showLineNumbers', 'contextLines'],
        hover: ['filePath', 'line', 'column']
      },
      argumentDefaults: {
        diagnostics: {
          showLineNumbers: true,
          contextLines: false
        }
      },
      pathArguments: {
        diagnostics: {
          filePath: {
            root: CwdMode.WORKTREE,
            virtualRoots: ['/workspace/worktrees/{{beadId}}', '/workspace']
          }
        },
        hover: {
          filePath: {
            root: CwdMode.WORKTREE,
            virtualRoots: ['/workspace/worktrees/{{beadId}}', '/workspace']
          }
        }
      }
    }, 'diagnostics', 'diagnostics', {
      filePath: '/workspace/worktrees/bd-1/packages/example.py',
      showLineNumbers: true,
      contextLines: false
    }, {
      projectRoot: tempRoot,
      worktreePath: tempWorktree,
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze',
      toolName: 'fixture_diagnostic_tool'
    });

    expect(result.arguments).toEqual({
      filePath: path.join(tempWorktree, 'packages/example.py'),
      showLineNumbers: true,
      contextLines: false
    });
    expect(result.normalizedPathArguments).toEqual(['filePath']);
  });

  it('normalizes configured MCP path arguments into a framework root', () => {
    const frameworkRoot = path.join(tempRoot, 'framework');
    fs.mkdirSync(path.join(frameworkRoot, 'tests'), { recursive: true });

    const result = normalizeMcpPathArguments({
      name: 'framework_structure_tool',
      type: ProjectToolType.MCP,
      server: 'fixture_mcp_tool',
      operations: { context: 'get_file_context' },
      pathArguments: {
        context: {
          path: {
            rootKind: 'framework',
            virtualRoots: ['/workspace/framework']
          }
        }
      }
    }, 'context', 'get_file_context', {
      path: '/workspace/framework/tests/teammates.test.ts'
    }, {
      projectRoot: tempRoot,
      worktreePath: tempWorktree,
      frameworkRoot,
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze',
      toolName: 'framework_structure_tool'
    });

    expect(result.arguments).toEqual({
      path: path.join(frameworkRoot, 'tests/teammates.test.ts')
    });
    expect(result.normalizedPathArguments).toEqual(['path']);
  });

  it('rejects configured MCP path arguments outside the active worktree', () => {
    expect(() => normalizeMcpPathArguments({
      name: 'fixture_mcp_tool',
      type: ProjectToolType.MCP,
      server: 'fixture_mcp_tool',
      pathArguments: {
        get_structure: {
          path: {
            root: CwdMode.WORKTREE
          }
        }
      }
    }, 'get_structure', 'get_structure', {
      path: path.join(tempRoot, 'outside.py')
    }, {
      projectRoot: tempRoot,
      worktreePath: tempWorktree,
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze',
      toolName: 'fixture_mcp_tool'
    })).toThrow(/escapes configured worktree root/);
  });

  it('rejects diagnostic-tool filePath arguments outside the active worktree', () => {
    const pythonLspTool: ProjectMcpToolConfig = {
      name: 'fixture_diagnostic_tool',
      type: ProjectToolType.MCP,
      server: 'fixture-diagnostic-server',
      pathArguments: {
        diagnostics: {
          filePath: {
            root: CwdMode.WORKTREE
          }
        },
        hover: {
          filePath: {
            root: CwdMode.WORKTREE
          }
        }
      }
    };
    const templateContext = {
      projectRoot: tempRoot,
      worktreePath: tempWorktree,
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze',
      toolName: 'fixture_diagnostic_tool'
    };
    const siblingWorktree = path.join(tempRoot, 'worktrees', 'bd-2');
    fs.mkdirSync(siblingWorktree, { recursive: true });

    expect(() => normalizeMcpPathArguments(
      pythonLspTool,
      'diagnostics',
      'diagnostics',
      { filePath: path.join(tempRoot, 'packages/example.py') },
      templateContext
    )).toThrow(/escapes configured worktree root/);
    expect(() => normalizeMcpPathArguments(
      pythonLspTool,
      'hover',
      'hover',
      { filePath: path.join(siblingWorktree, 'packages/example.py') },
      templateContext
    )).toThrow(/escapes configured worktree root/);
  });

  it('isolates generated files under project .tmp by bead, state, action, tool, and invocation', async () => {
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, envProbeTool(CwdMode.WORKTREE), {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.outputFile).toBeUndefined();
    // s3wp.25: stdoutFile/stderrFile are now visible raw refs in the model-facing result
    expect(typeof result.stdoutFile).toBe('string');
    expect(typeof result.stderrFile).toBe('string');
    expect((result as any).outputAccess).toBeUndefined();
    expect((result as any).outputArchive).toBeUndefined();
    const events = await eventStore.readAll();
    const started = events.find(event => event.type === DomainEventName.PROJECT_TOOL_STARTED);
    const prepared = events.find(event => event.type === DomainEventName.PROJECT_TOOL_OUTPUT_DIR_PREPARED);
    expect(JSON.stringify(started?.data)).not.toContain('outputFile');
    expect(prepared).toBeUndefined();
    // Event start data still includes outputArchive.artifactRef (event-side, not model-facing)
    expect((started?.data as any).outputArchive.artifactRef).toMatch(/^project-tool-output:/);
    // s3wp.25: stdout is in stdoutFile, not inline on the model-facing result
    const stdoutContent = fs.readFileSync(result.stdoutFile!, 'utf8');
    const payload = JSON.parse(stdoutContent);
    const expectedCallDir = path.join(tempRoot, '.pi/tool-output/bd-1/Planning/analyze/env_probe', payload[EnvProbeField.TOOL_INVOCATION_ID]);
    const expectedOutputDir = path.join(expectedCallDir, 'output');

    expect(payload[EnvProbeField.CWD]).toBe(tempWorktree);
    expect(payload[EnvProbeField.PROJECT_ROOT]).toBe(tempRoot);
    expect(payload[EnvProbeField.WORKTREE_PATH]).toBe(tempWorktree);
    expect(payload[EnvProbeField.TOOL_INVOCATION_ID]).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload[EnvProbeField.CALL_DIR]).toBe(expectedCallDir);
    expect(payload[EnvProbeField.OUTPUT_DIR]).toBe(expectedOutputDir);
    expect(payload[EnvProbeField.OUTPUT_FILE]).toBe(path.join(expectedOutputDir, `env_probe-${payload[EnvProbeField.TOOL_INVOCATION_ID]}.json`));
    expect(payload[EnvProbeField.TMP_DIR]).toBe(path.join(expectedCallDir, 'tmp'));
    expect(payload[EnvProbeField.TMPDIR]).toBe(path.join(expectedCallDir, 'tmp'));
    expect(payload[EnvProbeField.TOOL_WORKING_DIR]).toBe(tempWorktree);
    expect(fs.existsSync(path.join(expectedOutputDir, 'probe.json'))).toBe(true);
    expect(fs.existsSync(payload[EnvProbeField.OUTPUT_FILE])).toBe(true);
    expect(fs.existsSync(path.join(tempWorktree, '.tmp'))).toBe(false);
  });

  it('allows configured project tools to run in the main checkout without sharing worktree temp allocations', async () => {
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, envProbeTool(CwdMode.WORKTREE), {
      beadId: 'bd-2',
      stateId: 'AdversarialPostReview',
      actionId: 'quality',
      cwd: CwdMode.PROJECT
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    // s3wp.25: stdout is in stdoutFile
    const stdoutContent2 = fs.readFileSync(result.stdoutFile!, 'utf8');
    const payload = JSON.parse(stdoutContent2);
    const expectedCallDir = path.join(tempRoot, '.pi/tool-output/bd-2/AdversarialPostReview/quality/env_probe', payload[EnvProbeField.TOOL_INVOCATION_ID]);
    const expectedOutputDir = path.join(expectedCallDir, 'output');

    expect(payload[EnvProbeField.CWD]).toBe(tempRoot);
    expect(payload[EnvProbeField.TOOL_INVOCATION_ID]).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload[EnvProbeField.CALL_DIR]).toBe(expectedCallDir);
    expect(payload[EnvProbeField.OUTPUT_DIR]).toBe(expectedOutputDir);
    expect(payload[EnvProbeField.OUTPUT_FILE]).toBe(path.join(expectedOutputDir, `env_probe-${payload[EnvProbeField.TOOL_INVOCATION_ID]}.json`));
    expect(payload[EnvProbeField.TMP_DIR]).toBe(path.join(expectedCallDir, 'tmp'));
    expect(payload[EnvProbeField.TOOL_WORKING_DIR]).toBe(tempRoot);
    expect(fs.existsSync(path.join(expectedOutputDir, 'probe.json'))).toBe(true);
    expect(fs.existsSync(payload[EnvProbeField.OUTPUT_FILE])).toBe(true);
    expect(fs.existsSync(path.join(tempWorktree, '.tmp'))).toBe(false);
  });

  it('allocates a unique project .tmp output file for each tool call', async () => {
    const first = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, envProbeTool(CwdMode.WORKTREE), {
      beadId: 'bd-3',
      stateId: 'Planning',
      actionId: 'repeat'
    }, {} as any, undefined, new Map());
    const second = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, envProbeTool(CwdMode.WORKTREE), {
      beadId: 'bd-3',
      stateId: 'Planning',
      actionId: 'repeat'
    }, {} as any, undefined, new Map());

    // s3wp.25: stdout is in stdoutFile
    const firstPayload = JSON.parse(fs.readFileSync(first.stdoutFile!, 'utf8'));
    const secondPayload = JSON.parse(fs.readFileSync(second.stdoutFile!, 'utf8'));

    expect(firstPayload[EnvProbeField.TOOL_INVOCATION_ID]).not.toBe(secondPayload[EnvProbeField.TOOL_INVOCATION_ID]);
    expect(firstPayload[EnvProbeField.CALL_DIR]).not.toBe(secondPayload[EnvProbeField.CALL_DIR]);
    expect(firstPayload[EnvProbeField.OUTPUT_FILE]).not.toBe(secondPayload[EnvProbeField.OUTPUT_FILE]);
    expect(firstPayload[EnvProbeField.OUTPUT_FILE]).toContain(path.join(tempRoot, '.pi/tool-output/bd-3/Planning/repeat/env_probe'));
    expect(secondPayload[EnvProbeField.OUTPUT_FILE]).toContain(path.join(tempRoot, '.pi/tool-output/bd-3/Planning/repeat/env_probe'));
  });
});

// WI-28: resolveContextField precedence tests
describe('resolveContextField', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv['PI_BEAD_ID'] = process.env['PI_BEAD_ID'];
    savedEnv['PI_STATE_ID'] = process.env['PI_STATE_ID'];
    savedEnv['PI_ACTION_ID'] = process.env['PI_ACTION_ID'];
    delete process.env['PI_BEAD_ID'];
    delete process.env['PI_STATE_ID'];
    delete process.env['PI_ACTION_ID'];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('resolves bead ID from top-level canonical key', () => {
    expect(resolveContextField({ beadId: 'bd-top' }, ['beadId', 'id'], 'PI_BEAD_ID')).toBe('bd-top');
  });

  it('resolves bead ID from top-level alias key', () => {
    expect(resolveContextField({ id: 'bd-alias' }, ['beadId', 'id'], 'PI_BEAD_ID')).toBe('bd-alias');
  });

  it('resolves bead ID from nested arguments.* canonical key', () => {
    expect(resolveContextField({ arguments: { beadId: 'bd-nested' } }, ['beadId', 'id'], 'PI_BEAD_ID')).toBe('bd-nested');
  });

  it('resolves bead ID from nested arguments.* alias key', () => {
    expect(resolveContextField({ arguments: { id: 'bd-nested-alias' } }, ['beadId', 'id'], 'PI_BEAD_ID')).toBe('bd-nested-alias');
  });

  it('resolves bead ID from env when no args present', () => {
    process.env['PI_BEAD_ID'] = 'bd-env';
    expect(resolveContextField({}, ['beadId', 'id'], 'PI_BEAD_ID')).toBe('bd-env');
  });

  it('top-level key takes precedence over nested arguments.*', () => {
    expect(resolveContextField({ beadId: 'top', arguments: { beadId: 'nested' } }, ['beadId', 'id'], 'PI_BEAD_ID')).toBe('top');
  });

  it('nested arguments.* takes precedence over env', () => {
    process.env['PI_BEAD_ID'] = 'bd-env';
    expect(resolveContextField({ arguments: { beadId: 'nested' } }, ['beadId', 'id'], 'PI_BEAD_ID')).toBe('nested');
  });

  it('resolves state ID with its key pair', () => {
    expect(resolveContextField({ stateId: 'Planning' }, ['stateId', 'state'], 'PI_STATE_ID')).toBe('Planning');
    expect(resolveContextField({ state: 'Review' }, ['stateId', 'state'], 'PI_STATE_ID')).toBe('Review');
    expect(resolveContextField({ arguments: { stateId: 'CodeGen' } }, ['stateId', 'state'], 'PI_STATE_ID')).toBe('CodeGen');
  });

  it('resolves action ID with its key pair', () => {
    expect(resolveContextField({ actionId: 'quality' }, ['actionId', 'action'], 'PI_ACTION_ID')).toBe('quality');
    expect(resolveContextField({ action: 'plan' }, ['actionId', 'action'], 'PI_ACTION_ID')).toBe('plan');
    expect(resolveContextField({ arguments: { actionId: 'review' } }, ['actionId', 'action'], 'PI_ACTION_ID')).toBe('review');
  });

  it('returns undefined when args and env are all absent', () => {
    expect(resolveContextField({}, ['beadId', 'id'], 'PI_BEAD_ID')).toBeUndefined();
  });

  it('returns undefined when envVar is not provided and args are absent', () => {
    expect(resolveContextField({}, ['beadId', 'id'])).toBeUndefined();
  });
});

// WI-28: buildCommandResult shape tests via executeConfiguredProjectTool
describe('buildCommandResult field completeness', () => {
  let tempRoot: string;
  let tempWorktree: string;
  let previousProjectRootEnv: string | undefined;
  let previousWorktreeEnv: string | undefined;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let toolCallPathFactory: ToolCallPathFactory;

  beforeEach(() => {
    previousProjectRootEnv = process.env[EnvVars.PROJECT_ROOT];
    previousWorktreeEnv = process.env[EnvVars.WORKTREE_PATH];
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-cmd-result-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-shape');
    fs.mkdirSync(tempWorktree, { recursive: true });
    writeMinimalHarnessConfig(tempRoot);
    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-shape-${process.pid}`);
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempWorktree;
  });

  afterEach(() => {
    configLoader.reset();
    vi.restoreAllMocks();
    if (previousProjectRootEnv === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = previousProjectRootEnv;
    if (previousWorktreeEnv === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = previousWorktreeEnv;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const minimalCommandTool = (script: string): ProjectCommandToolConfig => ({
    name: 'shape_probe',
    type: ProjectToolType.COMMAND,
    command: process.execPath,
    defaultArgs: ['-e', script],
    cwd: CwdMode.WORKTREE,
  });

  it('success branch carries all expected fields', async () => {
    // Process exits 0 — goes through the try success path of executeCommandTool.
    // The final result is model-facing: stdoutFile/stderrFile are hidden, signal is
    // filtered (undefined on normal exit), timedOut is present as false.
    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory,
      minimalCommandTool('process.stdout.write(JSON.stringify({ok:true}))'),
      { beadId: 'bd-shape', stateId: 'Planning', actionId: 'test' },
      {} as any, undefined, new Map()
    ) as any;

    // s3wp.25 minimal schema assertions
    expect(result.tool).toBe('shape_probe');
    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    // maxBufferExceeded/stdoutTruncated/stderrTruncated are NOT in model-facing result (s3wp.25)
    expect(result.maxBufferExceeded).toBeUndefined();
    expect(result.stdoutTruncated).toBeUndefined();
    expect(result.stderrTruncated).toBeUndefined();
    // stdout/stderr raw text NOT in model-facing result (s3wp.25) — use stdoutFile/stderrFile
    expect(result.stdout).toBeUndefined();
    expect(result.stderr).toBeUndefined();
    expect(typeof result.stdoutBytes).toBe('number');
    expect(typeof result.stderrBytes).toBe('number');
    // stdoutFile/stderrFile ARE in model-facing result (s3wp.25 — raw-output refs)
    expect(typeof result.stdoutFile).toBe('string');
    expect(typeof result.stderrFile).toBe('string');
  });

  it('error branch (non-zero exit) carries all expected fields', async () => {
    // Process exits 1 — goes through the try success path with REJECTED status.
    // stdoutTruncated remains false (no maxBufferExceeded on normal non-zero exit).
    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory,
      {
        name: 'shape_probe_fail',
        type: ProjectToolType.COMMAND,
        command: process.execPath,
        defaultArgs: ['-e', 'process.exit(1)'],
        cwd: CwdMode.WORKTREE,
      },
      { beadId: 'bd-shape', stateId: 'Planning', actionId: 'test' },
      {} as any, undefined, new Map()
    ) as any;

    // s3wp.25 minimal schema assertions
    expect(result.tool).toBe('shape_probe_fail');
    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.exitCode).toBe(1);
    // maxBufferExceeded/stdoutTruncated/stderrTruncated NOT in model-facing result (s3wp.25)
    expect(result.maxBufferExceeded).toBeUndefined();
    expect(result.stdoutTruncated).toBeUndefined();
    expect(result.stderrTruncated).toBeUndefined();
    // stdout/stderr raw text NOT in model-facing result (s3wp.25)
    expect(result.stdout).toBeUndefined();
    expect(result.stderr).toBeUndefined();
    expect(typeof result.stdoutBytes).toBe('number');
    expect(typeof result.stderrBytes).toBe('number');
    // stdoutFile/stderrFile ARE in model-facing result (raw-output refs)
    expect(typeof result.stdoutFile).toBe('string');
    expect(typeof result.stderrFile).toBe('string');
  });
});

describe('tool-call scratch cleanup (bounded-storage)', () => {
  let tempRoot: string;
  let tempWorktree: string;
  let previousProjectRootEnv: string | undefined;
  let previousWorktreeEnv: string | undefined;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let toolCallPathFactory: ToolCallPathFactory;

  beforeEach(() => {
    previousProjectRootEnv = process.env[EnvVars.PROJECT_ROOT];
    previousWorktreeEnv = process.env[EnvVars.WORKTREE_PATH];
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-scratch-cleanup-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-scratch');
    fs.mkdirSync(tempWorktree, { recursive: true });
    writeMinimalHarnessConfig(tempRoot);
    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-scratch-${process.pid}`);
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempWorktree;
  });

  afterEach(() => {
    configLoader.reset();
    vi.restoreAllMocks();
    eventStore.setSessionId(`test-scratch-${process.pid}-reset`);
    if (previousProjectRootEnv === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = previousProjectRootEnv;
    if (previousWorktreeEnv === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = previousWorktreeEnv;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  /**
   * Tool that writes a large file into TMPDIR (simulating a uv-cache),
   * writes the real output to the output file (as any well-behaved tool does),
   * and prints a simple JSON result.
   */
  function cachingTool(): import('../src/core/domain/StateModels.js').ProjectCommandToolConfig {
    const script = `
const fs = require('fs');
const path = require('path');
const tmpDir = process.env.TMPDIR;
const outputDir = process.env.${EnvVars.TOOL_OUTPUT_DIR};
// Simulate a uv-cache written by a child tool (reference_docs, pip, etc.)
fs.mkdirSync(path.join(tmpDir, 'uv-cache', 'packages'), { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'uv-cache', 'packages', 'bigfile.whl'), 'x'.repeat(1024));
// Real structured output
const result = { status: 'PASSED', tool: 'cache_sim', message: 'ok', cached: true };
fs.writeFileSync(process.env.${EnvVars.TOOL_OUTPUT_FILE}, JSON.stringify(result));
process.stdout.write(JSON.stringify(result));
`;
    return {
      name: 'cache_sim',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', script],
      cwd: CwdMode.WORKTREE,
    };
  }

  it('removes the tmpDir scratch tree after the output JSON is written', async () => {
    const result = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, cachingTool(),
      { beadId: 'bd-scratch', stateId: 'Impl', actionId: 'build' },
      {} as any, undefined, new Map()
    ) as any;

    expect(result.status).toBe(ToolResultStatus.PASSED);

    // Give the async cleanup a moment to complete (it fires with `void`, i.e.
    // fire-and-forget, so we wait briefly before asserting).
    await new Promise(resolve => setTimeout(resolve, 200));

    // The tmpDir (scratch) should have been removed.
    const toolCallRoot = path.join(tempRoot, '.pi', 'tool-output');
    const callDirs = fs.readdirSync(path.join(toolCallRoot, 'bd-scratch', 'Impl', 'build', 'cache_sim'));
    // There should be at most one callDir (the one we just ran).
    expect(callDirs.length).toBeGreaterThanOrEqual(1);
    for (const callDirName of callDirs) {
      const callDir = path.join(toolCallRoot, 'bd-scratch', 'Impl', 'build', 'cache_sim', callDirName);
      // The output/ sub-directory must exist with the JSON artifact inside it.
      const outputDir = path.join(callDir, 'output');
      expect(fs.existsSync(outputDir)).toBe(true);
      const outputFiles = fs.readdirSync(outputDir);
      expect(outputFiles.some(f => f.endsWith('.json'))).toBe(true);

      // The tmp/ sub-directory (scratch) should be gone.
      const tmpDir = path.join(callDir, 'tmp');
      expect(fs.existsSync(tmpDir)).toBe(false);
    }
  });

  it('does not accumulate scratch dirs across repeated tool calls', async () => {
    const tool = cachingTool();
    const args = { beadId: 'bd-scratch', stateId: 'Impl', actionId: 'build' };

    for (let i = 0; i < 3; i++) {
      const result = await executeConfiguredProjectTool(
        eventStore, toolCallPathFactory, tool, args, {} as any, undefined, new Map()
      ) as any;
      expect(result.status).toBe(ToolResultStatus.PASSED);
    }

    // Let cleanup fire for all three calls.
    await new Promise(resolve => setTimeout(resolve, 400));

    const scratchToolDir = path.join(
      tempRoot, '.pi', 'tool-output', 'bd-scratch', 'Impl', 'build', 'cache_sim'
    );
    const callDirs = fs.readdirSync(scratchToolDir);
    // All three invocations ran, each gets its own callDir keyed by toolInvocationId.
    expect(callDirs.length).toBe(3);

    // None of the callDirs should still have a tmp/ sub-directory.
    for (const callDirName of callDirs) {
      const tmpDir = path.join(scratchToolDir, callDirName, 'tmp');
      expect(fs.existsSync(tmpDir)).toBe(false);
    }

    // All output JSON artifacts must still exist.
    for (const callDirName of callDirs) {
      const outputDir = path.join(scratchToolDir, callDirName, 'output');
      expect(fs.existsSync(outputDir)).toBe(true);
      const files = fs.readdirSync(outputDir);
      expect(files.some(f => f.endsWith('.json'))).toBe(true);
    }
  });

  it('parallel invocations only clean their own scratch dir and preserve other output dirs', async () => {
    const tool = cachingTool();

    // Fire two invocations concurrently (different beadIds to bypass backpressure).
    const [r1, r2] = await Promise.all([
      executeConfiguredProjectTool(
        eventStore, toolCallPathFactory, tool,
        { beadId: 'bd-scratch', stateId: 'Impl', actionId: 'parallel-a' },
        {} as any, undefined, new Map()
      ) as Promise<any>,
      executeConfiguredProjectTool(
        eventStore, toolCallPathFactory, tool,
        { beadId: 'bd-scratch', stateId: 'Impl', actionId: 'parallel-b' },
        {} as any, undefined, new Map()
      ) as Promise<any>
    ]);

    expect(r1.status).toBe(ToolResultStatus.PASSED);
    expect(r2.status).toBe(ToolResultStatus.PASSED);

    await new Promise(resolve => setTimeout(resolve, 400));

    // Both invocations should have their output/ JSON intact.
    for (const action of ['parallel-a', 'parallel-b']) {
      const scratchToolDir = path.join(
        tempRoot, '.pi', 'tool-output', 'bd-scratch', 'Impl', action, 'cache_sim'
      );
      const callDirs = fs.readdirSync(scratchToolDir);
      expect(callDirs.length).toBe(1);

      const outputDir = path.join(scratchToolDir, callDirs[0], 'output');
      expect(fs.existsSync(outputDir)).toBe(true);
      const files = fs.readdirSync(outputDir);
      expect(files.some(f => f.endsWith('.json'))).toBe(true);

      // Scratch tmp/ should be cleaned for both.
      const tmpDir = path.join(scratchToolDir, callDirs[0], 'tmp');
      expect(fs.existsSync(tmpDir)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Bead 5fij: structured-invocation registry integration (S1)
//
// Verifies the full commandExecutor → resolveStructuredInvocation path using
// real shell-script stubs so spawnArgs order is observable end-to-end.
// ---------------------------------------------------------------------------
describe('structured-invocation registry integration (5fij)', () => {
  let tempRoot: string;
  let tempWorktree: string;
  let previousProjectRootEnv: string | undefined;
  let previousWorktreeEnv: string | undefined;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let toolCallPathFactory: ToolCallPathFactory;

  beforeEach(() => {
    previousProjectRootEnv = process.env[EnvVars.PROJECT_ROOT];
    previousWorktreeEnv = process.env[EnvVars.WORKTREE_PATH];
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-5fij-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-1');
    fs.mkdirSync(tempWorktree, { recursive: true });
    writeMinimalHarnessConfig(tempRoot);
    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-5fij-${process.pid}`);
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempWorktree;
  });

  afterEach(() => {
    configLoader.reset();
    vi.restoreAllMocks();
    if (previousProjectRootEnv === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = previousProjectRootEnv;
    if (previousWorktreeEnv === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = previousWorktreeEnv;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  // (a) Unknown tool: spawnArgs are BYTE-IDENTICAL to finalArgs — no injection.
  it('leaves spawnArgs byte-identical to finalArgs for an unknown tool (no injection)', async () => {
    // Write a Node script that emits the args it received as JSON, then invoke it
    // via a command name that is not in the registry ('unknown_linter').
    // The resolver must leave the args unchanged.
    const argEchoScript = [
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1) }));'
    ].join('');
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'unknown_linter',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      // defaultArgs become finalArgs — the registry must not touch them.
      defaultArgs: ['-e', argEchoScript],
      cwd: CwdMode.WORKTREE,
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'lint'
    }, {} as any, undefined, new Map()) as any;

    expect(result.status).toBe(ToolResultStatus.PASSED);
    // s3wp.25: stdout is in stdoutFile, not inline on model-facing result
    const argv = JSON.parse(fs.readFileSync(result.stdoutFile!, 'utf8')).argv as string[];
    // argv[0] = '-e', argv[1] = script — no output-format flags injected
    expect(argv).not.toContain('--format');
    expect(argv).not.toContain('--output-format');
    expect(argv).not.toContain('--json');
    expect(argv).not.toContain('--out-format');
    expect(argv).not.toContain('--pretty');
  });

  // (b) pi-experiment-0yt5.2: the harness ships NO built-in parsers, so formerly
  // built-in tools (ruff, golangci-lint, semgrep, mypy, ...) get no registered
  // handler — resolveStructuredInvocation returns null and args are untouched.
  it('returns null (no injection) for formerly-built-in tools — harness is parser-free', () => {
    expect(resolveStructuredInvocation('ruff', ['check', '.'])).toBeNull();
    expect(resolveStructuredInvocation('golangci-lint', ['run'])).toBeNull();
    expect(resolveStructuredInvocation('semgrep', ['--config=auto', '.'])).toBeNull();
    expect(resolveStructuredInvocation('mypy', ['src/'])).toBeNull();
  });

  // (c) pi-experiment-0yt5.2: with no registered parser, the executor produces NO
  // parsed structuredResult and does not inject an output-format flag. Cerdiwen
  // per-tool files own their own parsing and return their own minimal result.
  it('does not inject flags nor synthesize a parsed structuredResult for a formerly-built-in tool', async () => {
    const binDir = path.join(tempRoot, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    // Stub named 'semgrep' that echoes its received argv as JSON and exits 0.
    const stubScript = path.join(binDir, 'semgrep');
    fs.writeFileSync(
      stubScript,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));\nprocess.exit(0);\n`,
      { mode: 0o755 }
    );

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'semgrep_stub',
      type: ProjectToolType.COMMAND,
      command: 'semgrep',
      defaultArgs: ['--config=auto', '.'],
      cwd: CwdMode.WORKTREE,
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}` }
    }, {
      beadId: 'bd-1',
      stateId: 'AdversarialPostReview',
      actionId: 'adversarial-code-review'
    }, {} as any, undefined, new Map()) as any;

    expect(result.status).toBe(ToolResultStatus.PASSED);
    // No --json injected (the harness registers no semgrep handler).
    const argv = JSON.parse(fs.readFileSync(result.stdoutFile!, 'utf8')).argv as string[];
    expect(argv).toEqual(['--config=auto', '.']);
  });
});

// s3wp.8: frameworkRootFromConfig env-driven fallback
describe('frameworkRootFromConfig — env-driven root resolution (s3wp.8)', () => {
  const ENV_VAR = EnvVars.FRAMEWORK_ROOT; // 'ORR_ELSE_FRAMEWORK_ROOT'

  function makeEnv(vars: Record<string, string | undefined>): import('../src/core/RuntimeEnvironment.js').RuntimeEnvironment {
    return { env: (key: string) => vars[key] };
  }

  function minimalConfig(orrElseFrameworkRoot?: string): import('../src/core/domain/StateModels.js').HarnessConfig {
    return {
      settings: {
        artifacts: orrElseFrameworkRoot !== undefined
          ? { templates: { orrElseFrameworkRoot } }
          : undefined
      } as any,
      tools: [],
      states: {},
    } as any;
  }

  it('returns the config literal when it is set to an absolute path', () => {
    const config = minimalConfig('/abs/framework');
    const env = makeEnv({});
    const result = frameworkRootFromConfig(config, env, '/project');
    expect(result).toBe('/abs/framework');
  });

  it('falls back to the ORR_ELSE_FRAMEWORK_ROOT env var when config literal is absent', () => {
    const config = minimalConfig(); // no orrElseFrameworkRoot in config
    const env = makeEnv({ [ENV_VAR]: '/env/framework' });
    const result = frameworkRootFromConfig(config, env, '/project');
    expect(result).toBe('/env/framework');
  });

  it('falls back to the ORR_ELSE_FRAMEWORK_ROOT env var when config literal is empty string', () => {
    const config = minimalConfig('');
    const env = makeEnv({ [ENV_VAR]: '/env/framework' });
    const result = frameworkRootFromConfig(config, env, '/project');
    expect(result).toBe('/env/framework');
  });

  it('returns undefined when both config literal and env var are absent', () => {
    const config = minimalConfig();
    const env = makeEnv({});
    const result = frameworkRootFromConfig(config, env, '/project');
    expect(result).toBeUndefined();
  });

  it('prefers the config literal over the env var when both are present', () => {
    const config = minimalConfig('/config/framework');
    const env = makeEnv({ [ENV_VAR]: '/env/framework' });
    const result = frameworkRootFromConfig(config, env, '/project');
    expect(result).toBe('/config/framework');
  });
});

// ---- demm: sequenced toolCalls from outputFile with provenance ----
// AC1: toolCalls can be extracted from outputFile when stdout omits them.
// AC2: extractSequencedToolCalls records count + source provenance.
// AC3: fail-closed condition tested via extractSequencedToolCalls returning 'none'.
// AC4: covers stdout-only, outputFile-only, malformed outputFile, and missing-for-generator.

describe('extractSequencedToolCalls — outputFile fallback with provenance (demm)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'demm-tc-')));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- toolCallsFromOutputFile unit tests ---

  it('toolCallsFromOutputFile returns undefined for absent file', async () => {
    const result = await toolCallsFromOutputFile(path.join(tmpDir, 'nonexistent.json'));
    expect(result).toBeUndefined();
  });

  it('toolCallsFromOutputFile returns undefined for a file with no toolCalls key', async () => {
    const filePath = path.join(tmpDir, 'no-calls.json');
    fs.writeFileSync(filePath, JSON.stringify({ status: 'PASSED', message: 'ok' }));
    const result = await toolCallsFromOutputFile(filePath);
    expect(result).toBeUndefined();
  });

  it('toolCallsFromOutputFile returns undefined for malformed JSON (AC4: malformed outputFile)', async () => {
    const filePath = path.join(tmpDir, 'malformed.json');
    fs.writeFileSync(filePath, '{ not valid json at all {{}}');
    const result = await toolCallsFromOutputFile(filePath);
    expect(result).toBeUndefined();
  });

  it('toolCallsFromOutputFile extracts toolCalls from direct key', async () => {
    const calls = [{ tool: 'add_checklist_item', arguments: { text: 'item 1' } }];
    const filePath = path.join(tmpDir, 'direct.json');
    fs.writeFileSync(filePath, JSON.stringify({ status: 'PASSED', toolCalls: calls }));
    const result = await toolCallsFromOutputFile(filePath);
    expect(result).toEqual(calls);
  });

  it('toolCallsFromOutputFile extracts toolCalls from frameworkToolCalls key', async () => {
    const calls = [{ tool: 'add_checklist_item', arguments: { text: 'fw item' } }];
    const filePath = path.join(tmpDir, 'fw.json');
    fs.writeFileSync(filePath, JSON.stringify({ status: 'PASSED', frameworkToolCalls: calls }));
    const result = await toolCallsFromOutputFile(filePath);
    expect(result).toEqual(calls);
  });

  // --- extractSequencedToolCalls provenance tests ---

  // AC4 / AC2: stdout-only toolCalls
  it('AC2/AC4: source=stdout when inline result has toolCalls and no outputFile given', async () => {
    const calls = [{ tool: 'add_checklist_item', arguments: { text: 'stdout item' } }];
    const inlineResult = { status: 'PASSED', toolCalls: calls };
    const { toolCalls, source } = await extractSequencedToolCalls(inlineResult, undefined);
    expect(source).toBe('stdout');
    expect(toolCalls).toEqual(calls);
  });

  it('AC2/AC4: source=stdout when inline result has toolCalls and outputFile has none', async () => {
    const calls = [{ tool: 'add_checklist_item', arguments: { text: 'stdout item' } }];
    const inlineResult = { status: 'PASSED', toolCalls: calls };
    const filePath = path.join(tmpDir, 'empty-calls.json');
    fs.writeFileSync(filePath, JSON.stringify({ status: 'PASSED' }));
    const { toolCalls, source } = await extractSequencedToolCalls(inlineResult, filePath);
    expect(source).toBe('stdout');
    expect(toolCalls).toEqual(calls);
  });

  // AC1 / AC2 / AC4: outputFile-only toolCalls
  it('AC1/AC2/AC4: source=outputFile when inline result omits toolCalls but outputFile has them', async () => {
    const calls = [{ tool: 'add_checklist_item', arguments: { text: 'from file' } }];
    const inlineResult = { status: 'PASSED' }; // no toolCalls in stdout
    const filePath = path.join(tmpDir, 'output.json');
    fs.writeFileSync(filePath, JSON.stringify({ status: 'PASSED', toolCalls: calls }));
    const { toolCalls, source } = await extractSequencedToolCalls(inlineResult, filePath);
    expect(source).toBe('outputFile');
    expect(toolCalls).toEqual(calls);
    expect(toolCalls).toHaveLength(1);
  });

  // AC2: both sources
  it('AC2: source=both when inline result and outputFile both have toolCalls; inline takes precedence', async () => {
    const inlineCalls = [{ tool: 'add_checklist_item', arguments: { text: 'inline' } }];
    const fileCalls = [{ tool: 'add_checklist_item', arguments: { text: 'from file' } }];
    const inlineResult = { status: 'PASSED', toolCalls: inlineCalls };
    const filePath = path.join(tmpDir, 'both.json');
    fs.writeFileSync(filePath, JSON.stringify({ status: 'PASSED', toolCalls: fileCalls }));
    const { toolCalls, source } = await extractSequencedToolCalls(inlineResult, filePath);
    expect(source).toBe('both');
    // inline takes precedence
    expect(toolCalls).toEqual(inlineCalls);
  });

  // AC3 / AC4: missing toolCalls for a generator tool (source='none')
  it('AC3/AC4: source=none when neither inline result nor outputFile has toolCalls', async () => {
    const inlineResult = { status: 'PASSED' };
    const filePath = path.join(tmpDir, 'no-calls-output.json');
    fs.writeFileSync(filePath, JSON.stringify({ status: 'PASSED', message: 'no calls here' }));
    const { toolCalls, source } = await extractSequencedToolCalls(inlineResult, filePath);
    expect(source).toBe('none');
    expect(toolCalls).toHaveLength(0);
  });

  it('AC3/AC4: source=none when outputFile is absent and inline result has no toolCalls', async () => {
    const inlineResult = { status: 'PASSED' };
    const { toolCalls, source } = await extractSequencedToolCalls(inlineResult, undefined);
    expect(source).toBe('none');
    expect(toolCalls).toHaveLength(0);
  });

  it('AC4: malformed outputFile yields source=none (no exception thrown)', async () => {
    const inlineResult = { status: 'PASSED' };
    const filePath = path.join(tmpDir, 'malformed-output.json');
    fs.writeFileSync(filePath, '{{{{not json}}}}');
    const { toolCalls, source } = await extractSequencedToolCalls(inlineResult, filePath);
    expect(source).toBe('none');
    expect(toolCalls).toHaveLength(0);
  });
});

// AC2: executeConfiguredProjectTool attaches _internalOutputFile for sequencing path
describe('executeConfiguredProjectTool — _internalOutputFile internal channel (demm)', () => {
  let tempRoot: string;
  let tempWorktree: string;
  let previousProjectRootEnv: string | undefined;
  let previousWorktreeEnv: string | undefined;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let toolCallPathFactory: ToolCallPathFactory;

  beforeEach(() => {
    previousProjectRootEnv = process.env[EnvVars.PROJECT_ROOT];
    previousWorktreeEnv = process.env[EnvVars.WORKTREE_PATH];
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'demm-iof-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-1');
    fs.mkdirSync(tempWorktree, { recursive: true });
    writeMinimalHarnessConfig(tempRoot);
    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-demm-iof-${process.pid}`);
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempWorktree;
  });

  afterEach(() => {
    configLoader.reset();
    vi.restoreAllMocks();
    if (previousProjectRootEnv === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = previousProjectRootEnv;
    if (previousWorktreeEnv === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = previousWorktreeEnv;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('AC2: result carries _internalOutputFile as a resolvable path to the persisted artifact', async () => {
    const script = `
      const data = { status: 'PASSED', toolCalls: [{ tool: 'add_checklist_item', arguments: { text: 'from tool' } }] };
      process.stdout.write(JSON.stringify(data));
    `;
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'demm_tc_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', script],
      cwd: CwdMode.WORKTREE
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'generate'
    }, {} as any, undefined, new Map()) as any;

    expect(result.status).toBe(ToolResultStatus.PASSED);
    // Internal channel: _internalOutputFile is present and points to the archive.
    expect(typeof result._internalOutputFile).toBe('string');
    expect(result._internalOutputFile.length).toBeGreaterThan(0);
    // The archive file exists and is readable.
    expect(fs.existsSync(result._internalOutputFile)).toBe(true);
    // _internalOutputFile is NOT exposed to the model (not model-facing).
    // Verified by checking it's in MODEL_HIDDEN_RESULT_KEYS indirectly: the outputFile
    // key itself is already hidden; _internalOutputFile is added alongside it.
  });

  it('AC1: toolCallsFromOutputFile can recover toolCalls from the internal archive when stdout is truncated', async () => {
    // Simulate: a tool writes toolCalls to outputFile (the archive written by
    // persistAndBoundResult). In practice the tool writes them to stdout, which the
    // harness persists to stdoutFile and then also to outputFile (the archive) via
    // persistAndBoundResult. We verify that toolCallsFromOutputFile can read them back.
    const calls = [{ tool: 'add_checklist_item', arguments: { text: 'from archive' } }];
    const script = `process.stdout.write(JSON.stringify({ status: 'PASSED', toolCalls: ${JSON.stringify(calls)} }));`;

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'demm_archive_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', script],
      cwd: CwdMode.WORKTREE
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'archive-test'
    }, {} as any, undefined, new Map()) as any;

    const outputFile = result._internalOutputFile as string;
    // toolCallsFromOutputFile can recover the calls from the archive.
    const recoveredCalls = await toolCallsFromOutputFile(outputFile);
    expect(recoveredCalls).toEqual(calls);
  });

  // demm Finding 1: model-facing no-leak test
  // The registered tool execute() (model boundary) must NEVER return _internalOutputFile.
  it('model-facing: registered tool execute() strips _internalOutputFile before returning to the model', async () => {
    const script = `process.stdout.write(JSON.stringify({ status: 'PASSED', message: 'ok' }));`;
    const definition: ProjectCommandToolConfig = {
      name: 'demm_leak_probe',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', script],
      cwd: CwdMode.WORKTREE
    };

    // First verify that executeConfiguredProjectTool itself attaches _internalOutputFile
    // (the internal channel for runParentSequenceActionsBeforeActive).
    const rawResult = await executeConfiguredProjectTool(
      eventStore, toolCallPathFactory, definition,
      { beadId: 'bd-1', stateId: 'Planning', actionId: 'probe' },
      {} as any, undefined, new Map(), tempRoot
    ) as any;
    expect(rawResult._internalOutputFile).toBeDefined(); // must fail before fix

    // Now verify that registerConfiguredProjectTools's execute() closure strips it.
    // Use an identity wrapper so we can call the execute() directly.
    const registeredTools: any[] = [];
    const config = await configLoader.load();
    registerConfiguredProjectTools(
      eventStore, toolCallPathFactory,
      { registerTool: (t: any) => registeredTools.push(t) } as any,
      { ...config, tools: [definition] },
      new Set(),
      (t: any) => t, // identity: bypass wrapPluginTool
      undefined, undefined, new Map(), tempRoot
    );

    expect(registeredTools).toHaveLength(1);
    const modelFacingResult = await registeredTools[0].execute({}, {} as any) as any;

    // The model-facing result must NOT contain _internalOutputFile.
    expect(modelFacingResult._internalOutputFile).toBeUndefined();
    expect(JSON.stringify(modelFacingResult)).not.toContain('_internalOutputFile');
    // The result still carries model-facing fields.
    expect(modelFacingResult.status).toBe(ToolResultStatus.PASSED);
  });
});
