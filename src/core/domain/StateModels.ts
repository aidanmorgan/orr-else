import { ChecklistItem } from '../ProtocolParser.js';
import {
  ActionContextMode,
  ActionRunContext,
  ActionType,
  ProjectToolType,
  CwdMode,
  StateContextPolicy,
  ThinkingLevel,
  ToolValidationCondition
} from '../../constants/index.js';
import type { RtkCancellationPolicy, RtkIdempotencyClass } from '../RtkContract.js';

/**
 * Domain types for configured Orr Else states.
 */

/**
 * Per-scope loop detection configuration (pi-experiment-6q0y.49).
 *
 * Each supported loop scope may have its own maxLoops and routeEvent.
 * When absent, the parent loopDetection.maxLoops / defaultRouteEvent apply.
 *
 * Supported scope keys: toolCall | toolCallSemantic | failedRoute | verifierFail | blocker.
 */
export interface LoopScopeConfig {
  /** Override maxLoops for this scope. */
  maxLoops?: number;
  /** Route event to emit when this scope exceeds its limit. */
  routeEvent?: string;
}

/**
 * Optional loop-detection configuration (pi-experiment-6q0y.49).
 *
 * ALWAYS ON — this config only adjusts thresholds; it cannot disable detection.
 * When absent, all scopes use maxLoops=10 and route=FAILURE (AC2).
 *
 * YAML: settings.loopDetection.maxLoops (global), plus per-scope overrides.
 */
export interface LoopDetectionConfig {
  /**
   * Global maxLoops ceiling applied to all scopes that don't declare their own.
   * Default: 10. Must be >= 1 (startup lint rejects 0 or negative).
   */
  maxLoops?: number;
  /**
   * Default route event emitted when any scope exceeds its limit.
   * Must be a declared statechart outcome (startup lint AC4).
   * Default: 'FAILURE'.
   */
  defaultRouteEvent?: string;
  /** Per-scope overrides keyed by LoopScope name. */
  toolCall?: LoopScopeConfig;
  toolCallSemantic?: LoopScopeConfig;
  failedRoute?: LoopScopeConfig;
  verifierFail?: LoopScopeConfig;
  blocker?: LoopScopeConfig;
}

/**
 * Optional hard prompt-budget policy (pi-experiment-6q0y.17).
 *
 * Opt-in: absent = no rejection (true no-op when unconfigured, AC1).
 * When declared:
 *   - maxBytes: hard upper limit for the final assembled prompt in UTF-8 bytes.
 *   - maxTokens: hard upper limit for the final assembled prompt in estimated tokens
 *     (token estimate = ceil(byteLength / TOKEN_ESTIMATE_DIVISOR = 4)).
 *   - route: deterministic outcome route when the limit is exceeded. Must be a
 *     declared outcome in the statechart vocabulary (AC7 startup lint).
 *
 * Precedence (highest first): action > state > settings (AC3).
 * Only the innermost configured policy takes effect — there is no merging.
 */
export interface PromptBudgetPolicy {
  /** Maximum UTF-8 byte length for the final assembled prompt. Optional. */
  maxBytes?: number;
  /** Maximum estimated token count for the final assembled prompt. Optional. */
  maxTokens?: number;
  /**
   * Deterministic outcome route emitted when the limit is exceeded.
   * Must reference a declared outcome in the statechart vocabulary (AC7 lint).
   */
  route: string;
}

/**
 * Optional per-tool or default payload-budget policy (pi-experiment-6q0y.18).
 *
 * Opt-in: absent = no rejection for that result path (true no-op when unconfigured).
 * When declared:
 *   - maxBytes: hard upper limit for the model-facing tool result in UTF-8 bytes.
 *   - route: deterministic outcome route when the limit is exceeded. Must be a
 *     declared outcome in the statechart vocabulary (AC7 startup lint).
 *
 * Resolution: per-tool declaration > default.
 * Only the innermost configured policy takes effect — there is no merging.
 */
export interface ToolPayloadBudgetPolicy {
  /** Maximum UTF-8 byte length for the model-facing tool result payload. */
  maxBytes: number;
  /**
   * Deterministic outcome route emitted when the limit is exceeded.
   * Must reference a declared outcome in the statechart vocabulary (AC7 lint).
   */
  route: string;
}

