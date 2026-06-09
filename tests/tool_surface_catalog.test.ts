/**
 * pi-experiment-amq0.15 — ToolSurfaceCatalog conformance tests.
 *
 * COVERAGE
 * --------
 * 1. Catalog shape: all BuiltInToolName, PluginToolName, NativePiToolName
 *    appear with the correct kind in a catalog built from an empty config.
 * 2. COMMAND vs TOOL distinction: orr-else is COMMAND; all other BuiltInToolNames
 *    are BUILTIN_TOOL. COMMAND entries cannot appear in setActiveTools or requiredTools.
 * 3. Fail-closed startup checks:
 *    - Duplicate tool name → validate() returns violation
 *    - Command/tool collision → validate() returns violation
 *    - Missing sourceInfo for non-observeOnly EXTENSION_TOOL → validate() returns violation
 * 4. Consumer wiring proofs (load-bearing):
 *    - Proof A: marking a catalog entry hidden changes getAdmissibleRequiredToolNames()
 *    - Proof B: a COMMAND name in requiredTools is rejected by validateRequiredToolsNotCommands()
 * 5. RTK inventory: checkRtkInventoryCoverageFromCatalog covers all static tools.
 * 6. Cerdiwen fixture admission: cerdiwen harness.yaml project tools + extension-registered
 *    callbacks are admitted consistently (read-only cerdiwen access; no cerdiwen edits).
 * 7. Startup fingerprint: computeSurfaceFingerprint is deterministic and changes when
 *    a new tool is added.
 * 8. getConfiguredPiToolNames derives correctly from settings.pi.tools (not overlapping with defaults).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  buildToolSurfaceCatalog,
  assertCatalogValid,
  checkRequiredToolsForCommandCollisions,
  ToolSurfaceCatalog,
  type ToolSurfaceEntry,
} from '../src/core/ToolSurfaceCatalog.js';
import { validateRequiredToolVerifiers, validateRequiredToolsNotCommands } from '../src/core/CoordinatorVerifierGate.js';
import { checkRtkInventoryCoverageFromCatalog } from '../src/core/RtkContract.js';
import {
  BuiltInToolName,
  DEFAULT_OBSERVED_PI_TOOLS,
  NativePiToolName,
  PluginToolName,
} from '../src/constants/index.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal HarnessConfig with no project tools. */
function emptyConfig(): HarnessConfig {
  return {
    version: 1,
    settings: {
      startState: 'Planning',
      worktreePolicy: { default: 'always' },
    },
    states: {},
    tools: [],
  } as unknown as HarnessConfig;
}

/** Build a catalog from an empty config (no project tools). */
function emptyCatalog(): ToolSurfaceCatalog {
  return buildToolSurfaceCatalog(emptyConfig(), [], []);
}

// ---------------------------------------------------------------------------
// 1. Catalog shape
// ---------------------------------------------------------------------------

