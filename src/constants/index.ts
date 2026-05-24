/**
 * Centralized constants and enums for Orr Else.
 * This file eliminates "magic strings" and provides a single source of truth for standard values.
 */

export const App = {
  NAME: 'orr-else',
  SERVICE_NAME: 'orr-else',
  TRACER_NAME: 'orr-else.core',
  VERSION: '0.1.0'
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
  SUCCESS: 0
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
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
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
  BeadStatus.DEFERRED
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
  ACTION_COMPLETED = 'ACTION_COMPLETED',
  CHECKLIST_ITEM_ADDED = 'CHECKLIST_ITEM_ADDED',
  CHECKLIST_ITEM_TICKED = 'CHECKLIST_ITEM_TICKED',
  CHECKPOINT_SUBMITTED = 'CHECKPOINT_SUBMITTED',
  CONTEXT_COMPACTION_RECORDED = 'CONTEXT_COMPACTION_RECORDED',
  CONTEXT_RESTART_REQUESTED = 'CONTEXT_RESTART_REQUESTED',
  FEATURE_LIST_UPDATED = 'FEATURE_LIST_UPDATED',
  GIT_LOCK_ACQUIRED = 'GIT_LOCK_ACQUIRED',
  GIT_LOCK_RELEASED = 'GIT_LOCK_RELEASED',
  HARNESS_STARTED = 'HARNESS_STARTED',
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
  STATE_TRANSITION_APPLIED = 'STATE_TRANSITION_APPLIED',
  STATE_RUN_INITIALIZED = 'STATE_RUN_INITIALIZED',
  TEAMMATE_EVENT = 'TEAMMATE_EVENT',
  TEAMMATE_PROCESS_EXITED = 'TEAMMATE_PROCESS_EXITED',
  TEAMMATE_SLOT_HEALTH_CHECKED = 'TEAMMATE_SLOT_HEALTH_CHECKED',
  TEAMMATE_SPAWNED = 'TEAMMATE_SPAWNED',
  TEAMMATE_SPAWN_FAILED = 'TEAMMATE_SPAWN_FAILED',
  TEAMMATE_SPAWN_STARTED = 'TEAMMATE_SPAWN_STARTED',
  TOOL_INVOCATION_FAILED = 'TOOL_INVOCATION_FAILED',
  TOOL_INVOCATION_STARTED = 'TOOL_INVOCATION_STARTED',
  TOOL_INVOCATION_SUCCEEDED = 'TOOL_INVOCATION_SUCCEEDED',
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
  ON: 'on'
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
  RESOURCES_DISCOVER = 'resources_discover',
  SESSION_COMPACT = 'session_compact',
  SESSION_SHUTDOWN = 'session_shutdown',
  SESSION_START = 'session_start',
  TOOL_CALL = 'tool_call',
  TOOL_RESULT = 'tool_result',
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
  OPENAI = 'openai'
}

export const DefaultModelName = {
  CLAUDE: 'claude-opus-4-5',
  OPENAI: 'gpt-5.5'
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
  CONFIG_PATH: 'ORR_ELSE_CONFIG',
  API_PORT: 'ORR_ELSE_API_PORT',
  API_BASE: 'ORR_ELSE_API_BASE',
  TRACE_ID: 'PI_TRACE_ID',
  SPAN_ID: 'PI_SPAN_ID',
  SESSION_STATE_ID: 'PI_SESSION_STATE_ID',
  OBSERVABILITY_SESSION_ID: 'PI_OBSERVABILITY_SESSION_ID',
  OBSERVABILITY_FILE_NAME: 'PI_OBSERVABILITY_FILE_NAME',
  WORKER_MODE: 'PI_ORR_ELSE_WORKER',
  LOG_LEVEL: 'LOG_LEVEL'
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
  SIGNAL_COMPLETION = 'signal_completion',
  REQUEST_CONTEXT_RESTART = 'request_context_restart',
  REQUEST_HARNESS_RESTART = 'request_harness_restart',
  GET_ARTIFACT_PATHS = 'get_artifact_paths',
  GET_COMPATIBILITY_CONTEXT = 'get_compatibility_context',
  HARNESS_STATUS = 'harness_status'
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
    '/.pi/tool-output/',
    '.git-harness.lock'
  ]
} as const;

export const SchedulerDefaults = {
  MAX_WAIT_TIME_MS: TimeMs.DAY,
  MAX_EXECUTION_TIME_MS: 4 * TimeMs.HOUR,
  RETRY_PENALTY_WEIGHT: 0.1,
  COMPACTION_PENALTY_WEIGHT: 0.2,
  LOG_TOP_BEAD_COUNT: 5
} as const;

