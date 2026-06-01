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
import { EnvVars } from '../constants/index.js';

// ─── Caps (named constants — no magic numbers) ────────────────────────────────

/** Maximum number of nearest-match candidates returned per call. */
export const PATH_CONTEXT_MAX_NEAR_MATCHES = 5;

/** Maximum number of files scanned when searching for nearest matches. */
export const PATH_CONTEXT_MAX_SCAN_FILES = 500;

/** Maximum lines that may be requested in a single safe_read_slice call. */
export const PATH_CONTEXT_MAX_SLICE_LINES = 400;

// ─── Path-safety helpers (mirrors ArtifactQuery / FileAccessPolicy) ───────────

/**
 * Canonicalize a path: resolve symlinks via realpathSync where the file
 * exists; for a non-existent path, canonicalize the deepest existing ancestor
 * and re-join the missing tail segments.
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
 * Uses canonicalized paths and a separator-boundary check so that
 * `/artifacts-evil` does NOT match a root of `/artifacts`.
 */
function isPathInside(childPath: string, rootPath: string): boolean {
  const rel = path.relative(canonicalPath(rootPath), canonicalPath(childPath));
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve the allowed roots for path-context checks.
 * Mirrors allowedArtifactRoots in ArtifactQuery but without the bead artifact
 * sub-directory — the path-context tool scopes to the whole worktree and
 * project root because it is a general file-discovery helper.
 */
function allowedRoots(projectRoot: string): string[] {
  const worktreePath =
    process.env[EnvVars.WORKTREE_PATH] ||
    process.env[EnvVars.PROJECT_ROOT] ||
    projectRoot;

  // Deduplicate in case worktree and project root coincide.
  const candidates = [
    canonicalPath(worktreePath),
    canonicalPath(projectRoot)
  ];
  const seen = new Set<string>();
  return candidates.filter(root => {
    if (seen.has(root)) return false;
    seen.add(root);
    return true;
  });
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
}

/** Returned when the resolved path is outside the allowed scope. */
export interface PathContextOutOfScope {
  status: 'out_of_scope';
  reason: string;
  recovery: string[];
}

/** Returned when the path does not exist. */
export interface PathContextNotFound {
  status: 'not_found';
  exists: false;
  /** Path as provided (not resolved, to avoid leaking canonical system paths). */
  providedPath: string;
  nearestMatches: string[];
  recovery: string[];
}

/** Returned for a successful path resolution (file exists). */
export interface PathContextFound {
  status: 'found';
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
}

export type PathContextResult = PathContextFound | PathContextNotFound | PathContextOutOfScope;

// ─── PathContext class ────────────────────────────────────────────────────────

export class PathContext {
  constructor(private readonly projectRoot: string) {}

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
        status: 'not_found',
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
    const roots = allowedRoots(this.projectRoot);

    // Resolve the candidate: absolute as-is, relative against cwd.
    const resolved = path.isAbsolute(input.filePath)
      ? input.filePath
      : path.resolve(input.filePath);

    // Scope check — must be inside at least one allowed root.
    const inScope = roots.some(root => isPathInside(resolved, root));
    if (!inScope) {
      return {
        status: 'out_of_scope',
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
        status: 'not_found',
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
    const matchedRoot = roots.find(root => isPathInside(resolved, root)) ?? roots[0]!;
    const canonicalRelativePath = path.relative(matchedRoot, canonicalPath(resolved));

    const validOffsetRange = { min: 1, max: Math.max(1, totalLines) };

    // Validate optional offset.
    const hasOffset = input.offset !== undefined && input.offset !== null;
    let requestedOffsetValid: boolean | null = null;
    let correctedOffset: number | null = null;
    let slice: string | null = null;

    if (hasOffset && isReadableFile) {
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
      status: 'found',
      exists: true,
      canonicalRelativePath,
      totalLines,
      validOffsetRange,
      requestedOffsetValid,
      correctedOffset,
      slice,
      nearestMatches: []
    };
  }
}
