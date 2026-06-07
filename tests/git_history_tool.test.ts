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

import { verifier, VerifyVerdict, type VerifyContext } from '../src/contract.js';
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
} from '../src/core/ToolEvidenceHandle.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

function ctxWith(toolOutputs: Record<string, string>): VerifyContext {
  return {
    beadId: 'bead-1',
    stateId: 'state-1',
    actionId: 'action-1',
    writeSet: [],
    artifacts: {},
    toolOutputs
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
        // The outputFile (if any) from a REJECTED run must NOT pass the verifier.
        const verifyResult = gitHistoryVerify(ctxWith({ [GIT_HISTORY_TOOL_NAME]: result.outputFile }));
        expect(verifyResult.verdict).not.toBe(VerifyVerdict.PASS);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// AC3 (new, negative): tmp/cwd/outputFile-only/ToolResultBase-shaped artifacts CANNOT pass
// ---------------------------------------------------------------------------

describe('AC3 (new, negative): non-canonical artifacts cannot pass gitHistoryVerify', () => {
  it('NEGATIVE (real verifier): a tmp-dir raw git log file makes gitHistoryVerify return FAIL', async () => {
    // A raw git log file (not a ToolEvidenceHandle JSON) written to a temp dir:
    // gitHistoryVerify must return FAIL (fails JSON/handle validation), never PASS.
    await withTempDir(async (dir) => {
      const rawLogFile = path.join(dir, 'git-history.stdout.log');
      fs.writeFileSync(rawLogFile, '4c241a5 init\n');
      const verifyResult = gitHistoryVerify(ctxWith({ [GIT_HISTORY_TOOL_NAME]: rawLogFile }));
      // Raw git text is not valid JSON → not a canonical handle → FAIL (not PASS).
      expect(verifyResult.verdict).toBe(VerifyVerdict.FAIL);
      expect(verifyResult.failureOutcome).toBeDefined();
    });
  });

  it('NEGATIVE (real verifier): a REJECTED run (no harness path) outputFile cannot produce PASS', async () => {
    // When no harness-injected path is present, the run is REJECTED and outputFile is ''.
    // gitHistoryVerify with an empty/absent path returns NOT_APPLICABLE (not PASS).
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
        const verifyResult = gitHistoryVerify(ctxWith({ [GIT_HISTORY_TOOL_NAME]: result.outputFile }));
        // A REJECTED run's outputFile (empty string) cannot produce PASS in the verifier.
        expect(verifyResult.verdict).not.toBe(VerifyVerdict.PASS);
      });
    });
  });

  it('NEGATIVE (real verifier): an outputFile-only record (ToolResultBase shape) written to disk makes gitHistoryVerify FAIL', async () => {
    // A ToolResultBase-like JSON (missing invocationId, schemaVersion, etc.) written to disk:
    // gitHistoryVerify must return FAIL when it reads this file (fails validateToolEvidenceHandle).
    await withTempDir(async (dir) => {
      const toolResultBaseLike = {
        tool: GIT_HISTORY_TOOL_NAME,
        status: 'PASSED',
        outputFile: path.join(dir, 'git-history.stdout.log'),
        outputFileBytes: 42,
      };
      const artifactFile = path.join(dir, 'git-history.json');
      fs.writeFileSync(artifactFile, JSON.stringify(toolResultBaseLike, null, 2));

      const verifyResult = gitHistoryVerify(ctxWith({ [GIT_HISTORY_TOOL_NAME]: artifactFile }));
      // ToolResultBase-shaped artifact fails handle validation → FAIL (not PASS).
      expect(verifyResult.verdict).toBe(VerifyVerdict.FAIL);
      expect(verifyResult.failureOutcome).toBeDefined();
    });
  });

  it('NEGATIVE (real verifier): various ToolResultBase-shaped JSON files make gitHistoryVerify FAIL', async () => {
    // Any JSON object missing canonical ToolEvidenceHandle fields must FAIL gitHistoryVerify.
    const shapes = [
      { tool: GIT_HISTORY_TOOL_NAME, status: 'PASSED', outputFile: '/tmp/a.log', outputFileBytes: 10 },
      { toolName: GIT_HISTORY_TOOL_NAME, runStatus: 'PASSED', outputFile: '/tmp/a.log' },
      { toolName: GIT_HISTORY_TOOL_NAME, runStatus: 'PASSED', toolOutputRoot: '/out', summaryMode: 'none' },
    ];
    await withTempDir(async (dir) => {
      for (const shape of shapes) {
        const artifactFile = path.join(dir, `shape-${Object.keys(shape).join('-')}.json`);
        fs.writeFileSync(artifactFile, JSON.stringify(shape, null, 2));
        const verifyResult = gitHistoryVerify(ctxWith({ [GIT_HISTORY_TOOL_NAME]: artifactFile }));
        expect(verifyResult.verdict, `expected FAIL for shape: ${JSON.stringify(shape)}`).toBe(VerifyVerdict.FAIL);
      }
    });
  });

  it('NEGATIVE (real verifier): a near-valid handle with semanticArtifactPath outside toolOutputRoot makes gitHistoryVerify FAIL', async () => {
    // A handle JSON that has semanticArtifactPath outside toolOutputRoot fails
    // validateToolEvidenceHandle → gitHistoryVerify returns FAIL.
    await withTempDir(async (dir) => {
      // The handle file lives inside harness-output, but semanticArtifactPath is outside.
      const harnessOutput = path.join(dir, 'harness-output');
      fs.mkdirSync(harnessOutput);
      const outsideFile = path.join(dir, 'outside.log');
      fs.writeFileSync(outsideFile, '4c241a5 init\n');

      const nearValidHandle = {
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
      };
      const artifactFile = path.join(harnessOutput, 'git-history.json');
      fs.writeFileSync(artifactFile, JSON.stringify(nearValidHandle, null, 2));

      const verifyResult = gitHistoryVerify(ctxWith({ [GIT_HISTORY_TOOL_NAME]: artifactFile }));
      // Handle fails validateToolEvidenceHandle (semanticArtifactPath outside root) → FAIL.
      expect(verifyResult.verdict).toBe(VerifyVerdict.FAIL);
      expect(verifyResult.failureOutcome).toBeDefined();
    });
  });

  it('NEGATIVE (real verifier): a REJECTED-status handle JSON makes gitHistoryVerify FAIL', async () => {
    // A valid ToolEvidenceHandle with runStatus: 'REJECTED' must make gitHistoryVerify FAIL.
    await withTempDir(async (dir) => {
      const harnessOutput = path.join(dir, 'harness-output');
      fs.mkdirSync(harnessOutput);
      const handleFile = path.join(harnessOutput, 'git-history.json');

      const rejectedHandle = {
        schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
        toolName: GIT_HISTORY_TOOL_NAME,
        invocationId: 'inv-rejected-001',
        runStatus: 'REJECTED',
        failureCategory: 'INFRA',
        toolOutputRoot: harnessOutput,
        summaryMode: 'none',
        noSummaryReason: 'REJECTED: not a git repository',
        admittedHarnessFingerprint: 'sha256:test',
        admittedExecutionBoundary: 'bead:b1/state:s1/action:a1',
        semanticArtifactPath: handleFile,
      };
      fs.writeFileSync(handleFile, JSON.stringify(rejectedHandle, null, 2));

      const verifyResult = gitHistoryVerify(ctxWith({ [GIT_HISTORY_TOOL_NAME]: handleFile }));
      // REJECTED runStatus → FAIL (not PASS).
      expect(verifyResult.verdict).toBe(VerifyVerdict.FAIL);
      expect(verifyResult.failureOutcome).toBe('rejected git_history run');
    });
  });
});

