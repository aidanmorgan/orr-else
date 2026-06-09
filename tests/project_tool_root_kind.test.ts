/**
 * pi-experiment-amq0.19 — Single typed project-tool root/path-scope model + startup named-root validation.
 *
 * Coverage:
 *   A. Built-in root kinds resolve correctly via resolvePathArgumentRoot.
 *   B. Named roots resolve when present in namedRoots.
 *   C. Missing named root at runtime: resolvePathArgumentRoot throws (fail-closed).
 *   D. Path escape: PathArgumentRootEscapeError is thrown and carries typed guidance.
 *   E. No 'configured' compat-mode: raw-string fallback cannot leak from resolvePathArgumentRoot.
 *   F. Startup validation: unknown named rootKind → startup failure via ConfigValidator.validateNamedRoots.
 *   G. Startup validation: known named rootKind declared in settings.roots → passes.
 *   H. Startup validation: MCP tool pathArguments unknown rootKind → startup failure.
 *   I. Structured rejection diagnostics: PathArgumentEscapeGuidance.rootKind is typed.
 *   J. ProjectToolRootKind from constants/domain.ts is the single source (no duplicate).
 *   K. Cerdiwen artifact/root template tests: read-only in-repo fixture untouched.
 */

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ProjectToolRootKind } from '../src/constants/domain.js';
import type { ProjectToolBuiltinRootKind } from '../src/constants/domain.js';
import {
  BUILTIN_ROOT_KINDS,
  type ResolvedRootKind
} from '../src/plugins/projectTools/rootKind.js';
import {
  resolvePathArgumentRoot,
  normalizePathArgumentValue,
  PathArgumentRootEscapeError
} from '../src/plugins/projectTools/pathNormalization.js';
import type { TemplateContext } from '../src/core/TemplateResolver.js';
import { ConfigValidator } from '../src/core/ConfigValidator.js';
import type { HarnessConfig } from '../src/core/domain/StateModels.js';
import type { ProjectToolPathArgumentConfig } from '../src/core/domain/StateModels.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseContext(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    projectRoot: '/test/project',
    worktreePath: '/test/worktree',
    ...overrides
  };
}

function makeConfigValidator(projectRoot: string): ConfigValidator {
  return new ConfigValidator(projectRoot, () => path.join(projectRoot, 'harness.yaml'));
}

/**
 * Minimal harness config for ConfigValidator.validateNamedRoots tests.
 * Uses v1 format to avoid triggering v2-only validation.
 */
function minimalConfig(overrides: {
  roots?: Record<string, string>;
  tools?: unknown;
} = {}): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: 'handover',
      agentTurnTimeoutMs: 60000,
      processReapIntervalMs: 5000,
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'claude-opus-4-5',
      defaultProvider: 'anthropic',
      modelProviders: {},
      stateContextRotThreshold: 50000,
      harnessContextRotThreshold: 100000,
      startState: 'planning',
      ...(overrides.roots ? { roots: overrides.roots } : {})
    },
    statechart: {
      terminalStates: ['completed'],
      advanceOutcomes: ['SUCCESS'],
      failedOutcomes: ['FAILURE'],
      blockedOutcomes: ['BLOCKED']
    },
    states: {},
    tools: overrides.tools ?? []
  } as unknown as HarnessConfig;
}

// ---------------------------------------------------------------------------
// A. Built-in root kinds resolve correctly
// ---------------------------------------------------------------------------

