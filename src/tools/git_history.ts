#!/usr/bin/env node
/**
 * git_history — a COMMON, harness-OWNED built-in tool (pi-experiment-0yt5.21).
 *
 * git_history is NOT cerdiwen-specific. It lives in the orr-else harness `src/`
 * tree, owns its OWN deterministic git-output parsing, produces a canonical
 * ToolEvidenceHandle (pi-experiment-oi48), and ships a deterministic verify()
 * callback that the harness SELF-registers at load (see ./index.ts). This module
 * imports ONLY the contract TYPES and node builtins — never any consumer code.
 *
 * Behaviour mirrors the reference implementation that previously lived in the
 * cerdiwen checkout, but the path resolution is now harness-native: it reads the
 * harness-injected PI_* env vars (EnvVars) rather than any consumer helper.
 *
 * Determinism: argument parsing and git-output handling are pure deterministic
 * code (node:util parseArgs + explicit branching, minimal regex) — NOT LLM-based.
 * The verify() is pure given a paths-only VerifyContext: it reads the recorded
 * outputFile and judges presence/shape on disk.
 *
 * pi-experiment-oi48: git_history now emits a canonical ToolEvidenceHandle on
 * PASSED runs. Missing harness-injected output identity (no PI_TOOL_OUTPUT_DIR
 * and no PI_TOOL_OUTPUT_FILE) → REJECTED result; no tmp/cwd path is used as
 * verifier evidence. The verifier checks for a REJECTED JSON payload in the
 * output file and returns FAIL rather than PASS for such files.
 */
import { createHash, randomUUID } from 'node:crypto';
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
import {
  TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
  validateToolEvidenceHandle,
  validateToolEvidenceArtifact,
  type ToolEvidenceHandle,
} from '../core/ToolEvidenceHandle.js';
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
const HANDLE_FILE_NAME = 'git-history.json';
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
 * GitHistoryRtkSummary — the TypeScript-owned, deterministic RTK summary for
 * a git_history run. Attached to the ToolEvidenceHandle on PASSED runs.
 *
 * pi-experiment-oi48: this is the tool-owned summary shape. The harness only
 * validates structure (schemaTypeName + owningFile); it does not inspect payload.
 *
 * outputText: the raw git stdout (embedded in the handle artifact so that
 * readFileSync(semanticArtifactPath) contains real git evidence and the handle
 * JSON IS the canonical on-disk artifact).
 *
 * zog2.7: schemaHash is DERIVED from GIT_HISTORY_SCHEMA_DESCRIPTOR at module load,
 * not pasted. Editing the descriptor changes the hash automatically.
 */
export interface GitHistoryRtkSummary {
  operation: string;
  repo: string;
  root: string;
  outputLines: number;
  outputFileBytes: number;
  objectFound?: boolean;
  lockfileReason?: string;
  stderr?: string;
  /** The raw git stdout, embedded so the handle artifact IS the evidence. */
  outputText?: string;
}

/**
 * Stable, canonicalizable descriptor of the GitHistoryRtkSummary schema fields
 * and their types (zog2.7 — real drift detection).
 *
 * This object IS the schema source of truth. The schemaHash is DERIVED from
 * JSON.stringify(GIT_HISTORY_SCHEMA_DESCRIPTOR) at module load. Adding or
 * removing a field here changes the hash, and the conformance test detects it.
 *
 * Ordering is canonical (alphabetical) so the stringification is stable.
 */
export const GIT_HISTORY_SCHEMA_DESCRIPTOR = {
  lockfileReason: 'string|undefined',
  objectFound: 'boolean|undefined',
  operation: 'string',
  outputFileBytes: 'number',
  outputLines: 'number',
  outputText: 'string|undefined',
  repo: 'string',
  root: 'string',
  stderr: 'string|undefined',
} as const;

