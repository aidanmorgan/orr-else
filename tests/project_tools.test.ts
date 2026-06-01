import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { ToolCallPathFactory } from '../src/core/ToolCallPathFactory.js';
import { getProjectRoot, setProjectRoot } from '../src/core/Paths.js';
import { CommandErrorCode, CwdMode, DomainEventName, EnvVars, EventName, ProjectToolDefaults, ProjectToolType, TeammateEventType, ToolResultStatus } from '../src/constants/index.js';
import type { ProjectCommandToolConfig, ProjectMcpToolConfig } from '../src/core/domain/StateModels.js';
import { classifyProjectToolFailure, describeConfiguredProjectTools, executeConfiguredProjectTool, isAcceptedMaxBufferFailure, isSuccessfulCommandExitCode, mcpToolRequestTimeoutMs, normalizeCommandArguments, normalizeMcpPathArguments, ProjectToolFailureCategory, projectToolFailureLimitSuggestedOutcome, shouldSerializeMcpTool } from '../src/plugins/projectTools.js';

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
  let previousRoot: string;
  let previousProjectRootEnv: string | undefined;
  let previousWorktreeEnv: string | undefined;
  let previousFrameworkRootEnv: string | undefined;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let toolCallPathFactory: ToolCallPathFactory;

  beforeEach(() => {
    previousRoot = getProjectRoot();
    previousProjectRootEnv = process.env[EnvVars.PROJECT_ROOT];
    previousWorktreeEnv = process.env[EnvVars.WORKTREE_PATH];
    previousFrameworkRootEnv = process.env[EnvVars.FRAMEWORK_ROOT];
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-project-tools-')));
    tempWorktree = path.join(tempRoot, 'worktrees', 'bd-1');
    fs.mkdirSync(tempWorktree, { recursive: true });
    writeMinimalHarnessConfig(tempRoot);
    setProjectRoot(tempRoot);
    configLoader = new ConfigLoader();
    eventStore = new EventStore(configLoader);
    toolCallPathFactory = new ToolCallPathFactory();
    eventStore.setSessionId(`test-${process.pid}`);
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempWorktree;
  });

  afterEach(() => {
    setProjectRoot(previousRoot);
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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

    expect(result.status).toBe(ToolResultStatus.PASSED);
    expect(result.matchStatus).toBe('no_match');
    expect(result.message).toContain('ast_grep found no matches');
    expect(result.nextAction).toBe('record_no_match');
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
    }, {} as any);

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
    }, {} as any);

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
    const first = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);
    const second = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);

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

    const first = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);
    const second = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);

    expect(first).toMatchObject({ tool: 'pytest', status: ToolResultStatus.REJECTED });
    expect(second).toMatchObject({ tool: 'pytest', status: ToolResultStatus.REJECTED });
    expect((first as any).failureLimit).toBeUndefined();
    expect((second as any).failureLimit).toBeUndefined();
  });

  it('backpressures concurrent configured project-tool invocations for the same worker action', async () => {
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
      executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any),
      executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any),
      executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any)
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

    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);

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
    await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);
    const terminalRetry = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);
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
    const restartedRetry = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);
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
    await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);
    const terminalRetry = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);
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
    const freshRunFailure = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);
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
    await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);
    const terminalRetry = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);
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
    const freshRunFailure = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);

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
    await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);
    const second = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);

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

    const first = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);
    const second = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, tool, context, {} as any);

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
    }, {} as any);

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

  it('leaves normal artifact_validator output unchanged when no unsupported output-control flag is present', async () => {
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
    }, {} as any);

    expect(result).toMatchObject({
      tool: 'artifact_validator',
      status: ToolResultStatus.PASSED,
      stdout: payload,
      stderr: '',
      stdoutBytes: Buffer.byteLength(payload),
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      maxBufferExceeded: false,
      nextAction: 'use_result'
    });
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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);

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
    }, {} as any);
    const second = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, envProbeTool(CwdMode.WORKTREE), {
      beadId: 'bd-3',
      stateId: 'Planning',
      actionId: 'repeat'
    }, {} as any);

    const firstPayload = JSON.parse(first.stdout);
    const secondPayload = JSON.parse(second.stdout);

    expect(firstPayload[EnvProbeField.TOOL_INVOCATION_ID]).not.toBe(secondPayload[EnvProbeField.TOOL_INVOCATION_ID]);
    expect(firstPayload[EnvProbeField.CALL_DIR]).not.toBe(secondPayload[EnvProbeField.CALL_DIR]);
    expect(firstPayload[EnvProbeField.OUTPUT_FILE]).not.toBe(secondPayload[EnvProbeField.OUTPUT_FILE]);
    expect(firstPayload[EnvProbeField.OUTPUT_FILE]).toContain(path.join(tempRoot, '.tmp/tool-calls/bd-3/Planning/repeat/env_probe'));
    expect(secondPayload[EnvProbeField.OUTPUT_FILE]).toContain(path.join(tempRoot, '.tmp/tool-calls/bd-3/Planning/repeat/env_probe'));
  });
});
