/**
 * pi-experiment-kutb: replay-critical event schema cases
 *
 * Extends g0bi's domain_event_schema_registry.test.ts with:
 *
 * AC1 (kutb): Every replay-critical event has version + replayImpact + optionalFields
 *             metadata in DOMAIN_EVENT_SCHEMA_METADATA.
 *
 * AC2 (kutb): Identity fields (beadId/stateId/actionId/runId/restartId/
 *             toolInvocationId) are schema-checked — required when the writer
 *             guarantees them, optional (documented) when the writer may omit.
 *
 * AC3 (kutb): Replay reconstruction tests — BeadStateProjection reconstructs
 *             state from a sequence of validated events; fails (event rejected)
 *             if required identity fields are missing.
 *
 * AC4 (kutb): Legacy-compat tests — old events lacking optional fields (restartId,
 *             toolInvocationId, runId, previousRunId) do NOT crash projections.
 *             Migration warnings are emitted for known upgrade gaps.
 *
 * NOTE: g0bi's DOMAIN_EVENT_SCHEMAS (required-field map) and
 *       EventStore.validateProductionPayload() are NOT modified. This file
 *       tests the kutb EXTENSION only (DOMAIN_EVENT_SCHEMA_METADATA +
 *       getDomainEventMeta).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DOMAIN_EVENT_SCHEMA_METADATA,
  DOMAIN_EVENT_SCHEMAS,
  getDomainEventMeta
} from '../src/core/DomainEventSchemas.js';
import { EventStore, EventStoreValidationError } from '../src/core/EventStore.js';
import { BeadStateProjection } from '../src/core/BeadStateProjection.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Logger } from '../src/core/Logger.js';
import { DomainEventName, EventName, REPLAY_CRITICAL_EVENT_TYPES, RestartKind, TeammateEventType } from '../src/constants/domain.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function setupTempRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-kutb-'));
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
  Implementation:
    identity: { role: "Builder", expertise: "Implementation", constraints: [] }
    baseInstructions: "Build"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: "completed", FAILURE: "Planning" }
`);
  return tempRoot;
}

function makeStore(tempRoot: string): EventStore {
  const store = new EventStore(new ConfigLoader(undefined, tempRoot), undefined, undefined, tempRoot);
  store.setSessionId('kutb-test');
  return store;
}

function makeEvent(type: string, data: Record<string, unknown>): DomainEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    timestamp: new Date().toISOString(),
    sessionId: 's-kutb',
    data
  };
}

// ---------------------------------------------------------------------------
// AC1 (kutb): DOMAIN_EVENT_SCHEMA_METADATA covers all registered events
// ---------------------------------------------------------------------------

describe('AC1 (kutb) – DOMAIN_EVENT_SCHEMA_METADATA structure', () => {
  it('every key in DOMAIN_EVENT_SCHEMAS has a corresponding DOMAIN_EVENT_SCHEMA_METADATA entry', () => {
    const missingMeta: string[] = [];
    for (const eventType of Object.keys(DOMAIN_EVENT_SCHEMAS)) {
      if (!(eventType in DOMAIN_EVENT_SCHEMA_METADATA)) {
        missingMeta.push(eventType);
      }
    }
    expect(missingMeta).toEqual([]);
  });

  it('every REPLAY_CRITICAL event has replayImpact CRITICAL or INFORMATIONAL', () => {
    for (const eventType of REPLAY_CRITICAL_EVENT_TYPES) {
      const meta = DOMAIN_EVENT_SCHEMA_METADATA[eventType];
      if (!meta) continue; // guard against future events added before schema
      expect(
        meta.replayImpact === 'CRITICAL' || meta.replayImpact === 'INFORMATIONAL',
        `${eventType} replay-critical event must not be AUDIT`
      ).toBe(true);
    }
  });

  it('every metadata entry has a positive integer version', () => {
    for (const [eventType, meta] of Object.entries(DOMAIN_EVENT_SCHEMA_METADATA)) {
      expect(
        Number.isInteger(meta.version) && meta.version >= 1,
        `${eventType} version must be a positive integer`
      ).toBe(true);
    }
  });

  it('every metadata entry has an optionalFields array of strings', () => {
    for (const [eventType, meta] of Object.entries(DOMAIN_EVENT_SCHEMA_METADATA)) {
      expect(Array.isArray(meta.optionalFields), `${eventType} optionalFields must be an array`).toBe(true);
      for (const field of meta.optionalFields) {
        expect(typeof field, `${eventType} optionalField ${String(field)} must be string`).toBe('string');
      }
    }
  });

  it('no required field also appears in optionalFields (separation of concerns)', () => {
    for (const [eventType, required] of Object.entries(DOMAIN_EVENT_SCHEMAS)) {
      const meta = DOMAIN_EVENT_SCHEMA_METADATA[eventType];
      if (!meta) continue;
      for (const req of required) {
        expect(
          meta.optionalFields.includes(req),
          `${eventType}: field "${req}" is required but also listed as optional — pick one`
        ).toBe(false);
      }
    }
  });

  it('getDomainEventMeta returns the correct metadata for a known event', () => {
    const meta = getDomainEventMeta(DomainEventName.STATE_RUN_INITIALIZED);
    expect(meta).toBeDefined();
    expect(meta?.replayImpact).toBe('CRITICAL');
    expect(meta?.version).toBeGreaterThanOrEqual(1);
    expect(meta?.optionalFields).toContain('restartId');
    expect(meta?.optionalFields).toContain('runId');
  });

  it('getDomainEventMeta returns undefined for an unknown event type', () => {
    expect(getDomainEventMeta('NON_EXISTENT_EVENT_TYPE')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC2 (kutb): Identity-field schema coverage per event category
// ---------------------------------------------------------------------------

describe('AC2 (kutb) – identity field coverage in metadata', () => {
  it('STATE_RUN_INITIALIZED: runId and restartId are optionalFields (writer may omit)', () => {
    const meta = getDomainEventMeta(DomainEventName.STATE_RUN_INITIALIZED)!;
    expect(meta.optionalFields).toContain('runId');
    expect(meta.optionalFields).toContain('restartId');
    expect(meta.optionalFields).toContain('previousRunId');
  });

  it('CONTEXT/HARNESS_RESTART_REQUESTED: restartId is a required field (q8tl), previousRunId is optionalFields', () => {
    // pi-experiment-q8tl: restartId and targetState are now required (moved from optionalFields).
    // previousRunId stays optional: supervisor-triggered restarts have no prior session ID.
    for (const evt of [DomainEventName.CONTEXT_RESTART_REQUESTED, DomainEventName.HARNESS_RESTART_REQUESTED]) {
      const meta = getDomainEventMeta(evt)!;
      expect(meta.optionalFields).not.toContain('restartId');
      expect(meta.optionalFields).not.toContain('targetState');
      expect(meta.optionalFields).toContain('previousRunId');
    }
  });

  it('TOOL_INVOCATION_*: toolInvocationId and beadId are optionalFields', () => {
    for (const evt of [
      DomainEventName.TOOL_INVOCATION_STARTED,
      DomainEventName.TOOL_INVOCATION_SUCCEEDED,
      DomainEventName.TOOL_INVOCATION_FAILED
    ]) {
      const meta = getDomainEventMeta(evt)!;
      expect(meta.optionalFields).toContain('toolInvocationId');
      expect(meta.optionalFields).toContain('beadId');
    }
  });

  it('PROJECT_TOOL_*: beadId, stateId, actionId, toolInvocationId are optionalFields', () => {
    for (const evt of [
      DomainEventName.PROJECT_TOOL_FAILED,
      DomainEventName.PROJECT_TOOL_SUCCEEDED,
      DomainEventName.PROJECT_TOOL_STARTED
    ]) {
      const meta = getDomainEventMeta(evt)!;
      expect(meta.optionalFields).toContain('beadId');
      expect(meta.optionalFields).toContain('stateId');
      expect(meta.optionalFields).toContain('actionId');
      expect(meta.optionalFields).toContain('toolInvocationId');
    }
  });

  it('STATE_TRANSITION_APPLIED: workerId is optionalFields', () => {
    const meta = getDomainEventMeta(DomainEventName.STATE_TRANSITION_APPLIED)!;
    expect(meta.optionalFields).toContain('workerId');
  });

  it('PROJECT_TOOL_FAILED has CRITICAL replayImpact (circuit-breaker replay-critical)', () => {
    const meta = getDomainEventMeta(DomainEventName.PROJECT_TOOL_FAILED)!;
    expect(meta.replayImpact).toBe('CRITICAL');
  });

  it('TOOL_INVOCATION_* has INFORMATIONAL replayImpact (not in REPLAY_CRITICAL_EVENT_TYPES)', () => {
    for (const evt of [
      DomainEventName.TOOL_INVOCATION_STARTED,
      DomainEventName.TOOL_INVOCATION_SUCCEEDED,
      DomainEventName.TOOL_INVOCATION_FAILED
    ]) {
      const meta = getDomainEventMeta(evt)!;
      expect(meta.replayImpact).toBe('INFORMATIONAL');
    }
  });

  it('HARNESS_STARTED/STOPPED have AUDIT replayImpact (pure substrate telemetry)', () => {
    expect(getDomainEventMeta(DomainEventName.HARNESS_STARTED)?.replayImpact).toBe('AUDIT');
    expect(getDomainEventMeta(DomainEventName.HARNESS_STOPPED)?.replayImpact).toBe('AUDIT');
  });
});

// ---------------------------------------------------------------------------
// AC3 (kutb): Replay reconstruction — state reconstructed from validated events
// ---------------------------------------------------------------------------

describe('AC3 (kutb) – replay reconstruction from validated events', () => {
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

  it('full bead lifecycle reconstructed: claim → run init → transition → action complete', () => {
    const projection = new BeadStateProjection();
    const events: DomainEvent[] = [
      makeEvent(DomainEventName.BEAD_CLAIMED, {
        beadId: 'bd-kutb-1',
        stateId: 'Planning',
        lease: { owner: 'OrrElse', expiresAt: '2099-01-01' }
      }),
      makeEvent(DomainEventName.STATE_RUN_INITIALIZED, {
        beadId: 'bd-kutb-1',
        stateId: 'Planning',
        actionId: 'formulate-plan'
      }),
      makeEvent(DomainEventName.ACTION_COMPLETED, {
        beadId: 'bd-kutb-1',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        result: { status: 'SUCCESS' }
      }),
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-kutb-1',
        fromState: 'Planning',
        nextState: 'Implementation',
        transitionEvent: 'SUCCESS',
        actionId: 'formulate-plan'
      })
    ];

    const result = projection.projectBeadStateChartFromEvents('bd-kutb-1', events);
    expect(result.currentState).toBe('Implementation');
    expect(result.previousState).toBe('Planning');
    // completedActionIds uses actionId directly when no actionKey/workflowVersion is set
    expect(result.completedActionIds).toContain('formulate-plan');
    expect(result.transitions).toHaveLength(1);
  });

  it('restart lifecycle reconstructed: restart requested → cleared on transition', () => {
    const projection = new BeadStateProjection();
    const events: DomainEvent[] = [
      makeEvent(DomainEventName.BEAD_CLAIMED, {
        beadId: 'bd-kutb-2',
        stateId: 'Implementation',
        lease: { owner: 'OrrElse', expiresAt: '2099-01-01' }
      }),
      makeEvent(DomainEventName.HARNESS_RESTART_REQUESTED, {
        beadId: 'bd-kutb-2',
        stateId: 'Implementation',
        targetState: 'Implementation',
        transitionEvent: EventName.HARNESS_RESTART
      }),
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-kutb-2',
        fromState: 'Implementation',
        nextState: 'Implementation',
        transitionEvent: EventName.HARNESS_RESTART
      })
    ];

    const result = projection.projectBeadStateChartFromEvents('bd-kutb-2', events);
    expect(result.restartRequested).toBe(false);
    expect(result.restartKind).toBeUndefined();
    expect(result.currentState).toBe('Implementation');
  });

  it('context restart reconstructed with restartKind CONTEXT', () => {
    const projection = new BeadStateProjection();
    const events: DomainEvent[] = [
      makeEvent(DomainEventName.BEAD_CLAIMED, {
        beadId: 'bd-kutb-3',
        stateId: 'Planning',
        lease: { owner: 'OrrElse', expiresAt: '2099-01-01' }
      }),
      makeEvent(DomainEventName.CONTEXT_RESTART_REQUESTED, {
        beadId: 'bd-kutb-3',
        stateId: 'Planning',
        targetState: 'Planning',
        transitionEvent: EventName.CONTEXT_RESTART,
        // optional fields present in newer writes:
        restartId: 'rst-abc123',
        previousRunId: 'run-xyz'
      })
    ];

    const result = projection.projectBeadStateChartFromEvents('bd-kutb-3', events);
    expect(result.restartRequested).toBe(true);
    expect(result.restartKind).toBe(RestartKind.CONTEXT);
    expect(result.restartFromState).toBe('Planning');
  });

  it('EventStore rejects STATE_RUN_INITIALIZED missing required stateId — replay fails before write', async () => {
    await expect(
      store.record(DomainEventName.STATE_RUN_INITIALIZED, {
        beadId: 'bd-kutb-fail',
        // missing stateId and actionId
      })
    ).rejects.toBeInstanceOf(EventStoreValidationError);
  });

  it('EventStore rejects ACTION_COMPLETED missing required beadId — identity missing causes rejection', async () => {
    await expect(
      store.record(DomainEventName.ACTION_COMPLETED, {
        stateId: 'Planning',
        actionId: 'formulate-plan'
        // missing beadId
      })
    ).rejects.toBeInstanceOf(EventStoreValidationError);
  });

  it('EventStore rejects TEAMMATE_SPAWNED missing workerId — identity missing causes rejection', async () => {
    await expect(
      store.record(DomainEventName.TEAMMATE_SPAWNED, {
        beadId: 'bd-kutb-fail',
        stateId: 'Planning'
        // missing workerId
      })
    ).rejects.toBeInstanceOf(EventStoreValidationError);
  });

  it('valid full-identity STATE_RUN_INITIALIZED (with optional restartId) is written', async () => {
    await expect(
      store.record(DomainEventName.STATE_RUN_INITIALIZED, {
        beadId: 'bd-kutb-ok',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        runId: 'sess-abc',
        restartId: 'rst-abc',
        previousRunId: 'run-prev'
      })
    ).resolves.toBeUndefined();
  });

  it('valid TOOL_INVOCATION_STARTED with toolInvocationId (optional) is written', async () => {
    await expect(
      store.record(DomainEventName.TOOL_INVOCATION_STARTED, {
        tool: 'artifact_validator',
        beadId: 'bd-kutb-ok',
        toolInvocationId: 'inv-abc123',
        stateId: 'Planning',
        actionId: 'formulate-plan'
      })
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC4 (kutb / q8tl INVERTED): Malformed restart records are rejected at write
// and projection boundaries — no pre-nyug compat fallback for restartId.
// ---------------------------------------------------------------------------

describe('AC4 (kutb) – malformed restart records are rejected (q8tl: no pre-nyug compat)', () => {
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

  it('pre-nyug CONTEXT_RESTART_REQUESTED without restartId is REJECTED (q8tl: now required)', async () => {
    // pi-experiment-q8tl: restartId is now required. Old pre-nyug writes are
    // rejected at the event store write boundary, not silently accepted.
    await expect(
      store.record(DomainEventName.CONTEXT_RESTART_REQUESTED, {
        beadId: 'bd-legacy-1',
        stateId: 'Planning',
        transitionEvent: 'CONTEXT_RESTART',
        targetState: 'Planning'
        // restartId absent — must be REJECTED
      })
    ).rejects.toThrow(/CONTEXT_RESTART_REQUESTED.*missing required field.*restartId/i);
  });

  it('pre-nyug HARNESS_RESTART_REQUESTED without restartId is REJECTED (q8tl: now required)', async () => {
    await expect(
      store.record(DomainEventName.HARNESS_RESTART_REQUESTED, {
        beadId: 'bd-legacy-2',
        stateId: 'Planning',
        transitionEvent: 'HARNESS_RESTART',
        targetState: 'Planning'
        // restartId absent — must be REJECTED
      })
    ).rejects.toThrow(/HARNESS_RESTART_REQUESTED.*missing required field.*restartId/i);
  });

  it('BeadStateProjection rejects legacy CONTEXT_RESTART_REQUESTED without restartId (records corruptionDiagnostics)', () => {
    const projection = new BeadStateProjection();
    const events: DomainEvent[] = [
      makeEvent(DomainEventName.CONTEXT_RESTART_REQUESTED, {
        beadId: 'bd-legacy-3',
        stateId: 'Planning',
        targetState: 'Planning',
        transitionEvent: EventName.CONTEXT_RESTART
        // No restartId — malformed; must be fail-closed
      })
    ];
    // Projection must not throw; the event is rejected, not applied.
    expect(() =>
      projection.projectBeadStateChartFromEvents('bd-legacy-3', events)
    ).not.toThrow();
    const result = projection.projectBeadStateChartFromEvents('bd-legacy-3', events);
    // restartRequested must NOT be set — the event was rejected
    expect(result.restartRequested).not.toBe(true);
    expect(result.corruptionDiagnostics).toBeDefined();
    expect(result.corruptionDiagnostics![0].missingFields).toContain('restartId');
  });

  it('STATE_RUN_INITIALIZED without runId/restartId is accepted (no-restart run path)', async () => {
    await expect(
      store.record(DomainEventName.STATE_RUN_INITIALIZED, {
        beadId: 'bd-legacy-4',
        stateId: 'Implementation',
        actionId: 'surgical-execution'
        // runId/restartId/previousRunId absent: normal non-restart run
      })
    ).resolves.toBeUndefined();
  });

  it('TOOL_INVOCATION_STARTED without toolInvocationId is accepted (older direct writes)', async () => {
    await expect(
      store.record(DomainEventName.TOOL_INVOCATION_STARTED, {
        tool: 'artifact_validator'
        // toolInvocationId absent: old write path
      })
    ).resolves.toBeUndefined();
  });

  it('TOOL_INVOCATION_SUCCEEDED without beadId is accepted (no-bead-context path)', async () => {
    await expect(
      store.record(DomainEventName.TOOL_INVOCATION_SUCCEEDED, {
        tool: 'artifact_validator'
        // beadId absent: tool ran without bead context
      })
    ).resolves.toBeUndefined();
  });

  it('STATE_TRANSITION_APPLIED without workerId is accepted (grandfathered partial write)', async () => {
    await expect(
      store.record(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-legacy-5',
        fromState: 'Planning',
        nextState: 'Implementation',
        transitionEvent: 'SUCCESS'
        // workerId absent: grandfathered (project_tools.test.ts:1071)
      })
    ).resolves.toBeUndefined();
  });

  it('BeadStateProjection handles STATE_TRANSITION_APPLIED without workerId gracefully', () => {
    const projection = new BeadStateProjection();
    const events: DomainEvent[] = [
      makeEvent(DomainEventName.BEAD_CLAIMED, {
        beadId: 'bd-legacy-6',
        stateId: 'Planning',
        lease: { owner: 'OrrElse', expiresAt: '2099-01-01' }
      }),
      makeEvent(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bd-legacy-6',
        fromState: 'Planning',
        nextState: 'Implementation',
        transitionEvent: 'SUCCESS'
        // workerId absent
      })
    ];
    expect(() =>
      projection.projectBeadStateChartFromEvents('bd-legacy-6', events)
    ).not.toThrow();
    const result = projection.projectBeadStateChartFromEvents('bd-legacy-6', events);
    expect(result.currentState).toBe('Implementation');
  });

  it('SIGNAL_ACKNOWLEDGED without idempotencyKey is accepted (pre-registry test writes)', async () => {
    await expect(
      store.record(DomainEventName.SIGNAL_ACKNOWLEDGED, {
        beadId: 'bd-legacy-7',
        type: TeammateEventType.STATE_TRANSITIONED
        // idempotencyKey absent: per g0bi grandfathered note
      })
    ).resolves.toBeUndefined();
  });

  it('PROJECT_TOOL_FAILED without beadId/stateId/actionId is accepted (minimal circuit-breaker write)', async () => {
    await expect(
      store.record(DomainEventName.PROJECT_TOOL_FAILED, {
        tool: 'pytest'
        // beadId/stateId/actionId all absent: beadIdFromArgs() returns undefined
      })
    ).resolves.toBeUndefined();
  });
});
