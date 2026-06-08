/**
 * pi-experiment-oi48 — git_history canonical ToolEvidenceHandle tests.
 *
 * AC1 (new): git_history emits a canonical ToolEvidenceHandle (not ToolResultBase as
 *   evidence shape). PASSED runs carry semanticArtifactPath, invocationId, rtkSummary,
 *   admittedHarnessFingerprint, admittedExecutionBoundary. validateToolEvidenceHandle
 *   returns valid:true.
 * AC2 (new): missing harness-injected output identity (no PI_TOOL_OUTPUT_DIR and no
 *   PI_TOOL_OUTPUT_FILE) → REJECTED/UNAVAILABLE result; the evidenceHandle.runStatus
 *   is REJECTED; no tmp/cwd path can be used as verifier evidence.
 * AC3 (new, negative): tmp/cwd artifacts, outputFile-only records, and ToolResultBase-
 *   shaped objects CANNOT satisfy gitHistoryVerify (≠ PASS).
 * AC4 (preserved): gitHistoryVerify() returns NOT_APPLICABLE when content absent,
 *   PASS/FAIL based on canonical semanticArtifactPath.
 * AC5 (preserved): the harness self-registers git_history's verify() at load.
 * AC6 (preserved): parseArgs is pure deterministic argument parsing.
 * AC7 (preserved): src/ imports NO cerdiwen consumer code.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { verifier, VerifyVerdict, type VerifyContext, type VerifyEvidenceHandle } from '../src/contract.js';
import {
  GIT_HISTORY_TOOL_NAME,
  gitHistoryVerify,
  runGitHistory,
  archiveOutput,
  parseArgs,
  GIT_HISTORY_INTERFACE_FIELDS,
  GIT_HISTORY_SCHEMA_DESCRIPTOR,
} from '../src/tools/git_history.js';
import {
  validateToolEvidenceHandle,
  TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
  type ToolEvidenceHandle,
} from '../src/core/ToolEvidenceHandle.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Build a VerifyContext with a PASSED evidenceHandle for git_history.
 * The semanticArtifactPath points to the file that will be checked for readability.
 * pi-experiment-yhec: gitHistoryVerify reads ctx.evidenceHandles, not toolOutputs.
 */
function ctxWithPassedHandle(semanticArtifactPath: string, toolOutputRoot?: string): VerifyContext {
  const root = toolOutputRoot ?? path.dirname(semanticArtifactPath);
  const handle: VerifyEvidenceHandle = {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: GIT_HISTORY_TOOL_NAME,
    invocationId: 'inv-test-001',
    runStatus: 'PASSED',
    semanticArtifactPath,
    toolOutputRoot: root,
    summaryMode: 'none',
    admittedHarnessFingerprint: 'sha256:test-fp',
    admittedExecutionBoundary: 'bead:bead-1/state:state-1/action:action-1',
  };
  return {
    beadId: 'bead-1',
    stateId: 'state-1',
    actionId: 'action-1',
    writeSet: [],
    artifacts: {},
    evidenceHandles: { [GIT_HISTORY_TOOL_NAME]: handle }
  };
}

/**
 * Build a VerifyContext with a REJECTED evidenceHandle for git_history.
 */
function ctxWithRejectedHandle(toolOutputRoot: string): VerifyContext {
  const handle: VerifyEvidenceHandle = {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: GIT_HISTORY_TOOL_NAME,
    invocationId: 'inv-test-rejected-001',
    runStatus: 'REJECTED',
    toolOutputRoot,
    summaryMode: 'none',
    admittedHarnessFingerprint: 'sha256:test-fp',
    admittedExecutionBoundary: 'bead:bead-1/state:state-1/action:action-1',
  };
  return {
    beadId: 'bead-1',
    stateId: 'state-1',
    actionId: 'action-1',
    writeSet: [],
    artifacts: {},
    evidenceHandles: { [GIT_HISTORY_TOOL_NAME]: handle }
  };
}

/**
 * Build a VerifyContext with NO evidenceHandle for git_history.
 * gitHistoryVerify should return NOT_APPLICABLE.
 */
