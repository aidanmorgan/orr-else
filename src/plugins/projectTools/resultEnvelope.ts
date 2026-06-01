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
  CMD_FAIL_TRANSPORT_PATTERN
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

// ---- Summarizer registry ----

export const PROJECT_TOOL_SUMMARIZER_REGISTRY: ProjectToolSummarizer[] = [
  diagnosticSummarizer,
  commandFailureSummarizer
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
    return withoutUndefined({
      ...(result as Record<string, unknown>),
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

export function attachProjectToolSteering(definition: ProjectToolConfig, result: unknown): unknown {
  const steering = projectToolSteering(definition, result);
  if (Object.keys(steering).length === 0) return result;
  if (isJsonRecord(result)) {
    return withoutUndefined({
      ...(result as Record<string, unknown>),
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

function resultPreviewText(record: Record<string, unknown>, limitBytes: number): string | undefined {
  const hasStructuredModelSummary =
    Boolean(record[ProjectToolResultKey.STRUCTURED_RESULT]) || Boolean(record[DIAGNOSTIC_SUMMARY_KEY]);

  if (hasStructuredModelSummary) {
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
  return summary;
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

  const modelResult = applyDiagnosticModelSummary(definition, enrichedResult, context);
  const record = resultRecord(modelResult);
  if (serialized.length <= maxInlineBytes) {
    return attachArchiveIfNeeded(modelFacingInlineResult(modelResult), context, serialized.length, false);
  }

  return modelFacingTruncatedResult(definition, record, context, serialized, maxInlineBytes);
}
