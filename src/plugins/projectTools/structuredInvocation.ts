/**
 * Structured invocation registry for projectTools.
 *
 * When a known tool (eslint, ruff, tsc, pytest, semgrep, golangci-lint, mypy)
 * is being spawned, this module intercepts the args to inject the JSON/structured
 * output flag and provides a typed parser that turns that structured output into a
 * compact `structuredResult` consistent with the resultEnvelope contract.
 *
 * Package-internal — do not import from outside src/plugins/.
 */

// ---- Local caps (mirror existing diagnostic summary caps) ----

/** Maximum number of issue groups surfaced in a structuredResult. */
const MAX_GROUPS = 6;

/** Maximum number of representative locations per group. */
const MAX_LOCATIONS_PER_GROUP = 3;

/** Maximum character length for a message snippet before truncation. */
const MAX_MESSAGE_CHARS = 240;

/** Maximum number of affected paths surfaced in affectedPaths. */
const MAX_AFFECTED_PATHS = 10;

// ---- Shared types ----

export interface StructuredInvocationResult {
  status: 'ok' | 'parse_error';
  counts?: Record<string, number>;
  affectedPaths?: string[];
  representativeSamples?: unknown[];
  omissions?: string;
  nextAction?: string;
}

export interface StructuredInvocationHandler {
  /** The augmented args to pass to the process (instead of the original args). */
  augmentedArgs: string[];
  /**
   * Parse structured stdout/stderr/exitCode into a compact structuredResult.
   * Returns null on malformed input — caller falls back to text summarizers.
   * Must NEVER throw.
   */
  parse(stdout: string, stderr: string, exitCode: number | undefined): StructuredInvocationResult | null;
}

// ---- Helpers ----

