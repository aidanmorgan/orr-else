import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import { ResolvedLLMConfig, HarnessConfig } from './domain/StateModels.js';
import { ChecklistItem } from './ProtocolParser.js';
import { resolveInstall, resolveProjectFrom } from './Paths.js';
import { Logger } from './Logger.js';
import { isRecord, mergeReplacingArrays } from './RecordUtils.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from './RuntimeEnvironment.js';
import {
  BeadStatus,
  Component,
  DEFAULT_OBSERVED_PI_TOOLS,
  DefaultModelName,
  Defaults,
  EnvVars,
  EventName,
  LLMProviderName,
  ModelProviderKey,
  RECOGNIZED_COARSE_SINK_STATUSES,
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

  constructor(
    private readonly env: RuntimeEnvironment = nodeRuntimeEnvironment,
    private readonly projectRoot: string = process.cwd()
  ) {}

  private normalizeConfigPath(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : resolveProjectFrom(this.projectRoot, filePath);
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
    return this.normalizeConfigPath(this.configPath || this.env.env(CONFIG_ENV_VAR) || DEFAULT_CONFIG_FILE);
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
      // s3wp.24: strip deprecated inline byte-cap fields before schema validation.
      // Configs that still declare inlineResultBytes (or sibling caps) are handled
      // with a deprecation warning rather than a hard error so existing configs keep
      // loading without modification.  The field is silently ignored at runtime.
      this.warnAndStripDeprecatedOutputCapFields(parsed, configPath);
      const merged: unknown = mergeReplacingArrays(
        DEFAULTS as Record<string, unknown>,
        parsed as Record<string, unknown>
      );
      this.validate(merged);
      config = merged;
      this.resolveFileBackedFields(config);
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
   * s3wp.24 migration: check the raw parsed config for deprecated output-cap fields
   * (inlineResultBytes and any sibling inline byte-cap knobs removed in s3wp.24).
   * Logs a deprecation warning naming each found field, then strips the field from
   * the config object in-place so AJV schema validation does not reject the file.
   *
   * Migration choice: IGNORE-WITH-DEPRECATION-WARNING.
   * - The field is silently removed; the harness runs as if it was never set.
   * - A warning is logged that names the field and the tool(s) where it appeared.
   * - No exception is thrown, so existing configs keep loading without modification.
   */
  private warnAndStripDeprecatedOutputCapFields(parsed: unknown, configPath: string): void {
    // Deprecated fields that were removed in s3wp.24.
    const DEPRECATED_OUTPUT_CAP_FIELDS = ['inlineResultBytes'];

    if (typeof parsed !== 'object' || parsed === null) return;
    const record = parsed as Record<string, unknown>;
    const toolsList = record['tools'];
    if (!Array.isArray(toolsList)) return;

    for (const tool of toolsList) {
      if (typeof tool !== 'object' || tool === null) continue;
      const toolRecord = tool as Record<string, unknown>;
      const toolName = typeof toolRecord['name'] === 'string' ? toolRecord['name'] : '<unknown>';
      for (const field of DEPRECATED_OUTPUT_CAP_FIELDS) {
        if (toolRecord[field] !== undefined) {
          Logger.warn(Component.CONFIG,
            `Deprecated config field "${field}" in tool "${toolName}" (${configPath}). ` +
            `This field has been removed in s3wp.24 — the harness no longer caps model-facing ` +
            `output by a byte budget. The field is ignored and the config will load normally. ` +
            `Remove "${field}" from your harness.yaml to suppress this warning.`,
            { tool: toolName, field, configPath }
          );
          delete toolRecord[field];
        }
      }
    }
  }

  private validate(config: unknown): asserts config is HarnessConfig {
    const ajv = new Ajv({ allErrors: true, useDefaults: true });
    addFormats(ajv);

    const projectSchemaPath = resolveProjectFrom(this.projectRoot, 'harness.schema.json');
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

    // ── Semantic validation (post-schema) ────────────────────────────────────
    this.validateSemantics(config as HarnessConfig);
  }

  /**
   * Post-schema semantic checks.
   *
   * When a `statechart` block is present (explicit opt-in):
   *   - startState / statechart.initialState must exist in states.
   *   - Every transition target must be a defined state, a declared terminal state,
   *     OR a recognized coarse sink status (completed / blocked / deferred) (throws otherwise).
   *     Coarse sink targets exit the active statechart flow without spawning a worker.
   *   - Warns when a transition outcome key is not in the declared vocabulary.
   *
   * When no `statechart` block is present (legacy / default config):
   *   - startState existence is still validated.
   *   - Transition target validation is SKIPPED (backward-safe: old configs freely
   *     reference implicit terminals like 'done', 'completed', 'failed').
   *   - No vocabulary warnings are emitted.
   */
  private validateSemantics(config: HarnessConfig): void {
    const stateIds = new Set(Object.keys(config.states || {}));
    const sc = config.statechart;
    const hasStatechartBlock = !!sc;
    const terminalStates = new Set<string>(
      sc?.terminalStates ?? [BeadStatus.COMPLETED]
    );
    // knownTargets = defined states ∪ declared terminal states ∪ recognized
    // coarse sink statuses (completed / blocked / deferred).  A transition
    // whose target is a coarse sink status is valid: the bead leaves the active
    // statechart flow rather than being spawned into a new worker state.
    const knownTargets = new Set([...stateIds, ...terminalStates, ...RECOGNIZED_COARSE_SINK_STATUSES]);

    // startState / statechart.initialState existence check.
    // Only enforced when there are defined states (avoids false positives in
    // test configs with empty states maps that only care about other features).
    const startState = config.settings.startState || sc?.initialState;
    if (startState && stateIds.size > 0 && !stateIds.has(startState) && !terminalStates.has(startState)) {
      throw new Error(
        `Configured startState "${startState}" does not exist in states. ` +
        `Known states: ${[...stateIds].join(', ')}`
      );
    }

    if (!hasStatechartBlock) {
      // Legacy mode: skip transition-target and vocabulary validation for
      // backward compatibility with configs that predate the statechart block.
      return;
    }

    // Declared outcome vocabulary for warning (only when statechart block present)
    const declaredOutcomes = new Set([
      ...(sc.advanceOutcomes ?? ['SUCCESS']),
      ...(sc.failedOutcomes ?? ['FAILURE']),
      ...(sc.blockedOutcomes ?? ['BLOCKED']),
      ...(sc.customOutcomes ?? []),
      // Always include restart events which are harness-internal
      EventName.HARNESS_RESTART,
      EventName.CONTEXT_RESTART
    ].map(o => o.toUpperCase()));

    for (const [stateId, state] of Object.entries(config.states || {})) {
      const allTransitions: Record<string, string> = {
        ...(state.transitions || {}),
        ...(state.on || {})
      };
      for (const [outcomeKey, targetState] of Object.entries(allTransitions)) {
        if (!knownTargets.has(targetState)) {
          throw new Error(
            `State "${stateId}" has transition "${outcomeKey}" → "${targetState}" ` +
            `but "${targetState}" is not a defined state, declared terminal state, or recognized coarse sink status. ` +
            `Defined states: ${[...stateIds].join(', ')}; terminal states: ${[...terminalStates].join(', ')}; ` +
            `coarse sink statuses: ${[...RECOGNIZED_COARSE_SINK_STATUSES].join(', ')}`
          );
        }
        if (!declaredOutcomes.has(outcomeKey.toUpperCase())) {
          Logger.warn(Component.CONFIG,
            `State "${stateId}" uses transition outcome "${outcomeKey}" which is not declared ` +
            `in statechart advanceOutcomes/failedOutcomes/blockedOutcomes/customOutcomes. ` +
            `Add it to customOutcomes to suppress this warning.`
          );
        }
      }
    }
  }

  private resolveConfigPath(reference: string): string {
    return path.isAbsolute(reference) ? reference : resolveProjectFrom(this.projectRoot, reference);
  }

  private resolveTextReference(value: unknown): unknown {
    if (typeof value !== 'string' || !value.trim()) return value;
    const filePath = this.resolveConfigPath(value);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return value;
    return fs.readFileSync(filePath, 'utf8');
  }

  private resolveChecklistReference(value: unknown): ChecklistItem[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) return value as ChecklistItem[];
    if (typeof value !== 'string' || !value.trim()) return undefined;

    const filePath = this.resolveConfigPath(value);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Checklist file not found: ${value}`);
    }

    const parsed = yaml.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) return parsed as ChecklistItem[];
    if (isRecord(parsed) && Array.isArray(parsed.items)) return parsed.items as ChecklistItem[];
    throw new Error(`Checklist file must contain an array or an { items: [...] } object: ${value}`);
  }

  private resolveFileBackedFields(config: HarnessConfig): void {
    config.settings.harnessRestartPrompt = this.resolveTextReference(config.settings.harnessRestartPrompt) as string | undefined;
    config.settings.contextRestartPrompt = this.resolveTextReference(config.settings.contextRestartPrompt) as string | undefined;

    for (const gate of config.validationGates || []) {
      gate.checklist = this.resolveChecklistReference(gate.checklist);
    }

    for (const state of Object.values(config.states || {})) {
      state.harnessRestartPrompt = this.resolveTextReference(state.harnessRestartPrompt) as string | undefined;
      state.contextRestartPrompt = this.resolveTextReference(state.contextRestartPrompt) as string | undefined;
      state.checklist = this.resolveChecklistReference(state.checklist);

      for (const action of state.actions || []) {
        action.prompt = this.resolveTextReference(action.prompt) as string | undefined;
        action.checklist = this.resolveChecklistReference(action.checklist);
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
