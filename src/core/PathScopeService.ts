/**
 * PathScopeService — the single path-containment authority for the harness.
 *
 * Collapses the duplicate canonicalPath / isPathInside implementations that
 * were previously scattered across ArtifactQuery, PathContext, and
 * FileAccessPolicy into one injectable service.
 *
 * INJECTABLE: constructed with a real default (real fs.realpathSync / fs.existsSync)
 * so production wiring works unchanged. Tests inject a FsStaticPort to exercise
 * traversal/symlink/scope behavior without touching the real filesystem.
 */

import * as path from 'path';
import * as realFs from 'fs';

/**
 * Narrow interface for the static fs operations PathScopeService needs.
 * The real implementation delegates to Node's fs module.
 * Tests inject a fake implementation.
 */
export interface FsStaticPort {
  /** Synchronously resolves symlinks; throws when the path does not exist. */
  realpathSync(p: string): string;
  /** Returns true when the path exists (file or directory). */
  existsSync(p: string): boolean;
}

/**
 * Real FsStaticPort implementation — delegates directly to Node's fs module.
 */
export const nodeFsStaticPort: FsStaticPort = {
  realpathSync: (p: string): string => realFs.realpathSync(p),
  existsSync: (p: string): boolean => realFs.existsSync(p)
};

export class PathScopeService {
  constructor(private readonly fsStat: FsStaticPort = nodeFsStaticPort) {}

  /**
   * Canonicalize a path: resolve symlinks via realpathSync where the file
   * exists; for a non-existent path, canonicalize the deepest existing ancestor
   * and re-join the missing tail segments.
   *
   * This is the SINGLE implementation — all consuming sites use this method
   * instead of their own local copies.
   */
  public canonicalPath(value: string): string {
    const resolvedPath = path.resolve(value);
    try {
      return this.fsStat.realpathSync(resolvedPath);
    } catch {
      let currentPath = resolvedPath;
      const missingSegments: string[] = [];
      while (!this.fsStat.existsSync(currentPath)) {
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) return resolvedPath;
        missingSegments.unshift(path.basename(currentPath));
        currentPath = parentPath;
      }
      try {
        return path.join(this.fsStat.realpathSync(currentPath), ...missingSegments);
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
  public isPathInside(childPath: string, rootPath: string): boolean {
    const rel = path.relative(this.canonicalPath(rootPath), this.canonicalPath(childPath));
    return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }
}

/**
 * Shared singleton PathScopeService using real fs.
 * Passed as the default in all consuming constructors so production
 * wiring is unchanged.
 */
export const nodePathScopeService = new PathScopeService(nodeFsStaticPort);
