/**
 * configLoader_v1_legacy_statechart.test.ts
 *
 * pi-experiment-nkiq: Reject explicit legacy-v1 statechart configs missing terminalStates.
 *
 * AC1: An explicit legacy v1 config (version: 1) that declares a statechart block
 *      but omits terminalStates is REJECTED with a deterministic diagnostic via
 *      preValidateV2Admission.
 * AC2: Versionless project configs are NOT admitted through the explicit-v1 path;
 *      they skip the explicit-v1 check (absent version → no-op in preValidateV2Admission).
 *      The v2 default-discovery flip has NOT yet landed — versionless configs still
 *      pass through to v1 semantics.
 * AC3: v2 configs using statechart.terminal remain unaffected.
 * AC4: Explicit v1 fixtures that declare terminalStates are admitted by
 *      preValidateV2Admission (valid inside migration/legacy validation tests).
 *      Note: ConfigLoader.load() would still reject them at AJV schema validation
 *      (schema const: 2); this bead covers only the preValidateV2Admission path.
 * AC5: Tests cover all four cases:
 *   - explicit-v1-missing-terminalStates rejection (AC1)
 *   - explicit-v1-with-terminalStates success (AC4)
 *   - versionless skips explicit-v1 check (AC2)
 *   - valid v2 statechart.terminal admission (AC3)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigValidator } from '../src/core/ConfigValidator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nkiq-'));
}

// ---------------------------------------------------------------------------
// AC1: explicit v1 statechart block missing terminalStates → REJECTED
// ---------------------------------------------------------------------------
describe('pi-experiment-nkiq: explicit v1 statechart missing terminalStates (AC1)', () => {
  let dir: string;
  let validator: ConfigValidator;

  beforeEach(() => {
    dir = tmpDir();
    validator = new ConfigValidator(dir, () => path.join(dir, 'harness.yaml'));
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('AC1: version:1 + statechart block without terminalStates → rejected', () => {
    expect(() => validator.preValidateV2Admission({
      version: 1,
      settings: {},
      statechart: {
        advanceOutcomes: ['ADVANCE'],
        failedOutcomes: ['REWORK'],
        blockedOutcomes: ['HALT']
        // terminalStates intentionally absent
      }
    })).toThrow(/terminalStates/);
  });

  it('AC1: diagnostic message references terminalStates', () => {
    let caught: Error | undefined;
    try {
      validator.preValidateV2Admission({
        version: 1,
        settings: {},
        statechart: {
          advanceOutcomes: ['ADVANCE']
          // terminalStates absent
        }
      });
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/terminalStates/);
  });

  it('AC1: diagnostic message is deterministic (same message each call)', () => {
    const msg1 = (() => {
      try {
        validator.preValidateV2Admission({ version: 1, settings: {}, statechart: {} });
      } catch (e) { return (e as Error).message; }
      return '';
    })();
    const msg2 = (() => {
      try {
        validator.preValidateV2Admission({ version: 1, settings: {}, statechart: {} });
      } catch (e) { return (e as Error).message; }
      return '';
    })();

    expect(msg1).toBe(msg2);
    expect(msg1).toMatch(/terminalStates/);
  });

  it('AC1: version:1 + statechart with null terminalStates → rejected', () => {
    expect(() => validator.preValidateV2Admission({
      version: 1,
      settings: {},
      statechart: {
        terminalStates: null
      }
    })).toThrow(/terminalStates/);
  });

  it('AC1: version:1 + statechart with empty terminalStates array → rejected', () => {
    expect(() => validator.preValidateV2Admission({
      version: 1,
      settings: {},
      statechart: {
        terminalStates: []
      }
    })).toThrow(/terminalStates/);
  });
});

// ---------------------------------------------------------------------------
// AC4: explicit v1 fixtures with terminalStates declared → admitted by preValidateV2Admission
// ---------------------------------------------------------------------------
describe('pi-experiment-nkiq: explicit v1 with terminalStates declared (AC4)', () => {
  let dir: string;
  let validator: ConfigValidator;

  beforeEach(() => {
    dir = tmpDir();
    validator = new ConfigValidator(dir, () => path.join(dir, 'harness.yaml'));
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('AC4: version:1 + statechart with terminalStates → passes preValidateV2Admission', () => {
    expect(() => validator.preValidateV2Admission({
      version: 1,
      settings: {},
      statechart: {
        terminalStates: ['done'],
        advanceOutcomes: ['ADVANCE'],
        failedOutcomes: ['REWORK'],
        blockedOutcomes: ['HALT']
      }
    })).not.toThrow();
  });

  it('AC4: version:1 + statechart with multiple terminalStates → passes', () => {
    expect(() => validator.preValidateV2Admission({
      version: 1,
      settings: {},
      statechart: {
        terminalStates: ['completed', 'cancelled'],
        advanceOutcomes: ['SUCCESS'],
        failedOutcomes: ['FAILURE'],
        blockedOutcomes: ['BLOCKED']
      }
    })).not.toThrow();
  });

  it('AC4: version:1 without statechart block → passes (no statechart = no terminalStates check)', () => {
    expect(() => validator.preValidateV2Admission({
      version: 1,
      settings: {}
      // no statechart block
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC2: versionless configs skip the explicit-v1 terminalStates check.
//
// Absent version → no-op in preValidateV2Admission (v2 default-discovery flip
// has NOT yet landed; versionless configs continue through v1 semantics).
// ---------------------------------------------------------------------------
describe('pi-experiment-nkiq: versionless config is not the explicit-v1 path (AC2)', () => {
  let dir: string;
  let validator: ConfigValidator;

  beforeEach(() => {
    dir = tmpDir();
    validator = new ConfigValidator(dir, () => path.join(dir, 'harness.yaml'));
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('AC2: absent version + statechart without terminalStates → no-op in preValidateV2Admission', () => {
    // Absent version skips all preValidateV2Admission checks (no v1 terminalStates enforcement here)
    expect(() => validator.preValidateV2Admission({
      settings: {},
      statechart: {
        advanceOutcomes: ['ADVANCE']
        // terminalStates absent
      }
    })).not.toThrow();
  });

  it('AC2: absent version + full statechart → no-op in preValidateV2Admission', () => {
    expect(() => validator.preValidateV2Admission({
      settings: {},
      statechart: {
        terminalStates: ['done'],
        advanceOutcomes: ['ADVANCE'],
        failedOutcomes: ['REWORK'],
        blockedOutcomes: ['HALT']
      }
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC3: v2 configs using statechart.terminal remain unaffected
// ---------------------------------------------------------------------------
describe('pi-experiment-nkiq: v2 statechart.terminal is unaffected (AC3)', () => {
  let dir: string;
  let validator: ConfigValidator;

  beforeEach(() => {
    dir = tmpDir();
    validator = new ConfigValidator(dir, () => path.join(dir, 'harness.yaml'));
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('AC3: version:2 with statechart.terminal → passes preValidateV2Admission', () => {
    // A minimal v2 fixture: statechart.terminal declared, no terminalStates
    expect(() => validator.preValidateV2Admission({
      version: 2,
      settings: {},
      statechart: {
        initial: 'Alpha',
        terminal: ['completed']
      },
      events: {
        advance: ['SUCCESS'],
        failure: ['FAILURE'],
        blocked: ['BLOCKED'],
        neutral: []
      },
      states: {}
    })).not.toThrow();
  });

  it('AC3: version:2 with statechart.terminalStates → still rejected (v1 field in v2)', () => {
    // The existing v2 check: terminalStates is a removed v1 field in v2 configs
    expect(() => validator.preValidateV2Admission({
      version: 2,
      settings: {},
      statechart: {
        terminalStates: ['done']
      }
    })).toThrow(/statechart\.terminalStates/);
  });
});
