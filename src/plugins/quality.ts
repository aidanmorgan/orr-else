import path from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { Type } from "@earendil-works/pi-ai";
import { Logger } from '../core/Logger.js';
import { PluginToolName } from '../constants/domain.js';
import { Component, EnvVars, OperationalArtifactPath } from '../constants/infra.js';
import { nodeRuntimeEnvironment, type RuntimeEnvironment } from '../core/RuntimeEnvironment.js';
import { resolveProjectFrom } from '../core/Paths.js';
import type { RuntimePlugin, RuntimeTool } from '../core/RuntimeServices.js';

// ── Deterministic reducers ───────────────────────────────────────────────────
//
// These reducers transform raw command output into compact structured results.
// No LLM summarization. No byte-capped previews. The model sees only the
// reduced schema; complete raw output is archived to a file.

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
 * Priority: the harness-injected PI_TOOL_OUTPUT_DIR env var (already absolute),
 * else the project-scoped OperationalArtifactPath.PI_TOOL_OUTPUT_DIR resolved
 * against the injected PROJECT_ROOT — never a bare cwd-relative literal.
 * Returns the absolute path of the written file.
 */
async function writeRawLogFile(
  fileName: string,
  content: string,
  env: RuntimeEnvironment,
  projectRoot: string
): Promise<string> {
  const outputDir =
    env.env(EnvVars.TOOL_OUTPUT_DIR)
    ?? resolveProjectFrom(env.env(EnvVars.PROJECT_ROOT) || projectRoot, OperationalArtifactPath.PI_TOOL_OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, fileName);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

// ── Plugin factory ───────────────────────────────────────────────────────────

export function createQualityPlugin(
  env: RuntimeEnvironment = nodeRuntimeEnvironment,
  projectRoot: string = process.cwd()
): RuntimePlugin {
  return {
  name: 'quality-assurance',
  tools: [
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
          rawLogFile = await writeRawLogFile(rawLogFileName, logs, env, projectRoot);
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
