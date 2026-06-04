import type { PlanWriteSet } from './PlanWriteSet.js';
import type { HarnessConfig, RequiredTool, RequiredToolCondition } from './domain/StateModels.js';

export interface RequiredToolResolverContext {
  beadId?: string;
  stateId?: string;
  worktreePath?: string;
  projectRoot?: string;
  config: HarnessConfig;
}

export interface SkippedRequiredTool {
  name: string;
  reason: string;
}

export interface RequiredToolResolution {
  toolNames: string[];
  skippedTools: SkippedRequiredTool[];
}

const TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;
const PATH_SEPARATOR = '/';
const ARTIFACT_TEMPLATE_PREFIX = 'artifacts.templates.';
const SETTINGS_ARTIFACT_TEMPLATE_PREFIX = 'settings.artifacts.templates.';
const TEMPLATE_EXPANSION_PASSES = 4;
const CONDITION_REASON = {
  WRITE_SET_DOES_NOT_INCLUDE_ANY: 'approved write set does not include any configured path prefix',
  WRITE_SET_DOES_NOT_INCLUDE_ALL: 'approved write set does not include every configured path prefix',
} as const;

export class RequiredToolResolver {
  constructor(
    private readonly planWriteSet: PlanWriteSet,
    private readonly projectRoot: string = process.cwd()
  ) {}

  public async resolve(
    requiredTools: RequiredTool[] | undefined,
    context: RequiredToolResolverContext
  ): Promise<RequiredToolResolution> {
    const toolNames: string[] = [];
    const skippedTools: SkippedRequiredTool[] = [];
    const seen = new Set<string>();

    for (const requiredTool of requiredTools || []) {
      const name = this.requiredToolName(requiredTool);
      if (!name) continue;

      const result = await this.requiredToolApplies(requiredTool, context);
      if (!result.applies) {
        skippedTools.push({ name, reason: result.reason });
        continue;
      }

      if (seen.has(name)) continue;
      seen.add(name);
      toolNames.push(name);
    }

    return { toolNames, skippedTools };
  }

  private requiredToolName(requiredTool: RequiredTool): string {
    return typeof requiredTool === 'string' ? requiredTool : requiredTool.name;
  }

  private async requiredToolApplies(
    requiredTool: RequiredTool,
    context: RequiredToolResolverContext
  ): Promise<{ applies: boolean; reason: string }> {
    if (typeof requiredTool === 'string' || !requiredTool.when) {
      return { applies: true, reason: '' };
    }

    return this.conditionApplies(requiredTool.when, context);
  }

  private async conditionApplies(
    condition: RequiredToolCondition,
    context: RequiredToolResolverContext
  ): Promise<{ applies: boolean; reason: string }> {
    const writeSet = await this.normalizedWriteSet(context);
    const includesAny = this.expandedConditionPaths(condition.writeSetIncludesAny, context);
    const includesAll = this.expandedConditionPaths(condition.writeSetIncludesAll, context);

    if (includesAny.length > 0 && !includesAny.some(candidate => this.writeSetContains(writeSet, candidate))) {
      return { applies: false, reason: CONDITION_REASON.WRITE_SET_DOES_NOT_INCLUDE_ANY };
    }

    if (includesAll.length > 0 && !includesAll.every(candidate => this.writeSetContains(writeSet, candidate))) {
      return { applies: false, reason: CONDITION_REASON.WRITE_SET_DOES_NOT_INCLUDE_ALL };
    }

    return { applies: true, reason: '' };
  }

  private async normalizedWriteSet(context: RequiredToolResolverContext): Promise<string[]> {
    if (!context.beadId || !context.worktreePath) return [];

    const resolution = await this.planWriteSet.resolve({
      beadId: context.beadId,
      stateId: context.stateId,
      worktreePath: context.worktreePath,
      projectRoot: context.projectRoot || this.projectRoot
    });

    return resolution.allowedWriteSet.map(filePath => this.normalizePath(filePath));
  }

  private expandedConditionPaths(
    values: string[] | undefined,
    context: RequiredToolResolverContext
  ): string[] {
    const roots = [context.worktreePath, context.projectRoot || this.projectRoot].filter(Boolean) as string[];
    const paths = (values || []).flatMap(value => {
      const expanded = this.expandTemplate(value, context);
      return [
        this.normalizePath(expanded),
        this.normalizePath(this.planWriteSet.normalizeConfiguredPath(expanded, roots))
      ];
    });
    return [...new Set(paths.filter(Boolean))];
  }

  private expandTemplate(value: string, context: RequiredToolResolverContext): string {
    let expanded = value;
    for (let pass = 0; pass < TEMPLATE_EXPANSION_PASSES; pass += 1) {
      const next = expanded.replace(TEMPLATE_PATTERN, (_match, key: string) => this.templateValue(key, context) || '');
      if (next === expanded) return next;
      expanded = next;
    }
    return expanded;
  }

  private templateValue(key: string, context: RequiredToolResolverContext): string | undefined {
    const trimmedKey = key.trim();
    // Normalize artifact templates (string shorthand OR { path, ... } object) to
    // their path string for template-variable substitution.
    const templates: Record<string, string> = Object.fromEntries(
      Object.entries(context.config.settings.artifacts?.templates || {}).map(
        ([name, entry]) => [name, typeof entry === 'string' ? entry : entry.path]
      )
    );
    const directValues: Record<string, string | undefined> = {
      projectRoot: context.projectRoot || this.projectRoot,
      worktreePath: context.worktreePath,
      beadId: context.beadId,
      stateId: context.stateId,
      ...templates
    };

    if (Object.prototype.hasOwnProperty.call(directValues, trimmedKey)) {
      return directValues[trimmedKey];
    }

    if (trimmedKey.startsWith(ARTIFACT_TEMPLATE_PREFIX)) {
      return templates[trimmedKey.slice(ARTIFACT_TEMPLATE_PREFIX.length)];
    }

    if (trimmedKey.startsWith(SETTINGS_ARTIFACT_TEMPLATE_PREFIX)) {
      return templates[trimmedKey.slice(SETTINGS_ARTIFACT_TEMPLATE_PREFIX.length)];
    }

    return undefined;
  }

  private writeSetContains(writeSet: string[], candidate: string): boolean {
    if (!candidate) return false;
    return writeSet.some(entry => entry === candidate || entry.startsWith(`${candidate}${PATH_SEPARATOR}`));
  }

  private normalizePath(filePath: string): string {
    return filePath.replaceAll('\\', PATH_SEPARATOR).replace(/\/+$/, '');
  }
}
