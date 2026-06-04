/**
 * pi-experiment-0yt5.20 — coordinator gate bootstrap (AC2 + AC4).
 *
 *   AC2 — the coordinator loads pi.workerExtensions in its OWN process at startup
 *         so consumer verify() callbacks register in the GATE process. A test
 *         asserts the verifier registry is non-empty IN THE GATE PROCESS after
 *         loading a fixture extension.
 *   AC4 — config fail-fast: every required tool that EXPECTS a verify()
 *         (expectsVerify:true) MUST resolve to a registered callback; presence-only
 *         tools (string form / no flag) load cleanly. The error NAMES the offender.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifier } from '../src/contract.js';
import { loadCoordinatorWorkerExtensions } from '../src/core/CoordinatorExtensionLoader.js';
import { validateRequiredToolVerifiers } from '../src/core/CoordinatorVerifierGate.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import type { SDLCState } from '../src/core/domain/StateModels.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const FIXTURE_EXTENSION = path.join('tests', 'fixtures', 'coordinator-gate', 'verify-extension.ts');
const FIXTURE_TOOL = 'fixture_coordinator_verify_tool';

afterEach(() => {
  vi.restoreAllMocks();
  // last-wins overwrite so the fixture callback cannot leak into other suites.
  verifier.register(FIXTURE_TOOL, () => ({ verdict: 'NOT_APPLICABLE' as never, reasons: [] }));
});

function configWithWorkerExtensions(paths: string[]): HarnessConfig {
  return {
    settings: { pi: { workerExtensions: paths } },
    states: {}
  } as unknown as HarnessConfig;
}

function state(requiredTools: SDLCState['requiredTools']): SDLCState {
  return {
    id: 's', identity: { role: 'r', expertise: 'e', constraints: [] } as never,
    actions: [], transitions: {}, requiredTools
  } as SDLCState;
}

describe('AC2 — coordinator loads pi.workerExtensions in the GATE process', () => {
  it('registers the fixture extension verify() in this (gate) process', async () => {
    expect(verifier.has(FIXTURE_TOOL)).toBe(false);

    // Primary extension path is the coordinator's own extension — it is SKIPPED
    // for import (already loaded); only the configured worker extension loads.
    const primary = path.join('src', 'extension.ts');
    const result = await loadCoordinatorWorkerExtensions(
      configWithWorkerExtensions([FIXTURE_EXTENSION]),
      projectRoot,
      primary
    );

    expect(result.loaded.some(p => p.endsWith('verify-extension.ts'))).toBe(true);
    // The verifier registry is non-empty IN THE GATE PROCESS after the load.
    expect(verifier.has(FIXTURE_TOOL)).toBe(true);
    expect(verifier.names()).toContain(FIXTURE_TOOL);
  });

  it('a failing extension import degrades (recorded in failed) without throwing', async () => {
    const result = await loadCoordinatorWorkerExtensions(
      configWithWorkerExtensions([FIXTURE_EXTENSION]),
      projectRoot,
      path.join('src', 'extension.ts'),
      async () => { throw new Error('boom import'); }
    );
    expect(result.loaded).toHaveLength(0);
    expect(result.failed[0].error).toContain('boom import');
  });
});

describe('AC4 — config fail-fast for verify()-expecting required tools', () => {
  it('throws NAMING the offending tool when expectsVerify:true has no registered callback', () => {
    const config = {
      states: { Impl: state([{ name: 'needs_verify_xyz', expectsVerify: true }]) }
    } as unknown as HarnessConfig;

    expect(() => validateRequiredToolVerifiers(config, { has: () => false }))
      .toThrowError(/needs_verify_xyz/);
  });

  it('presence-only tools (string form, or object without the flag) load cleanly', () => {
    const config = {
      states: {
        Impl: state(['ast_grep', { name: 'codemap' }, { name: 'opt', expectsVerify: false }])
      }
    } as unknown as HarnessConfig;
    // No callbacks registered at all (registry.has === false) — must NOT throw.
    expect(() => validateRequiredToolVerifiers(config, { has: () => false })).not.toThrow();
  });

  it('passes when the verify()-expecting tool DOES resolve to a registered callback', () => {
    const config = {
      states: { Impl: state([{ name: 'present_tool', expectsVerify: true }]) }
    } as unknown as HarnessConfig;
    expect(() => validateRequiredToolVerifiers(config, { has: (n: string) => n === 'present_tool' })).not.toThrow();
  });

  it('inspects ACTION-level requiredTools too', () => {
    const s = state(undefined);
    s.actions = [{ id: 'a', type: 'agent' as never, requiredTools: [{ name: 'action_needs_verify', expectsVerify: true }] }];
    const config = { states: { Impl: s } } as unknown as HarnessConfig;
    expect(() => validateRequiredToolVerifiers(config, { has: () => false })).toThrowError(/action_needs_verify/);
  });
});
