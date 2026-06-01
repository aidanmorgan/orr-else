/**
 * Centralized constants and enums for Orr Else.
 * This file eliminates "magic strings" and provides a single source of truth for standard values.
 */

export const App = {
  NAME: 'orr-else',
  DISPLAY_NAME: 'Orr Else',
  SERVICE_NAME: 'orr-else',
  TRACER_NAME: 'orr-else.core',
  VERSION: '0.1.0',
  COORDINATOR_ID: 'coordinator',
  TURN_ACTION_ID: 'turn',
  UNKNOWN_MODEL: 'unknown'
} as const;

export const TimeMs = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000
} as const;

export const Numeric = {
  DECIMAL_RADIX: 10,
  NANOSECONDS_PER_SECOND: 1_000_000_000n,
  UNIX_SECONDS_MS_THRESHOLD: 10_000_000_000
} as const;

export const CommandExitCode = {
  SUCCESS: 0,
  NO_MATCH: 1
} as const;

export const CommandErrorCode = {
  MAX_BUFFER: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
} as const;

export const DataSize = {
  KIB: 1024,
  MIB: 1024 * 1024
} as const;

export const HttpHeader = {
  CONTENT_TYPE: 'Content-Type',
  CONTENT_LENGTH: 'Content-Length',
  APPLICATION_JSON: 'application/json'
} as const;

export const HttpStatus = {
  OK: 200,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  REQUEST_TIMEOUT: 408,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500
} as const;

/**
 * Global Bead Statuses
 */
export enum BeadStatus {
  READY = 'ready',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  BLOCKED = 'blocked',
  DEFERRED = 'deferred',
  FAILED = 'failed'
}

export enum BeadsIssueStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  CLOSED = 'closed',
  DONE = 'done',
  BLOCKED = 'blocked',
  DEFERRED = 'deferred'
}

export const TERMINAL_BEAD_STATUSES = new Set<string>([
  BeadStatus.COMPLETED,
  BeadStatus.FAILED,
  BeadStatus.BLOCKED,
  BeadStatus.DEFERRED,
  BeadsIssueStatus.CLOSED,
  BeadsIssueStatus.DONE
]);

/**
 * Standard State Machine Events / Outcomes
 */
export enum EventName {
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
  BLOCKED = 'BLOCKED',
  RESTART = 'RESTART',
  HARNESS_RESTART = 'HARNESS_RESTART',
  CONTEXT_RESTART = 'CONTEXT_RESTART'
}

export enum RestartKind {
  HARNESS = 'harness',
  CONTEXT = 'context'
}

export enum MergeAndCommitStatus {
  STARTED = 'started',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed'
}

export enum DomainEventName {
  AGENT_TURN_FAILED = 'AGENT_TURN_FAILED',
  ASSIGNMENT_FAILED = 'ASSIGNMENT_FAILED',
  BEADS_COMMAND_FAILED = 'BEADS_COMMAND_FAILED',
  BEADS_COMMAND_STARTED = 'BEADS_COMMAND_STARTED',
  BEADS_COMMAND_SUCCEEDED = 'BEADS_COMMAND_SUCCEEDED',
  BEAD_CLAIMED = 'BEAD_CLAIMED',
  BEAD_CLOSED = 'BEAD_CLOSED',
  BEAD_CREATED = 'BEAD_CREATED',
  BEAD_METADATA_MERGED = 'BEAD_METADATA_MERGED',
  BEAD_RELEASED = 'BEAD_RELEASED',
  BEAD_STATUS_UPDATED = 'BEAD_STATUS_UPDATED',
  BEAD_TOMBSTONED = 'BEAD_TOMBSTONED',
  ACTION_COMPLETED = 'ACTION_COMPLETED',
  CHECKLIST_ITEM_ADDED = 'CHECKLIST_ITEM_ADDED',
  CHECKLIST_ITEM_TICKED = 'CHECKLIST_ITEM_TICKED',
  CHECKPOINT_SUBMITTED = 'CHECKPOINT_SUBMITTED',
  CONTEXT_COMPACTION_RECORDED = 'CONTEXT_COMPACTION_RECORDED',
  CONTEXT_RESTART_REQUESTED = 'CONTEXT_RESTART_REQUESTED',
  FEATURE_LIST_UPDATED = 'FEATURE_LIST_UPDATED',
  GIT_LOCK_ACQUIRED = 'GIT_LOCK_ACQUIRED',
  GIT_INDEX_UNSTAGED = 'GIT_INDEX_UNSTAGED',
  GIT_LOCK_RELEASED = 'GIT_LOCK_RELEASED',
  HARNESS_STARTED = 'HARNESS_STARTED',
  HARNESS_API_BOUND = 'HARNESS_API_BOUND',
  HARNESS_STOPPED = 'HARNESS_STOPPED',
  HARNESS_RESTART_REQUESTED = 'HARNESS_RESTART_REQUESTED',
  HARNESS_CAPACITY_LIMIT_REACHED = 'HARNESS_CAPACITY_LIMIT_REACHED',
  HEARTBEAT_RECORDED = 'HEARTBEAT_RECORDED',
  MAILBOX_MESSAGE_DELETED = 'MAILBOX_MESSAGE_DELETED',
  MAILBOX_MESSAGE_SENT = 'MAILBOX_MESSAGE_SENT',
  MERGE_AND_COMMIT_FAILED = 'MERGE_AND_COMMIT_FAILED',
  MERGE_AND_COMMIT_STARTED = 'MERGE_AND_COMMIT_STARTED',
  MERGE_AND_COMMIT_SUCCEEDED = 'MERGE_AND_COMMIT_SUCCEEDED',
  PLUGIN_FILE_CREATED = 'PLUGIN_FILE_CREATED',
  PROGRESS_FILE_INITIALIZED = 'PROGRESS_FILE_INITIALIZED',
  PROGRESS_LOG_APPENDED = 'PROGRESS_LOG_APPENDED',
  PROJECT_TOOL_FAILED = 'PROJECT_TOOL_FAILED',
  PROJECT_TOOL_OUTPUT_DIR_PREPARED = 'PROJECT_TOOL_OUTPUT_DIR_PREPARED',
  PROJECT_TOOL_STARTED = 'PROJECT_TOOL_STARTED',
  PROJECT_TOOL_SUCCEEDED = 'PROJECT_TOOL_SUCCEEDED',
  SHIP_POST_REVIEW = 'SHIP_POST_REVIEW',
  SIGNAL_ACKNOWLEDGED = 'SIGNAL_ACKNOWLEDGED',
  SIGNAL_INTENT_RECORDED = 'SIGNAL_INTENT_RECORDED',
  STATE_TRANSITION_APPLIED = 'STATE_TRANSITION_APPLIED',
  STATE_RUN_INITIALIZED = 'STATE_RUN_INITIALIZED',
  TEAMMATE_EVENT = 'TEAMMATE_EVENT',
  TEAMMATE_SIGNAL_FAILED = 'TEAMMATE_SIGNAL_FAILED',
  TEAMMATE_DEAD_PANES_REMOVED = 'TEAMMATE_DEAD_PANES_REMOVED',
  TEAMMATE_CAPACITY_UNDERFILLED = 'TEAMMATE_CAPACITY_UNDERFILLED',
  TEAMMATE_PANE_SCAN_FAILED = 'TEAMMATE_PANE_SCAN_FAILED',
  TEAMMATE_PROCESS_EXITED = 'TEAMMATE_PROCESS_EXITED',
  TEAMMATE_SLOT_HEALTH_CHECKED = 'TEAMMATE_SLOT_HEALTH_CHECKED',
  TEAMMATE_SPAWNED = 'TEAMMATE_SPAWNED',
  TEAMMATE_SPAWN_FAILED = 'TEAMMATE_SPAWN_FAILED',
  TEAMMATE_SPAWN_STARTED = 'TEAMMATE_SPAWN_STARTED',
  TOKEN_USAGE_RECORDED = 'TOKEN_USAGE_RECORDED',
  TOOL_INVOCATION_FAILED = 'TOOL_INVOCATION_FAILED',
  TOOL_INVOCATION_STARTED = 'TOOL_INVOCATION_STARTED',
  TOOL_INVOCATION_SUCCEEDED = 'TOOL_INVOCATION_SUCCEEDED',
  FILE_ACCESS_ATTEMPTED = 'FILE_ACCESS_ATTEMPTED',
  FILE_ACCESS_REJECTED = 'FILE_ACCESS_REJECTED',
  FILE_DELETE_CONVERTED_TO_TRASH = 'FILE_DELETE_CONVERTED_TO_TRASH',
  FILE_MUTATION_REJECTED = 'FILE_MUTATION_REJECTED',
  TRANSACTIONAL_STATE_AUTO_RESTORE_FAILED = 'TRANSACTIONAL_STATE_AUTO_RESTORE_FAILED',
  TRANSACTIONAL_STATE_AUTO_RESTORE_STARTED = 'TRANSACTIONAL_STATE_AUTO_RESTORE_STARTED',
  TRANSACTIONAL_STATE_AUTO_RESTORE_SUCCEEDED = 'TRANSACTIONAL_STATE_AUTO_RESTORE_SUCCEEDED',
  TRANSACTIONAL_STATE_REJECTED = 'TRANSACTIONAL_STATE_REJECTED',
  WORKTREE_CREATE_FAILED = 'WORKTREE_CREATE_FAILED',
  WORKTREE_CREATED = 'WORKTREE_CREATED',
  WORKTREE_EXCLUDES_CONFIGURED = 'WORKTREE_EXCLUDES_CONFIGURED',
  WORKTREE_PROVISIONED = 'WORKTREE_PROVISIONED',
  WORKTREE_REUSED = 'WORKTREE_REUSED',
  WORKTREE_REMOVE_FAILED = 'WORKTREE_REMOVE_FAILED',
  WORKTREE_REMOVE_SKIPPED = 'WORKTREE_REMOVE_SKIPPED',
  WORKTREE_REMOVED = 'WORKTREE_REMOVED',
  WORKLOG_ENTRY_APPENDED = 'WORKLOG_ENTRY_APPENDED'
}

