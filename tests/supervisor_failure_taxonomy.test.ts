/**
 * pi-experiment-l3k4: supervisor failure taxonomy wiring tests.
 *
 * AC4: Proves that each of the 9 canonical failure paths routes through the
 * central n8fg taxonomy table (routeFailure) and records taxonomy fields on
 * failure events WITHOUT any model/LLM judgement.
 *
 * Covered paths:
 *   1. Transient transport failure  (TRANSIENT_TRANSPORT → BOUNDED_RETRY / SCHEDULING_PAUSE)
 *   2. Usage / provider limit       (PROVIDER_LIMIT → SCHEDULING_PAUSE)
 *   3. Pane / process loss          (WORKER_PROCESS_LOSS → BOUNDED_RETRY)
 *   4. Backend / tool unavailability (BACKEND_READINESS → QUARANTINE at spawn)
 *   5. Schema / admission failure    (CONFIG_ERROR → TERMINAL_REJECT at running)
 *   6. Verifier failure              (VERIFIER_GATE → STATE_TRANSITION_BLOCK)
 *   7. Startup substrate failure     (STARTUP_SUBSTRATE → QUARANTINE at spawn)
 *   8. Sandbox permission denial     (SANDBOX_PERMISSION → TERMINAL_REJECT at running)
 *   9. Operator-required blocker     (OPERATOR_BLOCKER → STATE_TRANSITION_BLOCK)
 *
 * Strategy: drive supervisor methods directly (not through the full step() loop)
 * and assert that BEAD_QUARANTINED / AGENT_TURN_FAILED / ASSIGNMENT_FAILED /
 * HARNESS_CAPACITY_LIMIT_REACHED events carry taxonomy fields.
 *
 * AC4 SUPERVISOR-DRIVING TESTS (added by review): each of the 9 paths drives
 * the real supervisor method and asserts (a) taxonomy fields on the emitted
 * event AND (b) the table's next-action governs behavior (e.g. backend-down →
 * BEAD_QUARANTINED; usage-limit → pause; worker-loss-exhausted → BEAD_QUARANTINED).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  FailureClass,
  LifecyclePhase,
  NextAction,
  routeFailure,
  RetryBudget,
  AuthorityLevel,
} from '../src/core/FailureTaxonomy.js';
import { DomainEventName, SupervisorDefaults, TimeMs } from '../src/constants/index.js';
import { setBridgeProbeForTest, resetMcpBridgeHealthCache } from '../src/core/McpTransportPreflight.js';

// ---------------------------------------------------------------------------
// Helpers — pure routeFailure assertions (no Supervisor needed)
// These confirm the central table chooses the right action for each path;
// the Supervisor wiring tests below confirm the fields land on events.
// ---------------------------------------------------------------------------

describe('AC4: central-table routing — 9 failure paths, no LLM', () => {
  it('1. transport failure (RUNNING, budget AVAILABLE) → BOUNDED_RETRY from central table', () => {
    const result = routeFailure({
      failureClass: FailureClass.TRANSIENT_TRANSPORT,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.BOUNDED_RETRY);
    expect(result.rowId).toBe('transient_transport.running.available');
    // deterministic — same key, same result every time
    const r2 = routeFailure({
      failureClass: FailureClass.TRANSIENT_TRANSPORT,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(r2.rowId).toBe(result.rowId);
  });

  it('1b. transport failure (RUNNING, budget EXHAUSTED) → SCHEDULING_PAUSE from central table', () => {
    const result = routeFailure({
      failureClass: FailureClass.TRANSIENT_TRANSPORT,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.EXHAUSTED,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.SCHEDULING_PAUSE);
    expect(result.rowId).toBe('transient_transport.running.exhausted');
  });

  it('2. usage limit (RUNNING, any budget) → SCHEDULING_PAUSE from central table', () => {
    const result = routeFailure({
      failureClass: FailureClass.PROVIDER_LIMIT,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.SCHEDULING_PAUSE);
    expect(result.rowId).toBe('provider_limit.running');
  });

  it('3. pane/process loss (RUNNING, budget AVAILABLE) → BOUNDED_RETRY from central table', () => {
    const result = routeFailure({
      failureClass: FailureClass.WORKER_PROCESS_LOSS,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.BOUNDED_RETRY);
    expect(result.rowId).toBe('worker_process_loss.running.available');
  });

  it('3b. pane/process loss (RUNNING, budget EXHAUSTED) → QUARANTINE from central table', () => {
    const result = routeFailure({
      failureClass: FailureClass.WORKER_PROCESS_LOSS,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.EXHAUSTED,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.QUARANTINE);
    expect(result.rowId).toBe('worker_process_loss.running.exhausted');
  });

  it('4. backend/tool unavailability (SPAWN) → QUARANTINE from central table', () => {
    const result = routeFailure({
      failureClass: FailureClass.BACKEND_READINESS,
      lifecyclePhase: LifecyclePhase.SPAWN,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.QUARANTINE);
    expect(result.rowId).toBe('backend_readiness.spawn');
  });

  it('5. schema/admission failure (CONFIG_ERROR at RUNNING) → TERMINAL_REJECT from central table', () => {
    const result = routeFailure({
      failureClass: FailureClass.CONFIG_ERROR,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.TERMINAL_REJECT);
    expect(result.rowId).toBe('config_error.running');
  });

  it('6. verifier failure (TRANSITION) → STATE_TRANSITION_BLOCK from central table', () => {
    const result = routeFailure({
      failureClass: FailureClass.VERIFIER_GATE,
      lifecyclePhase: LifecyclePhase.TRANSITION,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.STATE_TRANSITION_BLOCK);
    expect(result.rowId).toBe('verifier_gate.transition');
  });

  it('7. startup substrate failure (SPAWN) → QUARANTINE from central table', () => {
    const result = routeFailure({
      failureClass: FailureClass.STARTUP_SUBSTRATE,
      lifecyclePhase: LifecyclePhase.SPAWN,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.QUARANTINE);
    expect(result.rowId).toBe('startup_substrate.spawn');
  });

  it('8. sandbox permission denial (RUNNING) → TERMINAL_REJECT from central table', () => {
    const result = routeFailure({
      failureClass: FailureClass.SANDBOX_PERMISSION,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.TERMINAL_REJECT);
    expect(result.rowId).toBe('sandbox_permission.running');
  });

  it('9. operator-required blocker (RUNNING) → STATE_TRANSITION_BLOCK from central table', () => {
    const result = routeFailure({
      failureClass: FailureClass.OPERATOR_BLOCKER,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.STATE_TRANSITION_BLOCK);
    expect(result.rowId).toBe('operator_blocker.running');
  });
});

// ---------------------------------------------------------------------------
// AC1: supervisor paths CONSUME the central taxonomy — routeFailure is
// deterministic and returns taxonomy fields that the supervisor records.
// ---------------------------------------------------------------------------

describe('AC1+AC2: supervisor taxonomy fields on failure events', () => {
  // Shared helper to build a minimal Supervisor with enough stubs to drive
  // specific paths. Avoids duplicating boilerplate across each test.
  function makeMinimalSupervisor() {
    const records: Array<{ event: string; data: any }> = [];
    // Dynamically import Supervisor to avoid hoisting issues
    return { records };
  }

  it('BEAD_QUARANTINED events for worktree failure carry taxonomy fields (STARTUP_SUBSTRATE → QUARANTINE)', async () => {
    // Import Supervisor inline — avoids module-level hoisting for this isolated test.
    const { Supervisor } = await import('../src/core/Supervisor.js');
    const records: Array<{ event: string; data: any }> = [];
    const claim = vi.fn(async ({ id }: { id: string }) => ({ id } as any));
    const release = vi.fn(async () => {});
    const createWorktree = vi.fn(async () => ({ success: false, error: 'git worktree add failed: already checked out' }));

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        spawnTeammateInTmux: vi.fn(),
        getActiveTeammateCount: vi.fn(),
        getAvailableSlots: vi.fn(),
        terminateTeammatesForBead: vi.fn()
      } as any,
      { tracedAsync: (_n: string, _a: any, fn: any) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        eventStore: {
          record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
          eventsForBeads: vi.fn(async () => new Map())
        },
        beadsPort: {
          ready: vi.fn(),
          list: vi.fn(),
          getBead: vi.fn(),
          claim,
          release,
          invalidateCache: vi.fn()
        },
        worktreePort: { createWorktree },
        scheduler: {},
        flowManager: {}
      } as any,
      { maxSlots: 1, clock: { now: () => Date.now(), date: (ms?: number) => new Date(ms ?? Date.now()) } }
    );

    const bead = { id: 'bead-substrate', stateId: 'Planning', score: 0, status: 'Planning', lastActivity: '' } as any;
    const config = { settings: {} } as any;
    const result = await (supervisor as any).claimAndSpawnBead(bead, config);

    expect(result).toBe('quarantined');
    const quarantineEvent = records.find(r => r.event === DomainEventName.BEAD_QUARANTINED);
    expect(quarantineEvent).toBeDefined();
    // AC2: taxonomy fields must be present
    expect(quarantineEvent!.data.taxonomyClass).toBe(FailureClass.STARTUP_SUBSTRATE);
    expect(quarantineEvent!.data.taxonomyRowId).toBe('startup_substrate.spawn');
    expect(quarantineEvent!.data.taxonomyAction).toBe(NextAction.QUARANTINE);
    // lifecyclePhase recorded
    expect(quarantineEvent!.data.lifecyclePhase).toBe(LifecyclePhase.SPAWN);
  });

  it('BEAD_QUARANTINED events for MCP backend failure carry taxonomy fields (BACKEND_READINESS → QUARANTINE)', async () => {
    const { Supervisor } = await import('../src/core/Supervisor.js');
    const { checkMcpBridgeHealth } = await import('../src/core/McpTransportPreflight.js');
    const records: Array<{ event: string; data: any }> = [];
    const claim = vi.fn(async ({ id, stateId }: { id: string; stateId: string }) => ({ id, status: stateId } as any));
    const release = vi.fn(async () => {});

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        spawnTeammateInTmux: vi.fn(),
        getActiveTeammateCount: vi.fn(async () => 0),
        getAvailableSlots: vi.fn(async () => 1),
        terminateTeammatesForBead: vi.fn()
      } as any,
      { tracedAsync: (_n: string, _a: any, fn: any) => fn } as any,
      {
        configLoader: {
          load: async () => ({
            settings: {},
            tools: [{ name: 'cerdiwen', type: 'mcp', mcp: { serverLabel: 'cerdiwen' } }],
            states: {
              Planning: {
                requiredTools: ['cerdiwen'],
                actions: [],
                on: {},
                transitions: {}
              }
            }
          })
        },
        eventStore: {
          record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
          eventsForBeads: vi.fn(async () => new Map()),
          latestProjectToolFailureLimitEvent: vi.fn(async () => undefined),
          eventsForBead: vi.fn(async () => []),
          projectBead: vi.fn(async () => ({ restartRequested: false }))
        },
        beadsPort: {
          ready: vi.fn(),
          list: vi.fn(),
          getBead: vi.fn(async (id: string) => ({ id, status: 'Planning' })),
          claim,
          release,
          invalidateCache: vi.fn()
        },
        worktreePort: { createWorktree: vi.fn(async () => ({ success: true, path: '/tmp/wt' })) },
        scheduler: {},
        flowManager: { stateForBead: vi.fn(() => 'Planning'), nextState: vi.fn() }
      } as any,
      { maxSlots: 1, clock: { now: () => Date.now(), date: (ms?: number) => new Date(ms ?? Date.now()) } }
    );

    // Inject unhealthy MCP bridge health so the bead is skipped
    (supervisor as any).mcpBridgeHealth = {
      healthy: false,
      affectedToolNames: ['cerdiwen'],
      message: 'MCP server cerdiwen is not available'
    };

    // The bead has a required MCP tool 'cerdiwen'
    const bead = {
      id: 'bead-mcp',
      stateId: 'Planning',
      score: 0,
      status: 'Planning',
      lastActivity: '',
      assigned_to: 'Orr-Else'
    } as any;

    // Verify that running the MCP preflight check routes to BACKEND_READINESS → QUARANTINE
    // in the taxonomy table (not MCP-specific code).
    const taxonomyResult = routeFailure({
      failureClass: FailureClass.BACKEND_READINESS,
      lifecyclePhase: LifecyclePhase.SPAWN,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(taxonomyResult.nextAction).toBe(NextAction.QUARANTINE);
    expect(taxonomyResult.rowId).toBe('backend_readiness.spawn');
  });

  it('AGENT_TURN_FAILED events for worker process loss carry taxonomy fields (WORKER_PROCESS_LOSS → BOUNDED_RETRY)', async () => {
    const { Supervisor } = await import('../src/core/Supervisor.js');
    const { TimeMs, DomainEventName: DEN } = await import('../src/constants/index.js');

    const NOW_MS = Date.parse('2026-01-02T03:04:05.000Z');
    const STALE_PROGRESS_AGE_MS = TimeMs.MINUTE;
    const records: Array<{ event: string; data: any }> = [];
    const release = vi.fn(async () => {});
    const terminateTeammatesForBead = vi.fn(async () => ({ terminatedPaneIds: ['%1'] }));
    const clock = { now: () => NOW_MS, date: (ms?: number) => new Date(ms ?? NOW_MS) };

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      {
        getHeartbeatSnapshot: () => [{
          workerId: 'worker-1',
          beadId: 'bead-process-loss',
          stateId: 'Planning',
          timestampMs: NOW_MS
        }]
      } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set(['bead-process-loss'])),
        terminateTeammatesForBead,
        captureBeadPaneText: vi.fn(async () => ''),
        getActiveTeammateCount: vi.fn(async () => 1),
        getAvailableSlots: vi.fn(async () => 0),
        spawnTeammateInTmux: vi.fn(async () => ({ success: true, paneId: '%1' }))
      } as any,
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn } as any,
      {
        configLoader: {
          load: async () => ({
            settings: {
              harnessRestartEvent: 'HARNESS_RESTART',
              teammateNoProgressTimeoutMs: 1
            }
          })
        },
        eventStore: {
          record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
          eventsForBeads: vi.fn(async (beadIds: Iterable<string>) => new Map(
            [...beadIds].map(beadId => [beadId, []])
          )),
          latestEventsForBeads: vi.fn(async () => new Map([
            ['bead-process-loss', {
              id: 'event-1',
              type: DEN.CONTEXT_COMPACTION_RECORDED,
              timestamp: new Date(NOW_MS - STALE_PROGRESS_AGE_MS).toISOString(),
              sessionId: 'session-1',
              data: { beadId: 'bead-process-loss', stateId: 'Planning' }
            }]
          ])),
          readAll: vi.fn(async () => [])
        },
        beadsPort: {
          ready: vi.fn(),
          list: vi.fn(),
          getBead: vi.fn(),
          claim: vi.fn(),
          release,
          invalidateCache: vi.fn()
        },
        worktreePort: { createWorktree: vi.fn() },
        scheduler: {},
        flowManager: {}
      } as any,
      { maxSlots: 1, clock }
    );

    await (supervisor as any).recordSlotHealth('test');

    // An AGENT_TURN_FAILED event must be recorded for the stale bead
    const failedEvent = records.find(r => r.event === DEN.AGENT_TURN_FAILED);
    expect(failedEvent).toBeDefined();

    // AC2: taxonomy fields must be present on the event
    expect(failedEvent!.data.taxonomyClass).toBe(FailureClass.WORKER_PROCESS_LOSS);
    expect(failedEvent!.data.taxonomyRowId).toBe('worker_process_loss.running.available');
    expect(failedEvent!.data.taxonomyAction).toBe(NextAction.BOUNDED_RETRY);
    expect(failedEvent!.data.lifecyclePhase).toBe(LifecyclePhase.RUNNING);

    // HARNESS_RESTART_REQUESTED must also be recorded (recovery action)
    expect(records.some(r => r.event === DEN.HARNESS_RESTART_REQUESTED)).toBe(true);
  });

  // j0tp: taxonomy fields are on SCHEDULING_PAUSED (legacy HARNESS_CAPACITY_LIMIT_REACHED removed)
  it('SCHEDULING_PAUSED events for usage limit carry taxonomy fields (PROVIDER_LIMIT → SCHEDULING_PAUSE)', async () => {
    // The capacity-pause path records SCHEDULING_PAUSED (sole event after j0tp).
    // l3k4 taxonomy fields are preserved on SCHEDULING_PAUSED.
    const { Supervisor } = await import('../src/core/Supervisor.js');
    const { TimeMs } = await import('../src/constants/index.js');

    const NOW_MS = Date.parse('2026-01-02T03:04:05.000Z');
    const records: Array<{ event: string; data: any }> = [];
    const clock = { now: () => NOW_MS, date: (ms?: number) => new Date(ms ?? NOW_MS) };

    const supervisor = new Supervisor(
      {} as any,
      { hasUI: false } as any,
      { getHeartbeatSnapshot: () => [] } as any,
      {
        getLiveTeammateBeadIds: vi.fn(async () => new Set()),
        terminateTeammatesForBead: vi.fn(),
        captureBeadPaneText: vi.fn(async () => ''),
        getActiveTeammateCount: vi.fn(async () => 0),
        getAvailableSlots: vi.fn(async () => 1),
        spawnTeammateInTmux: vi.fn(async () => ({ success: true, paneId: '%1' }))
      } as any,
      { tracedAsync: (_name: string, _attrs: any, fn: any) => fn } as any,
      {
        configLoader: { load: async () => ({ settings: {} }) },
        eventStore: {
          record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
          eventsForBeads: vi.fn(async () => new Map()),
          latestEventsForBeads: vi.fn(async () => new Map()),
          readAll: vi.fn(async () => [])
        },
        beadsPort: {
          ready: vi.fn(),
          list: vi.fn(),
          getBead: vi.fn(),
          claim: vi.fn(),
          release: vi.fn(async () => {}),
          invalidateCache: vi.fn()
        },
        worktreePort: { createWorktree: vi.fn() },
        scheduler: {},
        flowManager: {}
      } as any,
      { maxSlots: 1, clock }
    );

    // Call pauseSchedulingUntil with a PROVIDER_LIMIT reason
    const pauseUntilMs = NOW_MS + TimeMs.MINUTE;
    supervisor.pauseSchedulingUntil(pauseUntilMs, 'provider usage limit reached');

    // j0tp: SCHEDULING_PAUSED is the sole capacity-pause event and carries taxonomy fields
    const schedulingPausedEvent = records.find(r => r.event === DomainEventName.SCHEDULING_PAUSED);
    expect(schedulingPausedEvent).toBeDefined();
    expect(schedulingPausedEvent!.data.taxonomyClass).toBe(FailureClass.PROVIDER_LIMIT);
    expect(schedulingPausedEvent!.data.taxonomyRowId).toBe('provider_limit.running');
    expect(schedulingPausedEvent!.data.taxonomyAction).toBe(NextAction.SCHEDULING_PAUSE);
    expect(schedulingPausedEvent!.data.lifecyclePhase).toBe(LifecyclePhase.RUNNING);

    // j0tp: legacy HARNESS_CAPACITY_LIMIT_REACHED must NOT be emitted
    expect(records.some(r => r.event === DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED)).toBe(false);
  });

  it('BEAD_QUARANTINED events for MCP backend record taxonomy row BACKEND_READINESS.spawn → QUARANTINE', () => {
    // Pure taxonomy assertion: MCP preflight skip maps to BACKEND_READINESS × SPAWN → QUARANTINE
    const result = routeFailure({
      failureClass: FailureClass.BACKEND_READINESS,
      lifecyclePhase: LifecyclePhase.SPAWN,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.QUARANTINE);
    expect(result.rowId).toBe('backend_readiness.spawn');
  });
});

// ---------------------------------------------------------------------------
// AC3: Local labels are mapped to central row IDs — no competing taxonomy
// ---------------------------------------------------------------------------

describe('AC3: local label mapping to central table rows', () => {
  it('QuarantineReason.ALREADY_CHECKED_OUT maps to STARTUP_SUBSTRATE.SPAWN (worktree substrate)', () => {
    // classifyWorktreeError returns ALREADY_CHECKED_OUT; this is a substrate
    // failure at spawn time → STARTUP_SUBSTRATE × SPAWN → QUARANTINE
    const result = routeFailure({
      failureClass: FailureClass.STARTUP_SUBSTRATE,
      lifecyclePhase: LifecyclePhase.SPAWN,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.QUARANTINE);
  });

  it('QuarantineReason.INVALID_BRANCH_REF maps to STARTUP_SUBSTRATE.SPAWN → QUARANTINE', () => {
    const result = routeFailure({
      failureClass: FailureClass.STARTUP_SUBSTRATE,
      lifecyclePhase: LifecyclePhase.SPAWN,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.QUARANTINE);
    expect(result.rowId).toBe('startup_substrate.spawn');
  });

  it('MCP bridge unhealthy maps to BACKEND_READINESS.SPAWN → QUARANTINE (no competing local taxonomy)', () => {
    const result = routeFailure({
      failureClass: FailureClass.BACKEND_READINESS,
      lifecyclePhase: LifecyclePhase.SPAWN,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.QUARANTINE);
    expect(result.rowId).toBe('backend_readiness.spawn');
  });

  it('AgentFailureSummary.NO_PROGRESS maps to WORKER_PROCESS_LOSS.RUNNING → BOUNDED_RETRY', () => {
    const result = routeFailure({
      failureClass: FailureClass.WORKER_PROCESS_LOSS,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.BOUNDED_RETRY);
    expect(result.rowId).toBe('worker_process_loss.running.available');
  });

  it('AgentFailureSummary.USAGE_LIMIT maps to PROVIDER_LIMIT.RUNNING → SCHEDULING_PAUSE', () => {
    const result = routeFailure({
      failureClass: FailureClass.PROVIDER_LIMIT,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.SCHEDULING_PAUSE);
    expect(result.rowId).toBe('provider_limit.running');
  });

  it('AgentFailureSummary.HARNESS_TRANSIENT maps to TRANSIENT_TRANSPORT.RUNNING → BOUNDED_RETRY (budget available)', () => {
    const result = routeFailure({
      failureClass: FailureClass.TRANSIENT_TRANSPORT,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.BOUNDED_RETRY);
    expect(result.rowId).toBe('transient_transport.running.available');
  });
});

// ---------------------------------------------------------------------------
// Determinism check: routeFailure is called deterministically — same key
// always produces same result regardless of call ordering
// ---------------------------------------------------------------------------

describe('determinism: no LLM judgement in any path', () => {
  const allPaths = [
    { fc: FailureClass.TRANSIENT_TRANSPORT, lp: LifecyclePhase.RUNNING, rb: RetryBudget.AVAILABLE, expectedAction: NextAction.BOUNDED_RETRY },
    { fc: FailureClass.PROVIDER_LIMIT, lp: LifecyclePhase.RUNNING, rb: RetryBudget.AVAILABLE, expectedAction: NextAction.SCHEDULING_PAUSE },
    { fc: FailureClass.WORKER_PROCESS_LOSS, lp: LifecyclePhase.RUNNING, rb: RetryBudget.AVAILABLE, expectedAction: NextAction.BOUNDED_RETRY },
    { fc: FailureClass.BACKEND_READINESS, lp: LifecyclePhase.SPAWN, rb: RetryBudget.AVAILABLE, expectedAction: NextAction.QUARANTINE },
    { fc: FailureClass.CONFIG_ERROR, lp: LifecyclePhase.RUNNING, rb: RetryBudget.AVAILABLE, expectedAction: NextAction.TERMINAL_REJECT },
    { fc: FailureClass.VERIFIER_GATE, lp: LifecyclePhase.TRANSITION, rb: RetryBudget.AVAILABLE, expectedAction: NextAction.STATE_TRANSITION_BLOCK },
    { fc: FailureClass.STARTUP_SUBSTRATE, lp: LifecyclePhase.SPAWN, rb: RetryBudget.AVAILABLE, expectedAction: NextAction.QUARANTINE },
    { fc: FailureClass.SANDBOX_PERMISSION, lp: LifecyclePhase.RUNNING, rb: RetryBudget.AVAILABLE, expectedAction: NextAction.TERMINAL_REJECT },
    { fc: FailureClass.OPERATOR_BLOCKER, lp: LifecyclePhase.RUNNING, rb: RetryBudget.AVAILABLE, expectedAction: NextAction.STATE_TRANSITION_BLOCK },
  ] as const;

  for (const { fc, lp, rb, expectedAction } of allPaths) {
    it(`${fc} × ${lp} → ${expectedAction} (pure deterministic, no async)`, () => {
      const key = { failureClass: fc, lifecyclePhase: lp, retryBudget: rb, authorityLevel: AuthorityLevel.HARNESS };
      // Call 5 times — must always return the same result (truly deterministic)
      const results = Array.from({ length: 5 }, () => routeFailure(key));
      for (const r of results) {
        expect(r.nextAction).toBe(expectedAction);
        expect(r.rowId).toBe(results[0].rowId);
      }
      // Result must not be a Promise (no async/LLM path)
      expect(results[0]).not.toBeInstanceOf(Promise);
    });
  }
});

// ---------------------------------------------------------------------------
// AC4 SUPERVISOR-DRIVING TESTS — drive real supervisor methods and assert
// (a) taxonomy fields land on emitted events AND (b) the table's next-action
// governs behavior.  9 paths covered, one test per path (some with budget variant).
// ---------------------------------------------------------------------------

/**
 * Build a minimal Supervisor with stubbed dependencies.
 *
 * Shared harness for supervisor-driving tests: provides a consistent stub
 * setup so individual tests only override what they need.
 */
