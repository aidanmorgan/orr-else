import * as fs from 'fs';
import * as path from 'path';
import { ResolvedLLMConfig, HarnessConfig, type ResolvedHarnessConfig, type RawHarnessConfig } from './domain/StateModels.js';
import { resolveProjectFrom } from './Paths.js';
import { nodeLogger as Logger } from './Logger.js'
import { getPackagedSchemaPath } from './SchemaRegistry.js';
import { isRecord, mergeReplacingArrays } from './RecordUtils.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from './RuntimeEnvironment.js';
import { EventName, LLMProviderName, ModelProviderKey, SubscriptionProviderToken, ThinkingLevel } from '../constants/domain.js';
import { Component, DEFAULT_OBSERVED_PI_TOOLS, DefaultModelName, Defaults, EnvVars, SchedulerDefaults } from '../constants/infra.js';
import { ConfigFileSource } from './ConfigFileSource.js';
import { ConfigParser } from './ConfigParser.js';
import { ConfigNormalizer } from './ConfigNormalizer.js';
import { ConfigValidator } from './ConfigValidator.js';
import { ConfigReferenceResolver } from './ConfigReferenceResolver.js';

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
  private cachedPath: string | null = null;
  private cachedSignature: { mtimeMs: number; ctimeMs: number; size: number } | null = null;

  private readonly source: ConfigFileSource;
  private readonly parser: ConfigParser;
  private readonly normalizer: ConfigNormalizer;
  private readonly validator: ConfigValidator;
  private readonly resolver: ConfigReferenceResolver;

  constructor(
    private readonly env: RuntimeEnvironment = nodeRuntimeEnvironment,
    private readonly projectRoot: string = process.cwd()
  ) {
    this.source = new ConfigFileSource(env, projectRoot);
    this.parser = new ConfigParser(projectRoot);
    this.normalizer = new ConfigNormalizer();
    this.validator = new ConfigValidator(
      projectRoot,
      () => this.getConfigPath(),
      () => this.resolveInstallSchemaPath()
    );
    this.resolver = new ConfigReferenceResolver(projectRoot);
  }

  private normalizeConfigPath(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : resolveProjectFrom(this.projectRoot, filePath);
  }

  public setConfigPath(filePath: string) {
    const nextPath = this.normalizeConfigPath(filePath);
    // Compare against the explicitly set path (not env-var fallback) to match original behavior
    if (this.source.getExplicitConfigPath() === nextPath) return;
    this.source.setConfigPath(filePath);
    this.cached = null;
    this.cachedPath = null;
    this.cachedSignature = null;
  }

  public getConfigPath(): string {
    return this.source.getConfigPath();
  }

  public reset(): void {
    this.cached = null;
    this.source.reset();
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
      const parsed = this.parser.parse(fileContent);
      // pi-experiment-202g: v2 admission check runs on the raw parsed document
      // BEFORE defaults are merged, so DEFAULTS-injected fields (startState:undefined,
      // teamLeadSystemPrompt, projectObjective) do not cause false rejections.
      this.validator.preValidateV2Admission(parsed);
      // pi-experiment-0dgy: normalize v2 map-form collections (tools, validationGates,
      // states.<state>.actions) to sorted arrays with canonical map-derived IDs.
      // Runs after preValidateV2Admission (which already validated grammar/conflicts)
      // and before schema validation (which expects array form).
      if (isRecord(parsed) && parsed['version'] === 2) {
        this.normalizer.normalizeV2MapCollections(parsed);
      }
      // s3wp.10: expand tsProjectTool shorthand before merging with defaults
      // so that the merged+validated config only ever sees type: command tools.
      this.parser.expandTsProjectToolsInRaw(parsed);
      const merged: unknown = this.normalizer.mergeWithDefaults(
        DEFAULTS as Record<string, unknown>,
        parsed
      );
      this.validator.validate(merged);
      config = merged as HarnessConfig;
      this.resolver.expandToolProfiles(config);
      this.resolver.resolveFileBackedFields(config);
      this.cached = config;
      this.cachedPath = configPath;
      this.cachedSignature = signature;
      return config;
    } catch (error) {
      Logger.error(Component.CONFIG, 'Failed to load configuration', { error: String(error) });
      throw error;
    }
  }

  /**
   * Returns the absolute path to the packaged harness.schema.json.
   * Protected so test subclasses can override it to inject a custom install path.
   */
  protected resolveInstallSchemaPath(): string {
    return getPackagedSchemaPath();
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
/**
 * pi-experiment-amq0.12: Re-export canonical resolved/raw config types.
 *
 * ResolvedHarnessConfig — canonical post-admission type (= HarnessConfig).
 *   Consumer signatures (Scheduler, FlowManager, CoordinatorController,
 *   WorkerRunController, project-tool execution) should use this type to make
 *   the compile-time narrowing explicit: unknown strings cannot reach them.
 *
 * RawHarnessConfig — untrusted input type (YAML → plain object) before
 *   admission. Never pass this to consumers; pass it to ConfigValidator
 *   for admission, which produces ResolvedHarnessConfig after rejection of
 *   unknown enum values.
 */
export type { ResolvedHarnessConfig, RawHarnessConfig };
