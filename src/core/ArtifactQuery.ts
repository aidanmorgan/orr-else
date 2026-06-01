/**
 * ArtifactQuery — selector-based JSON artifact query and projection tool.
 *
 * Design goals:
 * - Agents fetch only requested fields from structured artifacts instead of
 *   whole contract blobs (token efficiency).
 * - Named projections for `planContract` and `requirementsAnalysis` are a
 *   first-class feature; a small registry maps artifact-type → projection-name
 *   → dot-path selector.
 * - A plain dot-path selector is also accepted for ad-hoc queries.
 * - If a result exceeds RESULT_MAX_BYTES the tool returns counts + up to
 *   SAMPLE_MAX_ITEMS representative items + a narrower-selector hint instead
 *   of dumping the full subtree (req 4).
 * - Invalid/missing inputs return a structured rejection listing valid
 *   projection names + path/existence metadata (req 5).
 * - Artifact path resolution is delegated to the existing ArtifactPaths class
 *   so path logic is never duplicated (req 6).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ArtifactPaths } from './ArtifactPaths.js';
import { ArtifactQueryDefaults, EnvVars, OperationalArtifactPath } from '../constants/index.js';
import { getProjectRoot } from './Paths.js';

// ─── Path-safety helpers ──────────────────────────────────────────────────────

/**
 * Canonicalize a path: resolve symlinks via realpathSync where the file
 * exists; for a non-existent path, canonicalize the deepest existing ancestor
 * and re-join the missing tail segments.
 *
 * Mirrors the private `canonicalPath` logic in FileAccessPolicy so the two
 * implementations stay consistent.
 */
function canonicalPath(value: string): string {
  const resolvedPath = path.resolve(value);
  try {
    return fs.realpathSync(resolvedPath);
  } catch {
    let currentPath = resolvedPath;
    const missingSegments: string[] = [];
    while (!fs.existsSync(currentPath)) {
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) return resolvedPath;
      missingSegments.unshift(path.basename(currentPath));
      currentPath = parentPath;
    }
    try {
      return path.join(fs.realpathSync(currentPath), ...missingSegments);
    } catch {
      return resolvedPath;
    }
  }
}

/**
 * Returns true iff `childPath` is inside (or equal to) `rootPath`.
 *
 * Uses canonicalized paths and a separator-boundary check so that
 * `/artifacts-evil` does NOT match a root of `/artifacts`.
 *
 * Mirrors the private `isInside` logic in FileAccessPolicy.
 */
