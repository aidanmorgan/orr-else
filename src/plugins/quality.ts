import path from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { Type } from "@earendil-works/pi-ai";
import { execa } from 'execa';
import { Logger } from '../core/Logger.js';
import { Component, EnvVars, OperationalArtifactPath, OtelAttr, PluginToolName, SpanName, ToolResultStatus } from '../constants/index.js';
import type { Observability } from '../core/Observability.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from '../core/RuntimeEnvironment.js';
import type { RuntimePlugin, RuntimeTool } from '../core/RuntimeServices.js';

// ── Deterministic reducers ───────────────────────────────────────────────────
//
// These reducers transform raw command output into compact structured results.
// No LLM summarization. No byte-capped previews. The model sees only the
// reduced schema; complete raw output is archived to a file.

/** Maximum number of representative failures to include in model-facing result. */
const FIRST_N_FAILURES = 10;

/** Patterns used to classify output lines. */
const ERROR_PATTERNS = [/\berror\b/i, /\bERROR\b/, /✗/, /FAIL/, /✘/];
const WARNING_PATTERNS = [/\bwarn(?:ing)?\b/i, /\bWARN\b/];
const TEST_FAIL_PATTERNS = [
  /^\s*✗\s+/,
  /FAIL\s+/,
  /^\s*×\s+/,
  /AssertionError/,
  /^\s*●\s+/,         // jest/vitest
  /\bFAILED\b/,
];
const TEST_PASS_PATTERNS = [
  /^\s*✓\s+/,
  /^\s*√\s+/,
  /PASS\s+/,
  /\bPASSED\b/,
  /Tests\s+\d+\s+passed/,
];

function countMatches(lines: string[], patterns: RegExp[]): number {
  return lines.filter(l => patterns.some(p => p.test(l))).length;
}

function extractFailingChecks(lines: string[]): string[] {
  const failures: string[] = [];
  for (const line of lines) {
    if (TEST_FAIL_PATTERNS.some(p => p.test(line))) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && failures.length < FIRST_N_FAILURES) {
        failures.push(trimmed);
      }
    }
  }
  return failures;
}

/** Model-facing result type for run_quality_checks. */
export interface QualityChecksResult {
  status: string;
  verdict: 'passed' | 'failed';
  exitCode: number;
  durationMs: number;
  rawLogFile: string;
  errorCount: number;
  warningCount: number;
  /** First up to 10 failing check lines (deterministic semantic selection). */
  failedChecks: string[];
  passedCheckCount: number;
}

/**
 * Reduce raw quality-check output to a compact model-facing result.
 * Deterministic: same input always produces same output.
 */
export function reduceQualityOutput(
  rawOutput: string,
  verdict: 'passed' | 'failed',
  exitCode: number,
  durationMs: number,
  rawLogFile: string,
  status: string
): QualityChecksResult {
  const lines = rawOutput.split('\n');
  return {
    status,
    verdict,
    exitCode,
    durationMs,
    rawLogFile,
    errorCount: countMatches(lines, ERROR_PATTERNS),
    warningCount: countMatches(lines, WARNING_PATTERNS),
    failedChecks: extractFailingChecks(lines),
    passedCheckCount: countMatches(lines, TEST_PASS_PATTERNS),
  };
}

/** Model-facing result type for compress_session_logs. */
export interface SessionLogSummary {
  rawLogFile: string;
  lineCount: number;
  byteCount: number;
  errorCount: number;
  warnCount: number;
  /** Up to 10 unique component names found in log lines. */
  components: string[];
  /** First up to 10 error lines (deterministic semantic selection). */
  recentErrors: string[];
}

// Matches common structured log prefixes like "[Component]" or "Component:"
const LOG_COMPONENT_PATTERN = /^\[?([A-Z][A-Za-z0-9_-]+)\]?[:\s]/;
const LOG_ERROR_LINE_PATTERN = /\b(?:error|ERROR|✗|FAIL)\b/;
const LOG_WARN_LINE_PATTERN = /\b(?:warn(?:ing)?|WARN)\b/i;

/**
 * Reduce raw session log content to a compact model-facing summary.
 * Deterministic: counts, component names, and first-N error lines.
 */
export function reduceSessionLogs(rawLogs: string, rawLogFile: string): SessionLogSummary {
  const lines = rawLogs.split('\n');
  const componentSet = new Set<string>();
  const errorLines: string[] = [];
  let errorCount = 0;
  let warnCount = 0;

  for (const line of lines) {
    const compMatch = LOG_COMPONENT_PATTERN.exec(line);
    if (compMatch && componentSet.size < 10) componentSet.add(compMatch[1]);
    if (LOG_ERROR_LINE_PATTERN.test(line)) {
      errorCount++;
      if (errorLines.length < 10) errorLines.push(line.trim());
    }
    if (LOG_WARN_LINE_PATTERN.test(line)) warnCount++;
  }

  return {
    rawLogFile,
    lineCount: lines.length,
    byteCount: Buffer.byteLength(rawLogs, 'utf8'),
    errorCount,
    warnCount,
    components: Array.from(componentSet),
    recentErrors: errorLines,
  };
}

// ── Raw-log file writer ──────────────────────────────────────────────────────

/**
 * Write complete raw content to a file under the harness-injected output dir.
 * Falls back to OperationalArtifactPath.PI_TOOL_OUTPUT_DIR if env var is unset.
 * Returns the absolute (or project-relative) path of the written file.
 */
