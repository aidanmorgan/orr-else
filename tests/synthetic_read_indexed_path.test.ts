/**
 * pi-experiment-dtly: regression test for the INDEXED-READ synthetic fail-closed path.
 *
 * pi-experiment-jxdk removed the silent synthetic-event read-layer filter and
 * made all production read paths FAIL CLOSED (throw EventStoreSyntheticReadError)
 * when a synthetic:true record is encountered on disk.
 *
 * The existing synthetic_read_filter.test.ts covers the SCAN/FALLBACK path
 * (no bead index on disk → eventsForBeads falls back to a full primary-log scan).
 * This file specifically locks in the INDEXED path:
 *
 *   EventStore.eventsForBeads() → BeadEventIndex.eventsForBead() returns events
 *   (not undefined) → EventStore loops over indexedEvents and calls
 *   rejectSyntheticReadIfPresent(e) on each → throws EventStoreSyntheticReadError.
 *
 * The indexed path is taken when BOTH the hashed bead-index JSONL AND the
 * corresponding .ready marker file exist on disk.  The scan/fallback path is
 * taken when BeadEventIndex.eventsForBead() returns undefined (no ready marker).
 *
 * Fixture strategy: we inject the synthetic record directly into the bead-index
 * JSONL (not the primary JSONL) and create a valid .ready marker.  This forces
 * BeadEventIndex.eventsForBead() to return the event (non-undefined), ensuring
 * the indexed branch is taken.  No production write path is used — the record
 * is written raw to disk, simulating a corrupted or pre-824i indexed record.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { EventStore, EventStoreSyntheticReadError } from '../src/core/EventStore.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Logger } from '../src/core/Logger.js';
import { DomainEventName } from '../src/constants/domain.js';
import { EventStoreDefaults } from '../src/constants/infra.js';
import type { BeadId } from '../src/types/ids.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupTempRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-dtly-idx-'));
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
  store.setSessionId('dtly-indexed-test');
  return store;
}

/**
 * Computes the hashed index filename for a bead ID — mirrors
 * BeadEventIndex.indexFileName() exactly so the fixture lands in the right file.
 */
function indexFileName(beadId: string): string {
  const sanitized = beadId
    .replace(EventStoreDefaults.UNSAFE_INDEX_PATH_SEGMENT_PATTERN, '-')
    .replace(/^-+|-+$/g, '');
  const prefix = sanitized || 'bead';
  const hash = createHash('sha256').update(beadId).digest('hex').slice(0, 8);
  return `${prefix}-${hash}${EventStoreDefaults.INDEX_FILE_EXTENSION}`;
}

/**
 * Writes a raw fixture event DIRECTLY into the bead-index JSONL for the given
 * beadId (bypassing production EventStore.record() validation) AND creates a
 * valid .ready marker so BeadEventIndex.eventsForBead() treats the index as
 * populated and returns events (non-undefined), forcing the indexed branch.
 *
 * This is the test-only backdoor that simulates a corrupted or pre-824i record
 * reaching the indexed layer without going through the production write guard.
 */
async function writeFixtureEventToIndex(
  tempRoot: string,
  beadId: string,
  eventType: string,
  data: Record<string, unknown>
): Promise<void> {
  const eventsDir = path.join(tempRoot, '.pi/events');
  const indexDir = path.join(eventsDir, EventStoreDefaults.BEAD_INDEX_DIR);
  fs.mkdirSync(indexDir, { recursive: true });

  const iFileName = indexFileName(beadId);
  const iPath = path.join(indexDir, iFileName);
  const rPath = `${iPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`;

  const entry = {
    id: `fixture-${Date.now()}`,
    type: eventType,
    timestamp: new Date().toISOString(),
    sessionId: 'dtly-fixture',
    data
  };

  // Write the event into the bead-index JSONL directly.
  await fs.promises.appendFile(iPath, JSON.stringify(entry) + '\n', 'utf8');

  // Write a valid .ready marker so BeadEventIndex.eventsForBead() treats the
  // index as ready (non-undefined return) → indexed branch is taken.
  // sources is empty (no primary bytes indexed) so the top-up loop runs but
  // finds nothing new in the primary file (which doesn't exist yet).
  const marker = { version: 1, generatedAt: new Date().toISOString(), sources: {} };
  await fs.promises.writeFile(rPath, JSON.stringify(marker), 'utf8');
}

