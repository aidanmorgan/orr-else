import * as winston from 'winston';
import 'winston-daily-rotate-file';
import { resolveProjectFrom } from './Paths.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from './RuntimeEnvironment.js';
import { App } from '../constants/domain.js';
import { EnvVars, LoggingDefaults } from '../constants/infra.js';

/**
 * Orr Else structured logger.
 * Uses Winston for high-reliability, multi-transport logging.
 */

const { combine, timestamp, json, colorize, printf, errors } = winston.format;

// Custom format for TUI-friendly console output
const tuiFormat = printf(info => {
  const { level, message, timestamp, component, ...metadata } = info;
  const metaString = Object.keys(metadata).length ? ` ${JSON.stringify(metadata)}` : '';
  const componentStr = component ? `[${String(component)}] ` : '';
  return `${timestamp} ${level}: ${componentStr}${message}${metaString}`;
});

type LogMetadata = Record<string, unknown>;

export class LoggerService {
  private logger: winston.Logger | null = null;
  private logDir: string | null = null;
  private configuredLevel: string | null = null;
  private configuredProjectRoot: string | null = null;

  constructor(
    private readonly env: RuntimeEnvironment = nodeRuntimeEnvironment,
    private readonly transports: winston.transport[] | null = null
  ) {}

  /**
   * Point the rotating-file transport at a specific project root.
   * Must be called before the first log line if you need the log dir to
   * reflect the injected root rather than process.cwd().
   * Takes effect immediately — if the logger is already open and the new
   * logDir differs it will be re-initialised on the next log call.
   */
  public configureProjectRoot(root: string): void {
    this.configuredProjectRoot = root;
    // Force re-init on next log call so the new dir takes effect.
    if (this.logger && this.logDir !== resolveProjectFrom(root, LoggingDefaults.DIR)) {
      this.logger.close();
      this.logger = null;
      this.logDir = null;
    }
  }

  private resolveLevel(): string {
    // Use `||` (not `??`) so an empty-string LOG_LEVEL falls back to the default,
    // preserving the original `process.env[LOG_LEVEL] || LEVEL` semantics.
    return this.configuredLevel || this.env.env(EnvVars.LOG_LEVEL) || LoggingDefaults.LEVEL;
  }

  private buildDefaultTransports(logDir: string, logLevel: string): winston.transport[] {
    return [
      new winston.transports.DailyRotateFile({
        dirname: logDir,
        filename: LoggingDefaults.FILE_NAME_TEMPLATE,
        datePattern: LoggingDefaults.DATE_PATTERN,
        maxSize: LoggingDefaults.MAX_FILE_SIZE,
        maxFiles: LoggingDefaults.MAX_FILES,
        level: LoggingDefaults.FILE_LEVEL
      }),
      new winston.transports.Console({
        format: combine(
          colorize(),
          tuiFormat
        ),
        level: logLevel
      })
    ];
  }

  private init(): winston.Logger {
    // When custom transports are injected, skip logDir-based identity check
    // (there is no rotating file whose dir we need to track).
    if (this.transports !== null) {
      if (!this.logger) {
        const logLevel = this.resolveLevel();
        this.logger = winston.createLogger({
          level: logLevel,
          format: combine(
            errors({ stack: true }),
            timestamp({ format: LoggingDefaults.TIMESTAMP_FORMAT }),
            json()
          ),
          defaultMeta: { pid: process.pid, version: App.VERSION },
          transports: this.transports
        });
      }
      return this.logger;
    }

    const rootForLog = this.configuredProjectRoot || process.cwd();
    const logDir = resolveProjectFrom(rootForLog, LoggingDefaults.DIR);
    if (this.logger && this.logDir === logDir) return this.logger;
    if (this.logger) {
      this.logger.close();
      this.logger = null;
    }

    const logLevel = this.resolveLevel();

    this.logger = winston.createLogger({
      level: logLevel,
      format: combine(
        errors({ stack: true }),
        timestamp({ format: LoggingDefaults.TIMESTAMP_FORMAT }),
        json()
      ),
      defaultMeta: { pid: process.pid, version: App.VERSION },
      transports: this.buildDefaultTransports(logDir, logLevel)
    });
    this.logDir = logDir;

    this.logger.debug('Logger initialized', { logDir, level: this.logger.level });
    return this.logger;
  }

  /**
   * Set the log level at runtime without mutating process.env.
   * Takes effect immediately if the logger is already initialised,
   * and is remembered for subsequent lazy-init calls.
   */
  public configure(level: string): void {
    this.configuredLevel = level;
    if (this.logger) {
      this.logger.level = level;
    }
  }

  public info(component: string, message: string, metadata?: LogMetadata) {
    this.init().info(message, { component, ...metadata });
  }

  public error(component: string, message: string, metadata?: LogMetadata) {
    this.init().error(message, { component, ...metadata });
  }

  public warn(component: string, message: string, metadata?: LogMetadata) {
    this.init().warn(message, { component, ...metadata });
  }

  public debug(component: string, message: string, metadata?: LogMetadata) {
    this.init().debug(message, { component, ...metadata });
  }

  public close() {
    if (!this.logger) return;
    this.logger.close();
    this.logger = null;
    this.logDir = null;
  }
}

/**
 * LoggerPort — the interface contract for logging.
 * Core modules accept this type instead of the LoggerService class directly,
 * so the composition root can inject a per-runtime instance while the public
 * boundary still exposes the process-wide singleton.
 */
export type LoggerPort = LoggerService;

/**
 * Process-wide default logger instance.
 * Imported by core module constructors as the default parameter value so
 * tests can inject a fresh LoggerService without touching production behaviour.
 *
 * The named `Logger` export below is the public-boundary alias (used by
 * extension.ts, plugins, bin scripts — NOT by core internals).
 */
export const nodeLogger: LoggerService = new LoggerService();

/**
 * Public-boundary alias for the process-wide default logger.
 * Extension.ts, plugins, bin scripts, and Teammate.ts import THIS name.
 * Core internals MUST NOT import this name — they receive a LoggerPort via
 * their constructor (defaulting to nodeLogger).
 */
export const Logger = nodeLogger;