export enum BeadsCliCommand {
  CLOSE = 'close',
  CREATE = 'create',
  IMPORT = 'import',
  UPDATE = 'update'
}

export const MUTATING_BEADS_COMMANDS = new Set<string>([
  BeadsCliCommand.CLOSE,
  BeadsCliCommand.CREATE,
  BeadsCliCommand.IMPORT,
  BeadsCliCommand.UPDATE
]);

export enum ToolResultStatus {
  PASSED = 'PASSED',
  REJECTED = 'REJECTED',
  UNAVAILABLE = 'UNAVAILABLE'
}

export enum ToolValidationCondition {
  CALLED = 'called',
  PASSED = 'passed',
  SUCCEEDED = 'succeeded'
}

export enum ToolEvidenceSource {
  EVENT_STORE_COMPLETED_ACTION = 'event-store-completed-action'
}

export enum ExtensionCommandAction {
  STATUS = 'status',
  STOP = 'stop'
}

export enum CliOption {
  CONFIG = '--config',
  BEAD = '--bead',
  MAX_SLOTS = '--max-slots'
}

export const PiCliCommand = {
  PI: 'pi'
} as const;

export const TmuxFormat = {
  FIELD_SEPARATOR: '\t',
  PANE_ID: '#{pane_id}',
  PANE_TITLE: '#{pane_title}',
  PANE_CURRENT_COMMAND: '#{pane_current_command}',
  PANE_START_COMMAND: '#{pane_start_command}',
  PANE_CURRENT_PATH: '#{pane_current_path}',
  PANE_DEAD: '#{pane_dead}'
} as const;

export const TmuxCommand = {
  HAS_SESSION: 'has-session',
  KILL_PANE: 'kill-pane',
  LIST_PANES: 'list-panes',
  LIST_WINDOWS: 'list-windows',
  NEW_SESSION: 'new-session',
  NEW_WINDOW: 'new-window',
  SELECT_LAYOUT: 'select-layout',
  SELECT_PANE: 'select-pane',
  SET_WINDOW_OPTION: 'set-window-option',
  SPLIT_WINDOW: 'split-window'
} as const;

export const TmuxOption = {
  REMAIN_ON_EXIT: 'remain-on-exit'
} as const;

export const TmuxOptionValue = {
  OFF: 'off',
  ON: 'on'
} as const;

export const TeammatePaneCleanupReason = {
  DEAD_TMUX_PANE: 'dead tmux pane cleanup'
} as const;

export enum PiCliFlag {
  EXTENSION = '-e',
  MODEL = '--model',
  NO_EXTENSIONS = '--no-extensions',
  NO_SESSION = '--no-session',
  PROVIDER = '--provider',
  SKILL = '--skill',
  THINKING = '--thinking'
}

