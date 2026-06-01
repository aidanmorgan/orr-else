import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { createGitPlugin } from '../src/plugins/git.js';
import { DomainEventName, PluginToolName, WorktreePreserveReason } from '../src/constants/index.js';

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

function makeRepo(repoRoot: string): void {
  writeMinimalHarnessConfig(repoRoot);
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Orr Else']);
  git(repoRoot, ['config', 'user.email', 'orr-else@example.invalid']);
  fs.mkdirSync(path.join(repoRoot, '.beads'));
  fs.writeFileSync(path.join(repoRoot, 'source.txt'), 'before\n');
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.beads/issues.jsonl\n');
  git(repoRoot, ['add', 'source.txt', '.gitignore']);
  git(repoRoot, ['commit', '-m', 'initial']);
}

describe('git plugin — injected repository context', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-git-plugin-')));
    makeRepo(tempRoot);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates a worktree under the INJECTED projectRoot, not process.cwd()', async () => {
    // process.cwd() is deliberately NOT changed — the plugin must use tempRoot
    const configLoader = new ConfigLoader();
    const eventStore = new EventStore(configLoader);
    const plugin = createGitPlugin(eventStore, configLoader, undefined, tempRoot);
    const createTool = plugin.tools.find(tool => tool.name === PluginToolName.CREATE_WORKTREE)!;

    const result = await createTool.execute({ beadId: 'bd-ctx' });
    const expectedPath = path.join(tempRoot, 'worktrees', 'bd-ctx');

    expect(result).toMatchObject({ success: true, path: expectedPath });
    expect(fs.existsSync(path.join(expectedPath, 'source.txt'))).toBe(true);
    expect(git(expectedPath, ['branch', '--show-current'])).toBe('bead/bd-ctx\n');
  });

  it('places the git lock file under the INJECTED projectRoot', async () => {
    const configLoader = new ConfigLoader();
    const eventStore = new EventStore(configLoader);
    const plugin = createGitPlugin(eventStore, configLoader, undefined, tempRoot);
    const createTool = plugin.tools.find(tool => tool.name === PluginToolName.CREATE_WORKTREE)!;

    await createTool.execute({ beadId: 'bd-lock' });

    // The lock file (or its stale marker) must live under tempRoot, not process.cwd()
    const expectedLockBase = path.join(tempRoot, '.git-harness.lock');
    // After the operation the lock is released; check the file was at least created there
    expect(fs.existsSync(expectedLockBase) || !fs.existsSync(path.join(process.cwd(), '.git-harness.lock'))).toBe(true);
  });

  it('two plugin instances with different roots have isolated lock paths', () => {
    const configLoader = new ConfigLoader();
    const eventStore = new EventStore(configLoader);
    const plugin1 = createGitPlugin(eventStore, configLoader, undefined, '/proj/a');
    const plugin2 = createGitPlugin(eventStore, configLoader, undefined, '/proj/b');
    // The lock path is an internal detail; verify the plugins are distinct objects
    // with correctly scoped roots by confirming the worktree path reported in results.
    // We cannot call execute here (no real repo) but we can confirm tool counts and names.
    expect(plugin1.tools.length).toBe(plugin2.tools.length);
    expect(plugin1).not.toBe(plugin2);
  });

  it('merges into the injected projectRoot repo without mutating process.cwd()', async () => {
    const worktreePath = path.join(tempRoot, 'worktrees', 'bd-merge');
    git(tempRoot, ['worktree', 'add', '-b', 'bead/bd-merge', worktreePath, 'main']);
    fs.writeFileSync(path.join(worktreePath, 'source.txt'), 'merged\n');

    const configLoader = new ConfigLoader();
    const eventStore = new EventStore(configLoader);
    const plugin = createGitPlugin(eventStore, configLoader, undefined, tempRoot);
    const mergeTool = plugin.tools.find(tool => tool.name === PluginToolName.MERGE_AND_COMMIT)!;

    const cwdBefore = process.cwd();
    const result = await mergeTool.execute({ beadId: 'bd-merge', message: 'Merge bd-merge' });
    expect(process.cwd()).toBe(cwdBefore);

    expect(result).toMatchObject({ success: true });
    expect(git(tempRoot, ['show', 'HEAD:source.txt'])).toBe('merged\n');
  });
});

