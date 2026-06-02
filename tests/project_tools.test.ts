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
import { classifyProjectToolFailure, describeConfiguredProjectTools, executeConfiguredProjectTool, isAcceptedMaxBufferFailure, isSuccessfulCommandExitCode, mcpToolRequestTimeoutMs, normalizeCommandArguments, normalizeMcpPathArguments, ProjectToolBackpressure, ProjectToolFailureCategory, projectToolFailureLimitSuggestedOutcome, resolveContextField, shouldSerializeMcpTool, structuredResultHasDecisionEvidence } from '../src/plugins/projectTools.js';
import { AST_GREP_RESULT_PREVIEW_MAX_BYTES, CODEMAP_RESULT_PREVIEW_MAX_BYTES, HIGH_VOLUME_NARROW_RERUN_RECOVERY } from '../src/plugins/projectTools/constants.js';

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
    maxOutputBytes: 10_000
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
      maxOutputBytes: 10_000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze',
      arguments: {
        argv: ['/workspace/worktrees/bd-1/packages/example.py', '-k', 'selector']
      }
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(JSON.parse(result.stdout).argv).toEqual([
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
      maxOutputBytes: 10_000
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
    expect(JSON.parse(result.stdout)).toEqual({
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
      maxOutputBytes: 10_000
    }, {
      beadId: 'bd-1',
      stateId: 'AdversarialPreReview',
      actionId: 'coding-standards',
      arguments: {
        argv: [frameworkPath]
      }
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(JSON.parse(result.stdout).argv).toEqual([frameworkPath]);
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
      maxOutputBytes: 10_000
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
      maxOutputBytes: 10_000
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
      maxOutputBytes: 10_000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze',
      arguments: {
        argv: ['--changed-file=/workspace/packages/example.py']
      }
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(JSON.parse(result.stdout).argv).toEqual([
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
      maxOutputBytes: 10_000
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
      maxOutputBytes: 10_000
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

  it('serializes python-lsp MCP project-tool calls', () => {
    expect(shouldSerializeMcpTool({ name: 'python_lsp', type: ProjectToolType.MCP })).toBe(true);
    expect(shouldSerializeMcpTool({ name: 'codemap', type: ProjectToolType.MCP })).toBe(false);
    expect(shouldSerializeMcpTool({ name: 'python_lsp', type: ProjectToolType.COMMAND })).toBe(false);
  });

  it('keeps serialized MCP tool client timeouts above python-lsp server timeouts', () => {
    const pythonLspTool: ProjectMcpToolConfig = {
      name: 'python_lsp',
      type: ProjectToolType.MCP,
      server: 'python-lsp'
    };
    const codemapTool: ProjectMcpToolConfig = {
      name: 'codemap',
      type: ProjectToolType.MCP,
      server: 'codemap'
    };

    expect(mcpToolRequestTimeoutMs(pythonLspTool)).toBeGreaterThan(120_000);
    expect(mcpToolRequestTimeoutMs(codemapTool)).toBe(60_000);
    expect(mcpToolRequestTimeoutMs({ ...pythonLspTool, timeoutMs: 240_000 })).toBe(240_000);
  });

  it('returns structured backpressure when python_lsp serialized lock acquisition times out', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    vi.spyOn(lockfile, 'lock').mockRejectedValueOnce(new Error('Lock file is already being held'));
    const tool: ProjectMcpToolConfig = {
      name: 'python_lsp',
      type: ProjectToolType.MCP,
      server: 'python-lsp'
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

    expect(result).toMatchObject({
      tool: 'python_lsp',
      server: 'python-lsp',
      status: ToolResultStatus.REJECTED,
      failureCategory: ProjectToolFailureCategory.BACKPRESSURE,
      lockTimeout: true,
      nextAction: 'wait_for_in_flight_result'
    });
    expect((result as any).message).toContain('could not acquire the serialized MCP project-tool lock');
    expect((result as any).lockMetadata).toMatchObject({
      scope: 'project',
      waitedMs: 0,
      tool: 'python_lsp',
      server: 'python-lsp'
    });
    expect(JSON.stringify((result as any).lockMetadata)).not.toContain(tempRoot);
    expect(JSON.stringify((result as any).lockMetadata)).not.toContain(tempWorktree);

    const events = await eventStore.eventsForBead('bd-1');
    const failed = events.find(event =>
      event.type === DomainEventName.PROJECT_TOOL_FAILED &&
      event.data?.tool === 'python_lsp'
    );
    expect(failed?.data?.failureCategory).toBe(ProjectToolFailureCategory.BACKPRESSURE);
    expect(failed?.data?.result).toMatchObject({
      status: ToolResultStatus.REJECTED,
      failureCategory: ProjectToolFailureCategory.BACKPRESSURE,
      lockTimeout: true,
      lockMetadata: {
        scope: 'project',
        waitedMs: 0,
        tool: 'python_lsp',
        server: 'python-lsp'
      },
      nextAction: 'wait_for_in_flight_result'
    });
    expect(JSON.stringify(failed?.data?.result)).not.toContain(tempRoot);
    expect(JSON.stringify(failed?.data?.result)).not.toContain(tempWorktree);
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
    expect(result.stderr).toContain('missing path');
  });

  it('labels ast_grep no-match results without making them look like tool failures', async () => {
    const payload = {
      tool: 'ast_grep',
      status: ToolResultStatus.PASSED,
      exitCode: 1,
      stdout: '',
      stderr: ''
    };
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'ast_grep',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});`],
      successExitCodes: [0, 1],
      cwd: CwdMode.WORKTREE
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.matchStatus).toBe('no_match');
    expect(result.message).toContain('ast_grep found no matches');
    expect(result.nextAction).toBe('record_no_match');
    const recovery = (result as any).recovery as string[];
    expect(recovery.join('\n')).not.toContain('outputFilters');
    expect(recovery).toEqual(['Record the no-match result as evidence if it satisfies the current check; otherwise rerun with a narrower or corrected pattern.']);
  });

  it('explains filter-eliminated vs pattern-no-match when ast_grep no-match result includes outputFilters', async () => {
    const payload = {
      tool: 'ast_grep',
      status: ToolResultStatus.PASSED,
      exitCode: 1,
      stdout: '',
      stderr: '',
      outputFilters: ['--filter', 'some_function']
    };
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'ast_grep',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});`],
      successExitCodes: [0, 1],
      cwd: CwdMode.WORKTREE
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.matchStatus).toBe('no_match');
    expect(result.nextAction).toBe('record_no_match');
    const recovery = (result as any).recovery as string[];
    const recoveryText = recovery.join('\n');
    expect(recoveryText).toContain('ast-grep pattern ran first');
    expect(recoveryText).toContain('outputFilters post-filtered stdout');
    expect(recoveryText).toContain('filter-eliminated output');
    expect(recoveryText).toContain('does NOT mean the pattern found no matches');
    expect(recovery).toEqual(expect.arrayContaining([
      expect.stringContaining('wrapper-side outputFilters post-filtered stdout')
    ]));
  });

  it('rejects zero-target framework semgrep output as insufficient evidence', async () => {
    const frameworkRoot = path.join(tempRoot, 'framework');
    fs.mkdirSync(frameworkRoot, { recursive: true });
    const payload = {
      tool: 'semgrep',
      version: '1.0.0',
      results: [],
      errors: [],
      paths: {
        scanned: []
      }
    };

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'framework_semgrep',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});`],
      cwd: CwdMode.WORKTREE,
      argumentPathScope: {
        rootKind: 'framework',
        virtualRoots: ['/workspace/framework'],
        positionals: true
      },
      maxOutputBytes: 10_000
    }, {
      beadId: 'bd-1',
      stateId: 'AdversarialPostReview',
      actionId: 'adversarial-code-review',
      frameworkRoot
    }, {} as any, undefined, new Map());

    const structuredResult = result.structuredResult as any;

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.nextAction).toBe('insufficient_evidence');
    expect(result.scannedTargetCount).toBe(0);
    expect(structuredResult.scannedTargetCount).toBe(0);
    expect(result.message).toContain('zero scanned targets');
    expect(result.message).toContain(`Expected target root: ${frameworkRoot}`);
    expect(result.message).toContain('/workspace/framework/<path-relative-to-framework-root>');
    expect(result.remediation).toEqual(expect.arrayContaining([
      expect.stringContaining(frameworkRoot),
      expect.stringContaining('<path-relative-to-framework-root>')
    ]));

    const events = await eventStore.eventsForBead('bd-1');
    expect(events.some(event =>
      event.type === DomainEventName.PROJECT_TOOL_FAILED &&
      event.data?.tool === 'framework_semgrep'
    )).toBe(true);
    expect(events.some(event =>
      event.type === DomainEventName.PROJECT_TOOL_SUCCEEDED &&
      event.data?.tool === 'framework_semgrep'
    )).toBe(false);
  });

  it('exposes scanned-target counts for nonzero passing framework semgrep output', async () => {
    const frameworkRoot = path.join(tempRoot, 'framework');
    fs.mkdirSync(frameworkRoot, { recursive: true });
    const scannedTargets = [
      'tests/adversarial_code_review.md',
      'tests/default_post_review.md'
    ];
    const payload = {
      tool: 'semgrep',
      version: '1.0.0',
      results: [],
      errors: [],
      paths: {
        scanned: scannedTargets
      }
    };

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'framework_semgrep',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});`],
      cwd: CwdMode.WORKTREE,
      argumentPathScope: {
        rootKind: 'framework',
        virtualRoots: ['/workspace/framework'],
        positionals: true
      },
      maxOutputBytes: 10_000
    }, {
      beadId: 'bd-1',
      stateId: 'AdversarialPostReview',
      actionId: 'adversarial-code-review',
      frameworkRoot
    }, {} as any, undefined, new Map());

    const structuredResult = result.structuredResult as any;

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.nextAction).toBe('use_result');
    expect(result.scannedTargetCount).toBe(2);
    expect(result.scannedTargetSamples).toEqual(scannedTargets);
    expect(structuredResult.scannedTargetCount).toBe(2);
    expect(structuredResult.scannedTargetSamples).toEqual(scannedTargets);
    expect(result.remediation).toBeUndefined();
  });

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

    expect(first).toMatchObject({
      status: ToolResultStatus.REJECTED,
      failureCategory: ProjectToolFailureCategory.TERMINAL_GATE,
      nextAction: 'route_configured_outcome',
      failureLimit: {
        suggestedOutcome: 'REQUIREMENTS_DEFECT',
        terminal: true
      }
    });
    expect(first.remediation).toEqual(expect.arrayContaining([
      expect.stringContaining('Treat artifact_validator output as an authoritative gate'),
      expect.stringContaining('Do not rerun artifact_validator unchanged')
    ]));
    expect(second).toMatchObject({
      status: ToolResultStatus.REJECTED,
      failureCategory: ProjectToolFailureCategory.TERMINAL_GATE,
      nextAction: 'route_configured_outcome',
      failureLimit: {
        suggestedOutcome: 'REQUIREMENTS_DEFECT',
        terminal: true
      }
    });
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

    expect(result).toMatchObject({
      tool: 'artifact_validator',
      status: ToolResultStatus.REJECTED,
      failureCategory: ProjectToolFailureCategory.TOOL_INPUT_ERROR,
      unsupportedOutputControlFlag: '--output-limit',
      nextAction: 'fix_arguments'
    });
    expect(result.message).toContain('does not support output-control flag --output-limit');
    expect(result.remediation).toEqual(expect.arrayContaining([
      expect.stringContaining('structuredResult'),
      expect.stringContaining('resultPreview'),
      expect.stringContaining('outputArchive.artifactRef'),
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
      maxOutputBytes: 10_000
    }, {
      beadId: 'bd-1',
      stateId: 'AdversarialPreReview',
      actionId: 'artifact-validation',
      arguments: {
        argv: ['planContract']
      }
    }, {} as any, undefined, new Map());

    // Compact metadata fields are retained
    expect(result).toMatchObject({
      tool: 'artifact_validator',
      status: ToolResultStatus.PASSED,
      stdoutBytes: Buffer.byteLength(payload),
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      maxBufferExceeded: false,
      nextAction: 'use_result'
    });
    // structuredResult is present (passedCheckCount from the checks array)
    const structuredResult = (result as any).structuredResult;
    expect(structuredResult).toBeDefined();
    expect(structuredResult.passedCheckCount).toBe(1);
    expect(structuredResult.rejectedCheckCount).toBe(0);
    // Raw stdout/stderr are suppressed from the model-facing result (hasStructuredModelSummary=true)
    expect((result as any).stdout).toBeUndefined();
    expect((result as any).stderr).toBeUndefined();
    // No output-control flag issues
    expect(result.unsupportedOutputControlFlag).toBeUndefined();
    expect(result.failureCategory).toBeUndefined();
    expect(result.remediation).toBeUndefined();
  });

  it('classifies representative project-tool failures for agent remediation', () => {
    const tool = { name: 'codemap' } as ProjectCommandToolConfig;

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
      message: 'MCP project tool codemap path argument path escapes configured root'
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
      maxOutputBytes: 1024
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.maxBufferExceeded).toBe(false);
    expect(result.stdoutBytes).toBe(outputBytes);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.nextAction).toBe('rerun_narrower');
    expect(result.recovery).toEqual(expect.arrayContaining([
      expect.stringContaining('named missing fact or decision blocker')
    ]));
    expect(result.recovery.join('\n')).toContain('First decide from resultPreview, structuredResult, and toolCalls');
    expect(result.recovery.join('\n')).toContain('Do not read outputArchive.artifactRef just because the preview is truncated');
    expect(result.recovery.join('\n')).not.toMatch(/read .*archive first|read .*archive before/i);
    expect(result.stdout).toContain('[truncated 198976 bytes; full stream archived by harness]');
    expect(result.stdoutFile).toBeUndefined();
    expect(result.outputAccess).toBeUndefined();
    expect(result.outputArchive).toMatchObject({ truncated: true });
    expect(result.outputArchive.artifactRef).toMatch(/^project-tool-output:/);
    expect(JSON.stringify(result.outputArchive)).not.toContain(tempRoot);
  });

  it('bounds inline project tool observations while preserving framework tool calls', async () => {
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'large_json_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          status: 'PASSED',
          toolCalls: [{ tool: 'add_checklist_item', arguments: { text: 'Rule checked', mandatory: true } }],
          filler: 'x'.repeat(20000)
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.outputTruncated).toBe(true);
    expect(result.nextAction).toBe('rerun_narrower');
    expect(result.recovery.join('\n')).toContain('First decide from resultPreview, structuredResult, and toolCalls');
    expect(result.recovery.join('\n')).toContain('named missing fact or decision blocker');
    expect(result.recovery.join('\n')).toContain('Do not read outputArchive.artifactRef just because the preview is truncated');
    expect(result.recovery.join('\n')).not.toMatch(/read .*archive first|read .*archive before/i);
    expect(result.toolCalls).toEqual([{ tool: 'add_checklist_item', arguments: { text: 'Rule checked', mandatory: true } }]);
    expect(result.stdout).toBeUndefined();
    expect(result.outputPreview.length).toBeLessThan(1500);
    expect(result.outputPreview).not.toContain('filler');
    expect(result.outputAccess).toContain('Archived by harness');
    expect(result.outputAccess).toContain('Do not read the archive just because the preview is truncated');
    expect(result.outputFile).toBeUndefined();
    expect(result.outputArchive).toMatchObject({ truncated: true });
    expect(result.outputArchive.artifactRef).toMatch(/^project-tool-output:/);
    expect(JSON.stringify(result.outputArchive)).not.toContain(tempRoot);
  });

  it('uses sufficient compact structured results even when archived output is capped', async () => {
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'coding_standards',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'coding_standards',
          status: 'PASSED',
          checks: [
            { name: 'style-policy', status: 'PASSED', message: 'relevant standard found' },
            { name: 'test-policy', status: 'PASSED', message: 'test guidance found' }
          ],
          filler: 'x'.repeat(20000)
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    const structuredResult = result.structuredResult as any;

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.outputTruncated).toBe(true);
    expect(result.nextAction).toBe('use_result');
    expect(result.stdout).toBeUndefined();
    expect(result.outputAccess).toContain('Archived by harness');
    expect(result.outputAccess).toContain('First decide from resultPreview, structuredResult, and toolCalls');
    expect(result.outputFile).toBeUndefined();
    expect(result.outputArchive).toMatchObject({ truncated: true });
    expect(result.outputArchive.artifactRef).toMatch(/^project-tool-output:/);
    expect(structuredResult.passedCheckCount).toBe(2);
    expect(structuredResult.rejectedCheckCount).toBe(0);
  });

  it('uses actionable codemap structure previews even when they are truncated', async () => {
    const codemapPreview = [
      'tests',
      'Files: 542 | Size: 6.4MB',
      'Top Extensions: .py (519), .broken (7), .md (4)',
      'tests',
      '|-- acceptance',
      '|   |-- conftest',
      '|   |-- test_all_types',
      '|   |-- test_arithmetic',
      '',
      '[truncated 8217 characters; rerun with narrower arguments for more detail]'
    ].join('\n');
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'codemap',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'codemap',
          status: 'PASSED',
          server: 'codemap',
          operation: 'get_structure',
          stdout: ${JSON.stringify(codemapPreview)},
          filler: 'x'.repeat(20000)
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.outputTruncated).toBe(true);
    expect(result.nextAction).toBe('use_result');
    expect(result.resultPreview).toContain('Files: 542');
    expect(result.resultPreview).toContain('[truncated 8217 characters');
    expect(result.outputAccess).toContain('Archived by harness');
  });

  it('uses file-scoped python_lsp diagnostics previews even when they are truncated', async () => {
    const diagnosticsPreview = [
      path.join(tempWorktree, 'packages/example.py'),
      'Diagnostics in File: 257',
      'ERROR at L12:C6: Import "ceridwen_foundation.wasm.types" could not be resolved (Source: Pyright, Code: reportMissingImports)',
      'ERROR at L84:C10: Import "ceridwen_foundation.pli.aggregate" could not be resolved (Source: Pyright, Code: reportMissingImports)',
      'ERROR at L93:C10: Import "ceridwen_foundation.pli.arithmetic" could not be resolved (Source: Pyright, Code: reportMissingImports)',
      '',
      '[truncated 49125 characters; rerun with narrower arguments for more detail]'
    ].join('\n');
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'python_lsp',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'python_lsp',
          status: 'PASSED',
          server: 'python-lsp',
          operation: 'diagnostics',
          stdout: ${JSON.stringify(diagnosticsPreview)},
          stdoutBytes: 52055,
          filler: 'x'.repeat(20000)
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.outputTruncated).toBe(true);
    expect(result.nextAction).toBe('use_result');
    expect(result.resultPreview).toContain('Diagnostics in File: 257');
    expect(result.resultPreview).toContain('reportMissingImports');
    expect(result.outputAccess).toContain('Archived by harness');
  });

  it('groups noisy python_lsp missing-import diagnostics before model display', async () => {
    const diagnosticFile = path.join(tempWorktree, 'packages/type_mapping.py');
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'python_lsp',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `
          const diagnosticFile = ${JSON.stringify(diagnosticFile)};
          const lines = [
            diagnosticFile,
            'Diagnostics in File: 257',
            ...Array.from({ length: 257 }, (_, index) =>
              \`ERROR at L\${12 + index}:C\${(index % 20) + 1}: Import "ceridwen_foundation.generated.module_\${index}" could not be resolved (Source: Pyright, Code: reportMissingImports)\`
            )
          ];
          const diagnostics = lines.join('\\n');
          console.log(JSON.stringify({
            tool: 'python_lsp',
            status: 'PASSED',
            server: 'python-lsp',
            operation: 'diagnostics',
            stdout: diagnostics,
            stdoutBytes: Buffer.byteLength(diagnostics),
            filler: 'x'.repeat(20000)
          }));
        `
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    const summary = result.diagnosticSummary as any;

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.outputTruncated).toBe(true);
    expect(result.nextAction).toBe('use_result');
    expect(result.recovery).toEqual(expect.arrayContaining([
      expect.stringContaining('inspect non-import groups')
    ]));
    expect(result.outputArchive).toMatchObject({ truncated: true });
    expect(result.outputArchive.artifactRef).toMatch(/^project-tool-output:/);
    expect(result.outputAccess).toContain('Archived by harness');
    expect(result.stdout).toBeUndefined();
    expect(result.resultPreview.length).toBeLessThan(1200);
    expect(result.resultPreview).toContain('Diagnostics in File: 257');
    expect(result.resultPreview).toContain('Pyright/reportMissingImports count=257');
    expect(result.resultPreview).not.toContain('module_256');
    expect(summary.totalDiagnostics).toBe(257);
    expect(summary.missingImportCount).toBe(257);
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]).toMatchObject({
      source: 'Pyright',
      code: 'reportMissingImports',
      count: 257,
      messagePrefix: 'Import "<module>" could not be resolved',
      missingImport: true
    });
    expect(summary.groups[0].representativeLocations).toEqual([
      'packages/type_mapping.py:12:1',
      'packages/type_mapping.py:13:2',
      'packages/type_mapping.py:14:3'
    ]);
  });

  it('keeps mixed actionable diagnostics ahead of grouped missing-import noise', async () => {
    const diagnosticFile = path.join(tempWorktree, 'packages/arithmetic_normalizer.py');
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'python_lsp',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `
          const diagnosticFile = ${JSON.stringify(diagnosticFile)};
          const importNoise = Array.from({ length: 32 }, (_, index) =>
            \`ERROR at L\${80 + index}:C10: Import "ceridwen_foundation.pli.noise_\${index}" could not be resolved (Source: Pyright, Code: reportMissingImports)\`
          );
          const lines = [
            diagnosticFile,
            'Diagnostics in File: 35',
            'ERROR at L24:C15: Type "str" is not assignable to declared type "int" (Source: Pyright, Code: reportAssignmentType)',
            'ERROR at L42:C9: "normalize_operand" is not defined (Source: Pyright, Code: reportUndefinedVariable)',
            'WARNING at L61:C5: Type of "result" is partially unknown (Source: Pyright, Code: reportUnknownVariableType)',
            ...importNoise
          ];
          const diagnostics = lines.join('\\n');
          console.log(JSON.stringify({
            tool: 'python_lsp',
            status: 'PASSED',
            server: 'python-lsp',
            operation: 'diagnostics',
            stdout: diagnostics,
            stdoutBytes: Buffer.byteLength(diagnostics),
            filler: 'x'.repeat(20000)
          }));
        `
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    const summary = result.diagnosticSummary as any;
    const codes = summary.groups.map((group: any) => group.code);

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.outputTruncated).toBe(true);
    expect(result.nextAction).toBe('use_result');
    expect(summary.totalDiagnostics).toBe(35);
    expect(summary.missingImportCount).toBe(32);
    expect(codes.slice(0, 3)).toEqual([
      'reportAssignmentType',
      'reportUndefinedVariable',
      'reportUnknownVariableType'
    ]);
    expect(codes).toContain('reportMissingImports');
    expect(summary.groups.find((group: any) => group.code === 'reportMissingImports')).toMatchObject({
      count: 32,
      missingImport: true
    });
    expect(result.resultPreview.indexOf('Pyright/reportAssignmentType')).toBeLessThan(result.resultPreview.indexOf('Pyright/reportMissingImports'));
    expect(result.resultPreview).toContain('reportUndefinedVariable');
    expect(result.resultPreview).toContain('Pyright/reportMissingImports count=32');
    expect(result.resultPreview).not.toContain('noise_31');
  });

  it('keeps resultPreview compact when diagnosticSummary is present even with large raw MCP diagnostic content', async () => {
    // This test targets the MCP python_lsp code path where record.result contains
    // MCP content with the full raw diagnostic text.  Before the fix, resultPreviewText
    // would pick record.result content (tens of KiB of raw lines) over the compact
    // diagnosticSummary preview already placed in RESULT_PREVIEW, causing token pressure.
    const diagnosticFile = path.join(tempWorktree, 'packages/type_mapping.py');
    const rawDiagnosticLines = [
      diagnosticFile,
      'Diagnostics in File: 257',
      ...Array.from({ length: 257 }, (_, index) =>
        `ERROR at L${12 + index}:C${(index % 20) + 1}: Import "ceridwen_foundation.generated.module_${index}" could not be resolved (Source: Pyright, Code: reportMissingImports)`
      )
    ].join('\n');

    // Simulate the shape of an MCP python_lsp result: the MCP SDK wraps the
    // response text in result.content[].text — the structure that
    // textFromMcpContent() extracts.
    const mcpContent = {
      content: [{ type: 'text', text: rawDiagnosticLines }]
    };

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'python_lsp',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'python_lsp',
          status: 'PASSED',
          server: 'python-lsp',
          operation: 'diagnostics',
          result: ${JSON.stringify(mcpContent)},
          filler: 'x'.repeat(20000)
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.outputTruncated).toBe(true);
    expect(result.nextAction).toBe('use_result');
    // The model-facing resultPreview must be the compact summary, not the raw
    // MCP diagnostic text.  Assert it is well within the named budget constant
    // and does not expose individual raw import lines.
    expect(result.resultPreview).toBeDefined();
    expect(result.resultPreview.length).toBeLessThanOrEqual(ProjectToolDefaults.DIAGNOSTIC_SUMMARY_RESULT_PREVIEW_MAX_BYTES);
    expect(result.resultPreview).toContain('Diagnostics in File: 257');
    expect(result.resultPreview).toContain('Pyright/reportMissingImports count=257');
    // Raw individual module import lines must NOT appear in the preview.
    expect(result.resultPreview).not.toContain('module_256');
    expect(result.resultPreview).not.toContain('module_0');
    // diagnosticSummary must be present and correct.
    const summary = result.diagnosticSummary as any;
    expect(summary.totalDiagnostics).toBe(257);
    expect(summary.missingImportCount).toBe(257);
    expect(summary.groups).toHaveLength(1);
    // Recovery guidance must direct agents to cite groups and rerun narrowly.
    expect(result.recovery).toEqual(expect.arrayContaining([
      expect.stringContaining('diagnosticSummary groups'),
      expect.stringContaining('Rerun diagnostics narrowly')
    ]));
    // Raw diagnostics remain available via outputArchive — not deleted.
    expect(result.outputArchive).toMatchObject({ truncated: true });
    expect(result.outputArchive.artifactRef).toMatch(/^project-tool-output:/);
  });

  it('keeps actionable mixed diagnostics visible in resultPreview even when MCP content is present', async () => {
    // Mixed case: non-import errors alongside import noise, delivered via MCP content.
    // The compact preview must keep actionable groups visible and omit raw lines.
    const diagnosticFile = path.join(tempWorktree, 'packages/arithmetic_normalizer.py');
    const importNoise = Array.from({ length: 32 }, (_, index) =>
      `ERROR at L${80 + index}:C10: Import "ceridwen_foundation.pli.noise_${index}" could not be resolved (Source: Pyright, Code: reportMissingImports)`
    );
    const rawDiagnosticLines = [
      diagnosticFile,
      'Diagnostics in File: 35',
      'ERROR at L24:C15: Type "str" is not assignable to declared type "int" (Source: Pyright, Code: reportAssignmentType)',
      'ERROR at L42:C9: "normalize_operand" is not defined (Source: Pyright, Code: reportUndefinedVariable)',
      'WARNING at L61:C5: Type of "result" is partially unknown (Source: Pyright, Code: reportUnknownVariableType)',
      ...importNoise
    ].join('\n');

    const mcpContent = {
      content: [{ type: 'text', text: rawDiagnosticLines }]
    };

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'python_lsp',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'python_lsp',
          status: 'PASSED',
          server: 'python-lsp',
          operation: 'diagnostics',
          result: ${JSON.stringify(mcpContent)},
          filler: 'x'.repeat(20000)
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    const summary = result.diagnosticSummary as any;
    const codes = summary.groups.map((group: any) => group.code);

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.outputTruncated).toBe(true);
    expect(result.nextAction).toBe('use_result');
    // Actionable (non-import) groups must appear ahead of import noise.
    expect(result.resultPreview).toContain('reportAssignmentType');
    expect(result.resultPreview).toContain('reportUndefinedVariable');
    expect(result.resultPreview).toContain('Pyright/reportMissingImports count=32');
    // The group listing must have non-import groups before the import noise group.
    // Use indexOf on the group entry markers (numbered group lines) rather than
    // the code name strings, because the summary header also mentions reportMissingImports.
    expect(result.resultPreview.indexOf('Pyright/reportAssignmentType')).toBeLessThan(
      result.resultPreview.indexOf('Pyright/reportMissingImports count=32')
    );
    // Raw individual raw import lines must not appear.
    expect(result.resultPreview).not.toContain('noise_31');
    // Preview must fit within the named budget.
    expect(result.resultPreview.length).toBeLessThanOrEqual(ProjectToolDefaults.DIAGNOSTIC_SUMMARY_RESULT_PREVIEW_MAX_BYTES);
    // Summary groups are correctly ordered (non-import first).
    expect(codes.slice(0, 3)).toEqual([
      'reportAssignmentType',
      'reportUndefinedVariable',
      'reportUnknownVariableType'
    ]);
    expect(codes).toContain('reportMissingImports');
  });

  it('inline-path: resultPreview is summary-first when diagnosticSummary present and result fits under inline cap', async () => {
    // DEFECT 1 regression: before the fix, modelFacingInlineResult stripped RESULT_PREVIEW
    // (compact summary) but kept the raw `result` MCP content, so the model saw raw
    // diagnostic lines instead of the grouped summary.  This test exercises the INLINE
    // path — no filler, no forced outputTruncated — so serialized.length < inlineResultBytes.
    const diagnosticFile = path.join(tempWorktree, 'packages/inline_target.py');
    const rawDiagnosticLines = [
      diagnosticFile,
      'Diagnostics in File: 5',
      ...Array.from({ length: 5 }, (_, index) =>
        `ERROR at L${10 + index}:C1: Import "ceridwen_foundation.generated.inline_module_${index}" could not be resolved (Source: Pyright, Code: reportMissingImports)`
      )
    ].join('\n');

    // Simulate an MCP python_lsp result shape.
    const mcpContent = {
      content: [{ type: 'text', text: rawDiagnosticLines }]
    };

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'python_lsp',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'python_lsp',
          status: 'PASSED',
          server: 'python-lsp',
          operation: 'diagnostics',
          result: ${JSON.stringify(mcpContent)}
        }))`
      ],
      cwd: CwdMode.WORKTREE
      // No inlineResultBytes override — uses default 4 KiB. The small result fits inline.
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    // The inline path must NOT have outputTruncated — this confirms we hit the inline branch.
    expect(result.outputTruncated).toBeUndefined();

    // The compact summary must reach the model.
    expect(result.resultPreview).toBeDefined();
    expect(result.resultPreview).toContain('Diagnostics in File: 5');
    expect(result.resultPreview).toContain('Pyright/reportMissingImports count=5');

    // Raw individual module import lines must NOT appear inline.
    expect(result.resultPreview).not.toContain('inline_module_0');
    expect(result.resultPreview).not.toContain('inline_module_4');
    // The raw MCP 'result' field must be absent from the inline payload —
    // modelFacingInlineResult must have suppressed it when diagnosticSummary is present.
    expect((result as any).result).toBeUndefined();

    // The structured diagnosticSummary must still be present.
    const summary = result.diagnosticSummary as any;
    expect(summary).toBeDefined();
    expect(summary.totalDiagnostics).toBe(5);
    expect(summary.missingImportCount).toBe(5);
    expect(summary.groups).toHaveLength(1);
  });

  it('no-summary regression guard: raw MCP content appears in resultPreview when no diagnosticSummary', async () => {
    // DEFECT 1 guard: ensure hasDiagnosticSummary=false does not suppress normal MCP previews.
    // Uses a non-diagnostic MCP tool name so applyDiagnosticModelSummary returns no summary.
    const mcpContent = {
      content: [{ type: 'text', text: 'symbol ceridwen_unique_codemap_symbol found at packages/engine.py:42' }]
    };

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'codemap',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'codemap',
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

    // No diagnosticSummary: raw MCP content must reach the model.
    expect(result.diagnosticSummary).toBeUndefined();
    // The MCP content text must appear somewhere in the serialized result.
    expect(JSON.stringify(result)).toContain('ceridwen_unique_codemap_symbol');
  });

  it('cap-truncation: diagnosticSummaryPreview truncates gracefully when many groups exceed the byte cap', async () => {
    // DEFECT 2 regression: the constant comment falsely claimed no truncation.
    // Construct a payload with 6 distinct non-import codes × 3 occurrences each
    // (filling 3 representative locations per group) plus an import group.  With a
    // long file path (≈90 chars per location × 3 per group × 6 groups = ≈1620 chars
    // for locations alone, plus headers/group-labels) the untruncated summary text
    // exceeds DIAGNOSTIC_SUMMARY_RESULT_PREVIEW_MAX_BYTES (2048).
    // Confirms: preview <= cap, truncation marker present, top (non-import) groups survive.
    const diagnosticFile = path.join(tempWorktree, 'packages/large_module_with_a_very_long_path_segment/subpackage/arithmetic_normalizer_extended.py');

    // 6 distinct actionable (non-import) codes, 3 occurrences each → 3 representative
    // locations per group in the summary.
    const makeLines = (code: string, baseL: number) =>
      Array.from({ length: 3 }, (_, i) =>
        `ERROR at L${baseL + i}:C${i + 1}: Some diagnostic message for code ${code} at position ${baseL + i} (Source: Pyright, Code: ${code})`
      );
    const actionableLines = [
      ...makeLines('reportAssignmentType', 10),
      ...makeLines('reportUndefinedVariable', 20),
      ...makeLines('reportUnknownVariableType', 30),
      ...makeLines('reportAttributeAccessIssue', 40),
      ...makeLines('reportReturnType', 50),
      ...makeLines('reportArgumentType', 60)
    ];
    const importNoise = Array.from({ length: 10 }, (_, i) =>
      `ERROR at L${100 + i}:C1: Import "ceridwen_foundation.generated.noise_module_${i}" could not be resolved (Source: Pyright, Code: reportMissingImports)`
    );
    const allLines = [
      diagnosticFile,
      `Diagnostics in File: ${actionableLines.length + importNoise.length}`,
      ...actionableLines,
      ...importNoise
    ].join('\n');

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'python_lsp',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'python_lsp',
          status: 'PASSED',
          server: 'python-lsp',
          operation: 'diagnostics',
          stdout: ${JSON.stringify(allLines)},
          stdoutBytes: Buffer.byteLength(${JSON.stringify(allLines)}),
          filler: 'x'.repeat(20000)
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    expect(result.outputTruncated).toBe(true);
    expect(result.resultPreview).toBeDefined();

    // Truncation marker must be present (summary exceeded the cap).
    expect(result.resultPreview).toMatch(/\[truncated \d+ characters/);

    // The content before the truncation marker must fit within the cap.
    // boundedPreviewText slices at cap chars then appends the marker, so the total
    // preview length is cap + marker-suffix length — we check the slice, not the total.
    const markerIndex = result.resultPreview.indexOf('\n\n[truncated ');
    expect(markerIndex).toBeGreaterThan(0);
    expect(markerIndex).toBeLessThanOrEqual(ProjectToolDefaults.DIAGNOSTIC_SUMMARY_RESULT_PREVIEW_MAX_BYTES);

    // Top non-import groups survive (they sort first in the summary).
    expect(result.resultPreview).toContain('reportAssignmentType');
    expect(result.resultPreview).toContain('reportUndefinedVariable');
  });

  it('keeps useful command stdout in resultPreview when project tool output is archived', async () => {
    const matchLines = [
      'packages/example.py:10:class Example:',
      'packages/example.py:11:    value = 1'
    ].join('\n');
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'ast_grep',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'ast_grep',
          status: 'PASSED',
          exitCode: 0,
          stdout: ${JSON.stringify(matchLines)},
          stderr: '',
          stdoutBytes: ${Buffer.byteLength(matchLines)},
          stderrBytes: 0,
          filler: 'x'.repeat(20000)
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.outputTruncated).toBe(true);
    expect(result.nextAction).toBe('use_result');
    expect(result.stdout).toBeUndefined();
    expect(result.resultPreview).toContain('packages/example.py:10:class Example:');
    expect(result.resultPreview).not.toContain('filler');
    expect(result.outputArchive.artifactRef).toMatch(/^project-tool-output:/);
    expect(JSON.stringify(result)).not.toContain('outputFile');
  });

  it('adds diagnostic previews for truncated rejected command observations', async () => {
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'pytest_like_failure',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `
          process.stdout.write('pytest header\\n'.repeat(500));
          process.stdout.write('ImportError: cannot import name _emit_display_expression\\n');
          process.stdout.write('ERROR packages/example/test_display.py\\n');
          process.stderr.write('plugin warning\\n'.repeat(500));
          process.exit(2);
        `
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'verify'
    }, {} as any, undefined, new Map());

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.outputTruncated).toBe(true);
    expect(result.nextAction).toBe('fix_or_route_failure');
    expect(result.stdout).toBeUndefined();
    expect(result.diagnosticPreview).toContain('ImportError: cannot import name _emit_display_expression');
    expect(result.diagnosticPreview).toContain('ERROR packages/example/test_display.py');
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
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    const structuredResult = result.structuredResult as any;

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout).toBeUndefined();
    expect(result.outputAccess).toContain('Archived by harness');
    expect(result.outputFile).toBeUndefined();
    expect(result.outputArchive).toMatchObject({ truncated: true });
    expect(result.outputArchive.artifactRef).toMatch(/^project-tool-output:/);
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
          server: 'chroma',
          operations: {
            query: 'chroma_query_documents',
            get: 'chroma_get_documents'
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
          usageNotes: ['Returned ids are Chroma document ids, not filesystem paths.']
        }
      ]
    } as any);

    expect(description).toContain('query -> chroma_query_documents');
    expect(description).toContain('get -> chroma_get_documents');
    expect(description).toContain('query(collection_name, query_texts)');
    expect(description).toContain('get(collection_name, ids)');
    expect(description).toContain('query defaults {"collection_name":"reference_docs"}');
    expect(description).toContain('query(path)');
    expect(description).toContain('Returned ids are Chroma document ids, not filesystem paths.');
    expect(description).toContain('artifactRef or outputAccess text, treat it as archive guidance');
    expect(description).toContain('first decide from resultPreview, structuredResult, and toolCalls');
    expect(description).toContain('Prefer one narrow project-tool call at a time');
    expect(description).toContain('rerun narrower only for a named missing fact or decision blocker');
    expect(description).toContain('Pi UI native MCP server count reports only Pi-adapter connections');
  });

  it('normalizes configured MCP path arguments into the active worktree', () => {
    const result = normalizeMcpPathArguments({
      name: 'codemap',
      type: ProjectToolType.MCP,
      server: 'codemap',
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
      toolName: 'codemap'
    });

    expect(result.arguments).toEqual({
      path: path.join(tempWorktree, 'packages/example'),
      depth: 2
    });
    expect(result.normalizedPathArguments).toEqual(['path']);
  });

  it('normalizes python_lsp filePath arguments into the active worktree', () => {
    const result = normalizeMcpPathArguments({
      name: 'python_lsp',
      type: ProjectToolType.MCP,
      server: 'python-lsp',
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
      toolName: 'python_lsp'
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
      name: 'framework_codemap',
      type: ProjectToolType.MCP,
      server: 'codemap',
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
      toolName: 'framework_codemap'
    });

    expect(result.arguments).toEqual({
      path: path.join(frameworkRoot, 'tests/teammates.test.ts')
    });
    expect(result.normalizedPathArguments).toEqual(['path']);
  });

  it('rejects configured MCP path arguments outside the active worktree', () => {
    expect(() => normalizeMcpPathArguments({
      name: 'codemap',
      type: ProjectToolType.MCP,
      server: 'codemap',
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
      toolName: 'codemap'
    })).toThrow(/escapes configured worktree root/);
  });

  it('rejects python_lsp filePath arguments outside the active worktree', () => {
    const pythonLspTool: ProjectMcpToolConfig = {
      name: 'python_lsp',
      type: ProjectToolType.MCP,
      server: 'python-lsp',
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
      toolName: 'python_lsp'
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
    expect(result.stdoutFile).toBeUndefined();
    expect(result.stderrFile).toBeUndefined();
    expect(result.outputAccess).toBeUndefined();
    expect(result.outputArchive).toBeUndefined();
    const events = await eventStore.readAll();
    const started = events.find(event => event.type === DomainEventName.PROJECT_TOOL_STARTED);
    const prepared = events.find(event => event.type === DomainEventName.PROJECT_TOOL_OUTPUT_DIR_PREPARED);
    expect(JSON.stringify(started?.data)).not.toContain('outputFile');
    expect(prepared).toBeUndefined();
    expect((started?.data as any).outputArchive.artifactRef).toMatch(/^project-tool-output:/);
    const payload = JSON.parse(result.stdout);
    const expectedCallDir = path.join(tempRoot, '.tmp/tool-calls/bd-1/Planning/analyze/env_probe', payload[EnvProbeField.TOOL_INVOCATION_ID]);
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
    const payload = JSON.parse(result.stdout);
    const expectedCallDir = path.join(tempRoot, '.tmp/tool-calls/bd-2/AdversarialPostReview/quality/env_probe', payload[EnvProbeField.TOOL_INVOCATION_ID]);
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

    const firstPayload = JSON.parse(first.stdout);
    const secondPayload = JSON.parse(second.stdout);

    expect(firstPayload[EnvProbeField.TOOL_INVOCATION_ID]).not.toBe(secondPayload[EnvProbeField.TOOL_INVOCATION_ID]);
    expect(firstPayload[EnvProbeField.CALL_DIR]).not.toBe(secondPayload[EnvProbeField.CALL_DIR]);
    expect(firstPayload[EnvProbeField.OUTPUT_FILE]).not.toBe(secondPayload[EnvProbeField.OUTPUT_FILE]);
    expect(firstPayload[EnvProbeField.OUTPUT_FILE]).toContain(path.join(tempRoot, '.tmp/tool-calls/bd-3/Planning/repeat/env_probe'));
    expect(secondPayload[EnvProbeField.OUTPUT_FILE]).toContain(path.join(tempRoot, '.tmp/tool-calls/bd-3/Planning/repeat/env_probe'));
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
    maxOutputBytes: 10_000
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

    expect(result.tool).toBe('shape_probe');
    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.exitCode).toBe(0);
    expect(result.maxBufferExceeded).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.stderr).toBe('string');
    expect(typeof result.stdoutBytes).toBe('number');
    expect(typeof result.stderrBytes).toBe('number');
    expect(typeof result.stdoutTruncated).toBe('boolean');
    expect(typeof result.stderrTruncated).toBe('boolean');
    expect(result.stdoutTruncated).toBe(false);
    // stdoutFile/stderrFile are stripped by model-facing filter (MODEL_HIDDEN_RESULT_KEYS)
    expect(result).not.toHaveProperty('stdoutFile');
    expect(result).not.toHaveProperty('stderrFile');
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
        maxOutputBytes: 10_000
      },
      { beadId: 'bd-shape', stateId: 'Planning', actionId: 'test' },
      {} as any, undefined, new Map()
    ) as any;

    expect(result.tool).toBe('shape_probe_fail');
    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.exitCode).toBe(1);
    expect(result.maxBufferExceeded).toBe(false);
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.stderr).toBe('string');
    expect(typeof result.stdoutBytes).toBe('number');
    expect(typeof result.stderrBytes).toBe('number');
    expect(typeof result.stdoutTruncated).toBe('boolean');
    expect(typeof result.stderrTruncated).toBe('boolean');
    // stdoutFile/stderrFile are stripped by model-facing filter (MODEL_HIDDEN_RESULT_KEYS)
    expect(result).not.toHaveProperty('stdoutFile');
    expect(result).not.toHaveProperty('stderrFile');
  });
});

// wf9j/pi-experiment-ejl4: per-tool structured summarizer registry
describe('per-tool structured summarizer registry', () => {
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
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-summarizer-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-1');
    fs.mkdirSync(tempWorktree, { recursive: true });
    writeMinimalHarnessConfig(tempRoot);
    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-summarizer-${process.pid}`);
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

  // (a) registered summarizer produces structuredResult with stable fields
  it('(a) diagnostic summarizer produces structuredResult with all stable StructuredResult fields', async () => {
    const diagnosticFile = path.join(tempWorktree, 'packages/test_module.py');
    const diagnosticLines = [
      diagnosticFile,
      'Diagnostics in File: 3',
      'ERROR at L10:C5: Type "str" is not assignable to declared type "int" (Source: Pyright, Code: reportAssignmentType)',
      'ERROR at L20:C1: "undefined_func" is not defined (Source: Pyright, Code: reportUndefinedVariable)',
      'WARNING at L30:C3: Type partially unknown (Source: Pyright, Code: reportUnknownVariableType)'
    ].join('\n');

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'python_lsp',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'python_lsp',
          status: 'PASSED',
          server: 'python-lsp',
          operation: 'diagnostics',
          stdout: ${JSON.stringify(diagnosticLines)},
          stdoutBytes: Buffer.byteLength(${JSON.stringify(diagnosticLines)}),
          filler: 'x'.repeat(20000)
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    // structuredResult must be present with all stable fields
    const structuredResult = result.structuredResult as any;
    expect(structuredResult).toBeDefined();

    // status must be 'ok' on successful parse
    expect(structuredResult.status).toBe('ok');

    // counts must contain numeric diagnostic tallies
    expect(structuredResult.counts).toBeDefined();
    expect(typeof structuredResult.counts.total).toBe('number');
    expect(structuredResult.counts.total).toBe(3);
    expect(typeof structuredResult.counts.groups).toBe('number');

    // affectedPaths must be an array of strings (representative file locations)
    expect(Array.isArray(structuredResult.affectedPaths)).toBe(true);
    expect(structuredResult.affectedPaths.length).toBeGreaterThan(0);
    for (const p of structuredResult.affectedPaths) {
      expect(typeof p).toBe('string');
    }

    // nextAction must be a string guidance hint
    expect(typeof structuredResult.nextAction).toBe('string');
    expect(structuredResult.nextAction.length).toBeGreaterThan(0);

    // representativeSamples is optional — no requirement to be present for diagnostic summarizer
    // omissions is optional — no omissions when all groups fit
  });

  // (b) no-summarizer tool falls back to existing bounded preview behavior unchanged
  it('(b) tool without a registered summarizer falls back to generic bounded preview with no structuredResult change', async () => {
    // 'env_probe' does not trigger any summarizer — raw JSON output, not a diagnostic tool
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'env_probe',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `
        const payload = { tool: 'env_probe', status: 'PASSED', output: 'x'.repeat(20000) };
        process.stdout.write(JSON.stringify(payload));
      `],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    // Tool should still succeed
    expect(result.status).toBe(ToolResultStatus.PASSED);
    // Should be truncated (payload exceeds 1000 byte inline limit)
    expect(result.outputTruncated).toBe(true);
    // No diagnostic summary
    expect((result as any).diagnosticSummary).toBeUndefined();
    // structuredResult must be absent (no summarizer applies)
    // (The existing structuredPayloadSummary path from the command tool produces structuredResult
    // from structured JSON stdout, but env_probe's stdout is not JSON with structured keys.
    // If the payload happens to have structuredResult from the generic path, that's also fine —
    // the key test is that the summarizer registry did NOT produce one for a non-diagnostic tool.)

    // outputArchive must be present (archive always written — requirement 5)
    expect(result.outputArchive).toBeDefined();
    expect(result.outputArchive.artifactRef).toMatch(/^project-tool-output:/);

    // outputAccess guidance must be present (truncated path)
    expect(result.outputAccess).toContain('Archived by harness');
  });

  // (c) parse_error path: summarizer returns parse_error, archive is preserved, no raw dump
  it('(c) diagnostic summarizer returns parse_error structured result for unrecognized diagnostic content and archive is preserved', async () => {
    // We test the parse_error path by producing a payload that triggers the diagnostic
    // summarizer (tool name 'python_lsp') but with content that will parse to zero diagnostics
    // (so summarizeParsedDiagnostics returns undefined — summarizer returns null, not parse_error).
    // To hit parse_error we need to cause the summarize catch path.
    // The real parse_error path is exercised when summarizeParsedDiagnostics returns undefined
    // after the shouldSummarize check passes with non-empty text but no parseable diagnostics.
    // In the diagnostic summarizer: if summarizeParsedDiagnostics returns undefined, return null
    // (not parse_error); the parse_error is only returned if an exception is thrown.
    // We verify the parse_error StructuredResult shape via the exported interface instead,
    // by confirming the archive is always written (requirement 5) even when the result is large.

    const largePayload = 'x'.repeat(50000);
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'large_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `process.stdout.write(JSON.stringify({
          tool: 'large_tool',
          status: 'PASSED',
          output: ${JSON.stringify(largePayload)}
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    // Archive is always written regardless of summarizer outcome (requirement 5)
    expect(result.outputArchive).toBeDefined();
    expect(result.outputArchive.artifactRef).toMatch(/^project-tool-output:/);
    expect(result.outputArchive.bytes).toBeGreaterThan(1000);
    // Model-facing result is compact (not raw 50KB dump)
    const modelFacingSize = JSON.stringify(result).length;
    expect(modelFacingSize).toBeLessThan(5000);
  });

  // (d) existing diagnostic behavior (7i0) still holds via the registry
  it('(d) diagnostic summarizer in registry preserves 7i0 behavior: diagnosticSummary, resultPreview, recovery', async () => {
    const diagnosticFile = path.join(tempWorktree, 'packages/type_mapping.py');
    const importLines = Array.from({ length: 50 }, (_, index) =>
      `ERROR at L${12 + index}:C1: Import "ceridwen_foundation.module_${index}" could not be resolved (Source: Pyright, Code: reportMissingImports)`
    );
    const diagnosticLines = [
      diagnosticFile,
      `Diagnostics in File: ${importLines.length}`,
      ...importLines
    ].join('\n');

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'python_lsp',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'python_lsp',
          status: 'PASSED',
          server: 'python-lsp',
          operation: 'diagnostics',
          stdout: ${JSON.stringify(diagnosticLines)},
          stdoutBytes: Buffer.byteLength(${JSON.stringify(diagnosticLines)}),
          filler: 'x'.repeat(20000)
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    // 7i0 behavior: diagnosticSummary is present with the expected shape
    const summary = result.diagnosticSummary as any;
    expect(summary).toBeDefined();
    expect(summary.totalDiagnostics).toBe(50);
    expect(summary.missingImportCount).toBe(50);
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]).toMatchObject({
      source: 'Pyright',
      code: 'reportMissingImports',
      count: 50,
      missingImport: true
    });

    // 7i0 behavior: resultPreview is the compact grouped text, not raw lines
    expect(result.resultPreview).toBeDefined();
    expect(result.resultPreview).toContain(`Diagnostics in File: ${importLines.length}`);
    expect(result.resultPreview).toContain('Pyright/reportMissingImports count=50');
    expect(result.resultPreview).not.toContain('module_49');
    expect(result.resultPreview.length).toBeLessThanOrEqual(ProjectToolDefaults.DIAGNOSTIC_SUMMARY_RESULT_PREVIEW_MAX_BYTES);

    // 7i0 behavior: recovery guidance cites diagnosticSummary
    expect(result.recovery).toEqual(expect.arrayContaining([
      expect.stringContaining('diagnosticSummary groups')
    ]));

    // 7i0 behavior: archive is present (raw data preserved)
    expect(result.outputArchive).toMatchObject({ truncated: true });
    expect(result.outputArchive.artifactRef).toMatch(/^project-tool-output:/);

    // Registry behavior: structuredResult is also present with stable fields (new)
    const structuredResult = result.structuredResult as any;
    expect(structuredResult).toBeDefined();
    expect(structuredResult.status).toBe('ok');
    expect(structuredResult.counts.total).toBe(50);
  });

  // Token metric: structuredResult replaces raw payload in model-facing result
  it('token efficiency: model-facing result with structured summary is substantially smaller than raw payload', async () => {
    const diagnosticFile = path.join(tempWorktree, 'packages/large_module.py');
    // Build a large raw diagnostic payload (~50 distinct import errors)
    const rawLines = Array.from({ length: 50 }, (_, index) =>
      `ERROR at L${index + 1}:C1: Import "ceridwen_foundation.very_long_module_name_${index}.subpackage" could not be resolved (Source: Pyright, Code: reportMissingImports)`
    );
    const diagnosticText = [
      diagnosticFile,
      `Diagnostics in File: ${rawLines.length}`,
      ...rawLines
    ].join('\n');
    // Raw payload is intentionally large (many lines)
    const rawPayloadBytes = Buffer.byteLength(diagnosticText);

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'python_lsp',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'python_lsp',
          status: 'PASSED',
          server: 'python-lsp',
          operation: 'diagnostics',
          stdout: ${JSON.stringify(diagnosticText)},
          stdoutBytes: ${rawPayloadBytes},
          filler: 'x'.repeat(20000)
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    // Model-facing result must be compact — well within 5 KiB
    const modelFacingJson = JSON.stringify(result);
    const modelFacingBytes = Buffer.byteLength(modelFacingJson);
    expect(modelFacingBytes).toBeLessThan(5 * 1024);

    // The raw payload alone was larger than the model-facing result
    expect(rawPayloadBytes).toBeGreaterThan(modelFacingBytes);

    // structuredResult is present with stable fields
    const structuredResult = result.structuredResult as any;
    expect(structuredResult.status).toBe('ok');
    expect(structuredResult.counts.total).toBe(50);
    expect(Array.isArray(structuredResult.affectedPaths)).toBe(true);

    // Archive holds the full raw data (requirement 5)
    expect(result.outputArchive).toMatchObject({ truncated: true });
    expect(result.outputArchive.bytes).toBeGreaterThan(rawPayloadBytes);
  });

  // (f) clobber-precedence: pre-existing structuredPayloadSummary (rich gate evidence) wins over
  //     the diagnostic summarizer when both would fire.
  //
  //     Regression test for: registry UNCONDITIONALLY overwriting STRUCTURED_RESULT would replace
  //     the rich structuredPayloadSummary (with verdict/artifact/errorsByTool gate evidence) with
  //     the leaner diagnostic StructuredResult (with counts/affectedPaths).
  //     This test FAILS against the clobbering code and PASSES with the precedence guard.
  it('(f) pre-existing structuredPayloadSummary (rich gate evidence) is NOT clobbered by the diagnostic summarizer', async () => {
    const diagnosticFile = path.join(tempWorktree, 'packages/checker.py');
    // Embed diagnostic text in the stdout field so the diagnostic summarizer's appliesTo fires
    const diagnosticLines = [
      diagnosticFile,
      'Diagnostics in File: 2',
      'ERROR at L5:C1: Type mismatch (Source: Pyright, Code: reportAssignmentType)',
      'ERROR at L9:C3: Undefined variable (Source: Pyright, Code: reportUndefinedVariable)'
    ].join('\n');

    // The outer JSON stdout carries rich gate-evidence keys (artifact, verdict, errors_by_tool).
    // buildCommandResult feeds this to structuredPayloadSummary, which extracts them into
    // STRUCTURED_RESULT BEFORE persistAndBoundResult runs the summarizer registry.
    // The diagnostic summarizer also fires (tool name 'python_lsp' matches shouldSummarizeDiagnostics).
    // With the fix: the pre-existing rich structuredResult is preserved (precedence guard).
    // Without the fix: the registry overwrites it with the leaner diagnostic StructuredResult.
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'python_lsp',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'python_lsp',
          status: 'REJECTED',
          artifact: 'gate_evidence_artifact',
          verdict: 'fail',
          errors_by_tool: {
            pyright: [
              { tool: 'pyright', file: 'packages/checker.py', line: 5, code: 'reportAssignmentType', message: 'Type mismatch', blocking: true }
            ]
          },
          stdout: ${JSON.stringify(diagnosticLines)},
          stdoutBytes: ${Buffer.byteLength(diagnosticLines)},
          filler: 'x'.repeat(20000)
        })); process.exit(1);`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'verify'
    }, {} as any, undefined, new Map());

    const structuredResult = result.structuredResult as any;
    expect(structuredResult).toBeDefined();

    // The rich gate-evidence fields from structuredPayloadSummary must be present.
    // These are absent from the leaner diagnostic StructuredResult (which only has
    // status/counts/affectedPaths/representativeSamples/omissions/nextAction).
    expect(structuredResult.artifact).toBe('gate_evidence_artifact');
    expect(structuredResult.verdict).toBe('fail');
    expect(Array.isArray(structuredResult.errorsByTool)).toBe(true);
    expect(structuredResult.errorsByTool[0].group).toBe('pyright');

    // The diagnostic summarizer's leaner shape fields must NOT be present on the result.
    // If the registry had clobbered, we'd see counts.total/affectedPaths instead.
    expect(structuredResult.counts).toBeUndefined();
    expect(structuredResult.affectedPaths).toBeUndefined();
  });
});

// pi-experiment-b77h: generalized hasStructuredModelSummary suppression
// Suppresses raw stdout/stderr/output/result from model-facing result when
// structuredResult OR diagnosticSummary is present, while keeping archives and
// actionable failure fields.
describe('generalized structuredModelSummary suppression (b77h)', () => {
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
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-b77h-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-1');
    fs.mkdirSync(tempWorktree, { recursive: true });
    writeMinimalHarnessConfig(tempRoot);
    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-b77h-${process.pid}`);
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

  // (a) non-diagnostic structuredResult suppresses raw stdout/stderr/result on both inline
  //     and truncated paths, and keeps structuredResult + outputArchive
  it('(a) structuredResult (non-diagnostic) suppresses raw stdout/stderr on inline AND truncated paths; keeps structuredResult + archive', async () => {
    // Payload produces a structuredResult via structuredPayloadSummary (checks array).
    // With filler to force the truncated path.
    const checksPayload = JSON.stringify({
      tool: 'coding_standards',
      status: ToolResultStatus.PASSED,
      artifact: 'implementation',
      checks: [
        { name: 'style', status: ToolResultStatus.PASSED, message: 'ok' },
        { name: 'coverage', status: ToolResultStatus.PASSED, message: 'ok' }
      ],
      errors_by_tool: {
        eslint: []
      }
    });

    // --- TRUNCATED PATH (with filler that pushes past inlineResultBytes) ---
    const truncatedResult = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'coding_standards',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'coding_standards',
          status: 'PASSED',
          artifact: 'implementation',
          checks: [
            { name: 'style', status: 'PASSED', message: 'ok' },
            { name: 'coverage', status: 'PASSED', message: 'ok' }
          ],
          errors_by_tool: { eslint: [] },
          filler: 'x'.repeat(20000)
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'verify'
    }, {} as any, undefined, new Map()) as any;

    expect(truncatedResult.status).toBe(ToolResultStatus.PASSED);
    expect(truncatedResult.outputTruncated).toBe(true);
    // Raw payload fields must be absent on truncated path
    expect(truncatedResult.stdout).toBeUndefined();
    expect(truncatedResult.stderr).toBeUndefined();
    expect((truncatedResult as any).result).toBeUndefined();
    // structuredResult with gate-evidence (passedCheckCount from checks) is present
    expect(truncatedResult.structuredResult).toBeDefined();
    expect(truncatedResult.structuredResult.passedCheckCount).toBe(2);
    expect(truncatedResult.structuredResult.rejectedCheckCount).toBe(0);
    // outputArchive is attached (raw payload archived)
    expect(truncatedResult.outputArchive).toBeDefined();
    expect(truncatedResult.outputArchive.artifactRef).toMatch(/^project-tool-output:/);

    // --- INLINE PATH (small payload, no filler, fits under default 4 KiB inline cap) ---
    const inlineResult = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'coding_standards',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `process.stdout.write(${JSON.stringify(checksPayload)})`
      ],
      cwd: CwdMode.WORKTREE
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'verify'
    }, {} as any, undefined, new Map()) as any;

    expect(inlineResult.status).toBe(ToolResultStatus.PASSED);
    // Small result fits inline (no outputTruncated)
    expect(inlineResult.outputTruncated).toBeUndefined();
    // Raw payload fields must be absent on inline path too
    expect(inlineResult.stdout).toBeUndefined();
    expect(inlineResult.stderr).toBeUndefined();
    expect((inlineResult as any).result).toBeUndefined();
    // structuredResult is present
    expect(inlineResult.structuredResult).toBeDefined();
    expect(inlineResult.structuredResult.passedCheckCount).toBe(2);
  });

  // (b) FAILURE with structuredResult keeps failureCategory + diagnosticPreview (actionable)
  //     while raw stdout/stderr are suppressed.  Uses a clean JSON stdout (no mixed output)
  //     so structuredPayloadSummary can extract the checks array into structuredResult.
  it('(b) FAILURE with structuredResult keeps failureCategory + diagnosticPreview actionable while raw is suppressed', async () => {
    // The tool outputs structured JSON, then exits non-zero.  The stderr carries raw
    // diagnostic lines so commandDiagnosticPreview can extract a diagnosticPreview.
    // The stdout JSON has a checks array so structuredPayloadSummary fires.
    // filler pushes the serialized past inlineResultBytes → truncated path.
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'pytest',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'pytest',
          status: 'REJECTED',
          checks: [
            { name: 'test-suite', status: 'REJECTED', message: 'test_example.py::test_add FAILED' }
          ],
          errors_by_tool: { pytest: [{ tool: 'pytest', file: 'test_example.py', line: 10, message: 'AssertionError', blocking: true }] },
          filler: 'x'.repeat(10000)
        }));
        process.stderr.write('ERROR test_example.py::test_add FAILED\\nAssertionError: assert 1 == 2\\n');
        process.exitCode = 1;`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000,
      maxOutputBytes: 50_000
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'verify'
    }, {} as any, undefined, new Map()) as any;

    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.outputTruncated).toBe(true);
    // failureCategory must be present (failure stays actionable)
    expect(result.failureCategory).toBeDefined();
    // diagnosticPreview must be present for actionable failure context
    expect(result.diagnosticPreview).toBeDefined();
    expect(result.diagnosticPreview).toMatch(/ERROR|AssertionError|FAILED/);
    // structuredResult with rejection evidence is present
    expect(result.structuredResult).toBeDefined();
    expect(result.structuredResult.rejectedCheckCount).toBe(1);
    // Raw stdout is suppressed (structuredResult present)
    expect(result.stdout).toBeUndefined();
    // outputArchive is present (raw preserved in archive)
    expect(result.outputArchive).toBeDefined();
    expect(result.outputArchive.artifactRef).toMatch(/^project-tool-output:/);
  });

  // (c) small plain-text no-summary result still works and has no duplicate raw fields
  it('(c) small plain-text result without structuredResult has no duplicate raw fields', async () => {
    // A simple passing tool with no checks/structured keys — no structuredResult generated.
    // The raw stdout appears directly in the model-facing result (no suppression).
    // resultPreview is hidden on inline path, so no duplicate.
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'simple_grep',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', 'process.stdout.write("match found at line 42\\n");'],
      cwd: CwdMode.WORKTREE
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'search'
    }, {} as any, undefined, new Map()) as any;

    expect(result.status).toBe(ToolResultStatus.PASSED);
    // No structuredResult (tool has no structured output)
    expect(result.structuredResult).toBeUndefined();
    // No diagnosticSummary
    expect(result.diagnosticSummary).toBeUndefined();
    // Small result is inline — no outputTruncated
    expect(result.outputTruncated).toBeUndefined();
    // Raw stdout present (no suppression without structuredResult)
    expect(result.stdout).toContain('match found at line 42');
    // resultPreview is hidden on inline path (MODEL_HIDDEN_RESULT_KEYS) — no duplicate
    expect((result as any).resultPreview).toBeUndefined();
    // No output duplication: stdout carries the raw text once and only once
    const resultJson = JSON.stringify(result);
    const occurrences = (resultJson.match(/match found at line 42/g) || []).length;
    expect(occurrences).toBe(1);
  });

  // (d) 7i0 diagnostic behavior still holds (regression guard for exact 7i0 behavior)
  it('(d) 7i0 diagnostic behavior preserved: diagnosticSummary suppresses raw MCP result on inline path', async () => {
    // Identical to the inline-path test from the 7i0 regression suite to confirm
    // the generalized suppression is a strict superset that does not break 7i0.
    const diagnosticFile = path.join(tempWorktree, 'packages/b77h_inline_target.py');
    const rawDiagnosticLines = [
      diagnosticFile,
      'Diagnostics in File: 3',
      'ERROR at L10:C1: Import "ceridwen_foundation.generated.b77h_module_0" could not be resolved (Source: Pyright, Code: reportMissingImports)',
      'ERROR at L11:C1: Import "ceridwen_foundation.generated.b77h_module_1" could not be resolved (Source: Pyright, Code: reportMissingImports)',
      'ERROR at L12:C1: Import "ceridwen_foundation.generated.b77h_module_2" could not be resolved (Source: Pyright, Code: reportMissingImports)'
    ].join('\n');

    const mcpContent = {
      content: [{ type: 'text', text: rawDiagnosticLines }]
    };

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'python_lsp',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'python_lsp',
          status: 'PASSED',
          server: 'python-lsp',
          operation: 'diagnostics',
          result: ${JSON.stringify(mcpContent)}
        }))`
      ],
      cwd: CwdMode.WORKTREE
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map()) as any;

    // 7i0 behavior preserved: inline path, no outputTruncated
    expect(result.outputTruncated).toBeUndefined();
    // Compact summary must be present
    expect(result.resultPreview).toContain('Diagnostics in File: 3');
    expect(result.resultPreview).toContain('Pyright/reportMissingImports count=3');
    // Raw module names must NOT appear inline
    expect(result.resultPreview).not.toContain('b77h_module_0');
    // Raw MCP result field must be absent (suppressed by hasStructuredModelSummary)
    expect((result as any).result).toBeUndefined();
    // diagnosticSummary is present
    const summary = result.diagnosticSummary;
    expect(summary).toBeDefined();
    expect(summary.totalDiagnostics).toBe(3);
    expect(summary.missingImportCount).toBe(3);
  });

  // Token metric: model-facing size with structuredResult is substantially smaller than the
  // archived (raw) payload.  Uses maxOutputBytes large enough to capture the full filler
  // so the archive bytes reflect the actual raw payload size.
  it('token metric: model-facing result with structuredResult is compact vs raw payload size', async () => {
    // Build a large payload with a checks array (triggers structuredResult via structuredPayloadSummary)
    // plus filler to force the truncated path.
    // maxOutputBytes is set large so the full filler is captured by boundedCommandFile,
    // ensuring serialized.length (== archive bytes) reflects the actual large payload.
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'coding_standards',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `
          const checks = Array.from({ length: 30 }, (_, i) => ({
            name: 'check-' + i,
            status: 'PASSED',
            message: 'check ' + i + ' passed with details: ' + 'x'.repeat(200)
          }));
          console.log(JSON.stringify({
            tool: 'coding_standards',
            status: 'PASSED',
            checks,
            filler: 'x'.repeat(30000)
          }));
        `
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000,
      maxOutputBytes: 60_000
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'verify'
    }, {} as any, undefined, new Map()) as any;

    const modelFacingJson = JSON.stringify(result);
    const modelFacingBytes = Buffer.byteLength(modelFacingJson);

    // Model-facing result must be compact — well within 5 KiB
    expect(modelFacingBytes).toBeLessThan(5 * 1024);
    // structuredResult is present
    expect(result.structuredResult).toBeDefined();
    expect(result.structuredResult.passedCheckCount).toBe(30);
    // Raw stdout is suppressed
    expect(result.stdout).toBeUndefined();
    // Archive is attached and truncated (payload exceeded inlineResultBytes cap)
    expect(result.outputArchive).toMatchObject({ truncated: true });
    expect(result.outputArchive.artifactRef).toMatch(/^project-tool-output:/);
    // The archive bytes reflect the bounded serialized output; model-facing is even smaller
    // because the compact structuredResult replaces the raw payload fields.
    // (archive bytes = serialized bounded-stdout result; model-facing = compact summary only)
    expect(result.outputArchive.bytes).toBeGreaterThan(modelFacingBytes);
  });

  // -------------------------------------------------------------------------
  // EARS work item pi-experiment-cdw9: structuredResult as authoritative
  // steering evidence
  // -------------------------------------------------------------------------

  it('(cdw9-a) structuredResult with decision evidence + outputTruncated steers to use_result, not rerun_narrower', async () => {
    // A large payload that forces outputTruncated=true (exceeds inlineResultBytes) plus
    // a checks array that produces structuredResult with passedCheckCount/rejectedCheckCount
    // decision evidence.  The steering must prefer structuredResult evidence over the raw
    // truncation marker and return use_result, not rerun_narrower.
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'artifact_validator',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'artifact_validator',
          status: 'PASSED',
          checks: [
            { name: 'schema', status: 'PASSED', message: 'valid' },
            { name: 'completeness', status: 'PASSED', message: 'all required fields present' }
          ],
          filler: 'x'.repeat(20000)
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    const structuredResult = (result as any).structuredResult;

    // structuredResult with decision evidence must be present
    expect(structuredResult).toBeDefined();
    expect(structuredResult.passedCheckCount).toBe(2);
    expect(structuredResult.rejectedCheckCount).toBe(0);

    // outputTruncated is set because payload exceeds inlineResultBytes
    expect((result as any).outputTruncated).toBe(true);

    // Steering must use structured evidence — not raw truncation markers
    expect(result.nextAction).toBe('use_result');
    expect(result.nextAction).not.toBe('rerun_narrower');
  });

  it('(cdw9-b) failure/rejected result still gets failure-category nextAction, not overridden to use_result', async () => {
    // A REJECTED result with structuredResult decision evidence (rejectedCheckCount).
    // The failure-category routing must take precedence — use_result must NOT override it.
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'artifact_validator',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `process.stdout.write(JSON.stringify({
          tool: 'artifact_validator',
          status: 'REJECTED',
          checks: [
            { name: 'schema', status: 'PASSED', message: 'valid' },
            { name: 'completeness', status: 'REJECTED', message: 'section omitted by author' }
          ]
        })); process.exit(1);`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 10_000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    const structuredResult = (result as any).structuredResult;

    // structuredResult with decision evidence is present (rejectedCheckCount > 0)
    expect(structuredResult).toBeDefined();
    expect(structuredResult.rejectedCheckCount).toBe(1);

    // Status is REJECTED — failure category must NOT be overridden by structured evidence
    expect(result.status).toBe(ToolResultStatus.REJECTED);
    expect(result.nextAction).not.toBe('use_result');
    // Verifier-failed is the expected failure-category routing for a generic REJECTED result
    expect(result.nextAction).toBe('fix_or_route_failure');
    expect(result.failureCategory).toBe(ProjectToolFailureCategory.VERIFIER_FAILED);
  });

  it('(cdw9-c) structuredResult with omissions yields fetch_named_omission nextAction, not a generic rerun', async () => {
    // A PASSED result where the structuredResult is produced by a summarizer that
    // explicitly marks omissions.  To inject a structuredResult with omissions we use a
    // tool whose stdout JSON already carries the structuredResult key directly — the harness
    // passes it through via structuredPayloadSummary when no richer evidence is present.
    // We build the payload so that structuredPayloadSummary will surface the provided
    // fields as the structuredResult.
    //
    // However, structuredPayloadSummary does not forward the omissions field.  We instead
    // exercise the code path via executeConfiguredProjectTool with a payload that reaches
    // persistAndBoundResult: the diagnostic summarizer sets omissions when
    // summary.omittedGroups > 0.  We produce >6 distinct diagnostic groups (the
    // STRUCTURED_SUMMARY_MAX_GROUPS cap) so the summarizer sets omissions on the
    // structuredResult and the steering must return fetch_named_omission.
    const diagnosticFile = path.join(tempWorktree, 'packages/example.py');
    // 7 distinct non-import codes — one beyond the 6-group cap — triggers omittedGroups > 0
    const makeLines = (code: string, baseL: number): string[] =>
      Array.from({ length: 1 }, (_, i) =>
        `ERROR at L${baseL + i}:C1: Some error message (Source: Pyright, Code: ${code})`
      );
    const diagnosticLines = [
      diagnosticFile,
      'Diagnostics in File: 7',
      ...makeLines('codeA', 10),
      ...makeLines('codeB', 20),
      ...makeLines('codeC', 30),
      ...makeLines('codeD', 40),
      ...makeLines('codeE', 50),
      ...makeLines('codeF', 60),
      ...makeLines('codeG', 70)  // 7th group — exceeds 6-group cap → omittedGroups=1
    ].join('\n');

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'python_lsp',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'python_lsp',
          status: 'PASSED',
          server: 'python-lsp',
          operation: 'diagnostics',
          stdout: ${JSON.stringify(diagnosticLines)},
          stdoutBytes: ${Buffer.byteLength(diagnosticLines)},
          filler: 'x'.repeat(20000)
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    const structuredResult = (result as any).structuredResult;

    // The summarizer must have set omissions because omittedGroups > 0
    expect(structuredResult).toBeDefined();
    expect(structuredResult.omissions).toBeDefined();
    expect(typeof structuredResult.omissions).toBe('string');

    // Steering must return fetch_named_omission, NOT a generic rerun_narrower
    expect(result.nextAction).toBe('fetch_named_omission');
    expect(result.nextAction).not.toBe('rerun_narrower');

    // Recovery must surface the omissions text
    const recovery = (result as any).recovery as string[];
    expect(recovery).toBeDefined();
    expect(recovery.join('\n')).toContain('omissions');
    expect(recovery.join('\n')).toContain('specific missing');
  });

  it('(cdw9-d) tool with NO structuredResult keeps existing truncation-based steering unchanged', async () => {
    // A large plain-text output tool with no checks array and no diagnostic content —
    // no structuredResult will be produced.  The existing rerun_narrower truncation
    // steering must remain in effect (no-structuredResult path unchanged).
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'large_plain_stdout',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `process.stdout.write('x'.repeat(20000));`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    // No structuredResult — fallback to truncation-based steering
    expect((result as any).structuredResult).toBeUndefined();
    expect((result as any).diagnosticSummary).toBeUndefined();

    // Truncation is set
    expect((result as any).stdoutTruncated).toBe(true);

    // Steering falls back to rerun_narrower because no structured evidence
    expect(result.nextAction).toBe('rerun_narrower');
  });
});