export enum PiEventName {
  AGENT_END = 'agent_end',
  BEFORE_AGENT_START = 'before_agent_start',
  BEFORE_PROVIDER_REQUEST = 'before_provider_request',
  RESOURCES_DISCOVER = 'resources_discover',
  SESSION_COMPACT = 'session_compact',
  SESSION_SHUTDOWN = 'session_shutdown',
  SESSION_START = 'session_start',
  TOOL_CALL = 'tool_call',
  TOOL_RESULT = 'tool_result',
  TURN_START = 'turn_start',
  TURN_END = 'turn_end'
}

export enum ProcessEventName {
  BEFORE_EXIT = 'beforeExit',
  EXIT = 'exit',
  UNCAUGHT_EXCEPTION_MONITOR = 'uncaughtExceptionMonitor',
  UNHANDLED_REJECTION = 'unhandledRejection'
}

export enum NativePiToolName {
  BASH = 'bash',
  EDIT = 'edit',
  FIND = 'find',
  GREP = 'grep',
  LS = 'ls',
  MCP = 'mcp',
  READ = 'read',
  WRITE = 'write'
}

export const DEFAULT_OBSERVED_PI_TOOLS = [
  NativePiToolName.BASH,
  NativePiToolName.EDIT,
  NativePiToolName.FIND,
  NativePiToolName.GREP,
  NativePiToolName.LS,
  NativePiToolName.MCP,
  NativePiToolName.READ,
  NativePiToolName.WRITE
] as const;

export const PiToolPolicyDefaults = {
  DISALLOW_PROJECT_TOOL_FALLBACK: false
} as const;

export const ActionCompletionKey = {
  FIELD_SEPARATOR: '/',
  WORKFLOW_PREFIX: 'workflow',
  STATE_PREFIX: 'state',
  ACTION_PREFIX: 'action'
} as const;

export enum HttpMethod {
  GET = 'GET',
  POST = 'POST'
}

export enum ApiPath {
  EVENTS = '/events',
  HEARTBEAT = '/heartbeat',
  HEARTBEATS = '/heartbeats',
  SIGNAL = '/signal',
  SIGNALS = '/signals'
}

/**
 * Teammate Event Types (Signals)
 */
export enum TeammateEventType {
  TEAMMATE_STARTED = 'TEAMMATE_STARTED',
  STATE_STARTED = 'STATE_STARTED',
  CHECKPOINT_ACCEPTED = 'CHECKPOINT_ACCEPTED',
  STATE_TRANSITIONED = 'STATE_TRANSITIONED',
  STATE_FAILED = 'STATE_FAILED',
  STATE_BLOCKED = 'STATE_BLOCKED',
  CONTEXT_RESTART_REQUESTED = 'CONTEXT_RESTART_REQUESTED',
  HARNESS_RESTART_REQUESTED = 'HARNESS_RESTART_REQUESTED',
  HEARTBEAT = 'HEARTBEAT',
  TEAMMATE_EXITED = 'TEAMMATE_EXITED'
}

export enum TeammateEventDecisionAction {
  ACCEPT = 'accept',
  IGNORE = 'ignore',
  DUPLICATE = 'duplicate'
}

/**
 * Teammate Action Types
 */
export enum ActionType {
  PROMPT = 'prompt',
  CHECKLIST = 'checklist',
  TOOL = 'tool',
  SCRIPT = 'script'
}

export enum ActionContextMode {
  SAME = 'same',
  ONE_SHOT = 'oneShot',
  SUBAGENT = 'subagent'
}

export enum ActionRunContext {
  PARENT = 'parent',
  FRESH = 'fresh'
}

export enum ChecklistItemType {
  MANUAL = 'manual',
  TOOL = 'tool',
  SCRIPT = 'script'
}

export const ChecklistPromptSuffix = {
  MANDATORY: '(MANDATORY)',
  OPTIONAL: '(OPTIONAL)',
  TOOL: '(HARNESS TOOL CHECK)',
  SCRIPT: '(HARNESS SCRIPT CHECK)'
} as const;

export const CHECKLIST_PROMPT_SUFFIXES = Object.values(ChecklistPromptSuffix);

/**
 * Project Tool Types
 */
export enum ProjectToolType {
  COMMAND = 'command',
  EXTENSION = 'extension',
  MCP = 'mcp'
}

/**
 * CWD Modes for Project Tools
 */
export enum CwdMode {
  PROJECT = 'project',
  WORKTREE = 'worktree'
}

/**
 * LLM Thinking Levels
 */
export enum ThinkingLevel {
  OFF = 'off',
  MINIMAL = 'minimal',
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  XHIGH = 'xhigh'
}

export enum ModelProviderKey {
  CLAUDE = 'claude',
  OPENAI = 'openai'
}

export enum LLMProviderName {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  OPENAI_CODEX = 'openai-codex'
}

/**
 * Substring tokens that, when present in a configured provider string, route
 * the teammate to a Pi subscription (OAuth) provider instead of an API-key
 * provider. Matching is case-insensitive. `claude` -> the Anthropic
 * (Claude Pro/Max) OAuth provider; `codex` -> the ChatGPT (Codex) OAuth
 * provider.
 */
export enum SubscriptionProviderToken {
  CLAUDE = 'claude',
  CODEX = 'codex'
}

export const DefaultModelName = {
  CLAUDE: 'claude-opus-4-5',
  OPENAI: 'gpt-5.5'
} as const;

/**
 * Per-request output-token limits applied to provider requests.
 *
 * A Claude Pro/Max subscription admits each request against an included
 * per-request "claim"; the reservation is `input_tokens + max_tokens`. When a
 * teammate request reserves the model's full output budget (Opus 4.5 =
 * 64,000) on top of its system prompt and tool schemas, the reservation can
 * exceed the included claim and spill to overage — which is rejected when the
 * account has no overage credits (`out_of_credits`). Capping max output tokens
 * keeps each request inside the included quota.
 */
export const ProviderRequestLimits = {
  ANTHROPIC_MAX_OUTPUT_TOKENS: 32000,
  // Output headroom preserved when an extended-thinking budget is present;
  // Anthropic requires `budget_tokens < max_tokens`.
  ANTHROPIC_MIN_OUTPUT_HEADROOM: 4096,
  // Anthropic enforces a minimum budget_tokens value of 1024 for extended thinking.
  ANTHROPIC_MIN_THINKING_BUDGET_TOKENS: 1024
} as const;

