/**
 * Internal constants for the projectTools plugin modules.
 * Package-internal — do not import from outside src/plugins/.
 */

export const DEFAULT_MCP_CONFIG_PATH = '{{projectRoot}}/.pi/mcp/config.json';
export const MCP_SERVER_CONFIG_KEY = 'mcpServers';
export const LEGACY_MCP_SERVER_CONFIG_KEY = 'mcp-servers';
export const MCP_SSE_TRANSPORT = 'sse';
export const COMMAND_STDOUT_FILE_NAME = 'stdout.log';
export const COMMAND_STDERR_FILE_NAME = 'stderr.log';

export const ProjectToolResultKey = {
  TOOL_CALLS: 'toolCalls',
  FRAMEWORK_TOOL_CALLS: 'frameworkToolCalls',
  STDOUT: 'stdout',
  STDERR: 'stderr',
  MATCH_STATUS: 'matchStatus',
  FAILURE_CATEGORY: 'failureCategory',
  REMEDIATION: 'remediation',
  OUTPUT_ACCESS: 'outputAccess',
  OUTPUT_ARCHIVE: 'outputArchive',
  RESULT_PREVIEW: 'resultPreview',
  DIAGNOSTIC_PREVIEW: 'diagnosticPreview',
  STRUCTURED_RESULT: 'structuredResult',
  NEXT_ACTION: 'nextAction',
  RECOVERY: 'recovery',
  REJECTED_CHECKS: 'rejectedChecks',
  REJECTED_CHECK_COUNT: 'rejectedCheckCount',
  PASSED_CHECK_COUNT: 'passedCheckCount',
  SCANNED_TARGET_COUNT: 'scannedTargetCount',
  SCANNED_TARGET_SAMPLES: 'scannedTargetSamples'
} as const;

export const StructuredPayloadSummaryKey = [
  'tool',
  'status',
  'success',
  'message',
  'error',
  'artifact',
  'path',
  'server',
  'operation',
  'verdict',
  'blocking_count',
  'total_errors',
  'context_count',
  'findingsDetected',
  'routingHint',
  'exitCode',
  'warnings',
  'outputFilters',
  'stdoutBytes',
  'stderrBytes',
  'stdoutTruncated',
  'stderrTruncated',
  'scannedTargetCount',
  'scanned_target_count',
  'scannedTargetsCount',
  'scanned_targets_count',
  'scannedTargetSamples',
  'scanned_target_samples',
  'filesScanned',
  'files_scanned',
  'scannedFileCount',
  'scanned_file_count',
  'targetsScanned',
  'targets_scanned'
] as const;

export const StructuredPayloadCollectionKey = {
  CHECKS: 'checks',
  ERRORS_BY_TOOL: 'errors_by_tool',
  ERRORS_BY_FILE: 'errors_by_file',
  TOOL_RESULTS: 'tool_results'
} as const;

export const StructuredPayloadIssueKey = [
  'tool',
  'file',
  'line',
  'column',
  'code',
  'message',
  'severity',
  'classification',
  'blocking',
  'hint',
  'policy_reason'
] as const;

export const StructuredPayloadToolResultKey = [
  'tool',
  'success',
  'exit_code',
  'error_count',
  'timed_out'
] as const;

export const StructuredPayloadSummaryOutputKey = {
  ERRORS_BY_TOOL: 'errorsByTool',
  ERRORS_BY_FILE: 'errorsByFile',
  TOOL_RESULTS: 'toolResults'
} as const;

export const PROJECT_TOOL_OUTPUT_ACCESS_GUIDANCE =
  'Archived by harness; artifactRef is an opaque handle, not a path. First decide from resultPreview, structuredResult, and toolCalls. Do not read the archive just because the preview is truncated; rerun with narrower arguments only for a named missing fact or decision blocker.';

export const PROJECT_TOOL_MODEL_CONTRACT = [
  'Configured project tools are the supported route for project-specific command and MCP-backed capabilities.',
  'Do not replace them with shell, native MCP, or native reads of harness artifact paths.',
  'If a PASSED result includes outputArchive.artifactRef or outputAccess text, treat it as archive guidance, not a tool failure. The artifactRef is an opaque harness handle, not a filesystem path; first decide from resultPreview, structuredResult, and toolCalls.',
  'Prefer one narrow project-tool call at a time. If a preview is truncated, a wrapper warning is returned, or a broad codemap/ast_grep call returns too much data, use the available preview/summary/toolCalls first; rerun narrower only for a named missing fact or decision blocker.',
  'The Pi UI native MCP server count reports only Pi-adapter connections. It can show zero while Orr Else MCP-backed project tools are healthy; use the named configured project tool and route BLOCKED only when that tool itself reports unavailable/rejected.'
] as const;

