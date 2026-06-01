import type { RuntimePlugin, RuntimeServices, RuntimeTool } from './RuntimeServices.js';

export type HarnessTool = RuntimeTool;

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
      services.plugins.teammates,
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

function isRuntimePluginProvider(input: ToolRegistryComposition | RuntimePluginProvider): input is RuntimePluginProvider {
  return 'plugins' in input;
}

export class ToolRegistry {
  private readonly composition: ToolRegistryComposition;

  constructor(composition: ToolRegistryComposition | RuntimePluginProvider) {
    this.composition = isRuntimePluginProvider(composition)
      ? createToolRegistryComposition(composition)
      : composition;
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
