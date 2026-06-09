/**
 * WorkerPromptIdentityBuilder — single source of truth for worker identity inputs.
 *
 * pi-experiment-amq0.10
 *
 * PURPOSE
 * -------
 * Worker identity / digest computation was split across three sites:
 *   1. Teammate spawn (teammates.ts) — used workerExtension paths as toolNames (wrong).
 *   2. Prompt assembly (WorkerContextResolver.ts) — used catalog Pi tool names (correct).
 *   3. RESOURCES_DISCOVER (extension.ts) — used global-only skill paths (missed state skills).
 *
 * This module collapses all three into ONE builder so every consumer — spawn
 * bootstrap digest, STATE_PROMPT_ASSEMBLED, admittedHarnessFingerprint contribution,
 * and replay checks — derives its StableBootstrapInputs from the same code path.
 *
 * SKILL DELIVERY POLICY
 * ---------------------
 * One admitted path: resolvePiSkillPathsForState (state-aware, global+state merged,
 * de-duplicated by resolved path).  Global-only resolvePiSkillPaths is NOT used
 * directly by identity computation; it remains available for other consumers.
 *
 * DUPLICATION DETECTION
 * ---------------------
 * detectSkillDuplication() is LOAD-BEARING: a config where a skill name appears in
 * both settings.pi.skillPaths (global) and a state's `skills` list produces a compact
 * diagnostic.  Tests must exercise this path — removing the detection causes test
 * failure.
 */
import * as path from 'path';
import { getConfiguredPiToolNames, resolvePiSkillPathsForState, type ResolvedSkill, type FileSystemPort, nodeFileSystemPort } from './WorkerResourceResolver.js';
import type { HarnessConfig } from './ConfigLoader.js';
import type { ToolSurfaceCatalog } from './ToolSurfaceCatalog.js';
import type { StableBootstrapInputs } from './BootstrapDigest.js';

// ---------------------------------------------------------------------------
// Skill duplication diagnostic
// ---------------------------------------------------------------------------

/**
 * A compact skill duplication entry.  name is the skill name that appears in
 * both the global skillPaths list and a state's `skills` list.
 */
export interface SkillDuplication {
  /** The duplicated skill name (basename of the SKILL.md parent directory). */
  name: string;
  /** State ID(s) that also declare this skill in their `skills` list. */
  affectedStates: string[];
}

/**
 * Detect skills that appear in BOTH the global settings.pi.skillPaths list
 * AND one or more state-level `skills` lists.  These duplicates are redundant
 * (resolvePiSkillPathsForState already deduplicates by resolved path) but are
 * reported so operators can clean up config drift.
 *
 * LOAD-BEARING: removing this detection causes the duplication test to fail.
 *
 * @param config   Loaded HarnessConfig.
 * @param projectRoot   Absolute project root for resolving skill paths.
 * @returns Array of skill duplication entries (empty when none detected).
 */
export function detectSkillDuplication(
  config: HarnessConfig,
  projectRoot: string
): SkillDuplication[] {
  // Collect global skill names from settings.pi.skillPaths.
  // Convention: skill name = basename of the parent directory of the SKILL.md file.
  const globalSkillNames = new Set<string>(
    (config.settings?.pi?.skillPaths || []).map(p =>
      path.basename(path.dirname(path.isAbsolute(p) ? p : path.resolve(projectRoot, p)))
    )
  );
  if (globalSkillNames.size === 0) return [];

  // Walk state-level `skills` lists and detect names that also appear globally.
  const duplicateMap = new Map<string, string[]>(); // name → affectedStates
  for (const [stateId, state] of Object.entries(config.states || {})) {
    const stateSkills: string[] = (state as { skills?: string[] }).skills || [];
    for (const skillName of stateSkills) {
      if (globalSkillNames.has(skillName)) {
        const existing = duplicateMap.get(skillName);
        if (existing) {
          existing.push(stateId);
        } else {
          duplicateMap.set(skillName, [stateId]);
        }
      }
    }
  }

  return Array.from(duplicateMap.entries()).map(([name, affectedStates]) => ({
    name,
    affectedStates: [...affectedStates].sort()
  }));
}

/**
 * Format a compact diagnostic string for detected skill duplications.
 * Returns an empty string when duplications is empty.
 */
