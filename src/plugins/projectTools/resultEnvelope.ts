/**
 * Result persistence, model-facing envelope shaping, structured summarizers,
 * steering, and failure-category enrichment for projectTools.
 * Package-internal — do not import from outside src/plugins/.
 */
import path from 'path';
import { readdir, rm, stat, writeFile } from 'fs/promises';
import { resolveTemplateString as resolveTemplateStringHelper } from '../../core/PiIntegration.js';
import { Logger } from '../../core/Logger.js';
import type { ProjectToolConfig } from '../../core/domain/StateModels.js';
import { Component, ProjectToolDefaults, ToolResultStatus, WorkerDefaults } from '../../constants/index.js';
import {
  CODEMAP_TOOL_NAME,
  COMMAND_DIAGNOSTIC_LINE_PATTERN,
  COMMAND_DIAGNOSTIC_MAX_MATCH_LINES,
  COMMAND_DIAGNOSTIC_SECTION_SUFFIX,
  COMMAND_DIAGNOSTIC_TAIL_LINES,
  COMMAND_STREAM_OUTPUT_KEYS,
  DIAGNOSTIC_MESSAGE_PREFIX_CHARS,
  DIAGNOSTIC_SUMMARY_KEY,
  DIAGNOSTIC_SUMMARY_LOCATION_LIMIT,
  DIAGNOSTIC_TRUNCATION_PATTERN,
  INSUFFICIENT_EVIDENCE_NEXT_ACTION,
  MODEL_HIDDEN_RESULT_KEYS,
  MODEL_RAW_SUPPRESSED_KEYS,
  NO_MATCH_STATUS,
  PROJECT_TOOL_OUTPUT_ACCESS_GUIDANCE,
  ProjectToolNextAction,
  ProjectToolResultKey,
  PYTHON_LSP_TOOL_NAME,
  StructuredPayloadCollectionKey,
  StructuredPayloadIssueKey,
  StructuredPayloadSummaryKey,
  StructuredPayloadSummaryOutputKey,
  StructuredPayloadToolResultKey,
  SCAN_TARGET_COUNT_KEYS,
  SCAN_TARGET_COLLECTION_KEYS,
  SEMGREP_PATH_COLLECTION_KEYS,
  SCAN_TARGET_SAMPLE_LIMIT,
  ZERO_TARGET_SCAN_MESSAGE_PREFIX,
  ARTIFACT_VALIDATOR_TOOL_NAME,
  AST_GREP_NO_MATCH_FILTERED_RECOVERY,
  AST_GREP_TOOL_NAME,
  CMD_FAIL_TEST_LINE_PATTERN,
  CMD_FAIL_PYTEST_SECTION_PATTERN,
  CMD_FAIL_ASSERTION_PATTERN,
  CMD_FAIL_TRACEBACK_LINE_PATTERN,
  CMD_FAIL_LINT_LINE_PATTERN,
  CMD_FAIL_ESLINT_RULE_PATTERN,
  CMD_FAIL_SEVERITY_WORD_PATTERN,
  CMD_FAIL_TIMEOUT_PATTERN,
  CMD_FAIL_MAX_BUFFER_PATTERN,
  CMD_FAIL_SIGNAL_PATTERN,
  CMD_FAIL_TRANSPORT_PATTERN,
  HIGH_VOLUME_PAYLOAD_MIN_BYTES,
  HIGH_VOLUME_SAMPLE_COUNT,
  HIGH_VOLUME_NARROW_RERUN_RECOVERY,
  HIGH_VOLUME_RESULT_PREVIEW_MAX_BYTES,
  CODEMAP_RESULT_PREVIEW_MAX_BYTES,
  AST_GREP_RESULT_PREVIEW_MAX_BYTES,
  REFERENCE_DOCS_RESULT_PREVIEW_MAX_BYTES,
  GIT_HISTORY_RESULT_PREVIEW_MAX_BYTES,
  WORKFLOW_PARITY_RESULT_PREVIEW_MAX_BYTES,
  GIT_HISTORY_TOOL_NAME,
  REFERENCE_DOCS_TOOL_NAME,
  WORKFLOW_PARITY_TOOL_NAME,
  FAILURE_REREAD_ARCHIVE_RECOVERY,
  TOKEN_ESTIMATE_CHARS_PER_TOKEN,
  MODEL_FACING_RESULT_BUDGET_BYTES
} from './constants.js';
import {
  classifyProjectToolFailure,
  ProjectToolFailureCategory,
  isInfrastructureProjectToolFailure
} from './failureCategory.js';
import type {
  DiagnosticGroupAccumulator,
  DiagnosticGroupSummary,
  ModelFacingProjectToolResult,
  ParsedProjectDiagnostic,
  ParsedProjectDiagnostics,
  ProjectDiagnosticSummary,
  ProjectToolExecutionContext,
  ProjectToolOutputArchive,
  ScanTargetEvidence
} from './types.js';
import {
  isJsonRecord,
  nestedRecord,
  parseJsonRecord,
  resultRecord,
  searchableFailureText,
  serializeProjectToolResult,
  stringField,
  truncateString,
  uniqueLines,
  withoutUndefined
} from './utils.js';
import {
  commandDiagnosticPreview,
  textFromMcpContent,
  toolCallsFromRecord,
  structuredCommandResultPreview
} from './commandExecutor.js';
import { outputArtifactRef } from './contextHelpers.js';
import { pathArgumentRootKind, pathArgumentEscapeGuidance, resolvePathArgumentRoot } from './pathNormalization.js';

// ---- (9g8z) Module-level accounting registry ----
//
// WeakMap keyed on the model-facing result object so accounting survives identity
// changes from object spreading in attachProjectToolSteering.  persistAndBoundResult
// registers the accounting; any pipeline function that spreads the result into a new
// object must call transferResultAccounting(oldResult, newResult) to preserve the entry;
// summarizeToolResult reads and surfaces it into the event-store summary.
// The WeakMap holds no strong references — entries are GC-eligible once the result
// object is no longer reachable.  Typed as WeakMap<object, unknown>; call sites cast
// to ResultAccounting after the interface is declared below.
//
// NOTE (9g8z fragility): each pipeline function that creates a new object via spread
// must explicitly re-register using transferResultAccounting.  Currently:
//   - attachFailureCategory (resultEnvelope.ts)
//   - attachProjectToolSteering (resultEnvelope.ts)
//   - attachProjectToolFailureLimit (preflight.ts)
// A future spread at a new pipeline stage must add the same call to remain correct.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resultAccountingRegistry = new WeakMap<object, any>();

