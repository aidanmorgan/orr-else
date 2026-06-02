/**
 * RTK inventory regression tests.
 *
 * Assertions:
 *  1. Every BuiltInToolName has an inventory entry.
 *  2. Every PluginToolName has an inventory entry.
 *  3. Every DEFAULT_OBSERVED_PI_TOOLS (NativePiToolName) has an entry.
 *  4. A synthetic "newly registered tool" with no inventory entry causes the
 *     guardrail (checkRtkInventoryCoverage) to report a violation.
 *  5. NO assertion requires all tools to expose uniform return keys
 *     (structuredResult / resultPreview / outputArchive).
 *  6. Each inventory entry has the mandatory fields populated and valid values.
 */

import { describe, expect, it } from 'vitest';
import {
  RTK_INVENTORY,
  RTK_INVENTORY_BY_NAME,
  checkRtkInventoryCoverage,
  getRtkContractEntry,
  type RtkArchiveStrategy,
  type RtkContractEntry,
  type RtkInventoryViolation,
  type RtkToolClass
} from '../src/core/RtkContract.js';
import {
  BuiltInToolName,
  DEFAULT_OBSERVED_PI_TOOLS,
  NativePiToolName,
  PluginToolName
} from '../src/constants/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOOL_CLASSES: Set<RtkToolClass> = new Set([
  'built_in',
  'plugin',
  'native_pi',
  'project_configured'
]);

const VALID_ARCHIVE_STRATEGIES: Set<RtkArchiveStrategy> = new Set([
  'none',
  'byte_budget_cap',
  'structured_preview',
  'archive_with_ref',
  'sampling',
  'pass_through'
]);

function assertEntryShape(entry: RtkContractEntry): void {
  expect(typeof entry.toolName).toBe('string');
  expect(entry.toolName.length).toBeGreaterThan(0);

  expect(VALID_TOOL_CLASSES.has(entry.toolClass)).toBe(true);

  expect(typeof entry.owningFile).toBe('string');
  expect(entry.owningFile.startsWith('src/')).toBe(true);

  expect(typeof entry.schemaTypeName).toBe('string');
  expect(entry.schemaTypeName.length).toBeGreaterThan(0);

  expect(typeof entry.skillPath).toBe('string');
  expect(entry.skillPath.startsWith('.pi/skills/')).toBe(true);

  expect(typeof entry.byteBudget).toBe('number');
  expect(entry.byteBudget).toBeGreaterThanOrEqual(0);

  expect(VALID_ARCHIVE_STRATEGIES.has(entry.archiveStrategy)).toBe(true);

  expect(typeof entry.mutating).toBe('boolean');
}

// ---------------------------------------------------------------------------
// 1. Built-in tools: every BuiltInToolName must have an inventory entry
// ---------------------------------------------------------------------------

describe('RTK inventory — built-in tools', () => {
  const builtInNames = Object.values(BuiltInToolName);

  it('covers 100% of BuiltInToolName values', () => {
    const violations = checkRtkInventoryCoverage(builtInNames);
    if (violations.length > 0) {
      const messages = violations.map((v: RtkInventoryViolation) => v.message).join('\n');
      throw new Error(
        `${violations.length} built-in tool(s) missing from RTK_INVENTORY:\n${messages}`
      );
    }
    expect(violations).toHaveLength(0);
  });

  it('has correct toolClass "built_in" for each entry', () => {
    for (const name of builtInNames) {
      const entry = getRtkContractEntry(name);
      expect(entry, `missing entry for BuiltInToolName.${name}`).toBeDefined();
      expect(entry!.toolClass).toBe('built_in');
    }
  });

  it.each(builtInNames)('entry for %s has valid shape', (name) => {
    const entry = getRtkContractEntry(name);
    expect(entry).toBeDefined();
    assertEntryShape(entry!);
  });
});

// ---------------------------------------------------------------------------
// 2. Plugin tools: every PluginToolName must have an inventory entry
// ---------------------------------------------------------------------------