function truncateMessage(value: string): string {
  if (value.length <= MAX_MESSAGE_CHARS) return value;
  return `${value.slice(0, MAX_MESSAGE_CHARS)}...`;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** Returns true when an arg token looks like an output-format flag for the given tool. */
function hasOutputFormatFlag(args: string[], patterns: RegExp[]): boolean {
  return args.some(arg => patterns.some(pattern => pattern.test(arg)));
}

// ---- ESLint ----
//
// ESLint JSON format: array of file-level objects, each with `messages` array.
// { filePath, messages: [{ ruleId, severity, message, line, column }] }

const ESLINT_OUTPUT_FORMAT_PATTERNS = [
  /^--format\b/,
  /^-f\b/,
  /^--format=/
];

interface EslintMessage {
  ruleId?: string | null;
  severity?: number;
  message?: string;
  line?: number;
  column?: number;
}

interface EslintFileResult {
  filePath?: string;
  messages?: EslintMessage[];
  errorCount?: number;
  warningCount?: number;
}

function parseEslintOutput(stdout: string): StructuredInvocationResult | null {
  const parsed = safeParseJson(stdout.trim());
  if (!Array.isArray(parsed)) return null;

  const files = parsed as EslintFileResult[];
  let totalErrors = 0;
  let totalWarnings = 0;

  interface Group {
    rule: string;
    severity: string;
    count: number;
    locations: string[];
  }
  const groupMap = new Map<string, Group>();
  const affectedPaths: string[] = [];

  for (const file of files) {
    if (!isRecord(file)) continue;
    const filePath = typeof file.filePath === 'string' ? file.filePath : undefined;
    const messages = Array.isArray(file.messages) ? file.messages as EslintMessage[] : [];

    if (typeof file.errorCount === 'number') totalErrors += file.errorCount;
    if (typeof file.warningCount === 'number') totalWarnings += file.warningCount;

    if (filePath && messages.length > 0 && affectedPaths.length < MAX_AFFECTED_PATHS) {
      affectedPaths.push(filePath);
    }

    for (const msg of messages) {
      if (!isRecord(msg)) continue;
      const rule = typeof msg.ruleId === 'string' ? msg.ruleId : 'unknown';
      const severity = msg.severity === 2 ? 'error' : msg.severity === 1 ? 'warning' : 'info';
      const key = `${rule}\0${severity}`;
      const location = filePath
        ? (msg.line !== undefined ? `${filePath}:${msg.line}` : filePath)
        : '<unknown>';

      const existing = groupMap.get(key);
      if (existing) {
        existing.count += 1;
        if (existing.locations.length < MAX_LOCATIONS_PER_GROUP && !existing.locations.includes(location)) {
          existing.locations.push(location);
        }
      } else if (groupMap.size < MAX_GROUPS) {
        groupMap.set(key, { rule, severity, count: 1, locations: [location] });
      }
    }
  }

  const groups = [...groupMap.values()];
  const totalViolations = groups.reduce((sum, group) => sum + group.count, 0);

  // If JSON was empty/no issues parsed at all but also no errors/warnings, still return ok
  const counts: Record<string, number> = {
    errors: totalErrors,
    warnings: totalWarnings
  };
  if (totalViolations > 0) counts.violations = totalViolations;

  const result: StructuredInvocationResult = {
    status: 'ok',
    counts
  };
  if (affectedPaths.length > 0) result.affectedPaths = affectedPaths;
  if (groups.length > 0) {
    result.representativeSamples = groups.map(group => ({
      type: 'lint_violation',
      rule: group.rule,
      severity: group.severity,
      count: group.count,
      locations: group.locations
    }));
  }
  return result;
}

// ---- Ruff ----
//
// ruff check --output-format json: array of { filename, message, code, location: {row, column}, severity }

const RUFF_OUTPUT_FORMAT_PATTERNS = [
  /^--output-format\b/,
  /^--output-format=/,
  /^--format\b/,
  /^--format=/
];

interface RuffViolation {
  filename?: string;
  code?: string;
  message?: string;
  severity?: string;
  location?: { row?: number; column?: number };
}

function parseRuffOutput(stdout: string): StructuredInvocationResult | null {
  const parsed = safeParseJson(stdout.trim());
  if (!Array.isArray(parsed)) return null;

  const violations = parsed as RuffViolation[];

  interface Group {
    code: string;
    severity: string;
    count: number;
    locations: string[];
    sample?: string;
  }
  const groupMap = new Map<string, Group>();
  const affectedPaths: string[] = [];
  let errorCount = 0;
  let warningCount = 0;

  for (const violation of violations) {
    if (!isRecord(violation)) continue;
    const filename = typeof violation.filename === 'string' ? violation.filename : undefined;
    const code = typeof violation.code === 'string' ? violation.code : 'unknown';
    const severity = typeof violation.severity === 'string' ? violation.severity.toLowerCase() : 'error';
    const row = isRecord(violation.location) && typeof violation.location.row === 'number'
      ? violation.location.row : undefined;
    const location = filename ? (row !== undefined ? `${filename}:${row}` : filename) : '<unknown>';

    if (severity === 'error') errorCount += 1;
    else warningCount += 1;

    if (filename && affectedPaths.length < MAX_AFFECTED_PATHS && !affectedPaths.includes(filename)) {
      affectedPaths.push(filename);
    }

    const key = `${code}\0${severity}`;
    const existing = groupMap.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.locations.length < MAX_LOCATIONS_PER_GROUP && !existing.locations.includes(location)) {
        existing.locations.push(location);
      }
    } else if (groupMap.size < MAX_GROUPS) {
      const msg = typeof violation.message === 'string' ? truncateMessage(violation.message) : undefined;
      groupMap.set(key, { code, severity, count: 1, locations: [location], sample: msg });
    }
  }

  const groups = [...groupMap.values()];
  const counts: Record<string, number> = {
    errors: errorCount,
    warnings: warningCount,
    violations: violations.length
  };

  const result: StructuredInvocationResult = {
    status: 'ok',
    counts
  };
  if (affectedPaths.length > 0) result.affectedPaths = affectedPaths;
  if (groups.length > 0) {
    result.representativeSamples = groups.map(group => ({
      type: 'lint_violation',
      code: group.code,
      severity: group.severity,
      count: group.count,
      locations: group.locations,
      ...(group.sample ? { sample: group.sample } : {})
    }));
  }
  return result;
}

// ---- TypeScript (tsc) ----
//
// tsc --pretty false outputs lines like: file(line,col): error TS2345: message
// No native JSON mode; we parse the structured diagnostic line format.
// When color leaks in (e.g. from tsc called without --pretty false), ANSI escape
// codes must be stripped before the regex can match.

/** Matches ANSI CSI escape sequences (e.g. \x1B[31m). */
const ANSI_ESCAPE_PATTERN = /\x1B\[[0-9;]*[A-Za-z]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '');
}

const TSC_OUTPUT_FORMAT_PATTERNS = [
  /^--pretty\b/,
  /^--pretty=/
];

