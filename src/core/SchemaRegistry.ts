/**
 * SchemaRegistry — harness JSON Schema registry and versioning policy (dsm2.1).
 *
 * PURPOSE
 * -------
 * One authoritative place to name, version, locate, and enforce JSON Schemas for
 * harness BOUNDARY CONTRACTS (config objects, tool payloads, handoff shapes).
 *
 * This is a REGISTRY + POLICY module only.  It does not migrate any existing
 * parser code.  Callers (startup lint, runtime validators, dsm2.2+ beads) adopt
 * it incrementally.
 *
 * SCOPE
 * -----
 * Boundary-contract schemas: config objects, tool input/result shapes, handoff
 * payloads.  This is SEPARATE from the domain-event schema registry in EventStore
 * (which governs domain-event envelopes).  Do not add domain events here.
 *
 * COMPATIBILITY POLICY
 * --------------------
 * Schemas carry semver-style versions.  The registry enforces:
 *
 *   - ADDITIVE_ONLY: new optional fields only; removal/rename = breaking → bump major.
 *   - FULL_COMPATIBLE: both additions and removals are safe (flexible envelopes).
 *   - BREAKING_EXPLICIT: incompatible; consumers MUST be updated before the new
 *     version is activated.
 *
 * A "version downgrade" (registering a lower major over a higher major) is REJECTED
 * with a hard error.
 *
 * REPLAY-IMPACT CLASSIFICATION
 * ----------------------------
 * Every schema entry declares its replayPolicy:
 *
 *   - CRITICAL: changes to this boundary contract break event-log replay (treat like
 *     domain events — coordinate with EventStore migrations before changing).
 *   - BEST_EFFORT: changes may silently omit fields on replay; warn but don't halt.
 *   - NONE: schema is not involved in any replay path (config-only / UI-only).
 *
 * FAIL-CLOSED BEHAVIOR
 * --------------------
 * getValidator() throws (does NOT return undefined/null) on:
 *   - unknown schema id
 *   - missing validator
 *   - missing owner
 *   - missing replay policy
 *   - duplicate ids at registration time
 *   - version downgrade (new major < current major)
 */

import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKEND_READINESS_MANIFEST_SCHEMA } from './BackendReadiness.js';
import {
  ROUTE_EVENT_EMITTED_SCHEMA_ID,
  ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
  ROUTE_EVENT_EMITTED_JSON_SCHEMA,
} from './RouteEventContract.js';

const Ajv = AjvModule.default ?? AjvModule;
const addFormats = addFormatsModule.default ?? addFormatsModule;

// ---------------------------------------------------------------------------
// Packaged schema path (published for consuming projects — AC iery)
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to the authoritative harness.schema.json that ships
 * with the orr-else package.
 *
 * Consuming projects (e.g. cerdiwen) can reference this path directly by
 * calling getPackagedSchemaPath() from the installed orr-else package.
 * Use the returned path as the $schema reference in editor tooling or
 * as the source for copying/validating a local schema file.
 *
 * The schema at this path is the AUTHORITATIVE source. Any locally-copied
 * harness.schema.json in a consumer repo must be generated from this path
 * (or version-pinned) and is drift-detected by the harness regression suite.
 */
export function getPackagedSchemaPath(): string {
  // Resolve relative to this file: src/core/SchemaRegistry.ts → ../../harness.schema.json
  // When compiled to dist/core/SchemaRegistry.js → ../../harness.schema.json (same two levels)
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), '..', '..', 'harness.schema.json');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Semver-style version string e.g. "1.0.0". */
export type SchemaVersion = string;

/**
 * How changes to this schema affect harness event-log replay.
 *
 *   CRITICAL   — boundary is serialised into or deserialized from the event log;
 *                breaking changes to this schema break replay.
 *   BEST_EFFORT — boundary may appear in the event log but field omissions
 *                 are tolerated; warn on mismatch but don't halt.
 *   NONE        — schema is not on any replay path (config/startup only).
 */
export type ReplayPolicy = 'CRITICAL' | 'BEST_EFFORT' | 'NONE';

/**
 * Compatibility policy for this schema.
 *
 *   ADDITIVE_ONLY     — only new optional fields are allowed.
 *   FULL_COMPATIBLE   — additions and removals are both safe.
 *   BREAKING_EXPLICIT — incompatible; consumers must be updated before activation.
 */
export type CompatibilityPolicy = 'ADDITIVE_ONLY' | 'FULL_COMPATIBLE' | 'BREAKING_EXPLICIT';

/**
 * A negative fixture: a JSON value that MUST be rejected by this schema's validator.
 * Used in conformance tests to verify the validator catches bad payloads.
 */
export interface NegativeFixture {
  /** Human-readable label. */
  label: string;
  /** The invalid payload. */
  value: unknown;
}

/**
 * A positive fixture: a JSON value that MUST be accepted by this schema's validator.
 */
export interface PositiveFixture {
  /** Human-readable label. */
  label: string;
  /** The valid payload. */
  value: unknown;
}

/**
 * One entry in the boundary-contract schema registry.
 */
