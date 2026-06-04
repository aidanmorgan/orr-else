import * as fs from 'fs';
import * as path from 'path';
import { Type } from "@earendil-works/pi-ai";
import { EventStore } from '../core/EventStore.js';
import { DomainEventName, PluginToolName } from '../constants/index.js';
import type { RuntimePlugin, RuntimeTool } from '../core/RuntimeServices.js';

export interface CreatePluginResult {
  success: boolean;
  name?: string;
  path?: string;
  error?: string;
}

export function createMetaPlugin(eventStore: EventStore, projectRoot: string): RuntimePlugin {
  return {
  name: 'meta-plugin-manager',
  tools: [
    {
      name: PluginToolName.CREATE_NEW_PLUGIN,
      description: 'Create a new TypeScript plugin to extend the harness capabilities.',
      parameters: Type.Object({
        name: Type.String({ description: 'The name of the plugin file (e.g., custom-tool.ts)' }),
        content: Type.String({ description: 'The full TypeScript code for the plugin' })
      }),
      execute: async (params: unknown): Promise<CreatePluginResult> => {
        const { name, content } = (params && typeof params === 'object' ? params : {}) as { name: string; content: string };
        try {
          const safeName = path.basename(name);
          if (!safeName.endsWith('.ts') || safeName !== name) {
            throw new Error('Plugin name must be a single TypeScript filename ending in .ts');
          }
          const pluginPath = path.join(projectRoot, 'src', 'plugins', safeName);
          fs.writeFileSync(pluginPath, content);
          await eventStore.record(DomainEventName.PLUGIN_FILE_CREATED, {
            pluginName: safeName,
            path: pluginPath
          });
          return { success: true, name: safeName, path: pluginPath };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      }
    }
  ] satisfies RuntimeTool[]
};
}
