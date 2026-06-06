import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactPaths } from '../src/core/ArtifactPaths.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { Logger } from '../src/core/Logger.js';
import { PlanWriteSet } from '../src/core/PlanWriteSet.js';
import { TransactionalStateGuard } from '../src/core/TransactionalStateGuard.js';
import { DomainEventName } from '../src/constants/index.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('TransactionalStateGuard', () => {
  let tempRoot: string;
  let worktreePath: string;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let guard: TransactionalStateGuard;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-transactional-'));
    worktreePath = path.join(tempRoot, 'worktrees', 'bd-1');

    fs.mkdirSync(path.join(tempRoot, '.pi/artifacts/bd-1'), { recursive: true });
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
states:
  Implementation:
    identity: { role: "Builder", expertise: "Implementation", constraints: [] }
    baseInstructions: "Build"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Implementation" }
`);
    fs.writeFileSync(path.join(tempRoot, '.pi/artifacts/bd-1/plan-contract.json'), JSON.stringify({
      writeSet: [{ path: 'approved.py' }]
    }));

    git(tempRoot, ['init']);
    fs.writeFileSync(path.join(tempRoot, 'approved.py'), 'print("old")\n');
    fs.writeFileSync(path.join(tempRoot, 'uv.lock'), 'old\n');
    fs.writeFileSync(path.join(tempRoot, '.gitignore'), 'ignored-tests/\n');
    git(tempRoot, ['add', 'approved.py', 'uv.lock', '.gitignore']);
    git(tempRoot, ['-c', 'user.name=Orr Else', '-c', 'user.email=orr-else@example.invalid', 'commit', '-m', 'initial']);
    git(tempRoot, ['worktree', 'add', '-b', 'bead/bd-1', worktreePath]);

    configLoader = new ConfigLoader(undefined, tempRoot);
    eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
    eventStore.setSessionId(`test-${process.pid}`);
    const artifactPaths = new ArtifactPaths(configLoader, undefined, tempRoot);
    guard = new TransactionalStateGuard(configLoader, artifactPaths, eventStore, new PlanWriteSet(configLoader, artifactPaths, tempRoot));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    configLoader.reset();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('rejects dirty worktree paths outside the approved plan write set', async () => {
    fs.writeFileSync(path.join(worktreePath, 'approved.py'), 'print("new")\n');
    fs.writeFileSync(path.join(worktreePath, 'uv.lock'), 'new\n');

    const result = await guard.validateSuccess('bd-1' as any, 'Implementation', worktreePath);

    expect(result.passed).toBe(false);
    expect(result.unapprovedPaths).toEqual(['uv.lock']);

    const events = await eventStore.readAll();
    expect(events.some(event => event.type === DomainEventName.TRANSACTIONAL_STATE_REJECTED)).toBe(true);
  });

  it('passes when all dirty paths are in the approved plan write set', async () => {
    fs.writeFileSync(path.join(worktreePath, 'approved.py'), 'print("new")\n');

    const result = await guard.validateSuccess('bd-1' as any, 'Implementation', worktreePath);

    expect(result.passed).toBe(true);
    expect(result.unapprovedPaths).toEqual([]);
  });

  it('rejects ignored untracked paths in the approved plan write set', async () => {
    fs.writeFileSync(path.join(tempRoot, '.pi/artifacts/bd-1/plan-contract.json'), JSON.stringify({
      writeSet: [{ path: 'ignored-tests/new_test.py' }]
    }));

    const result = await guard.validateSuccess('bd-1' as any, 'Implementation', worktreePath);

    expect(result.passed).toBe(false);
    expect(result.ignoredWriteSetPaths).toEqual(['ignored-tests/new_test.py']);

    const events = await eventStore.readAll();
    expect(events.some(event => event.type === DomainEventName.TRANSACTIONAL_STATE_REJECTED)).toBe(true);
  });

  it('does not let a stale plan write set block RequirementsAnalysis success', async () => {
    fs.writeFileSync(path.join(tempRoot, '.pi/artifacts/bd-1/plan-contract.json'), JSON.stringify({
      writeSet: [{ path: 'ignored-tests/new_test.py' }]
    }));

    const result = await guard.validateSuccess('bd-1' as any, 'RequirementsAnalysis', worktreePath);

    expect(result.passed).toBe(true);
    expect(result.ignoredWriteSetPaths).toBeUndefined();

    const events = await eventStore.readAll();
    expect(events.some(event => event.type === DomainEventName.TRANSACTIONAL_STATE_REJECTED)).toBe(false);
  });

  it('auto-restores configured unapproved paths before passing the gate', async () => {
    fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Implementation
  transactionalState:
    enabled: true
    requireWriteSet: true
    autoRestoreUnapprovedPaths:
      - uv.lock
  artifacts:
    baseDir: .pi/artifacts
    templates:
      planContract: .pi/artifacts/{{beadId}}/plan-contract.json
  worktreePolicy:
    default: always
states:
  Implementation:
    identity: { role: "Builder", expertise: "Implementation", constraints: [] }
    baseInstructions: "Build"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Implementation" }
`);
    configLoader.reset();
    fs.writeFileSync(path.join(worktreePath, 'approved.py'), 'print("new")\n');
    fs.writeFileSync(path.join(worktreePath, 'uv.lock'), 'new\n');

    const result = await guard.validateSuccess('bd-1' as any, 'Implementation', worktreePath);

    expect(result.passed).toBe(true);
    expect(result.dirtyPaths).toEqual(['approved.py']);
    expect(fs.readFileSync(path.join(worktreePath, 'uv.lock'), 'utf8')).toBe('old\n');

    const events = await eventStore.readAll();
    expect(events.some(event => event.type === DomainEventName.TRANSACTIONAL_STATE_AUTO_RESTORE_STARTED)).toBe(true);
    expect(events.some(event => event.type === DomainEventName.TRANSACTIONAL_STATE_AUTO_RESTORE_SUCCEEDED)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // WI-18 — TransactionalStateGuard eventStore.record failure sites
  //
  // BEFORE: eventStore.record rejections in the two validateSuccess catch arms
  //         were swallowed with .catch(() => {}).  No diagnosis trail.
  // AFTER:  each rejection still swallowed (control flow / return value
  //         unchanged) AND emits Logger.warn with beadId, stateId, error.
  // ---------------------------------------------------------------------------

  it('(WI-18a) warns when eventStore.record rejects for the ignored-write-set rejection path, return value unchanged', async () => {
    // Force the ignored write set path: plan contract contains a path that git
    // will ignore.
    fs.writeFileSync(path.join(tempRoot, '.pi/artifacts/bd-1/plan-contract.json'), JSON.stringify({
      writeSet: [{ path: 'ignored-tests/new_test.py' }]
    }));

    // Stub eventStore.record so it rejects.
    vi.spyOn(eventStore, 'record').mockRejectedValue(new Error('store unavailable'));
    // Intercept Logger.warn to avoid the real DailyRotateFile transport writing
    // to the tempRoot that afterEach will delete.
    const warnCalls: Array<Parameters<typeof Logger.warn>> = [];
    vi.spyOn(Logger, 'warn').mockImplementation((...args) => { warnCalls.push(args); });

    // (a) Return value is unchanged — still a failed validation result.
    const result = await guard.validateSuccess('bd-1' as any, 'Implementation', worktreePath);
    expect(result.passed).toBe(false);
    expect(result.ignoredWriteSetPaths).toEqual(['ignored-tests/new_test.py']);

    // (b) A warn was emitted with beadId, stateId, and a non-empty error string.
    const warnCall = warnCalls.find(([, msg]) => msg.includes('transactional state rejection'));
    expect(warnCall).toBeDefined();
    const [component, , metadata] = warnCall!;
    expect(component).toBe('Core');
    expect(metadata?.beadId).toBe('bd-1');
    expect(metadata?.stateId).toBe('Implementation');
    expect(typeof metadata?.error).toBe('string');
    expect((metadata?.error as string)).toContain('store unavailable');
  });

  it('(WI-18b) warns when eventStore.record rejects for the unapproved-paths rejection path, return value unchanged', async () => {
    // Write an unapproved file to the worktree.
    fs.writeFileSync(path.join(worktreePath, 'uv.lock'), 'changed\n');

    // Stub eventStore.record so it rejects.
    vi.spyOn(eventStore, 'record').mockRejectedValue(new Error('store unavailable'));
    // Intercept Logger.warn to avoid the real DailyRotateFile transport writing
    // to the tempRoot that afterEach will delete.
    const warnCalls: Array<Parameters<typeof Logger.warn>> = [];
    vi.spyOn(Logger, 'warn').mockImplementation((...args) => { warnCalls.push(args); });

    // (a) Return value is unchanged — still a failed validation result.
    const result = await guard.validateSuccess('bd-1' as any, 'Implementation', worktreePath);
    expect(result.passed).toBe(false);
    expect(result.unapprovedPaths).toContain('uv.lock');

    // (b) A warn was emitted with beadId, stateId, and a non-empty error string.
    const warnCall = warnCalls.find(([, msg]) => msg.includes('transactional state rejection'));
    expect(warnCall).toBeDefined();
    const [component, , metadata] = warnCall!;
    expect(component).toBe('Core');
    expect(metadata?.beadId).toBe('bd-1');
    expect(metadata?.stateId).toBe('Implementation');
    expect(typeof metadata?.error).toBe('string');
    expect((metadata?.error as string)).toContain('store unavailable');
  });
});
