/**
 * PiHostInventory — Pi getAllTools host-contract admission (1elr.8).
 *
 * PURPOSE
 * -------
 * When any configured tool uses native Pi extension semantics (type: extension),
 * the Pi host MUST expose a getAllTools() inventory API and the returned entries
 * MUST be schema-valid, uniquely named, callable, and provenance-attributed.
 *
 * This module owns:
 *   1. The host-inventory JSON Schema (registered in SchemaRegistry).
 *   2. The admission function validateNativePiExtensionProjectToolInventory(),
 *      called from extension.ts SESSION_START before any worker token spend.
 *
 * RULES
 * -----
 * - Configs with NO type:extension tools → admission skipped entirely (zero cost).
 * - observeOnly extension tools → bypass strict provenance/callable/hidden checks;
 *   they also cannot satisfy requiredTools (config load is rejected at validation
 *   time by validateObserveOnlyInRequiredTools in ConfigLoader).
 * - Required extension tools (non-observeOnly):
 *     * getAllTools() MUST exist and be a function → hard fail if absent.
 *     * Inventory MUST be an array → hard fail if not.
 *     * Each entry MUST pass the schema validator → hard fail on malformed.
 *     * Names MUST be unique → hard fail on duplicates.
 *     * Each configured extension tool MUST appear in the inventory → hard fail if missing.
 *     * Inventory entry MUST have: callable=true, hidden=false, deprecated=false,
 *       source (non-empty), provenance (non-empty) → hard fail otherwise.
 */

import type { HarnessConfig } from './ConfigLoader.js';
import { schemaRegistry, SchemaRegistryError } from './SchemaRegistry.js';
import type { SchemaRegistryEntry } from './SchemaRegistry.js';
import { ProjectToolType } from '../constants/index.js';
import type { ProjectExtensionToolConfig } from './domain/StateModels.js';

// ---------------------------------------------------------------------------
// Schema ID
// ---------------------------------------------------------------------------

/** Stable schema id for the Pi host getAllTools inventory response. */
export const PI_TOOL_INVENTORY_SCHEMA_ID = 'harness.host.piToolInventory';

// ---------------------------------------------------------------------------
// Schema definition
// ---------------------------------------------------------------------------

const piToolInventorySchema: SchemaRegistryEntry = {
  id: PI_TOOL_INVENTORY_SCHEMA_ID,
  version: '1.0.0',
  owner: 'src/core/PiHostInventory.ts',
  replayPolicy: 'NONE',
  compatibilityPolicy: 'ADDITIVE_ONLY',
  jsonSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['entries'],
    additionalProperties: false,
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name'],
          additionalProperties: true,
          properties: {
            name:          { type: 'string', minLength: 1 },
            callable:      { type: 'boolean' },
            hidden:        { type: 'boolean' },
            deprecated:    { type: 'boolean' },
            source:        { type: 'string', minLength: 1 },
            provenance:    { type: 'string', minLength: 1 },
            promptExposure: { type: 'string' }
          }
        }
      }
    }
  },
  positiveFixtures: [
    {
      label: 'empty entries array',
      value: { entries: [] }
    },
    {
      label: 'single fully-attributed entry',
      value: {
        entries: [
          {
            name: 'native_search',
            callable: true,
            hidden: false,
            deprecated: false,
            source: 'extension',
            provenance: '.pi/extensions/search.ts',
            promptExposure: 'exposed'
          }
        ]
      }
    },
    {
      label: 'entry with only name (minimal — schema-valid; business rules enforced separately)',
      value: { entries: [{ name: 'minimal_tool' }] }
    }
  ],
  negativeFixtures: [
    {
      label: 'entries is not an array',
      value: { entries: 'not-an-array' }
    },
    {
      label: 'missing entries key',
      value: {}
    },
    {
      label: 'entry with non-string name',
      value: { entries: [{ name: 42, callable: true }] }
    }
  ]
};

// ---------------------------------------------------------------------------
// Register on module import
// ---------------------------------------------------------------------------

schemaRegistry.register(piToolInventorySchema);

// ---------------------------------------------------------------------------
// Typed inventory entry
// ---------------------------------------------------------------------------

/**
 * A single entry returned by the Pi host getAllTools() API.
 * Fields beyond `name` are optional in the raw response (schema: additionalProperties:true),
 * but the admission function applies strict business rules for required extension tools.
 */
