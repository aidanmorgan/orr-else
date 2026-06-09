import * as fs from 'fs';
import * as path from 'path';
import { TransactionalStateDefaults } from '../constants/infra.js';
import type { ArtifactPaths } from './ArtifactPaths.js';
import type { ConfigLoader } from './ConfigLoader.js';
import { nodeGitWorkingTreePort, type GitWorkingTreePort } from './GitWorkingTreePort.js';

interface PlanContractWriteSetEntry {
  path?: string;
}

interface PlanContract {
  writeSet?: Array<string | PlanContractWriteSetEntry>;
}

export interface PlanWriteSetContext {
  beadId?: string;
  stateId?: string;
  worktreePath: string;
  projectRoot?: string;
}

export interface MutationTargetWriteSetContext extends PlanWriteSetContext {
  targetPath: string;
  cwd: string;
  toolLabel: string;
}

export interface PlanWriteSetResolution {
  enforced: boolean;
  allowedWriteSet: string[];
  planContractPath?: string;
  planContractExists: boolean;
}

export interface MutationTargetWriteSetValidation extends PlanWriteSetResolution {
  passed: boolean;
  normalizedTargetPath?: string;
  reason?: string;
}

export interface IgnoredWriteSetPath {
  path: string;
  source?: string;
  line?: number;
  pattern?: string;
  rule?: string;
}

export interface PlanWriteSetPreflightValidation extends PlanWriteSetResolution {
  passed: boolean;
  ignoredWriteSetPaths: IgnoredWriteSetPath[];
  reason?: string;
}

const readFileAsync = fs.promises.readFile;

export class PlanWriteSet {
  constructor(
    private readonly configLoader: ConfigLoader,
    private readonly artifactPaths: ArtifactPaths,
    private readonly projectRoot: string = process.cwd(),
    private readonly git: GitWorkingTreePort = nodeGitWorkingTreePort
  ) {}

  public async resolve(context: PlanWriteSetContext): Promise<PlanWriteSetResolution> {
    const config = await this.configLoader.load();
    const settings = config.settings.transactionalState;
    if (!settings?.enabled || !settings.requireWriteSet || !context.beadId) {
      return {
        enforced: false,
        allowedWriteSet: [],
        planContractExists: false
      };
    }

    const planContractPath = await this.resolvePlanContractPath(context);
    const planContractExists = Boolean(planContractPath && fs.existsSync(planContractPath));
    if (!planContractExists) {
      return {
        enforced: true,
        allowedWriteSet: [],
        planContractPath,
        planContractExists: false
      };
    }

    const allowedWriteSet = await this.allowedWriteSet(planContractPath, context.worktreePath, context.projectRoot);
    return {
      enforced: true,
      allowedWriteSet,
      planContractPath,
      planContractExists: true
    };
  }

  public async validatePlanContract(context: PlanWriteSetContext): Promise<PlanWriteSetPreflightValidation> {
    const resolution = await this.resolve(context);
    return this.validateResolvedWriteSet(resolution, context.worktreePath);
  }

  public async validateProposedPlanContract(
    content: string,
    context: PlanWriteSetContext
  ): Promise<PlanWriteSetPreflightValidation> {
    const config = await this.configLoader.load();
    const settings = config.settings.transactionalState;
    if (!settings?.enabled || !settings.requireWriteSet || !context.beadId) {
      return this.passedPreflight({
        enforced: false,
        allowedWriteSet: [],
        planContractExists: false
      });
    }

    let parsed: PlanContract;
    try {
      parsed = JSON.parse(content) as PlanContract;
    } catch {
      return this.passedPreflight({
        enforced: true,
        allowedWriteSet: [],
        planContractPath: await this.resolvePlanContractPath(context),
        planContractExists: true
      });
    }

    const resolution: PlanWriteSetResolution = {
      enforced: true,
      allowedWriteSet: this.allowedWriteSetFromContract(parsed, context.worktreePath, context.projectRoot),
      planContractPath: await this.resolvePlanContractPath(context),
      planContractExists: true
    };
    return this.validateResolvedWriteSet(resolution, context.worktreePath);
  }