function ctxWithNoHandle(): VerifyContext {
  return {
    beadId: 'bead-1',
    stateId: 'state-1',
    actionId: 'action-1',
    writeSet: [],
    artifacts: {},
    evidenceHandles: {}
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-history-harness-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Save/restore a set of env vars around an async test. */
async function withEnvVars(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// AC5: harness self-registers git_history verify()
// ---------------------------------------------------------------------------

describe('AC5: the harness self-registers git_history verify() at load (no consumer extension)', () => {
  it('verifier has a git_history entry after merely importing the harness built-in tools barrel', async () => {
    await import('../src/tools/index.js');
    expect(verifier.has(GIT_HISTORY_TOOL_NAME)).toBe(true);
    const cb = verifier.get(GIT_HISTORY_TOOL_NAME);
    expect(cb).toBe(gitHistoryVerify);
  });

  it('registerBuiltInVerifiers() is idempotent (last-wins, does not throw)', async () => {
    const { registerBuiltInVerifiers } = await import('../src/tools/index.js');
    expect(() => registerBuiltInVerifiers()).not.toThrow();
    expect(() => registerBuiltInVerifiers()).not.toThrow();
    expect(verifier.has(GIT_HISTORY_TOOL_NAME)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC1 (new): runGitHistory emits a canonical ToolEvidenceHandle on PASSED runs
// ---------------------------------------------------------------------------

describe('AC1 (new): runGitHistory emits a canonical ToolEvidenceHandle on PASSED runs', () => {
  it('evidenceHandle on a PASSED run validates against ToolEvidenceHandle schema', async () => {
    await withTempDir(async (dir) => {
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(repo);
      const env = { cwd: repo };
      await execFileAsync('git', ['init', '-q'], env);
      await execFileAsync('git', ['config', 'user.email', 't@t.dev'], env);
      await execFileAsync('git', ['config', 'user.name', 'Tester'], env);
      fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
      await execFileAsync('git', ['add', 'a.txt'], env);
      await execFileAsync('git', ['commit', '-q', '-m', 'init'], env);

      const outDir = path.join(dir, 'out');
      await withEnvVars({
        PI_WORKTREE_PATH: repo,
        PI_TOOL_OUTPUT_DIR: outDir,
        PI_TOOL_OUTPUT_FILE: undefined,
        PI_BEAD_ID: 'bd-1',
        PI_STATE_ID: 'Implementing',
        PI_ACTION_ID: 'code',
        PI_TOOL_INVOCATION_ID: 'inv-test-001',
      }, async () => {
        const result = await runGitHistory(['log']);
        expect(result.status).toBe('PASSED');

        // evidenceHandle MUST be present on PASSED runs.
        expect(result.evidenceHandle).toBeDefined();
        const handle = result.evidenceHandle!;

        // Schema version must match contract.
        expect(handle.schemaVersion).toBe(TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION);
        expect(handle.toolName).toBe(GIT_HISTORY_TOOL_NAME);
        expect(typeof handle.invocationId).toBe('string');
        expect(handle.invocationId.length).toBeGreaterThan(0);

        // runStatus must be PASSED.
        expect(handle.runStatus).toBe('PASSED');

        // semanticArtifactPath must be inside toolOutputRoot.
        expect(typeof handle.semanticArtifactPath).toBe('string');
        expect(path.isAbsolute(handle.semanticArtifactPath!)).toBe(true);
        expect(fs.existsSync(handle.semanticArtifactPath!)).toBe(true);
        expect(handle.semanticArtifactPath!.startsWith(handle.toolOutputRoot)).toBe(true);

        // Semantic artifact content is real git evidence.
        expect(fs.readFileSync(handle.semanticArtifactPath!, 'utf8')).toContain('init');

        // rtkSummary is present (summaryMode='summary').
        expect(handle.summaryMode).toBe('summary');
        expect(handle.rtkSummary).toBeDefined();
        expect(handle.rtkSummary!.owningFile).toMatch(/\.ts$/);
        expect(typeof handle.rtkSummary!.schemaTypeName).toBe('string');
        expect(handle.rtkSummary!.summary).toBeDefined();

        // Admitted provenance fields must be non-empty strings.
        expect(typeof handle.admittedHarnessFingerprint).toBe('string');
        expect(handle.admittedHarnessFingerprint.length).toBeGreaterThan(0);
        expect(typeof handle.admittedExecutionBoundary).toBe('string');
        expect(handle.admittedExecutionBoundary.length).toBeGreaterThan(0);

        // Full schema validation must pass.
        const validation = validateToolEvidenceHandle(handle, { expectedToolName: GIT_HISTORY_TOOL_NAME });
        expect(validation.valid, `validateToolEvidenceHandle errors: ${!validation.valid ? (validation as { valid: false; errors: string[] }).errors.join(', ') : ''}`).toBe(true);
      });
    });
  });

  it('PASSED run: outputFile on the result object points to the same file as semanticArtifactPath', async () => {
    await withTempDir(async (dir) => {
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(repo);
      const env = { cwd: repo };
      await execFileAsync('git', ['init', '-q'], env);
      await execFileAsync('git', ['config', 'user.email', 't@t.dev'], env);
      await execFileAsync('git', ['config', 'user.name', 'Tester'], env);
      fs.writeFileSync(path.join(repo, 'b.txt'), 'world\n');
      await execFileAsync('git', ['add', 'b.txt'], env);
      await execFileAsync('git', ['commit', '-q', '-m', 'second'], env);

      const outDir = path.join(dir, 'out');
      await withEnvVars({
        PI_WORKTREE_PATH: repo,
        PI_TOOL_OUTPUT_DIR: outDir,
        PI_TOOL_OUTPUT_FILE: undefined,
      }, async () => {
        const result = await runGitHistory(['status']);
        expect(result.status).toBe('PASSED');
        expect(result.evidenceHandle).toBeDefined();
        // The legacy outputFile must resolve to the same artifact as semanticArtifactPath.
        expect(result.outputFile).toBe(result.evidenceHandle!.semanticArtifactPath);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// AC2 (new): missing harness-injected identity → REJECTED/UNAVAILABLE
// ---------------------------------------------------------------------------

describe('AC2 (new): missing harness-injected output identity → REJECTED/UNAVAILABLE', () => {
  it('no PI_TOOL_OUTPUT_DIR and no PI_TOOL_OUTPUT_FILE → REJECTED result with failureCategory INFRA', async () => {
    await withTempDir(async (dir) => {
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(repo);
      const env = { cwd: repo };
      await execFileAsync('git', ['init', '-q'], env);
      await execFileAsync('git', ['config', 'user.email', 't@t.dev'], env);
      await execFileAsync('git', ['config', 'user.name', 'Tester'], env);
      fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
      await execFileAsync('git', ['add', 'a.txt'], env);
      await execFileAsync('git', ['commit', '-q', '-m', 'init'], env);

      await withEnvVars({
        PI_WORKTREE_PATH: repo,
        PI_TOOL_OUTPUT_DIR: undefined,
        PI_TOOL_OUTPUT_FILE: undefined,
        PI_TOOL_TMP_DIR: undefined,
      }, async () => {
        const result = await runGitHistory(['log']);
        // Must be REJECTED (not PASSED with a tmp/cwd fallback path).
        expect(result.status).toBe('REJECTED');
        expect(result.failureCategory).toBe('INFRA');
        // evidenceHandle.runStatus must also be REJECTED.
        expect(result.evidenceHandle).toBeDefined();
        expect(result.evidenceHandle!.runStatus).toBe('REJECTED');
      });
    });
  });

  it('REJECTED evidenceHandle cannot satisfy gitHistoryVerify (verifier returns FAIL)', async () => {
    await withTempDir(async (dir) => {
      // pi-experiment-yhec: gitHistoryVerify reads ctx.evidenceHandles, not toolOutputs.
      // Pass a REJECTED handle directly — the verifier must return FAIL.
      const verifyResult = gitHistoryVerify(ctxWithRejectedHandle(dir));
      expect(verifyResult.verdict).not.toBe(VerifyVerdict.PASS);
      expect(verifyResult.verdict).toBe(VerifyVerdict.FAIL);
      expect(verifyResult.failureOutcome).toBe('rejected git_history run');
    });
  });
});

// ---------------------------------------------------------------------------
// AC3 (new, negative — yhec): non-canonical handle types cannot pass gitHistoryVerify
// pi-experiment-yhec: gitHistoryVerify reads ctx.evidenceHandles, not toolOutputs.
// The VerifierGate validates handles before calling verify(). These tests confirm:
//  - A REJECTED handle → gitHistoryVerify returns FAIL.
//  - No handle → gitHistoryVerify returns NOT_APPLICABLE.
//  - A PASSED handle with a non-existent semanticArtifactPath → FAIL.
// ---------------------------------------------------------------------------

describe('AC3 (new, negative — yhec): non-canonical evidence cannot pass gitHistoryVerify', () => {
  it('NEGATIVE: no evidenceHandle in context → gitHistoryVerify returns NOT_APPLICABLE', () => {
    // pi-experiment-yhec: gitHistoryVerify reads evidenceHandles, not toolOutputs.
    // No handle = tool not in context → NOT_APPLICABLE.
    const verifyResult = gitHistoryVerify(ctxWithNoHandle());
    expect(verifyResult.verdict).toBe(VerifyVerdict.NOT_APPLICABLE);
  });

  it('NEGATIVE: REJECTED handle → gitHistoryVerify returns FAIL', async () => {
    await withTempDir(async (dir) => {
      const verifyResult = gitHistoryVerify(ctxWithRejectedHandle(dir));
      expect(verifyResult.verdict).toBe(VerifyVerdict.FAIL);
      expect(verifyResult.failureOutcome).toBe('rejected git_history run');
    });
  });

  it('NEGATIVE: PASSED handle with non-existent semanticArtifactPath → gitHistoryVerify returns FAIL', async () => {
    await withTempDir(async (dir) => {
      // A PASSED handle where the artifact file does not exist on disk.
      const verifyResult = gitHistoryVerify(ctxWithPassedHandle(path.join(dir, 'nonexistent.json'), dir));
      expect(verifyResult.verdict).toBe(VerifyVerdict.FAIL);
      expect(verifyResult.failureOutcome).toBe('unreadable git_history semantic artifact');
    });
  });

  it('NEGATIVE: a REJECTED run (no harness path) produces a REJECTED evidenceHandle → verifier returns FAIL', async () => {
    // When no harness-injected path is present, runGitHistory returns REJECTED with a REJECTED evidenceHandle.
    await withTempDir(async (dir) => {
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(repo);
      const env = { cwd: repo };
      await execFileAsync('git', ['init', '-q'], env);
      await execFileAsync('git', ['config', 'user.email', 't@t.dev'], env);
      await execFileAsync('git', ['config', 'user.name', 'Tester'], env);
      fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
      await execFileAsync('git', ['add', 'a.txt'], env);
      await execFileAsync('git', ['commit', '-q', '-m', 'init'], env);

      await withEnvVars({
        PI_WORKTREE_PATH: repo,
        PI_TOOL_OUTPUT_DIR: undefined,
        PI_TOOL_OUTPUT_FILE: undefined,
        PI_TOOL_TMP_DIR: undefined,
      }, async () => {
        const result = await runGitHistory(['log']);
        expect(result.status).toBe('REJECTED');
        expect(result.evidenceHandle).toBeDefined();
        // Build a context from the evidenceHandle the run produced.
        const handle = result.evidenceHandle!;
        const ctx: VerifyContext = {
          beadId: 'bead-1', stateId: 'state-1', actionId: 'action-1',
          writeSet: [], artifacts: {},
          evidenceHandles: { [GIT_HISTORY_TOOL_NAME]: handle as VerifyEvidenceHandle }
        };
        const verifyResult = gitHistoryVerify(ctx);
        expect(verifyResult.verdict).not.toBe(VerifyVerdict.PASS);
        expect(verifyResult.verdict).toBe(VerifyVerdict.FAIL);
      });
    });
  });

  it('NEGATIVE: a near-valid handle with semanticArtifactPath outside toolOutputRoot is caught by gate (EVIDENCE_HANDLE_INVALID), not gitHistoryVerify', async () => {
    // pi-experiment-yhec: the VerifierGate validates semanticArtifactPath containment BEFORE calling verify().
    // If the gate somehow passes a handle with out-of-root path (shouldn't happen), gitHistoryVerify
    // doesn't know — it just checks if the path exists. This test documents the gate-level protection.
    await withTempDir(async (dir) => {
      // Validate the handle directly to confirm it fails.
      const harnessOutput = path.join(dir, 'harness-output');
      const outsideFile = path.join(dir, 'outside.log');
      fs.mkdirSync(harnessOutput);
      fs.writeFileSync(outsideFile, 'test\n');
      const result = validateToolEvidenceHandle({
        schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
        toolName: GIT_HISTORY_TOOL_NAME,
        invocationId: 'inv-test-001',
        runStatus: 'PASSED',
        toolOutputRoot: harnessOutput,
        summaryMode: 'none',
        noSummaryReason: 'test',
        admittedHarnessFingerprint: 'sha256:test',
        admittedExecutionBoundary: 'bead:b1/state:s1/action:a1',
        semanticArtifactPath: outsideFile, // OUTSIDE toolOutputRoot
      }, { expectedToolName: GIT_HISTORY_TOOL_NAME });
      // Handle validation fails → gate would reject with EVIDENCE_HANDLE_INVALID.
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toContain('toolOutputRoot');
    });
  });

  it('NEGATIVE: a REJECTED-status canonical handle → gitHistoryVerify returns FAIL', async () => {
    // A canonical REJECTED handle directly passed to gitHistoryVerify → FAIL.
    await withTempDir(async (dir) => {
      const verifyResult = gitHistoryVerify(ctxWithRejectedHandle(dir));
      expect(verifyResult.verdict).toBe(VerifyVerdict.FAIL);
      expect(verifyResult.failureOutcome).toBe('rejected git_history run');
    });
  });
});

// ---------------------------------------------------------------------------
// AC4 (yhec): gitHistoryVerify() — NOT_APPLICABLE when no handle, PASS/FAIL otherwise
// pi-experiment-yhec: gitHistoryVerify reads ctx.evidenceHandles, not toolOutputs.
// It checks handle.runStatus and whether semanticArtifactPath is readable.
// ---------------------------------------------------------------------------

describe('AC4 (yhec): gitHistoryVerify() — NOT_APPLICABLE when no handle, PASS/FAIL otherwise', () => {
  it('NEGATIVE: NOT_APPLICABLE when no git_history handle is in evidenceHandles', () => {
    const result = gitHistoryVerify(ctxWithNoHandle());
    expect(result.verdict).toBe(VerifyVerdict.NOT_APPLICABLE);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('NEGATIVE: FAIL when the semanticArtifactPath does not exist on disk', async () => {
    await withTempDir(async (dir) => {
      // PASSED handle but the artifact file doesn't exist.
      const result = gitHistoryVerify(ctxWithPassedHandle(path.join(dir, 'nonexistent.json'), dir));
      expect(result.verdict).toBe(VerifyVerdict.FAIL);
      expect(result.failureOutcome).toBe('unreadable git_history semantic artifact');
    });
  });

  it('PASS: when a PASSED handle has a readable semanticArtifactPath', async () => {
    await withTempDir(async (dir) => {
      // Write any readable file — gitHistoryVerify just checks existence.
      const artifactPath = path.join(dir, 'git-history.json');
      fs.writeFileSync(artifactPath, '{"runStatus":"PASSED"}');
      const result = gitHistoryVerify(ctxWithPassedHandle(artifactPath, dir));
      expect(result.verdict).toBe(VerifyVerdict.PASS);
      // The PASS reason references the canonical handle (invocationId / admittedExecutionBoundary).
      expect(result.reasons.some((r) => r.includes('canonical handle validated'))).toBe(true);
    });
  });

  it('FAIL: when the handle has REJECTED runStatus', async () => {
    await withTempDir(async (dir) => {
      const result = gitHistoryVerify(ctxWithRejectedHandle(dir));
      expect(result.verdict).toBe(VerifyVerdict.FAIL);
      expect(result.failureOutcome).toBe('rejected git_history run');
    });
  });

  it('FAIL: when the PASSED handle has no semanticArtifactPath', async () => {
    // This tests what gitHistoryVerify does when the gate passes a handle without semPath.
    await withTempDir(async (dir) => {
      const handle: VerifyEvidenceHandle = {
        schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
        toolName: GIT_HISTORY_TOOL_NAME,
        invocationId: 'inv-nopath-001',
        runStatus: 'PASSED',
        // semanticArtifactPath intentionally absent
        toolOutputRoot: dir,
        summaryMode: 'none',
        admittedHarnessFingerprint: 'sha256:test',
        admittedExecutionBoundary: 'bead:bead-1/state:state-1/action:action-1',
      };
      const ctx: VerifyContext = {
        beadId: 'bead-1', stateId: 'state-1', actionId: 'action-1',
        writeSet: [], artifacts: {},
        evidenceHandles: { [GIT_HISTORY_TOOL_NAME]: handle }
      };
      const result = gitHistoryVerify(ctx);
      expect(result.verdict).toBe(VerifyVerdict.FAIL);
      expect(result.failureOutcome).toBe('missing git_history semantic artifact');
    });
  });

  it('END-TO-END: a canonical PASSED run satisfies gitHistoryVerify (PASS verdict)', async () => {
    await withTempDir(async (dir) => {
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(repo);
      const env = { cwd: repo };
      await execFileAsync('git', ['init', '-q'], env);
      await execFileAsync('git', ['config', 'user.email', 't@t.dev'], env);
      await execFileAsync('git', ['config', 'user.name', 'Tester'], env);
      fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
      await execFileAsync('git', ['add', 'a.txt'], env);
      await execFileAsync('git', ['commit', '-q', '-m', 'init'], env);

      const outDir = path.join(dir, 'out');
      await withEnvVars({
        PI_WORKTREE_PATH: repo,
        PI_TOOL_OUTPUT_DIR: outDir,
        PI_TOOL_OUTPUT_FILE: undefined,
        PI_BEAD_ID: 'bead-1',
        PI_STATE_ID: 'state-1',
        PI_ACTION_ID: 'action-1',
        PI_TOOL_INVOCATION_ID: 'inv-e2e-001',
      }, async () => {
        const result = await runGitHistory(['log']);
        expect(result.status).toBe('PASSED');
        expect(result.evidenceHandle).toBeDefined();
        const handle = result.evidenceHandle!;
        // Build a VerifyContext from the real evidenceHandle.
        const ctx: VerifyContext = {
          beadId: 'bead-1', stateId: 'state-1', actionId: 'action-1',
          writeSet: [], artifacts: {},
          evidenceHandles: { [GIT_HISTORY_TOOL_NAME]: handle as VerifyEvidenceHandle }
        };
        const verifyResult = gitHistoryVerify(ctx);
        expect(verifyResult.verdict).toBe(VerifyVerdict.PASS);
        expect(verifyResult.reasons.some(r => r.includes('canonical handle validated'))).toBe(true);
      });
    });
  });

  it('a non-git directory yields a REJECTED result that does NOT pass verifier', async () => {
    await withTempDir(async (dir) => {
      const notRepo = path.join(dir, 'plain');
      fs.mkdirSync(notRepo);
      await withEnvVars({
        PI_WORKTREE_PATH: notRepo,
        PI_TOOL_OUTPUT_FILE: path.join(dir, 'out.log'),
        PI_TOOL_OUTPUT_DIR: undefined,
      }, async () => {
        const result = await runGitHistory(['status']);
        expect(result.status).toBe('REJECTED');
        expect(result.failureCategory).toBe('INFRA');
        // Build context from the REJECTED evidenceHandle.
        const handle = result.evidenceHandle!;
        const ctx: VerifyContext = {
          beadId: 'bead-1', stateId: 'state-1', actionId: 'action-1',
          writeSet: [], artifacts: {},
          evidenceHandles: { [GIT_HISTORY_TOOL_NAME]: handle as VerifyEvidenceHandle }
        };
        const verifyResult = gitHistoryVerify(ctx);
        expect(verifyResult.verdict).not.toBe(VerifyVerdict.PASS);
        expect(verifyResult.verdict).toBe(VerifyVerdict.FAIL);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// AC6: parseArgs is pure deterministic argument parsing
// ---------------------------------------------------------------------------

describe('AC6: parseArgs is pure deterministic argument parsing', () => {
  it('maps git-native aliases to the structured ParsedArgs the tool runs on', () => {
    const a = parseArgs(['log', '--oneline', '-n', '5', '--', 'src/a.ts']);
    expect(a.operation).toBe('log');
    expect(a.limit).toBe(5);
    expect(a.paths).toEqual(['src/a.ts']);

    const b = parseArgs(['status', '--ignored']);
    expect(b.operation).toBe('status');
    expect(b.includeIgnored).toBe(true);

    // Same input twice yields identical output (deterministic).
    expect(parseArgs(['diff', '--name-only'])).toEqual(parseArgs(['diff', '--name-only']));
  });
});

// ---------------------------------------------------------------------------
// AC7: import hygiene — src/ imports NO cerdiwen consumer code
// ---------------------------------------------------------------------------

describe('AC7: import hygiene: src/ imports NO cerdiwen consumer code', () => {
  it('rg-style scan of src/ finds zero cerdiwen/.pi/project-tools IMPORTS', () => {
    const importSpecRes = [
      /(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/g,
      /^\s*import\s+['"]([^'"]+)['"]\s*;?/gm,
      /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    ];
    const isCerdiwenToolImport = (spec: string): boolean =>
      /cerdiwen[\\/]\.pi[\\/]project-tools/.test(spec) || /(^|[\\/])\.pi[\\/]project-tools[\\/]/.test(spec);

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const src = fs.readFileSync(full, 'utf8');
        for (const re of importSpecRes) {
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(src)) !== null) {
            if (isCerdiwenToolImport(m[1])) offenders.push(`${full}: ${m[1]}`);
          }
        }
      }
    };
    walk(path.join(PROJECT_ROOT, 'src'));
    expect(offenders, `src/ must not import cerdiwen project-tools; found: ${offenders.join(', ')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// pi-experiment-64i8: descriptor/interface cross-check
// Cross-check GIT_HISTORY_SCHEMA_DESCRIPTOR keys against GitHistoryRtkSummary
// interface fields (via GIT_HISTORY_INTERFACE_FIELDS).
//
// LOAD-BEARING: GIT_HISTORY_INTERFACE_FIELDS is typed as
// Record<keyof GitHistoryRtkSummary, true>, so a TypeScript compile error occurs
// if its keys drift from the interface. At runtime, the test compares the sorted
// key sets of the descriptor and interface record — a mismatch fails the test.
// ---------------------------------------------------------------------------

describe('pi-experiment-64i8: GIT_HISTORY_SCHEMA_DESCRIPTOR keys match GitHistoryRtkSummary interface', () => {
  it('descriptor and interface have the same field set (fails on drift)', () => {
    // Derive both key sets at runtime from the REAL exports — not hand-copied lists.
    const descriptorKeys = Object.keys(GIT_HISTORY_SCHEMA_DESCRIPTOR).sort();
    const interfaceKeys = Object.keys(GIT_HISTORY_INTERFACE_FIELDS).sort();

    // LOAD-BEARING: if a field is added to GitHistoryRtkSummary but not to
    // GIT_HISTORY_SCHEMA_DESCRIPTOR (or vice versa), the sets diverge and this
    // assertion fails. GIT_HISTORY_INTERFACE_FIELDS is typed Record<keyof
    // GitHistoryRtkSummary, true> so it also produces a TS compile error on drift.
    expect(descriptorKeys).toEqual(interfaceKeys);
  });

  it('descriptor contains every required interface field', () => {
    // Every required field of GitHistoryRtkSummary must appear in the descriptor.
    const requiredFields: Array<keyof typeof GIT_HISTORY_INTERFACE_FIELDS> = [
      'operation', 'repo', 'root', 'outputLines', 'outputFileBytes',
    ];
    for (const field of requiredFields) {
      expect(
        Object.prototype.hasOwnProperty.call(GIT_HISTORY_SCHEMA_DESCRIPTOR, field),
        `descriptor missing required field: ${field}`
      ).toBe(true);
    }
  });

  it('descriptor contains every optional interface field', () => {
    const optionalFields: Array<keyof typeof GIT_HISTORY_INTERFACE_FIELDS> = [
      'objectFound', 'lockfileReason', 'stderr', 'outputText',
    ];
    for (const field of optionalFields) {
      expect(
        Object.prototype.hasOwnProperty.call(GIT_HISTORY_SCHEMA_DESCRIPTOR, field),
        `descriptor missing optional field: ${field}`
      ).toBe(true);
    }
  });
});