export interface PiToolInventoryEntry {
  name: string;
  callable?: boolean;
  hidden?: boolean;
  deprecated?: boolean;
  source?: string;
  provenance?: string;
  promptExposure?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Admission function
// ---------------------------------------------------------------------------

/**
 * Validate the Pi host getAllTools inventory for any configured extension tools.
 *
 * @param pi     The Pi ExtensionAPI (cast to include optional getAllTools).
 * @param config The loaded harness configuration.
 *
 * Throws a descriptive Error if the contract is violated.
 * Is a no-op when no type:extension tools are configured.
 */
export function validateNativePiExtensionProjectToolInventory(
  pi: unknown,
  config: HarnessConfig
): void {
  const allTools = config.tools ?? [];

  // Partition extension tools into required (strict) and observeOnly (lenient).
  const requiredExtTools: ProjectExtensionToolConfig[] = [];
  const observeOnlyExtTools: ProjectExtensionToolConfig[] = [];

  for (const tool of allTools) {
    if (tool.type !== ProjectToolType.EXTENSION) continue;
    const extTool = tool as ProjectExtensionToolConfig & { observeOnly?: boolean };
    if (extTool.observeOnly) {
      observeOnlyExtTools.push(extTool);
    } else {
      requiredExtTools.push(extTool);
    }
  }

  // If there are no extension tools at all, nothing to validate.
  if (requiredExtTools.length === 0 && observeOnlyExtTools.length === 0) return;

  // If only observeOnly extension tools and no required ones, skip strict checks.
  if (requiredExtTools.length === 0) return;

  // AC1/AC4: getAllTools MUST be present and be a function.
  const api = pi as { getAllTools?: unknown };
  if (typeof api.getAllTools !== 'function') {
    const toolNames = requiredExtTools.map(t => t.name).join(', ');
    throw new Error(
      `Pi host inventory API (getAllTools) is required but not present. ` +
      `The config declares native Pi extension project tool(s): [${toolNames}]. ` +
      `The Pi host MUST expose getAllTools() so the harness can verify these tools are ` +
      `callable, uniquely named, and provenance-attributed before startup. ` +
      `Ensure the Pi host version supports getAllTools(), or remove the type:extension tool declarations.`
    );
  }

  // AC4: Inventory MUST be an array.
  const rawInventory: unknown = api.getAllTools();
  if (!Array.isArray(rawInventory)) {
    throw new Error(
      `Pi host getAllTools() returned a non-array value (got: ${typeof rawInventory}). ` +
      `The inventory MUST be an array of tool entries. ` +
      `This is a Pi host API contract violation.`
    );
  }

  // AC2/AC4: Schema-validate the full inventory payload.
  const inventoryPayload = { entries: rawInventory };
  let validate: import('ajv').ValidateFunction;
  try {
    validate = schemaRegistry.getValidator(PI_TOOL_INVENTORY_SCHEMA_ID);
  } catch (err) {
    // Should not happen (schema is registered on import), but fail closed.
    throw new SchemaRegistryError(`Failed to get Pi host inventory validator: ${String(err)}`);
  }

  const valid = validate(inventoryPayload);
  if (!valid) {
    const errors = (validate.errors ?? []).map(e => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
    throw new Error(
      `Pi host getAllTools() inventory failed schema validation. ` +
      `Errors: ${errors}. ` +
      `Each entry must have at minimum a non-empty string "name" field.`
    );
  }

  const entries = rawInventory as PiToolInventoryEntry[];

  // AC4: Names MUST be unique (case-sensitive).
  const namesSeen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      throw new Error(
        `Pi host getAllTools() returned a malformed entry with missing or non-string name: ` +
        `${JSON.stringify(entry)}. All inventory entries must have a non-empty string "name".`
      );
    }
    if (namesSeen.has(entry.name)) {
      throw new Error(
        `Pi host getAllTools() returned duplicate tool name "${entry.name}". ` +
        `Tool names in the Pi host inventory must be unique. ` +
        `Duplicate names indicate misconfigured or conflicting Pi extensions.`
      );
    }
    namesSeen.add(entry.name);
  }

  // Build a lookup map for O(1) access.
  const inventoryMap = new Map<string, PiToolInventoryEntry>();
  for (const entry of entries) {
    inventoryMap.set(entry.name, entry);
  }

  // AC3/AC4: Validate each required (non-observeOnly) extension tool.
  const failures: string[] = [];

  for (const toolConfig of requiredExtTools) {
    const name = toolConfig.name;
    const entry = inventoryMap.get(name);

    if (!entry) {
      failures.push(`"${name}": missing from Pi host inventory (getAllTools did not return this tool)`);
      continue;
    }

    const issues: string[] = [];

    // Callable check: must be explicitly true.
    if (entry.callable !== true) {
      const callableVal = entry.callable === false ? 'false (stale/disabled)' : 'absent';
      issues.push(`callable=${callableVal} — tool is not callable`);
    }

    // Hidden check: must be explicitly false.
    if (entry.hidden === true) {
      issues.push(`hidden=true — tool is hidden from prompt exposure`);
    }

    // Deprecated check: must be explicitly false.
    if (entry.deprecated === true) {
      issues.push(`deprecated=true — tool is deprecated`);
    }

    // Provenance/source check: both must be non-empty strings.
    if (typeof entry.source !== 'string' || !entry.source.trim()) {
      issues.push(`source is missing or empty — cannot verify tool ownership/provenance`);
    }
    if (typeof entry.provenance !== 'string' || !entry.provenance.trim()) {
      issues.push(`provenance is missing or empty — cannot verify tool ownership/provenance`);
    }

    if (issues.length > 0) {
      failures.push(`"${name}": ${issues.join('; ')}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Pi host inventory validation failed for native extension project tool(s):\n` +
      failures.map(f => `  - ${f}`).join('\n') + '\n' +
      `Required extension tools must be: callable=true, hidden=false, deprecated=false, ` +
      `and have non-empty source and provenance. ` +
      `Declare observeOnly:true on a tool config entry to bypass strict checks for observation-only tools.`
    );
  }
}