/**
 * Exhaustive keyof-driven record enumerating every field of GitHistoryRtkSummary.
 *
 * pi-experiment-64i8: this const is a compile-time cross-check between the
 * GitHistoryRtkSummary interface and GIT_HISTORY_SCHEMA_DESCRIPTOR. The type
 * annotation `Record<keyof GitHistoryRtkSummary, true>` causes a TypeScript
 * error if a field is added to the interface but not to this record, or if this
 * record contains a key that the interface doesn't have. At runtime,
 * Object.keys(GIT_HISTORY_INTERFACE_FIELDS) produces the canonical interface
 * field list that tests compare against Object.keys(GIT_HISTORY_SCHEMA_DESCRIPTOR).
 */
export const GIT_HISTORY_INTERFACE_FIELDS: Record<keyof GitHistoryRtkSummary, true> = {
  operation: true,
  repo: true,
  root: true,
  outputLines: true,
  outputFileBytes: true,
  objectFound: true,
  lockfileReason: true,
  stderr: true,
  outputText: true,
};

/**
 * Compute the schemaHash for GIT_HISTORY_SCHEMA_DESCRIPTOR.
 * Returns 'sha256:<hex>' — the canonical format required by the contract.
 *
 * Exported so conformance tests can independently recompute and compare.
 */
