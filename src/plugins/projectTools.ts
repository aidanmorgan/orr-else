import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { mkdir, open, readFile, stat, writeFile } from 'fs/promises';
import path from 'path';
import lockfile from 'proper-lockfile';
import { v7 as uuidv7 } from 'uuid';
import type { HarnessConfig } from '../core/ConfigLoader.js';
import { getProjectRoot } from '../core/Paths.js';
import { resolveTemplateString, type TemplateContext } from '../core/PiIntegration.js';
import { ToolCallPathFactory } from '../core/ToolCallPathFactory.js';
import { ProjectToolConfig, ProjectCommandToolConfig, ProjectMcpToolConfig, ProjectToolPathArgumentConfig, ProjectCommandArgumentPathConfig } from '../core/domain/StateModels.js';
import { Logger } from '../core/Logger.js';
import { EventStore, type DomainEvent } from '../core/EventStore.js';
import { isRestartTransition } from '../core/EventUtils.js';
import { Component, ProjectToolType, CwdMode, EnvVars, ToolResultStatus, Defaults, DomainEventName, EventName, WorkerDefaults, CommandExitCode, CommandErrorCode, ProjectToolDefaults, TeammateEventType, ToolDefaults } from '../constants/index.js';

const DEFAULT_MCP_CONFIG_PATH = '{{projectRoot}}/.pi/mcp/config.json';
const MCP_SERVER_CONFIG_KEY = 'mcpServers';
const LEGACY_MCP_SERVER_CONFIG_KEY = 'mcp-servers';
const MCP_SSE_TRANSPORT = 'sse';
const COMMAND_STDOUT_FILE_NAME = 'stdout.log';
const COMMAND_STDERR_FILE_NAME = 'stderr.log';
const ProjectToolResultKey = {
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
const StructuredPayloadSummaryKey = [
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
const StructuredPayloadCollectionKey = {
  CHECKS: 'checks',
  ERRORS_BY_TOOL: 'errors_by_tool',
  ERRORS_BY_FILE: 'errors_by_file',
  TOOL_RESULTS: 'tool_results'
} as const;
const StructuredPayloadIssueKey = [
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
const StructuredPayloadToolResultKey = [
  'tool',
  'success',
  'exit_code',
  'error_count',
  'timed_out'
] as const;
const StructuredPayloadSummaryOutputKey = {
  ERRORS_BY_TOOL: 'errorsByTool',
  ERRORS_BY_FILE: 'errorsByFile',
  TOOL_RESULTS: 'toolResults'
} as const;
const PROJECT_TOOL_OUTPUT_ACCESS_GUIDANCE =
  'Archived by harness; artifactRef is an opaque handle, not a path. First decide from resultPreview, structuredResult, and toolCalls. Do not read the archive just because the preview is truncated; rerun with narrower arguments only for a named missing fact or decision blocker.';
const PROJECT_TOOL_MODEL_CONTRACT = [
  'Configured project tools are the supported route for project-specific command and MCP-backed capabilities.',
  'Do not replace them with shell, native MCP, or native reads of harness artifact paths.',
  'If a PASSED result includes outputArchive.artifactRef or outputAccess text, treat it as archive guidance, not a tool failure. The artifactRef is an opaque harness handle, not a filesystem path; first decide from resultPreview, structuredResult, and toolCalls.',
  'Prefer one narrow project-tool call at a time. If a preview is truncated, a wrapper warning is returned, or a broad codemap/ast_grep call returns too much data, use the available preview/summary/toolCalls first; rerun narrower only for a named missing fact or decision blocker.',
  'The Pi UI native MCP server count reports only Pi-adapter connections. It can show zero while Orr Else MCP-backed project tools are healthy; use the named configured project tool and route BLOCKED only when that tool itself reports unavailable/rejected.'
] as const;
const PROJECT_TOOL_DESCRIPTION_SUFFIX =
  'Returns bounded inline previews and structured summaries; outputArchive.artifactRef is an opaque harness handle, not a path to read. Decide from resultPreview, structuredResult, and toolCalls before rerunning narrower for a named missing fact.';
const ARTIFACT_VALIDATOR_TOOL_NAME = 'artifact_validator';
const AST_GREP_TOOL_NAME = 'ast_grep';
const CODEMAP_TOOL_NAME = 'codemap';
const PYTHON_LSP_TOOL_NAME = 'python_lsp';
const UNSUPPORTED_ARTIFACT_VALIDATOR_OUTPUT_CONTROL_FLAGS = new Set<string>([
  '--output-limit'
]);
export const ProjectToolFailureCategory = {
  BACKPRESSURE: 'backpressure',
  TERMINAL_GATE: 'terminal_gate',
  TRANSIENT_TRANSPORT: 'transient_transport',
  TOOL_INPUT_ERROR: 'tool_input_error',
  UNAVAILABLE: 'unavailable',
  VERIFIER_FAILED: 'verifier_failed',
  WORKTREE_STATE_ERROR: 'worktree_state_error'
} as const;
export type ProjectToolFailureCategory =
  (typeof ProjectToolFailureCategory)[keyof typeof ProjectToolFailureCategory];
const ProjectToolNextAction = {
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
  /**
   * structuredResult is present with decision evidence but its `omissions` field names data
   * that was excluded from the summary.  The agent should fetch the specific missing
   * selector/path/range named in `structuredResult.omissions` rather than running a generic
   * rerun of the whole tool call.
   */
  FETCH_NAMED_OMISSION: 'fetch_named_omission'
} as const;
const NO_MATCH_STATUS = 'no_match';
const TRANSIENT_PROJECT_TOOL_FAILURE_PATTERN =
  /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOSPC|timed out|timeout|socket|transport|network|response headers timed out|temporar(?:y|ily))\b/i;
const TOOL_INPUT_PROJECT_TOOL_FAILURE_PATTERN =
  /\b(?:No valid MCP operation|escapes configured (?:[a-z]+ )?root|invalid argument|bad argument|unknown option|malformed|parse error|missing required|not configured in|unsupported operation)\b/i;
const WORKTREE_STATE_PROJECT_TOOL_FAILURE_PATTERN =
  /\b(?:dirty worktree|worktree state|outside approved|write set|untracked|unstaged|merge conflict|index lock|permission denied)\b/i;
const AST_GREP_NO_MATCH_MESSAGE =
  'ast_grep found no matches (exit code 1 with empty output). This is accepted absence evidence only when the pattern is known valid; otherwise adjust the pattern, language, or path and rerun with narrower arguments.';
const ZERO_TARGET_SCAN_MESSAGE_PREFIX =
  'INSUFFICIENT_EVIDENCE: configured security/evidence scan reported zero scanned targets.';
const SCAN_TARGET_SAMPLE_LIMIT = 5;
const INSUFFICIENT_EVIDENCE_NEXT_ACTION = 'insufficient_evidence';
const COMMAND_TRUNCATION_MARKER_PREFIX = '[truncated ';
const COMMAND_TRUNCATION_STREAM_MARKER_SUFFIX = ' bytes; full stream archived by harness';
const COMMAND_TRUNCATION_TEXT_MARKER_SUFFIX = ' characters';
const COMMAND_STREAM_OUTPUT_KEYS = [ProjectToolResultKey.STDOUT, ProjectToolResultKey.STDERR] as const;
const COMMAND_DIAGNOSTIC_SECTION_SUFFIX = ' diagnostic';
const COMMAND_DIAGNOSTIC_LINE_PATTERN = /\b(?:ERROR|FAILED|FAILURES|Traceback|Exception|Error|ImportError|AssertionError|TypeError|NameError|Timeout|timed out)\b|^E\s+/i;
const COMMAND_DIAGNOSTIC_MAX_MATCH_LINES = 40;
const COMMAND_DIAGNOSTIC_TAIL_LINES = 25;
const DIAGNOSTIC_SUMMARY_KEY = 'diagnosticSummary';
const DIAGNOSTIC_SUMMARY_LOCATION_LIMIT = 3;
const DIAGNOSTIC_MESSAGE_PREFIX_CHARS = 160;
const DIAGNOSTIC_TRUNCATION_PATTERN = /\[truncated\b/i;
const SERIAL_MCP_TOOL_NAMES = new Set([PYTHON_LSP_TOOL_NAME]);
const SERIAL_MCP_LOCK_STALE_MS = 10 * 60 * 1000;
const SERIAL_MCP_LOCK_RETRIES = 480;
const SERIAL_MCP_LOCK_RETRY_MIN_MS = 250;
const SERIAL_MCP_LOCK_RETRY_MAX_MS = 1000;
const SERIAL_MCP_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const SERIAL_MCP_LOCK_SCOPE = 'project';
const SERIAL_MCP_LOCK_REASON = 'shared_backend_symbol_operations';

const ProjectToolParameter = {
  ARGUMENTS: 'arguments',
  ARGV: 'argv',
  CWD: 'cwd',
  CWD_MODE: 'cwdMode'
} as const;
const PathArgumentConfigKey = {
  ROOT_KIND: 'rootKind',
  ROOT: 'root',
  WORKSPACE_ROOT: 'workspaceRoot',
  VIRTUAL_ROOTS: 'virtualRoots',
  MUST_STAY_INSIDE_ROOT: 'mustStayInsideRoot'
} as const;
const ProjectToolRootKind = {
  WORKTREE: 'worktree',
  PROJECT: 'project',
  FRAMEWORK: 'framework',
  WORKSPACE: 'workspace'
} as const;
const PROJECT_TOOL_CONTROL_PARAMETERS = new Set<string>([
  ProjectToolParameter.ARGV,
  ProjectToolParameter.CWD,
  ProjectToolParameter.CWD_MODE
]);

interface McpServerDefinition {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerDefinition>;
  'mcp-servers'?: Record<string, McpServerDefinition>;
}

interface ProjectToolExecutionContext {
  templateContext: TemplateContext;
  cwd: string;
  callDir: string;
  outputDir: string;
  outputFile: string;
  tmpDir: string;
}

interface SerializedMcpLockMetadata {
  scope: typeof SERIAL_MCP_LOCK_SCOPE;
  projectRoot: string;
  worktreePath: string;
  reason: typeof SERIAL_MCP_LOCK_REASON;
}

interface SerializedMcpLockTimeoutMetadata {
  scope: typeof SERIAL_MCP_LOCK_SCOPE;
  reason: typeof SERIAL_MCP_LOCK_REASON;
  waitedMs: number;
  tool: string;
  server: string;
  lockRef: string;
  lockFile: string;
}

class SerializedMcpToolLockTimeoutError extends Error {
  readonly lockMetadata: SerializedMcpLockTimeoutMetadata;

  constructor(
    definition: ProjectMcpToolConfig,
    lockPath: string,
    waitedMs: number,
    cause: unknown,
    metadata: SerializedMcpLockMetadata
  ) {
    super(`Timed out acquiring serialized MCP project-tool lock for ${definition.name} after ${waitedMs}ms: ${String(cause)}`);
    this.name = 'SerializedMcpToolLockTimeoutError';
    this.lockMetadata = {
      scope: metadata.scope,
      reason: metadata.reason,
      waitedMs,
      tool: definition.name,
      server: definition.server,
      lockRef: path.basename(path.dirname(lockPath)),
      lockFile: path.basename(lockPath)
    };
  }
}

export interface ProjectToolRuntimeContext {
  beadId?: string;
  stateId?: string;
  actionId?: string;
}

interface ProjectToolFailureLimitResult {
  reached: boolean;
  failureCount: number;
  maxFailures: number;
  result?: Record<string, unknown>;
}

interface ProjectToolOutputArchive {
  artifactRef: string;
  bytes: number;
  truncated: boolean;
}

interface InFlightProjectToolCall {
  token: string;
  startedAtMs: number;
}

type ModelFacingProjectToolResult = Record<string, unknown> & {
  [ProjectToolResultKey.OUTPUT_ARCHIVE]?: ProjectToolOutputArchive;
  [ProjectToolResultKey.OUTPUT_ACCESS]?: string;
  [ProjectToolResultKey.RESULT_PREVIEW]?: string;
  outputPreview?: string;
  outputTruncated?: boolean;
};

interface ParsedProjectDiagnostic {
  severity: string;
  message: string;
  source?: string;
  code?: string;
  file?: string;
  line?: number;
  column?: number;
}

interface ParsedProjectDiagnostics {
  diagnostics: ParsedProjectDiagnostic[];
  declaredDiagnostics?: number;
  sourceTruncated: boolean;
}

interface DiagnosticGroupSummary {
  source: string;
  code: string;
  severity: string;
  messagePrefix: string;
  count: number;
  missingImport: boolean;
  representativeLocations: string[];
}

interface DiagnosticGroupAccumulator extends DiagnosticGroupSummary {
  sortIndex: number;
  severityRank: number;
}

interface ProjectDiagnosticSummary {
  totalDiagnostics: number;
  parsedDiagnostics: number;
  declaredDiagnostics?: number;
  missingImportCount: number;
  sourceTruncated: boolean;
  groups: DiagnosticGroupSummary[];
  omittedGroups?: number;
  nextAction: string;
}

/**
 * Stable model-facing structured summary produced by a registered ProjectToolSummarizer.
 * Fields are intentionally kept stable: consumers may rely on their presence/absence
 * but must not assume internal shapes beyond what is documented here.
 *
 * status        - 'ok' | 'parse_error' — whether the summarizer succeeded or fell back
 *                 to a compact parse_error without exposing raw payload.
 * counts        - key/value counts (e.g. { errors: 3, warnings: 1 }).
 * affectedPaths - up to SUMMARIZER_MAX_AFFECTED_PATHS representative file/path strings.
 * representativeSamples - up to SUMMARIZER_MAX_REPRESENTATIVE_SAMPLES compact issue objects.
 * omissions     - description of what was omitted from this summary (non-null when truncated).
 * nextAction    - terse routing hint for the model.
 */
export interface StructuredResult {
  status: 'ok' | 'parse_error';
  counts?: Record<string, number>;
  affectedPaths?: string[];
  representativeSamples?: unknown[];
  omissions?: string;
  nextAction?: string;
}

/**
 * A registered per-tool payload summarizer.
 * Summarizers are resolved in registry order; the first whose appliesTo returns true
 * is called.  Summarizers MUST NOT throw — return null (no summary) or a parse_error
 * StructuredResult when they cannot parse.
 */
export interface ProjectToolSummarizer {
  /** Stable display name used in logging and tests. */
  name: string;
  /** Returns true when this summarizer should handle the given tool definition + raw result record. */
  appliesTo(definition: ProjectToolConfig, record: Record<string, unknown>): boolean;
  /**
   * Produce a StructuredResult from the raw record, or null if the record does not
   * contain enough signal to summarize.  Must not throw — catch parse errors and return
   * a parse_error StructuredResult instead.
   */
  summarize(
    definition: ProjectToolConfig,
    record: Record<string, unknown>,
    context: ProjectToolExecutionContext
  ): StructuredResult | null;
}

const inFlightProjectToolCalls = new Map<string, InFlightProjectToolCall>();

export function shouldSerializeMcpTool(definition: Pick<ProjectToolConfig, 'name' | 'type'>): boolean {
  return definition.type === ProjectToolType.MCP && SERIAL_MCP_TOOL_NAMES.has(definition.name);
}

export function mcpToolRequestTimeoutMs(definition: Pick<ProjectMcpToolConfig, 'name' | 'type' | 'timeoutMs'>): number {
  if (typeof definition.timeoutMs === 'number' && Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0) {
    return definition.timeoutMs;
  }
  return shouldSerializeMcpTool(definition) ? SERIAL_MCP_REQUEST_TIMEOUT_MS : Defaults.PROCESS_REAP_INTERVAL_MS;
}

function mcpToolRequestOptions(definition: ProjectMcpToolConfig): RequestOptions {
  return { timeout: mcpToolRequestTimeoutMs(definition) };
}

function serializedMcpLockMetadata(context: ProjectToolExecutionContext): SerializedMcpLockMetadata {
  const root = context.templateContext.projectRoot || getProjectRoot() || process.cwd();
  return {
    scope: SERIAL_MCP_LOCK_SCOPE,
    projectRoot: root,
    worktreePath: context.templateContext.worktreePath,
    reason: SERIAL_MCP_LOCK_REASON
  };
}

function serializedMcpLockPath(definition: ProjectMcpToolConfig, context: ProjectToolExecutionContext): string {
  const metadata = serializedMcpLockMetadata(context);
  const digest = createHash('sha256')
    .update(`${metadata.projectRoot}\n${definition.server}\n${definition.name}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(tmpdir(), 'orr-else-mcp-tool-locks', digest, `${definition.name}.lock`);
}

async function ensureSerializedMcpLockFile(definition: ProjectMcpToolConfig, context: ProjectToolExecutionContext): Promise<string> {
  const lockPath = serializedMcpLockPath(definition, context);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await open(lockPath, 'a');
  await handle.close();
  return lockPath;
}

async function withSerializedMcpToolLock<T>(
  definition: ProjectMcpToolConfig,
  context: ProjectToolExecutionContext,
  fn: () => Promise<T>
): Promise<T> {
  if (!shouldSerializeMcpTool(definition)) return await fn();

  const lockPath = await ensureSerializedMcpLockFile(definition, context);
  const startedAtMs = Date.now();
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(lockPath, {
      stale: SERIAL_MCP_LOCK_STALE_MS,
      retries: {
        retries: SERIAL_MCP_LOCK_RETRIES,
        factor: 1.1,
        minTimeout: SERIAL_MCP_LOCK_RETRY_MIN_MS,
        maxTimeout: SERIAL_MCP_LOCK_RETRY_MAX_MS
      }
    });
  } catch (error) {
    const waitedMs = Date.now() - startedAtMs;
    const lockMetadata = serializedMcpLockMetadata(context);
    Logger.warn(Component.PROJECT_TOOLS, 'Timed out acquiring serialized MCP project-tool lock', {
      tool: definition.name,
      server: definition.server,
      waitedMs,
      lockScope: lockMetadata.scope,
      lockReason: lockMetadata.reason,
      lockRef: path.basename(path.dirname(lockPath)),
      lockFile: path.basename(lockPath),
      error: String(error)
    });
    throw new SerializedMcpToolLockTimeoutError(definition, lockPath, waitedMs, error, lockMetadata);
  }

  const waitedMs = Date.now() - startedAtMs;
  if (waitedMs > SERIAL_MCP_LOCK_RETRY_MAX_MS) {
    const lockMetadata = serializedMcpLockMetadata(context);
    Logger.warn(Component.PROJECT_TOOLS, 'Waited for serialized MCP project-tool lock', {
      tool: definition.name,
      server: definition.server,
      waitedMs,
      lockScope: lockMetadata.scope,
      lockReason: lockMetadata.reason,
      projectRoot: lockMetadata.projectRoot,
      worktreePath: lockMetadata.worktreePath,
      lockPath
    });
  }

  try {
    return await fn();
  } finally {
    await release?.().catch((error: unknown) => {
      Logger.warn(Component.PROJECT_TOOLS, 'Unable to release serialized MCP project-tool lock', {
        tool: definition.name,
        server: definition.server,
        lockPath,
        error: String(error)
      });
    });
  }
}

function buildProjectToolFailureLimitResult(
  definition: ProjectToolConfig,
  failureCount: number,
  maxFailures: number,
  stateId?: string,
  actionId?: string,
  suggestedOutcomeOverride?: string
): Record<string, unknown> {
  const configuredSuggestedOutcome = projectToolFailureLimitSuggestedOutcome(definition, stateId, actionId);
  const suggestedOutcome = suggestedOutcomeOverride || configuredSuggestedOutcome;
  const terminal = definition.failureLimit?.terminal === true;
  const message = suggestedOutcomeOverride && suggestedOutcomeOverride !== configuredSuggestedOutcome
    ? `Failure limit reached for project tool ${definition.name}. Route the state with ${suggestedOutcome} based on the project-tool routing hint instead of retrying this verifier.`
    : definition.failureLimit?.message
    || `Failure limit reached for project tool ${definition.name}. Route the state with ${suggestedOutcome} instead of retrying this verifier.`;

  return {
    tool: definition.name,
    status: ToolResultStatus.REJECTED,
    message,
    failureLimit: {
      failureCount,
      maxFailures,
      suggestedOutcome,
      terminal
    }
  };
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isJsonRecord(value)) return undefined;
  return isJsonRecord(value[key]) ? value[key] as Record<string, unknown> : undefined;
}

function routingHintSuggestedOutcome(value: unknown): string | undefined {
  if (!isJsonRecord(value)) return undefined;
  const candidates = [
    nestedRecord(value, 'routingHint'),
    nestedRecord(nestedRecord(value, ProjectToolResultKey.STRUCTURED_RESULT), 'routingHint'),
    nestedRecord(nestedRecord(value, 'result'), 'routingHint'),
    nestedRecord(nestedRecord(nestedRecord(value, 'result'), ProjectToolResultKey.STRUCTURED_RESULT), 'routingHint')
  ];
  for (const candidate of candidates) {
    if (isJsonRecord(candidate) && typeof candidate.suggestedOutcome === 'string') {
      return candidate.suggestedOutcome;
    }
  }
  return undefined;
}

function failureLimitSuggestedOutcomeFromEvent(event: DomainEvent): string | undefined {
  const failureLimit = event.data?.result?.failureLimit;
  return isJsonRecord(failureLimit) && typeof failureLimit.suggestedOutcome === 'string'
    ? failureLimit.suggestedOutcome
    : routingHintSuggestedOutcome(event.data?.result);
}

export function isInfrastructureProjectToolFailure(value: unknown): boolean {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return /\bENOSPC\b|No space left on device|os error 28/i.test(text);
}

function attachProjectToolFailureLimit(
  result: unknown,
  failureLimitResult: Record<string, unknown>
): unknown {
  const limit = failureLimitResult.failureLimit;
  if (!isJsonRecord(result)) {
    return {
      ...failureLimitResult,
      result
    };
  }

  return {
    ...result,
    message: typeof result.message === 'string' ? result.message : failureLimitResult.message,
    failureLimit: limit
  };
}

export function projectToolFailureLimitSuggestedOutcome(
  definition: ProjectToolConfig | undefined,
  stateId?: string,
  actionId?: string
): string {
  const failureLimit = definition?.failureLimit;
  const byAction = failureLimit?.suggestedOutcomeByAction || {};
  const stateActionKey = stateId && actionId ? `${stateId}/${actionId}` : undefined;
  if (stateActionKey && byAction[stateActionKey]) return byAction[stateActionKey];
  if (actionId && byAction[actionId]) return byAction[actionId];

  const byState = failureLimit?.suggestedOutcomeByState || {};
  if (stateId && byState[stateId]) return byState[stateId];

  return failureLimit?.suggestedOutcome || EventName.BLOCKED;
}

function toFlagName(key: string): string {
  const prefix = key.startsWith('--') ? '--' : key.startsWith('-') ? '-' : '--';
  const optionName = key
    .replace(/^-+/, '')
    .replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)
    .replace(/_/g, '-');
  return `${prefix}${optionName}`;
}

export function normalizeCommandArguments(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (Array.isArray(input)) return input.map(value => String(value));
  if (typeof input === 'string') return [input];
  if (typeof input !== 'object') return [String(input)];

  const record = input as Record<string, unknown>;
  const args: string[] = [];
  const explicitArgv = record[ProjectToolParameter.ARGV];
  if (Array.isArray(explicitArgv)) {
    args.push(...explicitArgv.map(value => String(value)));
  } else if (typeof explicitArgv === 'string') {
    args.push(explicitArgv);
  }

  for (const [key, value] of Object.entries(record)) {
    if (PROJECT_TOOL_CONTROL_PARAMETERS.has(key)) continue;
    if (value === undefined || value === null || value === false) continue;
    const flag = toFlagName(key);
    if (value === true) {
      args.push(flag);
    } else if (Array.isArray(value)) {
      for (const item of value) args.push(flag, String(item));
    } else {
      args.push(flag, String(value));
    }
  }
  return args;
}

type CommandArgumentPathNormalization = {
  arguments: string[];
  normalizedPathArguments: string[];
  rejection?: CommandArgumentPathRejection;
};

type CommandArgumentPathRejection = {
  argumentName: string;
  value: string;
  message: string;
  guidance?: PathArgumentEscapeGuidance;
};

interface PathArgumentRootResolution {
  path: string;
  kind: string;
}

interface PathArgumentEscapeGuidance {
  rootKind: string;
  allowedRoot: string;
  expectedRelativeForm: string;
  acceptedForms: string[];
  remediation: string[];
}

class PathArgumentRootEscapeError extends Error {
  readonly guidance: PathArgumentEscapeGuidance;

  constructor(message: string, guidance: PathArgumentEscapeGuidance) {
    super(message);
    this.name = 'PathArgumentRootEscapeError';
    this.guidance = guidance;
  }
}

function normalizeConfiguredCliFlag(flag: string): string {
  const trimmed = flag.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith('-') ? trimmed.replace(/=.*$/, '') : toFlagName(trimmed);
}

function splitCliFlagAssignment(arg: string): { flag: string; value: string } | undefined {
  if (!arg.startsWith('-')) return undefined;
  const equalsIndex = arg.indexOf('=');
  if (equalsIndex < 1) return undefined;
  return {
    flag: arg.slice(0, equalsIndex),
    value: arg.slice(equalsIndex + 1)
  };
}

function splitTestSelector(value: string): { pathPart: string; suffix: string } {
  const selectorIndex = value.indexOf('::');
  if (selectorIndex < 0) return { pathPart: value, suffix: '' };
  return {
    pathPart: value.slice(0, selectorIndex),
    suffix: value.slice(selectorIndex)
  };
}

function looksLikePathValue(value: string): boolean {
  const candidate = splitTestSelector(value.trim()).pathPart;
  if (!candidate) return false;
  return path.isAbsolute(candidate)
    || candidate === '.'
    || candidate === '..'
    || candidate.startsWith('./')
    || candidate.startsWith('../')
    || candidate.includes('/')
    || candidate.includes('\\');
}

function normalizeCommandPathValue(
  toolName: string,
  argumentName: string,
  value: string,
  config: ProjectCommandArgumentPathConfig,
  templateContext: TemplateContext,
  requirePathLike: boolean
): { value: string; normalized: boolean } {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
        const normalizedItems = parsed.map(item => normalizeCommandPathValue(
          toolName,
          argumentName,
          item,
          config,
          templateContext,
          requirePathLike
        ).value);
        return { value: JSON.stringify(normalizedItems), normalized: true };
      }
    } catch {
      // Fall through to normal scalar handling so invalid JSON is left to the tool wrapper.
    }
  }

  if (requirePathLike && !looksLikePathValue(trimmed)) {
    return { value, normalized: false };
  }

  const selector = splitTestSelector(trimmed);
  const normalizedPath = normalizePathArgumentValue(
    toolName,
    argumentName,
    selector.pathPart,
    config,
    templateContext
  );
  return {
    value: `${normalizedPath}${selector.suffix}`,
    normalized: true
  };
}

function commandArgumentPathRejection(error: unknown, argumentName: string, value: string): CommandArgumentPathRejection {
  const guidance = error instanceof PathArgumentRootEscapeError ? error.guidance : undefined;
  return {
    argumentName,
    value,
    message: String(error instanceof Error ? error.message : error),
    ...(guidance ? { guidance } : {})
  };
}

function normalizeCommandArgumentPaths(
  definition: ProjectCommandToolConfig,
  suppliedArgs: string[],
  templateContext: TemplateContext
): CommandArgumentPathNormalization {
  const config = definition.argumentPathScope;
  if (!config) return { arguments: suppliedArgs, normalizedPathArguments: [] };

  const pathFlags = new Set((config.flags || []).map(normalizeConfiguredCliFlag).filter(Boolean));
  const normalizedArgs: string[] = [];
  const normalizedPathArguments: string[] = [];

  for (let index = 0; index < suppliedArgs.length; index += 1) {
    const arg = suppliedArgs[index];
    const inlineFlag = splitCliFlagAssignment(arg);
    if (inlineFlag && pathFlags.has(inlineFlag.flag)) {
      try {
        const normalized = normalizeCommandPathValue(
          definition.name,
          inlineFlag.flag,
          inlineFlag.value,
          config,
          templateContext,
          false
        );
        normalizedArgs.push(`${inlineFlag.flag}=${normalized.value}`);
        normalizedPathArguments.push(inlineFlag.flag);
      } catch (error) {
        return {
          arguments: normalizedArgs,
          normalizedPathArguments,
          rejection: commandArgumentPathRejection(error, inlineFlag.flag, inlineFlag.value)
        };
      }
      continue;
    }

    const normalizedFlag = normalizeConfiguredCliFlag(arg);
    if (pathFlags.has(normalizedFlag)) {
      normalizedArgs.push(arg);
      const value = suppliedArgs[index + 1];
      if (value === undefined) continue;
      try {
        const normalized = normalizeCommandPathValue(
          definition.name,
          normalizedFlag,
          value,
          config,
          templateContext,
          false
        );
        normalizedArgs.push(normalized.value);
        normalizedPathArguments.push(normalizedFlag);
        index += 1;
      } catch (error) {
        return {
          arguments: normalizedArgs,
          normalizedPathArguments,
          rejection: commandArgumentPathRejection(error, normalizedFlag, value)
        };
      }
      continue;
    }

    if (config.positionals === true && !arg.startsWith('-')) {
      try {
        const normalized = normalizeCommandPathValue(
          definition.name,
          `argv[${index}]`,
          arg,
          config,
          templateContext,
          true
        );
        normalizedArgs.push(normalized.value);
        if (normalized.normalized) normalizedPathArguments.push(`argv[${index}]`);
      } catch (error) {
        return {
          arguments: normalizedArgs,
          normalizedPathArguments,
          rejection: commandArgumentPathRejection(error, `argv[${index}]`, arg)
        };
      }
      continue;
    }

    normalizedArgs.push(arg);
  }

  return { arguments: normalizedArgs, normalizedPathArguments };
}

function commandArgumentFlagName(argument: string): string | undefined {
  const trimmed = argument.trim();
  if (!trimmed.startsWith('-')) return undefined;
  const token = trimmed.split(/\s+/, 1)[0];
  return token.replace(/=.*$/, '');
}

function unsupportedArtifactValidatorOutputControlFlag(definition: ProjectCommandToolConfig, suppliedArgs: string[]): string | undefined {
  if (definition.name !== ARTIFACT_VALIDATOR_TOOL_NAME) return undefined;
  for (const argument of suppliedArgs) {
    const flag = commandArgumentFlagName(argument);
    if (flag && UNSUPPORTED_ARTIFACT_VALIDATOR_OUTPUT_CONTROL_FLAGS.has(flag)) return flag;
  }
  return undefined;
}

function unsupportedArtifactValidatorOutputControlResult(
  definition: ProjectCommandToolConfig,
  flag: string
): Record<string, unknown> {
  return {
    tool: definition.name,
    status: ToolResultStatus.REJECTED,
    message: `Project tool ${definition.name} does not support output-control flag ${flag}. Project-tool output is already bounded and archived by the harness; do not pass harness output-control flags to artifact_validator.`,
    unsupportedOutputControlFlag: flag,
    [ProjectToolResultKey.FAILURE_CATEGORY]: ProjectToolFailureCategory.TOOL_INPUT_ERROR,
    [ProjectToolResultKey.REMEDIATION]: [
      'Use structuredResult, resultPreview, diagnosticPreview, rejectedChecks, and outputArchive.artifactRef from the artifact_validator response instead of adding output-control flags.',
      'Use supported harness retrieval patterns for archived output; artifactRef is an opaque harness handle, not a filesystem path.',
      'Rerun artifact_validator only with supported validator arguments or narrower artifact inputs.'
    ]
  };
}

function commandPathRejectionResult(
  definition: ProjectCommandToolConfig,
  rejection: CommandArgumentPathRejection,
  normalizedPathArguments: string[]
) {
  const remediation = rejection.guidance?.remediation || [
    'Correct the command path argument so it resolves inside the configured path root.',
    'Use a path relative to the configured root or a configured virtual workspace root; do not pass unrelated absolute paths.'
  ];
  return {
    tool: definition.name,
    status: ToolResultStatus.REJECTED,
    message: rejection.message,
    rejectedPathArgument: {
      name: rejection.argumentName,
      value: rejection.value
    },
    normalizedPathArguments,
    [ProjectToolResultKey.FAILURE_CATEGORY]: ProjectToolFailureCategory.TOOL_INPUT_ERROR,
    [ProjectToolResultKey.REMEDIATION]: remediation
  };
}

function unavailable(name: string, message: string) {
  return {
    tool: name,
    status: ToolResultStatus.UNAVAILABLE,
    message
  };
}

function commandFailureStatus(error: any): ToolResultStatus {
  return error?.code === 'ENOENT' ? ToolResultStatus.UNAVAILABLE : ToolResultStatus.REJECTED;
}

function successfulExitCodes(definition: ProjectCommandToolConfig): number[] {
  return definition.successExitCodes?.length
    ? definition.successExitCodes
    : [CommandExitCode.SUCCESS];
}

export function isSuccessfulCommandExitCode(definition: ProjectCommandToolConfig, code: unknown): boolean {
  return typeof code === 'number' && successfulExitCodes(definition).includes(code);
}

export function isAcceptedMaxBufferFailure(definition: ProjectCommandToolConfig, error: unknown): boolean {
  return definition.acceptMaxBuffer === true
    && typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === CommandErrorCode.MAX_BUFFER;
}

function commandReturnBytes(definition: ProjectCommandToolConfig): number {
  if (typeof definition.maxOutputBytes !== 'number' || !Number.isFinite(definition.maxOutputBytes) || definition.maxOutputBytes <= 0) {
    return ProjectToolDefaults.COMMAND_RETURN_BYTES;
  }
  return Math.min(definition.maxOutputBytes, ProjectToolDefaults.COMMAND_RETURN_BYTES);
}

function boundedCommandText(value: unknown, limitBytes: number): { text: string; bytes: number; truncated: boolean } {
  const text = typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : String(value);
  if (text.length <= limitBytes) {
    return { text, bytes: text.length, truncated: false };
  }
  const headLength = Math.ceil(limitBytes / 2);
  const tailLength = Math.max(limitBytes - headLength, 0);
  const tail = tailLength > 0 ? `\n\n${text.slice(-tailLength)}` : '';
  return {
    text: `${text.slice(0, headLength)}\n\n${COMMAND_TRUNCATION_MARKER_PREFIX}${text.length - limitBytes}${COMMAND_TRUNCATION_TEXT_MARKER_SUFFIX}]${tail}`,
    bytes: text.length,
    truncated: true
  };
}

async function boundedCommandFile(filePath: string, limitBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  let size = 0;
  try {
    size = (await stat(filePath)).size;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { text: '', bytes: 0, truncated: false };
    throw error;
  }

  if (size === 0) return { text: '', bytes: 0, truncated: false };

  const handle = await open(filePath, 'r');
  try {
    if (size <= limitBytes) {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      return { text: buffer.subarray(0, bytesRead).toString('utf8'), bytes: size, truncated: false };
    }

    const headBytes = Math.ceil(limitBytes / 2);
    const tailBytes = Math.max(limitBytes - headBytes, 0);
    const headBuffer = Buffer.alloc(headBytes);
    const tailBuffer = Buffer.alloc(tailBytes);
    const { bytesRead: headBytesRead } = await handle.read(headBuffer, 0, headBytes, 0);
    const { bytesRead: tailBytesRead } = tailBytes > 0
      ? await handle.read(tailBuffer, 0, tailBytes, Math.max(size - tailBytes, 0))
      : { bytesRead: 0 };
    const headText = headBuffer.subarray(0, headBytesRead).toString('utf8');
    const tailText = tailBuffer.subarray(0, tailBytesRead).toString('utf8');
    const tail = tailText.length > 0 ? `\n\n${tailText}` : '';
    return {
      text: `${headText}\n\n${COMMAND_TRUNCATION_MARKER_PREFIX}${size - limitBytes}${COMMAND_TRUNCATION_STREAM_MARKER_SUFFIX}]${tail}`,
      bytes: size,
      truncated: true
    };
  } finally {
    await handle.close();
  }
}

/**
 * Resolves a context field from args with fixed precedence:
 * 1. args.[key]            — top-level keys (legacy shims, checked first for backward compat)
 * 2. args.arguments.[key]  — nested arguments.* form (canonical; prefer this in new callers)
 * 3. process.env[envVar]   — environment fallback (optional)
 * Keys are [canonical, ...aliases] and are tried in that order within each tier.
 */
export function resolveContextField(args: any, keys: [string, ...string[]], envVar?: string): string | undefined {
  for (const key of keys) {
    if (args?.[key]) return args[key];
  }
  for (const key of keys) {
    if (args?.arguments?.[key]) return args.arguments[key];
  }
  return envVar ? process.env[envVar] : undefined;
}

function beadIdFromArgs(args: any): string | undefined {
  return resolveContextField(args, ['beadId', 'id'], EnvVars.BEAD_ID);
}

function stateIdFromArgs(args: any): string | undefined {
  return resolveContextField(args, ['stateId', 'state'], EnvVars.STATE_ID);
}

function actionIdFromArgs(args: any): string | undefined {
  return resolveContextField(args, ['actionId', 'action'], EnvVars.ACTION_ID);
}

function cwdOverrideFromArgs(args: any): string | undefined {
  const value = args?.[ProjectToolParameter.CWD]
    || args?.[ProjectToolParameter.CWD_MODE]
    || args?.[ProjectToolParameter.ARGUMENTS]?.[ProjectToolParameter.CWD]
    || args?.[ProjectToolParameter.ARGUMENTS]?.[ProjectToolParameter.CWD_MODE];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function pathSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value || fallback)
    .replace(ProjectToolDefaults.UNSAFE_PATH_SEGMENT_PATTERN, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || fallback;
}

function baseTemplateContext(definition: ProjectToolConfig, args: any): TemplateContext {
  const projectRoot = process.env[EnvVars.PROJECT_ROOT] || getProjectRoot();
  const worktreeRoot = process.env[EnvVars.WORKTREE_PATH] || projectRoot;
  return {
    configPath: process.env[EnvVars.CONFIG_PATH],
    projectRoot,
    worktreePath: worktreeRoot,
    frameworkRoot: frameworkRootFromArgs(args, projectRoot),
    beadId: pathSegment(beadIdFromArgs(args), ProjectToolDefaults.UNASSIGNED_BEAD_ID),
    stateId: pathSegment(stateIdFromArgs(args), ProjectToolDefaults.UNSPECIFIED_STATE_ID),
    actionId: pathSegment(actionIdFromArgs(args), ProjectToolDefaults.UNSPECIFIED_ACTION_ID),
    toolName: pathSegment(definition.name, definition.name)
  };
}

function frameworkRootFromArgs(args: any, fallbackRoot?: string): string | undefined {
  const value = typeof args?.frameworkRoot === 'string' && args.frameworkRoot.trim()
    ? args.frameworkRoot
    : process.env[EnvVars.FRAMEWORK_ROOT] || fallbackRoot;
  if (!value) return undefined;
  return path.resolve(value);
}

function frameworkRootFromConfig(config: HarnessConfig): string | undefined {
  const value = config.settings.artifacts?.templates?.orrElseFrameworkRoot;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const projectRoot = process.env[EnvVars.PROJECT_ROOT] || getProjectRoot();
  const context: TemplateContext = {
    projectRoot,
    worktreePath: process.env[EnvVars.WORKTREE_PATH] || projectRoot
  };
  const resolved = resolveTemplateString(value, context);
  return path.isAbsolute(resolved) ? resolved : path.resolve(projectRoot, resolved);
}

function resolvePathAgainst(baseDir: string, value: string, templateContext: TemplateContext): string {
  const resolved = resolveTemplateString(value, templateContext);
  return path.isAbsolute(resolved) ? resolved : path.resolve(baseDir, resolved);
}

function resolveCwdValue(value: CwdMode | string | undefined, templateContext: TemplateContext): string {
  if (value === CwdMode.WORKTREE) return templateContext.worktreePath;
  if (value === CwdMode.PROJECT) return templateContext.projectRoot;
  if (value === ProjectToolRootKind.FRAMEWORK) {
    if (!templateContext.frameworkRoot) throw new Error('Project tool configured framework root, but no framework root is available.');
    return templateContext.frameworkRoot;
  }
  if (value) return resolvePathAgainst(templateContext.projectRoot, value, templateContext);
  return templateContext.worktreePath;
}

function isInsidePath(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function resolveToolCwd(definition: ProjectToolConfig, templateContext: TemplateContext, args: any): string {
  if (definition.type !== ProjectToolType.COMMAND) return templateContext.worktreePath;
  const configuredCwd = definition.allowCwdOverride
    ? cwdOverrideFromArgs(args) || definition.cwd
    : definition.cwd;
  return resolveCwdValue(configuredCwd, templateContext);
}

function executionContext(pathFactory: ToolCallPathFactory, definition: ProjectToolConfig, args: any): ProjectToolExecutionContext {
  const initialContext = baseTemplateContext(definition, args);
  const cwd = resolveToolCwd(definition, initialContext, args);
  const invocationContext = {
    ...initialContext,
    toolInvocationId: uuidv7()
  };
  const allocation = pathFactory.allocate(invocationContext);
  const allocatedContext = {
    ...invocationContext,
    toolCallDir: allocation.callDir,
    toolOutputDir: allocation.outputDir,
    toolOutputFile: allocation.outputFile,
    toolTmpDir: allocation.tmpDir
  };
  return {
    templateContext: allocatedContext,
    cwd,
    callDir: allocation.callDir,
    outputDir: allocation.outputDir,
    outputFile: allocation.outputFile,
    tmpDir: allocation.tmpDir
  };
}

function projectToolBackpressureKey(definition: ProjectToolConfig, context: ProjectToolExecutionContext): string {
  const templateContext = context.templateContext;
  return [
    templateContext.projectRoot,
    templateContext.worktreePath,
    templateContext.beadId || ProjectToolDefaults.UNASSIGNED_BEAD_ID,
    templateContext.stateId || ProjectToolDefaults.UNSPECIFIED_STATE_ID,
    templateContext.actionId || ProjectToolDefaults.UNSPECIFIED_ACTION_ID,
    definition.name
  ].join('\0');
}

function projectToolBackpressureStaleMs(definition: ProjectToolConfig): number {
  const configured = definition.wrapperTimeoutMs;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : ToolDefaults.WRAPPER_TIMEOUT_MS;
}

function reserveProjectToolCall(definition: ProjectToolConfig, context: ProjectToolExecutionContext): { key: string; existing?: InFlightProjectToolCall } {
  const key = projectToolBackpressureKey(definition, context);
  const existing = inFlightProjectToolCalls.get(key);
  const now = Date.now();
  if (existing) {
    const staleMs = projectToolBackpressureStaleMs(definition);
    if (now - existing.startedAtMs <= staleMs) {
      return { key, existing };
    }
    Logger.warn(Component.PROJECT_TOOLS, 'Discarding stale in-flight project-tool backpressure entry', {
      tool: definition.name,
      beadId: context.templateContext.beadId,
      stateId: context.templateContext.stateId,
      actionId: context.templateContext.actionId,
      staleMs,
      ageMs: now - existing.startedAtMs
    });
  }

  inFlightProjectToolCalls.set(key, {
    token: context.templateContext.toolInvocationId || uuidv7(),
    startedAtMs: now
  });
  return { key };
}

function releaseProjectToolCall(key: string, token: string | undefined): void {
  const existing = inFlightProjectToolCalls.get(key);
  if (!existing || existing.token !== token) return;
  inFlightProjectToolCalls.delete(key);
}

function projectToolBackpressureResult(
  definition: ProjectToolConfig,
  context: ProjectToolExecutionContext,
  existing: InFlightProjectToolCall
): Record<string, unknown> {
  const ageMs = Math.max(0, Date.now() - existing.startedAtMs);
  return {
    tool: definition.name,
    status: ToolResultStatus.REJECTED,
    failureCategory: ProjectToolFailureCategory.BACKPRESSURE,
    message: `REJECTED: \`${definition.name}\` is already running for this bead/state/action. Wait for the in-flight result before starting another \`${definition.name}\` call; rerun narrower only after that result is visible.`,
    inFlight: {
      ageMs,
      toolInvocationId: existing.token,
      beadId: context.templateContext.beadId,
      stateId: context.templateContext.stateId,
      actionId: context.templateContext.actionId
    },
    nextAction: ProjectToolNextAction.WAIT_FOR_IN_FLIGHT_RESULT,
    recovery: [
      'Use the result from the project-tool call that is already in progress.',
      'If more evidence is still required after that result, rerun the same configured project tool once with narrower arguments.'
    ]
  };
}

function serializedMcpLockTimeoutResult(
  definition: ProjectMcpToolConfig,
  error: SerializedMcpToolLockTimeoutError
): Record<string, unknown> {
  return {
    tool: definition.name,
    status: ToolResultStatus.REJECTED,
    server: definition.server,
    failureCategory: ProjectToolFailureCategory.BACKPRESSURE,
    lockTimeout: true,
    lockMetadata: error.lockMetadata,
    message: `REJECTED: \`${definition.name}\` could not acquire the serialized MCP project-tool lock after ${error.lockMetadata.waitedMs}ms. Another ${definition.server} operation is likely still in flight; wait for that result instead of starting parallel retries.`,
    recovery: [
      'Wait for the in-flight serialized MCP project-tool result before retrying.',
      'After the in-flight result is visible, rerun this configured project tool once with narrower arguments only if more evidence is still required.'
    ]
  };
}

async function prepareProjectToolOutputDir(context: ProjectToolExecutionContext): Promise<void> {
  await mkdir(context.outputDir, { recursive: true });
  await mkdir(context.tmpDir, { recursive: true });
}

function projectToolEnvironment(context: ProjectToolExecutionContext): Record<string, string> {
  return {
    [EnvVars.PROJECT_ROOT]: context.templateContext.projectRoot,
    [EnvVars.WORKTREE_PATH]: context.templateContext.worktreePath,
    [EnvVars.BEAD_ID]: context.templateContext.beadId || ProjectToolDefaults.UNASSIGNED_BEAD_ID,
    [EnvVars.STATE_ID]: context.templateContext.stateId || ProjectToolDefaults.UNSPECIFIED_STATE_ID,
    [EnvVars.ACTION_ID]: context.templateContext.actionId || ProjectToolDefaults.UNSPECIFIED_ACTION_ID,
    [EnvVars.TOOL_NAME]: context.templateContext.toolName || ProjectToolDefaults.UNASSIGNED_BEAD_ID,
    [EnvVars.TOOL_INVOCATION_ID]: context.templateContext.toolInvocationId || '',
    [EnvVars.TOOL_CALL_DIR]: context.callDir,
    [EnvVars.TOOL_OUTPUT_DIR]: context.outputDir,
    [EnvVars.TOOL_OUTPUT_FILE]: context.outputFile,
    [EnvVars.TOOL_TMP_DIR]: context.tmpDir,
    [EnvVars.TOOL_WORKING_DIR]: context.cwd,
    ...(context.templateContext.frameworkRoot ? { [EnvVars.FRAMEWORK_ROOT]: context.templateContext.frameworkRoot } : {}),
    TMPDIR: context.tmpDir,
    TMP: context.tmpDir,
    TEMP: context.tmpDir
  };
}

function statusFromToolResult(result: unknown): ToolResultStatus | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const status = (result as { status?: unknown }).status;
  return typeof status === 'string' ? status as ToolResultStatus : undefined;
}

