import { describe, expect, it } from 'vitest';
import { BuiltInToolName, PluginToolName } from '../src/constants/index.js';
import { createRuntimeServices } from '../src/composition/createRuntimeServices.js';
import { createToolRegistryComposition, requireTool, ToolRegistry } from '../src/core/ToolRegistry.js';
import type { RuntimePlugin } from '../src/core/RuntimeServices.js';

describe('ToolRegistry composition', () => {
  it('exposes the existing orchestrator and state tool sets from injected runtime plugins', () => {
    const services = createRuntimeServices();
    const registry = new ToolRegistry(createToolRegistryComposition(services));

    expect(registry.getOrchestratorTools().map(tool => tool.name)).toEqual([
      PluginToolName.BD_READY,
      PluginToolName.BD_LIST,
      PluginToolName.BD_EXPORT_JSONL,
      PluginToolName.BD_IMPORT_JSONL,
      PluginToolName.BD_CREATE,
      PluginToolName.BD_GET_BEAD,
      PluginToolName.BD_GET_STATE_CHART,
      PluginToolName.BD_CLAIM,
      PluginToolName.BD_RELEASE,
      PluginToolName.BD_UPDATE_STATUS,
      PluginToolName.BD_HEARTBEAT,
      PluginToolName.BD_GET_HEARTBEATS,
      PluginToolName.CREATE_WORKTREE,
      PluginToolName.REMOVE_WORKTREE,
      PluginToolName.MERGE_AND_COMMIT,
      PluginToolName.SPAWN_TEAMMATE,
      PluginToolName.SEND_MAILBOX_MESSAGE,
      PluginToolName.CHECK_MAILBOX,
      'fetch_mailbox_message',
      PluginToolName.CREATE_NEW_PLUGIN
    ]);

    expect(registry.getStateTools().map(tool => tool.name)).toEqual([
      PluginToolName.SEND_MAILBOX_MESSAGE,
      PluginToolName.CHECK_MAILBOX,
      'fetch_mailbox_message',
      PluginToolName.RUN_QUALITY_CHECKS,
      PluginToolName.COMPRESS_SESSION_LOGS,
      BuiltInToolName.SIGNAL_COMPLETION
    ]);
  });

  it('keeps the RuntimeServices constructor path behavior-compatible', () => {
    const registry = new ToolRegistry(createRuntimeServices());

    expect(registry.getAllTools().map(tool => tool.name)).toContain(PluginToolName.SPAWN_TEAMMATE);
    expect(registry.getAllTools().map(tool => tool.name)).toContain(BuiltInToolName.SIGNAL_COMPLETION);
  });
});

describe('requireTool', () => {
  function fakePlugin(toolNames: string[]): RuntimePlugin {
    return {
      name: 'fake-plugin',
      tools: toolNames.map(name => ({
        name,
        description: `Tool ${name}`,
        execute: () => {}
      }))
    };
  }

  it('returns the tool when it is registered in the plugin', () => {
    const plugin = fakePlugin(['tool-a', 'tool-b']);
    const result = requireTool(plugin, 'tool-a');
    expect(result.name).toBe('tool-a');
  });

  it('throws a descriptive error when the tool is missing', () => {
    const plugin = fakePlugin(['tool-a', 'tool-b']);
    expect(() => requireTool(plugin, 'tool-missing')).toThrow(
      'Required tool "tool-missing" is not registered in plugin "fake-plugin"'
    );
  });

  it('error message lists the available tool names', () => {
    const plugin = fakePlugin(['tool-a', 'tool-b']);
    expect(() => requireTool(plugin, 'tool-missing')).toThrow(
      'Available tools: [tool-a, tool-b]'
    );
  });

  it('returns the same object reference (not a copy)', () => {
    const plugin = fakePlugin(['tool-a']);
    const result = requireTool(plugin, 'tool-a');
    expect(result).toBe(plugin.tools[0]);
  });
});