export const PROJECT_TOOL_DESCRIPTION_SUFFIX =
  'Returns bounded inline previews and structured summaries; outputArchive.artifactRef is an opaque harness handle, not a path to read. Decide from resultPreview, structuredResult, and toolCalls before rerunning narrower for a named missing fact.';

export const ARTIFACT_VALIDATOR_TOOL_NAME = 'artifact_validator';
export const AST_GREP_TOOL_NAME = 'ast_grep';
export const CODEMAP_TOOL_NAME = 'codemap';
export const PYTHON_LSP_TOOL_NAME = 'python_lsp';
export const GIT_HISTORY_TOOL_NAME = 'git_history';
export const REFERENCE_DOCS_TOOL_NAME = 'reference_docs';
export const WORKFLOW_PARITY_TOOL_NAME = 'workflow_parity';

// High-volume tool preview budgets (model-facing resultPreview byte caps).
// These constants bound the compact structured summary preview emitted by the
// generic high-volume summarizer so the model never receives a raw truncated dump.
//
// DEFAULT: used for any high-volume tool that does not have a family override.
export const HIGH_VOLUME_RESULT_PREVIEW_MAX_BYTES = 3 * 1024; // 3 KiB
// Codemap structure dumps can include large directory trees — keep the overview
// tight so the model sees the header (Files / Top Extensions) without raw paths.
export const CODEMAP_RESULT_PREVIEW_MAX_BYTES = 2 * 1024; // 2 KiB
// ast_grep match output: each match line is short, so allow slightly more lines.
export const AST_GREP_RESULT_PREVIEW_MAX_BYTES = 3 * 1024; // 3 KiB
// Reference docs / git history / workflow parity: JSON/text blobs that compress
// well into a compact {status, counts, samples} envelope.
export const REFERENCE_DOCS_RESULT_PREVIEW_MAX_BYTES = 3 * 1024; // 3 KiB
export const GIT_HISTORY_RESULT_PREVIEW_MAX_BYTES = 3 * 1024; // 3 KiB
export const WORKFLOW_PARITY_RESULT_PREVIEW_MAX_BYTES = 3 * 1024; // 3 KiB

// Minimum byte size of a result's raw payload that qualifies it as "high-volume"
// and triggers the generic summarizer.  Results below this threshold are not
// worth summarizing — the raw preview already fits within the budget.
export const HIGH_VOLUME_PAYLOAD_MIN_BYTES = 4 * 1024; // 4 KiB

// Generic summarizer representative sample cap: how many entries (lines/items) to
// surface in representativeSamples when the full content would exceed the preview budget.
export const HIGH_VOLUME_SAMPLE_COUNT = 8;

// Recovery guidance template for high-volume summarized tools: directs agents to
// rerun with narrower args / path / range rather than reading the raw archive.
export const HIGH_VOLUME_NARROW_RERUN_RECOVERY =
  'This is a compact summary of a large result. Raw output is preserved in outputArchive. '
  + 'To retrieve a specific section: rerun the same tool with a narrower path, range, symbol, '
  + 'or operation argument. Do not read outputArchive.artifactRef directly — '
  + 'use the narrow-rerun / selector path to fetch only the named missing fact.';

export const UNSUPPORTED_ARTIFACT_VALIDATOR_OUTPUT_CONTROL_FLAGS = new Set<string>([
  '--output-limit'
]);

export const ProjectToolNextAction = {
  RECORD_NO_MATCH: 'record_no_match',
  RERUN_NARROWER: 'rerun_narrower',
  USE_RESULT: 'use_result',
  WAIT_FOR_IN_FLIGHT_RESULT: 'wait_for_in_flight_result',
  ROUTE_CONFIGURED_OUTCOME: 'route_configured_outcome',
  RETRY_ONCE: 'retry_once',
  FIX_ARGUMENTS: 'fix_arguments',
  ROUTE_BLOCKED: 'route_blocked',
  FIX_WORKTREE_STATE: 'fix_worktree_state',
  FIX_OR_ROUTE_FAILURE: 'fix_or_route_failure',
  FETCH_NAMED_OMISSION: 'fetch_named_omission'
} as const;

export const NO_MATCH_STATUS = 'no_match';

