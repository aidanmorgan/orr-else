import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactPaths } from '../src/core/ArtifactPaths.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { FileAccessPolicy } from '../src/core/FileAccessPolicy.js';
import { PlanWriteSet } from '../src/core/PlanWriteSet.js';
import { ShellCommandParser } from '../src/core/ShellCommandParser.js';
import { DomainEventName, EnvVars, FileMutationPolicyDefaults, NativePiToolName, ProcessFlag } from '../src/constants/index.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('PlanWriteSet preflight validation', () => {
  let tempRoot: string;
  let configLoader: ConfigLoader;
  let artifactPaths: ArtifactPaths;
  let planWriteSet: PlanWriteSet;

  function writeFile(relativePath: string, content: string): void {
    const target = path.join(tempRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  function context() {
    return {
      beadId: 'bd-1',
      stateId: 'Planning',
      worktreePath: tempRoot,
      projectRoot: tempRoot
    };
  }

  beforeEach(() => {
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-plan-write-set-')));
    fs.mkdirSync(path.join(tempRoot, '.pi/artifacts/bd-1'), { recursive: true });
    writeFile('harness.yaml', `
settings:
  startState: Planning
  transactionalState:
    enabled: true
    requireWriteSet: true
  artifacts:
    baseDir: .pi/artifacts
    templates:
      planContract: .pi/artifacts/{{beadId}}/plan-contract.json
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions: []
    transitions: { SUCCESS: "Implementation", FAILURE: "Planning" }
  Implementation:
    identity: { role: "Builder", expertise: "Implementation", constraints: [] }
    baseInstructions: "Build"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Implementation" }
`);
    git(tempRoot, ['init', '--initial-branch=main']);
    configLoader = new ConfigLoader(undefined, tempRoot);
    artifactPaths = new ArtifactPaths(configLoader, undefined, tempRoot);
    planWriteSet = new PlanWriteSet(configLoader, artifactPaths, tempRoot);
  });

  afterEach(() => {
    configLoader.reset();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('rejects ignored new write-set paths with the owning ignore rule', async () => {
    writeFile('.gitignore', 'generated/\nreference/\npackages/cerdiwen-foundation/tests/unit/pli/\n');

    const result = await planWriteSet.validateProposedPlanContract(JSON.stringify({
      writeSet: [
        { path: 'reference/ibm/language-reference/conditions-pending-condition.md' },
        { path: 'generated/new-output.json' },
        { path: 'packages/cerdiwen-foundation/tests/unit/pli/test_fixed_binary_byte_size.py' }
      ]
    }), context());

    expect(result.passed).toBe(false);
    expect(result.ignoredWriteSetPaths.map(entry => entry.path)).toEqual([
      'generated/new-output.json',
      'packages/cerdiwen-foundation/tests/unit/pli/test_fixed_binary_byte_size.py',
      'reference/ibm/language-reference/conditions-pending-condition.md'
    ]);
    expect(result.ignoredWriteSetPaths[0]).toMatchObject({
      source: '.gitignore',
      line: 1,
      pattern: 'generated/'
    });
    expect(result.ignoredWriteSetPaths[1]).toMatchObject({
      source: '.gitignore',
      line: 3,
      pattern: 'packages/cerdiwen-foundation/tests/unit/pli/'
    });
    expect(result.ignoredWriteSetPaths[2]).toMatchObject({
      source: '.gitignore',
      line: 2,
      pattern: 'reference/'
    });
    expect(result.reason).toContain('generated/new-output.json (.gitignore:1:generated/)');
    expect(result.reason).toContain('packages/cerdiwen-foundation/tests/unit/pli/test_fixed_binary_byte_size.py (.gitignore:3:packages/cerdiwen-foundation/tests/unit/pli/)');
    expect(result.reason).toContain('reference/ibm/language-reference/conditions-pending-condition.md (.gitignore:2:reference/)');
  });

  it('allows tracked files that match ignore patterns and existing allowed paths', async () => {
    writeFile('.gitignore', 'generated/\nreference/\n');
    writeFile('generated/tracked-output.json', '{}\n');
    writeFile('reference/tracked-reference.md', '# tracked\n');
    writeFile('src/existing.ts', 'export const value = 1;\n');
    git(tempRoot, ['add', '.gitignore', 'src/existing.ts']);
    git(tempRoot, ['add', '-f', 'generated/tracked-output.json', 'reference/tracked-reference.md']);

    const result = await planWriteSet.validateProposedPlanContract(JSON.stringify({
      writeSet: [
        { path: 'generated/tracked-output.json' },
        { path: 'reference/tracked-reference.md' },
        { path: 'src/existing.ts' }
      ]
    }), context());

    expect(result.passed).toBe(true);
    expect(result.ignoredWriteSetPaths).toEqual([]);
  });

  it('rejects ignored package test paths from live planning failures', async () => {
    writeFile('.gitignore', [
      'packages/ceridwen-compiler/tests/',
      'packages/ceridwen-runtime/tests/unit/host/'
    ].join('\n'));

    const liveFailurePaths = [
      'packages/ceridwen-compiler/tests/acceptance/test_locate_statement.py',
      'packages/ceridwen-compiler/tests/unit/codegen/emitters/statements/test_locate_codegen_boundary.py',
      'packages/ceridwen-compiler/tests/unit/parser/test_locate_statement.py',
      'packages/ceridwen-compiler/tests/unit/semantic/test_locate_normalization.py',
      'packages/ceridwen-runtime/tests/unit/host/test_locate_host_functions.py'
    ];

    const result = await planWriteSet.validateProposedPlanContract(JSON.stringify({
      writeSet: liveFailurePaths.map(pathName => ({ path: pathName }))
    }), context());

    expect(result.passed).toBe(false);
    expect(result.ignoredWriteSetPaths.map(entry => entry.path)).toEqual(liveFailurePaths);
    expect(result.reason).toContain('packages/ceridwen-compiler/tests/acceptance/test_locate_statement.py (.gitignore:1:packages/ceridwen-compiler/tests/)');
    expect(result.reason).toContain('packages/ceridwen-runtime/tests/unit/host/test_locate_host_functions.py (.gitignore:2:packages/ceridwen-runtime/tests/unit/host/)');
  });

  it('allows existing untracked paths that are not ignored', async () => {
    writeFile('.gitignore', 'generated/\n');
    writeFile('docs/existing-note.md', '# existing\n');

    const result = await planWriteSet.validateProposedPlanContract(JSON.stringify({
      writeSet: [{ path: 'docs/existing-note.md' }]
    }), context());

    expect(result.passed).toBe(true);
    expect(result.ignoredWriteSetPaths).toEqual([]);
  });

  it('rejects native plan-contract mutations before the artifact is recorded', async () => {
    const previousCwd = process.cwd();
    const previousEnv = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    writeFile('.gitignore', 'generated/\n');
    const eventStore = new EventStore(configLoader);
    const policy = new FileAccessPolicy(eventStore, new ShellCommandParser(), planWriteSet);

    try {
      process.chdir(tempRoot);
      process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
      process.env[EnvVars.BEAD_ID] = 'bd-1';
      process.env[EnvVars.STATE_ID] = 'Planning';
      process.env[EnvVars.PROJECT_ROOT] = tempRoot;
      process.env[EnvVars.WORKTREE_PATH] = tempRoot;

      const editResult = await policy.apply({
        toolName: NativePiToolName.EDIT,
        toolCallId: 'edit-plan-contract',
        input: {
          filePath: path.join(tempRoot, '.pi/artifacts/bd-1/plan-contract.json'),
          oldString: '{}',
          newString: JSON.stringify({ writeSet: [{ path: 'generated/new-output.json' }] })
        }
      });
      const result = await policy.apply({
        toolName: NativePiToolName.WRITE,
        toolCallId: 'write-plan-contract',
        input: {
          path: path.join(tempRoot, '.pi/artifacts/bd-1/plan-contract.json'),
          content: JSON.stringify({ writeSet: [{ path: 'generated/new-output.json' }] })
        }
      });
      const nonPlanContractEdit = await policy.apply({
        toolName: NativePiToolName.EDIT,
        toolCallId: 'edit-non-plan-contract',
        input: {
          filePath: path.join(tempRoot, '.pi/artifacts/bd-1/review-notes.json'),
          oldString: '{}',
          newString: '{"ok":true}'
        }
      });

      expect(editResult?.rejection).toContain('may only replace a plan contract with a full `write` payload');
      expect(editResult?.nextAction).toBe('replace_plan_contract_with_full_write');
      expect(editResult?.recovery).toEqual(expect.arrayContaining([
        expect.stringContaining('complete plan-contract JSON'),
        expect.stringContaining('validate the full write set'),
        expect.stringContaining('Do not retry a partial edit or patch')
      ]));
      expect(result?.rejection).toContain('attempted to record a plan contract with unmergeable write-set paths');
      expect(result?.rejection).toContain('generated/new-output.json (.gitignore:1:generated/)');
      expect(nonPlanContractEdit).toBeNull();
      expect(fs.existsSync(path.join(tempRoot, '.pi/artifacts/bd-1/plan-contract.json'))).toBe(false);

      const events = await eventStore.readAll();
      expect(events.some(event => event.type === DomainEventName.FILE_MUTATION_REJECTED)).toBe(true);
    } finally {
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
    }
  });
});

describe('FileAccessPolicy validateShellTarget — WRITE vs DELETE operation labels', () => {
  let tempRoot: string;
  let policy: FileAccessPolicy;
  let recordedEvents: Array<{ eventName: string; data: unknown }>;

  beforeEach(() => {
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-shell-label-')));

    recordedEvents = [];
    // Use a stub EventStore so no real file I/O occurs during label assertions.
    const stubEventStore = {
      record: vi.fn(async (eventName: string, data: unknown) => {
        recordedEvents.push({ eventName, data });
      })
    } as unknown as EventStore;

    // PlanWriteSet requires a real ConfigLoader to resolve the write-set; use a stub that
    // passes all mutations so the label-assertion path is reached.
    const stubPlanWriteSet = {
      validateMutationTarget: vi.fn(async () => ({ passed: true })),
      isPlanContractPath: vi.fn(async () => false),
      validateProposedPlanContract: vi.fn(async () => ({ passed: true }))
    } as unknown as PlanWriteSet;

    policy = new FileAccessPolicy(stubEventStore, new ShellCommandParser(), stubPlanWriteSet, undefined, tempRoot);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function withWorkerEnv<T>(fn: () => Promise<T>): Promise<T> {
    const saved = {
      workerMode: process.env[EnvVars.WORKER_MODE],
      beadId: process.env[EnvVars.BEAD_ID],
      stateId: process.env[EnvVars.STATE_ID],
      projectRoot: process.env[EnvVars.PROJECT_ROOT],
      worktreePath: process.env[EnvVars.WORKTREE_PATH]
    };
    process.env[EnvVars.WORKER_MODE] = ProcessFlag.TRUE;
    process.env[EnvVars.BEAD_ID] = 'bd-label-test';
    process.env[EnvVars.STATE_ID] = 'Planning';
    process.env[EnvVars.PROJECT_ROOT] = tempRoot;
    process.env[EnvVars.WORKTREE_PATH] = tempRoot;
    return fn().finally(() => {
      if (saved.workerMode === undefined) delete process.env[EnvVars.WORKER_MODE];
      else process.env[EnvVars.WORKER_MODE] = saved.workerMode;
      if (saved.beadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = saved.beadId;
      if (saved.stateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = saved.stateId;
      if (saved.projectRoot === undefined) delete process.env[EnvVars.PROJECT_ROOT];
      else process.env[EnvVars.PROJECT_ROOT] = saved.projectRoot;
      if (saved.worktreePath === undefined) delete process.env[EnvVars.WORKTREE_PATH];
      else process.env[EnvVars.WORKTREE_PATH] = saved.worktreePath;
    });
  }

  it('records WRITE operation label for shell mutation targets (applyShellMutationPolicy path)', async () => {
    const target = path.join(tempRoot, 'src/output.txt');
    await withWorkerEnv(() =>
      policy.apply({
        toolName: NativePiToolName.BASH,
        toolCallId: 'bash-write-1',
        input: { command: `tee ${target}` }
      })
    );

    const accessAttempts = recordedEvents.filter(e => e.eventName === DomainEventName.FILE_ACCESS_ATTEMPTED);
    expect(accessAttempts.length).toBeGreaterThan(0);
    expect(accessAttempts.every(e => (e.data as any).operation === FileMutationPolicyDefaults.WRITE_OPERATION)).toBe(true);
    expect(accessAttempts.some(e => (e.data as any).operation === FileMutationPolicyDefaults.DELETE_OPERATION)).toBe(false);
  });

  it('records DELETE operation label for shell deletion targets (convertDeletion path)', async () => {
    const target = path.join(tempRoot, 'src/old-file.txt');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'content');

    await withWorkerEnv(() =>
      policy.apply({
        toolName: NativePiToolName.BASH,
        toolCallId: 'bash-delete-1',
        input: { command: `rm ${target}` }
      })
    );

    const accessAttempts = recordedEvents.filter(e => e.eventName === DomainEventName.FILE_ACCESS_ATTEMPTED);
    expect(accessAttempts.length).toBeGreaterThan(0);
    expect(accessAttempts.every(e => (e.data as any).operation === FileMutationPolicyDefaults.DELETE_OPERATION)).toBe(true);
    expect(accessAttempts.some(e => (e.data as any).operation === FileMutationPolicyDefaults.WRITE_OPERATION)).toBe(false);
  });
});