function searchableFailureText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) || String(value);
  } catch {
    return String(value);
  }
}

export function classifyProjectToolFailure(
  definition: Pick<ProjectToolConfig, 'name'> | undefined,
  result: unknown
): ProjectToolFailureCategory | undefined {
  const record = resultRecord(result);
  const status = statusFromToolResult(record);
  if (status === ToolResultStatus.PASSED) return undefined;
  if (record[ProjectToolResultKey.FAILURE_CATEGORY]) {
    return record[ProjectToolResultKey.FAILURE_CATEGORY] as ProjectToolFailureCategory;
  }
  if (record.failureLimit) return ProjectToolFailureCategory.TERMINAL_GATE;
  if (status === ToolResultStatus.UNAVAILABLE) return ProjectToolFailureCategory.UNAVAILABLE;

  const text = searchableFailureText({ tool: definition?.name, ...record });
  if (TRANSIENT_PROJECT_TOOL_FAILURE_PATTERN.test(text)) return ProjectToolFailureCategory.TRANSIENT_TRANSPORT;
  if (TOOL_INPUT_PROJECT_TOOL_FAILURE_PATTERN.test(text)) return ProjectToolFailureCategory.TOOL_INPUT_ERROR;
  if (WORKTREE_STATE_PROJECT_TOOL_FAILURE_PATTERN.test(text)) return ProjectToolFailureCategory.WORKTREE_STATE_ERROR;
  if (status === ToolResultStatus.REJECTED) return ProjectToolFailureCategory.VERIFIER_FAILED;
  return undefined;
}

function projectToolRemediationValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function mergeProjectToolRemediation(existing: unknown, additional: string[]): string[] {
  return [...new Set([...projectToolRemediationValues(existing), ...additional])];
}

function attachFailureCategory(definition: ProjectToolConfig, result: unknown): unknown {
  const failureCategory = classifyProjectToolFailure(definition, result);
  if (!failureCategory) return result;
  if (isJsonRecord(result)) {
    const remediation = mergeProjectToolRemediation(
      result[ProjectToolResultKey.REMEDIATION],
      projectToolRemediation(definition, failureCategory, result)
    );
    return withoutUndefined({
      ...result,
      [ProjectToolResultKey.FAILURE_CATEGORY]: failureCategory,
      [ProjectToolResultKey.REMEDIATION]: remediation
    });
  }
  const remediation = projectToolRemediation(definition, failureCategory, result);
  return {
    status: ToolResultStatus.REJECTED,
    tool: definition.name,
    [ProjectToolResultKey.FAILURE_CATEGORY]: failureCategory,
    [ProjectToolResultKey.REMEDIATION]: remediation,
    result
  };
}

function attachProjectToolSteering(definition: ProjectToolConfig, result: unknown): unknown {
  const steering = projectToolSteering(definition, result);
  if (Object.keys(steering).length === 0) return result;
  if (isJsonRecord(result)) {
    return withoutUndefined({
      ...result,
      ...steering
    });
  }
  return withoutUndefined({
    tool: definition.name,
    status: ToolResultStatus.REJECTED,
    result,
    ...steering
  });
}

