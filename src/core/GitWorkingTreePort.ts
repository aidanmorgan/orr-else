/**
 * GitWorkingTreePort — narrow interface for git working-tree operations.
 *
 * Replaces direct execa('git') calls in TransactionalStateGuard, PlanWriteSet,
 * and the git plugin (git.ts) so those classes can be tested with fake git
 * adapters without spawning real git processes.
 *
 * INJECTABLE: the real implementation delegates to execa. Tests inject a fake.
 */

import { execa } from 'execa';
import { FileMutationPolicyDefaults, TransactionalStateDefaults } from '../constants/infra.js';
import { CommandExitCode } from '../constants/infra.js';

export interface GitCheckIgnoreResult {
  isIgnored: boolean;
  stdout: string;
}

export interface GitWorkingTreePort {
  /**
   * Run `git status --porcelain=v1 --untracked-files=all -z` in the given
   * worktree directory and return the raw stdout.
   * Throws on git error.
   */
  porcelainStatus(worktreePath: string): Promise<string>;

  /**
   * Run `git restore --source=HEAD -- <paths>` in the given worktree.
   * Throws on git error.
   */
  restoreFromHead(worktreePath: string, paths: string[]): Promise<void>;

  /**
   * Run `git ls-files --error-unmatch -- <filePath>` in the given worktree.
   * Returns true when the path is tracked.
   */
  isTrackedPath(worktreePath: string, filePath: string): Promise<boolean>;

  /**
   * Run `git check-ignore --verbose -- <filePath>` in the given worktree.
   * Returns { isIgnored: true, stdout } when the path is git-ignored,
   * { isIgnored: false, stdout: '' } when it is not.
   */
  checkIgnore(worktreePath: string, filePath: string): Promise<GitCheckIgnoreResult>;

  /**
   * Run an arbitrary `git <args>` command in the given cwd directory.
   * Throws on non-zero exit (same semantics as the old simpleGit.raw() wrapper).
   * Returns the raw stdout string.
   *
   * Used by the git plugin to execute worktree/status/commit/merge/switch/restore
   * commands without keeping a module-local simpleGit wrapper.
   */
  run(args: string[], cwd: string): Promise<string>;

  /**
   * Run `git merge-base --is-ancestor <branch> <target>` in the given cwd.
   * Returns the exit code (0 = ancestor, 1 = not ancestor, undefined = fatal error).
   * Never throws — fatal errors return undefined.
   */
  mergeBaseIsAncestor(branch: string, target: string, cwd: string): Promise<number | undefined>;
}

/**
 * Real GitWorkingTreePort implementation — delegates to execa.
 */
export const nodeGitWorkingTreePort: GitWorkingTreePort = {
  async porcelainStatus(worktreePath: string): Promise<string> {
    const { stdout } = await execa('git', [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '-z'
    ], {
      cwd: worktreePath,
      maxBuffer: TransactionalStateDefaults.GIT_STATUS_MAX_BUFFER_BYTES
    });
    return stdout;
  },

  async restoreFromHead(worktreePath: string, paths: string[]): Promise<void> {
    await execa(FileMutationPolicyDefaults.GIT_COMMAND, [
      FileMutationPolicyDefaults.GIT_RESTORE_SUBCOMMAND,
      TransactionalStateDefaults.GIT_SOURCE_OPTION,
      TransactionalStateDefaults.GIT_HEAD_REF,
      FileMutationPolicyDefaults.ARG_SEPARATOR,
      ...paths
    ], {
      cwd: worktreePath,
      maxBuffer: TransactionalStateDefaults.GIT_STATUS_MAX_BUFFER_BYTES
    });
  },

  async isTrackedPath(worktreePath: string, filePath: string): Promise<boolean> {
    const result = await execa(FileMutationPolicyDefaults.GIT_COMMAND, [
      'ls-files',
      '--error-unmatch',
      FileMutationPolicyDefaults.ARG_SEPARATOR,
      filePath
    ], {
      cwd: worktreePath,
      reject: false,
      maxBuffer: TransactionalStateDefaults.GIT_STATUS_MAX_BUFFER_BYTES
    });
    return result.exitCode === CommandExitCode.SUCCESS;
  },

  async checkIgnore(worktreePath: string, filePath: string): Promise<GitCheckIgnoreResult> {
    const result = await execa(FileMutationPolicyDefaults.GIT_COMMAND, [
      TransactionalStateDefaults.GIT_CHECK_IGNORE_SUBCOMMAND,
      '--verbose',
      FileMutationPolicyDefaults.ARG_SEPARATOR,
      filePath
    ], {
      cwd: worktreePath,
      reject: false,
      maxBuffer: TransactionalStateDefaults.GIT_STATUS_MAX_BUFFER_BYTES
    });
    if (result.exitCode !== CommandExitCode.SUCCESS) {
      return { isIgnored: false, stdout: '' };
    }
    return { isIgnored: true, stdout: result.stdout };
  },

  async run(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execa(FileMutationPolicyDefaults.GIT_COMMAND, args, {
      cwd,
      maxBuffer: TransactionalStateDefaults.GIT_STATUS_MAX_BUFFER_BYTES
    });
    return stdout;
  },

  async mergeBaseIsAncestor(branch: string, target: string, cwd: string): Promise<number | undefined> {
    try {
      const result = await execa(
        FileMutationPolicyDefaults.GIT_COMMAND,
        ['merge-base', '--is-ancestor', branch, target],
        { cwd, reject: false }
      );
      return result.exitCode;
    } catch {
      return undefined;
    }
  }
};