/**
 * Optional per-bead/per-state/per-action runtime budget policy (pi-experiment-6q0y.48).
 *
 * Opt-in: absent = no enforcement (true no-op when unconfigured, AC1).
 * When declared, exceeded hard limits fail BEFORE the next model/provider/tool
 * spend and route through the configured deterministic outcome (AC4).
 *
 * Supported dimensions (AC3):
 *   - maxModelCalls:           total model-request count across the run.
 *   - maxEstimatedInputTokens: cumulative estimated input tokens (ceil(bytes/4)).
 *   - maxProviderTotalTokens:  cumulative provider-reported total tokens.
 *   - maxWallClockMs:          wall-clock elapsed ms since worker-run start.
 *   - maxRetries:              cumulative retry count across all tool invocations.
 *   - maxToolFailures:         cumulative per-tool failure count.
 *   - maxVerifierFailures:     cumulative verifier-gate rejection count.
 *   - maxToolPayloadBytes:     cumulative tool-result payload bytes sent to model.
 *
 * All dimension fields are optional — omitting a field means no limit for that
 * dimension. At least one dimension should be set to be meaningful.
 *
 * Precedence (highest first): action > state > settings (AC2).
 * Only the innermost configured policy takes effect — there is no merging.
 *
 * `route` must be a declared outcome in the statechart vocabulary (AC6 startup lint).
 */
export interface RuntimeBudgetPolicy {
  /** Maximum total model-request count (fails BEFORE the next request when reached). */
  maxModelCalls?: number;
  /** Maximum cumulative estimated input tokens (ceil(bytes/4)). */
  maxEstimatedInputTokens?: number;
  /** Maximum cumulative provider-reported total tokens. */
  maxProviderTotalTokens?: number;
  /** Maximum wall-clock elapsed ms since worker-run start (AC7: fake clock in tests). */
  maxWallClockMs?: number;
  /** Maximum cumulative retry count across all tool invocations. */
  maxRetries?: number;
  /** Maximum cumulative per-tool failure count. */
  maxToolFailures?: number;
  /** Maximum cumulative verifier-gate rejection count. */
  maxVerifierFailures?: number;
  /** Maximum cumulative tool-result payload bytes sent to the model. */
  maxToolPayloadBytes?: number;
  /**
   * Deterministic outcome route emitted when any limit is exceeded.
   * Must reference a declared outcome in the statechart vocabulary (AC6 lint).
   */
  route: string;
}

/**
 * Retry policy for project-configured tools (pi-experiment-t6gw).
 *
 * Opt-in: absent retryPolicy means ZERO automatic retries (default).
 * When declared:
 *   - maxAttempts: total number of attempts (1 = no retry; must be >= 1).
 *     The retry count is maxAttempts - 1. E.g. maxAttempts:3 allows 2 retries.
 *   - retriableCategories: closed set of ToolFailureCategory values that trigger
 *     a retry. Only TRANSPORT | TIMEOUT | INPUT | INFRA are valid. The retry
 *     pipeline admits a retry ONLY when the failure category is in this set
 *     AND the tool declares an eligible idempotencyClass (idempotent | at_least_once).
 *     non_idempotent tools are NEVER retried regardless of policy.
 *
 * AC-binding constraints enforced at config load:
 *   - maxAttempts must be >= 1 (zero retries means "don't declare retryPolicy").
 *   - retriableCategories must be non-empty.
 */
export interface ToolRetryPolicy {
  /** Total attempts including the first (1 = no retry; 2 = one retry; etc.). */
  maxAttempts: number;
  /** Closed set of ToolFailureCategory values that may trigger a retry. */
  retriableCategories: Array<'TRANSPORT' | 'TIMEOUT' | 'INPUT' | 'INFRA'>;
}

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
  /**
   * Optional retry policy (pi-experiment-t6gw). Absent = ZERO automatic retries.
   * When present, the harness retry pipeline consults the tool's sideEffectContract
   * idempotencyClass before admitting any retry. non_idempotent tools are NEVER retried.
   */
  retryPolicy?: ToolRetryPolicy;
}

/**
 * A single per-tool prompt text override within a named tool prompt profile
 * (pi-experiment-6q0y.4).
 *
 * `tool`  — name of the configured project tool this override applies to.
 * `id`    — must match the enclosing profile map key; used for lint cross-checks.
 * `text`  — replacement description injected into the assembled prompt for this
 *           tool when the profile is selected. Max 700 characters; must not
 *           contain volatile template placeholders (e.g. {{beadId}}).
 */
export interface ToolPromptProfileEntry {
  tool: string;
  id: string;
  text: string;
}

/**
 * Named map of per-tool prompt profile overrides (pi-experiment-6q0y.4).
 *
 * Lives under settings.toolPromptProfiles in harness.yaml.
 * Keys are arbitrary project-defined profile names (e.g. "compact", "detailed").
 * Each value is an array of per-tool text overrides for that profile.
 *
 * Selection precedence (highest first): action > state > settings > default.
 * The "default" profile means no override — the tool's own `description` is used.
 */
export type ToolPromptProfilesConfig = Record<string, ToolPromptProfileEntry[]>;

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

/**
 * pi-experiment-ne2w: v2 gate operator.
 *
 * allOf — pass only when ALL listed checks pass.
 * anyOf — pass when AT LEAST ONE check passes.
 * noneOf — explicitly out of scope for this bead.
 */
export type V2GateOperator = 'allOf' | 'anyOf';

