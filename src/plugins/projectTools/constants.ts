/**
 * Internal constants for the projectTools plugin modules.
 * Package-internal — do not import from outside src/plugins/.
 */

export const DEFAULT_MCP_CONFIG_PATH = '{{projectRoot}}/.pi/mcp/config.json';
export const MCP_SERVER_CONFIG_KEY = 'mcpServers';
export const MCP_SSE_TRANSPORT = 'sse';
export const COMMAND_STDOUT_FILE_NAME = 'stdout.log';
export const COMMAND_STDERR_FILE_NAME = 'stderr.log';
// s3wp.26: raw MCP call-tool result (complete client.callTool payload) is written
// to this file under context.outputDir before the model-facing compact result is built.
export const MCP_RAW_FILE_NAME = 'mcp-raw.json';
// s3wp.26: raw plugin-tool result (complete execute() return value) persisted by the
// wrapPluginTool hook in extension.ts to the per-invocation tool-calls directory.
export const PLUGIN_RAW_FILE_NAME = 'plugin-raw.json';

export const ProjectToolResultKey = {
  TOOL_CALLS: 'toolCalls',
  FRAMEWORK_TOOL_CALLS: 'frameworkToolCalls',
  STDOUT: 'stdout',
  STDERR: 'stderr',
  MATCH_STATUS: 'matchStatus',
  FAILURE_CATEGORY: 'failureCategory',
  REMEDIATION: 'remediation',
  OUTPUT_ACCESS: 'outputAccess',
  // Tool-owned compact text summary of the result (replaces the forbidden generic 'resultPreview').
  // This is tool-owned deterministic compaction of raw output into a bounded text field.
  COMPACT_SUMMARY: 'compactSummary',
  // Tool-owned extracted diagnostic lines (replaces the forbidden generic 'diagnosticPreview').
  // For failed results: semantically extracted error-pattern lines from stderr/stdout.
  DIAGNOSTIC_FACTS: 'diagnosticFacts',
  STRUCTURED_RESULT: 'structuredResult',
  NEXT_ACTION: 'nextAction',
  RECOVERY: 'recovery',
  REJECTED_CHECKS: 'rejectedChecks',
  REJECTED_CHECK_COUNT: 'rejectedCheckCount',
  PASSED_CHECK_COUNT: 'passedCheckCount'
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
  'stderrBytes'
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

export const PROJECT_TOOL_MODEL_CONTRACT = [
  'Configured project tools are the supported route for project-specific command and MCP-backed capabilities.',
  'Do not replace them with shell, native MCP, or native reads of harness artifact paths.',
  'If a PASSED result includes raw-output file references (stdoutFile/stderrFile), treat them as archive guidance, not a tool failure. They are harness file references, not content to inline; first decide from compactSummary, structuredResult, and toolCalls.',
  'Prefer one narrow project-tool call at a time. If a preview is truncated, a wrapper warning is returned, or a broad project-tool call returns too much data, use the available preview/summary/toolCalls first; rerun narrower only for a named missing fact or decision blocker.',
  'The Pi UI native MCP server count reports only Pi-adapter connections. It can show zero while Orr Else MCP-backed project tools are healthy; use the named configured project tool and route BLOCKED only when that tool itself reports unavailable/rejected.'
] as const;

export const PROJECT_TOOL_DESCRIPTION_SUFFIX =
  'Returns compact summaries and structured facts; raw output is referenced via stdoutFile/stderrFile, not inlined. Decide from compactSummary, structuredResult, and toolCalls before rerunning narrower for a named missing fact.';

// 0yt5.17: HIGH_VOLUME_* summarizer caps, FAILURE_REREAD_ARCHIVE_RECOVERY
// steering text, and TOKEN_ESTIMATE_CHARS_PER_TOKEN result-accounting divisor have
// been REMOVED. The harness no longer summarizes, steers, or token-accounts tool
// results; it persists raw to outputFile and passes the tool's result verbatim.

// Output-control flags rejected for ALL project command tools: project-tool
// output is already bounded and archived by the harness, so a model-supplied
// harness output-control flag has no effect (generic, not per-tool).
export const UNSUPPORTED_PROJECT_TOOL_OUTPUT_CONTROL_FLAGS = new Set<string>([
  '--output-limit'
]);

export const ProjectToolNextAction = {
  RECORD_NO_MATCH: 'record_no_match',
  USE_RESULT: 'use_result',
  WAIT_FOR_IN_FLIGHT_RESULT: 'wait_for_in_flight_result',
  ROUTE_CONFIGURED_OUTCOME: 'route_configured_outcome',
  RETRY_ONCE: 'retry_once',
  FIX_ARGUMENTS: 'fix_arguments',
  ROUTE_BLOCKED: 'route_blocked',
  FIX_WORKTREE_STATE: 'fix_worktree_state',
  FIX_OR_ROUTE_FAILURE: 'fix_or_route_failure'
} as const;

export const TRANSIENT_PROJECT_TOOL_FAILURE_PATTERN =
  /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOSPC|timed out|timeout|socket|transport|network|response headers timed out|temporar(?:y|ily))\b/i;

