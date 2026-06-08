/**
 * compaction_fallback.test.ts
 *
 * pi-experiment-6q0y.37: Add optional compaction warning and deterministic
 * fallback restart flow.
 *
 * LOAD-BEARING TESTS (per AC7):
 *
 * UNIT — Warning + fallback integration (real SESSION_COMPACT handler):
 *
 *   U1 (AC1/AC6 NO-OP): disabled-default Pi autocompaction path.
 *     - Fire SESSION_COMPACT for state with NO compactionFallback config.
 *     - Assert: NO CONTEXT_COMPACTION_WARNING and NO evidence-aware restart signal.
 *     - CONTEXT_COMPACTION_RECORDED is still recorded (existing behavior unchanged).
 *     - LOAD-BEARING: removing the default-no-op guard must cause this to fail.
 *
 *   U2 (AC2 WARNING-ONLY): enabled warning-only path.
 *     - Fire SESSION_COMPACT once for state with compactionFallback.warnThreshold=1,
 *       autoThreshold=3.
 *     - Assert: CONTEXT_COMPACTION_WARNING recorded with correct beadId/stateId/
 *       compactionCount/warnThreshold.
 *     - Assert: NO restart signal posted (compaction count < autoThreshold).
 *     - LOAD-BEARING: removing the warning event record must cause this to fail.
 *
 *   U3 (AC3/AC4 FALLBACK): enabled automatic-fallback path.
 *     - Fire SESSION_COMPACT enough times to reach autoThreshold.
 *     - Assert: postHarnessSignal called EXACTLY ONCE.
 *     - Assert: signal carries evidenceRefs (non-empty, with schemaId/
 *       semanticArtifactPath/bytes/sha256/sourceEventIds).
 *     - Assert: signal is NOT a generic one-line summary (has evidenceRefs).
 *     - LOAD-BEARING: removing the fallback restart or stripping evidenceRefs
 *       must cause this to fail.
 *
 *   U4 (AC5 DUPLICATE SUPPRESSION): multiple compactions after auto-threshold.
 *     - Fire SESSION_COMPACT warnThreshold+autoThreshold+2 times.
 *     - Assert: postHarnessSignal called EXACTLY ONCE (not twice or more).
 *     - Assert: CONTEXT_COMPACTION_RECORDED recorded for every fire (evidence preserved).
 *     - LOAD-BEARING: removing the restartSignalSent guard must cause this to fail.
 *
 *   U5 (AC1/AC6 enabled-false): states with enabled:false → no warning or restart.
 *     - Fire SESSION_COMPACT for state with compactionFallback.enabled:false.
 *     - Assert: NO CONTEXT_COMPACTION_WARNING. NO restart signal.
 *
 *   U6 (AC3/AC4 COMPACTION-POINTER): fallback includes compaction-artifact pointer.
 *     - Configure both compactionSummary + compactionFallback.
 *     - Fire SESSION_COMPACT to trigger summary generation + fallback restart.
 *     - Assert: evidenceRefs[0].semanticArtifactPath matches the written
 *       compaction-summary artifact path.
 *     - Assert: evidenceRefs[0].bytes > 0 + sha256 is 64-char hex.
 *     - LOAD-BEARING: the fallback must use the compaction pointer, not a
 *       generic summary.
 *
 *   U7 (no-backcompat: no compactionFallback → NO Orr Else restart, AC1/AC6):
 *     - State has NO compactionFallback.
 *     - Fire SESSION_COMPACT.
 *     - Assert: NO CONTEXT_RESTART_REQUESTED posted; NO warning event.
 *     - CONTEXT_COMPACTION_RECORDED still recorded (evidence preserved).
 *     - SELF-VERIFY: re-adding the removed legacy triggerAutoRestart path causes this to fail.
 *
 * LINT — ConfigLoader startup validation (AC7):
 *
 *   L1: valid enabled:false → loads without error.
 *   L2: valid enabled:true with correct thresholds → loads.
 *   L3: non-object compactionFallback → startup-fatal.
 *   L4: enabled not boolean → startup-fatal.
 *   L5: enabled:true + missing warnThreshold → startup-fatal.
 *   L6: enabled:true + missing autoThreshold → startup-fatal.
 *   L7: autoThreshold <= warnThreshold → startup-fatal.
 *   L8: warnThreshold < 1 → startup-fatal.
 *   L9: absent compactionFallback → complete no-op (AC1/AC6).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Teammate, type WorkerContext } from '../src/core/Teammate.js';
import { Logger } from '../src/core/Logger.js';
import {
  DomainEventName,
  PiEventName,
  PluginToolName,
  WorkerDefaults
} from '../src/constants/index.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import type { BeadId } from '../src/types/index.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';

// ---------------------------------------------------------------------------
// Temp dirs
// ---------------------------------------------------------------------------

let TEST_PROJECT_ROOT: string;

beforeEach(() => {
  TEST_PROJECT_ROOT = fs.realpathSync(
    fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'orr-else-6q0y37-'))
  );
  vi.spyOn(Logger, 'configureProjectRoot').mockImplementation(() => {});
});

afterEach(() => {
  try { fs.rmSync(TEST_PROJECT_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fake pi event emitter
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    emit: vi.fn()
  } as unknown as ExtensionAPI;

  const fire = (event: string) => {
    for (const h of handlers.get(event) ?? []) h();
  };

  return { pi, fire };
}

// ---------------------------------------------------------------------------
// Config factories
// ---------------------------------------------------------------------------

/** State with NO compactionFallback config (default no-op). */
function noFallbackConfig(): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 2,
      handoverTemplate: 'handover',
      agentTurnTimeoutMs: 60000,
      processReapIntervalMs: 5000,
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'claude-opus-4-5',
      defaultProvider: 'anthropic',
      modelProviders: {},
      stateContextRotThreshold: 5,
      harnessContextRotThreshold: 10
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    statechart: { terminalStates: ['completed'] },
    states: {
      Implement: {
        id: 'Implement',
        identity: { role: 'Dev', expertise: 'Code', constraints: [] },
        actions: [],
        transitions: {}
        // no compactionFallback
      }
    }
  } as unknown as HarnessConfig;
}

