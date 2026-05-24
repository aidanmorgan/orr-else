import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Observability } from '../src/core/Observability.js';
import { SignalingServer } from '../src/core/SignalingServer.js';
import { EventStore } from '../src/core/EventStore.js';
import { createTeammateEventIdempotencyKey } from '../src/core/TeammateEvents.js';
import { setProjectRoot } from '../src/core/Paths.js';

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
    setProjectRoot(root);
    configLoader = new ConfigLoader();
    configLoader.setConfigPath(configPath);
    eventStore = new EventStore(configLoader);
    observability = new Observability(configLoader);
    await observability.initialize();
  });

  afterEach(() => {
    observability.shutdown();
    configLoader.reset();
    setProjectRoot(process.cwd());
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
      expect(events).toHaveLength(1);
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
});
