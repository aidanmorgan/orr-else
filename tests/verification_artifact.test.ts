import { describe, it, expect } from 'vitest';
import {
  VERIFICATION_ARTIFACT_SCHEMA_VERSION,
  VERIFICATION_ARTIFACT_SCHEMA,
  validateVerificationArtifact,
  buildVerificationArtifact,
  type VerificationArtifact
} from '../src/core/VerificationArtifact.js';

// ---- Helpers ----

function conformantArtifact(overrides: Partial<VerificationArtifact> = {}): unknown {
  return {
    schemaVersion: VERIFICATION_ARTIFACT_SCHEMA_VERSION,
    verdict: 'pass',
    tool: 'run_quality_checks',
    counts: { blocking: 0, total: 0, warnings: 0 },
    ...overrides
  };
}

// ---- validateVerificationArtifact ----

describe('validateVerificationArtifact', () => {
  describe('valid artifacts', () => {
    it('accepts a minimal conformant artifact (pass verdict)', () => {
      const result = validateVerificationArtifact(conformantArtifact());
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.artifact.verdict).toBe('pass');
        expect(result.artifact.schemaVersion).toBe(VERIFICATION_ARTIFACT_SCHEMA_VERSION);
        expect(result.artifact.tool).toBe('run_quality_checks');
        expect(result.artifact.counts.blocking).toBe(0);
      }
    });

    it('accepts a fail verdict', () => {
      const result = validateVerificationArtifact(conformantArtifact({ verdict: 'fail' }));
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.artifact.verdict).toBe('fail');
      }
    });

    it('accepts an artifact with only required counts.blocking', () => {
      const result = validateVerificationArtifact({
        schemaVersion: VERIFICATION_ARTIFACT_SCHEMA_VERSION,
        verdict: 'pass',
        tool: 'artifact_validator',
        counts: { blocking: 0 }
      });
      expect(result.valid).toBe(true);
    });

    it('accepts optional evidenceRefs as an array of strings', () => {
      const result = validateVerificationArtifact(
        conformantArtifact({ evidenceRefs: ['ref-abc123', 'ref-def456'] })
      );
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.artifact.evidenceRefs).toEqual(['ref-abc123', 'ref-def456']);
      }
    });

    it('accepts optional createdAtMs as a number', () => {
      const ts = 1_700_000_000_000;
      const result = validateVerificationArtifact(conformantArtifact({ createdAtMs: ts }));
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.artifact.createdAtMs).toBe(ts);
      }
    });

    it('accepts optional counts.passed and counts.total', () => {
      const result = validateVerificationArtifact({
        schemaVersion: VERIFICATION_ARTIFACT_SCHEMA_VERSION,
        verdict: 'pass',
        tool: 'run_quality_checks',
        counts: { blocking: 0, total: 10, warnings: 2, passed: 8 }
      });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.artifact.counts.total).toBe(10);
        expect(result.artifact.counts.passed).toBe(8);
        expect(result.artifact.counts.warnings).toBe(2);
      }
    });

    it('preserves additional top-level properties (additionalProperties: true)', () => {
      const result = validateVerificationArtifact({
        schemaVersion: VERIFICATION_ARTIFACT_SCHEMA_VERSION,
        verdict: 'pass',
        tool: 'custom_verifier',
        counts: { blocking: 0 },
        extraField: 'ignored-by-validator-but-returned-in-artifact'
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('missing required fields', () => {
    it('rejects a null value', () => {
      const result = validateVerificationArtifact(null);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]).toMatch(/root.*must be a non-null object/);
      }
    });

    it('rejects a non-object value', () => {
      const result = validateVerificationArtifact('not-an-object');
      expect(result.valid).toBe(false);
    });

    it('rejects when schemaVersion is missing', () => {
      const { schemaVersion: _, ...rest } = conformantArtifact() as Record<string, unknown>;
      const result = validateVerificationArtifact(rest);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('schemaVersion'))).toBe(true);
      }
    });

    it('rejects when verdict is missing', () => {
      const { verdict: _, ...rest } = conformantArtifact() as Record<string, unknown>;
      const result = validateVerificationArtifact(rest);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('verdict'))).toBe(true);
      }
    });

    it('rejects when tool is missing', () => {
      const { tool: _, ...rest } = conformantArtifact() as Record<string, unknown>;
      const result = validateVerificationArtifact(rest);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('tool'))).toBe(true);
      }
    });

    it('rejects when counts is missing', () => {
      const { counts: _, ...rest } = conformantArtifact() as Record<string, unknown>;
      const result = validateVerificationArtifact(rest);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('counts'))).toBe(true);
      }
    });

    it('rejects when counts.blocking is missing', () => {
      const result = validateVerificationArtifact({
        schemaVersion: VERIFICATION_ARTIFACT_SCHEMA_VERSION,
        verdict: 'pass',
        tool: 'run_quality_checks',
        counts: { total: 0 }
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('counts.blocking'))).toBe(true);
      }
    });
  });

  describe('wrong types', () => {
    it('rejects non-string schemaVersion', () => {
      const result = validateVerificationArtifact(conformantArtifact({ schemaVersion: 42 as unknown as string }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('schemaVersion'))).toBe(true);
      }
    });

    it('rejects empty string tool', () => {
      const result = validateVerificationArtifact(conformantArtifact({ tool: '' }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('tool'))).toBe(true);
      }
    });

    it('rejects non-object counts', () => {
      const result = validateVerificationArtifact(conformantArtifact({ counts: 'bad' as unknown as VerificationArtifact['counts'] }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('counts'))).toBe(true);
      }
    });

    it('rejects non-integer counts.blocking', () => {
      const result = validateVerificationArtifact(conformantArtifact({ counts: { blocking: 1.5 } }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('counts.blocking'))).toBe(true);
      }
    });
  });

  describe('bad verdict', () => {
    it('rejects an unrecognized verdict value', () => {
      const result = validateVerificationArtifact(
        conformantArtifact({ verdict: 'unknown' as unknown as 'pass' | 'fail' })
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('verdict'))).toBe(true);
      }
    });

    it('rejects verdict=passed (old harness string, not in schema)', () => {
      const result = validateVerificationArtifact(
        conformantArtifact({ verdict: 'passed' as unknown as 'pass' | 'fail' })
      );
      expect(result.valid).toBe(false);
    });
  });

  describe('negative counts', () => {
    it('rejects negative counts.blocking', () => {
      const result = validateVerificationArtifact(conformantArtifact({ counts: { blocking: -1 } }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('counts.blocking'))).toBe(true);
      }
    });

    it('rejects negative counts.total when present', () => {
      const result = validateVerificationArtifact(
        conformantArtifact({ counts: { blocking: 0, total: -5 } })
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('counts.total'))).toBe(true);
      }
    });

    it('rejects negative counts.warnings when present', () => {
      const result = validateVerificationArtifact(
        conformantArtifact({ counts: { blocking: 0, warnings: -1 } })
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('counts.warnings'))).toBe(true);
      }
    });
  });

  describe('invalid optional fields', () => {
    it('rejects evidenceRefs that is not an array', () => {
      const result = validateVerificationArtifact(
        conformantArtifact({ evidenceRefs: 'not-array' as unknown as string[] })
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('evidenceRefs'))).toBe(true);
      }
    });

    it('rejects evidenceRefs containing non-string items', () => {
      const result = validateVerificationArtifact(
        conformantArtifact({ evidenceRefs: [42] as unknown as string[] })
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('evidenceRefs[0]'))).toBe(true);
      }
    });

    it('rejects non-numeric createdAtMs', () => {
      const result = validateVerificationArtifact(
        conformantArtifact({ createdAtMs: 'not-a-number' as unknown as number })
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.includes('createdAtMs'))).toBe(true);
      }
    });
  });

  describe('structured errors', () => {
    it('accumulates multiple field errors in a single result', () => {
      const result = validateVerificationArtifact({
        schemaVersion: '',
        verdict: 'bad',
        tool: '',
        counts: { blocking: -1 }
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.length).toBeGreaterThanOrEqual(3);
      }
    });
  });
});

