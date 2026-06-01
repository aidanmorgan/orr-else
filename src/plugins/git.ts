import { Type } from "@earendil-works/pi-ai";
import * as path from 'path';
import * as fs from 'fs';
import * as lockfile from 'proper-lockfile';
import { simpleGit } from 'simple-git';
import { Logger } from '../core/Logger.js';
import { EventStore } from '../core/EventStore.js';
import { BeadStatus, Component, DomainEventName, FileMutationPolicyDefaults, PluginToolName, TransactionalStateDefaults, WorktreeDefaults } from '../constants/index.js';
import type { ConfigLoader } from '../core/ConfigLoader.js';
import type { RuntimePlugin } from '../core/RuntimeServices.js';

const appendFileAsync = fs.promises.appendFile;
const mkdirAsync = fs.promises.mkdir;
const readFileAsync = fs.promises.readFile;
const writeFileAsync = fs.promises.writeFile;

const GIT_LOCK_FILE = path.join(process.cwd(), WorktreeDefaults.GIT_LOCK_FILE);
const GitSubcommand = {
  ADD: 'add',
  BRANCH: 'branch',
  COMMIT: 'commit',
  DIFF: 'diff',
  MERGE: 'merge',
  RESTORE: 'restore',
  REV_PARSE: 'rev-parse',
  SHOW_REF: 'show-ref',
  STATUS: 'status',
  SWITCH: 'switch',
  WORKTREE: 'worktree'
} as const;
const GitFlag = {
  ALL: '--all',
  ARG_SEPARATOR: '--',
  CACHED: '--cached',
  FORCE: '--force',
  MESSAGE: '-m',
  ABORT: '--abort',
  NAME_ONLY: '--name-only',
  NO_COMMIT: '--no-commit',
  NO_FF: '--no-ff',
  PORCELAIN: '--porcelain',
  QUIET: '--quiet',
  SHOW_CURRENT: '--show-current',
  STAGED: '--staged',
  VERIFY: '--verify'
} as const;

async function git(args: string[], cwd: string = process.cwd()): Promise<string> {
  return await simpleGit({ baseDir: cwd, binary: 'git' }).raw(args);
}

async function withGitLock<T>(
  eventStore: EventStore,
  operation: PluginToolName,
  beadId: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  await mkdirAsync(path.dirname(GIT_LOCK_FILE), { recursive: true });
  await writeFileAsync(GIT_LOCK_FILE, '', { flag: 'a' });

  const release = await lockfile.lock(GIT_LOCK_FILE, {
    realpath: false,
    retries: {
      retries: WorktreeDefaults.MAX_LOCK_RETRIES,
      factor: 1,
      minTimeout: WorktreeDefaults.LOCK_WAIT_MS,
      maxTimeout: WorktreeDefaults.LOCK_WAIT_MS
    }
  });

  await eventStore.record(DomainEventName.GIT_LOCK_ACQUIRED, {
    beadId,
    operation,
    path: GIT_LOCK_FILE
  });

  try {
    return await fn();
  } finally {
    await release();
    await eventStore.record(DomainEventName.GIT_LOCK_RELEASED, {
      beadId,
      operation,
      path: GIT_LOCK_FILE
    });
  }
}

function branchNameFor(beadId: string): string {
  return `${WorktreeDefaults.BRANCH_PREFIX}${beadId}`;
}

async function currentBranch(): Promise<string> {
  const out = await git([GitSubcommand.BRANCH, GitFlag.SHOW_CURRENT]);
  return out.trim();
}

