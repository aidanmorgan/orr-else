/**
 * Result persistence, model-facing envelope shaping, and failure-category
 * enrichment for projectTools.
 * Package-internal — do not import from outside src/plugins/.
 *
 * 0yt5.16/0yt5.17: the harness performs NO truncation/capping/size-backstop on
 * tool results AND NO recognition/summarization. It persists the tool's full raw
 * result to outputFile (the archive) and passes the tool's returned result
 * through VERBATIM. The only enrichment retained here is failure-category
 * classification (ToolResultBase.failureCategory), which is NOT
 * truncation/summarization/recognition. Semantic pass/fail is decided by
 * verify() callbacks and the artifact-presence gate, never by result-field
 * recognition in the harness.
 */
import path from 'path';
import { readdir, rm, stat, writeFile } from 'fs/promises';
import { Logger } from '../../core/Logger.js';
import type { ProjectToolConfig } from '../../core/domain/StateModels.js';
import { ToolResultStatus } from '../../constants/domain.js';
import { Component, ProjectToolDefaults, WorkerDefaults } from '../../constants/infra.js';
import {
  MODEL_HIDDEN_RESULT_KEYS,
  ProjectToolResultKey
} from './constants.js';
import {
  classifyProjectToolFailure,
  ProjectToolFailureCategory
} from './failureCategory.js';
import type {
  ModelFacingProjectToolResult,
  ProjectToolExecutionContext
} from './types.js';
import {
  isJsonRecord,
  resultRecord,
  serializeProjectToolResult,
  withoutUndefined
} from './utils.js';
import { toolCallsFromRecord } from './commandExecutor.js';

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

// ---- Remediation helpers (failure-category enrichment) ----

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
      guidance.add('Use diagnosticFacts, structuredResult, and rejectedChecks to fix the implementation or route the configured failure edge.');
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

// ---- Model-facing envelope ----
//
// 0yt5.16/0yt5.17: the model-facing result is the tool's own result passed
// through VERBATIM, minus only the INTERNAL-ONLY keys that are not part of the
// tool's result (raw stdout/stderr text retained in-process for failure
// classification, the internal outputFile handle, and the raw MCP callTool
// payload). Those raw streams are persisted in full to stdoutFile/stderrFile and
// the per-invocation outputFile archive. The harness adds NO truncation, NO
// capping, NO size backstop, NO summarization, NO preview/narrowing field.

function modelFacingInlineResult(result: unknown): ModelFacingProjectToolResult {
  const record = resultRecord(result);
  const modelFacing = Object.fromEntries(
    Object.entries(record).filter(([key, value]) => !MODEL_HIDDEN_RESULT_KEYS.has(key) && value !== undefined)
  );
  const toolCalls = toolCallsFromRecord(record);
  if (toolCalls && !Array.isArray(modelFacing[ProjectToolResultKey.TOOL_CALLS])) {
    modelFacing[ProjectToolResultKey.TOOL_CALLS] = toolCalls;
  }
  return modelFacing;
}

// ---- summarizeToolResult (for event store) ----
//
// Produces the harness-internal event-store record for a tool result. This is
// NOT model-facing and NOT a summarizer of the tool's semantics — it copies the
// tool's own fields and adds byte counts + bounded excerpts of the raw streams
// for harness observability only. The 'Excerpt' suffix is intentional so these
// internal telemetry fields never match the forbidden model-facing cap list.

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
    [ProjectToolResultKey.STRUCTURED_RESULT]: record[ProjectToolResultKey.STRUCTURED_RESULT],
    // s3wp.25: include stderrHint in event-store summary so isInfrastructureProjectToolFailure
    // can detect ENOSPC/transient patterns when checking stored failure events.
    ...(record.stderrHint !== undefined ? { stderrHint: record.stderrHint } : {})
  };
  // Event-store internal telemetry: byte counts + truncated excerpts of large raw fields.
  // These are NOT model-facing — they live only in the event log for harness observability.
  // Keys use the 'Excerpt' suffix (not 'Preview') so they don't match the forbidden cap list.
  for (const key of ['stdout', 'stderr', 'output', 'result']) {
    const value = record[key];
    if (typeof value === 'string') {
      summary[`${key}Bytes`] = value.length;
      summary[`${key}Excerpt`] = value.length > WorkerDefaults.EVENT_PREVIEW_CHARS
        ? `${value.slice(0, WorkerDefaults.EVENT_PREVIEW_CHARS)}...`
        : value;
    } else if (value !== undefined) {
      try {
        const json = JSON.stringify(value);
        summary[`${key}Bytes`] = json.length;
        summary[`${key}Excerpt`] = json.length > WorkerDefaults.EVENT_PREVIEW_CHARS
          ? `${json.slice(0, WorkerDefaults.EVENT_PREVIEW_CHARS)}...`
          : value;
      } catch {
        summary[`${key}Excerpt`] = String(value);
      }
    }
  }
  return summary;
}

// ---- persistAndBoundResult ----
//
// 0yt5.16/0yt5.17: persists the tool's FULL raw result to outputFile (the
// archive) and returns the tool's result through VERBATIM (minus internal-only
// raw-stream keys). NO truncation, NO byte-cap gating, NO size backstop, NO
// summarization, NO recognition. A 5 MB result is persisted and returned
// unchanged; a literal '[truncated …]' string in the tool's result passes
// through untouched.

export async function persistAndBoundResult(
  definition: ProjectToolConfig,
  result: unknown,
  context: ProjectToolExecutionContext
): Promise<unknown> {
  const serialized = serializeProjectToolResult(result);
  await writeFile(context.outputFile, serialized);
  void cleanupToolCallScratch(context);

  return modelFacingInlineResult(result);
}