export interface SchemaRegistryEntry {
  /** Stable, namespaced identifier.  Convention: `harness.<domain>.<name>`. */
  readonly id: string;
  /** Semver version string, e.g. "1.0.0". */
  readonly version: SchemaVersion;
  /**
   * Owning module/file (repo-relative path).  The owner is responsible for
   * keeping the schema, TypeScript type, validator, and fixtures in sync.
   */
  readonly owner: string;
  /**
   * The JSON Schema object used to compile the AJV validator.
   * Must be a valid JSON Schema draft-07 object.
   */
  readonly jsonSchema: Record<string, unknown>;
  /** Replay-impact classification. */
  readonly replayPolicy: ReplayPolicy;
  /** Compatibility policy for this schema version. */
  readonly compatibilityPolicy: CompatibilityPolicy;
  /**
   * Positive fixtures: payloads that MUST pass validation.
   * At least one positive fixture is required for conformance.
   */
  readonly positiveFixtures: readonly PositiveFixture[];
  /**
   * Negative fixtures: payloads that MUST fail validation.
   * At least one negative fixture is required for conformance.
   */
  readonly negativeFixtures: readonly NegativeFixture[];
}

// ---------------------------------------------------------------------------
// Internal compiled-validator cache
// ---------------------------------------------------------------------------

interface CompiledEntry {
  entry: SchemaRegistryEntry;
  validate: ValidateFunction;
}

// ---------------------------------------------------------------------------
// SchemaRegistry
// ---------------------------------------------------------------------------

/**
 * Boundary-contract JSON Schema registry.
 *
 * Responsibilities:
 *  - Register schemas with stable ids, versions, owners, and replay policies.
 *  - Compile AJV validators at registration time (fail-fast on bad schemas).
 *  - Expose getValidator(id) with fail-closed semantics (throws on any unknown/bad id).
 *  - Detect duplicate ids and version downgrades at registration time.
 */
export class SchemaRegistry {
  private readonly _entries = new Map<string, CompiledEntry>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _ajv: any;

  constructor() {
    this._ajv = new Ajv({ allErrors: true, useDefaults: true });
    addFormats(this._ajv);
  }

  /**
   * Register a boundary-contract schema.
   *
   * Throws if:
   *   - The entry is missing any required field (id, version, owner, jsonSchema,
   *     replayPolicy, compatibilityPolicy, positiveFixtures, negativeFixtures).
   *   - The id is already registered with an incompatible major version (downgrade).
   *   - The id is already registered with the same version (duplicate).
   *   - The JSON Schema fails AJV compilation.
   */
  register(entry: SchemaRegistryEntry): void {
    this._assertComplete(entry);

    const existing = this._entries.get(entry.id);
    if (existing) {
      const existingMajor = majorOf(existing.entry.version);
      const newMajor = majorOf(entry.version);

      if (newMajor < existingMajor) {
        throw new SchemaRegistryError(
          `Version downgrade rejected for schema "${entry.id}": ` +
          `existing version "${existing.entry.version}" (major ${existingMajor}) > ` +
          `new version "${entry.version}" (major ${newMajor}). ` +
          `Version downgrades are never permitted.`
        );
      }
      if (entry.version === existing.entry.version) {
        throw new SchemaRegistryError(
          `Duplicate schema id "${entry.id}" at version "${entry.version}". ` +
          `Either bump the version or remove the duplicate registration.`
        );
      }
      // Higher major is an upgrade — allowed (replaces the existing entry).
    }

    let validate: ValidateFunction;
    try {
      // Remove previously compiled schema with same id (if upgrading).
      if (this._ajv.getSchema(entry.id)) {
        this._ajv.removeSchema(entry.id);
      }
      validate = this._ajv.compile({ ...entry.jsonSchema, $id: entry.id });
    } catch (err) {
      throw new SchemaRegistryError(
        `Failed to compile JSON Schema for "${entry.id}" v${entry.version}: ${String(err)}`
      );
    }

    this._entries.set(entry.id, { entry, validate });
  }

  /**
   * Retrieve the compiled AJV ValidateFunction for a schema by id.
   *
   * FAIL CLOSED: throws SchemaRegistryError for any of:
   *   - unknown schema id
   *   - missing validator (internal invariant — should not occur)
   *   - missing owner
   *   - missing replay policy
   *
   * @param id The stable schema id.
   */
  getValidator(id: string): ValidateFunction {
    const compiled = this._entries.get(id);
    if (!compiled) {
      throw new SchemaRegistryError(
        `Unknown schema id "${id}". ` +
        `Register the schema via SchemaRegistry.register() before querying it. ` +
        `Known ids: ${this._knownIds()}`
      );
    }
    // Internal invariant guards (should be impossible given register() checks).
    if (!compiled.validate) {
      throw new SchemaRegistryError(
        `Internal: schema "${id}" has no compiled validator. This is a registry bug.`
      );
    }
    if (!compiled.entry.owner) {
      throw new SchemaRegistryError(
        `Schema "${id}" has no declared owner. Owner is required for all boundary contracts.`
      );
    }
    if (!compiled.entry.replayPolicy) {
      throw new SchemaRegistryError(
        `Schema "${id}" has no declared replay policy. ` +
        `Add replayPolicy: 'CRITICAL' | 'BEST_EFFORT' | 'NONE'.`
      );
    }
    return compiled.validate;
  }

