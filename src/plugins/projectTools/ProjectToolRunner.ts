/**
 * ProjectToolRunner — deterministic execution pipeline for project tools.
 *
 * pi-experiment-amq0.16
 *
 * DESIGN
 * ------
 * This module owns the complete execution path for a single project-tool
 * invocation.  It has NO Pi ExtensionAPI / ExtensionContext import — all
 * coordination concerns (output allocation, event recording, command/MCP
 * dispatch, backpressure, clock, logger, schema validation, evidence
 * recording) are supplied as narrow ports or as already-injected sub-module
 * dependencies.
 *
 * The MCP executor receives the opaque Pi context token (`mcpCtx`) typed as
 * `unknown` so this module remains Pi-free.  The caller (ProjectToolRegistrar)
 * is the only module that knows the concrete ExtensionContext type.
 *
 * MOVE NOTE
 * ---------
 * The execution body was moved verbatim from the old executeConfiguredProjectTool
 * implementation in src/plugins/projectTools.ts.  The only change is:
 *   - `ctx: ExtensionContext` replaced by `mcpCtx: unknown` (Pi-free port)
 *   - the executeMcpTool call threads `mcpCtx as any` to preserve runtime behaviour
 *     (executeMcpTool does not use ctx internally, so `any` is safe)
 * The old location is deleted; this is the single canonical implementation.
 */

import { mkdir } from 'fs/promises';
import { EventStore } from '../../core/EventStore.js';
import { ToolCallPathFactory } from '../../core/ToolCallPathFactory.js';
import type { RuntimeEnvironment } from '../../core/RuntimeEnvironment.js';
import { DomainEventName, ProjectToolType, ToolResultStatus } from '../../constants/domain.js';
import { ProjectToolDefaults } from '../../constants/infra.js';
import type { ProjectCommandToolConfig, ProjectMcpToolConfig, ProjectToolConfig } from '../../core/domain/StateModels.js';
import type { ProjectToolBackpressure } from '../../core/RuntimeServices.js';
import { ToolResultRecorder } from '../../core/ToolResultRecorder.js';
import { v7 as uuidv7 } from 'uuid';

import { Logger, type LoggerPort } from '../../core/Logger.js';
import {
  classifyProjectToolFailure,
  isInfrastructureProjectToolFailure,
} from './failureCategory.js';
import {
  beadIdFromArgs,
  executionContext,
  projectToolRunEventData,
  releaseProjectToolCall,
} from './contextHelpers.js';
import {
  executeCommandTool,
} from './commandExecutor.js';
import {
  executeMcpTool,
} from './mcpExecutor.js';
import {
  persistAndBoundResult,
  attachFailureCategory,
  summarizeToolResult,
} from './resultEnvelope.js';
import {
  projectToolFailureLimitSuggestedOutcome,
  projectToolFailureLimit,
  buildProjectToolFailureLimitResult,
  attachProjectToolFailureLimit,
  routingHintSuggestedOutcome,
  preflightProjectTool,
} from './preflight.js';
import {
  extractCanonicalEvidence,
  buildCanonicalRejectionResult,
} from './canonicalEvidence.js';

// Re-export for barrel consumers
export { projectToolFailureLimitSuggestedOutcome };

// ---- Private helpers ----

function statusFromToolResult(result: unknown): ToolResultStatus | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const status = (result as { status?: unknown }).status;
  return typeof status === 'string' ? status as ToolResultStatus : undefined;
}

