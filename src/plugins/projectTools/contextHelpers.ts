/**
 * Execution context building, CWD/path resolution, and backpressure helpers.
 * Package-internal — do not import from outside src/plugins/.
 */
import path from 'path';
import { v7 as uuidv7 } from 'uuid';
import { resolveTemplateString, type TemplateContext } from '../../core/PiIntegration.js';
import { ToolCallPathFactory } from '../../core/ToolCallPathFactory.js';
import type { ProjectToolConfig, ProjectCommandToolConfig } from '../../core/domain/StateModels.js';
import type { InFlightProjectToolCall, ProjectToolBackpressure } from '../../core/RuntimeServices.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from '../../core/RuntimeEnvironment.js';
import { Logger } from '../../core/Logger.js';
import type { HarnessConfig } from '../../core/ConfigLoader.js';
import { Component, CwdMode, EnvVars, ProjectToolDefaults, ProjectToolType, ToolDefaults, ToolResultStatus } from '../../constants/index.js';
import {
  PathArgumentConfigKey,
  ProjectToolNextAction,
  ProjectToolParameter,
  ProjectToolRootKind
} from './constants.js';
import type { ProjectToolExecutionContext } from './types.js';
import { ProjectToolFailureCategory } from './failureCategory.js';
import { shouldEmitCapsule, buildBackpressureCapsule } from './BackpressureCapsule.js';

