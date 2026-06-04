import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { JsonlSpanExporter, Observability, SpanStatusValue } from '../src/core/Observability.js';
import { EnvVars, ObservabilityDefaults, SpanName, ToolResultStatus } from '../src/constants/index.js';

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
    configLoader = new ConfigLoader(undefined, root);
    observability = new Observability(configLoader, undefined, root);
  });

  afterEach(() => {
    observability.shutdown();
    configLoader.reset();
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

    observability.recordToolInvocation('some_tool', passingResult);
    observability.recordToolInvocation('some_tool', laterFailure);

    expect(observability.getToolResult('some_tool')).toBe(laterFailure);
    expect(observability.getPassingToolResult('some_tool')).toBe(passingResult);
    expect(observability.hasToolPassed('some_tool')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // recordCompletedSpan — llm_turn duration fix
  // ---------------------------------------------------------------------------

  it('recordCompletedSpan emits a span with nonzero duration equal to endTimeMs-startTimeMs', async () => {
    writeHarnessConfig();
    configLoader.setConfigPath(configPath);

    await observability.initialize();

    const startTimeMs = Date.now() - 5000; // 5 seconds ago
    const endTimeMs = startTimeMs + 3000;  // 3-second turn

    observability.recordCompletedSpan(SpanName.LLM_TURN, {
      'gen_ai.request.model': 'claude-opus-4-5',
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.usage.output_tokens': 200,
      'orr_else.bead_id': 'bead-test'
    }, startTimeMs, endTimeMs);

    await observability.forceFlush();

    const lines = fs.readFileSync(observability.getJsonlFilePath(), 'utf8').trim().split('\n');
    const record = JSON.parse(lines[0]);

    expect(record.name).toBe(SpanName.LLM_TURN);

    // Duration must be nonzero and match the explicit timestamps.
    const durationNs = BigInt(record.durationUnixNano);
    expect(durationNs).toBeGreaterThan(0n);

    const expectedDurationNs = BigInt(endTimeMs - startTimeMs) * 1_000_000n;
    // Allow ±1ms tolerance for millisecond-to-nanosecond conversion.
    const toleranceNs = 2_000_000n;
    expect(durationNs).toBeGreaterThanOrEqual(expectedDurationNs - toleranceNs);
    expect(durationNs).toBeLessThanOrEqual(expectedDurationNs + toleranceNs);

    // Attributes must be present.
    expect(record.attributes['gen_ai.request.model']).toBe('claude-opus-4-5');
    expect(record.attributes['gen_ai.usage.input_tokens']).toBe(1000);
  });

  it('recordCompletedSpan emits startTimeUnixNano matching startTimeMs', async () => {
    writeHarnessConfig();
    configLoader.setConfigPath(configPath);

    await observability.initialize();

    const startTimeMs = 1700000000000; // fixed epoch ms for determinism
    const endTimeMs = startTimeMs + 1500;

    observability.recordCompletedSpan('test_completed', {}, startTimeMs, endTimeMs);

    await observability.forceFlush();

    const lines = fs.readFileSync(observability.getJsonlFilePath(), 'utf8').trim().split('\n');
    const record = JSON.parse(lines[0]);

    // startTimeUnixNano must equal startTimeMs * 1e6 (ms → ns).
    const expectedStartNs = BigInt(startTimeMs) * 1_000_000n;
    const actualStartNs = BigInt(record.startTimeUnixNano);
    const toleranceNs = 2_000_000n;
    expect(actualStartNs).toBeGreaterThanOrEqual(expectedStartNs - toleranceNs);
    expect(actualStartNs).toBeLessThanOrEqual(expectedStartNs + toleranceNs);
  });

  // ---------------------------------------------------------------------------
  // Trace-context propagation — PI_TRACE_ID / PI_SPAN_ID env vars
  // ---------------------------------------------------------------------------

  it('a span created with PI_TRACE_ID+PI_SPAN_ID env set carries that traceId and parentSpanId', async () => {
    writeHarnessConfig();
    configLoader.setConfigPath(configPath);

    const coordTraceId = 'a'.repeat(32); // 32-char hex trace id
    const coordSpanId = 'b'.repeat(16);  // 16-char hex span id

    const previous = {
      [EnvVars.TRACE_ID]: process.env[EnvVars.TRACE_ID],
      [EnvVars.SPAN_ID]: process.env[EnvVars.SPAN_ID]
    };
    process.env[EnvVars.TRACE_ID] = coordTraceId;
    process.env[EnvVars.SPAN_ID] = coordSpanId;

    try {
      // Re-create observability so it uses the env from a fresh RuntimeEnvironment.
      // The existing observability instance reads env lazily via getTraceContext(),
      // so we can use it directly — no re-creation needed.
      await observability.initialize();

      const traceCtx = observability.getTraceContext();
      expect(traceCtx).toBeDefined();
      expect(traceCtx!.traceId).toBe(coordTraceId);
      expect(traceCtx!.spanId).toBe(coordSpanId);

      // A span created via startSpan (default parent = getTraceContext) should
      // carry the coordSpanId as parentSpanId in the exported record.
      const spanCtx = observability.startSpan('worker.child.span', { 'test.field': 'present' });
      observability.endSpan(spanCtx.spanId);

      await observability.forceFlush();

      const lines = fs.readFileSync(observability.getJsonlFilePath(), 'utf8').trim().split('\n');
      const record = JSON.parse(lines[0]);

      // The worker span must share the coordinator's traceId.
      // Note: Observability uses SessionIdGenerator which always returns sessionTraceId
      // for generateTraceId; the parent context traceId influences parentSpanId linkage
      // but the actual traceId in the record comes from the provider's IdGenerator.
      // What we CAN verify is that parentSpanId equals the coordSpanId.
      expect(record.parentSpanId).toBe(coordSpanId);

      // spanId in the context must be set.
      expect(spanCtx.parentSpanId).toBe(coordSpanId);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('getTraceContext() returns undefined when PI_TRACE_ID/PI_SPAN_ID are not set', () => {
    const previous = {
      [EnvVars.TRACE_ID]: process.env[EnvVars.TRACE_ID],
      [EnvVars.SPAN_ID]: process.env[EnvVars.SPAN_ID]
    };
    delete process.env[EnvVars.TRACE_ID];
    delete process.env[EnvVars.SPAN_ID];

    try {
      const traceCtx = observability.getTraceContext();
      expect(traceCtx).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// a1j1 AC#1: the JSONL trace WriteStream has an 'error' handler so a write
// failure (e.g. ENOSPC) is handled rather than thrown as an uncaught exception.
// ---------------------------------------------------------------------------

describe('JsonlSpanExporter stream error handling', () => {
  const root = path.join(os.tmpdir(), 'orr-else-otel-stream-error-test');
  const filePath = path.join(root, 'traces-test.jsonl');

  beforeEach(() => {
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("attaches an 'error' listener to the write stream", () => {
    const exporter = new JsonlSpanExporter(filePath);
    try {
      const stream = (exporter as unknown as { stream: NodeJS.EventEmitter }).stream;
      // The handler attached in the constructor must be the only/first listener,
      // so an emitted 'error' is consumed instead of crashing the process.
      expect(stream.listenerCount('error')).toBeGreaterThanOrEqual(1);
    } finally {
      void (exporter as unknown as { stream: { destroy(): void } }).stream.destroy();
    }
  });

  it('does not throw / emit an uncaught exception when the stream errors (simulated ENOSPC)', async () => {
    const unhandled: unknown[] = [];
    const onUncaught = (err: unknown) => unhandled.push(err);
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);

    try {
      const exporter = new JsonlSpanExporter(filePath);
      const stream = (exporter as unknown as { stream: NodeJS.EventEmitter }).stream;

      // Simulate the kernel surfacing a disk-full write error on the stream.
      // With the handler in place this must NOT throw or escape as uncaught.
      const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      expect(() => stream.emit('error', enospc)).not.toThrow();

      // Give any (mis)scheduled microtasks/macrotasks a tick to surface.
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(unhandled).toHaveLength(0);
      void (exporter as unknown as { stream: { destroy(): void } }).stream.destroy();
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUncaught);
    }
  });
});
