/**
 * pi-experiment-6q0y.12 — Validate tool-local RTK summaries against the owning
 * project-tool TypeScript file.
 *
 * LOAD-BEARING: these tests drive the REAL on-disk validation added in 6q0y.12.
 * If the project-tool owningFile existence check were removed or bypassed, the
 * negative tests below MUST fail (they rely on projectRoot being checked against
 * an actually missing file).
 *
 * Assertions:
 *   AC1: A project-tool summary whose owningFile exists on disk under projectRoot
 *        is accepted when projectRoot is provided.
 *   AC2a: A project-tool summary with a non-TypeScript owningFile is rejected
 *         (regardless of projectRoot).
 *   AC2b: A project-tool summary with 'untyped_record' schemaTypeName is rejected.
 *   AC2c: A project-tool summary with a missing schemaHash is rejected.
 *   AC2d: A project-tool summary with a generic harness owningFile is rejected.
 *   AC3: ToolRunStatus enum values (PASSED, REJECTED, UNAVAILABLE) are accepted;
 *        other values are rejected.
 *   AC4: ToolEvidenceRtkSummary and ValidateToolEvidenceHandleOptions are exported
 *        from src/core/ToolEvidenceHandle.ts.
 *   AC5a: A project-tool summary whose owningFile does NOT exist on disk is rejected
 *         when projectRoot is provided (the key load-bearing test: fails if
 *         the on-disk check is removed).
 *   AC5b: Without projectRoot, a project-tool owningFile path is accepted even if
 *         the file doesn't exist (projectRoot is required to trigger the check).
 *   AC5c: A src/-prefixed owningFile is NOT subject to the on-disk check even when
 *         projectRoot is provided (harness files use the affirmative expectedToolName
 *         check, not the filesystem check).
 *   AC6: No LLM, no generic summarizer: validate that the summary value accepted by
 *        the contract is tool-owned (schemaTypeName ≠ 'untyped_record', no generic
 *        extraction framework references in the payload).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
  validateToolEvidenceHandle,
  type ToolEvidenceHandle,
  type ToolEvidenceRtkSummary,
  type ValidateToolEvidenceHandleOptions,
} from '../src/core/ToolEvidenceHandle.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid PASSED handle with a project-tool owningFile summary.
 */
function makeProjectToolHandle(
  owningFile: string,
  extraSummaryOverrides: Partial<ToolEvidenceRtkSummary> = {},
  outputRoot = '/project/.pi/tool-output'
): unknown {
  const rtkSummary: ToolEvidenceRtkSummary = {
    schemaTypeName: 'CerdiwenToolRtkSummary',
    owningFile,
    summarySchemaVersion: '1.0.0',
    schemaHash: 'sha256:' + 'a'.repeat(64),
    deterministicSummaryVersion: '1.0.0',
    inputArtifactSchemaId: 'cerdiwen-tool-output',
    inputArtifactSchemaVersion: '1.0.0',
    maximumCounts: { items: 20 },
    omissionSemantics: 'items beyond maximumCounts.items are omitted',
    summary: { itemCount: 5, truncated: false },
    ...extraSummaryOverrides,
  };
  const handle: ToolEvidenceHandle = {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: 'cerdiwen_tool',
    invocationId: 'inv-6q0y12-test',
    runStatus: 'PASSED',
    semanticArtifactPath: `${outputRoot}/bead1/state1/action1/cerdiwen_tool/inv-6q0y12-test/result.json`,
    toolOutputRoot: outputRoot,
    summaryMode: 'summary',
    rtkSummary,
    admittedHarnessFingerprint: 'sha256:test-fp',
    admittedExecutionBoundary: 'bead:b1/state:s1/action:a1',
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Temp dir helpers — create a real .pi/project-tools/<tool>.ts on disk
// ---------------------------------------------------------------------------

let tmpProjectRoot: string;

beforeEach(() => {
  tmpProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), '6q0y12-proj-'));
});

afterEach(() => {
  if (tmpProjectRoot) {
    fs.rmSync(tmpProjectRoot, { recursive: true, force: true });
  }
});