/**
 * pi-experiment-ne2w: one check entry inside a v2 gate.
 *
 * checkId   — stable ID of the tool or verifier to evaluate (matches a configured tool name).
 * emits     — the route-event names this check can emit (pass, fail, blocked).
 *
 * The pass event is always in emits.pass. fail and blocked are optional.
 */
export interface V2GateCheckEntry {
  /** Stable ID of the tool or verifier this check evaluates. */
  readonly checkId: string;
  /** Route-event name emitted when this check passes. Must be in the v2 vocab. */
  readonly passEvent: string;
  /** Route-event name emitted when this check fails. Must be in the v2 vocab. */
  readonly failEvent: string;
  /** Route-event name emitted when this check is blocked. Optional. Must be in the v2 vocab if present. */
  readonly blockedEvent?: string;
}

/**
 * pi-experiment-ne2w: Result of evaluating a single check inside a v2 gate.
 *
 * verdict    — 'pass' | 'fail' | 'blocked'
 * eventName  — the normalized UPPER_SNAKE event name chosen by the verdict
 * evidenceRef— the artifact evidence produced by this check (required by AC4)
 */
export interface V2GateCheckResult {
  /** ID of the check (tool or verifier name). */
  readonly checkId: string;
  /** Deterministic verdict produced by the check. */
  readonly verdict: 'pass' | 'fail' | 'blocked';
  /**
   * The UPPER_SNAKE event name that corresponds to this verdict.
   * Chosen from V2GateCheckEntry.passEvent / failEvent / blockedEvent.
   */
  readonly eventName: string;
  /** All artifact evidence produced by this check. Required by AC4. */
  readonly evidenceRefs: readonly import('../RouteEventContract.js').RouteEvidenceRef[];
}

/**
 * pi-experiment-ne2w: v2 gate configuration.
 *
 * Extends ValidationGateConfig with the operator + checks + precedence fields
 * needed for aggregated deterministic gate evaluation.
 *
 * operator        — 'allOf' | 'anyOf' (noneOf out of scope).
 * checks          — ordered list of check entries; evaluated in configured order.
 * passEvent       — single event emitted when the operator resolves to pass.
 * failPrecedence  — ordered list of failure-category event names; first entry wins.
 *                   REQUIRED when two or more checks can emit different failure events.
 * blockPrecedence — ordered list of blocked-category event names; first entry wins.
 *                   REQUIRED when two or more checks can emit different blocked events.
 *
 * VERSION-GATED: only applies to v2 configs (config.version === 2).
 */
export interface V2GateConfig extends ValidationGateConfig {
  /** Gate operator: 'allOf' or 'anyOf'. */
  readonly operator: V2GateOperator;
  /** Ordered list of check entries to evaluate. */
  readonly checks: readonly V2GateCheckEntry[];
  /** Event name emitted when the gate resolves to pass. Must be in the v2 vocab. */
  readonly passEvent: string;
  /**
   * Ordered precedence list for failure-category events (highest priority first).
   * Must reference each possible failure event name exactly once.
   * REQUIRED when any two checks can emit different failure events.
   * Startup fails as ambiguous if this list is missing or incomplete.
   */
  readonly failPrecedence?: readonly string[];
  /**
   * Ordered precedence list for blocked-category events (highest priority first).
   * Must reference each possible blocked event name exactly once.
   * REQUIRED when any two checks can emit different blocked events.
   * Startup fails as ambiguous if this list is missing or incomplete.
   */
  readonly blockPrecedence?: readonly string[];
}

/**
 * pi-experiment-hutg: v2 action route-event emits mapping.
 *
 * Config-owned mapping from deterministic TypeScript verdicts to declared v2 event names.
 * The route event name is chosen ONLY by (configured mapping + deterministic TS verdict).
 * Tool stdout/stderr, LLM prose, and model-provided args MUST NEVER choose the route.
 *
 * Required fields:
 *   pass  — event name emitted when the deterministic verdict is pass.
 *   fail  — event name emitted when the deterministic verdict is fail.
 *
 * Optional fields:
 *   blocked            — emitted when the verdict is blocked.
 *   preconditionFailed — emitted when a required artifact is missing BEFORE the
 *                        tool/verifier body runs. If a route-affecting action requires
 *                        an artifact and this field is absent, startup REJECTS the action.
 *
 * All event names must reference the declared v2 event vocabulary (events.advance/
 * failure/blocked/neutral). References to undeclared events fail at startup.
 *
 * Only valid on tool/verifier actions (emitterType: 'tool' | 'verifier'). Declaring
 * emits on an LLM action (one with an `llm` block) is a STARTUP FAILURE — LLM
 * actions cannot choose workflow routes.
 */
export interface ActionEmitsMapping {
  /** Event name emitted when the deterministic verdict is pass. Must be in v2 vocab. */
  readonly pass: string;
  /** Event name emitted when the deterministic verdict is fail. Must be in v2 vocab. */
  readonly fail: string;
  /** Event name emitted when the deterministic verdict is blocked. Optional. Must be in v2 vocab. */
  readonly blocked?: string;
  /**
   * Event name emitted BEFORE tool/verifier body when a required artifact is missing.
   * If absent and the action requires artifacts, startup rejects the action.
   */
  readonly preconditionFailed?: string;
}

