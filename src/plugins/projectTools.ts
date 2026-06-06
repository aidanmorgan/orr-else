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
import type { ProjectCommandToolConfig, ProjectMcpToolConfig, ProjectToolConfig, RequiredTool } from '../core/domain/StateModels.js';
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
  executeCommandTool,
  extractSequencedToolCalls,
  toolCallsFromOutputFile
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

// ---- Re-export public surface ----

export type { ProjectToolBackpressure } from '../core/RuntimeServices.js';
export { ProjectToolFailureCategory } from './projectTools/failureCategory.js';
export { classifyProjectToolFailure } from './projectTools/failureCategory.js';
export { isInfrastructureProjectToolFailure } from './projectTools/failureCategory.js';
export { resolveContextField } from './projectTools/contextHelpers.js';
export { normalizeCommandArguments } from './projectTools/commandExecutor.js';
export { normalizeMcpPathArguments } from './projectTools/pathNormalization.js';
export { shouldSerializeMcpTool, mcpToolRequestTimeoutMs } from './projectTools/mcpExecutor.js';
export { projectToolFailureLimitSuggestedOutcome } from './projectTools/preflight.js';
export { isSuccessfulCommandExitCode, isAcceptedMaxBufferFailure, shouldSerializeCommandTool, toolCallsFromOutputFile, extractSequencedToolCalls } from './projectTools/commandExecutor.js';
export type { ToolCallSource } from './projectTools/commandExecutor.js';

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
  injectedRoot: string = process.cwd()
): Promise<unknown> {
  // Deprecation guard: intercept before any execution when tool is marked deprecated.
  const defAny = definition as { deprecated?: boolean; replacedBy?: string[]; deprecationReason?: string };
  if (defAny.deprecated) {
    const beadIdForEvent = beadIdFromArgs(args, env);
    const stateIdForEvent = typeof args.stateId === 'string' ? args.stateId : undefined;
    const actionIdForEvent = typeof args.actionId === 'string' ? args.actionId : undefined;
    const replacements = defAny.replacedBy;
    const reason = defAny.deprecationReason;
    const replacementHint = replacements?.length
      ? ` Use ${replacements.map(r => `\`${r}\``).join(' or ')} instead.`
      : '';
    const reasonHint = reason ? ` Reason: ${reason}` : '';
    const message = `REJECTED: \`${definition.name}\` is deprecated and cannot be invoked.${replacementHint}${reasonHint}`;
    await eventStore.record(DomainEventName.TOOL_DEPRECATED_REJECTED, {
      tool: definition.name,
      ...(beadIdForEvent !== undefined ? { beadId: beadIdForEvent } : {}),
      ...(stateIdForEvent !== undefined ? { stateId: stateIdForEvent } : {}),
      ...(actionIdForEvent !== undefined ? { actionId: actionIdForEvent } : {}),
      ...(replacements !== undefined ? { replacedBy: replacements } : {}),
      ...(reason !== undefined ? { reason } : {})
    }).catch(() => {});
    // zog2.16: also emit PROJECT_TOOL_FAILED with a durable outputFile so
    // latestToolResultEvent can match this invocation as TOOL_REJECTED (not TOOL_NOT_INVOKED).
    const deprecatedInvocationId = uuidv7();
    const deprecatedRecorder = new ToolResultRecorder(pathFactory, injectedRoot);
    const deprecatedHandle = await deprecatedRecorder.recordShortCircuit({
      toolName: definition.name, invocationId: deprecatedInvocationId,
      beadId: beadIdForEvent, stateId: stateIdForEvent, actionId: actionIdForEvent,
      status: ToolResultStatus.REJECTED, failureCategory: 'INPUT',
      rejectionReason: message,
    }).catch(() => undefined);
    if (deprecatedHandle && deprecatedHandle.outputFile) {
      await eventStore.record(DomainEventName.PROJECT_TOOL_FAILED, {
        beadId: beadIdForEvent,
        stateId: stateIdForEvent,
        actionId: actionIdForEvent,
        tool: definition.name,
        type: definition.type,
        status: ToolResultStatus.REJECTED,
        toolInvocationId: deprecatedInvocationId,
        outputFile: deprecatedHandle.outputFile,
        result: summarizeToolResult({ status: ToolResultStatus.REJECTED, message }),
      }).catch(() => {});
    }
    return { status: ToolResultStatus.REJECTED, message };
  }

  const beadId = beadIdFromArgs(args, env);
  const context = executionContext(pathFactory, definition, args, env, injectedRoot, process.env);
  const stateId = context.templateContext.stateId;
  const actionId = context.templateContext.actionId;

  // WI-12: preflightProjectTool handles extension/backpressure/failure-limit.
  // Returns { tag: 'ready', result } (short-circuit) OR { tag: 'proceed', failureLimit }.
  const preflight = await preflightProjectTool(
    eventStore, definition, context, backpressure, beadId, stateId, actionId
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
          result: summarizeToolResult(finalResult)
        }
      );
      // Attach the persisted outputFile path as an internal-only field so the
      // sequencing path (runParentSequenceActionsBeforeActive) can use it as a
      // fallback source for framework toolCalls without changing the public
      // function signature.  The field is already in MODEL_HIDDEN_RESULT_KEYS so
      // it never reaches the model when the result is passed through
      // modelFacingInlineResult in other contexts.
      return isJsonRecord(finalResult)
        ? { ...(finalResult as Record<string, unknown>), _internalOutputFile: context.outputFile }
        : finalResult;
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
 * Returns the set of tool names that are explicitly allowed despite being deprecated/hidden,
 * based on the current state's and action's requiredTools entries that carry allowDeprecated:true.
 * Reuses the same string-form / object-form parsing as validateDeprecatedRequiredTools.
 */
