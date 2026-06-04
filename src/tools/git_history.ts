#!/usr/bin/env node
/**
 * git_history — a COMMON, harness-OWNED built-in tool (pi-experiment-0yt5.21).
 *
 * git_history is NOT cerdiwen-specific. It lives in the orr-else harness `src/`
 * tree, owns its OWN deterministic git-output parsing, produces a
 * ToolResultBase-conformant result, and ships a deterministic verify() callback
 * that the harness SELF-registers at load (see ./index.ts). This module imports
 * ONLY the contract TYPES and node builtins — never any consumer code.
 *
 * Behaviour mirrors the reference implementation that previously lived in the
 * cerdiwen checkout, but the path resolution is now harness-native: it reads the
 * harness-injected PI_* env vars (EnvVars) rather than any consumer helper.
 *
 * Determinism: argument parsing and git-output handling are pure deterministic
 * code (node:util parseArgs + explicit branching, minimal regex) — NOT LLM-based.
 * The verify() is pure given a paths-only VerifyContext: it reads the recorded
 * outputFile and judges presence/shape on disk.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path, { relative, resolve } from 'node:path';
import { parseArgs as parseNodeArgs, promisify } from 'node:util';

import {
  VerifyVerdict,
  type ToolResultBase,
  type VerifyContext,
  type VerifyResult
} from '../contract.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from '../core/RuntimeEnvironment.js';

const execFileAsync = promisify(execFile);

export const GIT_HISTORY_TOOL_NAME = 'git_history';

const STATUS = {
  PASSED: 'PASSED',
  REJECTED: 'REJECTED'
} as const;

const OPERATIONS = {
  STATUS: 'status',
  LOG: 'log',
  DIFF: 'diff',
  SHOW: 'show'
} as const;

const REPOSITORIES = {
  WORKTREE: 'worktree',
  PROJECT: 'project'
} as const;

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;
const MAX_PATHS = 30;
const DEFAULT_UNIFIED_CONTEXT_LINES = 3;
const MAX_UNIFIED_CONTEXT_LINES = 500;
const OUTPUT_FILE_NAME = 'git-history.stdout.log';
const EXEC_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const EXEC_TIMEOUT_MS = 120_000;
const EMPTY_HISTORY_PATTERN = /does not have any commits yet|your current branch .* does not have any commits yet/i;
const OBJECT_MISSING_FROM_REVISION_PATTERN = /fatal: path '.+' exists on disk, but not in '.+'|fatal: path '.+' does not exist in '.+'/i;
const GIT_STATUS_IGNORED_ALIAS = '--ignored';
const GIT_STATUS_UNTRACKED_ALIAS = '--untracked';
const GIT_STATUS_PORCELAIN_ALIAS = '--porcelain';
const GIT_LOG_MAX_COUNT_ALIAS = '--max-count';
const GIT_LOG_ONELINE_ALIAS = '--oneline';
const GIT_LOG_DECORATE_ALIAS = '--decorate';
const INCLUDE_IGNORED_OPTION = '--include-ignored';
const INCLUDE_UNTRACKED_OPTION = '--include-untracked';
const LOCKFILE_PATH_PATTERN = /(^|\/)(uv\.lock|poetry\.lock|Pipfile\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock)$/;

type Operation = typeof OPERATIONS[keyof typeof OPERATIONS];
type Repository = typeof REPOSITORIES[keyof typeof REPOSITORIES];

export type ParsedArgs = {
  operation: Operation;
  repo: Repository;
  paths: string[];
  limit: number;
  ref?: string;
  object?: string;
  base?: string;
  head?: string;
  patch: boolean;
  stat: boolean;
  nameOnly: boolean;
  includeIgnored: boolean;
  includeUntracked: boolean;
  porcelain: boolean;
  unified: number;
  allowLockfileContent: boolean;
  lockfileReason?: string;
  help: boolean;
};

/**
 * The model-facing git_history result. Extends the harness ToolResultBase with
 * the tool's own structured fields. The five ToolResultBase fields are the thin
 * "did the tool RUN" base — the semantic verdict lives in verify(), never here.
 */
