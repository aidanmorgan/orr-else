import { execFile } from 'child_process';
import { promisify } from 'util';
import { Type } from "@earendil-works/pi-ai";
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../core/Logger.js';
import { EventStore } from '../core/EventStore.js';
import { Component, DomainEventName, PluginToolName, WorktreeDefaults } from '../constants/index.js';

const execFileAsync = promisify(execFile);
const appendFileAsync = fs.promises.appendFile;
const mkdirAsync = fs.promises.mkdir;
const readFileAsync = fs.promises.readFile;
const writeFileAsync = fs.promises.writeFile;
const unlinkAsync = fs.promises.unlink;

const GIT_LOCK_FILE = path.join(process.cwd(), WorktreeDefaults.GIT_LOCK_FILE);

async function git(args: string[], cwd: string = process.cwd()): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

async function withGitLock<T>(
  eventStore: EventStore,
  operation: PluginToolName,
  beadId: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  let retries = WorktreeDefaults.MAX_LOCK_RETRIES;
  while (retries > 0) {
    try {
      if (!fs.existsSync(GIT_LOCK_FILE)) {
        await writeFileAsync(GIT_LOCK_FILE, process.pid.toString());
        await eventStore.record(DomainEventName.GIT_LOCK_ACQUIRED, {
          beadId,
          operation,
          path: GIT_LOCK_FILE
        });
        try {
          return await fn();
        } finally {
          try {
            await unlinkAsync(GIT_LOCK_FILE);
            await eventStore.record(DomainEventName.GIT_LOCK_RELEASED, {
              beadId,
              operation,
              path: GIT_LOCK_FILE
            });
          } catch {}
        }
      }
    } catch (error) {
      // Ignore write errors if another process beat us
    }
    await new Promise(resolve => setTimeout(resolve, WorktreeDefaults.LOCK_WAIT_MS));
    retries--;
  }
  throw new Error('Git lock timeout');
}

function branchNameFor(beadId: string): string {
  return `${WorktreeDefaults.BRANCH_PREFIX}${beadId}`;
}

async function currentBranch(): Promise<string> {
  const out = await git(['branch', '--show-current']);
  return out.trim();
}

async function hasHead(): Promise<boolean> {
  try {
    await git(['rev-parse', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

function assertSafeBeadId(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid Bead ID format');
}

async function worktreeExcludePath(worktreePath: string): Promise<string> {
  const rawPath = (await git(['rev-parse', '--git-path', 'info/exclude'], worktreePath)).trim();
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(worktreePath, rawPath);
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

export function createGitPlugin(eventStore: EventStore) {
  return {
  name: 'git-worktrees',
  tools: [
    {
      name: PluginToolName.CREATE_WORKTREE,
      description: 'Spawn a dedicated Git worktree tied to a Bead identifier.',
      parameters: Type.Object({
        beadId: Type.String({ description: 'The Bead identifier' }),
        baseBranch: Type.String({ description: 'The branch to fork from', optional: true })
      }),
      execute: async ({ beadId, baseBranch }: { beadId: string, baseBranch?: string }, ctx?: any) => {
        try {
          assertSafeBeadId(beadId);
          const worktreePath = path.join(process.cwd(), WorktreeDefaults.ROOT_DIR, beadId);
          if (fs.existsSync(worktreePath)) {
            Logger.info(Component.GIT, `Worktree already exists for ${beadId}. Reusing.`);
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
            
            let branchExists = false;
            try {
              await git(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
              branchExists = true;
            } catch {}

            const args = !repositoryHasHead
              ? ['worktree', 'add', '--orphan', '-b', branchName, worktreePath]
              : branchExists
              ? ['worktree', 'add', worktreePath, branchName]
              : ['worktree', 'add', '-b', branchName, worktreePath, resolvedBaseBranch!];
            await git(args);
          });
          await configureOperationalExcludes(eventStore, beadId, worktreePath);
          
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
        force: Type.Boolean({ description: 'Skip confirmation', optional: true })
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
            await git(['worktree', 'remove', '--force', worktreePath]);
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
        message: Type.String({ description: 'The merge commit message', optional: true }),
        targetBranch: Type.String({ description: 'Branch to merge into', optional: true })
      }),
      execute: async ({ beadId, message, targetBranch = WorktreeDefaults.TARGET_BRANCH }: { beadId: string, message?: string, targetBranch?: string }, ctx?: any) => {
        try {
          assertSafeBeadId(beadId);
          const branchName = branchNameFor(beadId);
          const worktreePath = path.join(process.cwd(), WorktreeDefaults.ROOT_DIR, beadId);
          const commitMessage = message || `Complete ${beadId}`;

          if (ctx?.hasUI) ctx.ui.setWorkingMessage(`Merging ${beadId} into ${targetBranch}...`);

          Logger.info(Component.GIT, `Committing and merging ${branchName} into ${targetBranch}`, { message: commitMessage });
          await eventStore.record(DomainEventName.MERGE_AND_COMMIT_STARTED, { beadId, branchName, targetBranch, message: commitMessage });
          await withGitLock(eventStore, PluginToolName.MERGE_AND_COMMIT, beadId, async () => {
            if (fs.existsSync(worktreePath) && (await git(['status', '--porcelain'], worktreePath)).trim()) {
              await git(['add', '--all'], worktreePath);
              await git(['commit', '-m', commitMessage], worktreePath);
            }
            await git(['switch', targetBranch]);
            const args = commitMessage
              ? ['merge', '--no-ff', branchName, '-m', commitMessage]
              : ['merge', '--no-ff', branchName];
            await git(args);
          });

          if (ctx?.hasUI) {
            ctx.ui.notify(`Merged ${beadId} into ${targetBranch}`, 'info');
            ctx.ui.setWorkingMessage(undefined);
          }
          await eventStore.record(DomainEventName.MERGE_AND_COMMIT_SUCCEEDED, { beadId, branchName, targetBranch, message: commitMessage });
          return { success: true };
        } catch (error) {
          await eventStore.record(DomainEventName.MERGE_AND_COMMIT_FAILED, { beadId, targetBranch, error: String(error) }).catch(() => {});
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