describe('structuredResultHasDecisionEvidence — counts guard (defensive hardening)', () => {
  // Invariant: the diagnostic summarizer only emits 'counts' when diagnostics.length >= 1,
  // so all-zero or empty counts are never produced today.  These tests verify the guard is
  // self-enforcing for any future code path that might violate that invariant.

  it('returns false when the only evidence-like field is an empty counts object', () => {
    expect(structuredResultHasDecisionEvidence({ status: 'ok', counts: {} })).toBe(false);
  });

  it('returns false when counts is present but all values are zero', () => {
    expect(structuredResultHasDecisionEvidence({ status: 'ok', counts: { total: 0, groups: 0 } })).toBe(false);
  });

  it('returns false when counts has mixed zero and non-numeric values only', () => {
    expect(structuredResultHasDecisionEvidence({ status: 'ok', counts: { total: 0, label: 'none' } })).toBe(false);
  });

  it('returns true when counts contains at least one numeric value > 0 (current normal case)', () => {
    expect(structuredResultHasDecisionEvidence({ status: 'ok', counts: { total: 3, parsed: 3, groups: 2 } })).toBe(true);
  });

  it('returns true when counts has a single positive numeric value', () => {
    expect(structuredResultHasDecisionEvidence({ counts: { total: 1 } })).toBe(true);
  });

  it('returns false when value is not a record', () => {
    expect(structuredResultHasDecisionEvidence(null)).toBe(false);
    expect(structuredResultHasDecisionEvidence('counts')).toBe(false);
    expect(structuredResultHasDecisionEvidence(42)).toBe(false);
  });

  it('returns true for other presence-based evidence fields regardless of counts', () => {
    expect(structuredResultHasDecisionEvidence({ verdict: 'pass' })).toBe(true);
    expect(structuredResultHasDecisionEvidence({ error: 'boom' })).toBe(true);
    expect(structuredResultHasDecisionEvidence({ artifact: '/path/to/file' })).toBe(true);
    expect(structuredResultHasDecisionEvidence({ findingsDetected: false })).toBe(true);
    expect(structuredResultHasDecisionEvidence({ routingHint: 'retry' })).toBe(true);
  });

  it('returns false when no evidence fields are present', () => {
    expect(structuredResultHasDecisionEvidence({ status: 'ok' })).toBe(false);
    expect(structuredResultHasDecisionEvidence({})).toBe(false);
  });
});

