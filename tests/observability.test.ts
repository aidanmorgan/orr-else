import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { Observability, SpanStatusValue } from '../src/core/Observability.js';
import { setProjectRoot } from '../src/core/Paths.js';
import { EnvVars, ObservabilityDefaults, ToolResultStatus } from '../src/constants/index.js';

describe('Observability', () => {
  const root = path.join(os.tmpdir(), 'orr-else-observability-test');
  const configPath = path.join(root, 'harness.yaml');
  let configLoader: ConfigLoader;
  let observability: Observability;

  function writeHarnessConfig(): void {
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
  }

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
    writeHarnessConfig();
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
    expect(record.attributes['observability.file.name']).toBeUndefined();
    expect(record.attributes['observability.file.path']).toBeUndefined();
    expect(record.attributes['test.attribute']).toBe('present');
  });

  it('bounds noisy span attributes while preserving Orr Else correlation attributes', async () => {
    writeHarnessConfig();
    configLoader.setConfigPath(configPath);
    const previous = {
      [EnvVars.BEAD_ID]: process.env[EnvVars.BEAD_ID],
      [EnvVars.STATE_ID]: process.env[EnvVars.STATE_ID],
      [EnvVars.ACTION_ID]: process.env[EnvVars.ACTION_ID],
      [EnvVars.WORKER_ID]: process.env[EnvVars.WORKER_ID]
    };
    process.env[EnvVars.BEAD_ID] = 'bd-1';
    process.env[EnvVars.STATE_ID] = 'Planning';
    process.env[EnvVars.ACTION_ID] = 'formulate-plan';
    process.env[EnvVars.WORKER_ID] = 'worker-bd-1';

    try {
      await observability.initialize();
      const longValue = 'x'.repeat(ObservabilityDefaults.SPAN_ATTRIBUTE_MAX_CHARS + 100);
      const span = observability.startSpan('tool:tick_items', { 'tool.params': longValue });
      observability.addEvent(span.spanId, 'tool.preview', { preview: longValue });
      observability.setAttribute(span.spanId, 'tool.result.preview', longValue);
      observability.endSpan(span.spanId, SpanStatusValue.ERROR, longValue);
      await observability.forceFlush();

      const lines = fs.readFileSync(observability.getJsonlFilePath(), 'utf8').trim().split('\n');
      const record = JSON.parse(lines[0]);
      expect(record.attributes['orr_else.bead_id']).toBe('bd-1');
      expect(record.attributes['orr_else.state_id']).toBe('Planning');
      expect(record.attributes['orr_else.action_id']).toBe('formulate-plan');
      expect(record.attributes['orr_else.worker_id']).toBe('worker-bd-1');
      expect(record.attributes['tool.params'].length).toBeLessThan(longValue.length);
      expect(record.attributes['tool.params']).toContain('[truncated; chars=');
      expect(record.attributes['tool.result.preview'].length).toBeLessThan(longValue.length);
      expect(record.events[0].attributes.preview.length).toBeLessThan(longValue.length);
      expect(record.status.message.length).toBeLessThan(longValue.length);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('retains passing tool evidence after a later failed invocation', () => {
    const passingResult = { status: ToolResultStatus.PASSED, scoped: true };
    const laterFailure = { status: ToolResultStatus.REJECTED, strict: true };

    observability.recordToolInvocation('run_quality_checks', passingResult);
    observability.recordToolInvocation('run_quality_checks', laterFailure);

    expect(observability.getToolResult('run_quality_checks')).toBe(laterFailure);
    expect(observability.getPassingToolResult('run_quality_checks')).toBe(passingResult);
    expect(observability.hasToolPassed('run_quality_checks')).toBe(true);
  });
});