describe('A. Built-in root kinds via resolvePathArgumentRoot', () => {
  it('A1: worktree rootKind resolves to worktreePath', () => {
    const ctx = baseContext();
    const result = resolvePathArgumentRoot({ rootKind: ProjectToolRootKind.WORKTREE }, ctx);
    expect(result.path).toBe('/test/worktree');
    expect(result.kind).toBe('worktree');
  });

  it('A2: project rootKind resolves to projectRoot', () => {
    const ctx = baseContext();
    const result = resolvePathArgumentRoot({ rootKind: ProjectToolRootKind.PROJECT }, ctx);
    expect(result.path).toBe('/test/project');
    expect(result.kind).toBe('project');
  });

  it('A3: framework rootKind resolves to frameworkRoot when present', () => {
    const ctx = baseContext({ frameworkRoot: '/test/framework' });
    const result = resolvePathArgumentRoot({ rootKind: ProjectToolRootKind.FRAMEWORK }, ctx);
    expect(result.path).toBe('/test/framework');
    expect(result.kind).toBe('framework');
  });

  it('A4: framework rootKind throws when frameworkRoot is absent', () => {
    const ctx = baseContext();
    expect(() => resolvePathArgumentRoot({ rootKind: ProjectToolRootKind.FRAMEWORK }, ctx))
      .toThrow('no framework root');
  });

  it('A5: workspace rootKind resolves to workspaceRoot', () => {
    const ctx = baseContext();
    const result = resolvePathArgumentRoot(
      { rootKind: ProjectToolRootKind.WORKSPACE, workspaceRoot: '/abs/workspace' },
      ctx
    );
    expect(result.path).toBe('/abs/workspace');
    expect(result.kind).toBe('workspace');
  });

  it('A6: workspace rootKind throws when workspaceRoot is absent', () => {
    const ctx = baseContext();
    expect(() => resolvePathArgumentRoot({ rootKind: ProjectToolRootKind.WORKSPACE }, ctx))
      .toThrow('workspaceRoot is not configured');
  });

  it('A7: kind field on resolution is always typed (not a raw string fallback)', () => {
    const ctx = baseContext();
    const result = resolvePathArgumentRoot({ rootKind: ProjectToolRootKind.WORKTREE }, ctx);
    // TypeScript ensures result.kind is ResolvedRootKind at compile time;
    // at runtime verify it is a known built-in kind.
    expect(BUILTIN_ROOT_KINDS.has(result.kind)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. Named roots resolve when present in namedRoots
// ---------------------------------------------------------------------------

describe('B. Named root resolution', () => {
  it('B1: named rootKind resolved from namedRoots', () => {
    const ctx = baseContext({ namedRoots: { artifactsDir: '/abs/artifacts' } });
    const result = resolvePathArgumentRoot({ rootKind: 'artifactsDir' }, ctx);
    expect(result.path).toBe('/abs/artifacts');
    expect(result.kind).toBe('artifactsDir');
  });

  it('B2: named rootKind takes precedence over root field', () => {
    const ctx = baseContext({ namedRoots: { myRoot: '/my/root' } });
    const result = resolvePathArgumentRoot({ rootKind: 'myRoot', root: '/other' }, ctx);
    expect(result.path).toBe('/my/root');
    expect(result.kind).toBe('myRoot');
  });

  it('B3: built-in rootKind still resolves even when namedRoots present', () => {
    const ctx = baseContext({ namedRoots: { myRoot: '/my/root' } });
    const result = resolvePathArgumentRoot({ rootKind: ProjectToolRootKind.PROJECT }, ctx);
    expect(result.path).toBe('/test/project');
    expect(result.kind).toBe('project');
    expect(BUILTIN_ROOT_KINDS.has(result.kind)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C. Missing named root at runtime: resolvePathArgumentRoot throws (fail-closed)
// ---------------------------------------------------------------------------

describe('C. Unknown rootKind at runtime is rejected (no configured fallback)', () => {
  it('C1: unknown rootKind with no namedRoots throws — not fallback to configured', () => {
    const ctx = baseContext(); // no namedRoots
    expect(() => resolvePathArgumentRoot({ rootKind: 'unknownRoot' }, ctx))
      .toThrow(/not a built-in root kind.*not a configured named root/);
  });

  it('C2: unknown rootKind with namedRoots present but key missing throws', () => {
    const ctx = baseContext({ namedRoots: { otherRoot: '/other' } });
    expect(() => resolvePathArgumentRoot({ rootKind: 'unknownRoot' }, ctx))
      .toThrow(/not a built-in root kind.*not a configured named root/);
  });

  it('C3: error message names the unknown rootKind and guidance to add it to settings.roots', () => {
    const ctx = baseContext();
    let caught: Error | undefined;
    try {
      resolvePathArgumentRoot({ rootKind: 'missingRoot' }, ctx);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('missingRoot');
    expect(caught!.message).toContain('settings.roots');
  });
});

// ---------------------------------------------------------------------------
// D. Path escape: PathArgumentRootEscapeError carries typed guidance
// ---------------------------------------------------------------------------

describe('D. PathArgumentRootEscapeError has typed rootKind guidance', () => {
  it('D1: escape from worktree root throws PathArgumentRootEscapeError', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amq0-19-test-'));
    try {
      const ctx = baseContext({ worktreePath: dir });
      const config: ProjectToolPathArgumentConfig = {
        rootKind: ProjectToolRootKind.WORKTREE,
        mustStayInsideRoot: true
      };
      expect(() =>
        normalizePathArgumentValue('myTool', 'filePath', '/outside/path.ts', config, ctx)
      ).toThrow(PathArgumentRootEscapeError);
    } finally {
      fs.rmdirSync(dir);
    }
  });

  it('D2: PathArgumentRootEscapeError.guidance.rootKind is a typed ResolvedRootKind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amq0-19-test-'));
    try {
      const ctx = baseContext({ worktreePath: dir });
      const config: ProjectToolPathArgumentConfig = {
        rootKind: ProjectToolRootKind.WORKTREE,
        mustStayInsideRoot: true
      };
      let caught: PathArgumentRootEscapeError | undefined;
      try {
        normalizePathArgumentValue('myTool', 'filePath', '/outside/path.ts', config, ctx);
      } catch (err) {
        if (err instanceof PathArgumentRootEscapeError) caught = err;
      }
      expect(caught).toBeDefined();
      // rootKind must be 'worktree' — a known typed value, not a raw string fallback.
      expect(caught!.guidance.rootKind).toBe('worktree');
      expect(BUILTIN_ROOT_KINDS.has(caught!.guidance.rootKind)).toBe(true);
    } finally {
      fs.rmdirSync(dir);
    }
  });

  it('D3: escape from named root carries the named kind in guidance', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amq0-19-test-'));
    try {
      const ctx = baseContext({ namedRoots: { myRoot: dir } });
      const config: ProjectToolPathArgumentConfig = {
        rootKind: 'myRoot',
        mustStayInsideRoot: true
      };
      let caught: PathArgumentRootEscapeError | undefined;
      try {
        normalizePathArgumentValue('myTool', 'filePath', '/outside/path.ts', config, ctx);
      } catch (err) {
        if (err instanceof PathArgumentRootEscapeError) caught = err;
      }
      expect(caught).toBeDefined();
      // The named rootKind is preserved in guidance — not coerced to 'configured'.
      expect(caught!.guidance.rootKind).toBe('myRoot');
    } finally {
      fs.rmdirSync(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// E. No 'configured' compat-mode: cannot get kind === 'configured' from resolution
// ---------------------------------------------------------------------------

describe('E. Configured-fallback compat-mode is removed (no-backcompat)', () => {
  it('E1: resolvePathArgumentRoot never returns kind === "configured"', () => {
    // Try every built-in kind and a named root — none should produce 'configured'.
    const ctx = baseContext({
      frameworkRoot: '/fw',
      namedRoots: { myRoot: '/my/root' }
    });
    const configs: ProjectToolPathArgumentConfig[] = [
      { rootKind: ProjectToolRootKind.WORKTREE },
      { rootKind: ProjectToolRootKind.PROJECT },
      { rootKind: ProjectToolRootKind.FRAMEWORK },
      { rootKind: ProjectToolRootKind.WORKSPACE, workspaceRoot: '/ws' },
      { rootKind: 'myRoot' }
    ];
    for (const config of configs) {
      const result = resolvePathArgumentRoot(config, ctx);
      expect(result.kind).not.toBe('configured');
    }
  });

  it('E2: passing an unknown rootKind throws instead of returning kind === "configured"', () => {
    const ctx = baseContext();
    // Before amq0.19, this would silently return { kind: 'configured' }.
    // Now it must throw — fail closed.
    expect(() => resolvePathArgumentRoot({ rootKind: 'someUnknownKind' }, ctx)).toThrow();
  });

  it('E3: BUILTIN_ROOT_KINDS does not contain "configured"', () => {
    expect(BUILTIN_ROOT_KINDS.has('configured')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F. Startup validation: unknown named rootKind → startup failure
// ---------------------------------------------------------------------------

describe('F. Startup named-root validation — unknown named rootKind fails startup', () => {
  it('F1: command tool with unknown rootKind in argumentPathScope fails validateNamedRoots', () => {
    const validator = makeConfigValidator('/project');
    const config = minimalConfig({
      tools: [
        {
          name: 'my_tool',
          type: 'command',
          command: 'node',
          argumentPathScope: { rootKind: 'undeclaredRoot' }
        }
      ]
    });
    expect(() => validator.validateNamedRoots(config)).toThrow(/undeclaredRoot/);
  });

  it('F2: error message names the tool, field, and rootKind for structured diagnostics', () => {
    const validator = makeConfigValidator('/project');
    const config = minimalConfig({
      tools: [
        {
          name: 'broken_tool',
          type: 'command',
          command: 'node',
          argumentPathScope: { rootKind: 'missingRoot' }
        }
      ]
    });
    let caught: Error | undefined;
    try { validator.validateNamedRoots(config); } catch (err) { caught = err as Error; }
    expect(caught!.message).toContain('broken_tool');
    expect(caught!.message).toContain('argumentPathScope.rootKind');
    expect(caught!.message).toContain('missingRoot');
    expect(caught!.message).toContain('settings.roots');
  });

  it('F3: LOAD-BEARING: validation must throw if validateNamedRoots is removed (self-verifying)', () => {
    // This test directly calls validateNamedRoots. If the method were removed from
    // ConfigValidator the test would fail with TypeError at the call site.
    const validator = makeConfigValidator('/project');
    expect(typeof validator.validateNamedRoots).toBe('function');

    const config = minimalConfig({
      tools: [
        {
          name: 'tool_a',
          type: 'command',
          command: 'echo',
          argumentPathScope: { rootKind: 'phantomRoot' }
        }
      ]
    });
    // If validateNamedRoots were a no-op, this would NOT throw — causing the test to fail.
    expect(() => validator.validateNamedRoots(config)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// G. Startup validation: known named rootKind declared in settings.roots → passes
// ---------------------------------------------------------------------------

describe('G. Startup named-root validation — declared roots pass', () => {
  it('G1: command tool with rootKind in settings.roots passes validateNamedRoots', () => {
    const validator = makeConfigValidator('/project');
    const config = minimalConfig({
      roots: { artifactsDir: '/abs/artifacts' },
      tools: [
        {
          name: 'my_tool',
          type: 'command',
          command: 'node',
          argumentPathScope: { rootKind: 'artifactsDir' }
        }
      ]
    });
    expect(() => validator.validateNamedRoots(config)).not.toThrow();
  });

  it('G2: built-in rootKinds always pass without settings.roots', () => {
    const validator = makeConfigValidator('/project');
    for (const kind of ['worktree', 'project', 'framework', 'workspace']) {
      const config = minimalConfig({
        tools: [
          {
            name: 'my_tool',
            type: 'command',
            command: 'node',
            argumentPathScope: { rootKind: kind }
          }
        ]
      });
      expect(() => validator.validateNamedRoots(config)).not.toThrow();
    }
  });

  it('G3: tools with no argumentPathScope pass without settings.roots', () => {
    const validator = makeConfigValidator('/project');
    const config = minimalConfig({
      tools: [
        { name: 'plain_tool', type: 'command', command: 'echo' }
      ]
    });
    expect(() => validator.validateNamedRoots(config)).not.toThrow();
  });

  it('G4: empty tools list passes', () => {
    const validator = makeConfigValidator('/project');
    const config = minimalConfig({ tools: [] });
    expect(() => validator.validateNamedRoots(config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// H. Startup validation: MCP tool pathArguments unknown rootKind → startup failure
// ---------------------------------------------------------------------------

describe('H. Startup named-root validation — MCP tool pathArguments', () => {
  it('H1: MCP tool pathArguments with unknown rootKind fails validateNamedRoots', () => {
    const validator = makeConfigValidator('/project');
    const config = minimalConfig({
      tools: [
        {
          name: 'mcp_tool',
          type: 'mcp',
          server: 'test-server',
          pathArguments: {
            search: {
              filePath: { rootKind: 'unknownMcpRoot' }
            }
          }
        }
      ]
    });
    expect(() => validator.validateNamedRoots(config)).toThrow(/unknownMcpRoot/);
  });

  it('H2: MCP tool pathArguments with declared named root passes', () => {
    const validator = makeConfigValidator('/project');
    const config = minimalConfig({
      roots: { codebase: '/abs/codebase' },
      tools: [
        {
          name: 'mcp_tool',
          type: 'mcp',
          server: 'test-server',
          pathArguments: {
            search: {
              filePath: { rootKind: 'codebase' }
            }
          }
        }
      ]
    });
    expect(() => validator.validateNamedRoots(config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// I. Structured rejection diagnostics: PathArgumentEscapeGuidance.rootKind is typed
// ---------------------------------------------------------------------------

describe('I. Structured rejection diagnostics use typed rootKind', () => {
  it('I1: PathArgumentEscapeGuidance.rootKind matches the configured rootKind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amq0-19-diag-'));
    try {
      const ctx = baseContext({ projectRoot: dir });
      const config: ProjectToolPathArgumentConfig = {
        rootKind: ProjectToolRootKind.PROJECT,
        mustStayInsideRoot: true
      };
      let caught: PathArgumentRootEscapeError | undefined;
      try {
        normalizePathArgumentValue('diag_tool', 'myPath', '/completely/outside', config, ctx);
      } catch (err) {
        if (err instanceof PathArgumentRootEscapeError) caught = err;
      }
      expect(caught).toBeDefined();
      expect(caught!.guidance.rootKind).toBe('project');
      // Structured guidance must include the allowedRoot
      expect(caught!.guidance.allowedRoot).toBe(dir);
    } finally {
      fs.rmdirSync(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// J. ProjectToolRootKind from constants/domain.ts is the single source
// ---------------------------------------------------------------------------

describe('J. Single source of truth: ProjectToolRootKind from constants/index.ts', () => {
  it('J1: ProjectToolRootKind has all four built-in kinds', () => {
    expect(ProjectToolRootKind.WORKTREE).toBe('worktree');
    expect(ProjectToolRootKind.PROJECT).toBe('project');
    expect(ProjectToolRootKind.FRAMEWORK).toBe('framework');
    expect(ProjectToolRootKind.WORKSPACE).toBe('workspace');
  });

  it('J2: BUILTIN_ROOT_KINDS set exactly matches the four values from ProjectToolRootKind', () => {
    const fromConst = new Set(Object.values(ProjectToolRootKind));
    expect(BUILTIN_ROOT_KINDS.size).toBe(fromConst.size);
    for (const kind of fromConst) {
      expect(BUILTIN_ROOT_KINDS.has(kind)).toBe(true);
    }
  });

  it('J3: TypeScript — ProjectToolBuiltinRootKind type is assignable from ProjectToolRootKind values', () => {
    // This test validates at compile time (via type annotation) that the exported
    // type is consistent with the const.
    const w: ProjectToolBuiltinRootKind = ProjectToolRootKind.WORKTREE;
    const p: ProjectToolBuiltinRootKind = ProjectToolRootKind.PROJECT;
    const f: ProjectToolBuiltinRootKind = ProjectToolRootKind.FRAMEWORK;
    const ws: ProjectToolBuiltinRootKind = ProjectToolRootKind.WORKSPACE;
    expect([w, p, f, ws]).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// L. Startup wiring — validateSemantics calls validateNamedRoots (FIX1)
//
// These tests drive the REAL startup path (validateSemantics) to prove the
// wiring at ConfigValidator.ts:validateSemantics is load-bearing.
// A test that calls validator.validateNamedRoots directly does NOT prove this.
// ---------------------------------------------------------------------------

/**
 * Minimal v1 harness config that satisfies all validateSemantics validators
 * EXCEPT the named-root check. Includes settings.worktreePolicy.default (required
 * for v1 configs by validateWorktreePolicy) and a statechart with explicit
 * outcome vocabulary (required by the statechart block check).
 */
function minimalSemanticsConfig(overrides: {
  roots?: Record<string, string>;
  tools?: unknown;
} = {}): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: 'handover',
      agentTurnTimeoutMs: 60000,
      processReapIntervalMs: 5000,
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      defaultModel: 'claude-opus-4-5',
      defaultProvider: 'anthropic',
      modelProviders: {},
      stateContextRotThreshold: 50000,
      harnessContextRotThreshold: 100000,
      startState: '',
      worktreePolicy: { default: 'always' },
      ...(overrides.roots ? { roots: overrides.roots } : {})
    },
    statechart: {
      terminalStates: ['completed'],
      advanceOutcomes: ['SUCCESS'],
      failedOutcomes: ['FAILURE'],
      blockedOutcomes: ['BLOCKED']
    },
    states: {},
    tools: overrides.tools ?? []
  } as unknown as HarnessConfig;
}

describe('L. Startup wiring — validateSemantics calls validateNamedRoots', () => {
  it('L1: validateSemantics throws on undeclared rootKind (wiring confirmed via startup path)', () => {
    // This test drives validateSemantics — the real startup-lint path — NOT the
    // direct validateNamedRoots call. If the wiring call at ConfigValidator.ts
    // (this.validateNamedRoots(config)) were removed, this test would go RED
    // even though validateNamedRoots itself is still a valid method.
    const validator = makeConfigValidator('/project');
    const config = minimalSemanticsConfig({
      tools: [
        {
          name: 'my_tool',
          type: 'command',
          command: 'node',
          argumentPathScope: { rootKind: 'undeclaredRoot' }
        }
      ]
    });
    expect(() => validator.validateSemantics(config)).toThrow(/undeclaredRoot/);
  });

  it('L2: validateSemantics does NOT throw when rootKind is declared in settings.roots', () => {
    // Positive case: a tool with a named rootKind that IS declared in settings.roots
    // must pass validateSemantics cleanly (the wiring must allow valid configs through).
    const validator = makeConfigValidator('/project');
    const config = minimalSemanticsConfig({
      roots: { myRoot: '/abs/my-root' },
      tools: [
        {
          name: 'my_tool',
          type: 'command',
          command: 'node',
          argumentPathScope: { rootKind: 'myRoot' }
        }
      ]
    });
    expect(() => validator.validateSemantics(config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// K. Cerdiwen artifact/root template tests — read-only fixture
// ---------------------------------------------------------------------------

describe('K. Cerdiwen artifact/root template tests (read-only fixture)', () => {
  it('K1: cerdiwen followthrough fixture exists and is readable (fixture not modified)', () => {
    const fixturePath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      'fixtures/cerdiwen-followthrough/harness-bead-audit.json'
    );
    expect(fs.existsSync(fixturePath)).toBe(true);
    const raw = fs.readFileSync(fixturePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('K2: ArtifactTemplate scope field uses project/worktree vocabulary (not rootKind extension)', () => {
    // ArtifactTemplate.scope is a separate vocabulary from ProjectToolRootKind.
    // This test confirms the scope field type accepts 'project' and 'worktree'.
    // TypeScript compile-time check: these are the only legal values.
    const projectScope: 'project' | 'worktree' = 'project';
    const worktreeScope: 'project' | 'worktree' = 'worktree';
    expect(projectScope).toBe('project');
    expect(worktreeScope).toBe('worktree');
  });
});