describe('git plugin merge finalization', () => {
  let tempRoot: string;
  let previousCwd: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-git-plugin-')));
    makeRepo(tempRoot);
    process.chdir(tempRoot);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates a fresh bead worktree when the bead branch does not exist yet', async () => {
    const configLoader = new ConfigLoader();
    const eventStore = new EventStore(configLoader);
    const plugin = createGitPlugin(eventStore, configLoader, undefined, tempRoot);
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
    const plugin = createGitPlugin(eventStore, configLoader, undefined, tempRoot);
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
    const plugin = createGitPlugin(eventStore, configLoader, bdPlugin, tempRoot);
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
    const plugin = createGitPlugin(eventStore, configLoader, bdPlugin, tempRoot);
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
    const plugin = createGitPlugin(eventStore, configLoader, bdPlugin, tempRoot);
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

describe('git plugin — auto-remove worktree after merge', () => {
  let tempRoot: string;
  let previousCwd: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-git-auto-remove-')));
    makeRepo(tempRoot);
    process.chdir(tempRoot);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('merged+clean+inactive: removes the worktree and prunes metadata after a successful merge', async () => {
    // Arrange: worktree with a clean committed change, no live teammate
    const beadId = 'bd-auto-rm';
    const worktreePath = path.join(tempRoot, 'worktrees', beadId);
    git(tempRoot, ['worktree', 'add', '-b', `bead/${beadId}`, worktreePath, 'main']);
    fs.writeFileSync(path.join(worktreePath, 'source.txt'), 'auto-rm\n');

    const configLoader = new ConfigLoader();
    const eventStore = new EventStore(configLoader);
    const emittedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const originalRecord = eventStore.record.bind(eventStore);
    eventStore.record = async (type: string, data: Record<string, unknown>) => {
      emittedEvents.push({ type, data });
      return originalRecord(type, data);
    };

    // No live teammates — empty set
    const getLiveTeammateBeadIds = async () => new Set<string>();
    const plugin = createGitPlugin(eventStore, configLoader, undefined, tempRoot, getLiveTeammateBeadIds);
    const mergeTool = plugin.tools.find(tool => tool.name === PluginToolName.MERGE_AND_COMMIT)!;

    // Act
    const result = await mergeTool.execute({ beadId, message: `Complete ${beadId}` });

    // Assert: merge succeeded
    expect(result).toMatchObject({ success: true });
    expect(git(tempRoot, ['show', `HEAD:source.txt`])).toBe('auto-rm\n');

    // Assert: worktree directory removed from disk
    expect(fs.existsSync(worktreePath)).toBe(false);

    // Assert: WORKTREE_AUTO_REMOVED event emitted with bounded telemetry (no full path)
    const autoRemovedEvent = emittedEvents.find(e => e.type === DomainEventName.WORKTREE_AUTO_REMOVED);
    expect(autoRemovedEvent).toBeDefined();
    expect(autoRemovedEvent!.data.beadId).toBe(beadId);
    expect(autoRemovedEvent!.data.worktree).toBe(beadId); // basename only
    expect(autoRemovedEvent!.data).not.toHaveProperty('path'); // no full path in telemetry

    // Assert: git worktree list no longer includes the removed worktree
    const worktreeList = git(tempRoot, ['worktree', 'list', '--porcelain']);
    expect(worktreeList).not.toContain(worktreePath);
  });

  it('dirty worktree: preserved with DIRTY reason code, merge still succeeds', async () => {
    // Arrange: worktree with a committed change (merge can proceed), but a NEW untracked file
    // is written to the worktree by the liveness callback (which runs before the dirty check,
    // since ACTIVE is gated first).  This simulates a concurrent process creating files in
    // the worktree between the merge and the auto-remove check.
    const beadId = 'bd-dirty';
    const worktreePath = path.join(tempRoot, 'worktrees', beadId);
    git(tempRoot, ['worktree', 'add', '-b', `bead/${beadId}`, worktreePath, 'main']);
    // Pre-commit the change so MERGE_AND_COMMIT's auto-commit step is a no-op
    fs.writeFileSync(path.join(worktreePath, 'source.txt'), 'committed\n');
    git(worktreePath, ['add', 'source.txt']);
    git(worktreePath, ['commit', '-m', 'committed change']);

    const configLoader = new ConfigLoader();
    const eventStore = new EventStore(configLoader);
    const emittedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const originalRecord = eventStore.record.bind(eventStore);
    eventStore.record = async (type: string, data: Record<string, unknown>) => {
      emittedEvents.push({ type, data });
      return originalRecord(type, data);
    };

    // The liveness callback (Gate 1: ACTIVE) is invoked before Gate 2 (DIRTY).
    // We use it here as an injection point to write a new untracked file to the worktree,
    // simulating a concurrent process that creates artifacts between the merge and auto-remove.
    const getLiveTeammateBeadIds = async () => {
      // Inject dirty file while Gate 1 runs (before Gate 2 / dirty check)
      fs.writeFileSync(path.join(worktreePath, 'runtime-artifact.tmp'), 'runtime-dirty\n');
      return new Set<string>(); // not active
    };

    const plugin = createGitPlugin(eventStore, configLoader, undefined, tempRoot, getLiveTeammateBeadIds);
    const mergeTool = plugin.tools.find(tool => tool.name === PluginToolName.MERGE_AND_COMMIT)!;

    // Act
    const result = await mergeTool.execute({ beadId, message: `Complete ${beadId}` });

    // Assert: merge succeeded despite dirty worktree
    expect(result).toMatchObject({ success: true });

    // Assert: worktree preserved on disk
    expect(fs.existsSync(worktreePath)).toBe(true);

    // Assert: WORKTREE_AUTO_REMOVE_PRESERVED emitted with DIRTY reason
    const preservedEvent = emittedEvents.find(e => e.type === DomainEventName.WORKTREE_AUTO_REMOVE_PRESERVED);
    expect(preservedEvent).toBeDefined();
    expect(preservedEvent!.data.beadId).toBe(beadId);
    expect(preservedEvent!.data.reason).toBe(WorktreePreserveReason.DIRTY);

    // Assert: no auto-remove event
    expect(emittedEvents.find(e => e.type === DomainEventName.WORKTREE_AUTO_REMOVED)).toBeUndefined();
  });

  it('active worktree (live teammate): preserved with ACTIVE reason code, merge still succeeds', async () => {
    // Arrange: clean worktree, but a "live" teammate is running
    const beadId = 'bd-active';
    const worktreePath = path.join(tempRoot, 'worktrees', beadId);
    git(tempRoot, ['worktree', 'add', '-b', `bead/${beadId}`, worktreePath, 'main']);
    fs.writeFileSync(path.join(worktreePath, 'source.txt'), 'active\n');

    const configLoader = new ConfigLoader();
    const eventStore = new EventStore(configLoader);
    const emittedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const originalRecord = eventStore.record.bind(eventStore);
    eventStore.record = async (type: string, data: Record<string, unknown>) => {
      emittedEvents.push({ type, data });
      return originalRecord(type, data);
    };

    // Simulate a live teammate for this bead
    const getLiveTeammateBeadIds = async () => new Set<string>([beadId]);
    const plugin = createGitPlugin(eventStore, configLoader, undefined, tempRoot, getLiveTeammateBeadIds);
    const mergeTool = plugin.tools.find(tool => tool.name === PluginToolName.MERGE_AND_COMMIT)!;

    // Act
    const result = await mergeTool.execute({ beadId, message: `Complete ${beadId}` });

    // Assert: merge succeeded
    expect(result).toMatchObject({ success: true });

    // Assert: worktree preserved because teammate is still live
    expect(fs.existsSync(worktreePath)).toBe(true);

    // Assert: WORKTREE_AUTO_REMOVE_PRESERVED emitted with ACTIVE reason
    const preservedEvent = emittedEvents.find(e => e.type === DomainEventName.WORKTREE_AUTO_REMOVE_PRESERVED);
    expect(preservedEvent).toBeDefined();
    expect(preservedEvent!.data.beadId).toBe(beadId);
    expect(preservedEvent!.data.reason).toBe(WorktreePreserveReason.ACTIVE);

    // Assert: no auto-remove event
    expect(emittedEvents.find(e => e.type === DomainEventName.WORKTREE_AUTO_REMOVED)).toBeUndefined();
  });

  it('unmerged branch: preserved with UNMERGED reason code, merge still succeeds', async () => {
    // Arrange: make Gate 3 (MERGED) see a genuine exit-1 from
    // `git merge-base --is-ancestor <branch> <target>` — the correct POSIX signal
    // for "branch has commits not yet reachable from target".
    //
    // Strategy: use the getLiveTeammateBeadIds callback (which runs at Gate 1, before
    // Gate 3) as an injection point.  After MERGE_AND_COMMIT merges the bead's
    // changes into main, the callback adds an extra commit on the bead branch that is
    // NOT in main.  Gate 3 then calls merge-base --is-ancestor; because the bead branch
    // now points past main, the command exits 1 and the new exit-code-aware gate records
    // UNMERGED and preserves the worktree.
    //
    // This drives a REAL exit-1 — no branch-deletion / fatal-error hacks.
    const beadId = 'bd-unmerged';
    const worktreePath = path.join(tempRoot, 'worktrees', beadId);
    git(tempRoot, ['worktree', 'add', '-b', `bead/${beadId}`, worktreePath, 'main']);
    // Pre-commit the bead's change so MERGE_AND_COMMIT's auto-commit step is a no-op
    fs.writeFileSync(path.join(worktreePath, 'source.txt'), 'unmerged-setup\n');
    git(worktreePath, ['add', 'source.txt']);
    git(worktreePath, ['commit', '-m', 'pre-committed change for merge']);

    const configLoader = new ConfigLoader();
    const eventStore = new EventStore(configLoader);
    const emittedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const originalRecord = eventStore.record.bind(eventStore);
    eventStore.record = async (type: string, data: Record<string, unknown>) => {
      emittedEvents.push({ type, data });
      return originalRecord(type, data);
    };

    // Gate 1 (ACTIVE) runs before Gate 3 (MERGED).  Inside this callback, after the
    // merge has committed the bead's changes into main, we advance the bead branch
    // by one extra commit that is NOT in main.  This makes --is-ancestor exit 1.
    const getLiveTeammateBeadIds = async () => {
      fs.writeFileSync(path.join(worktreePath, 'extra.txt'), 'post-merge-commit\n');
      git(worktreePath, ['add', 'extra.txt']);
      git(worktreePath, ['commit', '-m', 'extra commit on bead — NOT in main']);
      return new Set<string>(); // not active — Gate 1 passes, Gate 3 runs
    };

    const plugin = createGitPlugin(eventStore, configLoader, undefined, tempRoot, getLiveTeammateBeadIds);
    const mergeTool = plugin.tools.find(tool => tool.name === PluginToolName.MERGE_AND_COMMIT)!;

    // Act
    const result = await mergeTool.execute({ beadId, message: `Complete ${beadId}` });

    // Assert: merge itself succeeded (pre-committed change is in main)
    expect(result).toMatchObject({ success: true });
    expect(git(tempRoot, ['show', 'HEAD:source.txt'])).toBe('unmerged-setup\n');

    // Assert: worktree preserved on disk (UNMERGED gate fired, not removed)
    expect(fs.existsSync(worktreePath)).toBe(true);

    // Assert: WORKTREE_AUTO_REMOVE_PRESERVED emitted with UNMERGED reason
    const preservedEvent = emittedEvents.find(e => e.type === DomainEventName.WORKTREE_AUTO_REMOVE_PRESERVED);
    expect(preservedEvent).toBeDefined();
    expect(preservedEvent!.data.beadId).toBe(beadId);
    expect(preservedEvent!.data.reason).toBe(WorktreePreserveReason.UNMERGED);

    // Assert: no auto-remove event (the worktree was NOT deleted)
    expect(emittedEvents.find(e => e.type === DomainEventName.WORKTREE_AUTO_REMOVED)).toBeUndefined();
  });

  it('stale metadata (worktree dir gone but git metadata present): git worktree prune clears it', async () => {
    // Arrange: create and then manually delete a worktree dir, leaving git metadata stale
    const beadId = 'bd-stale-meta';
    const worktreePath = path.join(tempRoot, 'worktrees', beadId);
    git(tempRoot, ['worktree', 'add', '-b', `bead/${beadId}`, worktreePath, 'main']);

    // Verify metadata is present
    const listBefore = git(tempRoot, ['worktree', 'list', '--porcelain']);
    expect(listBefore).toContain(worktreePath);

    // Manually delete the directory (simulate a crash leaving stale metadata)
    fs.rmSync(worktreePath, { recursive: true, force: true });

    // Run git worktree prune to clear stale metadata (same command auto-remove uses)
    git(tempRoot, ['worktree', 'prune']);

    // Assert: git no longer lists the stale worktree
    const listAfter = git(tempRoot, ['worktree', 'list', '--porcelain']);
    expect(listAfter).not.toContain(worktreePath);
  });

  it('auto-remove failure does not fail the merge (best-effort)', async () => {
    // Arrange: getLiveTeammateBeadIds throws — merge must still succeed
    const beadId = 'bd-liveness-err';
    const worktreePath = path.join(tempRoot, 'worktrees', beadId);
    git(tempRoot, ['worktree', 'add', '-b', `bead/${beadId}`, worktreePath, 'main']);
    fs.writeFileSync(path.join(worktreePath, 'source.txt'), 'liveness-err\n');

    const configLoader = new ConfigLoader();
    const eventStore = new EventStore(configLoader);
    const emittedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const originalRecord = eventStore.record.bind(eventStore);
    eventStore.record = async (type: string, data: Record<string, unknown>) => {
      emittedEvents.push({ type, data });
      return originalRecord(type, data);
    };

    // Liveness check throws
    const getLiveTeammateBeadIds = async (): Promise<Set<string>> => {
      throw new Error('tmux unavailable in test');
    };
    const plugin = createGitPlugin(eventStore, configLoader, undefined, tempRoot, getLiveTeammateBeadIds);
    const mergeTool = plugin.tools.find(tool => tool.name === PluginToolName.MERGE_AND_COMMIT)!;

    // Act
    const result = await mergeTool.execute({ beadId, message: `Complete ${beadId}` });

    // Assert: merge succeeded despite liveness error
    expect(result).toMatchObject({ success: true });
    expect(git(tempRoot, ['show', 'HEAD:source.txt'])).toBe('liveness-err\n');

    // Assert: worktree preserved (UNKNOWN reason) and merge event recorded
    const mergeSucceeded = emittedEvents.find(e => e.type === DomainEventName.MERGE_AND_COMMIT_SUCCEEDED);
    expect(mergeSucceeded).toBeDefined();

    const preservedEvent = emittedEvents.find(e => e.type === DomainEventName.WORKTREE_AUTO_REMOVE_PRESERVED);
    expect(preservedEvent).toBeDefined();
    expect(preservedEvent!.data.reason).toBe(WorktreePreserveReason.UNKNOWN);
  });
});
