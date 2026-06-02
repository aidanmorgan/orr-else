/**
 * Path argument normalization and root-escape validation for projectTools.
 * Package-internal — do not import from outside src/plugins/.
 */
import path from 'path';
import { resolveTemplateString } from '../../core/PiIntegration.js';
import type { TemplateContext } from '../../core/PiIntegration.js';
import type {
  ProjectCommandToolConfig,
  ProjectMcpToolConfig,
  ProjectToolPathArgumentConfig
} from '../../core/domain/StateModels.js';
import { CwdMode } from '../../constants/index.js';
import {
  PathArgumentConfigKey,
  ProjectToolRootKind,
  PROJECT_TOOL_CONTROL_PARAMETERS,
  ProjectToolParameter
} from './constants.js';
import type {
  CommandArgumentPathNormalization,
  CommandArgumentPathRejection,
  PathArgumentEscapeGuidance,
  PathArgumentRootResolution
} from './types.js';
// Local pure helpers — duplicated to avoid circular imports
function isInsidePath(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

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

export class PathArgumentRootEscapeError extends Error {
  readonly guidance: PathArgumentEscapeGuidance;

  constructor(message: string, guidance: PathArgumentEscapeGuidance) {
    super(message);
    this.name = 'PathArgumentRootEscapeError';
    this.guidance = guidance;
  }
}

export function pathArgumentRootKind(config: ProjectToolPathArgumentConfig): string {
  const configuredRootKind = config[PathArgumentConfigKey.ROOT_KIND];
  if (typeof configuredRootKind === 'string' && configuredRootKind.trim()) {
    return configuredRootKind;
  }
  const root = config[PathArgumentConfigKey.ROOT];
  if (root === CwdMode.PROJECT || root === CwdMode.WORKTREE || root === ProjectToolRootKind.FRAMEWORK) return root;
  return ProjectToolRootKind.WORKTREE;
}

function resolvePathAgainst(baseDir: string, value: string, templateContext: TemplateContext): string {
  const resolved = resolveTemplateString(value, templateContext);
  return path.isAbsolute(resolved) ? resolved : path.resolve(baseDir, resolved);
}

export function resolvePathArgumentRoot(config: ProjectToolPathArgumentConfig, templateContext: TemplateContext): PathArgumentRootResolution {
  const rootKind = pathArgumentRootKind(config);
  if (rootKind === ProjectToolRootKind.WORKTREE) {
    return { path: templateContext.worktreePath, kind: rootKind };
  }
  if (rootKind === ProjectToolRootKind.PROJECT) {
    return { path: templateContext.projectRoot, kind: rootKind };
  }
  if (rootKind === ProjectToolRootKind.FRAMEWORK) {
    if (!templateContext.frameworkRoot) {
      throw new Error('Project tool path argument uses framework root, but no framework root is available.');
    }
    return { path: templateContext.frameworkRoot, kind: rootKind };
  }
  if (rootKind === ProjectToolRootKind.WORKSPACE) {
    const workspaceRoot = config[PathArgumentConfigKey.WORKSPACE_ROOT];
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
      throw new Error('Project tool path argument uses workspace root, but workspaceRoot is not configured.');
    }
    return { path: resolvePathAgainst(templateContext.projectRoot, workspaceRoot, templateContext), kind: rootKind };
  }
  // Named root: check if rootKind matches a key in namedRoots (generic project-defined roots).
  if (templateContext.namedRoots && Object.prototype.hasOwnProperty.call(templateContext.namedRoots, rootKind)) {
    const namedRootPath = templateContext.namedRoots[rootKind]!;
    return { path: namedRootPath, kind: rootKind };
  }
  return {
    path: resolveCwdValue(config[PathArgumentConfigKey.ROOT] || CwdMode.WORKTREE, templateContext),
    kind: 'configured'
  };
}

function stripConfiguredVirtualRoot(value: string, virtualRoot: string): string | undefined {
  const normalizedValue = value.replace(/\\/g, '/');
  const normalizedRoot = virtualRoot.replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalizedRoot) return undefined;
  if (normalizedValue === normalizedRoot) return '';
  return normalizedValue.startsWith(`${normalizedRoot}/`)
    ? normalizedValue.slice(normalizedRoot.length + 1)
    : undefined;
}

function pathArgumentExpectedRelativeForm(rootKind: string): string {
  const normalizedRootKind = rootKind.trim() || 'configured';
  return `<path-relative-to-${normalizedRootKind}-root>`;
}

function pathArgumentVirtualRootForm(virtualRoot: string, expectedRelativeForm: string): string {
  const normalizedRoot = virtualRoot.replace(/\\/g, '/').replace(/\/+$/g, '');
  return normalizedRoot ? `${normalizedRoot}/${expectedRelativeForm}` : expectedRelativeForm;
}

