import { ChecklistItem } from '../ProtocolParser.js';
import {
  ActionContextMode,
  ActionRunContext,
  ActionType,
  ProjectToolType,
  CwdMode,
  ThinkingLevel,
  ToolValidationCondition
} from '../../constants/index.js';
import type { RtkCancellationPolicy, RtkIdempotencyClass } from '../RtkContract.js';

/**
 * Domain types for configured Orr Else states.
 */

/**
 * Deterministic side-effect / resource contract for project-configured tools (zog2.9).
 *
 * Startup lint enforces:
 *   - serialize: true tools MUST have a non-empty serializationKey.
 *
 * Execution enforces:
 *   - allowedInReadOnlyContext: false → REJECTED in review/read-only action contexts.
 *   - safeForReadinessProbe: false → REJECTED during harness readiness probes.
 */
export interface ProjectToolSideEffectContract {
  /** Whether the tool honours AbortSignal cancellation. */
  cancellationPolicy: RtkCancellationPolicy;
  /** Retry-safety classification. */
  idempotencyClass: RtkIdempotencyClass;
  /**
   * Non-null string means this tool must not run concurrently with other tools
   * sharing the same key. MUST be non-empty when the tool also declares serialize: true.
   * null means no serialization constraint beyond the per-tool default keying.
   */
  serializationKey: string | null;
  /**
   * false means this tool is rejected in review/read-only statechart action contexts.
   */
  allowedInReadOnlyContext: boolean;
  /**
   * false means this tool must not be called during a harness readiness probe.
   */
  safeForReadinessProbe: boolean;
}

export interface AgentIdentity {
  role: string;
  expertise: string;
  constraints: string[];
}

export type LLMThinkingLevel = ThinkingLevel | string;
export type ConfiguredActionContextMode = ActionContextMode | string;
export type ConfiguredActionRunContext = ActionRunContext | string;

export interface LLMProviderConfig {
  provider: string;
  model: string;
  thinking?: LLMThinkingLevel;
}

export interface ResolvedLLMConfig extends LLMProviderConfig {
  providerKey: string;
}

export interface BaseProjectToolConfig {
  name: string;
  description?: string;
  type: ProjectToolType;
  optional?: boolean;
  // inlineResultBytes has been removed (obsolete — s3wp.24). Configs that still
  // declare it are HARD-REJECTED by ConfigLoader at startup (unknown property,
  // additionalProperties:false). See docs/raw-output-contract.md for the policy.
  usageNotes?: string[];
  // Hard wall-clock timeout enforced by the harness wrapper around every
  // invocation. Distinct from tool-specific request/process timeouts.
  wrapperTimeoutMs?: number;
  // Open the per-(bead, tool) circuit breaker after this many consecutive
  // failures within the session. The wrapper then short-circuits further
  // invocations with a REJECTED result until the bead transitions.
  maxConsecutiveFailures?: number;
  // When true, the harness memoises this tool's results within a single
  // worker session keyed by `(toolName, JSON.stringify(params))`. Cache is
  // invalidated whenever any non-cacheable tool runs (assumed to potentially
  // mutate state). Intended for stable read-only structural queries
  // (e.g. bd_get_bead, get_artifact_paths, and configured read-only project tools) that the LLM otherwise
  // re-issues on every turn.
  cacheable?: boolean;
  failureLimit?: {
    maxFailuresPerState?: number;
    suggestedOutcome?: string;
    suggestedOutcomeByState?: Record<string, string>;
    suggestedOutcomeByAction?: Record<string, string>;
    message?: string;
    terminal?: boolean;
  };
  /**
   * Deterministic side-effect / resource contract for this project-configured tool (zog2.9).
   * Required for tools with serialize: true — serializationKey must be non-empty.
   * Enforced at startup and execution time.
   */
  sideEffectContract?: ProjectToolSideEffectContract;
}

/**
 * Partial command-tool configuration that can be shared across multiple tools
 * via settings.toolProfiles (named profile) or settings.toolDefaults (global).
 * These fields are merged: toolDefaults → named profile → per-tool fields (per-tool wins).
 */
