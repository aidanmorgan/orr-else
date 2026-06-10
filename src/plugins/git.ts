import { Type } from "@earendil-works/pi-ai";
import * as path from 'path';
import * as fs from 'fs';
import * as lockfile from 'proper-lockfile';
import { Logger } from '../core/Logger.js';
import { EventStore } from '../core/EventStore.js';
import { BeadStatus, DomainEventName, PluginToolName, WorktreePreserveReason } from '../constants/domain.js';
import { Component, EnvVars, FileMutationPolicyDefaults, OtelAttr, SpanName, TransactionalStateDefaults, WorktreeDefaults } from '../constants/infra.js';
import type { Observability } from '../core/Observability.js';
import type { ConfigLoader } from '../core/ConfigLoader.js';
import type { MergeResult, RuntimePlugin, RuntimeTool } from '../core/RuntimeServices.js';
import type { BeadCompletionPort, WorktreeResult } from '../core/OrchestrationPorts.js';
import { type GitWorkingTreePort, nodeGitWorkingTreePort } from '../core/GitWorkingTreePort.js';
import { type FileSystemPort, nodeFileSystemPort } from '../core/FileSystemPort.js';

const appendFileAsync = fs.promises.appendFile;
const mkdirAsync = fs.promises.mkdir;
const readFileAsync = fs.promises.readFile;
const writeFileAsync = fs.promises.writeFile;

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

async function withGitLock<T>(
  eventStore: EventStore,
  operation: PluginToolName,
  beadId: string | undefined,
  lockFile: string,
  fn: () => Promise<T>
): Promise<T> {
  await mkdirAsync(path.dirname(lockFile), { recursive: true });
  await writeFileAsync(lockFile, '', { flag: 'a' });

  const release = await lockfile.lock(lockFile, {
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
    path: lockFile
  });

  try {
    return await fn();
  } finally {
    await release();
    await eventStore.record(DomainEventName.GIT_LOCK_RELEASED, {
      beadId,
      operation,
      path: lockFile
    });
  }
}

function branchNameFor(beadId: string): string {
  return `${WorktreeDefaults.BRANCH_PREFIX}${beadId}`;
}

function assertSafeBeadId(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid Bead ID format');
}

