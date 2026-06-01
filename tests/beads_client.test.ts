/**
 * Tests for BeadsClient:
 *  - Concurrent identical reads → bd invoked ONCE (cache hit).
 *  - Mutation between reads → cache invalidated (bd re-invoked).
 *  - Error from bd propagates (not swallowed).
 *  - Mutations serialize (two concurrent mutations don't interleave).
 *  - Lock-wait telemetry (BEADS_LOCK_WAIT_WARN_MS constant exists and is positive).
 *  - Cache bound (entries do not exceed BEADS_CACHE_MAX_ENTRIES).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { BeadsClient, BEADS_CACHE_MAX_ENTRIES, BEADS_LOCK_WAIT_WARN_MS } from '../src/plugins/BeadsClient.js';

// ---------------------------------------------------------------------------
// Mock execa and proper-lockfile so tests stay pure in-process.
// ---------------------------------------------------------------------------

vi.mock('execa', () => {
  return { execa: vi.fn() };
});

vi.mock('proper-lockfile', () => {
  return {
    default: {
      lock: vi.fn(async (_path: string) => {
        // Return a no-op release function.
        return async () => {};
      })
    }
  };
});

// Also mock the lock-file helpers so we don't touch the filesystem.
vi.mock('node:fs/promises', () => {
  return {
    mkdir: vi.fn(async () => {}),
    open: vi.fn(async () => ({ close: vi.fn(async () => {}) }))
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = '/fake/root';

function mkExecaResult(stdout: string, stderr = '') {
  return { stdout, stderr };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BeadsClient', () => {
  let client: BeadsClient;

  beforeEach(() => {
    client = new BeadsClient();
    vi.mocked(execa).mockReset();
  });

  // -------------------------------------------------------------------------
  // Named constants
  // -------------------------------------------------------------------------

  it('exports a positive BEADS_LOCK_WAIT_WARN_MS threshold constant', () => {
    expect(typeof BEADS_LOCK_WAIT_WARN_MS).toBe('number');
    expect(BEADS_LOCK_WAIT_WARN_MS).toBeGreaterThan(0);
  });

  it('exports a positive BEADS_CACHE_MAX_ENTRIES constant', () => {
    expect(typeof BEADS_CACHE_MAX_ENTRIES).toBe('number');
    expect(BEADS_CACHE_MAX_ENTRIES).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Concurrent reads → cache hit (bd invoked ONCE)
  // -------------------------------------------------------------------------

  it('returns a cached result for concurrent identical reads (bd invoked once)', async () => {
    vi.mocked(execa).mockResolvedValue(mkExecaResult('{"id":"bd-1"}') as any);

    const args = ['-C', ROOT, 'show', 'bd-1', '--json'];
    const [r1, r2] = await Promise.all([
      client.read(args, { root: ROOT }),
      client.read(args, { root: ROOT })
    ]);

    expect(r1.stdout).toBe('{"id":"bd-1"}');
    expect(r2.stdout).toBe('{"id":"bd-1"}');
    // bd should have been called exactly once (second read was a cache hit).
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
  });

  it('does NOT share cache between different args', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce(mkExecaResult('{"id":"bd-1"}') as any)
      .mockResolvedValueOnce(mkExecaResult('{"id":"bd-2"}') as any);

    const r1 = await client.read(['-C', ROOT, 'show', 'bd-1', '--json'], { root: ROOT });
    const r2 = await client.read(['-C', ROOT, 'show', 'bd-2', '--json'], { root: ROOT });

    expect(r1.stdout).toBe('{"id":"bd-1"}');
    expect(r2.stdout).toBe('{"id":"bd-2"}');
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Mutation invalidates cache (bd re-invoked on next read)
  // -------------------------------------------------------------------------

  it('invalidates the read cache after a mutation', async () => {
    const readArgs = ['-C', ROOT, 'show', 'bd-1', '--json'];
    const mutateArgs = ['-C', ROOT, 'update', 'bd-1', '--claim', '--json'];

    vi.mocked(execa)
      .mockResolvedValueOnce(mkExecaResult('{"status":"open"}') as any)   // first read
      .mockResolvedValueOnce(mkExecaResult('{"status":"in_progress"}') as any) // mutation
      .mockResolvedValueOnce(mkExecaResult('{"status":"in_progress"}') as any); // second read (cache miss)

    const r1 = await client.read(readArgs, { root: ROOT });
    expect(r1.stdout).toBe('{"status":"open"}');

    // Mutate — should invalidate cache.
    await client.mutate(mutateArgs, { root: ROOT });

    // Next read must hit bd again (cache cleared).
    const r2 = await client.read(readArgs, { root: ROOT });
    expect(r2.stdout).toBe('{"status":"in_progress"}');

    // Three bd calls total: first read + mutate + second read.
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(3);
  });

  it('explicit invalidate() clears the cache', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce(mkExecaResult('before') as any)
      .mockResolvedValueOnce(mkExecaResult('after') as any);

    const args = ['-C', ROOT, 'list', '--json'];
    const r1 = await client.read(args, { root: ROOT });
    expect(r1.stdout).toBe('before');

    client.invalidate();

    const r2 = await client.read(args, { root: ROOT });
    expect(r2.stdout).toBe('after');

    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  it('propagates errors from read() without swallowing them', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('bd read failed'));

    await expect(client.read(['-C', ROOT, 'show', 'bd-missing', '--json'], { root: ROOT }))
      .rejects.toThrow('bd read failed');
  });

  it('propagates errors from mutate() without swallowing them', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('bd mutate failed'));

    await expect(client.mutate(['-C', ROOT, 'update', 'bd-1', '--claim', '--json'], { root: ROOT }))
      .rejects.toThrow('bd mutate failed');
  });

  it('keeps the mutation queue alive after a failed mutation', async () => {
    vi.mocked(execa)
      .mockRejectedValueOnce(new Error('first mutation failed'))
      .mockResolvedValueOnce(mkExecaResult('second ok') as any);

    const mutateArgs = ['-C', ROOT, 'update', 'bd-1', '--claim', '--json'];

    // First mutation fails.
    await expect(client.mutate(mutateArgs, { root: ROOT })).rejects.toThrow('first mutation failed');

    // Second mutation must still execute (queue stays alive).
    const r2 = await client.mutate(mutateArgs, { root: ROOT });
    expect(r2.stdout).toBe('second ok');

    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Mutation serialization (two concurrent mutations don't interleave)
  // -------------------------------------------------------------------------

  it('serializes concurrent mutations (they execute one at a time)', async () => {
    let activeCount = 0;
    let maxActiveCount = 0;

    const slowMutation = vi.fn(async (_bin: string, _args: string[], _opts?: any) => {
      activeCount++;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await new Promise(resolve => setTimeout(resolve, 20));
      activeCount--;
      return mkExecaResult('ok');
    });

    vi.mocked(execa)
      .mockImplementationOnce(slowMutation as any)
      .mockImplementationOnce(slowMutation as any);

    const mutateArgs = ['-C', ROOT, 'update', 'bd-1', '--claim', '--json'];

    await Promise.all([
      client.mutate(mutateArgs, { root: ROOT }),
      client.mutate(mutateArgs, { root: ROOT })
    ]);

    // If mutations ran concurrently maxActiveCount would be 2.
    expect(maxActiveCount).toBe(1);
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Bounded cache (does not exceed BEADS_CACHE_MAX_ENTRIES)
  // -------------------------------------------------------------------------

  it('evicts the oldest cache entry when the cache is full', async () => {
    // Fill the cache to the cap, then add one more entry.
    const totalCalls = BEADS_CACHE_MAX_ENTRIES + 1;
    for (let i = 0; i < totalCalls; i++) {
      vi.mocked(execa).mockResolvedValueOnce(mkExecaResult(`entry-${i}`) as any);
    }

    // Make BEADS_CACHE_MAX_ENTRIES + 1 distinct reads (each unique by args).
    for (let i = 0; i < totalCalls; i++) {
      await client.read(['-C', ROOT, 'show', `bd-${i}`, '--json'], { root: ROOT });
    }

    // Now re-read entry-0 — it should have been evicted (cache miss → new bd call).
    vi.mocked(execa).mockResolvedValueOnce(mkExecaResult('entry-0-fresh') as any);
    const r = await client.read(['-C', ROOT, 'show', 'bd-0', '--json'], { root: ROOT });
    expect(r.stdout).toBe('entry-0-fresh');

    // Total execa calls: totalCalls fills + 1 re-read of evicted entry.
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(totalCalls + 1);
  });

  // -------------------------------------------------------------------------
  // Read-after-mutation ordering (mutation completes before subsequent read)
  // -------------------------------------------------------------------------

  it('a read immediately after a mutation sees the post-mutation state', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce(mkExecaResult('before') as any)    // first read
      .mockResolvedValueOnce(mkExecaResult('mutated') as any)   // mutation
      .mockResolvedValueOnce(mkExecaResult('after') as any);    // read after mutation

    const readArgs = ['-C', ROOT, 'show', 'bd-1', '--json'];

    const r1 = await client.read(readArgs, { root: ROOT });
    expect(r1.stdout).toBe('before');

    await client.mutate(['-C', ROOT, 'update', 'bd-1', '--claim', '--json'], { root: ROOT });

    const r2 = await client.read(readArgs, { root: ROOT });
    expect(r2.stdout).toBe('after');

    // 3 bd calls (read + mutate + read after invalidation).
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // FIX-1 regression: two reads separated by an explicit invalidate() must
  // both invoke bd (proving per-tick freshness when coordinator calls
  // beadsPort.invalidateCache() at tick-start).
  // -------------------------------------------------------------------------

  it('(FIX-1) two reads across an explicit invalidate() each invoke bd (no stale cache across ticks)', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce(mkExecaResult('tick-1') as any)  // first read (tick 1)
      .mockResolvedValueOnce(mkExecaResult('tick-2') as any); // second read (tick 2, after invalidate)

    const args = ['-C', ROOT, 'list', '--json'];

    // Tick 1: read populates the cache.
    const r1 = await client.read(args, { root: ROOT });
    expect(r1.stdout).toBe('tick-1');

    // Intra-tick: same read returns cached result — bd NOT called again.
    const r1b = await client.read(args, { root: ROOT });
    expect(r1b.stdout).toBe('tick-1');
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);

    // Tick boundary: coordinator calls invalidate() (simulating step() start).
    client.invalidate();

    // Tick 2: cache was invalidated — bd MUST be called again (no stale hit).
    const r2 = await client.read(args, { root: ROOT });
    expect(r2.stdout).toBe('tick-2');
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
  });
});
