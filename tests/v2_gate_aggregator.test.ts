/**
 * v2_gate_aggregator.test.ts
 *
 * pi-experiment-ne2w: Add deterministic v2 gate aggregation with explicit precedence.
 *
 * AC1: v2 supports allOf and anyOf gate operators; noneOf is out of scope.
 * AC2: Gates evaluate ALL listed checks in configured order (no short-circuit) and
 *      emit EXACTLY ONE route event.
 * AC3: Blocked/failure/pass precedence and per-event precedence lists are documented
 *      and enforced at startup (ambiguity rejection in ConfigLoader).
 * AC4: Gate result events include ALL check evidence refs (even non-deciding checks).
 * AC5: Tests cover allOf pass/fail, anyOf pass/all-fail/blocked, precedence ordering,
 *      ambiguity rejection, no-short-circuit evidence collection, route-event schema validity.
 *
 * LOAD-BEARING tests are marked with LOAD-BEARING in their description.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { buildV2EventVocabulary, v2ApplyTransition } from '../src/core/FlowManager.js';
import {
  evaluateV2Gate,
  type V2GateEmitOptions,
  type V2GateAggregateResult,
} from '../src/core/V2GateAggregator.js';
import {
  computeConfigFingerprint,
  type RouteEvidenceRef,
  type RouteEventStore,
} from '../src/core/RouteEventContract.js';
import { DomainEventName } from '../src/constants/index.js';
import type { V2GateConfig, V2GateCheckResult } from '../src/core/domain/StateModels.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_DIR = fs.realpathSync(
  fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'orr-else-ne2w-'))
);

function writeFile(relPath: string, content: string): string {
  const abs = path.join(TEST_DIR, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function writeYaml(name: string, content: string): string {
  return writeFile(name, content);
}

afterEach(() => {
  for (const entry of fs.readdirSync(TEST_DIR)) {
    const p = path.join(TEST_DIR, entry);
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** Build a minimal in-memory event store that records events into an array. */
function makeTestStore(): { store: RouteEventStore; recorded: Array<{ type: string; data: unknown }> } {
  const recorded: Array<{ type: string; data: unknown }> = [];
  const store: RouteEventStore = {
    async record(event: string, data: unknown): Promise<void> {
      recorded.push({ type: event, data });
    }
  };
  return { store, recorded };
}

/** Stable test evidence ref for check A. */
const EVIDENCE_A: RouteEvidenceRef = {
  semanticPath: 'artifacts/quality.json',
  byteCount: 256,
  sha256: 'aaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee5',
};

/** Stable test evidence ref for check B. */
const EVIDENCE_B: RouteEvidenceRef = {
  semanticPath: 'artifacts/test_results.json',
  byteCount: 512,
  sha256: 'bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff6',
};

const TEST_FINGERPRINT = computeConfigFingerprint('test-config-ne2w');

/** Build a v2 vocab map for test events. */
function makeVocab(events: Record<string, string[]>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [category, names] of Object.entries(events)) {
    for (const n of names) {
      m.set(n.toUpperCase(), category);
    }
  }
  return m;
}

/** Standard test vocab. */
const TEST_VOCAB = makeVocab({
  advance: ['QUALITY_PASSED', 'GATE_PASSED'],
  failure: ['QUALITY_FAILED', 'TESTS_FAILED', 'GATE_FAILED'],
  blocked: ['QUALITY_BLOCKED', 'TESTS_BLOCKED', 'GATE_BLOCKED'],
  neutral: [],
});

/** Build standard V2GateEmitOptions for tests. */
function makeEmitOptions(store: RouteEventStore, overrides: Partial<V2GateEmitOptions> = {}): V2GateEmitOptions {
  return {
    beadId: 'test-bead-1',
    stateId: 'implement',
    actionId: 'quality-gate',
    runId: 'test-run-1',
    configFingerprint: TEST_FINGERPRINT,
    v2Vocab: TEST_VOCAB,
    v2NextState: null,
    store,
    ...overrides,
  };
}