interface TscDiagnostic {
  file: string;
  line: number;
  code: string;
  severity: string;
  message: string;
}

function parseTscLine(line: string): TscDiagnostic | undefined {
  // file(line,col): error TS1234: message
  const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+(TS\d+):\s+(.+)$/);
  if (!match) return undefined;
  return {
    file: match[1].trim(),
    line: Number.parseInt(match[2], 10),
    code: match[5],
    severity: match[4],
    message: truncateMessage(match[6].trim())
  };
}

function parseTscOutput(stdout: string, stderr: string): StructuredInvocationResult | null {
  const rawText = stdout || stderr;
  if (!rawText.trim()) return null;
  // Strip ANSI escape sequences so the regex matches even when color leaks in.
  const text = stripAnsi(rawText);

  interface Group {
    code: string;
    severity: string;
    count: number;
    locations: string[];
  }
  const groupMap = new Map<string, Group>();
  const affectedPaths: string[] = [];
  let errorCount = 0;
  let warningCount = 0;
  let parsedAny = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const diag = parseTscLine(line);
    if (!diag) continue;
    parsedAny = true;

    if (diag.severity === 'error') errorCount += 1;
    else warningCount += 1;

    if (affectedPaths.length < MAX_AFFECTED_PATHS && !affectedPaths.includes(diag.file)) {
      affectedPaths.push(diag.file);
    }

    const key = `${diag.code}\0${diag.severity}`;
    const location = `${diag.file}:${diag.line}`;
    const existing = groupMap.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.locations.length < MAX_LOCATIONS_PER_GROUP && !existing.locations.includes(location)) {
        existing.locations.push(location);
      }
    } else if (groupMap.size < MAX_GROUPS) {
      groupMap.set(key, { code: diag.code, severity: diag.severity, count: 1, locations: [location] });
    }
  }

  if (!parsedAny) return null;

  const groups = [...groupMap.values()];
  const counts: Record<string, number> = { errors: errorCount, warnings: warningCount };

  const result: StructuredInvocationResult = {
    status: 'ok',
    counts
  };
  if (affectedPaths.length > 0) result.affectedPaths = affectedPaths;
  if (groups.length > 0) {
    result.representativeSamples = groups.map(group => ({
      type: 'ts_diagnostic',
      code: group.code,
      severity: group.severity,
      count: group.count,
      locations: group.locations
    }));
  }
  return result;
}

// ---- Pytest ----
//
// pytest -q --tb=no outputs minimal text; for JSON use pytest-json-report (plugin needed).
// We inject -q --tb=no for a compact, broadly-compatible parseable summary line.
// --no-header is intentionally omitted: it is unknown to pytest <6.0 and causes exit 4.

const PYTEST_OUTPUT_FORMAT_PATTERNS = [
  /^--json-report\b/,
  /^-v\b/,
  /^--verbose\b/,
  /^-q\b/,
  /^--quiet\b/
];

function parsePytestOutput(stdout: string, stderr: string, exitCode: number | undefined): StructuredInvocationResult | null {
  const text = stdout || stderr;
  if (!text.trim()) return null;

  // Look for summary line: "3 failed, 2 passed in 1.23s" or "5 passed in 0.5s" etc.
  let passed = 0;
  let failed = 0;
  let errors = 0;
  let skipped = 0;
  let foundSummary = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // short test summary info line: "FAILED tests/test_foo.py::test_bar - AssertionError"
    // summary line: "1 failed, 3 passed, 1 skipped in 0.42s"
    const summaryMatch = line.match(/^(\d+) failed|(\d+) passed|(\d+) error|(\d+) skipped/i);
    if (summaryMatch) {
      // parse all counts from this line
      const failedMatch = line.match(/(\d+) failed/i);
      const passedMatch = line.match(/(\d+) passed/i);
      const errorMatch = line.match(/(\d+) error/i);
      const skippedMatch = line.match(/(\d+) skipped/i);
      if (failedMatch) failed = Number.parseInt(failedMatch[1], 10);
      if (passedMatch) passed = Number.parseInt(passedMatch[1], 10);
      if (errorMatch) errors = Number.parseInt(errorMatch[1], 10);
      if (skippedMatch) skipped = Number.parseInt(skippedMatch[1], 10);
      foundSummary = true;
    }
  }

  if (!foundSummary) {
    // Nothing parseable; return null to fall back to text summarizers
    if (exitCode === 0) {
      return { status: 'ok', counts: { passed: 0, failed: 0 } };
    }
    return null;
  }

  const counts: Record<string, number> = { passed, failed, errors, skipped };
  const total = passed + failed + errors + skipped;
  if (total > 0) counts.total = total;

  return {
    status: 'ok',
    counts,
    nextAction: failed > 0 || errors > 0 ? 'fix_or_route_failure' : 'use_result'
  };
}