function projectToolSteering(definition: ProjectToolConfig, result: unknown): Record<string, unknown> {
  const record = resultRecord(result);
  const status = statusFromToolResult(record);

  if (record[ProjectToolResultKey.NEXT_ACTION] === INSUFFICIENT_EVIDENCE_NEXT_ACTION) {
    return {};
  }

  if (status === ToolResultStatus.PASSED) {
    if (record[ProjectToolResultKey.MATCH_STATUS] === NO_MATCH_STATUS) {
      return {
        [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.RECORD_NO_MATCH,
        [ProjectToolResultKey.RECOVERY]: ['Record the no-match result as evidence if it satisfies the current check; otherwise rerun with a narrower or corrected pattern.']
      };
    }

    // Requirement 1/2: When structuredResult carries declared decision evidence, treat it as
    // the authoritative summary and steer to use_result — even when outputTruncated/
    // stdoutTruncated/stderrTruncated is set.  Raw-truncation markers on the serialized
    // output are NOT sufficient reason to rerun when a structured summary already provides
    // the decision evidence.
    //
    // Precedence (requirement 4 honoured first — failure/terminal/backpressure routing is
    // evaluated BEFORE this block via the status === PASSED guard above):
    //   1. failure / terminal / backpressure  → evaluated before this if-branch
    //   2. structured evidence → use_result (or fetch_named_omission for omissions)
    //   3. truncation fallback → rerun_narrower (existing path below, unchanged)
    //
    // Requirement 3: If structuredResult.omissions is set, the summary deliberately excluded
    // data that may be needed for the decision.  Steer to fetch_named_omission and surface
    // the omission description in recovery so the agent can fetch the specific missing fact
    // rather than running a broad generic rerun.
    const structuredResultValue = record[ProjectToolResultKey.STRUCTURED_RESULT];
    if (structuredResultHasDecisionEvidence(structuredResultValue)) {
      const omissions = isJsonRecord(structuredResultValue) && typeof structuredResultValue.omissions === 'string'
        ? structuredResultValue.omissions
        : undefined;
      if (omissions) {
        return {
          [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.FETCH_NAMED_OMISSION,
          [ProjectToolResultKey.RECOVERY]: [
            `structuredResult omissions: ${omissions}`,
            'Fetch only the specific missing selector, path, or range identified in structuredResult.omissions; do not rerun the full tool call.'
          ]
        };
      }
      // Evidence is sufficient and nothing is omitted — use the structured result as-is.
      if (record[ProjectToolResultKey.OUTPUT_ARCHIVE] || record[ProjectToolResultKey.OUTPUT_ACCESS]) {
        if (record[DIAGNOSTIC_SUMMARY_KEY]) {
          return {
            [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.USE_RESULT,
            [ProjectToolResultKey.RECOVERY]: [
              'Cite the diagnosticSummary groups (source/code/count/locations) when reporting findings; inspect non-import groups before grouped reportMissingImports noise.',
              'Raw diagnostic lines are omitted from resultPreview when a summary is available; they remain in outputArchive.',
              'Rerun diagnostics narrowly (single file or operation) only when representative locations in the summary are insufficient for a specific fix decision.'
            ]
          };
        }
        return {
          [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.USE_RESULT,
          [ProjectToolResultKey.RECOVERY]: ['structuredResult contains sufficient decision evidence; treat artifactRef as an opaque harness archive handle, not a filesystem path. Decide from structuredResult, resultPreview, and toolCalls; rerun narrower only if structuredResult.omissions names a specific missing fact.']
        };
      }
      return {
        [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.USE_RESULT
      };
    }

    // Requirement 4 (no structured evidence) / requirement 5 (ambiguous → conservative):
    // Fall through to the existing truncation-based steering when structuredResult is absent
    // or lacks decision evidence.  This path is unchanged from before.
    if (projectToolResultNeedsNarrowing(record)) {
      return {
        [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.RERUN_NARROWER,
        [ProjectToolResultKey.RECOVERY]: ['First decide from resultPreview, structuredResult, and toolCalls. Rerun this same configured project tool with narrower path, pattern, operation, or arguments only when a named missing fact or decision blocker remains. Do not read outputArchive.artifactRef just because the preview is truncated.']
      };
    }
    if (record[ProjectToolResultKey.OUTPUT_ARCHIVE] || record[ProjectToolResultKey.OUTPUT_ACCESS]) {
      if (record[DIAGNOSTIC_SUMMARY_KEY]) {
        return {
          [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.USE_RESULT,
          [ProjectToolResultKey.RECOVERY]: [
            'Cite the diagnosticSummary groups (source/code/count/locations) when reporting findings; inspect non-import groups before grouped reportMissingImports noise.',
            'Raw diagnostic lines are omitted from resultPreview when a summary is available; they remain in outputArchive.',
            'Rerun diagnostics narrowly (single file or operation) only when representative locations in the summary are insufficient for a specific fix decision.'
          ]
        };
      }
      return {
        [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.USE_RESULT,
        [ProjectToolResultKey.RECOVERY]: ['Treat artifactRef as an opaque harness archive handle, not a filesystem path. Decide from resultPreview, structuredResult, and toolCalls; rerun narrower only when a named missing fact or decision blocker remains.']
      };
    }
    return {
      [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.USE_RESULT
    };
  }

  const failureCategory = classifyProjectToolFailure(definition, record);
  switch (failureCategory) {
    case ProjectToolFailureCategory.BACKPRESSURE:
      return { [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.WAIT_FOR_IN_FLIGHT_RESULT };
    case ProjectToolFailureCategory.TERMINAL_GATE:
      return { [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.ROUTE_CONFIGURED_OUTCOME };
    case ProjectToolFailureCategory.TRANSIENT_TRANSPORT:
      return { [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.RETRY_ONCE };
    case ProjectToolFailureCategory.TOOL_INPUT_ERROR:
      return { [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.FIX_ARGUMENTS };
    case ProjectToolFailureCategory.UNAVAILABLE:
      return { [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.ROUTE_BLOCKED };
    case ProjectToolFailureCategory.WORKTREE_STATE_ERROR:
      return { [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.FIX_WORKTREE_STATE };
    case ProjectToolFailureCategory.VERIFIER_FAILED:
      return { [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.FIX_OR_ROUTE_FAILURE };
    default:
      return {};
  }
}

function projectToolResultNeedsNarrowing(record: Record<string, unknown>): boolean {
  const hasSufficientCompactEvidence = projectToolResultHasSufficientCompactEvidence(record);
  if (projectToolResultHasMessageNarrowingSignal(record)) return true;
  if (!hasSufficientCompactEvidence && projectToolResultHasPreviewNarrowingSignal(record)) return true;
  if (record.maxBufferExceeded === true) return true;
  if (record.outputTruncated === true || record.stdoutTruncated === true || record.stderrTruncated === true) {
    return !hasSufficientCompactEvidence;
  }
  return false;
}

function projectToolResultHasPreviewNarrowingSignal(record: Record<string, unknown>): boolean {
  return [
    record[ProjectToolResultKey.RESULT_PREVIEW],
    record.outputPreview
  ].some(projectToolPreviewSuggestsNarrowing);
}

function projectToolResultHasMessageNarrowingSignal(record: Record<string, unknown>): boolean {
  const structuredResult = record[ProjectToolResultKey.STRUCTURED_RESULT];
  const structuredMessage = isJsonRecord(structuredResult) ? structuredResult.message : undefined;
  const structuredError = isJsonRecord(structuredResult) ? structuredResult.error : undefined;
  return [
    record.message,
    structuredMessage,
    structuredError
  ].some(projectToolMessageSuggestsNarrowing);
}

function projectToolResultHasSufficientCompactEvidence(record: Record<string, unknown>): boolean {
  if (record.maxBufferExceeded === true) return false;
  if (projectToolResultHasCompletePreview(record)) return true;
  if (projectToolResultHasActionableTruncatedPreview(record)) return true;
  return structuredResultHasDecisionEvidence(record[ProjectToolResultKey.STRUCTURED_RESULT]);
}

function projectToolResultHasCompletePreview(record: Record<string, unknown>): boolean {
  const value = record[ProjectToolResultKey.RESULT_PREVIEW];
  return typeof value === 'string'
    && value.trim().length > 0
    && !projectToolPreviewSuggestsNarrowing(value);
}

function projectToolPreviewSuggestsNarrowing(value: unknown): boolean {
  return typeof value === 'string' && /\[truncated\b|too much data|rerun with narrower/i.test(value);
}

function projectToolMessageSuggestsNarrowing(value: unknown): boolean {
  return typeof value === 'string' && /truncated|too much data|rerun with narrower/i.test(value);
}

function projectToolResultHasActionableTruncatedPreview(record: Record<string, unknown>): boolean {
  const preview = record[ProjectToolResultKey.RESULT_PREVIEW];
  if (typeof preview !== 'string' || preview.trim().length === 0) return false;
  const tool = stringField(record, 'tool') || stringField(record[ProjectToolResultKey.STRUCTURED_RESULT], 'tool');
  const operation = stringField(record, 'operation') || stringField(record[ProjectToolResultKey.STRUCTURED_RESULT], 'operation');

  if (tool === CODEMAP_TOOL_NAME && codemapStructurePreviewHasOverview(preview, operation)) return true;
  if (tool === PYTHON_LSP_TOOL_NAME && pythonLspDiagnosticsPreviewHasEvidence(preview, operation)) return true;
  return false;
}

function stringField(value: unknown, key: string): string | undefined {
  return isJsonRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

function codemapStructurePreviewHasOverview(preview: string, operation?: string): boolean {
  if (operation && operation !== 'get_structure') return false;
  return /\bFiles:\s*\d+\b/.test(preview)
    && /\bTop Extensions:/.test(preview)
    && /\n[^\s].*/.test(preview);
}

function pythonLspDiagnosticsPreviewHasEvidence(preview: string, operation?: string): boolean {
  if (operation && operation !== 'diagnostics') return false;
  return /\bDiagnostics in File:\s*\d+\b/.test(preview)
    && /\b(?:ERROR|WARNING|INFO) at L\d+:C\d+:/i.test(preview);
}

// Exported for unit testing only — treat as package-internal.
export function structuredResultHasDecisionEvidence(value: unknown): boolean {
  if (!isJsonRecord(value)) return false;

  // For all evidence fields except 'counts', mere presence (non-undefined) qualifies.
  const presenceFields = [
    'artifact',
    'path',
    'message',
    'error',
    'verdict',
    'blocking_count',
    'total_errors',
    'context_count',
    'findingsDetected',
    'routingHint',
    'warnings',
    'outputFilters',
    ProjectToolResultKey.PASSED_CHECK_COUNT,
    ProjectToolResultKey.REJECTED_CHECK_COUNT,
    ProjectToolResultKey.REJECTED_CHECKS,
    ProjectToolResultKey.SCANNED_TARGET_COUNT,
    StructuredPayloadSummaryOutputKey.ERRORS_BY_TOOL,
    StructuredPayloadSummaryOutputKey.ERRORS_BY_FILE,
    StructuredPayloadSummaryOutputKey.TOOL_RESULTS
  ];
  if (presenceFields.some(key => value[key] !== undefined)) return true;

  // 'counts' requires a non-empty object with at least one numeric value > 0.
  //
  // Invariant: today the only producer of 'counts' is the diagnostic summarizer
  // (diagnosticSummarizer, ~line 2330), which returns null when diagnostics.length === 0,
  // so an empty or all-zero counts record is never emitted in practice.  This guard makes
  // that invariant self-enforcing: if a future summarizer emits 'counts' on a zero-item
  // result, or if 'counts' is added to the passthrough whitelist, an empty/all-zero value
  // will still NOT be treated as decision evidence.
  const counts = value['counts'];
  if (isJsonRecord(counts)) {
    return Object.values(counts).some(v => typeof v === 'number' && v > 0);
  }

  return false;
}

function projectToolRemediation(
  definition: Pick<ProjectToolConfig, 'name'>,
  failureCategory: ProjectToolFailureCategory,
  result: unknown
): string[] {
  const guidance = new Set<string>();
  const toolName = definition.name;
  const text = searchableFailureText(result);

  if (toolName === ARTIFACT_VALIDATOR_TOOL_NAME) {
    guidance.add('Treat artifact_validator output as an authoritative gate: use structuredResult, rejectedChecks, diagnosticPreview, and routingHint to revise the plan/artifact or route the configured failure edge.');
    guidance.add('Do not rerun artifact_validator unchanged after a terminal gate rejection.');
  }

  if (toolName === AST_GREP_TOOL_NAME) {
    guidance.add('For ast_grep failures, adjust the pattern/language/path and rerun with narrower arguments; do not fall back to shell grep for configured project-tool coverage.');
    if (/exitCode["']?:?1|NO_MATCH|no match/i.test(text)) {
      guidance.add('Exit code 1 from ast-grep usually means no match, not infrastructure failure; record the no-match evidence if that satisfies the check.');
    }
  }

  if (toolName === CODEMAP_TOOL_NAME) {
    guidance.add('For codemap failures, pass worktree-relative paths or paths under the active bead worktree; do not pass project-root, sibling-worktree, or harness artifact paths.');
  }

  if (toolName === 'read') {
    guidance.add('For read failures, reduce the requested range and target only files inside the active bead worktree; use configured artifact/project tools for harness artifacts.');
  }

  switch (failureCategory) {
    case ProjectToolFailureCategory.BACKPRESSURE:
      guidance.add('Do not start another copy of this project tool while one is already in flight for the same bead/state/action; wait for the existing result, then rerun narrower only if needed.');
      break;
    case ProjectToolFailureCategory.TERMINAL_GATE:
      guidance.add('A terminal gate has already produced the routing decision; update the failing artifact/plan or route the configured outcome instead of retrying the same input.');
      break;
    case ProjectToolFailureCategory.TRANSIENT_TRANSPORT:
      guidance.add('Retry the same configured project tool once with the same scoped arguments; if transport failures repeat, request a context or harness restart according to the phase protocol.');
      break;
    case ProjectToolFailureCategory.TOOL_INPUT_ERROR:
      guidance.add('Correct the tool arguments using the configured operation, allowlist, and path contract; do not substitute native shell/MCP calls.');
      break;
    case ProjectToolFailureCategory.UNAVAILABLE:
      guidance.add('If the named configured project tool is unavailable, route BLOCKED with the exact tool name and message unless the phase defines a narrower fallback.');
      break;
    case ProjectToolFailureCategory.WORKTREE_STATE_ERROR:
      guidance.add('Fix the active worktree or approved write-set mismatch, then rerun the configured tool; do not bypass the worktree boundary.');
      break;
    case ProjectToolFailureCategory.VERIFIER_FAILED:
      guidance.add('Use diagnosticPreview, structuredResult, and rejectedChecks to fix the implementation or route the configured failure edge.');
      break;
  }

  return [...guidance];
}

async function projectToolFailureLimit(
  eventStore: EventStore,
  definition: ProjectToolConfig,
  context: ProjectToolExecutionContext
): Promise<ProjectToolFailureLimitResult> {
  const maxFailures = definition.failureLimit?.maxFailuresPerState;
  if (typeof maxFailures !== 'number' || !Number.isFinite(maxFailures) || maxFailures <= 0) {
    return { reached: false, failureCount: 0, maxFailures: 0 };
  }

  const beadId = context.templateContext.beadId;
  if (!beadId || beadId === ProjectToolDefaults.UNASSIGNED_BEAD_ID) {
    return { reached: false, failureCount: 0, maxFailures };
  }

  const stateId = context.templateContext.stateId;
  const actionId = context.templateContext.actionId;
  const events = await eventStore.eventsForBead(beadId);
  const activeRunEvents = eventsForActiveProjectToolRun(events, stateId, actionId);
  const matchingFailures = activeRunEvents.filter(event => {
    const data = event.data || {};
    if (event.type !== DomainEventName.PROJECT_TOOL_FAILED) return false;
    if (data.tool !== definition.name) return false;
    if (stateId && data.stateId !== stateId) return false;
    if (actionId && data.actionId !== actionId) return false;
    if (data.failureCategory === ProjectToolFailureCategory.BACKPRESSURE || data.result?.failureCategory === ProjectToolFailureCategory.BACKPRESSURE) return false;
    if (isInfrastructureProjectToolFailure(data.error) || isInfrastructureProjectToolFailure(data.result)) return false;
    return true;
  });
  const failureCount = matchingFailures.length;

  if (failureCount < maxFailures) {
    return { reached: false, failureCount, maxFailures };
  }

  return {
    reached: true,
    failureCount,
    maxFailures,
    result: buildProjectToolFailureLimitResult(
      definition,
      failureCount,
      maxFailures,
      stateId,
      actionId,
      [...matchingFailures].reverse().map(failureLimitSuggestedOutcomeFromEvent).find(Boolean)
    )
  };
}

function eventsForActiveProjectToolRun(
  events: DomainEvent[],
  stateId?: string,
  actionId?: string
): DomainEvent[] {
  if (!stateId) return events;
  let startIndex = 0;
  let terminalOutcomeAcknowledged = false;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (isProjectToolFailureWindowBoundary(event, stateId, actionId)) {
      startIndex = index + 1;
      terminalOutcomeAcknowledged = false;
      continue;
    }
    if (isProjectToolTerminalOutcomeAcknowledged(event, stateId, actionId)) {
      terminalOutcomeAcknowledged = true;
      continue;
    }
    if (terminalOutcomeAcknowledged && isProjectToolStateRunStart(event, stateId, actionId)) {
      startIndex = index + 1;
      terminalOutcomeAcknowledged = false;
    }
  }
  return events.slice(startIndex);
}

function isProjectToolFailureWindowBoundary(
  event: DomainEvent,
  stateId: string,
  actionId?: string
): boolean {
  if (event.type !== DomainEventName.STATE_TRANSITION_APPLIED) return false;
  const data = event.data || {};
  if (isRestartTransition(data.transitionEvent)) return false;
  if (data.fromState !== stateId && data.nextState !== stateId) return false;
  if (actionId && data.actionId && data.actionId !== actionId) return false;
  return true;
}

function isProjectToolTerminalOutcomeAcknowledged(
  event: DomainEvent,
  stateId: string,
  actionId?: string
): boolean {
  if (event.type !== DomainEventName.SIGNAL_ACKNOWLEDGED) return false;
  const data = event.data || {};
  if (
    data.type !== TeammateEventType.STATE_FAILED
    && data.type !== TeammateEventType.STATE_BLOCKED
    && data.type !== TeammateEventType.STATE_TRANSITIONED
  ) {
    return false;
  }
  if (isRestartTransition(data.transitionEvent)) return false;
  if (data.stateId !== stateId) return false;
  if (actionId && data.actionId && data.actionId !== actionId) return false;
  return true;
}

function isProjectToolStateRunStart(
  event: DomainEvent,
  stateId: string,
  actionId?: string
): boolean {
  if (event.type !== DomainEventName.STATE_RUN_INITIALIZED) return false;
  const data = event.data || {};
  if (data.stateId !== stateId) return false;
  if (actionId && data.actionId && data.actionId !== actionId) return false;
  return true;
}

function summarizeToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    status: record.status,
    success: record.success,
    message: record.message,
    tool: record.tool,
    server: record.server,
    operation: record.operation,
    [ProjectToolResultKey.MATCH_STATUS]: record[ProjectToolResultKey.MATCH_STATUS],
    [ProjectToolResultKey.FAILURE_CATEGORY]: record[ProjectToolResultKey.FAILURE_CATEGORY],
    [ProjectToolResultKey.REMEDIATION]: record[ProjectToolResultKey.REMEDIATION],
    failureLimit: record.failureLimit,
    lockTimeout: record.lockTimeout,
    lockMetadata: record.lockMetadata,
    routingHint: record.routingHint,
    [ProjectToolResultKey.SCANNED_TARGET_COUNT]: record[ProjectToolResultKey.SCANNED_TARGET_COUNT],
    [ProjectToolResultKey.SCANNED_TARGET_SAMPLES]: record[ProjectToolResultKey.SCANNED_TARGET_SAMPLES],
    [ProjectToolResultKey.NEXT_ACTION]: record[ProjectToolResultKey.NEXT_ACTION],
    [ProjectToolResultKey.RECOVERY]: record[ProjectToolResultKey.RECOVERY],
    [ProjectToolResultKey.RESULT_PREVIEW]: record[ProjectToolResultKey.RESULT_PREVIEW],
    [ProjectToolResultKey.DIAGNOSTIC_PREVIEW]: record[ProjectToolResultKey.DIAGNOSTIC_PREVIEW],
    [DIAGNOSTIC_SUMMARY_KEY]: record[DIAGNOSTIC_SUMMARY_KEY],
    [ProjectToolResultKey.STRUCTURED_RESULT]: record[ProjectToolResultKey.STRUCTURED_RESULT]
  };
  for (const key of ['stdout', 'stderr', 'output', 'result']) {
    const value = record[key];
    if (typeof value === 'string') {
      summary[`${key}Bytes`] = value.length;
      summary[`${key}Preview`] = value.length > WorkerDefaults.EVENT_PREVIEW_CHARS
        ? `${value.slice(0, WorkerDefaults.EVENT_PREVIEW_CHARS)}...`
        : value;
    } else if (value !== undefined) {
      try {
        const json = JSON.stringify(value);
        summary[`${key}Bytes`] = json.length;
        summary[`${key}Preview`] = json.length > WorkerDefaults.EVENT_PREVIEW_CHARS
          ? `${json.slice(0, WorkerDefaults.EVENT_PREVIEW_CHARS)}...`
          : value;
      } catch {
        summary[`${key}Preview`] = String(value);
      }
    }
  }
  return summary;
}

function inlineResultLimit(definition: ProjectToolConfig): number {
  const configured = definition.inlineResultBytes;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.min(configured, ProjectToolDefaults.INLINE_RESULT_BYTES);
  }
  return ProjectToolDefaults.INLINE_RESULT_BYTES;
}

function outputPreviewLimit(inlineBytes: number): number {
  return Math.min(inlineBytes, ProjectToolDefaults.OUTPUT_PREVIEW_BYTES);
}

function baseResultSummary(definition: ProjectToolConfig, result: Record<string, unknown>): Record<string, unknown> {
  return withoutUndefined({
    tool: typeof result.tool === 'string' ? result.tool : definition.name,
    status: result.status,
    exitCode: result.exitCode,
    server: result.server,
    operation: result.operation,
    message: result.message,
    timedOut: result.timedOut,
    signal: result.signal,
    failureLimit: result.failureLimit,
    lockTimeout: result.lockTimeout,
    lockMetadata: result.lockMetadata,
    [ProjectToolResultKey.MATCH_STATUS]: result[ProjectToolResultKey.MATCH_STATUS],
    [ProjectToolResultKey.FAILURE_CATEGORY]: result[ProjectToolResultKey.FAILURE_CATEGORY],
    [ProjectToolResultKey.REMEDIATION]: result[ProjectToolResultKey.REMEDIATION],
    [ProjectToolResultKey.RESULT_PREVIEW]: result[ProjectToolResultKey.RESULT_PREVIEW],
    [DIAGNOSTIC_SUMMARY_KEY]: result[DIAGNOSTIC_SUMMARY_KEY],
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    [ProjectToolResultKey.SCANNED_TARGET_COUNT]: result[ProjectToolResultKey.SCANNED_TARGET_COUNT],
    [ProjectToolResultKey.SCANNED_TARGET_SAMPLES]: result[ProjectToolResultKey.SCANNED_TARGET_SAMPLES],
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    maxBufferExceeded: result.maxBufferExceeded,
    [ProjectToolResultKey.STRUCTURED_RESULT]: result[ProjectToolResultKey.STRUCTURED_RESULT]
  });
}

const MODEL_HIDDEN_RESULT_KEYS = new Set<string>([
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

/**
 * Raw payload keys suppressed from the model-facing result when a compact structured
 * model summary is present (structuredResult or diagnosticSummary).  The full raw
 * content is preserved in the output archive and remains recoverable via the existing
 * archive path — only the inline model-facing payload is bounded.
 *
 * Named constant so the suppression set has a stable identity and is reusable across
 * the inline and preview paths.
 */
const MODEL_RAW_SUPPRESSED_KEYS = new Set<string>([
  ProjectToolResultKey.STDOUT,
  ProjectToolResultKey.STDERR,
  'output',
  'result'
]);

function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function resultRecord(result: unknown): Record<string, unknown> {
  return isJsonRecord(result) ? result : { result };
}

function modelFacingInlineResult(result: unknown): ModelFacingProjectToolResult {
  const record = resultRecord(result);
  // When a structuredResult OR diagnosticSummary is present the compact structured
  // payload is the authoritative model-facing representation.  Suppress the raw
  // stdout/stderr/output/result fields (which can be tens of KiB) and keep
  // RESULT_PREVIEW visible so the compact summary reaches the model.  All other keys
  // follow the standard MODEL_HIDDEN_RESULT_KEYS filter unchanged.
  //
  // This is a strict superset of the 7i0 diagnostic-suppression behavior:
  //   - hasDiagnosticSummary=true  → hasStructuredModelSummary=true  (7i0 path preserved)
  //   - hasStructuredResult=true   → hasStructuredModelSummary=true  (new generalization)
  //
  // Requirement 4 (failures stay actionable): failureCategory, diagnosticPreview, and
  // the compact RESULT_PREVIEW all remain visible; the raw content is archived.
  const hasStructuredModelSummary =
    Boolean(record[ProjectToolResultKey.STRUCTURED_RESULT]) || Boolean(record[DIAGNOSTIC_SUMMARY_KEY]);
  const hiddenKeys = hasStructuredModelSummary
    ? new Set([
        ...MODEL_HIDDEN_RESULT_KEYS,
        ...MODEL_RAW_SUPPRESSED_KEYS
      ].filter(k => k !== ProjectToolResultKey.RESULT_PREVIEW))
    : MODEL_HIDDEN_RESULT_KEYS;
  const modelFacing = Object.fromEntries(
    Object.entries(record).filter(([key, value]) => !hiddenKeys.has(key) && value !== undefined)
  );
  const toolCalls = toolCallsFromRecord(record);
  if (toolCalls && !Array.isArray(modelFacing[ProjectToolResultKey.TOOL_CALLS])) {
    modelFacing[ProjectToolResultKey.TOOL_CALLS] = toolCalls;
  }
  // MUST-FIX 1 (b77h req 4 / inline-path blind spot): when a structuredResult is present
  // on a FAILURE record the raw stdout/stderr are suppressed by b77h.  Ensure the agent
  // always sees a bounded real-failure tail via diagnosticPreview — the same guarantee that
  // the truncated path already provides (~line 2987).  diagnosticPreview is NOT in
  // MODEL_RAW_SUPPRESSED_KEYS so it survives the filter above; we only need to compute and
  // inject it when absent.
  if (
    hasStructuredModelSummary
    && record.status !== ToolResultStatus.PASSED
    && !modelFacing[ProjectToolResultKey.DIAGNOSTIC_PREVIEW]
  ) {
    const dp = commandDiagnosticPreview(record);
    if (dp) modelFacing[ProjectToolResultKey.DIAGNOSTIC_PREVIEW] = dp;
  }
  return modelFacing;
}

function hasArchivedStream(record: Record<string, unknown>): boolean {
  return record.stdoutTruncated === true
    || record.stderrTruncated === true
    || record.maxBufferExceeded === true;
}

function outputArtifactRef(context: ProjectToolExecutionContext): string {
  const invocationId = context.templateContext.toolInvocationId || path.basename(context.outputFile, '.json');
  return `project-tool-output:${invocationId}`;
}

function outputArchiveSummary(context: ProjectToolExecutionContext, bytes: number, truncated: boolean): ProjectToolOutputArchive {
  return {
    artifactRef: outputArtifactRef(context),
    bytes,
    truncated
  };
}

function projectToolRunEventData(
  definition: ProjectToolConfig,
  context: ProjectToolExecutionContext,
  beadId: string | undefined,
  stateId: string | undefined,
  actionId: string | undefined
): Record<string, unknown> {
  return {
    beadId,
    stateId,
    actionId,
    tool: definition.name,
    type: definition.type,
    cwd: context.cwd,
    toolInvocationId: context.templateContext.toolInvocationId,
    outputArchive: {
      artifactRef: outputArtifactRef(context)
    }
  };
}

function outputPreviewText(definition: ProjectToolConfig, record: Record<string, unknown>, serialized: string, limitBytes: number): string {
  const summary = baseResultSummary(definition, record);
  const summaryText = Object.keys(summary).length > 0 ? JSON.stringify(summary, null, 2) : '';
  const previewSource = summaryText || serialized;
  if (previewSource.length <= limitBytes) return previewSource;
  return `${previewSource.slice(0, limitBytes)}\n\n[truncated ${previewSource.length - limitBytes} characters; full result archived by harness]`;
}

function boundedPreviewText(value: string, limitBytes: number): string {
  if (value.length <= limitBytes) return value;
  return `${value.slice(0, limitBytes)}\n\n[truncated ${value.length - limitBytes} characters; use this preview first, then rerun narrower only for a named missing fact or decision blocker]`;
}

function diagnosticToolName(definition: ProjectToolConfig, record: Record<string, unknown>): string {
  return [
    definition.name,
    stringField(record, 'tool'),
    stringField(record[ProjectToolResultKey.STRUCTURED_RESULT], 'tool')
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
}

function diagnosticOperationName(record: Record<string, unknown>): string | undefined {
  return stringField(record, 'operation')
    || stringField(record[ProjectToolResultKey.STRUCTURED_RESULT], 'operation');
}

function diagnosticsTextFromRecord(record: Record<string, unknown>): string | undefined {
  const mcpText = textFromMcpContent(record.result);
  const mcpJson = parseJsonRecord(mcpText);
  const stdoutRecord = parseJsonRecord(record[ProjectToolResultKey.STDOUT]);
  const candidates = [
    record[ProjectToolResultKey.RESULT_PREVIEW],
    stdoutRecord?.stdout,
    stdoutRecord?.stderr,
    mcpJson?.stdout,
    mcpJson?.stderr,
    mcpText,
    record[ProjectToolResultKey.STDOUT],
    record[ProjectToolResultKey.STDERR],
    record.output
  ];
  return candidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function shouldSummarizeDiagnostics(
  definition: ProjectToolConfig,
  record: Record<string, unknown>,
  text: string
): boolean {
  const toolName = diagnosticToolName(definition, record);
  const operation = diagnosticOperationName(record);
  return toolName.includes(PYTHON_LSP_TOOL_NAME)
    || operation === 'diagnostics'
    || /\bDiagnostics in File:\s*\d+\b/.test(text);
}

function parseDiagnosticMetadata(messageWithMetadata: string): {
  message: string;
  source?: string;
  code?: string;
} {
  const metadata = messageWithMetadata.match(/\s*\(Source:\s*([^,()]+?)(?:,\s*Code:\s*([^)]+?))?\)\s*$/i);
  if (!metadata) return { message: messageWithMetadata.trim() };
  return withoutUndefined({
    message: messageWithMetadata.slice(0, metadata.index).trim(),
    source: metadata[1]?.trim(),
    code: metadata[2]?.trim()
  }) as { message: string; source?: string; code?: string };
}

function normalizeDiagnosticSeverity(value: string): string {
  const severity = value.trim().toUpperCase();
  if (severity === 'INFORMATION') return 'INFO';
  return severity;
}

function parseAtDiagnosticLine(line: string, currentFile: string | undefined): ParsedProjectDiagnostic | undefined {
  const match = line.match(/^(ERROR|WARNING|INFO|INFORMATION|HINT)\s+at\s+L(\d+):C(\d+):\s+(.+)$/i);
  if (!match) return undefined;
  const metadata = parseDiagnosticMetadata(match[4]);
  return withoutUndefined({
    severity: normalizeDiagnosticSeverity(match[1]),
    file: currentFile,
    line: Number.parseInt(match[2], 10),
    column: Number.parseInt(match[3], 10),
    ...metadata
  }) as unknown as ParsedProjectDiagnostic;
}

function parseColonDiagnosticLine(line: string): ParsedProjectDiagnostic | undefined {
  const match = line.match(/^(.+?):(\d+):(\d+)\s*(?:-|:)\s*(error|warning|info|information|hint):\s+(.+)$/i);
  if (!match) return undefined;
  const metadata = parseDiagnosticMetadata(match[5]);
  const codeMatch = metadata.message.match(/\s+\[([^\]]+)\]\s*$/);
  const message = codeMatch ? metadata.message.slice(0, codeMatch.index).trim() : metadata.message;
  return withoutUndefined({
    severity: normalizeDiagnosticSeverity(match[4]),
    file: match[1].trim(),
    line: Number.parseInt(match[2], 10),
    column: Number.parseInt(match[3], 10),
    ...metadata,
    message,
    code: metadata.code || codeMatch?.[1]?.trim()
  }) as unknown as ParsedProjectDiagnostic;
}

function parseProjectDiagnostics(text: string): ParsedProjectDiagnostics {
  const diagnostics: ParsedProjectDiagnostic[] = [];
  let currentFile: string | undefined;
  let declaredDiagnostics = 0;
  let sawDeclaredDiagnostics = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (DIAGNOSTIC_TRUNCATION_PATTERN.test(line)) continue;

    const declared = line.match(/^Diagnostics in File:\s*(\d+)\b/i);
    if (declared) {
      declaredDiagnostics += Number.parseInt(declared[1], 10);
      sawDeclaredDiagnostics = true;
      continue;
    }

    const diagnostic = parseAtDiagnosticLine(line, currentFile) || parseColonDiagnosticLine(line);
    if (diagnostic) {
      diagnostics.push(diagnostic);
      continue;
    }

    currentFile = line;
  }

  return withoutUndefined({
    diagnostics,
    declaredDiagnostics: sawDeclaredDiagnostics ? declaredDiagnostics : undefined,
    sourceTruncated: DIAGNOSTIC_TRUNCATION_PATTERN.test(text)
  }) as unknown as ParsedProjectDiagnostics;
}

function severityRank(severity: string): number {
  switch (severity.toUpperCase()) {
    case 'ERROR':
      return 0;
    case 'WARNING':
      return 1;
    case 'INFO':
      return 2;
    default:
      return 3;
  }
}

function isMissingImportDiagnostic(diagnostic: ParsedProjectDiagnostic): boolean {
  const code = (diagnostic.code || '').toLowerCase();
  return code === 'reportmissingimports'
    || code === 'reportmissingmodulesource'
    || /^Import\s+["'][^"']+["']\s+could not be resolved/i.test(diagnostic.message);
}

function diagnosticMessagePrefix(diagnostic: ParsedProjectDiagnostic): string {
  if (isMissingImportDiagnostic(diagnostic)) {
    if (/could not be resolved from source/i.test(diagnostic.message)) {
      return 'Import "<module>" could not be resolved from source';
    }
    return 'Import "<module>" could not be resolved';
  }

  const normalized = diagnostic.message
    .replace(/"[^"]*"/g, '"<value>"')
    .replace(/'[^']*'/g, "'<value>'")
    .replace(/\b\d+\b/g, '<number>')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > DIAGNOSTIC_MESSAGE_PREFIX_CHARS
    ? `${normalized.slice(0, DIAGNOSTIC_MESSAGE_PREFIX_CHARS)}...`
    : normalized;
}

function displayDiagnosticPath(file: string | undefined, context: ProjectToolExecutionContext): string {
  if (!file) return '<unknown>';
  const normalized = file.trim();
  if (!path.isAbsolute(normalized)) return normalized.replace(/\\/g, '/');

  const worktreePath = context.templateContext.worktreePath;
  if (worktreePath && isInsidePath(worktreePath, normalized)) {
    const relative = path.relative(worktreePath, normalized) || '.';
    return relative.replace(/\\/g, '/');
  }

  const projectRoot = context.templateContext.projectRoot;
  if (projectRoot && isInsidePath(projectRoot, normalized)) {
    const relative = path.relative(projectRoot, normalized) || '.';
    return relative.replace(/\\/g, '/');
  }

  return normalized.replace(/\\/g, '/');
}

function diagnosticLocation(diagnostic: ParsedProjectDiagnostic, context: ProjectToolExecutionContext): string {
  const location = displayDiagnosticPath(diagnostic.file, context);
  if (diagnostic.line !== undefined && diagnostic.column !== undefined) {
    return `${location}:${diagnostic.line}:${diagnostic.column}`;
  }
  if (diagnostic.line !== undefined) return `${location}:${diagnostic.line}`;
  return location;
}

function diagnosticGroupKey(diagnostic: ParsedProjectDiagnostic): string {
  return [
    diagnostic.source || 'unknown',
    diagnostic.code || 'no-code',
    diagnosticMessagePrefix(diagnostic)
  ].join('\0');
}

function summarizeParsedDiagnostics(
  parsed: ParsedProjectDiagnostics,
  context: ProjectToolExecutionContext
): ProjectDiagnosticSummary | undefined {
  if (parsed.diagnostics.length === 0) return undefined;

  const groups = new Map<string, DiagnosticGroupAccumulator>();
  let missingImportCount = 0;

  parsed.diagnostics.forEach((diagnostic, index) => {
    const missingImport = isMissingImportDiagnostic(diagnostic);
    if (missingImport) missingImportCount += 1;

    const key = diagnosticGroupKey(diagnostic);
    const existing = groups.get(key);
    const location = diagnosticLocation(diagnostic, context);
    if (existing) {
      existing.count += 1;
      if (
        existing.representativeLocations.length < DIAGNOSTIC_SUMMARY_LOCATION_LIMIT
        && !existing.representativeLocations.includes(location)
      ) {
        existing.representativeLocations.push(location);
      }
      return;
    }

    groups.set(key, {
      source: diagnostic.source || 'unknown',
      code: diagnostic.code || 'no-code',
      severity: diagnostic.severity,
      messagePrefix: diagnosticMessagePrefix(diagnostic),
      count: 1,
      missingImport,
      representativeLocations: [location],
      sortIndex: index,
      severityRank: severityRank(diagnostic.severity)
    });
  });

  const sortedGroups = [...groups.values()].sort((left, right) => {
    if (left.missingImport !== right.missingImport) return left.missingImport ? 1 : -1;
    if (left.severityRank !== right.severityRank) return left.severityRank - right.severityRank;
    if (left.count !== right.count) return right.count - left.count;
    return left.sortIndex - right.sortIndex;
  });
  const groupLimit = ProjectToolDefaults.STRUCTURED_SUMMARY_MAX_GROUPS;
  const visibleGroups = sortedGroups.slice(0, groupLimit).map(group => ({
    source: group.source,
    code: group.code,
    severity: group.severity,
    messagePrefix: group.messagePrefix,
    count: group.count,
    missingImport: group.missingImport,
    representativeLocations: group.representativeLocations
  }));
  const totalDiagnostics = Math.max(parsed.declaredDiagnostics || 0, parsed.diagnostics.length);

  return withoutUndefined({
    totalDiagnostics,
    parsedDiagnostics: parsed.diagnostics.length,
    declaredDiagnostics: parsed.declaredDiagnostics,
    missingImportCount,
    sourceTruncated: parsed.sourceTruncated,
    groups: visibleGroups,
    omittedGroups: sortedGroups.length > visibleGroups.length ? sortedGroups.length - visibleGroups.length : undefined,
    nextAction: 'inspect_non_import_groups_first_then_rerun_narrowly_if_more_locations_are_needed'
  }) as unknown as ProjectDiagnosticSummary;
}

function diagnosticSummaryPreview(summary: ProjectDiagnosticSummary): string {
  const lines = [
    `Diagnostics in File: ${summary.totalDiagnostics}`,
    `Summary: ${summary.parsedDiagnostics} parsed; ${summary.missingImportCount} missing-import diagnostics grouped; ${summary.groups.length} groups shown.`
  ];
  if (summary.sourceTruncated) {
    lines.push('Source preview was truncated; full raw diagnostics remain archived by the harness.');
  }
  lines.push('Inspect non-import groups first; reportMissingImports noise is grouped separately.');
  lines.push('Groups:');

  summary.groups.forEach((group, index) => {
    const code = group.code === 'no-code' ? 'no-code' : group.code;
    lines.push(`${index + 1}. ${group.severity} ${group.source}/${code} count=${group.count}: ${group.messagePrefix}`);
    lines.push(`   locations: ${group.representativeLocations.join(', ')}`);
  });

  if (summary.omittedGroups) lines.push(`Omitted groups: ${summary.omittedGroups}`);
  lines.push(`Next action: ${summary.nextAction}.`);
  return lines.join('\n');
}

function diagnosticSummaryForRecord(
  definition: ProjectToolConfig,
  record: Record<string, unknown>,
  context: ProjectToolExecutionContext
): ProjectDiagnosticSummary | undefined {
  const text = diagnosticsTextFromRecord(record);
  if (!text || !shouldSummarizeDiagnostics(definition, record, text)) return undefined;
  return summarizeParsedDiagnostics(parseProjectDiagnostics(text), context);
}

function applyDiagnosticModelSummary(
  definition: ProjectToolConfig,
  result: unknown,
  context: ProjectToolExecutionContext
): unknown {
  const record = resultRecord(result);
  const summary = diagnosticSummaryForRecord(definition, record, context);
  if (!summary) return result;

  return withoutUndefined({
    ...record,
    [DIAGNOSTIC_SUMMARY_KEY]: summary,
    [ProjectToolResultKey.RESULT_PREVIEW]: diagnosticSummaryPreview(summary)
  });
}

// ---------------------------------------------------------------------------
// Per-tool structured summarizer registry
// ---------------------------------------------------------------------------

/**
 * Diagnostic summarizer — wraps the existing applyDiagnosticModelSummary logic
 * so it participates in the general registry.  This is always the first entry;
 * it preserves the exact behavior established by bead 7i0.
 */
const diagnosticSummarizer: ProjectToolSummarizer = {
  name: 'diagnostic',
  appliesTo(definition: ProjectToolConfig, record: Record<string, unknown>): boolean {
    const text = diagnosticsTextFromRecord(record);
    if (!text) return false;
    return shouldSummarizeDiagnostics(definition, record, text);
  },
  summarize(
    definition: ProjectToolConfig,
    record: Record<string, unknown>,
    context: ProjectToolExecutionContext
  ): StructuredResult | null {
    const text = diagnosticsTextFromRecord(record);
    if (!text) return null;
    try {
      const summary = summarizeParsedDiagnostics(parseProjectDiagnostics(text), context);
      if (!summary) return null;
      const affectedPaths = summary.groups
        .flatMap(group => group.representativeLocations)
        .slice(0, ProjectToolDefaults.SUMMARIZER_MAX_AFFECTED_PATHS);
      const counts: Record<string, number> = {
        total: summary.totalDiagnostics,
        parsed: summary.parsedDiagnostics,
        missingImport: summary.missingImportCount,
        groups: summary.groups.length
      };
      if (summary.omittedGroups) counts.omittedGroups = summary.omittedGroups;
      const structured: StructuredResult = {
        status: 'ok',
        counts
      };
      if (affectedPaths.length > 0) structured.affectedPaths = affectedPaths;
      // representativeSamples: one compact object per top-N groups (capped by the registry constant).
      const representativeSamples = summary.groups
        .slice(0, ProjectToolDefaults.SUMMARIZER_MAX_REPRESENTATIVE_SAMPLES)
        .map(group => ({
          severity: group.severity,
          source: group.source,
          code: group.code,
          count: group.count,
          messagePrefix: group.messagePrefix,
          location: group.representativeLocations[0]
        }));
      if (representativeSamples.length > 0) structured.representativeSamples = representativeSamples;
      if (summary.omittedGroups) {
        structured.omissions = `${summary.omittedGroups} diagnostic groups omitted from summary`;
      }
      if (summary.nextAction) structured.nextAction = summary.nextAction;
      return structured;
    } catch {
      // Defensive guard — parseProjectDiagnostics and summarizeParsedDiagnostics do not
      // currently throw, but we keep this catch to ensure the summarizer contract
      // (must not propagate exceptions) holds if that ever changes.
      return { status: 'parse_error', nextAction: 'inspect_raw_archive_if_needed' };
    }
  }
};

// ---------------------------------------------------------------------------
// commandFailureSummarizer — plain-text command failure grouper
// ---------------------------------------------------------------------------

/**
 * Pattern that detects pytest/vitest/jest-style test failure header lines.
 * Matches lines like:
 *   FAILED tests/test_foo.py::test_bar - AssertionError: ...
 *   ✗ src/foo.test.ts > describe > test name
 *   × test name (vitest "×" marker)
 *   FAIL src/foo.test.ts
 */
const CMD_FAIL_TEST_FAILURE_PATTERN =
  /^(?:FAILED|FAIL\s+\S|✗|×|●)\s+(\S+?(?:::\S+)?)\s*(?:-\s*(.+))?$|^(?:FAILED|FAIL)\s+(\S+(?:\s+>\s+\S+)+)/m;

/**
 * Pattern for individual test-failure lines we want to collect.
 * Covers pytest (FAILED tests/foo.py::test_x), vitest (✗/×), jest (●).
 */
const CMD_FAIL_TEST_LINE_PATTERN =
  /^(?:FAILED|✗|×|●)\s+(\S+(?:::\S+|\s+>\s+\S+)*)/;

/**
 * Pytest section header for failures (marks start of a failure block).
 */
const CMD_FAIL_PYTEST_SECTION_PATTERN =
  /^_{3,}\s+(\S.+?)\s+_{3,}$/;

/**
 * Pattern for assertion/error type lines within a failure block.
 * Matches lines like: "AssertionError: ...", "TypeError: ...", "E  assert ...".
 */
const CMD_FAIL_ASSERTION_PATTERN =
  /^(?:E\s{2,})?([A-Za-z][A-Za-z0-9_]*Error|[A-Za-z][A-Za-z0-9_]*Exception|AssertionError|assert\b)[\s:](.{0,120})/;

/**
 * Pattern for file:line traceback references.
 * Matches: "  File \"path/to/file.py\", line 42, in function_name"
 * and also compact forms like "path/to/file.ts:42:5".
 */
const CMD_FAIL_TRACEBACK_LINE_PATTERN =
  /(?:File\s+"([^"]+)",\s+line\s+(\d+))|(?:^\s+at\s+\S+\s+\(([^)]+):(\d+):\d+\))|(?:^(\S+\.(py|ts|js|tsx|jsx|rb|go|rs|java|cs|cpp|c|h):\d+))/m;

/**
 * Pattern for linter/scanner rule violations.
 * Covers: ESLint (file:line:col  rule/code  message), flake8, pylint, ruff, tsc,
 * semgrep-text, and generic "file:line:col: severity: message" patterns.
 *
 * Group 1: file path
 * Group 2: line number
 * Group 3+: severity/code/message (varies by format)
 */
const CMD_FAIL_LINT_LINE_PATTERN =
  /^(\S[^:]*\.[a-zA-Z]{1,8}):(\d+)(?::\d+)?:?\s+(?:(error|warning|note|info|hint)\s*[:—\-]\s*)?(.{0,180})/i;

/**
 * Pattern for ESLint-style "  rule/code" on a following line (indented rule name).
 */
const CMD_FAIL_ESLINT_RULE_PATTERN =
  /^\s{2,}([a-z][\w/.-]{2,50})\s*$/;

/**
 * Pattern for a severity word at the start of a message (for classification).
 */
const CMD_FAIL_SEVERITY_WORD_PATTERN =
  /^(error|warning|warn|note|info|hint)\b/i;

/**
 * Pattern for timeout/maxBuffer/signal/transport indicators in failure output.
 */
const CMD_FAIL_TIMEOUT_PATTERN =
  /\b(?:timed?\s*out|timeout|ETIMEDOUT|SIGALRM)\b/i;
const CMD_FAIL_MAX_BUFFER_PATTERN =
  /\b(?:ERR_CHILD_PROCESS_STDIO_MAXBUFFER|maxBuffer|max[_-]?buffer)\b/i;
const CMD_FAIL_SIGNAL_PATTERN =
  /\b(?:SIGKILL|SIGTERM|SIGABRT|SIGSEGV|killed|signal\s+\d+)\b/i;
const CMD_FAIL_TRANSPORT_PATTERN =
  /\b(?:ECONNRESET|EPIPE|ENOSPC|transport\s+error|connection\s+reset)\b/i;

/** Returns true when the record represents a plain-text command failure with no richer structuredResult. */
function isPlainTextCommandFailure(record: Record<string, unknown>): boolean {
  const status = record.status;
  // Must be a failure/rejection
  if (status === ToolResultStatus.PASSED) return false;
  // Must have plain-text stdout or stderr
  const hasPlainText =
    (typeof record[ProjectToolResultKey.STDOUT] === 'string' && (record[ProjectToolResultKey.STDOUT] as string).trim().length > 0)
    || (typeof record[ProjectToolResultKey.STDERR] === 'string' && (record[ProjectToolResultKey.STDERR] as string).trim().length > 0);
  if (!hasPlainText) return false;
  // If stdout is JSON-parseable (structuredPayloadSummary territory), skip this summarizer.
  const stdoutStr = typeof record[ProjectToolResultKey.STDOUT] === 'string' ? record[ProjectToolResultKey.STDOUT] as string : '';
  if (stdoutStr.trim().startsWith('{') || stdoutStr.trim().startsWith('[')) {
    const parsed = parseJsonRecord(stdoutStr);
    if (parsed !== undefined) return false;
  }
  return true;
}

interface CommandFailureTestGroup {
  testName: string;
  assertionType?: string;
  locations: string[];
  count: number;
}

interface CommandFailureLintGroup {
  rule: string;
  severity: string;
  locations: string[];
  count: number;
}

function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}

function parseCommandFailureTestGroups(text: string): { groups: CommandFailureTestGroup[]; totalSeen: number } {
  const groups = new Map<string, CommandFailureTestGroup>();
  const lines = text.split(/\r?\n/);
  let currentTestName: string | undefined;
  let currentAssertion: string | undefined;
  const currentLocations: string[] = [];

  function flushGroup(): void {
    if (!currentTestName) return;
    const key = currentTestName;
    const existing = groups.get(key);
    const locations = [...currentLocations];
    if (existing) {
      existing.count += 1;
      for (const loc of locations) {
        if (existing.locations.length < ProjectToolDefaults.COMMAND_FAILURE_MAX_LOCATIONS_PER_GROUP && !existing.locations.includes(loc)) {
          existing.locations.push(loc);
        }
      }
    } else {
      groups.set(key, {
        testName: truncateString(key, ProjectToolDefaults.COMMAND_FAILURE_MESSAGE_CHARS),
        assertionType: currentAssertion ? truncateString(currentAssertion, ProjectToolDefaults.COMMAND_FAILURE_MESSAGE_CHARS) : undefined,
        locations: locations.slice(0, ProjectToolDefaults.COMMAND_FAILURE_MAX_LOCATIONS_PER_GROUP),
        count: 1
      });
    }
    currentTestName = undefined;
    currentAssertion = undefined;
    currentLocations.length = 0;
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Pytest section header: ___ test_name ___
    const sectionMatch = CMD_FAIL_PYTEST_SECTION_PATTERN.exec(line);
    if (sectionMatch) {
      flushGroup();
      currentTestName = sectionMatch[1].trim();
      continue;
    }

    // Direct failure marker: FAILED tests/foo.py::test_bar or ✗ / × / ●
    const testLineMatch = CMD_FAIL_TEST_LINE_PATTERN.exec(line.trim());
    if (testLineMatch) {
      flushGroup();
      currentTestName = testLineMatch[1].trim();
      continue;
    }

    if (!currentTestName) continue;

    // Assertion/error type
    const assertionMatch = CMD_FAIL_ASSERTION_PATTERN.exec(line);
    if (assertionMatch && !currentAssertion) {
      currentAssertion = `${assertionMatch[1]}: ${assertionMatch[2].trim()}`;
      continue;
    }

    // Traceback locations
    const traceMatch = CMD_FAIL_TRACEBACK_LINE_PATTERN.exec(line);
    if (traceMatch) {
      const loc = traceMatch[1]
        ? `${traceMatch[1]}:${traceMatch[2]}`
        : traceMatch[3]
          ? `${traceMatch[3]}:${traceMatch[4]}`
          : traceMatch[5] || '';
      if (loc && currentLocations.length < ProjectToolDefaults.COMMAND_FAILURE_MAX_LOCATIONS_PER_GROUP) {
        currentLocations.push(truncateString(loc, ProjectToolDefaults.COMMAND_FAILURE_CONTEXT_LINE_CHARS));
      }
    }
  }
  flushGroup();

  // MUST-FIX 3: return all groups and the total-seen count so the caller can compute
  // omissions without a second parse.  The caller is responsible for applying the cap.
  const all = [...groups.values()];
  return { groups: all.slice(0, ProjectToolDefaults.COMMAND_FAILURE_MAX_TEST_GROUPS), totalSeen: all.length };
}

function parseCommandFailureLintGroups(text: string): { groups: CommandFailureLintGroup[]; totalSeen: number } {
  const groups = new Map<string, CommandFailureLintGroup>();
  let totalSeen = 0; // MUST-FIX 3: track distinct rule/severity groups seen (including those beyond cap)
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trimEnd();
    const lintMatch = CMD_FAIL_LINT_LINE_PATTERN.exec(line);
    if (!lintMatch) continue;

    const filePath = lintMatch[1].trim();
    const lineNum = lintMatch[2];
    const severityWord = lintMatch[3]?.trim().toLowerCase() || '';
    const rest = lintMatch[4]?.trim() || '';

    // Try to extract a rule/code from the rest:
    //   "[rule/code]" suffix pattern — e.g., "no-unused-vars" in brackets
    //   or "rule/code" from the next line (ESLint indented rule)
    let rule = '';
    const bracketRule = rest.match(/\[([^\]]{2,50})\]\s*$/);
    if (bracketRule) {
      rule = bracketRule[1].trim();
    } else if (index + 1 < lines.length) {
      const nextLine = lines[index + 1].trimEnd();
      const eslintRuleMatch = CMD_FAIL_ESLINT_RULE_PATTERN.exec(nextLine);
      if (eslintRuleMatch) {
        rule = eslintRuleMatch[1].trim();
        index += 1; // consumed
      }
    }

    if (!rule) {
      // MUST-FIX 2: a single bare "file:line: message" with no bracket-rule, no
      // indented-rule follow-on, and no explicit severity word in group 3 of the
      // pattern is NOT a lint line — it is Go/compiler/generic output that shares
      // the same surface syntax.  Only fall through to the 'unknown' rule when
      // there IS a recognised severity word in the lint position (group 3) OR the
      // rest already starts with a recognised severity word.  Without at least one
      // of these signals, skip this line to avoid misparsing compiler errors.
      const hasSeveritySignal =
        Boolean(severityWord) // captured in group 3 — e.g. "error" / "warning"
        || Boolean(CMD_FAIL_SEVERITY_WORD_PATTERN.exec(rest)?.[1]); // first word of rest
      if (!hasSeveritySignal) continue;
      // Severity signal present but no structured rule/code — use 'unknown' rule only
      // when the match also has a column number (3-part file:line:col form), which
      // distinguishes linters from plain compiler output (most compilers emit
      // "file:line: message" without a column).  Without a column AND without a rule,
      // skip to avoid misparse.
      const hasColumn = /^(\S[^:]*\.[a-zA-Z]{1,8}):(\d+):(\d+):?\s/.test(line);
      if (!hasColumn) continue;
      const firstWord = rest.split(/\s+/)[0] || '';
      rule = /^[a-z][\w/.:-]{2,40}$/i.test(firstWord) ? firstWord : 'unknown';
    }

    const severity = severityWord || (CMD_FAIL_SEVERITY_WORD_PATTERN.exec(rest)?.[1]?.toLowerCase() || 'error');
    const location = `${filePath}:${lineNum}`;
    const key = `${rule}\0${severity}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.locations.length < ProjectToolDefaults.COMMAND_FAILURE_MAX_LOCATIONS_PER_GROUP && !existing.locations.includes(location)) {
        existing.locations.push(location);
      }
    } else {
      totalSeen += 1; // MUST-FIX 3: count every distinct group, even those that won't fit
      if (groups.size < ProjectToolDefaults.COMMAND_FAILURE_MAX_LINT_GROUPS) {
        groups.set(key, {
          rule: truncateString(rule, ProjectToolDefaults.COMMAND_FAILURE_MESSAGE_CHARS),
          severity,
          locations: [truncateString(location, ProjectToolDefaults.COMMAND_FAILURE_CONTEXT_LINE_CHARS)],
          count: 1
        });
      }
    }
  }

  return { groups: [...groups.values()], totalSeen };
}

function extractCommandFailureProcessFields(record: Record<string, unknown>): {
  timedOut?: boolean;
  maxBufferExceeded?: boolean;
  signal?: string;
  transportError?: boolean;
} {
  const timedOut = record.timedOut === true;
  const maxBufferExceeded = record.maxBufferExceeded === true;
  const signal = typeof record.signal === 'string' && record.signal ? record.signal : undefined;
  const combinedText = [
    typeof record[ProjectToolResultKey.STDOUT] === 'string' ? record[ProjectToolResultKey.STDOUT] : '',
    typeof record[ProjectToolResultKey.STDERR] === 'string' ? record[ProjectToolResultKey.STDERR] : ''
  ].join('\n');
  const transportError = CMD_FAIL_TRANSPORT_PATTERN.test(combinedText);
  return withoutUndefined({ timedOut: timedOut || undefined, maxBufferExceeded: maxBufferExceeded || undefined, signal, transportError: transportError || undefined }) as {
    timedOut?: boolean;
    maxBufferExceeded?: boolean;
    signal?: string;
    transportError?: boolean;
  };
}

/**
 * Command failure summarizer — registered after the diagnostic summarizer.
 *
 * Fires only for plain-text command FAILURES with no pre-existing richer structuredResult.
 * Parses test-runner and linter/scanner output into grouped structured summaries so agents
 * get actionable grouped errors instead of large stderr/stdout tails.
 */
const commandFailureSummarizer: ProjectToolSummarizer = {
  name: 'command_failure',
  appliesTo(definition: ProjectToolConfig, record: Record<string, unknown>): boolean {
    // EARS req 6: never fires for SUCCESS
    if (record.status === ToolResultStatus.PASSED) return false;
    // Only applies to plain-text failures (no JSON structuredPayloadSummary territory)
    return isPlainTextCommandFailure(record);
  },
  summarize(
    _definition: ProjectToolConfig,
    record: Record<string, unknown>,
    _context: ProjectToolExecutionContext
  ): StructuredResult | null {
    try {
      const processFields = extractCommandFailureProcessFields(record);
      const combinedText = [
        typeof record[ProjectToolResultKey.STDOUT] === 'string' ? record[ProjectToolResultKey.STDOUT] : '',
        typeof record[ProjectToolResultKey.STDERR] === 'string' ? record[ProjectToolResultKey.STDERR] : ''
      ].join('\n');

      // EARS req 4: expose timeout/maxBuffer/signal/transport as explicit structured fields
      // regardless of whether we can parse the rest
      const hasProcessSignal =
        processFields.timedOut
        || processFields.maxBufferExceeded
        || processFields.signal !== undefined
        || processFields.transportError
        || CMD_FAIL_TIMEOUT_PATTERN.test(combinedText)
        || CMD_FAIL_MAX_BUFFER_PATTERN.test(combinedText)
        || CMD_FAIL_SIGNAL_PATTERN.test(combinedText);

      // Try parsing test failures (pytest/vitest/jest pattern)
      const testParseResult = parseCommandFailureTestGroups(combinedText);
      const testGroups = testParseResult.groups;
      const testTotalSeen = testParseResult.totalSeen;
      // Try parsing linter/scanner failures
      const lintParseResult = parseCommandFailureLintGroups(combinedText);
      const lintGroups = lintParseResult.groups;
      const lintTotalSeen = lintParseResult.totalSeen;

      const hasTestGroups = testGroups.length > 0;
      const hasLintGroups = lintGroups.length > 0;
      const hasParsedGroups = hasTestGroups || hasLintGroups;

      // EARS req 5: if parsing is incomplete (no groups found), return bounded diagnosticPreview
      // + archive metadata note rather than exposing raw streams
      if (!hasParsedGroups && !hasProcessSignal) {
        // Nothing actionable to structure — return null so the record falls back to
        // commandDiagnosticPreview and the existing bounded preview path.
        return null;
      }

      const counts: Record<string, number> = {};
      const affectedPaths: string[] = [];
      const representativeSamples: unknown[] = [];

      if (hasTestGroups) {
        const totalTests = testGroups.reduce((sum, group) => sum + group.count, 0);
        counts.testFailures = totalTests;
        counts.testGroups = testGroups.length;
        for (const group of testGroups) {
          for (const loc of group.locations) {
            if (affectedPaths.length < ProjectToolDefaults.SUMMARIZER_MAX_AFFECTED_PATHS && !affectedPaths.includes(loc)) {
              affectedPaths.push(loc);
            }
          }
        }
        for (const group of testGroups.slice(0, ProjectToolDefaults.SUMMARIZER_MAX_REPRESENTATIVE_SAMPLES)) {
          representativeSamples.push({
            type: 'test_failure',
            testName: group.testName,
            ...(group.assertionType ? { assertionType: group.assertionType } : {}),
            locations: group.locations,
            count: group.count
          });
        }
      }

      if (hasLintGroups) {
        const totalLint = lintGroups.reduce((sum, group) => sum + group.count, 0);
        counts.lintViolations = totalLint;
        counts.lintGroups = lintGroups.length;
        for (const group of lintGroups) {
          for (const loc of group.locations) {
            if (affectedPaths.length < ProjectToolDefaults.SUMMARIZER_MAX_AFFECTED_PATHS && !affectedPaths.includes(loc)) {
              affectedPaths.push(loc);
            }
          }
        }
        const lintSamplesLeft = ProjectToolDefaults.SUMMARIZER_MAX_REPRESENTATIVE_SAMPLES - representativeSamples.length;
        for (const group of lintGroups.slice(0, lintSamplesLeft)) {
          representativeSamples.push({
            type: 'lint_violation',
            rule: group.rule,
            severity: group.severity,
            locations: group.locations,
            count: group.count
          });
        }
      }

      // EARS req 4: add process signal fields when present
      if (hasProcessSignal) {
        if (processFields.timedOut || CMD_FAIL_TIMEOUT_PATTERN.test(combinedText)) counts.timedOut = 1;
        if (processFields.maxBufferExceeded || CMD_FAIL_MAX_BUFFER_PATTERN.test(combinedText)) counts.maxBufferExceeded = 1;
        if (processFields.signal) counts.signal = 1;
        if (processFields.transportError || CMD_FAIL_TRANSPORT_PATTERN.test(combinedText)) counts.transportError = 1;
      }

      // Total for quick overview
      const totalFailures = (counts.testFailures || 0) + (counts.lintViolations || 0);
      if (totalFailures > 0) counts.failures = totalFailures;

      const result: StructuredResult = {
        status: 'ok',
        counts
      };
      if (affectedPaths.length > 0) result.affectedPaths = affectedPaths;
      if (representativeSamples.length > 0) result.representativeSamples = representativeSamples;

      // EARS req 5: if parsing produced no groups (only process fields), add a note
      if (!hasParsedGroups) {
        result.omissions = 'failure output could not be parsed into test/lint groups; diagnosticPreview and archive retain bounded raw context';
        result.nextAction = 'inspect_diagnosticPreview_then_archive_if_more_context_needed';
      } else {
        // MUST-FIX 3: use totalSeen from the first parse — no second re-parse needed.
        const omittedTestGroups = hasTestGroups ? Math.max(0, testTotalSeen - ProjectToolDefaults.COMMAND_FAILURE_MAX_TEST_GROUPS) : 0;
        const omittedLintGroups = hasLintGroups ? Math.max(0, lintTotalSeen - ProjectToolDefaults.COMMAND_FAILURE_MAX_LINT_GROUPS) : 0;
        if (omittedTestGroups > 0 || omittedLintGroups > 0) {
          result.omissions = [
            omittedTestGroups > 0 ? `${omittedTestGroups} test-failure groups omitted` : '',
            omittedLintGroups > 0 ? `${omittedLintGroups} lint-violation groups omitted` : ''
          ].filter(Boolean).join('; ');
        }
        result.nextAction = 'fix_or_route_failure';
      }

      // Add explicit process signal fields at top level for EARS req 4.
      // StructuredResult is narrowly typed; extend via Object.assign to preserve
      // the interface contract while surfacing the extra fields in the JSON output.
      const extra: Record<string, unknown> = {};
      if (processFields.timedOut) extra.timedOut = true;
      if (processFields.maxBufferExceeded) extra.maxBufferExceeded = true;
      if (processFields.signal) extra.signal = processFields.signal;
      if (processFields.transportError) extra.transportError = true;
      if (Object.keys(extra).length > 0) Object.assign(result, extra);

      return result;
    } catch {
      // Must not throw — return parse_error with archive guidance (EARS req 5)
      return { status: 'parse_error', nextAction: 'inspect_diagnosticPreview_then_archive_if_needed' };
    }
  }
};

/**
 * The ordered registry of per-tool summarizers.
 * Resolution: first entry whose appliesTo returns true wins.
 * Add new summarizers here — diagnostic summarizer must remain first.
 */
const PROJECT_TOOL_SUMMARIZER_REGISTRY: ProjectToolSummarizer[] = [
  diagnosticSummarizer,
  commandFailureSummarizer
];

/**
 * Attempt to produce a StructuredResult via the registry for the given raw result.
 * Returns null when no summarizer applies (the common case — existing behavior unchanged).
 * When a summarizer applies but cannot parse, returns a compact parse_error StructuredResult
 * (requirement 4: no raw payload exposure, archive preserved).
 */
function applyStructuredSummarizerRegistry(
  definition: ProjectToolConfig,
  result: unknown,
  context: ProjectToolExecutionContext
): StructuredResult | null {
  const record = resultRecord(result);
  for (const summarizer of PROJECT_TOOL_SUMMARIZER_REGISTRY) {
    if (!summarizer.appliesTo(definition, record)) continue;
    const structured = summarizer.summarize(definition, record, context);
    return structured;
  }
  return null;
}

function textFromMcpContent(value: unknown): string | undefined {
  if (!isJsonRecord(value)) return undefined;
  const content = value.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(isJsonRecord)
    .map(item => typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n\n');
  return text.trim() ? text : undefined;
}

function commandPayloadPreviewText(record: Record<string, unknown>): string | undefined {
  if (record[ProjectToolResultKey.MATCH_STATUS] === NO_MATCH_STATUS) return undefined;

  if (typeof record[ProjectToolResultKey.RESULT_PREVIEW] === 'string' && String(record[ProjectToolResultKey.RESULT_PREVIEW]).trim()) {
    return String(record[ProjectToolResultKey.RESULT_PREVIEW]);
  }

  const stdoutRecord = parseJsonRecord(record[ProjectToolResultKey.STDOUT]);
  const nestedStdout = typeof stdoutRecord?.stdout === 'string' && stdoutRecord.stdout.trim()
    ? stdoutRecord.stdout
    : undefined;
  const nestedStderr = typeof stdoutRecord?.stderr === 'string' && stdoutRecord.stderr.trim()
    ? stdoutRecord.stderr
    : undefined;
  if (nestedStdout && nestedStderr) return `stdout:\n${nestedStdout}\n\nstderr:\n${nestedStderr}`;
  if (nestedStdout) return nestedStdout;
  if (nestedStderr) return `stderr:\n${nestedStderr}`;

  const stdout = typeof record[ProjectToolResultKey.STDOUT] === 'string' && String(record[ProjectToolResultKey.STDOUT]).trim()
    ? String(record[ProjectToolResultKey.STDOUT])
    : undefined;
  const stderr = typeof record[ProjectToolResultKey.STDERR] === 'string' && String(record[ProjectToolResultKey.STDERR]).trim()
    ? String(record[ProjectToolResultKey.STDERR])
    : undefined;
  if (stdout && stderr) return `stdout:\n${stdout}\n\nstderr:\n${stderr}`;
  return stdout || (stderr ? `stderr:\n${stderr}` : undefined);
}

function resultPreviewText(record: Record<string, unknown>, limitBytes: number): string | undefined {
  // When a structuredResult OR diagnosticSummary is present the compact structured
  // payload is already the authoritative model-facing text.  Skip raw MCP content
  // and raw output/stdout/stderr text so large payloads do not reappear alongside
  // the summary and create token pressure.  The raw text remains retrievable via the
  // outputArchive and by rerunning the tool with narrower arguments.
  //
  // Strict superset of 7i0 diagnostic behavior:
  //   - hasDiagnosticSummary=true  → hasStructuredModelSummary=true  (7i0 preserved)
  //   - hasStructuredResult=true   → hasStructuredModelSummary=true  (new generalization)
  //
  // Requirement 3 (no duplicate raw fields): when raw content is suppressed in the
  // model-facing result, it is also excluded from the preview source so the same bytes
  // do not reappear under a different key.
  //
  // Correctness: RESULT_PREVIEW is only populated before this call when
  // applyDiagnosticModelSummary or buildCommandResult have already set it.
  // commandPayloadPreviewText reads RESULT_PREVIEW and returns it directly for
  // the hasStructuredModelSummary branch, then returns undefined for the raw fallbacks
  // (which are skipped by hasStructuredModelSummary below).
  const hasStructuredModelSummary =
    Boolean(record[ProjectToolResultKey.STRUCTURED_RESULT]) || Boolean(record[DIAGNOSTIC_SUMMARY_KEY]);

  if (hasStructuredModelSummary) {
    // Raw MCP content, raw stdout/stderr, and raw output are all suppressed — only the
    // compact RESULT_PREVIEW (placed by applyDiagnosticModelSummary or buildCommandResult)
    // is eligible.  commandPayloadPreviewText is intentionally bypassed here because its
    // raw stdout/stderr fallback path would duplicate content already hidden from the
    // model-facing result.
    const existingPreview = typeof record[ProjectToolResultKey.RESULT_PREVIEW] === 'string'
      && String(record[ProjectToolResultKey.RESULT_PREVIEW]).trim()
      ? String(record[ProjectToolResultKey.RESULT_PREVIEW])
      : undefined;
    if (!existingPreview) return undefined;
    return boundedPreviewText(existingPreview, ProjectToolDefaults.DIAGNOSTIC_SUMMARY_RESULT_PREVIEW_MAX_BYTES);
  }

  const mcpText = textFromMcpContent(record.result);
  const commandText = commandPayloadPreviewText(record);
  const outputText = typeof record.output === 'string' && record.output.trim()
    ? record.output
    : undefined;
  const preview = mcpText || commandText || outputText;
  if (!preview) return undefined;
  return boundedPreviewText(preview, limitBytes);
}

function structuredCommandResultPreview(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  const stdout = typeof record.stdout === 'string' && record.stdout.trim() ? record.stdout : undefined;
  const stderr = typeof record.stderr === 'string' && record.stderr.trim() ? record.stderr : undefined;
  const mcpText = textFromMcpContent(record.result);
  if (stdout && stderr) return `stdout:\n${stdout}\n\nstderr:\n${stderr}`;
  if (stdout) return stdout;
  if (stderr) return `stderr:\n${stderr}`;
  return mcpText;
}

function attachArchiveIfNeeded(
  result: ModelFacingProjectToolResult,
  context: ProjectToolExecutionContext,
  bytes: number,
  truncated: boolean
): ModelFacingProjectToolResult {
  const archiveTruncated = truncated || hasArchivedStream(result);
  if (!archiveTruncated) return result;
  return {
    ...result,
    [ProjectToolResultKey.OUTPUT_ARCHIVE]: outputArchiveSummary(context, bytes, archiveTruncated)
  };
}

function modelFacingTruncatedResult(
  definition: ProjectToolConfig,
  record: Record<string, unknown>,
  context: ProjectToolExecutionContext,
  serialized: string,
  maxInlineBytes: number
): ModelFacingProjectToolResult {
  const toolCalls = toolCallsFromRecord(record);
  const diagnosticPreview = commandDiagnosticPreview(record);
  const previewBytes = outputPreviewLimit(maxInlineBytes);
  const resultPreview = resultPreviewText(record, previewBytes);
  return {
    ...baseResultSummary(definition, record),
    ...(toolCalls ? { [ProjectToolResultKey.TOOL_CALLS]: toolCalls } : {}),
    ...(resultPreview ? { [ProjectToolResultKey.RESULT_PREVIEW]: resultPreview } : {}),
    ...(diagnosticPreview ? { [ProjectToolResultKey.DIAGNOSTIC_PREVIEW]: diagnosticPreview } : {}),
    [ProjectToolResultKey.OUTPUT_ARCHIVE]: outputArchiveSummary(context, serialized.length, true),
    [ProjectToolResultKey.OUTPUT_ACCESS]: PROJECT_TOOL_OUTPUT_ACCESS_GUIDANCE,
    outputTruncated: true,
    outputPreview: outputPreviewText(definition, record, serialized, previewBytes)
  };
}

function serializeProjectToolResult(result: unknown): string {
  return JSON.stringify(result, null, 2) ?? String(result);
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toolCallsFromRecord(record: Record<string, unknown>): unknown[] | undefined {
  const direct = record[ProjectToolResultKey.TOOL_CALLS];
  if (Array.isArray(direct)) return direct;
  const framework = record[ProjectToolResultKey.FRAMEWORK_TOOL_CALLS];
  if (Array.isArray(framework)) return framework;
  const stdoutRecord = parseJsonRecord(record[ProjectToolResultKey.STDOUT]);
  if (!stdoutRecord) return undefined;
  return toolCallsFromRecord(stdoutRecord);
}

async function jsonRecordFromFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  let size = 0;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return undefined;
  }
  if (size <= 0 || size > ProjectToolDefaults.TOOL_CALL_EXTRACTION_MAX_BYTES) return undefined;
  return parseJsonRecord(await readFile(filePath, 'utf8'));
}

function rejectedChecksFromRecord(record: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(record[ProjectToolResultKey.REJECTED_CHECKS])) {
    return record[ProjectToolResultKey.REJECTED_CHECKS] as unknown[];
  }
  const checks = Array.isArray(record[StructuredPayloadCollectionKey.CHECKS])
    ? record[StructuredPayloadCollectionKey.CHECKS] as unknown[]
    : undefined;
  if (!checks) return undefined;
  const rejected = checks
    .filter(isJsonRecord)
    .filter(item => item.status === ToolResultStatus.REJECTED)
    .map(item => ({
      name: item.name,
      message: item.message
    }));
  return rejected.length > 0 ? rejected : undefined;
}

function compactStructuredValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length <= ProjectToolDefaults.STRUCTURED_SUMMARY_TEXT_CHARS) return value;
  return `${value.slice(0, ProjectToolDefaults.STRUCTURED_SUMMARY_TEXT_CHARS)}...`;
}

function issueSummary(issue: unknown): Record<string, unknown> {
  if (!isJsonRecord(issue)) return { value: compactStructuredValue(issue) };
  const summary: Record<string, unknown> = {};
  for (const key of StructuredPayloadIssueKey) {
    const value = issue[key];
    if (value !== undefined) summary[key] = compactStructuredValue(value);
  }
  return summary;
}

function groupedIssueSummary(value: unknown): unknown[] | undefined {
  if (!isJsonRecord(value)) return undefined;
  const groups = Object.entries(value).slice(0, ProjectToolDefaults.STRUCTURED_SUMMARY_MAX_GROUPS);
  if (groups.length === 0) return undefined;
  return groups.map(([group, groupValue]) => ({
    group,
    count: Array.isArray(groupValue) ? groupValue.length : undefined,
    samples: Array.isArray(groupValue)
      ? groupValue.slice(0, ProjectToolDefaults.STRUCTURED_SUMMARY_MAX_ITEMS_PER_GROUP).map(issueSummary)
      : compactStructuredValue(groupValue)
  }));
}

function toolResultSummary(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const results = value.slice(0, ProjectToolDefaults.STRUCTURED_SUMMARY_MAX_GROUPS)
    .filter(isJsonRecord)
    .map(result => {
      const summary: Record<string, unknown> = {};
      for (const key of StructuredPayloadToolResultKey) {
        const nested = result[key];
        if (nested !== undefined) summary[key] = compactStructuredValue(nested);
      }
      return summary;
  });
  return results.length > 0 ? results : undefined;
}

interface ScanTargetEvidence {
  scannedTargetCount: number;
  scannedTargetSamples?: string[];
}

const SCAN_TARGET_COUNT_KEYS = [
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

const SCAN_TARGET_COLLECTION_KEYS = [
  'scannedTargets',
  'scanned_targets',
  'scannedTargetSamples',
  'scanned_target_samples',
  'scannedFiles',
  'scanned_files',
  'targetPaths',
  'target_paths'
] as const;

const SEMGREP_PATH_COLLECTION_KEYS = [
  'scanned',
  'scannedTargets',
  'scanned_targets'
] as const;

function scanTargetCountValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

function scanTargetSamplesFromArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(item => {
      if (typeof item === 'string') return item;
      if (isJsonRecord(item) && typeof item.path === 'string') return item.path;
      if (isJsonRecord(item) && typeof item.file === 'string') return item.file;
      return undefined;
    })
    .filter((item): item is string => Boolean(item));
}

function compactScanTargetSamples(samples: string[] | undefined): string[] | undefined {
  if (!samples) return undefined;
  const uniqueSamples = uniqueLines(samples).slice(0, SCAN_TARGET_SAMPLE_LIMIT);
  return uniqueSamples.length > 0
    ? uniqueSamples.map(sample => String(compactStructuredValue(sample)))
    : undefined;
}

function scanTargetEvidenceFromPayload(record: Record<string, unknown> | undefined): ScanTargetEvidence | undefined {
  if (!record) return undefined;

  let scannedTargetCount: number | undefined;
  let scannedTargetSamples: string[] | undefined;

  for (const key of SCAN_TARGET_COUNT_KEYS) {
    const value = scanTargetCountValue(record[key]);
    if (value !== undefined) {
      scannedTargetCount = value;
      break;
    }
  }

  for (const key of SCAN_TARGET_COLLECTION_KEYS) {
    const samples = scanTargetSamplesFromArray(record[key]);
    if (samples !== undefined) {
      scannedTargetSamples = samples;
      if (scannedTargetCount === undefined) scannedTargetCount = samples.length;
      break;
    }
  }

  const paths = nestedRecord(record, 'paths');
  if (paths) {
    for (const key of SEMGREP_PATH_COLLECTION_KEYS) {
      const samples = scanTargetSamplesFromArray(paths[key]);
      if (samples !== undefined) {
        scannedTargetSamples = samples;
        if (scannedTargetCount === undefined) scannedTargetCount = samples.length;
        break;
      }
    }
  }

  if (scannedTargetCount === undefined) return undefined;
  return withoutUndefined({
    [ProjectToolResultKey.SCANNED_TARGET_COUNT]: scannedTargetCount,
    [ProjectToolResultKey.SCANNED_TARGET_SAMPLES]: compactScanTargetSamples(scannedTargetSamples)
  }) as unknown as ScanTargetEvidence;
}

function scanTargetEvidenceFromResult(result: unknown): ScanTargetEvidence | undefined {
  const record = resultRecord(result);
  const candidates = [
    record,
    isJsonRecord(record[ProjectToolResultKey.STRUCTURED_RESULT])
      ? record[ProjectToolResultKey.STRUCTURED_RESULT] as Record<string, unknown>
      : undefined,
    parseJsonRecord(record[ProjectToolResultKey.STDOUT]),
    parseJsonRecord(record[ProjectToolResultKey.STDERR]),
    parseJsonRecord(record.output),
    isJsonRecord(record.result) ? record.result as Record<string, unknown> : undefined
  ];

  for (const candidate of candidates) {
    const evidence = scanTargetEvidenceFromPayload(candidate);
    if (evidence) return evidence;
  }
  return undefined;
}

function structuredPayloadSummary(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const summary: Record<string, unknown> = {};
  for (const key of StructuredPayloadSummaryKey) {
    const value = record[key];
    if (value !== undefined) summary[key] = value;
  }

  const checks = Array.isArray(record[StructuredPayloadCollectionKey.CHECKS])
    ? record[StructuredPayloadCollectionKey.CHECKS] as unknown[]
    : undefined;
  if (checks) {
    const rejected = rejectedChecksFromRecord(record);
    const passedCount = checks
      .filter(isJsonRecord)
      .filter(item => item.status === ToolResultStatus.PASSED)
      .length;
    summary[ProjectToolResultKey.PASSED_CHECK_COUNT] = passedCount;
    summary[ProjectToolResultKey.REJECTED_CHECK_COUNT] = rejected?.length || 0;
    if (rejected?.length) summary[ProjectToolResultKey.REJECTED_CHECKS] = rejected;
  }

  const errorsByTool = groupedIssueSummary(record[StructuredPayloadCollectionKey.ERRORS_BY_TOOL]);
  if (errorsByTool) summary[StructuredPayloadSummaryOutputKey.ERRORS_BY_TOOL] = errorsByTool;

  const errorsByFile = groupedIssueSummary(record[StructuredPayloadCollectionKey.ERRORS_BY_FILE]);
  if (errorsByFile) summary[StructuredPayloadSummaryOutputKey.ERRORS_BY_FILE] = errorsByFile;

  const toolResults = toolResultSummary(record[StructuredPayloadCollectionKey.TOOL_RESULTS]);
  if (toolResults) summary[StructuredPayloadSummaryOutputKey.TOOL_RESULTS] = toolResults;

  const scanTargetEvidence = scanTargetEvidenceFromPayload(record);
  if (scanTargetEvidence) Object.assign(summary, scanTargetEvidence);

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function commandDiagnosticPreview(record: Record<string, unknown>): string | undefined {
  if (record.status === ToolResultStatus.PASSED && record.timedOut !== true) return undefined;

  const sections = COMMAND_STREAM_OUTPUT_KEYS
    .map(key => commandStreamDiagnosticSection(key, record[key]))
    .filter((value): value is string => Boolean(value));

  if (sections.length === 0) return undefined;
  return boundedCommandText(sections.join('\n\n'), ProjectToolDefaults.COMMAND_DIAGNOSTIC_PREVIEW_BYTES).text;
}

function commandStreamDiagnosticSection(key: (typeof COMMAND_STREAM_OUTPUT_KEYS)[number], value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;

  const lines = value
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0);
  const matchedLines = lines
    .filter(line => COMMAND_DIAGNOSTIC_LINE_PATTERN.test(line))
    .slice(-COMMAND_DIAGNOSTIC_MAX_MATCH_LINES);
  const tailLines = lines.slice(-COMMAND_DIAGNOSTIC_TAIL_LINES);
  const diagnosticLines = uniqueLines([...matchedLines, ...tailLines]);
  if (diagnosticLines.length === 0) return undefined;
  return `${key}${COMMAND_DIAGNOSTIC_SECTION_SUFFIX}:\n${diagnosticLines.join('\n')}`;
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter(line => {
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
}

function astGrepNoMatch(
  definition: ProjectCommandToolConfig,
  exitCode: number | undefined,
  stdout: string,
  stderr: string,
  structuredStdout?: Record<string, unknown>
): boolean {
  if (definition.name !== AST_GREP_TOOL_NAME) return false;
  if (exitCode === CommandExitCode.NO_MATCH && stdout.trim().length === 0 && stderr.trim().length === 0) return true;
  return structuredStdout?.exitCode === CommandExitCode.NO_MATCH
    && String(structuredStdout.stdout || '').trim().length === 0
    && String(structuredStdout.stderr || '').trim().length === 0;
}

function commandResultAnnotations(
  definition: ProjectCommandToolConfig,
  exitCode: number | undefined,
  stdout: string,
  stderr: string,
  structuredStdout?: Record<string, unknown>
): Record<string, unknown> {
  if (!astGrepNoMatch(definition, exitCode, stdout, stderr, structuredStdout)) return {};
  return {
    [ProjectToolResultKey.MATCH_STATUS]: NO_MATCH_STATUS,
    message: AST_GREP_NO_MATCH_MESSAGE
  };
}

function isConfiguredEvidenceScanTool(definition: ProjectToolConfig, record: Record<string, unknown>): boolean {
  const names = [
    definition.name,
    stringField(record, 'tool'),
    stringField(record[ProjectToolResultKey.STRUCTURED_RESULT], 'tool')
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
  return /\bsemgrep\b|security|sast|evidence|(?:^|[_-])scan(?:ner)?(?:[_-]|$)/.test(names);
}

function isFrameworkScanTool(definition: ProjectToolConfig): boolean {
  const name = definition.name.toLowerCase();
  if (name.startsWith('framework_') || name.includes('framework')) return true;
  if (definition.type === ProjectToolType.COMMAND) {
    const scope = (definition as ProjectCommandToolConfig).argumentPathScope;
    return Boolean(scope && pathArgumentRootKind(scope) === ProjectToolRootKind.FRAMEWORK);
  }
  return false;
}

function scanTargetVirtualRoots(
  definition: ProjectToolConfig,
  context: ProjectToolExecutionContext,
  config?: ProjectToolPathArgumentConfig
): string[] {
  const configuredRoots = (config?.[PathArgumentConfigKey.VIRTUAL_ROOTS] || [])
    .map(rootValue => resolveTemplateString(rootValue, context.templateContext));
  const defaultRoots = isFrameworkScanTool(definition) ? ['/workspace/framework'] : [];
  return [...new Set([...configuredRoots, ...defaultRoots])];
}

function scanTargetEscapeGuidance(
  definition: ProjectToolConfig,
  context: ProjectToolExecutionContext
): PathArgumentEscapeGuidance {
  const config = definition.type === ProjectToolType.COMMAND
    ? (definition as ProjectCommandToolConfig).argumentPathScope
    : undefined;
  const virtualRoots = scanTargetVirtualRoots(definition, context, config);

  if (config) {
    try {
      return pathArgumentEscapeGuidance(resolvePathArgumentRoot(config, context.templateContext), virtualRoots);
    } catch {
      if (pathArgumentRootKind(config) === ProjectToolRootKind.FRAMEWORK) {
        return pathArgumentEscapeGuidance({ path: '<configured-framework-root>', kind: ProjectToolRootKind.FRAMEWORK }, virtualRoots);
      }
    }
  }

  if (isFrameworkScanTool(definition)) {
    return pathArgumentEscapeGuidance(
      {
        path: context.templateContext.frameworkRoot || '<configured-framework-root>',
        kind: ProjectToolRootKind.FRAMEWORK
      },
      virtualRoots
    );
  }

  return pathArgumentEscapeGuidance(
    { path: context.templateContext.worktreePath, kind: ProjectToolRootKind.WORKTREE },
    virtualRoots
  );
}

function zeroTargetScanResult(
  definition: ProjectToolConfig,
  result: Record<string, unknown>,
  context: ProjectToolExecutionContext
): Record<string, unknown> {
  const guidance = scanTargetEscapeGuidance(definition, context);
  const acceptedForms = guidance.acceptedForms.join(' or ');
  return withoutUndefined({
    ...result,
    status: ToolResultStatus.REJECTED,
    message: `${ZERO_TARGET_SCAN_MESSAGE_PREFIX} Tool ${definition.name} scanned 0 targets, so it is not passing evidence. Expected target root: ${guidance.allowedRoot}. Expected target path form: ${acceptedForms}.`,
    [ProjectToolResultKey.NEXT_ACTION]: INSUFFICIENT_EVIDENCE_NEXT_ACTION,
    [ProjectToolResultKey.REMEDIATION]: mergeProjectToolRemediation(result[ProjectToolResultKey.REMEDIATION], [
      `Rerun ${definition.name} against files under the configured ${guidance.rootKind} root (${guidance.allowedRoot}).`,
      `Use target path form ${acceptedForms}; do not treat zero scanned targets as security or evidence coverage.`
    ]),
    [ProjectToolResultKey.RECOVERY]: [
      `Rerun ${definition.name} with a target that resolves under ${guidance.allowedRoot}.`,
      'If the configured target root is wrong or unavailable, route insufficient evidence instead of recording the scan as passed.'
    ]
  });
}

function applyScanTargetEvidencePolicy(
  definition: ProjectToolConfig,
  result: unknown,
  context: ProjectToolExecutionContext
): unknown {
  const scanTargetEvidence = scanTargetEvidenceFromResult(result);
  if (!scanTargetEvidence) return result;

  const record = withoutUndefined({
    ...resultRecord(result),
    ...scanTargetEvidence
  });
  if (
    scanTargetEvidence.scannedTargetCount === 0
    && statusFromToolResult(record) === ToolResultStatus.PASSED
    && isConfiguredEvidenceScanTool(definition, record)
  ) {
    return zeroTargetScanResult(definition, record, context);
  }
  return record;
}

async function persistAndBoundResult(
  definition: ProjectToolConfig,
  result: unknown,
  context: ProjectToolExecutionContext
): Promise<unknown> {
  const policyResult = applyScanTargetEvidencePolicy(definition, result, context);
  // Archive is ALWAYS written from the raw (pre-summary) policy result — requirement 5.
  const serialized = serializeProjectToolResult(policyResult);
  await writeFile(context.outputFile, serialized);
  const maxInlineBytes = inlineResultLimit(definition);

  // Run the per-tool structured summarizer registry BEFORE truncation/preview construction.
  // The registry fires whenever a summarizer's appliesTo() returns true for this tool/record.
  const structuredResult = applyStructuredSummarizerRegistry(definition, policyResult, context);

  // Attach structuredResult only when the record does not already carry gate-evidence in its
  // structuredResult.  A pre-existing structuredResult from buildCommandResult / buildMcpResult
  // (structuredPayloadSummary) may carry richer gate evidence: verdict, rejectedChecks,
  // errorsByTool, errorsByFile, scan-target counts.  The registry's leaner diagnostic summary
  // must not clobber that payload.  Basic-field-only summaries (tool/status/operation/stdout*)
  // do NOT constitute gate evidence and do not block the registry.
  const existingStructuredResult = resultRecord(policyResult)[ProjectToolResultKey.STRUCTURED_RESULT];
  const hasGateEvidence = structuredResultHasDecisionEvidence(existingStructuredResult);
  const enrichedResult = (structuredResult && !hasGateEvidence)
    ? withoutUndefined({ ...resultRecord(policyResult), [ProjectToolResultKey.STRUCTURED_RESULT]: structuredResult })
    : policyResult;

  // applyDiagnosticModelSummary adds diagnosticSummary + resultPreview for diagnostic tools
  // (preserving 7i0 behavior exactly).  It operates on the enriched result so existing
  // diagnosticSummary consumers remain unaffected.
  const modelResult = applyDiagnosticModelSummary(definition, enrichedResult, context);
  const record = resultRecord(modelResult);
  if (serialized.length <= maxInlineBytes) {
    return attachArchiveIfNeeded(modelFacingInlineResult(modelResult), context, serialized.length, false);
  }

  return modelFacingTruncatedResult(definition, record, context, serialized, maxInlineBytes);
}

interface CommandResultInput {
  definition: ProjectCommandToolConfig;
  status: ToolResultStatus;
  exitCode: number | undefined;
  maxBufferExceeded: boolean;
  timedOut?: boolean;
  signal?: string | undefined;
  stdoutFile: string;
  stderrFile: string;
  boundedStdout: { text: string; bytes: number; truncated: boolean };
  boundedStderr: { text: string; bytes: number; truncated: boolean };
  stdoutTruncated: boolean;
  structuredStdout: Record<string, unknown> | undefined;
  structuredSummary: unknown;
  toolCalls: unknown;
  normalizedPathArguments: string[];
}

function buildCommandResult(input: CommandResultInput): object {
  const {
    definition, status, exitCode, maxBufferExceeded, timedOut, signal,
    stdoutFile, stderrFile, boundedStdout, boundedStderr, stdoutTruncated,
    structuredStdout, structuredSummary, toolCalls, normalizedPathArguments
  } = input;
  return {
    tool: definition.name,
    status,
    exitCode,
    ...(timedOut !== undefined ? { timedOut } : {}),
    ...(signal !== undefined ? { signal } : {}),
    maxBufferExceeded,
    stdoutFile,
    stderrFile,
    stdout: boundedStdout.text,
    stderr: boundedStderr.text,
    stdoutBytes: boundedStdout.bytes,
    stderrBytes: boundedStderr.bytes,
    stdoutTruncated,
    stderrTruncated: boundedStderr.truncated,
    ...commandResultAnnotations(definition, exitCode, boundedStdout.text, boundedStderr.text, structuredStdout),
    ...(normalizedPathArguments.length > 0 ? { normalizedPathArguments } : {}),
    ...(structuredCommandResultPreview(structuredStdout) ? { [ProjectToolResultKey.RESULT_PREVIEW]: structuredCommandResultPreview(structuredStdout) } : {}),
    ...(structuredSummary ? { [ProjectToolResultKey.STRUCTURED_RESULT]: structuredSummary } : {}),
    ...(toolCalls ? { [ProjectToolResultKey.TOOL_CALLS]: toolCalls } : {})
  };
}

async function executeCommandTool(definition: ProjectCommandToolConfig, args: any, context: ProjectToolExecutionContext) {
  const templateContext = context.templateContext;
  const command = resolveTemplateString(definition.command, templateContext);
  const finalArgs = (definition.defaultArgs || []).map(arg => resolveTemplateString(arg, templateContext));
  const stdoutFile = path.join(context.outputDir, COMMAND_STDOUT_FILE_NAME);
  const stderrFile = path.join(context.outputDir, COMMAND_STDERR_FILE_NAME);
  const returnBytes = commandReturnBytes(definition);
  const suppliedArgs = normalizeCommandArguments(args?.[ProjectToolParameter.ARGUMENTS])
    .map(arg => resolveTemplateString(arg, templateContext));
  const unsupportedOutputControlFlag = unsupportedArtifactValidatorOutputControlFlag(definition, suppliedArgs);
  if (unsupportedOutputControlFlag) {
    return unsupportedArtifactValidatorOutputControlResult(definition, unsupportedOutputControlFlag);
  }

  const scopedArgs: CommandArgumentPathNormalization = definition.allowArgs
    ? normalizeCommandArgumentPaths(definition, suppliedArgs, templateContext)
    : { arguments: [], normalizedPathArguments: [] };
  if (scopedArgs.rejection) {
    return commandPathRejectionResult(definition, scopedArgs.rejection, scopedArgs.normalizedPathArguments);
  }

  if (definition.allowArgs && scopedArgs.arguments.length > 0) {
    if (definition.argsMode === 'append') {
      finalArgs.push(...scopedArgs.arguments);
    } else {
      finalArgs.splice(0, finalArgs.length, ...scopedArgs.arguments);
    }
  }

  const env = Object.fromEntries(
    Object.entries(definition.env || {}).map(([key, value]) => [key, resolveTemplateString(value, templateContext)])
  );

  try {
    const result = await execa(command, finalArgs, {
      cwd: context.cwd,
      env: { ...process.env, ...env, ...projectToolEnvironment(context) },
      stdout: { file: stdoutFile },
      stderr: { file: stderrFile },
      reject: false,
      timeout: definition.timeoutMs || Defaults.PROCESS_REAP_INTERVAL_MS
    });
    const boundedStdout = await boundedCommandFile(stdoutFile, returnBytes);
    const boundedStderr = await boundedCommandFile(stderrFile, returnBytes);
    const structuredStdout = await jsonRecordFromFile(stdoutFile);
    const structuredSummary = structuredStdout ? structuredPayloadSummary(structuredStdout) : undefined;
    const toolCalls = structuredStdout ? toolCallsFromRecord(structuredStdout) : undefined;
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : undefined;
    const acceptedExitCode = isSuccessfulCommandExitCode(definition, exitCode);
    const acceptedNonZeroExitCode = exitCode !== CommandExitCode.SUCCESS
      && acceptedExitCode
      && boundedStderr.text.trim().length === 0;
    const passed = !result.timedOut && (exitCode === CommandExitCode.SUCCESS || acceptedNonZeroExitCode);

    return buildCommandResult({
      definition,
      status: passed ? ToolResultStatus.PASSED : ToolResultStatus.REJECTED,
      exitCode,
      maxBufferExceeded: false,
      timedOut: result.timedOut,
      signal: result.signal,
      stdoutFile,
      stderrFile,
      boundedStdout,
      boundedStderr,
      stdoutTruncated: boundedStdout.truncated,
      structuredStdout,
      structuredSummary,
      toolCalls,
      normalizedPathArguments: scopedArgs.normalizedPathArguments
    });
  } catch (error: any) {
    const fileStdout = await boundedCommandFile(stdoutFile, returnBytes);
    const fileStderr = await boundedCommandFile(stderrFile, returnBytes);
    const stderrText = fileStderr.text || (typeof error.stderr === 'string' ? error.stderr : '');
    const acceptedExitCode = isSuccessfulCommandExitCode(definition, error.code) && stderrText.trim().length === 0;
    const acceptedMaxBuffer = isAcceptedMaxBufferFailure(definition, error);
    const maxBufferExceeded = error?.code === CommandErrorCode.MAX_BUFFER;
    const status = acceptedExitCode || acceptedMaxBuffer
      ? ToolResultStatus.PASSED
      : commandFailureStatus(error);
    const boundedStdout = fileStdout.bytes > 0 ? fileStdout : boundedCommandText(error.stdout, returnBytes);
    const boundedStderr = fileStderr.bytes > 0 ? fileStderr : boundedCommandText(error.stderr || (acceptedExitCode ? '' : error.message), returnBytes);
    const structuredStdout = await jsonRecordFromFile(stdoutFile);
    const structuredSummary = structuredStdout ? structuredPayloadSummary(structuredStdout) : undefined;
    const toolCalls = structuredStdout ? toolCallsFromRecord(structuredStdout) : undefined;
    const exitCode = typeof error.code === 'number' ? error.code : undefined;

    return buildCommandResult({
      definition,
      status,
      exitCode,
      maxBufferExceeded,
      stdoutFile,
      stderrFile,
      boundedStdout,
      boundedStderr,
      stdoutTruncated: boundedStdout.truncated || maxBufferExceeded,
      structuredStdout,
      structuredSummary,
      toolCalls,
      normalizedPathArguments: scopedArgs.normalizedPathArguments
    });
  }
}

function resolveConfiguredPath(value: string, templateContext: TemplateContext): string {
  const resolved = resolveTemplateString(value, templateContext);
  return path.isAbsolute(resolved) ? resolved : path.resolve(templateContext.projectRoot, resolved);
}

function resolveArgumentTemplates(value: unknown, templateContext: TemplateContext): unknown {
  if (typeof value === 'string') return resolveTemplateString(value, templateContext);
  if (Array.isArray(value)) return value.map(item => resolveArgumentTemplates(item, templateContext));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, resolveArgumentTemplates(nested, templateContext)])
  );
}

async function loadMcpConfig(configPath: string): Promise<McpConfigFile> {
  const raw = await readFile(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as McpConfigFile;
  return parsed;
}

function getMcpServers(config: McpConfigFile): Record<string, McpServerDefinition> {
  return config[MCP_SERVER_CONFIG_KEY] || config[LEGACY_MCP_SERVER_CONFIG_KEY] || {};
}

function resolveRecordTemplates(record: Record<string, string> | undefined, templateContext: TemplateContext): Record<string, string> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, resolveTemplateString(value, templateContext)])
  );
}

function resolveMcpOperation(definition: ProjectMcpToolConfig, requested: unknown): string | undefined {
  const requestedOperation = typeof requested === 'string' && requested.trim()
    ? requested.trim()
    : undefined;
  const configuredOperations = definition.operations;

  if (!configuredOperations) return requestedOperation;
  if (Array.isArray(configuredOperations)) {
    if (requestedOperation) return configuredOperations.includes(requestedOperation) ? requestedOperation : undefined;
    return configuredOperations[0];
  }

  if (requestedOperation) {
    return configuredOperations[requestedOperation] || (
      Object.values(configuredOperations).includes(requestedOperation) ? requestedOperation : undefined
    );
  }

  return Object.values(configuredOperations)[0];
}

function operationError(definition: ProjectMcpToolConfig, requested: unknown) {
  const requestedText = typeof requested === 'string' && requested.trim() ? ` Requested operation: ${requested}.` : '';
  const configured = definition.operations
    ? ` Configured operations: ${JSON.stringify(definition.operations)}.`
    : ' No default operations are configured.';
  return {
    tool: definition.name,
    status: ToolResultStatus.REJECTED,
    server: definition.server,
    message: `No valid MCP operation was selected for project tool ${definition.name}.${requestedText}${configured}`
  };
}

function operationArgumentDefaults(
  definition: ProjectMcpToolConfig,
  requested: unknown,
  operation: string,
  templateContext: TemplateContext
): Record<string, unknown> {
  const defaults = definition.argumentDefaults || {};
  const requestedOperation = typeof requested === 'string' && requested.trim()
    ? requested.trim()
    : undefined;
  const configuredDefaults = (requestedOperation && defaults[requestedOperation])
    || defaults[operation]
    || {};
  return resolveArgumentTemplates(configuredDefaults, templateContext) as Record<string, unknown>;
}

function operationArgumentAllowlist(
  definition: ProjectMcpToolConfig,
  requested: unknown,
  operation: string
): string[] | undefined {
  const allowlist = definition.argumentAllowlist || {};
  const requestedOperation = typeof requested === 'string' && requested.trim()
    ? requested.trim()
    : undefined;
  return (requestedOperation && allowlist[requestedOperation]) || allowlist[operation];
}

function filterMcpArguments(
  definition: ProjectMcpToolConfig,
  requested: unknown,
  operation: string,
  argumentsRecord: Record<string, unknown>
): { arguments: Record<string, unknown>; droppedArguments: string[] } {
  const allowlist = operationArgumentAllowlist(definition, requested, operation);
  if (!allowlist) return { arguments: argumentsRecord, droppedArguments: [] };

  const allowed = new Set(allowlist);
  const filtered: Record<string, unknown> = {};
  const droppedArguments: string[] = [];
  for (const [key, value] of Object.entries(argumentsRecord)) {
    if (allowed.has(key)) filtered[key] = value;
    else droppedArguments.push(key);
  }
  return { arguments: filtered, droppedArguments };
}

function operationPathArguments(
  definition: ProjectMcpToolConfig,
  requested: unknown,
  operation: string
): Record<string, ProjectToolPathArgumentConfig> {
  const pathArguments = definition.pathArguments || {};
  const requestedOperation = typeof requested === 'string' && requested.trim()
    ? requested.trim()
    : undefined;
  return (requestedOperation && pathArguments[requestedOperation]) || pathArguments[operation] || {};
}

function stripConfiguredVirtualRoot(value: string, virtualRoot: string): string | undefined {
  const normalizedValue = value.replace(/\\/g, '/');
  const normalizedRoot = virtualRoot.replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalizedRoot) return undefined;
  if (normalizedValue === normalizedRoot) return '';
  return normalizedValue.startsWith(`${normalizedRoot}/`)
    ? normalizedValue.slice(normalizedRoot.length + 1)
    : undefined;
}

function pathArgumentExpectedRelativeForm(rootKind: string): string {
  const normalizedRootKind = rootKind.trim() || 'configured';
  return `<path-relative-to-${normalizedRootKind}-root>`;
}

function pathArgumentVirtualRootForm(virtualRoot: string, expectedRelativeForm: string): string {
  const normalizedRoot = virtualRoot.replace(/\\/g, '/').replace(/\/+$/g, '');
  return normalizedRoot ? `${normalizedRoot}/${expectedRelativeForm}` : expectedRelativeForm;
}

function pathArgumentEscapeGuidance(
  root: PathArgumentRootResolution,
  virtualRoots: string[]
): PathArgumentEscapeGuidance {
  const rootKind = root.kind.trim() || 'configured';
  const expectedRelativeForm = pathArgumentExpectedRelativeForm(rootKind);
  const virtualRootForms = virtualRoots.map(virtualRoot => pathArgumentVirtualRootForm(virtualRoot, expectedRelativeForm));
  const acceptedForms = [expectedRelativeForm, ...virtualRootForms];
  return {
    rootKind,
    allowedRoot: root.path,
    expectedRelativeForm,
    acceptedForms,
    remediation: [
      `Use a path inside the configured ${rootKind} root (${root.path}).`,
      `Pass ${acceptedForms.join(' or ')}; do not pass unrelated absolute paths or paths from a different configured root.`
    ]
  };
}

function pathArgumentEscapeMessage(
  toolName: string,
  argumentName: string,
  value: string,
  root: PathArgumentRootResolution,
  guidance: PathArgumentEscapeGuidance
): string {
  const acceptedForms = guidance.acceptedForms.length > 1
    ? ` Accepted path forms: ${guidance.acceptedForms.join(' or ')}.`
    : '';
  return `Project tool ${toolName} path argument ${argumentName} escapes configured ${root.kind} root: ${value}. ` +
    `Allowed root: ${guidance.allowedRoot}. Expected relative form: ${guidance.expectedRelativeForm}.${acceptedForms}`;
}

function pathArgumentRootKind(config: ProjectToolPathArgumentConfig): string {
  const configuredRootKind = config[PathArgumentConfigKey.ROOT_KIND];
  if (typeof configuredRootKind === 'string' && configuredRootKind.trim()) {
    return configuredRootKind;
  }
  const root = config[PathArgumentConfigKey.ROOT];
  if (root === CwdMode.PROJECT || root === CwdMode.WORKTREE || root === ProjectToolRootKind.FRAMEWORK) return root;
  return ProjectToolRootKind.WORKTREE;
}

function resolvePathArgumentRoot(config: ProjectToolPathArgumentConfig, templateContext: TemplateContext): PathArgumentRootResolution {
  const rootKind = pathArgumentRootKind(config);
  if (rootKind === ProjectToolRootKind.WORKTREE) {
    return { path: templateContext.worktreePath, kind: rootKind };
  }
  if (rootKind === ProjectToolRootKind.PROJECT) {
    return { path: templateContext.projectRoot, kind: rootKind };
  }
  if (rootKind === ProjectToolRootKind.FRAMEWORK) {
    if (!templateContext.frameworkRoot) {
      throw new Error('Project tool path argument uses framework root, but no framework root is available.');
    }
    return { path: templateContext.frameworkRoot, kind: rootKind };
  }
  if (rootKind === ProjectToolRootKind.WORKSPACE) {
    const workspaceRoot = config[PathArgumentConfigKey.WORKSPACE_ROOT];
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
      throw new Error('Project tool path argument uses workspace root, but workspaceRoot is not configured.');
    }
    return { path: resolvePathAgainst(templateContext.projectRoot, workspaceRoot, templateContext), kind: rootKind };
  }
  return {
    path: resolveCwdValue(config[PathArgumentConfigKey.ROOT] || CwdMode.WORKTREE, templateContext),
    kind: 'configured'
  };
}

function normalizePathArgumentValue(
  toolName: string,
  argumentName: string,
  value: string,
  config: ProjectToolPathArgumentConfig,
  templateContext: TemplateContext
): string {
  const root = resolvePathArgumentRoot(config, templateContext);
  const virtualRoots = (config[PathArgumentConfigKey.VIRTUAL_ROOTS] || [])
    .map(rootValue => resolveTemplateString(rootValue, templateContext))
    .sort((left, right) => right.length - left.length);
  let candidate: string | undefined;

  for (const virtualRoot of virtualRoots) {
    const relativeSuffix = stripConfiguredVirtualRoot(value, virtualRoot);
    if (relativeSuffix !== undefined) {
      candidate = path.resolve(root.path, relativeSuffix);
      break;
    }
  }

  if (!candidate) {
    const resolvedValue = resolveTemplateString(value, templateContext);
    candidate = path.isAbsolute(resolvedValue)
      ? path.resolve(resolvedValue)
      : path.resolve(root.path, resolvedValue);
  }

  if (config[PathArgumentConfigKey.MUST_STAY_INSIDE_ROOT] !== false && !isInsidePath(root.path, candidate)) {
    const guidance = pathArgumentEscapeGuidance(root, virtualRoots);
    throw new PathArgumentRootEscapeError(
      pathArgumentEscapeMessage(toolName, argumentName, value, root, guidance),
      guidance
    );
  }

  return candidate;
}

export function normalizeMcpPathArguments(
  definition: ProjectMcpToolConfig,
  requested: unknown,
  operation: string,
  argumentsRecord: Record<string, unknown>,
  templateContext: TemplateContext
): { arguments: Record<string, unknown>; normalizedPathArguments: string[] } {
  const pathArguments = operationPathArguments(definition, requested, operation);
  const normalizedArguments: Record<string, unknown> = { ...argumentsRecord };
  const normalizedPathArguments: string[] = [];

  for (const [argumentName, config] of Object.entries(pathArguments)) {
    const value = normalizedArguments[argumentName];
    if (typeof value === 'string') {
      normalizedArguments[argumentName] = normalizePathArgumentValue(
        definition.name,
        argumentName,
        value,
        config,
        templateContext
      );
      normalizedPathArguments.push(argumentName);
    } else if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
      normalizedArguments[argumentName] = value.map(item => normalizePathArgumentValue(
        definition.name,
        argumentName,
        item,
        config,
        templateContext
      ));
      normalizedPathArguments.push(argumentName);
    }
  }

  return { arguments: normalizedArguments, normalizedPathArguments };
}

async function createMcpTransport(server: McpServerDefinition, context: ProjectToolExecutionContext) {
  const templateContext = context.templateContext;
  if (server.command) {
    const env = resolveRecordTemplates(server.env, templateContext);
    return new StdioClientTransport({
      command: resolveTemplateString(server.command, templateContext),
      args: (server.args || []).map(arg => resolveTemplateString(arg, templateContext)),
      cwd: server.cwd ? resolveConfiguredPath(server.cwd, templateContext) : templateContext.worktreePath,
      env: { ...process.env, ...env, ...projectToolEnvironment(context) } as Record<string, string>,
      stderr: 'ignore'
    });
  }

  if (server.url) {
    const requestInit = server.headers
      ? { headers: resolveRecordTemplates(server.headers, templateContext) }
      : undefined;
    const url = new URL(resolveTemplateString(server.url, templateContext));
    return server.type === MCP_SSE_TRANSPORT
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
  }

  throw new Error('MCP server has neither command nor url configured.');
}

async function executeMcpTool(definition: ProjectMcpToolConfig, args: any, ctx: ExtensionContext, context: ProjectToolExecutionContext) {
  try {
    return await withSerializedMcpToolLock(definition, context, async () => executeMcpToolUnlocked(definition, args, ctx, context));
  } catch (error) {
    if (error instanceof SerializedMcpToolLockTimeoutError) {
      return serializedMcpLockTimeoutResult(definition, error);
    }
    throw error;
  }
}

async function executeMcpToolUnlocked(definition: ProjectMcpToolConfig, args: any, ctx: ExtensionContext, context: ProjectToolExecutionContext) {
  const templateContext = context.templateContext;
  const configPath = resolveConfiguredPath(definition.configPath || DEFAULT_MCP_CONFIG_PATH, templateContext);
  const operation = resolveMcpOperation(definition, args.operation);
  if (!operation) return operationError(definition, args.operation);

  try {
    const mcpConfig = await loadMcpConfig(configPath);
    const server = getMcpServers(mcpConfig)[definition.server];
    if (!server) {
      const message = `MCP server ${definition.server} is not configured in ${configPath}.`;
      if (definition.optional) return unavailable(definition.name, message);
      return {
        tool: definition.name,
        status: ToolResultStatus.REJECTED,
        server: definition.server,
        operation,
        message
      };
    }
    
    Logger.info(Component.PROJECT_TOOLS, 'Calling configured MCP tool', {
      tool: definition.name,
      server: definition.server,
      operation,
      timeoutMs: mcpToolRequestTimeoutMs(definition)
    });

    const client = new Client(
      { name: `orr-else-${definition.name}`, version: '1.0.0' },
      { capabilities: {} }
    );
    const transport = await createMcpTransport(server, context);
    try {
      await client.connect(transport);
      const defaultArguments = operationArgumentDefaults(definition, args.operation, operation, templateContext);
      const suppliedArguments = resolveArgumentTemplates(args.arguments || {}, templateContext) as Record<string, unknown>;
      const { arguments: toolArguments, droppedArguments } = filterMcpArguments(
        definition,
        args.operation,
        operation,
        {
          ...defaultArguments,
          ...suppliedArguments
        }
      );
      const normalizedArguments = normalizeMcpPathArguments(
        definition,
        args.operation,
        operation,
        toolArguments,
        templateContext
      );
      const result = await client.callTool({
        name: operation,
        arguments: normalizedArguments.arguments
      }, undefined, mcpToolRequestOptions(definition));

      if ((result as { isError?: boolean }).isError) {
        return {
          tool: definition.name,
          status: ToolResultStatus.REJECTED,
          server: definition.server,
          operation,
          droppedArguments,
          normalizedPathArguments: normalizedArguments.normalizedPathArguments,
          result
        };
      }

      return {
        tool: definition.name,
        status: ToolResultStatus.PASSED,
        server: definition.server,
        operation,
        droppedArguments,
        normalizedPathArguments: normalizedArguments.normalizedPathArguments,
        result
      };
    } finally {
      await client.close().catch((error: unknown) => {
        Logger.warn(Component.PROJECT_TOOLS, 'Failed to close MCP client', { server: definition.server, error: String(error) });
      });
      await transport.close().catch((error: unknown) => {
        Logger.warn(Component.PROJECT_TOOLS, 'Failed to close MCP transport', { server: definition.server, error: String(error) });
      });
    }
  } catch (error) {
    const message = String(error);
    if (definition.optional) return unavailable(definition.name, message);
    return {
      tool: definition.name,
      status: ToolResultStatus.REJECTED,
      server: definition.server,
      operation,
      message
    };
  }
}

export async function executeConfiguredProjectTool(
  eventStore: EventStore,
  pathFactory: ToolCallPathFactory,
  definition: ProjectToolConfig,
  args: Record<string, unknown>,
  ctx: ExtensionContext
): Promise<unknown> {
  const beadId = beadIdFromArgs(args);
  const context = executionContext(pathFactory, definition, args);
  const stateId = context.templateContext.stateId;
  const actionId = context.templateContext.actionId;
  if (definition.type === ProjectToolType.EXTENSION) {
    const result = {
      tool: definition.name,
      status: ToolResultStatus.REJECTED,
      message: `Project tool ${definition.name} is registered by a Pi extension and cannot be executed directly by Orr Else. Use it as a model tool call, or configure a command/mcp tool for harness-run parent actions.`
    };
    const finalResult = attachProjectToolSteering(definition, attachFailureCategory(definition, result));
    await eventStore.record(DomainEventName.PROJECT_TOOL_FAILED, {
      beadId,
      stateId,
      actionId,
      tool: definition.name,
      type: definition.type,
      status: result.status,
      result: summarizeToolResult(finalResult)
    }).catch(() => {});
    return finalResult;
  }

  const reservation = reserveProjectToolCall(definition, context);
  if (reservation.existing) {
    const result = attachProjectToolSteering(
      definition,
      attachFailureCategory(definition, projectToolBackpressureResult(definition, context, reservation.existing))
    );
    await eventStore.record(DomainEventName.PROJECT_TOOL_FAILED, {
      beadId,
      stateId,
      actionId,
      tool: definition.name,
      type: definition.type,
      status: ToolResultStatus.REJECTED,
      failureCategory: ProjectToolFailureCategory.BACKPRESSURE,
      result: summarizeToolResult(result)
    }).catch(() => {});
    return result;
  }

  try {
    const failureLimit = await projectToolFailureLimit(eventStore, definition, context);
    if (failureLimit.reached && failureLimit.result) {
      const result = attachProjectToolSteering(definition, attachFailureCategory(definition, failureLimit.result));
      await eventStore.record(DomainEventName.PROJECT_TOOL_FAILED, {
        beadId,
        stateId,
        actionId,
        tool: definition.name,
        type: definition.type,
        status: ToolResultStatus.REJECTED,
        result: summarizeToolResult(result)
      }).catch(() => {});
      return result;
    }

    await eventStore.record(
      DomainEventName.PROJECT_TOOL_STARTED,
      projectToolRunEventData(definition, context, beadId, stateId, actionId)
    );

    try {
      await prepareProjectToolOutputDir(context);
      const rawResult = definition.type === ProjectToolType.COMMAND
        ? await executeCommandTool(definition as ProjectCommandToolConfig, args, context)
        : await executeMcpTool(definition as ProjectMcpToolConfig, args, ctx, context);
      const result = await persistAndBoundResult(definition, rawResult, context);
      const status = statusFromToolResult(result);
      const infrastructureFailure = status !== ToolResultStatus.PASSED && isInfrastructureProjectToolFailure(result);
      const finalResultWithoutCategory = status === ToolResultStatus.PASSED
        ? result
        : !infrastructureFailure && failureLimit.maxFailures > 0 && failureLimit.failureCount + 1 >= failureLimit.maxFailures
          ? attachProjectToolFailureLimit(
            result,
            buildProjectToolFailureLimitResult(
              definition,
              failureLimit.failureCount + 1,
              failureLimit.maxFailures,
              stateId,
              actionId,
              routingHintSuggestedOutcome(result)
            )
          )
          : result;
      const finalResult = attachProjectToolSteering(definition, status === ToolResultStatus.PASSED
        ? finalResultWithoutCategory
        : attachFailureCategory(definition, finalResultWithoutCategory));
      await eventStore.record(
        status === ToolResultStatus.PASSED ? DomainEventName.PROJECT_TOOL_SUCCEEDED : DomainEventName.PROJECT_TOOL_FAILED,
        {
          beadId,
          stateId,
          actionId,
          tool: definition.name,
          type: definition.type,
          status,
          failureCategory: status === ToolResultStatus.PASSED ? undefined : classifyProjectToolFailure(definition, finalResult),
          result: summarizeToolResult(finalResult)
        }
      );
      return finalResult;
    } catch (error) {
      const failureCategory = classifyProjectToolFailure(definition, {
        status: ToolResultStatus.REJECTED,
        message: String(error)
      });
      await eventStore.record(DomainEventName.PROJECT_TOOL_FAILED, {
        beadId,
        stateId,
        actionId,
        tool: definition.name,
        type: definition.type,
        failureCategory,
        error: String(error)
      }).catch(() => {});
      throw error;
    }
  } finally {
    releaseProjectToolCall(reservation.key, context.templateContext.toolInvocationId);
  }
}

export function getConfiguredProjectToolNames(config: HarnessConfig): string[] {
  return (config.tools || []).map(tool => tool.name);
}

export function getHarnessRegisteredProjectToolNames(config: HarnessConfig): string[] {
  return (config.tools || [])
    .filter(tool => tool.type !== ProjectToolType.EXTENSION)
    .map(tool => tool.name);
}

export function getNativePiExtensionProjectToolNames(config: HarnessConfig): string[] {
  return (config.tools || [])
    .filter(tool => tool.type === ProjectToolType.EXTENSION)
    .map(tool => tool.name);
}

export function describeConfiguredProjectTools(config: HarnessConfig): string {
  const tools = config.tools || [];
  if (tools.length === 0) return '';

  function operationSummary(tool: ProjectMcpToolConfig): string {
    const operations = tool.operations || {};
    const values = Array.isArray(operations)
      ? operations
      : Object.entries(operations).map(([alias, operation]) => `${alias} -> ${operation}`);
    return values.length > 0 ? ` Operations: ${values.join(', ')}.` : '';
  }

  function allowlistSummary(tool: ProjectMcpToolConfig): string {
    const entries = Object.entries(tool.argumentAllowlist || {});
    if (entries.length === 0) return '';
    const values = entries.map(([operation, keys]) => `${operation}(${keys.join(', ') || 'no arguments'})`);
    return ` Allowed arguments: ${values.join('; ')}.`;
  }

  function defaultSummary(tool: ProjectMcpToolConfig): string {
    const entries = Object.entries(tool.argumentDefaults || {});
    if (entries.length === 0) return '';
    const values = entries.map(([operation, defaults]) => `${operation} defaults ${JSON.stringify(defaults)}`);
    return ` Argument defaults: ${values.join('; ')}.`;
  }

  function pathArgumentSummary(tool: ProjectMcpToolConfig): string {
    const entries = Object.entries(tool.pathArguments || {});
    if (entries.length === 0) return '';
    const values = entries.map(([operation, pathArguments]) => {
      const argumentsList = Object.keys(pathArguments).join(', ');
      const roots = [...new Set(Object.values(pathArguments).map(pathArgumentRootKind))];
      return `${operation}(${argumentsList}) [root: ${roots.join(', ')}]`;
    });
    return ` Harness-normalized path arguments: ${values.join('; ')}.`;
  }

  function commandPathScopeSummary(tool: ProjectCommandToolConfig): string {
    const scope = tool.argumentPathScope;
    if (!scope) return '';
    const parts: string[] = [];
    if (scope.positionals) parts.push('positionals');
    if (scope.flags?.length) parts.push(...scope.flags.map(normalizeConfiguredCliFlag));
    const root = pathArgumentRootKind(scope);
    return parts.length
      ? ` Harness-normalized path arguments: ${[...new Set(parts)].join(', ')} [root: ${root}].`
      : ` Harness-normalized command path arguments are enabled [root: ${root}].`;
  }

  function usageNotesSummary(tool: ProjectToolConfig): string {
    return tool.usageNotes?.length ? ` Usage notes: ${tool.usageNotes.join(' ')}` : '';
  }

  const descriptions = tools.map(tool => {
    const transport = tool.type === ProjectToolType.MCP
      ? ` MCP server \`${(tool as ProjectMcpToolConfig).server}\`.`
      : tool.type === ProjectToolType.EXTENSION
        ? ' Native Pi extension tool registered with `pi.registerTool()` from `.pi/extensions`, `~/.pi/agent/extensions`, or an installed Pi package.'
        : '';
    const mcpDetails = tool.type === ProjectToolType.MCP
      ? [
        operationSummary(tool as ProjectMcpToolConfig),
        allowlistSummary(tool as ProjectMcpToolConfig),
        defaultSummary(tool as ProjectMcpToolConfig),
        pathArgumentSummary(tool as ProjectMcpToolConfig)
      ].join('')
      : '';
    const commandDetails = tool.type === ProjectToolType.COMMAND
      ? commandPathScopeSummary(tool as ProjectCommandToolConfig)
      : '';
    return `- \`${tool.name}\`: ${tool.description || 'No description provided.'}${transport}${mcpDetails}${commandDetails}${usageNotesSummary(tool)}`;
  }).join('\n');

  return `\n### PROJECT-SPECIFIC TOOLS\nThe following project-specific tools are available to you:\n\n${PROJECT_TOOL_MODEL_CONTRACT.map(note => `- ${note}`).join('\n')}\n\n${descriptions}\n`;
}

function projectToolDescription(definition: ProjectToolConfig): string {
  const base = definition.description || `Project-specific tool: ${definition.name}`;
  return `${base} ${PROJECT_TOOL_DESCRIPTION_SUFFIX}`;
}

export function registerConfiguredProjectTools(
  eventStore: EventStore,
  pathFactory: ToolCallPathFactory,
  pi: ExtensionAPI,
  config: HarnessConfig,
  seen: Set<string>,
  wrapper: (tool: { name: string; description: string; parameters: unknown; execute(params: unknown, ctx?: unknown): unknown | Promise<unknown> }) => Parameters<ExtensionAPI['registerTool']>[0],
  runtimeContext?: () => ProjectToolRuntimeContext | undefined
) {
  const tools = config.tools || [];
  for (const definition of tools) {
    if (definition.type === ProjectToolType.EXTENSION) continue;
    if (seen.has(definition.name)) continue;
    seen.add(definition.name);
    const commandArgumentDescription = definition.type === ProjectToolType.COMMAND
      && (definition as ProjectCommandToolConfig).argumentPathScope
      ? 'Command arguments. Use an argv array for exact control, or an object whose keys become stable --kebab-case flags. Configured path arguments are normalized into the configured root and rejected before execution if they escape that root.'
      : 'Command arguments. Use an argv array for exact control, or an object whose keys become stable --kebab-case flags.';

    pi.registerTool(wrapper({
      name: definition.name,
      description: projectToolDescription(definition),
      parameters: definition.type === ProjectToolType.COMMAND
        ? Type.Object({
            [ProjectToolParameter.ARGUMENTS]: Type.Optional(Type.Any({
              description: commandArgumentDescription
            })),
            [ProjectToolParameter.CWD]: Type.Optional(Type.String({
              description: 'Optional execution directory override when the tool configuration has allowCwdOverride=true. Use "worktree", "project", or a configured path template.'
            }))
          })
        : Type.Object({
            operation: Type.Optional(Type.String({ description: 'The configured MCP operation or alias to perform' })),
            arguments: Type.Optional(Type.Object({}, { additionalProperties: true, description: 'JSON object arguments for the MCP tool operation' }))
          }),
      execute: async (params: any, ctx: ExtensionContext) => {
        const hiddenContext = runtimeContext?.() || {};
        const configuredFrameworkRoot = frameworkRootFromConfig(config);
        return await executeConfiguredProjectTool(eventStore, pathFactory, definition, {
          ...(params || {}),
          ...hiddenContext,
          ...(configuredFrameworkRoot ? { frameworkRoot: configuredFrameworkRoot } : {})
        }, ctx);
      }
    }));
  }
}