  public async isPlanContractPath(candidatePath: string, context: PlanWriteSetContext): Promise<boolean> {
    const planContractPath = await this.resolvePlanContractPath(context);
    return Boolean(planContractPath) && path.resolve(candidatePath) === path.resolve(planContractPath!);
  }

  public async validateMutationTarget(context: MutationTargetWriteSetContext): Promise<MutationTargetWriteSetValidation> {
    const resolution = await this.resolve(context);
    if (!resolution.enforced) return { ...resolution, passed: true };

    const normalizedTargetPath = this.normalizeTargetPath(context.targetPath, context.cwd, context.worktreePath);
    if (!normalizedTargetPath) return { ...resolution, passed: true };

    if (resolution.planContractExists && this.isAllowedPath(normalizedTargetPath, resolution.allowedWriteSet)) {
      return {
        ...resolution,
        passed: true,
        normalizedTargetPath
      };
    }

    const reason = resolution.planContractExists
      ? [
        `PROTOCOL VIOLATION: ${context.toolLabel} may only mutate files in the approved plan write set.`,
        `Target \`${normalizedTargetPath}\` is not approved.`,
        resolution.allowedWriteSet.length > 0
          ? `Approved write set: ${resolution.allowedWriteSet.join(', ')}.`
          : `Approved write set is empty in ${resolution.planContractPath || 'plan contract'}.`
      ].join(' ')
      : [
        `PROTOCOL VIOLATION: ${context.toolLabel} attempted to mutate \`${normalizedTargetPath}\` before an approved plan contract was available.`,
        `Expected plan contract: ${resolution.planContractPath || 'unconfigured'}.`
      ].join(' ');

    return {
      ...resolution,
      passed: false,
      normalizedTargetPath,
      reason
    };
  }

  public normalizeConfiguredPath(filePath: string, roots: string[]): string {
    const trimmed = filePath.trim();
    if (!trimmed) return '';
    if (!path.isAbsolute(trimmed)) return this.normalizeRelativePath(trimmed);

    const absolutePath = path.resolve(trimmed);
    for (const root of roots) {
      const relativePath = path.relative(path.resolve(root), absolutePath);
      if (!relativePath || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
        return this.normalizeRelativePath(relativePath || '.');
      }
    }

    return this.normalizeRelativePath(trimmed);
  }

  public isAllowedPath(dirtyPath: string, allowedWriteSet: string[]): boolean {
    const normalizedDirtyPath = this.normalizeRelativePath(dirtyPath);
    return allowedWriteSet.some(allowedPath => {
      const normalizedAllowedPath = this.normalizeRelativePath(allowedPath);
      if (normalizedDirtyPath === normalizedAllowedPath) return true;
      return normalizedAllowedPath.endsWith('/') && normalizedDirtyPath.startsWith(normalizedAllowedPath);
    });
  }