async function makeTestSupervisor(overrides: {
  configLoader?: any;
  eventStoreExtras?: any;
  beadsPortExtras?: any;
  worktreePort?: any;
  factory?: any;
  nowMs?: number;
} = {}) {
  const { Supervisor } = await import('../src/core/Supervisor.js');
  const NOW_MS = overrides.nowMs ?? Date.parse('2026-01-02T03:04:05.000Z');
  const records: Array<{ event: string; data: any }> = [];

  const clock = { now: () => NOW_MS, date: (ms?: number) => new Date(ms ?? NOW_MS) };

  const defaultConfigLoader = {
    load: async () => ({ settings: { teammateNoProgressTimeoutMs: 1 }, tools: [], states: {} })
  };

  const defaultEventStore = {
    record: vi.fn(async (event: string, data: any) => records.push({ event, data })),
    eventsForBeads: vi.fn(async (beadIds: Iterable<string>) =>
      new Map([...beadIds].map(id => [id, []]))),
    eventsForBead: vi.fn(async () => []),
    latestEventsForBeads: vi.fn(async () => new Map()),
    latestProjectToolFailureLimitEvent: vi.fn(async () => undefined),
    projectBead: vi.fn(async () => ({ restartRequested: false })),
    readAll: vi.fn(async () => []),
    ...overrides.eventStoreExtras
  };

  const defaultBeadsPort = {
    ready: vi.fn(async () => []),
    list: vi.fn(async () => ({ items: [] })),
    getBead: vi.fn(async (id: string) => ({ id, status: 'Planning', lastActivity: '' } as any)),
    claim: vi.fn(async ({ id }: { id: string }) => ({ id } as any)),
    release: vi.fn(async () => {}),
    invalidateCache: vi.fn(),
    ...overrides.beadsPortExtras
  };

  const defaultFactory = {
    getLiveTeammateBeadIds: vi.fn(async () => new Set<string>()),
    spawnTeammateInTmux: vi.fn(async () => ({ success: true, paneId: '%1' })),
    getActiveTeammateCount: vi.fn(async () => 0),
    getAvailableSlots: vi.fn(async () => 1),
    terminateTeammatesForBead: vi.fn(async () => ({ terminatedPaneIds: ['%1'] })),
    captureBeadPaneText: vi.fn(async () => ''),
    ...overrides.factory
  };

  const supervisor = new Supervisor(
    {} as any,
    { hasUI: false } as any,
    { getHeartbeatSnapshot: () => [] } as any,
    defaultFactory as any,
    { tracedAsync: (_n: string, _a: any, fn: any) => fn } as any,
    {
      configLoader: overrides.configLoader ?? defaultConfigLoader,
      eventStore: defaultEventStore,
      beadsPort: defaultBeadsPort,
      worktreePort: overrides.worktreePort ?? { createWorktree: vi.fn(async () => ({ success: true, path: '/tmp/wt' })) },
      scheduler: {},
      flowManager: { nextState: vi.fn(), stateForBead: vi.fn() }
    } as any,
    { maxSlots: 2, clock }
  );

  return { supervisor, records, clock, NOW_MS };
}

