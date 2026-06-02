/**
 * Tests for the generic named-root injection contract.
 *
 * Coverage:
 *   (a) resolveTemplateString — {{roots.NAME}} tokens expanded from namedRoots
 *   (b) namedRootsFromConfig — resolves settings.roots paths relative to projectRoot
 *   (c) baseTemplateContext — namedRoots propagated into TemplateContext via args
 *   (d) projectToolEnvironment — namedRoots emitted as HARNESS_ROOT_<NAME> env vars
 *   (e) resolvePathArgumentRoot — rootKind matching a named root resolves to that root
 *   (f) virtualRoots template expansion — {{roots.NAME}} in virtualRoots is expanded
 *   (g) Multiple named roots — all keys injected; unknown tokens left untouched
 *   (h) No named roots — context unchanged; no HARNESS_ROOT_* env vars emitted
 *   (i) namedRootsFromConfig with relative paths — resolved against projectRoot
 *   (j) namedRootsFromConfig with template tokens in values — {{projectRoot}} expanded
 */

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
  resolveTemplateString,
  NAMED_ROOT_TOKEN_PREFIX,
  type TemplateContext
} from '../src/core/PiIntegration.js';
import {
  namedRootsFromConfig,
  projectToolEnvironment
} from '../src/plugins/projectTools/contextHelpers.js';
import {
  resolvePathArgumentRoot,
  normalizePathArgumentValue
} from '../src/plugins/projectTools/pathNormalization.js';
import { normalizeMcpPathArguments } from '../src/plugins/projectTools.js';
import { ProjectToolType } from '../src/constants/index.js';
import type { HarnessConfig } from '../src/core/domain/StateModels.js';
import type { ProjectToolExecutionContext } from '../src/plugins/projectTools/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeProjectRoot(): string {
  const dir = path.join(os.tmpdir(), `named-root-test-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function minimalConfig(roots?: Record<string, string>): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: 'handover',
      agentTurnTimeoutMs: 60000,
      processReapIntervalMs: 5000,
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'claude-3-5-sonnet-20241022',
      defaultProvider: 'anthropic',
      modelProviders: {},
      stateContextRotThreshold: 50000,
      harnessContextRotThreshold: 100000,
      startState: 'planning',
      ...(roots ? { roots } : {})
    },
    scheduler: {
      weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
    },
    states: {}
  } as unknown as HarnessConfig;
}

function baseContext(overrides: Partial<TemplateContext> = {}): TemplateContext {
  const projectRoot = '/test/project';
  return {
    projectRoot,
    worktreePath: '/test/worktree',
    beadId: 'bd-test',
    stateId: 'planning',
    actionId: 'analyze',
    toolName: 'test_tool',
    ...overrides
  };
}

function executionCtxFromTemplateContext(tc: TemplateContext): ProjectToolExecutionContext {
  const callDir = path.join(tc.projectRoot, '.tmp', 'tool-calls', 'test');
  const outputDir = path.join(callDir, 'output');
  return {
    templateContext: tc,
    cwd: tc.worktreePath,
    callDir,
    outputDir,
    outputFile: path.join(outputDir, 'result.json'),
    tmpDir: path.join(callDir, 'tmp'),
    hostEnv: {}
  };
}

// ---------------------------------------------------------------------------
// (a) resolveTemplateString — {{roots.NAME}} expansion
// ---------------------------------------------------------------------------

describe('resolveTemplateString — {{roots.NAME}} expansion', () => {
  it('(a1) expands a single named root token', () => {
    const ctx = baseContext({
      namedRoots: { artifactsDir: '/abs/artifacts' }
    });
    const result = resolveTemplateString('{{roots.artifactsDir}}/output', ctx);
    expect(result).toBe('/abs/artifacts/output');
  });

  it('(a2) expands multiple named root tokens in one string', () => {
    const ctx = baseContext({
      namedRoots: {
        srcRoot: '/src',
        buildRoot: '/build'
      }
    });
    const result = resolveTemplateString(
      '{{roots.srcRoot}}/lib and {{roots.buildRoot}}/dist',
      ctx
    );
    expect(result).toBe('/src/lib and /build/dist');
  });

  it('(a3) leaves unknown {{roots.X}} tokens untouched when no namedRoots', () => {
    const ctx = baseContext();
    const result = resolveTemplateString('{{roots.unknown}}/foo', ctx);
    expect(result).toBe('{{roots.unknown}}/foo');
  });

  it('(a4) leaves unknown {{roots.X}} tokens untouched when key not in namedRoots', () => {
    const ctx = baseContext({
      namedRoots: { known: '/known' }
    });
    const result = resolveTemplateString('{{roots.unknown}}/bar', ctx);
    expect(result).toBe('{{roots.unknown}}/bar');
  });

  it('(a5) named root tokens coexist with standard tokens', () => {
    const ctx = baseContext({
      namedRoots: { myRoot: '/my/root' }
    });
    const result = resolveTemplateString(
      '{{projectRoot}}/src and {{roots.myRoot}}/lib',
      ctx
    );
    expect(result).toBe('/test/project/src and /my/root/lib');
  });

  it('(a6) NAMED_ROOT_TOKEN_PREFIX is exported and correct', () => {
    expect(NAMED_ROOT_TOKEN_PREFIX).toBe('{{roots.');
  });
});

// ---------------------------------------------------------------------------
// (b) namedRootsFromConfig — settings.roots path resolution
// ---------------------------------------------------------------------------

describe('namedRootsFromConfig', () => {
  it('(b1) returns undefined when settings.roots is absent', () => {
    const config = minimalConfig();
    expect(namedRootsFromConfig(config)).toBeUndefined();
  });

  it('(b2) returns undefined when settings.roots is empty', () => {
    const config = minimalConfig({});
    expect(namedRootsFromConfig(config)).toBeUndefined();
  });

  it('(b3) returns resolved absolute paths unchanged', () => {
    const config = minimalConfig({
      myRoot: '/absolute/path/to/root'
    });
    const result = namedRootsFromConfig(config, undefined, '/ignored');
    expect(result).toBeDefined();
    expect(result!['myRoot']).toBe('/absolute/path/to/root');
  });

  it('(b4) resolves relative paths against projectRoot', () => {
    const projectRoot = '/my/project';
    const config = minimalConfig({ srcDir: 'src/main' });
    const result = namedRootsFromConfig(config, undefined, projectRoot);
    expect(result!['srcDir']).toBe('/my/project/src/main');
  });

  it('(b5) resolves multiple roots', () => {
    const projectRoot = '/prj';
    const config = minimalConfig({
      artifactsDir: '/abs/artifacts',
      buildDir: 'build/output'
    });
    const result = namedRootsFromConfig(config, undefined, projectRoot);
    expect(result!['artifactsDir']).toBe('/abs/artifacts');
    expect(result!['buildDir']).toBe('/prj/build/output');
  });

  it('(b6) expands {{projectRoot}} in values before resolving', () => {
    const projectRoot = '/real/project';
    const config = minimalConfig({
      frameworkDir: '{{projectRoot}}/framework'
    });
    const result = namedRootsFromConfig(config, undefined, projectRoot);
    expect(result!['frameworkDir']).toBe('/real/project/framework');
  });

  it('(b7) skips blank/empty values without crashing', () => {
    const config = minimalConfig({
      validRoot: '/valid',
      emptyRoot: ''
    });
    const result = namedRootsFromConfig(config, undefined, '/prj');
    expect(result).toBeDefined();
    expect(result!['validRoot']).toBe('/valid');
    expect(result!['emptyRoot']).toBeUndefined();
  });

  it('(i) relative paths with real disk directory are resolved correctly', () => {
    const projectRoot = makeProjectRoot();
    try {
      const subDir = path.join(projectRoot, 'artifacts');
      fs.mkdirSync(subDir, { recursive: true });
      const config = minimalConfig({ artifacts: 'artifacts' });
      const result = namedRootsFromConfig(config, undefined, projectRoot);
      expect(result!['artifacts']).toBe(subDir);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (d) projectToolEnvironment — HARNESS_ROOT_<NAME> env vars
// ---------------------------------------------------------------------------

describe('projectToolEnvironment — named-root env vars', () => {
  it('(d1) emits HARNESS_ROOT_<UPPER> for each named root', () => {
    const ctx = baseContext({
      toolCallDir: '/tmp/calldir',
      toolOutputDir: '/tmp/outputdir',
      toolOutputFile: '/tmp/outputdir/result.json',
      toolTmpDir: '/tmp/tmpdir',
      toolInvocationId: 'test-invocation-id',
      namedRoots: {
        artifactsDir: '/abs/artifacts',
        buildRoot: '/abs/build'
      }
    });
    const execCtx = executionCtxFromTemplateContext(ctx);
    const env = projectToolEnvironment(execCtx);

    expect(env['HARNESS_ROOT_ARTIFACTSDIR']).toBe('/abs/artifacts');
    expect(env['HARNESS_ROOT_BUILDROOT']).toBe('/abs/build');
  });

  it('(d2) does NOT emit any HARNESS_ROOT_* when namedRoots is absent', () => {
    const ctx = baseContext({
      toolCallDir: '/tmp/calldir',
      toolOutputDir: '/tmp/outputdir',
      toolOutputFile: '/tmp/outputdir/result.json',
      toolTmpDir: '/tmp/tmpdir',
      toolInvocationId: 'test-invocation-id'
    });
    const execCtx = executionCtxFromTemplateContext(ctx);
    const env = projectToolEnvironment(execCtx);
    const harnessRootKeys = Object.keys(env).filter(k => k.startsWith('HARNESS_ROOT_'));
    expect(harnessRootKeys).toHaveLength(0);
  });

  it('(d3) sanitizes non-alphanumeric chars in root name to underscores for env key', () => {
    const ctx = baseContext({
      toolCallDir: '/tmp/calldir',
      toolOutputDir: '/tmp/outputdir',
      toolOutputFile: '/tmp/outputdir/result.json',
      toolTmpDir: '/tmp/tmpdir',
      toolInvocationId: 'test-invocation-id',
      namedRoots: {
        'my-root': '/my/root'
      }
    });
    const execCtx = executionCtxFromTemplateContext(ctx);
    const env = projectToolEnvironment(execCtx);
    // Dashes are replaced with underscores
    expect(env['HARNESS_ROOT_MY_ROOT']).toBe('/my/root');
  });
});

// ---------------------------------------------------------------------------
// (e) resolvePathArgumentRoot — rootKind matching a named root
// ---------------------------------------------------------------------------

describe('resolvePathArgumentRoot — named root via rootKind', () => {
  it('(e1) resolves a named rootKind to the corresponding namedRoots path', () => {
    const ctx = baseContext({
      namedRoots: { artifactsDir: '/abs/artifacts' }
    });
    const config = { rootKind: 'artifactsDir' as any };
    const result = resolvePathArgumentRoot(config, ctx);
    expect(result.path).toBe('/abs/artifacts');
    expect(result.kind).toBe('artifactsDir');
  });

  it('(e2) falls through to configured root when rootKind not in namedRoots', () => {
    const ctx = baseContext({
      namedRoots: { myRoot: '/my/root' }
    });
    // rootKind is 'worktree' — one of the built-in kinds, not in namedRoots
    const config = { rootKind: 'worktree' as any };
    const result = resolvePathArgumentRoot(config, ctx);
    expect(result.path).toBe('/test/worktree');
    expect(result.kind).toBe('worktree');
  });

  it('(e3) named rootKind takes precedence over falling through to configured', () => {
    const ctx = baseContext({
      namedRoots: {
        customRoot: '/custom/root'
      }
    });
    const config = {
      rootKind: 'customRoot' as any,
      root: '/some-other-root'
    };
    const result = resolvePathArgumentRoot(config, ctx);
    expect(result.path).toBe('/custom/root');
    expect(result.kind).toBe('customRoot');
  });

  it('(e4) built-in rootKind values still work with namedRoots present', () => {
    const ctx = baseContext({
      namedRoots: { myDir: '/my/dir' }
    });
    // project root kind
    const configProject = { rootKind: 'project' as any };
    expect(resolvePathArgumentRoot(configProject, ctx).path).toBe('/test/project');

    // worktree root kind
    const configWorktree = { rootKind: 'worktree' as any };
    expect(resolvePathArgumentRoot(configWorktree, ctx).path).toBe('/test/worktree');
  });
});

// ---------------------------------------------------------------------------
// (f) virtualRoots template expansion with {{roots.NAME}}
// ---------------------------------------------------------------------------

describe('virtualRoots template expansion with {{roots.NAME}}', () => {
  it('(f1) {{roots.NAME}} in virtualRoots is expanded when normalizing MCP path arguments', () => {
    const projectRoot = makeProjectRoot();
    const worktreeRoot = path.join(projectRoot, 'worktree');
    fs.mkdirSync(worktreeRoot, { recursive: true });
    try {
      const myRoot = '/my/virtual/root';
      const templateContext: TemplateContext = {
        projectRoot,
        worktreePath: worktreeRoot,
        beadId: 'bd-1',
        stateId: 'planning',
        actionId: 'analyze',
        toolName: 'test_mcp',
        namedRoots: { myRoot }
      };

      const result = normalizeMcpPathArguments(
        {
          name: 'test_mcp',
          type: ProjectToolType.MCP,
          server: 'test-server',
          pathArguments: {
            operation1: {
              filePath: {
                root: 'worktree' as any,
                virtualRoots: ['{{roots.myRoot}}']
              }
            }
          }
        },
        'operation1',
        'operation1',
        { filePath: '/my/virtual/root/src/file.ts' },
        templateContext
      );

      // The path should have been normalized: virtual root prefix stripped,
      // then resolved against the worktree root
      expect(result.normalizedPathArguments).toContain('filePath');
      expect(result.arguments['filePath']).toBe(path.join(worktreeRoot, 'src/file.ts'));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('(f2) normalizePathArgumentValue resolves {{roots.NAME}} in a virtualRoots entry', () => {
    const projectRoot = makeProjectRoot();
    const worktreeRoot = path.join(projectRoot, 'worktree');
    fs.mkdirSync(worktreeRoot, { recursive: true });
    try {
      const myRoot = path.join(projectRoot, 'my-root');
      const templateContext: TemplateContext = {
        projectRoot,
        worktreePath: worktreeRoot,
        beadId: 'bd-1',
        stateId: 'planning',
        actionId: 'analyze',
        toolName: 'test_tool',
        namedRoots: { myRoot }
      };

      // Value uses the virtual root prefix
      const value = path.join(myRoot, 'sub/path.ts');
      const normalized = normalizePathArgumentValue(
        'test_tool',
        'filePath',
        value,
        {
          root: 'worktree' as any,
          virtualRoots: ['{{roots.myRoot}}']
        },
        templateContext
      );

      // Strip virtual root → resolve against worktree
      expect(normalized).toBe(path.join(worktreeRoot, 'sub/path.ts'));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (g) Multiple named roots — all keys injected
// ---------------------------------------------------------------------------

describe('Multiple named roots coexist', () => {
  it('(g1) all namedRoots entries are available as template tokens', () => {
    const ctx = baseContext({
      namedRoots: {
        rootA: '/path/a',
        rootB: '/path/b',
        rootC: '/path/c'
      }
    });
    expect(resolveTemplateString('{{roots.rootA}}', ctx)).toBe('/path/a');
    expect(resolveTemplateString('{{roots.rootB}}', ctx)).toBe('/path/b');
    expect(resolveTemplateString('{{roots.rootC}}', ctx)).toBe('/path/c');
  });

  it('(g2) unknown tokens untouched; defined tokens expanded in same string', () => {
    const ctx = baseContext({
      namedRoots: { knownRoot: '/known' }
    });
    const result = resolveTemplateString(
      '{{roots.knownRoot}}/a and {{roots.unknownRoot}}/b',
      ctx
    );
    expect(result).toBe('/known/a and {{roots.unknownRoot}}/b');
  });
});

// ---------------------------------------------------------------------------
// (h) No named roots — backward compat
// ---------------------------------------------------------------------------

describe('Backward compat when no namedRoots', () => {
  it('(h1) resolveTemplateString works normally without namedRoots', () => {
    const ctx = baseContext();
    expect(resolveTemplateString('{{projectRoot}}/src', ctx)).toBe('/test/project/src');
    expect(resolveTemplateString('{{worktreePath}}/lib', ctx)).toBe('/test/worktree/lib');
  });

  it('(h2) projectToolEnvironment emits no HARNESS_ROOT_* without namedRoots', () => {
    const ctx = baseContext({
      toolCallDir: '/tmp/calldir',
      toolOutputDir: '/tmp/outputdir',
      toolOutputFile: '/tmp/outputdir/result.json',
      toolTmpDir: '/tmp/tmpdir',
      toolInvocationId: 'inv-id'
    });
    const execCtx = executionCtxFromTemplateContext(ctx);
    const env = projectToolEnvironment(execCtx);
    const harnessKeys = Object.keys(env).filter(k => k.startsWith('HARNESS_ROOT_'));
    expect(harnessKeys).toHaveLength(0);
  });

  it('(h3) resolvePathArgumentRoot falls back normally when namedRoots absent', () => {
    const ctx = baseContext();
    const result = resolvePathArgumentRoot({ rootKind: 'worktree' as any }, ctx);
    expect(result.path).toBe('/test/worktree');
    expect(result.kind).toBe('worktree');
  });
});
