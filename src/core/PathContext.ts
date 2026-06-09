/**
 * PathContext — path-aware read and file-discovery helper.
 *
 * Design goals:
 * - Cut wasted retries from non-existent paths (ENOENT) and invalid offsets
 *   (offset-beyond-EOF) before the model issues raw read calls.
 * - Expose existence, canonical relative path, total lines, valid next offsets,
 *   and nearest matches (closest existing paths by name similarity) WITHOUT
 *   forcing the model to guess.
 * - Security: all inputs are canonicalized and SCOPE-CHECKED against allowed
 *   roots (active worktree + project root), mirroring the tvxo/ArtifactQuery
 *   pattern. Out-of-scope paths return a structured rejection — no
 *   content/existence-of-target leak.
 * - Best-effort: never throws. All errors produce structured rejection results.
 *
 * Nearest-match suggestions use a bounded walk of the allowed roots, capped at
 * PATH_CONTEXT_MAX_NEAR_MATCHES, with simple basename/dirname similarity
 * ranking so the model gets actionable hints without a full directory dump.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EnvVars } from '../constants/infra.js';
import { type RuntimeEnvironment, nodeRuntimeEnvironment } from './RuntimeEnvironment.js';
import { skeletons as globalSkeletons, type SkeletonExtractor } from '../contract.js';
import type { RegistryPort } from './ContractRegistrySet.js';
import { PathContextStatus } from './vocabulary.js';
import { nodePathScopeService, type PathScopeService } from './PathScopeService.js';

// ─── Caps (named constants — no magic numbers) ────────────────────────────────

/** Maximum number of nearest-match candidates returned per call. */
export const PATH_CONTEXT_MAX_NEAR_MATCHES = 5;

/** Maximum number of files scanned when searching for nearest matches. */
export const PATH_CONTEXT_MAX_SCAN_FILES = 500;

/** Maximum lines that may be requested in a single safe_read_slice call. */
export const PATH_CONTEXT_MAX_SLICE_LINES = 400;

/** Maximum byte length of the skeleton output (body-elided code structure). */
export const SKELETON_MAX_BYTES = 32_000;

// ─── Skeleton dispatch (delegates to the harness-owned `skeletons` registry) ──

/**
 * Extract a structural skeleton from source code at `filePath`.
 *
 * The harness ships NO built-in language extractors. Per-language skeleton
 * extraction is delegated to the harness-owned `skeletons` registry
 * (src/contract.ts), which consuming-project pi extensions populate via
 * `skeletons.register(ext, (source) => string)` at load.
 *
 * Dispatch is purely by lowercased file extension (including the leading dot,
 * e.g. `.ts`, `.py`). A file with no extension dispatches under the empty
 * string `''`.
 *
 * Returns:
 *   - null   → NO extractor is registered for this extension. The caller FAILS
 *              CLOSED: skeletonContent remains null and skeletonFallback is set
 *              to true to signal the missing-extractor condition. Raw content
 *              is never returned via skeleton mode.
 *   - string → the registered extractor's skeleton output (byte-capped at
 *              SKELETON_MAX_BYTES).
 */
function extractSkeleton(filePath: string, source: string, skeletonsReg: RegistryPort<SkeletonExtractor>): string | null {
  const ext = path.extname(filePath).toLowerCase();

  const extractor = skeletonsReg.get(ext);
  if (!extractor) return null;

  const skeleton = extractor(source);

  // Enforce byte cap
  const bytes = Buffer.byteLength(skeleton, 'utf8');
  if (bytes > SKELETON_MAX_BYTES) {
    // Trim to cap at a newline boundary
    const buf = Buffer.from(skeleton, 'utf8');
    const trimmed = buf.subarray(0, SKELETON_MAX_BYTES).toString('utf8');
    // Trim to last newline to avoid cutting a line mid-character
    const lastNewline = trimmed.lastIndexOf('\n');
    return (lastNewline > 0 ? trimmed.slice(0, lastNewline) : trimmed) +
      '\n// [skeleton truncated at SKELETON_MAX_BYTES]';
  }

  return skeleton;
}

// ─── Path-safety helpers ───────────────────────────────────────────────────────

/**
 * Resolve the allowed roots for path-context checks.
 * Deduplicates in case worktree and project root coincide.
 */
function allowedRoots(projectRoot: string, worktreePath: string, pathScope: PathScopeService): string[] {
  const candidates = [
    pathScope.canonicalPath(worktreePath),
    pathScope.canonicalPath(projectRoot)
  ];
  const seen = new Set<string>();
  return candidates.filter(root => {
    if (seen.has(root)) return false;
    seen.add(root);
    return true;
  });
}

/**
 * Operational/system paths are shared, project-root-scoped artifacts (event log,
 * scratch, worktrees registry, harness config) — NOT per-teammate source. They
 * resolve against the project root regardless of which worktree is active.
 */
function operationalProjectRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  return (
    normalized === 'harness.yaml' ||
    normalized.startsWith('.pi/') ||
    normalized.startsWith('.tmp/') ||
    normalized.startsWith('worktrees/')
  );
}

/**
 * Resolve a relative path to EXACTLY ONE deterministic root by path class —
 * never an existsSync race across roots (d5b2/g9ye):
 *   - operational/system paths → the shared project root
 *   - everything else (source) → the active teammate worktree ONLY
 * A source file missing from the worktree therefore resolves to a (non-existent)
 * worktree path and is reported not_found — it must NEVER silently fall through
 * to the project-root copy and cross the teammate boundary. Absolute paths are
 * taken as-is and validated by the caller's scope check.
 */
function resolveCandidatePath(filePath: string, projectRoot: string, worktreePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  const root = operationalProjectRelativePath(filePath) ? projectRoot : worktreePath;
  return path.resolve(root, filePath);
}

// ─── Nearest-match search ──────────────────────────────────────────────────────

/**
 * Score how similar `candidateName` is to `targetName` (both basenames).
 * Higher score = more similar. Pure heuristic — enough for actionable hints.
 */
function similarity(targetName: string, candidateName: string): number {
  const t = targetName.toLowerCase();
  const c = candidateName.toLowerCase();
  if (t === c) return 3;
  if (c.startsWith(t) || t.startsWith(c)) return 2;
  // Count shared leading characters
  let shared = 0;
  for (let index = 0; index < Math.min(t.length, c.length); index++) {
    if (t[index] === c[index]) shared++;
    else break;
  }
  return shared / Math.max(t.length, 1);
}

/**
 * Walk `rootDir` up to `maxFiles` entries and collect real files.
 * Returns paths relative to `rootDir` in posix form.
 */
function walkFiles(rootDir: string, maxFiles: number): string[] {
  const results: string[] = [];
  const queue: string[] = [rootDir];

  while (queue.length > 0 && results.length < maxFiles) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden directories and common noise dirs
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          queue.push(fullPath);
        }
      } else if (entry.isFile()) {
        results.push(path.relative(rootDir, fullPath));
      }
    }
  }

  return results;
}

/**
 * Find the closest existing files to `candidatePath` within `roots`.
 * Returns an array of relative paths (relative to the first matching root),
 * capped at PATH_CONTEXT_MAX_NEAR_MATCHES.
 */
function nearestMatches(candidatePath: string, roots: string[]): string[] {
  const targetBasename = path.basename(candidatePath);
  const targetDirname = path.dirname(candidatePath);

  const scored: Array<{ relativePath: string; score: number }> = [];
  const remaining = PATH_CONTEXT_MAX_SCAN_FILES;
  let scanned = 0;

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const files = walkFiles(root, remaining - scanned);
    scanned += files.length;

    for (const relFile of files) {
      const fileBasename = path.basename(relFile);
      const baseSim = similarity(targetBasename, fileBasename);

      // Also reward files in the same directory subtree
      const fileDir = path.dirname(relFile);
      const dirSim = similarity(targetDirname, fileDir) * 0.3;

      scored.push({ relativePath: relFile, score: baseSim + dirSim });
    }

    if (scanned >= remaining) break;
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, PATH_CONTEXT_MAX_NEAR_MATCHES)
    .filter(item => item.score > 0)
    .map(item => item.relativePath);
}

// ─── Line-counting helper ─────────────────────────────────────────────────────

/**
 * Count the number of newline-delimited lines in a file.
 * Returns 0 for empty files and throws for unreadable files.
 */
function countLines(filePath: string): number {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content) return 0;
  // Count newlines; a trailing newline means the last line is included in the split
  const lines = content.split('\n');
  // If the file ends with a newline, the last element is an empty string —
  // the conventional line count is lines - 1 in that case.
  if (lines.length > 0 && lines[lines.length - 1] === '') return lines.length - 1;
  return lines.length;
}

/**
 * Extract a bounded line slice from a file.
 * Lines are 1-indexed (line 1 = first line of the file).
 * Returns the lines as a single string with newlines preserved.
 */
function readSlice(filePath: string, startLine: number, endLine: number): string {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  // Clamp to valid range (1-indexed to 0-indexed)
  const from = Math.max(0, startLine - 1);
  const to = Math.min(lines.length, endLine);
  return lines.slice(from, to).join('\n');
}

// ─── Tool input / output types ────────────────────────────────────────────────