function splitGitPathLines(output: string): string[] {
  return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function safeRelativeRestorePath(filePath: string): string | null {
  const normalized = filePath.replaceAll(path.sep, '/').replace(/^\.\//, '');
  if (!normalized || path.isAbsolute(normalized) || normalized.startsWith('../')) return null;
  return normalized;
}

export type { WorktreeResult, MergeResult };

export function createGitPlugin(
  eventStore: EventStore,
  configLoader?: ConfigLoader,
  beadCompletionPort?: BeadCompletionPort,
  projectRoot: string = process.cwd(),
  getLiveTeammateBeadIds?: () => Promise<Set<string>>,
  observability?: Observability,
  gitPort: GitWorkingTreePort = nodeGitWorkingTreePort,
  fsPort: FileSystemPort = nodeFileSystemPort
): RuntimePlugin {
  const gitLockFile = path.join(projectRoot, WorktreeDefaults.GIT_LOCK_FILE);

  async function currentBranch(repoRoot: string): Promise<string> {
    const out = await gitPort.run([GitSubcommand.BRANCH, GitFlag.SHOW_CURRENT], repoRoot);
    return out.trim();
  }

  async function hasHead(repoRoot: string): Promise<boolean> {
    try {
      await gitPort.run([GitSubcommand.REV_PARSE, 'HEAD'], repoRoot);
      return true;
    } catch {
      return false;
    }
  }

  async function localBranchExists(branchName: string, repoRoot: string): Promise<boolean> {
    try {
      await gitPort.run([GitSubcommand.REV_PARSE, GitFlag.VERIFY, `refs/heads/${branchName}`], repoRoot);
      return true;
    } catch {
      return false;
    }
  }

  async function worktreeExcludePath(worktreePath: string): Promise<string> {
    const rawPath = (await gitPort.run([GitSubcommand.REV_PARSE, '--git-path', 'info/exclude'], worktreePath)).trim();
    return path.isAbsolute(rawPath) ? rawPath : path.resolve(worktreePath, rawPath);
  }

  async function stagedPaths(cwd: string): Promise<string[]> {
    return splitGitPathLines(await gitPort.run([GitSubcommand.DIFF, GitFlag.CACHED, GitFlag.NAME_ONLY], cwd));
  }

  async function unmergedPaths(cwd: string): Promise<string[]> {
    return splitGitPathLines(await gitPort.run([GitSubcommand.DIFF, GitFlag.NAME_ONLY, '--diff-filter=U'], cwd));
  }

  async function abortMergeIfNeeded(repoRoot: string): Promise<void> {
    const unmerged = await unmergedPaths(repoRoot);
    if (unmerged.length === 0) return;
    await gitPort.run([GitSubcommand.MERGE, GitFlag.ABORT], repoRoot);
  }

  async function unstageIndexBeforeMerge(beadId: string, targetBranch: string, repoRoot: string): Promise<void> {
    const paths = await stagedPaths(repoRoot);
    if (paths.length === 0) return;
    await gitPort.run([GitSubcommand.RESTORE, GitFlag.STAGED, GitFlag.ARG_SEPARATOR, ...paths], repoRoot);
    await eventStore.record(DomainEventName.GIT_INDEX_UNSTAGED, {
      beadId,
      targetBranch,
      paths,
      reason: 'prepare harness-owned merge without committing pre-existing index state'
    });
  }

  async function configureOperationalExcludes(
    beadId: string,
    worktreePath: string
  ): Promise<void> {
    const excludePath = await worktreeExcludePath(worktreePath);
    const existing = fsPort.existsSync(excludePath) ? await readFileAsync(excludePath, 'utf8') : '';
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

  async function autoRestoreConfiguredPaths(
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
      const status = await gitPort.run([GitSubcommand.STATUS, GitFlag.PORCELAIN, GitFlag.ARG_SEPARATOR, filePath], worktreePath);
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
      await gitPort.run([
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

  /**
   * Attempt to auto-remove a worktree after a successful merge.
   *
   * Gating (all three must pass inside the git lock):
   *   1. NOT ACTIVE — no live teammate pane for this bead (cheapest check; avoids unnecessary I/O)
   *   2. NOT DIRTY  — `git status --porcelain` is empty
   *   3. MERGED     — no unmerged commits from the bead branch remain on the target branch
   *
   * When all gates pass the worktree is removed and `git worktree prune` is run to
   * clear stale metadata.  On any gate failure the worktree is preserved and a
   * concise WORKTREE_AUTO_REMOVE_PRESERVED event is emitted with an explicit reason code.
   *
   * MERGE_AND_COMMIT success behaviour is preserved: a removal failure never fails
   * the merge — this function is always best-effort and logged.
   */
  async function autoRemoveWorktreeAfterMerge(
    beadId: string,
    branchName: string,
    targetBranch: string,
    worktreePath: string
  ): Promise<void> {
    if (!fsPort.existsSync(worktreePath)) return;

    await withGitLock(eventStore, PluginToolName.REMOVE_WORKTREE, beadId, gitLockFile, async () => {
      // Re-check existence inside the lock (another process may have removed it).
      if (!fsPort.existsSync(worktreePath)) return;

      // Gate 1: NOT ACTIVE — no live teammate pane for this bead.
      // Checked first (cheapest): if unavailable, preserve conservatively.
      if (getLiveTeammateBeadIds) {
        let liveBeadIds: Set<string>;
        try {
          liveBeadIds = await getLiveTeammateBeadIds();
        } catch {
          await eventStore.record(DomainEventName.WORKTREE_AUTO_REMOVE_PRESERVED, {
            beadId,
            worktree: path.basename(worktreePath),
            reason: WorktreePreserveReason.UNKNOWN
          });
          Logger.warn(Component.GIT, `Auto-remove skipped: could not determine liveness for ${beadId}`, {
            reason: WorktreePreserveReason.UNKNOWN
          });
          return;
        }
        if (liveBeadIds.has(beadId)) {
          await eventStore.record(DomainEventName.WORKTREE_AUTO_REMOVE_PRESERVED, {
            beadId,
            worktree: path.basename(worktreePath),
            reason: WorktreePreserveReason.ACTIVE
          });
          Logger.info(Component.GIT, `Auto-remove skipped: worktree ${beadId} has a live teammate`, {
            reason: WorktreePreserveReason.ACTIVE
          });
          return;
        }
      }

      // Gate 2: NOT DIRTY — check for uncommitted or untracked changes.
      const statusOutput = await gitPort.run([GitSubcommand.STATUS, GitFlag.PORCELAIN], worktreePath);
      if (statusOutput.trim()) {
        await eventStore.record(DomainEventName.WORKTREE_AUTO_REMOVE_PRESERVED, {
          beadId,
          worktree: path.basename(worktreePath),
          reason: WorktreePreserveReason.DIRTY
        });
        Logger.info(Component.GIT, `Auto-remove skipped: worktree ${beadId} has uncommitted changes`, {
          reason: WorktreePreserveReason.DIRTY
        });
        return;
      }

      // Gate 3: MERGED — confirm the branch commits are all reachable from the target branch.
      // `git merge-base --is-ancestor <branch> <target>` exits:
      //   0 → branch IS an ancestor of target (fully merged) → proceed to remove
      //   1 → branch is NOT an ancestor (unmerged commits remain) → PRESERVE with UNMERGED
      //   other / error → fail-safe → PRESERVE with UNKNOWN
      //
      // simpleGit.raw() returns empty string for BOTH exit 0 and exit 1 — it only
      // throws on fatal errors (exit 128).  We must inspect the exit code explicitly,
      // so mergeBaseIsAncestor uses execa with reject:false to capture it without throwing on non-zero.
      const mergeCheckExitCode = await gitPort.mergeBaseIsAncestor(branchName, targetBranch, projectRoot);
      if (mergeCheckExitCode === undefined) {
        // gitPort.mergeBaseIsAncestor threw (e.g. git binary not found) — fail-safe
        await eventStore.record(DomainEventName.WORKTREE_AUTO_REMOVE_PRESERVED, {
          beadId,
          worktree: path.basename(worktreePath),
          reason: WorktreePreserveReason.UNKNOWN
        });
        Logger.warn(Component.GIT, `Auto-remove skipped: merge-base check threw unexpectedly for ${branchName}`, {
          reason: WorktreePreserveReason.UNKNOWN
        });
        return;
      }
      if (mergeCheckExitCode === 1) {
        // Not an ancestor — unmerged commits remain on the bead branch.
        await eventStore.record(DomainEventName.WORKTREE_AUTO_REMOVE_PRESERVED, {
          beadId,
          worktree: path.basename(worktreePath),
          reason: WorktreePreserveReason.UNMERGED
        });
        Logger.info(Component.GIT, `Auto-remove skipped: branch ${branchName} not fully merged into ${targetBranch}`, {
          reason: WorktreePreserveReason.UNMERGED
        });
        return;
      }
      if (mergeCheckExitCode !== 0) {
        // Unexpected exit code (128 = fatal git error, etc.) — fail-safe preserve.
        await eventStore.record(DomainEventName.WORKTREE_AUTO_REMOVE_PRESERVED, {
          beadId,
          worktree: path.basename(worktreePath),
          reason: WorktreePreserveReason.UNKNOWN
        });
        Logger.warn(Component.GIT, `Auto-remove skipped: merge-base check returned unexpected exit code ${mergeCheckExitCode} for ${branchName}`, {
          reason: WorktreePreserveReason.UNKNOWN
        });
        return;
      }

      // All gates passed — remove the worktree.
      await gitPort.run([GitSubcommand.WORKTREE, 'remove', GitFlag.FORCE, worktreePath], projectRoot);

      // Prune stale worktree metadata from git's internal tracking.
      await gitPort.run([GitSubcommand.WORKTREE, 'prune'], projectRoot);

      await eventStore.record(DomainEventName.WORKTREE_AUTO_REMOVED, {
        beadId,
        worktree: path.basename(worktreePath),
        branchName,
        targetBranch
      });
      Logger.info(Component.GIT, `Auto-removed merged worktree for ${beadId}`, {
        worktree: path.basename(worktreePath)
      });
    });
  }

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
      execute: async (params: unknown, ctx?: unknown): Promise<WorktreeResult> => {
        const { beadId, baseBranch } = params as { beadId: string; baseBranch?: string };
        const ui = ctx as { hasUI?: boolean; ui?: { setWorkingMessage: (m: string | undefined) => void; notify: (m: string, t: string) => void } } | undefined;
        try {
          assertSafeBeadId(beadId);
          const worktreePath = path.join(projectRoot, WorktreeDefaults.ROOT_DIR, beadId);
          if (fsPort.existsSync(worktreePath)) {
            Logger.info(Component.GIT, `Worktree already exists for ${beadId}. Reusing.`);
            await withGitLock(eventStore, PluginToolName.CREATE_WORKTREE, beadId, gitLockFile, async () => {
              await autoRestoreConfiguredPaths(beadId, worktreePath);
            });
            await configureOperationalExcludes(beadId, worktreePath);
            await eventStore.record(DomainEventName.WORKTREE_REUSED, { beadId, path: worktreePath });
            return { success: true, path: worktreePath };
          }

          if (ui?.hasUI) ui.ui?.setWorkingMessage(`Creating worktree for ${beadId}...`);

          const branchName = branchNameFor(beadId);
          await withGitLock(eventStore, PluginToolName.CREATE_WORKTREE, beadId, gitLockFile, async () => {
            const repositoryHasHead = await hasHead(projectRoot);
            const resolvedBaseBranch = repositoryHasHead ? (baseBranch || await currentBranch(projectRoot)) : undefined;
            Logger.info(Component.GIT, `Creating worktree for ${beadId}${resolvedBaseBranch ? ` from ${resolvedBaseBranch}` : ' as orphan bootstrap worktree'}`, { branchName });

            const branchExists = await localBranchExists(branchName, projectRoot);

            const args = !repositoryHasHead
              ? [GitSubcommand.WORKTREE, GitSubcommand.ADD, '--orphan', '-b', branchName, worktreePath]
              : branchExists
              ? [GitSubcommand.WORKTREE, GitSubcommand.ADD, worktreePath, branchName]
              : [GitSubcommand.WORKTREE, GitSubcommand.ADD, '-b', branchName, worktreePath, resolvedBaseBranch!];
            await gitPort.run(args, projectRoot);
          });
          await configureOperationalExcludes(beadId, worktreePath);
          await autoRestoreConfiguredPaths(beadId, worktreePath);

          if (ui?.hasUI) {
            ui.ui?.notify(`Worktree created for ${beadId}`, 'info');
            ui.ui?.setWorkingMessage(undefined);
          }
          await eventStore.record(DomainEventName.WORKTREE_CREATED, { beadId, path: worktreePath, branchName });
          return { success: true, path: worktreePath };
        } catch (error) {
          await eventStore.record(DomainEventName.WORKTREE_CREATE_FAILED, { beadId, error: String(error) }).catch(() => {});
          Logger.error(Component.GIT, `Failed to create worktree for ${beadId}`, { error: String(error) });
          if (ui?.hasUI) {
            ui.ui?.notify(`Failed to create worktree: ${String(error)}`, 'error');
            ui.ui?.setWorkingMessage(undefined);
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
      execute: async (params: unknown, ctx?: unknown): Promise<MergeResult> => {
        const { beadId, force } = params as { beadId: string; force?: boolean };
        const ui = ctx as { hasUI?: boolean; ui?: { setWorkingMessage: (m: string | undefined) => void; notify: (m: string, t: string) => void; confirm: (title: string, msg: string) => Promise<boolean> } } | undefined;
        try {
          assertSafeBeadId(beadId);
          const worktreePath = path.join(projectRoot, WorktreeDefaults.ROOT_DIR, beadId);
          if (!fsPort.existsSync(worktreePath)) {
            await eventStore.record(DomainEventName.WORKTREE_REMOVE_SKIPPED, { beadId, path: worktreePath, reason: 'missing' });
            return { success: true };
          }

          if (ui?.hasUI && !force) {
            const confirmed = await ui.ui?.confirm(
              'Remove Worktree',
              `Are you sure you want to remove the worktree for ${beadId}? Uncommitted changes will be lost.`
            );
            if (!confirmed) return { success: false, error: 'User cancelled worktree removal' };
          }

          if (ui?.hasUI) ui.ui?.setWorkingMessage(`Removing worktree ${beadId}...`);

          Logger.info(Component.GIT, `Removing worktree for ${beadId}`);
          await withGitLock(eventStore, PluginToolName.REMOVE_WORKTREE, beadId, gitLockFile, async () => {
            await gitPort.run([GitSubcommand.WORKTREE, 'remove', GitFlag.FORCE, worktreePath], projectRoot);
          });

          if (ui?.hasUI) {
            ui.ui?.notify(`Worktree removed: ${beadId}`, 'info');
            ui.ui?.setWorkingMessage(undefined);
          }
          await eventStore.record(DomainEventName.WORKTREE_REMOVED, { beadId, path: worktreePath });
          return { success: true };
        } catch (error) {
          await eventStore.record(DomainEventName.WORKTREE_REMOVE_FAILED, { beadId, error: String(error) }).catch(() => {});
          Logger.error(Component.GIT, `Failed to remove worktree for ${beadId}`, { error: String(error) });
          if (ui?.hasUI) {
            ui.ui?.notify(`Failed to remove worktree: ${String(error)}`, 'error');
            ui.ui?.setWorkingMessage(undefined);
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
      execute: async (params: unknown, ctx?: unknown): Promise<MergeResult> => {
        const {
          beadId,
          message,
          targetBranch = WorktreeDefaults.TARGET_BRANCH,
          closeAfterMerge,
          closeReason
        } = params as {
          beadId: string;
          message?: string;
          targetBranch?: string;
          closeAfterMerge?: boolean;
          closeReason?: string;
        };
        const ui = ctx as { hasUI?: boolean; ui?: { setWorkingMessage: (m: string | undefined) => void; notify: (m: string, t: string) => void } } | undefined;

        const mergeStartMs = Date.now();
        let mergeSuccess = false;

        try {
          assertSafeBeadId(beadId);
          const branchName = branchNameFor(beadId);
          const worktreePath = path.join(projectRoot, WorktreeDefaults.ROOT_DIR, beadId);
          const commitMessage = message || `Complete ${beadId}`;

          if (ui?.hasUI) ui.ui?.setWorkingMessage(`Merging ${beadId} into ${targetBranch}...`);

          Logger.info(Component.GIT, `Committing and merging ${branchName} into ${targetBranch}`, { message: commitMessage });
          await eventStore.record(DomainEventName.MERGE_AND_COMMIT_STARTED, { beadId, branchName, targetBranch, message: commitMessage });
          await withGitLock(eventStore, PluginToolName.MERGE_AND_COMMIT, beadId, gitLockFile, async () => {
            if (fsPort.existsSync(worktreePath) && (await gitPort.run([GitSubcommand.STATUS, GitFlag.PORCELAIN], worktreePath)).trim()) {
              await gitPort.run([GitSubcommand.ADD, GitFlag.ALL], worktreePath);
              await gitPort.run([GitSubcommand.COMMIT, GitFlag.MESSAGE, commitMessage], worktreePath);
            }
            await gitPort.run([GitSubcommand.SWITCH, targetBranch], projectRoot);
            await unstageIndexBeforeMerge(beadId, targetBranch, projectRoot);
            const args = commitMessage
              ? [GitSubcommand.MERGE, GitFlag.NO_FF, GitFlag.NO_COMMIT, branchName, GitFlag.MESSAGE, commitMessage]
              : [GitSubcommand.MERGE, GitFlag.NO_FF, GitFlag.NO_COMMIT, branchName];
            await gitPort.run(args, projectRoot);
            const conflicts = await unmergedPaths(projectRoot);
            if (conflicts.length > 0) {
              throw new Error(`Merge produced unresolved conflicts: ${conflicts.join(', ')}`);
            }
            await gitPort.run([GitSubcommand.COMMIT, GitFlag.MESSAGE, commitMessage], projectRoot);
            if (closeAfterMerge) {
              if (!beadCompletionPort) throw new Error('Cannot close Bead during merge: bead completion port is unavailable.');
              await beadCompletionPort.updateStatus(beadId, BeadStatus.COMPLETED, closeReason || commitMessage, ctx);
            }
          });

          mergeSuccess = true;

          if (ui?.hasUI) {
            ui.ui?.notify(`Merged ${beadId} into ${targetBranch}`, 'info');
            ui.ui?.setWorkingMessage(undefined);
          }
          await eventStore.record(DomainEventName.MERGE_AND_COMMIT_SUCCEEDED, { beadId, branchName, targetBranch, message: commitMessage });

          try {
            observability?.recordCompletedSpan(SpanName.BEAD_MERGE_CLOSE, {
              [OtelAttr.ORR_ELSE_BEAD_ID]: beadId || undefined,
              'merge.success': true
            }, mergeStartMs, Date.now());
          } catch { /* best-effort: telemetry must never fail the merge */ }

          // Best-effort auto-remove: never fails the merge.
          await autoRemoveWorktreeAfterMerge(
            beadId,
            branchName,
            targetBranch,
            worktreePath
          ).catch(removeError => {
            Logger.warn(Component.GIT, `Auto-remove of worktree for ${beadId} failed (non-fatal)`, {
              worktree: path.basename(worktreePath),
              error: String(removeError)
            });
          });

          return { success: true };
        } catch (error) {
          if (!mergeSuccess) {
            try {
              observability?.recordCompletedSpan(SpanName.BEAD_MERGE_CLOSE, {
                [OtelAttr.ORR_ELSE_BEAD_ID]: beadId || undefined,
                'merge.success': false
              }, mergeStartMs, Date.now());
            } catch { /* best-effort */ }
          }
          let abortError: string | undefined;
          try {
            await abortMergeIfNeeded(projectRoot);
          } catch (abortFailure) {
            abortError = String(abortFailure);
          }
          await eventStore.record(DomainEventName.MERGE_AND_COMMIT_FAILED, { beadId, targetBranch, error: String(error), abortError }).catch(() => {});
          Logger.error(Component.GIT, `Failed to merge for ${beadId}`, { error: String(error) });
          if (ui?.hasUI) {
            ui.ui?.notify(`Failed to merge: ${String(error)}`, 'error');
            ui.ui?.setWorkingMessage(undefined);
          }
          return { success: false, error: String(error) };
        }
      }
    }
  ] satisfies RuntimeTool[]
  };
}