export interface ToolProfileConfig {
  env?: Record<string, string>;
  cwd?: CwdMode | string;
  allowCwdOverride?: boolean;
  timeoutMs?: number;
  wrapperTimeoutMs?: number;
  argsMode?: 'replace' | 'append';
  allowArgs?: boolean;
  acceptMaxBuffer?: boolean;
  successExitCodes?: number[];
  argumentPathScope?: ProjectCommandArgumentPathConfig;
  failureLimit?: BaseProjectToolConfig['failureLimit'];
}

/**
 * Harness-wide defaults for tsProjectTool shorthand tools (s3wp.10).
 * All fields are optional — absent fields use built-in defaults.
 */
export interface TsProjectToolDefaults {
  /**
   * Base directory for default TS project-tool scripts, relative to projectRoot.
   * Default: .pi/project-tools
   * The default script path for a tool named "foo" becomes <scriptDir>/foo.ts.
   */
  scriptDir?: string;
  /** Default argsMode. Defaults to 'append'. */
  argsMode?: 'replace' | 'append';
  /** Default allowArgs. Defaults to true. */
  allowArgs?: boolean;
  /** Default cwd for tsProjectTool tools. */
  cwd?: string;
  /** Default timeoutMs for tsProjectTool tools. */
  timeoutMs?: number;
  /** Default wrapperTimeoutMs for tsProjectTool tools. */
  wrapperTimeoutMs?: number;
}

export interface ProjectCommandToolConfig extends BaseProjectToolConfig {
  type: ProjectToolType.COMMAND;
  /**
   * Optional name of a settings.toolProfiles entry.
   * When set, the named profile's fields are applied as defaults for this tool
   * (after settings.toolDefaults, before per-tool explicit values).
   * The profile field itself is stripped before the tool reaches runtime consumers.
   */
  profile?: string;
  command: string;
  defaultArgs?: string[];
  argsMode?: 'replace' | 'append';
  allowArgs?: boolean;
  argumentPathScope?: ProjectCommandArgumentPathConfig;
  cwd?: CwdMode | string;
  allowCwdOverride?: boolean;
  timeoutMs?: number;
  successExitCodes?: number[];
  acceptMaxBuffer?: boolean;
  env?: Record<string, string>;
  /**
   * When true, invocations of this command tool are serialized across teammates
   * via the same generic cross-process lock that serializes MCP tools (for
   * stateful tools that must not run concurrently — e.g. a tsProjectTool that
   * mutates a shared backend index). Different tools never block each other; the
   * SAME serialized tool runs to completion before another teammate's identical
   * tool can start. tsProjectTool shorthand expands to a command tool, so this
   * flag covers tsProjectTool tools too.
   */
  serialize?: boolean;
}

export interface ProjectCommandArgumentPathConfig extends ProjectToolPathArgumentConfig {
  positionals?: boolean;
  flags?: string[];
}

export interface ToolValidationRule {
  tool: string;
  condition: ToolValidationCondition;
  message?: string;
}

export interface ProjectMcpToolConfig extends BaseProjectToolConfig {
  type: ProjectToolType.MCP;
  server: string;
  // Client-side MCP request timeout for the remote tools/call operation.
  timeoutMs?: number;
  /**
   * When true, calls to this MCP tool are serialized across teammates via a
   * cross-process lock (for stateful/non-concurrent-safe MCP servers). This is a
   * generic, config-driven replacement for the old hard-coded SERIAL_MCP_TOOL_NAMES
   * set — the consuming project declares which of its tools need serialization.
   */
  serialize?: boolean;
  operations?: Record<string, string> | string[];
  configPath?: string;
  argumentDefaults?: Record<string, Record<string, unknown>>;
  argumentAllowlist?: Record<string, string[]>;
  pathArguments?: Record<string, Record<string, ProjectToolPathArgumentConfig>>;
}

