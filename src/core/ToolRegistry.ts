import type { RuntimePlugin, RuntimeServices, RuntimeTool } from './RuntimeServices.js';

export type HarnessTool = RuntimeTool;

/**
 * Look up a required tool by name within a plugin's tool list.
 * Throws a descriptive error if the tool is not registered, so callers get a
 * clear message instead of a downstream `Cannot read properties of undefined`.
 */
export function requireTool(plugin: RuntimePlugin, name: string): RuntimeTool {
  const tool = plugin.tools.find(t => t.name === name);
  if (!tool) {
    throw new Error(
      `Required tool "${name}" is not registered in plugin "${plugin.name}". ` +
      `Available tools: [${plugin.tools.map(t => t.name).join(', ')}]`
    );
  }
  return tool;
}

export interface ToolRegistryComposition {
  orchestratorPlugins: RuntimePlugin[];
  statePlugins: RuntimePlugin[];
}

type RuntimePluginProvider = Pick<RuntimeServices, 'plugins'>;

export function createToolRegistryComposition(services: RuntimePluginProvider): ToolRegistryComposition {
  return {
    orchestratorPlugins: [
      services.plugins.bd,
      services.plugins.git,
      services.plugins.mailbox,
      services.plugins.meta
    ],
    statePlugins: [
      services.plugins.mailbox,
      services.plugins.quality,
      services.plugins.signaling
    ]
  };
}

export class ToolRegistry {
  private readonly composition: ToolRegistryComposition;

  constructor(composition: ToolRegistryComposition) {
    this.composition = composition;
  }

  public getOrchestratorTools(): HarnessTool[] {
    return this.composition.orchestratorPlugins.flatMap(plugin => plugin.tools);
  }

  public getStateTools(): HarnessTool[] {
    return this.composition.statePlugins.flatMap(plugin => plugin.tools);
  }

  public getAllTools(): HarnessTool[] {
    return [
      ...this.getOrchestratorTools(),
      ...this.getStateTools()
    ];
  }
}
