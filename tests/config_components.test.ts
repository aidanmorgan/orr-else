/**
 * pi-experiment-amq0.5: Unit tests for the 5 ConfigLoader sub-components.
 *
 * Tests cover:
 *  - ConfigFileSource: path resolution, caching fingerprint, missing file
 *  - ConfigParser: YAML parsing, tsProjectTool expansion, profile/default precedence
 *  - ConfigNormalizer: v2 map-form → array normalization, mergeWithDefaults
 *  - ConfigValidator: missing schema hard failure, malformed statechart, removed config fields
 *  - ConfigReferenceResolver: file-backed text resolution, checklist resolution
 *
 * These tests exercise the components WITHOUT filesystem config loading (no load() call),
 * proving normalization and validation can be tested independently of filesystem access.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigFileSource } from '../src/core/ConfigFileSource.js';
import { ConfigParser } from '../src/core/ConfigParser.js';
import { ConfigNormalizer } from '../src/core/ConfigNormalizer.js';
import { ConfigValidator } from '../src/core/ConfigValidator.js';
import { ConfigReferenceResolver } from '../src/core/ConfigReferenceResolver.js';
import { nodeRuntimeEnvironment } from '../src/core/RuntimeEnvironment.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amq0.5-'));
}

// ─── ConfigFileSource ────────────────────────────────────────────────────────

describe('ConfigFileSource', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('getConfigPath() falls back to default file name when nothing set', () => {
    const src = new ConfigFileSource(nodeRuntimeEnvironment, dir);
    const got = src.getConfigPath();
    expect(got).toBe(path.join(dir, 'harness.yaml'));
  });

  it('setConfigPath() stores a normalized absolute path', () => {
    const src = new ConfigFileSource(nodeRuntimeEnvironment, dir);
    src.setConfigPath('custom.yaml');
    expect(src.getConfigPath()).toBe(path.join(dir, 'custom.yaml'));
  });

  it('getExplicitConfigPath() returns null before setConfigPath()', () => {
    const src = new ConfigFileSource(nodeRuntimeEnvironment, dir);
    expect(src.getExplicitConfigPath()).toBeNull();
  });

  it('getExplicitConfigPath() returns the normalized path after setConfigPath()', () => {
    const src = new ConfigFileSource(nodeRuntimeEnvironment, dir);
    src.setConfigPath('custom.yaml');
    expect(src.getExplicitConfigPath()).toBe(path.join(dir, 'custom.yaml'));
  });

  it('reset() clears the explicit path', () => {
    const src = new ConfigFileSource(nodeRuntimeEnvironment, dir);
    src.setConfigPath('custom.yaml');
    src.reset();
    expect(src.getExplicitConfigPath()).toBeNull();
  });

  it('read() throws when file does not exist', () => {
    const src = new ConfigFileSource(nodeRuntimeEnvironment, dir);
    expect(() => src.read(path.join(dir, 'nonexistent.yaml')))
      .toThrow('Configuration file not found');
  });

  it('read() returns content + stat signature for existing file', () => {
    const src = new ConfigFileSource(nodeRuntimeEnvironment, dir);
    const file = path.join(dir, 'test.yaml');
    fs.writeFileSync(file, 'hello: world');
    const result = src.read(file);
    expect(result.fileContent).toBe('hello: world');
    expect(result.signature.size).toBeGreaterThan(0);
    expect(result.configPath).toBe(file);
  });
});

// ─── ConfigParser ────────────────────────────────────────────────────────────

describe('ConfigParser', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('parse() returns an object from YAML string', () => {
    const parser = new ConfigParser(dir);
    const result = parser.parse('key: value\nnumber: 42');
    expect(result).toEqual({ key: 'value', number: 42 });
  });

  it('parse() returns empty object for null/empty YAML', () => {
    const parser = new ConfigParser(dir);
    expect(parser.parse('')).toEqual({});
    expect(parser.parse('~')).toEqual({});
  });

  it('expandTsProjectToolsInRaw() expands tsProjectTool to command tool', () => {
    const parser = new ConfigParser(dir);
    const parsed: Record<string, unknown> = {
      tools: [
        { type: 'tsProjectTool', name: 'my_tool' }
      ]
    };
    parser.expandTsProjectToolsInRaw(parsed);
    const tools = parsed['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]['type']).toBe('command');
    expect(tools[0]['command']).toBe('node');
    const defaultArgs = tools[0]['defaultArgs'] as string[];
    expect(defaultArgs[0]).toBe('--experimental-strip-types');
    expect(typeof defaultArgs[1]).toBe('string');
    expect((defaultArgs[1] as string).endsWith('my_tool.ts')).toBe(true);
    expect(tools[0]['argsMode']).toBe('append');
    expect(tools[0]['allowArgs']).toBe(true);
  });

  it('expandTsProjectToolsInRaw() uses explicit scriptPath when provided', () => {
    const parser = new ConfigParser(dir);
    const customPath = path.join(dir, 'scripts', 'custom.ts');
    const parsed: Record<string, unknown> = {
      tools: [
        { type: 'tsProjectTool', name: 'my_tool', scriptPath: customPath }
      ]
    };
    parser.expandTsProjectToolsInRaw(parsed);
    const tools = parsed['tools'] as Array<Record<string, unknown>>;
    const defaultArgs = tools[0]['defaultArgs'] as string[];
    expect(defaultArgs[1]).toBe(customPath);
  });

  it('expandTsProjectToolsInRaw() respects tsProjectToolDefaults.scriptDir', () => {
    const parser = new ConfigParser(dir);
    const parsed: Record<string, unknown> = {
      settings: { tsProjectToolDefaults: { scriptDir: '.pi/custom-tools' } },
      tools: [{ type: 'tsProjectTool', name: 'my_tool' }]
    };
    parser.expandTsProjectToolsInRaw(parsed);
    const tools = parsed['tools'] as Array<Record<string, unknown>>;
    const defaultArgs = tools[0]['defaultArgs'] as string[];
    expect((defaultArgs[1] as string)).toContain('custom-tools');
    expect((defaultArgs[1] as string)).toContain('my_tool.ts');
  });

  it('expandTsProjectToolsInRaw() preserves non-tsProjectTool entries unchanged', () => {
    const parser = new ConfigParser(dir);
    const parsed: Record<string, unknown> = {
      tools: [{ type: 'command', name: 'other', command: 'echo' }]
    };
    parser.expandTsProjectToolsInRaw(parsed);
    const tools = parsed['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]['type']).toBe('command');
    expect(tools[0]['command']).toBe('echo');
  });

  it('expandTsProjectToolsInRaw() respects per-tool argsMode override', () => {
    const parser = new ConfigParser(dir);
    const parsed: Record<string, unknown> = {
      tools: [{ type: 'tsProjectTool', name: 'my_tool', argsMode: 'replace' }]
    };
    parser.expandTsProjectToolsInRaw(parsed);
    const tools = parsed['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]['argsMode']).toBe('replace');
  });
});

// ─── ConfigNormalizer ────────────────────────────────────────────────────────

describe('ConfigNormalizer', () => {
  it('normalizeV2MapCollections() converts map-form tools to sorted array', () => {
    const norm = new ConfigNormalizer();
    const parsed: Record<string, unknown> = {
      version: 2,
      tools: {
        zebra: { type: 'command', command: 'z' },
        alpha: { type: 'command', command: 'a' }
      }
    };
    norm.normalizeV2MapCollections(parsed);
    const tools = parsed['tools'] as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(2);
    // sorted lexicographically: alpha before zebra
    expect(tools[0]['name']).toBe('alpha');
    expect(tools[1]['name']).toBe('zebra');
  });

  it('normalizeV2MapCollections() sets name = key for each tool', () => {
    const norm = new ConfigNormalizer();
    const parsed: Record<string, unknown> = {
      tools: { my_tool: { type: 'command', command: 'node' } }
    };
    norm.normalizeV2MapCollections(parsed);
    const tools = parsed['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]['name']).toBe('my_tool');
  });

  it('normalizeV2MapCollections() converts map-form validationGates to sorted array', () => {
    const norm = new ConfigNormalizer();
    const parsed: Record<string, unknown> = {
      validationGates: {
        beta: { states: ['B'] },
        alpha: { states: ['A'] }
      }
    };
    norm.normalizeV2MapCollections(parsed);
    const gates = parsed['validationGates'] as Array<Record<string, unknown>>;
    expect(Array.isArray(gates)).toBe(true);
    expect(gates[0]['id']).toBe('alpha');
    expect(gates[1]['id']).toBe('beta');
  });

  it('normalizeV2MapCollections() converts map-form actions to sorted array', () => {
    const norm = new ConfigNormalizer();
    const parsed: Record<string, unknown> = {
      states: {
        Planning: {
          actions: {
            write: { type: 'prompt', prompt: 'Write' },
            analyze: { type: 'prompt', prompt: 'Analyze' }
          }
        }
      }
    };
    norm.normalizeV2MapCollections(parsed);
    const state = (parsed['states'] as Record<string, unknown>)['Planning'] as Record<string, unknown>;
    const actions = state['actions'] as Array<Record<string, unknown>>;
    expect(Array.isArray(actions)).toBe(true);
    expect(actions[0]['id']).toBe('analyze');
    expect(actions[1]['id']).toBe('write');
  });

  it('mergeWithDefaults() deep-merges replacing arrays', () => {
    const norm = new ConfigNormalizer();
    const defaults = { a: 1, b: [1, 2], c: { x: 10 } };
    const parsed = { b: [3], c: { y: 20 } };
    const result = norm.mergeWithDefaults(defaults as Record<string, unknown>, parsed) as Record<string, unknown>;
    expect((result['a'])).toBe(1);
    expect((result['b'] as number[])).toEqual([3]); // array replaced
    expect(((result['c'] as Record<string, unknown>)['x'])).toBe(10);
    expect(((result['c'] as Record<string, unknown>)['y'])).toBe(20);
  });
});

// ─── ConfigValidator ────────────────────────────────────────────────────────

describe('ConfigValidator', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('preValidateV2Admission() is a no-op for v1 (absent version)', () => {
    const validator = new ConfigValidator(dir, () => path.join(dir, 'harness.yaml'));
    expect(() => validator.preValidateV2Admission({ settings: {}, tools: [] })).not.toThrow();
  });

  it('preValidateV2Admission() rejects unknown version', () => {
    const validator = new ConfigValidator(dir, () => path.join(dir, 'harness.yaml'));
    expect(() => validator.preValidateV2Admission({ version: 99 }))
      .toThrow('Unknown harness config version: 99');
  });

  it('preValidateV2Admission() rejects v2 config with settings.startState (removed v1 field)', () => {
    const validator = new ConfigValidator(dir, () => path.join(dir, 'harness.yaml'));
    expect(() => validator.preValidateV2Admission({
      version: 2,
      settings: { startState: 'Planning' },
      statechart: {}
    })).toThrow('settings.startState');
  });

  it('preValidateV2Admission() rejects v2 config with statechart.terminalStates (removed v1 field)', () => {
    const validator = new ConfigValidator(dir, () => path.join(dir, 'harness.yaml'));
    expect(() => validator.preValidateV2Admission({
      version: 2,
      settings: {},
      statechart: { terminalStates: ['Done'] }
    })).toThrow('statechart.terminalStates');
  });

  it('preValidateNoDeprecatedToolFields() rejects tool with deprecated field', () => {
    const validator = new ConfigValidator(dir, () => path.join(dir, 'harness.yaml'));
    expect(() => validator.preValidateNoDeprecatedToolFields({
      tools: [{ name: 'old_tool', type: 'command', command: 'echo', deprecated: true }]
    })).toThrow('stale deprecated-lifecycle field');
  });

  it('preValidateNoDeprecatedToolFields() is a no-op for clean tools', () => {
    const validator = new ConfigValidator(dir, () => path.join(dir, 'harness.yaml'));
    expect(() => validator.preValidateNoDeprecatedToolFields({
      tools: [{ name: 'good_tool', type: 'command', command: 'echo' }]
    })).not.toThrow();
  });

  it('validate() fails closed when schema is missing', () => {
    // schemaPathResolver returns a nonexistent path; no project schema either
    const validator = new ConfigValidator(
      dir,
      () => path.join(dir, 'harness.yaml'),
      () => path.join(dir, 'nonexistent', 'harness.schema.json')
    );
    expect(() => validator.validate({ settings: {} }))
      .toThrow('Harness schema not found');
  });

  it('v2 terminal-sink-not-runnable: rejects if terminal state has actions', () => {
    const validator = new ConfigValidator(dir, () => path.join(dir, 'harness.yaml'));
    expect(() => validator.preValidateV2Admission({
      version: 2,
      settings: {},
      statechart: { terminal: ['Done'] },
      states: {
        Done: {
          actions: {
            cleanup: { type: 'prompt', prompt: 'cleanup' }
          }
        }
      }
    })).toThrow('terminal sink');
  });
});

// ─── ConfigReferenceResolver ─────────────────────────────────────────────────

describe('ConfigReferenceResolver', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('resolveFileBackedFields() resolves a file-path string to file content for harnessRestartPrompt', () => {
    const promptFile = path.join(dir, 'restart.md');
    fs.writeFileSync(promptFile, 'Restart prompt content');
    const resolver = new ConfigReferenceResolver(dir);

    // Build a minimal config with a file-backed harnessRestartPrompt
    const config = {
      version: 1,
      settings: {
        harnessRestartPrompt: promptFile,
        contextRestartPrompt: undefined,
        pi: {}
      },
      tools: [],
      validationGates: [],
      states: {},
      statechart: {}
    } as unknown as import('../src/core/domain/StateModels.js').HarnessConfig;

    resolver.resolveFileBackedFields(config);
    expect(config.settings.harnessRestartPrompt).toBe('Restart prompt content');
  });

  it('resolveFileBackedFields() leaves non-file string values unchanged', () => {
    const resolver = new ConfigReferenceResolver(dir);
    const config = {
      settings: {
        harnessRestartPrompt: 'Inline restart text',
        contextRestartPrompt: undefined,
        pi: {}
      },
      tools: [],
      validationGates: [],
      states: {},
      statechart: {}
    } as unknown as import('../src/core/domain/StateModels.js').HarnessConfig;

    resolver.resolveFileBackedFields(config);
    // Not a file path that exists → unchanged
    expect(config.settings.harnessRestartPrompt).toBe('Inline restart text');
  });

  it('expandToolProfiles() applies toolDefaults to command tools', () => {
    const resolver = new ConfigReferenceResolver(dir);
    const config = {
      settings: {
        toolDefaults: { timeoutMs: 5000 },
        pi: {}
      },
      tools: [{ type: 'command', name: 'my_tool', command: 'echo' }],
      validationGates: [],
      states: {},
      statechart: {}
    } as unknown as import('../src/core/domain/StateModels.js').HarnessConfig;

    resolver.expandToolProfiles(config);
    const tool = config.tools[0] as unknown as Record<string, unknown>;
    expect(tool['timeoutMs']).toBe(5000);
  });

  it('expandToolProfiles() throws for unknown profile reference', () => {
    const resolver = new ConfigReferenceResolver(dir);
    const config = {
      settings: {
        toolProfiles: { fastProfile: { timeoutMs: 1000 } },
        pi: {}
      },
      tools: [{ type: 'command', name: 'my_tool', command: 'echo', profile: 'unknownProfile' }],
      validationGates: [],
      states: {},
      statechart: {}
    } as unknown as import('../src/core/domain/StateModels.js').HarnessConfig;

    expect(() => resolver.expandToolProfiles(config))
      .toThrow('profile "unknownProfile" which is not defined');
  });
});
