import * as crypto from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { HarnessConfig } from './ConfigLoader.js';
import { DEFAULT_OBSERVED_PI_TOOLS, PromptProvenanceKind, PromptProvenanceDefaults } from '../constants/index.js';
import { InstructionLoader } from './InstructionLoader.js';

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

/**
 * Convention: skill name "foo" maps to <projectRoot>/.pi/skills/foo/SKILL.md
 */
const SKILL_FILE_NAME = 'SKILL.md';
const SKILLS_BASE_DIR = '.pi/skills';

export interface ResolvedSkill {
  name: string;
  path: string;
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
function resolveGlobalSkills(config: HarnessConfig, projectRoot: string, excludePaths?: Set<string>): ResolvedSkill[] {
  return unique(config.settings.pi?.skillPaths || []).flatMap(configuredPath => {
    const resolvedPath = resolveProjectPath(projectRoot, configuredPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Configured Pi skill path does not exist: ${configuredPath} (${resolvedPath})`);
    }
    if (excludePaths?.has(resolvedPath)) return [];
    return [{ name: path.basename(path.dirname(resolvedPath)), path: resolvedPath }];
  });
}

export function resolvePiSkillPathsForState(
  config: HarnessConfig,
  projectRoot: string,
  stateId?: string
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
      if (!fs.existsSync(skillPath)) {
        throw new Error(
          `State "${stateId}" references skill "${skillName}" but no SKILL.md was found at: ${skillPath}`
        );
      }
      return { name: skillName, path: skillPath };
    });

    // Append global skills (settings.pi.skillPaths), deduplicating by resolved path.
    const statePaths = new Set(stateSkills.map(s => s.path));
    return [...stateSkills, ...resolveGlobalSkills(config, projectRoot, statePaths)];
  }

  // Fallback: behave exactly like the global resolvePiSkillPaths.
  return resolveGlobalSkills(config, projectRoot);
}

export function resolveWorkerArgs(
  config: HarnessConfig,
  context: TemplateContext
): string[] {
  return (config.settings.pi?.workerArgs || []).map(arg => resolveTemplateString(arg, context));
}

// ---------------------------------------------------------------------------
// Prompt Provenance
// ---------------------------------------------------------------------------

/**
 * Local kind identifier for the state-config-subtree entry.
 *
 * We cannot add to PromptProvenanceKind in constants/index.ts (another bead
 * owns it), so we define a local constant that is stored as the `kind` string
 * on STATE_CONFIG entries.  Kept as a plain string so it round-trips through
 * JSON without any import requirement.
 */
const STATE_CONFIG_KIND = 'stateConfig' as const;

/**
 * A single file entry in a run's prompt provenance record.
 *
 * `path`     — absolute path to the source file on disk, OR a logical identifier
 *              (e.g. `stateConfig:<stateId>`) for non-file entries like the
 *              state-config-subtree hash.
 * `sha256`   — hex SHA-256 of the file's contents (or canonical subtree JSON)
 *              at record time, or '' when missing.
 * `missing`  — true when the file did not exist at record time.
 * `blocking` — when explicitly false, this entry is recorded for AUDIT only and
 *              is excluded from the STALE rejection set.  Omitting this field
 *              (undefined) means the entry IS blocking (default).
 */
export interface PromptProvenanceEntry {
  kind: PromptProvenanceKind | typeof STATE_CONFIG_KIND;
  path: string;
  sha256: string;
  missing?: true;
  blocking?: false;
}

/**
 * The full provenance record stored on STATE_RUN_INITIALIZED.
 *
 * `resolutionFailed` — set to true when the provenance resolver encountered an
 *   unrecoverable error during init.  The completion gate treats this as a
 *   warning (never a hard block) because the agent should not be penalised for
 *   a harness-level resolution problem.
 */
export interface PromptProvenance {
  entries: PromptProvenanceEntry[];
  harnessConfigVersion: string | undefined;
  resolutionFailed?: true;
}

/**
 * Hash a file's contents with SHA-256 and return the hex string.
 * Returns an empty string and sets `missing: true` when the file is absent.
 * Never throws.
 */
function hashFile(filePath: string): { sha256: string; missing?: true } {
  try {
    const content = fs.readFileSync(filePath);
    const sha256 = crypto
      .createHash(PromptProvenanceDefaults.HASH_ALGORITHM)
      .update(content)
      .digest(PromptProvenanceDefaults.HASH_ENCODING);
    return { sha256 };
  } catch {
    return { sha256: PromptProvenanceDefaults.MISSING_HASH, missing: true };
  }
}

/**
 * Parse the raw (unresolved) YAML content of harness.yaml and extract the
 * state subtree for `stateId` as-authored.  Returns `undefined` if the config
 * cannot be parsed or the state is missing.  Never throws.
 *
 * We use the raw YAML (not the resolved HarnessConfig) for the state-config
 * hash because ConfigLoader.resolveFileBackedFields() replaces prompt path
 * strings with the actual file content before returning HarnessConfig. Hashing
 * the resolved config would embed file content that changes independently (and
 * is already tracked by the file-backed STATE_PROMPT provenance entries). Using
 * the raw authored values keeps the state-config hash stable as long as the
 * author's intent (the harness.yaml lines for this state) has not changed.
 */
function readRawStateSubtree(configPath: string, stateId: string): unknown | undefined {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.parse(raw);
    const state = parsed?.states?.[stateId];
    return state ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Serialize the prompt-defining config subtree for a specific state into a
 * canonical, deterministic JSON string (keys sorted recursively) and return its
 * SHA-256 hex digest.
 *
 * Only the fields that govern this state's prompt/behavior are included:
 * identity, baseInstructions, ruleCategories, skills, actions, model,
 * llmProvider, thinking, checklist.  Harness-wide or other-state settings
 * are intentionally excluded so that editing an unrelated state never makes
 * this state's provenance stale.
 *
 * The raw YAML state subtree (not the resolved HarnessConfig) is used so that
 * the hash captures the AUTHORED values (prompt file PATHS as written) rather
 * than the resolved file contents (which are separately tracked by file-backed
 * STATE_PROMPT provenance entries).
 *
 * @param configPath  Absolute path to the harness.yaml file (for raw parsing).
 * @param stateId     The state to hash.
 * @returns `{ sha256, missing: true }` if the state is absent or unparseable.
 * Never throws.
 */
function hashStateConfigSubtree(configPath: string, stateId: string | undefined): { sha256: string; missing?: true } {
  if (!stateId) return { sha256: PromptProvenanceDefaults.MISSING_HASH, missing: true };
  try {
    const rawState = readRawStateSubtree(configPath, stateId);
    if (rawState === undefined) return { sha256: PromptProvenanceDefaults.MISSING_HASH, missing: true };
    // Extract only the prompt/behavior-defining fields from the raw subtree.
    const subtree = rawState as Record<string, unknown>;
    const relevant = {
      identity: subtree['identity'],
      baseInstructions: subtree['baseInstructions'],
      ruleCategories: subtree['ruleCategories'],
      skills: subtree['skills'],
      actions: subtree['actions'],
      model: subtree['model'],
      llmProvider: subtree['llmProvider'],
      thinking: subtree['thinking'],
      checklist: subtree['checklist']
    };
    const canonical = stableStringify(relevant);
    const sha256 = crypto
      .createHash(PromptProvenanceDefaults.HASH_ALGORITHM)
      .update(canonical)
      .digest(PromptProvenanceDefaults.HASH_ENCODING);
    return { sha256 };
  } catch {
    return { sha256: PromptProvenanceDefaults.MISSING_HASH, missing: true };
  }
}

/**
 * Produce a deterministic JSON string with keys sorted recursively.
 * Arrays preserve their order (sorting arrays would change semantics).
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const sorted = Object.keys(value as object).sort();
  const pairs = sorted.map(k => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k]));
  return '{' + pairs.join(',') + '}';
}

/**
 * Detect whether a config string value is a file-path reference rather than
 * inline text.  Mirrors the heuristic used by ConfigLoader.resolveTextReference:
 * if the trimmed value resolves to an existing regular file on disk, it is a
 * file reference.
 */
function resolveFileReference(value: string | undefined, projectRoot: string): string | undefined {
  if (!value || !value.trim()) return undefined;
  const candidate = path.isAbsolute(value) ? value : path.resolve(projectRoot, value.trim());
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() ? candidate : undefined;
  } catch {
    // Value is not a path that exists on disk — treat as inline text.
    return undefined;
  }
}

/**
 * Resolve the prompt provenance for a single run.
 *
 * Computes a SHA-256 for each prompt/config source that is specific to THIS
 * state's run: the state-config-subtree hash, goal prompt file, state action
 * prompt files, compatibility prompt files, and skill SKILL.md files.
 *
 * The whole harness.yaml file hash is also recorded, but only for AUDIT
 * purposes (blocking: false) — it is NOT included in the STALE rejection set.
 * This means editing another state's config or an unrelated harness setting
 * mid-run does NOT cause a false STALE rejection for this run.
 *
 * Design decisions:
 *   - Per-entry errors degrade gracefully (missing entry) rather than throwing
 *     the whole resolution.  One bad compat path or unresolvable skill does
 *     not abort all provenance tracking.
 *   - Only if the entire resolution is fundamentally broken (should not happen
 *     in practice) does the caller receive resolutionFailed: true on the
 *     returned PromptProvenance.
 *
 * @param config       Loaded harness configuration.
 * @param projectRoot  Absolute path to the project root.
 * @param stateId      Current state identifier (selects the action prompt).
 * @param configPath   Absolute path to the harness.yaml config file.
 */
export function resolvePromptProvenance(
  config: HarnessConfig,
  projectRoot: string,
  stateId: string | undefined,
  configPath: string
): PromptProvenance {
  const entries: PromptProvenanceEntry[] = [];

  // ── 1. State-config-subtree hash (BLOCKING) ────────────────────────────────
  // Hash only the config fields that govern THIS state's prompt/behavior.
  // Editing other states' config or unrelated settings does NOT affect this hash.
  {
    const subtreeId = stateId ? `stateConfig:${stateId}` : 'stateConfig:<unknown>';
    const { sha256, missing } = hashStateConfigSubtree(configPath, stateId);
    const entry: PromptProvenanceEntry = {
      kind: STATE_CONFIG_KIND,
      path: subtreeId,
      sha256
    };
    if (missing) entry.missing = true;
    // No `blocking: false` → this entry IS blocking (default).
    entries.push(entry);
  }

  // ── 2. Harness config file (AUDIT ONLY — non-blocking) ────────────────────
  // Recorded for full-file auditability, but excluded from the STALE gate so
  // that edits to unrelated states or settings never reject this run.
  {
    const { sha256, missing } = hashFile(configPath);
    const entry: PromptProvenanceEntry = {
      kind: PromptProvenanceKind.HARNESS_CONFIG,
      path: configPath,
      sha256,
      blocking: false   // audit only — not checked by detectStaleProvenanceEntries
    };
    if (missing) entry.missing = true;
    entries.push(entry);
  }

  // ── 3. Goal / objective prompt ─────────────────────────────────────────────
  // The "goal prompt" is the projectObjective if it resolves to a file.
  try {
    const goalRef = resolveFileReference(config.settings.projectObjective, projectRoot);
    if (goalRef) {
      const { sha256, missing } = hashFile(goalRef);
      const entry: PromptProvenanceEntry = { kind: PromptProvenanceKind.GOAL_PROMPT, path: goalRef, sha256 };
      if (missing) entry.missing = true;
      entries.push(entry);
    }
  } catch {
    // Degrade gracefully — skip goal prompt entry rather than aborting all provenance.
  }

  // ── 4. State action prompt ────────────────────────────────────────────────
  // IMPORTANT: We read action prompt paths from the RAW (unresolved) YAML rather
  // than from the loaded HarnessConfig.  ConfigLoader.resolveFileBackedFields()
  // replaces path strings with the file content before returning HarnessConfig,
  // so action.prompt in the resolved config is the file content string — it no
  // longer functions as a file path reference and resolveFileReference() will not
  // find it as an existing file.  By reading the raw YAML we recover the original
  // authored path (e.g. "default_plan.md") and can hash the file directly.
  if (stateId) {
    try {
      const rawState = readRawStateSubtree(configPath, stateId) as Record<string, unknown> | undefined;
      const rawActions: unknown[] = Array.isArray(rawState?.['actions']) ? rawState['actions'] as unknown[] : [];
      for (const rawAction of rawActions) {
        try {
          const promptValue = (rawAction as Record<string, unknown>)?.['prompt'];
          if (typeof promptValue === 'string') {
            const actionPromptRef = resolveFileReference(promptValue, projectRoot);
            if (actionPromptRef) {
              const { sha256, missing } = hashFile(actionPromptRef);
              const entry: PromptProvenanceEntry = {
                kind: PromptProvenanceKind.STATE_PROMPT,
                path: actionPromptRef,
                sha256
              };
              if (missing) entry.missing = true;
              entries.push(entry);
            }
          }
        } catch {
          // Skip this action's prompt rather than aborting all provenance.
        }
      }
    } catch {
      // Degrade gracefully — skip state action prompts rather than aborting.
    }
  }

  // ── 5. Compatibility / rule prompt files ─────────────────────────────────
  try {
    const instructionLoader = new InstructionLoader(projectRoot);
    const compatPaths = instructionLoader.compatibilityPaths(config);
    for (const compatPath of compatPaths) {
      try {
        const { sha256, missing } = hashFile(compatPath);
        const entry: PromptProvenanceEntry = {
          kind: PromptProvenanceKind.COMPATIBILITY_PROMPT,
          path: compatPath,
          sha256
        };
        if (missing) entry.missing = true;
        entries.push(entry);
      } catch {
        // Skip individual bad compat path rather than aborting.
      }
    }
  } catch {
    // compatibilityPaths() itself should not throw (uses existsSync internally),
    // but guard defensively.
  }

  // ── 6. Skill SKILL.md files ───────────────────────────────────────────────
  try {
    const skills = resolvePiSkillPathsForState(config, projectRoot, stateId);
    for (const skill of skills) {
      try {
        const { sha256, missing } = hashFile(skill.path);
        const entry: PromptProvenanceEntry = {
          kind: PromptProvenanceKind.SKILL_PROMPT,
          path: skill.path,
          sha256
        };
        if (missing) entry.missing = true;
        entries.push(entry);
      } catch {
        // Skip individual skill rather than aborting all provenance.
      }
    }
  } catch {
    // resolvePiSkillPathsForState can throw (missing skill dir / path traversal).
    // Best-effort: skip skill entries rather than aborting all provenance.
  }

  return {
    entries,
    harnessConfigVersion: config.settings.workflowVersion
  };
}

/**
 * Re-hash each BLOCKING, FILE-BACKED entry in a recorded provenance snapshot
 * and return the paths of any whose current hash differs from the recorded hash
 * (or that are now missing when they existed before, or vice-versa).
 *
 * Two entry types are skipped intentionally:
 *  1. `blocking: false` entries — recorded for audit only (e.g. whole-file
 *     harness.yaml hash).  Editing other states' config or unrelated settings
 *     should never cause a STALE rejection for this run.
 *  2. STATE_CONFIG_KIND entries — these carry the hash of a serialised in-memory
 *     config subtree (not a file path).  Their staleness is checked separately
 *     by the gate via `computeCurrentStateConfigHash`; re-hashing them here
 *     would require config access that this function intentionally does not have.
 *
 * Returns an empty array when all checked entries are fresh.
 */
export function detectStaleProvenanceEntries(entries: PromptProvenanceEntry[]): string[] {
  const stale: string[] = [];
  for (const entry of entries) {
    // Skip audit-only (non-blocking) entries.
    if (entry.blocking === false) continue;
    // Skip state-config-subtree entries — staleness checked by the gate directly.
    if (entry.kind === STATE_CONFIG_KIND) continue;

    const { sha256: current, missing } = hashFile(entry.path);
    const wasRecordedMissing = entry.missing === true;
    if (current !== entry.sha256 || (missing === true) !== wasRecordedMissing) {
      stale.push(entry.path);
    }
  }
  return stale;
}

/**
 * Re-derive the state-config-subtree hash for the given stateId from the
 * raw harness.yaml on disk and return it.  The gate uses this to compare
 * against the init-time hash stored in the STATE_RUN_INITIALIZED event.
 *
 * @param configPath  Absolute path to the harness.yaml file (read raw).
 * @param stateId     The state whose config subtree to hash.
 *
 * Returns `{ sha256, identifier }` where `identifier` is the logical path
 * key used in the provenance entry (e.g. `stateConfig:<stateId>` where stateId comes from harness.yaml config, not any built-in name).
 */
export function computeCurrentStateConfigHash(
  configPath: string,
  stateId: string
): { sha256: string; identifier: string; missing?: true } {
  const identifier = `stateConfig:${stateId}`;
  const { sha256, missing } = hashStateConfigSubtree(configPath, stateId);
  return missing ? { sha256, identifier, missing } : { sha256, identifier };
}