export const TRANSIENT_PROJECT_TOOL_FAILURE_PATTERN =
  /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOSPC|timed out|timeout|socket|transport|network|response headers timed out|temporar(?:y|ily))\b/i;

export const TOOL_INPUT_PROJECT_TOOL_FAILURE_PATTERN =
  /\b(?:No valid MCP operation|escapes configured (?:[a-z]+ )?root|invalid argument|bad argument|unknown option|malformed|parse error|missing required|not configured in|unsupported operation)\b/i;

export const WORKTREE_STATE_PROJECT_TOOL_FAILURE_PATTERN =
  /\b(?:dirty worktree|worktree state|outside approved|write set|untracked|unstaged|merge conflict|index lock|permission denied)\b/i;

export const AST_GREP_NO_MATCH_MESSAGE =
  'ast_grep found no matches (exit code 1 with empty output). This is accepted absence evidence only when the pattern is known valid; otherwise adjust the pattern, language, or path and rerun with narrower arguments.';

export const AST_GREP_NO_MATCH_FILTERED_RECOVERY =
  'The ast-grep pattern ran first and the wrapper-side outputFilters post-filtered stdout after the pattern executed. Empty output here means the pattern produced output that was then filtered out — it does NOT mean the pattern found no matches. Treat this as filter-eliminated output, not pattern-no-match. Rerun without the filter or with a narrower filter to see what the pattern matched.';

export const ZERO_TARGET_SCAN_MESSAGE_PREFIX =
  'INSUFFICIENT_EVIDENCE: configured security/evidence scan reported zero scanned targets.';

export const SCAN_TARGET_SAMPLE_LIMIT = 5;
export const INSUFFICIENT_EVIDENCE_NEXT_ACTION = 'insufficient_evidence';

export const COMMAND_TRUNCATION_MARKER_PREFIX = '[truncated ';
export const COMMAND_TRUNCATION_STREAM_MARKER_SUFFIX = ' bytes; full stream archived by harness';
export const COMMAND_TRUNCATION_TEXT_MARKER_SUFFIX = ' characters';

export const COMMAND_STREAM_OUTPUT_KEYS = [ProjectToolResultKey.STDOUT, ProjectToolResultKey.STDERR] as const;
export const COMMAND_DIAGNOSTIC_SECTION_SUFFIX = ' diagnostic';
export const COMMAND_DIAGNOSTIC_LINE_PATTERN = /\b(?:ERROR|FAILED|FAILURES|Traceback|Exception|Error|ImportError|AssertionError|TypeError|NameError|Timeout|timed out)\b|^E\s+/i;
export const COMMAND_DIAGNOSTIC_MAX_MATCH_LINES = 40;
export const COMMAND_DIAGNOSTIC_TAIL_LINES = 25;

