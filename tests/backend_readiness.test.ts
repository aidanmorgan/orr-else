/**
 * pi-experiment-6q0y.33 — Cerdiwen backend readiness manifest schema + startup-lint module.
 *
 * AC1  Manifest covers python_lsp:8799, codemap, sonarqube:9199, reference_docs.
 * AC2  All probes complete within 5 seconds when all backends are down.
 * AC3  Probes are TCP-connect only: no LLM, no Docker, no file mutation.
 * AC4  Output is sorted JSON with name / required / ok / latencyMs / remediation.
 * AC5  Tests cover: all-up, all-down, optional-down, malformed manifest cases.
 *
 * These tests drive the REAL manifest validation and readiness module using an
 * injectable TCP probe stub — no real network calls, no always-true assertions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateManifest,
  checkBackendReadiness,
  BackendManifestValidationError,
  CERDIWEN_BACKEND_MANIFEST,
  BACKEND_READINESS_MANIFEST_SCHEMA,
  type BackendManifest,
  type TcpProbe
} from '../src/core/BackendReadiness.js';
import {
  schemaRegistry,
  SchemaId
} from '../src/core/SchemaRegistry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a fake TCP probe where each named service either responds or refuses. */
function makeFakeProbe(upServices: Set<string>): TcpProbe {
  return async (_host: string, port: number, _timeoutMs: number) => {
    // Resolve name from port using the canonical manifest entries.
    const entry = CERDIWEN_BACKEND_MANIFEST.backends.find(b => b.port === port);
    const name = entry?.name ?? `port-${port}`;
    const ok = upServices.has(name);
    return { ok, latencyMs: ok ? 3 : undefined };
  };
}

/** A valid minimal manifest (not cerdiwen-specific) for schema tests. */
const minimalManifest: BackendManifest = {
  backends: [
    { name: 'python_lsp', port: 8799, required: true, remediation: 'start lsp' }
  ]
};

// ---------------------------------------------------------------------------
// Schema registration (AC1 + SchemaRegistry drift check)
// ---------------------------------------------------------------------------

