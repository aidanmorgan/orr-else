/**
 * projectTools — facade module.
 *
 * This module re-exports everything that external callers (extension.ts, tests) import,
 * and wires the decomposed modules into the public execute/register API.
 *
 * Responsibilities (each delegated to a sub-module):
 *   - COMMAND executor:   src/plugins/projectTools/commandExecutor.ts
 *   - MCP executor:       src/plugins/projectTools/mcpExecutor.ts
 *   - Result envelope:    src/plugins/projectTools/resultEnvelope.ts
 *   - Preflight/backpressure/failure-limit: src/plugins/projectTools/preflight.ts
 *   - Path normalization: src/plugins/projectTools/pathNormalization.ts
 *   - Context helpers:    src/plugins/projectTools/contextHelpers.ts
 *   - Failure category:   src/plugins/projectTools/failureCategory.ts
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { mkdir } from 'fs/promises';
import type { RuntimeEnvironment } from '../core/RuntimeEnvironment.js';
import { EventStore } from '../core/EventStore.js';
import { ToolCallPathFactory } from '../core/ToolCallPathFactory.js';
import type { HarnessConfig } from '../core/ConfigLoader.js';
import { DomainEventName, ProjectToolDefaults, ProjectToolType, ToolResultStatus } from '../constants/index.js';
import type { ProjectCommandToolConfig, ProjectMcpToolConfig, ProjectToolConfig, SDLCState, TeammateAction } from '../core/domain/StateModels.js';
import type { ProjectToolBackpressure } from '../core/RuntimeServices.js';
import { ToolResultRecorder } from '../core/ToolResultRecorder.js';
import { v7 as uuidv7 } from 'uuid';

// ---- Sub-module imports ----
import {
  classifyProjectToolFailure,
  isInfrastructureProjectToolFailure,
  ProjectToolFailureCategory
} from './projectTools/failureCategory.js';
import {
  resolveContextField,
  beadIdFromArgs,
  executionContext,
  frameworkRootFromConfig,
  namedRootsFromConfig,
  projectToolRunEventData,
  releaseProjectToolCall
} from './projectTools/contextHelpers.js';
import {
  normalizeCommandArguments,
  isSuccessfulCommandExitCode,
  isAcceptedMaxBufferFailure,
  executeCommandTool
} from './projectTools/commandExecutor.js';
import {
  shouldSerializeMcpTool,
  mcpToolRequestTimeoutMs,
  executeMcpTool
} from './projectTools/mcpExecutor.js';
import {
  persistAndBoundResult,
  attachFailureCategory,
  summarizeToolResult
} from './projectTools/resultEnvelope.js';
import {
  projectToolFailureLimitSuggestedOutcome,
  projectToolFailureLimit,
  buildProjectToolFailureLimitResult,
  attachProjectToolFailureLimit,
  routingHintSuggestedOutcome,
  preflightProjectTool
} from './projectTools/preflight.js';
import {
  normalizeConfiguredCliFlag,
  pathArgumentRootKind,
  normalizeMcpPathArguments as normalizeMcpPathArgumentsInternal
} from './projectTools/pathNormalization.js';
import {
  ProjectToolResultKey,
  PROJECT_TOOL_DESCRIPTION_SUFFIX,
  PROJECT_TOOL_MODEL_CONTRACT,
  ProjectToolParameter
} from './projectTools/constants.js';
import { isJsonRecord } from './projectTools/utils.js';
import {
  extractCanonicalEvidence,
  buildCanonicalRejectionResult
} from './projectTools/canonicalEvidence.js';

// ---- Re-export public surface ----

export type { ProjectToolBackpressure } from '../core/RuntimeServices.js';
export { ProjectToolFailureCategory } from './projectTools/failureCategory.js';
export { classifyProjectToolFailure } from './projectTools/failureCategory.js';
export { isInfrastructureProjectToolFailure } from './projectTools/failureCategory.js';
export { resolveContextField } from './projectTools/contextHelpers.js';
export { normalizeCommandArguments } from './projectTools/commandExecutor.js';
export { normalizeMcpPathArguments } from './projectTools/pathNormalization.js';
export { shouldSerializeMcpTool, mcpToolRequestTimeoutMs } from './projectTools/mcpExecutor.js';
export { projectToolFailureLimitSuggestedOutcome, checkSideEffectContractGates } from './projectTools/preflight.js';
export { isSuccessfulCommandExitCode, isAcceptedMaxBufferFailure, shouldSerializeCommandTool } from './projectTools/commandExecutor.js';
export { stripLeadingAt } from './projectTools/pathNormalization.js';

// ---- ProjectToolRuntimeContext ----

export interface ProjectToolRuntimeContext {
  beadId?: string;
  stateId?: string;
  actionId?: string;
}

// ---- executeConfiguredProjectTool (WI-12 flat form) ----

export async function executeConfiguredProjectTool(
  eventStore: EventStore,
  pathFactory: ToolCallPathFactory,
  definition: ProjectToolConfig,
  args: Record<string, unknown>,
  ctx: ExtensionContext,
  env: RuntimeEnvironment | undefined,
  backpressure: ProjectToolBackpressure,
  injectedRoot: string = process.cwd(),
  signal?: AbortSignal
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
    { readOnlyContext: isReadOnlyContext }
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
      const failureLimitRecorder = new ToolResultRecorder(pathFactory, injectedRoot);
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
        : await executeMcpTool(definition as ProjectMcpToolConfig, args, ctx, context, signal);

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
      let canonicalEvidenceHandle: import('../core/ToolEvidenceHandle.js').ToolEvidenceHandle | undefined;

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

// ---- Config helpers ----

export function getConfiguredProjectToolNames(config: HarnessConfig): string[] {
  return (config.tools || []).map(tool => tool.name);
}

// ---- describeConfiguredProjectTools ----

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

/**
 * Resolves the effective tool prompt profile ID for a given state/action pair.
 *
 * Precedence (highest → lowest):
 *   action.toolPromptProfile → state.toolPromptProfile → settings.toolPromptProfile → undefined
 *
 * Returns undefined when no profile is selected at any scope (= default: use tool.description).
 * Pure helper — no side effects; unit-testable and reusable.
 */