/** Standard allOf gate config for two checks. */
const ALLOF_GATE_CONFIG: V2GateConfig = {
  id: 'implementation-quality',
  operator: 'allOf',
  checks: [
    { checkId: 'run_quality_checks', passEvent: 'QUALITY_PASSED', failEvent: 'QUALITY_FAILED', blockedEvent: 'QUALITY_BLOCKED' },
    { checkId: 'pytest', passEvent: 'QUALITY_PASSED', failEvent: 'TESTS_FAILED', blockedEvent: 'TESTS_BLOCKED' },
  ],
  passEvent: 'GATE_PASSED',
  failPrecedence: ['QUALITY_FAILED', 'TESTS_FAILED'],
  blockPrecedence: ['QUALITY_BLOCKED', 'TESTS_BLOCKED'],
};

/** Standard anyOf gate config for two checks. */
const ANYOF_GATE_CONFIG: V2GateConfig = {
  id: 'any-check-gate',
  operator: 'anyOf',
  checks: [
    { checkId: 'run_quality_checks', passEvent: 'QUALITY_PASSED', failEvent: 'QUALITY_FAILED', blockedEvent: 'QUALITY_BLOCKED' },
    { checkId: 'pytest', passEvent: 'QUALITY_PASSED', failEvent: 'TESTS_FAILED', blockedEvent: 'TESTS_BLOCKED' },
  ],
  passEvent: 'GATE_PASSED',
  failPrecedence: ['QUALITY_FAILED', 'TESTS_FAILED'],
  blockPrecedence: ['QUALITY_BLOCKED', 'TESTS_BLOCKED'],
};

// ---------------------------------------------------------------------------
// AC1 + AC2 (LOAD-BEARING): allOf all-pass → pass event emitted exactly once
// ---------------------------------------------------------------------------