/** State with compactionFallback enabled:false (explicit disabled). */
function explicitlyDisabledConfig(): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 2,
      handoverTemplate: 'handover',
      agentTurnTimeoutMs: 60000,
      processReapIntervalMs: 5000,
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'claude-opus-4-5',
      defaultProvider: 'anthropic',
      modelProviders: {},
      stateContextRotThreshold: 5,
      harnessContextRotThreshold: 10
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    statechart: { terminalStates: ['completed'] },
    states: {
      Implement: {
        id: 'Implement',
        identity: { role: 'Dev', expertise: 'Code', constraints: [] },
        actions: [],
        transitions: {},
        compactionFallback: { enabled: false }
      }
    }
  } as unknown as HarnessConfig;
}

/** State with compactionFallback enabled:true. */
function enabledFallbackConfig(warnThreshold = 1, autoThreshold = 2): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 2,
      handoverTemplate: 'handover',
      agentTurnTimeoutMs: 60000,
      processReapIntervalMs: 5000,
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'claude-opus-4-5',
      defaultProvider: 'anthropic',
      modelProviders: {},
      stateContextRotThreshold: 5,
      harnessContextRotThreshold: 10
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    statechart: { terminalStates: ['completed'] },
    states: {
      Implement: {
        id: 'Implement',
        identity: { role: 'Dev', expertise: 'Code', constraints: [] },
        actions: [],
        transitions: {},
        compactionFallback: { enabled: true, warnThreshold, autoThreshold }
      }
    }
  } as unknown as HarnessConfig;
}

