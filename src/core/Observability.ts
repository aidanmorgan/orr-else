import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import {
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  context,
  trace,
  type Attributes,
  type Span as OtelSpan
} from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  RandomIdGenerator,
  SimpleSpanProcessor,
  type IdGenerator,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor
} from '@opentelemetry/sdk-trace-base';
import { v7 as uuidv7 } from 'uuid';
import { ConfigLoader } from './ConfigLoader.js';
import { nodeLogger as Logger } from './Logger.js'
import { resolveProjectFrom } from './Paths.js';
import { isRecord } from './RecordUtils.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from './RuntimeEnvironment.js';
import { App, ToolResultStatus } from '../constants/domain.js';
import { Component, EnvVars, Numeric, ObservabilityDefaults, OperationalArtifactPath, OtelAttr } from '../constants/infra.js';

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

export const SpanStatusValue = {
  OK: 'ok',
  ERROR: 'error'
} as const;

export type SpanStatus = typeof SpanStatusValue[keyof typeof SpanStatusValue];
export interface SpanCompletion {
  status: SpanStatus;
  message?: string;
}

type ToolInvocationResult = {
  success?: unknown;
  status?: unknown;
};

class SessionIdGenerator implements IdGenerator {
  private readonly random = new RandomIdGenerator();

  constructor(private readonly traceId: string) {}

  generateTraceId(): string {
    return this.traceId;
  }

  generateSpanId(): string {
    return this.random.generateSpanId();
  }
}

/**
 * Exported for testability: the gate-before-reclaim/ENOSPC error-handler test
 * (a1j1 AC#1) constructs an exporter and simulates a stream 'error' event to
 * assert the handler swallows it rather than crashing the process.
 *
 * The stream is created lazily on first span write so that sessions with no
 * spans leave no zero-byte trace file (rhne). Absence of a file means no spans;
 * presence means the file contains at least one valid JSONL span record.
 */
export class JsonlSpanExporter implements SpanExporter {
  // Null until the first span is written (lazy creation).
  stream: fs.WriteStream | null = null;

  constructor(private readonly filePath: string) {}

  private getOrCreateStream(): fs.WriteStream {
    if (!this.stream) {
      this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
      // A WriteStream with no 'error' listener re-throws as an uncaught exception
      // when the underlying write fails (e.g. ENOSPC on a full disk), crashing the
      // process. Observability is best-effort telemetry: log and swallow the error
      // so a failed trace write never takes down the harness.
      this.stream.on('error', error => {
        Logger.warn(Component.OBSERVABILITY, 'OTEL JSONL trace stream write failed', {
          filePath: this.filePath,
          error: String(error)
        });
      });
    }
    return this.stream;
  }

