import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import { ResolvedLLMConfig, HarnessConfig } from './domain/StateModels.js';
import { resolveInstall, resolveProject } from './Paths.js';
import { Logger } from './Logger.js';
import { isRecord, mergeReplacingArrays } from './RecordUtils.js';
import {
  Component,
  DEFAULT_OBSERVED_PI_TOOLS,
  DefaultModelName,
  Defaults,
  EnvVars,
  EventName,
  LLMProviderName,
  ModelProviderKey,
  SchedulerDefaults,
  SubscriptionProviderToken,
  ThinkingLevel
} from '../constants/index.js';

const Ajv = AjvModule.default || AjvModule;
const addFormats = addFormatsModule.default || addFormatsModule;

const DEFAULT_CONFIG_FILE = 'harness.yaml';
const CONFIG_ENV_VAR = EnvVars.CONFIG_PATH;

/**
 * Map a configured provider string to the Pi provider name passed to
 * `pi --provider`. When the configured string contains the `codex` or
 * `claude` subscription token (case-insensitive), route to the matching Pi
 * subscription (OAuth) provider so teammates run on a ChatGPT/Codex or
 * Claude Pro/Max subscription. Any other value passes through unchanged, so
 * explicit API-key providers such as `openai` and `anthropic` keep working.
 */
export function resolveProviderName(provider: string): string {
  const normalized = provider.toLowerCase();
  if (normalized.includes(SubscriptionProviderToken.CODEX)) {
    return LLMProviderName.OPENAI_CODEX;
  }
  if (normalized.includes(SubscriptionProviderToken.CLAUDE)) {
    return LLMProviderName.ANTHROPIC;
  }
  return provider;
}

const DEFAULTS: Partial<HarnessConfig> = {
  settings: {
    maxConcurrentSlots: Defaults.MAX_SLOTS,
    handoverTemplate: `
      CRITICAL: You are hitting context limits. 
      Generate a detailed "RESUMPTION HANDOVER" document for a fresh teammate.
      HISTORY: {{history}}
    `,
    agentTurnTimeoutMs: Defaults.LEASE_TTL_MS,
    processReapIntervalMs: Defaults.PROCESS_REAP_INTERVAL_MS,
    teamLeadSystemPrompt: 'You are the Team Lead. Manage slots and delegate tasks.',
    projectObjective: 'Implement the requested project successfully.',
    startState: undefined,
    harnessRestartEvent: EventName.HARNESS_RESTART,
    contextRestartEvent: EventName.CONTEXT_RESTART,
    pi: {
      tools: [],
      observedTools: [...DEFAULT_OBSERVED_PI_TOOLS],
      skillPaths: [],
      workerArgs: [],
      workerExtensions: []
    },
    defaultProvider: ModelProviderKey.OPENAI,
    defaultModel: DefaultModelName.OPENAI,
    modelProviders: {
      [ModelProviderKey.CLAUDE]: {
        provider: LLMProviderName.ANTHROPIC,
        model: DefaultModelName.CLAUDE,
        thinking: ThinkingLevel.HIGH
      },
      [ModelProviderKey.OPENAI]: {
        provider: LLMProviderName.OPENAI,
        model: DefaultModelName.OPENAI,
        thinking: ThinkingLevel.XHIGH
      }
    },
    stateContextRotThreshold: 10,
    harnessContextRotThreshold: 5,
    observability: {
      enabled: true,
      dir: '.pi/otel',
      retentionDays: Defaults.LOG_RETENTION_DAYS
    }
  },
  scheduler: {
    weights: SchedulerDefaults.DEFAULT_WEIGHTS
  }
};

export class ConfigLoader {
  private cached: HarnessConfig | null = null;
  private configPath: string | null = null;
  private cachedPath: string | null = null;
  private cachedSignature: { mtimeMs: number; ctimeMs: number; size: number } | null = null;

  private normalizeConfigPath(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : resolveProject(filePath);
  }

  public setConfigPath(filePath: string) {
    const nextPath = this.normalizeConfigPath(filePath);
    if (this.configPath === nextPath) return;
    this.configPath = nextPath;
    this.cached = null;
    this.cachedPath = null;
    this.cachedSignature = null;
  }

  public getConfigPath(): string {
    return this.normalizeConfigPath(this.configPath || process.env[CONFIG_ENV_VAR] || DEFAULT_CONFIG_FILE);
  }

  public reset(): void {
    this.cached = null;
    this.configPath = null;
    this.cachedPath = null;
    this.cachedSignature = null;
  }