function isPathInside(childPath: string, rootPath: string): boolean {
  const rel = path.relative(canonicalPath(rootPath), canonicalPath(childPath));
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Build the list of allowed roots for an explicit artifactPath:
 *   1. The bead-scoped artifact directory:
 *      <projectRoot>/.pi/artifacts/<beadId>
 *   2. The active worktree path (PI_WORKTREE_PATH → PI_PROJECT_ROOT → getProjectRoot()).
 *
 * Both roots are canonicalized so symlinks in the config/env cannot widen scope.
 */
function allowedArtifactRoots(beadId: string): string[] {
  const projectRoot = process.env[EnvVars.PROJECT_ROOT] || getProjectRoot();
  const worktreePath =
    process.env[EnvVars.WORKTREE_PATH] ||
    process.env[EnvVars.PROJECT_ROOT] ||
    getProjectRoot();

  const beadArtifactDir = path.join(projectRoot, OperationalArtifactPath.PI_ARTIFACTS_DIR, beadId);

  return [canonicalPath(beadArtifactDir), canonicalPath(worktreePath)];
}

// ─── Named projection registry ───────────────────────────────────────────────

/**
 * Registry entry: maps a human-readable projection name to the dot-path
 * selector that extracts the relevant subtree from the artifact JSON.
 */
interface ProjectionEntry {
  /** Dot-path into the artifact JSON (empty string means root). */
  selector: string;
  /** Short human description for rejection hints. */
  description: string;
}

/**
 * Registry for planContract named projections (req 2).
 * Keys are stable model-facing names; values are selectors into the JSON.
 */
const PLAN_CONTRACT_PROJECTIONS: Record<string, ProjectionEntry> = {
  writeSet: {
    selector: 'writeSet',
    description: 'Approved file write set for this implementation step'
  },
  verifierObligations: {
    selector: 'verifierObligations',
    description: 'Verifier obligations that must pass before acceptance'
  },
  implementationSteps: {
    selector: 'implementationSteps',
    description: 'Ordered implementation steps from the plan'
  },
  riskList: {
    selector: 'riskList',
    description: 'Identified risks and mitigations'
  },
  evidenceReferences: {
    selector: 'evidenceReferences',
    description: 'Evidence references supporting the plan'
  },
  acceptanceCriteria: {
    selector: 'acceptanceCriteria',
    description: 'Acceptance criteria for this bead'
  }
} as const;

/**
 * Registry for requirementsAnalysis named projections (req 3).
 */
const REQUIREMENTS_ANALYSIS_PROJECTIONS: Record<string, ProjectionEntry> = {
  requirementsInventory: {
    selector: 'requirementsInventory',
    description: 'Full inventory of discovered requirements'
  },
  traceabilityReferences: {
    selector: 'traceabilityReferences',
    description: 'Traceability links between requirements and source artifacts'
  },
  gapFlags: {
    selector: 'gapFlags',
    description: 'Flags indicating gaps in requirements coverage'
  },
  referenceCitations: {
    selector: 'referenceCitations',
    description: 'Source citations referenced in the requirements analysis'
  },
  unresolvedQuestions: {
    selector: 'unresolvedQuestions',
    description: 'Open questions that require resolution before planning'
  }
} as const;

/**
 * Artifact-type → projection-name → entry.
 * Keys are the artifact identifiers as they appear in harness.yaml templates
 * (e.g. TransactionalStateDefaults.PLAN_CONTRACT_ARTIFACT_ID = 'planContract').
 */
const PROJECTION_REGISTRY: Record<string, Record<string, ProjectionEntry>> = {
  planContract: PLAN_CONTRACT_PROJECTIONS,
  requirementsAnalysis: REQUIREMENTS_ANALYSIS_PROJECTIONS
} as const;

// ─── Safe dot-path traversal ──────────────────────────────────────────────────

/**
 * Traverse `root` following the dot-separated `selector`.
 * Supports:
 *   - empty string → root
 *   - "foo"        → root.foo
 *   - "foo.bar"    → root.foo.bar
 *   - "foo.0"      → root.foo[0]   (numeric segments index arrays)
 *
 * Safety rules:
 *   - Never calls eval or Function.
 *   - Numeric segments are parsed with parseInt (only integers accepted).
 *   - Prototype-polluting keys (__proto__, constructor, prototype) are
 *     rejected and cause the traversal to return undefined.
 *
 * Returns `undefined` when any segment is missing or the selector is invalid.
 */
export function safeSelectPath(root: unknown, selector: string): unknown {
  if (!selector.trim()) return root;

  const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const segments = selector.split('.');

  let current: unknown = root;
  for (const segment of segments) {
    if (!segment) return undefined;
    if (BLOCKED_KEYS.has(segment)) return undefined;

    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current)) {
      const index = parseInt(segment, 10);
      if (isNaN(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }

  return current;
}

// ─── Too-much-data guard (req 4) ──────────────────────────────────────────────

interface TooMuchDataResult {
  tooMuchData: true;
  itemCount?: number;
  byteCount: number;
  representativeSamples: unknown[];
  narrowerSelectorHint: string;
  nextAction: 'rerun_with_narrower_selector';
  recovery: string[];
}

/**
 * Checks whether `value` serializes beyond RESULT_MAX_BYTES.
 * If so, returns a TooMuchDataResult with counts + representative samples.
 * Returns null when the value is within the cap.
 */
function tooMuchDataGuard(value: unknown, selector: string, artifactId: string): TooMuchDataResult | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }

  if (serialized.length <= ArtifactQueryDefaults.RESULT_MAX_BYTES) return null;

  const itemCount = Array.isArray(value) ? value.length : undefined;
  const samples = Array.isArray(value)
    ? value.slice(0, ArtifactQueryDefaults.SAMPLE_MAX_ITEMS)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).slice(0, ArtifactQueryDefaults.SAMPLE_MAX_ITEMS)
        )
      : value;

  const exampleNarrowing = Array.isArray(value) && value.length > 0
    ? `${selector}.0`
    : typeof value === 'object' && value !== null && Object.keys(value).length > 0
      ? `${selector}.${Object.keys(value as Record<string, unknown>)[0]}`
      : selector;

  return {
    tooMuchData: true,
    itemCount,
    byteCount: serialized.length,
    representativeSamples: Array.isArray(samples) ? samples : [samples],
    narrowerSelectorHint: exampleNarrowing !== selector ? exampleNarrowing : `${selector}.<key>`,
    nextAction: 'rerun_with_narrower_selector',
    recovery: [
      `The selected value from artifact "${artifactId}" at selector "${selector}" is ${serialized.length} bytes (cap: ${ArtifactQueryDefaults.RESULT_MAX_BYTES} bytes).`,
      `Rerun query_artifact with a narrower selector such as "${exampleNarrowing !== selector ? exampleNarrowing : `${selector}.<specific-key-or-index>`}" to get an in-cap result.`,
      `Use a named projection (see validProjections) if available for this artifact type, as projections are pre-scoped to stay within the cap.`
    ]
  };
}