/**
 * pi-experiment-0njv: v2 LLM action configuration sub-object.
 *
 * When an action in a v2 config (version: 2) declares an `llm` block, it is a
 * "v2 LLM action". The `promptFile` field is REQUIRED; inline prompt bodies
 * (`llm.prompt` or the legacy top-level `prompt` field) are FORBIDDEN.
 *
 * promptFile must be a normalized project-relative path — no absolute paths,
 * no `..` escape, no symlink escape, no directory, no unreadable/nonexistent file.
 * Path safety is verified at config load BEFORE any provider/model request.
 */
export interface V2LlmActionConfig {
  /**
   * Project-relative path to the prompt file for this LLM action.
   * Must be a non-empty string naming an existing, readable file within the
   * project root (no absolute paths, no `..` escape, no symlink escape outside root).
   */
  promptFile: string;
}

/**
 * pi-experiment-0njv: Provenance record for a v2 LLM action prompt file.
 *
 * Recorded at config load for every admitted v2 LLM action promptFile.
 * The prompt BODY is NEVER stored here — only path, digest, byte count,
 * and source action ID for deterministic provenance tracking.
 */
export interface V2PromptFileProvenance {
  /** Normalized project-relative path (e.g. ".pi/prompts/implement.md"). */
  normalizedPath: string;
  /** Byte count of the prompt file at admission time. */
  byteCount: number;
  /** SHA-256 hex digest of the prompt file contents at admission time. */
  sha256: string;
  /** Canonical action ID (map key / action.id) that owns this prompt file. */
  actionId: string;
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
  /**
   * Explicit set of tool names active for this action.
   * When absent, the active set is inherited from the parent state's activeTools.
   * When present, overrides the state-level set for this action only.
   * Resolved by ActiveToolSetResolver — unknown names fail startup lint.
   */
  activeTools?: string[];
  /**
   * Action-level tool prompt profile selection (pi-experiment-6q0y.4).
   *
   * Highest-priority profile selection — overrides state.toolPromptProfile and
   * settings.toolPromptProfile for this specific action. When set, the named
   * profile specializes tool descriptions in the assembled prompt for this action.
   * Must reference a key in settings.toolPromptProfiles.
   */
  toolPromptProfile?: string;
  /**
   * Action-level prompt-budget policy (pi-experiment-6q0y.17).
   *
   * Highest-precedence budget limit — overrides state.promptBudget and
   * settings.promptBudget for this action. When absent, the state-level
   * policy applies (action > state > settings precedence, AC3).
   */
  promptBudget?: PromptBudgetPolicy;
  /**
   * Action-level runtime budget policy (pi-experiment-6q0y.48).
   *
   * Highest-precedence runtime budget — overrides state.runtimeBudget and
   * settings.runtimeBudget for this specific action (action > state > settings, AC2).
   * When absent, the state-level policy applies.
   */
  runtimeBudget?: RuntimeBudgetPolicy;
  /**
   * pi-experiment-0njv: v2 LLM action configuration.
   *
   * When present, this action is a "v2 LLM action". The `promptFile` field is
   * REQUIRED. Inline prompt bodies (llm.prompt or top-level prompt) are FORBIDDEN.
   * Path safety is validated at config load before any provider/model request.
   *
   * Only admitted in v2 configs (version: 2). In v1 configs this field is ignored.
   */
  llm?: V2LlmActionConfig;
  /**
   * pi-experiment-0njv: Resolved prompt provenance for this v2 LLM action.
   *
   * Populated by ConfigLoader.resolveV2LlmPromptProvenance() after path admission.
   * Records normalized path, byteCount, sha256 digest, and actionId.
   * The prompt BODY is NEVER stored here (AC4: no body inlining).
   * Absent for non-LLM actions and v1 configs.
   */
  v2PromptProvenance?: V2PromptFileProvenance;
  /**
   * pi-experiment-hutg: v2 action route-event emits mapping.
   *
   * Config-owned mapping from deterministic TypeScript verdicts (pass/fail/blocked/
   * preconditionFailed) to declared v2 event names. The route event name is chosen
   * ONLY by (configured mapping + deterministic TS verdict). Tool stdout/stderr,
   * LLM prose, and model-provided args MUST NEVER choose the route.
   *
   * Only valid on tool/verifier actions. Declaring emits on an LLM action (with an
   * `llm` block) is a STARTUP FAILURE — LLM actions cannot choose workflow routes.
   *
   * All event names must be in the declared v2 vocabulary. Startup rejects refs
   * to undeclared events. If the action requires artifacts and preconditionFailed
   * is absent, startup also rejects the action.
   *
   * Only admitted in v2 configs (version: 2). In v1 configs this field is ignored.
   */
  emits?: ActionEmitsMapping;
}

