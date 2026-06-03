/**
 * Tests for FileAccessPolicy framework-root-write-set early rejection (Part B of
 * bead pi-experiment-mis; contract aligned in pi-experiment-ruq0).
 *
 * CONTRACT (ruq0): the framework root (orr-else repo) is READ-ONLY EVIDENCE from
 * a Cerdiwen worktree.  Framework-root write-sets are EXPLICITLY REJECTED with a
 * clear message that names the correct route: make framework/orr-else changes
 * directly in the orr-else repository, not via a Cerdiwen worktree write-set.
 *
 * SECURITY CONTRACT: these tests verify HARDENING — the framework-root check must
 * reject earlier and more clearly, but must NEVER broaden what is allowed.
 * Normal worktree write-sets must continue to pass through unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileAccessPolicy } from '../src/core/FileAccessPolicy.js';
import { EventStore } from '../src/core/EventStore.js';
import { PlanWriteSet } from '../src/core/PlanWriteSet.js';
import { ShellCommandParser } from '../src/core/ShellCommandParser.js';
import { DomainEventName, EnvVars, NativePiToolName, ProcessFlag } from '../src/constants/index.js';

describe('FileAccessPolicy — framework-root write-set early rejection (Part B mis)', () => {
  let tempRoot: string;
  let frameworkRoot: string;
  let worktree: string;
  let policy: FileAccessPolicy;
  let recordedEvents: Array<{ eventName: string; data: unknown }>;

  beforeEach(() => {
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-fap-framework-')));
    frameworkRoot = path.join(tempRoot, 'framework');
    worktree = path.join(tempRoot, 'worktrees', 'bd-1');
    fs.mkdirSync(frameworkRoot, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });

    recordedEvents = [];
    const stubEventStore = {
      record: vi.fn(async (eventName: string, data: unknown) => {
        recordedEvents.push({ eventName, data });
      })
    } as unknown as EventStore;

    // PlanWriteSet stub: passes all mutations so we isolate the framework-root check.
    const stubPlanWriteSet = {
      validateMutationTarget: vi.fn(async () => ({ passed: true })),
      isPlanContractPath: vi.fn(async () => false),
      validateProposedPlanContract: vi.fn(async () => ({ passed: true }))
    } as unknown as PlanWriteSet;

    policy = new FileAccessPolicy(stubEventStore, new ShellCommandParser(), stubPlanWriteSet, undefined, tempRoot);
  });

  afterEach(() => {
    // Restore process.env keys we may have set.
    delete process.env[EnvVars.WORKER_MODE];
    delete process.env[EnvVars.BEAD_ID];
    delete process.env[EnvVars.STATE_ID];
    delete process.env[EnvVars.PROJECT_ROOT];
    delete process.env[EnvVars.WORKTREE_PATH];
    delete process.env[EnvVars.FRAMEWORK_ROOT];
    fs.rmSync(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function withWorkerEnv<T>(overrides: Partial<Record<string, string>>, fn: () => Promise<T>): Promise<T> {
    const defaults: Record<string, string> = {
      [EnvVars.WORKER_MODE]: ProcessFlag.TRUE,
      [EnvVars.BEAD_ID]: 'bd-1',
      [EnvVars.STATE_ID]: 'AdversarialPreReview',
      [EnvVars.PROJECT_ROOT]: tempRoot,
      [EnvVars.WORKTREE_PATH]: worktree,
      [EnvVars.FRAMEWORK_ROOT]: frameworkRoot
    };
    const envToSet = { ...defaults, ...overrides };
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(envToSet)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    return fn().finally(() => {
      for (const [key, original] of Object.entries(saved)) {
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      }
    });
  }

  it('rejects a Write to a path inside the framework root but outside the worktree with a clear framework-root-contract message', async () => {
    // Target is under framework root (not under worktree) — must be rejected early.
    const targetPath = path.join(frameworkRoot, 'src', 'core', 'SomeHarnessFile.ts');

    const result = await withWorkerEnv({}, () =>
      policy.apply({
        toolName: NativePiToolName.WRITE,
        toolCallId: 'write-framework-file',
        input: { path: targetPath, content: 'export const x = 1;' }
      })
    );

    expect(result).not.toBeNull();
    expect(result?.rejection).toBeDefined();
    expect(result?.rejection).toContain('PROTOCOL VIOLATION');
    // Must name the read-only-evidence contract and the correct route.
    expect(result?.rejection).toContain('configured framework root');
    expect(result?.rejection).toContain('read-only evidence');
    expect(result?.rejection).toContain('orr-else repository');
    // Must NOT be the generic "resolves outside worktree" message.
    expect(result?.rejection).not.toContain('may only mutate files inside this Bead worktree');
    // Event must be recorded.
    expect(recordedEvents.some(e => e.eventName === DomainEventName.FILE_MUTATION_REJECTED)).toBe(true);
  });

  it('rejects an Edit to a path inside the framework root but outside the worktree with a clear framework-root-contract message', async () => {
    const targetPath = path.join(frameworkRoot, '.pi', 'extensions', 'some-extension.ts');

    const result = await withWorkerEnv({}, () =>
      policy.apply({
        toolName: NativePiToolName.EDIT,
        toolCallId: 'edit-framework-file',
        input: { filePath: targetPath, oldString: 'old', newString: 'new' }
      })
    );

    expect(result).not.toBeNull();
    expect(result?.rejection).toContain('configured framework root');
    expect(result?.rejection).toContain('read-only evidence');
    expect(result?.rejection).toContain('orr-else repository');
    expect(result?.rejection).not.toContain('may only mutate files inside this Bead worktree');
  });

  it('rejects a Bash mutation to a path inside the framework root but outside the worktree with a clear framework-root-contract message', async () => {
    const targetPath = path.join(frameworkRoot, 'src', 'core', 'NewModule.ts');

    const result = await withWorkerEnv({}, () =>
      policy.apply({
        toolName: NativePiToolName.BASH,
        toolCallId: 'bash-framework-tee',
        input: { command: `tee ${targetPath}` }
      })
    );

    expect(result).not.toBeNull();
    expect(result?.rejection).toContain('configured framework root');
    expect(result?.rejection).toContain('read-only evidence');
    expect(result?.rejection).toContain('orr-else repository');
  });

  it('allows a Write to a path inside the worktree even when the framework root is configured', async () => {
    // Normal worktree write (worktree is inside the configured framework root) — must pass through unchanged.
    const targetPath = path.join(worktree, 'src', 'implementation.py');

    const result = await withWorkerEnv({}, () =>
      policy.apply({
        toolName: NativePiToolName.WRITE,
        toolCallId: 'write-worktree-file',
        input: { path: targetPath, content: 'def hello(): pass' }
      })
    );

    // No framework-root rejection — should be null (allowed by stub PlanWriteSet).
    expect(result).toBeNull();
  });

  it('rejects a path outside the framework root AND outside the worktree with the generic scope rejection (not framework-root message)', async () => {
    // This path is completely unrelated — not under framework root or worktree.
    const unrelatedPath = path.join(tempRoot, '..', 'some-other-project', 'file.ts');

    const result = await withWorkerEnv({}, () =>
      policy.apply({
        toolName: NativePiToolName.WRITE,
        toolCallId: 'write-unrelated-file',
        input: { path: unrelatedPath, content: 'x' }
      })
    );

    expect(result).not.toBeNull();
    expect(result?.rejection).toBeDefined();
    // Should be the generic worktree-scope rejection, NOT the framework-root one.
    expect(result?.rejection).toContain('may only mutate files inside this Bead worktree');
    // Must NOT incorrectly name the framework-root contract.
    expect(result?.rejection).not.toContain('configured framework root');
  });

  it('does not invoke framework-root check when FRAMEWORK_ROOT env is not set', async () => {
    // When no framework root is configured the path falls through to normal scope check.
    const targetPath = path.join(frameworkRoot, 'src', 'SomeFile.ts');

    const result = await withWorkerEnv(
      { [EnvVars.FRAMEWORK_ROOT]: '' }, // explicitly unset by passing empty string
      () =>
        policy.apply({
          toolName: NativePiToolName.WRITE,
          toolCallId: 'write-no-framework-env',
          input: { path: targetPath, content: 'x' }
        })
    );

    // With no framework root env, falls through to generic worktree-scope rejection.
    expect(result).not.toBeNull();
    // Generic rejection message — not the framework-root one.
    expect(result?.rejection).toContain('may only mutate files inside this Bead worktree');
    expect(result?.rejection).not.toContain('configured framework root');
  });

  it('hardening: framework-root check does not allow paths that the generic scope check would reject', async () => {
    // Verify the security invariant: the early rejection catches framework-root paths
    // EARLIER (with a clearer message), but does NOT broaden allowed paths.
    // An out-of-scope path that is NOT under the framework root is still rejected.
    const outOfScopePath = path.join(tempRoot, 'sibling-project', 'sensitive.ts');

    const result = await withWorkerEnv({}, () =>
      policy.apply({
        toolName: NativePiToolName.WRITE,
        toolCallId: 'write-out-of-scope',
        input: { path: outOfScopePath, content: 'x' }
      })
    );

    // Must still be rejected — the framework-root hardening must not have broadened anything.
    expect(result).not.toBeNull();
    expect(result?.rejection).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // ruq0: read-only-evidence contract + correct-route message
  // -------------------------------------------------------------------------

  it('ruq0: rejection message names the read-only-evidence contract and the correct finalization route', async () => {
    // The framework root is read-only evidence from a Cerdiwen worktree.
    // The rejection must name the correct route: orr-else repo directly.
    const targetPath = path.join(frameworkRoot, 'src', 'core', 'FileAccessPolicy.ts');

    const result = await withWorkerEnv({}, () =>
      policy.apply({
        toolName: NativePiToolName.WRITE,
        toolCallId: 'write-framework-policy-file',
        input: { path: targetPath, content: 'overwrite attempt' }
      })
    );

    expect(result).not.toBeNull();
    expect(result?.rejection).toBeDefined();
    // Contract wording: read-only evidence + correct route.
    expect(result?.rejection).toContain('read-only evidence');
    expect(result?.rejection).toContain('orr-else repository');
    expect(result?.rejection).toContain('explicitly rejected');
  });

  it('ruq0: normal cerdiwen worktree write-set is accepted (unchanged by framework-root contract)', async () => {
    // A write to a path inside the cerdiwen worktree must NOT be rejected
    // by the framework-root contract even when a framework root is configured.
    const targetPath = path.join(worktree, 'packages', 'ceridwen', 'compiler.py');

    const result = await withWorkerEnv({}, () =>
      policy.apply({
        toolName: NativePiToolName.WRITE,
        toolCallId: 'write-cerdiwen-worktree-file',
        input: { path: targetPath, content: 'def compile(): pass' }
      })
    );

    // Must be null (allowed) — the stub PlanWriteSet passes all mutations.
    expect(result).toBeNull();
  });

  it('ruq0: framework-root write-set rejection applies to the framework root itself (not just subdirs)', async () => {
    // A write targeting a file at the framework root level must also be rejected.
    const targetPath = path.join(frameworkRoot, 'package.json');

    const result = await withWorkerEnv({}, () =>
      policy.apply({
        toolName: NativePiToolName.EDIT,
        toolCallId: 'edit-framework-root-package-json',
        input: { filePath: targetPath, oldString: '"name":', newString: '"name": "modified"' }
      })
    );

    expect(result).not.toBeNull();
    expect(result?.rejection).toContain('read-only evidence');
    expect(result?.rejection).toContain('orr-else repository');
  });
});
