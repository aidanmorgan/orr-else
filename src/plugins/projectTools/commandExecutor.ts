/**
 * Command (shell/execa) executor for projectTools.
 * Package-internal — do not import from outside src/plugins/.
 */
import path from 'path';
import { execa } from 'execa';
import { open, readFile, stat } from 'fs/promises';
import { resolveTemplateString } from '../../core/TemplateResolver.js';
import type { ProjectCommandToolConfig } from '../../core/domain/StateModels.js';
import { CommandErrorCode, CommandExitCode, Defaults, ProjectToolDefaults, ProjectToolType, ToolResultStatus } from '../../constants/index.js';
import {
  COMMAND_STDERR_FILE_NAME,
  COMMAND_STDOUT_FILE_NAME,
  ProjectToolParameter,
  ProjectToolResultKey,
  StructuredPayloadCollectionKey,
  StructuredPayloadSummaryKey,
  StructuredPayloadSummaryOutputKey,
  StructuredPayloadIssueKey,
  StructuredPayloadToolResultKey,
  UNSUPPORTED_PROJECT_TOOL_OUTPUT_CONTROL_FLAGS,
  PROJECT_TOOL_CONTROL_PARAMETERS
} from './constants.js';
import { ProjectToolFailureCategory } from './failureCategory.js';
import type { CommandResultInput, ProjectToolExecutionContext } from './types.js';
import {
  isJsonRecord,
  parseJsonRecord,
  withoutUndefined
} from './utils.js';
import {
  normalizeCommandArgumentPaths,
  normalizeConfiguredCliFlag
} from './pathNormalization.js';
import { projectToolEnvironment } from './contextHelpers.js';
import { resolveStructuredInvocation } from './structuredInvocation.js';
import { COMMAND_TOOL_LOCK_DIR, SERIAL_TOOL_LOCK_REASON, SERIAL_MCP_LOCK_SCOPE } from './constants.js';
import { SerializedToolLockTimeoutError, withSerializedToolLock } from './serializedToolLock.js';

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

// commandReturnBytes / boundedCommandText / boundedCommandFile removed
// (0yt5.17). The harness performs NO truncation/capping of command output:
// raw stdout/stderr are persisted in full to stdoutFile/stderrFile; the
// model-facing result references those files + byte counts. Generic byte-cap
// of command return text is forbidden per docs/raw-output-contract.md.

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

// 0yt5.16/0yt5.17: harness-side scan-target recognition (the scan-target evidence
// extractors and their scanned-count / scanned-sample field plucking) has been
// REMOVED. The harness no longer recognizes scan-target evidence on a tool result.
// A tool that wants to surface zero-target-scan semantics does so in its own
// verify() callback.

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

  return Object.keys(summary).length > 0 ? summary : undefined;
}

// ---- Tool calls extraction ----

// Safety guard for in-process JSON parsing of tool-output files.  Only files
// that are reasonably-sized are loaded into memory for structured extraction.
// This is NOT a model-facing byte cap (see docs/raw-output-contract.md) — it
// is a memory-safety limit for the JSON.parse call below.  Raw files are always
// persisted to disk regardless of this limit; only structured extraction is skipped.
const JSON_EXTRACTION_MAX_BYTES = 256 * 1024; // 256 KiB

export async function jsonRecordFromFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  let size = 0;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return undefined;
  }
  if (size <= 0 || size > JSON_EXTRACTION_MAX_BYTES) return undefined;
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

// ---- command no-match annotations ----

function commandArgumentFlagName(argument: string): string | undefined {
  const trimmed = argument.trim();
  if (!trimmed.startsWith('-')) return undefined;
  const token = trimmed.split(/\s+/, 1)[0];
  return token.replace(/=.*$/, '');
}

function unsupportedProjectToolOutputControlFlag(_definition: ProjectCommandToolConfig, suppliedArgs: string[]): string | undefined {
  // Output-control flags are unsupported for ALL project command tools:
  // project-tool output is already bounded and archived by the harness, so a
  // model-supplied harness output-control flag has no effect and is rejected
  // generically (no per-tool name match).
  for (const argument of suppliedArgs) {
    const flag = commandArgumentFlagName(argument);
    if (flag && UNSUPPORTED_PROJECT_TOOL_OUTPUT_CONTROL_FLAGS.has(flag)) return flag;
  }
  return undefined;
}

