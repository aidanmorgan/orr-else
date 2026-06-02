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

/**
 * Domain types for configured Orr Else states.
 */

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
  inlineResultBytes?: number;
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
  // (e.g. bd_get_bead, codemap, get_artifact_paths) that the LLM otherwise
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
}

export interface ProjectCommandToolConfig extends BaseProjectToolConfig {
  type: ProjectToolType.COMMAND;
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
}

export type RequiredTool = string | ConditionalRequiredTool;

export interface CompatibilityDiscoveryConfig {
  masterRules?: string[];
  ruleDirs?: string[];
  hookDirs?: string[];
  docsDirs?: string[];
  agentDirs?: string[];
}

export interface ArtifactConfig {
  baseDir?: string;
  templates?: Record<string, string>;
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
}

export type ActionDefinition = TeammateAction;

export interface SDLCState {
  id: string;
  identity: AgentIdentity;
  baseInstructions: string;
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
}

export interface HarnessConfig {
  settings: {
    maxConcurrentSlots: number;
    handoverTemplate: string;
    agentTurnTimeoutMs: number;
    teammateNoProgressTimeoutMs?: number;
    processReapIntervalMs: number;
    teamLeadSystemPrompt?: string;
    projectObjective?: string;
    startState?: string;
    workflowVersion?: string;
    harnessRestartEvent: string;
    harnessRestartPrompt?: string;
    contextRestartEvent: string;
    contextRestartPrompt?: string;
    compatibilityMode?: string;
    compatibility?: { modes?: Record<string, CompatibilityDiscoveryConfig> };
    pi?: PiIntegrationConfig;
    eventStore?: { enabled?: boolean; dir?: string; name?: string; fileName?: string };
    contextRestartRequirements?: { rereadFiles?: string[]; requireEvidence?: boolean };
    traceability?: { requirePlanToBead?: boolean; requireBeadToPlan?: boolean; evidenceStore?: string };
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
