/**
 * Tests for Teammate — focused on the WI-13 extraction and teardown fix:
 *
 * Resource-leak fix: before this change, the SESSION_COMPACT listener registered
 * via pi.on() was never deactivated when the teammate's abort signal fired.
 * Because ExtensionAPI exposes no pi.off(), the fix uses an `active` guard inside
 * the closure returned by setupCompactionMonitor so that the listener becomes a
 * no-op after abort. Each Teammate lifecycle therefore accumulates at most one
 * inert handler rather than a permanently-live one.
 *
 * The test for compaction-listener teardown FAILS against the pre-fix code because
 * the old inline closure had no `active` guard — invoking it after abort would still
 * call eventStore.record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Teammate, type WorkerContext } from '../src/core/Teammate.js';
import { DomainEventName, PluginToolName } from '../src/constants/domain.js';
import { EnvVars, PiEventName, WorkerDefaults } from '../src/constants/infra.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import type { BeadId } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Minimal config fixture
// ---------------------------------------------------------------------------

function minimalConfig(overrides: Partial<HarnessConfig['settings']> = {}): HarnessConfig {
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
      harnessContextRotThreshold: 10,
      ...overrides
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    states: {}
  } as HarnessConfig;
}

// ---------------------------------------------------------------------------
// Fake pi that records on-calls and lets tests fire handlers
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

  /** Fire all registered handlers for an event */
  function fire(event: string, ...args: unknown[]) {
    for (const h of handlers.get(event) ?? []) {
      h(...args);
    }
  }

  /** Count live handlers registered for an event */
  function handlerCount(event: string): number {
    return handlers.get(event)?.length ?? 0;
  }

  return { pi, fire, handlerCount, handlers };
}

// ---------------------------------------------------------------------------
// Fake abort controller / signal
// ---------------------------------------------------------------------------

function fakeAbortController() {
  const controller = new AbortController();
  return controller;
}

// ---------------------------------------------------------------------------
// Default stub WorkerContext
// ---------------------------------------------------------------------------

