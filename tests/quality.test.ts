/**
 * Tests for the quality plugin.
 *
 * Covers:
 *   1. VERIFIER_RUN span instrumentation (existing contract).
 *   2. Deterministic reducer contract: model-facing result is compact structured
 *      data, NOT inline raw output and NOT an LLM summary.
 *   3. Raw-log archival fixture: large output -> raw log file holds complete
 *      content; model-facing result is a compact reducer result with no capped
 *      preview, no truncation, and no LLM-summary fields.
 *   4. compress_session_logs deterministic reducer (replaces LLM-prompt path).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQualityPlugin, reduceQualityOutput, reduceSessionLogs } from '../src/plugins/quality.js';
import { EnvVars, PluginToolName, SpanName, ToolResultStatus } from '../src/constants/index.js';
import type { Observability } from '../src/core/Observability.js';

// ── mock execa so tests never shell out ─────────────────────────────────────

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

// ── mock fs/promises so tests never write to disk ────────────────────────────

const mkdirMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const writeFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('fs/promises', () => ({ mkdir: mkdirMock, writeFile: writeFileMock }));

// ── helpers ──────────────────────────────────────────────────────────────────

function makeObservabilitySpy() {
  return {
    recordCompletedSpan: vi.fn()
  } as unknown as Observability;
}

function tool(plugin: ReturnType<typeof createQualityPlugin>, name: string) {
  const found = plugin.tools.find(t => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function makeEnv(vars: Record<string, string> = {}) {
  return { env: (name: string) => vars[name] };
}

// ── VERIFIER_RUN span tests (existing contract) ───────────────────────────────

describe('quality plugin — VERIFIER_RUN span', () => {
  beforeEach(() => {
    execaMock.mockReset();
    mkdirMock.mockReset().mockResolvedValue(undefined);
    writeFileMock.mockReset().mockResolvedValue(undefined);
  });

  it('emits SpanName.VERIFIER_RUN with startMs<=endMs and verdict=passed on success', async () => {
    execaMock.mockResolvedValue({ stdout: 'all good', exitCode: 0, stderr: '' });

    const obs = makeObservabilitySpy();
    const plugin = createQualityPlugin(obs);

    const result = await tool(plugin, PluginToolName.RUN_QUALITY_CHECKS).execute({ command: 'echo ok' });

    expect(result).toMatchObject({ status: ToolResultStatus.PASSED });

    expect(obs.recordCompletedSpan).toHaveBeenCalledOnce();
    const [name, attrs, startMs, endMs] = (obs.recordCompletedSpan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(name).toBe(SpanName.VERIFIER_RUN);
    expect(startMs).toBeLessThanOrEqual(endMs);
    expect(endMs - startMs).toBeGreaterThanOrEqual(0);
    expect(attrs['verifier.verdict']).toBe('passed');
    expect(attrs['verifier.exit_code']).toBe(0);
  });

  it('emits SpanName.VERIFIER_RUN with verdict=failed when execa throws', async () => {
    const fakeError = Object.assign(new Error('tsc failed'), { stdout: 'error output', exitCode: 1 });
    execaMock.mockRejectedValue(fakeError);

    const obs = makeObservabilitySpy();
    const plugin = createQualityPlugin(obs);

    const result = await tool(plugin, PluginToolName.RUN_QUALITY_CHECKS).execute({ command: 'tsc --noEmit' });

    expect(result).toMatchObject({ status: ToolResultStatus.REJECTED });

    expect(obs.recordCompletedSpan).toHaveBeenCalledOnce();
    const [name, attrs, startMs, endMs] = (obs.recordCompletedSpan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(name).toBe(SpanName.VERIFIER_RUN);
    expect(startMs).toBeLessThanOrEqual(endMs);
    expect(attrs['verifier.verdict']).toBe('failed');
    expect(attrs['verifier.exit_code']).toBe(1);
  });

  it('includes orr_else.bead_id and orr_else.state_id from env when set', async () => {
    execaMock.mockResolvedValue({ stdout: 'ok', exitCode: 0, stderr: '' });

    const previousBeadId = process.env[EnvVars.BEAD_ID];
    const previousStateId = process.env[EnvVars.STATE_ID];
    process.env[EnvVars.BEAD_ID] = 'bd-quality-test';
    process.env[EnvVars.STATE_ID] = 'Implementation';

    try {
      const obs = makeObservabilitySpy();
      const plugin = createQualityPlugin(obs);

      await tool(plugin, PluginToolName.RUN_QUALITY_CHECKS).execute({ command: 'echo hi' });

      const [, attrs] = (obs.recordCompletedSpan as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(attrs['orr_else.bead_id']).toBe('bd-quality-test');
      expect(attrs['orr_else.state_id']).toBe('Implementation');
    } finally {
      if (previousBeadId === undefined) delete process.env[EnvVars.BEAD_ID];
      else process.env[EnvVars.BEAD_ID] = previousBeadId;
      if (previousStateId === undefined) delete process.env[EnvVars.STATE_ID];
      else process.env[EnvVars.STATE_ID] = previousStateId;
    }
  });

  it('does not emit span when no observability is provided', async () => {
    execaMock.mockResolvedValue({ stdout: 'ok', exitCode: 0, stderr: '' });

    // No observability passed — must not throw.
    const plugin = createQualityPlugin(undefined);
    const result = await tool(plugin, PluginToolName.RUN_QUALITY_CHECKS).execute({ command: 'echo hi' });
    expect(result).toMatchObject({ status: ToolResultStatus.PASSED });
  });

  it('telemetry error does not break the verifier result (best-effort)', async () => {
    execaMock.mockResolvedValue({ stdout: 'ok', exitCode: 0, stderr: '' });

    const obs = {
      recordCompletedSpan: vi.fn().mockImplementation(() => {
        throw new Error('otel unavailable');
      })
    } as unknown as Observability;

    const plugin = createQualityPlugin(obs);

    // Must still return PASSED despite telemetry throwing.
    const result = await tool(plugin, PluginToolName.RUN_QUALITY_CHECKS).execute({ command: 'echo hi' });
    expect(result).toMatchObject({ status: ToolResultStatus.PASSED });
  });
});

// ── Deterministic reducer unit tests ─────────────────────────────────────────

describe('reduceQualityOutput — deterministic reducer', () => {
  it('counts errors and warnings from raw output', () => {
    const raw = [
      'src/foo.ts:10:5 - error TS2345: Type mismatch',
      'src/bar.ts:3:1 - warning: unused variable',
      'src/baz.ts:7:2 - error TS1234: Something wrong',
      'All good here',
    ].join('\n');

    const result = reduceQualityOutput(raw, 'failed', 1, 1000, '/tmp/test.log', ToolResultStatus.REJECTED);

    expect(result.verdict).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.durationMs).toBe(1000);
    expect(result.rawLogFile).toBe('/tmp/test.log');
    expect(result.errorCount).toBeGreaterThanOrEqual(2);
    expect(result.warningCount).toBeGreaterThanOrEqual(1);
    // No raw output field
    expect(result).not.toHaveProperty('output');
  });

  it('extracts failing checks deterministically (first-N, not byte-capped)', () => {
    // Generate 20 failing lines — reducer must return first 10 semantically, not truncate by bytes
    const failLines = Array.from({ length: 20 }, (_, i) => ` ✗ test case ${i + 1} failed`);
    const raw = failLines.join('\n');

    const result = reduceQualityOutput(raw, 'failed', 1, 500, '/tmp/test.log', ToolResultStatus.REJECTED);

    expect(result.failedChecks).toHaveLength(10);
    // First failure is first line deterministically
    expect(result.failedChecks[0]).toContain('test case 1');
    // No LLM-summary field
    expect(result).not.toHaveProperty('summary');
    expect(result).not.toHaveProperty('preview');
    expect(result).not.toHaveProperty('outputPreview');
  });

  it('passes test with zero errors and zero warnings on clean output', () => {
    const raw = 'Build succeeded\nAll 42 tests passed\n✓ suite A\n✓ suite B';
    const result = reduceQualityOutput(raw, 'passed', 0, 200, '/tmp/ok.log', ToolResultStatus.PASSED);

    expect(result.verdict).toBe('passed');
    expect(result.failedChecks).toHaveLength(0);
    expect(result.passedCheckCount).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic: same input always produces same output', () => {
    const raw = 'error: something\nwarning: something else\n✗ test 1';
    const a = reduceQualityOutput(raw, 'failed', 1, 100, '/tmp/x.log', ToolResultStatus.REJECTED);
    const b = reduceQualityOutput(raw, 'failed', 1, 100, '/tmp/x.log', ToolResultStatus.REJECTED);
    expect(a).toEqual(b);
  });
});

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
    execaMock.mockReset();
    mkdirMock.mockReset().mockResolvedValue(undefined);
    writeFileMock.mockReset().mockResolvedValue(undefined);
  });

  it('run_quality_checks: raw log file receives complete output; model result is compact reducer', async () => {
    // Simulate large output: 500 lines of build/test output (~40KB)
    const largeOutput = Array.from({ length: 500 }, (_, i) =>
      i % 17 === 0
        ? `error TS${1000 + i}: Type error in src/file${i}.ts`
        : `info: processing file src/file${i}.ts`
    ).join('\n');

    execaMock.mockResolvedValue({ stdout: largeOutput, exitCode: 1, stderr: '' });

    const env = makeEnv({ [EnvVars.TOOL_OUTPUT_DIR]: '/tmp/pi-tool-output' });
    const plugin = createQualityPlugin(undefined, env);

    const result = await tool(plugin, PluginToolName.RUN_QUALITY_CHECKS).execute({ command: 'tsc --noEmit' }) as Record<string, unknown>;

    // ── Raw log file contract ────────────────────────────────────────────────
    // writeFile was called once with the complete raw output
    expect(writeFileMock).toHaveBeenCalledOnce();
    const [writtenPath, writtenContent] = writeFileMock.mock.calls[0] as [string, string, string];

    // Path is under the injected tool output dir
    expect(writtenPath).toMatch(/^\/tmp\/pi-tool-output\//);
    expect(writtenPath).toMatch(/quality-checks-.+\.log$/);

    // Complete output was written — byte count matches exactly, no truncation
    expect(writtenContent).toBe(largeOutput);
    expect(writtenContent.length).toBe(largeOutput.length);

    // ── Model-facing result contract ─────────────────────────────────────────
    // Result has compact structured fields
    expect(result).toHaveProperty('verdict', 'failed');
    expect(result).toHaveProperty('exitCode', 1);
    expect(result).toHaveProperty('durationMs');
    expect(result).toHaveProperty('rawLogFile', writtenPath);
    expect(result).toHaveProperty('errorCount');
    expect(result).toHaveProperty('warningCount');
    expect(result).toHaveProperty('failedChecks');
    expect(result).toHaveProperty('passedCheckCount');

    // failedChecks is at most 10 items (semantic first-N, not byte-capped)
    expect((result['failedChecks'] as string[]).length).toBeLessThanOrEqual(10);

    // FORBIDDEN fields — raw output, previews, LLM summaries must not appear
    expect(result).not.toHaveProperty('output');
    expect(result).not.toHaveProperty('preview');
    expect(result).not.toHaveProperty('outputPreview');
    expect(result).not.toHaveProperty('resultPreview');
    expect(result).not.toHaveProperty('diagnosticPreview');
    expect(result).not.toHaveProperty('summary');
    expect(result).not.toHaveProperty('llmSummary');
    expect(result).not.toHaveProperty('stdoutTruncated');
    expect(result).not.toHaveProperty('truncated');
  });

  it('compress_session_logs: raw log file receives complete output; model result is compact reducer', async () => {
    // Simulate large session log: 1000 lines (~80KB)
    const largeLogs = Array.from({ length: 1000 }, (_, i) => {
      if (i % 20 === 0) return `[Orchestrator] error: failed task ${i}`;
      if (i % 13 === 0) return `[Supervisor] warn: retry ${i}`;
      return `[Core] info: processing step ${i}`;
    }).join('\n');

    const env = makeEnv({ [EnvVars.TOOL_OUTPUT_DIR]: '/tmp/pi-tool-output' });
    const plugin = createQualityPlugin(undefined, env);

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

  it('run_quality_checks: rawLogFile path is returned in model result so model can access full output', async () => {
    execaMock.mockResolvedValue({ stdout: 'ok', exitCode: 0, stderr: '' });

    const env = makeEnv({ [EnvVars.TOOL_OUTPUT_DIR]: '/tmp/pi-tool-output' });
    const plugin = createQualityPlugin(undefined, env);

    const result = await tool(plugin, PluginToolName.RUN_QUALITY_CHECKS).execute({ command: 'echo ok' }) as Record<string, unknown>;

    // rawLogFile gives the model a reference path to the full output
    expect(typeof result['rawLogFile']).toBe('string');
    expect((result['rawLogFile'] as string).length).toBeGreaterThan(0);
  });
});