/**
 * (9g8z) Transfer the accounting entry from one result object to another.
 * Call this whenever a pipeline function spreads the result into a new object
 * so that summarizeToolResult can still find the accounting entry.
 * No-op when `from` has no accounting entry or is not an object.
 */
export function transferResultAccounting(from: unknown, to: object): void {
  if (typeof from !== 'object' || from === null) return;
  const accounting = resultAccountingRegistry.get(from as object);
  if (accounting !== undefined) resultAccountingRegistry.set(to, accounting);
}

// ---- Public types ----

export interface StructuredResult {
  status: 'ok' | 'parse_error';
  counts?: Record<string, number>;
  affectedPaths?: string[];
  representativeSamples?: unknown[];
  omissions?: string;
  nextAction?: string;
}

export interface ProjectToolSummarizer {
  name: string;
  appliesTo(definition: ProjectToolConfig, record: Record<string, unknown>): boolean;
  summarize(
    definition: ProjectToolConfig,
    record: Record<string, unknown>,
    context: ProjectToolExecutionContext
  ): StructuredResult | null;
}

// ---- Helpers ----

function statusFromToolResult(result: unknown): ToolResultStatus | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const status = (result as { status?: unknown }).status;
  return typeof status === 'string' ? status as ToolResultStatus : undefined;
}

// ---- structuredResultHasDecisionEvidence ----

export function structuredResultHasDecisionEvidence(value: unknown): boolean {
  if (!isJsonRecord(value)) return false;

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

  const counts = value['counts'];
  if (isJsonRecord(counts)) {
    return Object.values(counts).some(v => typeof v === 'number' && v > 0);
  }

  return false;
}

// ---- Diagnostic summarizer ----

