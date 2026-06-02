import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Observability } from '../src/core/Observability.js';
import { SignalingServer } from '../src/core/SignalingServer.js';
import { EventStore } from '../src/core/EventStore.js';
import { createTeammateEventIdempotencyKey } from '../src/core/TeammateEvents.js';
import { EnvVars, BuiltInToolName } from '../src/constants/index.js';
import type { RuntimeEnvironment } from '../src/core/RuntimeEnvironment.js';

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
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Done:
    identity: { role: done, expertise: done, constraints: [] }
    baseInstructions: done
    actions: []
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
