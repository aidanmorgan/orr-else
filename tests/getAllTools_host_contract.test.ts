/**
 * pi-experiment-1elr.8: Validate the Pi getAllTools host contract for native extension project tools.
 *
 * AC1  When ANY configured tool uses native Pi extension semantics (type: extension),
 *      startup admission REQUIRES getAllTools (hard-fail if absent).
 * AC2  The returned inventory is schema-validated: name, uniqueness, active/hidden/deprecated
 *      state, source/provenance, owning extension/package, prompt exposure, callable status.
 * AC3  Missing source/provenance, missing callable status, hidden/deprecated required tools,
 *      or name-only inventory is a HARD startup failure UNLESS the tool is observeOnly.
 *      observeOnly tools cannot satisfy requiredTools.
 * AC4  Missing getAllTools, malformed entries, duplicate names, missing required native tools,
 *      stale disabled tools, or unexpected aliases FAIL with compact diagnostics.
 * AC5  Non-native-extension configs (no type: extension tools) are UNAFFECTED.
 *
 * The schema is registered in SchemaRegistry under 'harness.host.piToolInventory'.
 * Admission runs in validateNativePiExtensionProjectTools() in extension.ts,
 * before any worker token spend (SESSION_START fires before Supervisor.start).
 */

import { describe, it, expect } from 'vitest';
import { schemaRegistry } from '../src/core/SchemaRegistry.js';
import {
  validateNativePiExtensionProjectToolInventory,
  PI_TOOL_INVENTORY_SCHEMA_ID,
} from '../src/core/PiHostInventory.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import { ProjectToolType } from '../src/constants/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(tools: Array<Record<string, unknown>> = []): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 1,
      handoverTemplate: 'test',
      agentTurnTimeoutMs: 3600000,
      processReapIntervalMs: 60000,
      defaultModel: 'm',
      defaultProvider: 'openai',
      modelProviders: {},
      stateContextRotThreshold: 5,
      harnessContextRotThreshold: 3,
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    states: {},
    tools: tools as any,
  } as unknown as HarnessConfig;
}

function extensionTool(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, type: ProjectToolType.EXTENSION, ...extra };
}

function commandTool(name: string): Record<string, unknown> {
  return { name, type: ProjectToolType.COMMAND, command: 'node' };
}

/** Minimal valid inventory entry — satisfies all required fields. */
function validEntry(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    callable: true,
    hidden: false,
    deprecated: false,
    source: 'extension',
    provenance: '.pi/extensions/my-ext.ts',
    promptExposure: 'exposed',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// AC5: configs with NO type:extension tools are unaffected
// ---------------------------------------------------------------------------

describe('AC5: non-native-extension configs are unaffected', () => {
  it('does not throw when no tools are declared', () => {
    const config = makeConfig([]);
    const pi = { getAllTools: () => [] } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config)).not.toThrow();
  });

  it('does not throw when all tools are command or mcp type', () => {
    const config = makeConfig([
      commandTool('my_command'),
      { name: 'my_mcp', type: ProjectToolType.MCP, server: 'my-mcp' },
    ]);
    const pi = { getAllTools: () => [] } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config)).not.toThrow();
  });

  it('does not require getAllTools when no extension tools are configured', () => {
    const config = makeConfig([commandTool('cmd_tool')]);
    // pi without getAllTools at all
    const pi = {} as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC1 & AC4: missing getAllTools is a HARD failure when extension tools are present
// ---------------------------------------------------------------------------

describe('AC1 / AC4: getAllTools absence is a hard failure for extension tool configs', () => {
  it('throws when getAllTools is absent and extension tools are configured', () => {
    const config = makeConfig([extensionTool('native_search')]);
    const pi = {} as any; // no getAllTools
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config))
      .toThrow(/getAllTools|host.*API|Pi host inventory/i);
  });

  it('throws when getAllTools is not a function', () => {
    const config = makeConfig([extensionTool('native_search')]);
    const pi = { getAllTools: 'not-a-function' } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config))
      .toThrow(/getAllTools|host.*API|Pi host inventory/i);
  });

  it('diagnostic names the configured extension tool(s)', () => {
    const config = makeConfig([extensionTool('native_search'), extensionTool('native_index')]);
    const pi = {} as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config))
      .toThrow(/native_search|native_index/);
  });
});

// ---------------------------------------------------------------------------
// AC4: empty inventory is a hard failure
// ---------------------------------------------------------------------------

describe('AC4: empty inventory fails when required extension tools are configured', () => {
  it('throws when getAllTools returns empty array', () => {
    const config = makeConfig([extensionTool('native_search')]);
    const pi = { getAllTools: () => [] } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config))
      .toThrow(/missing|not found|native_search/i);
  });
});

