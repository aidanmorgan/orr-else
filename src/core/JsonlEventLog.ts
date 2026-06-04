import * as fs from 'fs';
import * as path from 'path';
import * as ndjson from 'ndjson';
import lockfile from 'proper-lockfile';
import { EventLogDefaults } from '../constants/index.js';

const appendFileAsync = fs.promises.appendFile;
const readdirAsync = fs.promises.readdir;

export class JsonlEventLog {
  /** Per-file in-process promise chains: same-process appends to a file are
   * serialized cheaply (no cross-process lock thrash) before one of them takes
   * the cross-process lock. */
  private readonly appendChains = new Map<string, Promise<void>>();
  public async eventFilePaths(dir: string): Promise<string[]> {
    return (await readdirAsync(dir))
      .filter(file => file.endsWith('.jsonl'))
      .sort()
      .map(file => path.join(dir, file));
  }

  public async scan(filePath: string, visitor: (record: unknown) => void): Promise<void> {
    await this.scanFromOffset(filePath, 0, visitor);
  }

  public async scanFromOffset(filePath: string, offset: number, visitor: (record: unknown) => void): Promise<void> {
    const parser = fs
      .createReadStream(filePath, { encoding: 'utf8', start: Math.max(0, offset) })
      .pipe(ndjson.parse({ strict: false }));

    for await (const value of parser as AsyncIterable<unknown>) {
      if (value !== undefined && value !== null) visitor(value);
    }
  }

  public async append(filePath: string, record: unknown): Promise<void> {
    // Serialize same-process appends to this file, then perform the locked write.
    // The chain link always runs (regardless of the prior link's outcome) and is
    // pruned once it settles with nothing newer queued, keeping the map bounded.
    const previous = this.appendChains.get(filePath) ?? Promise.resolve();
    const link = previous.then(
      () => this.lockedAppend(filePath, record),
      () => this.lockedAppend(filePath, record)
    );
    const guarded = link.catch(() => {});
    this.appendChains.set(filePath, guarded);
    void guarded.finally(() => {
      if (this.appendChains.get(filePath) === guarded) this.appendChains.delete(filePath);
    });
    await link;
  }

  /**
   * Append a single record under a cross-process advisory lock so concurrent
   * worker processes cannot interleave/tear records in the shared events JSONL
   * (13op). The lock is held only for the duration of one append.
   */
  private async lockedAppend(filePath: string, record: unknown): Promise<void> {
    await this.ensureFileExists(filePath);
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(filePath, {
        stale: EventLogDefaults.LOCK_STALE_MS,
        realpath: false,
        retries: {
          retries: EventLogDefaults.LOCK_RETRIES,
          factor: 1.2,
          minTimeout: EventLogDefaults.LOCK_RETRY_MIN_MS,
          maxTimeout: EventLogDefaults.LOCK_RETRY_MAX_MS
        }
      });
      await appendFileAsync(filePath, `${JSON.stringify(record)}\n`);
    } finally {
      await release?.().catch(() => {});
    }
  }

  private async ensureFileExists(filePath: string): Promise<void> {
    const handle = await fs.promises.open(filePath, 'a');
    await handle.close();
  }
}