  /**
   * Retrieve the full registry entry for a schema by id.
   *
   * FAIL CLOSED: throws SchemaRegistryError for unknown id.
   */
  getEntry(id: string): SchemaRegistryEntry {
    const compiled = this._entries.get(id);
    if (!compiled) {
      throw new SchemaRegistryError(
        `Unknown schema id "${id}". Known ids: ${this._knownIds()}`
      );
    }
    return compiled.entry;
  }

  /** Return true if the id is registered. */
  has(id: string): boolean {
    return this._entries.has(id);
  }

  /** Return all registered ids. */
  ids(): readonly string[] {
    return [...this._entries.keys()];
  }

  /** Return all registered entries (immutable view). */
  entries(): readonly SchemaRegistryEntry[] {
    return [...this._entries.values()].map(c => c.entry);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _assertComplete(entry: SchemaRegistryEntry): void {
    const missing: string[] = [];
    if (!entry.id || !entry.id.trim()) missing.push('id');
    if (!entry.version || !entry.version.trim()) missing.push('version');
    if (!entry.owner || !entry.owner.trim()) missing.push('owner');
    if (!entry.jsonSchema || typeof entry.jsonSchema !== 'object') missing.push('jsonSchema');
    if (!entry.replayPolicy) missing.push('replayPolicy');
    if (!entry.compatibilityPolicy) missing.push('compatibilityPolicy');
    if (!entry.positiveFixtures || entry.positiveFixtures.length === 0) missing.push('positiveFixtures (at least 1)');
    if (!entry.negativeFixtures || entry.negativeFixtures.length === 0) missing.push('negativeFixtures (at least 1)');
    if (missing.length > 0) {
      throw new SchemaRegistryError(
        `SchemaRegistryEntry for "${entry.id || '(no id)'}" is missing required fields: ${missing.join(', ')}.`
      );
    }

    if (!isValidSemver(entry.version)) {
      throw new SchemaRegistryError(
        `Schema "${entry.id}" has invalid version "${entry.version}". ` +
        `Version must be semver format: MAJOR.MINOR.PATCH`
      );
    }
  }

  private _knownIds(): string {
    const ids = [...this._entries.keys()];
    return ids.length === 0 ? '(none registered)' : ids.sort().join(', ');
  }
}

// ---------------------------------------------------------------------------
// SchemaRegistryError
// ---------------------------------------------------------------------------

/** Thrown by the registry on any fail-closed condition. */
export class SchemaRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaRegistryError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function majorOf(version: string): number {
  const parts = version.split('.');
  const major = parseInt(parts[0] ?? '0', 10);
  return isNaN(major) ? 0 : major;
}

function isValidSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

// ---------------------------------------------------------------------------
// Seed schemas
//
// These are the initial boundary schemas registered with the harness registry.
// They cover three representative boundary contracts:
//
//   1. harness.config.schedulerWeights  — the Scheduler weights object from
//      harness.yaml (config-boundary; replay: NONE).
//
//   2. harness.tool.commandTool         — a command-type tool declaration from
//      harness.yaml `tools:` (config-boundary; replay: NONE).
//
//   3. harness.tool.requiredTool        — the requiredTool entry shape (both
//      string shorthand and object form) from state definitions in harness.yaml
//      (config-boundary that indirectly affects tool invocation; replay: BEST_EFFORT).
//
// Full coverage of every boundary is the job of dsm2.2+ beads.
// ---------------------------------------------------------------------------

const schedulerWeightsSchema: SchemaRegistryEntry = {
  id: 'harness.config.schedulerWeights',
  version: '1.0.0',
  // Type is defined in StateModels.ts (HarnessConfig.scheduler.weights).
  owner: 'src/core/domain/StateModels.ts',
  replayPolicy: 'NONE',
  compatibilityPolicy: 'ADDITIVE_ONLY',
  jsonSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['waitTime', 'executionTime', 'progress', 'penalty'],
    additionalProperties: false,
    properties: {
      waitTime:      { type: 'number' },
      executionTime: { type: 'number' },
      progress:      { type: 'number' },
      penalty:       { type: 'number' },
      // Optional fields matching StateModels.ts HarnessConfig.scheduler.weights.
      priority:      { type: 'number' },
      restart:       { type: 'number' },
      resume:        { type: 'number' }
    }
  },
  positiveFixtures: [
    {
      label: 'all four base weights as integers',
      value: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
    },
    {
      label: 'weights as floats',
      value: { waitTime: 0.5, executionTime: 2.0, progress: 1.5, penalty: 0.1 }
    },
    {
      label: 'base weights plus optional priority/restart/resume',
      value: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1, priority: 2, restart: 0.5, resume: 0.8 }
    }
  ],
  negativeFixtures: [
    {
      label: 'missing required penalty field',
      value: { waitTime: 1, executionTime: 1, progress: 1 }
    },
    {
      label: 'extra unknown field (additionalProperties: false)',
      value: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1, extra: 'oops' }
    },
    {
      label: 'string instead of number for waitTime',
      value: { waitTime: 'one', executionTime: 1, progress: 1, penalty: 1 }
    }
  ]
};

