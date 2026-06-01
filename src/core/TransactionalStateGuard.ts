import { execa } from 'execa';
import { Component, DomainEventName, FileMutationPolicyDefaults, TransactionalStateDefaults } from '../constants/index.js';
import type { BeadId } from '../types/index.js';
import type { ArtifactPaths } from './ArtifactPaths.js';
import type { ConfigLoader } from './ConfigLoader.js';
import type { EventStore } from './EventStore.js';
import { Logger } from './Logger.js';
import type { PlanWriteSet } from './PlanWriteSet.js';

export interface TransactionalStateValidation {
  passed: boolean;
  dirtyPaths: string[];
  allowedWriteSet: string[];
  unapprovedPaths: string[];
  ignoredWriteSetPaths?: string[];
  planContractPath?: string;
  reason?: string;
}

export class TransactionalStateGuard {
  constructor(
    private readonly configLoader: ConfigLoader,
    private readonly artifactPaths: ArtifactPaths,
    private readonly eventStore: EventStore,
    private readonly planWriteSet: PlanWriteSet
  ) {}

  public async validateSuccess(
    beadId: BeadId,
    stateId: string,
    worktreePath: string
  ): Promise<TransactionalStateValidation> {
    const config = await this.configLoader.load();
    const settings = config.settings.transactionalState;
    if (!settings?.enabled || !settings.requireWriteSet) {
      return this.pass();
    }
    if (this.isPrePlanContractState(stateId)) {
      return this.pass();
    }

    const writeSetPreflight = await this.planWriteSet.validatePlanContract({ beadId, stateId, worktreePath });
    const planContractPath = writeSetPreflight.planContractPath;
    const allowedWriteSet = writeSetPreflight.allowedWriteSet;
    const ignoredWriteSetPaths = writeSetPreflight.ignoredWriteSetPaths.map(entry => entry.path);
    if (!writeSetPreflight.passed) {
      const reason = writeSetPreflight.reason || [
        'Approved plan write set contains ignored paths that Git will not merge.',
        `Ignored write set paths: ${ignoredWriteSetPaths.join(', ')}`,
        'Choose tracked paths, update the repository ignore rules in the approved write set, or remove these paths from the plan.'
      ].join(' ');
      const result: TransactionalStateValidation = {
        passed: false,
        dirtyPaths: [],
        allowedWriteSet,
        unapprovedPaths: [],
        ignoredWriteSetPaths,
        planContractPath,
        reason
      };
      await this.eventStore.record(DomainEventName.TRANSACTIONAL_STATE_REJECTED, {
        beadId,
        stateId,
        worktreePath,
        planContractPath,
        dirtyPaths: [],
        allowedWriteSet,
        unapprovedPaths: [],
        ignoredWriteSetPaths,
        reason
      }).catch((error: unknown) => {
        Logger.warn(Component.CORE, 'Failed to record transactional state rejection (ignored write set)', { beadId, stateId, error: String(error) });
      });
      return result;
    }

    const dirtyPaths = await this.changedWorktreePaths(worktreePath);
    if (dirtyPaths.length === 0) return this.pass([], allowedWriteSet, planContractPath);

    let currentDirtyPaths = dirtyPaths;
    let unapprovedPaths = currentDirtyPaths.filter(dirtyPath => !this.planWriteSet.isAllowedPath(dirtyPath, allowedWriteSet));

    if (unapprovedPaths.length > 0) {
      const restoredPaths = await this.restoreConfiguredUnapprovedPaths({
        beadId,
        stateId,
        worktreePath,
        unapprovedPaths,
        configuredPaths: settings.autoRestoreUnapprovedPaths || []
      });
      if (restoredPaths.length > 0) {
        currentDirtyPaths = await this.changedWorktreePaths(worktreePath);
        unapprovedPaths = currentDirtyPaths.filter(dirtyPath => !this.planWriteSet.isAllowedPath(dirtyPath, allowedWriteSet));
      }
    }

    if (unapprovedPaths.length === 0) {
      return this.pass(currentDirtyPaths, allowedWriteSet, planContractPath);
    }

    const reason = [
      'Dirty worktree paths are outside the approved plan write set.',
      `Unapproved paths: ${unapprovedPaths.join(', ')}`,
      allowedWriteSet.length > 0
        ? `Approved write set: ${allowedWriteSet.join(', ')}`
        : `Approved write set is empty or missing in ${planContractPath || 'plan contract'}.`
    ].join(' ');

    const result: TransactionalStateValidation = {
      passed: false,
      dirtyPaths: currentDirtyPaths,
      allowedWriteSet,
      unapprovedPaths,
      planContractPath,
      reason
    };

    await this.eventStore.record(DomainEventName.TRANSACTIONAL_STATE_REJECTED, {
      beadId,
      stateId,
      worktreePath,
      planContractPath,
      dirtyPaths: currentDirtyPaths,
      allowedWriteSet,
      unapprovedPaths,
      reason
    }).catch((error: unknown) => {
      Logger.warn(Component.CORE, 'Failed to record transactional state rejection (unapproved paths)', { beadId, stateId, error: String(error) });
    });

    return result;
  }