export function computeGitHistorySchemaHash(): string {
  const canonical = JSON.stringify(GIT_HISTORY_SCHEMA_DESCRIPTOR);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

/**
 * The derived schemaHash for the git_history summary schema.
 * Computed once at module load from GIT_HISTORY_SCHEMA_DESCRIPTOR.
 * Never pasted — always derived so it tracks the descriptor.
 */
export const GIT_HISTORY_SCHEMA_HASH: string = computeGitHistorySchemaHash();

/**
 * The git_history tool result. Extends the harness ToolResultBase for backward
 * compatibility (tool, status, outputFile, outputFileBytes, failureCategory),
 * and additionally carries a canonical ToolEvidenceHandle (pi-experiment-oi48).
 *
 * The VERIFIER EVIDENCE SHAPE is the evidenceHandle (ToolEvidenceHandle), not
 * the ToolResultBase fields. The ToolResultBase fields are retained for
 * compatibility with existing callers; outputFile points to the same file as
 * evidenceHandle.semanticArtifactPath on PASSED runs.
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
  /** Canonical ToolEvidenceHandle (pi-experiment-oi48). Present on all runs. */
  evidenceHandle?: ToolEvidenceHandle;
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
 *
 * pi-experiment-oi48: the former PI_TOOL_TMP_DIR / cwd fallback is REMOVED.
 * A missing harness-injected identity means the run cannot produce verifier
 * evidence. Returns undefined when no harness-injected path is present.
 */
function resolveOutputTarget(env: RuntimeEnvironment): { dir: string; file: string } | undefined {
  const explicitFile = env.env('PI_TOOL_OUTPUT_FILE');
  if (explicitFile) {
    return { dir: path.dirname(path.resolve(explicitFile)), file: path.resolve(explicitFile) };
  }
  const outDir = env.env('PI_TOOL_OUTPUT_DIR');
  if (outDir) {
    const dir = path.resolve(outDir);
    // The primary artifact is the canonical handle JSON (pi-experiment-oi48).
    return { dir, file: resolve(dir, HANDLE_FILE_NAME) };
  }
  // No harness-injected output path — cannot produce verifier evidence.
  return undefined;
}

/**
 * Read harness-injected execution identity from env vars.
 * Returns best-effort values; falls back to 'unknown' for missing vars.
 */
function resolveExecutionIdentity(env: RuntimeEnvironment): {
  invocationId: string;
  admittedExecutionBoundary: string;
  admittedHarnessFingerprint: string;
  toolOutputRoot: string;
} {
  const invocationId = env.env('PI_TOOL_INVOCATION_ID') || randomUUID();
  const beadId = env.env('PI_BEAD_ID') || 'unknown';
  const stateId = env.env('PI_STATE_ID') || 'unknown';
  const actionId = env.env('PI_ACTION_ID') || 'unknown';
  const admittedExecutionBoundary = `bead:${beadId}/state:${stateId}/action:${actionId}`;
  const admittedHarnessFingerprint = env.env('PI_HARNESS_FINGERPRINT') || 'unknown';
  const outDirEnv = env.env('PI_TOOL_OUTPUT_DIR');
  const toolOutputRoot = outDirEnv ? path.resolve(outDirEnv) : '';
  return { invocationId, admittedExecutionBoundary, admittedHarnessFingerprint, toolOutputRoot };
}

/**
 * Compute hex SHA-256 of a file's content (read synchronously).
 * Returns 'unknown' on any error (non-fatal for audit metadata).
 */
function sha256OfFile(filePath: string): string {
  try {
    const content = readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return 'unknown';
  }
}

/**
 * Build a canonical ToolEvidenceHandle for a PASSED git_history run.
 *
 * pi-experiment-oi48 (review fix): semanticArtifactPath is the handle JSON file
 * (outFile). rawTransportArchivePaths carries the separate raw stdout log file.
 * The git output is embedded in rtkSummary.summary.outputText so that
 * readFileSync(semanticArtifactPath) contains real git evidence.
 */
function buildPassedHandle(params: {
  outputFile: string;
  outputFileBytes: number;
  rawTransportLogFile: string;
  toolOutputRoot: string;
  invocationId: string;
  admittedExecutionBoundary: string;
  admittedHarnessFingerprint: string;
  rtkSummary: GitHistoryRtkSummary;
}): ToolEvidenceHandle {
  const {
    outputFile, toolOutputRoot,
    rawTransportLogFile,
    invocationId, admittedExecutionBoundary, admittedHarnessFingerprint, rtkSummary,
  } = params;
  return {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: GIT_HISTORY_TOOL_NAME,
    invocationId,
    runStatus: 'PASSED',
    // semanticArtifactPath is the handle JSON file; bytes/sha256 are computed
    // after writing (omitted here to avoid circular self-reference).
    semanticArtifactPath: outputFile,
    rawTransportArchivePaths: [rawTransportLogFile],
    toolOutputRoot,
    summaryMode: 'summary',
    rtkSummary: {
      schemaTypeName: 'GitHistoryRtkSummary',
      owningFile: 'src/tools/git_history.ts',
      summarySchemaVersion: '1.0.0',
      // Derived from GIT_HISTORY_SCHEMA_DESCRIPTOR via computeGitHistorySchemaHash() (zog2.7).
      // Never pasted — changing the descriptor changes this hash automatically.
      schemaHash: GIT_HISTORY_SCHEMA_HASH,
      deterministicSummaryVersion: '1.0.0',
      // Input artifact: the raw git stdout log archived by archiveOutput().
      // The log file is git output text; schema is the git stdout format for the operation.
      inputArtifactSchemaId: 'git-stdout-log',
      inputArtifactSchemaVersion: '1.0.0',
      // Maximum counts applied by this summary (zog2.7 AC metadata).
      maximumCounts: { commits: MAX_LIMIT, paths: MAX_PATHS },
      // Omission semantics: items beyond the limits are omitted; outputLines
      // in the summary payload reports the total line count of the raw output.
      omissionSemantics:
        'commits beyond maximumCounts.commits and paths beyond maximumCounts.paths are not ' +
        'included in the request; outputLines in the summary payload reports the actual line ' +
        'count of the raw git stdout archived in rawTransportArchivePaths',
      summary: rtkSummary as unknown as Record<string, unknown>,
    },
    admittedHarnessFingerprint,
    admittedExecutionBoundary,
  };
}

/**
 * Build a canonical ToolEvidenceHandle for a REJECTED git_history run.
 */
function buildRejectedHandle(params: {
  outputFile: string;
  outputFileBytes: number;
  toolOutputRoot: string;
  invocationId: string;
  admittedExecutionBoundary: string;
  admittedHarnessFingerprint: string;
  failureCategory: ToolResultBase['failureCategory'];
  noSummaryReason: string;
}): ToolEvidenceHandle {
  const {
    outputFile, outputFileBytes, toolOutputRoot,
    invocationId, admittedExecutionBoundary, admittedHarnessFingerprint,
    failureCategory, noSummaryReason,
  } = params;
  return {
    schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
    toolName: GIT_HISTORY_TOOL_NAME,
    invocationId,
    runStatus: 'REJECTED',
    ...(failureCategory ? { failureCategory } : {}),
    semanticArtifactPath: outputFile,
    semanticArtifactBytes: outputFileBytes,
    rawTransportArchivePaths: [outputFile],
    toolOutputRoot,
    summaryMode: 'none',
    noSummaryReason,
    admittedHarnessFingerprint,
    admittedExecutionBoundary,
  };
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
 * Write a canonical ToolEvidenceHandle as a JSON artifact to disk.
 * Returns the resolved file path and byte count of the written file.
 *
 * pi-experiment-oi48 (review fix): the handle JSON IS the primary artifact;
 * gitHistoryVerify reads and validates this file via validateToolEvidenceHandle.
 */
async function writeHandleArtifact(
  outDir: string,
  filePath: string,
  handle: ToolEvidenceHandle
): Promise<{ outputFile: string; outputFileBytes: number }> {
  await mkdir(outDir, { recursive: true });
  const outputFile = filePath.includes(path.sep) ? resolve(filePath) : resolve(outDir, filePath);
  const content = JSON.stringify(handle, null, 2);
  await writeFile(outputFile, content, 'utf8');
  const outputFileBytes = await stat(outputFile)
    .then((s) => s.size)
    .catch(() => Buffer.byteLength(content, 'utf8'));
  return { outputFile, outputFileBytes };
}

/**
 * Run git_history once and return the canonical GitHistoryResult.
 * Pure deterministic body: argv -> git argv -> exec -> archive -> result.
 * Never throws for expected git conditions (empty history, missing show object).
 *
 * pi-experiment-oi48: missing harness-injected output identity (no
 * PI_TOOL_OUTPUT_DIR and no PI_TOOL_OUTPUT_FILE) → REJECTED result.
 * PASSED runs carry a canonical ToolEvidenceHandle as evidenceHandle.
 */
export async function runGitHistory(argv: string[], env: RuntimeEnvironment = nodeRuntimeEnvironment): Promise<GitHistoryResult> {
  const args = parseArgs(argv);
  const outputTarget = resolveOutputTarget(env);
  const identity = resolveExecutionIdentity(env);

  // pi-experiment-oi48: no harness-injected output path → REJECTED (no tmp/cwd fallback).
  // No output file is written — there is no safe, harness-owned location for the artifact.
  // The empty outputFile means the verifier returns NOT_APPLICABLE (cannot satisfy the gate).
  if (!outputTarget) {
    const message = 'git_history requires a harness-injected output path (PI_TOOL_OUTPUT_FILE or PI_TOOL_OUTPUT_DIR) to produce verifier evidence. No tmp/cwd fallback is allowed.';
    const evidenceHandle: ToolEvidenceHandle = {
      schemaVersion: TOOL_EVIDENCE_HANDLE_SCHEMA_VERSION,
      toolName: GIT_HISTORY_TOOL_NAME,
      invocationId: identity.invocationId,
      runStatus: 'REJECTED',
      failureCategory: 'INFRA',
      toolOutputRoot: process.cwd(), // best-effort; no harness root available
      summaryMode: 'none',
      noSummaryReason: 'REJECTED: missing harness-injected output identity',
      admittedHarnessFingerprint: identity.admittedHarnessFingerprint,
      admittedExecutionBoundary: identity.admittedExecutionBoundary,
    };
    return {
      tool: GIT_HISTORY_TOOL_NAME,
      status: STATUS.REJECTED,
      failureCategory: 'INFRA',
      outputFile: '',
      outputFileBytes: 0,
      error: message,
      evidenceHandle,
    };
  }

  const { dir: outDir, file: outFile } = outputTarget;

  if (args.help) {
    const message = 'Help output is not git history evidence and cannot satisfy required git_history gates.';
    const toolOutputRoot = identity.toolOutputRoot || outDir;
    // Build and write the REJECTED handle JSON as the canonical artifact.
    const evidenceHandle = buildRejectedHandle({
      outputFile: outFile,
      outputFileBytes: 0,
      toolOutputRoot,
      invocationId: identity.invocationId,
      admittedExecutionBoundary: identity.admittedExecutionBoundary,
      admittedHarnessFingerprint: identity.admittedHarnessFingerprint,
      failureCategory: 'INPUT',
      noSummaryReason: 'REJECTED: help request',
    });
    const { outputFile, outputFileBytes } = await writeHandleArtifact(outDir, outFile, evidenceHandle);
    return {
      tool: GIT_HISTORY_TOOL_NAME,
      status: STATUS.REJECTED,
      failureCategory: 'INPUT',
      outputFile,
      outputFileBytes,
      error: message,
      evidenceHandle,
    };
  }

  const root = repoRoot(args.repo, env);
  if (!existsSync(resolve(root, '.git'))) {
    const message = `selected repository is not a git repository: ${root}`;
    const toolOutputRoot = identity.toolOutputRoot || outDir;
    // Build and write the REJECTED handle JSON as the canonical artifact.
    const evidenceHandle = buildRejectedHandle({
      outputFile: outFile,
      outputFileBytes: 0,
      toolOutputRoot,
      invocationId: identity.invocationId,
      admittedExecutionBoundary: identity.admittedExecutionBoundary,
      admittedHarnessFingerprint: identity.admittedHarnessFingerprint,
      failureCategory: 'INFRA',
      noSummaryReason: `REJECTED: not a git repository: ${root}`,
    });
    const { outputFile, outputFileBytes } = await writeHandleArtifact(outDir, outFile, evidenceHandle);
    return {
      tool: GIT_HISTORY_TOOL_NAME,
      status: STATUS.REJECTED,
      failureCategory: 'INFRA',
      outputFile,
      outputFileBytes,
      error: message,
      evidenceHandle,
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
  const outputLines = rawStdout ? rawStdout.split('\n').length : 0;
  const toolOutputRoot = identity.toolOutputRoot || outDir;

  // Archive the raw git stdout to a separate transport file (for durability).
  const rawLogFile = resolve(outDir, OUTPUT_FILE_NAME);
  await archiveOutput(outDir, rawStdout, rawLogFile);
  const rawLogBytes = rawStdout ? Buffer.byteLength(rawStdout, 'utf8') : 0;

  const rtkSummary: GitHistoryRtkSummary = {
    operation: args.operation,
    repo: args.repo,
    root,
    outputLines,
    outputFileBytes: rawLogBytes,
    ...(objectFound !== undefined ? { objectFound } : {}),
    ...(args.lockfileReason ? { lockfileReason: args.lockfileReason } : {}),
    ...(rawStderr ? { stderr: rawStderr } : {}),
    // Embed the git output so the handle artifact itself contains real git evidence.
    ...(rawStdout ? { outputText: rawStdout } : {}),
  };

  // Build the handle with outFile as the semanticArtifactPath; rawTransportArchivePaths
  // carries the separate raw stdout log.
  const evidenceHandle = buildPassedHandle({
    outputFile: outFile,
    outputFileBytes: 0, // placeholder; updated after handle JSON is written
    rawTransportLogFile: rawLogFile,
    toolOutputRoot,
    invocationId: identity.invocationId,
    admittedExecutionBoundary: identity.admittedExecutionBoundary,
    admittedHarnessFingerprint: identity.admittedHarnessFingerprint,
    rtkSummary,
  });

  // Write the canonical handle JSON as the primary artifact.
  const { outputFile, outputFileBytes } = await writeHandleArtifact(outDir, outFile, evidenceHandle);

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
    stderr: rawStderr || undefined,
    evidenceHandle,
  };
}

// ---------------------------------------------------------------------------
// verify() — the harness-owned, deterministic semantic judgement.
//
// VerifyContext is PATHS-ONLY: the recorded git_history artifact path is read
// from ctx.toolOutputs[GIT_HISTORY_TOOL_NAME]. The artifact MUST be a canonical
// ToolEvidenceHandle JSON file (pi-experiment-oi48 review fix). The verdict is
// decided purely from the handle's runStatus and semanticArtifactPath readability:
//
//   - NOT_APPLICABLE when no path is recorded, the path does not exist, or the
//     file is empty / unreadable.
//   - FAIL when the file exists but is NOT a valid ToolEvidenceHandle (not JSON,
//     fails validateToolEvidenceHandle), OR the handle's runStatus is not PASSED,
//     OR the semanticArtifactPath is not readable (validateToolEvidenceArtifact).
//   - PASS when the handle validates, runStatus === 'PASSED', and the semantic
//     artifact path is readable.
//
// A ToolResultBase-shaped file, a raw git-log file, a tmp/cwd artifact, or a
// REJECTED-run handle all produce FAIL — only a canonical PASSED handle passes.
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
      reasons: ['git_history artifact is absent (empty file) — nothing to verify.']
    };
  }

  // Read the artifact and parse it as a canonical ToolEvidenceHandle JSON.
  let raw: string;
  try {
    raw = readFileSync(outputPath, 'utf8');
  } catch (error: unknown) {
    return {
      verdict: VerifyVerdict.FAIL,
      reasons: [`git_history artifact exists but could not be read: ${error instanceof Error ? error.message : String(error)}`],
      failureOutcome: 'unreadable git_history artifact'
    };
  }

  // Attempt JSON parse; non-JSON files (raw git text, whitespace) are not valid handles.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      verdict: VerifyVerdict.FAIL,
      reasons: [`git_history artifact at "${outputPath}" is not valid JSON — not a canonical ToolEvidenceHandle.`],
      failureOutcome: 'non-canonical git_history artifact'
    };
  }

  // Validate the parsed object as a canonical ToolEvidenceHandle.
  const validation = validateToolEvidenceHandle(parsed, { expectedToolName: GIT_HISTORY_TOOL_NAME });
  if (!validation.valid) {
    return {
      verdict: VerifyVerdict.FAIL,
      reasons: [
        `git_history artifact at "${outputPath}" failed ToolEvidenceHandle validation: ${validation.errors.join('; ')}`
      ],
      failureOutcome: 'non-canonical git_history artifact'
    };
  }

  const handle = validation.handle;

  // Key verdict off runStatus: only PASSED runs can satisfy the gate.
  if (handle.runStatus !== 'PASSED') {
    return {
      verdict: VerifyVerdict.FAIL,
      reasons: [`git_history handle runStatus is "${handle.runStatus}" — tool did not complete successfully.`],
      failureOutcome: 'rejected git_history run'
    };
  }

  // Validate that the semanticArtifactPath (the handle JSON file itself) is readable.
  const artifactCheck = validateToolEvidenceArtifact(handle);
  if (!artifactCheck.readable) {
    return {
      verdict: VerifyVerdict.FAIL,
      reasons: [artifactCheck.error],
      failureOutcome: 'unreadable git_history semantic artifact'
    };
  }

  return {
    verdict: VerifyVerdict.PASS,
    reasons: [
      `git_history canonical handle validated (runStatus=PASSED, invocationId=${handle.invocationId}, ` +
      `admittedExecutionBoundary=${handle.admittedExecutionBoundary}).`
    ]
  };
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