// ---- Semgrep ----
//
// semgrep --json: { results: [...], errors: [...], paths: { scanned: [...] } }
// each result: { check_id, path, start: {line}, extra: {message, severity} }

const SEMGREP_OUTPUT_FORMAT_PATTERNS = [
  /^--json\b/,
  /^--sarif\b/,
  /^--text\b/,
  /^--emacs\b/,
  /^--vim\b/,
  /^--output\b/,
  /^--output=/
];

interface SemgrepResult {
  check_id?: string;
  path?: string;
  start?: { line?: number };
  extra?: {
    message?: string;
    severity?: string;
  };
}

function parseSemgrepOutput(stdout: string): StructuredInvocationResult | null {
  const parsed = safeParseJson(stdout.trim());
  if (!isRecord(parsed)) return null;

  const results: SemgrepResult[] = Array.isArray(parsed.results)
    ? parsed.results as SemgrepResult[]
    : [];
  const errs = Array.isArray(parsed.errors) ? parsed.errors : [];
  const paths = isRecord(parsed.paths) ? parsed.paths : {};
  const scanned = isStringArray(paths.scanned) ? paths.scanned : [];

  interface Group {
    checkId: string;
    severity: string;
    count: number;
    locations: string[];
  }
  const groupMap = new Map<string, Group>();
  const affectedPaths: string[] = [];

  for (const finding of results) {
    if (!isRecord(finding)) continue;
    const checkId = typeof finding.check_id === 'string' ? finding.check_id : 'unknown';
    const filePath = typeof finding.path === 'string' ? finding.path : undefined;
    const line = isRecord(finding.start) && typeof finding.start.line === 'number'
      ? finding.start.line : undefined;
    const severity = isRecord(finding.extra) && typeof finding.extra.severity === 'string'
      ? finding.extra.severity.toLowerCase()
      : 'error';
    const location = filePath ? (line !== undefined ? `${filePath}:${line}` : filePath) : '<unknown>';

    if (filePath && affectedPaths.length < MAX_AFFECTED_PATHS && !affectedPaths.includes(filePath)) {
      affectedPaths.push(filePath);
    }

    const key = `${checkId}\0${severity}`;
    const existing = groupMap.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.locations.length < MAX_LOCATIONS_PER_GROUP && !existing.locations.includes(location)) {
        existing.locations.push(location);
      }
    } else if (groupMap.size < MAX_GROUPS) {
      groupMap.set(key, { checkId, severity, count: 1, locations: [location] });
    }
  }

  const groups = [...groupMap.values()];
  // 0yt5.16/0yt5.17: emit the scanned-file count under scannedFiles only. The
  // redundant scanned-target-count echo (which existed solely to feed the removed
  // harness zero-target-scan recognition) is gone — the harness no longer
  // recognizes scan-target evidence on a tool result.
  const counts: Record<string, number> = {
    findings: results.length,
    errors: errs.length,
    scannedFiles: scanned.length
  };

  const result: StructuredInvocationResult = {
    status: 'ok',
    counts
  };
  if (affectedPaths.length > 0) result.affectedPaths = affectedPaths;
  if (groups.length > 0) {
    result.representativeSamples = groups.map(group => ({
      type: 'semgrep_finding',
      checkId: group.checkId,
      severity: group.severity,
      count: group.count,
      locations: group.locations
    }));
  }
  return result;
}

// ---- golangci-lint ----
//
// golangci-lint run --out-format json: { Issues: [...], Report: {...} }
// each issue: { Text, Pos: {Filename, Line}, FromLinter }

const GOLANGCI_OUTPUT_FORMAT_PATTERNS = [
  /^--out-format\b/,
  /^--out-format=/,
  /^--format\b/,
  /^--format=/
];

interface GolangciIssue {
  Text?: string;
  Pos?: { Filename?: string; Line?: number };
  FromLinter?: string;
  Severity?: string;
}

