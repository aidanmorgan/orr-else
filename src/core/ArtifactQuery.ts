/**
 * ArtifactQuery — selector-based JSON artifact query and projection tool.
 *
 * Design goals:
 * - Agents fetch only requested fields from structured artifacts instead of
 *   whole contract blobs (token efficiency).
 * - Named projections are GENERIC and registration-driven: a consuming-project
 *   extension registers each projection (name → candidate dot-path selectors)
 *   in the harness-owned `projections` registry (orr-else/contract). This tool
 *   embeds NO project's artifact schema; an UNregistered named projection falls
 *   back to the generic dot-path selector.
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
import { projections, type ProjectionDef } from '../contract.js';

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
 *   2. The active worktree path (PI_WORKTREE_PATH → PI_PROJECT_ROOT → process.cwd()).
 *
 * Both roots are canonicalized so symlinks in the config/env cannot widen scope.
 */
function allowedArtifactRoots(beadId: string): string[] {
  const projectRoot = process.env[EnvVars.PROJECT_ROOT] || process.cwd();
  const worktreePath =
    process.env[EnvVars.WORKTREE_PATH] ||
    process.env[EnvVars.PROJECT_ROOT] ||
    process.cwd();

  const beadArtifactDir = path.join(projectRoot, OperationalArtifactPath.PI_ARTIFACTS_DIR, beadId);

  return [canonicalPath(beadArtifactDir), canonicalPath(worktreePath)];
}

// ─── Named projection resolution ─────────────────────────────────────────────
//
// query_artifact is GENERIC: it embeds NO project's artifact schema. Named
// projections are registration-driven via the harness-owned `projections`
// registry in orr-else/contract. A consuming-project extension registers each
// projection under a `<artifactId>:<name>` key (e.g. `planContract:writeSet`)
// at load. An UNregistered named projection falls back to the generic dot-path
// selector — there is NO built-in project default.

/**
 * Build the namespaced registry key for a projection: `<artifactId>:<name>`.
 * This lets the flat last-wins `projections` registry hold projections for any
 * artifact type without the harness knowing any artifact schema.
 */
function projectionKey(artifactId: string, projectionName: string): string {
  return `${artifactId}:${projectionName}`;
}

/**
 * Try each candidate selector in `def.selectors` against `root` in order.
 * Returns the first that resolves to a defined value plus the selector used.
 * If no selector resolves, returns { value: undefined, resolvedSelector: def.selectors[0] }
 * so callers have a primary selector for error messages.
 */
function resolveProjectionValue(
  root: unknown,
  def: ProjectionDef
): { value: unknown; resolvedSelector: string } {
  for (const sel of def.selectors) {
    const v = safeSelectPath(root, sel);
    if (v !== undefined) {
      return { value: v, resolvedSelector: sel };
    }
  }
  return { value: undefined, resolvedSelector: def.selectors[0] };
}

/**
 * Find the closest projection name to `name` by Levenshtein distance,
 * for use in retry hints. Returns undefined when there are no candidates or the
 * closest match is too distant (> maxDistance edits) to be useful.
 */
function closestProjection(
  name: string,
  candidates: string[],
  maxDistance = 4
): string | undefined {
  let best: string | undefined;
  let bestDist = maxDistance + 1;

  for (const candidate of candidates) {
    const dist = levenshtein(name.toLowerCase(), candidate.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }

  return bestDist <= maxDistance ? best : undefined;
}

/** Simple two-row iterative Levenshtein distance (no recursion, O(n) space). */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // prev[j] = edit distance between a[0..i-1] and b[0..j-1]
  let prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }

  return prev[n];
}

// ─── JSON Pointer normalization ───────────────────────────────────────────────

/**
 * Normalize a selector to dot-path form.
 *
 * Accepts:
 *   - JSON Pointer (RFC 6901): "/foo/bar/0" → "foo.bar.0"
 *     Only the slash-separated form is recognized; the `~0` / `~1` escape
 *     sequences are decoded to their literal equivalents.
 *   - Plain dot-path: returned as-is after trimming.
 *
 * This is a light normalization pass — it does NOT validate the selector
 * further; safeSelectPath handles the actual traversal + safety checks.
 */
