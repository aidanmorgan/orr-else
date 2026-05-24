import * as winston from 'winston';
import 'winston-daily-rotate-file';
import { resolveProject } from './Paths.js';
import { App, EnvVars, LoggingDefaults } from '../constants/index.js';

/**
 * Orr Else structured logger.
 * Uses Winston for high-reliability, multi-transport logging.
 */

const { combine, timestamp, json, colorize, printf, errors } = winston.format;

// Custom format for TUI-friendly console output
const tuiFormat = printf((info: any) => {
  const { level, message, timestamp, component, ...metadata } = info;
  const metaString = Object.keys(metadata).length ? ` ${JSON.stringify(metadata)}` : '';
  const componentStr = component ? `[${component}] ` : '';
  return `${timestamp} ${level}: ${componentStr}${message}${metaString}`;
});

export class LoggerService {
  private logger: winston.Logger | null = null;

  private init() {
    if (this.logger) return;

    const logDir = resolveProject(LoggingDefaults.DIR);
    const logLevel = process.env[EnvVars.LOG_LEVEL] || LoggingDefaults.LEVEL;
    
    this.logger = winston.createLogger({
      level: logLevel,
      format: combine(
        errors({ stack: true }),
        timestamp({ format: LoggingDefaults.TIMESTAMP_FORMAT }),
        json()
      ),
      defaultMeta: { pid: process.pid, version: App.VERSION },
      transports: [
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
      ]
    });

    this.logger.debug('Logger initialized', { logDir, level: this.logger.level });
  }

  public info(component: string, message: string, metadata?: any) {
    this.init();
    this.logger!.info(message, { component, ...metadata });
  }

  public error(component: string, message: string, metadata?: any) {
    this.init();
    this.logger!.error(message, { component, ...metadata });
  }

  public warn(component: string, message: string, metadata?: any) {
    this.init();
    this.logger!.warn(message, { component, ...metadata });
  }

  public debug(component: string, message: string, metadata?: any) {
    this.init();
    this.logger!.debug(message, { component, ...metadata });
  }
}

export const Logger = new LoggerService();