export function resolveToolPromptProfileId(
  config: HarnessConfig,
  state?: Pick<SDLCState, 'toolPromptProfile'>,
  action?: Pick<TeammateAction, 'toolPromptProfile'>
): string | undefined {
  return action?.toolPromptProfile ?? state?.toolPromptProfile ?? config.settings?.toolPromptProfile;
}

export function describeConfiguredProjectTools(
  config: HarnessConfig,
  profileId?: string,
  activeToolNames?: ReadonlySet<string>
): string {
  const tools = config.tools || [];
  if (tools.length === 0) return '';

  // Build a lookup map from tool name → profile text override when a profile is selected.
  // Precedence: profileId → no override (use tool.description).
  const profileOverrides = new Map<string, string>();
  if (profileId) {
    const profileEntries = config.settings.toolPromptProfiles?.[profileId] ?? [];
    for (const entry of profileEntries) {
      profileOverrides.set(entry.tool, entry.text);
    }
  }

  // Sort by name so prompt text is canonical regardless of YAML declaration order.
  // When activeToolNames is provided, omit inactive tools — reducing token spend for
  // narrow states while keeping canonical alphabetical ordering (6q0y.2).
  const allSorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const sortedTools = activeToolNames !== undefined
    ? allSorted.filter(t => activeToolNames.has(t.name))
    : allSorted;

  if (sortedTools.length === 0) return '';

  const descriptions = sortedTools.map(tool => {
    // Profile text overrides tool.description; all other summary fields are preserved
    // (transport, mcpDetails, commandDetails, usageNotes are structural — not overridden).
    const effectiveDescription = profileOverrides.has(tool.name)
      ? profileOverrides.get(tool.name)!
      : (tool.description || 'No description provided.');
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
    return `- \`${tool.name}\`: ${effectiveDescription}${transport}${mcpDetails}${commandDetails}${usageNotesSummary(tool)}`;
  }).join('\n');

  return `\n### PROJECT-SPECIFIC TOOLS\nThe following project-specific tools are available to you:\n\n${PROJECT_TOOL_MODEL_CONTRACT.map(note => `- ${note}`).join('\n')}\n\n${descriptions}\n`;
}

// ---- registerConfiguredProjectTools ----

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
  wrapper: (tool: { name: string; description: string; parameters: unknown; execute(params: unknown, ctx?: unknown, signal?: AbortSignal): unknown | Promise<unknown> }) => Parameters<ExtensionAPI['registerTool']>[0],
  runtimeContext: (() => ProjectToolRuntimeContext | undefined) | undefined,
  env: RuntimeEnvironment | undefined,
  backpressure: ProjectToolBackpressure,
  injectedRoot: string = process.cwd()
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
      execute: async (params: unknown, ctx: ExtensionContext, signal?: AbortSignal) => {
        const hiddenContext = runtimeContext?.() || {};
        const configuredFrameworkRoot = frameworkRootFromConfig(config, env, injectedRoot);
        const configuredNamedRoots = namedRootsFromConfig(config, env, injectedRoot);
        const paramsRecord = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
        const result = await executeConfiguredProjectTool(eventStore, pathFactory, definition, {
          ...paramsRecord,
          ...hiddenContext,
          ...(configuredFrameworkRoot ? { frameworkRoot: configuredFrameworkRoot } : {}),
          ...(configuredNamedRoots ? { namedRoots: configuredNamedRoots } : {})
        }, ctx, env, backpressure, injectedRoot, signal);
        return result;
      }
    }));
  }
}

// ---- Private helpers ----

function statusFromToolResult(result: unknown): ToolResultStatus | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const status = (result as { status?: unknown }).status;
  return typeof status === 'string' ? status as ToolResultStatus : undefined;
}

function reservationKeyFor(
  context: import('./projectTools/types.js').ProjectToolExecutionContext,
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