function parseGolangciLintOutput(stdout: string): StructuredInvocationResult | null {
  const parsed = safeParseJson(stdout.trim());
  if (!isRecord(parsed)) return null;

  const issues: GolangciIssue[] = Array.isArray(parsed.Issues)
    ? parsed.Issues as GolangciIssue[]
    : [];

  interface Group {
    linter: string;
    count: number;
    locations: string[];
  }
  const groupMap = new Map<string, Group>();
  const affectedPaths: string[] = [];

  for (const issue of issues) {
    if (!isRecord(issue)) continue;
    const linter = typeof issue.FromLinter === 'string' ? issue.FromLinter : 'unknown';
    const pos = isRecord(issue.Pos) ? issue.Pos : {};
    const filename = typeof pos.Filename === 'string' ? pos.Filename : undefined;
    const line = typeof pos.Line === 'number' ? pos.Line : undefined;
    const location = filename ? (line !== undefined ? `${filename}:${line}` : filename) : '<unknown>';

    if (filename && affectedPaths.length < MAX_AFFECTED_PATHS && !affectedPaths.includes(filename)) {
      affectedPaths.push(filename);
    }

    const key = linter;
    const existing = groupMap.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.locations.length < MAX_LOCATIONS_PER_GROUP && !existing.locations.includes(location)) {
        existing.locations.push(location);
      }
    } else if (groupMap.size < MAX_GROUPS) {
      groupMap.set(key, { linter, count: 1, locations: [location] });
    }
  }

  const groups = [...groupMap.values()];
  const counts: Record<string, number> = { issues: issues.length };

  const result: StructuredInvocationResult = {
    status: 'ok',
    counts
  };
  if (affectedPaths.length > 0) result.affectedPaths = affectedPaths;
  if (groups.length > 0) {
    result.representativeSamples = groups.map(group => ({
      type: 'lint_violation',
      linter: group.linter,
      count: group.count,
      locations: group.locations
    }));
  }
  return result;
}

// ---- mypy ----
//
// mypy --output=json outputs one JSON object per line:
// { file, line, column, message, code, severity }

const MYPY_OUTPUT_FORMAT_PATTERNS = [
  /^--output\b/,
  /^--output=/
];

interface MypyDiagnostic {
  file?: string;
  line?: number;
  message?: string;
  code?: string;
  severity?: string;
}

function parseMypyOutput(stdout: string, stderr: string): StructuredInvocationResult | null {
  const text = stdout || stderr;
  if (!text.trim()) return null;

  interface Group {
    code: string;
    severity: string;
    count: number;
    locations: string[];
  }
  const groupMap = new Map<string, Group>();
  const affectedPaths: string[] = [];
  let errorCount = 0;
  let noteCount = 0;
  let parsedAny = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = safeParseJson(line);
    if (!isRecord(parsed)) continue;

    // mypy --output=json: each line is a diagnostic
    const diag = parsed as MypyDiagnostic;
    const file = typeof diag.file === 'string' ? diag.file : undefined;
    const code = typeof diag.code === 'string' ? diag.code : 'unknown';
    const severity = typeof diag.severity === 'string' ? diag.severity.toLowerCase() : 'error';
    const diagLine = typeof diag.line === 'number' ? diag.line : undefined;
    const location = file ? (diagLine !== undefined ? `${file}:${diagLine}` : file) : '<unknown>';

    parsedAny = true;
    if (severity === 'error') errorCount += 1;
    else noteCount += 1;

    if (file && affectedPaths.length < MAX_AFFECTED_PATHS && !affectedPaths.includes(file)) {
      affectedPaths.push(file);
    }

    const key = `${code}\0${severity}`;
    const existing = groupMap.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.locations.length < MAX_LOCATIONS_PER_GROUP && !existing.locations.includes(location)) {
        existing.locations.push(location);
      }
    } else if (groupMap.size < MAX_GROUPS) {
      groupMap.set(key, { code, severity, count: 1, locations: [location] });
    }
  }

  if (!parsedAny) return null;

  const groups = [...groupMap.values()];
  const counts: Record<string, number> = { errors: errorCount, notes: noteCount };

  const result: StructuredInvocationResult = {
    status: 'ok',
    counts
  };
  if (affectedPaths.length > 0) result.affectedPaths = affectedPaths;
  if (groups.length > 0) {
    result.representativeSamples = groups.map(group => ({
      type: 'type_error',
      code: group.code,
      severity: group.severity,
      count: group.count,
      locations: group.locations
    }));
  }
  return result;
}