export interface PathContextInput {
  /** The candidate file path to inspect. May be absolute or relative to cwd. */
  filePath: string;
  /**
   * Optional 1-based line offset to validate. When provided, the response
   * indicates whether this offset is within the file and what the valid range is.
   */
  offset?: number;
  /**
   * Optional number of lines to request (used together with `offset`).
   * Capped at PATH_CONTEXT_MAX_SLICE_LINES.
   */
  limit?: number;
  /**
   * When true, return a structural skeleton of the file instead of a bounded
   * line slice.
   *
   * The harness ships NO built-in language extractors. Skeleton extraction is
   * dispatched by lowercased file extension to the harness-owned `skeletons`
   * registry (src/contract.ts), which consuming-project pi extensions populate
   * via `skeletons.register(ext, (source) => string)` at load.
   *   - An extractor IS registered for the extension → its skeleton output is
   *     returned in `skeletonContent` (capped at SKELETON_MAX_BYTES).
   *   - NO extractor is registered for the extension → FAIL CLOSED: the
   *     request does not return raw content. `skeletonContent` is null and
   *     `skeletonFallback:true` signals the missing-extractor condition. Use
   *     explicit offset+limit for raw reads instead.
   *
   * Output is capped at SKELETON_MAX_BYTES.
   * Mutually exclusive with `offset`/`limit` (skeleton ignores them when set).
   * Scope-check still applies — out-of-scope paths return 'out_of_scope'.
   */
  skeleton?: boolean;
}

/** Returned when the resolved path is outside the allowed scope. */
export interface PathContextOutOfScope {
  status: typeof PathContextStatus.OUT_OF_SCOPE;
  reason: string;
  recovery: string[];
}

/** Returned when the path does not exist. */
export interface PathContextNotFound {
  status: typeof PathContextStatus.NOT_FOUND;
  exists: false;
  /** Path as provided (not resolved, to avoid leaking canonical system paths). */
  providedPath: string;
  nearestMatches: string[];
  recovery: string[];
}

/** Returned for a successful path resolution (file exists). */
export interface PathContextFound {
  status: typeof PathContextStatus.FOUND;
  exists: true;
  /** Canonical path relative to the matched root (stable reference for the model). */
  canonicalRelativePath: string;
  totalLines: number;
  /** Valid line-number range for native read calls. Always {min:1, max:totalLines}. */
  validOffsetRange: { min: number; max: number };
  /** Whether the requested offset (if any) is within the valid range. */
  requestedOffsetValid: boolean | null;
  /**
   * When a non-null offset was requested and is out of range, provides the
   * corrected first-valid range so the model knows exactly where to start.
   */
  correctedOffset: number | null;
  /**
   * When offset + limit are both provided and valid, contains the bounded text
   * slice (capped at PATH_CONTEXT_MAX_SLICE_LINES). Null otherwise.
   */
  slice: string | null;
  nearestMatches: string[];
  /**
   * When `skeleton:true` was requested AND an extractor is registered for the
   * file's extension, contains the extractor's skeleton output (capped at
   * SKELETON_MAX_BYTES). Null when skeleton mode was not requested, no extractor
   * is registered (fail-closed — see skeletonFallback), or the file is not
   * readable.
   */
  skeletonContent: string | null;
  /**
   * True when `skeleton:true` was requested but NO extractor is registered for
   * the file's extension. In that case `skeletonContent` is null (fail-closed:
   * no raw content is returned). Use explicit offset+limit for raw reads.
   * False when skeleton mode was not requested or an extractor is available.
   */
  skeletonFallback: boolean;
}

export type PathContextResult = PathContextFound | PathContextNotFound | PathContextOutOfScope;

// ─── PathContext class ────────────────────────────────────────────────────────

export class PathContext {
  private readonly skeletonsRegistry: RegistryPort<SkeletonExtractor>;

  constructor(
    private readonly projectRoot: string,
    private readonly env: RuntimeEnvironment = nodeRuntimeEnvironment,
    private readonly pathScope: PathScopeService = nodePathScopeService,
    skeletonsRegistry?: RegistryPort<SkeletonExtractor>
  ) {
    // Default to the global singleton proxy so behaviour is unchanged when no
    // registry is injected. Tests pass a fresh registry from createFreshRegistrySet().
    this.skeletonsRegistry = skeletonsRegistry ?? (globalSkeletons as unknown as RegistryPort<SkeletonExtractor>);
  }

  /** The active teammate worktree root, resolved from the injected environment.
   * Falls back to the project root when no worktree is set (e.g. coordinator). */
  private worktreeRoot(): string {
    return (
      this.env.env(EnvVars.WORKTREE_PATH) ||
      this.env.env(EnvVars.PROJECT_ROOT) ||
      this.projectRoot
    );
  }

  /**
   * Resolve a candidate path and validate optional read offsets.
   * Never throws — all errors produce structured results.
   */
  public resolve(input: PathContextInput): PathContextResult {
    try {
      return this.resolveInner(input);
    } catch (error) {
      // Defensive catch — should never be reached given internal try/catch guards.
      return {
        status: PathContextStatus.NOT_FOUND,
        exists: false,
        providedPath: input.filePath,
        nearestMatches: [],
        recovery: [
          `An unexpected error occurred while resolving "${input.filePath}": ${String(error)}`,
          'Check the path and try again.'
        ]
      };
    }
  }