  export(spans: ReadableSpan[], resultCallback: (result: { code: ExportResultCode; error?: Error }) => void): void {
    if (spans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    try {
      const stream = this.getOrCreateStream();
      for (const span of spans) {
        stream.write(`${JSON.stringify(this.serialize(span))}\n`);
      }
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  async shutdown(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>(resolve => {
      this.stream!.end(() => resolve());
    });
  }

  async forceFlush(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>((resolve, reject) => {
      this.stream!.write('', error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private serialize(span: ReadableSpan) {
    const spanContext = span.spanContext();
    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      parentSpanId: span.parentSpanContext?.spanId,
      name: span.name,
      kind: span.kind,
      startTimeUnixNano: hrTimeToUnixNano(span.startTime),
      endTimeUnixNano: hrTimeToUnixNano(span.endTime),
      durationUnixNano: hrTimeToUnixNano(span.duration),
      status: span.status,
      attributes: span.attributes,
      events: span.events.map(event => ({
        name: event.name,
        timeUnixNano: hrTimeToUnixNano(event.time),
        attributes: event.attributes
      })),
      resource: span.resource.attributes,
      instrumentationScope: span.instrumentationScope
    };
  }
}

function hrTimeToUnixNano(hrTime: [number, number]): string {
  return (BigInt(hrTime[0]) * Numeric.NANOSECONDS_PER_SECOND + BigInt(hrTime[1])).toString();
}

function compactSpanString(value: string): string {
  if (value.length <= ObservabilityDefaults.SPAN_ATTRIBUTE_MAX_CHARS) return value;
  return `${value.slice(0, ObservabilityDefaults.SPAN_ATTRIBUTE_MAX_CHARS)}... [truncated; chars=${value.length}]`;
}

function cleanAttributeValue(value: string | number | boolean | undefined): string | number | boolean | undefined {
  if (typeof value === 'string') return compactSpanString(value);
  return value;
}

function cleanAttributes(attributes: SpanAttributes): Attributes {
  return Object.fromEntries(
    Object.entries(attributes)
      .map(([key, value]) => [key, cleanAttributeValue(value)] as const)
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
  );
}

/**
 * OpenTelemetry-backed observability for Orr Else.
 * Defaults to a single JSONL file per Pi process under .pi/otel.
 */
export class Observability {
  private readonly sessionId: string;
  private readonly sessionStateId: string | null;
  private readonly sessionTraceId: string;
  private readonly contextStorage = new AsyncLocalStorage<SpanContext>();
  private readonly activeSpans: Map<string, OtelSpan> = new Map();
  private readonly calledTools: Set<string> = new Set();
  private readonly toolResults: Map<string, unknown> = new Map();
  private readonly passingToolResults: Map<string, unknown> = new Map();

  private provider: BasicTracerProvider | null = null;
  private tracer = trace.getTracer(App.TRACER_NAME, App.VERSION);
  private currentConfigKey: string | null = null;
  private currentFileName: string | null = null;
  private currentFilePath: string | null = null;

  constructor(
    private readonly configLoader: ConfigLoader,
    private readonly env: RuntimeEnvironment = nodeRuntimeEnvironment,
    private readonly injectedProjectRoot: string = process.cwd(),
    // Injected so the 'process.pid' span attribute is deterministic under test
    // rather than read from the global directly (pf7v).
    private readonly pid: number = process.pid
  ) {
    this.sessionId = this.env.env(EnvVars.OBSERVABILITY_SESSION_ID) || uuidv7();
    this.sessionStateId = this.env.env(EnvVars.SESSION_STATE_ID) || null;
    this.sessionTraceId = this.sessionId.replace(/-/g, '');
  }

  public async initialize(): Promise<void> {
    await this.init();
  }

  public recordToolInvocation(name: string, result?: unknown) {
    this.calledTools.add(name);
    if (result !== undefined) {
      this.toolResults.set(name, result);
      if (this.toolResultPassed(result)) {
        this.passingToolResults.set(name, result);
      }
    }
  }

  public getCalledTools(): string[] {
    return Array.from(this.calledTools);
  }

  public getToolResult(name: string): unknown {
    return this.toolResults.get(name);
  }

  public getPassingToolResult(name: string): unknown {
    return this.passingToolResults.get(name);
  }

  public hasToolPassed(name: string): boolean {
    return this.passingToolResults.has(name);
  }

  public getJsonlFileName(): string {
    return this.currentFileName || this.resolveFileName();
  }

  public getJsonlFilePath(): string {
    if (this.currentFilePath) return this.currentFilePath;
    return path.join(this.resolveOtelDir(), this.getJsonlFileName());
  }

  /**
   * Resolve the PROJECT_ROOT for artifact resolution. The injected env
   * PROJECT_ROOT wins (consistent with ArtifactPaths/bd precedence), then the
   * constructor-injected root — never a process.cwd()-relative join.
   */
  private projectRoot(): string {
    return this.env.env(EnvVars.PROJECT_ROOT) || this.injectedProjectRoot;
  }

  /**
   * Resolve the OTel JSONL directory against the injected PROJECT_ROOT via the
   * OperationalArtifactPath constant. The observability.dir config setting may
   * override the directory name (absolute paths are honored as-is); when unset it
   * falls back to OperationalArtifactPath.PI_OTEL_DIR — never a bare literal.
   */
  private resolveOtelDir(configuredDir?: string): string {
    const dir = configuredDir || OperationalArtifactPath.PI_OTEL_DIR;
    return path.isAbsolute(dir) ? dir : resolveProjectFrom(this.projectRoot(), dir);
  }

  private toolResultPassed(result: unknown): boolean {
    if (!isRecord(result)) return false;
    const toolResult = result as ToolInvocationResult;
    return toolResult.success === true || toolResult.status === ToolResultStatus.PASSED;
  }

  private async init(): Promise<boolean> {
    const config = await this.configLoader.load();
    const observability = config.settings.observability;
    if (observability?.enabled === false) {
      this.shutdown();
      return false;
    }

    const absoluteDir = this.resolveOtelDir(observability?.dir);
    const fileName = this.resolveFileName(observability?.fileName);
    const filePath = path.join(absoluteDir, fileName);
    const collector = observability?.collector;
    const configKey = JSON.stringify({
      filePath,
      collector: collector
        ? {
            endpoint: collector.endpoint,
            headers: collector.headers || {},
            timeoutMs: collector.timeoutMs || ObservabilityDefaults.COLLECTOR_TIMEOUT_MS
          }
        : null
    });

    if (this.provider && this.currentConfigKey === configKey) return true;

    this.shutdown();
    if (!fs.existsSync(absoluteDir)) {
      fs.mkdirSync(absoluteDir, { recursive: true });
    }

    const spanProcessors: SpanProcessor[] = [
      new SimpleSpanProcessor(new JsonlSpanExporter(filePath))
    ];

    if (collector?.endpoint) {
      spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({
        url: collector.endpoint,
        headers: collector.headers || {},
        timeoutMillis: collector.timeoutMs || ObservabilityDefaults.COLLECTOR_TIMEOUT_MS
      })));
    }

    this.provider = new BasicTracerProvider({
      idGenerator: new SessionIdGenerator(this.sessionTraceId),
      spanProcessors
    });
    this.tracer = this.provider.getTracer(App.TRACER_NAME, App.VERSION);
    this.currentConfigKey = configKey;
    this.currentFileName = fileName;
    this.currentFilePath = filePath;

    Logger.debug(Component.OBSERVABILITY, 'Initialized OpenTelemetry observability', {
      sessionId: this.sessionId,
      filePath,
      collectorEndpoint: collector?.endpoint
    });

    return true;
  }

  public startSpan(name: string, attributes: SpanAttributes = {}, parentContext?: SpanContext): SpanContext {
    const parent = parentContext || this.getTraceContext();
    const parentOtelContext = parent
      ? trace.setSpanContext(context.active(), {
          traceId: parent.traceId,
          spanId: parent.spanId,
          traceFlags: TraceFlags.SAMPLED,
          isRemote: true
        })
      : undefined;

    const span = this.tracer.startSpan(
      name,
      {
        kind: SpanKind.INTERNAL,
        attributes: cleanAttributes({
          'service.name': App.SERVICE_NAME,
          'service.instance.id': this.sessionId,
          'session.id': this.sessionId,
          'session.state_id': this.sessionStateId || undefined,
          [OtelAttr.ORR_ELSE_BEAD_ID]: this.env.env(EnvVars.BEAD_ID) || undefined,
          [OtelAttr.ORR_ELSE_STATE_ID]: this.env.env(EnvVars.STATE_ID) || undefined,
          [OtelAttr.ORR_ELSE_ACTION_ID]: this.env.env(EnvVars.ACTION_ID) || undefined,
          [OtelAttr.ORR_ELSE_WORKER_ID]: this.env.env(EnvVars.WORKER_ID) || undefined,
          'process.pid': this.pid,
          ...attributes
        })
      },
      parentOtelContext
    );
    const spanContext = span.spanContext();
    const contextValue = {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      parentSpanId: parent?.spanId
    };

    this.activeSpans.set(spanContext.spanId, span);
    return contextValue;
  }

  /**
   * Record a span whose start and end timestamps are known in advance (e.g. an
   * LLM turn recorded after the fact with exact token-usage timing).
   *
   * Unlike startSpan+endSpan, both timestamps are set explicitly so the
   * exported duration = endTimeMs - startTimeMs, regardless of wall-clock drift
   * between the JS event loop and the OTel SDK.
   *
   * @param name        Span name — use a SpanName constant.
   * @param attributes  Span attributes merged on top of the standard session attrs.
   * @param startTimeMs Unix epoch milliseconds for the span start.
   * @param endTimeMs   Unix epoch milliseconds for the span end (must be ≥ startTimeMs).
   * @param parentContext Optional explicit parent; falls back to getTraceContext().
   */
  public recordCompletedSpan(
    name: string,
    attributes: SpanAttributes,
    startTimeMs: number,
    endTimeMs: number,
    parentContext?: SpanContext
  ): void {
    const parent = parentContext || this.getTraceContext();
    const parentOtelContext = parent
      ? trace.setSpanContext(context.active(), {
          traceId: parent.traceId,
          spanId: parent.spanId,
          traceFlags: TraceFlags.SAMPLED,
          isRemote: true
        })
      : undefined;

    const span = this.tracer.startSpan(
      name,
      {
        kind: SpanKind.INTERNAL,
        startTime: startTimeMs,
        attributes: cleanAttributes({
          'service.name': App.SERVICE_NAME,
          'service.instance.id': this.sessionId,
          'session.id': this.sessionId,
          'session.state_id': this.sessionStateId || undefined,
          [OtelAttr.ORR_ELSE_BEAD_ID]: this.env.env(EnvVars.BEAD_ID) || undefined,
          [OtelAttr.ORR_ELSE_STATE_ID]: this.env.env(EnvVars.STATE_ID) || undefined,
          [OtelAttr.ORR_ELSE_ACTION_ID]: this.env.env(EnvVars.ACTION_ID) || undefined,
          [OtelAttr.ORR_ELSE_WORKER_ID]: this.env.env(EnvVars.WORKER_ID) || undefined,
          'process.pid': this.pid,
          ...attributes
        })
      },
      parentOtelContext
    );
    span.setStatus({ code: SpanStatusCode.OK });
    span.end(endTimeMs);
  }

  public endSpan(spanId: string, status: SpanStatus = SpanStatusValue.OK, message?: string): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;

    span.setStatus({
      code: status === SpanStatusValue.OK ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      message: message === undefined ? undefined : compactSpanString(message)
    });
    span.end();
    this.activeSpans.delete(spanId);
  }

  public addEvent(spanId: string, name: string, attributes: SpanAttributes = {}): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;
    span.addEvent(name, cleanAttributes(attributes));
  }

  public setAttribute(spanId: string, key: string, value: string | number | boolean | undefined): void {
    const span = this.activeSpans.get(spanId);
    const cleanValue = cleanAttributeValue(value);
    if (!span || cleanValue === undefined) return;
    span.setAttribute(key, cleanValue);
  }

  public tracedAsync<T>(
    name: string,
    attributes: SpanAttributes | ((...args: any[]) => SpanAttributes) = {},
    fn: (...args: any[]) => Promise<T>,
    complete?: (result: T) => SpanCompletion | undefined
  ): (...args: any[]) => Promise<T> {
    return async (...args: any[]) => {
      const parent = this.getTraceContext();
      const resolvedAttributes = typeof attributes === 'function' ? attributes(...args) : attributes;
      const span = this.startSpan(name, resolvedAttributes, parent);

      return this.contextStorage.run(span, async () => {
        try {
          const result = await fn(...args);
          const completion = complete?.(result);
          this.endSpan(span.spanId, completion?.status || SpanStatusValue.OK, completion?.message);
          return result;
        } catch (error) {
          this.endSpan(span.spanId, SpanStatusValue.ERROR, String(error));
          throw error;
        }
      });
    };
  }

  public getTraceContext(): SpanContext | undefined {
    const active = this.contextStorage.getStore();
    if (active) return active;
    const traceId = this.env.env(EnvVars.TRACE_ID);
    const spanId = this.env.env(EnvVars.SPAN_ID);
    if (traceId && spanId) {
      return {
        traceId,
        spanId
      };
    }
    return undefined;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getTraceId(): string {
    return this.sessionTraceId;
  }

  public shutdown(): void {
    this.activeSpans.clear();
    if (this.provider) {
      void this.provider.shutdown().catch(error => {
        Logger.warn(Component.OBSERVABILITY, 'OpenTelemetry provider shutdown failed', { error: String(error) });
      });
    }
    this.provider = null;
    this.currentConfigKey = null;
    this.currentFileName = null;
    this.currentFilePath = null;
  }

  public async forceFlush(): Promise<void> {
    await this.provider?.forceFlush();
  }

  private resolveFileName(configuredFileName?: string): string {
    const configured = this.env.env(EnvVars.OBSERVABILITY_FILE_NAME) || configuredFileName || ObservabilityDefaults.JSONL_FILE_TEMPLATE;
    const substituted = configured.replace(/\{\{\s*sessionId\s*\}\}/g, this.sessionId);
    return path.basename(substituted);
  }
}
