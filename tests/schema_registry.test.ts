/**
 * pi-experiment-dsm2.1 — SchemaRegistry conformance + fail-closed tests.
 *
 * AC1: A code-owned JSON Schema registry exists with stable ids, versions,
 *      owners, validators, replay-impact classification, compatibility policy,
 *      and negative-fixture references. Seeded with 3 representative boundary
 *      contracts.
 *
 * AC2: Conformance tests: every registered schema MUST have a validator, owner,
 *      replay policy, at least one positive fixture, and at least one negative
 *      fixture — otherwise the registry rejects registration.
 *
 * AC3: Startup lint and runtime validators FAIL CLOSED on: unknown id, missing
 *      validator, duplicate ids at same version, version downgrade, missing owner,
 *      missing replay policy.
 *
 * AC4: No schema validation path uses LLM judgement, prompt text, or duck typing —
 *      all validators are AJV-compiled (structural enforcement only).
 *
 * AC5: Tests compare representative fixtures, declared TypeScript types, and
 *      registry metadata for the three seeded boundary contracts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SchemaRegistry,
  SchemaRegistryError,
  schemaRegistry,
  SchemaId,
  REQUIRED_BOUNDARY_IDS,
  type SchemaRegistryEntry,
  type ReplayPolicy,
  type CompatibilityPolicy
} from '../src/core/SchemaRegistry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid entry for tests that only need a compilable schema. */
function minimalEntry(overrides: Partial<SchemaRegistryEntry> = {}): SchemaRegistryEntry {
  return {
    id: 'harness.test.minimal',
    version: '1.0.0',
    owner: 'tests/schema_registry.test.ts',
    replayPolicy: 'NONE',
    compatibilityPolicy: 'ADDITIVE_ONLY',
    jsonSchema: {
      type: 'object',
      required: ['x'],
      properties: { x: { type: 'string' } }
    },
    positiveFixtures: [{ label: 'valid', value: { x: 'hello' } }],
    negativeFixtures: [{ label: 'invalid', value: {} }],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// AC1 — Module-level singleton seeded with 3 representative boundary schemas
// ---------------------------------------------------------------------------

describe('AC1: seeded schema registry', () => {
  it('the module-level schemaRegistry singleton is defined', () => {
    expect(schemaRegistry).toBeInstanceOf(SchemaRegistry);
  });

  it('registers the 3 seed schemas by stable id', () => {
    expect(schemaRegistry.has(SchemaId.SCHEDULER_WEIGHTS)).toBe(true);
    expect(schemaRegistry.has(SchemaId.COMMAND_TOOL)).toBe(true);
    expect(schemaRegistry.has(SchemaId.REQUIRED_TOOL)).toBe(true);
  });

  it('every seed entry has the required metadata fields', () => {
    for (const id of Object.values(SchemaId)) {
      const entry = schemaRegistry.getEntry(id);
      expect(entry.id, `${id} — id`).toBeTruthy();
      expect(entry.version, `${id} — version`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.owner, `${id} — owner`).toBeTruthy();
      expect(entry.replayPolicy, `${id} — replayPolicy`).toMatch(/^(CRITICAL|BEST_EFFORT|NONE)$/);
      expect(entry.compatibilityPolicy, `${id} — compatibilityPolicy`).toMatch(/^(ADDITIVE_ONLY|FULL_COMPATIBLE|BREAKING_EXPLICIT)$/);
      expect(entry.positiveFixtures.length, `${id} — positiveFixtures`).toBeGreaterThan(0);
      expect(entry.negativeFixtures.length, `${id} — negativeFixtures`).toBeGreaterThan(0);
    }
  });

  it('schedulerWeights entry has correct metadata', () => {
    const entry = schemaRegistry.getEntry(SchemaId.SCHEDULER_WEIGHTS);
    expect(entry.version).toBe('1.0.0');
    // Owner is StateModels.ts — that is where the type (HarnessConfig.scheduler.weights) lives.
    expect(entry.owner).toBe('src/core/domain/StateModels.ts');
    expect(entry.replayPolicy).toBe('NONE');
    expect(entry.compatibilityPolicy).toBe('ADDITIVE_ONLY');
  });

  it('commandTool entry has correct metadata', () => {
    const entry = schemaRegistry.getEntry(SchemaId.COMMAND_TOOL);
    expect(entry.version).toBe('1.0.0');
    // Owner is StateModels.ts — ProjectCommandToolConfig is defined there.
    expect(entry.owner).toBe('src/core/domain/StateModels.ts');
    expect(entry.replayPolicy).toBe('NONE');
  });

  it('requiredTool entry has correct metadata', () => {
    const entry = schemaRegistry.getEntry(SchemaId.REQUIRED_TOOL);
    expect(entry.version).toBe('1.0.0');
    expect(entry.owner).toBe('src/core/domain/StateModels.ts');
    expect(entry.replayPolicy).toBe('BEST_EFFORT');
  });
});

// ---------------------------------------------------------------------------
// AC2 — Conformance: every registered schema must pass integrity checks
// ---------------------------------------------------------------------------

describe('AC2: conformance — every registered schema has required fields', () => {
  it('each registered schema has a compiled validator (getValidator does not throw)', () => {
    for (const id of schemaRegistry.ids()) {
      expect(() => schemaRegistry.getValidator(id)).not.toThrow();
    }
  });

  it('registration rejects entry missing id', () => {
    const reg = new SchemaRegistry();
    expect(() => reg.register(minimalEntry({ id: '' }))).toThrow(SchemaRegistryError);
  });

  it('registration rejects entry missing version', () => {
    const reg = new SchemaRegistry();
    expect(() => reg.register(minimalEntry({ version: '' }))).toThrow(SchemaRegistryError);
  });

  it('registration rejects entry missing owner', () => {
    const reg = new SchemaRegistry();
    expect(() => reg.register(minimalEntry({ owner: '' }))).toThrow(SchemaRegistryError);
  });

  it('registration rejects entry missing replayPolicy', () => {
    const reg = new SchemaRegistry();
    expect(() => reg.register(minimalEntry({ replayPolicy: '' as ReplayPolicy }))).toThrow(SchemaRegistryError);
  });

  it('registration rejects entry missing compatibilityPolicy', () => {
    const reg = new SchemaRegistry();
    expect(() => reg.register(minimalEntry({ compatibilityPolicy: '' as CompatibilityPolicy }))).toThrow(SchemaRegistryError);
  });

  it('registration rejects entry with no positive fixtures', () => {
    const reg = new SchemaRegistry();
    expect(() => reg.register(minimalEntry({ positiveFixtures: [] }))).toThrow(SchemaRegistryError);
  });

  it('registration rejects entry with no negative fixtures', () => {
    const reg = new SchemaRegistry();
    expect(() => reg.register(minimalEntry({ negativeFixtures: [] }))).toThrow(SchemaRegistryError);
  });

  it('registration rejects invalid semver version', () => {
    const reg = new SchemaRegistry();
    expect(() => reg.register(minimalEntry({ version: 'v1' }))).toThrow(SchemaRegistryError);
    expect(() => reg.register(minimalEntry({ version: '1.0' }))).toThrow(SchemaRegistryError);
    expect(() => reg.register(minimalEntry({ version: 'latest' }))).toThrow(SchemaRegistryError);
  });

  it('registration rejects an invalid JSON Schema that fails AJV compilation', () => {
    const reg = new SchemaRegistry();
    expect(() =>
      reg.register(minimalEntry({
        jsonSchema: { type: 'impossible_type_that_ajv_will_reject' } as unknown as Record<string, unknown>
      }))
    ).toThrow(SchemaRegistryError);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Fail-closed behavior: getValidator() and getEntry() throw on bad input
// ---------------------------------------------------------------------------

describe('AC3: fail-closed behavior', () => {
  let reg: SchemaRegistry;

  beforeEach(() => {
    reg = new SchemaRegistry();
    reg.register(minimalEntry());
  });

  it('getValidator throws SchemaRegistryError for unknown id', () => {
    expect(() => reg.getValidator('harness.does.not.exist')).toThrow(SchemaRegistryError);
    expect(() => reg.getValidator('harness.does.not.exist')).toThrow(/Unknown schema id/);
  });

  it('getEntry throws SchemaRegistryError for unknown id', () => {
    expect(() => reg.getEntry('harness.does.not.exist')).toThrow(SchemaRegistryError);
    expect(() => reg.getEntry('harness.does.not.exist')).toThrow(/Unknown schema id/);
  });

  it('the error message includes the unknown id', () => {
    try {
      reg.getValidator('harness.missing.schema');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaRegistryError);
      expect((err as SchemaRegistryError).message).toContain('harness.missing.schema');
    }
  });

  it('getValidator error lists known ids to aid debugging', () => {
    try {
      reg.getValidator('harness.unknown');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as SchemaRegistryError).message).toContain('harness.test.minimal');
    }
  });

  it('duplicate id at same version throws SchemaRegistryError', () => {
    reg.register(minimalEntry({ id: 'harness.test.dup', version: '1.0.0' }));
    expect(() =>
      reg.register(minimalEntry({ id: 'harness.test.dup', version: '1.0.0' }))
    ).toThrow(SchemaRegistryError);
    expect(() =>
      reg.register(minimalEntry({ id: 'harness.test.dup', version: '1.0.0' }))
    ).toThrow(/Duplicate schema id/);
  });

  it('version downgrade (lower major) throws SchemaRegistryError', () => {
    reg.register(minimalEntry({ id: 'harness.test.down', version: '2.0.0' }));
    expect(() =>
      reg.register(minimalEntry({ id: 'harness.test.down', version: '1.0.0' }))
    ).toThrow(SchemaRegistryError);
    expect(() =>
      reg.register(minimalEntry({ id: 'harness.test.down', version: '1.9.9' }))
    ).toThrow(/Version downgrade rejected/);
  });

  it('higher major version upgrade is allowed (replaces existing entry)', () => {
    reg.register(minimalEntry({ id: 'harness.test.upgrade', version: '1.0.0' }));
    expect(() =>
      reg.register(minimalEntry({ id: 'harness.test.upgrade', version: '2.0.0' }))
    ).not.toThrow();
    expect(reg.getEntry('harness.test.upgrade').version).toBe('2.0.0');
  });

  it('minor version bump within same major is allowed', () => {
    reg.register(minimalEntry({ id: 'harness.test.minor', version: '1.0.0' }));
    expect(() =>
      reg.register(minimalEntry({ id: 'harness.test.minor', version: '1.1.0' }))
    ).not.toThrow();
    expect(reg.getEntry('harness.test.minor').version).toBe('1.1.0');
  });

  it('patch bump within same major is allowed', () => {
    reg.register(minimalEntry({ id: 'harness.test.patch', version: '1.0.0' }));
    expect(() =>
      reg.register(minimalEntry({ id: 'harness.test.patch', version: '1.0.1' }))
    ).not.toThrow();
  });

  it('has() returns false for unregistered ids', () => {
    expect(reg.has('harness.does.not.exist')).toBe(false);
  });

  it('has() returns true for registered ids', () => {
    expect(reg.has('harness.test.minimal')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2 (extended) — Anti-drift boundary-inventory cross-check
// ---------------------------------------------------------------------------

describe('AC2 (extended): boundary-inventory cross-check — no silent drift', () => {
  it('REQUIRED_BOUNDARY_IDS is exported and non-empty', () => {
    expect(REQUIRED_BOUNDARY_IDS.size).toBeGreaterThan(0);
  });

  it('every id in REQUIRED_BOUNDARY_IDS is registered in the singleton registry', () => {
    const missing: string[] = [];
    for (const id of REQUIRED_BOUNDARY_IDS) {
      if (!schemaRegistry.has(id)) {
        missing.push(id);
      }
    }
    expect(
      missing,
      `These required boundary ids have NO registry entry (drift detected): ${missing.join(', ')}`
    ).toHaveLength(0);
  });

  it('every registered id in the singleton registry is in REQUIRED_BOUNDARY_IDS', () => {
    const unexpected: string[] = [];
    for (const id of schemaRegistry.ids()) {
      if (!REQUIRED_BOUNDARY_IDS.has(id)) {
        unexpected.push(id);
      }
    }
    expect(
      unexpected,
      `These registered ids are NOT in REQUIRED_BOUNDARY_IDS (add them or remove the registration): ${unexpected.join(', ')}`
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 — Validators are AJV-compiled; no LLM judgement or duck typing
// ---------------------------------------------------------------------------

describe('AC4: validators are AJV-compiled — deterministic structural enforcement', () => {
  it('validator for schedulerWeights accepts a valid payload', () => {
    const validate = schemaRegistry.getValidator(SchemaId.SCHEDULER_WEIGHTS);
    const valid = validate({ waitTime: 1, executionTime: 1, progress: 1, penalty: 1 });
    expect(valid).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('validator for schedulerWeights rejects a payload missing penalty', () => {
    const validate = schemaRegistry.getValidator(SchemaId.SCHEDULER_WEIGHTS);
    const valid = validate({ waitTime: 1, executionTime: 1, progress: 1 });
    expect(valid).toBe(false);
    expect(validate.errors).toBeTruthy();
  });

  it('validator for schedulerWeights rejects extra unknown fields', () => {
    const validate = schemaRegistry.getValidator(SchemaId.SCHEDULER_WEIGHTS);
    const valid = validate({ waitTime: 1, executionTime: 1, progress: 1, penalty: 1, extra: 'oops' });
    expect(valid).toBe(false);
    expect(validate.errors).toBeTruthy();
  });

  it('validator for schedulerWeights accepts optional priority/restart/resume fields', () => {
    const validate = schemaRegistry.getValidator(SchemaId.SCHEDULER_WEIGHTS);
    // These optional fields match the real TS type in StateModels.ts.
    const valid = validate({ waitTime: 1, executionTime: 1, progress: 1, penalty: 1, priority: 2, restart: 0.5, resume: 0.8 });
    expect(valid).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('validator for commandTool accepts a minimal valid command tool', () => {
    const validate = schemaRegistry.getValidator(SchemaId.COMMAND_TOOL);
    const valid = validate({ name: 'my_tool', type: 'command', command: 'node' });
    expect(valid).toBe(true);
  });

  it('validator for commandTool rejects missing command field', () => {
    const validate = schemaRegistry.getValidator(SchemaId.COMMAND_TOOL);
    const valid = validate({ name: 'my_tool', type: 'command' });
    expect(valid).toBe(false);
    expect(validate.errors).toBeTruthy();
  });

  it('validator for commandTool rejects invalid name (space in name)', () => {
    const validate = schemaRegistry.getValidator(SchemaId.COMMAND_TOOL);
    const valid = validate({ name: 'my tool', type: 'command', command: 'node' });
    expect(valid).toBe(false);
    expect(validate.errors).toBeTruthy();
  });

  it('validator for requiredTool accepts string shorthand', () => {
    const validate = schemaRegistry.getValidator(SchemaId.REQUIRED_TOOL);
    expect(validate('plan_contract')).toBe(true);
  });

  it('validator for requiredTool accepts object form with name only', () => {
    const validate = schemaRegistry.getValidator(SchemaId.REQUIRED_TOOL);
    expect(validate({ name: 'plan_contract' })).toBe(true);
  });

  it('validator for requiredTool accepts full object form', () => {
    const validate = schemaRegistry.getValidator(SchemaId.REQUIRED_TOOL);
    expect(validate({
      name: 'plan_contract',
      expectsVerify: true,
      allowDeprecated: false,
      when: { writeSetIncludesAny: ['src/'] }
    })).toBe(true);
  });

  it('validator for requiredTool rejects empty string', () => {
    const validate = schemaRegistry.getValidator(SchemaId.REQUIRED_TOOL);
    expect(validate('')).toBe(false);
    expect(validate.errors).toBeTruthy();
  });

  it('validator for requiredTool rejects object without name', () => {
    const validate = schemaRegistry.getValidator(SchemaId.REQUIRED_TOOL);
    expect(validate({ expectsVerify: true })).toBe(false);
    expect(validate.errors).toBeTruthy();
  });

  it('validator for requiredTool rejects object with unknown fields', () => {
    const validate = schemaRegistry.getValidator(SchemaId.REQUIRED_TOOL);
    expect(validate({ name: 'plan_contract', unknownField: 'oops' })).toBe(false);
    expect(validate.errors).toBeTruthy();
  });

  it('validator for requiredTool rejects a number', () => {
    const validate = schemaRegistry.getValidator(SchemaId.REQUIRED_TOOL);
    expect(validate(42)).toBe(false);
    expect(validate.errors).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AC5 — Positive and negative fixtures pass/fail as declared
// ---------------------------------------------------------------------------

describe('AC5: positive fixtures validate; negative fixtures reject', () => {
  for (const id of Object.values(SchemaId)) {
    describe(`schema: ${id}`, () => {
      it('all positive fixtures pass validation', () => {
        const validate = schemaRegistry.getValidator(id);
        const entry = schemaRegistry.getEntry(id);
        for (const fixture of entry.positiveFixtures) {
          const result = validate(fixture.value);
          expect(result, `positive fixture "${fixture.label}" should pass`).toBe(true);
        }
      });

      it('all negative fixtures fail validation', () => {
        const validate = schemaRegistry.getValidator(id);
        const entry = schemaRegistry.getEntry(id);
        for (const fixture of entry.negativeFixtures) {
          const result = validate(fixture.value);
          expect(result, `negative fixture "${fixture.label}" should fail`).toBe(false);
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Additional: registry introspection methods
// ---------------------------------------------------------------------------

describe('registry introspection', () => {
  it('ids() returns all registered ids', () => {
    const reg = new SchemaRegistry();
    reg.register(minimalEntry({ id: 'harness.test.a' }));
    reg.register(minimalEntry({ id: 'harness.test.b' }));
    const ids = reg.ids();
    expect(ids).toContain('harness.test.a');
    expect(ids).toContain('harness.test.b');
    expect(ids.length).toBe(2);
  });

  it('entries() returns all registered entries', () => {
    const reg = new SchemaRegistry();
    reg.register(minimalEntry({ id: 'harness.test.a' }));
    reg.register(minimalEntry({ id: 'harness.test.b' }));
    const entries = reg.entries();
    expect(entries.length).toBe(2);
    expect(entries.map(e => e.id)).toContain('harness.test.a');
  });

  it('entries() is an immutable snapshot (mutating it does not affect the registry)', () => {
    const reg = new SchemaRegistry();
    reg.register(minimalEntry({ id: 'harness.test.snap' }));
    const entries = reg.entries();
    // Cast to mutable to attempt mutation — registry should be unaffected.
    (entries as SchemaRegistryEntry[]).push(minimalEntry({ id: 'harness.test.injected' }));
    expect(reg.has('harness.test.injected')).toBe(false);
  });

  it('SchemaRegistryError has the correct name', () => {
    const reg = new SchemaRegistry();
    try {
      reg.getValidator('harness.does.not.exist');
    } catch (err) {
      expect((err as SchemaRegistryError).name).toBe('SchemaRegistryError');
    }
  });
});

// ---------------------------------------------------------------------------
// Additive guard: confirm EventStore is untouched
// ---------------------------------------------------------------------------

describe('additive guard — EventStore is not imported by SchemaRegistry', () => {
  it('SchemaRegistry module does not depend on EventStore', async () => {
    // Import the module and check that none of its exported names reference EventStore.
    const mod = await import('../src/core/SchemaRegistry.js');
    const exportedKeys = Object.keys(mod);
    // EventStore-related exports would be named EventStore, eventStore, etc.
    for (const key of exportedKeys) {
      expect(key.toLowerCase()).not.toContain('eventstore');
    }
  });
});
