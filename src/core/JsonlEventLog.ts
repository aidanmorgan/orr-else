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

  /**
   * Read and parse only the last `tailBytes` of a JSONL file, visiting every
   * complete record found in that tail window.
   *
   * Uses a bounded byte-offset read (O(tailBytes), not O(file size)).  If the
   * window contains no complete records and the file has content before the
   * window start (i.e. a single event line exceeds tailBytes), the window is
   * doubled and the read is retried — up to a maximum of 32× the initial
   * tailBytes — so oversized events are still returned correctly.
   *
   * Partial lines at the start of each window (created by slicing mid-line) are
   * silently discarded — the first newline boundary in the buffer marks the
   * start of the first complete record.
   *
   * If the file is smaller than `tailBytes`, the whole file is read.
   */
  public async scanTail(filePath: string, tailBytes: number, visitor: (record: unknown) => void): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }

    const fileSize = stat.size;
    if (fileSize === 0) return;

    let window = tailBytes;

    while (true) {
      const start = Math.max(0, fileSize - window);
      const readSize = fileSize - start;

      // Bounded byte-offset read: allocate only what we need.
      const buf = Buffer.allocUnsafe(readSize);
      const fh = await fs.promises.open(filePath, 'r');
      try {
        await fh.read(buf, 0, readSize, start);
      } finally {
        await fh.close();
      }

      const tailText = buf.toString('utf8');

      // Drop the partial first line when we didn't start from byte 0.
      // This trim is defensive: a mid-line fragment is almost always invalid JSON
      // (JSON.parse would reject it), but trimming guarantees we never emit a
      // structurally-valid fragment from an adjacent record.
      const firstNewline = start > 0 ? tailText.indexOf('\n') : -1;
      const cleanText = start > 0 && firstNewline >= 0 ? tailText.slice(firstNewline + 1) : tailText;

      let foundAny = false;
      for (const line of cleanText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const value = JSON.parse(trimmed);
          if (value !== undefined && value !== null) {
            foundAny = true;
            visitor(value);
          }
        } catch {
          // Malformed JSON — skip (same as ndjson strict:false behaviour).
        }
      }

      // If we found records, or we've already read the whole file, we're done.
      if (foundAny || start === 0) break;

      // No complete records found and there is content before our window:
      // the last event line is likely larger than the window.  Grow and retry.
      // Clamp to fileSize so start reaches 0 on the next iteration — this
      // guarantees termination even when a single event line exceeds any
      // arbitrary multiple of tailBytes.
      window = Math.min(window * 2, fileSize);
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
