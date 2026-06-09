/**
 * ProjectToolRegistrar — adapts ToolSurfaceCatalog PROJECT_TOOL descriptors
 * to Pi ExtensionAPI registerTool() definitions.
 *
 * pi-experiment-amq0.16
 *
 * DESIGN
 * ------
 * This module is the ONLY place in the project-tools plugin that imports from
 * the Pi SDK (@earendil-works/pi-coding-agent).  All execution concerns are
 * delegated to ProjectToolRunner (Pi-free).
 *
 * The ToolSurfaceCatalog (pi-experiment-amq0.15) is the SINGLE source of truth
 * for which project tools to register; this module does NOT rebuild a parallel
 * tool list — it reads PROJECT_TOOL entries from the catalog.
 *
 * MOVE NOTE
 * ---------
 * The registration body was moved verbatim from the old registerConfiguredProjectTools
 * implementation in src/plugins/projectTools.ts (which deleted it).  The change:
 *   - Iterates catalog.getToolEntries() for PROJECT_TOOL entries (instead of
 *     config.tools with a type !== EXTENSION guard) to consume the catalog
 *     as the single source of truth (amq0.15 contract).
 *   - Keeps config for the Pi registerTool parameter schemas (Type.Object),
 *     runtimeContext, and the frameworkRoot / namedRoots injection.
 *   - Calls executeConfiguredProjectTool from ProjectToolRunner (not from
 *     the old projectTools.ts location which no longer has the body).
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import type { ToolSurfaceCatalog } from '../../core/ToolSurfaceCatalog.js';
import { EventStore } from '../../core/EventStore.js';
import { ToolCallPathFactory } from '../../core/ToolCallPathFactory.js';
import type { RuntimeEnvironment } from '../../core/RuntimeEnvironment.js';
import type { HarnessConfig } from '../../core/ConfigLoader.js';
import { ProjectToolType } from '../../constants/index.js';
import type { ProjectCommandToolConfig, ProjectToolConfig } from '../../core/domain/StateModels.js';
import type { ProjectToolBackpressure } from '../../core/RuntimeServices.js';
import { frameworkRootFromConfig, namedRootsFromConfig } from './contextHelpers.js';
import {
  ProjectToolParameter,
  PROJECT_TOOL_DESCRIPTION_SUFFIX,
} from './constants.js';
import { executeConfiguredProjectTool } from './ProjectToolRunner.js';

// ---- ProjectToolRuntimeContext ----

export interface ProjectToolRuntimeContext {
  beadId?: string;
  stateId?: string;
  actionId?: string;
}

// ---- projectToolDescription (local) ----

function projectToolDescription(definition: ProjectToolConfig): string {
  const base = definition.description || `Project-specific tool: ${definition.name}`;
  return `${base} ${PROJECT_TOOL_DESCRIPTION_SUFFIX}`;
}

// ---- registerConfiguredProjectTools ----

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
  injectedRoot: string = process.cwd(),
  catalog: ToolSurfaceCatalog
) {
  const toolConfigs: ProjectToolConfig[] = catalog
    .getToolEntries()
    .filter(e => e.kind === 'PROJECT_TOOL' && e.configEntry !== undefined)
    .map(e => e.configEntry!);

  for (const definition of toolConfigs) {
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