const commandToolSchema: SchemaRegistryEntry = {
  id: 'harness.tool.commandTool',
  version: '1.0.0',
  // Type is ProjectCommandToolConfig in StateModels.ts.
  owner: 'src/core/domain/StateModels.ts',
  replayPolicy: 'NONE',
  compatibilityPolicy: 'ADDITIVE_ONLY',
  jsonSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['name', 'type', 'command'],
    additionalProperties: true,
    properties: {
      name:    { type: 'string', pattern: '^[A-Za-z0-9_]+$' },
      type:    { type: 'string', const: 'command' },
      command: { type: 'string', minLength: 1 },
      defaultArgs: {
        type: 'array',
        items: { type: 'string' }
      },
      argsMode: { type: 'string', enum: ['replace', 'append'] },
      allowArgs: { type: 'boolean' },
      timeoutMs: { type: 'integer', minimum: 1 },
      optional:  { type: 'boolean' },
      description: { type: 'string' }
    }
  },
  positiveFixtures: [
    {
      label: 'minimal command tool',
      value: { name: 'my_tool', type: 'command', command: 'node' }
    },
    {
      label: 'command tool with optional fields',
      value: {
        name: 'my_tool',
        type: 'command',
        command: 'node',
        defaultArgs: ['--experimental-strip-types', 'script.ts'],
        argsMode: 'append',
        allowArgs: true,
        timeoutMs: 30000,
        optional: false,
        description: 'A tool that does things'
      }
    }
  ],
  negativeFixtures: [
    {
      label: 'missing required name field',
      value: { type: 'command', command: 'node' }
    },
    {
      label: 'missing required command field',
      value: { name: 'my_tool', type: 'command' }
    },
    {
      label: 'wrong type discriminant',
      value: { name: 'my_tool', type: 'mcp', command: 'node' }
    },
    {
      label: 'name with invalid characters (spaces)',
      value: { name: 'my tool', type: 'command', command: 'node' }
    }
  ]
};

const requiredToolSchema: SchemaRegistryEntry = {
  id: 'harness.tool.requiredTool',
  version: '1.0.0',
  owner: 'src/core/domain/StateModels.ts',
  replayPolicy: 'BEST_EFFORT',
  compatibilityPolicy: 'ADDITIVE_ONLY',
  jsonSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    oneOf: [
      // String shorthand form
      { type: 'string', minLength: 1 },
      // Object form
      {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name:           { type: 'string', minLength: 1 },
          expectsVerify:  { type: 'boolean' },
          when: {
            type: 'object',
            additionalProperties: false,
            properties: {
              writeSetIncludesAny: { type: 'array', items: { type: 'string' } },
              writeSetIncludesAll: { type: 'array', items: { type: 'string' } }
            }
          }
        }
      }
    ]
  },
  positiveFixtures: [
    {
      label: 'string shorthand',
      value: 'plan_contract'
    },
    {
      label: 'object form — name only',
      value: { name: 'plan_contract' }
    },
    {
      label: 'object form — with expectsVerify',
      value: { name: 'plan_contract', expectsVerify: true }
    },
    {
      label: 'object form — with conditional when clause',
      value: {
        name: 'plan_contract',
        when: { writeSetIncludesAny: ['src/'] }
      }
    }
  ],
  negativeFixtures: [
    {
      label: 'empty string (minLength: 1 on string shorthand)',
      value: ''
    },
    {
      label: 'object form missing required name',
      value: { expectsVerify: true }
    },
    {
      label: 'object form with unknown field (additionalProperties: false)',
      value: { name: 'plan_contract', unknownField: 'oops' }
    },
    {
      label: 'number (not string or object)',
      value: 42
    }
  ]
};

// ---------------------------------------------------------------------------
// Module-level singleton registry (seeded at import time)
// ---------------------------------------------------------------------------

/**
 * The harness-wide boundary-contract schema registry.
 *
 * Import and call getValidator(id) or getEntry(id) to query schemas.
 * Call register() to add new boundary contracts (dsm2.2+ beads will do this).
 *
 * This singleton is separate from EventStore's domain-event schema registry.
 */
export const schemaRegistry: SchemaRegistry = new SchemaRegistry();

// Seed with representative boundary contracts.
schemaRegistry.register(schedulerWeightsSchema);
schemaRegistry.register(commandToolSchema);
schemaRegistry.register(requiredToolSchema);

// ---------------------------------------------------------------------------
// harness.config.harnessYaml — authoritative full harness YAML schema (iery)
//
// Loaded from the packaged harness.schema.json at registry-init time so that
// the registry entry's jsonSchema always matches the file on disk.
// Consuming projects reference this via getPackagedSchemaPath() or the
// 'harness.config.harnessYaml' registry id.
// ---------------------------------------------------------------------------

