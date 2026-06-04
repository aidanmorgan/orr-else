/**
 * BeadEventIndex – manages per-bead JSONL index files within an event-store
 * directory.  Extracted from EventStore (structural split, no semantic change).
 *
 * Responsibilities:
 *  - Computing index-file paths (by-bead/<sanitised-beadId>.jsonl)
 *  - Appending events to a bead's index (with stale-index cleanup on failure)
 *  - Reading indexed + gap events back for a given beadId
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './Logger.js';
import { JsonlEventLog } from './JsonlEventLog.js';
import { Component, EventStoreDefaults } from '../constants/index.js';
import type { DomainEvent } from './EventStoreTypes.js';

const existsSync = fs.existsSync;
const mkdirAsync = fs.promises.mkdir;
const rmAsync = fs.promises.rm;

/** Stored in the <beadId>.jsonl.ready marker; tracks per-source-file read offsets. */
export interface BeadIndexMarker {
  version?: number;
  generatedAt?: string;
  sources?: Record<string, number>;
  [key: string]: unknown;
}

/** The subset of an event-store location that BeadEventIndex needs. */
export interface BeadIndexLocation {
  dir: string;
}

export class BeadEventIndex {
  constructor(private readonly eventLog: JsonlEventLog) {}

  // ---------------------------------------------------------------------------
  // Path helpers
  // ---------------------------------------------------------------------------

  private safeIndexFileName(beadId: string): string {
    const sanitized = beadId
      .replace(EventStoreDefaults.UNSAFE_INDEX_PATH_SEGMENT_PATTERN, '-')
      .replace(/^-+|-+$/g, '');
    return `${sanitized || 'bead'}${EventStoreDefaults.INDEX_FILE_EXTENSION}`;
  }

  private indexDir(location: BeadIndexLocation): string {
    return path.join(location.dir, EventStoreDefaults.BEAD_INDEX_DIR);
  }

  private indexPath(location: BeadIndexLocation, beadId: string): string {
    return path.join(this.indexDir(location), this.safeIndexFileName(beadId));
  }

  private indexReadyPath(location: BeadIndexLocation, beadId: string): string {
    return `${this.indexPath(location, beadId)}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`;
  }

  // ---------------------------------------------------------------------------
  // Marker I/O
  // ---------------------------------------------------------------------------