export const DIAGNOSTIC_SUMMARY_KEY = 'diagnosticSummary';
export const DIAGNOSTIC_SUMMARY_LOCATION_LIMIT = 3;
export const DIAGNOSTIC_MESSAGE_PREFIX_CHARS = 160;
export const DIAGNOSTIC_TRUNCATION_PATTERN = /\[truncated\b/i;

export const SERIAL_MCP_TOOL_NAMES = new Set([PYTHON_LSP_TOOL_NAME]);
export const SERIAL_MCP_LOCK_STALE_MS = 10 * 60 * 1000;
export const SERIAL_MCP_LOCK_RETRIES = 480;
export const SERIAL_MCP_LOCK_RETRY_MIN_MS = 250;
export const SERIAL_MCP_LOCK_RETRY_MAX_MS = 1000;
export const SERIAL_MCP_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
export const SERIAL_MCP_LOCK_SCOPE = 'project' as const;
export const SERIAL_MCP_LOCK_REASON = 'shared_backend_symbol_operations' as const;

export const ProjectToolParameter = {
  ARGUMENTS: 'arguments',
  ARGV: 'argv',
  CWD: 'cwd',
  CWD_MODE: 'cwdMode'
} as const;

export const PathArgumentConfigKey = {
  ROOT_KIND: 'rootKind',
  ROOT: 'root',
  WORKSPACE_ROOT: 'workspaceRoot',
  VIRTUAL_ROOTS: 'virtualRoots',
  MUST_STAY_INSIDE_ROOT: 'mustStayInsideRoot'
} as const;

export const ProjectToolRootKind = {
  WORKTREE: 'worktree',
  PROJECT: 'project',
  FRAMEWORK: 'framework',
  WORKSPACE: 'workspace'
} as const;

export const PROJECT_TOOL_CONTROL_PARAMETERS = new Set<string>([
  ProjectToolParameter.ARGV,
  ProjectToolParameter.CWD,
  ProjectToolParameter.CWD_MODE
]);

export const MODEL_HIDDEN_RESULT_KEYS = new Set<string>([
  'outputFile',
  'stdoutFile',
  'stderrFile',
  'outputBytes',
  'outputTruncated',
  'outputPreview',
  ProjectToolResultKey.RESULT_PREVIEW,
  ProjectToolResultKey.OUTPUT_ACCESS,
  ProjectToolResultKey.OUTPUT_ARCHIVE,
  ProjectToolResultKey.FRAMEWORK_TOOL_CALLS
]);

export const MODEL_RAW_SUPPRESSED_KEYS = new Set<string>([
  ProjectToolResultKey.STDOUT,
  ProjectToolResultKey.STDERR,
  'output',
  'result'
]);

export const SCAN_TARGET_COUNT_KEYS = [
  'scannedTargetCount',
  'scanned_target_count',
  'scannedTargetsCount',
  'scanned_targets_count',
  'filesScanned',
  'files_scanned',
  'scannedFileCount',
  'scanned_file_count',
  'targetsScanned',
  'targets_scanned'
] as const;

export const SCAN_TARGET_COLLECTION_KEYS = [
  'scannedTargets',
  'scanned_targets',
  'scannedTargetSamples',
  'scanned_target_samples',
  'scannedFiles',
  'scanned_files',
  'targetPaths',
  'target_paths'
] as const;

export const SEMGREP_PATH_COLLECTION_KEYS = [
  'scanned',
  'scannedTargets',
  'scanned_targets'
] as const;

// commandFailureSummarizer patterns
export const CMD_FAIL_TEST_FAILURE_PATTERN =
  /^(?:FAILED|FAIL\s+\S|✗|×|●)\s+(\S+?(?:::\S+)?)\s*(?:-\s*(.+))?$|^(?:FAILED|FAIL)\s+(\S+(?:\s+>\s+\S+)+)/m;

export const CMD_FAIL_TEST_LINE_PATTERN =
  /^(?:FAILED|✗|×|●)\s+(\S+(?:::\S+|\s+>\s+\S+)*)/;

export const CMD_FAIL_PYTEST_SECTION_PATTERN =
  /^_{3,}\s+(\S.+?)\s+_{3,}$/;

export const CMD_FAIL_ASSERTION_PATTERN =
  /^(?:E\s{2,})?([A-Za-z][A-Za-z0-9_]*Error|[A-Za-z][A-Za-z0-9_]*Exception|AssertionError|assert\b)[\s:](.{0,120})/;

export const CMD_FAIL_TRACEBACK_LINE_PATTERN =
  /(?:File\s+"([^"]+)",\s+line\s+(\d+))|(?:^\s+at\s+\S+\s+\(([^)]+):(\d+):\d+\))|(?:^(\S+\.(py|ts|js|tsx|jsx|rb|go|rs|java|cs|cpp|c|h):\d+))/m;

export const CMD_FAIL_LINT_LINE_PATTERN =
  /^(\S[^:]*\.[a-zA-Z]{1,8}):(\d+)(?::\d+)?:?\s+(?:(error|warning|note|info|hint)\s*[:—\-]\s*)?(.{0,180})/i;

export const CMD_FAIL_ESLINT_RULE_PATTERN =
  /^\s{2,}([a-z][\w/.-]{2,50})\s*$/;

export const CMD_FAIL_SEVERITY_WORD_PATTERN =
  /^(error|warning|warn|note|info|hint)\b/i;

export const CMD_FAIL_TIMEOUT_PATTERN =
  /\b(?:timed?\s*out|timeout|ETIMEDOUT|SIGALRM)\b/i;

export const CMD_FAIL_MAX_BUFFER_PATTERN =
  /\b(?:ERR_CHILD_PROCESS_STDIO_MAXBUFFER|maxBuffer|max[_-]?buffer)\b/i;

export const CMD_FAIL_SIGNAL_PATTERN =
  /\b(?:SIGKILL|SIGTERM|SIGABRT|SIGSEGV|killed|signal\s+\d+)\b/i;

export const CMD_FAIL_TRANSPORT_PATTERN =
  /\b(?:ECONNRESET|EPIPE|ENOSPC|transport\s+error|connection\s+reset)\b/i;
