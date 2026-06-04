import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BeadEventIndex } from '../src/core/BeadEventIndex.js';
import { JsonlEventLog } from '../src/core/JsonlEventLog.js';
import { EventStoreDefaults } from '../src/constants/index.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';

const BEAD_CLAIMED = 'BEAD_CLAIMED';
const CHECKLIST_ITEM_TICKED = 'CHECKLIST_ITEM_TICKED';

function makeDomainEvent(overrides: Partial<DomainEvent>): DomainEvent {
  return {
    id: overrides.id ?? 'evt-default',
    type: overrides.type ?? BEAD_CLAIMED,
    timestamp: overrides.timestamp ?? '2026-01-01T00:00:00.000Z',
    sessionId: overrides.sessionId ?? 's1',
    data: overrides.data ?? {}
  };
}

function isDomainEvent(v: unknown): v is DomainEvent {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as any).type === 'string' &&
    typeof (v as any).timestamp === 'string'
  );
}

function beadIdFor(e: DomainEvent): string | undefined {
  return e.data?.beadId || e.data?.id;
}

function compareEvents(a: DomainEvent, b: DomainEvent): number {
  const byTime = Date.parse(a.timestamp) - Date.parse(b.timestamp);
  return byTime !== 0 ? byTime : String(a.id || '').localeCompare(String(b.id || ''));
}

