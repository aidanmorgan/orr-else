import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuiltInToolName, NativePiToolName, NativeReadPolicyDefaults, PluginToolName, ProjectToolType } from '../src/constants/index.js';
import { ProtocolInjector } from '../src/core/ProtocolInjector.js';
import { InstructionLoader } from '../src/core/InstructionLoader.js';
import type { HarnessConfig, SDLCState } from '../src/core/domain/StateModels.js';

const root = path.join(os.tmpdir(), 'orr-else-instruction-loader-test');

function state(): SDLCState {
  return {
    id: 'RequirementsAnalysis',
    identity: { role: 'Requirements', expertise: 'Spec analysis', constraints: [] },
    baseInstructions: 'Analyze requirements.',
    actions: [],
    transitions: { SUCCESS: 'Planning' }
  };
}

// buvj: compatibility surface removed — these tests assert the ABSENCE of compat injection
describe('InstructionLoader — no compatibility surface (buvj)', () => {
  let instructionLoader: InstructionLoader;
  let protocolInjector: ProtocolInjector;

  beforeEach(() => {
    instructionLoader = new InstructionLoader(root);
    protocolInjector = new ProtocolInjector();
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('InstructionLoader does NOT expose a compatibilityContext method', () => {
    expect((instructionLoader as any).compatibilityContext).toBeUndefined();
  });

  it('InstructionLoader does NOT expose a compatibilityPaths method', () => {
    expect((instructionLoader as any).compatibilityPaths).toBeUndefined();
  });

  it('InstructionLoader does NOT expose a loadCompatibilityDocuments method', () => {
    expect((instructionLoader as any).loadCompatibilityDocuments).toBeUndefined();
  });

  it('protocol does NOT mention get_compatibility_context', () => {
    const config: HarnessConfig = {
      settings: {
        maxConcurrentSlots: 1,
        handoverTemplate: '',
        defaultModel: 'gpt-5.5',
        defaultProvider: 'openaiCodex',
        modelProviders: {}
      },
      states: {}
    } as HarnessConfig;
    const protocol = protocolInjector.inject(state(), config);

    expect(protocol).not.toContain('get_compatibility_context');
    // Core protocol tools still present
    expect(protocol).toContain(BuiltInToolName.GET_ARTIFACT_PATHS);
    expect(protocol).toContain(PluginToolName.BD_GET_BEAD);
    expect(protocol).toContain(PluginToolName.BD_GET_STATE_CHART);
    expect(protocol).toContain(NativePiToolName.BASH);
    expect(protocol).toContain(`${NativeReadPolicyDefaults.MAX_LIMIT_LINES} lines`);
    expect(protocol).toContain('Do not issue concurrent calls to the same configured project tool');
    expect(protocol).toContain('For structural code-pattern queries, use a configured AST-aware grep tool');
  });

  it('assemble() does NOT inject compatibility mode files section', () => {
    const config: HarnessConfig = {
      settings: {
        maxConcurrentSlots: 1,
        handoverTemplate: '',
        defaultModel: 'gpt-5.5',
        defaultProvider: 'openaiCodex',
        modelProviders: {}
      },
      states: {}
    } as HarnessConfig;
    const assembled = instructionLoader.assemble(state(), config);

    expect(assembled).not.toContain('COMPATIBILITY MODE FILES');
    expect(assembled).not.toContain('compatibility');
  });
});

describe('ProtocolInjector MCP distinction', () => {
  const injector = new ProtocolInjector();

  function baseConfig(): HarnessConfig {
    return {
      settings: {
        maxConcurrentSlots: 1,
        handoverTemplate: '',
        defaultModel: 'gpt-5.5',
        defaultProvider: 'openaiCodex',
        modelProviders: {}
      },
      states: {}
    } as HarnessConfig;
  }

  function stateFor(id: string): SDLCState {
    return {
      id,
      identity: { role: 'Dev', expertise: 'Coding', constraints: [] },
      baseInstructions: 'Do the work.',
      actions: [],
      transitions: { SUCCESS: 'Done' }
    };
  }

  it('does NOT inject the MCP policy line when no configured tools and native MCP is allowed', () => {
    const cfg = baseConfig();
    const protocol = injector.inject(stateFor('Implementation'), cfg);

    expect(protocol).not.toContain('MCP Policy');
    expect(protocol).not.toContain('Pi UI `MCP: 0/N`');
  });

  it('injects the MCP clarification line when MCP-backed project tools are configured, even when native MCP is allowed', () => {
    const cfg: HarnessConfig = {
      ...baseConfig(),
      tools: [
        { name: 'fixture_mcp_tool_a', type: ProjectToolType.MCP } as any,
        { name: 'reference_docs', type: ProjectToolType.MCP } as any
      ]
    };
    const protocol = injector.inject(stateFor('Implementation'), cfg);

    expect(protocol).toContain('MCP Policy');
    expect(protocol).toContain('Pi UI `MCP: 0/N` counts native adapters only, not Orr Else configured MCP-backed project tools');
    expect(protocol).toContain(BuiltInToolName.HARNESS_STATUS);
    // Must NOT disable-native-MCP language since native MCP is still allowed
    expect(protocol).not.toContain('access is disabled for this project');
    // Must NOT encourage routing BLOCKED solely on the native count
    expect(protocol).toContain('route a blocker only when no configured tool exposes the needed capability');
  });

  it('injects the MCP clarification line and disabled notice when native MCP is explicitly disabled', () => {
    const cfg: HarnessConfig = {
      ...baseConfig(),
      settings: {
        ...(baseConfig().settings),
        pi: { mcp: { allowToolCalls: false } }
      }
    };
    const protocol = injector.inject(stateFor('Implementation'), cfg);

    expect(protocol).toContain('MCP Policy');
    expect(protocol).toContain('access is disabled for this project');
    expect(protocol).toContain('Pi UI `MCP: 0/N` counts native adapters only, not Orr Else configured MCP-backed project tools');
    expect(protocol).toContain(BuiltInToolName.HARNESS_STATUS);
    expect(protocol).toContain('route a blocker only when no configured tool exposes the needed capability');
  });

  it('injects the MCP clarification line when native MCP is disabled AND MCP tools are configured', () => {
    const cfg: HarnessConfig = {
      ...baseConfig(),
      settings: {
        ...(baseConfig().settings),
        pi: { mcp: { allowToolCalls: false } }
      },
      tools: [
        { name: 'fixture_mcp_tool_b', type: ProjectToolType.MCP } as any
      ]
    };
    const protocol = injector.inject(stateFor('Implementation'), cfg);

    expect(protocol).toContain('MCP Policy');
    expect(protocol).toContain('Pi UI `MCP: 0/N` counts native adapters only, not Orr Else configured MCP-backed project tools');
  });

  it('does NOT instruct agents to route BLOCKED based solely on the native Pi MCP count', () => {
    const cfg: HarnessConfig = {
      ...baseConfig(),
      tools: [
        { name: 'fixture_mcp_tool_a', type: ProjectToolType.MCP } as any
      ]
    };
    const protocol = injector.inject(stateFor('Implementation'), cfg);

    // The guidance must only route BLOCKED when no configured tool covers the capability
    expect(protocol).toContain('route a blocker only when no configured tool exposes the needed capability');
    // Must NOT say "MCP is down" or imply native count = tool availability
    expect(protocol).not.toMatch(/route.*BLOCKED.*MCP.*0/i);
    expect(protocol).not.toMatch(/MCP.*0\/N.*blocked/i);
  });
});
