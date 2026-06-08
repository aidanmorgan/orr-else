/**
 * pi-experiment-jxdk: production read paths FAIL CLOSED on synthetic records.
 *
 * Inverted from y2ax (which proved silent read-layer filtering).  Per the
 * owner's no-backcompat directive the silent filter is removed.  This file now
 * proves the new fail-closed behaviour:
 *
 *   (a) Production EventStore read throws EventStoreSyntheticReadError when a
 *       synthetic record is present on disk — it does NOT silently drop it.
 *
 *   (b) No production gate/projection makes progress by ignoring a synthetic
 *       record — the read itself fails before the caller can act.
 *
 *   (c) Real production event logs contain no synthetic records (824i rejects
 *       synthetic writes), so for non-synthetic data the read path is a no-op.
 *
 * Note: y2ax reversal.  The isSyntheticEvent read-layer filter is removed.
 * EventStore.rejectSyntheticReadIfPresent() now throws instead of skipping.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore, EventStoreSyntheticReadError } from '../src/core/EventStore.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Logger } from '../src/core/Logger.js';
import { DomainEventName, TeammateEventType } from '../src/constants/index.js';
import { writeFixtureEvent } from './support/TestEventStore.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function setupTempRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-jxdk-synth-'));
  fs.mkdirSync(path.join(tempRoot, '.pi/events'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, '.pi/logs'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
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
`);
  return tempRoot;
}

function makeStore(tempRoot: string): EventStore {
  const store = new EventStore(new ConfigLoader(undefined, tempRoot), undefined, undefined, tempRoot);
  store.setSessionId('jxdk-synth-test');
  return store;
}

// ---------------------------------------------------------------------------
// (a) Fail-closed: production read THROWS on a synthetic record on disk.
//
// A synthetic record injected via writeFixtureEvent() (raw JSONL — simulating
// a pre-824i legacy record or store corruption) must cause the production read
// to throw EventStoreSyntheticReadError, NOT silently disappear.
// ---------------------------------------------------------------------------

describe('(a) Fail-closed: production read throws on a synthetic record', () => {
  let tempRoot: string;
  let store: EventStore;

  beforeEach(() => {
    tempRoot = setupTempRoot();
    store = makeStore(tempRoot);
  });

  afterEach(async () => {
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('eventsForBead THROWS EventStoreSyntheticReadError when a synthetic record is on disk', async () => {
    const beadId = 'bd-fail-closed';

    // Inject a synthetic record via raw JSONL (simulating a pre-824i or
    // corrupted store record — production write would reject this).
    await writeFixtureEvent(tempRoot, DomainEventName.STATE_RUN_INITIALIZED, {
      beadId,
      stateId: 'Planning',
      actionId: 'sentinel',
      synthetic: true
    });

    // Production read must fail closed — NOT silently drop the record.
    await expect(store.eventsForBead(beadId)).rejects.toBeInstanceOf(EventStoreSyntheticReadError);
  });

  it('readAll THROWS EventStoreSyntheticReadError when a synthetic record is on disk', async () => {
    await writeFixtureEvent(tempRoot, DomainEventName.STATE_RUN_INITIALIZED, {
      beadId: 'bd-readall',
      stateId: 'Planning',
      actionId: 'sentinel',
      synthetic: true
    });

    await expect(store.readAll()).rejects.toBeInstanceOf(EventStoreSyntheticReadError);
  });

  it('latestEvent THROWS EventStoreSyntheticReadError when a synthetic record is on disk', async () => {
    await writeFixtureEvent(tempRoot, DomainEventName.HARNESS_STARTED, {
      beadId: 'bd-latest',
      synthetic: true
    });

    await expect(store.latestEvent()).rejects.toBeInstanceOf(EventStoreSyntheticReadError);
  });

  it('EventStoreSyntheticReadError carries the event type and deterministic message', async () => {
    const beadId = 'bd-err-shape';

    await writeFixtureEvent(tempRoot, DomainEventName.BEAD_CLAIMED, {
      beadId,
      synthetic: true
    });

    let caught: unknown;
    try {
      await store.eventsForBead(beadId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EventStoreSyntheticReadError);
    const err = caught as EventStoreSyntheticReadError;
    expect(err.eventType).toBe(DomainEventName.BEAD_CLAIMED);
    expect(err.message).toMatch(/synthetic/i);
    expect(err.message).toMatch(/production EventStore encountered/i);
    // Deterministic: no live timestamp in the message.
    expect(err.message).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('synthetic record on disk IS present (raw read confirms) — fail-closed is not a silent drop', async () => {
    const beadId = 'bd-disk-confirm';

    await writeFixtureEvent(tempRoot, DomainEventName.STATE_RUN_INITIALIZED, {
      beadId,
      stateId: 'Planning',
      actionId: 'sentinel',
      synthetic: true
    });

    // Raw JSONL confirms the record is present on disk.
    const eventsPath = path.join(tempRoot, '.pi/events', `${path.basename(tempRoot)}.jsonl`);
    const rawEvents = fs.readFileSync(eventsPath, 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));

    expect(rawEvents).toHaveLength(1);
    expect(rawEvents[0].type).toBe(DomainEventName.STATE_RUN_INITIALIZED);
    expect(rawEvents[0].data.synthetic).toBe(true);

    // Production read fails closed — does NOT silently drop the record.
    await expect(store.eventsForBead(beadId)).rejects.toBeInstanceOf(EventStoreSyntheticReadError);
  });
});

// ---------------------------------------------------------------------------
// (b) No production gate/projection progresses via a synthetic record.
//
// latestProjectToolFailureLimitEvent reads via eventsForBead, so it also fails
// closed when a synthetic record is on disk.  The circuit-breaker cannot
// advance (or be incorrectly reset) by a synthetic record.
// ---------------------------------------------------------------------------

describe('(b) No production gate progresses via a synthetic record (fail-closed propagates)', () => {
  let tempRoot: string;
  let store: EventStore;

  beforeEach(() => {
    tempRoot = setupTempRoot();
    store = makeStore(tempRoot);
  });

  afterEach(async () => {
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('latestProjectToolFailureLimitEvent THROWS when a synthetic record is on disk (gate cannot progress)', async () => {
    const beadId = 'bd-circuit-fail-closed';
    const stateId = 'Planning';
    const actionId = 'formulate-plan';

    // Real PROJECT_TOOL_FAILED.
    await store.record(DomainEventName.PROJECT_TOOL_FAILED, {
      beadId,
      stateId,
      actionId,
      tool: 'verifier',
      result: {
        status: 'FAILURE',
        failureLimit: { terminal: true, maxFailures: 3, failureCount: 3 }
      }
    });

    // Inject a synthetic record — simulates pre-824i or corrupted store.
    await writeFixtureEvent(tempRoot, DomainEventName.STATE_RUN_INITIALIZED, {
      beadId,
      stateId,
      actionId,
      synthetic: true
    });

    // The circuit-breaker must not silently advance — read fails closed.
    await expect(
      store.latestProjectToolFailureLimitEvent(beadId, { stateId, actionId })
    ).rejects.toBeInstanceOf(EventStoreSyntheticReadError);
  });

  it('a REAL STATE_RUN_INITIALIZED still resets the circuit-breaker window (control — no synthetic on disk)', async () => {
    const beadId = 'bd-circuit-control';
    const stateId = 'Planning';
    const actionId = 'formulate-plan';

    // Real failure event.
    await store.record(DomainEventName.PROJECT_TOOL_FAILED, {
      beadId,
      stateId,
      actionId,
      tool: 'verifier',
      result: {
        status: 'FAILURE',
        failureLimit: { terminal: true, maxFailures: 3, failureCount: 3 }
      }
    });

    // Acknowledge terminal outcome.
    await store.record(DomainEventName.SIGNAL_ACKNOWLEDGED, {
      beadId,
      stateId,
      actionId,
      type: TeammateEventType.STATE_TRANSITIONED
    });

    // REAL STATE_RUN_INITIALIZED — legitimate run-start boundary.
    await store.record(DomainEventName.STATE_RUN_INITIALIZED, {
      beadId,
      stateId,
      actionId,
      actionKey: 'workflow=v1/state=Planning/action=formulate-plan'
    });

    // After a real init following an acknowledgement, the window is reset.
    const result = await store.latestProjectToolFailureLimitEvent(beadId, { stateId, actionId });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (c) Non-synthetic data is unaffected — no regression for real production reads.
//
// Since 824i rejects synthetic writes, real production event logs contain no
// synthetic records.  Removing the read-layer filter is a no-op for real data.
// ---------------------------------------------------------------------------

describe('(c) Non-synthetic data reads correctly — fail-closed is a no-op for clean stores', () => {
  let tempRoot: string;
  let store: EventStore;

  beforeEach(() => {
    tempRoot = setupTempRoot();
    store = makeStore(tempRoot);
  });

  afterEach(async () => {
    Logger.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('eventsForBead returns real events unaffected when no synthetic record is on disk', async () => {
    const beadId = 'bd-clean';

    await store.record(DomainEventName.STATE_RUN_INITIALIZED, {
      beadId,
      stateId: 'Planning',
      actionId: 'formulate-plan'
    });

    const events = await store.eventsForBead(beadId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(DomainEventName.STATE_RUN_INITIALIZED);
    expect(events[0].data?.synthetic).toBeUndefined();
  });

  it('readAll returns all real events when no synthetic record is on disk', async () => {
    await store.record(DomainEventName.STATE_RUN_INITIALIZED, {
      beadId: 'bd-ra-1',
      stateId: 'Planning',
      actionId: 'formulate-plan'
    });
    await store.record(DomainEventName.PROJECT_TOOL_FAILED, {
      beadId: 'bd-ra-1',
      stateId: 'Planning',
      actionId: 'formulate-plan',
      tool: 'verifier',
      result: { status: 'FAILURE' }
    });

    const events = await store.readAll();
    expect(events).toHaveLength(2);
    expect(events.every(e => e.data?.synthetic !== true)).toBe(true);
  });
});