(function registerHarnessYamlSchema(): void {
  const schemaPath = getPackagedSchemaPath();
  let jsonSchema: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(schemaPath, 'utf8');
    jsonSchema = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new SchemaRegistryError(
      `Failed to load packaged harness.schema.json from "${schemaPath}": ${String(err)}. ` +
      `Ensure the file is present in the package root.`
    );
  }

  const harnessYamlSchema: SchemaRegistryEntry = {
    id: 'harness.config.harnessYaml',
    version: '1.0.0',
    owner: 'harness.schema.json',
    replayPolicy: 'NONE',
    compatibilityPolicy: 'ADDITIVE_ONLY',
    jsonSchema,
    positiveFixtures: [
      {
        label: 'minimal valid harness config',
        value: {
          settings: {
            maxConcurrentSlots: 1,
            handoverTemplate: 'test',
            defaultModel: 'gpt-4',
            startState: 'impl',
          },
          scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
          states: {
            impl: {
              identity: { role: 'R', expertise: 'E', constraints: [] },
              actions: [{ id: 'a1', type: 'prompt', prompt: 'Go!' }],
              transitions: { SUCCESS: 'done' },
            },
          },
        },
      },
      {
        label: 'harness with tsProjectTool (serialize + wrapperTimeoutMs + failureLimit)',
        value: {
          settings: {
            maxConcurrentSlots: 2,
            handoverTemplate: 'test',
            defaultModel: 'gpt-4',
            startState: 'impl',
            pi: {
              mcp: { allowToolCalls: false, blockedToolPatterns: ['^ruff$'] },
              workerExtensions: ['.pi/extensions/cerdiwen.ts'],
            },
            roots: { myRoot: '/some/path' },
          },
          scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 2, penalty: 1, priority: 1 } },
          tools: [{
            name: 'my_tool',
            type: 'tsProjectTool',
            serialize: true,
            wrapperTimeoutMs: 600000,
            failureLimit: { maxFailuresPerState: 5, suggestedOutcome: 'BLOCKED', terminal: true },
            argumentPathScope: { root: 'worktree', virtualRoots: ['/workspace'], flags: ['--file'] },
          }],
          states: {
            impl: {
              identity: { role: 'R', expertise: 'E', constraints: [] },
              requiredTools: ['my_tool', { name: 'plan_contract', expectsVerify: true }],
              actions: [{ id: 'a1', type: 'prompt', prompt: 'Go!' }],
              transitions: { SUCCESS: 'done' },
            },
          },
        },
      },
    ],
    negativeFixtures: [
      {
        label: 'missing required top-level states key',
        value: {
          settings: { startState: 'impl' },
          scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
          // states is absent — required at root level
        },
      },
      {
        label: 'settings is not an object',
        value: {
          settings: 'invalid',
          scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
          states: {},
        },
      },
    ],
  };

  schemaRegistry.register(harnessYamlSchema);
})();

// ---------------------------------------------------------------------------
// harness.config.backendReadinessManifest — Cerdiwen backend readiness schema
//
// Registered at module init time. The canonical JSON Schema object is defined
// in BackendReadiness.ts (the module that owns the probe logic) to keep the
// schema co-located with its TypeScript types and validation logic.
// ---------------------------------------------------------------------------

(function registerBackendReadinessSchema(): void {
  const backendReadinessManifestSchema: SchemaRegistryEntry = {
    id: 'harness.config.backendReadinessManifest',
    version: '1.0.0',
    owner: 'src/core/BackendReadiness.ts',
    replayPolicy: 'NONE',
    compatibilityPolicy: 'ADDITIVE_ONLY',
    jsonSchema: BACKEND_READINESS_MANIFEST_SCHEMA as unknown as Record<string, unknown>,
    positiveFixtures: [
      {
        label: 'minimal manifest with one required backend',
        value: {
          backends: [
            { name: 'python_lsp', port: 8799, required: true, remediation: 'start lsp' }
          ]
        }
      },
      {
        label: 'full cerdiwen manifest with host + description + optional backend',
        value: {
          backends: [
            { name: 'python_lsp', host: 'localhost', port: 8799, required: true, remediation: 'start lsp', description: 'LSP server' },
            { name: 'sonarqube',  host: 'localhost', port: 9199, required: true, remediation: 'docker compose up -d sonarqube' },
            { name: 'codemap',    host: 'localhost', port: 8798, required: true, remediation: 'start codemap' },
            { name: 'reference_docs', host: 'localhost', port: 8000, required: false, remediation: 'start chroma' }
          ]
        }
      }
    ],
    negativeFixtures: [
      {
        label: 'missing required backends array',
        value: {}
      },
      {
        label: 'backend entry missing required port',
        value: { backends: [{ name: 'python_lsp', required: true, remediation: 'start lsp' }] }
      },
      {
        label: 'backend entry missing required remediation',
        value: { backends: [{ name: 'python_lsp', port: 8799, required: true }] }
      },
      {
        label: 'port out of range',
        value: { backends: [{ name: 'python_lsp', port: 99999, required: true, remediation: 'start lsp' }] }
      }
    ]
  };

  schemaRegistry.register(backendReadinessManifestSchema);
})();

// ---------------------------------------------------------------------------
// pi-experiment-6q0y.15: token accounting boundary schemas
//
// Two distinct, schema-validated event payload shapes:
//   1. harness.accounting.modelTurnUsage  — MODEL_TURN_USAGE_RECORDED payload
//   2. harness.accounting.toolPayload     — TOOL_PAYLOAD_ACCOUNTED payload
//
// Registered here (same module as the other seed schemas) to keep all
// compile-time boundary-contract registrations together.
// Corresponding DOMAIN_EVENT_SCHEMAS entries live in DomainEventSchemas.ts.
// ---------------------------------------------------------------------------

