import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { createGitPlugin } from '../src/plugins/git.js';
import { PluginToolName } from '../src/constants/index.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

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

describe('git plugin merge finalization', () => {
  let tempRoot: string;
  let previousCwd: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-git-plugin-')));
    writeMinimalHarnessConfig(tempRoot);
    git(tempRoot, ['init', '-b', 'main']);
    git(tempRoot, ['config', 'user.name', 'Orr Else']);
    git(tempRoot, ['config', 'user.email', 'orr-else@example.invalid']);
    fs.mkdirSync(path.join(tempRoot, '.beads'));
    fs.writeFileSync(path.join(tempRoot, 'source.txt'), 'before\n');
    fs.writeFileSync(path.join(tempRoot, '.gitignore'), '.beads/issues.jsonl\n');
    git(tempRoot, ['add', 'source.txt', '.gitignore']);
    git(tempRoot, ['commit', '-m', 'initial']);
    process.chdir(tempRoot);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates a fresh bead worktree when the bead branch does not exist yet', async () => {
    const configLoader = new ConfigLoader();
    const eventStore = new EventStore(configLoader);
    const plugin = createGitPlugin(eventStore, configLoader);
    const createTool = plugin.tools.find(tool => tool.name === PluginToolName.CREATE_WORKTREE)!;

    const result = await createTool.execute({ beadId: 'bd-new' });
    const worktreePath = path.join(tempRoot, 'worktrees', 'bd-new');

    expect(result).toMatchObject({ success: true, path: worktreePath });
    expect(fs.existsSync(path.join(worktreePath, 'source.txt'))).toBe(true);
    expect(git(worktreePath, ['branch', '--show-current'])).toBe('bead/bd-new\n');
    expect(git(tempRoot, ['show-ref', '--verify', 'refs/heads/bead/bd-new'])).toContain('refs/heads/bead/bd-new');
  });

  it('unstages pre-existing index changes before merging a completed bead branch', async () => {
    const worktreePath = path.join(tempRoot, 'worktrees', 'bd-1');
    git(tempRoot, ['worktree', 'add', '-b', 'bead/bd-1', worktreePath, 'main']);
    fs.writeFileSync(path.join(worktreePath, 'source.txt'), 'after\n');

    fs.writeFileSync(path.join(tempRoot, 'other.txt'), 'staged-on-main\n');
    git(tempRoot, ['add', 'other.txt']);
    expect(git(tempRoot, ['status', '--porcelain', '--', 'other.txt'])).toBe('A  other.txt\n');

    const configLoader = new ConfigLoader();
    const eventStore = new EventStore(configLoader);
    const plugin = createGitPlugin(eventStore, configLoader);
    const mergeTool = plugin.tools.find(tool => tool.name === PluginToolName.MERGE_AND_COMMIT)!;

    const result = await mergeTool.execute({ beadId: 'bd-1', message: 'Complete bd-1' });

    expect(result).toMatchObject({ success: true });
    expect(fs.readFileSync(path.join(tempRoot, 'source.txt'), 'utf8')).toBe('after\n');
    expect(git(tempRoot, ['status', '--porcelain', '--', 'other.txt'])).toBe('?? other.txt\n');
    expect(git(tempRoot, ['log', '-1', '--pretty=%B'])).toContain('Complete bd-1');
  });

  it('closeAfterMerge updates the bead via bd and commits the merge without touching the JSONL export', async () => {
    const worktreePath = path.join(tempRoot, 'worktrees', 'bd-1');
    git(tempRoot, ['worktree', 'add', '-b', 'bead/bd-1', worktreePath, 'main']);
    fs.writeFileSync(path.join(worktreePath, 'source.txt'), 'after\n');

    const closeCalls: Array<{ id: string; status: string; notes?: string }> = [];
    const configLoader = new ConfigLoader();
    const eventStore = new EventStore(configLoader);
    const bdPlugin = {
      name: 'bd-test',
      tools: [{
        name: PluginToolName.BD_UPDATE_STATUS,
        execute: async ({ id, status, notes }: { id: string; status: string; notes?: string }) => {
          closeCalls.push({ id, status, notes });
          return { id, status, notes };
        }
      }]
    };
    const plugin = createGitPlugin(eventStore, configLoader, bdPlugin);
    const mergeTool = plugin.tools.find(tool => tool.name === PluginToolName.MERGE_AND_COMMIT)!;

    const result = await mergeTool.execute({
      beadId: 'bd-1',
      message: 'Complete bd-1',
      closeAfterMerge: true,
      closeReason: 'Done'
    });

    expect(result).toMatchObject({ success: true });
    expect(closeCalls).toEqual([{ id: 'bd-1', status: 'completed', notes: 'Done' }]);
    expect(git(tempRoot, ['show', 'HEAD:source.txt'])).toBe('after\n');
    expect(git(tempRoot, ['show', '--name-only', '--pretty=', 'HEAD'])).not.toContain('.beads/issues.jsonl');
  });

  it('does not close the bead and aborts the target merge when conflicts remain', async () => {
    const worktreePath = path.join(tempRoot, 'worktrees', 'bd-1');
    git(tempRoot, ['worktree', 'add', '-b', 'bead/bd-1', worktreePath, 'main']);
    fs.writeFileSync(path.join(worktreePath, 'source.txt'), 'branch\n');

    fs.writeFileSync(path.join(tempRoot, 'source.txt'), 'main\n');
    git(tempRoot, ['add', 'source.txt']);
    git(tempRoot, ['commit', '-m', 'main change']);

    const closeCalls: Array<{ id: string; status: string; notes?: string }> = [];
    const configLoader = new ConfigLoader();
    const eventStore = new EventStore(configLoader);
    const bdPlugin = {
      name: 'bd-test',
      tools: [{
        name: PluginToolName.BD_UPDATE_STATUS,
        execute: async ({ id, status, notes }: { id: string; status: string; notes?: string }) => {
          closeCalls.push({ id, status, notes });
          return { id, status, notes };
        }
      }]
    };
    const plugin = createGitPlugin(eventStore, configLoader, bdPlugin);
    const mergeTool = plugin.tools.find(tool => tool.name === PluginToolName.MERGE_AND_COMMIT)!;

    const result = await mergeTool.execute({
      beadId: 'bd-1',
      message: 'Complete bd-1',
      closeAfterMerge: true,
      closeReason: 'Done'
    });

    expect(result).toMatchObject({ success: false });
    expect(closeCalls).toEqual([]);
    expect(git(tempRoot, ['diff', '--name-only', '--diff-filter=U'])).toBe('');
    expect(git(tempRoot, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
    expect(fs.readFileSync(path.join(tempRoot, 'source.txt'), 'utf8')).toBe('main\n');
  });

  it('survives a dirty JSONL export in the worktree because the harness no longer manages it', async () => {
    const worktreePath = path.join(tempRoot, 'worktrees', 'bd-1');
    git(tempRoot, ['worktree', 'add', '-b', 'bead/bd-1', worktreePath, 'main']);
    fs.writeFileSync(path.join(worktreePath, 'source.txt'), 'after\n');
    fs.mkdirSync(path.join(worktreePath, '.beads'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.beads/issues.jsonl'), '{"id":"bd-1","status":"branch-dirty"}\n');
    fs.writeFileSync(path.join(tempRoot, '.beads/issues.jsonl'), '{"id":"bd-1","status":"main-dirty"}\n');

    const configLoader = new ConfigLoader();
    const eventStore = new EventStore(configLoader);
    const bdPlugin = {
      name: 'bd-test',
      tools: [{
        name: PluginToolName.BD_UPDATE_STATUS,
        execute: async ({ id, status, notes }: { id: string; status: string; notes?: string }) => ({ id, status, notes })
      }]
    };
    const plugin = createGitPlugin(eventStore, configLoader, bdPlugin);
    const mergeTool = plugin.tools.find(tool => tool.name === PluginToolName.MERGE_AND_COMMIT)!;

    const result = await mergeTool.execute({
      beadId: 'bd-1',
      message: 'Complete bd-1',
      closeAfterMerge: true,
      closeReason: 'Done'
    });

    expect(result).toMatchObject({ success: true });
    expect(git(tempRoot, ['show', 'HEAD:source.txt'])).toBe('after\n');
  });
});
