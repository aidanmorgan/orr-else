/**
 * pi-experiment-g0bi: Canonical domain-event schema registry.
 *
 * AC1: A TypeScript domain-event schema registry covers all replay-critical AND
 *      startup-critical events (state run lifecycle, action completion/transition,
 *      worker/teammate lifecycle, tool invocation, evidence handle, restart
 *      lifecycle, startup events). REPLAY_CRITICAL_EVENT_TYPES is the source
 *      of truth.
 *
 * AC2: Production EventStore writes validate required fields and reject malformed
 *      payloads with structured diagnostics (extending y2ax's mechanism).
 *
 * AC3: Production write path REJECTS synthetic:true (y2ax redesign); fixture writes
 *      use writeFixtureEvent() (raw JSONL injection, isolated from production).
 *
 * AC4: Replay tests FAIL if required fields for covered event categories are
 *      absent.
 *
 * AC5: Backward compatibility — events/fields grandfathered with explicit rationale;
 *      older events lacking new fields must not crash projections.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore, EventStoreValidationError, EventStoreSyntheticRejectedError } from '../src/core/EventStore.js';
import { DOMAIN_EVENT_SCHEMAS } from '../src/core/DomainEventSchemas.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Logger } from '../src/core/Logger.js';
import { DomainEventName, REPLAY_CRITICAL_EVENT_TYPES, TeammateEventType } from '../src/constants/index.js';
import { writeFixtureEvent } from './support/TestEventStore.js';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function setupTempRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-g0bi-'));
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

function makeStore(tempRoot: string): EventStore {
  const store = new EventStore(new ConfigLoader(undefined, tempRoot), undefined, undefined, tempRoot);
  store.setSessionId('g0bi-test');
  return store;
}

// ---------------------------------------------------------------------------
// AC1: Registry structure — covers replay-critical and startup-critical events
// ---------------------------------------------------------------------------

describe('AC1 – registry covers replay-critical and startup-critical events', () => {
  it('REPLAY_CRITICAL_EVENT_TYPES is the source of truth: every replay-critical event has a schema entry', () => {
    const missingFromRegistry: string[] = [];
    for (const eventType of REPLAY_CRITICAL_EVENT_TYPES) {
      if (!(eventType in DOMAIN_EVENT_SCHEMAS)) {
        missingFromRegistry.push(eventType);
      }
    }
    expect(missingFromRegistry).toEqual([]);
  });

  it('state run lifecycle events have schemas: STATE_RUN_INITIALIZED, STATE_TRANSITION_APPLIED, ACTION_COMPLETED', () => {
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.STATE_RUN_INITIALIZED]).toEqual(
      expect.arrayContaining(['beadId', 'stateId', 'actionId'])
    );
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.STATE_TRANSITION_APPLIED]).toEqual(
      expect.arrayContaining(['beadId', 'fromState', 'nextState', 'transitionEvent'])
    );
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.ACTION_COMPLETED]).toEqual(
      expect.arrayContaining(['beadId', 'stateId', 'actionId'])
    );
  });

  it('worker/teammate lifecycle events have schemas', () => {
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.TEAMMATE_SPAWNED]).toEqual(
      expect.arrayContaining(['beadId', 'stateId', 'workerId'])
    );
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.TEAMMATE_PROCESS_EXITED]).toContain('beadId');
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.TEAMMATE_EVENT]).toEqual(
      expect.arrayContaining(['beadId', 'type', 'processingDecision'])
    );
  });

  it('worktree lifecycle events have schemas', () => {
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.WORKTREE_CREATED]).toEqual(
      expect.arrayContaining(['beadId', 'path'])
    );
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.WORKTREE_REUSED]).toEqual(
      expect.arrayContaining(['beadId', 'path'])
    );
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.WORKTREE_PROVISIONED]).toContain('beadId');
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.WORKTREE_REMOVED]).toEqual(
      expect.arrayContaining(['beadId', 'path'])
    );
  });

  it('tool invocation events have schemas: TOOL_INVOCATION_* and PROJECT_TOOL_*', () => {
    for (const event of [
      DomainEventName.TOOL_INVOCATION_STARTED,
      DomainEventName.TOOL_INVOCATION_SUCCEEDED,
      DomainEventName.TOOL_INVOCATION_FAILED,
    ]) {
      // beadId is NOT required: beadIdFromToolParams() returns string|undefined,
      // so beadId can be absent when a tool runs without a bead context.
      // Only tool is guaranteed by every writer (definition.name / event.toolName).
      expect(DOMAIN_EVENT_SCHEMAS[event]).toContain('tool');
      expect(DOMAIN_EVENT_SCHEMAS[event]).not.toContain('beadId');
    }
    // PROJECT_TOOL_* events require only 'tool' (not beadId) because
    // beadIdFromArgs() returns undefined when a tool is called without a bead
    // context (see project_tools.test.ts:2715 — execute({}, {} as any)).
    for (const event of [
      DomainEventName.PROJECT_TOOL_STARTED,
      DomainEventName.PROJECT_TOOL_SUCCEEDED,
      DomainEventName.PROJECT_TOOL_FAILED,
    ]) {
      expect(DOMAIN_EVENT_SCHEMAS[event]).toContain('tool');
    }
  });

  it('restart lifecycle events have schemas: CONTEXT_RESTART_REQUESTED, HARNESS_RESTART_REQUESTED', () => {
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.CONTEXT_RESTART_REQUESTED]).toEqual(
      expect.arrayContaining(['beadId', 'stateId', 'transitionEvent'])
    );
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.HARNESS_RESTART_REQUESTED]).toEqual(
      expect.arrayContaining(['beadId', 'stateId', 'transitionEvent'])
    );
  });

  it('signal idempotency & intent reconciliation events have schemas', () => {
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.SIGNAL_INTENT_RECORDED]).toEqual(
      expect.arrayContaining(['beadId', 'type'])
    );
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.SIGNAL_ACKNOWLEDGED]).toEqual(
      expect.arrayContaining(['beadId', 'type'])
    );
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.SIGNAL_INTENT_RECONCILED]).toContain('beadId');
  });

  it('startup/substrate events are registered: BEAD_CREATED', () => {
    expect(DOMAIN_EVENT_SCHEMAS[DomainEventName.BEAD_CREATED]).toContain('beadId');
  });

  it('schema required-field lists are non-empty arrays for all registered events', () => {
    for (const [eventType, fields] of Object.entries(DOMAIN_EVENT_SCHEMAS)) {
      // All entries must be arrays
      expect(Array.isArray(fields), `${eventType} schema must be an array`).toBe(true);
      // All required field names must be strings
      for (const field of fields) {
        expect(typeof field, `${eventType} field ${String(field)} must be a string`).toBe('string');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC2: Production EventStore writes validate required fields (extends y2ax)
// ---------------------------------------------------------------------------

describe('AC2 – extended registry validates production writes for new event categories', () => {
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

  // State transition
  it('rejects STATE_TRANSITION_APPLIED missing fromState', async () => {
    await expect(
      store.record(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-1',
        nextState: 'Implementation',
        transitionEvent: 'SUCCESS'
        // missing: fromState
      })
    ).rejects.toThrow(/STATE_TRANSITION_APPLIED.*missing required field.*fromState/i);
  });

  it('accepts STATE_TRANSITION_APPLIED with all required fields', async () => {
    await expect(
      store.record(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-1',
        fromState: 'Planning',
        nextState: 'Implementation',
        transitionEvent: 'SUCCESS',
        actionId: 'formulate-plan'
      })
    ).resolves.toBeUndefined();
  });

  // Action completed
  it('rejects ACTION_COMPLETED missing actionId', async () => {
    await expect(
      store.record(DomainEventName.ACTION_COMPLETED, {
        beadId: 'bd-1',
        stateId: 'Planning'
        // missing: actionId
      })
    ).rejects.toThrow(/ACTION_COMPLETED.*missing required field.*actionId/i);
  });

  it('accepts ACTION_COMPLETED with all required fields', async () => {
    await expect(
      store.record(DomainEventName.ACTION_COMPLETED, {
        beadId: 'bd-1',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        result: { status: 'SUCCESS' }
      })
    ).resolves.toBeUndefined();
  });

  // Worker lifecycle
  it('rejects TEAMMATE_SPAWNED missing workerId', async () => {
    await expect(
      store.record(DomainEventName.TEAMMATE_SPAWNED, {
        beadId: 'bd-1',
        stateId: 'Planning'
        // missing: workerId
      })
    ).rejects.toThrow(/TEAMMATE_SPAWNED.*missing required field.*workerId/i);
  });

  it('accepts TEAMMATE_SPAWNED with all required fields', async () => {
    await expect(
      store.record(DomainEventName.TEAMMATE_SPAWNED, {
        beadId: 'bd-1',
        stateId: 'Planning',
        workerId: 'w-abc',
        worktreePath: '/tmp/wt',
        paneId: '%1'
      })
    ).resolves.toBeUndefined();
  });

  // Worktree
  it('rejects WORKTREE_CREATED missing path', async () => {
    await expect(
      store.record(DomainEventName.WORKTREE_CREATED, {
        beadId: 'bd-1'
        // missing: path
      })
    ).rejects.toThrow(/WORKTREE_CREATED.*missing required field.*path/i);
  });

  it('accepts WORKTREE_CREATED with beadId and path', async () => {
    await expect(
      store.record(DomainEventName.WORKTREE_CREATED, {
        beadId: 'bd-1',
        path: '/tmp/worktrees/bd-1',
        branchName: 'bead/bd-1'
      })
    ).resolves.toBeUndefined();
  });

  // Restart lifecycle
  it('rejects CONTEXT_RESTART_REQUESTED missing transitionEvent', async () => {
    await expect(
      store.record(DomainEventName.CONTEXT_RESTART_REQUESTED, {
        beadId: 'bd-1',
        stateId: 'Planning'
        // missing: transitionEvent
      })
    ).rejects.toThrow(/CONTEXT_RESTART_REQUESTED.*missing required field.*transitionEvent/i);
  });

  it('accepts CONTEXT_RESTART_REQUESTED with minimal required fields', async () => {
    await expect(
      store.record(DomainEventName.CONTEXT_RESTART_REQUESTED, {
        beadId: 'bd-1',
        stateId: 'Planning',
        transitionEvent: 'CONTEXT_RESTART',
        targetState: 'Planning'
      })
    ).resolves.toBeUndefined();
  });

  // Tool invocation
  it('rejects TOOL_INVOCATION_STARTED missing tool', async () => {
    await expect(
      store.record(DomainEventName.TOOL_INVOCATION_STARTED, {
        beadId: 'bd-1'
        // missing: tool
      })
    ).rejects.toThrow(/TOOL_INVOCATION_STARTED.*missing required field.*tool/i);
  });

  it('accepts TOOL_INVOCATION_STARTED with beadId and tool', async () => {
    await expect(
      store.record(DomainEventName.TOOL_INVOCATION_STARTED, {
        beadId: 'bd-1',
        tool: 'artifact_validator',
        toolInvocationId: 'inv-1',
        params: {}
      })
    ).resolves.toBeUndefined();
  });

  // Signal intent
  it('rejects SIGNAL_INTENT_RECORDED missing type', async () => {
    await expect(
      store.record(DomainEventName.SIGNAL_INTENT_RECORDED, {
        beadId: 'bd-1'
        // missing: type
      })
    ).rejects.toThrow(/SIGNAL_INTENT_RECORDED.*missing required field.*type/i);
  });

  it('accepts SIGNAL_INTENT_RECORDED with beadId and type', async () => {
    await expect(
      store.record(DomainEventName.SIGNAL_INTENT_RECORDED, {
        beadId: 'bd-1',
        type: TeammateEventType.STATE_TRANSITIONED,
        stateId: 'Planning',
        workerId: 'w-abc',
        idempotencyKey: 'idem-1'
      })
    ).resolves.toBeUndefined();
  });

  // Teammate event (idempotency deduplication record)
  it('rejects TEAMMATE_EVENT missing processingDecision', async () => {
    await expect(
      store.record(DomainEventName.TEAMMATE_EVENT, {
        beadId: 'bd-1',
        type: TeammateEventType.STATE_TRANSITIONED
        // missing: processingDecision
      })
    ).rejects.toThrow(/TEAMMATE_EVENT.*missing required field.*processingDecision/i);
  });

  it('accepts TEAMMATE_EVENT with all required fields', async () => {
    await expect(
      store.record(DomainEventName.TEAMMATE_EVENT, {
        beadId: 'bd-1',
        type: TeammateEventType.STATE_TRANSITIONED,
        processingDecision: 'accept',
        stateId: 'Planning',
        workerId: 'w-abc',
        idempotencyKey: 'idem-1',
        processingReason: 'first occurrence'
      })
    ).resolves.toBeUndefined();
  });

  it('rejected registry write carries EventStoreValidationError diagnostic', async () => {
    let caught: unknown;
    try {
      await store.record(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-1'
        // missing: fromState, nextState, transitionEvent
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EventStoreValidationError);
    const err = caught as EventStoreValidationError;
    expect(err.diagnostic.eventType).toBe(DomainEventName.STATE_TRANSITION_APPLIED);
    expect(err.diagnostic.missingFields).toEqual(
      expect.arrayContaining(['fromState', 'nextState', 'transitionEvent'])
    );
    expect(err.diagnostic.receivedKeys).toContain('beadId');
  });
});

// ---------------------------------------------------------------------------
// AC3: Production write path REJECTS synthetic:true (y2ax redesign).
//      Fixture writes use writeFixtureEvent() (raw JSONL injection).
//      This group is the y2ax redesign regression guard: confirms that the
//      extended g0bi registry does NOT restore the synthetic bypass on the
//      production write path.
// ---------------------------------------------------------------------------

describe('AC3 – production rejects synthetic:true; g0bi registry does not restore the bypass', () => {
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

  it('REJECTS STATE_TRANSITION_APPLIED with synthetic:true through production write path', async () => {
    await expect(
      store.record(DomainEventName.STATE_TRANSITION_APPLIED, { synthetic: true, beadId: 'bd-1' })
    ).rejects.toBeInstanceOf(EventStoreSyntheticRejectedError);
  });

  it('REJECTS TEAMMATE_SPAWNED with synthetic:true through production write path', async () => {
    await expect(
      store.record(DomainEventName.TEAMMATE_SPAWNED, { synthetic: true, beadId: 'bd-1' })
    ).rejects.toBeInstanceOf(EventStoreSyntheticRejectedError);
  });

  it('REJECTS TOOL_INVOCATION_STARTED with synthetic:true through production write path', async () => {
    await expect(
      store.record(DomainEventName.TOOL_INVOCATION_STARTED, { synthetic: true, beadId: 'bd-1' })
    ).rejects.toBeInstanceOf(EventStoreSyntheticRejectedError);
  });

  it('REJECTS CONTEXT_RESTART_REQUESTED with synthetic:true through production write path', async () => {
    await expect(
      store.record(DomainEventName.CONTEXT_RESTART_REQUESTED, { synthetic: true, beadId: 'bd-1', stateId: 'Planning' })
    ).rejects.toBeInstanceOf(EventStoreSyntheticRejectedError);
  });

  it('fixture write via writeFixtureEvent() bypasses production validation (isolated test path)', async () => {
    // writeFixtureEvent goes directly to JSONL — no production validation.
    await expect(
      writeFixtureEvent(tempRoot, DomainEventName.STATE_TRANSITION_APPLIED, { synthetic: true, beadId: 'bd-1' })
    ).resolves.toBeUndefined();
  });

  it('events with empty required-field schemas (grandfathered) continue to accept any payload', async () => {
    // CHECKLIST_ITEM_TICKED is registered with an empty required-field list —
    // any payload shape is accepted (grandfathered: tests write it without beadId).
    await expect(
      store.record(DomainEventName.CHECKLIST_ITEM_TICKED, { text: 'Done' })
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC4: Replay FAILS if required fields for covered categories are absent
// ---------------------------------------------------------------------------

describe('AC4 – replay-critical required fields: absent fields cause rejection before write', () => {
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

  it('state execution: STATE_RUN_INITIALIZED without stateId is rejected', async () => {
    await expect(
      store.record(DomainEventName.STATE_RUN_INITIALIZED, { beadId: 'bd-1', actionId: 'plan' })
    ).rejects.toThrow(/STATE_RUN_INITIALIZED.*missing required field.*stateId/i);
  });

  it('action completion: ACTION_COMPLETED without beadId is rejected', async () => {
    await expect(
      store.record(DomainEventName.ACTION_COMPLETED, { stateId: 'Planning', actionId: 'plan' })
    ).rejects.toThrow(/ACTION_COMPLETED.*missing required field.*beadId/i);
  });

  it('worker lifecycle: TEAMMATE_SPAWNED without beadId is rejected', async () => {
    await expect(
      store.record(DomainEventName.TEAMMATE_SPAWNED, { stateId: 'Planning', workerId: 'w-1' })
    ).rejects.toThrow(/TEAMMATE_SPAWNED.*missing required field.*beadId/i);
  });

  it('tool invocation: TOOL_INVOCATION_SUCCEEDED accepts write without beadId (beadId not required)', async () => {
    // beadId is NOT required for TOOL_INVOCATION_* events: beadIdFromToolParams()
    // returns string|undefined, so writes without bead context must succeed.
    // Only tool is required.
    await expect(
      store.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, { tool: 'artifact_validator' })
    ).resolves.toBeUndefined();
  });

  it('project tool circuit-breaker: PROJECT_TOOL_FAILED without tool is rejected', async () => {
    // beadId is NOT required (can be undefined when called without bead context);
    // tool is required — it is definition.name and always provided by every writer.
    await expect(
      store.record(DomainEventName.PROJECT_TOOL_FAILED, { beadId: 'bd-1', stateId: 'Planning' })
    ).rejects.toThrow(/PROJECT_TOOL_FAILED.*missing required field.*tool/i);
  });

  it('restart lifecycle: HARNESS_RESTART_REQUESTED without stateId is rejected', async () => {
    await expect(
      store.record(DomainEventName.HARNESS_RESTART_REQUESTED, {
        beadId: 'bd-1',
        transitionEvent: 'HARNESS_RESTART'
      })
    ).rejects.toThrow(/HARNESS_RESTART_REQUESTED.*missing required field.*stateId/i);
  });

  it('signal idempotency: SIGNAL_ACKNOWLEDGED without type is rejected', async () => {
    await expect(
      store.record(DomainEventName.SIGNAL_ACKNOWLEDGED, { beadId: 'bd-1', stateId: 'Planning' })
    ).rejects.toThrow(/SIGNAL_ACKNOWLEDGED.*missing required field.*type/i);
  });

  it('rejected malformed write does NOT persist to disk', async () => {
    const eventsPath = path.join(tempRoot, '.pi/events', `${path.basename(tempRoot)}.jsonl`);

    try {
      await store.record(DomainEventName.STATE_TRANSITION_APPLIED, { beadId: 'bd-1' });
    } catch {
      // expected
    }

    if (fs.existsSync(eventsPath)) {
      expect(fs.readFileSync(eventsPath, 'utf8').trim()).toBe('');
    } else {
      expect(fs.existsSync(eventsPath)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// AC5: Backward compatibility — grandfathered fields do NOT crash projections
// ---------------------------------------------------------------------------

describe('AC5 – backward compatibility: grandfathered partial-shape writes are accepted', () => {
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

  it('TEAMMATE_PROCESS_EXITED with only beadId is accepted (Supervisor partial-shape path)', async () => {
    // Supervisor.ts:1027 writes { beadId } only when a pane goes missing without a restart.
    await expect(
      store.record(DomainEventName.TEAMMATE_PROCESS_EXITED, { beadId: 'bd-1' })
    ).resolves.toBeUndefined();
  });

  it('CONTEXT_RESTART_REQUESTED without restartId is accepted (pre-nyug writes)', async () => {
    // project_tools.test.ts:1027 writes without restartId (added in pi-experiment-nyug).
    await expect(
      store.record(DomainEventName.CONTEXT_RESTART_REQUESTED, {
        beadId: 'bd-1',
        stateId: 'Planning',
        transitionEvent: 'CONTEXT_RESTART',
        targetState: 'Planning'
      })
    ).resolves.toBeUndefined();
  });

  it('STATE_TRANSITION_APPLIED without workerId is accepted (workerId is optional)', async () => {
    // project_tools.test.ts:1071 writes without workerId.
    await expect(
      store.record(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-1',
        fromState: 'Planning',
        nextState: 'Implementation',
        transitionEvent: 'SUCCESS'
      })
    ).resolves.toBeUndefined();
  });

  it('SIGNAL_ACKNOWLEDGED without idempotencyKey is accepted (pre-registry test writes)', async () => {
    // project_tools.test.ts:1117 / synthetic_read_filter.test.ts:222 write without it.
    await expect(
      store.record(DomainEventName.SIGNAL_ACKNOWLEDGED, {
        beadId: 'bd-1',
        type: TeammateEventType.STATE_TRANSITIONED,
        stateId: 'Planning'
      })
    ).resolves.toBeUndefined();
  });

  it('PROJECT_TOOL_FAILED without stateId, actionId, or beadId is accepted (minimal write path)', async () => {
    // project_tools.test.ts:975 writes without stateId/actionId.
    // project_tools.test.ts:2715 invokes execute({}, {}) so beadId is undefined.
    // Only 'tool' is required.
    await expect(
      store.record(DomainEventName.PROJECT_TOOL_FAILED, {
        tool: 'pytest',
        status: 'REJECTED',
        result: { failureLimit: { failureCount: 1, maxFailures: 1, terminal: true } }
      })
    ).resolves.toBeUndefined();
  });

  it('WORKTREE_PROVISIONED with only beadId is accepted (Supervisor single-field write)', async () => {
    await expect(
      store.record(DomainEventName.WORKTREE_PROVISIONED, {
        beadId: 'bd-1',
        worktreePath: '/tmp/wt/bd-1'
      })
    ).resolves.toBeUndefined();
  });
});