function isInsidePath(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function normalizeDiagnosticSeverity(value: string): string {
  const severity = value.trim().toUpperCase();
  if (severity === 'INFORMATION') return 'INFO';
  return severity;
}

function severityRank(severity: string): number {
  switch (severity.toUpperCase()) {
    case 'ERROR': return 0;
    case 'WARNING': return 1;
    case 'INFO': return 2;
    default: return 3;
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

function diagnosticGroupKey(diagnostic: ParsedProjectDiagnostic): string {
  return [
    diagnostic.source || 'unknown',
    diagnostic.code || 'no-code',
    diagnosticMessagePrefix(diagnostic)
  ].join('\0');
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
      return { status: 'parse_error', nextAction: 'inspect_raw_archive_if_needed' };
    }
  }
};

// ---- commandFailureSummarizer ----

function isPlainTextCommandFailure(record: Record<string, unknown>): boolean {
  const status = record.status;
  if (status === ToolResultStatus.PASSED) return false;
  const hasPlainText =
    (typeof record[ProjectToolResultKey.STDOUT] === 'string' && (record[ProjectToolResultKey.STDOUT] as string).trim().length > 0)
    || (typeof record[ProjectToolResultKey.STDERR] === 'string' && (record[ProjectToolResultKey.STDERR] as string).trim().length > 0);
  if (!hasPlainText) return false;
  const stdoutStr = typeof record[ProjectToolResultKey.STDOUT] === 'string' ? record[ProjectToolResultKey.STDOUT] as string : '';
  if (stdoutStr.trim().startsWith('{') || stdoutStr.trim().startsWith('[')) {
    const parsed = parseJsonRecord(stdoutStr);
    if (parsed !== undefined) return false;
  }
  return true;
}

function parseCommandFailureTestGroups(text: string): { groups: Array<{ testName: string; assertionType?: string; locations: string[]; count: number }>; totalSeen: number } {
  const groups = new Map<string, { testName: string; assertionType?: string; locations: string[]; count: number }>();
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

    const sectionMatch = CMD_FAIL_PYTEST_SECTION_PATTERN.exec(line);
    if (sectionMatch) {
      flushGroup();
      currentTestName = sectionMatch[1].trim();
      continue;
    }

    const testLineMatch = CMD_FAIL_TEST_LINE_PATTERN.exec(line.trim());
    if (testLineMatch) {
      flushGroup();
      currentTestName = testLineMatch[1].trim();
      continue;
    }

    if (!currentTestName) continue;

    const assertionMatch = CMD_FAIL_ASSERTION_PATTERN.exec(line);
    if (assertionMatch && !currentAssertion) {
      currentAssertion = `${assertionMatch[1]}: ${assertionMatch[2].trim()}`;
      continue;
    }

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

  const all = [...groups.values()];
  return { groups: all.slice(0, ProjectToolDefaults.COMMAND_FAILURE_MAX_TEST_GROUPS), totalSeen: all.length };
}

function parseCommandFailureLintGroups(text: string): { groups: Array<{ rule: string; severity: string; locations: string[]; count: number }>; totalSeen: number } {
  const groups = new Map<string, { rule: string; severity: string; locations: string[]; count: number }>();
  let totalSeen = 0;
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trimEnd();
    const lintMatch = CMD_FAIL_LINT_LINE_PATTERN.exec(line);
    if (!lintMatch) continue;

    const filePath = lintMatch[1].trim();
    const lineNum = lintMatch[2];
    const severityWord = lintMatch[3]?.trim().toLowerCase() || '';
    const rest = lintMatch[4]?.trim() || '';

    let rule = '';
    const bracketRule = rest.match(/\[([^\]]{2,50})\]\s*$/);
    if (bracketRule) {
      rule = bracketRule[1].trim();
    } else if (index + 1 < lines.length) {
      const nextLine = lines[index + 1].trimEnd();
      const eslintRuleMatch = CMD_FAIL_ESLINT_RULE_PATTERN.exec(nextLine);
      if (eslintRuleMatch) {
        rule = eslintRuleMatch[1].trim();
        index += 1;
      }
    }

    if (!rule) {
      const hasSeveritySignal =
        Boolean(severityWord)
        || Boolean(CMD_FAIL_SEVERITY_WORD_PATTERN.exec(rest)?.[1]);
      if (!hasSeveritySignal) continue;
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
      totalSeen += 1;
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

const commandFailureSummarizer: ProjectToolSummarizer = {
  name: 'command_failure',
  appliesTo(definition: ProjectToolConfig, record: Record<string, unknown>): boolean {
    if (record.status === ToolResultStatus.PASSED) return false;
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

      const hasProcessSignal =
        processFields.timedOut
        || processFields.maxBufferExceeded
        || processFields.signal !== undefined
        || processFields.transportError
        || CMD_FAIL_TIMEOUT_PATTERN.test(combinedText)
        || CMD_FAIL_MAX_BUFFER_PATTERN.test(combinedText)
        || CMD_FAIL_SIGNAL_PATTERN.test(combinedText);

      const testParseResult = parseCommandFailureTestGroups(combinedText);
      const testGroups = testParseResult.groups;
      const testTotalSeen = testParseResult.totalSeen;
      const lintParseResult = parseCommandFailureLintGroups(combinedText);
      const lintGroups = lintParseResult.groups;
      const lintTotalSeen = lintParseResult.totalSeen;

      const hasTestGroups = testGroups.length > 0;
      const hasLintGroups = lintGroups.length > 0;
      const hasParsedGroups = hasTestGroups || hasLintGroups;

      if (!hasParsedGroups && !hasProcessSignal) {
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

      if (hasProcessSignal) {
        if (processFields.timedOut || CMD_FAIL_TIMEOUT_PATTERN.test(combinedText)) counts.timedOut = 1;
        if (processFields.maxBufferExceeded || CMD_FAIL_MAX_BUFFER_PATTERN.test(combinedText)) counts.maxBufferExceeded = 1;
        if (processFields.signal) counts.signal = 1;
        if (processFields.transportError || CMD_FAIL_TRANSPORT_PATTERN.test(combinedText)) counts.transportError = 1;
      }

      const totalFailures = (counts.testFailures || 0) + (counts.lintViolations || 0);
      if (totalFailures > 0) counts.failures = totalFailures;

      const result: StructuredResult = {
        status: 'ok',
        counts
      };
      if (affectedPaths.length > 0) result.affectedPaths = affectedPaths;
      if (representativeSamples.length > 0) result.representativeSamples = representativeSamples;

      if (!hasParsedGroups) {
        result.omissions = 'failure output could not be parsed into test/lint groups; diagnosticPreview and archive retain bounded raw context';
        result.nextAction = 'inspect_diagnosticPreview_then_archive_if_more_context_needed';
      } else {
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

      const extra: Record<string, unknown> = {};
      if (processFields.timedOut) extra.timedOut = true;
      if (processFields.maxBufferExceeded) extra.maxBufferExceeded = true;
      if (processFields.signal) extra.signal = processFields.signal;
      if (processFields.transportError) extra.transportError = true;
      if (Object.keys(extra).length > 0) Object.assign(result, extra);

      return result;
    } catch {
      return { status: 'parse_error', nextAction: 'inspect_diagnosticPreview_then_archive_if_needed' };
    }
  }
};

// ---- genericHighVolumeSummarizer ----
//
// Covers all high-volume tools that do NOT have a more specific summarizer
// (codemap, ast_grep, reference_docs, git_history, workflow_parity).  For
// any PASSED result whose raw payload exceeds HIGH_VOLUME_PAYLOAD_MIN_BYTES
// this summarizer emits a compact {status, counts, representativeSamples,
// omissions, nextAction} envelope before truncation so the model-facing
// result is a bounded summary rather than a raw truncated dump.
//
// The gate-evidence precedence guard in persistAndBoundResult ensures this
// result does NOT clobber a richer structuredResult already present (e.g.
// from structuredPayloadSummary or a more specific summarizer).
//
// Recovery text points agents to narrow-rerun / selector paths rather than
// whole-archive reads (scope: archive section retrieval by path/range).

const HIGH_VOLUME_TOOL_NAMES = new Set<string>([
  CODEMAP_TOOL_NAME,
  AST_GREP_TOOL_NAME,
  GIT_HISTORY_TOOL_NAME,
  REFERENCE_DOCS_TOOL_NAME,
  WORKFLOW_PARITY_TOOL_NAME
]);

function highVolumePreviewBudget(toolName: string): number {
  switch (toolName) {
    case CODEMAP_TOOL_NAME: return CODEMAP_RESULT_PREVIEW_MAX_BYTES;
    case AST_GREP_TOOL_NAME: return AST_GREP_RESULT_PREVIEW_MAX_BYTES;
    case REFERENCE_DOCS_TOOL_NAME: return REFERENCE_DOCS_RESULT_PREVIEW_MAX_BYTES;
    case GIT_HISTORY_TOOL_NAME: return GIT_HISTORY_RESULT_PREVIEW_MAX_BYTES;
    case WORKFLOW_PARITY_TOOL_NAME: return WORKFLOW_PARITY_RESULT_PREVIEW_MAX_BYTES;
    default: return HIGH_VOLUME_RESULT_PREVIEW_MAX_BYTES;
  }
}

function isHighVolumeTool(definition: ProjectToolConfig): boolean {
  return HIGH_VOLUME_TOOL_NAMES.has(definition.name.toLowerCase());
}

function rawPayloadBytes(record: Record<string, unknown>): number {
  let total = 0;
  for (const key of ['stdout', 'stderr', 'output', 'result']) {
    const value = record[key];
    if (typeof value === 'string') total += value.length;
    else if (value && typeof value === 'object') {
      try { total += JSON.stringify(value).length; } catch { /* ignore */ }
    }
  }
  if (typeof record.stdoutBytes === 'number') total = Math.max(total, record.stdoutBytes);
  if (typeof record.stderrBytes === 'number') total += record.stderrBytes;
  return total;
}

function extractHighVolumeText(record: Record<string, unknown>): string | undefined {
  const mcpText = textFromMcpContent(record.result);
  if (mcpText) return mcpText;

  const stdoutRecord = parseJsonRecord(record[ProjectToolResultKey.STDOUT]);
  const nestedStdout = typeof stdoutRecord?.stdout === 'string' && stdoutRecord.stdout.trim()
    ? stdoutRecord.stdout : undefined;
  if (nestedStdout) return nestedStdout;

  const existing = typeof record[ProjectToolResultKey.RESULT_PREVIEW] === 'string'
    && (record[ProjectToolResultKey.RESULT_PREVIEW] as string).trim()
    ? record[ProjectToolResultKey.RESULT_PREVIEW] as string
    : undefined;
  if (existing) return existing;

  const stdout = typeof record[ProjectToolResultKey.STDOUT] === 'string'
    ? record[ProjectToolResultKey.STDOUT] as string : undefined;
  if (stdout?.trim()) return stdout;

  const output = typeof record.output === 'string' ? record.output : undefined;
  if (output?.trim()) return output;

  return undefined;
}

function splitIntoLines(text: string): string[] {
  return text.split(/\r?\n/).filter(line => line.trim().length > 0);
}

function genericHighVolumePreview(
  toolName: string,
  lines: string[],
  totalLines: number,
  budget: number
): string {
  const header = `${toolName} result: ${totalLines} lines`;
  const samples: string[] = [];
  let used = header.length + 1;
  for (const line of lines.slice(0, HIGH_VOLUME_SAMPLE_COUNT)) {
    if (used + line.length + 1 > budget) break;
    samples.push(line);
    used += line.length + 1;
  }
  const omittedLines = totalLines - samples.length;
  const parts = [header, ...samples];
  if (omittedLines > 0) {
    parts.push(`[${omittedLines} lines omitted; rerun with narrower path/range/symbol to retrieve a specific section]`);
  }
  return parts.join('\n');
}

const genericHighVolumeSummarizer: ProjectToolSummarizer = {
  name: 'generic_high_volume',
  appliesTo(definition: ProjectToolConfig, record: Record<string, unknown>): boolean {
    if (!isHighVolumeTool(definition)) return false;
    // Only apply to PASSED results — failures are handled by commandFailureSummarizer
    if (record.status !== 'PASSED') return false;
    // Do NOT apply when an existing resultPreview already fits within the per-tool
    // preview budget.  The command executor sets RESULT_PREVIEW from the tool's stdout
    // (e.g. codemap structure overview, ast_grep match preview).  If that preview is
    // already compact enough, no summarizer is needed.  But if it exceeds the budget
    // (e.g. a raw large MCP text set as RESULT_PREVIEW by structuredCommandResultPreview),
    // we should still apply the generic summarizer to produce a compact structured result.
    const existingPreview = record[ProjectToolResultKey.RESULT_PREVIEW];
    if (typeof existingPreview === 'string' && existingPreview.trim().length > 0) {
      const budget = highVolumePreviewBudget(definition.name);
      // If the existing preview already fits within budget, leave it alone
      if (existingPreview.length <= budget) return false;
    }
    // Only apply when the raw payload is large enough to warrant summarization
    return rawPayloadBytes(record) >= HIGH_VOLUME_PAYLOAD_MIN_BYTES;
  },
  summarize(
    definition: ProjectToolConfig,
    record: Record<string, unknown>,
    _context: ProjectToolExecutionContext
  ): StructuredResult | null {
    try {
      const toolName = definition.name;
      const budget = highVolumePreviewBudget(toolName);
      const text = extractHighVolumeText(record);
      const payloadSize = rawPayloadBytes(record);

      const counts: Record<string, number> = { payloadBytes: payloadSize };

      let representativeSamples: unknown[] | undefined;

      // (4eqg) omissions string that names the sections/fields NOT inlined.
      // For high-volume tools this is embedded in the recovery guidance and causes
      // projectToolSteering to route USE_RESULT + HIGH_VOLUME_NARROW_RERUN_RECOVERY
      // (not FETCH_NAMED_OMISSION — the named re-fetch for high-volume is a narrower
      // rerun of the same tool with tighter arguments, not an archive section fetch).
      let omissionsText: string | undefined;

      if (text && text.trim().length > 0) {
        const lines = splitIntoLines(text);
        counts.lines = lines.length;
        const sampleLines = lines.slice(0, HIGH_VOLUME_SAMPLE_COUNT);
        counts.sampleLines = sampleLines.length;
        const omittedLineCount = lines.length - sampleLines.length;
        if (omittedLineCount > 0) {
          counts.omittedLines = omittedLineCount;
          // Populate omissions: name the sections NOT inlined so the model can
          // request a narrower rerun via HIGH_VOLUME_NARROW_RERUN_RECOVERY guidance.
          omissionsText = `${omittedLineCount} lines omitted from inline summary`
            + ` (${sampleLines.length} of ${lines.length} lines shown);`
            + ` full matches / entries preserved in outputArchive.`
            + ` To retrieve a specific section, rerun with a narrower path, range, symbol, or operation argument.`;
        }
        const compactPreview = genericHighVolumePreview(toolName, sampleLines, lines.length, budget);
        counts.previewBytes = compactPreview.length;
        representativeSamples = sampleLines.map(line => ({ line: truncateString(line, 160) }));
      }

      const result: StructuredResult = {
        status: 'ok',
        counts,
        nextAction: ProjectToolNextAction.USE_RESULT
      };
      if (representativeSamples && representativeSamples.length > 0) {
        result.representativeSamples = representativeSamples;
      }
      // (4eqg) Set omissions when lines were truncated.  projectToolSteering embeds
      // the omissions text in the HIGH_VOLUME_NARROW_RERUN_RECOVERY guidance and
      // routes USE_RESULT; it does NOT route FETCH_NAMED_OMISSION for high-volume tools.
      if (omissionsText) {
        result.omissions = omissionsText;
      }

      return result;
    } catch {
      return { status: 'parse_error', nextAction: 'inspect_archive_narrowly_if_needed' };
    }
  }
};

// ---- Summarizer registry ----

export const PROJECT_TOOL_SUMMARIZER_REGISTRY: ProjectToolSummarizer[] = [
  diagnosticSummarizer,
  commandFailureSummarizer,
  genericHighVolumeSummarizer
];

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

// ---- Scan target evidence policy ----

function scanTargetCountValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
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

function compactStructuredValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length <= ProjectToolDefaults.STRUCTURED_SUMMARY_TEXT_CHARS) return value;
  return `${value.slice(0, ProjectToolDefaults.STRUCTURED_SUMMARY_TEXT_CHARS)}...`;
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
  if (definition.type === 'command') {
    const scope = (definition as import('../../core/domain/StateModels.js').ProjectCommandToolConfig).argumentPathScope;
    return Boolean(scope && pathArgumentRootKind(scope) === 'framework');
  }
  return false;
}

function scanTargetVirtualRoots(
  definition: ProjectToolConfig,
  context: ProjectToolExecutionContext,
  config?: import('../../core/domain/StateModels.js').ProjectToolPathArgumentConfig
): string[] {
  const configuredRoots = ((config as Record<string, unknown> | undefined)?.['virtualRoots'] as string[] || [])
    .map((rootValue: string) => resolveTemplateStringHelper(rootValue, context.templateContext));
  const defaultRoots = isFrameworkScanTool(definition) ? ['/workspace/framework'] : [];
  return [...new Set([...configuredRoots, ...defaultRoots])];
}

function scanTargetEscapeGuidance(
  definition: ProjectToolConfig,
  context: ProjectToolExecutionContext
): import('./types.js').PathArgumentEscapeGuidance {
  const config = definition.type === 'command'
    ? (definition as import('../../core/domain/StateModels.js').ProjectCommandToolConfig).argumentPathScope
    : undefined;
  const virtualRoots = scanTargetVirtualRoots(definition, context, config);

  if (config) {
    try {
      return pathArgumentEscapeGuidance(resolvePathArgumentRoot(config, context.templateContext), virtualRoots);
    } catch {
      if (pathArgumentRootKind(config) === 'framework') {
        return pathArgumentEscapeGuidance({ path: '<configured-framework-root>', kind: 'framework' }, virtualRoots);
      }
    }
  }

  if (isFrameworkScanTool(definition)) {
    return pathArgumentEscapeGuidance(
      {
        path: context.templateContext.frameworkRoot || '<configured-framework-root>',
        kind: 'framework'
      },
      virtualRoots
    );
  }

  return pathArgumentEscapeGuidance(
    { path: context.templateContext.worktreePath, kind: 'worktree' },
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

// ---- Scratch cleanup ----

async function scratchDirUsage(dirPath: string): Promise<{ du: number }> {
  let total = 0;
  let entries: import('fs').Dirent[];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return { du: 0 };
  }
  await Promise.all(entries.map(async entry => {
    const full = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        const sub = await scratchDirUsage(full);
        total += sub.du;
      } else {
        const s = await stat(full);
        total += s.size;
      }
    } catch {
      // ignore entries that vanish mid-walk
    }
  }));
  return { du: total };
}

