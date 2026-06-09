/**
 * projectTools — barrel/facade module.
 *
 * pi-experiment-amq0.16: split execution from registration.
 *
 * After amq0.16 the two main concerns live in dedicated modules:
 *   - Execution pipeline: src/plugins/projectTools/ProjectToolRunner.ts
 *   - Pi registration:    src/plugins/projectTools/ProjectToolRegistrar.ts
 *
 * This barrel re-exports the public surface so all existing callers
 * (extension.ts, tests) continue to import from './plugins/projectTools.js'
 * without change.  The old function bodies have been DELETED from this file;
 * they live exclusively in the two new modules above.
 *
 * Sub-module responsibilities (unchanged):
 *   - COMMAND executor:   src/plugins/projectTools/commandExecutor.ts
 *   - MCP executor:       src/plugins/projectTools/mcpExecutor.ts
 *   - Result envelope:    src/plugins/projectTools/resultEnvelope.ts
 *   - Preflight/backpressure/failure-limit: src/plugins/projectTools/preflight.ts
 *   - Path normalization: src/plugins/projectTools/pathNormalization.ts
 *   - Context helpers:    src/plugins/projectTools/contextHelpers.ts
 *   - Failure category:   src/plugins/projectTools/failureCategory.ts
 */
import type { ResolvedHarnessConfig } from '../core/ConfigLoader.js';
import { ProjectToolType } from '../constants/index.js';
import type { ProjectCommandToolConfig, ProjectMcpToolConfig, ProjectToolConfig, SDLCState, TeammateAction } from '../core/domain/StateModels.js';
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

// ---- Execution pipeline (Pi-free runner) ----
export { executeConfiguredProjectTool } from './projectTools/ProjectToolRunner.js';

// ---- Registration adapter (Pi-aware registrar) ----
export { registerConfiguredProjectTools } from './projectTools/ProjectToolRegistrar.js';
export type { ProjectToolRuntimeContext } from './projectTools/ProjectToolRegistrar.js';

// ---- Config helpers ----

export function getConfiguredProjectToolNames(config: ResolvedHarnessConfig): string[] {
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
  config: ResolvedHarnessConfig,
  state?: Pick<SDLCState, 'toolPromptProfile'>,
  action?: Pick<TeammateAction, 'toolPromptProfile'>
): string | undefined {
  return action?.toolPromptProfile ?? state?.toolPromptProfile ?? config.settings?.toolPromptProfile;
}

export function describeConfiguredProjectTools(
  config: ResolvedHarnessConfig,
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