function reservationKeyFor(
  context: import('./types.js').ProjectToolExecutionContext,
  definition: ProjectToolConfig
): string {
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

// ---- executeConfiguredProjectTool (WI-12 flat form) ----
//
// NOTE: `mcpCtx` is typed `unknown` so this module has no Pi SDK import.
// The Pi ExtensionContext is provided by the caller (ProjectToolRegistrar /
// extension.ts) and threaded through to executeMcpTool which does not use
// it internally.

export async function executeConfiguredProjectTool(
  eventStore: EventStore,
  pathFactory: ToolCallPathFactory,
  definition: ProjectToolConfig,
  args: Record<string, unknown>,
  mcpCtx: unknown,
  env: RuntimeEnvironment | undefined,
  backpressure: ProjectToolBackpressure,
  injectedRoot: string = process.cwd(),
  signal?: AbortSignal,
  logger: LoggerPort = Logger
): Promise<unknown> {
  const beadId = beadIdFromArgs(args, env);
  const context = executionContext(pathFactory, definition, args, env, injectedRoot, process.env);
  const stateId = context.templateContext.stateId;
  const actionId = context.templateContext.actionId;

  // zog2.9: derive readOnlyContext from env. When WORKTREE_PATH equals PROJECT_ROOT
  // the teammate is running at the project root without an isolated worktree — this
  // is the "read-only / review" context (no worktree provisioned; Supervisor comment:
  // "read-only states such as Planning/Review"). Tools with allowedInReadOnlyContext:false
  // are rejected in this context.
  const worktreePath = context.templateContext.worktreePath;
  const projectRoot = context.templateContext.projectRoot;
  const isReadOnlyContext = Boolean(worktreePath && projectRoot && worktreePath === projectRoot);

  // WI-12: preflightProjectTool handles extension/backpressure/failure-limit.
  // Returns { tag: 'ready', result } (short-circuit) OR { tag: 'proceed', failureLimit }.
  const preflight = await preflightProjectTool(
    eventStore, definition, context, backpressure, beadId, stateId, actionId,
    { readOnlyContext: isReadOnlyContext },
    logger
  );

  if (preflight.tag === 'ready') {
    // Short-circuit: extension rejection or backpressure collision.
    // No reservation was successfully made, so no release needed.
    return preflight.result;
  }

  // preflight.tag === 'proceed': reservation is held; release MUST happen in finally.
  const { failureLimit } = preflight;

  // Failure-limit short-circuit (reservation is held; release in finally below)
  if (failureLimit.reached && failureLimit.result) {
    try {
      const result = attachFailureCategory(definition, failureLimit.result);
      // zog2.16: write durable artifact to context.outputFile so latestToolResultEvent
      // finds a readable outputFile (status=REJECTED, not absent).
      const failureLimitRecorder = new ToolResultRecorder(pathFactory, injectedRoot, logger);
      const failureLimitHandle = await failureLimitRecorder.recordShortCircuit({
        toolName: definition.name, invocationId: context.templateContext.toolInvocationId ?? uuidv7(),
        beadId, stateId, actionId,
        status: ToolResultStatus.REJECTED, failureCategory: 'INPUT',
        rejectionReason: `failure limit reached (${failureLimit.failureCount}/${failureLimit.maxFailures})`,
      }).catch(() => undefined);
      await eventStore.record(DomainEventName.PROJECT_TOOL_FAILED, {
        beadId,
        stateId,
        actionId,
        tool: definition.name,
        type: definition.type,
        status: ToolResultStatus.REJECTED,
        toolInvocationId: context.templateContext.toolInvocationId,
        ...(failureLimitHandle?.outputFile ? { outputFile: failureLimitHandle.outputFile } : {}),
        result: summarizeToolResult(result)
      }).catch(() => {});
      return result;
    } finally {
      releaseProjectToolCall(backpressure, reservationKeyFor(context, definition), context.templateContext.toolInvocationId);
    }
  }

  // Main execution path — reservation held; finally MUST release.
  try {
    await eventStore.record(
      DomainEventName.PROJECT_TOOL_STARTED,
      projectToolRunEventData(definition, context, beadId, stateId, actionId)
    );

    try {
      await mkdir(context.outputDir, { recursive: true });
      await mkdir(context.tmpDir, { recursive: true });

      const rawResult = definition.type === ProjectToolType.COMMAND
        ? await executeCommandTool(definition as ProjectCommandToolConfig, args, context, signal)
        : await executeMcpTool(definition as ProjectMcpToolConfig, args, mcpCtx as any, context, signal);

      // zog2.3 (producer-half): canonical evidence validation for command/tsProjectTool.
      // If the raw result carries an evidenceHandle in its stdout JSON (the opt-in signal),
      // validate it. Reject with a deterministic error for any canonical-path violation.
      // Non-canonical tools (no evidenceHandle) pass through unchanged — cerdiwen/legacy unaffected.
      //
      // 6q0y.11 (producer scope): when the handle is valid, capture semanticArtifactPath and
      // rawTransportArchivePaths so the domain event records both the semantic child artifact
      // path and the raw transport archive metadata (AC1, AC2, AC3). The raw transport archives
      // (stdoutFile/stderrFile) remain available as explicit raw archive fields and are NOT
      // promoted to semantic artifact status — the handle's semanticArtifactPath is the gate target.
      let canonicalSemanticArtifactPath: string | undefined;
      let canonicalRawTransportArchivePaths: string[] | undefined;
      let canonicalEvidenceHandle: import('../../core/ToolEvidenceHandle.js').ToolEvidenceHandle | undefined;

      if (definition.type === ProjectToolType.COMMAND) {
        const canonicalCheck = extractCanonicalEvidence(rawResult, projectRoot);
        if (canonicalCheck.kind === 'rejected') {
          // Tool declared canonical evidence but it failed validation. Short-circuit with REJECTED.
          const rejectionResult = buildCanonicalRejectionResult(
            definition.name,
            canonicalCheck.errors,
            canonicalCheck.rejectionReason
          );
          const rejectionPersisted = await persistAndBoundResult(definition, rejectionResult, context);
          await eventStore.record(DomainEventName.PROJECT_TOOL_FAILED, {
            beadId,
            stateId,
            actionId,
            tool: definition.name,
            type: definition.type,
            status: ToolResultStatus.REJECTED,
            toolInvocationId: context.templateContext.toolInvocationId,
            failureCategory: 'INPUT',
            outputFile: context.outputFile,
            result: summarizeToolResult(rejectionPersisted)
          }).catch(() => {});
          return rejectionPersisted;
        }
        // 6q0y.11 + yhec: capture the semantic artifact path, raw transport archive paths, and
        // the canonical handle so they can be threaded into the domain event (AC1, AC3, yhec).
        if (canonicalCheck.kind === 'valid') {
          canonicalSemanticArtifactPath = canonicalCheck.handle.semanticArtifactPath;
          canonicalRawTransportArchivePaths = canonicalCheck.handle.rawTransportArchivePaths;
          canonicalEvidenceHandle = canonicalCheck.handle;
        }
        // kind === 'non-canonical': legacy tool; continue unchanged (no capture).
      }

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
      const finalResult = status === ToolResultStatus.PASSED
        ? finalResultWithoutCategory
        : attachFailureCategory(definition, finalResultWithoutCategory);
      await eventStore.record(
        status === ToolResultStatus.PASSED ? DomainEventName.PROJECT_TOOL_SUCCEEDED : DomainEventName.PROJECT_TOOL_FAILED,
        {
          beadId,
          stateId,
          actionId,
          tool: definition.name,
          type: definition.type,
          status,
          toolInvocationId: context.templateContext.toolInvocationId,
          failureCategory: status === ToolResultStatus.PASSED ? undefined : classifyProjectToolFailure(definition, finalResult),
          // 0yt5.27: record the single PROJECT-scoped per-invocation output path so the
          // coordinator-only gate can resolve the latest event per (bead,state,action,tool)
          // => outputFile + status. The file lives under {PROJECT_ROOT}/.pi/tool-output/…
          // and persistAndBoundResult wrote the full result to it.
          outputFile: context.outputFile,
          // 6q0y.11: thread semantic artifact path and raw transport archive paths from the
          // canonical evidence handle into the domain event (AC3). Present only for canonical-path
          // tools (tsProjectTool / command tools that opt in via evidenceHandle). Legacy tools
          // (cerdiwen etc.) leave these undefined and are unaffected.
          ...(canonicalSemanticArtifactPath !== undefined
            ? { semanticArtifactPath: canonicalSemanticArtifactPath }
            : {}),
          ...(canonicalRawTransportArchivePaths !== undefined
            ? { rawTransportArchivePaths: canonicalRawTransportArchivePaths }
            : {}),
          // yhec: include the canonical ToolEvidenceHandle in the event so the gate
          // can validate it directly (instead of reading from the outputFile on disk).
          ...(canonicalEvidenceHandle !== undefined
            ? { evidenceHandle: canonicalEvidenceHandle }
            : {}),
          result: summarizeToolResult(finalResult)
        }
      );
      // yhec: attach the canonical evidenceHandle to the result so the extension layer
      // can thread it into the TOOL_INVOCATION_SUCCEEDED event (which is recorded later
      // and would otherwise lack the handle since it's coordinator-side only).
      const resultWithHandle = canonicalEvidenceHandle !== undefined
        ? { ...finalResult as object, _canonicalEvidenceHandle: canonicalEvidenceHandle }
        : finalResult;
      return resultWithHandle as typeof finalResult;
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
        status: ToolResultStatus.REJECTED,
        toolInvocationId: context.templateContext.toolInvocationId,
        failureCategory,
        // 0yt5.27: deterministic per-invocation path (partial output may or may not
        // be present when the run threw) so the gate's latest-event read is consistent.
        outputFile: context.outputFile,
        error: String(error)
      }).catch(() => {});
      throw error;
    }
  } finally {
    releaseProjectToolCall(backpressure, reservationKeyFor(context, definition), context.templateContext.toolInvocationId);
  }
}
