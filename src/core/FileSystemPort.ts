/**
 * FileSystemPort — narrow interface for filesystem read operations used by
 * the harness's policy and artifact-reading layer.
 *
 * This adapter covers the fs operations in ArtifactQuery (existence check +
 * artifact JSON read) so those classes can be tested with fake fs adapters.
 *
 * INJECTABLE: the real implementation delegates to Node's fs module.
 * Tests inject a fake that provides in-memory file data.
 *
 * NOTE: PathContext's walkFiles/countLines/readSlice are lower-level
 * internal file-reading operations that are NOT covered here — they are
 * tested directly via real-fs integration tests.
 */

import * as realFs from 'fs';

export interface FileSystemPort {
  /** Returns true when the path exists. */
  existsSync(p: string): boolean;
  /** Reads a file and returns its utf-8 content. Throws on ENOENT or read error. */
  readFileSync(p: string, encoding: 'utf8'): string;
}

/**
 * Real FileSystemPort — delegates to Node's fs module.
 */
export const nodeFileSystemPort: FileSystemPort = {
  existsSync: (p: string): boolean => realFs.existsSync(p),
  readFileSync: (p: string, encoding: 'utf8'): string => realFs.readFileSync(p, encoding)
};