export function pathArgumentEscapeGuidance(
  root: PathArgumentRootResolution,
  virtualRoots: string[]
): PathArgumentEscapeGuidance {
  const rootKind = root.kind.trim() || 'configured';
  const expectedRelativeForm = pathArgumentExpectedRelativeForm(rootKind);
  const virtualRootForms = virtualRoots.map(virtualRoot => pathArgumentVirtualRootForm(virtualRoot, expectedRelativeForm));
  const acceptedForms = [expectedRelativeForm, ...virtualRootForms];
  return {
    rootKind,
    allowedRoot: root.path,
    expectedRelativeForm,
    acceptedForms,
    remediation: [
      `Use a path inside the configured ${rootKind} root (${root.path}).`,
      `Pass ${acceptedForms.join(' or ')}; do not pass unrelated absolute paths or paths from a different configured root.`
    ]
  };
}

function pathArgumentEscapeMessage(
  toolName: string,
  argumentName: string,
  value: string,
  root: PathArgumentRootResolution,
  guidance: PathArgumentEscapeGuidance
): string {
  const acceptedForms = guidance.acceptedForms.length > 1
    ? ` Accepted path forms: ${guidance.acceptedForms.join(' or ')}.`
    : '';
  return `Project tool ${toolName} path argument ${argumentName} escapes configured ${root.kind} root: ${value}. ` +
    `Allowed root: ${guidance.allowedRoot}. Expected relative form: ${guidance.expectedRelativeForm}.${acceptedForms}`;
}

export function normalizePathArgumentValue(
  toolName: string,
  argumentName: string,
  value: string,
  config: ProjectToolPathArgumentConfig,
  templateContext: TemplateContext
): string {
  const root = resolvePathArgumentRoot(config, templateContext);
  const virtualRoots = (config[PathArgumentConfigKey.VIRTUAL_ROOTS] || [])
    .map(rootValue => resolveTemplateString(rootValue, templateContext))
    .sort((left, right) => right.length - left.length);
  let candidate: string | undefined;

  for (const virtualRoot of virtualRoots) {
    const relativeSuffix = stripConfiguredVirtualRoot(value, virtualRoot);
    if (relativeSuffix !== undefined) {
      candidate = path.resolve(root.path, relativeSuffix);
      break;
    }
  }

  if (!candidate) {
    const resolvedValue = resolveTemplateString(value, templateContext);
    candidate = path.isAbsolute(resolvedValue)
      ? path.resolve(resolvedValue)
      : path.resolve(root.path, resolvedValue);
  }

  if (config[PathArgumentConfigKey.MUST_STAY_INSIDE_ROOT] !== false && !isInsidePath(root.path, candidate)) {
    const guidance = pathArgumentEscapeGuidance(root, virtualRoots);
    throw new PathArgumentRootEscapeError(
      pathArgumentEscapeMessage(toolName, argumentName, value, root, guidance),
      guidance
    );
  }

  return candidate;
}

export function normalizeMcpPathArguments(
  definition: ProjectMcpToolConfig,
  requested: unknown,
  operation: string,
  argumentsRecord: Record<string, unknown>,
  templateContext: TemplateContext
): { arguments: Record<string, unknown>; normalizedPathArguments: string[] } {
  const pathArguments = operationPathArguments(definition, requested, operation);
  const normalizedArguments: Record<string, unknown> = { ...argumentsRecord };
  const normalizedPathArguments: string[] = [];

  for (const [argumentName, config] of Object.entries(pathArguments)) {
    const value = normalizedArguments[argumentName];
    if (typeof value === 'string') {
      normalizedArguments[argumentName] = normalizePathArgumentValue(
        definition.name,
        argumentName,
        value,
        config,
        templateContext
      );
      normalizedPathArguments.push(argumentName);
    } else if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
      normalizedArguments[argumentName] = value.map(item => normalizePathArgumentValue(
        definition.name,
        argumentName,
        item,
        config,
        templateContext
      ));
      normalizedPathArguments.push(argumentName);
    }
  }

  return { arguments: normalizedArguments, normalizedPathArguments };
}

function operationPathArguments(
  definition: ProjectMcpToolConfig,
  requested: unknown,
  operation: string
): Record<string, ProjectToolPathArgumentConfig> {
  const pathArguments = definition.pathArguments || {};
  const requestedOperation = typeof requested === 'string' && requested.trim()
    ? requested.trim()
    : undefined;
  return (requestedOperation && pathArguments[requestedOperation]) || pathArguments[operation] || {};
}

// ---- Command path normalization ----

export function normalizeConfiguredCliFlag(flag: string): string {
  const trimmed = flag.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith('-') ? trimmed.replace(/=.*$/, '') : toFlagName(trimmed);
}

function splitCliFlagAssignment(arg: string): { flag: string; value: string } | undefined {
  if (!arg.startsWith('-')) return undefined;
  const equalsIndex = arg.indexOf('=');
  if (equalsIndex < 1) return undefined;
  return {
    flag: arg.slice(0, equalsIndex),
    value: arg.slice(equalsIndex + 1)
  };
}