export type ActionDefinition = TeammateAction;

/**
 * State-level context policy declaration (pi-experiment-6q0y.44).
 *
 * Inline form: `contextPolicy: freshSubagent`  (string shorthand for the enum value).
 * Structured form: `contextPolicy: { mode: namedContinuation, contextKey: "planContext" }`.
 *
 * The default for any state that omits this field is `freshSubagent` — a new
 * isolated sub-agent context.  Named continuation states must supply a
 * `contextKey` so the coordinator can resolve and thread the continuation
 * anchor into the spawn.
 */
export type StateContextPolicyMode = StateContextPolicy | string;

export interface StateContextPolicyConfig {
  /**
   * The context mode for this state.
   * 'freshSubagent'     — fresh isolated sub-agent (default when absent).
   * 'namedContinuation' — continue a named prior-state context.
   */
  mode: StateContextPolicyMode;
  /**
   * Stable key naming the context to continue.
   * Required when mode = 'namedContinuation'; ignored for freshSubagent.
   * Must be a non-empty string containing only alphanumeric, dash, and underscore characters.
   */
  contextKey?: string;
  /**
   * Stable key under which this state's Pi session is stored so a subsequent
   * namedContinuation state can resume it (pi-experiment-6q0y.44 write-side).
   *
   * When set the coordinator spawns this state's worker with a persistent Pi
   * session (omitting --no-session) and stores the resolved session path in
   * contextKeyStore under this key.  A later state declaring
   * contextPolicy: { mode: namedContinuation, contextKey: <same key> } then
   * receives --session <path> at spawn time.
   *
   * Must satisfy the same character constraints as contextKey.
   * Ignored when mode = 'namedContinuation' (consumers don't produce).
   */
  producesContextKey?: string;
}

/**
 * The contextPolicy field on a state may be the string shorthand (mode only)
 * or the structured form with mode + contextKey.
 */
export type StateContextPolicyDeclaration = StateContextPolicyMode | StateContextPolicyConfig;

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
  /**
   * pi-experiment-w2tz: Optional reference to a named state profile in
   * profiles.states. When set, the named profile's allowlisted fields are
   * applied after defaults and before local overrides.
   * Precedence: defaults < profile < local.
   * Only valid in v2 configs (version: 2). Startup fails if the profile is unknown.
   */
  profile?: string;
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
  /**
   * Explicit set of tool names active for this state.
   * When absent, all tools in config.tools are considered active (default behavior,
   * identical to today's full exposure).
   * When present, only the named tools are exposed to the teammate for this state.
   * Action-level activeTools further narrows this set for individual actions.
   * Resolved by ActiveToolSetResolver — unknown names fail startup lint.
   */
  activeTools?: string[];
  /**
   * State-level tool prompt profile selection (pi-experiment-6q0y.4).
   *
   * When set, this profile specializes tool descriptions in the assembled prompt
   * for all actions in this state (unless an action overrides with its own
   * toolPromptProfile). Overrides settings.toolPromptProfile.
   * Must reference a key in settings.toolPromptProfiles.
   */
  toolPromptProfile?: string;
  /**
   * State-level context policy (pi-experiment-6q0y.44).
   *
   * Declares how this state's worker context is handled at spawn time.
   *
   * Shorthand (mode only): `contextPolicy: freshSubagent`
   * Structured (mode + key): `contextPolicy: { mode: namedContinuation, contextKey: "planCtx" }`
   *
   * Default when absent: freshSubagent — a fresh isolated sub-agent context is spawned.
   * This default ensures cerdiwen and other consumers that do not declare a
   * contextPolicy are unaffected by the policy machinery.
   *
   * When mode = namedContinuation, contextKey is required: it names the stable
   * context anchor the coordinator threads into the spawn.  ConfigLoader rejects
   * namedContinuation without a contextKey at startup.
   */
  contextPolicy?: StateContextPolicyDeclaration;
  /**
   * State-level prompt-budget policy (pi-experiment-6q0y.17).
   *
   * When present, all actions in this state inherit this budget unless the
   * action declares its own promptBudget (action > state > settings, AC3).
   * Absent means no per-state limit — falls back to settings.promptBudget.
   */
  promptBudget?: PromptBudgetPolicy;
  /**
   * State-level runtime budget policy (pi-experiment-6q0y.48).
   *
   * When present, all actions in this state inherit this runtime budget unless
   * the action declares its own runtimeBudget (action > state > settings, AC2).
   * Absent means no per-state runtime limit — falls back to settings.runtimeBudget.
   */
  runtimeBudget?: RuntimeBudgetPolicy;
  /**
   * Per-route required-tool evidence (pi-experiment-6q0y.46).
   *
   * Declares required tool evidence for specific route events (advance AND
   * terminal transitions). When a bead signals the named route, the coordinator
   * gate evaluates these required tools against durable tool-result events +
   * registered verify() callbacks BEFORE applying the transition. A route event
   * admitted without the declared evidence is REJECTED and a ROUTE_ADMISSION_REJECTED
   * domain event is recorded — no raw prose bodies, only identity + missing IDs.
   *
   * Keys are outcome names (case-insensitive match against the route event).
   * Values are RequiredTool arrays — same form as state/action-level requiredTools.
   *
   * Example:
   *   routeEvidence:
   *     SUCCESS:
   *       - name: verify_build
   *         expectsVerify: true
   *
   * AC1 (6q0y.46): admission is rejected when any listed tool is absent or its
   *   verify() returns FAIL.
   * AC4 (6q0y.46): enforced for EVERY advance AND terminal route event, not just
   *   Cerdiwen `completed`.
   * AC5 (6q0y.46): startup lint reports required tools per route and fails if any
   *   tool with expectsVerify:true has no registered verify() callback.
   */
  routeEvidence?: Record<string, RequiredTool[]>;
}