// ---------------------------------------------------------------------------
// AC4: gitHistoryVerify() — NOT_APPLICABLE when content absent, PASS/FAIL otherwise
// ---------------------------------------------------------------------------

describe('AC4: gitHistoryVerify() — NOT_APPLICABLE when content absent, PASS/FAIL otherwise', () => {
  it('NEGATIVE: NOT_APPLICABLE when no git_history output path is recorded', () => {
    const result = gitHistoryVerify(ctxWith({}));
    expect(result.verdict).toBe(VerifyVerdict.NOT_APPLICABLE);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('NEGATIVE: NOT_APPLICABLE when the recorded output path does not exist', () => {
    const result = gitHistoryVerify(ctxWith({ [GIT_HISTORY_TOOL_NAME]: '/no/such/git-history.log' }));
    expect(result.verdict).toBe(VerifyVerdict.NOT_APPLICABLE);
  });

  it('NEGATIVE: NOT_APPLICABLE when the archived output is an empty file', async () => {
    await withTempDir(async (dir) => {
      const { outputFile } = await archiveOutput(dir, '');
      const result = gitHistoryVerify(ctxWith({ [GIT_HISTORY_TOOL_NAME]: outputFile }));
      expect(result.verdict).toBe(VerifyVerdict.NOT_APPLICABLE);
    });
  });

  it('PASS: when the artifact is a canonical PASSED ToolEvidenceHandle JSON', async () => {
    await withTempDir(async (dir) => {
      // Write a valid canonical handle JSON with runStatus PASSED and a readable semanticArtifactPath.
      const canonicalHandle = {
        schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
        toolName: GIT_HISTORY_TOOL_NAME,
        invocationId: 'inv-pass-001',
        runStatus: 'PASSED',
        semanticArtifactPath: path.join(dir, 'git-history.json'), // points to self (will be written below)
        toolOutputRoot: dir,
        summaryMode: 'summary' as const,
        rtkSummary: {
          schemaTypeName: 'GitHistoryRtkSummary',
          owningFile: 'src/tools/git_history.ts',
          summarySchemaVersion: '1.0.0',
          schemaHash: 'sha256:' + 'a'.repeat(64),
          deterministicSummaryVersion: '1.0.0',
          inputArtifactSchemaId: 'git-stdout-log',
          inputArtifactSchemaVersion: '1.0.0',
          maximumCounts: { commits: 50, paths: 30 },
          omissionSemantics: 'commits beyond maximumCounts.commits are omitted; outputLines reports total',
          summary: { operation: 'log', repo: 'worktree', root: dir, outputLines: 2, outputFileBytes: 40, outputText: '4c241a5 some commit\n180355f another commit' },
        },
        admittedHarnessFingerprint: 'sha256:test',
        admittedExecutionBoundary: 'bead:b1/state:s1/action:a1',
      };
      const handleFile = path.join(dir, 'git-history.json');
      fs.writeFileSync(handleFile, JSON.stringify(canonicalHandle, null, 2));

      const result = gitHistoryVerify(ctxWith({ [GIT_HISTORY_TOOL_NAME]: handleFile }));
      expect(result.verdict).toBe(VerifyVerdict.PASS);
      // The PASS reason references the canonical handle (invocationId / admittedExecutionBoundary).
      expect(result.reasons.some((r) => r.includes('canonical handle validated'))).toBe(true);
    });
  });

  it('FAIL: when the archive holds a recorded REJECTED git_history payload', async () => {
    await withTempDir(async (dir) => {
      const payload = JSON.stringify({ tool: GIT_HISTORY_TOOL_NAME, status: 'REJECTED', error: 'not a git repo' });
      const { outputFile } = await archiveOutput(dir, payload);
      const result = gitHistoryVerify(ctxWith({ [GIT_HISTORY_TOOL_NAME]: outputFile }));
      expect(result.verdict).toBe(VerifyVerdict.FAIL);
      expect(result.failureOutcome).toBeDefined();
    });
  });

  it('FAIL: when the archive is whitespace-only despite a non-empty file', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'ws.log');
      fs.writeFileSync(filePath, '   \n  \t\n');
      const result = gitHistoryVerify(ctxWith({ [GIT_HISTORY_TOOL_NAME]: filePath }));
      expect(result.verdict).toBe(VerifyVerdict.FAIL);
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
      }, async () => {
        const result = await runGitHistory(['log']);
        expect(result.status).toBe('PASSED');
        // The verifier must return PASS when given the semantic artifact path.
        const verifyResult = gitHistoryVerify(ctxWith({ [GIT_HISTORY_TOOL_NAME]: result.outputFile }));
        expect(verifyResult.verdict).toBe(VerifyVerdict.PASS);
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
        expect(fs.existsSync(result.outputFile)).toBe(true);
        // REJECTED run's outputFile must not pass the verifier.
        const verifyResult = gitHistoryVerify(ctxWith({ [GIT_HISTORY_TOOL_NAME]: result.outputFile }));
        expect(verifyResult.verdict).not.toBe(VerifyVerdict.PASS);
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
