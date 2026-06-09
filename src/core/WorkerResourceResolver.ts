/**
 * WorkerResourceResolver — worker skill/extension path resolution with injected
 * filesystem and config ports.
 *
 * pi-experiment-amq0.13: extracted verbatim from PiIntegration.ts.
 *
 * All fs.existsSync calls go through the injected FileSystemPort so this module
 * is testable without real filesystem access.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { HarnessConfig } from './ConfigLoader.js';
import { DEFAULT_OBSERVED_PI_TOOLS } from '../constants/infra.js';
import { resolveTemplateString, type TemplateContext } from './TemplateResolver.js';

/** Injected filesystem port — allows testing without real disk I/O. */
export interface FileSystemPort {
  existsSync(filePath: string): boolean;
}

/** Default production implementation backed by the real fs module. */
export function nodeFileSystemPort(): FileSystemPort {
  return { existsSync: (p) => fs.existsSync(p) };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim().length > 0))];
}

function resolveProjectPath(projectRoot: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(projectRoot, configuredPath);
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
  primaryExtensionPath: string,
  fsPort: FileSystemPort = nodeFileSystemPort()
): string[] {
  const configuredPaths = unique([
    primaryExtensionPath,
    ...(config.settings.pi?.workerExtensions || [])
  ]);

  return configuredPaths.map(configuredPath => {
    const resolvedPath = resolveProjectPath(projectRoot, configuredPath);
    if (!fsPort.existsSync(resolvedPath)) {
      throw new Error(`Configured Pi worker extension does not exist: ${configuredPath} (${resolvedPath})`);
    }
    return resolvedPath;
  });
}

export function resolvePiSkillPaths(
  config: HarnessConfig,
  projectRoot: string,
  fsPort: FileSystemPort = nodeFileSystemPort()
): string[] {
  return unique(config.settings.pi?.skillPaths || []).map(configuredPath => {
    const resolvedPath = resolveProjectPath(projectRoot, configuredPath);
    if (!fsPort.existsSync(resolvedPath)) {
      throw new Error(`Configured Pi skill path does not exist: ${configuredPath} (${resolvedPath})`);
    }
    return resolvedPath;
  });
}

/**
 * Convention: skill name "foo" maps to <projectRoot>/.pi/skills/foo/SKILL.md
 */
const SKILL_FILE_NAME = 'SKILL.md';
const SKILLS_BASE_DIR = '.pi/skills';

export interface ResolvedSkill {
  name: string;
  path: string;
}

function resolveGlobalSkills(
  config: HarnessConfig,
  projectRoot: string,
  fsPort: FileSystemPort,
  excludePaths?: Set<string>
): ResolvedSkill[] {
  return unique(config.settings.pi?.skillPaths || []).flatMap(configuredPath => {
    const resolvedPath = resolveProjectPath(projectRoot, configuredPath);
    if (!fsPort.existsSync(resolvedPath)) {
      throw new Error(`Configured Pi skill path does not exist: ${configuredPath} (${resolvedPath})`);
    }
    if (excludePaths?.has(resolvedPath)) return [];
    return [{ name: path.basename(path.dirname(resolvedPath)), path: resolvedPath }];
  });
}

/**
 * Resolve skill paths for a specific state worker.
 *
 * Resolution order:
 *  1. If the named state exists and has a non-empty `skills` array, resolve each
 *     skill name to <projectRoot>/.pi/skills/<name>/SKILL.md. Missing skills throw.
 *  2. Global skills from settings.pi.skillPaths are appended after state skills.
 *  3. Fallback (no stateId, unknown state, or empty state.skills): behaves like
 *     resolvePiSkillPaths — returns only the global skillPaths list.
 *
 * The existing resolvePiSkillPaths is left unchanged so extension.ts callers are
 * unaffected.
 */
export function resolvePiSkillPathsForState(
  config: HarnessConfig,
  projectRoot: string,
  stateId?: string,
  fsPort: FileSystemPort = nodeFileSystemPort()
): ResolvedSkill[] {
  const skillsBaseDir = path.resolve(projectRoot, SKILLS_BASE_DIR);
  const state = stateId ? config.states?.[stateId] : undefined;
  const stateSkillNames = state?.skills && state.skills.length > 0 ? state.skills : undefined;

  if (stateSkillNames) {
    // State-scoped resolution: map each skill name to its SKILL.md path.
    const stateSkills: ResolvedSkill[] = unique(stateSkillNames).map(skillName => {
      const skillPath = path.join(projectRoot, SKILLS_BASE_DIR, skillName, SKILL_FILE_NAME);
      // Guard against path-traversal: the resolved path must remain inside .pi/skills.
      if (!path.resolve(skillPath).startsWith(skillsBaseDir + path.sep)) {
        throw new Error(
          `State "${stateId}" references skill "${skillName}" whose resolved path escapes the skills directory. ` +
          `Skill names must not contain path separators or ".." segments.`
        );
      }
      if (!fsPort.existsSync(skillPath)) {
        throw new Error(
          `State "${stateId}" references skill "${skillName}" but no SKILL.md was found at: ${skillPath}`
        );
      }
      return { name: skillName, path: skillPath };
    });

    // Append global skills (settings.pi.skillPaths), deduplicating by resolved path.
    const statePaths = new Set(stateSkills.map(s => s.path));
    return [...stateSkills, ...resolveGlobalSkills(config, projectRoot, fsPort, statePaths)];
  }

  // Fallback: behave exactly like the global resolvePiSkillPaths.
  return resolveGlobalSkills(config, projectRoot, fsPort);
}

export function resolveWorkerArgs(
  config: HarnessConfig,
  context: TemplateContext
): string[] {
  return (config.settings.pi?.workerArgs || []).map(arg => resolveTemplateString(arg, context));
}