export function normalizeSelectorToDotPath(selector: string): string {
  const trimmed = selector.trim();
  if (!trimmed.startsWith('/')) return trimmed;

  // JSON Pointer: strip leading slash, split on '/', decode escapes.
  return trimmed
    .slice(1) // drop the leading '/'
    .split('/')
    .map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');
}

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

// ─── Schema-mode constants (named — no magic numbers) ────────────────────────

/** Maximum depth the schema extraction recurses into nested objects/arrays. */
export const SCHEMA_MAX_DEPTH = 8;

/**
 * Fallback recursion depth used when the full-depth schema exceeds
 * SCHEMA_MAX_BYTES. Shallow enough to always fit; deep enough to be useful.
 */
const SCHEMA_FALLBACK_DEPTH = 2;

/** Maximum number of object keys enumerated per level in schema mode. */
export const SCHEMA_MAX_KEYS_PER_LEVEL = 30;

/** Maximum byte length of the schema output before truncation. */
export const SCHEMA_MAX_BYTES = 24_000;

// ─── Schema extraction ────────────────────────────────────────────────────────

/**
 * JSON-type names returned in schema mode.
 * Values are dropped; only type labels and array lengths are kept.
 */
type JsonTypeName = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

/**
 * A single node in the recursive schema shape.
 */
export interface SchemaNode {
  type: JsonTypeName;
  /** Present on array nodes: number of elements in the array. */
  length?: number;
  /**
   * Present on object nodes: record of key → SchemaNode for each enumerated
   * key (up to SCHEMA_MAX_KEYS_PER_LEVEL keys; truncated with a sentinel entry
   * when more exist).
   */
  properties?: Record<string, SchemaNode>;
  /**
   * Present on array nodes where the element type is object: a single
   * representative SchemaNode for the first element, so agents can see the
   * shape of array items without fetching all values.
   */
  items?: SchemaNode;
  /**
   * Set to true when the key count or recursion depth was capped.
   * Signals that there are more keys/levels than shown.
   */
  truncated?: true;
}

/**
 * Extract the recursive shape of `value` up to `maxDepth` levels deep,
 * with up to `maxKeys` keys per object level.
 * Values are always dropped — only types, key names, and array lengths remain.
 *
 * Prototype-polluting keys (__proto__, constructor, prototype) are skipped
 * to preserve the same safety invariant as safeSelectPath.
 */
function extractSchema(
  value: unknown,
  depth: number,
  maxDepth: number,
  maxKeys: number
): SchemaNode {
  const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return { type: 'string' };
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };

  if (Array.isArray(value)) {
    const node: SchemaNode = { type: 'array', length: value.length };
    if (depth < maxDepth && value.length > 0) {
      // Provide a representative schema for the first element
      node.items = extractSchema(value[0], depth + 1, maxDepth, maxKeys);
    }
    return node;
  }

  if (typeof value === 'object') {
    const node: SchemaNode = { type: 'object' };
    if (depth < maxDepth) {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !BLOCKED_KEYS.has(k));
      const truncated = entries.length > maxKeys;
      const sliced = truncated ? entries.slice(0, maxKeys) : entries;
      const properties: Record<string, SchemaNode> = {};
      for (const [k, v] of sliced) {
        properties[k] = extractSchema(v, depth + 1, maxDepth, maxKeys);
      }
      node.properties = properties;
      if (truncated) node.truncated = true;
    } else {
      // At depth limit: still report the type but no properties
      node.truncated = true;
    }
    return node;
  }

  // Fallback for exotic types (Function, Symbol, etc.) — treat as string shape
  return { type: 'string' };
}

// ─── Size estimate helpers ────────────────────────────────────────────────────

/**
 * Estimate the token count for a serialized JSON string using the
 * TOKEN_ESTIMATE_CHARS_PER_TOKEN heuristic (chars / 4 for mixed text/code).
 * This is intentionally a fast approximation — agents use it to gauge whether
 * a projection fits their context budget BEFORE expanding it inline.
 */