export interface HarnessConfig {
  /**
   * pi-experiment-202g: Config schema version.
   * When set to 2, the loader validates the document against v2 admission rules
   * and rejects removed v1 fields with path-specific diagnostics.
   * Absent → v1 behavior (backward-compatible).
   * Any value other than 2 → fail closed (unknown version).
   */
  version?: 2;
  /**
   * pi-experiment-cfzu: v2 category-first event vocabulary.
   * Declared when version: 2. Each event name appears in exactly one category.
   * Categories are TAXONOMY ONLY — no routing fallback from category membership.
   * A state routes an event only when it declares an exact transition key for it.
   * Absent (v1 configs) → unaffected; v1 outcome/transition resolution is unchanged.
   */
  events?: V2EventsConfig;
  /**
   * pi-experiment-w2tz: v2 same-file defaults block.
   *
   * defaults.state — applied to every state as the lowest-priority base before
   *   any profile or local override.
   * defaults.tool  — applied to every tool as the lowest-priority base.
   *
   * Only allowlisted non-routing fields are permitted in defaults blocks.
   * Routing fields (transitions, actions, routeEvidence, etc.) are rejected at startup.
   * Version-gated: only processed when version: 2.
   */
  defaults?: V2DefaultsConfig;
  /**
   * pi-experiment-w2tz: v2 same-file profiles block.
   *
   * profiles.states — named state profiles keyed by profile ID. A state can
   *   reference one profile via its `profile` field (string). The profile is
   *   expanded with precedence: defaults < profile < local override.
   * profiles.tools  — named tool profiles keyed by profile ID. A tool can
   *   reference one profile via its `profile` field (string, existing tool field).
   *
   * Only allowlisted non-routing fields are permitted in profile entries.
   * Unknown profiles, cycles, and non-compressible fields cause startup failures.
   * Version-gated: only processed when version: 2.
   */
  profiles?: V2ProfilesConfig;
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
     * Named per-tool prompt profile declarations (pi-experiment-6q0y.4).
     *
     * Each entry maps a profile name to an array of per-tool text overrides.
     * The selected profile replaces individual tool descriptions in the assembled
     * prompt; tools with no override in the selected profile retain their default
     * `description`. Startup lint enforces unknown-tool, unknown-profile-ID,
     * duplicate-entry, volatile-template, and 700-char constraints.
     */
    toolPromptProfiles?: ToolPromptProfilesConfig;
    /**
     * Settings-level default tool prompt profile selection (pi-experiment-6q0y.4).
     *
     * When set, this profile is applied to all states/actions that do not
     * declare their own toolPromptProfile. State and action-level declarations
     * override this default. Must reference a key in settings.toolPromptProfiles.
     */
    toolPromptProfile?: string;
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
    /**
     * Settings-level (global) prompt-budget policy (pi-experiment-6q0y.17).
     *
     * Lowest-precedence budget limit — applies to all states/actions that do not
     * declare their own promptBudget. When absent, no limit is enforced anywhere
     * (full no-op, AC1). State and action-level declarations override this.
     */
    promptBudget?: PromptBudgetPolicy;
    /**
     * Settings-level (global) runtime budget policy (pi-experiment-6q0y.48).
     *
     * Lowest-precedence runtime budget — applies when no state or action policy
     * is configured. When absent, no runtime enforcement anywhere (full no-op,
     * AC1). State and action-level runtimeBudget declarations override this.
     */
    runtimeBudget?: RuntimeBudgetPolicy;
    /**
     * pi-experiment-6q0y.17 AC7(b): Named per-state budget overrides keyed by
     * state ID. Startup lint rejects any key that does not match a declared state.
     * Precedence: lower than state.promptBudget (direct declaration wins), higher
     * than settings.promptBudget (global). Enables AC7(b): a budget that REFERENCES
     * a state by name, so an unknown reference is a detectable, rejectable error.
     */
    promptBudgetStateOverrides?: Record<string, PromptBudgetPolicy>;
    /**
     * pi-experiment-6q0y.17 AC7(b): Named per-action budget overrides keyed by
     * "stateId/actionId". Startup lint rejects any key whose state segment is not a
     * declared state, or whose action segment is not a declared action in that state.
     * Precedence: lower than action.promptBudget (direct declaration wins), higher
     * than settings.promptBudgetStateOverrides and settings.promptBudget.
     */
    promptBudgetActionOverrides?: Record<string, PromptBudgetPolicy>;
    /**
     * Always-on structural loop detection (pi-experiment-6q0y.49).
     *
     * Detection cannot be disabled; this config only adjusts thresholds.
     * When absent, all scopes use maxLoops=10 and route=FAILURE.
     * Startup lint (AC4) rejects: maxLoops<1, unknown scopes, unknown route
     * events, and route events absent from the declared statechart vocabulary.
     */
    loopDetection?: LoopDetectionConfig;
    /**
     * Default tool-payload budget applied to all tools that do not declare an
     * explicit per-tool budget (pi-experiment-6q0y.18).
     *
     * Absent = no limit enforced anywhere (full no-op, AC2). Per-tool declarations
     * in toolPayloadBudgetByTool override this default for specific tools.
     */
    toolPayloadBudget?: ToolPayloadBudgetPolicy;
    /**
     * Per-tool tool-payload budget overrides keyed by tool name
     * (pi-experiment-6q0y.18 AC4).
     *
     * Takes precedence over settings.toolPayloadBudget (default).
     * Startup lint (AC7) rejects keys that do not match a declared tool name
     * and routes absent from the statechart vocabulary.
     */
    toolPayloadBudgetByTool?: Record<string, ToolPayloadBudgetPolicy>;
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
 * v2 category-first event vocabulary (pi-experiment-cfzu).
 *
 * Declared at the top-level `events` key in harness.yaml when version: 2.
 * Each event name is canonical (UPPER_SNAKE_CASE pattern) and appears in
 * exactly one category after case-insensitive normalization.
 *
 * Categories are TAXONOMY ONLY: category membership never supplies a
 * default transition, terminal/failure route, or fallback status. A state
 * routes an event ONLY when it declares an exact transition for the
 * canonical event name.
 */
export interface V2EventsConfig {
  /** Advance-category event names (taxonomy only — no routing fallback). */
  advance?: string[];
  /** Failure-category event names (taxonomy only — no routing fallback). */
  failure?: string[];
  /** Blocked-category event names (taxonomy only — no routing fallback). */
  blocked?: string[];
  /** Neutral-category event names (taxonomy only — no routing fallback). */
  neutral?: string[];
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
 *
 * v1 fields (used when version is absent):
 *   initialState   — override for the initial state.
 *   terminalStates — list of terminal state IDs.
 *
 * v2 fields (used when version: 2 — v1 fields are rejected in v2 configs):
 *   initial  — names the single runnable start state.
 *   terminal — lists terminal sink names that must not also be runnable states.
 */
export interface StatechartConfig {
  /** v1: Override for the initial state (mirrors settings.startState; settings wins). */
  initialState?: string;
  /**
   * v1: State IDs that are considered terminal (workflow is done when reached).
   * Required when the block is present; defaults to ['completed'] when absent.
   */
  terminalStates: string[];
  /**
   * v2: Names the single runnable start state.
   * pi-experiment-202g: Used in version:2 configs instead of v1 initialState.
   */
  initial?: string;
  /**
   * v2: Lists terminal sink names that must not also be runnable states.
   * pi-experiment-202g: Used in version:2 configs instead of v1 terminalStates.
   */
  terminal?: string[];
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

// ── pi-experiment-w2tz: v2 defaults/profiles ─────────────────────────────────

/**
 * Allowlisted non-routing fields that may be supplied via defaults or profiles
 * for STATES (AC3). Any field name outside this set is rejected at startup
 * (unknown-allowlist-field diagnostic).
 *
 * Policy: ergonomic execution + prompt-surface defaults ONLY.
 * Routing fields (transitions, emitters, gate selection, etc.) are
 * explicitly excluded — see NON_COMPRESSIBLE_STATE_FIELDS below.
 */
export const ALLOWLISTED_STATE_FIELDS = new Set<string>([
  // Execution timeouts
  'thinking',
  'llmProvider',
  'model',
  // Context policy (how a state's worker context is handled)
  'contextPolicy',
  // Prompt-surface: prompt profile selection
  'toolPromptProfile',
  // Runtime budget
  'runtimeBudget',
  // Prompt budget
  'promptBudget',
  // Default action context mode
  'defaultActionContextMode',
  // Context rotation threshold
  'contextRotThreshold',
  // Max context tokens
  'maxContextTokens',
  // Handover required
  'handoverRequired',
]);

/**
 * Allowlisted non-routing fields that may be supplied via defaults or profiles
 * for TOOLS (AC3). Any field outside this set is rejected at startup.
 */
export const ALLOWLISTED_TOOL_FIELDS = new Set<string>([
  // Execution configuration
  'cwd',
  'allowCwdOverride',
  'timeoutMs',
  'wrapperTimeoutMs',
  'argsMode',
  'allowArgs',
  'acceptMaxBuffer',
  'successExitCodes',
  'env',
  // Serialization
  'serialize',
  // Failure limit
  'failureLimit',
  // Argument path scope
  'argumentPathScope',
]);

/**
 * Non-compressible workflow fields for STATES that must NEVER appear in
 * defaults.state or profiles.states entries (AC4). Presence of any of these
 * in a default/profile block causes a startup-fatal rejection with source-path
 * diagnostics naming the offending field.
 *
 * These are the routing/statechart fields whose visibility must remain LOCAL
 * to each state definition — hiding them behind inheritance would make the
 * workflow semantics invisible.
 */
export const NON_COMPRESSIBLE_STATE_FIELDS = new Set<string>([
  // Transition routing table
  'transitions',
  'on', // v1 transition map (also non-compressible)
  // Route evidence (verifier route mappings)
  'routeEvidence',
  // Prompt file paths (must be locally visible per 0njv)
  // NOTE: promptFile is an llm sub-field; we check for the llm block itself
  // Terminal state declaration is a statechart concern, not a state field
  // Gate selection / guard
  // Actions block (statechart execution graph)
  'actions',
  // Required tools (artifact gate — route affects workflow)
  'requiredTools',
  // Identity is structurally required per state
  'identity',
  // Skills (per-state required skill set)
  'requiredSkills',
  // Active tools (route-affecting tool set)
  'activeTools',
  // llm block contains promptFile — must stay local per 0njv
  'llm',
]);

/**
 * Non-compressible fields for TOOLS (AC4). Must stay LOCAL to each tool def.
 */
export const NON_COMPRESSIBLE_TOOL_FIELDS = new Set<string>([
  // Tool identity / type
  'name',
  'type',
  'command',
  'defaultArgs',
  // Validation rules (tool-specific gate logic)
  'validationRules',
  // Optional (tool presence contract)
  'optional',
  // Side effect contract (safety contract — must be explicitly stated)
  'sideEffectContract',
  // Retry policy (tool-specific)
  'retryPolicy',
  // Profile reference (resolved by expandToolProfiles — not inheritable via defaults/profiles)
  'profile',
  // Probe context (safety-critical, must be explicit)
  'probeContext',
  // Observe only (tool type contract)
  'observeOnly',
  // Cacheable
  'cacheable',
  // Max consecutive failures
  'maxConsecutiveFailures',
  // Description (tool identity surface)
  'description',
  // Usage notes
  'usageNotes',
]);

/**
 * pi-experiment-w2tz: v2 state-level defaults block.
 *
 * Fields declared here are applied to every state as the lowest-priority
 * base before profile and local overrides.
 * Only allowlisted non-routing fields are permitted.
 */
export type V2StateDefaults = Record<string, unknown>;

/**
 * pi-experiment-w2tz: v2 tool-level defaults block.
 *
 * Fields declared here are applied to every tool as the lowest-priority base.
 * Only allowlisted non-routing fields are permitted.
 */
export type V2ToolDefaults = Record<string, unknown>;

/**
 * pi-experiment-w2tz: v2 defaults block (top-level in harness.yaml).
 *
 * defaults.state — applies to every state.
 * defaults.tool  — applies to every tool.
 */
export interface V2DefaultsConfig {
  state?: V2StateDefaults;
  tool?: V2ToolDefaults;
}

/**
 * pi-experiment-w2tz: a single state profile entry.
 *
 * Keyed by profile ID in profiles.states.<id>.
 * Only allowlisted non-routing fields are permitted.
 */
export type V2StateProfile = Record<string, unknown>;

/**
 * pi-experiment-w2tz: a single tool profile entry.
 *
 * Keyed by profile ID in profiles.tools.<id>.
 * Only allowlisted non-routing fields are permitted.
 */
export type V2ToolProfile = Record<string, unknown>;

/**
 * pi-experiment-w2tz: v2 profiles block (top-level in harness.yaml).
 *
 * profiles.states — map of named state profile objects keyed by profile ID.
 * profiles.tools  — map of named tool profile objects keyed by profile ID.
 */
export interface V2ProfilesConfig {
  states?: Record<string, V2StateProfile>;
  tools?: Record<string, V2ToolProfile>;
}

/**
 * Source-path record for a single resolved field.
 * Used by config-explain diagnostics to name WHERE each field came from.
 */
export interface V2FieldSource {
  /** Field name. */
  field: string;
  /** Where the resolved value came from: 'default' | 'profile:<id>' | 'local'. */
  source: string;
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