// ---- buildVerificationArtifact ----

describe('buildVerificationArtifact', () => {
  it('produces a conformant artifact from minimal input', () => {
    const artifact = buildVerificationArtifact({
      verdict: 'pass',
      counts: { blocking: 0 }
    });
    const validation = validateVerificationArtifact(artifact);
    expect(validation.valid).toBe(true);
  });

  it('produces a conformant artifact for a failed run with counts', () => {
    const artifact = buildVerificationArtifact({
      verdict: 'fail',
      counts: { blocking: 3, total: 10, warnings: 7 },
      tool: 'artifact_validator'
    });
    const validation = validateVerificationArtifact(artifact);
    expect(validation.valid).toBe(true);
    if (validation.valid) {
      expect(validation.artifact.verdict).toBe('fail');
      expect(validation.artifact.counts.blocking).toBe(3);
      expect(validation.artifact.counts.total).toBe(10);
      expect(validation.artifact.counts.warnings).toBe(7);
      expect(validation.artifact.tool).toBe('artifact_validator');
    }
  });

  it('uses run_quality_checks as default tool', () => {
    const artifact = buildVerificationArtifact({ verdict: 'pass', counts: { blocking: 0 } });
    expect(artifact.tool).toBe('run_quality_checks');
  });

  it('sets schemaVersion to the current constant', () => {
    const artifact = buildVerificationArtifact({ verdict: 'pass', counts: { blocking: 0 } });
    expect(artifact.schemaVersion).toBe(VERIFICATION_ARTIFACT_SCHEMA_VERSION);
  });

  it('attaches evidenceRefs when provided', () => {
    const artifact = buildVerificationArtifact({
      verdict: 'pass',
      counts: { blocking: 0 },
      evidenceRefs: ['ref-abc']
    });
    expect(artifact.evidenceRefs).toEqual(['ref-abc']);
    const validation = validateVerificationArtifact(artifact);
    expect(validation.valid).toBe(true);
  });

  it('omits evidenceRefs when the input array is empty', () => {
    const artifact = buildVerificationArtifact({
      verdict: 'pass',
      counts: { blocking: 0 },
      evidenceRefs: []
    });
    expect(artifact.evidenceRefs).toBeUndefined();
  });

  it('uses the provided createdAtMs override', () => {
    const ts = 1_700_000_000_000;
    const artifact = buildVerificationArtifact({
      verdict: 'pass',
      counts: { blocking: 0 },
      createdAtMs: ts
    });
    expect(artifact.createdAtMs).toBe(ts);
  });

  it('sets a createdAtMs timestamp when not overridden', () => {
    const before = Date.now();
    const artifact = buildVerificationArtifact({ verdict: 'pass', counts: { blocking: 0 } });
    const after = Date.now();
    expect(artifact.createdAtMs).toBeGreaterThanOrEqual(before);
    expect(artifact.createdAtMs).toBeLessThanOrEqual(after);
  });
});

