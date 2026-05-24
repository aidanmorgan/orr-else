import * as fs from 'fs';
import * as path from 'path';
import { Type } from "@earendil-works/pi-ai";
import { EventStore } from '../core/EventStore.js';
import { DomainEventName, PluginToolName } from '../constants/index.js';

export function createMetaPlugin(eventStore: EventStore) {
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
      execute: async ({ name, content }: { name: string, content: string }) => {
        try {
          const safeName = path.basename(name);
          if (!safeName.endsWith('.ts') || safeName !== name) {
            throw new Error('Plugin name must be a single TypeScript filename ending in .ts');
          }
          const pluginPath = path.join(process.cwd(), 'src', 'plugins', safeName);
          fs.writeFileSync(pluginPath, content);
          await eventStore.record(DomainEventName.PLUGIN_FILE_CREATED, {
            pluginName: safeName,
            path: pluginPath
          });
          return `Plugin ${safeName} created successfully at ${pluginPath}. You may need to restart the harness to load it.`;
        } catch (error) {
          return `Error creating plugin: ${error}`;
        }
      }
    }
  ]
};
}