export function allowedDeprecatedToolNames(
  stateRequiredTools: RequiredTool[] | undefined,
  actionRequiredTools: RequiredTool[] | undefined
): Set<string> {
  const allowed = new Set<string>();
  for (const rt of [...(stateRequiredTools || []), ...(actionRequiredTools || [])]) {
    if (typeof rt !== 'string' && rt.allowDeprecated) {
      allowed.add(rt.name);
    }
  }
  return allowed;
}

export function describeConfiguredProjectTools(
  config: HarnessConfig,
  allowedDeprecated: Set<string> = new Set()
): string {
  const tools = (config.tools || []).filter(tool => {
    const t = tool as { hidden?: boolean; deprecated?: boolean };
    if (!t.hidden && !t.deprecated) return true;
    return allowedDeprecated.has(tool.name);
  });
  if (tools.length === 0) return '';

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
  wrapper: (tool: { name: string; description: string; parameters: unknown; execute(params: unknown, ctx?: unknown): unknown | Promise<unknown> }) => Parameters<ExtensionAPI['registerTool']>[0],
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
      execute: async (params: unknown, ctx: ExtensionContext) => {
        const hiddenContext = runtimeContext?.() || {};
        const configuredFrameworkRoot = frameworkRootFromConfig(config, env, injectedRoot);
        const configuredNamedRoots = namedRootsFromConfig(config, env, injectedRoot);
        const paramsRecord = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
        const result = await executeConfiguredProjectTool(eventStore, pathFactory, definition, {
          ...paramsRecord,
          ...hiddenContext,
          ...(configuredFrameworkRoot ? { frameworkRoot: configuredFrameworkRoot } : {}),
          ...(configuredNamedRoots ? { namedRoots: configuredNamedRoots } : {})
        }, ctx, env, backpressure, injectedRoot);
        // Strip _internalOutputFile at the model boundary: this field is an
        // internal sequencing channel used only by runParentSequenceActionsBeforeActive
        // (which calls executeConfiguredProjectTool directly). The registered tool
        // handler must NEVER expose it to the model via toolResult().
        if (isJsonRecord(result) && '_internalOutputFile' in (result as Record<string, unknown>)) {
          const { _internalOutputFile: _, ...modelFacing } = result as Record<string, unknown>;
          return modelFacing;
        }
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