export interface ProjectToolPathArgumentConfig {
  rootKind?: 'worktree' | 'project' | 'framework' | 'workspace';
  root?: CwdMode | string;
  workspaceRoot?: string;
  virtualRoots?: string[];
  mustStayInsideRoot?: boolean;
}

export interface ProjectExtensionToolConfig extends BaseProjectToolConfig {
  type: ProjectToolType.EXTENSION;
  /**
   * When true, this tool is declared for observation only — the harness records
   * its calls but does not enforce that it appears in the Pi host inventory with
   * callable/provenance attributes. observeOnly tools cannot satisfy requiredTools
   * (config load is rejected if any observeOnly tool appears in any state or action
   * requiredTools — see validateObserveOnlyInRequiredTools in ConfigLoader). This
   * lets configs declare Pi-native tools that the harness watches without requiring
   * a full host-inventory contract at startup.
   */
  observeOnly?: boolean;
}

export type ProjectToolConfig = (ProjectCommandToolConfig | ProjectMcpToolConfig | ProjectExtensionToolConfig) & {
  validationRules?: ToolValidationRule[];
};

export interface RequiredToolCondition {
  writeSetIncludesAny?: string[];
  writeSetIncludesAll?: string[];
}

export interface ConditionalRequiredTool {
  name: string;
  when?: RequiredToolCondition;
  /**
   * When true, this required tool EXPECTS a registered verify() callback: the
   * coordinator-side artifact-presence gate (0yt5.20) fails fast at startup if no
   * callback is registered under `name`. Presence-only tools (ast_grep / codemap
   * etc.) that ship NO verify() omit this flag (or set it false) and load cleanly
   * — for them the gate enforces tool-result presence only.
   */
  expectsVerify?: boolean;
}

export type RequiredTool = string | ConditionalRequiredTool;


/**
 * Rich declaration for an artifact type. Lets a project extension declare an
 * artifact the harness should generate a directory for and/or permit the
 * teammate to write outside the plan write-set. The plain-string shorthand
 * (`name: "<template>"`) remains valid and is equivalent to `{ path: "<template>" }`.
 */
export interface ArtifactTemplate {
  /** Path template (supports {{beadId}}, {{stateId}}, {{baseDir}}, {{projectRoot}}, {{worktreePath}}, ...). */
  path: string;
  /** Which root the template resolves against when relative. Defaults to 'project'. */
  scope?: 'project' | 'worktree';
  /**
   * When true, the teammate may write to this artifact's exact resolved path even
   * when it is NOT in the bead's approved plan write set (path-class systemArtifact).
   * Undeclared workspace-root writes remain rejected.
   */
  writable?: boolean;
  /** When true, the harness ensures the artifact's parent directory exists (mkdir -p). */
  ensureDir?: boolean;
}

export type ArtifactTemplateConfig = string | ArtifactTemplate;

export interface ArtifactConfig {
  baseDir?: string;
  templates?: Record<string, ArtifactTemplateConfig>;
}

export interface PiShellPolicyConfig {
  disallowProjectToolFallback?: boolean;
  blockedCommandPatterns?: string[];
}

export interface PiMcpPolicyConfig {
  allowToolCalls?: boolean;
  blockedToolPatterns?: string[];
}

export interface PiIntegrationConfig {
  tools?: string[];
  observedTools?: string[];
  skillPaths?: string[];
  workerArgs?: string[];
  workerExtensions?: string[];
  shell?: PiShellPolicyConfig;
  mcp?: PiMcpPolicyConfig;
}

export interface ValidationGateConfig {
  id: string;
  description?: string;
  states?: string[];
  beforeStates?: string[];
  afterStates?: string[];
  checklist?: ChecklistItem[] | string;
  required?: boolean;
}

export interface TeammateAction {
  id: string;
  type: ActionType;
  context?: ConfiguredActionRunContext;
  prompt?: string;
  checklist?: ChecklistItem[] | string;
  tool?: string;
  arguments?: Record<string, unknown>;
  command?: string;
  requiredTools?: RequiredTool[];
  requiredSkills?: string[];
  contextMode?: ConfiguredActionContextMode;
  maxContextTokens?: number;
  handoverRequired?: boolean;
  /** When true, the sequenced action is expected to produce framework toolCalls.
   *  If neither the inline result nor the outputFile contains valid toolCalls,
   *  the sequenced action FAILS CLOSED instead of silently completing. */
  generatesFrameworkToolCalls?: boolean;
}