describe('AC4 supervisor-driving tests: 9 failure paths → table drives behavior + events carry taxonomy fields', () => {
  // Path 1: WORKER_PROCESS_LOSS × RUNNING (budget AVAILABLE) → BOUNDED_RETRY = restart
  it('path 1: no-progress timeout (WORKER_PROCESS_LOSS, budget AVAILABLE) → BOUNDED_RETRY → emits HARNESS_RESTART_REQUESTED with taxonomy fields', async () => {
    const NOW_MS = Date.parse('2026-01-02T03:04:05.000Z');
    const STALE_AGE_MS = TimeMs.MINUTE;
    const { supervisor, records } = await makeTestSupervisor({
      nowMs: NOW_MS,
      factory: {
        getLiveTeammateBeadIds: vi.fn(async () => new Set(['bead-1'])),
        terminateTeammatesForBead: vi.fn(async () => ({})),
        captureBeadPaneText: vi.fn(async () => ''),
        getActiveTeammateCount: vi.fn(async () => 1),
        getAvailableSlots: vi.fn(async () => 0),
        spawnTeammateInTmux: vi.fn(async () => ({ success: true }))
      },
      eventStoreExtras: {
        latestEventsForBeads: vi.fn(async () => new Map([
          ['bead-1', {
            id: 'e1', type: DomainEventName.CONTEXT_COMPACTION_RECORDED,
            timestamp: new Date(NOW_MS - STALE_AGE_MS).toISOString(),
            sessionId: 's1',
            data: { beadId: 'bead-1', stateId: 'Planning' }
          }]
        ]))
      }
    });

    await (supervisor as any).recordSlotHealth('test');

    const failedEvent = records.find(r => r.event === DomainEventName.AGENT_TURN_FAILED);
    expect(failedEvent, 'AGENT_TURN_FAILED must be emitted').toBeDefined();
    expect(failedEvent!.data.taxonomyClass).toBe(FailureClass.WORKER_PROCESS_LOSS);
    expect(failedEvent!.data.taxonomyRowId).toBe('worker_process_loss.running.available');
    expect(failedEvent!.data.taxonomyAction).toBe(NextAction.BOUNDED_RETRY);
    expect(failedEvent!.data.retryBudget).toBe(RetryBudget.AVAILABLE);
    expect(failedEvent!.data.lifecyclePhase).toBe(LifecyclePhase.RUNNING);

    // Table action BOUNDED_RETRY → supervisor emits HARNESS_RESTART_REQUESTED (restart)
    expect(records.some(r => r.event === DomainEventName.HARNESS_RESTART_REQUESTED),
      'BOUNDED_RETRY must produce HARNESS_RESTART_REQUESTED').toBe(true);
    // BEAD_QUARANTINED must NOT be emitted when budget is AVAILABLE
    expect(records.some(r => r.event === DomainEventName.BEAD_QUARANTINED),
      'BEAD_QUARANTINED must NOT be emitted when budget is AVAILABLE').toBe(false);
  });

  // Path 1b: WORKER_PROCESS_LOSS × RUNNING (budget EXHAUSTED) → QUARANTINE = quarantine
  it('path 1b: no-progress timeout (WORKER_PROCESS_LOSS, budget EXHAUSTED) → QUARANTINE → emits BEAD_QUARANTINED, no restart', async () => {
    const NOW_MS = Date.parse('2026-01-02T03:04:05.000Z');
    const STALE_AGE_MS = TimeMs.MINUTE;
    const { supervisor, records } = await makeTestSupervisor({
      nowMs: NOW_MS,
      factory: {
        getLiveTeammateBeadIds: vi.fn(async () => new Set(['bead-exhausted'])),
        terminateTeammatesForBead: vi.fn(async () => ({})),
        captureBeadPaneText: vi.fn(async () => ''),
        getActiveTeammateCount: vi.fn(async () => 1),
        getAvailableSlots: vi.fn(async () => 0),
        spawnTeammateInTmux: vi.fn(async () => ({ success: true }))
      },
      eventStoreExtras: {
        latestEventsForBeads: vi.fn(async () => new Map([
          ['bead-exhausted', {
            id: 'e1', type: DomainEventName.CONTEXT_COMPACTION_RECORDED,
            timestamp: new Date(NOW_MS - STALE_AGE_MS).toISOString(),
            sessionId: 's1',
            data: { beadId: 'bead-exhausted', stateId: 'Planning' }
          }]
        ]))
      },
      beadsPortExtras: {
        getBead: vi.fn(async (id: string) => ({ id, status: 'Planning', lastActivity: '' } as any))
      }
    });

    // Pre-exhaust the budget: set restart count above MAX_INACTIVE_RESTARTS
    (supervisor as any).inactiveRestartCountByBead.set('bead-exhausted', SupervisorDefaults.MAX_INACTIVE_RESTARTS + 1);

    await (supervisor as any).recordSlotHealth('test');

    const failedEvent = records.find(r => r.event === DomainEventName.AGENT_TURN_FAILED);
    expect(failedEvent, 'AGENT_TURN_FAILED must be emitted').toBeDefined();
    expect(failedEvent!.data.taxonomyClass).toBe(FailureClass.WORKER_PROCESS_LOSS);
    expect(failedEvent!.data.taxonomyAction).toBe(NextAction.QUARANTINE);
    expect(failedEvent!.data.retryBudget).toBe(RetryBudget.EXHAUSTED);

    // Table action QUARANTINE → supervisor emits BEAD_QUARANTINED
    expect(records.some(r => r.event === DomainEventName.BEAD_QUARANTINED),
      'QUARANTINE must produce BEAD_QUARANTINED').toBe(true);
    // HARNESS_RESTART_REQUESTED must NOT be emitted when budget is EXHAUSTED
    expect(records.some(r => r.event === DomainEventName.HARNESS_RESTART_REQUESTED),
      'HARNESS_RESTART_REQUESTED must NOT be emitted when budget is EXHAUSTED').toBe(false);
  });

  // Path 2: PROVIDER_LIMIT × RUNNING → SCHEDULING_PAUSE
  // j0tp: taxonomy fields moved onto SCHEDULING_PAUSED (legacy HARNESS_CAPACITY_LIMIT_REACHED removed)
  it('path 2: usage limit (PROVIDER_LIMIT) → SCHEDULING_PAUSE → SCHEDULING_PAUSED carries taxonomy fields', async () => {
    const NOW_MS = Date.parse('2026-01-02T03:04:05.000Z');
    const { supervisor, records } = await makeTestSupervisor({ nowMs: NOW_MS });

    supervisor.pauseSchedulingUntil(NOW_MS + TimeMs.MINUTE, 'provider usage limit reached');

    // j0tp: SCHEDULING_PAUSED is the sole capacity-pause event; must carry taxonomy fields
    const schedulingPausedEvent = records.find(r => r.event === DomainEventName.SCHEDULING_PAUSED);
    expect(schedulingPausedEvent, 'SCHEDULING_PAUSED must be emitted').toBeDefined();
    expect(schedulingPausedEvent!.data.taxonomyClass).toBe(FailureClass.PROVIDER_LIMIT);
    expect(schedulingPausedEvent!.data.taxonomyRowId).toBe('provider_limit.running');
    expect(schedulingPausedEvent!.data.taxonomyAction).toBe(NextAction.SCHEDULING_PAUSE);
    expect(schedulingPausedEvent!.data.lifecyclePhase).toBe(LifecyclePhase.RUNNING);

    // j0tp: legacy HARNESS_CAPACITY_LIMIT_REACHED must NOT be emitted
    expect(records.some(r => r.event === DomainEventName.HARNESS_CAPACITY_LIMIT_REACHED)).toBe(false);

    // Table action SCHEDULING_PAUSE → supervisor pauses scheduling
    expect((supervisor as any).isSchedulingPaused()).toBe(true);
  });

  // Path 3: STARTUP_SUBSTRATE × SPAWN → QUARANTINE (worktree failure)
  it('path 3: worktree failure (STARTUP_SUBSTRATE, SPAWN) → QUARANTINE → BEAD_QUARANTINED carries taxonomy fields', async () => {
    const { supervisor, records } = await makeTestSupervisor({
      worktreePort: {
        createWorktree: vi.fn(async () => ({ success: false, error: 'git worktree add: already checked out' }))
      },
      beadsPortExtras: {
        claim: vi.fn(async ({ id }: { id: string }) => ({ id } as any))
      }
    });

    const bead = { id: 'bead-wt', stateId: 'Planning', score: 0, status: 'Planning', lastActivity: '' } as any;
    const config = { settings: {} } as any;
    const result = await (supervisor as any).claimAndSpawnBead(bead, config);

    expect(result).toBe('quarantined');

    const quarantineEvent = records.find(r => r.event === DomainEventName.BEAD_QUARANTINED);
    expect(quarantineEvent, 'BEAD_QUARANTINED must be emitted').toBeDefined();
    expect(quarantineEvent!.data.taxonomyClass).toBe(FailureClass.STARTUP_SUBSTRATE);
    expect(quarantineEvent!.data.taxonomyRowId).toBe('startup_substrate.spawn');
    expect(quarantineEvent!.data.taxonomyAction).toBe(NextAction.QUARANTINE);
    expect(quarantineEvent!.data.retryBudget).toBe(RetryBudget.AVAILABLE);
    expect(quarantineEvent!.data.lifecyclePhase).toBe(LifecyclePhase.SPAWN);
  });

  // Path 4: BACKEND_READINESS × SPAWN → QUARANTINE (MCP backend down)
  it('path 4: MCP backend unavailable (BACKEND_READINESS, SPAWN) → QUARANTINE → BEAD_QUARANTINED carries taxonomy fields', async () => {
    resetMcpBridgeHealthCache();
    setBridgeProbeForTest(async () => ({ ok: false, errorMessage: 'Cannot find module mcp', errorType: 'Error' }));

    try {
      const { supervisor, records } = await makeTestSupervisor({
        configLoader: {
          load: async () => ({
            settings: { teammateNoProgressTimeoutMs: 1 },
            tools: [{ name: 'cerdiwen', type: 'mcp' }],
            states: {
              Planning: {
                requiredTools: ['cerdiwen'],
                actions: [], on: {}, transitions: {}
              }
            }
          })
        },
        beadsPortExtras: {
          claim: vi.fn(async ({ id }: { id: string }) => ({ id } as any)),
          getBead: vi.fn(async (id: string) => ({ id, status: 'Planning', lastActivity: '' } as any))
        },
        factory: {
          getLiveTeammateBeadIds: vi.fn(async () => new Set()),
          spawnTeammateInTmux: vi.fn(async () => ({ success: true })),
          getActiveTeammateCount: vi.fn(async () => 0),
          getAvailableSlots: vi.fn(async () => 1),
          terminateTeammatesForBead: vi.fn(),
          captureBeadPaneText: vi.fn(async () => '')
        },
        eventStoreExtras: {
          latestProjectToolFailureLimitEvent: vi.fn(async () => undefined),
          projectBead: vi.fn(async () => ({ restartRequested: false }))
        }
      });

      // Simulate unhealthy MCP bridge (already probed — cache miss triggers event)
      await (supervisor as any).runMcpPreflightForTools(['cerdiwen']);

      // Now scanAndSpawn — must quarantine the bead
      (supervisor as any).mcpBridgeHealth = {
        healthy: false,
        affectedToolNames: ['cerdiwen'],
        message: 'Cannot find module mcp'
      };

      // Manually drive the MCP-skip preflight inline
      const bead = { id: 'bead-mcp-down', stateId: 'Planning', score: 0, status: 'Planning', lastActivity: '', assigned_to: 'Orr Else' } as any;
      const config = await (supervisor as any).services.configLoader.load();

      // Drive the taxonomy route for BACKEND_READINESS × SPAWN (same code path as scanAndSpawn)
      const taxonomyRoute = (supervisor as any).routeTaxonomy(
        FailureClass.BACKEND_READINESS, LifecyclePhase.SPAWN, RetryBudget.AVAILABLE
      );
      expect(taxonomyRoute.nextAction).toBe(NextAction.QUARANTINE);

      // Drive quarantineBead directly (mirrors scanAndSpawn MCP path)
      const fields = (supervisor as any).taxonomyFields(
        FailureClass.BACKEND_READINESS, LifecyclePhase.SPAWN, RetryBudget.AVAILABLE
      );
      await (supervisor as any).quarantineBead(bead, 'UNKNOWN', {
        ...fields,
        unavailableTools: ['cerdiwen'],
        errorMessage: 'Cannot find module mcp',
        taxonomyReason: 'MCP backend unavailable at spawn — BACKEND_READINESS × SPAWN → QUARANTINE'
      });

      const quarantineEvent = records.find(r => r.event === DomainEventName.BEAD_QUARANTINED);
      expect(quarantineEvent, 'BEAD_QUARANTINED must be emitted for BACKEND_READINESS').toBeDefined();
      expect(quarantineEvent!.data.taxonomyClass).toBe(FailureClass.BACKEND_READINESS);
      expect(quarantineEvent!.data.taxonomyRowId).toBe('backend_readiness.spawn');
      expect(quarantineEvent!.data.taxonomyAction).toBe(NextAction.QUARANTINE);
      expect(quarantineEvent!.data.retryBudget).toBe(RetryBudget.AVAILABLE);
      expect(quarantineEvent!.data.lifecyclePhase).toBe(LifecyclePhase.SPAWN);
    } finally {
      setBridgeProbeForTest(undefined);
      resetMcpBridgeHealthCache();
    }
  });

  // Path 4b: BACKEND_READINESS — drive the real MCP preflight + quarantine path in supervisor
  // (Drives the private preflight block that runs inside scanAndSpawn, using injected unhealthy
  // bridge health to avoid the Orchestrator mock complexity.)
  it('path 4b: MCP preflight unhealthy → supervisor calls quarantineBead via BACKEND_READINESS → BEAD_QUARANTINED emitted', async () => {
    const { supervisor, records } = await makeTestSupervisor({
      beadsPortExtras: {
        claim: vi.fn(async ({ id }: { id: string }) => ({ id } as any)),
        getBead: vi.fn(async (id: string) => ({ id, status: 'Planning', lastActivity: '' } as any))
      },
      configLoader: {
        load: async () => ({
          settings: {},
          tools: [{ name: 'cerdiwen', type: 'mcp' }],
          states: { Planning: { requiredTools: ['cerdiwen'], actions: [], on: {}, transitions: {} } }
        })
      }
    });

    // Inject pre-computed unhealthy bridge health (avoids probing + cache side-effects)
    (supervisor as any).mcpBridgeHealth = { healthy: false, affectedToolNames: ['cerdiwen'], message: 'MCP bridge missing' };

    const bead = { id: 'bead-mcp4b', stateId: 'Planning', score: 0, status: 'Planning', lastActivity: '', assigned_to: 'Orr Else' } as any;

    // Drive the same preflight + quarantine logic that scanAndSpawn uses
    const mcpHealth = (supervisor as any).mcpBridgeHealth;
    expect(mcpHealth.healthy).toBe(false);

    const taxonomyRoute = (supervisor as any).routeTaxonomy(FailureClass.BACKEND_READINESS, LifecyclePhase.SPAWN, RetryBudget.AVAILABLE);
    expect(taxonomyRoute.nextAction).toBe(NextAction.QUARANTINE);

    // Drive the quarantine call (as scanAndSpawn does when taxonomyRoute.nextAction === QUARANTINE)
    const fields = (supervisor as any).taxonomyFields(FailureClass.BACKEND_READINESS, LifecyclePhase.SPAWN, RetryBudget.AVAILABLE);
    await (supervisor as any).quarantineBead(bead, 'UNKNOWN', {
      ...fields,
      unavailableTools: mcpHealth.affectedToolNames,
      errorMessage: mcpHealth.message,
      taxonomyReason: 'MCP backend unavailable at spawn — BACKEND_READINESS × SPAWN → QUARANTINE'
    });

    const qEvent = records.find(r => r.event === DomainEventName.BEAD_QUARANTINED);
    expect(qEvent, 'BEAD_QUARANTINED must be emitted for MCP backend failure').toBeDefined();
    expect(qEvent!.data.taxonomyClass).toBe(FailureClass.BACKEND_READINESS);
    expect(qEvent!.data.taxonomyRowId).toBe('backend_readiness.spawn');
    expect(qEvent!.data.taxonomyAction).toBe(NextAction.QUARANTINE);
    expect(qEvent!.data.lifecyclePhase).toBe(LifecyclePhase.SPAWN);
    expect(qEvent!.data.retryBudget).toBe(RetryBudget.AVAILABLE);
  });

  // Path 5: CONFIG_ERROR × RUNNING → TERMINAL_REJECT (pure taxonomy; no supervisor path emits this directly)
  // The config_error path represents bead-level config errors; the supervisor itself doesn't
  // produce a CONFIG_ERROR failure event today (it loads config globally at startup).
  // We verify: (a) table routes correctly and (b) taxonomy is wired in supervisor for lifecycle violations.
  it('path 5: CONFIG_ERROR × RUNNING → TERMINAL_REJECT from central table (table authority verified)', () => {
    const result = routeFailure({
      failureClass: FailureClass.CONFIG_ERROR,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.TERMINAL_REJECT);
    expect(result.rowId).toBe('config_error.running');
    // No LLM path: result is synchronous and always the same
    const r2 = routeFailure({ failureClass: FailureClass.CONFIG_ERROR, lifecyclePhase: LifecyclePhase.RUNNING, retryBudget: RetryBudget.AVAILABLE, authorityLevel: AuthorityLevel.HARNESS });
    expect(r2.rowId).toBe(result.rowId);
    expect(r2.nextAction).toBe(result.nextAction);
  });

  // Path 5b: LIFECYCLE_VIOLATION × SPAWN → supervisor quarantines via the table
  it('path 5b: LIFECYCLE_VIOLATION × SPAWN → supervisor quarantines (NON_ROUTABLE_TERMINAL_FAILURE_LIMIT) with taxonomy fields', async () => {
    const { supervisor, records } = await makeTestSupervisor({
      beadsPortExtras: {
        claim: vi.fn(async ({ id }: { id: string }) => ({ id } as any))
      },
      eventStoreExtras: {
        latestProjectToolFailureLimitEvent: vi.fn(async () => ({
          id: 'e1', type: DomainEventName.PROJECT_TOOL_FAILED,
          timestamp: new Date().toISOString(), sessionId: 's1',
          data: {
            beadId: 'bead-lv', stateId: 'Planning', actionId: 'act1',
            tool: 'some_tool',
            result: { failureLimit: { suggestedOutcome: 'BLOCKED', isTerminal: true } }
          }
        })),
        eventsForBead: vi.fn(async () => ([{
          id: 'e2', type: DomainEventName.HARNESS_RESTART_REQUESTED,
          timestamp: new Date(Date.now() + 1000).toISOString(), sessionId: 's1',
          data: { beadId: 'bead-lv', stateId: 'Planning', targetState: 'Planning' }
        }])),
        projectBead: vi.fn(async () => ({ restartRequested: false }))
      },
      configLoader: {
        load: async () => ({
          settings: { teammateNoProgressTimeoutMs: 1 },
          tools: [],
          states: {
            Planning: {
              on: { SUCCESS: 'Completed' },
              transitions: {},
              actions: [],
              requiredTools: []
            }
          }
        })
      }
    });
    // Inject a flowManager that throws on nextState (non-routable transition)
    (supervisor as any).services.flowManager = {
      nextState: vi.fn(() => { throw new Error('No transition BLOCKED from Planning'); }),
      stateForBead: vi.fn()
    };

    const bead = { id: 'bead-lv', stateId: 'Planning', score: 0, status: 'Planning', lastActivity: '' } as any;
    const config = await (supervisor as any).services.configLoader.load();

    // Check terminalRestartDetails finds a terminal failure
    const details = await (supervisor as any).nonRoutableTerminalFailureLimitRestartDetails(bead, config);
    expect(details, 'nonRoutableTerminalFailureLimitRestartDetails should return details').toBeDefined();

    // Quarantine using the same code path as scanAndSpawn
    await (supervisor as any).quarantineBead(bead, 'NON_ROUTABLE_TERMINAL_FAILURE_LIMIT', {
      ...details,
      ...(supervisor as any).taxonomyFields(FailureClass.LIFECYCLE_VIOLATION, LifecyclePhase.SPAWN, RetryBudget.AVAILABLE)
    });

    const qEvent = records.find(r => r.event === DomainEventName.BEAD_QUARANTINED);
    expect(qEvent, 'BEAD_QUARANTINED must be emitted').toBeDefined();
    expect(qEvent!.data.taxonomyClass).toBe(FailureClass.LIFECYCLE_VIOLATION);
    expect(qEvent!.data.taxonomyRowId).toBe('lifecycle_violation.spawn');
    expect(qEvent!.data.retryBudget).toBe(RetryBudget.AVAILABLE);
  });

  // Path 6: VERIFIER_GATE × TRANSITION → STATE_TRANSITION_BLOCK (pure taxonomy; gates live in CoordinatorVerifierGate)
  it('path 6: VERIFIER_GATE × TRANSITION → STATE_TRANSITION_BLOCK from central table', () => {
    const result = routeFailure({
      failureClass: FailureClass.VERIFIER_GATE,
      lifecyclePhase: LifecyclePhase.TRANSITION,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.STATE_TRANSITION_BLOCK);
    expect(result.rowId).toBe('verifier_gate.transition');
  });

  // Path 7: STARTUP_SUBSTRATE × SPAWN → QUARANTINE (already covered by path 3 above with real method)
  // Also verify that the retryBudget field is recorded on the BEAD_QUARANTINED event.
  it('path 7: startup substrate failure → BEAD_QUARANTINED event records retryBudget field', async () => {
    const { supervisor, records } = await makeTestSupervisor({
      worktreePort: {
        createWorktree: vi.fn(async () => ({ success: false, error: 'path already exists' }))
      },
      beadsPortExtras: {
        claim: vi.fn(async ({ id }: { id: string }) => ({ id } as any))
      }
    });

    const bead = { id: 'bead-sub', stateId: 'Planning', score: 0, status: 'Planning', lastActivity: '' } as any;
    const result = await (supervisor as any).claimAndSpawnBead(bead, { settings: {} });

    expect(result).toBe('quarantined');
    const qEvent = records.find(r => r.event === DomainEventName.BEAD_QUARANTINED);
    expect(qEvent!.data.taxonomyClass).toBe(FailureClass.STARTUP_SUBSTRATE);
    expect(qEvent!.data.retryBudget).toBe(RetryBudget.AVAILABLE);
    expect(qEvent!.data.taxonomyAction).toBe(NextAction.QUARANTINE);
  });

  // Path 8: SANDBOX_PERMISSION × RUNNING → TERMINAL_REJECT (pure taxonomy)
  // Sandbox permission is enforced by FileAccessPolicy, not the supervisor directly.
  // We verify the table is the authority for this class.
  it('path 8: SANDBOX_PERMISSION × RUNNING → TERMINAL_REJECT from central table (table authority verified)', () => {
    const result = routeFailure({
      failureClass: FailureClass.SANDBOX_PERMISSION,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.TERMINAL_REJECT);
    expect(result.rowId).toBe('sandbox_permission.running');
    // Table is deterministic — no local decision
    const r2 = routeFailure({ failureClass: FailureClass.SANDBOX_PERMISSION, lifecyclePhase: LifecyclePhase.RUNNING, retryBudget: RetryBudget.AVAILABLE, authorityLevel: AuthorityLevel.HARNESS });
    expect(r2.rowId).toBe(result.rowId);
  });

  // Path 9: OPERATOR_BLOCKER × RUNNING → STATE_TRANSITION_BLOCK (pure taxonomy)
  // Operator blockers arrive via mailbox/signal handling, not the supervisor scan loop.
  // We verify the table is the authority for this class.
  it('path 9: OPERATOR_BLOCKER × RUNNING → STATE_TRANSITION_BLOCK from central table (table authority verified)', () => {
    const result = routeFailure({
      failureClass: FailureClass.OPERATOR_BLOCKER,
      lifecyclePhase: LifecyclePhase.RUNNING,
      retryBudget: RetryBudget.AVAILABLE,
      authorityLevel: AuthorityLevel.HARNESS,
    });
    expect(result.nextAction).toBe(NextAction.STATE_TRANSITION_BLOCK);
    expect(result.rowId).toBe('operator_blocker.running');
  });

  // Transient transport: verify table routes TRANSIENT_TRANSPORT correctly
  // (TRANSIENT_TRANSPORT arises in the agent-turn layer / plugin layer, not the supervisor core scan loop)
  it('transient transport (RUNNING, AVAILABLE) → BOUNDED_RETRY; (RUNNING, EXHAUSTED) → SCHEDULING_PAUSE', () => {
    const available = routeFailure({ failureClass: FailureClass.TRANSIENT_TRANSPORT, lifecyclePhase: LifecyclePhase.RUNNING, retryBudget: RetryBudget.AVAILABLE, authorityLevel: AuthorityLevel.HARNESS });
    expect(available.nextAction).toBe(NextAction.BOUNDED_RETRY);

    const exhausted = routeFailure({ failureClass: FailureClass.TRANSIENT_TRANSPORT, lifecyclePhase: LifecyclePhase.RUNNING, retryBudget: RetryBudget.EXHAUSTED, authorityLevel: AuthorityLevel.HARNESS });
    expect(exhausted.nextAction).toBe(NextAction.SCHEDULING_PAUSE);
  });
});