export const TOOL_INPUT_PROJECT_TOOL_FAILURE_PATTERN =
  /\b(?:No valid MCP operation|escapes configured (?:[a-z]+ )?root|invalid argument|bad argument|unknown option|malformed|parse error|missing required|not configured in|unsupported operation)\b/i;

export const WORKTREE_STATE_PROJECT_TOOL_FAILURE_PATTERN =
  /\b(?:dirty worktree|worktree state|outside approved|write set|untracked|unstaged|merge conflict|index lock|permission denied)\b/i;

// 0yt5.16/0yt5.17: the no-match/filtered recovery text, the zero-target-scan
// message prefix, the scan-target sample limit, the insufficient-evidence next
// action, the command-stream truncation markers, the command-stream output keys,
// the command-stream diagnostic-extraction constants, and the diagnostic-summary /
// diagnostic-source-truncation pattern constants have all been REMOVED. The harness
// performs no truncation, diagnostic summarization, or scan-target recognition on
// tool results.

/** tmpdir bucket for serialized MCP project-tool locks. */
export const MCP_TOOL_LOCK_DIR = 'orr-else-mcp-tool-locks';
/** tmpdir bucket for serialized command/tsProjectTool project-tool locks. */
export const COMMAND_TOOL_LOCK_DIR = 'orr-else-command-tool-locks';

export const SERIAL_MCP_LOCK_STALE_MS = 10 * 60 * 1000;
export const SERIAL_MCP_LOCK_RETRIES = 480;
export const SERIAL_MCP_LOCK_RETRY_MIN_MS = 250;
export const SERIAL_MCP_LOCK_RETRY_MAX_MS = 1000;
export const SERIAL_MCP_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
export const SERIAL_MCP_LOCK_SCOPE = 'project' as const;
export const SERIAL_MCP_LOCK_REASON = 'shared_backend_symbol_operations' as const;
// Generic reason for serialized COMMAND/tsProjectTool locks (no MCP backend semantics).
export const SERIAL_TOOL_LOCK_REASON = 'serialized_tool' as const;

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

// MODEL_HIDDEN_RESULT_KEYS: INTERNAL-ONLY keys removed from the model-facing
// payload because they are not part of the tool's result — they are harness
// scratch the executors attach in-process. Everything ELSE on the tool's result
// passes through VERBATIM (0yt5.16/0yt5.17 — no truncation/capping/summarization).
//
//   stdout / stderr: in-process raw text sample retained ONLY for failure
//     classification (classifyProjectToolFailure / stderrHint). Always hidden;
//     the full raw streams live in stdoutFile / stderrFile.
//   stdoutFile / stderrFile: intentionally NOT hidden — raw-output file refs the
//     model should see.
//   stderrHint: intentionally NOT hidden — compact (≤512-char) stderr excerpt the
//     model-facing result carries for failure-classification context.
//   outputFile / outputBytes: internal harness archive handle, always hidden.
//   result: raw MCP callTool payload — always hidden. Complete payload is persisted
//     to mcp-raw.json; the model sees only the file references.
export const MODEL_HIDDEN_RESULT_KEYS = new Set<string>([
  'outputFile',
  'outputBytes',
  ProjectToolResultKey.STDOUT,
  ProjectToolResultKey.STDERR,
  ProjectToolResultKey.OUTPUT_ACCESS,
  ProjectToolResultKey.FRAMEWORK_TOOL_CALLS,
  'result', // s3wp.26: raw MCP callTool payload — always hidden; see mcp-raw.json
  // cosx: raw transport archive references — harness-side evidence only, never model-facing.
  // The raw file lives at context.outputDir/mcp-raw.json and is accessible via the
  // canonical event/evidence path; the model must not see the archive file reference.
  'rawFile',
  'rawBytes',
  'rawChecksum',
]);

// 0yt5.16/0yt5.17: the model raw-suppressed key set, the scan-target / semgrep-path
// recognition key lists, and the command-failure summarizer regex patterns have all
// been REMOVED. The harness no longer recognizes scan-target evidence nor summarizes
// command-failure output into test/lint groups.
