/**
 * pi-experiment-zog2.1 — ToolEvidenceHandle contract conformance tests.
 *
 * TDD-first: these tests define the contract before the implementation.
 * They prove:
 *   AC1: the typed handle has all required fields.
 *   AC2: execution status (runStatus) is distinct from verifier verdict
 *        (verifierVerdict), and model-facing raw output is forbidden.
 *   AC3: summaryMode distinguishes 'summary' (has rtkSummary) vs 'none'
 *        (has noSummaryReason). No LLM-generated summaries.
 *   AC4: invalid handles FAIL CLOSED — the validator rejects every
 *        known invalid shape.
 *   AC5: ToolResultBase is mapped as MIGRATION DEBT — the adapter exists,
 *        is clearly marked temporary, and does not replace a tool's own
 *        semantic path resolution.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
  validateToolEvidenceHandle,
  validateToolEvidenceArtifact,
  toolResultBaseToMigrationDebt,
  type ToolEvidenceHandle,
  type ToolEvidenceRunStatus,
  type ToolEvidenceSummaryMode,
  type ToolEvidenceVerifierVerdict,
} from '../src/core/ToolEvidenceHandle.js';
import type { ToolResultBase } from '../src/contract.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOL_OUTPUT_ROOT = '/project/.pi/tool-output';

function validHandle(overrides: Partial<ToolEvidenceHandle> = {}): unknown {
  const base: ToolEvidenceHandle = {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: 'run_quality_checks',
    invocationId: 'inv-abc-123',
    runStatus: 'PASSED',
    semanticArtifactPath: `${TOOL_OUTPUT_ROOT}/bead1/state1/action1/run_quality_checks/inv-abc-123/output/result.json`,
    semanticArtifactBytes: 1024,
    semanticArtifactSha256: 'a'.repeat(64),
    toolOutputRoot: TOOL_OUTPUT_ROOT,
    summaryMode: 'none',
    noSummaryReason: 'tool does not produce an RTK summary in this context',
    admittedHarnessFingerprint: 'sha256:abcdef1234567890',
    admittedExecutionBoundary: 'bead:bead1/state:state1/action:action1',
  };
  return { ...base, ...overrides };
}

function validHandleWithSummary(overrides: Partial<ToolEvidenceHandle> = {}): unknown {
  const base: ToolEvidenceHandle = {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: 'git_history',
    invocationId: 'inv-def-456',
    runStatus: 'PASSED',
    semanticArtifactPath: `${TOOL_OUTPUT_ROOT}/bead2/state2/action2/git_history/inv-def-456/output/result.json`,
    semanticArtifactBytes: 512,
    semanticArtifactSha256: 'b'.repeat(64),
    toolOutputRoot: TOOL_OUTPUT_ROOT,
    summaryMode: 'summary',
    rtkSummary: {
      schemaTypeName: 'GitHistoryRtkSummary',
      owningFile: 'src/tools/git_history.ts',
      summary: { commitCount: 5, authors: ['alice', 'bob'] }
    },
    admittedHarnessFingerprint: 'sha256:abcdef1234567890',
    admittedExecutionBoundary: 'bead:bead2/state:state2/action:action2',
  };
  return { ...base, ...overrides };
}

function validHandleRejected(overrides: Partial<ToolEvidenceHandle> = {}): unknown {
  const base: ToolEvidenceHandle = {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: 'run_quality_checks',
    invocationId: 'inv-xyz-789',
    runStatus: 'REJECTED',
    failureCategory: 'TIMEOUT',
    // REJECTED handles have no semantic artifact
    toolOutputRoot: TOOL_OUTPUT_ROOT,
    summaryMode: 'none',
    noSummaryReason: 'tool did not run to completion',
    admittedHarnessFingerprint: 'sha256:abcdef1234567890',
    admittedExecutionBoundary: 'bead:bead3/state:state3/action:action3',
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// AC1: the typed handle exists and has all required fields
// ---------------------------------------------------------------------------

describe('ToolEvidenceHandle — valid handles (AC1)', () => {
  it('accepts a minimal valid PASSED handle with summaryMode=none', () => {
    const result = validateToolEvidenceHandle(validHandle());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.handle.schemaVersion).toBe(TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION);
      expect(result.handle.toolName).toBe('run_quality_checks');
      expect(result.handle.invocationId).toBe('inv-abc-123');
      expect(result.handle.runStatus).toBe('PASSED');
      expect(result.handle.summaryMode).toBe('none');
      expect(result.handle.noSummaryReason).toBeTruthy();
      expect(result.handle.admittedHarnessFingerprint).toBeTruthy();
      expect(result.handle.admittedExecutionBoundary).toBeTruthy();
    }
  });

  it('accepts a PASSED handle with summaryMode=summary and rtkSummary', () => {
    const result = validateToolEvidenceHandle(validHandleWithSummary());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.handle.summaryMode).toBe('summary');
      expect(result.handle.rtkSummary).toBeDefined();
      expect(result.handle.rtkSummary?.schemaTypeName).toBe('GitHistoryRtkSummary');
      expect(result.handle.rtkSummary?.owningFile).toBe('src/tools/git_history.ts');
    }
  });

  it('accepts a REJECTED handle (no semantic artifact required)', () => {
    const result = validateToolEvidenceHandle(validHandleRejected());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.handle.runStatus).toBe('REJECTED');
      expect(result.handle.failureCategory).toBe('TIMEOUT');
      expect(result.handle.semanticArtifactPath).toBeUndefined();
    }
  });

  it('accepts optional rawTransportArchivePaths for PASSED handles', () => {
    const result = validateToolEvidenceHandle(validHandle({
      rawTransportArchivePaths: [
        `${TOOL_OUTPUT_ROOT}/bead1/state1/action1/run_quality_checks/inv-abc-123/output/stdout.txt`
      ]
    }));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.handle.rawTransportArchivePaths).toHaveLength(1);
    }
  });

  it('accepts optional verifierVerdict on a PASSED handle', () => {
    const result = validateToolEvidenceHandle(validHandle({ verifierVerdict: 'PASS' }));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.handle.verifierVerdict).toBe('PASS');
    }
  });
});

// ---------------------------------------------------------------------------
// AC2: execution status is distinct from verifier verdict;
//       model-facing raw output is forbidden
// ---------------------------------------------------------------------------

describe('ToolEvidenceHandle — status/verdict separation (AC2)', () => {
  it('PASSED runStatus does NOT imply verifierVerdict (verdict is absent or explicit)', () => {
    // A tool can RUN (PASSED) but still have FAIL verifier verdict
    const handle = validHandle({ runStatus: 'PASSED', verifierVerdict: 'FAIL' });
    const result = validateToolEvidenceHandle(handle);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.handle.runStatus).toBe('PASSED');
      expect(result.handle.verifierVerdict).toBe('FAIL');
    }
  });

  it('REJECTED runStatus with no verifierVerdict is valid (tool never reached verifier)', () => {
    const result = validateToolEvidenceHandle(validHandleRejected());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.handle.runStatus).toBe('REJECTED');
      expect(result.handle.verifierVerdict).toBeUndefined();
    }
  });

  it('rejects a handle that includes a modelFacingRawOutput field', () => {
    const handle = {
      ...validHandle(),
      modelFacingRawOutput: 'raw stdout content here'
    } as unknown;
    const result = validateToolEvidenceHandle(handle);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('modelFacingRawOutput'))).toBe(true);
    }
  });

  it('rejects a handle that includes a rawOutput field (alias for model-facing raw)', () => {
    const handle = {
      ...validHandle(),
      rawOutput: 'raw content'
    } as unknown;
    const result = validateToolEvidenceHandle(handle);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('rawOutput') || e.includes('model-facing'))).toBe(true);
    }
  });

  it('rawTransportArchivePaths CANNOT satisfy semantic gates — and PASSED handles without semanticArtifactPath are invalid (zog2.8)', () => {
    // A handle where rawTransportArchivePaths is set but semanticArtifactPath is absent.
    // Per zog2.8: PASSED runs MUST have a semanticArtifactPath (even a minimal artifact).
    // rawTransportArchivePaths are raw-archive paths only and are NOT semantic evidence.
    const handle: ToolEvidenceHandle = {
      schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
      toolName: 'some_tool',
      invocationId: 'inv-raw-001',
      runStatus: 'PASSED',
      // No semanticArtifactPath — invalid per zog2.8 for PASSED runs
      rawTransportArchivePaths: [`${TOOL_OUTPUT_ROOT}/bead1/state1/action1/some_tool/inv-raw-001/stdout.txt`],
      toolOutputRoot: TOOL_OUTPUT_ROOT,
      summaryMode: 'none',
      noSummaryReason: 'raw-only tool, no semantic artifact in this run',
      admittedHarnessFingerprint: 'sha256:abcdef1234567890',
      admittedExecutionBoundary: 'bead:bead1/state:state1/action:action1',
    };
    const result = validateToolEvidenceHandle(handle);
    // zog2.8: PASSED handles without semanticArtifactPath are INVALID.
    // rawTransportArchivePaths alone cannot satisfy semantic gates.
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('semanticArtifactPath'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: summaryMode distinguishes 'summary' vs 'none'; no LLM summaries
// ---------------------------------------------------------------------------

describe('ToolEvidenceHandle — summaryMode + RTK summary contract (AC3)', () => {
  it('summaryMode=summary requires rtkSummary', () => {
    const handle = {
      ...validHandleWithSummary(),
    };
    const result = validateToolEvidenceHandle(handle);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.handle.rtkSummary).toBeDefined();
    }
  });

  it('summaryMode=none requires noSummaryReason', () => {
    const result = validateToolEvidenceHandle(validHandle());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.handle.noSummaryReason).toBeTruthy();
    }
  });

  it('rtkSummary requires owningFile that ends with .ts (TypeScript-only)', () => {
    const handle = validHandleWithSummary({
      rtkSummary: {
        schemaTypeName: 'SomeResult',
        owningFile: 'src/tools/some_tool.py',  // Python — NOT allowed
        summary: { count: 0 }
      }
    });
    const result = validateToolEvidenceHandle(handle);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('owningFile') || e.includes('.ts') || e.includes('TypeScript'))).toBe(true);
    }
  });

  it('rtkSummary owningFile must end with .ts', () => {
    const handle = validHandleWithSummary({
      rtkSummary: {
        schemaTypeName: 'ValidResult',
        owningFile: 'src/tools/git_history.ts',
        summary: { commitCount: 3 }
      }
    });
    const result = validateToolEvidenceHandle(handle);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4: fail-closed cases — invalid handles MUST fail validation
// ---------------------------------------------------------------------------

describe('ToolEvidenceHandle — fail-closed validation (AC4)', () => {
  it('rejects null', () => {
    const result = validateToolEvidenceHandle(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects non-object', () => {
    const result = validateToolEvidenceHandle('not-an-object');
    expect(result.valid).toBe(false);
  });

  it('rejects missing toolName', () => {
    const { toolName: _, ...rest } = validHandle() as Record<string, unknown>;
    const result = validateToolEvidenceHandle(rest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('toolName'))).toBe(true);
    }
  });

  it('rejects missing invocationId', () => {
    const { invocationId: _, ...rest } = validHandle() as Record<string, unknown>;
    const result = validateToolEvidenceHandle(rest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('invocationId'))).toBe(true);
    }
  });

  it('rejects missing runStatus', () => {
    const { runStatus: _, ...rest } = validHandle() as Record<string, unknown>;
    const result = validateToolEvidenceHandle(rest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('runStatus'))).toBe(true);
    }
  });

  it('rejects invalid runStatus value', () => {
    const result = validateToolEvidenceHandle(validHandle({ runStatus: 'RUNNING' as ToolEvidenceRunStatus }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('runStatus'))).toBe(true);
    }
  });

  it('rejects summaryMode=summary without rtkSummary (AC4 — missing summary)', () => {
    const handle = {
      ...validHandleWithSummary(),
      rtkSummary: undefined
    };
    const result = validateToolEvidenceHandle(handle);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('rtkSummary') || e.includes('summaryMode'))).toBe(true);
    }
  });

  it('rejects summaryMode=none without noSummaryReason (AC4 — missing noSummaryReason)', () => {
    const { noSummaryReason: _, ...rest } = validHandle() as Record<string, unknown>;
    const result = validateToolEvidenceHandle(rest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('noSummaryReason') || e.includes('summaryMode'))).toBe(true);
    }
  });

  it('rejects missing admittedHarnessFingerprint (AC4 — missing fingerprint)', () => {
    const { admittedHarnessFingerprint: _, ...rest } = validHandle() as Record<string, unknown>;
    const result = validateToolEvidenceHandle(rest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('admittedHarnessFingerprint') || e.includes('fingerprint'))).toBe(true);
    }
  });

  it('rejects missing admittedExecutionBoundary (AC4 — missing execution boundary)', () => {
    const { admittedExecutionBoundary: _, ...rest } = validHandle() as Record<string, unknown>;
    const result = validateToolEvidenceHandle(rest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('admittedExecutionBoundary') || e.includes('execution'))).toBe(true);
    }
  });

  it('rejects non-TypeScript summary owningFile (AC4 — non-TS summarizer path)', () => {
    const handle = validHandleWithSummary({
      rtkSummary: {
        schemaTypeName: 'SomeResult',
        owningFile: 'scripts/summarize.js',  // JS — not allowed
        summary: {}
      }
    });
    const result = validateToolEvidenceHandle(handle);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('owningFile') || e.includes('.ts') || e.includes('TypeScript'))).toBe(true);
    }
  });

  it('rejects semanticArtifactPath outside toolOutputRoot (AC4 — path outside tool-output root)', () => {
    const handle = validHandle({
      semanticArtifactPath: '/etc/passwd'  // outside tool-output root
    });
    const result = validateToolEvidenceHandle(handle);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('semanticArtifactPath') || e.includes('toolOutputRoot') || e.includes('root'))).toBe(true);
    }
  });

  it('rejects malformed rtkSummary (missing schemaTypeName) (AC4 — malformed summary)', () => {
    const handle = validHandleWithSummary({
      rtkSummary: {
        schemaTypeName: '',  // empty — must be a non-empty string
        owningFile: 'src/tools/git_history.ts',
        summary: {}
      }
    });
    const result = validateToolEvidenceHandle(handle);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('schemaTypeName') || e.includes('rtkSummary'))).toBe(true);
    }
  });

  it('rejects model-facing raw output field (AC4 — rawOutput model-facing exposure)', () => {
    const handle = {
      ...validHandle(),
      rawOutput: 'STDOUT: compilation results...'
    };
    const result = validateToolEvidenceHandle(handle as unknown);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('rawOutput') || e.includes('model-facing') || e.includes('forbidden'))).toBe(true);
    }
  });

  it('rejects missing schemaVersion', () => {
    const { schemaVersion: _, ...rest } = validHandle() as Record<string, unknown>;
    const result = validateToolEvidenceHandle(rest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('schemaVersion'))).toBe(true);
    }
  });

  it('rejects missing toolOutputRoot', () => {
    const { toolOutputRoot: _, ...rest } = validHandle() as Record<string, unknown>;
    const result = validateToolEvidenceHandle(rest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('toolOutputRoot'))).toBe(true);
    }
  });

  it('rejects invalid verifierVerdict value', () => {
    const result = validateToolEvidenceHandle(validHandle({ verifierVerdict: 'MAYBE' as ToolEvidenceVerifierVerdict }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('verifierVerdict'))).toBe(true);
    }
  });

  it('rejects invalid summaryMode value', () => {
    const result = validateToolEvidenceHandle(validHandle({ summaryMode: 'partial' as ToolEvidenceSummaryMode }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('summaryMode'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 (review fix 1): expectedToolName — mismatched tool name must fail closed
// ---------------------------------------------------------------------------

describe('validateToolEvidenceHandle — expectedToolName option (AC4)', () => {
  it('passes when toolName matches expectedToolName', () => {
    const result = validateToolEvidenceHandle(
      validHandle({ toolName: 'run_quality_checks' }),
      { expectedToolName: 'run_quality_checks' }
    );
    expect(result.valid).toBe(true);
  });

  it('fails closed when toolName does NOT match expectedToolName', () => {
    const result = validateToolEvidenceHandle(
      validHandle({ toolName: 'run_quality_checks' }),
      { expectedToolName: 'git_history' }
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('toolName') && e.includes('mismatch'))).toBe(true);
      expect(result.errors.some(e => e.includes('git_history') && e.includes('run_quality_checks'))).toBe(true);
    }
  });

  it('behaves identically to no-option call when expectedToolName is absent', () => {
    const withOpts = validateToolEvidenceHandle(validHandle(), {});
    const withoutOpts = validateToolEvidenceHandle(validHandle());
    expect(withOpts.valid).toBe(withoutOpts.valid);
  });
});

// ---------------------------------------------------------------------------
// AC4 (review fix 2): validateToolEvidenceArtifact — unreadable artifact fail-closed
// ---------------------------------------------------------------------------

describe('validateToolEvidenceArtifact — artifact readability (AC4)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns readable:true when semanticArtifactPath is absent', () => {
    // A handle without a semanticArtifactPath (e.g. REJECTED run)
    const result = validateToolEvidenceHandle(validHandleRejected());
    expect(result.valid).toBe(true);
    if (result.valid) {
      const check = validateToolEvidenceArtifact(result.handle);
      expect(check.readable).toBe(true);
    }
  });

  it('returns readable:true when the artifact file exists and is readable', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teh-test-'));
    const artifactPath = path.join(tmpDir, 'result.json');
    fs.writeFileSync(artifactPath, '{"ok":true}');

    const handleInput = {
      schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
      toolName: 'run_quality_checks',
      invocationId: 'inv-art-001',
      runStatus: 'PASSED' as const,
      semanticArtifactPath: artifactPath,
      toolOutputRoot: tmpDir,
      summaryMode: 'none' as const,
      noSummaryReason: 'test',
      admittedHarnessFingerprint: 'sha256:test',
      admittedExecutionBoundary: 'bead:b1/state:s1/action:a1',
    };
    const result = validateToolEvidenceHandle(handleInput);
    expect(result.valid).toBe(true);
    if (result.valid) {
      const check = validateToolEvidenceArtifact(result.handle);
      expect(check.readable).toBe(true);
    }
  });

  it('fails closed when the artifact file does not exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teh-test-'));
    const missingPath = path.join(tmpDir, 'nonexistent.json');

    const handleInput = {
      schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
      toolName: 'run_quality_checks',
      invocationId: 'inv-art-002',
      runStatus: 'PASSED' as const,
      semanticArtifactPath: missingPath,
      toolOutputRoot: tmpDir,
      summaryMode: 'none' as const,
      noSummaryReason: 'test',
      admittedHarnessFingerprint: 'sha256:test',
      admittedExecutionBoundary: 'bead:b1/state:s1/action:a1',
    };
    const result = validateToolEvidenceHandle(handleInput);
    expect(result.valid).toBe(true);
    if (result.valid) {
      const check = validateToolEvidenceArtifact(result.handle);
      expect(check.readable).toBe(false);
      if (!check.readable) {
        expect(check.error).toContain('semanticArtifactPath not readable');
        expect(check.error).toContain(missingPath);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 (review fix 3): path-traversal-safe containment in isInsideRoot
// ---------------------------------------------------------------------------

describe('validateToolEvidenceHandle — path traversal containment (AC4)', () => {
  it('fails closed when semanticArtifactPath uses .. to escape toolOutputRoot', () => {
    // "/project/.pi/tool-output/../../etc/passwd" resolves outside the root
    const traversalPath = `${TOOL_OUTPUT_ROOT}/../../etc/passwd`;
    const result = validateToolEvidenceHandle(validHandle({
      semanticArtifactPath: traversalPath
    }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('semanticArtifactPath') || e.includes('toolOutputRoot'))).toBe(true);
    }
  });

  it('accepts a legitimate deep path under toolOutputRoot (no traversal)', () => {
    const deepPath = `${TOOL_OUTPUT_ROOT}/bead1/state1/action1/run_quality_checks/inv-abc-123/output/result.json`;
    const result = validateToolEvidenceHandle(validHandle({
      semanticArtifactPath: deepPath
    }));
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC5: ToolResultBase migration debt adapter
// ---------------------------------------------------------------------------

describe('toolResultBaseToMigrationDebt — ToolResultBase adapter (AC5)', () => {
  it('maps a PASSED ToolResultBase to a migration-debt partial handle', () => {
    const base: ToolResultBase = {
      tool: 'run_quality_checks',
      status: 'PASSED',
      outputFile: `${TOOL_OUTPUT_ROOT}/bead1/state1/action1/run_quality_checks/inv-001/output/result.json`,
      outputFileBytes: 2048
    };
    const debt = toolResultBaseToMigrationDebt(base, TOOL_OUTPUT_ROOT);
    expect(debt.toolName).toBe('run_quality_checks');
    expect(debt.runStatus).toBe('PASSED');
    // The adapter gives the outputFile as a candidate semanticArtifactPath — it is
    // NOT authoritative but it is the only path available from ToolResultBase.
    expect(debt.semanticArtifactPath).toBe(base.outputFile);
    expect(debt.semanticArtifactBytes).toBe(2048);
    // Migration debt is clearly marked
    expect(debt._migrationDebt).toBe(true);
  });

  it('maps a REJECTED ToolResultBase (no semanticArtifactPath)', () => {
    const base: ToolResultBase = {
      tool: 'run_quality_checks',
      status: 'REJECTED',
      failureCategory: 'TIMEOUT',
      outputFile: `${TOOL_OUTPUT_ROOT}/bead1/state1/action1/run_quality_checks/inv-002/output/result.json`,
      outputFileBytes: 0
    };
    const debt = toolResultBaseToMigrationDebt(base, TOOL_OUTPUT_ROOT);
    expect(debt.runStatus).toBe('REJECTED');
    expect(debt.failureCategory).toBe('TIMEOUT');
    // REJECTED means the tool didn't complete — semanticArtifactPath should be undefined
    expect(debt.semanticArtifactPath).toBeUndefined();
    expect(debt._migrationDebt).toBe(true);
  });

  it('migration debt result is NOT a valid ToolEvidenceHandle (missing required fields)', () => {
    const base: ToolResultBase = {
      tool: 'run_quality_checks',
      status: 'PASSED',
      outputFile: `${TOOL_OUTPUT_ROOT}/bead1/state1/action1/run_quality_checks/inv-003/output/result.json`,
      outputFileBytes: 100
    };
    const debt = toolResultBaseToMigrationDebt(base, TOOL_OUTPUT_ROOT);
    // The adapter result intentionally lacks invocationId, schemaVersion, admittedHarnessFingerprint, etc.
    const result = validateToolEvidenceHandle(debt);
    expect(result.valid).toBe(false);
    // It should fail on missing required fields (schema version, invocationId, etc.)
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});