export interface GitHistoryResult extends ToolResultBase {
  operation?: Operation;
  repo?: Repository;
  root?: string;
  command?: { binary: string; args: string[] };
  lockfileReason?: string;
  objectFound?: boolean;
  outputLines?: number;
  stderr?: string;
  error?: string;
}

function print(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function asOperation(value: string): Operation {
  const operations = Object.values(OPERATIONS) as string[];
  if (operations.includes(value)) return value as Operation;
  throw new Error(`unsupported operation: ${value}`);
}

function asRepository(value: string): Repository {
  const repositories = Object.values(REPOSITORIES) as string[];
  if (repositories.includes(value)) return value as Repository;
  throw new Error(`unsupported repo: ${value}`);
}

function parseLimit(value: string | undefined): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function parseUnified(value: string | undefined): number {
  if (!value) return DEFAULT_UNIFIED_CONTEXT_LINES;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_UNIFIED_CONTEXT_LINES;
  return Math.min(parsed, MAX_UNIFIED_CONTEXT_LINES);
}

function appendPaths(paths: string[], value: string): void {
  for (const item of value.split(',')) {
    const trimmed = item.trim();
    if (trimmed) paths.push(trimmed);
  }
}

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  return [];
}

function normalizeArgvForParse(argv: string[]): string[] {
  const normalized: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === GIT_STATUS_IGNORED_ALIAS || arg.startsWith(`${GIT_STATUS_IGNORED_ALIAS}=`)) {
      normalized.push(INCLUDE_IGNORED_OPTION);
      continue;
    }
    if (arg === GIT_STATUS_UNTRACKED_ALIAS || arg.startsWith(`${GIT_STATUS_UNTRACKED_ALIAS}=`)) {
      normalized.push(INCLUDE_UNTRACKED_OPTION);
      continue;
    }
    if (arg.startsWith(`${GIT_STATUS_PORCELAIN_ALIAS}=`)) {
      normalized.push(GIT_STATUS_PORCELAIN_ALIAS);
      continue;
    }
    if (arg === GIT_LOG_MAX_COUNT_ALIAS || arg.startsWith(`${GIT_LOG_MAX_COUNT_ALIAS}=`)) {
      normalized.push(arg.replace(GIT_LOG_MAX_COUNT_ALIAS, '--limit'));
      continue;
    }
    if (/^-\d+$/u.test(arg)) {
      normalized.push('--limit', arg.slice(1));
      continue;
    }
    if (arg === GIT_LOG_ONELINE_ALIAS || arg === '--abbrev-commit' || arg.startsWith('--pretty=') || arg.startsWith('--format=')) {
      continue;
    }
    if (arg === GIT_LOG_DECORATE_ALIAS) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) index += 1;
      continue;
    }
    if (arg.startsWith(`${GIT_LOG_DECORATE_ALIAS}=`)) continue;
    normalized.push(arg);
  }
  return normalized;
}

function parseArgsEnvelopeValue(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Fall through to treating the value as one native git argv token.
    }
  }
  return [value];
}