const modelTurnUsageSchema: SchemaRegistryEntry = {
  id: 'harness.accounting.modelTurnUsage',
  version: '1.0.0',
  owner: 'src/core/TokenUsage.ts',
  replayPolicy: 'BEST_EFFORT',
  compatibilityPolicy: 'ADDITIVE_ONLY',
  jsonSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: [
      'beadId', 'stateId', 'actionId', 'workerId', 'model',
      'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
      'totalTokens', 'costTotal', 'durationMs'
    ],
    additionalProperties: false,
    properties: {
      // Required: stable identifiers (always writer-guaranteed)
      beadId:           { type: 'string', minLength: 1 },
      stateId:          { type: 'string', minLength: 1 },
      actionId:         { type: 'string', minLength: 1 },
      workerId:         { type: 'string', minLength: 1 },
      model:            { type: 'string', minLength: 1 },
      // Required: provider-reported token counts
      inputTokens:      { type: 'integer', minimum: 0 },
      outputTokens:     { type: 'integer', minimum: 0 },
      cacheReadTokens:  { type: 'integer', minimum: 0 },
      cacheWriteTokens: { type: 'integer', minimum: 0 },
      totalTokens:      { type: 'integer', minimum: 0 },
      // Required: cost and duration scalars
      costTotal:        { type: 'number', minimum: 0 },
      durationMs:       { type: 'integer', minimum: 0 },
      // Optional: provider name (e.g. "anthropic", "openai")
      provider:         { type: 'string', minLength: 1 },
      // Optional: deduplication key for replayers
      idempotencyKey:   { type: 'string', minLength: 1 }
    }
  },
  positiveFixtures: [
    {
      label: 'minimal valid model-turn accounting payload',
      value: {
        beadId: 'bead-abc',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        workerId: 'worker-1',
        model: 'claude-opus-4-5',
        inputTokens: 1200,
        outputTokens: 800,
        cacheReadTokens: 300,
        cacheWriteTokens: 100,
        totalTokens: 2400,
        costTotal: 0.33,
        durationMs: 2500
      }
    },
    {
      label: 'with optional provider and idempotencyKey',
      value: {
        beadId: 'bead-abc',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        workerId: 'worker-1',
        model: 'claude-opus-4-5',
        provider: 'anthropic',
        inputTokens: 500,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 700,
        costTotal: 0.0,
        durationMs: 1200,
        idempotencyKey: 'formulate-plan:worker-1:Planning'
      }
    }
  ],
  negativeFixtures: [
    {
      label: 'missing required model field',
      value: {
        beadId: 'bead-abc',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        workerId: 'worker-1',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        costTotal: 0,
        durationMs: 1000
      }
    },
    {
      label: 'negative totalTokens (minimum: 0 violated)',
      value: {
        beadId: 'bead-abc',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        workerId: 'worker-1',
        model: 'claude-opus-4-5',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: -1,
        costTotal: 0,
        durationMs: 1000
      }
    },
    {
      label: 'unknown field rejected (additionalProperties: false)',
      value: {
        beadId: 'bead-abc',
        stateId: 'Planning',
        actionId: 'formulate-plan',
        workerId: 'worker-1',
        model: 'claude-opus-4-5',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        costTotal: 0,
        durationMs: 1000,
        promptBody: 'raw prompt text must never appear here'
      }
    }
  ]
};

const toolPayloadAccountingSchema: SchemaRegistryEntry = {
  id: 'harness.accounting.toolPayload',
  version: '1.0.0',
  owner: 'src/core/TokenUsage.ts',
  replayPolicy: 'BEST_EFFORT',
  compatibilityPolicy: 'ADDITIVE_ONLY',
  jsonSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['tool', 'modelFacingBytes', 'estimatedTokens', 'cached'],
    additionalProperties: false,
    properties: {
      // Required: tool identity + byte/token estimates
      tool:             { type: 'string', minLength: 1 },
      modelFacingBytes: { type: 'integer', minimum: 0 },
      estimatedTokens:  { type: 'integer', minimum: 0 },
      cached:           { type: 'boolean' },
      // Optional: invocation context
      beadId:           { type: 'string', minLength: 1 },
      stateId:          { type: 'string', minLength: 1 },
      actionId:         { type: 'string', minLength: 1 },
      toolInvocationId: { type: 'string', minLength: 1 },
      // Optional: deduplication key for replayers
      idempotencyKey:   { type: 'string', minLength: 1 }
    }
  },
  positiveFixtures: [
    {
      label: 'minimal valid tool-payload accounting (no bead context)',
      value: {
        tool: 'my_tool',
        modelFacingBytes: 1024,
        estimatedTokens: 256,
        cached: false
      }
    },
    {
      label: 'full tool-payload accounting with all optional fields',
      value: {
        tool: 'my_tool',
        modelFacingBytes: 4096,
        estimatedTokens: 1024,
        cached: true,
        beadId: 'bead-xyz',
        stateId: 'Implementation',
        actionId: 'act-1',
        toolInvocationId: '01935c28-1234-7abc-def0-123456789abc',
        idempotencyKey: '01935c28-1234-7abc-def0-123456789abc:bead-xyz'
      }
    }
  ],
  negativeFixtures: [
    {
      label: 'missing required tool field',
      value: {
        modelFacingBytes: 1024,
        estimatedTokens: 256,
        cached: false
      }
    },
    {
      label: 'negative modelFacingBytes (minimum: 0 violated)',
      value: {
        tool: 'my_tool',
        modelFacingBytes: -1,
        estimatedTokens: 256,
        cached: false
      }
    },
    {
      label: 'unknown field rejected (additionalProperties: false)',
      value: {
        tool: 'my_tool',
        modelFacingBytes: 100,
        estimatedTokens: 25,
        cached: false,
        rawOutputBody: 'raw tool output must never appear here'
      }
    }
  ]
};