// ---------------------------------------------------------------------------
// Regression tests: indexed-read path FAILS CLOSED on synthetic records
// ---------------------------------------------------------------------------

describe('pi-experiment-dtly: indexed-read synthetic fail-closed (eventsForBeads indexed branch)', () => {
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

  it('eventsForBead THROWS EventStoreSyntheticReadError when the synthetic record is in the bead index (indexed path)', async () => {
    const beadId = 'bd-dtly-indexed' as BeadId;

    // Inject a synthetic record directly into the bead index (not the primary
    // JSONL) and create a .ready marker so the indexed branch is taken.
    await writeFixtureEventToIndex(tempRoot, beadId, DomainEventName.STATE_RUN_INITIALIZED, {
      beadId,
      stateId: 'Planning',
      actionId: 'a1',
      synthetic: true
    });

    // Confirm the indexed path will be taken: the hashed index file AND marker exist.
    const indexDir = path.join(tempRoot, '.pi/events', EventStoreDefaults.BEAD_INDEX_DIR);
    const iPath = path.join(indexDir, indexFileName(beadId));
    const rPath = `${iPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`;
    expect(fs.existsSync(iPath)).toBe(true);
    expect(fs.existsSync(rPath)).toBe(true);

    // Production read MUST fail closed — NOT silently drop the synthetic record.
    await expect(store.eventsForBead(beadId)).rejects.toBeInstanceOf(EventStoreSyntheticReadError);
  });

  it('EventStoreSyntheticReadError from the indexed path carries the correct event type', async () => {
    const beadId = 'bd-dtly-err-shape' as BeadId;

    await writeFixtureEventToIndex(tempRoot, beadId, DomainEventName.BEAD_CLAIMED, {
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
    // Deterministic: no live timestamp leaking into the message.
    expect(err.message).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('eventsForBeads (batch) THROWS when the indexed bead contains a synthetic record', async () => {
    const cleanBead = 'bd-dtly-clean' as BeadId;
    const dirtBead = 'bd-dtly-dirty' as BeadId;

    // Write a legitimate real event for cleanBead via the production store.
    await store.record(DomainEventName.STATE_RUN_INITIALIZED, {
      beadId: cleanBead,
      stateId: 'Planning',
      actionId: 'a1'
    });

    // Inject a synthetic record for dirtBead into its bead-index.
    await writeFixtureEventToIndex(tempRoot, dirtBead, DomainEventName.STATE_RUN_INITIALIZED, {
      beadId: dirtBead,
      stateId: 'Planning',
      actionId: 'a1',
      synthetic: true
    });

    // The batch call must fail closed when any indexed bead has a synthetic record.
    await expect(store.eventsForBeads([cleanBead, dirtBead])).rejects.toBeInstanceOf(EventStoreSyntheticReadError);
  });

  it('indexed path: synthetic record on disk is NOT silently dropped (raw confirms it is there)', async () => {
    const beadId = 'bd-dtly-disk-confirm' as BeadId;

    await writeFixtureEventToIndex(tempRoot, beadId, DomainEventName.STATE_RUN_INITIALIZED, {
      beadId,
      stateId: 'Planning',
      actionId: 'a1',
      synthetic: true
    });

    // Raw JSONL in the bead index confirms the record is present.
    const indexDir = path.join(tempRoot, '.pi/events', EventStoreDefaults.BEAD_INDEX_DIR);
    const iPath = path.join(indexDir, indexFileName(beadId));
    const rawLines = fs.readFileSync(iPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));

    expect(rawLines).toHaveLength(1);
    expect(rawLines[0].data.synthetic).toBe(true);

    // Production read fails closed — not a silent drop.
    await expect(store.eventsForBead(beadId)).rejects.toBeInstanceOf(EventStoreSyntheticReadError);
  });

  it('control: non-synthetic record in the bead index is read successfully (indexed path is healthy for real events)', async () => {
    const beadId = 'bd-dtly-control' as BeadId;

    // Use the production store to write a real event — this populates the index
    // via EventStore.record() → beadIndex.append().
    await store.record(DomainEventName.STATE_RUN_INITIALIZED, {
      beadId,
      stateId: 'Planning',
      actionId: 'a1'
    });

    // The production read must succeed and return the real event.
    const events = await store.eventsForBead(beadId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(DomainEventName.STATE_RUN_INITIALIZED);
    expect(events[0].data?.synthetic).toBeUndefined();
  });
});
