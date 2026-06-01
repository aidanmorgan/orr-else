import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuiltInToolName, NativePiToolName, NativeReadPolicyDefaults, PluginToolName } from '../src/constants/index.js';
import { ProtocolInjector } from '../src/core/ProtocolInjector.js';
import { InstructionLoader } from '../src/core/InstructionLoader.js';
import { setProjectRoot } from '../src/core/Paths.js';
import type { HarnessConfig, SDLCState } from '../src/core/domain/StateModels.js';

const root = path.join(os.tmpdir(), 'orr-else-instruction-loader-test');

function writeFile(relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function config(): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: '',
      defaultModel: 'gpt-5.5',
      defaultProvider: 'openaiCodex',
      modelProviders: {},
      compatibilityMode: 'claude',
      compatibility: {
        modes: {
          claude: {
            masterRules: ['CLAUDE.md'],
            ruleDirs: ['.claude/rules'],
            hookDirs: ['.claude/hooks'],
            docsDirs: ['.claude/docs']
          }
        }
      }
    },
    states: {}
  } as HarnessConfig;
}

function state(): SDLCState {
  return {
    id: 'RequirementsAnalysis',
    identity: { role: 'Requirements', expertise: 'Spec analysis', constraints: [] },
    baseInstructions: 'Analyze requirements.',
    actions: [],
    transitions: { SUCCESS: 'Planning' }
  };
}

describe('InstructionLoader compatibility context', () => {
  let instructionLoader: InstructionLoader;
  let protocolInjector: ProtocolInjector;

  beforeEach(() => {
    instructionLoader = new InstructionLoader();
    protocolInjector = new ProtocolInjector();
    fs.rmSync(root, { recursive: true, force: true });
    setProjectRoot(root);
    writeFile('CLAUDE.md', '# Claude rules\n');
    writeFile('.claude/rules/tooling.md', '# Tooling\n');
    writeFile('.claude/hooks/enforce-tools.py', 'print("ok")\n');
    writeFile('.claude/hooks/vendor/ignored.py', 'print("ignored")\n');
    writeFile('.claude/docs/design.md', '# Design\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    setProjectRoot(process.cwd());
  });

  it('returns typed compatibility paths without asking agents to read directories', () => {
    const context = instructionLoader.compatibilityContext(config());

    expect(context.mode).toBe('claude');
    expect(context.masterRules).toEqual([path.join(root, 'CLAUDE.md')]);
    expect(context.ruleFiles).toEqual([path.join(root, '.claude/rules/tooling.md')]);
    expect(context.hookDirs).toEqual([path.join(root, '.claude/hooks')]);
    expect(context.hookFiles).toEqual([path.join(root, '.claude/hooks/enforce-tools.py')]);
    expect(context.docDirs).toEqual([path.join(root, '.claude/docs')]);
    expect(context.docFiles).toEqual([]);
    expect(context.agentDirs).toEqual([]);
    expect(context.agentFiles).toEqual([]);
    expect(context.truncated).toEqual([]);
    expect(context.missing).toEqual([]);
  });

  it('expands compatibility docs only when requested', () => {
    const context = instructionLoader.compatibilityContext(config(), { includeDocs: true });

    expect(context.docFiles).toEqual([path.join(root, '.claude/docs/design.md')]);
  });

  it('bounds expanded compatibility docs', () => {
    writeFile('.claude/docs/architecture.md', '# Architecture\n');
    writeFile('.claude/docs/process.md', '# Process\n');

    const context = instructionLoader.compatibilityContext(config(), { includeDocs: true, maxDocs: 2 });

    expect(context.docFiles).toHaveLength(2);
    expect(context.truncated).toEqual([{
      group: 'docFiles',
      returned: 2,
      total: 3,
      limit: 2
    }]);
  });

  it('injects the compatibility tool into the protocol instructions', () => {
    const protocol = protocolInjector.inject(state(), config());

    expect(protocol).toContain(BuiltInToolName.GET_COMPATIBILITY_CONTEXT);
    expect(protocol).toContain(BuiltInToolName.GET_ARTIFACT_PATHS);
    expect(protocol).toContain(PluginToolName.BD_GET_BEAD);
    expect(protocol).toContain(PluginToolName.BD_GET_STATE_CHART);
    expect(protocol).toContain(NativePiToolName.BASH);
    expect(protocol).toContain(`${NativeReadPolicyDefaults.MAX_LIMIT_LINES} lines`);
    expect(protocol).toContain('Do not issue concurrent calls to the same configured project tool');
    expect(protocol).toContain('Use `ast_grep` only for valid AST-shaped structural patterns');
  });
});
