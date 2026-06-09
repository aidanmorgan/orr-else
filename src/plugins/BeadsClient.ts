/**
 * BeadsClient — centralized bd CLI subprocess access.
 *
 * Responsibilities:
 *  - Owns the single execa('bd') invocation (moved from bd.ts execBd / withBdCliLock).
 *  - Caches read-only command results (bounded size; invalidated by any mutation).
 *  - Serializes mutations through a promise-chain mutex so concurrent mutations
 *    never race the bd filesystem lock.
 *  - Emits lock-wait telemetry when bd invocation latency exceeds a named threshold.
 *
 * Core/plugin boundary: this module lives in src/plugins/ and is used only by
 * bd.ts. Core never imports it — the layering test enforces this.
 */

import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import lockfile from 'proper-lockfile';
import { Logger } from '../core/Logger.js';
import type { Observability } from '../core/Observability.js';
import { BeadsDefaults, Component, SpanName } from '../constants/infra.js';

// ---------------------------------------------------------------------------
// Named constants — no magic numbers
// ---------------------------------------------------------------------------

/**
 * Read-cache: maximum number of distinct command results held in memory.
 * Once the cap is reached the oldest entry is evicted (FIFO / insertion order).
 */
export const BEADS_CACHE_MAX_ENTRIES = 64 as const;

/**
 * Lock-wait telemetry threshold in milliseconds.
 * If acquiring the cross-process bd CLI lock takes longer than this, a
 * Logger.warn entry is emitted with { command, waitedMs }.
 */
export const BEADS_LOCK_WAIT_WARN_MS: number = BeadsDefaults.CLI_LOCK_RETRY_MAX_MS;

// ---------------------------------------------------------------------------
// Internals — lock helpers (preserved from bd.ts execBd / withBdCliLock)
// ---------------------------------------------------------------------------

function bdLockPath(root: string): string {
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return path.join(tmpdir(), 'orr-else-bd-locks', digest, 'bd-cli.lock');
}

async function ensureBdLockFile(root: string): Promise<string> {
  const lockPath = bdLockPath(root);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await open(lockPath, 'a');
  await handle.close();
  return lockPath;
}

interface LockResult<T> {
  value: T;
  lockWaitStartMs: number;
  lockAcquiredMs: number;
}

async function withBdCliLock<T>(fn: () => Promise<T>, root: string): Promise<LockResult<T>> {
  const lockPath = await ensureBdLockFile(root);
  const lockWaitStartMs = Date.now();
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(lockPath, {
      stale: BeadsDefaults.CLI_LOCK_STALE_MS,
      retries: {
        retries: BeadsDefaults.CLI_LOCK_RETRIES,
        factor: 1.1,
        minTimeout: BeadsDefaults.CLI_LOCK_RETRY_MIN_MS,
        maxTimeout: BeadsDefaults.CLI_LOCK_RETRY_MAX_MS
      }
    });
  } catch (error) {
    throw new Error(`Timed out acquiring bd CLI lock after ${Date.now() - lockWaitStartMs}ms: ${String(error)}`);
  }

  const lockAcquiredMs = Date.now();
  const waitedMs = lockAcquiredMs - lockWaitStartMs;
  if (waitedMs > BEADS_LOCK_WAIT_WARN_MS) {
    Logger.warn(Component.BEADS_CLI, 'Waited for bd CLI lock', { waitedMs, lockPath });
  }

  try {
    const value = await fn();
    return { value, lockWaitStartMs, lockAcquiredMs };
  } finally {
    await release?.().catch((error: unknown) => {
      Logger.warn(Component.BEADS_CLI, 'Unable to release bd CLI lock', { lockPath, error: String(error) });
    });
  }
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

function cacheKey(finalArgs: string[], root: string): string {
  return JSON.stringify({ root, args: finalArgs });
}

// ---------------------------------------------------------------------------
// BeadsClient
// ---------------------------------------------------------------------------

export interface BdInvokeOptions {
  /** stdin to pass to bd */
  input?: string;
  /** project root for -C flag and lock path */
  root: string;
}

export interface BdResult {
  stdout: string;
  stderr: string;
}

/**
 * BeadsClient — one instance per coordinator process.
 *
 * Usage:
 *   const client = new BeadsClient();
 *   const result = await client.read(finalArgs, { root });   // cached, concurrent ok
 *   const result = await client.mutate(finalArgs, { root }); // serialized, cache-busting
 */