describe('pi-experiment-ne2w AC1/AC2: allOf gate — all checks pass', () => {
  it('LOAD-BEARING: allOf all-pass → single GATE_PASSED route event with all evidence', async () => {
    const { store, recorded } = makeTestStore();

    const checkResults: V2GateCheckResult[] = [
      { checkId: 'run_quality_checks', verdict: 'pass', eventName: 'QUALITY_PASSED', evidenceRefs: [EVIDENCE_A] },
      { checkId: 'pytest', verdict: 'pass', eventName: 'QUALITY_PASSED', evidenceRefs: [EVIDENCE_B] },
    ];

    const result = await evaluateV2Gate(ALLOF_GATE_CONFIG, checkResults, makeEmitOptions(store));

    // Exactly one route event emitted (AC2).
    expect(recorded.filter(r => r.type === DomainEventName.ROUTE_EVENT_EMITTED)).toHaveLength(1);

    // Verdict is pass.
    expect(result.verdict).toBe('pass');
    expect(result.eventName).toBe('GATE_PASSED');

    // All evidence included (AC4) — both checks' evidence refs in order.
    expect(result.allEvidence).toHaveLength(2);
    expect(result.allEvidence[0]).toEqual(EVIDENCE_A);
    expect(result.allEvidence[1]).toEqual(EVIDENCE_B);

    // Route event was emitted successfully.
    expect(result.routeEventResult.emitted).toBe(true);
    expect(result.routeEventResult.routeEventId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC1 + AC2 (LOAD-BEARING): allOf one-fail → fail event chosen by failPrecedence
// ---------------------------------------------------------------------------

describe('pi-experiment-ne2w AC1/AC2: allOf gate — first check fails', () => {
  it('LOAD-BEARING: allOf first-check-fail → QUALITY_FAILED route event (highest precedence)', async () => {
    const { store, recorded } = makeTestStore();

    const checkResults: V2GateCheckResult[] = [
      { checkId: 'run_quality_checks', verdict: 'fail', eventName: 'QUALITY_FAILED', evidenceRefs: [EVIDENCE_A] },
      { checkId: 'pytest', verdict: 'pass', eventName: 'QUALITY_PASSED', evidenceRefs: [EVIDENCE_B] },
    ];

    const result = await evaluateV2Gate(ALLOF_GATE_CONFIG, checkResults, makeEmitOptions(store));

    expect(recorded.filter(r => r.type === DomainEventName.ROUTE_EVENT_EMITTED)).toHaveLength(1);
    expect(result.verdict).toBe('fail');
    expect(result.eventName).toBe('QUALITY_FAILED');

    // All evidence still recorded even though second check passed (AC4 no short-circuit).
    expect(result.allEvidence).toHaveLength(2);
  });

  it('LOAD-BEARING: allOf two-fail → failPrecedence determines winner (QUALITY_FAILED over TESTS_FAILED)', async () => {
    const { store, recorded } = makeTestStore();

    const checkResults: V2GateCheckResult[] = [
      { checkId: 'run_quality_checks', verdict: 'fail', eventName: 'QUALITY_FAILED', evidenceRefs: [EVIDENCE_A] },
      { checkId: 'pytest', verdict: 'fail', eventName: 'TESTS_FAILED', evidenceRefs: [EVIDENCE_B] },
    ];

    const result = await evaluateV2Gate(ALLOF_GATE_CONFIG, checkResults, makeEmitOptions(store));

    expect(recorded.filter(r => r.type === DomainEventName.ROUTE_EVENT_EMITTED)).toHaveLength(1);
    expect(result.verdict).toBe('fail');
    // QUALITY_FAILED is first in failPrecedence → wins.
    expect(result.eventName).toBe('QUALITY_FAILED');
    // Both checks' evidence included (AC4).
    expect(result.allEvidence).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC2/AC4 (LOAD-BEARING): no short-circuit — non-deciding check evidence still collected
// ---------------------------------------------------------------------------

describe('pi-experiment-ne2w AC2/AC4: no short-circuit — all evidence collected', () => {
  it('LOAD-BEARING: allOf with failing first check still records later checks evidence', async () => {
    const { store } = makeTestStore();

    // First check fails; second check passes. allOf outcome = fail.
    // But BOTH checks' evidence must be in the emitted event (AC4: no short-circuit).
    const checkResults: V2GateCheckResult[] = [
      { checkId: 'run_quality_checks', verdict: 'fail', eventName: 'QUALITY_FAILED', evidenceRefs: [EVIDENCE_A] },
      { checkId: 'pytest', verdict: 'pass', eventName: 'QUALITY_PASSED', evidenceRefs: [EVIDENCE_B] },
    ];

    const result = await evaluateV2Gate(ALLOF_GATE_CONFIG, checkResults, makeEmitOptions(store));

    // The gate fails (allOf with one fail).
    expect(result.verdict).toBe('fail');

    // CRITICAL: EVIDENCE_B (from non-deciding passing check) is still in allEvidence.
    expect(result.allEvidence).toHaveLength(2);
    expect(result.allEvidence.some(e => e.semanticPath === EVIDENCE_A.semanticPath)).toBe(true);
    expect(result.allEvidence.some(e => e.semanticPath === EVIDENCE_B.semanticPath)).toBe(true);

    // The emitted route event payload includes all evidence refs.
    // (Verified via routeEventResult.emitted === true; applyV2RouteEvent embeds evidenceRefs.)
    expect(result.routeEventResult.emitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC1 (LOAD-BEARING): anyOf — one check passes
// ---------------------------------------------------------------------------

describe('pi-experiment-ne2w AC1: anyOf gate — one check passes', () => {
  it('LOAD-BEARING: anyOf one-pass → GATE_PASSED route event emitted once', async () => {
    const { store, recorded } = makeTestStore();

    // First check fails, second passes.
    const checkResults: V2GateCheckResult[] = [
      { checkId: 'run_quality_checks', verdict: 'fail', eventName: 'QUALITY_FAILED', evidenceRefs: [EVIDENCE_A] },
      { checkId: 'pytest', verdict: 'pass', eventName: 'QUALITY_PASSED', evidenceRefs: [EVIDENCE_B] },
    ];

    const result = await evaluateV2Gate(ANYOF_GATE_CONFIG, checkResults, makeEmitOptions(store));

    expect(recorded.filter(r => r.type === DomainEventName.ROUTE_EVENT_EMITTED)).toHaveLength(1);
    expect(result.verdict).toBe('pass');
    expect(result.eventName).toBe('GATE_PASSED');

    // All evidence still recorded (AC4).
    expect(result.allEvidence).toHaveLength(2);
    expect(result.routeEventResult.emitted).toBe(true);
  });

  it('LOAD-BEARING: anyOf all-fail → QUALITY_FAILED chosen by failPrecedence', async () => {
    const { store, recorded } = makeTestStore();

    const checkResults: V2GateCheckResult[] = [
      { checkId: 'run_quality_checks', verdict: 'fail', eventName: 'QUALITY_FAILED', evidenceRefs: [EVIDENCE_A] },
      { checkId: 'pytest', verdict: 'fail', eventName: 'TESTS_FAILED', evidenceRefs: [EVIDENCE_B] },
    ];

    const result = await evaluateV2Gate(ANYOF_GATE_CONFIG, checkResults, makeEmitOptions(store));

    expect(recorded.filter(r => r.type === DomainEventName.ROUTE_EVENT_EMITTED)).toHaveLength(1);
    expect(result.verdict).toBe('fail');
    expect(result.eventName).toBe('QUALITY_FAILED'); // first in failPrecedence
    expect(result.allEvidence).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC1 (LOAD-BEARING): blocked takes precedence over failure
// ---------------------------------------------------------------------------

describe('pi-experiment-ne2w AC1: blocked > failure precedence', () => {
  it('LOAD-BEARING: anyOf with one blocked + one failed → blocked event wins over failure', async () => {
    const { store, recorded } = makeTestStore();

    // One check blocked, one check failed. No passing check.
    // Blocked takes precedence over failure.
    const checkResults: V2GateCheckResult[] = [
      { checkId: 'run_quality_checks', verdict: 'blocked', eventName: 'QUALITY_BLOCKED', evidenceRefs: [EVIDENCE_A] },
      { checkId: 'pytest', verdict: 'fail', eventName: 'TESTS_FAILED', evidenceRefs: [EVIDENCE_B] },
    ];

    const result = await evaluateV2Gate(ANYOF_GATE_CONFIG, checkResults, makeEmitOptions(store));

    expect(recorded.filter(r => r.type === DomainEventName.ROUTE_EVENT_EMITTED)).toHaveLength(1);
    // Blocked takes precedence over failure (AC1 semantics).
    expect(result.verdict).toBe('blocked');
    expect(result.eventName).toBe('QUALITY_BLOCKED');
    expect(result.allEvidence).toHaveLength(2);
    expect(result.routeEventResult.emitted).toBe(true);
  });

  it('LOAD-BEARING: allOf with one blocked + one failed → blocked event wins over failure', async () => {
    const { store, recorded } = makeTestStore();

    const checkResults: V2GateCheckResult[] = [
      { checkId: 'run_quality_checks', verdict: 'blocked', eventName: 'QUALITY_BLOCKED', evidenceRefs: [EVIDENCE_A] },
      { checkId: 'pytest', verdict: 'fail', eventName: 'TESTS_FAILED', evidenceRefs: [EVIDENCE_B] },
    ];

    const result = await evaluateV2Gate(ALLOF_GATE_CONFIG, checkResults, makeEmitOptions(store));

    expect(recorded.filter(r => r.type === DomainEventName.ROUTE_EVENT_EMITTED)).toHaveLength(1);
    expect(result.verdict).toBe('blocked');
    expect(result.eventName).toBe('QUALITY_BLOCKED');
    expect(result.allEvidence).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC3 (LOAD-BEARING): blockPrecedence ordering
// ---------------------------------------------------------------------------

describe('pi-experiment-ne2w AC3: blocked precedence ordering', () => {
  it('LOAD-BEARING: anyOf all-blocked → blockPrecedence determines winner (QUALITY_BLOCKED over TESTS_BLOCKED)', async () => {
    const { store, recorded } = makeTestStore();

    const checkResults: V2GateCheckResult[] = [
      { checkId: 'run_quality_checks', verdict: 'blocked', eventName: 'QUALITY_BLOCKED', evidenceRefs: [EVIDENCE_A] },
      { checkId: 'pytest', verdict: 'blocked', eventName: 'TESTS_BLOCKED', evidenceRefs: [EVIDENCE_B] },
    ];

    const result = await evaluateV2Gate(ANYOF_GATE_CONFIG, checkResults, makeEmitOptions(store));

    expect(recorded.filter(r => r.type === DomainEventName.ROUTE_EVENT_EMITTED)).toHaveLength(1);
    expect(result.verdict).toBe('blocked');
    // QUALITY_BLOCKED is first in blockPrecedence → wins.
    expect(result.eventName).toBe('QUALITY_BLOCKED');
    expect(result.allEvidence).toHaveLength(2);
  });

  it('blockPrecedence reversed: TESTS_BLOCKED wins when it is first in blockPrecedence', async () => {
    const { store } = makeTestStore();

    const reversedBlockGate: V2GateConfig = {
      ...ALLOF_GATE_CONFIG,
      id: 'reversed-block-gate',
      blockPrecedence: ['TESTS_BLOCKED', 'QUALITY_BLOCKED'], // reversed order
    };

    const checkResults: V2GateCheckResult[] = [
      { checkId: 'run_quality_checks', verdict: 'blocked', eventName: 'QUALITY_BLOCKED', evidenceRefs: [EVIDENCE_A] },
      { checkId: 'pytest', verdict: 'blocked', eventName: 'TESTS_BLOCKED', evidenceRefs: [EVIDENCE_B] },
    ];

    const result = await evaluateV2Gate(reversedBlockGate, checkResults, makeEmitOptions(store));

    expect(result.verdict).toBe('blocked');
    // TESTS_BLOCKED is now first → wins.
    expect(result.eventName).toBe('TESTS_BLOCKED');
  });
});

// ---------------------------------------------------------------------------
// AC2 (LOAD-BEARING): exactly one route event emitted
// ---------------------------------------------------------------------------

describe('pi-experiment-ne2w AC2: exactly one route event emitted', () => {
  it('LOAD-BEARING: gate emits exactly one ROUTE_EVENT_EMITTED regardless of check count', async () => {
    const { store, recorded } = makeTestStore();

    // Three checks all passing.
    const threeCheckGate: V2GateConfig = {
      id: 'three-check-gate',
      operator: 'allOf',
      checks: [
        { checkId: 'check_a', passEvent: 'QUALITY_PASSED', failEvent: 'QUALITY_FAILED' },
        { checkId: 'check_b', passEvent: 'QUALITY_PASSED', failEvent: 'QUALITY_FAILED' },
        { checkId: 'check_c', passEvent: 'QUALITY_PASSED', failEvent: 'QUALITY_FAILED' },
      ],
      passEvent: 'GATE_PASSED',
    };

    const checkResults: V2GateCheckResult[] = [
      { checkId: 'check_a', verdict: 'pass', eventName: 'QUALITY_PASSED', evidenceRefs: [EVIDENCE_A] },
      { checkId: 'check_b', verdict: 'pass', eventName: 'QUALITY_PASSED', evidenceRefs: [EVIDENCE_B] },
      { checkId: 'check_c', verdict: 'pass', eventName: 'QUALITY_PASSED', evidenceRefs: [] },
    ];

    const result = await evaluateV2Gate(threeCheckGate, checkResults, makeEmitOptions(store));

    // LOAD-BEARING: exactly one ROUTE_EVENT_EMITTED (not one per check).
    const routeEvents = recorded.filter(r => r.type === DomainEventName.ROUTE_EVENT_EMITTED);
    expect(routeEvents).toHaveLength(1);
    expect(result.verdict).toBe('pass');
    expect(result.eventName).toBe('GATE_PASSED');
    // All three checks' evidence aggregated.
    expect(result.allEvidence).toHaveLength(2); // A + B (C has empty refs)
  });
});

// ---------------------------------------------------------------------------
// AC3 (LOAD-BEARING): ConfigLoader startup ambiguity rejection
// ---------------------------------------------------------------------------

describe('pi-experiment-ne2w AC3: ConfigLoader ambiguity rejection at startup', () => {
  /**
   * Minimal v2 YAML with a gate block. Allows injecting a custom gates block.
   */
  function minimalV2WithGates(gatesBlock: string): string {
    return `
version: 2
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initial: implement
  terminal: [completed]
events:
  advance: [GATE_PASSED]
  failure: [QUALITY_FAILED, TESTS_FAILED]
  blocked: [QUALITY_BLOCKED, TESTS_BLOCKED]
  neutral: []
states:
  implement:
    identity: { role: "Implementer", expertise: "Coding", constraints: [] }
    baseInstructions: "Implement the task."
    actions:
      plan:
        type: prompt
        prompt: "Plan."
    transitions:
      GATE_PASSED: completed
      QUALITY_FAILED: implement
      TESTS_FAILED: implement
      QUALITY_BLOCKED: implement
      TESTS_BLOCKED: implement
${gatesBlock}
`;
  }

  it('LOAD-BEARING: gate with two fail events and missing failPrecedence → startup fails as ambiguous', () => {
    const yamlPath = writeYaml('ambiguous_gate.yaml', minimalV2WithGates(`
validationGates:
  implementation-quality:
    operator: allOf
    checks:
      - checkId: run_quality_checks
        passEvent: GATE_PASSED
        failEvent: QUALITY_FAILED
      - checkId: pytest
        passEvent: GATE_PASSED
        failEvent: TESTS_FAILED
    passEvent: GATE_PASSED
    # failPrecedence is MISSING — two distinct failure events → ambiguous
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).toThrow(/failPrecedence/);
  });

  it('LOAD-BEARING: gate with two fail events and duplicate in failPrecedence → startup fails', () => {
    const yamlPath = writeYaml('dup_prec_gate.yaml', minimalV2WithGates(`
validationGates:
  implementation-quality:
    operator: allOf
    checks:
      - checkId: run_quality_checks
        passEvent: GATE_PASSED
        failEvent: QUALITY_FAILED
      - checkId: pytest
        passEvent: GATE_PASSED
        failEvent: TESTS_FAILED
    passEvent: GATE_PASSED
    failPrecedence: [QUALITY_FAILED, QUALITY_FAILED]
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).toThrow(/QUALITY_FAILED/);
  });

  it('LOAD-BEARING: gate with two fail events and incomplete failPrecedence (missing one) → startup fails', () => {
    const yamlPath = writeYaml('incomplete_prec_gate.yaml', minimalV2WithGates(`
validationGates:
  implementation-quality:
    operator: allOf
    checks:
      - checkId: run_quality_checks
        passEvent: GATE_PASSED
        failEvent: QUALITY_FAILED
      - checkId: pytest
        passEvent: GATE_PASSED
        failEvent: TESTS_FAILED
    passEvent: GATE_PASSED
    failPrecedence: [QUALITY_FAILED]
    # TESTS_FAILED is missing from failPrecedence → ambiguous
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).toThrow(/TESTS_FAILED/);
  });

  it('gate with only one distinct failure event and no failPrecedence → valid (unambiguous)', () => {
    const yamlPath = writeYaml('unambiguous_gate.yaml', minimalV2WithGates(`
validationGates:
  implementation-quality:
    operator: allOf
    checks:
      - checkId: run_quality_checks
        passEvent: GATE_PASSED
        failEvent: QUALITY_FAILED
      - checkId: pytest
        passEvent: GATE_PASSED
        failEvent: QUALITY_FAILED
    passEvent: GATE_PASSED
    # No failPrecedence needed: both checks emit the same failure event
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    // Should not throw — single distinct failure event is unambiguous.
    expect(() => loader.load(yamlPath)).not.toThrow();
  });

  it('LOAD-BEARING: gate with two blocked events and missing blockPrecedence → startup fails as ambiguous', () => {
    const yamlPath = writeYaml('ambiguous_block_gate.yaml', minimalV2WithGates(`
validationGates:
  implementation-quality:
    operator: anyOf
    checks:
      - checkId: run_quality_checks
        passEvent: GATE_PASSED
        failEvent: QUALITY_FAILED
        blockedEvent: QUALITY_BLOCKED
      - checkId: pytest
        passEvent: GATE_PASSED
        failEvent: QUALITY_FAILED
        blockedEvent: TESTS_BLOCKED
    passEvent: GATE_PASSED
    # blockPrecedence is MISSING — two distinct blocked events → ambiguous
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).toThrow(/blockPrecedence/);
  });

  it('LOAD-BEARING: gate with unsupported operator (noneOf) → startup fails', () => {
    const yamlPath = writeYaml('noneof_gate.yaml', minimalV2WithGates(`
validationGates:
  implementation-quality:
    operator: noneOf
    checks:
      - checkId: run_quality_checks
        passEvent: GATE_PASSED
        failEvent: QUALITY_FAILED
    passEvent: GATE_PASSED
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).toThrow(/noneOf/);
  });

  it('gate with operator but missing checks array → startup fails', () => {
    const yamlPath = writeYaml('no_checks_gate.yaml', minimalV2WithGates(`
validationGates:
  implementation-quality:
    operator: allOf
    passEvent: GATE_PASSED
    # checks array is MISSING
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).toThrow(/checks/);
  });

  it('gate with operator but missing passEvent → startup fails', () => {
    const yamlPath = writeYaml('no_pass_event_gate.yaml', minimalV2WithGates(`
validationGates:
  implementation-quality:
    operator: allOf
    checks:
      - checkId: run_quality_checks
        passEvent: GATE_PASSED
        failEvent: QUALITY_FAILED
    # passEvent is MISSING
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).toThrow(/passEvent/);
  });

  it('valid v2 gate with complete precedence lists → ConfigLoader admits it', () => {
    const yamlPath = writeYaml('valid_complete_gate.yaml', minimalV2WithGates(`
validationGates:
  implementation-quality:
    operator: allOf
    checks:
      - checkId: run_quality_checks
        passEvent: GATE_PASSED
        failEvent: QUALITY_FAILED
        blockedEvent: QUALITY_BLOCKED
      - checkId: pytest
        passEvent: GATE_PASSED
        failEvent: TESTS_FAILED
        blockedEvent: TESTS_BLOCKED
    passEvent: GATE_PASSED
    failPrecedence: [QUALITY_FAILED, TESTS_FAILED]
    blockPrecedence: [QUALITY_BLOCKED, TESTS_BLOCKED]
`));

    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).not.toThrow();
    const config = loader.load(yamlPath);
    const gate = config.validationGates?.find(g => g.id === 'implementation-quality');
    expect(gate).toBeDefined();
    expect((gate as unknown as Record<string, unknown>)['operator']).toBe('allOf');
  });

  it('v1 config with array-form gates (no operator) → v2 gate validation is skipped (version-gated)', () => {
    // v1 configs use old-form gates and must not be rejected by the v2 gate validator.
    const v1Yaml = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
validationGates:
  - id: review-gate
    states: [Planning]
    required: false
states:
  Planning:
    identity: { role: "Planner", expertise: "Planning", constraints: [] }
    baseInstructions: "Plan."
    actions:
      - id: plan
        type: prompt
        prompt: "Plan."
    transitions:
      SUCCESS: completed
      FAILURE: Planning
`;
    const yamlPath = writeYaml('v1_gate.yaml', v1Yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    // v1 gate (array form) should load without error.
    expect(() => loader.load(yamlPath)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC4 (LOAD-BEARING): route-event schema validity
// ---------------------------------------------------------------------------

describe('pi-experiment-ne2w AC4: route-event schema validity', () => {
  it('LOAD-BEARING: emitted event payload has all required ROUTE_EVENT_EMITTED fields', async () => {
    const { store, recorded } = makeTestStore();

    const checkResults: V2GateCheckResult[] = [
      { checkId: 'run_quality_checks', verdict: 'pass', eventName: 'QUALITY_PASSED', evidenceRefs: [EVIDENCE_A] },
      { checkId: 'pytest', verdict: 'pass', eventName: 'QUALITY_PASSED', evidenceRefs: [EVIDENCE_B] },
    ];

    await evaluateV2Gate(ALLOF_GATE_CONFIG, checkResults, makeEmitOptions(store));

    const routeEvent = recorded.find(r => r.type === DomainEventName.ROUTE_EVENT_EMITTED);
    expect(routeEvent).toBeDefined();
    const payload = routeEvent!.data as Record<string, unknown>;

    // Required fields (from ROUTE_EVENT_EMITTED_JSON_SCHEMA).
    expect(payload['schemaId']).toBe('harness.event.routeEventEmitted');
    expect(payload['schemaVersion']).toBe('1.0.0');
    expect(payload['configVersion']).toBe(2);
    expect(payload['configFingerprint']).toBe(TEST_FINGERPRINT);
    expect(payload['beadId']).toBe('test-bead-1');
    expect(payload['stateId']).toBe('implement');
    expect(payload['actionId']).toBe('quality-gate');
    expect(payload['runId']).toBe('test-run-1');
    expect(payload['emitterType']).toBe('gate');
    expect(payload['emitterId']).toBe('implementation-quality'); // gate id
    expect(payload['eventName']).toBe('GATE_PASSED');
    expect(payload['category']).toBe('advance');

    // Evidence refs include ALL check refs (AC4).
    const evidenceRefs = payload['evidenceRefs'] as RouteEvidenceRef[];
    expect(evidenceRefs).toHaveLength(2);
    expect(evidenceRefs[0]).toEqual(EVIDENCE_A);
    expect(evidenceRefs[1]).toEqual(EVIDENCE_B);

    // routeEventId is present (uuidv7).
    expect(typeof payload['routeEventId']).toBe('string');
    expect((payload['routeEventId'] as string).length).toBeGreaterThan(0);
  });

  it('LOAD-BEARING: failed gate event payload has failure category', async () => {
    const { store, recorded } = makeTestStore();

    const checkResults: V2GateCheckResult[] = [
      { checkId: 'run_quality_checks', verdict: 'fail', eventName: 'QUALITY_FAILED', evidenceRefs: [EVIDENCE_A] },
      { checkId: 'pytest', verdict: 'fail', eventName: 'TESTS_FAILED', evidenceRefs: [EVIDENCE_B] },
    ];

    await evaluateV2Gate(ALLOF_GATE_CONFIG, checkResults, makeEmitOptions(store));

    const routeEvent = recorded.find(r => r.type === DomainEventName.ROUTE_EVENT_EMITTED);
    const payload = routeEvent!.data as Record<string, unknown>;
    expect(payload['category']).toBe('failure');
    expect(payload['eventName']).toBe('QUALITY_FAILED');

    // Both checks' evidence in payload (non-deciding TESTS_FAILED evidence included).
    const evidenceRefs = payload['evidenceRefs'] as RouteEvidenceRef[];
    expect(evidenceRefs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC1 (LOAD-BEARING): version-gated — v1 config unaffected
// ---------------------------------------------------------------------------

describe('pi-experiment-ne2w AC1: version-gating — v1/cerdiwen unaffected', () => {
  it('v1 config loads without v2 gate validation running (no operator field required)', () => {
    // This is the cerdiwen-style v1 gate format: plain gate with states selector.
    // The v2 gate validator must not run on v1 configs.
    const v1Yaml = `
settings:
  startState: Planning
  worktreePolicy:
    default: always
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
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
      - id: plan
        type: prompt
        prompt: "Plan."
    transitions:
      SUCCESS: completed
      FAILURE: Planning
`;
    const yamlPath = writeYaml('v1_only.yaml', v1Yaml);
    const loader = new ConfigLoader(undefined, TEST_DIR);
    expect(() => loader.load(yamlPath)).not.toThrow();
  });
});
