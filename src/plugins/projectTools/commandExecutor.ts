/**
 * Command (shell/execa) executor for projectTools.
 * Package-internal — do not import from outside src/plugins/.
 */
import path from 'path';
import { execa } from 'execa';
import { open, readFile, stat } from 'fs/promises';
import { resolveTemplateString } from '../../core/PiIntegration.js';
import type { ProjectCommandToolConfig } from '../../core/domain/StateModels.js';
import { CommandErrorCode, CommandExitCode, Defaults, ProjectToolDefaults, ToolResultStatus } from '../../constants/index.js';
import {
  ARTIFACT_VALIDATOR_TOOL_NAME,
  AST_GREP_TOOL_NAME,
  COMMAND_DIAGNOSTIC_LINE_PATTERN,
  COMMAND_DIAGNOSTIC_MAX_MATCH_LINES,
  COMMAND_DIAGNOSTIC_SECTION_SUFFIX,
  COMMAND_DIAGNOSTIC_TAIL_LINES,
  COMMAND_STDERR_FILE_NAME,
  COMMAND_STDOUT_FILE_NAME,
  COMMAND_STREAM_OUTPUT_KEYS,
  COMMAND_TRUNCATION_MARKER_PREFIX,
  COMMAND_TRUNCATION_STREAM_MARKER_SUFFIX,
  COMMAND_TRUNCATION_TEXT_MARKER_SUFFIX,
  NO_MATCH_STATUS,
  ProjectToolParameter,
  ProjectToolResultKey,
  StructuredPayloadCollectionKey,
  StructuredPayloadSummaryKey,
  StructuredPayloadSummaryOutputKey,
  StructuredPayloadIssueKey,
  StructuredPayloadToolResultKey,
  UNSUPPORTED_ARTIFACT_VALIDATOR_OUTPUT_CONTROL_FLAGS,
  PROJECT_TOOL_CONTROL_PARAMETERS,
  SCAN_TARGET_COUNT_KEYS,
  SCAN_TARGET_COLLECTION_KEYS,
  SEMGREP_PATH_COLLECTION_KEYS,
  SCAN_TARGET_SAMPLE_LIMIT
} from './constants.js';
import { ProjectToolFailureCategory } from './failureCategory.js';
import type { CommandResultInput, ProjectToolExecutionContext, ScanTargetEvidence } from './types.js';
import {
  isJsonRecord,
  parseJsonRecord,
  resultRecord,
  uniqueLines,
  withoutUndefined,
  nestedRecord
} from './utils.js';
import {
  normalizeCommandArgumentPaths,
  normalizeConfiguredCliFlag
} from './pathNormalization.js';
import { projectToolEnvironment } from './contextHelpers.js';
import { resolveStructuredInvocation } from './structuredInvocation.js';

// ---- Argument normalization ----

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

// ---- Exit code / buffer helpers ----

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

export function commandReturnBytes(definition: ProjectCommandToolConfig): number {
  if (typeof definition.maxOutputBytes !== 'number' || !Number.isFinite(definition.maxOutputBytes) || definition.maxOutputBytes <= 0) {
    return ProjectToolDefaults.COMMAND_RETURN_BYTES;
  }
  return Math.min(definition.maxOutputBytes, ProjectToolDefaults.COMMAND_RETURN_BYTES);
}