function isInsidePath(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export { isInsidePath };

function resolveCwdValue(value: CwdMode | string | undefined, templateContext: TemplateContext): string {
  if (value === CwdMode.WORKTREE) return templateContext.worktreePath;
  if (value === CwdMode.PROJECT) return templateContext.projectRoot;
  if (value === ProjectToolRootKind.FRAMEWORK) {
    if (!templateContext.frameworkRoot) throw new Error('Project tool configured framework root, but no framework root is available.');
    return templateContext.frameworkRoot;
  }
  const resolved = value ? resolveTemplateString(value, templateContext) : undefined;
  if (resolved) return path.isAbsolute(resolved) ? resolved : path.resolve(templateContext.projectRoot, resolved);
  return templateContext.worktreePath;
}

// ---- Exported resolveContextField ----

export function resolveContextField(args: any, keys: [string, ...string[]], envVar?: string, env: RuntimeEnvironment = nodeRuntimeEnvironment): string | undefined {
  for (const key of keys) {
    if (args?.[key]) return args[key];
  }
  for (const key of keys) {
    if (args?.arguments?.[key]) return args.arguments[key];
  }
  return envVar ? env.env(envVar) : undefined;
}

export function beadIdFromArgs(args: any, env?: RuntimeEnvironment): string | undefined {
  return resolveContextField(args, ['beadId', 'id'], EnvVars.BEAD_ID, env);
}

export function stateIdFromArgs(args: any, env?: RuntimeEnvironment): string | undefined {
  return resolveContextField(args, ['stateId', 'state'], EnvVars.STATE_ID, env);
}

export function actionIdFromArgs(args: any, env?: RuntimeEnvironment): string | undefined {
  return resolveContextField(args, ['actionId', 'action'], EnvVars.ACTION_ID, env);
}

function cwdOverrideFromArgs(args: any): string | undefined {
  const value = args?.[ProjectToolParameter.CWD]
    || args?.[ProjectToolParameter.CWD_MODE]
    || args?.[ProjectToolParameter.ARGUMENTS]?.[ProjectToolParameter.CWD]
    || args?.[ProjectToolParameter.ARGUMENTS]?.[ProjectToolParameter.CWD_MODE];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function pathSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value || fallback)
    .replace(ProjectToolDefaults.UNSAFE_PATH_SEGMENT_PATTERN, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || fallback;
}

function frameworkRootFromArgs(args: any, fallbackRoot?: string, env: RuntimeEnvironment = nodeRuntimeEnvironment): string | undefined {
  const value = typeof args?.frameworkRoot === 'string' && args.frameworkRoot.trim()
    ? args.frameworkRoot
    : env.env(EnvVars.FRAMEWORK_ROOT) || fallbackRoot;
  if (!value) return undefined;
  return path.resolve(value);
}

export function frameworkRootFromConfig(config: HarnessConfig, env: RuntimeEnvironment = nodeRuntimeEnvironment, injectedRoot: string = process.cwd()): string | undefined {
  // Fall back to the FRAMEWORK_ROOT environment variable so project configs need not
  // hard-code user-specific absolute paths.  The orrElseFrameworkRoot config key has
  // been retired (pi-experiment-5lbg); configs that set it are rejected at startup.
  const value = env.env(EnvVars.FRAMEWORK_ROOT);
  if (!value || !value.trim()) return undefined;
  const projectRoot = env.env(EnvVars.PROJECT_ROOT) || injectedRoot;
  const context: TemplateContext = {
    projectRoot,
    worktreePath: env.env(EnvVars.WORKTREE_PATH) || projectRoot
  };
  const resolved = resolveTemplateString(value, context);
  return path.isAbsolute(resolved) ? resolved : path.resolve(projectRoot, resolved);
}

/**
 * Resolve `settings.roots` entries from the loaded harness config into
 * absolute paths.  Each value is resolved relative to `projectRoot` when it
 * is not already absolute.  Returns undefined when no roots are configured.
 *
 * This function is intentionally generic — it reads whatever named roots the
 * project has declared without requiring the harness to know their semantics.
 */
export function namedRootsFromConfig(
  config: HarnessConfig,
  env: RuntimeEnvironment = nodeRuntimeEnvironment,
  injectedRoot: string = process.cwd()
): Record<string, string> | undefined {
  const configuredRoots = config.settings.roots;
  if (!configuredRoots || Object.keys(configuredRoots).length === 0) return undefined;
  const projectRoot = env.env(EnvVars.PROJECT_ROOT) || injectedRoot;
  const baseContext: TemplateContext = {
    projectRoot,
    worktreePath: env.env(EnvVars.WORKTREE_PATH) || projectRoot
  };
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(configuredRoots)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const expandedValue = resolveTemplateString(value, baseContext);
    resolved[name] = path.isAbsolute(expandedValue)
      ? expandedValue
      : path.resolve(projectRoot, expandedValue);
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/**
 * Extract namedRoots from tool invocation args (injected as a hidden context
 * parameter by the plugin layer when the config has settings.roots).
 */
function namedRootsFromArgs(args: any): Record<string, string> | undefined {
  const value = args?.namedRoots;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  // Ensure all values are strings (filter out any non-string entries defensively).
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') result[k] = v;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function baseTemplateContext(definition: ProjectToolConfig, args: any, env: RuntimeEnvironment = nodeRuntimeEnvironment, injectedRoot: string = process.cwd()): TemplateContext {
  const projectRoot = env.env(EnvVars.PROJECT_ROOT) || injectedRoot;
  const worktreeRoot = env.env(EnvVars.WORKTREE_PATH) || projectRoot;
  return {
    configPath: env.env(EnvVars.CONFIG_PATH),
    projectRoot,
    worktreePath: worktreeRoot,
    frameworkRoot: frameworkRootFromArgs(args, projectRoot, env),
    namedRoots: namedRootsFromArgs(args),
    beadId: pathSegment(beadIdFromArgs(args, env), ProjectToolDefaults.UNASSIGNED_BEAD_ID),
    stateId: pathSegment(stateIdFromArgs(args, env), ProjectToolDefaults.UNSPECIFIED_STATE_ID),
    actionId: pathSegment(actionIdFromArgs(args, env), ProjectToolDefaults.UNSPECIFIED_ACTION_ID),
    toolName: pathSegment(definition.name, definition.name)
  };
}

function resolveToolCwd(definition: ProjectToolConfig, templateContext: TemplateContext, args: any): string {
  if (definition.type !== ProjectToolType.COMMAND) return templateContext.worktreePath;
  const configuredCwd = (definition as ProjectCommandToolConfig).allowCwdOverride
    ? cwdOverrideFromArgs(args) || (definition as ProjectCommandToolConfig).cwd
    : (definition as ProjectCommandToolConfig).cwd;
  return resolveCwdValue(configuredCwd, templateContext);
}

export function executionContext(
  pathFactory: ToolCallPathFactory,
  definition: ProjectToolConfig,
  args: any,
  env: RuntimeEnvironment = nodeRuntimeEnvironment,
  injectedRoot: string = process.cwd(),
  hostEnv: Record<string, string | undefined> = {}
): ProjectToolExecutionContext {
  const initialContext = baseTemplateContext(definition, args, env, injectedRoot);
  const cwd = resolveToolCwd(definition, initialContext, args);
  const invocationContext = {
    ...initialContext,
    toolInvocationId: uuidv7()
  };
  const allocation = pathFactory.allocate(invocationContext);
  const allocatedContext = {
    ...invocationContext,
    toolCallDir: allocation.callDir,
    toolOutputDir: allocation.outputDir,
    toolOutputFile: allocation.outputFile,
    toolTmpDir: allocation.tmpDir
  };
  return {
    templateContext: allocatedContext,
    cwd,
    callDir: allocation.callDir,
    outputDir: allocation.outputDir,
    outputFile: allocation.outputFile,
    tmpDir: allocation.tmpDir,
    hostEnv
  };
}

export function projectToolEnvironment(context: ProjectToolExecutionContext): Record<string, string> {
  // Build named-root env vars: each entry in namedRoots becomes
  // HARNESS_ROOT_<UPPER_NAME> so project tools can reference them without
  // hard-coding absolute paths.
  const namedRootEnv: Record<string, string> = {};
  if (context.templateContext.namedRoots) {
    for (const [name, rootPath] of Object.entries(context.templateContext.namedRoots)) {
      const envKey = `HARNESS_ROOT_${name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
      namedRootEnv[envKey] = rootPath;
    }
  }

  return {
    [EnvVars.PROJECT_ROOT]: context.templateContext.projectRoot,
    [EnvVars.WORKTREE_PATH]: context.templateContext.worktreePath,
    [EnvVars.BEAD_ID]: context.templateContext.beadId || ProjectToolDefaults.UNASSIGNED_BEAD_ID,
    [EnvVars.STATE_ID]: context.templateContext.stateId || ProjectToolDefaults.UNSPECIFIED_STATE_ID,
    [EnvVars.ACTION_ID]: context.templateContext.actionId || ProjectToolDefaults.UNSPECIFIED_ACTION_ID,
    [EnvVars.TOOL_NAME]: context.templateContext.toolName || ProjectToolDefaults.UNASSIGNED_BEAD_ID,
    [EnvVars.TOOL_INVOCATION_ID]: context.templateContext.toolInvocationId || '',
    [EnvVars.TOOL_CALL_DIR]: context.callDir,
    [EnvVars.TOOL_OUTPUT_DIR]: context.outputDir,
    [EnvVars.TOOL_OUTPUT_FILE]: context.outputFile,
    [EnvVars.TOOL_TMP_DIR]: context.tmpDir,
    [EnvVars.TOOL_WORKING_DIR]: context.cwd,
    ...(context.templateContext.frameworkRoot ? { [EnvVars.FRAMEWORK_ROOT]: context.templateContext.frameworkRoot } : {}),
    ...namedRootEnv,
    TMPDIR: context.tmpDir,
    TMP: context.tmpDir,
    TEMP: context.tmpDir
  };
}

// ---- Backpressure helpers ----

function projectToolBackpressureKey(definition: ProjectToolConfig, context: ProjectToolExecutionContext): string {
  const templateContext = context.templateContext;
  return [
    templateContext.projectRoot,
    templateContext.worktreePath,
    templateContext.beadId || ProjectToolDefaults.UNASSIGNED_BEAD_ID,
    templateContext.stateId || ProjectToolDefaults.UNSPECIFIED_STATE_ID,
    templateContext.actionId || ProjectToolDefaults.UNSPECIFIED_ACTION_ID,
    definition.name
  ].join('\0');
}

function projectToolBackpressureStaleMs(definition: ProjectToolConfig): number {
  const configured = definition.wrapperTimeoutMs;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : ToolDefaults.WRAPPER_TIMEOUT_MS;
}

export function reserveProjectToolCall(backpressure: ProjectToolBackpressure, definition: ProjectToolConfig, context: ProjectToolExecutionContext): { key: string; existing?: InFlightProjectToolCall } {
  const key = projectToolBackpressureKey(definition, context);
  const existing = backpressure.get(key);
  const now = Date.now();
  if (existing) {
    const staleMs = projectToolBackpressureStaleMs(definition);
    if (now - existing.startedAtMs <= staleMs) {
      // Increment the collision count so the caller can gate on capsule vs verbose text.
      existing.collisionCount += 1;
      return { key, existing };
    }
    Logger.warn(Component.PROJECT_TOOLS, 'Discarding stale in-flight project-tool backpressure entry', {
      tool: definition.name,
      beadId: context.templateContext.beadId,
      stateId: context.templateContext.stateId,
      actionId: context.templateContext.actionId,
      staleMs,
      ageMs: now - existing.startedAtMs
    });
  }

  backpressure.set(key, {
    token: context.templateContext.toolInvocationId || uuidv7(),
    startedAtMs: now,
    collisionCount: 0
  });
  return { key };
}

export function releaseProjectToolCall(backpressure: ProjectToolBackpressure, key: string, token: string | undefined): void {
  const existing = backpressure.get(key);
  if (!existing || existing.token !== token) return;
  backpressure.delete(key);
}

export function projectToolBackpressureResult(
  definition: ProjectToolConfig,
  context: ProjectToolExecutionContext,
  existing: InFlightProjectToolCall
): Record<string, unknown> {
  const ageMs = Math.max(0, Date.now() - existing.startedAtMs);

  // On repeated collisions (2nd+), emit a compact coordination capsule INSTEAD of
  // repeating the verbose text.  The first collision (collisionCount === 1) still
  // gets the full explanation so the agent sees it once.
  if (shouldEmitCapsule(existing.collisionCount)) {
    return buildBackpressureCapsule(
      definition.name,
      context.templateContext.beadId || '',
      context.templateContext.stateId || '',
      context.templateContext.actionId || '',
      ageMs
    ) as Record<string, unknown>;
  }

  return {
    tool: definition.name,
    status: ToolResultStatus.REJECTED,
    failureCategory: ProjectToolFailureCategory.BACKPRESSURE,
    message: `REJECTED: \`${definition.name}\` is already running for this bead/state/action. Wait for the in-flight result before starting another \`${definition.name}\` call; rerun narrower only after that result is visible.`,
    inFlight: {
      ageMs,
      toolInvocationId: existing.token,
      beadId: context.templateContext.beadId,
      stateId: context.templateContext.stateId,
      actionId: context.templateContext.actionId
    },
    nextAction: ProjectToolNextAction.WAIT_FOR_IN_FLIGHT_RESULT,
    recovery: [
      'Use the result from the project-tool call that is already in progress.',
      'If more evidence is still required after that result, rerun the same configured project tool once with narrower arguments.'
    ]
  };
}

export function projectToolRunEventData(
  definition: ProjectToolConfig,
  context: ProjectToolExecutionContext,
  beadId: string | undefined,
  stateId: string | undefined,
  actionId: string | undefined
): Record<string, unknown> {
  return {
    beadId,
    stateId,
    actionId,
    tool: definition.name,
    type: definition.type,
    cwd: context.cwd,
    toolInvocationId: context.templateContext.toolInvocationId
  };
}
