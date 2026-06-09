/**
 * ConfigFileSource — config file discovery, path resolution, and stat-based caching.
 *
 * Owns: getConfigPath(), setConfigPath(), reset(), stat-based cache fingerprint.
 * Does NOT parse, validate, or transform config content.
 *
 * Extracted from ConfigLoader as part of pi-experiment-amq0.5 decomposition.
 * ConfigLoader remains the public facade; this class holds only the sourcing concern.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveProjectFrom } from './Paths.js';
import { EnvVars } from '../constants/infra.js';
import { type RuntimeEnvironment } from './RuntimeEnvironment.js';

const DEFAULT_CONFIG_FILE = 'harness.yaml';
const CONFIG_ENV_VAR = EnvVars.CONFIG_PATH;

export interface ConfigFileSignature {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
}

export interface ConfigFileResult {
  configPath: string;
  signature: ConfigFileSignature;
  fileContent: string;
}

export class ConfigFileSource {
  private configPath: string | null = null;

  constructor(
    private readonly env: RuntimeEnvironment,
    private readonly projectRoot: string
  ) {}

  private normalizeConfigPath(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : resolveProjectFrom(this.projectRoot, filePath);
  }

  public setConfigPath(filePath: string): void {
    this.configPath = this.normalizeConfigPath(filePath);
  }

  public getConfigPath(): string {
    const base = this.configPath ?? this.env.env(CONFIG_ENV_VAR) ?? DEFAULT_CONFIG_FILE;
    return this.normalizeConfigPath(base);
  }

  /** Returns the explicitly set config path (null if not set), without env-var fallback. */
  public getExplicitConfigPath(): string | null {
    return this.configPath;
  }

  public reset(): void {
    this.configPath = null;
  }

  /**
   * Read the config file and return its content + stat signature.
   * Throws if the file does not exist.
   */
  public read(configPath: string): ConfigFileResult {
    if (!fs.existsSync(configPath)) {
      throw new Error(`Configuration file not found: ${configPath}`);
    }
    const fileStat = fs.statSync(configPath);
    const signature: ConfigFileSignature = {
      mtimeMs: fileStat.mtimeMs,
      ctimeMs: fileStat.ctimeMs,
      size: fileStat.size
    };
    const fileContent = fs.readFileSync(configPath, 'utf8');
    return { configPath, signature, fileContent };
  }
}