schemaRegistry.register(modelTurnUsageSchema);
schemaRegistry.register(toolPayloadAccountingSchema);

// ---------------------------------------------------------------------------
// harness.event.routeEventEmitted — v2 route-event contract (pi-experiment-6k8e)
//
// ROUTE_EVENT_EMITTED boundary contract: emitted ONLY by configured deterministic
// emitters. Schema enforces all required fields + artifact-digest strictness
// (byteCount + sha256 required per evidenceRef — AC4).
// ---------------------------------------------------------------------------

(function registerRouteEventEmittedSchema(): void {
  const routeEventEmittedSchema: SchemaRegistryEntry = {
    id: ROUTE_EVENT_EMITTED_SCHEMA_ID,
    version: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
    owner: 'src/core/RouteEventContract.ts',
    replayPolicy: 'CRITICAL',
    compatibilityPolicy: 'ADDITIVE_ONLY',
    jsonSchema: ROUTE_EVENT_EMITTED_JSON_SCHEMA,
    positiveFixtures: [
      {
        label: 'minimal valid ROUTE_EVENT_EMITTED with one evidence ref',
        value: {
          schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
          schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
          configVersion: 2,
          configFingerprint: 'abcd1234abcd1234',
          beadId: 'bead-001',
          stateId: 'Planning',
          actionId: 'plan-action',
          runId: 'run-abc123',
          emitterType: 'verifier',
          emitterId: 'plan_verifier',
          eventName: 'PLAN_ACCEPTED',
          category: 'advance',
          evidenceRefs: [
            {
              semanticPath: '.pi/artifacts/plan.md',
              byteCount: 1024,
              sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd'
            }
          ]
        }
      },
      {
        label: 'ROUTE_EVENT_EMITTED with optional schemaId/schemaVersion in evidenceRef',
        value: {
          schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
          schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
          configVersion: 2,
          configFingerprint: 'abcd1234abcd1234',
          beadId: 'bead-002',
          stateId: 'Review',
          actionId: 'review-action',
          runId: 'run-def456',
          emitterType: 'gate',
          emitterId: 'review_gate',
          eventName: 'QUALITY_PASSED',
          category: 'advance',
          evidenceRefs: [
            {
              semanticPath: '.pi/artifacts/review.json',
              byteCount: 512,
              sha256: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
              schemaId: 'harness.tool.reviewOutput',
              schemaVersion: '1.0.0'
            }
          ]
        }
      },
      {
        label: 'ROUTE_EVENT_EMITTED with optional routeEventId (pi-experiment-6k8e self-referential link)',
        value: {
          schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
          schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
          configVersion: 2,
          configFingerprint: 'abcd1234abcd1234',
          beadId: 'bead-003',
          stateId: 'Planning',
          actionId: 'plan-action',
          runId: 'run-xyz789',
          emitterType: 'verifier',
          emitterId: 'plan_verifier',
          eventName: 'PLAN_ACCEPTED',
          category: 'advance',
          evidenceRefs: [
            {
              semanticPath: '.pi/artifacts/plan.md',
              byteCount: 256,
              sha256: 'aabbccddeeff0011aabbccddeeff0011aabbccddeeff0011aabbccddeeff0011'
            }
          ],
          routeEventId: '01928c8d-1234-7abc-8def-000000000001'
        }
      }
    ],
    negativeFixtures: [
      {
        label: 'missing required beadId',
        value: {
          schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
          schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
          configVersion: 2,
          configFingerprint: 'abcd1234',
          stateId: 'Planning',
          actionId: 'plan-action',
          runId: 'run-abc',
          emitterType: 'verifier',
          emitterId: 'plan_verifier',
          eventName: 'PLAN_ACCEPTED',
          category: 'advance',
          evidenceRefs: []
        }
      },
      {
        label: 'evidenceRef missing sha256 (AC4 — digest required)',
        value: {
          schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
          schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
          configVersion: 2,
          configFingerprint: 'abcd1234abcd1234',
          beadId: 'bead-001',
          stateId: 'Planning',
          actionId: 'plan-action',
          runId: 'run-abc123',
          emitterType: 'tool',
          emitterId: 'plan_tool',
          eventName: 'PLAN_ACCEPTED',
          category: 'advance',
          evidenceRefs: [
            {
              semanticPath: '.pi/artifacts/plan.md',
              byteCount: 1024
              // sha256: missing — MUST be rejected
            }
          ]
        }
      },
      {
        label: 'evidenceRef missing byteCount (AC4 — digest required)',
        value: {
          schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
          schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
          configVersion: 2,
          configFingerprint: 'abcd1234abcd1234',
          beadId: 'bead-001',
          stateId: 'Planning',
          actionId: 'plan-action',
          runId: 'run-abc123',
          emitterType: 'tool',
          emitterId: 'plan_tool',
          eventName: 'PLAN_ACCEPTED',
          category: 'advance',
          evidenceRefs: [
            {
              semanticPath: '.pi/artifacts/plan.md',
              sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd'
              // byteCount: missing — MUST be rejected
            }
          ]
        }
      },
      {
        label: 'configVersion not equal to 2',
        value: {
          schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
          schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
          configVersion: 1,
          configFingerprint: 'abcd1234abcd1234',
          beadId: 'bead-001',
          stateId: 'Planning',
          actionId: 'plan-action',
          runId: 'run-abc123',
          emitterType: 'verifier',
          emitterId: 'plan_verifier',
          eventName: 'PLAN_ACCEPTED',
          category: 'advance',
          evidenceRefs: []
        }
      },
      {
        label: 'unknown emitterType rejected (not in enum)',
        value: {
          schemaId: ROUTE_EVENT_EMITTED_SCHEMA_ID,
          schemaVersion: ROUTE_EVENT_EMITTED_SCHEMA_VERSION,
          configVersion: 2,
          configFingerprint: 'abcd1234abcd1234',
          beadId: 'bead-001',
          stateId: 'Planning',
          actionId: 'plan-action',
          runId: 'run-abc123',
          emitterType: 'model',
          emitterId: 'llm_prose',
          eventName: 'PLAN_ACCEPTED',
          category: 'advance',
          evidenceRefs: []
        }
      }
    ]
  };

  schemaRegistry.register(routeEventEmittedSchema);
})();