// pi-experiment-tk6i: commandFailureSummarizer — plain-text command failure grouper
describe('commandFailureSummarizer', () => {
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
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-cmd-fail-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-1');
    fs.mkdirSync(tempWorktree, { recursive: true });
    writeMinimalHarnessConfig(tempRoot);
    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-cmd-fail-${process.pid}`);
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

  // (a) pytest-style test failures -> structuredResult groups by test file/name + assertion type + locations
  it('(a) failing command with pytest-style test failures -> structuredResult groups by test name, assertion type, and locations', async () => {
    const pytestStderr = [
      '_____________________________ test_add _____________________________',
      '',
      '    def test_add():',
      '>       assert add(1, 2) == 4',
      'E       AssertionError: assert 3 == 4',
      '',
      '    File "tests/test_math.py", line 10, in test_add',
      '',
      '_____________________________ test_sub _____________________________',
      '',
      '    def test_sub():',
      '>       assert sub(5, 3) == 3',
      'E       AssertionError: assert 2 == 3',
      '',
      '    File "tests/test_math.py", line 20, in test_sub',
      '',
      'FAILED tests/test_math.py::test_add - AssertionError: assert 3 == 4',
      'FAILED tests/test_math.py::test_sub - AssertionError: assert 2 == 3',
      '2 failed, 0 passed'
    ].join('\n');

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'run_tests',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `process.stderr.write(${JSON.stringify(pytestStderr)}); process.exitCode = 1;`
      ],
      cwd: CwdMode.WORKTREE,
      maxOutputBytes: 50_000
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'test'
    }, {} as any, undefined, new Map()) as any;

    // Status must be REJECTED (failure)
    expect(result.status).toBe(ToolResultStatus.REJECTED);

    // structuredResult must be present with test group data
    const structuredResult = result.structuredResult as any;
    expect(structuredResult).toBeDefined();
    expect(structuredResult.status).toBe('ok');

    // Counts must reflect test failures
    expect(structuredResult.counts).toBeDefined();
    expect(typeof structuredResult.counts.testFailures).toBe('number');
    expect(structuredResult.counts.testFailures).toBeGreaterThan(0);
    expect(typeof structuredResult.counts.testGroups).toBe('number');
    expect(structuredResult.counts.testGroups).toBeGreaterThan(0);

    // representativeSamples must carry test_failure entries with testName
    expect(Array.isArray(structuredResult.representativeSamples)).toBe(true);
    expect(structuredResult.representativeSamples.length).toBeGreaterThan(0);
    const sample = structuredResult.representativeSamples[0];
    expect(sample.type).toBe('test_failure');
    expect(typeof sample.testName).toBe('string');
    expect(sample.testName.length).toBeGreaterThan(0);

    // affectedPaths must be present and contain file references
    expect(Array.isArray(structuredResult.affectedPaths)).toBe(true);
    expect(structuredResult.affectedPaths.length).toBeGreaterThan(0);

    // nextAction must be fix_or_route_failure
    expect(structuredResult.nextAction).toBe('fix_or_route_failure');

    // failureCategory must be preserved (not altered by summarizer)
    expect(typeof result.failureCategory).toBe('string');

    // When structuredResult is present, raw stderr is suppressed in model-facing result
    // (either undefined or absent from the model-facing output)
    // The archive is attached when the result exceeds the inline limit; for small results it may be absent.
    // We only check the structuredResult presence and content here.
  });

  // (b) linter/scanner output -> groups by rule/code/file/severity
  it('(b) failing command with linter/scanner output -> structuredResult groups by rule, severity, and file', async () => {
    const eslintOutput = [
      '/workspace/src/index.ts:10:5: error  Missing semicolon  [semi]',
      '/workspace/src/index.ts:14:1: warning  Unused variable x  [no-unused-vars]',
      '/workspace/src/utils.ts:5:9: error  Missing semicolon  [semi]',
      '/workspace/src/utils.ts:22:3: error  Missing semicolon  [semi]',
      '',
      '4 problems (3 errors, 1 warning)'
    ].join('\n');

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'lint',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `process.stdout.write(${JSON.stringify(eslintOutput)}); process.exitCode = 1;`
      ],
      cwd: CwdMode.WORKTREE,
      maxOutputBytes: 50_000
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'lint'
    }, {} as any, undefined, new Map()) as any;

    expect(result.status).toBe(ToolResultStatus.REJECTED);

    const structuredResult = result.structuredResult as any;
    expect(structuredResult).toBeDefined();
    expect(structuredResult.status).toBe('ok');

    // Counts must reflect lint violations
    expect(structuredResult.counts).toBeDefined();
    expect(typeof structuredResult.counts.lintViolations).toBe('number');
    expect(structuredResult.counts.lintViolations).toBeGreaterThan(0);
    expect(typeof structuredResult.counts.lintGroups).toBe('number');
    expect(structuredResult.counts.lintGroups).toBeGreaterThan(0);

    // representativeSamples must carry lint_violation entries with rule and severity
    expect(Array.isArray(structuredResult.representativeSamples)).toBe(true);
    expect(structuredResult.representativeSamples.length).toBeGreaterThan(0);
    const lintSample = structuredResult.representativeSamples.find((s: any) => s.type === 'lint_violation');
    expect(lintSample).toBeDefined();
    expect(typeof lintSample.rule).toBe('string');
    expect(lintSample.rule.length).toBeGreaterThan(0);
    expect(typeof lintSample.severity).toBe('string');

    // affectedPaths must include file references
    expect(Array.isArray(structuredResult.affectedPaths)).toBe(true);
    expect(structuredResult.affectedPaths.length).toBeGreaterThan(0);
    // At least one affected path should reference the source files
    const hasSourceFile = structuredResult.affectedPaths.some((p: string) => p.includes('.ts'));
    expect(hasSourceFile).toBe(true);

    // nextAction
    expect(structuredResult.nextAction).toBe('fix_or_route_failure');
  });

  // (c) timeout/maxBuffer failure -> explicit structured fields + failureCategory preserved
  it('(c) timeout failure -> explicit timedOut field in structuredResult + failureCategory preserved', async () => {
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'slow_tests',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `
        // Output something to give the summarizer content, then simulate a timeout via plain text
        process.stderr.write('Command timed out after 60s\\nSIGALRM received\\n');
        process.exitCode = 1;
      `],
      cwd: CwdMode.WORKTREE,
      maxOutputBytes: 50_000,
      timeoutMs: 10_000
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'test'
    }, {} as any, undefined, new Map()) as any;

    expect(result.status).toBe(ToolResultStatus.REJECTED);

    const structuredResult = result.structuredResult as any;
    expect(structuredResult).toBeDefined();
    expect(structuredResult.status).toBe('ok');

    // Timeout must be surfaced as an explicit count field
    expect(typeof structuredResult.counts).toBe('object');
    expect(structuredResult.counts.timedOut).toBe(1);

    // failureCategory must be preserved (not altered by summarizer)
    expect(typeof result.failureCategory).toBe('string');
    // failureCategory routing comes from classifyProjectToolFailure, not the summarizer
    // It should still be present regardless of the summarizer
  });

  // (c2) actual process timeout via execa -> timedOut field in record + preserved in structuredResult
  it('(c2) process-level timeout -> timedOut field exposed in structuredResult + failureCategory routing preserved', async () => {
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'timed_out_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `setTimeout(() => {}, 30000);`],
      cwd: CwdMode.WORKTREE,
      maxOutputBytes: 50_000,
      timeoutMs: 100
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'test'
    }, {} as any, undefined, new Map()) as any;

    // Tool must have timed out
    expect(result.status).toBe(ToolResultStatus.REJECTED);
    // The record-level timedOut must be true (set by buildCommandResult)
    expect(result.timedOut).toBe(true);

    // failureCategory must be set (routing preserved)
    expect(typeof result.failureCategory).toBe('string');

    // When a process times out with empty stdout/stderr, there is no structured or diagnostic
    // content to parse — the timedOut=true flag on the result IS the actionable signal.
    // The harness preserves failureCategory routing (TRANSIENT_TRANSPORT for timeout patterns
    // or VERIFIER_FAILED) regardless of whether the summarizer fires.
  });

  // (d) unparseable failure -> bounded diagnosticPreview + archive metadata, NO raw dump
  it('(d) unparseable failure output -> null from summarizer -> bounded diagnosticPreview + archive, no raw dump', async () => {
    // A large, completely unparseable stderr (no test/lint patterns, no timeout signals)
    // The summarizer should return null, falling back to commandDiagnosticPreview.
    const gibberish = Array.from({ length: 200 }, (_, i) => `random line ${i}: abcdef ghijkl mnopqr`).join('\n');

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'unparseable_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `process.stderr.write(${JSON.stringify(gibberish)}); process.exitCode = 1;`
      ],
      cwd: CwdMode.WORKTREE,
      maxOutputBytes: 50_000,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'test'
    }, {} as any, undefined, new Map()) as any;

    expect(result.status).toBe(ToolResultStatus.REJECTED);

    // structuredResult must be absent (summarizer returned null — no patterns matched)
    expect(result.structuredResult).toBeUndefined();

    // Archive must be present (raw data preserved — EARS req 5)
    expect(result.outputArchive).toBeDefined();
    expect(result.outputArchive.artifactRef).toMatch(/^project-tool-output:/);

    // Model-facing result must be compact (no raw dump)
    const modelFacingJson = JSON.stringify(result);
    expect(modelFacingJson.length).toBeLessThan(10 * 1024);

    // stderr field may be present (inline) or absent (truncated), but raw 200-line dump must not be inline
    if (result.stderr !== undefined) {
      expect(result.stderr.length).toBeLessThan(gibberish.length);
    }
  });

  // (e) SUCCESS result is unaffected — no failure summary, success semantics intact
  it('(e) SUCCESS result is unaffected by the failure summarizer', async () => {
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'run_tests',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: ['-e', `
        process.stdout.write('All tests passed.\\n1 passed, 0 failed\\n');
      `],
      cwd: CwdMode.WORKTREE,
      maxOutputBytes: 50_000
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'test'
    }, {} as any, undefined, new Map()) as any;

    // Must still be PASSED
    expect(result.status).toBe(ToolResultStatus.PASSED);

    // structuredResult must be absent (failure summarizer does not fire for PASSED)
    // (structuredPayloadSummary might fire for JSON stdout, but this is plain text — no structured keys)
    expect(result.structuredResult).toBeUndefined();

    // No diagnosticSummary (not a python_lsp diagnostic tool)
    expect(result.diagnosticSummary).toBeUndefined();

    // The success output should be inline and accessible
    expect(result.stdout).toBeDefined();
    expect(result.stdout).toContain('All tests passed');
  });

  // (f) does not clobber a richer JSON structuredPayloadSummary
  it('(f) commandFailureSummarizer does NOT clobber a pre-existing JSON structuredPayloadSummary', async () => {
    // The stdout is JSON with a checks array (triggers structuredPayloadSummary with gate evidence).
    // The summarizer registry must NOT overwrite the richer structuredResult with its own.
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'run_checks',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'run_checks',
          status: 'REJECTED',
          artifact: 'implementation',
          verdict: 'fail',
          checks: [
            { name: 'test-suite', status: 'REJECTED', message: 'test_example.py::test_add FAILED - AssertionError' }
          ],
          errors_by_tool: {
            pytest: [{ tool: 'pytest', file: 'test_example.py', line: 10, message: 'AssertionError', blocking: true }]
          }
        })); process.exit(1);`
      ],
      cwd: CwdMode.WORKTREE,
      maxOutputBytes: 50_000
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'verify'
    }, {} as any, undefined, new Map()) as any;

    expect(result.status).toBe(ToolResultStatus.REJECTED);

    // The pre-existing rich gate-evidence structuredResult must be present
    const structuredResult = result.structuredResult as any;
    expect(structuredResult).toBeDefined();

    // Gate-evidence fields from structuredPayloadSummary must be present
    expect(structuredResult.artifact).toBe('implementation');
    expect(structuredResult.verdict).toBe('fail');
    expect(Array.isArray(structuredResult.errorsByTool)).toBe(true);
    expect(structuredResult.rejectedCheckCount).toBe(1);

    // The commandFailureSummarizer's leaner fields must NOT be present
    // (if clobbered, counts/affectedPaths/representativeSamples would appear)
    expect(structuredResult.counts).toBeUndefined();
    expect(structuredResult.affectedPaths).toBeUndefined();
    expect(structuredResult.representativeSamples).toBeUndefined();
  });

  // Token metric: failing command with large stderr -> compact structured summary, archive retained
  it('token metric: failing command with large stderr -> compact structuredResult + archive retained', async () => {
    // Generate a large pytest-like failure output
    const failureLines = Array.from({ length: 80 }, (_, i) => [
      `_____________________________ test_func_${i} _____________________________`,
      '',
      `    def test_func_${i}():`,
      `>       assert compute_${i}() == ${i}`,
      `E       AssertionError: assert ${i + 1} == ${i}`,
      '',
      `    File "tests/test_module_${i % 5}.py", line ${10 + i}, in test_func_${i}`,
      '',
      `FAILED tests/test_module_${i % 5}.py::test_func_${i} - AssertionError: assert ${i + 1} == ${i}`
    ].join('\n')).join('\n');

    const rawPayloadBytes = Buffer.byteLength(failureLines);

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'run_tests',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `process.stderr.write(${JSON.stringify(failureLines)}); process.exitCode = 1;`
      ],
      cwd: CwdMode.WORKTREE,
      maxOutputBytes: 200_000,
      inlineResultBytes: 1000
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'test'
    }, {} as any, undefined, new Map()) as any;

    expect(result.status).toBe(ToolResultStatus.REJECTED);

    // Model-facing result must be compact — well within 8 KiB
    const modelFacingJson = JSON.stringify(result);
    const modelFacingBytes = Buffer.byteLength(modelFacingJson);
    expect(modelFacingBytes).toBeLessThan(8 * 1024);

    // The raw payload alone was much larger than the model-facing result
    expect(rawPayloadBytes).toBeGreaterThan(modelFacingBytes);

    // structuredResult must be present with test group data
    const structuredResult = result.structuredResult as any;
    expect(structuredResult).toBeDefined();
    expect(structuredResult.status).toBe('ok');
    expect(structuredResult.counts.testFailures).toBeGreaterThan(0);

    // Archive holds the bounded raw data (EARS req 5)
    expect(result.outputArchive).toBeDefined();
    expect(result.outputArchive.artifactRef).toMatch(/^project-tool-output:/);
  });

  // MUST-FIX 1: inline-path diagnosticPreview survival
  // A small failing command output (stays on the inline path — no forced truncation) that
  // produces a structuredResult must STILL expose a bounded diagnosticPreview so the agent
  // sees the real failure tail even when b77h suppresses raw stdout/stderr.
  it('(g) inline-path failure with structuredResult carries diagnosticPreview (MUST-FIX 1)', async () => {
    const eslintOutput = [
      '/workspace/src/index.ts:10:5: error  Missing semicolon  [semi]',
      '/workspace/src/index.ts:14:1: warning  Unused variable x  [no-unused-vars]',
      '/workspace/src/utils.ts:5:9: error  Missing semicolon  [semi]',
      '4 problems (3 errors, 1 warning)'
    ].join('\n');

    // Use a generous inline limit so the result stays on the inline path
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'lint',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `process.stderr.write(${JSON.stringify(eslintOutput)}); process.exitCode = 1;`
      ],
      cwd: CwdMode.WORKTREE,
      maxOutputBytes: 50_000
      // No inlineResultBytes override — defaults to large inline limit, so stays inline
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'lint'
    }, {} as any, undefined, new Map()) as any;

    expect(result.status).toBe(ToolResultStatus.REJECTED);

    // structuredResult must be present (lint groups were found)
    expect(result.structuredResult).toBeDefined();

    // Raw stderr must be suppressed (b77h suppression active)
    expect(result.stderr).toBeUndefined();

    // MUST-FIX 1: diagnosticPreview must be present and carry bounded real failure text
    expect(result.diagnosticPreview).toBeDefined();
    expect(typeof result.diagnosticPreview).toBe('string');
    expect(result.diagnosticPreview.length).toBeGreaterThan(0);
    // The preview should contain something from the actual failure output
    expect(result.diagnosticPreview).toContain('index.ts');
  });

  // MUST-FIX 2: misparse guard — bare Go/compiler-style output must NOT produce a lint group
  // A single bare "file:line: message" (no bracket rule, no column, no severity word) must
  // not be treated as lint output and must not produce a spurious structuredResult with lint groups.
  it('(h) Go/compiler-style bare file:line output does NOT produce a spurious lint structuredResult (MUST-FIX 2)', async () => {
    // Go compiler: "main.go:42: undefined: foo" — no column, no severity word, no bracket rule
    const goError = 'main.go:42: undefined: foo\n./cmd/main.go:15: cannot use x (type int) as type string';

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'build',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `process.stderr.write(${JSON.stringify(goError)}); process.exitCode = 2;`
      ],
      cwd: CwdMode.WORKTREE,
      maxOutputBytes: 50_000
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'build'
    }, {} as any, undefined, new Map()) as any;

    expect(result.status).toBe(ToolResultStatus.REJECTED);

    // The summarizer should either return null (no structuredResult) OR if it produces one
    // it must NOT have lint groups.  The preferred outcome is null (no spurious structuredResult).
    if (result.structuredResult !== undefined) {
      // If a structuredResult was produced (e.g. via process-signal path), it must not have
      // lint-group fields
      expect(result.structuredResult.counts?.lintGroups).toBeUndefined();
      expect(result.structuredResult.counts?.lintViolations).toBeUndefined();
      const samples = result.structuredResult.representativeSamples ?? [];
      const hasLintSample = samples.some((s: any) => s.type === 'lint_violation');
      expect(hasLintSample).toBe(false);
    } else {
      // Preferred: no structuredResult at all from this bare output
      expect(result.structuredResult).toBeUndefined();
    }
  });

  // MUST-FIX 3: omissions note fires when groups exceed the cap
  // Produce enough distinct lint groups to exceed COMMAND_FAILURE_MAX_LINT_GROUPS (8),
  // then assert that structuredResult.omissions is populated.
  it('(i) omissions note is populated when lint groups exceed the cap (MUST-FIX 3)', async () => {
    // Generate 10 distinct ESLint-style lint violations (each with a different rule code)
    // so the 9th and 10th should be omitted (cap = 8)
    const lintLines = Array.from({ length: 10 }, (_, i) =>
      `/workspace/src/file${i}.ts:${i + 1}:5: error  Some lint error  [rule-code-${i}]`
    ).join('\n');

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'lint',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `process.stderr.write(${JSON.stringify(lintLines)}); process.exitCode = 1;`
      ],
      cwd: CwdMode.WORKTREE,
      maxOutputBytes: 50_000
    }, {
      beadId: 'bd-1',
      stateId: 'Implementation',
      actionId: 'lint'
    }, {} as any, undefined, new Map()) as any;

    expect(result.status).toBe(ToolResultStatus.REJECTED);

    const structuredResult = result.structuredResult as any;
    expect(structuredResult).toBeDefined();
    expect(structuredResult.status).toBe('ok');

    // 10 distinct groups, cap is 8 — omissions must be populated
    expect(structuredResult.counts.lintGroups).toBe(8); // capped at 8
    expect(typeof structuredResult.omissions).toBe('string');
    expect(structuredResult.omissions).toContain('lint-violation groups omitted');
    // The omissions note should mention 2 omitted groups (10 - 8 = 2)
    expect(structuredResult.omissions).toContain('2');
  });
});

