import { afterEach, describe, expect, it } from 'vitest';
import TransportStream from 'winston-transport';
import { LoggerService } from '../src/core/Logger.js';
import { EnvVars, LoggingDefaults } from '../src/constants/index.js';
import type { RuntimeEnvironment } from '../src/core/RuntimeEnvironment.js';

// ---------------------------------------------------------------------------
// Metric: testability
//
// BEFORE: any test touching a LoggerService consumer triggered real
//   rotating-file writes bound to the Paths global, and log level was only
//   settable via process.env mutation.
//
// AFTER: transports + level are injectable via the constructor; the tests
//   below capture log entries with zero filesystem I/O.
//
// Winston transport-level note: a transport's own `level` option overrides
// the logger-level filter when it is more permissive.  To let logger-level
// filtering work correctly in tests, MemoryTransport is created WITHOUT an
// explicit `level` so it inherits the level set on the logger.
// ---------------------------------------------------------------------------

interface CapturedEntry {
  level: string;
  message: string;
  component?: string;
  [key: string]: unknown;
}

/**
 * In-memory winston transport — captures every log entry without writing to
 * disk.  Extends TransportStream (the base class for all winston transports)
 * and overrides `log` to push the info object onto an array.
 *
 * Created with no explicit `level` so the parent logger's level acts as the
 * sole filter; the transport accepts whatever the logger passes through.
 */
class MemoryTransport extends TransportStream {
  public readonly entries: CapturedEntry[] = [];

  override log(info: CapturedEntry, callback: () => void): void {
    this.entries.push(info);
    callback();
  }
}

function stubRuntimeEnvironment(vars: Record<string, string | undefined>): RuntimeEnvironment {
  return {
    env: (name: string): string | undefined => vars[name]
  };
}

describe('LoggerService — injectable transports and log level', () => {
  let service: LoggerService;
  let transport: MemoryTransport;

  afterEach(() => {
    service?.close();
  });

  // -------------------------------------------------------------------------
  // Zero-filesystem-write capture
  // -------------------------------------------------------------------------

  it('captures log entries in the in-memory transport with zero filesystem writes', () => {
    transport = new MemoryTransport();
    service = new LoggerService(stubRuntimeEnvironment({}), [transport]);

    service.info('TestComponent', 'hello info');
    service.warn('TestComponent', 'hello warn');
    service.error('TestComponent', 'hello error');

    expect(transport.entries).toHaveLength(3);
    expect(transport.entries[0].message).toBe('hello info');
    expect(transport.entries[1].message).toBe('hello warn');
    expect(transport.entries[2].message).toBe('hello error');
  });

  it('attaches the component field to captured entries', () => {
    transport = new MemoryTransport();
    service = new LoggerService(stubRuntimeEnvironment({}), [transport]);

    service.info('MyComp', 'a message', { extra: 42 });

    expect(transport.entries[0].component).toBe('MyComp');
    expect(transport.entries[0].extra).toBe(42);
  });

  // -------------------------------------------------------------------------
  // Log level — via RuntimeEnvironment (no process.env mutation)
  // -------------------------------------------------------------------------

  it('reads LOG_LEVEL from the injected RuntimeEnvironment without touching process.env', () => {
    transport = new MemoryTransport();
    const env = stubRuntimeEnvironment({ [EnvVars.LOG_LEVEL]: 'warn' });
    service = new LoggerService(env, [transport]);

    // info is below warn — should be filtered out by the logger level
    service.info('TestComponent', 'should be suppressed');
    service.warn('TestComponent', 'should appear');

    const messages = transport.entries.map(e => e.message);
    expect(messages).not.toContain('should be suppressed');
    expect(messages).toContain('should appear');
  });

  it('falls back to LoggingDefaults.LEVEL when RuntimeEnvironment has no LOG_LEVEL', () => {
    transport = new MemoryTransport();
    service = new LoggerService(stubRuntimeEnvironment({}), [transport]);

    // Default level is 'info', so debug should be filtered out
    service.debug('TestComponent', 'debug message');
    service.info('TestComponent', 'info message');

    const messages = transport.entries.map(e => e.message);
    expect(LoggingDefaults.LEVEL).toBe('info'); // confirm the constant
    expect(messages).not.toContain('debug message');
    expect(messages).toContain('info message');
  });

  // -------------------------------------------------------------------------
  // configure() seam — changes level without mutating process.env
  // -------------------------------------------------------------------------

  it('configure() sets the log level immediately on an already-initialised logger', () => {
    transport = new MemoryTransport();
    service = new LoggerService(stubRuntimeEnvironment({}), [transport]);

    // Trigger lazy init
    service.info('TestComponent', 'initial message');

    // Now raise the level to warn; info should be suppressed
    service.configure('warn');
    service.info('TestComponent', 'should be suppressed after configure');
    service.warn('TestComponent', 'should appear after configure');

    const messages = transport.entries.map(e => e.message);
    expect(messages).toContain('initial message');
    expect(messages).not.toContain('should be suppressed after configure');
    expect(messages).toContain('should appear after configure');
  });

  it('configure() before first use is respected on lazy init', () => {
    transport = new MemoryTransport();
    service = new LoggerService(stubRuntimeEnvironment({}), [transport]);

    // Set level before any log call triggers init
    service.configure('error');

    service.info('TestComponent', 'info — should be suppressed');
    service.warn('TestComponent', 'warn — should be suppressed');
    service.error('TestComponent', 'error — should appear');

    const messages = transport.entries.map(e => e.message);
    expect(messages).not.toContain('info — should be suppressed');
    expect(messages).not.toContain('warn — should be suppressed');
    expect(messages).toContain('error — should appear');
  });

  it('configure() takes precedence over RuntimeEnvironment LOG_LEVEL', () => {
    transport = new MemoryTransport();
    // env says warn, but configure will override to debug
    const env = stubRuntimeEnvironment({ [EnvVars.LOG_LEVEL]: 'warn' });
    service = new LoggerService(env, [transport]);

    service.configure('debug');
    service.debug('TestComponent', 'debug should now appear');

    const messages = transport.entries.map(e => e.message);
    expect(messages).toContain('debug should now appear');
  });

  it('does not mutate process.env when configure() is called', () => {
    transport = new MemoryTransport();
    service = new LoggerService(stubRuntimeEnvironment({}), [transport]);
    const before = process.env[EnvVars.LOG_LEVEL];

    service.configure('error');

    expect(process.env[EnvVars.LOG_LEVEL]).toBe(before);
  });

  // -------------------------------------------------------------------------
  // Production default — module-level Logger export still compiles/constructs
  // -------------------------------------------------------------------------

  it('the module-level Logger export is a LoggerService instance', async () => {
    const { Logger } = await import('../src/core/Logger.js');
    expect(Logger).toBeInstanceOf(LoggerService);
  });
});