  private resolveInner(input: PathContextInput): PathContextResult {
    const worktreePath = this.worktreeRoot();
    const roots = allowedRoots(this.projectRoot, worktreePath, this.pathScope);

    const resolved = resolveCandidatePath(input.filePath, this.projectRoot, worktreePath);

    // Scope check — must be inside at least one allowed root.
    const inScope = roots.some(root => this.pathScope.isPathInside(resolved, root));
    if (!inScope) {
      return {
        status: PathContextStatus.OUT_OF_SCOPE,
        reason:
          'The requested path is outside the allowed roots for this context ' +
          '(active worktree and project root). ' +
          'Provide a path inside the worktree or project root.',
        recovery: [
          'Use a path relative to the active worktree or project root.',
          'Do not use "../" traversals to escape the allowed scope.',
          'Use get_artifact_paths for configured artifact locations.'
        ]
      };
    }

    const exists = fs.existsSync(resolved);

    if (!exists) {
      const candidates = nearestMatches(resolved, roots);
      return {
        status: PathContextStatus.NOT_FOUND,
        exists: false,
        providedPath: input.filePath,
        nearestMatches: candidates,
        recovery: [
          `File "${input.filePath}" does not exist.`,
          candidates.length > 0
            ? `Nearest existing files: ${candidates.slice(0, 3).map(p => `"${p}"`).join(', ')}.`
            : 'No similar files found within the allowed roots.',
          'Check the path spelling or use the nearestMatches list to identify the correct file.'
        ]
      };
    }

    // Count lines — best-effort; treat directories or unreadable files gracefully.
    let totalLines = 0;
    let isReadableFile = false;
    try {
      const stat = fs.statSync(resolved);
      if (stat.isFile()) {
        totalLines = countLines(resolved);
        isReadableFile = true;
      }
    } catch {
      // Leave totalLines = 0, isReadableFile = false
    }

    // Compute canonical relative path (relative to the first matching root).
    const matchedRoot = roots.find(root => this.pathScope.isPathInside(resolved, root)) ?? roots[0]!;
    const canonicalRelativePath = path.relative(matchedRoot, this.pathScope.canonicalPath(resolved));

    const validOffsetRange = { min: 1, max: Math.max(1, totalLines) };

    // ── Skeleton mode ────────────────────────────────────────────────────────
    let skeletonContent: string | null = null;
    let skeletonFallback = false;

    if (input.skeleton && isReadableFile) {
      try {
        const source = fs.readFileSync(resolved, 'utf8');
        const result = extractSkeleton(resolved, source, this.skeletonsRegistry);
        if (result === null) {
          // No extractor registered for this extension — FAIL CLOSED: do not
          // return raw content. skeletonFallback signals the missing-extractor
          // condition; skeletonContent remains null. Use offset+limit for raw reads.
          skeletonFallback = true;
        } else {
          skeletonContent = result;
        }
      } catch {
        // Best-effort — leave skeletonContent null
      }
    }

    // ── Validate optional offset (existing behavior) ──────────────────────────
    // Skeleton mode is mutually exclusive with offset/limit: when `skeleton` is
    // set, offset/limit are ignored (no slice, no offset validation) so the
    // result honors the documented PathContextInput contract.
    const hasOffset = input.offset !== undefined && input.offset !== null;
    let requestedOffsetValid: boolean | null = null;
    let correctedOffset: number | null = null;
    let slice: string | null = null;

    if (hasOffset && isReadableFile && !input.skeleton) {
      const requestedOffset = input.offset!;
      requestedOffsetValid = requestedOffset >= 1 && requestedOffset <= totalLines;

      if (!requestedOffsetValid) {
        // Suggest a corrected offset — use line 1 if before the start, or the
        // last valid line if beyond EOF.
        correctedOffset = requestedOffset < 1 ? 1 : totalLines;
      } else if (input.limit !== undefined) {
        // Produce a bounded slice when both offset and limit are valid.
        const cappedLimit = Math.min(
          Math.max(1, input.limit),
          PATH_CONTEXT_MAX_SLICE_LINES
        );
        const endLine = Math.min(requestedOffset + cappedLimit - 1, totalLines);
        try {
          slice = readSlice(resolved, requestedOffset, endLine);
        } catch {
          // Best-effort — leave slice null
        }
      }
    }

    return {
      status: PathContextStatus.FOUND,
      exists: true,
      canonicalRelativePath,
      totalLines,
      validOffsetRange,
      requestedOffsetValid,
      correctedOffset,
      slice,
      nearestMatches: [],
      skeletonContent,
      skeletonFallback
    };
  }
}