// ---- VERIFICATION_ARTIFACT_SCHEMA ----

describe('VERIFICATION_ARTIFACT_SCHEMA', () => {
  it('declares the expected required fields', () => {
    const required = VERIFICATION_ARTIFACT_SCHEMA.required as readonly string[];
    expect(required).toContain('schemaVersion');
    expect(required).toContain('verdict');
    expect(required).toContain('tool');
    expect(required).toContain('counts');
  });

  it('has a schemaVersion property in its properties', () => {
    expect(VERIFICATION_ARTIFACT_SCHEMA.properties.schemaVersion).toBeDefined();
    expect(VERIFICATION_ARTIFACT_SCHEMA.properties.schemaVersion.type).toBe('string');
  });

  it('constrains verdict to pass|fail enum', () => {
    const verdictEnum = VERIFICATION_ARTIFACT_SCHEMA.properties.verdict.enum;
    expect(verdictEnum).toContain('pass');
    expect(verdictEnum).toContain('fail');
    expect(verdictEnum).toHaveLength(2);
  });

  it('requires counts.blocking in the counts sub-schema', () => {
    const countsRequired = VERIFICATION_ARTIFACT_SCHEMA.properties.counts.required as readonly string[];
    expect(countsRequired).toContain('blocking');
  });

  it('uses the current VERIFICATION_ARTIFACT_SCHEMA_VERSION in the schemaVersion description', () => {
    expect(VERIFICATION_ARTIFACT_SCHEMA.properties.schemaVersion.description).toContain(
      VERIFICATION_ARTIFACT_SCHEMA_VERSION
    );
  });

  it('has a $schema property identifying it as a JSON Schema document', () => {
    expect(VERIFICATION_ARTIFACT_SCHEMA.$schema).toContain('json-schema.org');
  });
});
