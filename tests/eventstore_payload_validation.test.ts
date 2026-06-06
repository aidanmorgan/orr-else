/**
 * pi-experiment-y2ax: payload validation for production event writes.
 *
 * AC1: BEAD_CLAIMED without beadId+lease/status is REJECTED before writing.
 * AC2: STATE_RUN_INITIALIZED without beadId+stateId+actionId is REJECTED.
 * AC3: Production write path REJECTS synthetic:true; fixture writes use
 *      TestEventStore (raw JSONL injection) — isolated from the production store.
 * AC4: Malformed production writes are rejected with a structured diagnostic.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore, EventStoreSyntheticRejectedError } from '../src/core/EventStore.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Logger } from '../src/core/Logger.js';
import { DomainEventName } from '../src/constants/index.js';
import { writeFixtureEvent } from './support/TestEventStore.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStore(tempRoot: string): EventStore {
  const store = new EventStore(new ConfigLoader(undefined, tempRoot), undefined, undefined, tempRoot);
  store.setSessionId('y2ax-test');
  return store;
}

function setupTempRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-y2ax-'));
  fs.mkdirSync(path.join(tempRoot, '.pi/events'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, '.pi/logs'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
  worktreePolicy:
    default: always
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
  return tempRoot;
}

// ---------------------------------------------------------------------------
// AC1: BEAD_CLAIMED without beadId + lease/status is rejected
// ---------------------------------------------------------------------------

describe('AC1 – BEAD_CLAIMED production payload validation', () => {
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

  it('rejects BEAD_CLAIMED with no fields at all (empty data)', async () => {
    await expect(
      store.record(DomainEventName.BEAD_CLAIMED, {})
    ).rejects.toThrow(/BEAD_CLAIMED.*missing required field.*beadId/i);
  });

  it('rejects BEAD_CLAIMED with only test/fixture data and no beadId', async () => {
    await expect(
      store.record(DomainEventName.BEAD_CLAIMED, { test: 'data' })
    ).rejects.toThrow(/BEAD_CLAIMED.*missing required field.*beadId/i);
  });

  it('rejects BEAD_CLAIMED with beadId but missing lease', async () => {
    await expect(
      store.record(DomainEventName.BEAD_CLAIMED, { beadId: 'bd-1' })
    ).rejects.toThrow(/BEAD_CLAIMED.*missing required field.*lease/i);
  });

  it('accepts BEAD_CLAIMED with both beadId and lease (real harness write shape)', async () => {
    await expect(
      store.record(DomainEventName.BEAD_CLAIMED, {
        beadId: 'bd-1',
        owner: 'Orr Else',
        stateId: 'Planning',
        lease: { owner: 'Orr Else', expiresAt: '2026-01-01T01:00:00.000Z' }
      })
    ).resolves.toBeUndefined();

    // Verify it was actually written to disk
    const eventsPath = path.join(tempRoot, '.pi/events', `${path.basename(tempRoot)}.jsonl`);
    const events = fs.readFileSync(eventsPath, 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(DomainEventName.BEAD_CLAIMED);
    expect(events[0].data.beadId).toBe('bd-1');
  });

  it('structured diagnostic names the event type, missing fields, and received keys', async () => {
    let error: Error | undefined;
    try {
      await store.record(DomainEventName.BEAD_CLAIMED, { test: 'data' });
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    // Diagnostic must name the event type
    expect(error!.message).toContain('BEAD_CLAIMED');
    // Diagnostic must name the missing field
    expect(error!.message).toContain('beadId');
    // Structured diagnostic payload on the error object
    const structured = (error as any).diagnostic;
    expect(structured).toBeDefined();
    expect(structured.eventType).toBe(DomainEventName.BEAD_CLAIMED);
    expect(structured.missingFields).toContain('beadId');
  });
});

// ---------------------------------------------------------------------------
// AC2: STATE_RUN_INITIALIZED without beadId+stateId+actionId is rejected
// ---------------------------------------------------------------------------

describe('AC2 – STATE_RUN_INITIALIZED production payload validation', () => {
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

  it('rejects STATE_RUN_INITIALIZED with empty data', async () => {
    await expect(
      store.record(DomainEventName.STATE_RUN_INITIALIZED, {})
    ).rejects.toThrow(/STATE_RUN_INITIALIZED.*missing required field/i);
  });

  it('rejects STATE_RUN_INITIALIZED missing stateId', async () => {
    await expect(
      store.record(DomainEventName.STATE_RUN_INITIALIZED, { beadId: 'bd-1', actionId: 'plan' })
    ).rejects.toThrow(/STATE_RUN_INITIALIZED.*missing required field.*stateId/i);
  });

  it('rejects STATE_RUN_INITIALIZED missing actionId', async () => {
    await expect(
      store.record(DomainEventName.STATE_RUN_INITIALIZED, { beadId: 'bd-1', stateId: 'Planning' })
    ).rejects.toThrow(/STATE_RUN_INITIALIZED.*missing required field.*actionId/i);
  });

  it('rejects STATE_RUN_INITIALIZED missing beadId', async () => {
    await expect(
      store.record(DomainEventName.STATE_RUN_INITIALIZED, { stateId: 'Planning', actionId: 'plan' })
    ).rejects.toThrow(/STATE_RUN_INITIALIZED.*missing required field.*beadId/i);
  });

  it('accepts STATE_RUN_INITIALIZED with all three required fields (real harness write shape)', async () => {
    await expect(
      store.record(DomainEventName.STATE_RUN_INITIALIZED, {
        beadId: 'bd-1',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        actionKey: 'workflow=v1/state=Planning/action=formulate-plan'
      })
    ).resolves.toBeUndefined();

    const eventsPath = path.join(tempRoot, '.pi/events', `${path.basename(tempRoot)}.jsonl`);
    const events = fs.readFileSync(eventsPath, 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0].data.stateId).toBe('Planning');
    expect(events[0].data.actionId).toBe('formulate-plan');
  });
});

// ---------------------------------------------------------------------------
// AC3: Production write path REJECTS synthetic:true.
//      Fixture/test writes use writeFixtureEvent() (raw JSONL injection).
//      Read-layer legacy filter (isSyntheticEvent) is the defense for any
//      on-disk synthetic records that pre-date this bead.
// ---------------------------------------------------------------------------

describe('AC3 – production rejects synthetic:true; fixture path via raw JSONL injection', () => {
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

  it('REJECTS BEAD_CLAIMED with synthetic:true through the production write path', async () => {
    await expect(
      store.record(DomainEventName.BEAD_CLAIMED, { test: 'data', synthetic: true })
    ).rejects.toThrow(/BEAD_CLAIMED.*production EventStore.*rejects.*synthetic/i);
  });

  it('rejection of synthetic:true carries EventStoreSyntheticRejectedError type', async () => {
    let caught: unknown;
    try {
      await store.record(DomainEventName.STATE_RUN_INITIALIZED, { synthetic: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EventStoreSyntheticRejectedError);
    expect((caught as EventStoreSyntheticRejectedError).eventType).toBe(DomainEventName.STATE_RUN_INITIALIZED);
  });

  it('fixture write via writeFixtureEvent() lands on disk with synthetic:true (raw JSONL)', async () => {
    // LEGACY-COMPAT: inject a synthetic record directly onto disk (as if it were
    // a pre-y2ax-redesign record written by an older harness version).
    await writeFixtureEvent(tempRoot, DomainEventName.BEAD_CLAIMED, { test: 'data', synthetic: true });

    const eventsPath = path.join(tempRoot, '.pi/events', `${path.basename(tempRoot)}.jsonl`);
    const rawEvents = fs.readFileSync(eventsPath, 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));
    expect(rawEvents).toHaveLength(1);
    expect(rawEvents[0].data.synthetic).toBe(true);

    // But the production read layer must hide it (legacy defense).
    const productionEvents = await store.readAll();
    expect(productionEvents.some(e => (e.data as Record<string, unknown>)?.synthetic === true)).toBe(false);
  });

  it('events with an empty required-field schema (no enforcement) are unaffected (no regression)', async () => {
    // CHECKLIST_ITEM_TICKED is registered in the g0bi registry with an empty
    // required-field list — it accepts any payload shape including { text: 'Done' }
    // without beadId (grandfathered: test fixtures predate the registry).
    await expect(
      store.record(DomainEventName.CHECKLIST_ITEM_TICKED, { text: 'Done' })
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC4: malformed production writes are rejected with a structured diagnostic
// ---------------------------------------------------------------------------

describe('AC4 – structured diagnostic on malformed production write', () => {
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

  it('rejected write leaves the event store file empty (event not persisted)', async () => {
    const eventsPath = path.join(tempRoot, '.pi/events', `${path.basename(tempRoot)}.jsonl`);

    try {
      await store.record(DomainEventName.BEAD_CLAIMED, { test: 'data' });
    } catch {
      // expected rejection
    }

    // The file must not exist (never created) or be empty — the event was NOT written
    if (fs.existsSync(eventsPath)) {
      const content = fs.readFileSync(eventsPath, 'utf8').trim();
      expect(content).toBe('');
    } else {
      expect(fs.existsSync(eventsPath)).toBe(false);
    }
  });

  it('error carries structured diagnostic with eventType, missingFields, and receivedKeys', async () => {
    let caught: unknown;
    try {
      await store.record(DomainEventName.STATE_RUN_INITIALIZED, { beadId: 'bd-1' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const diag = (caught as any).diagnostic;
    expect(diag).toMatchObject({
      eventType: DomainEventName.STATE_RUN_INITIALIZED,
      missingFields: expect.arrayContaining(['stateId', 'actionId']),
      receivedKeys: expect.arrayContaining(['beadId'])
    });
  });

  it('a valid write after a failed write succeeds (store remains consistent)', async () => {
    // First write fails
    try {
      await store.record(DomainEventName.BEAD_CLAIMED, { test: 'data' });
    } catch {
      // expected
    }

    // Second write (valid) succeeds
    await store.record(DomainEventName.BEAD_CLAIMED, {
      beadId: 'bd-ok',
      stateId: 'Planning',
      lease: { owner: 'Orr Else', expiresAt: '2026-01-01T01:00:00.000Z' }
    });

    const eventsPath = path.join(tempRoot, '.pi/events', `${path.basename(tempRoot)}.jsonl`);
    const events = fs.readFileSync(eventsPath, 'utf8')
      .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0].data.beadId).toBe('bd-ok');
  });
});