async function hasHead(): Promise<boolean> {
  try {
    await git([GitSubcommand.REV_PARSE, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

async function localBranchExists(branchName: string): Promise<boolean> {
  try {
    await git([GitSubcommand.REV_PARSE, GitFlag.VERIFY, `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

function assertSafeBeadId(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid Bead ID format');
}

async function worktreeExcludePath(worktreePath: string): Promise<string> {
  const rawPath = (await git([GitSubcommand.REV_PARSE, '--git-path', 'info/exclude'], worktreePath)).trim();
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(worktreePath, rawPath);
}

function splitGitPathLines(output: string): string[] {
  return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

async function stagedPaths(cwd: string = process.cwd()): Promise<string[]> {
  return splitGitPathLines(await git([GitSubcommand.DIFF, GitFlag.CACHED, GitFlag.NAME_ONLY], cwd));
}

async function unmergedPaths(cwd: string = process.cwd()): Promise<string[]> {
  return splitGitPathLines(await git([GitSubcommand.DIFF, GitFlag.NAME_ONLY, '--diff-filter=U'], cwd));
}

async function abortMergeIfNeeded(): Promise<void> {
  const unmerged = await unmergedPaths();
  if (unmerged.length === 0) return;
  await git([GitSubcommand.MERGE, GitFlag.ABORT]);
}

async function unstageIndexBeforeMerge(eventStore: EventStore, beadId: string, targetBranch: string): Promise<void> {
  const paths = await stagedPaths();
  if (paths.length === 0) return;
  await git([GitSubcommand.RESTORE, GitFlag.STAGED, GitFlag.ARG_SEPARATOR, ...paths]);
  await eventStore.record(DomainEventName.GIT_INDEX_UNSTAGED, {
    beadId,
    targetBranch,
    paths,
    reason: 'prepare harness-owned merge without committing pre-existing index state'
  });
}

async function configureOperationalExcludes(
  eventStore: EventStore,
  beadId: string,
  worktreePath: string
): Promise<void> {
  const excludePath = await worktreeExcludePath(worktreePath);
  const existing = fs.existsSync(excludePath) ? await readFileAsync(excludePath, 'utf8') : '';
  const existingPatterns = new Set(existing.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  const missingPatterns = WorktreeDefaults.OPERATIONAL_EXCLUDE_PATTERNS
    .filter(pattern => !existingPatterns.has(pattern));

  if (missingPatterns.length === 0) return;

  const prefix = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
  const header = existingPatterns.has(WorktreeDefaults.OPERATIONAL_EXCLUDE_HEADER)
    ? ''
    : `${WorktreeDefaults.OPERATIONAL_EXCLUDE_HEADER}\n`;
  const body = `${prefix}${header}${missingPatterns.join('\n')}\n`;

  await mkdirAsync(path.dirname(excludePath), { recursive: true });
  await appendFileAsync(excludePath, body);
  await eventStore.record(DomainEventName.WORKTREE_EXCLUDES_CONFIGURED, {
    beadId,
    path: excludePath,
    patterns: missingPatterns
  });
}

function safeRelativeRestorePath(filePath: string): string | null {
  const normalized = filePath.replaceAll(path.sep, '/').replace(/^\.\//, '');
  if (!normalized || path.isAbsolute(normalized) || normalized.startsWith('../')) return null;
  return normalized;
}

async function autoRestoreConfiguredPaths(
  eventStore: EventStore,
  configLoader: ConfigLoader | undefined,
  beadId: string,
  worktreePath: string
): Promise<void> {
  let config: ReturnType<ConfigLoader['load']> | undefined;
  try {
    config = configLoader?.load();
  } catch {
    config = undefined;
  }
  const configuredPaths = config?.settings.transactionalState?.autoRestoreUnapprovedPaths || [];
  const restorePaths = configuredPaths
    .map((filePath: string) => safeRelativeRestorePath(filePath))
    .filter((filePath): filePath is string => !!filePath);
  if (restorePaths.length === 0) return;

  const dirtyPaths: string[] = [];
  for (const filePath of restorePaths) {
    const status = await git([GitSubcommand.STATUS, GitFlag.PORCELAIN, GitFlag.ARG_SEPARATOR, filePath], worktreePath);
    if (status.trim()) dirtyPaths.push(filePath);
  }
  if (dirtyPaths.length === 0) return;

  await eventStore.record(DomainEventName.TRANSACTIONAL_STATE_AUTO_RESTORE_STARTED, {
    beadId,
    stateId: WorktreeDefaults.AUTO_RESTORE_STATE_ID,
    worktreePath,
    paths: dirtyPaths
  });
  try {
    await git([
      FileMutationPolicyDefaults.GIT_RESTORE_SUBCOMMAND,
      TransactionalStateDefaults.GIT_SOURCE_OPTION,
      TransactionalStateDefaults.GIT_HEAD_REF,
      GitFlag.ARG_SEPARATOR,
      ...dirtyPaths
    ], worktreePath);
    await eventStore.record(DomainEventName.TRANSACTIONAL_STATE_AUTO_RESTORE_SUCCEEDED, {
      beadId,
      stateId: WorktreeDefaults.AUTO_RESTORE_STATE_ID,
      worktreePath,
      paths: dirtyPaths
    });
  } catch (error) {
    await eventStore.record(DomainEventName.TRANSACTIONAL_STATE_AUTO_RESTORE_FAILED, {
      beadId,
      stateId: WorktreeDefaults.AUTO_RESTORE_STATE_ID,
      worktreePath,
      paths: dirtyPaths,
      error: String(error)
    });
    throw error;
  }
}

export function createGitPlugin(eventStore: EventStore, configLoader?: ConfigLoader, bdPlugin?: RuntimePlugin) {
  return {
  name: 'git-worktrees',
  tools: [
    {
      name: PluginToolName.CREATE_WORKTREE,
      description: 'Spawn a dedicated Git worktree tied to a Bead identifier.',
      parameters: Type.Object({
        beadId: Type.String({ description: 'The Bead identifier' }),
        baseBranch: Type.Optional(Type.String({ description: 'The branch to fork from' }))
      }),
      execute: async ({ beadId, baseBranch }: { beadId: string, baseBranch?: string }, ctx?: any) => {
        try {
          assertSafeBeadId(beadId);
          const worktreePath = path.join(process.cwd(), WorktreeDefaults.ROOT_DIR, beadId);
          if (fs.existsSync(worktreePath)) {
            Logger.info(Component.GIT, `Worktree already exists for ${beadId}. Reusing.`);
            await withGitLock(eventStore, PluginToolName.CREATE_WORKTREE, beadId, async () => {
              await autoRestoreConfiguredPaths(eventStore, configLoader, beadId, worktreePath);
            });
            await configureOperationalExcludes(eventStore, beadId, worktreePath);
            await eventStore.record(DomainEventName.WORKTREE_REUSED, { beadId, path: worktreePath });
            return { success: true, path: worktreePath };
          }

          if (ctx?.hasUI) ctx.ui.setWorkingMessage(`Creating worktree for ${beadId}...`);

          const branchName = branchNameFor(beadId);
          await withGitLock(eventStore, PluginToolName.CREATE_WORKTREE, beadId, async () => {
            const repositoryHasHead = await hasHead();
            const resolvedBaseBranch = repositoryHasHead ? (baseBranch || await currentBranch()) : undefined;
            Logger.info(Component.GIT, `Creating worktree for ${beadId}${resolvedBaseBranch ? ` from ${resolvedBaseBranch}` : ' as orphan bootstrap worktree'}`, { branchName });
            
            const branchExists = await localBranchExists(branchName);

            const args = !repositoryHasHead
              ? [GitSubcommand.WORKTREE, GitSubcommand.ADD, '--orphan', '-b', branchName, worktreePath]
              : branchExists
              ? [GitSubcommand.WORKTREE, GitSubcommand.ADD, worktreePath, branchName]
              : [GitSubcommand.WORKTREE, GitSubcommand.ADD, '-b', branchName, worktreePath, resolvedBaseBranch!];
            await git(args);
          });
          await configureOperationalExcludes(eventStore, beadId, worktreePath);
          await autoRestoreConfiguredPaths(eventStore, configLoader, beadId, worktreePath);
          
          if (ctx?.hasUI) {
            ctx.ui.notify(`Worktree created for ${beadId}`, 'info');
            ctx.ui.setWorkingMessage(undefined);
          }
          await eventStore.record(DomainEventName.WORKTREE_CREATED, { beadId, path: worktreePath, branchName });
          return { success: true, path: worktreePath };
        } catch (error) {
          await eventStore.record(DomainEventName.WORKTREE_CREATE_FAILED, { beadId, error: String(error) }).catch(() => {});
          Logger.error(Component.GIT, `Failed to create worktree for ${beadId}`, { error: String(error) });
          if (ctx?.hasUI) {
            ctx.ui.notify(`Failed to create worktree: ${String(error)}`, 'error');
            ctx.ui.setWorkingMessage(undefined);
          }
          return { success: false, error: String(error) };
        }
      }
    },
    {
      name: PluginToolName.REMOVE_WORKTREE,
      description: 'Remove an isolated Git worktree.',
      parameters: Type.Object({
        beadId: Type.String({ description: 'The Bead identifier' }),
        force: Type.Optional(Type.Boolean({ description: 'Skip confirmation' }))
      }),
      execute: async ({ beadId, force }: { beadId: string, force?: boolean }, ctx?: any) => {
        try {
          assertSafeBeadId(beadId);
          const worktreePath = path.join(process.cwd(), WorktreeDefaults.ROOT_DIR, beadId);
          if (!fs.existsSync(worktreePath)) {
            await eventStore.record(DomainEventName.WORKTREE_REMOVE_SKIPPED, { beadId, path: worktreePath, reason: 'missing' });
            return { success: true };
          }

          if (ctx?.hasUI && !force) {
            const confirmed = await ctx.ui.confirm(
              'Remove Worktree',
              `Are you sure you want to remove the worktree for ${beadId}? Uncommitted changes will be lost.`
            );
            if (!confirmed) return { success: false, error: 'User cancelled worktree removal' };
          }

          if (ctx?.hasUI) ctx.ui.setWorkingMessage(`Removing worktree ${beadId}...`);

          Logger.info(Component.GIT, `Removing worktree for ${beadId}`);
          await withGitLock(eventStore, PluginToolName.REMOVE_WORKTREE, beadId, async () => {
            await git([GitSubcommand.WORKTREE, 'remove', GitFlag.FORCE, worktreePath]);
          });

          if (ctx?.hasUI) {
            ctx.ui.notify(`Worktree removed: ${beadId}`, 'info');
            ctx.ui.setWorkingMessage(undefined);
          }
          await eventStore.record(DomainEventName.WORKTREE_REMOVED, { beadId, path: worktreePath });
          return { success: true };
        } catch (error) {
          await eventStore.record(DomainEventName.WORKTREE_REMOVE_FAILED, { beadId, error: String(error) }).catch(() => {});
          Logger.error(Component.GIT, `Failed to remove worktree for ${beadId}`, { error: String(error) });
          if (ctx?.hasUI) {
            ctx.ui.notify(`Failed to remove worktree: ${String(error)}`, 'error');
            ctx.ui.setWorkingMessage(undefined);
          }
          return { success: false, error: String(error) };
        }
      }
    },
    {
      name: PluginToolName.MERGE_AND_COMMIT,
      description: 'Merge the worktree branch into the target branch.',
      parameters: Type.Object({
        beadId: Type.String({ description: 'The Bead identifier' }),
        message: Type.Optional(Type.String({ description: 'The merge commit message' })),
        targetBranch: Type.Optional(Type.String({ description: 'Branch to merge into' })),
        closeAfterMerge: Type.Optional(Type.Boolean({ description: 'Harness-owned terminal finalization: close the Bead after a clean staged merge. Bead state is propagated via the embedded Dolt DB; the JSONL export is no longer touched.' })),
        closeReason: Type.Optional(Type.String({ description: 'Close reason to record when closeAfterMerge is true.' }))
      }),
      execute: async ({
        beadId,
        message,
        targetBranch = WorktreeDefaults.TARGET_BRANCH,
        closeAfterMerge,
        closeReason
      }: {
        beadId: string;
        message?: string;
        targetBranch?: string;
        closeAfterMerge?: boolean;
        closeReason?: string;
      }, ctx?: any) => {
        try {
          assertSafeBeadId(beadId);
          const branchName = branchNameFor(beadId);
          const worktreePath = path.join(process.cwd(), WorktreeDefaults.ROOT_DIR, beadId);
          const commitMessage = message || `Complete ${beadId}`;

          if (ctx?.hasUI) ctx.ui.setWorkingMessage(`Merging ${beadId} into ${targetBranch}...`);

          Logger.info(Component.GIT, `Committing and merging ${branchName} into ${targetBranch}`, { message: commitMessage });
          await eventStore.record(DomainEventName.MERGE_AND_COMMIT_STARTED, { beadId, branchName, targetBranch, message: commitMessage });
          await withGitLock(eventStore, PluginToolName.MERGE_AND_COMMIT, beadId, async () => {
            if (fs.existsSync(worktreePath) && (await git([GitSubcommand.STATUS, GitFlag.PORCELAIN], worktreePath)).trim()) {
              await git([GitSubcommand.ADD, GitFlag.ALL], worktreePath);
              await git([GitSubcommand.COMMIT, GitFlag.MESSAGE, commitMessage], worktreePath);
            }
            await git([GitSubcommand.SWITCH, targetBranch]);
            await unstageIndexBeforeMerge(eventStore, beadId, targetBranch);
            const args = commitMessage
              ? [GitSubcommand.MERGE, GitFlag.NO_FF, GitFlag.NO_COMMIT, branchName, GitFlag.MESSAGE, commitMessage]
              : [GitSubcommand.MERGE, GitFlag.NO_FF, GitFlag.NO_COMMIT, branchName];
            await git(args);
            const conflicts = await unmergedPaths();
            if (conflicts.length > 0) {
              throw new Error(`Merge produced unresolved conflicts: ${conflicts.join(', ')}`);
            }
            await git([GitSubcommand.COMMIT, GitFlag.MESSAGE, commitMessage]);
            if (closeAfterMerge) {
              const closeTool = bdPlugin?.tools.find(tool => tool.name === PluginToolName.BD_UPDATE_STATUS);
              if (!closeTool) throw new Error('Cannot close Bead during merge: bd_update_status tool is unavailable.');
              await closeTool.execute({ id: beadId, status: BeadStatus.COMPLETED, notes: closeReason || commitMessage }, ctx);
            }
          });

          if (ctx?.hasUI) {
            ctx.ui.notify(`Merged ${beadId} into ${targetBranch}`, 'info');
            ctx.ui.setWorkingMessage(undefined);
          }
          await eventStore.record(DomainEventName.MERGE_AND_COMMIT_SUCCEEDED, { beadId, branchName, targetBranch, message: commitMessage });
          return { success: true };
        } catch (error) {
          let abortError: string | undefined;
          try {
            await abortMergeIfNeeded();
          } catch (abortFailure) {
            abortError = String(abortFailure);
          }
          await eventStore.record(DomainEventName.MERGE_AND_COMMIT_FAILED, { beadId, targetBranch, error: String(error), abortError }).catch(() => {});
          Logger.error(Component.GIT, `Failed to merge for ${beadId}`, { error: String(error) });
          if (ctx?.hasUI) {
            ctx.ui.notify(`Failed to merge: ${String(error)}`, 'error');
            ctx.ui.setWorkingMessage(undefined);
          }
          return { success: false, error: String(error) };
        }
      }
    }
  ]
  };
}