export type ActionDefinition = TeammateAction;

/**
 * Worktree provisioning mode for harness.settings.worktreePolicy.default.
 *
 * 'always'  — every state receives an isolated git worktree (current default).
 * 'never'   — no state receives an isolated worktree; teammates run at the
 *             project root unless overridden per-state.
 *
 * Per-state `provisionWorktree` overrides this default for individual states.
 */
export type WorktreeProvisioningMode = 'always' | 'never';

/**
 * Top-level worktree allocation policy.
 * Lives under settings.worktreePolicy in harness.yaml.
 *
 * settings.worktreePolicy.default is REQUIRED — ConfigLoader rejects configs
 * that omit it. Declare 'always' to preserve the original behavior (every
 * state receives an isolated git worktree) or 'never' to run all states at
 * the project root unless overridden per-state.
 */
export interface WorktreePolicyConfig {
  /**
   * Default provisioning mode applied to all states that do not declare
   * an explicit `provisionWorktree` field. REQUIRED — ConfigLoader fails
   * startup if this field is absent.
   */
  default?: WorktreeProvisioningMode;
}

export interface SDLCState {
  id: string;
  identity: AgentIdentity;
  baseInstructions?: string;
  harnessRestartPrompt?: string;
  contextRestartPrompt?: string;
  ruleCategories?: string[]; // Folders in .pi/rules to load
  llmProvider?: string;
  model?: string;
  thinking?: LLMThinkingLevel;
  checklist?: ChecklistItem[] | string;
  actions: TeammateAction[];
  skills?: string[];
  defaultActionContextMode?: ConfiguredActionContextMode;
  maxContextTokens?: number;
  handoverRequired?: boolean;
  contextRotThreshold?: number;
  on?: Record<string, string>;
  transitions: Record<string, string>;
  requiredTools?: RequiredTool[];
  requiredSkills?: string[];
  /**
   * Whether to provision an isolated git worktree for this state.
   *
   * When true, the Supervisor provisions a per-bead worktree before spawning
   * the teammate; the teammate runs isolated from the project root.
   * When false, the teammate runs at the project root (no worktree created).
   *
   * When absent, the harness falls back to settings.worktreePolicy.default
   * (which is now required to be explicit — ConfigLoader rejects configs
   * that omit it).
   *
   * Example: set to false for Planning/Review states that must not modify
   * code; set to true (or omit) for Implementation states.
   */
  provisionWorktree?: boolean;
}

