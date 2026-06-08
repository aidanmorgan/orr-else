/**
 * compaction_summary_integration.test.ts
 *
 * pi-experiment-6q0y.35: Real-trigger integration tests for compaction summary wiring.
 *
 * These tests drive the REAL production path — Teammate.setupCompactionMonitor's
 * SESSION_COMPACT handler — to verify that wiring is in place. They MUST FAIL
 * if the generation call is removed from the handler (self-verified by comment).
 *
 * IT1 (ENABLED → artifact + event):
 *   Fire SESSION_COMPACT for a state with compactionSummary.enabled:true.
 *   Assert: (a) summary artifact is written to disk (path / bytes / sha256),
 *           (b) COMPACTION_SUMMARY_RECORDED is emitted with nonAuthoritative:true
 *               and the sourceEventIds array.
 *   SELF-VERIFY: removing the generateCompactionSummary call from the SESSION_COMPACT
 *   handler makes this test fail (no artifact written, event never recorded).
 *
 * IT2 (DISABLED → no-op):
 *   Fire SESSION_COMPACT for a state with compactionSummary absent/disabled.
 *   Assert: no summary artifact, no COMPACTION_SUMMARY_RECORDED event.
 *   CONTEXT_COMPACTION_RECORDED IS still recorded (existing behavior unchanged).
 *
 * IT3 (ENABLED with compactionRoute → route metadata in pointer event):
 *   Fire SESSION_COMPACT with compactionRoute declared.
 *   Assert: COMPACTION_SUMMARY_RECORDED payload includes compactionRoute.
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

// ---------------------------------------------------------------------------
// Temp dir for artifact writes
// ---------------------------------------------------------------------------

let TEST_PROJECT_ROOT: string;

beforeEach(() => {
  TEST_PROJECT_ROOT = fs.realpathSync(
    fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'orr-else-6q0y35-int-'))
  );
  // Logger.configureProjectRoot is called by Teammate.startInner with projectRoot.
  // Silence it in tests so the DailyRotateFile transport isn't reconfigured to
  // the temp dir — the module-level Logger stays on process.cwd()/.pi/logs.
  vi.spyOn(Logger, 'configureProjectRoot').mockImplementation(() => {});
});

afterEach(() => {
  try {
    fs.rmSync(TEST_PROJECT_ROOT, { recursive: true, force: true });
  } catch { /* ignore */ }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fake pi that lets tests fire handlers
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
    setActiveTools: vi.fn(),
    getActiveTools: vi.fn(() => [] as string[]),
    events: { on: vi.fn(() => () => {}), emit: vi.fn() }
  } as unknown as ExtensionAPI;

  function fire(event: string, ...args: unknown[]) {
    for (const h of handlers.get(event) ?? []) h(...args);
  }

  return { pi, fire };
}

// ---------------------------------------------------------------------------
// Config factories
// ---------------------------------------------------------------------------

function enabledConfig(compactionRoute?: string): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: 'handover',
      agentTurnTimeoutMs: 60_000,
      processReapIntervalMs: 5_000,
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'test-model',
      defaultProvider: 'anthropic',
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 10
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    states: {
      Implement: {
        compactionSummary: {
          enabled: true,
          ...(compactionRoute !== undefined ? { compactionRoute } : {})
        }
      }
    }
  } as HarnessConfig;
}

function disabledConfig(): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: 'handover',
      agentTurnTimeoutMs: 60_000,
      processReapIntervalMs: 5_000,
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'test-model',
      defaultProvider: 'anthropic',
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 10
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    states: {
      Implement: {
        // no compactionSummary — absent → no-op (AC1/AC2)
      }
    }
  } as HarnessConfig;
}

// ---------------------------------------------------------------------------
// Teammate factory
// ---------------------------------------------------------------------------