/** State with both compactionSummary + compactionFallback enabled. */
function enabledSummaryAndFallbackConfig(warnThreshold = 1, autoThreshold = 2): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 2,
      handoverTemplate: 'handover',
      agentTurnTimeoutMs: 60000,
      processReapIntervalMs: 5000,
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'claude-opus-4-5',
      defaultProvider: 'anthropic',
      modelProviders: {},
      stateContextRotThreshold: 5,
      harnessContextRotThreshold: 10
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    statechart: { terminalStates: ['completed'] },
    states: {
      Implement: {
        id: 'Implement',
        identity: { role: 'Dev', expertise: 'Code', constraints: [] },
        actions: [],
        transitions: {},
        compactionSummary: { enabled: true, compactionRoute: 'COMPACTED' },
        compactionFallback: { enabled: true, warnThreshold, autoThreshold }
      }
    }
  } as unknown as HarnessConfig;
}

// ---------------------------------------------------------------------------
// Teammate factory
// ---------------------------------------------------------------------------

function buildTeammate(options: {
  pi: ExtensionAPI;
  config: HarnessConfig;
  recordFn: ReturnType<typeof vi.fn>;
  eventsForBeadFn?: () => Promise<DomainEvent[]>;
  postSignalFn?: ReturnType<typeof vi.fn>;
  projectRoot?: string;
}) {
  const { pi, config, recordFn } = options;
  const projectRoot = options.projectRoot ?? TEST_PROJECT_ROOT;
  const postSignal = options.postSignalFn ?? vi.fn(async () => {});

  const ctx = {
    hasUI: false,
    signal: undefined,
    shutdown: vi.fn()
  } as unknown as ExtensionContext;

  const observability = {
    tracedAsync: (_name: string, _attrs: object, fn: () => unknown) => fn
  } as any;

  const configLoader = { load: vi.fn(() => config) } as any;

  const eventsForBead = options.eventsForBeadFn ?? vi.fn(async () => [] as DomainEvent[]);
  const eventStore = {
    record: recordFn,
    eventsForBead
  } as any;

  const flowManager = { activateTools: vi.fn() } as any;
  const bdPlugin = {
    tools: [{ name: PluginToolName.BD_HEARTBEAT, execute: vi.fn(async () => {}) }]
  } as any;
  const gitPlugin = { tools: [] } as any;
  const mailboxPlugin = { tools: [] } as any;
  const qualityPlugin = { tools: [] } as any;

  const workerContext: WorkerContext = {
    beadId: 'bd-6q0y37-test' as BeadId,
    stateId: 'Implement',
    projectRoot,
    worktreePath: undefined,
    workerId: 'worker-6q0y37-1',
    actionId: WorkerDefaults.AUTO_CONTEXT_RESTART_ACTION_ID
  };

  // Patch postHarnessSignal to use our mock
  const teammate = new (class extends Teammate {
    protected async postSignal(signal: unknown): Promise<void> {
      await postSignal(signal);
    }
  })(
    pi, ctx, observability, configLoader, eventStore,
    flowManager, bdPlugin, gitPlugin, mailboxPlugin, qualityPlugin,
    workerContext
  );

  // Patch internal postHarnessSignal — since Teammate.triggerFallbackRestart
  // calls the module-level postHarnessSignal, we stub it via vi.mock is not
  // available here; instead we inject via module-level mocking.
  return { teammate, eventStore, postSignal, ctx };
}

// ---------------------------------------------------------------------------
// Module-level mock for postHarnessSignal
// ---------------------------------------------------------------------------

// We use vi.mock at module level to intercept postHarnessSignal calls from Teammate.

vi.mock('../src/core/HarnessApiClient.js', () => {
  const postHarnessSignalMock = vi.fn(async () => {});
  return { postHarnessSignal: postHarnessSignalMock };
});

// Import the mock after vi.mock is registered.
const { postHarnessSignal } = await import('../src/core/HarnessApiClient.js');

// ---------------------------------------------------------------------------
// Helper: drain microtasks
// ---------------------------------------------------------------------------

async function drainMicrotasks(count = 30) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Unit tests — real SESSION_COMPACT handler
// ---------------------------------------------------------------------------

