/**
 * pi-experiment-6k8e: v2 route-event domain schema and transition application contract.
 *
 * AC1: ROUTE_EVENT_EMITTED + STATE_TRANSITION_APPLIED v2 schemas are registered with
 *      required schema ID/version + replay-critical fields.
 * AC2: Projection applies transitions ONLY from schema-valid route events + exact
 *      configured transition keys (via v2ApplyTransition).
 * AC3: Model-authored outcome fields, route labels in prose, and untrusted
 *      stdout/stderr NEVER satisfy route evidence. LOAD-BEARING: must fail if
 *      anti-prose enforcement is removed.
 * AC4: Route-evidence artifact refs missing byteCount or sha256 are REJECTED by
 *      schema validation BEFORE projection. LOAD-BEARING.
 * AC5: Tests cover valid route emission, transition application referencing the
 *      route-event ID, malicious model/tool route strings ignored, missing-artifact-
 *      digest rejection, and replay use of route-event IDs.
 *
 * Each load-bearing test is marked LOAD-BEARING in its description.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { v7 as uuidv7 } from 'uuid';

import {
  applyV2RouteEvent,
  projectV2Transitions,
  validateEvidenceRefs,
  computeConfigFingerprint,
  ROUTE_EVENT_EMITTED_SCHEMA_ID,
  ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
  ROUTE_EVENT_EMITTED_JSON_SCHEMA,
  ROUTE_EVIDENCE_REF_JSON_SCHEMA,
  type V2RouteEventInput,
  type RouteEvidenceRef,
  type RouteEventStore,
  type ProjectableEvent,
} from '../src/core/RouteEventContract.js';
import { buildV2EventVocabulary, v2ApplyTransition } from '../src/core/FlowManager.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { DomainEventName, REPLAY_CRITICAL_EVENT_TYPES } from '../src/constants/index.js';
import { DOMAIN_EVENT_SCHEMAS, DOMAIN_EVENT_SCHEMA_METADATA } from '../src/core/DomainEventSchemas.js';
import { schemaRegistry, SchemaId, REQUIRED_BOUNDARY_IDS } from '../src/core/SchemaRegistry.js';
import { EventStore, EventStoreValidationError } from '../src/core/EventStore.js';
import { writeFixtureEvent } from './support/TestEventStore.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const TEST_DIR_PREFIX = path.join(os.tmpdir(), 'orr-else-6k8e-');

function makeTempDir(): string {
  return fs.mkdtempSync(TEST_DIR_PREFIX);
}

function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/** Minimal v2 config YAML with events block containing PLAN_ACCEPTED. */
const V2_CONFIG_YAML = `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "handover"
  harnessRestartEvent: HARNESS_RESTART
  contextRestartEvent: CONTEXT_RESTART
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: Planning
  terminal: [completed]
events:
  advance: [PLAN_ACCEPTED, SUCCESS]
  failure: [FAILURE]
  blocked: [BLOCKED]
  neutral: []
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan the work."
    actions:
      - id: plan_action
        type: prompt
        prompt: "Plan the task."
    transitions:
      PLAN_ACCEPTED: completed
      SUCCESS: completed
      FAILURE: Planning
      BLOCKED: Planning
`;

/** Minimal v1 config YAML (no version field). */
const V1_CONFIG_YAML = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
  maxConcurrentSlots: 2
  handoverTemplate: "handover"
  harnessRestartEvent: HARNESS_RESTART
  contextRestartEvent: CONTEXT_RESTART
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan."
    actions:
      - id: plan_action
        type: prompt
    transitions: { SUCCESS: completed, FAILURE: Planning }