/**
 * Live Claude Code login reuse.
 *
 * Teammates authenticate to Anthropic with the SAME login the Claude Code app
 * uses, read live from the macOS keychain on every request — never a token
 * snapshot persisted in Pi's auth.json. The keychain item is owned and
 * refreshed by the Claude Code app; Pi only reads it, so the two never fight
 * over OAuth refresh-token rotation.
 *
 * `auth.json` holds a non-secret marker (see CREDENTIAL_MARKER) with a
 * far-future expiry so Pi treats the provider as authenticated and always
 * routes through the live-read `getApiKey` rather than trying to self-refresh.
 */
export const ClaudeCodeAuth = {
  KEYCHAIN_SERVICE: 'Claude Code-credentials',
  CREDENTIAL_MARKER: 'managed-by-claude-code-app',
  MARKER_EXPIRES_MS: 4102444800000
} as const;

/**
 * Environment Variable Names
 */
export const EnvVars = {
  PROJECT_ROOT: 'PI_PROJECT_ROOT',
  BEAD_ID: 'PI_BEAD_ID',
  STATE_ID: 'PI_STATE_ID',
  WORKER_ID: 'PI_WORKER_ID',
  ACTION_ID: 'PI_ACTION_ID',
  WORKTREE_PATH: 'PI_WORKTREE_PATH',
  TOOL_NAME: 'PI_TOOL_NAME',
  TOOL_INVOCATION_ID: 'PI_TOOL_INVOCATION_ID',
  TOOL_CALL_DIR: 'PI_TOOL_CALL_DIR',
  TOOL_OUTPUT_DIR: 'PI_TOOL_OUTPUT_DIR',
  TOOL_OUTPUT_FILE: 'PI_TOOL_OUTPUT_FILE',
  TOOL_TMP_DIR: 'PI_TOOL_TMP_DIR',
  TOOL_WORKING_DIR: 'PI_TOOL_WORKING_DIR',
  LLM_PROVIDER_KEY: 'PI_LLM_PROVIDER_KEY',
  LLM_PROVIDER: 'PI_LLM_PROVIDER',
  LLM_MODEL: 'PI_LLM_MODEL',
  LLM_THINKING: 'PI_LLM_THINKING',
  MAX_OUTPUT_TOKENS: 'ORR_ELSE_MAX_OUTPUT_TOKENS',
  CONFIG_PATH: 'ORR_ELSE_CONFIG',
  API_PORT: 'ORR_ELSE_API_PORT',
  API_BASE: 'ORR_ELSE_API_BASE',
  FRAMEWORK_ROOT: 'ORR_ELSE_FRAMEWORK_ROOT',
  TRACE_ID: 'PI_TRACE_ID',
  SPAN_ID: 'PI_SPAN_ID',
  SESSION_STATE_ID: 'PI_SESSION_STATE_ID',
  OBSERVABILITY_SESSION_ID: 'PI_OBSERVABILITY_SESSION_ID',
  OBSERVABILITY_FILE_NAME: 'PI_OBSERVABILITY_FILE_NAME',
  WORKER_MODE: 'PI_ORR_ELSE_WORKER',
  LOG_LEVEL: 'LOG_LEVEL',
  // Tells the Anthropic SDK to use the 1-hour prompt-cache TTL on cacheable
  // prefix segments. Inter-role handoffs (planner → implementer → reviewer)
  // routinely exceed the 5-minute default TTL; a 1-hour write costs 2× base
  // input but breaks even on a single subsequent read. Default-on for the
  // teammate spawn so multi-hour bead sessions benefit.
  ENABLE_PROMPT_CACHING_1H: 'ENABLE_PROMPT_CACHING_1H'
} as const;

export const ProcessFlag = {
  TRUE: '1'
} as const;

/**
 * Core Framework Control Plane Tools.
 * These are the ONLY tools that are hardcoded into the Orr Else protocol.
 * All other tools are plugins or project-specific configurations.
 */
export enum BuiltInToolName {
  ORR_ELSE = 'orr-else',
  TICK_ITEM = 'tick_item',
  TICK_ITEMS = 'tick_items',
  GET_OUTSTANDING_TASKS = 'get_outstanding_tasks',
  ADD_CHECKLIST_ITEM = 'add_checklist_item',
  SUBMIT_CHECKPOINT = 'submit_checkpoint',
  SUBMIT_REVIEW_ARTIFACT = 'submit_review_artifact',
  SIGNAL_COMPLETION = 'signal_completion',
  REQUEST_CONTEXT_RESTART = 'request_context_restart',
  REQUEST_HARNESS_RESTART = 'request_harness_restart',
  GET_ARTIFACT_PATHS = 'get_artifact_paths',
  QUERY_ARTIFACT = 'query_artifact',
  GET_COMPATIBILITY_CONTEXT = 'get_compatibility_context',
  HARNESS_STATUS = 'harness_status'
}

/**
 * Named projection caps for the query_artifact tool.
 * These are the bounded-result guardrails so agents get counts+samples
 * instead of raw dumps when a selection is too large.
 */
export const ArtifactQueryDefaults = {
  /** Maximum JSON-serialized byte size of a query result before switching
   *  to counts + representative samples. */
  RESULT_MAX_BYTES: 8 * 1024,
  /** Maximum number of representative array items returned when a result
   *  exceeds RESULT_MAX_BYTES. */
  SAMPLE_MAX_ITEMS: 5
} as const;

export enum ReviewArtifactKind {
  SHIP_POST_REVIEW = 'shipPostReview'
}

export enum ReviewArtifactStore {
  EVENT_STORE = 'eventStore'
}

/**
 * System Plugin Tool Names (Internal Plugins)
 * These are standard plugins provided by Orr Else but are NOT core protocol tools.
 */