export class BeadsClient {
  // Read cache: key → BdResult. Map preserves insertion order for FIFO eviction.
  private readonly cache = new Map<string, BdResult>();

  // In-flight read deduplication: key → pending promise.
  // Concurrent identical reads share the same promise so bd is invoked only once.
  private readonly inFlight = new Map<string, Promise<BdResult>>();

  // Mutation serializer: tail of the promise chain (mutations queue behind this).
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly observability?: Observability) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Execute a read-only bd command with result caching.
   * Concurrent identical reads share a single in-flight invocation — if two
   * reads for the same (args+root) arrive before the first completes, both
   * await the same promise.  Once it resolves the result is stored in the
   * completed-result cache so subsequent reads return immediately.
   *
   * Lock-wait telemetry is emitted if the bd CLI lock wait exceeds
   * BEADS_LOCK_WAIT_WARN_MS.
   */
  async read(finalArgs: string[], options: BdInvokeOptions): Promise<BdResult> {
    const key = cacheKey(finalArgs, options.root);

    // 1. Completed-result cache hit.
    const cached = this.cache.get(key);
    if (cached) return cached;

    // 2. In-flight deduplication: reuse an ongoing request.
    const inflight = this.inFlight.get(key);
    if (inflight) return inflight;

    // 3. No cache entry and no in-flight request — start a new one.
    const promise = this.invoke(finalArgs, options).then(result => {
      this.putCache(key, result);
      return result;
    }).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * Execute a mutating bd command with mutation serialization.
   * Mutations are queued behind a promise chain so they execute one-at-a-time,
   * preventing concurrent writers from racing the bd filesystem lock.
   * After each mutation the read cache is fully invalidated.
   *
   * Lock-wait telemetry is emitted if the bd CLI lock wait exceeds
   * BEADS_LOCK_WAIT_WARN_MS.
   */
  async mutate(finalArgs: string[], options: BdInvokeOptions): Promise<BdResult> {
    const result = await this.enqueue(() => this.invoke(finalArgs, options));
    this.invalidate();
    return result;
  }

  /**
   * Explicitly invalidate the read cache.
   * Call this when an out-of-band mutation has occurred that the client
   * is not tracking (e.g. a direct exportJsonlAfterMutation call).
   * In-flight reads are NOT cancelled — they complete normally, but their
   * results are NOT stored to the cache (the inFlight entry is cleaned up
   * in the finally block of read()).
   */
  invalidate(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Append a unit of work to the mutation queue and return its promise. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // Chain the new work onto the tail. The tail promise never rejects outward
    // (we catch rejections so the chain stays alive), but we still surface
    // the error to the original caller.
    const next = this.mutationTail.then(() => fn());
    // Keep the chain alive even if this invocation throws.
    this.mutationTail = next.catch(() => {});
    return next;
  }

  /** Raw bd subprocess invocation — lock acquisition + execa. */
  private async invoke(finalArgs: string[], options: BdInvokeOptions): Promise<BdResult> {
    const { value: raw, lockWaitStartMs, lockAcquiredMs } = await withBdCliLock(async () => {
      return execa('bd', finalArgs, {
        input: options.input,
        maxBuffer: BeadsDefaults.MAX_BUFFER_BYTES,
        timeout: BeadsDefaults.CLI_TIMEOUT_MS
      });
    }, options.root);

    // Emit a lock-wait span so dashboards can track bd CLI contention.
    // Duration = time from wait-start to lock-acquired (excludes the bd execution itself).
    // The orr_else.bead_id / state_id attrs are added automatically by recordCompletedSpan
    // from env vars; 'bd.command' captures the first arg for grouping in dashboards.
    try {
      this.observability?.recordCompletedSpan(SpanName.BEADS_LOCK_WAIT, {
        'bd.command': finalArgs[0] ?? ''
      }, lockWaitStartMs, lockAcquiredMs);
    } catch {
      // Span emission is best-effort — never block the bd invocation.
    }

    return { stdout: raw.stdout, stderr: raw.stderr };
  }

  /** Bounded cache insertion — evict oldest entry when at capacity. */
  private putCache(key: string, result: BdResult): void {
    if (this.cache.size >= BEADS_CACHE_MAX_ENTRIES) {
      // Map.keys() iterator is insertion-order; delete the first (oldest) entry.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, result);
  }
}