function splitTestSelector(value: string): { pathPart: string; suffix: string } {
  const selectorIndex = value.indexOf('::');
  if (selectorIndex < 0) return { pathPart: value, suffix: '' };
  return {
    pathPart: value.slice(0, selectorIndex),
    suffix: value.slice(selectorIndex)
  };
}

function looksLikePathValue(value: string): boolean {
  const candidate = splitTestSelector(value.trim()).pathPart;
  if (!candidate) return false;
  return path.isAbsolute(candidate)
    || candidate === '.'
    || candidate === '..'
    || candidate.startsWith('./')
    || candidate.startsWith('../')
    || candidate.includes('/')
    || candidate.includes('\\');
}

function normalizeCommandPathValue(
  toolName: string,
  argumentName: string,
  value: string,
  config: import('../../core/domain/StateModels.js').ProjectCommandArgumentPathConfig,
  templateContext: TemplateContext,
  requirePathLike: boolean
): { value: string; normalized: boolean } {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
        const normalizedItems = parsed.map(item => normalizeCommandPathValue(
          toolName,
          argumentName,
          item,
          config,
          templateContext,
          requirePathLike
        ).value);
        return { value: JSON.stringify(normalizedItems), normalized: true };
      }
    } catch {
      // Fall through to normal scalar handling so invalid JSON is left to the tool wrapper.
    }
  }

  if (requirePathLike && !looksLikePathValue(trimmed)) {
    return { value, normalized: false };
  }

  const selector = splitTestSelector(trimmed);
  const normalizedPath = normalizePathArgumentValue(
    toolName,
    argumentName,
    selector.pathPart,
    config,
    templateContext
  );
  return {
    value: `${normalizedPath}${selector.suffix}`,
    normalized: true
  };
}

function commandArgumentPathRejection(error: unknown, argumentName: string, value: string): CommandArgumentPathRejection {
  const guidance = error instanceof PathArgumentRootEscapeError ? error.guidance : undefined;
  return {
    argumentName,
    value,
    message: String(error instanceof Error ? error.message : error),
    ...(guidance ? { guidance } : {})
  };
}

export function normalizeCommandArgumentPaths(
  definition: ProjectCommandToolConfig,
  suppliedArgs: string[],
  templateContext: TemplateContext
): CommandArgumentPathNormalization {
  const config = definition.argumentPathScope;
  if (!config) return { arguments: suppliedArgs, normalizedPathArguments: [] };

  const pathFlags = new Set((config.flags || []).map(normalizeConfiguredCliFlag).filter(Boolean));
  const normalizedArgs: string[] = [];
  const normalizedPathArguments: string[] = [];

  for (let index = 0; index < suppliedArgs.length; index += 1) {
    const arg = suppliedArgs[index];

    const inlineFlag = splitCliFlagAssignment(arg);
    if (inlineFlag && pathFlags.has(inlineFlag.flag)) {
      try {
        const normalized = normalizeCommandPathValue(
          definition.name,
          inlineFlag.flag,
          inlineFlag.value,
          config,
          templateContext,
          false
        );
        normalizedArgs.push(`${inlineFlag.flag}=${normalized.value}`);
        normalizedPathArguments.push(inlineFlag.flag);
      } catch (error) {
        return {
          arguments: normalizedArgs,
          normalizedPathArguments,
          rejection: commandArgumentPathRejection(error, inlineFlag.flag, inlineFlag.value)
        };
      }
      continue;
    }

    const normalizedFlag = normalizeConfiguredCliFlag(arg);
    if (pathFlags.has(normalizedFlag)) {
      normalizedArgs.push(arg);
      const value = suppliedArgs[index + 1];
      if (value === undefined) continue;
      try {
        const normalized = normalizeCommandPathValue(
          definition.name,
          normalizedFlag,
          value,
          config,
          templateContext,
          false
        );
        normalizedArgs.push(normalized.value);
        normalizedPathArguments.push(normalizedFlag);
        index += 1;
      } catch (error) {
        return {
          arguments: normalizedArgs,
          normalizedPathArguments,
          rejection: commandArgumentPathRejection(error, normalizedFlag, value)
        };
      }
      continue;
    }

    if (config.positionals === true && !arg.startsWith('-')) {
      try {
        const normalized = normalizeCommandPathValue(
          definition.name,
          `argv[${index}]`,
          arg,
          config,
          templateContext,
          true
        );
        normalizedArgs.push(normalized.value);
        if (normalized.normalized) normalizedPathArguments.push(`argv[${index}]`);
      } catch (error) {
        return {
          arguments: normalizedArgs,
          normalizedPathArguments,
          rejection: commandArgumentPathRejection(error, `argv[${index}]`, arg)
        };
      }
      continue;
    }

    normalizedArgs.push(arg);
  }

  return { arguments: normalizedArgs, normalizedPathArguments };
}

function toFlagName(key: string): string {
  const prefix = key.startsWith('--') ? '--' : key.startsWith('-') ? '-' : '--';
  const optionName = key
    .replace(/^-+/, '')
    .replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)
    .replace(/_/g, '-');
  return `${prefix}${optionName}`;
}