export interface HarnessConfig {
  settings: {
    maxConcurrentSlots: number;
    handoverTemplate: string;
    agentTurnTimeoutMs: number;
    teammateNoProgressTimeoutMs?: number;
    /**
     * Number of consecutive slot-health checks a heartbeat-only live gap must
     * persist before it is declared orphaned and suppressed.
     * Defaults to SupervisorDefaults.HEARTBEAT_ONLY_GAP_ORPHAN_CHECKS (3).
     */
    heartbeatOnlyGapOrphanChecks?: number;
    /**
     * Wall-clock TTL (ms) after which a heartbeat-only live gap is declared
     * orphaned even if the consecutive-check threshold has not been reached.
     * Defaults to SupervisorDefaults.HEARTBEAT_ONLY_GAP_ORPHAN_TTL_MS (90 s).
     */
    heartbeatOnlyGapOrphanTtlMs?: number;
    processReapIntervalMs: number;
    teamLeadSystemPrompt?: string;
    projectObjective?: string;
    startState?: string;
    workflowVersion?: string;
    harnessRestartEvent: string;
    harnessRestartPrompt?: string;
    contextRestartEvent: string;
    contextRestartPrompt?: string;
    pi?: PiIntegrationConfig;
    eventStore?: { enabled?: boolean; dir?: string; name?: string; fileName?: string };
    contextRestartRequirements?: { rereadFiles?: string[]; requireEvidence?: boolean };
    traceability?: {
      requirePlanToBead?: boolean;
      requireBeadToPlan?: boolean;
      evidenceStore?: string;
      /**
       * Name of the project verifier or tool that owns the traceability contract.
       * REQUIRED when the traceability block is present: without an explicit owner
       * declaration, the setting would be inert — implying harness enforcement when
       * none exists. ConfigLoader rejects the config if this field is absent.
       *
       * Example: 'plan_contract' (cerdiwen's project verifier that validates
       * plan-to-bead and bead-to-plan traceability internally).
       */
      ownedBy: string;
    };
    reviewArtifacts?: { shipPostReview?: { state?: string; store?: string; eventType?: string; required?: boolean } };
    transactionalState?: {
      enabled?: boolean;
      requireReadSet?: boolean;
      requireWriteSet?: boolean;
      autoRestoreUnapprovedPaths?: string[];
      requireAssumptions?: boolean;
      requireVersionDependencies?: boolean;
      requireVerifierObligations?: boolean;
      requireConflictPolicy?: boolean;
      evidenceStore?: string;
    };
    artifacts?: ArtifactConfig;
    /**
     * Named path roots resolved at runtime and injected into template context,
     * tool env, and prompt variables.  Keys are generic identifiers (e.g.
     * "frameworkRoot", "artifactsDir"); values are absolute paths or paths
     * relative to projectRoot.  Template variables use `{{roots.NAME}}`.
     *
     * Project-specific roots (e.g. the consuming project's artifact dirs) stay here so the
     * harness core remains generic — no hard-coded project paths in defaults.
     */
    roots?: Record<string, string>;
    /**
     * Global defaults applied to every command tool before per-tool or per-profile
     * values. Any field set here acts as the lowest-priority base; per-tool and
     * per-profile values always win. Optional and additive — existing configs
     * without this field behave identically to before.
     */
    toolDefaults?: ToolProfileConfig;
    /**
     * Named reusable partial command-tool configuration blocks.
     * A command tool can reference one profile by name via its `profile` field.
     * Profile fields are applied after toolDefaults and before per-tool fields.
     * Keys are arbitrary project-defined profile names.
     */
    toolProfiles?: Record<string, ToolProfileConfig>;
    /**
     * Harness-wide defaults for tsProjectTool shorthand tools (s3wp.10).
     * scriptDir sets the base directory for default script paths.
     * Other fields set defaults applied to all tsProjectTool tools.
     */
    tsProjectToolDefaults?: TsProjectToolDefaults;
    /**
     * Harness-wide worktree allocation policy. REQUIRED — ConfigLoader
     * rejects startup when this block (or its `default` field) is absent.
     *
     * Controls which states receive an isolated git worktree before the
     * teammate is spawned. Declare `default: always` to provision a worktree
     * for every state (original behavior) or `default: never` to run all
     * states at the project root.
     *
     * Per-state `provisionWorktree` overrides this policy for individual
     * states regardless of the policy default.
     */
    worktreePolicy?: WorktreePolicyConfig;
    defaultActionContextMode?: ConfiguredActionContextMode;
    defaultModel: string;
    defaultProvider: string;
    modelProviders: Record<string, LLMProviderConfig>;
    stateContextRotThreshold: number;
    harnessContextRotThreshold: number;
    cycleCap?: number;
    contextMonitor?: {
      autoRestartCompactionCount?: number;
    };
    observability?: {
      enabled: boolean;
      dir?: string;
      fileName?: string;
      retentionDays?: number;
      collector?: {
        endpoint: string;
        headers?: Record<string, string>;
        timeoutMs?: number;
      };
    };
  };
  scheduler: {
    weights: {
      waitTime: number;
      executionTime: number;
      progress: number;
      penalty: number;
      priority?: number;
      restart?: number;
      resume?: number;
    }
  };
  statechart?: StatechartConfig;
  retention?: RetentionConfig;
  validationGates?: ValidationGateConfig[];
  states: Record<string, SDLCState>;
  tools?: ProjectToolConfig[];
}