function expandStructuredArgsEnvelope(argv: string[]): string[] {
  const wrapperArgs: string[] = [];
  const gitArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--args') {
      const value = argv[index + 1];
      if (value !== undefined) {
        gitArgs.push(...parseArgsEnvelopeValue(value));
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--args=')) {
      gitArgs.push(...parseArgsEnvelopeValue(arg.slice('--args='.length)));
      continue;
    }
    wrapperArgs.push(arg);
  }
  return [...wrapperArgs, ...gitArgs];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const normalizedArgv = normalizeArgvForParse(expandStructuredArgsEnvelope(argv));
  const { values, positionals } = parseNodeArgs({
    args: normalizedArgv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      verbose: { type: 'boolean', short: 'v' },
      version: { type: 'boolean' },
      json: { type: 'boolean' },
      operation: { type: 'string' },
      repo: { type: 'string' },
      filter: { type: 'string', multiple: true },
      paths: { type: 'string', multiple: true },
      path: { type: 'string', multiple: true },
      limit: { type: 'string', short: 'n' },
      ref: { type: 'string' },
      revision: { type: 'string' },
      rev: { type: 'string' },
      object: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      patch: { type: 'boolean' },
      stat: { type: 'boolean' },
      'name-only': { type: 'boolean' },
      nameOnly: { type: 'boolean' },
      'include-ignored': { type: 'boolean' },
      includeIgnored: { type: 'boolean' },
      'show-ignored': { type: 'boolean' },
      showIgnored: { type: 'boolean' },
      'include-untracked': { type: 'boolean' },
      includeUntracked: { type: 'boolean' },
      'show-untracked': { type: 'boolean' },
      showUntracked: { type: 'boolean' },
      porcelain: { type: 'boolean' },
      short: { type: 'boolean' },
      branch: { type: 'boolean' },
      full: { type: 'boolean' },
      unified: { type: 'string', short: 'U' },
      'allow-lockfile-content': { type: 'boolean' },
      allowLockfileContent: { type: 'boolean' },
      'lockfile-reason': { type: 'string' },
      lockfileReason: { type: 'string' }
    }
  });
  const remainingPositionals = [...positionals];
  const positionalOperation =
    typeof remainingPositionals[0] === 'string' && (Object.values(OPERATIONS) as string[]).includes(remainingPositionals[0])
      ? asOperation(String(remainingPositionals.shift()))
      : undefined;
  const positionalObject =
    positionalOperation === OPERATIONS.SHOW && remainingPositionals.length === 1 && remainingPositionals[0]?.includes(':')
      ? String(remainingPositionals.shift())
      : undefined;
  const parsed: ParsedArgs = {
    operation: values.operation ? asOperation(String(values.operation)) : positionalOperation ?? OPERATIONS.STATUS,
    repo: values.repo ? asRepository(String(values.repo)) : REPOSITORIES.WORKTREE,
    paths: [],
    limit: parseLimit(typeof values.limit === 'string' ? values.limit : undefined),
    ref:
      typeof values.ref === 'string'
        ? values.ref
        : typeof values.revision === 'string'
          ? values.revision
          : typeof values.rev === 'string'
            ? values.rev
            : undefined,
    object: typeof values.object === 'string' ? values.object : positionalObject,
    base: typeof values.base === 'string' ? values.base : undefined,
    head: typeof values.head === 'string' ? values.head : undefined,
    patch: values.patch === true || values.full === true || values.unified !== undefined,
    stat: values.stat !== false,
    nameOnly: values['name-only'] === true || values.nameOnly === true,
    includeIgnored:
      values['include-ignored'] === true || values.includeIgnored === true || values['show-ignored'] === true || values.showIgnored === true,
    includeUntracked:
      values['include-untracked'] === true ||
      values.includeUntracked === true ||
      values['show-untracked'] === true ||
      values.showUntracked === true,
    porcelain: values.porcelain === true,
    unified: parseUnified(typeof values.unified === 'string' ? values.unified : undefined),
    allowLockfileContent: values['allow-lockfile-content'] === true || values.allowLockfileContent === true,
    lockfileReason:
      typeof values['lockfile-reason'] === 'string'
        ? values['lockfile-reason']
        : typeof values.lockfileReason === 'string'
          ? values.lockfileReason
          : undefined,
    help: values.help === true
  };

  for (const value of [...stringValues(values.filter), ...stringValues(values.paths), ...stringValues(values.path), ...remainingPositionals]) {
    appendPaths(parsed.paths, value);
  }

  parsed.paths = [...new Set(parsed.paths)].slice(0, MAX_PATHS);
  return parsed;
}

function rejectOptionLike(value: string | undefined, field: string): void {
  if (value?.startsWith('-')) throw new Error(`${field} must not start with '-'`);
}

function validatePath(root: string, pathArg: string): string {
  if (pathArg.startsWith('-')) throw new Error(`path must not start with '-': ${pathArg}`);
  const absolute = resolve(root, pathArg);
  const rel = relative(root, absolute);
  if (rel === '') return '.';
  if (rel.startsWith('..') || rel.startsWith('/')) {
    throw new Error(`path must stay inside selected repository: ${pathArg}`);
  }
  return rel;
}

// ---------------------------------------------------------------------------
// Harness-native path resolution. Reads the PI_* env vars the harness injects
// for every tool invocation. NO consumer helper is imported.
// ---------------------------------------------------------------------------

