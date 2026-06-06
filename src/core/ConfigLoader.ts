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

  private validate(config: unknown): asserts config is HarnessConfig {
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
  private validateDeprecatedRequiredTools(config: HarnessConfig): void {
    // Build a set of tool names that are both deprecated AND hidden.
    // Only the combination of deprecated+hidden triggers the hard validation failure:
    // - deprecated-only: tool still appears in guidance (just prints a REJECTED on invocation).
    // - hidden-only: tool is invisible to the model but can still be used programmatically.
    // - deprecated+hidden: tool is gone from guidance AND will reject on invocation;
    //   a requiredTools reference here is almost certainly a stale config bug.
    const deprecatedHiddenTools = new Set<string>();
    for (const tool of config.tools || []) {
      const t = tool as { deprecated?: boolean; hidden?: boolean };
      if (t.deprecated && t.hidden) {
        deprecatedHiddenTools.add(tool.name);
      }
    }
    if (deprecatedHiddenTools.size === 0) return;

    const checkRequiredTools = (requiredTools: import('./domain/StateModels.js').RequiredTool[] | undefined, location: string): void => {
      for (const rt of requiredTools || []) {
        if (typeof rt === 'string') {
          if (deprecatedHiddenTools.has(rt)) {
            throw new Error(
              `${location} references requiredTool "${rt}" which is deprecated and hidden. ` +
              `Either remove the reference, use a replacement tool, or add allowDeprecated:true to the object form to explicitly opt in.`
            );
          }
        } else {
          if (deprecatedHiddenTools.has(rt.name) && !rt.allowDeprecated) {
            throw new Error(
              `${location} references requiredTool "${rt.name}" which is deprecated and hidden. ` +
              `Either remove the reference, use a replacement tool, or set allowDeprecated:true on the entry to explicitly opt in.`
            );
          }
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

  private validateSemantics(config: HarnessConfig): void {
    this.validateDeprecatedRequiredTools(config);
    this.validateObserveOnlyInRequiredTools(config);
    this.validateTraceabilityOwner(config);
    this.validateWorktreePolicy(config);

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
    const settingsStartState = config.settings.startState;
    const scInitialState = sc?.initialState;
    const startState = settingsStartState || scInitialState;
    if (startState && stateIds.size > 0 && !stateIds.has(startState) && !terminalStates.has(startState)) {
      throw new Error(
        `Configured startState "${startState}" does not exist in states. ` +
        `Known states: ${[...stateIds].join(', ')}`
      );
    }

    // ── AC1 (1elr.2): startState / statechart.initialState must agree ─────────
    // If both are present they must name the same state.  Disagreement means
    // FlowManager.initialState (reads settings.startState) and any loader that
    // reads sc.initialState would pick different starting states — runtime split.
    if (
      settingsStartState && scInitialState &&
      settingsStartState !== scInitialState
    ) {
      throw new Error(
        `settings.startState "${settingsStartState}" and statechart.initialState "${scInitialState}" disagree. ` +
        `They must name the same state so the runtime resolves a single canonical start state. ` +
        `Either remove statechart.initialState (settings.startState is authoritative) or set them to the same value.`
      );
    }

    if (!hasStatechartBlock) {
      // Legacy mode: skip strict lint rules for backward compatibility with
      // configs that predate the statechart block.
      return;
    }

    // ── AC4 (1elr.2): duplicate outcomes across sets (case-insensitive) ───────
    // Outcomes must be declared exactly once.  A duplicate means the same
    // outcome key is in two lists (e.g. both advanceOutcomes and failedOutcomes)
    // — the classification would be non-deterministic depending on evaluation
    // order.
    if (
      sc.advanceOutcomes !== undefined ||
      sc.failedOutcomes !== undefined ||
      sc.blockedOutcomes !== undefined ||
      sc.customOutcomes !== undefined
    ) {
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

    // Strict vocabulary validation only when the author explicitly declared at
    // least one outcome list.  A statechart block with ONLY terminalStates /
    // initialState is NOT strict: forcing default {SUCCESS,FAILURE,BLOCKED} on
    // such configs silently breaks legacy callers.
    const hasExplicitVocab =
      sc.advanceOutcomes !== undefined ||
      sc.failedOutcomes !== undefined ||
      sc.blockedOutcomes !== undefined ||
      sc.customOutcomes !== undefined;

    // Declared outcome vocabulary — only built when strict mode is active.
    const declaredOutcomes: Set<string> | null = hasExplicitVocab
      ? new Set([
          ...(sc.advanceOutcomes ?? ['SUCCESS']),
          ...(sc.failedOutcomes ?? ['FAILURE']),
          ...(sc.blockedOutcomes ?? ['BLOCKED']),
          ...(sc.customOutcomes ?? []),
          // Always include harness-internal restart events
          EventName.HARNESS_RESTART,
          EventName.CONTEXT_RESTART
        ].map(o => o.toUpperCase()))
      : null;

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
        if (declaredOutcomes !== null && !declaredOutcomes.has(outcomeKey.toUpperCase())) {
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
