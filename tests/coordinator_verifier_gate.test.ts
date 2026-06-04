/**
 * pi-experiment-0yt5.20 — the COORDINATOR-side per-transition artifact-presence gate.
 *
 * Bead 0yt5.5 built + tested `runVerifierGate` (the loop mechanism). THIS bead
 * wires that loop into the LIVE coordinator transition path. These tests prove
 * the coordinator-side orchestration + isolation + config fail-fast + extension
 * loading + the VERIFY_EVALUATED observability event, against a REAL EventStore
 * and the REAL contract `verifier` registry (with fixture callbacks).
 *
 *   AC1 — the gate resolves each requiredTool's latest tool-result event, runs
 *         each registered verify() on the resolved outputFile, and blocks on FAIL
 *         OR status:REJECTED OR no-event-this-attempt (not-invoked); a no-required-
 *         tools transition is a NO-OP (ran:false).
 *   AC2 — the coordinator loads pi.workerExtensions in its OWN process so consumer
 *         verify() register in the gate process (registry non-empty after load).
 *   AC3 — a locally-passing worker is still BLOCKED when the durable event/artifact
 *         is absent (coordinator is the sole binding authority).
 *   AC4 — config fail-fast: a required tool with expectsVerify:true and no callback
 *         throws naming the tool; presence-only tools load cleanly.
 *   AC5 — a throwing verify() AND a timing-out verify() both yield FAIL without
 *         hanging/crashing; a late resolve/reject is abandoned (no unhandledRejection).
 *   AC6 — a VERIFY_EVALUATED event is recorded per gate with per-tool diagnostics.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  verifier,
  VerifyVerdict,
  type VerifyContext,
  type VerifyResult
} from '../src/contract.js';
import {
  evaluateCoordinatorGate,
  validateRequiredToolVerifiers,
  type CoordinatorVerifierGateDeps,
  type CoordinatorGateInput
} from '../src/core/CoordinatorVerifierGate.js';
import { loadCoordinatorWorkerExtensions } from '../src/core/CoordinatorExtensionLoader.js';
import { runVerifierGate, VerifierGateBlockKind, type VerifierGateContext } from '../src/core/VerifierGate.js';
import { ConfigLoader } from '../src/core/ConfigLoader.js';
import { EventStore } from '../src/core/EventStore.js';
import { ArtifactPaths } from '../src/core/ArtifactPaths.js';
import { PlanWriteSet } from '../src/core/PlanWriteSet.js';
import { RequiredToolResolver } from '../src/core/RequiredToolResolver.js';
import { Observability } from '../src/core/Observability.js';
import { SignalingServer, type SignalAck, type SignalGateVerdict } from '../src/core/SignalingServer.js';
import { createTeammateEventIdempotencyKey, type TeammateEvent } from '../src/core/TeammateEvents.js';
import { DomainEventName, ToolResultStatus, TeammateEventType } from '../src/constants/index.js';
import type { HarnessConfig } from '../src/core/ConfigLoader.js';
import type { DomainEvent } from '../src/core/EventStoreTypes.js';

// ── registry cleanup (module-level singleton, last-wins, no removal API) ──────
const registered: string[] = [];
function registerVerify(tool: string, fn: (ctx: VerifyContext) => VerifyResult | Promise<VerifyResult>): void {
  verifier.register(tool, fn);
  registered.push(tool);
}
afterEach(() => {
  for (const tool of registered.splice(0)) {
    verifier.register(tool, () => ({ verdict: VerifyVerdict.NOT_APPLICABLE, reasons: [] }));
  }
});

// ── a real-store coordinator harness ──────────────────────────────────────────
function harnessYaml(): string {
  return `
settings:
  startState: Implementing
  eventStore:
    enabled: true
states:
  Implementing:
    identity: { role: "Eng", expertise: "x", constraints: [] }
    baseInstructions: "Do"
    actions:
      - id: code
        type: prompt
        requiredTools: [tA]
    transitions: { SUCCESS: "completed", FAILURE: "Implementing" }
`;
}

interface Harness {
  projectRoot: string;
  configLoader: ConfigLoader;
  config: HarnessConfig;
  store: EventStore;
  deps: CoordinatorVerifierGateDeps;
}

function makeHarness(): Harness {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orr-else-0yt5-20-')));
  fs.writeFileSync(path.join(projectRoot, 'harness.yaml'), harnessYaml());
  const configLoader = new ConfigLoader(undefined, projectRoot);
  const config = configLoader.load();
  const store = new EventStore(configLoader, undefined, undefined, projectRoot);
  store.setSessionId(`test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const artifactPaths = new ArtifactPaths(configLoader, undefined, projectRoot);
  const planWriteSet = new PlanWriteSet(configLoader, artifactPaths, projectRoot);
  const requiredToolResolver = new RequiredToolResolver(planWriteSet, projectRoot);
  const deps: CoordinatorVerifierGateDeps = {
    eventStore: store,
    artifactPaths,
    requiredToolResolver,
    planWriteSet,
    projectRoot,
    config,
    verifyTimeoutMs: 200
  };
  return { projectRoot, configLoader, config, store, deps };
}

const input = (overrides: Partial<CoordinatorGateInput> = {}): CoordinatorGateInput => ({
  beadId: 'bd-1',
  stateId: 'Implementing',
  actionId: 'code',
  requiredTools: ['tA'],
  ...overrides
});

async function verifyEvaluatedEvents(store: EventStore): Promise<DomainEvent[]> {
  return (await store.readAll()).filter(e => e.type === DomainEventName.VERIFY_EVALUATED);
}

let h: Harness;
beforeEach(() => { h = makeHarness(); });
afterEach(() => {
  vi.restoreAllMocks();
  h.configLoader.reset();
  fs.rmSync(h.projectRoot, { recursive: true, force: true });
});

describe('AC1 — coordinator gate resolves the latest tool-result, runs verify(), and blocks/advances', () => {
  it('advances when the required tool ran and its verify() PASSes', async () => {
    const outputFile = path.join(h.projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'tA', 'inv', 'o.json');
    await h.store.record(DomainEventName.PROJECT_TOOL_SUCCEEDED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'tA', status: ToolResultStatus.PASSED, outputFile
    });
    let sawOutput: string | undefined;
    registerVerify('tA', (ctx) => { sawOutput = ctx.toolOutputs.tA; return { verdict: VerifyVerdict.PASS, reasons: [] }; });

    const outcome = await evaluateCoordinatorGate(h.deps, input());

    expect(outcome.ran).toBe(true);
    expect(outcome.pass).toBe(true);
    expect(outcome.evaluatedTools).toEqual(['tA']);
    // The verify() saw the durable outputFile path resolved coordinator-side.
    expect(sawOutput).toBe(outputFile);
  });

  it('blocks on verify() FAIL and surfaces structured failures + a rendered message', async () => {
    const outputFile = path.join(h.projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'tA', 'inv', 'o.json');
    await h.store.record(DomainEventName.PROJECT_TOOL_SUCCEEDED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'tA', status: ToolResultStatus.PASSED, outputFile
    });
    registerVerify('tA', () => ({ verdict: VerifyVerdict.FAIL, reasons: ['tA content invalid'], failureOutcome: 'REWORK' }));

    const outcome = await evaluateCoordinatorGate(h.deps, input());

    expect(outcome.pass).toBe(false);
    expect(outcome.failures[0]).toMatchObject({ tool: 'tA', kind: VerifierGateBlockKind.VERIFY_FAIL, verdict: VerifyVerdict.FAIL });
    expect(outcome.rejectMessage).toContain('tA content invalid');
    // failureOutcome is ADVISORY only — surfaced, never auto-routed.
    expect(outcome.rejectMessage).toContain('advisory failureOutcome=REWORK');
  });

  it('blocks on status:REJECTED even when a verify() would PASS', async () => {
    const outputFile = path.join(h.projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'tA', 'inv', 'o.json');
    await h.store.record(DomainEventName.PROJECT_TOOL_FAILED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'tA', status: ToolResultStatus.REJECTED, outputFile
    });
    registerVerify('tA', () => ({ verdict: VerifyVerdict.PASS, reasons: ['would pass'] }));

    const outcome = await evaluateCoordinatorGate(h.deps, input());
    expect(outcome.pass).toBe(false);
    expect(outcome.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_REJECTED);
  });

  it('is a NO-OP for a transition with NO required tools (ran:false, no event recorded)', async () => {
    const outcome = await evaluateCoordinatorGate(h.deps, input({ requiredTools: [] }));
    expect(outcome.ran).toBe(false);
    expect(outcome.pass).toBe(true);
    expect(await verifyEvaluatedEvents(h.store)).toHaveLength(0);
  });
});

describe('AC3 — a locally-passing worker is still BLOCKED when the durable event is absent', () => {
  it('blocks (TOOL_NOT_INVOKED) when no tool-result event was recorded this attempt', async () => {
    // The worker may have "passed" locally, but NOTHING is recorded durably.
    registerVerify('tA', () => ({ verdict: VerifyVerdict.PASS, reasons: ['worker thinks it passed'] }));

    const outcome = await evaluateCoordinatorGate(h.deps, input());
    expect(outcome.pass).toBe(false);
    expect(outcome.failures[0].kind).toBe(VerifierGateBlockKind.TOOL_NOT_INVOKED);
  });
});

describe('AC6 — a VERIFY_EVALUATED event is recorded per gate with per-tool diagnostics', () => {
  it('records {beadId,stateId,actionId,perTool,blocked} with verdict/reasons/timing', async () => {
    const outputFile = path.join(h.projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'tA', 'inv', 'o.json');
    await h.store.record(DomainEventName.PROJECT_TOOL_SUCCEEDED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'tA', status: ToolResultStatus.PASSED, outputFile
    });
    registerVerify('tA', () => ({ verdict: VerifyVerdict.FAIL, reasons: ['nope'] }));

    await evaluateCoordinatorGate(h.deps, input());

    const events = await verifyEvaluatedEvents(h.store);
    expect(events).toHaveLength(1);
    const data = events[0].data as Record<string, unknown>;
    expect(data.beadId).toBe('bd-1');
    expect(data.stateId).toBe('Implementing');
    expect(data.actionId).toBe('code');
    expect(data.blocked).toBe(true);
    const perTool = data.perTool as Array<Record<string, unknown>>;
    expect(perTool).toHaveLength(1);
    expect(perTool[0].tool).toBe('tA');
    expect(perTool[0].verdict).toBe(VerifyVerdict.FAIL);
    expect(perTool[0].reasons).toEqual(['nope']);
    expect(typeof perTool[0].durationMs).toBe('number');
  });
});

describe('AC5 — per-verify isolation: throw and timeout both yield FAIL without hanging', () => {
  const baseCtx: VerifierGateContext = {
    beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', writeSet: [], artifacts: {}
  };
  class FakeStore {
    async latestToolResultEvent(beadId: string, stateId: string, actionId: string, tool: string): Promise<DomainEvent> {
      return {
        id: `e-${tool}`, type: DomainEventName.PROJECT_TOOL_SUCCEEDED, timestamp: new Date().toISOString(), sessionId: 't',
        data: { beadId, stateId, actionId, tool, status: ToolResultStatus.PASSED, outputFile: `/o/${tool}.json` }
      };
    }
  }

  it('a THROWING verify() is converted to FAIL (threw:true)', async () => {
    registerVerify('boom', () => { throw new Error('kaboom'); });
    const result = await runVerifierGate(baseCtx, ['boom'], new FakeStore(), { verifyTimeoutMs: 200 });
    expect(result.pass).toBe(false);
    expect(result.failures[0].kind).toBe(VerifierGateBlockKind.VERIFY_FAIL);
    expect(result.perTool[0].threw).toBe(true);
    expect(result.rejectMessage).toContain('threw');
  });

  it('a TIMING-OUT verify() is converted to FAIL (timedOut:true); a late REJECT is abandoned (no unhandledRejection)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      // Resolves AFTER the timeout window AND rejects — both must be abandoned safely.
      registerVerify('slow', () => new Promise<VerifyResult>((_resolve, reject) => {
        setTimeout(() => reject(new Error('late rejection after abandon')), 80);
      }));
      const result = await runVerifierGate(baseCtx, ['slow'], new FakeStore(), { verifyTimeoutMs: 20 });
      expect(result.pass).toBe(false);
      expect(result.perTool[0].timedOut).toBe(true);
      expect(result.rejectMessage).toContain('timed out');
      // Wait past the late rejection so any unhandledRejection would surface.
      await new Promise(r => setTimeout(r, 120));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('one tool failing in isolation does not prevent the gate from evaluating its peers', async () => {
    registerVerify('boom', () => { throw new Error('x'); });
    registerVerify('ok', () => ({ verdict: VerifyVerdict.PASS, reasons: [] }));
    const result = await runVerifierGate(baseCtx, ['boom', 'ok'], new FakeStore(), { verifyTimeoutMs: 200 });
    expect(result.perTool.map(p => p.tool)).toEqual(['boom', 'ok']);
    expect(result.failures.map(f => f.tool)).toEqual(['boom']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 (decision B) — VERDICT ROUND-TRIP: the status-mutating completion signal
// runs the gate SYNCHRONOUSLY in the request handler and returns a STRUCTURED
// VERDICT to the caller (advance vs reject+verdict/reasons) — NOT fire-and-forget
// {ok:true}. We drive the REAL gate (fixture verify() registered via the contract
// `verifier`) through the SignalingServer's hold/send ack — exactly how
// handleTeammateEvent wires it — and assert the HTTP response carries the verdict.
// ─────────────────────────────────────────────────────────────────────────────
describe('AC3 — synchronous gate verdict round-trip in the completion-signal HTTP response', () => {
  // A handler modelled on handleTeammateEvent's gate wiring: hold the response
  // SYNCHRONOUSLY for the status-mutating completion signal, run the gate, send
  // the structured verdict. Non-STATE_TRANSITIONED signals stay fire-and-forget.
  function gatedHandler(deps: CoordinatorVerifierGateDeps) {
    return async (event: TeammateEvent, ack: SignalAck): Promise<void> => {
      if (event.type !== TeammateEventType.STATE_TRANSITIONED) return;
      ack.hold();
      const outcome = await evaluateCoordinatorGate(deps, {
        beadId: event.beadId,
        stateId: event.stateId,
        actionId: (event as { actionId?: string }).actionId || '',
        requiredTools: ['tA']
      });
      if (!outcome.ran) { ack.send(); return; }
      const verdict: SignalGateVerdict = {
        pass: outcome.pass,
        failures: outcome.failures,
        rejectMessage: outcome.rejectMessage
      };
      ack.send(verdict);
    };
  }

  function transitionBody(overrides: Record<string, unknown> = {}) {
    const base = {
      type: TeammateEventType.STATE_TRANSITIONED,
      beadId: 'bd-1',
      workerId: 'worker-1',
      stateId: 'Implementing',
      actionId: 'code',
      transitionEvent: 'SUCCESS',
      summary: 'done',
      evidence: 'evidence recorded',
      handover: 'handover recorded',
      timestamp: Date.now()
    };
    return { ...base, idempotencyKey: createTeammateEventIdempotencyKey(base), ...overrides };
  }

  async function withServer(deps: CoordinatorVerifierGateDeps, run: (port: number) => Promise<void>): Promise<void> {
    const observability = new Observability(h.configLoader, undefined, h.projectRoot);
    await observability.initialize();
    const port = 39920 + (process.pid % 60);
    const server = new SignalingServer(gatedHandler(deps), observability, h.store, port);
    await server.start();
    try {
      await run(port);
    } finally {
      server.stop();
      observability.shutdown();
    }
  }

  it('a gate that FAILS returns the structured verdict (pass:false + failures{tool,verdict,reasons} + rejectMessage), NOT a bare {ok:true}', async () => {
    const outputFile = path.join(h.projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'tA', 'inv', 'o.json');
    await h.store.record(DomainEventName.PROJECT_TOOL_SUCCEEDED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'tA', status: ToolResultStatus.PASSED, outputFile
    });
    registerVerify('tA', () => ({ verdict: VerifyVerdict.FAIL, reasons: ['tA content invalid'] }));

    await withServer(h.deps, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(transitionBody())
      });
      const body = await response.json() as {
        ok?: boolean;
        blocked?: boolean;
        gate?: { pass: boolean; failures: Array<{ tool: string; verdict?: string; reasons: string[] }>; rejectMessage: string };
      };

      // Structured rejection — NOT a bare {ok:true}.
      expect(body.ok).toBe(false);
      expect(body.blocked).toBe(true);
      expect(body.gate).toBeDefined();
      expect(body.gate!.pass).toBe(false);
      expect(body.gate!.failures[0].tool).toBe('tA');
      expect(body.gate!.failures[0].verdict).toBe(VerifyVerdict.FAIL);
      expect(body.gate!.failures[0].reasons).toContain('tA content invalid');
      expect(body.gate!.rejectMessage).toContain('tA content invalid');
    });
  });

  it('a gate that PASSes returns an advance verdict {ok:true, gate:{pass:true}}', async () => {
    const outputFile = path.join(h.projectRoot, '.pi', 'tool-output', 'bd-1', 'Implementing', 'code', 'tA', 'inv', 'o.json');
    await h.store.record(DomainEventName.PROJECT_TOOL_SUCCEEDED, {
      beadId: 'bd-1', stateId: 'Implementing', actionId: 'code', tool: 'tA', status: ToolResultStatus.PASSED, outputFile
    });
    registerVerify('tA', () => ({ verdict: VerifyVerdict.PASS, reasons: [] }));

    await withServer(h.deps, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(transitionBody())
      });
      const body = await response.json() as { ok?: boolean; gate?: { pass: boolean } };
      expect(body.ok).toBe(true);
      expect(body.gate).toBeDefined();
      expect(body.gate!.pass).toBe(true);
    });
  });
});
