import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import { ResolvedLLMConfig, HarnessConfig, ToolProfileConfig, TsProjectToolDefaults, ProjectCommandToolConfig, V2PromptFileProvenance, ALLOWLISTED_STATE_FIELDS, ALLOWLISTED_TOOL_FIELDS, NON_COMPRESSIBLE_STATE_FIELDS, NON_COMPRESSIBLE_TOOL_FIELDS } from './domain/StateModels.js';
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
      // pi-experiment-0dgy: normalize v2 map-form collections (tools, validationGates,
      // states.<state>.actions) to sorted arrays with canonical map-derived IDs.
      // Runs after preValidateV2Admission (which already validated grammar/conflicts)
      // and before schema validation (which expects array form).
      if (isRecord(parsed) && parsed['version'] === 2) {
        this.normalizeV2MapCollections(parsed);
      }
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

    // pi-experiment-ux5e: v2 adapter/worktree field rejection.
    // tmux workers and isolated git worktrees are MANDATORY in v2 — not configurable.
    // Reject any field that tries to configure the worker adapter, workspace adapter,
    // backlog adapter, worktree policy, or per-state worktree overrides.
    this.validateV2WorkerAdapterFields(config, settings, states);

    // AC4 (cfzu): v2 configs must not declare old v1 outcome/custom-event fields.
    // These are replaced by the category-first event vocabulary (events.advance/failure/blocked/neutral).
    const V2_BANNED_OUTCOME_FIELDS: Array<{ path: string; hint: string }> = [];

    if ('advanceOutcomes' in statechart) {
      V2_BANNED_OUTCOME_FIELDS.push({
        path: 'statechart.advanceOutcomes',
        hint: 'Declare advance-category events under events.advance in v2. ' +
          'Example: events: { advance: ["SUCCESS"] }'
      });
    }
    if ('failedOutcomes' in statechart) {
      V2_BANNED_OUTCOME_FIELDS.push({
        path: 'statechart.failedOutcomes',
        hint: 'Declare failure-category events under events.failure in v2. ' +
          'Example: events: { failure: ["FAILURE"] }'
      });
    }
    if ('blockedOutcomes' in statechart) {
      V2_BANNED_OUTCOME_FIELDS.push({
        path: 'statechart.blockedOutcomes',
        hint: 'Declare blocked-category events under events.blocked in v2. ' +
          'Example: events: { blocked: ["BLOCKED"] }'
      });
    }
    if ('customOutcomes' in statechart) {
      V2_BANNED_OUTCOME_FIELDS.push({
        path: 'statechart.customOutcomes',
        hint: 'Declare custom outcomes as additional event names in the appropriate category under events in v2. ' +
          'Example: events: { neutral: ["MY_CUSTOM_EVENT"] }'
      });
    }
    if ('customEvents' in statechart) {
      V2_BANNED_OUTCOME_FIELDS.push({
        path: 'statechart.customEvents',
        hint: 'Declare custom events under the appropriate category in events in v2. ' +
          'Example: events: { neutral: ["MY_EVENT"] }'
      });
    }

    if (V2_BANNED_OUTCOME_FIELDS.length > 0) {
      const details = V2_BANNED_OUTCOME_FIELDS.map(f => `  ${f.path}: ${f.hint}`).join('\n');
      throw new Error(
        `v2 harness config (version: 2) contains ${V2_BANNED_OUTCOME_FIELDS.length} removed v1 outcome/event field(s):\n` +
        details + '\n' +
        `In v2, the event vocabulary is declared under the top-level \`events\` key with categories ` +
        `(advance/failure/blocked/neutral). Remove these v1 fields and migrate to the v2 events structure.`
      );
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

    // AC1/AC2 (cfzu): validate the v2 event vocabulary if declared.
    const eventsRaw = isRecord(config['events']) ? config['events'] as Record<string, unknown> : undefined;
    if (eventsRaw !== undefined) {
      this.validateV2EventVocabulary(eventsRaw);
    }

    // AC3 (cfzu): startup lint — state transition keys must be exact declared event names.
    // Only enforced when events are declared (a v2 config may validly have no events declared yet).
    if (eventsRaw !== undefined) {
      const declaredV2Vocab = this.buildV2EventVocabulary(eventsRaw);
      this.validateV2TransitionKeys(config, declaredV2Vocab);
    }

    // AC5: terminal sink not runnable.
    // A name in statechart.terminal must not also be a runnable state (a state with actions).
    // Handles both array-form and map-form actions (map-form check: non-empty object).
    const terminalV2 = Array.isArray(statechart['terminal']) ? statechart['terminal'] as string[] : [];
    for (const sinkName of terminalV2) {
      const stateRaw = states[sinkName];
      if (!isRecord(stateRaw)) continue;
      const stateActions = stateRaw['actions'];
      const hasActions =
        (Array.isArray(stateActions) && (stateActions as unknown[]).length > 0) ||
        (isRecord(stateActions) && Object.keys(stateActions as Record<string, unknown>).length > 0);
      if (hasActions) {
        throw new Error(
          `v2 statechart.terminal lists "${sinkName}" as a terminal sink, but "${sinkName}" is also declared as a runnable state with actions. ` +
          `Terminal sinks must not be runnable states. ` +
          `Either remove "${sinkName}" from statechart.terminal, or remove its actions block to make it a true sink state.`
        );
      }
    }

    // pi-experiment-w2tz: v2 defaults/profiles expansion.
    // Runs BEFORE map-form collection validation so that allowlist/non-compressible
    // rejection fires before key-grammar checks. Expands defaults.state, defaults.tool,
    // profiles.states, and profiles.tools onto each state/tool with precedence
    // defaults < profile < local. Version-gated (only when version === 2).
    this.expandV2DefaultsAndProfiles(config);

    // pi-experiment-0dgy: v2 map-form collection validation.
    // Validates tools, validationGates, and states.<state>.actions:
    //   1. Array-form → rejected with migration guidance (AC2).
    //   2. Map key grammar → each key must match the v2 identifier pattern (AC1).
    //   3. Inner-identity conflict → entries that also declare a conflicting id/name → rejected (AC3).
    //   4. Case-insensitive duplicate keys → rejected (AC5 duplicate detection).
    // State keys (states map) are also validated for key grammar.
    this.validateV2MapCollections(config, states);

    // pi-experiment-0njv: v2 LLM action promptFile admission.
    // Runs BEFORE any model/provider/Pi request (AC2: before-model-spend).
    // Validates that every v2 LLM action (any action with an `llm` sub-object):
    //   - Has llm.promptFile (non-empty) — no inline llm.prompt or top-level prompt.
    //   - promptFile is a safe, project-relative, existing, readable FILE (not absolute,
    //     no `..` escape, no symlink escape, no directory, no unreadable/nonexistent).
    // Runs on the RAW map-form states (before normalizeV2MapCollections converts actions
    // to arrays), so both map-form and array-form action shapes are handled.
    this.validateV2LlmActions(states);

    // pi-experiment-hutg: v2 action emits mapping validation.
    // Runs after event vocabulary is built (requires declaredV2Vocab for event-ref checks).
    // Uses the already-built vocab (or empty map if no events declared yet).
    const emitsVocab = eventsRaw !== undefined
      ? this.buildV2EventVocabulary(eventsRaw)
      : new Map<string, string>();
    this.validateV2ActionEmits(states, emitsVocab);

    // pi-experiment-ne2w: v2 gate aggregation ambiguity validation.
    // Runs after event vocabulary is built. Checks that every v2 gate with allOf/anyOf
    // operator has non-ambiguous precedence lists (AC3: startup fails if ambiguous).
    const gatesRawForV2 = config['validationGates'];
    if (gatesRawForV2 !== undefined && !Array.isArray(gatesRawForV2) && isRecord(gatesRawForV2)) {
      this.validateV2GateAmbiguity(gatesRawForV2 as Record<string, unknown>, emitsVocab);
    }
  }

  /**
   * pi-experiment-ux5e: Reject adapter/worktree fields in v2 configs.
   *
   * In v2, tmux workers and isolated git worktrees are MANDATORY framework behavior.
   * They are NOT configurable. Any field that tries to configure:
   *   - runtime.adapters.worker / workspace / backlog — rejected
   *   - runtime.worktreePolicy — rejected
   *   - states.*.provisionWorktree — rejected (per-state override is not configurable)
   *   - settings.pi.workerArgs — rejected (provider-specific worker process alternative)
   *   - settings.pi.workerExtensions — rejected (provider-specific worker process alternative)
   *
   * Admitted (AC1): runtime.teammates — numeric concurrency setting; no adapter knobs.
   *
   * Each rejection names the field + states that tmux workers and isolated git worktrees
   * are mandatory/non-configurable in v2 (AC3).
   *
   * @param config   Raw parsed document (version: 2 already verified).
   * @param settings Extracted settings record (already coerced by caller).
   * @param states   Extracted states record (already coerced by caller).
   */
  private validateV2WorkerAdapterFields(
    config: Record<string, unknown>,
    settings: Record<string, unknown>,
    states: Record<string, unknown>
  ): void {
    const forbidden: Array<{ path: string; hint: string }> = [];

    // ── runtime block ────────────────────────────────────────────────────────
    // runtime.adapters.* and runtime.worktreePolicy are forbidden.
    // runtime.teammates is the ONLY admitted runtime key.
    const runtimeRaw = config['runtime'];
    if (isRecord(runtimeRaw)) {
      const runtime = runtimeRaw as Record<string, unknown>;

      // runtime.adapters — reject any adapter configuration.
      const adaptersRaw = runtime['adapters'];
      if (adaptersRaw !== undefined && adaptersRaw !== null) {
        if (isRecord(adaptersRaw)) {
          const adapters = adaptersRaw as Record<string, unknown>;
          if ('worker' in adapters) {
            forbidden.push({
              path: 'runtime.adapters.worker',
              hint: 'In v2, tmux is the mandatory worker adapter. Worker adapter selection is not configurable. Remove runtime.adapters.worker.'
            });
          }
          if ('workspace' in adapters) {
            forbidden.push({
              path: 'runtime.adapters.workspace',
              hint: 'In v2, isolated git worktrees are the mandatory workspace. Workspace adapter selection is not configurable. Remove runtime.adapters.workspace.'
            });
          }
          if ('backlog' in adapters) {
            forbidden.push({
              path: 'runtime.adapters.backlog',
              hint: 'In v2, the backlog adapter is not configurable. Remove runtime.adapters.backlog.'
            });
          }
          // Reject any other adapter sub-keys too.
          for (const key of Object.keys(adapters)) {
            if (key !== 'worker' && key !== 'workspace' && key !== 'backlog') {
              forbidden.push({
                path: `runtime.adapters.${key}`,
                hint: `In v2, adapter selection is not configurable. tmux workers and isolated git worktrees are mandatory. Remove runtime.adapters.${key}.`
              });
            }
          }
        } else {
          // adapters present but not a record — still forbidden
          forbidden.push({
            path: 'runtime.adapters',
            hint: 'In v2, adapter selection is not configurable. tmux workers and isolated git worktrees are mandatory. Remove runtime.adapters.'
          });
        }
      }

      // runtime.worktreePolicy — forbidden (worktree policy is not configurable in v2).
      if ('worktreePolicy' in runtime) {
        forbidden.push({
          path: 'runtime.worktreePolicy',
          hint: 'In v2, isolated git worktrees are mandatory for every worker — worktree policy is not configurable. Remove runtime.worktreePolicy.'
        });
      }
    }

    // ── states.*.provisionWorktree — per-state worktree override forbidden in v2 ──
    for (const [stateId, stateRaw] of Object.entries(states)) {
      if (!isRecord(stateRaw)) continue;
      if ('provisionWorktree' in (stateRaw as Record<string, unknown>)) {
        forbidden.push({
          path: `states.${stateId}.provisionWorktree`,
          hint: `In v2, isolated git worktrees are mandatory for every worker — per-state worktree overrides are not configurable. Remove states.${stateId}.provisionWorktree.`
        });
      }
    }

    // ── settings.pi.workerArgs / workerExtensions ────────────────────────────
    // These are provider-specific worker process alternatives — not configurable in v2.
    const piRaw = settings['pi'];
    if (isRecord(piRaw)) {
      const pi = piRaw as Record<string, unknown>;
      if ('workerArgs' in pi) {
        forbidden.push({
          path: 'settings.pi.workerArgs',
          hint: 'In v2, tmux workers are mandatory — provider-specific worker process arguments are not configurable. Remove settings.pi.workerArgs.'
        });
      }
      if ('workerExtensions' in pi) {
        forbidden.push({
          path: 'settings.pi.workerExtensions',
          hint: 'In v2, tmux workers are mandatory — provider-specific worker process extensions are not configurable. Remove settings.pi.workerExtensions.'
        });
      }
    }

    if (forbidden.length > 0) {
      const details = forbidden.map(f => `  ${f.path}: ${f.hint}`).join('\n');
      throw new Error(
        `v2 harness config (version: 2) declares ${forbidden.length} non-configurable adapter/worktree field(s):\n` +
        details + '\n' +
        `In v2, tmux workers and isolated git worktrees are mandatory framework behavior — they are not configurable. ` +
        `Remove these fields from your harness.yaml to comply with the v2 schema.`
      );
    }
  }

  /**
   * pi-experiment-0dgy: v2 identifier grammar for map keys.
   *
   * Pattern: one letter (upper or lower), followed by zero or more letters,
   * digits, underscores, dots, or hyphens. No spaces, no leading digit,
   * no leading special character.
   *
   * Valid examples:
   *   write-plan, verify-plan, plan_contract, run_impl, a1, tool.v2
   *   Implement, Planning, PlanContract   (PascalCase; existing v2 state names)
   * Invalid examples:
   *   1bad          (starts with digit)
   *   my name       (contains space)
   *   -leading      (starts with hyphen)
   *
   * Documented as the canonical v2 identifier grammar for tools, gates,
   * state IDs, and action IDs.
   */
  private static readonly V2_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

  /**
   * pi-experiment-0dgy AC1–AC5: Validate v2 map-form collections.
   *
   * Checks (all startup-fatal):
   *   AC1: Map keys must match the v2 identifier grammar.
   *   AC2: Array-form tools/gates/actions in v2 → rejected with migration guidance.
   *   AC3: Inner identity fields (id/name) that conflict with the map key → rejected.
   *   AC5: Case-insensitive duplicate keys → rejected.
   *
   * Collection-specific key grammar and identity field:
   *   tools           → identity field: name  → migration path: tools.<name>
   *   validationGates → identity field: id    → migration path: gates.<id>
   *   states (keys)   → no identity field      → just grammar validation
   *   state.actions   → identity field: id    → migration path: actions.<id>
   */
  private validateV2MapCollections(config: Record<string, unknown>, states: Record<string, unknown>): void {
    // ── tools ────────────────────────────────────────────────────────────────
    const toolsRaw = config['tools'];
    if (toolsRaw !== undefined) {
      if (Array.isArray(toolsRaw)) {
        throw new Error(
          `v2 harness config (version: 2) declares tools as an array (old v1 form). ` +
          `In v2, tools must be a map whose keys are the canonical tool names. ` +
          `Migrate to map form: replace the array with an object keyed by tool name.\n` +
          `Migration example: tools:\n  plan_contract:\n    type: command\n    command: node\n` +
          `(old array entry with name: plan_contract becomes the key tools.plan_contract)`
        );
      }
      if (isRecord(toolsRaw)) {
        this.validateV2MapKeys(toolsRaw as Record<string, unknown>, 'tools', 'name', 'tools.<name>');
      }
    }

    // ── validationGates ──────────────────────────────────────────────────────
    const gatesRaw = config['validationGates'];
    if (gatesRaw !== undefined) {
      if (Array.isArray(gatesRaw)) {
        throw new Error(
          `v2 harness config (version: 2) declares validationGates as an array (old v1 form). ` +
          `In v2, validationGates must be a map whose keys are the canonical gate IDs. ` +
          `Migrate to map form: replace the array with an object keyed by gate ID.\n` +
          `Migration example: gates:\n  review-gate:\n    states: [Implement]\n` +
          `(old array entry with id: review-gate becomes the key gates.review-gate)`
        );
      }
      if (isRecord(gatesRaw)) {
        this.validateV2MapKeys(gatesRaw as Record<string, unknown>, 'validationGates', 'id', 'gates.<id>');
      }
    }

    // ── states key grammar ───────────────────────────────────────────────────
    // State keys are already the canonical IDs; just validate grammar.
    this.validateV2StateKeys(states);

    // ── states.<state>.actions ───────────────────────────────────────────────
    for (const [stateId, stateRaw] of Object.entries(states)) {
      if (!isRecord(stateRaw)) continue;
      const actionsRaw = stateRaw['actions'];
      if (actionsRaw === undefined) continue;
      if (Array.isArray(actionsRaw)) {
        throw new Error(
          `v2 harness config (version: 2) state "${stateId}" declares actions as an array (old v1 form). ` +
          `In v2, actions must be a map whose keys are the canonical action IDs. ` +
          `Migrate to map form: replace the array with an object keyed by action ID.\n` +
          `Migration example: actions:\n  write-plan:\n    type: prompt\n` +
          `(old array entry with id: write-plan becomes the key actions.write-plan)`
        );
      }
      if (isRecord(actionsRaw)) {
        this.validateV2MapKeys(
          actionsRaw as Record<string, unknown>,
          `states.${stateId}.actions`,
          'id',
          'actions.<id>'
        );
      }
    }
  }

  /**
   * Validate v2 state map keys for grammar only (no inner-identity field for states).
   *
   * State keys are the canonical state IDs. Key grammar violations are rejected.
   * Case-insensitive duplicate detection is applied.
   *
   * Note: existing configs may use PascalCase state names (e.g. "Implement") from v1.
   * For v2, state keys must match the v2 identifier grammar (lowercase-first).
   */
  private validateV2StateKeys(states: Record<string, unknown>): void {
    const seenLower = new Map<string, string>(); // lowercase key → original key
    for (const stateKey of Object.keys(states)) {
      // Grammar check
      if (!ConfigLoader.V2_IDENTIFIER_PATTERN.test(stateKey)) {
        throw new Error(
          `v2 harness config (version: 2) state key "${stateKey}" does not match the v2 identifier grammar. ` +
          `State keys must start with a letter and contain only letters, digits, underscores, dots, or hyphens. ` +
          `(pattern: ^[A-Za-z][A-Za-z0-9_.-]*$). Rename the state to a valid v2 identifier.`
        );
      }
      // Case-insensitive duplicate detection
      const lower = stateKey.toLowerCase();
      const prev = seenLower.get(lower);
      if (prev !== undefined) {
        throw new Error(
          `v2 harness config (version: 2) states map has case-insensitive duplicate keys: ` +
          `"${prev}" and "${stateKey}" are the same identifier after case folding. ` +
          `Each state key must be unique case-insensitively. Remove or rename one of the duplicate state keys.`
        );
      }
      seenLower.set(lower, stateKey);
    }
  }

  /**
   * Validate a single v2 map collection for key grammar, inner-identity conflicts,
   * and case-insensitive duplicate keys.
   *
   * @param mapRaw         The raw map object.
   * @param collectionPath Path for diagnostic messages (e.g. "tools", "states.Implement.actions").
   * @param identityField  The inner field name that must NOT conflict with the key ("name" or "id").
   * @param migrationPath  Migration hint path fragment (e.g. "tools.<name>", "actions.<id>").
   */
  private validateV2MapKeys(
    mapRaw: Record<string, unknown>,
    collectionPath: string,
    identityField: string,
    migrationPath: string
  ): void {
    const seenLower = new Map<string, string>(); // lowercase key → original key

    for (const [key, entry] of Object.entries(mapRaw)) {
      // AC1: Key grammar validation.
      if (!ConfigLoader.V2_IDENTIFIER_PATTERN.test(key)) {
        throw new Error(
          `v2 harness config (version: 2) ${collectionPath} map key "${key}" does not match the v2 identifier grammar. ` +
          `Map keys must start with a letter and contain only letters, digits, underscores, dots, or hyphens. ` +
          `(pattern: ^[A-Za-z][A-Za-z0-9_.-]*$). ` +
          `Rename the key to a valid v2 identifier (migration path: ${migrationPath}).`
        );
      }

      // AC5: Case-insensitive duplicate detection.
      const lower = key.toLowerCase();
      const prev = seenLower.get(lower);
      if (prev !== undefined) {
        throw new Error(
          `v2 harness config (version: 2) ${collectionPath} map has case-insensitive duplicate keys: ` +
          `"${prev}" and "${key}" are the same identifier after case folding. ` +
          `Each map key must be unique case-insensitively (migration path: ${migrationPath}). ` +
          `Remove or rename one of the duplicate keys.`
        );
      }
      seenLower.set(lower, key);

      // AC3: Inner-identity conflict detection.
      if (!isRecord(entry)) continue;
      const innerIdentity = (entry as Record<string, unknown>)[identityField];
      if (innerIdentity !== undefined && innerIdentity !== key) {
        throw new Error(
          `v2 harness config (version: 2) ${collectionPath} map entry "${key}" declares inner ` +
          `"${identityField}: ${innerIdentity}" which conflicts with the map key "${key}". ` +
          `In v2, the map key is the canonical identity — inner ${identityField} fields must not be declared ` +
          `(or must match the key exactly). Remove the inner ${identityField} field from the entry ` +
          `(migration path: ${migrationPath}).`
        );
      }
    }
  }

  /**
   * pi-experiment-0njv: Validate v2 LLM action promptFile declarations.
   *
   * Runs in preValidateV2Admission on the raw map-form states (BEFORE map normalization
   * converts actions to arrays), ensuring rejection happens BEFORE any provider/model
   * request is issued (AC2: before-model-spend).
   *
   * A "v2 LLM action" is any action entry that declares an `llm` sub-object.
   *
   * Rules (all startup-fatal):
   *   AC1: llm.promptFile must be present and non-empty; llm.prompt (inline body) is FORBIDDEN.
   *   AC1: The legacy top-level `prompt` field on a v2 LLM action is FORBIDDEN.
   *   AC2: promptFile must not be absolute.
   *   AC2: promptFile must not escape the project root via `..` (normalized path check).
   *   AC2: promptFile must not escape the project root via symlinks (realpath containment).
   *   AC2: promptFile must not name a directory.
   *   AC2: promptFile must exist and be readable.
   *
   * @param states Raw map-form states object from the parsed YAML (pre-normalization).
   */
  private validateV2LlmActions(states: Record<string, unknown>): void {
    for (const [stateId, stateRaw] of Object.entries(states)) {
      if (!isRecord(stateRaw)) continue;
      const actionsRaw = (stateRaw as Record<string, unknown>)['actions'];
      if (!actionsRaw) continue;

      // Actions may be map-form (record) or array-form (array) at this point.
      // Map-form: iterate over entries; array-form: iterate over elements.
      const actionEntries: Array<[string, unknown]> = isRecord(actionsRaw)
        ? Object.entries(actionsRaw as Record<string, unknown>)
        : Array.isArray(actionsRaw)
          ? (actionsRaw as unknown[]).map((a, i) => {
              const id = isRecord(a) ? ((a as Record<string, unknown>)['id'] as string ?? `action_${i}`) : `action_${i}`;
              return [id, a] as [string, unknown];
            })
          : [];

      for (const [actionId, actionRaw] of actionEntries) {
        if (!isRecord(actionRaw)) continue;
        const action = actionRaw as Record<string, unknown>;
        const llmRaw = action['llm'];

        // Only process actions that declare an `llm` sub-object.
        if (llmRaw === undefined || llmRaw === null) continue;

        const location = `state "${stateId}" action "${actionId}"`;

        // AC1: llm must be a record.
        if (!isRecord(llmRaw)) {
          throw new Error(
            `v2 config: ${location} declares llm as a non-object value. ` +
            `The llm field must be an object with promptFile: "<project-relative-path>". ` +
            `Example: llm:\n  promptFile: .pi/prompts/implement.md`
          );
        }

        const llm = llmRaw as Record<string, unknown>;

        // AC1: inline llm.prompt is forbidden.
        if ('prompt' in llm) {
          throw new Error(
            `v2 config: ${location} declares llm.prompt (inline body) which is forbidden. ` +
            `Inline prompt bodies are not allowed in v2 LLM actions. ` +
            `Replace llm.prompt with llm.promptFile pointing to a project-relative prompt file. ` +
            `Example: llm:\n  promptFile: .pi/prompts/implement.md`
          );
        }

        // AC1: legacy top-level prompt field on a v2 LLM action is forbidden.
        if ('prompt' in action) {
          throw new Error(
            `v2 config: ${location} declares a top-level prompt field on a v2 LLM action. ` +
            `Inline prompt bodies are forbidden on v2 LLM actions (actions with an llm block). ` +
            `Remove the prompt field and use llm.promptFile instead. ` +
            `Example: llm:\n  promptFile: .pi/prompts/implement.md`
          );
        }

        // AC1: llm.promptFile must be present and non-empty.
        const promptFile = llm['promptFile'];
        if (promptFile === undefined || promptFile === null || promptFile === '') {
          throw new Error(
            `v2 config: ${location} declares an llm block without promptFile. ` +
            `Every v2 LLM action must declare llm.promptFile as a non-empty project-relative path. ` +
            `Example: llm:\n  promptFile: .pi/prompts/implement.md`
          );
        }
        if (typeof promptFile !== 'string' || !promptFile.trim()) {
          throw new Error(
            `v2 config: ${location} declares llm.promptFile as a non-string or blank value. ` +
            `llm.promptFile must be a non-empty string naming a project-relative file path. ` +
            `Example: llm:\n  promptFile: .pi/prompts/implement.md`
          );
        }

        // AC2: path must not be absolute.
        if (path.isAbsolute(promptFile)) {
          throw new Error(
            `v2 config: ${location} declares llm.promptFile: "${promptFile}" which is an absolute path. ` +
            `promptFile must be a project-relative path (no leading /). ` +
            `Example: llm:\n  promptFile: .pi/prompts/implement.md`
          );
        }

        // AC2: normalize and check for `..` escape (the resolved path must be within projectRoot).
        // Also check symlink escape via realpath.
        const resolved = path.resolve(this.projectRoot, promptFile);

        // Normalize projectRoot itself (resolve symlinks for the root too, for containment check).
        let realRoot: string;
        try {
          realRoot = fs.realpathSync(this.projectRoot);
        } catch {
          realRoot = path.resolve(this.projectRoot);
        }

        // Check `..` escape: the resolved path must start with the realRoot prefix.
        const normalizedResolved = path.resolve(resolved);
        const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
        if (normalizedResolved !== realRoot && !normalizedResolved.startsWith(rootPrefix)) {
          throw new Error(
            `v2 config: ${location} declares llm.promptFile: "${promptFile}" which escapes ` +
            `the project root via ".." traversal. ` +
            `promptFile must resolve to a path within the project root. ` +
            `Project root: ${realRoot}. Resolved path: ${normalizedResolved}.`
          );
        }

        // AC2: path must exist (rejects nonexistent + measures lstat before realpath).
        if (!fs.existsSync(resolved)) {
          throw new Error(
            `v2 config: ${location} declares llm.promptFile: "${promptFile}" which does not exist. ` +
            `The file must exist and be readable at config load time. ` +
            `Create the prompt file at: ${resolved}`
          );
        }

        // AC2: path must not be a directory.
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          throw new Error(
            `v2 config: ${location} declares llm.promptFile: "${promptFile}" which is a directory, not a file. ` +
            `promptFile must name a readable file, not a directory.`
          );
        }

        // AC2: symlink escape — resolve all symlinks and verify the real path is within projectRoot.
        let realPromptFile: string;
        try {
          realPromptFile = fs.realpathSync(resolved);
        } catch {
          throw new Error(
            `v2 config: ${location} declares llm.promptFile: "${promptFile}" — ` +
            `could not resolve real path (broken symlink or permission error). ` +
            `Ensure the file exists and is accessible.`
          );
        }
        if (realPromptFile !== realRoot && !realPromptFile.startsWith(rootPrefix)) {
          throw new Error(
            `v2 config: ${location} declares llm.promptFile: "${promptFile}" — ` +
            `the file resolves via symlink to "${realPromptFile}" which is outside the project root. ` +
            `promptFile must resolve within the project root (no symlink escape). ` +
            `Project root: ${realRoot}.`
          );
        }

        // AC2: file must be readable.
        try {
          fs.accessSync(resolved, fs.constants.R_OK);
        } catch {
          throw new Error(
            `v2 config: ${location} declares llm.promptFile: "${promptFile}" which is not readable. ` +
            `Ensure the file has read permissions.`
          );
        }
      }
    }
  }

  /**
   * pi-experiment-hutg AC1–AC4: Validate v2 action emits mappings.
   *
   * Runs in preValidateV2Admission on the raw map-form states (BEFORE map normalization
   * converts actions to arrays). Three startup-fatal checks:
   *
   *   AC3 (LLM-emitter rejection): An action that declares both `llm` and `emits` → REJECTED.
   *     LLM actions cannot choose workflow routes. emits is only valid on tool/verifier actions.
   *
   *   AC2 (undeclared event rejection): An emits mapping whose pass/fail/blocked/preconditionFailed
   *     references an event NOT in the declared v2 vocabulary → REJECTED. If the events block
   *     is not yet declared, any emits reference is rejected (no vocab means no valid refs).
   *     Exception: if vocab is empty (no events block declared at all), we skip event-ref checks
   *     because the config may be in a partial state during development — but if emits IS declared,
   *     we require the vocab to also be declared (circular dependency: hutg requires cfzu events).
   *
   *   AC4 (precondition requirement): An emits action that also declares `requiresArtifact` (or
   *     equivalent) without a preconditionFailed mapping → REJECTED. We use `requiredTools` as
   *     the artifact-dependency signal: an action with emits + non-empty requiredTools must also
   *     declare emits.preconditionFailed, or startup rejects it.
   *
   * @param states Raw map-form states object from the parsed YAML (pre-normalization).
   * @param vocab  Pre-built v2 event vocabulary (normalized UPPER_SNAKE → category).
   *               Empty map when no events block declared.
   */
  private validateV2ActionEmits(
    states: Record<string, unknown>,
    vocab: Map<string, string>
  ): void {
    for (const [stateId, stateRaw] of Object.entries(states)) {
      if (!isRecord(stateRaw)) continue;
      const actionsRaw = (stateRaw as Record<string, unknown>)['actions'];
      if (!actionsRaw) continue;

      // Actions may be map-form (record) or array-form (array) at this point.
      const actionEntries: Array<[string, unknown]> = isRecord(actionsRaw)
        ? Object.entries(actionsRaw as Record<string, unknown>)
        : Array.isArray(actionsRaw)
          ? (actionsRaw as unknown[]).map((a, i) => {
              const id = isRecord(a) ? ((a as Record<string, unknown>)['id'] as string ?? `action_${i}`) : `action_${i}`;
              return [id, a] as [string, unknown];
            })
          : [];

      for (const [actionId, actionRaw] of actionEntries) {
        if (!isRecord(actionRaw)) continue;
        const action = actionRaw as Record<string, unknown>;
        const emitsRaw = action['emits'];

        // Only validate actions that declare an `emits` block.
        if (emitsRaw === undefined || emitsRaw === null) continue;

        const location = `state "${stateId}" action "${actionId}"`;

        // emits must be a record.
        if (!isRecord(emitsRaw)) {
          throw new Error(
            `v2 config: ${location} declares emits as a non-object value. ` +
            `The emits field must be an object with pass and fail event names. ` +
            `Example: emits:\n  pass: PLAN_ACCEPTED\n  fail: PLAN_REJECTED`
          );
        }

        const emits = emitsRaw as Record<string, unknown>;

        // AC3: LLM actions cannot declare emits.
        const llmRaw = action['llm'];
        if (llmRaw !== undefined && llmRaw !== null) {
          throw new Error(
            `v2 config: ${location} declares both llm and emits. ` +
            `LLM actions cannot choose workflow routes — the emits mapping is only valid ` +
            `on tool or verifier actions. ` +
            `Remove emits from the LLM action, or convert it to a tool/verifier action.`
          );
        }

        // emits.pass and emits.fail are required.
        const passEvent = emits['pass'];
        const failEvent = emits['fail'];
        if (typeof passEvent !== 'string' || !passEvent.trim()) {
          throw new Error(
            `v2 config: ${location} declares emits without a non-empty pass event name. ` +
            `emits.pass is required and must reference a declared v2 event. ` +
            `Example: emits:\n  pass: PLAN_ACCEPTED\n  fail: PLAN_REJECTED`
          );
        }
        if (typeof failEvent !== 'string' || !failEvent.trim()) {
          throw new Error(
            `v2 config: ${location} declares emits without a non-empty fail event name. ` +
            `emits.fail is required and must reference a declared v2 event. ` +
            `Example: emits:\n  pass: PLAN_ACCEPTED\n  fail: PLAN_REJECTED`
          );
        }

        // AC2: Event-ref validation — all event names must be in the declared v2 vocabulary.
        // If vocab is non-empty (events block declared), check each ref.
        // If vocab is EMPTY and emits is declared, we still check: if an events block
        // is expected (emits requires one), the vocab should not be empty — but rather
        // than assuming intent, only reject when vocab has entries and the ref is missing.
        // Strict: vocab non-empty → all refs must be in it.
        if (vocab.size > 0) {
          const eventRefs: Array<[string, string]> = [
            ['pass', passEvent],
            ['fail', failEvent],
          ];
          const blockedEvent = emits['blocked'];
          if (typeof blockedEvent === 'string' && blockedEvent.trim()) {
            eventRefs.push(['blocked', blockedEvent]);
          }
          const preconditionEvent = emits['preconditionFailed'];
          if (typeof preconditionEvent === 'string' && preconditionEvent.trim()) {
            eventRefs.push(['preconditionFailed', preconditionEvent]);
          }

          for (const [verdictKey, eventName] of eventRefs) {
            const normalized = eventName.toUpperCase();
            if (!vocab.has(normalized)) {
              const declared = [...vocab.keys()].sort().join(', ') || '(none)';
              throw new Error(
                `v2 config: ${location} declares emits.${verdictKey}: "${eventName}" which is not ` +
                `in the declared v2 event vocabulary (events.advance/failure/blocked/neutral). ` +
                `Declared events: ${declared}. ` +
                `Add "${eventName}" to the appropriate category in the events block, or correct the name.`
              );
            }
          }
        }

        // AC4: Precondition requirement — if the action declares requiredTools (artifact deps),
        // it must also declare emits.preconditionFailed so the harness can emit a route event
        // when the artifact is missing (before the tool/verifier body runs).
        const requiredTools = action['requiredTools'];
        const hasRequiredTools = Array.isArray(requiredTools) && (requiredTools as unknown[]).length > 0;
        if (hasRequiredTools) {
          const preconditionEvent = emits['preconditionFailed'];
          const hasPrecondition = typeof preconditionEvent === 'string' && preconditionEvent.trim().length > 0;
          if (!hasPrecondition) {
            throw new Error(
              `v2 config: ${location} declares emits + requiredTools but has no emits.preconditionFailed event. ` +
              `When a route-affecting action requires artifacts (requiredTools), it must declare ` +
              `emits.preconditionFailed so the harness can emit a configured route event when an ` +
              `artifact is missing — before the tool/verifier body runs. ` +
              `Add emits.preconditionFailed: "<eventName>" to the action, or remove requiredTools if no artifacts are required.`
            );
          }
        }
      }
    }
  }

  /**
   * pi-experiment-ne2w AC3: Validate v2 gate aggregation precedence lists for ambiguity.
   *
   * A gate that declares allOf or anyOf MUST have unambiguous precedence lists:
   *   - If two or more checks can emit different failure-category events, failPrecedence
   *     must reference each possible failure event EXACTLY ONCE.
   *   - If two or more checks can emit different blocked-category events, blockPrecedence
   *     must reference each possible blocked event EXACTLY ONCE.
   *   - A missing precedence list when multiple distinct events exist → STARTUP FAILS.
   *   - A precedence list that references an event more than once → STARTUP FAILS.
   *   - A precedence list that references an event NOT declared in the v2 vocab → STARTUP FAILS.
   *
   * Runs on the map-form gates (before normalization to array).
   * Version-gated: only called when version === 2.
   *
   * @param gatesMap — raw map-form validationGates (Record<gateId, gateEntry>).
   * @param vocab    — pre-built v2 event vocabulary (normalized UPPER_SNAKE → category).
   */
  private validateV2GateAmbiguity(
    gatesMap: Record<string, unknown>,
    vocab: Map<string, string>
  ): void {
    for (const [gateId, gateRaw] of Object.entries(gatesMap)) {
      if (!isRecord(gateRaw)) continue;
      const gate = gateRaw as Record<string, unknown>;

      // Only validate gates that declare an operator (v2 aggregation gates).
      const operator = gate['operator'];
      if (operator === undefined || operator === null) continue;

      // Operator must be 'allOf' or 'anyOf' (noneOf is out of scope for ne2w).
      if (operator !== 'allOf' && operator !== 'anyOf') {
        throw new Error(
          `v2 gate "${gateId}" declares an unsupported operator: "${operator}". ` +
          `Only "allOf" and "anyOf" are supported. ` +
          `noneOf is explicitly out of scope. Remove or correct the operator field.`
        );
      }

      // checks must be an array.
      const checksRaw = gate['checks'];
      if (!Array.isArray(checksRaw)) {
        throw new Error(
          `v2 gate "${gateId}" declares operator "${operator}" but is missing the "checks" array. ` +
          `A gate with an operator must declare checks: [{ checkId, passEvent, failEvent, blockedEvent? }, ...]`
        );
      }
      const checks = checksRaw as unknown[];

      // passEvent must be a non-empty string in the vocab.
      const passEventRaw = gate['passEvent'];
      if (typeof passEventRaw !== 'string' || !passEventRaw.trim()) {
        throw new Error(
          `v2 gate "${gateId}" declares operator "${operator}" but is missing passEvent. ` +
          `A gate with an operator must declare passEvent: "<eventName>" (the event emitted when the gate passes). ` +
          `Example: passEvent: QUALITY_PASSED`
        );
      }
      const passEvent = passEventRaw.trim().toUpperCase();
      if (vocab.size > 0 && !vocab.has(passEvent)) {
        const declared = [...vocab.keys()].sort().join(', ') || '(none)';
        throw new Error(
          `v2 gate "${gateId}" declares passEvent: "${passEventRaw}" which is not in the declared v2 vocabulary. ` +
          `Declared events: ${declared}. ` +
          `Add "${passEventRaw}" to the appropriate category in the events block, or correct the name.`
        );
      }

      // Collect all possible failure and blocked events from the checks.
      const possibleFailEvents = new Set<string>();
      const possibleBlockedEvents = new Set<string>();

      for (let i = 0; i < checks.length; i++) {
        const checkRaw = checks[i];
        if (!isRecord(checkRaw)) continue;
        const check = checkRaw as Record<string, unknown>;

        // checkId is required.
        const checkId = check['checkId'];
        if (typeof checkId !== 'string' || !checkId.trim()) {
          throw new Error(
            `v2 gate "${gateId}" check at index ${i} is missing a non-empty checkId. ` +
            `Each check entry must declare checkId: "<toolOrVerifierId>".`
          );
        }

        // passEvent on check is required.
        const checkPassEvent = check['passEvent'];
        if (typeof checkPassEvent !== 'string' || !checkPassEvent.trim()) {
          throw new Error(
            `v2 gate "${gateId}" check "${checkId}" is missing passEvent. ` +
            `Each check must declare passEvent: "<eventName>". ` +
            `Example: passEvent: QUALITY_PASSED`
          );
        }
        // failEvent on check is required.
        const checkFailEvent = check['failEvent'];
        if (typeof checkFailEvent !== 'string' || !checkFailEvent.trim()) {
          throw new Error(
            `v2 gate "${gateId}" check "${checkId}" is missing failEvent. ` +
            `Each check must declare failEvent: "<eventName>". ` +
            `Example: failEvent: QUALITY_FAILED`
          );
        }

        // Validate vocab refs.
        if (vocab.size > 0) {
          for (const [field, eventName] of [
            ['passEvent', checkPassEvent],
            ['failEvent', checkFailEvent],
          ] as Array<[string, string]>) {
            const normalized = eventName.trim().toUpperCase();
            if (!vocab.has(normalized)) {
              const declared = [...vocab.keys()].sort().join(', ') || '(none)';
              throw new Error(
                `v2 gate "${gateId}" check "${checkId}" declares ${field}: "${eventName}" ` +
                `which is not in the declared v2 vocabulary. ` +
                `Declared events: ${declared}. ` +
                `Add "${eventName}" to the appropriate category in the events block, or correct the name.`
              );
            }
          }
        }

        possibleFailEvents.add(checkFailEvent.trim().toUpperCase());

        const checkBlockedEvent = check['blockedEvent'];
        if (typeof checkBlockedEvent === 'string' && checkBlockedEvent.trim()) {
          const normalized = checkBlockedEvent.trim().toUpperCase();
          if (vocab.size > 0 && !vocab.has(normalized)) {
            const declared = [...vocab.keys()].sort().join(', ') || '(none)';
            throw new Error(
              `v2 gate "${gateId}" check "${checkId}" declares blockedEvent: "${checkBlockedEvent}" ` +
              `which is not in the declared v2 vocabulary. ` +
              `Declared events: ${declared}. ` +
              `Add "${checkBlockedEvent}" to the appropriate category in the events block, or correct the name.`
            );
          }
          possibleBlockedEvents.add(normalized);
        }
      }

      // AC3: Ambiguity check — if multiple distinct failure events exist, failPrecedence
      // must cover each exactly once.
      if (possibleFailEvents.size > 1) {
        const failPrecedenceRaw = gate['failPrecedence'];
        if (!Array.isArray(failPrecedenceRaw)) {
          throw new Error(
            `v2 gate "${gateId}" (operator: ${operator}) can emit multiple failure events: ` +
            `${[...possibleFailEvents].sort().join(', ')}. ` +
            `A failPrecedence list is required to resolve ambiguity at startup. ` +
            `Add failPrecedence: [${[...possibleFailEvents].sort().map(e => `"${e}"`).join(', ')}] ` +
            `(highest priority first) to the gate config.`
          );
        }
        const failPrecedence = failPrecedenceRaw as unknown[];
        const failPrecedenceNormalized = failPrecedence
          .filter((e): e is string => typeof e === 'string')
          .map(e => e.trim().toUpperCase());

        // Each possible failure event must appear exactly once in failPrecedence.
        const seenInPrec = new Map<string, number>(); // event → count
        for (const e of failPrecedenceNormalized) {
          seenInPrec.set(e, (seenInPrec.get(e) ?? 0) + 1);
        }
        for (const evt of possibleFailEvents) {
          const count = seenInPrec.get(evt) ?? 0;
          if (count === 0) {
            throw new Error(
              `v2 gate "${gateId}" failPrecedence is missing event "${evt}". ` +
              `Every possible failure event must appear exactly once in failPrecedence. ` +
              `Possible failure events: ${[...possibleFailEvents].sort().join(', ')}. ` +
              `Current failPrecedence: ${failPrecedenceNormalized.join(', ') || '(empty)'}.`
            );
          }
          if (count > 1) {
            throw new Error(
              `v2 gate "${gateId}" failPrecedence references event "${evt}" ${count} times. ` +
              `Each event must appear exactly once in failPrecedence. ` +
              `Remove the duplicate "${evt}" entry from failPrecedence.`
            );
          }
        }
      }

      // AC3: Ambiguity check — if multiple distinct blocked events exist, blockPrecedence
      // must cover each exactly once.
      if (possibleBlockedEvents.size > 1) {
        const blockPrecedenceRaw = gate['blockPrecedence'];
        if (!Array.isArray(blockPrecedenceRaw)) {
          throw new Error(
            `v2 gate "${gateId}" (operator: ${operator}) can emit multiple blocked events: ` +
            `${[...possibleBlockedEvents].sort().join(', ')}. ` +
            `A blockPrecedence list is required to resolve ambiguity at startup. ` +
            `Add blockPrecedence: [${[...possibleBlockedEvents].sort().map(e => `"${e}"`).join(', ')}] ` +
            `(highest priority first) to the gate config.`
          );
        }
        const blockPrecedence = blockPrecedenceRaw as unknown[];
        const blockPrecedenceNormalized = blockPrecedence
          .filter((e): e is string => typeof e === 'string')
          .map(e => e.trim().toUpperCase());

        const seenInPrec = new Map<string, number>();
        for (const e of blockPrecedenceNormalized) {
          seenInPrec.set(e, (seenInPrec.get(e) ?? 0) + 1);
        }
        for (const evt of possibleBlockedEvents) {
          const count = seenInPrec.get(evt) ?? 0;
          if (count === 0) {
            throw new Error(
              `v2 gate "${gateId}" blockPrecedence is missing event "${evt}". ` +
              `Every possible blocked event must appear exactly once in blockPrecedence. ` +
              `Possible blocked events: ${[...possibleBlockedEvents].sort().join(', ')}. ` +
              `Current blockPrecedence: ${blockPrecedenceNormalized.join(', ') || '(empty)'}.`
            );
          }
          if (count > 1) {
            throw new Error(
              `v2 gate "${gateId}" blockPrecedence references event "${evt}" ${count} times. ` +
              `Each event must appear exactly once in blockPrecedence. ` +
              `Remove the duplicate "${evt}" entry from blockPrecedence.`
            );
          }
        }
      }
    }
  }

  /**
   * pi-experiment-0njv: Resolve and record provenance for v2 LLM action prompt files.
   *
   * Called from resolveFileBackedFields() AFTER path safety validation (preValidateV2Admission
   * already guaranteed all llm.promptFile paths are safe). Records normalized path,
   * byteCount, sha256 digest, and actionId for each admitted v2 LLM action.
   *
   * The prompt BODY is NEVER stored on the resolved config — only the provenance record
   * (AC4: no body inlining). The prompt content is read only to compute the digest,
   * then discarded.
   *
   * @param config The validated (schema-checked) HarnessConfig (version: 2 only).
   */
  private resolveV2LlmPromptProvenance(config: HarnessConfig): void {
    if (config.version !== 2) return;

    for (const [, state] of Object.entries(config.states || {})) {
      for (const action of state.actions || []) {
        const actionRecord = action as unknown as Record<string, unknown>;
        const llmRaw = actionRecord['llm'];
        if (!isRecord(llmRaw)) continue;

        const llm = llmRaw as Record<string, unknown>;
        const promptFile = llm['promptFile'];
        if (typeof promptFile !== 'string' || !promptFile.trim()) continue;

        // Resolve to absolute path within projectRoot (already validated safe).
        const resolved = path.resolve(this.projectRoot, promptFile);

        // Compute normalized project-relative path (canonical form).
        let realRoot: string;
        try {
          realRoot = fs.realpathSync(this.projectRoot);
        } catch {
          realRoot = path.resolve(this.projectRoot);
        }
        const realResolved = fs.realpathSync(resolved);
        const normalizedPath = path.relative(realRoot, realResolved);

        // Read file contents to compute digest + byte count. Body is NOT stored.
        const contents = fs.readFileSync(resolved);
        const byteCount = contents.length;
        const sha256 = createHash('sha256').update(contents).digest('hex');

        const provenance: V2PromptFileProvenance = {
          normalizedPath,
          byteCount,
          sha256,
          actionId: action.id
        };

        // Store provenance on the action (AC3). Body is never stored (AC4).
        (action as unknown as Record<string, unknown>)['v2PromptProvenance'] = provenance;
      }
    }
  }

  /**
   * pi-experiment-w2tz: Expand v2 same-file defaults and profiles.
   *
   * Called from preValidateV2Admission, BEFORE normalizeV2MapCollections and
   * BEFORE AJV validation. Operates on the RAW parsed document (map-form states
   * and tools). Mutates `parsed` in place.
   *
   * Processing order (version-gated: only when version === 2):
   *   1. Validate non-compressible field rejection for defaults.state, defaults.tool,
   *      and every profiles.states / profiles.tools entry.
   *   2. Validate unknown-allowlist-field rejection for the same blocks.
   *   3. Validate unknown-profile references and cycle detection for each state
   *      and tool that declares a `profile` field.
   *   4. Expand: for each state, merge defaults.state < profile < local (state wins).
   *              for each tool, merge defaults.tool < profile < local (tool wins).
   *
   * Precedence rule (AC2): defaults < one selected profile < local override.
   *   A field set at all three levels resolves to the LOCAL value.
   *   defaults-only: inherited. profile: overrides defaults. local: overrides profile.
   *
   * All errors are startup-fatal with source-path diagnostics (AC5).
   */
  private expandV2DefaultsAndProfiles(parsed: unknown): void {
    if (!isRecord(parsed) || parsed['version'] !== 2) return;

    const defaultsRaw = parsed['defaults'];
    const profilesRaw = parsed['profiles'];

    // Extract defaults blocks (may be absent).
    const defaultState: Record<string, unknown> = isRecord(defaultsRaw) && isRecord((defaultsRaw as Record<string, unknown>)['state'])
      ? (defaultsRaw as Record<string, unknown>)['state'] as Record<string, unknown>
      : {};
    const defaultTool: Record<string, unknown> = isRecord(defaultsRaw) && isRecord((defaultsRaw as Record<string, unknown>)['tool'])
      ? (defaultsRaw as Record<string, unknown>)['tool'] as Record<string, unknown>
      : {};

    // Extract profiles maps (may be absent).
    const stateProfilesMap: Record<string, unknown> = isRecord(profilesRaw) && isRecord((profilesRaw as Record<string, unknown>)['states'])
      ? (profilesRaw as Record<string, unknown>)['states'] as Record<string, unknown>
      : {};
    const toolProfilesMap: Record<string, unknown> = isRecord(profilesRaw) && isRecord((profilesRaw as Record<string, unknown>)['tools'])
      ? (profilesRaw as Record<string, unknown>)['tools'] as Record<string, unknown>
      : {};

    // ── 1+2: Validate defaults blocks ────────────────────────────────────────
    if (Object.keys(defaultState).length > 0) {
      this.validateDefaultsOrProfileBlock(defaultState, 'defaults.state', 'state');
    }
    if (Object.keys(defaultTool).length > 0) {
      this.validateDefaultsOrProfileBlock(defaultTool, 'defaults.tool', 'tool');
    }

    // ── 1+2: Validate profiles blocks ────────────────────────────────────────
    for (const [profileId, profileEntry] of Object.entries(stateProfilesMap)) {
      if (!isRecord(profileEntry)) continue;
      this.validateDefaultsOrProfileBlock(profileEntry as Record<string, unknown>, `profiles.states.${profileId}`, 'state');
    }
    for (const [profileId, profileEntry] of Object.entries(toolProfilesMap)) {
      if (!isRecord(profileEntry)) continue;
      this.validateDefaultsOrProfileBlock(profileEntry as Record<string, unknown>, `profiles.tools.${profileId}`, 'tool');
    }

    // ── 3+4: Expand states ────────────────────────────────────────────────────
    const statesRaw = parsed['states'];
    if (isRecord(statesRaw)) {
      for (const [stateId, stateRaw] of Object.entries(statesRaw as Record<string, unknown>)) {
        if (!isRecord(stateRaw)) continue;
        const state = stateRaw as Record<string, unknown>;
        const profileId = typeof state['profile'] === 'string' ? state['profile'] : undefined;

        // Resolve selected profile for this state.
        let selectedProfile: Record<string, unknown> = {};
        if (profileId !== undefined) {
          if (!(profileId in stateProfilesMap)) {
            const available = Object.keys(stateProfilesMap).sort().join(', ') || '(none)';
            throw new Error(
              `v2 state "${stateId}" references unknown profile "${profileId}" in profiles.states. ` +
              `Available state profiles: ${available}. ` +
              `Define the profile in profiles.states or correct the profile name.`
            );
          }
          const entry = stateProfilesMap[profileId];
          selectedProfile = isRecord(entry) ? entry as Record<string, unknown> : {};
        }

        // Merge: defaults < profile < local (only ALLOWLISTED fields; routing fields already rejected above).
        for (const field of ALLOWLISTED_STATE_FIELDS) {
          if (state[field] === undefined) {
            // Local not set — try profile then default.
            if (selectedProfile[field] !== undefined) {
              state[field] = selectedProfile[field];
            } else if (defaultState[field] !== undefined) {
              state[field] = defaultState[field];
            }
          }
          // If local is set, it wins (no change needed).
        }
      }
    }

    // ── 3+4: Expand tools ────────────────────────────────────────────────────
    const toolsRaw = parsed['tools'];
    if (isRecord(toolsRaw)) {
      // tools is still map-form at this point (before normalizeV2MapCollections).
      for (const [toolId, toolRaw] of Object.entries(toolsRaw as Record<string, unknown>)) {
        if (!isRecord(toolRaw)) continue;
        const tool = toolRaw as Record<string, unknown>;
        const profileId = typeof tool['profile'] === 'string' ? tool['profile'] : undefined;

        let selectedProfile: Record<string, unknown> = {};
        if (profileId !== undefined) {
          if (!(profileId in toolProfilesMap)) {
            const available = Object.keys(toolProfilesMap).sort().join(', ') || '(none)';
            throw new Error(
              `v2 tool "${toolId}" references unknown profile "${profileId}" in profiles.tools. ` +
              `Available tool profiles: ${available}. ` +
              `Define the profile in profiles.tools or correct the profile name.`
            );
          }
          const entry = toolProfilesMap[profileId];
          selectedProfile = isRecord(entry) ? entry as Record<string, unknown> : {};
        }

        // Merge allowlisted fields: defaults < profile < local.
        for (const field of ALLOWLISTED_TOOL_FIELDS) {
          if (tool[field] === undefined) {
            if (selectedProfile[field] !== undefined) {
              tool[field] = selectedProfile[field];
            } else if (defaultTool[field] !== undefined) {
              tool[field] = defaultTool[field];
            }
          }
        }

        // Strip the v2 `profile` reference from the tool map entry so that
        // expandToolProfiles (which handles v1 settings.toolProfiles) does not
        // try to look it up there and throw an unknown-profile error.
        if (profileId !== undefined) {
          delete tool['profile'];
        }
      }
    }
  }

  /**
   * Validate a single defaults or profiles block for non-compressible field
   * rejection (AC4) and unknown-allowlist-field rejection (AC3/AC5).
   *
   * @param block       The raw block record to validate.
   * @param sourcePath  Source path for diagnostic messages (e.g. "defaults.state").
   * @param kind        'state' or 'tool' — selects the correct field sets.
   */
  private validateDefaultsOrProfileBlock(
    block: Record<string, unknown>,
    sourcePath: string,
    kind: 'state' | 'tool'
  ): void {
    const nonCompressible = kind === 'state' ? NON_COMPRESSIBLE_STATE_FIELDS : NON_COMPRESSIBLE_TOOL_FIELDS;
    const allowlisted = kind === 'state' ? ALLOWLISTED_STATE_FIELDS : ALLOWLISTED_TOOL_FIELDS;

    const nonCompressibleViolations: string[] = [];
    const unknownAllowlistViolations: string[] = [];

    for (const field of Object.keys(block)) {
      if (nonCompressible.has(field)) {
        nonCompressibleViolations.push(field);
      } else if (!allowlisted.has(field)) {
        unknownAllowlistViolations.push(field);
      }
    }

    if (nonCompressibleViolations.length > 0) {
      const fieldList = nonCompressibleViolations.map(f => `"${f}"`).join(', ');
      throw new Error(
        `v2 config: ${sourcePath} declares non-compressible workflow field(s): ${fieldList}. ` +
        `Non-compressible fields must remain LOCAL to their owning ${kind} definition — ` +
        `they cannot be inherited via defaults or profiles because hiding routing/workflow ` +
        `semantics behind inheritance would make the statechart illegible. ` +
        `Remove ${fieldList} from ${sourcePath} and declare ${fieldList.length > 1 ? 'them' : 'it'} ` +
        `directly in each ${kind} that needs ${fieldList.length > 1 ? 'them' : 'it'}.`
      );
    }

    if (unknownAllowlistViolations.length > 0) {
      const fieldList = unknownAllowlistViolations.map(f => `"${f}"`).join(', ');
      const allowedList = [...allowlisted].sort().join(', ');
      throw new Error(
        `v2 config: ${sourcePath} declares unknown allowlist field(s): ${fieldList}. ` +
        `Only allowlisted non-routing fields may appear in defaults or profiles. ` +
        `Allowed fields for ${kind}: ${allowedList}. ` +
        `Remove ${fieldList} from ${sourcePath} or add the field to the allowlist if it is a new ergonomic default.`
      );
    }
  }

  /**
   * pi-experiment-0dgy AC4: Normalize v2 map-form collections to sorted arrays.
   *
   * Converts map-form tools, validationGates, and states.<state>.actions to
   * sorted arrays with canonical map-derived IDs. The sort is lexicographic on
   * the canonical ID (map key), ensuring deterministic resolved serialization.
   *
   * Called AFTER preValidateV2Admission (grammar/conflict validation already done)
   * and BEFORE AJV schema validation (which expects array form).
   *
   * Version-gated: only runs when version === 2.
   */
  private normalizeV2MapCollections(parsed: unknown): void {
    if (!isRecord(parsed)) return;

    // ── tools: map → sorted array with name = key ─────────────────────────
    const toolsRaw = parsed['tools'];
    if (isRecord(toolsRaw)) {
      const entries = Object.entries(toolsRaw as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
      parsed['tools'] = entries.map(([key, value]) => {
        if (!isRecord(value)) return value;
        const entry = { ...(value as Record<string, unknown>) };
        // Map key becomes the canonical name; inner name (if matching key) is normalized
        entry['name'] = key;
        return entry;
      });
    }

    // ── validationGates: map → sorted array with id = key ─────────────────
    const gatesRaw = parsed['validationGates'];
    if (isRecord(gatesRaw)) {
      const entries = Object.entries(gatesRaw as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
      parsed['validationGates'] = entries.map(([key, value]) => {
        if (!isRecord(value)) return value;
        const entry = { ...(value as Record<string, unknown>) };
        // Map key becomes the canonical id; inner id (if matching key) is normalized
        entry['id'] = key;
        return entry;
      });
    }

    // ── states.<state>.actions: map → sorted array with id = key ─────────
    const statesRaw = parsed['states'];
    if (isRecord(statesRaw)) {
      for (const [, stateRaw] of Object.entries(statesRaw as Record<string, unknown>)) {
        if (!isRecord(stateRaw)) continue;
        const actionsRaw = (stateRaw as Record<string, unknown>)['actions'];
        if (!isRecord(actionsRaw)) continue;
        const entries = Object.entries(actionsRaw as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
        (stateRaw as Record<string, unknown>)['actions'] = entries.map(([key, value]) => {
          if (!isRecord(value)) return value;
          const entry = { ...(value as Record<string, unknown>) };
          // Map key becomes the canonical id; inner id (if matching key) is normalized
          entry['id'] = key;
          return entry;
        });
      }
    }
  }

  /**
   * pi-experiment-cfzu AC1/AC2: Validate v2 event vocabulary.
   *
   * Rules (all startup-fatal):
   *   1. Each event name must match the canonical pattern: one or more segments of
   *      uppercase letters/digits, joined by underscores (e.g. SUCCESS, QUALITY_PASSED).
   *      Case-insensitive on input — normalized to upper-case.
   *   2. Duplicate event names (case-insensitive) within the same category → rejected.
   *   3. Duplicate event names (case-insensitive) across categories → rejected, naming
   *      both categories and the normalized key.
   *
   * The valid pattern: /^[A-Z0-9]+(_[A-Z0-9]+)*$/ (after normalization to upper-case).
   */
  private validateV2EventVocabulary(eventsRaw: Record<string, unknown>): void {
    const VALID_EVENT_PATTERN = /^[A-Z0-9]+(_[A-Z0-9]+)*$/;
    const CATEGORIES = ['advance', 'failure', 'blocked', 'neutral'] as const;

    // Map of normalized event name → first category that declared it
    const seenAcrossCategories = new Map<string, string>();

    for (const category of CATEGORIES) {
      const raw = eventsRaw[category];
      if (raw === undefined) continue;
      if (!Array.isArray(raw)) {
        throw new Error(
          `v2 events.${category} must be an array of event name strings, but got ${typeof raw}. ` +
          `Declare event names as a YAML array under events.${category}.`
        );
      }
      const seenInCategory = new Map<string, string>(); // normalized → original
      for (const entry of raw) {
        if (typeof entry !== 'string' || !entry.trim()) {
          throw new Error(
            `v2 events.${category} contains an invalid entry: ${JSON.stringify(entry)}. ` +
            `Event names must be non-empty strings.`
          );
        }
        const normalized = entry.toUpperCase();
        if (!VALID_EVENT_PATTERN.test(normalized)) {
          throw new Error(
            `v2 events.${category} contains event name "${entry}" which does not match the required pattern. ` +
            `Event names must be UPPER_SNAKE_CASE: one or more segments of uppercase letters or digits, ` +
            `joined by underscores (e.g. SUCCESS, QUALITY_PASSED, MY_EVENT_123). ` +
            `Rename "${entry}" to match the pattern.`
          );
        }
        // Duplicate within same category
        const prevInCat = seenInCategory.get(normalized);
        if (prevInCat !== undefined) {
          throw new Error(
            `v2 events.${category} declares duplicate event name "${entry}" (normalized: "${normalized}") — ` +
            `already declared in the same category as "${prevInCat}". ` +
            `Each event name must appear at most once within and across all categories. ` +
            `Remove the duplicate from events.${category}.`
          );
        }
        seenInCategory.set(normalized, entry);
        // Duplicate across categories
        const prevCategory = seenAcrossCategories.get(normalized);
        if (prevCategory !== undefined) {
          throw new Error(
            `v2 event vocabulary declares "${normalized}" in both "${prevCategory}" and "${category}" categories. ` +
            `Duplicate event names (case-insensitive) across categories are not allowed — ` +
            `each event name must appear in exactly one category. ` +
            `Remove "${entry}" from one of the two category lists.`
          );
        }
        seenAcrossCategories.set(normalized, category);
      }
    }
  }

  /**
   * pi-experiment-cfzu: Build the closed v2 event vocabulary set from a raw events block.
   *
   * Returns a Map of normalized event name (upper-case) → category name.
   * Assumes validateV2EventVocabulary() has already confirmed no duplicates.
   */
  private buildV2EventVocabulary(eventsRaw: Record<string, unknown>): Map<string, string> {
    const vocab = new Map<string, string>();
    const CATEGORIES = ['advance', 'failure', 'blocked', 'neutral'] as const;
    for (const category of CATEGORIES) {
      const raw = eventsRaw[category];
      if (!Array.isArray(raw)) continue;
      for (const entry of raw) {
        if (typeof entry === 'string' && entry.trim()) {
          vocab.set(entry.toUpperCase(), category);
        }
      }
    }
    return vocab;
  }

  /**
   * pi-experiment-cfzu AC3 startup lint: Every state transition key must be an exact
   * declared event name from the v2 vocabulary.
   *
   * Harness-internal restart events (HARNESS_RESTART / CONTEXT_RESTART) are always
   * admitted regardless of whether they appear in the vocabulary.
   */
  private validateV2TransitionKeys(config: unknown, declaredVocab: Map<string, string>): void {
    if (!isRecord(config)) return;
    const states = isRecord(config['states']) ? config['states'] as Record<string, unknown> : {};
    const ALWAYS_ADMITTED = new Set(['HARNESS_RESTART', 'CONTEXT_RESTART']);

    for (const [stateId, stateRaw] of Object.entries(states)) {
      if (!isRecord(stateRaw)) continue;
      const transitions = isRecord(stateRaw['transitions']) ? stateRaw['transitions'] as Record<string, unknown> : {};
      for (const key of Object.keys(transitions)) {
        const normalized = key.toUpperCase();
        if (ALWAYS_ADMITTED.has(normalized)) continue;
        if (!declaredVocab.has(normalized)) {
          const declared = [...declaredVocab.keys()].sort().join(', ') || '(none)';
          throw new Error(
            `v2 state "${stateId}" declares transition key "${key}" which is not in the declared ` +
            `event vocabulary (events.advance/failure/blocked/neutral). ` +
            `Declared event names: ${declared}. ` +
            `Add "${key}" to the appropriate category in the events block, or remove this transition key. ` +
            `In v2, state transition keys must be exact declared event names — ` +
            `category membership alone never routes an event.`
          );
        }
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

  /**
   * pi-experiment-6q0y.17 (AC7): Reject prompt-budget policies that declare:
   *   (a) negative limits (maxBytes < 0 or maxTokens < 0),
   *   (b) unknown state/action references (state/action ids not in the config),
   *   (c) a route that is absent from the declared statechart outcome vocabulary.
   *
   * Scopes: settings.promptBudget, state.promptBudget, action.promptBudget.
   * This check runs AFTER declaredOutcomes is built so route validation is accurate.
   */
  private validatePromptBudgetDeclarations(
    config: HarnessConfig,
    stateIds: Set<string>,
    declaredOutcomes: Set<string>
  ): void {
    const configPath = this.getConfigPath();

    const validatePolicy = (
      policy: { maxBytes?: number; maxTokens?: number; route: string } | undefined,
      context: string
    ): void => {
      if (!policy) return;

      // (a) Negative limits
      if (policy.maxBytes !== undefined && policy.maxBytes < 0) {
        throw new Error(
          `${context} declares promptBudget.maxBytes: ${policy.maxBytes} which is negative. ` +
          `Prompt budget limits must be non-negative integers. ` +
          `Remove the field or set a non-negative value.`
        );
      }
      if (policy.maxTokens !== undefined && policy.maxTokens < 0) {
        throw new Error(
          `${context} declares promptBudget.maxTokens: ${policy.maxTokens} which is negative. ` +
          `Prompt budget limits must be non-negative integers. ` +
          `Remove the field or set a non-negative value.`
        );
      }

      // (c) Route absent from statechart vocabulary
      if (!declaredOutcomes.has(policy.route.toUpperCase())) {
        throw new Error(
          `${context} declares promptBudget.route: "${policy.route}" which is absent ` +
          `from the statechart outcome vocabulary (advanceOutcomes/failedOutcomes/blockedOutcomes/customOutcomes). ` +
          `Declared outcomes: ${[...declaredOutcomes].join(', ')}. ` +
          `Add "${policy.route}" to the appropriate outcome list or correct the route.`
        );
      }
    };

    // Settings-level global policy
    validatePolicy(
      config.settings.promptBudget as { maxBytes?: number; maxTokens?: number; route: string } | undefined,
      `settings (${configPath})`
    );

    // (b) settings.promptBudgetStateOverrides: keyed by state ID — validate each
    // key exists in the statechart.  This is the AC7(b) unknown-state-reference
    // check: the key is a NAME that must resolve to a declared state.  Iterating
    // config.states (structural nesting) can never encounter an undeclared state;
    // this named map is the only place where an unknown state ID can be referenced.
    const settings = config.settings as {
      promptBudget?: { maxBytes?: number; maxTokens?: number; route: string };
      promptBudgetStateOverrides?: Record<string, { maxBytes?: number; maxTokens?: number; route: string }>;
      promptBudgetActionOverrides?: Record<string, { maxBytes?: number; maxTokens?: number; route: string }>;
    };
    for (const [refStateId, policy] of Object.entries(settings.promptBudgetStateOverrides ?? {})) {
      if (!stateIds.has(refStateId)) {
        throw new Error(
          `settings.promptBudgetStateOverrides key "${refStateId}" (${configPath}) references an unknown state. ` +
          `Known states: ${[...stateIds].join(', ')}. ` +
          `Remove or correct the state reference.`
        );
      }
      validatePolicy(policy, `settings.promptBudgetStateOverrides["${refStateId}"] (${configPath})`);
    }

    // (b) settings.promptBudgetActionOverrides: keyed by "stateId/actionId" — validate
    // both segments.  The key is a compound NAME; an unknown state or action ID is
    // rejected with a diagnostic naming the unknown reference and config path.
    // Build a map of stateId → Set<actionId> from config.states for O(1) lookup.
    const stateActionIds = new Map<string, Set<string>>();
    for (const [sid, state] of Object.entries(config.states || {})) {
      const ids = new Set<string>();
      for (const action of state.actions || []) {
        if (action.id) ids.add(action.id);
      }
      stateActionIds.set(sid, ids);
    }
    for (const [refKey, policy] of Object.entries(settings.promptBudgetActionOverrides ?? {})) {
      const slashIdx = refKey.indexOf('/');
      if (slashIdx === -1) {
        throw new Error(
          `settings.promptBudgetActionOverrides key "${refKey}" (${configPath}) is not in "stateId/actionId" format. ` +
          `Use slash-separated "stateId/actionId" as the key.`
        );
      }
      const refStateId = refKey.slice(0, slashIdx);
      const refActionId = refKey.slice(slashIdx + 1);
      if (!stateIds.has(refStateId)) {
        throw new Error(
          `settings.promptBudgetActionOverrides key "${refKey}" (${configPath}) references unknown state "${refStateId}". ` +
          `Known states: ${[...stateIds].join(', ')}. ` +
          `Remove or correct the state reference.`
        );
      }
      const knownActions = stateActionIds.get(refStateId) ?? new Set<string>();
      if (!knownActions.has(refActionId)) {
        throw new Error(
          `settings.promptBudgetActionOverrides key "${refKey}" (${configPath}) references unknown action "${refActionId}" in state "${refStateId}". ` +
          `Known actions for state "${refStateId}": ${[...knownActions].join(', ')}. ` +
          `Remove or correct the action reference.`
        );
      }
      validatePolicy(policy, `settings.promptBudgetActionOverrides["${refKey}"] (${configPath})`);
    }

    // State-level and action-level (structural nesting — state IDs are always declared)
    for (const [stateId, state] of Object.entries(config.states || {})) {
      validatePolicy(
        (state as { promptBudget?: { maxBytes?: number; maxTokens?: number; route: string } }).promptBudget,
        `state "${stateId}" (${configPath})`
      );

      for (const action of state.actions || []) {
        validatePolicy(
          (action as { promptBudget?: { maxBytes?: number; maxTokens?: number; route: string } }).promptBudget,
          `state "${stateId}" / action "${action.id}" (${configPath})`
        );
      }
    }
  }

  /**
   * pi-experiment-6q0y.18 AC7: Validate tool-payload budget declarations.
   *
   * Three load-bearing checks (all startup-fatal):
   *   (a) Negative limits: maxBytes < 0 is rejected.
   *   (b) Unknown tool names: keys in toolPayloadBudgetByTool that do not match
   *       any declared tool in config.tools are rejected with a diagnostic.
   *   (c) Routes absent from statechart vocabulary: every configured route must
   *       be in declaredOutcomes (case-insensitive match).
   *
   * Each check is independent — removing any one causes its test to fail.
   */
  private validateToolPayloadBudgetDeclarations(
    config: HarnessConfig,
    declaredToolNames: Set<string>,
    declaredOutcomes: Set<string>
  ): void {
    const configPath = this.getConfigPath();
    const settings = config.settings as typeof config.settings & {
      toolPayloadBudget?: { maxBytes: number; route: string };
      toolPayloadBudgetByTool?: Record<string, { maxBytes: number; route: string }>;
    };

    const validatePolicy = (
      policy: { maxBytes: number; route: string } | undefined,
      context: string
    ): void => {
      if (!policy) return;

      // (a) Negative limits
      if (policy.maxBytes < 0) {
        throw new Error(
          `${context} declares toolPayloadBudget.maxBytes: ${policy.maxBytes} which is negative. ` +
          `Tool payload budget limits must be non-negative integers. ` +
          `Remove the field or set a non-negative value.`
        );
      }

      // (c) Route absent from statechart vocabulary
      if (!declaredOutcomes.has(policy.route.toUpperCase())) {
        throw new Error(
          `${context} declares toolPayloadBudget.route: "${policy.route}" which is absent ` +
          `from the statechart outcome vocabulary (advanceOutcomes/failedOutcomes/blockedOutcomes/customOutcomes). ` +
          `Declared outcomes: ${[...declaredOutcomes].join(', ')}. ` +
          `Add "${policy.route}" to the appropriate outcome list or correct the route.`
        );
      }
    };

    // Settings-level global default policy
    validatePolicy(settings.toolPayloadBudget, `settings (${configPath})`);

    // (b) Per-tool policies: validate tool name exists AND validate each policy
    for (const [toolName, policy] of Object.entries(settings.toolPayloadBudgetByTool ?? {})) {
      if (!declaredToolNames.has(toolName)) {
        throw new Error(
          `settings.toolPayloadBudgetByTool key "${toolName}" (${configPath}) references an unknown tool name. ` +
          `Known tools: ${[...declaredToolNames].join(', ')}. ` +
          `Remove or correct the tool name reference.`
        );
      }
      validatePolicy(policy, `settings.toolPayloadBudgetByTool["${toolName}"] (${configPath})`);
    }
  }

  /**
   * pi-experiment-6q0y.48 (AC6): Reject runtime-budget policies that declare:
   *   (a) negative limits (any dimension field < 0),
   *   (b) unknown routes (route absent from statechart vocabulary),
   *   (c) policies on unknown states or actions (structural scopes are always
   *       valid; only named override maps can reference unknown state/action IDs),
   *   (d) outcomes absent from the declared statechart vocabulary.
   *
   * Checks (a) and (b)/(d) are the same check — a negative limit or an unknown
   * route both cause rejection. Check (c) applies to the settings-level named
   * override maps (promptBudgetStateOverrides pattern) — runtime budget uses
   * structural nesting, so (c) applies to any runtimeBudget declared directly
   * on a state or action (always valid by construction), and to any unknown
   * state or action ids referenced by the structure parser (caught by AJV).
   * We validate all structural runtimeBudget policies for (a) and (b).
   *
   * Scopes: settings.runtimeBudget, state.runtimeBudget, action.runtimeBudget.
   */
  private validateRuntimeBudgetDeclarations(
    config: HarnessConfig,
    stateIds: Set<string>,
    declaredOutcomes: Set<string>
  ): void {
    const configPath = this.getConfigPath();

    // Dimension field names for negative-limit checks.
    const DIMENSION_FIELDS: ReadonlyArray<string> = [
      'maxModelCalls', 'maxEstimatedInputTokens', 'maxProviderTotalTokens',
      'maxWallClockMs', 'maxRetries', 'maxToolFailures', 'maxVerifierFailures',
      'maxToolPayloadBytes',
    ];

    const validatePolicy = (
      policy: Record<string, unknown> | undefined,
      context: string
    ): void => {
      if (!policy) return;

      // (a) Negative limits — any dimension field must be non-negative.
      for (const field of DIMENSION_FIELDS) {
        const val = policy[field];
        if (typeof val === 'number' && val < 0) {
          throw new Error(
            `${context} declares runtimeBudget.${field}: ${val} which is negative. ` +
            `Runtime budget limits must be non-negative integers. ` +
            `Remove the field or set a non-negative value.`
          );
        }
      }

      // (b)/(d) Route absent from statechart vocabulary.
      if (typeof policy['route'] === 'string') {
        if (!declaredOutcomes.has((policy['route'] as string).toUpperCase())) {
          throw new Error(
            `${context} declares runtimeBudget.route: "${policy['route']}" which is absent ` +
            `from the statechart outcome vocabulary (advanceOutcomes/failedOutcomes/blockedOutcomes/customOutcomes). ` +
            `Declared outcomes: ${[...declaredOutcomes].join(', ')}. ` +
            `Add "${policy['route']}" to the appropriate outcome list or correct the route.`
          );
        }
      }
    };

    // (c) Settings-level policy: no unknown-state-reference check needed (no named maps for runtimeBudget).
    const settings = config.settings as typeof config.settings & {
      runtimeBudget?: Record<string, unknown>;
    };
    validatePolicy(settings.runtimeBudget, `settings (${configPath})`);

    // State-level and action-level structural policies — always reference known states/actions.
    // We validate the policies themselves for (a) and (b); (c) does not apply here.
    for (const [sid, state] of Object.entries(config.states || {})) {
      if (!stateIds.has(sid)) continue; // defensive; stateIds was built from config.states keys

      const statePolicy = (state as { runtimeBudget?: Record<string, unknown> }).runtimeBudget;
      validatePolicy(statePolicy, `state "${sid}" (${configPath})`);

      // Action-level policies.
      for (const action of (state.actions || [])) {
        const actionPolicy = (action as { runtimeBudget?: Record<string, unknown> }).runtimeBudget;
        validatePolicy(actionPolicy, `state "${sid}" action "${action.id}" (${configPath})`);
      }
    }
  }

  /**
   * AC4 (pi-experiment-6q0y.49): Startup lint for loop detection config.
   *
   * Rejects:
   *   (a) maxLoops < 1 (global or per-scope).
   *   (b) Unknown loop scopes (keys other than the supported LoopScope values).
   *   (c) Unknown routeEvent/defaultRouteEvent (absent from statechart vocabulary).
   *   (d) A configured route event absent from the declared v2 event vocabulary.
   */
  private validateLoopDetectionConfig(
    config: HarnessConfig,
    declaredOutcomes: Set<string>
  ): void {
    const settings = config.settings as typeof config.settings & {
      loopDetection?: Record<string, unknown>
    };
    const ld = settings.loopDetection;
    if (!ld) return; // no loopDetection config → always-on defaults, nothing to validate

    const configPath = this.getConfigPath();

    const SUPPORTED_SCOPES = new Set([
      'toolCall', 'toolCallSemantic', 'failedRoute', 'verifierFail', 'blocker'
    ]);

    // (a) global maxLoops < 1
    if (typeof ld['maxLoops'] === 'number' && ld['maxLoops'] < 1) {
      throw new Error(
        `loopDetection.maxLoops: ${ld['maxLoops']} is invalid (${configPath}). ` +
        `maxLoops must be >= 1. The default is 10.`
      );
    }

    // (c) global defaultRouteEvent absent from vocabulary
    if (typeof ld['defaultRouteEvent'] === 'string') {
      const route = ld['defaultRouteEvent'] as string;
      if (!declaredOutcomes.has(route.toUpperCase())) {
        throw new Error(
          `loopDetection.defaultRouteEvent: "${route}" is absent from the statechart outcome vocabulary (${configPath}). ` +
          `Declared outcomes: ${[...declaredOutcomes].join(', ')}. ` +
          `Add "${route}" to the appropriate outcome list or correct the route.`
        );
      }
    }

    // Check each key: (b) unknown scopes; (a)+(c) per-scope limits/routes.
    for (const [key, val] of Object.entries(ld)) {
      if (key === 'maxLoops' || key === 'defaultRouteEvent') continue; // already validated above

      // (b) Unknown scope key
      if (!SUPPORTED_SCOPES.has(key)) {
        throw new Error(
          `loopDetection.${key} is an unknown loop scope (${configPath}). ` +
          `Supported scopes: ${[...SUPPORTED_SCOPES].join(', ')}.`
        );
      }

      // Per-scope config
      const scopeVal = val as Record<string, unknown> | undefined;
      if (!scopeVal || typeof scopeVal !== 'object') continue;

      // (a) per-scope maxLoops < 1
      if (typeof scopeVal['maxLoops'] === 'number' && scopeVal['maxLoops'] < 1) {
        throw new Error(
          `loopDetection.${key}.maxLoops: ${scopeVal['maxLoops']} is invalid (${configPath}). ` +
          `maxLoops must be >= 1.`
        );
      }

      // (c)/(d) per-scope routeEvent absent from vocabulary
      if (typeof scopeVal['routeEvent'] === 'string') {
        const route = scopeVal['routeEvent'] as string;
        if (!declaredOutcomes.has(route.toUpperCase())) {
          throw new Error(
            `loopDetection.${key}.routeEvent: "${route}" is absent from the statechart outcome vocabulary (${configPath}). ` +
            `Declared outcomes: ${[...declaredOutcomes].join(', ')}. ` +
            `Add "${route}" to the appropriate outcome list or correct the route.`
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
    // Note: validatePromptBudgetDeclarations checks route against the declared
    // outcome vocabulary, so it must run AFTER the statechart/vocabulary block
    // below. We call it at the end of validateSemantics once declaredOutcomes is
    // built — see the call site at the bottom of this method.
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
    // pi-experiment-cfzu: v2 configs declare events via the top-level `events` block
    // (events.advance/failure/blocked/neutral) instead of v1 outcome fields. The
    // v1 outcome fields (advanceOutcomes/failedOutcomes/blockedOutcomes/customOutcomes)
    // are rejected in v2 configs by preValidateV2Admission above, so this check
    // only applies to v1 configs.
    const isV2 = config.version === 2;
    const hasExplicitVocab =
      sc.advanceOutcomes !== undefined ||
      sc.failedOutcomes !== undefined ||
      sc.blockedOutcomes !== undefined ||
      sc.customOutcomes !== undefined;
    if (!isV2 && !hasExplicitVocab) {
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
    // Only applies to v1 configs — v2 configs use the category-first events block
    // (validated in preValidateV2Admission → validateV2EventVocabulary).
    if (!isV2) {
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

    // Declared outcome vocabulary.
    // pi-experiment-cfzu: v2 configs build the vocabulary from the top-level events block;
    // v1 configs use the statechart outcome lists.
    let declaredOutcomes: Set<string>;
    if (isV2) {
      // v2: vocabulary is derived from events.advance/failure/blocked/neutral.
      // The events block was already validated in preValidateV2Admission.
      const eventsConfig = config.events;
      declaredOutcomes = new Set([
        ...(eventsConfig?.advance ?? []),
        ...(eventsConfig?.failure ?? []),
        ...(eventsConfig?.blocked ?? []),
        ...(eventsConfig?.neutral ?? []),
        // Always include harness-internal restart events
        EventName.HARNESS_RESTART,
        EventName.CONTEXT_RESTART
      ].map(o => o.toUpperCase()));
    } else {
      // v1: vocabulary from statechart outcome lists (always present — checked above).
      declaredOutcomes = new Set([
        ...(sc.advanceOutcomes ?? ['SUCCESS']),
        ...(sc.failedOutcomes ?? ['FAILURE']),
        ...(sc.blockedOutcomes ?? ['BLOCKED']),
        ...(sc.customOutcomes ?? []),
        // Always include harness-internal restart events
        EventName.HARNESS_RESTART,
        EventName.CONTEXT_RESTART
      ].map(o => o.toUpperCase()));
    }

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
    // pi-experiment-cfzu: v2 configs have transition key validation done in
    // preValidateV2Admission → validateV2TransitionKeys (on the raw document).
    // Here we only validate transition targets (must be known states/terminals/sinks)
    // and, for v1 configs, transition keys against the declared outcome vocabulary.
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
        // v1 only: validate transition key against statechart outcome vocabulary.
        // v2 transition key validation is done in preValidateV2Admission.
        if (!isV2 && !declaredOutcomes.has(outcomeKey.toUpperCase())) {
          throw new Error(
            `State "${stateId}" uses transition outcome "${outcomeKey}" which is not in the declared ` +
            `statechart vocabulary (advanceOutcomes/failedOutcomes/blockedOutcomes/customOutcomes). ` +
            `Declared outcomes: ${[...declaredOutcomes].join(', ')}. ` +
            `Add "${outcomeKey}" to customOutcomes (or the appropriate list) to permit it.`
          );
        }
      }
    }

    // ── AC7 (pi-experiment-6q0y.17): prompt-budget policy validation ──────────
    // Now that declaredOutcomes is built we can validate budget routes.
    this.validatePromptBudgetDeclarations(config, stateIds, declaredOutcomes);

    // ── AC7 (pi-experiment-6q0y.18): tool-payload budget policy validation ──
    // Build the set of declared tool names for unknown-tool-name checks (AC7(b)).
    const declaredToolNames = new Set<string>((config.tools ?? []).map(t => t.name));
    this.validateToolPayloadBudgetDeclarations(config, declaredToolNames, declaredOutcomes);

    // ── AC6 (pi-experiment-6q0y.48): runtime budget policy validation ──────
    this.validateRuntimeBudgetDeclarations(config, stateIds, declaredOutcomes);

    // ── AC5 (pi-experiment-6q0y.46): routeEvidence startup lint ──────────────
    // Reports which artifacts/verifiers are required for each advance or terminal
    // route event. Fails at startup if any tool with expectsVerify:true has no
    // registered verify() callback resolution can be proven deterministically.
    // NOTE: verify() registry validation for routeEvidence tools is handled at
    // coordinator startup via validateRequiredToolVerifiers (CoordinatorVerifierGate),
    // which already scans ALL state + action requiredTools. The lint here validates
    // that routeEvidence route keys are declared in the statechart vocabulary so
    // referencing an unknown outcome fails fast at load time (before a worker runs).
    this.validateRouteEvidenceDeclarations(config, declaredOutcomes);

    // ── pi-experiment-6q0y.46 FAIL-CLOSED: advance/terminal route must declare evidence ──
    // Every state transition whose outcome is an advance outcome OR whose target is
    // a terminal state must have a non-empty evidence union
    // (state.requiredTools ∪ matching routeEvidence[outcome]).
    // A zero-evidence advance/terminal route is a configuration error — it means the
    // artifact-first invariant would be silently bypassed at runtime. Fail at load().
    // pi-experiment-cfzu: v2 configs do not have advanceOutcomes; use events.advance instead.
    const advanceOutcomesForEvidence = isV2
      ? (config.events?.advance ?? [])
      : (sc.advanceOutcomes ?? ['SUCCESS']);
    this.validateEmptyAdvanceEvidence(config, advanceOutcomesForEvidence, terminalStates);

    // ── AC4 (pi-experiment-6q0y.49): loop detection config validation ─────────
    this.validateLoopDetectionConfig(config, declaredOutcomes);
  }

  /**
   * pi-experiment-6q0y.46 FAIL-CLOSED: enforce that every advance/terminal route
   * declares at least one tool in the resolved evidence union
   * (state.requiredTools ∪ action.requiredTools ∪ routeEvidence[outcome]).
   *
   * A route is "advance/terminal" when its outcome is in advanceOutcomes OR its
   * transition target is a terminal state.  Both are checked here: advance by
   * outcome vocabulary membership; terminal-target by consulting the state's
   * transitions map.
   *
   * Throws at load() with a diagnostic naming the offending state + route if any
   * such route has an empty evidence union.  Self-verifying: removing this call
   * causes the startup-lint test to fail.
   */
  private validateEmptyAdvanceEvidence(
    config: HarnessConfig,
    advanceOutcomes: string[],
    terminalStates: Set<string>
  ): void {
    // Only enforce when the config has opted into the evidence system: at least
    // one state must have a non-empty requiredTools, action.requiredTools, or
    // routeEvidence declaration. Configs with ZERO evidence declarations anywhere
    // are legacy/test configs that predate the artifact-first system; imposing the
    // lint on them would break all existing test fixtures that never declared evidence.
    const hasAnyEvidence = Object.values(config.states || {}).some(state => {
      if ((state.requiredTools ?? []).length > 0) return true;
      if ((state.actions ?? []).some(a => (a.requiredTools ?? []).length > 0)) return true;
      if (state.routeEvidence && Object.values(state.routeEvidence).some(tools => (tools ?? []).length > 0)) return true;
      return false;
    });
    if (!hasAnyEvidence) return;

    const advanceSet = new Set(advanceOutcomes.map(o => o.toUpperCase()));

    for (const [stateId, state] of Object.entries(config.states || {})) {
      // Collect the union of all transitions for this state.
      const allTransitions: Record<string, string> = {
        ...(state.transitions || {}),
        ...(state.on || {}),
      };

      for (const [outcomeKey, targetState] of Object.entries(allTransitions)) {
        const upperOutcome = outcomeKey.toUpperCase();
        const isAdvance = advanceSet.has(upperOutcome);
        const isTerminalTarget = terminalStates.has(targetState);

        if (!isAdvance && !isTerminalTarget) continue;

        // Compute evidence union: state.requiredTools ∪ action.requiredTools (any) ∪ routeEvidence[outcome].
        // This mirrors coordinatorGateRequiredTools() in extension.ts which unions all three sources.
        const stateTools = state.requiredTools ?? [];
        const actionTools = (state.actions ?? []).flatMap(a => a.requiredTools ?? []);
        const routeEvidenceEntry = state.routeEvidence
          ? Object.entries(state.routeEvidence).find(
              ([key]) => key.toUpperCase() === upperOutcome
            )
          : undefined;
        const routeTools = routeEvidenceEntry ? (routeEvidenceEntry[1] ?? []) : [];
        const evidenceUnion = [...stateTools, ...actionTools, ...routeTools];

        if (evidenceUnion.length === 0) {
          throw new Error(
            `State "${stateId}" route "${outcomeKey}" → "${targetState}" is an ` +
            `${isAdvance ? 'advance' : 'terminal-target'} route but declares no artifact evidence ` +
            `(state.requiredTools, all action.requiredTools, and routeEvidence["${outcomeKey}"] are all empty). ` +
            `Artifact-first enforcement requires at least one tool in requiredTools or ` +
            `routeEvidence for every advance/terminal route. ` +
            `Add a tool to state "${stateId}".requiredTools, an action's requiredTools, or routeEvidence["${outcomeKey}"].`
          );
        }
      }
    }
  }

  /**
   * AC5 (pi-experiment-6q0y.46): Validate state.routeEvidence declarations.
   *
   * Checks that every route key in state.routeEvidence is declared in the
   * statechart vocabulary. An undeclared route key means the evidence config
   * can never fire (the outcome is unknown) — this is almost certainly a typo
   * and should fail fast.
   *
   * Does NOT validate verifier callbacks here (they are runtime-registered; the
   * validateRequiredToolVerifiers startup check at coordinator startup covers them).
   * Does log a startup summary of which routes require evidence per state (AC5).
   */
  private validateRouteEvidenceDeclarations(
    config: HarnessConfig,
    declaredOutcomes: Set<string>
  ): void {
    for (const [stateId, state] of Object.entries(config.states || {})) {
      if (!state.routeEvidence) continue;
      for (const [routeKey, tools] of Object.entries(state.routeEvidence)) {
        if (!tools || tools.length === 0) continue;
        const normalizedKey = routeKey.toUpperCase();
        if (!declaredOutcomes.has(normalizedKey)) {
          const toolIds = tools.map((t: import('./domain/StateModels.js').RequiredTool) =>
            typeof t === 'string' ? t : t.name
          ).join(', ');
          throw new Error(
            `State "${stateId}" declares routeEvidence for route "${routeKey}" which is not in the ` +
            `statechart vocabulary (advanceOutcomes/failedOutcomes/blockedOutcomes/customOutcomes). ` +
            `Declared outcomes: ${[...declaredOutcomes].join(', ')}. ` +
            `Either add "${routeKey}" to the statechart vocabulary or remove the routeEvidence entry. ` +
            `Required tools for this route: ${toolIds}.`
          );
        }
        // AC5: log which artifacts/verifiers are required for this route.
        const toolIds = tools.map((t: import('./domain/StateModels.js').RequiredTool) =>
          typeof t === 'string' ? t : (t.expectsVerify ? `${t.name}(verify)` : t.name)
        ).join(', ');
        Logger.info('ConfigLoader', `routeEvidence lint: state "${stateId}" route "${routeKey}" requires [${toolIds}]`);
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

    // pi-experiment-0njv: compute and store v2 LLM action prompt file provenance.
    // Runs after all other field resolution; path safety was already enforced by
    // preValidateV2Admission → validateV2LlmActions (before-model-spend guarantee).
    this.resolveV2LlmPromptProvenance(config);
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