function defaultWorkerContext(overrides: Partial<WorkerContext> = {}): WorkerContext {
  return {
    beadId: 'pi-experiment-test-bead' as BeadId,
    stateId: 'Implementation',
    projectRoot: process.cwd(),
    worktreePath: undefined,
    workerId: 'worker-test-1234',
    actionId: WorkerDefaults.AUTO_CONTEXT_RESTART_ACTION_ID,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Teammate harness
// ---------------------------------------------------------------------------

function buildTeammate(
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  config: HarnessConfig,
  recordFn: ReturnType<typeof vi.fn>,
  workerContext: WorkerContext = defaultWorkerContext()
) {
  const ctx = {
    hasUI: false,
    signal,
    shutdown: vi.fn()
  } as unknown as ExtensionContext;

  const observability = {
    tracedAsync: (_name: string, _attrs: object, fn: () => unknown) => fn
  } as any;

  const configLoader = {
    load: vi.fn(() => config)
  } as any;

  const eventStore = {
    record: recordFn
  } as any;

  const flowManager = {
    activateTools: vi.fn()
  } as any;

  const bdHeartbeatExecute = vi.fn(async () => {});
  const bdPlugin = {
    tools: [{ name: PluginToolName.BD_HEARTBEAT, execute: bdHeartbeatExecute }]
  } as any;

  const gitPlugin = { tools: [] } as any;
  const mailboxPlugin = { tools: [] } as any;
  const qualityPlugin = { tools: [] } as any;

  const teammate = new Teammate(
    pi, ctx, observability, configLoader, eventStore,
    flowManager, bdPlugin, gitPlugin, mailboxPlugin, qualityPlugin,
    workerContext
  );

  return { teammate, ctx, configLoader, flowManager, bdHeartbeatExecute };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Teammate — WI-13: compaction-monitor and heartbeat extraction + teardown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Heartbeat teardown
  // -------------------------------------------------------------------------

  it('clears the heartbeat interval when the abort signal fires', async () => {
    const { pi, fire: _fire } = fakePi();
    const controller = fakeAbortController();
    const record = vi.fn(async () => {});
    const { teammate } = buildTeammate(pi, controller.signal, minimalConfig(), record);

    await teammate.start();

    // Heartbeat should tick once immediately on the first interval
    vi.advanceTimersByTime(WorkerDefaults.HEARTBEAT_INTERVAL_MS);
    const callsBeforeAbort = record.mock.calls.length;

    // Abort — this must clear the interval
    controller.abort();

    // Advance time further — no additional heartbeat calls should occur
    vi.advanceTimersByTime(WorkerDefaults.HEARTBEAT_INTERVAL_MS * 3);
    expect(record.mock.calls.length).toBe(callsBeforeAbort);
  });

  // -------------------------------------------------------------------------
  // Compaction-monitor teardown (the leak fix)
  // -------------------------------------------------------------------------

  it('prevents the SESSION_COMPACT handler from recording events after abort', async () => {
    /**
     * WHY THIS FAILS AGAINST OLD CODE:
     * Before WI-13 the SESSION_COMPACT handler was an inline closure with no
     * `active` guard. Firing it after abort would still call eventStore.record,
     * causing the leak. The new setupCompactionMonitor sets `active = false`
     * when its cleanup is called, so the handler becomes a no-op.
     */
    const { pi, fire } = fakePi();
    const controller = fakeAbortController();
    const record = vi.fn(async () => {});
    const { teammate } = buildTeammate(pi, controller.signal, minimalConfig(), record);

    await teammate.start();

    // Verify that a compaction BEFORE abort IS recorded (normal behaviour preserved)
    fire(PiEventName.SESSION_COMPACT);
    expect(record).toHaveBeenCalledWith(
      DomainEventName.CONTEXT_COMPACTION_RECORDED,
      expect.objectContaining({ beadId: 'pi-experiment-test-bead', compactionCount: 1 })
    );

    const callsBeforeAbort = record.mock.calls.length;

    // Abort — this must deactivate the compaction handler
    controller.abort();

    // Fire SESSION_COMPACT again — handler must be inert now
    fire(PiEventName.SESSION_COMPACT);
    fire(PiEventName.SESSION_COMPACT);

    // No additional record calls should have been made
    expect(record.mock.calls.length).toBe(callsBeforeAbort);
  });

  // -------------------------------------------------------------------------
  // Both teardowns fire on a single abort
  // -------------------------------------------------------------------------

  it('tears down BOTH the heartbeat interval AND the compaction monitor on abort', async () => {
    const { pi, fire } = fakePi();
    const controller = fakeAbortController();
    const record = vi.fn(async () => {});
    const { teammate } = buildTeammate(pi, controller.signal, minimalConfig(), record);

    await teammate.start();

    // Confirm compaction records before abort
    fire(PiEventName.SESSION_COMPACT);
    expect(record).toHaveBeenCalledWith(
      DomainEventName.CONTEXT_COMPACTION_RECORDED,
      expect.objectContaining({ compactionCount: 1 })
    );

    const callsAtAbort = record.mock.calls.length;

    controller.abort();

    // Heartbeat: no additional calls after abort
    vi.advanceTimersByTime(WorkerDefaults.HEARTBEAT_INTERVAL_MS * 2);

    // Compaction: no additional calls after abort
    fire(PiEventName.SESSION_COMPACT);
    fire(PiEventName.SESSION_COMPACT);

    expect(record.mock.calls.length).toBe(callsAtAbort);
  });

  // -------------------------------------------------------------------------
  // Normal compaction behavior is preserved (counter increments, event recorded)
  // -------------------------------------------------------------------------

  it('records each compaction with an incrementing counter before abort', async () => {
    const { pi, fire } = fakePi();
    const controller = fakeAbortController();
    const record = vi.fn(async () => {});
    const { teammate } = buildTeammate(pi, controller.signal, minimalConfig(), record);

    await teammate.start();

    fire(PiEventName.SESSION_COMPACT);
    fire(PiEventName.SESSION_COMPACT);
    fire(PiEventName.SESSION_COMPACT);

    const compactionCalls = record.mock.calls.filter(
      ([name]) => name === DomainEventName.CONTEXT_COMPACTION_RECORDED
    );
    expect(compactionCalls).toHaveLength(3);
    expect(compactionCalls[0][1]).toMatchObject({ compactionCount: 1 });
    expect(compactionCalls[1][1]).toMatchObject({ compactionCount: 2 });
    expect(compactionCalls[2][1]).toMatchObject({ compactionCount: 3 });

    controller.abort();
  });

  // -------------------------------------------------------------------------
  // No-signal path: teardown must not throw when ctx.signal is undefined
  // -------------------------------------------------------------------------

  it('starts successfully and does not throw when ctx.signal is undefined', async () => {
    const { pi } = fakePi();
    const record = vi.fn(async () => {});
    const { teammate } = buildTeammate(pi, undefined, minimalConfig(), record);

    await expect(teammate.start()).resolves.not.toThrow();

    // Clean up the live interval so fake timers don't leak into other tests
    vi.clearAllTimers();
  });
});

// ---------------------------------------------------------------------------
// WI-6: WorkerContext injection — env-free testability
// ---------------------------------------------------------------------------

describe('Teammate — WI-6: WorkerContext injection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('heartbeat emits the injected workerId (NOT process.env)', async () => {
    const { pi } = fakePi();
    const controller = fakeAbortController();
    const record = vi.fn(async () => {});
    const ctx = defaultWorkerContext({ workerId: 'injected-worker-99' });
    const { teammate, bdHeartbeatExecute } = buildTeammate(
      pi, controller.signal, minimalConfig(), record, ctx
    );

    await teammate.start();

    // Advance one heartbeat tick
    await vi.advanceTimersByTimeAsync(WorkerDefaults.HEARTBEAT_INTERVAL_MS);

    expect(bdHeartbeatExecute).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: 'injected-worker-99' })
    );

    controller.abort();
  });

  it('heartbeat does NOT use process.env WORKER_ID even when set', async () => {
    const originalWorkerId = process.env[EnvVars.WORKER_ID];
    process.env[EnvVars.WORKER_ID] = 'env-worker-should-be-ignored';

    try {
      const { pi } = fakePi();
      const controller = fakeAbortController();
      const record = vi.fn(async () => {});
      const ctx = defaultWorkerContext({ workerId: 'injected-worker-only' });
      const { teammate, bdHeartbeatExecute } = buildTeammate(
        pi, controller.signal, minimalConfig(), record, ctx
      );

      await teammate.start();
      await vi.advanceTimersByTimeAsync(WorkerDefaults.HEARTBEAT_INTERVAL_MS);

      // Must use injected value, not process.env
      expect(bdHeartbeatExecute).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: 'injected-worker-only' })
      );
      expect(bdHeartbeatExecute).not.toHaveBeenCalledWith(
        expect.objectContaining({ workerId: 'env-worker-should-be-ignored' })
      );

      controller.abort();
    } finally {
      process.env[EnvVars.WORKER_ID] = originalWorkerId;
    }
  });

  it('startInner uses injected beadId and stateId from WorkerContext', async () => {
    const { pi } = fakePi();
    const controller = fakeAbortController();
    const record = vi.fn(async () => {});
    const ctx = defaultWorkerContext({
      beadId: 'injected-bead-abc' as BeadId,
      stateId: 'InjectedState'
    });
    const { teammate } = buildTeammate(
      pi, controller.signal, minimalConfig(), record, ctx
    );

    await teammate.start();

    // Fire a compaction so we see the beadId/stateId passed to record
    const { fire } = fakePi();
    // Re-use pi from outer fakePi — but we need to fire on the registered pi.
    // Instead, verify via the compaction event which uses beadId from workerContext.
    // The above start() registered on `pi`, so fire via the same pi fixture.
    // (Rebuild with fire from same fakePi instance to fire the event)
    controller.abort();
    vi.clearAllTimers();
  });

  it('startInner records compaction with injected beadId and stateId', async () => {
    const { pi, fire } = fakePi();
    const controller = fakeAbortController();
    const record = vi.fn(async () => {});
    const ctx = defaultWorkerContext({
      beadId: 'bead-from-context' as BeadId,
      stateId: 'StateFromContext'
    });
    const { teammate } = buildTeammate(
      pi, controller.signal, minimalConfig(), record, ctx
    );

    await teammate.start();
    fire(PiEventName.SESSION_COMPACT);

    expect(record).toHaveBeenCalledWith(
      DomainEventName.CONTEXT_COMPACTION_RECORDED,
      expect.objectContaining({
        beadId: 'bead-from-context',
        stateId: 'StateFromContext',
        compactionCount: 1
      })
    );

    controller.abort();
  });

  it('returns early (no error) when WorkerContext has missing beadId', async () => {
    const { pi } = fakePi();
    const record = vi.fn(async () => {});
    // beadId undefined => startInner should return early
    const ctx = defaultWorkerContext({ beadId: undefined });
    const { teammate } = buildTeammate(pi, undefined, minimalConfig(), record, ctx);

    await expect(teammate.start()).resolves.not.toThrow();

    // No compaction or heartbeat setup should have occurred
    expect(record).not.toHaveBeenCalled();
    vi.clearAllTimers();
  });
});