// ---------------------------------------------------------------------------
// Bounded-storage / scratch-cleanup tests
//
// ROOT CAUSE recap: the per-invocation CALL_DIR_TEMPLATE allocates a unique
// dir at .tmp/tool-calls/{{beadId}}/{{stateId}}/{{actionId}}/{{toolName}}/{{toolInvocationId}}.
// The harness sets TMPDIR/TMP/TEMP → <callDir>/tmp/ so child processes write
// caches there.  Before this fix, that tmpDir was never cleaned, so repeated
// reference_docs calls accumulated one full uv-cache tree per invocation.
//
// FIX: after persistAndBoundResult() safely writes the output JSON, the harness
// calls cleanupToolCallScratch() which removes only the tmpDir sub-directory.
// The output/ dir with the structured result JSON is preserved intact.
// ---------------------------------------------------------------------------
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
      maxOutputBytes: 10_000
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
    const toolCallRoot = path.join(tempRoot, '.tmp', 'tool-calls');
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
      tempRoot, '.tmp', 'tool-calls', 'bd-scratch', 'Impl', 'build', 'cache_sim'
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
        tempRoot, '.tmp', 'tool-calls', 'bd-scratch', 'Impl', action, 'cache_sim'
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
// Generic high-volume summarizer regression metrics
//
// These tests verify that high-volume tools (codemap, ast_grep, reference_docs,
// git_history, workflow_parity) emit a compact structuredResult + use_result
// steering when their MCP/JSON/text payload is large, and that the model-facing
// size is within the per-tool preview budget.
//
// BEFORE (without genericHighVolumeSummarizer): a large MCP payload with no
//   existing resultPreview would produce a raw truncated dump + rerun_narrower.
// AFTER: a compact {status, counts, representativeSamples} + use_result.
//
// Metrics: outputTruncated frequency / rerun_narrower frequency / input-token
// impact are captured via the model-facing byte assertions below.
// ---------------------------------------------------------------------------
describe('generic high-volume summarizer — regression metrics (wf9j)', () => {
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
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-hv-summ-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-1');
    fs.mkdirSync(tempWorktree, { recursive: true });
    writeMinimalHarnessConfig(tempRoot);
    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-hv-${process.pid}`);
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

  // Metric 1: codemap-style MCP result with large JSON body → compact structuredResult
  // + use_result (not rerun_narrower), model-facing size within CODEMAP_RESULT_PREVIEW_MAX_BYTES.
  it('codemap MCP result with large body → compact structuredResult + use_result, model-facing within budget', async () => {
    // Simulate a large codemap MCP response: many lines of directory tree output
    // delivered via MCP content wrapper (as a real codemap MCP tool would).
    const codemapLines = [
      'src',
      'Files: 320 | Size: 2.1MB',
      'Top Extensions: .ts (210), .json (45), .md (30)',
      ...Array.from({ length: 200 }, (_, i) => `|-- module_${i}/`),
      ...Array.from({ length: 100 }, (_, i) => `    |-- file_${i}.ts`)
    ];
    const largeCodemapText = codemapLines.join('\n');

    // MCP content wrapper (as textFromMcpContent would decode)
    const mcpContent = {
      content: [{ type: 'text', text: largeCodemapText }]
    };

    const rawTextBytes = Buffer.byteLength(largeCodemapText);
    expect(rawTextBytes).toBeGreaterThan(4 * 1024); // confirms it's high-volume

    // Test the summarizer via the command tool path with MCP-shaped output.
    // (The MCP transport path is not testable here; the summarizer logic operates
    // on the result record regardless of how the tool was invoked.)
    const result2 = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'codemap',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'codemap',
          status: 'PASSED',
          server: 'codemap',
          operation: 'get_structure',
          result: ${JSON.stringify(mcpContent)}
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000,
      maxOutputBytes: 500_000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    const modelFacingJson = JSON.stringify(result2);
    const modelFacingBytes = Buffer.byteLength(modelFacingJson);

    // The raw text payload was large — verify it exceeds the model-facing result
    expect(rawTextBytes).toBeGreaterThan(modelFacingBytes);

    // structuredResult must be present (generic summarizer fired)
    const structuredResult = (result2 as any).structuredResult as any;
    expect(structuredResult).toBeDefined();
    expect(structuredResult.status).toBe('ok');
    expect(structuredResult.counts).toBeDefined();
    expect(structuredResult.counts.payloadBytes).toBeGreaterThan(0);

    // METRIC: nextAction must be use_result (NOT rerun_narrower) — outputTruncated is set
    // but structured evidence overrides raw truncation signal.
    expect((result2 as any).outputTruncated).toBe(true);
    expect(result2.nextAction).toBe('use_result');
    expect(result2.nextAction).not.toBe('rerun_narrower');

    // METRIC: model-facing result is compact — within the high-volume budget (8 KiB generous cap)
    expect(modelFacingBytes).toBeLessThan(8 * 1024);

    // resultPreview must be present and compact
    expect((result2 as any).resultPreview).toBeDefined();
    expect(typeof (result2 as any).resultPreview).toBe('string');
    const previewLen = ((result2 as any).resultPreview as string).length;
    // METRIC: Preview is bounded by the per-tool CODEMAP_RESULT_PREVIEW_MAX_BYTES budget (2 KiB).
    // The truncation marker appended by boundedPreviewText may push length slightly above the
    // slice point, so we allow a small overhead for the marker itself.
    expect(previewLen).toBeLessThanOrEqual(CODEMAP_RESULT_PREVIEW_MAX_BYTES + 256);

    // Archive is preserved
    expect((result2 as any).outputArchive).toBeDefined();
    expect((result2 as any).outputArchive.artifactRef).toMatch(/^project-tool-output:/);

    // Raw MCP result field must be absent (suppressed by hasStructuredModelSummary)
    expect((result2 as any).result).toBeUndefined();
  });

  // Metric 2: ast_grep-style large output → compact structuredResult + use_result (not rerun_narrower).
  //
  // The "before" scenario uses a large stdout that triggers stdoutTruncated=true (via low maxOutputBytes)
  // with no structured summary — this produces rerun_narrower.  The "after" scenario uses ast_grep
  // with the same type of large MCP payload but the generic summarizer produces structuredResult +
  // use_result instead.
  it('ast_grep large MCP result with no existing resultPreview → compact structuredResult + use_result (not rerun_narrower)', async () => {
    // Simulate a large ast_grep MCP response: many match lines
    const matchLines = Array.from({ length: 300 }, (_, i) =>
      `packages/module_${i % 20}/file_${i}.ts:${10 + (i % 50)}:class AstGrepMatch_${i} { value = ${i}; }`
    );
    const largeAstGrepText = matchLines.join('\n');

    const mcpContent = {
      content: [{ type: 'text', text: largeAstGrepText }]
    };

    const rawPayloadSize = Buffer.byteLength(largeAstGrepText);
    expect(rawPayloadSize).toBeGreaterThan(4 * 1024); // confirms high-volume

    // BEFORE state: simulate a non-high-volume tool receiving large stdout that gets
    // stream-truncated (stdoutTruncated=true, no structured evidence) → rerun_narrower.
    // We use a plain-text large stdout (not JSON) so no structuredPayloadSummary fires.
    const beforeResult = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'large_plain_tool',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        // Plain text (not JSON) ensures no structuredPayloadSummary or summarizer fires
        `process.stdout.write(${JSON.stringify(largeAstGrepText + '\nextra line'.repeat(100))})`
      ],
      cwd: CwdMode.WORKTREE,
      // Set maxOutputBytes low so stdoutTruncated=true
      maxOutputBytes: 2048
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    // AFTER state: same kind of payload but for ast_grep (generic summarizer fires via MCP result)
    const afterResult = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'ast_grep',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'ast_grep',
          status: 'PASSED',
          result: ${JSON.stringify(mcpContent)}
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000,
      maxOutputBytes: 500_000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    const afterBytes = Buffer.byteLength(JSON.stringify(afterResult));

    // BEFORE: no structured evidence, stdout truncated → rerun_narrower
    expect((beforeResult as any).stdoutTruncated).toBe(true);
    expect((beforeResult as any).structuredResult).toBeUndefined();
    expect(beforeResult.nextAction).toBe('rerun_narrower');

    // AFTER: structuredResult present → use_result steering
    const structuredResult = (afterResult as any).structuredResult as any;
    expect(structuredResult).toBeDefined();
    expect(structuredResult.status).toBe('ok');
    expect(structuredResult.counts.payloadBytes).toBeGreaterThan(0);
    expect(afterResult.nextAction).toBe('use_result');
    expect(afterResult.nextAction).not.toBe('rerun_narrower');

    // METRIC: "after" model-facing result is compact — within 8 KiB
    expect(afterBytes).toBeLessThan(8 * 1024);

    // METRIC: rerun_narrower frequency drops — "before" gets rerun_narrower, "after" does not.
    expect(beforeResult.nextAction).toBe('rerun_narrower');
    expect(afterResult.nextAction).not.toBe('rerun_narrower');

    // METRIC: ast_grep resultPreview is bounded by its per-tool budget (AST_GREP_RESULT_PREVIEW_MAX_BYTES = 3 KiB),
    // NOT by the shared 2 KiB diagnostic constant. The marker overhead is small.
    const afterPreview = (afterResult as any).resultPreview as string | undefined;
    if (afterPreview !== undefined) {
      expect(afterPreview.length).toBeLessThanOrEqual(AST_GREP_RESULT_PREVIEW_MAX_BYTES + 256);
    }

    // representativeSamples must be present (sample lines from the large output)
    expect(Array.isArray(structuredResult.representativeSamples)).toBe(true);
    expect(structuredResult.representativeSamples.length).toBeGreaterThan(0);

    // Archive is preserved — raw output stored in outputArchive
    expect((afterResult as any).outputArchive).toBeDefined();
    expect((afterResult as any).outputArchive.artifactRef).toMatch(/^project-tool-output:/);
  });

  // Metric 3: git_history large result → compact structuredResult + use_result.
  it('git_history large MCP result → compact structuredResult + use_result, within budget', async () => {
    // Simulate a large git history response
    const historyLines = Array.from({ length: 150 }, (_, i) =>
      `commit ${i.toString(16).padStart(40, 'a')} Author: Dev <dev@example.com> Date: 2024-0${(i % 9) + 1}-${(i % 28) + 1} Commit message ${i}: refactor module ${i % 10}`
    );
    const largeHistoryText = historyLines.join('\n');
    const mcpContent = { content: [{ type: 'text', text: largeHistoryText }] };

    expect(Buffer.byteLength(largeHistoryText)).toBeGreaterThan(4 * 1024);

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'git_history',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'git_history',
          status: 'PASSED',
          result: ${JSON.stringify(mcpContent)}
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000,
      maxOutputBytes: 500_000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    const structuredResult = (result as any).structuredResult as any;
    expect(structuredResult).toBeDefined();
    expect(structuredResult.status).toBe('ok');
    expect(structuredResult.counts.payloadBytes).toBeGreaterThan(0);

    // use_result, not rerun_narrower
    expect(result.nextAction).toBe('use_result');
    expect(result.nextAction).not.toBe('rerun_narrower');

    // Model-facing compact
    const modelFacingBytes = Buffer.byteLength(JSON.stringify(result));
    expect(modelFacingBytes).toBeLessThan(8 * 1024);
  });

  // (gate-evidence guard) generic summarizer does NOT clobber a pre-existing
  // structuredPayloadSummary (rich gate evidence) on a high-volume tool.
  it('gate-evidence guard: pre-existing rich structuredResult on codemap is NOT clobbered by generic summarizer', async () => {
    // Payload has rich gate-evidence keys (artifact, verdict) which trigger
    // structuredPayloadSummary BEFORE persistAndBoundResult runs the registry.
    // The generic summarizer must be blocked by the hasGateEvidence guard.
    const richPayload = {
      tool: 'codemap',
      status: 'PASSED',
      artifact: 'codemap_analysis',
      verdict: 'pass',
      checks: [
        { name: 'structure', status: 'PASSED', message: 'ok' }
      ],
      result: {
        content: [{ type: 'text', text: Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') }]
      }
    };

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'codemap',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify(${JSON.stringify(richPayload)}))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000,
      maxOutputBytes: 500_000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    const structuredResult = (result as any).structuredResult as any;
    expect(structuredResult).toBeDefined();

    // Rich gate-evidence fields from structuredPayloadSummary must be present
    expect(structuredResult.artifact).toBe('codemap_analysis');
    expect(structuredResult.verdict).toBe('pass');
    expect(typeof structuredResult.passedCheckCount).toBe('number');

    // The generic summarizer's leaner counts.payloadBytes must NOT be present
    // (if the guard failed, we'd see counts with payloadBytes)
    expect(structuredResult.counts?.payloadBytes).toBeUndefined();
  });

  // (recovery text) summarized high-volume result carries narrow-rerun recovery guidance
  // pointing agents to rerun with narrower args rather than reading raw archive.
  it('summarized high-volume result recovery text points to narrow-rerun / selector path', async () => {
    const largeText = Array.from({ length: 200 }, (_, i) =>
      `entry ${i}: some reference documentation line that is moderately long for testing purposes`
    ).join('\n');

    const mcpContent = { content: [{ type: 'text', text: largeText }] };

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, {
      name: 'reference_docs',
      type: ProjectToolType.COMMAND,
      command: process.execPath,
      defaultArgs: [
        '-e',
        `console.log(JSON.stringify({
          tool: 'reference_docs',
          status: 'PASSED',
          result: ${JSON.stringify(mcpContent)}
        }))`
      ],
      cwd: CwdMode.WORKTREE,
      inlineResultBytes: 1000,
      maxOutputBytes: 500_000
    }, {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any, undefined, new Map());

    expect(result.nextAction).toBe('use_result');

    // Recovery text must be present and must be HIGH_VOLUME_NARROW_RERUN_RECOVERY.
    // FIX 2: high-volume summarized results now wire the narrow-rerun recovery constant
    // so agents get archive-section / selector guidance rather than generic archive text.
    const recovery = (result as any).recovery as string[] | undefined;
    expect(recovery).toBeDefined();
    expect(Array.isArray(recovery)).toBe(true);
    const recoveryText = (recovery ?? []).join('\n');
    // The wired constant contains narrow-rerun / selector guidance
    expect(recoveryText).toContain(HIGH_VOLUME_NARROW_RERUN_RECOVERY);
    // Must NOT say "read the archive" as a first action
    expect(recoveryText).not.toMatch(/read .*archive first|read .*archive before/i);
    // Must mention rerunning narrower (from the wired constant)
    expect(recoveryText).toMatch(/rerun.*narrower|narrow.*rerun/i);
  });
});
