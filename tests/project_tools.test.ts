import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { ToolCallPathFactory } from '../src/core/ToolCallPathFactory.js';
import { getProjectRoot, setProjectRoot } from '../src/core/Paths.js';
import { CommandErrorCode, CwdMode, EnvVars, ProjectToolType, ToolResultStatus } from '../src/constants/index.js';
import type { ProjectCommandToolConfig } from '../src/core/domain/StateModels.js';
import { describeConfiguredProjectTools, executeConfiguredProjectTool, isAcceptedMaxBufferFailure, isSuccessfulCommandExitCode, normalizeCommandArguments } from '../src/plugins/projectTools.js';

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
    enabled: false
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
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let toolCallPathFactory: ToolCallPathFactory;

  beforeEach(() => {
    previousRoot = getProjectRoot();
    previousProjectRootEnv = process.env[EnvVars.PROJECT_ROOT];
    previousWorktreeEnv = process.env[EnvVars.WORKTREE_PATH];
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
    eventStore.setSessionId(`test-${process.pid}-reset`);
    if (previousProjectRootEnv === undefined) delete process.env[EnvVars.PROJECT_ROOT];
    else process.env[EnvVars.PROJECT_ROOT] = previousProjectRootEnv;
    if (previousWorktreeEnv === undefined) delete process.env[EnvVars.WORKTREE_PATH];
    else process.env[EnvVars.WORKTREE_PATH] = previousWorktreeEnv;
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
          usageNotes: ['Returned ids are Chroma document ids, not filesystem paths.']
        }
      ]
    } as any);

    expect(description).toContain('query -> chroma_query_documents');
    expect(description).toContain('get -> chroma_get_documents');
    expect(description).toContain('query(collection_name, query_texts)');
    expect(description).toContain('get(collection_name, ids)');
    expect(description).toContain('query defaults {"collection_name":"reference_docs"}');
    expect(description).toContain('Returned ids are Chroma document ids, not filesystem paths.');
  });

  it('isolates generated files under project .tmp by bead, state, action, tool, and invocation', async () => {
    const result = await executeConfiguredProjectTool(eventStore, toolCallPathFactory, envProbeTool(CwdMode.WORKTREE), {
      beadId: 'bd-1',
      stateId: 'Planning',
      actionId: 'analyze'
    }, {} as any);

    expect(result.status).toBe(ToolResultStatus.PASSED);
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