describe('BeadEventIndex', () => {
  let tempDir: string;
  let eventLog: JsonlEventLog;
  let index: BeadEventIndex;
  let location: { dir: string };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bead-index-test-'));
    eventLog = new JsonlEventLog();
    index = new BeadEventIndex(eventLog);
    location = { dir: tempDir };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Append
  // ---------------------------------------------------------------------------

  it('creates the by-bead directory and index file on first append', async () => {
    const event = makeDomainEvent({ id: 'e1', data: { beadId: 'bd-1', stateId: 'Planning' } });
    await index.append(location, 'bd-1', event);

    const indexDir = path.join(tempDir, EventStoreDefaults.BEAD_INDEX_DIR);
    const indexPath = path.join(indexDir, `bd-1${EventStoreDefaults.INDEX_FILE_EXTENSION}`);
    expect(fs.existsSync(indexPath)).toBe(true);

    const lines = fs.readFileSync(indexPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ id: 'e1', type: BEAD_CLAIMED });
  });

  it('appends multiple events for the same bead', async () => {
    await index.append(location, 'bd-1', makeDomainEvent({ id: 'e1', data: { beadId: 'bd-1' } }));
    await index.append(location, 'bd-1', makeDomainEvent({ id: 'e2', type: CHECKLIST_ITEM_TICKED, timestamp: '2026-01-01T00:00:01.000Z', data: { beadId: 'bd-1', text: 'task' } }));

    const indexPath = path.join(tempDir, EventStoreDefaults.BEAD_INDEX_DIR, `bd-1${EventStoreDefaults.INDEX_FILE_EXTENSION}`);
    const lines = fs.readFileSync(indexPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe('e1');
    expect(JSON.parse(lines[1]).id).toBe('e2');
  });

  it('advances an existing ready marker to the current primary file size on append', async () => {
    const primaryPath = path.join(tempDir, 'project.jsonl');
    const event = makeDomainEvent({ id: 'e1', data: { beadId: 'bd-1' } });
    fs.writeFileSync(primaryPath, `${JSON.stringify(event)}\n`);
    const primarySize = fs.statSync(primaryPath).size;

    const indexDir = path.join(tempDir, EventStoreDefaults.BEAD_INDEX_DIR);
    fs.mkdirSync(indexDir, { recursive: true });
    const indexPath = path.join(indexDir, `bd-1${EventStoreDefaults.INDEX_FILE_EXTENSION}`);
    const readyPath = `${indexPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`;
    fs.writeFileSync(indexPath, '');
    fs.writeFileSync(readyPath, JSON.stringify({
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      sources: { 'project.jsonl': 0, 'other.jsonl': 42 }
    }));

    await index.append(location, 'bd-1', event, primaryPath);

    const marker = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
    expect(marker.sources['project.jsonl']).toBe(primarySize);
    expect(marker.sources['other.jsonl']).toBe(42);
    expect(marker.version).toBe(1);
    expect(marker.generatedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('uses unique temp marker paths even when append updates share the same millisecond', async () => {
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(1780498935534);
    try {
      const primaryPath = path.join(tempDir, 'project.jsonl');
      const e1 = makeDomainEvent({ id: 'e1', data: { beadId: 'bd-1' } });
      fs.writeFileSync(primaryPath, `${JSON.stringify(e1)}\n`);

      const indexDir = path.join(tempDir, EventStoreDefaults.BEAD_INDEX_DIR);
      fs.mkdirSync(indexDir, { recursive: true });
      const indexPath = path.join(indexDir, `bd-1${EventStoreDefaults.INDEX_FILE_EXTENSION}`);
      const readyPath = `${indexPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`;
      fs.writeFileSync(indexPath, '');
      fs.writeFileSync(readyPath, JSON.stringify({ version: 1, sources: { 'project.jsonl': 0 } }));

      await index.append(location, 'bd-1', e1, primaryPath);
      const e2 = makeDomainEvent({ id: 'e2', timestamp: '2026-01-01T00:00:01.000Z', data: { beadId: 'bd-1' } });
      fs.appendFileSync(primaryPath, `${JSON.stringify(e2)}\n`);
      await index.append(location, 'bd-1', e2, primaryPath);

      expect(fs.existsSync(indexPath)).toBe(true);
      expect(fs.existsSync(readyPath)).toBe(true);
      const marker = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
      expect(marker.sources['project.jsonl']).toBe(fs.statSync(primaryPath).size);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('bootstraps a ready marker on first append when a primary path is provided', async () => {
    const primaryPath = path.join(tempDir, 'project.jsonl');
    const event = makeDomainEvent({ id: 'e1', data: { beadId: 'bd-1' } });
    fs.writeFileSync(primaryPath, `${JSON.stringify(event)}\n`);
    const primarySize = fs.statSync(primaryPath).size;

    await index.append(location, 'bd-1', event, primaryPath);

    const readyPath = path.join(
      tempDir,
      EventStoreDefaults.BEAD_INDEX_DIR,
      `bd-1${EventStoreDefaults.INDEX_FILE_EXTENSION}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`
    );
    // The marker MUST be created on first append (previously it was never
    // bootstrapped, leaving the index write-only and unbounded).
    expect(fs.existsSync(readyPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
    expect(marker.version).toBe(1);
    expect(marker.sources['project.jsonl']).toBe(primarySize);
  });

  it('serves appended events from the index without a pre-existing marker (write+read round-trip)', async () => {
    const primaryPath = path.join(tempDir, 'project.jsonl');
    const e1 = makeDomainEvent({ id: 'e1', timestamp: '2026-01-01T00:00:01.000Z', data: { beadId: 'bd-1' } });
    const e2 = makeDomainEvent({ id: 'e2', timestamp: '2026-01-01T00:00:02.000Z', data: { beadId: 'bd-1' } });

    // Simulate EventStore.record: append to primary, then to the index, advancing
    // the marker each time to the current primary size.
    fs.writeFileSync(primaryPath, `${JSON.stringify(e1)}\n`);
    await index.append(location, 'bd-1', e1, primaryPath);
    fs.appendFileSync(primaryPath, `${JSON.stringify(e2)}\n`);
    await index.append(location, 'bd-1', e2, primaryPath);

    // Read served from the index (marker exists with the source offset).
    const result = await index.eventsForBead(location, 'bd-1', [primaryPath], isDomainEvent, beadIdFor, compareEvents);
    expect(result).not.toBeUndefined();
    expect(result!.map(e => e.id)).toEqual(['e1', 'e2']);

    // Prove the read was served from the index: the .ready marker exists on disk
    // and records the primary source offset (so eventsForBead no longer full-scans).
    const readyPath = path.join(
      tempDir,
      EventStoreDefaults.BEAD_INDEX_DIR,
      `bd-1${EventStoreDefaults.INDEX_FILE_EXTENSION}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`
    );
    expect(fs.existsSync(readyPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
    expect(marker.sources['project.jsonl']).toBe(fs.statSync(primaryPath).size);
  });

  it('removes index and ready marker when ready marker advancement fails', async () => {
    const primaryPath = path.join(tempDir, 'project.jsonl');
    const event = makeDomainEvent({ id: 'e1', data: { beadId: 'bd-1' } });
    fs.writeFileSync(primaryPath, `${JSON.stringify(event)}\n`);

    const indexDir = path.join(tempDir, EventStoreDefaults.BEAD_INDEX_DIR);
    fs.mkdirSync(indexDir, { recursive: true });
    const indexPath = path.join(indexDir, `bd-1${EventStoreDefaults.INDEX_FILE_EXTENSION}`);
    const readyPath = `${indexPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`;
    fs.writeFileSync(indexPath, '');
    fs.mkdirSync(readyPath);

    await index.append(location, 'bd-1', event, primaryPath);

    expect(fs.existsSync(indexPath)).toBe(false);
    expect(fs.existsSync(readyPath)).toBe(false);
  });

  it('sanitises bead IDs that contain unsafe path characters', async () => {
    const event = makeDomainEvent({ id: 'e1', data: { beadId: 'bd/with:unsafe' } });
    await index.append(location, 'bd/with:unsafe', event);

    const indexDir = path.join(tempDir, EventStoreDefaults.BEAD_INDEX_DIR);
    const files = fs.readdirSync(indexDir);
    expect(files.some(f => f.endsWith('.jsonl'))).toBe(true);
    // The slash and colon must have been replaced
    expect(files.every(f => !f.includes('/') && !f.includes(':'))).toBe(true);
  });

  it('removes stale index files when an append fails', async () => {
    const indexDir = path.join(tempDir, EventStoreDefaults.BEAD_INDEX_DIR);
    fs.mkdirSync(indexDir, { recursive: true });
    const indexPath = path.join(indexDir, `bd-fail${EventStoreDefaults.INDEX_FILE_EXTENSION}`);
    const readyPath = `${indexPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`;
    // Write the files so they exist before the failing append
    fs.writeFileSync(indexPath, '');
    fs.writeFileSync(readyPath, '{}');

    // Make append fail by pointing to a read-only directory (simulate via making
    // the index file a directory so appendFile throws)
    fs.rmSync(indexPath);
    fs.mkdirSync(indexPath);   // now indexPath is a directory — append will throw

    await index.append(location, 'bd-fail', makeDomainEvent({ data: { beadId: 'bd-fail' } }));

    // Both files must have been removed (the directory we planted also gets rm'd)
    // The ready marker must be gone
    expect(fs.existsSync(readyPath)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Read (eventsForBead)
  // ---------------------------------------------------------------------------

  it('returns undefined when no ready marker exists', async () => {
    // Create the index file but NOT the .ready marker
    const indexDir = path.join(tempDir, EventStoreDefaults.BEAD_INDEX_DIR);
    fs.mkdirSync(indexDir, { recursive: true });
    const indexPath = path.join(indexDir, `bd-1${EventStoreDefaults.INDEX_FILE_EXTENSION}`);
    fs.writeFileSync(indexPath, JSON.stringify(makeDomainEvent({ data: { beadId: 'bd-1' } })) + '\n');

    const result = await index.eventsForBead(location, 'bd-1', [], isDomainEvent, beadIdFor, compareEvents);
    expect(result).toBeUndefined();
  });

  it('reads events from the index file when a ready marker exists', async () => {
    const indexDir = path.join(tempDir, EventStoreDefaults.BEAD_INDEX_DIR);
    fs.mkdirSync(indexDir, { recursive: true });
    const indexPath = path.join(indexDir, `bd-1${EventStoreDefaults.INDEX_FILE_EXTENSION}`);
    const readyPath = `${indexPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`;

    const e1 = makeDomainEvent({ id: 'e1', timestamp: '2026-01-01T00:00:01.000Z', data: { beadId: 'bd-1' } });
    const e2 = makeDomainEvent({ id: 'e2', timestamp: '2026-01-01T00:00:02.000Z', data: { beadId: 'bd-1' } });
    fs.writeFileSync(indexPath, [e1, e2].map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(readyPath, JSON.stringify({ sources: {} }));

    const result = await index.eventsForBead(location, 'bd-1', [], isDomainEvent, beadIdFor, compareEvents);
    expect(result).toHaveLength(2);
    expect(result![0].id).toBe('e1');
    expect(result![1].id).toBe('e2');
  });

  it('catches up from primary files when the ready marker records a smaller offset', async () => {
    // Write a primary JSONL file with two events
    const primaryPath = path.join(tempDir, 'project.jsonl');
    const e1 = makeDomainEvent({ id: 'e1', timestamp: '2026-01-01T00:00:01.000Z', data: { beadId: 'bd-1' } });
    fs.writeFileSync(primaryPath, JSON.stringify(e1) + '\n');
    const afterE1 = fs.statSync(primaryPath).size;
    const e2 = makeDomainEvent({ id: 'e2', timestamp: '2026-01-01T00:00:02.000Z', data: { beadId: 'bd-1' } });
    fs.appendFileSync(primaryPath, JSON.stringify(e2) + '\n');

    // Index only contains e1; ready marker says primary stopped at afterE1
    const indexDir = path.join(tempDir, EventStoreDefaults.BEAD_INDEX_DIR);
    fs.mkdirSync(indexDir, { recursive: true });
    const indexPath = path.join(indexDir, `bd-1${EventStoreDefaults.INDEX_FILE_EXTENSION}`);
    const readyPath = `${indexPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`;
    fs.writeFileSync(indexPath, JSON.stringify(e1) + '\n');
    fs.writeFileSync(readyPath, JSON.stringify({ sources: { 'project.jsonl': afterE1 } }));

    const result = await index.eventsForBead(location, 'bd-1', [primaryPath], isDomainEvent, beadIdFor, compareEvents);
    expect(result).toHaveLength(2);
    expect(result!.map(e => e.id)).toEqual(['e1', 'e2']);
  });

  it('de-duplicates events that appear in both index and primary catch-up', async () => {
    const primaryPath = path.join(tempDir, 'project.jsonl');
    const e1 = makeDomainEvent({ id: 'e1', timestamp: '2026-01-01T00:00:01.000Z', data: { beadId: 'bd-1' } });
    fs.writeFileSync(primaryPath, JSON.stringify(e1) + '\n');

    const indexDir = path.join(tempDir, EventStoreDefaults.BEAD_INDEX_DIR);
    fs.mkdirSync(indexDir, { recursive: true });
    const indexPath = path.join(indexDir, `bd-1${EventStoreDefaults.INDEX_FILE_EXTENSION}`);
    const readyPath = `${indexPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`;
    // Index has e1; ready marker says offset 0 (so it re-reads e1 from primary too)
    fs.writeFileSync(indexPath, JSON.stringify(e1) + '\n');
    fs.writeFileSync(readyPath, JSON.stringify({ sources: { 'project.jsonl': 0 } }));

    const result = await index.eventsForBead(location, 'bd-1', [primaryPath], isDomainEvent, beadIdFor, compareEvents);
    expect(result).toHaveLength(1);
    expect(result![0].id).toBe('e1');
  });

  it('excludes events belonging to different beads during catch-up', async () => {
    const primaryPath = path.join(tempDir, 'project.jsonl');
    const e1 = makeDomainEvent({ id: 'e1', data: { beadId: 'bd-1' } });
    const e2 = makeDomainEvent({ id: 'e2', data: { beadId: 'bd-other' } });
    fs.writeFileSync(primaryPath, [e1, e2].map(e => JSON.stringify(e)).join('\n') + '\n');

    const indexDir = path.join(tempDir, EventStoreDefaults.BEAD_INDEX_DIR);
    fs.mkdirSync(indexDir, { recursive: true });
    const indexPath = path.join(indexDir, `bd-1${EventStoreDefaults.INDEX_FILE_EXTENSION}`);
    const readyPath = `${indexPath}${EventStoreDefaults.INDEX_READY_FILE_EXTENSION}`;
    fs.writeFileSync(indexPath, '');
    fs.writeFileSync(readyPath, JSON.stringify({ sources: { 'project.jsonl': 0 } }));

    const result = await index.eventsForBead(location, 'bd-1', [primaryPath], isDomainEvent, beadIdFor, compareEvents);
    expect(result).toHaveLength(1);
    expect(result![0].id).toBe('e1');
  });
});
