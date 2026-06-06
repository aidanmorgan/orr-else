/**
 * Test-only isolated fixture writer for the event store.
 *
 * pi-experiment-y2ax (redesign): The production EventStore.record() now rejects
 * data.synthetic === true.  Tests that need to inject malformed or synthetic
 * fixture events must use this helper instead of the production writer.
 *
 * Usage — writing raw fixtures:
 *
 *   const fixture = new TestEventStore(tempRoot);
 *   await fixture.writeFixture(DomainEventName.STATE_RUN_INITIALIZED, {
 *     beadId: 'bd-1', stateId: 'Planning', actionId: 'plan', synthetic: true
 *   });
 *
 *   // The production store reads from the same JSONL, so the read-layer
 *   // isSyntheticEvent filter is exercised end-to-end.
 *   const events = await productionStore.eventsForBead('bd-1');
 *   expect(events.some(e => e.data?.synthetic === true)).toBe(false);
 *
 * The fixture is appended directly to the same JSONL file that the production
 * EventStore reads.  No production validation is run — this is intentional:
 * the fixture writer is a test-only escape hatch for injecting arbitrary
 * (possibly malformed or legacy-shaped) records onto disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v7 as uuidv7 } from 'uuid';

/** Default event store location — mirrors EventStoreDefaults in the harness constants. */
const DEFAULT_EVENTS_DIR = '.pi/events';

/**
 * Resolves the JSONL file path for a given tempRoot, matching the convention
 * used by EventStore: `<tempRoot>/.pi/events/<basename(tempRoot)>.jsonl`.
 */
export function resolveFixtureFilePath(tempRoot: string): string {
  const dir = path.join(tempRoot, DEFAULT_EVENTS_DIR);
  return path.join(dir, `${path.basename(tempRoot)}.jsonl`);
}

/**
 * Write a single fixture event directly onto disk (bypassing production
 * validation) into the same JSONL file that the production EventStore reads.
 *
 * @param tempRoot  - The temp directory used by both the fixture writer and
 *                    the production EventStore under test.
 * @param eventType - The domain event type string.
 * @param data      - Arbitrary payload (may include synthetic:true, missing
 *                    required fields, or any other fixture-specific shape).
 * @param sessionId - Optional sessionId (defaults to 'test-fixture').
 */
export async function writeFixtureEvent(
  tempRoot: string,
  eventType: string,
  data: Record<string, unknown>,
  sessionId = 'test-fixture'
): Promise<void> {
  const filePath = resolveFixtureFilePath(tempRoot);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const entry = {
    id: uuidv7(),
    type: eventType,
    timestamp: new Date().toISOString(),
    sessionId,
    data
  };

  await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
}