describe('RTK inventory — plugin tools', () => {
  const pluginNames = Object.values(PluginToolName);

  it('covers 100% of PluginToolName values', () => {
    const violations = checkRtkInventoryCoverage(pluginNames);
    if (violations.length > 0) {
      const messages = violations.map((v: RtkInventoryViolation) => v.message).join('\n');
      throw new Error(
        `${violations.length} plugin tool(s) missing from RTK_INVENTORY:\n${messages}`
      );
    }
    expect(violations).toHaveLength(0);
  });

  it('has correct toolClass "plugin" for each entry', () => {
    for (const name of pluginNames) {
      const entry = getRtkContractEntry(name);
      expect(entry, `missing entry for PluginToolName.${name}`).toBeDefined();
      expect(entry!.toolClass).toBe('plugin');
    }
  });

  it.each(pluginNames)('entry for %s has valid shape', (name) => {
    const entry = getRtkContractEntry(name);
    expect(entry).toBeDefined();
    assertEntryShape(entry!);
  });
});

// ---------------------------------------------------------------------------
// 3. Native Pi tools: every DEFAULT_OBSERVED_PI_TOOLS entry must have coverage
// ---------------------------------------------------------------------------

describe('RTK inventory — native Pi tools', () => {
  it('covers all DEFAULT_OBSERVED_PI_TOOLS values', () => {
    const violations = checkRtkInventoryCoverage(DEFAULT_OBSERVED_PI_TOOLS);
    if (violations.length > 0) {
      const messages = violations.map((v: RtkInventoryViolation) => v.message).join('\n');
      throw new Error(
        `${violations.length} native Pi tool(s) missing from RTK_INVENTORY:\n${messages}`
      );
    }
    expect(violations).toHaveLength(0);
  });

  it('has correct toolClass "native_pi" for each observed Pi tool', () => {
    for (const name of DEFAULT_OBSERVED_PI_TOOLS) {
      const entry = getRtkContractEntry(name);
      expect(entry, `missing entry for NativePiToolName.${name}`).toBeDefined();
      expect(entry!.toolClass).toBe('native_pi');
    }
  });

  it.each(Object.values(NativePiToolName))('entry for %s has valid shape', (name) => {
    const entry = getRtkContractEntry(name);
    expect(entry).toBeDefined();
    assertEntryShape(entry!);
  });
});

// ---------------------------------------------------------------------------
// 4. Regression guardrail: a newly registered tool without an inventory entry
//    causes checkRtkInventoryCoverage to return a non-empty violation list
// ---------------------------------------------------------------------------

describe('RTK inventory — regression guardrail', () => {
  it('reports a violation for a newly registered tool that has no inventory entry', () => {
    const syntheticNewTool = '__synthetic_new_tool_without_inventory__';
    const violations = checkRtkInventoryCoverage([syntheticNewTool]);

    expect(violations).toHaveLength(1);
    expect(violations[0].toolName).toBe(syntheticNewTool);
    expect(violations[0].message).toContain('RTK inventory entry');
  });

  it('reports zero violations when the registered list is a subset of the inventory', () => {
    const knownTools = [
      BuiltInToolName.TICK_ITEMS,
      PluginToolName.BD_CLAIM,
      NativePiToolName.READ
    ];
    const violations = checkRtkInventoryCoverage(knownTools);
    expect(violations).toHaveLength(0);
  });

  it('reports multiple violations when multiple new tools lack entries', () => {
    const newTools = ['__ghost_tool_a__', '__ghost_tool_b__', BuiltInToolName.HARNESS_STATUS];
    const violations = checkRtkInventoryCoverage(newTools);
    // Only the two ghost tools should violate; HARNESS_STATUS is covered
    expect(violations).toHaveLength(2);
    expect(violations.map((v: RtkInventoryViolation) => v.toolName)).toContain('__ghost_tool_a__');
    expect(violations.map((v: RtkInventoryViolation) => v.toolName)).toContain('__ghost_tool_b__');
  });
});