export function boundedCommandText(value: unknown, limitBytes: number): { text: string; bytes: number; truncated: boolean } {
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

export async function boundedCommandFile(filePath: string, limitBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
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

// ---- Structured payload helpers ----

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

export function scanTargetEvidenceFromResult(result: unknown): ScanTargetEvidence | undefined {
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

export function structuredPayloadSummary(record: Record<string, unknown>): Record<string, unknown> | undefined {
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

// ---- Tool calls extraction ----

export async function jsonRecordFromFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  let size = 0;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return undefined;
  }
  if (size <= 0 || size > ProjectToolDefaults.TOOL_CALL_EXTRACTION_MAX_BYTES) return undefined;
  return parseJsonRecord(await readFile(filePath, 'utf8'));
}

export function toolCallsFromRecord(record: Record<string, unknown>): unknown[] | undefined {
  const direct = record[ProjectToolResultKey.TOOL_CALLS];
  if (Array.isArray(direct)) return direct;
  const framework = record[ProjectToolResultKey.FRAMEWORK_TOOL_CALLS];
  if (Array.isArray(framework)) return framework;
  const stdoutRecord = parseJsonRecord(record[ProjectToolResultKey.STDOUT]);
  if (!stdoutRecord) return undefined;
  return toolCallsFromRecord(stdoutRecord);
}

// ---- ast_grep annotations ----

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

export function unsupportedArtifactValidatorOutputControlResult(
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

export function commandPathRejectionResult(
  definition: ProjectCommandToolConfig,
  rejection: import('./types.js').CommandArgumentPathRejection,
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
    message: 'ast_grep found no matches (exit code 1 with empty output). This is accepted absence evidence only when the pattern is known valid; otherwise adjust the pattern, language, or path and rerun with narrower arguments.'
  };
}

function commandFailureStatus(error: any): ToolResultStatus {
  return error?.code === 'ENOENT' ? ToolResultStatus.UNAVAILABLE : ToolResultStatus.REJECTED;
}

export function structuredCommandResultPreview(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  const stdout = typeof record.stdout === 'string' && record.stdout.trim() ? record.stdout : undefined;
  const stderr = typeof record.stderr === 'string' && record.stderr.trim() ? record.stderr : undefined;
  const mcpText = textFromMcpContent(record.result);
  if (stdout && stderr) return `stdout:\n${stdout}\n\nstderr:\n${stderr}`;
  if (stdout) return stdout;
  if (stderr) return `stderr:\n${stderr}`;
  return mcpText;
}

export function textFromMcpContent(value: unknown): string | undefined {
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

export function commandDiagnosticPreview(record: Record<string, unknown>): string | undefined {
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

// ---- buildCommandResult ----

export function buildCommandResult(input: CommandResultInput): object {
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

// ---- executeCommandTool ----

export async function executeCommandTool(definition: ProjectCommandToolConfig, args: any, context: ProjectToolExecutionContext) {
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

  const scopedArgs = definition.allowArgs
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

  // --- Structured invocation: inject machine-readable output flag if known tool ---
  // resolveStructuredInvocation returns null when the tool is unknown OR when an
  // output-format flag is already present — in both cases we leave finalArgs unchanged
  // and fall back to the existing text summarizers after the process completes.
  const structuredHandler = resolveStructuredInvocation(command, finalArgs);
  const spawnArgs = structuredHandler ? structuredHandler.augmentedArgs : finalArgs;

  try {
    const result = await execa(command, spawnArgs, {
      cwd: context.cwd,
      env: { ...context.hostEnv, ...env, ...projectToolEnvironment(context) },
      stdout: { file: stdoutFile },
      stderr: { file: stderrFile },
      reject: false,
      timeout: definition.timeoutMs || Defaults.PROCESS_REAP_INTERVAL_MS
    });
    const boundedStdout = await boundedCommandFile(stdoutFile, returnBytes);
    const boundedStderr = await boundedCommandFile(stderrFile, returnBytes);
    const structuredStdout = await jsonRecordFromFile(stdoutFile);
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : undefined;

    // If a structured handler is active, parse the process output into a compact
    // structuredResult.  If parse() returns null (malformed/empty JSON), fall back
    // to the existing structuredPayloadSummary path — no regression.
    const parsedStructuredResult = structuredHandler
      ? structuredHandler.parse(boundedStdout.text, boundedStderr.text, exitCode)
      : null;
    const structuredSummary = parsedStructuredResult
      ?? (structuredStdout ? structuredPayloadSummary(structuredStdout) : undefined);

    const toolCalls = structuredStdout ? toolCallsFromRecord(structuredStdout) : undefined;
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
    const exitCode = typeof error.code === 'number' ? error.code : undefined;

    // Same fallback logic as in the success path: structured parse takes precedence,
    // null parse falls through to the existing structuredPayloadSummary.
    const parsedStructuredResult = structuredHandler
      ? structuredHandler.parse(boundedStdout.text, boundedStderr.text, exitCode)
      : null;
    const structuredSummary = parsedStructuredResult
      ?? (structuredStdout ? structuredPayloadSummary(structuredStdout) : undefined);

    const toolCalls = structuredStdout ? toolCallsFromRecord(structuredStdout) : undefined;

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