// ─── Tool inputs / outputs ────────────────────────────────────────────────────

export interface ArtifactQueryInput {
  /** The bead ID, used by ArtifactPaths to resolve the artifact path. */
  beadId: string;
  /** Optional state ID for artifact template resolution. */
  stateId?: string;
  /** Optional action ID for artifact template resolution. */
  actionId?: string;
  /**
   * The artifact identifier — must match a key in the harness.yaml
   * `settings.artifacts.templates` map (e.g. "planContract").
   * Mutually exclusive with `artifactPath`.
   */
  artifactId?: string;
  /**
   * Explicit filesystem path to the artifact JSON.
   * Mutually exclusive with `artifactId`.
   * When provided, ArtifactPaths is NOT used for path resolution, but the
   * path is still validated to exist before reading.
   */
  artifactPath?: string;
  /**
   * Named projection for schema-aware field extraction.
   * Must be a key in the projection registry for the given artifact type.
   * Mutually exclusive with `selector`.
   */
  projection?: string;
  /**
   * Dot-path selector for ad-hoc subtree extraction.
   * Syntax: "foo.bar.0" selects root.foo.bar[0].
   * Empty string or omitted selector returns the artifact root (subject to
   * the too-much-data cap).
   * Mutually exclusive with `projection`.
   */
  selector?: string;
}

export interface ArtifactQueryRejection {
  status: 'rejected';
  reason: string;
  validProjections?: string[];
  artifactPath?: string;
  exists: boolean;
}

export interface ArtifactQuerySuccess {
  status: 'ok';
  artifactId: string;
  artifactPath: string;
  selector: string;
  result: unknown;
}

export type ArtifactQueryResult = ArtifactQuerySuccess | ArtifactQueryRejection | TooMuchDataResult;

// ─── ArtifactQuery class ──────────────────────────────────────────────────────

export class ArtifactQuery {
  constructor(private readonly artifactPaths: ArtifactPaths) {}

