import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Observability } from '../src/core/Observability.js';
import { setProjectRoot } from '../src/core/Paths.js';

describe('Observability', () => {
  const root = path.join(os.tmpdir(), 'orr-else-observability-test');
  const configPath = path.join(root, 'harness.yaml');
  let configLoader: ConfigLoader;
  let observability: Observability;

  beforeEach(() => {
    fs.mkdirSync(path.join(root, 'state', 'logs'), { recursive: true });
    setProjectRoot(root);
    configLoader = new ConfigLoader();
    observability = new Observability(configLoader);
  });

  afterEach(() => {
    observability.shutdown();
    configLoader.reset();
    setProjectRoot(process.cwd());
  });

  it('writes spans to the default session-named JSONL file with a UUIDv7 session id', async () => {
    fs.writeFileSync(configPath, `
settings:
  maxConcurrentSlots: 1
  handoverTemplate: "handover"
  startState: Done
  defaultModel: "model"
  observability:
    dir: .pi/otel
    fileName: session-{{sessionId}}.jsonl
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
states:
  Done:
    identity: { role: done, expertise: done, constraints: [] }
    baseInstructions: done
    actions: []
    transitions: {}
`);
    configLoader.setConfigPath(configPath);

    await observability.initialize();
    const sessionId = observability.getSessionId();
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(observability.getJsonlFileName()).toBe(`session-${sessionId}.jsonl`);

    const span = observability.startSpan('test.span', { 'test.attribute': 'present' });
    observability.endSpan(span.spanId, 'ok');
    await observability.forceFlush();

    const lines = fs.readFileSync(observability.getJsonlFilePath(), 'utf8').trim().split('\n');
    const record = JSON.parse(lines[0]);
    expect(record.traceId).toBe(sessionId.replace(/-/g, ''));
    expect(record.name).toBe('test.span');
    expect(record.attributes['session.id']).toBe(sessionId);
    expect(record.attributes['observability.file.name']).toBe(`session-${sessionId}.jsonl`);
    expect(record.attributes['test.attribute']).toBe('present');
  });
});
