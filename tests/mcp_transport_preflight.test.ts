/**
 * s3wp.32 — MCP transport preflight + collapsed health + no per-worker rediscovery.
 *
 * Tests:
 *  1. checkMcpBridgeHealth with a simulated module-load failure:
 *     - recordEvent is called exactly ONCE for a unique failure key
 *     - repeated calls with the same failure reuse cached result (no new events)
 *     - affectedToolNames are accumulated correctly across calls
 *  2. mcpBackedRequiredToolNames correctly filters to MCP-type tools only
 *  3. Supervisor spawn gating:
 *     - beads whose required MCP tools are unhealthy are NOT spawned
 *     - beads with no MCP required tools are spawned normally
 *     - the spawnTeammateInTmux call count confirms no per-worker rediscovery
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  checkMcpBridgeHealth,
  mcpBackedRequiredToolNames,
  resetMcpBridgeHealthCache,
  setBridgeProbeForTest
} from '../src/core/McpTransportPreflight.js';
import { Supervisor } from '../src/core/Supervisor.js';
import { fakeProjectionStore } from './support/fakeProjectionStore.js';
import { DomainEventName, ProjectToolType } from '../src/constants/index.js';
import type { Clock } from '../src/core/Clock.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function failingProbe(message = "Cannot find module '@modelcontextprotocol/sdk/dist/cjs/dist/cjs/client/index.js'") {
  return async () => ({
    ok: false as const,
    errorMessage: message,
    errorType: 'Error'
  });
}

function passingProbe() {
  return async () => ({ ok: true as const });
}

// ── McpTransportPreflight unit tests ──────────────────────────────────────────

describe('s3wp.32 — McpTransportPreflight', () => {
  beforeEach(() => {
    resetMcpBridgeHealthCache();
    setBridgeProbeForTest(undefined);
  });

  afterEach(() => {
    resetMcpBridgeHealthCache();
    setBridgeProbeForTest(undefined);
  });

  it('returns healthy when the bridge probe succeeds', async () => {
    setBridgeProbeForTest(passingProbe());
    const recordEvent = vi.fn(async () => {});
    const health = await checkMcpBridgeHealth(['codemap', 'python_lsp'], recordEvent);

    expect(health.healthy).toBe(true);
    expect(health.affectedToolNames).toEqual([]);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('returns unhealthy with affected tool names when bridge probe fails', async () => {
    setBridgeProbeForTest(failingProbe());
    const recordEvent = vi.fn(async () => {});
    const health = await checkMcpBridgeHealth(['codemap', 'python_lsp'], recordEvent);

    expect(health.healthy).toBe(false);
    expect(health.affectedToolNames).toEqual(expect.arrayContaining(['codemap', 'python_lsp']));
    expect(health.message).toBeDefined();
    expect(health.remediation).toBeDefined();
  });

  it('records the domain event exactly ONCE per unique failure — no per-worker spam', async () => {
    setBridgeProbeForTest(failingProbe());
    const recordEvent = vi.fn(async () => {});

    // Simulate 3 workers all discovering the same failure
    await checkMcpBridgeHealth(['codemap'], recordEvent);
    await checkMcpBridgeHealth(['python_lsp'], recordEvent);
    await checkMcpBridgeHealth(['reference_docs'], recordEvent);

    // Only ONE event recorded regardless of how many times it is called
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it('accumulates affected tool names across repeated unhealthy calls', async () => {
    setBridgeProbeForTest(failingProbe());
    const recordEvent = vi.fn(async () => {});

    await checkMcpBridgeHealth(['codemap'], recordEvent);
    const health2 = await checkMcpBridgeHealth(['python_lsp'], recordEvent);
    const health3 = await checkMcpBridgeHealth(['reference_docs'], recordEvent);

    // Latest result includes all tool names seen since the first failure
    expect(health3.affectedToolNames).toEqual(
      expect.arrayContaining(['codemap', 'python_lsp', 'reference_docs'])
    );
    // Still only one event
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it('returns empty affected tools when no tools are passed', async () => {
    setBridgeProbeForTest(failingProbe()); // probe never runs
    const recordEvent = vi.fn(async () => {});
    const health = await checkMcpBridgeHealth([], recordEvent);

    expect(health.healthy).toBe(true);
    expect(health.affectedToolNames).toEqual([]);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('resets correctly: after resetMcpBridgeHealthCache a new probe is issued', async () => {
    setBridgeProbeForTest(failingProbe());
    const recordEvent1 = vi.fn(async () => {});
    await checkMcpBridgeHealth(['codemap'], recordEvent1);
    expect(recordEvent1).toHaveBeenCalledTimes(1);

    // Reset cache + change probe to passing
    resetMcpBridgeHealthCache();
    setBridgeProbeForTest(passingProbe());

    const recordEvent2 = vi.fn(async () => {});
    const health2 = await checkMcpBridgeHealth(['codemap'], recordEvent2);

    expect(health2.healthy).toBe(true);
    expect(recordEvent2).not.toHaveBeenCalled();
  });
});

// ── mcpBackedRequiredToolNames utility ────────────────────────────────────────

describe('s3wp.32 — mcpBackedRequiredToolNames', () => {
  const projectTools = [
    { name: 'codemap', type: ProjectToolType.MCP },
    { name: 'python_lsp', type: ProjectToolType.MCP },
    { name: 'run_quality_checks', type: ProjectToolType.COMMAND },
    { name: 'artifact_validator', type: ProjectToolType.COMMAND }
  ];

  it('filters required tools to MCP-backed tools only', () => {
    const result = mcpBackedRequiredToolNames(
      ['codemap', 'run_quality_checks', 'python_lsp'],
      projectTools
    );
    expect(result).toEqual(expect.arrayContaining(['codemap', 'python_lsp']));
    expect(result).not.toContain('run_quality_checks');
  });

  it('returns empty when no required tools match MCP type', () => {
    const result = mcpBackedRequiredToolNames(
      ['run_quality_checks', 'artifact_validator'],
      projectTools
    );
    expect(result).toEqual([]);
  });

  it('returns empty when required tools list is empty', () => {
    const result = mcpBackedRequiredToolNames([], projectTools);
    expect(result).toEqual([]);
  });

  it('returns empty when project tool config is empty', () => {
    const result = mcpBackedRequiredToolNames(['codemap'], []);
    expect(result).toEqual([]);
  });
});

// ── Supervisor spawn gating ───────────────────────────────────────────────────

function createFakeClock(nowMs = Date.now()): Clock {
  return { now: () => nowMs, date: (ts?: number) => new Date(ts === undefined ? nowMs : ts) };
}

function buildSupervisorForMcpGating(options: {
  backlogBeads: Array<{ id: string; status: string; stateId: string }>;
  requiredToolsForState?: string[];
  bridgeProbe: () => Promise<{ ok: boolean; errorMessage?: string; errorType?: string }>;
}) {
  const { backlogBeads, requiredToolsForState = [], bridgeProbe } = options;
  const clock = createFakeClock();
  const spawnTeammateInTmux = vi.fn(async () => ({ success: true, paneId: '%1' }));
  const records: Array<{ event: string; data: any }> = [];

  const config = {
    settings: {
      harnessRestartEvent: 'HARNESS_RESTART',
      teammateNoProgressTimeoutMs: 1
    },
    tools: requiredToolsForState.length > 0
      ? [{ name: requiredToolsForState[0], type: ProjectToolType.MCP, server: 'test-server' }]
      : [],
    states: {
      Planning: {
        identity: { role: 'Planner', expertise: 'Planning', constraints: [] },
        baseInstructions: 'Plan',
        actions: [{ id: 'formulate-plan', type: 'prompt', prompt: 'Plan', requiredTools: [] }],
        requiredTools: requiredToolsForState,
        transitions: { SUCCESS: 'completed', FAILURE: 'Planning' }
      }
    }
  };

  const beadsPort = {
    ready: vi.fn(async () => backlogBeads.filter(b => b.status === 'ready')),
    list: vi.fn(async () => ({ items: backlogBeads })),
    getBead: vi.fn(async (id: string) => backlogBeads.find(b => b.id === id) ?? { id }),
    claim: vi.fn(async ({ id }: { id: string }) => ({ id } as any)),
    release: vi.fn(async () => {}),
    invalidateCache: vi.fn()
  };

  const supervisor = new Supervisor(
    {} as any,
    { hasUI: false } as any,
    { getHeartbeatSnapshot: () => [] } as any,
    {
      getLiveTeammateBeadIds: vi.fn(async () => new Set<string>()),
      terminateTeammatesForBead: vi.fn(async () => ({ terminatedPaneIds: [] })),
      captureBeadPaneText: vi.fn(async () => ''),
      getActiveTeammateCount: vi.fn(async () => 0),
      getAvailableSlots: vi.fn(async () => 5),
      spawnTeammateInTmux
    } as any,
    { tracedAsync: (_name: string, _attrs: any, fn: any) => fn } as any,
    {
      configLoader: { load: async () => config },
      eventStore: fakeProjectionStore({
        record: vi.fn(async (event: string, data: unknown) => { records.push({ event, data }); })
      }),
      beadsPort,
      worktreePort: { createWorktree: vi.fn(async () => ({ success: true, path: '/tmp/wt' })) },
      scheduler: {
        sortBacklog: vi.fn(async (beads: any[]) => beads.map((b, i) => ({
          ...b,
          stateId: b.status === 'ready' ? 'Planning' : 'Planning',
          score: i
        })))
      },
      flowManager: {
        stateForBead: vi.fn((bead: any) => 'Planning')
      },
      projectRoot: '/tmp/project'
    } as any,
    { maxSlots: 5, clock }
  );

  // Inject the bridge probe
  setBridgeProbeForTest(bridgeProbe);

  return { supervisor, spawnTeammateInTmux, records };
}

describe('s3wp.32 — Supervisor MCP spawn gating', () => {
  beforeEach(() => {
    resetMcpBridgeHealthCache();
    setBridgeProbeForTest(undefined);
  });

  afterEach(() => {
    resetMcpBridgeHealthCache();
    setBridgeProbeForTest(undefined);
  });

  it('spawns beads normally when required MCP tools have a healthy bridge', async () => {
    const backlogBeads = [
      { id: 'bd-healthy-1', status: 'ready', stateId: 'Planning' },
      { id: 'bd-healthy-2', status: 'ready', stateId: 'Planning' }
    ];
    const { supervisor, spawnTeammateInTmux } = buildSupervisorForMcpGating({
      backlogBeads,
      requiredToolsForState: ['codemap'],
      bridgeProbe: passingProbe()
    });

    await (supervisor as any).scanAndSpawn();

    // Both beads should be spawned since bridge is healthy
    expect(spawnTeammateInTmux).toHaveBeenCalledTimes(2);
  });

  it('does NOT spawn beads into states with unavailable MCP required tools', async () => {
    const backlogBeads = [
      { id: 'bd-mcp-1', status: 'ready', stateId: 'Planning' },
      { id: 'bd-mcp-2', status: 'ready', stateId: 'Planning' }
    ];
    const { supervisor, spawnTeammateInTmux, records } = buildSupervisorForMcpGating({
      backlogBeads,
      requiredToolsForState: ['codemap'],
      bridgeProbe: failingProbe()
    });

    await (supervisor as any).scanAndSpawn();

    // NO beads should be spawned — bridge is unhealthy
    expect(spawnTeammateInTmux).not.toHaveBeenCalled();

    // Domain event recorded exactly ONCE (collapsed, not per-bead)
    const prefailEvents = records.filter(r => r.event === DomainEventName.MCP_TRANSPORT_PREFLIGHT_FAILED);
    expect(prefailEvents.length).toBe(1);
  });

  it('records MCP preflight failure exactly once across multiple spawn attempts — no per-worker rediscovery', async () => {
    // Two scan cycles with three beads each — the same failure should generate
    // exactly one event total, not one per bead or per cycle.
    const backlogBeads = [
      { id: 'bd-a', status: 'ready', stateId: 'Planning' },
      { id: 'bd-b', status: 'ready', stateId: 'Planning' },
      { id: 'bd-c', status: 'ready', stateId: 'Planning' }
    ];
    const { supervisor, spawnTeammateInTmux, records } = buildSupervisorForMcpGating({
      backlogBeads,
      requiredToolsForState: ['codemap'],
      bridgeProbe: failingProbe()
    });

    // Run two scan cycles
    await (supervisor as any).scanAndSpawn();
    await (supervisor as any).scanAndSpawn();

    // No workers spawned in either cycle
    expect(spawnTeammateInTmux).not.toHaveBeenCalled();

    // Exactly ONE preflight-failed event across all cycles
    const prefailEvents = records.filter(r => r.event === DomainEventName.MCP_TRANSPORT_PREFLIGHT_FAILED);
    expect(prefailEvents.length).toBe(1);
  });

  it('spawns beads that have no MCP required tools even when bridge is unhealthy', async () => {
    const backlogBeads = [
      { id: 'bd-no-mcp', status: 'ready', stateId: 'Planning' }
    ];
    const { supervisor, spawnTeammateInTmux } = buildSupervisorForMcpGating({
      backlogBeads,
      requiredToolsForState: [], // No MCP required tools
      bridgeProbe: failingProbe() // Bridge would fail if checked
    });

    await (supervisor as any).scanAndSpawn();

    // Bead should be spawned — it has no MCP required tools so bridge is not checked
    expect(spawnTeammateInTmux).toHaveBeenCalledTimes(1);
  });
});
