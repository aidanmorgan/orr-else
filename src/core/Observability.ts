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
import { Logger } from './Logger.js';
import { resolveProject } from './Paths.js';
import { isRecord } from './RecordUtils.js';
import { App, Component, EnvVars, Numeric, ObservabilityDefaults, OtelAttr, ToolResultStatus } from '../constants/index.js';

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

class JsonlSpanExporter implements SpanExporter {
  private readonly stream: fs.WriteStream;

  constructor(private readonly filePath: string) {
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
  }

  export(spans: ReadableSpan[], resultCallback: (result: { code: ExportResultCode; error?: Error }) => void): void {
    try {
      for (const span of spans) {
        this.stream.write(`${JSON.stringify(this.serialize(span))}\n`);
      }
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  async shutdown(): Promise<void> {
    await new Promise<void>(resolve => {
      this.stream.end(() => resolve());
    });
  }

  async forceFlush(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.write('', error => {
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
  private readonly sessionId = process.env[EnvVars.OBSERVABILITY_SESSION_ID] || uuidv7();
  private readonly sessionStateId = process.env[EnvVars.SESSION_STATE_ID] || null;
  private readonly sessionTraceId = this.sessionId.replace(/-/g, '');
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

  constructor(private readonly configLoader: ConfigLoader) {}

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
    return path.join(resolveProject('.pi/otel'), this.getJsonlFileName());
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

    const obsDir = observability?.dir || '.pi/otel';
    const absoluteDir = path.isAbsolute(obsDir) ? obsDir : resolveProject(obsDir);
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
          [OtelAttr.ORR_ELSE_BEAD_ID]: process.env[EnvVars.BEAD_ID] || undefined,
          [OtelAttr.ORR_ELSE_STATE_ID]: process.env[EnvVars.STATE_ID] || undefined,
          [OtelAttr.ORR_ELSE_ACTION_ID]: process.env[EnvVars.ACTION_ID] || undefined,
          [OtelAttr.ORR_ELSE_WORKER_ID]: process.env[EnvVars.WORKER_ID] || undefined,
          'process.pid': process.pid,
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
    const traceId = process.env[EnvVars.TRACE_ID];
    const spanId = process.env[EnvVars.SPAN_ID];
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
    const configured = process.env[EnvVars.OBSERVABILITY_FILE_NAME] || configuredFileName || ObservabilityDefaults.JSONL_FILE_TEMPLATE;
    const substituted = configured.replace(/\{\{\s*sessionId\s*\}\}/g, this.sessionId);
    return path.basename(substituted);
  }
}
