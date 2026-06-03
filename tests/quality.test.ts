/**
 * Tests for the quality plugin.
 *
 * Covers:
 *   1. compress_session_logs deterministic reducer.
 *   2. Raw-log archival fixture: large session log -> raw log file holds complete
 *      content; model-facing result is a compact reducer result with no capped
 *      preview, no truncation, and no LLM-summary fields.
 *
 * Note: run_quality_checks was a cerdiwen-specific bundled tool that has been
 * removed from the generic harness (pi-experiment-gzy0). Projects that need a
 * quality gate should define their own project tool in harness.yaml.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQualityPlugin, reduceSessionLogs } from '../src/plugins/quality.js';
import { EnvVars, PluginToolName } from '../src/constants/index.js';

// ── mock fs/promises so tests never write to disk ────────────────────────────

const mkdirMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const writeFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('fs/promises', () => ({ mkdir: mkdirMock, writeFile: writeFileMock }));

// ── helpers ──────────────────────────────────────────────────────────────────

function tool(plugin: ReturnType<typeof createQualityPlugin>, name: string) {
  const found = plugin.tools.find(t => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function makeEnv(vars: Record<string, string> = {}) {
  return { env: (name: string) => vars[name] };
}

describe('reduceSessionLogs — deterministic reducer', () => {
  it('counts lines, bytes, errors, and warnings', () => {
    const logs = [
      '[Core] Starting up',
      '[Orchestrator] error: connection refused',
      '[Supervisor] warn: retry attempt 1',
      '[Teammate] normal log line',
      '[Core] error: timeout',
    ].join('\n');

    const result = reduceSessionLogs(logs, '/tmp/session.log');

    expect(result.rawLogFile).toBe('/tmp/session.log');
    expect(result.lineCount).toBe(5);
    expect(result.byteCount).toBe(Buffer.byteLength(logs, 'utf8'));
    expect(result.errorCount).toBeGreaterThanOrEqual(2);
    expect(result.warnCount).toBeGreaterThanOrEqual(1);
    expect(result.components).toContain('Core');
    expect(result.components).toContain('Orchestrator');
  });

  it('returns first-N error lines (max 10), not a preview/truncation', () => {
    const errorLines = Array.from({ length: 20 }, (_, i) => `[Component] error: failure ${i + 1}`);
    const logs = errorLines.join('\n');

    const result = reduceSessionLogs(logs, '/tmp/session.log');

    expect(result.recentErrors).toHaveLength(10);
    expect(result.recentErrors[0]).toContain('failure 1');
    // No LLM-summary or preview fields
    expect(result).not.toHaveProperty('summary');
    expect(result).not.toHaveProperty('preview');
    expect(result).not.toHaveProperty('compressed');
  });

  it('is deterministic: same input always produces same output', () => {
    const logs = '[A] error: x\n[B] warn: y\n[C] info: z';
    const a = reduceSessionLogs(logs, '/tmp/s.log');
    const b = reduceSessionLogs(logs, '/tmp/s.log');
    expect(a).toEqual(b);
  });
});

// ── Raw-log archival fixture ──────────────────────────────────────────────────
//
// Fixture: a quality/log run producing large output.
// Contract:
//   - raw log file receives COMPLETE output (all bytes, verified by byte count)
//   - model-facing result is a compact deterministic reducer result
//   - no capped preview / truncation / LLM-summary fields anywhere

describe('quality plugin — raw-log archival fixture (large output)', () => {
  beforeEach(() => {
    mkdirMock.mockReset().mockResolvedValue(undefined);
    writeFileMock.mockReset().mockResolvedValue(undefined);
  });

  it('compress_session_logs: raw log file receives complete output; model result is compact reducer', async () => {
    // Simulate large session log: 1000 lines (~80KB)
    const largeLogs = Array.from({ length: 1000 }, (_, i) => {
      if (i % 20 === 0) return `[Orchestrator] error: failed task ${i}`;
      if (i % 13 === 0) return `[Supervisor] warn: retry ${i}`;
      return `[Core] info: processing step ${i}`;
    }).join('\n');

    const env = makeEnv({ [EnvVars.TOOL_OUTPUT_DIR]: '/tmp/pi-tool-output' });
    const plugin = createQualityPlugin(env);

    const result = await tool(plugin, PluginToolName.COMPRESS_SESSION_LOGS).execute({ logs: largeLogs }) as Record<string, unknown>;

    // ── Raw log file contract ────────────────────────────────────────────────
    expect(writeFileMock).toHaveBeenCalledOnce();
    const [writtenPath, writtenContent] = writeFileMock.mock.calls[0] as [string, string, string];

    expect(writtenPath).toMatch(/^\/tmp\/pi-tool-output\//);
    expect(writtenPath).toMatch(/session-logs-.+\.log$/);

    // Complete logs written — byte count matches exactly
    expect(writtenContent).toBe(largeLogs);
    expect(writtenContent.length).toBe(largeLogs.length);

    // ── Model-facing result contract ─────────────────────────────────────────
    expect(result).toHaveProperty('rawLogFile', writtenPath);
    expect(result).toHaveProperty('lineCount', 1000);
    expect(result).toHaveProperty('byteCount', Buffer.byteLength(largeLogs, 'utf8'));
    expect(result).toHaveProperty('errorCount');
    expect(result).toHaveProperty('warnCount');
    expect(result).toHaveProperty('components');
    expect(result).toHaveProperty('recentErrors');

    // recentErrors is at most 10 (semantic first-N, not byte-capped)
    expect((result['recentErrors'] as string[]).length).toBeLessThanOrEqual(10);

    // FORBIDDEN fields
    expect(result).not.toHaveProperty('output');
    expect(result).not.toHaveProperty('preview');
    expect(result).not.toHaveProperty('compressed');
    expect(result).not.toHaveProperty('summary');
    expect(result).not.toHaveProperty('llmSummary');
    expect(result).not.toHaveProperty('llmPrompt');
    expect(result).not.toHaveProperty('truncated');
  });
});