function inferWorkspaceRoot(start: string): string | undefined {
  // <workspace>/worktrees/<beadId>/... resolves back to <workspace> so harness
  // artifacts stay workspace-root relative even inside isolated bead worktrees.
  const marker = `${path.sep}worktrees${path.sep}`;
  const idx = start.indexOf(marker);
  if (idx < 0) return undefined;
  return start.slice(0, idx);
}

export function projectRoot(env: RuntimeEnvironment = nodeRuntimeEnvironment): string {
  return path.resolve(
    env.env('PI_PROJECT_ROOT') ||
      inferWorkspaceRoot(env.env('PI_WORKTREE_PATH') || env.env('PI_TOOL_WORKING_DIR') || process.cwd()) ||
      process.cwd()
  );
}

export function worktreeRoot(env: RuntimeEnvironment = nodeRuntimeEnvironment): string {
  return path.resolve(env.env('PI_TOOL_WORKING_DIR') || env.env('PI_WORKTREE_PATH') || process.cwd());
}

function repoRoot(repo: Repository, env: RuntimeEnvironment): string {
  if (repo === REPOSITORIES.PROJECT) return projectRoot(env);
  return worktreeRoot(env);
}

/**
 * Where the raw git output archive is written. Precedence:
 *   PI_TOOL_OUTPUT_FILE — the harness-assigned exact output file (if set).
 *   PI_TOOL_OUTPUT_DIR  — the harness-assigned output directory.
 *   PI_TOOL_TMP_DIR / os tmp — last-resort fallback.
 */
function resolveOutputTarget(env: RuntimeEnvironment): { dir: string; file: string } {
  const explicitFile = env.env('PI_TOOL_OUTPUT_FILE');
  if (explicitFile) {
    return { dir: path.dirname(path.resolve(explicitFile)), file: path.resolve(explicitFile) };
  }
  const dir = path.resolve(env.env('PI_TOOL_OUTPUT_DIR') || env.env('PI_TOOL_TMP_DIR') || resolve(process.cwd(), '.tmp', 'git-history'));
  return { dir, file: resolve(dir, OUTPUT_FILE_NAME) };
}

function commandFor(args: ParsedArgs, root: string): string[] {
  rejectOptionLike(args.ref, 'ref');
  rejectOptionLike(args.object, 'object');
  rejectOptionLike(args.base, 'base');
  rejectOptionLike(args.head, 'head');
  validateLockfileContentAccess(args);
  const paths = args.paths.map((p) => validatePath(root, p));

  if (args.operation === OPERATIONS.STATUS) {
    const ignoredArgs = args.includeIgnored || paths.length > 0 ? ['--ignored=matching'] : [];
    const untrackedArgs = args.includeUntracked ? ['--untracked-files=all'] : [];
    return ['status', '--short', '--branch', ...ignoredArgs, ...untrackedArgs, '--', ...paths];
  }

  if (args.operation === OPERATIONS.LOG) {
    const formatArgs = args.nameOnly ? ['--name-only'] : [];
    return ['log', '--oneline', '--decorate=short', '-n', String(args.limit), ...formatArgs, '--', ...paths];
  }

  if (args.operation === OPERATIONS.DIFF) {
    const range = args.base && args.head ? [`${args.base}..${args.head}`] : [];
    const formatArgs = args.patch ? ['--patch', `--unified=${args.unified}`] : ['--stat'];
    if (args.nameOnly) {
      return ['diff', '--name-only', '--no-ext-diff', ...range, '--', ...paths];
    }
    return ['diff', ...formatArgs, '--no-ext-diff', ...range, '--', ...paths];
  }

  const ref = args.object || args.ref || 'HEAD';
  if (args.object) {
    return ['show', '--no-ext-diff', ref];
  }
  const formatArgs = args.patch
    ? ['--patch', `--unified=${args.unified}`]
    : args.nameOnly
      ? ['--name-only']
      : args.stat
        ? ['--stat', '--oneline', '--decorate=short']
        : ['--no-patch', '--format=fuller'];
  return ['show', ...formatArgs, '--no-ext-diff', ref, '--', ...paths];
}