describe('ToolSurfaceCatalog — shape from empty config', () => {
  it('contains one COMMAND entry for orr-else', () => {
    const catalog = emptyCatalog();
    const cmd = catalog.getCommandEntries();
    expect(cmd).toHaveLength(1);
    expect(cmd[0].name).toBe(BuiltInToolName.ORR_ELSE);
    expect(cmd[0].kind).toBe('COMMAND');
    expect(cmd[0].callable).toBe(false);
    expect(cmd[0].admissibleForRequiredTools).toBe(false);
  });

  it('contains BUILTIN_TOOL entries for all BuiltInToolNames except orr-else', () => {
    const catalog = emptyCatalog();
    const toolNames = new Set(catalog.getToolEntries().map(e => e.name));
    for (const name of Object.values(BuiltInToolName)) {
      if (name === BuiltInToolName.ORR_ELSE) {
        // orr-else is COMMAND, not TOOL
        expect(toolNames.has(name), `${name} should NOT be in tool entries`).toBe(false);
      } else {
        expect(toolNames.has(name), `${name} should be in tool entries`).toBe(true);
      }
    }
  });

  it('contains PLUGIN_TOOL entries for all PluginToolNames', () => {
    const catalog = emptyCatalog();
    const toolNames = new Set(catalog.getToolEntries().map(e => e.name));
    for (const name of Object.values(PluginToolName)) {
      expect(toolNames.has(name), `PluginToolName ${name} should be in tool entries`).toBe(true);
    }
  });

  it('contains NATIVE_PI_TOOL entries for all DEFAULT_OBSERVED_PI_TOOLS', () => {
    const catalog = emptyCatalog();
    const toolNames = new Set(catalog.getToolEntries().map(e => e.name));
    for (const name of DEFAULT_OBSERVED_PI_TOOLS) {
      expect(toolNames.has(name), `DEFAULT_OBSERVED_PI_TOOLS ${name} should be in tool entries`).toBe(true);
    }
  });

  it('all BUILTIN_TOOL entries (except orr-else) have callable=true', () => {
    const catalog = emptyCatalog();
    const builtIns = catalog.getToolEntries().filter(e => e.kind === 'BUILTIN_TOOL');
    expect(builtIns.length).toBeGreaterThan(0);
    for (const e of builtIns) {
      expect(e.callable, `${e.name} should be callable`).toBe(true);
    }
  });

  it('all PLUGIN_TOOL entries have rtkToolClass=plugin', () => {
    const catalog = emptyCatalog();
    const plugins = catalog.getToolEntries().filter(e => e.kind === 'PLUGIN_TOOL');
    expect(plugins.length).toBeGreaterThan(0);
    for (const e of plugins) {
      expect(e.rtkToolClass).toBe('plugin');
    }
  });

  it('all NATIVE_PI_TOOL entries have rtkToolClass=native_pi', () => {
    const catalog = emptyCatalog();
    const natives = catalog.getToolEntries().filter(e => e.kind === 'NATIVE_PI_TOOL');
    expect(natives.length).toBeGreaterThan(0);
    for (const e of natives) {
      expect(e.rtkToolClass).toBe('native_pi');
    }
  });

  it('validate() returns no violations for the empty catalog', () => {
    const violations = emptyCatalog().validate();
    expect(violations).toHaveLength(0);
  });

  it('assertCatalogValid does not throw for the empty catalog', () => {
    expect(() => assertCatalogValid(emptyCatalog())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. COMMAND vs TOOL distinction
// ---------------------------------------------------------------------------

describe('ToolSurfaceCatalog — COMMAND vs TOOL distinction (pi-experiment-2xho)', () => {
  it('orr-else is in getCommandNames() but NOT in getCallableToolNames()', () => {
    const catalog = emptyCatalog();
    expect(catalog.getCommandNames().has(BuiltInToolName.ORR_ELSE)).toBe(true);
    expect(catalog.getCallableToolNames().has(BuiltInToolName.ORR_ELSE)).toBe(false);
  });

  it('orr-else is NOT in getAdmissibleRequiredToolNames()', () => {
    const catalog = emptyCatalog();
    expect(catalog.getAdmissibleRequiredToolNames().has(BuiltInToolName.ORR_ELSE)).toBe(false);
  });

  it('tick_items is in getCallableToolNames() but NOT in getCommandNames()', () => {
    const catalog = emptyCatalog();
    expect(catalog.getCallableToolNames().has(BuiltInToolName.TICK_ITEMS)).toBe(true);
    expect(catalog.getCommandNames().has(BuiltInToolName.TICK_ITEMS)).toBe(false);
  });

  it('checkRequiredToolsForCommandCollisions flags a COMMAND name in requiredTools', () => {
    const catalog = emptyCatalog();
    const violations = checkRequiredToolsForCommandCollisions(
      [BuiltInToolName.ORR_ELSE, BuiltInToolName.TICK_ITEMS],
      catalog,
      'State "Planning"'
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(BuiltInToolName.ORR_ELSE);
    expect(violations[0]).toContain('COMMAND');
  });

  it('checkRequiredToolsForCommandCollisions is clean for model-callable tool names', () => {
    const catalog = emptyCatalog();
    const violations = checkRequiredToolsForCommandCollisions(
      [BuiltInToolName.TICK_ITEMS, BuiltInToolName.GET_ARTIFACT_PATHS, NativePiToolName.BASH],
      catalog,
      'State "Planning"'
    );
    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Fail-closed startup checks
// ---------------------------------------------------------------------------

describe('ToolSurfaceCatalog — fail-closed startup checks', () => {
  it('validate() detects duplicate tool names', () => {
    // Build a catalog where two entries share the same name (direct constructor call)
    const entries: ToolSurfaceEntry[] = [
      {
        name: 'my_tool',
        kind: 'BUILTIN_TOOL',
        owner: 'test',
        sourceInfo: '',
        callable: true,
        admissibleForRequiredTools: true,
        hidden: false,
        deprecated: false,
        observeOnly: false,
        rtkToolClass: 'built_in',
        sideEffectContract: 'read_only',
        configEntry: undefined,
      },
      {
        name: 'my_tool', // duplicate!
        kind: 'PLUGIN_TOOL',
        owner: 'test',
        sourceInfo: '',
        callable: true,
        admissibleForRequiredTools: false,
        hidden: false,
        deprecated: false,
        observeOnly: false,
        rtkToolClass: 'plugin',
        sideEffectContract: 'read_only',
        configEntry: undefined,
      },
    ];
    const catalog = new ToolSurfaceCatalog(entries);
    const violations = catalog.validate();
    expect(violations.some(v => v.kind === 'DUPLICATE_NAME')).toBe(true);
    expect(violations.some(v => v.name === 'my_tool')).toBe(true);
  });

  it('validate() detects command/tool name collision', () => {
    // A COMMAND and a BUILTIN_TOOL share the same name
    const entries: ToolSurfaceEntry[] = [
      {
        name: 'my_cmd',
        kind: 'COMMAND',
        owner: 'test',
        sourceInfo: '',
        callable: false,
        admissibleForRequiredTools: false,
        hidden: false,
        deprecated: false,
        observeOnly: false,
        rtkToolClass: undefined,
        sideEffectContract: 'read_only',
        configEntry: undefined,
      },
      {
        name: 'my_cmd', // collision!
        kind: 'BUILTIN_TOOL',
        owner: 'test',
        sourceInfo: '',
        callable: true,
        admissibleForRequiredTools: true,
        hidden: false,
        deprecated: false,
        observeOnly: false,
        rtkToolClass: 'built_in',
        sideEffectContract: 'read_only',
        configEntry: undefined,
      },
    ];
    const catalog = new ToolSurfaceCatalog(entries);
    const violations = catalog.validate();
    expect(violations.some(v => v.kind === 'COMMAND_TOOL_COLLISION')).toBe(true);
    expect(violations.some(v => v.name === 'my_cmd')).toBe(true);
  });

  it('validate() detects missing sourceInfo for non-observeOnly EXTENSION_TOOL', () => {
    const entries: ToolSurfaceEntry[] = [
      {
        name: 'my_ext',
        kind: 'EXTENSION_TOOL',
        owner: 'harness.yaml',
        sourceInfo: '', // missing!
        callable: true,
        admissibleForRequiredTools: true,
        hidden: false,
        deprecated: false,
        observeOnly: false, // non-observeOnly → must have sourceInfo
        rtkToolClass: 'project_configured',
        sideEffectContract: 'unknown',
        configEntry: undefined,
      },
    ];
    const catalog = new ToolSurfaceCatalog(entries);
    const violations = catalog.validate();
    expect(violations.some(v => v.kind === 'MISSING_SOURCE_INFO')).toBe(true);
    expect(violations.some(v => v.name === 'my_ext')).toBe(true);
  });

  it('validate() does NOT flag OBSERVE_ONLY entries for missing sourceInfo', () => {
    const entries: ToolSurfaceEntry[] = [
      {
        name: 'my_obs',
        kind: 'OBSERVE_ONLY',
        owner: 'harness.yaml',
        sourceInfo: '', // observeOnly → sourceInfo not required
        callable: false,
        admissibleForRequiredTools: false,
        hidden: false,
        deprecated: false,
        observeOnly: true,
        rtkToolClass: 'project_configured',
        sideEffectContract: 'unknown',
        configEntry: undefined,
      },
    ];
    const catalog = new ToolSurfaceCatalog(entries);
    const violations = catalog.validate();
    expect(violations).toHaveLength(0);
  });

  it('validateRequiredToolsNotCommands throws when a COMMAND name appears in requiredTools', () => {
    const catalog = emptyCatalog();
    const config = {
      ...emptyConfig(),
      states: {
        Planning: {
          actions: [{ id: 'plan', prompt: 'plan' }],
          requiredTools: [BuiltInToolName.ORR_ELSE], // ← COMMAND, not tool
        }
      }
    } as unknown as HarnessConfig;

    expect(() => validateRequiredToolsNotCommands(config, catalog)).toThrow(/COMMAND surface/);
    expect(() => validateRequiredToolsNotCommands(config, catalog)).toThrow(BuiltInToolName.ORR_ELSE);
  });

  it('validateRequiredToolsNotCommands does not throw for model-callable tool names', () => {
    const catalog = emptyCatalog();
    const config = {
      ...emptyConfig(),
      states: {
        Planning: {
          actions: [{ id: 'plan', prompt: 'plan' }],
          requiredTools: [BuiltInToolName.TICK_ITEMS, NativePiToolName.BASH],
        }
      }
    } as unknown as HarnessConfig;

    expect(() => validateRequiredToolsNotCommands(config, catalog)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Consumer wiring proofs (load-bearing)
//    A mutation to a catalog entry MUST change the corresponding consumer behavior.
// ---------------------------------------------------------------------------

describe('ToolSurfaceCatalog — consumer wiring proofs', () => {

  /**
   * PROOF A: getAdmissibleRequiredToolNames() reads from catalog entries.
   *
   * Build two catalogs: one where tick_items is admissible (normal), one where
   * tick_items is a COMMAND (not admissible). The set must change.
   */
  it('PROOF A: getAdmissibleRequiredToolNames() changes when entry.admissibleForRequiredTools changes', () => {
    // Normal catalog: tick_items is admissible
    const normalCatalog = emptyCatalog();
    expect(normalCatalog.getAdmissibleRequiredToolNames().has(BuiltInToolName.TICK_ITEMS)).toBe(true);

    // Mutated catalog: reclassify tick_items as a COMMAND (not admissible)
    const entries: ToolSurfaceEntry[] = [
      {
        name: BuiltInToolName.TICK_ITEMS,
        kind: 'COMMAND', // ← mutated kind
        owner: 'test',
        sourceInfo: '',
        callable: false,
        admissibleForRequiredTools: false, // ← mutated
        hidden: false,
        deprecated: false,
        observeOnly: false,
        rtkToolClass: undefined,
        sideEffectContract: 'read_only',
        configEntry: undefined,
      },
    ];
    const mutatedCatalog = new ToolSurfaceCatalog(entries);
    expect(mutatedCatalog.getAdmissibleRequiredToolNames().has(BuiltInToolName.TICK_ITEMS)).toBe(false);
  });

  /**
   * PROOF B: validateRequiredToolsNotCommands reads from catalog.getCommandNames().
   *
   * A tool that is NOT a command passes; a tool that IS a command is rejected.
   */
  it('PROOF B: validateRequiredToolsNotCommands fails when the catalog marks a name as COMMAND', () => {
    // Build a catalog where 'my_special_tool' is a COMMAND
    const entries: ToolSurfaceEntry[] = [
      {
        name: 'my_special_tool',
        kind: 'COMMAND',
        owner: 'test',
        sourceInfo: '',
        callable: false,
        admissibleForRequiredTools: false,
        hidden: false,
        deprecated: false,
        observeOnly: false,
        rtkToolClass: undefined,
        sideEffectContract: 'read_only',
        configEntry: undefined,
      },
    ];
    const catalogWithCommand = new ToolSurfaceCatalog(entries);

    const config = {
      ...emptyConfig(),
      states: {
        Planning: {
          actions: [],
          requiredTools: ['my_special_tool'], // this name is a COMMAND in the catalog
        }
      }
    } as unknown as HarnessConfig;

    // With catalog: should throw
    expect(() => validateRequiredToolsNotCommands(config, catalogWithCommand)).toThrow(/COMMAND/);

    // Without the command in the catalog: should not throw
    const toolCatalog = new ToolSurfaceCatalog([
      {
        name: 'my_special_tool',
        kind: 'BUILTIN_TOOL', // now a tool, not a command
        owner: 'test',
        sourceInfo: '',
        callable: true,
        admissibleForRequiredTools: true,
        hidden: false,
        deprecated: false,
        observeOnly: false,
        rtkToolClass: 'built_in',
        sideEffectContract: 'read_only',
        configEntry: undefined,
      },
    ]);
    expect(() => validateRequiredToolsNotCommands(config, toolCatalog)).not.toThrow();
  });

  /**
   * PROOF C: getObservedPiToolNames() is derived from catalog entries.
   *
   * Adding a NATIVE_PI_TOOL entry changes the observed set.
   */
  it('PROOF C: getObservedPiToolNames() changes when a new NATIVE_PI_TOOL entry is added', () => {
    const catalog = emptyCatalog();
    const defaultObservedNames = new Set(DEFAULT_OBSERVED_PI_TOOLS);

    // Default catalog observed tools should include all DEFAULT_OBSERVED_PI_TOOLS
    const observed = catalog.getObservedPiToolNames();
    for (const name of DEFAULT_OBSERVED_PI_TOOLS) {
      expect(observed.has(name), `${name} should be in observed set`).toBe(true);
    }

    // A catalog built with an extra pi tool name should include it in observed set
    const extraToolName = '__test_extra_pi_tool__';
    const catalogWithExtra = buildToolSurfaceCatalog(emptyConfig(), [], [extraToolName]);
    expect(catalogWithExtra.getObservedPiToolNames().has(extraToolName)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. RTK inventory: checkRtkInventoryCoverageFromCatalog
// ---------------------------------------------------------------------------

describe('ToolSurfaceCatalog — RTK inventory coverage from catalog', () => {
  it('checkRtkInventoryCoverageFromCatalog returns no violations for the empty catalog', () => {
    const catalog = emptyCatalog();
    const violations = checkRtkInventoryCoverageFromCatalog(catalog);
    if (violations.length > 0) {
      const msgs = violations.map(v => v.message).join('\n');
      throw new Error(`RTK inventory violations from catalog:\n${msgs}`);
    }
    expect(violations).toHaveLength(0);
  });

  it('checkRtkInventoryCoverageFromCatalog reports violation for an unknown static tool', () => {
    // Build a catalog with a custom BUILTIN_TOOL entry that has no RTK inventory entry
    const entries: ToolSurfaceEntry[] = [
      {
        name: '__nonexistent_tool_for_rtk_test__',
        kind: 'BUILTIN_TOOL',
        owner: 'test',
        sourceInfo: '',
        callable: true,
        admissibleForRequiredTools: true,
        hidden: false,
        deprecated: false,
        observeOnly: false,
        rtkToolClass: 'built_in',
        sideEffectContract: 'read_only',
        configEntry: undefined,
      },
    ];
    const catalog = new ToolSurfaceCatalog(entries);
    const violations = checkRtkInventoryCoverageFromCatalog(catalog);
    expect(violations).toHaveLength(1);
    expect(violations[0].toolName).toBe('__nonexistent_tool_for_rtk_test__');
  });

  it('project_configured tools are excluded from RTK catalog coverage check', () => {
    // project_configured tools don't appear in the static RTK_INVENTORY; they're config-driven
    const entries: ToolSurfaceEntry[] = [
      {
        name: 'run_tests',
        kind: 'PROJECT_TOOL',
        owner: 'harness.yaml',
        sourceInfo: '',
        callable: true,
        admissibleForRequiredTools: true,
        hidden: false,
        deprecated: false,
        observeOnly: false,
        rtkToolClass: 'project_configured',
        sideEffectContract: 'unknown',
        configEntry: undefined,
      },
    ];
    const catalog = new ToolSurfaceCatalog(entries);
    const violations = checkRtkInventoryCoverageFromCatalog(catalog);
    // project_configured should be excluded → no violation
    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Cerdiwen fixture admission: project tools + extension callbacks
//    Read-only cerdiwen access. NO cerdiwen edits.
// ---------------------------------------------------------------------------

describe('ToolSurfaceCatalog — Cerdiwen fixture admission (read-only)', () => {
  const CERDIWEN_ROOT = '/Users/aidan/dev/bankwest/cerdiwen';
  const CERDIWEN_HARNESS_YAML = path.join(CERDIWEN_ROOT, 'harness.yaml');

  const cerdiwenExists = fs.existsSync(CERDIWEN_HARNESS_YAML);

  it.skipIf(!cerdiwenExists)('cerdiwen harness.yaml exists for fixture test', () => {
    expect(cerdiwenExists).toBe(true);
  });

  it.skipIf(!cerdiwenExists)(
    'cerdiwen project tools are admitted consistently via catalog (no observeOnly collisions)',
    () => {
      const raw = fs.readFileSync(CERDIWEN_HARNESS_YAML, 'utf-8');
      const parsed = parseYaml(raw) as { tools?: Array<{ name: string; type?: string; observeOnly?: boolean }> };
      const tools = parsed.tools || [];

      // Build a minimal config from cerdiwen's tool declarations
      const minimalConfig = {
        ...emptyConfig(),
        tools: tools as any,
      } as HarnessConfig;

      // The catalog should build without throwing
      let catalog: ToolSurfaceCatalog;
      expect(() => {
        catalog = buildToolSurfaceCatalog(minimalConfig, [], []);
      }).not.toThrow();

      // All non-observeOnly project tools should be admitted (PROJECT_TOOL or EXTENSION_TOOL)
      const projectTools = tools.filter((t: any) => !t.observeOnly);
      const harnessRegistered = catalog!.getHarnessRegisteredProjectToolNames();
      const extensionTools = catalog!.getNativePiExtensionProjectToolNames();
      const allCatalogProjectNames = new Set([...harnessRegistered, ...extensionTools]);

      for (const tool of projectTools) {
        if (tool.type === 'extension') {
          // Extension tools go into EXTENSION_TOOL (or OBSERVE_ONLY if observeOnly)
          // non-observeOnly extension tools: in getNativePiExtensionProjectToolNames
          expect(
            extensionTools.includes(tool.name) || allCatalogProjectNames.has(tool.name),
            `cerdiwen extension tool "${tool.name}" should be in catalog`
          ).toBe(true);
        } else {
          // COMMAND or MCP tools go into PROJECT_TOOL
          expect(
            harnessRegistered.includes(tool.name),
            `cerdiwen project tool "${tool.name}" should be in catalog harness-registered tools`
          ).toBe(true);
        }
      }
    }
  );

  it.skipIf(!cerdiwenExists)(
    'cerdiwen requiredTools entries are not COMMAND names (catalog-based admission)',
    () => {
      const raw = fs.readFileSync(CERDIWEN_HARNESS_YAML, 'utf-8');
      const parsed = parseYaml(raw) as {
        tools?: Array<{ name: string; type?: string; observeOnly?: boolean }>;
        states?: Record<string, { requiredTools?: Array<string | { name: string }> }>;
      };

      const minimalConfig = {
        ...emptyConfig(),
        tools: (parsed.tools || []) as any,
        states: (parsed.states || {}) as any,
      } as HarnessConfig;

      const catalog = buildToolSurfaceCatalog(minimalConfig, [], []);

      // Collect all cerdiwen requiredTool names
      const allRequiredNames: string[] = [];
      for (const state of Object.values(parsed.states || {})) {
        for (const rt of state.requiredTools || []) {
          const name = typeof rt === 'string' ? rt : (rt as any).name;
          if (name) allRequiredNames.push(name);
        }
      }

      // The catalog's command names should NOT overlap with cerdiwen's requiredTools
      const commandNames = catalog.getCommandNames();
      const requiredInCatalogCommands = allRequiredNames.filter(n => commandNames.has(n));
      expect(
        requiredInCatalogCommands,
        `cerdiwen requiredTools should not contain COMMAND names: ${requiredInCatalogCommands.join(', ')}`
      ).toHaveLength(0);
    }
  );

  it.skipIf(!cerdiwenExists)(
    'cerdiwen observeOnly tools are in OBSERVE_ONLY kind (not PROJECT_TOOL or EXTENSION_TOOL)',
    () => {
      const raw = fs.readFileSync(CERDIWEN_HARNESS_YAML, 'utf-8');
      const parsed = parseYaml(raw) as {
        tools?: Array<{ name: string; type?: string; observeOnly?: boolean }>;
      };
      const observeOnlyTools = (parsed.tools || []).filter((t: any) => t.observeOnly);

      if (observeOnlyTools.length === 0) {
        // No observeOnly tools in cerdiwen → trivially passes
        return;
      }

      const minimalConfig = {
        ...emptyConfig(),
        tools: (parsed.tools || []) as any,
      } as HarnessConfig;

      const catalog = buildToolSurfaceCatalog(minimalConfig, [], []);

      for (const tool of observeOnlyTools) {
        const entry = catalog.get(tool.name);
        expect(entry, `observeOnly tool "${tool.name}" should be in catalog`).toBeDefined();
        expect(entry!.kind).toBe('OBSERVE_ONLY');
        expect(entry!.admissibleForRequiredTools).toBe(false);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// 7. Startup fingerprint determinism
// ---------------------------------------------------------------------------

describe('ToolSurfaceCatalog — startup fingerprint', () => {
  it('computeSurfaceFingerprint is deterministic for the same catalog', () => {
    const a = emptyCatalog().computeSurfaceFingerprint();
    const b = emptyCatalog().computeSurfaceFingerprint();
    expect(a).toBe(b);
  });

  it('computeSurfaceFingerprint changes when a new tool is added via settings.pi.tools', () => {
    const base = emptyCatalog().computeSurfaceFingerprint();
    const withExtra = buildToolSurfaceCatalog(emptyConfig(), ['__extra_pi_tool__'], []).computeSurfaceFingerprint();
    expect(withExtra).not.toBe(base);
  });

  it('computeSurfaceFingerprint changes when a project tool is added', () => {
    const base = emptyCatalog().computeSurfaceFingerprint();
    const configWithTool = {
      ...emptyConfig(),
      tools: [{ name: 'my_project_tool', type: 'command', command: 'echo' }] as any,
    } as HarnessConfig;
    const withTool = buildToolSurfaceCatalog(configWithTool, [], []).computeSurfaceFingerprint();
    expect(withTool).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// 8. getConfiguredPiToolNames from settings.pi.tools
// ---------------------------------------------------------------------------

describe('ToolSurfaceCatalog — getConfiguredPiToolNames', () => {
  it('returns empty array when no pi.tools configured', () => {
    const catalog = emptyCatalog();
    expect(catalog.getConfiguredPiToolNames()).toHaveLength(0);
  });

  it('returns configured pi.tools names', () => {
    const catalog = buildToolSurfaceCatalog(emptyConfig(), ['search', 'codemap'], []);
    const names = catalog.getConfiguredPiToolNames();
    expect(names).toContain('search');
    expect(names).toContain('codemap');
  });

  it('includes names that overlap with DEFAULT_OBSERVED_PI_TOOLS (bash is both default-observed and configured)', () => {
    // bash is in DEFAULT_OBSERVED_PI_TOOLS; if a project also lists it in pi.tools,
    // getConfiguredPiToolNames should still return it
    const catalog = buildToolSurfaceCatalog(emptyConfig(), [NativePiToolName.BASH, 'extra_tool'], []);
    const names = catalog.getConfiguredPiToolNames();
    expect(names).toContain(NativePiToolName.BASH);
    expect(names).toContain('extra_tool');
  });
});

// ---------------------------------------------------------------------------
// 9. getWrappedToolNames — replaces the old wrappedToolNames Set
// ---------------------------------------------------------------------------

describe('ToolSurfaceCatalog — getWrappedToolNames', () => {
  it('includes all BUILTIN_TOOL names', () => {
    const wrapped = emptyCatalog().getWrappedToolNames();
    for (const name of Object.values(BuiltInToolName)) {
      if (name !== BuiltInToolName.ORR_ELSE) { // orr-else is COMMAND, not BUILTIN_TOOL
        expect(wrapped.has(name), `${name} should be in wrapped tool names`).toBe(true);
      }
    }
  });

  it('includes all PLUGIN_TOOL names', () => {
    const wrapped = emptyCatalog().getWrappedToolNames();
    for (const name of Object.values(PluginToolName)) {
      expect(wrapped.has(name), `PluginToolName ${name} should be in wrapped tool names`).toBe(true);
    }
  });

  it('does NOT include COMMAND names', () => {
    const wrapped = emptyCatalog().getWrappedToolNames();
    expect(wrapped.has(BuiltInToolName.ORR_ELSE)).toBe(false);
  });

  it('does NOT include NATIVE_PI_TOOL names (they are observed, not wrapped)', () => {
    const wrapped = emptyCatalog().getWrappedToolNames();
    for (const name of DEFAULT_OBSERVED_PI_TOOLS) {
      expect(wrapped.has(name), `${name} should NOT be wrapped (it is native Pi)`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. getObservedPiToolNames — replaces the old observedPiTools Set
// ---------------------------------------------------------------------------

describe('ToolSurfaceCatalog — getObservedPiToolNames', () => {
  it('includes all DEFAULT_OBSERVED_PI_TOOLS (none are wrapped)', () => {
    const observed = emptyCatalog().getObservedPiToolNames();
    for (const name of DEFAULT_OBSERVED_PI_TOOLS) {
      expect(observed.has(name), `${name} should be in observed set`).toBe(true);
    }
  });

  it('does NOT include BUILTIN_TOOL names (they are wrapped, not observed)', () => {
    const observed = emptyCatalog().getObservedPiToolNames();
    for (const name of Object.values(BuiltInToolName)) {
      if (name !== BuiltInToolName.ORR_ELSE) {
        expect(observed.has(name), `BUILTIN_TOOL ${name} should NOT be in observed set`).toBe(false);
      }
    }
  });

  it('does NOT include PLUGIN_TOOL names (they are wrapped, not observed)', () => {
    const observed = emptyCatalog().getObservedPiToolNames();
    for (const name of Object.values(PluginToolName)) {
      expect(observed.has(name), `PLUGIN_TOOL ${name} should NOT be in observed set`).toBe(false);
    }
  });

  it('includes extra observed tools from settings.pi.observedTools', () => {
    const catalog = buildToolSurfaceCatalog(emptyConfig(), [], ['__extra_observed__']);
    expect(catalog.getObservedPiToolNames().has('__extra_observed__')).toBe(true);
  });

  it('a PROJECT_TOOL that shadows a native Pi tool name is in wrapped not observed', () => {
    // If a project configures a tool named 'bash' as a COMMAND tool,
    // it goes into PROJECT_TOOL → wrapped → NOT observed
    const configWithBash = {
      ...emptyConfig(),
      tools: [{ name: NativePiToolName.BASH, type: 'command', command: 'bash' }] as any,
    } as HarnessConfig;
    const catalog = buildToolSurfaceCatalog(configWithBash, [], []);
    // bash is now a PROJECT_TOOL (wrapped)
    expect(catalog.getWrappedToolNames().has(NativePiToolName.BASH)).toBe(true);
    // But it should still be in observed as NATIVE_PI_TOOL too...
    // Actually, the catalog keeps both entries. The observed Pi filter excludes wrapped.
    // Since bash is now ALSO in wrappedToolNames, getObservedPiToolNames() excludes it.
    // This is the correct behavior: the project tool takes precedence.
    expect(catalog.getObservedPiToolNames().has(NativePiToolName.BASH)).toBe(false);
  });
});
