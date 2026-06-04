/**
 * Tests for JsonlEventLog append integrity under concurrency (13op).
 *
 * Multiple teammate worker processes append to the SAME shared events JSONL.
 * Records can exceed PIPE_BUF, so a bare appendFile can interleave/tear lines,
 * which ndjson.parse({strict:false}) then silently drops — losing events from
 * every projection. Appends must be serialized so every record survives intact.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonlEventLog } from '../src/core/JsonlEventLog.js';

describe('JsonlEventLog — concurrent append integrity', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-jsonl-')));
    filePath = path.join(dir, 'events.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves every record when many large records are appended concurrently', async () => {
    const log = new JsonlEventLog();
    const count = 60;
    // Each record is well over PIPE_BUF (4096 bytes) so a torn write would corrupt JSON.
    const big = 'x'.repeat(6000);
    const records = Array.from({ length: count }, (_, i) => ({ seq: i, payload: big }));

    // Fire all appends concurrently against the same file.
    await Promise.all(records.map(record => log.append(filePath, record)));

    const seen: number[] = [];
    await log.scan(filePath, (value: any) => { seen.push(value.seq); });

    // No torn/dropped lines: every record parses and every seq is present exactly once.
    expect(seen.length).toBe(count);
    expect(new Set(seen).size).toBe(count);
    expect([...seen].sort((a, b) => a - b)).toEqual(records.map(r => r.seq));
  });
});
