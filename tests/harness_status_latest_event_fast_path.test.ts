/**
 * pi-experiment-6q0y.27: harness_status latest-event fast path.
 *
 * Tests prove:
 * (a) Equivalence — EventStore.latestEvent() returns the same event as
 *     readAll().at(-1) for representative event sets.
 * (b) readAll() is NOT called by the fast path (stub it to throw; status still works).
 * (c) Boundedness — a 10,000-event fixture completes under 100ms.
 *
 * pi-experiment-rm9x: scanTail bounded byte-offset read + large-event handling.
 * (d) An event whose serialized JSON exceeds the default tail window is still
 *     returned correctly by latestEvent() (grow-window path).
 * (e) Normal small events are scanned correctly after the bounded-read change.
 * (f) A partial line at the window boundary is not mis-parsed: the trim is shown
 *     to be load-bearing (a valid-JSON suffix fragment is excluded from the visitor).
 * (g) The read is bounded: a large log where only the tail matters completes
 *     under 200ms and returns the correct tail event (not a stale earlier one).
 * (h) Regression: a single event line exceeding 32× tailBytes is returned without
 *     hanging (grow-loop termination guarantee).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore } from '../src/core/EventStore.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Logger } from '../src/core/Logger.js';
import { DomainEventName } from '../src/constants/domain.js';
import { writeFixtureEvent } from './support/TestEventStore.js';
import { JsonlEventLog } from '../src/core/JsonlEventLog.js';

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const MINIMAL_HARNESS_YAML = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`;

function setupTempRoot(): { tempRoot: string; configLoader: ConfigLoader; eventStore: EventStore } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-6q0y27-'));
  fs.mkdirSync(path.join(tempRoot, '.pi/events'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, '.pi/logs'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), MINIMAL_HARNESS_YAML);
  const configLoader = new ConfigLoader(undefined, tempRoot);
  const eventStore = new EventStore(configLoader, undefined, undefined, tempRoot);
  eventStore.setSessionId(`test-${process.pid}`);
  return { tempRoot, configLoader, eventStore };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('EventStore.latestEvent() fast path', () => {
  let tempRoot: string;
  let configLoader: ConfigLoader;
  let eventStore: EventStore;

  beforeEach(() => {
    ({ tempRoot, configLoader, eventStore } = setupTempRoot());
  });

  afterEach(async () => {
    configLoader.reset();
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // (a) Equivalence tests
  // -------------------------------------------------------------------------

  it('returns undefined when no events have been written', async () => {
    const latest = await eventStore.latestEvent();
    expect(latest).toBeUndefined();
  });

  it('returns the single event when only one event exists (equivalence with readAll)', async () => {
    await writeFixtureEvent(tempRoot, DomainEventName.HARNESS_STARTED, {
      beadId: 'bd-equiv-1',
      maxSlots: 1
    });

    const allEvents = await eventStore.readAll();
    const fastPathResult = await eventStore.latestEvent();

    expect(allEvents).toHaveLength(1);
    expect(fastPathResult).toBeDefined();
    expect(fastPathResult!.type).toBe(allEvents.at(-1)!.type);
    expect(fastPathResult!.timestamp).toBe(allEvents.at(-1)!.timestamp);
    expect(fastPathResult!.id).toBe(allEvents.at(-1)!.id);
  });

  it('returns the same event as readAll().at(-1) across a sequence of events (equivalence)', async () => {
    // Write several events with distinct timestamps.
    const types = [
      DomainEventName.HARNESS_STARTED,
      DomainEventName.BEAD_CLAIMED,
      DomainEventName.STATE_RUN_INITIALIZED,
    ];
    for (const type of types) {
      // Space out timestamps so ordering is deterministic.
      await new Promise(resolve => setTimeout(resolve, 5));
      await writeFixtureEvent(tempRoot, type, { beadId: 'bd-equiv-seq' });
    }

    const allEvents = await eventStore.readAll();
    const fastPathResult = await eventStore.latestEvent();

    expect(allEvents.length).toBeGreaterThan(0);
    const expected = allEvents.at(-1)!;
    expect(fastPathResult).toBeDefined();
    expect(fastPathResult!.id).toBe(expected.id);
    expect(fastPathResult!.type).toBe(expected.type);
    expect(fastPathResult!.timestamp).toBe(expected.timestamp);
  });

  it('fails closed (throws EventStoreSyntheticReadError) when a synthetic event is on disk (pi-experiment-jxdk)', async () => {
    // pi-experiment-jxdk: production reads no longer silently drop synthetic
    // records — they throw EventStoreSyntheticReadError (fail-closed).
    // A synthetic record on disk indicates store corruption or a pre-824i record.
    const { EventStoreSyntheticReadError } = await import('../src/core/EventStore.js');

    await writeFixtureEvent(tempRoot, DomainEventName.BEAD_CLAIMED, {
      beadId: 'bd-synth-eq',
      synthetic: true
    });

    // Both readAll() and latestEvent() fail closed.
    await expect(eventStore.readAll()).rejects.toBeInstanceOf(EventStoreSyntheticReadError);
    await expect(eventStore.latestEvent()).rejects.toBeInstanceOf(EventStoreSyntheticReadError);
  });

  // -------------------------------------------------------------------------
  // (b) readAll() is NOT called — stub it to throw
  // -------------------------------------------------------------------------

  it('obtains latest-event without calling readAll() (AC3: stub readAll to throw)', async () => {
    await writeFixtureEvent(tempRoot, DomainEventName.HARNESS_STARTED, {
      beadId: 'bd-no-readall',
      maxSlots: 1
    });

    // Stub readAll to throw — if the fast path accidentally calls it, the test fails.
    const readAllSpy = vi.spyOn(eventStore, 'readAll').mockRejectedValue(
      new Error('readAll must NOT be called by the fast path')
    );

    const result = await eventStore.latestEvent();

    expect(result).toBeDefined();
    expect(result!.type).toBe(DomainEventName.HARNESS_STARTED);
    expect(readAllSpy).not.toHaveBeenCalled();

    readAllSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // (c) Boundedness — 10,000-event fixture under 100ms
  // -------------------------------------------------------------------------

  it('completes latest-event lookup under 100ms for a 10,000-event fixture (AC4)', async () => {
    // Write 10,000 fixture events directly onto disk.
    const eventsDir = path.join(tempRoot, '.pi/events');
    const fileName = `${path.basename(tempRoot)}.jsonl`;
    const filePath = path.join(eventsDir, fileName);

    // Pre-generate all lines for bulk write.
    const baseTime = new Date('2026-01-01T00:00:00.000Z').getTime();
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const entry = {
        id: `event-fixture-${String(i).padStart(6, '0')}`,
        type: i === 9999 ? DomainEventName.STATE_RUN_INITIALIZED : DomainEventName.HARNESS_STARTED,
        timestamp: new Date(baseTime + i).toISOString(),
        sessionId: 'test-fixture',
        data: { beadId: `bd-bulk`, index: i }
      };
      lines.push(JSON.stringify(entry));
    }
    fs.appendFileSync(filePath, lines.join('\n') + '\n', 'utf8');

    // Verify setup: readAll sees 10,000 events (baseline for correctness).
    const allEvents = await eventStore.readAll();
    expect(allEvents).toHaveLength(10_000);
    const expectedLatest = allEvents.at(-1)!;

    // Now time the fast-path lookup.
    const t0 = performance.now();
    const fastResult = await eventStore.latestEvent();
    const elapsed = performance.now() - t0;

    // Under 100ms.
    expect(elapsed).toBeLessThan(100);

    // Equivalence: returns the same event.
    expect(fastResult).toBeDefined();
    expect(fastResult!.id).toBe(expectedLatest.id);
    expect(fastResult!.type).toBe(expectedLatest.type);
    expect(fastResult!.timestamp).toBe(expectedLatest.timestamp);
  });

  // -------------------------------------------------------------------------
  // (d–g) pi-experiment-rm9x: scanTail bounded byte-offset + large-event tests
  // -------------------------------------------------------------------------

  it('(rm9x-d) returns a correct event whose serialized JSON line exceeds the tail window', async () => {
    // Write a small "old" event followed by a large event whose JSON exceeds
    // the default 64 KiB tail window.  latestEvent() must still return the large
    // event via the grow-window path rather than missing it.
    const eventsDir = path.join(tempRoot, '.pi/events');
    const fileName = `${path.basename(tempRoot)}.jsonl`;
    const filePath = path.join(eventsDir, fileName);

    const baseTime = new Date('2026-01-01T00:00:00.000Z').getTime();

    // Small "old" event that fits easily in any tail window.
    const smallEvent = {
      id: 'rm9x-small-event',
      type: DomainEventName.HARNESS_STARTED,
      timestamp: new Date(baseTime).toISOString(),
      sessionId: 'test-fixture',
      data: { beadId: 'bd-rm9x', maxSlots: 1 }
    };

    // Large "latest" event whose JSON exceeds 65,536 bytes.
    // We embed a payload field of ~80,000 bytes so the serialized line is > 64 KiB.
    const largeEvent = {
      id: 'rm9x-large-event',
      type: DomainEventName.BEAD_CLAIMED,
      timestamp: new Date(baseTime + 1000).toISOString(),
      sessionId: 'test-fixture',
      data: { beadId: 'bd-rm9x', payload: 'L'.repeat(80_000) }
    };

    fs.appendFileSync(filePath, JSON.stringify(smallEvent) + '\n', 'utf8');
    fs.appendFileSync(filePath, JSON.stringify(largeEvent) + '\n', 'utf8');

    // The file must be larger than the default tail window for this test to be meaningful.
    const stat = fs.statSync(filePath);
    expect(stat.size).toBeGreaterThan(65_536);

    // latestEvent() must find the large event despite it exceeding the tail window.
    const latest = await eventStore.latestEvent();
    expect(latest).toBeDefined();
    expect(latest!.id).toBe('rm9x-large-event');
    expect(latest!.type).toBe(DomainEventName.BEAD_CLAIMED);
  });

  it('(rm9x-e) small events are still scanned correctly after the bounded-read change', async () => {
    // Regression: bounded-read path must behave identically to the old path for
    // normal-size events (the common case).
    await writeFixtureEvent(tempRoot, DomainEventName.HARNESS_STARTED, {
      beadId: 'bd-rm9x-small-a',
      maxSlots: 1
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    await writeFixtureEvent(tempRoot, DomainEventName.BEAD_CLAIMED, {
      beadId: 'bd-rm9x-small-b'
    });

    const allEvents = await eventStore.readAll();
    const expected = allEvents.at(-1)!;

    const latest = await eventStore.latestEvent();
    expect(latest).toBeDefined();
    expect(latest!.id).toBe(expected.id);
    expect(latest!.type).toBe(expected.type);
    expect(latest!.timestamp).toBe(expected.timestamp);
  });

  it('(rm9x-f) the partial-line trim at the window boundary is load-bearing: a valid-JSON fragment that appears at the start of the read window is excluded from the visitor', async () => {
    // The trim (slice to first newline when start > 0) is load-bearing for
    // scanTail callers that collect ALL records — not just the last.  Without the
    // trim, a partial tail of a previous line that happens to be valid JSON would
    // be emitted to the visitor as a spurious record.
    //
    // Construction:
    //   line1 = "42\n"  (3 bytes: '4', '2', '\n')
    //   line2 = a full valid JSON event  (N2 bytes)
    //   tailBytes = N2 + 2
    //
    // => start = fileSize - tailBytes = 3 + N2 - (N2 + 2) = 1
    // => tailText starts at byte 1, which is '2' — the suffix of "42" on line1.
    //    '2' is valid JSON (the number 2).
    //
    // WITH trim:    firstNewline is at index 1 → cleanText = line2 → 1 visitor call.
    // WITHOUT trim: '2' parses as JSON number 2 → visitor called with 2 then with
    //               the real event → 2 visitor calls (spurious first record).
    //
    // The trim is defensive for latestEvent() (the spurious record comes before the
    // real one so it gets overwritten), but IS load-bearing when every visited record
    // matters — e.g. any scanTail caller that collects or counts all records.

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm9x-f-'));
    try {
      const filePath = path.join(tmpDir, 'test.jsonl');

      // line1: "42\n" — 3 bytes.  Byte 0 = '4', byte 1 = '2', byte 2 = '\n'.
      fs.writeFileSync(filePath, '42\n', 'utf8');

      // line2: a well-formed JSON object that is a valid harness-style event.
      const line2Content = JSON.stringify({
        id: 'rm9x-f-real',
        type: 'BEAD_CLAIMED',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 's',
        data: { beadId: 'bd-f' }
      });
      const line2Bytes = Buffer.byteLength(line2Content + '\n', 'utf8');
      fs.appendFileSync(filePath, line2Content + '\n', 'utf8');

      // tailBytes chosen so start = 1 (byte '2', a valid-JSON suffix of line1).
      const tailBytes = line2Bytes + 2;

      const log = new JsonlEventLog();
      const collected: unknown[] = [];
      await log.scanTail(filePath, tailBytes, v => collected.push(v));

      // With the trim in place: only the real event is collected.
      // Without the trim: '2' (valid JSON) would also be collected as a spurious
      // first record, giving collected.length === 2.
      expect(collected).toHaveLength(1);
      expect((collected[0] as Record<string, unknown>)['id']).toBe('rm9x-f-real');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('(rm9x-h) a single event line exceeding maxWindow (32× tailBytes) is returned correctly and without hanging', async () => {
    // Regression for the infinite-loop defect: with the old code, window was
    // capped at maxWindow = tailBytes * 32.  When fileSize > maxWindow, start
    // never reached 0 and the loop ran forever (71,578+ iterations observed).
    //
    // Fix: window = Math.min(window * 2, fileSize) — clamps to fileSize so the
    // next iteration always has start === 0 and the break fires unconditionally.
    //
    // This test uses tailBytes=1024 and a ~100 KiB single-event line, so:
    //   maxWindow (old) = 1024 * 32 = 32,768 bytes < 100,000 bytes = fileSize.
    //   With the fix: window doubles until clamped to fileSize; start reaches 0;
    //   loop terminates in ≤ 17 iterations.

    const eventsDir = path.join(tempRoot, '.pi/events');
    const fileName = `${path.basename(tempRoot)}.jsonl`;
    const filePath = path.join(eventsDir, fileName);

    // Write a single oversized event whose JSON line is ~100 KiB — well above
    // 32 × 1024 = 32,768 bytes.
    const oversizedEvent = {
      id: 'rm9x-oversized',
      type: DomainEventName.BEAD_CLAIMED,
      timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      sessionId: 'test-fixture',
      data: { beadId: 'bd-oversized', payload: 'O'.repeat(100_000) }
    };
    fs.appendFileSync(filePath, JSON.stringify(oversizedEvent) + '\n', 'utf8');

    // Sanity: the line really does exceed 32 × 1024 bytes.
    const stat = fs.statSync(filePath);
    expect(stat.size).toBeGreaterThan(32_768);

    // Use a small tailBytes (1024) to trigger the grow-window path.
    // With the old cap-without-clamp bug this would hang; with the fix it must
    // complete quickly (well under 2 seconds).
    const log = new JsonlEventLog();
    const collected: unknown[] = [];

    const start = performance.now();
    await log.scanTail(filePath, 1024, v => collected.push(v));
    const elapsed = performance.now() - start;

    // Must not hang: complete within 2 seconds.
    expect(elapsed).toBeLessThan(2000);

    // Must return the oversized event correctly.
    expect(collected).toHaveLength(1);
    expect((collected[0] as Record<string, unknown>)['id']).toBe('rm9x-oversized');
  }, 5000 /* hard vitest timeout: fail fast rather than hang the full suite */);

  it('(rm9x-g) bounded read: completes quickly for a large log and returns the correct tail event', async () => {
    // Write a large log (> 1 MiB of padding events) followed by a single final
    // event in the tail.  The bounded read must complete well under 500ms and
    // return the final tail event without reading the entire file.
    const eventsDir = path.join(tempRoot, '.pi/events');
    const fileName = `${path.basename(tempRoot)}.jsonl`;
    const filePath = path.join(eventsDir, fileName);

    const baseTime = new Date('2026-01-01T00:00:00.000Z').getTime();

    // ~1 MiB of padding (5,000 × ~200-byte lines ≈ 1 MB).
    const paddingLines: string[] = [];
    for (let i = 0; i < 5_000; i++) {
      paddingLines.push(JSON.stringify({
        id: `rm9x-bulk-${String(i).padStart(5, '0')}`,
        type: DomainEventName.HARNESS_STARTED,
        timestamp: new Date(baseTime + i).toISOString(),
        sessionId: 'test-fixture',
        data: { beadId: 'bd-bulk-g', index: i, pad: 'X'.repeat(120) }
      }));
    }
    fs.appendFileSync(filePath, paddingLines.join('\n') + '\n', 'utf8');

    // Append the distinguished tail event.
    const tailEvent = {
      id: 'rm9x-tail-event',
      type: DomainEventName.BEAD_CLAIMED,
      timestamp: new Date(baseTime + 9_999_999).toISOString(),
      sessionId: 'test-fixture',
      data: { beadId: 'bd-bulk-g' }
    };
    fs.appendFileSync(filePath, JSON.stringify(tailEvent) + '\n', 'utf8');

    const stat = fs.statSync(filePath);
    // Must be a genuinely large file (>> 64 KiB) to validate the bounded-read path.
    expect(stat.size).toBeGreaterThan(500_000);

    const t0 = performance.now();
    const latest = await eventStore.latestEvent();
    const elapsed = performance.now() - t0;

    // Bounded read: must complete well under 500ms (the tail is small; we don't
    // read the full file).
    expect(elapsed).toBeLessThan(500);

    // Correctness: the tail event is returned.
    expect(latest).toBeDefined();
    expect(latest!.id).toBe('rm9x-tail-event');
    expect(latest!.type).toBe(DomainEventName.BEAD_CLAIMED);
  });
});