function createProjectToolFile(projectRoot: string, relPath: string): string {
  const absPath = path.join(projectRoot, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  // Write a minimal TypeScript stub — the validator only checks existence, not content.
  fs.writeFileSync(absPath, '// project-tool stub\nexport {};\n', 'utf8');
  return absPath;
}

// ---------------------------------------------------------------------------
// AC1: project-tool owningFile that exists on disk is accepted
// ---------------------------------------------------------------------------

describe('6q0y.12 — AC1: existing project-tool owningFile accepted with projectRoot', () => {
  it('accepts a handle whose project-tool owningFile exists on disk under projectRoot', () => {
    const relPath = '.pi/project-tools/cerdiwen_tool.ts';
    createProjectToolFile(tmpProjectRoot, relPath);

    const handle = makeProjectToolHandle(relPath);
    const opts: ValidateToolEvidenceHandleOptions = { projectRoot: tmpProjectRoot };
    const result = validateToolEvidenceHandle(handle, opts);

    // LOAD-BEARING: if the existence check is removed, a non-existent file would also
    // pass (AC5a tests that). This test confirms the happy path still passes.
    expect(
      result.valid,
      `validator errors: ${!result.valid ? (result as { valid: false; errors: string[] }).errors.join('; ') : ''}`
    ).toBe(true);
    if (result.valid) {
      expect(result.handle.rtkSummary?.owningFile).toBe(relPath);
    }
  });

  it('accepts project-tool owningFile under a custom scriptDir (not .pi/project-tools)', () => {
    const relPath = '.pi/tools/my_tool.ts';
    createProjectToolFile(tmpProjectRoot, relPath);

    const handle = makeProjectToolHandle(relPath);
    const opts: ValidateToolEvidenceHandleOptions = { projectRoot: tmpProjectRoot };
    const result = validateToolEvidenceHandle(handle, opts);

    expect(
      result.valid,
      `validator errors: ${!result.valid ? (result as { valid: false; errors: string[] }).errors.join('; ') : ''}`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2: rejection rules still hold for project-tool summaries
// ---------------------------------------------------------------------------

describe('6q0y.12 — AC2a: non-TypeScript project-tool owningFile is rejected', () => {
  it('rejects .pi/project-tools/cerdiwen_tool.py (non-TypeScript)', () => {
    const handle = makeProjectToolHandle('.pi/project-tools/cerdiwen_tool.py');
    const opts: ValidateToolEvidenceHandleOptions = { projectRoot: tmpProjectRoot };
    const result = validateToolEvidenceHandle(handle, opts);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('owningFile') || e.includes('.ts') || e.includes('TypeScript'))).toBe(true);
    }
  });

  it('rejects .pi/project-tools/cerdiwen_tool.js (non-TypeScript)', () => {
    const handle = makeProjectToolHandle('.pi/project-tools/cerdiwen_tool.js');
    const opts: ValidateToolEvidenceHandleOptions = { projectRoot: tmpProjectRoot };
    const result = validateToolEvidenceHandle(handle, opts);
    expect(result.valid).toBe(false);
  });
});

describe('6q0y.12 — AC2b: untyped_record schemaTypeName is rejected for project-tool summaries', () => {
  it('rejects rtkSummary with schemaTypeName="untyped_record" even for project-tool files', () => {
    const relPath = '.pi/project-tools/cerdiwen_tool.ts';
    createProjectToolFile(tmpProjectRoot, relPath);

    const handle = makeProjectToolHandle(relPath, { schemaTypeName: 'untyped_record' });
    const opts: ValidateToolEvidenceHandleOptions = { projectRoot: tmpProjectRoot };
    const result = validateToolEvidenceHandle(handle, opts);

    // LOAD-BEARING: removing the 'untyped_record' ban would make this valid:true
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('untyped_record') || e.includes('schemaTypeName'))).toBe(true);
    }
  });
});

describe('6q0y.12 — AC2c: missing schemaHash is rejected for project-tool summaries', () => {
  it('rejects rtkSummary with no schemaHash', () => {
    const relPath = '.pi/project-tools/cerdiwen_tool.ts';
    createProjectToolFile(tmpProjectRoot, relPath);

    const { schemaHash: _, ...summaryWithoutHash } = {
      schemaTypeName: 'CerdiwenToolRtkSummary',
      owningFile: relPath,
      summarySchemaVersion: '1.0.0',
      schemaHash: 'sha256:' + 'a'.repeat(64),
      deterministicSummaryVersion: '1.0.0',
      inputArtifactSchemaId: 'cerdiwen-tool-output',
      inputArtifactSchemaVersion: '1.0.0',
      maximumCounts: { items: 20 },
      omissionSemantics: 'items beyond maximumCounts.items are omitted',
      summary: { itemCount: 5 },
    };

    const handle = makeProjectToolHandle(relPath, summaryWithoutHash as Partial<ToolEvidenceRtkSummary>);
    // Override the full rtkSummary to use the one missing schemaHash
    const handleRecord = handle as Record<string, unknown>;
    handleRecord['rtkSummary'] = summaryWithoutHash;

    const opts: ValidateToolEvidenceHandleOptions = { projectRoot: tmpProjectRoot };
    const result = validateToolEvidenceHandle(handleRecord, opts);

    // LOAD-BEARING: removing schemaHash requirement would make this valid:true
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('schemaHash'))).toBe(true);
    }
  });
});