// ---- Registry ----

interface ToolEntry {
  /** Flag(s) to inject for machine-readable output. */
  flags: string[];
  /** Patterns of args that indicate an output-format flag is already present. */
  conflictPatterns: RegExp[];
  /** Parse structured output into a compact structuredResult. */
  parse(stdout: string, stderr: string, exitCode: number | undefined): StructuredInvocationResult | null;
}

const REGISTRY: Record<string, ToolEntry> = {
  eslint: {
    flags: ['--format', 'json'],
    conflictPatterns: ESLINT_OUTPUT_FORMAT_PATTERNS,
    parse(stdout, _stderr, _exitCode) {
      try {
        return parseEslintOutput(stdout);
      } catch {
        return null;
      }
    }
  },
  ruff: {
    flags: ['--output-format', 'json'],
    conflictPatterns: RUFF_OUTPUT_FORMAT_PATTERNS,
    parse(stdout, _stderr, _exitCode) {
      try {
        return parseRuffOutput(stdout);
      } catch {
        return null;
      }
    }
  },
  tsc: {
    flags: ['--pretty', 'false'],
    conflictPatterns: TSC_OUTPUT_FORMAT_PATTERNS,
    parse(stdout, stderr, _exitCode) {
      try {
        return parseTscOutput(stdout, stderr);
      } catch {
        return null;
      }
    }
  },
  pytest: {
    flags: ['-q', '--tb=no'],
    conflictPatterns: PYTEST_OUTPUT_FORMAT_PATTERNS,
    parse(stdout, stderr, exitCode) {
      try {
        return parsePytestOutput(stdout, stderr, exitCode);
      } catch {
        return null;
      }
    }
  },
  semgrep: {
    flags: ['--json'],
    conflictPatterns: SEMGREP_OUTPUT_FORMAT_PATTERNS,
    parse(stdout, _stderr, _exitCode) {
      try {
        return parseSemgrepOutput(stdout);
      } catch {
        return null;
      }
    }
  },
  'golangci-lint': {
    flags: ['--out-format', 'json'],
    conflictPatterns: GOLANGCI_OUTPUT_FORMAT_PATTERNS,
    parse(stdout, _stderr, _exitCode) {
      try {
        return parseGolangciLintOutput(stdout);
      } catch {
        return null;
      }
    }
  },
  mypy: {
    flags: ['--output', 'json'],
    conflictPatterns: MYPY_OUTPUT_FORMAT_PATTERNS,
    parse(stdout, stderr, _exitCode) {
      try {
        return parseMypyOutput(stdout, stderr);
      } catch {
        return null;
      }
    }
  }
};

// ---- Public API ----

/**
 * Resolve a structured invocation handler for a known tool.
 *
 * @param commandName - The base name of the executable (e.g. 'eslint', 'ruff').
 * @param args - The argument list that will be passed to the process.
 * @returns A handler with `augmentedArgs` and `parse`, or null if:
 *   - the tool is unknown (not in the registry), or
 *   - an output-format flag is already present in `args` (don't double-inject).
 */
export function resolveStructuredInvocation(
  commandName: string,
  args: string[]
): StructuredInvocationHandler | null {
  // Normalize: strip path prefix (e.g. '/usr/local/bin/eslint' → 'eslint')
  const baseName = commandName.split('/').pop() ?? commandName;
  // Also strip extensions on Windows (e.g. 'eslint.cmd' → 'eslint')
  const toolName = baseName.replace(/\.(cmd|exe|bat)$/i, '');

  const entry = REGISTRY[toolName];
  if (!entry) return null;

  // Don't inject if an output-format flag is already present
  if (hasOutputFormatFlag(args, entry.conflictPatterns)) return null;

  // Append the output-format flags AFTER the user-supplied args so that subcommand
  // tools (ruff check, golangci-lint run) receive the subcommand first.
  // e.g. ruff check . --output-format json  ✓
  //      golangci-lint run --out-format json  ✓
  // All current registry entries are safe with appended flags.
  const augmentedArgs = [...args, ...entry.flags];

  return {
    augmentedArgs,
    parse(stdout: string, stderr: string, exitCode: number | undefined): StructuredInvocationResult | null {
      try {
        const result = entry.parse(stdout, stderr, exitCode);
        return result;
      } catch {
        // Defensive: never throw, always fall back
        return null;
      }
    }
  };
}