  public async query(input: ArtifactQueryInput): Promise<ArtifactQueryResult> {
    // 1. Validate mutual exclusivity of (artifactId / artifactPath) and (projection / selector)
    if (input.artifactId && input.artifactPath) {
      return this.rejection(
        'Provide either "artifactId" (resolved via harness templates) or "artifactPath" (explicit path), not both.',
        undefined,
        false
      );
    }
    if (!input.artifactId && !input.artifactPath) {
      return this.rejection(
        'Provide either "artifactId" (resolved via harness templates) or "artifactPath" (explicit path).',
        undefined,
        false
      );
    }
    if (input.projection && input.selector !== undefined && input.selector !== '') {
      return this.rejection(
        'Provide either "projection" (named schema-aware extraction) or "selector" (dot-path), not both.',
        undefined,
        false
      );
    }

    // 2. Resolve artifact path
    const { resolvedPath, resolvedId, scopeRejection } = await this.resolvePath(input);
    if (scopeRejection) {
      return scopeRejection;
    }
    if (!resolvedPath) {
      return this.rejection(
        `Could not resolve artifact path: no matching template found for artifactId "${input.artifactId}".`,
        undefined,
        false,
        resolvedId
      );
    }

    const exists = fs.existsSync(resolvedPath);

    if (!exists) {
      return this.rejection(
        `Artifact "${resolvedId}" does not exist at path "${resolvedPath}".`,
        resolvedPath,
        false,
        resolvedId
      );
    }

    // 3. Parse artifact JSON
    let parsed: unknown;
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (error) {
      return this.rejection(
        `Failed to read/parse artifact at "${resolvedPath}": ${String(error)}`,
        resolvedPath,
        true,
        resolvedId
      );
    }

    // 4. Resolve selector from projection or raw selector input
    let effectiveSelector: string;
    if (input.projection) {
      const projEntry = this.lookupProjection(resolvedId, input.projection);
      if (!projEntry) {
        const validProjections = this.validProjectionNames(resolvedId);
        return {
          status: 'rejected',
          reason: `Unknown projection "${input.projection}" for artifact type "${resolvedId}". Use one of the validProjections listed, or provide a dot-path "selector" instead.`,
          validProjections,
          artifactPath: resolvedPath,
          exists: true
        };
      }
      effectiveSelector = projEntry.selector;
    } else {
      effectiveSelector = input.selector ?? '';
    }

    // 5. Apply safe dot-path traversal
    const value = safeSelectPath(parsed, effectiveSelector);
    if (value === undefined && effectiveSelector) {
      const validProjections = this.validProjectionNames(resolvedId);
      return {
        status: 'rejected',
        reason: `Selector "${effectiveSelector}" did not match any value in artifact "${resolvedId}".${validProjections.length > 0 ? ' Use a named projection for schema-aware access.' : ''}`,
        validProjections: validProjections.length > 0 ? validProjections : undefined,
        artifactPath: resolvedPath,
        exists: true
      };
    }

    // 6. Too-much-data guard (req 4)
    const tooMuch = tooMuchDataGuard(value, effectiveSelector || '(root)', resolvedId);
    if (tooMuch) return tooMuch;

    // 7. Return success
    return {
      status: 'ok',
      artifactId: resolvedId,
      artifactPath: resolvedPath,
      selector: effectiveSelector,
      result: value
    };
  }

  /**
   * Resolve the filesystem path of the artifact.
   *
   * If `artifactPath` is given directly, it is CANONICALIZED and VERIFIED to
   * be inside an allowed root (bead artifact directory or active worktree).
   * Paths outside those roots return a scope-rejection result without leaking
   * file content or error text.
   *
   * If `artifactId` is given, delegate to ArtifactPaths.resolve() so the
   * existing template expansion logic is reused — requirement 6.
   */
  private async resolvePath(
    input: ArtifactQueryInput
  ): Promise<{ resolvedPath: string | undefined; resolvedId: string; scopeRejection?: ArtifactQueryRejection }> {
    if (input.artifactPath) {
      const resolved = path.isAbsolute(input.artifactPath)
        ? input.artifactPath
        : path.resolve(input.artifactPath);

      const roots = allowedArtifactRoots(input.beadId);
      const inScope = roots.some(root => isPathInside(resolved, root));
      if (!inScope) {
        const scopeRejection: ArtifactQueryRejection = {
          status: 'rejected',
          reason:
            'artifactPath is outside the allowed artifact and worktree roots for this bead. ' +
            'Provide a path inside the bead artifact directory or the active worktree.',
          exists: false
        };
        return { resolvedPath: undefined, resolvedId: '', scopeRejection };
      }

      return { resolvedPath: resolved, resolvedId: path.basename(resolved, path.extname(resolved)) };
    }

    const artifactId = input.artifactId!;
    const resolution = await this.artifactPaths.resolve({
      beadId: input.beadId,
      stateId: input.stateId,
      actionId: input.actionId,
      artifactId,
      includeContent: false
    });

    const resolvedPath = resolution.artifactPaths[artifactId];
    return { resolvedPath, resolvedId: artifactId };
  }

  private lookupProjection(artifactId: string, projectionName: string): ProjectionEntry | undefined {
    const registry = PROJECTION_REGISTRY[artifactId];
    if (!registry) return undefined;
    return registry[projectionName];
  }

  private validProjectionNames(artifactId: string): string[] {
    const registry = PROJECTION_REGISTRY[artifactId];
    if (!registry) return [];
    return Object.keys(registry);
  }

  private rejection(
    reason: string,
    artifactPath: string | undefined,
    exists: boolean,
    artifactId?: string
  ): ArtifactQueryRejection {
    const validProjections = artifactId ? this.validProjectionNames(artifactId) : undefined;
    return {
      status: 'rejected',
      reason,
      ...(validProjections && validProjections.length > 0 ? { validProjections } : {}),
      ...(artifactPath !== undefined ? { artifactPath } : {}),
      exists
    };
  }
}