function showObjectPath(object: string | undefined): string | undefined {
  if (!object) return undefined;
  const separatorIndex = object.indexOf(':');
  if (separatorIndex < 0) return undefined;
  return object.slice(separatorIndex + 1);
}

function validateLockfileContentAccess(args: ParsedArgs): void {
  const objectPath = showObjectPath(args.object);
  if (args.operation !== OPERATIONS.SHOW || !objectPath || !LOCKFILE_PATH_PATTERN.test(objectPath)) return;
  if (!args.allowLockfileContent) {
    throw new Error(
      `Refusing to show lockfile content for ${objectPath}. Use status/diff to prove lockfile drift. ` +
        'Pass --allow-lockfile-content with --lockfile-reason only when the Bead explicitly requires dependency metadata or status/diff reports a lockfile change.'
    );
  }
  if (!args.lockfileReason?.trim()) {
    throw new Error('Lockfile content reads require --lockfile-reason evidence.');
  }
}

function isExpectedMissingShowObject(args: ParsedArgs, stderr: string): boolean {
  return args.operation === OPERATIONS.SHOW && args.object !== undefined && OBJECT_MISSING_FROM_REVISION_PATTERN.test(stderr);
}

/** Archive the COMPLETE raw git output to disk; return the file path and byte count. No cap or truncation. */
export async function archiveOutput(outDir: string, content: string, fileName: string = OUTPUT_FILE_NAME): Promise<{ outputFile: string; outputFileBytes: number }> {
  await mkdir(outDir, { recursive: true });
  const outputFile = fileName.includes(path.sep) ? resolve(fileName) : resolve(outDir, fileName);
  await writeFile(outputFile, content, 'utf8');
  const outputFileBytes = await stat(outputFile)
    .then((s) => s.size)
    .catch(() => Buffer.byteLength(content, 'utf8'));
  return { outputFile, outputFileBytes };
}

/**
 * Run git_history once and return the harness ToolResultBase-conformant result.
 * Pure deterministic body: argv -> git argv -> exec -> archive -> result.
 * Never throws for expected git conditions (empty history, missing show object).
 */
