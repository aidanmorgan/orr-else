/**
 * State context policy tests (pi-experiment-6q0y.44).
 *
 * Encodes the invariants:
 *   1. resolveStateContextPolicy defaults to freshSubagent when contextPolicy is absent.
 *   2. resolveStateContextPolicy returns namedContinuation + contextKey for structured declarations.
 *   3. resolveStateContextPolicy normalises string shorthand to the typed shape.
 *   4. ConfigLoader rejects: unknown mode, namedContinuation without contextKey,
 *      contextKey with invalid characters.
 *   5. REAL COORDINATOR SPAWN PATH: Supervisor passes spawnOptions.contextKey to
 *      spawnTeammateInTmux when the state's policy is namedContinuation (load-bearing:
 *      removing the wiring makes this test fail).
 *   6. Supervisor passes no spawnOptions for freshSubagent states (default).
 *   7. Cerdiwen golden: states without contextPolicy load cleanly (default-fresh keeps
 *      cerdiwen unaffected).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  resolveStateContextPolicy,
  type ContextKeyRecord
} from '../src/extension/CoordinatorController.js';
import { StateContextPolicy } from '../src/constants/domain.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import type { BeadsPort, WorktreePort } from '../src/core/OrchestrationPorts.js';

import { Supervisor } from '../src/core/Supervisor.js';
import { fakeProjectionStore } from './support/fakeProjectionStore.js';

// Shared orchestrator mock — injected directly into Supervisor options
// (pi-experiment-amq0.2: no vi.mock needed; orchestrator is now a required inject).
const orchestratorMock = {
  selectAssignments: vi.fn()
};

function fakeOrchestrator() {
  return orchestratorMock as any;
}

function fakeRetentionScheduler() {
  return { runIfDue: vi.fn(async () => {}) } as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper builders
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(stateOverrides: Record<string, unknown> = {}): HarnessConfig {
  return {
    settings: {
      maxConcurrentSlots: 2,
      handoverTemplate: 'test',
      defaultModel: 'model-x',
      defaultProvider: 'openai',
      agentTurnTimeoutMs: 3600000,
      processReapIntervalMs: 60000,
      startState: 'Alpha',
      harnessRestartEvent: 'HARNESS_RESTART',
      contextRestartEvent: 'CONTEXT_RESTART',
      worktreePolicy: { default: 'always' },
      modelProviders: {},
      stateContextRotThreshold: 10,
      harnessContextRotThreshold: 5
    },
    scheduler: { weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 } },
    states: stateOverrides
  } as unknown as HarnessConfig;
}

const NOW_MS = Date.parse('2026-01-02T03:04:05.000Z');

function fakeBeadsPort(overrides: Partial<BeadsPort> = {}): BeadsPort {
  return {
    ready: vi.fn(async () => []),
    list: vi.fn(async () => ({ items: [] })),
    getBead: vi.fn(async (id) => ({ id } as any)),
    claim: vi.fn(async ({ id }: { id: string }) => ({ id } as any)),
    release: vi.fn(async () => {}),
    invalidateCache: vi.fn(),
    ...overrides
  };
}

function fakeWorktreePort(overrides: Partial<WorktreePort> = {}): WorktreePort {
  return {
    createWorktree: vi.fn(async () => ({ success: true, path: '/tmp/worktree' })),
    ...overrides
  };
}

function buildSupervisor(
  configOverride: Record<string, unknown>,
  {
    spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%1' })),
    claim = vi.fn(async ({ id }: { id: string }) => ({ id } as any)),
  } = {}
) {
  const records: Array<{ event: string; data: unknown }> = [];
  const supervisor = new Supervisor(
    {} as any,
    { hasUI: false } as any,
    { getHeartbeatSnapshot: () => [] } as any,
    {
      getLiveTeammateBeadIds: vi.fn(async () => new Set()),
      getAvailableSlots: vi.fn(async () => 2),
      getActiveTeammateCount: vi.fn(async () => 0),
      spawnTeammateInTmux
    } as any,
    { tracedAsync: (_name: string, _attrs: unknown, fn: () => unknown) => fn } as any,
    {
      configLoader: { load: async () => configOverride },
      flowManager: {},
      scheduler: {},
      eventStore: fakeProjectionStore({
        record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); })
      }),
      beadsPort: fakeBeadsPort({ claim }),
      worktreePort: fakeWorktreePort(),
      projectRoot: '/project/root'
    } as any,
    { maxSlots: 2, clock: { now: () => NOW_MS, date: () => new Date(NOW_MS) }, orchestrator: fakeOrchestrator(), retentionScheduler: fakeRetentionScheduler() }
  );
  return { supervisor, records, spawnTeammateInTmux };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. resolveStateContextPolicy — pure function tests
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveStateContextPolicy — pure policy resolver', () => {
  it('defaults to freshSubagent when contextPolicy is absent', () => {
    const config = makeConfig({ Alpha: { actions: [], transitions: {} } });
    const result = resolveStateContextPolicy('Alpha', config);
    expect(result.mode).toBe(StateContextPolicy.FRESH_SUBAGENT);
    expect(result.contextKey).toBeUndefined();
  });

  it('defaults to freshSubagent for an unknown stateId', () => {
    const config = makeConfig({});
    const result = resolveStateContextPolicy('UnknownState', config);
    expect(result.mode).toBe(StateContextPolicy.FRESH_SUBAGENT);
  });

  it('resolves string shorthand freshSubagent', () => {
    const config = makeConfig({ Alpha: { contextPolicy: 'freshSubagent', actions: [], transitions: {} } });
    const result = resolveStateContextPolicy('Alpha', config);
    expect(result.mode).toBe(StateContextPolicy.FRESH_SUBAGENT);
    expect(result.contextKey).toBeUndefined();
  });

  it('resolves structured freshSubagent (mode only, no contextKey)', () => {
    const config = makeConfig({ Alpha: { contextPolicy: { mode: 'freshSubagent' }, actions: [], transitions: {} } });
    const result = resolveStateContextPolicy('Alpha', config);
    expect(result.mode).toBe(StateContextPolicy.FRESH_SUBAGENT);
    expect(result.contextKey).toBeUndefined();
  });

  it('resolves structured namedContinuation with contextKey', () => {
    const config = makeConfig({
      Beta: {
        contextPolicy: { mode: 'namedContinuation', contextKey: 'planCtx' },
        actions: [],
        transitions: {}
      }
    });
    const result = resolveStateContextPolicy('Beta', config);
    expect(result.mode).toBe(StateContextPolicy.NAMED_CONTINUATION);
    expect(result.contextKey).toBe('planCtx');
  });

  it('resolves structured namedContinuation without contextKey as namedContinuation (no key)', () => {
    // The pure resolver does not throw — ConfigLoader is responsible for rejecting this.
    // The resolver returns mode=NAMED_CONTINUATION with no contextKey.
    const config = makeConfig({
      Beta: {
        contextPolicy: { mode: 'namedContinuation' },
        actions: [],
        transitions: {}
      }
    });
    const result = resolveStateContextPolicy('Beta', config);
    expect(result.mode).toBe(StateContextPolicy.NAMED_CONTINUATION);
    expect(result.contextKey).toBeUndefined();
  });

  it('resolves an unrecognised string mode to freshSubagent (lint catches it, resolver is lenient)', () => {
    const config = makeConfig({ Alpha: { contextPolicy: 'continueSameSession', actions: [], transitions: {} } });
    const result = resolveStateContextPolicy('Alpha', config);
    expect(result.mode).toBe(StateContextPolicy.FRESH_SUBAGENT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ConfigLoader lint — invalid policy declarations rejected at startup
// ─────────────────────────────────────────────────────────────────────────────

describe('ConfigLoader state context policy lint', () => {
  const tempPath = path.join(process.cwd(), 'temp_ctx_policy_test.yaml');

  afterEach(() => {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  });

  function minimalYaml(statesBlock: string): string {
    return `
settings:
  maxConcurrentSlots: 2
  handoverTemplate: "test"
  defaultModel: "m1"
  startState: Alpha
  worktreePolicy:
    default: always
scheduler:
  weights: { waitTime: 1, executionTime: 1, progress: 1, penalty: 1 }
statechart:
  terminalStates: [done]
  advanceOutcomes: [SUCCESS]
  failedOutcomes: [FAILURE]
  blockedOutcomes: [BLOCKED]
states:
  Alpha:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: done }
${statesBlock}
`;
  }

  it('loads cleanly when contextPolicy is absent (default freshSubagent)', () => {
    fs.writeFileSync(tempPath, minimalYaml(''));
    const loader = new ConfigLoader();
    expect(() => loader.load(tempPath)).not.toThrow();
  });

  it('loads cleanly for contextPolicy: freshSubagent string shorthand', () => {
    fs.writeFileSync(tempPath, minimalYaml(`  Beta:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    contextPolicy: freshSubagent
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: done }
`));
    const loader = new ConfigLoader();
    expect(() => loader.load(tempPath)).not.toThrow();
  });

  it('loads cleanly for contextPolicy: { mode: namedContinuation, contextKey: "planCtx" }', () => {
    fs.writeFileSync(tempPath, minimalYaml(`  Beta:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    contextPolicy:
      mode: namedContinuation
      contextKey: planCtx
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: done }
`));
    const loader = new ConfigLoader();
    expect(() => loader.load(tempPath)).not.toThrow();
  });

  it('rejects unknown contextPolicy mode string', () => {
    fs.writeFileSync(tempPath, minimalYaml(`  Beta:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    contextPolicy: continueSameSession
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: done }
`));
    const loader = new ConfigLoader();
    // Schema catches unknown mode values via enum validation before semantic lint runs.
    expect(() => loader.load(tempPath)).toThrow(/Configuration validation failed|not a recognised mode/);
  });

  it('rejects contextPolicy: namedContinuation string shorthand (no contextKey provided)', () => {
    fs.writeFileSync(tempPath, minimalYaml(`  Beta:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    contextPolicy: namedContinuation
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: done }
`));
    const loader = new ConfigLoader();
    expect(() => loader.load(tempPath)).toThrow(/without a contextKey/);
  });

  it('rejects contextPolicy: { mode: namedContinuation } without contextKey', () => {
    fs.writeFileSync(tempPath, minimalYaml(`  Beta:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    contextPolicy:
      mode: namedContinuation
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: done }
`));
    const loader = new ConfigLoader();
    expect(() => loader.load(tempPath)).toThrow(/contextKey is missing or empty/);
  });

  it('rejects contextPolicy.contextKey with invalid characters', () => {
    fs.writeFileSync(tempPath, minimalYaml(`  Beta:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    contextPolicy:
      mode: namedContinuation
      contextKey: "plan ctx!"
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: done }
`));
    const loader = new ConfigLoader();
    expect(() => loader.load(tempPath)).toThrow(/invalid characters/);
  });

  it('rejects contextPolicy object without a mode field', () => {
    fs.writeFileSync(tempPath, minimalYaml(`  Beta:
    identity: { role: "R", expertise: "E", constraints: [] }
    baseInstructions: "i"
    contextPolicy:
      contextKey: planCtx
    actions:
      - id: a1
        type: prompt
    transitions: { SUCCESS: done }
`));
    const loader = new ConfigLoader();
    // Schema catches missing 'mode' via required property validation before semantic lint.
    expect(() => loader.load(tempPath)).toThrow(/Configuration validation failed|missing the required "mode" field/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. REAL COORDINATOR SPAWN PATH — policy changes spawn/continuation behaviour
//    (load-bearing: removing wiring makes these tests fail)
// ─────────────────────────────────────────────────────────────────────────────

describe('Supervisor context policy — real coordinator spawn path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('freshSubagent state (default) — spawnTeammateInTmux receives no spawnOptions', async () => {
    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-fresh', stateId: 'Alpha', score: 1, status: 'ready' }
    ]);

    const { supervisor, spawnTeammateInTmux } = buildSupervisor({
      settings: { worktreePolicy: { default: 'always' } },
      states: { Alpha: {} }
    });

    await (supervisor as any).scanAndSpawn();

    // freshSubagent: no spawnOptions argument (5th param is undefined)
    expect(spawnTeammateInTmux).toHaveBeenCalledTimes(1);
    const [, , , , spawnOptions] = spawnTeammateInTmux.mock.calls[0];
    expect(spawnOptions).toBeUndefined();
  });

  it('namedContinuation state — spawnTeammateInTmux receives spawnOptions with contextKey when context is stored', async () => {
    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-cont', stateId: 'Beta', score: 1, status: 'ready' }
    ]);

    const { supervisor, spawnTeammateInTmux } = buildSupervisor({
      settings: { worktreePolicy: { default: 'always' } },
      states: {
        Beta: {
          contextPolicy: { mode: 'namedContinuation', contextKey: 'planCtx' }
        }
      }
    });

    // Pre-seed the context key store with a ContextKeyRecord (simulates a prior state having produced 'planCtx').
    // beadId must match the consuming bead ('bead-cont') and digest must match real config.
    const digest = (supervisor as any).spawnCoordinator.computeConfigDigest() as string;
    const planCtxRecord: ContextKeyRecord = {
      piSessionPath: 'prior-session-id-abc',
      beadId: 'bead-cont',
      sourceStateId: 'Beta',
      sourceActionId: '',
      configDigest: digest,
      terminal: false
    };
    (supervisor as any).spawnCoordinator.contextKeyStore.set('planCtx', planCtxRecord);

    await (supervisor as any).scanAndSpawn();

    expect(spawnTeammateInTmux).toHaveBeenCalledTimes(1);
    const [, , , , spawnOptions] = spawnTeammateInTmux.mock.calls[0];
    // namedContinuation with a stored context: spawnOptions carries contextKey
    expect(spawnOptions).toEqual({ contextKey: 'prior-session-id-abc' });
  });

  it('namedContinuation state — no spawnOptions when no prior context is stored', async () => {
    orchestratorMock.selectAssignments.mockResolvedValue([
      { id: 'bead-no-prior', stateId: 'Beta', score: 1, status: 'ready' }
    ]);

    const { supervisor, spawnTeammateInTmux } = buildSupervisor({
      settings: { worktreePolicy: { default: 'always' } },
      states: {
        Beta: {
          contextPolicy: { mode: 'namedContinuation', contextKey: 'planCtx' }
        }
      }
    });
    // contextKeyStore is empty — no prior context for 'planCtx'

    await (supervisor as any).scanAndSpawn();

    expect(spawnTeammateInTmux).toHaveBeenCalledTimes(1);
    const [, , , , spawnOptions] = spawnTeammateInTmux.mock.calls[0];
    // No stored prior context → no spawnOptions passed
    expect(spawnOptions).toBeUndefined();
  });

  it('distinguishes freshSubagent vs namedContinuation across two beads', async () => {
    // First bead: freshSubagent (Alpha)
    orchestratorMock.selectAssignments
      .mockResolvedValueOnce([{ id: 'bead-alpha', stateId: 'Alpha', score: 2, status: 'ready' }])
      .mockResolvedValueOnce([{ id: 'bead-beta', stateId: 'Beta', score: 1, status: 'ready' }]);

    const config = {
      settings: { worktreePolicy: { default: 'always' } },
      states: {
        Alpha: {},
        Beta: { contextPolicy: { mode: 'namedContinuation', contextKey: 'alphaCtx' } }
      }
    };

    // Alpha: no prior context stored
    const { supervisor: s1, spawnTeammateInTmux: spawn1 } = buildSupervisor(config);
    await (s1 as any).scanAndSpawn();
    const [, , , , opts1] = spawn1.mock.calls[0];
    expect(opts1).toBeUndefined(); // freshSubagent

    // Beta: alphaCtx stored as a full ContextKeyRecord (AC7 format).
    // beadId must match the consuming bead ('bead-beta') for the beadId check to pass.
    const { supervisor: s2, spawnTeammateInTmux: spawn2 } = buildSupervisor(config);
    const digest2 = (s2 as any).spawnCoordinator.computeConfigDigest() as string;
    const alphaCtxRecord: ContextKeyRecord = {
      piSessionPath: 'alpha-session-xyz',
      beadId: 'bead-beta',
      sourceStateId: 'Beta',
      sourceActionId: '',
      configDigest: digest2,
      terminal: false
    };
    (s2 as any).spawnCoordinator.contextKeyStore.set('alphaCtx', alphaCtxRecord);
    await (s2 as any).scanAndSpawn();
    const [, , , , opts2] = spawn2.mock.calls[0];
    expect(opts2).toEqual({ contextKey: 'alpha-session-xyz' }); // namedContinuation
  });
});