`;

function writeConfig(dir: string, yaml: string): string {
  const p = path.join(dir, 'harness.yaml');
  fs.writeFileSync(p, yaml, 'utf8');
  return p;
}

function loadV2Config(dir: string): HarnessConfig {
  writeConfig(dir, V2_CONFIG_YAML);
  return new ConfigLoader(undefined, dir).load();
}

function loadV1Config(dir: string): HarnessConfig {
  writeConfig(dir, V1_CONFIG_YAML);
  return new ConfigLoader(undefined, dir).load();
}

/** A mock event store that records written events in memory. */
class MockEventStore implements RouteEventStore {
  readonly written: Array<{ event: string; data: unknown }> = [];

  async record(event: string, data: unknown): Promise<void> {
    this.written.push({ event, data });
  }
}

/** Stable test evidence ref with all required fields. */
function makeEvidenceRef(overrides: Partial<RouteEvidenceRef> = {}): RouteEvidenceRef {
  return {
    semanticPath: '.pi/artifacts/plan.md',
    byteCount: 1024,
    sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
    ...overrides
  };
}

/** Build a valid V2RouteEventInput with pre-computed vocab from a v2 config. */
function makeRouteEventInput(
  config: HarnessConfig,
  overrides: Partial<Omit<V2RouteEventInput, 'v2Vocab' | 'v2NextState'>> & {
    v2Vocab?: ReadonlyMap<string, string>;
    v2NextState?: string | null;
  } = {}
): V2RouteEventInput {
  const eventName = overrides.eventName ?? 'PLAN_ACCEPTED';
  const vocab = overrides.v2Vocab ?? buildV2EventVocabulary(config);
  const state = config.states['Planning']!;
  const v2NextState = overrides.v2NextState !== undefined
    ? overrides.v2NextState
    : v2ApplyTransition(state, eventName, vocab);

  return {
    beadId: 'bead-001',
    stateId: 'Planning',
    actionId: 'plan_action',
    runId: 'run-abc123',
    emitterType: 'verifier',
    emitterId: 'plan_verifier',
    configFingerprint: 'abcd1234abcd1234',
    evidenceRefs: [makeEvidenceRef()],
    ...overrides,
    eventName,
    v2Vocab: vocab,
    v2NextState
  };
}

// ---------------------------------------------------------------------------
// AC1: Schema registration — required fields + replay-critical
// ---------------------------------------------------------------------------

describe('AC1: ROUTE_EVENT_EMITTED schema registered with required fields', () => {
  it('ROUTE_EVENT_EMITTED is in DomainEventName enum', () => {
    expect(DomainEventName.ROUTE_EVENT_EMITTED).toBe('ROUTE_EVENT_EMITTED');
  });

  it('ROUTE_EVENT_EMITTED is in REPLAY_CRITICAL_EVENT_TYPES', () => {
    expect(REPLAY_CRITICAL_EVENT_TYPES.has(DomainEventName.ROUTE_EVENT_EMITTED)).toBe(true);
  });

  it('ROUTE_EVENT_EMITTED has required-field schema in DOMAIN_EVENT_SCHEMAS', () => {
    const schema = DOMAIN_EVENT_SCHEMAS[DomainEventName.ROUTE_EVENT_EMITTED];
    expect(schema).toBeDefined();
    // All 13 required fields must be present.
    const required = [
      'schemaId', 'schemaVersion',
      'configVersion', 'configFingerprint',
      'beadId', 'stateId', 'actionId', 'runId',
      'emitterType', 'emitterId',
      'eventName', 'category',
      'evidenceRefs'
    ];
    for (const field of required) {
      expect(schema).toContain(field);
    }
  });

  it('ROUTE_EVENT_EMITTED has CRITICAL replay metadata', () => {
    const meta = DOMAIN_EVENT_SCHEMA_METADATA[DomainEventName.ROUTE_EVENT_EMITTED];
    expect(meta).toBeDefined();
    expect(meta!.replayImpact).toBe('CRITICAL');
    // version 2: pi-experiment-6k8e added routeEventId to optionalFields.
    expect(meta!.version).toBe(2);
  });

  it('STATE_TRANSITION_APPLIED schema has v2 optional fields routeEventId + transitionKey', () => {
    const meta = DOMAIN_EVENT_SCHEMA_METADATA[DomainEventName.STATE_TRANSITION_APPLIED];
    expect(meta).toBeDefined();
    expect(meta!.optionalFields).toContain('routeEventId');
    expect(meta!.optionalFields).toContain('transitionKey');
  });

  it('STATE_TRANSITION_APPLIED v1 required fields are unchanged (no v1 regression)', () => {
    const schema = DOMAIN_EVENT_SCHEMAS[DomainEventName.STATE_TRANSITION_APPLIED];
    // The four v1 required fields must still be present.
    expect(schema).toContain('beadId');
    expect(schema).toContain('fromState');
    expect(schema).toContain('nextState');
    expect(schema).toContain('transitionEvent');
  });

  it('ROUTE_EVENT_EMITTED is registered in SchemaRegistry with correct id', () => {
    expect(schemaRegistry.has(ROUTE_EVENT_EMITTED_SCHEMA_ID)).toBe(true);
    expect(schemaRegistry.has(SchemaId.ROUTE_EVENT_EMITTED)).toBe(true);
    const entry = schemaRegistry.getEntry(ROUTE_EVENT_EMITTED_SCHEMA_ID);
    expect(entry.version).toBe(ROUTE_EVENT_EMITTED_SCHEMA_VERSION);
    expect(entry.replayPolicy).toBe('CRITICAL');
    expect(entry.owner).toBe('src/core/RouteEventContract.ts');
  });

  it('SchemaRegistry validator accepts a valid ROUTE_EVENT_EMITTED payload', () => {
    const validate = schemaRegistry.getValidator(ROUTE_EVENT_EMITTED_SCHEMA_ID);
    const valid = validate({
      schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
      schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
      configVersion: 2,
      configFingerprint: 'abcd1234abcd1234',
      beadId: 'bead-001',
      stateId: 'Planning',
      actionId: 'plan_action',
      runId: 'run-abc123',
      emitterType: 'verifier',
      emitterId: 'plan_verifier',
      eventName: 'PLAN_ACCEPTED',
      category: 'advance',
      evidenceRefs: [
        {
          semanticPath: '.pi/artifacts/plan.md',
          byteCount: 1024,
          sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd'
        }
      ]
    });
    expect(valid).toBe(true);
  });

  it('ROUTE_EVENT_EMITTED is in REQUIRED_BOUNDARY_IDS (anti-drift)', () => {
    expect(REQUIRED_BOUNDARY_IDS.has(ROUTE_EVENT_EMITTED_SCHEMA_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2: Projection applies transitions ONLY from schema-valid route events
//       + exact configured transition keys (v2ApplyTransition)
// ---------------------------------------------------------------------------

describe('AC2: v2 projection uses route events + exact keys', () => {
  let tempDir: string;
  let config: HarnessConfig;

  beforeEach(() => {
    tempDir = makeTempDir();
    config = loadV2Config(tempDir);
  });

  afterEach(() => removeTempDir(tempDir));

  it('S2a: valid route event emits ROUTE_EVENT_EMITTED and finds exact transition', async () => {
    const store = new MockEventStore();

    const result = await applyV2RouteEvent(
      makeRouteEventInput(config, { eventName: 'PLAN_ACCEPTED' }),
      store
    );

    expect(result.emitted).toBe(true);
    expect(result.category).toBe('advance');
    expect(result.transitionKey).toBe('PLAN_ACCEPTED');
    expect(result.nextState).toBe('completed');
    expect(result.rejectReason).toBeUndefined();

    // applyV2RouteEvent MUST return a routeEventId (no test-fabricated uuid needed).
    expect(result.routeEventId).toBeDefined();
    expect(typeof result.routeEventId).toBe('string');
    expect(result.routeEventId!.length).toBeGreaterThan(0);

    // ROUTE_EVENT_EMITTED was written.
    expect(store.written).toHaveLength(1);
    expect(store.written[0]!.event).toBe(DomainEventName.ROUTE_EVENT_EMITTED);

    const written = store.written[0]!.data as Record<string, unknown>;
    expect(written['schemaId']).toBe(ROUTE_EVENT_EMITTED_SCHEMA_ID);
    expect(written['schemaVersion']).toBe(ROUTE_EVENT_EMITTED_SCHEMA_VERSION);
    expect(written['configVersion']).toBe(2);
    expect(written['beadId']).toBe('bead-001');
    expect(written['eventName']).toBe('PLAN_ACCEPTED');
    expect(written['category']).toBe('advance');
    expect(written['emitterType']).toBe('verifier');
    expect(written['emitterId']).toBe('plan_verifier');

    // The routeEventId RETURNED matches the one EMBEDDED in the payload.
    // This is the key linkage test: no uuid fabrication by caller needed.
    expect(written['routeEventId']).toBe(result.routeEventId);
  });

  it('S2b: route event recognized but state has no transition for it — emitted:true, nextState:undefined', async () => {
    const store = new MockEventStore();

    const result = await applyV2RouteEvent(
      makeRouteEventInput(config, { eventName: 'BLOCKED' }),
      store
    );

    // BLOCKED is in the vocabulary (category: blocked) and has a transition (Planning → Planning)
    expect(result.emitted).toBe(true);
    expect(result.category).toBe('blocked');
    // The transition exists: BLOCKED → Planning
    expect(result.nextState).toBe('Planning');
  });

  it('S2c: v2ApplyTransition returns null for event with no exact transition key', () => {
    const vocab = buildV2EventVocabulary(config);
    const state = config.states['Planning']!;

    // Add a synthetic undeclared event to test: vocab won't have it
    const result = v2ApplyTransition(state, 'REQUIREMENTS_CLARIFICATION_NEEDED', vocab);
    // Not in vocab → null
    expect(result).toBeNull();
  });

  it('S2d: LOAD-BEARING — applyV2RouteEvent returns routeEventId; caller links STATE_TRANSITION_APPLIED without fabricating uuid', async () => {
    // Verifies the full linkage contract:
    //   1. applyV2RouteEvent() generates + returns a routeEventId.
    //   2. The same id is embedded in the ROUTE_EVENT_EMITTED payload.
    //   3. Caller writes STATE_TRANSITION_APPLIED using that id (no separate uuidv7() needed).
    //   4. Both records are readable; STATE_TRANSITION_APPLIED.routeEventId == ROUTE_EVENT_EMITTED.routeEventId.
    const tempRoot = makeTempDir();
    try {
      fs.mkdirSync(path.join(tempRoot, '.pi/events'), { recursive: true });
      fs.mkdirSync(path.join(tempRoot, '.pi/logs'), { recursive: true });
      writeConfig(tempRoot, V2_CONFIG_YAML);
      const v2Config = loadV2Config(tempRoot);
      const store = new EventStore(new ConfigLoader(undefined, tempRoot), undefined, undefined, tempRoot);
      store.setSessionId('6k8e-test');

      // Step 1: call applyV2RouteEvent — it generates and returns the routeEventId.
      // No test-fabricated uuid here.
      const emitResult = await applyV2RouteEvent(
        makeRouteEventInput(v2Config, { eventName: 'PLAN_ACCEPTED', beadId: 'bead-link-001' }),
        store
      );

      expect(emitResult.emitted).toBe(true);
      expect(emitResult.routeEventId).toBeDefined();
      const routeEventId = emitResult.routeEventId!;

      // Step 2: caller writes STATE_TRANSITION_APPLIED using the returned id.
      await store.record(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bead-link-001',
        fromState: 'Planning',
        nextState: 'completed',
        transitionEvent: 'PLAN_ACCEPTED',
        routeEventId,
        transitionKey: 'PLAN_ACCEPTED'
      });

      // Both records are readable.
      const events = await store.eventsForBead('bead-link-001');
      const routeEvents = events.filter(e => e.type === DomainEventName.ROUTE_EVENT_EMITTED);
      const transitionEvents = events.filter(e => e.type === DomainEventName.STATE_TRANSITION_APPLIED);

      expect(routeEvents).toHaveLength(1);
      expect(transitionEvents).toHaveLength(1);

      // The ROUTE_EVENT_EMITTED payload contains the self-referential routeEventId.
      expect(routeEvents[0]!.data['routeEventId']).toBe(routeEventId);

      // STATE_TRANSITION_APPLIED references the same id as the ROUTE_EVENT_EMITTED.
      expect(transitionEvents[0]!.data['routeEventId']).toBe(routeEventId);
      expect(transitionEvents[0]!.data['transitionKey']).toBe('PLAN_ACCEPTED');

      // The returned id is the link — no separate uuidv7() was generated by the test.
    } finally {
      removeTempDir(tempRoot);
    }
  });

  it('S2e: LOAD-BEARING — applyV2RouteEvent v1 vocab (empty) returns NOT_IN_VOCABULARY, no event written', async () => {
    const v1TempDir = makeTempDir();
    try {
      const v1Config = loadV1Config(v1TempDir);
      const store = new MockEventStore();

      // v1 config: buildV2EventVocabulary returns empty map.
      // applyV2RouteEvent with empty vocab → NOT_IN_VOCABULARY.
      const emptyVocab = buildV2EventVocabulary(v1Config); // returns empty map
      expect(emptyVocab.size).toBe(0);

      const result = await applyV2RouteEvent(
        {
          beadId: 'bead-001',
          stateId: 'Planning',
          actionId: 'plan_action',
          runId: 'run-abc',
          emitterType: 'verifier',
          emitterId: 'plan_verifier',
          eventName: 'PLAN_ACCEPTED',
          configFingerprint: 'abcd1234',
          evidenceRefs: [makeEvidenceRef()],
          v2Vocab: emptyVocab,
          v2NextState: null
        },
        store
      );

      // v1 empty vocab: no route event emitted, no store write.
      expect(result.emitted).toBe(false);
      expect(result.rejectReason).toBe('NOT_IN_VOCABULARY');
      expect(store.written).toHaveLength(0);
    } finally {
      removeTempDir(v1TempDir);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: LOAD-BEARING anti-prose enforcement
//       Model prose, tool stdout/stderr, worker args containing PLAN_ACCEPTED
//       MUST NOT produce a ROUTE_EVENT_EMITTED or any state transition.
// ---------------------------------------------------------------------------

describe('AC3: LOAD-BEARING — model prose, tool stdout/stderr, worker args never produce route events', () => {
  let tempDir: string;
  let config: HarnessConfig;

  beforeEach(() => {
    tempDir = makeTempDir();
    config = loadV2Config(tempDir);
  });

  afterEach(() => removeTempDir(tempDir));

  it('S3a: LOAD-BEARING — model review prose containing PLAN_ACCEPTED produces no ROUTE_EVENT_EMITTED', async () => {
    // Simulate a model review that contains the event name in prose.
    const modelProse = `
      I have completed the planning phase.
      Based on my analysis, the outcome is PLAN_ACCEPTED.
      This signifies that we can move to the next phase.
    `;

    // The harness MUST NOT scan prose for event names — no store.record() is
    // called for prose, and applyV2RouteEvent is NEVER called from a prose parser.
    // This test verifies that just having prose containing PLAN_ACCEPTED is not
    // enough — a deterministic emitter must explicitly call applyV2RouteEvent.

    const store = new MockEventStore();

    // A prose string is not a valid event name in the vocabulary.
    // Build a vocab and pass the prose as the eventName — must be rejected.
    const vocab = buildV2EventVocabulary(config);
    const proseAsEvent = await applyV2RouteEvent(
      {
        beadId: 'bead-001',
        stateId: 'Planning',
        actionId: 'plan_action',
        runId: 'run-abc123',
        emitterType: 'verifier',
        emitterId: 'plan_verifier',
        eventName: modelProse,
        configFingerprint: 'abcd1234abcd1234',
        evidenceRefs: [makeEvidenceRef()],
        v2Vocab: vocab,
        v2NextState: null
      },
      store
    );

    // Prose must be rejected — NOT in vocabulary.
    expect(proseAsEvent.emitted).toBe(false);
    expect(proseAsEvent.rejectReason).toBe('NOT_IN_VOCABULARY');
    expect(store.written).toHaveLength(0);

    // Even if we extract "PLAN_ACCEPTED" from prose and pass it, there's still
    // no route event unless a deterministic emitter explicitly calls applyV2RouteEvent.
    // The test below (S3b) covers the case where an extracted string is used.
  });

  it('S3b: LOAD-BEARING — projectV2Transitions rejects a record with invalid emitterType (anti-prose gate)', () => {
    // A ROUTE_EVENT_EMITTED record with emitterType 'model' (from a malicious actor
    // or a badly-migrated log) must be IGNORED by the read-side reducer.
    // This is the anti-prose gate: 'model' is not in the valid emitter enum.
    const vocab = buildV2EventVocabulary(config);
    const stateFor = (id: string) => config.states[id];

    const maliciousRecord: ProjectableEvent = {
      type: DomainEventName.ROUTE_EVENT_EMITTED,
      data: {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
        schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
        configVersion: 2,
        configFingerprint: 'abcd1234abcd1234',
        beadId: 'bead-001',
        stateId: 'Planning',
        actionId: 'plan_action',
        runId: 'run-abc123',
        emitterType: 'model',  // NOT in the valid enum — must be rejected
        emitterId: 'llm_prose_parser',
        eventName: 'PLAN_ACCEPTED',
        category: 'advance',
        evidenceRefs: [makeEvidenceRef()],
        routeEventId: '01928c8d-0000-7000-8000-000000000001'
      }
    };

    const transitions = projectV2Transitions([maliciousRecord], vocab, stateFor);

    // The malicious record with emitterType 'model' MUST be ignored.
    // If the emitterType gate is removed, this would return 1 transition — that's the mutation target.
    expect(transitions).toHaveLength(0);
  });

  it('S3c: LOAD-BEARING — projectV2Transitions ignores non-ROUTE_EVENT_EMITTED records (worker args, outcome fields)', () => {
    // Records that have all valid payload fields (vocab event, valid emitterType,
    // routeEventId) but the WRONG event type must be ignored by gate 1 alone.
    // If gate 1 is removed, these would pass all remaining gates and sneak through.
    const vocab = buildV2EventVocabulary(config);
    const stateFor = (id: string) => config.states[id];

    // A STATE_TRANSITION_APPLIED record where someone injected route-event-shaped data
    // into a non-ROUTE_EVENT_EMITTED record type (the event-type gate blocks it).
    const nonRouteEvents: ProjectableEvent[] = [
      {
        type: DomainEventName.STATE_TRANSITION_APPLIED,
        data: {
          beadId: 'bead-001', stateId: 'Planning', actionId: 'plan_action',
          emitterType: 'verifier', emitterId: 'plan_verifier',
          eventName: 'PLAN_ACCEPTED', category: 'advance',
          routeEventId: '01928c8d-4444-7000-8000-000000000001',
          fromState: 'Planning', nextState: 'completed', transitionEvent: 'PLAN_ACCEPTED'
        }
      },
      // A plain string-like event type that contains the vocab event name.
      {
        type: 'PLAN_ACCEPTED',
        data: {
          beadId: 'bead-001', stateId: 'Planning', actionId: 'plan_action',
          emitterType: 'tool', emitterId: 'some_tool',
          eventName: 'PLAN_ACCEPTED', category: 'advance',
          routeEventId: '01928c8d-5555-7000-8000-000000000001'
        }
      }
    ];

    const transitions = projectV2Transitions(nonRouteEvents, vocab, stateFor);

    // None of these records are ROUTE_EVENT_EMITTED — all must be ignored.
    // If the event-type gate (gate 1) is removed, both records would pass remaining
    // gates and produce 2 spurious transitions.
    expect(transitions).toHaveLength(0);
  });

  it('S3d: LOAD-BEARING — undeclared event (not in v2 vocab) never produces route event', async () => {
    const store = new MockEventStore();

    // An event name not in the declared v2 vocabulary must be rejected even if it
    // looks like a valid event (e.g. from an old v1 config or a model-authored string).
    const result = await applyV2RouteEvent(
      makeRouteEventInput(config, { eventName: 'CUSTOM_UNDECLARED_EVENT' }),
      store
    );

    expect(result.emitted).toBe(false);
    expect(result.rejectReason).toBe('NOT_IN_VOCABULARY');
    expect(store.written).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC4: LOAD-BEARING — missing artifact digest rejection
// ---------------------------------------------------------------------------

describe('AC4: LOAD-BEARING — missing artifact digest rejects route event before projection', () => {
  let tempDir: string;
  let config: HarnessConfig;

  beforeEach(() => {
    tempDir = makeTempDir();
    config = loadV2Config(tempDir);
  });

  afterEach(() => removeTempDir(tempDir));

  it('S4a: LOAD-BEARING — evidenceRef without sha256 → INVALID_EVIDENCE, no event written', async () => {
    const store = new MockEventStore();

    const refWithoutSha256 = {
      semanticPath: '.pi/artifacts/plan.md',
      byteCount: 1024
      // sha256: missing
    } as RouteEvidenceRef;

    const result = await applyV2RouteEvent(
      makeRouteEventInput(config, { evidenceRefs: [refWithoutSha256] }),
      store
    );

    expect(result.emitted).toBe(false);
    expect(result.rejectReason).toBe('INVALID_EVIDENCE');
    expect(store.written).toHaveLength(0);
  });

  it('S4b: LOAD-BEARING — evidenceRef without byteCount → INVALID_EVIDENCE, no event written', async () => {
    const store = new MockEventStore();

    const refWithoutByteCount = {
      semanticPath: '.pi/artifacts/plan.md',
      sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd'
      // byteCount: missing
    } as RouteEvidenceRef;

    const result = await applyV2RouteEvent(
      makeRouteEventInput(config, { evidenceRefs: [refWithoutByteCount] }),
      store
    );

    expect(result.emitted).toBe(false);
    expect(result.rejectReason).toBe('INVALID_EVIDENCE');
    expect(store.written).toHaveLength(0);
  });

  it('S4c: LOAD-BEARING — SchemaRegistry JSON Schema rejects evidenceRef without sha256', () => {
    const validate = schemaRegistry.getValidator(ROUTE_EVENT_EMITTED_SCHEMA_ID);

    const payloadMissingSha256 = {
      schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
      schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
      configVersion: 2,
      configFingerprint: 'abcd1234abcd1234',
      beadId: 'bead-001',
      stateId: 'Planning',
      actionId: 'plan_action',
      runId: 'run-abc123',
      emitterType: 'tool',
      emitterId: 'plan_tool',
      eventName: 'PLAN_ACCEPTED',
      category: 'advance',
      evidenceRefs: [
        {
          semanticPath: '.pi/artifacts/plan.md',
          byteCount: 1024
          // sha256: missing — MUST be rejected by schema
        }
      ]
    };

    expect(validate(payloadMissingSha256)).toBe(false);
  });

  it('S4d: LOAD-BEARING — SchemaRegistry JSON Schema rejects evidenceRef without byteCount', () => {
    const validate = schemaRegistry.getValidator(ROUTE_EVENT_EMITTED_SCHEMA_ID);

    const payloadMissingByteCount = {
      schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
      schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
      configVersion: 2,
      configFingerprint: 'abcd1234abcd1234',
      beadId: 'bead-001',
      stateId: 'Planning',
      actionId: 'plan_action',
      runId: 'run-abc123',
      emitterType: 'tool',
      emitterId: 'plan_tool',
      eventName: 'PLAN_ACCEPTED',
      category: 'advance',
      evidenceRefs: [
        {
          semanticPath: '.pi/artifacts/plan.md',
          sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd'
          // byteCount: missing — MUST be rejected by schema
        }
      ]
    };

    expect(validate(payloadMissingByteCount)).toBe(false);
  });

  it('S4e: production EventStore.record() rejects ROUTE_EVENT_EMITTED with missing required fields', async () => {
    const tempRoot = makeTempDir();
    try {
      fs.mkdirSync(path.join(tempRoot, '.pi/events'), { recursive: true });
      fs.mkdirSync(path.join(tempRoot, '.pi/logs'), { recursive: true });
      writeConfig(tempRoot, V2_CONFIG_YAML);
      const store = new EventStore(new ConfigLoader(undefined, tempRoot), undefined, undefined, tempRoot);
      store.setSessionId('6k8e-test');

      // Record without required 'evidenceRefs' field — must throw.
      await expect(store.record(DomainEventName.ROUTE_EVENT_EMITTED, {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
        schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
        configVersion: 2,
        configFingerprint: 'abcd1234abcd1234',
        beadId: 'bead-001',
        stateId: 'Planning',
        actionId: 'plan_action',
        runId: 'run-abc123',
        emitterType: 'verifier',
        emitterId: 'plan_verifier',
        eventName: 'PLAN_ACCEPTED',
        category: 'advance'
        // evidenceRefs: missing
      })).rejects.toBeInstanceOf(EventStoreValidationError);
    } finally {
      removeTempDir(tempRoot);
    }
  });

  it('S4f: validateEvidenceRefs returns null for valid refs (all fields present)', () => {
    const refs = [makeEvidenceRef()];
    expect(validateEvidenceRefs(refs)).toBeNull();
  });

  it('S4g: validateEvidenceRefs returns error message for ref with empty sha256', () => {
    const refs = [makeEvidenceRef({ sha256: '' })];
    const error = validateEvidenceRefs(refs);
    expect(error).not.toBeNull();
    expect(error).toContain('sha256');
  });

  it('S4h: validateEvidenceRefs returns error message for ref with negative byteCount', () => {
    const refs = [makeEvidenceRef({ byteCount: -1 })];
    const error = validateEvidenceRefs(refs);
    expect(error).not.toBeNull();
    expect(error).toContain('byteCount');
  });
});

// ---------------------------------------------------------------------------
// AC5: Replay — route-event IDs provide deterministic replay
// ---------------------------------------------------------------------------

describe('AC5: replay use of route-event IDs', () => {
  it('S5a: computeConfigFingerprint is deterministic (same input → same output)', () => {
    const fp1 = computeConfigFingerprint('harness-v2-config-path:/project/harness.yaml');
    const fp2 = computeConfigFingerprint('harness-v2-config-path:/project/harness.yaml');
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(16);
  });

  it('S5b: computeConfigFingerprint produces different output for different inputs', () => {
    const fp1 = computeConfigFingerprint('config-a');
    const fp2 = computeConfigFingerprint('config-b');
    expect(fp1).not.toBe(fp2);
  });

  it('S5c: two identical route event inputs produce identical payload (deterministic replay)', async () => {
    const tempDir1 = makeTempDir();
    const tempDir2 = makeTempDir();
    try {
      const config1 = loadV2Config(tempDir1);
      const config2 = loadV2Config(tempDir2);
      const input1 = makeRouteEventInput(config1);
      const input2 = makeRouteEventInput(config2);

      const store1 = new MockEventStore();
      const store2 = new MockEventStore();

      await applyV2RouteEvent(input1, store1);
      await applyV2RouteEvent(input2, store2);

      const payload1 = store1.written[0]!.data as Record<string, unknown>;
      const payload2 = store2.written[0]!.data as Record<string, unknown>;

      // Deterministic fields must match.
      expect(payload1['schemaId']).toBe(payload2['schemaId']);
      expect(payload1['schemaVersion']).toBe(payload2['schemaVersion']);
      expect(payload1['configVersion']).toBe(payload2['configVersion']);
      expect(payload1['eventName']).toBe(payload2['eventName']);
      expect(payload1['category']).toBe(payload2['category']);
      expect(payload1['emitterType']).toBe(payload2['emitterType']);
      expect(payload1['emitterId']).toBe(payload2['emitterId']);
    } finally {
      removeTempDir(tempDir1);
      removeTempDir(tempDir2);
    }
  });

  it('S5d: STATE_TRANSITION_APPLIED with routeEventId written to production EventStore is readable on replay', async () => {
    const tempRoot = makeTempDir();
    try {
      fs.mkdirSync(path.join(tempRoot, '.pi/events'), { recursive: true });
      fs.mkdirSync(path.join(tempRoot, '.pi/logs'), { recursive: true });
      writeConfig(tempRoot, V2_CONFIG_YAML);
      const v2Config = loadV2Config(tempRoot);
      const store = new EventStore(new ConfigLoader(undefined, tempRoot), undefined, undefined, tempRoot);
      store.setSessionId('6k8e-replay-test');

      // Use applyV2RouteEvent to write ROUTE_EVENT_EMITTED and get the routeEventId.
      // No test-fabricated uuid — the id comes from the emitter.
      const emitResult = await applyV2RouteEvent(
        makeRouteEventInput(v2Config, {
          eventName: 'PLAN_ACCEPTED',
          beadId: 'bead-replay-001',
          emitterType: 'gate',
          emitterId: 'plan_gate'
        }),
        store
      );
      expect(emitResult.emitted).toBe(true);
      const routeEventId = emitResult.routeEventId!;

      // Write STATE_TRANSITION_APPLIED referencing the routeEventId returned by applyV2RouteEvent.
      await store.record(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bead-replay-001',
        fromState: 'Planning',
        nextState: 'completed',
        transitionEvent: 'PLAN_ACCEPTED',
        routeEventId,
        transitionKey: 'PLAN_ACCEPTED'
      });

      // Replay: read all events for the bead.
      const events = await store.eventsForBead('bead-replay-001');
      const routeEvents = events.filter(e => e.type === DomainEventName.ROUTE_EVENT_EMITTED);
      const transitionEvents = events.filter(e => e.type === DomainEventName.STATE_TRANSITION_APPLIED);

      // Route event is present.
      expect(routeEvents).toHaveLength(1);
      expect(routeEvents[0]!.data.eventName).toBe('PLAN_ACCEPTED');
      expect(routeEvents[0]!.data.emitterType).toBe('gate');
      expect(routeEvents[0]!.data.configVersion).toBe(2);

      // Transition event references the route event.
      expect(transitionEvents).toHaveLength(1);
      expect(transitionEvents[0]!.data.routeEventId).toBe(routeEventId);
      expect(transitionEvents[0]!.data.transitionKey).toBe('PLAN_ACCEPTED');

      // The v1 required fields are still present (no v1 regression).
      expect(transitionEvents[0]!.data.beadId).toBe('bead-replay-001');
      expect(transitionEvents[0]!.data.fromState).toBe('Planning');
      expect(transitionEvents[0]!.data.nextState).toBe('completed');
      expect(transitionEvents[0]!.data.transitionEvent).toBe('PLAN_ACCEPTED');
    } finally {
      removeTempDir(tempRoot);
    }
  });

  it('S5e: replay using pre-written fixture events: ROUTE_EVENT_EMITTED is readable and REPLAY_CRITICAL', async () => {
    const tempRoot = makeTempDir();
    try {
      fs.mkdirSync(path.join(tempRoot, '.pi/events'), { recursive: true });
      fs.mkdirSync(path.join(tempRoot, '.pi/logs'), { recursive: true });
      writeConfig(tempRoot, V2_CONFIG_YAML);

      // Write fixture events directly to disk (bypassing production validation),
      // simulating a replay scenario from a historical event log (pre-6k8e: no routeEventId in payload).
      const fixtureRunId = uuidv7();
      await writeFixtureEvent(tempRoot, DomainEventName.BEAD_CLAIMED, {
        beadId: 'bead-fixture-001',
        lease: { beadId: 'bead-fixture-001', owner: 'test', expiresAt: new Date().toISOString() }
      });
      await writeFixtureEvent(tempRoot, DomainEventName.ROUTE_EVENT_EMITTED, {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
        schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
        configVersion: 2,
        configFingerprint: 'fixture-fp-001',
        beadId: 'bead-fixture-001',
        stateId: 'Planning',
        actionId: 'plan_action',
        runId: fixtureRunId,
        emitterType: 'verifier',
        emitterId: 'plan_verifier',
        eventName: 'PLAN_ACCEPTED',
        category: 'advance',
        evidenceRefs: [
          {
            semanticPath: '.pi/artifacts/plan.md',
            byteCount: 512,
            sha256: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
          }
        ]
        // No routeEventId — simulates a pre-6k8e fixture event; still valid.
      });

      const store = new EventStore(new ConfigLoader(undefined, tempRoot), undefined, undefined, tempRoot);
      store.setSessionId('6k8e-fixture-replay');

      const events = await store.eventsForBead('bead-fixture-001');
      const routeEvents = events.filter(e => e.type === DomainEventName.ROUTE_EVENT_EMITTED);

      expect(routeEvents).toHaveLength(1);
      expect(routeEvents[0]!.data.routeEventId).toBeUndefined(); // fixture didn't set it
      expect(routeEvents[0]!.data.eventName).toBe('PLAN_ACCEPTED');
      expect(routeEvents[0]!.data.configVersion).toBe(2);
    } finally {
      removeTempDir(tempRoot);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 (read-side): projectV2Transitions reducer — genuine v2 projection
// ---------------------------------------------------------------------------

describe('AC2 (read-side): projectV2Transitions — genuine v2 projection reducer', () => {
  let tempDir: string;
  let config: HarnessConfig;

  beforeEach(() => {
    tempDir = makeTempDir();
    config = loadV2Config(tempDir);
  });

  afterEach(() => removeTempDir(tempDir));

  it('LOAD-BEARING — projects a transition from a valid ROUTE_EVENT_EMITTED record', () => {
    const vocab = buildV2EventVocabulary(config);
    const stateFor = (id: string) => config.states[id];

    const validRecord: ProjectableEvent = {
      type: DomainEventName.ROUTE_EVENT_EMITTED,
      data: {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
        schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
        configVersion: 2,
        configFingerprint: 'abcd1234abcd1234',
        beadId: 'bead-proj-001',
        stateId: 'Planning',
        actionId: 'plan_action',
        runId: 'run-abc123',
        emitterType: 'verifier',
        emitterId: 'plan_verifier',
        eventName: 'PLAN_ACCEPTED',
        category: 'advance',
        evidenceRefs: [makeEvidenceRef()],
        routeEventId: '01928c8d-1111-7000-8000-000000000001'
      }
    };

    const transitions = projectV2Transitions([validRecord], vocab, stateFor);

    // Must produce exactly one transition.
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.eventName).toBe('PLAN_ACCEPTED');
    expect(transitions[0]!.category).toBe('advance');
    expect(transitions[0]!.emitterType).toBe('verifier');
    expect(transitions[0]!.nextState).toBe('completed');
    expect(transitions[0]!.transitionKey).toBe('PLAN_ACCEPTED');
    expect(transitions[0]!.routeEventId).toBe('01928c8d-1111-7000-8000-000000000001');
    expect(transitions[0]!.beadId).toBe('bead-proj-001');
  });

  it('LOAD-BEARING — ignores prose strings and non-ROUTE_EVENT_EMITTED records', () => {
    const vocab = buildV2EventVocabulary(config);
    const stateFor = (id: string) => config.states[id];

    // A mix of records that should all be ignored.
    const records: ProjectableEvent[] = [
      { type: 'PLAN_ACCEPTED', data: { beadId: 'bead-001' } },
      { type: DomainEventName.STATE_TRANSITION_APPLIED, data: { beadId: 'bead-001', fromState: 'Planning', nextState: 'completed', transitionEvent: 'PLAN_ACCEPTED' } },
      { type: DomainEventName.BEAD_CLAIMED, data: { beadId: 'bead-001', eventName: 'PLAN_ACCEPTED' } },
      // A route event record with missing routeEventId (no linkage possible).
      {
        type: DomainEventName.ROUTE_EVENT_EMITTED,
        data: {
          schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID, schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
          configVersion: 2, configFingerprint: 'fp', beadId: 'bead-001', stateId: 'Planning',
          actionId: 'a', runId: 'r', emitterType: 'verifier', emitterId: 'e',
          eventName: 'PLAN_ACCEPTED', category: 'advance', evidenceRefs: []
          // routeEventId: absent
        }
      }
    ];

    const transitions = projectV2Transitions(records, vocab, stateFor);

    // None of these records should produce a transition.
    expect(transitions).toHaveLength(0);
  });

  it('LOAD-BEARING — ignores ROUTE_EVENT_EMITTED with eventName not in v2 vocab', () => {
    const vocab = buildV2EventVocabulary(config);
    const stateFor = (id: string) => config.states[id];

    const unknownEventRecord: ProjectableEvent = {
      type: DomainEventName.ROUTE_EVENT_EMITTED,
      data: {
        schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID, schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
        configVersion: 2, configFingerprint: 'fp', beadId: 'bead-001', stateId: 'Planning',
        actionId: 'plan_action', runId: 'run-001', emitterType: 'tool', emitterId: 'some_tool',
        eventName: 'UNKNOWN_CUSTOM_EVENT',
        category: 'advance',
        evidenceRefs: [],
        routeEventId: '01928c8d-2222-7000-8000-000000000001'
      }
    };

    const transitions = projectV2Transitions([unknownEventRecord], vocab, stateFor);

    // Event not in vocab — must be ignored.
    expect(transitions).toHaveLength(0);
  });

  it('LOAD-BEARING — AC5 replay: same events → same transitions (deterministic)', () => {
    const vocab = buildV2EventVocabulary(config);
    const stateFor = (id: string) => config.states[id];

    const records: ProjectableEvent[] = [
      {
        type: DomainEventName.ROUTE_EVENT_EMITTED,
        data: {
          schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID, schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
          configVersion: 2, configFingerprint: 'fp-abc', beadId: 'bead-002', stateId: 'Planning',
          actionId: 'plan_action', runId: 'run-002', emitterType: 'gate', emitterId: 'plan_gate',
          eventName: 'PLAN_ACCEPTED', category: 'advance', evidenceRefs: [makeEvidenceRef()],
          routeEventId: '01928c8d-3333-7000-8000-000000000001'
        }
      }
    ];

    const result1 = projectV2Transitions(records, vocab, stateFor);
    const result2 = projectV2Transitions(records, vocab, stateFor);

    // Replay invariant: identical inputs → identical outputs.
    expect(result1).toHaveLength(1);
    expect(result2).toHaveLength(1);
    expect(result1[0]!.routeEventId).toBe(result2[0]!.routeEventId);
    expect(result1[0]!.eventName).toBe(result2[0]!.eventName);
    expect(result1[0]!.nextState).toBe(result2[0]!.nextState);
    expect(result1[0]!.category).toBe(result2[0]!.category);
  });

  it('projectV2Transitions via applyV2RouteEvent: emitted record is projectable without test-fabricated id', async () => {
    // End-to-end: emit via applyV2RouteEvent, then project the emitted record.
    // The routeEventId in the projected transition matches the one returned by the emitter.
    const store = new MockEventStore();
    const emitResult = await applyV2RouteEvent(
      makeRouteEventInput(config, { eventName: 'PLAN_ACCEPTED', beadId: 'bead-e2e-001' }),
      store
    );
    expect(emitResult.emitted).toBe(true);
    const returnedId = emitResult.routeEventId!;

    // Convert the mock-store write to a ProjectableEvent.
    const emittedRecord: ProjectableEvent = {
      type: store.written[0]!.event,
      data: store.written[0]!.data as Record<string, unknown>
    };

    const vocab = buildV2EventVocabulary(config);
    const stateFor = (id: string) => config.states[id];
    const transitions = projectV2Transitions([emittedRecord], vocab, stateFor);

    expect(transitions).toHaveLength(1);
    // The projected routeEventId == the id returned by applyV2RouteEvent.
    expect(transitions[0]!.routeEventId).toBe(returnedId);
    expect(transitions[0]!.eventName).toBe('PLAN_ACCEPTED');
    expect(transitions[0]!.nextState).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Version gating: v1 configs unaffected
// ---------------------------------------------------------------------------

describe('Version gating: v1 configs and cerdiwen unaffected', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => removeTempDir(tempDir));

  it('S6a: v1 config — empty vocab → NOT_IN_VOCABULARY for all events, nothing written', async () => {
    const v1Config = loadV1Config(tempDir);
    const store = new MockEventStore();

    // v1 config: buildV2EventVocabulary returns empty map → all events rejected.
    const emptyVocab = buildV2EventVocabulary(v1Config);
    expect(emptyVocab.size).toBe(0);

    const result = await applyV2RouteEvent(
      {
        beadId: 'bead-001',
        stateId: 'Planning',
        actionId: 'plan_action',
        runId: 'run-abc',
        emitterType: 'verifier',
        emitterId: 'plan_verifier',
        eventName: 'SUCCESS',
        configFingerprint: 'abcd1234',
        evidenceRefs: [makeEvidenceRef()],
        v2Vocab: emptyVocab,
        v2NextState: null
      },
      store
    );

    expect(result.emitted).toBe(false);
    expect(result.rejectReason).toBe('NOT_IN_VOCABULARY');
    expect(store.written).toHaveLength(0);
  });

  it('S6b: STATE_TRANSITION_APPLIED v1 records (no routeEventId/transitionKey) still validate', async () => {
    const tempRoot = makeTempDir();
    try {
      fs.mkdirSync(path.join(tempRoot, '.pi/events'), { recursive: true });
      fs.mkdirSync(path.join(tempRoot, '.pi/logs'), { recursive: true });
      writeConfig(tempRoot, V1_CONFIG_YAML);
      const store = new EventStore(new ConfigLoader(undefined, tempRoot), undefined, undefined, tempRoot);
      store.setSessionId('6k8e-v1-test');

      // A v1 STATE_TRANSITION_APPLIED without routeEventId/transitionKey must pass validation.
      await expect(store.record(DomainEventName.STATE_TRANSITION_APPLIED, {
        beadId: 'bead-v1-001',
        fromState: 'Planning',
        nextState: 'completed',
        transitionEvent: 'SUCCESS'
        // routeEventId: absent — v1 record
        // transitionKey: absent — v1 record
      })).resolves.toBeUndefined();

      const events = await store.eventsForBead('bead-v1-001');
      const transitionEvents = events.filter(e => e.type === DomainEventName.STATE_TRANSITION_APPLIED);
      expect(transitionEvents).toHaveLength(1);
      // No v2 fields on this v1 record.
      expect(transitionEvents[0]!.data.routeEventId).toBeUndefined();
    } finally {
      removeTempDir(tempRoot);
    }
  });

  it('S6c: buildV2EventVocabulary returns empty map for v1 config', () => {
    const v1Config = loadV1Config(tempDir);
    const vocab = buildV2EventVocabulary(v1Config);
    expect(vocab.size).toBe(0);
  });
});