export function unsupportedProjectToolOutputControlResult(
  definition: ProjectCommandToolConfig,
  flag: string
): Record<string, unknown> {
  return {
    tool: definition.name,
    status: ToolResultStatus.REJECTED,
    message: `Project tool ${definition.name} does not support output-control flag ${flag}. Project-tool output is already bounded and archived by the harness; do not pass harness output-control flags to project tools.`,
    unsupportedOutputControlFlag: flag,
    [ProjectToolResultKey.FAILURE_CATEGORY]: ProjectToolFailureCategory.TOOL_INPUT_ERROR,
    [ProjectToolResultKey.REMEDIATION]: [
      `Use structuredResult, compactSummary, diagnosticFacts, rejectedChecks, and the stdoutFile/stderrFile references from the ${definition.name} response instead of adding output-control flags.`,
      'Use supported harness retrieval patterns for archived output; stdoutFile/stderrFile are harness file references, not content to inline.',
      `Rerun ${definition.name} only with supported tool arguments or narrower inputs.`
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

function commandFailureStatus(error: any): ToolResultStatus {
  return error?.code === 'ENOENT' ? ToolResultStatus.UNAVAILABLE : ToolResultStatus.REJECTED;
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

// 0yt5.17: commandDiagnosticPreview / commandStreamDiagnosticSection /
// structuredCommandResultPreview REMOVED — these produced bounded/truncated
// model-facing preview text (the harness diagnostic summarizer). The harness no
// longer summarizes or truncates command output; raw stdout/stderr are persisted
// in full to stdoutFile/stderrFile.

// ---- buildCommandResult ----

// ---- buildCommandResult (s3wp.25 minimal schema) ----
//
// Model-facing fields:
//   tool, status, exitCode, timedOut, signal — command identity and outcome
//   stdoutFile, stderrFile                   — raw-output file references
//   stdoutBytes, stderrBytes                 — byte counts (size of raw files)
//   normalizedPathArguments                  — path normalization metadata
//   structuredResult, toolCalls              — tool-owned compact facts (semantic summarizers)
//   plus any annotation fields (matchStatus etc.)
//
// Intentionally omitted (s3wp.24/s3wp.25/s3wp.30 — forbidden generic output controls):
//   stdout, stderr           — raw text (use stdoutFile/stderrFile instead)
//   truncation flags (stdoutTruncated, stderrTruncated) — obsolete, removed s3wp.30
//   bounded text previews (resultPreview, diagnosticPreview, outputPreview) — obsolete, removed s3wp.30
//   maxBufferExceeded        — no longer relevant (streaming always used)
// Tool-owned compaction fields now use: compactSummary, diagnosticFacts (non-forbidden names)
// Maximum length of the stderrHint used for infrastructure/transient failure classification.
// Enough to capture common error lines like ENOSPC messages, not the full raw content.
const STDERR_HINT_MAX_CHARS = 512;

export function buildCommandResult(input: CommandResultInput): object {
  const {
    definition, status, exitCode, timedOut, cancelled, signal,
    stdoutFile, stderrFile, boundedStdout, boundedStderr,
    structuredStdout, structuredSummary, toolCalls, normalizedPathArguments
  } = input;
  // stderrHint: compact excerpt for infrastructure/transient failure classification.
  // Listed in MODEL_HIDDEN_RESULT_KEYS — the model never sees it; it is used only for
  // classifyProjectToolFailure / isInfrastructureProjectToolFailure.  The full stderr is
  // always available in stderrFile.
  const stderrHint = boundedStderr.text.length > 0
    ? boundedStderr.text.slice(0, STDERR_HINT_MAX_CHARS)
    : undefined;
  return {
    tool: definition.name,
    status,
    exitCode,
    ...(timedOut !== undefined ? { timedOut } : {}),
    ...(cancelled ? { cancelled } : {}),
    ...(signal !== undefined ? { signal } : {}),
    stdoutFile,
    stderrFile,
    stdoutBytes: boundedStdout.bytes,
    stderrBytes: boundedStderr.bytes,
    ...(stderrHint ? { stderrHint } : {}),
    // stdout/stderr: included as INTERNAL-ONLY fields for semantic summarizers
    // (diagnostic text extraction, high-volume compaction).  They are listed in
    // MODEL_HIDDEN_RESULT_KEYS so the model never sees them.  The full raw streams
    // are in stdoutFile / stderrFile; the in-process text sample here is bounded to
    // JSON_EXTRACTION_MAX_BYTES (256 KiB) for memory-safe extraction.
    ...(boundedStdout.text ? { [ProjectToolResultKey.STDOUT]: boundedStdout.text } : {}),
    ...(boundedStderr.text ? { [ProjectToolResultKey.STDERR]: boundedStderr.text } : {}),
    ...(normalizedPathArguments.length > 0 ? { normalizedPathArguments } : {}),
    ...(structuredSummary ? { [ProjectToolResultKey.STRUCTURED_RESULT]: structuredSummary } : {}),
    ...(toolCalls ? { [ProjectToolResultKey.TOOL_CALLS]: toolCalls } : {})
  };
}

// ---- executeCommandTool ----
//
// s3wp.25: raw stdout and stderr are persisted to stdoutFile / stderrFile on
// SUCCESS, FAILURE, and TIMEOUT.  The model-facing result references those
// files by path plus byte counts; no inline text is returned.

// ---- Serialized command/tsProjectTool lock ----
//
// Reuses the SAME generic cross-process lock as the MCP path
// (withSerializedToolLock / SerializedToolLockTimeoutError in serializedToolLock.ts).
// A command tool with serialize:true acquires a per-tool lock keyed on
// (projectRoot, tool name) before running and releases it after, so identical
// serialized command/tsProjectTool tools never overlap across teammates, while
// different tools (and non-serialized tools) run freely.

export class SerializedCommandToolLockTimeoutError extends Error {
  readonly lockMetadata: import('./types.js').SerializedCommandLockTimeoutMetadata;

  constructor(definition: ProjectCommandToolConfig, cause: SerializedToolLockTimeoutError) {
    super(cause.message);
    this.name = 'SerializedCommandToolLockTimeoutError';
    this.lockMetadata = {
      scope: SERIAL_MCP_LOCK_SCOPE,
      reason: SERIAL_TOOL_LOCK_REASON,
      waitedMs: cause.waitedMs,
      tool: definition.name,
      lockRef: cause.lockRef,
      lockFile: cause.lockFile
    };
  }
}

export function shouldSerializeCommandTool(
  definition: Pick<ProjectCommandToolConfig, 'type' | 'serialize'>
): boolean {
  return definition.type === ProjectToolType.COMMAND && definition.serialize === true;
}

export function serializedCommandLockTimeoutResult(
  definition: ProjectCommandToolConfig,
  error: SerializedCommandToolLockTimeoutError
): Record<string, unknown> {
  return {
    tool: definition.name,
    status: ToolResultStatus.REJECTED,
    [ProjectToolResultKey.FAILURE_CATEGORY]: ProjectToolFailureCategory.BACKPRESSURE,
    lockTimeout: true,
    lockMetadata: error.lockMetadata,
    message: `REJECTED: \`${definition.name}\` could not acquire the serialized project-tool lock after ${error.lockMetadata.waitedMs}ms. Another \`${definition.name}\` invocation is likely still in flight; wait for that result instead of starting parallel retries.`,
    [ProjectToolResultKey.RECOVERY]: [
      'Wait for the in-flight serialized project-tool result before retrying.',
      'After the in-flight result is visible, rerun this configured project tool once with narrower arguments only if more evidence is still required.'
    ]
  };
}

export async function executeCommandTool(definition: ProjectCommandToolConfig, args: any, context: ProjectToolExecutionContext, signal?: AbortSignal) {
  if (!shouldSerializeCommandTool(definition)) {
    return await executeCommandToolUnlocked(definition, args, context, signal);
  }
  const projectRoot = context.templateContext.projectRoot || process.cwd();
  // zog2.9: when the tool declares a sideEffectContract.serializationKey, use that
  // key (instead of the tool name) as the lock-bucket differentiator so that two
  // distinct tools sharing the same serializationKey genuinely serialize against
  // each other. Without this, only tools with the same NAME would collide.
  const serializationKey = (definition as { sideEffectContract?: { serializationKey?: string | null } })
    .sideEffectContract?.serializationKey;
  const lockBucket = (typeof serializationKey === 'string' && serializationKey.trim())
    ? serializationKey.trim()
    : definition.name;
  try {
    return await withSerializedToolLock(
      {
        lockDir: COMMAND_TOOL_LOCK_DIR,
        keyParts: [projectRoot, lockBucket],
        lockName: definition.name,
        logFields: {
          tool: definition.name,
          lockBucket,
          lockScope: SERIAL_MCP_LOCK_SCOPE,
          lockReason: SERIAL_TOOL_LOCK_REASON
        }
      },
      `Timed out acquiring serialized project-tool lock for ${definition.name}`,
      async () => executeCommandToolUnlocked(definition, args, context, signal)
    );
  } catch (error) {
    if (error instanceof SerializedToolLockTimeoutError) {
      return serializedCommandLockTimeoutResult(definition, new SerializedCommandToolLockTimeoutError(definition, error));
    }
    throw error;
  }
}

async function executeCommandToolUnlocked(definition: ProjectCommandToolConfig, args: any, context: ProjectToolExecutionContext, signal?: AbortSignal) {
  const templateContext = context.templateContext;
  const command = resolveTemplateString(definition.command, templateContext);
  const finalArgs = (definition.defaultArgs || []).map(arg => resolveTemplateString(arg, templateContext));
  const stdoutFile = path.join(context.outputDir, COMMAND_STDOUT_FILE_NAME);
  const stderrFile = path.join(context.outputDir, COMMAND_STDERR_FILE_NAME);
  const suppliedArgs = normalizeCommandArguments(args?.[ProjectToolParameter.ARGUMENTS])
    .map(arg => resolveTemplateString(arg, templateContext));
  const unsupportedOutputControlFlag = unsupportedProjectToolOutputControlFlag(definition, suppliedArgs);
  if (unsupportedOutputControlFlag) {
    return unsupportedProjectToolOutputControlResult(definition, unsupportedOutputControlFlag);
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

  // Helper: read the byte count and a small text sample from a persisted output
  // file.  The text sample is used only for in-process semantic extraction (command
  // no-match annotations, structuredPayloadSummary).  It is NOT included in the model-facing
  // result.  Reading the complete file here is acceptable because jsonRecordFromFile
  // already caps at JSON_EXTRACTION_MAX_BYTES and the diagnostic pattern matching is
  // bounded by the file itself.  For very large files the sample is truncated purely
  // for the in-process extraction step; the raw file on disk remains complete.
  async function fileInfo(filePath: string): Promise<{ bytes: number; text: string }> {
    let size = 0;
    try { size = (await stat(filePath)).size; } catch { /* file may not exist yet */ }
    if (size === 0) return { bytes: 0, text: '' };
    // Read up to JSON_EXTRACTION_MAX_BYTES for structured parsing/annotation.
    const handle = await open(filePath, 'r');
    try {
      const readSize = Math.min(size, JSON_EXTRACTION_MAX_BYTES);
      const buffer = Buffer.alloc(readSize);
      const { bytesRead } = await handle.read(buffer, 0, readSize, 0);
      return { bytes: size, text: buffer.subarray(0, bytesRead).toString('utf8') };
    } finally {
      await handle.close();
    }
  }

  // zog2.9: propagate the Pi AbortSignal to execa only for tools that declare
  // cancellationPolicy: 'supported' in their sideEffectContract.  Tools that
  // declare 'not_supported' run to completion regardless of the signal.
  const cancellationPolicy = (definition as { sideEffectContract?: { cancellationPolicy?: string } })
    .sideEffectContract?.cancellationPolicy;
  const cancelSignal = cancellationPolicy === 'supported' && signal ? signal : undefined;

  try {
    const result = await execa(command, spawnArgs, {
      cwd: context.cwd,
      env: { ...context.hostEnv, ...env, ...projectToolEnvironment(context) },
      // s3wp.25: stream stdout/stderr directly to files — raw output is always
      // persisted regardless of exit code, signal, or timeout.
      stdout: { file: stdoutFile },
      stderr: { file: stderrFile },
      reject: false,
      timeout: definition.timeoutMs || Defaults.PROCESS_REAP_INTERVAL_MS,
      ...(cancelSignal ? { cancelSignal } : {})
    });
    const stdoutInfo = await fileInfo(stdoutFile);
    const stderrInfo = await fileInfo(stderrFile);
    const structuredStdout = await jsonRecordFromFile(stdoutFile);
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : undefined;
    const isCanceled = (result as { isCanceled?: boolean }).isCanceled === true;

    // If a structured handler is active, parse the process output into a compact
    // structuredResult.  If parse() returns null (malformed/empty JSON), fall back
    // to the existing structuredPayloadSummary path — no regression.
    const parsedStructuredResult = structuredHandler
      ? structuredHandler.parse(stdoutInfo.text, stderrInfo.text, exitCode)
      : null;
    const structuredSummary = parsedStructuredResult
      ?? (structuredStdout ? structuredPayloadSummary(structuredStdout) : undefined);

    const toolCalls = structuredStdout ? toolCallsFromRecord(structuredStdout) : undefined;
    const acceptedExitCode = isSuccessfulCommandExitCode(definition, exitCode);
    const acceptedNonZeroExitCode = exitCode !== CommandExitCode.SUCCESS
      && acceptedExitCode
      && stderrInfo.text.trim().length === 0;
    const passed = !result.timedOut && !isCanceled && (exitCode === CommandExitCode.SUCCESS || acceptedNonZeroExitCode);

    return buildCommandResult({
      definition,
      status: passed ? ToolResultStatus.PASSED : ToolResultStatus.REJECTED,
      exitCode,
      maxBufferExceeded: false,
      timedOut: result.timedOut,
      cancelled: isCanceled || undefined,
      signal: result.signal,
      stdoutFile,
      stderrFile,
      boundedStdout: { text: stdoutInfo.text, bytes: stdoutInfo.bytes, truncated: false },
      boundedStderr: { text: stderrInfo.text, bytes: stderrInfo.bytes, truncated: false },
      structuredStdout,
      structuredSummary,
      toolCalls,
      normalizedPathArguments: scopedArgs.normalizedPathArguments
    });
  } catch (error: any) {
    // System-level error (e.g. ENOENT — command not found).  The output files may
    // not exist or may be partially written.  Read whatever is available.
    const stdoutInfo = await fileInfo(stdoutFile);
    const stderrInfo = await fileInfo(stderrFile);
    // Fall back to error properties if files are empty (command never started)
    const stderrText = stderrInfo.text || (typeof error.stderr === 'string' ? error.stderr : '');
    const acceptedExitCode = isSuccessfulCommandExitCode(definition, error.code) && stderrText.trim().length === 0;
    const acceptedMaxBuffer = isAcceptedMaxBufferFailure(definition, error);
    const status = acceptedExitCode || acceptedMaxBuffer
      ? ToolResultStatus.PASSED
      : commandFailureStatus(error);

    // For annotation/extraction purposes, use what we have from the files; fall
    // back to error.stdout/stderr only if the files are empty.
    const annotationStdout = stdoutInfo.text || (typeof error.stdout === 'string' ? error.stdout : '');
    const annotationStderr = stderrText;

    const structuredStdout = await jsonRecordFromFile(stdoutFile);
    const exitCode = typeof error.code === 'number' ? error.code : undefined;

    // Same fallback logic as in the success path: structured parse takes precedence,
    // null parse falls through to the existing structuredPayloadSummary.
    const parsedStructuredResult = structuredHandler
      ? structuredHandler.parse(annotationStdout, annotationStderr, exitCode)
      : null;
    const structuredSummary = parsedStructuredResult
      ?? (structuredStdout ? structuredPayloadSummary(structuredStdout) : undefined);

    const toolCalls = structuredStdout ? toolCallsFromRecord(structuredStdout) : undefined;

    return buildCommandResult({
      definition,
      status,
      exitCode,
      maxBufferExceeded: false,
      stdoutFile,
      stderrFile,
      boundedStdout: { text: annotationStdout, bytes: stdoutInfo.bytes, truncated: false },
      boundedStderr: { text: annotationStderr, bytes: stderrInfo.bytes, truncated: false },
      structuredStdout,
      structuredSummary,
      toolCalls,
      normalizedPathArguments: scopedArgs.normalizedPathArguments
    });
  }
}