  private pass(
    dirtyPaths: string[] = [],
    allowedWriteSet: string[] = [],
    planContractPath?: string
  ): TransactionalStateValidation {
    return {
      passed: true,
      dirtyPaths,
      allowedWriteSet,
      unapprovedPaths: [],
      planContractPath
    };
  }

  private async changedWorktreePaths(worktreePath: string): Promise<string[]> {
    const { stdout } = await execa('git', [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '-z'
    ], {
      cwd: worktreePath,
      maxBuffer: TransactionalStateDefaults.GIT_STATUS_MAX_BUFFER_BYTES
    });

    const entries = stdout.split('\0').filter(Boolean);
    const paths = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.length < TransactionalStateDefaults.PORCELAIN_ENTRY_MIN_LENGTH) continue;
      const status = entry.slice(0, TransactionalStateDefaults.PORCELAIN_STATUS_WIDTH);
      const filePath = entry.slice(TransactionalStateDefaults.PORCELAIN_PATH_START_INDEX);
      paths.add(this.normalizeRelativePath(filePath));

      if (this.isRenameOrCopyStatus(status)) index += 1;
    }

    return [...paths].sort();
  }

  private isRenameOrCopyStatus(status: string): boolean {
    return status.includes(TransactionalStateDefaults.PORCELAIN_RENAME_STATUS)
      || status.includes(TransactionalStateDefaults.PORCELAIN_COPY_STATUS);
  }

  private normalizeRelativePath(filePath: string): string {
    return this.planWriteSet.normalizeRelativePath(filePath);
  }

  private isPrePlanContractState(stateId: string): boolean {
    return (TransactionalStateDefaults.PRE_PLAN_CONTRACT_STATE_IDS as readonly string[]).includes(stateId);
  }

  private async restoreConfiguredUnapprovedPaths({
    beadId,
    stateId,
    worktreePath,
    unapprovedPaths,
    configuredPaths
  }: {
    beadId: BeadId;
    stateId: string;
    worktreePath: string;
    unapprovedPaths: string[];
    configuredPaths: string[];
  }): Promise<string[]> {
    const restorablePaths = this.restorableUnapprovedPaths(unapprovedPaths, configuredPaths);
    if (restorablePaths.length === 0) return [];

    await this.eventStore.record(DomainEventName.TRANSACTIONAL_STATE_AUTO_RESTORE_STARTED, {
      beadId,
      stateId,
      worktreePath,
      paths: restorablePaths
    }).catch(() => {});

    try {
      await execa(FileMutationPolicyDefaults.GIT_COMMAND, [
        FileMutationPolicyDefaults.GIT_RESTORE_SUBCOMMAND,
        TransactionalStateDefaults.GIT_SOURCE_OPTION,
        TransactionalStateDefaults.GIT_HEAD_REF,
        FileMutationPolicyDefaults.ARG_SEPARATOR,
        ...restorablePaths
      ], {
        cwd: worktreePath,
        maxBuffer: TransactionalStateDefaults.GIT_STATUS_MAX_BUFFER_BYTES
      });
      await this.eventStore.record(DomainEventName.TRANSACTIONAL_STATE_AUTO_RESTORE_SUCCEEDED, {
        beadId,
        stateId,
        worktreePath,
        paths: restorablePaths
      }).catch(() => {});
      return restorablePaths;
    } catch (error) {
      await this.eventStore.record(DomainEventName.TRANSACTIONAL_STATE_AUTO_RESTORE_FAILED, {
        beadId,
        stateId,
        worktreePath,
        paths: restorablePaths,
        error: String(error)
      }).catch(() => {});
      return [];
    }
  }

  private restorableUnapprovedPaths(unapprovedPaths: string[], configuredPaths: string[]): string[] {
    const configured = new Set(
      configuredPaths
        .map(filePath => this.normalizeRelativePath(filePath))
        .filter(filePath => filePath && !filePath.startsWith('../'))
    );
    return unapprovedPaths.filter(filePath => configured.has(filePath));
  }
}
