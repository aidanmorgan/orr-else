/**
 * pi-experiment-6q0y.27: harness_status latest-event fast path.
 *
 * Tests prove:
 * (a) Equivalence — EventStore.latestEvent() returns the same event as
 *     readAll().at(-1) for representative event sets.
 * (b) readAll() is NOT called by the fast path (stub it to throw; status still works).
 * (c) Boundedness — a 10,000-event fixture completes under 100ms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore } from '../src/core/EventStore.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Logger } from '../src/core/Logger.js';
import { DomainEventName } from '../src/constants/index.js';
import { writeFixtureEvent } from './support/TestEventStore.js';

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

  it('excludes synthetic events from the fast-path result (equivalence with readAll filter semantics)', async () => {
    // Write one real event, then one synthetic event after it.
    await writeFixtureEvent(tempRoot, DomainEventName.HARNESS_STARTED, {
      beadId: 'bd-synth-eq',
      maxSlots: 1
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    await writeFixtureEvent(tempRoot, DomainEventName.BEAD_CLAIMED, {
      beadId: 'bd-synth-eq',
      synthetic: true
    });

    // readAll() also filters synthetic events (read-layer filter).
    const allEvents = await eventStore.readAll();
    const fastPathResult = await eventStore.latestEvent();

    // readAll should NOT include the synthetic event.
    expect(allEvents.every(e => e.data?.synthetic !== true)).toBe(true);
    // Fast path should agree: its result must match readAll().at(-1).
    if (allEvents.length === 0) {
      expect(fastPathResult).toBeUndefined();
    } else {
      expect(fastPathResult).toBeDefined();
      expect(fastPathResult!.id).toBe(allEvents.at(-1)!.id);
    }
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
});
