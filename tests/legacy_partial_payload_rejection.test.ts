/**
 * pi-experiment-824i: Reject legacy partial domain-event payload shapes in production schemas.
 *
 * Load-bearing reject+accept tests for the tightened CHECKLIST_ITEM_TICKED and
 * CHECKLIST_ITEM_ADDED schemas. Validates that:
 *
 *   1. Legacy partial payloads (missing now-required fields) are REJECTED through
 *      the REAL production write path (EventStore.record) — not a hand-rolled
 *      validate() call. The rejection fires on EventStore.record() which invokes
 *      validateProductionPayload() → PRODUCTION_PAYLOAD_SCHEMAS → DOMAIN_EVENT_SCHEMAS.
 *
 *   2. Complete payloads (all required fields present) are ACCEPTED through the
 *      same path and land on disk.
 *
 *   3. The EventStoreValidationDiagnostic now includes schemaVersion (AC4).
 *
 * If the schema were reverted to permissive ([] empty arrays), tests in group (1)
 * would FAIL — they assert rejects.toThrow(), which would become a resolution.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore, EventStoreValidationError } from '../src/core/EventStore.js';
import { DOMAIN_EVENT_SCHEMAS } from '../src/core/DomainEventSchemas.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Logger } from '../src/core/Logger.js';
import { DomainEventName } from '../src/constants/index.js';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function setupTempRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-824i-'));
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
  store.setSessionId('824i-test');
  return store;
}

// ---------------------------------------------------------------------------
// Schema registry invariant: tightened schemas are non-empty
// ---------------------------------------------------------------------------

describe('824i – schema tightening: CHECKLIST schemas are non-empty (load-bearing invariant)', () => {
  it('CHECKLIST_ITEM_TICKED schema requires beadId and text (not the old empty array)', () => {
    const fields = DOMAIN_EVENT_SCHEMAS[DomainEventName.CHECKLIST_ITEM_TICKED];
    // This test FAILS if schema is reverted to [].
    expect(fields).toContain('beadId');
    expect(fields).toContain('text');
    expect(fields.length).toBeGreaterThan(0);
  });

  it('CHECKLIST_ITEM_ADDED schema requires beadId and item (not the old empty array)', () => {
    const fields = DOMAIN_EVENT_SCHEMAS[DomainEventName.CHECKLIST_ITEM_ADDED];
    // This test FAILS if schema is reverted to [].
    expect(fields).toContain('beadId');
    expect(fields).toContain('item');
    expect(fields.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Load-bearing reject tests through the REAL production path (record())
// ---------------------------------------------------------------------------

describe('824i – legacy partial payload REJECTION via real production write path', () => {
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

  it('REJECTS CHECKLIST_ITEM_TICKED with only text (missing beadId) — legacy partial shape', async () => {
    // This is the prototypical legacy partial payload: old writes supplied only
    // { text: 'Done' } without beadId. The rejection fires through:
    //   EventStore.record() → validateProductionPayload() → PRODUCTION_PAYLOAD_SCHEMAS
    // If schema is reverted to [], this test FAILS (resolves instead of rejects).
    await expect(
      store.record(DomainEventName.CHECKLIST_ITEM_TICKED, { text: 'Item done' })
    ).rejects.toThrow(/CHECKLIST_ITEM_TICKED.*missing required field.*beadId/i);
  });

  it('REJECTS CHECKLIST_ITEM_TICKED with only beadId (missing text) — partial shape', async () => {
    await expect(
      store.record(DomainEventName.CHECKLIST_ITEM_TICKED, { beadId: 'bd-1' })
    ).rejects.toThrow(/CHECKLIST_ITEM_TICKED.*missing required field.*text/i);
  });

  it('REJECTS CHECKLIST_ITEM_TICKED with empty payload — legacy empty shape', async () => {
    await expect(
      store.record(DomainEventName.CHECKLIST_ITEM_TICKED, {})
    ).rejects.toBeInstanceOf(EventStoreValidationError);
  });

  it('REJECTS CHECKLIST_ITEM_ADDED with only beadId (missing item) — partial shape', async () => {
    await expect(
      store.record(DomainEventName.CHECKLIST_ITEM_ADDED, { beadId: 'bd-1' })
    ).rejects.toThrow(/CHECKLIST_ITEM_ADDED.*missing required field.*item/i);
  });

  it('REJECTS CHECKLIST_ITEM_ADDED with empty payload — legacy empty shape', async () => {
    await expect(
      store.record(DomainEventName.CHECKLIST_ITEM_ADDED, {})
    ).rejects.toBeInstanceOf(EventStoreValidationError);
  });

  it('rejected CHECKLIST write does NOT persist to disk', async () => {
    const eventsPath = path.join(tempRoot, '.pi/events', `${path.basename(tempRoot)}.jsonl`);

    try {
      await store.record(DomainEventName.CHECKLIST_ITEM_TICKED, { text: 'Should not land' });
    } catch {
      // expected rejection
    }

    if (fs.existsSync(eventsPath)) {
      expect(fs.readFileSync(eventsPath, 'utf8').trim()).toBe('');
    } else {
      expect(fs.existsSync(eventsPath)).toBe(false);
    }
  });

  it('EventStoreValidationError diagnostic includes schemaVersion (AC4)', async () => {
    let caught: unknown;
    try {
      await store.record(DomainEventName.CHECKLIST_ITEM_TICKED, { text: 'No beadId' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EventStoreValidationError);
    const err = caught as EventStoreValidationError;
    expect(err.diagnostic.eventType).toBe(DomainEventName.CHECKLIST_ITEM_TICKED);
    expect(err.diagnostic.missingFields).toContain('beadId');
    // schemaVersion must be present (pi-experiment-824i AC4)
    expect(typeof err.diagnostic.schemaVersion).toBe('number');
    expect(err.diagnostic.schemaVersion).toBeGreaterThan(0);
    // schema v2: bumped in pi-experiment-824i
    expect(err.diagnostic.schemaVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Load-bearing accept tests through the REAL production path (record())
// ---------------------------------------------------------------------------

describe('824i – complete payload ACCEPTANCE via real production write path', () => {
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

  it('ACCEPTS CHECKLIST_ITEM_TICKED with beadId + text (complete shape matching extension.ts write)', async () => {
    await expect(
      store.record(DomainEventName.CHECKLIST_ITEM_TICKED, {
        beadId: 'bd-1',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        text: 'Read the spec',
        evidence: 'CLAUDE.md'
      })
    ).resolves.toBeUndefined();

    // Verify it landed on disk
    const eventsPath = path.join(tempRoot, '.pi/events', `${path.basename(tempRoot)}.jsonl`);
    const events = fs.readFileSync(eventsPath, 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(DomainEventName.CHECKLIST_ITEM_TICKED);
    expect(events[0].data.beadId).toBe('bd-1');
    expect(events[0].data.text).toBe('Read the spec');
  });

  it('ACCEPTS CHECKLIST_ITEM_TICKED with beadId + text only (no optional fields)', async () => {
    await expect(
      store.record(DomainEventName.CHECKLIST_ITEM_TICKED, {
        beadId: 'bd-2',
        text: 'Verify build passes'
      })
    ).resolves.toBeUndefined();
  });

  it('ACCEPTS CHECKLIST_ITEM_ADDED with beadId + item (complete shape matching extension.ts write)', async () => {
    await expect(
      store.record(DomainEventName.CHECKLIST_ITEM_ADDED, {
        beadId: 'bd-1',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        source: 'tool',
        item: { text: 'Write tests', mandatory: true }
      })
    ).resolves.toBeUndefined();

    const eventsPath = path.join(tempRoot, '.pi/events', `${path.basename(tempRoot)}.jsonl`);
    const events = fs.readFileSync(eventsPath, 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(DomainEventName.CHECKLIST_ITEM_ADDED);
    expect(events[0].data.beadId).toBe('bd-1');
    expect(events[0].data.item).toEqual({ text: 'Write tests', mandatory: true });
  });

  it('ACCEPTS CHECKLIST_ITEM_ADDED with beadId + item only (no optional fields)', async () => {
    await expect(
      store.record(DomainEventName.CHECKLIST_ITEM_ADDED, {
        beadId: 'bd-3',
        item: { text: 'Lint check' }
      })
    ).resolves.toBeUndefined();
  });
});