/**
 * Statechart vocabulary configuration.
 *
 * Declared at the top-level `statechart` key in harness.yaml.
 * All fields are optional — absent fields reproduce the hard-coded defaults
 * (SUCCESS/FAILURE/BLOCKED outcomes, 'completed' terminal state), so any
 * config without a `statechart` block behaves byte-identically to before.
 *
 * `customEvents` is a placeholder field whose behaviour is provided by a
 * parallel bead; it is declared here so the interface is stable.
 */
export interface StatechartConfig {
  /** Override for the initial state (mirrors settings.startState; settings wins). */
  initialState?: string;
  /**
   * State IDs that are considered terminal (workflow is done when reached).
   * Required when the block is present; defaults to ['completed'] when absent.
   */
  terminalStates: string[];
  /**
   * Outcome strings that trigger forward state advancement.
   * Defaults to ['SUCCESS'].
   */
  advanceOutcomes?: string[];
  /**
   * Outcome strings that map to a STATE_FAILED teammate event.
   * Defaults to ['FAILURE'].
   */
  failedOutcomes?: string[];
  /**
   * Outcome strings that map to a STATE_BLOCKED teammate event.
   * Defaults to ['BLOCKED'].
   */
  blockedOutcomes?: string[];
  /**
   * Additional custom outcome strings (beyond the above sets).
   * Custom outcomes map to STATE_TRANSITIONED (advance semantics without gates).
   */
  customOutcomes?: string[];
  /**
   * Placeholder: custom event names whose behaviour is filled by a parallel bead.
   * Declare here to keep the interface stable across beads.
   */
  customEvents?: string[];
}

/**
 * Retention policy configuration (settings.retention in harness.yaml).
 *
 * All fields are optional — when absent the system uses the named constants in
 * RetentionDefaults (backward-safe: no config → current behavior unchanged).
 */
export interface RetentionConfig {
  /**
   * Maximum age in milliseconds for log/.tmp/.trash entries before removal.
   * Defaults to RetentionDefaults.MAX_AGE_MS (2 days).
   */
  maxAgeMs?: number;
  /**
   * Whether event-JSONL compaction is enabled.
   * Defaults to RetentionDefaults.COMPACTION_ENABLED (false).
   * When false, the compaction step is skipped entirely (safe default).
   */
  compactionEnabled?: boolean;
  /**
   * Age in milliseconds after which non-replay-critical events may be
   * compacted out of the JSONL.
   * Defaults to RetentionDefaults.COMPACTION_WINDOW_MS (7 days).
   */
  compactionWindowMs?: number;
  /**
   * Bytes threshold for emitting a RETENTION_DISK_HEALTH event.
   * Defaults to RetentionDefaults.DISK_HEALTH_WARN_BYTES (50 MiB).
   */
  diskHealthWarnBytes?: number;
  /**
   * Maximum number of files removed from the tool-output area in a single retention run.
   * Bounds million-file cleanup spikes from legacy scratch accumulation.
   * Defaults to RetentionDefaults.MAX_TOOL_CALL_FILES_PER_RUN (50,000).
   */
  maxToolCallFilesPerRun?: number;
  /**
   * Maximum number of directories removed from the tool-output area in a single retention run.
   * Defaults to RetentionDefaults.MAX_TOOL_CALL_DIRS_PER_RUN (10,000).
   */
  maxToolCallDirsPerRun?: number;
}

/**
 * First-class Checklist domain entity
 */
export class Checklist {
  constructor(public readonly items: ChecklistItem[]) {}

  public validate(results: Record<string, { checked: boolean; evidence?: string }>): { 
    valid: boolean; 
    missing: string[] 
  } {
    const missing = this.items
      .filter(item => item.mandatory && (!results[item.text] || !results[item.text].checked))
      .map(item => item.text);
    
    return {
      valid: missing.length === 0,
      missing
    };
  }
}
