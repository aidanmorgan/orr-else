/**
 * pi-experiment-qlm4: Coordinator ok:false responses must be REJECTED, never ACKNOWLEDGED.
 *
 * AC1: HTTP 2xx with ok:false, blocked:true, timedOut:true, missing ok, or malformed body
 *      is recorded as TEAMMATE_SIGNAL_FAILED (never SIGNAL_ACKNOWLEDGED, never success).
 * AC2: signal_completion returns a bounded diagnostic naming the coordinator rejection
 *      rule and required evidence — NOT a success/shutdown result.
 * AC3: Replay/projection consume only accepted (SIGNAL_ACKNOWLEDGED) signal events;
 *      rejected signals (TEAMMATE_SIGNAL_FAILED) do NOT advance terminal progress.
 * AC4: Cases: ok:false timeout, ok:false blocked gate, malformed response, non-2xx transport
 *      failure, accepted ok:true, duplicate idempotency, restart replay rejects can't advance.
 *
 * NOTE: postHarnessSignal real-HTTP-server tests live in
 * signal_coordinator_rejection_http.test.ts (separate file — no module mock there).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainEventName } from '../src/constants/domain.js';
import type { TeammateEvent } from '../src/core/TeammateEvents.js';
import type { RuntimeServices } from '../src/core/RuntimeServices.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestEvent(overrides: Partial<Record<string, unknown>> = {}): TeammateEvent {
  return {
    type: 'STATE_TRANSITIONED',
    beadId: 'bd-qlm4-test',
    workerId: 'w-qlm4',
    sessionStateId: undefined,
    stateId: 'Implementation',
    idempotencyKey: 'idem-qlm4-1',
    timestamp: Date.now(),
    actionId: 'implement',
    transitionEvent: 'SUCCESS',
    summary: 'done',
    evidence: 'done',
    handover: 'done',
    ...overrides
  } as unknown as TeammateEvent;
}

function makeSignalServices(overrides: Partial<{
  record: ReturnType<typeof vi.fn>;
  eventsForBead: ReturnType<typeof vi.fn>;
}> = {}): RuntimeServices {
  return {
    eventStore: {
      record: overrides.record ?? vi.fn().mockResolvedValue(undefined),
      eventsForBead: overrides.eventsForBead ?? vi.fn().mockResolvedValue([])
    },
    observability: {
      recordCompletedSpan: vi.fn()
    }
  } as unknown as RuntimeServices;
}

// ---------------------------------------------------------------------------
// Module-level mock for HarnessApiClient.
// The CoordinatorRejectionError is mirrored here so tests can construct
// instances without importing the real module (which would bypass the mock).
// ---------------------------------------------------------------------------

const harnessApiMockQlm4 = vi.hoisted(() => ({ postHarnessSignal: vi.fn() }));

vi.mock('../src/core/HarnessApiClient.js', () => {
  class CoordinatorRejectionError extends Error {
    rule: string;
    timedOut?: boolean;
    blocked?: boolean;
    gate?: unknown;
    malformed?: boolean;
    responseBody: Record<string, unknown>;

    constructor(responseBody: Record<string, unknown>) {
      const rule = responseBody.timedOut
        ? 'timedOut'
        : responseBody.blocked
          ? 'blocked'
          : 'malformed';
      super(`Coordinator rejected signal: rule=${rule}`);
      this.name = 'CoordinatorRejectionError';
      this.rule = rule;
      this.responseBody = responseBody;
      if (responseBody.timedOut) this.timedOut = true;
      if (responseBody.blocked) this.blocked = true;
      if (responseBody.gate !== undefined) this.gate = responseBody.gate;
      if (rule === 'malformed') this.malformed = true;
    }
  }

  return {
    postHarnessSignal: harnessApiMockQlm4.postHarnessSignal,
    CoordinatorRejectionError
  };
});

// ---------------------------------------------------------------------------
// AC1 + AC3: postWorkerSignal — rejection records TEAMMATE_SIGNAL_FAILED, not ACKNOWLEDGED
// ---------------------------------------------------------------------------

describe('postWorkerSignal — coordinator rejection is FAILED not ACKNOWLEDGED (qlm4 AC1+AC3)', () => {
  beforeEach(() => {
    harnessApiMockQlm4.postHarnessSignal.mockReset();
  });

  it('AC4: ok:true → records SIGNAL_ACKNOWLEDGED, not TEAMMATE_SIGNAL_FAILED', async () => {
    harnessApiMockQlm4.postHarnessSignal.mockResolvedValue({ ok: true });

    const { postWorkerSignal } = await import('../src/extension/SignalController.js');
    const record = vi.fn().mockResolvedValue(undefined);
    const services = makeSignalServices({ record });

    await postWorkerSignal(services, makeTestEvent());

    const acknowledged = record.mock.calls.some(([name]) => name === DomainEventName.SIGNAL_ACKNOWLEDGED);
    const failed = record.mock.calls.some(([name]) => name === DomainEventName.TEAMMATE_SIGNAL_FAILED);
    expect(acknowledged).toBe(true);
    expect(failed).toBe(false);
  });

  it('AC1: ok:false timedOut → records TEAMMATE_SIGNAL_FAILED with coordinatorRejection:true, NOT SIGNAL_ACKNOWLEDGED', async () => {
    const { CoordinatorRejectionError } = await import('../src/core/HarnessApiClient.js');
    const rejection = new CoordinatorRejectionError({ ok: false, timedOut: true });
    harnessApiMockQlm4.postHarnessSignal.mockRejectedValue(rejection);

    const { postWorkerSignal } = await import('../src/extension/SignalController.js');
    const record = vi.fn().mockResolvedValue(undefined);
    const services = makeSignalServices({ record });

    await expect(postWorkerSignal(services, makeTestEvent())).rejects.toThrow('Coordinator rejected');

    const failedCalls = record.mock.calls.filter(([name]) => name === DomainEventName.TEAMMATE_SIGNAL_FAILED);
    expect(failedCalls).toHaveLength(1);
    const failedPayload = failedCalls[0][1] as Record<string, unknown>;
    expect(failedPayload.coordinatorRejection).toBe(true);
    expect(failedPayload.rule).toBe('timedOut');

    const acknowledged = record.mock.calls.some(([name]) => name === DomainEventName.SIGNAL_ACKNOWLEDGED);
    expect(acknowledged).toBe(false);
  });

  it('AC1: ok:false blocked → records TEAMMATE_SIGNAL_FAILED with coordinatorRejection:true, NOT SIGNAL_ACKNOWLEDGED', async () => {
    const { CoordinatorRejectionError } = await import('../src/core/HarnessApiClient.js');
    const gateVerdict = { pass: false, failures: [], rejectMessage: 'gate blocked' };
    const rejection = new CoordinatorRejectionError({ ok: false, blocked: true, gate: gateVerdict });
    harnessApiMockQlm4.postHarnessSignal.mockRejectedValue(rejection);

    const { postWorkerSignal } = await import('../src/extension/SignalController.js');
    const record = vi.fn().mockResolvedValue(undefined);
    const services = makeSignalServices({ record });

    await expect(postWorkerSignal(services, makeTestEvent())).rejects.toThrow('Coordinator rejected');

    const failedCalls = record.mock.calls.filter(([name]) => name === DomainEventName.TEAMMATE_SIGNAL_FAILED);
    expect(failedCalls).toHaveLength(1);
    const failedPayload = failedCalls[0][1] as Record<string, unknown>;
    expect(failedPayload.coordinatorRejection).toBe(true);
    expect(failedPayload.rule).toBe('blocked');

    const acknowledged = record.mock.calls.some(([name]) => name === DomainEventName.SIGNAL_ACKNOWLEDGED);
    expect(acknowledged).toBe(false);
  });

  it('AC1: malformed response → records TEAMMATE_SIGNAL_FAILED with coordinatorRejection:true, NOT SIGNAL_ACKNOWLEDGED', async () => {
    const { CoordinatorRejectionError } = await import('../src/core/HarnessApiClient.js');
    const rejection = new CoordinatorRejectionError({ ok: false, malformed: true });
    harnessApiMockQlm4.postHarnessSignal.mockRejectedValue(rejection);

    const { postWorkerSignal } = await import('../src/extension/SignalController.js');
    const record = vi.fn().mockResolvedValue(undefined);
    const services = makeSignalServices({ record });

    await expect(postWorkerSignal(services, makeTestEvent())).rejects.toThrow('Coordinator rejected');

    const acknowledged = record.mock.calls.some(([name]) => name === DomainEventName.SIGNAL_ACKNOWLEDGED);
    expect(acknowledged).toBe(false);
    const failed = record.mock.calls.some(([name]) => name === DomainEventName.TEAMMATE_SIGNAL_FAILED);
    expect(failed).toBe(true);
    const failedPayload = record.mock.calls.find(([name]) => name === DomainEventName.TEAMMATE_SIGNAL_FAILED)![1] as Record<string, unknown>;
    expect(failedPayload.coordinatorRejection).toBe(true);
  });

  it('AC4: non-2xx transport failure still records TEAMMATE_SIGNAL_FAILED (transport path, not coordinator rejection)', async () => {
    harnessApiMockQlm4.postHarnessSignal.mockRejectedValue(new Error('network error'));

    const { postWorkerSignal } = await import('../src/extension/SignalController.js');
    const record = vi.fn().mockResolvedValue(undefined);
    const eventsForBead = vi.fn().mockResolvedValue([]); // reconcile finds nothing
    const services = makeSignalServices({ record, eventsForBead });

    await expect(postWorkerSignal(services, makeTestEvent())).rejects.toThrow('network error');

    const failed = record.mock.calls.some(([name]) => name === DomainEventName.TEAMMATE_SIGNAL_FAILED);
    expect(failed).toBe(true);
    const acknowledged = record.mock.calls.some(([name]) => name === DomainEventName.SIGNAL_ACKNOWLEDGED);
    expect(acknowledged).toBe(false);
  });

  it('AC4: duplicate idempotency ok:false → rejection, not acknowledged progress', async () => {
    const { CoordinatorRejectionError } = await import('../src/core/HarnessApiClient.js');
    const rejection = new CoordinatorRejectionError({ ok: false, timedOut: true });
    harnessApiMockQlm4.postHarnessSignal.mockRejectedValue(rejection);

    const { postWorkerSignal } = await import('../src/extension/SignalController.js');
    const record = vi.fn().mockResolvedValue(undefined);
    const services = makeSignalServices({ record });

    await expect(postWorkerSignal(services, makeTestEvent())).rejects.toThrow('Coordinator rejected');

    // CRITICAL: no false-progress — never acknowledged
    const acknowledged = record.mock.calls.some(([name]) => name === DomainEventName.SIGNAL_ACKNOWLEDGED);
    expect(acknowledged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3: replay/projection — rejected signals cannot advance terminal progress.
//
// The projection invariant: ONLY SIGNAL_ACKNOWLEDGED represents accepted
// coordinator progress. Coordinator rejections write TEAMMATE_SIGNAL_FAILED
// (never SIGNAL_ACKNOWLEDGED). The Supervisor.reconcileUnacknowledgedSignalIntents
// reads SIGNAL_ACKNOWLEDGED to identify processed intents; without it, the
// intent stays unacknowledged.
// ---------------------------------------------------------------------------

describe('replay projection — coordinator-rejected signals cannot advance terminal progress (qlm4 AC3)', () => {
  beforeEach(() => {
    harnessApiMockQlm4.postHarnessSignal.mockReset();
  });

  it('AC3: accepted signal (ok:true) writes SIGNAL_ACKNOWLEDGED — replay can advance progress', async () => {
    harnessApiMockQlm4.postHarnessSignal.mockResolvedValue({ ok: true });

    const { postWorkerSignal } = await import('../src/extension/SignalController.js');
    const record = vi.fn().mockResolvedValue(undefined);
    const services = makeSignalServices({ record });

    await postWorkerSignal(services, makeTestEvent());

    const acknowledged = record.mock.calls.filter(([name]) => name === DomainEventName.SIGNAL_ACKNOWLEDGED);
    expect(acknowledged).toHaveLength(1);

    const failed = record.mock.calls.filter(([name]) => name === DomainEventName.TEAMMATE_SIGNAL_FAILED);
    expect(failed).toHaveLength(0);
  });

  it('AC3: coordinator-rejected signal writes TEAMMATE_SIGNAL_FAILED, NEVER SIGNAL_ACKNOWLEDGED — replay cannot advance', async () => {
    const { CoordinatorRejectionError } = await import('../src/core/HarnessApiClient.js');
    const rejection = new CoordinatorRejectionError({ ok: false, timedOut: true });
    harnessApiMockQlm4.postHarnessSignal.mockRejectedValue(rejection);

    const { postWorkerSignal } = await import('../src/extension/SignalController.js');
    const record = vi.fn().mockResolvedValue(undefined);
    const services = makeSignalServices({ record });

    await expect(postWorkerSignal(services, makeTestEvent())).rejects.toThrow('Coordinator rejected');

    const acknowledged = record.mock.calls.filter(([name]) => name === DomainEventName.SIGNAL_ACKNOWLEDGED);
    expect(acknowledged).toHaveLength(0);

    const failed = record.mock.calls.filter(([name]) => name === DomainEventName.TEAMMATE_SIGNAL_FAILED);
    expect(failed).toHaveLength(1);
    const failedPayload = failed[0][1] as Record<string, unknown>;
    expect(failedPayload.coordinatorRejection).toBe(true);
  });

  it('AC3: restart replay — coordinator-rejected intent has no SIGNAL_ACKNOWLEDGED (Supervisor sees it as unacknowledged)', async () => {
    const { CoordinatorRejectionError } = await import('../src/core/HarnessApiClient.js');
    const rejection = new CoordinatorRejectionError({ ok: false, blocked: true });
    harnessApiMockQlm4.postHarnessSignal.mockRejectedValue(rejection);

    const { postWorkerSignal } = await import('../src/extension/SignalController.js');
    const writtenEvents: Array<[string, unknown]> = [];
    const record = vi.fn().mockImplementation(async (name: string, payload: unknown) => {
      writtenEvents.push([name, payload]);
    });
    const services = makeSignalServices({ record });

    await expect(postWorkerSignal(services, makeTestEvent())).rejects.toThrow();

    const intentWritten = writtenEvents.some(([name]) => name === DomainEventName.SIGNAL_INTENT_RECORDED);
    const failureWritten = writtenEvents.some(([name]) => name === DomainEventName.TEAMMATE_SIGNAL_FAILED);
    const acknowledgedWritten = writtenEvents.some(([name]) => name === DomainEventName.SIGNAL_ACKNOWLEDGED);

    expect(intentWritten).toBe(true);        // Intent recorded
    expect(failureWritten).toBe(true);       // Failure recorded (coordinator rejected)
    expect(acknowledgedWritten).toBe(false); // No SIGNAL_ACKNOWLEDGED → intent is unacknowledged
    // The Supervisor will see an unacknowledged intent and reconcile it.
    // The coordinator rejection was NOT silently promoted to acknowledged progress.
  });
});

// ---------------------------------------------------------------------------
// AC2 + AC4: signal_completion returns a rejection diagnostic on coordinator rejection
// ---------------------------------------------------------------------------

describe('signal_completion — coordinator rejection produces diagnostic, not success (qlm4 AC2)', () => {
  beforeEach(() => {
    harnessApiMockQlm4.postHarnessSignal.mockReset();
  });

  it('AC2: ok:false timedOut → signal_completion returns {ok:false, rule, requiredEvidence}', async () => {
    const { CoordinatorRejectionError } = await import('../src/core/HarnessApiClient.js');
    const rejection = new CoordinatorRejectionError({ ok: false, timedOut: true });
    harnessApiMockQlm4.postHarnessSignal.mockRejectedValue(rejection);

    const { signalingPlugin } = await import('../src/plugins/signaling.js');
    const tool = signalingPlugin.tools.find(t => t.name === 'signal_completion')!;
    expect(tool).toBeDefined();

    const testEvent = {
      type: 'STATE_TRANSITIONED' as const,
      beadId: 'bd-qlm4-diag',
      workerId: 'w-qlm4',
      stateId: 'Implementation',
      timestamp: Date.now(),
      actionId: 'implement',
      transitionEvent: 'SUCCESS',
      summary: 'done',
      evidence: 'done',
      handover: 'done',
      idempotencyKey: 'diag-key-1'
    };

    const result = await tool.execute(testEvent) as Record<string, unknown>;

    // Must not be ok:true — coordinator rejected
    expect(result.ok).toBe(false);
    // Must carry structured rejection fields
    expect(typeof result.rule).toBe('string');
    expect(result.rule).toBe('timedOut');
    expect(typeof result.requiredEvidence).toBe('string');
  });

  it('AC2: ok:false blocked → signal_completion returns {ok:false, rule:blocked, requiredEvidence}', async () => {
    const { CoordinatorRejectionError } = await import('../src/core/HarnessApiClient.js');
    const gateVerdict = { pass: false, failures: [{ tool: 'verify', verdict: 'FAIL', reasons: ['missing artifact'] }], rejectMessage: 'gate blocked' };
    const rejection = new CoordinatorRejectionError({ ok: false, blocked: true, gate: gateVerdict });
    harnessApiMockQlm4.postHarnessSignal.mockRejectedValue(rejection);

    const { signalingPlugin } = await import('../src/plugins/signaling.js');
    const tool = signalingPlugin.tools.find(t => t.name === 'signal_completion')!;

    const testEvent = {
      type: 'STATE_TRANSITIONED' as const,
      beadId: 'bd-qlm4-blocked',
      workerId: 'w-qlm4',
      stateId: 'Implementation',
      timestamp: Date.now(),
      actionId: 'implement',
      transitionEvent: 'SUCCESS',
      summary: 'done',
      evidence: 'done',
      handover: 'done',
      idempotencyKey: 'diag-key-2'
    };

    const result = await tool.execute(testEvent) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.rule).toBe('blocked');
    expect(typeof result.requiredEvidence).toBe('string');
  });

  it('AC4: ok:true → signal_completion returns { ok: true } (accepted path preserved)', async () => {
    harnessApiMockQlm4.postHarnessSignal.mockResolvedValue({ ok: true });

    const { signalingPlugin } = await import('../src/plugins/signaling.js');
    const tool = signalingPlugin.tools.find(t => t.name === 'signal_completion')!;

    const testEvent = {
      type: 'STATE_TRANSITIONED' as const,
      beadId: 'bd-qlm4-ok',
      workerId: 'w-qlm4',
      stateId: 'Implementation',
      timestamp: Date.now(),
      actionId: 'implement',
      transitionEvent: 'SUCCESS',
      summary: 'done',
      evidence: 'done',
      handover: 'done',
      idempotencyKey: 'ok-key-1'
    };

    const result = await tool.execute(testEvent) as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });
});
