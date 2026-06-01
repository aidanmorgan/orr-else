import * as winston from 'winston';
import 'winston-daily-rotate-file';
import { resolveProject } from './Paths.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from './RuntimeEnvironment.js';
import { App, EnvVars, LoggingDefaults } from '../constants/index.js';

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

  constructor(
    private readonly env: RuntimeEnvironment = nodeRuntimeEnvironment,
    private readonly transports: winston.transport[] | null = null
  ) {}

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

  private init() {
    // When custom transports are injected, skip logDir-based identity check
    // (there is no rotating file whose dir we need to track).
    if (this.transports !== null) {
      if (this.logger) return;
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
      return;
    }

    const logDir = resolveProject(LoggingDefaults.DIR);
    if (this.logger && this.logDir === logDir) return;
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
    this.init();
    this.logger!.info(message, { component, ...metadata });
  }

  public error(component: string, message: string, metadata?: LogMetadata) {
    this.init();
    this.logger!.error(message, { component, ...metadata });
  }

  public warn(component: string, message: string, metadata?: LogMetadata) {
    this.init();
    this.logger!.warn(message, { component, ...metadata });
  }

  public debug(component: string, message: string, metadata?: LogMetadata) {
    this.init();
    this.logger!.debug(message, { component, ...metadata });
  }

  public close() {
    if (!this.logger) return;
    this.logger.close();
    this.logger = null;
    this.logDir = null;
  }
}

export const Logger = new LoggerService();