function buildTeammate(options: {
  pi: ExtensionAPI;
  config: HarnessConfig;
  recordFn: ReturnType<typeof vi.fn>;
  eventsForBeadFn?: () => Promise<DomainEvent[]>;
  projectRoot?: string;
}) {
  const { pi, config, recordFn } = options;
  const projectRoot = options.projectRoot ?? TEST_PROJECT_ROOT;

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
    beadId: 'bd-integration-test' as BeadId,
    stateId: 'Implement',
    projectRoot,
    worktreePath: undefined,
    workerId: 'worker-int-1',
    actionId: WorkerDefaults.AUTO_CONTEXT_RESTART_ACTION_ID
  };

  const teammate = new Teammate(
    pi, ctx, observability, configLoader, eventStore,
    flowManager, bdPlugin, gitPlugin, mailboxPlugin, qualityPlugin,
    workerContext
  );

  return { teammate, eventStore };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Compaction summary integration — real SESSION_COMPACT trigger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  // -------------------------------------------------------------------------
  // IT1: enabled → artifact written + COMPACTION_SUMMARY_RECORDED emitted
  // -------------------------------------------------------------------------

  it('IT1: enabled state → SESSION_COMPACT writes artifact + records COMPACTION_SUMMARY_RECORDED', async () => {
    /**
     * SELF-VERIFY: if you remove the `generateCompactionSummary` call from
     * Teammate.setupCompactionMonitor's SESSION_COMPACT handler, this test fails:
     *   - no artifact is written (existsSync returns false)
     *   - no COMPACTION_SUMMARY_RECORDED event is recorded
     */
    const { pi, fire } = fakePi();
    const record = vi.fn(async () => {});
    const { teammate } = buildTeammate({
      pi,
      config: enabledConfig(),
      recordFn: record
    });

    await teammate.start();

    fire(PiEventName.SESSION_COMPACT);

    // Drain microtasks so the async generation (void promise) completes.
    // Do NOT use vi.runAllTimersAsync() here — it triggers the heartbeat setInterval
    // infinite loop. The async generation is micro-task-level (no macrotask delay).
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // (a) Artifact must be written to disk
    const expectedArtifactPath = path.join(
      TEST_PROJECT_ROOT, '.pi', 'artifacts', 'bd-integration-test', 'compaction-summary.json'
    );
    expect(fs.existsSync(expectedArtifactPath)).toBe(true);
    const artifactContent = JSON.parse(fs.readFileSync(expectedArtifactPath, 'utf8'));
    expect(artifactContent.nonAuthoritative).toBe(true);
    expect(artifactContent.beadId).toBe('bd-integration-test');
    expect(artifactContent.stateId).toBe('Implement');
    expect(typeof artifactContent.compactionCount).toBe('number');
    const artifactBytes = fs.statSync(expectedArtifactPath).size;
    expect(artifactBytes).toBeGreaterThan(0);

    // (b) COMPACTION_SUMMARY_RECORDED must be recorded with nonAuthoritative:true
    const summaryRecordedCalls = record.mock.calls.filter(
      ([name]) => name === DomainEventName.COMPACTION_SUMMARY_RECORDED
    );
    expect(summaryRecordedCalls).toHaveLength(1);
    const [, payload] = summaryRecordedCalls[0]!;
    expect(payload['nonAuthoritative']).toBe(true);
    expect(payload['beadId']).toBe('bd-integration-test');
    expect(payload['stateId']).toBe('Implement');
    expect(typeof payload['artifactPath']).toBe('string');
    expect(payload['artifactPath']).toBe(expectedArtifactPath);
    expect(typeof payload['artifactBytes']).toBe('number');
    expect(typeof payload['artifactSha256']).toBe('string');
    expect((payload['artifactSha256'] as string).length).toBe(64);
    expect(Array.isArray(payload['sourceEventIds'])).toBe(true);

    // CONTEXT_COMPACTION_RECORDED is ALSO still recorded (existing behavior unchanged)
    const compactionCalls = record.mock.calls.filter(
      ([name]) => name === DomainEventName.CONTEXT_COMPACTION_RECORDED
    );
    expect(compactionCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // IT2: disabled/absent → no-op (no artifact, no COMPACTION_SUMMARY_RECORDED)
  // -------------------------------------------------------------------------

  it('IT2: disabled/absent compactionSummary → SESSION_COMPACT produces no artifact + no COMPACTION_SUMMARY_RECORDED', async () => {
    const { pi, fire } = fakePi();
    const record = vi.fn(async () => {});
    const { teammate } = buildTeammate({
      pi,
      config: disabledConfig(),
      recordFn: record
    });

    await teammate.start();

    fire(PiEventName.SESSION_COMPACT);

    for (let i = 0; i < 20; i++) await Promise.resolve();

    // No artifact written anywhere in the project root
    const artifactsDir = path.join(TEST_PROJECT_ROOT, '.pi', 'artifacts');
    const artifactExists = fs.existsSync(artifactsDir)
      ? fs.readdirSync(artifactsDir, { recursive: true })
          .some(f => String(f).endsWith('compaction-summary.json'))
      : false;
    expect(artifactExists).toBe(false);

    // No COMPACTION_SUMMARY_RECORDED event
    const summaryRecordedCalls = record.mock.calls.filter(
      ([name]) => name === DomainEventName.COMPACTION_SUMMARY_RECORDED
    );
    expect(summaryRecordedCalls).toHaveLength(0);

    // CONTEXT_COMPACTION_RECORDED IS still recorded (existing behavior preserved)
    const compactionCalls = record.mock.calls.filter(
      ([name]) => name === DomainEventName.CONTEXT_COMPACTION_RECORDED
    );
    expect(compactionCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // IT3: compactionRoute metadata included in pointer event
  // -------------------------------------------------------------------------

  it('IT3: enabled state with compactionRoute → pointer event includes compactionRoute', async () => {
    const { pi, fire } = fakePi();
    const record = vi.fn(async () => {});
    const { teammate } = buildTeammate({
      pi,
      config: enabledConfig('COMPACTED'),
      recordFn: record
    });

    await teammate.start();

    fire(PiEventName.SESSION_COMPACT);

    for (let i = 0; i < 20; i++) await Promise.resolve();

    const summaryRecordedCalls = record.mock.calls.filter(
      ([name]) => name === DomainEventName.COMPACTION_SUMMARY_RECORDED
    );
    expect(summaryRecordedCalls).toHaveLength(1);
    const [, payload] = summaryRecordedCalls[0]!;
    expect(payload['compactionRoute']).toBe('COMPACTED');
    expect(payload['nonAuthoritative']).toBe(true);
  });

  // -------------------------------------------------------------------------
  // IT4: eventsForBead feeds summary — checkpoint events appear in artifact
  // -------------------------------------------------------------------------

  it('IT4: schema-valid events from eventsForBead appear in the summary artifact', async () => {
    const { pi, fire } = fakePi();
    const record = vi.fn(async () => {});

    // Provide a real CHECKPOINT_SUBMITTED event in the bead history
    const checkpointEvent: DomainEvent = {
      id: 'evt-0001',
      type: DomainEventName.CHECKPOINT_SUBMITTED,
      timestamp: '2026-06-09T00:00:01.000Z',
      sessionId: 'test-session',
      data: {
        beadId: 'bd-integration-test',
        stateId: 'Implement',
        summary: 'Implemented feature X and all tests pass.'
      }
    } as DomainEvent;

    const { teammate } = buildTeammate({
      pi,
      config: enabledConfig(),
      recordFn: record,
      eventsForBeadFn: async () => [checkpointEvent]
    });

    await teammate.start();

    fire(PiEventName.SESSION_COMPACT);

    for (let i = 0; i < 20; i++) await Promise.resolve();

    const expectedArtifactPath = path.join(
      TEST_PROJECT_ROOT, '.pi', 'artifacts', 'bd-integration-test', 'compaction-summary.json'
    );
    expect(fs.existsSync(expectedArtifactPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(expectedArtifactPath, 'utf8'));
    // The checkpoint should appear in latestCheckpoints
    expect(content.latestCheckpoints).toHaveLength(1);
    expect(content.latestCheckpoints[0].summary).toBe('Implemented feature X and all tests pass.');
    expect(content.nonAuthoritative).toBe(true);
  });
});
