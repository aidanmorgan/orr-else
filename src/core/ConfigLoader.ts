import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import { ResolvedLLMConfig, HarnessConfig, ToolProfileConfig, TsProjectToolDefaults, ProjectCommandToolConfig } from './domain/StateModels.js';
import { ChecklistItem } from './ProtocolParser.js';
import { resolveInstall, resolveProjectFrom } from './Paths.js';
import { Logger } from './Logger.js';
import { getPackagedSchemaPath } from './SchemaRegistry.js';
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
  StateContextPolicy,
  SubscriptionProviderToken,
  ThinkingLevel
} from '../constants/index.js';
import { lintActiveToolSets } from './ActiveToolSetResolver.js';

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
      // pi-experiment-202g: v2 admission check runs on the raw parsed document
      // BEFORE defaults are merged, so DEFAULTS-injected fields (startState:undefined,
      // teamLeadSystemPrompt, projectObjective) do not cause false rejections.
      this.preValidateV2Admission(parsed);
      // s3wp.10: expand tsProjectTool shorthand before merging with defaults
      // so that the merged+validated config only ever sees type: command tools.
      this.expandTsProjectToolsInRaw(parsed);
      const merged: unknown = mergeReplacingArrays(
        DEFAULTS as Record<string, unknown>,
        parsed as Record<string, unknown>
      );
      this.validate(merged);
      config = merged;
      this.expandToolProfiles(config);
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
   * s3wp.10: Expand tsProjectTool shorthand entries in the raw parsed config.
   *
   * Run before merging with DEFAULTS and before schema validation, so the
   * merged config only ever contains type: command tools.
   *
   * Expansion:
   *   type: command
   *   command: node
   *   defaultArgs: ["--experimental-strip-types", <resolvedScriptPath>]
   *   argsMode: append          (unless explicitly set on the tool)
   *   allowArgs: true           (unless explicitly set on the tool)
   *   + any other per-tool fields are preserved unchanged
   *
   * Script path resolution (highest priority first):
   *   1. tool.scriptPath (explicit per-tool path)
   *   2. settings.tsProjectToolDefaults.scriptDir/<toolName>.ts
   *   3. .pi/project-tools/<toolName>.ts  (built-in default)
   *
   * Paths may contain {{projectRoot}} which is replaced with this.projectRoot.
   *
   * Per-tool argsMode/allowArgs/cwd/timeoutMs/wrapperTimeoutMs win over
   * tsProjectToolDefaults which win over the defaults above.
   */
  private expandTsProjectToolsInRaw(parsed: unknown): void {
    if (typeof parsed !== 'object' || parsed === null) return;
    const record = parsed as Record<string, unknown>;
    const toolsList = record['tools'];
    if (!Array.isArray(toolsList)) return;

    // Extract tsProjectToolDefaults from the raw parsed config (before DEFAULTS merge)
    const settingsRaw = isRecord(record['settings']) ? record['settings'] as Record<string, unknown> : {};
    const tsDefs = isRecord(settingsRaw['tsProjectToolDefaults'])
      ? settingsRaw['tsProjectToolDefaults'] as Partial<TsProjectToolDefaults>
      : undefined;
    const scriptDir = (tsDefs?.scriptDir as string | undefined) ?? '.pi/project-tools';

    const resolveTemplate = (val: string): string =>
      val.replace(/\{\{projectRoot\}\}/g, this.projectRoot);

    for (let i = 0; i < toolsList.length; i++) {
      const tool = toolsList[i];
      if (!isRecord(tool) || tool['type'] !== 'tsProjectTool') continue;

      const toolRecord = tool as Record<string, unknown>;
      const toolName = typeof toolRecord['name'] === 'string' ? toolRecord['name'] : `tool_${i}`;

      // Resolve script path
      let scriptPath: string;
      if (typeof toolRecord['scriptPath'] === 'string') {
        scriptPath = resolveTemplate(toolRecord['scriptPath'] as string);
      } else {
        // Default: <scriptDir>/<toolName>.ts  — keep as a relative path so
        // {{projectRoot}}-style template substitution is handled at runtime by
        // the executor; we emit the literal projectRoot path here.
        const resolvedDir = resolveTemplate(scriptDir);
        scriptPath = path.isAbsolute(resolvedDir)
          ? path.join(resolvedDir, `${toolName}.ts`)
          : path.join(this.projectRoot, resolvedDir, `${toolName}.ts`);
      }

      // Collect per-tool overrides (fields that survive the tsProjectTool → command transform)
      const {
        type: _typeDiscard,
        scriptPath: _scriptPathDiscard,
        name,
        description,
        usageNotes,
        failureLimit,
        optional,
        validationRules,
        profile,
        defaultArgs: perToolExtraArgs,
        argsMode,
        allowArgs,
        argumentPathScope,
        cwd,
        allowCwdOverride,
        timeoutMs,
        wrapperTimeoutMs,
        acceptMaxBuffer,
        successExitCodes,
        env,
        serialize,
        ...rest
      } = toolRecord;

      // Build expanded command tool
      const expanded: Record<string, unknown> = {
        name,
        type: 'command',
        command: 'node',
        // defaultArgs: [--experimental-strip-types, <scriptPath>, ...perToolExtraArgs]
        defaultArgs: [
          '--experimental-strip-types',
          scriptPath,
          ...(Array.isArray(perToolExtraArgs) ? (perToolExtraArgs as string[]) : [])
        ],
        // argsMode: per-tool → tsProjectToolDefaults → 'append'
        argsMode: argsMode ?? tsDefs?.argsMode ?? 'append',
        // allowArgs: per-tool → tsProjectToolDefaults → true
        allowArgs: allowArgs ?? tsDefs?.allowArgs ?? true,
      };

      // Apply remaining per-tool fields (only if defined)
      if (description !== undefined) expanded['description'] = description;
      if (usageNotes !== undefined) expanded['usageNotes'] = usageNotes;
      if (failureLimit !== undefined) expanded['failureLimit'] = failureLimit;
      if (optional !== undefined) expanded['optional'] = optional;
      if (validationRules !== undefined) expanded['validationRules'] = validationRules;
      if (profile !== undefined) expanded['profile'] = profile;
      if (argumentPathScope !== undefined) expanded['argumentPathScope'] = argumentPathScope;
      if (env !== undefined) expanded['env'] = env;
      if (allowCwdOverride !== undefined) expanded['allowCwdOverride'] = allowCwdOverride;
      if (acceptMaxBuffer !== undefined) expanded['acceptMaxBuffer'] = acceptMaxBuffer;
      if (successExitCodes !== undefined) expanded['successExitCodes'] = successExitCodes;
      // serialize survives the tsProjectTool → command transform so the expanded
      // command tool acquires the generic cross-process lock (s3wp/0yt5.23).
      if (serialize !== undefined) expanded['serialize'] = serialize;

      // cwd: per-tool → tsProjectToolDefaults
      const resolvedCwd = cwd ?? tsDefs?.cwd;
      if (resolvedCwd !== undefined) expanded['cwd'] = resolvedCwd;

      // timeoutMs: per-tool → tsProjectToolDefaults
      const resolvedTimeoutMs = timeoutMs ?? tsDefs?.timeoutMs;
      if (resolvedTimeoutMs !== undefined) expanded['timeoutMs'] = resolvedTimeoutMs;

      // wrapperTimeoutMs: per-tool → tsProjectToolDefaults
      const resolvedWrapperTimeoutMs = wrapperTimeoutMs ?? tsDefs?.wrapperTimeoutMs;
      if (resolvedWrapperTimeoutMs !== undefined) expanded['wrapperTimeoutMs'] = resolvedWrapperTimeoutMs;

      // Preserve any unrecognized fields (forward compatibility)
      for (const [k, v] of Object.entries(rest)) {
        expanded[k] = v;
      }

      toolsList[i] = expanded;
    }
  }

  /**
   * Returns the absolute path to the packaged harness.schema.json.
   * Protected so test subclasses can override it to inject a custom install path.
   */
  protected resolveInstallSchemaPath(): string {
    return getPackagedSchemaPath();
  }

  /**
   * Pre-schema raw check for deprecated lifecycle fields.
   *
   * Runs before AJV so the error names the offending tool + replacement rather
   * than surfacing a generic "additionalProperties" schema violation.
   */
  private preValidateNoDeprecatedToolFields(config: unknown): void {
    if (!isRecord(config)) return;
    const tools = config['tools'];
    if (!Array.isArray(tools)) return;
    for (const tool of tools) {
      if (!isRecord(tool)) continue;
      const name = typeof tool['name'] === 'string' ? tool['name'] : '(unknown)';
      const staleFields: string[] = [];
      if ('deprecated' in tool) staleFields.push('deprecated');
      if ('hidden' in tool) staleFields.push('hidden');
      if ('replacedBy' in tool) staleFields.push('replacedBy');
      if ('deprecationReason' in tool) staleFields.push('deprecationReason');
      if (staleFields.length > 0) {
        const replacedBy = Array.isArray(tool['replacedBy']) ? tool['replacedBy'] as string[] : undefined;
        const replacementHint = replacedBy?.length
          ? ` Replace all references with: ${replacedBy.map(r => `"${r}"`).join(', ')}.`
          : ' Remove the tool from config and update all references to use its replacement.';
        throw new Error(
          `Tool "${name}" declares stale deprecated-lifecycle field(s): ${staleFields.join(', ')}. ` +
          `Deprecated/replaced tools must be removed from config entirely — they cannot satisfy gates or appear in requiredTools.` +
          replacementHint
        );
      }
    }
  }

  /**
   * pi-experiment-202g: v2 schema root admission boundary.
   *
   * Runs BEFORE AJV schema validation, on the raw parsed document.
   *
   * Version routing:
   *   - Absent version → v1 behavior (no-op here; existing schema + semantics apply).
   *   - version: 2 → v2 admission: reject removed v1 fields with path-specific diagnostics.
   *   - Any other value → fail closed (unknown version, startup-fatal).
   *
   * Removed v1 fields rejected in v2 configs (AC2 — full 8-category set):
   *   settings.startState           — replaced by statechart.initial in v2.
   *   settings.teamLeadSystemPrompt — removed in v2 config surface.
   *   settings.projectObjective     — removed in v2 config surface.
   *   settings.worktreePolicy       — replaced by per-state provisionWorktree in v2.
   *   statechart.initialState       — replaced by statechart.initial in v2.
   *   statechart.terminalStates     — replaced by statechart.terminal in v2.
   *   states.*.on                   — v1 transition map; v2 uses states.*.transitions only.
   *   include / extends             — v2 is a single file; no external config composition.
   *
   * Also enforces AC5: terminal sink not runnable (statechart.terminal names must
   * not also appear as runnable states with actions).
   */
  private preValidateV2Admission(config: unknown): void {
    if (!isRecord(config)) return;
    const versionRaw = config['version'];

    // Absent version → v1 path; skip v2 checks.
    if (versionRaw === undefined || versionRaw === null) return;

    // Unknown version → fail closed.
    if (versionRaw !== 2) {
      throw new Error(
        `Unknown harness config version: ${JSON.stringify(versionRaw)}. ` +
        `The only supported version values are: 2 (v2 schema) or absent (v1, backward-compatible). ` +
        `Check your harness.yaml version field and correct it to a supported value.`
      );
    }

    // version: 2 — reject removed v1 fields with path-specific diagnostics.
    const staleV1Fields: Array<{ path: string; hint: string }> = [];

    // Category 1–4: removed settings fields.
    const settings = isRecord(config['settings']) ? config['settings'] as Record<string, unknown> : {};

    if ('startState' in settings) {
      staleV1Fields.push({
        path: 'settings.startState',
        hint: 'Use statechart.initial instead to declare the starting state in a v2 config.'
      });
    }
    if ('teamLeadSystemPrompt' in settings) {
      staleV1Fields.push({
        path: 'settings.teamLeadSystemPrompt',
        hint: 'settings.teamLeadSystemPrompt has been removed from the v2 config surface. Remove this field from your harness.yaml.'
      });
    }
    if ('projectObjective' in settings) {
      staleV1Fields.push({
        path: 'settings.projectObjective',
        hint: 'settings.projectObjective has been removed from the v2 config surface. Remove this field from your harness.yaml.'
      });
    }
    if ('worktreePolicy' in settings) {
      staleV1Fields.push({
        path: 'settings.worktreePolicy',
        hint: 'settings.worktreePolicy has been removed from the v2 config surface. Use per-state provisionWorktree declarations instead.'
      });
    }

    // Category 5–6: stale statechart fields replaced by v2 counterparts.
    const statechart = isRecord(config['statechart']) ? config['statechart'] as Record<string, unknown> : {};

    if ('initialState' in statechart) {
      staleV1Fields.push({
        path: 'statechart.initialState',
        hint: 'Use statechart.initial instead — v2 names the start state with statechart.initial.'
      });
    }
    if ('terminalStates' in statechart) {
      staleV1Fields.push({
        path: 'statechart.terminalStates',
        hint: 'Use statechart.terminal instead — v2 lists terminal sink names with statechart.terminal.'
      });
    }

    // Category 7: states.*.on — v1 transition map not used in v2.
    const states = isRecord(config['states']) ? config['states'] as Record<string, unknown> : {};
    for (const [stateId, stateRaw] of Object.entries(states)) {
      if (isRecord(stateRaw) && 'on' in stateRaw) {
        staleV1Fields.push({
          path: `states.${stateId}.on`,
          hint: `Use states.${stateId}.transitions instead — v2 uses states.<state>.transitions only; the v1 "on" transition map is not supported.`
        });
      }
    }

    // Category 8: external config-composition fields.
    if ('include' in config) {
      staleV1Fields.push({
        path: 'include',
        hint: 'v2 harness configs are single YAML files. File references are only allowed for prompt/checklist/artifact content paths, not config fragments. Remove the include field.'
      });
    }
    if ('extends' in config) {
      staleV1Fields.push({
        path: 'extends',
        hint: 'v2 harness configs are single YAML files. File references are only allowed for prompt/checklist/artifact content paths, not config fragments. Remove the extends field.'
      });
    }

    if (staleV1Fields.length > 0) {
      const details = staleV1Fields.map(f => `  ${f.path}: ${f.hint}`).join('\n');
      throw new Error(
        `v2 harness config (version: 2) contains ${staleV1Fields.length} removed v1 field(s):\n` +
        details + '\n' +
        `Remove the stale fields to comply with the v2 schema. ` +
        `These fields are no longer part of the v2 config contract and will not be read by the runtime.`
      );
    }

    // AC5: terminal sink not runnable.
    // A name in statechart.terminal must not also be a runnable state (a state with actions).
    const terminalV2 = Array.isArray(statechart['terminal']) ? statechart['terminal'] as string[] : [];
    for (const sinkName of terminalV2) {
      const stateRaw = states[sinkName];
      if (isRecord(stateRaw) && Array.isArray(stateRaw['actions']) && (stateRaw['actions'] as unknown[]).length > 0) {
        throw new Error(
          `v2 statechart.terminal lists "${sinkName}" as a terminal sink, but "${sinkName}" is also declared as a runnable state with actions. ` +
          `Terminal sinks must not be runnable states. ` +
          `Either remove "${sinkName}" from statechart.terminal, or remove its actions block to make it a true sink state.`
        );
      }
    }
  }

  private validate(config: unknown): asserts config is HarnessConfig {
    // Pre-schema check: deprecated lifecycle fields must not appear in any tool.
    // Runs before AJV so the diagnostic names the offending tool + replacement.
    this.preValidateNoDeprecatedToolFields(config);

    const ajv = new Ajv({ allErrors: true, useDefaults: true });
    addFormats(ajv);

    const installSchemaPath = this.resolveInstallSchemaPath();
    const projectSchemaPath = resolveProjectFrom(this.projectRoot, 'harness.schema.json');
    const schemaPath = fs.existsSync(installSchemaPath) ? installSchemaPath : projectSchemaPath;
    if (!fs.existsSync(schemaPath)) {
      throw new Error(
        `Harness schema not found — startup aborted. ` +
        `Attempted paths:\n` +
        `  install: ${installSchemaPath}\n` +
        `  project: ${projectSchemaPath}\n` +
        `The packaged schema ships with the orr-else package. ` +
        `Call getPackagedSchemaPath() (from SchemaRegistry) to locate it, ` +
        `or ensure the package is installed correctly.`
      );
    }

    let schema: Record<string, unknown>;
    try {
      schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    } catch (err) {
      throw new Error(
        `Harness schema at "${schemaPath}" could not be parsed — startup aborted. ` +
        `Attempted paths:\n` +
        `  install: ${installSchemaPath}\n` +
        `  project: ${projectSchemaPath}\n` +
        `Ensure the file is valid JSON. Call getPackagedSchemaPath() (from SchemaRegistry) ` +
        `to locate the authoritative packaged schema. Parse error: ${String(err)}`
      );
    }

    let validate: ReturnType<typeof ajv.compile>;
    try {
      validate = ajv.compile(schema);
    } catch (err) {
      throw new Error(
        `Harness schema at "${schemaPath}" could not be compiled by AJV — startup aborted. ` +
        `Attempted paths:\n` +
        `  install: ${installSchemaPath}\n` +
        `  project: ${projectSchemaPath}\n` +
        `Ensure the file is a valid JSON Schema draft-07 document. ` +
        `Call getPackagedSchemaPath() (from SchemaRegistry) to locate the authoritative schema. ` +
        `Compile error: ${String(err)}`
      );
    }

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
   * A `statechart` block with explicit outcome vocabulary is REQUIRED:
   *   - Missing statechart block → startup-fatal error.
   *   - Missing explicit outcome vocabulary (advanceOutcomes/failedOutcomes/
   *     blockedOutcomes/customOutcomes) → startup-fatal error.
   *   - startState / statechart.initialState must exist in states.
   *   - Every transition target must be a defined state, a declared terminal state,
   *     OR a recognized coarse sink status (completed / blocked / deferred).
   *     Coarse sink targets exit the active statechart flow without spawning a worker.
   *   - All transition outcome keys must be in the declared vocabulary.
   */
  /**
   * pi-experiment-h05b: Fail startup if any tool in the config is declared with
   * deprecated/hidden/replacedBy/deprecationReason fields.
   *
   * Deprecated/replaced tools must be REMOVED from config entirely. Stale
   * references to removed tools are caught by validateNoStaleToolReferences.
   * The invocation-time REJECTED guard in executeConfiguredProjectTool remains
   * as a defensive runtime guard for impossible/stale calls only.
   */
  private validateNoDeprecatedTools(config: HarnessConfig): void {
    for (const tool of config.tools || []) {
      const t = tool as { deprecated?: boolean; hidden?: boolean; replacedBy?: string[]; deprecationReason?: string };
      const staleFields: string[] = [];
      if (t.deprecated !== undefined) staleFields.push('deprecated');
      if (t.hidden !== undefined) staleFields.push('hidden');
      if (t.replacedBy !== undefined) staleFields.push('replacedBy');
      if (t.deprecationReason !== undefined) staleFields.push('deprecationReason');
      if (staleFields.length > 0) {
        const replacementHint = t.replacedBy?.length
          ? ` Replace all references with: ${t.replacedBy.map(r => `"${r}"`).join(', ')}.`
          : ' Remove the tool from config and update all references to use its replacement.';
        throw new Error(
          `Tool "${tool.name}" declares stale deprecated-lifecycle field(s): ${staleFields.join(', ')}. ` +
          `Deprecated/replaced tools must be removed from config entirely — they cannot satisfy gates or appear in requiredTools.` +
          replacementHint
        );
      }
    }
  }

  /**
   * 1elr.8: Reject observeOnly tools appearing in requiredTools.
   *
   * observeOnly extension tools are declared for observation only — the harness
   * records their calls but never enforces host-inventory requirements for them.
   * Because they make no guarantee of being callable or present in the Pi host
   * inventory, they CANNOT satisfy a requiredTools gate. Listing an observeOnly
   * tool in any state or action requiredTools is a config bug that is caught at
   * config-load time, not at runtime.
   *
   * Mirrors the validateDeprecatedRequiredTools cross-reference pattern.
   */
  private validateObserveOnlyInRequiredTools(config: HarnessConfig): void {
    const observeOnlyTools = new Set<string>();
    for (const tool of config.tools || []) {
      const t = tool as { observeOnly?: boolean };
      if (t.observeOnly) {
        observeOnlyTools.add(tool.name);
      }
    }
    if (observeOnlyTools.size === 0) return;

    const checkRequiredTools = (requiredTools: import('./domain/StateModels.js').RequiredTool[] | undefined, location: string): void => {
      for (const rt of requiredTools || []) {
        const name = typeof rt === 'string' ? rt : rt.name;
        if (observeOnlyTools.has(name)) {
          throw new Error(
            `${location} references requiredTool "${name}" which is declared observeOnly. ` +
            `observeOnly tools cannot satisfy requiredTools — they are recorded for observation only ` +
            `and make no guarantee of being callable. ` +
            `Either declare "${name}" without observeOnly:true, or remove it from requiredTools.`
          );
        }
      }
    };

    for (const [stateId, state] of Object.entries(config.states || {})) {
      checkRequiredTools(state.requiredTools, `State "${stateId}"`);
      for (const action of state.actions || []) {
        checkRequiredTools(action.requiredTools, `State "${stateId}" action "${action.id}"`);
      }
    }
  }

  /**
   * r0oh: Reject inert traceability settings.
   *
   * settings.traceability is meaningful only when a concrete, DECLARED owner is
   * named. Two checks are applied in sequence:
   *   1. ownedBy must be present and non-empty.
   *   2. ownedBy must resolve to a name in config.tools[].name (the set of
   *      declared verifiers/tools). A typo or reference to a non-existent tool
   *      implies the setting is still inert; that is rejected with a diagnostic
   *      that lists the known names — mirroring the startState and
   *      validateDeprecatedRequiredTools cross-reference patterns.
   */
  private validateTraceabilityOwner(config: HarnessConfig): void {
    const traceability = config.settings.traceability;
    if (!traceability) return; // absent → fine; no inert setting present
    if (!traceability.ownedBy || !traceability.ownedBy.trim()) {
      throw new Error(
        'settings.traceability requires an ownedBy declaration naming the verifier or tool ' +
        'that owns and enforces the traceability contract. ' +
        'Without an explicit owner, the setting is inert and implies enforcement that does not exist. ' +
        'Add `ownedBy: <verifierOrToolName>` (e.g. ownedBy: plan_contract) to the traceability block, ' +
        'or remove the traceability block if no project verifier enforces it.'
      );
    }
    const knownOwners = new Set<string>((config.tools || []).map(t => t.name));
    if (!knownOwners.has(traceability.ownedBy)) {
      const knownList = [...knownOwners].sort().join(', ') || '(none declared)';
      throw new Error(
        `settings.traceability.ownedBy "${traceability.ownedBy}" does not match any declared tool. ` +
        `Known tools: ${knownList}. ` +
        `Declare a tool whose name matches ownedBy, or correct the spelling.`
      );
    }
  }

  /**
   * pi-experiment-145m: Reject configs that do not declare settings.worktreePolicy.default.
   *
   * The harness no longer defaults a missing policy to 'always'. Every harness
   * config must declare its intent explicitly so the provisioning behaviour is
   * visible in the config file rather than implied by the absence of a field.
   *
   * Replacement example included in the diagnostic so the author can fix the
   * issue without reading documentation.
   */
  private validateWorktreePolicy(config: HarnessConfig): void {
    const policy = config.settings?.worktreePolicy;
    if (!policy || policy.default === undefined) {
      throw new Error(
        'settings.worktreePolicy.default is required but was not declared. ' +
        'The harness no longer defaults a missing worktree policy to "always". ' +
        'Declare the intended default explicitly, for example:\n' +
        '  settings:\n' +
        '    worktreePolicy:\n' +
        '      default: always   # or: never\n' +
        'Use "always" to provision an isolated git worktree for every state (original behavior). ' +
        'Use "never" to run all states at the project root unless a state declares provisionWorktree: true.'
      );
    }
  }

  /**
   * pi-experiment-buvj: Reject configs that declare compatibility fields.
   *
   * settings.compatibilityMode and settings.compatibility were removed in buvj.
   * These fields are no longer part of the harness contract; a config that
   * still declares them is stale and must be updated.  The error includes the
   * exact field names and migration guidance so the author can fix without
   * reading documentation.
   */
  private validateNoCompatibilityFields(config: HarnessConfig): void {
    const settings = config.settings as Record<string, unknown>;
    const hasMode = 'compatibilityMode' in settings;
    const hasCompat = 'compatibility' in settings;
    if (hasMode || hasCompat) {
      const fields = [hasMode && 'settings.compatibilityMode', hasCompat && 'settings.compatibility']
        .filter(Boolean).join(' and ');
      throw new Error(
        `${fields} ${hasMode && hasCompat ? 'have been' : 'has been'} removed (pi-experiment-buvj). ` +
        `The compatibility-context surface is no longer part of the Orr Else core harness. ` +
        `Remove the ${fields} ${hasMode && hasCompat ? 'fields' : 'field'} from your harness.yaml to start.`
      );
    }
  }

  /**
   * pi-experiment-5lbg: Reject configs that still reference the retired
   * orrElseFrameworkRoot template alias.
   *
   * The alias (settings.artifacts.templates.orrElseFrameworkRoot) has been
   * removed with no back-compat.  Configs must use settings.roots plus
   * {{roots.NAME}} or the canonical {{frameworkRoot}} token.  Failing fast
   * here surfaces the config bug deterministically at startup rather than
   * silently producing wrong paths.
   */
  private validateNoLegacyOrrElseFrameworkRoot(config: HarnessConfig): void {
    const templates = config.settings.artifacts?.templates as Record<string, unknown> | undefined;
    if (templates && 'orrElseFrameworkRoot' in templates) {
      throw new Error(
        'settings.artifacts.templates.orrElseFrameworkRoot has been retired (pi-experiment-5lbg). ' +
        'Use settings.roots to declare named roots and reference them with {{roots.NAME}} ' +
        'or use the {{frameworkRoot}} token. ' +
        'Remove orrElseFrameworkRoot from your harness.yaml to start.'
      );
    }
  }

  /**
   * zog2.9: Reject project-configured tools that declare serialize: true without a
   * non-empty serializationKey in their sideEffectContract.
   *
   * A serialized tool MUST name the lock bucket so two different tools sharing a
   * backend can genuinely serialize against each other (same key → same lock).
   * A tool that omits serializationKey but declares serialize:true has an
   * inconsistent contract and is rejected at startup.
   */
  /**
   * pi-experiment-8ieq: Reject tools that declare probeContext:true without also
   * declaring sideEffectContract.safeForReadinessProbe: true.
   *
   * A tool marked probeContext:true will be executed at startup before model
   * spend. Executing it without the safe-for-probe declaration is unsafe. The
   * harness rejects this combination at config-load time so operators get a
   * deterministic startup error rather than a runtime probe failure.
   */
  private validateProbeContextDeclarations(config: HarnessConfig): void {
    for (const tool of config.tools || []) {
      const t = tool as { probeContext?: boolean; sideEffectContract?: { safeForReadinessProbe?: boolean } };
      if (t.probeContext === true) {
        if (t.sideEffectContract?.safeForReadinessProbe !== true) {
          const configPath = this.getConfigPath();
          throw new Error(
            `Tool "${tool.name}" (${configPath}) declares probeContext: true but ` +
            `its sideEffectContract.safeForReadinessProbe is not true. ` +
            `Readiness probes must only run tools declared safe for probing. ` +
            `Add sideEffectContract: { safeForReadinessProbe: true, ... } to the tool declaration.`
          );
        }
      }
    }
  }

  /**
   * pi-experiment-t6gw: Reject tools that declare a retryPolicy without a
   * sideEffectContract.idempotencyClass.
   *
   * A retry policy is useless without an idempotencyClass declaration: the
   * retry pipeline will always reject the retry with REJECT_NO_IDEMPOTENCY_CLASS.
   * Fail fast at config load so operators get a deterministic startup error.
   *
   * Note: idempotencyClass is NOT required for tools without a retryPolicy —
   * this validation only fires when retryPolicy is explicitly declared.
   */
  private validateRetryPolicyDeclarations(config: HarnessConfig): void {
    for (const tool of config.tools || []) {
      const t = tool as { retryPolicy?: { maxAttempts?: number }; sideEffectContract?: { idempotencyClass?: string } };
      if (t.retryPolicy !== undefined) {
        const idempotencyClass = t.sideEffectContract?.idempotencyClass;
        if (!idempotencyClass) {
          const configPath = this.getConfigPath();
          throw new Error(
            `Tool "${tool.name}" (${configPath}) declares retryPolicy but has no ` +
            `sideEffectContract.idempotencyClass. The retry pipeline requires an idempotencyClass ` +
            `to determine retry eligibility. Add sideEffectContract: { idempotencyClass: "idempotent" | ` +
            `"at_least_once" | "non_idempotent", ... } to the tool declaration.`
          );
        }
      }
    }
  }

  private validateSerializeRequiresSerializationKey(config: HarnessConfig): void {
    for (const tool of config.tools || []) {
      const t = tool as { serialize?: boolean; sideEffectContract?: { serializationKey?: string | null } };
      if (t.serialize === true) {
        const key = t.sideEffectContract?.serializationKey;
        if (typeof key !== 'string' || key.trim().length === 0) {
          throw new Error(
            `Tool "${tool.name}" declares serialize: true but its sideEffectContract.serializationKey is missing or empty. ` +
            `Serialized tools must declare a non-empty serializationKey so the harness can deterministically enforce ` +
            `non-concurrent access for tools sharing the same backend. ` +
            `Add sideEffectContract: { serializationKey: "<key>", ... } to the tool declaration.`
          );
        }
      }
    }
  }

  /**
   * pi-experiment-6q0y.4: Validate tool prompt profile declarations.
   *
   * Checks (all startup-fatal):
   *   1. Each profile entry references a known tool name (in config.tools).
   *   2. No duplicate tool entries within a single profile (same tool referenced twice).
   *   3. Profile text must not contain volatile template placeholders (e.g. {{beadId}},
   *      {{worktreePath}}). Profile text is placed in the stable cache prefix; volatile
   *      templates would make it non-cacheable.
   *   4. Profile text must not exceed 700 characters.
   *   5. Every toolPromptProfile reference at settings, state, or action scope must
   *      resolve to a declared key in settings.toolPromptProfiles.
   */
  private validateToolPromptProfiles(config: HarnessConfig): void {
    const profiles = config.settings.toolPromptProfiles;
    if (!profiles || Object.keys(profiles).length === 0) {
      // No profiles declared — still check that no references exist.
      this.validateToolPromptProfileReferences(config, new Set<string>());
      return;
    }

    const knownToolNames = new Set((config.tools ?? []).map(t => t.name));
    const declaredProfileIds = new Set(Object.keys(profiles));

    // Volatile template placeholder pattern — any {{word}} in profile text.
    // These would be placed verbatim in the stable cache prefix and must be absent.
    const VOLATILE_PATTERN = /\{\{[^}]+\}\}/;

    for (const [profileId, entries] of Object.entries(profiles)) {
      const seenTools = new Set<string>();

      for (const entry of entries) {
        // 1. Unknown tool name.
        if (!knownToolNames.has(entry.tool)) {
          const knownList = [...knownToolNames].sort().join(', ') || '(none declared)';
          throw new Error(
            `settings.toolPromptProfiles["${profileId}"] references unknown tool "${entry.tool}". ` +
            `Tool prompt profile entries must reference declared config.tools names. ` +
            `Known tools: ${knownList}. ` +
            `Declare the tool in config.tools or correct the name.`
          );
        }

        // 2. Duplicate tool entry within this profile.
        if (seenTools.has(entry.tool)) {
          throw new Error(
            `settings.toolPromptProfiles["${profileId}"] has a duplicate tool entry for "${entry.tool}". ` +
            `Each tool may appear at most once within a single profile. ` +
            `Remove the duplicate tool profile entry.`
          );
        }
        seenTools.add(entry.tool);

        // 3. Volatile template placeholders.
        if (VOLATILE_PATTERN.test(entry.text)) {
          const match = entry.text.match(VOLATILE_PATTERN)?.[0] ?? '';
          throw new Error(
            `settings.toolPromptProfiles["${profileId}"] tool "${entry.tool}" text contains volatile template placeholder ${match}. ` +
            `Tool prompt profile text is placed in the stable cache prefix and must not contain runtime-specific templates. ` +
            `Remove all {{...}} placeholders from the profile text.`
          );
        }

        // 4. Text length.
        if (entry.text.length > 700) {
          throw new Error(
            `settings.toolPromptProfiles["${profileId}"] tool "${entry.tool}" text exceeds 700 characters ` +
            `(actual: ${entry.text.length} chars). ` +
            `Shorten the profile text to at most 700 characters.`
          );
        }
      }
    }

    // 5. All profile references must resolve.
    this.validateToolPromptProfileReferences(config, declaredProfileIds);
  }

  /**
   * Check that every toolPromptProfile reference (at settings, state, and action
   * scope) resolves to a declared profile ID.
   */
  private validateToolPromptProfileReferences(config: HarnessConfig, declaredProfileIds: Set<string>): void {
    const check = (ref: string | undefined, location: string): void => {
      if (ref === undefined) return;
      if (!declaredProfileIds.has(ref)) {
        const known = [...declaredProfileIds].sort().join(', ') || '(none declared)';
        throw new Error(
          `${location} references unknown tool prompt profile "${ref}". ` +
          `Declared profiles: ${known}. ` +
          `Define the profile in settings.toolPromptProfiles or correct the profile name.`
        );
      }
    };

    check(config.settings.toolPromptProfile, 'settings.toolPromptProfile');

    for (const [stateId, state] of Object.entries(config.states ?? {})) {
      check(state.toolPromptProfile, `State "${stateId}" toolPromptProfile`);
      for (const action of state.actions ?? []) {
        check(action.toolPromptProfile, `State "${stateId}" action "${action.id}" toolPromptProfile`);
      }
    }
  }

  /**
   * pi-experiment-6q0y.6: Reject configs with duplicate project tool names,
   * duplicate skill paths, or duplicate worker extension paths.
   *
   * Duplicates produce non-deterministic prompt text and break cache-key stability.
   * Rejecting them at startup catches config bugs early and ensures the stable
   * block ordering canonicalisation (sort-before-render) remains sound.
   */
  private validateNoDuplicateStableArrays(config: HarnessConfig): void {
    // Duplicate project tool names (config.tools[].name).
    const toolNamesSeen = new Set<string>();
    const dupToolNames: string[] = [];
    for (const tool of config.tools || []) {
      if (toolNamesSeen.has(tool.name)) {
        dupToolNames.push(tool.name);
      }
      toolNamesSeen.add(tool.name);
    }
    if (dupToolNames.length > 0) {
      throw new Error(
        `config.tools declares duplicate project tool name(s): ${dupToolNames.map(n => `"${n}"`).join(', ')}. ` +
        `Each tool name must appear at most once. ` +
        `Remove or rename the duplicate tool declaration(s).`
      );
    }

    // Duplicate skill paths (settings.pi.skillPaths).
    const skillPathsSeen = new Set<string>();
    const dupSkillPaths: string[] = [];
    for (const sp of config.settings.pi?.skillPaths || []) {
      if (skillPathsSeen.has(sp)) {
        dupSkillPaths.push(sp);
      }
      skillPathsSeen.add(sp);
    }
    if (dupSkillPaths.length > 0) {
      throw new Error(
        `settings.pi.skillPaths declares duplicate skill path(s): ${dupSkillPaths.map(p => `"${p}"`).join(', ')}. ` +
        `Each skill path must appear at most once. ` +
        `Remove the duplicate path(s).`
      );
    }

    // Duplicate worker extension paths (settings.pi.workerExtensions).
    const extSeen = new Set<string>();
    const dupExts: string[] = [];
    for (const ext of config.settings.pi?.workerExtensions || []) {
      if (extSeen.has(ext)) {
        dupExts.push(ext);
      }
      extSeen.add(ext);
    }
    if (dupExts.length > 0) {
      throw new Error(
        `settings.pi.workerExtensions declares duplicate worker extension path(s): ${dupExts.map(p => `"${p}"`).join(', ')}. ` +
        `Each worker extension path must appear at most once. ` +
        `Remove the duplicate path(s).`
      );
    }
  }

  /**
   * pi-experiment-6q0y.44: Validate state context policy declarations.
   *
   * Rules (startup-fatal):
   *   1. When a state declares contextPolicy as a string, it must be a known
   *      StateContextPolicy value (freshSubagent or namedContinuation).
   *   2. When mode = namedContinuation, contextKey must be a non-empty string
   *      containing only alphanumeric, dash, and underscore characters.
   *   3. Invalid structured forms (missing mode) are rejected.
   *
   * Default (absent contextPolicy) is freshSubagent — no error, no action.
   * This keeps cerdiwen (which does not declare contextPolicy) loading cleanly.
   */
  private validateStateContextPolicies(config: HarnessConfig): void {
    const VALID_CONTEXT_KEY_RE = /^[A-Za-z0-9_-]+$/;
    const VALID_MODES = new Set<string>([
      StateContextPolicy.FRESH_SUBAGENT,
      StateContextPolicy.NAMED_CONTINUATION
    ]);

    for (const [stateId, state] of Object.entries(config.states || {})) {
      const raw = state?.contextPolicy;
      if (raw === undefined || raw === null) continue;

      if (typeof raw === 'string') {
        if (!VALID_MODES.has(raw)) {
          throw new Error(
            `State "${stateId}" declares contextPolicy: "${raw}" which is not a recognised mode. ` +
            `Valid values are: freshSubagent, namedContinuation. ` +
            `Use contextPolicy: freshSubagent (default) or contextPolicy: { mode: namedContinuation, contextKey: "yourKey" }.`
          );
        }
        // String shorthand for namedContinuation without contextKey — reject.
        if (raw === StateContextPolicy.NAMED_CONTINUATION) {
          throw new Error(
            `State "${stateId}" declares contextPolicy: namedContinuation without a contextKey. ` +
            `Named continuation requires a stable context key. ` +
            `Use the structured form: contextPolicy: { mode: namedContinuation, contextKey: "yourKey" }.`
          );
        }
        continue;
      }

      if (typeof raw === 'object') {
        const structured = raw as { mode?: unknown; contextKey?: unknown };
        if (!structured.mode || typeof structured.mode !== 'string') {
          throw new Error(
            `State "${stateId}" declares a contextPolicy object but is missing the required "mode" field. ` +
            `Declare contextPolicy: { mode: freshSubagent } or contextPolicy: { mode: namedContinuation, contextKey: "yourKey" }.`
          );
        }
        if (!VALID_MODES.has(structured.mode)) {
          throw new Error(
            `State "${stateId}" declares contextPolicy.mode: "${structured.mode}" which is not a recognised mode. ` +
            `Valid values are: freshSubagent, namedContinuation.`
          );
        }
        if (structured.mode === StateContextPolicy.NAMED_CONTINUATION) {
          if (!structured.contextKey || typeof structured.contextKey !== 'string' || structured.contextKey.trim().length === 0) {
            throw new Error(
              `State "${stateId}" declares contextPolicy.mode: namedContinuation but contextKey is missing or empty. ` +
              `Named continuation requires a stable non-empty context key. ` +
              `Add contextKey: "yourKey" to the contextPolicy object.`
            );
          }
          if (!VALID_CONTEXT_KEY_RE.test(structured.contextKey)) {
            throw new Error(
              `State "${stateId}" declares contextPolicy.contextKey: "${structured.contextKey}" which contains invalid characters. ` +
              `Context keys must contain only alphanumeric characters, dashes, and underscores.`
            );
          }
        }
        continue;
      }

      throw new Error(
        `State "${stateId}" declares a contextPolicy with an unrecognised type (${typeof raw}). ` +
        `Use a string shorthand (freshSubagent) or a structured object { mode, contextKey }.`
      );
    }
  }

  /**
   * pi-experiment-6q0y.44 AC3: Reject legacy `same` contextMode declarations.
   *
   * `same` meant "continue the same session" — that semantics is now expressed
   * explicitly via contextPolicy: { mode: namedContinuation, contextKey }.
   * There is NO compatibility shim; `same` must be removed from all configs.
   */
  private validateNoLegacySameContextMode(config: HarnessConfig): void {
    const LEGACY_SAME = 'same';

    const checkMode = (location: string, mode: string | undefined) => {
      if (mode === LEGACY_SAME) {
        throw new Error(
          `${location} declares contextMode: "same" which is a legacy no-compat mode. ` +
          `"same" has been removed. Convert to an explicit named continuation: ` +
          `contextPolicy: { mode: namedContinuation, contextKey: "yourKey" } on the state ` +
          `and remove the per-action contextMode.`
        );
      }
    };

    checkMode('settings', config.settings?.defaultActionContextMode);
    for (const [stateId, state] of Object.entries(config.states || {})) {
      checkMode(`State "${stateId}"`, state?.defaultActionContextMode);
      for (const action of state?.actions || []) {
        checkMode(`State "${stateId}" action "${action.id}"`, action.contextMode);
      }
    }
  }

  /**
   * pi-experiment-6q0y.44 AC5: compute and log the deterministic context-policy
   * fingerprint at config load time.
   *
   * Computes a SHA-256 digest of the sorted state-policy table (mode + contextKey
   * + producesContextKey per state) so that every config load leaves a deterministic
   * audit record.  The full table is logged at info level; the coordinator startup
   * also records this as a CONTEXT_POLICY_FINGERPRINT_RECORDED domain event.
   *
   * Uses inline hashing to avoid importing from the extension layer (circular import).
   */
  private logContextPolicyFingerprint(config: HarnessConfig): void {
    try {
      const stateIds = Object.keys(config.states || {}).sort();
      const rows = stateIds.map(stateId => {
        const raw = config.states?.[stateId]?.contextPolicy;
        let mode = StateContextPolicy.FRESH_SUBAGENT;
        let contextKey: string | undefined;
        let producesContextKey: string | undefined;
        if (typeof raw === 'string' && raw === StateContextPolicy.NAMED_CONTINUATION) {
          mode = StateContextPolicy.NAMED_CONTINUATION;
        } else if (raw && typeof raw === 'object') {
          const s = raw as { mode?: string; contextKey?: string; producesContextKey?: string };
          if (s.mode === StateContextPolicy.NAMED_CONTINUATION) {
            mode = StateContextPolicy.NAMED_CONTINUATION;
            contextKey = s.contextKey;
          }
          producesContextKey = s.producesContextKey;
        }
        return { stateId, mode, contextKey, producesContextKey };
      });
      const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      Logger.info(Component.CONFIG, 'Context-policy fingerprint computed at config load (AC5)', {
        digest,
        stateCount: stateIds.length
      });
    } catch {
      // Best-effort: fingerprint computation must never block config load.
    }
  }

  private validateSemantics(config: HarnessConfig): void {
    this.validateNoCompatibilityFields(config);
    this.validateNoLegacyOrrElseFrameworkRoot(config);
    this.validateNoDeprecatedTools(config);
    this.validateObserveOnlyInRequiredTools(config);
    this.validateTraceabilityOwner(config);
    // pi-experiment-202g: worktreePolicy is a removed v1 field in v2 configs.
    // v2 configs (version: 2) do not declare worktreePolicy; skip this check.
    if (config.version !== 2) {
      this.validateWorktreePolicy(config);
    }
    this.validateSerializeRequiresSerializationKey(config);
    this.validateProbeContextDeclarations(config);
    this.validateRetryPolicyDeclarations(config);
    this.validateNoDuplicateStableArrays(config);
    this.validateToolPromptProfiles(config);
    this.validateStateContextPolicies(config);
    this.validateNoLegacySameContextMode(config);
    lintActiveToolSets(config);
    this.logContextPolicyFingerprint(config);

    const stateIds = new Set(Object.keys(config.states || {}));
    const sc = config.statechart;

    // ── Mandatory statechart block ────────────────────────────────────────────
    // A harness config without a statechart block is not a valid config.
    // All statechart semantics are now mandatory and strict.
    if (!sc) {
      throw new Error(
        'statechart block is required but missing from this harness config. ' +
        'Add a statechart block with terminalStates, advanceOutcomes, failedOutcomes, ' +
        'blockedOutcomes, and valid transition targets. ' +
        'No-statechart legacy mode is no longer supported.'
      );
    }

    // ── Mandatory explicit outcome vocabulary ─────────────────────────────────
    // A statechart block without explicit outcome vocabulary is also rejected.
    const hasExplicitVocab =
      sc.advanceOutcomes !== undefined ||
      sc.failedOutcomes !== undefined ||
      sc.blockedOutcomes !== undefined ||
      sc.customOutcomes !== undefined;
    if (!hasExplicitVocab) {
      throw new Error(
        'statechart block is present but declares no explicit outcome vocabulary ' +
        '(advanceOutcomes/failedOutcomes/blockedOutcomes/customOutcomes). ' +
        'Declare at least advanceOutcomes, failedOutcomes, and blockedOutcomes so every ' +
        'transition outcome is deterministically classified. ' +
        'A statechart with only terminalStates/initialState is no longer accepted.'
      );
    }

    // pi-experiment-202g: v2 configs use statechart.terminal (v2 field) instead of
    // statechart.terminalStates (v1 field). Resolve the correct terminal list by version.
    const terminalStates = new Set<string>(
      config.version === 2
        ? (sc.terminal ?? [BeadStatus.COMPLETED])
        : (sc.terminalStates ?? [BeadStatus.COMPLETED])
    );
    // knownTargets = defined states ∪ declared terminal states ∪ recognized
    // coarse sink statuses (completed / blocked / deferred).  A transition
    // whose target is a coarse sink status is valid: the bead leaves the active
    // statechart flow rather than being spawned into a new worker state.
    const knownTargets = new Set([...stateIds, ...terminalStates, ...RECOGNIZED_COARSE_SINK_STATUSES]);

    // startState / statechart initial-state existence check.
    // pi-experiment-202g: v2 uses statechart.initial; v1 uses settings.startState / statechart.initialState.
    // Only enforced when there are defined states (avoids false positives in
    // test configs with empty states maps that only care about other features).
    const settingsStartState = config.settings.startState;
    const scInitialState = config.version === 2 ? sc.initial : sc.initialState;
    const startState = settingsStartState || scInitialState;
    if (startState && stateIds.size > 0 && !stateIds.has(startState) && !terminalStates.has(startState)) {
      throw new Error(
        `Configured startState "${startState}" does not exist in states. ` +
        `Known states: ${[...stateIds].join(', ')}`
      );
    }

    // ── AC1 (1elr.2): startState / statechart initial-state must agree ─────────
    // If both are present they must name the same state.  Disagreement means
    // FlowManager.initialState (reads settings.startState) and any loader that
    // reads sc.initialState/sc.initial would pick different starting states — runtime split.
    if (
      settingsStartState && scInitialState &&
      settingsStartState !== scInitialState
    ) {
      const scField = config.version === 2 ? 'statechart.initial' : 'statechart.initialState';
      throw new Error(
        `settings.startState "${settingsStartState}" and ${scField} "${scInitialState}" disagree. ` +
        `They must name the same state so the runtime resolves a single canonical start state. ` +
        `Either remove ${scField} (settings.startState is authoritative) or set them to the same value.`
      );
    }

    // ── AC4 (1elr.2): duplicate outcomes across sets (case-insensitive) ───────
    // Outcomes must be declared exactly once.  A duplicate means the same
    // outcome key is in two lists (e.g. both advanceOutcomes and failedOutcomes)
    // — the classification would be non-deterministic depending on evaluation
    // order.
    // At this point we know hasExplicitVocab is true (checked above).
    {
      const seenUpper = new Map<string, string>(); // normalized → first list name
      const checkList = (outcomes: string[] | undefined, listName: string): void => {
        for (const o of outcomes ?? []) {
          const upper = o.toUpperCase();
          const existing = seenUpper.get(upper);
          if (existing) {
            throw new Error(
              `Duplicate outcome "${o}" (case-insensitive) appears in both "${existing}" and "${listName}". ` +
              `Each outcome must be declared exactly once across advanceOutcomes/failedOutcomes/blockedOutcomes/customOutcomes. ` +
              `Remove the duplicate from one of the lists.`
            );
          }
          seenUpper.set(upper, listName);
        }
      };
      checkList(sc.advanceOutcomes, 'advanceOutcomes');
      checkList(sc.failedOutcomes, 'failedOutcomes');
      checkList(sc.blockedOutcomes, 'blockedOutcomes');
      checkList(sc.customOutcomes, 'customOutcomes');
    }

    // Declared outcome vocabulary (always present — explicit vocab is required).
    const declaredOutcomes: Set<string> = new Set([
      ...(sc.advanceOutcomes ?? ['SUCCESS']),
      ...(sc.failedOutcomes ?? ['FAILURE']),
      ...(sc.blockedOutcomes ?? ['BLOCKED']),
      ...(sc.customOutcomes ?? []),
      // Always include harness-internal restart events
      EventName.HARNESS_RESTART,
      EventName.CONTEXT_RESTART
    ].map(o => o.toUpperCase()));

    // ── AC2 (1elr.2): every runnable state has ≥1 action; action ids unique ──
    // A state with no actions is inert — worker startup throws because there is
    // nothing to execute.  Duplicate action ids cause non-deterministic action
    // tracking and event correlation.
    for (const [stateId, state] of Object.entries(config.states || {})) {
      // Skip terminal states that are declared in the statechart but are not
      // real runnable states (they have no actions by design).
      if (terminalStates.has(stateId)) continue;

      const actions = state.actions ?? [];
      if (actions.length === 0) {
        throw new Error(
          `State "${stateId}" has no actions. ` +
          `Every runnable state must declare at least one action for worker execution. ` +
          `Add an action (e.g. type: prompt) to the state, or move it to terminalStates if it should be a terminal.`
        );
      }
      const actionIds = new Set<string>();
      for (const action of actions) {
        if (!action.id) continue;
        const lowerId = action.id.toLowerCase();
        if (actionIds.has(lowerId)) {
          throw new Error(
            `State "${stateId}" has duplicate action id "${action.id}". ` +
            `Action ids must be unique within a state (case-insensitive comparison). ` +
            `Rename one of the duplicate actions to a distinct id.`
          );
        }
        actionIds.add(lowerId);
      }
    }

    // ── AC6 (1elr.2): validationGates selectors must reference valid states ──
    // and each gate must use exactly one selector mode (states / beforeStates /
    // afterStates).  Mixed modes are ambiguous; unknown state references are
    // almost certainly a typo or a stale reference after a rename.
    for (const gate of config.validationGates ?? []) {
      const hasStates      = Array.isArray(gate.states)       && gate.states.length > 0;
      const hasBeforeStates = Array.isArray(gate.beforeStates) && gate.beforeStates.length > 0;
      const hasAfterStates  = Array.isArray(gate.afterStates)  && gate.afterStates.length > 0;
      const selectorCount  = (hasStates ? 1 : 0) + (hasBeforeStates ? 1 : 0) + (hasAfterStates ? 1 : 0);

      if (selectorCount > 1) {
        throw new Error(
          `validationGate "${gate.id}" uses multiple selector modes (states/beforeStates/afterStates). ` +
          `Each gate must use exactly one selector mode. ` +
          `Remove the extra selector(s) to disambiguate the gate scope.`
        );
      }

      const allSelectorStates = [
        ...(hasStates       ? gate.states!       : []),
        ...(hasBeforeStates ? gate.beforeStates!  : []),
        ...(hasAfterStates  ? gate.afterStates!   : [])
      ];
      for (const selectorStateId of allSelectorStates) {
        if (!stateIds.has(selectorStateId)) {
          throw new Error(
            `validationGate "${gate.id}" references unknown state "${selectorStateId}". ` +
            `Gate selector states must be defined in the statechart. ` +
            `Known states: ${[...stateIds].join(', ')}. ` +
            `Remove or correct the state reference.`
          );
        }
      }
    }

    // ── Transition target + vocabulary validation ─────────────────────────────
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
          throw new Error(
            `State "${stateId}" uses transition outcome "${outcomeKey}" which is not in the declared ` +
            `statechart vocabulary (advanceOutcomes/failedOutcomes/blockedOutcomes/customOutcomes). ` +
            `Declared outcomes: ${[...declaredOutcomes].join(', ')}. ` +
            `Add "${outcomeKey}" to customOutcomes (or the appropriate list) to permit it.`
          );
        }
      }
    }
  }

  /**
   * s3wp.2: Expand tool profiles and defaults.
   *
   * Merge precedence (lowest → highest):
   *   settings.toolDefaults → settings.toolProfiles[tool.profile] → per-tool fields
   *
   * Only command tools participate (mcp/extension tools are left untouched).
   * The `profile` field is retained on the config object after expansion (it is
   * informational and does not affect runtime behaviour once merged).
   *
   * Merge rules:
   * - Plain scalar fields (cwd, allowCwdOverride, timeoutMs, …): per-tool wins if
   *   explicitly set (i.e. !== undefined); otherwise profile wins; otherwise default wins.
   * - `env` record: shallowly merged (default → profile → per-tool; per-tool keys win).
   * - `failureLimit` object: shallowly merged field-by-field (same precedence).
   * - `argumentPathScope` object: shallowly merged field-by-field (same precedence).
   * - `successExitCodes` array: per-tool wins if explicitly set; otherwise profile wins;
   *   otherwise default wins (no array concatenation — replacement semantics).
   *
   * If a tool references a profile name that does not exist, a warning is logged and
   * the tool is left as-is (load does not fail).
   */
  private expandToolProfiles(config: HarnessConfig): void {
    const toolDefaults = config.settings.toolDefaults;
    const toolProfiles = config.settings.toolProfiles;

    const PROFILE_SCALAR_KEYS: Array<keyof ToolProfileConfig> = [
      'cwd', 'allowCwdOverride', 'timeoutMs', 'wrapperTimeoutMs',
      'argsMode', 'allowArgs', 'acceptMaxBuffer'
    ];

    for (const tool of config.tools || []) {
      if (tool.type !== 'command') continue;
      const cmdTool = tool as ProjectCommandToolConfig;

      // Resolve profile (if any)
      let profile: ToolProfileConfig | undefined;
      if (cmdTool.profile) {
        if (toolProfiles && cmdTool.profile in toolProfiles) {
          profile = toolProfiles[cmdTool.profile];
        } else {
          const available = toolProfiles ? Object.keys(toolProfiles).sort().join(', ') || '(none)' : '(none)';
          throw new Error(
            `Tool "${cmdTool.name}" references profile "${cmdTool.profile}" which is not defined in settings.toolProfiles. ` +
            `Available profiles: ${available}. ` +
            `Define the profile in settings.toolProfiles or remove the profile reference from the tool.`
          );
        }
      }

      // If no defaults or profile, and no profile reference, skip to avoid unnecessary iteration
      if (!toolDefaults && !profile) continue;

      // Merge scalar fields: default → profile → per-tool (per-tool wins when defined)
      for (const key of PROFILE_SCALAR_KEYS) {
        if (cmdTool[key] === undefined) {
          if (profile?.[key] !== undefined) {
            (cmdTool as unknown as Record<string, unknown>)[key] = profile[key];
          } else if (toolDefaults?.[key] !== undefined) {
            (cmdTool as unknown as Record<string, unknown>)[key] = toolDefaults[key];
          }
        }
      }

      // Merge `env` (shallow: default → profile → per-tool; per-tool keys win)
      const envDefault = toolDefaults?.env;
      const envProfile = profile?.env;
      const envTool = cmdTool.env;
      if (envDefault || envProfile || envTool) {
        cmdTool.env = { ...envDefault, ...envProfile, ...envTool };
      }

      // Merge `argumentPathScope` (shallow field-by-field)
      const apsDefault = toolDefaults?.argumentPathScope;
      const apsProfile = profile?.argumentPathScope;
      const apsTool = cmdTool.argumentPathScope;
      if (apsDefault || apsProfile || apsTool) {
        cmdTool.argumentPathScope = { ...apsDefault, ...apsProfile, ...apsTool };
      }

      // Merge `failureLimit` (shallow field-by-field)
      const flDefault = toolDefaults?.failureLimit;
      const flProfile = profile?.failureLimit;
      const flTool = cmdTool.failureLimit;
      if (flDefault || flProfile || flTool) {
        cmdTool.failureLimit = { ...flDefault, ...flProfile, ...flTool };
      }

      // Merge `successExitCodes` (replacement — per-tool wins if set)
      if (cmdTool.successExitCodes === undefined) {
        if (profile?.successExitCodes !== undefined) {
          cmdTool.successExitCodes = profile.successExitCodes;
        } else if (toolDefaults?.successExitCodes !== undefined) {
          cmdTool.successExitCodes = toolDefaults.successExitCodes;
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

    for (const [stateId, state] of Object.entries(config.states || {})) {
      state.id = state.id || stateId;
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