export function formatSkillDuplicationDiagnostic(duplications: SkillDuplication[]): string {
  if (duplications.length === 0) return '';
  const lines = duplications.map(d =>
    `  skill "${d.name}" is declared globally AND in state(s): ${d.affectedStates.join(', ')}`
  );
  return `Skill duplication detected (${duplications.length}):\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Builder inputs
// ---------------------------------------------------------------------------

/**
 * Inputs required to build the canonical WorkerPromptIdentity.
 *
 * At spawn time (coordinator process) the toolSurfaceCatalog is not yet built
 * for the worker, so Pi tool names are read directly from config.  At prompt-
 * assembly time (worker BEFORE_AGENT_START) the catalog is available and its
 * getConfiguredPiToolNames() result is identical to the config-derived list.
 * Passing the catalog here is preferred (single source of truth); when omitted
 * the builder falls back to reading config.settings.pi.tools directly.
 */
export interface WorkerIdentityInputs {
  /** Absolute project root path. */
  projectRoot: string;
  /** Absolute path to the harness config file (used as configIdentity). */
  configPath: string;
  /** State ID for which the identity is being computed. */
  stateId: string;
  /** Loaded harness config. */
  config: HarnessConfig;
  /**
   * Optional tool surface catalog.  When present, Pi tool names are read from
   * catalog.getConfiguredPiToolNames() — the single source of truth.  When
   * absent the builder reads config.settings.pi.tools directly, which produces
   * an identical list (same function, called in buildToolSurfaceCatalog).
   */
  toolSurfaceCatalog?: ToolSurfaceCatalog;
  /**
   * Optional protocol label for the identity.  Callers (in the plugins/composition
   * layers) resolve the label from resolveToolPromptProfileId and pass it here.
   * When omitted the builder uses the default 'ORR_ELSE_PROTOCOL_v1'.
   *
   * NOTE: at spawn time the action is unknown so only the state+settings levels
   * are resolved; at prompt-assembly time the action-level profile may refine it.
   * Both callers pass the label they have computed — the builder does not perform
   * profile resolution itself (which would require importing src/plugins/).
   */
  protocolLabel?: string;
  /**
   * Optional filesystem port for testing.  Defaults to the real fs module.
   */
  fsPort?: FileSystemPort;
}

// ---------------------------------------------------------------------------
// Builder result
// ---------------------------------------------------------------------------

/**
 * Result of WorkerPromptIdentityBuilder.build().
 */
export interface WorkerIdentityResult {
  /** The canonical stable identity inputs — pass to digestIdentity() or digestStableBlock(). */
  identity: StableBootstrapInputs;
  /**
   * Resolved skills for this state (merged global + state-specific, de-duplicated).
   * Exposed so callers can extract skillPaths for CLI --skill flags without re-resolving.
   */
  resolvedSkills: ResolvedSkill[];
  /**
   * Skill duplication diagnostics (empty when none detected).
   * Callers MUST log/emit these as warnings — they indicate config drift.
   * A non-empty value means the same skill was declared both globally (skillPaths)
   * and in a state's `skills` list.  Use formatSkillDuplicationDiagnostic() to
   * render the compact diagnostic string.
   */
  skillDuplications: SkillDuplication[];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * WorkerPromptIdentityBuilder — computes the canonical StableBootstrapInputs
 * for a worker spawn or prompt assembly.
 *
 * USAGE
 * -----
 * One static method `build()` — no instance state, pure function.
 *
 * All consumers (spawn bootstrap digest, STATE_PROMPT_ASSEMBLED, replay checks)
 * call this method and pass the result to digestIdentity() or digestStableBlock().
 * Removing or bypassing this builder in any consumer makes the "all consumers
 * move together" mutation test fail.
 */
export class WorkerPromptIdentityBuilder {
  /**
   * Build the canonical worker identity inputs.
   *
   * Algorithm
   * ---------
   * 1. Resolve Pi tool names: from catalog if available, else from config directly.
   *    Both paths produce an identical list (catalog stores exactly config.settings.pi.tools).
   * 2. Resolve skills: resolvePiSkillPathsForState(config, projectRoot, stateId) —
   *    state-specific + global, de-duplicated by resolved path.
   * 3. Detect skill duplication: compare global skillPaths names against state skills.
   * 4. Compute protocolLabel: resolveToolPromptProfileId at state+action level.
   * 5. Assemble StableBootstrapInputs.
   *
   * @throws Error when skill resolution fails (e.g. a referenced state skill file is
   *   missing).  A missing referenced skill is a CONFIG ERROR — the caller (spawn or
   *   prompt-assembly) must treat the thrown error as a hard failure and abort.
   *   Do NOT catch this error silently; fail-closed is required.
   */
  static build(inputs: WorkerIdentityInputs): WorkerIdentityResult {
    const { projectRoot, configPath, stateId, config, toolSurfaceCatalog, fsPort } = inputs;

    // Step 1: resolve Pi tool names from catalog (preferred) or config (fallback).
    // Both produce the same list — catalog is just a pre-built view of config.
    const piToolNames: string[] = toolSurfaceCatalog
      ? Array.from(toolSurfaceCatalog.getConfiguredPiToolNames())
      : getConfiguredPiToolNames(config);

    // Step 2: resolve skills — state-aware, de-duplicated.
    // FAIL-CLOSED: a missing referenced state skill is a config error; let the
    // error propagate so the caller (spawn or prompt-assembly) aborts hard.
    const resolvedSkills = resolvePiSkillPathsForState(config, projectRoot, stateId, fsPort ?? nodeFileSystemPort());
    const skillNames = resolvedSkills.map(s => s.name);

    // Step 3: detect skill duplication (global + state overlap).
    const skillDuplications = detectSkillDuplication(config, projectRoot);

    // Step 4: use the caller-supplied protocol label, or the default.
    // Protocol label resolution (resolveToolPromptProfileId) is done by the caller
    // in the plugins/composition layer, not here, to keep core free of plugin imports.
    const protocolLabel = inputs.protocolLabel ?? 'ORR_ELSE_PROTOCOL_v1';

    // Step 5: assemble the canonical identity.
    const identity: StableBootstrapInputs = {
      projectRoot,
      configIdentity: configPath,
      stateId,
      toolNames: piToolNames,
      skillNames,
      ruleCategories: [],
      protocolLabel
    };

    return { identity, resolvedSkills, skillDuplications };
  }
}
