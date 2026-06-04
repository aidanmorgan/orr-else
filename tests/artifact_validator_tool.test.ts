/**
 * pi-experiment-0yt5.22 — harness-side tests for the GENERIC, harness-owned
 * artifact_validator built-in tool and its SELF-registered verify().
 *
 * AC1: the generic verify() has NO cerdiwen-specific artifact names (asserted by
 *      the bead grep; here we additionally exercise it with arbitrary names).
 * AC2: the harness SELF-registers artifact_validator's verify() at load —
 *      verifier.has('artifact_validator') is true after harness bootstrap WITHOUT
 *      a consumer extension loaded.
 * AC3: the verify() reads declared artifacts via VerifyContext.artifacts (PATHS
 *      ONLY) and returns NOT_APPLICABLE when the relevant artifact is absent,
 *      PASS on valid presence/shape, FAIL on missing/malformed (NA / PASS / FAIL).
 * Determinism: same context ⇒ same verdict; pure (no LLM/network/subprocess).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { verifier, VerifyVerdict, type VerifyContext } from '../src/contract.js';
import { ARTIFACT_VALIDATOR_TOOL, artifactValidatorVerify } from '../src/tools/artifact_validator.js';

function ctxWith(artifacts: Record<string, string>): VerifyContext {
  return {
    beadId: 'bead-1',
    stateId: 'state-1',
    actionId: 'action-1',
    writeSet: [],
    artifacts,
    toolOutputs: {}
  };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-validator-harness-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('AC2: the harness self-registers artifact_validator verify() at load (no consumer extension)', () => {
  it('verifier has an artifact_validator entry after merely importing the harness built-in tools barrel', async () => {
    // Importing src/tools/index.js (the harness built-in bootstrap) self-registers
    // artifact_validator's verify() as an import side effect — no consumer extension.
    await import('../src/tools/index.js');
    expect(verifier.has(ARTIFACT_VALIDATOR_TOOL)).toBe(true);
    expect(verifier.get(ARTIFACT_VALIDATOR_TOOL)).toBe(artifactValidatorVerify);
  });
});

describe('AC3: artifactValidatorVerify() — NOT_APPLICABLE absent, PASS valid, FAIL malformed', () => {
  it('NOT_APPLICABLE: when no artifacts are declared for the transition', () => {
    const result = artifactValidatorVerify(ctxWith({}));
    expect(result.verdict).toBe(VerifyVerdict.NOT_APPLICABLE);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('NOT_APPLICABLE: when the only declared artifact is absent on disk', () => {
    const result = artifactValidatorVerify(ctxWith({ someArtifact: '/no/such/artifact.json' }));
    expect(result.verdict).toBe(VerifyVerdict.NOT_APPLICABLE);
  });

  it('NOT_APPLICABLE: when the declared artifact path is an empty file', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'empty.json');
      fs.writeFileSync(file, '');
      const result = artifactValidatorVerify(ctxWith({ someArtifact: file }));
      expect(result.verdict).toBe(VerifyVerdict.NOT_APPLICABLE);
    });
  });

  it('PASS: when a declared artifact is present and parses as valid JSON', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'artifact.json');
      fs.writeFileSync(file, JSON.stringify({ anyShape: true, nested: [1, 2, 3] }));
      const result = artifactValidatorVerify(ctxWith({ someArtifact: file }));
      expect(result.verdict).toBe(VerifyVerdict.PASS);
      expect(result.reasons.some((r) => r.includes('well-formed'))).toBe(true);
    });
  });

  it('PASS: a non-empty non-JSON artifact (plain text) is accepted on the generic shape check', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'artifact.txt');
      fs.writeFileSync(file, 'some plain-text artifact content\n');
      const result = artifactValidatorVerify(ctxWith({ textArtifact: file }));
      expect(result.verdict).toBe(VerifyVerdict.PASS);
    });
  });

  it('PASS: at least one present+valid artifact passes even when another declared artifact is absent', () => {
    withTempDir((dir) => {
      const present = path.join(dir, 'present.json');
      fs.writeFileSync(present, JSON.stringify({ ok: true }));
      const result = artifactValidatorVerify(
        ctxWith({ present, missing: path.join(dir, 'missing.json') })
      );
      expect(result.verdict).toBe(VerifyVerdict.PASS);
    });
  });

  it('FAIL: when a present declared artifact looks like JSON but is malformed', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'broken.json');
      fs.writeFileSync(file, '{ "unterminated": ');
      const result = artifactValidatorVerify(ctxWith({ someArtifact: file }));
      expect(result.verdict).toBe(VerifyVerdict.FAIL);
      expect(result.failureOutcome).toBeDefined();
    });
  });

  it('FAIL: when a present declared artifact is whitespace-only despite a non-empty file', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'ws.txt');
      fs.writeFileSync(file, '   \n  \t\n');
      const result = artifactValidatorVerify(ctxWith({ someArtifact: file }));
      expect(result.verdict).toBe(VerifyVerdict.FAIL);
    });
  });
});

describe('determinism: artifactValidatorVerify is pure given a paths-only context', () => {
  it('same context yields an identical verdict on repeated calls', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'artifact.json');
      fs.writeFileSync(file, JSON.stringify({ ok: true }));
      const ctx = ctxWith({ a: file });
      expect(artifactValidatorVerify(ctx)).toEqual(artifactValidatorVerify(ctx));
    });
  });
});
