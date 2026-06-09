/**
 * ArtifactReader — narrow interface for reading and parsing artifact JSON files.
 *
 * Used by ArtifactQuery to read structured JSON artifacts. Injecting a fake
 * ArtifactReader in tests lets you exercise projection/selector/schema logic
 * with in-memory artifact data without writing real files.
 *
 * INJECTABLE: the real implementation delegates to FileSystemPort.
 * Tests inject a fake that returns in-memory data.
 *
 * Note: existence checks and path-scope validation remain in ArtifactQuery
 * and are not part of this adapter — ArtifactReader only handles the read.
 */

import { nodeFileSystemPort, type FileSystemPort } from './FileSystemPort.js';

export interface ArtifactReader {
  /**
   * Read and parse the artifact JSON at the given path.
   * Throws when the file cannot be read or the content is not valid JSON.
   */
  readJson(filePath: string): unknown;
}

/**
 * Real ArtifactReader — delegates to FileSystemPort.
 */
export class NodeArtifactReader implements ArtifactReader {
  constructor(private readonly fs: FileSystemPort = nodeFileSystemPort) {}

  readJson(filePath: string): unknown {
    const raw = this.fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  }
}

export const nodeArtifactReader: ArtifactReader = new NodeArtifactReader();