  public normalizeRelativePath(filePath: string): string {
    return filePath.replaceAll(path.sep, '/').replace(/^\.\//, '');
  }

  private async resolvePlanContractPath(context: PlanWriteSetContext): Promise<string | undefined> {
    if (!context.beadId) return undefined;
    const artifactResolution = await this.artifactPaths.resolve({
      beadId: context.beadId,
      stateId: context.stateId,
      artifactId: TransactionalStateDefaults.PLAN_CONTRACT_ARTIFACT_ID
    });
    return artifactResolution.artifactPaths[TransactionalStateDefaults.PLAN_CONTRACT_ARTIFACT_ID];
  }

  private async allowedWriteSet(
    planContractPath: string | undefined,
    worktreePath: string,
    projectRoot: string | undefined
  ): Promise<string[]> {
    if (!planContractPath || !fs.existsSync(planContractPath)) return [];

    const parsed = JSON.parse(await readFileAsync(planContractPath, 'utf8')) as PlanContract;
    return this.allowedWriteSetFromContract(parsed, worktreePath, projectRoot);
  }

  private allowedWriteSetFromContract(
    parsed: PlanContract,
    worktreePath: string,
    projectRoot: string | undefined
  ): string[] {
    const writeSet = parsed.writeSet || [];
    const roots = [worktreePath, projectRoot || this.projectRoot];
    return writeSet
      .map(entry => typeof entry === 'string' ? entry : entry.path || '')
      .filter(Boolean)
      .map(entryPath => this.normalizeConfiguredPath(entryPath, roots))
      .filter(Boolean)
      .sort();
  }

  private async validateResolvedWriteSet(
    resolution: PlanWriteSetResolution,
    worktreePath: string
  ): Promise<PlanWriteSetPreflightValidation> {
    if (!resolution.enforced || !resolution.planContractExists || resolution.allowedWriteSet.length === 0) {
      return this.passedPreflight(resolution);
    }

    const ignoredWriteSetPaths = await this.ignoredUntrackedWriteSetPaths(worktreePath, resolution.allowedWriteSet);
    if (ignoredWriteSetPaths.length === 0) return this.passedPreflight(resolution);

    return {
      ...resolution,
      passed: false,
      ignoredWriteSetPaths,
      reason: this.ignoredWriteSetReason(ignoredWriteSetPaths)
    };
  }

  private passedPreflight(resolution: PlanWriteSetResolution): PlanWriteSetPreflightValidation {
    return {
      ...resolution,
      passed: true,
      ignoredWriteSetPaths: []
    };
  }

  private async ignoredUntrackedWriteSetPaths(
    worktreePath: string,
    allowedWriteSet: string[]
  ): Promise<IgnoredWriteSetPath[]> {
    const ignoredPaths: IgnoredWriteSetPath[] = [];
    const uniqueWriteSet = [...new Set(allowedWriteSet)].sort();
    for (const filePath of uniqueWriteSet) {
      if (!filePath || filePath.startsWith('../') || path.isAbsolute(filePath)) continue;
      if (await this.isTrackedPath(worktreePath, filePath)) continue;
      const ignoreRule = await this.ignoreRuleForPath(worktreePath, filePath);
      if (ignoreRule) ignoredPaths.push(ignoreRule);
    }
    return ignoredPaths.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async isTrackedPath(worktreePath: string, filePath: string): Promise<boolean> {
    return this.git.isTrackedPath(worktreePath, filePath);
  }

  private async ignoreRuleForPath(worktreePath: string, filePath: string): Promise<IgnoredWriteSetPath | null> {
    const result = await this.git.checkIgnore(worktreePath, filePath);
    if (!result.isIgnored) return null;
    return this.parseIgnoreRule(result.stdout, filePath);
  }

  private parseIgnoreRule(stdout: string, filePath: string): IgnoredWriteSetPath {
    const firstLine = stdout.split(/\r?\n/).find(line => line.trim().length > 0) || '';
    const [metadata] = firstLine.split('\t');
    const match = /^(.*?):(\d+):(.*)$/.exec(metadata || '');
    if (!match) return { path: filePath };

    const source = match[1];
    const line = Number.parseInt(match[2], 10);
    const pattern = match[3];
    const rule = [
      source,
      Number.isFinite(line) ? String(line) : undefined,
      pattern
    ].filter(Boolean).join(':');

    return {
      path: filePath,
      source,
      line: Number.isFinite(line) ? line : undefined,
      pattern,
      rule
    };
  }

  private ignoredWriteSetReason(ignoredWriteSetPaths: IgnoredWriteSetPath[]): string {
    const pathList = ignoredWriteSetPaths
      .map(entry => entry.rule ? `${entry.path} (${entry.rule})` : entry.path)
      .join('; ');
    return [
      'Approved plan write set contains ignored paths that Git will not merge.',
      `Ignored write set paths: ${pathList}.`,
      'Choose tracked paths, update the repository ignore rules in the approved write set, or remove these paths from the plan.'
    ].join(' ');
  }

  private normalizeTargetPath(targetPath: string, cwd: string, worktreePath: string): string {
    if (!worktreePath) return '';
    const resolvedPath = path.resolve(path.isAbsolute(targetPath) ? targetPath : path.join(cwd, targetPath));
    const relativePath = path.relative(path.resolve(worktreePath), resolvedPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return '';
    return this.normalizeRelativePath(relativePath || '.');
  }
}
