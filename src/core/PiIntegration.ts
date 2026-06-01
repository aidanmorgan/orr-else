import * as fs from 'fs';
import * as path from 'path';
import type { HarnessConfig } from './ConfigLoader.js';
import { DEFAULT_OBSERVED_PI_TOOLS } from '../constants/index.js';

const TemplateToken = {
  CONFIG_PATH: '{{configPath}}',
  PROJECT_ROOT: '{{projectRoot}}',
  WORKTREE_PATH: '{{worktreePath}}',
  FRAMEWORK_ROOT: '{{frameworkRoot}}',
  ORR_ELSE_FRAMEWORK_ROOT: '{{orrElseFrameworkRoot}}',
  BEAD_ID: '{{beadId}}',
  STATE_ID: '{{stateId}}',
  ACTION_ID: '{{actionId}}',
  TOOL_NAME: '{{toolName}}',
  TOOL_INVOCATION_ID: '{{toolInvocationId}}',
  TOOL_CALL_DIR: '{{toolCallDir}}',
  TOOL_OUTPUT_DIR: '{{toolOutputDir}}',
  TOOL_OUTPUT_FILE: '{{toolOutputFile}}',
  TOOL_TMP_DIR: '{{toolTmpDir}}'
} as const;

export interface TemplateContext {
  configPath?: string;
  projectRoot: string;
  worktreePath: string;
  frameworkRoot?: string;
  beadId?: string;
  stateId?: string;
  actionId?: string;
  toolName?: string;
  toolInvocationId?: string;
  toolCallDir?: string;
  toolOutputDir?: string;
  toolOutputFile?: string;
  toolTmpDir?: string;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim().length > 0))];
}

function resolveProjectPath(projectRoot: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(projectRoot, configuredPath);
}

export function resolveTemplateString(value: string, context: TemplateContext): string {
  const replacements: Array<[string, string | undefined]> = [
    [TemplateToken.PROJECT_ROOT, context.projectRoot],
    [TemplateToken.WORKTREE_PATH, context.worktreePath],
    [TemplateToken.FRAMEWORK_ROOT, context.frameworkRoot],
    [TemplateToken.ORR_ELSE_FRAMEWORK_ROOT, context.frameworkRoot],
    [TemplateToken.CONFIG_PATH, context.configPath],
    [TemplateToken.BEAD_ID, context.beadId],
    [TemplateToken.STATE_ID, context.stateId],
    [TemplateToken.ACTION_ID, context.actionId],
    [TemplateToken.TOOL_NAME, context.toolName],
    [TemplateToken.TOOL_INVOCATION_ID, context.toolInvocationId],
    [TemplateToken.TOOL_CALL_DIR, context.toolCallDir],
    [TemplateToken.TOOL_OUTPUT_DIR, context.toolOutputDir],
    [TemplateToken.TOOL_OUTPUT_FILE, context.toolOutputFile],
    [TemplateToken.TOOL_TMP_DIR, context.toolTmpDir]
  ];

  return replacements.reduce(
    (resolved, [token, replacement]) => replacement === undefined ? resolved : resolved.replaceAll(token, replacement),
    value
  );
}

export function getConfiguredPiToolNames(config: HarnessConfig): string[] {
  return unique(config.settings.pi?.tools || []);
}

export function getObservedPiToolNames(config: HarnessConfig): string[] {
  return unique([
    ...DEFAULT_OBSERVED_PI_TOOLS,
    ...(config.settings.pi?.tools || []),
    ...(config.settings.pi?.observedTools || [])
  ]);
}

export function resolveWorkerExtensionPaths(
  config: HarnessConfig,
  projectRoot: string,
  primaryExtensionPath: string
): string[] {
  const configuredPaths = unique([
    primaryExtensionPath,
    ...(config.settings.pi?.workerExtensions || [])
  ]);

  return configuredPaths.map(configuredPath => {
    const resolvedPath = resolveProjectPath(projectRoot, configuredPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Configured Pi worker extension does not exist: ${configuredPath} (${resolvedPath})`);
    }
    return resolvedPath;
  });
}

export function resolvePiSkillPaths(config: HarnessConfig, projectRoot: string): string[] {
  return unique(config.settings.pi?.skillPaths || []).map(configuredPath => {
    const resolvedPath = resolveProjectPath(projectRoot, configuredPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Configured Pi skill path does not exist: ${configuredPath} (${resolvedPath})`);
    }
    return resolvedPath;
  });
}

export function resolveWorkerArgs(
  config: HarnessConfig,
  context: TemplateContext
): string[] {
  return (config.settings.pi?.workerArgs || []).map(arg => resolveTemplateString(arg, context));
}