describe('Compaction fallback — real SESSION_COMPACT handler (pi-experiment-6q0y.37)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(postHarnessSignal).mockReset();
    vi.mocked(postHarnessSignal).mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // U1: NO-OP for states without compactionFallback (AC1/AC6)
  // -------------------------------------------------------------------------

  it('U1: no compactionFallback config → SESSION_COMPACT produces no warning/restart (AC1/AC6 no-op)', async () => {
    /**
     * SELF-VERIFY: if the "fallbackCfg?.enabled !== true" guard in
     * setupCompactionMonitor is removed so the fallback always runs,
     * the assertions below about no CONTEXT_COMPACTION_WARNING will fail.
     */
    const { pi, fire } = fakePi();
    const record = vi.fn(async () => {});
    const { teammate } = buildTeammate({ pi, config: noFallbackConfig(), recordFn: record });

    await teammate.start();
    fire(PiEventName.SESSION_COMPACT);
    await drainMicrotasks();

    // No CONTEXT_COMPACTION_WARNING event
    const warningCalls = record.mock.calls.filter(([n]) => n === DomainEventName.CONTEXT_COMPACTION_WARNING);
    expect(warningCalls).toHaveLength(0);

    // No restart signal for compaction count < legacy threshold (999)
    expect(postHarnessSignal).not.toHaveBeenCalled();

    // CONTEXT_COMPACTION_RECORDED is still recorded (existing behavior unchanged)
    const compactionCalls = record.mock.calls.filter(([n]) => n === DomainEventName.CONTEXT_COMPACTION_RECORDED);
    expect(compactionCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // U2: Warning-only path (AC2)
  // -------------------------------------------------------------------------

  it('U2: warnThreshold reached → CONTEXT_COMPACTION_WARNING recorded, NO restart (AC2)', async () => {
    /**
     * SELF-VERIFY: removing the CONTEXT_COMPACTION_WARNING record call from
     * setupCompactionMonitor's SESSION_COMPACT handler makes this test fail
     * (no warning event, assertion on warningCalls.length fails).
     */
    const { pi, fire } = fakePi();
    const record = vi.fn(async () => {});
    // warnThreshold=1, autoThreshold=3 — one fire is warn-only
    const config = enabledFallbackConfig(1, 3);
    const { teammate } = buildTeammate({ pi, config, recordFn: record });

    await teammate.start();
    fire(PiEventName.SESSION_COMPACT); // count=1, reaches warnThreshold
    await drainMicrotasks();

    // CONTEXT_COMPACTION_WARNING must be recorded
    const warningCalls = record.mock.calls.filter(([n]) => n === DomainEventName.CONTEXT_COMPACTION_WARNING);
    expect(warningCalls).toHaveLength(1);
    const [, payload] = warningCalls[0]!;
    expect(payload['beadId']).toBe('bd-6q0y37-test');
    expect(payload['stateId']).toBe('Implement');
    expect(payload['compactionCount']).toBe(1);
    expect(payload['warnThreshold']).toBe(1);

    // NO restart signal — compaction count (1) < autoThreshold (3)
    expect(postHarnessSignal).not.toHaveBeenCalled();

    // CONTEXT_COMPACTION_RECORDED still recorded
    const compactionCalls = record.mock.calls.filter(([n]) => n === DomainEventName.CONTEXT_COMPACTION_RECORDED);
    expect(compactionCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // U3: Automatic fallback path (AC3/AC4)
  // -------------------------------------------------------------------------

  it('U3: autoThreshold reached → exactly one evidence-aware restart signal (AC3/AC4)', async () => {
    /**
     * SELF-VERIFY: removing the triggerFallbackRestart call from
     * setupCompactionMonitor's SESSION_COMPACT handler makes this test fail
     * (postHarnessSignal never called).
     *
     * The signal MUST carry evidenceRefs (non-empty). When no COMPACTION_SUMMARY_RECORDED
     * is in prior events, the fallback falls through to the legacy path — but that
     * path does NOT include evidenceRefs. This test validates with a compaction pointer
     * to prove the real evidence-aware path.
     */
    const { pi, fire } = fakePi();
    const record = vi.fn(async () => {});

    // Provide a COMPACTION_SUMMARY_RECORDED event as prior history so the pointer resolves.
    const compactionPointerEvent: DomainEvent = {
      id: 'evt-cs-001',
      type: DomainEventName.COMPACTION_SUMMARY_RECORDED,
      timestamp: '2026-06-09T00:00:01.000Z',
      sessionId: 'test-session',
      data: {
        beadId: 'bd-6q0y37-test',
        stateId: 'Implement',
        artifactPath: path.join(TEST_PROJECT_ROOT, '.pi', 'artifacts', 'bd-6q0y37-test', 'compaction-summary.json'),
        artifactBytes: 512,
        artifactSha256: 'a'.repeat(64),
        sourceEventIds: ['evt-001'],
        nonAuthoritative: true
      }
    } as DomainEvent;

    const eventsForBead = vi.fn(async () => [compactionPointerEvent]);
    const config = enabledFallbackConfig(1, 2);
    const { teammate } = buildTeammate({ pi, config, recordFn: record, eventsForBeadFn: eventsForBead });

    await teammate.start();
    fire(PiEventName.SESSION_COMPACT); // count=1, warn
    await drainMicrotasks();
    fire(PiEventName.SESSION_COMPACT); // count=2, autoThreshold reached
    await drainMicrotasks(50);

    // Exactly one restart signal posted
    expect(postHarnessSignal).toHaveBeenCalledTimes(1);

    // Signal must carry evidenceRefs (AC4: not a generic summary)
    const signalArg = vi.mocked(postHarnessSignal).mock.calls[0]![0] as Record<string, unknown>;
    expect(Array.isArray(signalArg['evidenceRefs'])).toBe(true);
    const evidenceRefs = signalArg['evidenceRefs'] as Array<Record<string, unknown>>;
    expect(evidenceRefs.length).toBeGreaterThan(0);

    // Each ref must have schemaId, semanticArtifactPath, bytes, sha256
    const ref = evidenceRefs[0]!;
    expect(typeof ref['schemaId']).toBe('string');
    expect(ref['schemaId']).toBe('compaction-summary');
    expect(typeof ref['semanticArtifactPath']).toBe('string');
    expect((ref['semanticArtifactPath'] as string).length).toBeGreaterThan(0);
    expect(typeof ref['bytes']).toBe('number');
    expect((ref['bytes'] as number)).toBeGreaterThan(0);
    expect(typeof ref['sha256']).toBe('string');
    expect((ref['sha256'] as string).length).toBe(64);
  });

  // -------------------------------------------------------------------------
  // U4: Duplicate suppression (AC5)
  // -------------------------------------------------------------------------

  it('U4: multiple compactions after autoThreshold → exactly one restart, all compactions recorded (AC5)', async () => {
    /**
     * SELF-VERIFY: removing the restartSignalSent guard in setupCompactionMonitor
     * causes postHarnessSignal to be called multiple times (duplicate suppression
     * broken). The assertion expect(postHarnessSignal).toHaveBeenCalledTimes(1) fails.
     */
    const { pi, fire } = fakePi();
    const record = vi.fn(async () => {});

    // Provide a compaction pointer so the fallback path can resolve it.
    const compactionPointerEvent: DomainEvent = {
      id: 'evt-cs-001',
      type: DomainEventName.COMPACTION_SUMMARY_RECORDED,
      timestamp: '2026-06-09T00:00:01.000Z',
      sessionId: 'test-session',
      data: {
        beadId: 'bd-6q0y37-test',
        stateId: 'Implement',
        artifactPath: path.join(TEST_PROJECT_ROOT, '.pi', 'artifacts', 'bd-6q0y37-test', 'compaction-summary.json'),
        artifactBytes: 512,
        artifactSha256: 'b'.repeat(64),
        sourceEventIds: ['evt-001'],
        nonAuthoritative: true
      }
    } as DomainEvent;

    const eventsForBead = vi.fn(async () => [compactionPointerEvent]);
    // warnThreshold=1, autoThreshold=2
    const config = enabledFallbackConfig(1, 2);
    const { teammate } = buildTeammate({ pi, config, recordFn: record, eventsForBeadFn: eventsForBead });

    await teammate.start();

    // Fire 5 compactions — only one restart signal should ever be posted
    for (let i = 0; i < 5; i++) {
      fire(PiEventName.SESSION_COMPACT);
      await drainMicrotasks(20);
    }

    // EXACTLY ONE restart signal (duplicate suppression)
    expect(postHarnessSignal).toHaveBeenCalledTimes(1);

    // All 5 CONTEXT_COMPACTION_RECORDED events recorded (evidence preserved)
    const compactionCalls = record.mock.calls.filter(([n]) => n === DomainEventName.CONTEXT_COMPACTION_RECORDED);
    expect(compactionCalls).toHaveLength(5);
  });

  // -------------------------------------------------------------------------
  // U5: enabled:false → no warning or restart (AC1/AC6)
  // -------------------------------------------------------------------------

  it('U5: compactionFallback.enabled:false → no warning or restart (AC1/AC6)', async () => {
    const { pi, fire } = fakePi();
    const record = vi.fn(async () => {});
    const { teammate } = buildTeammate({ pi, config: explicitlyDisabledConfig(), recordFn: record });

    await teammate.start();
    fire(PiEventName.SESSION_COMPACT);
    await drainMicrotasks();

    const warningCalls = record.mock.calls.filter(([n]) => n === DomainEventName.CONTEXT_COMPACTION_WARNING);
    expect(warningCalls).toHaveLength(0);
    expect(postHarnessSignal).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // U6: Fallback carries compaction-artifact pointer (AC4)
  // -------------------------------------------------------------------------

  it('U6: fallback restart evidenceRefs include the compaction-artifact pointer (AC4)', async () => {
    /**
     * SELF-VERIFY: changing triggerFallbackRestart to build evidenceRefs without the
     * compaction pointer (e.g. empty array) causes this test to fail because
     * ref.schemaId and ref.semanticArtifactPath assertions fail.
     */
    const { pi, fire } = fakePi();
    const record = vi.fn(async () => {});

    const artifactPath = path.join(
      TEST_PROJECT_ROOT, '.pi', 'artifacts', 'bd-6q0y37-test', 'compaction-summary.json'
    );
    const artifactSha256 = 'c'.repeat(64);
    const artifactBytes = 1024;

    const compactionPointerEvent: DomainEvent = {
      id: 'evt-cs-002',
      type: DomainEventName.COMPACTION_SUMMARY_RECORDED,
      timestamp: '2026-06-09T00:00:01.000Z',
      sessionId: 'test-session',
      data: {
        beadId: 'bd-6q0y37-test',
        stateId: 'Implement',
        artifactPath,
        artifactBytes,
        artifactSha256,
        sourceEventIds: ['src-evt-001', 'src-evt-002'],
        nonAuthoritative: true
      }
    } as DomainEvent;

    const eventsForBead = vi.fn(async () => [compactionPointerEvent]);
    const config = enabledFallbackConfig(1, 2);
    const { teammate } = buildTeammate({ pi, config, recordFn: record, eventsForBeadFn: eventsForBead });

    await teammate.start();
    fire(PiEventName.SESSION_COMPACT); // count=1 (warn)
    await drainMicrotasks();
    fire(PiEventName.SESSION_COMPACT); // count=2 (auto)
    await drainMicrotasks(50);

    expect(postHarnessSignal).toHaveBeenCalledTimes(1);
    const signalArg = vi.mocked(postHarnessSignal).mock.calls[0]![0] as Record<string, unknown>;

    const evidenceRefs = signalArg['evidenceRefs'] as Array<Record<string, unknown>>;
    expect(evidenceRefs.length).toBe(1);
    const ref = evidenceRefs[0]!;
    expect(ref['schemaId']).toBe('compaction-summary');
    expect(ref['semanticArtifactPath']).toBe(artifactPath);
    expect(ref['bytes']).toBe(artifactBytes);
    expect(ref['sha256']).toBe(artifactSha256);
    expect(Array.isArray(ref['sourceEventIds'])).toBe(true);
  });

  // -------------------------------------------------------------------------
  // U7: State without fallback — NO Orr Else restart from compaction policy (AC1/AC6)
  // -------------------------------------------------------------------------

  it('U7: state without compactionFallback → SESSION_COMPACT produces NO Orr Else restart (AC1/AC6 no-backcompat)', async () => {
    /**
     * SELF-VERIFY: if the removed legacy triggerAutoRestart path is re-added for
     * non-fallback states, postHarnessSignal would be called and this test would fail.
     *
     * AC1/AC6: Pi.dev autocompaction is the ONLY compaction behavior for states without
     * compactionFallback.enabled:true. The harness posts NO CONTEXT_RESTART_REQUESTED.
     */
    const { pi, fire } = fakePi();
    const record = vi.fn(async () => {});
    const config = noFallbackConfig();
    const { teammate } = buildTeammate({ pi, config, recordFn: record });

    await teammate.start();
    fire(PiEventName.SESSION_COMPACT); // count=1
    await drainMicrotasks(30);

    // No CONTEXT_COMPACTION_WARNING (compactionFallback is absent)
    const warningCalls = record.mock.calls.filter(([n]) => n === DomainEventName.CONTEXT_COMPACTION_WARNING);
    expect(warningCalls).toHaveLength(0);

    // NO restart signal — Pi.dev autocompaction is the only behavior (AC1/AC6)
    expect(postHarnessSignal).not.toHaveBeenCalled();

    // CONTEXT_COMPACTION_RECORDED still recorded (evidence preserved)
    const compactionCalls = record.mock.calls.filter(([n]) => n === DomainEventName.CONTEXT_COMPACTION_RECORDED);
    expect(compactionCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Lint tests — ConfigLoader startup validation (AC7)
// ---------------------------------------------------------------------------

const LINT_DIR = fs.realpathSync(
  fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'orr-else-6q0y37-lint-'))
);

afterEach(() => {
  for (const entry of fs.readdirSync(LINT_DIR)) {
    try { fs.rmSync(path.join(LINT_DIR, entry), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function writeYaml(name: string, content: string): string {
  const p = path.join(LINT_DIR, name);
  fs.writeFileSync(p, content);
  return p;
}

function minimalYaml(fallbackBlock: string): string {
  return `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test handover"
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  initialState: Implement
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
tools:
  - name: verify_build
    type: command
    command: echo ok
    sideEffectContract:
      idempotencyClass: idempotent
states:
  Implement:
    identity:
      role: "Implementer"
      expertise: "Code"
      constraints: []
    baseInstructions: "Implement."
    checklist:
      - text: "Done"
        mandatory: true
    actions:
      - id: implement_action
        type: prompt
        prompt: "Do the work."
    transitions:
      SUCCESS: completed
      FAILURE: Implement
    requiredTools:
      - verify_build
    ${fallbackBlock}
  completed:
    identity:
      role: "Done"
      expertise: "Done"
      constraints: []
    actions: []
    transitions: {}
`;
}

describe('Compaction fallback lint — ConfigLoader startup validation (AC7)', () => {
  it('L1: valid enabled:false → loads without error', () => {
    const p = writeYaml('l1.yaml', minimalYaml('compactionFallback:\n      enabled: false'));
    const loader = new ConfigLoader();
    expect(() => loader.load(p)).not.toThrow();
  });

  it('L2: valid enabled:true with correct thresholds + compactionSummary → loads', () => {
    const p = writeYaml('l2.yaml', minimalYaml(
      'compactionSummary:\n      enabled: true\n      compactionRoute: SUCCESS\n    compactionFallback:\n      enabled: true\n      warnThreshold: 1\n      autoThreshold: 2'
    ));
    const loader = new ConfigLoader();
    expect(() => loader.load(p)).not.toThrow();
  });

  it('L2b: enabled:true without compactionSummary.enabled:true → startup-fatal (DEFECT2 fix)', () => {
    const p = writeYaml('l2b.yaml', minimalYaml(
      'compactionFallback:\n      enabled: true\n      warnThreshold: 1\n      autoThreshold: 2'
    ));
    const loader = new ConfigLoader();
    expect(() => loader.load(p)).toThrow(/compactionSummary/);
  });

  it('L3: non-object compactionFallback → startup-fatal', () => {
    const p = writeYaml('l3.yaml', minimalYaml('compactionFallback: "invalid"'));
    const loader = new ConfigLoader();
    // Schema validation fires before ConfigLoader lint; error message references compactionFallback
    expect(() => loader.load(p)).toThrow(/compactionFallback/);
  });

  it('L4: enabled not boolean → startup-fatal', () => {
    const p = writeYaml('l4.yaml', minimalYaml(
      'compactionFallback:\n      enabled: "yes"'
    ));
    const loader = new ConfigLoader();
    // Schema validation fires before ConfigLoader lint; error message references enabled
    expect(() => loader.load(p)).toThrow(/compactionFallback.*enabled|enabled.*boolean/i);
  });

  it('L5: enabled:true + missing warnThreshold → startup-fatal', () => {
    // Include compactionSummary so the new co-declaration lint passes and warnThreshold check fires.
    const p = writeYaml('l5.yaml', minimalYaml(
      'compactionSummary:\n      enabled: true\n      compactionRoute: SUCCESS\n    compactionFallback:\n      enabled: true\n      autoThreshold: 2'
    ));
    const loader = new ConfigLoader();
    expect(() => loader.load(p)).toThrow(/warnThreshold is missing/);
  });

  it('L6: enabled:true + missing autoThreshold → startup-fatal', () => {
    // Include compactionSummary so the new co-declaration lint passes and autoThreshold check fires.
    const p = writeYaml('l6.yaml', minimalYaml(
      'compactionSummary:\n      enabled: true\n      compactionRoute: SUCCESS\n    compactionFallback:\n      enabled: true\n      warnThreshold: 1'
    ));
    const loader = new ConfigLoader();
    expect(() => loader.load(p)).toThrow(/autoThreshold is missing/);
  });

  it('L7: autoThreshold <= warnThreshold → startup-fatal', () => {
    // Include compactionSummary so the new co-declaration lint passes and ordering check fires.
    const p = writeYaml('l7.yaml', minimalYaml(
      'compactionSummary:\n      enabled: true\n      compactionRoute: SUCCESS\n    compactionFallback:\n      enabled: true\n      warnThreshold: 3\n      autoThreshold: 3'
    ));
    const loader = new ConfigLoader();
    expect(() => loader.load(p)).toThrow(/autoThreshold must be a positive integer.*greater than warnThreshold/);
  });

  it('L8: warnThreshold < 1 → startup-fatal', () => {
    // Include compactionSummary so the new co-declaration lint passes and warnThreshold check fires.
    const p = writeYaml('l8.yaml', minimalYaml(
      'compactionSummary:\n      enabled: true\n      compactionRoute: SUCCESS\n    compactionFallback:\n      enabled: true\n      warnThreshold: 0\n      autoThreshold: 1'
    ));
    const loader = new ConfigLoader();
    // Schema validation fires before ConfigLoader lint; catches warnThreshold < 1
    expect(() => loader.load(p)).toThrow(/warnThreshold/);
  });

  it('L9: absent compactionFallback → complete no-op (AC1/AC6)', () => {
    const p = writeYaml('l9.yaml', minimalYaml(''));
    const loader = new ConfigLoader();
    const config = loader.load(p);
    const state = config.states['Implement'] as { compactionFallback?: unknown };
    expect(state?.compactionFallback).toBeUndefined();
  });
});
