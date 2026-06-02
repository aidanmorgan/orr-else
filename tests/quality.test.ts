/**
 * Tests for the quality plugin's VERIFIER_RUN span instrumentation.
 *
 * Strategy: spy on observability.recordCompletedSpan so we can assert:
 *   - the span name is SpanName.VERIFIER_RUN ('verifier_run')
 *   - startMs <= endMs (nonzero duration contract)
 *   - bead/state attrs are threaded through
 *   - verdict is 'passed' on success, 'failed' on error
 *   - telemetry errors never break the verifier outcome
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQualityPlugin } from '../src/plugins/quality.js';
import { EnvVars, PluginToolName, SpanName, ToolResultStatus } from '../src/constants/index.js';
import type { Observability } from '../src/core/Observability.js';

// ── mock execa so tests never shell out ─────────────────────────────────────

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

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

// ── tests ─────────────────────────────────────────────────────────────────────

describe('quality plugin — VERIFIER_RUN span', () => {
  beforeEach(() => {
    execaMock.mockReset();
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