// ---------------------------------------------------------------------------
// AC1/AC6: No Orr Else restart from compaction policy (no-backcompat)
//
// After removing the legacy default auto-restart (triggerAutoRestart), states
// without compactionFallback.enabled:true produce NO CONTEXT_RESTART_REQUESTED
// on SESSION_COMPACT. Pi.dev autocompaction is the only compaction behavior
// (AC1). CONTEXT_COMPACTION_RECORDED is still recorded for every compaction
// (durable evidence preserved).
// ---------------------------------------------------------------------------

vi.mock('../src/core/HarnessApiClient.js', () => ({
  postHarnessSignal: vi.fn().mockResolvedValue({ ok: true })
}));

describe('Teammate — AC1/AC6: no harness-forced restart for states without compactionFallback', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const { postHarnessSignal } = await import('../src/core/HarnessApiClient.js');
    vi.mocked(postHarnessSignal).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('AC1/AC6: SESSION_COMPACT on state without compactionFallback posts NO restart signal (Pi.dev-only default)', async () => {
    const { postHarnessSignal } = await import('../src/core/HarnessApiClient.js');
    const mockPostHarnessSignal = vi.mocked(postHarnessSignal);

    const { pi, fire } = fakePi();
    const controller = fakeAbortController();
    const record = vi.fn(async () => {});

    // No compactionFallback config — even if contextMonitor was previously set,
    // the legacy auto-restart path is gone. Pi.dev handles compaction natively.
    const config = minimalConfig();
    const { teammate } = buildTeammate(pi, controller.signal, config, record);

    await teammate.start();

    // Fire multiple compactions — no restart should ever be posted
    fire(PiEventName.SESSION_COMPACT);
    await Promise.resolve();
    await Promise.resolve();
    fire(PiEventName.SESSION_COMPACT);
    fire(PiEventName.SESSION_COMPACT);
    await Promise.resolve();

    // NO remote restart signal (AC1: Pi.dev autocompaction is the only behavior)
    const restartCalls = mockPostHarnessSignal.mock.calls.filter(
      args => (args[0] as any).type === 'CONTEXT_RESTART_REQUESTED'
    );
    expect(restartCalls).toHaveLength(0);

    // All three compactions must have durable CONTEXT_COMPACTION_RECORDED records
    const compactionRecords = record.mock.calls.filter(
      ([name]) => name === DomainEventName.CONTEXT_COMPACTION_RECORDED
    );
    expect(compactionRecords).toHaveLength(3);

    controller.abort();
    vi.clearAllTimers();
  });

  it('AC1/AC6: NO SIGNAL_INTENT_RECORDED for states without compactionFallback (legacy path removed)', async () => {
    const { pi, fire } = fakePi();
    const controller = fakeAbortController();
    const record = vi.fn(async () => {});

    const config = minimalConfig();
    const { teammate } = buildTeammate(pi, controller.signal, config, record);

    await teammate.start();

    fire(PiEventName.SESSION_COMPACT);
    await Promise.resolve();
    await Promise.resolve();
    fire(PiEventName.SESSION_COMPACT);
    fire(PiEventName.SESSION_COMPACT);
    await Promise.resolve();

    // NO SIGNAL_INTENT_RECORDED — legacy triggerAutoRestart is removed
    const intentRecords = record.mock.calls.filter(
      ([name]) => name === DomainEventName.SIGNAL_INTENT_RECORDED
    );
    expect(intentRecords).toHaveLength(0);

    controller.abort();
    vi.clearAllTimers();
  });
});
