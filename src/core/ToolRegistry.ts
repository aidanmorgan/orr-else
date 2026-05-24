import { signalingPlugin } from '../plugins/signaling.js';
import { teammatePlugin, TeammateFactory } from '../plugins/teammates.js';
import type { RuntimeServices } from './RuntimeServices.js';

export interface HarnessTool {
  name: string;
  description: string;
  parameters: any;
  execute: (args: any, context?: any) => Promise<any>;
}

export class ToolRegistry {
  constructor(private readonly services: RuntimeServices) {}

  public getOrchestratorTools(): HarnessTool[] {
    const factory = new TeammateFactory(
      this.services.observability,
      this.services.configLoader,
      this.services.eventStore
    );
    return [
      ...this.services.plugins.bd.tools,
      ...this.services.plugins.git.tools,
      ...teammatePlugin(factory).tools,
      ...this.services.plugins.mailbox.tools,
      ...this.services.plugins.meta.tools
    ] as any;
  }

  public getStateTools(): HarnessTool[] {
    return [
      ...this.services.plugins.mailbox.tools,
      ...this.services.plugins.quality.tools,
      ...signalingPlugin.tools
    ] as any;
  }

  public getAllTools(): HarnessTool[] {
    return [
      ...this.getOrchestratorTools(),
      ...this.getStateTools()
    ];
  }
}