// ---------------------------------------------------------------------------
// AC4: duplicate names in inventory
// ---------------------------------------------------------------------------

describe('AC4: duplicate names in Pi inventory are rejected', () => {
  it('throws when getAllTools returns duplicate names', () => {
    const config = makeConfig([extensionTool('native_search')]);
    const pi = {
      getAllTools: () => [
        validEntry('native_search'),
        validEntry('native_search'), // duplicate
      ],
    } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config))
      .toThrow(/duplicate|native_search/i);
  });
});

// ---------------------------------------------------------------------------
// AC4: malformed entries in inventory
// ---------------------------------------------------------------------------

describe('AC4: malformed inventory entries are rejected', () => {
  it('throws when an entry is missing the name field', () => {
    const config = makeConfig([extensionTool('native_search')]);
    const pi = {
      getAllTools: () => [{ callable: true, hidden: false, deprecated: false, source: 'ext', provenance: 'x.ts', promptExposure: 'exposed' }],
    } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config))
      .toThrow(/name|malformed|invalid/i);
  });

  it('throws when an entry name is not a string', () => {
    const config = makeConfig([extensionTool('native_search')]);
    const pi = {
      getAllTools: () => [{ name: 42, callable: true, hidden: false, deprecated: false, source: 'ext', provenance: 'x.ts', promptExposure: 'exposed' }],
    } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config))
      .toThrow(/name|malformed|invalid/i);
  });

  it('throws when getAllTools returns a non-array', () => {
    const config = makeConfig([extensionTool('native_search')]);
    const pi = { getAllTools: () => 'not-an-array' } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config))
      .toThrow(/malformed|inventory|array/i);
  });
});

// ---------------------------------------------------------------------------
// AC3: hidden/deprecated required tools
// ---------------------------------------------------------------------------

describe('AC3: hidden or deprecated required extension tools fail admission', () => {
  it('throws when a required extension tool is hidden in the inventory', () => {
    const config = makeConfig([extensionTool('native_search')]);
    const pi = {
      getAllTools: () => [validEntry('native_search', { hidden: true })],
    } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config))
      .toThrow(/hidden|native_search/i);
  });

  it('throws when a required extension tool is deprecated in the inventory', () => {
    const config = makeConfig([extensionTool('native_search')]);
    const pi = {
      getAllTools: () => [validEntry('native_search', { deprecated: true })],
    } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config))
      .toThrow(/deprecated|native_search/i);
  });
});

// ---------------------------------------------------------------------------
// AC3: missing provenance forces rejection (unless observeOnly)
// ---------------------------------------------------------------------------

describe('AC3: missing provenance is a hard failure', () => {
  it('throws when provenance is missing from a required extension tool entry', () => {
    const config = makeConfig([extensionTool('native_search')]);
    const pi = {
      getAllTools: () => [validEntry('native_search', { provenance: undefined })],
    } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config))
      .toThrow(/provenance|native_search/i);
  });

  it('throws when source is missing from a required extension tool entry', () => {
    const config = makeConfig([extensionTool('native_search')]);
    const pi = {
      getAllTools: () => [validEntry('native_search', { source: undefined })],
    } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config))
      .toThrow(/source|provenance|native_search/i);
  });
});

// ---------------------------------------------------------------------------
// AC3: missing callable status is a hard failure (unless observeOnly)
// ---------------------------------------------------------------------------

describe('AC3: missing callable status is a hard failure', () => {
  it('throws when callable is missing', () => {
    const config = makeConfig([extensionTool('native_search')]);
    const pi = {
      getAllTools: () => [validEntry('native_search', { callable: undefined })],
    } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config))
      .toThrow(/callable|native_search/i);
  });

  it('throws when callable is false (not callable = stale/disabled tool)', () => {
    const config = makeConfig([extensionTool('native_search')]);
    const pi = {
      getAllTools: () => [validEntry('native_search', { callable: false })],
    } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config))
      .toThrow(/callable|stale|disabled|native_search/i);
  });
});

// ---------------------------------------------------------------------------
// AC3: observeOnly carve-out
// ---------------------------------------------------------------------------