  public load(filePath?: string): HarnessConfig {
    if (filePath) this.setConfigPath(filePath);

    const configPath = this.getConfigPath();
    let config: HarnessConfig;

    try {
      if (!fs.existsSync(configPath)) {
        throw new Error(`Configuration file not found: ${configPath}`);
      }

      const fileStat = fs.statSync(configPath);
      const signature = {
        mtimeMs: fileStat.mtimeMs,
        ctimeMs: fileStat.ctimeMs,
        size: fileStat.size
      };
      if (
        this.cached
        && this.cachedPath === configPath
        && this.cachedSignature?.mtimeMs === signature.mtimeMs
        && this.cachedSignature.ctimeMs === signature.ctimeMs
        && this.cachedSignature.size === signature.size
      ) {
        return this.cached;
      }

      const fileContent = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.parse(fileContent) || {};
      config = mergeReplacingArrays(
        DEFAULTS as Record<string, unknown>,
        parsed as Record<string, unknown>
      ) as unknown as HarnessConfig;
      this.resolveFileBackedFields(config);

      this.validate(config);
      this.cached = config;
      this.cachedPath = configPath;
      this.cachedSignature = signature;
      return config;
    } catch (error) {
      Logger.error(Component.CONFIG, 'Failed to load configuration', { error: String(error) });
      throw error;
    }
  }

  private validate(config: HarnessConfig) {
    const ajv = new Ajv({ allErrors: true, useDefaults: true });
    addFormats(ajv);

    const projectSchemaPath = resolveProject('harness.schema.json');
    const installSchemaPath = resolveInstall('harness.schema.json');
    const schemaPath = fs.existsSync(installSchemaPath) ? installSchemaPath : projectSchemaPath;
    if (!fs.existsSync(schemaPath)) {
      Logger.warn(Component.CONFIG, 'Schema file not found, skipping validation', { path: schemaPath });
      return;
    }

    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const validate = ajv.compile(schema);
    const valid = validate(config);

    if (!valid) {
      const errors = validate.errors?.map(e => `${e.instancePath} ${e.message}`).join(', ');
      throw new Error(`Configuration validation failed: ${errors}`);
    }
  }

  private resolveConfigPath(reference: string): string {
    return path.isAbsolute(reference) ? reference : resolveProject(reference);
  }

  private resolveTextReference(value: unknown): unknown {
    if (typeof value !== 'string' || !value.trim()) return value;
    const filePath = this.resolveConfigPath(value);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return value;
    return fs.readFileSync(filePath, 'utf8');
  }

  private resolveChecklistReference(value: unknown): unknown {
    if (Array.isArray(value) || value === undefined || value === null) return value;
    if (typeof value !== 'string' || !value.trim()) return value;

    const filePath = this.resolveConfigPath(value);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Checklist file not found: ${value}`);
    }

    const parsed = yaml.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (isRecord(parsed) && Array.isArray(parsed.items)) return parsed.items;
    throw new Error(`Checklist file must contain an array or an { items: [...] } object: ${value}`);
  }

  private resolveFileBackedFields(config: HarnessConfig): void {
    config.settings.harnessRestartPrompt = this.resolveTextReference(config.settings.harnessRestartPrompt) as string | undefined;
    config.settings.contextRestartPrompt = this.resolveTextReference(config.settings.contextRestartPrompt) as string | undefined;

    for (const gate of config.validationGates || []) {
      gate.checklist = this.resolveChecklistReference(gate.checklist) as any;
    }

    for (const state of Object.values(config.states || {})) {
      state.harnessRestartPrompt = this.resolveTextReference(state.harnessRestartPrompt) as string | undefined;
      state.contextRestartPrompt = this.resolveTextReference(state.contextRestartPrompt) as string | undefined;
      state.checklist = this.resolveChecklistReference(state.checklist) as any;

      for (const action of state.actions || []) {
        action.prompt = this.resolveTextReference(action.prompt) as string | undefined;
        action.checklist = this.resolveChecklistReference(action.checklist) as any;
      }
    }
  }

  public resolveLLMConfig(stateId: string, config: HarnessConfig): ResolvedLLMConfig {
    const state = config.states[stateId];
    const providerKey = state?.llmProvider || config.settings.defaultProvider;
    const providerConfig = config.settings.modelProviders[providerKey] || {
      provider: providerKey,
      model: config.settings.defaultModel
    };

    return {
      providerKey,
      provider: resolveProviderName(providerConfig.provider || providerKey),
      model: state?.model || providerConfig.model || config.settings.defaultModel,
      thinking: state?.thinking || providerConfig.thinking
    };
  }
}
export type { HarnessConfig };