export enum PluginToolName {
  BD_HEARTBEAT = 'bd_heartbeat',
  BD_READY = 'bd_ready',
  BD_LIST = 'bd_list',
  BD_EXPORT_JSONL = 'bd_export_jsonl',
  BD_IMPORT_JSONL = 'bd_import_jsonl',
  BD_CREATE = 'bd_create',
  BD_GET_BEAD = 'bd_get_bead',
  BD_GET_STATE_CHART = 'bd_get_state_chart',
  BD_CLAIM = 'bd_claim',
  BD_RELEASE = 'bd_release',
  BD_UPDATE_STATUS = 'bd_update_status',
  BD_GET_HEARTBEATS = 'bd_get_heartbeats',
  CREATE_WORKTREE = 'create_worktree',
  REMOVE_WORKTREE = 'remove_worktree',
  MERGE_AND_COMMIT = 'merge_and_commit',
  SEND_MAILBOX_MESSAGE = 'send_mailbox_message',
  CHECK_MAILBOX = 'check_mailbox',
  RUN_QUALITY_CHECKS = 'run_quality_checks',
  COMPRESS_SESSION_LOGS = 'compress_session_logs',
  SPAWN_TEAMMATE = 'spawn_teammate',
  CREATE_NEW_PLUGIN = 'create_new_plugin'
}

export enum MailboxMessageType {
  REQUEST = 'REQUEST',
  INFO = 'INFO',
  BLOCKER = 'BLOCKER',
  STEER = 'STEER'
}

export enum FeatureStatus {
  TODO = 'todo',
  IN_PROGRESS = 'in-progress',
  COMPLETED = 'completed',
  FAILED = 'failed'
}

export const HarnessMetadataKey = {
  CURRENT: 'orr_else',
  LEGACY_MICROMANAGER: 'micromanager'
} as const;

/**
 * System Component Names (for Logging)
 */
export enum Component {
  CORE = 'Core',
  ORR_ELSE = 'OrrElse',
  ORCHESTRATOR = 'Orchestrator',
  SCHEDULER = 'Scheduler',
  SUPERVISOR = 'Supervisor',
  TEAMMATE = 'Teammate',
  FACTORY = 'TeammateFactory',
  SIGNALING = 'SignalingServer',
  OBSERVABILITY = 'Observability',
  BEADS_CLI = 'BeadsCLI',
  GIT = 'Git',
  CODEBASE = 'Codebase',
  QUALITY = 'Quality',
  FLOW = 'FlowManager',
  CONFIG = 'ConfigLoader',
  WORKLOG = 'WorklogManager',
  PROGRESS = 'ProgressManager',
  PROJECT_TOOLS = 'ProjectTools'
}

export const WorktreeDefaults = {
  AUTO_RESTORE_STATE_ID: 'worktree_reuse',
  ROOT_DIR: 'worktrees',
  BRANCH_PREFIX: 'bead/',
  GIT_LOCK_FILE: '.git-harness.lock',
  LOCK_WAIT_MS: TimeMs.SECOND / 2,
  MAX_LOCK_RETRIES: 5,
  TARGET_BRANCH: 'main',
  OPERATIONAL_EXCLUDE_HEADER: '# Orr Else operational artifacts',
  OPERATIONAL_EXCLUDE_PATTERNS: [
    '/PROGRESS.md',
    '/worklogs/',
    '/state/',
    '/.tmp/',
    '/.pi/events/',
    '/.pi/logs/',
    '/.pi/mailbox/',
    '/.pi/otel/',
    '/.pi/.trash/',
    '/.pi/tool-output/',
    '.git-harness.lock',
    // Beads exports JSONL purely as a viewer/interchange artifact. Source of
    // truth lives in `.beads/embeddeddolt/`. Keeping the JSONL out of git
    // removes the systemic merge-conflict pattern around it.
    '/.beads/issues.jsonl'
  ]
} as const;

export const SchedulerDefaults = {
  DEFAULT_WEIGHTS: {
    waitTime: 1.0,
    executionTime: 0.5,
    progress: 2.0,
    penalty: 1.0,
    priority: 1.0,
    restart: 3.0,
    resume: 4.0
  },
  MAX_WAIT_TIME_MS: TimeMs.DAY,
  MAX_EXECUTION_TIME_MS: 4 * TimeMs.HOUR,
  HIGHEST_PRIORITY: 0,
  DEFAULT_PRIORITY: 2,
  LOWEST_PRIORITY: 4,
  RESTART_REQUESTED_SCORE: 1.0,
  RESUMABLE_STATE_SCORE: 1.0,
  RETRY_PENALTY_WEIGHT: 0.1,
  COMPACTION_PENALTY_WEIGHT: 0.2,
  LOG_TOP_BEAD_COUNT: 5
} as const;

export const ObservabilityDefaults = {
  JSONL_FILE_TEMPLATE: 'traces-{{sessionId}}.jsonl',
  COLLECTOR_TIMEOUT_MS: 5 * TimeMs.SECOND,
  SPAN_ATTRIBUTE_MAX_CHARS: 1024
} as const;

export const OperationalArtifactPath = {
  LEGACY_STATE_DIR: 'state',
  TEMP_DIR: '.tmp',
  PI_EVENTS_DIR: '.pi/events',
  PI_LOGS_DIR: '.pi/logs',
  PI_MAILBOX_DIR: '.pi/mailbox',
  PI_OTEL_DIR: '.pi/otel',
  PI_TRASH_DIR: '.pi/.trash',
  PI_ARTIFACTS_DIR: '.pi/artifacts',
  PI_TOOL_OUTPUT_DIR: '.pi/tool-output'
} as const;

export const EventStoreDefaults = {
  DIR: OperationalArtifactPath.PI_EVENTS_DIR,
  FILE_NAME_TEMPLATE: '{{projectName}}.jsonl',
  PROJECT_NAME_TOKEN: '{{projectName}}',
  BEAD_INDEX_DIR: 'by-bead',
  INDEX_FILE_EXTENSION: '.jsonl',
  INDEX_READY_FILE_EXTENSION: '.ready',
  UNSAFE_INDEX_PATH_SEGMENT_PATTERN: /[^A-Za-z0-9._-]/g
} as const;

export const TransactionalStateDefaults = {
  PLAN_CONTRACT_ARTIFACT_ID: 'planContract',
  PRE_PLAN_CONTRACT_STATE_IDS: ['RequirementsAnalysis'],
  GIT_HEAD_REF: 'HEAD',
  GIT_CHECK_IGNORE_SUBCOMMAND: 'check-ignore',
  GIT_QUIET_OPTION: '--quiet',
  GIT_SOURCE_OPTION: '--source',
  GIT_STATUS_MAX_BUFFER_BYTES: 8 * DataSize.MIB,
  PORCELAIN_ENTRY_MIN_LENGTH: 4,
  PORCELAIN_STATUS_WIDTH: 2,
  PORCELAIN_PATH_START_INDEX: 3,
  PORCELAIN_RENAME_STATUS: 'R',
  PORCELAIN_COPY_STATUS: 'C'
} as const;