async function cleanupToolCallScratch(context: ProjectToolExecutionContext): Promise<void> {
  if (!ProjectToolDefaults.SCRATCH_CLEANUP_ENABLED) return;
  const scratchDir = context.tmpDir;
  let dirsRemoved = 0;
  let bytesReclaimed = 0;

  try {
    try {
      const { du } = await scratchDirUsage(scratchDir);
      bytesReclaimed = du;
    } catch {
      // size measurement is optional
    }

    await rm(scratchDir, { recursive: true, force: true });
    dirsRemoved = 1;
  } catch {
    return;
  }

  if (ProjectToolDefaults.SCRATCH_CLEANUP_LOG_SUMMARY && dirsRemoved > 0) {
    Logger.debug(Component.PROJECT_TOOLS, 'tool-call scratch cleaned up', {
      toolInvocationId: context.templateContext.toolInvocationId,
      tool: context.templateContext.toolName,
      dirsRemoved,
      bytesReclaimed
    });
  }
}

// ---- Remediation helpers ----

function projectToolRemediationValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function mergeProjectToolRemediation(existing: unknown, additional: string[]): string[] {
  return [...new Set([...projectToolRemediationValues(existing), ...additional])];
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

export function attachFailureCategory(definition: ProjectToolConfig, result: unknown): unknown {
  const failureCategory = classifyProjectToolFailure(definition, result);
  if (!failureCategory) return result;
  if (isJsonRecord(result)) {
    const remediation = mergeProjectToolRemediation(
      (result as Record<string, unknown>)[ProjectToolResultKey.REMEDIATION],
      projectToolRemediation(definition, failureCategory, result)
    );
    const newResult = withoutUndefined({
      ...(result as Record<string, unknown>),
      [ProjectToolResultKey.FAILURE_CATEGORY]: failureCategory,
      [ProjectToolResultKey.REMEDIATION]: remediation
    });
    // (9g8z) Preserve accounting across the spread — re-register on the new object.
    transferResultAccounting(result, newResult as object);
    return newResult;
  }
  const remediation = projectToolRemediation(definition, failureCategory, result);
  const newResult = {
    status: ToolResultStatus.REJECTED,
    tool: definition.name,
    [ProjectToolResultKey.FAILURE_CATEGORY]: failureCategory,
    [ProjectToolResultKey.REMEDIATION]: remediation,
    result
  };
  // (9g8z) Preserve accounting across the spread — re-register on the new object.
  transferResultAccounting(result, newResult as object);
  return newResult;
}

// ---- Steering ----

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

function projectToolResultHasSufficientCompactEvidence(record: Record<string, unknown>): boolean {
  if (record.maxBufferExceeded === true) return false;
  if (projectToolResultHasCompletePreview(record)) return true;
  if (projectToolResultHasActionableTruncatedPreview(record)) return true;
  return structuredResultHasDecisionEvidence(record[ProjectToolResultKey.STRUCTURED_RESULT]);
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

function projectToolSteering(definition: ProjectToolConfig, result: unknown): Record<string, unknown> {
  const record = resultRecord(result);
  const status = statusFromToolResult(record);

  if (record[ProjectToolResultKey.NEXT_ACTION] === INSUFFICIENT_EVIDENCE_NEXT_ACTION) {
    return {};
  }

  if (status === ToolResultStatus.PASSED) {
    if (record[ProjectToolResultKey.MATCH_STATUS] === NO_MATCH_STATUS) {
      const structuredResult = record[ProjectToolResultKey.STRUCTURED_RESULT];
      const hasOutputFilters = isJsonRecord(structuredResult) && structuredResult['outputFilters'] !== undefined;
      if (hasOutputFilters) {
        return {
          [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.RECORD_NO_MATCH,
          [ProjectToolResultKey.RECOVERY]: [
            AST_GREP_NO_MATCH_FILTERED_RECOVERY,
            'Record the no-match result as evidence if it satisfies the current check; otherwise rerun with a narrower or corrected pattern.'
          ]
        };
      }
      return {
        [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.RECORD_NO_MATCH,
        [ProjectToolResultKey.RECOVERY]: ['Record the no-match result as evidence if it satisfies the current check; otherwise rerun with a narrower or corrected pattern.']
      };
    }

    const structuredResultValue = record[ProjectToolResultKey.STRUCTURED_RESULT];
    if (structuredResultHasDecisionEvidence(structuredResultValue)) {
      const omissions = isJsonRecord(structuredResultValue) && typeof structuredResultValue.omissions === 'string'
        ? structuredResultValue.omissions
        : undefined;

      // (4eqg) High-volume tools (genericHighVolumeSummarizer) now set omissions to name
      // the sections that were NOT inlined.  For these tools the "named re-fetch" is
      // accomplished by rerunning with narrower args (not a literal archive section fetch),
      // so we route USE_RESULT + HIGH_VOLUME_NARROW_RERUN_RECOVERY even when omissions
      // is set — the omissions text is already embedded in the recovery so the model
      // can request a specific section via a narrower rerun.
      // Diagnostics and other summarizers that set omissions still get FETCH_NAMED_OMISSION.
      if (isHighVolumeTool(definition) && isGenericHighVolumeSummarizerResult(record)) {
        const highVolumeRecovery = omissions
          ? [`${HIGH_VOLUME_NARROW_RERUN_RECOVERY} Omitted sections: ${omissions}`]
          : [HIGH_VOLUME_NARROW_RERUN_RECOVERY];
        return {
          [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.USE_RESULT,
          [ProjectToolResultKey.RECOVERY]: highVolumeRecovery
        };
      }

      if (omissions) {
        return {
          [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.FETCH_NAMED_OMISSION,
          [ProjectToolResultKey.RECOVERY]: [
            `structuredResult omissions: ${omissions}`,
            'Fetch only the specific missing selector, path, or range identified in structuredResult.omissions; do not rerun the full tool call.'
          ]
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
          [ProjectToolResultKey.RECOVERY]: ['structuredResult contains sufficient decision evidence; treat artifactRef as an opaque harness archive handle, not a filesystem path. Decide from structuredResult, resultPreview, and toolCalls; rerun narrower only if structuredResult.omissions names a specific missing fact.']
        };
      }
      return {
        [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.USE_RESULT
      };
    }

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

  // (wp8h) Failure-gated 're-read don't re-run' steering.
  // For ANY failed command (non-zero exit / REJECTED status) where the failure
  // detail exceeds the inline summary (archive present), steer the model to
  // RE-READ the archived failure output via query_artifact / artifactRef handle
  // rather than RE-RUNNING the command.  Re-running an expensive failed build or
  // test suite without first reading the archived output wastes time and compute.
  //
  // This branch fires BEFORE the failure-category switch so it applies to all
  // failure categories that have an archive (verifier_failed, unclassified, etc.).
  // Failure categories with their own specific recovery (backpressure, transient,
  // tool_input_error, unavailable, worktree_state_error, terminal_gate) are
  // handled in the switch below — those are NOT the expensive-command-rerun cases.
  //
  // SUCCESS-path steering is intentionally unchanged — the success path returns
  // above at `if (status === ToolResultStatus.PASSED)` and never reaches here.
  const hasArchive = Boolean(record[ProjectToolResultKey.OUTPUT_ARCHIVE]);
  const hasNonZeroExit = typeof record.exitCode === 'number' && record.exitCode !== 0;
  const isExpensiveCommandFailureWithArchive = hasArchive && hasNonZeroExit;

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
      if (isExpensiveCommandFailureWithArchive) {
        return {
          [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.FIX_OR_ROUTE_FAILURE,
          [ProjectToolResultKey.RECOVERY]: [FAILURE_REREAD_ARCHIVE_RECOVERY]
        };
      }
      return { [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.FIX_OR_ROUTE_FAILURE };
    default:
      // For unclassified failures with an archive and non-zero exit, apply the
      // re-read recovery to avoid expensive re-runs.
      if (isExpensiveCommandFailureWithArchive) {
        return {
          [ProjectToolResultKey.NEXT_ACTION]: ProjectToolNextAction.FIX_OR_ROUTE_FAILURE,
          [ProjectToolResultKey.RECOVERY]: [FAILURE_REREAD_ARCHIVE_RECOVERY]
        };
      }
      return {};
  }
}

export function attachProjectToolSteering(definition: ProjectToolConfig, result: unknown): unknown {
  const steering = projectToolSteering(definition, result);
  if (Object.keys(steering).length === 0) return result;
  if (isJsonRecord(result)) {
    const newResult = withoutUndefined({
      ...(result as Record<string, unknown>),
      ...steering
    });
    // (9g8z) Preserve accounting across the spread — re-register on the new object.
    transferResultAccounting(result, newResult as object);
    return newResult;
  }
  const newResult = withoutUndefined({
    tool: definition.name,
    status: ToolResultStatus.REJECTED,
    result,
    ...steering
  });
  // (9g8z) Preserve accounting across the spread — re-register on the new object.
  transferResultAccounting(result, newResult as object);
  return newResult;
}

// ---- Model-facing envelope ----

function outputArchiveSummary(context: ProjectToolExecutionContext, bytes: number, truncated: boolean): ProjectToolOutputArchive {
  return {
    artifactRef: outputArtifactRef(context),
    bytes,
    truncated
  };
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

function modelFacingInlineResult(result: unknown): ModelFacingProjectToolResult {
  const record = resultRecord(result);
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

function isGenericHighVolumeSummarizerResult(record: Record<string, unknown>): boolean {
  if (record[DIAGNOSTIC_SUMMARY_KEY]) return false;
  const sr = record[ProjectToolResultKey.STRUCTURED_RESULT];
  if (!isJsonRecord(sr) || typeof sr['counts'] !== 'object') return false;
  const counts = sr['counts'] as Record<string, unknown>;
  return typeof counts['payloadBytes'] === 'number';
}

function resultPreviewText(
  record: Record<string, unknown>,
  limitBytes: number,
  definition?: Pick<ProjectToolConfig, 'name'>
): string | undefined {
  const hasStructuredModelSummary =
    Boolean(record[ProjectToolResultKey.STRUCTURED_RESULT]) || Boolean(record[DIAGNOSTIC_SUMMARY_KEY]);

  if (hasStructuredModelSummary) {
    const existingPreview = typeof record[ProjectToolResultKey.RESULT_PREVIEW] === 'string'
      && String(record[ProjectToolResultKey.RESULT_PREVIEW]).trim()
      ? String(record[ProjectToolResultKey.RESULT_PREVIEW])
      : undefined;
    if (!existingPreview) return undefined;
    // For high-volume tools summarized by genericHighVolumeSummarizer, apply the
    // per-tool preview budget (which may exceed the shared 2 KiB diagnostic constant).
    // Diagnostics are unchanged: they still use DIAGNOSTIC_SUMMARY_RESULT_PREVIEW_MAX_BYTES.
    const previewBudget = (definition && isGenericHighVolumeSummarizerResult(record))
      ? highVolumePreviewBudget(definition.name)
      : ProjectToolDefaults.DIAGNOSTIC_SUMMARY_RESULT_PREVIEW_MAX_BYTES;
    return boundedPreviewText(existingPreview, previewBudget);
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
  const resultPreview = resultPreviewText(record, previewBytes, definition);
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

// ---- summarizeToolResult (for event store) ----

export function summarizeToolResult(result: unknown): unknown {
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
  // (9g8z) Read accounting from the module-level WeakMap registry and surface it
  // into the event-store summary as an enumerable field.  This is the ONLY place
  // _accounting is written into a serializable record; it never appears on the
  // model-facing result because persistAndBoundResult only registers it in the
  // WeakMap (not as any property on the result object).  attachProjectToolSteering
  // and attachFailureCategory re-register accounting on any new spread object they
  // create so the entry survives through the steering pipeline to this call site.
  // As a fallback, also check for a direct _accounting property (enumerable or not)
  // on the record — this handles synthetic test objects and any path that attaches
  // accounting directly rather than via the WeakMap.
  const accountingValue = typeof result === 'object' && result !== null
    ? (resultAccountingRegistry.get(result as object) ?? (result as Record<string, unknown>)['_accounting'])
    : undefined;
  if (accountingValue !== undefined) {
    summary['_accounting'] = accountingValue;
  }
  return summary;
}

// ---- (9g8z) Per-tool-result token accounting + leak flag ----
//
// Accounting lives exclusively on the harness/event side:
//   - persistAndBoundResult computes it and registers it in resultAccountingRegistry
//     (a module-level WeakMap) keyed on the model-facing result object.  No property
//     is added to the result, so the model-facing payload is unchanged.
//   - attachProjectToolSteering re-registers accounting on any new object it creates
//     via spread so the WeakMap entry survives through the steering pipeline.
//   - summarizeToolResult reads from the WeakMap and copies _accounting into the
//     event-store summary as an enumerable field for harness-internal aggregation.
//   - rawExceededBudget compares the RAW (pre-bounding) serialized bytes to
//     MODEL_FACING_RESULT_BUDGET_BYTES (4 KiB) — it fires when the tool produced more
//     data than the budget and the harness had to truncate/bound the output.  This is
//     the meaningful, reachable signal; modelFacingBytes is hard-clamped so a
//     modelFacingBytes-based check would be permanently dead.
// A future leak-report tool can aggregate these records to identify hot spots.

export interface ResultAccounting {
  /** Byte length of the serialized full result before bounding. */
  rawBytes: number;
  /** Byte length of the final model-facing serialized result. */
  modelFacingBytes: number;
  /** Approximate token estimate: modelFacingBytes / TOKEN_ESTIMATE_CHARS_PER_TOKEN. */
  tokenEstimate: number;
  /** Ratio: modelFacingBytes / rawBytes.  Lower is better (more reduction). */
  reductionRatio: number;
  /** True when the RAW (pre-bounding) result exceeded MODEL_FACING_RESULT_BUDGET_BYTES,
   *  meaning the harness had to truncate/bound the output.  This is the meaningful leak
   *  signal: the tool produced more data than the budget and the pipeline had to intervene.
   *  Based on rawBytes (reachable), NOT modelFacingBytes (which is hard-clamped to <= budget). */
  rawExceededBudget: boolean;
  /** Tool name for aggregation. */
  tool: string;
  /** The raw-output budget threshold used for the rawExceededBudget flag computation. */
  resultBudgetBytes: number;
}

export interface ResultAccountingLeakReport {
  /** Tool name. */
  tool: string;
  /** Number of results sampled for this tool. */
  sampleCount: number;
  /** Average reduction ratio across samples (lower is worse). */
  avgReductionRatio: number;
  /** Number of samples where the raw result exceeded the budget (rawExceededBudget was true). */
  rawExceededBudgetCount: number;
  /** Average model-facing bytes across samples. */
  avgModelFacingBytes: number;
  /** Average token estimate across samples. */
  avgTokenEstimate: number;
}

/**
 * (9g8z) Pure helper: given a set of ResultAccounting records, return tools
 * ranked by leakiness (poor reduction ratio + budget exceedance).
 * Ready for a future leak-discovery report tool; no event/OTEL wiring in this bead.
 */
export function summarizeResultAccounting(records: ResultAccounting[]): ResultAccountingLeakReport[] {
  if (records.length === 0) return [];

  // Group by tool name
  const byTool = new Map<string, ResultAccounting[]>();
  for (const record of records) {
    const existing = byTool.get(record.tool);
    if (existing) {
      existing.push(record);
    } else {
      byTool.set(record.tool, [record]);
    }
  }

  const reports: ResultAccountingLeakReport[] = [];
  for (const [tool, toolRecords] of byTool) {
    const sampleCount = toolRecords.length;
    const avgReductionRatio = toolRecords.reduce((sum, r) => sum + r.reductionRatio, 0) / sampleCount;
    const rawExceededBudgetCount = toolRecords.filter(r => r.rawExceededBudget).length;
    const avgModelFacingBytes = toolRecords.reduce((sum, r) => sum + r.modelFacingBytes, 0) / sampleCount;
    const avgTokenEstimate = toolRecords.reduce((sum, r) => sum + r.tokenEstimate, 0) / sampleCount;
    reports.push({
      tool,
      sampleCount,
      avgReductionRatio,
      rawExceededBudgetCount,
      avgModelFacingBytes,
      avgTokenEstimate
    });
  }

  // Rank by leakiness: highest rawExceededBudgetCount first (tools that most frequently
  // produced raw output beyond the budget), then worst (highest) avgReductionRatio as
  // tiebreaker (a ratio closer to 1.0 means less compression was achieved).
  reports.sort((a, b) => {
    if (b.rawExceededBudgetCount !== a.rawExceededBudgetCount) {
      return b.rawExceededBudgetCount - a.rawExceededBudgetCount;
    }
    return b.avgReductionRatio - a.avgReductionRatio;
  });

  return reports;
}

function computeResultAccounting(
  toolName: string,
  rawBytes: number,
  modelFacingBytes: number
): ResultAccounting {
  const tokenEstimate = Math.ceil(modelFacingBytes / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
  const reductionRatio = rawBytes > 0 ? modelFacingBytes / rawBytes : 1;
  // rawExceededBudget: true when the RAW (pre-bounding) result exceeded the budget,
  // meaning the harness had to truncate it.  Based on rawBytes, NOT modelFacingBytes —
  // modelFacingBytes is hard-clamped to <= INLINE_RESULT_BYTES so it can NEVER exceed
  // MODEL_FACING_RESULT_BUDGET_BYTES, making a modelFacingBytes-based check permanently
  // dead.  The raw check is the meaningful, reachable signal for leaky tool producers.
  const rawExceededBudget = rawBytes > MODEL_FACING_RESULT_BUDGET_BYTES;
  return {
    rawBytes,
    modelFacingBytes,
    tokenEstimate,
    reductionRatio,
    rawExceededBudget,
    tool: toolName,
    resultBudgetBytes: MODEL_FACING_RESULT_BUDGET_BYTES
  };
}

// ---- applyHighVolumeModelSummary ----
//
// Injects a compact RESULT_PREVIEW for high-volume tools summarized by
// genericHighVolumeSummarizer, mirroring the pattern used by
// applyDiagnosticModelSummary.  Only runs when the structuredResult on the
// record came from the generic summarizer (identified by presence of
// counts.payloadBytes without a diagnosticSummary) AND no RESULT_PREVIEW
// is already set.  This ensures the model-facing resultPreview is within
// the per-tool budget rather than a raw truncated dump.

function applyHighVolumeModelSummary(
  definition: ProjectToolConfig,
  result: unknown
): unknown {
  if (!isHighVolumeTool(definition)) return result;
  const record = resultRecord(result);
  const budget = highVolumePreviewBudget(definition.name);
  // Only inject when no compact RESULT_PREVIEW is already present.
  // An existing preview that fits within budget is fine as-is.  One that
  // exceeds the budget (e.g. raw MCP text) should be replaced with the
  // compact summary from the generic summarizer.
  const existingPreview = record[ProjectToolResultKey.RESULT_PREVIEW];
  if (typeof existingPreview === 'string'
    && existingPreview.trim().length > 0
    && existingPreview.length <= budget) {
    return result;
  }
  // Require a structuredResult from the generic summarizer (payloadBytes present).
  const sr = record[ProjectToolResultKey.STRUCTURED_RESULT];
  if (!isJsonRecord(sr) || typeof sr['counts'] !== 'object') return result;
  const counts = sr['counts'] as Record<string, unknown>;
  if (typeof counts['payloadBytes'] !== 'number') return result;

  const text = extractHighVolumeText(record);
  if (!text || !text.trim()) return result;

  const toolName = definition.name;
  const lines = splitIntoLines(text);
  const sampleLines = lines.slice(0, Math.min(HIGH_VOLUME_SAMPLE_COUNT, lines.length));
  const compactPreview = genericHighVolumePreview(toolName, sampleLines, lines.length, budget);

  return withoutUndefined({
    ...record,
    [ProjectToolResultKey.RESULT_PREVIEW]: compactPreview
  });
}

// ---- persistAndBoundResult ----

export async function persistAndBoundResult(
  definition: ProjectToolConfig,
  result: unknown,
  context: ProjectToolExecutionContext
): Promise<unknown> {
  const policyResult = applyScanTargetEvidencePolicy(definition, result, context);
  const serialized = serializeProjectToolResult(policyResult);
  await writeFile(context.outputFile, serialized);
  void cleanupToolCallScratch(context);
  const maxInlineBytes = inlineResultLimit(definition);

  const structuredResult = applyStructuredSummarizerRegistry(definition, policyResult, context);

  const existingStructuredResult = resultRecord(policyResult)[ProjectToolResultKey.STRUCTURED_RESULT];
  const hasGateEvidence = structuredResultHasDecisionEvidence(existingStructuredResult);
  const enrichedResult = (structuredResult && !hasGateEvidence)
    ? withoutUndefined({ ...resultRecord(policyResult), [ProjectToolResultKey.STRUCTURED_RESULT]: structuredResult })
    : policyResult;

  const modelResult = applyDiagnosticModelSummary(
    definition,
    applyHighVolumeModelSummary(definition, enrichedResult),
    context
  );
  const record = resultRecord(modelResult);

  let modelFacingResult: ModelFacingProjectToolResult;
  if (serialized.length <= maxInlineBytes) {
    modelFacingResult = attachArchiveIfNeeded(modelFacingInlineResult(modelResult), context, serialized.length, false);
  } else {
    modelFacingResult = modelFacingTruncatedResult(definition, record, context, serialized, maxInlineBytes);
  }

  // (9g8z) Compute lightweight token accounting and register it in the module-level
  // WeakMap (resultAccountingRegistry) keyed on the returned model-facing result object.
  // The WeakMap holds no strong reference — the entry is GC-eligible when the result is
  // no longer reachable.  No accounting key is added to modelFacingResult, so the
  // model-facing payload is byte-identical to before 9g8z.
  // attachProjectToolSteering re-registers the accounting on any new spread object it
  // creates so the entry survives through the steering pipeline.
  // summarizeToolResult reads from the registry and writes _accounting into the
  // event-store summary, keeping it exclusively on the harness/event side.
  const modelFacingJson = JSON.stringify(modelFacingResult);
  const accounting = computeResultAccounting(
    definition.name,
    serialized.length,
    modelFacingJson.length
  );
  resultAccountingRegistry.set(modelFacingResult as object, accounting);

  return modelFacingResult;
}
