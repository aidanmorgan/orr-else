/**
 * pi-experiment-0yt5.21 — harness-side tests for the COMMON, harness-owned
 * git_history built-in tool and its SELF-registered verify().
 *
 * AC1: git_history produces a ToolResultBase-conformant result.
 * AC2: the harness SELF-registers git_history's verify() at load — verifier.has
 *      ('git_history') is true after harness bootstrap WITHOUT a consumer
 *      extension loaded.
 * AC4: git_history's verify() returns NOT_APPLICABLE when its output content is
 *      ABSENT, and PASS / FAIL otherwise.
 * Plus the import-hygiene assertion: src/ imports NO cerdiwen consumer code.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { verifier, VerifyVerdict, type VerifyContext, type ToolResultBase } from '../src/contract.js';
import {
  GIT_HISTORY_TOOL_NAME,
  gitHistoryVerify,
  runGitHistory,
  archiveOutput,
  parseArgs
} from '../src/tools/git_history.js';

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

describe('AC2: the harness self-registers git_history verify() at load (no consumer extension)', () => {
  it('verifier has a git_history entry after merely importing the harness built-in tools barrel', async () => {
    // Importing src/tools/index.js (the harness built-in bootstrap) self-registers
    // git_history's verify() as an import side effect — no consumer extension loaded.
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

describe('AC1: runGitHistory produces a ToolResultBase-conformant result', () => {
  it('returns {tool,status,outputFile,outputFileBytes} for a real git status invocation', async () => {
    await withTempDir(async (dir) => {
      // Build a tiny real git repo so the tool runs end-to-end.
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(repo);
      const env = { cwd: repo };
      await execFileAsync('git', ['init', '-q'], env);
      await execFileAsync('git', ['config', 'user.email', 't@t.dev'], env);
      await execFileAsync('git', ['config', 'user.name', 'Tester'], env);
      fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
      await execFileAsync('git', ['add', 'a.txt'], env);
      await execFileAsync('git', ['commit', '-q', '-m', 'init'], env);

      const prevWorktree = process.env.PI_WORKTREE_PATH;
      const prevOutDir = process.env.PI_TOOL_OUTPUT_DIR;
      const prevOutFile = process.env.PI_TOOL_OUTPUT_FILE;
      process.env.PI_WORKTREE_PATH = repo;
      process.env.PI_TOOL_OUTPUT_DIR = path.join(dir, 'out');
      delete process.env.PI_TOOL_OUTPUT_FILE;
      try {
        const result: ToolResultBase = await runGitHistory(['log']);
        expect(result.tool).toBe(GIT_HISTORY_TOOL_NAME);
        expect(result.status).toBe('PASSED');
        expect(typeof result.outputFile).toBe('string');
        expect(path.isAbsolute(result.outputFile)).toBe(true);
        expect(fs.existsSync(result.outputFile)).toBe(true);
        expect(typeof result.outputFileBytes).toBe('number');
        expect(result.outputFileBytes).toBeGreaterThan(0);
        // The base shape has EXACTLY the 5 fields (+ tool-owned extras allowed).
        expect(result.failureCategory).toBeUndefined();
        // Output content is real git evidence.
        expect(fs.readFileSync(result.outputFile, 'utf8')).toContain('init');
      } finally {
        if (prevWorktree === undefined) delete process.env.PI_WORKTREE_PATH; else process.env.PI_WORKTREE_PATH = prevWorktree;
        if (prevOutDir === undefined) delete process.env.PI_TOOL_OUTPUT_DIR; else process.env.PI_TOOL_OUTPUT_DIR = prevOutDir;
        if (prevOutFile === undefined) delete process.env.PI_TOOL_OUTPUT_FILE; else process.env.PI_TOOL_OUTPUT_FILE = prevOutFile;
      }
    });
  });

  it('a non-git directory yields a REJECTED ToolResultBase with a failureCategory', async () => {
    await withTempDir(async (dir) => {
      const notRepo = path.join(dir, 'plain');
      fs.mkdirSync(notRepo);
      const prevWorktree = process.env.PI_WORKTREE_PATH;
      const prevOutFile = process.env.PI_TOOL_OUTPUT_FILE;
      process.env.PI_WORKTREE_PATH = notRepo;
      process.env.PI_TOOL_OUTPUT_FILE = path.join(dir, 'out.log');
      try {
        const result = await runGitHistory(['status']);
        expect(result.status).toBe('REJECTED');
        expect(result.failureCategory).toBe('INFRA');
        expect(fs.existsSync(result.outputFile)).toBe(true);
      } finally {
        if (prevWorktree === undefined) delete process.env.PI_WORKTREE_PATH; else process.env.PI_WORKTREE_PATH = prevWorktree;
        if (prevOutFile === undefined) delete process.env.PI_TOOL_OUTPUT_FILE; else process.env.PI_TOOL_OUTPUT_FILE = prevOutFile;
      }
    });
  });
});

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

  it('PASS: when the archived output holds non-empty git evidence', async () => {
    await withTempDir(async (dir) => {
      const { outputFile } = await archiveOutput(dir, '4c241a5 some commit\n180355f another commit\n');
      const result = gitHistoryVerify(ctxWith({ [GIT_HISTORY_TOOL_NAME]: outputFile }));
      expect(result.verdict).toBe(VerifyVerdict.PASS);
      expect(result.reasons.some((r) => r.includes('git evidence'))).toBe(true);
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
});

describe('determinism: parseArgs is pure deterministic argument parsing', () => {
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

describe('import hygiene: src/ imports NO cerdiwen consumer code', () => {
  it('rg-style scan of src/ finds zero cerdiwen/.pi/project-tools IMPORTS', () => {
    // Match only IMPORT specifiers (import/export ... from '…', side-effect
    // import '…', dynamic import('…')/require('…')) that reference a cerdiwen
    // project-tools module — NOT incidental path-string constants.
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