export const FileMutationPolicyDefaults = {
  READ_OPERATION: 'read',
  WRITE_OPERATION: 'write',
  DELETE_OPERATION: 'delete',
  PROJECT_TOOL_OPERATION: 'project_tool',
  REWRITTEN_DELETE_FLAG: '__orrElseDeleteConverted',
  STDIN_NULL_FLAG: '--stdin-null',
  ARG_SEPARATOR: '--',
  FIND_DELETE_PREDICATE: '-delete',
  FIND_PRINT0_PREDICATE: '-print0',
  FIND_DEPTH_PREDICATE: '-depth',
  GIT_COMMAND: 'git',
  GIT_CHDIR_OPTION: '-C',
  GIT_ADD_SUBCOMMAND: 'add',
  GIT_CLEAN_SUBCOMMAND: 'clean',
  GIT_CHECKOUT_SUBCOMMAND: 'checkout',
  GIT_MV_SUBCOMMAND: 'mv',
  GIT_RESTORE_SUBCOMMAND: 'restore',
  GIT_RM_SUBCOMMAND: 'rm',
  RM_COMMAND: 'rm',
  RMDIR_COMMAND: 'rmdir',
  UNLINK_COMMAND: 'unlink',
  FIND_COMMAND: 'find',
  SUDO_COMMAND: 'sudo',
  ENV_COMMAND: 'env',
  COMMAND_BUILTIN: 'command',
  GLOB_PATTERN: /[*?[\]]/,
  DYNAMIC_SHELL_WORD_PATTERN: /[$`]/,
  SHELL_WRITE_REDIRECT_OPERATORS: ['>', '>>', '>|', '>&'] as const,
  SED_COMMAND: 'sed',
  PERL_COMMAND: 'perl',
  MV_COMMAND: 'mv',
  CP_COMMAND: 'cp',
  TOUCH_COMMAND: 'touch',
  MKDIR_COMMAND: 'mkdir',
  TEE_COMMAND: 'tee',
  TRUNCATE_COMMAND: 'truncate',
  DD_COMMAND: 'dd',
  DD_OUTPUT_PREFIX: 'of=',
  ENV_ASSIGNMENT_PATTERN: /^[A-Za-z_][A-Za-z0-9_]*=/,
  SUDO_VALUE_OPTIONS: ['-C', '-D', '-g', '-h', '-p', '-R', '-r', '-t', '-T', '-U', '-u'] as const,
  SUDO_VALUE_OPTION_PREFIXES: ['-C', '-D', '-g', '-h', '-p', '-R', '-r', '-t', '-T', '-U', '-u'] as const,
  ENV_VALUE_OPTIONS: ['-C', '-S', '-u'] as const,
  ENV_VALUE_OPTION_PREFIXES: ['--chdir=', '--ignore-environment=', '--split-string=', '--unset='] as const,
  COMMAND_BUILTIN_OPTIONS: ['-p'] as const,
  PERL_IN_PLACE_PATTERN: /^-[^-]*i/,
  SED_IN_PLACE_PATTERN: /^-i/,
  SHELL_MUTATION_COMMANDS: ['cp', 'dd', 'mkdir', 'mv', 'perl', 'sed', 'tee', 'touch', 'truncate'],
  SHELL_READ_COMMANDS: ['cat', 'grep', 'head', 'less', 'more', 'rg', 'tail', 'wc'],
  FILE_ARGUMENT_KEYS: [
    'path',
    'paths',
    'file',
    'files',
    'filePath',
    'file_path',
    'target',
    'targetFile',
    'target_file',
    'filename',
    'directory',
    'dir'
  ] as const
} as const;

export const EventProjectionDefaults = {
  HANDOVER_PREVIEW_CHARS: 2 * DataSize.KIB,
  FAILURE_HANDOVER_PREVIEW_CHARS: 500,
  // Write-time hard cap on a handover payload (before it lands in the event
  // log). Anything longer is truncated with a tail marker so the event store
  // and downstream projections don't carry megabyte-scale handovers.
  HANDOVER_WRITE_MAX_BYTES: 8 * DataSize.KIB
} as const;

export const AgentFailureCode = {
  CONTEXT_LENGTH_EXCEEDED: 'context_length_exceeded',
  USAGE_LIMIT_REACHED: 'usage_limit_reached',
  WEBSOCKET_ERROR: 'websocket error',
  WEBSOCKET_CLOSED: 'websocket closed',
  CONNECTION_RESET: 'connection reset',
  NETWORK_ERROR: 'network error',
  RESPONSE_HEADERS_TIMEOUT: 'response headers timed out'
} as const;

export const AgentFailureSummary = {
  CONTEXT_OVERFLOW: 'Agent lifecycle failure: context window exceeded; context restart requested.',
  HARNESS_TRANSIENT: 'Agent lifecycle failure: transient harness transport error; harness restart requested.',
  NO_PROGRESS: 'Agent lifecycle failure: teammate heartbeat continued without non-heartbeat progress; harness restart requested.',
  USAGE_LIMIT: 'Agent lifecycle failure: usage limit reached; harness capacity pause requested.',
  EVENT_STORE_DETAILS: 'Full provider error remains in the event store.'
} as const;

export const EVENT_STORE_ONLY_METADATA_KEYS = [
  'checklists',
  'completedActionIds',
  'dynamicChecklists',
  'handovers'
] as const;

export const BeadsDefaults = {
  MAX_BUFFER_BYTES: 64 * DataSize.MIB,
  CLI_TIMEOUT_MS: 2 * TimeMs.MINUTE,
  // Keep lock recovery below ToolDefaults.WRAPPER_TIMEOUT_MS. If a worker is
  // killed while holding the cross-process bd lock, other teammates must see
  // the lock as stale before their wrapped tool calls hit the 5-minute cap.
  CLI_LOCK_STALE_MS: 45 * TimeMs.SECOND,
  CLI_LOCK_RETRIES: 90,
  CLI_LOCK_RETRY_MIN_MS: 250,
  CLI_LOCK_RETRY_MAX_MS: TimeMs.SECOND / 2,
  INLINE_JSONL_EXPORT_PREVIEW_BYTES: 4 * DataSize.KIB,
  LIST_DEFAULT_LIMIT: 50,
  READY_DEFAULT_LIMIT: 100,
  READY_SCAN_MULTIPLIER: 3,
  READY_SCAN_MIN_LIMIT: 10,
  IN_PROGRESS_RECOVERY_SCAN_MULTIPLIER: 20,
  IN_PROGRESS_RECOVERY_SCAN_MIN_LIMIT: 100,
  TEXT_PREVIEW_CHARS: 500,
  LONG_TEXT_PREVIEW_CHARS: DataSize.KIB
} as const;

export const StateChartToolDefaults = {
  RECENT_COMPLETED_ACTIONS: 12,
  RECENT_CHECKPOINTS: 3,
  RECENT_TRANSITIONS: 5,
  RECENT_HANDOVERS: 2,
  DETAIL_COMPLETED_ACTIONS: 12,
  DETAIL_CHECKED_ITEMS: 6,
  DETAIL_ADDED_CHECKLIST_ITEMS: 6,
  DETAIL_CHECKPOINTS: 3,
  DETAIL_TRANSITIONS: 3,
  DETAIL_HANDOVERS: 2,
  DETAIL_REVIEW_ARTIFACTS: 3,
  TEXT_PREVIEW_CHARS: 180,
  DETAIL_TEXT_PREVIEW_CHARS: 100
} as const;

export const CompatibilityContextDefaults = {
  DOC_FILE_LIMIT: 40,
  AGENT_FILE_LIMIT: 40
} as const;

export const NativeReadPolicyDefaults = {
  MAX_LIMIT_LINES: 400,
  RECOMMENDED_LIMIT_LINES: 200
} as const;

export const ArtifactPathDefaults = {
  DEFAULT_INLINE_BYTES: 2 * DataSize.KIB,
  DEFAULT_TOTAL_INLINE_BYTES: 2 * DataSize.KIB,
  MAX_INLINE_BYTES: 8 * DataSize.KIB,
  MAX_TOTAL_INLINE_BYTES: 8 * DataSize.KIB
} as const;

export const ProjectToolDefaults = {
  CALL_DIR_TEMPLATE: '.tmp/tool-calls/{{beadId}}/{{stateId}}/{{actionId}}/{{toolName}}/{{toolInvocationId}}',
  TMP_DIR_NAME: 'tmp',
  OUTPUT_DIR_NAME: 'output',
  OUTPUT_FILE_NAME_TEMPLATE: '{{toolName}}-{{toolInvocationId}}.json',
  COMMAND_RETURN_BYTES: 4 * DataSize.KIB,
  INLINE_RESULT_BYTES: 4 * DataSize.KIB,
  OUTPUT_PREVIEW_BYTES: DataSize.KIB,
  COMMAND_DIAGNOSTIC_PREVIEW_BYTES: 3 * DataSize.KIB,
  // Hard safety bound for the model-facing resultPreview when a diagnosticSummary
  // is available. Measured in UTF-16 code units (.length) like sibling _BYTES
  // constants. Compact grouped text is typically under 1 KiB; a worst-case
  // 6-group summary with long messages and paths may approach ~1.5 KiB, so the
  // preview can be truncated — the truncation marker is intentionally graceful
  // (non-import groups sort first and survive). Far below the raw diagnostic
  // payload (tens of KiB).
  DIAGNOSTIC_SUMMARY_RESULT_PREVIEW_MAX_BYTES: 2 * DataSize.KIB,
  TOOL_CALL_EXTRACTION_MAX_BYTES: 256 * DataSize.KIB,
  STRUCTURED_SUMMARY_MAX_GROUPS: 6,
  STRUCTURED_SUMMARY_MAX_ITEMS_PER_GROUP: 3,
  STRUCTURED_SUMMARY_TEXT_CHARS: 240,
  UNASSIGNED_BEAD_ID: 'unassigned',
  UNSPECIFIED_STATE_ID: 'state',
  UNSPECIFIED_ACTION_ID: 'manual',
  UNSAFE_PATH_SEGMENT_PATTERN: /[^A-Za-z0-9._-]/g,
  // Per-tool structured summarizer registry caps.
  // Maximum number of affected paths surfaced in a StructuredResult.
  SUMMARIZER_MAX_AFFECTED_PATHS: 10,
  // Maximum number of representative samples surfaced in a StructuredResult.
  SUMMARIZER_MAX_REPRESENTATIVE_SAMPLES: 5,
  // Command failure summarizer caps.
  // Maximum number of distinct test-failure groups surfaced per run.
  COMMAND_FAILURE_MAX_TEST_GROUPS: 8,
  // Maximum number of distinct linter/scanner-failure groups surfaced per run.
  COMMAND_FAILURE_MAX_LINT_GROUPS: 8,
  // Maximum number of representative location strings per group.
  COMMAND_FAILURE_MAX_LOCATIONS_PER_GROUP: 3,
  // Char limit applied to individual message/rule strings before they are stored.
  COMMAND_FAILURE_MESSAGE_CHARS: 200,
  // Char limit applied to a single representative traceback/context line.
  COMMAND_FAILURE_CONTEXT_LINE_CHARS: 160,
  // Bounded-storage / scratch-cleanup constants.
  //
  // ROOT CAUSE: Each project-tool invocation allocates a unique scratch dir at
  //   .tmp/tool-calls/{{beadId}}/{{stateId}}/{{actionId}}/{{toolName}}/{{toolInvocationId}}
  // The harness exports TMPDIR/TMP/TEMP pointing at the `tmp/` sub-directory of
  // that callDir so child processes (e.g. `uv`, Python pip) use it for their
  // caches.  Once persistAndBoundResult() writes the structured JSON output to
  // `output/<name>-<id>.json`, the raw scratch tree (uv-cache, package
  // environments, pip download dirs) is no longer needed by the harness and is
  // never removed.  Repeated reference_docs calls therefore accumulate one full
  // uv-cache/package-env tree per invocation.
  //
  // FIX: after the output JSON is safely persisted, remove only the `tmp/`
  // sub-directory (SCRATCH_DIR_NAME) inside the unique invocation callDir.  The
  // `output/` sub-directory and its JSON artifact are preserved intact.  The
  // callDir itself is also preserved so any future harness code that scans it
  // still finds the output tree.  Cleanup is keyed by toolInvocationId so
  // parallel teammates never touch each other's dirs.
  //
  // SCRATCH_CLEANUP_ENABLED: set to true to activate post-result tmpDir removal.
  SCRATCH_CLEANUP_ENABLED: true,
  // Log one concise summary entry per invocation (bytes reclaimed, dirs removed).
  // Never dumps individual file paths so the log stays bounded.
  SCRATCH_CLEANUP_LOG_SUMMARY: true
} as const;

export const LoggingDefaults = {
  LEVEL: 'info',
  FILE_LEVEL: 'debug',
  DIR: OperationalArtifactPath.PI_LOGS_DIR,
  FILE_NAME_TEMPLATE: 'orr-else-%DATE%.log',
  DATE_PATTERN: 'YYYY-MM-DD',
  TIMESTAMP_FORMAT: 'YYYY-MM-DD HH:mm:ss',
  MAX_FILE_SIZE: '20m',
  MAX_FILES: '14d'
} as const;

export const OperationalLogPath = {
  PROGRESS_FILE: 'PROGRESS.md',
  WORKLOG_DIR: 'worklogs',
  WORKLOG_FILE_SUFFIX: '.log.md'
} as const;

export const MailboxDefaults = {
  DIR: OperationalArtifactPath.PI_MAILBOX_DIR,
  TEAMMATE_SENDER: 'Teammate',
  EMPTY_MESSAGE: 'No new messages.'
} as const;

export const WorkerDefaults = {
  // Safety net only. Telemetry shows this gate has not fired in real runs —
  // LLM-initiated `request_context_restart` is the actual restart driver.
  // Override per project via `settings.contextMonitor.autoRestartCompactionCount`.
  AUTO_RESTART_COMPACTION_COUNT: 2,
  HEARTBEAT_INTERVAL_MS: 10 * TimeMs.SECOND,
  // The signaling server keeps an in-memory liveness snapshot fresh on every
  // heartbeat, but only persists a HEARTBEAT_RECORDED event this often per
  // worker. Stuck-detection still uses the in-memory snapshot.
  HEARTBEAT_RECORD_INTERVAL_MS: 30 * TimeMs.SECOND,
  SIGNAL_REQUEST_TIMEOUT_MS: 30 * TimeMs.SECOND,
  SIGNAL_REQUEST_ATTEMPTS: 3,
  SIGNAL_REQUEST_RETRY_DELAY_MS: 250,
  SHUTDOWN_AFTER_SIGNAL_MS: TimeMs.SECOND,
  SHUTDOWN_AFTER_RESTART_MS: 2 * TimeMs.SECOND,
  CHECKLIST_EVIDENCE_PREVIEW_CHARS: 100,
  TOOL_AUDIT_PREVIEW_CHARS: 500,
  EVENT_PREVIEW_CHARS: 800,
  EVENT_DETAIL_PREVIEW_CHARS: 200,
  EVENT_ARRAY_PREVIEW_ITEMS: 12,
  EVENT_OBJECT_PREVIEW_KEYS: 40,
  UNKNOWN_STATE_ID: 'unknown',
  AUTO_CONTEXT_RESTART_ACTION_ID: 'auto-context-restart',
  INLINE_DYNAMIC_CHECKLIST_SOURCE: 'inline'
} as const;

export const SupervisorDefaults = {
  SLOT_HEALTH_EVENT_INTERVAL_MS: 30 * TimeMs.SECOND,
  STALE_HEARTBEAT_MS: 3 * WorkerDefaults.HEARTBEAT_INTERVAL_MS,
  NO_PROGRESS_TIMEOUT_MS: 15 * TimeMs.MINUTE,
  STARTUP_HEARTBEAT_GRACE_MS: TimeMs.MINUTE * 2,
  CAPACITY_LIMIT_FALLBACK_PAUSE_MS: TimeMs.MINUTE * 10
} as const;

export const TelemetryDefaults = {
  LOOP_DETECTION_WINDOW: 3,
  IMMEDIATE_FAILURE_DURATION_MS: TimeMs.SECOND / 2
} as const;

export const ToolDefaults = {
  // Default hard wall-clock cap enforced around every tool invocation.
  // Configurable per-tool via BaseProjectToolConfig.wrapperTimeoutMs.
  // Catches hangs like the 170-min bd_get_bead and 14-min read observed in
  // production telemetry.
  WRAPPER_TIMEOUT_MS: 5 * TimeMs.MINUTE,
  // Default consecutive-failure cap per (bead, tool). Mirrors 12-factor
  // Factor 9 ("Compact Errors", ~3 attempts). Open circuit short-circuits
  // further invocations until the bead transitions.
  MAX_CONSECUTIVE_FAILURES: 3
} as const;

/**
 * OTEL span attribute keys for project-owned namespaces (orr_else.* and agent.*).
 * gen_ai.* keys (OpenTelemetry GenAI semantic conventions) are NOT aliased here —
 * they are a published spec and must remain as verbatim string literals at their
 * use sites.
 */
export const OtelAttr = {
  // orr_else.* — harness-specific context propagated on every span
  ORR_ELSE_BEAD_ID: 'orr_else.bead_id',
  ORR_ELSE_STATE_ID: 'orr_else.state_id',
  ORR_ELSE_ACTION_ID: 'orr_else.action_id',
  ORR_ELSE_WORKER_ID: 'orr_else.worker_id',
  ORR_ELSE_COST_TOTAL: 'orr_else.cost_total',
  // agent.* — teammate spawn context
  AGENT_BEAD_ID: 'agent.bead_id',
  AGENT_STATE_ID: 'agent.state_id',
  AGENT_WORKER_ID: 'agent.worker_id',
  AGENT_EVENT_TYPE: 'agent.event_type'
} as const;

/**
 * Defaults
 */
export const Defaults = {
  API_PORT: '3000',
  API_HOST: '127.0.0.1',
  MAX_SLOTS: 6,
  LEASE_TTL_MS: TimeMs.HOUR,
  POLL_INTERVAL_MS: 5 * TimeMs.SECOND,
  TEAMMATE_MISSING_REAP_THRESHOLD: 3,
  PROCESS_REAP_INTERVAL_MS: TimeMs.MINUTE,
  LOG_RETENTION_DAYS: 7,
  METADATA_KEY: HarnessMetadataKey.CURRENT,
  TMUX_SESSION: 'orr-else',
  TMUX_COORDINATOR_WINDOW: 'Coordinator',
  TMUX_AGENTS_WINDOW: 'Agents',
  AGENT_PANE_PREFIX: 'orr-else-agent:',
  NODE_PROCESS_COMMAND: 'node',
  PROJECT_EXTENSION_PATH: '.pi/extensions/orr-else.ts'
} as const;