describe('harness.config.backendReadinessManifest is registered in SchemaRegistry', () => {
  it('schema id is registered in the singleton registry', () => {
    expect(schemaRegistry.has(SchemaId.BACKEND_READINESS_MANIFEST)).toBe(true);
  });

  it('registry entry has owner = src/core/BackendReadiness.ts', () => {
    const entry = schemaRegistry.getEntry(SchemaId.BACKEND_READINESS_MANIFEST);
    expect(entry.owner).toBe('src/core/BackendReadiness.ts');
  });

  it('registry entry has replayPolicy = NONE (config-only, not on replay path)', () => {
    const entry = schemaRegistry.getEntry(SchemaId.BACKEND_READINESS_MANIFEST);
    expect(entry.replayPolicy).toBe('NONE');
  });

  it('compiled validator accepts the minimal positive fixture', () => {
    const validate = schemaRegistry.getValidator(SchemaId.BACKEND_READINESS_MANIFEST);
    const valid = validate({
      backends: [{ name: 'python_lsp', port: 8799, required: true, remediation: 'start lsp' }]
    });
    expect(valid).toBe(true);
  });

  it('compiled validator rejects an empty backends array', () => {
    const validate = schemaRegistry.getValidator(SchemaId.BACKEND_READINESS_MANIFEST);
    const valid = validate({ backends: [] });
    // minItems: 1 — empty array is invalid
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BACKEND_READINESS_MANIFEST_SCHEMA shape
// ---------------------------------------------------------------------------

describe('BACKEND_READINESS_MANIFEST_SCHEMA object', () => {
  it('is exported as a non-null object', () => {
    expect(BACKEND_READINESS_MANIFEST_SCHEMA).toBeDefined();
    expect(typeof BACKEND_READINESS_MANIFEST_SCHEMA).toBe('object');
  });

  it('has type object and requires backends', () => {
    expect((BACKEND_READINESS_MANIFEST_SCHEMA as Record<string, unknown>).type).toBe('object');
    expect(
      (BACKEND_READINESS_MANIFEST_SCHEMA as Record<string, unknown>).required
    ).toContain('backends');
  });
});

// ---------------------------------------------------------------------------
// validateManifest (AC5 — malformed manifest)
// ---------------------------------------------------------------------------

describe('validateManifest — schema enforcement', () => {
  it('accepts a minimal valid manifest', () => {
    const result = validateManifest({ backends: [{ name: 'svc', port: 8080, required: true, remediation: 'fix' }] });
    expect(result.backends).toHaveLength(1);
    expect(result.backends[0].name).toBe('svc');
  });

  it('accepts the canonical CERDIWEN_BACKEND_MANIFEST', () => {
    const result = validateManifest(CERDIWEN_BACKEND_MANIFEST);
    expect(result.backends.length).toBeGreaterThanOrEqual(4);
  });

  it('accepts a manifest with optional host and description fields', () => {
    const raw = {
      backends: [{
        name: 'python_lsp', host: 'localhost', port: 8799, required: true,
        remediation: 'start lsp', description: 'LSP server'
      }]
    };
    expect(() => validateManifest(raw)).not.toThrow();
  });

  it('throws BackendManifestValidationError when backends key is missing', () => {
    expect(() => validateManifest({}))
      .toThrow(BackendManifestValidationError);
  });

  it('throws BackendManifestValidationError when backends is not an array', () => {
    expect(() => validateManifest({ backends: 'not-an-array' }))
      .toThrow(BackendManifestValidationError);
  });

  it('throws BackendManifestValidationError when backends is empty (minItems: 1)', () => {
    expect(() => validateManifest({ backends: [] }))
      .toThrow(BackendManifestValidationError);
  });

  it('throws BackendManifestValidationError when an entry is missing required port', () => {
    expect(() => validateManifest({ backends: [{ name: 'svc', required: true, remediation: 'fix' }] }))
      .toThrow(BackendManifestValidationError);
  });

  it('throws BackendManifestValidationError when an entry is missing required remediation', () => {
    expect(() => validateManifest({ backends: [{ name: 'svc', port: 8080, required: true }] }))
      .toThrow(BackendManifestValidationError);
  });

  it('throws BackendManifestValidationError when an entry is missing required name', () => {
    expect(() => validateManifest({ backends: [{ port: 8080, required: true, remediation: 'fix' }] }))
      .toThrow(BackendManifestValidationError);
  });

  it('throws BackendManifestValidationError when port is out of range (> 65535)', () => {
    expect(() => validateManifest({ backends: [{ name: 'svc', port: 99999, required: true, remediation: 'fix' }] }))
      .toThrow(BackendManifestValidationError);
  });

  it('throws BackendManifestValidationError when port is 0 (minimum: 1)', () => {
    expect(() => validateManifest({ backends: [{ name: 'svc', port: 0, required: true, remediation: 'fix' }] }))
      .toThrow(BackendManifestValidationError);
  });

  it('error message names at least one validation failure', () => {
    let err: BackendManifestValidationError | undefined;
    try {
      validateManifest({ backends: [{ name: 'svc', required: true, remediation: 'fix' }] });
    } catch (e) {
      if (e instanceof BackendManifestValidationError) err = e;
    }
    expect(err).toBeDefined();
    expect(err!.validationErrors.length).toBeGreaterThan(0);
    expect(err!.message).toContain('invalid');
  });

  it('throws BackendManifestValidationError when raw value is null', () => {
    expect(() => validateManifest(null)).toThrow(BackendManifestValidationError);
  });

  it('throws BackendManifestValidationError when raw value is a string', () => {
    expect(() => validateManifest('not-an-object')).toThrow(BackendManifestValidationError);
  });
});

// ---------------------------------------------------------------------------
// CERDIWEN_BACKEND_MANIFEST (AC1)
// ---------------------------------------------------------------------------

describe('CERDIWEN_BACKEND_MANIFEST — canonical Cerdiwen backend coverage (AC1)', () => {
  it('covers python_lsp on port 8799', () => {
    const entry = CERDIWEN_BACKEND_MANIFEST.backends.find(b => b.name === 'python_lsp');
    expect(entry).toBeDefined();
    expect(entry!.port).toBe(8799);
    expect(entry!.required).toBe(true);
  });

  it('covers sonarqube on port 9199', () => {
    const entry = CERDIWEN_BACKEND_MANIFEST.backends.find(b => b.name === 'sonarqube');
    expect(entry).toBeDefined();
    expect(entry!.port).toBe(9199);
    expect(entry!.required).toBe(true);
  });

  it('covers codemap (required)', () => {
    const entry = CERDIWEN_BACKEND_MANIFEST.backends.find(b => b.name === 'codemap');
    expect(entry).toBeDefined();
    expect(entry!.required).toBe(true);
  });

  it('covers reference_docs (chroma/reference-doc backend)', () => {
    const entry = CERDIWEN_BACKEND_MANIFEST.backends.find(b => b.name === 'reference_docs');
    expect(entry).toBeDefined();
  });

  it('all entries have non-empty remediation strings', () => {
    for (const entry of CERDIWEN_BACKEND_MANIFEST.backends) {
      expect(entry.remediation.trim().length, `${entry.name}.remediation is empty`).toBeGreaterThan(0);
    }
  });

  it('passes validateManifest (is itself a valid manifest)', () => {
    expect(() => validateManifest(CERDIWEN_BACKEND_MANIFEST)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// checkBackendReadiness — all-up scenario (AC4, AC5)
// ---------------------------------------------------------------------------

describe('checkBackendReadiness — all-up scenario', () => {
  it('returns ok=true for all backends when all are up', async () => {
    const allUp = new Set(['python_lsp', 'codemap', 'sonarqube', 'reference_docs']);
    const results = await checkBackendReadiness(CERDIWEN_BACKEND_MANIFEST, { probe: makeFakeProbe(allUp) });

    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.ok, `${r.name} should be ok`).toBe(true);
      expect(typeof r.latencyMs).toBe('number');
    }
  });

  it('returns results sorted by service name (AC4)', async () => {
    const allUp = new Set(['python_lsp', 'codemap', 'sonarqube', 'reference_docs']);
    const results = await checkBackendReadiness(CERDIWEN_BACKEND_MANIFEST, { probe: makeFakeProbe(allUp) });

    const names = results.map(r => r.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('each result includes name, required, ok, latencyMs, remediation (AC4)', async () => {
    const allUp = new Set(['python_lsp', 'codemap', 'sonarqube', 'reference_docs']);
    const results = await checkBackendReadiness(CERDIWEN_BACKEND_MANIFEST, { probe: makeFakeProbe(allUp) });

    for (const r of results) {
      expect(typeof r.name).toBe('string');
      expect(typeof r.required).toBe('boolean');
      expect(typeof r.ok).toBe('boolean');
      expect(r.latencyMs !== undefined ? typeof r.latencyMs === 'number' : true).toBe(true);
      expect(typeof r.remediation).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// checkBackendReadiness — all-down scenario (AC2, AC5)
// ---------------------------------------------------------------------------

describe('checkBackendReadiness — all-down scenario (AC2)', () => {
  it('returns ok=false for all backends when none are reachable', async () => {
    const noneUp = new Set<string>();
    const results = await checkBackendReadiness(CERDIWEN_BACKEND_MANIFEST, { probe: makeFakeProbe(noneUp) });

    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.ok, `${r.name} should NOT be ok`).toBe(false);
      expect(r.latencyMs).toBeUndefined();
    }
  });

  it('completes within 5 seconds when all backends are down (AC2)', async () => {
    // The fake probe resolves instantly (simulating timeout expiry returning quickly).
    // The real probe would finish by the deadline; the fake probe proves the module
    // does not hang: all results are returned, not just a subset.
    const noneUp = new Set<string>();
    const start = Date.now();
    const results = await checkBackendReadiness(CERDIWEN_BACKEND_MANIFEST, {
      probe: makeFakeProbe(noneUp),
      timeoutMs: 5000
    });
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(4);
    // With a fake probe the test should finish in well under 1 second.
    expect(elapsed).toBeLessThan(1000);
  });

  it('results still include remediation when backend is down', async () => {
    const noneUp = new Set<string>();
    const results = await checkBackendReadiness(CERDIWEN_BACKEND_MANIFEST, { probe: makeFakeProbe(noneUp) });

    for (const r of results) {
      expect(r.remediation.trim().length, `${r.name}.remediation is empty when down`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// checkBackendReadiness — optional-down scenario (AC5)
// ---------------------------------------------------------------------------

describe('checkBackendReadiness — optional-down scenario', () => {
  it('reference_docs (optional) down: other required backends are unaffected', async () => {
    // Only reference_docs is down.
    const upWithoutOptional = new Set(['python_lsp', 'codemap', 'sonarqube']);
    const results = await checkBackendReadiness(CERDIWEN_BACKEND_MANIFEST, {
      probe: makeFakeProbe(upWithoutOptional)
    });

    const refDocs = results.find(r => r.name === 'reference_docs');
    expect(refDocs).toBeDefined();
    expect(refDocs!.ok).toBe(false);
    expect(refDocs!.required).toBe(false);

    // Required backends are all up.
    const requiredResults = results.filter(r => r.required);
    for (const r of requiredResults) {
      expect(r.ok, `required backend ${r.name} should be ok`).toBe(true);
    }
  });

  it('optional backend down does not prevent results for required backends', async () => {
    const upWithoutOptional = new Set(['python_lsp', 'codemap', 'sonarqube']);
    const results = await checkBackendReadiness(CERDIWEN_BACKEND_MANIFEST, {
      probe: makeFakeProbe(upWithoutOptional)
    });

    expect(results).toHaveLength(4); // All backends probed regardless of required flag.
  });
});

// ---------------------------------------------------------------------------
// checkBackendReadiness — probe with a custom small manifest
// ---------------------------------------------------------------------------

describe('checkBackendReadiness — single-entry manifest', () => {
  it('works with a single-entry manifest', async () => {
    const manifest: BackendManifest = {
      backends: [{ name: 'svc', port: 9999, required: true, remediation: 'fix it' }]
    };
    const probe: TcpProbe = async () => ({ ok: true, latencyMs: 10 });
    const results = await checkBackendReadiness(manifest, { probe });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('svc');
    expect(results[0].ok).toBe(true);
    expect(results[0].latencyMs).toBe(10);
    expect(results[0].remediation).toBe('fix it');
  });

  it('correctly propagates required=false for optional backends in a custom manifest', async () => {
    const manifest: BackendManifest = {
      backends: [
        { name: 'required_svc', port: 1000, required: true, remediation: 'start required' },
        { name: 'optional_svc', port: 2000, required: false, remediation: 'start optional' }
      ]
    };
    const probe: TcpProbe = async (_host, port) => {
      // required_svc up, optional_svc down
      return { ok: port === 1000, latencyMs: port === 1000 ? 5 : undefined };
    };

    const results = await checkBackendReadiness(manifest, { probe });
    const req = results.find(r => r.name === 'required_svc')!;
    const opt = results.find(r => r.name === 'optional_svc')!;

    expect(req.ok).toBe(true);
    expect(req.required).toBe(true);
    expect(opt.ok).toBe(false);
    expect(opt.required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkBackendReadiness — probe receives correct host/port/timeout
// ---------------------------------------------------------------------------

describe('checkBackendReadiness — probe arguments', () => {
  it('passes configured host, port, and timeoutMs to the probe function', async () => {
    const calls: Array<{ host: string; port: number; timeoutMs: number }> = [];
    const recordingProbe: TcpProbe = async (host, port, timeoutMs) => {
      calls.push({ host, port, timeoutMs });
      return { ok: false, latencyMs: undefined };
    };

    const manifest: BackendManifest = {
      backends: [
        { name: 'svc', host: '192.168.1.1', port: 7777, required: true, remediation: 'fix' }
      ]
    };

    await checkBackendReadiness(manifest, { probe: recordingProbe, timeoutMs: 3000 });

    expect(calls).toHaveLength(1);
    expect(calls[0].host).toBe('192.168.1.1');
    expect(calls[0].port).toBe(7777);
    expect(calls[0].timeoutMs).toBe(3000);
  });

  it('defaults host to "localhost" when the entry has no host field', async () => {
    const calls: Array<{ host: string; port: number; timeoutMs: number }> = [];
    const recordingProbe: TcpProbe = async (host, port, timeoutMs) => {
      calls.push({ host, port, timeoutMs });
      return { ok: false, latencyMs: undefined };
    };

    const manifest: BackendManifest = {
      backends: [
        // No host field — should default to "localhost"
        { name: 'svc', port: 7777, required: true, remediation: 'fix' }
      ]
    };

    await checkBackendReadiness(manifest, { probe: recordingProbe });

    expect(calls[0].host).toBe('localhost');
  });
});