// ---------------------------------------------------------------------------
// 5. No uniform-envelope requirement
//    The inventory does NOT require every tool to expose structuredResult,
//    resultPreview, or outputArchive.  Only project_configured tools use those
//    compatibility fields.
// ---------------------------------------------------------------------------

describe('RTK inventory — no uniform envelope requirement', () => {
  it('does not require built_in tools to use structuredResult/resultPreview/outputArchive', () => {
    const builtInEntries = RTK_INVENTORY.filter(e => e.toolClass === 'built_in');
    // We simply assert that no uniform-schema-field check is applied.
    // All built-in tools use schemaTypeName 'untyped_record' — which is the
    // per-tool minimal shape, not a shared envelope.
    for (const entry of builtInEntries) {
      // The schema type is the tool's own minimal schema — not a global envelope.
      expect(entry.schemaTypeName).not.toBe('ModelFacingProjectToolResult');
    }
  });

  it('does not require plugin tools to use structuredResult/resultPreview/outputArchive', () => {
    const pluginEntries = RTK_INVENTORY.filter(e => e.toolClass === 'plugin');
    for (const entry of pluginEntries) {
      expect(entry.schemaTypeName).not.toBe('ModelFacingProjectToolResult');
    }
  });

  it('does not require native_pi tools to use structuredResult/resultPreview/outputArchive', () => {
    const nativeEntries = RTK_INVENTORY.filter(e => e.toolClass === 'native_pi');
    for (const entry of nativeEntries) {
      expect(entry.schemaTypeName).not.toBe('ModelFacingProjectToolResult');
    }
  });

  it('only project_configured tools may declare ModelFacingProjectToolResult schema', () => {
    const nonProjectEntries = RTK_INVENTORY.filter(e => e.toolClass !== 'project_configured');
    for (const entry of nonProjectEntries) {
      expect(entry.schemaTypeName).not.toBe('ModelFacingProjectToolResult');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Inventory structural integrity
// ---------------------------------------------------------------------------

describe('RTK inventory — structural integrity', () => {
  it('has no duplicate toolName entries', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of RTK_INVENTORY) {
      if (seen.has(entry.toolName)) {
        duplicates.push(entry.toolName);
      }
      seen.add(entry.toolName);
    }
    expect(duplicates).toHaveLength(0);
  });

  it('RTK_INVENTORY_BY_NAME index has the same count as the array', () => {
    expect(RTK_INVENTORY_BY_NAME.size).toBe(RTK_INVENTORY.length);
  });

  it('every inventory entry has a valid shape', () => {
    for (const entry of RTK_INVENTORY) {
      assertEntryShape(entry);
    }
  });

  it('inventory total covers built-in + plugin + observed Pi tool counts', () => {
    const builtInCount = Object.values(BuiltInToolName).length;
    const pluginCount = Object.values(PluginToolName).length;
    const nativeCount = DEFAULT_OBSERVED_PI_TOOLS.length;

    const builtInInInventory = RTK_INVENTORY.filter(e => e.toolClass === 'built_in').length;
    const pluginInInventory = RTK_INVENTORY.filter(e => e.toolClass === 'plugin').length;
    const nativeInInventory = RTK_INVENTORY.filter(e => e.toolClass === 'native_pi').length;

    expect(builtInInInventory).toBe(builtInCount);
    expect(pluginInInventory).toBe(pluginCount);
    expect(nativeInInventory).toBe(nativeCount);
  });

  it('getRtkContractEntry returns undefined for an unknown tool name', () => {
    expect(getRtkContractEntry('does_not_exist')).toBeUndefined();
  });

  it('getRtkContractEntry returns a defined entry for every BuiltInToolName', () => {
    for (const name of Object.values(BuiltInToolName)) {
      expect(getRtkContractEntry(name), `getRtkContractEntry('${name}')`).toBeDefined();
    }
  });
});