  async readMarker(location: BeadIndexLocation, beadId: string): Promise<BeadIndexMarker | undefined> {
    const markerPath = this.indexReadyPath(location, beadId);
    if (!existsSync(markerPath)) return undefined;
    try {
      const text = await fs.promises.readFile(markerPath, 'utf8');
      const marker = JSON.parse(text) as BeadIndexMarker;
      return (marker && typeof marker === 'object') ? marker as BeadIndexMarker : {};
    } catch {
      return {};
    }
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  private async removeIndexState(indexPath: string, readyPath: string): Promise<void> {
    await rmAsync(indexPath, { force: true, recursive: true }).catch(() => {});
    await rmAsync(readyPath, { force: true, recursive: true }).catch(() => {});
  }

  private async advanceReadyMarker(
    location: BeadIndexLocation,
    beadId: string,
    sourcePath: string,
    indexPath: string,
    readyPath: string
  ): Promise<void> {
    if (!existsSync(readyPath)) return;

    const marker = await this.readMarker(location, beadId);
    if (marker === undefined) return;

    const sourceBasename = path.basename(sourcePath);
    const currentSize = fs.statSync(sourcePath).size;
    const sources = {
      ...(marker.sources ?? {}),
      [sourceBasename]: Math.max(marker.sources?.[sourceBasename] ?? 0, currentSize)
    };
    const nextMarker: BeadIndexMarker = {
      ...marker,
      version: typeof marker.version === 'number' ? marker.version : 1,
      generatedAt: new Date().toISOString(),
      sources
    };
    const tempPath = `${readyPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

    try {
      await fs.promises.writeFile(tempPath, JSON.stringify(nextMarker));
      await fs.promises.rename(tempPath, readyPath);
    } catch (error) {
      await rmAsync(tempPath, { force: true }).catch(() => {});
      await this.removeIndexState(indexPath, readyPath);
      Logger.warn(Component.CORE, 'Removed stale bead event index after ready marker update failure', {
        beadId,
        indexPath,
        readyPath,
        sourcePath,
        error: String(error)
      });
    }
  }

  async append(location: BeadIndexLocation, beadId: string, event: DomainEvent, sourcePath?: string): Promise<void> {
    const dir = this.indexDir(location);
    await mkdirAsync(dir, { recursive: true });
    const iPath = this.indexPath(location, beadId);
    const rPath = this.indexReadyPath(location, beadId);
    try {
      await this.eventLog.append(iPath, event);
      if (sourcePath) {
        await this.advanceReadyMarker(location, beadId, sourcePath, iPath, rPath);
      }
    } catch (error) {
      await this.removeIndexState(iPath, rPath);
      Logger.warn(Component.CORE, 'Removed stale bead event index after append failure', {
        beadId,
        indexPath: iPath,
        readyPath: rPath,
        error: String(error)
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Invalidation
  // ---------------------------------------------------------------------------

  /**
   * Invalidates the by-bead index for every beadId whose index JSONL currently
   * contains events sourced from any of the given primary-file basenames.
   *
   * Call this after a primary JSONL is compacted (rewritten to a smaller file
   * via tmp+rename).  Compaction shrinks the primary, so any stored byte-offset
   * in the per-bead .ready marker becomes stale: the next top-up read would
   * `scanFromOffset` past the end of the compacted file (or into wrong bytes),
   * silently producing a corrupt per-bead projection.
   *
   * Invalidation deletes the .ready marker file for every affected bead index,
   * forcing the next `eventsForBead` call to treat the index as absent and fall
   * back to a full primary-scan rebuild from offset 0 of the compacted file.
   * The index JSONL itself (the cached events) is also removed so the rebuild
   * writes a fresh, self-consistent copy.
   *
   * Only reads the `sources` keys in each .ready file — never the primary JSONL —
   * so this operation is cheap and does not alter the primary files.
   *
   * @param location     The event-store location (contains the events dir path).
   * @param sourceBasenames  The set of primary-file basenames that were compacted
   *                         (e.g. `new Set(['project.jsonl'])`).
   */
  async invalidateForSources(location: BeadIndexLocation, sourceBasenames: Set<string>): Promise<void> {
    if (sourceBasenames.size === 0) return;
    const dir = this.indexDir(location);
    if (!existsSync(dir)) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // Only consider .ready marker files.
      if (!entry.name.endsWith(EventStoreDefaults.INDEX_READY_FILE_EXTENSION)) continue;

      const markerPath = path.join(dir, entry.name);
      let marker: BeadIndexMarker;
      try {
        const text = await fs.promises.readFile(markerPath, 'utf8');
        marker = JSON.parse(text) as BeadIndexMarker;
      } catch {
        continue;
      }

      // Check whether any source tracked in this marker was compacted.
      const sources = marker?.sources ?? {};
      const affected = Object.keys(sources).some(basename => sourceBasenames.has(basename));
      if (!affected) continue;

      // Derive the corresponding index JSONL path from the marker path.
      const indexJsonlPath = markerPath.slice(
        0,
        markerPath.length - EventStoreDefaults.INDEX_READY_FILE_EXTENSION.length
      );

      // Delete both the index JSONL and the .ready marker so the next read rebuilds from scratch.
      await rmAsync(indexJsonlPath, { force: true }).catch(() => {});
      await rmAsync(markerPath, { force: true }).catch(() => {});

      Logger.debug(Component.CORE, 'Invalidated by-bead index after primary compaction', {
        indexJsonlPath,
        markerPath,
        compactedSources: [...sourceBasenames]
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Returns the ordered, de-duplicated events for `beadId` using the index
   * file (if a .ready marker exists) and catching up from the primary JSONL
   * files for any bytes not yet indexed.
   *
   * Returns `undefined` when no .ready marker exists (caller must full-scan).
   */
  async eventsForBead(
    location: BeadIndexLocation,
    beadId: string,
    primaryFilePaths: string[],
    isDomainEvent: (v: unknown) => v is DomainEvent,
    beadIdFor: (e: DomainEvent) => string | undefined,
    compareEvents: (a: DomainEvent, b: DomainEvent) => number
  ): Promise<DomainEvent[] | undefined> {
    const iPath = this.indexPath(location, beadId);
    const marker = await this.readMarker(location, beadId);
    if (!existsSync(iPath) || marker === undefined) return undefined;

    const events: DomainEvent[] = [];

    // Read the index file
    await this.eventLog.scan(iPath, value => {
      if (!isDomainEvent(value)) return;
      if (beadIdFor(value) !== beadId) return;
      events.push(value);
    });

    // Top-up from primary files for bytes beyond what the index captured
    for (const filePath of primaryFilePaths) {
      const indexedSize = marker.sources?.[path.basename(filePath)] || 0;
      const currentSize = fs.statSync(filePath).size;
      if (indexedSize >= currentSize) continue;
      await this.eventLog.scanFromOffset(filePath, indexedSize, value => {
        if (!isDomainEvent(value)) return;
        if (beadIdFor(value) !== beadId) return;
        events.push(value);
      });
    }

    // De-duplicate and sort
    return [...new Map(events.map(e => [e.id, e])).values()].sort(compareEvents);
  }
}
