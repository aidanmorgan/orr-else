/**
 * PromptProvenanceService — prompt provenance and asset hashing with injected
 * file/config ports.
 *
 * pi-experiment-amq0.13: extracted verbatim from PiIntegration.ts.
 *
 * All fs.readFileSync / fs.statSync calls go through the injected FileReadPort so
 * this module is testable without real disk access.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'node:crypto';
import * as yaml from 'yaml';
import type { HarnessConfig } from './ConfigLoader.js';
import { PromptProvenanceKind, PromptProvenanceDefaults } from '../constants/index.js';
import { resolvePiSkillPathsForState, type FileSystemPort, nodeFileSystemPort } from './WorkerResourceResolver.js';

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

/** Injected file-read port for provenance hashing. */
export interface FileReadPort {
  /** Read a file as a Buffer. Returns null on ENOENT or any error. */
  readFile(filePath: string): Buffer | null;
  /** Stat a file. Returns null on ENOENT or any error. */
  statFile(filePath: string): { isFile(): boolean } | null;
}

/** Default production implementation backed by the real fs module. */
export function nodeFileReadPort(): FileReadPort {
  return {
    readFile(filePath: string): Buffer | null {
      try {
        return fs.readFileSync(filePath);
      } catch {
        return null;
      }
    },
    statFile(filePath: string): { isFile(): boolean } | null {
      try {
        return fs.statSync(filePath);
      } catch {
        return null;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Types
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
 *   unexpected harness-level error during init (e.g. an unhandled exception in
 *   the outer guard).  The completion gate treats this as WARN-ONLY — the agent
 *   should not be penalised for a harness-level resolution problem.
 *
 * `configuredSourceFailed` — set to true when a CONFIGURED / author-declared
 *   required source (a skill listed in state.skills, a global skillPath, or a
 *   prompt field that looks like a file path) could not be resolved at run start.
 *   The completion gate treats this as a HARD BLOCK: SUCCESS cannot be claimed
 *   when a configured required context was absent.
 */
export interface PromptProvenance {
  entries: PromptProvenanceEntry[];
  harnessConfigVersion: string | undefined;
  resolutionFailed?: true;
  configuredSourceFailed?: true;
}

// ---------------------------------------------------------------------------
// Internal helpers (verbatim from PiIntegration.ts)
// ---------------------------------------------------------------------------

/**
 * Hash a file's contents with SHA-256 and return the hex string.
 * Returns an empty string and sets `missing: true` when the file is absent.
 * Never throws.
 */
function hashFile(filePath: string, filePort: FileReadPort): { sha256: string; missing?: true } {
  try {
    const content = filePort.readFile(filePath);
    if (content === null) return { sha256: PromptProvenanceDefaults.MISSING_HASH, missing: true };
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
function readRawStateSubtree(configPath: string, stateId: string, filePort: FileReadPort): unknown | undefined {
  try {
    const raw = filePort.readFile(configPath);
    if (raw === null) return undefined;
    const parsed = yaml.parse(raw.toString('utf8'));
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
function hashStateConfigSubtree(
  configPath: string,
  stateId: string | undefined,
  filePort: FileReadPort
): { sha256: string; missing?: true } {
  if (!stateId) return { sha256: PromptProvenanceDefaults.MISSING_HASH, missing: true };
  try {
    const rawState = readRawStateSubtree(configPath, stateId, filePort);
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
function resolveFileReference(value: string | undefined, projectRoot: string, filePort: FileReadPort): string | undefined {
  if (!value || !value.trim()) return undefined;
  const candidate = path.isAbsolute(value) ? value : path.resolve(projectRoot, value.trim());
  try {
    const stat = filePort.statFile(candidate);
    return stat?.isFile() ? candidate : undefined;
  } catch {
    // Value is not a path that exists on disk — treat as inline text.
    return undefined;
  }
}

/**
 * Heuristic: does this string look like a file path rather than inline text?
 *
 * A value is treated as a CONFIGURED file reference ONLY if its trimmed form
 * contains NO whitespace AND at least one of:
 *   - it is an absolute path (starts with '/'), OR
 *   - it contains a path separator ('/' or '\'), OR
 *   - it has a recognisable file extension (e.g. .md, .txt, .yaml, .yml, .json).
 *
 * If the trimmed value contains ANY whitespace it is definitively inline text
 * (sentences, objectives, multi-word prompts) and returns false unconditionally.
 * Configured file paths in this harness are always single tokens; multi-word
 * values cannot be file paths, so slashes inside them (e.g. "auth/login flow",
 * "TypeScript/JavaScript") must never trigger missing-file detection.
 */
function looksLikeFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Multi-word / whitespace-containing values are always inline text, never file refs.
  if (/\s/.test(trimmed)) return false;
  if (path.isAbsolute(trimmed)) return true;
  if (trimmed.includes('/') || trimmed.includes('\\')) return true;
  // Has a recognisable file extension
  const ext = path.extname(trimmed).toLowerCase();
  return ['.md', '.txt', '.yaml', '.yml', '.json', '.prompt', '.instructions'].includes(ext);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the prompt provenance for a single run.
 *
 * Computes a SHA-256 for each prompt/config source that is specific to THIS
 * state's run: the state-config-subtree hash, goal prompt file, state action
 * prompt files, and skill SKILL.md files.
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
 * @param filePort     Injected file-read port (defaults to real fs).
 * @param fsPort       Injected existsSync port for skill resolution (defaults to real fs).
 */
export function resolvePromptProvenance(
  config: HarnessConfig,
  projectRoot: string,
  stateId: string | undefined,
  configPath: string,
  filePort: FileReadPort = nodeFileReadPort(),
  fsPort: FileSystemPort = nodeFileSystemPort()
): PromptProvenance {
  const entries: PromptProvenanceEntry[] = [];

  // ── 1. State-config-subtree hash (BLOCKING) ────────────────────────────────
  // Hash only the config fields that govern THIS state's prompt/behavior.
  // Editing other states' config or unrelated settings does NOT affect this hash.
  {
    const subtreeId = stateId ? `stateConfig:${stateId}` : 'stateConfig:<unknown>';
    const { sha256, missing } = hashStateConfigSubtree(configPath, stateId, filePort);
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
    const { sha256, missing } = hashFile(configPath, filePort);
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
  //
  // CONFIGURED-SOURCE detection: if the value looks like a file path (has a
  // file extension, path separator, or is absolute) but the file does not exist
  // on disk, this is a CONFIGURED source that failed to resolve.  Emit a
  // missing entry and set configuredSourceFailed so the gate can hard-block.
  let configuredSourceFailed = false;
  try {
    const goalValue = config.settings.projectObjective;
    if (goalValue && goalValue.trim()) {
      const goalRef = resolveFileReference(goalValue, projectRoot, filePort);
      if (goalRef) {
        const { sha256, missing } = hashFile(goalRef, filePort);
        const entry: PromptProvenanceEntry = { kind: PromptProvenanceKind.GOAL_PROMPT, path: goalRef, sha256 };
        if (missing) entry.missing = true;
        entries.push(entry);
      } else if (looksLikeFilePath(goalValue)) {
        // Looks like a file path but does not exist — CONFIGURED source missing.
        const resolvedCandidate = path.isAbsolute(goalValue)
          ? goalValue
          : path.resolve(projectRoot, goalValue.trim());
        const entry: PromptProvenanceEntry = {
          kind: PromptProvenanceKind.GOAL_PROMPT,
          path: resolvedCandidate,
          sha256: PromptProvenanceDefaults.MISSING_HASH,
          missing: true
        };
        entries.push(entry);
        configuredSourceFailed = true;
      }
      // else: genuine inline text — not a file reference, skip silently.
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
  //
  // CONFIGURED-SOURCE detection: if the raw prompt value looks like a file path
  // (has a file extension, path separator, or is absolute) but the file does not
  // exist, this is a CONFIGURED prompt-file source that failed.  Emit a missing
  // entry and set configuredSourceFailed so the gate hard-blocks SUCCESS.
  if (stateId) {
    try {
      const rawState = readRawStateSubtree(configPath, stateId, filePort) as Record<string, unknown> | undefined;
      const rawActions: unknown[] = Array.isArray(rawState?.['actions']) ? rawState['actions'] as unknown[] : [];
      for (const rawAction of rawActions) {
        try {
          const promptValue = (rawAction as Record<string, unknown>)?.['prompt'];
          if (typeof promptValue === 'string') {
            const actionPromptRef = resolveFileReference(promptValue, projectRoot, filePort);
            if (actionPromptRef) {
              const { sha256, missing } = hashFile(actionPromptRef, filePort);
              const entry: PromptProvenanceEntry = {
                kind: PromptProvenanceKind.STATE_PROMPT,
                path: actionPromptRef,
                sha256
              };
              if (missing) entry.missing = true;
              entries.push(entry);
            } else if (looksLikeFilePath(promptValue)) {
              // Looks like a file path but does not exist — CONFIGURED prompt-file source missing.
              const resolvedCandidate = path.isAbsolute(promptValue)
                ? promptValue
                : path.resolve(projectRoot, promptValue.trim());
              const entry: PromptProvenanceEntry = {
                kind: PromptProvenanceKind.STATE_PROMPT,
                path: resolvedCandidate,
                sha256: PromptProvenanceDefaults.MISSING_HASH,
                missing: true
              };
              entries.push(entry);
              configuredSourceFailed = true;
            }
            // else: genuine inline text — not a file reference, skip silently.
          }
        } catch {
          // Skip this action's prompt rather than aborting all provenance.
        }
      }
    } catch {
      // Degrade gracefully — skip state action prompts rather than aborting.
    }
  }

  // ── 5. Skill SKILL.md files ───────────────────────────────────────────────
  // CONFIGURED sources: resolvePiSkillPathsForState throws for any skill that
  // is listed in the state's `skills` array (or in global `skillPaths`) but
  // cannot be found on disk.  We must NOT silently eat that error — a missing
  // configured skill means the run would proceed without a deterministic context
  // that the author declared as required.  Propagate the failure as
  // `configuredSourceFailed: true` so the completion gate hard-blocks SUCCESS.
  //
  // Within a successful skill list, individual hashFile calls still degrade
  // gracefully (unexpected I/O error on a file that DID resolve) to avoid
  // aborting provenance for a transient read fault.
  try {
    const skills = resolvePiSkillPathsForState(config, projectRoot, stateId, fsPort);
    for (const skill of skills) {
      const { sha256, missing } = hashFile(skill.path, filePort);
      const entry: PromptProvenanceEntry = {
        kind: PromptProvenanceKind.SKILL_PROMPT,
        path: skill.path,
        sha256
      };
      if (missing) entry.missing = true;
      entries.push(entry);
    }
  } catch (err) {
    // resolvePiSkillPathsForState threw — a CONFIGURED skill or global skill
    // path could not be resolved.  This is a deterministic configured-source
    // failure: return configuredSourceFailed: true so the completion gate
    // hard-blocks SUCCESS.
    return {
      entries,
      harnessConfigVersion: config.settings.workflowVersion,
      configuredSourceFailed: true
    };
  }

  return {
    entries,
    harnessConfigVersion: config.settings.workflowVersion,
    ...(configuredSourceFailed ? { configuredSourceFailed: true as const } : {})
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
export function detectStaleProvenanceEntries(
  entries: PromptProvenanceEntry[],
  filePort: FileReadPort = nodeFileReadPort()
): string[] {
  const stale: string[] = [];
  for (const entry of entries) {
    // Skip audit-only (non-blocking) entries.
    if (entry.blocking === false) continue;
    // Skip state-config-subtree entries — staleness checked by the gate directly.
    if (entry.kind === STATE_CONFIG_KIND) continue;

    const { sha256: current, missing } = hashFile(entry.path, filePort);
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
 * @param filePort    Injected file-read port (defaults to real fs).
 *
 * Returns `{ sha256, identifier }` where `identifier` is the logical path
 * key used in the provenance entry (e.g. `stateConfig:<stateId>` where stateId comes from harness.yaml config, not any built-in name).
 */
export function computeCurrentStateConfigHash(
  configPath: string,
  stateId: string,
  filePort: FileReadPort = nodeFileReadPort()
): { sha256: string; identifier: string; missing?: true } {
  const identifier = `stateConfig:${stateId}`;
  const { sha256, missing } = hashStateConfigSubtree(configPath, stateId, filePort);
  return missing ? { sha256, identifier, missing } : { sha256, identifier };
}