export async function runGitHistory(argv: string[], env: RuntimeEnvironment = nodeRuntimeEnvironment): Promise<GitHistoryResult> {
  const args = parseArgs(argv);
  const { dir: outDir, file: outFile } = resolveOutputTarget(env);

  if (args.help) {
    const message = 'Help output is not git history evidence and cannot satisfy required git_history gates.';
    const { outputFile, outputFileBytes } = await archiveOutput(outDir, message, outFile);
    return {
      tool: GIT_HISTORY_TOOL_NAME,
      status: STATUS.REJECTED,
      failureCategory: 'INPUT',
      outputFile,
      outputFileBytes,
      error: message
    };
  }

  const root = repoRoot(args.repo, env);
  if (!existsSync(resolve(root, '.git'))) {
    const message = `selected repository is not a git repository: ${root}`;
    const { outputFile, outputFileBytes } = await archiveOutput(outDir, message, outFile);
    return {
      tool: GIT_HISTORY_TOOL_NAME,
      status: STATUS.REJECTED,
      failureCategory: 'INFRA',
      outputFile,
      outputFileBytes,
      error: message
    };
  }

  const gitArgs = commandFor(args, root);
  let stdout = '';
  let stderr = '';
  let objectFound: boolean | undefined;
  try {
    const result = await execFileAsync('git', gitArgs, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: EXEC_MAX_BUFFER_BYTES,
      timeout: EXEC_TIMEOUT_MS
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error: unknown) {
    const commandError = error as { stdout?: string; stderr?: string; message?: string };
    stdout = commandError.stdout || '';
    stderr = commandError.stderr || commandError.message || '';
    if (isExpectedMissingShowObject(args, stderr)) {
      objectFound = false;
    } else if (!EMPTY_HISTORY_PATTERN.test(stderr)) {
      throw error;
    }
  }
  if (args.operation === OPERATIONS.SHOW && args.object !== undefined && objectFound === undefined) {
    objectFound = true;
  }

  const rawStdout = stdout.trim();
  const rawStderr = stderr.trim();

  const { outputFile, outputFileBytes } = await archiveOutput(outDir, rawStdout, outFile);
  const outputLines = rawStdout ? rawStdout.split('\n').length : 0;

  return {
    tool: GIT_HISTORY_TOOL_NAME,
    status: STATUS.PASSED,
    operation: args.operation,
    repo: args.repo,
    root,
    command: { binary: 'git', args: gitArgs },
    lockfileReason: args.lockfileReason,
    objectFound,
    outputLines,
    outputFileBytes,
    outputFile,
    stderr: rawStderr || undefined
  };
}

// ---------------------------------------------------------------------------
// verify() — the harness-owned, deterministic semantic judgement.
//
// VerifyContext is PATHS-ONLY: the recorded git_history outputFile path is read
// from ctx.toolOutputs[GIT_HISTORY_TOOL_NAME]. The verdict is decided purely
// from on-disk presence/shape — no LLM, no external state:
//   - NOT_APPLICABLE when the git_history output content is ABSENT (no path
//     recorded, the path does not exist, or the archived file is empty).
//   - PASS when the archived output exists and holds non-empty git evidence.
//   - FAIL when the archived output exists but is structurally invalid (an empty
//     or whitespace-only file with a recorded non-zero byte count is incoherent;
//     a recorded REJECTED-shaped error payload is a FAIL).
// ---------------------------------------------------------------------------

export function gitHistoryVerify(ctx: VerifyContext): VerifyResult {
  const outputPath = ctx.toolOutputs[GIT_HISTORY_TOOL_NAME];

  if (!outputPath || !existsSync(outputPath)) {
    return {
      verdict: VerifyVerdict.NOT_APPLICABLE,
      reasons: [`git_history produced no output for this transition (no readable ${GIT_HISTORY_TOOL_NAME} output path).`]
    };
  }

  let stats;
  try {
    stats = statSync(outputPath);
  } catch (error: unknown) {
    return {
      verdict: VerifyVerdict.NOT_APPLICABLE,
      reasons: [`git_history output path is not readable: ${error instanceof Error ? error.message : String(error)}`]
    };
  }

  if (!stats.isFile() || stats.size === 0) {
    return {
      verdict: VerifyVerdict.NOT_APPLICABLE,
      reasons: ['git_history output is absent (empty archive) — nothing to verify.']
    };
  }

  let content: string;
  try {
    content = readFileSync(outputPath, 'utf8');
  } catch (error: unknown) {
    return {
      verdict: VerifyVerdict.FAIL,
      reasons: [`git_history output exists but could not be read: ${error instanceof Error ? error.message : String(error)}`],
      failureOutcome: 'unreadable git_history output'
    };
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    // Non-zero on-disk size but whitespace-only content: incoherent evidence.
    return {
      verdict: VerifyVerdict.FAIL,
      reasons: ['git_history output is whitespace-only despite a non-empty archive — no usable git evidence.'],
      failureOutcome: 'empty git_history evidence'
    };
  }

  // A recorded REJECTED-shaped payload is explicit evidence the tool could not run.
  if (isRejectedPayload(trimmed)) {
    return {
      verdict: VerifyVerdict.FAIL,
      reasons: ['git_history recorded a REJECTED run — the tool could not produce git evidence.'],
      failureOutcome: 'rejected git_history run'
    };
  }

  return {
    verdict: VerifyVerdict.PASS,
    reasons: [`git_history produced ${trimmed.split('\n').length} line(s) of git evidence (${stats.size} bytes).`]
  };
}

function isRejectedPayload(content: string): boolean {
  if (!content.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(content) as { tool?: unknown; status?: unknown };
    return parsed.tool === GIT_HISTORY_TOOL_NAME && parsed.status === STATUS.REJECTED;
  } catch {
    return false;
  }
}

async function run(): Promise<void> {
  const result = await runGitHistory(process.argv.slice(2));
  print(result);
  process.exitCode = result.status === STATUS.REJECTED ? 1 : 0;
}

// Only execute when this file is run directly (not when imported by tests/harness).
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename ?? '')) {
  run().catch((error: unknown) => {
    print({
      tool: GIT_HISTORY_TOOL_NAME,
      status: STATUS.REJECTED,
      error: error instanceof Error ? error.message : String(error)
    });
    process.exitCode = 1;
  });
}
