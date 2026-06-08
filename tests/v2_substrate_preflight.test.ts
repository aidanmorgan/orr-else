/**
 * v2_substrate_preflight.test.ts — pi-experiment-ek2j
 *
 * Unit tests for V2SubstratePreflight: tmux substrate check, git-worktree
 * substrate check, combined admission gate, sanitisation.
 *
 * All execa calls are intercepted via setSubstrateProbesForTest so no real
 * tmux or git processes are spawned in the test suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkTmuxSubstrate,
  checkGitWorktreeSubstrate,
  runV2SubstratePreflight,
  sanitiseStderr,
  setSubstrateProbesForTest,
  resetSubstrateProbes,
  type SubstrateProbe
} from '../src/core/V2SubstratePreflight.js';
import { DomainEventName } from '../src/constants/index.js';

// ---------------------------------------------------------------------------
// Fake probes
// ---------------------------------------------------------------------------

function okProbe(): SubstrateProbe {
  return async () => ({ ok: true });
}

function failProbe(stderr = 'command not found: tmux'): SubstrateProbe {
  return async () => ({ ok: false, stderr });
}

// ---------------------------------------------------------------------------
// Fake EventStore
// ---------------------------------------------------------------------------

function fakeEventStore() {
  const recorded: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    recorded,
    record: async (type: string, data: Record<string, unknown>) => {
      recorded.push({ type, data });
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V2SubstratePreflight — sanitiseStderr', () => {
  it('truncates to 500 chars', () => {
    const long = 'x'.repeat(600);
    expect(sanitiseStderr(long)).toHaveLength(500);
  });

  it('redacts KEY=value env-var tokens', () => {
    const raw = 'failed: TMUX_SOCKET=/tmp/sock, error: TOKEN=abc123';
    const sanitised = sanitiseStderr(raw);
    expect(sanitised).not.toContain('TMUX_SOCKET=/tmp/sock');
    expect(sanitised).not.toContain('TOKEN=abc123');
    expect(sanitised).toContain('<redacted>');
  });

  it('passes through short stderr with no env tokens', () => {
    const raw = 'no server running on /tmp/tmux-1000/default';
    expect(sanitiseStderr(raw)).toBe(raw);
  });
});

describe('V2SubstratePreflight — checkTmuxSubstrate', () => {
  afterEach(() => resetSubstrateProbes());

  it('returns ok=true when the tmux probe succeeds', async () => {
    setSubstrateProbesForTest({ tmux: okProbe() });
    const result = await checkTmuxSubstrate('/some/root');
    expect(result.ok).toBe(true);
    expect(result.substrate).toBe('tmux');
    expect(result.diagnostic).toBeUndefined();
  });

  it('returns ok=false with substrate, command, sanitizedStderr, diagnostic when probe fails', async () => {
    setSubstrateProbesForTest({ tmux: failProbe('no server running') });
    const result = await checkTmuxSubstrate('/some/root');
    expect(result.ok).toBe(false);
    expect(result.substrate).toBe('tmux');
    expect(result.command).toMatch(/^tmux /);
    expect(result.sanitizedStderr).toContain('no server running');
    expect(result.diagnostic).toMatch(/tmux substrate check failed/i);
    expect(result.diagnostic).toMatch(/tmux list-sessions/);
  });

  it('includes install hint in diagnostic', async () => {
    setSubstrateProbesForTest({ tmux: failProbe() });
    const result = await checkTmuxSubstrate('/proj');
    expect(result.diagnostic).toMatch(/Install tmux/);
  });
});

describe('V2SubstratePreflight — checkGitWorktreeSubstrate', () => {
  afterEach(() => resetSubstrateProbes());

  it('returns ok=true when the git probe succeeds', async () => {
    setSubstrateProbesForTest({ git: okProbe() });
    const result = await checkGitWorktreeSubstrate('/some/root');
    expect(result.ok).toBe(true);
    expect(result.substrate).toBe('git-worktree');
    expect(result.diagnostic).toBeUndefined();
  });

  it('returns ok=false with substrate, command, projectRoot, diagnostic when probe fails', async () => {
    setSubstrateProbesForTest({ git: failProbe('not a git repository') });
    const result = await checkGitWorktreeSubstrate('/some/root');
    expect(result.ok).toBe(false);
    expect(result.substrate).toBe('git-worktree');
    expect(result.command).toBe('git worktree list');
    expect(result.projectRoot).toBe('/some/root');
    expect(result.sanitizedStderr).toContain('not a git repository');
    expect(result.diagnostic).toMatch(/git worktree substrate check failed/i);
    expect(result.diagnostic).toMatch(/\/some\/root/);
  });

  it('includes git repository hint in diagnostic', async () => {
    setSubstrateProbesForTest({ git: failProbe() });
    const result = await checkGitWorktreeSubstrate('/proj');
    expect(result.diagnostic).toMatch(/inside a git repository/i);
  });
});

describe('V2SubstratePreflight — runV2SubstratePreflight', () => {
  afterEach(() => resetSubstrateProbes());

  it('resolves without throwing when both substrates pass', async () => {
    setSubstrateProbesForTest({ tmux: okProbe(), git: okProbe() });
    const store = fakeEventStore();
    await expect(
      runV2SubstratePreflight('/proj', store as any)
    ).resolves.toBeUndefined();
    expect(store.recorded).toHaveLength(0);
  });

  it('throws and records V2_SUBSTRATE_PREFLIGHT_FAILED when tmux fails', async () => {
    setSubstrateProbesForTest({
      tmux: failProbe('no tmux server running'),
      git: okProbe()
    });
    const store = fakeEventStore();
    await expect(
      runV2SubstratePreflight('/proj', store as any)
    ).rejects.toThrow(/substrate preflight failed/i);

    expect(store.recorded).toHaveLength(1);
    const [ev] = store.recorded;
    expect(ev.type).toBe(DomainEventName.V2_SUBSTRATE_PREFLIGHT_FAILED);
    expect(ev.data.substrate).toBe('tmux');
    expect(ev.data.projectRoot).toBe('/proj');
    expect(typeof ev.data.diagnostic).toBe('string');
  });

  it('throws and records V2_SUBSTRATE_PREFLIGHT_FAILED when git-worktree fails', async () => {
    setSubstrateProbesForTest({
      tmux: okProbe(),
      git: failProbe('not a git repository')
    });
    const store = fakeEventStore();
    await expect(
      runV2SubstratePreflight('/proj', store as any)
    ).rejects.toThrow(/git-worktree/i);

    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0].data.substrate).toBe('git-worktree');
  });

  it('records two events and names both substrates in the error when both fail', async () => {
    setSubstrateProbesForTest({
      tmux: failProbe('no tmux'),
      git: failProbe('not a repo')
    });
    const store = fakeEventStore();
    let error: Error | undefined;
    try {
      await runV2SubstratePreflight('/proj', store as any);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/tmux/);
    expect(error!.message).toMatch(/git-worktree/);
    expect(store.recorded).toHaveLength(2);
    const substrates = store.recorded.map(r => r.data.substrate);
    expect(substrates).toContain('tmux');
    expect(substrates).toContain('git-worktree');
  });

  it('error message references no model spend and no worker spawn', async () => {
    setSubstrateProbesForTest({ tmux: failProbe(), git: okProbe() });
    const store = fakeEventStore();
    await expect(
      runV2SubstratePreflight('/proj', store as any)
    ).rejects.toThrow(/no model spend|no worker spawn/i);
  });

  it('failure event includes command field when command is available', async () => {
    setSubstrateProbesForTest({ tmux: failProbe('err'), git: okProbe() });
    const store = fakeEventStore();
    await expect(runV2SubstratePreflight('/proj', store as any)).rejects.toThrow();
    const [ev] = store.recorded;
    expect(ev.data.command).toMatch(/^tmux /);
  });

  it('V2_SUBSTRATE_PREFLIGHT_FAILED event carries sanitizedStderr', async () => {
    setSubstrateProbesForTest({
      tmux: failProbe('SOCKET=/tmp/orr-else failed'),
      git: okProbe()
    });
    const store = fakeEventStore();
    await expect(runV2SubstratePreflight('/proj', store as any)).rejects.toThrow();
    const ev = store.recorded[0];
    // sanitizedStderr must be present and must be redacted
    expect(ev.data.sanitizedStderr).toBeDefined();
    expect(ev.data.sanitizedStderr as string).not.toContain('SOCKET=/tmp/orr-else');
  });
});