async function writeRawLogFile(
  fileName: string,
  content: string,
  env: RuntimeEnvironment
): Promise<string> {
  const outputDir =
    env.env(EnvVars.TOOL_OUTPUT_DIR) ?? OperationalArtifactPath.PI_TOOL_OUTPUT_DIR;
  await mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, fileName);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

// ── Plugin factory ───────────────────────────────────────────────────────────

export function createQualityPlugin(observability?: Observability, env: RuntimeEnvironment = nodeRuntimeEnvironment): RuntimePlugin {
  return {
  name: 'quality-assurance',
  tools: [
    {
      name: PluginToolName.RUN_QUALITY_CHECKS,
      description: "Performs mandatory code quality, complexity, and idiomatic checks.",
      parameters: Type.Object({
        command: Type.Optional(Type.String({ description: "Optional command to run instead of the default TypeScript checks" }))
      }),
      execute: async (params: unknown, ctx?: unknown): Promise<QualityChecksResult> => {
        const { command } = (params && typeof params === 'object' ? params : {}) as { command?: string };
        const ui = ctx && typeof ctx === 'object' ? ctx as { hasUI?: boolean; ui?: { setWorkingMessage(m: string | undefined): void; notify(m: string, t: string): void } } : undefined;

        if (ui?.hasUI) ui.ui?.setWorkingMessage("Running quality checks...");

        const startMs = Date.now();
        let rawOutput = '';
        let exitCode: number | undefined;
        let verdict: 'passed' | 'failed' = 'passed';

        try {
          if (command) {
            const result = await execa('sh', ['-lc', command]);
            rawOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');
            exitCode = result.exitCode;
            if (exitCode !== 0) verdict = 'failed';
          } else {
            const build = await execa('npm', ['run', 'build']);
            const test = await execa('npm', ['test']);
            rawOutput = [build.stdout, build.stderr, test.stdout, test.stderr].filter(Boolean).join('\n');
            exitCode = test.exitCode;
            if (exitCode !== 0) verdict = 'failed';
          }
        } catch (error: unknown) {
          verdict = 'failed';
          const errStdout = (error && typeof error === 'object' && 'stdout' in error ? (error as { stdout: string }).stdout : undefined) ?? '';
          const errStderr = (error && typeof error === 'object' && 'stderr' in error ? (error as { stderr: string }).stderr : undefined) ?? '';
          rawOutput = [errStdout, errStderr].filter(Boolean).join('\n') || (error instanceof Error ? error.message : String(error));
          exitCode = (error && typeof error === 'object' && 'exitCode' in error ? (error as { exitCode?: number }).exitCode : undefined) ?? 1;
          Logger.error(Component.QUALITY, 'Quality checks failed', { error: rawOutput });
        }

        const endMs = Date.now();
        const durationMs = endMs - startMs;

        // ── Write complete raw output to file ────────────────────────────────
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const rawLogFileName = `quality-checks-${ts}.log`;
        let rawLogFile = rawLogFileName;
        try {
          rawLogFile = await writeRawLogFile(rawLogFileName, rawOutput, env);
        } catch (writeErr) {
          Logger.error(Component.QUALITY, 'Failed to write raw quality log', { error: writeErr });
        }

        // ── Telemetry (best-effort) ──────────────────────────────────────────
        try {
          observability?.recordCompletedSpan(SpanName.VERIFIER_RUN, {
            [OtelAttr.ORR_ELSE_BEAD_ID]: env.env(EnvVars.BEAD_ID) || undefined,
            [OtelAttr.ORR_ELSE_STATE_ID]: env.env(EnvVars.STATE_ID) || undefined,
            'verifier.verdict': verdict,
            'verifier.exit_code': exitCode ?? 0
          }, startMs, endMs);
        } catch { /* best-effort: telemetry must never fail the check */ }

        const status = verdict === 'failed' ? ToolResultStatus.REJECTED : ToolResultStatus.PASSED;

        if (ui?.hasUI) {
          if (verdict === 'failed') {
            ui.ui?.notify("Quality checks FAILED", "error");
          } else {
            ui.ui?.notify("Quality checks PASSED", "info");
          }
          ui.ui?.setWorkingMessage(undefined);
        }

        // ── Return deterministic reducer result (no raw output inline) ───────
        return reduceQualityOutput(rawOutput, verdict, exitCode ?? 0, durationMs, rawLogFile, status);
      }
    },
    {
      name: PluginToolName.COMPRESS_SESSION_LOGS,
      description: "Archives session logs to a file and returns a deterministic structural summary. Raw logs are written in full; the model-facing result contains counts, components, and first-N error lines.",
      parameters: Type.Object({
        logs: Type.String({ description: "The session logs to archive and summarize" })
      }),
      execute: async (params: unknown): Promise<SessionLogSummary> => {
        const { logs } = (params && typeof params === 'object' ? params : {}) as { logs: string };

        // ── Write complete raw logs to file ──────────────────────────────────
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const rawLogFileName = `session-logs-${ts}.log`;
        let rawLogFile = rawLogFileName;
        try {
          rawLogFile = await writeRawLogFile(rawLogFileName, logs, env);
        } catch (writeErr) {
          Logger.error(Component.QUALITY, 'Failed to write raw session log', { error: writeErr });
        }

        // ── Return deterministic reducer result ──────────────────────────────
        return reduceSessionLogs(logs, rawLogFile);
      }
    }
  ] satisfies RuntimeTool[]
};
}