export const ObservabilityDefaults = {
  JSONL_FILE_TEMPLATE: 'traces-{{sessionId}}.jsonl',
  COLLECTOR_TIMEOUT_MS: 5 * TimeMs.SECOND
} as const;

export const OperationalArtifactPath = {
  LEGACY_STATE_DIR: 'state',
  TEMP_DIR: '.tmp',
  PI_EVENTS_DIR: '.pi/events',
  PI_LOGS_DIR: '.pi/logs',
  PI_MAILBOX_DIR: '.pi/mailbox',
  PI_OTEL_DIR: '.pi/otel',
  PI_TOOL_OUTPUT_DIR: '.pi/tool-output'
} as const;

export const EventStoreDefaults = {
  DIR: OperationalArtifactPath.PI_EVENTS_DIR,
  FILE_NAME_TEMPLATE: '{{projectName}}.jsonl',
  PROJECT_NAME_TOKEN: '{{projectName}}'
} as const;

export const EventProjectionDefaults = {
  HANDOVER_PREVIEW_CHARS: 2 * DataSize.KIB,
  FAILURE_HANDOVER_PREVIEW_CHARS: 500
} as const;

export const AgentFailureCode = {
  CONTEXT_LENGTH_EXCEEDED: 'context_length_exceeded',
  USAGE_LIMIT_REACHED: 'usage_limit_reached',
  WEBSOCKET_ERROR: 'websocket error',
  WEBSOCKET_CLOSED: 'websocket closed',
  CONNECTION_RESET: 'connection reset',
  NETWORK_ERROR: 'network error'
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
  INLINE_JSONL_EXPORT_PREVIEW_BYTES: 4 * DataSize.KIB,
  LIST_DEFAULT_LIMIT: 50,
  READY_DEFAULT_LIMIT: 100,
  READY_SCAN_MULTIPLIER: 3,
  READY_SCAN_MIN_LIMIT: 10,
  IN_PROGRESS_RECOVERY_SCAN_MULTIPLIER: 20,
  IN_PROGRESS_RECOVERY_SCAN_MIN_LIMIT: 100,
  TEXT_PREVIEW_CHARS: 500
} as const;

export const StateChartToolDefaults = {
  RECENT_COMPLETED_ACTIONS: 20,
  RECENT_CHECKPOINTS: 5,
  RECENT_TRANSITIONS: 10,
  DETAIL_COMPLETED_ACTIONS: 100,
  DETAIL_CHECKED_ITEMS: 100,
  DETAIL_ADDED_CHECKLIST_ITEMS: 50,
  DETAIL_CHECKPOINTS: 20,
  DETAIL_TRANSITIONS: 40,
  TEXT_PREVIEW_CHARS: 500
} as const;

export const CompatibilityContextDefaults = {
  DOC_FILE_LIMIT: 40,
  AGENT_FILE_LIMIT: 40
} as const;

export const NativeReadPolicyDefaults = {
  MAX_LIMIT_LINES: 400
} as const;

export const ProjectToolDefaults = {
  CALL_DIR_TEMPLATE: '.tmp/tool-calls/{{beadId}}/{{stateId}}/{{actionId}}/{{toolName}}/{{toolInvocationId}}',
  TMP_DIR_NAME: 'tmp',
  OUTPUT_DIR_NAME: 'output',
  OUTPUT_FILE_NAME_TEMPLATE: '{{toolName}}-{{toolInvocationId}}.json',
  INLINE_RESULT_BYTES: 64 * DataSize.KIB,
  UNASSIGNED_BEAD_ID: 'unassigned',
  UNSPECIFIED_STATE_ID: 'state',
  UNSPECIFIED_ACTION_ID: 'manual',
  UNSAFE_PATH_SEGMENT_PATTERN: /[^A-Za-z0-9._-]/g
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
  AUTO_RESTART_COMPACTION_COUNT: 2,
  HEARTBEAT_INTERVAL_MS: 10 * TimeMs.SECOND,
  SHUTDOWN_AFTER_SIGNAL_MS: TimeMs.SECOND,
  SHUTDOWN_AFTER_RESTART_MS: 2 * TimeMs.SECOND,
  CHECKLIST_EVIDENCE_PREVIEW_CHARS: 100,
  TOOL_AUDIT_PREVIEW_CHARS: 500,
  EVENT_PREVIEW_CHARS: 2000,
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
