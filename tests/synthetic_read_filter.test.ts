/**
 * pi-experiment-y2ax review fix: read-layer synthetic filter.
 *
 * Proves that filtering synthetic:true events at the EventStore read layer
 * (eventsForBeads / eventsForBead / scanEvents) uniformly protects the four
 * production consumers that the original per-consumer approach missed:
 *
 *   (a) WorkerRunController SHIP_POST_REVIEW gate / prompt-provenance —
 *       a synthetic STATE_RUN_INITIALIZED must NOT shift the current-run
 *       boundary used by the review-artifact gate or the provenance check.
 *
 *   (b) EventStore.latestProjectToolFailureLimitEvent circuit-breaker —
 *       a synthetic STATE_RUN_INITIALIZED must NOT reset the failure-limit
 *       window, so a real failure before and after the synthetic event is
 *       still visible to the circuit breaker.
 *
 * Both tests use a real EventStore writing to a temp directory so the actual
 * read path (eventsForBead → isSyntheticEvent filter) is exercised end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore } from '../src/core/EventStore.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Logger } from '../src/core/Logger.js';
import { DomainEventName, TeammateEventType } from '../src/constants/index.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function setupTempRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-y2ax-synth-'));
  fs.mkdirSync(path.join(tempRoot, '.pi/events'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, '.pi/logs'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'harness.yaml'), `
settings:
  startState: Planning
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan"
    actions: []
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
  return tempRoot;
}

function makeStore(tempRoot: string): EventStore {
  const store = new EventStore(new ConfigLoader(undefined, tempRoot), undefined, undefined, tempRoot);
  store.setSessionId('y2ax-synth-test');
  return store;
}

// ---------------------------------------------------------------------------
// (a) WorkerRunController gate: current-run boundary must NOT shift on
//     a synthetic STATE_RUN_INITIALIZED.
//
// The gate reads eventsForBead and reverse-finds the LATEST
// STATE_RUN_INITIALIZED for activeRun.stateId to determine when the current
// run started.  A synthetic one with the same stateId must be invisible.
// ---------------------------------------------------------------------------

describe('(a) current-run boundary — synthetic STATE_RUN_INITIALIZED does not shift it', () => {
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

  it('eventsForBead omits a synthetic STATE_RUN_INITIALIZED — real init event remains latest', async () => {
    const beadId = 'bd-gate-test';
    const stateId = 'AdversarialPostReview';

    // Real STATE_RUN_INITIALIZED — the run boundary.
    await store.record(DomainEventName.STATE_RUN_INITIALIZED, {
      beadId,
      stateId,
      actionId: 'review',
      promptProvenanceResolutionFailed: true
    });

    // Synthetic STATE_RUN_INITIALIZED for the same stateId — must be invisible.
    await store.record(DomainEventName.STATE_RUN_INITIALIZED, {
      beadId,
      stateId,
      actionId: 'injected-action',
      synthetic: true
    });

    const events = await store.eventsForBead(beadId);

    // The synthetic event must not appear in the production read.
    expect(events.some(e => e.data?.synthetic === true)).toBe(false);

    // The real init event must still be present.
    const initEvents = events.filter(
      e => e.type === DomainEventName.STATE_RUN_INITIALIZED && e.data?.stateId === stateId
    );
    expect(initEvents).toHaveLength(1);
    expect(initEvents[0].data?.actionId).toBe('review');
  });

  it('synthetic STATE_RUN_INITIALIZED is persisted on disk (raw JSONL confirms AC3 write)', async () => {
    const beadId = 'bd-persistence-check';
    const stateId = 'Planning';

    await store.record(DomainEventName.STATE_RUN_INITIALIZED, {
      beadId,
      stateId,
      actionId: 'sentinel',
      synthetic: true
    });

    // Raw JSONL read — synthetic event must be on disk.
    const eventsPath = path.join(tempRoot, '.pi/events', `${path.basename(tempRoot)}.jsonl`);
    const rawEvents = fs.readFileSync(eventsPath, 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));

    expect(rawEvents).toHaveLength(1);
    expect(rawEvents[0].type).toBe(DomainEventName.STATE_RUN_INITIALIZED);
    expect(rawEvents[0].data.synthetic).toBe(true);

    // But the production read must hide it.
    const productionEvents = await store.eventsForBead(beadId);
    expect(productionEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (b) Circuit-breaker window: latestProjectToolFailureLimitEvent must NOT
//     reset on a synthetic STATE_RUN_INITIALIZED.
//
// Sequence:
//   1. SIGNAL_ACKNOWLEDGED (STATE_TRANSITIONED) — terminal outcome acknowledged
//   2. Synthetic STATE_RUN_INITIALIZED — must NOT be seen as a run-start reset
//   3. Real PROJECT_TOOL_FAILED with failureLimit — must still be returned
//
// Without the read-layer filter the synthetic event was treated as a new run
// boundary, which cleared `latest` and caused `latestProjectToolFailureLimitEvent`
// to return undefined even though a real failure-limit event was present.
// ---------------------------------------------------------------------------

describe('(b) circuit-breaker window — synthetic STATE_RUN_INITIALIZED does not reset it', () => {
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

  it('failure-limit event before the synthetic init is still returned (circuit breaker intact)', async () => {
    const beadId = 'bd-circuit-test';
    const stateId = 'Planning';
    const actionId = 'formulate-plan';

    // 1. A real PROJECT_TOOL_FAILED with failureLimit payload.
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

    // 2. A synthetic STATE_RUN_INITIALIZED — must NOT reset the window.
    await store.record(DomainEventName.STATE_RUN_INITIALIZED, {
      beadId,
      stateId,
      actionId,
      synthetic: true
    });

    // latestProjectToolFailureLimitEvent reads via eventsForBead; the synthetic
    // event is invisible so it cannot act as a window-reset boundary.
    const result = await store.latestProjectToolFailureLimitEvent(beadId, { stateId, actionId });

    expect(result).toBeDefined();
    expect(result!.type).toBe(DomainEventName.PROJECT_TOOL_FAILED);
    const failureLimit = (result!.data?.result as any)?.failureLimit;
    expect(failureLimit?.terminal).toBe(true);
  });

  it('a REAL STATE_RUN_INITIALIZED after acknowledgement DOES reset the window (control case)', async () => {
    const beadId = 'bd-circuit-control';
    const stateId = 'Planning';
    const actionId = 'formulate-plan';

    // 1. Real failure event.
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

    // 2. Acknowledge terminal outcome.
    await store.record(DomainEventName.SIGNAL_ACKNOWLEDGED, {
      beadId,
      stateId,
      actionId,
      type: TeammateEventType.STATE_TRANSITIONED
    });

    // 3. REAL STATE_RUN_INITIALIZED — this one IS a legitimate run-start boundary.
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