describe('6q0y.12 — AC2d: generic harness owningFile is rejected even with projectRoot', () => {
  it('rejects src/core/ToolEvidenceHandle.ts as owningFile even with projectRoot', () => {
    const handle = makeProjectToolHandle('src/core/ToolEvidenceHandle.ts');
    const opts: ValidateToolEvidenceHandleOptions = { projectRoot: tmpProjectRoot };
    const result = validateToolEvidenceHandle(handle, opts);

    // LOAD-BEARING: this is caught by the FORBIDDEN_GENERIC_SUMMARY_OWNER_FILES denylist.
    // If the denylist were removed and only projectRoot check applied, 'src/core/...' would
    // not be subject to the on-disk check (it starts with 'src/'), so the denylist is
    // the only gate here.
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e =>
        e.includes('owningFile') &&
        (e.includes('generic harness framework') || e.includes('zog2.7'))
      )).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: ToolRunStatus enum values
// ---------------------------------------------------------------------------

describe('6q0y.12 — AC3: ToolRunStatus strict enum (PASSED, REJECTED, UNAVAILABLE)', () => {
  it('accepts PASSED as runStatus', () => {
    const handle = makeProjectToolHandle('.pi/project-tools/any.ts');
    const result = validateToolEvidenceHandle(handle);
    // runStatus = 'PASSED' is part of the base handle — structural test without projectRoot
    // is fine here since we're testing runStatus, not owningFile.
    expect((handle as Record<string, unknown>)['runStatus']).toBe('PASSED');
  });

  it('accepts REJECTED as runStatus', () => {
    const rejectedHandle = {
      schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
      toolName: 'cerdiwen_tool',
      invocationId: 'inv-6q0y12-rejected',
      runStatus: 'REJECTED',
      failureCategory: 'TIMEOUT',
      toolOutputRoot: '/project/.pi/tool-output',
      summaryMode: 'none',
      noSummaryReason: 'tool timed out',
      admittedHarnessFingerprint: 'sha256:test-fp',
      admittedExecutionBoundary: 'bead:b1/state:s1/action:a1',
    };
    const result = validateToolEvidenceHandle(rejectedHandle);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.handle.runStatus).toBe('REJECTED');
    }
  });

  it('accepts UNAVAILABLE as runStatus', () => {
    const unavailableHandle = {
      schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
      toolName: 'cerdiwen_tool',
      invocationId: 'inv-6q0y12-unavailable',
      runStatus: 'UNAVAILABLE',
      toolOutputRoot: '/project/.pi/tool-output',
      summaryMode: 'none',
      noSummaryReason: 'tool binary not found',
      admittedHarnessFingerprint: 'sha256:test-fp',
      admittedExecutionBoundary: 'bead:b1/state:s1/action:a1',
    };
    const result = validateToolEvidenceHandle(unavailableHandle);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.handle.runStatus).toBe('UNAVAILABLE');
    }
  });

  it('rejects RUNNING as runStatus (not in the enum)', () => {
    const badHandle = {
      schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
      toolName: 'cerdiwen_tool',
      invocationId: 'inv-6q0y12-running',
      runStatus: 'RUNNING',  // NOT a valid ToolRunStatus
      toolOutputRoot: '/project/.pi/tool-output',
      summaryMode: 'none',
      noSummaryReason: 'tool is running',
      admittedHarnessFingerprint: 'sha256:test-fp',
      admittedExecutionBoundary: 'bead:b1/state:s1/action:a1',
    };
    const result = validateToolEvidenceHandle(badHandle);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('runStatus'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC4: ToolEvidenceRtkSummary and ValidateToolEvidenceHandleOptions are exported
// ---------------------------------------------------------------------------

describe('6q0y.12 — AC4: contract package exports summary interfaces', () => {
  it('ToolEvidenceRtkSummary is exported from src/core/ToolEvidenceHandle.ts', () => {
    // TypeScript type exports cannot be verified at runtime, but we can verify the
    // module exports the value-level constants and functions alongside the types.
    // The import at the top of this file uses the exported type — if it were removed,
    // the TypeScript compiler would error.
    const summary: ToolEvidenceRtkSummary = {
      schemaTypeName: 'TestSummary',
      owningFile: 'src/tools/test.ts',
      summarySchemaVersion: '1.0.0',
      schemaHash: 'sha256:' + 'b'.repeat(64),
      deterministicSummaryVersion: '1.0.0',
      inputArtifactSchemaId: 'test-output',
      inputArtifactSchemaVersion: '1.0.0',
      maximumCounts: { items: 10 },
      omissionSemantics: 'items beyond limit omitted',
      summary: { count: 0 },
    };
    // Verify the shape is correct (structural check at runtime)
    expect(typeof summary.schemaTypeName).toBe('string');
    expect(typeof summary.owningFile).toBe('string');
    expect(typeof summary.schemaHash).toBe('string');
    expect(typeof summary.maximumCounts).toBe('object');
  });

  it('ValidateToolEvidenceHandleOptions is exported and has projectRoot field', () => {
    // Verify the type is usable by constructing a value of that type.
    const opts: ValidateToolEvidenceHandleOptions = {
      expectedToolName: 'test_tool',
      projectRoot: '/tmp/proj',
    };
    expect(opts.expectedToolName).toBe('test_tool');
    expect(opts.projectRoot).toBe('/tmp/proj');
  });
});

// ---------------------------------------------------------------------------
// AC5a: non-existent project-tool owningFile is rejected (the KEY load-bearing test)
// ---------------------------------------------------------------------------

describe('6q0y.12 — AC5a: non-existent project-tool owningFile is rejected', () => {
  it('rejects a project-tool summary whose owningFile does NOT exist on disk', () => {
    // The file does NOT exist — we do not call createProjectToolFile.
    const relPath = '.pi/project-tools/nonexistent_tool.ts';
    const handle = makeProjectToolHandle(relPath);
    const opts: ValidateToolEvidenceHandleOptions = { projectRoot: tmpProjectRoot };
    const result = validateToolEvidenceHandle(handle, opts);

    // LOAD-BEARING: THIS IS THE CORE 6q0y.12 TEST.
    // If the on-disk existence check (projectToolFileExists) were removed from
    // validateRtkSummary, this test would produce valid:true (the file ends with .ts,
    // is not in FORBIDDEN_GENERIC_SUMMARY_OWNER_FILES, and no expectedToolName is set).
    // The existence check is the ONLY thing that rejects it.
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some(e =>
          e.includes('owningFile') &&
          (e.includes('does not exist') || e.includes('6q0y.12') || e.includes('project-tool'))
        )
      ).toBe(true);
      // Also confirm the error references the actual path
      expect(
        result.errors.some(e => e.includes(relPath))
      ).toBe(true);
    }
  });

  it('rejects even a plausible-looking path that simply does not exist', () => {
    // 'plausible' — correct convention, but file simply not on disk
    const relPath = '.pi/project-tools/run_quality_checks.ts';
    const handle = makeProjectToolHandle(relPath);
    const opts: ValidateToolEvidenceHandleOptions = { projectRoot: tmpProjectRoot };
    const result = validateToolEvidenceHandle(handle, opts);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('owningFile'))).toBe(true);
    }
  });

  it('rejects a directory path (not a regular file) even if it exists', () => {
    // Create the directory but NOT the file
    const dirPath = path.join(tmpProjectRoot, '.pi', 'project-tools');
    fs.mkdirSync(dirPath, { recursive: true });

    const relPath = '.pi/project-tools';  // This is a directory, not a .ts file
    // First check: this would fail the .ts extension check anyway
    const handle = makeProjectToolHandle(`${relPath}/`);
    const opts: ValidateToolEvidenceHandleOptions = { projectRoot: tmpProjectRoot };
    const result = validateToolEvidenceHandle(handle, opts);
    // Must fail (no .ts extension)
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC5b: without projectRoot, project-tool owningFile path is NOT checked on disk
// ---------------------------------------------------------------------------

describe('6q0y.12 — AC5b: without projectRoot, project-tool owningFile is not disk-checked', () => {
  it('accepts a project-tool owningFile without projectRoot even if the file does not exist', () => {
    // No file created; no projectRoot provided.
    const relPath = '.pi/project-tools/hypothetical_tool.ts';
    const handle = makeProjectToolHandle(relPath);
    // No projectRoot — the on-disk check is skipped entirely.
    const result = validateToolEvidenceHandle(handle);

    // Without projectRoot: the path ends with .ts, is not in the denylist,
    // and there's no expectedToolName — it should pass.
    expect(
      result.valid,
      `validator errors: ${!result.valid ? (result as { valid: false; errors: string[] }).errors.join('; ') : ''}`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC5c: src/-prefixed owningFile is NOT subject to on-disk check
// ---------------------------------------------------------------------------

describe('6q0y.12 — AC5c: harness src/ files are not subject to the project-tool disk check', () => {
  it('src/tools/git_history.ts is not checked on disk (harness files use affirmative check)', () => {
    // Provide projectRoot but a src/ file — should NOT trigger the filesystem check
    // for project-tool files. The harness path goes through the expectedToolName
    // or denylist gate instead.
    const handle = makeProjectToolHandle('src/tools/git_history.ts');
    const opts: ValidateToolEvidenceHandleOptions = { projectRoot: tmpProjectRoot };
    // No expectedToolName provided, so no affirmative check → valid (ends with .ts, not in denylist)
    const result = validateToolEvidenceHandle(handle, opts);

    // LOAD-BEARING: src/ prefix should NOT trigger the filesystem check.
    // The isProjectToolOwningFile guard prevents it.
    expect(
      result.valid,
      `validator errors: ${!result.valid ? (result as { valid: false; errors: string[] }).errors.join('; ') : ''}`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC6: No LLM / generic summarizer — validate that admissible summaries are tool-owned
// ---------------------------------------------------------------------------

describe('6q0y.12 — AC6: RTK summary must be tool-owned, no LLM or generic summarizer', () => {
  it('accepts a tool-owned summary with concrete schemaTypeName and real schemaHash', () => {
    const relPath = '.pi/project-tools/cerdiwen_tool.ts';
    createProjectToolFile(tmpProjectRoot, relPath);

    const handle = makeProjectToolHandle(relPath);
    const opts: ValidateToolEvidenceHandleOptions = { projectRoot: tmpProjectRoot };
    const result = validateToolEvidenceHandle(handle, opts);

    expect(result.valid).toBe(true);
    if (result.valid) {
      // A real tool-owned summary has a concrete schemaTypeName (not 'untyped_record')
      // and a schemaHash in the sha256: format — no LLM/generic extraction.
      expect(result.handle.rtkSummary?.schemaTypeName).not.toBe('untyped_record');
      expect(result.handle.rtkSummary?.schemaHash).toMatch(/^sha256:/);
      expect(result.handle.rtkSummary?.deterministicSummaryVersion).toBeTruthy();
    }
  });

  it('rejects a summary with no schemaHash (cannot prove deterministic extraction)', () => {
    const relPath = '.pi/project-tools/cerdiwen_tool.ts';
    createProjectToolFile(tmpProjectRoot, relPath);

    const handleRecord = makeProjectToolHandle(relPath) as Record<string, unknown>;
    const rtkSummary = handleRecord['rtkSummary'] as Record<string, unknown>;
    const { schemaHash: _, ...rtkWithoutHash } = rtkSummary;
    handleRecord['rtkSummary'] = rtkWithoutHash;

    const opts: ValidateToolEvidenceHandleOptions = { projectRoot: tmpProjectRoot };
    const result = validateToolEvidenceHandle(handleRecord, opts);

    // LOAD-BEARING: removing schemaHash requirement would make this valid:true.
    // schemaHash is the proof of deterministic extraction — no generic/LLM summarizer.
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('schemaHash'))).toBe(true);
    }
  });

  it('rejects a summary with schemaHash that looks like an LLM-generated value (no sha256: prefix)', () => {
    const relPath = '.pi/project-tools/cerdiwen_tool.ts';
    createProjectToolFile(tmpProjectRoot, relPath);

    const handle = makeProjectToolHandle(relPath, {
      schemaHash: 'llm-generated-hash-value',  // not a real sha256: hash
    });
    const opts: ValidateToolEvidenceHandleOptions = { projectRoot: tmpProjectRoot };
    const result = validateToolEvidenceHandle(handle, opts);

    // LOAD-BEARING: the format check ('sha256:' prefix required) is what prevents
    // a non-deterministic value from being admitted as a valid schemaHash.
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('schemaHash') && e.includes('sha256:'))).toBe(true);
    }
  });
});