// ---------------------------------------------------------------------------
// Convenience re-exports for the seeded schema ids
// ---------------------------------------------------------------------------

/** Stable schema ids for the seeded boundary contracts. */
export const SchemaId = {
  SCHEDULER_WEIGHTS: 'harness.config.schedulerWeights',
  COMMAND_TOOL:      'harness.tool.commandTool',
  REQUIRED_TOOL:     'harness.tool.requiredTool',
  /** Authoritative full harness YAML schema (published from harness.schema.json). */
  HARNESS_YAML:      'harness.config.harnessYaml',
  /** pi-experiment-6q0y.33: Cerdiwen backend readiness manifest schema. */
  BACKEND_READINESS_MANIFEST: 'harness.config.backendReadinessManifest',
  /** pi-experiment-6q0y.15: model-turn token/cost accounting event payload. */
  MODEL_TURN_USAGE:  'harness.accounting.modelTurnUsage',
  /** pi-experiment-6q0y.15: tool-payload byte/token accounting event payload. */
  TOOL_PAYLOAD:      'harness.accounting.toolPayload',
  /** pi-experiment-6k8e: v2 route-event boundary contract. */
  ROUTE_EVENT_EMITTED: ROUTE_EVENT_EMITTED_SCHEMA_ID,
} as const;

export type SchemaId = typeof SchemaId[keyof typeof SchemaId];

// ---------------------------------------------------------------------------
// Anti-drift boundary inventory
//
// Every boundary id listed here MUST have a registry entry in schemaRegistry.
// Conformance tests assert: (a) all listed ids are registered, and (b) no
// registered id is absent from this set.  Violations fail the test suite,
// making silent drift impossible in either direction.
//
// When dsm2.2+ beads register new boundary contracts they MUST also add the
// id here; removing an id here without removing the registration also fails.
// ---------------------------------------------------------------------------

/**
 * The complete set of boundary-contract ids that MUST be registered in the
 * harness schema registry.  Any id in this set that lacks a registry entry
 * causes a conformance test failure.  Any registry entry whose id is not in
 * this set also causes a conformance test failure.
 *
 * When adding new boundary contracts (dsm2.2+ beads), add the id here AND
 * register the schema entry in the appropriate module.
 *
 * NOTE (dsm2.3): Handoff/statechart boundary contracts are registered by
 * HandoffSchemas.ts and tracked in HANDOFF_BOUNDARY_IDS (exported from there).
 * They are not listed here to avoid a circular import (HandoffSchemas.ts →
 * SchemaRegistry.ts). The conformance tests for those schemas live in
 * tests/handoff_schemas.test.ts.
 */
export const REQUIRED_BOUNDARY_IDS: ReadonlySet<string> = new Set<string>([
  SchemaId.SCHEDULER_WEIGHTS,
  SchemaId.COMMAND_TOOL,
  SchemaId.REQUIRED_TOOL,
  SchemaId.HARNESS_YAML,
  SchemaId.BACKEND_READINESS_MANIFEST,
  SchemaId.MODEL_TURN_USAGE,
  SchemaId.TOOL_PAYLOAD,
  SchemaId.ROUTE_EVENT_EMITTED,
]);
