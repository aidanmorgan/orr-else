import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Observability } from '../src/core/Observability.js';
import { SignalingServer } from '../src/core/SignalingServer.js';
import { EventStore } from '../src/core/EventStore.js';
import { createTeammateEventIdempotencyKey } from '../src/core/TeammateEvents.js';
import { EnvVars, BuiltInToolName, DomainEventName } from '../src/constants/index.js';
import type { RuntimeEnvironment } from '../src/core/RuntimeEnvironment.js';
import type { SignalAck } from '../src/core/SignalingServer.js';

vi.mock('../src/core/HarnessApiClient.js', () => ({
  postHarnessSignal: vi.fn().mockResolvedValue({ ok: true })
}));

function eventBody(overrides: Record<string, unknown> = {}) {
  const base = {
    type: 'STATE_TRANSITIONED' as const,
    beadId: 'pi-experiment-proof',
    workerId: 'worker-1',
    stateId: 'Planning',
    timestamp: 1_779_000_000_000,
    actionId: 'formulate-plan',
    transitionEvent: 'SUCCESS',
    summary: 'done',
    evidence: 'Phase-wide evidence recorded by submit_checkpoint.',
    handover: 'Handover recorded by submit_checkpoint.'
  };
  return {
    ...base,
    idempotencyKey: createTeammateEventIdempotencyKey(base),
    ...overrides
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  assertion();
}

function runtimeEnvironment(vars: Record<string, string | undefined>): RuntimeEnvironment {
  return {
    env: (name: string): string | undefined => vars[name]
  };
}

describe('SignalingServer', () => {
  const root = path.join(os.tmpdir(), 'orr-else-signaling-test');
  const configPath = path.join(root, 'harness.yaml');
  let configLoader: ConfigLoader;
  let eventStore: EventStore;
  let observability: Observability;

  beforeEach(async () => {
    fs.mkdirSync(path.join(root, 'state', 'logs'), { recursive: true });
    fs.writeFileSync(configPath, `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "handover"
  startState: Done
  defaultModel: "model"
  eventStore:
    enabled: false
  observability:
    enabled: false
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [completed]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]

states:
  Done:
    identity: { role: done, expertise: done, constraints: [] }
    baseInstructions: done
    actions:
      - id: a1
        type: prompt
    transitions: {}
`);
    configLoader = new ConfigLoader(undefined, root);
    configLoader.setConfigPath(configPath);
    eventStore = new EventStore(configLoader, undefined, undefined, root);
    observability = new Observability(configLoader, undefined, root);
    await observability.initialize();
  });

  afterEach(() => {
    observability.shutdown();
    configLoader.reset();
  });

  it('accepts typed teammate events and heartbeats', async () => {
    const events: any[] = [];
    const server = new SignalingServer(event => {
      events.push(event);
    }, observability, eventStore, 39000 + (process.pid % 1000));
    const port = await server.start();

    try {
      const signalResponse = await fetch(`http://127.0.0.1:${port}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventBody())
      });
      expect(signalResponse.ok).toBe(true);
      await waitFor(() => expect(events).toHaveLength(1));
      expect(events[0].beadId).toBe('pi-experiment-proof');
      expect(events[0].idempotencyKey).toContain('STATE_TRANSITIONED');

      const heartbeatResponse = await fetch(`http://127.0.0.1:${port}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: 12345, workerId: 'worker-heartbeat' })
      });
      expect(heartbeatResponse.ok).toBe(true);

      const heartbeats = await fetch(`http://127.0.0.1:${port}/heartbeats`).then(res => res.json());
      expect(heartbeats['worker-heartbeat']).toBeTypeOf('number');
    } finally {
      server.stop();
    }
  });

  it('uses injected runtime API_PORT when no explicit port is provided', async () => {
    const expectedPort = 39400 + (process.pid % 1000);
    const server = new SignalingServer(() => {}, observability, eventStore, {
      runtimeEnvironment: runtimeEnvironment({ [EnvVars.API_PORT]: String(expectedPort) })
    });
    const port = await server.start();

    try {
      expect(port).toBe(expectedPort);
    } finally {
      server.stop();
    }
  });

  it('uses explicit port over injected runtime API_PORT', async () => {
    const explicitPort = 39500 + (process.pid % 1000);
    const runtimePort = explicitPort + 100;
    const server = new SignalingServer(() => {}, observability, eventStore, {
      port: explicitPort,
      runtimeEnvironment: runtimeEnvironment({ [EnvVars.API_PORT]: String(runtimePort) })
    });
    const port = await server.start();

    try {
      expect(port).toBe(explicitPort);
    } finally {
      server.stop();
    }
  });

  it('responds to valid non-heartbeat signals before slow coordinator side effects finish', async () => {
    const events: any[] = [];
    let markHandlerEntered: () => void = () => {};
    let releaseHandler: () => void = () => {};
    const handlerEntered = new Promise<void>(resolve => {
      markHandlerEntered = resolve;
    });
    const server = new SignalingServer(async event => {
      events.push(event);
      markHandlerEntered();
      await new Promise<void>(release => {
        releaseHandler = release;
      });
    }, observability, eventStore, 39300 + (process.pid % 1000));
    const port = await server.start();

    try {
      const responsePromise = fetch(`http://127.0.0.1:${port}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventBody())
      });
      await handlerEntered;
      const first = await Promise.race([
        responsePromise.then(response => response.ok ? 'response' : `status:${response.status}`),
        new Promise(resolve => setTimeout(() => resolve('timeout'), 500))
      ]);
      expect(first).toBe('response');
      expect(events).toHaveLength(1);
    } finally {
      releaseHandler();
      server.stop();
    }
  });

  it('serializes async signal handling per bead so duplicate retries cannot interleave (xmp3)', async () => {
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    const server = new SignalingServer(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 60));
      active--;
      completed++;
    }, observability, eventStore, 39500 + (process.pid % 1000));
    const port = await server.start();
    try {
      // Two POSTs of the SAME signal (same beadId + idempotencyKey) — a network-retry duplicate.
      const body = JSON.stringify(eventBody());
      const headers = { 'Content-Type': 'application/json' };
      await Promise.all([
        fetch(`http://127.0.0.1:${port}/signals`, { method: 'POST', headers, body }),
        fetch(`http://127.0.0.1:${port}/signals`, { method: 'POST', headers, body })
      ]);
      // Wait until both fire-and-forget handlers have run.
      await waitFor(() => expect(completed).toBe(2));
      // They must NEVER have executed concurrently for the same bead.
      expect(maxActive).toBe(1);
    } finally {
      server.stop();
    }
  });

  it('rejects malformed typed events without invoking the handler', async () => {
    const events: any[] = [];
    const server = new SignalingServer(event => {
      events.push(event);
    }, observability, eventStore, 39100 + (process.pid % 1000));
    const port = await server.start();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventBody({ idempotencyKey: '' }))
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error');
      expect(events).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  it('returns 400 for syntactically invalid JSON signal requests without invoking the handler', async () => {
    const events: any[] = [];
    const server = new SignalingServer(event => {
      events.push(event);
    }, observability, eventStore, 39200 + (process.pid % 1000));
    const port = await server.start();

    try {
      for (const path of ['/signal', '/signals', '/events']) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{not valid json'
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toHaveProperty('error');
      }
      expect(events).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  describe('custom event taxonomy via config.statechart.customEvents', () => {
    function customEventBody(type: string, overrides: Record<string, unknown> = {}) {
      const base = {
        type,
        beadId: 'pi-experiment-proof',
        workerId: 'worker-1',
        stateId: 'Done',
        timestamp: Date.now()
      };
      return {
        ...base,
        idempotencyKey: createTeammateEventIdempotencyKey(base),
        ...overrides
      };
    }

    it('accepts a custom event type when allowedCustomEvents includes it', async () => {
      const events: any[] = [];
      // Simulate config.statechart.customEvents = ['DOMAIN_CHECK']
      const server = new SignalingServer(event => {
        events.push(event);
      }, observability, eventStore, {
        port: 39600 + (process.pid % 1000),
        allowedCustomEvents: ['DOMAIN_CHECK']
      });
      const port = await server.start();

      try {
        const response = await fetch(`http://127.0.0.1:${port}/signals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(customEventBody('DOMAIN_CHECK'))
        });

        expect(response.ok).toBe(true);
        await waitFor(() => expect(events).toHaveLength(1));
        expect(events[0].type).toBe('DOMAIN_CHECK');
      } finally {
        server.stop();
      }
    });

    it('rejects an undeclared custom event type when no allowedCustomEvents are configured', async () => {
      const events: any[] = [];
      // No allowedCustomEvents — mirrors a config without statechart.customEvents
      const server = new SignalingServer(event => {
        events.push(event);
      }, observability, eventStore, 39700 + (process.pid % 1000));
      const port = await server.start();

      try {
        const response = await fetch(`http://127.0.0.1:${port}/signals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(customEventBody('DOMAIN_CHECK'))
        });

        expect(response.status).toBe(400);
        const body = await response.json() as { error?: string };
        expect(body.error).toContain('Invalid event type');
        expect(events).toHaveLength(0);
      } finally {
        server.stop();
      }
    });

    it('rejects a custom event not present in the allowedCustomEvents list', async () => {
      const events: any[] = [];
      const server = new SignalingServer(event => {
        events.push(event);
      }, observability, eventStore, {
        port: 39800 + (process.pid % 1000),
        allowedCustomEvents: ['PIPELINE_VERIFIED']
      });
      const port = await server.start();

      try {
        const response = await fetch(`http://127.0.0.1:${port}/signals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(customEventBody('ROGUE_EVENT'))
        });

        expect(response.status).toBe(400);
        const body = await response.json() as { error?: string };
        expect(body.error).toContain('Invalid event type');
        expect(events).toHaveLength(0);
      } finally {
        server.stop();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Held-ack timeout (pi-experiment-f5h6)
  //
  // A handler that calls ack.hold() but never calls ack.send() must not hang
  // the HTTP request indefinitely. The server must time out the deferred
  // response, record TEAMMATE_SIGNAL_FAILED with held-timeout metadata, and
  // return a retryable failure response to the caller.
  // ---------------------------------------------------------------------------

  describe('held-ack timeout (f5h6)', () => {
    // AC1 + AC2: a handler that holds and then hangs (never calls send) returns
    // within the configured timeout and records TEAMMATE_SIGNAL_FAILED with
    // held=true metadata.
    it('AC1+AC2: hold-and-never-send returns within timeout and records TEAMMATE_SIGNAL_FAILED with held metadata', async () => {
      const recordedEvents: Array<{ name: string; payload: unknown }> = [];
      const originalRecord = eventStore.record.bind(eventStore);
      vi.spyOn(eventStore, 'record').mockImplementation(async (name, payload) => {
        recordedEvents.push({ name, payload });
        return originalRecord(name, payload);
      });

      const heldAckTimeoutMs = 150;
      const server = new SignalingServer(
        async (_event, ack: SignalAck) => {
          // Call hold() then await something that never resolves — simulates a
          // hung gated handler that acquired the deferred response but stalled.
          ack.hold();
          await new Promise<void>(() => {}); // intentionally never resolves
        },
        observability,
        eventStore,
        { port: 39900 + (process.pid % 1000), heldAckTimeoutMs }
      );
      const port = await server.start();

      try {
        const before = Date.now();
        const response = await fetch(`http://127.0.0.1:${port}/signals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(eventBody())
        });
        const elapsed = Date.now() - before;

        // AC1: request must resolve within a bounded time (timeout + generous buffer)
        expect(elapsed).toBeLessThan(heldAckTimeoutMs + 1000);

        // AC2: response must be a retryable failure verdict
        const body = await response.json() as Record<string, unknown>;
        expect(body.ok).toBe(false);

        // AC2: TEAMMATE_SIGNAL_FAILED must be recorded with held-timeout metadata
        await waitFor(() => {
          const failed = recordedEvents.find(e => e.name === DomainEventName.TEAMMATE_SIGNAL_FAILED);
          expect(failed).toBeDefined();
          const p = failed!.payload as Record<string, unknown>;
          expect(p.held).toBe(true);
          expect(p.timeoutMs).toBe(heldAckTimeoutMs);
          expect(p.beadId).toBe('pi-experiment-proof');
          expect(p.stateId).toBe('Planning');
          expect(p.workerId).toBe('worker-1');
          expect(p.type).toBe('STATE_TRANSITIONED');
          expect(typeof p.idempotencyKey).toBe('string');
        });
      } finally {
        server.stop();
        vi.restoreAllMocks();
      }
    });

    // AC3: a held handler that DOES call send() still returns the verifier verdict.
    it('AC3: held handler that calls send() returns the verifier verdict normally', async () => {
      const server = new SignalingServer(
        async (_event, ack: SignalAck) => {
          ack.hold();
          // Simulate async gate work then resolve with a verdict
          await new Promise(resolve => setTimeout(resolve, 20));
          ack.send({ pass: true, failures: [], rejectMessage: '' });
        },
        observability,
        eventStore,
        { port: 39910 + (process.pid % 1000), heldAckTimeoutMs: 500 }
      );
      const port = await server.start();

      try {
        const response = await fetch(`http://127.0.0.1:${port}/signals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(eventBody())
        });
        const body = await response.json() as Record<string, unknown>;
        // Must carry the gate verdict (pass: true)
        expect(body.ok).toBe(true);
        expect((body.gate as Record<string, unknown>).pass).toBe(true);
      } finally {
        server.stop();
      }
    });

    // Timer-cleanup guard: the held-ack timeout handle must be cleared via
    // clearTimeout() on BOTH the success path (send() wins the race) and the
    // timeout path (timer fires first). Without the fix, the timer outlives the
    // race and pins the Node event loop for 25 s on every held-success signal.
    //
    // Strategy: spy on BOTH globalThis.setTimeout and globalThis.clearTimeout.
    // Identify the held-ack timer by filtering setTimeout calls for the one whose
    // delay === heldAckTimeoutMs, capture its return value (the timer handle), and
    // assert clearTimeout was called WITH THAT EXACT HANDLE. This is immune to
    // Node internals calling clearTimeout for their own socket/HTTP timers.
    it('timer-cleanup: clearTimeout is called after held success (timer must not outlive the race)', async () => {
      const heldAckTimeoutMs = 500;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      const server = new SignalingServer(
        async (_event, ack: SignalAck) => {
          ack.hold();
          await new Promise(resolve => setTimeout(resolve, 10));
          ack.send({ pass: true, failures: [], rejectMessage: '' });
        },
        observability,
        eventStore,
        { port: 39930 + (process.pid % 1000), heldAckTimeoutMs }
      );
      const port = await server.start();

      try {
        const response = await fetch(`http://127.0.0.1:${port}/signals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(eventBody())
        });
        expect(response.ok).toBe(true);

        // Find the held-ack timer: the setTimeout call whose delay === heldAckTimeoutMs.
        const heldAckCall = setTimeoutSpy.mock.results.find(
          (_r, i) => setTimeoutSpy.mock.calls[i]?.[1] === heldAckTimeoutMs
        );
        expect(heldAckCall).toBeDefined(); // sanity: the timer must have been set
        const heldTimerHandle = heldAckCall!.value;

        // clearTimeout must have been called with the exact held-ack handle.
        // Node's own HTTP/socket internals never receive this handle, so this
        // assertion fails precisely when clearTimeout(heldTimer) is removed.
        expect(clearTimeoutSpy.mock.calls.flat()).toContain(heldTimerHandle);
      } finally {
        server.stop();
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    });

    it('timer-cleanup: clearTimeout is called after held timeout (timer handle must be cleared even on the timeout path)', async () => {
      const heldAckTimeoutMs = 80;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      const server = new SignalingServer(
        async (_event, ack: SignalAck) => {
          ack.hold();
          await new Promise<void>(() => {}); // never resolves
        },
        observability,
        eventStore,
        { port: 39940 + (process.pid % 1000), heldAckTimeoutMs }
      );
      const port = await server.start();

      try {
        const response = await fetch(`http://127.0.0.1:${port}/signals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(eventBody())
        });
        const body = await response.json() as Record<string, unknown>;
        expect(body.ok).toBe(false);

        // Find the held-ack timer: the setTimeout call whose delay === heldAckTimeoutMs.
        const heldAckCall = setTimeoutSpy.mock.results.find(
          (_r, i) => setTimeoutSpy.mock.calls[i]?.[1] === heldAckTimeoutMs
        );
        expect(heldAckCall).toBeDefined(); // sanity: the timer must have been set
        const heldTimerHandle = heldAckCall!.value;

        // Even though the timer fired (timedOut path), clearTimeout must still be
        // called in the finally block with the exact handle — ensuring it's released.
        // Node's own internals never receive this handle, so this fails precisely
        // when clearTimeout(heldTimer) is removed from the finally block.
        expect(clearTimeoutSpy.mock.calls.flat()).toContain(heldTimerHandle);
      } finally {
        server.stop();
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    });

    // AC4: non-held signals respond immediately (fire-and-forget) — unaffected.
    it('AC4: non-held signals respond immediately without waiting for the handler', async () => {
      let markHandlerEntered: () => void = () => {};
      let releaseHandler: () => void = () => {};
      const handlerEntered = new Promise<void>(resolve => { markHandlerEntered = resolve; });

      const server = new SignalingServer(
        async () => {
          markHandlerEntered();
          // Block for much longer than any timeout — must not affect response time.
          await new Promise<void>(resolve => { releaseHandler = resolve; });
        },
        observability,
        eventStore,
        { port: 39920 + (process.pid % 1000), heldAckTimeoutMs: 100 }
      );
      const port = await server.start();

      try {
        const responsePromise = fetch(`http://127.0.0.1:${port}/signals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(eventBody())
        });
        await handlerEntered;
        const first = await Promise.race([
          responsePromise.then(r => r.ok ? 'response' : `status:${r.status}`),
          new Promise(resolve => setTimeout(() => resolve('timeout'), 500))
        ]);
        // Fire-and-forget: response must arrive before the handler finishes.
        expect(first).toBe('response');
      } finally {
        releaseHandler();
        server.stop();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // r06o: coalesce repeated invalid-event log noise (AC2)
  //
  // Repeated malformed payloads from the same source must produce ONE Logger.warn
  // plus an aggregate count.  The HTTP 400 response is returned for every request
  // (no suppression at the HTTP layer).
  // ---------------------------------------------------------------------------

  describe('r06o: coalesce repeated invalid-event log noise (AC2)', () => {
    it('AC2: repeated malformed payloads warn once then suppress log noise; every HTTP response is still 400', async () => {
      const warnCalls: Array<unknown[]> = [];
      const { Logger } = await import('../src/core/Logger.js');
      const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation((...args) => {
        warnCalls.push(args);
      });

      const server = new SignalingServer(
        () => {},
        observability,
        eventStore,
        { port: 39950 + (process.pid % 1000) }
      );
      const port = await server.start();

      try {
        // Post the SAME malformed payload 5 times (missing workerId → fails validation)
        const malformedBody = {
          type: 'STATE_TRANSITIONED',
          beadId: 'bead-noisy',
          stateId: 'Planning',
          timestamp: 12345,
          idempotencyKey: 'key-noisy'
          // workerId intentionally absent → validation failure
        };

        const responses: Response[] = [];
        for (let i = 0; i < 5; i++) {
          const r = await fetch(`http://127.0.0.1:${port}/signals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(malformedBody)
          });
          responses.push(r);
        }

        // All 5 HTTP responses must be 400 (not suppressed)
        for (const r of responses) {
          expect(r.status).toBe(400);
        }

        // Only ONE 'Invalid teammate event received' warn must be logged for the
        // repeated fingerprint; subsequent ones are coalesced into an aggregate.
        const invalidEventWarns = warnCalls.filter(args =>
          typeof args[1] === 'string' && args[1].includes('Invalid teammate event received')
        );
        expect(invalidEventWarns).toHaveLength(1);
      } finally {
        server.stop();
        warnSpy.mockRestore();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// signalingPlugin — no-cap minimal schema fixture (s3wp.27e)
//
// Verifies that the SIGNAL_COMPLETION tool result is always a compact
// structured schema with no inline content, preview, or byte-cap fields.
// ---------------------------------------------------------------------------

import { signalingPlugin } from '../src/plugins/signaling.js';
import { postHarnessSignal } from '../src/core/HarnessApiClient.js';

describe('signalingPlugin — no-cap minimal schema (s3wp.27e)', () => {
  it('SIGNAL_COMPLETION result returns only { ok } with no preview/cap fields', async () => {
    vi.mocked(postHarnessSignal).mockResolvedValue({ ok: true });

    const tool = signalingPlugin.tools.find(t => t.name === BuiltInToolName.SIGNAL_COMPLETION)!;
    expect(tool).toBeDefined();

    const testEvent = {
      type: 'STATE_TRANSITIONED' as const,
      beadId: 'test-bead',
      workerId: 'worker-1',
      stateId: 'Planning',
      timestamp: Date.now(),
      actionId: 'test-action',
      transitionEvent: 'SUCCESS',
      summary: 'done',
      evidence: 'evidence',
      handover: 'handover',
      idempotencyKey: 'test-key'
    };

    const result = await tool.execute(testEvent) as Record<string, unknown>;

    // Must be a structured result, not null
    expect(result).not.toBeNull();
    expect(typeof result).toBe('object');

    // The returned shape is { ok: boolean }
    expect(result.ok).toBe(true);

    // Must NOT contain any inline content, preview, truncation, or byte-cap fields
    expect(result).not.toHaveProperty('outputPreview');
    expect(result).not.toHaveProperty('resultPreview');
    expect(result).not.toHaveProperty('diagnosticPreview');
    expect(result).not.toHaveProperty('truncated');
    expect(result).not.toHaveProperty('stdoutTruncated');
    expect(result).not.toHaveProperty('stderrTruncated');
    expect(result).not.toHaveProperty('outputArchive');
    expect(result).not.toHaveProperty('structuredResult');
    expect(result).not.toHaveProperty('byteCap');
    expect(result).not.toHaveProperty('outputLimit');

    // Only allowed key: ok
    const allowedKeys = new Set(['ok']);
    for (const key of Object.keys(result)) {
      expect(allowedKeys).toContain(key);
    }
  });
});
