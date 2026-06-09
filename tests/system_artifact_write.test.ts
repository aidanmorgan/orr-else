/**
 * Tests for declared writable system artifacts through transactional write-set
 * enforcement (g9ye). An extension declares an artifact type with writable:true;
 * the harness then permits the teammate to write that artifact's EXACT resolved
 * path even when it is not in the bead's approved plan write set, while keeping
 * every other undeclared workspace-root write rejected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileAccessPolicy } from '../src/core/FileAccessPolicy.js';
import { ArtifactPaths } from '../src/core/ArtifactPaths.js';
import { EventStore } from '../src/core/EventStore.js';
import { PlanWriteSet } from '../src/core/PlanWriteSet.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { ShellCommandParser } from '../src/core/ShellCommandParser.js';
import { DomainEventName } from '../src/constants/domain.js';
import { EnvVars, NativePiToolName, ProcessFlag } from '../src/constants/infra.js';

describe('FileAccessPolicy — declared writable system artifacts (g9ye)', () => {
  let tempRoot: string;
  let worktree: string;
  let policy: FileAccessPolicy;
  let recordedEvents: Array<{ eventName: string; data: any }>;

  beforeEach(() => {
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-sysartifact-')));
    worktree = path.join(tempRoot, 'worktrees', 'bd-1');
    fs.mkdirSync(worktree, { recursive: true });

    recordedEvents = [];
    const stubEventStore = {
      record: vi.fn(async (eventName: string, data: any) => { recordedEvents.push({ eventName, data }); })
    } as unknown as EventStore;

    // PlanWriteSet stub: REJECTS every mutation (target is not in the plan write
    // set) so we isolate the declared-artifact bypass.
    const stubPlanWriteSet = {
      validateMutationTarget: vi.fn(async () => ({ passed: false, reason: 'PROTOCOL VIOLATION: outside the approved plan write set.' })),
      isPlanContractPath: vi.fn(async () => false),
      validateProposedPlanContract: vi.fn(async () => ({ passed: true }))
    } as unknown as PlanWriteSet;

    // ConfigLoader stub declaring a writable lesson artifact (project-scoped).
    const stubConfigLoader = {
      load: vi.fn(async () => ({
        settings: {
          artifacts: {
            baseDir: '.pi/artifacts',
            templates: {
              lessons: { path: '.pi/lessons/{{beadId}}.md', scope: 'project', writable: true, ensureDir: true }
            }
          }
        }
      }))
    } as unknown as ConfigLoader;

    const artifactPaths = new ArtifactPaths(stubConfigLoader, { env: (n: string) => process.env[n] }, tempRoot);
    policy = new FileAccessPolicy(stubEventStore, new ShellCommandParser(), stubPlanWriteSet, undefined, tempRoot, artifactPaths);
  });

  afterEach(() => {
    for (const k of [EnvVars.WORKER_MODE, EnvVars.BEAD_ID, EnvVars.STATE_ID, EnvVars.PROJECT_ROOT, EnvVars.WORKTREE_PATH]) delete process.env[k];
    fs.rmSync(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function withWorkerEnv<T>(overrides: Partial<Record<string, string>>, fn: () => Promise<T>): Promise<T> {
    const defaults: Record<string, string> = {
      [EnvVars.WORKER_MODE]: ProcessFlag.TRUE,
      [EnvVars.BEAD_ID]: 'bd-1',
      [EnvVars.STATE_ID]: 'LessonCapture',
      [EnvVars.PROJECT_ROOT]: tempRoot,
      [EnvVars.WORKTREE_PATH]: worktree
    };
    const envToSet = { ...defaults, ...overrides };
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(envToSet)) { saved[key] = process.env[key]; process.env[key] = value; }
    return fn().finally(() => {
      for (const [key, original] of Object.entries(saved)) {
        if (original === undefined) delete process.env[key]; else process.env[key] = original;
      }
    });
  }

  it('permits a Write to the exact declared lesson artifact path and records a systemArtifact audit event', async () => {
    const lessonPath = path.join(tempRoot, '.pi', 'lessons', 'bd-1.md');
    const result = await withWorkerEnv({}, () =>
      policy.apply({ toolName: NativePiToolName.WRITE, toolCallId: 'w1', input: { path: lessonPath, content: '# lesson\n' } })
    );
    // Permitted -> apply returns null (no rejection).
    expect(result).toBeNull();
    const permit = recordedEvents.find(e => e.eventName === DomainEventName.SYSTEM_ARTIFACT_WRITE_PERMITTED);
    expect(permit).toBeDefined();
    expect(permit?.data.beadId).toBe('bd-1');
    expect(permit?.data.pathClass).toBe('systemArtifact');
    expect(permit?.data.resolvedPath).toBe(lessonPath);
  });

  it("rejects a Write to a DIFFERENT bead's lesson path (not this bead's declared artifact)", async () => {
    const otherBeadLesson = path.join(tempRoot, '.pi', 'lessons', 'bd-OTHER.md');
    const result = await withWorkerEnv({}, () =>
      policy.apply({ toolName: NativePiToolName.WRITE, toolCallId: 'w2', input: { path: otherBeadLesson, content: 'x' } })
    );
    expect(result).not.toBeNull();
    expect(result?.rejection).toContain('PROTOCOL VIOLATION');
    expect(recordedEvents.some(e => e.eventName === DomainEventName.SYSTEM_ARTIFACT_WRITE_PERMITTED)).toBe(false);
  });

  it('rejects a Write to an UNDECLARED workspace-root path', async () => {
    const undeclared = path.join(tempRoot, '.pi', 'notes.md');
    const result = await withWorkerEnv({}, () =>
      policy.apply({ toolName: NativePiToolName.WRITE, toolCallId: 'w3', input: { path: undeclared, content: 'x' } })
    );
    expect(result).not.toBeNull();
    expect(result?.rejection).toContain('PROTOCOL VIOLATION');
    expect(recordedEvents.some(e => e.eventName === DomainEventName.SYSTEM_ARTIFACT_WRITE_PERMITTED)).toBe(false);
  });

  it('ensureArtifactDirs creates the declared artifact directory', async () => {
    const artifactPaths = new ArtifactPaths(
      { load: async () => ({ settings: { artifacts: { templates: { lessons: { path: '.pi/lessons/{{beadId}}.md', ensureDir: true } } } } }) } as unknown as ConfigLoader,
      { env: (n: string) => process.env[n] },
      tempRoot
    );
    await withWorkerEnv({}, async () => {
      await artifactPaths.ensureArtifactDirs({ beadId: 'bd-1' });
    });
    expect(fs.existsSync(path.join(tempRoot, '.pi', 'lessons'))).toBe(true);
  });
});