function estimateTokens(byteLength: number): number {
  return Math.ceil(byteLength / ArtifactQueryDefaults.TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

/** Serialize `value` to a string for byte/token measurement. */
function serializeForMeasure(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Compute byteCount + tokenEstimate for an already-serialized string. */
function sizeEstimate(serialized: string): { byteCount: number; tokenEstimate: number } {
  const byteCount = Buffer.byteLength(serialized, 'utf8');
  return {
    byteCount,
    tokenEstimate: estimateTokens(byteCount)
  };
}

// ─── Too-much-data guard (req 4) ──────────────────────────────────────────────

interface TooMuchDataResult {
  tooMuchData: true;
  itemCount?: number;
  byteCount: number;
  tokenEstimate: number;
  representativeSamples: unknown[];
  narrowerSelectorHint: string;
  nextAction: 'rerun_with_narrower_selector';
  recovery: string[];
}

/**
 * Checks whether `value` serializes beyond RESULT_MAX_BYTES.
 * If so, returns a TooMuchDataResult with counts + representative samples
 * + size estimates (byteCount + tokenEstimate) so agents can gauge the cost.
 * Returns null when the value is within the cap.
 */
function tooMuchDataGuard(value: unknown, selector: string, artifactId: string): TooMuchDataResult | null {
  const serialized = serializeForMeasure(value);

  if (Buffer.byteLength(serialized, 'utf8') <= ArtifactQueryDefaults.RESULT_MAX_BYTES) return null;

  const { byteCount, tokenEstimate } = sizeEstimate(serialized);
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
    byteCount,
    tokenEstimate,
    representativeSamples: Array.isArray(samples) ? samples : [samples],
    narrowerSelectorHint: exampleNarrowing !== selector ? exampleNarrowing : `${selector}.<key>`,
    nextAction: 'rerun_with_narrower_selector',
    recovery: [
      `The selected value from artifact "${artifactId}" at selector "${selector}" is ${byteCount} bytes (~${tokenEstimate} tokens, cap: ${ArtifactQueryDefaults.RESULT_MAX_BYTES} bytes).`,
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
   * Dot-path or JSON Pointer selector for ad-hoc subtree extraction.
   *
   * Dot-path syntax: "foo.bar.0" selects root.foo.bar[0].
   * JSON Pointer syntax (RFC 6901): "/foo/bar/0" — normalized automatically
   * to the equivalent dot-path before traversal, so "/writeSet/0" and
   * "writeSet.0" are equivalent.
   * Empty string or omitted selector returns the artifact root (subject to
   * the too-much-data cap).
   * Mutually exclusive with `projection`.
   */
  selector?: string;
  /**
   * When true, return a schema-aware summary of the artifact's available
   * projections (or top-level keys for unknown artifact types) with size
   * estimates (byteCount + tokenEstimate) per projection/key — WITHOUT the
   * full content.  Use this BEFORE requesting a large projection inline so
   * agents can decide what to fetch within their context budget.
   *
   * When the artifact type has registered named projections, the summary is
   * schema-aware (lists those registered projections).  When it has none (no
   * registered projections, e.g. `artifactPath` or an unregistered artifactId),
   * it lists top-level keys.
   *
   * Mutually exclusive with `projection`, `selector`, and `schema`.
   */
  summary?: boolean;
  /**
   * When true, return the recursive SHAPE of the selected artifact/subtree:
   * object keys + each value's TYPE + array LENGTHS, with VALUES DROPPED.
   * This lets an agent navigate an unfamiliar large JSON cheaply before
   * choosing a projection/selector.
   *
   * The shape is bounded by:
   *   - SCHEMA_MAX_DEPTH: maximum recursion depth
   *   - SCHEMA_MAX_KEYS_PER_LEVEL: max keys per object level (excess → truncated:true)
   *   - SCHEMA_MAX_BYTES: total byte cap on the serialized schema
   *
   * Security: resolve/scope-check is performed BEFORE reading, identical to
   * all other modes.
   *
   * Mutually exclusive with `projection`, `selector`, and `summary`.
   * Composes with `artifactId` / `artifactPath` for path resolution.
   */
  schema?: boolean;
}

export interface ArtifactQueryRejection {
  status: 'rejected';
  reason: string;
  validProjections?: string[];
  artifactPath?: string;
  exists: boolean;
}

/** Size estimate attached to every successful projection/selector result. */
export interface SizeEstimate {
  /** JSON-serialized byte count of the returned result. */
  byteCount: number;
  /**
   * Estimated token count (byteCount / TOKEN_ESTIMATE_CHARS_PER_TOKEN).
   * Heuristic approximation — use to gauge context-budget cost before
   * requesting a projection inline.
   */
  tokenEstimate: number;
}

export interface ArtifactQuerySuccess {
  status: 'ok';
  artifactId: string;
  artifactPath: string;
  selector: string;
  result: unknown;
  /** Size of the returned `result` — use to gauge context cost. */
  sizeEstimate: SizeEstimate;
}

/** One entry in a schema-aware or generic artifact summary. */
export interface ProjectionSummaryEntry {
  /** Projection name (schema-aware) or top-level key name (generic). */
  name: string;
  /** Human-readable description (schema-aware only; absent for generic keys). */
  description?: string;
  /**
   * Whether this projection's selector resolves to an actual value in the
   * artifact being queried.  Schema-aware projections are listed even when
   * the selector is absent so agents see the full menu; this flag
   * distinguishes "present and fetchable" from "registered but unavailable".
   *
   * Always true for generic (non-schema-aware) summaries because generic
   * entries are derived directly from the artifact's top-level keys.
   */
  available: boolean;
  /**
   * The selector that would be used to retrieve this projection.
   * For multi-candidate projections, this is the first candidate that
   * actually resolves in the artifact; for unavailable projections it is the
   * primary (first) candidate selector.
   */
  resolvedSelector: string;
  /** Size estimate for the value at this projection/key (zero when unavailable). */
  sizeEstimate: SizeEstimate;
}

export interface ArtifactSummary {
  status: 'summary';
  artifactId: string;
  artifactPath: string;
  /**
   * Whether the summary is schema-aware (true) or generic top-level key
   * enumeration (false).  Schema-aware summaries list the named projection
   * registry entries even when the artifact doesn't contain every key.
   */
  schemaAware: boolean;
  /** Total byte + token estimates for the ENTIRE artifact. */
  totalSizeEstimate: SizeEstimate;
  /**
   * Per-projection or per-key size estimates WITHOUT content.
   * Agents use this to pick which projections to fetch inline.
   */
  projections: ProjectionSummaryEntry[];
}

/** Result returned by schema mode. */
export interface ArtifactSchemaResult {
  status: 'schema';
  artifactId: string;
  artifactPath: string;
  /**
   * The effective selector used (empty string = root of the artifact).
   * Mirrors ArtifactQuerySuccess.selector so callers can correlate.
   */
  selector: string;
  /**
   * Recursive shape of the selected value: keys + types + array lengths,
   * values dropped.
   */
  shape: SchemaNode;
  /** Size estimate for the serialized schema shape itself. */
  sizeEstimate: SizeEstimate;
  /** Bounds applied during extraction — useful for understanding truncation. */
  bounds: {
    maxDepth: number;
    maxKeysPerLevel: number;
    maxBytes: number;
  };
  /**
   * True when the serialized schema exceeded SCHEMA_MAX_BYTES and was
   * truncated.  Use a narrower selector to see deeper structure.
   */
  truncated: boolean;
}

export type ArtifactQueryResult = ArtifactQuerySuccess | ArtifactQueryRejection | TooMuchDataResult | ArtifactSummary | ArtifactSchemaResult;

// ─── ArtifactQuery class ──────────────────────────────────────────────────────

export class ArtifactQuery {
  constructor(private readonly artifactPaths: ArtifactPaths) {}

  public async query(input: ArtifactQueryInput): Promise<ArtifactQueryResult> {
    // 1. Validate mutual exclusivity of (artifactId / artifactPath) and (projection / selector / summary / schema)
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
    if (input.summary && (input.projection || (input.selector !== undefined && input.selector !== ''))) {
      return this.rejection(
        'Provide either "summary" (size overview without content) or "projection"/"selector" (content extraction), not both.',
        undefined,
        false
      );
    }
    if (input.schema && input.summary) {
      return this.rejection(
        'Provide either "schema" (recursive shape without values) or "summary" (size overview), not both.',
        undefined,
        false
      );
    }
    if (input.schema && (input.projection || (input.selector !== undefined && input.selector !== ''))) {
      return this.rejection(
        'Provide either "schema" (recursive shape without values) or "projection"/"selector" (content extraction), not both.',
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

    // 4. Summary mode — return schema-aware or generic size estimates without content
    if (input.summary) {
      return this.buildSummary(parsed, resolvedId, resolvedPath);
    }

    // 4b. Schema mode — return recursive shape without values
    if (input.schema) {
      return this.buildSchemaResult(parsed, resolvedId, resolvedPath, '');
    }

    // 5. Resolve selector from projection or raw selector input
    let effectiveSelector: string;
    let value: unknown;

    if (input.projection) {
      const projDef = this.lookupProjection(resolvedId, input.projection);
      if (!projDef) {
        // UNregistered named projection: fall back to the GENERIC dot-path
        // selector. The harness embeds NO project's artifact schema, so an
        // unregistered projection name is treated as a plain selector against
        // the artifact JSON. (Consuming-project projections are registered via
        // projections.register at extension load.)
        effectiveSelector = normalizeSelectorToDotPath(input.projection);
        value = safeSelectPath(parsed, effectiveSelector);

        if (value === undefined) {
          const validProjections = this.validProjectionNames(resolvedId);
          const hint = closestProjection(input.projection, validProjections);
          const hintLine = hint ? ` Retry hint: projection=${hint}` : '';
          return {
            status: 'rejected',
            reason: `Unknown projection "${input.projection}" for artifact type "${resolvedId}". This projection name is not registered and did not resolve as a dot-path selector; use one of the validProjections listed, or provide a dot-path "selector" instead.${hintLine}`,
            ...(validProjections.length > 0 ? { validProjections } : {}),
            artifactPath: resolvedPath,
            exists: true
          };
        }
      } else {
        // Projection is registered — try each candidate selector.
        const { value: projValue, resolvedSelector } = resolveProjectionValue(parsed, projDef);
        effectiveSelector = resolvedSelector;
        value = projValue;

        if (value === undefined) {
          // "Registered projection whose selector is absent in this artifact."
          // This is a schema-drift case, not an unknown-projection error.
          const validProjections = this.validProjectionNames(resolvedId);
          const candidateList = projDef.selectors.join('", "');
          return {
            status: 'rejected',
            reason: `Projection "${input.projection}" is registered but its selector(s) ["${candidateList}"] did not match any key in artifact "${resolvedId}". The artifact may use a different schema version. Try the "schema" or "summary" modes to inspect the actual artifact shape.`,
            ...(validProjections.length > 0 ? { validProjections } : {}),
            artifactPath: resolvedPath,
            exists: true
          };
        }
      }
    } else {
      // Normalize JSON Pointer ("/foo/bar/0") to dot-path ("foo.bar.0") if needed
      effectiveSelector = normalizeSelectorToDotPath(input.selector ?? '');
      value = safeSelectPath(parsed, effectiveSelector);

      if (value === undefined && effectiveSelector) {
        const validProjections = this.validProjectionNames(resolvedId);
        // Provide a projection retry hint when the raw selector looks like a registered projection name.
        const hint = closestProjection(effectiveSelector, validProjections);
        const hintLine = hint ? ` Retry hint: projection=${hint}` : '';
        return {
          status: 'rejected',
          reason: `Selector "${effectiveSelector}" did not match any value in artifact "${resolvedId}".${validProjections.length > 0 ? ' Use a named projection for schema-aware access.' : ''}${hintLine}`,
          validProjections: validProjections.length > 0 ? validProjections : undefined,
          artifactPath: resolvedPath,
          exists: true
        };
      }
    }

    // 7. Too-much-data guard (req 4)
    const tooMuch = tooMuchDataGuard(value, effectiveSelector || '(root)', resolvedId);
    if (tooMuch) return tooMuch;

    // 8. Return success with size estimate
    const serialized = serializeForMeasure(value);
    return {
      status: 'ok',
      artifactId: resolvedId,
      artifactPath: resolvedPath,
      selector: effectiveSelector,
      result: value,
      sizeEstimate: sizeEstimate(serialized)
    };
  }

  /**
   * Build a schema-aware (or generic) summary of an artifact's projections
   * with per-projection size estimates but WITHOUT returning any content.
   *
   * For artifact types with registered named projections, lists each
   * registered projection — even when the artifact doesn't contain every key —
   * so agents see the full menu and its cost.
   * Each entry includes an `available` flag indicating whether the projection's
   * selector resolves against this particular artifact (guards against stale
   * menus that list projections which don't exist in the artifact).
   * For artifact types with no registered projections, lists top-level JSON keys.
   */
  private buildSummary(parsed: unknown, artifactId: string, artifactPath: string): ArtifactSummary {
    const totalSerialized = serializeForMeasure(parsed);
    const totalSizeEstimate = sizeEstimate(totalSerialized);
    const registeredNames = this.validProjectionNames(artifactId);
    const schemaAware = registeredNames.length > 0;

    let projections: ProjectionSummaryEntry[];

    if (schemaAware) {
      projections = registeredNames.map((name) => {
        const def = this.lookupProjection(artifactId, name)!;
        // Try each candidate selector in order; use the first that resolves.
        const { value, resolvedSelector } = resolveProjectionValue(parsed, def);
        const available = value !== undefined;
        // Unavailable projections have no content → zero size estimate.
        const { byteCount: projBytes, tokenEstimate: projTokens } = available
          ? sizeEstimate(serializeForMeasure(value))
          : { byteCount: 0, tokenEstimate: 0 };
        return {
          name,
          ...(def.description !== undefined ? { description: def.description } : {}),
          available,
          resolvedSelector,
          sizeEstimate: { byteCount: projBytes, tokenEstimate: projTokens }
        };
      });
    } else {
      // Generic: enumerate top-level keys (always available since derived from artifact)
      const root = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
      projections = Object.entries(root).map(([name, value]) => {
        const serialized = serializeForMeasure(value);
        return {
          name,
          available: true,
          resolvedSelector: name,
          sizeEstimate: sizeEstimate(serialized)
        };
      });
    }

    return {
      status: 'summary',
      artifactId,
      artifactPath,
      schemaAware,
      totalSizeEstimate,
      projections
    };
  }

  /**
   * Build the recursive schema shape of `parsed` and return an ArtifactSchemaResult.
   *
   * schema+selector is rejected upstream (mutually exclusive), so selector is
   * always '' here. The dead subtree-selection branch has been removed.
   *
   * Security: resolve/scope-check is always done BEFORE this method is called,
   * so `parsed` is already read from a validated path.
   */
  private buildSchemaResult(
    parsed: unknown,
    artifactId: string,
    artifactPath: string,
    selector: string
  ): ArtifactSchemaResult {
    // selector is always '' (schema+selector is rejected before this is called)
    const valueToSchema = parsed;

    const shape = extractSchema(
      valueToSchema,
      0,
      SCHEMA_MAX_DEPTH,
      SCHEMA_MAX_KEYS_PER_LEVEL
    );

    const serialized = serializeForMeasure(shape);
    const byteLength = Buffer.byteLength(serialized, 'utf8');
    let finalShape = shape;
    let truncated = false;

    if (byteLength > SCHEMA_MAX_BYTES) {
      // The schema itself is too large; rebuild with tighter depth.
      // SCHEMA_FALLBACK_DEPTH is shallow enough to always fit within the cap.
      const tightShape = extractSchema(
        valueToSchema,
        0,
        SCHEMA_FALLBACK_DEPTH,
        SCHEMA_MAX_KEYS_PER_LEVEL
      );
      finalShape = { ...tightShape, truncated: true };
      truncated = true;
    }

    const finalSerialized = serializeForMeasure(finalShape);
    return {
      status: 'schema',
      artifactId,
      artifactPath,
      selector,
      shape: finalShape,
      sizeEstimate: sizeEstimate(finalSerialized),
      bounds: {
        maxDepth: SCHEMA_MAX_DEPTH,
        maxKeysPerLevel: SCHEMA_MAX_KEYS_PER_LEVEL,
        maxBytes: SCHEMA_MAX_BYTES
      },
      truncated
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

  private lookupProjection(artifactId: string, projectionName: string): ProjectionDef | undefined {
    return projections.get(projectionKey(artifactId, projectionName));
  }

  private validProjectionNames(artifactId: string): string[] {
    const prefix = `${artifactId}:`;
    return projections
      .names()
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
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