describe('AC3: observeOnly carve-out', () => {
  it('does not throw when an observeOnly tool has missing provenance', () => {
    // observeOnly tools bypass strict provenance/callable checks
    const config = makeConfig([extensionTool('watch_only', { observeOnly: true })]);
    const pi = {
      getAllTools: () => [validEntry('watch_only', { provenance: undefined, source: undefined })],
    } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config)).not.toThrow();
  });

  it('does not throw when an observeOnly tool is hidden in the inventory', () => {
    const config = makeConfig([extensionTool('watch_only', { observeOnly: true })]);
    const pi = {
      getAllTools: () => [validEntry('watch_only', { hidden: true })],
    } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config)).not.toThrow();
  });

  it('does not throw when an observeOnly tool is not found in getAllTools (absent from inventory)', () => {
    // observeOnly tools do not need to be in the inventory at all
    const config = makeConfig([extensionTool('watch_only', { observeOnly: true })]);
    const pi = { getAllTools: () => [] } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC4: required native tool missing from inventory
// ---------------------------------------------------------------------------

describe('AC4: required extension tool missing from inventory', () => {
  it('throws when a required tool is not in the getAllTools inventory', () => {
    const config = makeConfig([extensionTool('native_search'), extensionTool('native_index')]);
    const pi = {
      getAllTools: () => [validEntry('native_search')],
      // native_index is missing
    } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config))
      .toThrow(/native_index.*missing|missing.*native_index/i);
  });
});

// ---------------------------------------------------------------------------
// AC2 + AC5: successful admission with valid inventory
// ---------------------------------------------------------------------------

describe('AC2 / AC5: successful admission with valid inventory', () => {
  it('admits when all required extension tools are in the inventory with full metadata', () => {
    const config = makeConfig([
      extensionTool('native_search'),
      extensionTool('native_index'),
    ]);
    const pi = {
      getAllTools: () => [
        validEntry('native_search'),
        validEntry('native_index', { source: 'package', provenance: '@myorg/tools' }),
        validEntry('unrelated_tool'), // extra tools in inventory are fine
      ],
    } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config)).not.toThrow();
  });

  it('admits when mix of extension and command tools — only extension entries are validated', () => {
    const config = makeConfig([
      extensionTool('native_search'),
      commandTool('cmd_tool'),
    ]);
    const pi = {
      getAllTools: () => [validEntry('native_search')],
    } as any;
    expect(() => validateNativePiExtensionProjectToolInventory(pi, config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SchemaRegistry: Pi host inventory schema is registered
// ---------------------------------------------------------------------------

describe('SchemaRegistry: Pi host inventory schema is registered', () => {
  it('the schema is registered under PI_TOOL_INVENTORY_SCHEMA_ID', () => {
    expect(schemaRegistry.has(PI_TOOL_INVENTORY_SCHEMA_ID)).toBe(true);
  });

  it('the schema entry has all required metadata', () => {
    const entry = schemaRegistry.getEntry(PI_TOOL_INVENTORY_SCHEMA_ID);
    expect(entry.owner).toBeTruthy();
    expect(entry.replayPolicy).toMatch(/^(CRITICAL|BEST_EFFORT|NONE)$/);
    expect(entry.compatibilityPolicy).toBeTruthy();
    expect(entry.positiveFixtures.length).toBeGreaterThan(0);
    expect(entry.negativeFixtures.length).toBeGreaterThan(0);
  });

  it('the validator accepts a well-formed inventory entry', () => {
    const validate = schemaRegistry.getValidator(PI_TOOL_INVENTORY_SCHEMA_ID);
    const validInventory = { entries: [validEntry('native_search')] };
    const result = validate(validInventory);
    expect(result).toBe(true);
  });

  it('the validator rejects an entry with missing name', () => {
    const validate = schemaRegistry.getValidator(PI_TOOL_INVENTORY_SCHEMA_ID);
    const invalid = {
      entries: [{ callable: true, hidden: false, deprecated: false, source: 'ext', provenance: 'x.ts', promptExposure: 'exposed' }],
    };
    expect(validate(invalid)).toBe(false);
  });

  it('the validator rejects an empty entries array when non-optional tools exist (structural: entries must be array)', () => {
    const validate = schemaRegistry.getValidator(PI_TOOL_INVENTORY_SCHEMA_ID);
    // The schema validates the shape; business logic (required tools present) is in the admission function
    expect(validate({ entries: [] })).toBe(true); // empty array is valid schema-wise
    expect(validate({ entries: 'not-an-array' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Anti-drift: Pi host inventory schema ID constant is stable
// ---------------------------------------------------------------------------

describe('Anti-drift: PI_TOOL_INVENTORY_SCHEMA_ID is a stable constant', () => {
  it('PI_TOOL_INVENTORY_SCHEMA_ID has the expected stable value', () => {
    // This constant is the public API surface. Changing it would break callers.
    expect(PI_TOOL_INVENTORY_SCHEMA_ID).toBe('harness.host.piToolInventory');
  });

  it('the schema is registered in the global registry when PiHostInventory is imported', () => {
    // Side effect of importing PiHostInventory: schema is registered.
    expect(schemaRegistry.has(PI_TOOL_INVENTORY_SCHEMA_ID)).toBe(true);
  });
});
